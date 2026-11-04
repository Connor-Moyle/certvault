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
  if (review.length) html += `<div class="section-title">Check these details</div><div class="list gap">${review.map(docItem).join("")}</div>`;
  if (upcoming.length) html += `<div class="section-title">Coming up</div><div class="list gap">${upcoming.map(docItem).join("")}</div>`;
  render(html);
}

// ---------- all documents ----------
function viewAll(params) {
  chrome(true, true);
  if (params.get("f")) S.filter = params.get("f");
  const present = [...new Set(S.docs.map((d) => d.category || "other"))];
  const filters = [["all", "All", "category"], ["expired", "Expired", "error"], ["soon", "Due soon", "warning"], ["valid", "Current", "check"],
    ...(S.docs.some((d) => d.superseded) ? [["old", "Previous versions", "history_edu"]] : []),
    ...(S.docs.some((d) => d.kind === "register") ? [["kind:ticket", "Tickets & licences", "badge"], ["kind:register", "Registers", "fact_check"]] : []),
    ...present.map((id) => [`cat:${id}`, (S.catById[id] || {}).name || id, (S.catById[id] || {}).icon || "description"])];
  render(topbar("Documents") + `
    <label class="search">${icon("search")}<input id="q" type="search" placeholder="Search tickets, issuers, numbers" value="${esc(S.query)}" enterkeyhint="search"></label>
    <div class="chips" id="chips">${filters.map(([k, l, i]) => `<button class="fchip ${S.filter === k ? "on" : ""}" data-f="${esc(k)}">${S.filter === k ? icon("check") : ""}${esc(l)}</button>`).join("")}</div>
    <div id="res"></div>`);
  const draw = () => {
    const q = S.query.trim().toLowerCase();
    let docs = S.filter === "old" ? S.docs.filter((d) => d.superseded) : S.docs.filter((d) => !d.superseded);
    if (S.filter === "valid") docs = docs.filter((d) => d.state === "valid" || d.state === "none");
    else if (S.filter.startsWith("kind:")) docs = docs.filter((d) => d.kind === S.filter.slice(5));
    else if (S.filter.startsWith("cat:")) docs = docs.filter((d) => (d.category || "other") === S.filter.slice(4));
    else if (!["all", "old"].includes(S.filter)) docs = docs.filter((d) => d.state === S.filter);
    if (q) docs = docs.filter((d) => [d.title, d.issuer, d.licence_number, d.category_name, d.holder_name, d.location, d.notes, d.original_name]
      .some((v) => (v || "").toLowerCase().includes(q)));
    $("#res").innerHTML = docs.length ? `<div class="list gap">${sortDocs(docs).map(docItem).join("")}</div>`
      : `<div class="empty">${icon("search")}<p>Nothing matches.</p></div>`;
  };
  draw();
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
    <div id="queue"></div>`);
  const drop = $("#drop");
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", async (e) => upload(await filesFromDrop(e.dataTransfer)));
  $("#cam").addEventListener("change", (e) => upload([...e.target.files]));
  $("#pick").addEventListener("change", (e) => upload([...e.target.files]));
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

async function upload(all, fromFolder = false) {
  if (!all.length) return;
  const maxBytes = (S.me.max_upload_mb || 25) * 1048576;
  const files = all.filter((f) => !f.name.startsWith(".") && (OK_FILE.test(f.name) || /^(image\/|application\/pdf)/.test(f.type)) && f.size <= maxBytes);
  const skipped = all.length - files.length;
  const q = $("#queue");
  if (!files.length) { snack(`No PDFs or photos found${skipped ? ` (${skipped} other file${skipped > 1 ? "s" : ""} skipped)` : ""}`, 5000); return; }
  const many = files.length > 3 || fromFolder;
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
  const BATCH = 5;
  for (let i = 0; i < files.length; i += BATCH) {
    const chunk = files.slice(i, i + BATCH);
    const fd = new FormData();
    chunk.forEach((f) => fd.append("files", f, f.name));
    try {
      const res = await api("/api/documents", { method: "POST", body: fd });
      res.forEach((r) => { if (r.error) stats.failed.push(`${r.name}: ${r.error}`); else if (r.duplicate) stats.dup++; else stats.added.push(r.id); });
    } catch (err) {
      chunk.forEach((f) => stats.failed.push(`${f.name}: ${err.message}`));
      if (/log in/i.test(err.message)) return;
    }
    if (many) { q.innerHTML = drawSummary(Math.min(i + BATCH, files.length)); setBar(Math.min(i + BATCH, files.length)); }
  }
  await loadDocs();
  if (!many) {
    stats.failed.forEach((m) => snack(m, 5000));
    if (stats.added.length === 1 && files.length === 1) return void (location.hash = `#/doc/${stats.added[0]}`);
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
  const [cls, label, ic] = stateLabel(d);
  const big = d.status === "processing" ? "…" : d.days_left == null ? "" : Math.abs(d.days_left);
  const reg = d.kind === "register";
  const L = reg ? { done: "Last inspected", exp: "Next inspection due", expShort: "inspection due" } : { done: "Completed / issued", exp: "Expires", expShort: "expires" };
  const cdText = d.status === "processing" ? "Reading your document…"
    : reg && d.state === "expired" ? `days overdue — inspection was due ${fmtDate(d.expiry_date)}`
    : reg && d.days_left != null ? (d.days_left === 0 ? "Inspection due today!" : `days until next inspection · ${fmtDate(d.expiry_date)}`)
    : d.state === "expired" ? `days since it expired on ${fmtDate(d.expiry_date)}`
    : d.state === "none" ? "This one doesn't expire"
    : d.days_left == null ? "No expiry date found — add one so you get reminders"
    : d.days_left === 0 ? "Expires today!" : `days left · expires ${fmtDate(d.expiry_date)}`;
  const kv = (ico, lab, val) => val ? `<div class="item"><div class="lead">${icon(ico)}</div><div class="body"><div class="s">${esc(lab)}</div><div class="h">${esc(val)}</div></div></div>` : "";
  const issuerTypes = { government: "Government", training: "Training provider", company: "Company / site", other: "Other" };
  const rem = d.reminder_days || "default";
  const older = (d.history || []).filter((h) => h.id !== d.id);
  let html = topbar(d.category_name, { back: true, actions: `<a class="icon-btn" href="#/doc/${d.id}/edit" aria-label="Edit">${icon("edit")}</a>
    <button class="icon-btn" id="more" aria-label="More options" aria-haspopup="menu">${icon("more_vert")}${older.length ? `<span class="dot">${older.length}</span>` : ""}</button>` });
  html += `<div class="menu hidden" id="menu" role="menu">
    <button role="menuitem" data-m="versions">${icon("history_edu")}<span>Previous / expired versions</span><span class="count">${older.length}</span></button>
    <a role="menuitem" href="#/doc/${d.id}/edit">${icon("edit")}<span>Edit details</span></a>
    <button role="menuitem" data-m="rescan">${icon(S.me.ai_enabled ? "star_shine" : "refresh")}<span>${S.me.ai_enabled ? "Re-read with AI" : "Re-read"}</span></button>
    <a role="menuitem" href="/api/documents/${d.id}/file?download=1">${icon("download")}<span>Download file</span></a>
    ${d.versions > 1 || d.version_group === "solo" ? `<button role="menuitem" data-m="solo">${icon("category")}<span>${d.version_group === "solo" ? "Group with same-name copies" : "Not a renewal — keep separate"}</span></button>` : ""}
    <div class="menu-div"></div>
    <button role="menuitem" data-m="delete" class="danger">${icon("delete")}<span>Delete</span></button></div>`;
  if (d.superseded) html += `<div class="card"><div class="head">${icon("history_edu")}<div><h3>Previous version</h3>
    <p>A newer copy of this ticket is on file, so this one is kept for your records and won't send reminders.</p></div></div>
    <div class="btn-row end"><a class="btn filled" href="#/doc/${esc(d.current_id)}">Open current</a></div></div>`;
  html += `<div class="hero"><div class="lead c-${esc(d.color)}">${icon(d.icon, "lg")}</div><div><h2>${esc(d.title || "Untitled")}</h2><div class="s">${esc(d.issuer || d.category_name)}</div></div></div>`;
  if (d.status === "processing") html += `<div class="card tonal-primary"><div class="head">${icon(S.me.ai_enabled ? "star_shine" : "hourglass_top")}<div><h3>${S.me.ai_enabled ? "AI is reading this file" : "Reading this file"}</h3><p>This usually takes a few seconds.</p></div></div><div class="progress"></div></div>`;
  else if (d.status === "review") html += `<div class="card tonal-primary"><div class="head">${icon(d.extract_source && d.extract_source.startsWith("ai") ? "star_shine" : "edit")}<div><h3>Check these details</h3>
    <p>${d.extract_source && d.extract_source.startsWith("ai") ? "Filled in by AI" : "Filled in from OCR"} — confirm they're right or tap edit.</p></div></div>
    <div class="btn-row end"><a class="btn text" href="#/doc/${d.id}/edit">Edit</a><button class="btn filled" id="confirm">${icon("check")}Looks right</button></div></div>`;
  if (d.extract_error) html += `<div class="card warn"><div class="head">${icon("warning")}<p>${esc(d.extract_error)}</p></div></div>`;
  html += `<div class="countdown ${cls}">${big !== "" ? `<div class="big">${big}</div>` : icon(ic, "xl")}<div class="s">${esc(cdText)}${d.expiry_estimated ? "<br><b>Estimated</b> from typical validity — check your card" : ""}</div></div>`;
  if (d.has_thumb) html += `<a class="preview" href="/api/documents/${d.id}/file" target="_blank" rel="noopener"><img src="/api/documents/${d.id}/thumb" alt="Preview"></a>`;
  html += `<div class="list gap kv">
    ${kv("category", "Type", d.category_name)}
    ${kv("apartment", "Issued by", d.issuer ? d.issuer + (d.issuer_type ? ` · ${issuerTypes[d.issuer_type] || d.issuer_type}` : "") : null)}
    ${kv("person", "Holder", d.holder_name)}
    ${kv("tag", "Number", d.licence_number)}
    ${kv("event_available", L.done, d.completion_date ? fmtDate(d.completion_date) : null)}
    ${kv("event", L.exp, d.expiry_date ? fmtDate(d.expiry_date) + (d.expiry_estimated ? " (estimated)" : "") : d.no_expiry ? "Doesn't expire" : "Not set")}
    ${kv("location_on", "Location", d.location)}
    ${kv("description", "Notes", d.notes)}
    ${kv("notifications", "Reminders", rem === "default" ? "Default schedule" : rem.split(",").map((x) => x === "0" ? "on the day" : `${x}d`).join(", ") + " before")}
  </div>
  <div class="btn-row">
    ${["xlsx", "csv"].includes(d.file_ext) ? "" : `<a class="btn tonal" href="/api/documents/${d.id}/file" target="_blank" rel="noopener">${icon("open_in_new")}Open</a>`}
    <a class="btn outlined" href="/api/documents/${d.id}/file?download=1">${icon("download")}Download</a>
    <button class="btn outlined" id="rescan">${icon(S.me.ai_enabled ? "star_shine" : "refresh")}${S.me.ai_enabled ? "Re-read with AI" : "Re-read"}</button>
    <button class="btn text" id="del">${icon("delete")}Delete</button>
  </div>
  <div class="meta">${esc(d.original_name || "")} · ${(d.size / 1048576).toFixed(2)} MB · uploaded ${fmtDate((d.created_at || "").slice(0, 10))}${d.extract_source ? ` · read by ${esc(d.extract_source.replace("ai:", "AI "))}` : ""}</div>
  ${d.ocr_text ? `<details><summary>Show scanned text</summary><pre class="ocr">${esc(d.ocr_text)}</pre></details>` : ""}`;
  render(html);
  $("#confirm") && $("#confirm").addEventListener("click", async () => { await api(`/api/documents/${d.id}`, { method: "PATCH", body: {} }); await loadDocs(); snack("Saved"); viewDoc(id); });
  const menu = $("#menu");
  const closeMenu = () => menu.classList.add("hidden");
  $("#more").addEventListener("click", (e) => { e.stopPropagation(); menu.classList.toggle("hidden"); });
  $$("[data-m]", menu).forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation(); closeMenu();
    const m = b.dataset.m;
    if (m === "versions") return showVersions(d);
    if (m === "rescan") return $("#rescan").click();
    if (m === "delete") return $("#del").click();
    if (m === "solo") {
      await api(`/api/documents/${d.id}`, { method: "PATCH", body: { version_group: d.version_group === "solo" ? null : "solo" } });
      await loadDocs(); snack(d.version_group === "solo" ? "Grouped with its other versions" : "Kept as a separate ticket"); viewDoc(id);
    }
  }));
  $("#rescan").addEventListener("click", async () => { await api(`/api/documents/${d.id}/rescan`, { method: "POST" }); await loadDocs(); viewDoc(id); });
  $("#del").addEventListener("click", async () => {
    if (!(await confirmDlg("Delete document?", `“${d.title}” and its file will be permanently removed.`))) return;
    await api(`/api/documents/${d.id}`, { method: "DELETE" }); await loadDocs(); snack("Deleted"); location.hash = "#/all";
  });
  if (d.status === "processing") { clearTimeout(S.docPoll); S.docPoll = setTimeout(() => { if (location.hash === `#/doc/${id}`) viewDoc(id); }, 2500); }
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
      <div class="field"><label>Location / venue</label><input name="location" value="${esc(d.location)}"></div>
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
    </div>
    <label class="search noprint">${icon("search")}<input id="mq" type="search" placeholder="Filter the list"></label>
    <div class="table-wrap"><table class="master" id="mt">
      <thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
      <tbody>${m.rows.map((r) => `<tr class="st-${esc(r._state)} ${r.Version === "Previous" ? "old" : ""}" data-id="${esc(r.ID)}">${cols.map((c) => `<td>${esc(fmtCell(c, r[c]))}</td>`).join("")}</tr>`).join("")}</tbody>
    </table></div>
    ${m.rows.length ? "" : `<div class="empty">${icon("list_alt")}<p>Nothing uploaded yet.</p></div>`}
    <div class="meta">An always-up-to-date copy is saved on the NAS in the <b>exports</b> folder of the CertVault dataset.</div>`);
  $("#print").addEventListener("click", () => window.print());
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
