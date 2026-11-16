import asyncio
import json
import logging
import math
import re
import secrets
import time
from collections import deque

from aiohttp import WSMsgType, web

from store import clean_name

PROTO = 1
ROOM_LIMIT = 8
ROOMS_MAX = 3000
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 6
SEAT_HOLD_SECONDS = 120
EMPTY_CLOSE_SECONDS = 600
HELLO_SECONDS = 10
CHAT_KEEP = 50
CHAT_LIMIT = 500
START_DELAY = 0.8
COUNTDOWN_EXTRA = 3.0
COUNTDOWN_AFTER = 1.5
TICKET_SECONDS = 60
INVITE_SECONDS = 1800
WAIT_SECONDS = 25
WS_MAX = 640 * 1024
SUBTITLE_LIMIT = 600 * 1024
RATE_MIN = 0.25
RATE_MAX = 4.0
POSITION_MAX = 10 * 24 * 3600
REACTIONS = ("laugh", "wow", "scary", "sad", "fire", "heart")
SETTINGS = {"control": ("all", "host"), "wait": (True, False), "friends": (False, True), "autoNext": (True, False)}
MEDIA_TEXT = {"title": 200, "poster": 120, "year": 8, "episodeName": 200, "releaseId": 64, "fileName": 300, "quality": 40, "torrentName": 300, "pickId": 64, "donorId": 64}

log = logging.getLogger("party")


def now() -> float:
    return time.time()


def short(value, limit: int) -> str:
    return str(value or "")[:limit]


def number(value, low: float, high: float):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return value if low <= value <= high else None


def clean_media(value) -> dict | None:
    if not isinstance(value, dict):
        return None
    kind = value.get("type")
    ident = number(value.get("id"), 1, 10**9)
    info_hash = str(value.get("infoHash") or "").lower()
    file_index = number(value.get("fileIndex"), 0, 100000)
    if kind not in ("movie", "tv") or ident is None or not re.fullmatch(r"[0-9a-f]{40}", info_hash) or file_index is None:
        return None
    media = {"type": kind, "id": int(ident), "infoHash": info_hash, "fileIndex": int(file_index)}
    for field, limit in MEDIA_TEXT.items():
        if value.get(field):
            media[field] = clean_name(short(value.get(field), limit * 2))[:limit] if field in ("title", "episodeName") else short(value.get(field), limit)
    if "title" not in media:
        return None
    for field in ("season", "episode"):
        found = number(value.get(field), 0, 100000)
        if kind == "tv" and found is not None:
            media[field] = int(found)
    size = number(value.get("size"), 0, 10**15)
    if size is not None:
        media["size"] = int(size)
    tags = value.get("tags")
    if isinstance(tags, list):
        media["tags"] = [short(tag, 30) for tag in tags[:12] if isinstance(tag, str)]
    return media


def clean_suggest(value) -> dict | None:
    if not isinstance(value, dict):
        return None
    kind = value.get("type")
    ident = number(value.get("id"), 1, 10**9)
    title = clean_name(short(value.get("title"), 400))[:200]
    if kind not in ("movie", "tv") or ident is None or not title:
        return None
    suggest = {"type": kind, "id": int(ident), "title": title}
    poster = short(value.get("poster"), 120)
    if re.fullmatch(r"/[A-Za-z0-9_\-]+\.(jpg|png|webp)", poster):
        suggest["poster"] = poster
    if value.get("year"):
        suggest["year"] = short(value.get("year"), 8)
    return suggest


def clean_track(value) -> dict | None:
    if not isinstance(value, dict):
        return None
    track = {"label": short(value.get("label"), 120), "lang": short(value.get("lang"), 12), "kind": short(value.get("kind"), 16)}
    index = number(value.get("index"), -1, 1000)
    if index is not None:
        track["index"] = int(index)
    return track


def clean_status(value) -> dict:
    if not isinstance(value, dict):
        return {}
    status = {}
    for field in ("loaded", "waiting", "away", "synced", "has", "behind"):
        if isinstance(value.get(field), bool):
            status[field] = value[field]
    for field, low, high in (("ahead", 0, 100000), ("drift", -100000, 100000), ("pct", 0, 100), ("down", 0, 10**11)):
        found = number(value.get(field), low, high)
        if found is not None:
            status[field] = round(found, 2)
    port = number(value.get("port"), 1, 65535)
    if port is not None:
        status["port"] = int(port)
    for field in ("audio", "sub"):
        track = clean_track(value.get(field))
        if track is not None:
            status[field] = track
    return status


def summary(status: dict) -> tuple:
    drift = status.get("drift", 0)
    band = 0 if abs(drift) < 0.5 else 1 if abs(drift) < 2 else 2
    return (
        status.get("loaded"),
        status.get("waiting"),
        status.get("away"),
        status.get("synced"),
        status.get("has"),
        status.get("behind"),
        band,
        int(status.get("pct", 0) // 5),
        json.dumps(status.get("audio"), sort_keys=True),
        json.dumps(status.get("sub"), sort_keys=True),
        status.get("port"),
    )


class Member:
    def __init__(self, user, ip: str) -> None:
        self.id = user["id"]
        self.name = user["name"]
        self.avatar = user["avatar"]
        self.joined = now()
        self.ws: web.WebSocketResponse | None = None
        self.online = True
        self.left_at = 0.0
        self.status: dict = {}
        self.status_key: tuple = ()
        self.skipped = False
        self.ip = ip
        self.counters: dict = {}

    def view(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "avatar": f"a/{self.avatar}.jpg" if self.avatar else None,
            "online": self.online,
            "skipped": self.skipped,
            "status": self.status,
            "ip": self.ip if self.online else "",
        }

    def allow(self, key: str, limit: int, window: float) -> bool:
        stamp = now()
        start, used = self.counters.get(key, (stamp, 0))
        if stamp - start > window:
            start, used = stamp, 0
        if used >= limit:
            return False
        self.counters[key] = (start, used + 1)
        return True

    def active(self) -> bool:
        return self.online and not self.skipped and not self.status.get("away", False)


class Room:
    def __init__(self, code: str, host: int) -> None:
        self.code = code
        self.host = host
        self.members: dict[int, Member] = {}
        self.banned: set[int] = set()
        self.settings = {"control": "all", "wait": True, "friends": False, "autoNext": True}
        self.media: dict | None = None
        self.seq = 0
        self.playing = False
        self.pos = 0.0
        self.at = now()
        self.rate = 1.0
        self.gate: dict | None = None
        self.by = 0
        self.reason = ""
        self.countdown = False
        self.chat: deque = deque(maxlen=CHAT_KEEP)
        self.chat_seq = 0
        self.empty_since = 0.0

    def position(self, stamp: float | None = None) -> float:
        stamp = now() if stamp is None else stamp
        if self.playing and stamp > self.at:
            return self.pos + (stamp - self.at) * self.rate
        return self.pos

    def state(self) -> dict:
        gate = None
        if self.gate:
            gate = {"id": self.gate["id"], "pos": self.gate["pos"], "resume": self.gate["resume"], "since": self.gate["since"], "waiting": sorted(self.gate["waiting"])}
        return {
            "seq": self.seq,
            "playing": self.playing,
            "pos": self.pos,
            "at": self.at,
            "rate": self.rate,
            "gate": gate,
            "by": self.by,
            "reason": self.reason,
            "countdown": self.countdown,
            "now": now(),
        }

    def ordered(self) -> list[Member]:
        return sorted(self.members.values(), key=lambda member: member.joined)

    def snapshot(self, me: int) -> dict:
        return {
            "t": "room",
            "proto": PROTO,
            "code": self.code,
            "me": me,
            "host": self.host,
            "settings": self.settings,
            "media": self.media,
            "state": self.state(),
            "members": [member.view() for member in self.ordered()],
            "chat": list(self.chat),
        }

    def can_control(self, user_id: int) -> bool:
        return self.settings["control"] == "all" or user_id == self.host

    def changed(self, by: int, reason: str, countdown: bool = False) -> None:
        self.seq += 1
        self.by = by
        self.reason = reason
        self.countdown = countdown

    def open_gate(self, pos: float, resume: bool, by: int, reason: str) -> None:
        waiting = {member.id for member in self.members.values() if member.active()} if self.settings["wait"] else set()
        self.playing = False
        self.pos = max(0.0, pos)
        self.at = now()
        self.gate = {"id": secrets.token_hex(4), "pos": self.pos, "resume": resume, "since": now(), "waiting": waiting}
        self.changed(by, reason)
        self.try_finish(by)

    def try_finish(self, by: int) -> bool:
        if not self.gate or self.gate["waiting"]:
            return False
        gate = self.gate
        self.gate = None
        waited = now() - gate["since"]
        countdown = gate["resume"] and waited > COUNTDOWN_AFTER
        self.pos = gate["pos"]
        if gate["resume"]:
            self.playing = True
            self.at = now() + START_DELAY + (COUNTDOWN_EXTRA if countdown else 0)
        else:
            self.playing = False
            self.at = now()
        self.changed(by, "start" if gate["resume"] else "ready", countdown)
        return True

    def drop_waiting(self, user_id: int) -> bool:
        if self.gate and user_id in self.gate["waiting"]:
            self.gate["waiting"].discard(user_id)
            return self.try_finish(user_id) or True
        return False


class Party:
    def __init__(self, state) -> None:
        self.state = state
        self.rooms: dict[str, Room] = {}
        self.where: dict[int, str] = {}
        self.tickets: dict[str, tuple] = {}
        self.invites: dict[int, list] = {}
        self.waiters: dict[int, asyncio.Event] = {}
        self.sweeper: asyncio.Task | None = None
        self.jobs: set = set()

    def start(self) -> None:
        if self.sweeper is None:
            self.sweeper = asyncio.get_running_loop().create_task(self.sweep_forever())

    async def stop(self) -> None:
        if self.sweeper:
            self.sweeper.cancel()
        for room in list(self.rooms.values()):
            for member in room.members.values():
                if member.ws and not member.ws.closed:
                    await member.ws.close()

    def ticket(self, user_id: int) -> str:
        stamp = now()
        self.tickets = {key: value for key, value in self.tickets.items() if value[1] > stamp}
        token = secrets.token_urlsafe(24)
        self.tickets[token] = (user_id, stamp + TICKET_SECONDS)
        return token

    def use_ticket(self, token: str) -> int | None:
        found = self.tickets.pop(token, None)
        if not found or found[1] < now():
            return None
        return found[0]

    def room_of(self, user_id: int) -> Room | None:
        code = self.where.get(user_id)
        room = self.rooms.get(code) if code else None
        if room and user_id in room.members:
            return room
        return None

    def friend_room(self, user_id: int) -> dict | None:
        room = self.room_of(user_id)
        if not room or not room.settings["friends"] or not room.members[user_id].online:
            return None
        return {"code": room.code, "title": room.media["title"] if room.media else None, "count": len(room.members)}

    def new_code(self) -> str:
        while True:
            code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
            if code not in self.rooms:
                return code

    async def send(self, member: Member, message: dict) -> None:
        ws = member.ws
        if ws is None or ws.closed:
            return
        try:
            await ws.send_str(json.dumps(message, ensure_ascii=False))
        except (ConnectionError, RuntimeError):
            pass

    async def broadcast(self, room: Room, message: dict, skip: int | None = None) -> None:
        text = json.dumps(message, ensure_ascii=False)
        targets = [member.ws for member in room.members.values() if member.ws is not None and not member.ws.closed and member.id != skip]
        await asyncio.gather(*(ws.send_str(text) for ws in targets), return_exceptions=True)

    async def push_state(self, room: Room) -> None:
        await self.broadcast(room, {"t": "state", "state": room.state(), "media": room.media})

    async def push_members(self, room: Room) -> None:
        await self.broadcast(room, {"t": "members", "host": room.host, "settings": room.settings, "members": [member.view() for member in room.ordered()]})

    async def system(self, room: Room, kind: str, user_id: int, extra: dict | None = None) -> None:
        room.chat_seq += 1
        message = {"id": room.chat_seq, "from": user_id, "kind": kind, "at": now(), "pos": room.position(), **(extra or {})}
        room.chat.append(message)
        await self.broadcast(room, {"t": "chat", "msg": message})

    async def remove(self, room: Room, user_id: int, reason: str) -> None:
        member = room.members.pop(user_id, None)
        if not member:
            return
        if self.where.get(user_id) == room.code:
            self.where.pop(user_id, None)
        room.drop_waiting(user_id)
        if room.host == user_id and room.members:
            room.host = room.ordered()[0].id
        if not room.members:
            room.empty_since = now()
        await self.system(room, reason, user_id, {"name": member.name})
        await self.push_members(room)
        await self.push_state(room)

    async def sweep_forever(self) -> None:
        while True:
            await asyncio.sleep(5)
            try:
                await self.sweep()
            except Exception:
                log.exception("party sweep failed")

    async def sweep(self) -> None:
        stamp = now()
        for room in list(self.rooms.values()):
            for member in list(room.members.values()):
                if not member.online and stamp - member.left_at > SEAT_HOLD_SECONDS:
                    await self.remove(room, member.id, "left")
            if not room.members and stamp - room.empty_since > EMPTY_CLOSE_SECONDS:
                self.rooms.pop(room.code, None)
        for user_id in list(self.invites):
            fresh = [invite for invite in self.invites[user_id] if stamp - invite["at"] < INVITE_SECONDS and invite["code"] in self.rooms]
            if fresh:
                self.invites[user_id] = fresh
            else:
                self.invites.pop(user_id, None)
        self.tickets = {key: value for key, value in self.tickets.items() if value[1] > stamp}

    async def wait_invites(self, user_id: int) -> list:
        pending = self.take_invites(user_id)
        if pending:
            return pending
        event = self.waiters.get(user_id)
        if event is None:
            event = asyncio.Event()
            self.waiters[user_id] = event
        try:
            await asyncio.wait_for(event.wait(), WAIT_SECONDS)
        except asyncio.TimeoutError:
            pass
        finally:
            if self.waiters.get(user_id) is event:
                self.waiters.pop(user_id, None)
        return self.take_invites(user_id)

    def take_invites(self, user_id: int) -> list:
        stamp = now()
        found = [invite for invite in self.invites.pop(user_id, []) if stamp - invite["at"] < INVITE_SECONDS and invite["code"] in self.rooms]
        return found

    def add_invite(self, user_id: int, invite: dict) -> None:
        listed = [item for item in self.invites.get(user_id, []) if item["code"] != invite["code"]]
        listed.append(invite)
        self.invites[user_id] = listed[-10:]
        event = self.waiters.get(user_id)
        if event:
            event.set()

    async def enter(self, room: Room, user, ws: web.WebSocketResponse, ip: str) -> Member:
        member = room.members.get(user["id"])
        if member:
            old = member.ws
            member.ws = ws
            member.online = True
            member.ip = ip
            member.name = user["name"]
            member.avatar = user["avatar"]
            if old is not None and old is not ws and not old.closed:
                await old.send_str(json.dumps({"t": "moved"}))
                await old.close()
            await self.push_members(room)
            return member
        previous = self.room_of(user["id"])
        if previous and previous is not room:
            old = previous.members[user["id"]].ws
            if old is not None and not old.closed:
                await old.send_str(json.dumps({"t": "moved"}))
                await old.close()
            await self.remove(previous, user["id"], "left")
        member = Member(user, ip)
        member.ws = ws
        room.members[member.id] = member
        self.where[member.id] = room.code
        await self.system(room, "joined", member.id, {"name": member.name})
        await self.push_members(room)
        return member

    async def handle(self, request: web.Request) -> web.StreamResponse:
        user_id = self.use_ticket(request.query.get("ticket", ""))
        user = self.state.store.user(user_id) if user_id else None
        if not user:
            return web.json_response({"error": "account_signed_out"}, status=401)
        ws = web.WebSocketResponse(heartbeat=20, max_msg_size=WS_MAX)
        await ws.prepare(request)
        ip = request.headers.get("X-Kinuza-IP", "") or (request.remote or "")
        room: Room | None = None
        member: Member | None = None
        try:
            hello = await asyncio.wait_for(ws.receive(), HELLO_SECONDS)
        except asyncio.TimeoutError:
            await ws.close()
            return ws
        if hello.type != WSMsgType.TEXT:
            await ws.close()
            return ws
        try:
            first = json.loads(hello.data)
        except ValueError:
            first = {}
        kind = first.get("t") if isinstance(first, dict) else None
        if first.get("proto") != PROTO:
            await ws.send_str(json.dumps({"t": "error", "code": "party_old_app"}))
            await ws.close()
            return ws
        if kind == "create":
            if len(self.rooms) >= ROOMS_MAX or not self.state.count(("room", user["id"]), 30, 3600):
                await ws.send_str(json.dumps({"t": "error", "code": "party_busy"}))
                await ws.close()
                return ws
            room = Room(self.new_code(), user["id"])
            settings = first.get("settings")
            if isinstance(settings, dict):
                for key, allowed in SETTINGS.items():
                    if settings.get(key) in allowed:
                        room.settings[key] = settings[key]
            media = clean_media(first.get("media"))
            if media:
                room.media = media
                start = number(first.get("pos"), 0, POSITION_MAX)
                room.pos = float(start or 0)
            self.rooms[room.code] = room
            log.info("party: room made by user=%s", user["id"])
        elif kind == "join":
            room = self.rooms.get(re.sub(r"[^A-Z0-9]", "", str(first.get("code", "")).upper())[:CODE_LENGTH])
            failure = None
            if room is None:
                failure = "party_not_found"
            elif user["id"] in room.banned:
                failure = "party_banned"
            elif user["id"] not in room.members and len(room.members) >= ROOM_LIMIT:
                failure = "party_full"
            if failure:
                await ws.send_str(json.dumps({"t": "error", "code": failure}))
                await ws.close()
                return ws
        else:
            await ws.close()
            return ws
        member = await self.enter(room, user, ws, ip)
        await ws.send_str(json.dumps(room.snapshot(member.id), ensure_ascii=False))
        try:
            async for message in ws:
                if message.type != WSMsgType.TEXT:
                    continue
                try:
                    data = json.loads(message.data)
                except ValueError:
                    continue
                if not isinstance(data, dict):
                    continue
                if data.get("t") == "ping":
                    await ws.send_str(json.dumps({"t": "pong", "c": data.get("c"), "s": now()}))
                    continue
                if room.members.get(member.id) is not member:
                    break
                if data.get("t") == "leave":
                    await self.remove(room, member.id, "left")
                    break
                try:
                    await self.act(room, member, data)
                except Exception:
                    log.exception("party: message %s failed", data.get("t"))
        finally:
            if room.members.get(member.id) is member and member.ws is ws:
                member.online = False
                member.ws = None
                member.left_at = now()
                self.later(self.went_offline(room, room.drop_waiting(member.id)))
        return ws

    def later(self, job) -> None:
        task = asyncio.get_running_loop().create_task(job)
        self.jobs.add(task)
        task.add_done_callback(self.jobs.discard)

    async def went_offline(self, room: Room, changed: bool) -> None:
        if changed:
            await self.push_state(room)
        await self.push_members(room)

    async def act(self, room: Room, member: Member, data: dict) -> None:
        kind = data.get("t")
        me = member.id
        if kind == "control":
            await self.control(room, member, data)
        elif kind == "ready":
            if room.gate and data.get("gate") == room.gate["id"] and room.drop_waiting(me):
                await self.push_state(room)
        elif kind == "stall":
            pos = number(data.get("pos"), 0, POSITION_MAX)
            if room.playing and room.gate is None and room.settings["wait"] and member.active() and now() >= room.at:
                current = room.position()
                start = pos if pos is not None and abs(pos - current) < 5 else current
                room.open_gate(min(start, current), True, me, "stall")
                await self.push_state(room)
        elif kind == "status":
            status = clean_status(data.get("s"))
            member.status = status
            if member.skipped and status.get("synced"):
                member.skipped = False
                await self.push_members(room)
            key = summary(status)
            if key != member.status_key and member.allow("status", 4, 1):
                member.status_key = key
                await self.broadcast(room, {"t": "member", "id": me, "status": status})
        elif kind == "media":
            media = clean_media(data.get("media"))
            if not media or me != room.host:
                return
            room.media = media
            start = float(number(data.get("pos"), 0, POSITION_MAX) or 0)
            if data.get("autostart"):
                room.open_gate(start, True, me, "media")
            else:
                room.gate = None
                room.playing = False
                room.pos = start
                room.at = now()
                room.changed(me, "media")
            await self.push_state(room)
            await self.system(room, "media", me, {"title": media["title"], "season": media.get("season"), "episode": media.get("episode")})
        elif kind == "skip":
            target = room.members.get(number(data.get("id"), 1, 10**12) or 0)
            if not target or not room.can_control(me):
                return
            target.skipped = True
            if room.drop_waiting(target.id):
                await self.push_state(room)
            await self.push_members(room)
            await self.system(room, "skipped", me, {"name": target.name, "target": target.id})
        elif kind == "chat":
            text = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", str(data.get("text", ""))).strip()[:CHAT_LIMIT]
            if not text or not member.allow("chat", 5, 5):
                return
            room.chat_seq += 1
            message = {"id": room.chat_seq, "from": me, "kind": "text", "text": text, "at": now(), "pos": room.position()}
            suggest = clean_suggest(data.get("suggest"))
            if suggest:
                message["suggest"] = suggest
            room.chat.append(message)
            await self.broadcast(room, {"t": "chat", "msg": message})
        elif kind == "react":
            if data.get("e") in REACTIONS and member.allow("react", 10, 10):
                await self.broadcast(room, {"t": "react", "from": me, "e": data["e"]})
        elif kind == "typing":
            if member.allow("typing", 1, 2):
                await self.broadcast(room, {"t": "typing", "from": me}, skip=me)
        elif kind == "settings":
            if me != room.host or not isinstance(data.get("settings"), dict):
                return
            for key, allowed in SETTINGS.items():
                value = data["settings"].get(key)
                if value in allowed:
                    room.settings[key] = value
            if not room.settings["wait"] and room.gate:
                room.gate["waiting"] = set()
                room.try_finish(me)
                await self.push_state(room)
            await self.push_members(room)
        elif kind == "host":
            target = number(data.get("id"), 1, 10**12)
            if me == room.host and target in room.members:
                room.host = int(target)
                await self.push_members(room)
                await self.system(room, "host", int(target), {"name": room.members[int(target)].name})
        elif kind == "kick":
            target = room.members.get(number(data.get("id"), 1, 10**12) or 0)
            if me != room.host or not target or target.id == me:
                return
            room.banned.add(target.id)
            await self.send(target, {"t": "kicked"})
            ws = target.ws
            await self.remove(room, target.id, "kicked")
            if ws is not None and not ws.closed:
                await ws.close()
        elif kind == "invite":
            to = number(data.get("to"), 1, 10**12)
            if to is None or to in room.members or not self.state.store.are_friends(me, int(to)) or not member.allow("invite", 20, 3600):
                return
            self.add_invite(
                int(to),
                {"code": room.code, "from": me, "name": member.name, "avatar": f"a/{member.avatar}.jpg" if member.avatar else None, "title": room.media["title"] if room.media else None, "at": now()},
            )
            await self.send(member, {"t": "invited", "to": int(to)})
        elif kind == "subreq":
            target = room.members.get(number(data.get("to"), 1, 10**12) or 0)
            if target and target.id != me and member.allow("subreq", 6, 60):
                await self.send(target, {"t": "subreq", "from": me})
        elif kind == "subtext":
            target = room.members.get(number(data.get("to"), 1, 10**12) or 0)
            text = str(data.get("text", ""))
            if target and len(text) <= SUBTITLE_LIMIT and member.allow("subtext", 6, 60):
                await self.send(target, {"t": "subtext", "from": me, "name": short(data.get("name"), 200), "text": text})

    async def control(self, room: Room, member: Member, data: dict) -> None:
        me = member.id
        if not room.can_control(me):
            await self.send(member, {"t": "error", "code": "party_not_allowed"})
            return
        if room.media is None:
            return
        action = data.get("a")
        pos = number(data.get("pos"), 0, POSITION_MAX)
        if action == "pause":
            if not room.playing and room.gate is None:
                return
            current = room.position()
            room.gate = None
            room.playing = False
            room.pos = float(pos) if pos is not None and abs(pos - current) < 10 else current
            room.at = now()
            room.changed(me, "pause")
        elif action == "play":
            if room.playing or (room.gate and room.gate["resume"]):
                return
            start = room.gate["pos"] if room.gate else room.pos
            room.open_gate(start, True, me, "play")
        elif action == "seek":
            if pos is None:
                return
            resume = room.playing or bool(room.gate and room.gate["resume"])
            room.open_gate(float(pos), resume, me, "seek")
        elif action == "rate":
            rate = number(data.get("rate"), RATE_MIN, RATE_MAX)
            if rate is None:
                return
            stamp = max(now(), room.at)
            room.pos = room.position(stamp)
            room.at = stamp
            room.rate = float(rate)
            room.changed(me, "rate")
        else:
            return
        await self.push_state(room)
