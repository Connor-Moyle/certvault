"""Authentication, sessions, CSRF, brute-force protection and security headers."""
import hashlib
import logging
import secrets
import time

import pyotp
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, InvalidHashError
from fastapi import HTTPException, Request

from . import config, db

log = logging.getLogger("certvault.security")

ph = PasswordHasher()  # argon2id with sensible defaults
COOKIE = "cv_session"

# Brute-force limits
WINDOW = 15 * 60
MAX_PER_USER = 5
MAX_PER_IP = 20

# A dummy hash so login timing is the same whether the user exists or not
_DUMMY_HASH = ph.hash(secrets.token_hex(16))


def hash_password(pw: str) -> str:
    return ph.hash(pw)


def verify_password(pw_hash: str | None, pw: str) -> bool:
    try:
        return ph.verify(pw_hash or _DUMMY_HASH, pw) and pw_hash is not None
    except (VerifyMismatchError, InvalidHashError):
        return False


def password_problem(pw: str) -> str | None:
    if len(pw) < 10:
        return "Password must be at least 10 characters."
    if len(pw) > 256:
        return "Password is too long."
    if pw.lower() in {"password123", "1234567890", "qwertyuiop", "letmein123"}:
        return "That password is too common."
    return None


def _sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


# ---- rate limiting ----------------------------------------------------------

def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def check_rate_limit(ip: str, username: str) -> None:
    cutoff = time.time() - WINDOW
    db.run("DELETE FROM login_attempts WHERE ts < ?", (cutoff,))
    u = db.q1("SELECT COUNT(*) n FROM login_attempts WHERE key=?", ("u:" + username.lower(),))["n"]
    i = db.q1("SELECT COUNT(*) n FROM login_attempts WHERE key=?", ("ip:" + ip,))["n"]
    if u >= MAX_PER_USER or i >= MAX_PER_IP:
        raise HTTPException(429, "Too many failed attempts. Try again in 15 minutes.")


def record_failure(ip: str, username: str) -> None:
    now = time.time()
    with db.tx() as c:
        c.execute("INSERT INTO login_attempts(key, ts) VALUES(?,?)", ("u:" + username.lower(), now))
        c.execute("INSERT INTO login_attempts(key, ts) VALUES(?,?)", ("ip:" + ip, now))
    log.warning("Failed login for %r from %s", username, ip)


def clear_failures(username: str) -> None:
    db.run("DELETE FROM login_attempts WHERE key=?", ("u:" + username.lower(),))


# ---- sessions ---------------------------------------------------------------

def create_session(user_id: int, user_agent: str | None) -> str:
    token = secrets.token_urlsafe(32)
    db.run(
        "INSERT INTO sessions(token_hash, user_id, csrf, user_agent) VALUES(?,?,?,?)",
        (_sha(token), user_id, secrets.token_urlsafe(24), (user_agent or "")[:200]),
    )
    db.run("UPDATE users SET last_login=datetime('now') WHERE id=?", (user_id,))
    return token


def destroy_session(token: str | None) -> None:
    if token:
        db.run("DELETE FROM sessions WHERE token_hash=?", (_sha(token),))


def destroy_all_sessions(user_id: int, except_token: str | None = None) -> None:
    if except_token:
        db.run("DELETE FROM sessions WHERE user_id=? AND token_hash<>?", (user_id, _sha(except_token)))
    else:
        db.run("DELETE FROM sessions WHERE user_id=?", (user_id,))


def cookie_secure(request: Request) -> bool:
    if config.COOKIE_SECURE in ("true", "1", "yes"):
        return True
    if config.COOKIE_SECURE in ("false", "0", "no"):
        return False
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    return proto == "https"


def set_session_cookie(response, request: Request, token: str) -> None:
    response.set_cookie(
        COOKIE, token,
        max_age=config.SESSION_DAYS * 86400,
        httponly=True,
        samesite="strict",
        secure=cookie_secure(request),
        path="/",
    )


def session_from_request(request: Request):
    token = request.cookies.get(COOKIE)
    if not token:
        return None
    row = db.q1(
        "SELECT s.token_hash, s.csrf, s.last_seen, u.id, u.username, u.is_admin, u.totp_secret "
        "FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash=?",
        (_sha(token),),
    )
    if not row:
        return None
    # idle expiry
    age = db.q1("SELECT (julianday('now') - julianday(?)) AS d", (row["last_seen"],))["d"]
    if age is not None and age > config.SESSION_DAYS:
        destroy_session(token)
        return None
    db.run("UPDATE sessions SET last_seen=datetime('now') WHERE token_hash=?", (row["token_hash"],))
    return row


def require_user(request: Request):
    """FastAPI dependency: returns the logged-in user row, enforces CSRF on writes."""
    sess = session_from_request(request)
    if not sess:
        raise HTTPException(401, "Not logged in")
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        sent = request.headers.get("x-csrf-token", "")
        if not secrets.compare_digest(sent, sess["csrf"]):
            raise HTTPException(403, "CSRF check failed")
    return sess


def require_admin(request: Request):
    user = require_user(request)
    if not user["is_admin"]:
        raise HTTPException(403, "Admin only")
    return user


# ---- TOTP ---------------------------------------------------------------------

def verify_totp(secret: str, code: str) -> bool:
    code = (code or "").replace(" ", "")
    if not code.isdigit():
        return False
    return pyotp.TOTP(secret).verify(code, valid_window=1)


# ---- headers ------------------------------------------------------------------

SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; "
        "connect-src 'self'; font-src 'self'; object-src 'none'; frame-src 'self'; "
        "frame-ancestors 'self'; base-uri 'none'; form-action 'self'; manifest-src 'self'; worker-src 'self'"
    ),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=(self)",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
}
