"""Runtime configuration, read from environment variables."""
import os
from pathlib import Path

DATA_DIR = Path(os.environ.get("CV_DATA_DIR", "/data"))
FILES_DIR = DATA_DIR / "files"
THUMBS_DIR = DATA_DIR / "thumbs"
DB_PATH = DATA_DIR / "certvault.db"

# Max upload size in MB
MAX_UPLOAD_MB = int(os.environ.get("CV_MAX_UPLOAD_MB", "25"))

# Set to "true" when the app is served over HTTPS (e.g. Tailscale serve / reverse proxy)
# so the session cookie is marked Secure. "auto" trusts X-Forwarded-Proto / request scheme.
COOKIE_SECURE = os.environ.get("CV_COOKIE_SECURE", "auto").lower()

# Session lifetime (days of inactivity before you have to log in again)
SESSION_DAYS = int(os.environ.get("CV_SESSION_DAYS", "30"))

# Timezone for reminders (container TZ also respected)
TZ = os.environ.get("TZ", "Australia/Perth")

# Log level
LOG_LEVEL = os.environ.get("CV_LOG_LEVEL", "INFO")


def ensure_dirs() -> None:
    for d in (DATA_DIR, FILES_DIR, THUMBS_DIR):
        d.mkdir(parents=True, exist_ok=True)
