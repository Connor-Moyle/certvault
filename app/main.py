"""CertVault — self-hosted licence / ticket / induction tracker."""
import hashlib
import io
import logging
import secrets
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

import pyotp
import qrcode
import qrcode.image.svg
from fastapi import Depends, FastAPI, HTTPException, Request, UploadFile, File
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import ai, config, db, extract, notify, scheduler, security
from .categories import CATEGORIES, CATEGORY_BY_ID

logging.basicConfig(level=config.LOG_LEVEL, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("certvault")

STATIC = Path(__file__).parent / "static"
VERSION = "1.0.0"

app = FastAPI(title="CertVault", docs_url=None, redoc_url=None, openapi_url=None)
worker = ThreadPoolExecutor(max_workers=1)  # one document at a time — gentle on the NAS

SETUP_CODE: str | None = None


# ---- startup ----------------------------------------------------------------------

@app.on_event("startup")
def startup():
    global SETUP_CODE
    db.init()
    if not db.q1("SELECT 1 FROM users"):
        SETUP_CODE = secrets.token_hex(4).upper()
        (config.DATA_DIR / "SETUP_CODE.txt").write_text(SETUP_CODE + "\n")
        log.warning("=" * 60)
        log.warning("  No users yet. Open the web UI and use setup code: %s", SETUP_CODE)
        log.warning("  (also saved to %s)", config.DATA_DIR / "SETUP_CODE.txt")
        log.warning("=" * 60)
    # documents stuck in 'processing' after a restart -> re-queue
    for r in db.q("SELECT id FROM documents WHERE status='processing'"):
        worker.submit(process_document, r["id"], "full")
    scheduler.start()


@app.middleware("http")
async def headers_mw(request: Request, call_next):
    resp = await call_next(request)
    for k, v in security.SECURITY_HEADERS.items():
        resp.headers.setdefault(k, v)
    if request.url.path.startswith("/api/"):
        resp.headers.setdefault("Cache-Control", "no-store")
    return resp


# ---- helpers -------------------------------------------------------------------------

def doc_state(row) -> dict:
    d = dict(row)
    d.pop("ocr_text", None)
    d["expiry_estimated"] = bool(d["expiry_estimated"])
    d["no_expiry"] = bool(d["no_expiry"])
    d["has_thumb"] = bool(d["has_thumb"])
    d["days_left"] = None
    if d["expiry_date"]:
        try:
            d["days_left"] = (date.fromisoformat(d["expiry_date"]) - scheduler.today_local()).days
        except ValueError:
            pass
    if d["status"] == "processing":
        d["state"] = "processing"
    elif d["days_left"] is None:
        d["state"] = "none" if d["no_expiry"] else "unknown"
    elif d["days_left"] < 0:
        d["state"] = "expired"
    elif d["days_left"] <= 30:
        d["state"] = "soon"
    else:
        d["state"] = "valid"
    cat = CATEGORY_BY_ID.get(d["category"] or "other", CATEGORY_BY_ID["other"])
    d["category_name"] = cat["name"]
    d["icon"] = cat["icon"]
    d["color"] = cat["color"]
    return d


def get_doc(doc_id: str, user) -> dict:
    row = db.q1("SELECT * FROM documents WHERE id=? AND user_id=?", (doc_id, user["id"]))
    if not row:
        raise HTTPException(404, "Not found")
    return row


def file_path(row) -> Path:
    return config.FILES_DIR / f"{row['id']}.{row['file_ext']}"


def thumb_path(doc_id: str) -> Path:
    return config.THUMBS_DIR / f"{doc_id}.jpg"


EDITABLE = ["title", "category", "issuer", "issuer_type", "holder_name", "licence_number",
            "completion_date", "expiry_date", "expiry_estimated", "no_expiry", "location", "notes"]


def process_document(doc_id: str, mode: str = "full"):
    """mode: 'full' = overwrite all extracted fields, 'fill' = only fill blanks."""
    row = db.q1("SELECT * FROM documents WHERE id=?", (doc_id,))
    if not row:
        return
    path = file_path(row)
    error = None
    try:
        text = row["ocr_text"]
        if not text:
            text = extract.get_text(path, row["file_ext"])
            db.run("UPDATE documents SET ocr_text=? WHERE id=?", (text, doc_id))
        fields = extract.rule_extract(text, scheduler.today_local())
        source = "ocr"
        if ai.enabled():
            try:
                ai_fields, source = ai.analyse(path, row["file_ext"], text)
                for k, v in ai_fields.items():
                    if v not in (None, ""):
                        fields[k] = v
                if ai_fields.get("expiry_date"):
                    fields["expiry_estimated"] = bool(ai_fields.get("expiry_estimated"))
                if ai_fields.get("no_expiry") and not ai_fields.get("expiry_date"):
                    fields["expiry_date"] = None
                    fields["expiry_estimated"] = False
            except Exception as e:
                error = f"AI failed, used OCR instead: {e}"
                log.warning("AI analyse failed for %s: %s", doc_id, e)
        fields.setdefault("no_expiry", False)
        sets, vals = [], []
        for k in EDITABLE:
            v = fields.get(k)
            if isinstance(v, bool):
                v = int(v)
            if mode == "fill" and row[k] not in (None, "", 0):
                continue
            sets.append(f"{k}=?")
            vals.append(v)
        new_status = "review" if row["status"] in ("processing", "review", "error") or mode == "full" else row["status"]
        sets += ["extract_source=?", "extract_error=?", "status=?", "updated_at=datetime('now')"]
        vals += [source, error, new_status, doc_id]
        db.run(f"UPDATE documents SET {', '.join(sets)} WHERE id=?", vals)
        log.info("Processed %s via %s", doc_id, source)
    except Exception as e:
        log.exception("Processing failed for %s", doc_id)
        db.run("UPDATE documents SET status='review', extract_error=?, updated_at=datetime('now') WHERE id=?",
               (f"Couldn't read this file automatically: {e}", doc_id))


# ---- auth ---------------------------------------------------------------------------

class SetupIn(BaseModel):
    code: str
    username: str = Field(min_length=2, max_length=64)
    password: str


class LoginIn(BaseModel):
    username: str = Field(max_length=64)
    password: str = Field(max_length=256)
    totp: str | None = None


@app.get("/api/status")
def status(request: Request):
    sess = security.session_from_request(request)
    return {"setup_required": db.q1("SELECT 1 FROM users") is None,
            "logged_in": bool(sess), "version": VERSION}


@app.post("/api/setup")
def setup(body: SetupIn, request: Request):
    global SETUP_CODE
    if db.q1("SELECT 1 FROM users"):
        raise HTTPException(400, "Already set up")
    ip = security.client_ip(request)
    security.check_rate_limit(ip, "__setup__")
    if not SETUP_CODE or not secrets.compare_digest(body.code.strip().upper(), SETUP_CODE):
        security.record_failure(ip, "__setup__")
        raise HTTPException(403, "Wrong setup code — check the app logs on TrueNAS")
    if p := security.password_problem(body.password):
        raise HTTPException(400, p)
    uid = db.run("INSERT INTO users(username, pw_hash, is_admin) VALUES(?,?,1)",
                 (body.username.strip(), security.hash_password(body.password)))
    SETUP_CODE = None
    (config.DATA_DIR / "SETUP_CODE.txt").unlink(missing_ok=True)
    token = security.create_session(uid, request.headers.get("user-agent"))
    resp = JSONResponse({"ok": True})
    security.set_session_cookie(resp, request, token)
    return resp


@app.post("/api/login")
def login(body: LoginIn, request: Request):
    ip = security.client_ip(request)
    security.check_rate_limit(ip, body.username)
    user = db.q1("SELECT * FROM users WHERE username=?", (body.username.strip(),))
    if not security.verify_password(user["pw_hash"] if user else None, body.password):
        security.record_failure(ip, body.username)
        raise HTTPException(401, "Wrong username or password")
    if user["totp_secret"]:
        if not body.totp:
            return JSONResponse({"totp_required": True}, status_code=401)
        if not security.verify_totp(user["totp_secret"], body.totp):
            security.record_failure(ip, body.username)
            raise HTTPException(401, "Wrong 2-step code")
    security.clear_failures(body.username)
    if security.ph.check_needs_rehash(user["pw_hash"]):
        db.run("UPDATE users SET pw_hash=? WHERE id=?", (security.hash_password(body.password), user["id"]))
    token = security.create_session(user["id"], request.headers.get("user-agent"))
    resp = JSONResponse({"ok": True})
    security.set_session_cookie(resp, request, token)
    return resp


@app.post("/api/logout")
def logout(request: Request, user=Depends(security.require_user)):
    security.destroy_session(request.cookies.get(security.COOKIE))
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(security.COOKIE, path="/")
    return resp


@app.get("/api/me")
def me(user=Depends(security.require_user)):
    return {"id": user["id"], "username": user["username"], "is_admin": bool(user["is_admin"]),
            "csrf": user["csrf"], "totp_enabled": bool(user["totp_secret"]), "ai_enabled": ai.enabled()}


class PasswordIn(BaseModel):
    current: str
    new: str


@app.post("/api/account/password")
def change_password(body: PasswordIn, request: Request, user=Depends(security.require_user)):
    row = db.q1("SELECT pw_hash FROM users WHERE id=?", (user["id"],))
    if not security.verify_password(row["pw_hash"], body.current):
        raise HTTPException(400, "Current password is wrong")
    if p := security.password_problem(body.new):
        raise HTTPException(400, p)
    db.run("UPDATE users SET pw_hash=? WHERE id=?", (security.hash_password(body.new), user["id"]))
    security.destroy_all_sessions(user["id"], except_token=request.cookies.get(security.COOKIE))
    return {"ok": True}


@app.post("/api/account/totp/start")
def totp_start(user=Depends(security.require_user)):
    secret = pyotp.random_base32()
    uri = pyotp.TOTP(secret).provisioning_uri(name=user["username"], issuer_name="CertVault")
    img = qrcode.make(uri, image_factory=qrcode.image.svg.SvgPathImage, box_size=8, border=2)
    buf = io.BytesIO()
    img.save(buf)
    return {"secret": secret, "uri": uri, "qr_svg": buf.getvalue().decode()}


class TotpIn(BaseModel):
    secret: str | None = None
    code: str | None = None
    password: str | None = None


@app.post("/api/account/totp/enable")
def totp_enable(body: TotpIn, user=Depends(security.require_user)):
    if not body.secret or not security.verify_totp(body.secret, body.code or ""):
        raise HTTPException(400, "That code didn't match — try the next one")
    db.run("UPDATE users SET totp_secret=? WHERE id=?", (body.secret, user["id"]))
    return {"ok": True}


@app.post("/api/account/totp/disable")
def totp_disable(body: TotpIn, user=Depends(security.require_user)):
    row = db.q1("SELECT pw_hash FROM users WHERE id=?", (user["id"],))
    if not security.verify_password(row["pw_hash"], body.password or ""):
        raise HTTPException(400, "Password is wrong")
    db.run("UPDATE users SET totp_secret=NULL WHERE id=?", (user["id"],))
    return {"ok": True}


@app.post("/api/account/logout-others")
def logout_others(request: Request, user=Depends(security.require_user)):
    security.destroy_all_sessions(user["id"], except_token=request.cookies.get(security.COOKIE))
    return {"ok": True}


# ---- documents ---------------------------------------------------------------------

@app.get("/api/categories")
def categories(user=Depends(security.require_user)):
    return [{k: c[k] for k in ("id", "name", "icon", "color", "validity_years")} for c in CATEGORIES]


@app.get("/api/documents")
def list_documents(user=Depends(security.require_user)):
    rows = db.q("SELECT * FROM documents WHERE user_id=? ORDER BY "
                "CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END, expiry_date, created_at DESC", (user["id"],))
    return [doc_state(r) for r in rows]


@app.post("/api/documents")
async def upload(files: list[UploadFile] = File(...), user=Depends(security.require_user)):
    if len(files) > 30:
        raise HTTPException(400, "Max 30 files at a time")
    limit = config.MAX_UPLOAD_MB * 1024 * 1024
    results = []
    for f in files:
        data = bytearray()
        while chunk := await f.read(1024 * 1024):
            data += chunk
            if len(data) > limit:
                raise HTTPException(413, f"{f.filename} is larger than {config.MAX_UPLOAD_MB} MB")
        kind = extract.sniff(bytes(data[:16]))
        if not kind:
            results.append({"name": f.filename, "error": "Unsupported file — use PDF, JPG, PNG, WEBP or HEIC"})
            continue
        try:
            blob, ext, mime = extract.normalise_upload(bytes(data), kind[0])
        except Exception:
            results.append({"name": f.filename, "error": "File looks damaged or couldn't be opened"})
            continue
        sha = hashlib.sha256(blob).hexdigest()
        dup = db.q1("SELECT id FROM documents WHERE user_id=? AND sha256=?", (user["id"], sha))
        if dup:
            results.append({"name": f.filename, "id": dup["id"], "duplicate": True})
            continue
        doc_id = uuid.uuid4().hex
        (config.FILES_DIR / f"{doc_id}.{ext}").write_bytes(blob)
        has_thumb = extract.make_thumbnail(config.FILES_DIR / f"{doc_id}.{ext}", ext, thumb_path(doc_id))
        name = Path(f.filename or "upload").name[:200]
        db.run("INSERT INTO documents(id, user_id, original_name, file_ext, mime, size, sha256, has_thumb, title, status) "
               "VALUES(?,?,?,?,?,?,?,?,?,'processing')",
               (doc_id, user["id"], name, ext, mime, len(blob), sha, int(has_thumb), Path(name).stem[:100]))
        worker.submit(process_document, doc_id, "full")
        results.append({"name": f.filename, "id": doc_id})
    return results


@app.get("/api/documents/{doc_id}")
def get_document(doc_id: str, user=Depends(security.require_user)):
    row = get_doc(doc_id, user)
    d = doc_state(row)
    d["ocr_text"] = row["ocr_text"]
    return d


class DocIn(BaseModel):
    title: str | None = Field(None, max_length=300)
    category: str | None = None
    issuer: str | None = Field(None, max_length=300)
    issuer_type: str | None = None
    holder_name: str | None = Field(None, max_length=300)
    licence_number: str | None = Field(None, max_length=100)
    completion_date: str | None = None
    expiry_date: str | None = None
    expiry_estimated: bool | None = None
    no_expiry: bool | None = None
    location: str | None = Field(None, max_length=300)
    notes: str | None = Field(None, max_length=4000)
    reminder_days: str | None = Field(None, max_length=100)


@app.patch("/api/documents/{doc_id}")
def update_document(doc_id: str, body: DocIn, user=Depends(security.require_user)):
    get_doc(doc_id, user)
    data = body.model_dump(exclude_unset=True)
    for k in ("completion_date", "expiry_date"):
        if data.get(k):
            try:
                data[k] = date.fromisoformat(data[k]).isoformat()
            except ValueError:
                raise HTTPException(400, f"Bad date for {k}")
        elif k in data:
            data[k] = None
    if data.get("category") and data["category"] not in CATEGORY_BY_ID:
        raise HTTPException(400, "Unknown category")
    if "reminder_days" in data and data["reminder_days"]:
        data["reminder_days"] = ",".join(str(x) for x in scheduler.parse_days(data["reminder_days"]))
    if data.get("no_expiry"):
        data["expiry_date"] = None
    for k, v in list(data.items()):
        if isinstance(v, bool):
            data[k] = int(v)
        elif isinstance(v, str):
            data[k] = v.strip() or None
    if not data:  # "Looks right" — just confirm
        db.run("UPDATE documents SET status='ok', updated_at=datetime('now') WHERE id=? AND user_id=?", (doc_id, user["id"]))
        return doc_state(get_doc(doc_id, user))
    sets = ", ".join(f"{k}=?" for k in data) + ", status='ok', updated_at=datetime('now')"
    db.run(f"UPDATE documents SET {sets} WHERE id=? AND user_id=?", (*data.values(), doc_id, user["id"]))
    return doc_state(get_doc(doc_id, user))


@app.delete("/api/documents/{doc_id}")
def delete_document(doc_id: str, user=Depends(security.require_user)):
    row = get_doc(doc_id, user)
    file_path(row).unlink(missing_ok=True)
    thumb_path(doc_id).unlink(missing_ok=True)
    db.run("DELETE FROM documents WHERE id=?", (doc_id,))
    return {"ok": True}


@app.post("/api/documents/{doc_id}/rescan")
def rescan(doc_id: str, user=Depends(security.require_user)):
    get_doc(doc_id, user)
    db.run("UPDATE documents SET status='processing', ocr_text=NULL WHERE id=?", (doc_id,))
    worker.submit(process_document, doc_id, "full")
    return {"ok": True}


@app.post("/api/documents-rescan-all")
def rescan_all(user=Depends(security.require_user)):
    rows = db.q("SELECT id FROM documents WHERE user_id=? AND status<>'processing'", (user["id"],))
    for r in rows:
        worker.submit(process_document, r["id"], "fill")
    return {"queued": len(rows)}


@app.get("/api/documents/{doc_id}/file")
def get_file(doc_id: str, download: int = 0, user=Depends(security.require_user)):
    row = get_doc(doc_id, user)
    name = (row["title"] or "document").replace('"', "").replace("/", "-")[:80] + "." + row["file_ext"]
    return FileResponse(file_path(row), media_type=row["mime"], filename=name,
                        content_disposition_type="attachment" if download else "inline",
                        headers={"Cache-Control": "private, no-store"})


@app.get("/api/documents/{doc_id}/thumb")
def get_thumb(doc_id: str, user=Depends(security.require_user)):
    row = get_doc(doc_id, user)
    p = thumb_path(doc_id)
    if not row["has_thumb"] or not p.exists():
        raise HTTPException(404)
    return FileResponse(p, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})


# ---- settings -------------------------------------------------------------------------

USER_KEYS = ["reminder_days", "remind_expired_weekly", "ntfy_url", "ntfy_token", "email_to", "ha_webhook_url"]
GLOBAL_KEYS = ["ai_provider", "anthropic_api_key", "anthropic_model", "ollama_url", "ollama_model",
               "smtp_host", "smtp_port", "smtp_user", "smtp_pass", "smtp_from", "notify_hour", "public_url"]
SECRET_KEYS = {"ntfy_token", "anthropic_api_key", "smtp_pass"}
MASK = "••••••••"


def _mask(d: dict) -> dict:
    return {k: (MASK if k in SECRET_KEYS and v else v) for k, v in d.items()}


@app.get("/api/settings")
def get_settings(user=Depends(security.require_user)):
    us = db.get_settings(user["id"])
    out = {"user": _mask({k: us.get(k) for k in USER_KEYS})}
    out["user"]["reminder_days"] = out["user"]["reminder_days"] or scheduler.DEFAULT_DAYS
    out["user"]["remind_expired_weekly"] = out["user"]["remind_expired_weekly"] or "1"
    if user["is_admin"]:
        g = {**ai.DEFAULTS, "notify_hour": "8", **db.get_settings(0)}
        out["global"] = _mask({k: g.get(k) for k in GLOBAL_KEYS})
        out["global"]["last_check"] = g.get("last_check")
    return out


class SettingsIn(BaseModel):
    user: dict[str, str | None] = {}
    global_: dict[str, str | None] = Field(default={}, alias="global")


@app.put("/api/settings")
def put_settings(body: SettingsIn, user=Depends(security.require_user)):
    for k, v in body.user.items():
        if k not in USER_KEYS or v == MASK:
            continue
        if k == "reminder_days":
            v = ",".join(str(x) for x in scheduler.parse_days(v))
        if k in ("ntfy_url", "ha_webhook_url") and v and not v.startswith(("http://", "https://")):
            raise HTTPException(400, f"{k} must start with http:// or https://")
        db.set_setting(user["id"], k, (v or "").strip()[:500] or None)
    if body.global_:
        if not user["is_admin"]:
            raise HTTPException(403, "Admin only")
        for k, v in body.global_.items():
            if k not in GLOBAL_KEYS or v == MASK:
                continue
            if k == "ai_provider" and v not in ("none", "anthropic", "ollama"):
                raise HTTPException(400, "Bad AI provider")
            if k == "notify_hour" and v and not (v.isdigit() and 0 <= int(v) <= 23):
                raise HTTPException(400, "Hour must be 0-23")
            db.set_setting(0, k, (v or "").strip()[:500] or None)
    return get_settings(user)


@app.post("/api/settings/test-notify")
def test_notify(user=Depends(security.require_user)):
    try:
        ok = notify.send(user["id"], "CertVault test", "Notifications are working 👍", False,
                         db.get_setting(0, "public_url"))
    except Exception as e:
        raise HTTPException(400, str(e))
    return {"sent": ok}


@app.post("/api/settings/test-ai")
def test_ai(user=Depends(security.require_admin)):
    try:
        return {"message": ai.test_connection()}
    except Exception as e:
        raise HTTPException(400, str(e))


@app.post("/api/settings/run-check")
def run_check(user=Depends(security.require_admin)):
    return {"sent": scheduler.run_once()}


# ---- users (admin) ----------------------------------------------------------------------

class UserIn(BaseModel):
    username: str = Field(min_length=2, max_length=64)
    password: str
    is_admin: bool = False


@app.get("/api/users")
def list_users(user=Depends(security.require_admin)):
    return [dict(r) for r in db.q(
        "SELECT id, username, is_admin, created_at, last_login, totp_secret IS NOT NULL AS totp FROM users")]


@app.post("/api/users")
def add_user(body: UserIn, user=Depends(security.require_admin)):
    if p := security.password_problem(body.password):
        raise HTTPException(400, p)
    if db.q1("SELECT 1 FROM users WHERE username=?", (body.username.strip(),)):
        raise HTTPException(400, "Username taken")
    db.run("INSERT INTO users(username, pw_hash, is_admin) VALUES(?,?,?)",
           (body.username.strip(), security.hash_password(body.password), int(body.is_admin)))
    return {"ok": True}


@app.delete("/api/users/{uid}")
def delete_user(uid: int, user=Depends(security.require_admin)):
    if uid == user["id"]:
        raise HTTPException(400, "You can't delete yourself")
    for r in db.q("SELECT id, file_ext FROM documents WHERE user_id=?", (uid,)):
        (config.FILES_DIR / f"{r['id']}.{r['file_ext']}").unlink(missing_ok=True)
        thumb_path(r["id"]).unlink(missing_ok=True)
    db.run("DELETE FROM users WHERE id=?", (uid,))
    return {"ok": True}


# ---- frontend ------------------------------------------------------------------------------

@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/sw.js")
def sw():
    return FileResponse(STATIC / "sw.js", media_type="text/javascript", headers={"Cache-Control": "no-cache"})


@app.get("/manifest.webmanifest")
def manifest():
    return FileResponse(STATIC / "manifest.webmanifest", media_type="application/manifest+json")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
