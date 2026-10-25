// Join map screen: verdict summary, who proposed the keys, a small graph of tables and keys,
// and one table row per measured (or recalled) key with both rates, orphans and the SQL.

import { api, esc } from "../lib.js";

const VERDICT_CLASS = { VERIFIED: "good", PARTIAL: "mid", REJECTED: "bad" };

/** VERIFIED -> good, PARTIAL -> mid, REJECTED -> bad, else neutral. */
export function verdictClass(v) {
  return VERDICT_CLASS[v] ?? "neutral";
}

/** Plain words for a closed-set transform name (or the name itself when unknown). */
export function transformWords(t) {
  const name = String(t ?? "");
  if (name === "identity") return "as is";
  if (name === "upper") return "upper-cased";
  if (name === "lpad10") return "padded to 10 digits with leading zeros";
  if (name === "yyyymmdd_to_date") return "read as a date";
  if (name === "iso_to_quarter") return "bucketed to a calendar quarter";
  if (name === "strip_prefix" || name.startsWith("strip_prefix(")) return "prefix removed";
  const m = /^substr\((\d+)\s*,\s*(\d+)\)$/u.exec(name);
  if (m) {
    const start = Number(m[1]);
    const len = Number(m[2]);
    return `characters ${start} to ${start + len - 1}`;
  }
  return name;
}

/** Who proposed a key, in analyst words; duplicates removed. */
export function proposerWords(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const s = String(raw ?? "");
    let w;
    if (s === "planner") w = "the model";
    else if (s === "baseline" || s === "baseline (queue)") w = "name-match baseline";
    else if (s === "control") w = "control (deliberately without the transform)";
    else w = s;
    if (!w || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out.join(", ");
}

/**
 * "<matched> of <total> <unit> (<pct>)", or "not measured" when a count is null.
 * unit is "rows" or "distinct values".
 */
export function rateText(matched, total, rate, unit) {
  if (matched === null || matched === undefined || total === null || total === undefined) return "not measured";
  const pct = typeof rate === "number" && !Number.isNaN(rate) ? `${(rate * 100).toFixed(1)}%` : "n/a";
  return `${matched} of ${total} ${unit} (${pct})`;
}

function elapsedWords(ms) {
  if (typeof ms !== "number" || Number.isNaN(ms)) return "";
  if (ms >= 1000) return `in ${(ms / 1000).toFixed(1)} s`;
  return `in ${ms} ms`;
}

function objectLabel(object) {
  const s = String(object ?? "");
  return s.startsWith("cw.") ? s.slice(3) : s;
}

function proposalValid(p) {
  if (typeof p.valid === "number") return p.valid;
  if (typeof p.made === "number") return p.made - (Number(p.invalid_schema) || 0);
  return null;
}

function proposalCell(n) {
  return n === null || n === undefined ? "—" : esc(String(n));
}

function proposerRow(label, p) {
  if (!p || typeof p !== "object") {
    return `<tr><th scope="row">${esc(label)}</th><td colspan="6" class="muted">not recorded</td></tr>`;
  }
  return `<tr><th scope="row">${esc(label)}</th><td class="tnum">${proposalCell(p.made)}</td><td class="tnum">${proposalCell(proposalValid(p))}</td><td class="tnum">${proposalCell(p.verified)}</td><td class="tnum">${proposalCell(p.partial)}</td><td class="tnum">${proposalCell(p.rejected)}</td><td class="tnum">${proposalCell(p.unmeasurable)}</td></tr>`;
}

/** Counts sentence and the "Who proposed the keys" table. */
export function renderSummary(data) {
  const c = data?.counts ?? {};
  const other = c.other > 0 ? `, ${c.other} other` : "";
  const sentence = `${c.keys ?? 0} keys: ${c.verified ?? 0} VERIFIED, ${c.partial ?? 0} PARTIAL, ${c.rejected ?? 0} REJECTED${other}; ${c.measured_in_run ?? 0} measured in this run, ${c.recalled ?? 0} recalled from memory.`;
  const props = data?.proposals ?? {};
  return `<div class="panel jm-summary">
    <h2 class="panel__h">Summary</h2>
    <p class="jm-counts">${esc(sentence)}</p>
    <h3 class="jm-subh">Who proposed the keys</h3>
    <div class="table-wrap"><table class="jm-proposers">
      <thead><tr><th scope="col">Proposer</th><th scope="col">Made</th><th scope="col">Valid</th><th scope="col">VERIFIED</th><th scope="col">PARTIAL</th><th scope="col">REJECTED</th><th scope="col">Unmeasurable</th></tr></thead>
      <tbody>
        ${proposerRow("The model (NVIDIA Nemotron 3 Nano 4B)", props.model)}
        ${proposerRow("Name-match baseline (no model)", props.baseline)}
      </tbody>
    </table></div>
    <p class="small muted jm-proposers-note">Both sides propose from the same probed columns; every proposal is measured by the same Lightning SQL statement.</p>
  </div>`;
}

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Inline SVG of tables (nodes) and keys (edges), plus a verdict colour legend. */
export function renderJoinGraph(data) {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const order = [];
  const seen = new Set();
  for (const r of rows) {
    for (const obj of [r.left?.object, r.right?.object]) {
      if (!obj || seen.has(obj)) continue;
      seen.add(obj);
      order.push(obj);
    }
  }
  const n = order.length || 1;
  const cx = 480;
  const cy = 200;
  const rx = 360;
  const ry = 150;
  const nodes = new Map();
  for (let i = 0; i < order.length; i++) {
    const theta = -Math.PI / 2 + (2 * Math.PI * i) / n;
    const x = cx + rx * Math.cos(theta);
    const y = cy + ry * Math.sin(theta);
    const label = objectLabel(order[i]);
    const w = label.length * 8 + 20;
    const h = 28;
    nodes.set(order[i], { x, y, label, w, h });
  }

  const pairCount = new Map();
  const lines = [];
  const labels = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const a = nodes.get(r.left.object);
    const b = nodes.get(r.right.object);
    if (!a || !b) continue;
    const cls = verdictClass(r.verdict);
    const dash = r.verdict === "REJECTED" ? ` stroke-dasharray="6 4"` : "";
    const pk = pairKey(r.left.object, r.right.object);
    const k = pairCount.get(pk) ?? 0;
    pairCount.set(pk, k + 1);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const off = k * 7;
    const px = -uy * off;
    const py = ux * off;
    lines.push(`<line x1="${(a.x + px).toFixed(1)}" y1="${(a.y + py).toFixed(1)}" x2="${(b.x + px).toFixed(1)}" y2="${(b.y + py).toFixed(1)}" class="jm-edge jm-edge--${cls}" stroke="var(--${cls}-edge)" stroke-width="2.5"${dash}/>`);

    const shift = k * 24;
    const mx = (a.x + b.x) / 2 + ux * shift + px;
    const my = (a.y + b.y) / 2 + uy * shift + py;
    const num = i + 1;
    labels.push(`<g class="jm-edge-label"><circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="11" class="jm-edge-num jm-edge-num--${cls}"/><text x="${mx.toFixed(1)}" y="${(my + 4).toFixed(1)}" text-anchor="middle" class="jm-edge-num-t">${esc(String(num))}</text></g>`);
  }

  const nodeEls = [];
  for (const [, node] of nodes) {
    const x = node.x - node.w / 2;
    const y = node.y - node.h / 2;
    nodeEls.push(`<g class="jm-node"><rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${node.w}" height="${node.h}" rx="6" ry="6"/><text x="${node.x.toFixed(1)}" y="${(node.y + 5).toFixed(1)}" text-anchor="middle" font-size="13">${esc(node.label)}</text></g>`);
  }

  const ariaParts = rows.map((r, i) => `${i + 1}: ${r.left?.ref ?? ""} to ${r.right?.ref ?? ""}, ${r.verdict ?? "unknown"}`);
  const aria = ariaParts.join("; ");

  const legend = `<ul class="jm-legend" aria-label="Verdict colours"><li class="jm-legend__i jm-legend__i--good"><span class="jm-legend__swatch" aria-hidden="true"></span>VERIFIED</li><li class="jm-legend__i jm-legend__i--mid"><span class="jm-legend__swatch" aria-hidden="true"></span>PARTIAL</li><li class="jm-legend__i jm-legend__i--bad"><span class="jm-legend__swatch" aria-hidden="true"></span>REJECTED</li></ul>`;

  return `<div class="panel jm-graph-panel">
    <h2 class="panel__h">Join graph</h2>
    <div class="jm-graph">
      <svg viewBox="0 0 960 400" role="img" aria-label="${esc(aria)}" class="jm-graph__svg">${lines.join("")}${labels.join("")}${nodeEls.join("")}</svg>
      ${legend}
    </div>
  </div>`;
}

function transformCell(row) {
  const name = String(row.transform ?? "");
  const words = transformWords(name);
  let applies = "";
  if (row.transform_applies_to === "left") applies = " on the left column";
  else if (row.transform_applies_to === "right") applies = " on the right column";
  return `<code class="jm-xform-name">${esc(name)}</code> <span class="jm-xform-words">${esc(words)}${esc(applies)}</span>`;
}

function provenanceCell(row, definitions) {
  if (row.recalled) {
    const tip = definitions?.recalled ? ` title="${esc(definitions.recalled)}"` : "";
    const mem = row.memory_id ? ` <span class="eng">${esc(row.memory_id)}</span>` : "";
    const as = row.measured_as ? ` <span class="eng">${esc(row.measured_as)}</span>` : "";
    return `<span class="jm-prov jm-prov--recalled"${tip}>Recalled from memory</span>${mem}${as}`;
  }
  const el = elapsedWords(row.elapsed_ms);
  const as = row.measured_as ? ` <span class="eng">${esc(row.measured_as)}</span>` : "";
  return `<span class="jm-prov jm-prov--measured">Measured in this run${el ? ` ${esc(el)}` : ""}</span>${as}`;
}

function orphansCell(orphans, row = {}) {
  const list = Array.isArray(orphans) ? orphans.slice(0, 10) : [];
  const unmatched = typeof row.matched_rows === "number" && typeof row.left_rows === "number" ? row.left_rows - row.matched_rows : null;
  if (!list.length && unmatched) return `<span class="muted">${esc(String(unmatched))} unmatched; not listed by this statement</span>`;
  if (!list.length) return `<span class="muted">none</span>`;
  return `<ul class="jm-orphans">${list.map((o) => `<li><code>${esc(o)}</code></li>`).join("")}</ul>`;
}

function sqlDetails(row) {
  const sql = row.sql ?? "";
  const orphans = row.sql_orphans
    ? `<p class="small muted jm-sql-orphans-h">Orphans listed by:</p><pre class="jm-sql"><code>${esc(row.sql_orphans)}</code></pre>`
    : "";
  return `<details class="jm-sql-details"><summary>SQL</summary><pre class="jm-sql"><code>${esc(sql)}</code></pre>${orphans}</details>`;
}

function oneRow(row, index, definitions) {
  const n = index + 1;
  const v = row.verdict ?? "—";
  const cls = verdictClass(row.verdict);
  const def = row.verdict_definition ?? (row.verdict && definitions?.[row.verdict]) ?? "";
  const rate = rateText(row.matched_rows, row.left_rows, row.rate, "rows");
  const distinct = rateText(row.matched_keys, row.left_keys, row.rate_distinct, "distinct values");
  const proposers = proposerWords(row.proposed_by);
  return `<tr class="jm-row jm-row--${cls}">
    <td class="tnum jm-n">${esc(String(n))}</td>
    <td class="jm-sides"><div class="jm-ref">${esc(row.left?.ref ?? "")}</div><div class="jm-ref jm-ref--right">${esc(row.right?.ref ?? "")}</div><span class="eng">${esc(row.id ?? "")}</span><span class="eng">${esc(row.key ?? "")}</span>${row.label && !String(row.label).includes(" ~ ") ? `<div class="small muted jm-label">${esc(row.label)}</div>` : ""}</td>
    <td class="jm-xform">${transformCell(row)}</td>
    <td class="jm-rate"><div class="jm-rate-rows tnum">${esc(rate)}</div><div class="jm-rate-dist tnum small muted">${esc(distinct)}</div></td>
    <td class="jm-verdict"><span class="chip chip--${cls}">${esc(v)}</span><span class="jm-verdict-def small">${esc(def)}</span></td>
    <td class="jm-orphans-cell">${orphansCell(row.orphans, row)}</td>
    <td class="jm-prov-cell">${provenanceCell(row, definitions)}<div class="small muted">${esc(proposers)}</div></td>
    <td class="jm-sql-cell">${sqlDetails(row)}</td>
  </tr>`;
}

/** One row per key: sides, transform, rates, verdict, orphans, provenance, SQL. */
export function renderJoinTable(data) {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const definitions = data?.definitions ?? {};
  const orphanHelp = definitions.orphan ? `<span class="small muted"> ${esc(definitions.orphan)}</span>` : "";
  const body = rows.map((r, i) => oneRow(r, i, definitions)).join("");
  return `<div class="panel jm-table-panel">
    <h2 class="panel__h">Keys</h2>
    <div class="table-wrap"><table class="jm-table">
      <thead><tr>
        <th scope="col">#</th>
        <th scope="col">Left → right</th>
        <th scope="col">Transform</th>
        <th scope="col">Rate</th>
        <th scope="col">Verdict</th>
        <th scope="col">Orphans${orphanHelp}</th>
        <th scope="col">Provenance</th>
        <th scope="col">SQL</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table></div>
  </div>`;
}

function renderDefinitions(definitions) {
  const entries = definitions && typeof definitions === "object" ? Object.entries(definitions) : [];
  if (!entries.length) return "";
  const items = entries.map(([k, v]) => `<dt class="jm-def__k">${esc(k)}</dt><dd class="jm-def__v">${esc(v)}</dd>`).join("");
  return `<div class="panel jm-def-panel"><h2 class="panel__h">Definitions</h2><dl class="jm-def">${items}</dl></div>`;
}

/** The whole Join map section. */
export function renderJoinMap(data) {
  return `<section class="jm">
    <h1 class="view-h">Join map</h1>
    <p class="view-h__sub muted">Which columns join which, measured in Lightning SQL over cached views.</p>
    ${renderSummary(data)}
    ${renderJoinGraph(data)}
    ${renderJoinTable(data)}
    ${renderDefinitions(data?.definitions)}
  </section>`;
}

/** Mount: load /api/joinmap/<run>, render or show the server's error. Returns a cleanup. */
export function mount(el, ctx) {
  ctx?.setTitle?.("Join map");
  const run = ctx?.run ?? ctx?.params?.run;
  el.innerHTML = `<p class="muted" role="status">Loading the join map…</p>`;
  if (!run) {
    el.innerHTML = `<p class="msg msg--error" role="alert">No run selected.</p>`;
    return () => {};
  }
  let cancelled = false;
  api(`/api/joinmap/${encodeURIComponent(run)}`).then((r) => {
    if (cancelled) return;
    if (!r.ok) {
      const msg = r.data && typeof r.data === "object" && typeof r.data.error === "string" ? r.data.error : `request failed (${r.status})`;
      el.innerHTML = `<p class="msg msg--error" role="alert">${esc(msg)}</p>`;
      return;
    }
    el.innerHTML = renderJoinMap(r.data);
  });
  return () => {
    cancelled = true;
  };
}
