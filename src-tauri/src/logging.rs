//! The app's log: what the torrent engine, the trackers, the server and the window ran into, in
//! `%APPDATA%\com.lembegor.kinuza\logs`. One file per start; the last few starts are kept, and a
//! file stops growing at a size limit so that a long session cannot fill the disk.

use std::{
    fs::File,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

/// `kinuza.log` is this start, `kinuza.1.log` the one before, and so on.
const KEPT_STARTS: usize = 5;
const FILE_LIMIT_BYTES: u64 = 20 * 1024 * 1024;
/// The app at "info"; the torrent library at "info", its trackers at "debug" (one line per
/// announce, with the error when one fails); everything else only when something is wrong.
const DEFAULT_FILTER: &str = "warn,kinuza_lib=info,librqbit=info,librqbit_tracker_comms=debug";

pub fn folder(data_dir: &Path) -> PathBuf {
    data_dir.join("logs")
}

fn file_name(index: usize) -> String {
    if index == 0 { "kinuza.log".to_owned() } else { format!("kinuza.{index}.log") }
}

/// A file that stops growing at its limit and says so once.
struct CappedFile {
    file: File,
    written: u64,
    full: bool,
}

impl Write for CappedFile {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if self.full {
            return Ok(buf.len());
        }
        if self.written + buf.len() as u64 > FILE_LIMIT_BYTES {
            self.full = true;
            let _ = self.file.write_all(b"... the log reached its size limit; nothing more is written until the next start\n");
            return Ok(buf.len());
        }
        let line = redact(buf);
        self.written += line.len() as u64;
        self.file.write_all(&line)?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }
}

/// Personal tracker keys (`pk=…` in a RuTracker announce address) never reach the file: the log
/// is meant to be read and sent, the key is the user's own.
fn redact(line: &[u8]) -> std::borrow::Cow<'_, [u8]> {
    const KEY: &[u8] = b"pk=";
    if !line.windows(KEY.len()).any(|window| window == KEY) {
        return std::borrow::Cow::Borrowed(line);
    }
    let mut out = Vec::with_capacity(line.len());
    let mut index = 0;
    while index < line.len() {
        if line[index..].starts_with(KEY) {
            out.extend_from_slice(b"pk=...");
            index += KEY.len();
            while index < line.len() && line[index].is_ascii_alphanumeric() {
                index += 1;
            }
        } else {
            out.push(line[index]);
            index += 1;
        }
    }
    std::borrow::Cow::Owned(out)
}

/// Starts the log for this run. `KINUZA_LOG` (an `EnvFilter` such as
/// `info,librqbit::torrent_state::live=debug`) asks for more detail.
pub fn start(data_dir: &Path) {
    let folder = folder(data_dir);
    if std::fs::create_dir_all(&folder).is_err() {
        return;
    }
    // The oldest goes, the others move up one.
    let _ = std::fs::remove_file(folder.join(file_name(KEPT_STARTS - 1)));
    for index in (0..KEPT_STARTS - 1).rev() {
        let _ = std::fs::rename(folder.join(file_name(index)), folder.join(file_name(index + 1)));
    }
    let Ok(file) = File::create(folder.join(file_name(0))) else {
        return;
    };

    let filter = std::env::var("KINUZA_LOG")
        .ok()
        .and_then(|custom| tracing_subscriber::EnvFilter::try_new(custom).ok())
        .unwrap_or_else(|| tracing_subscriber::EnvFilter::new(DEFAULT_FILTER));
    let installed = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_ansi(false)
        .with_writer(Mutex::new(CappedFile { file, written: 0, full: false }))
        .try_init()
        .is_ok();
    if !installed {
        return;
    }

    // A crash leaves its reason in the log rather than nowhere.
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        tracing::error!("crash: {info}");
        previous(info);
    }));
    tracing::info!("Kinuza {} started", env!("CARGO_PKG_VERSION"));
}

/// A line from the window: problems the interface reports (see the journal there).
#[tauri::command]
pub fn log_write(level: String, message: String) {
    let message: String = message.chars().take(2000).collect();
    match level.as_str() {
        "error" => tracing::error!(target: "kinuza_lib::ui", "{message}"),
        "warn" => tracing::warn!(target: "kinuza_lib::ui", "{message}"),
        _ => tracing::info!(target: "kinuza_lib::ui", "{message}"),
    }
}

/// Opens the folder with the logs in Explorer.
#[tauri::command]
pub fn logs_open(state: tauri::State<'_, crate::AppState>) -> Result<(), String> {
    let folder = folder(&state.data_dir);
    std::fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    std::process::Command::new("explorer").arg(&folder).spawn().map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn personal_tracker_keys_are_hidden() {
        let line = b"tracker=http://bt.t-ru.org/ann?pk=0123abcdEF&x=1 sleeping";
        assert_eq!(&*super::redact(line), b"tracker=http://bt.t-ru.org/ann?pk=...&x=1 sleeping".as_slice());
        assert_eq!(&*super::redact(b"no key here"), b"no key here".as_slice());
    }
}
