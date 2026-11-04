"""Master list: every document in one table, every field, no pictures.

Available as a download (Excel / CSV) and kept up to date automatically on the NAS at
  /data/exports/<username> - CertVault Master List.xlsx  (and .csv)
so you can open it straight from the SMB share.
"""
import csv
import io
import logging
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

from . import config, db, scheduler, versions
from .categories import CATEGORY_BY_ID, KINDS

log = logging.getLogger("certvault.export")

COLUMNS = [
    ("Status", 12), ("Days left", 9), ("Version", 10), ("Title", 40), ("Kind", 18), ("Type", 26), ("Issued by", 30),
    ("Issuer type", 16), ("Holder", 22), ("Number", 18), ("Completed / last inspected", 16),
    ("Expiry / next due", 16), ("Expiry estimated", 10), ("Doesn't expire", 10), ("Location", 26),
    ("Folders", 26), ("Classes / endorsements", 40), ("RTO code", 10), ("Cost", 10), ("Tags", 20), ("Required for", 26),
    ("How to renew", 30), ("Sides / pages", 8), ("Last shared", 24),
    ("Notes", 50), ("Reminder days", 14), ("Review status", 12), ("Read by", 20), ("File name", 30),
    ("Uploaded", 16), ("Last updated", 16), ("ID", 34),
]

COL = {name: i for i, (name, _) in enumerate(COLUMNS, 1)}

STATUS_TEXT = {"expired": "EXPIRED", "soon": "Due ≤30 days", "valid": "Current",
               "none": "No expiry", "unknown": "No date", "processing": "Reading…"}
FILLS = {"expired": "FFDAD6", "soon": "FFDEA3", "valid": "B7F1B0", "none": "DFE0FF", "unknown": "E2E2E9"}


def _d(v):
    if not v:
        return None
    try:
        return date.fromisoformat(v[:10])
    except ValueError:
        return None


def _dt(v):
    """DB timestamps are UTC -> local time (naive, for Excel)."""
    if not v:
        return None
    try:
        utc = datetime.fromisoformat(v.replace(" ", "T")[:19]).replace(tzinfo=timezone.utc)
        return utc.astimezone(ZoneInfo(config.TZ)).replace(tzinfo=None)
    except ValueError:
        return None


def rows_for(user_id: int, only_ids: set | None = None) -> list[dict]:
    today = scheduler.today_local()
    default_days = db.get_setting(user_id, "reminder_days") or scheduler.DEFAULT_DAYS
    out = []
    all_rows = db.q("SELECT * FROM documents WHERE user_id=?", (user_id,))
    old = versions.superseded_ids(all_rows)
    pages = {r["doc_id"]: r["n"] for r in db.q(
        "SELECT doc_id, COUNT(*) n FROM doc_pages WHERE doc_id IN (SELECT id FROM documents WHERE user_id=?) GROUP BY doc_id", (user_id,))}
    last_share = {}
    for sh in db.q("SELECT doc_ids, recipient, method, created_at FROM shares WHERE user_id=? ORDER BY id", (user_id,)):
        for did in sh["doc_ids"].split(","):
            last_share[did] = f"{sh['recipient'] or sh['method']} ({(_dt(sh['created_at']) or datetime.now()):%d/%m/%Y})"
    fnames = {}
    try:
        for fr in db.q("SELECT dc.doc_id, c.name FROM doc_collections dc JOIN collections c ON c.id=dc.collection_id "
                       "WHERE c.user_id=? AND dc.excluded=0 ORDER BY c.name", (user_id,)):
            fnames.setdefault(fr["doc_id"], []).append(fr["name"])
    except Exception:
        pass
    for r in all_rows:
        if only_ids is not None and r["id"] not in only_ids:
            continue
        cat = CATEGORY_BY_ID.get(r["category"] or "other", CATEGORY_BY_ID["other"])
        exp = _d(r["expiry_date"])
        days = (exp - today).days if exp else None
        if r["status"] == "processing":
            state = "processing"
        elif days is None:
            state = "none" if r["no_expiry"] else "unknown"
        else:
            state = "expired" if days < 0 else "soon" if days <= 30 else "valid"
        out.append({
            "_state": state,
            "Status": STATUS_TEXT[state],
            "Days left": days,
            "Version": "Previous" if r["id"] in old else "Current",
            "Title": r["title"],
            "Kind": KINDS[cat["kind"]]["name"],
            "Type": cat["name"],
            "Issued by": r["issuer"],
            "Issuer type": (r["issuer_type"] or "").capitalize() or None,
            "Holder": r["holder_name"],
            "Number": r["licence_number"],
            "Completed / last inspected": _d(r["completion_date"]),
            "Expiry / next due": exp,
            "Expiry estimated": "Yes" if r["expiry_estimated"] else "",
            "Doesn't expire": "Yes" if r["no_expiry"] else "",
            "Location": r["location"],
            "Folders": ", ".join(fnames.get(r["id"], [])) or None,
            "Classes / endorsements": r["classes"],
            "RTO code": r["rto_code"],
            "Cost": r["cost"],
            "Tags": r["tags"],
            "Required for": r["required_for"],
            "How to renew": r["renewal_info"],
            "Sides / pages": 1 + pages.get(r["id"], 0),
            "Last shared": last_share.get(r["id"]),
            "Notes": r["notes"],
            "Reminder days": r["reminder_days"] or f"Default ({default_days})",
            "Review status": "Confirmed" if r["status"] == "ok" else "Needs check" if r["status"] == "review" else r["status"],
            "Read by": (r["extract_source"] or "").replace("ai:", "AI ") or None,
            "File name": r["original_name"],
            "Uploaded": _dt(r["created_at"]),
            "Last updated": _dt(r["updated_at"]),
            "ID": r["id"],
        })
    for x in out:
        if x["Version"] == "Previous":
            x["_order_old"] = 1
    order = {"expired": 0, "soon": 1, "valid": 2, "unknown": 3, "none": 4, "processing": 5}
    out.sort(key=lambda x: (x.get("_order_old", 0), order[x["_state"]], x["Days left"] if x["Days left"] is not None else 10**6, x["Title"] or ""))
    return out


def xlsx_bytes(user_id: int, username: str, only_ids: set | None = None) -> bytes:
    rows = rows_for(user_id, only_ids)
    wb = Workbook()
    ws = wb.active
    ws.title = "Master List"
    head_fill = PatternFill("solid", fgColor="415F91")
    ws.append([c for c, _ in COLUMNS])
    for i, (name, width) in enumerate(COLUMNS, 1):
        cell = ws.cell(row=1, column=i)
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = head_fill
        cell.alignment = Alignment(vertical="center", wrap_text=True)
        ws.column_dimensions[get_column_letter(i)].width = width
    ws.row_dimensions[1].height = 32
    for r in rows:
        ws.append([r[c] for c, _ in COLUMNS])
        row = ws.max_row
        fill = FILLS.get(r["_state"])
        if fill:
            ws.cell(row=row, column=1).fill = PatternFill("solid", fgColor=fill)
            ws.cell(row=row, column=COL["Expiry / next due"]).fill = PatternFill("solid", fgColor=fill)
        if r["Version"] == "Previous":
            for c in range(1, len(COLUMNS) + 1):
                ws.cell(row=row, column=c).font = Font(color="808080")
        for col, fmt in ((COL["Completed / last inspected"], "DD/MM/YYYY"), (COL["Expiry / next due"], "DD/MM/YYYY"),
                         (COL["Uploaded"], "DD/MM/YYYY HH:MM"), (COL["Last updated"], "DD/MM/YYYY HH:MM")):
            ws.cell(row=row, column=col).number_format = fmt
        ws.cell(row=row, column=COL["Notes"]).alignment = Alignment(wrap_text=True, vertical="top")
    ws.freeze_panes = "D2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(COLUMNS))}{max(ws.max_row, 1)}"
    info = wb.create_sheet("About")
    info.append(["CertVault master list"])
    info.append(["Owner", username])
    info.append(["Generated", datetime.now().strftime("%d/%m/%Y %H:%M")])
    info.append(["Documents", len(rows)])
    info.append(["Expired", sum(1 for r in rows if r["_state"] == "expired")])
    info.append(["Due within 30 days", sum(1 for r in rows if r["_state"] == "soon")])
    info["A1"].font = Font(bold=True, size=14)
    info.column_dimensions["A"].width = 22
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def csv_text(user_id: int) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([c for c, _ in COLUMNS])
    for r in rows_for(user_id):
        vals = []
        for c, _ in COLUMNS:
            v = r[c]
            if isinstance(v, datetime):
                v = v.strftime("%d/%m/%Y %H:%M")
            elif isinstance(v, date):
                v = v.strftime("%d/%m/%Y")
            vals.append("" if v is None else v)
        w.writerow(vals)
    return "﻿" + buf.getvalue()  # BOM so Excel opens it as UTF-8


def safe_name(username: str) -> str:
    return "".join(ch for ch in username if ch.isalnum() or ch in "-_ ") or "user"


def write_master(user_id: int) -> None:
    """Refresh the always-current master list files on the NAS."""
    try:
        u = db.q1("SELECT username FROM users WHERE id=?", (user_id,))
        if not u:
            return
        d = config.DATA_DIR / "exports"
        d.mkdir(exist_ok=True)
        base = f"{safe_name(u['username'])} ({user_id}) - CertVault Master List"
        for ext in ("xlsx", "csv"):  # pre-1.8 name
            (d / f"{safe_name(u['username'])} - CertVault Master List.{ext}").unlink(missing_ok=True)
        tmp = d / f".{base}.xlsx.tmp"
        tmp.write_bytes(xlsx_bytes(user_id, u["username"]))
        tmp.replace(d / f"{base}.xlsx")
        tmp = d / f".{base}.csv.tmp"
        tmp.write_text(csv_text(user_id), encoding="utf-8")
        tmp.replace(d / f"{base}.csv")
    except Exception:
        log.exception("Couldn't write master list for user %s", user_id)
    try:
        from .naming import write_library
        write_library(user_id)
    except Exception:
        log.exception("Couldn't refresh library for user %s", user_id)
