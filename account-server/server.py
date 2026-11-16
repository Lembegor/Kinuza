import asyncio
import base64
import logging
import os
import re
import time

import httpx
from aiohttp import web

import google
from party import Party
from store import Store, StoreError, clean_code, clean_name

DATA = os.environ.get("ACCOUNT_DATA", "/data")
PORT = int(os.environ.get("ACCOUNT_PORT", "8093"))
HOST = os.environ.get("ACCOUNT_HOST", "0.0.0.0")
CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
DEV_KEY = os.environ.get("ACCOUNT_DEV_KEY", "")
ONLINE_SECONDS = 150
SEEN_WRITE_SECONDS = 600
BACKUP_LIMIT = 12 * 1024 * 1024
AVATAR_LIMIT = 96 * 1024
SYNC_GAP_SECONDS = 4
REQUESTS_PER_DAY = 40
LOOKUPS_PER_HOUR = 60
JSON_LIMIT = 256 * 1024

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("account")


class State:
    def __init__(self) -> None:
        os.makedirs(DATA, exist_ok=True)
        self.store = Store(os.path.join(DATA, "accounts.sqlite"))
        self.lock = asyncio.Lock()
        self.client = httpx.AsyncClient(timeout=15.0)
        self.presence: dict = {}
        self.seen_written: dict = {}
        self.last_sync: dict = {}
        self.counters: dict = {}
        self.party = Party(self)

    def count(self, key: tuple, limit: int, window: int) -> bool:
        now = time.time()
        start, used = self.counters.get(key, (now, 0))
        if now - start > window:
            start, used = now, 0
        if used >= limit:
            return False
        self.counters[key] = (start, used + 1)
        if len(self.counters) > 20000:
            self.counters = {k: v for k, v in self.counters.items() if now - v[0] <= 86400}
        return True


def error(code: str, status: int = 400) -> web.Response:
    return web.json_response({"error": code}, status=status)


def bearer(request: web.Request) -> str:
    header = request.headers.get("Authorization", "")
    return header[7:].strip() if header.startswith("Bearer ") else ""


def account_of(row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "email": row["email"],
        "code": row["code"],
        "avatar": f"a/{row['avatar']}.jpg" if row["avatar"] else None,
        "showActivity": bool(row["show_activity"]),
        "invisible": bool(row["invisible"]),
        "created": row["created"],
    }


async def body_json(request: web.Request) -> dict:
    if request.content_length and request.content_length > JSON_LIMIT:
        raise web.HTTPRequestEntityTooLarge(max_size=JSON_LIMIT, actual_size=request.content_length)
    try:
        data = await request.json()
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def signed_in(handler):
    async def wrapper(request: web.Request) -> web.Response:
        state: State = request.app["state"]
        user = state.store.session_user(bearer(request))
        if not user:
            return error("account_signed_out", 401)
        request["user"] = user
        return await handler(request)

    return wrapper


async def config(request: web.Request) -> web.Response:
    return web.json_response({"googleClientId": CLIENT_ID}, headers={"Cache-Control": "max-age=300"})


async def sign_in_google(request: web.Request) -> web.Response:
    state: State = request.app["state"]
    if not CLIENT_ID or not CLIENT_SECRET:
        return error("account_not_ready", 503)
    data = await body_json(request)
    try:
        identity = await google.exchange(
            state.client, CLIENT_ID, CLIENT_SECRET, str(data.get("code", "")), str(data.get("verifier", "")), str(data.get("redirect", ""))
        )
    except google.GoogleError as failure:
        log.info("google sign in failed: %s", failure)
        return error(str(failure), 401)
    return await finish_sign_in(state, identity, str(data.get("device", "")))


async def sign_in_dev(request: web.Request) -> web.Response:
    if not DEV_KEY or request.headers.get("X-Dev-Key") != DEV_KEY:
        return error("not_found", 404)
    data = await body_json(request)
    identity = {"sub": str(data.get("sub") or "10000000000"), "email": str(data.get("email") or ""), "name": str(data.get("name") or "Tester")}
    return await finish_sign_in(request.app["state"], identity, str(data.get("device", "")))


async def finish_sign_in(state: State, identity: dict, device: str) -> web.Response:
    async with state.lock:
        token, user, created = state.store.sign_in(identity["sub"], identity["email"], identity["name"], device)
    log.info("sign in user=%s new=%s", user["id"], created)
    return web.json_response({"token": token, "account": account_of(user), "created": created})


@signed_in
async def sign_out(request: web.Request) -> web.Response:
    state: State = request.app["state"]
    async with state.lock:
        state.store.sign_out(bearer(request))
    return web.json_response({"ok": True})


@signed_in
async def sign_out_everywhere(request: web.Request) -> web.Response:
    state: State = request.app["state"]
    async with state.lock:
        state.store.sign_out_everywhere(request["user"]["id"])
    return web.json_response({"ok": True})


@signed_in
async def me(request: web.Request) -> web.Response:
    return web.json_response(account_of(request["user"]))


def decode_avatar(value) -> bytes | None:
    if value is None:
        return None
    match = re.fullmatch(r"data:image/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)", str(value))
    if not match:
        raise StoreError("avatar_invalid")
    data = base64.b64decode(match.group(2))
    if len(data) > AVATAR_LIMIT:
        raise StoreError("avatar_too_large")
    if not (data.startswith(b"\xff\xd8\xff") or data.startswith(b"\x89PNG") or (data[:4] == b"RIFF" and data[8:12] == b"WEBP")):
        raise StoreError("avatar_invalid")
    return data


@signed_in
async def update_me(request: web.Request) -> web.Response:
    state: State = request.app["state"]
    data = await body_json(request)
    user_id = request["user"]["id"]
    try:
        avatar = decode_avatar(data["avatar"]) if "avatar" in data else None
    except (StoreError, ValueError) as failure:
        return error(str(failure) if isinstance(failure, StoreError) else "avatar_invalid")
    async with state.lock:
        state.store.update_profile(user_id, data)
        if "avatar" in data:
            state.store.set_avatar(user_id, avatar)
        user = state.store.user(user_id)
    if "invisible" in data and data["invisible"]:
        state.presence.pop(user_id, None)
    return web.json_response(account_of(user))


@signed_in
async def delete_me(request: web.Request) -> web.Response:
    state: State = request.app["state"]
    user_id = request["user"]["id"]
    async with state.lock:
        state.store.delete_user(user_id)
    state.presence.pop(user_id, None)
    room = state.party.room_of(user_id)
    if room:
        await state.party.remove(room, user_id, "left")
    log.info("deleted user=%s", user_id)
    return web.json_response({"ok": True})


async def avatar(request: web.Request) -> web.Response:
    avatar_id = request.match_info["avatar"]
    data = request.app["state"].store.avatar(avatar_id)
    if not data:
        return error("not_found", 404)
    kind = "image/png" if data.startswith(b"\x89PNG") else "image/webp" if data[:4] == b"RIFF" else "image/jpeg"
    return web.Response(body=data, content_type=kind, headers={"Cache-Control": "public, max-age=31536000, immutable"})


@signed_in
async def get_backup(request: web.Request) -> web.Response:
    state: State = request.app["state"]
    row = state.store.backup(request["user"]["id"])
    if not row:
        return web.Response(status=204, headers={"X-Revision": "0"})
    if request.headers.get("If-None-Match") == str(row["revision"]):
        return web.Response(status=304, headers={"X-Revision": str(row["revision"])})
    return web.Response(
        body=bytes(row["data"]),
        content_type="application/octet-stream",
        headers={"X-Revision": str(row["revision"]), "X-Updated": str(row["updated"]), "Cache-Control": "no-store"},
    )


@signed_in
async def put_backup(request: web.Request) -> web.Response:
    state: State = request.app["state"]
    user_id = request["user"]["id"]
    expected = request.headers.get("If-Match", "")
    if not re.fullmatch(r"\d{1,9}", expected):
        return error("sync_revision_missing")
    if request.content_length is None or request.content_length > BACKUP_LIMIT:
        return error("sync_too_large", 413)
    now = time.time()
    if now - state.last_sync.get(user_id, 0) < SYNC_GAP_SECONDS:
        return error("sync_too_often", 429)
    state.last_sync[user_id] = now
    data = await request.read()
    if len(data) > BACKUP_LIMIT or not data.startswith(b"\x1f\x8b"):
        return error("sync_invalid")
    async with state.lock:
        saved, revision = state.store.save_backup(user_id, int(expected), data)
    if not saved:
        return web.json_response({"error": "sync_conflict", "revision": revision}, status=409)
    return web.json_response({"revision": revision})


def watching_of(value) -> dict | None:
    if not isinstance(value, dict):
        return None
    kind = value.get("type")
    title = clean_name(str(value.get("title", "")))[:120] if value.get("title") else ""
    try:
        ident = int(value.get("id"))
    except (TypeError, ValueError):
        return None
    if kind not in ("movie", "tv") or not 0 < ident < 10**9 or not title:
        return None
    poster = str(value.get("poster") or "")
    result = {"type": kind, "id": ident, "title": title, "poster": poster if re.fullmatch(r"/[A-Za-z0-9_\-]+\.(jpg|png|webp)", poster) else None}
    for field in ("season", "episode"):
        number = value.get(field)
        if kind == "tv" and isinstance(number, int) and 0 <= number < 10000:
            result[field] = number
    return result


def friend_view(state: State, row, now: float) -> dict:
    seen = state.presence.get(row["id"])
    hidden = bool(row["invisible"])
    online = not hidden and seen is not None and now - seen["at"] < ONLINE_SECONDS
    last_seen = None if hidden else int(seen["at"]) if seen else (row["last_seen"] or None)
    return {
        "id": row["id"],
        "name": row["name"],
        "avatar": f"a/{row['avatar']}.jpg" if row["avatar"] else None,
        "online": online,
        "lastSeen": last_seen,
        "watching": seen.get("watching") if online and row["show_activity"] and seen else None,
        "room": state.party.friend_room(row["id"]) if not hidden else None,
    }


def person_of(row, at: int) -> dict:
    return {"id": row["id"], "name": row["name"], "avatar": f"a/{row['avatar']}.jpg" if row["avatar"] else None, "at": at}


def social(state: State, user_id: int) -> dict:
    now = time.time()
    store = state.store
    friends = [friend_view(state, row, now) for row in store.users(store.friend_ids(user_id))]
    friends.sort(key=lambda item: (not item["online"], item["watching"] is None, (item["name"] or "").lower()))
    incoming = store.requests_to(user_id)
    outgoing = store.requests_from(user_id)
    people = {row["id"]: row for row in store.users([row["id"] for row in incoming] + [row["id"] for row in outgoing])}
    return {
        "friends": friends,
        "incoming": [person_of(people[row["id"]], row["created"]) for row in incoming if row["id"] in people],
        "outgoing": [person_of(people[row["id"]], row["created"]) for row in outgoing if row["id"] in people],
        "backupRevision": store.backup_revision(user_id),
    }


@signed_in
async def presence(request: web.Request) -> web.Response:
    state: State = request.app["state"]
    user = request["user"]
    data = await body_json(request)
    now = time.time()
    user_id = user["id"]
    if data.get("state") == "offline":
        state.presence.pop(user_id, None)
        async with state.lock:
            state.store.note_seen(user_id, int(now))
        state.seen_written[user_id] = now
        return web.json_response({"ok": True})
    if not user["invisible"]:
        state.presence[user_id] = {"at": now, "watching": watching_of(data.get("watching"))}
    if now - state.seen_written.get(user_id, 0) > SEEN_WRITE_SECONDS:
        state.seen_written[user_id] = now
        async with state.lock:
            state.store.note_seen(user_id, int(now))
    return web.json_response(social(state, user_id))


@signed_in
async def lookup(request: web.Request) -> web.Response:
    state: State = request.app["state"]
    user = request["user"]
    if not state.count(("lookup", user["id"]), LOOKUPS_PER_HOUR, 3600):
        return error("friend_too_often", 429)
    other = state.store.user_by_code(clean_code(request.query.get("code", "")))
    if not other:
        return error("friend_not_found", 404)
    return web.json_response(
        {"id": other["id"], "name": other["name"], "avatar": f"a/{other['avatar']}.jpg" if other["avatar"] else None, "self": other["id"] == user["id"]}
    )


@signed_in
async def friend_request(request: web.Request) -> web.Response:
    state: State = request.app["state"]
    user_id = request["user"]["id"]
    data = await body_json(request)
    if not state.count(("request", user_id), REQUESTS_PER_DAY, 86400):
        return error("friend_too_often", 429)
    try:
        async with state.lock:
            result, other = state.store.request_friend(user_id, str(data.get("code", "")))
    except StoreError as failure:
        return error(str(failure), 404 if str(failure) == "friend_not_found" else 400)
    return web.json_response({"result": result, "id": other, **social(state, user_id)})


def friend_action(name: str):
    @signed_in
    async def handler(request: web.Request) -> web.Response:
        state: State = request.app["state"]
        user_id = request["user"]["id"]
        data = await body_json(request)
        try:
            other = int(data.get("id"))
        except (TypeError, ValueError):
            return error("friend_not_found")
        try:
            async with state.lock:
                if name == "accept":
                    state.store.accept(user_id, other)
                elif name == "decline":
                    state.store.decline(user_id, other)
                elif name == "cancel":
                    state.store.cancel(user_id, other)
                elif name == "remove":
                    state.store.remove_friend(user_id, other)
        except StoreError as failure:
            return error(str(failure))
        return web.json_response(social(state, user_id))

    return handler


@web.middleware
async def guard(request: web.Request, handler):
    try:
        response = await handler(request)
    except web.HTTPException:
        raise
    except Exception:
        log.exception("request %s failed", request.path)
        return error("account_failed", 500)
    if isinstance(response, web.WebSocketResponse) or response.prepared:
        return response
    if "Cache-Control" not in response.headers:
        response.headers["Cache-Control"] = "no-store"
    return response


@signed_in
async def party_ticket(request: web.Request) -> web.Response:
    state: State = request.app["state"]
    if not state.count(("ticket", request["user"]["id"]), 120, 3600):
        return error("party_busy", 429)
    return web.json_response({"ticket": state.party.ticket(request["user"]["id"])})


async def party_socket(request: web.Request) -> web.StreamResponse:
    return await request.app["state"].party.handle(request)


@signed_in
async def party_wait(request: web.Request) -> web.Response:
    invites = await request.app["state"].party.wait_invites(request["user"]["id"])
    return web.json_response({"invites": invites})


async def begin(app: web.Application) -> None:
    app["state"].party.start()


async def stop(app: web.Application) -> None:
    await app["state"].party.stop()
    await app["state"].client.aclose()


def build() -> web.Application:
    app = web.Application(middlewares=[guard], client_max_size=BACKUP_LIMIT + 1024)
    app["state"] = State()
    app.router.add_get("/config", config)
    app.router.add_post("/auth/google", sign_in_google)
    app.router.add_post("/auth/dev", sign_in_dev)
    app.router.add_post("/auth/signout", sign_out)
    app.router.add_post("/auth/signout-all", sign_out_everywhere)
    app.router.add_get("/me", me)
    app.router.add_patch("/me", update_me)
    app.router.add_delete("/me", delete_me)
    app.router.add_get(r"/a/{avatar:[A-Za-z0-9_\-]{8,40}}.jpg", avatar)
    app.router.add_get("/sync", get_backup)
    app.router.add_put("/sync", put_backup)
    app.router.add_post("/presence", presence)
    app.router.add_get("/friends/lookup", lookup)
    app.router.add_post("/friends/request", friend_request)
    for name in ("accept", "decline", "cancel", "remove"):
        app.router.add_post(f"/friends/{name}", friend_action(name))
    app.router.add_post("/party/ticket", party_ticket)
    app.router.add_get("/party/ws", party_socket)
    app.router.add_get("/party/wait", party_wait)
    app.on_startup.append(begin)
    app.on_cleanup.append(stop)
    return app


def main() -> None:
    web.run_app(build(), host=HOST, port=PORT, access_log=None)


if __name__ == "__main__":
    main()
