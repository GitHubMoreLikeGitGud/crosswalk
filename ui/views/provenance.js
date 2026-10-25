// The provenance drawer for one answer cell (GET /api/evidence/:run/:cell): the value and how it
// was derived, then every Lightning SQL statement behind it with its Zetaris object, the rows that
// make up this cell, the time it took, when it ran (SGT) and the cache state. renderCell is pure.

import { api, eng, esc, fmtMs, fmtNum, fmtPct, fmtSgt, renderError, safeUrl } from "../lib.js";
import { openDrawer, pushDrawer, updateDrawer } from "./drawer.js";

function cellValue(v) {
  if (v === null || v === undefined) return `<span class="null">null</span>`;
  if (typeof v === "object") return esc(JSON.stringify(v));
  if (typeof v === "number") return `<span class="tnum">${esc(Number.isInteger(v) && Math.abs(v) >= 10000 ? fmtNum(v) : String(v))}</span>`;
  return esc(String(v));
}

function rowsTable(s) {
  const cols = Array.isArray(s.columns) ? s.columns : [];
  const rows = Array.isArray(s.rows) ? s.rows : [];
  if (!rows.length) return `<p class="muted small">No row of this statement feeds this cell.</p>`;
  const tr = (r) => `<tr>${(Array.isArray(r) ? r : [r]).map((v) => `<td>${cellValue(v)}</td>`).join("")}</tr>`;
  return `<div class="table-wrap"><table class="rows"><thead><tr>${cols.map((c) => `<th scope="col">${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows.map(tr).join("")}</tbody></table></div>`;
}

function kv(label, value) {
  return `<div class="kv__row"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
}

/** "Revenue change CY2024Q1 to CY2025Q1" -> "Revenue change Q1 2024 to Q1 2025". */
export function quarterText(text) {
  return String(text ?? "").replace(/\bCY(\d{4})Q([1-4])\b/gu, "Q$2 $1");
}

/** The value of a cell in words: a change as a signed percentage, a count plain, money in millions. */
export function valueWords(field, value) {
  if (value === null || value === undefined) return "not computed";
  if (/_change$/u.test(field ?? "")) return fmtPct(value, 2);
  if (/^revenue_(current|previous)$/u.test(field ?? "")) return `${fmtNum(Number(value) / 1e6, 1)} M USD`;
  if (/^weather_(current|previous)$/u.test(field ?? "")) return `${fmtNum(value, 1)} degree days`;
  return fmtNum(value, Number.isInteger(Number(value)) ? 0 : 3);
}

export function renderStatement(s, i) {
  const objects = Array.isArray(s.zetaris_objects) && s.zetaris_objects.length ? s.zetaris_objects : s.zetaris_object ? [s.zetaris_object] : [];
  const url = safeUrl(s.source_url);
  const rowsLine = `${fmtNum(Array.isArray(s.rows) ? s.rows.length : 0)} of ${fmtNum(s.row_count)} rows of the statement feed this cell`;
  const cached = s.source_cached_at_sgt ?? s.source_cached_at;
  return `<section class="prov__stmt" aria-label="Statement ${i + 1}">
    <h3 class="prov__h">Statement ${i + 1}${objects.length ? ` over <code>${objects.map(esc).join("</code>, <code>")}</code>` : ""}</h3>
    <dl class="kv">
      ${kv("Rows", `${esc(rowsLine)}${s.rows_truncated ? ` <span class="warn-text">(the saved run kept ${esc(fmtNum(s.rows_in_run))} of ${esc(fmtNum(s.row_count))} rows)</span>` : ""}`)}
      ${kv("Time", `${esc(fmtMs(s.elapsed_ms))} <span class="label">measured</span>`)}
      ${kv("Ran at", esc(fmtSgt(s.executed_at_sgt ?? s.executed_at)) || `<span class="nm">not recorded</span>`)}
      ${kv("Cache", `${s.cache_state ? `statement cache ${esc(s.cache_state)}` : `<span class="nm">not reported</span>`}; source cached at ${cached ? esc(fmtSgt(cached)) : `<span class="nm">not reported by the gateway</span>`}`)}
      ${url || s.source_url ? kv("Source", url ? `<a href="${esc(url)}" rel="noreferrer" target="_blank">${esc(url)}</a>` : `<code class="wrap">${esc(s.source_url)}</code>`) : ""}
      ${s.licence ? kv("Licence", esc(s.licence)) : ""}
      <div class="kv__row eng-row"><dt>Ids</dt><dd><code>${esc(s.evidence_id)}</code> template <code>${esc(s.template)}</code> sha256 <code class="hash">${esc(s.sql_sha256)}</code></dd></div>
    </dl>
    ${rowsTable(s)}
    <details class="prov__sql"><summary>Lightning SQL</summary><pre><code>${esc(s.sql)}</code></pre></details>
  </section>`;
}

/** Pure: the drawer body for a cell payload. */
export function renderCell(d) {
  if (!d) return "";
  const stmts = Array.isArray(d.statements) ? d.statements : [];
  const missing = Array.isArray(d.missing) ? d.missing : [];
  return `<div class="prov">
    <p class="prov__value"><span class="fig">${esc(valueWords(d.field, d.value))}</span></p>
    ${d.derivation ? `<p class="prov__deriv"><strong>How it is computed.</strong> ${esc(d.derivation)}</p>` : ""}
    ${d.cell_rows_complete === false ? `<p class="msg msg--warn" role="note">Not every row behind this cell was kept in the saved run, so it cannot be fully recomputed here. Missing: ${missing.map(esc).join("; ")}.</p>` : ""}
    <p class="small muted">${esc(fmtNum(stmts.length))} Lightning SQL statement${stmts.length === 1 ? "" : "s"} over cached views produced this value. ${eng(`cell <code>${esc(d.cell)}</code>`)}</p>
    ${stmts.map(renderStatement).join("")}
  </div>`;
}

/** Opens the drawer for a cell of a run. */
export async function openCell(run, cell, { push = false } = {}) {
  const entry = { title: "Provenance", kicker: "Loading", html: `<p class="muted">Loading the statements behind this cell…</p>` };
  (push ? pushDrawer : openDrawer)(entry);
  const r = await api(`/api/evidence/${encodeURIComponent(run)}/${encodeURIComponent(cell)}`);
  if (!r.ok) {
    updateDrawer(entry, { kicker: "", html: renderError(r) });
    return;
  }
  updateDrawer(entry, { title: quarterText(r.data.label ?? "Provenance"), kicker: r.data.subject ?? "", html: renderCell(r.data) });
}
