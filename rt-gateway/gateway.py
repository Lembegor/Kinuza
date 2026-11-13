import asyncio
import base64
import hmac
import itertools
import json
import logging
import os
import random
import sqlite3
import time
import urllib.parse
from dataclasses import dataclass, field

import httpx
from aiohttp import web
from playwright.async_api import async_playwright

HOST = os.environ.get("RT_HOST", "rutracker.org")
CDP = os.environ.get("RT_CDP", "http://127.0.0.1:9222")
KEY = os.environ.get("GATEWAY_KEY", "")
DATA = os.environ.get("GATEWAY_DATA", "/data")
PORT = int(os.environ.get("GATEWAY_PORT", "8090"))
TELEGRAM_TOKEN = os.environ.get("TELEGRAM_TOKEN", "")
TELEGRAM_CHAT = os.environ.get("TELEGRAM_CHAT", "")

PRIORITY = {"interactive": 0, "secondary": 1, "background": 2}
GAPS = {0: (1.0, 2.2), 1: (1.5, 3.0), 2: (8.0, 15.0)}
BUSY_GAP = (4.0, 7.0)
BACKGROUND_DAILY_LIMIT = 400
UNSEEN_DAILY_LIMIT = 150
BUSY_DAILY_LIMIT = 2500
QUEUE_LIMIT = 150
REQUEST_DEADLINE = 80
SEARCH_TTL = {"interactive": 3 * 3600, "secondary": 3 * 3600, "background": 24 * 3600}
EMPTY_SEARCH_TTL = 20 * 60
TORRENT_TTL = {"interactive": 2 * 3600, "secondary": 2 * 3600, "background": 6 * 3600}
TORRENT_KEEP = 3 * 86400
SIZE_TTL = 30 * 86400
SEEN_TTL = 120 * 86400
TORRENT_BYTES_LIMIT = 900 * 1024 * 1024
MAX_RESULTS = 50
LAST_PAGE = 9
MAX_SIZE_LOOKUPS = 20
NAVIGATION_TIMEOUT = 30
PAGE_TIMEOUT = 30
SIZES_TIMEOUT = 60
EVALUATE_TIMEOUT = 8
CHALLENGE_GRACE = 8
PROBE_INTERVAL = 0.4
RECHECK_EVERY = 120
DOWN_EXIT_AFTER = 3
WATCHDOG_EVERY = 20
SEARCH_ORDER = "o=10&s=2"
PAGE_MARK = "kinuza-gateway"

log = logging.getLogger("gateway")

PROBE = r"""(() => {
  if (location.hostname !== "__HOST__" || document.readyState === "loading") return null;
  const challenge = typeof window._cf_chl_opt !== "undefined"
    || document.querySelector("#challenge-form, #challenge-running, #challenge-error-text") !== null
    || /^(just a moment|один момент)/i.test(document.title);
  const guest = location.pathname.endsWith("/login.php")
    || document.querySelector('a[href*="profile.php?mode=register"]') !== null;
  let data = null;
  if (!challenge) {
    try { data = (__EXTRACT__)(); } catch (_) { data = null; }
  }
  return JSON.stringify({ challenge, guest, data, search: location.search });
})()"""

SEARCH_EXTRACTOR = r"""() => {
  const table = document.querySelector("#tor-tbl");
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
    hasTable: table !== null,
    rowCount: rows.length,
    items,
  };
}"""

TORRENT_EXTRACTOR = r"""() => {
  const job = (window.__gatewayTorrent__JOB__ ||= { started: false, done: false, data: null, error: null });
  if (!job.started) {
    job.started = true;
    (async () => {
      try {
        const response = await fetch("dl.php?t=__ID__", { credentials: "same-origin", signal: AbortSignal.timeout(20000) });
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!response.ok || bytes.length === 0 || bytes[0] !== 0x64) {
          job.error = "not_a_torrent:" + response.status;
          return;
        }
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        job.data = btoa(binary);
      } catch (error) {
        job.error = String(error);
      } finally {
        job.done = true;
      }
    })();
  }
  return job.done ? { pending: false, data: job.data, error: job.error } : { pending: true };
}"""

SIZES_EXTRACTOR = r"""() => {
  const job = (window.__gatewaySizes__JOB__ ||= { started: false, done: false, sizes: {} });
  if (!job.started) {
    job.started = true;
    const ids = __IDS__;
    const sizeIn = (text) => {
      const videoLines = [...text.matchAll(/Видео\s*:/gi)].map((match) => text.slice(match.index, match.index + 240));
      for (const scope of [...videoLines, text]) {
        for (const match of scope.matchAll(/(\d{3,4})\s?[xх×*]\s?(\d{3,4})/g)) {
          const width = Number(match[1]);
          const height = Number(match[2]);
          if (width >= 320 && width <= 8192 && height >= 200 && height <= 4320) return { width, height };
        }
      }
      return null;
    };
    const read = async (id) => {
      try {
        const response = await fetch(`viewtopic.php?t=${id}`, { credentials: "same-origin", signal: AbortSignal.timeout(10000) });
        if (!response.ok) return;
        const html = new TextDecoder("windows-1251").decode(await response.arrayBuffer());
        const post = new DOMParser().parseFromString(html, "text/html").querySelector(".post_body");
        if (!post) return;
        job.sizes[id] = sizeIn(post.textContent || "") || { width: 0, height: 0 };
      } catch (_) {}
    };
    const queue = [...ids];
    const drain = async () => {
      while (queue.length > 0) {
        await read(queue.shift());
        await new Promise((resolve) => setTimeout(resolve, 150 + Math.random() * 250));
      }
    };
    Promise.all([drain(), drain(), drain()]).then(() => { job.done = true; });
  }
  return job.done ? { pending: false, sizes: job.sizes } : { pending: true };
}"""

INDEX_EXTRACTOR = "() => true"


class GatewayError(Exception):
    def __init__(self, code: str, status: int = 503):
        super().__init__(code)
        self.code = code
        self.status = status


def topic_id(value: str) -> bool:
    return value.isdigit() and 0 < len(value) <= 12


def forum_url(page: str) -> str:
    return f"https://{HOST}/forum/{page}"


def normalized(query: str) -> str:
    return " ".join(query.lower().replace("ё", "е").split())


def kind_of(request: web.Request) -> str:
    kind = request.query.get("kind", "interactive")
    return kind if kind in PRIORITY else "interactive"


def store() -> sqlite3.Connection:
    os.makedirs(DATA, exist_ok=True)
    db = sqlite3.connect(os.path.join(DATA, "gateway.db"), isolation_level=None, check_same_thread=False)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=NORMAL")
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS searches(query TEXT NOT NULL, page INTEGER NOT NULL, items TEXT NOT NULL,
            fetched INTEGER NOT NULL, PRIMARY KEY(query, page)) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS torrents(id TEXT PRIMARY KEY, data BLOB NOT NULL, fetched INTEGER NOT NULL,
            used INTEGER NOT NULL) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS sizes(id TEXT PRIMARY KEY, width INTEGER NOT NULL, height INTEGER NOT NULL,
            fetched INTEGER NOT NULL) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS seen(id TEXT PRIMARY KEY, at INTEGER NOT NULL) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS stats(day TEXT NOT NULL, name TEXT NOT NULL, count INTEGER NOT NULL,
            PRIMARY KEY(day, name)) WITHOUT ROWID;
        """
    )
    return db


@dataclass(order=True)
class Job:
    priority: int
    order: int
    url: str = field(compare=False)
    timeout: float = field(compare=False)
    navigate: bool = field(compare=False)
    probe: bool = field(compare=False)
    extractor: str = field(compare=False)
    accept: object = field(compare=False)
    future: asyncio.Future = field(compare=False)


class Tracker:
    def __init__(self, db: sqlite3.Connection):
        self.db = db
        self.queue: asyncio.PriorityQueue[Job] = asyncio.PriorityQueue()
        self.counter = itertools.count()
        self.playwright = None
        self.browser = None
        self.page = None
        self.crashed = False
        self.last_request = 0.0
        self.state = "starting"
        self.state_since = time.time()
        self.last_ok = 0.0
        self.notified = False
        self.down_streak = 0
        self.inflight: dict[str, asyncio.Future] = {}

    def today(self, name: str) -> int:
        row = self.db.execute("SELECT count FROM stats WHERE day = ? AND name = ?", (time.strftime("%Y-%m-%d"), name)).fetchone()
        return row[0] if row else 0

    def count(self, name: str) -> None:
        self.db.execute("INSERT INTO stats(day, name, count) VALUES(?, ?, 1) "
                        "ON CONFLICT(day, name) DO UPDATE SET count = count + 1", (time.strftime("%Y-%m-%d"), name))

    def background_allowed(self) -> bool:
        return self.today("tracker_background") < BACKGROUND_DAILY_LIMIT

    def unavailable(self) -> GatewayError | None:
        if self.state == "login_required":
            return GatewayError("gateway_login")
        if self.state == "challenge":
            return GatewayError("gateway_challenge")
        return None

    async def once(self, key: str, make):
        running = self.inflight.get(key)
        if running is not None:
            return await asyncio.shield(running)
        task = asyncio.ensure_future(make())
        self.inflight[key] = task
        task.add_done_callback(lambda _: self.inflight.pop(key, None))
        return await asyncio.shield(task)

    async def set_state(self, state: str) -> None:
        if state == self.state:
            return
        log.info("tracker state %s -> %s", self.state, state)
        previous = self.state
        self.state = state
        self.state_since = time.time()
        self.count("state_" + state)
        if state == "ready":
            if self.notified:
                await notify("Kinuza: поиск RuTracker через сервер снова работает.")
            self.notified = False
        elif previous in ("ready", "starting") and state in ("login_required", "challenge"):
            self.notified = True
            await notify(
                "Kinuza: поиск RuTracker через сервер остановился - "
                + ("RuTracker просит войти в аккаунт." if state == "login_required" else "Cloudflare просит пройти проверку.")
                + " Открой «RuTracker на сервере.bat» в C:\\Projects\\kinuza-tools и пройди вход или проверку."
            )

    async def drop_page(self) -> None:
        page, self.page = self.page, None
        if page is not None:
            try:
                await page.close()
            except Exception:
                pass

    async def connect(self) -> None:
        if (self.page is not None and not self.crashed and not self.page.is_closed()
                and self.browser is not None and self.browser.is_connected()):
            return
        if self.playwright is None:
            self.playwright = await async_playwright().start()
        if self.browser is None or not self.browser.is_connected():
            self.browser = await self.playwright.chromium.connect_over_cdp(CDP, timeout=15000)
        context = self.browser.contexts[0] if self.browser.contexts else await self.browser.new_context()
        for page in list(context.pages):
            try:
                mark = await asyncio.wait_for(page.evaluate("window.name"), 3)
            except Exception:
                continue
            if mark == PAGE_MARK and page is not self.page:
                try:
                    await page.close()
                except Exception:
                    pass
        await self.drop_page()
        self.crashed = False
        self.page = await context.new_page()
        self.page.on("crash", lambda _: setattr(self, "crashed", True))
        await self.page.goto(forum_url("index.php"), wait_until="domcontentloaded", timeout=NAVIGATION_TIMEOUT * 1000)
        await self.page.evaluate(f"window.name = {json.dumps(PAGE_MARK)}")

    async def submit(self, priority: int, url: str, extractor: str, accept, timeout: float = PAGE_TIMEOUT,
                     navigate: bool = True, probe: bool = False) -> object:
        if not probe:
            blocked = self.unavailable()
            if blocked is not None:
                raise blocked
        if self.queue.qsize() >= QUEUE_LIMIT:
            raise GatewayError("gateway_busy")
        future = asyncio.get_running_loop().create_future()
        await self.queue.put(Job(priority, next(self.counter), url, timeout, navigate, probe, extractor, accept, future))
        try:
            return await asyncio.wait_for(asyncio.shield(future), REQUEST_DEADLINE)
        except asyncio.TimeoutError:
            future.cancel()
            raise GatewayError("gateway_busy")

    async def worker(self) -> None:
        while True:
            job = await self.queue.get()
            if job.future.done():
                continue
            span = GAPS[job.priority]
            if job.priority == 0 and self.today("tracker_request") >= BUSY_DAILY_LIMIT:
                span = BUSY_GAP
            wait = self.last_request + random.uniform(*span) - time.monotonic()
            if wait > 0:
                await self.queue.put(job)
                await asyncio.sleep(min(wait, 0.5))
                continue
            if not job.probe and self.unavailable() is not None:
                job.future.set_exception(self.unavailable())
                continue
            try:
                if job.priority == 2:
                    self.count("tracker_background")
                result = await self.open(job)
                if not job.future.done():
                    job.future.set_result(result)
            except Exception as error:
                if not job.future.done():
                    job.future.set_exception(error if isinstance(error, GatewayError) else GatewayError("gateway_failed", 502))
            finally:
                self.last_request = time.monotonic()

    async def browser_failed(self) -> GatewayError:
        await self.drop_page()
        self.browser = None
        self.down_streak += 1
        await self.set_state("browser_down")
        if self.down_streak >= DOWN_EXIT_AFTER:
            log.error("browser unreachable %d times in a row, restarting the gateway", self.down_streak)
            asyncio.get_running_loop().call_later(1, os._exit, 1)
        return GatewayError("gateway_down")

    async def open(self, job: Job) -> object:
        try:
            await self.connect()
        except Exception as error:
            log.warning("browser unavailable: %s", type(error).__name__)
            raise await self.browser_failed()
        self.down_streak = 0
        self.count("tracker_request")
        script = PROBE.replace("__HOST__", HOST).replace("__EXTRACT__", job.extractor)
        on_forum = urllib.parse.urlparse(self.page.url).hostname == HOST and self.state == "ready"
        expected = urllib.parse.urlparse(job.url).query
        if job.navigate or not on_forum:
            try:
                await self.page.goto(job.url, wait_until="domcontentloaded", timeout=NAVIGATION_TIMEOUT * 1000)
            except Exception as error:
                log.warning("page load failed: %s", type(error).__name__)
                if self.crashed or self.page.is_closed() or not self.browser.is_connected():
                    raise await self.browser_failed()
                await self.drop_page()
                raise GatewayError("gateway_timeout", 504)
        started = time.monotonic()
        challenged_at = None
        failures = 0
        while time.monotonic() - started < job.timeout:
            if self.crashed:
                raise await self.browser_failed()
            try:
                raw = await asyncio.wait_for(self.page.evaluate(script), EVALUATE_TIMEOUT)
                failures = 0
            except Exception:
                raw = None
                failures += 1
                if self.page.is_closed() or not self.browser.is_connected() or failures >= 3:
                    raise await self.browser_failed()
            report = json.loads(raw) if raw else None
            if report is not None:
                if report["challenge"]:
                    challenged_at = challenged_at or time.monotonic()
                    if time.monotonic() - challenged_at > CHALLENGE_GRACE:
                        await self.set_state("challenge")
                        raise GatewayError("gateway_challenge")
                elif report["guest"]:
                    await self.set_state("login_required")
                    raise GatewayError("gateway_login")
                elif job.navigate and expected and not same_query(report.get("search", ""), expected):
                    pass
                else:
                    outcome = job.accept(report["data"])
                    if outcome is not None:
                        self.last_ok = time.time()
                        await self.set_state("ready")
                        return outcome
            await asyncio.sleep(PROBE_INTERVAL)
        await self.drop_page()
        raise GatewayError("gateway_timeout", 504)

    async def recheck(self) -> None:
        await asyncio.sleep(5)
        while True:
            if self.state != "ready":
                try:
                    await self.submit(2, forum_url("index.php"), INDEX_EXTRACTOR, lambda data: True if data else None, probe=True)
                except GatewayError:
                    pass
            await asyncio.sleep(RECHECK_EVERY)


async def watchdog() -> None:
    misses = 0
    async with httpx.AsyncClient(timeout=5) as client:
        while True:
            await asyncio.sleep(WATCHDOG_EVERY)
            try:
                response = await client.get(f"{CDP}/json/version")
                misses = 0 if response.status_code == 200 else misses + 1
            except Exception:
                misses += 1
            if misses >= DOWN_EXIT_AFTER:
                log.error("browser debugging port unreachable %d times, restarting to rejoin the browser", misses)
                os._exit(1)


async def notify(text: str) -> None:
    log.info("notify: %s", text)
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT:
        return
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            await client.post(f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage",
                              json={"chat_id": TELEGRAM_CHAT, "text": text})
    except Exception as error:
        log.warning("telegram failed: %s", type(error).__name__)


def search_accept(data):
    if not isinstance(data, dict):
        return None
    if not data.get("isSearchPage"):
        raise GatewayError("tracker_unexpected_page", 502)
    if not data.get("hasTable"):
        return None
    items = [item for item in data.get("items") or [] if topic_id(str(item.get("id", "")))]
    if not items and (data.get("rowCount") or 0) > 1:
        raise GatewayError("tracker_markup_changed", 502)
    items.sort(key=lambda item: -int(item.get("seeds") or 0))
    return [{"id": str(item["id"]), "title": str(item.get("title") or ""), "size": str(item.get("size") or ""),
             "seeds": int(item.get("seeds") or 0)} for item in items[:MAX_RESULTS]]


def same_query(actual: str, expected: str) -> bool:
    def params(text: str) -> dict:
        found = {}
        for part in text.lstrip("?").split("&"):
            name, _, value = part.partition("=")
            found[name] = urllib.parse.unquote_to_bytes(value.replace("+", "%20"))
        return found
    want = params(expected)
    have = params(actual)
    return all(have.get(name) == value for name, value in want.items() if name in ("nm", "start", "t"))


def pending_accept(key: str):
    def accept(data):
        if not isinstance(data, dict) or data.get("pending"):
            return None
        return data.get(key) if key != "*" else data
    return accept


def cp1251(query: str) -> str:
    return urllib.parse.quote(query.encode("cp1251", errors="replace"), safe="")


def bdecode(data: bytes, i: int = 0):
    c = data[i:i + 1]
    if c == b"i":
        end = data.index(b"e", i)
        return int(data[i + 1:end]), end + 1
    if c in (b"l", b"d"):
        i += 1
        items = []
        while data[i:i + 1] != b"e":
            item, i = bdecode(data, i)
            items.append(item)
        if c == b"l":
            return items, i + 1
        return dict(zip(items[::2], items[1::2])), i + 1
    colon = data.index(b":", i)
    length = int(data[i:colon])
    return data[colon + 1:colon + 1 + length], colon + 1 + length


def strings(value):
    if isinstance(value, bytes):
        yield value
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)
    elif isinstance(value, dict):
        for key, item in value.items():
            yield key
            yield from strings(item)


def bencode_safe(data: bytes) -> bool:
    try:
        top, end = bdecode(data)
    except (ValueError, IndexError):
        return False
    if not isinstance(top, dict) or b"info" not in top or end != len(data):
        return False
    outside = [text.lower() for key, value in top.items() if key != b"info" for text in strings(value)]
    return not any(b"pk=" in text or b"passkey" in text or b"uk=" in text for text in outside)


def prune(db: sqlite3.Connection) -> None:
    now = int(time.time())
    db.execute("DELETE FROM torrents WHERE used < ?", (now - TORRENT_KEEP,))
    db.execute("DELETE FROM seen WHERE at < ?", (now - SEEN_TTL,))
    total = db.execute("SELECT COALESCE(SUM(LENGTH(data)), 0) FROM torrents").fetchone()[0]
    while total > TORRENT_BYTES_LIMIT:
        row = db.execute("SELECT id, LENGTH(data) FROM torrents ORDER BY used LIMIT 1").fetchone()
        if not row:
            break
        db.execute("DELETE FROM torrents WHERE id = ?", (row[0],))
        total -= row[1]


def remember_seen(db: sqlite3.Connection, items) -> None:
    now = int(time.time())
    db.executemany("INSERT INTO seen(id, at) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at",
                   [(item["id"], now) for item in items])


def allow_topic(tracker: Tracker, tid: str) -> None:
    if tracker.db.execute("SELECT 1 FROM seen WHERE id = ?", (tid,)).fetchone():
        return
    if tracker.today("unseen_topic") >= UNSEEN_DAILY_LIMIT:
        raise GatewayError("gateway_busy")
    tracker.count("unseen_topic")


def authorized(request: web.Request) -> bool:
    given = request.headers.get("X-Kinuza-Key", "").encode("utf-8", errors="replace")
    return bool(KEY) and hmac.compare_digest(given, KEY.encode())


@web.middleware
async def guard(request: web.Request, handler):
    if not authorized(request):
        return web.json_response({"error": "forbidden"}, status=403)
    try:
        return await handler(request)
    except GatewayError as error:
        return web.json_response({"error": error.code}, status=error.status)


def cached_search(row, kind: str, now: int, any_age: bool):
    if not row:
        return None
    items = json.loads(row[0])
    ttl = SEARCH_TTL[kind] if items else EMPTY_SEARCH_TTL
    if any_age or now - row[1] < ttl:
        return items
    return None


async def search(request: web.Request) -> web.Response:
    tracker: Tracker = request.app["tracker"]
    db = tracker.db
    query = request.query.get("q", "").strip()[:200]
    if not query:
        return web.json_response({"error": "empty_query"}, status=400)
    try:
        page = max(0, min(int(request.query.get("page", "0") or 0), LAST_PAGE))
    except ValueError:
        return web.json_response({"error": "bad_page"}, status=400)
    kind = kind_of(request)
    key = normalized(query)
    now = int(time.time())
    row = db.execute("SELECT items, fetched FROM searches WHERE query = ? AND page = ?", (key, page)).fetchone()
    fresh = cached_search(row, kind, now, request.query.get("cached") == "1")
    if fresh is not None or request.query.get("cached") == "1":
        tracker.count("search_cached")
        return web.json_response({"items": fresh or [], "fetchedAt": row[1] if row else 0, "cached": True})

    def stale(code: str) -> web.Response | None:
        if not row:
            return None
        return web.json_response({"items": json.loads(row[0]), "fetchedAt": row[1], "cached": True, "stale": code})

    if kind == "background" and not tracker.background_allowed():
        return stale("gateway_busy") or web.json_response({"error": "gateway_busy"}, status=503)
    start = page * MAX_RESULTS
    url = forum_url(f"tracker.php?nm={cp1251(query)}&{SEARCH_ORDER}" + (f"&start={start}" if start else ""))

    async def fetch():
        again = db.execute("SELECT items, fetched FROM searches WHERE query = ? AND page = ?", (key, page)).fetchone()
        recent = cached_search(again, kind, int(time.time()), False)
        if recent is not None:
            return recent
        found = await tracker.submit(PRIORITY[kind], url, SEARCH_EXTRACTOR, search_accept)
        db.execute("INSERT INTO searches(query, page, items, fetched) VALUES(?, ?, ?, ?) ON CONFLICT(query, page) "
                   "DO UPDATE SET items = excluded.items, fetched = excluded.fetched",
                   (key, page, json.dumps(found, ensure_ascii=False), int(time.time())))
        remember_seen(db, found)
        tracker.count("search_" + kind)
        return found

    try:
        items = await tracker.once(f"search:{page}:{key}", fetch)
    except GatewayError as error:
        fallback = stale(error.code)
        if fallback is not None:
            return fallback
        raise
    return web.json_response({"items": items, "fetchedAt": now, "cached": False})


async def torrent(request: web.Request) -> web.Response:
    tracker: Tracker = request.app["tracker"]
    db = tracker.db
    tid = request.query.get("id", "")
    if not topic_id(tid):
        return web.json_response({"error": "bad_id"}, status=400)
    kind = kind_of(request)
    try:
        max_age = max(1800, min(int(request.query.get("maxAge", TORRENT_TTL[kind])), TORRENT_KEEP))
    except ValueError:
        max_age = TORRENT_TTL[kind]
    now = int(time.time())
    row = db.execute("SELECT data, fetched FROM torrents WHERE id = ?", (tid,)).fetchone()

    def cached() -> web.Response:
        db.execute("UPDATE torrents SET used = ? WHERE id = ?", (int(time.time()), tid))
        return web.Response(body=row[0], content_type="application/x-bittorrent")

    if row and now - row[1] < max_age:
        tracker.count("torrent_cached")
        return cached()
    if row and (tracker.unavailable() is not None or (kind == "background" and not tracker.background_allowed())):
        return cached()
    if kind == "background" and not tracker.background_allowed():
        raise GatewayError("gateway_busy")
    allow_topic(tracker, tid)

    async def fetch():
        extractor = TORRENT_EXTRACTOR.replace("__ID__", tid).replace("__JOB__", str(next(tracker.counter)))
        result = await tracker.submit(PRIORITY[kind], forum_url(f"viewtopic.php?t={tid}"), extractor, pending_accept("*"),
                                      navigate=False)
        if not result.get("data"):
            log.warning("torrent %s unavailable: %s", tid, str(result.get("error"))[:80])
            raise GatewayError("torrent_file_unavailable", 502)
        fetched = base64.b64decode(result["data"])
        if not bencode_safe(fetched):
            log.warning("torrent %s refused: unexpected content", tid)
            raise GatewayError("torrent_file_unavailable", 502)
        stamp = int(time.time())
        db.execute("INSERT INTO torrents(id, data, fetched, used) VALUES(?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET "
                   "data = excluded.data, fetched = excluded.fetched, used = excluded.used", (tid, fetched, stamp, stamp))
        prune(db)
        tracker.count("torrent_fetched")
        return fetched

    try:
        data = await tracker.once(f"torrent:{tid}", fetch)
    except GatewayError:
        if row:
            return cached()
        raise
    return web.Response(body=data, content_type="application/x-bittorrent")


async def sizes(request: web.Request) -> web.Response:
    tracker: Tracker = request.app["tracker"]
    db = tracker.db
    raw = request.query.get("ids", "")[:400]
    ids = [value for value in dict.fromkeys(raw.split(",")) if topic_id(value)][:MAX_SIZE_LOOKUPS]
    kind = kind_of(request)
    now = int(time.time())
    known = {}
    missing = []
    for tid in ids:
        row = db.execute("SELECT width, height, fetched FROM sizes WHERE id = ?", (tid,)).fetchone()
        if row and now - row[2] < SIZE_TTL:
            known[tid] = (row[0], row[1])
        elif db.execute("SELECT 1 FROM seen WHERE id = ?", (tid,)).fetchone():
            missing.append(tid)
    blocked = tracker.unavailable() is not None or (kind == "background" and not tracker.background_allowed())
    if missing and not blocked:
        extractor = SIZES_EXTRACTOR.replace("__IDS__", json.dumps(missing)).replace("__JOB__", str(next(tracker.counter)))
        priority = max(PRIORITY[kind], PRIORITY["secondary"])
        try:
            found = await tracker.once(
                "sizes:" + ",".join(missing),
                lambda: tracker.submit(priority, forum_url(f"viewtopic.php?t={missing[0]}"), extractor,
                                       pending_accept("sizes"), SIZES_TIMEOUT, navigate=False),
            ) or {}
        except GatewayError:
            found = {}
        stamp = int(time.time())
        for tid, size in found.items():
            if tid in missing and isinstance(size, dict):
                width, height = int(size.get("width") or 0), int(size.get("height") or 0)
                db.execute("INSERT INTO sizes(id, width, height, fetched) VALUES(?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET "
                           "width = excluded.width, height = excluded.height, fetched = excluded.fetched", (tid, width, height, stamp))
                known[tid] = (width, height)
        tracker.count("sizes_fetched")
    return web.json_response({tid: {"width": w, "height": h} for tid, (w, h) in known.items() if w and h})


async def status(request: web.Request) -> web.Response:
    tracker: Tracker = request.app["tracker"]
    return web.json_response({"state": tracker.state, "since": int(tracker.state_since), "lastOk": int(tracker.last_ok),
                              "queue": tracker.queue.qsize()})


async def start(app: web.Application) -> None:
    tracker: Tracker = app["tracker"]
    prune(tracker.db)
    app["tasks"] = [asyncio.create_task(tracker.worker()), asyncio.create_task(tracker.recheck()), asyncio.create_task(watchdog())]


def main() -> None:
    logging.basicConfig(level=os.environ.get("GATEWAY_LOG", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("aiohttp.access").setLevel(logging.WARNING)
    if not KEY:
        raise SystemExit("GATEWAY_KEY is not set")
    app = web.Application(middlewares=[guard], client_max_size=64 * 1024)
    app["tracker"] = Tracker(store())
    app.router.add_get("/search", search)
    app.router.add_get("/torrent", torrent)
    app.router.add_get("/sizes", sizes)
    app.router.add_get("/status", status)
    app.on_startup.append(start)
    web.run_app(app, host="0.0.0.0", port=PORT, access_log=None)


if __name__ == "__main__":
    main()
