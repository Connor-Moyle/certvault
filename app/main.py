"""CertVault — self-hosted licence / ticket / induction tracker."""
import hashlib
import io
import re
import shutil
import logging
import secrets
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

import pyotp
import qrcode
import qrcode.image.svg
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import files as files_mod
from . import pdfconv
from . import folders
from . import backup
from . import ai, config, db, export, extract, files, naming, notify, scheduler, security, share, versions
from .categories import CATEGORIES, CATEGORY_BY_ID, KINDS, is_register, kind_of

logging.basicConfig(level=config.LOG_LEVEL, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("certvault")

STATIC = Path(__file__).parent / "static"
VERSION = "1.7.0"

app = FastAPI(title="CertVault", docs_url=None, redoc_url=None, openapi_url=None)
worker = ThreadPoolExecutor(max_workers=1)  # one document at a time — gentle on the NAS

SETUP_CODE: str | None = None


# ---- startup ----------------------------------------------------------------------

@app.on_event("startup")
def startup():
    global SETUP_CODE
    config.ensure_dirs()
    if backup.apply_pending_restore():
        log.warning("Restored from backup")
    db.init()
    folders.init()
    if not db.q1("SELECT 1 FROM users"):
        SETUP_CODE = secrets.token_hex(4).upper()
        (config.DATA_DIR / "SETUP_CODE.txt").write_text(SETUP_CODE + "\n")
        log.warning("=" * 60)
        log.warning("  No users yet. Open the web UI and use setup code: %s", SETUP_CODE)
        log.warning("  (also saved to %s)", config.DATA_DIR / "SETUP_CODE.txt")
        log.warning("=" * 60)
    # clear half-finished uploads
    import time
    for t in (config.DATA_DIR / "tmp").glob("*"):
        try:
            if t.is_file() and time.time() - t.stat().st_mtime > 86400:
                t.unlink()
        except OSError:
            pass
    # documents stuck in 'processing' after a restart -> re-queue
    for r in db.q("SELECT id FROM documents WHERE status='processing'"):
        worker.submit(process_document, r["id"], "full")
    for u in db.q("SELECT id FROM users"):
        export.write_master(u["id"])
    # file documents into folders (organisations, Medicals, Gov docs)
    for r in db.q("SELECT id FROM documents WHERE status<>'processing'"):
        try:
            folders.auto_assign(r["id"])
        except Exception:
            log.exception("auto folder failed")
    # make PDFs for documents uploaded before v1.6
    for r in db.q("SELECT id FROM documents WHERE file_ext IS NOT NULL AND COALESCE(has_pdf,'0') IN ('0', 0) "
                  "AND status<>'processing'"):
        worker.submit(build_pdf_and_sync, r["id"])
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
    d.pop("ai_text", None)
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
    d["kind"] = cat["kind"]
    d["has_file"] = bool(d["file_ext"])
    d["has_pdf"] = str(d.get("has_pdf") or "0") in ("1", "True")
    d["renew_months"] = int(d["renew_months"]) if str(d.get("renew_months") or "").isdigit() else None
    return d


def get_doc(doc_id: str, user) -> dict:
    row = db.q1("SELECT * FROM documents WHERE id=? AND user_id=?", (doc_id, user["id"]))
    if not row:
        raise HTTPException(404, "Not found")
    return row


def file_path(row) -> Path | None:
    return config.FILES_DIR / f"{row['id']}.{row['file_ext']}" if row["file_ext"] else None


def thumb_path(doc_id: str) -> Path:
    return config.THUMBS_DIR / f"{doc_id}.jpg"


# fields the reader (OCR / AI) fills in
EXTRACTED = ["title", "category", "issuer", "issuer_type", "holder_name", "licence_number",
             "completion_date", "expiry_date", "expiry_estimated", "no_expiry", "location", "notes",
             "classes", "rto_code", "cost"]


def build_pdf(doc_id: str) -> bool:
    """(Re)build the combined searchable PDF for a document."""
    row = db.q1("SELECT * FROM documents WHERE id=?", (doc_id,))
    if not row:
        return False
    try:
        ok = pdfconv.build_combined(row, page_rows(doc_id)) is not None
    except Exception:
        log.exception("PDF build failed for %s", doc_id)
        ok = False
    if not ok:
        pdfconv.combined_path(doc_id).unlink(missing_ok=True)
    db.run("UPDATE documents SET has_pdf=? WHERE id=?", (int(ok), doc_id))
    return ok


def build_pdf_and_sync(doc_id: str) -> None:
    build_pdf(doc_id)
    row = db.q1("SELECT user_id FROM documents WHERE id=?", (doc_id,))
    if row:
        export.write_master(row["user_id"])


def page_rows(doc_id: str):
    return db.q("SELECT * FROM doc_pages WHERE doc_id=? ORDER BY sort, created_at", (doc_id,))


def page_path(p) -> Path:
    return config.FILES_DIR / f"{p['id']}.{p['file_ext']}"


def process_document(doc_id: str, mode: str = "full"):
    """mode: 'full' = overwrite all extracted fields, 'fill' = only fill blanks."""
    row = db.q1("SELECT * FROM documents WHERE id=?", (doc_id,))
    if not row:
        return
    path = file_path(row)
    error = None
    if path is not None:
        build_pdf(doc_id)
    if path is None:  # manual entry without a file
        db.run("UPDATE documents SET status='ok' WHERE id=? AND status='processing'", (doc_id,))
        return
    try:
        text = row["ocr_text"]
        if not text:
            text = extract.get_text(path, row["file_ext"])
            db.run("UPDATE documents SET ocr_text=? WHERE id=?", (text, doc_id))
        files = [(path, row["file_ext"])]
        for p in page_rows(doc_id):
            ptext = p["ocr_text"]
            if ptext is None:
                ptext = extract.get_text(page_path(p), p["file_ext"])
                db.run("UPDATE doc_pages SET ocr_text=? WHERE id=?", (ptext, p["id"]))
            text += f"\n\n--- {p['label'] or 'Next page'} ---\n{ptext}"
            files.append((page_path(p), p["file_ext"]))
        fields = extract.rule_extract(text, scheduler.today_local())
        source = "ocr"
        ai_text = None
        readable = bool(text.strip()) or any(extract.is_visual(e) for _, e in files)
        if not readable:
            error = (f"{files_mod.kind_label(row['file_ext'])} file stored safely — CertVault can't read this type, "
                     "so fill in the details (or add a photo/PDF of it as another page).")
            fields = {"category": row["category"] or "other", "title": row["title"]}
        combined = pdfconv.combined_path(doc_id)
        ai_files = [(combined, "pdf")] if combined.exists() and (len(files) > 1 or not extract.is_visual(files[0][1])) else files
        if ai.enabled() and readable:
            try:
                ai_fields, source = ai.analyse(ai_files, text)
                ai_text = ai_fields.pop("transcript", None)
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
        for k in EXTRACTED:
            if k not in fields:
                continue
            v = fields.get(k)
            if isinstance(v, bool):
                v = int(v)
            if mode == "fill" and row[k] not in (None, "", 0):
                continue
            sets.append(f"{k}=?")
            vals.append(v)
        new_status = "review" if row["status"] in ("processing", "review", "error") or mode == "full" else row["status"]
        sets += ["extract_source=?", "extract_error=?", "status=?", "ai_text=?", "updated_at=datetime('now')"]
        vals += [source, error, new_status, ai_text, doc_id]
        db.run(f"UPDATE documents SET {', '.join(sets)} WHERE id=?", vals)
        log.info("Processed %s via %s", doc_id, source)
        try:
            folders.auto_assign(doc_id)
        except Exception:
            log.exception("auto folder failed")
        if naming.settings(row["user_id"]).get("name_titles") == "1":
            fresh = db.q1("SELECT * FROM documents WHERE id=?", (doc_id,))
            db.run("UPDATE documents SET title=? WHERE id=?", (naming.build(fresh), doc_id))
        export.write_master(row["user_id"])
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
        db.log_activity(user["id"] if user else None, "login failed", body.username[:64], ip)
        raise HTTPException(401, "Wrong username or password")
    if user["totp_secret"]:
        if not body.totp:
            return JSONResponse({"totp_required": True}, status_code=401)
        if not security.verify_totp(user["totp_secret"], body.totp):
            security.record_failure(ip, body.username)
            raise HTTPException(401, "Wrong 2-step code")
    security.clear_failures(body.username)
    db.log_activity(user["id"], "login", (request.headers.get("user-agent") or "")[:120], ip)
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
            "csrf": user["csrf"], "totp_enabled": bool(user["totp_secret"]), "ai_enabled": ai.enabled(),
            "max_upload_mb": config.MAX_UPLOAD_MB}


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
    return {"categories": [{k: c[k] for k in ("id", "name", "icon", "color", "validity_years", "kind")} for c in CATEGORIES],
            "kinds": KINDS}


@app.get("/api/documents")
def list_documents(user=Depends(security.require_user)):
    rows = db.q("SELECT * FROM documents WHERE user_id=? ORDER BY "
                "CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END, expiry_date, created_at DESC", (user["id"],))
    fm = folders.doc_folder_ids(user["id"])
    out = versions.annotate([doc_state(r) for r in rows])
    for d in out:
        d["folders"] = fm.get(d["id"], [])
    return out


async def _read_upload(f: UploadFile) -> list[files.Stored]:
    """Stream one upload to disk, then convert/unpack it. Any file type is accepted; a ZIP gives many."""
    limit = config.MAX_UPLOAD_MB * 1024 * 1024
    raw = files.tmp_dir() / f"up-{uuid.uuid4().hex}"
    size = 0
    try:
        with open(raw, "wb") as out:
            while chunk := await f.read(4 * 1024 * 1024):
                size += len(chunk)
                if size > limit:
                    raise ValueError(f"larger than {config.MAX_UPLOAD_MB} MB (raise CV_MAX_UPLOAD_MB if you need more)")
                out.write(chunk)
        if size == 0:
            raise ValueError("file is empty")
        return files.prepare(raw, f.filename or "upload")
    finally:
        raw.unlink(missing_ok=True)


def _place(st: files.Stored, file_id: str) -> bool:
    """Move a prepared file into storage; returns has_thumb."""
    dest = config.FILES_DIR / f"{file_id}.{st.ext}"
    shutil.move(str(st.path), dest)
    return extract.make_thumbnail(dest, st.ext, thumb_path(file_id))


def _add_page(doc_id: str, st: files.Stored, label: str | None) -> str:
    pid = uuid.uuid4().hex
    has_thumb = _place(st, pid)
    n = db.q1("SELECT COUNT(*) n FROM doc_pages WHERE doc_id=?", (doc_id,))["n"]
    db.run("INSERT INTO doc_pages(id, doc_id, label, sort, original_name, file_ext, mime, size, sha256, has_thumb) "
           "VALUES(?,?,?,?,?,?,?,?,?,?)",
           (pid, doc_id, (label or ("Back" if n == 0 else f"Page {n + 2}"))[:40], n + 1, st.name, st.ext, st.mime,
            st.size, st.sha256, int(has_thumb)))
    return pid


def _new_document(user_id: int, st: files.Stored) -> str:
    doc_id = uuid.uuid4().hex
    has_thumb = _place(st, doc_id)
    readable = extract.is_visual(st.ext) or st.ext in extract.SHEETS or st.ext in (
        "docx", "odt", "xls", "txt", "md", "eml", "rtf", "json", "pptx", "html", "xml")
    db.run("INSERT INTO documents(id, user_id, original_name, file_ext, mime, size, sha256, has_thumb, title, status, extract_error) "
           "VALUES(?,?,?,?,?,?,?,?,?,'processing',?)",
           (doc_id, user_id, st.name, st.ext, st.mime, st.size, st.sha256, int(has_thumb), Path(st.name).stem[:100],
            None if readable else f"{files.kind_label(st.ext)} file stored — it can't be read automatically, so fill in the details."))
    return doc_id


@app.post("/api/documents")
async def upload(request: Request, files_: list[UploadFile] = File(..., alias="files"), group: int = Form(0),
                 user=Depends(security.require_user)):
    """Any file type. group=1: the first file is the front, the rest are the back / extra pages of ONE document.
    ZIPs are unpacked and every file inside imported."""
    if len(files_) > 200:
        raise HTTPException(400, "Max 200 files per request")
    results = []
    main_id = None
    for f in files_:
        try:
            prepared = await _read_upload(f)
        except ValueError as e:
            results.append({"name": f.filename, "error": str(e)})
            continue
        except Exception as e:
            log.exception("upload failed")
            results.append({"name": f.filename, "error": f"Couldn't save: {e}"})
            continue
        for st in prepared:
            label = st.name if st.name != files.clean_name(f.filename or "") else f.filename
            try:
                if group and main_id:
                    _add_page(main_id, st, None)
                    results.append({"name": label, "id": main_id, "page": True})
                    continue
                dup = db.q1("SELECT id FROM documents WHERE user_id=? AND sha256=?", (user["id"], st.sha256))
                if dup:
                    st.path.unlink(missing_ok=True)
                    results.append({"name": label, "id": dup["id"], "duplicate": True})
                    continue
                doc_id = _new_document(user["id"], st)
                if group:
                    main_id = doc_id
                else:
                    worker.submit(process_document, doc_id, "full")
                results.append({"name": label, "id": doc_id, "from_zip": st.name != files.clean_name(f.filename or "")})
            except Exception as e:
                log.exception("store failed")
                st.path.unlink(missing_ok=True)
                results.append({"name": label, "error": f"Couldn't save: {e}"})
    if main_id:
        worker.submit(process_document, main_id, "full")
    added = [r for r in results if r.get("id") and not r.get("duplicate") and not r.get("page")]
    if added:
        db.log_activity(user["id"], "upload", f"{len(added)} document(s)" + (" (front & back)" if group else ""),
                        security.client_ip(request))
    return results


@app.post("/api/documents/{doc_id}/pages")
async def add_page(doc_id: str, request: Request, file: UploadFile = File(...), label: str = Form(""),
                   user=Depends(security.require_user)):
    row = get_doc(doc_id, user)
    try:
        prepared = await _read_upload(file)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not prepared:
        raise HTTPException(400, "Nothing to add")
    first, rest = prepared[0], prepared[1:]
    if not row["file_ext"]:  # manual entry: first file becomes the document itself
        has_thumb = _place(first, doc_id)
        db.run("UPDATE documents SET file_ext=?, mime=?, size=?, sha256=?, has_thumb=?, original_name=?, status='processing' WHERE id=?",
               (first.ext, first.mime, first.size, first.sha256, int(has_thumb), first.name, doc_id))
    else:
        _add_page(doc_id, first, label.strip() or None)
    for st in rest:
        _add_page(doc_id, st, None)
    pid = doc_id
    # re-read with the new side: fully if not yet confirmed, otherwise only fill blanks (keeps your edits)
    db.run("UPDATE documents SET status='processing' WHERE id=?", (doc_id,))
    worker.submit(process_document, doc_id, "full" if row["status"] != "ok" else "fill")
    db.log_activity(user["id"], "add page", f"{label or 'page'} → {row['title']}", security.client_ip(request))
    return {"id": pid}


def get_page(doc_id: str, pid: str, user):
    get_doc(doc_id, user)
    p = db.q1("SELECT * FROM doc_pages WHERE id=? AND doc_id=?", (pid, doc_id))
    if not p:
        raise HTTPException(404)
    return p


@app.get("/api/documents/{doc_id}/pages/{pid}/file")
def page_file(doc_id: str, pid: str, download: int = 0, user=Depends(security.require_user)):
    p = get_page(doc_id, pid, user)
    doc = get_doc(doc_id, user)
    return _serve(page_path(p), p["file_ext"], p["mime"], naming.build(doc, side=p["label"] or "Page", ext=p["file_ext"]), download)


@app.get("/api/documents/{doc_id}/pages/{pid}/thumb")
def page_thumb(doc_id: str, pid: str, user=Depends(security.require_user)):
    p = get_page(doc_id, pid, user)
    t = thumb_path(pid)
    if not p["has_thumb"] or not t.exists():
        raise HTTPException(404)
    return FileResponse(t, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})


class PageIn(BaseModel):
    label: str = Field(max_length=40)


@app.patch("/api/documents/{doc_id}/pages/{pid}")
def rename_page(doc_id: str, pid: str, body: PageIn, user=Depends(security.require_user)):
    get_page(doc_id, pid, user)
    db.run("UPDATE doc_pages SET label=? WHERE id=?", (body.label.strip() or "Page", pid))
    return {"ok": True}


@app.delete("/api/documents/{doc_id}/pages/{pid}")
def delete_page(doc_id: str, pid: str, user=Depends(security.require_user)):
    p = get_page(doc_id, pid, user)
    page_path(p).unlink(missing_ok=True)
    thumb_path(pid).unlink(missing_ok=True)
    db.run("DELETE FROM doc_pages WHERE id=?", (pid,))
    worker.submit(build_pdf_and_sync, doc_id)
    return {"ok": True}


@app.get("/api/documents/{doc_id}")
def get_document(doc_id: str, user=Depends(security.require_user)):
    row = get_doc(doc_id, user)
    alld = versions.annotate([doc_state(r) for r in db.q("SELECT * FROM documents WHERE user_id=?", (user["id"],))])
    d = next(x for x in alld if x["id"] == doc_id)
    d["ocr_text"] = row["ocr_text"]
    d["ai_text"] = row["ai_text"]
    d["history"] = [{k: x[k] for k in ("id", "title", "issuer", "completion_date", "expiry_date", "state", "days_left",
                                        "superseded", "status", "icon", "color", "kind")}
                    for x in versions.group_of(alld, doc_id)]
    d["pages"] = [{k: p[k] for k in ("id", "label", "file_ext", "has_thumb", "size", "original_name")}
                  for p in page_rows(doc_id)]
    d["folders"] = [dict(r) for r in db.q(
        "SELECT c.id, c.name, c.icon, c.color, dc.auto FROM doc_collections dc JOIN collections c ON c.id=dc.collection_id "
        "WHERE dc.doc_id=? AND dc.excluded=0 ORDER BY c.name", (doc_id,))]
    d["shares"] = [dict(r) for r in db.q(
        "SELECT method, recipient, created_at FROM shares WHERE user_id=? AND (',' || doc_ids || ',') LIKE ? "
        "ORDER BY id DESC LIMIT 20", (user["id"], f"%,{doc_id},%"))]
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
    version_group: str | None = Field(None, max_length=20)
    classes: str | None = Field(None, max_length=1000)
    rto_code: str | None = Field(None, max_length=40)
    cost: str | None = Field(None, max_length=40)
    tags: str | None = Field(None, max_length=300)
    required_for: str | None = Field(None, max_length=500)
    renewal_info: str | None = Field(None, max_length=1000)
    renew_months: int | None = Field(None, ge=0, le=240)


@app.patch("/api/documents/{doc_id}")
def update_document(doc_id: str, body: DocIn, request: Request, user=Depends(security.require_user)):
    row = get_doc(doc_id, user)
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
    if "version_group" in data and data["version_group"] not in (None, "", "solo"):
        raise HTTPException(400, "version_group must be 'solo' or empty")
    if data.get("tags"):
        data["tags"] = ", ".join(dict.fromkeys(t.strip() for t in data["tags"].split(",") if t.strip()))
    for k, v in list(data.items()):
        if isinstance(v, bool):
            data[k] = int(v)
        elif isinstance(v, str):
            data[k] = v.strip() or None
    if not data:  # "Looks right" — just confirm
        db.run("UPDATE documents SET status='ok', updated_at=datetime('now') WHERE id=? AND user_id=?", (doc_id, user["id"]))
        export.write_master(user["id"])
        return doc_state(get_doc(doc_id, user))
    sets = ", ".join(f"{k}=?" for k in data) + ", status='ok', updated_at=datetime('now')"
    db.run(f"UPDATE documents SET {sets} WHERE id=? AND user_id=?", (*data.values(), doc_id, user["id"]))
    db.log_activity(user["id"], "edit", row["title"], security.client_ip(request))
    export.write_master(user["id"])
    return doc_state(get_doc(doc_id, user))


@app.delete("/api/documents/{doc_id}")
def delete_document(doc_id: str, request: Request, user=Depends(security.require_user)):
    row = get_doc(doc_id, user)
    for p in page_rows(doc_id):
        page_path(p).unlink(missing_ok=True)
        thumb_path(p["id"]).unlink(missing_ok=True)
    if file_path(row):
        file_path(row).unlink(missing_ok=True)
    pdfconv.combined_path(doc_id).unlink(missing_ok=True)
    thumb_path(doc_id).unlink(missing_ok=True)
    db.run("DELETE FROM documents WHERE id=?", (doc_id,))
    db.log_activity(user["id"], "delete", row["title"], security.client_ip(request))
    export.write_master(user["id"])
    return {"ok": True}


# ---- sharing ------------------------------------------------------------------------------

def _docs_for(user, ids: list[str]):
    ids = [i for i in dict.fromkeys(ids) if i][:200]
    if not ids:
        raise HTTPException(400, "Pick at least one document")
    rows = db.q(f"SELECT * FROM documents WHERE user_id=? AND id IN ({','.join('?' * len(ids))})", (user["id"], *ids))
    if len(rows) != len(ids):
        raise HTTPException(404, "Document not found")
    order = {i: n for n, i in enumerate(ids)}
    return sorted(rows, key=lambda r: order[r["id"]])


EMAIL_RX = re.compile(r"^[^@\s,;<>]+@[^@\s,;<>]+\.[a-z]{2,}$", re.I)


class ShareEmailIn(BaseModel):
    ids: list[str]
    to: str = Field(max_length=500)
    cc: str | None = Field(None, max_length=500)
    message: str | None = Field(None, max_length=4000)
    attach_files: bool = True
    attach_list: bool = False


def _emails(s: str | None) -> list[str]:
    out = [e.strip() for e in re.split(r"[,;\s]+", s or "") if e.strip()]
    bad = [e for e in out if not EMAIL_RX.match(e)]
    if bad:
        raise HTTPException(400, f"Not a valid email: {bad[0]}")
    return out


@app.post("/api/share/email")
def share_email(body: ShareEmailIn, request: Request, user=Depends(security.require_user)):
    docs = _docs_for(user, body.ids)
    to, cc = _emails(body.to), _emails(body.cc)
    if not to:
        raise HTTPException(400, "Who should it go to?")
    if len(to) + len(cc) > 10:
        raise HTTPException(400, "Max 10 recipients")
    try:
        share.send_email(user["id"], user["username"], docs, to, cc, body.message or "", body.attach_files, body.attach_list)
    except RuntimeError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        log.exception("share email failed")
        raise HTTPException(502, f"Email server said: {e}")
    rec = ", ".join(to + cc)
    db.run("INSERT INTO shares(user_id, doc_ids, method, recipient) VALUES(?,?,?,?)",
           (user["id"], ",".join(d["id"] for d in docs), "email", rec))
    db.log_activity(user["id"], "share email", f"{len(docs)} doc(s) → {rec}", security.client_ip(request))
    export.write_master(user["id"])
    return {"ok": True, "sent_to": rec}


class ShareLogIn(BaseModel):
    ids: list[str]
    method: str = Field(max_length=20)
    recipient: str | None = Field(None, max_length=200)


@app.post("/api/share/log")
def share_log(body: ShareLogIn, request: Request, user=Depends(security.require_user)):
    """Record a share done on the phone (share sheet / copy) so it shows in the history."""
    docs = _docs_for(user, body.ids)
    method = body.method if body.method in ("phone", "copy", "zip", "download") else "other"
    db.run("INSERT INTO shares(user_id, doc_ids, method, recipient) VALUES(?,?,?,?)",
           (user["id"], ",".join(d["id"] for d in docs), method, (body.recipient or "").strip() or None))
    db.log_activity(user["id"], f"share {method}", f"{len(docs)} doc(s)", security.client_ip(request))
    return {"ok": True}


@app.get("/api/share/zip")
def share_zip(ids: str, request: Request, user=Depends(security.require_user)):
    docs = _docs_for(user, ids.split(","))
    data = share.zip_pack(user["id"], user["username"], docs)
    db.run("INSERT INTO shares(user_id, doc_ids, method) VALUES(?,?,?)", (user["id"], ",".join(d["id"] for d in docs), "zip"))
    db.log_activity(user["id"], "ticket pack", f"{len(docs)} doc(s)", security.client_ip(request))
    fn = f"{export.safe_name(db.get_setting(user['id'], 'full_name') or user['username'])} - ticket pack {date.today():%Y-%m-%d}.zip"
    return Response(data, media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="{fn}"', "Cache-Control": "no-store"})


@app.get("/api/share/pack.pdf")
def share_pack_pdf(ids: str, request: Request, user=Depends(security.require_user)):
    """Everything in ONE PDF: cover page with a summary table, then each document."""
    docs = _docs_for(user, ids.split(","))
    for d in docs:
        if d["file_ext"] and not pdfconv.combined_path(d["id"]).exists():
            build_pdf(d["id"])
    data = share.pack_pdf(user["id"], user["username"], docs)
    db.run("INSERT INTO shares(user_id, doc_ids, method) VALUES(?,?,?)", (user["id"], ",".join(d["id"] for d in docs), "pdf"))
    db.log_activity(user["id"], "ticket pack PDF", f"{len(docs)} doc(s)", security.client_ip(request))
    fn = f"{export.safe_name(db.get_setting(user['id'], 'full_name') or user['username'])} - tickets {date.today():%Y-%m-%d}.pdf"
    return Response(data, media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="{fn}"', "Cache-Control": "no-store"})


@app.get("/api/share/text")
def share_text(ids: str, user=Depends(security.require_user)):
    return {"text": share.summary_text(_docs_for(user, ids.split(",")))}


@app.get("/api/share/recent")
def share_recent(user=Depends(security.require_user)):
    seen = []
    for r in db.q("SELECT recipient FROM shares WHERE user_id=? AND method='email' AND recipient IS NOT NULL "
                  "ORDER BY id DESC LIMIT 50", (user["id"],)):
        for e in r["recipient"].split(", "):
            if e not in seen:
                seen.append(e)
    return seen[:8]


# ---- folders (organisations / groups) ---------------------------------------------------------

def _folder_summary(user, c, today, old, docs_by_id, links) -> dict:
    ids = [i for i in links.get(c["id"], []) if i in docs_by_id and i not in old]
    states = [folders._state(docs_by_id[i], today) for i in ids]
    chk = folders.checklist(user["id"], c["id"], today, old)
    return {**dict(c), "count": len(ids), "expired": states.count("expired"), "soon": states.count("soon"),
            "requirements": [x for x in (c["requirements"] or "").split(",") if x],
            "ready": sum(1 for x in chk if x["state"] in ("valid", "none")), "required": len(chk),
            "missing": sum(1 for x in chk if x["state"] == "missing")}


@app.get("/api/folders")
def list_folders(user=Depends(security.require_user)):
    today = scheduler.today_local()
    all_docs = db.q("SELECT * FROM documents WHERE user_id=?", (user["id"],))
    old = versions.superseded_ids(all_docs)
    by_id = {d["id"]: d for d in all_docs}
    links: dict[int, list[str]] = {}
    for r in db.q("SELECT dc.collection_id, dc.doc_id FROM doc_collections dc JOIN collections c ON c.id=dc.collection_id "
                  "WHERE c.user_id=? AND dc.excluded=0", (user["id"],)):
        links.setdefault(r["collection_id"], []).append(r["doc_id"])
    cols = db.q("SELECT * FROM collections WHERE user_id=? ORDER BY ctype DESC, name", (user["id"],))
    return [_folder_summary(user, c, today, old, by_id, links) for c in cols]


@app.get("/api/folders/{cid}")
def get_folder(cid: int, user=Depends(security.require_user)):
    c = db.q1("SELECT * FROM collections WHERE id=? AND user_id=?", (cid, user["id"]))
    if not c:
        raise HTTPException(404)
    today = scheduler.today_local()
    all_docs = db.q("SELECT * FROM documents WHERE user_id=?", (user["id"],))
    old = versions.superseded_ids(all_docs)
    ids = [r["doc_id"] for r in db.q("SELECT doc_id FROM doc_collections WHERE collection_id=? AND excluded=0", (cid,))]
    out = _folder_summary(user, c, today, old, {d["id"]: d for d in all_docs}, {cid: ids})
    out["doc_ids"] = ids
    out["checklist"] = folders.checklist(user["id"], cid, today, old)
    sector = folders.ORG_SECTOR.get(c["name"])
    out["suggested"] = folders.SUGGESTED.get(sector) or (folders.SUGGESTED["mining"] if c["ctype"] == "org" else [])
    return out


class FolderIn(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=80)
    icon: str | None = Field(None, max_length=40)
    color: str | None = Field(None, max_length=20)
    requirements: list[str] | None = None
    notes: str | None = Field(None, max_length=2000)


@app.post("/api/folders")
def create_folder(body: FolderIn, user=Depends(security.require_user)):
    if not body.name:
        raise HTTPException(400, "Give the folder a name")
    if db.q1("SELECT 1 FROM collections WHERE user_id=? AND name=?", (user["id"], body.name.strip())):
        raise HTTPException(400, "A folder with that name already exists")
    reqs = ",".join(r for r in (body.requirements or []) if r in CATEGORY_BY_ID)
    cid = db.run("INSERT INTO collections(user_id, name, icon, color, ctype, requirements, notes) VALUES(?,?,?,?,'custom',?,?)",
                 (user["id"], body.name.strip(), body.icon or "folder_open", body.color or "blue", reqs or None, body.notes))
    return {"id": cid}


@app.patch("/api/folders/{cid}")
def update_folder(cid: int, body: FolderIn, user=Depends(security.require_user)):
    if not db.q1("SELECT 1 FROM collections WHERE id=? AND user_id=?", (cid, user["id"])):
        raise HTTPException(404)
    data = body.model_dump(exclude_unset=True)
    if "requirements" in data:
        data["requirements"] = ",".join(r for r in (data["requirements"] or []) if r in CATEGORY_BY_ID) or None
    if "name" in data and data["name"]:
        data["name"] = data["name"].strip()
    if data:
        db.run(f"UPDATE collections SET {', '.join(f'{k}=?' for k in data)} WHERE id=?", (*data.values(), cid))
    export.write_master(user["id"])
    return {"ok": True}


@app.delete("/api/folders/{cid}")
def delete_folder(cid: int, user=Depends(security.require_user)):
    c = db.q1("SELECT * FROM collections WHERE id=? AND user_id=?", (cid, user["id"]))
    if not c:
        raise HTTPException(404)
    db.run("DELETE FROM collections WHERE id=?", (cid,))
    if c["auto_key"]:  # don't let auto-filing recreate it
        db.set_setting(user["id"], "auto_folders_blocked", ",".join(filter(None, [db.get_setting(user["id"], "auto_folders_blocked"), c["auto_key"]])))
    export.write_master(user["id"])
    return {"ok": True}


class FolderDocsIn(BaseModel):
    add: list[str] = []
    remove: list[str] = []


@app.post("/api/folders/{cid}/docs")
def folder_docs(cid: int, body: FolderDocsIn, user=Depends(security.require_user)):
    if not db.q1("SELECT 1 FROM collections WHERE id=? AND user_id=?", (cid, user["id"])):
        raise HTTPException(404)
    if body.add:
        _docs_for(user, body.add)
    for did in body.add:
        db.run("INSERT INTO doc_collections(doc_id, collection_id, auto, excluded) VALUES(?,?,0,0) "
               "ON CONFLICT(doc_id, collection_id) DO UPDATE SET excluded=0, auto=0", (did, cid))
    for did in body.remove:
        db.run("UPDATE doc_collections SET excluded=1 WHERE doc_id=? AND collection_id=?", (did, cid))
    export.write_master(user["id"])
    return {"ok": True}


# ---- search inside documents -------------------------------------------------------------------

@app.get("/api/search")
def search(q: str, user=Depends(security.require_user)):
    """Find documents by any word in them — including the scanned/AI text of every side."""
    terms = [t for t in re.split(r"\s+", q.strip().lower()) if len(t) >= 2][:6]
    if not terms:
        return []
    out = []
    rows = db.q("SELECT d.id, d.title, d.issuer, d.licence_number, d.classes, d.notes, d.ocr_text, d.ai_text, "
                "(SELECT group_concat(p.ocr_text, ' ') FROM doc_pages p WHERE p.doc_id=d.id) AS pages_text "
                "FROM documents d WHERE d.user_id=?", (user["id"],))
    for r in rows:
        hay = " ".join(str(r[k] or "") for k in ("title", "issuer", "licence_number", "classes", "notes", "ai_text", "ocr_text", "pages_text"))
        low = hay.lower()
        if all(t in low for t in terms):
            i = low.find(terms[0])
            snip = re.sub(r"\s+", " ", hay[max(0, i - 40): i + 80]).strip()
            out.append({"id": r["id"], "snippet": ("…" if i > 40 else "") + snip + "…"})
    return out[:100]


# ---- backup / restore ----------------------------------------------------------------------------

@app.get("/api/backup")
def download_backup(request: Request, user=Depends(security.require_admin)):
    path = backup.full_zip()
    db.log_activity(user["id"], "backup downloaded", path.name, security.client_ip(request))
    from starlette.background import BackgroundTask
    return FileResponse(path, media_type="application/zip", filename=path.name,
                        background=BackgroundTask(lambda: path.unlink(missing_ok=True)))


@app.post("/api/restore")
async def restore_backup(request: Request, file: UploadFile = File(...), user=Depends(security.require_admin)):
    tmp = files.tmp_dir() / f"restore-{uuid.uuid4().hex}.zip"
    try:
        with open(tmp, "wb") as out:
            while chunk := await file.read(4 * 1024 * 1024):
                out.write(chunk)
        try:
            backup.stage_restore(tmp)
        except ValueError as e:
            raise HTTPException(400, str(e))
        except Exception as e:
            raise HTTPException(400, f"Couldn't read that backup: {e}")
    finally:
        tmp.unlink(missing_ok=True)
    db.log_activity(user["id"], "restore staged", file.filename, security.client_ip(request))
    backup.restart_soon()
    return {"ok": True, "message": "Restoring — CertVault restarts in a few seconds. Log in again when it's back."}


# ---- file naming -------------------------------------------------------------------------------

@app.get("/api/naming")
def naming_info(user=Depends(security.require_user)):
    s = naming.settings(user["id"])
    return {"tokens": naming.TOKENS, "separators": naming.SEPARATORS,
            "datefmts": {k: v[0] for k, v in naming.DATEFMTS.items()}, "current": s, "preview": naming.preview(user["id"], s)}


class NamingIn(BaseModel):
    name_tokens: str = Field(max_length=200)
    name_sep: str = Field(max_length=5)
    name_datefmt: str = Field(max_length=10)
    name_case: str = Field("as-is", max_length=10)


@app.post("/api/naming/preview")
def naming_preview(body: NamingIn, user=Depends(security.require_user)):
    s = {**naming.settings(user["id"]), **body.model_dump()}
    return {"preview": naming.preview(user["id"], s)}


@app.post("/api/naming/apply-titles")
def naming_apply(request: Request, user=Depends(security.require_user)):
    s = naming.settings(user["id"])
    rows = db.q("SELECT * FROM documents WHERE user_id=? AND status<>'processing'", (user["id"],))
    for r in rows:
        db.run("UPDATE documents SET title=?, updated_at=datetime('now') WHERE id=?", (naming.build(r, s), r["id"]))
    db.log_activity(user["id"], "renamed titles", f"{len(rows)} document(s)", security.client_ip(request))
    export.write_master(user["id"])
    return {"renamed": len(rows)}


@app.get("/api/share/files")
def share_files(ids: str, user=Depends(security.require_user)):
    """Download URLs + nice names for sharing from the phone."""
    out = []
    pdf_first = db.get_setting(user["id"], "share_format", "pdf") == "pdf"
    for d in _docs_for(user, ids.split(",")):
        s = naming.settings(user["id"])
        if pdf_first and pdfconv.combined_path(d["id"]).exists():
            out.append({"url": f"/api/documents/{d['id']}/pdf", "name": naming.build(d, s, ext="pdf")})
            continue
        pages = page_rows(d["id"])
        if d["file_ext"]:
            out.append({"url": f"/api/documents/{d['id']}/file", "name": naming.build(d, s, side="Front" if pages else None, ext=d["file_ext"])})
        for p in pages:
            out.append({"url": f"/api/documents/{d['id']}/pages/{p['id']}/file", "name": naming.build(d, s, side=p["label"] or "Page", ext=p["file_ext"])})
    return out


# ---- calendar ---------------------------------------------------------------------------------

@app.get("/api/calendar.ics")
def calendar_all(ids: str | None = None, user=Depends(security.require_user)):
    rows = db.q("SELECT * FROM documents WHERE user_id=? AND expiry_date IS NOT NULL", (user["id"],))
    old = versions.superseded_ids(db.q("SELECT * FROM documents WHERE user_id=?", (user["id"],)))
    if ids:
        want = set(ids.split(","))
        rows = [r for r in rows if r["id"] in want]
    else:
        rows = [r for r in rows if r["id"] not in old]
    body = share.ics(rows, db.get_setting(user["id"], "reminder_days") or scheduler.DEFAULT_DAYS)
    name = "certvault-expiries.ics" if not ids else "certvault-reminder.ics"
    return Response(body, media_type="text/calendar; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"})


# ---- activity log ---------------------------------------------------------------------------------

@app.get("/api/activity")
def activity(user=Depends(security.require_user)):
    if user["is_admin"]:
        rows = db.q("SELECT a.ts, a.action, a.detail, a.ip, u.username FROM activity a LEFT JOIN users u ON u.id=a.user_id "
                    "ORDER BY a.id DESC LIMIT 200")
    else:
        rows = db.q("SELECT a.ts, a.action, a.detail, a.ip, ? AS username FROM activity a WHERE user_id=? "
                    "ORDER BY a.id DESC LIMIT 200", (user["username"], user["id"]))
    return [dict(r) for r in rows]


class ManualIn(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    category: str = "other"
    issuer: str | None = Field(None, max_length=300)
    licence_number: str | None = Field(None, max_length=100)
    completion_date: str | None = None
    expiry_date: str | None = None
    renew_months: int | None = Field(None, ge=0, le=240)
    notes: str | None = Field(None, max_length=4000)


@app.post("/api/documents/manual")
def create_manual(body: ManualIn, request: Request, user=Depends(security.require_user)):
    """Track something that has no file (a service due, a subscription, BAS…) — add a file later if you like."""
    if body.category not in CATEGORY_BY_ID:
        raise HTTPException(400, "Unknown category")
    dates = {}
    for k in ("completion_date", "expiry_date"):
        v = getattr(body, k)
        try:
            dates[k] = date.fromisoformat(v).isoformat() if v else None
        except ValueError:
            raise HTTPException(400, f"Bad date for {k}")
    doc_id = uuid.uuid4().hex
    db.run("INSERT INTO documents(id, user_id, title, category, issuer, licence_number, completion_date, expiry_date, "
           "renew_months, notes, status, extract_source) VALUES(?,?,?,?,?,?,?,?,?,?,'ok','manual')",
           (doc_id, user["id"], body.title.strip(), body.category, body.issuer, body.licence_number,
            dates["completion_date"], dates["expiry_date"], body.renew_months, body.notes))
    db.log_activity(user["id"], "add (no file)", body.title, security.client_ip(request))
    export.write_master(user["id"])
    return {"id": doc_id}


class RenewIn(BaseModel):
    months: int | None = Field(None, ge=1, le=240)
    new_expiry: str | None = None


@app.post("/api/documents/{doc_id}/renew")
def renew(doc_id: str, body: RenewIn, request: Request, user=Depends(security.require_user)):
    """Mark something renewed / done: rolls the due date forward by its renewal period."""
    row = get_doc(doc_id, user)
    today = scheduler.today_local()
    if body.new_expiry:
        try:
            new_exp = date.fromisoformat(body.new_expiry)
        except ValueError:
            raise HTTPException(400, "Bad date")
    else:
        months = body.months or (int(row["renew_months"]) if str(row["renew_months"] or "").isdigit() else None)
        if not months:
            vy = CATEGORY_BY_ID.get(row["category"] or "other", CATEGORY_BY_ID["other"])["validity_years"]
            months = round(vy * 12) if vy else None
        if not months:
            raise HTTPException(400, "How often does this renew? Set 'Renews every' on the edit screen.")
        old = date.fromisoformat(row["expiry_date"]) if row["expiry_date"] else None
        # renew from the old due date if it's recent/upcoming (rego, insurance), otherwise from today
        base = old if old and (old - today).days > -60 else today
        new_exp = extract.add_months(base, months)
        body.months = months
    note = f"Renewed {today:%d/%m/%Y} (was due {row['expiry_date'] or '—'})"
    db.run("UPDATE documents SET completion_date=?, expiry_date=?, expiry_estimated=0, no_expiry=0, renew_months=COALESCE(?, renew_months), "
           "notes=TRIM(COALESCE(notes,'') || CASE WHEN notes IS NULL OR notes='' THEN '' ELSE char(10) END || ?), "
           "status='ok', updated_at=datetime('now') WHERE id=?",
           (today.isoformat(), new_exp.isoformat(), body.months, note, doc_id))
    db.log_activity(user["id"], "renewed", f"{row['title']} → {new_exp:%d/%m/%Y}", security.client_ip(request))
    export.write_master(user["id"])
    return doc_state(get_doc(doc_id, user))


@app.post("/api/documents/{doc_id}/rescan")
def rescan(doc_id: str, user=Depends(security.require_user)):
    if not get_doc(doc_id, user)["file_ext"]:
        raise HTTPException(400, "This entry has no file to read — add one first")
    db.run("UPDATE documents SET status='processing', ocr_text=NULL WHERE id=?", (doc_id,))
    worker.submit(process_document, doc_id, "full")
    return {"ok": True}


@app.post("/api/documents-rescan-all")
def rescan_all(user=Depends(security.require_user)):
    rows = db.q("SELECT id FROM documents WHERE user_id=? AND status<>'processing' AND file_ext IS NOT NULL", (user["id"],))
    for r in rows:
        worker.submit(process_document, r["id"], "fill")
    return {"queued": len(rows)}


DANGEROUS_MIME = ("text/html", "image/svg", "text/xml", "application/xml", "text/javascript", "application/javascript",
                  "application/xhtml")


def _serve(path: Path, ext: str, mime: str, name: str, download: int):
    """Only PDFs and photos are shown inline; everything else downloads. Uploaded HTML/SVG/JS can
    never run in the app's origin (attachment + octet-stream + sandbox CSP)."""
    inline = not download and ext in files.VIEWABLE
    if not mime or mime.startswith(DANGEROUS_MIME):
        mime = "application/octet-stream"
    headers = {"Cache-Control": "private, no-store"}
    if not inline:  # downloads: can never be rendered as a page in our origin
        headers["Content-Security-Policy"] = "sandbox; default-src 'none'"
    return FileResponse(path, media_type=mime, filename=name, content_disposition_type="inline" if inline else "attachment",
                        headers=headers)


@app.get("/api/documents/{doc_id}/file")
def get_file(doc_id: str, download: int = 0, user=Depends(security.require_user)):
    row = get_doc(doc_id, user)
    if not row["file_ext"]:
        raise HTTPException(404, "No file attached")
    side = "Front" if page_rows(doc_id) else None
    return _serve(file_path(row), row["file_ext"], row["mime"], naming.build(row, side=side, ext=row["file_ext"]), download)


@app.get("/api/documents/{doc_id}/pdf")
def get_pdf(doc_id: str, download: int = 0, user=Depends(security.require_user)):
    """The document as ONE searchable PDF (every side/page)."""
    row = get_doc(doc_id, user)
    p = pdfconv.combined_path(doc_id)
    if not p.exists():
        raise HTTPException(404, "PDF not ready yet")
    return _serve(p, "pdf", "application/pdf", naming.build(row, ext="pdf"), download)


@app.get("/api/documents/{doc_id}/thumb")
def get_thumb(doc_id: str, user=Depends(security.require_user)):
    row = get_doc(doc_id, user)
    p = thumb_path(doc_id)
    if not row["has_thumb"] or not p.exists():
        raise HTTPException(404)
    return FileResponse(p, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})


# ---- master list ----------------------------------------------------------------------

@app.get("/api/master")
def master(user=Depends(security.require_user)):
    rows = export.rows_for(user["id"])
    for r in rows:
        for k, v in r.items():
            if hasattr(v, "isoformat"):
                r[k] = v.isoformat()
    return {"columns": [c for c, _ in export.COLUMNS], "rows": rows}


@app.get("/api/master.xlsx")
def master_xlsx(user=Depends(security.require_user)):
    fn = f"{export.safe_name(user['username'])} - CertVault Master List {date.today():%Y-%m-%d}.xlsx"
    return Response(export.xlsx_bytes(user["id"], user["username"]), media_type=extract.XLSX_MIME,
                    headers={"Content-Disposition": f'attachment; filename="{fn}"', "Cache-Control": "no-store"})


@app.get("/api/master.csv")
def master_csv(user=Depends(security.require_user)):
    fn = f"{export.safe_name(user['username'])} - CertVault Master List {date.today():%Y-%m-%d}.csv"
    return Response(export.csv_text(user["id"]), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{fn}"', "Cache-Control": "no-store"})


# ---- settings -------------------------------------------------------------------------

USER_KEYS = ["reminder_days", "remind_expired_weekly", "ntfy_url", "ntfy_token", "email_to", "ha_webhook_url",
             "full_name", "company", "phone", "my_email",
             "name_tokens", "name_sep", "name_datefmt", "name_case", "name_titles", "library", "share_format", "library_format",
             "weekly_digest", "auto_folders"]
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
def put_settings(body: SettingsIn, request: Request, user=Depends(security.require_user)):
    db.log_activity(user["id"], "settings", ", ".join(list(body.user) + list(body.global_))[:200], security.client_ip(request))
    for k, v in body.user.items():
        if k not in USER_KEYS or v == MASK:
            continue
        if k == "reminder_days":
            v = ",".join(str(x) for x in scheduler.parse_days(v))
        if k == "name_tokens":
            v = ",".join(t for t in (v or "").split(",") if t in naming.TOKENS) or naming.DEFAULT["name_tokens"]
        if k == "name_sep" and v not in naming.SEPARATORS:
            v = naming.DEFAULT["name_sep"]
        if k == "name_datefmt" and v not in naming.DATEFMTS:
            v = "iso"
        if k == "name_case" and v not in ("as-is", "upper", "title", "lower"):
            v = "as-is"
        if k in ("name_sep",):
            db.set_setting(user["id"], k, v)  # keep spaces
            continue
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
    if any(k.startswith("name_") or k == "library" for k in body.user):
        worker.submit(export.write_master, user["id"])
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
        for p in page_rows(r["id"]):
            page_path(p).unlink(missing_ok=True)
            thumb_path(p["id"]).unlink(missing_ok=True)
        if r["file_ext"]:
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
