pub mod dlna;
pub mod stream;

use std::{
    collections::HashMap,
    net::IpAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Instant,
};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::AppState;
use dlna::Renderer;
use stream::{Container, Plan, Session, Shared, Subtitle};

#[derive(Default)]
pub struct CastState {
    devices: Mutex<HashMap<String, Renderer>>,
    active: Mutex<Option<Active>>,
    shared: Arc<Shared>,
}

struct Active {
    renderer: Renderer,
    start: f64,
    direct: bool,
    clock_base: f64,
    clock_since: Option<Instant>,
    last_position: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CastSubtitle {
    kind: String,
    index: Option<usize>,
    text: Option<bool>,
    content: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CastRequest {
    device: String,
    info_hash: String,
    file_index: usize,
    file_name: String,
    title: String,
    start: f64,
    duration: f64,
    audio: Option<usize>,
    audio_codec: String,
    audio_channels: String,
    video_codec: String,
    subtitle: Option<CastSubtitle>,
    burn: bool,
    level: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CastStarted {
    level: u8,
    direct: bool,
    mime: String,
    url: String,
    address: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CastStatus {
    active: bool,
    state: String,
    position: f64,
    reported: bool,
    duration: Option<f64>,
    volume: Option<u32>,
}

fn container_mime(file_name: &str) -> Option<&'static str> {
    match file_name.rsplit('.').next().unwrap_or_default().to_ascii_lowercase().as_str() {
        "mkv" => Some("video/x-matroska"),
        "mp4" | "m4v" => Some("video/mp4"),
        "ts" | "m2ts" => Some("video/mp2t"),
        _ => None,
    }
}

fn sink_accepts(sink: &str, mime: &str) -> bool {
    if sink.is_empty() {
        return true;
    }
    match mime {
        "video/x-matroska" => sink.contains("matroska") || sink.contains("x-mkv"),
        "video/mp4" => sink.contains("video/mp4"),
        "video/mp2t" => sink.contains("mp2t") || sink.contains("mpeg_ts") || sink.contains("vnd.dlna.mpeg-tts"),
        _ => false,
    }
}

fn channels_over_six(channels: &str) -> bool {
    let lower = channels.to_ascii_lowercase();
    lower.contains("7.1") || lower.contains("8 channels") || lower.contains("6.1")
}

pub fn plan_for(request: &CastRequest, source: String, sink: &str, external: Option<PathBuf>) -> Plan {
    let audio_index = request.audio.unwrap_or(0);
    let wants_subtitle = request.subtitle.as_ref().is_some_and(|subtitle| subtitle.kind != "none");
    let audio_ok = stream::audio_copyable(&request.audio_codec) || (request.audio_codec.to_ascii_lowercase().starts_with("dts") && sink.contains("dts"));
    let video_ok = stream::video_copyable(&request.video_codec);
    let original = container_mime(&request.file_name);
    let direct_possible = request.level == 0 && !wants_subtitle && audio_index == 0 && audio_ok && video_ok && original.is_some_and(|mime| sink_accepts(sink, mime));
    let mkv_ok = sink.is_empty() || sink_accepts(sink, "video/x-matroska");
    let container = match request.level {
        0 | 1 if mkv_ok => Container::Matroska,
        0 | 1 => Container::Transport,
        _ => Container::Transport,
    };
    let subtitle = match request.subtitle.as_ref() {
        Some(choice) if choice.kind == "internal" => Subtitle::Internal { index: choice.index.unwrap_or(0), text: choice.text.unwrap_or(true) },
        Some(choice) if choice.kind == "external" && external.is_some() => Subtitle::External,
        _ => Subtitle::None,
    };
    let burn = request.burn && !matches!(subtitle, Subtitle::None) && !matches!(subtitle, Subtitle::Internal { text: true, .. });
    Plan {
        source,
        start: request.start,
        direct: direct_possible,
        direct_mime: original.unwrap_or("video/x-matroska"),
        container,
        audio: request.audio,
        audio_copy: audio_ok && request.level < 2,
        audio_channels_over_six: channels_over_six(&request.audio_channels),
        video_encode: request.level >= 3 || !video_ok,
        subtitle,
        burn,
    }
}

async fn renderer_for(cast: &CastState, id: &str) -> Result<Renderer, String> {
    if let Some(found) = cast.devices.lock().unwrap().get(id).cloned() {
        return Ok(found);
    }
    let found = dlna::discover().await;
    let mut devices = cast.devices.lock().unwrap();
    for renderer in found {
        devices.insert(renderer.id.clone(), renderer);
    }
    devices.get(id).cloned().ok_or_else(|| "cast_device_gone".to_owned())
}

#[tauri::command]
pub async fn cast_devices(cast: State<'_, CastState>) -> Result<Vec<Renderer>, String> {
    let found = dlna::discover().await;
    tracing::info!("cast: found {} TVs: {}", found.len(), found.iter().map(|renderer| format!("{} ({} {})", renderer.name, renderer.maker, renderer.model)).collect::<Vec<_>>().join(", "));
    let mut devices = cast.devices.lock().unwrap();
    for renderer in &found {
        devices.insert(renderer.id.clone(), renderer.clone());
    }
    Ok(found)
}

#[tauri::command]
pub async fn cast_start(app: State<'_, AppState>, cast: State<'_, CastState>, request: CastRequest) -> Result<CastStarted, String> {
    let renderer = renderer_for(&cast, &request.device).await?;
    let sink = dlna::sink_formats(&renderer).await;
    let source = format!("{}/stream/{}/{}", app.stream_base_url, request.info_hash, request.file_index);
    let mut external = None;
    let mut subtitles = None;
    if let Some(choice) = request.subtitle.as_ref().filter(|choice| choice.kind == "external") {
        if let Some(content) = choice.content.as_deref().filter(|content| !content.trim().is_empty()) {
            match stream::shifted_subtitles(&app.data_dir, content, request.start).await {
                Ok((path, bytes)) => {
                    external = Some(path);
                    subtitles = Some(bytes);
                }
                Err(error) => tracing::warn!("cast: subtitles could not be prepared: {error}"),
            }
        }
    }
    let plan = plan_for(&request, source, &sink, external.clone());
    let port = stream::ensure_server(cast.shared.clone()).await.map_err(|error| format!("cast_server_failed: {error}"))?;
    let tv: IpAddr = renderer.address.parse().map_err(|_| "cast_device_gone".to_owned())?;
    let local = dlna::local_address_towards(tv).ok_or_else(|| "cast_no_network".to_owned())?;
    let host = match local {
        IpAddr::V4(ip) => format!("{ip}:{port}"),
        IpAddr::V6(ip) => format!("[{ip}]:{port}"),
    };
    let token = crate::store::random_token();
    let url = format!("http://{host}/cast/{token}/video.{}", plan.extension());
    let subtitle_url = subtitles.as_ref().map(|_| format!("http://{host}/cast/{token}/subs.srt"));
    let mime = plan.mime().to_owned();
    let direct = plan.direct;
    let start = plan.start;
    tracing::info!(
        "cast: {} on {} ({} {}) level={} direct={} sink={}",
        request.title,
        renderer.name,
        renderer.maker,
        renderer.model,
        request.level,
        direct,
        if sink.is_empty() { "unknown" } else if sink.contains("matroska") { "mkv" } else { "no-mkv" }
    );
    stream::stop_running(&cast.shared);
    *cast.shared.session.lock().unwrap() = Some(Arc::new(Session { token, plan, subtitles, shifted_path: external, data_dir: app.data_dir.clone() }));
    let duration = (request.duration > 0.0).then(|| if direct { request.duration } else { (request.duration - start).max(1.0) });
    let media = dlna::Media { url: &url, mime: &mime, title: &request.title, duration, subtitle_url: subtitle_url.as_deref(), streaming: !direct };
    dlna::load(&renderer, &media).await.map_err(|error| {
        tracing::warn!("cast: the TV refused the video: {error}");
        if error.to_string().starts_with("cast_unreachable") { "cast_unreachable".to_owned() } else { "cast_refused".to_owned() }
    })?;
    if direct && start > 1.0 {
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        if let Err(error) = dlna::seek(&renderer, start).await {
            tracing::info!("cast: the TV could not jump to {start:.0}s: {error}");
        }
    }
    *cast.active.lock().unwrap() = Some(Active { renderer: renderer.clone(), start: if direct { 0.0 } else { start }, direct, clock_base: start, clock_since: None, last_position: start });
    Ok(CastStarted { level: request.level, direct, mime, url, address: renderer.address })
}

fn current(cast: &CastState) -> Result<Renderer, String> {
    cast.active.lock().unwrap().as_ref().map(|active| active.renderer.clone()).ok_or_else(|| "cast_not_active".to_owned())
}

#[tauri::command]
pub async fn cast_status(cast: State<'_, CastState>) -> Result<CastStatus, String> {
    let Ok(renderer) = current(&cast) else {
        return Ok(CastStatus { active: false, state: String::new(), position: 0.0, reported: false, duration: None, volume: None });
    };
    let transport = dlna::transport(&renderer).await.map_err(|_| "cast_unreachable".to_owned())?;
    let volume = dlna::volume(&renderer).await;
    let mut active = cast.active.lock().unwrap();
    let Some(active) = active.as_mut() else {
        return Ok(CastStatus { active: false, state: String::new(), position: 0.0, reported: false, duration: None, volume: None });
    };
    let playing = transport.state == "PLAYING";
    match (playing, active.clock_since) {
        (true, None) => active.clock_since = Some(Instant::now()),
        (false, Some(since)) => {
            active.clock_base += since.elapsed().as_secs_f64();
            active.clock_since = None;
        }
        _ => {}
    }
    let estimated = active.clock_base + active.clock_since.map(|since| since.elapsed().as_secs_f64()).unwrap_or(0.0);
    let reported = transport.position.filter(|value| *value > 0.5);
    let position = match reported {
        Some(value) => active.start + value,
        None => estimated,
    };
    if reported.is_some() {
        active.clock_base = position;
        if active.clock_since.is_some() {
            active.clock_since = Some(Instant::now());
        }
    }
    active.last_position = position;
    let duration = transport.duration.map(|value| if active.direct { value } else { active.start + value });
    Ok(CastStatus { active: true, state: transport.state, position, reported: reported.is_some(), duration, volume })
}

#[tauri::command]
pub async fn cast_play(cast: State<'_, CastState>) -> Result<(), String> {
    dlna::play(&current(&cast)?).await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn cast_pause(cast: State<'_, CastState>) -> Result<(), String> {
    dlna::pause(&current(&cast)?).await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn cast_volume(cast: State<'_, CastState>, value: u32) -> Result<(), String> {
    dlna::set_volume(&current(&cast)?, value).await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn cast_seek_native(cast: State<'_, CastState>, position: f64) -> Result<bool, String> {
    let (renderer, direct) = {
        let active = cast.active.lock().unwrap();
        let active = active.as_ref().ok_or_else(|| "cast_not_active".to_owned())?;
        (active.renderer.clone(), active.direct)
    };
    if !direct {
        return Ok(false);
    }
    match dlna::seek(&renderer, position).await {
        Ok(()) => {
            if let Some(active) = cast.active.lock().unwrap().as_mut() {
                active.clock_base = position;
                if active.clock_since.is_some() {
                    active.clock_since = Some(Instant::now());
                }
            }
            Ok(true)
        }
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub async fn cast_stop(cast: State<'_, CastState>) -> Result<(), String> {
    let renderer = cast.active.lock().unwrap().take().map(|active| active.renderer);
    stream::stop_running(&cast.shared);
    *cast.shared.session.lock().unwrap() = None;
    if let Some(renderer) = renderer {
        let _ = dlna::stop(&renderer).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(level: u8) -> CastRequest {
        CastRequest {
            device: "uuid:1".into(),
            info_hash: "abc".into(),
            file_index: 0,
            file_name: "Film.2024.1080p.mkv".into(),
            title: "Film".into(),
            start: 120.0,
            duration: 6000.0,
            audio: Some(0),
            audio_codec: "ac3".into(),
            audio_channels: "5.1(side)".into(),
            video_codec: "h264".into(),
            subtitle: None,
            burn: false,
            level,
        }
    }

    #[test]
    fn simple_files_go_straight_to_the_tv() {
        let plan = plan_for(&request(0), "src".into(), "http-get:*:video/x-matroska:*", None);
        assert!(plan.direct);
        assert_eq!(plan.mime(), "video/x-matroska");
    }

    #[test]
    fn another_voice_or_subtitles_need_a_remux() {
        let mut chosen = request(0);
        chosen.audio = Some(2);
        let plan = plan_for(&chosen, "src".into(), "video/x-matroska", None);
        assert!(!plan.direct);
        assert_eq!(plan.container, Container::Matroska);
        assert!(plan.audio_copy);
        chosen.audio = Some(0);
        chosen.subtitle = Some(CastSubtitle { kind: "internal".into(), index: Some(1), text: Some(true), content: None });
        assert!(!plan_for(&chosen, "src".into(), "video/x-matroska", None).direct);
    }

    #[test]
    fn dts_turns_into_ac3_and_old_tvs_get_transport_stream() {
        let mut chosen = request(0);
        chosen.audio_codec = "dts".into();
        chosen.audio_channels = "7.1".into();
        let plan = plan_for(&chosen, "src".into(), "http-get:*:video/mp2t:*", None);
        assert!(!plan.direct);
        assert!(!plan.audio_copy);
        assert!(plan.audio_channels_over_six);
        assert_eq!(plan.container, Container::Transport);
    }

    #[test]
    fn higher_levels_get_safer() {
        let plan = plan_for(&request(2), "src".into(), "video/x-matroska", None);
        assert_eq!(plan.container, Container::Transport);
        assert!(!plan.audio_copy);
        assert!(!plan.video_encode);
        assert!(plan_for(&request(3), "src".into(), "video/x-matroska", None).video_encode);
    }

    #[tokio::test]
    #[ignore]
    async fn fake_tv_receives_the_chosen_tracks() {
        let file = std::env::var("KINUZA_CAST_FILE").unwrap();
        let data_dir = PathBuf::from(std::env::var("KINUZA_DATA_DIR").unwrap());
        let report = std::env::var("KINUZA_CAST_REPORT").unwrap();
        let level: u8 = std::env::var("KINUZA_CAST_LEVEL").ok().and_then(|value| value.parse().ok()).unwrap_or(0);
        let _ = std::fs::remove_file(&report);
        let tv = dlna::discover().await.into_iter().find(|renderer| renderer.name == "Kinuza Test TV").expect("the fake TV answers the search");
        let sink = dlna::sink_formats(&tv).await;
        let mut chosen = request(level);
        chosen.file_name = "test.mkv".into();
        chosen.start = 30.0;
        chosen.duration = 120.0;
        chosen.audio = Some(1);
        chosen.audio_codec = "dts".into();
        chosen.audio_channels = "stereo".into();
        chosen.subtitle = Some(CastSubtitle { kind: "internal".into(), index: Some(0), text: Some(true), content: None });
        let burn = std::env::var("KINUZA_CAST_BURN").is_ok();
        let mut shifted = None;
        if burn {
            let text = std::fs::read_to_string(std::env::var("KINUZA_CAST_SUBS").unwrap()).unwrap();
            let (path, _) = stream::shifted_subtitles(&data_dir, &text, chosen.start).await.unwrap();
            chosen.subtitle = Some(CastSubtitle { kind: "external".into(), index: None, text: None, content: Some(text) });
            chosen.burn = true;
            shifted = Some(path);
        }
        let plan = plan_for(&chosen, file, &sink, shifted.clone());
        assert_eq!(plan.burn, burn);
        let shared = Arc::new(Shared::default());
        let port = stream::ensure_server(shared.clone()).await.unwrap();
        let url = format!("http://127.0.0.1:{port}/cast/testtoken/video.{}", plan.extension());
        let mime = plan.mime().to_owned();
        *shared.session.lock().unwrap() = Some(Arc::new(Session { token: "testtoken".into(), plan, subtitles: None, shifted_path: shifted, data_dir }));
        let media = dlna::Media { url: &url, mime: &mime, title: "Test", duration: Some(90.0), subtitle_url: None, streaming: true };
        dlna::load(&tv, &media).await.unwrap();
        let mut seen = None;
        for _ in 0..40 {
            let transport = dlna::transport(&tv).await.unwrap();
            if transport.state == "PLAYING" && transport.position.unwrap_or(0.0) >= 3.0 {
                seen = Some(transport);
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        let seen = seen.expect("the TV plays the stream");
        dlna::pause(&tv).await.unwrap();
        assert_eq!(dlna::transport(&tv).await.unwrap().state, "PAUSED_PLAYBACK");
        dlna::play(&tv).await.unwrap();
        dlna::set_volume(&tv, 30).await.unwrap();
        assert_eq!(dlna::volume(&tv).await, Some(17));
        dlna::stop(&tv).await.unwrap();
        let received = std::fs::read_to_string(&report).unwrap();
        println!("level {level} position {:?} streams {received}", seen.position);
        assert!(received.contains("ac3"), "DTS became AC3");
        assert!(!received.contains("dts"));
        assert_eq!(received.matches("Audio:").count(), 1, "only the chosen voice");
        if burn {
            assert!(!received.contains("Subtitle"));
        } else if level < 2 {
            assert!(received.contains("Subtitle: subrip"));
        } else {
            assert!(!received.contains("Subtitle"));
        }
    }

    #[test]
    fn text_subtitles_inside_the_file_are_not_burned() {
        let mut chosen = request(1);
        chosen.burn = true;
        chosen.subtitle = Some(CastSubtitle { kind: "internal".into(), index: Some(0), text: Some(true), content: None });
        assert!(!plan_for(&chosen, "src".into(), "", None).burn);
        chosen.subtitle = Some(CastSubtitle { kind: "internal".into(), index: Some(0), text: Some(false), content: None });
        assert!(plan_for(&chosen, "src".into(), "", None).burn);
    }
}
