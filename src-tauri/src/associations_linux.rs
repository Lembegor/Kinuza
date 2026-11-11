use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use serde::Serialize;

const DESKTOP_FILE_NAME: &str = "kinuza-links.desktop";
const MAGNET_TYPE: &str = "x-scheme-handler/magnet";
const TORRENT_TYPE: &str = "application/x-bittorrent";
const HANDLED_TYPES: &[&str] = &[MAGNET_TYPE, TORRENT_TYPE];
const PREVIOUS_KEY_PREFIX: &str = "X-Kinuza-Previous-";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssociationStatus {
    pub enabled: bool,
    pub overridden_by_windows: bool,
}

fn data_home() -> Option<PathBuf> {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
}

fn config_home() -> Option<PathBuf> {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
}

fn applications_folder() -> Result<PathBuf> {
    data_home().map(|folder| folder.join("applications")).context("cannot find the user data folder")
}

fn desktop_file() -> Result<PathBuf> {
    Ok(applications_folder()?.join(DESKTOP_FILE_NAME))
}

fn launcher() -> Result<String> {
    if let Some(image) = std::env::var_os("APPIMAGE").filter(|path| !path.is_empty()) {
        return Ok(image.to_string_lossy().into_owned());
    }
    Ok(std::env::current_exe().context("cannot locate the executable")?.to_string_lossy().into_owned())
}

fn exec_line(program: &str) -> String {
    let mut quoted = String::from("\"");
    for character in program.chars() {
        match character {
            '\\' => quoted.push_str("\\\\\\\\"),
            '"' | '`' | '$' => {
                quoted.push_str("\\\\");
                quoted.push(character);
            }
            '%' => quoted.push_str("%%"),
            _ => quoted.push(character),
        }
    }
    quoted.push('"');
    format!("Exec={quoted} %u")
}

fn desktop_entry(program: &str, previous: &[(&str, String)]) -> String {
    let mut entry = format!(
        "[Desktop Entry]\nType=Application\nName=Kinuza\nComment=Kinuza media library and player\n{}\nIcon=kinuza\nTerminal=false\nNoDisplay=true\nMimeType={};\n",
        exec_line(program),
        HANDLED_TYPES.join(";"),
    );
    for (kind, handler) in previous {
        entry.push_str(&format!("{PREVIOUS_KEY_PREFIX}{}={handler}\n", key_for(kind)));
    }
    entry
}

fn key_for(kind: &str) -> String {
    kind.replace(['/', '-'], "_")
}

fn query_default(kind: &str) -> Option<String> {
    let output = crate::host::command("xdg-mime").args(["query", "default", kind]).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let handler = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!handler.is_empty()).then_some(handler)
}

fn set_default(handler: &str, kind: &str) -> Result<()> {
    let status = crate::host::command("xdg-mime")
        .args(["default", handler, kind])
        .status()
        .context("xdg-mime is not available")?;
    if !status.success() {
        bail!("xdg-mime could not set the handler for {kind}");
    }
    Ok(())
}

fn refresh_database() {
    if let Ok(folder) = applications_folder() {
        let _ = crate::host::command("update-desktop-database").arg(folder).status();
    }
}

fn previous_handlers(text: &str) -> Vec<(&'static str, String)> {
    HANDLED_TYPES
        .iter()
        .filter_map(|kind| {
            let prefix = format!("{PREVIOUS_KEY_PREFIX}{}=", key_for(kind));
            text.lines()
                .find_map(|line| line.strip_prefix(&prefix))
                .map(str::trim)
                .filter(|handler| !handler.is_empty())
                .map(|handler| (*kind, handler.to_owned()))
        })
        .collect()
}

pub fn status() -> AssociationStatus {
    let enabled = (|| {
        let text = std::fs::read_to_string(desktop_file().ok()?).ok()?;
        let expected = exec_line(&launcher().ok()?);
        let current = text.lines().any(|line| line == expected);
        let chosen = HANDLED_TYPES.iter().all(|kind| query_default(kind).as_deref() == Some(DESKTOP_FILE_NAME));
        Some(current && chosen)
    })()
    .unwrap_or(false);
    AssociationStatus { enabled, overridden_by_windows: false }
}

pub fn enable() -> Result<()> {
    let path = desktop_file()?;
    let remembered = std::fs::read_to_string(&path).map(|text| previous_handlers(&text)).unwrap_or_default();
    let previous: Vec<(&str, String)> = HANDLED_TYPES
        .iter()
        .filter_map(|kind| {
            remembered
                .iter()
                .find(|(known, _)| known == kind)
                .map(|(_, handler)| handler.clone())
                .or_else(|| query_default(kind).filter(|handler| handler != DESKTOP_FILE_NAME))
                .map(|handler| (*kind, handler))
        })
        .collect();

    std::fs::create_dir_all(applications_folder()?)?;
    let staging = path.with_extension("desktop.tmp");
    std::fs::write(&staging, desktop_entry(&launcher()?, &previous))?;
    std::fs::rename(&staging, &path)?;
    refresh_database();
    for kind in HANDLED_TYPES {
        set_default(DESKTOP_FILE_NAME, kind)?;
    }
    Ok(())
}

pub fn disable() -> Result<()> {
    let path = desktop_file()?;
    let previous = std::fs::read_to_string(&path).map(|text| previous_handlers(&text)).unwrap_or_default();
    for kind in HANDLED_TYPES {
        if query_default(kind).as_deref() != Some(DESKTOP_FILE_NAME) {
            continue;
        }
        if let Some((_, handler)) = previous.iter().find(|(known, _)| known == kind) {
            let _ = set_default(handler, kind);
        }
    }
    forget_in_mimeapps();
    let _ = std::fs::remove_file(&path);
    refresh_database();
    Ok(())
}

fn forget_in_mimeapps() {
    let Some(path) = config_home().map(|folder| folder.join("mimeapps.list")) else { return };
    let Ok(text) = std::fs::read_to_string(&path) else { return };
    if let Some(cleaned) = without_our_handler(&text) {
        let _ = std::fs::write(&path, cleaned);
    }
}

fn without_our_handler(text: &str) -> Option<String> {
    let mut changed = false;
    let mut cleaned = Vec::new();
    for line in text.lines() {
        let ours = line
            .split_once('=')
            .filter(|(kind, handlers)| HANDLED_TYPES.contains(&kind.trim()) && handlers.contains(DESKTOP_FILE_NAME));
        let Some((kind, handlers)) = ours else {
            cleaned.push(line.to_owned());
            continue;
        };
        changed = true;
        let rest: Vec<&str> = handlers
            .split(';')
            .map(str::trim)
            .filter(|handler| !handler.is_empty() && *handler != DESKTOP_FILE_NAME)
            .collect();
        if !rest.is_empty() {
            cleaned.push(format!("{kind}={};", rest.join(";")));
        }
    }
    changed.then(|| {
        let mut text = cleaned.join("\n");
        text.push('\n');
        text
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_the_launcher() {
        assert_eq!(exec_line("/opt/My Apps/Kinuza.AppImage"), "Exec=\"/opt/My Apps/Kinuza.AppImage\" %u");
        assert_eq!(exec_line("/home/a$b/100%"), "Exec=\"/home/a\\\\$b/100%%\" %u");
        assert_eq!(exec_line("/x\\y"), "Exec=\"/x\\\\\\\\y\" %u");
    }

    #[test]
    fn forgets_only_our_handler() {
        let list = "[Default Applications]\nx-scheme-handler/magnet=kinuza-links.desktop\napplication/x-bittorrent=kinuza-links.desktop;qbittorrent.desktop;\ntext/html=firefox.desktop\n";
        assert_eq!(
            without_our_handler(list).unwrap(),
            "[Default Applications]\napplication/x-bittorrent=qbittorrent.desktop;\ntext/html=firefox.desktop\n"
        );
        assert!(without_our_handler("[Default Applications]\ntext/html=firefox.desktop\n").is_none());
    }

    #[test]
    fn remembers_previous_handlers() {
        let entry = desktop_entry("/usr/bin/kinuza", &[(MAGNET_TYPE, "qbittorrent.desktop".to_owned())]);
        assert_eq!(previous_handlers(&entry), vec![(MAGNET_TYPE, "qbittorrent.desktop".to_owned())]);
    }
}
