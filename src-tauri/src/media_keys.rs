use std::{sync::Mutex, time::Duration};

use serde::{Deserialize, Serialize};
use souvlaki::{MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig, SeekDirection};
use tauri::{AppHandle, Emitter, Manager};

const EVENT_NAME: &str = "media-key";
const DBUS_NAME: &str = "kinuza";
const STEP_SECONDS: f64 = 10.0;

struct Controls(MediaControls);

unsafe impl Send for Controls {}

#[derive(Default)]
pub struct MediaKeys {
    controls: Mutex<Option<Controls>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MediaKeyEvent {
    action: &'static str,
    seconds: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    title: String,
    subtitle: String,
    cover_url: Option<String>,
    duration: f64,
}

fn translate(event: MediaControlEvent) -> Option<MediaKeyEvent> {
    let (action, seconds) = match event {
        MediaControlEvent::Play => ("play", None),
        MediaControlEvent::Pause => ("pause", None),
        MediaControlEvent::Toggle => ("toggle", None),
        MediaControlEvent::Next => ("next", None),
        MediaControlEvent::Previous => ("previous", None),
        MediaControlEvent::Stop => ("stop", None),
        MediaControlEvent::Seek(SeekDirection::Forward) => ("seekBy", Some(STEP_SECONDS)),
        MediaControlEvent::Seek(SeekDirection::Backward) => ("seekBy", Some(-STEP_SECONDS)),
        MediaControlEvent::SeekBy(SeekDirection::Forward, by) => ("seekBy", Some(by.as_secs_f64())),
        MediaControlEvent::SeekBy(SeekDirection::Backward, by) => ("seekBy", Some(-by.as_secs_f64())),
        MediaControlEvent::SetPosition(MediaPosition(at)) => ("seekTo", Some(at.as_secs_f64())),
        _ => return None,
    };
    Some(MediaKeyEvent { action, seconds })
}

fn open(app: &AppHandle) -> Result<MediaControls, String> {
    #[cfg(windows)]
    let hwnd = {
        let window = app.get_webview_window("main").ok_or_else(|| "media_keys_unavailable".to_owned())?;
        Some(window.hwnd().map_err(|error| error.to_string())?.0 as *mut std::ffi::c_void)
    };
    #[cfg(not(windows))]
    let hwnd = {
        let _ = app.get_webview_window("main");
        None
    };
    let config = PlatformConfig { display_name: "Kinuza", dbus_name: DBUS_NAME, hwnd };
    let mut controls = MediaControls::new(config).map_err(|error| format!("{error:?}"))?;
    let events = app.clone();
    controls
        .attach(move |event| {
            if let Some(event) = translate(event) {
                let _ = events.emit(EVENT_NAME, event);
            }
        })
        .map_err(|error| format!("{error:?}"))?;
    Ok(controls)
}

fn on_main<T: Send + 'static>(app: &AppHandle, work: impl FnOnce(&AppHandle) -> T + Send + 'static) -> Result<T, String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = sender.send(work(&handle));
    })
    .map_err(|error| error.to_string())?;
    receiver.recv_timeout(Duration::from_secs(5)).map_err(|_| "media_keys_timeout".to_owned())
}

#[tauri::command]
pub async fn media_session_start(app: AppHandle, now: NowPlaying) -> Result<(), String> {
    on_main(&app, move |app| {
        let keys = app.state::<MediaKeys>();
        let mut slot = keys.controls.lock().unwrap();
        if slot.is_none() {
            match open(app) {
                Ok(controls) => *slot = Some(Controls(controls)),
                Err(error) => {
                    tracing::warn!("media keys: unavailable: {error}");
                    return;
                }
            }
        }
        if let Some(Controls(controls)) = slot.as_mut() {
            let duration = (now.duration.is_finite() && now.duration > 0.0).then(|| Duration::from_secs_f64(now.duration));
            let _ = controls.set_metadata(MediaMetadata {
                title: Some(&now.title),
                artist: Some(&now.subtitle),
                album: Some("Kinuza"),
                cover_url: now.cover_url.as_deref(),
                duration,
            });
        }
    })
}

#[tauri::command]
pub async fn media_session_state(app: AppHandle, playing: bool, position: f64) -> Result<(), String> {
    on_main(&app, move |app| {
        let keys = app.state::<MediaKeys>();
        let mut slot = keys.controls.lock().unwrap();
        if let Some(Controls(controls)) = slot.as_mut() {
            let progress = (position.is_finite() && position >= 0.0).then(|| MediaPosition(Duration::from_secs_f64(position)));
            let playback = if playing { MediaPlayback::Playing { progress } } else { MediaPlayback::Paused { progress } };
            let _ = controls.set_playback(playback);
        }
    })
}

#[tauri::command]
pub async fn media_session_stop(app: AppHandle) -> Result<(), String> {
    on_main(&app, move |app| {
        let keys = app.state::<MediaKeys>();
        let mut slot = keys.controls.lock().unwrap();
        if let Some(Controls(mut controls)) = slot.take() {
            let _ = controls.set_playback(MediaPlayback::Stopped);
            let _ = controls.detach();
        }
    })
}
