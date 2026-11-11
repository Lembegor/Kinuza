use std::{
    path::{Path, PathBuf},
    process::Command,
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

const PROGRAM_FILES_VARIABLES: &[&str] = &["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"];

pub fn find() -> Option<ExternalPlayer> {
    CANDIDATES.iter().find_map(|candidate| {
        locate(candidate).map(|executable| ExternalPlayer {
            name: candidate.name,
            executable,
        })
    })
}

pub fn launch(player: &ExternalPlayer, target: &str) -> Result<()> {
    Command::new(&player.executable)
        .arg(target)
        .spawn()
        .with_context(|| format!("failed to start {}", player.name))?;
    Ok(())
}

fn locate(candidate: &Candidate) -> Option<PathBuf> {
    let installed = PROGRAM_FILES_VARIABLES
        .iter()
        .filter_map(|variable| std::env::var_os(variable))
        .flat_map(|root| {
            candidate
                .install_paths
                .iter()
                .map(move |relative| Path::new(&root).join(relative))
        })
        .find(|path| path.is_file());

    installed.or_else(|| find_in_path(candidate.command))
}

fn find_in_path(command: &str) -> Option<PathBuf> {
    let path_variable = std::env::var_os("PATH")?;
    std::env::split_paths(&path_variable)
        .map(|directory| directory.join(command))
        .find(|path| path.is_file())
}
