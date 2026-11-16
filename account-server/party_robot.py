import argparse
import asyncio
import json
import os
import statistics
import time

import aiohttp


def stamp() -> str:
    return time.strftime("%H:%M:%S")


class Robot:
    def __init__(self, base: str, name: str, sub: str, load_seconds: float) -> None:
        self.base = base.rstrip("/") + "/"
        self.name = name
        self.sub = sub
        self.load_seconds = load_seconds
        self.offset = 0.0
        self.samples: list = []
        self.state: dict | None = None
        self.media: dict | None = None
        self.me = 0
        self.code = ""
        self.members: dict = {}
        self.ready_sent = ""
        self.gate_seen: dict = {}
        self.drifts: dict = {}
        self.stalled_until = 0.0
        self.ws = None

    def server_now(self) -> float:
        return time.time() + self.offset

    def position(self) -> float:
        state = self.state
        if not state:
            return 0.0
        now = self.server_now()
        if state["playing"] and now > state["at"]:
            return state["pos"] + (now - state["at"]) * state["rate"]
        return state["pos"]

    async def send(self, message: dict) -> None:
        await self.ws.send_json(message)

    async def login(self, session: aiohttp.ClientSession) -> str:
        async with session.post(self.base + "auth/dev", json={"sub": self.sub, "name": self.name, "email": f"{self.sub}@robot"}, headers={"X-Dev-Key": os.environ["ACCOUNT_DEV_KEY"]}) as response:
            data = await response.json()
        token = data["token"]
        async with session.post(self.base + "party/ticket", headers={"Authorization": f"Bearer {token}"}) as response:
            return (await response.json())["ticket"]

    async def pinger(self) -> None:
        for _ in range(8):
            await self.send({"t": "ping", "c": time.time()})
            await asyncio.sleep(0.12)
        while True:
            await asyncio.sleep(15)
            await self.send({"t": "ping", "c": time.time()})

    async def status_loop(self) -> None:
        while True:
            await asyncio.sleep(2)
            gate = self.state.get("gate") if self.state else None
            waiting = time.time() < self.stalled_until
            pct = 100
            if gate:
                seen = self.gate_seen.setdefault(gate["id"], time.time())
                pct = min(100, int((time.time() - seen) / max(0.1, self.load_seconds) * 100))
            await self.send({"t": "status", "s": {"loaded": True, "waiting": waiting, "drift": 0.0, "synced": not gate and not waiting, "pct": pct, "ahead": 30, "audio": {"label": "Дубляж (робот)", "lang": "ru", "kind": "internal", "index": 0}, "sub": {"label": "", "lang": "", "kind": "none"}}})

    async def gate_loop(self) -> None:
        while True:
            await asyncio.sleep(0.2)
            gate = self.state.get("gate") if self.state else None
            if not gate or self.me not in gate["waiting"] or self.ready_sent == gate["id"]:
                continue
            seen = self.gate_seen.setdefault(gate["id"], time.time())
            if time.time() - seen >= self.load_seconds and time.time() >= self.stalled_until:
                self.ready_sent = gate["id"]
                await self.send({"t": "ready", "gate": gate["id"]})
                print(stamp(), "robot ready for gate", gate["id"], f"after {time.time() - seen:.1f}s", flush=True)

    async def script(self, steps: list) -> None:
        for step in steps:
            wait, action, *rest = step.split(":")
            await asyncio.sleep(float(wait))
            value = rest[0] if rest else None
            print(stamp(), "robot does", action, value or "", f"at room pos {self.position():.2f}", flush=True)
            if action == "pause":
                await self.send({"t": "control", "a": "pause", "pos": self.position()})
            elif action == "play":
                await self.send({"t": "control", "a": "play"})
            elif action == "seek":
                await self.send({"t": "control", "a": "seek", "pos": float(value)})
            elif action == "rate":
                await self.send({"t": "control", "a": "rate", "rate": float(value)})
            elif action == "stall":
                self.stalled_until = time.time() + float(value or 5)
                await self.send({"t": "stall", "pos": self.position()})
            elif action == "chat":
                await self.send({"t": "chat", "text": value or "привет от робота"})
            elif action == "react":
                await self.send({"t": "react", "e": value or "fire"})
            elif action == "leave":
                await self.send({"t": "leave"})
                return

    def report(self, final: bool = False) -> None:
        for member_id, values in self.drifts.items():
            recent = [abs(value) for value in values[-30:]]
            if not recent:
                continue
            name = self.members.get(member_id, {}).get("name", member_id)
            print(stamp(), "drift", name, f"median={statistics.median(recent):.3f}s max={max(recent):.3f}s samples={len(values)}", "FINAL" if final else "", flush=True)

    async def run(self, code: str, create: dict | None, steps: list, seconds: float) -> None:
        async with aiohttp.ClientSession() as session:
            ticket = await self.login(session)
            ws_url = self.base.replace("http", "ws", 1) + "party/ws?ticket=" + ticket
            async with session.ws_connect(ws_url) as ws:
                self.ws = ws
                hello = {"t": "create", "proto": 1, **(create or {})} if create else {"t": "join", "proto": 1, "code": code}
                await ws.send_json(hello)
                tasks = [asyncio.ensure_future(job) for job in (self.pinger(), self.status_loop(), self.gate_loop(), self.script(steps))]
                deadline = time.time() + seconds
                last_report = time.time()
                try:
                    while time.time() < deadline:
                        try:
                            message = await asyncio.wait_for(ws.receive(), 1.0)
                        except asyncio.TimeoutError:
                            message = None
                        if message is not None:
                            if message.type != aiohttp.WSMsgType.TEXT:
                                print(stamp(), "socket closed", flush=True)
                                break
                            self.handle(json.loads(message.data))
                        if time.time() - last_report > 15:
                            last_report = time.time()
                            self.report()
                finally:
                    self.report(final=True)
                    for task in tasks:
                        task.cancel()

    def handle(self, message: dict) -> None:
        kind = message.get("t")
        if kind == "pong":
            rtt = time.time() - message["c"]
            self.samples.append((rtt, message["s"] + rtt / 2 - time.time()))
            best = sorted(self.samples)[:3]
            self.offset = statistics.median(offset for _, offset in best)
            return
        if kind == "room":
            self.me = message["me"]
            self.code = message["code"]
            self.state = message["state"]
            self.media = message["media"]
            self.members = {member["id"]: member for member in message["members"]}
            print(stamp(), "ROOM", self.code, "members", [m["name"] for m in message["members"]], "media", (self.media or {}).get("title"), flush=True)
            return
        if kind == "state":
            self.state = message["state"]
            self.media = message.get("media")
            state = self.state
            gate = state.get("gate")
            print(stamp(), "state", state["reason"], "by", self.members.get(state["by"], {}).get("name", state["by"]), "playing" if state["playing"] else "paused", f"pos={state['pos']:.2f}", f"starts_in={state['at'] - self.server_now():.2f}" if state["playing"] else "", f"gate_waiting={[self.members.get(i, {}).get('name', i) for i in gate['waiting']]}" if gate else "", flush=True)
            return
        if kind == "members":
            self.members = {member["id"]: member for member in message["members"]}
            print(stamp(), "members", [(m["name"], "online" if m["online"] else "offline", "skipped" if m["skipped"] else "") for m in message["members"]], flush=True)
            return
        if kind == "member":
            status = message["status"]
            if message["id"] != self.me and "drift" in status:
                self.drifts.setdefault(message["id"], []).append(status["drift"])
            if message["id"] != self.me:
                name = self.members.get(message["id"], {}).get("name", message["id"])
                print(stamp(), "status", name, {key: status.get(key) for key in ("loaded", "waiting", "synced", "drift", "pct", "away", "ahead")}, flush=True)
            return
        if kind == "chat":
            msg = message["msg"]
            print(stamp(), "chat", msg.get("kind"), self.members.get(msg["from"], {}).get("name", msg["from"]), msg.get("text", msg.get("title", "")), flush=True)
            return
        if kind in ("react", "typing", "error", "kicked", "moved", "subreq", "invited"):
            print(stamp(), kind, {key: value for key, value in message.items() if key != "t"}, flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:18094/")
    parser.add_argument("--code", default="")
    parser.add_argument("--create", default="")
    parser.add_argument("--name", default="Робот")
    parser.add_argument("--sub", default="robot-1")
    parser.add_argument("--load", type=float, default=2.0)
    parser.add_argument("--seconds", type=float, default=300)
    parser.add_argument("steps", nargs="*")
    args = parser.parse_args()
    create = json.loads(args.create) if args.create else None
    asyncio.run(Robot(args.base, args.name, args.sub, args.load).run(args.code, create, args.steps, args.seconds))


if __name__ == "__main__":
    main()
