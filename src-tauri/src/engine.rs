use std::{
    collections::{HashMap, HashSet},
    net::SocketAddr,
    path::{Path, PathBuf},
    str::FromStr,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, Context, Result};
use bytes::Bytes;
use librqbit::{
    api::TorrentIdOrHash, dht::Id20, AddTorrent, AddTorrentOptions, AddTorrentResponse,
    ListenerOptions, ManagedTorrent, Session, SessionOptions, SessionPersistenceConfig,
    TorrentStatsState,
};
use serde::{Deserialize, Serialize};

const METADATA_TIMEOUT: Duration = Duration::from_secs(90);
const BYTES_PER_MEBIBYTE: f64 = 1024.0 * 1024.0;

type TorrentHandle = Arc<ManagedTorrent>;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TorrentFileView {
    pub index: usize,
    pub path: String,
    pub length: u64,
    pub included: bool,
    pub downloaded: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TorrentPreview {
    pub info_hash: String,
    pub name: String,
    pub files: Vec<TorrentFileView>,
    pub already_added: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TorrentView {
    pub info_hash: String,
    pub name: String,
    pub output_folder: String,
    pub state: &'static str,
    pub error: Option<String>,
    pub progress_bytes: u64,
    pub total_bytes: u64,
    pub uploaded_bytes: u64,
    pub finished: bool,
    pub download_speed: f64,
    pub upload_speed: f64,
    pub peers: u64,
    pub files: Vec<TorrentFileView>,
}

#[derive(Serialize, Deserialize, Clone)]
struct ParkedTorrent {
    name: String,
    files: Vec<ParkedFile>,
    #[serde(default)]
    peers: Vec<SocketAddr>,
    #[serde(default)]
    trackers: Vec<String>,
}

const MAX_REMEMBERED_PEERS: usize = 200;

#[derive(Serialize, Deserialize, Clone)]
struct ParkedFile {
    path: String,
    length: u64,
}

const PARKED_INDEX_NAME: &str = "parked.json";
const CACHE_INDEX_NAME: &str = "cache.json";
const QUEUE_INDEX_NAME: &str = "queue.json";
const ORDER_INDEX_NAME: &str = "order.json";
const POLICY_FILE_NAME: &str = "policy.json";
const PROMOTED_INDEX_NAME: &str = "promoted.json";
const NETWORK_FILE_NAME: &str = "network.json";
const LISTEN_PORT_FIRST: u16 = 20000;
const LISTEN_PORT_SPAN: u16 = 40000;
const LISTEN_PORT_ATTEMPTS: usize = 8;
const PEER_LIMIT: usize = 200;
const PEER_CONNECT_TIMEOUT: Duration = Duration::from_secs(6);
const PEER_REQUEST_WINDOW: usize = 32;
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
const ONLINE_LINGER: Duration = Duration::from_secs(5 * 60);
const CACHE_MAX_AGE: Duration = Duration::from_secs(14 * 24 * 60 * 60);
const CACHE_CHECK_EVERY: u32 = 6;
const BYTES_PER_GIBIBYTE: f64 = 1024.0 * 1024.0 * 1024.0;
const SWARM_LOG_EVERY: u32 = 2;
const CACHE_DATA_FOLDER_NAME: &str = "data";
const STATE_PARKED: &str = "parked";
const STATE_QUEUED: &str = "queued";
const STARTUP_CLEANUP_DELAY: Duration = Duration::from_secs(8);

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Promotion {
    files: Vec<usize>,
    download_dir: PathBuf,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct NetworkSettings {
    listen_port: u16,
}

#[derive(Serialize, Deserialize, Clone, Copy, Default)]
#[serde(rename_all = "camelCase")]
pub struct DownloadPolicy {
    pub download_limit: u32,
    pub upload_limit: u32,
    pub max_active_downloads: usize,
    pub seed_ratio: f32,
    #[serde(default)]
    pub cache_limit_gb: f32,
}

const POLICY_CHECK_INTERVAL: Duration = Duration::from_secs(5);
const STREAM_READY_TIMEOUT: Duration = Duration::from_secs(60);

struct Watch {
    file: usize,
    _keepalive: Box<dyn std::any::Any + Send>,
}

const ANNOUNCE_SELECTION: Duration = Duration::from_secs(10);
const RELEASE_GRACE: Duration = Duration::from_secs(5);
const TOUCH_EVERY_MILLIS: u64 = 60_000;

#[derive(Default)]
struct Usage {
    holders: usize,
    streams: usize,
    active: Option<Instant>,
    released: Option<Instant>,
}

impl Usage {
    fn playing(&self) -> bool {
        self.holders > 0
            || self.streams > 0
            || self.active.is_some_and(|active| {
                active.elapsed() < ONLINE_LINGER && self.released.map_or(true, |released| released < active)
            })
    }

    fn in_use(&self) -> bool {
        self.playing() || self.released.is_some_and(|released| released.elapsed() < ONLINE_LINGER)
    }

    fn just_released(&self) -> bool {
        self.holders == 0 && self.released.is_some_and(|released| released.elapsed() < RELEASE_GRACE)
    }
}
const FREE_SPACE_RESERVE: u64 = 2 * 1024 * 1024 * 1024;

const EXTRA_TRACKERS: &[&str] = &[
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://exodus.desync.com:6969/announce",
];

const PEER_SILENCE_TIMEOUT: Duration = Duration::from_secs(60);
const PEER_KEEP_ALIVE: Duration = Duration::from_secs(30);

struct PendingTorrent {
    torrent_bytes: Bytes,
    seen_peers: Vec<SocketAddr>,
    name: String,
    file_count: usize,
    trackers: Vec<String>,
}

pub struct Engine {
    session: Arc<Session>,
    pending: Mutex<HashMap<String, PendingTorrent>>,
    cache_dir: PathBuf,
    parked: Mutex<HashMap<String, ParkedTorrent>>,
    usage: Mutex<HashMap<String, Usage>>,
    parking: tokio::sync::Mutex<()>,
    policy: Mutex<DownloadPolicy>,
    queued: Mutex<HashSet<String>>,
    seeding_stopped: Mutex<HashSet<String>>,
    last_played: Mutex<HashMap<String, u64>>,
    policy_known: std::sync::atomic::AtomicBool,
    watching: Mutex<HashMap<String, Watch>>,
    announced: Mutex<HashSet<String>>,
    order: Mutex<HashMap<String, u64>>,
    promoted: Mutex<HashMap<String, Promotion>>,
    migrating: tokio::sync::Mutex<()>,
    session_reset: bool,
    listen_port: u16,
}

fn read_json<T: serde::de::DeserializeOwned + Default>(path: &Path) -> T {
    std::fs::read_to_string(path).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
}

fn write_json<T: Serialize>(path: &Path, value: &T) {
    match serde_json::to_vec(value) {
        Ok(bytes) => {
            if let Err(error) = crate::store::write_atomic(path, &bytes) {
                tracing::warn!("engine: could not save {}: {error}", path.display());
            }
        }
        Err(error) => tracing::warn!("engine: could not encode {}: {error}", path.display()),
    }
}

fn port_is_free(port: u16) -> bool {
    let tcp = std::net::TcpListener::bind(("0.0.0.0", port)).is_ok();
    let udp = std::net::UdpSocket::bind(("0.0.0.0", port)).is_ok();
    tcp && udp
}

fn random_port() -> u16 {
    LISTEN_PORT_FIRST + (crate::store::random_u64() % u64::from(LISTEN_PORT_SPAN)) as u16
}

fn choose_listen_port(cache_dir: &Path) -> u16 {
    let path = cache_dir.join(NETWORK_FILE_NAME);
    let saved: NetworkSettings = read_json(&path);
    if saved.listen_port != 0 && port_is_free(saved.listen_port) {
        return saved.listen_port;
    }
    let chosen = (0..LISTEN_PORT_ATTEMPTS).map(|_| random_port()).find(|port| port_is_free(*port)).unwrap_or(0);
    if chosen != 0 {
        if saved.listen_port != 0 {
            tracing::warn!("session: port {} is taken, moving to {chosen}", saved.listen_port);
        }
        write_json(&path, &NetworkSettings { listen_port: chosen });
    }
    chosen
}

fn classify_torrent_error(message: &str) -> String {
    let lower = message.to_ascii_lowercase();
    let disk_full = lower.contains("no space left")
        || lower.contains("os error 112")
        || lower.contains("os error 28")
        || lower.contains("not enough space")
        || lower.contains("disk full");
    if disk_full {
        "disk_full".to_owned()
    } else {
        message.to_owned()
    }
}

fn set_aside(folder: &Path) -> Result<PathBuf> {
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_secs()).unwrap_or(0);
    let name = folder.file_name().and_then(|name| name.to_str()).unwrap_or("session");
    let aside = folder.with_file_name(format!("{name}-damaged-{stamp}"));
    std::fs::rename(folder, &aside).with_context(|| format!("could not move {} aside", folder.display()))?;
    std::fs::create_dir_all(folder)?;
    Ok(aside)
}

impl Engine {
    pub async fn start(default_output: PathBuf, persistence_dir: PathBuf, cache_dir: PathBuf) -> Result<Arc<Self>> {
        std::fs::create_dir_all(&default_output).ok();
        std::fs::create_dir_all(&persistence_dir).ok();
        std::fs::create_dir_all(&cache_dir).ok();

        let listen_port = choose_listen_port(&cache_dir);
        let (session, session_reset) = match Self::open_session(&default_output, &persistence_dir, listen_port).await {
            Ok(session) => (session, false),
            Err(error) => {
                tracing::error!("session: could not start with the saved torrents: {error:#}");
                let aside = set_aside(&persistence_dir)?;
                match Self::open_session(&default_output, &persistence_dir, listen_port).await {
                    Ok(session) => {
                        tracing::warn!("session: started fresh, the saved torrents were moved to {}", aside.display());
                        (session, true)
                    }
                    Err(second) => {
                        tracing::error!("session: could not start even without the saved torrents: {second:#}");
                        let _ = std::fs::remove_dir_all(&persistence_dir);
                        let _ = std::fs::rename(&aside, &persistence_dir);
                        return Err(error);
                    }
                }
            }
        };
        tracing::info!("session listening on {:?}, announcing port {:?}", session.listen_addr(), session.announce_port());
        let listen_port = session.announce_port().unwrap_or(listen_port);
        Self::assemble(session, session_reset, cache_dir, listen_port)
    }

    async fn open_session(default_output: &Path, persistence_dir: &Path, listen_port: u16) -> Result<Arc<Session>> {
        let options = SessionOptions {
            fastresume: true,
            trackers: EXTRA_TRACKERS.iter().filter_map(|tracker| reqwest::Url::parse(tracker).ok()).collect(),
            persistence: Some(SessionPersistenceConfig::Json {
                folder: Some(persistence_dir.to_path_buf()),
            }),
            listen: Some(ListenerOptions {
                mode: librqbit::ListenerMode::TcpAndUtp,
                listen_addr: (std::net::Ipv6Addr::UNSPECIFIED, listen_port).into(),
                enable_upnp_port_forwarding: true,
                ..Default::default()
            }),
            connect: Some(librqbit::ConnectionOptions {
                peer_opts: Some(librqbit::PeerConnectionOptions {
                    connect_timeout: Some(PEER_CONNECT_TIMEOUT),
                    read_write_timeout: Some(PEER_SILENCE_TIMEOUT),
                    keep_alive_interval: Some(PEER_KEEP_ALIVE),
                    max_request_window: Some(PEER_REQUEST_WINDOW),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            peer_limit: Some(PEER_LIMIT),
            ..Default::default()
        };
        Session::new_with_opts(default_output.to_path_buf(), options)
            .await
            .context("failed to start the torrent session")
    }

    fn assemble(session: Arc<Session>, session_reset: bool, cache_dir: PathBuf, listen_port: u16) -> Result<Arc<Self>> {
        let parked = read_json(&cache_dir.join(PARKED_INDEX_NAME));
        let last_played = read_json(&cache_dir.join(CACHE_INDEX_NAME));
        let queued: Vec<String> = read_json(&cache_dir.join(QUEUE_INDEX_NAME));
        let order = read_json(&cache_dir.join(ORDER_INDEX_NAME));
        let promoted = read_json(&cache_dir.join(PROMOTED_INDEX_NAME));
        let saved_policy: Option<DownloadPolicy> = std::fs::read_to_string(cache_dir.join(POLICY_FILE_NAME))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok());
        let engine = Arc::new(Self {
            session,
            pending: Mutex::new(HashMap::new()),
            cache_dir,
            parked: Mutex::new(parked),
            usage: Mutex::new(HashMap::new()),
            parking: tokio::sync::Mutex::new(()),
            policy: Mutex::new(DownloadPolicy::default()),
            queued: Mutex::new(queued.into_iter().collect()),
            seeding_stopped: Mutex::new(HashSet::new()),
            last_played: Mutex::new(last_played),
            policy_known: std::sync::atomic::AtomicBool::new(false),
            watching: Mutex::new(HashMap::new()),
            announced: Mutex::new(HashSet::new()),
            order: Mutex::new(order),
            promoted: Mutex::new(promoted),
            migrating: tokio::sync::Mutex::new(()),
            session_reset,
            listen_port,
        });
        if let Some(policy) = saved_policy {
            engine.apply_policy(policy);
        }

        let keeper = engine.clone();
        tokio::spawn(async move {
            let mut tick: u32 = 0;
            loop {
                tokio::time::sleep(POLICY_CHECK_INTERVAL).await;
                keeper.enforce_policy().await;
                keeper.rest_released().await;
                keeper.migrate_promoted().await;
                tick = tick.wrapping_add(1);
                if tick % SWARM_LOG_EVERY == 0 {
                    keeper.log_swarms();
                }
                if tick % CACHE_CHECK_EVERY == 0 {
                    keeper.trim_cache().await;
                }
            }
        });

        let cleaner = engine.clone();
        tokio::spawn(async move {
            tokio::time::sleep(STARTUP_CLEANUP_DELAY).await;
            cleaner.rest_leftovers().await;
        });
        Ok(engine)
    }

    pub fn session_was_reset(&self) -> bool {
        self.session_reset
    }

    pub fn listen_port(&self) -> u16 {
        self.listen_port
    }

    pub async fn stop(&self) {
        self.save_queue();
        self.save_last_played();
        if tokio::time::timeout(STOP_TIMEOUT, self.session.stop()).await.is_err() {
            tracing::warn!("session: did not stop in {} s", STOP_TIMEOUT.as_secs());
        }
    }

    fn apply_policy(&self, policy: DownloadPolicy) {
        let limit = |bytes_per_second: u32| std::num::NonZeroU32::new(bytes_per_second);
        self.session.ratelimits.set_download_bps(limit(policy.download_limit));
        self.session.ratelimits.set_upload_bps(limit(policy.upload_limit));
        *self.policy.lock().unwrap() = policy;
        self.policy_known.store(true, std::sync::atomic::Ordering::Relaxed);
    }

    pub fn set_policy(&self, policy: DownloadPolicy) {
        self.apply_policy(policy);
        write_json(&self.cache_dir.join(POLICY_FILE_NAME), &policy);
    }

    fn save_queue(&self) {
        let mut queued: Vec<String> = self.queued.lock().unwrap().iter().cloned().collect();
        queued.sort();
        write_json(&self.cache_dir.join(QUEUE_INDEX_NAME), &queued);
    }

    fn save_order(&self) {
        let order = self.order.lock().unwrap().clone();
        write_json(&self.cache_dir.join(ORDER_INDEX_NAME), &order);
    }

    fn save_promoted(&self) {
        let promoted = self.promoted.lock().unwrap().clone();
        write_json(&self.cache_dir.join(PROMOTED_INDEX_NAME), &promoted);
    }

    fn remember_order(&self, info_hash: &str) {
        let added = {
            let mut order = self.order.lock().unwrap();
            if order.contains_key(info_hash) {
                false
            } else {
                order.insert(info_hash.to_owned(), unix_millis(SystemTime::now()));
                true
            }
        };
        if added {
            self.save_order();
        }
    }

    fn is_promoted(&self, info_hash: &str) -> bool {
        self.promoted.lock().unwrap().contains_key(info_hash)
    }

    fn is_streaming_cache(&self, handle: &TorrentHandle) -> bool {
        self.is_online_only(handle) && !self.is_promoted(&handle.info_hash().as_string())
    }

    async fn enforce_policy(&self) {
        let policy = *self.policy.lock().unwrap();
        let mut torrents: Vec<TorrentHandle> = self.session.with_torrents(|torrents| {
            torrents.map(|(_, handle)| handle.clone()).filter(|handle| !self.is_online_only(handle)).collect()
        });
        {
            let order = self.order.lock().unwrap();
            torrents.sort_by_key(|handle| order.get(&handle.info_hash().as_string()).copied().unwrap_or(0));
        }
        let queued_before = self.queued.lock().unwrap().clone();

        if policy.seed_ratio > 0.0 {
            for handle in &torrents {
                let stats = handle.stats();
                let info_hash = handle.info_hash().as_string();
                let given_back = stats.total_bytes > 0 && stats.uploaded_bytes as f64 >= stats.total_bytes as f64 * f64::from(policy.seed_ratio);
                if stats.finished && given_back && !handle.is_paused() && self.seeding_stopped.lock().unwrap().insert(info_hash) {
                    let _ = self.session.pause(handle).await;
                }
            }
        }

        let downloading: Vec<&TorrentHandle> = torrents
            .iter()
            .filter(|handle| {
                let stats = handle.stats();
                !stats.finished && stats.total_bytes > 0
            })
            .collect();
        self.queued.lock().unwrap().retain(|info_hash| {
            downloading.iter().any(|handle| &handle.info_hash().as_string() == info_hash && handle.is_paused())
        });

        let limit = if policy.max_active_downloads == 0 { usize::MAX } else { policy.max_active_downloads };
        let mut active = downloading.iter().filter(|handle| !handle.is_paused()).count();
        for handle in downloading.iter().rev() {
            if active <= limit {
                break;
            }
            if !handle.is_paused() && self.session.pause(handle).await.is_ok() {
                self.queued.lock().unwrap().insert(handle.info_hash().as_string());
                active -= 1;
            }
        }
        for handle in &downloading {
            if active >= limit {
                break;
            }
            let info_hash = handle.info_hash().as_string();
            if self.queued.lock().unwrap().contains(&info_hash) && self.session.unpause(handle).await.is_ok() {
                self.queued.lock().unwrap().remove(&info_hash);
                active += 1;
            }
        }
        if *self.queued.lock().unwrap() != queued_before {
            self.save_queue();
        }
    }

    fn cache_data_folder(&self, info_hash: &str) -> PathBuf {
        self.cache_dir.join(CACHE_DATA_FOLDER_NAME).join(info_hash)
    }

    fn torrent_file(&self, info_hash: &str) -> PathBuf {
        self.cache_dir.join(format!("{info_hash}.torrent"))
    }

    fn is_online_only(&self, handle: &TorrentHandle) -> bool {
        handle.output_folder().starts_with(&self.cache_dir)
    }

    fn save_parked(&self) {
        let parked = self.parked.lock().unwrap().clone();
        write_json(&self.cache_dir.join(PARKED_INDEX_NAME), &parked);
    }

    fn forget_parked(&self, info_hash: &str) {
        self.parked.lock().unwrap().remove(info_hash);
        let _ = std::fs::remove_file(self.torrent_file(info_hash));
        self.save_parked();
    }

    fn log_swarms(&self) {
        let hashes: Vec<String> = self.usage.lock().unwrap().keys().cloned().collect();
        for info_hash in hashes {
            let Ok(handle) = self.find(&info_hash) else { continue };
            let stats = handle.stats();
            let speed = stats.live.as_ref().map(|live| live.download_speed.mbps).unwrap_or(0.0);
            let aggregate = stats
                .live
                .as_ref()
                .and_then(|live| serde_json::to_string(&live.snapshot.peer_stats).ok())
                .unwrap_or_default();
            let mut by_state: std::collections::BTreeMap<String, usize> = Default::default();
            let (mut attempts, mut connections, mut errors, mut incoming, mut fetched) = (0u64, 0u64, 0u64, 0u64, 0u64);
            if let Some(live) = handle.live() {
                if let Some(filter) = serde_json::from_value(serde_json::json!({ "state": "all" })).ok() {
                    let snapshot = live.per_peer_stats_snapshot(filter);
                    if let Ok(serde_json::Value::Object(peers)) = serde_json::to_value(&snapshot.peers) {
                        for peer in peers.values() {
                            *by_state.entry(peer["state"].as_str().unwrap_or("?").to_owned()).or_default() += 1;
                            let counter = |name: &str| peer["counters"][name].as_u64().unwrap_or(0);
                            attempts += counter("connection_attempts");
                            connections += counter("connections");
                            errors += counter("errors");
                            incoming += counter("incoming_connections");
                            fetched += counter("fetched_bytes");
                        }
                    }
                }
            }
            tracing::info!(
                "swarm {} state={:?} paused={} only_files={:?} have={}MB selected_total={}MB speed={:.2}MiB/s peers_by_state={:?} aggregate={} attempts={} connections={} errors={} incoming={} fetched={}MB trackers={} watching={}",
                &info_hash[..8],
                stats.state,
                handle.is_paused(),
                handle.only_files(),
                stats.progress_bytes >> 20,
                stats.total_bytes >> 20,
                speed,
                by_state,
                aggregate,
                attempts,
                connections,
                errors,
                incoming,
                fetched >> 20,
                handle.shared().trackers.len(),
                self.watching.lock().unwrap().get(&info_hash).map(|watch| watch.file).map_or("-".to_owned(), |file| file.to_string()),
            );
        }
    }

    fn save_last_played(&self) {
        let last_played = self.last_played.lock().unwrap().clone();
        write_json(&self.cache_dir.join(CACHE_INDEX_NAME), &last_played);
    }

    fn touch(&self, info_hash: &str) {
        let now = unix_millis(SystemTime::now());
        let previous = self.last_played.lock().unwrap().insert(info_hash.to_owned(), now);
        if previous.map_or(true, |previous| now.saturating_sub(previous) >= TOUCH_EVERY_MILLIS) {
            self.save_last_played();
        }
    }

    fn forget_cached(&self, info_hash: &str) {
        self.watching.lock().unwrap().remove(info_hash);
        self.announced.lock().unwrap().remove(info_hash);
        self.usage.lock().unwrap().remove(info_hash);
        if self.last_played.lock().unwrap().remove(info_hash).is_some() {
            self.save_last_played();
        }
    }

    fn is_in_use(&self, info_hash: &str) -> bool {
        self.usage.lock().unwrap().get(info_hash).is_some_and(Usage::in_use)
    }

    fn is_playing(&self, info_hash: &str) -> bool {
        self.usage.lock().unwrap().get(info_hash).is_some_and(Usage::playing)
    }

    fn resting_online(&self, with_lingering: bool) -> Vec<TorrentHandle> {
        self.session.with_torrents(|torrents| {
            torrents
                .map(|(_, handle)| handle.clone())
                .filter(|handle| {
                    let info_hash = handle.info_hash().as_string();
                    let busy = if with_lingering { self.is_playing(&info_hash) } else { self.is_in_use(&info_hash) };
                    self.is_streaming_cache(handle) && !busy
                })
                .collect()
        })
    }

    async fn rest(&self, handle: &TorrentHandle) {
        let info_hash = handle.info_hash().as_string();
        self.watching.lock().unwrap().remove(&info_hash);
        self.announced.lock().unwrap().remove(&info_hash);
        self.deselect(handle).await;
        if !handle.is_paused() {
            if let Err(error) = self.session.pause(handle).await {
                tracing::warn!("engine: could not pause {}: {error}", handle.info_hash().as_string());
            }
        }
    }

    async fn rest_leftovers(&self) {
        let _parking = self.parking.lock().await;
        for handle in self.resting_online(false) {
            self.rest(&handle).await;
        }
    }

    async fn rest_released(&self) {
        let _parking = self.parking.lock().await;
        let due: Vec<String> = {
            let mut usage = self.usage.lock().unwrap();
            let due: Vec<String> = usage.iter().filter(|(_, usage)| !usage.in_use()).map(|(hash, _)| hash.clone()).collect();
            for hash in &due {
                usage.remove(hash);
            }
            due
        };
        for info_hash in due {
            if let Ok(handle) = self.find(&info_hash) {
                if self.is_streaming_cache(&handle) {
                    self.rest(&handle).await;
                }
            }
        }
    }

    async fn trim_cache(&self) -> u64 {
        if !self.policy_known.load(std::sync::atomic::Ordering::Relaxed) {
            return 0;
        }
        let limit_gb = self.policy.lock().unwrap().cache_limit_gb;
        let limit = if limit_gb > 0.0 { (f64::from(limit_gb) * BYTES_PER_GIBIBYTE) as u64 } else { u64::MAX };
        let shortage = crate::commands::free_space(&self.cache_dir)
            .map_or(0, |free| FREE_SPACE_RESERVE.saturating_sub(free));
        if shortage > 0 {
            tracing::warn!("engine: the disk is almost full, freeing {} MB of the stream cache", shortage >> 20);
        }
        self.evict_cache(limit, false, shortage).await
    }

    pub async fn clear_cache(&self) -> u64 {
        self.evict_cache(0, true, 0).await
    }

    async fn evict_cache(&self, limit: u64, with_lingering: bool, shortage: u64) -> u64 {
        let _parking = self.parking.lock().await;
        let now = unix_millis(SystemTime::now());
        let max_age = CACHE_MAX_AGE.as_millis() as u64;
        let mut resting: Vec<(TorrentHandle, u64, u64)> = self
            .resting_online(with_lingering)
            .into_iter()
            .map(|handle| {
                let info_hash = handle.info_hash().as_string();
                let played = self.last_played.lock().unwrap().get(&info_hash).copied().unwrap_or(0);
                let size = allocated_bytes(&self.cache_data_folder(&info_hash));
                (handle, played, size)
            })
            .collect();
        let in_use: u64 = self
            .session
            .with_torrents(|torrents| {
                torrents
                    .map(|(_, handle)| handle.clone())
                    .filter(|handle| {
                        let info_hash = handle.info_hash().as_string();
                        let busy = if with_lingering { self.is_playing(&info_hash) } else { self.is_in_use(&info_hash) };
                        self.is_streaming_cache(handle) && busy
                    })
                    .collect::<Vec<_>>()
            })
            .iter()
            .map(|handle| allocated_bytes(&self.cache_data_folder(&handle.info_hash().as_string())))
            .sum();
        resting.sort_by_key(|(_, played, _)| *played);
        let mut total = in_use + resting.iter().map(|(_, _, size)| size).sum::<u64>();
        let mut freed = 0;
        for (handle, played, size) in resting {
            let too_old = now.saturating_sub(played) > max_age;
            if !too_old && total <= limit && freed >= shortage {
                continue;
            }
            let info_hash = handle.info_hash().as_string();
            match self.session.delete(TorrentIdOrHash::Hash(handle.info_hash()), true).await {
                Ok(()) => {
                    let _ = std::fs::remove_dir_all(self.cache_data_folder(&info_hash));
                    self.forget_cached(&info_hash);
                    total = total.saturating_sub(size);
                    freed += size;
                }
                Err(error) => tracing::warn!("engine: could not drop {info_hash} from the cache: {error}"),
            }
        }
        freed
    }

    pub fn cache_bytes(&self) -> u64 {
        allocated_bytes(&self.cache_dir.join(CACHE_DATA_FOLDER_NAME))
    }

    async fn add_from_bytes(
        &self,
        info_hash: &str,
        torrent_bytes: Bytes,
        name: &str,
        file_count: usize,
        files: Vec<usize>,
        download_dir: &Path,
        peers: Vec<SocketAddr>,
        trackers: Vec<String>,
    ) -> Result<()> {
        let output_folder = if files.is_empty() {
            self.cache_data_folder(info_hash)
        } else if file_count > 1 {
            download_dir.join(sanitize_folder_name(name))
        } else {
            download_dir.to_path_buf()
        };
        let paused = files.is_empty();
        if !paused {
            self.remember_order(info_hash);
        }
        let options = AddTorrentOptions {
            paused,
            only_files: Some(files),
            overwrite: true,
            output_folder: Some(output_folder.to_string_lossy().into_owned()),
            initial_peers: Some(peers),
            trackers: Some(trackers),
            ..Default::default()
        };
        self.session.add_torrent(AddTorrent::from_bytes(torrent_bytes), Some(options)).await?;
        Ok(())
    }

    fn parked_torrent(&self, info_hash: &str) -> Option<(Bytes, ParkedTorrent)> {
        let parked = self.parked.lock().unwrap().get(info_hash).cloned()?;
        let bytes = std::fs::read(self.torrent_file(info_hash)).ok()?;
        Some((Bytes::from(bytes), parked))
    }

    pub async fn inspect(&self, source: AddTorrent<'static>) -> Result<TorrentPreview> {
        let options = AddTorrentOptions {
            list_only: true,
            ..Default::default()
        };
        let response = tokio::time::timeout(
            METADATA_TIMEOUT,
            self.session.add_torrent(source, Some(options)),
        )
        .await
        .map_err(|_| anyhow!("metadata_timeout"))??;

        match response {
            AddTorrentResponse::ListOnly(listed) => {
                let info_hash = listed.info_hash.as_string();
                let name = listed
                    .info
                    .name()
                    .map(|n| n.into_owned())
                    .unwrap_or_else(|| info_hash.clone());
                let files: Vec<TorrentFileView> = listed
                    .info
                    .iter_file_details()
                    .enumerate()
                    .map(|(index, details)| TorrentFileView {
                        index,
                        path: details.filename.to_vec().join("/"),
                        length: details.len,
                        included: true,
                        downloaded: 0,
                    })
                    .collect();

                let already_added = self.find(&info_hash).is_ok();
                self.pending.lock().unwrap().insert(
                    info_hash.clone(),
                    PendingTorrent {
                        torrent_bytes: listed.torrent_bytes,
                        seen_peers: listed.seen_peers,
                        name: name.clone(),
                        file_count: files.len(),
                        trackers: Vec::new(),
                    },
                );
                Ok(TorrentPreview {
                    info_hash,
                    name,
                    files,
                    already_added,
                })
            }
            AddTorrentResponse::AlreadyManaged(_, handle) | AddTorrentResponse::Added(_, handle) => {
                Ok(TorrentPreview {
                    info_hash: handle.info_hash().as_string(),
                    name: display_name(&handle),
                    files: file_views(&handle, &[]),
                    already_added: true,
                })
            }
        }
    }

    pub async fn inspect_torrent_file(&self, bytes: Bytes) -> Result<TorrentPreview> {
        let trackers: Vec<String> = librqbit::torrent_from_bytes(&bytes)
            .map(|torrent| {
                torrent
                    .iter_announce()
                    .filter_map(|tracker| std::str::from_utf8(tracker.as_ref()).ok().and_then(|url| reqwest::Url::parse(url).ok()))
                    .map(|url| url.to_string())
                    .collect()
            })
            .unwrap_or_default();
        let preview = self.inspect(AddTorrent::from_bytes(bytes)).await?;
        if let Some(pending) = self.pending.lock().unwrap().get_mut(&preview.info_hash) {
            pending.trackers = trackers;
        }
        Ok(preview)
    }

    async fn take_file_trackers(&self, info_hash: &str, pending: PendingTorrent) -> Result<()> {
        let Ok(handle) = self.find(info_hash) else {
            return Ok(());
        };
        let known: HashSet<String> = handle.shared().trackers.iter().map(|tracker| tracker.to_string()).collect();
        if !self.is_online_only(&handle) || pending.trackers.iter().all(|tracker| known.contains(tracker)) {
            return Ok(());
        }
        let _parking = self.parking.lock().await;
        if self.is_playing(info_hash) {
            return Ok(());
        }
        tracing::info!("engine: {info_hash} takes the trackers of its .torrent file");
        self.watching.lock().unwrap().remove(info_hash);
        self.announced.lock().unwrap().remove(info_hash);
        self.usage.lock().unwrap().remove(info_hash);
        self.session.delete(TorrentIdOrHash::Hash(handle.info_hash()), false).await?;
        self.add_from_bytes(
            info_hash,
            pending.torrent_bytes,
            &pending.name,
            pending.file_count,
            Vec::new(),
            Path::new(""),
            pending.seen_peers,
            Vec::new(),
        )
        .await
    }

    pub async fn add(&self, info_hash: &str, files: Vec<usize>, download_dir: &Path) -> Result<()> {
        let known = self.find(info_hash).is_ok() || self.parked.lock().unwrap().contains_key(info_hash);
        if known {
            let pending = self.pending.lock().unwrap().remove(info_hash);
            if files.is_empty() {
                if let Some(pending) = pending.filter(|pending| !pending.trackers.is_empty()) {
                    self.take_file_trackers(info_hash, pending).await?;
                }
                return Ok(());
            }
            return self.select_files(info_hash, &files, download_dir).await;
        }

        let pending = self
            .pending
            .lock()
            .unwrap()
            .remove(info_hash)
            .ok_or_else(|| anyhow!("torrent_not_inspected"))?;
        self.add_from_bytes(
            info_hash,
            pending.torrent_bytes,
            &pending.name,
            pending.file_count,
            files,
            download_dir,
            pending.seen_peers,
            Vec::new(),
        )
        .await
    }

    pub fn list(&self) -> Vec<TorrentView> {
        let mut list: Vec<TorrentView> = self.session.with_torrents(|torrents| {
            torrents
                .map(|(_, handle)| {
                    let mut view = torrent_view(handle);
                    if self.is_streaming_cache(handle) {
                        if !self.is_playing(&view.info_hash) {
                            view.state = STATE_PARKED;
                        }
                        for file in &mut view.files {
                            file.included = false;
                        }
                        view.finished = false;
                        view.progress_bytes = 0;
                        view.total_bytes = 0;
                    }
                    view
                })
                .collect()
        });
        {
            let queued = self.queued.lock().unwrap();
            for torrent in &mut list {
                if torrent.state == "paused" && queued.contains(&torrent.info_hash) {
                    torrent.state = STATE_QUEUED;
                }
            }
        }
        for (info_hash, parked) in self.parked.lock().unwrap().iter() {
            if list.iter().any(|torrent| &torrent.info_hash == info_hash) {
                continue;
            }
            list.push(TorrentView {
                info_hash: info_hash.clone(),
                name: parked.name.clone(),
                output_folder: String::new(),
                state: STATE_PARKED,
                error: None,
                progress_bytes: 0,
                total_bytes: 0,
                uploaded_bytes: 0,
                finished: false,
                download_speed: 0.0,
                upload_speed: 0.0,
                peers: 0,
                files: parked
                    .files
                    .iter()
                    .enumerate()
                    .map(|(index, file)| TorrentFileView {
                        index,
                        path: file.path.clone(),
                        length: file.length,
                        included: false,
                        downloaded: 0,
                    })
                    .collect(),
            });
        }
        list
    }

    pub async fn pause(&self, info_hash: &str) -> Result<()> {
        let handle = self.find(info_hash)?;
        if handle.is_paused() {
            return Ok(());
        }
        self.session.pause(&handle).await
    }

    pub async fn resume(&self, info_hash: &str) -> Result<()> {
        let handle = self.find(info_hash)?;
        self.resume_handle(&handle).await
    }

    pub async fn delete(&self, info_hash: &str, delete_files: bool) -> Result<()> {
        let _parking = self.parking.lock().await;
        self.forget_parked(info_hash);
        self.forget_cached(info_hash);
        self.forget_download(info_hash);
        let Ok(handle) = self.find(info_hash) else {
            return Ok(());
        };
        let online_only = self.is_online_only(&handle);
        self.session.delete(TorrentIdOrHash::Hash(handle.info_hash()), delete_files || online_only).await?;
        if online_only {
            let _ = std::fs::remove_dir_all(self.cache_data_folder(info_hash));
        }
        Ok(())
    }

    pub async fn select_files(&self, info_hash: &str, files: &[usize], download_dir: &Path) -> Result<()> {
        let _parking = self.parking.lock().await;
        if let Ok(handle) = self.find(info_hash) {
            if !self.is_online_only(&handle) {
                self.include_files(&handle, files).await?;
                return self.resume_handle(&handle).await;
            }
            if self.is_playing(info_hash) {
                return self.download_while_watching(&handle, files, download_dir).await;
            }
            return self.move_to_downloads(&handle, files, download_dir).await;
        }
        let (torrent_bytes, parked) = self.parked_torrent(info_hash).ok_or_else(|| anyhow!("torrent_not_found"))?;
        self.forget_parked(info_hash);
        self.add_from_bytes(
            info_hash,
            torrent_bytes,
            &parked.name,
            parked.files.len(),
            files.to_vec(),
            download_dir,
            parked.peers,
            parked.trackers,
        )
        .await
    }

    pub fn lease_stream(self: &Arc<Self>, info_hash: &str) -> StreamLease {
        let mut usage = self.usage.lock().unwrap();
        let entry = usage.entry(info_hash.to_owned()).or_default();
        entry.streams += 1;
        StreamLease { engine: self.clone(), info_hash: info_hash.to_owned() }
    }

    pub fn hold_online(&self, info_hash: &str) {
        let mut usage = self.usage.lock().unwrap();
        let entry = usage.entry(info_hash.to_owned()).or_default();
        entry.holders += 1;
        entry.active = Some(Instant::now());
    }

    fn note_stream_request(&self, info_hash: &str) -> bool {
        let mut usage = self.usage.lock().unwrap();
        let entry = usage.entry(info_hash.to_owned()).or_default();
        if entry.just_released() {
            return false;
        }
        entry.active = Some(Instant::now());
        true
    }

    pub async fn prepare_stream(self: &Arc<Self>, info_hash: &str, file: Option<usize>) -> Result<TorrentHandle> {
        let (handle, online, late) = {
            let _parking = self.parking.lock().await;
            if self.find(info_hash).is_err() {
                let (torrent_bytes, parked) = self.parked_torrent(info_hash).ok_or_else(|| anyhow!("torrent_not_found"))?;
                self.add_from_bytes(
                    info_hash,
                    torrent_bytes,
                    &parked.name,
                    parked.files.len(),
                    Vec::new(),
                    Path::new(""),
                    parked.peers,
                    parked.trackers,
                )
                .await?;
            }
            let handle = self.find(info_hash)?;
            let online = self.is_streaming_cache(&handle);
            let late = self.is_online_only(&handle) && !self.note_stream_request(info_hash);
            if online && !late {
                self.touch(info_hash);
            }
            (handle, online, late)
        };
        tokio::time::timeout(STREAM_READY_TIMEOUT, handle.wait_until_initialized())
            .await
            .map_err(|_| anyhow!("torrent_not_ready"))?
            .map_err(|error| anyhow!(classify_torrent_error(&format!("{error:#}"))))?;
        if late {
            return Ok(handle);
        }
        let _parking = self.parking.lock().await;
        if self.find(info_hash).is_err() {
            return Err(anyhow!("torrent_not_found"));
        }
        let announcing = match (online, file) {
            (true, Some(file)) => self.select_for_announce(&handle, file).await,
            _ => false,
        };
        if let (true, false, Some(file)) = (online, announcing, file) {
            self.follow_watched(&handle, file).await;
        }
        self.resume_handle(&handle).await?;
        if announcing {
            self.announced.lock().unwrap().insert(info_hash.to_owned());
            let engine = self.clone();
            let announced = handle.clone();
            tokio::spawn(async move {
                tokio::time::sleep(ANNOUNCE_SELECTION).await;
                if !engine.is_online_only(&announced) {
                    return;
                }
                let info_hash = announced.info_hash().as_string();
                if engine.is_promoted(&info_hash) {
                    return;
                }
                let watched = match announced.only_files().as_deref() {
                    Some(&[file]) if engine.is_playing(&info_hash) => Some(file),
                    _ => None,
                };
                match watched {
                    Some(file) if engine.has_room_for(&announced, file) => {
                        tracing::info!("engine: {} keeps downloading file {file} ahead of the player", &info_hash[..8]);
                    }
                    _ => {
                        if watched.is_some() {
                            tracing::info!("engine: {} streams only, the disk has too little free space for the whole file", &info_hash[..8]);
                        }
                        engine.deselect(&announced).await;
                    }
                }
            });
        }
        Ok(handle)
    }

    async fn download_while_watching(&self, handle: &TorrentHandle, files: &[usize], download_dir: &Path) -> Result<()> {
        let info_hash = handle.info_hash().as_string();
        let promotion = {
            let mut promoted = self.promoted.lock().unwrap();
            let entry = promoted
                .entry(info_hash.clone())
                .or_insert_with(|| Promotion { files: Vec::new(), download_dir: download_dir.to_path_buf() });
            entry.download_dir = download_dir.to_path_buf();
            for file in files {
                if !entry.files.contains(file) {
                    entry.files.push(*file);
                }
            }
            entry.clone()
        };
        self.save_promoted();
        let mut wanted: HashSet<usize> = handle.only_files().unwrap_or_default().into_iter().collect();
        wanted.extend(promotion.files.iter().copied());
        self.session.update_only_files(handle, &wanted).await?;
        self.remember_order(&info_hash);
        tracing::info!("engine: {} keeps playing and downloads {:?} into the cache until the player closes", &info_hash[..8], promotion.files);
        self.resume_handle(handle).await
    }

    async fn migrate_promoted(&self) {
        let due: Vec<(String, Promotion)> = self
            .promoted
            .lock()
            .unwrap()
            .iter()
            .map(|(hash, promotion)| (hash.clone(), promotion.clone()))
            .collect();
        for (info_hash, promotion) in due {
            if self.is_in_use(&info_hash) {
                continue;
            }
            let _parking = self.parking.lock().await;
            if self.is_in_use(&info_hash) {
                continue;
            }
            match self.find(&info_hash) {
                Ok(handle) if self.is_online_only(&handle) => {
                    if let Err(error) = self.move_to_downloads(&handle, &promotion.files, &promotion.download_dir).await {
                        tracing::warn!("engine: could not move {} into the downloads: {error:#}", &info_hash[..8]);
                        continue;
                    }
                }
                _ => {}
            }
            self.forget_download(&info_hash);
        }
    }

    fn forget_download(&self, info_hash: &str) {
        if self.promoted.lock().unwrap().remove(info_hash).is_some() {
            self.save_promoted();
        }
    }

    async fn move_to_downloads(&self, handle: &TorrentHandle, files: &[usize], download_dir: &Path) -> Result<()> {
        let _migrating = self.migrating.lock().await;
        let info_hash = handle.info_hash().as_string();
        let torrent_bytes = handle.with_metadata(|metadata| metadata.torrent_bytes.clone())?;
        let relative: Vec<PathBuf> = handle.with_metadata(|metadata| {
            metadata.file_infos.iter().map(|file| file.relative_filename.clone()).collect()
        })?;
        let file_count = relative.len();
        let name = display_name(handle);
        let peers = live_peers(handle);
        let trackers = torrent_trackers(handle);
        let source = self.cache_data_folder(&info_hash);
        let target = if relative.len() > 1 { download_dir.join(sanitize_folder_name(&name)) } else { download_dir.to_path_buf() };

        crate::store::write_atomic(&self.torrent_file(&info_hash), &torrent_bytes)?;
        self.forget_cached(&info_hash);
        self.session.delete(TorrentIdOrHash::Hash(handle.info_hash()), false).await?;

        let moved = {
            let (source, target) = (source.clone(), target.clone());
            tauri::async_runtime::spawn_blocking(move || move_cached_files(&source, &target, &relative)).await?
        };
        match moved {
            Ok(bytes) => tracing::info!("engine: {} moved {} MB from the stream cache into the downloads", &info_hash[..8], bytes >> 20),
            Err(error) => tracing::warn!("engine: {} could not reuse the stream cache, it downloads again: {error:#}", &info_hash[..8]),
        }
        let _ = std::fs::remove_dir_all(&source);

        let result = self
            .add_from_bytes(&info_hash, torrent_bytes, &name, file_count, files.to_vec(), download_dir, peers, trackers)
            .await;
        if result.is_ok() {
            let _ = std::fs::remove_file(self.torrent_file(&info_hash));
        }
        result
    }

    fn has_room_for(&self, handle: &TorrentHandle, file: usize) -> bool {
        let Ok(Some(length)) = handle.with_metadata(|metadata| metadata.file_infos.get(file).map(|info| info.len)) else {
            return false;
        };
        let have = handle.stats().file_progress.get(file).copied().unwrap_or(0);
        let missing = length.saturating_sub(have);
        crate::commands::free_space(&self.cache_dir).is_some_and(|free| free >= missing.saturating_add(FREE_SPACE_RESERVE))
    }

    async fn follow_watched(&self, handle: &TorrentHandle, file: usize) {
        let current: HashSet<usize> = handle.only_files().unwrap_or_default().into_iter().collect();
        if current.len() == 1 && current.contains(&file) {
            return;
        }
        let info_hash = handle.info_hash().as_string();
        let wanted = if self.has_room_for(handle, file) { HashSet::from([file]) } else { HashSet::new() };
        if wanted == current {
            return;
        }
        match self.session.update_only_files(handle, &wanted).await {
            Ok(()) if wanted.is_empty() => {
                tracing::info!("engine: {} streams only, the disk has too little free space for file {file}", &info_hash[..8]);
            }
            Ok(()) => tracing::info!("engine: {} downloads file {file} ahead of the player", &info_hash[..8]),
            Err(error) => tracing::warn!("engine: could not select file {file} of {info_hash}: {error}"),
        }
    }

    async fn select_for_announce(&self, handle: &TorrentHandle, file: usize) -> bool {
        let info_hash = handle.info_hash().as_string();
        if self.announced.lock().unwrap().contains(&info_hash) {
            return false;
        }
        if !handle.is_paused() {
            if let Err(error) = self.session.pause(handle).await {
                tracing::warn!("engine: could not restart {info_hash} for its announce: {error}");
                return false;
            }
        }
        match self.session.update_only_files(handle, &HashSet::from([file])).await {
            Ok(()) => true,
            Err(error) => {
                tracing::warn!("engine: could not select file {file} of {info_hash}: {error}");
                false
            }
        }
    }

    async fn deselect(&self, handle: &TorrentHandle) {
        if handle.only_files().is_some_and(|files| !files.is_empty()) {
            if let Err(error) = self.session.update_only_files(handle, &HashSet::new()).await {
                tracing::warn!("engine: could not stop the download of {}: {error}", handle.info_hash().as_string());
            }
        }
    }

    pub async fn release_online(&self, info_hash: &str) -> Result<()> {
        let _parking = self.parking.lock().await;
        let still_held = {
            let mut usage = self.usage.lock().unwrap();
            let entry = usage.entry(info_hash.to_owned()).or_default();
            entry.holders = entry.holders.saturating_sub(1);
            if entry.holders == 0 {
                entry.released = Some(Instant::now());
            }
            entry.holders > 0
        };
        if still_held {
            return Ok(());
        }
        if let Ok(handle) = self.find(info_hash) {
            if self.is_streaming_cache(&handle) {
                self.touch(info_hash);
                self.deselect(&handle).await;
            }
        }
        Ok(())
    }

    pub async fn watch_file(&self, handle: &TorrentHandle, file: usize) {
        use tokio::io::AsyncSeekExt;

        let info_hash = handle.info_hash().as_string();
        if !self.is_online_only(handle) || !self.is_playing(&info_hash) {
            return;
        }
        if self.watching.lock().unwrap().get(&info_hash).is_some_and(|watch| watch.file == file) {
            return;
        }
        let held = async {
            let mut stream = handle.clone().stream(file).await?;
            stream.seek(std::io::SeekFrom::End(0)).await?;
            anyhow::Ok(stream)
        };
        match held.await {
            Ok(stream) => {
                self.watching.lock().unwrap().insert(info_hash, Watch { file, _keepalive: Box::new(stream) });
            }
            Err(error) => tracing::warn!("engine: could not hold file {file} of {info_hash} open: {error}"),
        }
    }

    pub fn file_pieces(&self, info_hash: &str, file_index: usize) -> Result<FilePieces> {
        let handle = self.find(info_hash)?;
        let (offset, length, piece_length) = handle
            .with_metadata(|metadata| {
                metadata
                    .file_infos
                    .get(file_index)
                    .map(|file| (file.offset_in_torrent, file.len, u64::from(metadata.info.lengths().default_piece_length())))
            })?
            .ok_or_else(|| anyhow!("file_not_found"))?;
        let (have, _) = librqbit::Api::new(self.session.clone(), None)
            .api_dump_haves(TorrentIdOrHash::Hash(handle.info_hash()))
            .map_err(|error| anyhow!("{error}"))?;
        let first = offset / piece_length;
        let last = (offset + length.max(1) - 1) / piece_length;
        let pieces = (first..=last).map(|index| have.get(index as usize).is_some_and(|bit| *bit)).collect();
        Ok(FilePieces { offset, length, piece_length, first, pieces })
    }

    pub fn file_path(&self, info_hash: &str, file_index: usize) -> Result<PathBuf> {
        let handle = self.find(info_hash)?;
        let relative = handle
            .with_metadata(|metadata| {
                metadata
                    .file_infos
                    .get(file_index)
                    .map(|file| file.relative_filename.clone())
            })?
            .ok_or_else(|| anyhow!("file_not_found"))?;
        Ok(handle.output_folder().join(relative))
    }

    pub fn file_name(&self, info_hash: &str, file_index: usize) -> Result<String> {
        let path = self.file_path(info_hash, file_index)?;
        Ok(path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default())
    }

    pub fn is_file_complete(&self, info_hash: &str, file_index: usize) -> bool {
        let Ok(handle) = self.find(info_hash) else {
            return false;
        };
        let stats = handle.stats();
        let length = handle
            .with_metadata(|metadata| metadata.file_infos.get(file_index).map(|file| file.len))
            .ok()
            .flatten();
        match (stats.file_progress.get(file_index), length) {
            (Some(have), Some(length)) => *have >= length,
            _ => false,
        }
    }

    fn find(&self, info_hash: &str) -> Result<TorrentHandle> {
        let id = parse_hash(info_hash)?;
        self.session
            .get(TorrentIdOrHash::Hash(id))
            .ok_or_else(|| anyhow!("torrent_not_found"))
    }

    async fn include_files(&self, handle: &TorrentHandle, files: &[usize]) -> Result<()> {
        let Some(current) = handle.only_files() else {
            return Ok(());
        };
        let mut selected: HashSet<usize> = current.into_iter().collect();
        let before = selected.len();
        selected.extend(files.iter().copied());
        if selected.len() == before {
            return Ok(());
        }
        self.session.update_only_files(handle, &selected).await
    }

    async fn resume_handle(&self, handle: &TorrentHandle) -> Result<()> {
        if !handle.is_paused() {
            return Ok(());
        }
        self.session.unpause(handle).await
    }
}

pub struct StreamLease {
    engine: Arc<Engine>,
    info_hash: String,
}

impl Drop for StreamLease {
    fn drop(&mut self) {
        if let Ok(mut usage) = self.engine.usage.lock() {
            if let Some(entry) = usage.get_mut(&self.info_hash) {
                entry.streams = entry.streams.saturating_sub(1);
                if entry.holders == 0 && !entry.just_released() {
                    entry.active = Some(Instant::now());
                }
            }
        }
    }
}

pub struct FilePieces {
    offset: u64,
    pub length: u64,
    piece_length: u64,
    first: u64,
    pieces: Vec<bool>,
}

impl FilePieces {
    fn piece_of(&self, position: u64) -> usize {
        ((self.offset + position.min(self.length.saturating_sub(1))) / self.piece_length - self.first) as usize
    }

    pub fn available_until(&self, start: u64) -> u64 {
        if start >= self.length {
            return self.length;
        }
        let mut piece = self.piece_of(start);
        while piece < self.pieces.len() && self.pieces[piece] {
            piece += 1;
        }
        let end = (self.first + piece as u64) * self.piece_length;
        end.saturating_sub(self.offset).clamp(start, self.length)
    }

    pub fn buckets(&self, count: usize) -> Vec<u8> {
        let count = count.clamp(1, 1000);
        (0..count)
            .map(|bucket| {
                let from = self.length * bucket as u64 / count as u64;
                let to = (self.length * (bucket as u64 + 1) / count as u64).max(from + 1);
                let (first, last) = (self.piece_of(from), self.piece_of(to - 1));
                let span = &self.pieces[first..=last.min(self.pieces.len() - 1)];
                let have = span.iter().filter(|have| **have).count();
                ((have * 255) / span.len().max(1)) as u8
            })
            .collect()
    }
}

fn live_peers(handle: &TorrentHandle) -> Vec<SocketAddr> {
    handle
        .live()
        .and_then(|live| {
            let filter = serde_json::from_value(serde_json::json!({ "state": "live" })).ok()?;
            Some(live.per_peer_stats_snapshot(filter).peers.into_keys().collect::<Vec<String>>())
        })
        .unwrap_or_default()
        .iter()
        .filter_map(|address| address.parse().ok())
        .take(MAX_REMEMBERED_PEERS)
        .collect()
}

fn torrent_trackers(handle: &TorrentHandle) -> Vec<String> {
    handle.shared().trackers.iter().map(|tracker| tracker.to_string()).collect()
}

fn move_cached_files(source: &Path, target: &Path, relative: &[PathBuf]) -> Result<u64> {
    let mut moved = 0u64;
    for path in relative {
        let from = source.join(path);
        let Ok(metadata) = std::fs::metadata(&from) else { continue };
        let to = target.join(path);
        if to.exists() {
            continue;
        }
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if std::fs::rename(&from, &to).is_err() {
            let staging = to.with_extension("kinuza-moving");
            std::fs::copy(&from, &staging).with_context(|| format!("could not copy {}", from.display()))?;
            std::fs::rename(&staging, &to)?;
            let _ = std::fs::remove_file(&from);
        }
        moved += metadata.len();
    }
    Ok(moved)
}

fn unix_millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as u64).unwrap_or(0)
}

fn allocated_bytes(path: &Path) -> u64 {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    if metadata.is_dir() {
        return std::fs::read_dir(path)
            .map(|entries| entries.flatten().map(|entry| allocated_bytes(&entry.path())).sum())
            .unwrap_or(0);
    }
    file_allocated_bytes(path).unwrap_or(metadata.len())
}

#[cfg(windows)]
fn file_allocated_bytes(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{GetCompressedFileSizeW, INVALID_FILE_SIZE};

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut high = 0u32;
    let low = unsafe { GetCompressedFileSizeW(wide.as_ptr(), &mut high) };
    if low == INVALID_FILE_SIZE {
        return None;
    }
    Some((u64::from(high) << 32) | u64::from(low))
}

#[cfg(unix)]
fn file_allocated_bytes(path: &Path) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(path).ok().map(|metadata| metadata.blocks() * 512)
}

#[cfg(not(any(windows, unix)))]
fn file_allocated_bytes(_path: &Path) -> Option<u64> {
    None
}

fn parse_hash(info_hash: &str) -> Result<Id20> {
    Id20::from_str(info_hash).map_err(|_| anyhow!("bad_info_hash"))
}

fn display_name(handle: &TorrentHandle) -> String {
    handle
        .name()
        .unwrap_or_else(|| handle.info_hash().as_string())
}

fn file_views(handle: &TorrentHandle, file_progress: &[u64]) -> Vec<TorrentFileView> {
    let only_files = handle.only_files();
    handle
        .with_metadata(|metadata| {
            metadata
                .file_infos
                .iter()
                .enumerate()
                .map(|(index, file)| TorrentFileView {
                    index,
                    path: file.relative_filename.to_string_lossy().replace('\\', "/"),
                    length: file.len,
                    included: only_files
                        .as_ref()
                        .map(|selected| selected.contains(&index))
                        .unwrap_or(true),
                    downloaded: file_progress.get(index).copied().unwrap_or(0),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn torrent_view(handle: &TorrentHandle) -> TorrentView {
    let stats = handle.stats();
    let state = match stats.state {
        TorrentStatsState::Initializing { .. } => "initializing",
        TorrentStatsState::Live => "live",
        TorrentStatsState::Paused => "paused",
        TorrentStatsState::Error => "error",
    };
    let (download_speed, upload_speed, peers) = match &stats.live {
        Some(live) => (
            live.download_speed.mbps * BYTES_PER_MEBIBYTE,
            live.upload_speed.mbps * BYTES_PER_MEBIBYTE,
            live_peer_count(&live.snapshot.peer_stats),
        ),
        None => (0.0, 0.0, 0),
    };

    TorrentView {
        info_hash: handle.info_hash().as_string(),
        name: display_name(handle),
        output_folder: handle.output_folder().to_string_lossy().into_owned(),
        state,
        error: stats.error.as_deref().map(classify_torrent_error),
        progress_bytes: stats.progress_bytes,
        total_bytes: stats.total_bytes,
        uploaded_bytes: stats.uploaded_bytes,
        finished: stats.finished,
        download_speed,
        upload_speed,
        peers,
        files: file_views(handle, &stats.file_progress),
    }
}

fn live_peer_count(peer_stats: &impl Serialize) -> u64 {
    serde_json::to_value(peer_stats)
        .ok()
        .and_then(|value| value.get("live").and_then(|live| live.as_u64()))
        .unwrap_or(0)
}

fn sanitize_folder_name(name: &str) -> String {
    const FORBIDDEN_CHARS: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    let cleaned: String = name
        .chars()
        .map(|c| if FORBIDDEN_CHARS.contains(&c) || c.is_control() { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.');
    if trimmed.is_empty() {
        "torrent".to_owned()
    } else {
        trimmed.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pieces(offset: u64, length: u64, have: &[bool]) -> FilePieces {
        let piece_length = 100;
        FilePieces { offset, length, piece_length, first: offset / piece_length, pieces: have.to_vec() }
    }

    #[test]
    fn available_stops_at_the_first_missing_piece() {
        let map = pieces(50, 400, &[true, true, false, true, true]);
        assert_eq!(map.available_until(0), 150);
        assert_eq!(map.available_until(160), 160);
        assert_eq!(map.available_until(260), 400);
        assert_eq!(map.available_until(400), 400);
    }

    #[test]
    fn buckets_show_the_share_downloaded() {
        let map = pieces(0, 400, &[true, false, true, true]);
        assert_eq!(map.buckets(4), vec![255, 0, 255, 255]);
        assert_eq!(map.buckets(2), vec![127, 255]);
    }

    #[test]
    fn disk_errors_are_named() {
        assert_eq!(classify_torrent_error("write failed: No space left on device (os error 28)"), "disk_full");
        assert_eq!(classify_torrent_error("Недостаточно места на диске. (os error 112)"), "disk_full");
        assert_eq!(classify_torrent_error("tracker failed"), "tracker failed");
    }
}
