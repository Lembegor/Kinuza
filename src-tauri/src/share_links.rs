pub const SCHEME: &str = "kinuza";

#[cfg(windows)]
pub fn register() {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let Ok(exe) = std::env::current_exe() else { return };
    let exe = exe.to_string_lossy().into_owned();
    let command = format!("\"{exe}\" \"%1\"");
    let root = RegKey::predef(HKEY_CURRENT_USER);
    let base = format!("Software\\Classes\\{SCHEME}");
    let current: Option<String> = root.open_subkey(format!("{base}\\shell\\open\\command")).ok().and_then(|key| key.get_value("").ok());
    if current.as_deref() == Some(command.as_str()) {
        return;
    }
    let result = (|| -> std::io::Result<()> {
        let (key, _) = root.create_subkey(&base)?;
        key.set_value("", &"URL:Kinuza")?;
        key.set_value("URL Protocol", &"")?;
        let (icon, _) = key.create_subkey("DefaultIcon")?;
        icon.set_value("", &format!("\"{exe}\",0"))?;
        let (open, _) = key.create_subkey("shell\\open\\command")?;
        open.set_value("", &command)?;
        Ok(())
    })();
    match result {
        Ok(()) => tracing::info!("links: {SCHEME}:// opens this Kinuza"),
        Err(error) => tracing::warn!("links: could not register {SCHEME}://: {error}"),
    }
}

#[cfg(target_os = "linux")]
pub fn register() {
    const DESKTOP_FILE_NAME: &str = "kinuza-share.desktop";
    let kind = format!("x-scheme-handler/{SCHEME}");
    let Some(home) = std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".local/share")))
    else {
        return;
    };
    let program = std::env::var_os("APPIMAGE")
        .filter(|path| !path.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::current_exe().ok());
    let Some(program) = program else { return };
    let exec = crate::associations::exec_line(&program.to_string_lossy());
    let entry = format!("[Desktop Entry]\nType=Application\nName=Kinuza\n{exec}\nIcon=kinuza\nTerminal=false\nNoDisplay=true\nMimeType={kind};\n");
    let folder = home.join("applications");
    let path = folder.join(DESKTOP_FILE_NAME);
    if std::fs::read_to_string(&path).ok().as_deref() == Some(entry.as_str()) {
        return;
    }
    if std::fs::create_dir_all(&folder).and_then(|()| std::fs::write(&path, &entry)).is_err() {
        tracing::warn!("links: could not write {}", path.display());
        return;
    }
    let _ = crate::host::command("xdg-mime").args(["default", DESKTOP_FILE_NAME, &kind]).status();
    let _ = crate::host::command("update-desktop-database").arg(&folder).status();
    tracing::info!("links: {SCHEME}:// opens this Kinuza");
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn register() {}
