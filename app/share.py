"""Sharing: email documents (with the actual files attached), ZIP "ticket packs",
plain-text summaries and calendar (.ics) files."""
import io
import re
import smtplib
import ssl
import zipfile
from datetime import date, datetime, timedelta
from email.message import EmailMessage
from email.utils import formataddr, make_msgid

from . import config, db, export, scheduler
from .categories import CATEGORY_BY_ID

MAX_EMAIL_BYTES = 20 * 1024 * 1024  # Gmail/Outlook cap is ~25 MB after encoding


def _fmt(iso: str | None) -> str:
    if not iso:
        return "—"
    try:
        return date.fromisoformat(iso[:10]).strftime("%-d %b %Y")
    except ValueError:
        return iso


def safe(name: str) -> str:
    return re.sub(r"[^\w\-. ()&]+", "_", name or "document").strip()[:90] or "document"


def doc_files(doc) -> list[tuple[str, "Path", str]]:
    """[(download name, path, mime)] for the main file + every extra side/page."""
    base = safe(doc["title"] or doc["original_name"] or "document")
    out = [(f"{base}{' - front' if _page_count(doc['id']) else ''}.{doc['file_ext']}",
            config.FILES_DIR / f"{doc['id']}.{doc['file_ext']}", doc["mime"])]
    for p in db.q("SELECT * FROM doc_pages WHERE doc_id=? ORDER BY sort, created_at", (doc["id"],)):
        label = safe(p["label"] or "page")
        out.append((f"{base} - {label.lower()}.{p['file_ext']}", config.FILES_DIR / f"{p['id']}.{p['file_ext']}", p["mime"]))
    return out


def _page_count(doc_id: str) -> int:
    return db.q1("SELECT COUNT(*) n FROM doc_pages WHERE doc_id=?", (doc_id,))["n"]


def summary_lines(doc) -> list[str]:
    cat = CATEGORY_BY_ID.get(doc["category"] or "other", CATEGORY_BY_ID["other"])
    reg = cat["kind"] == "register"
    rows = [
        ("Type", cat["name"]),
        ("Issued by", doc["issuer"]),
        ("Holder", doc["holder_name"]),
        ("Number", doc["licence_number"]),
        ("Classes / endorsements", doc["classes"]),
        ("Last inspected" if reg else "Completed / issued", _fmt(doc["completion_date"]) if doc["completion_date"] else None),
        ("Next inspection due" if reg else "Expires",
         "Does not expire" if doc["no_expiry"] else (_fmt(doc["expiry_date"]) + (" (estimated)" if doc["expiry_estimated"] else "")) if doc["expiry_date"] else None),
        ("Location", doc["location"]),
        ("RTO", doc["rto_code"]),
        ("Notes", doc["notes"]),
    ]
    return [f"{doc['title'] or 'Untitled'}"] + [f"  {k}: {v}" for k, v in rows if v]


def summary_text(docs) -> str:
    return "\n\n".join("\n".join(summary_lines(d)) for d in docs)


def _signature(user_id: int, username: str) -> str:
    s = db.get_settings(user_id)
    parts = [s.get("full_name") or username, s.get("company"), s.get("phone"), s.get("my_email")]
    return "\n".join(p for p in parts if p)


def send_email(user_id: int, username: str, docs, to: list[str], cc: list[str], message: str,
               attach_files: bool, attach_list: bool) -> int:
    g = db.get_settings(0)
    if not g.get("smtp_host"):
        raise RuntimeError("Email isn't set up yet — an admin needs to fill in Settings → Email server.")
    us = db.get_settings(user_id)
    sender_name = us.get("full_name") or username
    msg = EmailMessage()
    n = len(docs)
    msg["Subject"] = (f"{docs[0]['title']}" if n == 1 else f"{n} licences / tickets") + f" — {sender_name}"
    msg["From"] = formataddr((sender_name, g.get("smtp_from") or g.get("smtp_user")))
    msg["To"] = ", ".join(to)
    if cc:
        msg["Cc"] = ", ".join(cc)
    if us.get("my_email"):
        msg["Reply-To"] = us["my_email"]
    msg["Message-ID"] = make_msgid(domain="certvault.local")
    body = (message.strip() + "\n\n" if message and message.strip() else "Hi,\n\nPlease find my details below"
            + (" with copies attached" if attach_files else "") + ".\n\n")
    body += summary_text(docs) + "\n\n--\n" + _signature(user_id, username) + "\n"
    msg.set_content(body)
    total = 0
    if attach_files:
        for d in docs:
            for name, path, mime in doc_files(d):
                if not path.exists():
                    continue
                data = path.read_bytes()
                total += len(data)
                if total > MAX_EMAIL_BYTES:
                    raise RuntimeError("That's more than 20 MB of files — too big for most inboxes. "
                                       "Send fewer documents, or use Download ticket pack (ZIP) instead.")
                maintype, subtype = (mime or "application/octet-stream").split("/", 1)
                msg.add_attachment(data, maintype=maintype, subtype=subtype, filename=name)
    if attach_list:
        msg.add_attachment(_list_xlsx([d["id"] for d in docs], user_id, username),
                           maintype="application", subtype="vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                           filename=f"{safe(sender_name)} - ticket list.xlsx")
    host, port = g["smtp_host"], int(g.get("smtp_port") or 587)
    ctx = ssl.create_default_context()
    smtp_cls = smtplib.SMTP_SSL if port == 465 else smtplib.SMTP
    kwargs = {"context": ctx} if port == 465 else {}
    with smtp_cls(host, port, timeout=60, **kwargs) as smtp:
        if port != 465:
            smtp.ehlo()
            if smtp.has_extn("starttls"):
                smtp.starttls(context=ctx)
            elif g.get("smtp_user"):
                raise RuntimeError("That email server doesn't offer encryption — refusing to send your password in the clear.")
        if g.get("smtp_user"):
            smtp.login(g["smtp_user"], g.get("smtp_pass", ""))
        smtp.send_message(msg)
    return total


def _list_xlsx(doc_ids: list[str], user_id: int, username: str) -> bytes:
    return export.xlsx_bytes(user_id, username, only_ids=set(doc_ids))


def zip_pack(user_id: int, username: str, docs) -> bytes:
    buf = io.BytesIO()
    used = set()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for d in docs:
            cat = CATEGORY_BY_ID.get(d["category"] or "other", CATEGORY_BY_ID["other"])
            for name, path, _ in doc_files(d):
                if not path.exists():
                    continue
                arc = f"{safe(cat['name'])}/{name}"
                i = 2
                while arc in used:
                    stem, dot, ext = name.rpartition(".")
                    arc = f"{safe(cat['name'])}/{stem} ({i}).{ext}"
                    i += 1
                used.add(arc)
                z.write(path, arc)
        z.writestr("Summary.txt", f"Licences & tickets — {username}\nGenerated {datetime.now():%d/%m/%Y %H:%M}\n\n"
                   + summary_text(docs) + "\n")
        z.writestr("Ticket list.xlsx", _list_xlsx([d["id"] for d in docs], user_id, username))
    return buf.getvalue()


# ---- calendar ----------------------------------------------------------------------

def _ics_escape(s: str) -> str:
    return (s or "").replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def ics(docs, user_days: str) -> str:
    now = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//CertVault//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
             "X-WR-CALNAME:CertVault expiries"]
    for d in docs:
        if not d["expiry_date"]:
            continue
        exp = date.fromisoformat(d["expiry_date"])
        reg = CATEGORY_BY_ID.get(d["category"] or "other", CATEGORY_BY_ID["other"])["kind"] == "register"
        title = f"{d['title']} — {'inspection due' if reg else 'expires'}"
        lines += ["BEGIN:VEVENT", f"UID:{d['id']}-{d['expiry_date']}@certvault", f"DTSTAMP:{now}",
                  f"DTSTART;VALUE=DATE:{exp:%Y%m%d}", f"DTEND;VALUE=DATE:{exp + timedelta(days=1):%Y%m%d}",
                  f"SUMMARY:{_ics_escape(title)}", f"DESCRIPTION:{_ics_escape(chr(10).join(summary_lines(d)))}",
                  "TRANSP:TRANSPARENT"]
        for off in scheduler.parse_days(d["reminder_days"] or user_days):
            lines += ["BEGIN:VALARM", "ACTION:DISPLAY", f"DESCRIPTION:{_ics_escape(title)}",
                      f"TRIGGER:-P{off}DT0H" if off else "TRIGGER:PT9H", "END:VALARM"]
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    return "\r\n".join(lines) + "\r\n"
