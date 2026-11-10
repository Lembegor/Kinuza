//! Loopback HTTP server that lets the player read torrent files with Range requests while they download.

use std::{io::SeekFrom, sync::Arc};

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

use crate::engine::Engine;

const STREAM_CHUNK_BYTES: usize = 256 * 1024;

#[derive(Clone)]
struct ServerState {
    engine: Arc<Engine>,
    token: Arc<str>,
}

/// Starts the server on a random loopback port and returns the base URL, including the access token.
pub async fn start(engine: Arc<Engine>, token: String) -> anyhow::Result<String> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let base_url = format!("http://127.0.0.1:{port}/{token}");

    let state = ServerState {
        engine,
        token: token.into(),
    };
    let router = Router::new()
        .route("/{token}/stream/{info_hash}/{file_index}", get(stream_file))
        .with_state(state);

    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, router).await {
            eprintln!("server: stopped with error: {error}");
        }
    });
    Ok(base_url)
}

async fn stream_file(
    State(state): State<ServerState>,
    Path((token, info_hash, file_index)): Path<(String, String, usize)>,
    headers: HeaderMap,
) -> Response {
    if token != *state.token {
        return StatusCode::FORBIDDEN.into_response();
    }
    match serve_range(&state.engine, &info_hash, file_index, &headers).await {
        Ok(response) => response,
        Err(error) => (StatusCode::NOT_FOUND, error.to_string()).into_response(),
    }
}

async fn serve_range(
    engine: &Engine,
    info_hash: &str,
    file_index: usize,
    headers: &HeaderMap,
) -> anyhow::Result<Response> {
    let handle = engine.prepare_stream(info_hash, file_index).await?;
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

/// Parses a single `bytes=start-end` range; returns inclusive bounds clamped to the file.
fn parse_range(value: &str, total: u64) -> Option<(u64, u64)> {
    if total == 0 {
        return None;
    }
    let spec = value.strip_prefix("bytes=")?.split(',').next()?.trim();
    let (start_text, end_text) = spec.split_once('-')?;
    let last = total - 1;

    if start_text.is_empty() {
        // Suffix form: the last N bytes.
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
