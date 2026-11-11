// RuTracker закрыт Cloudflare, который отсекает обычные HTTP-клиенты по TLS-отпечатку.
// Поэтому страницы форума загружает настоящий WebView в скрытом окне, а данные из DOM
// достаёт скрипт, результат которого возвращается в Rust через `eval_with_callback`.
// Окно показывается только когда нужен пользователь: для входа и проверки Cloudflare.

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
/// Настоящие запросы нумеруются с единицы; ноль отмечает ответы на опрос при парковке окна.
const PARKING_REQUEST_ID: u64 = 0;
const PARKING_PROBE_INTERVAL: Duration = Duration::from_millis(50);
const PARKING_TIMEOUT: Duration = Duration::from_secs(2);
/// Сколько ждать страницу, пока окно скрыто. Когда окно показано, ждём пользователя без ограничения.
const HIDDEN_PAGE_TIMEOUT: Duration = Duration::from_secs(30);
/// Как часто спрашивать страницу о её состоянии. Событие полной загрузки не годится:
/// оно ждёт всех картинок и рекламы, а разметка с результатами готова намного раньше.
const PROBE_INTERVAL: Duration = Duration::from_millis(400);
/// Проверка Cloudflare обычно проходит сама за пару секунд; окно показываем, только если она затянулась.
const CHALLENGE_GRACE: Duration = Duration::from_secs(6);
/// Помечает текущий документ устаревшим перед переходом, чтобы опрос не принял его за новую страницу.
const MARK_STALE_SCRIPT: &str = "window.__kinuzaStale = true;";
/// Одна страница выдачи трекера.
const MAX_SEARCH_RESULTS: usize = 50;
/// Сколько страниц раздач открывать за один запрос размеров кадра.
const MAX_SIZE_LOOKUPS: usize = 20;
/// Параметры `tracker.php`: сортировать по числу сидов (`o=10`) по убыванию (`s=2`).
const SEARCH_ORDER: &str = "o=10&s=2";
const MAGNET_PREFIX: &str = "magnet:?xt=urn:btih:";
/// Сколько страниц раздач запрашивать одновременно: больше — быстрее, но похоже на атаку на сайт.
const PARALLEL_TOPIC_FETCHES: usize = 4;
const TOPIC_FETCH_TIMEOUT: Duration = Duration::from_secs(8);

const ERROR_AUTH_REQUIRED: &str = "auth_required";
const ERROR_CANCELLED: &str = "cancelled";
const ERROR_TIMEOUT: &str = "timeout";
const ERROR_MAGNET_NOT_FOUND: &str = "magnet_not_found";
/// Ошибки поиска уходят в интерфейс кодами: текст для них пишется там, на языке пользователя.
const ERROR_PARSE_FAILED: &str = "tracker_parse_failed";
const ERROR_MARKUP_CHANGED: &str = "tracker_markup_changed";
/// За двоеточием следует заголовок страницы, которую открыл сайт.
const ERROR_UNEXPECTED_PAGE: &str = "tracker_unexpected_page";

/// Выполняется в странице форума и возвращает её состояние, либо `null`, пока страница не готова.
/// `__EXTRACT__` заменяется функцией, достающей из DOM данные конкретного запроса.
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
  const match = document.documentElement.innerHTML.match(/magnet:\?xt=urn:btih:[a-zA-Z0-9]+/);
  return match ? match[0] : null;
}"##;

/// Читает размер кадра со страниц раздач `__IDS__`. Открыта страница первой из них; остальные
/// страница запрашивает сама через `fetch`, по несколько за раз, и разбирает их HTML.
/// Работа асинхронная, а скрипт опроса обязан ответить сразу: первый вызов запускает её,
/// следующие возвращают `pending`, пока она не закончится.
const VIDEO_SIZES_EXTRACTOR: &str = r##"() => {
  const job = (window.__kinuzaVideoSizes ||= { started: false, done: false, sizes: {} });
  if (!job.started) {
    job.started = true;
    const ids = __IDS__;
    const sizeIn = (text) => {
      const anywhere = [text];
      // Размер из строки «Видео: …» надёжнее случайного «640x480» в описании.
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

/// Вход не требует данных со страницы: достаточно знать, гость на ней пользователь или нет.
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
    /// Строк в таблице результатов. Пустая выдача — это одна строка «Не найдено».
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

/// Размер кадра видео в пикселях.
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

/// То, что скрипт сообщил о загруженной странице.
#[derive(Deserialize)]
struct PageReport {
    /// Страница — проверка Cloudflare, а не форум.
    challenge: bool,
    /// Пользователь не вошёл в аккаунт.
    guest: bool,
    data: Value,
}

impl PageReport {
    /// Результат `eval_with_callback` — JSON-значение выражения, то есть строка с JSON внутри.
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
    /// Окно уничтожено: воркер нужно создать заново.
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

        // WebView2 не создаст окно в том же профиле, если аргументы браузера отличаются
        // от аргументов главного окна, поэтому берём их из конфига.
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

        // Скрытое окно не должно удерживать приложение запущенным после закрытия главного.
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

    /// Отбрасывает сигналы прошлого запроса. Возвращает `false`, если окно успели закрыть.
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

    /// Прячет окно и уводит его с форума, чтобы страница не работала в фоне.
    /// Дожидается, пока пустая страница действительно откроется: иначе этот переход
    /// отменяет переход следующего запроса, если тот приходит сразу следом.
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

    /// Опрашивает страницу и передаёт её состояние в `on_page`, пока тот не вернёт результат.
    /// Проверку Cloudflare в `on_page` не передаёт: ждёт, пока она пройдёт, и показывает окно, если затянулась.
    async fn drive<T>(
        &mut self,
        request_id: u64,
        script: &str,
        mut visible: bool,
        may_reveal: bool,
        mut on_page: impl FnMut(PageReport) -> Option<Result<T, String>>,
    ) -> Result<T, String> {
        let hidden_deadline = Instant::now() + HIDDEN_PAGE_TIMEOUT;
        let mut challenge_since: Option<Instant> = None;
        let mut probe_timer = tokio::time::interval(PROBE_INTERVAL);
        probe_timer.set_missed_tick_behavior(MissedTickBehavior::Delay);

        loop {
            tokio::select! {
                _ = probe_timer.tick() => {
                    if !visible && Instant::now() >= hidden_deadline {
                        // Страница могла зависнуть на полпути: следующий запрос начнёт с чистого окна.
                        let _ = self.window.destroy();
                        self.closed = true;
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

    /// Открывает `url` в окне-воркере и возвращает то, что `on_page` решит по загруженной странице.
    /// `visible` — показать окно сразу (вход), а не только при проверке Cloudflare.
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
    link.strip_prefix(MAGNET_PREFIX)
        .is_some_and(|hash| !hash.is_empty() && hash.chars().all(|c| c.is_ascii_alphanumeric()))
}

fn parse_search_page(data: Value) -> Result<Vec<RutrackerItem>, String> {
    let page: SearchPage =
        serde_json::from_value(data).map_err(|_| ERROR_PARSE_FAILED.to_owned())?;

    if !page.is_search_page {
        return Err(format!("{ERROR_UNEXPECTED_PAGE}:{}", page.title));
    }
    // Строки есть, а раздач в них не нашлось: разметка сайта изменилась, и это не «ничего не найдено».
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

    // Сайт уже сортирует выдачу по сидам; повторяем здесь, чтобы порядок не зависел от его параметров.
    items.sort_by(|a, b| b.seeds.cmp(&a.seeds));
    items.truncate(MAX_SEARCH_RESULTS);
    Ok(items)
}

/// Показывает страницу входа форума и ждёт, пока пользователь войдёт.
/// Сессия остаётся в профиле WebView, поэтому переживает перезапуск приложения.
#[tauri::command]
pub async fn rutracker_login_window(
    app: AppHandle,
    state: tauri::State<'_, Mutex<RutrackerState>>,
) -> Result<(), String> {
    state
        .lock()
        .await
        .request(&app, forum_url("login.php"), NO_EXTRACTOR, true, true, |page| (!page.guest).then_some(Ok(())))
        .await
}

#[tauri::command]
pub async fn rutracker_search(
    app: AppHandle,
    state: tauri::State<'_, Mutex<RutrackerState>>,
    query: String,
) -> Result<Vec<RutrackerItem>, String> {
    // Форум работает в windows-1251 и ждёт запрос в этой кодировке.
    let (encoded_query, _, _) = WINDOWS_1251.encode(&query);
    let url = forum_url(&format!(
        "tracker.php?nm={}&{SEARCH_ORDER}",
        percent_encode(&encoded_query, NON_ALPHANUMERIC)
    ));

    state
        .lock()
        .await
        .request(&app, url, SEARCH_EXTRACTOR, false, true, |page| {
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
    // Запрос, о котором пользователь не просил (проверка новых серий): окно форума не показывается,
    // даже если сайт требует проверку — такой запрос просто не удаётся.
    quiet: Option<bool>,
) -> Result<String, String> {
    if !is_topic_id(&id) {
        return Err(ERROR_MAGNET_NOT_FOUND.to_owned());
    }
    let url = forum_url(&format!("viewtopic.php?t={id}"));

    state
        .lock()
        .await
        .request(&app, url, MAGNET_EXTRACTOR, false, !quiet.unwrap_or(false), |page| {
            Some(match page.data.as_str() {
                Some(link) if is_magnet_link(link) => Ok(link.to_owned()),
                _ if page.guest => Err(ERROR_AUTH_REQUIRED.to_owned()),
                _ => Err(ERROR_MAGNET_NOT_FOUND.to_owned()),
            })
        })
        .await
}

/// Размер кадра раздач `ids`, прочитанный с их страниц. Раздач, где его найти не удалось, в ответе нет.
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

    state
        .lock()
        .await
        .request(&app, url, &extractor, false, true, |page| {
            match serde_json::from_value::<VideoSizeLookup>(page.data) {
                Ok(lookup) if lookup.pending => None,
                Ok(lookup) => Some(Ok(lookup.sizes)),
                // Страница не та, что ожидалась: размеры просто останутся неизвестными.
                Err(_) => Some(Ok(HashMap::new())),
            }
        })
        .await
}
