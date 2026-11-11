mod associations;
mod commands;
mod engine;
mod external_player;
mod ffmpeg;
mod imdb;
mod launch;
mod logging;
mod mpv;
mod online_subtitles;
mod rutracker;
mod server;
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
}

const DOWNLOAD_FOLDER_NAME: &str = "Kinuza";
const SESSION_FOLDER_NAME: &str = "session";
const STREAM_CACHE_FOLDER_NAME: &str = "stream-cache";

pub fn run() {
    tauri::Builder::default()
        .manage(TokioMutex::new(rutracker::RutrackerState::new()))
        .manage(imdb::ImdbState::default())
        .manage(ffmpeg::FfmpegState::default())
        .manage(mpv::MpvState::default())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
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
            let state = tauri::async_runtime::block_on(build_state(app.handle()))?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::torrent_inspect,
            commands::torrent_add,
            commands::torrent_list,
            commands::torrent_pause,
            commands::torrent_resume,
            commands::torrent_delete,
            commands::torrent_select_files,
            commands::torrent_release,
            commands::torrent_set_policy,
            commands::storage_info,
            commands::stream_cache_clear,
            rutracker::rutracker_torrent_inspect,
            logging::log_write,
            logging::logs_open,
            commands::write_text_file,
            commands::file_location,
            commands::open_external,
            commands::read_file_bytes,
            commands::take_launch_request,
            commands::associations_status,
            commands::associations_set,
            commands::open_default_apps_settings,
            store::store_get,
            store::store_set,
            imdb::imdb_rating,
            tray::tray_configure,
            online_subtitles::online_subtitles_search,
            online_subtitles::online_subtitles_download,
            ffmpeg::ffmpeg_status,
            ffmpeg::ffmpeg_install,
            ffmpeg::media_tracks,
            mpv::mpv_status,
            mpv::mpv_install,
            mpv::mpv_command,
            mpv::mpv_set,
            mpv::mpv_add_subtitle_text,
            
            rutracker::rutracker_login_window,
            rutracker::rutracker_search,
            rutracker::rutracker_magnet,
            rutracker::rutracker_video_sizes,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Kinuza")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                tauri::async_runtime::block_on(mpv::shutdown(&app.state::<mpv::MpvState>()));
                if let Some(state) = app.try_state::<AppState>() {
                    mpv::clear_subtitle_files(&state.data_dir);
                }
            }
        });
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
    })
}