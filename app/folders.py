"""Folders (collections): organisations like Western Power or South32, plus groups like Medicals and Gov docs.

* A document can be in many folders.
* Folders are created and filled automatically: companies are spotted in the document (issuer, text, title,
  "required for"), medicals go to Medicals, government-issued items to Government docs.
* You can add/remove by hand; removing an automatic match sticks (it won't come back).
* A folder can list required ticket types — the folder page then shows a ready / missing / expiring checklist.
"""
import re
from datetime import date

from . import db
from .categories import CATEGORY_BY_ID, kind_of

SCHEMA = """
CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    icon TEXT,
    color TEXT,
    ctype TEXT NOT NULL DEFAULT 'org',
    auto_key TEXT,
    requirements TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, name)
);
CREATE TABLE IF NOT EXISTS doc_collections (
    doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    auto INTEGER NOT NULL DEFAULT 0,
    excluded INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (doc_id, collection_id)
);
CREATE INDEX IF NOT EXISTS idx_dc_col ON doc_collections(collection_id);
"""

# (folder name, regex, icon, colour) — WA resources, utilities, telco, construction
ORGS = [
    ("Western Power", r"western\s*power", "bolt", "amber"),
    ("Horizon Power", r"horizon\s*power", "bolt", "amber"),
    ("Synergy", r"\bsynergy\b", "bolt", "amber"),
    ("Water Corporation", r"water\s*corp", "water_drop", "blue"),
    ("Main Roads WA", r"main\s*roads", "traffic", "amber"),
    ("South32", r"south\s*32", "factory", "orange"),
    ("Alcoa", r"\balcoa\b", "factory", "orange"),
    ("BHP", r"\bbhp\b", "factory", "orange"),
    ("Rio Tinto", r"rio\s*tinto", "factory", "red"),
    ("Fortescue", r"fortescue|\bfmg\b", "factory", "orange"),
    ("Roy Hill / Hancock", r"roy\s*hill|hancock\s*prospecting", "factory", "orange"),
    ("Woodside", r"\bwoodside\b", "factory", "blue"),
    ("Chevron", r"\bchevron\b", "factory", "blue"),
    ("Santos", r"\bsantos\b", "factory", "green"),
    ("Newmont", r"\bnewmont\b", "factory", "amber"),
    ("Northern Star", r"northern\s*star", "factory", "amber"),
    ("Mineral Resources", r"mineral\s*resources|\bminres\b", "factory", "orange"),
    ("Gold Fields", r"gold\s*fields", "factory", "amber"),
    ("Tronox", r"\btronox\b", "factory", "orange"),
    ("Iluka", r"\biluka\b", "factory", "orange"),
    ("Albemarle", r"\balbemarle\b", "factory", "teal"),
    ("Tianqi", r"\btianqi\b", "factory", "teal"),
    ("IGO", r"\bigo\b\s*(?:ltd|limited)", "factory", "teal"),
    ("Pilbara Minerals", r"pilbara\s*minerals|\bpls\b\s*ltd", "factory", "teal"),
    ("CBH Group", r"\bcbh\b", "factory", "green"),
    ("Perth Airport", r"perth\s*airport", "domain", "indigo"),
    ("Fremantle Ports", r"fremantle\s*ports", "anchor", "indigo"),
    ("Pilbara Ports", r"pilbara\s*ports", "anchor", "indigo"),
    ("Public Transport Authority", r"public\s*transport\s*authority|\bpta\b\s*wa", "domain", "indigo"),
    ("Telstra", r"\btelstra\b", "cell_tower", "purple"),
    ("Optus", r"\boptus\b", "cell_tower", "purple"),
    ("TPG Telecom", r"\btpg\b|vodafone", "cell_tower", "purple"),
    ("NBN Co", r"\bnbn\b", "cell_tower", "purple"),
    ("Amplitel", r"\bamplitel\b", "cell_tower", "purple"),
    ("Indara", r"\bindara\b", "cell_tower", "purple"),
    ("Ventia", r"\bventia\b", "engineering", "teal"),
    ("Downer", r"\bdowner\b", "engineering", "teal"),
    ("Service Stream", r"service\s*stream", "engineering", "teal"),
    ("Visionstream", r"\bvisionstream\b", "engineering", "teal"),
    ("Kordia", r"\bkordia\b", "cell_tower", "purple"),
    ("Future Engineering & Communication", r"future\s*engineering", "engineering", "teal"),
    ("A1 Communication Rigging", r"a1\s*communication", "engineering", "teal"),
    ("Monadelphous", r"\bmonadelphous\b", "engineering", "teal"),
    ("Civmec", r"\bcivmec\b", "engineering", "teal"),
    ("UGL", r"\bugl\b", "engineering", "teal"),
    ("John Holland", r"john\s*holland", "engineering", "teal"),
    ("CPB Contractors", r"\bcpb\b", "engineering", "teal"),
    ("Acciona", r"\bacciona\b", "engineering", "teal"),
    ("BGC", r"\bbgc\b", "engineering", "teal"),
]
_ORG_RX = [(n, re.compile(rx, re.I), ic, col) for n, rx, ic, col in ORGS]

GROUPS = {
    "group:medical": ("Medicals", "medical_information", "red"),
    "group:gov": ("Government docs", "account_balance", "indigo"),
}

# Starting points only — edit to match what the client actually asks for.
SUGGESTED = {
    "telco": ["heights", "rescue", "rf_eme", "first_aid", "cpr", "white_card", "site_induction"],
    "power": ["heights", "rescue", "first_aid", "cpr", "white_card", "ewp", "site_induction", "med_fitness"],
    "mining": ["white_card", "first_aid", "heights", "confined_space", "gas_test", "site_induction", "med_fitness"],
}
ORG_SECTOR = {"Telstra": "telco", "Optus": "telco", "TPG Telecom": "telco", "NBN Co": "telco", "Amplitel": "telco",
              "Indara": "telco", "Kordia": "telco", "Western Power": "power", "Horizon Power": "power", "Synergy": "power"}


def init():
    db.connect().executescript(SCHEMA)
    db.connect().commit()


def _get_or_create(user_id: int, name: str, icon: str, color: str, ctype: str, auto_key: str) -> int:
    row = db.q1("SELECT id FROM collections WHERE user_id=? AND (auto_key=? OR name=?)", (user_id, auto_key, name))
    if row:
        return row["id"]
    return db.run("INSERT INTO collections(user_id, name, icon, color, ctype, auto_key) VALUES(?,?,?,?,?,?)",
                  (user_id, name, icon, color, ctype, auto_key))


def detect(doc) -> list[tuple[str, str, str, str, str]]:
    """[(auto_key, name, icon, colour, ctype)] folders this document belongs in."""
    hay = " ".join(str(doc[k] or "") for k in ("title", "issuer", "required_for", "notes", "ocr_text", "ai_text", "original_name"))
    out = []
    for name, rx, ic, col in _ORG_RX:
        if rx.search(hay):
            out.append((f"org:{name.lower()}", name, ic, col, "org"))
    k = kind_of(doc["category"])
    if k == "medical":
        out.append(("group:medical", *GROUPS["group:medical"], "group"))
    if doc["issuer_type"] == "government" or k == "personal" or doc["category"] in ("drivers_licence", "hrwl", "police_check", "wwc"):
        out.append(("group:gov", *GROUPS["group:gov"], "group"))
    return out


def auto_assign(doc_id: str) -> None:
    doc = db.q1("SELECT * FROM documents WHERE id=?", (doc_id,))
    if not doc or db.get_setting(doc["user_id"], "auto_folders", "1") != "1":
        return
    wanted = set()
    blocked = set((db.get_setting(doc["user_id"], "auto_folders_blocked") or "").split(","))
    for key, name, ic, col, ctype in detect(doc):
        if key in blocked:
            continue
        cid = _get_or_create(doc["user_id"], name, ic, col, ctype, key)
        wanted.add(cid)
        db.run("INSERT OR IGNORE INTO doc_collections(doc_id, collection_id, auto) VALUES(?,?,1)", (doc_id, cid))
    # drop stale automatic links that no longer match (manual ones and exclusions stay)
    for r in db.q("SELECT collection_id FROM doc_collections WHERE doc_id=? AND auto=1 AND excluded=0", (doc_id,)):
        if r["collection_id"] not in wanted:
            db.run("DELETE FROM doc_collections WHERE doc_id=? AND collection_id=?", (doc_id, r["collection_id"]))


def doc_folder_ids(user_id: int) -> dict[str, list[int]]:
    out: dict[str, list[int]] = {}
    for r in db.q("SELECT dc.doc_id, dc.collection_id FROM doc_collections dc JOIN collections c ON c.id=dc.collection_id "
                  "WHERE c.user_id=? AND dc.excluded=0", (user_id,)):
        out.setdefault(r["doc_id"], []).append(r["collection_id"])
    return out


def _state(d, today: date) -> str:
    if d["status"] == "processing":
        return "processing"
    if not d["expiry_date"]:
        return "none" if d["no_expiry"] else "unknown"
    days = (date.fromisoformat(d["expiry_date"]) - today).days
    return "expired" if days < 0 else "soon" if days <= 30 else "valid"


def checklist(user_id: int, cid: int, today: date, superseded: set) -> list[dict]:
    """For each required type: the best current document that satisfies it.
    Site inductions / onboarding must be in this folder; everything else can be any of your documents."""
    col = db.q1("SELECT * FROM collections WHERE id=? AND user_id=?", (cid, user_id))
    if not col or not col["requirements"]:
        return []
    in_folder = {r["doc_id"] for r in db.q("SELECT doc_id FROM doc_collections WHERE collection_id=? AND excluded=0", (cid,))}
    docs = [d for d in db.q("SELECT * FROM documents WHERE user_id=?", (user_id,)) if d["id"] not in superseded]
    rank = {"valid": 0, "none": 1, "soon": 2, "unknown": 3, "processing": 4, "expired": 5}
    out = []
    for cat_id in [c for c in col["requirements"].split(",") if c in CATEGORY_BY_ID]:
        site_specific = cat_id in ("site_induction", "biz_onboarding")
        cands = [d for d in docs if d["category"] == cat_id and (not site_specific or d["id"] in in_folder)]
        best = min(cands, key=lambda d: (rank[_state(d, today)], -(int(d["expiry_date"].replace("-", "")) if d["expiry_date"] else 0)),
                   default=None)
        st = _state(best, today) if best else "missing"
        out.append({"category": cat_id, "name": CATEGORY_BY_ID[cat_id]["name"], "icon": CATEGORY_BY_ID[cat_id]["icon"],
                    "state": st, "doc_id": best["id"] if best else None, "title": best["title"] if best else None,
                    "expiry_date": best["expiry_date"] if best else None, "site_specific": site_specific})
    return out
