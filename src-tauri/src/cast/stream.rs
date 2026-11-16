use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use tokio::{io::AsyncReadExt, process::Command, sync::mpsc};
use tokio_stream::wrappers::ReceiverStream;

use crate::ffmpeg;

const CHUNK_BYTES: usize = 256 * 1024;
const QUEUE_CHUNKS: usize = 48;
const AC3_BITRATE: &str = "448k";
const COPY_AUDIO: &[&str] = &["aac", "ac3", "eac3", "mp3", "mp2"];
const COPY_VIDEO: &[&str] = &["h264", "hevc", "mpeg2video", "mpeg4", "vc1"];
const STREAM_FLAGS: &str = "DLNA.ORG_OP=00;DLNA.ORG_CI=1;DLNA.ORG_FLAGS=01300000000000000000000000000000";
const FILE_FLAGS: &str = "DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Container {
    Matroska,
    Transport,
}

impl Container {
    pub fn mime(self) -> &'static str {
        match self {
            Container::Matroska => "video/x-matroska",
            Container::Transport => "video/mp2t",
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Container::Matroska => "mkv",
            Container::Transport => "ts",
        }
    }
}

#[derive(Clone, Debug)]
pub enum Subtitle {
    None,
    Internal { index: usize, text: bool },
    External,
}

#[derive(Clone, Debug)]
pub struct Plan {
    pub source: String,
    pub start: f64,
    pub direct: bool,
    pub direct_mime: &'static str,
    pub container: Container,
    pub audio: Option<usize>,
    pub audio_copy: bool,
    pub audio_channels_over_six: bool,
    pub video_encode: bool,
    pub subtitle: Subtitle,
    pub burn: bool,
}

impl Plan {
    pub fn mime(&self) -> &'static str {
        if self.direct {
            self.direct_mime
        } else {
            self.container.mime()
        }
    }

    pub fn extension(&self) -> &'static str {
        if self.direct {
            match self.direct_mime {
                "video/mp4" => "mp4",
                "video/mp2t" => "ts",
                _ => "mkv",
            }
        } else {
            self.container.extension()
        }
    }
}

pub fn audio_copyable(codec: &str) -> bool {
    COPY_AUDIO.contains(&codec.to_ascii_lowercase().as_str())
}

pub fn video_copyable(codec: &str) -> bool {
    let codec = codec.to_ascii_lowercase();
    codec.is_empty() || COPY_VIDEO.contains(&codec.as_str())
}

fn filter_path(path: &std::path::Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let escaped = text.replace(':', "\\:").replace('\'', "\\'");
    format!("subtitles='{escaped}'")
}

pub fn ffmpeg_arguments(plan: &Plan, shifted_subtitles: Option<&std::path::Path>, encoder: Option<(&str, &[&str])>) -> Vec<String> {
    let mut args: Vec<String> = vec!["-loglevel".into(), "error".into(), "-fflags".into(), "+genpts".into()];
    let start = format!("{:.3}", plan.start.max(0.0));
    args.extend(["-ss".into(), start.clone(), "-i".into(), plan.source.clone()]);
    let soft_external = matches!(plan.subtitle, Subtitle::External) && !plan.burn && plan.container == Container::Matroska;
    if soft_external {
        if let Some(path) = shifted_subtitles {
            args.extend(["-i".into(), path.to_string_lossy().into_owned()]);
        }
    }
    let encode = plan.video_encode || plan.burn;
    let overlay = plan.burn && matches!(plan.subtitle, Subtitle::Internal { text: false, .. });
    if overlay {
        if let Subtitle::Internal { index, .. } = plan.subtitle {
            args.extend(["-filter_complex".into(), format!("[0:v:0][0:s:{index}]overlay[v]"), "-map".into(), "[v]".into()]);
        }
    } else {
        args.extend(["-map".into(), "0:v:0".into()]);
    }
    match plan.audio {
        Some(index) => args.extend(["-map".into(), format!("0:a:{index}?")]),
        None => args.extend(["-map".into(), "0:a:0?".into()]),
    }
    if encode {
        if let Some((name, quality)) = encoder {
            if plan.burn && !overlay {
                if let Some(path) = shifted_subtitles {
                    args.extend(["-vf".into(), filter_path(path)]);
                }
            }
            args.extend(["-pix_fmt".into(), "yuv420p".into(), "-c:v".into(), name.into()]);
            args.extend(quality.iter().map(|value| (*value).to_owned()));
            args.extend(["-g".into(), "48".into()]);
        } else {
            args.extend(["-c:v".into(), "copy".into()]);
        }
    } else {
        args.extend(["-c:v".into(), "copy".into()]);
    }
    if plan.audio_copy {
        args.extend(["-c:a".into(), "copy".into()]);
    } else {
        args.extend(["-c:a".into(), "ac3".into(), "-b:a".into(), AC3_BITRATE.into()]);
        if plan.audio_channels_over_six {
            args.extend(["-ac".into(), "6".into()]);
        }
    }
    let mut subtitle_mapped = false;
    if plan.container == Container::Matroska && !plan.burn {
        match &plan.subtitle {
            Subtitle::Internal { index, text } => {
                args.extend(["-map".into(), format!("0:s:{index}?"), "-c:s".into(), if *text { "srt".into() } else { "copy".into() }]);
                subtitle_mapped = true;
            }
            Subtitle::External if shifted_subtitles.is_some() => {
                args.extend(["-map".into(), "1:0".into(), "-c:s".into(), "srt".into()]);
                subtitle_mapped = true;
            }
            _ => {}
        }
    }
    if subtitle_mapped {
        args.extend(["-disposition:s:0".into(), "default".into()]);
    } else {
        args.push("-sn".into());
    }
    args.extend(["-dn".into(), "-map_chapters".into(), "-1".into(), "-max_muxing_queue_size".into(), "2048".into()]);
    match plan.container {
        Container::Matroska => args.extend(["-f".into(), "matroska".into(), "-live".into(), "1".into()]),
        Container::Transport => args.extend(["-f".into(), "mpegts".into(), "-mpegts_flags".into(), "resend_headers".into()]),
    }
    args.push("pipe:1".into());
    args
}

pub struct Session {
    pub token: String,
    pub plan: Plan,
    pub subtitles: Option<bytes::Bytes>,
    pub shifted_path: Option<PathBuf>,
    pub data_dir: PathBuf,
}

#[derive(Default)]
pub struct Shared {
    pub session: Mutex<Option<Arc<Session>>>,
    running: Mutex<Option<(u64, tokio::sync::oneshot::Sender<()>)>>,
    pub port: Mutex<Option<u16>>,
}

static NEXT_RUN: AtomicU64 = AtomicU64::new(1);

pub async fn ensure_server(shared: Arc<Shared>) -> anyhow::Result<u16> {
    if let Some(port) = *shared.port.lock().unwrap() {
        return Ok(port);
    }
    let listener = tokio::net::TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0)).await?;
    let port = listener.local_addr()?.port();
    let router = Router::new().route("/cast/{token}/{name}", get(serve)).with_state(shared.clone());
    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, router).await {
            tracing::warn!("cast: server stopped: {error}");
        }
    });
    *shared.port.lock().unwrap() = Some(port);
    tracing::info!("cast: serving the TV on port {port}");
    Ok(port)
}

pub fn stop_running(shared: &Shared) {
    if let Some((_, stop)) = shared.running.lock().unwrap().take() {
        let _ = stop.send(());
    }
}

fn dlna_headers(headers: &mut HeaderMap, mime: &str, streaming: bool, subtitle_url: Option<String>) {
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_str(mime).unwrap_or(HeaderValue::from_static("video/x-matroska")));
    headers.insert("transferMode.dlna.org", HeaderValue::from_static("Streaming"));
    headers.insert("contentFeatures.dlna.org", HeaderValue::from_static(if streaming { STREAM_FLAGS } else { FILE_FLAGS }));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if let Some(url) = subtitle_url.and_then(|url| HeaderValue::from_str(&url).ok()) {
        headers.insert("CaptionInfo.sec", url);
    }
}

async fn serve(State(shared): State<Arc<Shared>>, Path((token, name)): Path<(String, String)>, method: Method, request_headers: HeaderMap) -> Response {
    let Some(session) = shared.session.lock().unwrap().clone() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if token != session.token {
        return StatusCode::FORBIDDEN.into_response();
    }
    let host = request_headers.get(header::HOST).and_then(|value| value.to_str().ok()).unwrap_or_default().to_owned();
    if name == "subs.srt" {
        return match &session.subtitles {
            Some(text) => {
                let mut headers = HeaderMap::new();
                headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/srt; charset=utf-8"));
                headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
                (StatusCode::OK, headers, Body::from(text.clone())).into_response()
            }
            None => StatusCode::NOT_FOUND.into_response(),
        };
    }
    if name != format!("video.{}", session.plan.extension()) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let subtitle_url = session.subtitles.as_ref().map(|_| format!("http://{host}/cast/{}/subs.srt", session.token));
    if session.plan.direct {
        return direct(&session, &method, &request_headers, subtitle_url).await;
    }
    let mut headers = HeaderMap::new();
    dlna_headers(&mut headers, session.plan.mime(), true, subtitle_url);
    if method == Method::HEAD {
        return (StatusCode::OK, headers).into_response();
    }
    match remux(&shared, &session).await {
        Ok(body) => (StatusCode::OK, headers, body).into_response(),
        Err(error) => {
            tracing::warn!("cast: could not start the stream: {error}");
            (StatusCode::SERVICE_UNAVAILABLE, error.to_string()).into_response()
        }
    }
}

async fn direct(session: &Session, method: &Method, request_headers: &HeaderMap, subtitle_url: Option<String>) -> Response {
    let mut request = reqwest::Client::new().request(if *method == Method::HEAD { reqwest::Method::HEAD } else { reqwest::Method::GET }, &session.plan.source);
    if let Some(range) = request_headers.get(header::RANGE).and_then(|value| value.to_str().ok()) {
        request = request.header(reqwest::header::RANGE, range);
    }
    let upstream = match request.send().await {
        Ok(response) => response,
        Err(error) => return (StatusCode::BAD_GATEWAY, error.to_string()).into_response(),
    };
    let status = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::OK);
    let mut headers = HeaderMap::new();
    dlna_headers(&mut headers, session.plan.mime(), false, subtitle_url);
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    for name in [reqwest::header::CONTENT_LENGTH, reqwest::header::CONTENT_RANGE] {
        if let Some(value) = upstream.headers().get(&name).and_then(|value| HeaderValue::from_bytes(value.as_bytes()).ok()) {
            headers.insert(name.as_str().parse::<header::HeaderName>().unwrap(), value);
        }
    }
    if *method == Method::HEAD {
        return (status, headers).into_response();
    }
    (status, headers, Body::from_stream(upstream.bytes_stream())).into_response()
}

async fn remux(shared: &Arc<Shared>, session: &Arc<Session>) -> anyhow::Result<Body> {
    let executable = ffmpeg::executable(&session.data_dir).ok_or_else(|| anyhow::anyhow!("ffmpeg_missing"))?;
    let needs_encoder = session.plan.video_encode || session.plan.burn;
    let encoder = if needs_encoder { ffmpeg::video_encoder(&executable).await } else { None };
    if needs_encoder && encoder.is_none() {
        anyhow::bail!("no_video_encoder");
    }
    let arguments = ffmpeg_arguments(&session.plan, session.shifted_path.as_deref(), encoder);
    tracing::info!("cast: stream from {:.0}s direct=false container={:?} audio_copy={} encode={} burn={}", session.plan.start, session.plan.container, session.plan.audio_copy, needs_encoder, session.plan.burn);
    let mut command: Command = ffmpeg::command(&executable);
    command.args(&arguments).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut child = crate::children::spawn(&mut command)?;
    let mut output = child.stdout.take().ok_or_else(|| anyhow::anyhow!("no_output"))?;
    let errors = child.stderr.take();
    let id = NEXT_RUN.fetch_add(1, Ordering::Relaxed);
    let (stop, mut stopped) = tokio::sync::oneshot::channel::<()>();
    if let Some((_, previous)) = shared.running.lock().unwrap().replace((id, stop)) {
        let _ = previous.send(());
    }
    if let Some(mut errors) = errors {
        tokio::spawn(async move {
            let mut text = String::new();
            let _ = errors.read_to_string(&mut text).await;
            let text = text.trim();
            if !text.is_empty() {
                tracing::warn!("cast: ffmpeg said: {}", text.lines().take(6).collect::<Vec<_>>().join(" | "));
            }
        });
    }
    let (sender, receiver) = mpsc::channel::<std::io::Result<bytes::Bytes>>(QUEUE_CHUNKS);
    let running = shared.clone();
    tokio::spawn(async move {
        let mut buffer = vec![0u8; CHUNK_BYTES];
        loop {
            let read = tokio::select! {
                _ = &mut stopped => break,
                _ = sender.closed() => break,
                read = output.read(&mut buffer) => read,
            };
            let read = match read {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            let piece = bytes::Bytes::copy_from_slice(&buffer[..read]);
            let sent = tokio::select! {
                _ = &mut stopped => break,
                sent = sender.send(Ok(piece)) => sent,
            };
            if sent.is_err() {
                break;
            }
        }
        let _ = child.kill().await;
        let mut slot = running.running.lock().unwrap();
        if slot.as_ref().is_some_and(|(current, _)| *current == id) {
            *slot = None;
        }
    });
    Ok(Body::from_stream(ReceiverStream::new(receiver)))
}

pub async fn shifted_subtitles(data_dir: &std::path::Path, text: &str, start: f64) -> anyhow::Result<(PathBuf, bytes::Bytes)> {
    let folder = data_dir.join("cast");
    tokio::fs::create_dir_all(&folder).await?;
    let original = folder.join("original.srt");
    let shifted = folder.join("shifted.srt");
    tokio::fs::write(&original, text.as_bytes()).await?;
    let executable = ffmpeg::executable(data_dir).ok_or_else(|| anyhow::anyhow!("ffmpeg_missing"))?;
    let status = ffmpeg::command(&executable)
        .args(["-loglevel", "error", "-y", "-i"])
        .arg(&original)
        .args(["-ss", &format!("{:.3}", start.max(0.0)), "-f", "srt"])
        .arg(&shifted)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await?;
    if !status.success() {
        anyhow::bail!("subtitles_unreadable");
    }
    let bytes = tokio::fs::read(&shifted).await?;
    Ok((shifted, bytes::Bytes::from(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan() -> Plan {
        Plan {
            source: "http://127.0.0.1:9/t/stream/abc/0".into(),
            start: 61.5,
            direct: false,
            direct_mime: "video/x-matroska",
            container: Container::Matroska,
            audio: Some(2),
            audio_copy: false,
            audio_channels_over_six: true,
            video_encode: false,
            subtitle: Subtitle::Internal { index: 1, text: true },
            burn: false,
        }
    }

    fn joined(args: &[String]) -> String {
        args.join(" ")
    }

    #[test]
    fn remux_keeps_picture_and_picks_the_voice() {
        let text = joined(&ffmpeg_arguments(&plan(), None, None));
        assert!(text.contains("-ss 61.500 -i http://127.0.0.1:9/t/stream/abc/0"));
        assert!(text.contains("-map 0:v:0 -map 0:a:2? -c:v copy -c:a ac3 -b:a 448k -ac 6"));
        assert!(text.contains("-map 0:s:1? -c:s srt -disposition:s:0 default"));
        assert!(text.ends_with("-f matroska -live 1 pipe:1"));
    }

    #[test]
    fn transport_stream_drops_soft_subtitles() {
        let mut plan = plan();
        plan.container = Container::Transport;
        plan.audio_copy = true;
        let text = joined(&ffmpeg_arguments(&plan, None, None));
        assert!(text.contains("-c:a copy"));
        assert!(text.contains("-sn"));
        assert!(!text.contains("0:s:"));
        assert!(text.contains("-f mpegts"));
    }

    #[test]
    fn burning_encodes_the_picture() {
        let mut plan = plan();
        plan.burn = true;
        plan.subtitle = Subtitle::External;
        let shifted = PathBuf::from("C:\\data\\cast\\shifted.srt");
        let text = joined(&ffmpeg_arguments(&plan, Some(&shifted), Some(("h264_nvenc", &["-cq", "23"]))));
        assert!(text.contains("-vf subtitles='C\\:/data/cast/shifted.srt'"));
        assert!(text.contains("-c:v h264_nvenc -cq 23"));
        assert!(text.contains("-sn"));
        plan.subtitle = Subtitle::Internal { index: 0, text: false };
        let text = joined(&ffmpeg_arguments(&plan, None, Some(("h264_nvenc", &[]))));
        assert!(text.contains("-filter_complex [0:v:0][0:s:0]overlay[v] -map [v]"));
    }

    #[test]
    fn codecs_are_judged() {
        assert!(audio_copyable("AC3"));
        assert!(!audio_copyable("dts"));
        assert!(!audio_copyable("truehd"));
        assert!(video_copyable("h264"));
        assert!(!video_copyable("av1"));
    }
}
