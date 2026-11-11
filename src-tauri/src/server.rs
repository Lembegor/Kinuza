use std::{io::SeekFrom, sync::Arc};

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::io::ReaderStream;

use crate::{engine::Engine, ffmpeg};

const STREAM_CHUNK_BYTES: usize = 256 * 1024;
const AUDIO_CHUNK_BYTES: usize = 16 * 1024;
const AUDIO_QUEUE_CHUNKS: usize = 32;
const AUDIO_BITRATE: &str = "192k";
const CONVERTED_PICTURE: &str = "scale=-2:'min(1080,ih)'";
const CONVERTED_KEYFRAME_GAP: &str = "48";
const MAX_SUBTITLE_WINDOW_SECONDS: f64 = 900.0;
const SUBTITLE_READ_MARGIN: f64 = 1.25;
const SUBTITLE_READ_EXTRA_BYTES: u64 = 32 * 1024 * 1024;
const INDEX_TAIL_BYTES: u64 = 48 * 1024 * 1024;

#[derive(Clone)]
struct ServerState {
    engine: Arc<Engine>,
    token: Arc<str>,
    base_url: Arc<str>,
    data_dir: Arc<std::path::Path>,
}

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
        data_dir: data_dir.into(),
    };
    let router = Router::new()
        .route("/{token}/stream/{info_hash}/{file_index}", get(stream_file))
        .route("/{token}/audio/{info_hash}/{file_index}", get(stream_audio))
        .route("/{token}/subtitles/{info_hash}/{file_index}", get(read_subtitles))
        .route("/{token}/video/{info_hash}/{file_index}", get(stream_converted))
        .with_state(state);

    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, router).await {
            tracing::warn!("server: stopped with error: {error}");
        }
    });
    Ok(base_url)
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
        Err(error) => (StatusCode::NOT_FOUND, error.to_string()).into_response(),
    }
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

    let spawned = ffmpeg::command(&executable)
        .args(["-loglevel", "error", "-ss", &start, "-i", &input, "-map", &track])
        .args(["-vn", "-sn", "-dn", "-ac", "2", "-c:a", "aac", "-b:a", AUDIO_BITRATE, "-f", "adts", "pipe:1"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
    };
    let Some(mut output) = child.stdout.take() else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };

    let (sender, receiver) = tokio::sync::mpsc::channel::<std::io::Result<bytes::Bytes>>(AUDIO_QUEUE_CHUNKS);
    tokio::spawn(async move {
        let mut buffer = vec![0u8; AUDIO_CHUNK_BYTES];
        loop {
            match output.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if sender.send(Ok(bytes::Bytes::copy_from_slice(&buffer[..read]))).await.is_err() {
                        break;
                    }
                }
            }
        }
        let _ = child.kill().await;
    });

    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("audio/aac"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    (StatusCode::OK, headers, Body::from_stream(ReceiverStream::new(receiver))).into_response()
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

    let spawned = ffmpeg::command(&executable)
        .args(["-loglevel", "error", "-ss", &start, "-i", &input, "-map", "0:v:0", "-map", &audio, "-sn", "-dn"])
        .args(["-vf", CONVERTED_PICTURE, "-pix_fmt", "yuv420p", "-c:v", encoder])
        .args(quality)
        .args(["-g", CONVERTED_KEYFRAME_GAP, "-c:a", "aac", "-ac", "2", "-b:a", AUDIO_BITRATE])
        .args(["-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
    };
    let Some(mut output) = child.stdout.take() else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };

    let (sender, receiver) = tokio::sync::mpsc::channel::<std::io::Result<bytes::Bytes>>(AUDIO_QUEUE_CHUNKS);
    tokio::spawn(async move {
        let mut buffer = vec![0u8; STREAM_CHUNK_BYTES];
        loop {
            match output.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if sender.send(Ok(bytes::Bytes::copy_from_slice(&buffer[..read]))).await.is_err() {
                        break;
                    }
                }
            }
        }
        let _ = child.kill().await;
    });

    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("video/mp4"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    (StatusCode::OK, headers, Body::from_stream(ReceiverStream::new(receiver))).into_response()
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

    let spawned = ffmpeg::command(&executable)
        .args(["-loglevel", "error", "-ss", &start, "-i", &input, "-map", &track, "-flush_packets", "1", "-f", "srt", "pipe:1"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
    };
    let Some(mut output) = child.stdout.take() else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let (sender, receiver) = tokio::sync::mpsc::channel::<std::io::Result<bytes::Bytes>>(AUDIO_QUEUE_CHUNKS);
    tokio::spawn(async move {
        let mut buffer = vec![0u8; AUDIO_CHUNK_BYTES];
        loop {
            match output.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if sender.send(Ok(bytes::Bytes::copy_from_slice(&buffer[..read]))).await.is_err() {
                        break;
                    }
                }
            }
        }
        let _ = child.kill().await;
    });

    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    (StatusCode::OK, headers, Body::from_stream(ReceiverStream::new(receiver))).into_response()
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
    response_headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(mime_for(&file_name)),
    );
    response_headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );

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
            response_headers.insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes {start}-{end}/{total}"))?,
            );
            (StatusCode::PARTIAL_CONTENT, start, end - start + 1)
        }
        None => (StatusCode::OK, 0, total),
    };
    response_headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&length.to_string())?,
    );

    if start > 0 {
        stream.seek(SeekFrom::Start(start)).await?;
    }
    let body = Body::from_stream(ReaderStream::with_capacity(
        stream.take(length),
        STREAM_CHUNK_BYTES,
    ));
    Ok((status, response_headers, body).into_response())
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
    let extension = file_name
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
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
