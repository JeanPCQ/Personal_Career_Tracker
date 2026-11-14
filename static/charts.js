/* SQL Explorer: Graph section.
   Builds bar and line charts from the rows the table is showing, so the
   table's column filters drive the chart too. No Python involved.

   Settings read as a sentence:
     Show [Total] of [Qty] by [Month] of [Demand Date] split by [Backorder]

   app.js sends "sqlx:results" whenever the table changes and exposes
   window.SQLX for reading/setting filters. Saved charts live in this browser. */

(function () {
  "use strict";

  if (typeof Chart === "undefined") {
    document.getElementById("graph-body").textContent =
      "The chart library didn't load. Check that static/chart.umd.min.js is in the static folder.";
    return;
  }

  /* ------------------------------------------------------------ settings */

  // The page that hosts the chart can set its own words (see window.SQLX in app.js).
  const HOST = window.SQLX || {};
  const ROW_WORD = HOST.rowWord || "rows";
  const COUNT_LABEL = HOST.countLabel || "Number of rows";
  const TABLE_NAME = HOST.tableName || "Table Data";
  const EMPTY_MESSAGE = HOST.emptyMessage || "Run the query, then choose what to chart here.";
  const EMPTY_SUMMARY = HOST.emptySummary || "Run the query to chart it";

  const STORE_SAVED = "sqlx.savedCharts";   // { filePath: [{ name, config, filters }] }
  const STORE_LAST = "sqlx.lastChart";      // { filePath: config }
  const TOP_N = 15;                         // categories shown before "Other"
  const MAX_SPLIT = 12;                     // most distinct values a "split by" column may have
  const MAX_X_NUMERIC = 50;                 // a number column can go along the bottom if it has this few values
  const MAX_FILL = 500;                     // most date buckets we fill in with zeros
  const BLANK = "(Blank)";
  const NO_DATE = "(No date)";

  const CALCS = [
    { id: "sum", label: "Sum", stack: true },
    { id: "avg", label: "Average", stack: false },
    { id: "count", label: COUNT_LABEL, stack: true },
    { id: "distinct", label: "Count Distinct", stack: true },
    { id: "max", label: "Max", stack: false },
    { id: "min", label: "Min", stack: false },
  ];
  const GRAINS = [
    { id: "day", label: "Day" },
    { id: "week", label: "Week" },
    { id: "month", label: "Month" },
    { id: "quarter", label: "Quarter" },
    { id: "year", label: "Year" },
  ];

  const PALETTE_LIGHT = ["#1F4FA8", "#E0A21B", "#2A9D8F", "#C8553D", "#7A5BB5", "#6B8F23",
                         "#5A6676", "#D97FA0", "#3C8DD6", "#A0522D", "#3A7D44", "#B38F00"];
  const PALETTE_DARK  = ["#86A9F2", "#E8C84F", "#5CC2B4", "#EE8A73", "#B49BEA", "#A7C957",
                         "#95A2B3", "#F0A6C1", "#7CB8EE", "#D69A6B", "#7CC48A", "#E3C35A"];

  const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/;
  const ID_RE = /(^|_)(id|no|num|number|code|key)$/i;
  const MEASURE_RE = /qty|quantity|amount|total|value|price|cost|hours|weight|count/i;

  /* --------------------------------------------------------------- state */

  const panel = document.getElementById("graph-panel");
  const body = document.getElementById("graph-body");
  const summaryEl = document.getElementById("graph-summary");
  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

  let snap = null;        // latest snapshot from app.js
  let meta = null;        // per column: { name, numeric, date, distinct }
  let config = null;      // { calc, measure, x, grain, split, type, stacked }
  let touched = false;    // has a chart been set up for this file (by the user, a save, or last time)?
  let activeSaved = "";   // name of the saved chart on screen, if unchanged
  let chart = null;
  let ui = null;          // control elements

  const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const fmtNum = (v) => (v == null || Number.isNaN(v) ? "" : nf.format(v));
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const fmtDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const fmtMonth = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric", timeZone: "UTC" });

  /* ------------------------------------------------------------- helpers */

  function el(tag, attrs = {}, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v == null) continue;
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  let toastTimer;
  function toast(message) {
    const t = document.getElementById("toast");
    if (!t) return;
    t.textContent = message;
    t.classList.remove("error");
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
  }

  function readStore(key) {
    try { return JSON.parse(localStorage.getItem(key) || "{}"); } catch { return {}; }
  }
  function writeStore(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
  }

  const calcOf = (id) => CALCS.find((c) => c.id === id) || CALCS[0];
  const grainOf = (id) => GRAINS.find((g) => g.id === id) || GRAINS[2];
  const metaOf = (name) => meta && meta.find((m) => m.name === name);

  /* -------------------------------------------------- reading the columns */

  function buildMeta(s) {
    return s.columns.map((name, c) => {
      let date = true, sawDate = false;
      const distinct = new Set();
      let many = false;
      for (const r of s.rows) {
        const v = r[c];
        if (v === null || v === undefined || v === "") continue;
        if (date) {
          if (typeof v === "string" && DATE_RE.test(v)) sawDate = true;
          else date = false;
        }
        if (!many) {
          distinct.add(String(v));
          if (distinct.size > MAX_X_NUMERIC) many = true;
        }
        if (!date && many) break;
      }
      return { name, numeric: !!s.numeric[c], date: date && sawDate, distinct: many ? Infinity : distinct.size };
    });
  }

  // which columns each dropdown offers
  const measureColumns = () => meta.filter((m) => m.numeric);
  const columnsFor = (calc) => (calc === "distinct" ? meta : measureColumns());
  const xColumns = () => [
    ...meta.filter((m) => m.date),
    ...meta.filter((m) => !m.numeric && !m.date),
    ...meta.filter((m) => m.numeric && m.distinct <= MAX_X_NUMERIC),
  ];
  const splitColumns = (x) => meta.filter((m) =>
    !m.date && m.name !== x && (m.distinct >= 2 || m.name === HOST.defaultSplit) && m.distinct <= MAX_SPLIT);

  function guessConfig() {
    const date = meta.find((m) => m.date);
    const cat = meta.find((m) => !m.numeric && !m.date && m.distinct <= MAX_X_NUMERIC)
             || meta.find((m) => !m.numeric && !m.date);
    const preferred = HOST.preferX ? meta.find((m) => m.date && HOST.preferX.test(m.name)) : null;
    const x = preferred || date || cat || meta.find((m) => m.numeric && m.distinct <= MAX_X_NUMERIC);
    if (!x) return null;
    const nums = measureColumns().filter((m) => m !== x);
    const measure = nums.find((m) => MEASURE_RE.test(m.name) && !ID_RE.test(m.name))
                 || nums.find((m) => !ID_RE.test(m.name)) || nums[0];
    return {
      calc: measure ? "sum" : "count",
      measure: measure ? measure.name : "",
      x: x.name,
      grain: "month",
      split: HOST.defaultSplit && splitColumns(x.name).some((m) => m.name === HOST.defaultSplit) ? HOST.defaultSplit : "",
      type: "bar",
      stacked: true,
    };
  }

  /** Make a stored config fit the current columns, or return null if it can't. */
  function validate(cfg) {
    if (!cfg || !meta) return null;
    const out = { ...cfg };
    if (!xColumns().some((m) => m.name === out.x)) return null;
    if (!GRAINS.some((g) => g.id === out.grain)) out.grain = "month";
    if (!CALCS.some((c) => c.id === out.calc)) out.calc = "sum";
    const measures = columnsFor(out.calc);
    if (out.calc !== "count" && !measures.some((m) => m.name === out.measure)) {
      if (!measures.length) out.calc = "count";
      else out.measure = (out.calc === "distinct" ? pickDistinctColumn(out.x) : measures[0]).name;
    }
    if (out.split && !splitColumns(out.x).some((m) => m.name === out.split)) out.split = "";
    out.type = out.type === "line" ? "line" : "bar";
    out.stacked = out.stacked !== false;
    return out;
  }

  /** True when every non-blank value in the column is different (e.g. an order number). */
  function allUnique(m) {
    const c = snap.columns.indexOf(m.name);
    const seen = new Set();
    for (const r of snap.rows) {
      const v = r[c];
      if (v === null || v === undefined || v === "") continue;
      const k = String(v);
      if (seen.has(k)) return false;
      seen.add(k);
    }
    return true;
  }

  // For Distinct count, prefer a column whose values repeat, like Part_Number;
  // counting a column where every value is unique just repeats Number of rows.
  function pickDistinctColumn(x) {
    const others = meta.filter((m) => m.name !== x && !m.date && m.distinct > 1);
    const useful = others.filter((m) => !allUnique(m));
    return useful.find((m) => ID_RE.test(m.name))
        || useful.find((m) => !m.numeric)
        || useful[0]
        || others[0]
        || meta.find((m) => m.name !== x)
        || meta[0];
  }

  const valueName = (cfg) =>
    cfg.calc === "count" ? COUNT_LABEL
    : cfg.calc === "distinct" ? `Count Distinct of ${cfg.measure}`
    : `${calcOf(cfg.calc).label} ${cfg.measure}`;

  function describe(cfg) {
    if (!cfg) return "";
    let s = valueName(cfg);
    const xm = metaOf(cfg.x);
    s += " by " + (xm && xm.date ? `${grainOf(cfg.grain).label.toLowerCase()} of ${cfg.x}` : cfg.x);
    if (cfg.split) s += (isStacked(cfg) ? ", stacked by " : ", split by ") + cfg.split;
    return s;
  }

  const isStacked = (cfg) => cfg.type === "bar" && !!cfg.split && cfg.stacked && calcOf(cfg.calc).stack;

  /* ---------------------------------------------------------- crunching */

  function bucketDate(v, grain) {
    const y = +v.slice(0, 4), m = +v.slice(5, 7), d = +v.slice(8, 10);
    switch (grain) {
      case "day": return Date.UTC(y, m - 1, d);
      case "week": {
        const t = Date.UTC(y, m - 1, d);
        const fromMonday = (new Date(t).getUTCDay() + 6) % 7;
        return t - fromMonday * 86400000;
      }
      case "quarter": return Date.UTC(y, Math.floor((m - 1) / 3) * 3, 1);
      case "year": return Date.UTC(y, 0, 1);
      default: return Date.UTC(y, m - 1, 1);
    }
  }

  function nextBucket(t, grain) {
    const d = new Date(t), y = d.getUTCFullYear(), m = d.getUTCMonth();
    switch (grain) {
      case "day": return t + 86400000;
      case "week": return t + 7 * 86400000;
      case "quarter": return Date.UTC(y, m + 3, 1);
      case "year": return Date.UTC(y + 1, 0, 1);
      default: return Date.UTC(y, m + 1, 1);
    }
  }

  function labelDate(t, grain) {
    const d = new Date(t);
    switch (grain) {
      case "day": return fmtDay.format(d);
      case "week": return "Week of " + fmtDay.format(d);
      case "quarter": return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
      case "year": return String(d.getUTCFullYear());
      default: return fmtMonth.format(d);
    }
  }

  const newAcc = () => ({ sum: 0, n: 0, rows: 0, min: Infinity, max: -Infinity, vals: null });
  function addTo(acc, v, distinct) {
    acc.rows++;
    if (distinct) {
      // like SQL COUNT(DISTINCT ...): blanks are not counted
      if (v !== null && v !== undefined && v !== "") (acc.vals || (acc.vals = new Set())).add(String(v));
      return;
    }
    if (typeof v === "number" && Number.isFinite(v)) {
      acc.sum += v; acc.n++;
      if (v < acc.min) acc.min = v;
      if (v > acc.max) acc.max = v;
    }
  }
  function mergeInto(a, b) {
    a.sum += b.sum; a.n += b.n; a.rows += b.rows;
    a.min = Math.min(a.min, b.min); a.max = Math.max(a.max, b.max);
    if (b.vals) {
      if (!a.vals) a.vals = new Set();
      for (const v of b.vals) a.vals.add(v);
    }
  }
  function valueOf(acc, calc) {
    if (!acc) return calc === "sum" || calc === "count" || calc === "distinct" ? 0 : null;
    switch (calc) {
      case "count": return acc.rows;
      case "distinct": return acc.vals ? acc.vals.size : 0;
      case "avg": return acc.n ? acc.sum / acc.n : null;
      case "max": return acc.n ? acc.max : null;
      case "min": return acc.n ? acc.min : null;
      default: return acc.sum;
    }
  }

  function aggregate(cfg) {
    const cols = snap.columns;
    const xi = cols.indexOf(cfg.x);
    const mi = cfg.calc === "count" ? -1 : cols.indexOf(cfg.measure);
    const si = cfg.split ? cols.indexOf(cfg.split) : -1;
    const isDate = metaOf(cfg.x).date;
    const notes = [];

    const cells = new Map();          // xKey -> Map(splitKey -> acc)
    const splitKeys = new Set();
    for (const ri of snap.view) {
      const r = snap.rows[ri];
      const xv = r[xi];
      const blank = xv === null || xv === undefined || xv === "";
      const xk = isDate ? (blank ? NO_DATE : bucketDate(String(xv), cfg.grain)) : (blank ? BLANK : String(xv));
      const sv = si < 0 ? "" : r[si];
      const sk = si < 0 ? "" : (sv === null || sv === undefined || sv === "" ? BLANK : String(sv));
      splitKeys.add(sk);
      let row = cells.get(xk);
      if (!row) { row = new Map(); cells.set(xk, row); }
      let acc = row.get(sk);
      if (!acc) { acc = newAcc(); row.set(sk, acc); }
      addTo(acc, mi < 0 ? null : r[mi], cfg.calc === "distinct");
    }

    // order along the bottom
    let xKeys, labels;
    if (isDate) {
      const times = [...cells.keys()].filter((k) => k !== NO_DATE).sort((a, b) => a - b);
      xKeys = times;
      if (times.length > 1) {
        let count = 0;
        for (let t = times[0]; t <= times[times.length - 1] && count <= MAX_FILL; t = nextBucket(t, cfg.grain)) count++;
        if (count <= MAX_FILL) {
          xKeys = [];
          for (let t = times[0]; t <= times[times.length - 1]; t = nextBucket(t, cfg.grain)) xKeys.push(t);
        } else {
          notes.push("Lots of dates here, so empty ones are left out. Grouping by week or month is easier to read.");
        }
      }
      if (cells.has(NO_DATE)) xKeys.push(NO_DATE);
      labels = xKeys.map((k) => (k === NO_DATE ? NO_DATE : labelDate(k, cfg.grain)));
    } else {
      const totalFor = (k) => {
        const all = newAcc();
        for (const acc of cells.get(k).values()) mergeInto(all, acc);
        return valueOf(all, cfg.calc) ?? -Infinity;
      };
      const keys = [...cells.keys()];
      if (metaOf(cfg.x).numeric) keys.sort((a, b) => (a === BLANK) - (b === BLANK) || Number(a) - Number(b));
      else keys.sort((a, b) => totalFor(b) - totalFor(a) || collator.compare(a, b));

      if (keys.length > TOP_N) {
        const top = metaOf(cfg.x).numeric
          ? [...keys].sort((a, b) => totalFor(b) - totalFor(a)).slice(0, TOP_N)
          : keys.slice(0, TOP_N);
        const keep = new Set(top);
        const other = new Map();
        for (const k of keys) {
          if (keep.has(k)) continue;
          for (const [sk, acc] of cells.get(k)) {
            if (!other.has(sk)) other.set(sk, newAcc());
            mergeInto(other.get(sk), acc);
          }
        }
        notes.push(`Showing the top ${TOP_N} of ${keys.length.toLocaleString()} values of ${cfg.x}; the rest are grouped as "Other".`);
        xKeys = keys.filter((k) => keep.has(k));
        cells.set("\u0000other", other);
        xKeys.push("\u0000other");
      } else {
        xKeys = keys;
      }
      labels = xKeys.map((k) => (k === "\u0000other" ? "Other" : k));
    }

    const order = cfg.split && HOST.seriesOrder ? HOST.seriesOrder(cfg.split) : null;
    const rank = (k) => { const i = order ? order.indexOf(k) : -1; return i < 0 ? Infinity : i; };
    const seriesKeys = [...splitKeys].sort((a, b) =>
      (a === BLANK) - (b === BLANK) || rank(a) - rank(b) || collator.compare(a, b));
    const name = valueName(cfg);
    const datasets = seriesKeys.map((sk) => ({
      label: si < 0 ? name : sk,
      data: xKeys.map((xk) => valueOf(cells.get(xk) && cells.get(xk).get(sk), cfg.calc)),
    }));
    // For distinct counts, a bar's total is the number of different values
    // across all its segments, not the sum of the segments.
    let totals = null;
    if (cfg.calc === "distinct" && si >= 0) {
      totals = xKeys.map((xk) => {
        const all = newAcc();
        const row = cells.get(xk);
        if (row) for (const acc of row.values()) mergeInto(all, acc);
        return all.vals ? all.vals.size : 0;
      });
      const overlaps = totals.some((t, i) => datasets.reduce((sum, d) => sum + (d.data[i] || 0), 0) > t);
      if (overlaps) {
        notes.push(`Some ${cfg.measure} values appear under more than one ${cfg.split} in the same period, ` +
                   `so the segments add up to more than the total shown on top.`);
      }
    }
    return { labels, datasets, notes, totals, yTitle: name };
  }

  /* ------------------------------------------------------------ drawing */

  // Writes each stacked bar's total above it
  const totalsPlugin = {
    id: "sqlxTotals",
    afterDatasetsDraw(c, _args, opts) {
      if (!opts || !opts.show) return;
      const metas = c.data.datasets.map((_, i) => c.getDatasetMeta(i)).filter((m) => m.visible !== false && !m.hidden);
      if (!metas.length) return;
      const { ctx } = c;
      ctx.save();
      ctx.font = `600 11px ${Chart.defaults.font.family}`;
      ctx.fillStyle = opts.color;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      for (let i = 0; i < c.data.labels.length; i++) {
        let total = 0, top = Infinity, x = null;
        for (const m of metas) {
          if (!c.isDatasetVisible(m.index)) continue;
          const v = c.data.datasets[m.index].data[i];
          if (!v) continue;
          total += v;
          const bar = m.data[i];
          if (bar) { top = Math.min(top, bar.y); x = bar.x; }
        }
        if (opts.totals) total = opts.totals[i];
        if (x !== null && total > 0) ctx.fillText(fmtNum(total), x, top - 3);
      }
      ctx.restore();
    },
  };
  Chart.register(totalsPlugin);

  function draw() {
    if (!panel.open || !snap || !snap.hasResult || !config || !ui) return;
    Chart.defaults.font.family = '"IBM Plex Sans", "Segoe UI", system-ui, sans-serif';

    const data = aggregate(config);
    const stacked = isStacked(config);
    const palette = darkQuery.matches ? PALETTE_DARK : PALETTE_LIGHT;
    const ink = cssVar("--ink"), muted = cssVar("--muted"), grid = cssVar("--rule-soft");
    const many = data.labels.length > 60;

    const datasets = data.datasets.map((d, i) => {
      const custom = config.split && HOST.seriesColor ? HOST.seriesColor(config.split, d.label, darkQuery.matches) : null;
      const color = custom || palette[i % palette.length];
      return config.type === "line"
        ? { ...d, borderColor: color, backgroundColor: color, borderWidth: 2, tension: 0,
            pointRadius: many ? 0 : 3, pointHoverRadius: 5, spanGaps: false }
        : { ...d, backgroundColor: color, borderWidth: 0, borderRadius: stacked ? 0 : 3,
            maxBarThickness: 56 };
    });

    const options = {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      layout: { padding: { top: stacked ? 18 : 6, right: 8 } },
      scales: {
        x: { stacked, grid: { display: false }, ticks: { color: muted, maxRotation: 50, autoSkip: true } },
        y: {
          stacked, beginAtZero: true, border: { display: false },
          grid: { color: grid },
          ticks: { color: muted, callback: (v) => fmtNum(v) },
          title: { display: true, text: data.yTitle, color: muted },
        },
      },
      plugins: {
        legend: {
          display: !!config.split,
          position: "top", align: "end",
          labels: { color: ink, boxWidth: 12, boxHeight: 12, usePointStyle: config.type === "line" },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.dataset.label}: ${fmtNum(ctx.parsed.y)}`,
            footer: stacked
              ? (items) => `Total: ${fmtNum(data.totals
                  ? data.totals[items[0].dataIndex]
                  : items.reduce((t, it) => t + (it.parsed.y || 0), 0))}`
              : undefined,
          },
        },
        sqlxTotals: { show: stacked && data.labels.length <= 40, color: ink, totals: data.totals },
      },
    };

    if (chart && chart.config.type === config.type) {
      chart.data.labels = data.labels;
      chart.data.datasets = datasets;
      chart.options = options;
      chart.update("none");
    } else {
      if (chart) chart.destroy();
      chart = new Chart(ui.canvas, { type: config.type, data: { labels: data.labels, datasets }, options });
    }

    const empty = !snap.view.length;
    ui.empty.hidden = !empty;
    ui.chartNotes.textContent = empty ? "" : data.notes.join(" ");
  }

  function destroyChart() {
    if (chart) { chart.destroy(); chart = null; }
  }

  /* ---------------------------------------------------------- controls */

  function fillSelect(select, options, value) {
    select.replaceChildren(...options.map(([v, label]) => el("option", { value: v }, label)));
    select.value = value;
  }

  function buildControls() {
    destroyChart();
    const sel = (label) => el("select", { class: "pick", "aria-label": label });
    ui = {
      calc: sel("Calculation"),
      measure: sel("Value"),
      grain: sel("Group dates by"),
      x: sel("Along the bottom"),
      split: sel("Split by"),
      bar: el("button", { type: "button", "data-type": "bar" }, "Bar"),
      line: el("button", { type: "button", "data-type": "line" }, "Line"),
      stacked: el("input", { type: "checkbox" }),
      saved: el("select", { class: "saved-pick", "aria-label": "Saved charts" }),
      del: el("button", { type: "button", class: "btn-link" }, "Delete"),
      save: el("button", { type: "button", class: "btn btn-quiet btn-small" }, "Save chart"),
      png: el("button", { type: "button", class: "btn btn-quiet btn-small" }, "Download image"),
      canvas: el("canvas", { role: "img", "aria-label": "Chart" }),
      empty: el("p", { class: "graph-empty", hidden: true }, `Nothing matches the filters. Clear a filter in ${TABLE_NAME} to see the chart.`),
      filterNote: el("p", { class: "graph-filters" }),
      chartNotes: el("p", { class: "graph-notes" }),
    };
    ui.ofPart = el("span", { class: "part" }, "of ", ui.measure);
    ui.grainPart = el("span", { class: "part" }, ui.grain, " of");
    ui.stackPart = el("label", { class: "stack-opt" }, ui.stacked, el("span", {}, "Stacked"));

    ui.nameInput = el("input", { type: "text", placeholder: "Name, e.g. Monthly backorders", "aria-label": "Chart name", maxlength: "80" });
    ui.saveForm = el("form", { class: "save-form", hidden: true },
      ui.nameInput,
      el("button", { type: "submit", class: "btn btn-primary btn-small" }, "Save"),
      el("button", { type: "button", class: "btn btn-quiet btn-small", onclick: () => toggleSaveForm(false) }, "Cancel"));

    body.replaceChildren(
      el("div", { class: "graph-controls" },
        el("p", { class: "sentence" },
          "Show ", ui.calc, " ", ui.ofPart, " by ", ui.grainPart, " ", ui.x,
          el("span", { class: "part" }, " split by ", ui.split)),
        el("div", { class: "graph-tools" },
          el("div", { class: "seg", role: "group", "aria-label": "Chart type" }, ui.bar, ui.line),
          ui.stackPart,
          el("span", { class: "spacer" }),
          ui.saved, ui.del, ui.save, ui.png),
        ui.saveForm),
      ui.filterNote,
      el("div", { class: "graph-canvas" }, ui.canvas, ui.empty),
      ui.chartNotes,
    );

    const changed = (patch) => {
      config = validate({ ...config, ...patch }) || config;
      touched = true;
      activeSaved = "";
      rememberLast();
      updateControls();
      updateSummary();
      draw();
    };
    ui.calc.addEventListener("change", () => {
      const calc = ui.calc.value;
      const patch = { calc };
      if (calc === "distinct" && config.calc !== "distinct") patch.measure = pickDistinctColumn(config.x).name;
      if (calc !== "distinct" && config.calc === "distinct" && !metaOf(config.measure)?.numeric) {
        const guess = guessConfig();
        patch.measure = guess && guess.measure ? guess.measure : "";
      }
      changed(patch);
    });
    ui.measure.addEventListener("change", () => changed({ measure: ui.measure.value }));
    ui.grain.addEventListener("change", () => changed({ grain: ui.grain.value }));
    ui.x.addEventListener("change", () => changed({ x: ui.x.value }));
    ui.split.addEventListener("change", () => changed({ split: ui.split.value }));
    ui.bar.addEventListener("click", () => changed({ type: "bar" }));
    ui.line.addEventListener("click", () => changed({ type: "line" }));
    ui.stacked.addEventListener("change", () => changed({ stacked: ui.stacked.checked }));

    ui.saved.addEventListener("change", () => loadSaved(ui.saved.value));
    ui.del.addEventListener("click", deleteSaved);
    ui.save.addEventListener("click", () => toggleSaveForm(true));
    ui.saveForm.addEventListener("submit", (e) => { e.preventDefault(); saveChart(); });
    ui.nameInput.addEventListener("keydown", (e) => { if (e.key === "Escape") toggleSaveForm(false); });
    ui.png.addEventListener("click", downloadImage);
  }

  function updateControls() {
    if (!ui || !config) return;
    const xm = metaOf(config.x);
    const measures = measureColumns();

    fillSelect(ui.calc, CALCS.filter((c) => c.id === "count" || c.id === "distinct" || measures.length).map((c) => [c.id, c.label]), config.calc);
    fillSelect(ui.measure, columnsFor(config.calc).map((m) => [m.name, m.name]), config.measure);
    fillSelect(ui.grain, GRAINS.map((g) => [g.id, g.label]), config.grain);
    fillSelect(ui.x, xColumns().map((m) => [m.name, m.name]), config.x);
    fillSelect(ui.split, [["", "nothing"], ...splitColumns(config.x).map((m) => [m.name, m.name])], config.split);

    ui.ofPart.hidden = config.calc === "count";
    ui.grainPart.hidden = !(xm && xm.date);

    ui.bar.setAttribute("aria-pressed", String(config.type === "bar"));
    ui.line.setAttribute("aria-pressed", String(config.type === "line"));

    // "Stacked" only appears when it means something
    ui.stackPart.hidden = !(config.type === "bar" && config.split);
    const canStack = calcOf(config.calc).stack;
    ui.stacked.disabled = !canStack;
    ui.stacked.checked = canStack && config.stacked;
    ui.stackPart.title = canStack ? "" : `Stacking only adds up for Sum, ${COUNT_LABEL} and Count Distinct.`;

    // saved charts for this query
    const list = savedFor();
    fillSelect(ui.saved,
      [["", list.length ? "Saved charts" : "No saved charts"], ...list.map((s) => [s.name, s.name])],
      activeSaved);
    ui.saved.disabled = !list.length;
    ui.del.hidden = !activeSaved;

    updateFilterNote();
  }

  function updateFilterNote() {
    if (!ui || !snap) return;
    const filters = Object.entries(snap.filters);
    const total = snap.rows.length;
    if (!filters.length) {
      ui.filterNote.textContent = `Using all ${total.toLocaleString()} ${ROW_WORD}. Filters you set in ${TABLE_NAME} apply here too.`;
      return;
    }
    const parts = filters.map(([col, vals]) => `${col}: ${vals.length === 1 ? vals[0] : vals.length + " values"}`);
    ui.filterNote.replaceChildren(
      `Using ${snap.view.length.toLocaleString()} of ${total.toLocaleString()} ${ROW_WORD}, filtered by `,
      ...parts.flatMap((p, i) => [i ? ", " : "", el("mark", {}, p)]),
      `. Change filters in ${TABLE_NAME}.`);
  }

  function updateSummary() {
    if (!snap || !snap.file) { summaryEl.textContent = "Set up a chart"; return; }
    if (!snap.hasResult) { summaryEl.textContent = EMPTY_SUMMARY; return; }
    if (!config) { summaryEl.textContent = "Nothing in this result to chart"; return; }
    if (!touched) { summaryEl.textContent = "Set up a chart"; return; }
    summaryEl.textContent = (activeSaved ? `${activeSaved}: ` : "") + describe(config);
  }

  function showMessage(text) {
    destroyChart();
    ui = null;
    body.replaceChildren(el("p", { class: "graph-message" }, text));
  }

  /* -------------------------------------------------------- saved charts */

  function savedFor() {
    if (!snap || !snap.file) return [];
    return readStore(STORE_SAVED)[snap.file.path] || [];
  }

  function rememberLast() {
    if (!snap || !snap.file) return;
    const last = readStore(STORE_LAST);
    last[snap.file.path] = config;
    writeStore(STORE_LAST, last);
  }

  function toggleSaveForm(show) {
    ui.saveForm.hidden = !show;
    if (show) {
      ui.nameInput.value = activeSaved || "";
      ui.nameInput.focus();
    } else {
      ui.save.focus();
    }
  }

  function saveChart() {
    const name = ui.nameInput.value.trim();
    if (!name) { ui.nameInput.focus(); return; }
    const all = readStore(STORE_SAVED);
    const list = all[snap.file.path] || [];
    const entry = { name, config, filters: window.SQLX ? window.SQLX.getFilters() : {} };
    const i = list.findIndex((s) => s.name.toLowerCase() === name.toLowerCase());
    if (i >= 0) list[i] = entry; else list.push(entry);
    list.sort((a, b) => collator.compare(a.name, b.name));
    all[snap.file.path] = list;
    writeStore(STORE_SAVED, all);
    activeSaved = name;
    touched = true;
    toggleSaveForm(false);
    updateControls();
    updateSummary();
    toast(i >= 0 ? `Updated "${name}"` : `Saved "${name}"`);
  }

  function loadSaved(name) {
    const entry = savedFor().find((s) => s.name === name);
    if (!entry) return;
    const cfg = validate(entry.config);
    if (!cfg) { toast(`"${name}" uses columns this query no longer has.`); updateControls(); return; }
    config = cfg;
    touched = true;
    activeSaved = name;
    rememberLast();
    if (window.SQLX) window.SQLX.setFilters(entry.filters || {});   // redraws through sqlx:results
    else { updateControls(); updateSummary(); draw(); }
  }

  function deleteSaved() {
    if (!activeSaved) return;
    const all = readStore(STORE_SAVED);
    all[snap.file.path] = (all[snap.file.path] || []).filter((s) => s.name !== activeSaved);
    writeStore(STORE_SAVED, all);
    toast(`Deleted "${activeSaved}"`);
    activeSaved = "";
    updateControls();
    updateSummary();
  }

  function downloadImage() {
    if (!chart) return;
    const src = chart.canvas;
    const out = document.createElement("canvas");
    out.width = src.width;
    out.height = src.height;
    const ctx = out.getContext("2d");
    ctx.fillStyle = cssVar("--surface") || "#fff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(src, 0, 0);
    out.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const base = (activeSaved || (snap.file ? snap.file.name + "_chart" : "chart")).replace(/[\\/:*?"<>|]+/g, "_");
      const a = el("a", { href: url, download: `${base}.png` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast("Downloaded the chart");
    });
  }

  /* ------------------------------------------------------------- events */

  function onResults(s) {
    const fileChanged = !snap || !snap.file || !s.file || snap.file.path !== s.file.path;
    const rowsChanged = !snap || snap.rows !== s.rows;
    snap = s;

    if (fileChanged) { touched = false; activeSaved = ""; }

    if (!s.file) { config = null; showMessage("Pick a query to chart it."); updateSummary(); return; }
    if (!s.hasResult) {
      config = fileChanged ? null : config;
      showMessage(EMPTY_MESSAGE);
      updateSummary();
      return;
    }

    if (rowsChanged || !ui) {
      meta = buildMeta(s);
      const last = readStore(STORE_LAST)[s.file.path];
      const keep = !fileChanged && config ? validate(config) : null;
      const fromLast = keep ? null : validate(last);
      config = keep || fromLast || guessConfig();
      if (fromLast) touched = true;
      if (!config) {
        showMessage("This result has no column to put along the bottom of a chart.");
        updateSummary();
        return;
      }
      buildControls();
    }
    updateControls();
    updateSummary();
    draw();
  }

  document.addEventListener("sqlx:results", (e) => onResults(e.detail));

  panel.addEventListener("toggle", () => {
    if (panel.open) {
      if (snap && snap.hasResult && config && !touched) { touched = true; updateSummary(); }
      draw();
    }
  });

  darkQuery.addEventListener("change", () => { destroyChart(); draw(); });

  // pick up anything that happened before this file loaded
  if (window.SQLX) onResults(window.SQLX.snapshot());
})();
