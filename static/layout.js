/* SQL Explorer: section sizes.
   Two drag handles sit between Query / Graph / Table Data. Dragging one
   changes the height of the section above it; Table Data takes what's left.
   Double-click a handle to reset. Sizes and open/closed sections are
   remembered in this browser.                                              */

(function () {
  "use strict";

  const STORE = "sqlx.layout";
  const MIN = { query: 60, graph: 220 };      // smallest a section body can get
  const MIN_TABLE = 140;                      // the table always keeps this much

  const sections = {
    query: { panel: document.getElementById("sql-panel"), body: () => document.querySelector("#sql-panel .sql-body") },
    graph: { panel: document.getElementById("graph-panel"), body: () => document.getElementById("graph-body") },
  };
  for (const name of Object.keys(sections)) if (!sections[name].panel) delete sections[name];
  const results = document.querySelector(".results");

  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE) || "{}"); } catch { saved = {}; }
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(saved)); } catch { /* ignore */ } };

  function setHeight(name, px) {
    const body = sections[name].body();
    if (px == null) {
      body.style.removeProperty("height");
      body.style.removeProperty("max-height");
    } else {
      body.style.height = `${px}px`;
      body.style.maxHeight = "none";
    }
  }

  function syncHandles() {
    for (const name of Object.keys(sections)) {
      const handle = document.querySelector(`.splitter[data-resize="${name}"]`);
      handle.hidden = !sections[name].panel.open;
    }
    document.dispatchEvent(new CustomEvent("sqlx:layout"));
  }

  // ---- restore what was saved
  for (const [name, sec] of Object.entries(sections)) {
    if (saved[name + "Height"]) setHeight(name, saved[name + "Height"]);
    if (typeof saved[name + "Open"] === "boolean") sec.panel.open = saved[name + "Open"];
    sec.panel.addEventListener("toggle", () => {
      saved[name + "Open"] = sec.panel.open;
      save();
      syncHandles();
    });
  }
  syncHandles();

  // ---- dragging
  function maxFor(name) {
    const current = sections[name].body().getBoundingClientRect().height;
    const spare = results.getBoundingClientRect().height - MIN_TABLE;
    return Math.max(MIN[name], current + Math.max(0, spare));
  }

  function resizeBy(name, startHeight, delta, max) {
    const h = Math.round(Math.min(max, Math.max(MIN[name], startHeight + delta)));
    setHeight(name, h);
    saved[name + "Height"] = h;
    document.dispatchEvent(new CustomEvent("sqlx:layout"));
    return h;
  }

  document.querySelectorAll(".splitter").forEach((handle) => {
    const name = handle.dataset.resize;

    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startY = e.clientY;
      const startH = sections[name].body().getBoundingClientRect().height;
      const max = maxFor(name);
      handle.setPointerCapture(e.pointerId);
      handle.classList.add("dragging");
      document.body.classList.add("resizing");

      const move = (ev) => resizeBy(name, startH, ev.clientY - startY, max);
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        handle.classList.remove("dragging");
        document.body.classList.remove("resizing");
        save();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });

    handle.addEventListener("dblclick", () => {
      setHeight(name, null);
      delete saved[name + "Height"];
      save();
      document.dispatchEvent(new CustomEvent("sqlx:layout"));
    });

    // keyboard: arrow keys move the handle, Home resets
    handle.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 64 : 16;
      const startH = sections[name].body().getBoundingClientRect().height;
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        resizeBy(name, startH, e.key === "ArrowUp" ? -step : step, maxFor(name));
        save();
      } else if (e.key === "Home") {
        e.preventDefault();
        handle.dispatchEvent(new MouseEvent("dblclick"));
      }
    });
  });
})();
