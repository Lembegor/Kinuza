import asyncio
import json
import logging
import os
import re
import secrets
import sqlite3
import time

import httpx
from aiohttp import web

import page

CATALOG = os.environ.get("SHARE_CATALOG", "/catalog/catalog.db")
PORT = int(os.environ.get("SHARE_PORT", "8092"))
HOST = os.environ.get("SHARE_HOST", "0.0.0.0")
TMDB_KEY = os.environ.get("TMDB_API_KEY", "")
TMDB = "https://api.themoviedb.org/3"
TMDB_LANGUAGES = {"ru": "ru-RU", "uk": "uk-UA", "en": "en-US"}
CACHE_SECONDS = 24 * 3600
MISS_SECONDS = 15 * 60
CACHE_LIMIT = 4000
TMDB_TIMEOUT = 5.0

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("share")


def catalog_record(kind: str, ident: int) -> dict | None:
    try:
        connection = sqlite3.connect(f"file:{CATALOG}?mode=ro", uri=True, timeout=3)
        try:
            row = connection.execute("select record from titles where kind = ? and id = ?", ("m" if kind == "movie" else "t", ident)).fetchone()
        finally:
            connection.close()
    except sqlite3.Error as error:
        log.warning("catalog read failed: %s", error)
        return None
    if not row:
        return None
    try:
        record = json.loads(row[0])
    except ValueError:
        return None
    return record if isinstance(record, dict) else None


def from_record(record: dict, language: str) -> dict:
    titles = record.get("t") if isinstance(record.get("t"), dict) else {}
    posters = record.get("i") if isinstance(record.get("i"), dict) else {}
    original = str(record.get("o") or "")
    return {
        "title": str(titles.get(language) or titles.get("en") or original or ""),
        "original": original,
        "year": str(record.get("y") or ""),
        "poster": str(posters.get(language) or posters.get("") or ""),
        "backdrop": str(record.get("b") or ""),
        "overview": "",
    }


class Titles:
    def __init__(self) -> None:
        self.client = httpx.AsyncClient(timeout=TMDB_TIMEOUT, headers={"User-Agent": "Kinuza share page"})
        self.cache: dict = {}

    async def tmdb(self, kind: str, ident: int, language: str) -> dict | None:
        if not TMDB_KEY:
            return None
        try:
            response = await self.client.get(f"{TMDB}/{kind}/{ident}", params={"api_key": TMDB_KEY, "language": TMDB_LANGUAGES[language]})
        except httpx.HTTPError as error:
            log.info("tmdb %s %s failed: %s", kind, ident, type(error).__name__)
            return None
        if response.status_code != 200:
            return None
        try:
            data = response.json()
        except ValueError:
            return None
        return data if isinstance(data, dict) else None

    async def find(self, kind: str, ident: int, language: str) -> dict | None:
        key = (kind, ident, language)
        known = self.cache.get(key)
        if known and time.time() - known[0] < (CACHE_SECONDS if known[1] else MISS_SECONDS):
            return known[1]
        record = await asyncio.to_thread(catalog_record, kind, ident)
        info = from_record(record, language) if record else None
        details = await self.tmdb(kind, ident, language)
        if details:
            if info is None:
                date = str(details.get("release_date") or details.get("first_air_date") or "")
                info = {
                    "title": str(details.get("title") or details.get("name") or ""),
                    "original": str(details.get("original_title") or details.get("original_name") or ""),
                    "year": date[:4],
                    "poster": str(details.get("poster_path") or ""),
                    "backdrop": str(details.get("backdrop_path") or ""),
                    "overview": "",
                }
            info["overview"] = str(details.get("overview") or "")
            if details.get("adult") is True:
                info = None
        if info is not None and not info["title"]:
            info = None
        if len(self.cache) >= CACHE_LIMIT:
            self.cache.clear()
        self.cache[key] = (time.time(), info)
        return info


def number(value: str | None, limit: int) -> int | None:
    if value is None or not re.fullmatch(r"\d{1,4}", value):
        return None
    parsed = int(value)
    return parsed if parsed <= limit else None


async def title_page(request: web.Request) -> web.Response:
    kind = request.match_info["kind"]
    ident = int(request.match_info["ident"])
    language = page.pick_language(request.headers.get("Accept-Language", ""))
    season = number(request.query.get("s"), 500) if kind == "tv" else None
    episode = number(request.query.get("e"), 5000) if season is not None else None
    titles: Titles = request.app["titles"]
    info = await titles.find(kind, ident, language)
    nonce = secrets.token_urlsafe(16)
    body = page.render(info, kind, ident, language, season, episode, nonce)
    csp = (
        "default-src 'none'; "
        f"img-src {page.SITE}; "
        "style-src 'unsafe-inline'; "
        f"script-src 'nonce-{nonce}'; "
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    )
    return web.Response(
        text=body,
        status=200 if info else 404,
        content_type="text/html",
        headers={"Content-Security-Policy": csp, "Cache-Control": "public, max-age=600", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer"},
    )


async def stop(app: web.Application) -> None:
    await app["titles"].client.aclose()


def main() -> None:
    app = web.Application()
    app["titles"] = Titles()
    app.router.add_get(r"/t/{kind:movie|tv}/{ident:\d{1,9}}", title_page)
    app.on_cleanup.append(stop)
    web.run_app(app, host=HOST, port=PORT, access_log=None)


if __name__ == "__main__":
    main()
