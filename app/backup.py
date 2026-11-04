"""Backups.

* Nightly: a consistent copy of the database to /data/backups (last 14 kept). Your files live on the
  NAS dataset, so ZFS snapshots cover them.
* Settings → Backup: download a full backup ZIP (database + every file) and restore one.
  A restore is staged, then the app restarts itself (TrueNAS brings it straight back up) and swaps it in.
"""
import logging
import os
import shutil
import sqlite3
import threading
import zipfile
from datetime import datetime
from pathlib import Path

from . import config

log = logging.getLogger("certvault.backup")

BACKUP_DIR_NAME = "backups"
RESTORE_DIR_NAME = "restore-pending"
KEEP = 14


def _db_copy(dest: Path) -> None:
    src = sqlite3.connect(config.DB_PATH)
    try:
        out = sqlite3.connect(dest)
        with out:
            src.backup(out)
        out.close()
    finally:
        src.close()


def nightly() -> Path | None:
    d = config.DATA_DIR / BACKUP_DIR_NAME
    d.mkdir(exist_ok=True)
    dest = d / f"certvault-{datetime.now():%Y-%m-%d}.db"
    if dest.exists():
        return None
    _db_copy(dest)
    for old in sorted(d.glob("certvault-*.db"))[:-KEEP]:
        old.unlink(missing_ok=True)
    log.info("Database backup written: %s", dest.name)
    return dest


def full_zip() -> Path:
    """certvault.db + files/ + thumbs/ in one ZIP (written to /data/tmp, caller deletes)."""
    tmp = config.DATA_DIR / "tmp"
    tmp.mkdir(exist_ok=True)
    out = tmp / f"certvault-backup-{datetime.now():%Y-%m-%d-%H%M}.zip"
    dbcopy = tmp / f"db-{os.getpid()}.db"
    _db_copy(dbcopy)
    try:
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as z:
            z.write(dbcopy, "certvault.db")
            for sub in ("files", "thumbs"):
                for f in (config.DATA_DIR / sub).rglob("*"):
                    if f.is_file() and not f.name.endswith(".tmp"):
                        z.write(f, f"{sub}/{f.relative_to(config.DATA_DIR / sub)}",
                                compress_type=zipfile.ZIP_STORED if f.suffix.lower() in (".jpg", ".png", ".pdf", ".zip", ".mp4") else zipfile.ZIP_DEFLATED)
            z.writestr("BACKUP-INFO.txt", f"CertVault backup {datetime.now():%d/%m/%Y %H:%M}\nRestore: Settings → Backup → Restore.\n")
    finally:
        dbcopy.unlink(missing_ok=True)
    return out


def stage_restore(zip_path: Path) -> None:
    """Validate a backup ZIP and unpack it to /data/restore-pending. Raises ValueError if it isn't one."""
    stage = config.DATA_DIR / RESTORE_DIR_NAME
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir()
    try:
        with zipfile.ZipFile(zip_path) as z:
            names = z.namelist()
            if "certvault.db" not in names:
                raise ValueError("That isn't a CertVault backup (no certvault.db inside)")
            for n in names:
                p = Path(n)
                if p.is_absolute() or ".." in p.parts or not (n == "certvault.db" or n.startswith(("files/", "thumbs/")) or n == "BACKUP-INFO.txt"):
                    raise ValueError(f"Unexpected file in backup: {n}")
            z.extractall(stage)
        con = sqlite3.connect(stage / "certvault.db")
        try:
            con.execute("SELECT COUNT(*) FROM documents").fetchone()
            con.execute("SELECT COUNT(*) FROM users").fetchone()
        finally:
            con.close()
    except Exception:
        shutil.rmtree(stage, ignore_errors=True)
        raise


def apply_pending_restore() -> bool:
    """Called at startup, before the database is opened."""
    stage = config.DATA_DIR / RESTORE_DIR_NAME
    if not (stage / "certvault.db").exists():
        return False
    keep = config.DATA_DIR / BACKUP_DIR_NAME / f"before-restore-{datetime.now():%Y-%m-%d-%H%M}"
    keep.mkdir(parents=True, exist_ok=True)
    if config.DB_PATH.exists():
        try:  # consistent copy including anything still in the WAL
            _db_copy(keep / "certvault.db")
        except Exception:
            shutil.copy2(config.DB_PATH, keep / "certvault.db")
            for side in ("-wal", "-shm"):
                if Path(str(config.DB_PATH) + side).exists():
                    shutil.copy2(str(config.DB_PATH) + side, keep / f"certvault.db{side}")
    for side in ("-wal", "-shm"):
        Path(str(config.DB_PATH) + side).unlink(missing_ok=True)
    shutil.move(str(stage / "certvault.db"), config.DB_PATH)
    for sub in ("files", "thumbs"):
        src = stage / sub
        if src.exists():
            for f in src.rglob("*"):
                if f.is_file():
                    dest = config.DATA_DIR / sub / f.relative_to(src)
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(f), dest)
    shutil.rmtree(stage, ignore_errors=True)
    log.warning("Backup restored (previous database kept in %s)", keep)
    return True


def restart_soon(delay: float = 1.5) -> None:
    """Exit so Docker/TrueNAS restarts the app (restart: unless-stopped) and the restore is applied."""
    threading.Timer(delay, lambda: os._exit(3)).start()  # non-zero: restarts under any restart policy
