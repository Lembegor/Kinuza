import base64
import json
import re
import time

import httpx

TOKEN_URL = "https://oauth2.googleapis.com/token"
ISSUERS = {"accounts.google.com", "https://accounts.google.com"}
CLOCK_SLACK = 120


class GoogleError(Exception):
    pass


def loopback_redirect(uri: str) -> bool:
    return re.fullmatch(r"http://127\.0\.0\.1:\d{2,5}/", uri or "") is not None


def claims_of(id_token: str) -> dict:
    parts = (id_token or "").split(".")
    if len(parts) != 3:
        raise GoogleError("google_bad_token")
    payload = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        claims = json.loads(base64.urlsafe_b64decode(payload))
    except (ValueError, json.JSONDecodeError) as error:
        raise GoogleError("google_bad_token") from error
    if not isinstance(claims, dict):
        raise GoogleError("google_bad_token")
    return claims


def checked_identity(claims: dict, client_id: str, now: float | None = None) -> dict:
    now = time.time() if now is None else now
    if claims.get("iss") not in ISSUERS:
        raise GoogleError("google_bad_issuer")
    audience = claims.get("aud")
    if audience != client_id and not (isinstance(audience, list) and client_id in audience):
        raise GoogleError("google_bad_audience")
    try:
        expires = float(claims.get("exp", 0))
        issued = float(claims.get("iat", 0))
    except (TypeError, ValueError) as error:
        raise GoogleError("google_bad_token") from error
    if expires < now - CLOCK_SLACK or issued > now + CLOCK_SLACK:
        raise GoogleError("google_expired")
    if claims.get("email_verified") not in (True, "true"):
        raise GoogleError("google_email_unverified")
    sub = str(claims.get("sub") or "")
    if not re.fullmatch(r"\d{5,40}", sub):
        raise GoogleError("google_bad_token")
    return {
        "sub": sub,
        "email": str(claims.get("email") or "")[:200],
        "name": str(claims.get("given_name") or claims.get("name") or "")[:80],
    }


async def exchange(client: httpx.AsyncClient, client_id: str, secret: str, code: str, verifier: str, redirect: str) -> dict:
    if not loopback_redirect(redirect):
        raise GoogleError("google_bad_redirect")
    if not re.fullmatch(r"[A-Za-z0-9._~-]{43,128}", verifier or ""):
        raise GoogleError("google_bad_verifier")
    if not code or len(code) > 512:
        raise GoogleError("google_bad_code")
    try:
        response = await client.post(
            TOKEN_URL,
            data={
                "code": code,
                "client_id": client_id,
                "client_secret": secret,
                "redirect_uri": redirect,
                "grant_type": "authorization_code",
                "code_verifier": verifier,
            },
        )
    except httpx.HTTPError as error:
        raise GoogleError("google_unreachable") from error
    if response.status_code != 200:
        raise GoogleError("google_refused")
    try:
        token = response.json().get("id_token", "")
    except ValueError as error:
        raise GoogleError("google_bad_token") from error
    return checked_identity(claims_of(token), client_id)
