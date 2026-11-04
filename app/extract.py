"""File handling + OCR + rule-based field extraction (the non-AI fallback)."""
import io
import logging
import re
import subprocess
import tempfile
from calendar import monthrange
from datetime import date, timedelta
from pathlib import Path

from PIL import Image, ImageOps

from .categories import CATEGORIES, CATEGORY_BY_ID, DL_CLASSES, HRWL_CLASSES, ISSUERS, UNIT_TITLES, is_register

log = logging.getLogger("certvault.extract")

try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
    HEIF_OK = True
except Exception:  # pragma: no cover
    HEIF_OK = False

Image.MAX_IMAGE_PIXELS = 250_000_000  # big panoramas/scans OK; still guards against decompression bombs


# ---- file type detection ----------------------------------------------------

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
TEXT_KINDS = ("xlsx", "csv")  # kept for compatibility
SHEETS = ("xlsx", "xlsm", "csv")


def is_visual(ext: str | None) -> bool:
    """Files we can render to images for OCR / AI vision / thumbnails."""
    return ext in ("pdf", "jpg", "png", "webp", "gif")


def sniff(head: bytes, data: bytes = b"", filename: str = "") -> tuple[str, str] | None:
    """Return (ext, mime) from magic bytes, or None if not an allowed type."""
    name = (filename or "").lower()
    if head.startswith(b"PK\x03\x04") and name.endswith((".xlsx", ".xlsm")):
        import zipfile
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                if "xl/workbook.xml" in z.namelist():
                    return "xlsx", XLSX_MIME
        except zipfile.BadZipFile:
            return None
        return None
    if name.endswith(".csv") and data and b"\x00" not in data[:65536]:
        try:
            data[:65536].decode("utf-8-sig")
        except UnicodeDecodeError:
            try:
                data[:65536].decode("cp1252")
            except UnicodeDecodeError:
                return None
        return "csv", "text/csv"
    if head.startswith(b"%PDF-"):
        return "pdf", "application/pdf"
    if head.startswith(b"\xff\xd8\xff"):
        return "jpg", "image/jpeg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png", "image/png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp", "image/webp"
    if head[4:8] == b"ftyp" and head[8:12] in (b"heic", b"heix", b"mif1", b"msf1", b"heim", b"heis", b"hevc"):
        return "heic", "image/heic"
    return None


def normalise_upload(data: bytes, ext: str) -> tuple[bytes, str, str]:
    """Convert HEIC to JPEG (browsers can't show HEIC) and strip EXIF/GPS from images."""
    if ext == "pdf":
        return data, "pdf", "application/pdf"
    if ext == "xlsx":
        return data, "xlsx", XLSX_MIME
    if ext == "csv":
        return data, "csv", "text/csv"
    img = Image.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img)
    if ext in ("heic", "webp") or img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
        out = io.BytesIO()
        img.save(out, "JPEG", quality=92)
        return out.getvalue(), "jpg", "image/jpeg"
    # re-encode to drop metadata (GPS etc.)
    out = io.BytesIO()
    if ext == "png":
        img.save(out, "PNG", optimize=True)
        return out.getvalue(), "png", "image/png"
    img.save(out, "JPEG", quality=92)
    return out.getvalue(), "jpg", "image/jpeg"


# ---- rendering / OCR ----------------------------------------------------------

def pdf_pages_to_images(path: Path, dpi: int = 200, max_pages: int = 3) -> list[Image.Image]:
    with tempfile.TemporaryDirectory() as td:
        subprocess.run(
            ["pdftoppm", "-r", str(dpi), "-f", "1", "-l", str(max_pages), "-png", str(path), f"{td}/p"],
            check=True, capture_output=True, timeout=120,
        )
        imgs = []
        for p in sorted(Path(td).glob("p*.png")):
            im = Image.open(p)
            im.load()
            imgs.append(im)
        return imgs


def pdf_text(path: Path) -> str:
    try:
        r = subprocess.run(["pdftotext", "-layout", "-l", "5", str(path), "-"],
                           capture_output=True, timeout=60, text=True)
        return r.stdout
    except Exception as e:
        log.info("pdftotext failed: %s", e)
        return ""


def spreadsheet_text(path: Path, ext: str, max_chars: int = 40000) -> str:
    """Flatten a register spreadsheet to text: one line per row, cells separated by ' | '."""
    from datetime import datetime as _dt, date as _d
    lines = []
    if ext == "csv":
        import csv
        raw = path.read_bytes()
        try:
            txt = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            txt = raw.decode("cp1252", "replace")
        for row in csv.reader(io.StringIO(txt)):
            if any(c.strip() for c in row):
                lines.append(" | ".join(c.strip() for c in row))
            if sum(map(len, lines)) > max_chars:
                break
        return "\n".join(lines)[:max_chars]
    from openpyxl import load_workbook
    wb = load_workbook(path, read_only=True, data_only=True)
    try:
        for ws in wb.worksheets:
            lines.append(f"## Sheet: {ws.title}")
            for row in ws.iter_rows(values_only=True):
                cells = []
                for v in row:
                    if v is None:
                        cells.append("")
                    elif isinstance(v, (_dt, _d)):
                        cells.append(v.strftime("%d/%m/%Y"))
                    else:
                        cells.append(str(v).strip())
                while cells and not cells[-1]:
                    cells.pop()
                if any(cells):
                    lines.append(" | ".join(cells))
                if sum(map(len, lines)) > max_chars:
                    break
    finally:
        wb.close()
    return "\n".join(lines)[:max_chars]


def page_images(path: Path, ext: str) -> list[Image.Image]:
    if not is_visual(ext):
        return []
    if ext == "pdf":
        return pdf_pages_to_images(path)
    im = Image.open(path)
    im = ImageOps.exif_transpose(im)
    return [im.convert("RGB")]


def _otsu(a) -> float:
    import numpy as np
    hist = np.bincount(a.ravel(), minlength=256).astype(float)
    total = a.size
    sum_all = np.dot(np.arange(256), hist)
    w_b = sum_b = 0.0
    best, thr = 0.0, 127
    for t in range(256):
        w_b += hist[t]
        if w_b == 0 or w_b == total:
            continue
        sum_b += t * hist[t]
        m_b, m_f = sum_b / w_b, (sum_all - sum_b) / (total - w_b)
        between = w_b * (total - w_b) * (m_b - m_f) ** 2
        if between > best:
            best, thr = between, t
    return thr


def _deskew(g: Image.Image) -> Image.Image:
    """Straighten a slightly tilted photo (±15°) using the row-projection method."""
    import numpy as np
    small = g.copy()
    small.thumbnail((900, 900))
    # use local-threshold "ink" (text strokes) so dark backgrounds / tables / shadows don't dominate
    ink = 255 - np.asarray(_adaptive(small), dtype=np.uint8)
    ink_img = Image.fromarray(ink)

    def score(angle):
        r = np.asarray(ink_img.rotate(angle, resample=Image.BILINEAR, fillcolor=0), dtype=np.float32)
        return float(np.var(r.sum(axis=1)))

    best = max(range(-15, 16, 1), key=score)
    fine = max([best + d / 4 for d in range(-4, 5)], key=score)
    if abs(fine) < 0.3:
        return g
    return g.rotate(fine, resample=Image.BICUBIC, expand=True, fillcolor=255)


def _adaptive(g: Image.Image) -> Image.Image:
    """Local threshold — removes shadows / uneven lighting and coloured card backgrounds."""
    import numpy as np
    from PIL import ImageFilter
    a = np.asarray(g, dtype=np.int16)
    bg = np.asarray(g.filter(ImageFilter.BoxBlur(max(15, g.width // 60))), dtype=np.int16)
    out = np.where(a < bg - 12, 0, 255).astype(np.uint8)
    return Image.fromarray(out).filter(ImageFilter.MedianFilter(3))


def _stretch(g: Image.Image) -> Image.Image:
    """Contrast stretch that can't blank out sparse pages (one line of text on white)."""
    import numpy as np
    a = np.asarray(g)
    lo, hi = np.percentile(a, 0.5), np.percentile(a, 99.5)
    if hi - lo < 40:  # mostly one colour: plain min/max stretch instead
        lo, hi = a.min(), a.max()
    if hi <= lo:
        return g
    out = np.clip((a.astype(np.float32) - lo) * (255.0 / (hi - lo)), 0, 255).astype(np.uint8)
    return Image.fromarray(out)


def _ocr_best(variants) -> tuple[str, float, float]:
    """Run Tesseract over several preprocessed images / layouts and keep the most confident result,
    dropping low-confidence junk words and garbage lines."""
    import pytesseract
    best_text, best_score, best_mean = "", -1.0, 0.0
    for img in variants:
        for psm in (3, 6, 4):
            try:
                data = pytesseract.image_to_data(img, lang="eng", config=f"--psm {psm} --oem 1",
                                                 output_type=pytesseract.Output.DICT)
            except Exception:
                continue
            lines: dict = {}
            good = []
            total = sum(1 for w in data["text"] if w.strip())
            for i, word in enumerate(data["text"]):
                word = word.strip()
                try:
                    conf = float(data["conf"][i])
                except (TypeError, ValueError):
                    conf = -1
                if not word or conf < 0:
                    continue
                if conf >= 50 or (conf >= 25 and (re.fullmatch(r"[\d/.\-:]{4,}", word)
                                                  or re.fullmatch(r"[A-Z]{3,}[A-Z0-9]*\d{2,}[A-Z]?", word))):
                    key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
                    lines.setdefault(key, []).append(word)
                    good.append(conf)
            if not good:
                continue
            ratio = len(good) / max(total, 1)
            score = sum(good) * ratio * ratio  # confident AND mostly-readable beats lots of junk
            if score > best_score:
                out = []
                for key in sorted(lines):
                    ln = " ".join(lines[key])
                    alnum = sum(ch.isalnum() for ch in ln)
                    if len(ln) >= 2 and alnum / max(len(ln), 1) >= 0.55:
                        out.append(ln)
                best_text, best_score, best_mean = "\n".join(out), score, ratio
    return best_text, best_score, best_mean


def ocr_image(img: Image.Image) -> str:
    import pytesseract
    g = ImageOps.grayscale(img)
    # tesseract likes ~30px text; most phone photos of cards need upscaling
    target = 2400
    if max(g.size) < target:
        s = target / max(g.size)
        g = g.resize((int(g.width * s), int(g.height * s)), Image.LANCZOS)
    elif max(g.size) > 3600:
        g.thumbnail((3600, 3600), Image.LANCZOS)
    candidates = [g]
    try:
        osd = pytesseract.image_to_osd(g, output_type=pytesseract.Output.DICT)
        rot = int(osd.get("rotate", 0))
        if rot:  # OSD is unreliable on sparse cards — try both and let the confidence score decide
            candidates.append(g.rotate(-rot, expand=True))
    except Exception:
        pass
    def prep(cands):
        out = []
        for c in cands:
            try:
                c = _deskew(c)
            except Exception as e:
                log.info("deskew skipped: %s", e)
            out.append(_stretch(c))
            try:
                out.append(_adaptive(c))
            except Exception as e:
                log.info("adaptive threshold skipped: %s", e)
        return out

    text, score, mean = _ocr_best(prep(candidates))
    if mean < 0.75 or len(text) < 15:  # poor read (lots of unreadable words): maybe upside down / sideways
        for angle in (180, 90, 270):
            t2, s2, m2 = _ocr_best(prep([g.rotate(angle, expand=True)]))
            if s2 > score * 1.3:
                text, score, mean = t2, s2, m2
                if m2 >= 0.8:
                    break
    return text


def get_text(path: Path, ext: str) -> str:
    if ext in SHEETS:
        return spreadsheet_text(path, ext)
    if not is_visual(ext):
        from .files import document_text
        return document_text(path, ext)
    text = pdf_text(path) if ext == "pdf" else ""
    if len(text.strip()) < 40:  # scanned PDF or image -> OCR
        parts = []
        for im in page_images(path, ext):
            try:
                parts.append(ocr_image(im))
            except Exception as e:
                log.warning("OCR failed: %s", e)
        text = "\n".join(parts)
    return text


def make_thumbnail(path: Path, ext: str, out: Path) -> bool:
    if not is_visual(ext):
        return False
    try:
        if ext == "pdf":
            ims = pdf_pages_to_images(path, dpi=90, max_pages=1)
            if not ims:
                return False
            im = ims[0]
        else:
            im = ImageOps.exif_transpose(Image.open(path))
        im = im.convert("RGB")
        im.thumbnail((720, 720))
        im.save(out, "JPEG", quality=82)
        return True
    except Exception as e:
        log.warning("Thumbnail failed: %s", e)
        return False


# ---- date parsing -------------------------------------------------------------

MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}
MON_RE = r"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"

DATE_PATTERNS = [
    # 2026-03-14
    (re.compile(r"\b(20\d{2}|19\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b"), "ymd"),
    # 14/03/2026, 14-03-26, 14.03.2026
    (re.compile(r"\b(\d{1,2})\s?[-/.]\s?(\d{1,2})\s?[-/.]\s?(\d{4}|\d{2})\b"), "dmy"),
    # 14 March 2026, 14th of Mar 2026, 14MAR2026
    (re.compile(r"\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:of\s+)?" + MON_RE + r"\.?,?\s*(\d{4}|\d{2})\b", re.I), "dMy"),
    # March 14, 2026
    (re.compile(r"\b" + MON_RE + r"\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b", re.I), "Mdy"),
    # March 2026 (no day)
    (re.compile(r"\b" + MON_RE + r"\.?\s+(\d{4})\b", re.I), "My"),
]

EXPIRY_WORDS = re.compile(
    r"(expir|exp\b|exp\.|valid\s*(until|to|thru|through)|renew|due\s*date|refresher\s*due|re-?cert|"
    r"next\s*due|until|end\s*date|next\s*(insp|test|service|tag|check)|due\b)", re.I)
ISSUE_WORDS = re.compile(
    r"(issue|issued|complet|awarded|attain|achieved|conferred|assess|course\s*date|training\s*date|"
    r"date\s*of\s*(issue|completion|training|assessment)|start\s*date|valid\s*from|inducted|dated|last\s*(insp|test|service|check)|inspected|tested)", re.I)
DOB_WORDS = re.compile(r"(birth|\bdob\b|d\.o\.b|born)", re.I)


def _year(y: str) -> int:
    y = int(y)
    return y + 2000 if y < 70 else (y + 1900 if y < 100 else y)


def _mk(y, m, d) -> date | None:
    try:
        dt = date(y, m, d)
    except ValueError:
        return None
    if not (1950 <= dt.year <= 2100):
        return None
    return dt


def find_dates(text: str) -> list[dict]:
    found = []
    taken: list[tuple[int, int]] = []
    for rx, kind in DATE_PATTERNS:
        for m in rx.finditer(text):
            s, e = m.span()
            if any(s < te and e > ts for ts, te in taken):
                continue
            g = m.groups()
            dt = None
            if kind == "ymd":
                dt = _mk(int(g[0]), int(g[1]), int(g[2]))
            elif kind == "dmy":
                d, mo, y = int(g[0]), int(g[1]), _year(g[2])
                if mo > 12 and d <= 12:  # looks US-formatted
                    d, mo = mo, d
                dt = _mk(y, mo, d)
            elif kind == "dMy":
                dt = _mk(_year(g[2]), MONTHS[g[1][:3].lower()], int(g[0]))
            elif kind == "Mdy":
                dt = _mk(int(g[2]), MONTHS[g[0][:3].lower()], int(g[1]))
            elif kind == "My":
                y, mo = int(g[1]), MONTHS[g[0][:3].lower()]
                dt = _mk(y, mo, 1)
            if not dt:
                continue
            taken.append((s, e))
            line_start = text.rfind("\n", 0, s)
            prev_line_start = text.rfind("\n", 0, max(line_start, 0))
            ctx = text[max(prev_line_start, 0, s - 120):s]
            same_line = text[max(line_start, 0, s - 60):s]
            found.append({
                "date": dt, "pos": s, "kind": kind,
                "ctx": ctx, "line": same_line,
                "end_of_month": kind == "My",
            })
    found.sort(key=lambda f: f["pos"])
    # "near" = text between the previous date on this line (if any) and this date
    prev_end = 0
    for f in found:
        s = f["pos"]
        line_start = text.rfind("\n", 0, s) + 1
        f["near"] = text[max(line_start, prev_end, s - 50):s]
        f["after_date_same_line"] = prev_end > line_start
        f["end"] = s + 1
        m = None
        for rx, _ in DATE_PATTERNS:
            m = rx.match(text, s)
            if m:
                break
        prev_end = m.end() if m else s
    return found


def classify_dates(text: str, today: date | None = None) -> dict:
    today = today or date.today()
    dates = find_dates(text)
    expiry = issue = None
    others = []
    for f in dates:
        line = f["line"]
        ctx = f["ctx"]
        near = f["near"]
        if DOB_WORDS.search(near) or (not near.strip() and DOB_WORDS.search(ctx[-40:])):
            continue
        if f["after_date_same_line"] and re.fullmatch(r"\s*(to|-|–|until|till)\s*", near, re.I):
            expiry = expiry or f["date"]  # "valid from X to Y"
        elif EXPIRY_WORDS.search(near):
            dt = f["date"]
            if f["end_of_month"]:
                dt = date(dt.year, dt.month, monthrange(dt.year, dt.month)[1])
            expiry = expiry or dt
        elif ISSUE_WORDS.search(near):
            issue = issue or f["date"]
        elif EXPIRY_WORDS.search(line) and not ISSUE_WORDS.search(line[-25:]):
            dt = f["date"]
            if f["end_of_month"]:
                dt = date(dt.year, dt.month, monthrange(dt.year, dt.month)[1])
            expiry = expiry or dt
        elif ISSUE_WORDS.search(line):
            issue = issue or f["date"]
        elif EXPIRY_WORDS.search(ctx):
            expiry = expiry or f["date"]
        elif ISSUE_WORDS.search(ctx):
            issue = issue or f["date"]
        else:
            others.append(f["date"])
    if not issue:
        past = [d for d in others if d <= today]
        if past:
            issue = max(past)  # most recent past date is usually completion
    if not expiry:
        fut = [d for d in others if (not issue or d > issue) and d > (issue or today)]
        if fut:
            expiry = max(fut)
    # "valid for 3 years"
    m = re.search(r"valid\s+for\s+(\d{1,2})\s*(year|yr|month)", text, re.I)
    validity = None
    if m:
        n = int(m.group(1))
        validity = n if m.group(2).lower().startswith("y") else n / 12
    return {"completion_date": issue, "expiry_date": expiry, "validity_years": validity}


def add_months(d: date, months: int) -> date:
    m = d.month - 1 + months
    y, m = d.year + m // 12, m % 12 + 1
    return date(y, m, min(d.day, monthrange(y, m)[1]))


def add_years(d: date, years: float) -> date:
    if years != int(years):
        return d + timedelta(days=round(365.25 * years))
    try:
        return d.replace(year=d.year + int(years))
    except ValueError:  # 29 Feb
        return d.replace(year=d.year + int(years), day=28)


# ---- field extraction -----------------------------------------------------------

def _code_rx(code: str) -> re.Pattern:
    # OCR often reads 0 as O and 1 as I/l
    body = "".join("[0O]" if ch == "0" else "[1IL]" if ch == "1" else re.escape(ch) for ch in code)
    return re.compile(r"\b" + body + r"\b")


_CODE_RX = {code: _code_rx(code) for c in CATEGORIES for code in c["codes"]}
_CODE_RX.update({code: _code_rx(code) for code in UNIT_TITLES})
WEAK_CATEGORIES = {"training", "site_induction", "other_register", "ins_other", "asset_receipt", "membership"}  # generic words, only win if nothing specific matches


def has_code(upper: str, code: str) -> bool:
    return bool(_CODE_RX[code].search(upper))


def detect_category(text: str) -> str:
    low = " " + re.sub(r"\s+", " ", re.sub(r"[^\w'&/\-]+", " ", text.lower().replace("’", "'"))) + " "
    upper = text.upper()
    best, best_score = "other", 0
    for c in CATEGORIES:
        score = 0
        for code in c["codes"]:
            if has_code(upper, code):
                score += 10
        for kw in c["keywords"]:
            if kw in low:
                score += (3 if len(kw) > 6 else 1) * (0.3 if c["id"] in WEAK_CATEGORIES else 1)
        if score > best_score:
            best, best_score = c["id"], score
    return best


def detect_issuer(text: str) -> tuple[str | None, str | None]:
    low = text.lower()
    for needle, name, typ in ISSUERS:
        if re.search(r"\b" + re.escape(needle) + r"\b", low):
            return name, typ
    # RTO / company line fallback
    for line in text.splitlines():
        ln = line.strip()
        if 4 < len(ln) < 80 and re.search(r"\b(pty\.?\s*ltd|training|academy|institute|college|rto)\b", ln, re.I):
            if not re.search(r"(certif|attain|statement|nationally)", ln, re.I):
                return re.sub(r"\s{2,}", " ", ln), "training"
    return None, None


def detect_rto(text: str) -> str | None:
    m = re.search(r"\bRTO\s*(?:No\.?|Number|Code|ID|#)?\s*[:\-]?\s*(\d{4,6})\b", text, re.I)
    return m.group(1) if m else None


NAME_PATTERNS = [
    r"(?i:this\s+is\s+to\s+certify\s+that|certifies\s+that|awarded\s+to|presented\s+to|issued\s+to|"
    r"has\s+been\s+awarded\s+to)[ \t]*[:\-]?\s*([A-Z][A-Za-z'\-]+(?:[ \t]+[A-Z][A-Za-z'\-]+){1,3})",
    r"\b(?i:(?:full[ \t]+)?name)[ \t]*[:\-][ \t]*([A-Z][A-Za-z'\-]+(?:[ \t]+[A-Z][A-Za-z'\-]+){1,3})",
]


def detect_holder(text: str) -> str | None:
    for p in NAME_PATTERNS:
        m = re.search(p, text)
        if m:
            name = m.group(1).strip()
            if not re.search(r"(certif|complet|attain|unit|course)", name, re.I):
                return name.title() if name.isupper() else name
    return None


def detect_number(text: str) -> str | None:
    rx = re.compile(
        r"\b(?:licen[cs]e|certificate|card|cert|soa|statement|registration|reg|member|student|ref|policy|plate|serial|"
        r"vin|invoice|receipt|passport|document|account|abn)\b[ \t]*"
        r"(?:no\.?|number|#|id)?[ \t]*[:\-]?[ \t]*([A-Z0-9][A-Z0-9\-/]{3,20})", re.I)
    for m in rx.finditer(text):
        if re.search(r"\d", m.group(1)):
            return m.group(1).upper()
    return None


def detect_cost(text: str) -> str | None:
    m = re.search(r"(?:premium|total|amount paid|amount due|price|fee paid|cost|licence fee)\s*(?:\(inc\.? ?gst\))?\s*[:\-]?\s*"
                  r"(\$\s?\d[\d,]*(?:\.\d{2})?)", text, re.I)
    return m.group(1).replace(" ", "") if m else None


def detect_location(text: str) -> str | None:
    m = re.search(r"(?:venue|location|training\s+location|site)[ \t]*[:\-][ \t]*(.+)", text, re.I) or \
        re.search(r"(?:completed|delivered|held|conducted|trained)[ \t]+at[ \t]*[:\-]?[ \t]*(.+)", text, re.I)
    if m:
        return m.group(1).strip()[:120]
    m = re.search(r"([A-Z][A-Za-z ]{2,40}?)[,\s]+(WA|W\.A\.|Western Australia)[,\s]+(6\d{3})\b", text)
    if m:
        return f"{m.group(1).strip().title()} WA {m.group(3)}"
    return None


def detect_title(text: str, cat_id: str) -> str:
    upper = text.upper()
    for code, title in UNIT_TITLES.items():
        if has_code(upper, code):
            return f"{code} {title}"
    m = re.search(r"\b([A-Z]{3,6}[A-Z0-9]{2,4}\d{3}[A-Z]?)\b", upper)  # generic unit code
    if is_register(cat_id):
        return CATEGORY_BY_ID[cat_id]["name"]
    if m and cat_id not in ("drivers_licence", "police_check", "wwc", "security_id", "hrwl"):
        return f"{CATEGORY_BY_ID[cat_id]['name']} ({m.group(1)})"
    return CATEGORY_BY_ID[cat_id]["name"]


def detect_classes(text: str, cat_id: str) -> str | None:
    """Licence classes spelled out, e.g. 'CV – Vehicle loading crane; DG – Dogging'."""
    upper = text.upper()
    found = []
    if cat_id == "hrwl":
        lines = upper.splitlines()
        cand = []
        for i, ln in enumerate(lines):
            if "CLASS" in ln:  # "Classes: CV DG RB" and the line(s) right after
                cand.append(re.split(r"CLASS(?:ES)?\b", ln, maxsplit=1)[-1])
                cand += lines[i + 1:i + 3]
        if not cand:  # fall back to lines that are mostly class codes
            for ln in lines:
                toks = re.findall(r"[A-Z0-9]+", ln)
                hits = [t for t in toks if t in HRWL_CLASSES]
                if len(hits) >= 1 and len(hits) >= 0.6 * len(toks):
                    cand.append(ln)
        for tok in re.findall(r"(?<![A-Z0-9])([A-Z][A-Z0-9])(?![A-Z0-9])", " ".join(cand)):
            if tok in HRWL_CLASSES:
                code = "C0" if tok == "CO" else tok
                found.append(f"{code} – {HRWL_CLASSES[code]}")
    elif cat_id == "drivers_licence":
        m = re.search(r"\bCLASS(?:ES)?\s*[:\-]?\s*([A-Z0-9 ,/\-]{1,30})", upper)
        if m:
            for tok in re.split(r"[ ,/]+", m.group(1).strip()):
                if tok in DL_CLASSES:
                    found.append(f"{tok} – {DL_CLASSES[tok]}")
    return "; ".join(dict.fromkeys(found)) or None


def rule_extract(text: str, today: date | None = None) -> dict:
    """Best-effort extraction without AI."""
    cat = detect_category(text)
    issuer, itype = detect_issuer(text)
    if cat == "drivers_licence" and not issuer and re.search(r"western australia", text, re.I):
        issuer, itype = "WA Department of Transport", "government"
    dates = classify_dates(text, today)
    if is_register(cat):
        # registers list many items: last inspection = latest past date, next due = earliest upcoming date
        today_ = today or date.today()
        all_dates = [f["date"] for f in find_dates(text) if not DOB_WORDS.search(f["near"])]
        past = [d for d in all_dates if d <= today_]
        future = [d for d in all_dates if today_ < d <= add_years(today_, 3)]
        dates["completion_date"] = max(past) if past else dates["completion_date"]
        dates["expiry_date"] = min(future) if future else dates["expiry_date"]
    expiry = dates["expiry_date"]
    estimated = False
    validity = dates["validity_years"] or CATEGORY_BY_ID[cat]["validity_years"]
    if not expiry and dates["completion_date"] and validity:
        expiry = add_years(dates["completion_date"], validity)
        estimated = True
    rto = detect_rto(text)
    notes = None
    return {
        "title": detect_title(text, cat),
        "category": cat,
        "issuer": issuer,
        "issuer_type": itype,
        "holder_name": detect_holder(text),
        "licence_number": detect_number(text),
        "completion_date": dates["completion_date"].isoformat() if dates["completion_date"] else None,
        "expiry_date": expiry.isoformat() if expiry else None,
        "expiry_estimated": estimated,
        "location": detect_location(text),
        "notes": notes,
        "classes": detect_classes(text, cat),
        "cost": detect_cost(text),
        "rto_code": rto,
    }
