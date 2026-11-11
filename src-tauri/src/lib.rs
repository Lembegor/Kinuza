mod associations;
mod commands;
mod engine;
mod external_player;
mod launch;
mod server;
mod store;

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use tauri::{Emitter, Manager};

use engine::Engine;

/// Everything the commands need; created once in `setup`.
pub struct AppState {
    pub engine: Arc<Engine>,
    pub stream_base_url: String,
    pub data_dir: PathBuf,
    pub default_download_dir: PathBuf,
    /// A link the app was started with; the window picks it up once it is ready.
    pub pending_launch: Mutex<Option<launch::LaunchRequest>>,
}

const DOWNLOAD_FOLDER_NAME: &str = "Kinuza";
const SESSION_FOLDER_NAME: &str = "session";

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            // A second launch carrying a link forwards it to the window that is already open.
            if let Some(request) = launch::from_args(args) {
                let _ = app.emit(launch::LAUNCH_EVENT, request);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
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
            commands::file_location,
            commands::open_external,
            commands::read_file_bytes,
            commands::take_launch_request,
            commands::associations_status,
            commands::associations_set,
            commands::open_default_apps_settings,
            store::store_get,
            store::store_set,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kinuza");
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

    let engine = Arc::new(
        Engine::start(default_download_dir.clone(), data_dir.join(SESSION_FOLDER_NAME)).await?,
    );
    let stream_base_url = server::start(engine.clone(), store::random_token()).await?;

    Ok(AppState {
        engine,
        stream_base_url,
        data_dir,
        default_download_dir,
        pending_launch: Mutex::new(launch::from_args(std::env::args().skip(1))),
    })
}
