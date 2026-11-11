use std::{
    path::{Path, PathBuf},
    process::Stdio,
};

use anyhow::{Context, Result};

pub struct ExternalPlayer {
    pub name: &'static str,
    pub executable: PathBuf,
}

struct Candidate {
    name: &'static str,
    command: &'static str,
    install_paths: &'static [&'static str],
}

#[cfg(windows)]
const CANDIDATES: &[Candidate] = &[
    Candidate {
        name: "mpv",
        command: "mpv.exe",
        install_paths: &["mpv\\mpv.exe"],
    },
    Candidate {
        name: "VLC",
        command: "vlc.exe",
        install_paths: &["VideoLAN\\VLC\\vlc.exe"],
    },
    Candidate {
        name: "MPC-HC",
        command: "mpc-hc64.exe",
        install_paths: &["MPC-HC\\mpc-hc64.exe"],
    },
    Candidate {
        name: "MPC-BE",
        command: "mpc-be64.exe",
        install_paths: &["MPC-BE x64\\mpc-be64.exe", "MPC-BE\\mpc-be64.exe"],
    },
];

#[cfg(not(windows))]
const CANDIDATES: &[Candidate] = &[
    Candidate {
        name: "mpv",
        command: "mpv",
        install_paths: &["io.mpv.Mpv"],
    },
    Candidate {
        name: "VLC",
        command: "vlc",
        install_paths: &["org.videolan.VLC"],
    },
    Candidate {
        name: "Celluloid",
        command: "celluloid",
        install_paths: &["io.github.celluloid_player.Celluloid"],
    },
];

pub fn find() -> Option<ExternalPlayer> {
    CANDIDATES.iter().find_map(|candidate| {
        locate(candidate).map(|executable| ExternalPlayer {
            name: candidate.name,
            executable,
        })
    })
}

pub fn launch(player: &ExternalPlayer, target: &str) -> Result<()> {
    crate::host::command(&player.executable)
        .arg(target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .with_context(|| format!("failed to start {}", player.name))?;
    Ok(())
}

#[cfg(windows)]
fn install_roots() -> Vec<PathBuf> {
    ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
        .iter()
        .filter_map(|variable| std::env::var_os(variable))
        .map(PathBuf::from)
        .collect()
}

#[cfg(not(windows))]
fn install_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home).join(".local/share/flatpak/exports/bin"));
    }
    roots.push(PathBuf::from("/var/lib/flatpak/exports/bin"));
    roots
}

fn installed(candidate: &Candidate) -> Option<PathBuf> {
    install_roots()
        .into_iter()
        .flat_map(|root| candidate.install_paths.iter().map(move |relative| Path::new(&root).join(relative)))
        .find(|path| path.is_file())
}

fn locate(candidate: &Candidate) -> Option<PathBuf> {
    if cfg!(windows) {
        installed(candidate).or_else(|| crate::host::find_in_path(candidate.command))
    } else {
        crate::host::find_in_path(candidate.command).or_else(|| installed(candidate))
    }
}
