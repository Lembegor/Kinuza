#[cfg(windows)]
mod associations;
#[cfg(not(windows))]
#[path = "associations_linux.rs"]
mod associations;
mod activity;
mod catalog;
mod commands;
mod engine;
mod external_player;
mod ffmpeg;
mod fingerprint;
mod gateway;
mod children;
mod files;
mod host;
mod imdb;
mod launch;
mod logging;
mod media_keys;
mod metadata;
mod mpv;
mod online_subtitles;
mod report;
mod rutracker;
mod server;
mod storage;
mod store;
mod tray;

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::sync::Mutex as TokioMutex;

use tauri::{Emitter, Manager};

use engine::Engine;

pub struct AppState {
    pub engine: Arc<Engine>,
    pub stream_base_url: String,
    pub data_dir: PathBuf,
    pub default_download_dir: PathBuf,
    pub pending_launch: Mutex<Option<launch::LaunchRequest>>,
    pub updated_from: Option<String>,
}

const DOWNLOAD_FOLDER_NAME: &str = "Kinuza";
const SESSION_FOLDER_NAME: &str = "session";
const STREAM_CACHE_FOLDER_NAME: &str = "stream-cache";
const STARTUP_ERROR_TEXT: &str = "Kinuza не смогла запуститься. Подробности записаны в журнал (папка logs в данных приложения).";

#[cfg(target_os = "linux")]
fn prepare_linux_webview() {
    let nvidia = std::path::Path::new("/proc/driver/nvidia/version").exists();
    if nvidia && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

pub fn run() {
    #[cfg(target_os = "linux")]
    prepare_linux_webview();
    storage::clear_pending_web_cache();
    tauri::Builder::default()
        .manage(TokioMutex::new(rutracker::RutrackerState::new()))
        .manage(imdb::ImdbState::default())
        .manage(ffmpeg::FfmpegState::default())
        .manage(mpv::MpvState::default())
        .manage(fingerprint::PrintState::default())
        .manage(files::FileGrants::default())
        .manage(media_keys::MediaKeys::default())
        .manage(catalog::CatalogState::default())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            if let Some(request) = launch::from_args(args) {
                let _ = app.emit(launch::LAUNCH_EVENT, request);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let state = match tauri::async_runtime::block_on(build_state(app.handle())) {
                Ok(state) => state,
                Err(error) => {
                    tracing::error!("startup failed: {error:#}");
                    show_startup_error(&format!("{error:#}"));
                    return Err(error.into());
                }
            };
            app.manage(state);
            catalog::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::torrent_inspect,
            commands::torrent_add,
            commands::torrent_list,
            commands::torrent_pause,
            commands::torrent_resume,
            commands::torrent_set_upload,
            storage::storage_report,
            storage::storage_clear_part,
            storage::storage_drop_cached,
            storage::storage_free_download,
            commands::torrent_delete,
            commands::torrent_select_files,
            commands::torrent_hold,
            commands::torrent_warm,
            commands::engine_stop,
            commands::app_log,
            commands::torrent_exclude_files,
            commands::torrent_focus,
            commands::torrent_reorder,
            commands::torrent_release,
            commands::torrent_set_policy,
            commands::storage_info,
            commands::stream_cache_clear,
            rutracker::rutracker_torrent_inspect,
            logging::log_write,
            logging::logs_open,
            files::write_text_file,
            files::file_pick,
            files::file_save_target,
            commands::file_location,
            commands::open_external,
            files::read_file_bytes,
            commands::take_launch_request,
            commands::torrent_file_map,
            online_subtitles::subtitle_file_hash,
            commands::associations_status,
            commands::associations_set,
            commands::open_default_apps_settings,
            store::store_get,
            store::store_set,
            activity::activity_append,
            activity::activity_read,
            imdb::imdb_rating,
            imdb::imdb_ratings,
            tray::tray_configure,
            online_subtitles::online_subtitles_search,
            metadata::wikidata_links,
            metadata::shikimori_anime,
            metadata::shikimori_names,
            metadata::shikimori_search,
            metadata::wikidata_by_mal,
            catalog::catalog_lookup,
            catalog::catalog_search,
            catalog::catalog_status,
            online_subtitles::online_subtitles_download,
            ffmpeg::ffmpeg_status,
            ffmpeg::ffmpeg_install,
            ffmpeg::media_tracks,
            mpv::mpv_status,
            fingerprint::audio_print,
            fingerprint::audio_offset,
            fingerprint::audio_print_cancel,
            fingerprint::audio_segments,
            mpv::mpv_install,
            mpv::mpv_command,
            mpv::mpv_set,
            mpv::mpv_place,
            mpv::mpv_warm,
            mpv::mpv_surface,
            mpv::mpv_quit,
            mpv::mpv_add_subtitle_text,
            mpv::mpv_audio_filter,
            mpv::mpv_stats,
            mpv::mpv_screenshot,
            files::save_screenshot,
            report::report_build,
            report::report_send,
            media_keys::media_session_start,
            media_keys::media_session_state,
            media_keys::media_session_stop,
            rutracker::rutracker_login_window,
            rutracker::rutracker_maybe_signed_in,
            rutracker::rutracker_show_window,
            rutracker::rutracker_account,
            rutracker::rutracker_sign_out,
            rutracker::rutracker_search,
            rutracker::rutracker_magnet,
            rutracker::rutracker_video_sizes,
            gateway::gateway_search,
            gateway::gateway_torrent_inspect,
            gateway::gateway_video_sizes,
            gateway::gateway_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Kinuza")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                tauri::async_runtime::block_on(mpv::shutdown(&app.state::<mpv::MpvState>()));
                if let Some(state) = app.try_state::<AppState>() {
                    mpv::clear_subtitle_files(&state.data_dir);
                    tauri::async_runtime::block_on(state.engine.stop());
                }
            }
        });
}

#[cfg(windows)]
fn show_startup_error(detail: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    let wide = |text: &str| text.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let text = wide(&format!("{STARTUP_ERROR_TEXT}

{detail}"));
    let title = wide("Kinuza");
    unsafe {
        MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR);
    }
}

#[cfg(not(windows))]
fn show_startup_error(detail: &str) {
    let text = format!("{STARTUP_ERROR_TEXT}

{detail}");
    let shown = host::command("zenity")
        .args(["--error", "--title=Kinuza", "--no-markup", "--text"])
        .arg(&text)
        .status()
        .is_ok_and(|status| status.success());
    if !shown {
        let _ = host::command("kdialog").args(["--title", "Kinuza", "--error"]).arg(&text).status();
    }
}

async fn build_state(app: &tauri::AppHandle) -> anyhow::Result<AppState> {
    let data_dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data_dir)?;

    let default_download_dir = app
        .path()
        .video_dir()
        .or_else(|_| app.path().download_dir())
        .unwrap_or_else(|_| data_dir.clone())
        .join(DOWNLOAD_FOLDER_NAME);

    logging::start(&data_dir, &app.package_info().version.to_string());
    let updated_from = store::snapshot_on_version_change(&data_dir, &app.package_info().version.to_string());

    let engine = Engine::start(
        default_download_dir.clone(),
        data_dir.join(SESSION_FOLDER_NAME),
        data_dir.join(STREAM_CACHE_FOLDER_NAME),
    )
    .await?;
    let stream_base_url = server::start(engine.clone(), store::random_token(), data_dir.clone()).await?;

    Ok(AppState {
        engine,
        stream_base_url,
        data_dir,
        default_download_dir,
        pending_launch: Mutex::new(launch::from_args(std::env::args().skip(1))),
        updated_from,
    })
}