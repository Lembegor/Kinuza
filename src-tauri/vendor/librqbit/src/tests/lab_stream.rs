use std::{
    net::{Ipv4Addr, SocketAddr},
    num::NonZeroU32,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::{
    AddTorrent, AddTorrentOptions, CreateTorrentOptions, Session, SessionOptions, create_torrent,
    limits::LimitsConfig, spawn_utils::BlockingSpawner,
    tests::test_util::create_new_file_with_random_content,
};

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
#[ignore]
async fn lab_stream_order() -> anyhow::Result<()> {
    crate::tests::test_util::setup_test_logging();
    let size = env_u64("LAB_SIZE_MB", 600) << 20;
    let piece = (env_u64("LAB_PIECE_KB", 4096) << 10) as u32;
    let rate = env_u64("LAB_RATE_KB", 1000) << 10;
    let drop_at = env_u64("LAB_DROP_AT", 0);
    let speeds: Vec<u64> = std::env::var("LAB_PEERS")
        .unwrap_or_else(|_| "1500,600,300,200,150,100".into())
        .split(',')
        .filter_map(|v| v.trim().parse().ok())
        .collect();

    let data = TempDir::with_prefix("kinuza_lab_data")?;
    create_new_file_with_random_content(&data.path().join("movie.mkv"), size as usize);
    let torrent = create_torrent(
        &data.path().join("movie.mkv"),
        CreateTorrentOptions { name: None, piece_length: Some(piece), ..Default::default() },
        &BlockingSpawner::new(4),
    )
    .await?;
    let bytes = torrent.as_bytes()?;

    let mut seeds = Vec::new();
    let mut seed_handles = Vec::new();
    let mut addrs: Vec<SocketAddr> = Vec::new();
    for (index, speed) in speeds.iter().enumerate() {
        let port = 17100 + index as u16;
        let session = Session::new_with_opts(
            data.path().into(),
            SessionOptions {
                dht: None,
                persistence: None,
                disable_local_service_discovery: true,
                listen: Some(crate::listen::ListenerOptions {
                    listen_addr: (Ipv4Addr::LOCALHOST, port).into(),
                    enable_upnp_port_forwarding: false,
                    ..Default::default()
                }),
                ratelimits: LimitsConfig { upload_bps: NonZeroU32::new((*speed << 10) as u32), download_bps: None },
                ..Default::default()
            },
        )
        .await?;
        let handle = session
            .add_torrent(
                AddTorrent::from_bytes(bytes.clone()),
                Some(AddTorrentOptions {
                    paused: false,
                    output_folder: Some(data.path().to_str().unwrap().to_owned()),
                    overwrite: true,
                    ..Default::default()
                }),
            )
            .await?
            .into_handle()
            .unwrap();
        handle.wait_until_completed().await?;
        seed_handles.push(handle.clone());
        addrs.push((Ipv4Addr::LOCALHOST, port).into());
        seeds.push(session);
    }
    println!("lab: {} seeds ready, {} MB, piece {} KB, video {} KB/s", seeds.len(), size >> 20, piece >> 10, rate >> 10);

    let client_dir = TempDir::with_prefix("kinuza_lab_client")?;
    let client = Session::new_with_opts(
        client_dir.path().into(),
        SessionOptions {
            dht: None,
            persistence: None,
            disable_local_service_discovery: true,
            listen: None,
            connect: Some(crate::ConnectionOptions {
                peer_opts: Some(crate::PeerConnectionOptions {
                    max_request_window: Some(32),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        },
    )
    .await?;
    let handle = client
        .add_torrent(
            AddTorrent::from_bytes(bytes.clone()),
            Some(AddTorrentOptions { paused: false, initial_peers: Some(addrs.clone()), ..Default::default() }),
        )
        .await?
        .into_handle()
        .unwrap();
    handle.wait_until_initialized().await?;
    let silent = env_u64("LAB_SILENT", 0) as usize;
    if silent > 0 {
        let at = env_u64("LAB_SILENT_MS", 800);
        let quiet: Vec<_> = seed_handles.iter().take(silent).cloned().collect();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(at)).await;
            for seed in &quiet {
                seed.set_upload_enabled(false);
            }
            println!("lab: {} seeds went silent", quiet.len());
        });
    }
    let drop = (drop_at > 0).then(|| (drop_at, seeds.remove(0)));
    play(handle, size, piece, drop).await
}

async fn play(
    handle: crate::torrent_state::ManagedTorrentHandle,
    size: u64,
    piece: u32,
    drop: Option<(u64, Arc<Session>)>,
) -> anyhow::Result<()> {
    let rate = env_u64("LAB_RATE_KB", 1000) << 10;
    let start_pct = env_u64("LAB_START_PCT", 0);
    let seconds = env_u64("LAB_SECONDS", 120);
    let buffer_mb = env_u64("LAB_BUFFER_MB", 0);
    let cache_secs = env_u64("LAB_CACHE_SECS", 300);
    if buffer_mb > 0 {
        handle.set_stream_buffer(buffer_mb << 20)?;
    }
    let live = handle.live().unwrap();

    let begin = Instant::now();
    let start_offset = size * start_pct / 100;
    let front = Arc::new(AtomicU64::new(start_offset));
    let head = Arc::new(AtomicU64::new(start_offset));
    let done = Arc::new(AtomicBool::new(false));
    let cache_limit = (rate * cache_secs).min(1500 << 20);

    let mut idle = handle.clone().stream(0).await?;
    idle.seek(std::io::SeekFrom::End(0)).await?;
    let tails = env_u64("LAB_TAILS", 0);
    let tail_bytes = env_u64("LAB_TAIL_KB", 1024) << 10;
    for index in 0..tails {
        let handle = handle.clone();
        tokio::spawn(async move {
            let started = Instant::now();
            let mut stream = handle.stream(0).await.unwrap();
            stream.seek(std::io::SeekFrom::Start(size - tail_bytes)).await.unwrap();
            let mut buf = vec![0u8; 64 * 1024];
            let mut got = 0u64;
            while got < tail_bytes {
                match stream.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => got += n as u64,
                    Err(e) => panic!("tail read error {e}"),
                }
            }
            println!("lab: tail reader {index} got {got} bytes in {:.1}s", started.elapsed().as_secs_f64());
        });
    }
    if env_u64("LAB_WINDOW", 0) == 1 {
        let session = handle.shared.session.upgrade().unwrap();
        session.update_only_files(&handle, &Default::default()).await?;
    }

    let reader = {
        let (front, head, done, handle) = (front.clone(), head.clone(), done.clone(), handle.clone());
        tokio::spawn(async move {
            let mut stream = handle.stream(0).await.unwrap();
            stream.seek(std::io::SeekFrom::Start(start_offset)).await.unwrap();
            let mut buf = vec![0u8; 256 * 1024];
            while !done.load(Ordering::Relaxed) {
                if front.load(Ordering::Relaxed) - head.load(Ordering::Relaxed) >= cache_limit {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                }
                match tokio::time::timeout(Duration::from_millis(500), stream.read(&mut buf)).await {
                    Ok(Ok(0)) => break,
                    Ok(Ok(n)) => {
                        front.fetch_add(n as u64, Ordering::Relaxed);
                    }
                    Ok(Err(e)) => panic!("read error {e}"),
                    Err(_) => {}
                }
            }
        })
    };

    let pieces_total = size.div_ceil(piece as u64) as usize;
    let mut previous = live.lab_piece_states();
    let mut started_at: Option<f64> = None;
    let mut stalled = false;
    let mut stalls = 0u32;
    let mut stall_time = 0.0f64;
    let mut stall_began = 0.0f64;
    let mut buckets = [0u32; 6];
    let mut farthest_ahead = 0i64;
    let mut far_bytes = 0u64;
    let mut behind_bytes = 0u64;
    let mut tick = 0u64;
    let mut last_log = 0.0f64;
    let tick_ms = 100u64;
    let ready_bytes = rate * 2;
    let wait_steps = [2u64, 4, 7, 10];
    let mut dropped = false;
    let mut buffered_samples: Vec<f64> = Vec::new();

    while begin.elapsed().as_secs() < seconds {
        tokio::time::sleep(Duration::from_millis(tick_ms)).await;
        tick += 1;
        let now = begin.elapsed().as_secs_f64();
        if let Some((at, session)) = drop.as_ref()
            && !dropped
            && now >= *at as f64
        {
            dropped = true;
            session.stop().await;
            println!("lab: {:6.1}s dropped the fastest seed", now);
        }
        let f = front.load(Ordering::Relaxed);
        let mut h = head.load(Ordering::Relaxed);
        let ahead = f.saturating_sub(h);
        match started_at {
            None if ahead >= ready_bytes || f == size => {
                started_at = Some(now);
                println!("lab: {:6.1}s playback starts", now);
            }
            None => {}
            Some(_) => {
                if stalled {
                    if ahead >= rate * wait_steps[(stalls as usize).min(wait_steps.len() - 1)] || f == size {
                        stalled = false;
                        stall_time += now - stall_began;
                    }
                } else {
                    let step = rate * tick_ms / 1000;
                    if ahead >= step {
                        h += step;
                        head.store(h, Ordering::Relaxed);
                    } else {
                        stalled = true;
                        stalls += 1;
                        stall_began = now;
                        println!("lab: {:6.1}s STALL at {:.1}s of video", now, h as f64 / rate as f64);
                    }
                }
            }
        }

        let states = live.lab_piece_states();
        let front_piece = (f / piece as u64) as i64;
        let head_piece = (h / piece as u64) as i64;
        for (index, (old, new)) in previous.iter().zip(states.iter()).enumerate() {
            if *old != 2 && *new == 2 {
                let distance = index as i64 - front_piece;
                let bucket = match distance {
                    d if d < 0 => 0,
                    0..=1 => 1,
                    2..=7 => 2,
                    8..=31 => 3,
                    32..=127 => 4,
                    _ => 5,
                };
                buckets[bucket] += 1;
                farthest_ahead = farthest_ahead.max(distance);
                if (index as i64) < head_piece {
                    behind_bytes += piece as u64;
                }
                if distance > 32 {
                    far_bytes += piece as u64;
                }
            }
        }
        previous = states.clone();

        if started_at.is_some() {
            buffered_samples.push(ahead as f64 / rate as f64);
        }
        if now - last_log >= 2.0 {
            last_log = now;
            let from = (front_piece - 2).max(0) as usize;
            let map: String = (from..(from + 60).min(pieces_total))
                .map(|i| match (states[i], i as i64 == front_piece) {
                    (_, true) => '|',
                    (2, _) => '#',
                    (1, _) => '>',
                    _ => '.',
                })
                .collect();
            let inflight: Vec<i64> = states
                .iter()
                .enumerate()
                .filter(|(_, s)| **s == 1)
                .map(|(i, _)| i as i64 - front_piece)
                .collect();
            let speed = handle.stats().live.map(|l| l.download_speed.mbps).unwrap_or(0.0);
            println!(
                "lab: {:6.1}s video {:6.1}s cache {:5.1}s speed {:5.2} MiB/s {} inflight@{:?}",
                now,
                h as f64 / rate as f64,
                ahead as f64 / rate as f64,
                speed,
                map,
                inflight
            );
        }
        if f == size && h >= size {
            break;
        }
    }
    if stalled {
        stall_time += begin.elapsed().as_secs_f64() - stall_began;
    }
    done.store(true, Ordering::Relaxed);
    let _ = tokio::time::timeout(Duration::from_secs(2), reader).await;

    buffered_samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let pct = |p: f64| buffered_samples.get(((buffered_samples.len() as f64 - 1.0) * p) as usize).copied().unwrap_or(0.0);
    let snapshot = handle.stats().live.map(|l| l.snapshot);
    let (fetched, checked) = snapshot.map(|s| (s.fetched_bytes, s.downloaded_and_checked_bytes)).unwrap_or((0, 0));
    let partial = live.lab_partial_bytes();
    let _ = tick;
    println!(
        "lab RESULT start={:.1}s stalls={} stall_time={:.1}s cache_p10={:.1}s cache_p50={:.1}s done_by_distance[behind,0-1,2-7,8-31,32-127,128+]={:?} farthest={} far_MB={} behind_MB={} fetched_MB={} useful_MB={} waste_MB={}",
        started_at.unwrap_or(-1.0),
        stalls,
        stall_time,
        pct(0.1),
        pct(0.5),
        buckets,
        farthest_ahead,
        far_bytes >> 20,
        behind_bytes >> 20,
        fetched >> 20,
        checked >> 20,
        fetched.saturating_sub(checked + partial) >> 20
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
#[ignore]
async fn lab_stream_real() -> anyhow::Result<()> {
    crate::tests::test_util::setup_test_logging();
    let path = std::env::var("LAB_TORRENT").expect("LAB_TORRENT");
    let bytes = std::fs::read(&path)?;
    let dir = TempDir::with_prefix("kinuza_lab_real")?;
    let session = Session::new_with_opts(
        dir.path().into(),
        SessionOptions {
            persistence: None,
            listen: Some(crate::listen::ListenerOptions {
                mode: crate::ListenerMode::TcpAndUtp,
                listen_addr: (Ipv4Addr::UNSPECIFIED, 0).into(),
                enable_upnp_port_forwarding: false,
                ..Default::default()
            }),
            connect: Some(crate::ConnectionOptions {
                peer_opts: Some(crate::PeerConnectionOptions {
                    connect_timeout: Some(Duration::from_secs(6)),
                    read_write_timeout: Some(Duration::from_secs(60)),
                    max_request_window: Some(32),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            peer_limit: Some(200),
            ..Default::default()
        },
    )
    .await?;
    let handle = session
        .add_torrent(AddTorrent::from_bytes(bytes), Some(AddTorrentOptions { paused: false, ..Default::default() }))
        .await?
        .into_handle()
        .unwrap();
    handle.wait_until_initialized().await?;
    let (size, piece) = {
        let metadata = handle.metadata.load();
        let metadata = metadata.as_ref().unwrap();
        (metadata.file_infos[0].len, metadata.lengths().default_piece_length())
    };
    println!("lab: real torrent, {} MB, piece {} KB", size >> 20, piece >> 10);
    let result = play(handle, size, piece, None).await;
    session.stop().await;
    result
}
