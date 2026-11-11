use serde::Deserialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

const TRAY_ID: &str = "main";
const MAIN_WINDOW_LABEL: &str = "main";
const MENU_OPEN: &str = "open";
const MENU_QUIT: &str = "quit";
pub const QUIT_EVENT: &str = "tray-quit";

#[derive(Deserialize)]
pub struct TrayLabels {
    open: String,
    quit: String,
    tooltip: String,
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[tauri::command]
pub fn tray_configure(app: AppHandle, enabled: bool, labels: TrayLabels) -> Result<(), String> {
    let _ = app.remove_tray_by_id(TRAY_ID);
    if !enabled {
        return Ok(());
    }
    let build = || -> tauri::Result<()> {
        let open = MenuItem::with_id(&app, MENU_OPEN, &labels.open, true, None::<&str>)?;
        let quit = MenuItem::with_id(&app, MENU_QUIT, &labels.quit, true, None::<&str>)?;
        let menu = Menu::with_items(&app, &[&open, &quit])?;
        let mut tray = TrayIconBuilder::with_id(TRAY_ID)
            .tooltip(&labels.tooltip)
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id().as_ref() {
                MENU_OPEN => show_main_window(app),
                MENU_QUIT => {
                    if app.emit(QUIT_EVENT, ()).is_err() {
                        app.exit(0);
                    }
                }
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                    show_main_window(tray.app_handle());
                }
            });
        if let Some(icon) = app.default_window_icon() {
            tray = tray.icon(icon.clone());
        }
        tray.build(&app)?;
        Ok(())
    };
    build().map_err(|e| e.to_string())
}
