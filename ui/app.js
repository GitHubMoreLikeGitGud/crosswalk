// The analyst UI shell: hash routing between the screens, the shared evidence drawer and why
// trace, the connection status and the telemetry footer.

import { api, esc, on, onConnection } from "./lib.js";
import { drawerIsOpen } from "./views/drawer.js";
import { openEvidence } from "./views/evidence.js";
import { openWhy } from "./views/memory.js";
import { mountFooter, setFooterRun } from "./views/telemetry.js";
import * as ask from "./views/ask.js";
import * as card from "./views/card.js";
import * as memory from "./views/memory.js";
import * as graph from "./views/graph.js";
import * as evaluation from "./views/eval.js";

const VIEWS = { ask, card, memory, graph, eval: evaluation };
const TITLES = { ask: "Ask", card: "Answer card", memory: "Memory and why", graph: "Graph", eval: "Evaluation" };
const PRODUCT = "Weather-or-Not";

let cleanup = null;

/** "#/card/r2026...", "#/graph/0001031296", "#/ask". */
export function parseRoute(hash) {
  const m = /^#\/([a-z]+)(?:\/([A-Za-z0-9_-]{1,64}))?\/?$/u.exec(hash ?? "");
  if (!m || !VIEWS[m[1]]) return null;
  const p = m[2] ?? null;
  const params = { run: null, cik: null };
  if (p && /^r\d{8}T\d{6}[0-9a-f]{4}$/u.test(p)) params.run = p;
  else if (p && /^\d{10}$/u.test(p)) params.cik = p;
  return { view: m[1], params };
}

function announce(text) {
  const a = document.getElementById("announcer");
  a.textContent = "";
  setTimeout(() => {
    a.textContent = text;
  }, 30);
}

function route() {
  if (!location.hash.startsWith("#/")) {
    location.replace("#/ask");
    return;
  }
  const r = parseRoute(location.hash);
  if (!r) {
    location.replace("#/ask");
    return;
  }
  cleanup?.();
  const offs = [];
  const ctx = {
    params: r.params,
    on: (type, fn) => {
      const off = on(type, fn);
      offs.push(off);
      return off;
    },
    announce,
    setFooterRun,
    setTitle: (t) => {
      document.title = `${t} | ${PRODUCT}`;
    },
  };
  for (const a of document.querySelectorAll(".tabs a")) {
    if (a.dataset.tab === r.view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  document.title = `${TITLES[r.view]} | ${PRODUCT}`;
  if (r.view !== "card" && r.view !== "memory") setFooterRun(null);
  const el = document.getElementById("view");
  el.className = `view view--${r.view}`;
  const own = VIEWS[r.view].mount(el, ctx);
  cleanup = () => {
    offs.forEach((f) => f());
    if (typeof own === "function") own();
  };
  window.scrollTo(0, 0);
}

function delegate() {
  document.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const cited = t.closest(".ev[data-ev], .num[data-ev]");
    if (cited) {
      e.preventDefault();
      const group = cited.closest(".evs");
      const ids = (cited.getAttribute("data-ids") ?? group?.getAttribute("data-ids") ?? cited.getAttribute("data-ev")).split(" ").filter(Boolean);
      const inDrawer = !!cited.closest("#drawer");
      openEvidence(cited.getAttribute("data-run") || group?.getAttribute("data-run") || null, ids, { start: cited.getAttribute("data-ev"), push: inDrawer && drawerIsOpen() });
      return;
    }
    const why = t.closest("[data-why]");
    if (why) {
      e.preventDefault();
      openWhy(why.getAttribute("data-why"), { push: !!why.closest("#drawer") && drawerIsOpen() });
      return;
    }
    const skip = t.closest("[data-skip]");
    if (skip) {
      e.preventDefault();
      document.getElementById("main").focus();
    }
  });
}

/** The sticky offsets follow the real heights of the top bar and the footer (they wrap on narrow screens). */
function trackHeights() {
  const top = document.querySelector("header.top");
  const footer = document.getElementById("telemetry");
  const set = () => {
    document.documentElement.style.setProperty("--top-h", `${top.offsetHeight}px`);
    if (footer.offsetHeight) document.documentElement.style.setProperty("--footer-h", `${footer.offsetHeight}px`);
  };
  set();
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(set);
    ro.observe(top);
    ro.observe(footer);
  } else {
    window.addEventListener("resize", set);
  }
}

async function health() {
  const r = await api("/api/health");
  const el = document.getElementById("health");
  if (!el) return;
  if (r.ok) {
    const d = r.data ?? {};
    el.innerHTML = `${d.model ? `<span>${esc(d.model)}</span>` : ""}${typeof d.gateway_templates === "number" ? `<span>${esc(d.gateway_templates)} gateway templates</span>` : ""}${typeof d.runs === "number" ? `<span>${esc(d.runs)} saved runs</span>` : ""}`;
  } else {
    el.innerHTML = `<span class="warn-text">server not reachable</span>`;
  }
}

function start() {
  trackHeights();
  delegate();
  window.addEventListener("hashchange", route);
  onConnection((s) => {
    const el = document.getElementById("conn");
    el.dataset.state = s;
    el.textContent = s === "live" ? "Live events on" : s === "reconnecting" ? "Live events reconnecting" : s === "closed" ? "Live events off" : "Live events connecting";
  });
  mountFooter(document.getElementById("telemetry"));
  health();
  on("run_finished", health);
  route();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
}
