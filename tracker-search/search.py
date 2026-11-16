import asyncio
import hmac
import json
import logging
import os
import re
import sqlite3
import time
import urllib.parse

import httpx
from aiohttp import web

import names

KEY = os.environ.get("SEARCH_KEY", "")
DATA = os.environ.get("SEARCH_DATA", "/data")
PORT = int(os.environ.get("SEARCH_PORT", "8091"))
HOST = os.environ.get("SEARCH_HOST", "0.0.0.0")
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"

NNM = "https://nnmclub.to/forum/"
YTS_BASES = ["https://movies-api.accel.li", "https://yts.bz", "https://yts.mx"]
EZTV = "https://eztvx.to/api/get-torrents"
ANILIBERTY = "https://aniliberty.top"
SUKEBEI = "https://sukebei.nyaa.si"

SEARCH_TTL = 3 * 3600
EMPTY_TTL = 20 * 60
TOPIC_TTL = 7 * 86400
LIST_TTL = 3 * 3600
TORRENT_TTL = 3 * 86400
SOURCE_DEADLINE = 30
NNM_DETAILED = 8
NNM_DAILY_PAGES = 2500
EZTV_PAGES = 20
ANI_RELEASES = 6
TORRENT_LIMIT = 8 * 1024 * 1024
CHECK_EVERY = 30 * 60
GAPS = {"nnm": 0.6, "yts": 0.3, "eztv": 0.4, "aniliberty": 0.3, "sukebei": 1.0}

log = logging.getLogger("search")


class Pace:
    def __init__(self) -> None:
        self.locks = {name: asyncio.Lock() for name in GAPS}
        self.last = {name: 0.0 for name in GAPS}

    async def wait(self, source: str) -> None:
        async with self.locks[source]:
            gap = GAPS[source] - (time.monotonic() - self.last[source])
            if gap > 0:
                await asyncio.sleep(gap)
            self.last[source] = time.monotonic()


class Store:
    def __init__(self, path: str) -> None:
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY, value BLOB, fetched INTEGER)")
        self.db.execute("CREATE TABLE IF NOT EXISTS counters(day TEXT, name TEXT, value INTEGER, PRIMARY KEY(day, name))")
        self.db.commit()

    def get(self, key: str, ttl: int):
        row = self.db.execute("SELECT value, fetched FROM cache WHERE key = ?", (key,)).fetchone()
        if not row or time.time() - row[1] > ttl:
            return None
        return row[0]

    def put(self, key: str, value) -> None:
        self.db.execute(
            "INSERT INTO cache(key, value, fetched) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, fetched = excluded.fetched",
            (key, value, int(time.time())),
        )
        self.db.commit()

    def count(self, name: str) -> int:
        day = time.strftime("%Y-%m-%d")
        self.db.execute(
            "INSERT INTO counters(day, name, value) VALUES(?, ?, 1) ON CONFLICT(day, name) DO UPDATE SET value = value + 1", (day, name)
        )
        self.db.commit()
        return self.db.execute("SELECT value FROM counters WHERE day = ? AND name = ?", (day, name)).fetchone()[0]

    def prune(self) -> None:
        self.db.execute("DELETE FROM cache WHERE fetched < ?", (int(time.time()) - TOPIC_TTL,))
        self.db.execute("DELETE FROM counters WHERE day < ?", (time.strftime("%Y-%m-%d", time.localtime(time.time() - 7 * 86400)),))
        self.db.commit()


class SourceError(Exception):
    pass


class Search:
    def __init__(self) -> None:
        self.client = httpx.AsyncClient(
            follow_redirects=True,
            timeout=httpx.Timeout(20.0, connect=10.0),
            headers={"User-Agent": USER_AGENT, "Accept-Language": "ru,en;q=0.8"},
            limits=httpx.Limits(max_connections=8, max_keepalive_connections=4),
        )
        self.store = Store(os.path.join(DATA, "search.sqlite"))
        self.pace = Pace()
        self.health: dict = {name: {"state": "unknown", "checked": 0} for name in GAPS}
        self.running: dict = {}

    async def fetch(self, source: str, url: str, binary: bool = False, encoding: str = "utf-8"):
        await self.pace.wait(source)
        response = await self.client.get(url)
        if response.status_code == 404:
            raise SourceError("not_found")
        if response.status_code in (403, 429, 503) and "cf-mitigated" in response.headers:
            raise SourceError("challenge")
        if response.status_code >= 400:
            raise SourceError(f"status_{response.status_code}")
        if binary:
            return response.content
        return response.content.decode(encoding, "replace")

    async def cached(self, key: str, ttl: int, load):
        known = self.store.get(key, ttl)
        if known is not None:
            return json.loads(known)
        running = self.running.get(key)
        if running:
            return await running
        task = asyncio.ensure_future(load())
        self.running[key] = task
        try:
            value = await task
        finally:
            self.running.pop(key, None)
        self.store.put(key, json.dumps(value, ensure_ascii=False))
        return value

    async def nnm_search(self, query: str) -> list:
        async def load():
            page = await self.fetch("nnm", NNM + "tracker.php?nm=" + urllib.parse.quote(query), encoding="cp1251")
            if "tracker.php" not in page:
                raise SourceError("unexpected_page")
            return names.nnm_rows(page)

        return await self.cached(f"nnm:search:{query.lower()}", SEARCH_TTL, load)

    async def nnm_topic(self, topic: str):
        key = f"nnm:topic:{topic}"
        known = self.store.get(key, TOPIC_TTL)
        if known is not None:
            return json.loads(known)
        if self.store.count("nnm_pages") > NNM_DAILY_PAGES:
            return None
        page = await self.fetch("nnm", NNM + "viewtopic.php?t=" + topic, encoding="cp1251")
        details = names.nnm_details(page)
        download = re.search(r'href="download\.php\?id=(\d+)"', page)
        details["download"] = download.group(1) if download else ""
        self.store.put(key, json.dumps(details, ensure_ascii=False))
        return details

    async def nnm(self, request: dict) -> list:
        queries = [request["title"]] if request["title"] else []
        if request["original"] and request["original"].lower() != request["title"].lower() and re.search(r"[a-z]", request["original"], re.I):
            queries.append(request["original"])
        if not queries:
            return []
        rows: dict = {}
        for index, query in enumerate(queries):
            if index > 0 and len(rows) >= 5:
                break
            for row in await self.nnm_search(query):
                rows.setdefault(row["topic"], row)
        wanted = [row for row in rows.values() if self.nnm_fits(row, request)]
        wanted.sort(key=lambda row: -row["seeds"])
        details: dict = {}
        for row in wanted[:NNM_DETAILED]:
            try:
                details[row["topic"]] = await self.nnm_topic(row["topic"])
            except (SourceError, httpx.HTTPError) as error:
                log.info("nnm topic %s failed: %s", row["topic"], error)
        items = []
        for row in wanted:
            found = details.get(row["topic"]) or {}
            items.append({
                "source": "nnm",
                "id": row["topic"],
                "title": names.nnm_title(row, found or None, request["language"]),
                "name": row["title"],
                "size": row["size"],
                "sizeBytes": names.size_bytes(row["size"]),
                "seeds": row["seeds"],
                "leeches": row["leeches"],
                "infoHash": found.get("infoHash", ""),
                "magnet": "",
                "page": NNM + "viewtopic.php?t=" + row["topic"],
                "torrent": row["download"] or found.get("download", ""),
                "minutes": found.get("minutes", 0),
                "detailed": bool(found),
            })
        return items

    @staticmethod
    def nnm_fits(row: dict, request: dict) -> bool:
        if row["seeds"] <= 0:
            return False
        title = row["title"]
        year = request["year"]
        if request["type"] == "movie":
            if not year:
                return True
            years = [int(value) for value in re.findall(r"\b(?:19|20)\d{2}\b", title)]
            return any(abs(value - year) <= 1 for value in years)
        season = request["season"]
        if season is None:
            return True
        stated = names.NNM_SCOPE.search(title)
        if stated:
            first = int(stated.group(1))
            last = int(stated.group(2)) if stated.group(2) else first
            return first <= season <= last
        tv = re.search(r"\[\s*ТВ-(\d{1,2})", title)
        if tv:
            return int(tv.group(1)) == season
        return season == 1 or not re.search(r"сезон|ТВ-\d", title, re.I)

    async def yts(self, request: dict) -> list:
        imdb = request["imdb"]
        if request["type"] != "movie" or not imdb:
            return []

        async def load():
            last: Exception | None = None
            for base in YTS_BASES:
                try:
                    text = await self.fetch("yts", f"{base}/api/v2/list_movies.json?query_term={imdb}")
                    data = json.loads(text)
                    movies = [movie for movie in (data.get("data") or {}).get("movies") or [] if movie.get("imdb_code") == imdb]
                    return movies[:1]
                except (SourceError, httpx.HTTPError, ValueError) as error:
                    last = error
            raise SourceError(str(last or "unavailable"))

        movies = await self.cached(f"yts:{imdb}", SEARCH_TTL, load)
        items = []
        for movie in movies:
            items.extend(names.yts_items(movie, request["language"], str(movie.get("url") or "")))
        return items

    async def eztv(self, request: dict) -> list:
        imdb = request["imdb"]
        if request["type"] != "tv" or not imdb or request["anime"]:
            return []
        number = imdb[2:]

        async def load():
            torrents: list = []
            for page in range(1, EZTV_PAGES + 1):
                data = json.loads(await self.fetch("eztv", f"{EZTV}?imdb_id={number}&limit=100&page={page}"))
                batch = data.get("torrents") or []
                torrents.extend(batch)
                if len(batch) < 100 or len(torrents) >= int(data.get("torrents_count") or 0):
                    break
            return torrents

        torrents = await self.cached(f"eztv:{number}", LIST_TTL, load)
        show = request["english"] or request["original"] or request["title"]
        shows = [name for name in (request["english"], request["original"]) if name and re.search(r"[a-z]", name, re.I)]
        return names.eztv_items(torrents, show, request["language"], request["season"], request["episode"], shows or [show])

    async def aniliberty(self, request: dict) -> list:
        if not request["anime"]:
            return []
        queries = []
        for name in (request["original"], request["english"], request["title"]):
            if name and name.lower() not in [query.lower() for query in queries]:
                queries.append(name)
        releases: dict = {}
        for query in queries:
            async def load(query=query):
                text = await self.fetch("aniliberty", f"{ANILIBERTY}/api/v1/app/search/releases?query={urllib.parse.quote(query)}")
                return [{"id": entry.get("id"), "year": entry.get("year")} for entry in json.loads(text) if entry.get("id")]

            for entry in await self.cached(f"ani:search:{query.lower()}", SEARCH_TTL, load):
                releases.setdefault(entry["id"], entry)
            if len(releases) >= 2:
                break
        year = request["year"]
        chosen = [entry for entry in releases.values() if not year or not entry.get("year") or entry["year"] >= year - 1][:ANI_RELEASES]
        items = []
        for entry in chosen:
            async def load(entry=entry):
                return json.loads(await self.fetch("aniliberty", f"{ANILIBERTY}/api/v1/anime/releases/{entry['id']}"))

            release = await self.cached(f"ani:release:{entry['id']}", LIST_TTL, load)
            alias = release.get("alias") or ""
            page = f"{ANILIBERTY}/anime/releases/release/{alias}" if alias else ANILIBERTY
            items.extend(names.ani_items(release, release.get("torrents") or [], page))
        return items

    async def sukebei(self, request: dict) -> list:
        if not request["adult"]:
            return []
        latin = [name for name in (request["english"], request["original"], request["title"]) if name and re.search(r"[a-z]", name, re.I)]
        queries = []
        for name in latin + [request["original"]]:
            if name and name.lower() not in [query.lower() for query in queries]:
                queries.append(name)
        items: dict = {}
        for query in queries[:2]:
            async def load(query=query):
                params = urllib.parse.urlencode({"page": "rss", "q": query, "c": "1_1", "f": "0", "s": "seeders", "o": "desc"})
                return await self.fetch("sukebei", f"{SUKEBEI}/?{params}")

            rss = await self.cached(f"sukebei:{query.lower()}", SEARCH_TTL, load)
            for item in names.sukebei_items(rss, latin, request["season"], request["episode"]):
                items.setdefault(item["infoHash"], item)
            if len(items) >= 3:
                break
        return list(items.values())

    async def run(self, source: str, request: dict):
        try:
            items = await asyncio.wait_for(getattr(self, source)(request), SOURCE_DEADLINE)
            state = "ok" if items else "empty"
            self.health[source] = {"state": "ok", "checked": int(time.time())}
            return source, state, items
        except asyncio.TimeoutError:
            state = "timeout"
        except (SourceError, httpx.HTTPError, ValueError, KeyError) as error:
            state = str(error) if isinstance(error, SourceError) else type(error).__name__
        self.health[source] = {"state": state, "checked": int(time.time())}
        log.warning("%s failed: %s", source, state)
        return source, "failed", []

    def sources_for(self, request: dict) -> list:
        if request["adult"]:
            return ["sukebei", "nnm"]
        if request["anime"]:
            return ["aniliberty", "nnm"] + (["yts"] if request["type"] == "movie" else [])
        return ["yts", "nnm"] if request["type"] == "movie" else ["eztv", "nnm"]

    async def search(self, request: dict) -> dict:
        wanted = [source for source in self.sources_for(request) if not request["only"] or source in request["only"]]
        started = time.monotonic()
        results = await asyncio.gather(*(self.run(source, request) for source in wanted))
        items = []
        seen = set()
        statuses = {}
        for source, state, found in results:
            statuses[source] = state
            for item in found:
                key = item["infoHash"] or f"{item['source']}:{item['id']}"
                if key in seen:
                    continue
                seen.add(key)
                items.append(item)
        log.info(
            "search %s %s s=%s e=%s -> %s in %.1fs",
            request["type"], "anime" if request["anime"] else "", request["season"], request["episode"],
            " ".join(f"{source}={state}:{sum(1 for item in items if item['source'] == source)}" for source, state in statuses.items()),
            time.monotonic() - started,
        )
        return {"items": items, "sources": statuses}

    async def torrent(self, source: str, ident: str, link: str) -> bytes:
        key = f"file:{source}:{ident}"
        known = self.store.get(key, TORRENT_TTL)
        if known is not None:
            return bytes(known)
        if source == "nnm":
            download = link if link.isdigit() else ""
            if not download:
                details = await self.nnm_topic(ident)
                download = (details or {}).get("download", "")
            if not download:
                raise SourceError("torrent_file_unavailable")
            data = await self.fetch("nnm", f"{NNM}download.php?id={download}", binary=True)
        elif source == "yts":
            data = b""
            for base in ["https://yts.bz", "https://yts.mx"]:
                try:
                    data = await self.fetch("yts", f"{base}/torrent/download/{ident.upper()}", binary=True)
                    break
                except (SourceError, httpx.HTTPError):
                    continue
        elif source == "aniliberty":
            data = await self.fetch("aniliberty", f"{ANILIBERTY}/api/v1/anime/torrents/{ident}/file", binary=True)
        elif source == "sukebei" and ident.isdigit():
            data = await self.fetch("sukebei", f"{SUKEBEI}/download/{ident}.torrent", binary=True)
        else:
            raise SourceError("torrent_file_unavailable")
        if not data or data[:1] != b"d" or len(data) > TORRENT_LIMIT:
            raise SourceError("torrent_file_unavailable")
        self.store.put(key, data)
        return data

    async def check(self) -> None:
        samples = [
            ("nnm", {"type": "movie", "title": "Интерстеллар", "original": "Interstellar", "english": "Interstellar", "year": 2014}),
            ("yts", {"type": "movie", "imdb": "tt0816692", "year": 2014}),
            ("eztv", {"type": "tv", "imdb": "tt0121955", "english": "South Park", "season": 1, "episode": 1}),
            ("aniliberty", {"type": "tv", "anime": True, "original": "Sousou no Frieren", "year": 2023}),
            ("sukebei", {"type": "tv", "anime": True, "adult": True, "english": "Ijirare: Fukushuu Saimin", "season": 1}),
        ]
        for source, sample in samples:
            request = blank_request()
            request.update(sample)
            try:
                found = await asyncio.wait_for(getattr(self, source)(request), SOURCE_DEADLINE)
                self.health[source] = {"state": "ok" if found else "empty", "checked": int(time.time())}
            except Exception as error:
                self.health[source] = {"state": type(error).__name__ if not isinstance(error, SourceError) else str(error), "checked": int(time.time())}
            log.info("check %s: %s", source, self.health[source]["state"])


def blank_request() -> dict:
    return {
        "type": "movie", "title": "", "original": "", "english": "", "year": None, "imdb": "", "season": None, "episode": None,
        "anime": False, "adult": False, "language": "", "only": [],
    }


def number(value: str | None, low: int, high: int):
    if value is None or value == "":
        return None
    if not re.fullmatch(r"\d{1,4}", value):
        raise ValueError("bad_number")
    parsed = int(value)
    if not low <= parsed <= high:
        raise ValueError("bad_number")
    return parsed


def parse_request(query) -> dict:
    request = blank_request()
    kind = query.get("type", "movie")
    if kind not in ("movie", "tv"):
        raise ValueError("bad_type")
    request["type"] = kind
    for name in ("title", "original", "english"):
        request[name] = names.clean(query.get(name, ""))[:150]
    request["year"] = number(query.get("year"), 1880, 2100)
    request["season"] = number(query.get("season"), 0, 200)
    request["episode"] = number(query.get("episode"), 0, 5000)
    imdb = query.get("imdb", "")
    if imdb and not re.fullmatch(r"tt\d{5,10}", imdb):
        raise ValueError("bad_imdb")
    request["imdb"] = imdb
    request["anime"] = query.get("anime") == "1"
    request["adult"] = query.get("adult") == "1"
    language = query.get("language", "")
    request["language"] = language if re.fullmatch(r"[a-z]{2}", language) else ""
    request["only"] = [name for name in query.get("only", "").split(",") if name in GAPS]
    if not (request["title"] or request["original"] or request["imdb"]):
        raise ValueError("empty_query")
    return request


def authorized(request: web.Request) -> bool:
    return bool(KEY) and hmac.compare_digest(request.headers.get("X-Kinuza-Key", ""), KEY)


@web.middleware
async def guard(request: web.Request, handler):
    if not authorized(request):
        return web.json_response({"error": "forbidden"}, status=403)
    try:
        return await handler(request)
    except ValueError as error:
        return web.json_response({"error": str(error)}, status=400)


async def search_handler(request: web.Request) -> web.Response:
    service: Search = request.app["search"]
    return web.json_response(await service.search(parse_request(request.query)))


async def torrent_handler(request: web.Request) -> web.Response:
    service: Search = request.app["search"]
    source = request.query.get("source", "")
    ident = request.query.get("id", "")
    link = request.query.get("link", "")
    if source not in GAPS or not re.fullmatch(r"[0-9A-Za-z]{1,64}", ident) or (link and not link.isdigit()):
        return web.json_response({"error": "bad_request"}, status=400)
    try:
        data = await service.torrent(source, ident, link)
    except (SourceError, httpx.HTTPError) as error:
        log.info("torrent %s %s failed: %s", source, ident, error)
        return web.json_response({"error": "torrent_file_unavailable"}, status=404)
    return web.Response(body=data, content_type="application/x-bittorrent")


async def status_handler(request: web.Request) -> web.Response:
    service: Search = request.app["search"]
    return web.json_response({"sources": service.health})


async def checks(app: web.Application) -> None:
    service: Search = app["search"]
    await asyncio.sleep(20)
    while True:
        try:
            await service.check()
            service.store.prune()
        except Exception as error:
            log.warning("check failed: %s", error)
        await asyncio.sleep(CHECK_EVERY)


async def start(app: web.Application) -> None:
    app["search"] = Search()
    app["checks"] = asyncio.create_task(checks(app))


async def stop(app: web.Application) -> None:
    app["checks"].cancel()
    await app["search"].client.aclose()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    if not KEY:
        raise SystemExit("SEARCH_KEY is not set")
    app = web.Application(middlewares=[guard])
    app.router.add_get("/search", search_handler)
    app.router.add_get("/torrent", torrent_handler)
    app.router.add_get("/status", status_handler)
    app.on_startup.append(start)
    app.on_cleanup.append(stop)
    web.run_app(app, host=HOST, port=PORT, access_log=None)


if __name__ == "__main__":
    main()
