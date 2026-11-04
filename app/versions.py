"""Multiple copies of the same ticket (e.g. first aid renewed every 3 years).

Documents with the same type + title (or the same type + licence number) form one group.
The newest one is "current"; older ones are "previous versions": they're hidden from the
main lists, don't trigger reminders, and are listed under ⋮ → Previous versions.
A document can be pinned out of grouping with versions_group = 'solo'.
"""
import re


def _norm(s: str | None) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def group_key(d) -> str | None:
    if d["status"] == "processing":
        return None
    if d["version_group"] == "solo":
        return None
    cat = d["category"] or "other"
    num = _norm(d["licence_number"])
    # a renewed licence/HRWL/policy keeps its number — group on that when the type is specific
    if num and len(num) >= 5 and cat not in ("other", "other_register", "training", "asset_receipt"):
        return f"{cat}#{num}"
    # generic / uncategorised documents are never merged on title alone (two "image.jpg" uploads aren't renewals)
    if cat in ("other", "other_register", "training", "asset_receipt", "biz_contract") or not d["category"]:
        return None
    t = _norm(d["title"])
    stem = _norm((d.get("original_name") if isinstance(d, dict) else d["original_name"]) or "")
    stem = re.sub(r"(pdf|jpe?g|png|heic|webp|tiff?|docx?|xlsx?)$", "", stem)
    if not t or (stem and t == stem) or len(t) < 4:
        return None
    issuer = _norm(d["issuer"]) if cat in ("site_induction", "biz_onboarding") else ""
    if cat in ("site_induction", "biz_onboarding") and not issuer:
        return None
    return f"{cat}|{t}|{issuer}"


def _rank(d):
    # newest issue/completion wins; fall back to expiry, then upload time
    issued = d["completion_date"] or (d["created_at"] or "")[:10]
    return (issued, d["expiry_date"] or "", d["created_at"] or "")


def annotate(docs: list[dict]) -> list[dict]:
    """Adds: superseded (bool), current_id, versions (count in group). Mutates and returns docs."""
    groups: dict[str, list[dict]] = {}
    for d in docs:
        d["superseded"] = False
        d["current_id"] = d["id"]
        d["versions"] = 1
        k = group_key(d)
        if k:
            groups.setdefault(k, []).append(d)
    for members in groups.values():
        if len(members) < 2:
            continue
        newest = max(members, key=_rank)
        for m in members:
            m["versions"] = len(members)
            m["current_id"] = newest["id"]
            m["superseded"] = m is not newest
    return docs


def group_of(docs: list[dict], doc_id: str) -> list[dict]:
    target = next((d for d in docs if d["id"] == doc_id), None)
    if not target:
        return []
    k = group_key(target)
    if not k:
        return [target]
    return sorted([d for d in docs if group_key(d) == k], key=_rank, reverse=True)


def superseded_ids(rows) -> set[str]:
    docs = annotate([dict(r) for r in rows])
    return {d["id"] for d in docs if d["superseded"]}
