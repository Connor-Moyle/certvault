/* CertVault front end — plain JS, no build step. */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = (n, cls = "") => `<svg class="icon ${cls}" aria-hidden="true"><use href="/static/icons.svg#${String(n || "description").replace(/[^a-z0-9_-]/gi, "")}"/></svg>`;
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
const K = (kind) => (S.kinds && S.kinds[kind]) || { name: "Other", icon: "description", issuer: "Issued by", number: "Number", done: "Completed / issued", exp: "Expires", cost: "Cost" };
const chip = (d) => { const [c, l, i] = stateLabel(d); return `<span class="chip ${c}">${icon(i)}${esc(l)}</span>`; };

function lead(d) {
  if (d.has_thumb && S.showThumbs) return `<div class="lead thumb c-${esc(d.color)}"><img src="/api/documents/${d.id}/thumb" alt="" loading="lazy"></div>`;
  return `<div class="lead c-${esc(d.color)}">${icon(d.icon)}</div>`;
}

function docItem(d) {
  const sub = [d.issuer, d.expiry_date ? `${d.kind === "ticket" || d.kind === "personal" ? "Exp" : "Due"} ${fmtDate(d.expiry_date)}${d.expiry_estimated ? " (est.)" : ""}` : null,
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
  let r = (location.hash.split("/")[1] || "home").split("?")[0] || "home";
  if (r === "folder") r = "folders";
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
    <div class="subtitle">${docs.length ? (need ? `${need} item${need > 1 ? "s" : ""} need${need > 1 ? "" : "s"} attention` : "Everything is up to date") : "Tickets, insurance, rego, warranties — anything that expires"}</div>`;
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
  html += `<div class="btn-row home-links"><a class="btn tonal" href="#/timeline">${icon("timeline")}Timeline</a><a class="btn tonal" href="#/folders">${icon("folder_open")}Folders</a></div>`;
  const kinds = [...new Set(docs.map((d) => d.kind))];
  if (kinds.length > 1) html += `<div class="chips kinds">${kinds.map((k) => { const n = docs.filter((d) => d.kind === k); const bad = n.filter((d) => d.state === "expired" || d.state === "soon").length;
    return `<a class="fchip" href="#/all?f=kind:${k}">${icon(K(k).icon)}${esc(K(k).name)} <b>${n.length}</b>${bad ? `<span class="mini-badge">${bad}</span>` : ""}</a>`; }).join("")}</div>`;
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
    ...(new Set(S.docs.map((d) => d.kind)).size > 1 ? [...new Set(S.docs.map((d) => d.kind))].map((k) => [`kind:${k}`, K(k).name, K(k).icon]) : []),
    ...present.map((id) => [`cat:${id}`, (S.catById[id] || {}).name || id, (S.catById[id] || {}).icon || "description"])];
  const selecting = !!S.selecting;
  render(topbar(selecting ? `${S.sel.size} selected` : "Documents", { actions: selecting
    ? `<button class="icon-btn" id="selall" aria-label="Select all shown">${icon("select_check_box")}</button><button class="icon-btn" id="selx" aria-label="Cancel">${icon("close")}</button>`
    : `<button class="icon-btn" id="selon" aria-label="Select to share">${icon("check_box")}</button>` }) + `
    <label class="search">${icon("search")}<input id="q" type="search" placeholder="Search everything — even the text inside documents" value="${esc(S.query)}" enterkeyhint="search"></label>
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
    const textHits = S.textHits && S.textHits.q === q ? S.textHits.map : {};
    if (q) docs = docs.filter((d) => textHits[d.id] || [d.title, d.issuer, d.licence_number, d.category_name, d.holder_name, d.location, d.notes, d.original_name,
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
  let st;
  const textSearch = () => {
    clearTimeout(st);
    const q = S.query.trim().toLowerCase();
    if (q.length < 3) return;
    st = setTimeout(async () => {
      try {
        const hits = await api(`/api/search?q=${encodeURIComponent(q)}`);
        S.textHits = { q, map: Object.fromEntries(hits.map((h) => [h.id, h.snippet])) };
        if (S.query.trim().toLowerCase() === q) { draw(); markSnippets(); }
      } catch (e) { /* ignore */ }
    }, 300);
  };
  const markSnippets = () => {
    const m = (S.textHits && S.textHits.map) || {};
    $$("#res a.item").forEach((a) => {
      const id = (a.getAttribute("href") || "").split("/").pop();
      if (m[id] && !$(".snip", a)) { const sn = document.createElement("div"); sn.className = "s snip"; sn.textContent = `“${m[id]}”`; $(".body", a).append(sn); }
    });
  };
  $("#q").addEventListener("input", (e) => { S.query = e.target.value; draw(); textSearch(); });
  if (S.query) textSearch();
  $$("#chips .fchip").forEach((b) => b.addEventListener("click", () => { S.filter = b.dataset.f; history.replaceState(null, "", "#/all"); viewAll(new URLSearchParams()); }));
}

// ---------- add / upload ----------
function viewAdd() {
  chrome(true, false);
  render(topbar("Add documents", { back: true }) + `
    <div class="drop" id="drop"><div class="big-icon">${icon("upload_file", "xl")}</div>
      <h3>Add a document</h3>
      <div>Any file: photos, PDFs (any size), Word, Excel, emails, ZIPs — or drop a whole folder. Nothing gets skipped.<br>${S.me.ai_enabled ? `${icon("star_shine", "sm")} AI reads every file and fills in the details.` : "Details are read automatically with OCR."}</div></div>
    <div class="upload-actions three">
      <label class="btn tonal">${icon("photo_camera")}Take photo<input type="file" accept="image/*" capture="environment" class="hidden" id="cam"></label>
      <label class="btn tonal">${icon("upload_file")}Choose files<input type="file" multiple class="hidden" id="pick"></label>
      ${window.CertVaultAndroid ? `<label class="btn tonal">${icon("folder_zip")}Import ZIP<input type="file" accept=".zip,application/zip" class="hidden" id="folder"></label>` : `<label class="btn tonal">${icon("folder_open")}Import folder<input type="file" webkitdirectory directory multiple class="hidden" id="folder"></label>`}
    </div>
    <button class="btn outlined manual-btn" id="manual">${icon("note_add")}Add something without a file<span>service due, subscription, BAS, anything with a date</span></button>
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
  $("#manual").addEventListener("click", manualDialog);
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", async (e) => upload(await filesFromDrop(e.dataTransfer)));
  $("#cam").addEventListener("change", (e) => { camTaken([...e.target.files]); e.target.value = ""; });
  $("#pick").addEventListener("change", (e) => upload([...e.target.files], false, $("#group").checked && e.target.files.length > 1));
  $("#folder").addEventListener("change", (e) => upload([...e.target.files], true));
}

function manualDialog() {
  const byKind = {};
  S.cats.forEach((c) => (byKind[c.kind] = byKind[c.kind] || []).push(c));
  const dl = dialog(`<h2>Add without a file</h2><form class="form flush" id="mf">
    <div class="field"><label>What is it?</label><input name="title" required placeholder="e.g. Ute service, BizCover renewal, Quarterly BAS"></div>
    <div class="field"><label>Type</label><select name="category">${Object.entries(byKind).map(([k, cs]) => `<optgroup label="${esc(K(k).name)}">${cs.map((c) => `<option value="${c.id}" ${c.id === "other" ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</optgroup>`).join("")}</select></div>
    <div class="row2"><div class="field"><label>Last done</label><input type="date" name="completion_date"></div>
      <div class="field"><label>Next due</label><input type="date" name="expiry_date" required></div></div>
    <div class="row2"><div class="field"><label>Repeats every (months)</label><input type="number" name="renew_months" min="1" max="240" placeholder="e.g. 12"></div>
      <div class="field"><label>Reference (optional)</label><input name="licence_number" placeholder="Plate, policy no…"></div></div>
    <div class="field"><label>Notes</label><textarea name="notes"></textarea></div>
    <div class="btn-row"><button type="button" class="btn text" data-close>Cancel</button><button class="btn filled">${icon("check")}Save</button></div></form>`);
  $("#mf", dl).addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    f.renew_months = f.renew_months ? +f.renew_months : null;
    Object.keys(f).forEach((k) => f[k] === "" && (f[k] = null));
    try { const r = await api("/api/documents/manual", { method: "POST", body: f }); dl.close(); await loadDocs(); snack("Added"); location.hash = `#/doc/${r.id}`; } catch (er) { snack(er.message); }
  });
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

const JUNK = /^(\.ds_store|thumbs\.db|desktop\.ini|\._.*|~\$.*)$/i;
const VIEWABLE = ["pdf", "jpg", "png", "webp", "gif"];

// POST with upload progress (fetch can't report it)
function xhrUpload(url, fd, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", url);
    x.setRequestHeader("X-CSRF-Token", S.me.csrf);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded);
    x.onload = () => {
      let data = null; try { data = JSON.parse(x.responseText); } catch (e) { /* */ }
      if (x.status === 401) { location.hash = "#/login"; return reject(new Error("Please log in")); }
      x.status < 300 ? resolve(data) : reject(new Error((data && data.detail) || `Upload failed (${x.status})`));
    };
    x.onerror = () => reject(new Error("Network error — is the NAS reachable?"));
    x.send(fd);
  });
}

async function upload(all, fromFolder = false, group = false) {
  if (!all.length) return;
  const maxBytes = (S.me.max_upload_mb || 1024) * 1048576;
  const junk = all.filter((f) => JUNK.test(f.name));
  const tooBig = all.filter((f) => !JUNK.test(f.name) && f.size > maxBytes);
  const files = all.filter((f) => !JUNK.test(f.name) && f.size <= maxBytes);
  const q = $("#queue");
  if (!files.length) { snack(tooBig.length ? `Too big: ${tooBig.map((f) => f.name).join(", ")} (max ${S.me.max_upload_mb} MB)` : "Nothing to upload", 6000); return; }
  const totalBytes = files.reduce((a, f) => a + f.size, 0);
  const many = !group && (files.length > 3 || fromFolder || totalBytes > 30 * 1048576);
  const stats = { added: [], dup: 0, failed: tooBig.map((f) => `${f.name}: bigger than ${S.me.max_upload_mb} MB`), zip: 0 };
  let sent = 0, doneFiles = 0;
  const mb = (n) => (n / 1048576).toFixed(n > 10485760 ? 0 : 1);
  const drawList = () => `<div class="section-title">Uploading</div><div class="list gap">${files.map((f) => `<div class="item"><div class="lead c-grey">${icon("hourglass_top")}</div>
    <div class="body"><div class="h">${esc(f.webkitRelativePath || f.name)}</div><div class="s">${mb(f.size)} MB</div><div class="progress det"><span class="bar"></span></div></div></div>`).join("")}</div>`;
  const drawSummary = () => { const done = doneFiles >= files.length; return `<div class="card tonal-primary"><div class="head">${icon(done ? "task_alt" : "upload_file")}<div>
    <h3>${done ? "Import finished" : `Uploading ${doneFiles} of ${files.length} · ${mb(sent)} / ${mb(totalBytes)} MB`}</h3>
    <p>${stats.added.length} added${stats.zip ? ` (${stats.zip} from ZIPs)` : ""}${stats.dup ? ` · ${stats.dup} already in CertVault` : ""}${stats.failed.length ? ` · ${stats.failed.length} failed` : ""}${junk.length ? ` · ${junk.length} system file${junk.length > 1 ? "s" : ""} ignored` : ""}</p></div></div>
    <div class="progress det"><span class="bar"></span></div>
    ${stats.failed.length ? `<p>${stats.failed.map((x) => esc(x)).join("<br>")}</p>` : ""}
    ${done && stats.added.length ? `<div class="btn-row end"><a class="btn filled" href="#/">${icon("check")}Done</a></div>` : ""}</div>`; };
  const setBar = () => $$(".bar", q).forEach((b) => (b.style.width = `${Math.min(100, Math.round((sent / Math.max(totalBytes, 1)) * 100))}%`));
  q.innerHTML = many ? drawSummary() : drawList();
  setBar();
  // batches: max 10 files / 64 MB per request; a big file goes on its own
  const batches = [];
  if (group) batches.push(files);
  else {
    let cur = [], size = 0;
    for (const f of files) {
      if (cur.length && (cur.length >= 10 || size + f.size > 64 * 1048576)) { batches.push(cur); cur = []; size = 0; }
      cur.push(f); size += f.size;
    }
    if (cur.length) batches.push(cur);
  }
  for (const chunk of batches) {
    const fd = new FormData();
    chunk.forEach((f) => fd.append("files", f, f.name));
    if (group) fd.append("group", "1");
    const base = sent;
    try {
      const res = await xhrUpload("/api/documents", fd, (loaded) => { sent = base + loaded; setBar(); if (many) { const h = $("h3", q); if (h) h.textContent = `Uploading ${doneFiles} of ${files.length} · ${mb(sent)} / ${mb(totalBytes)} MB`; } });
      res.forEach((r) => { if (r.error) stats.failed.push(`${r.name}: ${r.error}`); else if (r.duplicate) stats.dup++; else if (!r.page) { stats.added.push(r.id); if (r.from_zip) stats.zip++; } });
    } catch (err) {
      chunk.forEach((f) => stats.failed.push(`${f.name}: ${err.message}`));
      if (/log in/i.test(err.message)) return;
    }
    sent = base + chunk.reduce((a, f) => a + f.size, 0);
    doneFiles += chunk.length;
    if (many) { q.innerHTML = drawSummary(); }
    setBar();
  }
  await loadDocs();
  if (!many) {
    stats.failed.forEach((m) => snack(m, 6000));
    if (stats.added.length === 1 && (files.length === 1 || group)) return void (location.hash = `#/doc/${stats.added[0]}`);
    if (stats.dup && !stats.added.length) snack("Already uploaded");
    if (stats.added.length) { snack(`${stats.added.length} added — reading them now`); location.hash = "#/"; }
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
  const L = K(d.kind);
  const cdText = d.status === "processing" ? "Reading your document…"
    : reg && d.state === "expired" ? `days overdue — inspection was due ${fmtDate(d.expiry_date)}`
    : reg && d.days_left != null ? (d.days_left === 0 ? "Inspection due today!" : `days until next inspection · ${fmtDate(d.expiry_date)}`)
    : d.kind !== "ticket" && d.state === "expired" ? `days overdue — was due ${fmtDate(d.expiry_date)}`
    : d.kind !== "ticket" && d.days_left != null ? (d.days_left === 0 ? "Due today!" : `days until ${L.exp.toLowerCase()} · ${fmtDate(d.expiry_date)}`)
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
  const sides = [...(d.has_file ? [{ id: "main", label: d.pages && d.pages.length ? "Front" : "Document", thumb: d.has_thumb ? `/api/documents/${d.id}/thumb` : null, file: `/api/documents/${d.id}/file`, ext: d.file_ext }] : []),
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
    ${d.has_pdf ? `<a role="menuitem" href="/api/documents/${d.id}/pdf?download=1">${icon("picture_as_pdf")}<span>Download as one PDF</span></a>` : ""}
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
  const canRenew = d.kind !== "ticket" || d.renew_months;
  if (canRenew && d.expiry_date && d.status !== "processing") html += `<div class="btn-row renew-row"><button class="btn tonal" id="renew">${icon("event_repeat")}Mark renewed / done${d.renew_months ? ` <small>(+${d.renew_months} mo)</small>` : ""}</button></div>`;
  html += `<div class="section-title">${sides.length > 1 ? `${sides.length} sides / pages` : sides.length ? "File" : "No file yet"}</div><div class="sides">
    ${sides.map((sd) => `<div class="side"><a href="${sd.file}${VIEWABLE.includes(sd.ext) ? "" : "?download=1"}" ${VIEWABLE.includes(sd.ext) ? 'target="_blank" rel="noopener"' : ""} class="side-img">${sd.thumb ? `<img src="${sd.thumb}" alt="${esc(sd.label)}" loading="lazy">` : `<div class="side-ph">${icon(["xlsx", "xlsm", "xls", "csv"].includes(sd.ext) ? "table_view" : "description", "xl")}<span>${esc((sd.ext || "").toUpperCase())}${VIEWABLE.includes(sd.ext) ? "" : " · tap to download"}</span></div>`}</a>
      <div class="side-cap"><span>${esc(sd.label)}</span>${sd.id !== "main" ? `<button class="icon-btn sm" data-delpage="${sd.id}" aria-label="Remove ${esc(sd.label)}">${icon("close", "sm")}</button>` : ""}</div></div>`).join("")}
    <label class="side add"><div class="side-img"><div class="side-ph">${icon("add_a_photo", "xl")}<span>${!sides.length ? "Add file" : sides.length > 1 || !["ticket", "personal"].includes(d.kind) ? "Add page" : "Add back"}</span></div></div>
      <input type="file" class="hidden" id="addside"></label>
  </div>`;
  html += `<div class="folder-row">${(d.folders || []).map((f) => `<a class="fchip on" href="#/folder/${f.id}">${icon(f.icon || "folder_open")}${esc(f.name)}</a>`).join("")}
    <button class="fchip" id="dfold">${icon("create_new_folder")}${(d.folders || []).length ? "Folders" : "Add to folder"}</button></div>`;
  html += `<div class="list gap kv">
    ${kv("category", "Type", d.category_name)}
    ${kv("apartment", L.issuer, d.issuer ? d.issuer + (d.issuer_type ? ` · ${issuerTypes[d.issuer_type] || d.issuer_type}` : "") : null)}
    ${kv("person", "Holder", d.holder_name)}
    ${kv("tag", L.number, d.licence_number)}
    ${kv("license", reg ? "Covers" : "Classes / endorsements", classes.length ? `<div class="class-list">${classes.map((c) => { const [code, ...rest] = c.split(" – "); return `<div class="class-row"><span class="code">${esc(code)}</span><span>${esc(rest.join(" – ") || "")}</span></div>`; }).join("")}</div>` : null, true)}
    ${kv("event_available", L.done, d.completion_date ? fmtDate(d.completion_date) : null)}
    ${kv("event", L.exp, d.expiry_date ? fmtDate(d.expiry_date) + (d.expiry_estimated ? " (estimated)" : "") : d.no_expiry ? "Doesn't expire" : "Not set")}
    ${kv("location_on", "Location", d.location)}
    ${kv("school", "RTO / provider code", d.rto_code)}
    ${kv("work", "Required for", d.required_for)}
    ${kv("autorenew", "How to renew", d.renewal_info)}
    ${kv("payments", L.cost, d.cost)}
    ${kv("event_repeat", "Renews every", d.renew_months ? `${d.renew_months} month${d.renew_months > 1 ? "s" : ""}` : null)}
    ${kv("sell", "Tags", tags.length ? `<div class="tag-row">${tags.map((t) => `<a class="chip none" href="#/all?q=${encodeURIComponent(t)}">${esc(t)}</a>`).join("")}</div>` : null, true)}
    ${kv("description", "Notes", d.notes)}
    ${kv("notifications", "Reminders", rem === "default" ? "Default schedule" : rem.split(",").map((x) => x === "0" ? "on the day" : `${x}d`).join(", ") + " before")}
  </div>
  <div class="btn-row">
    <button class="btn filled" id="share2">${icon("share")}Share</button>
    ${d.has_pdf ? `<a class="btn tonal" href="/api/documents/${d.id}/pdf" target="_blank" rel="noopener">${icon("picture_as_pdf")}PDF</a>` : ""}
    ${d.has_file ? `<a class="btn outlined" href="/api/documents/${d.id}/file?download=1">${icon("download")}Download</a>` : ""}
    ${d.expiry_date ? `<a class="btn outlined" href="/api/calendar.ics?ids=${d.id}">${icon("calendar_add_on")}Calendar</a>` : ""}
  </div>`;
  if (d.shares && d.shares.length) html += `<div class="section-title">Shared</div><div class="list gap kv">${d.shares.map((s) => `<div class="item"><div class="lead">${icon(s.method === "email" ? "mail" : s.method === "zip" ? "folder_zip" : "share")}</div>
    <div class="body"><div class="h">${esc(s.recipient || { phone: "Sent from phone", zip: "Downloaded ticket pack", copy: "Copied details" }[s.method] || s.method)}</div><div class="s">${esc(fmtDateTime(s.created_at))}</div></div></div>`).join("")}</div>`;
  html += `<div class="meta">${d.has_file ? `${esc(d.original_name || "")} · ${((d.size || 0) / 1048576).toFixed(2)} MB · ` : "Tracked without a file · "}added ${fmtDate((d.created_at || "").slice(0, 10))}${d.extract_source ? ` · read by ${esc(d.extract_source.replace("ai:", "AI "))}` : ""}</div>`;
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
  $("#dfold").addEventListener("click", () => docFoldersDialog(d));
  $("#renew") && $("#renew").addEventListener("click", async () => {
    const guess = d.renew_months || { insurance: 12, vehicle: 12, business: 12, asset: 12, medical: 24, register: 3, personal: 120 }[d.kind] || 12;
    const dl = dialog(`<h2>Mark renewed</h2><p>Sets today as done and moves the due date forward. Upload the new certificate/policy too if you have one.</p>
      <form class="form flush" id="rf"><div class="row2"><div class="field"><label>Renews every (months)</label><input type="number" name="months" min="1" max="240" value="${guess}" required></div>
      <div class="field"><label>…or exact new due date</label><input type="date" name="new_expiry"></div></div>
      <div class="btn-row"><button type="button" class="btn text" data-close>Cancel</button><button class="btn filled">${icon("event_repeat")}Renew</button></div></form>`);
    $("#rf", dl).addEventListener("submit", async (e) => {
      e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
      try {
        const r = await api(`/api/documents/${d.id}/renew`, { method: "POST", body: f.new_expiry ? { new_expiry: f.new_expiry } : { months: +f.months } });
        dl.close(); await loadDocs(); snack(`Renewed — next due ${fmtDate(r.expiry_date)}`); viewDoc(id);
      } catch (er) { snack(er.message); }
    });
  });
  $("#share2").addEventListener("click", () => shareSheet([d]));
  $("#addside").addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const fd = new FormData(); fd.append("file", f, f.name); fd.append("label", sides.length <= 1 ? "Back" : `Page ${sides.length + 1}`);
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
  const APP = window.CertVaultAndroid;
  const canPhone = !!APP || !!(navigator.canShare && window.isSecureContext);
  let recent = [];
  try { recent = await api("/api/share/recent"); } catch (e) { /* ignore */ }
  const dl = dialog(`<h2>Share ${esc(name)}</h2>
    <div class="share-opts">
      <button class="share-opt" id="sh-phone" ${canPhone ? "" : "disabled"}>${icon("share")}<span>Phone apps</span><small>${canPhone ? "WhatsApp, Gmail, Messages…" : "Use the Android app, or HTTPS"}</small></button>
      <button class="share-opt" id="sh-mail">${icon("mail")}<span>Email it</span><small>Sent from CertVault with files attached</small></button>
      <a class="share-opt" id="sh-pdf" href="/api/share/pack.pdf?ids=${ids.join(",")}">${icon("picture_as_pdf")}<span>One PDF</span><small>Cover summary + every document</small></a>
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
  $("#sh-pdf", dl).addEventListener("click", () => { snack("Building PDF…"); setTimeout(() => dl.close(), 300); });
  $("#sh-copy", dl).addEventListener("click", async () => {
    const { text } = await api(`/api/share/text?ids=${ids.join(",")}`);
    copyText(text); snack("Details copied — paste them into any message");
    api("/api/share/log", { method: "POST", body: { ids, method: "copy" } }).catch(() => {});
    dl.close();
  });
  $("#sh-phone", dl).addEventListener("click", async () => {
    if (APP) {
      try {
        const [{ text }, list] = await Promise.all([api(`/api/share/text?ids=${ids.join(",")}`), api(`/api/share/files?ids=${ids.join(",")}`)]);
        APP.shareFiles(JSON.stringify(list), text, one ? docs[0].title : "Licences & tickets");
        api("/api/share/log", { method: "POST", body: { ids, method: "phone" } }).catch(() => {});
        dl.close();
      } catch (err) { snack(err.message); }
      return;
    }
    try {
      snack("Preparing files…");
      const { text } = await api(`/api/share/text?ids=${ids.join(",")}`);
      const files = [];
      for (const it of await api(`/api/share/files?ids=${ids.join(",")}`)) {
        const b = await (await fetch(it.url, { credentials: "same-origin" })).blob();
        files.push(new File([b], it.name, { type: b.type }));
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
      <div class="field"><label>Type</label><select name="category">${Object.entries(S.cats.reduce((a, c) => ((a[c.kind] = a[c.kind] || []).push(c), a), {})).map(([k, cs]) => `<optgroup label="${esc(K(k).name)}">${cs.map((c) => opt(c.id, c.name, d.category || "other")).join("")}</optgroup>`).join("")}</select></div>
      <div class="row2">
        <div class="field"><label id="l-iss">${esc(K((S.catById[d.category] || {}).kind).issuer)}</label><input name="issuer" value="${esc(d.issuer)}" placeholder="e.g. WA Department of Transport"></div>
        <div class="field"><label>Issuer type</label><select name="issuer_type">${opt("", "—", d.issuer_type)}${opt("government", "Government", d.issuer_type)}${opt("training", "Training provider", d.issuer_type)}${opt("company", "Company / site", d.issuer_type)}${opt("other", "Other", d.issuer_type)}</select></div>
      </div>
      <div class="row2">
        <div class="field"><label>Holder name</label><input name="holder_name" value="${esc(d.holder_name)}" autocomplete="off"></div>
        <div class="field"><label id="l-num">${esc(K((S.catById[d.category] || {}).kind).number)}</label><input name="licence_number" value="${esc(d.licence_number)}" autocomplete="off"></div>
      </div>
      <div class="row2">
        <div class="field"><label id="l-done">${esc(K((S.catById[d.category] || {}).kind).done)}</label><input type="date" name="completion_date" value="${esc(d.completion_date)}"></div>
        <div class="field ${d.expiry_estimated ? "warn" : ""}"><label id="l-exp">${esc(K((S.catById[d.category] || {}).kind).exp)}</label><input type="date" name="expiry_date" id="exp" value="${esc(d.expiry_date)}">${d.expiry_estimated ? '<div class="hint">Estimated — check your card</div>' : ""}</div>
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
        <div class="field"><label>Cost / premium</label><input name="cost" value="${esc(d.cost)}" placeholder="$"></div>
        <div class="field"><label>Renews every (months)</label><input type="number" name="renew_months" min="0" max="240" value="${esc(d.renew_months)}" placeholder="—"></div>
      </div>
      <div class="row2">
        <div class="field"><label>Tags</label><input name="tags" value="${esc(d.tags)}" placeholder="e.g. telco, heights, client-required"></div>
      </div>
      <div class="field"><label>Notes</label><textarea name="notes" maxlength="4000">${esc(d.notes)}</textarea></div>
      <div class="field"><label>Reminder days for this document</label><input name="reminder_days" value="${esc(d.reminder_days)}" placeholder="Default (from Settings)" inputmode="numeric"><div class="hint">Comma separated, e.g. 60,30,14,7,0 — leave blank to use your default</div></div>
      <div class="btn-row end"><button type="button" class="btn text" data-back>Cancel</button><button class="btn filled">${icon("check")}Save</button></div>
    </form>`);
  $("[name=category]").addEventListener("change", (e) => {
    const k = K((S.catById[e.target.value] || {}).kind);
    $("#l-done").textContent = k.done; $("#l-exp").textContent = k.exp; $("#l-iss").textContent = k.issuer; $("#l-num").textContent = k.number;
  });
  $("#f").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const body = { ...f, no_expiry: !!f.no_expiry };
    body.classes = expandClasses(f.classes || "", f.category);
    body.renew_months = f.renew_months ? +f.renew_months : null;
    if (body.expiry_date !== (d.expiry_date || "")) body.expiry_estimated = false;
    try { await api(`/api/documents/${id}`, { method: "PATCH", body }); await loadDocs(); snack("Saved"); history.back(); } catch (err) { snack(err.message); }
  });
}

// ---------- folders (organisations / groups) ----------
const READY_LABEL = { valid: "Current", none: "Current (no expiry)", soon: "Expiring soon", expired: "Expired", unknown: "No date", processing: "Reading…", missing: "Missing" };

async function viewFolders() {
  chrome(true, false);
  const fl = await api("/api/folders");
  const orgs = fl.filter((f) => f.ctype !== "group"), groups = fl.filter((f) => f.ctype === "group");
  const card = (f) => `<a class="fcard c-${esc(f.color || "blue")}" href="#/folder/${f.id}">
    <div class="lead">${icon(f.icon || "folder_open")}</div>
    <div class="body"><div class="h">${esc(f.name)}</div><div class="s">${f.count} doc${f.count === 1 ? "" : "s"}${f.required ? ` · ${f.ready}/${f.required} ready` : ""}</div></div>
    ${f.expired + f.soon + f.missing ? `<span class="mini-badge ${f.expired || f.missing ? "bad" : ""}">${f.expired + f.soon + f.missing}</span>` : ""}</a>`;
  render(topbar("Folders", { actions: `<button class="icon-btn" id="newf" aria-label="New folder">${icon("create_new_folder")}</button>` }) + `
    <div class="subtitle">Organisations and groups — filled automatically, add your own any time</div>
    ${groups.length ? `<div class="section-title">Groups</div><div class="fgrid">${groups.map(card).join("")}</div>` : ""}
    <div class="section-title">Organisations &amp; clients</div>
    ${orgs.length ? `<div class="fgrid">${orgs.map(card).join("")}</div>` : `<div class="empty">${icon("folder_open")}<p>No organisations yet. They appear automatically when a document mentions one (e.g. a Western Power induction), or tap ${icon("create_new_folder", "sm")} to add one.</p></div>`}
  `);
  $("#newf").addEventListener("click", () => folderDialog());
}

function folderDialog(f = null) {
  const icons = ["folder_open", "bolt", "factory", "cell_tower", "engineering", "domain", "anchor", "water_drop", "traffic", "account_balance", "medical_information", "business_center"];
  const colors = ["blue", "teal", "green", "amber", "orange", "red", "purple", "indigo", "grey"];
  let ic = (f && f.icon) || "folder_open", col = (f && f.color) || "blue";
  const dl = dialog(`<h2>${f ? "Edit folder" : "New folder"}</h2><form class="form flush" id="ff">
    <div class="field"><label>Name</label><input name="name" required maxlength="80" value="${esc(f ? f.name : "")}" placeholder="e.g. Western Power, South32, Telstra"></div>
    <div class="field"><label>Icon</label><div class="icon-pick" id="ip">${icons.map((i) => `<button type="button" class="icon-btn ${i === ic ? "on" : ""}" data-i="${i}">${icon(i)}</button>`).join("")}</div></div>
    <div class="field"><label>Colour</label><div class="icon-pick" id="cp">${colors.map((c) => `<button type="button" class="swatch-sm c-${c} ${c === col ? "on" : ""}" data-c="${c}" aria-label="${c}"></button>`).join("")}</div></div>
    <div class="btn-row"><button type="button" class="btn text" data-close>Cancel</button><button class="btn filled">${icon("check")}Save</button></div></form>`);
  $$("#ip [data-i]", dl).forEach((b) => b.addEventListener("click", () => { ic = b.dataset.i; $$("#ip [data-i]", dl).forEach((x) => x.classList.toggle("on", x === b)); }));
  $$("#cp [data-c]", dl).forEach((b) => b.addEventListener("click", () => { col = b.dataset.c; $$("#cp [data-c]", dl).forEach((x) => x.classList.toggle("on", x === b)); }));
  $("#ff", dl).addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = { name: e.target.name.value, icon: ic, color: col };
    try {
      if (f) { await api(`/api/folders/${f.id}`, { method: "PATCH", body }); dl.close(); viewFolder(f.id); }
      else { const r = await api("/api/folders", { method: "POST", body }); dl.close(); location.hash = `#/folder/${r.id}`; }
    } catch (er) { snack(er.message); }
  });
}

async function viewFolder(id) {
  chrome(true, false);
  const f = await api(`/api/folders/${id}`);
  const docs = S.docs.filter((d) => f.doc_ids.includes(d.id) && !d.superseded);
  const chk = f.checklist || [];
  const pct = chk.length ? Math.round((f.ready / chk.length) * 100) : null;
  let html = topbar(f.name, { back: true, actions: `<button class="icon-btn" id="fshare" aria-label="Share folder">${icon("share")}</button>
    <button class="icon-btn" id="fmore" aria-label="More">${icon("more_vert")}</button>` });
  html += `<div class="menu hidden" id="fmenu" role="menu">
    <button role="menuitem" data-fm="req">${icon("checklist")}<span>Required tickets…</span></button>
    <button role="menuitem" data-fm="add">${icon("drive_file_move")}<span>Add documents…</span></button>
    <a role="menuitem" href="/api/share/pack.pdf?ids=${docs.map((d) => d.id).join(",")}">${icon("picture_as_pdf")}<span>Download all as one PDF</span></a>
    <button role="menuitem" data-fm="edit">${icon("edit")}<span>Rename / icon</span></button>
    <div class="menu-div"></div>
    <button role="menuitem" data-fm="del" class="danger">${icon("delete")}<span>Delete folder</span></button></div>`;
  html += `<div class="hero"><div class="lead c-${esc(f.color || "blue")}">${icon(f.icon || "folder_open", "lg")}</div><div><h2>${esc(f.name)}</h2>
    <div class="s">${f.count} document${f.count === 1 ? "" : "s"}${f.ctype === "group" ? " · automatic group" : ""}</div></div></div>`;
  if (chk.length) {
    html += `<div class="card compliance"><div class="ring ${pct === 100 ? "ok" : pct >= 70 ? "warn" : "bad"}" data-pct="${pct}"><span>${pct}%</span></div>
      <div class="body"><h3>${pct === 100 ? `Ready for ${esc(f.name)}` : `${chk.length - f.ready} to sort out`}</h3><p>${f.ready} of ${chk.length} required tickets current</p></div>
      <button class="icon-btn" id="sendready" aria-label="Send ready tickets">${icon("send")}</button></div>
      <div class="section-title">Requirements</div><div class="list gap">${chk.map((c) => `<a class="item" ${c.doc_id ? `href="#/doc/${c.doc_id}"` : `href="#/add"`}>
        <div class="lead ${c.state === "missing" || c.state === "expired" ? "c-red" : c.state === "soon" ? "c-amber" : "c-green"}">${icon(c.state === "missing" ? "add" : c.state === "expired" ? "error" : c.state === "soon" ? "warning" : "check")}</div>
        <div class="body"><div class="h">${esc(c.name)}</div><div class="s">${c.doc_id ? `${esc(c.title)}${c.expiry_date ? ` · ${fmtDate(c.expiry_date)}` : ""}` : c.site_specific ? `Upload your ${esc(f.name)} one` : "Not on file — tap to add"}</div></div>
        <div class="trail"><span class="chip ${c.state === "missing" ? "expired" : c.state}">${esc(READY_LABEL[c.state] || c.state)}</span></div></a>`).join("")}</div>`;
  } else if (f.ctype !== "group") {
    html += `<div class="card outlined"><div class="head">${icon("checklist")}<div><h3>What does ${esc(f.name)} require?</h3><p>Pick the tickets they ask for and this folder shows what's current, expiring or missing.</p></div></div>
      <div class="btn-row end"><button class="btn tonal" id="setreq">${icon("checklist")}Set requirements</button></div></div>`;
  }
  html += `<div class="section-title">In this folder</div>${docs.length ? `<div class="list gap">${sortDocs(docs).map(docItem).join("")}</div>`
    : `<div class="empty">${icon("folder_open")}<p>Nothing here yet.</p><button class="btn tonal" id="adddocs">${icon("drive_file_move")}Add documents</button></div>`}`;
  render(html);
  const ring = $(".ring"); if (ring) ring.style.setProperty("--p", ring.dataset.pct);
  const menu = $("#fmenu");
  $("#fmore").addEventListener("click", (e) => { e.stopPropagation(); menu.classList.toggle("hidden"); });
  const reqDialog = () => requirementsDialog(f);
  const addDialog = () => pickDocsDialog(f);
  $$("[data-fm]", menu).forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation(); menu.classList.add("hidden");
    const m = b.dataset.fm;
    if (m === "req") return reqDialog();
    if (m === "add") return addDialog();
    if (m === "edit") return folderDialog(f);
    if (m === "del") {
      if (!(await confirmDlg(`Delete “${f.name}”?`, "Only the folder is removed — the documents stay in CertVault.", "Delete folder"))) return;
      await api(`/api/folders/${f.id}`, { method: "DELETE" }); snack("Folder deleted"); location.hash = "#/folders";
    }
  }));
  $("#setreq") && $("#setreq").addEventListener("click", reqDialog);
  $("#adddocs") && $("#adddocs").addEventListener("click", addDialog);
  $("#fshare").addEventListener("click", () => docs.length ? shareSheet(docs) : snack("Nothing in this folder yet"));
  $("#sendready") && $("#sendready").addEventListener("click", () => {
    const ids = chk.filter((c) => c.doc_id && c.state !== "expired").map((c) => c.doc_id);
    shareSheet(S.docs.filter((d) => ids.includes(d.id) || (f.doc_ids.includes(d.id) && !d.superseded && d.state !== "expired")));
  });
}

function requirementsDialog(f) {
  const cur = new Set(f.requirements.length ? f.requirements : []);
  const byKind = {};
  S.cats.filter((c) => ["ticket", "medical", "personal", "business"].includes(c.kind) && c.id !== "other").forEach((c) => (byKind[c.kind] = byKind[c.kind] || []).push(c));
  const dl = dialog(`<h2>${esc(f.name)} requires…</h2>
    ${!f.requirements.length && f.suggested.length ? `<button class="btn text" id="sugg">${icon("star_shine")}Use a typical starting list</button>` : ""}
    <div class="req-list">${Object.entries(byKind).map(([k, cs]) => `<div class="s req-h">${esc(K(k).name)}</div>${cs.map((c) => `<label class="req-row"><input type="checkbox" class="switch" value="${c.id}" ${cur.has(c.id) ? "checked" : ""}><span>${icon(c.icon, "sm")}${esc(c.name)}</span></label>`).join("")}`).join("")}</div>
    <p class="hint-p">Site inductions and onboarding must be in this folder to count; other tickets count from anywhere in CertVault.</p>
    <div class="btn-row"><button class="btn text" data-close>Cancel</button><button class="btn filled" id="reqsave">${icon("check")}Save</button></div>`);
  $("#sugg", dl) && $("#sugg", dl).addEventListener("click", () => { $$(".req-row input", dl).forEach((i) => (i.checked = f.suggested.includes(i.value))); snack("Typical list ticked — adjust to what they actually ask for"); });
  $("#reqsave", dl).addEventListener("click", async () => {
    const reqs = $$(".req-row input", dl).filter((i) => i.checked).map((i) => i.value);
    await api(`/api/folders/${f.id}`, { method: "PATCH", body: { requirements: reqs } }); dl.close(); viewFolder(f.id);
  });
}

function pickDocsDialog(f) {
  const docs = sortDocs(S.docs.filter((d) => !d.superseded));
  const sel = new Set(f.doc_ids);
  const dl = dialog(`<h2>Documents in ${esc(f.name)}</h2><label class="search">${icon("search")}<input id="pq" type="search" placeholder="Filter"></label>
    <div class="list gap pick">${docs.map((d) => `<label class="item" data-t="${esc((d.title + " " + (d.issuer || "") + " " + d.category_name).toLowerCase())}"><input type="checkbox" class="switch" value="${d.id}" ${sel.has(d.id) ? "checked" : ""}>
      <div class="body"><div class="h">${esc(d.title || "Untitled")}</div><div class="s">${esc(d.category_name)}${d.expiry_date ? ` · ${fmtDate(d.expiry_date)}` : ""}</div></div></label>`).join("")}</div>
    <div class="spacer"></div><div class="btn-row"><button class="btn text" data-close>Cancel</button><button class="btn filled" id="psave">${icon("check")}Save</button></div>`);
  $("#pq", dl).addEventListener("input", (e) => { const q = e.target.value.toLowerCase(); $$(".pick .item", dl).forEach((it) => it.classList.toggle("hidden", !!q && !it.dataset.t.includes(q))); });
  $("#psave", dl).addEventListener("click", async () => {
    const now = new Set($$(".pick input", dl).filter((i) => i.checked).map((i) => i.value));
    const add = [...now].filter((x) => !sel.has(x)), remove = [...sel].filter((x) => !now.has(x));
    await api(`/api/folders/${f.id}/docs`, { method: "POST", body: { add, remove } }); dl.close(); await loadDocs(); viewFolder(f.id);
  });
}

async function docFoldersDialog(d) {
  const fl = await api("/api/folders");
  const cur = new Set((d.folders || []).map((x) => x.id));
  const dl = dialog(`<h2>Folders</h2><div class="list gap pick">${fl.map((f) => `<label class="item"><input type="checkbox" class="switch" value="${f.id}" ${cur.has(f.id) ? "checked" : ""}>
      <div class="lead c-${esc(f.color || "blue")}">${icon(f.icon || "folder_open")}</div><div class="body"><div class="h">${esc(f.name)}</div></div></label>`).join("") || "<p>No folders yet.</p>"}</div>
    <div class="row2 spacer-top"><div class="field"><label>New folder</label><input id="nfname" placeholder="e.g. South32"></div><div class="field"><label>&nbsp;</label><button class="btn tonal block" id="nfadd">${icon("create_new_folder")}Create</button></div></div>
    <div class="btn-row"><button class="btn text" data-close>Cancel</button><button class="btn filled" id="dfsave">${icon("check")}Save</button></div>`);
  $("#nfadd", dl).addEventListener("click", async () => {
    const name = $("#nfname", dl).value.trim(); if (!name) return;
    try { const r = await api("/api/folders", { method: "POST", body: { name } }); await api(`/api/folders/${r.id}/docs`, { method: "POST", body: { add: [d.id] } }); dl.close(); snack(`Added to ${name}`); viewDoc(d.id); } catch (er) { snack(er.message); }
  });
  $("#dfsave", dl).addEventListener("click", async () => {
    const now = new Set($$(".pick input", dl).filter((i) => i.checked).map((i) => +i.value));
    for (const f of fl) {
      if (now.has(f.id) && !cur.has(f.id)) await api(`/api/folders/${f.id}/docs`, { method: "POST", body: { add: [d.id] } });
      if (!now.has(f.id) && cur.has(f.id)) await api(`/api/folders/${f.id}/docs`, { method: "POST", body: { remove: [d.id] } });
    }
    dl.close(); await loadDocs(); viewDoc(d.id);
  });
}

// ---------- timeline: what's due over the next 12 months ----------
function viewTimeline() {
  chrome(true, false);
  const docs = sortDocs(S.docs.filter((d) => !d.superseded && d.expiry_date && d.status !== "processing"));
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const overdue = docs.filter((d) => d.days_left < 0);
  const groups = [];
  for (let m = 0; m < 13; m++) {
    const start = new Date(now.getFullYear(), now.getMonth() + m, 1);
    const end = new Date(now.getFullYear(), now.getMonth() + m + 1, 1);
    const inMonth = docs.filter((d) => { const x = new Date(d.expiry_date + "T00:00:00"); return d.days_left >= 0 && x >= start && x < end; });
    groups.push({ label: start.toLocaleDateString("en-AU", { month: "long", year: "numeric" }), docs: inMonth });
  }
  const later = docs.filter((d) => new Date(d.expiry_date + "T00:00:00") >= new Date(now.getFullYear(), now.getMonth() + 13, 1));
  const cost = (list) => list.reduce((a, d) => a + (parseFloat(String(d.cost || "").replace(/[^0-9.]/g, "")) || 0), 0);
  const sect = (label, list, cls = "") => list.length ? `<div class="tl-month ${cls}"><div class="tl-head"><span>${esc(label)}</span><span class="s">${list.length} item${list.length > 1 ? "s" : ""}${cost(list) ? ` · ~$${cost(list).toLocaleString("en-AU", { maximumFractionDigits: 0 })}` : ""}</span></div>
    <div class="list gap">${list.map(docItem).join("")}</div></div>` : "";
  const busiest = groups.reduce((a, g) => (g.docs.length > (a ? a.docs.length : 0) ? g : a), null);
  render(topbar("Timeline", { back: true }) + `
    <div class="subtitle">Everything that expires or falls due, month by month${busiest && busiest.docs.length > 1 ? ` · busiest: ${esc(busiest.label)}` : ""}</div>
    <div class="tl-bars">${groups.map((g) => `<div class="tl-bar"><div class="tl-fill" data-n="${g.docs.length}"></div><span>${esc(g.label.slice(0, 3))}</span></div>`).join("")}</div>
    ${sect("Overdue / expired", overdue, "bad")}
    ${groups.map((g) => sect(g.label, g.docs)).join("")}
    ${sect("Later", later)}
    ${docs.length ? "" : `<div class="empty">${icon("timeline")}<p>Nothing with a date yet.</p></div>`}`);
  const max = Math.max(1, ...groups.map((g) => g.docs.length));
  $$(".tl-fill").forEach((f) => { f.style.height = `${Math.round((+f.dataset.n / max) * 100)}%`; if (+f.dataset.n) f.classList.add("on"); });
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
  const [st, nm] = await Promise.all([api("/api/settings"), api("/api/naming")]);
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
  html += `<div class="section-title">File naming</div><div class="card" id="namecard"><div class="form flush">
    <p>Pick what goes into file names, in order. Used for downloads, email attachments, ZIP packs, phone sharing and the auto-named copy on the NAS.</p>
    <div class="name-order" id="norder"></div>
    <div class="chips wrap" id="navail"></div>
    <div class="row2">
      <div class="field"><label>Separator</label><select id="nsep">${Object.entries(nm.separators).map(([k, l]) => `<option value="${esc(k)}" ${k === nm.current.name_sep ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></div>
      <div class="field"><label>Date style</label><select id="ndate">${Object.entries(nm.datefmts).map(([k, l]) => `<option value="${k}" ${k === nm.current.name_datefmt ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></div>
    </div>
    <div class="field"><label>Letter case</label><select id="ncase">${[["as-is", "As written"], ["title", "Title Case"], ["upper", "UPPER CASE"], ["lower", "lower case"]].map(([k, l]) => `<option value="${k}" ${k === nm.current.name_case ? "selected" : ""}>${l}</option>`).join("")}</select></div>
    <div class="name-preview" id="nprev"></div>
    <div class="switch-row"><div class="body">Also rename document titles<div class="s">New uploads get titled with this pattern too</div></div><input type="checkbox" class="switch" id="ntitles" ${nm.current.name_titles === "1" ? "checked" : ""}></div>
    <div class="field"><label>Send & save documents as</label><select id="nfmt"><option value="pdf" ${(st.user.share_format || "pdf") === "pdf" ? "selected" : ""}>PDF — one searchable PDF per document (recommended)</option><option value="original" ${st.user.share_format === "original" ? "selected" : ""}>Original files (photos, Word, Excel…)</option></select></div>
    <div class="switch-row"><div class="body">Keep a neatly named copy on the NAS<div class="s">Folder <code>library</code> in the CertVault dataset, sorted by group and type — no extra space used</div></div><input type="checkbox" class="switch" id="nlib" ${nm.current.library === "1" ? "checked" : ""}></div>
    <div class="btn-row end"><button class="btn text" id="napply">Rename all titles now</button><button class="btn filled" id="nsave">Save</button></div></div></div>`;
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
  if (admin) html += `<div class="section-title">Backup</div><div class="card"><div class="form flush">
    <p>CertVault backs up its database every night to the <code>backups</code> folder on the NAS (last 14 kept). Download a full backup (database + every file) to keep a copy somewhere else.</p>
    <div class="btn-row"><a class="btn filled" href="/api/backup">${icon("backup")}Download full backup</a>
      <label class="btn outlined">${icon("settings_backup_restore")}Restore…<input type="file" accept=".zip" class="hidden" id="restore"></label></div></div></div>`;
  html += `<div class="section-title">Automatic</div><div class="card"><div class="form flush">
    <div class="switch-row"><div class="body">Weekly summary<div class="s">Monday morning: what's expired or due in the next 30 days</div></div><input type="checkbox" class="switch" id="wdig" ${(st.user.weekly_digest || "1") === "1" ? "checked" : ""}></div>
    <div class="switch-row"><div class="body">Auto-file into folders<div class="s">Put documents in organisation, Medicals and Gov docs folders automatically</div></div><input type="checkbox" class="switch" id="afold" ${(st.user.auto_folders || "1") === "1" ? "checked" : ""}></div></div></div>`;
  html += window.CertVaultAndroid
    ? `<div class="section-title">Android app</div><div class="list gap"><div class="item" id="appsrv"><div class="lead c-green">${icon("android")}</div><div class="body"><div class="h">Server address</div><div class="s">${esc(window.CertVaultAndroid.serverUrl())} · app v${esc(window.CertVaultAndroid.version())}</div></div></div></div>`
    : `<div class="section-title">Android app</div><div class="list gap"><a class="item" href="https://github.com/Connor-Moyle/certvault/releases/latest/download/CertVault.apk"><div class="lead c-green">${icon("android")}</div><div class="body"><div class="h">Get the Android app</div><div class="s">Native sharing, open PDFs, "Share to CertVault" from any app, reminders — download the APK</div></div></a></div>`;
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
  // file naming
  let order = (nm.current.name_tokens || "").split(",").filter((t) => nm.tokens[t]);
  const nmVals = () => ({ name_tokens: order.join(","), name_sep: $("#nsep").value, name_datefmt: $("#ndate").value, name_case: $("#ncase").value });
  let pvT;
  const drawNaming = () => {
    $("#norder").innerHTML = order.length ? order.map((t, i) => `<span class="ntok">${i ? `<button class="icon-btn sm" data-left="${i}" aria-label="Move left">${icon("arrow_back", "sm")}</button>` : ""}<b>${esc(nm.tokens[t])}</b><button class="icon-btn sm" data-rm="${t}" aria-label="Remove">${icon("close", "sm")}</button></span>`).join("")
      : `<span class="hint">Nothing picked — titles will be used</span>`;
    $("#navail").innerHTML = Object.entries(nm.tokens).filter(([k]) => !order.includes(k)).map(([k, l]) => `<button type="button" class="fchip" data-add="${k}">${icon("add")}${esc(l)}</button>`).join("");
    $$("[data-left]").forEach((b) => b.addEventListener("click", () => { const i = +b.dataset.left; [order[i - 1], order[i]] = [order[i], order[i - 1]]; drawNaming(); }));
    $$("[data-rm]").forEach((b) => b.addEventListener("click", () => { order = order.filter((t) => t !== b.dataset.rm); drawNaming(); }));
    $$("[data-add]").forEach((b) => b.addEventListener("click", () => { order.push(b.dataset.add); drawNaming(); }));
    clearTimeout(pvT);
    pvT = setTimeout(async () => {
      try { const r = await api("/api/naming/preview", { method: "POST", body: nmVals() });
        $("#nprev").innerHTML = r.preview.length ? `<div class="s">Example</div>${r.preview.map((x) => `<div class="code">${esc(x)}</div>`).join("")}` : `<div class="s">Upload a document to see an example</div>`;
      } catch (e) { /* ignore */ }
    }, 200);
  };
  ["#nsep", "#ndate", "#ncase"].forEach((sel) => $(sel).addEventListener("change", drawNaming));
  drawNaming();
  $("#nsave").addEventListener("click", async () => {
    try { await saveUser({ ...nmVals(), name_titles: $("#ntitles").checked ? "1" : "0", library: $("#nlib").checked ? "1" : "0", share_format: $("#nfmt").value, library_format: $("#nfmt").value }); snack("Saved — NAS copy updating"); } catch (e) { snack(e.message); }
  });
  $("#napply").addEventListener("click", async () => {
    if (!(await confirmDlg("Rename every title?", "All your document titles will be replaced using this naming pattern. You can still edit any title afterwards.", "Rename all", false))) return;
    await saveUser({ ...nmVals() });
    const r = await api("/api/naming/apply-titles", { method: "POST" }); await loadDocs(); snack(`${r.renamed} titles renamed`);
  });
  $("#appsrv") && $("#appsrv").addEventListener("click", () => window.CertVaultAndroid.changeServer());
  $("#wdig").addEventListener("change", (e) => saveUser({ weekly_digest: e.target.checked ? "1" : "0" }).then(() => snack("Saved")));
  $("#afold").addEventListener("change", (e) => saveUser({ auto_folders: e.target.checked ? "1" : "0" }).then(() => snack("Saved")));
  $("#restore") && $("#restore").addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    if (!(await confirmDlg("Restore this backup?", "Everything in CertVault is replaced with the backup. Your current database is kept in the backups folder just in case.", "Restore", true))) return;
    const fd = new FormData(); fd.append("file", f, f.name);
    snack("Uploading backup…", 60000);
    try { const r = await xhrUpload("/api/restore", fd, () => {}); snack(r.message, 15000); setTimeout(() => location.reload(), 12000); } catch (er) { snack(er.message, 8000); }
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
    if (parts[0] === "folders") return await viewFolders();
    if (parts[0] === "timeline") return viewTimeline();
    if (parts[0] === "folder") return await viewFolder(parts[1]);
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
  const cr = await api("/api/categories");
  S.cats = cr.categories; S.kinds = cr.kinds;
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
