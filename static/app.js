/* Job Tracker: browser side.
   Talks to app.py over a small JSON API:
     GET    /api/meta                                   statuses and limits
     GET    /api/applications                           every application (table)
     POST   /api/applications                           add one
     GET    /api/applications/<id>                      one, with contacts and PDFs
     PATCH  /api/applications/<id>                      change fields
     DELETE /api/applications/<id>
     POST   /api/applications/<id>/contacts             PATCH/DELETE /api/contacts/<id>
     POST   /api/applications/<id>/attachments/<kind>   GET/DELETE /api/attachments/<id>  */

"use strict";

const PAGE_SIZE = 100;
const FILTER_LIST_LIMIT = 1000;
const BLANK = "(Blanks)";

const COLUMNS = [
  { key: "id", label: "ID", type: "id" },
  { key: "company", label: "Company", type: "text" },
  { key: "title", label: "Job title", type: "text" },
  { key: "status", label: "Status", type: "status" },
  { key: "location", label: "Location", type: "text" },
  { key: "post_date", label: "Post date", type: "date" },
  { key: "applied_date", label: "Applied date", type: "date" },
  { key: "follow_up_date", label: "Follow-up date", type: "date" },
];
const STATUS_COL = COLUMNS.findIndex((c) => c.key === "status");

// Status colours, used by the chart when you split by Status (light, dark)
const STATUS_COLORS = {
  Applied:      ["#1F4FA8", "#86A9F2"],
  Interviewing: ["#7A5BB5", "#B49BEA"],
  Negotiating:  ["#C98A0B", "#E8C84F"],
  Offer:        ["#2A9D8F", "#5CC2B4"],
  Accepted:     ["#3A7D44", "#7CC48A"],
  Rejected:     ["#B3261E", "#F08A80"],
  Ghosted:      ["#8A94A3", "#7D8898"],
  Withdrawn:    ["#5A6676", "#A3AEBD"],
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const fmt = (n) => n.toLocaleString();
const pad = (n) => String(n).padStart(2, "0");
const idLabel = (id) => "#" + String(id).padStart(3, "0");
const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function fmtDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return dateFmt.format(Date.UTC(y, m - 1, d));
}
function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const state = {
  meta: { statuses: Object.keys(STATUS_COLORS), closed_statuses: [], attachment_kinds: {}, max_pdf_mb: 25 },
  apps: [],              // from /api/applications
  rows: [],              // table rows: arrays in COLUMNS order
  chartRows: [],         // the same rows without the ID, for charts.js
  searchText: [],        // lowercase text per row for the search box
  numeric: [],
  view: [],              // row indexes that pass search + filters, sorted
  sort: { col: 0, dir: -1 },    // newest first
  filters: new Map(),    // column index -> Set(allowed keys)
  search: "",
  page: 0,
  loaded: false,
};

/* ------------------------------------------------------------------ helpers */

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

async function api(url, { method = "GET", body, form } = {}) {
  const options = { method };
  if (form) options.body = form;
  else if (body !== undefined) {
    options.body = JSON.stringify(body);
    options.headers = { "Content-Type": "application/json" };
  }
  let res;
  try { res = await fetch(url, options); }
  catch { throw new Error("Can't reach Job Tracker. Is app.py still running?"); }
  let data;
  try { data = await res.json(); }
  catch { throw new Error(`The server answered with status ${res.status}.`); }
  if (!res.ok) throw new Error(data.error || `Request failed with status ${res.status}.`);
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const t = $("#toast");
  // keep messages above an open pop-up (pop-ups sit on top of everything else)
  const host = document.querySelector("dialog[open]") || document.body;
  if (t.parentElement !== host) host.append(t);
  t.textContent = message;
  t.classList.toggle("error", isError);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), isError ? 5000 : 2200);
}

const keyOf = (v) => (v === null || v === undefined || v === "") ? BLANK : String(v);
const isBlank = (v) => v === null || v === undefined || v === "";
const isClosed = (status) => state.meta.closed_statuses.includes(status);

/** "overdue", "today" or "" for an application's follow-up date */
function followUpState(app) {
  if (!app.follow_up_date || isClosed(app.status)) return "";
  const today = todayISO();
  if (app.follow_up_date < today) return "overdue";
  if (app.follow_up_date === today) return "today";
  return "";
}

function statusSelect(value, onChange, attrs = {}) {
  const select = el("select", { class: "status-pick", ...attrs },
    state.meta.statuses.map((s) => el("option", { value: s }, s)));
  select.value = value;
  select.dataset.status = value;
  select.addEventListener("change", () => {
    select.dataset.status = select.value;
    onChange(select.value);
  });
  return select;
}

function fillStatusSelect(select, value) {
  select.replaceChildren(...state.meta.statuses.map((s) => el("option", { value: s }, s)));
  select.value = value;
  select.dataset.status = value;
}

/* --------------------------------------------------------------- loading */

async function loadAll() {
  try {
    state.meta = await api("/api/meta");
    state.apps = await api("/api/applications");
    state.loaded = true;
  } catch (e) {
    toast(e.message, true);
  }
  rebuildRows();
  render();
}

function rebuildRows() {
  state.rows = state.apps.map((a) => COLUMNS.map((c) => (isBlank(a[c.key]) ? null : a[c.key])));
  state.chartRows = state.rows.map((r) => r.slice(1));
  state.searchText = state.apps.map((a) =>
    [idLabel(a.id), a.company, a.title, a.status, a.location, a.salary, a.contact_names, a.log_text, a.description]
      .filter(Boolean).join("\n").toLowerCase());
  state.numeric = COLUMNS.map((c) => c.type === "id");
}

/** Put a changed application (from the server) back into the table. */
function upsertApp(detail) {
  const listShape = {
    ...detail,
    contact_names: (detail.contacts || []).map((c) => c.name).filter(Boolean).join(", ") || null,
    contact_count: (detail.contacts || []).length,
    attachment_kinds: (detail.attachments || []).map((a) => a.kind).join(",") || null,
    log_text: detail.log_text ?? (detail.logs || []).map((log) =>
      `${log.log_date} [${log.status}] ${log.notes}`).join("\n"),
  };
  delete listShape.contacts;
  delete listShape.logs;
  delete listShape.attachments;
  const i = state.apps.findIndex((a) => a.id === detail.id);
  if (i >= 0) state.apps[i] = listShape;
  else state.apps.unshift(listShape);
  rebuildRows();
  render();
}

/* ----------------------------------------------------------- filtering */

function passes(i, skipCol) {
  if (state.search && !state.searchText[i].includes(state.search)) return false;
  const row = state.rows[i];
  for (const [c, allowed] of state.filters) {
    if (c === skipCol) continue;
    if (!allowed.has(keyOf(row[c]))) return false;
  }
  return true;
}

function computeView() {
  const rows = state.rows;
  const idx = [];
  for (let i = 0; i < rows.length; i++) if (passes(i, -1)) idx.push(i);
  const { col, dir } = state.sort;
  if (col >= 0) {
    const num = state.numeric[col];
    idx.sort((a, b) => {
      const x = rows[a][col], y = rows[b][col];
      const xb = isBlank(x), yb = isBlank(y);
      if (xb || yb) return xb === yb ? a - b : (xb ? 1 : -1);      // blanks always last
      const cmp = num ? x - y : collator.compare(String(x), String(y));
      return cmp * dir || a - b;
    });
  }
  state.view = idx;
  const pages = Math.max(1, Math.ceil(idx.length / PAGE_SIZE));
  state.page = Math.min(state.page, pages - 1);
}

/* -------------------------------------------------------------- render */

function render() {
  computeView();
  renderStatusChips();
  renderStats();
  renderFilterChips();
  renderTable();
  renderPager();
  notifyCharts();
}

function renderStatusChips() {
  const counts = new Map(state.meta.statuses.map((s) => [s, 0]));
  let all = 0;
  for (let i = 0; i < state.rows.length; i++) {
    if (!passes(i, STATUS_COL)) continue;
    all++;
    const s = state.rows[i][STATUS_COL];
    counts.set(s, (counts.get(s) || 0) + 1);
  }
  const active = state.filters.get(STATUS_COL);
  const only = active && active.size === 1 ? [...active][0] : null;

  const chip = (label, count, status, pressed) => el("button", {
    type: "button",
    class: "status-chip",
    dataset: status ? { status } : {},
    "aria-pressed": String(pressed),
    onclick: () => {
      if (!status || pressed) state.filters.delete(STATUS_COL);
      else state.filters.set(STATUS_COL, new Set([status]));
      state.page = 0;
      render();
    },
  }, el("span", { class: "chip-label" }, label), el("span", { class: "chip-count" }, fmt(count)));

  $("#status-chips").replaceChildren(
    chip("All", all, null, !active),
    ...state.meta.statuses.map((s) => chip(s, counts.get(s) || 0, s, only === s)));
}

function renderStats() {
  const shown = state.view.length, total = state.rows.length;
  const filtered = state.filters.size || state.search;
  $("#row-count").textContent = filtered
    ? `${fmt(shown)} of ${fmt(total)} applications`
    : `${fmt(total)} ${total === 1 ? "application" : "applications"}`;
  $("#download-csv").disabled = shown === 0;
}

function renderFilterChips() {
  const wrap = $("#filter-chips");
  wrap.replaceChildren();
  for (const [c, allowed] of state.filters) {
    const col = COLUMNS[c];
    const one = [...allowed][0];
    const label = allowed.size === 1 ? `${col.label}: ${col.type === "date" && one !== BLANK ? fmtDate(one) : one}`
                                     : `${col.label}: ${fmt(allowed.size)} values`;
    wrap.append(el("span", { class: "chip" }, label,
      el("button", { type: "button", "aria-label": `Remove filter on ${col.label}`,
        onclick: () => { state.filters.delete(c); state.page = 0; render(); } }, "×")));
  }
  if (state.search) {
    wrap.append(el("span", { class: "chip" }, `Search: ${$("#search").value.trim()}`,
      el("button", { type: "button", "aria-label": "Clear search",
        onclick: () => { $("#search").value = ""; state.search = ""; state.page = 0; render(); } }, "×")));
  }
}

const FUNNEL = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M1.5 2h13a.5.5 0 0 1 .39.81L10 8.9V13a.5.5 0 0 1-.28.45l-3 1.5A.5.5 0 0 1 6 14.5V8.9L1.11 2.81A.5.5 0 0 1 1.5 2z"/></svg>';

function renderTable() {
  const hasApps = state.rows.length > 0;
  $("#results-empty").hidden = hasApps || !state.loaded;
  $("#grid-wrap").hidden = !hasApps;
  if (!hasApps) return;

  const headRow = el("tr");
  COLUMNS.forEach((col, c) => {
    const sorted = state.sort.col === c;
    const sortBtn = el("button", {
      type: "button", class: "sort", "aria-label": `Sort by ${col.label}`,
      onclick: () => {
        if (state.sort.col !== c) state.sort = { col: c, dir: col.type === "id" ? -1 : 1 };
        else if (state.sort.dir === (col.type === "id" ? -1 : 1)) state.sort.dir *= -1;
        else state.sort = { col: 0, dir: -1 };
        render();
      },
    }, el("span", { class: "col-name" }, col.label,
         el("span", { class: "sort-ind", "aria-hidden": "true" }, sorted ? (state.sort.dir === 1 ? "▲" : "▼") : "")));

    const filterBtn = el("button", {
      type: "button", class: "filter-btn" + (state.filters.has(c) ? " active" : ""),
      "aria-label": `Filter ${col.label}`,
      onclick: (e) => { e.stopPropagation(); openFilter(c, e.currentTarget); },
    });
    filterBtn.innerHTML = FUNNEL;

    headRow.append(el("th", {
      scope: "col", class: `col-${col.key}`,
      "aria-sort": sorted ? (state.sort.dir === 1 ? "ascending" : "descending") : false,
    }, el("div", { class: "th" }, sortBtn, filterBtn)));
    if (col.key === "id") {
      headRow.append(el("th", { scope: "col", class: "col-link" },
        el("span", { class: "link-head" }, "Link")));
    }
  });

  const tbody = el("tbody");
  const start = state.page * PAGE_SIZE;
  const slice = state.view.slice(start, start + PAGE_SIZE);
  if (!slice.length) {
    tbody.append(el("tr", { class: "no-match" }, el("td", { colspan: COLUMNS.length + 1 },
      "No applications match. Clear the search or a filter to see more.")));
  }
  for (const ri of slice) tbody.append(renderRow(ri));
  $("#grid").replaceChildren(el("thead", {}, headRow), tbody);
}

function renderRow(ri) {
  const app = state.apps[ri];
  const tr = el("tr", { class: isClosed(app.status) ? "closed" : "" });
  COLUMNS.forEach((col) => {
    const v = app[col.key];
    let td;
    if (col.type === "id") {
      td = el("td", { class: "col-id" }, el("button", {
        type: "button", class: "id-link", title: "Open details",
        onclick: () => openDetail(app.id),
      }, idLabel(app.id)));
    } else if (col.type === "status") {
      td = el("td", { class: "col-status" }, statusSelect(app.status, (s) => changeStatus(app.id, s),
        { "aria-label": `Status of ${idLabel(app.id)}` }));
    } else if (col.type === "date") {
      td = el("td", { class: `col-date col-${col.key}` }, fmtDate(v));
      if (col.key === "follow_up_date") {
        const due = followUpState(app);
        if (due) td.append(" ", el("span", { class: `due-tag ${due}` }, due === "overdue" ? "Overdue" : "Today"));
      }
    } else {
      td = el("td", { class: `col-${col.key}` }, v || "");
      if (v && v.length > 32) td.title = v;
      if (col.key === "title") {
        const extras = [];
        if (app.contact_count) extras.push(`${app.contact_count} contact${app.contact_count === 1 ? "" : "s"}`);
        if (app.attachment_kinds) extras.push(app.attachment_kinds.split(",").length === 2 ? "2 PDFs" : "1 PDF");
        if (extras.length) td.append(el("span", { class: "row-extras" }, extras.join(", ")));
      }
    }
    tr.append(td);
    if (col.key === "id") tr.append(renderJobLink(app));
  });
  return tr;
}

function renderJobLink(app) {
  const rawUrl = (app.job_url || "").trim();
  const url = rawUrl && (/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
  return el("td", { class: "col-link" },
    url
      ? el("a", {
          class: "job-link",
          href: url,
          target: "_blank",
          rel: "noopener noreferrer",
          title: "Open job posting",
          "aria-label": `Open job posting for ${app.company}`,
        }, "↗")
      : el("span", { class: "job-link-empty", title: "No job link" }, "—"));
}

function renderPager() {
  const total = state.view.length;
  const pages = Math.ceil(total / PAGE_SIZE);
  const pager = $("#pager");
  pager.hidden = pages <= 1;
  if (pages <= 1) return;
  const start = state.page * PAGE_SIZE + 1;
  const end = Math.min(total, start + PAGE_SIZE - 1);
  $("#pager-label").textContent = `${fmt(start)} to ${fmt(end)} of ${fmt(total)}`;
  pager.querySelector('[data-page="first"]').disabled = state.page === 0;
  pager.querySelector('[data-page="prev"]').disabled = state.page === 0;
  pager.querySelector('[data-page="next"]').disabled = state.page >= pages - 1;
  pager.querySelector('[data-page="last"]').disabled = state.page >= pages - 1;
}

async function changeStatus(id, status) {
  try {
    const detail = await api(`/api/applications/${id}`, { method: "PATCH", body: { status } });
    upsertApp(detail);
    toast(`${idLabel(id)} is now ${status}`);
  } catch (e) {
    toast(e.message, true);
    render();
  }
}

/* --------------------------------------------------------- column filter */

const filterUI = { col: -1, values: [], counts: null, checked: null, anchor: null };

function filterLabel(col, v) {
  return COLUMNS[col].type === "date" && v !== BLANK ? fmtDate(v)
       : COLUMNS[col].type === "id" ? idLabel(v) : v;
}

function openFilter(col, anchor) {
  if (filterUI.col === col && !$("#filter-pop").hidden) { closeFilter(); return; }
  const counts = new Map();
  for (let i = 0; i < state.rows.length; i++) {
    if (!passes(i, col)) continue;
    const k = keyOf(state.rows[i][col]);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const num = state.numeric[col];
  const isStatus = COLUMNS[col].type === "status";
  const values = [...counts.keys()].sort((a, b) => {
    if (a === BLANK || b === BLANK) return a === b ? 0 : (a === BLANK ? 1 : -1);
    if (isStatus) return state.meta.statuses.indexOf(a) - state.meta.statuses.indexOf(b);
    return num ? Number(a) - Number(b) : collator.compare(a, b);
  });
  const current = state.filters.get(col);
  Object.assign(filterUI, { col, values, counts, anchor,
    checked: new Set(current ? values.filter((v) => current.has(v)) : values) });

  $("#filter-title").textContent = `Filter ${COLUMNS[col].label}`;
  $("#filter-search").value = "";
  renderFilterList();
  $("#filter-pop").hidden = false;
  positionFilter();
  $("#filter-search").focus();
}

function positionFilter() {
  const pop = $("#filter-pop");
  if (pop.hidden || !filterUI.anchor) return;
  const r = filterUI.anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
  let top = r.bottom + 4;
  if (top + pop.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - pop.offsetHeight - 4);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function visibleFilterValues() {
  const q = $("#filter-search").value.trim().toLowerCase();
  return q ? filterUI.values.filter((v) => String(filterLabel(filterUI.col, v)).toLowerCase().includes(q))
           : filterUI.values;
}

function renderFilterList() {
  const list = $("#filter-list");
  const visible = visibleFilterValues();
  list.replaceChildren(...visible.slice(0, FILTER_LIST_LIMIT).map((v) => {
    const cb = el("input", { type: "checkbox", checked: filterUI.checked.has(v) });
    cb.addEventListener("change", () => {
      cb.checked ? filterUI.checked.add(v) : filterUI.checked.delete(v);
      syncSelectAll();
    });
    const label = filterLabel(filterUI.col, v);
    return el("label", {}, cb,
      el("span", { class: "val" + (v === BLANK ? " blank" : ""), title: label }, label),
      el("span", { class: "cnt" }, fmt(filterUI.counts.get(v))));
  }));
  if (!visible.length) list.append(el("p", { class: "filter-note" }, "No values match."));
  $("#filter-note").textContent = visible.length > FILTER_LIST_LIMIT
    ? `Showing ${fmt(FILTER_LIST_LIMIT)} of ${fmt(visible.length)} values. Search to narrow the list.` : "";
  syncSelectAll();
}

function syncSelectAll() {
  const visible = visibleFilterValues();
  const n = visible.filter((v) => filterUI.checked.has(v)).length;
  const all = $("#filter-all");
  all.checked = visible.length > 0 && n === visible.length;
  all.indeterminate = n > 0 && n < visible.length;
}

function applyFilter() {
  const { col, values, checked } = filterUI;
  if (checked.size === values.length) state.filters.delete(col);
  else state.filters.set(col, new Set(checked));
  state.page = 0;
  closeFilter();
  render();
}

function closeFilter() {
  $("#filter-pop").hidden = true;
  const anchor = filterUI.anchor;
  filterUI.col = -1;
  filterUI.anchor = null;
  if (anchor && document.body.contains(anchor)) anchor.focus({ preventScroll: true });
}

/* -------------------------------------------------------------------- CSV */

function downloadCsv() {
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const cols = [...COLUMNS.map((c) => [c.key, c.label]), ["salary", "Salary"], ["job_url", "Job link"],
                ["contact_names", "Contacts"], ["log_text", "Log"]];
  const lines = [cols.map(([, label]) => esc(label)).join(",")];
  for (const i of state.view) {
    const a = state.apps[i];
    lines.push(cols.map(([key]) => esc(key === "id" ? idLabel(a.id) : a[key])).join(","));
  }
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: `job_applications_${todayISO()}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(`Downloaded ${fmt(state.view.length)} applications`);
}

/* ------------------------------------------------------- dialogs: shared */

// Close a dialog when you click the dark area around it (not when a drag
// that started inside ends outside).
function closeOnBackdrop(dialog) {
  let downOnBackdrop = false;
  dialog.addEventListener("mousedown", (e) => { downOnBackdrop = e.target === dialog; });
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog && downOnBackdrop) dialog.close();
  });
  dialog.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) dialog.close();
  });
}

/* ---------------------------------------------------- add application */

const addDialog = $("#add-dialog");
const addForm = $("#add-form");

function openAdd() {
  addForm.reset();
  fillStatusSelect(addForm.elements.status, "Applied");
  addForm.elements.applied_date.value = todayISO();
  $("#add-error").textContent = "";
  addDialog.showModal();
  addForm.elements.company.focus();
}

addForm.elements.status?.addEventListener("change", (e) => { e.target.dataset.status = e.target.value; });

addForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = addForm.elements;
  const body = {
    company: f.company.value.trim(), title: f.title.value.trim(), status: f.status.value,
    applied_date: f.applied_date.value, post_date: f.post_date.value,
    follow_up_date: f.follow_up_date.value, location: f.location.value.trim(),
    salary: f.salary.value.trim(), job_url: f.job_url.value.trim(),
    description: f.description.value.trim(), initial_log: f.initial_log.value.trim(),
  };
  if (!body.company || !body.title) {
    $("#add-error").textContent = "Company and job title are both needed.";
    (body.company ? f.title : f.company).focus();
    return;
  }
  try {
    const detail = await api("/api/applications", { method: "POST", body });
    addDialog.close();
    upsertApp(detail);
    toast(`Added ${idLabel(detail.id)}: ${detail.title} at ${detail.company}`);
  } catch (err) {
    $("#add-error").textContent = err.message;
  }
});

/* ------------------------------------------------------ details pop-up */

const detail = $("#detail");
const ui = {
  current: null,          // the open application, with contacts and attachments
  tab: "info",
  pending: {},            // fields typed but not saved yet
  timer: null,
  saving: Promise.resolve(),
  logSaving: null,
  editingContact: null,   // contact id, "new", or null
  editingLog: null,       // log id, "new", or null
  deleteArmed: false,
};

async function openDetail(id, tab = "info") {
  let data;
  try { data = await api(`/api/applications/${id}`); }
  catch (e) { toast(e.message, true); return; }

  ui.current = data;
  ui.pending = {};
  ui.editingContact = null;
  ui.editingLog = null;
  disarmDelete();
  setSaveState("");

  for (const input of $$("[data-field]", detail)) {
    if (input.tagName === "SELECT") fillStatusSelect(input, data.status);
    else input.value = data[input.dataset.field] ?? "";
  }
  renderDetailHeader();
  renderContacts();
  renderLogs();
  renderFiles();
  setTab(tab);
  if (!detail.open) detail.showModal();
}

function renderDetailHeader() {
  const a = ui.current;
  $("#detail-id").textContent = idLabel(a.id);
  $("#detail-title").textContent = $('[data-field="title"]', detail).value || a.title;
  $("#detail-company").textContent = $('[data-field="company"]', detail).value || a.company;
  const url = $('[data-field="job_url"]', detail).value.trim();
  const link = $("#open-link");
  link.hidden = !url;
  if (url) link.href = /^https?:\/\//i.test(url) ? url : "https://" + url;
  $("#contacts-count").textContent = a.contacts.length ? a.contacts.length : "";
  $("#logs-count").textContent = a.logs.length ? a.logs.length : "";
  $("#files-count").textContent = a.attachments.length ? a.attachments.length : "";
}

function setTab(name) {
  ui.tab = name;
  for (const b of $$(".tabs [data-tab]", detail)) {
    const on = b.dataset.tab === name;
    b.setAttribute("aria-selected", String(on));
    b.tabIndex = on ? 0 : -1;
  }
  for (const p of $$("[data-panel]", detail)) p.hidden = p.dataset.panel !== name;
}

$(".tabs", detail).addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (b) setTab(b.dataset.tab);
});
$(".tabs", detail).addEventListener("keydown", (e) => {
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
  const tabs = $$(".tabs [data-tab]", detail);
  const i = tabs.findIndex((t) => t.dataset.tab === ui.tab);
  const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
  setTab(next.dataset.tab);
  next.focus();
});

/* ---- saving as you type */

function setSaveState(text, isError = false) {
  const s = $("#save-state");
  s.textContent = text;
  s.classList.toggle("error", isError);
}

detail.addEventListener("input", (e) => {
  const input = e.target.closest("[data-field]");
  if (!input || !ui.current) return;
  ui.pending[input.dataset.field] = input.value;
  if (["title", "company", "job_url"].includes(input.dataset.field)) renderDetailHeader();
  setSaveState("Editing…");
  clearTimeout(ui.timer);
  ui.timer = setTimeout(flushSave, 700);
});

detail.addEventListener("change", (e) => {
  const input = e.target.closest("[data-field]");
  if (!input || !ui.current) return;
  ui.pending[input.dataset.field] = input.value;
  if (input.tagName === "SELECT") input.dataset.status = input.value;
  flushSave();
});

function flushSave() {
  clearTimeout(ui.timer);
  const patch = ui.pending;
  if (!ui.current || !Object.keys(patch).length) return ui.saving;
  ui.pending = {};
  const id = ui.current.id;
  ui.saving = ui.saving.then(async () => {
    setSaveState("Saving…");
    try {
      const fresh = await api(`/api/applications/${id}`, { method: "PATCH", body: patch });
      if (ui.current && ui.current.id === id) {
        ui.current = { ...ui.current, ...fresh };
        renderDetailHeader();
      }
      upsertApp(fresh);
      setSaveState(`Saved ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
    } catch (e) {
      setSaveState(e.message, true);
      toast(e.message, true);
    }
  });
  return ui.saving;
}

detail.addEventListener("close", async () => {
  await saveOpenContactForm();
  await saveOpenLogForm();
  await flushSave();
  disarmDelete();
  ui.editingLog = null;
  ui.current = null;
});

/* ---- contacts */

const CONTACT_INPUTS = [
  ["name", "Name", "text", "span-2"], ["role", "Role", "text", "", "Recruiter, Hiring manager…"],
  ["email", "Email", "email"], ["phone", "Phone", "tel"], ["linkedin", "LinkedIn", "url", "", "https://linkedin.com/in/…"],
  ["notes", "Notes", "textarea", "span-2"],
];

function renderContacts() {
  const list = $("#contact-list");
  const contacts = ui.current.contacts;
  list.replaceChildren();

  if (!contacts.length && ui.editingContact !== "new") {
    list.append(el("p", { class: "panel-empty" }, "No contacts yet. Add the recruiter or hiring manager here."));
  }
  for (const c of contacts) {
    list.append(ui.editingContact === c.id ? contactForm(c) : contactCard(c));
  }
  if (ui.editingContact === "new") list.append(contactForm(null));
  $("#add-contact").hidden = ui.editingContact !== null;
}

function contactCard(c) {
  const lines = [];
  if (c.email) lines.push(el("a", { href: `mailto:${c.email}` }, c.email));
  if (c.phone) lines.push(el("a", { href: `tel:${c.phone.replace(/[^\d+]/g, "")}` }, c.phone));
  if (c.linkedin) lines.push(el("a", { href: c.linkedin, target: "_blank", rel: "noopener" }, "LinkedIn"));

  const del = el("button", { type: "button", class: "btn-link danger" }, "Delete");
  del.addEventListener("click", async () => {
    if (!del.dataset.armed) {
      del.dataset.armed = "1";
      del.textContent = "Click again to delete";
      setTimeout(() => { if (del.isConnected) { delete del.dataset.armed; del.textContent = "Delete"; } }, 4000);
      return;
    }
    try {
      await api(`/api/contacts/${c.id}`, { method: "DELETE" });
      ui.current.contacts = ui.current.contacts.filter((x) => x.id !== c.id);
      afterContactsChanged();
      toast(`Deleted ${c.name}`);
    } catch (e) { toast(e.message, true); }
  });

  return el("article", { class: "contact-card" },
    el("div", { class: "contact-main" },
      el("p", { class: "contact-name" }, c.name, c.role ? el("span", { class: "contact-role" }, c.role) : null),
      lines.length ? el("p", { class: "contact-lines" }, lines.flatMap((l, i) => (i ? [el("span", { class: "sep", "aria-hidden": "true" }, "|"), l] : [l]))) : null,
      c.notes ? el("p", { class: "contact-notes" }, c.notes) : null),
    el("div", { class: "contact-actions" },
      el("button", { type: "button", class: "btn-link", onclick: () => { ui.editingContact = c.id; renderContacts(); focusContactForm(); } }, "Edit"),
      del));
}

function contactForm(c) {
  const form = el("form", { class: "contact-form form-grid", novalidate: true });
  for (const [key, label, type, span = "", placeholder] of CONTACT_INPUTS) {
    const input = type === "textarea"
      ? el("textarea", { name: key, rows: "3" })
      : el("input", { name: key, type, autocomplete: "off", placeholder });
    input.value = c ? c[key] || "" : "";
    form.append(el("label", { class: `field ${span}` }, label, input));
  }
  form.append(
    el("p", { class: "form-error span-2", role: "alert" }),
    el("div", { class: "form-buttons span-2" },
      el("button", { type: "submit", class: "btn btn-primary btn-small" }, c ? "Save contact" : "Add contact"),
      el("button", { type: "button", class: "btn btn-quiet btn-small", onclick: () => { ui.editingContact = null; renderContacts(); } }, "Cancel")));
  form.dataset.original = JSON.stringify(readContactForm(form));
  form.addEventListener("submit", (e) => { e.preventDefault(); saveContactForm(form, c); });
  return form;
}

function readContactForm(form) {
  return Object.fromEntries(CONTACT_INPUTS.map(([key]) => [key, form.elements[key].value.trim()]));
}

async function saveContactForm(form, c) {
  const body = readContactForm(form);
  if (!body.name) {
    form.querySelector(".form-error").textContent = "A contact needs at least a name.";
    form.elements.name.focus();
    return false;
  }
  try {
    if (c) {
      const fresh = await api(`/api/contacts/${c.id}`, { method: "PATCH", body });
      ui.current.contacts = ui.current.contacts.map((x) => (x.id === c.id ? fresh : x));
    } else {
      const fresh = await api(`/api/applications/${ui.current.id}/contacts`, { method: "POST", body });
      ui.current.contacts.push(fresh);
    }
    ui.editingContact = null;
    afterContactsChanged();
    return true;
  } catch (e) {
    form.querySelector(".form-error").textContent = e.message;
    return false;
  }
}

/** If the pop-up closes while a contact form has changes, keep them. */
async function saveOpenContactForm() {
  const form = $(".contact-form", detail);
  if (!form || !ui.current) return;
  if (form.dataset.original === JSON.stringify(readContactForm(form))) return;
  const c = ui.current.contacts.find((x) => x.id === ui.editingContact) || null;
  if (await saveContactForm(form, c)) toast("Saved the contact you were editing");
}

function focusContactForm() {
  const input = $(".contact-form input", detail);
  if (input) input.focus();
}

function afterContactsChanged() {
  renderContacts();
  renderDetailHeader();
  upsertApp(ui.current);
}

$("#add-contact").addEventListener("click", () => {
  ui.editingContact = "new";
  renderContacts();
  focusContactForm();
});

/* ---- application log */

function renderLogs() {
  const list = $("#log-list");
  const logs = ui.current.logs || [];
  list.replaceChildren();

  if (!logs.length && ui.editingLog !== "new") {
    list.append(el("p", { class: "panel-empty" }, "No log entries yet. Add the first update here."));
  }
  for (const log of logs) {
    list.append(ui.editingLog === log.id ? logForm(log) : logCard(log));
  }
  if (ui.editingLog === "new") list.append(logForm(null));
  $("#add-log").hidden = ui.editingLog !== null;
}

function logCard(log) {
  const del = el("button", { type: "button", class: "btn-link danger" }, "Delete");
  del.addEventListener("click", async () => {
    if (!del.dataset.armed) {
      del.dataset.armed = "1";
      del.textContent = "Click again to delete";
      setTimeout(() => {
        if (del.isConnected) { delete del.dataset.armed; del.textContent = "Delete"; }
      }, 4000);
      return;
    }
    try {
      const fresh = await api(`/api/logs/${log.id}`, { method: "DELETE" });
      ui.current = fresh;
      ui.editingLog = null;
      renderLogs();
      renderDetailHeader();
      upsertApp(fresh);
      toast("Deleted log entry");
    } catch (e) { toast(e.message, true); }
  });

  return el("article", { class: "log-card" },
    el("div", { class: "log-card-head" },
      el("div", { class: "log-meta" },
        el("time", { datetime: log.log_date }, fmtDate(log.log_date)),
        el("span", { class: "log-status", dataset: { status: log.status } }, log.status)),
      el("div", { class: "log-actions" },
        el("button", {
          type: "button", class: "btn-link",
          onclick: () => { ui.editingLog = log.id; renderLogs(); },
        }, "Edit"),
        del)),
    el("p", { class: "log-note" }, log.notes));
}

function logForm(log) {
  const form = el("form", { class: "log-form form-grid", novalidate: true });
  const date = el("input", { name: "log_date", type: "date", required: true });
  date.value = log ? log.log_date : todayISO();
  const status = el("select", { name: "status", class: "status-pick" });
  fillStatusSelect(status, log ? log.status : ($("#detail-status").value || ui.current.status));
  status.addEventListener("change", () => { status.dataset.status = status.value; });
  const notes = el("textarea", {
    name: "notes", rows: "4", required: true,
    placeholder: "What happened?",
  });
  notes.value = log ? log.notes : "";

  form.append(
    el("label", { class: "field" }, "Date", date),
    el("label", { class: "field" }, "Status", status),
    el("label", { class: "field span-2" }, "Log notes", notes),
    el("p", { class: "form-error span-2", role: "alert" }),
    el("div", { class: "form-buttons span-2" },
      el("button", { type: "submit", class: "btn btn-primary btn-small" }, log ? "Save log" : "Add log"),
      el("button", {
        type: "button", class: "btn btn-quiet btn-small",
        onclick: () => { ui.editingLog = null; renderLogs(); },
      }, "Cancel")));
  form.dataset.original = JSON.stringify(readLogForm(form));
  form.addEventListener("submit", (e) => { e.preventDefault(); saveLogForm(form, log); });
  return form;
}

function readLogForm(form) {
  return {
    log_date: form.elements.log_date.value,
    status: form.elements.status.value,
    notes: form.elements.notes.value.trim(),
  };
}

async function saveLogForm(form, log) {
  if (ui.logSaving) return ui.logSaving;
  const body = readLogForm(form);
  const error = form.querySelector(".form-error");
  if (!body.log_date || !body.notes) {
    error.textContent = "A log needs a date and notes.";
    (!body.log_date ? form.elements.log_date : form.elements.notes).focus();
    return false;
  }
  for (const control of form.elements) control.disabled = true;
  ui.logSaving = (async () => {
    try {
      const fresh = log
        ? await api(`/api/logs/${log.id}`, { method: "PATCH", body })
        : await api(`/api/applications/${ui.current.id}/logs`, { method: "POST", body });
      ui.current = fresh;
      ui.editingLog = null;
      renderLogs();
      renderDetailHeader();
      upsertApp(fresh);
      toast(log ? "Saved log entry" : "Added log entry");
      return true;
    } catch (e) {
      error.textContent = e.message;
      for (const control of form.elements) control.disabled = false;
      return false;
    } finally {
      ui.logSaving = null;
    }
  })();
  return ui.logSaving;
}

async function saveOpenLogForm() {
  if (ui.logSaving) {
    await ui.logSaving;
    return;
  }
  const form = $(".log-form", detail);
  if (!form || !ui.current) return;
  const body = readLogForm(form);
  if (form.dataset.original === JSON.stringify(body)) return;
  if (ui.editingLog === "new" && !body.notes) return;
  const log = ui.current.logs.find((item) => item.id === ui.editingLog) || null;
  await saveLogForm(form, log);
}

$("#add-log").addEventListener("click", () => {
  ui.editingLog = "new";
  renderLogs();
  $("textarea[name='notes']", $("#log-list")).focus();
});

/* ---- PDF attachments: one resume and one cover letter */

const PDF_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 1.5V9h5.5L13 3.5zM7.5 13v5h1.2v-1.6h.8c1 0 1.7-.6 1.7-1.7S10.5 13 9.5 13h-2zm1.2 1h.7c.4 0 .6.3.6.7s-.2.7-.6.7h-.7V14zm3 -1v5h1.6c1.4 0 2.3-.9 2.3-2.5S14.7 13 13.3 13h-1.6zm1.2 1h.3c.8 0 1.2.5 1.2 1.5s-.4 1.5-1.2 1.5h-.3v-3zm3.4-1v5h1.2v-2h1.7v-1h-1.7v-1h1.9v-1h-3.1z"/></svg>';

function renderFiles() {
  const kinds = state.meta.attachment_kinds;
  const order = ["resume", "cover_letter"];                 // resume first
  const entries = Object.entries(kinds).sort(([a], [b]) => order.indexOf(a) - order.indexOf(b));
  $("#file-slots").replaceChildren(...entries.map(([kind, label]) => fileSlot(kind, label)));
}

function fileSlot(kind, label) {
  const att = ui.current.attachments.find((a) => a.kind === kind);
  const input = el("input", { type: "file", accept: "application/pdf,.pdf", hidden: true });
  input.addEventListener("change", () => { if (input.files[0]) uploadPdf(kind, input.files[0]); });

  const slot = el("section", { class: "file-slot" + (att ? " has-file" : ""), "aria-label": label },
    el("h3", { class: "slot-title" }, label), input);

  if (att) {
    const remove = el("button", { type: "button", class: "btn-link danger" }, "Remove");
    remove.addEventListener("click", async () => {
      if (!remove.dataset.armed) {
        remove.dataset.armed = "1";
        remove.textContent = "Click again to remove";
        setTimeout(() => { if (remove.isConnected) { delete remove.dataset.armed; remove.textContent = "Remove"; } }, 4000);
        return;
      }
      try {
        await api(att.url, { method: "DELETE" });
        ui.current.attachments = ui.current.attachments.filter((a) => a.id !== att.id);
        afterFilesChanged();
        toast(`Removed the ${label.toLowerCase()}`);
      } catch (e) { toast(e.message, true); }
    });
    const icon = el("span", { class: "pdf-icon" });
    icon.innerHTML = PDF_ICON;
    slot.append(
      el("div", { class: "file-row" }, icon,
        el("div", { class: "file-info" },
          el("a", { class: "file-name", href: att.url, target: "_blank", rel: "noopener", title: "Open in a new tab" }, att.filename),
          el("span", { class: "file-meta" }, `${fmtSize(att.size)}, added ${fmtDate(att.uploaded_at.slice(0, 10))}`))),
      el("div", { class: "file-actions" },
        el("a", { class: "btn btn-quiet btn-small", href: att.url, target: "_blank", rel: "noopener" }, "Open"),
        el("a", { class: "btn btn-quiet btn-small", href: `${att.url}?download=1` }, "Download"),
        el("button", { type: "button", class: "btn btn-quiet btn-small", onclick: () => input.click() }, "Replace"),
        remove),
      el("p", { class: "drop-hint" }, "Drop a PDF here to replace it."));
  } else {
    slot.append(el("div", { class: "drop-zone" },
      el("p", {}, `No ${label.toLowerCase()} attached.`),
      el("p", {}, "Drop a PDF here or ",
        el("button", { type: "button", class: "btn btn-quiet btn-small", onclick: () => input.click() }, "Choose file"))));
  }

  // drag and drop
  slot.addEventListener("dragover", (e) => { e.preventDefault(); slot.classList.add("drag-over"); });
  slot.addEventListener("dragleave", (e) => { if (!slot.contains(e.relatedTarget)) slot.classList.remove("drag-over"); });
  slot.addEventListener("drop", (e) => {
    e.preventDefault();
    slot.classList.remove("drag-over");
    const file = e.dataTransfer.files[0];
    if (file) uploadPdf(kind, file);
  });
  return slot;
}

async function uploadPdf(kind, file) {
  const label = state.meta.attachment_kinds[kind];
  if (!/\.pdf$/i.test(file.name)) { toast("Only PDF files can be attached.", true); return; }
  if (file.size > state.meta.max_pdf_mb * 1024 * 1024) {
    toast(`That file is too big. PDFs can be up to ${state.meta.max_pdf_mb} MB.`, true);
    return;
  }
  const id = ui.current.id;
  const form = new FormData();
  form.append("file", file);
  setSaveState(`Uploading ${file.name}…`);
  try {
    const att = await api(`/api/applications/${id}/attachments/${kind}`, { method: "POST", form });
    if (ui.current && ui.current.id === id) {
      ui.current.attachments = [...ui.current.attachments.filter((a) => a.kind !== kind), att];
      afterFilesChanged();
    }
    setSaveState(`Saved ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
    toast(`Attached ${label.toLowerCase()}: ${att.filename}`);
  } catch (e) {
    setSaveState(e.message, true);
    toast(e.message, true);
  }
}

function afterFilesChanged() {
  renderFiles();
  renderDetailHeader();
  upsertApp(ui.current);
}

// a PDF dropped anywhere else in the pop-up shouldn't open in the browser
detail.addEventListener("dragover", (e) => e.preventDefault());
detail.addEventListener("drop", (e) => e.preventDefault());

/* ---- delete application */

function disarmDelete() {
  ui.deleteArmed = false;
  const b = $("#delete-app");
  b.textContent = "Delete application";
  b.classList.remove("armed");
}

$("#delete-app").addEventListener("click", async () => {
  const b = $("#delete-app");
  if (!ui.deleteArmed) {
    ui.deleteArmed = true;
    b.textContent = "Click again to delete it, with its contacts and PDFs";
    b.classList.add("armed");
    setTimeout(() => { if (ui.deleteArmed) disarmDelete(); }, 5000);
    return;
  }
  const { id, title, company } = ui.current;
  try {
    ui.pending = {};
    clearTimeout(ui.timer);
    await api(`/api/applications/${id}`, { method: "DELETE" });
    ui.editingContact = null;
    detail.close();
    state.apps = state.apps.filter((a) => a.id !== id);
    rebuildRows();
    render();
    toast(`Deleted ${idLabel(id)}: ${title} at ${company}`);
  } catch (e) {
    toast(e.message, true);
  }
});

closeOnBackdrop(addDialog);
closeOnBackdrop(detail);

/* ------------------------------------------- hooks for charts.js */
// charts.js lives in its own file; it listens for "sqlx:results" and reads
// or sets the table's filters through window.SQLX (same contract as in
// SQL Explorer, so the Graph code is shared).

function filtersByName() {
  const out = {};
  for (const [c, allowed] of state.filters) out[COLUMNS[c].label] = [...allowed];
  return out;
}

function snapshot() {
  const filters = filtersByName();
  if (state.search) filters.Search = [$("#search").value.trim()];
  return {
    file: { name: "Applications", path: "applications" },
    columns: COLUMNS.slice(1).map((c) => c.label),     // the ID isn't useful on a chart
    rows: state.chartRows,
    view: state.view,
    numeric: state.numeric.slice(1),
    filters,
    hasResult: state.rows.length > 0,
  };
}

function notifyCharts() {
  document.dispatchEvent(new CustomEvent("sqlx:results", { detail: snapshot() }));
}

window.SQLX = {
  snapshot,
  getFilters: filtersByName,
  setFilters(byName) {
    state.filters = new Map();
    for (const [name, values] of Object.entries(byName || {})) {
      const c = COLUMNS.findIndex((col) => col.label === name);
      if (c >= 0 && Array.isArray(values)) state.filters.set(c, new Set(values));
    }
    state.page = 0;
    render();
  },
  /** Status segments follow the status order (Applied, Interviewing, …) rather than A to Z. */
  seriesOrder: (column) => (column === "Status" ? state.meta.statuses : null),
  /** Colours for chart segments, so statuses look the same everywhere. */
  seriesColor(column, value, dark) {
    if (column !== "Status" || !STATUS_COLORS[value]) return null;
    return STATUS_COLORS[value][dark ? 1 : 0];
  },
  // words and defaults for the shared Graph code
  rowWord: "applications",
  countLabel: "Count",
  tableName: "the table",
  emptyMessage: "Add an application to chart it.",
  emptySummary: "Add an application to chart it",
  preferX: /appl/i,          // start with "by month of Applied date"
  defaultSplit: "Status",
};

/* ----------------------------------------------------------------- wiring */

let searchTimer;
$("#search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = $("#search").value.trim().toLowerCase();
    state.page = 0;
    render();
  }, 120);
});
$("#search").addEventListener("keydown", (e) => {
  if (e.key === "Escape" && e.target.value) {
    e.target.value = "";
    state.search = "";
    render();
  } else if (e.key === "Enter" && state.view.length === 1) {
    openDetail(state.apps[state.view[0]].id);
  }
});

$("#add-btn").addEventListener("click", openAdd);
document.addEventListener("click", (e) => { if (e.target.closest('[data-action="add"]')) openAdd(); });
$("#download-csv").addEventListener("click", downloadCsv);

$("#pager").addEventListener("click", (e) => {
  const b = e.target.closest("[data-page]");
  if (!b || b.disabled) return;
  const pages = Math.ceil(state.view.length / PAGE_SIZE);
  const target = { first: 0, prev: state.page - 1, next: state.page + 1, last: pages - 1 }[b.dataset.page];
  state.page = Math.max(0, Math.min(pages - 1, target));
  renderTable();
  renderPager();
  $("#grid-wrap").scrollTop = 0;
});

$("#filter-search").addEventListener("input", renderFilterList);
$("#filter-search").addEventListener("keydown", (e) => { if (e.key === "Enter") applyFilter(); });
$("#filter-all").addEventListener("change", (e) => {
  for (const v of visibleFilterValues()) e.target.checked ? filterUI.checked.add(v) : filterUI.checked.delete(v);
  renderFilterList();
});
$("#filter-apply").addEventListener("click", applyFilter);
$("#filter-clear").addEventListener("click", () => {
  state.filters.delete(filterUI.col);
  state.page = 0;
  closeFilter();
  render();
});
document.addEventListener("mousedown", (e) => {
  const pop = $("#filter-pop");
  if (!pop.hidden && !pop.contains(e.target) && !e.target.closest(".filter-btn")) closeFilter();
});
$("#grid-wrap").addEventListener("scroll", () => { if (!$("#filter-pop").hidden) positionFilter(); });
window.addEventListener("resize", positionFilter);

document.addEventListener("keydown", (e) => {
  if (document.querySelector("dialog[open]")) return;          // Esc in a pop-up is handled by the browser
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (e.key === "Escape" && !$("#filter-pop").hidden) {
    closeFilter();
  } else if (e.key === "/" && !typing) {
    e.preventDefault();
    $("#search").focus();
    $("#search").select();
  }
});

/* -------------------------------------------------------------------- start */

(function start() {
  if (location.protocol === "file:") {
    $("#app").hidden = true;
    $("#not-served").hidden = false;
    return;
  }
  loadAll();
})();
