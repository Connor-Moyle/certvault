"""SQLite storage. One file at /data/certvault.db — back it up with the rest of /data."""
import sqlite3
import threading
from contextlib import contextmanager

from . import config

_local = threading.local()

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pw_hash TEXT NOT NULL,
    totp_secret TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_login TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen TEXT NOT NULL DEFAULT (datetime('now')),
    user_agent TEXT
);

CREATE TABLE IF NOT EXISTS login_attempts (
    key TEXT NOT NULL,
    ts REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(key, ts);

CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT,
    category TEXT,
    issuer TEXT,
    issuer_type TEXT,
    holder_name TEXT,
    licence_number TEXT,
    completion_date TEXT,
    expiry_date TEXT,
    expiry_estimated INTEGER NOT NULL DEFAULT 0,
    no_expiry INTEGER NOT NULL DEFAULT 0,
    location TEXT,
    notes TEXT,
    original_name TEXT,
    file_ext TEXT,
    mime TEXT,
    size INTEGER,
    sha256 TEXT,
    has_thumb INTEGER NOT NULL DEFAULT 0,
    ocr_text TEXT,
    extract_source TEXT,
    extract_error TEXT,
    status TEXT NOT NULL DEFAULT 'processing',
    reminder_days TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_docs_user ON documents(user_id);

CREATE TABLE IF NOT EXISTS reminders_sent (
    doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    offset_days INTEGER NOT NULL,
    expiry_date TEXT NOT NULL,
    sent_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (doc_id, offset_days, expiry_date)
);

-- user_id 0 = global (admin) settings
CREATE TABLE IF NOT EXISTS settings (
    user_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (user_id, key)
);
"""


SCHEMA_V13 = """
-- extra sides / pages of a document (back of a card, page 2 ...)
CREATE TABLE IF NOT EXISTS doc_pages (
    id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    label TEXT,
    sort INTEGER NOT NULL DEFAULT 0,
    original_name TEXT,
    file_ext TEXT,
    mime TEXT,
    size INTEGER,
    sha256 TEXT,
    has_thumb INTEGER NOT NULL DEFAULT 0,
    ocr_text TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pages_doc ON doc_pages(doc_id);

CREATE TABLE IF NOT EXISTS shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    doc_ids TEXT NOT NULL,
    method TEXT NOT NULL,
    recipient TEXT,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_shares_user ON shares(user_id);

CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    action TEXT NOT NULL,
    detail TEXT,
    ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity(user_id, ts);
"""


def log_activity(user_id, action: str, detail: str | None = None, ip: str | None = None) -> None:
    try:
        run("INSERT INTO activity(user_id, action, detail, ip) VALUES(?,?,?,?)",
            (user_id, action, (detail or "")[:500], ip))
        run("DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY id DESC LIMIT 5000)")
    except Exception:
        pass


def connect() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = sqlite3.connect(config.DB_PATH, timeout=30, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        _local.conn = conn
    return conn


@contextmanager
def tx():
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def init() -> None:
    config.ensure_dirs()
    conn = connect()
    conn.executescript(SCHEMA)
    # migrations
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(documents)")}
    for col in ("version_group", "classes", "rto_code", "cost", "tags", "required_for", "renewal_info", "ai_text", "renew_months"):
        if col not in cols:
            conn.execute(f"ALTER TABLE documents ADD COLUMN {col} TEXT")
    conn.executescript(SCHEMA_V13)
    conn.commit()


def q(sql: str, params=()) -> list[sqlite3.Row]:
    return connect().execute(sql, params).fetchall()


def q1(sql: str, params=()):
    return connect().execute(sql, params).fetchone()


def run(sql: str, params=()) -> int:
    with tx() as c:
        cur = c.execute(sql, params)
        return cur.lastrowid


# ---- settings helpers -------------------------------------------------------

def get_setting(user_id: int, key: str, default=None):
    row = q1("SELECT value FROM settings WHERE user_id=? AND key=?", (user_id, key))
    return row["value"] if row and row["value"] is not None else default


def get_settings(user_id: int) -> dict:
    return {r["key"]: r["value"] for r in q("SELECT key, value FROM settings WHERE user_id=?", (user_id,))}


def set_setting(user_id: int, key: str, value) -> None:
    run(
        "INSERT INTO settings(user_id, key, value) VALUES(?,?,?) "
        "ON CONFLICT(user_id, key) DO UPDATE SET value=excluded.value",
        (user_id, key, None if value is None else str(value)),
    )
