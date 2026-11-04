"""File naming scheme (Settings → File naming).

You pick the parts and their order, e.g.  Holder · Type · Expiry  ->  "Connor Moyle - First Aid - 2028-03-14.pdf".
Used for downloads, email attachments, ZIP packs, phone sharing and the auto-named library copy on the NAS.
Optionally also renames document titles.
"""
import os
import re
import shutil
from datetime import date
from pathlib import Path

from . import config, db
from .categories import CATEGORY_BY_ID, KINDS

TOKENS = {
    "holder":    "Holder name",
    "title":     "Title",
    "type":      "Ticket / licence type",
    "kind":      "Group (Tickets, Insurance…)",
    "number":    "Licence / policy number",
    "classes":   "Classes (CV DG RB)",
    "issuer":    "Issued by",
    "expiry":    "Expiry / due date",
    "completed": "Completed / issued date",
    "year":      "Year completed",
    "status":    "Status (CURRENT / EXPIRED)",
}
DEFAULT = {"name_tokens": "holder,type,expiry", "name_sep": " - ", "name_datefmt": "iso", "name_case": "as-is",
           "name_titles": "0", "library": "1", "library_format": "pdf"}
SEPARATORS = {" - ": "Name - Type - Date", "_": "Name_Type_Date", " ": "Name Type Date", " · ": "Name · Type · Date"}
DATEFMTS = {"iso": ("2028-03-14", "%Y-%m-%d"), "au": ("14-03-2028", "%d-%m-%Y"), "long": ("14 Mar 2028", "%-d %b %Y"),
            "month": ("Mar 2028", "%b %Y")}


def settings(user_id: int) -> dict:
    s = {**DEFAULT, **{k: v for k, v in db.get_settings(user_id).items() if k in DEFAULT and v}}
    return s


def _fmt_date(iso: str | None, fmt: str) -> str | None:
    if not iso:
        return None
    try:
        return date.fromisoformat(iso[:10]).strftime(DATEFMTS.get(fmt, DATEFMTS["iso"])[1])
    except ValueError:
        return None


def _clean(part: str) -> str:
    part = re.sub(r"[\\/:*?\"<>|\x00-\x1f]+", " ", part)  # Windows-illegal characters
    return re.sub(r"\s+", " ", part).strip(" .-_")


def token_values(doc, s: dict, today: date | None = None) -> dict:
    cat = CATEGORY_BY_ID.get(doc["category"] or "other", CATEGORY_BY_ID["other"])
    classes = doc["classes"] or ""
    codes = " ".join(c.split(" – ")[0].strip() for c in classes.split(";") if c.strip()) if classes else None
    status = None
    if doc["expiry_date"]:
        try:
            status = "EXPIRED" if date.fromisoformat(doc["expiry_date"]) < (today or date.today()) else "CURRENT"
        except ValueError:
            pass
    return {
        "holder": doc["holder_name"],
        "title": doc["title"],
        "type": cat["name"] if cat["id"] != "other" else (
            doc["title"] if doc["title"] and doc["title"] != "Other" else Path(doc["original_name"] or "Document").stem),
        "kind": KINDS[cat["kind"]]["name"],
        "number": doc["licence_number"],
        "classes": codes,
        "issuer": doc["issuer"],
        "expiry": _fmt_date(doc["expiry_date"], s["name_datefmt"]) or ("No expiry" if doc["no_expiry"] else None),
        "completed": _fmt_date(doc["completion_date"], s["name_datefmt"]),
        "year": (doc["completion_date"] or "")[:4] or None,
        "status": status,
    }


def build(doc, s: dict | None = None, side: str | None = None, ext: str | None = None, user_id: int | None = None) -> str:
    """Name for a document's file (no folder). side = 'Front' / 'Back' / 'Page 3' when it has several."""
    s = s or settings(user_id or doc["user_id"])
    vals = token_values(doc, s)
    parts = []
    for t in (s["name_tokens"] or DEFAULT["name_tokens"]).split(","):
        v = vals.get(t.strip())
        if v:
            parts.append(_clean(str(v)))
    if not parts:
        parts = [_clean(doc["title"] or doc["original_name"] or "Document")]
    # drop exact repeats (e.g. title == type)
    seen, uniq = set(), []
    for p in parts:
        if p.lower() not in seen:
            uniq.append(p)
            seen.add(p.lower())
    if side:
        uniq.append(_clean(side))
    name = s["name_sep"].join(uniq)
    if s["name_case"] == "upper":
        name = name.upper()
    elif s["name_case"] == "title":
        name = name.title()
    elif s["name_case"] == "lower":
        name = name.lower()
    name = name[:150].rstrip(" .-_") or "Document"
    return f"{name}.{ext}" if ext else name


def preview(user_id: int, s: dict) -> list[str]:
    rows = db.q("SELECT * FROM documents WHERE user_id=? AND status<>'processing' ORDER BY updated_at DESC LIMIT 3", (user_id,))
    return [build(r, s, ext=r["file_ext"] or "pdf") for r in rows]


# ---- auto-named library copy on the NAS --------------------------------------------------

def _copy(src: Path, dst: Path) -> None:
    """Independent copy (never a hard link): editing a library file over SMB can't touch the vault's original."""
    tmp = dst.with_name(f".{dst.name}.part")
    shutil.copy2(src, tmp)
    tmp.replace(dst)


def _same(src: Path, dst: Path) -> bool:
    try:
        a, b = src.stat(), dst.stat()
        return a.st_size == b.st_size and int(a.st_mtime) == int(b.st_mtime) and b.st_nlink == 1
    except OSError:
        return False


def user_folder(user_id: int, username: str) -> str:
    from .export import safe_name
    return f"{safe_name(username)} ({user_id})"


def write_library(user_id: int) -> None:
    """/data/library/<user (id)>/<Group>/<Type>/<nice name>.<ext> — browse it over SMB, always matches the app.
    These are independent copies: changing or deleting them never affects what's stored in CertVault."""
    u = db.q1("SELECT username FROM users WHERE id=?", (user_id,))
    if not u:
        return
    s = settings(user_id)
    root = config.DATA_DIR / "library" / user_folder(user_id, u["username"])
    from .export import safe_name
    legacy = config.DATA_DIR / "library" / safe_name(u["username"])  # pre-1.8 layout
    if legacy.exists() and legacy != root and not db.q1("SELECT 1 FROM users WHERE id<>? AND username=?", (user_id, u["username"])):
        shutil.rmtree(legacy, ignore_errors=True)
    if s.get("library") != "1":
        shutil.rmtree(root, ignore_errors=True)
        return
    want: dict[Path, Path] = {}
    for d in db.q("SELECT * FROM documents WHERE user_id=? AND file_ext IS NOT NULL", (user_id,)):
        cat = CATEGORY_BY_ID.get(d["category"] or "other", CATEGORY_BY_ID["other"])
        folder = root / _clean(KINDS[cat["kind"]]["name"]) / _clean(cat["name"])
        combined = config.FILES_DIR / f"{d['id']}.combined.pdf"
        if s.get("library_format", "pdf") == "pdf" and combined.exists():
            items = [(combined, "pdf", None)]
        else:
            pages = db.q("SELECT * FROM doc_pages WHERE doc_id=? ORDER BY sort, created_at", (d["id"],))
            items = [(config.FILES_DIR / f"{d['id']}.{d['file_ext']}", d["file_ext"], "Front" if pages else None)]
            items += [(config.FILES_DIR / f"{p['id']}.{p['file_ext']}", p["file_ext"], p["label"] or "Page") for p in pages]
        for src, ext, side in items:
            if not src.exists():
                continue
            name = build(d, s, side=side, ext=ext)
            dst = folder / name
            n = 2
            while dst in want:
                dst = folder / f"{Path(name).stem} ({n}){Path(name).suffix}"
                n += 1
            want[dst] = src
            # also file it under each folder it belongs to (Western Power, Medicals …)
            try:
                for fr in db.q("SELECT c.name FROM doc_collections dc JOIN collections c ON c.id=dc.collection_id "
                               "WHERE dc.doc_id=? AND dc.excluded=0", (d["id"],)):
                    fdst = root / "By folder" / _clean(fr["name"]) / dst.name
                    if fdst not in want:
                        want[fdst] = src
            except Exception:
                pass
    # sync: add missing / changed, remove stale
    for dst, src in want.items():
        dst.parent.mkdir(parents=True, exist_ok=True)
        if dst.exists() and _same(src, dst):
            continue
        if dst.exists():
            dst.unlink()
        _copy(src, dst)
    if root.exists():
        for f in sorted(root.rglob("*"), reverse=True):
            if f.is_file() and f not in want:
                f.unlink(missing_ok=True)
            elif f.is_dir() and not any(f.iterdir()):
                f.rmdir()
