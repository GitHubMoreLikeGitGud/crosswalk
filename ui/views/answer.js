// The Answer screen (GET /api/answer/:run): one row per utility that served a state with a FEMA
// major-disaster declaration in the quarter, with the declarations by type per served state, the
// revenue change year on year and the weather change at its stations. Every number is a button that
// opens the provenance drawer for that cell. renderAnswer is pure.

import { api, eng, esc, fmtMillions, fmtNum, fmtPct, plural, quarterWords, renderError, tagShort } from "../lib.js";

const TYPE_WORDS = { severe_storm: "severe storm", fire: "fire", flood: "flood", other_incidents: "other" };

/** "1 severe storm, 1 flood" from {severe_storm: 1, fire: 0, flood: 1, other_incidents: 0}. */
export function typesWords(by) {
  const parts = Object.entries(by ?? {})
    .filter(([, v]) => Number(v) > 0)
    .map(([k, v]) => `${fmtNum(v)} ${TYPE_WORDS[k] ?? k.replaceAll("_", " ")}`);
  return parts.join(", ");
}

function cellBtn(run, cell, html, label, cls = "") {
  if (!cell) return `<span class="num num--uncited${cls ? ` ${cls}` : ""}">${html}</span>`;
  return `<button type="button" class="num${cls ? ` ${cls}` : ""}" data-run="${esc(run)}" data-cell="${esc(cell)}" aria-label="${esc(label)}: open the SQL behind it">${html}</button>`;
}

function signCls(x) {
  return typeof x !== "number" ? "" : x > 0 ? "up" : x < 0 ? "down" : "flat";
}

/** Plain summary of the revenue column: how many rose, fell, were not compared. */
export function answerSummary(d) {
  const rows = Array.isArray(d?.rows) ? d.rows : [];
  const ch = rows.map((r) => r.revenue?.change);
  const rose = ch.filter((x) => typeof x === "number" && x > 0).length;
  const fell = ch.filter((x) => typeof x === "number" && x < 0).length;
  const nc = ch.filter((x) => typeof x !== "number").length;
  const states = new Set(rows.flatMap((r) => (r.states ?? []).map((s) => s.state)));
  return { utilities: rows.length, states: states.size, rose, fell, not_compared: nc };
}

export function renderRow(run, r, i) {
  const c = r.cells ?? {};
  const name = r.ticker ? `<strong>${esc(r.ticker)}</strong> <span class="ans__name">${esc(r.name)}</span>` : `<strong>${esc(r.name)}</strong>`;
  const states = (r.states ?? []).map((s) => `<li><span class="ans__st">${esc(s.state)}</span> ${esc(typesWords(s.by_incident_type) || fmtNum(s.declarations))}</li>`).join("");
  const rev = r.revenue ?? {};
  const w = r.weather ?? {};
  const revCell =
    typeof rev.change === "number"
      ? `${cellBtn(run, c.revenue_change, esc(fmtPct(rev.change, 2)), `Revenue change of ${r.ticker ?? r.name}`, `fig--s ${signCls(rev.change)}`)}
         <span class="ans__pair">${cellBtn(run, c.revenue_current, esc(fmtMillions(rev.current)), "Revenue this quarter")} vs ${cellBtn(run, c.revenue_previous, esc(fmtMillions(rev.previous)), "Revenue a year earlier")} USD</span>
         <span class="ans__tag">tag ${tagShort(rev.tag)}</span>`
      : `<span class="nm">not compared</span>${r.revenue_note || rev.note ? `<span class="ans__note">${esc(r.revenue_note ?? rev.note)}</span>` : ""}`;
  const wCell =
    typeof w.change === "number"
      ? `${cellBtn(run, c.weather_change, esc(fmtPct(w.change, 2)), `Degree-day change at the stations of ${r.ticker ?? r.name}`, `fig--s ${signCls(w.change)}`)}
         <span class="ans__pair">${cellBtn(run, c.weather_current, esc(fmtNum(w.tdd_current, 0)), "Degree days this quarter")} vs ${cellBtn(run, c.weather_previous, esc(fmtNum(w.tdd_previous, 0)), "Degree days a year earlier")} degree days</span>
         <span class="ans__tag">${esc(plural((w.stations ?? []).length, "station"))}</span>`
      : `<span class="nm">not measured</span>${r.weather_note ? `<span class="ans__note">${esc(r.weather_note)}</span>` : ""}`;
  return `<tr>
    <td class="r muted tnum">${i + 1}</td>
    <th scope="row" class="ans__util">${name} ${eng(`<code>CIK ${esc(r.cik)}</code>`)}</th>
    <td><ul class="ans__states">${states}</ul></td>
    <td class="r">${cellBtn(run, c.declarations, esc(fmtNum(r.declarations)), `Declarations in the states ${r.ticker ?? r.name} serves`, "fig--s")}</td>
    <td class="ans__rev">${revCell}</td>
    <td class="ans__w">${wCell}</td>
  </tr>`;
}

/** Pure: the whole Answer screen from the answer payload; question is the run's question text. */
export function renderAnswer(d, question = "") {
  if (!d) return "";
  const run = d.run_id;
  const rows = Array.isArray(d.rows) ? d.rows : [];
  const s = answerSummary(d);
  const q = quarterWords(d.quarter);
  const p = quarterWords(d.previous);
  const defs = d.definitions ?? {};
  const nt = Array.isArray(d.not_tested) ? d.not_tested : [];
  return `<section class="ans">
    <h1 class="view-h">Answer <span class="view-h__sub">${esc(q)} against ${esc(p)}</span></h1>
    ${question ? `<p class="ans__q"><q>${esc(question)}</q></p>` : ""}
    <p class="ans__lead">${esc(fmtNum(s.utilities))} utilities served ${esc(fmtNum(s.states))} states with FEMA major-disaster declarations in ${esc(q)}. Revenue against ${esc(p)}: rose for ${esc(fmtNum(s.rose))}, fell for ${esc(fmtNum(s.fell))}${s.not_compared ? `, not compared for ${esc(fmtNum(s.not_compared))}` : ""}. Click any number to see the Lightning SQL behind it.</p>
    <div class="panel"><div class="table-wrap"><table class="ans__t">
      <thead><tr><th scope="col" class="r">#</th><th scope="col">Utility</th><th scope="col">Served states with declarations (by type)</th><th scope="col" class="r">Declarations</th><th scope="col">Revenue, ${esc(q)} vs ${esc(p)}</th><th scope="col">Weather at its stations (total degree days)</th></tr></thead>
      <tbody>${rows.map((r, i) => renderRow(run, r, i)).join("") || `<tr><td colspan="6" class="nm">No utility in this answer.</td></tr>`}</tbody>
    </table></div></div>
    <div class="ans__foot">
      <div class="panel"><h2 class="panel__h">How each column is computed</h2><dl class="defs">${Object.entries(defs)
        .map(([k, v]) => `<div class="defs__row"><dt>${esc(k.replaceAll("_", " "))}</dt><dd>${esc(v)}</dd></div>`)
        .join("")}</dl></div>
      <div class="panel"><h2 class="panel__h">Not tested</h2><ul class="nt">${nt.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
    </div>
  </section>`;
}

export function mount(el, ctx) {
  ctx.setTitle?.("Answer");
  el.innerHTML = `<p class="muted">Loading the answer…</p>`;
  let alive = true;
  (async () => {
    const r = await api(`/api/answer/${encodeURIComponent(ctx.run)}`);
    if (!alive) return;
    if (!r.ok) {
      el.innerHTML = r.status === 202 ? `<p class="msg">This run is still running; the answer appears when it finishes.</p>` : renderError(r);
      return;
    }
    el.innerHTML = renderAnswer(r.data, ctx.meta?.question ?? "");
  })();
  return () => {
    alive = false;
  };
}
