//! Registers Kinuza as the Windows handler for `magnet:` links and `.torrent` files (current user only).
//!
//! Turning it on remembers the handlers that were there before; turning it off puts them back.

use anyhow::{Context, Result};
use serde::Serialize;
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

const CLASSES_KEY: &str = "Software\\Classes";
const MAGNET_CLASS: &str = "magnet";
const TORRENT_EXTENSION: &str = ".torrent";
const MAGNET_PROG_ID: &str = "Kinuza.Magnet";
const TORRENT_PROG_ID: &str = "Kinuza.Torrent";
const OPEN_COMMAND_KEY: &str = "shell\\open\\command";
const OPEN_WITH_KEY: &str = "OpenWithProgids";

const CAPABILITIES_KEY: &str = "Software\\Kinuza\\Capabilities";
const PREVIOUS_HANDLERS_KEY: &str = "Software\\Kinuza\\PreviousHandlers";
const REGISTERED_APPLICATIONS_KEY: &str = "Software\\RegisteredApplications";
const REGISTERED_APPLICATION_NAME: &str = "Kinuza";
const PREVIOUS_MAGNET_COMMAND: &str = "MagnetCommand";
const PREVIOUS_TORRENT_PROG_ID: &str = "TorrentProgId";

/// Where Windows keeps a handler the user picked by hand; it wins over anything an app registers.
const MAGNET_USER_CHOICE_KEY: &str =
    "Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\magnet\\UserChoice";
const TORRENT_USER_CHOICE_KEY: &str =
    "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.torrent\\UserChoice";
const USER_CHOICE_PROG_ID: &str = "ProgId";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssociationStatus {
    /// Kinuza is registered as the handler.
    pub enabled: bool,
    /// The user chose another program in Windows settings, so Windows ignores the registration.
    pub overridden_by_windows: bool,
}

pub fn status() -> AssociationStatus {
    let root = RegKey::predef(HKEY_CURRENT_USER);
    let command = open_command().unwrap_or_default();

    let magnet_is_ours = read_default(&root, &class_path(&[MAGNET_CLASS, OPEN_COMMAND_KEY]))
        .is_some_and(|value| value.eq_ignore_ascii_case(&command));
    let torrent_is_ours =
        read_default(&root, &class_path(&[TORRENT_EXTENSION])).is_some_and(|value| value == TORRENT_PROG_ID);

    let overridden = |key: &str, ours: &str| {
        read_value(&root, key, USER_CHOICE_PROG_ID).is_some_and(|chosen| chosen != ours)
    };

    AssociationStatus {
        enabled: magnet_is_ours && torrent_is_ours,
        overridden_by_windows: overridden(MAGNET_USER_CHOICE_KEY, MAGNET_PROG_ID)
            || overridden(TORRENT_USER_CHOICE_KEY, TORRENT_PROG_ID),
    }
}

pub fn enable() -> Result<()> {
    let root = RegKey::predef(HKEY_CURRENT_USER);
    let command = open_command()?;
    let icon = format!("{},0", current_exe()?);

    remember_previous_handlers(&root, &command)?;

    write_prog_id(&root, MAGNET_PROG_ID, "URL:Magnet link", true, &command, &icon)?;
    write_prog_id(&root, TORRENT_PROG_ID, "Torrent file", false, &command, &icon)?;

    // The `magnet` class itself is what browsers look up.
    write_prog_id(&root, MAGNET_CLASS, "URL:Magnet link", true, &command, &icon)?;

    let (extension, _) = root.create_subkey(class_path(&[TORRENT_EXTENSION]))?;
    extension.set_value("", &TORRENT_PROG_ID)?;
    let (open_with, _) = extension.create_subkey(OPEN_WITH_KEY)?;
    open_with.set_value(TORRENT_PROG_ID, &"")?;

    // Lets the user pick Kinuza in Windows "Default apps".
    let (capabilities, _) = root.create_subkey(CAPABILITIES_KEY)?;
    capabilities.set_value("ApplicationName", &"Kinuza")?;
    capabilities.set_value("ApplicationDescription", &"Kinuza media library and player")?;
    let (urls, _) = capabilities.create_subkey("URLAssociations")?;
    urls.set_value(MAGNET_CLASS, &MAGNET_PROG_ID)?;
    let (files, _) = capabilities.create_subkey("FileAssociations")?;
    files.set_value(TORRENT_EXTENSION, &TORRENT_PROG_ID)?;
    let (registered, _) = root.create_subkey(REGISTERED_APPLICATIONS_KEY)?;
    registered.set_value(REGISTERED_APPLICATION_NAME, &CAPABILITIES_KEY)?;

    Ok(())
}

pub fn disable() -> Result<()> {
    let root = RegKey::predef(HKEY_CURRENT_USER);
    let command = open_command()?;
    let classes = root
        .open_subkey_with_flags(CLASSES_KEY, winreg::enums::KEY_ALL_ACCESS)
        .context("cannot open the classes key")?;

    let magnet_command_path = class_path(&[MAGNET_CLASS, OPEN_COMMAND_KEY]);
    let magnet_is_ours =
        read_default(&root, &magnet_command_path).is_some_and(|value| value.eq_ignore_ascii_case(&command));
    if magnet_is_ours {
        match read_value(&root, PREVIOUS_HANDLERS_KEY, PREVIOUS_MAGNET_COMMAND) {
            Some(previous) => {
                let (key, _) = root.create_subkey(&magnet_command_path)?;
                key.set_value("", &previous)?;
            }
            None => {
                let _ = classes.delete_subkey_all(MAGNET_CLASS);
            }
        }
    }

    if let Ok(extension) = classes.open_subkey_with_flags(TORRENT_EXTENSION, winreg::enums::KEY_ALL_ACCESS) {
        let torrent_is_ours = extension
            .get_value::<String, _>("")
            .is_ok_and(|value| value == TORRENT_PROG_ID);
        if torrent_is_ours {
            match read_value(&root, PREVIOUS_HANDLERS_KEY, PREVIOUS_TORRENT_PROG_ID) {
                Some(previous) => extension.set_value("", &previous)?,
                None => {
                    let _ = extension.delete_value("");
                }
            }
        }
        if let Ok(open_with) = extension.open_subkey_with_flags(OPEN_WITH_KEY, winreg::enums::KEY_ALL_ACCESS) {
            let _ = open_with.delete_value(TORRENT_PROG_ID);
        }
    }

    let _ = classes.delete_subkey_all(MAGNET_PROG_ID);
    let _ = classes.delete_subkey_all(TORRENT_PROG_ID);
    if let Ok(registered) = root.open_subkey_with_flags(REGISTERED_APPLICATIONS_KEY, winreg::enums::KEY_ALL_ACCESS) {
        let _ = registered.delete_value(REGISTERED_APPLICATION_NAME);
    }
    let _ = root.delete_subkey_all(CAPABILITIES_KEY);
    let _ = root.delete_subkey_all(PREVIOUS_HANDLERS_KEY);
    Ok(())
}

/// Saves whatever handled magnets and torrents before Kinuza, once, so `disable` can restore it.
fn remember_previous_handlers(root: &RegKey, command: &str) -> Result<()> {
    let (previous, _) = root.create_subkey(PREVIOUS_HANDLERS_KEY)?;

    let magnet_command = read_default(root, &class_path(&[MAGNET_CLASS, OPEN_COMMAND_KEY]));
    if let Some(existing) = magnet_command.filter(|value| !value.eq_ignore_ascii_case(command)) {
        if previous.get_value::<String, _>(PREVIOUS_MAGNET_COMMAND).is_err() {
            previous.set_value(PREVIOUS_MAGNET_COMMAND, &existing)?;
        }
    }

    let torrent_prog_id = read_default(root, &class_path(&[TORRENT_EXTENSION]));
    if let Some(existing) = torrent_prog_id.filter(|value| value != TORRENT_PROG_ID && !value.is_empty()) {
        if previous.get_value::<String, _>(PREVIOUS_TORRENT_PROG_ID).is_err() {
            previous.set_value(PREVIOUS_TORRENT_PROG_ID, &existing)?;
        }
    }
    Ok(())
}

fn write_prog_id(
    root: &RegKey,
    class: &str,
    description: &str,
    is_url_protocol: bool,
    command: &str,
    icon: &str,
) -> Result<()> {
    let (key, _) = root.create_subkey(class_path(&[class]))?;
    key.set_value("", &description)?;
    if is_url_protocol {
        key.set_value("URL Protocol", &"")?;
    }
    let (icon_key, _) = key.create_subkey("DefaultIcon")?;
    icon_key.set_value("", &icon)?;
    let (command_key, _) = key.create_subkey(OPEN_COMMAND_KEY)?;
    command_key.set_value("", &command)?;
    Ok(())
}

fn class_path(parts: &[&str]) -> String {
    let mut path = CLASSES_KEY.to_owned();
    for part in parts {
        path.push('\\');
        path.push_str(part);
    }
    path
}

fn current_exe() -> Result<String> {
    Ok(std::env::current_exe()
        .context("cannot locate the executable")?
        .to_string_lossy()
        .into_owned())
}

/// The command Windows runs: the link or file path arrives as the first argument.
fn open_command() -> Result<String> {
    Ok(format!("\"{}\" \"%1\"", current_exe()?))
}

fn read_default(root: &RegKey, key: &str) -> Option<String> {
    read_value(root, key, "")
}

fn read_value(root: &RegKey, key: &str, name: &str) -> Option<String> {
    root.open_subkey(key).ok()?.get_value::<String, _>(name).ok()
}
