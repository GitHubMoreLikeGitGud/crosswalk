// Graph: the World Model's counts (GET /api/world) and, for the run's utility, its neighbourhood
// grouped by relationship type and the source-time timeline (GET /api/world/:cik). renderGraph is pure.

import { api, esc, fmtNum, fmtPct, fmtSourceTime, renderError } from "../lib.js";
import { loadRun, pickRunId } from "./runs.js";

const REL_WORDS = {
  serves: "serves (states)",
  represented_by: "represented by (weather stations)",
  peer_of: "peer of (this period)",
  reported_in: "reported in (filings)",
  recasts: "recasts (a later filing restates it)",
  classified_as: "classified as (SIC)",
  observed_in: "observed in (quarters)",
};

function attrText(type, a) {
  if (!a || typeof a !== "object") return "";
  if (type === "peer_of") return [a.g !== undefined ? `g ${fmtPct(a.g)}` : "", a.dw !== undefined ? `dw ${fmtPct(a.dw)}` : "", a.tag ? String(a.tag).replace(/^RevenueFromContract.*$/u, "RFC").replace(/^RegulatedAndUnregulated.*$/u, "RUOR") : ""].filter(Boolean).join(", ");
  if (type === "reported_in") return [a.tag ? `tag ${a.tag}` : "", a.period ? a.period : "", a.val !== undefined ? `${fmtNum(Number(a.val) / 1e6, 1)} M` : ""].filter(Boolean).join(", ");
  if (type === "observed_in") return [a.hdd !== undefined ? `HDD ${fmtNum(a.hdd, 1)}` : "", a.cdd !== undefined ? `CDD ${fmtNum(a.cdd, 1)}` : "", a.coverage !== undefined ? `coverage ${fmtNum(a.coverage, 3)}` : ""].filter(Boolean).join(", ");
  const entries = Object.entries(a).filter(([, v]) => v !== null && v !== undefined && typeof v !== "object");
  return entries.map(([k, v]) => `${k} ${typeof v === "number" ? fmtNum(v, 3) : v}`).join(", ");
}

export function renderCounts(w) {
  if (!w || typeof w !== "object") return `<p class="muted">No World Model counts.</p>`;
  const ents = w.byType ?? w.entities ?? {};
  const edges = w.edgeTypes ?? w.edges ?? {};
  const row = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="count"><span class="count__v fig fig--s">${esc(fmtNum(v))}</span><span class="count__k">${esc(k.replaceAll("_", " "))}</span></div>`).join("");
  return `<div class="counts"><div><h3 class="sub-h">Entities</h3><div class="counts__row">${row(ents)}</div></div><div><h3 class="sub-h">Relationships</h3><div class="counts__row">${row(edges)}</div></div>${typeof w.events === "number" ? `<p class="small muted">${esc(fmtNum(w.events))} events in the append-only log; every edge is stamped with its source time, so re-ingesting the same rows appends nothing.</p>` : ""}</div>`;
}

export function renderNeighbourhood(n) {
  if (!n || !Array.isArray(n.edges)) return `<p class="muted">No neighbourhood for this utility yet.</p>`;
  const groups = new Map();
  for (const e of n.edges) {
    if (!groups.has(e.type)) groups.set(e.type, []);
    groups.get(e.type).push(e);
  }
  const order = Object.keys(REL_WORDS);
  const keys = [...groups.keys()].sort((a, b) => (order.includes(a) ? order.indexOf(a) : 99) - (order.includes(b) ? order.indexOf(b) : 99));
  return `${n.utility ? `<p class="small">Entity <code>${esc(n.utility.id)}</code> ${n.utility.name ? `<strong>${esc(n.utility.name)}</strong>` : ""}</p>` : ""}
    ${keys
      .map((k) => {
        const list = groups.get(k);
        return `<details class="relgroup" open><summary><span class="relgroup__n fig fig--s">${esc(fmtNum(list.length))}</span> ${esc(REL_WORDS[k] ?? k.replaceAll("_", " "))}</summary><ul class="rel">${list
          .map((e) => `<li><span class="rel__dir" aria-label="${e.dir === "out" ? "outgoing" : "incoming"}">${e.dir === "out" ? "→" : "←"}</span> <strong>${esc(e.otherName ?? e.other)}</strong> <span class="muted small">${esc(e.otherType ?? "")} <code>${esc(e.other)}</code></span>${attrText(k, e.attrs) ? `<span class="rel__attrs tnum">${esc(attrText(k, e.attrs))}</span>` : ""}${e.validFrom ? `<span class="rel__from small muted">from ${esc(fmtSourceTime(e.validFrom))}</span>` : ""}</li>`)
          .join("")}</ul></details>`;
      })
      .join("")}`;
}

export function renderTimeline(lines) {
  if (!Array.isArray(lines) || !lines.length) return `<p class="muted">No timeline yet.</p>`;
  return `<ol class="wm" aria-label="Source-time timeline">${lines
    .map((l) => `<li><span class="wm__at tnum">${esc(fmtSourceTime(l.at))}</span><span class="wm__kind">${esc(l.kind)}</span><span class="wm__sum">${esc(l.summary)}</span></li>`)
    .join("")}</ol>`;
}

export function mount(el, ctx) {
  el.innerHTML = `<h1 class="view-h">Graph <span class="view-h__sub">World Model</span></h1>
    <section class="panel" aria-labelledby="counts-h"><h2 class="panel__h" id="counts-h">What the World Model holds</h2><div id="counts"><p class="muted" role="status">Loading…</p></div></section>
    <div class="graph-grid">
      <section class="panel" aria-labelledby="nb-h"><h2 class="panel__h" id="nb-h">Neighbourhood <span class="panel__note" id="nb-note"></span></h2><div id="nb"><p class="muted" role="status">Loading…</p></div></section>
      <section class="panel" aria-labelledby="tl-h"><h2 class="panel__h" id="tl-h">Source-time timeline <span class="panel__note">ordered by when the source says it happened, not when it was read</span></h2><div id="tl"><p class="muted" role="status">Loading…</p></div></section>
    </div>`;
  (async () => {
    const counts = await api("/api/world");
    el.querySelector("#counts").innerHTML = counts.ok ? renderCounts(counts.data) : renderError(counts);
    let cik = ctx.params.cik ?? null;
    let name = null;
    if (!cik) {
      const id = await pickRunId(ctx.params.run ?? null);
      if (id) {
        const r = await loadRun(id);
        if (r.ok) {
          cik = r.data.cik;
          name = r.data.card?.utility?.name ?? null;
        }
      }
    }
    if (!cik) {
      el.querySelector("#nb").innerHTML = `<p class="muted">No run yet, so no utility to show. <a href="#/ask">Ask a question</a>.</p>`;
      el.querySelector("#tl").innerHTML = "";
      return;
    }
    el.querySelector("#nb-note").textContent = `${name ?? ""} CIK ${cik}`;
    const w = await api(`/api/world/${encodeURIComponent(cik)}`);
    if (!w.ok) {
      el.querySelector("#nb").innerHTML = renderError(w);
      el.querySelector("#tl").innerHTML = "";
      return;
    }
    const nb = w.data?.neighbourhood ?? w.data;
    if (!name && nb?.utility?.name) el.querySelector("#nb-note").textContent = `${nb.utility.name}, CIK ${cik}`;
    el.querySelector("#nb").innerHTML = renderNeighbourhood(nb);
    el.querySelector("#tl").innerHTML = renderTimeline(w.data?.timeline);
    ctx.setTitle("Graph");
  })();
}
