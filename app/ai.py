"""AI document reading. The model *looks at the actual file* (image or PDF pages) plus the
OCR text and returns structured fields.

Providers:
  - anthropic : Claude via the Anthropic API (best accuracy; needs an API key)
  - ollama    : any local Ollama vision model, e.g. qwen2.5vl:7b, llama3.2-vision, gemma3
  - none      : rule-based OCR only
Configured in Settings → AI (stored in the DB, admin only).
"""
import base64
import io
import json
import logging
import re
from datetime import date
from pathlib import Path

import httpx
from PIL import Image

from . import db
from .categories import CATEGORIES, CATEGORY_BY_ID, HRWL_CLASSES
from .extract import TEXT_KINDS, page_images

log = logging.getLogger("certvault.ai")

DEFAULTS = {
    "ai_provider": "none",
    "anthropic_model": "claude-sonnet-5-5",
    "ollama_url": "",
    "ollama_model": "qwen2.5vl:7b",
}

FIELDS = ["transcript", "title", "category", "issuer", "issuer_type", "holder_name", "licence_number",
          "completion_date", "expiry_date", "expiry_estimated", "no_expiry", "location", "notes", "classes", "rto_code"]


def ai_settings() -> dict:
    s = {**DEFAULTS, **{k: v for k, v in db.get_settings(0).items() if v not in (None, "")}}
    return s


def enabled() -> bool:
    s = ai_settings()
    if s["ai_provider"] == "anthropic":
        return bool(s.get("anthropic_api_key"))
    return s["ai_provider"] == "ollama"


HRWL_LIST = ", ".join(f"{k} = {v}" for k, v in HRWL_CLASSES.items() if k != "CO")


def build_prompt(ocr_text: str) -> str:
    cats = "\n".join(
        f'  - "{c["id"]}": {c["name"]}' + (" [REGISTER]" if c["kind"] == "register" else "")
        + (f' (typically valid {c["validity_years"]} yr)' if c["validity_years"] else "")
        for c in CATEGORIES)
    return f"""You are reading a scanned/photographed Australian (usually Western Australian) licence, ticket,
certificate, statement of attainment or site induction card. Today's date is {date.today().isoformat()}.

Look carefully at the image(s) and extract the details. OCR text is provided as a hint but it may contain errors -
trust what you can see in the image over the OCR.

Return ONLY a JSON object with exactly these keys:
{{
  "title": short human title, e.g. "HLTAID011 Provide First Aid" or "WA Driver's Licence (C)",
  "category": one of the ids below,
  "issuer": who issued it / who it is for (e.g. "WA Department of Transport", "WorkSafe WA", the RTO name, or the company for a site induction),
  "issuer_type": one of "government", "training", "company", "other",
  "holder_name": person's name or null,
  "licence_number": licence / certificate / card number or null,
  "completion_date": date completed or issued, "YYYY-MM-DD" or null,
  "expiry_date": expiry / valid-until / refresher-due date, "YYYY-MM-DD" or null,
  "expiry_estimated": true if the document does not print an expiry and you estimated it from typical industry validity,
  "no_expiry": true if this type genuinely does not expire (e.g. WA white card, most statements of attainment) and no expiry is printed,
  "location": where it was completed / training venue / site (suburb + state) or null,
  "classes": every licence class / endorsement / unit it covers, each spelled out, separated by "; "
             (e.g. "CV – Vehicle loading crane (10 metre-tonnes or more); DG – Dogging; RB – Basic rigging"
             or "C – Car; HR – Heavy rigid") or null,
  "rto_code": the RTO / training provider number if printed, or null,
  "notes": anything else useful in one line (conditions, restrictions, endorsements, unit codes) or null,
  "transcript": a clean, correctly spelled transcription of ALL readable text on the document (every side/page),
                laid out line by line as it appears, fixing OCR mistakes. Leave out signatures/barcodes. Max ~3000 characters.
}}

Rules:
- Australian dates are day-first: 03/04/2026 is 3 April 2026.
- Never use a date of birth as completion or expiry.
- If only a month/year expiry is printed, use the last day of that month.
- If there is no printed expiry but the category has a typical validity, set expiry_date = completion_date + that validity and expiry_estimated = true.
- The document may have several images: front, back and extra pages of the SAME card/certificate. Combine them.
  Licence classes and expiry dates are often on the back.
- High Risk Work Licence class codes (list EVERY class shown, with its name):
  {HRWL_LIST}
- REGISTERS (equipment / inspection registers such as a rigging gear register, harness register, test & tag register,
  plant register): use a [REGISTER] category. completion_date = the most recent inspection date, expiry_date = the
  EARLIEST upcoming "next inspection / retest / due" date of any item in it, issuer = who keeps or inspects it,
  title e.g. "Rigging Gear Register – CME", notes = a one-line summary (number of items, current colour code,
  any items overdue or tagged out). In WA, rigging gear is usually inspected quarterly (colour code changes each quarter).

Category ids:
{cats}

Document text (OCR or spreadsheet contents):
\"\"\"
{(ocr_text or '')[:20000]}
\"\"\""""


def _img_b64(img: Image.Image, max_side: int = 1568) -> str:
    img = img.convert("RGB")
    img.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=88)
    return base64.b64encode(buf.getvalue()).decode()


def _parse_json(text: str) -> dict:
    text = text.strip()
    text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.M).strip()
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ValueError("AI did not return JSON")
    return json.loads(m.group(0))


def _clean_date(v):
    if not v or not isinstance(v, str):
        return None
    try:
        return date.fromisoformat(v[:10]).isoformat()
    except ValueError:
        return None


def clean(result: dict) -> dict:
    out = {}
    for k in FIELDS:
        v = result.get(k)
        if isinstance(v, str):
            v = v.strip() or None
            if v and v.lower() in ("null", "none", "n/a", "unknown"):
                v = None
        out[k] = v
    out["completion_date"] = _clean_date(out["completion_date"])
    out["expiry_date"] = _clean_date(out["expiry_date"])
    out["expiry_estimated"] = bool(out.get("expiry_estimated"))
    out["no_expiry"] = bool(out.get("no_expiry")) and not out["expiry_date"]
    if out["category"] not in CATEGORY_BY_ID:
        out["category"] = None
    if out["issuer_type"] not in ("government", "training", "company", "other"):
        out["issuer_type"] = None
    if out.get("transcript") and isinstance(out["transcript"], str):
        out["transcript"] = out["transcript"][:6000]
    for k in ("title", "issuer", "holder_name", "licence_number", "location", "notes", "classes", "rto_code"):
        if out.get(k) and not isinstance(out[k], str):
            out[k] = str(out[k])
        if out.get(k):
            out[k] = out[k][:600]
    return out


Files = list[tuple[Path, str]]  # (path, ext) — main file first, then back / extra pages


def _anthropic(files: Files, prompt: str, s: dict) -> dict:
    content, n_img = [], 0
    for i, (path, ext) in enumerate(files):
        if ext in TEXT_KINDS:
            continue  # spreadsheet: its text is already in the prompt
        if ext == "pdf" and path.stat().st_size < 20 * 1024 * 1024:
            content.append({"type": "document", "source": {
                "type": "base64", "media_type": "application/pdf",
                "data": base64.b64encode(path.read_bytes()).decode()}})
            continue
        for im in page_images(path, ext)[:3]:
            if n_img >= 6:
                break
            label = "FRONT" if i == 0 else f"SIDE / PAGE {i + 1}"
            content.append({"type": "text", "text": f"[{label}]"})
            content.append({"type": "image", "source": {
                "type": "base64", "media_type": "image/jpeg", "data": _img_b64(im)}})
            n_img += 1
    content.append({"type": "text", "text": prompt})
    r = httpx.post(
        "https://api.anthropic.com/v1/messages",
        headers={"x-api-key": s["anthropic_api_key"], "anthropic-version": "2023-06-01",
                 "content-type": "application/json"},
        json={"model": s["anthropic_model"], "max_tokens": 3500,
              "messages": [{"role": "user", "content": content}]},
        timeout=180,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"Anthropic API {r.status_code}: {r.text[:300]}")
    data = r.json()
    text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
    return _parse_json(text)


def _ollama(files: Files, prompt: str, s: dict) -> dict:
    imgs = []
    for path, ext in files:
        for im in page_images(path, ext)[:2]:
            if len(imgs) < 4:
                imgs.append(_img_b64(im, 1280))
    r = httpx.post(
        s["ollama_url"].rstrip("/") + "/api/chat",
        json={"model": s["ollama_model"], "stream": False, "format": "json",
              "options": {"temperature": 0},
              "messages": [{"role": "user", "content": prompt, **({"images": imgs} if imgs else {})}]},
        timeout=300,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"Ollama {r.status_code}: {r.text[:300]}")
    return _parse_json(r.json()["message"]["content"])


def analyse(files: Files, ocr_text: str) -> tuple[dict, str]:
    """Returns (fields, source_label). Raises on failure."""
    s = ai_settings()
    prompt = build_prompt(ocr_text)
    if s["ai_provider"] == "anthropic":
        if not s.get("anthropic_api_key"):
            raise RuntimeError("No Anthropic API key set")
        return clean(_anthropic(files, prompt, s)), f"ai:{s['anthropic_model']}"
    if s["ai_provider"] == "ollama":
        return clean(_ollama(files, prompt, s)), f"ai:{s['ollama_model']}"
    raise RuntimeError("AI is turned off")


def test_connection() -> str:
    s = ai_settings()
    if s["ai_provider"] == "anthropic":
        r = httpx.post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": s.get("anthropic_api_key", ""), "anthropic-version": "2023-06-01"},
            json={"model": s["anthropic_model"], "max_tokens": 10,
                  "messages": [{"role": "user", "content": "Reply with OK"}]},
            timeout=30)
        if r.status_code >= 400:
            raise RuntimeError(f"{r.status_code}: {r.text[:200]}")
        return f"Connected to Claude ({s['anthropic_model']})"
    if s["ai_provider"] == "ollama":
        r = httpx.get(s["ollama_url"].rstrip("/") + "/api/tags", timeout=10)
        r.raise_for_status()
        names = [m["name"] for m in r.json().get("models", [])]
        if s["ollama_model"] not in names and f"{s['ollama_model']}:latest" not in names:
            raise RuntimeError(f"Connected, but model '{s['ollama_model']}' isn't pulled. "
                               f"Run: ollama pull {s['ollama_model']}  (available: {', '.join(names[:8]) or 'none'})")
        return f"Connected to Ollama ({s['ollama_model']})"
    raise RuntimeError("AI is turned off")
