use std::{
    collections::{HashMap, VecDeque},
    io::SeekFrom,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use axum::{
    body::Body,
    extract::{Path, Query, Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use serde::Deserialize;
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt},
    process::Command,
    sync::{mpsc, oneshot, Semaphore},
};
use tokio_stream::{wrappers::ReceiverStream, StreamExt};
use tokio_util::io::ReaderStream;

use crate::{engine::Engine, ffmpeg};

const STREAM_CHUNK_BYTES: usize = 256 * 1024;
const AUDIO_CHUNK_BYTES: usize = 16 * 1024;
const PIPE_QUEUE_CHUNKS: usize = 32;
const AUDIO_BITRATE: &str = "192k";
const CONVERTED_PICTURE: &str = "scale=-2:'min(1080,ih)'";
const CONVERTED_KEYFRAME_GAP: &str = "48";
const MAX_SUBTITLE_WINDOW_SECONDS: f64 = 900.0;
const SUBTITLE_READ_MARGIN: f64 = 1.25;
const SUBTITLE_READ_EXTRA_BYTES: u64 = 32 * 1024 * 1024;
const INDEX_TAIL_BYTES: u64 = 48 * 1024 * 1024;
const THUMBNAIL_TIMEOUT: Duration = Duration::from_secs(8);
const THUMBNAIL_WIDTH_MAX: u32 = 480;
const THUMBNAIL_WIDTH_DEFAULT: u32 = 240;
const THUMBNAILS_KEPT: usize = 400;
const PEEK_CHUNK_BYTES: usize = 64 * 1024;
const ALLOWED_ORIGINS: &[&str] = &["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost", "http://localhost:1420"];

#[derive(Default)]
struct Thumbnails {
    images: HashMap<String, bytes::Bytes>,
    order: VecDeque<String>,
}

impl Thumbnails {
    fn get(&self, key: &str) -> Option<bytes::Bytes> {
        self.images.get(key).cloned()
    }

    fn put(&mut self, key: String, image: bytes::Bytes) {
        if self.images.insert(key.clone(), image).is_none() {
            self.order.push_back(key);
        }
        while self.order.len() > THUMBNAILS_KEPT {
            if let Some(old) = self.order.pop_front() {
                self.images.remove(&old);
            }
        }
    }
}

#[derive(Clone)]
struct ServerState {
    engine: Arc<Engine>,
    token: Arc<str>,
    base_url: Arc<str>,
    host: Arc<str>,
    data_dir: Arc<std::path::Path>,
    conversions: Arc<Mutex<HashMap<String, (u64, oneshot::Sender<()>)>>>,
    thumbnails: Arc<Mutex<Thumbnails>>,
    thumbnail_slot: Arc<Semaphore>,
}

static NEXT_CONVERSION: AtomicU64 = AtomicU64::new(1);

#[derive(Deserialize)]
struct StreamQuery {
    until: Option<u64>,
}

#[derive(Deserialize)]
struct AudioQuery {
    #[serde(default)]
    track: usize,
    #[serde(default)]
    start: f64,
}

pub async fn start(engine: Arc<Engine>, token: String, data_dir: std::path::PathBuf) -> anyhow::Result<String> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let base_url = format!("http://127.0.0.1:{port}/{token}");

    let state = ServerState {
        engine,
        token: token.into(),
        base_url: base_url.as_str().into(),
        host: format!("127.0.0.1:{port}").into(),
        data_dir: data_dir.into(),
        conversions: Arc::default(),
        thumbnails: Arc::default(),
        thumbnail_slot: Arc::new(Semaphore::new(1)),
    };
    let router = Router::new()
        .route("/{token}/stream/{info_hash}/{file_index}", get(stream_file))
        .route("/{token}/peek/{info_hash}/{file_index}", get(peek_file))
        .route("/{token}/thumbnail/{info_hash}/{file_index}", get(thumbnail))
        .route("/{token}/audio/{info_hash}/{file_index}", get(stream_audio))
        .route("/{token}/subtitles/{info_hash}/{file_index}", get(read_subtitles))
        .route("/{token}/video/{info_hash}/{file_index}", get(stream_converted))
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state);

    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, router).await {
            tracing::warn!("server: stopped with error: {error}");
        }
    });
    Ok(base_url)
}

async fn guard(State(state): State<ServerState>, request: Request, next: Next) -> Response {
    let host_ok = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|host| host.eq_ignore_ascii_case(&state.host));
    if !host_ok {
        return StatusCode::MISDIRECTED_REQUEST.into_response();
    }
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .filter(|origin| ALLOWED_ORIGINS.contains(origin))
        .map(str::to_owned);
    let mut response = next.run(request).await;
    if let Some(origin) = origin.and_then(|origin| HeaderValue::from_str(&origin).ok()) {
        response.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        response.headers_mut().insert(header::VARY, HeaderValue::from_static("Origin"));
    }
    response
}

async fn stream_file(
    State(state): State<ServerState>,
    Path((token, info_hash, file_index)): Path<(String, String, usize)>,
    Query(query): Query<StreamQuery>,
    headers: HeaderMap,
) -> Response {
    if token != *state.token {
        return StatusCode::FORBIDDEN.into_response();
    }
    match serve_range(&state.engine, &info_hash, file_index, &headers, query.until).await {
        Ok(response) => response,
        Err(error) => {
            let message = error.to_string();
            let status = if message == "disk_full" { StatusCode::INSUFFICIENT_STORAGE } else { StatusCode::NOT_FOUND };
            (status, message).into_response()
        }
    }
}

fn pipe_conversion(state: &ServerState, key: String, mut command: Command, chunk: usize, content_type: &'static str) -> Response {
    command.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
    let mut child = match crate::children::spawn(&mut command) {
        Ok(child) => child,
        Err(error) => return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
    };
    let Some(mut output) = child.stdout.take() else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };

    let id = NEXT_CONVERSION.fetch_add(1, Ordering::Relaxed);
    let (stop, mut stopped) = oneshot::channel::<()>();
    if let Some((_, previous)) = state.conversions.lock().unwrap().insert(key.clone(), (id, stop)) {
        let _ = previous.send(());
    }

    let (sender, receiver) = mpsc::channel::<std::io::Result<bytes::Bytes>>(PIPE_QUEUE_CHUNKS);
    let conversions = state.conversions.clone();
    tokio::spawn(async move {
        let mut buffer = vec![0u8; chunk];
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
        let mut conversions = conversions.lock().unwrap();
        if conversions.get(&key).is_some_and(|(current, _)| *current == id) {
            conversions.remove(&key);
        }
    });

    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    (StatusCode::OK, headers, Body::from_stream(ReceiverStream::new(receiver))).into_response()
}

async fn stream_audio(
    State(state): State<ServerState>,
    Path((token, info_hash, file_index)): Path<(String, String, usize)>,
    Query(query): Query<AudioQuery>,
) -> Response {
    if token != *state.token {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(executable) = ffmpeg::executable(&state.data_dir) else {
        return (StatusCode::SERVICE_UNAVAILABLE, "ffmpeg_missing").into_response();
    };
    let input = format!("{}/stream/{}/{}", state.base_url, info_hash, file_index);
    let start = format!("{:.3}", query.start.max(0.0));
    let track = format!("0:a:{}", query.track);

    let mut command = ffmpeg::command(&executable);
    command
        .args(["-loglevel", "error", "-ss", &start, "-i", &input, "-map", &track])
        .args(["-vn", "-sn", "-dn", "-ac", "2", "-c:a", "aac", "-b:a", AUDIO_BITRATE, "-f", "adts", "pipe:1"]);
    pipe_conversion(&state, format!("audio:{info_hash}:{file_index}"), command, AUDIO_CHUNK_BYTES, "audio/aac")
}

#[derive(Deserialize)]
struct ConvertedQuery {
    #[serde(default)]
    audio: usize,
    #[serde(default)]
    start: f64,
}

async fn stream_converted(
    State(state): State<ServerState>,
    Path((token, info_hash, file_index)): Path<(String, String, usize)>,
    Query(query): Query<ConvertedQuery>,
) -> Response {
    if token != *state.token {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(executable) = ffmpeg::executable(&state.data_dir) else {
        return (StatusCode::SERVICE_UNAVAILABLE, "ffmpeg_missing").into_response();
    };
    let Some((encoder, quality)) = ffmpeg::video_encoder(&executable).await else {
        return (StatusCode::SERVICE_UNAVAILABLE, "no_video_encoder").into_response();
    };
    let input = format!("{}/stream/{}/{}", state.base_url, info_hash, file_index);
    let start = format!("{:.3}", query.start.max(0.0));
    let audio = format!("0:a:{}?", query.audio);

    let mut command = ffmpeg::command(&executable);
    command
        .args(["-loglevel", "error", "-ss", &start, "-i", &input, "-map", "0:v:0", "-map", &audio, "-sn", "-dn"])
        .args(["-vf", CONVERTED_PICTURE, "-pix_fmt", "yuv420p", "-c:v", encoder])
        .args(quality)
        .args(["-g", CONVERTED_KEYFRAME_GAP, "-c:a", "aac", "-ac", "2", "-b:a", AUDIO_BITRATE])
        .args(["-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1"]);
    pipe_conversion(&state, format!("video:{info_hash}:{file_index}"), command, STREAM_CHUNK_BYTES, "video/mp4")
}

#[derive(Deserialize)]
struct SubtitleQuery {
    #[serde(default)]
    track: usize,
    #[serde(default)]
    start: f64,
    duration: f64,
    length: f64,
}

async fn read_subtitles(
    State(state): State<ServerState>,
    Path((token, info_hash, file_index)): Path<(String, String, usize)>,
    Query(query): Query<SubtitleQuery>,
) -> Response {
    if token != *state.token {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(executable) = ffmpeg::executable(&state.data_dir) else {
        return (StatusCode::SERVICE_UNAVAILABLE, "ffmpeg_missing").into_response();
    };
    let total = match state.engine.prepare_stream(&info_hash, Some(file_index)).await.and_then(|handle| {
        Ok(handle.with_metadata(|metadata| metadata.file_infos.get(file_index).map(|file| file.len))?)
    }) {
        Ok(Some(total)) => total,
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    let start_seconds = query.start.max(0.0);
    let end_seconds = start_seconds + query.duration.clamp(1.0, MAX_SUBTITLE_WINDOW_SECONDS);
    let share = if query.length > 0.0 { (end_seconds / query.length).min(1.0) } else { 1.0 };
    let until = ((total as f64 * share * SUBTITLE_READ_MARGIN) as u64).saturating_add(SUBTITLE_READ_EXTRA_BYTES);
    let input = format!("{}/stream/{}/{}?until={}", state.base_url, info_hash, file_index, until.min(total));
    let start = format!("{start_seconds:.3}");
    let track = format!("0:s:{}", query.track);

    let mut command = ffmpeg::command(&executable);
    command.args(["-loglevel", "error", "-ss", &start, "-i", &input, "-map", &track, "-flush_packets", "1", "-f", "srt", "pipe:1"]);
    pipe_conversion(
        &state,
        format!("subtitles:{}:{info_hash}:{file_index}", query.track),
        command,
        AUDIO_CHUNK_BYTES,
        "text/plain; charset=utf-8",
    )
}

async fn peek_file(
    State(state): State<ServerState>,
    Path((token, info_hash, file_index)): Path<(String, String, usize)>,
    headers: HeaderMap,
) -> Response {
    if token != *state.token {
        return StatusCode::FORBIDDEN.into_response();
    }
    match serve_downloaded(&state.engine, &info_hash, file_index, &headers).await {
        Ok(response) => response,
        Err(error) => (StatusCode::NOT_FOUND, error.to_string()).into_response(),
    }
}

async fn serve_downloaded(engine: &Arc<Engine>, info_hash: &str, file_index: usize, headers: &HeaderMap) -> anyhow::Result<Response> {
    let pieces = engine.file_pieces(info_hash, file_index)?;
    let total = pieces.length;
    let path = engine.file_path(info_hash, file_index)?;
    let (start, wanted_end) = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| parse_range(value, total))
        .unwrap_or((0, total.saturating_sub(1)));
    let available = pieces.available_until(start);
    if available <= start {
        let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
        response.headers_mut().insert(header::CONTENT_RANGE, HeaderValue::from_str(&format!("bytes */{total}"))?);
        return Ok(response);
    }
    let end = wanted_end.min(available - 1);
    let mut file = tokio::fs::File::open(&path).await?;
    file.seek(SeekFrom::Start(start)).await?;
    let length = end - start + 1;
    let mut response_headers = HeaderMap::new();
    response_headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    response_headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
    response_headers.insert(header::CONTENT_RANGE, HeaderValue::from_str(&format!("bytes {start}-{end}/{total}"))?);
    response_headers.insert(header::CONTENT_LENGTH, HeaderValue::from_str(&length.to_string())?);
    let body = Body::from_stream(ReaderStream::with_capacity(file.take(length), PEEK_CHUNK_BYTES));
    Ok((StatusCode::PARTIAL_CONTENT, response_headers, body).into_response())
}

#[derive(Deserialize)]
struct ThumbnailQuery {
    at: f64,
    width: Option<u32>,
}

async fn thumbnail(
    State(state): State<ServerState>,
    Path((token, info_hash, file_index)): Path<(String, String, usize)>,
    Query(query): Query<ThumbnailQuery>,
) -> Response {
    if token != *state.token {
        return StatusCode::FORBIDDEN.into_response();
    }
    let width = query.width.unwrap_or(THUMBNAIL_WIDTH_DEFAULT).clamp(64, THUMBNAIL_WIDTH_MAX);
    let at = query.at.max(0.0);
    let key = format!("{info_hash}:{file_index}:{width}:{}", at.round() as u64);
    if let Some(image) = state.thumbnails.lock().unwrap().get(&key) {
        return jpeg(image);
    }
    let Some(executable) = ffmpeg::executable(&state.data_dir) else {
        return (StatusCode::SERVICE_UNAVAILABLE, "ffmpeg_missing").into_response();
    };
    let Ok(_slot) = state.thumbnail_slot.clone().acquire_owned().await else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    if let Some(image) = state.thumbnails.lock().unwrap().get(&key) {
        return jpeg(image);
    }
    let input = format!("{}/peek/{}/{}", state.base_url, info_hash, file_index);
    let position = format!("{at:.3}");
    let scale = format!("scale={width}:-2:flags=fast_bilinear,format=yuvj420p");
    let mut command = ffmpeg::command(&executable);
    command
        .args(["-loglevel", "error", "-skip_frame", "nokey", "-ss", &position, "-i", &input])
        .args(["-map", "0:v:0", "-an", "-sn", "-dn", "-frames:v", "1", "-vf", &scale])
        .args(["-c:v", "mjpeg", "-q:v", "6", "-f", "image2pipe", "pipe:1"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let Ok(child) = crate::children::spawn(&mut command) else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let output = match tokio::time::timeout(THUMBNAIL_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) if output.status.success() && !output.stdout.is_empty() => output.stdout,
        _ => return StatusCode::NO_CONTENT.into_response(),
    };
    let image = bytes::Bytes::from(output);
    state.thumbnails.lock().unwrap().put(key, image.clone());
    jpeg(image)
}

fn jpeg(image: bytes::Bytes) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/jpeg"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=3600"));
    (StatusCode::OK, headers, Body::from(image)).into_response()
}

async fn serve_range(
    engine: &Arc<Engine>,
    info_hash: &str,
    file_index: usize,
    headers: &HeaderMap,
    until: Option<u64>,
) -> anyhow::Result<Response> {
    let handle = engine.prepare_stream(info_hash, Some(file_index)).await?;
    engine.watch_file(&handle, file_index).await;
    let file_name = engine.file_name(info_hash, file_index).unwrap_or_default();
    let mut stream = handle.stream(file_index).await?;
    let total = stream.len();

    let mut response_headers = HeaderMap::new();
    response_headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    response_headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime_for(&file_name)));

    let requested = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| parse_range(value, total));

    let requested = match (requested, until) {
        (Some((start, end)), Some(until)) => {
            let tail_start = total.saturating_sub(INDEX_TAIL_BYTES);
            if start > until && start < tail_start {
                return Ok(StatusCode::RANGE_NOT_SATISFIABLE.into_response());
            }
            Some((start, if start <= until { end.min(until) } else { end }))
        }
        (None, Some(until)) => Some((0, until.min(total.saturating_sub(1)))),
        (requested, None) => requested,
    };

    let (status, start, length) = match requested {
        Some((start, end)) => {
            response_headers.insert(header::CONTENT_RANGE, HeaderValue::from_str(&format!("bytes {start}-{end}/{total}"))?);
            (StatusCode::PARTIAL_CONTENT, start, end - start + 1)
        }
        None => (StatusCode::OK, 0, total),
    };
    response_headers.insert(header::CONTENT_LENGTH, HeaderValue::from_str(&length.to_string())?);

    if start > 0 {
        stream.seek(SeekFrom::Start(start)).await?;
    }
    let lease = engine.lease_stream(info_hash);
    let chunks = ReaderStream::with_capacity(stream.take(length), STREAM_CHUNK_BYTES).map(move |chunk| {
        let _ = &lease;
        chunk
    });
    Ok((status, response_headers, Body::from_stream(chunks)).into_response())
}

fn parse_range(value: &str, total: u64) -> Option<(u64, u64)> {
    if total == 0 {
        return None;
    }
    let spec = value.strip_prefix("bytes=")?.split(',').next()?.trim();
    let (start_text, end_text) = spec.split_once('-')?;
    let last = total - 1;

    if start_text.is_empty() {
        let suffix: u64 = end_text.parse().ok()?;
        return Some((total.saturating_sub(suffix), last));
    }
    let start: u64 = start_text.parse().ok()?;
    if start > last {
        return None;
    }
    let end = end_text.parse::<u64>().map(|end| end.min(last)).unwrap_or(last);
    (end >= start).then_some((start, end))
}

fn mime_for(file_name: &str) -> &'static str {
    let extension = file_name.rsplit('.').next().unwrap_or_default().to_ascii_lowercase();
    match extension.as_str() {
        "mp4" | "m4v" | "mov" => "video/mp4",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "avi" => "video/x-msvideo",
        "ts" | "m2ts" => "video/mp2t",
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "srt" | "ass" | "ssa" | "vtt" | "sub" => "text/plain",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges_are_parsed() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=900-", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=1000-", 1000), None);
    }

    #[test]
    fn thumbnails_forget_the_oldest() {
        let mut thumbnails = Thumbnails::default();
        for index in 0..THUMBNAILS_KEPT + 5 {
            thumbnails.put(index.to_string(), bytes::Bytes::from_static(b"x"));
        }
        assert!(thumbnails.get("0").is_none());
        assert!(thumbnails.get(&(THUMBNAILS_KEPT + 4).to_string()).is_some());
        assert_eq!(thumbnails.images.len(), THUMBNAILS_KEPT);
    }
}
