/* CertVault front end — plain JS, no build step. */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = (n, cls = "") => `<svg class="icon ${cls}" aria-hidden="true"><use href="/static/icons.svg#${n}"/></svg>`;
const app = $("#app");

const S = { me: null, docs: [], cats: [], catById: {}, filter: "all", query: "", pollTimer: null };

// ---------- utilities ----------
function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }

function snack(msg, ms = 3200) {
  const s = $("#snack");
  s.textContent = msg;
  s.classList.add("show");
  clearTimeout(snack.t);
  snack.t = setTimeout(() => s.classList.remove("show"), ms);
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (S.me) headers["X-CSRF-Token"] = S.me.csrf;
  let body = opts.body;
  if (body && !(body instanceof FormData)) { headers["Content-Type"] = "application/json"; body = JSON.stringify(body); }
  const r = await fetch(path, { method: opts.method || "GET", headers, body, credentials: "same-origin" });
  let data = null;
  try { data = await r.json(); } catch (e) { /* not json */ }
  if (r.status === 401 && !opts.allow401) { S.me = null; location.hash = "#/login"; throw new Error("Please log in"); }
  if (!r.ok && !opts.allow401) throw new Error((data && (data.detail || data.message)) || `Error ${r.status}`);
  return opts.allow401 ? { status: r.status, data } : data;
}

const fmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
};

function stateLabel(d) {
  if (d.status === "processing") return ["processing", "Reading…", "hourglass_top"];
  switch (d.state) {
    case "expired": return ["expired", d.days_left === -1 ? "Expired yesterday" : `Expired ${-d.days_left}d ago`, "error"];
    case "soon": return ["soon", d.days_left === 0 ? "Expires today" : `${d.days_left} day${d.days_left === 1 ? "" : "s"}`, "warning"];
    case "valid": return ["valid", d.days_left > 365 ? `${(d.days_left / 365).toFixed(1)} yrs` : `${d.days_left} days`, "check"];
    case "none": return ["none", "No expiry", "verified"];
    default: return ["unknown", "No date", "event_busy"];
  }
}
const chip = (d) => { const [c, l, i] = stateLabel(d); return `<span class="chip ${c}">${icon(i)}${esc(l)}</span>`; };

function lead(d) {
  if (d.has_thumb && S.showThumbs) return `<div class="lead thumb c-${esc(d.color)}"><img src="/api/documents/${d.id}/thumb" alt="" loading="lazy"></div>`;
  return `<div class="lead c-${esc(d.color)}">${icon(d.icon)}</div>`;
}

function docItem(d) {
  const sub = [d.issuer, d.expiry_date ? `${d.kind === "register" ? "Due" : "Exp"} ${fmtDate(d.expiry_date)}${d.expiry_estimated ? " (est.)" : ""}` : null,
    d.superseded ? "Previous version" : d.versions > 1 ? `${d.versions} versions` : null].filter(Boolean).join(" · ") || d.category_name;
  const review = d.status === "review" ? `<span class="chip review">${icon("edit")}Check</span>` : "";
  return `<a class="item" href="#/doc/${d.id}">${lead(d)}
    <div class="body"><div class="h">${esc(d.title || d.original_name || "Untitled")}</div><div class="s">${esc(sub)}</div>
    ${d.status === "processing" ? '<div class="progress"></div>' : ""}</div>
    <div class="trail">${chip(d)}${review}</div></a>`;
}

function sortDocs(docs) {
  const rank = (d) => d.status === "processing" ? 0 : d.state === "expired" ? 1 : d.state === "soon" ? 2 : d.state === "valid" ? 3 : d.state === "unknown" ? 4 : 5;
  return [...docs].sort((a, b) => rank(a) - rank(b) || (a.days_left ?? 1e9) - (b.days_left ?? 1e9) || (a.title || "").localeCompare(b.title || ""));
}

function topbar(title, { back = false, actions = "" } = {}) {
  return `<header class="topbar">${back ? `<button class="icon-btn" data-back aria-label="Back">${icon("arrow_back")}</button>` : ""}
    <h1>${esc(title)}</h1>${actions}</header>`;
}

function chrome(showNav, fab = false) {
  $("#nav").classList.toggle("hidden", !showNav);
  $("#fab").classList.toggle("hidden", !fab);
  app.classList.toggle("no-nav", !showNav);
  const r = (location.hash.split("/")[1] || "home").split("?")[0] || "home";
  $$(".nav-item").forEach((a) => {
    const on = a.dataset.nav === r;
    a.classList.toggle("active", on);
    const use = $("use", a);
    const base = use.getAttribute("href").replace("-fill", "");
    use.setAttribute("href", on ? base + "-fill" : base);
  });
  const attention = S.docs.filter((d) => !d.superseded && (d.state === "expired" || d.state === "soon")).length;
  const pill = $('[data-nav="home"] .pill');
  let b = $(".badge", pill);
  if (attention) { if (!b) { b = document.createElement("span"); b.className = "badge"; pill.append(b); } b.textContent = attention; }
  else if (b) b.remove();
}

function render(html) {
  app.innerHTML = `<div class="view-enter">${html}</div>`;
  $$("[data-back]", app).forEach((b) => b.addEventListener("click", () => history.length > 1 ? history.back() : (location.hash = "#/")));
  window.scrollTo(0, 0);
}

function dialog(html, onOpen) {
  const d = $("#dlg");
  d.innerHTML = html;
  $$("[data-close]", d).forEach((b) => b.addEventListener("click", () => d.close()));
  d.showModal();
  onOpen && onOpen(d);
  return d;
}

function confirmDlg(title, text, okLabel = "Delete", danger = true) {
  return new Promise((res) => {
    const d = dialog(`<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="btn-row">
      <button class="btn text" data-close>Cancel</button><button class="btn ${danger ? "danger" : "filled"}" id="ok">${esc(okLabel)}</button></div>`);
    $("#ok", d).addEventListener("click", () => { d.close(); res(true); });
    d.addEventListener("close", () => res(false), { once: true });
  });
}

async function loadDocs() {
  S.docs = await api("/api/documents");
  schedulePoll();
}

function schedulePoll() {
  clearTimeout(S.pollTimer);
  if (S.docs.some((d) => d.status === "processing")) {
    S.pollTimer = setTimeout(async () => {
      const before = S.docs.filter((d) => d.status === "processing").map((d) => d.id);
      await loadDocs().catch(() => {});
      const done = S.docs.filter((d) => before.includes(d.id) && d.status !== "processing");
      if (done.length) { snack(done.length === 1 ? `Read “${done[0].title}” — check the details` : `${done.length} documents read`); route(); }
    }, 2500);
  }
}

// ---------- auth views ----------
function viewSetup() {
  chrome(false);
  render(`<div class="auth"><div class="logo">${icon("shield_lock")}</div>
    <h1>Welcome</h1><p class="s">Create your CertVault account. The setup code is shown in the app's logs on TrueNAS (Apps → CertVault → Logs) and saved in <b>/data/SETUP_CODE.txt</b>.</p>
    <form class="form" id="f">
      <div class="field"><label>Setup code</label><input name="code" required autocomplete="off" autocapitalize="characters"></div>
      <div class="field"><label>Username</label><input name="username" required autocomplete="username" autocapitalize="none"></div>
      <div class="field"><label>Password</label><input name="password" type="password" required minlength="10" autocomplete="new-password"><div class="hint">At least 10 characters</div></div>
      <button class="btn filled block">Create account</button></form></div>`);
  $("#f").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try { await api("/api/setup", { method: "POST", body: f }); await boot(); } catch (err) { snack(err.message); }
  });
}

function viewLogin() {
  chrome(false);
  render(`<div class="auth"><div class="logo">${icon("shield_lock")}</div>
    <h1>CertVault</h1><p class="s">Your licences, tickets and inductions.</p>
    <form class="form" id="f">
      <div class="field"><label>Username</label><input name="username" required autocomplete="username" autocapitalize="none"></div>
      <div class="field"><label>Password</label><input name="password" type="password" required autocomplete="current-password"></div>
      <div class="field hidden" id="totpf"><label>2-step code</label><input name="totp" inputmode="numeric" autocomplete="one-time-code" maxlength="8"></div>
      <button class="btn filled block">Log in</button></form></div>`);
  $("#f").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (!f.totp) delete f.totp;
    try {
      const r = await api("/api/login", { method: "POST", body: f, allow401: true });
      if (r.status === 200) return boot();
      if (r.data && r.data.totp_required) { $("#totpf").classList.remove("hidden"); $("[name=totp]").focus(); return snack("Enter the code from your authenticator app"); }
      snack((r.data && r.data.detail) || "Login failed");
    } catch (err) { snack(err.message); }
  });
}

// ---------- home ----------
function viewHome() {
  chrome(true, true);
  const docs = S.docs.filter((d) => !d.superseded);
  const expired = docs.filter((d) => d.state === "expired");
  const soon = docs.filter((d) => d.state === "soon");
  const valid = docs.filter((d) => d.state === "valid" || d.state === "none");
  const review = docs.filter((d) => d.status === "review" || d.status === "processing");
  const upcoming = sortDocs(docs.filter((d) => ["expired", "soon", "valid"].includes(d.state) && d.status !== "processing")).slice(0, 8);
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const need = expired.length + soon.length;
  let html = topbar("CertVault", { actions: `<a class="icon-btn" href="#/all" aria-label="Search">${icon("search")}</a>` });
  html += `<div class="large-title">${greet}, ${esc(S.me.username.charAt(0).toUpperCase() + S.me.username.slice(1))}</div>
    <div class="subtitle">${docs.length ? (need ? `${need} item${need > 1 ? "s" : ""} need${need > 1 ? "" : "s"} attention` : "Everything is up to date") : "Let's add your first ticket"}</div>`;
  if (!docs.length) {
    html += `<div class="empty">${icon("folder_open")}<p>No documents yet.<br>Snap a photo of a licence or upload a PDF certificate —<br>${S.me.ai_enabled ? "AI" : "OCR"} will fill in the details.</p>
      <a class="btn filled" href="#/add">${icon("add_a_photo")}Add your first</a></div>`;
    return render(html);
  }
  html += `<div class="tiles">
    <a class="tile bad" href="#/all?f=expired"><span class="n">${expired.length}</span><span class="l">Expired</span></a>
    <a class="tile warn" href="#/all?f=soon"><span class="n">${soon.length}</span><span class="l">Due in 30 days</span></a>
    <a class="tile ok" href="#/all?f=valid"><span class="n">${valid.length}</span><span class="l">Current</span></a></div>`;
  const tracked = docs.filter((d) => ["valid", "soon", "expired"].includes(d.state));
  const pct = tracked.length ? Math.round((tracked.filter((d) => d.state !== "expired").length / tracked.length) * 100) : 100;
  const next = sortDocs(docs.filter((d) => d.days_left != null && d.days_left >= 0))[0];
  html += `<div class="card compliance"><div class="ring ${pct === 100 ? "ok" : pct >= 80 ? "warn" : "bad"}" data-pct="${pct}"><span>${pct}%</span></div>
    <div class="body"><h3>${pct === 100 ? "Fully compliant" : `${tracked.length - Math.round(pct * tracked.length / 100)} expired`}</h3>
    <p>${tracked.length} tracked · ${docs.filter((d) => d.kind === "register").length} registers${next ? `<br>Next: <b>${esc(next.title)}</b> in ${next.days_left} day${next.days_left === 1 ? "" : "s"}` : ""}</p></div>
    <button class="icon-btn" id="sharepack" aria-label="Share all current tickets">${icon("share")}</button></div>`;
  if (review.length) html += `<div class="section-title">Check these details</div><div class="list gap">${review.map(docItem).join("")}</div>`;
  if (upcoming.length) html += `<div class="section-title">Coming up</div><div class="list gap">${upcoming.map(docItem).join("")}</div>`;
  render(html);
  const ring = $(".ring"); if (ring) ring.style.setProperty("--p", ring.dataset.pct);
  $("#sharepack") && $("#sharepack").addEventListener("click", () => shareSheet(docs.filter((d) => d.status !== "processing" && d.state !== "expired")));
}

// ---------- all documents ----------
function viewAll(params) {
  chrome(true, true);
  if (params.get("f")) S.filter = params.get("f");
  if (params.get("q") != null) { S.query = params.get("q"); S.filter = "all"; }
  S.sel = S.sel || new Set();
  const present = [...new Set(S.docs.map((d) => d.category || "other"))];
  const filters = [["all", "All", "category"], ["expired", "Expired", "error"], ["soon", "Due soon", "warning"], ["valid", "Current", "check"],
    ...(S.docs.some((d) => d.superseded) ? [["old", "Previous versions", "history_edu"]] : []),
    ...(S.docs.some((d) => d.kind === "register") ? [["kind:ticket", "Tickets & licences", "badge"], ["kind:register", "Registers", "fact_check"]] : []),
    ...present.map((id) => [`cat:${id}`, (S.catById[id] || {}).name || id, (S.catById[id] || {}).icon || "description"])];
  const selecting = !!S.selecting;
  render(topbar(selecting ? `${S.sel.size} selected` : "Documents", { actions: selecting
    ? `<button class="icon-btn" id="selall" aria-label="Select all shown">${icon("select_check_box")}</button><button class="icon-btn" id="selx" aria-label="Cancel">${icon("close")}</button>`
    : `<button class="icon-btn" id="selon" aria-label="Select to share">${icon("check_box")}</button>` }) + `
    <label class="search">${icon("search")}<input id="q" type="search" placeholder="Search tickets, issuers, numbers" value="${esc(S.query)}" enterkeyhint="search"></label>
    <div class="chips" id="chips">${filters.map(([k, l, i]) => `<button class="fchip ${S.filter === k ? "on" : ""}" data-f="${esc(k)}">${S.filter === k ? icon("check") : ""}${esc(l)}</button>`).join("")}</div>
    <div id="res"></div>
    ${selecting ? `<div class="actionbar"><span>${S.sel.size ? `${S.sel.size} to share` : "Tap documents to select"}</span>
      <button class="btn filled" id="selshare" ${S.sel.size ? "" : "disabled"}>${icon("share")}Share</button></div>` : ""}`);
  const draw = () => {
    const q = S.query.trim().toLowerCase();
    let docs = S.filter === "old" ? S.docs.filter((d) => d.superseded) : S.docs.filter((d) => !d.superseded);
    if (S.filter === "valid") docs = docs.filter((d) => d.state === "valid" || d.state === "none");
    else if (S.filter.startsWith("kind:")) docs = docs.filter((d) => d.kind === S.filter.slice(5));
    else if (S.filter.startsWith("cat:")) docs = docs.filter((d) => (d.category || "other") === S.filter.slice(4));
    else if (!["all", "old"].includes(S.filter)) docs = docs.filter((d) => d.state === S.filter);
    if (q) docs = docs.filter((d) => [d.title, d.issuer, d.licence_number, d.category_name, d.holder_name, d.location, d.notes, d.original_name,
      d.classes, d.tags, d.required_for, d.rto_code]
      .some((v) => (v || "").toLowerCase().includes(q)));
    S.shown = sortDocs(docs);
    $("#res").innerHTML = docs.length ? `<div class="list gap ${selecting ? "selecting" : ""}">${S.shown.map((d) => selecting
      ? docItem(d).replace('<a class="item"', `<a class="item ${S.sel.has(d.id) ? "sel" : ""}" data-sel="${d.id}"`).replace(/<div class="lead[^"]*"[\s\S]*?<\/div>/, `<div class="lead c-grey">${icon(S.sel.has(d.id) ? "check_box" : "check_box_outline_blank")}</div>`)
      : docItem(d)).join("")}</div>`
      : `<div class="empty">${icon("search")}<p>Nothing matches.</p></div>`;
    $$("[data-sel]").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault(); const sid = a.dataset.sel;
      S.sel.has(sid) ? S.sel.delete(sid) : S.sel.add(sid); viewAll(new URLSearchParams());
    }));
  };
  draw();
  $("#selon") && $("#selon").addEventListener("click", () => { S.selecting = true; S.sel = new Set(); viewAll(new URLSearchParams()); });
  $("#selx") && $("#selx").addEventListener("click", () => { S.selecting = false; S.sel = new Set(); viewAll(new URLSearchParams()); });
  $("#selall") && $("#selall").addEventListener("click", () => { (S.shown || []).forEach((d) => S.sel.add(d.id)); viewAll(new URLSearchParams()); });
  $("#selshare") && $("#selshare").addEventListener("click", () => shareSheet(S.docs.filter((d) => S.sel.has(d.id))));
  $("#q").addEventListener("input", (e) => { S.query = e.target.value; draw(); });
  $$("#chips .fchip").forEach((b) => b.addEventListener("click", () => { S.filter = b.dataset.f; history.replaceState(null, "", "#/all"); viewAll(new URLSearchParams()); }));
}

// ---------- add / upload ----------
function viewAdd() {
  chrome(true, false);
  render(topbar("Add documents", { back: true }) + `
    <div class="drop" id="drop"><div class="big-icon">${icon("upload_file", "xl")}</div>
      <h3>Add a licence or ticket</h3>
      <div>Photos, PDFs or register spreadsheets (Excel/CSV) — or drop a whole folder here.<br>${S.me.ai_enabled ? `${icon("star_shine", "sm")} AI reads every file and fills in the details.` : "Details are read automatically with OCR."}</div></div>
    <div class="upload-actions three">
      <label class="btn tonal">${icon("photo_camera")}Take photo<input type="file" accept="image/*" capture="environment" class="hidden" id="cam"></label>
      <label class="btn tonal">${icon("upload_file")}Choose files<input type="file" accept="application/pdf,image/*,.heic,.heif,.xlsx,.xlsm,.csv" multiple class="hidden" id="pick"></label>
      <label class="btn tonal">${icon("folder_open")}Import folder<input type="file" webkitdirectory directory multiple class="hidden" id="folder"></label>
    </div>
    <div class="card"><div class="switch-row"><div class="body"><b>Front &amp; back of one card</b><div class="s">Photos you take or pick become the sides/pages of ONE document</div></div><input type="checkbox" class="switch" id="group" ${S.groupMode ? "checked" : ""}></div>
      <div id="pending" class="hidden"><div class="sides small" id="pendsides"></div>
        <div class="btn-row end"><button class="btn text" id="pclear">Clear</button><label class="btn tonal">${icon("add_a_photo")}<span id="pnext">Take back</span><input type="file" accept="image/*" capture="environment" class="hidden" id="cam2"></label><button class="btn filled" id="pdone">${icon("check")}Save card</button></div></div></div>
    <div id="queue"></div>`);
  const drop = $("#drop");
  S.pending = S.pending || [];
  const drawPending = () => {
    $("#pending").classList.toggle("hidden", !S.pending.length);
    $("#pendsides").innerHTML = S.pending.map((f, i) => `<div class="side"><div class="side-img"><img src="${URL.createObjectURL(f)}" alt=""></div><div class="side-cap"><span>${i === 0 ? "Front" : i === 1 ? "Back" : `Page ${i + 1}`}</span></div></div>`).join("");
    $("#pnext").textContent = S.pending.length === 1 ? "Take back" : "Add page";
  };
  const camTaken = (files) => {
    if (!$("#group").checked) return upload(files);
    S.pending.push(...files); drawPending();
    snack(S.pending.length === 1 ? "Front saved — now take the back" : "Page added");
  };
  $("#group").addEventListener("change", (e) => { S.groupMode = e.target.checked; store("cv_group", e.target.checked ? "1" : "0"); });
  $("#cam2").addEventListener("change", (e) => { camTaken([...e.target.files]); e.target.value = ""; });
  $("#pclear").addEventListener("click", () => { S.pending = []; drawPending(); });
  $("#pdone").addEventListener("click", () => { const f = S.pending; S.pending = []; drawPending(); upload(f, false, true); });
  drawPending();
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", async (e) => upload(await filesFromDrop(e.dataTransfer)));
  $("#cam").addEventListener("change", (e) => { camTaken([...e.target.files]); e.target.value = ""; });
  $("#pick").addEventListener("change", (e) => upload([...e.target.files], false, $("#group").checked && e.target.files.length > 1));
  $("#folder").addEventListener("change", (e) => upload([...e.target.files], true));
}

// Walk dropped folders (and sub-folders) to collect every file
async function filesFromDrop(dt) {
  const entries = [...(dt.items || [])].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (!entries.length) return [...dt.files];
  const out = [];
  const walk = async (entry) => {
    if (entry.isFile) { out.push(await new Promise((res, rej) => entry.file(res, rej))); return; }
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const child of batch) await walk(child);
    }
  };
  for (const en of entries) await walk(en);
  return out;
}

const OK_FILE = /\.(pdf|jpe?g|png|webp|heic|heif|xlsx|xlsm|csv)$/i;

async function upload(all, fromFolder = false, group = false) {
  if (!all.length) return;
  const maxBytes = (S.me.max_upload_mb || 25) * 1048576;
  const files = all.filter((f) => !f.name.startsWith(".") && (OK_FILE.test(f.name) || /^(image\/|application\/pdf)/.test(f.type)) && f.size <= maxBytes);
  const skipped = all.length - files.length;
  const q = $("#queue");
  if (!files.length) { snack(`No PDFs or photos found${skipped ? ` (${skipped} other file${skipped > 1 ? "s" : ""} skipped)` : ""}`, 5000); return; }
  const many = !group && (files.length > 3 || fromFolder);
  const stats = { added: [], dup: 0, failed: [] };
  const drawList = () => `<div class="section-title">Uploading</div><div class="list gap">${files.map((f) => `<div class="item"><div class="lead c-grey">${icon("hourglass_top")}</div>
    <div class="body"><div class="h">${esc(f.webkitRelativePath || f.name)}</div><div class="s">${(f.size / 1048576).toFixed(1)} MB</div><div class="progress"></div></div></div>`).join("")}</div>`;
  const drawSummary = (done) => `<div class="card tonal-primary"><div class="head">${icon(done >= files.length ? "task_alt" : "folder_open")}<div>
    <h3>${done >= files.length ? "Import finished" : `Importing ${done} of ${files.length}`}</h3>
    <p>${stats.added.length} added${stats.dup ? ` · ${stats.dup} already in CertVault` : ""}${stats.failed.length ? ` · ${stats.failed.length} failed` : ""}${skipped ? ` · ${skipped} skipped (not PDF/photo or too big)` : ""}</p></div></div>
    <div class="progress det"><span id="bar"></span></div>
    ${stats.failed.length ? `<p>${stats.failed.map((x) => esc(x)).join("<br>")}</p>` : ""}
    ${done >= files.length && stats.added.length ? `<div class="btn-row end"><a class="btn filled" href="#/">${icon("check")}Done</a></div>` : ""}</div>`;
  const setBar = (done) => { const b = $("#bar"); if (b) b.style.width = `${Math.round((done / files.length) * 100)}%`; };
  q.innerHTML = many ? drawSummary(0) : drawList();
  setBar(0);
  const BATCH = group ? 30 : 5;
  for (let i = 0; i < files.length; i += BATCH) {
    const chunk = files.slice(i, i + BATCH);
    const fd = new FormData();
    chunk.forEach((f) => fd.append("files", f, f.name));
    if (group) fd.append("group", "1");
    try {
      const res = await api("/api/documents", { method: "POST", body: fd });
      res.forEach((r) => { if (r.error) stats.failed.push(`${r.name}: ${r.error}`); else if (r.duplicate) stats.dup++; else if (!r.page) stats.added.push(r.id); });
    } catch (err) {
      chunk.forEach((f) => stats.failed.push(`${f.name}: ${err.message}`));
      if (/log in/i.test(err.message)) return;
    }
    if (many) { q.innerHTML = drawSummary(Math.min(i + BATCH, files.length)); setBar(Math.min(i + BATCH, files.length)); }
  }
  await loadDocs();
  if (!many) {
    stats.failed.forEach((m) => snack(m, 5000));
    if (stats.added.length === 1 && (files.length === 1 || group)) return void (location.hash = `#/doc/${stats.added[0]}`);
    if (stats.dup && !stats.added.length) snack("Already uploaded");
    if (stats.added.length) { snack(`${stats.added.length} files uploaded — reading them now`); location.hash = "#/"; }
    else q.innerHTML = "";
    return;
  }
  snack(`${stats.added.length} added — ${S.me.ai_enabled ? "AI is" : "CertVault is"} reading them now`, 5000);
}

// ---------- document detail ----------
async function viewDoc(id) {
  chrome(true, false);
  let d;
  try { d = await api(`/api/documents/${id}`); } catch (e) { return render(topbar("Not found", { back: true }) + `<div class="empty">${icon("error")}<p>${esc(e.message)}</p></div>`); }
  const [cls, , ic] = stateLabel(d);
  const big = d.status === "processing" ? "…" : d.days_left == null ? "" : Math.abs(d.days_left);
  const reg = d.kind === "register";
  const L = reg ? { done: "Last inspected", exp: "Next inspection due" } : { done: "Completed / issued", exp: "Expires" };
  const cdText = d.status === "processing" ? "Reading your document…"
    : reg && d.state === "expired" ? `days overdue — inspection was due ${fmtDate(d.expiry_date)}`
    : reg && d.days_left != null ? (d.days_left === 0 ? "Inspection due today!" : `days until next inspection · ${fmtDate(d.expiry_date)}`)
    : d.state === "expired" ? `days since it expired on ${fmtDate(d.expiry_date)}`
    : d.state === "none" ? "This one doesn't expire"
    : d.days_left == null ? "No expiry date found — add one so you get reminders"
    : d.days_left === 0 ? "Expires today!" : `days left · expires ${fmtDate(d.expiry_date)}`;
  const kv = (ico, lab, val, raw = false) => val ? `<div class="item"><div class="lead">${icon(ico)}</div><div class="body"><div class="s">${esc(lab)}</div><div class="h">${raw ? val : esc(val)}</div></div></div>` : "";
  const issuerTypes = { government: "Government", training: "Training provider", company: "Company / site", other: "Other" };
  const rem = d.reminder_days || "default";
  const older = (d.history || []).filter((h) => h.id !== d.id);
  const isSheet = ["xlsx", "csv"].includes(d.file_ext);
  const classes = (d.classes || "").split(/;\s*/).filter(Boolean);
  const tags = (d.tags || "").split(/,\s*/).filter(Boolean);
  const sides = [{ id: "main", label: d.pages && d.pages.length ? "Front" : "Document", thumb: d.has_thumb ? `/api/documents/${d.id}/thumb` : null, file: `/api/documents/${d.id}/file`, ext: d.file_ext },
    ...(d.pages || []).map((p) => ({ id: p.id, label: p.label, thumb: p.has_thumb ? `/api/documents/${d.id}/pages/${p.id}/thumb` : null, file: `/api/documents/${d.id}/pages/${p.id}/file`, ext: p.file_ext }))];

  let html = topbar(d.category_name, { back: true, actions: `
    <button class="icon-btn" id="share" aria-label="Share">${icon("share")}</button>
    <a class="icon-btn" href="#/doc/${d.id}/edit" aria-label="Edit">${icon("edit")}</a>
    <button class="icon-btn" id="more" aria-label="More options" aria-haspopup="menu">${icon("more_vert")}${older.length ? `<span class="dot">${older.length}</span>` : ""}</button>` });
  html += `<div class="menu hidden" id="menu" role="menu">
    <button role="menuitem" data-m="versions">${icon("history_edu")}<span>Previous / expired versions</span><span class="count">${older.length}</span></button>
    <button role="menuitem" data-m="share">${icon("share")}<span>Share / send to someone</span></button>
    <button role="menuitem" data-m="addside">${icon("flip")}<span>Add back / another page</span></button>
    <a role="menuitem" href="#/doc/${d.id}/edit">${icon("edit")}<span>Edit details</span></a>
    <button role="menuitem" data-m="rescan">${icon(S.me.ai_enabled ? "star_shine" : "refresh")}<span>${S.me.ai_enabled ? "Re-read with AI" : "Re-read"}</span></button>
    ${d.expiry_date ? `<a role="menuitem" href="/api/calendar.ics?ids=${d.id}">${icon("calendar_add_on")}<span>Add to my calendar</span></a>` : ""}
    <a role="menuitem" href="/api/share/zip?ids=${d.id}">${icon("folder_zip")}<span>Download all sides (ZIP)</span></a>
    ${d.versions > 1 || d.version_group === "solo" ? `<button role="menuitem" data-m="solo">${icon("category")}<span>${d.version_group === "solo" ? "Group with same-name copies" : "Not a renewal — keep separate"}</span></button>` : ""}
    <div class="menu-div"></div>
    <button role="menuitem" data-m="delete" class="danger">${icon("delete")}<span>Delete</span></button></div>`;
  if (d.superseded) html += `<div class="card"><div class="head">${icon("history_edu")}<div><h3>Previous version</h3>
    <p>A newer copy of this ticket is on file, so this one is kept for your records and won't send reminders.</p></div></div>
    <div class="btn-row end"><a class="btn filled" href="#/doc/${esc(d.current_id)}">Open current</a></div></div>`;
  html += `<div class="hero"><div class="lead c-${esc(d.color)}">${icon(d.icon, "lg")}</div><div><h2>${esc(d.title || "Untitled")}</h2><div class="s">${esc(d.issuer || d.category_name)}</div></div></div>`;
  if (d.status === "processing") html += `<div class="card tonal-primary"><div class="head">${icon(S.me.ai_enabled ? "star_shine" : "hourglass_top")}<div><h3>${S.me.ai_enabled ? "AI is reading this file" : "Reading this file"}</h3><p>This usually takes a few seconds${sides.length > 1 ? " — every side is read" : ""}.</p></div></div><div class="progress"></div></div>`;
  else if (d.status === "review") html += `<div class="card tonal-primary"><div class="head">${icon(d.extract_source && d.extract_source.startsWith("ai") ? "star_shine" : "edit")}<div><h3>Check these details</h3>
    <p>${d.extract_source && d.extract_source.startsWith("ai") ? "Filled in by AI" : "Filled in from OCR"} — confirm they're right or tap edit.</p></div></div>
    <div class="btn-row end"><a class="btn text" href="#/doc/${d.id}/edit">Edit</a><button class="btn filled" id="confirm">${icon("check")}Looks right</button></div></div>`;
  if (d.extract_error) html += `<div class="card warn"><div class="head">${icon("warning")}<p>${esc(d.extract_error)}</p></div></div>`;
  html += `<div class="countdown ${cls}">${big !== "" ? `<div class="big">${big}</div>` : icon(ic, "xl")}<div class="s">${esc(cdText)}${d.expiry_estimated ? "<br><b>Estimated</b> from typical validity — check your card" : ""}</div></div>`;
  // sides gallery
  html += `<div class="section-title">${sides.length > 1 ? `${sides.length} sides / pages` : "File"}</div><div class="sides">
    ${sides.map((sd) => `<div class="side"><a href="${sd.file}" target="_blank" rel="noopener" class="side-img">${sd.thumb ? `<img src="${sd.thumb}" alt="${esc(sd.label)}" loading="lazy">` : `<div class="side-ph">${icon(isSheet && sd.id === "main" ? "table_view" : "description", "xl")}<span>${esc((sd.ext || "").toUpperCase())}</span></div>`}</a>
      <div class="side-cap"><span>${esc(sd.label)}</span>${sd.id !== "main" ? `<button class="icon-btn sm" data-delpage="${sd.id}" aria-label="Remove ${esc(sd.label)}">${icon("close", "sm")}</button>` : ""}</div></div>`).join("")}
    <label class="side add"><div class="side-img"><div class="side-ph">${icon("add_a_photo", "xl")}<span>${sides.length > 1 ? "Add page" : "Add back"}</span></div></div>
      <input type="file" accept="image/*,application/pdf,.heic,.heif" capture="environment" class="hidden" id="addside"></label>
  </div>`;
  html += `<div class="list gap kv">
    ${kv("category", "Type", d.category_name)}
    ${kv("apartment", "Issued by", d.issuer ? d.issuer + (d.issuer_type ? ` · ${issuerTypes[d.issuer_type] || d.issuer_type}` : "") : null)}
    ${kv("person", "Holder", d.holder_name)}
    ${kv("tag", "Number", d.licence_number)}
    ${kv("license", reg ? "Covers" : "Classes / endorsements", classes.length ? `<div class="class-list">${classes.map((c) => { const [code, ...rest] = c.split(" – "); return `<div class="class-row"><span class="code">${esc(code)}</span><span>${esc(rest.join(" – ") || "")}</span></div>`; }).join("")}</div>` : null, true)}
    ${kv("event_available", L.done, d.completion_date ? fmtDate(d.completion_date) : null)}
    ${kv("event", L.exp, d.expiry_date ? fmtDate(d.expiry_date) + (d.expiry_estimated ? " (estimated)" : "") : d.no_expiry ? "Doesn't expire" : "Not set")}
    ${kv("location_on", "Location", d.location)}
    ${kv("school", "RTO / provider code", d.rto_code)}
    ${kv("work", "Required for", d.required_for)}
    ${kv("autorenew", "How to renew", d.renewal_info)}
    ${kv("payments", "Cost", d.cost)}
    ${kv("sell", "Tags", tags.length ? `<div class="tag-row">${tags.map((t) => `<a class="chip none" href="#/all?q=${encodeURIComponent(t)}">${esc(t)}</a>`).join("")}</div>` : null, true)}
    ${kv("description", "Notes", d.notes)}
    ${kv("notifications", "Reminders", rem === "default" ? "Default schedule" : rem.split(",").map((x) => x === "0" ? "on the day" : `${x}d`).join(", ") + " before")}
  </div>
  <div class="btn-row">
    <button class="btn filled" id="share2">${icon("share")}Share</button>
    <a class="btn outlined" href="/api/documents/${d.id}/file?download=1">${icon("download")}Download</a>
    ${d.expiry_date ? `<a class="btn outlined" href="/api/calendar.ics?ids=${d.id}">${icon("calendar_add_on")}Calendar</a>` : ""}
  </div>`;
  if (d.shares && d.shares.length) html += `<div class="section-title">Shared</div><div class="list gap kv">${d.shares.map((s) => `<div class="item"><div class="lead">${icon(s.method === "email" ? "mail" : s.method === "zip" ? "folder_zip" : "share")}</div>
    <div class="body"><div class="h">${esc(s.recipient || { phone: "Sent from phone", zip: "Downloaded ticket pack", copy: "Copied details" }[s.method] || s.method)}</div><div class="s">${esc(fmtDateTime(s.created_at))}</div></div></div>`).join("")}</div>`;
  html += `<div class="meta">${esc(d.original_name || "")} · ${(d.size / 1048576).toFixed(2)} MB · uploaded ${fmtDate((d.created_at || "").slice(0, 10))}${d.extract_source ? ` · read by ${esc(d.extract_source.replace("ai:", "AI "))}` : ""}</div>`;
  if (d.ai_text || d.ocr_text) {
    html += `<details id="txt"><summary>${icon("description", "sm")} Show document text</summary>
      ${d.ai_text ? `<div class="seg small" id="txtseg"><button type="button" class="on" data-t="ai">${icon("star_shine", "sm")}AI transcript</button><button type="button" data-t="ocr">Raw scan</button></div>` : `<p class="hint-p">Raw OCR scan${S.me.ai_enabled ? "" : " — turn on AI in Settings for a clean transcript"}.</p>`}
      <pre class="ocr" id="txtbody">${esc(d.ai_text || d.ocr_text || "")}</pre></details>`;
  }
  render(html);

  $("#confirm") && $("#confirm").addEventListener("click", async () => { await api(`/api/documents/${d.id}`, { method: "PATCH", body: {} }); await loadDocs(); snack("Saved"); viewDoc(id); });
  const menu = $("#menu");
  $("#more").addEventListener("click", (e) => { e.stopPropagation(); menu.classList.toggle("hidden"); });
  const doRescan = async () => { await api(`/api/documents/${d.id}/rescan`, { method: "POST" }); await loadDocs(); viewDoc(id); };
  const doDelete = async () => {
    if (!(await confirmDlg("Delete document?", `“${d.title}” and all its sides/pages will be permanently removed.`))) return;
    await api(`/api/documents/${d.id}`, { method: "DELETE" }); await loadDocs(); snack("Deleted"); location.hash = "#/all";
  };
  $$("[data-m]", menu).forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation(); menu.classList.add("hidden");
    const m = b.dataset.m;
    if (m === "versions") return showVersions(d);
    if (m === "share") return shareSheet([d]);
    if (m === "addside") return $("#addside").click();
    if (m === "rescan") return doRescan();
    if (m === "delete") return doDelete();
    if (m === "solo") {
      await api(`/api/documents/${d.id}`, { method: "PATCH", body: { version_group: d.version_group === "solo" ? null : "solo" } });
      await loadDocs(); snack(d.version_group === "solo" ? "Grouped with its other versions" : "Kept as a separate ticket"); viewDoc(id);
    }
  }));
  $("#share").addEventListener("click", () => shareSheet([d]));
  $("#share2").addEventListener("click", () => shareSheet([d]));
  $("#addside").addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const fd = new FormData(); fd.append("file", f, f.name); fd.append("label", sides.length === 1 ? "Back" : `Page ${sides.length + 1}`);
    snack(`Uploading ${sides.length === 1 ? "back" : "page"}…`);
    try { await api(`/api/documents/${d.id}/pages`, { method: "POST", body: fd }); await loadDocs(); snack("Added — re-reading every side"); viewDoc(id); } catch (err) { snack(err.message, 5000); }
  });
  $$("[data-delpage]").forEach((b) => b.addEventListener("click", async (e) => {
    e.preventDefault();
    if (!(await confirmDlg("Remove this side?", "The image/page will be deleted from this document."))) return;
    await api(`/api/documents/${d.id}/pages/${b.dataset.delpage}`, { method: "DELETE" }); snack("Removed"); viewDoc(id);
  }));
  $$("#txtseg button").forEach((b) => b.addEventListener("click", () => {
    $$("#txtseg button").forEach((x) => x.classList.toggle("on", x === b));
    $("#txtbody").textContent = b.dataset.t === "ai" ? d.ai_text : (d.ocr_text || "(no raw scan text)");
  }));
  if (d.status === "processing") { clearTimeout(S.docPoll); S.docPoll = setTimeout(() => { if (location.hash === `#/doc/${id}`) viewDoc(id); }, 2500); }
}

// ---------- sharing ----------
async function shareSheet(docs) {
  const ids = docs.map((x) => x.id);
  const one = docs.length === 1;
  const name = one ? `“${docs[0].title}”` : `${docs.length} documents`;
  const canPhone = !!(navigator.canShare && window.isSecureContext);
  let recent = [];
  try { recent = await api("/api/share/recent"); } catch (e) { /* ignore */ }
  const dl = dialog(`<h2>Share ${esc(name)}</h2>
    <div class="share-opts">
      <button class="share-opt" id="sh-phone" ${canPhone ? "" : "disabled"}>${icon("share")}<span>Phone apps</span><small>${canPhone ? "WhatsApp, Gmail, Messages…" : "Needs HTTPS (see README)"}</small></button>
      <button class="share-opt" id="sh-mail">${icon("mail")}<span>Email it</span><small>Sent from CertVault with files attached</small></button>
      <a class="share-opt" id="sh-zip" href="/api/share/zip?ids=${ids.join(",")}">${icon("folder_zip")}<span>Ticket pack</span><small>ZIP of files + summary</small></a>
      <button class="share-opt" id="sh-copy">${icon("content_copy")}<span>Copy details</span><small>Paste into any message</small></button>
    </div>
    <form class="form flush hidden" id="mailf">
      <div class="field"><label>To</label><input name="to" type="email" multiple required placeholder="name@company.com.au" autocomplete="email">
        ${recent.length ? `<div class="chips wrap">${recent.map((r) => `<button type="button" class="fchip" data-r="${esc(r)}">${esc(r)}</button>`).join("")}</div>` : ""}</div>
      <div class="field"><label>CC (optional)</label><input name="cc" type="email" multiple></div>
      <div class="field"><label>Message</label><textarea name="message" placeholder="Hi, here are my tickets for the job on Monday."></textarea></div>
      <div class="switch-row"><div class="body">Attach the files<div class="s">Every side/page of ${one ? "this document" : "each document"}</div></div><input type="checkbox" class="switch" name="attach_files" checked></div>
      <div class="switch-row"><div class="body">Attach a summary spreadsheet</div><input type="checkbox" class="switch" name="attach_list" ${one ? "" : "checked"}></div>
      <div class="btn-row"><button type="button" class="btn text" data-close>Cancel</button><button class="btn filled">${icon("send")}Send</button></div>
    </form>
    <div class="btn-row" id="sh-close"><button class="btn text" data-close>Close</button></div>`);
  $("#sh-mail", dl).addEventListener("click", () => { $("#mailf", dl).classList.remove("hidden"); $(".share-opts", dl).classList.add("hidden"); $("#sh-close", dl).classList.add("hidden"); $("[name=to]", dl).focus(); });
  $$("[data-r]", dl).forEach((b) => b.addEventListener("click", () => { const i = $("[name=to]", dl); i.value = i.value ? `${i.value}, ${b.dataset.r}` : b.dataset.r; }));
  $("#mailf", dl).addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const btn = $("button.filled", e.target); btn.disabled = true; btn.textContent = "Sending…";
    try {
      const r = await api("/api/share/email", { method: "POST", body: { ids, to: f.get("to"), cc: f.get("cc"), message: f.get("message"), attach_files: !!f.get("attach_files"), attach_list: !!f.get("attach_list") } });
      dl.close(); snack(`Sent to ${r.sent_to}`, 4000); if (one && location.hash.startsWith("#/doc/")) viewDoc(ids[0]);
    } catch (err) { snack(err.message, 7000); btn.disabled = false; btn.innerHTML = `${icon("send")}Send`; }
  });
  $("#sh-zip", dl).addEventListener("click", () => setTimeout(() => dl.close(), 300));
  $("#sh-copy", dl).addEventListener("click", async () => {
    const { text } = await api(`/api/share/text?ids=${ids.join(",")}`);
    copyText(text); snack("Details copied — paste them into any message");
    api("/api/share/log", { method: "POST", body: { ids, method: "copy" } }).catch(() => {});
    dl.close();
  });
  $("#sh-phone", dl).addEventListener("click", async () => {
    try {
      snack("Preparing files…");
      const { text } = await api(`/api/share/text?ids=${ids.join(",")}`);
      const files = [];
      for (const x of docs) {
        const full = x.pages ? x : await api(`/api/documents/${x.id}`);
        const urls = [[`/api/documents/${x.id}/file`, x.file_ext, "front"], ...(full.pages || []).map((p) => [`/api/documents/${x.id}/pages/${p.id}/file`, p.file_ext, p.label])];
        for (const [u, ext, lab] of urls) {
          const b = await (await fetch(u, { credentials: "same-origin" })).blob();
          files.push(new File([b], `${(x.title || "document").replace(/[^\w\- ]+/g, "_")}${urls.length > 1 ? ` - ${lab}` : ""}.${ext}`, { type: b.type }));
        }
      }
      const payload = { title: one ? docs[0].title : "My licences & tickets", text, files };
      if (!navigator.canShare(payload)) delete payload.files;
      await navigator.share(payload);
      api("/api/share/log", { method: "POST", body: { ids, method: "phone" } }).catch(() => {});
      dl.close();
    } catch (err) { if (err.name !== "AbortError") snack(err.message, 5000); }
  });
}

function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const ta = document.createElement("textarea");
  ta.value = text; ta.setAttribute("readonly", ""); ta.className = "offscreen";
  document.body.append(ta); ta.select(); document.execCommand("copy"); ta.remove();
}

function fmtDateTime(utc) {
  if (!utc) return "";
  const d = new Date(utc.replace(" ", "T") + "Z");
  return d.toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function showVersions(d) {
  const hist = d.history || [d];
  const row = (h) => `<a class="item" href="#/doc/${h.id}" data-close>${h.id === d.id ? `<div class="lead c-${esc(h.color)}">${icon("check")}</div>` : `<div class="lead c-grey">${icon("history_edu")}</div>`}
    <div class="body"><div class="h">${esc(h.title || "Untitled")}${h.superseded ? "" : " · current"}</div>
    <div class="s">${h.completion_date ? (h.kind === "register" ? "Inspected " : "Done ") + fmtDate(h.completion_date) : ""}${h.expiry_date ? ` → ${fmtDate(h.expiry_date)}` : ""}${h.issuer ? ` · ${esc(h.issuer)}` : ""}</div></div>
    <div class="trail">${chip(h)}</div></a>`;
  const dl = dialog(`<h2>All versions</h2>
    <p>${hist.length > 1 ? `${hist.length} copies of this ticket on file — newest first. Only the newest one sends reminders.` : "There are no older or expired copies of this ticket yet. Upload a renewed certificate and they'll be grouped here automatically."}</p>
    <div class="list gap">${hist.map(row).join("")}</div><div class="spacer"></div>
    <div class="btn-row"><a class="btn tonal" href="#/add" data-close>${icon("add")}Add renewal</a><button class="btn text" data-close>Close</button></div>`);
  $$("a[data-close]", dl).forEach((a) => a.addEventListener("click", () => dl.close()));
}

const HRWL = { SB: "Basic scaffolding", SI: "Intermediate scaffolding", SA: "Advanced scaffolding", DG: "Dogging", RB: "Basic rigging",
  RI: "Intermediate rigging", RA: "Advanced rigging", CT: "Tower crane", CS: "Self-erecting tower crane", CD: "Derrick crane", CP: "Portal boom crane",
  CB: "Bridge and gantry crane", CV: "Vehicle loading crane (10 metre-tonnes or more)", CN: "Non-slewing mobile crane (over 3 t)",
  C2: "Slewing mobile crane (up to 20 t)", C6: "Slewing mobile crane (up to 60 t)", C1: "Slewing mobile crane (up to 100 t)",
  C0: "Slewing mobile crane (over 100 t)", PB: "Concrete placing boom", HM: "Materials hoist", HP: "Personnel and materials hoist",
  WP: "Boom-type elevating work platform (boom 11 m or more)", LF: "Forklift truck", LO: "Order-picking forklift truck", RS: "Reach stacker (over 3 t)",
  BS: "Standard boiler operation", BA: "Advanced boiler operation", TO: "Turbine operation", ES: "Reciprocating steam engine operation" };
const DLC = { C: "Car (up to 4.5 t GVM, 12 seats)", LR: "Light rigid", MR: "Medium rigid", HR: "Heavy rigid", HC: "Heavy combination", MC: "Multi-combination", R: "Motorcycle", "R-E": "Motorcycle (LAMS)", F: "Tractor / farm vehicle" };

// "CV, DG\nRB" -> "CV – Vehicle loading crane…; DG – Dogging; RB – Basic rigging"
function expandClasses(raw, cat) {
  const map = cat === "hrwl" ? HRWL : cat === "drivers_licence" ? DLC : null;
  const parts = raw.split(/[\n;]+/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const codes = map && p.split(/[\s,/]+/).every((t) => map[t.toUpperCase()]) ? p.split(/[\s,/]+/) : [p];
    for (const c of codes) {
      const up = c.toUpperCase();
      out.push(map && map[up] && !c.includes("–") ? `${up} – ${map[up]}` : c);
    }
  }
  return [...new Set(out)].join("; ");
}

async function viewEdit(id) {
  chrome(false);
  const d = await api(`/api/documents/${id}`);
  const opt = (v, l, cur) => `<option value="${esc(v)}" ${v === (cur || "") ? "selected" : ""}>${esc(l)}</option>`;
  render(topbar("Edit details", { back: true }) + `
    <form class="form" id="f">
      <div class="field"><label>Title</label><input name="title" value="${esc(d.title)}" maxlength="300"></div>
      <div class="field"><label>Type</label><select name="category">${S.cats.map((c) => opt(c.id, c.name, d.category || "other")).join("")}</select></div>
      <div class="row2">
        <div class="field"><label>Issued by</label><input name="issuer" value="${esc(d.issuer)}" placeholder="e.g. WA Department of Transport"></div>
        <div class="field"><label>Issuer type</label><select name="issuer_type">${opt("", "—", d.issuer_type)}${opt("government", "Government", d.issuer_type)}${opt("training", "Training provider", d.issuer_type)}${opt("company", "Company / site", d.issuer_type)}${opt("other", "Other", d.issuer_type)}</select></div>
      </div>
      <div class="row2">
        <div class="field"><label>Holder name</label><input name="holder_name" value="${esc(d.holder_name)}" autocomplete="off"></div>
        <div class="field"><label>Licence / cert number</label><input name="licence_number" value="${esc(d.licence_number)}" autocomplete="off"></div>
      </div>
      <div class="row2">
        <div class="field"><label id="l-done">${(S.catById[d.category] || {}).kind === "register" ? "Last inspected" : "Completed / issued"}</label><input type="date" name="completion_date" value="${esc(d.completion_date)}"></div>
        <div class="field ${d.expiry_estimated ? "warn" : ""}"><label id="l-exp">${(S.catById[d.category] || {}).kind === "register" ? "Next inspection due" : "Expiry date"}</label><input type="date" name="expiry_date" id="exp" value="${esc(d.expiry_date)}">${d.expiry_estimated ? '<div class="hint">Estimated — check your card</div>' : ""}</div>
      </div>
      <div class="switch-row"><div class="body">Doesn't expire<div class="s">No reminders for this one</div></div><input type="checkbox" class="switch" name="no_expiry" ${d.no_expiry ? "checked" : ""}></div>
      <div class="field"><label>Classes / endorsements / units</label><textarea name="classes" maxlength="1000" placeholder="e.g. CV – Vehicle loading crane; DG – Dogging; RB – Basic rigging">${esc((d.classes || "").split(/;\s*/).join("\n"))}</textarea><div class="hint">One per line. For a HRWL just type the codes (CV, DG, RB…) — they're spelled out for you.</div></div>
      <div class="row2">
        <div class="field"><label>Location / venue</label><input name="location" value="${esc(d.location)}"></div>
        <div class="field"><label>RTO / provider code</label><input name="rto_code" value="${esc(d.rto_code)}" inputmode="numeric"></div>
      </div>
      <div class="field"><label>Required for (clients / sites)</label><input name="required_for" value="${esc(d.required_for)}" placeholder="e.g. Telstra sites, FEC, Roy Hill"></div>
      <div class="field"><label>How to renew</label><textarea name="renewal_info" maxlength="1000" placeholder="Provider, phone, website, course length, refresher only?">${esc(d.renewal_info)}</textarea></div>
      <div class="row2">
        <div class="field"><label>Cost</label><input name="cost" value="${esc(d.cost)}" placeholder="$"></div>
        <div class="field"><label>Tags</label><input name="tags" value="${esc(d.tags)}" placeholder="e.g. telco, heights, client-required"></div>
      </div>
      <div class="field"><label>Notes</label><textarea name="notes" maxlength="4000">${esc(d.notes)}</textarea></div>
      <div class="field"><label>Reminder days for this document</label><input name="reminder_days" value="${esc(d.reminder_days)}" placeholder="Default (from Settings)" inputmode="numeric"><div class="hint">Comma separated, e.g. 60,30,14,7,0 — leave blank to use your default</div></div>
      <div class="btn-row end"><button type="button" class="btn text" data-back>Cancel</button><button class="btn filled">${icon("check")}Save</button></div>
    </form>`);
  $("[name=category]").addEventListener("change", (e) => {
    const r = (S.catById[e.target.value] || {}).kind === "register";
    $("#l-done").textContent = r ? "Last inspected" : "Completed / issued";
    $("#l-exp").textContent = r ? "Next inspection due" : "Expiry date";
  });
  $("#f").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const body = { ...f, no_expiry: !!f.no_expiry };
    body.classes = expandClasses(f.classes || "", f.category);
    if (body.expiry_date !== (d.expiry_date || "")) body.expiry_estimated = false;
    try { await api(`/api/documents/${id}`, { method: "PATCH", body }); await loadDocs(); snack("Saved"); history.back(); } catch (err) { snack(err.message); }
  });
}

// ---------- master list (text only, every field) ----------
async function viewList() {
  chrome(true, false);
  const m = await api("/api/master");
  const cols = m.columns.filter((c) => c !== "ID");
  const dateCols = new Set(["Completed / last inspected", "Expiry / next due"]);
  const fmtCell = (c, v) => {
    if (v == null || v === "") return "";
    if (dateCols.has(c)) return fmtDate(String(v).slice(0, 10));
    if (c === "Uploaded" || c === "Last updated") return fmtDate(String(v).slice(0, 10));
    return String(v);
  };
  const exp = m.rows.filter((r) => r._state === "expired").length, soon = m.rows.filter((r) => r._state === "soon").length;
  render(topbar("Master list", { actions: `<button class="icon-btn" id="print" aria-label="Print">${icon("print")}</button>` }) + `
    <div class="subtitle">${m.rows.length} documents · ${exp} expired · ${soon} due within 30 days</div>
    <div class="btn-row noprint">
      <a class="btn filled" href="/api/master.xlsx">${icon("download")}Excel</a>
      <a class="btn outlined" href="/api/master.csv">${icon("download")}CSV</a>
      <button class="btn tonal" id="mshare">${icon("share")}Send ticket pack</button>
      <a class="btn text" href="/api/calendar.ics">${icon("calendar_add_on")}All to calendar</a>
    </div>
    <label class="search noprint">${icon("search")}<input id="mq" type="search" placeholder="Filter the list"></label>
    <div class="table-wrap"><table class="master" id="mt">
      <thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
      <tbody>${m.rows.map((r) => `<tr class="st-${esc(r._state)} ${r.Version === "Previous" ? "old" : ""}" data-id="${esc(r.ID)}">${cols.map((c) => `<td>${esc(fmtCell(c, r[c]))}</td>`).join("")}</tr>`).join("")}</tbody>
    </table></div>
    ${m.rows.length ? "" : `<div class="empty">${icon("list_alt")}<p>Nothing uploaded yet.</p></div>`}
    <div class="meta">An always-up-to-date copy is saved on the NAS in the <b>exports</b> folder of the CertVault dataset.</div>`);
  $("#print").addEventListener("click", () => window.print());
  $("#mshare").addEventListener("click", () => shareSheet(S.docs.filter((d) => !d.superseded && d.status !== "processing" && d.state !== "expired")));
  $("#mq").addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase();
    $$("#mt tbody tr").forEach((tr) => tr.classList.toggle("hidden", !!q && !tr.textContent.toLowerCase().includes(q)));
  });
  $$("#mt tbody tr").forEach((tr) => tr.addEventListener("click", () => (location.hash = `#/doc/${tr.dataset.id}`)));
}

// ---------- settings ----------
async function viewSettings() {
  chrome(true, false);
  const st = await api("/api/settings");
  const u = st.user, g = st.global;
  const admin = S.me.is_admin;
  const days = u.reminder_days.split(",").filter(Boolean);
  const theme = store("cv_theme") || "system", accent = store("cv_accent") || "blue";
  const field = (scope, k, label, { type = "text", ph = "", hint = "", v } = {}) => `<div class="field"><label>${esc(label)}</label>
    <input data-scope="${scope}" name="${k}" type="${type}" value="${esc(v ?? (scope === "g" ? g[k] : u[k]))}" placeholder="${esc(ph)}" autocomplete="off">${hint ? `<div class="hint">${hint}</div>` : ""}</div>`;
  let html = topbar("Settings");
  html += `<div class="section-title">Reminders</div><div class="card">
    <p>Get notified this many days before something expires (0 = on the day):</p>
    <div class="chips" id="days">${days.map((x) => `<button class="fchip on" data-d="${esc(x)}">${x === "0" ? "On the day" : x + " days"}${icon("close")}</button>`).join("")}</div>
    <div class="row2"><div class="field"><label>Add days</label><input id="newday" type="number" min="0" max="730" inputmode="numeric" placeholder="e.g. 60"></div>
    <div class="field"><label>&nbsp;</label><button class="btn tonal block" id="addday">${icon("add")}Add</button></div></div>
    <div class="spacer"></div>
    <div class="switch-row"><div class="body">Keep reminding weekly after expiry</div><input type="checkbox" class="switch" id="weekly" ${u.remind_expired_weekly === "1" ? "checked" : ""}></div>
    ${admin ? `<div class="spacer"></div><div class="row2"><div class="field"><label>Daily check time</label><select data-scope="g" name="notify_hour">${[...Array(24).keys()].map((h) => `<option value="${h}" ${String(h) === String(g.notify_hour) ? "selected" : ""}>${(h % 12 || 12)}:00 ${h < 12 ? "am" : "pm"}</option>`).join("")}</select></div>
      <div class="field"><label>&nbsp;</label><button class="btn outlined block" id="runcheck">${icon("refresh")}Check now</button></div></div>
      <div class="hint">${g.last_check ? "Last checked " + esc(g.last_check.replace("T", " ").slice(0, 16)) : "Not checked yet"}</div>` : ""}
  </div>`;
  html += `<div class="section-title">Your details</div><div class="card"><div class="form flush">
    <p>Used as the signature and reply-to address when you share documents.</p>
    <div class="row2">${field("u", "full_name", "Full name", { ph: "Connor Moyle" })}${field("u", "company", "Business", { ph: "CME (Connor Moyle Engineering)" })}</div>
    <div class="row2">${field("u", "phone", "Phone", { type: "tel", ph: "04xx xxx xxx" })}${field("u", "my_email", "Your email (replies go here)", { type: "email" })}</div>
    <div class="btn-row end"><button class="btn filled" id="savep">Save</button></div></div></div>`;
  html += `<div class="section-title">Notifications</div><div class="card"><div class="form flush">
    ${field("u", "ntfy_url", "ntfy topic URL (phone push)", { ph: "https://ntfy.sh/certvault-xxxx", hint: 'Install the <b>ntfy</b> app from the Play Store and subscribe to the same topic. <button class="btn text" type="button" id="gentopic">Make a private topic</button>' })}
    ${field("u", "ntfy_token", "ntfy access token (optional)", { type: "password" })}
    ${field("u", "email_to", "Email reminders to", { type: "email", ph: "you@example.com", hint: admin ? "Needs the email server set below" : "" })}
    ${field("u", "ha_webhook_url", "Home Assistant webhook (optional)", { ph: "http://192.168.0.50:8123/api/webhook/certvault", hint: "Sends {title, message, url} — point an automation at notify.mobile_app_…" })}
    <div class="btn-row end"><button class="btn outlined" id="testn">${icon("send")}Send test</button><button class="btn filled" id="saven">Save</button></div></div></div>`;
  if (admin) {
    html += `<div class="section-title">AI document reading</div><div class="card"><div class="form flush">
      <p>${icon("star_shine", "sm")} AI looks at every photo/PDF you upload and fills in the type, issuer, dates, number and location.</p>
      <div class="seg" id="prov">${[["none", "Off"], ["anthropic", "Claude"], ["ollama", "Ollama (local)"]].map(([k, l]) => `<button type="button" data-p="${k}" class="${g.ai_provider === k ? "on" : ""}">${esc(l)}</button>`).join("")}</div>
      <input type="hidden" data-scope="g" name="ai_provider" value="${esc(g.ai_provider)}">
      <div id="p-anthropic" class="${g.ai_provider === "anthropic" ? "" : "hidden"}">
        ${field("g", "anthropic_api_key", "Anthropic API key", { type: "password", ph: "sk-ant-…", hint: "From console.anthropic.com → API keys. Costs a cent or two per document." })}
        ${field("g", "anthropic_model", "Model", { ph: "claude-sonnet-5-5" })}
      </div>
      <div id="p-ollama" class="${g.ai_provider === "ollama" ? "" : "hidden"}">
        ${field("g", "ollama_url", "Ollama URL", { ph: "http://192.168.0.x:11434", hint: "Your desktop's Ollama (fastest with the GPU) or the NAS Ollama app. Must be reachable from the NAS." })}
        ${field("g", "ollama_model", "Vision model", { ph: "qwen2.5vl:7b", hint: "Must be a vision model, e.g. <b>qwen2.5vl:7b</b> or <b>gemma3:12b</b>. Run <code>ollama pull qwen2.5vl:7b</code>" })}
      </div>
      <div class="btn-row end"><button class="btn outlined" id="testai">${icon("smart_toy")}Test</button><button class="btn filled" id="saveai">Save</button></div>
      <button class="btn tonal block" id="rescanall">${icon("star_shine")}Re-read all documents</button>
      <div class="hint">Fills in any blank fields on every document you've uploaded.</div></div></div>`;
    html += `<div class="section-title">Email server (SMTP)</div><div class="card"><div class="form flush">
      <div class="row2">${field("g", "smtp_host", "Server", { ph: "smtp.gmail.com" })}${field("g", "smtp_port", "Port", { ph: "587", type: "number" })}</div>
      ${field("g", "smtp_user", "Username", { ph: "you@gmail.com" })}
      ${field("g", "smtp_pass", "Password", { type: "password", hint: "For Gmail use an App Password (Google account → Security → App passwords)" })}
      ${field("g", "smtp_from", "From address (optional)")}
      ${field("g", "public_url", "Link to this app (for notification taps)", { ph: "http://192.168.0.50:30090" })}
      <div class="btn-row end"><button class="btn filled" id="saveg">Save</button></div></div></div>`;
  }
  html += `<div class="section-title">Appearance</div><div class="card"><div class="form flush">
    <div class="seg" id="theme">${[["system", "System"], ["light", "Light"], ["dark", "Dark"]].map(([k, l]) => `<button type="button" data-t="${k}" class="${theme === k ? "on" : ""}">${esc(l)}</button>`).join("")}</div>
    <div class="swatches" id="acc">${["blue", "green", "teal", "purple", "orange"].map((a) => `<button type="button" class="swatch ${a} ${accent === a ? "on" : ""}" data-a="${a}" aria-label="${a}">${icon("check")}</button>`).join("")}</div>
    <div class="switch-row"><div class="body">Show photo thumbnails in lists</div><input type="checkbox" class="switch" id="thumbs" ${S.showThumbs ? "checked" : ""}></div></div></div>`;
  html += `<div class="section-title">Account</div><div class="list gap">
    <div class="item" id="pw"><div class="lead c-grey">${icon("key")}</div><div class="body"><div class="h">Change password</div><div class="s">Signed in as ${esc(S.me.username)}</div></div></div>
    <div class="item" id="totp"><div class="lead c-grey">${icon("shield_lock")}</div><div class="body"><div class="h">2-step verification</div><div class="s">${S.me.totp_enabled ? "On — authenticator app" : "Off — recommended if you open this outside home"}</div></div></div>
    <div class="item" id="act"><div class="lead c-grey">${icon("history_edu")}</div><div class="body"><div class="h">Activity log</div><div class="s">Logins, uploads, edits and shares</div></div></div>
    <div class="item" id="others"><div class="lead c-grey">${icon("logout")}</div><div class="body"><div class="h">Log out other devices</div></div></div>
    ${admin ? `<div class="item" id="users"><div class="lead c-grey">${icon("group")}</div><div class="body"><div class="h">Users</div><div class="s">Add family or crew members — each sees only their own documents</div></div></div>` : ""}
    <div class="item" id="logout"><div class="lead c-red">${icon("logout")}</div><div class="body"><div class="h">Log out</div></div></div></div>
    <div class="meta">CertVault v${esc(S.version || "")} · files stay on your NAS</div>`;
  render(html);

  // reminders
  const saveUser = async (obj) => { await api("/api/settings", { method: "PUT", body: { user: obj } }); };
  const setDays = async (list) => { await saveUser({ reminder_days: list.join(",") }); viewSettings(); };
  $$("#days .fchip").forEach((b) => b.addEventListener("click", () => { const rest = days.filter((x) => x !== b.dataset.d); if (!rest.length) return snack("Keep at least one reminder"); setDays(rest); }));
  $("#addday").addEventListener("click", () => { const v = $("#newday").value; if (v === "" || +v < 0 || +v > 730) return snack("Enter 0–730 days"); setDays([...days, String(+v)]); });
  $("#weekly").addEventListener("change", (e) => saveUser({ remind_expired_weekly: e.target.checked ? "1" : "0" }).then(() => snack("Saved")));
  if (admin) {
    $("[name=notify_hour]").addEventListener("change", (e) => api("/api/settings", { method: "PUT", body: { global: { notify_hour: e.target.value } } }).then(() => snack("Saved")));
    $("#runcheck").addEventListener("click", async () => { const r = await api("/api/settings/run-check", { method: "POST" }); snack(`Check done — ${r.sent} reminder(s) sent`); });
  }
  // notifications
  const collect = (scope, root) => Object.fromEntries($$(`[data-scope="${scope}"]`, root).map((i) => [i.name, i.value]));
  const ncard = $("#saven").closest(".card");
  $("#gentopic").addEventListener("click", () => {
    const rnd = [...crypto.getRandomValues(new Uint8Array(9))].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 16);
    $("[name=ntfy_url]").value = `https://ntfy.sh/certvault-${rnd}`;
    snack("Private topic created — save, then subscribe to it in the ntfy app");
  });
  $("#savep").addEventListener("click", async (e) => { try { await saveUser(collect("u", e.target.closest(".card"))); snack("Saved"); } catch (er) { snack(er.message); } });
  $("#act").addEventListener("click", async () => {
    const rows = await api("/api/activity");
    dialog(`<h2>Activity</h2><div class="list gap act">${rows.length ? rows.map((r) => `<div class="item"><div class="body">
      <div class="h">${esc(r.action)}${S.me.is_admin && r.username ? ` · ${esc(r.username)}` : ""}</div>
      <div class="s">${esc(fmtDateTime(r.ts))}${r.ip ? ` · ${esc(r.ip)}` : ""}${r.detail ? ` · ${esc(r.detail)}` : ""}</div></div></div>`).join("") : "<p>Nothing yet.</p>"}</div>
      <div class="spacer"></div><div class="btn-row"><button class="btn text" data-close>Close</button></div>`);
  });
  $("#saven").addEventListener("click", async () => { try { await saveUser(collect("u", ncard)); snack("Saved"); } catch (e) { snack(e.message); } });
  $("#testn").addEventListener("click", async () => {
    try { await saveUser(collect("u", ncard)); const r = await api("/api/settings/test-notify", { method: "POST" }); snack(`Test sent via ${r.sent.join(", ")}`); } catch (e) { snack(e.message, 6000); }
  });
  if (admin) {
    const acard = $("#saveai").closest(".card");
    $$("#prov button").forEach((b) => b.addEventListener("click", () => {
      $$("#prov button").forEach((x) => x.classList.toggle("on", x === b));
      $("[name=ai_provider]").value = b.dataset.p;
      $("#p-anthropic").classList.toggle("hidden", b.dataset.p !== "anthropic");
      $("#p-ollama").classList.toggle("hidden", b.dataset.p !== "ollama");
    }));
    const saveG = async (card) => { await api("/api/settings", { method: "PUT", body: { global: collect("g", card) } }); };
    $("#saveai").addEventListener("click", async () => { try { await saveG(acard); S.me = await api("/api/me"); snack("Saved"); } catch (e) { snack(e.message); } });
    $("#testai").addEventListener("click", async () => {
      snack("Testing…");
      try { await saveG(acard); S.me = await api("/api/me"); const r = await api("/api/settings/test-ai", { method: "POST" }); snack(r.message, 5000); } catch (e) { snack(e.message, 8000); }
    });
    $("#rescanall").addEventListener("click", async () => {
      if (!(await confirmDlg("Re-read all documents?", "Every file will be read again and any blank fields filled in. Fields you've already filled are kept.", "Re-read all", false))) return;
      const r = await api("/api/documents-rescan-all", { method: "POST" }); await loadDocs(); snack(`${r.queued} document(s) queued`);
    });
    $("#saveg").addEventListener("click", async (e) => { try { await saveG(e.target.closest(".card")); snack("Saved"); } catch (er) { snack(er.message); } });
  }
  // appearance
  $$("#theme button").forEach((b) => b.addEventListener("click", () => {
    store("cv_theme", b.dataset.t);
    if (b.dataset.t === "system") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", b.dataset.t);
    $$("#theme button").forEach((x) => x.classList.toggle("on", x === b));
  }));
  $$("#acc .swatch").forEach((b) => b.addEventListener("click", () => {
    store("cv_accent", b.dataset.a); document.documentElement.setAttribute("data-accent", b.dataset.a);
    $$("#acc .swatch").forEach((x) => x.classList.toggle("on", x === b));
  }));
  $("#thumbs").addEventListener("change", (e) => { S.showThumbs = e.target.checked; store("cv_thumbs", e.target.checked ? "1" : "0"); });
  // account
  $("#pw").addEventListener("click", () => {
    const d = dialog(`<h2>Change password</h2><form class="form flush" id="pf">
      <div class="field"><label>Current password</label><input type="password" name="current" required autocomplete="current-password"></div>
      <div class="field"><label>New password</label><input type="password" name="new" required minlength="10" autocomplete="new-password"></div>
      <div class="btn-row"><button type="button" class="btn text" data-close>Cancel</button><button class="btn filled">Change</button></div></form>`);
    $("#pf", d).addEventListener("submit", async (e) => { e.preventDefault(); try { await api("/api/account/password", { method: "POST", body: Object.fromEntries(new FormData(e.target)) }); d.close(); snack("Password changed — other devices logged out"); } catch (er) { snack(er.message); } });
  });
  $("#totp").addEventListener("click", async () => {
    if (S.me.totp_enabled) {
      const d = dialog(`<h2>Turn off 2-step?</h2><form class="form flush" id="tf"><div class="field"><label>Password</label><input type="password" name="password" required></div>
        <div class="btn-row"><button type="button" class="btn text" data-close>Cancel</button><button class="btn danger">Turn off</button></div></form>`);
      $("#tf", d).addEventListener("submit", async (e) => { e.preventDefault(); try { await api("/api/account/totp/disable", { method: "POST", body: Object.fromEntries(new FormData(e.target)) }); d.close(); S.me = await api("/api/me"); viewSettings(); } catch (er) { snack(er.message); } });
      return;
    }
    const t = await api("/api/account/totp/start", { method: "POST" });
    const d = dialog(`<h2>Set up 2-step</h2><p>Scan with Google Authenticator, Aegis or similar, then enter the 6-digit code.</p>
      <div class="qr">${t.qr_svg.replace(/<\?xml[^>]*>/, "")}</div><div class="code">${esc(t.secret)}</div><div class="spacer"></div>
      <form class="form flush" id="tf"><div class="field"><label>Code</label><input name="code" inputmode="numeric" autocomplete="one-time-code" required maxlength="8"></div>
      <div class="btn-row"><button type="button" class="btn text" data-close>Cancel</button><button class="btn filled">Turn on</button></div></form>`);
    $("#tf", d).addEventListener("submit", async (e) => { e.preventDefault(); try { await api("/api/account/totp/enable", { method: "POST", body: { secret: t.secret, code: e.target.code.value } }); d.close(); S.me = await api("/api/me"); snack("2-step verification is on"); viewSettings(); } catch (er) { snack(er.message); } });
  });
  $("#others").addEventListener("click", async () => { await api("/api/account/logout-others", { method: "POST" }); snack("Other devices logged out"); });
  $("#logout").addEventListener("click", async () => { await api("/api/logout", { method: "POST" }).catch(() => {}); S.me = null; location.hash = "#/login"; });
  $("#users") && $("#users").addEventListener("click", manageUsers);
}

async function manageUsers() {
  const users = await api("/api/users");
  const d = dialog(`<h2>Users</h2><div class="list gap">${users.map((x) => `<div class="item"><div class="lead c-grey">${icon("person")}</div><div class="body"><div class="h">${esc(x.username)}${x.is_admin ? " · admin" : ""}</div>
    <div class="s">${x.last_login ? "Last login " + esc(x.last_login) : "Never logged in"}</div></div>${x.id !== S.me.id ? `<button class="icon-btn" data-del="${x.id}" aria-label="Delete">${icon("delete")}</button>` : ""}</div>`).join("")}</div>
    <div class="spacer"></div><form class="form flush" id="uf"><div class="field"><label>New username</label><input name="username" required autocapitalize="none"></div>
    <div class="field"><label>Password</label><input name="password" type="password" required minlength="10" autocomplete="new-password"></div>
    <div class="switch-row"><div class="body">Admin</div><input type="checkbox" class="switch" name="is_admin"></div>
    <div class="btn-row"><button type="button" class="btn text" data-close>Close</button><button class="btn filled">${icon("add")}Add user</button></div></form>`);
  $("#uf", d).addEventListener("submit", async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); f.is_admin = !!f.is_admin; try { await api("/api/users", { method: "POST", body: f }); d.close(); snack("User added"); } catch (er) { snack(er.message); } });
  $$("[data-del]", d).forEach((b) => b.addEventListener("click", async () => { d.close(); if (await confirmDlg("Delete user?", "Their documents will be deleted too.")) { await api(`/api/users/${b.dataset.del}`, { method: "DELETE" }); snack("User deleted"); } }));
}

// ---------- router ----------
async function route() {
  const [path, qs] = location.hash.replace(/^#/, "").split("?");
  const parts = (path || "/").split("/").filter(Boolean);
  const params = new URLSearchParams(qs || "");
  if (!S.me) return parts[0] === "setup" ? viewSetup() : viewLogin();
  try {
    if (!parts.length) return viewHome();
    if (parts[0] === "all") return viewAll(params);
    if (parts[0] === "add") return viewAdd();
    if (parts[0] === "doc" && parts[2] === "edit") return await viewEdit(parts[1]);
    if (parts[0] === "doc") return await viewDoc(parts[1]);
    if (parts[0] === "settings") return await viewSettings();
    if (parts[0] === "list") return await viewList();
    if (parts[0] === "login" || parts[0] === "setup") { location.hash = "#/"; return; }
    viewHome();
  } catch (e) { snack(e.message); }
}

async function boot() {
  S.showThumbs = store("cv_thumbs") === "1";
  S.groupMode = store("cv_group") === "1";
  const st = await api("/api/status", { allow401: true });
  S.version = st.data && st.data.version;
  if (st.data && st.data.setup_required) { S.me = null; location.hash = "#/setup"; return viewSetup(); }
  if (!st.data || !st.data.logged_in) { S.me = null; if (location.hash !== "#/login") location.hash = "#/login"; return viewLogin(); }
  S.me = await api("/api/me");
  S.cats = await api("/api/categories");
  S.catById = Object.fromEntries(S.cats.map((c) => [c.id, c]));
  await loadDocs();
  if (["#/login", "#/setup"].includes(location.hash)) location.hash = "#/";
  else route();
}

window.addEventListener("hashchange", route);
window.addEventListener("scroll", () => { const t = $(".topbar"); t && t.classList.toggle("scrolled", window.scrollY > 4); }, { passive: true });
$("#fab").addEventListener("click", () => (location.hash = "#/add"));
document.addEventListener("click", () => { const m = $("#menu"); if (m) m.classList.add("hidden"); });
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.me) loadDocs().then(() => { const h = location.hash; if (h === "#/" || h === "" || h.startsWith("#/all")) route(); }).catch(() => {}); });
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) navigator.serviceWorker.register("/sw.js").catch(() => {});
boot().catch((e) => { app.innerHTML = `<div class="empty">${icon("error")}<p>Can't reach CertVault: ${esc(e.message)}</p></div>`; });
