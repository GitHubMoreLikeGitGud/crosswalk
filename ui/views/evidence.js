// The evidence drawer: where each number came from, with the Lightning SQL text as the citation.
// renderEvidence is pure; openEvidence shows the drawer from the remembered run.json records or
// GET /api/run/:id/evidence/:eid.

import { api, esc, evidenceChips, evidenceRecord, evShort, EV_KIND_LONG, fieldOrMissing, fmtMs, fmtNum, fmtTime, linkMemoryIds, rememberEvidence, runOfEvidence, safeUrl } from "../lib.js";
import { openDrawer, pushDrawer, updateDrawer } from "./drawer.js";

const KIND_LABEL = {
  zetaris_sql: "Zetaris Lightning SQL",
  dq: "Zetaris data quality",
  tool: "Deterministic tool",
  model: "Local model",
  memory: "H-MEM memory",
  registrar: "Zetaris registrar",
  world_model: "World Model",
};
const SHORT = { zetaris_sql: "SQL", dq: "DQ", tool: "Tool", model: "Model", memory: "Memory", registrar: "Registrar", world_model: "World" };
const SQL_KINDS = new Set(["zetaris_sql", "dq", "registrar"]);

/** A result cell: large integers get thousands separators; years, counts and small ids stay plain. */
function cell(v) {
  if (v === null || v === undefined) return `<span class="null">null</span>`;
  if (typeof v === "object") return esc(JSON.stringify(v));
  if (typeof v === "number") return `<span class="tnum">${esc(Number.isInteger(v) && Math.abs(v) >= 10000 ? fmtNum(v) : String(v))}</span>`;
  return esc(String(v));
}

function rowsTable(rec) {
  const cols = Array.isArray(rec.columns) ? rec.columns : [];
  const rows = Array.isArray(rec.rows) ? rec.rows : [];
  const count = typeof rec.row_count === "number" ? rec.row_count : null;
  const head = `<p class="rows__count">${esc(fmtNum(rows.length))} of ${count === null ? `<span class="missing">missing</span>` : esc(fmtNum(count))} row${count === 1 ? "" : "s"} kept in the record</p>`;
  if (!rows.length) return `${head}<p class="muted">The statement returned no rows.</p>`;
  const first = rows.slice(0, 12);
  const rest = rows.slice(12);
  const tr = (r) => `<tr>${(Array.isArray(r) ? r : [r]).map((v) => `<td>${cell(v)}</td>`).join("")}</tr>`;
  return `${head}<div class="table-wrap"><table class="rows"><thead><tr>${cols.map((c) => `<th scope="col">${esc(c)}</th>`).join("")}</tr></thead><tbody>${first.map(tr).join("")}</tbody>${
    rest.length ? `<tbody class="rows__rest" hidden>${rest.map(tr).join("")}</tbody>` : ""
  }</table></div>${rest.length ? `<button type="button" class="btn btn--small" data-show-rows>Show the other ${esc(fmtNum(rest.length))} rows</button>` : ""}`;
}

function kv(label, value) {
  return `<div class="kv__row"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
}

function link(url) {
  const u = safeUrl(url);
  return u ? `<a href="${esc(u)}" rel="noreferrer" target="_blank">${esc(u)}</a>` : `<code>${esc(url)}</code>`;
}

function modelBlock(m) {
  if (!m) return `<span class="missing">missing</span>`;
  return `<dl class="kv kv--inline">
    ${kv("Model", `${esc(m.name)} <span class="muted">via Ollama, local host only</span>`)}
    ${kv("Thinking", m.think ? "on" : "off")}
    ${kv("Tokens in / out", `${esc(fmtNum(m.tokens_in))} / ${esc(fmtNum(m.tokens_out))} <span class="label">${esc(m.label ?? "measured")}</span>`)}
    ${kv("Attempts", esc(fmtNum(m.attempts)))}
    ${kv("Speed", m.tokens_per_s ? `${esc(fmtNum(m.tokens_per_s, 1))} tok/s <span class="label">${esc(m.label ?? "measured")}</span>` : "not measured")}
    ${kv("Prompt sha256", `<code class="hash">${esc(m.prompt_sha256)}</code>`)}
  </dl>`;
}

function provenanceBlock(p) {
  if (!p || typeof p !== "object") return "";
  return `<h4>Provenance of the memory</h4><dl class="kv">
    ${kv("Zetaris object", `<code>${esc(p.zetaris_object)}</code>`)}
    ${kv("Endpoint", link(p.endpoint))}
    ${p.accn ? kv("Accession", `<code>${esc(p.accn)}</code>${p.filed ? ` filed ${esc(p.filed)}` : ""}`) : ""}
    ${kv("Licence", esc(p.licence))}
    ${kv("Retrieved", `${esc(fmtTime(p.retrieved_at, true))} <span class="muted">(${esc(p.cache_state ?? "cache state not recorded")}, ${esc(fmtMs(p.latency_ms))})</span>`)}
    ${kv("From evidence", evidenceChips(p.run_id ?? null, p.evidence_id ? [p.evidence_id] : []))}
  </dl>`;
}

function detailsBlock(rec) {
  const d = rec.details;
  if (!d || typeof d !== "object") return "";
  let special = "";
  if (Array.isArray(d.allowed)) {
    special = `<h4>Numbers the memo was allowed to use (${esc(fmtNum(d.allowed.length))})</h4><ul class="allowed">${d.allowed.map((a) => `<li><span class="tnum">${esc(a.text)}</span> <span class="muted">${esc(a.label)}</span></li>`).join("")}</ul>`;
  } else if (d.memory_id) {
    special = `<p>Memory ${linkMemoryIds(d.memory_id)}${d.tag ? `, tag <code>${esc(d.tag)}</code>` : ""}</p>${provenanceBlock(d.provenance)}`;
  } else if (Array.isArray(d.peers)) {
    special = `<p>${esc(fmtNum(d.peers.length))} peers with both quarters; the card's peers table lists them with their tag, growth and degree-day change.</p>`;
  }
  return `${special}<details class="raw"><summary>Details as stored</summary><pre>${esc(JSON.stringify(d, null, 2))}</pre></details>`;
}

/** One record, every field visible; a required field that is absent shows "missing". */
export function renderRecord(rec) {
  if (!rec || typeof rec !== "object") return "";
  if (rec.error) return `<article class="evrec evrec--error" id="evrec-${esc(rec.id)}" tabindex="-1"><h3 class="evrec__claim">${esc(rec.id)}</h3><p class="msg msg--error">${esc(rec.error)}</p></article>`;
  const sql = SQL_KINDS.has(rec.kind) || typeof rec.sql === "string";
  const parts = [];
  parts.push(`<header class="evrec__head"><span class="evrec__n">Record ${esc(evShort(rec.id))}</span><span class="kind kind--${esc(rec.kind)}">${esc(KIND_LABEL[rec.kind] ?? rec.kind ?? "")}</span><code class="evrec__id">${fieldOrMissing(rec.id)}</code><span class="muted">run <code>${fieldOrMissing(rec.run_id)}</code></span></header>`);
  parts.push(`<h3 class="evrec__claim">${fieldOrMissing(rec.claim, (v) => linkMemoryIds(v))}</h3>`);
  if (sql) {
    const pre = `sql-${String(rec.id ?? "x").replace(/[^A-Za-z0-9-]/gu, "")}`;
    parts.push(`<section class="cite" aria-label="Lightning SQL citation">
      <div class="cite__bar"><span class="cite__title">Lightning SQL, the citation for this claim</span>${rec.sql ? `<button type="button" class="btn btn--small btn--oncite" data-copy="${esc(pre)}">Copy SQL</button>` : ""}</div>
      ${rec.sql ? `<pre class="sql" id="${esc(pre)}">${esc(rec.sql)}</pre>` : `<p class="sql sql--missing"><span class="missing">missing</span></p>`}
      <p class="cite__hash">sha256 ${fieldOrMissing(rec.sql_sha256, (v) => `<code class="hash">${esc(v)}</code>`)}</p>
    </section>`);
  }
  const rows = [];
  if (rec.template_id || sql) rows.push(kv("Template", `${fieldOrMissing(rec.template_id, (v) => `<code>${esc(v)}</code>`)}${rec.params && Object.keys(rec.params).length ? ` <span class="muted">${esc(Object.entries(rec.params).map(([k, v]) => `${k}=${Array.isArray(v) ? `${v.length} ids` : v}`).join(", "))}</span>` : ""}`));
  if (sql || rec.zetaris_object) rows.push(kv("Zetaris object", fieldOrMissing(rec.zetaris_object, (v) => `<code>${esc(v)}</code>`)));
  if (Array.isArray(rec.raw_objects) && rec.raw_objects.length) rows.push(kv("Raw objects", rec.raw_objects.map((o) => `<code>${esc(o)}</code>`).join("<br>")));
  if (sql || rec.source_url) rows.push(kv("Endpoint", fieldOrMissing(rec.source_url, link)));
  if (sql || rec.licence) rows.push(kv("Licence", fieldOrMissing(rec.licence)));
  if (Array.isArray(rec.sources) && rec.sources.length > 1) {
    rows.push(kv("Sources", `<ul class="srclist">${rec.sources.map((s) => `<li><code>${esc(s.object)}</code><br>${link(s.url)}<br><span class="muted">${esc(s.licence)}${s.cached_at ? `; cached ${esc(fmtTime(s.cached_at, true))}` : ""}</span></li>`).join("")}</ul>`));
  }
  if (rows.length) parts.push(`<dl class="kv">${rows.join("")}</dl>`);
  const timeCells = [`<div class="times__cell"><span class="times__k">Retrieved</span><span class="times__v">${fieldOrMissing(rec.queried_at, (v) => `<time datetime="${esc(v)}">${esc(fmtTime(v, true))}</time>`)}</span></div>`];
  if (sql) timeCells.push(`<div class="times__cell"><span class="times__k">Latency</span><span class="times__v">${fieldOrMissing(rec.elapsed_ms, (v) => esc(fmtMs(v)))}</span></div>`);
  if (sql) timeCells.push(`<div class="times__cell"><span class="times__k">Cache state</span><span class="times__v">${fieldOrMissing(rec.cache_state)}</span></div>`);
  if (sql && rec.source_cached_at !== undefined) timeCells.push(`<div class="times__cell"><span class="times__k">Source cached</span><span class="times__v">${rec.source_cached_at ? `<time datetime="${esc(rec.source_cached_at)}">${esc(fmtTime(rec.source_cached_at, true))}</time>` : "not recorded"}</span></div>`);
  if (sql) timeCells.push(`<div class="times__cell"><span class="times__k">Rows</span><span class="times__v">${fieldOrMissing(rec.row_count, (v) => esc(fmtNum(v)))}</span></div>`);
  if (rec.kind === "dq") timeCells.push(`<div class="times__cell"><span class="times__k">DQ source</span><span class="times__v">${fieldOrMissing(rec.dq_source, (v) => (v === "zetaris_dq" ? "Zetaris DQ (RUN DQ / SHOW DQ INVALID RECORD)" : esc(v)))}${rec.reused ? " <span class='muted'>(onboarding run, reused)</span>" : ""}</span></div>`);
  parts.push(`<div class="times">${timeCells.join("")}</div>`);
  if (sql) parts.push(rowsTable(rec));
  if (rec.kind === "model" || rec.model) parts.push(`<h4>Model</h4>${modelBlock(rec.model)}`);
  const derived = (Array.isArray(rec.derived_from) ? rec.derived_from : typeof rec.derived_from === "string" ? [rec.derived_from] : []).filter((id) => id !== rec.id);
  if (derived.length) parts.push(`<p class="derived">Derived from ${evidenceChips(rec.run_id, derived)}</p>`);
  parts.push(detailsBlock(rec));
  return `<article class="evrec" id="evrec-${esc(rec.id)}" tabindex="-1">${parts.join("")}</article>`;
}

/** The drawer body for one or more records (each a record or { id, error }). */
export function renderEvidence(records) {
  const list = (Array.isArray(records) ? records : [records]).filter(Boolean);
  if (!list.length) return `<p class="muted">No evidence records.</p>`;
  const index =
    list.length > 1
      ? `<nav class="evindex" aria-label="Records cited"><span>${list.length} records cited, jump to:</span> ${list.map((r) => `<button type="button" class="ev ev--jump" data-jump="evrec-${esc(r.id)}" data-kind="${esc(r.kind ?? "unknown")}" aria-label="Go to record ${esc(evShort(r.id))}: ${esc(KIND_LABEL[r.kind] ?? r.kind ?? "")}"><span class="ev__k" aria-hidden="true">${esc(SHORT[r.kind] ?? "Record")}</span><span class="ev__n" aria-hidden="true">${esc(evShort(r.id))}</span></button>`).join(" ")}</nav>`
      : "";
  return `${index}${list.map(renderRecord).join("")}`;
}

async function fetchRecord(runId, id) {
  const known = evidenceRecord(id);
  if (known && known.kind) return known;
  const run = runOfEvidence(id, runId);
  if (!run) return { id, error: "this evidence id names no run" };
  const r = await api(`/api/run/${encodeURIComponent(run)}/evidence/${encodeURIComponent(id)}`);
  return r.ok && r.data ? r.data : { id, error: r.data?.error ?? `HTTP ${r.status}` };
}

/** Fetches the records and shows them; inside the drawer it stacks (Back returns). */
export async function openEvidence(runId, ids, opts = {}) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  if (!list.length) return;
  const start = opts.start && list.includes(opts.start) ? opts.start : list[0];
  const entry = (opts.push ? pushDrawer : openDrawer)({
    title: list.length > 1 ? `Evidence for this number (${list.length} records)` : `Evidence record ${evShort(list[0])}`,
    kicker: "Where this came from",
    html: `<p class="muted" role="status">Loading ${list.length} evidence record${list.length === 1 ? "" : "s"}…</p>`,
  });
  const recs = await Promise.all(list.map((id) => fetchRecord(runId, id)));
  rememberEvidence(recs.filter((r) => !r.error));
  const one = recs.length === 1 && !recs[0].error ? recs[0] : null;
  updateDrawer(entry, { ...(one ? { title: `Evidence record ${evShort(one.id)}: ${KIND_LABEL[one.kind] ?? one.kind}`, kicker: EV_KIND_LONG[one.kind] ?? "Where this came from" } : {}), html: renderEvidence(recs), focus: `#evrec-${CSS.escape(start)}` });
}
