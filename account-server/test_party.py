import asyncio
import os
import tempfile
import time

os.environ.setdefault("ACCOUNT_DATA", tempfile.mkdtemp())
os.environ["ACCOUNT_DEV_KEY"] = "dev-test-key"

from aiohttp.test_utils import AioHTTPTestCase

import party
import server

server.DEV_KEY = "dev-test-key"
MEDIA = {"type": "movie", "id": 438631, "title": "Дюна", "infoHash": "a" * 40, "fileIndex": 0, "releaseId": "6112345", "fileName": "Dune.mkv", "size": 1000}


class Party(AioHTTPTestCase):
    async def get_application(self):
        return server.build()

    async def login(self, sub: str, name: str) -> dict:
        response = await self.client.post("/auth/dev", json={"sub": sub, "name": name, "email": f"{sub}@t"}, headers={"X-Dev-Key": "dev-test-key"})
        return await response.json()

    async def socket(self, token: str):
        response = await self.client.post("/party/ticket", headers={"Authorization": f"Bearer {token}"})
        ticket = (await response.json())["ticket"]
        return await self.client.ws_connect(f"/party/ws?ticket={ticket}")

    async def until(self, ws, kind: str, check=None, limit: float = 3.0):
        deadline = time.time() + limit
        while time.time() < deadline:
            message = await asyncio.wait_for(ws.receive_json(), deadline - time.time())
            if message.get("t") == kind and (check is None or check(message)):
                return message
        raise AssertionError(f"no {kind}")

    async def pair(self, media=MEDIA, settings=None):
        a = await self.login("pa-" + str(time.time_ns()), "Аня")
        b = await self.login("pb-" + str(time.time_ns()), "Борис")
        wa = await self.socket(a["token"])
        await wa.send_json({"t": "create", "proto": 1, "media": media, "settings": settings or {}})
        room = await self.until(wa, "room")
        wb = await self.socket(b["token"])
        await wb.send_json({"t": "join", "proto": 1, "code": room["code"].lower()})
        joined = await self.until(wb, "room")
        return a, b, wa, wb, room, joined

    async def test_create_join_and_errors(self):
        a, b, wa, wb, room, joined = await self.pair()
        self.assertEqual(len(room["code"]), 6)
        self.assertEqual(joined["media"]["title"], "Дюна")
        self.assertEqual([m["name"] for m in joined["members"]], ["Аня", "Борис"])
        self.assertEqual(joined["host"], a["account"]["id"])
        c = await self.login("pc-" + str(time.time_ns()), "Вика")
        wc = await self.socket(c["token"])
        await wc.send_json({"t": "join", "proto": 1, "code": "ZZZZZZ"})
        self.assertEqual((await self.until(wc, "error"))["code"], "party_not_found")
        wd = await self.socket(c["token"])
        await wd.send_json({"t": "join", "proto": 0, "code": room["code"]})
        self.assertEqual((await self.until(wd, "error"))["code"], "party_old_app")
        response = await self.client.get("/party/ws?ticket=nope")
        self.assertEqual(response.status, 401)
        for ws in (wa, wb):
            await ws.close()

    async def test_clock_gate_pause_and_seek(self):
        a, b, wa, wb, room, joined = await self.pair()
        before = time.time()
        await wa.send_json({"t": "ping", "c": 123})
        pong = await self.until(wa, "pong")
        self.assertEqual(pong["c"], 123)
        self.assertTrue(before - 1 < pong["s"] < time.time() + 1)
        await wb.send_json({"t": "control", "a": "play"})
        gate = (await self.until(wa, "state", lambda m: m["state"]["gate"]))["state"]["gate"]
        self.assertEqual(sorted(gate["waiting"]), sorted([a["account"]["id"], b["account"]["id"]]))
        await wa.send_json({"t": "ready", "gate": gate["id"]})
        still = (await self.until(wb, "state", lambda m: m["state"]["gate"] and len(m["state"]["gate"]["waiting"]) == 1))["state"]
        self.assertFalse(still["playing"])
        await wb.send_json({"t": "ready", "gate": gate["id"]})
        started = (await self.until(wa, "state", lambda m: m["state"]["playing"]))["state"]
        self.assertGreater(started["at"], time.time())
        self.assertLess(started["at"], time.time() + 1.5)
        self.assertEqual(started["pos"], 0)
        await asyncio.sleep(1.2)
        await wb.send_json({"t": "control", "a": "pause", "pos": 0.35})
        paused = (await self.until(wa, "state", lambda m: not m["state"]["playing"] and m["state"]["reason"] == "pause"))["state"]
        self.assertAlmostEqual(paused["pos"], 0.35)
        self.assertEqual(paused["by"], b["account"]["id"])
        await wa.send_json({"t": "control", "a": "seek", "pos": 600})
        sought = (await self.until(wb, "state", lambda m: m["state"]["reason"] == "seek"))["state"]
        self.assertEqual(sought["pos"], 600)
        self.assertFalse(sought["gate"]["resume"])
        await wa.send_json({"t": "ready", "gate": sought["gate"]["id"]})
        await wb.send_json({"t": "ready", "gate": sought["gate"]["id"]})
        ready = (await self.until(wa, "state", lambda m: m["state"]["reason"] == "ready"))["state"]
        self.assertFalse(ready["playing"])
        self.assertEqual(ready["pos"], 600)
        for ws in (wa, wb):
            await ws.close()

    async def test_stall_skip_and_countdown(self):
        a, b, wa, wb, room, joined = await self.pair()
        await wa.send_json({"t": "control", "a": "play"})
        gate = (await self.until(wa, "state", lambda m: m["state"]["gate"]))["state"]["gate"]
        for ws in (wa, wb):
            await ws.send_json({"t": "ready", "gate": gate["id"]})
        started = (await self.until(wa, "state", lambda m: m["state"]["playing"]))["state"]
        await asyncio.sleep(max(0, started["at"] - time.time()) + 0.3)
        await wb.send_json({"t": "stall", "pos": 0.2})
        stalled = (await self.until(wa, "state", lambda m: m["state"]["reason"] == "stall"))["state"]
        self.assertTrue(stalled["gate"]["resume"])
        self.assertLessEqual(stalled["gate"]["pos"], 0.4)
        await wa.send_json({"t": "ready", "gate": stalled["gate"]["id"]})
        await asyncio.sleep(1.6)
        await wa.send_json({"t": "skip", "id": b["account"]["id"]})
        resumed = (await self.until(wa, "state", lambda m: m["state"]["playing"]))["state"]
        self.assertTrue(resumed["countdown"])
        self.assertGreater(resumed["at"], time.time() + 2.5)
        members = await self.until(wa, "members", lambda m: any(x["skipped"] for x in m["members"]))
        self.assertTrue(next(x for x in members["members"] if x["id"] == b["account"]["id"])["skipped"])
        await wb.send_json({"t": "status", "s": {"synced": True, "drift": 0.1}})
        cleared = await self.until(wa, "members", lambda m: not any(x["skipped"] for x in m["members"]))
        self.assertTrue(cleared)
        for ws in (wa, wb):
            await ws.close()

    async def test_host_only_control_and_settings(self):
        a, b, wa, wb, room, joined = await self.pair(settings={"control": "host"})
        await wb.send_json({"t": "control", "a": "play"})
        self.assertEqual((await self.until(wb, "error"))["code"], "party_not_allowed")
        await wb.send_json({"t": "settings", "settings": {"control": "all"}})
        await wa.send_json({"t": "settings", "settings": {"control": "all", "wait": False}})
        updated = await self.until(wb, "members", lambda m: m["settings"]["control"] == "all")
        self.assertFalse(updated["settings"]["wait"])
        await wb.send_json({"t": "control", "a": "play"})
        started = (await self.until(wa, "state", lambda m: m["state"]["playing"]))["state"]
        self.assertIsNone(started["gate"])
        await wa.send_json({"t": "host", "id": b["account"]["id"]})
        moved = await self.until(wb, "members", lambda m: m["host"] == b["account"]["id"])
        self.assertTrue(moved)
        await wb.send_json({"t": "media", "media": {**MEDIA, "title": "Дюна 2", "id": 693134}, "autostart": True})
        changed = await self.until(wa, "state", lambda m: m["media"]["title"] == "Дюна 2")
        self.assertEqual(changed["media"]["title"], "Дюна 2")
        await wa.send_json({"t": "media", "media": MEDIA})
        await wa.send_json({"t": "ping", "c": 1})
        await self.until(wa, "pong")
        for ws in (wa, wb):
            await ws.close()

    async def test_chat_reactions_typing_and_subtitles(self):
        a, b, wa, wb, room, joined = await self.pair()
        await wa.send_json({"t": "chat", "text": "  привет\x07  "})
        message = (await self.until(wb, "chat", lambda m: m["msg"]["kind"] == "text"))["msg"]
        self.assertEqual(message["text"], "привет")
        self.assertEqual(message["from"], a["account"]["id"])
        for index in range(8):
            await wa.send_json({"t": "chat", "text": f"m{index}"})
        await wa.send_json({"t": "react", "e": "fire"})
        await wa.send_json({"t": "react", "e": "nope"})
        reaction = await self.until(wb, "react")
        self.assertEqual(reaction["e"], "fire")
        await wa.send_json({"t": "typing"})
        await self.until(wb, "typing")
        await wb.send_json({"t": "subreq", "to": a["account"]["id"]})
        request = await self.until(wa, "subreq")
        self.assertEqual(request["from"], b["account"]["id"])
        await wa.send_json({"t": "subtext", "to": b["account"]["id"], "name": "rus.srt", "text": "1\n00:00:01,000 --> 00:00:02,000\nПривет\n"})
        sub = await self.until(wb, "subtext")
        self.assertEqual(sub["name"], "rus.srt")
        c = await self.login("pc-" + str(time.time_ns()), "Вика")
        wc = await self.socket(c["token"])
        await wc.send_json({"t": "join", "proto": 1, "code": room["code"]})
        snapshot = await self.until(wc, "room")
        texts = [m.get("text") for m in snapshot["chat"] if m["kind"] == "text"]
        self.assertIn("привет", texts)
        self.assertLessEqual(len(texts), 5)
        for ws in (wa, wb, wc):
            await ws.close()

    async def test_invites_and_friend_room(self):
        a, b, wa, wb, room, joined = await self.pair(settings={"friends": True})
        c = await self.login("pc-" + str(time.time_ns()), "Вика")
        headers_a = {"Authorization": f"Bearer {a['token']}"}
        headers_c = {"Authorization": f"Bearer {c['token']}"}
        await wa.send_json({"t": "invite", "to": c["account"]["id"]})
        waiting = asyncio.ensure_future(self.client.get("/party/wait", headers=headers_c))
        await asyncio.sleep(0.3)
        self.assertFalse(waiting.done())
        await self.client.post("/friends/request", json={"code": c["account"]["code"]}, headers=headers_a)
        await self.client.post("/friends/accept", json={"id": a["account"]["id"]}, headers=headers_c)
        await wa.send_json({"t": "invite", "to": c["account"]["id"]})
        await self.until(wa, "invited")
        response = await asyncio.wait_for(waiting, 3)
        invites = (await response.json())["invites"]
        self.assertEqual(invites[0]["code"], room["code"])
        self.assertEqual(invites[0]["title"], "Дюна")
        presence = await (await self.client.post("/presence", json={}, headers=headers_c)).json()
        friend = next(item for item in presence["friends"] if item["id"] == a["account"]["id"])
        self.assertEqual(friend["room"]["code"], room["code"])
        for ws in (wa, wb):
            await ws.close()

    async def test_reconnect_seat_kick_and_moves(self):
        a, b, wa, wb, room, joined = await self.pair()
        await wa.send_json({"t": "control", "a": "play"})
        gate = (await self.until(wa, "state", lambda m: m["state"]["gate"]))["state"]["gate"]
        await wa.send_json({"t": "ready", "gate": gate["id"]})
        await wb.close()
        started = await self.until(wa, "state", lambda m: m["state"]["playing"])
        self.assertTrue(started)
        offline = await self.until(wa, "members", lambda m: any(not x["online"] for x in m["members"]))
        self.assertEqual(len(offline["members"]), 2)
        wb2 = await self.socket(b["token"])
        await wb2.send_json({"t": "join", "proto": 1, "code": room["code"]})
        again = await self.until(wb2, "room")
        self.assertEqual(sum(1 for m in again["members"] if m["online"]), 2)
        wb3 = await self.socket(b["token"])
        await wb3.send_json({"t": "join", "proto": 1, "code": room["code"]})
        await self.until(wb3, "room")
        await self.until(wb2, "moved")
        await wa.send_json({"t": "kick", "id": b["account"]["id"]})
        await self.until(wb3, "kicked")
        wb4 = await self.socket(b["token"])
        await wb4.send_json({"t": "join", "proto": 1, "code": room["code"]})
        self.assertEqual((await self.until(wb4, "error"))["code"], "party_banned")
        holder = self.app["state"].party
        member = holder.rooms[room["code"]].members[a["account"]["id"]]
        await wa.close()
        await asyncio.sleep(0.2)
        member.left_at = time.time() - party.SEAT_HOLD_SECONDS - 1
        await holder.sweep()
        self.assertEqual(len(holder.rooms[room["code"]].members), 0)
        holder.rooms[room["code"]].empty_since = time.time() - party.EMPTY_CLOSE_SECONDS - 1
        await holder.sweep()
        self.assertNotIn(room["code"], holder.rooms)


    async def test_gate_gives_up_on_stuck_members(self):
        a, b, wa, wb, room, joined = await self.pair()
        holder = self.app["state"].party
        live = holder.rooms[room["code"]]
        await wb.send_json({"t": "status", "s": {"loaded": False}})
        await wa.send_json({"t": "control", "a": "play"})
        gate = (await self.until(wa, "state", lambda m: m["state"]["gate"]))["state"]["gate"]
        await wa.send_json({"t": "ready", "gate": gate["id"]})
        await self.until(wa, "state", lambda m: m["state"]["gate"] and len(m["state"]["gate"]["waiting"]) == 1)
        live.gate["since"] = time.time() - party.GATE_STUCK_SECONDS + 5
        await holder.sweep()
        self.assertIsNotNone(live.gate)
        live.gate["since"] = time.time() - party.GATE_STUCK_SECONDS - 1
        await holder.sweep()
        started = (await self.until(wa, "state", lambda m: m["state"]["playing"]))["state"]
        self.assertIsNone(started["gate"])
        members = await self.until(wa, "members", lambda m: any(x["skipped"] for x in m["members"]))
        self.assertTrue(next(x for x in members["members"] if x["id"] == b["account"]["id"])["skipped"])
        note = (await self.until(wa, "chat", lambda m: m["msg"]["kind"] == "skipped"))["msg"]
        self.assertEqual(note["target"], b["account"]["id"])
        self.assertEqual(note["from"], 0)
        await wb.send_json({"t": "status", "s": {"loaded": True, "synced": True}})
        await self.until(wa, "members", lambda m: not any(x["skipped"] for x in m["members"]))
        await wa.send_json({"t": "control", "a": "seek", "pos": 300})
        sought = (await self.until(wa, "state", lambda m: m["state"]["reason"] == "seek"))["state"]
        await wa.send_json({"t": "ready", "gate": sought["gate"]["id"]})
        await wb.send_json({"t": "status", "s": {"loaded": True, "pct": 50}})
        await self.until(wa, "member", lambda m: m["status"].get("pct") == 50)
        live.gate["since"] = time.time() - party.GATE_STUCK_SECONDS - 1
        await holder.sweep()
        self.assertEqual(live.gate["waiting"], {b["account"]["id"]})
        live.gate["since"] = time.time() - party.GATE_GIVE_UP_SECONDS - 1
        await holder.sweep()
        self.assertIsNone(live.gate)
        self.assertTrue(live.playing)
        for ws in (wa, wb):
            await ws.close()

if __name__ == "__main__":
    import unittest

    unittest.main()
