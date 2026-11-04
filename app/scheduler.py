"""Daily expiry check. Runs inside the app process — no cron needed.

Default reminder points: 30, 14, 7 and 0 days before expiry (editable per user and per document).
If the NAS was off on a reminder day, the most urgent missed reminder is sent once on the next
check (older ones are skipped so you don't get spammed).
"""
import logging
import threading
import time
from datetime import date, datetime
from zoneinfo import ZoneInfo

from . import config, db, notify

log = logging.getLogger("certvault.scheduler")

DEFAULT_DAYS = "30,14,7,0"


def parse_days(s: str | None) -> list[int]:
    out = set()
    for part in (s or DEFAULT_DAYS).replace(" ", "").split(","):
        if part.lstrip("-").isdigit():
            n = int(part)
            if 0 <= n <= 730:
                out.add(n)
    return sorted(out, reverse=True) or [30, 14, 7, 0]


def today_local() -> date:
    return datetime.now(ZoneInfo(config.TZ)).date()


def fmt(d: date) -> str:
    return d.strftime("%-d %b %Y")


def message_for(doc, days_left: int, exp: date) -> tuple[str, str, bool]:
    name = doc["title"] or "A document"
    if days_left > 1:
        return (f"{name} expires in {days_left} days",
                f"{name} expires on {fmt(exp)}. Time to book the renewal.", days_left <= 7)
    if days_left == 1:
        return f"{name} expires tomorrow", f"{name} expires tomorrow ({fmt(exp)}).", True
    if days_left == 0:
        return f"{name} expires TODAY", f"{name} expires today ({fmt(exp)}).", True
    return (f"{name} has EXPIRED", f"{name} expired on {fmt(exp)} ({-days_left} days ago).", True)


def check_user(user_id: int, today: date | None = None) -> int:
    today = today or today_local()
    us = db.get_settings(user_id)
    user_days = us.get("reminder_days") or DEFAULT_DAYS
    weekly_overdue = us.get("remind_expired_weekly", "1") == "1"
    base = (db.get_setting(0, "public_url") or "").rstrip("/")
    sent = 0
    docs = db.q("SELECT * FROM documents WHERE user_id=? AND expiry_date IS NOT NULL "
                "AND status IN ('ok','review')", (user_id,))
    for d in docs:
        try:
            exp = date.fromisoformat(d["expiry_date"])
        except ValueError:
            continue
        days_left = (exp - today).days
        offsets = parse_days(d["reminder_days"] or user_days)
        if days_left >= 0:
            due = [o for o in offsets if days_left <= o]
            if not due:
                continue
            key = min(due)  # most urgent threshold reached
        else:
            if not weekly_overdue:
                key = 0
            else:
                key = -((-days_left) // 7) - 1  # -1 = first overdue week, -2 = second...
        if db.q1("SELECT 1 FROM reminders_sent WHERE doc_id=? AND offset_days=? AND expiry_date=?",
                 (d["id"], key, d["expiry_date"])):
            continue
        title, body, urgent = message_for(d, days_left, exp)
        try:
            notify.send(user_id, title, body, urgent, f"{base}/#/doc/{d['id']}" if base else None)
        except Exception as e:
            log.error("Reminder for %s not sent: %s", d["id"], e)
            continue
        with db.tx() as c:
            # mark this and every less-urgent threshold as done so catch-up doesn't spam
            for o in [o for o in offsets if o >= max(key, 0)] + [key]:
                c.execute("INSERT OR IGNORE INTO reminders_sent(doc_id, offset_days, expiry_date) VALUES(?,?,?)",
                          (d["id"], o, d["expiry_date"]))
        sent += 1
        log.info("Reminder sent: %s", title)
    return sent


def run_once() -> int:
    total = 0
    for u in db.q("SELECT id FROM users"):
        total += check_user(u["id"])
    db.set_setting(0, "last_check", datetime.now(ZoneInfo(config.TZ)).isoformat(timespec="minutes"))
    return total


def _loop():
    time.sleep(10)
    while True:
        try:
            now = datetime.now(ZoneInfo(config.TZ))
            hour = int(db.get_setting(0, "notify_hour", "8"))
            last = db.get_setting(0, "last_check_date")
            if now.hour >= hour and last != now.date().isoformat():
                n = run_once()
                db.set_setting(0, "last_check_date", now.date().isoformat())
                log.info("Daily expiry check done, %d reminder(s) sent", n)
        except Exception:
            log.exception("Scheduler error")
        time.sleep(300)


def start():
    threading.Thread(target=_loop, name="scheduler", daemon=True).start()
