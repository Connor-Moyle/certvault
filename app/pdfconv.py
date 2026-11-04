"""Everything becomes a PDF.

Every document gets ONE combined, searchable PDF (all sides/pages, in order) next to the original files:
  files/<doc id>.combined.pdf
  * photos / scans  -> Tesseract renders a PDF with an invisible text layer (searchable, copyable)
  * PDFs            -> kept; scanned PDFs without text get a text layer (up to 40 pages)
  * Word / Excel / PowerPoint / ODF / RTF / CSV / TXT / HTML / e-mail -> LibreOffice (headless)
  * anything else (video, CAD …) -> a placeholder page naming the attached file, so nothing is silently missing
The originals are always kept. Sharing, e-mail, ZIP packs and the NAS library default to the PDF.
"""
import html
import logging
import os
import shutil
import subprocess
import tempfile
import uuid
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageOps

from . import config

log = logging.getLogger("certvault.pdf")

OFFICE = {"docx", "doc", "odt", "rtf", "xlsx", "xlsm", "xls", "ods", "csv", "pptx", "ppt", "odp", "txt", "md",
          "html", "xml", "json"}
IMAGES = {"jpg", "png", "webp", "gif"}
MAX_OCR_PAGES = 40


def combined_path(doc_id: str) -> Path:
    return config.FILES_DIR / f"{doc_id}.combined.pdf"


def _work() -> Path:
    d = config.DATA_DIR / "tmp" / f"pdf-{uuid.uuid4().hex}"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _run(cmd: list[str], timeout: int = 180, env: dict | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, timeout=timeout, env=env)


def soffice_available() -> bool:
    return shutil.which("soffice") is not None


def _soffice(src: Path, outdir: Path) -> Path | None:
    if not soffice_available():
        return None
    profile = outdir / f"lo-{uuid.uuid4().hex[:8]}"  # own profile per call: parallel conversions can't clash
    profile.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "HOME": str(profile)}
    try:
        r = _run(["soffice", f"-env:UserInstallation=file://{profile}", "--headless", "--norestore",
                  "--convert-to", "pdf", "--outdir", str(outdir), str(src)], timeout=240, env=env)
    finally:
        shutil.rmtree(profile, ignore_errors=True)
    out = outdir / (src.stem + ".pdf")
    if r.returncode != 0 or not out.exists():
        log.warning("LibreOffice couldn't convert %s: %s", src.name, r.stderr[-300:])
        return None
    return out


def _text_pdf(title: str, body: str, outdir: Path) -> Path | None:
    """Render plain text (e-mail bodies, placeholders) to PDF via LibreOffice, or Pillow as a fallback."""
    page = (f"<html><head><meta charset='utf-8'><style>body{{font-family:DejaVu Sans,Arial;font-size:11pt}}"
            f"h1{{font-size:16pt}} pre{{white-space:pre-wrap;font-family:DejaVu Sans,Arial}}</style></head>"
            f"<body><h1>{html.escape(title)}</h1><pre>{html.escape(body)}</pre></body></html>")
    src = outdir / f"{uuid.uuid4().hex}.html"
    src.write_text(page, encoding="utf-8")
    out = _soffice(src, outdir)
    if out:
        return out
    # fallback: draw text on A4 pages with Pillow
    from PIL import ImageDraw, ImageFont
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 26)
        bold = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 34)
    except OSError:
        font = bold = ImageFont.load_default()
    lines = []
    for para in body.splitlines() or [""]:
        while len(para) > 90:
            cut = para.rfind(" ", 0, 90)
            cut = cut if cut > 20 else 90
            lines.append(para[:cut])
            para = para[cut:].lstrip()
        lines.append(para)
    pages, y, im = [], 0, None
    for i, ln in enumerate(lines):
        if im is None or y > 3300:
            im = Image.new("RGB", (2480, 3508), "white")
            d = ImageDraw.Draw(im)
            pages.append(im)
            y = 160
            if len(pages) == 1:
                d.text((160, y), title, font=bold, fill="black")
                y += 90
        d.text((160, y), ln, font=font, fill="black")
        y += 40
    out = outdir / f"{uuid.uuid4().hex}.pdf"
    pages[0].save(out, "PDF", save_all=True, append_images=pages[1:], resolution=300)
    return out


def _pdf_has_text(p: Path) -> bool:
    try:
        r = _run(["pdftotext", "-l", "3", str(p), "-"], timeout=60)
        return len(r.stdout.strip()) > 40
    except Exception:
        return False


def _pdf_pages(p: Path) -> int:
    try:
        out = _run(["pdfinfo", str(p)], timeout=30).stdout.decode("utf-8", "ignore")
        for ln in out.splitlines():
            if ln.startswith("Pages:"):
                return int(ln.split()[1])
    except Exception:
        pass
    return 0


def _image_pdf(img: Image.Image, outdir: Path) -> Path | None:
    """Image -> searchable PDF page (picture + invisible OCR text)."""
    img = img.convert("RGB")
    if max(img.size) > 3500:
        img.thumbnail((3500, 3500))
    try:  # straighten tilted phone photos so the text layer is accurate
        from .extract import deskew_angle
        ang = deskew_angle(ImageOps.grayscale(img))
        if ang:
            img = img.rotate(ang, resample=Image.BICUBIC, expand=True, fillcolor="white")
        if max(img.size) < 2000:  # tesseract reads small photos better upscaled
            sc = 2000 / max(img.size)
            img = img.resize((int(img.width * sc), int(img.height * sc)), Image.LANCZOS)
    except Exception as e:
        log.info("deskew for PDF skipped: %s", e)
    src = outdir / f"{uuid.uuid4().hex}.jpg"
    img.save(src, "JPEG", quality=88, dpi=(200, 200))
    base = outdir / src.stem
    r = _run(["tesseract", str(src), str(base), "-l", "eng", "--dpi", "200", "pdf"], timeout=180)
    out = base.with_suffix(".pdf")
    if r.returncode == 0 and out.exists():
        return out
    log.info("tesseract pdf failed (%s) — image-only page", r.stderr[-200:])
    out = outdir / f"{uuid.uuid4().hex}.pdf"
    img.save(out, "PDF", resolution=200)
    return out


def _ocr_pdf(src: Path, outdir: Path) -> Path:
    """Add a text layer to a scanned PDF (re-renders pages at 200 dpi). Returns src unchanged if not worth it."""
    n = _pdf_pages(src)
    if n == 0 or n > MAX_OCR_PAGES or _pdf_has_text(src):
        return src
    from .extract import pdf_pages_to_images
    try:
        pages = [_image_pdf(im, outdir) for im in pdf_pages_to_images(src, dpi=200, max_pages=n)]
        pages = [p for p in pages if p]
        if not pages:
            return src
        return _unite(pages, outdir)
    except Exception as e:
        log.info("OCR layer skipped for %s: %s", src.name, e)
        return src


def _unite(parts: list[Path], outdir: Path) -> Path:
    if len(parts) == 1:
        return parts[0]
    out = outdir / f"{uuid.uuid4().hex}.pdf"
    r = _run(["pdfunite", *map(str, parts), str(out)], timeout=300)
    if r.returncode != 0:
        r = _run(["qpdf", "--empty", "--pages", *map(str, parts), "--", str(out)], timeout=300) if shutil.which("qpdf") else r
    if not out.exists():
        raise RuntimeError(f"PDF merge failed: {r.stderr[-200:]!r}")
    return out


def side_to_pdf(path: Path, ext: str, name: str, outdir: Path) -> Path | None:
    """One stored file -> PDF (searchable where possible)."""
    from .files import document_text, kind_label
    if ext == "pdf":
        return _ocr_pdf(path, outdir)
    if ext in IMAGES:
        with Image.open(path) as im:
            frames = []
            try:
                i = 0
                while i < 50:
                    im.seek(i)
                    frames.append(ImageOps.exif_transpose(im.copy()))
                    i += 1
            except EOFError:
                pass
        parts = [p for p in (_image_pdf(f, outdir) for f in (frames or [])) if p]
        return _unite(parts, outdir) if parts else None
    if ext in OFFICE:
        stem = "".join(ch for ch in Path(name).stem if ch.isalnum() or ch in " -_()")[:60].strip() or "document"
        sub = outdir / uuid.uuid4().hex
        sub.mkdir()
        tmp = sub / f"{stem}.{ext if ext != 'md' else 'txt'}"
        shutil.copyfile(path, tmp)
        out = _soffice(tmp, outdir)
        if out:
            return out
        text = document_text(path, ext)
        return _text_pdf(name, text or f"({kind_label(ext)} file — contents couldn't be rendered)", outdir) if text else None
    if ext == "eml":
        return _text_pdf(name, document_text(path, ext), outdir)
    # not convertible: placeholder page so the PDF still shows it exists
    size = path.stat().st_size if path.exists() else 0
    return _text_pdf(f"Attached file: {name}",
                     f"This {kind_label(ext)} file ({size / 1048576:.1f} MB) can't be shown as a PDF.\n"
                     f"The original is stored in CertVault — download it from the document page.", outdir)


def build_combined(doc, pages) -> Path | None:
    """Build files/<id>.combined.pdf from the main file + every extra page. Returns the path or None."""
    sides = []
    if doc["file_ext"]:
        sides.append((config.FILES_DIR / f"{doc['id']}.{doc['file_ext']}", doc["file_ext"], doc["original_name"] or "document"))
    for p in pages:
        sides.append((config.FILES_DIR / f"{p['id']}.{p['file_ext']}", p["file_ext"], p["original_name"] or p["label"] or "page"))
    if not sides:
        return None
    work = _work()
    try:
        parts = []
        for path, ext, name in sides:
            if not path.exists():
                continue
            try:
                pdf = side_to_pdf(path, ext, name, work)
                if pdf:
                    parts.append(pdf)
            except Exception as e:
                log.warning("Couldn't convert %s to PDF: %s", name, e)
        if not parts:
            return None
        merged = _unite(parts, work)
        dest = combined_path(doc["id"])
        tmp = dest.with_name(f".{dest.name}.{uuid.uuid4().hex[:8]}.tmp")
        shutil.copyfile(merged, tmp)
        tmp.replace(dest)
        return dest
    finally:
        shutil.rmtree(work, ignore_errors=True)


def pack_pdf(cover_title: str, cover_rows: list[list[str]], doc_pdfs: list[Path], owner_lines: list[str]) -> bytes:
    """One PDF: cover page with a summary table, then every document's PDF."""
    work = _work()
    try:
        head = "".join(f"<th>{html.escape(h)}</th>" for h in cover_rows[0])
        body = "".join("<tr>" + "".join(f"<td>{html.escape(c or '')}</td>" for c in r) + "</tr>" for r in cover_rows[1:])
        page = (f"<html><head><meta charset='utf-8'><style>body{{font-family:DejaVu Sans,Arial;font-size:9.5pt}}"
                f"h1{{font-size:18pt;margin:0}} p{{color:#444}} table{{border-collapse:collapse;width:100%}}"
                f"th,td{{border:1px solid #bbb;padding:4px 6px;text-align:left;vertical-align:top}} th{{background:#dde5f5}}</style></head>"
                f"<body><h1>{html.escape(cover_title)}</h1><p>{'<br>'.join(html.escape(x) for x in owner_lines)}<br>"
                f"Generated {datetime.now():%d/%m/%Y %H:%M} · {len(doc_pdfs)} document(s)</p>"
                f"<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></body></html>")
        src = work / "cover.html"
        src.write_text(page, encoding="utf-8")
        cover = _soffice(src, work)
        if not cover:
            cover = _text_pdf(cover_title, "\n".join(owner_lines) + "\n\n" +
                              "\n".join(" | ".join(c or "" for c in r) for r in cover_rows), work)
        parts = [cover] + [p for p in doc_pdfs if p and p.exists()]
        return _unite(parts, work).read_bytes()
    finally:
        shutil.rmtree(work, ignore_errors=True)
