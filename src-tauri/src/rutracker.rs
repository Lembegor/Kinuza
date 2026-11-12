use std::collections::HashMap;
use std::time::Duration;

use encoding_rs::WINDOWS_1251;
use percent_encoding::{percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::sync::Mutex;
use tokio::time::{Instant, MissedTickBehavior};

const FORUM_HOST: &str = "rutracker.net";
const WORKER_WINDOW_LABEL: &str = "rutracker-worker";
const MAIN_WINDOW_LABEL: &str = "main";
const PARKING_URL: &str = "about:blank";
const PARKING_REQUEST_ID: u64 = 0;
const PARKING_PROBE_INTERVAL: Duration = Duration::from_millis(50);
const PARKING_TIMEOUT: Duration = Duration::from_secs(2);
const HIDDEN_PAGE_TIMEOUT: Duration = Duration::from_secs(30);
const SHOWN_PAGE_TIMEOUT: Duration = Duration::from_secs(4 * 60);
const QUEUE_WAIT: Duration = Duration::from_secs(5 * 60);
const ERROR_BUSY: &str = "tracker_busy";

static WINDOW_SHOWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static REVEAL_REQUESTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

struct ShownWindow;

impl ShownWindow {
    fn mark() -> Self {
        WINDOW_SHOWN.store(true, std::sync::atomic::Ordering::Relaxed);
        Self
    }
}

impl Drop for ShownWindow {
    fn drop(&mut self) {
        WINDOW_SHOWN.store(false, std::sync::atomic::Ordering::Relaxed);
    }
}

async fn take_turn<'a>(state: &'a Mutex<RutrackerState>, quiet: bool) -> Result<tokio::sync::MutexGuard<'a, RutrackerState>, String> {
    if let Ok(guard) = state.try_lock() {
        return Ok(guard);
    }
    if quiet && WINDOW_SHOWN.load(std::sync::atomic::Ordering::Relaxed) {
        return Err(ERROR_BUSY.to_owned());
    }
    tokio::time::timeout(QUEUE_WAIT, state.lock()).await.map_err(|_| ERROR_BUSY.to_owned())
}
const PROBE_INTERVAL: Duration = Duration::from_millis(400);
const CHALLENGE_GRACE: Duration = Duration::from_secs(6);
const MARK_STALE_SCRIPT: &str = "window.__kinuzaStale = true;";
const MAX_SEARCH_RESULTS: usize = 50;
const LAST_SEARCH_PAGE: u32 = 9;
const MAX_SIZE_LOOKUPS: usize = 20;
const SEARCH_ORDER: &str = "o=10&s=2";
const MAGNET_PREFIX: &str = "magnet:?xt=urn:btih:";
const ERROR_TORRENT_FILE: &str = "torrent_file_unavailable";
const PARALLEL_TOPIC_FETCHES: usize = 4;
const TOPIC_FETCH_TIMEOUT: Duration = Duration::from_secs(8);

const ERROR_AUTH_REQUIRED: &str = "auth_required";
const ERROR_CANCELLED: &str = "cancelled";
const ERROR_TIMEOUT: &str = "timeout";
const ERROR_MAGNET_NOT_FOUND: &str = "magnet_not_found";
const ERROR_PARSE_FAILED: &str = "tracker_parse_failed";
const ERROR_MARKUP_CHANGED: &str = "tracker_markup_changed";
const ERROR_UNEXPECTED_PAGE: &str = "tracker_unexpected_page";

const PROBE_SCRIPT: &str = r##"(() => {
  if (window.__kinuzaStale || location.hostname !== "__HOST__" || document.readyState === "loading") return null;
  const challenge = typeof window._cf_chl_opt !== "undefined"
    || document.querySelector("#challenge-form, #challenge-running, #challenge-error-text") !== null
    || /^(just a moment|один момент)/i.test(document.title);
  const guest = location.pathname.endsWith("/login.php")
    || document.querySelector('a[href*="profile.php?mode=register"]') !== null;
  let data = null;
  if (!challenge) {
    try { data = (__EXTRACT__)(); } catch (_) { data = null; }
  }
  return JSON.stringify({ challenge, guest, data });
})()"##;

const SEARCH_EXTRACTOR: &str = r##"() => {
  const rows = [...document.querySelectorAll("#tor-tbl > tbody > tr")];
  const text = (row, selector) =>
    (row.querySelector(selector)?.textContent || "").replace(/↓/g, "").replace(/\s+/g, " ").trim();
  const items = rows.map((row) => {
    const link = row.querySelector("a.tLink");
    const id = link && (link.getAttribute("href") || "").match(/[?&]t=(\d+)/);
    if (!id) return null;
    return {
      id: id[1],
      title: link.textContent.trim(),
      size: text(row, "td.tor-size"),
      seeds: parseInt(text(row, "b.seedmed"), 10) || 0,
    };
  }).filter(Boolean);
  return {
    title: document.title,
    isSearchPage: location.pathname.endsWith("/tracker.php"),
    rowCount: rows.length,
    items,
  };
}"##;

const MAGNET_EXTRACTOR: &str = r##"() => {
  const link = document.querySelector('a.magnet-link[href^="magnet:"], a[href^="magnet:"]');
  if (link) return link.getAttribute('href');
  const match = document.documentElement.innerHTML.match(/magnet:\?xt=urn:btih:[^"'<>\s]+/);
  return match ? match[0].replace(/&amp;/g, '&') : null;
}"##;

const TORRENT_FILE_EXTRACTOR: &str = r##"() => {
  const job = (window.__kinuzaTorrent__ID__ ||= { started: false, done: false, data: null, error: null });
  if (!job.started) {
    job.started = true;
    (async () => {
      try {
        const response = await fetch("dl.php?t=__ID__", { credentials: "same-origin", signal: AbortSignal.timeout(__FETCH_TIMEOUT_MS__) });
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!response.ok || bytes.length === 0 || bytes[0] !== 0x64) {
          job.error = "not_a_torrent:" + response.status;
          return;
        }
        let hex = "";
        for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
        job.data = hex;
      } catch (error) {
        job.error = String(error);
      } finally {
        job.done = true;
      }
    })();
  }
  return job.done ? { pending: false, data: job.data, error: job.error } : { pending: true };
}"##;

const VIDEO_SIZES_EXTRACTOR: &str = r##"() => {
  const job = (window.__kinuzaVideoSizes ||= { started: false, done: false, sizes: {} });
  if (!job.started) {
    job.started = true;
    const ids = __IDS__;
    const sizeIn = (text) => {
      const anywhere = [text];
      const videoLines = [...text.matchAll(/Видео\s*:/gi)].map((match) => text.slice(match.index, match.index + 240));
      for (const scope of [...videoLines, ...anywhere]) {
        for (const match of scope.matchAll(/(\d{3,4})\s?[xх×*]\s?(\d{3,4})/g)) {
          const width = Number(match[1]);
          const height = Number(match[2]);
          if (width >= 320 && width <= 8192 && height >= 200 && height <= 4320) return { width, height };
        }
      }
      return null;
    };
    const firstPost = (page) => page.querySelector(".post_body")?.textContent || "";
    const openedId = new URLSearchParams(location.search).get("t");
    const read = async (id) => {
      try {
        let text = "";
        if (id === openedId) {
          text = firstPost(document);
        } else {
          const response = await fetch(`viewtopic.php?t=${id}`, { credentials: "same-origin", signal: AbortSignal.timeout(__FETCH_TIMEOUT_MS__) });
          const html = new TextDecoder("windows-1251").decode(await response.arrayBuffer());
          text = firstPost(new DOMParser().parseFromString(html, "text/html"));
        }
        const size = sizeIn(text);
        if (size) job.sizes[id] = size;
      } catch (_) {}
    };
    const queue = [...ids];
    const drain = async () => {
      while (queue.length > 0) await read(queue.shift());
    };
    Promise.all(Array.from({ length: __PARALLEL__ }, drain)).then(() => { job.done = true; });
  }
  return job.done ? { pending: false, sizes: job.sizes } : { pending: true };
}"##;

const NO_EXTRACTOR: &str = "() => null";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RutrackerItem {
    pub id: String,
    pub title: String,
    pub size: String,
    pub seeds: u32,
    pub page_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchPage {
    title: String,
    is_search_page: bool,
    row_count: usize,
    items: Vec<ScrapedItem>,
}

#[derive(Deserialize)]
struct ScrapedItem {
    id: String,
    title: String,
    size: String,
    seeds: u32,
}

#[derive(Serialize, Deserialize, Clone, Copy)]
pub struct VideoSize {
    pub width: u32,
    pub height: u32,
}

#[derive(Deserialize)]
struct VideoSizeLookup {
    pending: bool,
    #[serde(default)]
    sizes: HashMap<String, VideoSize>,
}

#[derive(Deserialize)]
struct PageReport {
    challenge: bool,
    guest: bool,
    data: Value,
}

impl PageReport {
    fn parse(raw: &str) -> Option<Self> {
        let json: String = serde_json::from_str(raw).ok()?;
        serde_json::from_str(&json).ok()
    }
}

enum Signal {
    Report { request_id: u64, raw: String },
    Closed,
}

struct Worker {
    window: WebviewWindow,
    signals: UnboundedReceiver<Signal>,
    sender: UnboundedSender<Signal>,
    closed: bool,
}

impl Worker {
    fn open(app: &AppHandle, url: Url) -> Result<Self, String> {
        let (sender, signals) = unbounded_channel();

        let mut builder = WebviewWindowBuilder::new(app, WORKER_WINDOW_LABEL, WebviewUrl::External(url))
            .title("RuTracker")
            .inner_size(1000.0, 760.0)
            .center()
            .visible(false)
            .focused(false);

        let main_browser_args = app
            .config()
            .app
            .windows
            .iter()
            .find(|window| window.label == MAIN_WINDOW_LABEL)
            .and_then(|window| window.additional_browser_args.clone());
        if let Some(args) = main_browser_args {
            builder = builder.additional_browser_args(&args);
        }

        let main = app.get_webview_window(MAIN_WINDOW_LABEL);
        if let Some(main) = &main {
            builder = builder.parent(main).map_err(|e| e.to_string())?;
        }

        let window = builder.build().map_err(|e| e.to_string())?;

        let close_sender = sender.clone();
        window.on_window_event(move |event| {
            if matches!(event, WindowEvent::Destroyed) {
                let _ = close_sender.send(Signal::Closed);
            }
        });

        if let Some(main) = main {
            let worker_window = window.clone();
            main.on_window_event(move |event| {
                if matches!(event, WindowEvent::Destroyed) {
                    let _ = worker_window.destroy();
                }
            });
        }

        Ok(Self { window, signals, sender, closed: false })
    }

    fn discard_pending(&mut self) -> bool {
        while let Ok(signal) = self.signals.try_recv() {
            if matches!(signal, Signal::Closed) {
                return false;
            }
        }
        true
    }

    fn reveal(&self) {
        let _ = self.window.show();
        let _ = self.window.unminimize();
        let _ = self.window.set_focus();
    }

    async fn park(&mut self) {
        let _ = self.window.hide();
        let _ = self.window.navigate(PARKING_URL.parse().expect("valid parking url"));

        let deadline = Instant::now() + PARKING_TIMEOUT;
        let mut probe_timer = tokio::time::interval(PARKING_PROBE_INTERVAL);
        probe_timer.set_missed_tick_behavior(MissedTickBehavior::Delay);

        loop {
            tokio::select! {
                _ = probe_timer.tick() => {
                    if Instant::now() >= deadline {
                        return;
                    }
                    let sender = self.sender.clone();
                    let _ = self.window.eval_with_callback("location.href", move |raw| {
                        let _ = sender.send(Signal::Report { request_id: PARKING_REQUEST_ID, raw });
                    });
                }
                signal = self.signals.recv() => match signal {
                    Some(Signal::Report { request_id: PARKING_REQUEST_ID, raw }) if raw.contains(PARKING_URL) => return,
                    Some(Signal::Report { .. }) => {}
                    None | Some(Signal::Closed) => {
                        self.closed = true;
                        return;
                    }
                },
            }
        }
    }

    async fn drive<T>(
        &mut self,
        request_id: u64,
        script: &str,
        mut visible: bool,
        may_reveal: bool,
        mut on_page: impl FnMut(PageReport) -> Option<Result<T, String>>,
    ) -> Result<T, String> {
        let hidden_deadline = Instant::now() + HIDDEN_PAGE_TIMEOUT;
        let mut shown_deadline = Instant::now() + SHOWN_PAGE_TIMEOUT;
        let mut shown = visible.then(ShownWindow::mark);
        let mut challenge_since: Option<Instant> = None;
        let mut probe_timer = tokio::time::interval(PROBE_INTERVAL);
        probe_timer.set_missed_tick_behavior(MissedTickBehavior::Delay);
        REVEAL_REQUESTED.store(false, std::sync::atomic::Ordering::Relaxed);

        loop {
            tokio::select! {
                _ = probe_timer.tick() => {
                    if REVEAL_REQUESTED.swap(false, std::sync::atomic::Ordering::Relaxed) && !visible {
                        self.reveal();
                        visible = true;
                        shown_deadline = Instant::now() + SHOWN_PAGE_TIMEOUT;
                        shown = Some(ShownWindow::mark());
                    }
                    let now = Instant::now();
                    if (!visible && now >= hidden_deadline) || (visible && now >= shown_deadline) {
                        let _ = self.window.destroy();
                        self.closed = true;
                        drop(shown.take());
                        return Err(ERROR_TIMEOUT.to_owned());
                    }
                    let sender = self.sender.clone();
                    let probed = self.window.eval_with_callback(script, move |raw| {
                        let _ = sender.send(Signal::Report { request_id, raw });
                    });
                    if let Err(error) = probed {
                        let _ = self.window.destroy();
                        self.closed = true;
                        return Err(error.to_string());
                    }
                }
                signal = self.signals.recv() => {
                    let (reported_id, raw) = match signal {
                        Some(Signal::Report { request_id, raw }) => (request_id, raw),
                        None | Some(Signal::Closed) => {
                            self.closed = true;
                            return Err(ERROR_CANCELLED.to_owned());
                        }
                    };
                    if reported_id != request_id {
                        continue;
                    }
                    let Some(report) = PageReport::parse(&raw) else {
                        continue;
                    };
                    if report.challenge {
                        let since = *challenge_since.get_or_insert_with(Instant::now);
                        if !visible && may_reveal && since.elapsed() >= CHALLENGE_GRACE {
                            self.reveal();
                            visible = true;
                            shown_deadline = Instant::now() + SHOWN_PAGE_TIMEOUT;
                            shown = Some(ShownWindow::mark());
                        }
                        continue;
                    }
                    challenge_since = None;
                    if let Some(result) = on_page(report) {
                        return result;
                    }
                }
            }
        }
    }
}

pub struct RutrackerState {
    worker: Option<Worker>,
    last_request_id: u64,
}

impl RutrackerState {
    pub fn new() -> Self {
        Self { worker: None, last_request_id: 0 }
    }

    async fn request<T>(
        &mut self,
        app: &AppHandle,
        url: Url,
        extractor: &str,
        visible: bool,
        may_reveal: bool,
        on_page: impl FnMut(PageReport) -> Option<Result<T, String>>,
    ) -> Result<T, String> {
        self.last_request_id += 1;
        let request_id = self.last_request_id;
        let script = PROBE_SCRIPT
            .replace("__HOST__", FORUM_HOST)
            .replace("__EXTRACT__", extractor);

        let mut reused = None;
        if let Some(mut worker) = self.worker.take() {
            let _ = worker.window.eval(MARK_STALE_SCRIPT);
            if worker.discard_pending() && worker.window.navigate(url.clone()).is_ok() {
                reused = Some(worker);
            }
        }
        let mut worker = match reused {
            Some(worker) => worker,
            None => Worker::open(app, url)?,
        };

        if visible {
            worker.reveal();
        }
        let result = worker.drive(request_id, &script, visible, may_reveal, on_page).await;

        if !worker.closed {
            worker.park().await;
        }
        if !worker.closed {
            self.worker = Some(worker);
        }
        result
    }
}

fn forum_url(page: &str) -> Url {
    format!("https://{FORUM_HOST}/forum/{page}").parse().expect("valid forum url")
}

fn is_topic_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_digit())
}

fn is_magnet_link(link: &str) -> bool {
    link.strip_prefix(MAGNET_PREFIX).is_some_and(|rest| {
        let hash = rest.split('&').next().unwrap_or_default();
        !hash.is_empty() && hash.chars().all(|c| c.is_ascii_alphanumeric())
    })
}

fn parse_search_page(data: Value) -> Result<Vec<RutrackerItem>, String> {
    let page: SearchPage =
        serde_json::from_value(data).map_err(|_| ERROR_PARSE_FAILED.to_owned())?;

    if !page.is_search_page {
        return Err(format!("{ERROR_UNEXPECTED_PAGE}:{}", page.title));
    }
    if page.items.is_empty() && page.row_count > 1 {
        return Err(ERROR_MARKUP_CHANGED.to_owned());
    }

    let mut items: Vec<RutrackerItem> = page
        .items
        .into_iter()
        .filter(|item| is_topic_id(&item.id))
        .map(|item| RutrackerItem {
            page_url: forum_url(&format!("viewtopic.php?t={}", item.id)).into(),
            id: item.id,
            title: item.title,
            size: item.size,
            seeds: item.seeds,
        })
        .collect();

    items.sort_by(|a, b| b.seeds.cmp(&a.seeds));
    items.truncate(MAX_SEARCH_RESULTS);
    Ok(items)
}

const CLOUDFLARE_COOKIE_PREFIXES: &[&str] = &["cf_", "__cf"];
const SESSION_COOKIE: &str = "bb_session";

fn is_cloudflare_cookie(name: &str) -> bool {
    CLOUDFLARE_COOKIE_PREFIXES.iter().any(|prefix| name.starts_with(prefix))
}

fn has_forum_cookies<'a>(names: impl IntoIterator<Item = &'a str>) -> bool {
    names.into_iter().any(|name| !is_cloudflare_cookie(name))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RutrackerAccount {
    signed_in: bool,
}

#[tauri::command]
pub async fn rutracker_account(app: AppHandle) -> Result<RutrackerAccount, String> {
    let main = app.get_webview_window(MAIN_WINDOW_LABEL).ok_or_else(|| ERROR_UNEXPECTED_PAGE.to_owned())?;
    let cookies = main.cookies_for_url(forum_url("index.php")).map_err(|error| error.to_string())?;
    Ok(RutrackerAccount { signed_in: cookies.iter().any(|cookie| cookie.name() == SESSION_COOKIE && !cookie.value().is_empty()) })
}

const COOKIE_DELETE_TIMEOUT: Duration = Duration::from_secs(5);
const COOKIE_SETTLE_STEP: Duration = Duration::from_millis(200);
const COOKIE_SETTLE_STEPS: u32 = 10;

#[derive(Clone)]
struct ForumCookie {
    name: String,
    domain: String,
    path: String,
}

#[cfg(windows)]
async fn delete_forum_cookies(main: &WebviewWindow, cookies: Vec<ForumCookie>) -> Result<(), String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let uris = [forum_url("").to_string(), format!("https://{FORUM_HOST}/")];
    main.with_webview(move |webview| {
        let deleted = (|| -> windows_core::Result<()> {
            use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_2;
            use windows_core::{Interface, HSTRING};
            let manager = unsafe { webview.controller().CoreWebView2()?.cast::<ICoreWebView2_2>()?.CookieManager()? };
            for cookie in &cookies {
                let name = HSTRING::from(cookie.name.as_str());
                for uri in &uris {
                    unsafe { manager.DeleteCookies(&name, &HSTRING::from(uri.as_str()))? };
                }
                let bare = cookie.domain.trim_start_matches('.');
                for domain in [bare.to_owned(), format!(".{bare}")] {
                    for path in [cookie.path.as_str(), "/", "/forum/", "/forum"] {
                        unsafe { manager.DeleteCookiesWithDomainAndPath(&name, &HSTRING::from(domain.as_str()), &HSTRING::from(path))? };
                    }
                }
            }
            Ok(())
        })();
        let _ = sender.send(deleted.map_err(|error| error.to_string()));
    })
    .map_err(|error| error.to_string())?;
    tokio::time::timeout(COOKIE_DELETE_TIMEOUT, receiver)
        .await
        .map_err(|_| ERROR_TIMEOUT.to_owned())?
        .map_err(|_| ERROR_CANCELLED.to_owned())?
}

#[cfg(not(windows))]
async fn delete_forum_cookies(main: &WebviewWindow, targets: Vec<ForumCookie>) -> Result<(), String> {
    let cookies = main.cookies_for_url(forum_url("index.php")).map_err(|error| error.to_string())?;
    for cookie in cookies.into_iter().filter(|cookie| targets.iter().any(|target| target.name == cookie.name())) {
        main.delete_cookie(cookie).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn rutracker_sign_out(app: AppHandle, state: tauri::State<'_, Mutex<RutrackerState>>) -> Result<(), String> {
    let _turn = take_turn(&state, false).await?;
    let main = app.get_webview_window(MAIN_WINDOW_LABEL).ok_or_else(|| ERROR_UNEXPECTED_PAGE.to_owned())?;
    let cookies = main.cookies_for_url(forum_url("index.php")).map_err(|error| error.to_string())?;
    let targets: Vec<ForumCookie> = cookies
        .iter()
        .filter(|cookie| !is_cloudflare_cookie(cookie.name()))
        .map(|cookie| ForumCookie {
            name: cookie.name().to_owned(),
            domain: cookie.domain().unwrap_or(FORUM_HOST).to_owned(),
            path: cookie.path().unwrap_or("/").to_owned(),
        })
        .collect();
    for target in &targets {
        tracing::info!("rutracker: sign out removes {} (domain {}, path {})", target.name, target.domain, target.path);
    }
    if let Err(error) = delete_forum_cookies(&main, targets).await {
        tracing::warn!("rutracker: sign out failed: {error}");
        return Err(error);
    }
    for _ in 0..COOKIE_SETTLE_STEPS {
        tokio::time::sleep(COOKIE_SETTLE_STEP).await;
        let left = main.cookies_for_url(forum_url("index.php")).map_err(|error| error.to_string())?;
        if !left.iter().any(|cookie| cookie.name() == SESSION_COOKIE) {
            tracing::info!("rutracker: signed out");
            return Ok(());
        }
    }
    let left = main.cookies_for_url(forum_url("index.php")).map_err(|error| error.to_string())?;
    for cookie in left.iter().filter(|cookie| cookie.name() == SESSION_COOKIE) {
        tracing::warn!(
            "rutracker: session cookie stayed (domain {:?}, path {:?}, http only {:?}, secure {:?})",
            cookie.domain(),
            cookie.path(),
            cookie.http_only(),
            cookie.secure()
        );
    }
    Err(ERROR_UNEXPECTED_PAGE.to_owned())
}

#[tauri::command]
pub async fn rutracker_maybe_signed_in(app: AppHandle) -> Result<Option<bool>, String> {
    let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return Ok(None);
    };
    match main.cookies_for_url(forum_url("index.php")) {
        Ok(cookies) => Ok(Some(has_forum_cookies(cookies.iter().map(|cookie| cookie.name())))),
        Err(error) => {
            tracing::warn!("rutracker: cookies unavailable: {error}");
            Ok(None)
        }
    }
}

#[tauri::command]
pub fn rutracker_show_window(app: AppHandle) {
    REVEAL_REQUESTED.store(true, std::sync::atomic::Ordering::Relaxed);
    if let Some(window) = app.get_webview_window(WORKER_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[tauri::command]
pub async fn rutracker_login_window(
    app: AppHandle,
    state: tauri::State<'_, Mutex<RutrackerState>>,
) -> Result<(), String> {
    take_turn(&state, false)
        .await?
        .request(&app, forum_url("login.php"), NO_EXTRACTOR, true, true, |page| (!page.guest).then_some(Ok(())))
        .await
}

#[tauri::command]
pub async fn rutracker_search(
    app: AppHandle,
    state: tauri::State<'_, Mutex<RutrackerState>>,
    query: String,
    quiet: Option<bool>,
    page: Option<u32>,
) -> Result<Vec<RutrackerItem>, String> {
    let (encoded_query, _, _) = WINDOWS_1251.encode(&query);
    let start = page.unwrap_or(0).min(LAST_SEARCH_PAGE) as usize * MAX_SEARCH_RESULTS;
    let paging = if start > 0 { format!("&start={start}") } else { String::new() };
    let url = forum_url(&format!(
        "tracker.php?nm={}&{SEARCH_ORDER}{paging}",
        percent_encode(&encoded_query, NON_ALPHANUMERIC)
    ));

    take_turn(&state, quiet.unwrap_or(false))
        .await?
        .request(&app, url, SEARCH_EXTRACTOR, false, !quiet.unwrap_or(false), |page| {
            Some(if page.guest {
                Err(ERROR_AUTH_REQUIRED.to_owned())
            } else {
                parse_search_page(page.data)
            })
        })
        .await
}

#[tauri::command]
pub async fn rutracker_magnet(
    app: AppHandle,
    state: tauri::State<'_, Mutex<RutrackerState>>,
    id: String,
    quiet: Option<bool>,
) -> Result<String, String> {
    if !is_topic_id(&id) {
        return Err(ERROR_MAGNET_NOT_FOUND.to_owned());
    }
    let url = forum_url(&format!("viewtopic.php?t={id}"));

    take_turn(&state, quiet.unwrap_or(false))
        .await?
        .request(&app, url, MAGNET_EXTRACTOR, false, !quiet.unwrap_or(false), |page| {
            Some(match page.data.as_str() {
                Some(link) if is_magnet_link(link) => Ok(link.to_owned()),
                _ if page.guest => Err(ERROR_AUTH_REQUIRED.to_owned()),
                _ => Err(ERROR_MAGNET_NOT_FOUND.to_owned()),
            })
        })
        .await
}

#[derive(Deserialize)]
struct TorrentFileLookup {
    #[serde(default)]
    pending: bool,
    data: Option<String>,
    error: Option<String>,
}

fn decode_hex(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 {
        return None;
    }
    (0..text.len()).step_by(2).map(|index| u8::from_str_radix(text.get(index..index + 2)?, 16).ok()).collect()
}

#[tauri::command]
pub async fn rutracker_torrent_inspect(
    app: AppHandle,
    state: tauri::State<'_, Mutex<RutrackerState>>,
    app_state: tauri::State<'_, crate::AppState>,
    id: String,
    quiet: Option<bool>,
) -> Result<crate::engine::TorrentPreview, String> {
    if !is_topic_id(&id) {
        return Err(ERROR_MAGNET_NOT_FOUND.to_owned());
    }
    let url = forum_url(&format!("viewtopic.php?t={id}"));
    let extractor = TORRENT_FILE_EXTRACTOR
        .replace("__ID__", &id)
        .replace("__FETCH_TIMEOUT_MS__", &TOPIC_FETCH_TIMEOUT.as_millis().to_string());
    let bytes = take_turn(&state, quiet.unwrap_or(false))
        .await?
        .request(&app, url, &extractor, false, !quiet.unwrap_or(false), |page| {
            if page.guest {
                return Some(Err(ERROR_AUTH_REQUIRED.to_owned()));
            }
            match serde_json::from_value::<TorrentFileLookup>(page.data) {
                Ok(lookup) if lookup.pending => None,
                Ok(TorrentFileLookup { data: Some(hex), .. }) => Some(decode_hex(&hex).ok_or_else(|| ERROR_TORRENT_FILE.to_owned())),
                Ok(TorrentFileLookup { error, .. }) => {
                    tracing::warn!("rutracker: the .torrent of {id} could not be had: {}", error.unwrap_or_default());
                    Some(Err(ERROR_TORRENT_FILE.to_owned()))
                }
                Err(_) => Some(Err(ERROR_TORRENT_FILE.to_owned())),
            }
        })
        .await?;
    app_state.engine.inspect_torrent_file(bytes::Bytes::from(bytes)).await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn rutracker_video_sizes(
    app: AppHandle,
    state: tauri::State<'_, Mutex<RutrackerState>>,
    ids: Vec<String>,
) -> Result<HashMap<String, VideoSize>, String> {
    let ids: Vec<String> = ids.into_iter().filter(|id| is_topic_id(id)).take(MAX_SIZE_LOOKUPS).collect();
    let Some(first) = ids.first() else {
        return Ok(HashMap::new());
    };
    let url = forum_url(&format!("viewtopic.php?t={first}"));
    let extractor = VIDEO_SIZES_EXTRACTOR
        .replace("__IDS__", &serde_json::to_string(&ids).map_err(|e| e.to_string())?)
        .replace("__PARALLEL__", &PARALLEL_TOPIC_FETCHES.to_string())
        .replace("__FETCH_TIMEOUT_MS__", &TOPIC_FETCH_TIMEOUT.as_millis().to_string());

    take_turn(&state, true)
        .await?
        .request(&app, url, &extractor, false, true, |page| {
            match serde_json::from_value::<VideoSizeLookup>(page.data) {
                Ok(lookup) if lookup.pending => None,
                Ok(lookup) => Some(Ok(lookup.sizes)),
                Err(_) => Some(Ok(HashMap::new())),
            }
        })
        .await
}

#[cfg(test)]
mod session_tests {
    use super::*;

    #[test]
    fn only_cloudflare_cookies_mean_no_session() {
        assert!(!has_forum_cookies([]));
        assert!(!has_forum_cookies(["cf_clearance", "__cf_bm"]));
        assert!(has_forum_cookies(["cf_clearance", "bb_session"]));
    }
}
