import hashlib
import secrets
import sqlite3
import time

CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 8
NAME_LIMIT = 40
FRIEND_LIMIT = 300
PENDING_LIMIT = 50
HISTORY_KEPT = 3
SESSION_TOUCH_SECONDS = 3600

SCHEMA = """
create table if not exists users (
  id integer primary key,
  sub text unique not null,
  email text not null default '',
  name text not null default '',
  avatar text,
  code text unique not null,
  show_activity integer not null default 1,
  invisible integer not null default 0,
  created integer not null,
  last_seen integer not null default 0
);
create table if not exists sessions (
  hash text primary key,
  user_id integer not null references users(id) on delete cascade,
  device text not null default '',
  created integer not null,
  used integer not null
);
create index if not exists sessions_user on sessions(user_id);
create table if not exists backups (
  user_id integer primary key references users(id) on delete cascade,
  revision integer not null,
  updated integer not null,
  size integer not null,
  data blob not null
);
create table if not exists backup_history (
  user_id integer not null references users(id) on delete cascade,
  revision integer not null,
  updated integer not null,
  data blob not null,
  primary key (user_id, revision)
);
create table if not exists requests (
  from_id integer not null references users(id) on delete cascade,
  to_id integer not null references users(id) on delete cascade,
  created integer not null,
  primary key (from_id, to_id)
);
create index if not exists requests_to on requests(to_id);
create table if not exists friends (
  a integer not null references users(id) on delete cascade,
  b integer not null references users(id) on delete cascade,
  created integer not null,
  primary key (a, b)
);
create index if not exists friends_b on friends(b);
create table if not exists avatars (
  id text primary key,
  data blob not null
);
"""


class StoreError(Exception):
    pass


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_code() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))


def clean_code(text: str) -> str:
    return "".join(char for char in (text or "").upper() if char in CODE_ALPHABET)[:CODE_LENGTH]


def clean_name(text: str) -> str:
    text = "".join(char for char in (text or "") if char.isprintable() or char.isspace())
    return " ".join(text.split())[:NAME_LIMIT]


class Store:
    def __init__(self, path: str) -> None:
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("pragma journal_mode = wal")
        self.db.execute("pragma foreign_keys = on")
        self.db.execute("pragma synchronous = normal")
        self.db.executescript(SCHEMA)

    def user_by_sub(self, sub: str):
        return self.db.execute("select * from users where sub = ?", (sub,)).fetchone()

    def user(self, user_id: int):
        return self.db.execute("select * from users where id = ?", (user_id,)).fetchone()

    def user_by_code(self, code: str):
        return self.db.execute("select * from users where code = ?", (clean_code(code),)).fetchone()

    def sign_in(self, sub: str, email: str, name: str, device: str) -> tuple:
        now = int(time.time())
        user = self.user_by_sub(sub)
        created = user is None
        if created:
            for _ in range(20):
                code = new_code()
                if not self.user_by_code(code):
                    break
            self.db.execute(
                "insert into users (sub, email, name, code, created, last_seen) values (?, ?, ?, ?, ?, ?)",
                (sub, email, clean_name(name), code, now, now),
            )
            user = self.user_by_sub(sub)
        elif email and email != user["email"]:
            self.db.execute("update users set email = ? where id = ?", (email, user["id"]))
        token = secrets.token_urlsafe(32)
        self.db.execute(
            "insert into sessions (hash, user_id, device, created, used) values (?, ?, ?, ?, ?)",
            (token_hash(token), user["id"], (device or "")[:80], now, now),
        )
        return token, self.user(user["id"]), created

    def session_user(self, token: str):
        if not token or len(token) > 100:
            return None
        hashed = token_hash(token)
        row = self.db.execute("select user_id, used from sessions where hash = ?", (hashed,)).fetchone()
        if not row:
            return None
        now = int(time.time())
        if now - row["used"] > SESSION_TOUCH_SECONDS:
            self.db.execute("update sessions set used = ? where hash = ?", (now, hashed))
        return self.user(row["user_id"])

    def sign_out(self, token: str) -> None:
        self.db.execute("delete from sessions where hash = ?", (token_hash(token),))

    def sign_out_everywhere(self, user_id: int) -> None:
        self.db.execute("delete from sessions where user_id = ?", (user_id,))

    def update_profile(self, user_id: int, change: dict) -> None:
        fields = []
        values = []
        if "name" in change:
            fields.append("name = ?")
            values.append(clean_name(change["name"]))
        if "showActivity" in change:
            fields.append("show_activity = ?")
            values.append(1 if change["showActivity"] else 0)
        if "invisible" in change:
            fields.append("invisible = ?")
            values.append(1 if change["invisible"] else 0)
        if fields:
            self.db.execute(f"update users set {', '.join(fields)} where id = ?", (*values, user_id))

    def set_avatar(self, user_id: int, data: bytes | None) -> str | None:
        old = self.user(user_id)["avatar"]
        avatar_id = secrets.token_urlsafe(12) if data else None
        self.db.execute("begin")
        try:
            if data:
                self.db.execute("insert into avatars (id, data) values (?, ?)", (avatar_id, data))
            self.db.execute("update users set avatar = ? where id = ?", (avatar_id, user_id))
            if old:
                self.db.execute("delete from avatars where id = ?", (old,))
            self.db.execute("commit")
        except sqlite3.Error:
            self.db.execute("rollback")
            raise
        return avatar_id

    def avatar(self, avatar_id: str):
        row = self.db.execute("select data from avatars where id = ?", (avatar_id,)).fetchone()
        return bytes(row["data"]) if row else None

    def delete_user(self, user_id: int) -> None:
        avatar = self.user(user_id)["avatar"]
        self.db.execute("begin")
        try:
            if avatar:
                self.db.execute("delete from avatars where id = ?", (avatar,))
            self.db.execute("delete from users where id = ?", (user_id,))
            self.db.execute("commit")
        except sqlite3.Error:
            self.db.execute("rollback")
            raise

    def note_seen(self, user_id: int, at: int) -> None:
        self.db.execute("update users set last_seen = ? where id = ? and last_seen < ?", (at, user_id, at))

    def backup(self, user_id: int):
        return self.db.execute("select revision, updated, size, data from backups where user_id = ?", (user_id,)).fetchone()

    def backup_revision(self, user_id: int) -> int:
        row = self.db.execute("select revision from backups where user_id = ?", (user_id,)).fetchone()
        return row["revision"] if row else 0

    def save_backup(self, user_id: int, expected: int, data: bytes) -> tuple:
        now = int(time.time())
        self.db.execute("begin immediate")
        try:
            row = self.db.execute("select revision, updated, data from backups where user_id = ?", (user_id,)).fetchone()
            current = row["revision"] if row else 0
            if current != expected:
                self.db.execute("rollback")
                return False, current
            revision = current + 1
            if row:
                self.db.execute(
                    "insert or replace into backup_history (user_id, revision, updated, data) values (?, ?, ?, ?)",
                    (user_id, current, row["updated"], row["data"]),
                )
                self.db.execute(
                    "delete from backup_history where user_id = ? and revision <= ?",
                    (user_id, current - HISTORY_KEPT),
                )
            self.db.execute(
                "insert or replace into backups (user_id, revision, updated, size, data) values (?, ?, ?, ?, ?)",
                (user_id, revision, now, len(data), data),
            )
            self.db.execute("commit")
            return True, revision
        except sqlite3.Error:
            self.db.execute("rollback")
            raise

    def friend_ids(self, user_id: int) -> list:
        rows = self.db.execute("select b as other from friends where a = ? union select a as other from friends where b = ?", (user_id, user_id)).fetchall()
        return [row["other"] for row in rows]

    def are_friends(self, one: int, other: int) -> bool:
        a, b = sorted((one, other))
        return self.db.execute("select 1 from friends where a = ? and b = ?", (a, b)).fetchone() is not None

    def users(self, ids: list) -> list:
        if not ids:
            return []
        marks = ",".join("?" for _ in ids)
        return self.db.execute(f"select * from users where id in ({marks})", ids).fetchall()

    def requests_to(self, user_id: int) -> list:
        return self.db.execute("select from_id as id, created from requests where to_id = ? order by created desc", (user_id,)).fetchall()

    def requests_from(self, user_id: int) -> list:
        return self.db.execute("select to_id as id, created from requests where from_id = ? order by created desc", (user_id,)).fetchall()

    def request_friend(self, user_id: int, code: str) -> tuple:
        other = self.user_by_code(code)
        if not other:
            raise StoreError("friend_not_found")
        other_id = other["id"]
        if other_id == user_id:
            raise StoreError("friend_self")
        if self.are_friends(user_id, other_id):
            return "friends", other_id
        if len(self.friend_ids(user_id)) >= FRIEND_LIMIT:
            raise StoreError("friend_limit")
        now = int(time.time())
        if self.db.execute("select 1 from requests where from_id = ? and to_id = ?", (other_id, user_id)).fetchone():
            self.accept(user_id, other_id)
            return "friends", other_id
        if len(self.requests_from(user_id)) >= PENDING_LIMIT:
            raise StoreError("friend_pending_limit")
        self.db.execute("insert or ignore into requests (from_id, to_id, created) values (?, ?, ?)", (user_id, other_id, now))
        return "sent", other_id

    def accept(self, user_id: int, other_id: int) -> bool:
        if len(self.friend_ids(user_id)) >= FRIEND_LIMIT or len(self.friend_ids(other_id)) >= FRIEND_LIMIT:
            raise StoreError("friend_limit")
        self.db.execute("begin immediate")
        try:
            found = self.db.execute("delete from requests where from_id = ? and to_id = ?", (other_id, user_id)).rowcount
            if not found:
                self.db.execute("rollback")
                return False
            self.db.execute("delete from requests where from_id = ? and to_id = ?", (user_id, other_id))
            a, b = sorted((user_id, other_id))
            self.db.execute("insert or ignore into friends (a, b, created) values (?, ?, ?)", (a, b, int(time.time())))
            self.db.execute("commit")
            return True
        except sqlite3.Error:
            self.db.execute("rollback")
            raise

    def decline(self, user_id: int, other_id: int) -> None:
        self.db.execute("delete from requests where from_id = ? and to_id = ?", (other_id, user_id))

    def cancel(self, user_id: int, other_id: int) -> None:
        self.db.execute("delete from requests where from_id = ? and to_id = ?", (user_id, other_id))

    def remove_friend(self, user_id: int, other_id: int) -> None:
        a, b = sorted((user_id, other_id))
        self.db.execute("delete from friends where a = ? and b = ?", (a, b))
