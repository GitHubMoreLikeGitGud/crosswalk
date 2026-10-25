// The analyst UI shell: hash routing between the five screens, the run picker, the REPLAY / LIVE
// banner (exactly one of them, or none on the Ask screen with nothing running), the "Show
// engineering detail" toggle, the provenance drawer and the telemetry footer.

import { api, esc, runWords, sessionGet, sessionSet } from "./lib.js";
import { drawerIsOpen } from "./views/drawer.js";
import { openCell } from "./views/provenance.js";
import { mountFooter, setFooterRun } from "./views/telemetry.js";
import { bannerHtml } from "./views/banner.js";
import * as ask from "./views/ask.js";
import * as timeline from "./views/timeline.js";
import * as joinmap from "./views/joinmap.js";
import * as usl from "./views/usl.js";
import * as answer from "./views/answer.js";

const VIEWS = { ask, timeline, joinmap, usl, answer };
const TITLES = { ask: "Ask", timeline: "Discovery", joinmap: "Join map", usl: "USL and DQ", answer: "Answer" };
const PRODUCT = "Crosswalk";
const RUN_RE = /^r\d{8}T\d{6}[0-9a-f]{4}$/u;

let cleanup = null;
let runs = [];
let running = null;
let currentRun = null;

/** "#/answer/r2026...", "#/ask". */
export function parseRoute(hash) {
  const m = /^#\/([a-z]+)(?:\/([A-Za-z0-9_-]{1,64}))?\/?$/u.exec(hash ?? "");
  if (!m || !VIEWS[m[1]]) return null;
  const run = m[2] && RUN_RE.test(m[2]) ? m[2] : null;
  return { view: m[1], run };
}

function announce(text) {
  const a = document.getElementById("announcer");
  a.textContent = "";
  setTimeout(() => {
    a.textContent = text;
  }, 30);
}

function setBanner(mode, text = "") {
  const el = document.getElementById("mode-banner");
  if (!mode) {
    el.hidden = true;
    el.innerHTML = "";
    delete el.dataset.mode;
    return;
  }
  el.dataset.mode = mode;
  el.innerHTML = bannerHtml(mode, text);
  el.hidden = false;
}

function runMeta(id) {
  if (running && running.run_id === id) return { ...running, live: true };
  return runs.find((r) => r.run_id === id) ?? null;
}

/** The banner a run screen shows by default: LIVE while that run is running, else REPLAY. */
function defaultBanner(id) {
  const meta = runMeta(id);
  if (!meta) return setBanner(null);
  if (meta.live) return setBanner("live", `${runWords(meta)}: the agent is measuring now.`);
  return setBanner("replay", `${runWords(meta)}. A saved run: nothing on these screens is being measured now.`);
}

function fillPicker() {
  const sel = document.getElementById("run-pick");
  const opts = [];
  if (running) opts.push(`<option value="${esc(running.run_id)}">Live now: ${esc(runWords(running))}</option>`);
  for (const r of runs) {
    if (running && r.run_id === running.run_id) continue;
    opts.push(`<option value="${esc(r.run_id)}">${esc(runWords(r))}${r.wall_s ? `, ${esc(r.wall_s)} s` : ""}</option>`);
  }
  sel.innerHTML = opts.join("") || `<option value="">No saved run</option>`;
  if (currentRun) sel.value = currentRun;
}

export async function loadRuns() {
  const r = await api("/api/runs");
  if (r.ok) {
    runs = Array.isArray(r.data?.runs) ? r.data.runs : [];
    running = r.data?.running ?? null;
  }
  fillPicker();
  return r.ok;
}

function pickDefaultRun() {
  const remembered = sessionGet("cw.run");
  if (remembered && runMeta(remembered)) return remembered;
  return running?.run_id ?? runs[0]?.run_id ?? null;
}

function setTabs(view) {
  for (const a of document.querySelectorAll(".tabs a")) {
    const t = a.dataset.tab;
    a.setAttribute("href", t === "ask" || !currentRun ? `#/${t}` : `#/${t}/${currentRun}`);
    if (t === view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
}

function route() {
  const r = parseRoute(location.hash);
  if (!r) {
    location.replace("#/ask");
    return;
  }
  if (r.view !== "ask" && !r.run) {
    const id = currentRun ?? pickDefaultRun();
    if (id) {
      location.replace(`#/${r.view}/${id}`);
      return;
    }
  }
  if (r.run) {
    currentRun = r.run;
    sessionSet("cw.run", r.run);
    const sel = document.getElementById("run-pick");
    if (sel.value !== r.run) sel.value = r.run;
  }
  cleanup?.();
  setTabs(r.view);
  document.title = `${TITLES[r.view]} | ${PRODUCT}`;
  if (r.view === "ask") {
    setBanner(null);
    setFooterRun(null);
  } else {
    defaultBanner(r.run);
    setFooterRun(r.run);
  }
  const el = document.getElementById("view");
  el.className = `view view--${r.view}`;
  const ctx = {
    run: r.run,
    meta: r.run ? runMeta(r.run) : null,
    runs: () => runs,
    running: () => running,
    announce,
    setBanner,
    setFooterRun,
    reloadRuns: loadRuns,
    setTitle: (t) => {
      document.title = `${t} | ${PRODUCT}`;
    },
  };
  const own = VIEWS[r.view].mount(el, ctx);
  cleanup = () => {
    if (typeof own === "function") own();
  };
  window.scrollTo(0, 0);
}

function delegate() {
  document.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const cell = t.closest("[data-cell]");
    if (cell) {
      e.preventDefault();
      openCell(cell.getAttribute("data-run") || currentRun, cell.getAttribute("data-cell"), { push: !!cell.closest("#drawer") && drawerIsOpen() });
      return;
    }
    const skip = t.closest("[data-skip]");
    if (skip) {
      e.preventDefault();
      document.getElementById("main").focus();
    }
  });
}

/** The sticky offsets follow the real heights of the top bar, the banner and the footer. */
function trackHeights() {
  const top = document.querySelector("header.top");
  const banner = document.getElementById("mode-banner");
  const footer = document.getElementById("telemetry");
  const set = () => {
    document.documentElement.style.setProperty("--bar-h", `${top.offsetHeight}px`);
    if (footer.offsetHeight) document.documentElement.style.setProperty("--footer-h", `${footer.offsetHeight}px`);
  };
  set();
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(set);
    ro.observe(top);
    ro.observe(banner);
    ro.observe(footer);
  } else {
    window.addEventListener("resize", set);
  }
}

function engToggle() {
  const box = document.getElementById("eng-toggle");
  const apply = (on) => {
    document.documentElement.classList.toggle("eng-on", on);
    box.checked = on;
  };
  apply(sessionGet("cw.eng") === "1");
  box.addEventListener("change", () => {
    sessionSet("cw.eng", box.checked ? "1" : "0");
    apply(box.checked);
  });
}

async function start() {
  trackHeights();
  delegate();
  engToggle();
  mountFooter(document.getElementById("telemetry"));
  await loadRuns();
  document.getElementById("run-pick").addEventListener("change", (e) => {
    const id = e.target.value;
    if (!id) return;
    const r = parseRoute(location.hash);
    const view = r && r.view !== "ask" ? r.view : "answer";
    location.hash = `#/${view}/${id}`;
  });
  window.addEventListener("hashchange", route);
  route();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
}
