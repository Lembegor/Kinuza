import asyncio
import base64
import datetime as dt
import gzip
import hashlib
import json
import logging
import math
import os
import random
import signal
import sqlite3
import time
import unicodedata
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

DATA = Path(os.environ.get("CATALOG_DATA", "/data"))
PUBLIC = Path(os.environ.get("CATALOG_PUBLIC", "/public")) / "catalog"
TMDB_KEY = os.environ.get("TMDB_API_KEY", "")
TMDB_RATE = float(os.environ.get("TMDB_RATE", "20"))
WORKERS = int(os.environ.get("TMDB_WORKERS", "8"))
TIMEZONE = ZoneInfo(os.environ.get("CATALOG_TZ", "Europe/Kyiv"))
RUN_HOURS = [int(hour) for hour in os.environ.get("CATALOG_HOURS", "0,12").split(",")]
LIMIT = int(os.environ.get("CATALOG_LIMIT", "0"))
ONCE = os.environ.get("CATALOG_ONCE") == "1"
LOAD_PUBLISH_EVERY = int(os.environ.get("CATALOG_LOAD_PUBLISH_SECONDS", str(3 * 3600)))
REFRESH_PER_RUN = int(os.environ.get("CATALOG_REFRESH_PER_RUN", "12000"))
DELTA_DAYS = 45
FIRST_PUBLISH_AFTER = 1800
FORMAT = 1

TMDB = "https://api.themoviedb.org/3"
EXPORTS = "https://files.tmdb.org/p/exports"
WIKIDATA = "https://query.wikidata.org/sparql"
SHIKIMORI = "https://shikimori.io/api/animes"
USER_AGENT = "Kinuza catalog (https://github.com/Lembegor/Kinuza)"
KINDS = {"m": "movie", "t": "tv"}
EXPORT_NAMES = {"m": "movie_ids", "t": "tv_series_ids"}
LANGUAGES = ["ru", "uk", "en"]
NAME_LIMIT = 8
READABLE_SCRIPTS = {"LATIN", "CYRILLIC"}
ANIME_EVERY = 7 * 86400
FAILED = -1_000_000

log = logging.getLogger("catalog")
stopping = asyncio.Event()


def now() -> int:
    return int(time.time())


def connect() -> sqlite3.Connection:
    DATA.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DATA / "catalog.db", isolation_level=None)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=NORMAL")
    db.execute("PRAGMA cache_size=-16000")
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS titles(
            kind TEXT NOT NULL, id INTEGER NOT NULL, base TEXT NOT NULL, record TEXT NOT NULL,
            hash TEXT NOT NULL, seq INTEGER NOT NULL, fetched INTEGER NOT NULL, votes INTEGER NOT NULL,
            PRIMARY KEY(kind, id)) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS titles_seq ON titles(seq);
        CREATE INDEX IF NOT EXISTS titles_fetched ON titles(fetched) WHERE votes > 0;
        CREATE TABLE IF NOT EXISTS queue(
            kind TEXT NOT NULL, id INTEGER NOT NULL, priority REAL NOT NULL,
            PRIMARY KEY(kind, id)) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS queue_priority ON queue(priority DESC);
        CREATE TABLE IF NOT EXISTS removed(
            kind TEXT NOT NULL, id INTEGER NOT NULL, seq INTEGER NOT NULL,
            PRIMARY KEY(kind, id)) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS removed_seq ON removed(seq);
        CREATE TABLE IF NOT EXISTS anime(
            kind TEXT NOT NULL, id INTEGER NOT NULL, mal INTEGER NOT NULL,
            PRIMARY KEY(kind, id)) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS shikimori(
            mal INTEGER PRIMARY KEY, russian TEXT NOT NULL, name TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS publishes(
            version INTEGER PRIMARY KEY, created INTEGER NOT NULL, seq INTEGER NOT NULL,
            delta TEXT, delta_sha TEXT, delta_size INTEGER, delta_count INTEGER);
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        """
    )
    return db


def meta_get(db: sqlite3.Connection, key: str, default: str = "") -> str:
    row = db.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row[0] if row else default


def meta_set(db: sqlite3.Connection, key: str, value) -> None:
    db.execute("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, str(value)))


def next_seq(db: sqlite3.Connection) -> int:
    value = int(meta_get(db, "seq", "0")) + 1
    meta_set(db, "seq", value)
    return value


class RateLimiter:
    def __init__(self, rate: float):
        self.interval = 1.0 / rate
        self.next = time.monotonic()
        self.lock = asyncio.Lock()

    async def wait(self) -> None:
        async with self.lock:
            moment = time.monotonic()
            if self.next > moment:
                await asyncio.sleep(self.next - moment)
            self.next = max(self.next, moment) + self.interval

    def pause(self, seconds: float) -> None:
        self.next = max(self.next, time.monotonic() + seconds)


class Gone(Exception):
    pass


async def get_json(client: httpx.AsyncClient, limiter: RateLimiter, url: str, params: dict, attempts: int = 6):
    delay = 2.0
    for attempt in range(attempts):
        await limiter.wait()
        try:
            response = await client.get(url, params=params)
        except (httpx.TransportError, httpx.TimeoutException) as error:
            if attempt == attempts - 1:
                raise
            log.debug("network error %s, retrying", error)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 120)
            continue
        if response.status_code == 404:
            raise Gone()
        if response.status_code == 429:
            wait = float(response.headers.get("Retry-After", "10") or 10)
            limiter.pause(wait)
            log.warning("rate limited by %s, pausing %.0fs", httpx.URL(url).host, wait)
            continue
        if response.status_code >= 500 and attempt < attempts - 1:
            await asyncio.sleep(delay)
            delay = min(delay * 2, 120)
            continue
        if response.status_code >= 400:
            raise RuntimeError(f"HTTP {response.status_code} from {httpx.URL(url).host}{httpx.URL(url).path}")
        return response.json()
    raise RuntimeError(f"giving up on {httpx.URL(url).host}{httpx.URL(url).path}")


def by_votes(poster: dict):
    return (-(poster.get("vote_average") or 0), -(poster.get("vote_count") or 0))


def preferred_poster(fallback, posters, language):
    posters = [poster for poster in posters or [] if isinstance(poster.get("file_path"), str)]
    local = sorted((poster for poster in posters if poster.get("iso_639_1") == language), key=by_votes)
    if any(poster["file_path"] == fallback for poster in local):
        return fallback
    if local:
        return local[0]["file_path"]
    textless = sorted((poster for poster in posters if poster.get("iso_639_1") is None), key=by_votes)
    return textless[0]["file_path"] if textless else fallback


def popularity_step(value) -> float:
    value = max(float(value or 0), 0.0)
    return round(2 ** (round(math.log2(value + 1) * 2) / 2) - 1, 1)


def clean(text) -> str:
    return " ".join(str(text or "").split())


def comparable(text: str) -> str:
    return "".join(ch for ch in unicodedata.normalize("NFKC", text).lower() if ch.isalnum())


def scripts(text: str) -> set[str]:
    found = set()
    for ch in text:
        if ch.isalpha():
            name = unicodedata.name(ch, "")
            found.add(name.split(" ")[0] if name else "?")
    return found


def readable_name(name: str, allowed: set[str]) -> bool:
    used = scripts(name)
    return bool(used) and used <= allowed


def translated_title(raw: dict, kind: str, language: str) -> str:
    field = "title" if kind == "m" else "name"
    best = ""
    for item in (raw.get("translations") or {}).get("translations") or []:
        if item.get("iso_639_1") != language:
            continue
        title = clean((item.get("data") or {}).get(field))
        if not title:
            continue
        preferred = {"ru": "RU", "uk": "UA", "en": "US"}.get(language)
        if item.get("iso_3166_1") == preferred:
            return title
        best = best or title
    return best


def build_base(kind: str, raw: dict) -> dict:
    original = clean(raw.get("original_title") if kind == "m" else raw.get("original_name"))
    english = clean(raw.get("title") if kind == "m" else raw.get("name"))
    date = (raw.get("release_date") if kind == "m" else raw.get("first_air_date")) or ""
    titles = {}
    for language in LANGUAGES:
        title = translated_title(raw, kind, language)
        if language == "en" and not title:
            title = english
        if not title and raw.get("original_language") == language:
            title = original
        if title and title != original:
            titles[language] = title

    default_poster = raw.get("poster_path")
    posters = (raw.get("images") or {}).get("posters")
    images = {"": default_poster} if default_poster else {}
    for language in LANGUAGES:
        chosen = preferred_poster(default_poster, posters, language)
        if chosen and chosen != default_poster:
            images[language] = chosen

    known = {comparable(name) for name in [original, *titles.values()] if name}
    allowed = READABLE_SCRIPTS | scripts(original)
    alternatives = (raw.get("alternative_titles") or {}).get("titles" if kind == "m" else "results") or []
    names = []
    for item in alternatives:
        name = clean(item.get("title"))
        key = comparable(name)
        if name and key and key not in known and readable_name(name, allowed):
            known.add(key)
            names.append(name)
        if len(names) >= NAME_LIMIT:
            break

    base = {
        "k": kind,
        "id": raw["id"],
        "o": original,
        "l": raw.get("original_language") or "",
        "y": int(date[:4]) if date[:4].isdigit() else 0,
        "v": round(float(raw.get("vote_average") or 0), 1) if (raw.get("vote_count") or 0) > 0 else 0,
        "c": int(raw.get("vote_count") or 0),
        "p": popularity_step(raw.get("popularity")),
        "g": [genre["id"] for genre in raw.get("genres") or [] if isinstance(genre.get("id"), int)],
    }
    if titles:
        base["t"] = titles
    if images:
        base["i"] = images
    if raw.get("backdrop_path"):
        base["b"] = raw["backdrop_path"]
    if names:
        base["n"] = names
    if raw.get("adult"):
        base["a"] = 1
    imdb = ((raw.get("external_ids") or {}).get("imdb_id") or raw.get("imdb_id") or "").strip()
    if imdb:
        base["imdb"] = imdb
    return base


def has_cyrillic(text: str) -> bool:
    return any("Ѐ" <= ch <= "ӿ" for ch in text)


def build_record(db: sqlite3.Connection, base: dict) -> dict:
    record = dict(base)
    row = db.execute(
        "SELECT a.mal, s.russian, s.name FROM anime a LEFT JOIN shikimori s ON s.mal = a.mal WHERE a.kind = ? AND a.id = ?",
        (base["k"], base["id"]),
    ).fetchone()
    if row:
        mal, russian, name = row
        record["mal"] = mal
        if russian and has_cyrillic(russian):
            record["s"] = clean(russian)
        if name:
            known = {comparable(text) for text in [record["o"], *(record.get("t") or {}).values(), *(record.get("n") or [])]}
            if comparable(name) not in known:
                record["n"] = [*(record.get("n") or []), clean(name)]
    return record


def encode(record: dict) -> str:
    return json.dumps(record, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def store(db: sqlite3.Connection, base: dict, fetched: int | None = None) -> bool:
    fetched = now() if fetched is None else fetched
    record = encode(build_record(db, base))
    digest = hashlib.sha1(record.encode()).hexdigest()
    row = db.execute("SELECT hash FROM titles WHERE kind = ? AND id = ?", (base["k"], base["id"])).fetchone()
    changed = not row or row[0] != digest
    if changed:
        seq = next_seq(db)
        db.execute(
            "INSERT INTO titles(kind, id, base, record, hash, seq, fetched, votes) VALUES(?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(kind, id) DO UPDATE SET base = excluded.base, record = excluded.record, hash = excluded.hash, "
            "seq = excluded.seq, fetched = excluded.fetched, votes = excluded.votes",
            (base["k"], base["id"], encode(base), record, digest, seq, fetched, base["c"]),
        )
        db.execute("DELETE FROM removed WHERE kind = ? AND id = ?", (base["k"], base["id"]))
    else:
        db.execute(
            "UPDATE titles SET base = ?, fetched = ?, votes = ? WHERE kind = ? AND id = ?",
            (encode(base), fetched, base["c"], base["k"], base["id"]),
        )
    return changed


def remove(db: sqlite3.Connection, kind: str, id_: int) -> None:
    if db.execute("DELETE FROM titles WHERE kind = ? AND id = ?", (kind, id_)).rowcount:
        db.execute(
            "INSERT INTO removed(kind, id, seq) VALUES(?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq",
            (kind, id_, next_seq(db)),
        )


def rebuild(db: sqlite3.Connection, keys) -> int:
    changed = 0
    db.execute("BEGIN")
    for kind, id_ in keys:
        row = db.execute("SELECT base, fetched FROM titles WHERE kind = ? AND id = ?", (kind, id_)).fetchone()
        if row and store(db, json.loads(row[0]), row[1]):
            changed += 1
    db.execute("COMMIT")
    return changed


async def sync_exports(db: sqlite3.Connection, client: httpx.AsyncClient) -> None:
    today = dt.datetime.now(dt.timezone.utc).date()
    for back in range(0, 4):
        day = today - dt.timedelta(days=back)
        stamp = day.strftime("%m_%d_%Y")
        if meta_get(db, "export_day") >= day.isoformat():
            return
        urls = {kind: f"{EXPORTS}/{name}_{stamp}.json.gz" for kind, name in EXPORT_NAMES.items()}
        try:
            for kind, url in urls.items():
                head = await client.head(url)
                if head.status_code != 200:
                    raise FileNotFoundError(url)
        except (FileNotFoundError, httpx.HTTPError):
            continue
        for kind, url in urls.items():
            await import_export(db, client, kind, url)
        meta_set(db, "export_day", day.isoformat())
        return
    log.warning("no TMDB export found for the last days")


async def import_export(db: sqlite3.Connection, client: httpx.AsyncClient, kind: str, url: str) -> None:
    started = time.monotonic()
    path = DATA / f"export_{kind}.json.gz"
    async with client.stream("GET", url, timeout=600) as response:
        response.raise_for_status()
        with open(path, "wb") as file:
            async for chunk in response.aiter_bytes(1 << 16):
                file.write(chunk)

    db.execute("DROP TABLE IF EXISTS export")
    db.execute("CREATE TEMP TABLE export(id INTEGER PRIMARY KEY, popularity REAL NOT NULL)")
    db.execute("BEGIN")
    count = 0
    with gzip.open(path, "rt", encoding="utf-8") as lines:
        batch = []
        for line in lines:
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            if item.get("video"):
                continue
            batch.append((int(item["id"]), float(item.get("popularity") or 0)))
            if len(batch) >= 5000:
                db.executemany("INSERT OR REPLACE INTO export(id, popularity) VALUES(?, ?)", batch)
                count += len(batch)
                batch.clear()
        db.executemany("INSERT OR REPLACE INTO export(id, popularity) VALUES(?, ?)", batch)
        count += len(batch)
    path.unlink(missing_ok=True)

    if count < 1000:
        db.execute("ROLLBACK")
        log.warning("TMDB export %s looks broken (%d ids), skipped", url, count)
        return

    if LIMIT:
        db.execute("DELETE FROM export WHERE id NOT IN (SELECT id FROM export ORDER BY popularity DESC LIMIT ?)", (LIMIT,))

    added = db.execute(
        "INSERT INTO queue(kind, id, priority) SELECT ?, e.id, e.popularity FROM export e "
        "WHERE NOT EXISTS (SELECT 1 FROM titles t WHERE t.kind = ? AND t.id = e.id) "
        "ON CONFLICT(kind, id) DO NOTHING",
        (kind, kind),
    ).rowcount
    missing = 0
    if not LIMIT:
        missing = db.execute(
            "INSERT INTO queue(kind, id, priority) SELECT t.kind, t.id, 1000000 FROM titles t "
            "WHERE t.kind = ? AND NOT EXISTS (SELECT 1 FROM export e WHERE e.id = t.id) "
            "ON CONFLICT(kind, id) DO NOTHING",
            (kind,),
        ).rowcount
    db.execute("COMMIT")
    db.execute("DROP TABLE export")
    log.info("export %s: %d ids, %d new queued, %d gone from export rechecked, %.0fs",
             KINDS[kind], count, added, missing, time.monotonic() - started)


async def sync_changes(db: sqlite3.Connection, client: httpx.AsyncClient, limiter: RateLimiter) -> None:
    end = dt.datetime.now(dt.timezone.utc).date()
    last = meta_get(db, "changes_day")
    if not last:
        meta_set(db, "changes_day", end.isoformat())
        return
    start = max(dt.date.fromisoformat(last) - dt.timedelta(days=1), end - dt.timedelta(days=13))
    for kind, name in KINDS.items():
        page, pages, found = 1, 1, 0
        db.execute("BEGIN")
        while page <= pages and page <= 500:
            data = await get_json(client, limiter, f"{TMDB}/{name}/changes",
                                  {"api_key": TMDB_KEY, "start_date": start.isoformat(), "end_date": end.isoformat(), "page": page})
            pages = int(data.get("total_pages") or 1)
            rows = [(kind, int(item["id"])) for item in data.get("results") or [] if isinstance(item.get("id"), int)]
            if LIMIT:
                rows = [row for row in rows if db.execute("SELECT 1 FROM titles WHERE kind = ? AND id = ?", row).fetchone()]
            db.executemany("INSERT INTO queue(kind, id, priority) VALUES(?, ?, 500000) "
                           "ON CONFLICT(kind, id) DO UPDATE SET priority = MAX(priority, 500000)", rows)
            found += len(rows)
            page += 1
        db.execute("COMMIT")
        log.info("changes %s since %s: %d queued", name, start, found)
    meta_set(db, "changes_day", end.isoformat())


def queue_refresh(db: sqlite3.Connection) -> None:
    if REFRESH_PER_RUN <= 0:
        return
    queued = db.execute(
        "INSERT INTO queue(kind, id, priority) SELECT kind, id, 1 FROM titles WHERE votes > 0 "
        "ORDER BY fetched LIMIT ? ON CONFLICT(kind, id) DO NOTHING",
        (REFRESH_PER_RUN,),
    ).rowcount
    log.info("refresh: %d oldest titles with votes queued", queued)


async def process_queue(db: sqlite3.Connection, client: httpx.AsyncClient, limiter: RateLimiter, publish_during: bool) -> None:
    total = db.execute("SELECT COUNT(*) FROM queue").fetchone()[0]
    if not total:
        return
    log.info("queue: %d titles to fetch", total)
    started = time.monotonic()
    published = db.execute("SELECT 1 FROM publishes LIMIT 1").fetchone() is not None
    last_publish = time.monotonic() - (0 if published else max(LOAD_PUBLISH_EVERY - FIRST_PUBLISH_AFTER, 0))
    done = changed = gone = failed = 0
    results: asyncio.Queue = asyncio.Queue(maxsize=WORKERS * 8)
    jobs: asyncio.Queue = asyncio.Queue(maxsize=WORKERS * 4)

    async def feeder():
        while not stopping.is_set():
            rows = db.execute("SELECT kind, id FROM queue WHERE priority > ? ORDER BY priority DESC LIMIT 2000", (FAILED,)).fetchall()
            if not rows:
                break
            for row in rows:
                if stopping.is_set():
                    break
                await jobs.put(row)
            await jobs.join()
            await results.join()
        for _ in range(WORKERS):
            await jobs.put(None)

    async def worker():
        while True:
            job = await jobs.get()
            if job is None:
                jobs.task_done()
                return
            kind, id_ = job
            try:
                raw = await get_json(client, limiter, f"{TMDB}/{KINDS[kind]}/{id_}", {
                    "api_key": TMDB_KEY,
                    "append_to_response": "translations,images,alternative_titles,external_ids",
                    "include_image_language": "ru,uk,en,null",
                })
                await results.put(("ok", kind, id_, build_base(kind, raw)))
            except Gone:
                await results.put(("gone", kind, id_, None))
            except Exception as error:
                log.debug("fetch %s %s failed: %s", kind, id_, error)
                await results.put(("fail", kind, id_, None))
            finally:
                jobs.task_done()

    async def writer():
        nonlocal done, changed, gone, failed, last_publish
        pending = 0
        db.execute("BEGIN")
        while True:
            item = await results.get()
            if item is None:
                results.task_done()
                break
            status, kind, id_, base = item
            if status == "ok":
                changed += store(db, base)
                db.execute("DELETE FROM queue WHERE kind = ? AND id = ?", (kind, id_))
            elif status == "gone":
                remove(db, kind, id_)
                gone += 1
                db.execute("DELETE FROM queue WHERE kind = ? AND id = ?", (kind, id_))
            else:
                failed += 1
                db.execute("UPDATE queue SET priority = ? WHERE kind = ? AND id = ?", (FAILED - 1, kind, id_))
            done += 1
            pending += 1
            if pending >= 500:
                db.execute("COMMIT")
                db.execute("BEGIN")
                pending = 0
            if done % 10000 == 0:
                rate = done / max(time.monotonic() - started, 1)
                left = db.execute("SELECT COUNT(*) FROM queue").fetchone()[0]
                log.info("fetched %d (%d changed, %d gone, %d failed), %.1f/s, %d left, about %.1fh",
                         done, changed, gone, failed, rate, left, left / max(rate, 0.1) / 3600)
                write_status(db, "loading")
            if publish_during and time.monotonic() - last_publish >= LOAD_PUBLISH_EVERY:
                db.execute("COMMIT")
                publish(db)
                db.execute("BEGIN")
                last_publish = time.monotonic()
            results.task_done()
        db.execute("COMMIT")

    writer_task = asyncio.create_task(writer())
    workers = [asyncio.create_task(worker()) for _ in range(WORKERS)]
    await feeder()
    await asyncio.gather(*workers)
    await results.put(None)
    await writer_task
    log.info("queue done: %d fetched, %d changed, %d gone, %d failed in %.0fs",
             done, changed, gone, failed, time.monotonic() - started)


async def sync_anime(db: sqlite3.Connection, client: httpx.AsyncClient, force: bool = False) -> None:
    if not force and now() - int(meta_get(db, "anime_at", "0")) < ANIME_EVERY:
        return
    started = time.monotonic()
    query = """
        SELECT ?mal ?movie ?tv WHERE {
          ?item wdt:P4086 ?mal .
          OPTIONAL { ?item wdt:P4947 ?movie }
          OPTIONAL { ?item wdt:P4983 ?tv }
          FILTER(BOUND(?movie) || BOUND(?tv))
        }"""
    response = await client.get(WIKIDATA, params={"query": query, "format": "json"},
                                headers={"Accept": "application/sparql-results+json"}, timeout=120)
    response.raise_for_status()
    links: dict[tuple[str, int], int] = {}
    for row in response.json()["results"]["bindings"]:
        try:
            mal = int(row["mal"]["value"])
        except (KeyError, ValueError):
            continue
        for kind, field in (("m", "movie"), ("t", "tv")):
            value = row.get(field, {}).get("value", "")
            if value.isdigit():
                key = (kind, int(value))
                links[key] = min(links.get(key, mal), mal)
    if len(links) < 1000:
        log.warning("Wikidata returned only %d anime links, keeping the old ones", len(links))
        return

    before = {(kind, id_): mal for kind, id_, mal in db.execute("SELECT kind, id, mal FROM anime")}
    db.execute("BEGIN")
    db.execute("DELETE FROM anime")
    db.executemany("INSERT INTO anime(kind, id, mal) VALUES(?, ?, ?)", [(k, i, m) for (k, i), m in links.items()])
    db.execute("COMMIT")

    limiter = RateLimiter(1.3)
    mals = sorted(set(links.values()))
    if LIMIT:
        present = {(kind, id_) for kind, id_ in db.execute("SELECT kind, id FROM titles")}
        mals = sorted({mal for key, mal in links.items() if key in present})
    names_before = {mal: (russian, name) for mal, russian, name in db.execute("SELECT mal, russian, name FROM shikimori")}
    fetched: dict[int, tuple[str, str]] = {}
    for offset in range(0, len(mals), 50):
        if stopping.is_set():
            return
        chunk = mals[offset:offset + 50]
        try:
            rows = await get_json(client, limiter, SHIKIMORI,
                                  {"ids": ",".join(map(str, chunk)), "limit": 50, "censored": "false"})
        except Exception as error:
            log.warning("Shikimori batch failed: %s", error)
            continue
        for row in rows or []:
            if isinstance(row.get("id"), int):
                fetched[row["id"]] = (clean(row.get("russian")), clean(row.get("name")))
    db.execute("BEGIN")
    db.executemany("INSERT INTO shikimori(mal, russian, name) VALUES(?, ?, ?) ON CONFLICT(mal) DO UPDATE "
                   "SET russian = excluded.russian, name = excluded.name",
                   [(mal, russian, name) for mal, (russian, name) in fetched.items()])
    db.execute("COMMIT")

    touched = {key for key, mal in links.items() if before.get(key) != mal or names_before.get(mal) != fetched.get(mal, names_before.get(mal))}
    touched |= {key for key in before if key not in links}
    changed = rebuild(db, sorted(touched))
    meta_set(db, "anime_at", now())
    log.info("anime: %d TMDB links, %d Shikimori names, %d records changed, %.0fs",
             len(links), len(fetched), changed, time.monotonic() - started)


def signing_key() -> Ed25519PrivateKey:
    path = DATA / "signing.key"
    if path.exists():
        return serialization.load_pem_private_key(path.read_bytes(), password=None)
    key = Ed25519PrivateKey.generate()
    path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    path.chmod(0o600)
    public = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    (DATA / "signing.pub").write_text(base64.b64encode(public).decode() + "\n")
    log.info("new signing key created, public key in %s", DATA / "signing.pub")
    return key


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for chunk in iter(lambda: file.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_gzip_lines(path: Path, rows) -> int:
    temp = path.with_suffix(path.suffix + ".tmp")
    count = 0
    with open(temp, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=9, mtime=0) as file:
        for line in rows:
            file.write(line.encode())
            file.write(b"\n")
            count += 1
    temp.replace(path)
    return count


def publish(db: sqlite3.Connection) -> None:
    seq = int(meta_get(db, "seq", "0"))
    last = db.execute("SELECT version, seq FROM publishes ORDER BY version DESC LIMIT 1").fetchone()
    last_version, last_seq = last if last else (0, 0)
    if last and seq == last_seq and (PUBLIC / "manifest.json").exists():
        return
    started = time.monotonic()
    PUBLIC.mkdir(parents=True, exist_ok=True)
    version = last_version + 1
    created = now()

    delta_name = delta_sha = None
    delta_size = delta_count = 0
    if last:
        delta_name = f"delta-{version}.jsonl.gz"

        def delta_rows():
            for (record,) in db.execute("SELECT record FROM titles WHERE seq > ? AND seq <= ? ORDER BY kind, id", (last_seq, seq)):
                yield record
            for kind, id_ in db.execute("SELECT kind, id FROM removed WHERE seq > ? AND seq <= ?", (last_seq, seq)):
                yield encode({"k": kind, "id": id_, "x": 1})

        delta_count = write_gzip_lines(PUBLIC / delta_name, delta_rows())
        delta_sha = sha256_of(PUBLIC / delta_name)
        delta_size = (PUBLIC / delta_name).stat().st_size

    full_name = f"full-{version}.jsonl.gz"
    full_count = write_gzip_lines(PUBLIC / full_name, (record for (record,) in db.execute("SELECT record FROM titles ORDER BY kind, id")))
    full_sha = sha256_of(PUBLIC / full_name)
    full_size = (PUBLIC / full_name).stat().st_size

    db.execute("INSERT INTO publishes(version, created, seq, delta, delta_sha, delta_size, delta_count) VALUES(?, ?, ?, ?, ?, ?, ?)",
               (version, created, seq, delta_name, delta_sha, delta_size, delta_count))
    cutoff = created - DELTA_DAYS * 86400
    deltas = [
        {"version": v, "file": name, "sha256": sha, "size": size, "count": count}
        for v, name, sha, size, count in db.execute(
            "SELECT version, delta, delta_sha, delta_size, delta_count FROM publishes "
            "WHERE delta IS NOT NULL AND created >= ? ORDER BY version", (cutoff,))
    ]
    manifest = {
        "format": FORMAT,
        "version": version,
        "created": created,
        "count": full_count,
        "full": {"version": version, "file": full_name, "sha256": full_sha, "size": full_size, "count": full_count},
        "deltas": deltas,
    }
    body = json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode()
    signature = base64.b64encode(signing_key().sign(body)).decode()
    for name, content in (("manifest.json.sig", signature.encode()), ("manifest.json", body)):
        temp = PUBLIC / (name + ".tmp")
        temp.write_bytes(content)
        temp.replace(PUBLIC / name)

    keep = {full_name, f"full-{last_version}.jsonl.gz", "manifest.json", "manifest.json.sig", *(delta["file"] for delta in deltas)}
    for path in PUBLIC.iterdir():
        if path.name not in keep and not path.name.endswith(".tmp"):
            path.unlink(missing_ok=True)
    meta_set(db, "published_at", created)
    log.info("published version %d: %d titles (%.1f MB), delta %d records (%.1f KB), %.0fs",
             version, full_count, full_size / 1048576, delta_count, delta_size / 1024, time.monotonic() - started)


def write_status(db: sqlite3.Connection, state: str) -> None:
    status = {
        "state": state,
        "titles": db.execute("SELECT COUNT(*) FROM titles").fetchone()[0],
        "queue": db.execute("SELECT COUNT(*) FROM queue").fetchone()[0],
        "version": (db.execute("SELECT MAX(version) FROM publishes").fetchone()[0] or 0),
        "updated": dt.datetime.now(TIMEZONE).isoformat(timespec="seconds"),
    }
    temp = DATA / "status.json.tmp"
    temp.write_text(json.dumps(status, indent=1))
    temp.replace(DATA / "status.json")


def next_run_after(moment: dt.datetime) -> dt.datetime:
    local = moment.astimezone(TIMEZONE)
    candidates = []
    for days in (0, 1):
        day = local.date() + dt.timedelta(days=days)
        for hour in RUN_HOURS:
            candidates.append(dt.datetime(day.year, day.month, day.day, hour, tzinfo=TIMEZONE))
    return min(candidate for candidate in candidates if candidate > local)


async def run_cycle(db: sqlite3.Connection, client: httpx.AsyncClient, limiter: RateLimiter) -> None:
    loading = meta_get(db, "loaded") != "1"
    write_status(db, "loading" if loading else "updating")
    await sync_exports(db, client)
    await sync_changes(db, client, limiter)
    try:
        await sync_anime(db, client)
    except Exception as error:
        log.warning("anime sync failed, will retry next run: %s", error)
    if not loading:
        queue_refresh(db)
    await process_queue(db, client, limiter, publish_during=loading)
    if stopping.is_set():
        return
    left = db.execute("SELECT COUNT(*) FROM queue WHERE priority > ?", (FAILED,)).fetchone()[0]
    failed = db.execute("UPDATE queue SET priority = 0 WHERE priority <= ?", (FAILED,)).rowcount
    if failed:
        log.warning("%d titles failed to load, they will be retried next run", failed)
    if loading and left == 0:
        meta_set(db, "loaded", "1")
        log.info("first full load finished")
        try:
            await sync_anime(db, client, force=True)
        except Exception as error:
            log.warning("anime sync failed: %s", error)
    publish(db)
    write_status(db, "idle")


async def main() -> None:
    logging.basicConfig(level=os.environ.get("CATALOG_LOG", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    if not TMDB_KEY:
        raise SystemExit("TMDB_API_KEY is not set")
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, stopping.set)
        except NotImplementedError:
            pass
    db = connect()
    signing_key()
    limiter = RateLimiter(TMDB_RATE)
    limits = httpx.Limits(max_connections=WORKERS + 2, max_keepalive_connections=WORKERS + 2)
    async with httpx.AsyncClient(headers={"User-Agent": USER_AGENT}, timeout=30, limits=limits, follow_redirects=True) as client:
        while not stopping.is_set():
            try:
                await run_cycle(db, client, limiter)
            except Exception:
                log.exception("run failed")
                write_status(db, "failed")
                if ONCE:
                    raise
            if ONCE or stopping.is_set():
                break
            if meta_get(db, "loaded") != "1":
                await asyncio.sleep(60)
                continue
            wake = next_run_after(dt.datetime.now(TIMEZONE))
            log.info("next run at %s", wake.isoformat(timespec="minutes"))
            while not stopping.is_set():
                left = (wake - dt.datetime.now(TIMEZONE)).total_seconds()
                if left <= 0:
                    break
                try:
                    await asyncio.wait_for(stopping.wait(), timeout=min(left, 300))
                except asyncio.TimeoutError:
                    pass
    db.close()


if __name__ == "__main__":
    asyncio.run(main())
