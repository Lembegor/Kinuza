use std::{net::Ipv4Addr, time::Duration};

use anyhow::Context;
use tempfile::TempDir;
use tokio::time::timeout;
use tracing::info;

use crate::{
    AddTorrent, CreateTorrentOptions, Session, create_torrent,
    spawn_utils::BlockingSpawner,
    tests::test_util::{TestPeerMetadata, setup_test_logging},
};

use super::test_util::create_default_random_dir_with_torrents;

async fn e2e_upload_switch() -> anyhow::Result<()> {
    setup_test_logging();
    let files = create_default_random_dir_with_torrents(1, 8192, Some("test_e2e_upload_switch"));
    let torrent = create_torrent(
        files.path(),
        CreateTorrentOptions {
            name: None,
            piece_length: Some(1024),
            ..Default::default()
        },
        &BlockingSpawner::new(1),
    )
    .await?;

    let orig_content = std::fs::read(files.path().join("0.data")).unwrap();
    let server_session = Session::new_with_opts(
        files.path().into(),
        crate::SessionOptions {
            dht: None,
            peer_id: Some(TestPeerMetadata::good().as_peer_id()),
            persistence: None,
            listen: Some(crate::listen::ListenerOptions {
                listen_addr: (Ipv4Addr::LOCALHOST, 16011).into(),
                ..Default::default()
            }),
            ..Default::default()
        },
    )
    .await
    .context("error creating server session")?;

    info!("created server session");

    let server_handle = server_session
        .add_torrent(
            AddTorrent::from_bytes(torrent.as_bytes()?),
            Some(crate::AddTorrentOptions {
                paused: false,
                output_folder: Some(files.path().to_str().unwrap().to_owned()),
                overwrite: true,
                ..Default::default()
            }),
        )
        .await?
        .into_handle()
        .unwrap();
    server_handle.set_upload_enabled(false);
    timeout(Duration::from_secs(5), server_handle.wait_until_completed())
        .await?
        .context("error adding torrent")?;

    info!("server torrent was completed");

    let peer = server_session
        .listen_addr()
        .context("expected listen_addr to be set")?;

    let client_dir = TempDir::with_prefix("test_e2e_upload_switch_client")?;

    let client_session = Session::new_with_opts(
        client_dir.path().into(),
        crate::SessionOptions {
            dht: None,
            persistence: None,
            peer_id: Some(TestPeerMetadata::good().as_peer_id()),
            ..Default::default()
        },
    )
    .await?;

    info!("created client session");

    let client_handle = client_session
        .add_torrent(
            AddTorrent::from_bytes(torrent.as_bytes()?),
            Some(crate::AddTorrentOptions {
                paused: false,
                initial_peers: Some(vec![peer]),
                ..Default::default()
            }),
        )
        .await?
        .into_handle()
        .unwrap();

    client_handle.wait_until_initialized().await?;

    info!("client torrent initialized, starting stream");

    tokio::time::sleep(Duration::from_secs(4)).await;
    let blocked = client_handle.stats().progress_bytes;
    assert_eq!(blocked, 0, "the client got {blocked} bytes while upload was off");

    server_handle.set_upload_enabled(true);
    timeout(Duration::from_secs(15), client_handle.wait_until_completed())
        .await
        .context("the client did not finish after upload was turned back on")??;

    let got = std::fs::read(client_dir.path().join("0.data")).or_else(|_| {
        std::fs::read_dir(client_dir.path())?
            .flatten()
            .find_map(|entry| std::fs::read(entry.path().join("0.data")).ok())
            .ok_or_else(|| std::io::Error::other("downloaded file not found"))
    })?;
    if got != orig_content {
        panic!("contents differ")
    }

    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn test_e2e_upload_switch() -> anyhow::Result<()> {
    timeout(Duration::from_secs(30), e2e_upload_switch()).await?
}
