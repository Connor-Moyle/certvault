"""File intake: accept ANY file, never skip.

Every upload is streamed to disk (so 500 MB PDFs don't eat the NAS's RAM), then turned into one or
more stored files:
  * PDF / JPG / PNG / WEBP / GIF ......... stored (photos re-encoded to drop GPS/EXIF)
  * HEIC / BMP / TIFF .................... converted so browsers can show them (multi-page TIFF -> PDF)
  * XLSX / XLS / CSV / DOCX / ODT / TXT / EML / RTF ... stored, text extracted for reading
  * ZIP ................................... unpacked, every file inside imported (zip-bomb guarded)
  * anything else (video, CAD, …) ......... stored as-is as an "Other" document you can fill in
"""
import hashlib
import io
import logging
import re
import shutil
import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageOps

from . import config

log = logging.getLogger("certvault.files")

VIEWABLE = {"pdf", "jpg", "png", "webp", "gif"}             # browsers show these inline
IMAGE_EXTS = {"jpg", "png", "webp", "gif"}
JUNK_NAMES = {".ds_store", "thumbs.db", "desktop.ini", "__macosx", ".localized", "icon\r"}

MIME = {
    "pdf": "application/pdf", "jpg": "image/jpeg", "png": "image/png", "webp": "image/webp", "gif": "image/gif",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
    "xls": "application/vnd.ms-excel", "csv": "text/csv", "txt": "text/plain", "md": "text/plain", "json": "application/json",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "doc": "application/msword",
    "odt": "application/vnd.oasis.opendocument.text", "ods": "application/vnd.oasis.opendocument.spreadsheet",
    "rtf": "application/rtf", "eml": "message/rfc822", "msg": "application/vnd.ms-outlook",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "mp4": "video/mp4", "mov": "video/quicktime", "m4a": "audio/mp4", "mp3": "audio/mpeg", "zip": "application/zip",
}
MAX_ZIP_FILES = 2000
MAX_ZIP_TOTAL = 8 * 1024 ** 3     # 8 GB uncompressed cap
MAX_ZIP_RATIO = 200               # compression-ratio guard against zip bombs


@dataclass
class Stored:
    path: Path        # file in DATA_DIR/tmp, ready to be moved into place
    ext: str
    mime: str
    name: str         # original (display) name
    sha256: str
    size: int


def tmp_dir() -> Path:
    d = config.DATA_DIR / "tmp"
    d.mkdir(parents=True, exist_ok=True)
    return d


def clean_name(name: str) -> str:
    name = (name or "upload").replace("\\", "/").split("/")[-1]
    return re.sub(r"[\x00-\x1f]", "", name)[:200] or "upload"


def ext_of(name: str) -> str:
    e = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    e = re.sub(r"[^a-z0-9]", "", e)[:8]
    return {"jpeg": "jpg", "jpe": "jpg", "tif": "tiff", "htm": "html", "heif": "heic"}.get(e, e) or "bin"


def is_junk(name: str) -> bool:
    n = clean_name(name).lower()
    return n in JUNK_NAMES or n.startswith("._") or n.startswith("~$")


def _hash_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _new_tmp(ext: str) -> Path:
    return tmp_dir() / f"{uuid.uuid4().hex}.{ext}"


def _sniff(head: bytes, ext: str) -> str:
    """Trust magic bytes over the file name where we can."""
    if head.startswith(b"%PDF-"):
        return "pdf"
    if head.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if head[:2] == b"BM":
        return "bmp"
    if head[:4] in (b"II*\x00", b"MM\x00*"):
        return "tiff"
    if head[4:8] == b"ftyp" and head[8:12] in (b"heic", b"heix", b"mif1", b"msf1", b"heim", b"heis", b"hevc", b"avif"):
        return "heic"
    if head.startswith(b"PK\x03\x04") and ext not in ("xlsx", "xlsm", "docx", "odt", "ods", "pptx"):
        return "zip"
    if head.startswith(b"\xd0\xcf\x11\xe0") and ext not in ("xls", "doc", "msg", "ppt"):
        return ext if ext in ("xls", "doc", "msg") else "doc"
    return ext


def _finish(p: Path, ext: str, name: str) -> Stored:
    return Stored(p, ext, MIME.get(ext, "application/octet-stream"), name, _hash_file(p), p.stat().st_size)


def _image_to(src: Path, name: str, keep_png: bool) -> Stored:
    """Re-encode a photo: fixes rotation, strips GPS/EXIF, converts HEIC/BMP to something browsers show."""
    with Image.open(src) as im:
        im = ImageOps.exif_transpose(im)
        if keep_png and im.mode in ("RGBA", "LA", "P", "L", "1"):
            out = _new_tmp("png")
            im.save(out, "PNG", optimize=True)
            return _finish(out, "png", name)
        out = _new_tmp("jpg")
        im.convert("RGB").save(out, "JPEG", quality=92)
        return _finish(out, "jpg", name)


def _tiff_to_pdf(src: Path, name: str) -> Stored:
    """Scanners love multi-page TIFF; browsers can't show it. Keep every page as one PDF.
    Pages are converted one at a time so a huge scan can't exhaust memory."""
    import subprocess
    work = tmp_dir() / f"tiff-{uuid.uuid4().hex}"
    work.mkdir()
    try:
        parts = []
        with Image.open(src) as im:
            i = 0
            while i < 500:
                try:
                    im.seek(i)
                except EOFError:
                    break
                page = im.convert("RGB")
                if max(page.size) > 6000:
                    page.thumbnail((6000, 6000))
                p = work / f"{i:04d}.pdf"
                page.save(p, "PDF", resolution=200)
                page.close()
                parts.append(p)
                i += 1
        out = _new_tmp("pdf")
        if len(parts) == 1:
            shutil.move(str(parts[0]), out)
        else:
            subprocess.run(["pdfunite", *map(str, parts), str(out)], check=True, capture_output=True, timeout=600)
        return _finish(out, "pdf", name)
    finally:
        shutil.rmtree(work, ignore_errors=True)


class _Budget:
    """Shared across nested ZIPs: total bytes that may be unpacked from one upload."""
    def __init__(self, total: int = MAX_ZIP_TOTAL, files: int = MAX_ZIP_FILES):
        self.bytes, self.files = total, files


def _unzip(src: Path, name: str, depth: int, budget: "_Budget") -> list[Stored]:
    out: list[Stored] = []
    with zipfile.ZipFile(src) as z:
        infos = [i for i in z.infolist() if not i.is_dir()]
        for info in infos:
            inner = info.filename.split("/")
            if any(is_junk(part) for part in inner):
                continue
            budget.files -= 1
            if budget.files < 0:
                raise ValueError(f"ZIP has more than {MAX_ZIP_FILES} files")
            if info.file_size > 1024 ** 2 and info.compress_size and info.file_size / info.compress_size > MAX_ZIP_RATIO:
                raise ValueError(f"{info.filename} looks like a zip bomb — refused")
            if info.file_size > budget.bytes:
                raise ValueError("ZIP unpacks to more than 8 GB in total")
            member = clean_name(inner[-1])
            dest = _new_tmp(ext_of(member))
            written = 0
            with z.open(info) as fsrc, open(dest, "wb") as fdst:
                while chunk := fsrc.read(1024 * 1024):
                    written += len(chunk)
                    if written > budget.bytes:  # sizes in the header can lie
                        fdst.close()
                        dest.unlink(missing_ok=True)
                        raise ValueError("ZIP unpacks to more than 8 GB in total")
                    fdst.write(chunk)
            budget.bytes -= written
            try:
                out += prepare(dest, member, depth + 1, budget)
            finally:
                dest.unlink(missing_ok=True)
    return out


def prepare(src: Path, filename: str, depth: int = 0, budget: "_Budget | None" = None) -> list[Stored]:
    """Turn one uploaded file into stored file(s). Never drops a file: if conversion fails,
    the original is kept as-is."""
    name = clean_name(filename)
    ext = ext_of(name)
    with open(src, "rb") as f:
        head = f.read(16)
    kind = _sniff(head, ext)
    try:
        if kind == "zip" and depth < 3:
            return _unzip(src, name, depth, budget or _Budget())
        if kind in ("jpg", "webp"):
            return [_image_to(src, name, keep_png=False)]
        if kind == "png":
            return [_image_to(src, name, keep_png=True)]
        if kind in ("heic", "bmp"):
            return [_image_to(src, name, keep_png=kind == "bmp")]
        if kind == "tiff":
            return [_tiff_to_pdf(src, name)]
    except ValueError:
        raise
    except Exception as e:  # damaged/odd image: keep the original rather than skip it
        log.warning("Conversion failed for %s (%s) — storing original", name, e)
    dest = _new_tmp(kind or "bin")
    shutil.copyfile(src, dest)
    return [_finish(dest, kind or "bin", name)]


def kind_label(ext: str) -> str:
    return {"pdf": "PDF", "jpg": "Photo", "png": "Image", "webp": "Image", "gif": "Image", "xlsx": "Excel", "xlsm": "Excel",
            "xls": "Excel", "csv": "CSV", "docx": "Word", "doc": "Word", "odt": "Document", "txt": "Text", "eml": "Email",
            "msg": "Outlook email", "mp4": "Video", "mov": "Video"}.get(ext, ext.upper())


# ---- text from non-image documents ------------------------------------------------------

def _xml_text(data: bytes) -> str:
    s = data.decode("utf-8", "ignore")
    s = re.sub(r"</w:p>|</text:p>|<w:br/>|</a:p>", "\n", s)
    s = re.sub(r"<w:tab/>", "\t", s)
    s = re.sub(r"<[^>]+>", "", s)
    import html
    return html.unescape(s)


def document_text(path: Path, ext: str, max_chars: int = 40000) -> str:
    try:
        if ext in ("docx", "odt", "pptx"):
            with zipfile.ZipFile(path) as z:
                names = {"docx": ["word/document.xml"], "odt": ["content.xml"]}.get(ext) or \
                    sorted(n for n in z.namelist() if n.startswith("ppt/slides/slide"))
                return "\n".join(_xml_text(z.read(n)) for n in names if n in z.namelist())[:max_chars]
        if ext == "xls":
            import xlrd
            from datetime import datetime
            wb = xlrd.open_workbook(str(path))
            lines = []
            for sh in wb.sheets():
                lines.append(f"## Sheet: {sh.name}")
                for r in range(sh.nrows):
                    cells = []
                    for c in sh.row(r):
                        if c.ctype == xlrd.XL_CELL_DATE:
                            cells.append(datetime(*xlrd.xldate_as_tuple(c.value, wb.datemode)).strftime("%d/%m/%Y"))
                        else:
                            v = str(c.value).strip()
                            cells.append(v[:-2] if v.endswith(".0") else v)
                    if any(cells):
                        lines.append(" | ".join(cells))
            return "\n".join(lines)[:max_chars]
        if ext == "eml":
            from email import policy
            from email.parser import BytesParser
            msg = BytesParser(policy=policy.default).parse(open(path, "rb"))
            body = msg.get_body(preferencelist=("plain", "html"))
            text = body.get_content() if body else ""
            if body and body.get_content_type() == "text/html":
                text = re.sub(r"<[^>]+>", " ", text)
            return f"From: {msg['from']}\nSubject: {msg['subject']}\nDate: {msg['date']}\n\n{text}"[:max_chars]
        if ext == "rtf":
            raw = path.read_bytes()[:2_000_000].decode("latin-1", "ignore")
            raw = re.sub(r"\\par[d]?", "\n", raw)
            return re.sub(r"\\[a-z]+-?\d* ?|[{}]", "", raw)[:max_chars]
        if ext in ("txt", "md", "json", "log", "html", "xml"):
            raw = path.read_bytes()[:2_000_000]
            txt = raw.decode("utf-8", "ignore")
            if ext in ("html", "xml"):
                txt = re.sub(r"<[^>]+>", " ", txt)
            return txt[:max_chars]
    except Exception as e:
        log.info("No text from %s: %s", path.name, e)
    return ""


def shrink_for_email(path: Path, ext: str, max_side: int = 2200) -> bytes | None:
    """Smaller copy of a photo for email attachments; None if not an image."""
    if ext not in IMAGE_EXTS:
        return None
    try:
        with Image.open(path) as im:
            im = im.convert("RGB")
            im.thumbnail((max_side, max_side))
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=85)
            return buf.getvalue()
    except Exception:
        return None
