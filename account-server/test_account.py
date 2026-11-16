import base64
import gzip
import json
import os
import tempfile
import time
import unittest

os.environ["ACCOUNT_DATA"] = tempfile.mkdtemp()
os.environ["ACCOUNT_DEV_KEY"] = "dev-test-key"

from aiohttp.test_utils import AioHTTPTestCase

import google
import server
from store import clean_code, clean_name

server.DEV_KEY = "dev-test-key"
PIXEL = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 40).decode()


def token_for(claims: dict) -> str:
    body = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"e30.{body}.sig"


class Google(unittest.TestCase):
    def setUp(self):
        self.claims = {"iss": "https://accounts.google.com", "aud": "client", "exp": time.time() + 600, "iat": time.time(), "sub": "1234567890", "email": "a@b.c", "email_verified": True, "given_name": "Аня"}

    def test_good_token(self):
        identity = google.checked_identity(google.claims_of(token_for(self.claims)), "client")
        self.assertEqual(identity, {"sub": "1234567890", "email": "a@b.c", "name": "Аня"})

    def test_bad_tokens(self):
        for change, code in [({"aud": "other"}, "google_bad_audience"), ({"iss": "evil"}, "google_bad_issuer"), ({"exp": time.time() - 3600}, "google_expired"), ({"email_verified": False}, "google_email_unverified")]:
            with self.assertRaises(google.GoogleError) as caught:
                google.checked_identity({**self.claims, **change}, "client")
            self.assertEqual(str(caught.exception), code)

    def test_redirect_must_be_loopback(self):
        self.assertTrue(google.loopback_redirect("http://127.0.0.1:53111/"))
        self.assertFalse(google.loopback_redirect("https://evil.com/"))
        self.assertFalse(google.loopback_redirect("http://127.0.0.1:53111/x"))


class Cleaning(unittest.TestCase):
    def test_codes_and_names(self):
        self.assertEqual(clean_code("abcd-efgh"), "ABCDEFGH")
        self.assertEqual(clean_code("0O1I"), "")
        self.assertEqual(clean_name("  Аня   ‮  К "), "Аня К")


class Flow(AioHTTPTestCase):
    async def get_application(self):
        return server.build()

    async def sign_in(self, sub: str, name: str) -> tuple:
        response = await self.client.post("/auth/dev", json={"sub": sub, "name": name}, headers={"X-Dev-Key": "dev-test-key"})
        self.assertEqual(response.status, 200)
        data = await response.json()
        return {"Authorization": f"Bearer {data['token']}"}, data["account"]

    async def test_dev_login_needs_the_key(self):
        response = await self.client.post("/auth/dev", json={"sub": "1"})
        self.assertEqual(response.status, 404)

    async def test_signed_out_requests_are_refused(self):
        response = await self.client.get("/me", headers={"Authorization": "Bearer nope"})
        self.assertEqual(response.status, 401)

    async def test_backup_revisions_and_conflicts(self):
        auth, _ = await self.sign_in("2000000001", "Backup")
        response = await self.client.get("/sync", headers=auth)
        self.assertEqual((response.status, response.headers["X-Revision"]), (204, "0"))
        payload = gzip.compress(b'{"a":1}')
        response = await self.client.put("/sync", data=payload, headers={**auth, "If-Match": "0"})
        self.assertEqual((await response.json())["revision"], 1)
        server.SYNC_GAP_SECONDS = 0
        response = await self.client.put("/sync", data=payload, headers={**auth, "If-Match": "0"})
        self.assertEqual(response.status, 409)
        self.assertEqual((await response.json())["revision"], 1)
        response = await self.client.get("/sync", headers={**auth, "If-None-Match": "1"})
        self.assertEqual(response.status, 304)
        response = await self.client.get("/sync", headers=auth)
        self.assertEqual(gzip.decompress(await response.read()), b'{"a":1}')
        response = await self.client.put("/sync", data=b"plain", headers={**auth, "If-Match": "1"})
        self.assertEqual(response.status, 400)

    async def test_friends_presence_and_privacy(self):
        anna, anna_account = await self.sign_in("3000000001", "Anna")
        boris, boris_account = await self.sign_in("3000000002", "Boris")
        response = await self.client.post("/friends/request", json={"code": boris_account["code"]}, headers=anna)
        self.assertEqual((await response.json())["result"], "sent")
        response = await self.client.post("/presence", json={}, headers=boris)
        incoming = (await response.json())["incoming"]
        self.assertEqual([person["name"] for person in incoming], ["Anna"])
        response = await self.client.post("/friends/accept", json={"id": anna_account["id"]}, headers=boris)
        self.assertEqual([friend["name"] for friend in (await response.json())["friends"]], ["Anna"])
        watching = {"type": "tv", "id": 45790, "title": "ДжоДжо", "poster": "/x.jpg", "season": 2, "episode": 7}
        await self.client.post("/presence", json={"watching": watching}, headers=anna)
        response = await self.client.post("/presence", json={}, headers=boris)
        friend = (await response.json())["friends"][0]
        self.assertTrue(friend["online"])
        self.assertEqual(friend["watching"]["episode"], 7)
        await self.client.patch("/me", json={"showActivity": False}, headers=anna)
        await self.client.post("/presence", json={"watching": watching}, headers=anna)
        friend = (await (await self.client.post("/presence", json={}, headers=boris)).json())["friends"][0]
        self.assertTrue(friend["online"])
        self.assertIsNone(friend["watching"])
        await self.client.patch("/me", json={"invisible": True}, headers=anna)
        friend = (await (await self.client.post("/presence", json={}, headers=boris)).json())["friends"][0]
        self.assertFalse(friend["online"])
        self.assertIsNone(friend["lastSeen"])
        response = await self.client.post("/friends/remove", json={"id": anna_account["id"]}, headers=boris)
        self.assertEqual((await response.json())["friends"], [])

    async def test_requests_both_ways_become_friends(self):
        one, one_account = await self.sign_in("4000000001", "One")
        two, two_account = await self.sign_in("4000000002", "Two")
        await self.client.post("/friends/request", json={"code": two_account["code"]}, headers=one)
        response = await self.client.post("/friends/request", json={"code": one_account["code"]}, headers=two)
        self.assertEqual((await response.json())["result"], "friends")
        response = await self.client.post("/friends/request", json={"code": one_account["code"]}, headers=one)
        self.assertEqual((await response.json())["error"], "friend_self")

    async def test_avatar_and_deletion(self):
        auth, account = await self.sign_in("5000000001", "Pic")
        response = await self.client.patch("/me", json={"avatar": PIXEL, "name": "  Новое  имя "}, headers=auth)
        data = await response.json()
        self.assertEqual(data["name"], "Новое имя")
        response = await self.client.get("/" + data["avatar"])
        self.assertEqual(response.status, 200)
        bad = await self.client.patch("/me", json={"avatar": "data:image/png;base64," + base64.b64encode(b"<svg>").decode()}, headers=auth)
        self.assertEqual(bad.status, 400)
        await self.client.delete("/me", headers=auth)
        self.assertEqual((await self.client.get("/me", headers=auth)).status, 401)
        self.assertEqual((await self.client.get("/" + data["avatar"])).status, 404)

    async def test_sign_out_everywhere(self):
        first, _ = await self.sign_in("6000000001", "Many")
        second, _ = await self.sign_in("6000000001", "Many")
        await self.client.post("/auth/signout-all", headers=first)
        self.assertEqual((await self.client.get("/me", headers=second)).status, 401)


if __name__ == "__main__":
    unittest.main()
