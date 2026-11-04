"""Notification channels: ntfy (Android push), email (SMTP), Home Assistant webhook."""
import logging
import smtplib
import ssl
from email.message import EmailMessage

import httpx

from . import db

log = logging.getLogger("certvault.notify")


def _ntfy(s: dict, title: str, body: str, urgent: bool, click: str | None):
    headers = {"Title": title.encode("utf-8").decode("latin-1", "ignore"),
               "Priority": "high" if urgent else "default",
               "Tags": "warning" if urgent else "calendar"}
    if click:
        headers["Click"] = click
    if s.get("ntfy_token"):
        headers["Authorization"] = f"Bearer {s['ntfy_token']}"
    r = httpx.post(s["ntfy_url"], content=body.encode(), headers=headers, timeout=20)
    r.raise_for_status()


def _email(s: dict, g: dict, title: str, body: str):
    msg = EmailMessage()
    msg["Subject"] = title
    msg["From"] = g.get("smtp_from") or g.get("smtp_user")
    msg["To"] = s["email_to"]
    msg.set_content(body)
    host, port = g["smtp_host"], int(g.get("smtp_port") or 587)
    ctx = ssl.create_default_context()
    if port == 465:
        with smtplib.SMTP_SSL(host, port, context=ctx, timeout=30) as smtp:
            if g.get("smtp_user"):
                smtp.login(g["smtp_user"], g.get("smtp_pass", ""))
            smtp.send_message(msg)
    else:
        with smtplib.SMTP(host, port, timeout=30) as smtp:
            smtp.ehlo()
            if smtp.has_extn("starttls"):
                smtp.starttls(context=ctx)
            elif g.get("smtp_user"):
                raise RuntimeError("Email server doesn't offer encryption — not sending the password in the clear")
            if g.get("smtp_user"):
                smtp.login(g["smtp_user"], g.get("smtp_pass", ""))
            smtp.send_message(msg)


def _homeassistant(s: dict, title: str, body: str, click: str | None):
    r = httpx.post(s["ha_webhook_url"], json={"title": title, "message": body, "url": click}, timeout=20)
    r.raise_for_status()


def send(user_id: int, title: str, body: str, urgent: bool = False, click: str | None = None) -> list[str]:
    """Send to every channel the user has configured. Returns list of channels that worked.
    Raises RuntimeError if channels are configured but all of them failed."""
    s = db.get_settings(user_id)
    g = db.get_settings(0)
    ok, errors = [], []
    if s.get("ntfy_url"):
        try:
            _ntfy(s, title, body, urgent, click)
            ok.append("ntfy")
        except Exception as e:
            errors.append(f"ntfy: {e}")
    if s.get("email_to") and g.get("smtp_host"):
        try:
            _email(s, g, title, body + (f"\n\n{click}" if click else ""))
            ok.append("email")
        except Exception as e:
            errors.append(f"email: {e}")
    if s.get("ha_webhook_url"):
        try:
            _homeassistant(s, title, body, click)
            ok.append("homeassistant")
        except Exception as e:
            errors.append(f"homeassistant: {e}")
    for e in errors:
        log.error("Notification failed for user %s: %s", user_id, e)
    if errors and not ok:
        raise RuntimeError("; ".join(errors))
    if not ok and not errors:
        raise RuntimeError("No notification channel set up yet (Settings → Notifications).")
    return ok
