// Evaluation: data/eval/report.json from GET /api/eval rendered as tables, "Not yet measured"
// on 404. The report is the evaluation script's (agent/src/eval): the known sections get their
// own tables (totals, runs, cold vs warm, attribution, peers, coverage, DQ, join map); anything
// else falls back to a generic renderer. renderReport is pure.

import { api, esc, fmtMs, fmtNum, fmtPct, fmtTime, renderError, tagShort } from "../lib.js";

const NONE = `<span class="muted">none</span>`;

function num(v, digits = 0) {
  return v === null || v === undefined ? `<span class="null">null</span>` : `<span class="tnum">${esc(fmtNum(v, digits))}</span>`;
}

function yes(v) {
  return v === true ? `<span class="tick">yes</span>` : v === false ? `<span class="cross">no</span>` : `<span class="null">null</span>`;
}

function table(cols, rows, cls = "num") {
  return `<div class="table-wrap"><table class="${esc(cls)} eval__t"><thead><tr>${cols.map((c) => `<th scope="col"${c.r ? ' class="r"' : ""}>${esc(c.h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((v, i) => `<td${cols[i]?.r ? ' class="r"' : ""}>${v}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

function tile(k, v, note = "") {
  return `<div class="count"><span class="count__v fig fig--s">${v}</span><span class="count__k">${esc(k)}</span>${note ? `<span class="count__n small muted">${note}</span>` : ""}</div>`;
}

function panel(id, title, note, body) {
  return `<section class="panel" aria-labelledby="ev-${esc(id)}"><h2 class="panel__h" id="ev-${esc(id)}">${esc(title)}${note ? ` <span class="panel__note">${note}</span>` : ""}</h2>${body}</section>`;
}

// ---------- generic fallback ----------

function scalar(v) {
  if (v === null || v === undefined) return `<span class="null">null</span>`;
  if (typeof v === "number") return `<span class="tnum">${esc(Number.isInteger(v) ? fmtNum(v) : fmtNum(v, 4))}</span>`;
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/u.test(v)) return esc(fmtTime(v, true));
  return esc(String(v));
}

function isTable(arr) {
  return Array.isArray(arr) && arr.length > 0 && arr.every((x) => x && typeof x === "object" && !Array.isArray(x));
}

function generic(v, depth = 0) {
  if (isTable(v)) {
    const cols = [...new Set(v.flatMap((r) => Object.keys(r)))];
    return table(cols.map((c) => ({ h: c.replaceAll("_", " ") })), v.map((r) => cols.map((c) => generic(r[c], depth + 1))));
  }
  if (Array.isArray(v)) return v.length ? `<ul class="eval__list">${v.map((x) => `<li>${generic(x, depth + 1)}</li>`).join("")}</ul>` : NONE;
  if (v && typeof v === "object") {
    const entries = Object.entries(v);
    if (!entries.length) return `<span class="muted">empty</span>`;
    if (depth >= 2) return `<code>${esc(JSON.stringify(v))}</code>`;
    return `<dl class="kv kv--eval">${entries.map(([k, x]) => `<div class="kv__row"><dt>${esc(k.replaceAll("_", " "))}</dt><dd>${generic(x, depth + 1)}</dd></div>`).join("")}</dl>`;
  }
  return scalar(v);
}

// ---------- known sections ----------

function totalsPanel(t) {
  const tiles = [
    tile("runs", num(t.runs)),
    tile("planner calls", num(t.planner_calls), `${esc(fmtNum(t.valid_first_try))} valid first try, ${esc(fmtNum(t.repaired))} repaired${t.repairs_think_off ? ` (${esc(fmtNum(t.repairs_think_off))} think off)` : ""}`),
    tile("fallback steps", num(t.fallbacks)),
    tile("tool calls by the model", num(t.tool_calls_by_model)),
    tile("memo drafts", num(t.memo_drafts), `${esc(fmtNum(t.memo_drafts_with_unknown_numbers))} with an unknown number; ${esc(fmtNum(t.model_memos))} model memos kept, ${esc(fmtNum(t.template_memos))} template`),
    tile("evidence records complete", `${num(t.evidence_complete)} / ${num(t.evidence_records)}`, "E-complete: every required field and a resolved object name"),
    tile("claims with evidence", `${num(t.claims_with_evidence)} / ${num(t.claims)}`, "E-cov"),
    tile("cloud model calls", num(t.cloud_model_calls)),
    tile("refused hosts", num(t.refused_hosts)),
  ];
  return panel("totals", "Totals over every run", "measured", `<div class="counts__row">${tiles.join("")}</div>`);
}

function runsPanel(runs) {
  const cols = [
    { h: "Run" },
    { h: "Utility" },
    { h: "Mode" },
    { h: "Chunks", r: true },
    { h: "Wall", r: true },
    { h: "Planner calls (valid first try / repaired / fallbacks)", r: true },
    { h: "tok/s", r: true },
    { h: "Memo" },
    { h: "E-complete", r: true },
    { h: "E-cov", r: true },
    { h: "Verdict" },
    { h: "DQ" },
    { h: "degree-day SQL", r: true },
  ];
  const rows = runs.map((r) => {
    const drafts = Array.isArray(r.memo?.drafts) ? r.memo.drafts.map((d) => `draft ${d.attempt}: ${d.words} words, ${d.unknown_numbers} unknown number(s), ${d.ok ? "kept" : "rejected"}`).join("; ") : "";
    const link = r.source === "data/runs" ? `<a href="#/card/${esc(r.run_id)}"><code>${esc(r.run_id)}</code></a>` : `<code>${esc(r.run_id)}</code>`;
    return [
      `${link}<br><span class="small muted">${esc(fmtTime(r.started_at))}, ${esc(r.source ?? "")}</span>`,
      `${esc(r.utility ?? r.cik)}<br><span class="small muted">${esc(r.period)}, <q>${esc(r.claim)}</q></span>`,
      esc(r.mode ?? ""),
      num(r.chunks),
      esc(fmtMs(r.wall_ms)),
      `${num(r.planner_calls)} <span class="muted">(${esc(fmtNum(r.valid_first_try))} / ${esc(fmtNum(r.repaired))}${r.repairs_think_off ? `, ${esc(fmtNum(r.repairs_think_off))} think off` : ""} / ${esc(fmtNum(r.fallbacks))})</span>`,
      num(r.median_tokens_per_s),
      `${esc(r.memo?.source ?? "")}, ${esc(fmtNum(r.memo?.words))} words, ${esc(fmtNum(r.memo?.attempts))} attempt(s)${drafts ? `<br><span class="small muted">${esc(drafts)}</span>` : ""}`,
      `${num(r.evidence?.e_complete)} / ${num(r.evidence?.records)}${r.evidence?.unresolved_object_names ? `<br><span class="small warn-text">${esc(fmtNum(r.evidence.unresolved_object_names))} placeholder object name(s)</span>` : ""}`,
      num(r.claims?.e_cov, 3),
      `${esc(r.verdict ?? "")}${r.confidence ? ` <span class="muted">${esc(r.confidence)}</span>` : ""}${r.recast_conflicts ? `<br><span class="small">${esc(fmtNum(r.recast_conflicts))} recast conflict(s)</span>` : ""}`,
      esc(r.dq_label ?? ""),
      r.weather_quarter_ms ? `${esc(fmtMs(r.weather_quarter_ms.current))} + ${esc(fmtMs(r.weather_quarter_ms.previous))}` : "",
    ];
  });
  return panel("runs", "Runs in the report", `${esc(fmtNum(runs.length))} runs; the two degree-day statements per run are the wall-time floor`, table(cols, rows));
}

function coldWarmPanel(cw) {
  const cols = [{ h: "Group" }, { h: "Mode" }, { h: "Runs", r: true }, { h: "Chunks (mean)", r: true }, { h: "Wall mean", r: true }, { h: "Wall min to max", r: true }, { h: "Planner calls (mean)", r: true }, { h: "Steps skipped from memory (mean)", r: true }, { h: "Run ids" }];
  const rows = [];
  const push = (group, mode, s) => {
    if (!s) return;
    rows.push([esc(group), esc(mode), num(s.runs), num(s.chunks_mean, 2), esc(fmtMs(s.wall_ms_mean)), `${esc(fmtMs(s.wall_ms_min))} to ${esc(fmtMs(s.wall_ms_max))}`, num(s.planner_calls_mean, 2), num(s.skipped_steps_mean, 2), (s.run_ids ?? []).map((id) => `<code class="small">${esc(id)}</code>`).join(" ")]);
  };
  push("all", "cold", cw.all?.cold);
  push("all", "warm", cw.all?.warm);
  for (const [cik, p] of Object.entries(cw.per_cik ?? {})) {
    push(`${p.utility ?? cik}`, "cold", p.cold);
    push(`${p.utility ?? cik}`, "warm", p.warm);
  }
  return panel("cold_vs_warm", "Cold versus warm runs", "a warm run skips the probe step from memory (one chunk fewer); wall time is set by the two 18 s degree-day statements", table(cols, rows));
}

function range(x) {
  return x && typeof x === "object" ? `${esc(fmtPct(x.value))} <span class="muted">[${esc(fmtPct(x.lo))}, ${esc(fmtPct(x.hi))}]</span>` : "";
}

function attributionPanel(list) {
  const cols = [{ h: "Utility" }, { h: "g", r: true }, { h: "beta [range]", r: true }, { h: "Weather [range]", r: true }, { h: "Industry [range]", r: true }, { h: "Remainder [range]", r: true }, { h: "Coverage", r: true }, { h: "Confidence" }, { h: "Ratio", r: true }, { h: "Verdict" }, { h: "Identical across runs" }];
  const rows = list.map((a) => [
    `${esc(a.utility ?? a.cik)}<br><span class="small muted">${tagShort(a.tag)}, ${esc(a.current_accn ?? "")}${a.recast ? ", recast" : ""}${a.recast_conflicts ? `, ${esc(fmtNum(a.recast_conflicts))} conflict(s)` : ""}; from <code>${esc(a.from_run ?? "")}</code></span>`,
    esc(fmtPct(a.g)),
    `${esc(fmtNum(a.beta, 3))} <span class="muted">[${esc(fmtNum(a.beta_range?.lo, 3))}, ${esc(fmtNum(a.beta_range?.hi, 3))}]</span><br><span class="small muted">Theil-Sen ${esc(fmtNum(a.theil_sen, 3))}; bootstrap ${esc(fmtNum(a.bootstrap?.valid))}/${esc(fmtNum(a.bootstrap?.resamples))}, seed ${esc(a.bootstrap?.seed ?? "")}</span>`,
    range(a.weather),
    range(a.industry),
    range(a.remainder),
    num(a.coverage, 4),
    esc(a.confidence ?? ""),
    num(a.ratio, 3),
    esc(a.verdict ?? ""),
    `${yes(a.identical_across_runs)} <span class="small muted">(${esc(fmtNum((a.runs ?? []).length))} runs)</span>`,
  ]);
  return panel("attribution", "Attribution per utility", "ranges are the 10th to 90th percentile of the peer bootstrap", table(cols, rows));
}

function peersPanel(p) {
  const byTag = Object.entries(p.by_tag ?? {}).map(([t, n]) => `${esc(fmtNum(n))} under ${tagShort(t)}`).join(", ");
  const excluded = Array.isArray(p.excluded) && p.excluded.length ? `<h3 class="sub-h">Excluded (${esc(fmtNum(p.excluded.length))})</h3><ul class="excluded">${p.excluded.map((x) => `<li><code class="small">${esc(x.cik)}</code> ${esc(x.reason)}</li>`).join("")}</ul>` : "";
  return panel(
    "peers",
    "Peer set",
    `${esc(p.utility ?? p.target ?? "")}, ${esc(p.period ?? "")}, from <code>${esc(p.from_run ?? "")}</code>`,
    `<div class="counts__row">${tile("peers", num(p.count), byTag)}${tile("with weather", num(p.with_weather))}${tile("identical across runs", yes(p.identical_across_runs), `${esc(fmtNum((p.runs ?? []).length))} runs`)}</div>${excluded}`,
  );
}

function coveragePanel(c) {
  const s = c.summary ?? {};
  const periods = Array.isArray(c.periods) ? c.periods : [];
  const cols = [{ h: "Utility" }, { h: "Stations", r: true }, { h: "Present", r: true }, ...periods.map((p) => ({ h: p, r: true })), { h: "Minimum", r: true }, { h: "Complete" }];
  const rows = (Array.isArray(c.utilities) ? c.utilities : []).map((u) => [`${esc(u.name ?? u.cik)} <code class="small muted">${esc(u.cik)}</code>`, num(u.stations), num(u.present), ...periods.map((p) => num(u.coverage?.[p], 4)), num(u.min, 4), yes(u.complete)]);
  return panel(
    "coverage",
    "Station coverage per utility",
    `from the weather_quarter rows of <code>${esc(c.from_run ?? "")}</code> (${periods.map((p) => `${esc(p)}: ${esc(fmtNum(c.stations_in_rows?.[p]))} stations`).join(", ")})`,
    `<div class="counts__row">${tile("utilities", num(s.utilities))}${tile("with every station", num(s.with_every_station))}${tile("minimum coverage", num(s.min_coverage, 4))}${tile("below 0.9", num(s.below_0_9))}${tile("not covered", num(s.not_covered))}</div><details class="steps-wrap"><summary>Show the ${esc(fmtNum(rows.length))} utilities</summary>${table(cols, rows)}</details>`,
  );
}

function dqPanel(d) {
  const run = d.run ?? {};
  const stmts = Array.isArray(d.statements) ? d.statements : [];
  const sic = d.sic_fk;
  return panel(
    "dq",
    "Data-quality gate",
    `${esc(d.rule ?? "")} on <code>${esc(d.table ?? "")}</code>, onboarding run ${esc(fmtTime(d.ran_at, true))}, ${esc(fmtMs(Number(d.elapsed_s) * 1000))}`,
    `<div class="counts__row">${tile("gate", yes(d.ok))}${tile("rows checked", num(run.total))}${tile("valid", num(run.valid))}${tile("invalid", num(run.invalid), `${esc(fmtNum((d.invalid_rows ?? []).length))} invalid rows listed`)}${tile("RUN DQ time", esc(fmtMs(Number(run.elapsed_s) * 1000)))}</div>
    ${stmts.length ? table([{ h: "Template" }, { h: "Statement" }, { h: "Started" }, { h: "Elapsed", r: true }, { h: "Rows", r: true }, { h: "sha256" }], stmts.map((s) => [`<code>${esc(s.template_id)}</code>`, `<code class="small">${esc(s.sql)}</code>`, esc(fmtTime(s.started_at, true)), esc(fmtMs(Number(s.elapsed_s) * 1000)), num(s.row_count), `<code class="hash">${esc(String(s.sql_sha256 ?? "").slice(0, 12))}</code>`]), "num") : ""}
    ${sic ? `<h3 class="sub-h">SIC foreign key (the DQ demo moment)</h3><p class="small">${esc(sic.statement ?? "")}: ${esc(sic.result?.type ?? "")} ${esc(fmtNum(sic.result?.total))} rows, ${esc(fmtNum(sic.result?.valid))} valid, <strong>${esc(fmtNum(sic.result?.invalid))} invalid</strong> in ${esc(fmtMs(Number(sic.elapsed_s) * 1000))}${sic.invalid_record ? `; the invalid row is <strong>${esc(sic.invalid_record.name)}</strong> (<code>${esc(sic.invalid_record.cik)}</code>, ${esc(sic.invalid_record.ticker ?? "")}, SIC ${esc(sic.invalid_record.sic)}, ${esc(sic.invalid_record.hq_state ?? "")}) in ${esc(fmtMs(Number(sic.invalid_record_elapsed_s) * 1000))}` : ""}. ${esc(sic.note ?? "")} <span class="muted">(${esc(sic.source ?? "")})</span></p>` : ""}`,
  );
}

function joinMapPanel(j) {
  const r = j.results ?? {};
  const lpad = Object.values(r.cik_lpad ?? {});
  const loc = r.loc ?? {};
  const lpadTable = lpad.length
    ? table(
        [{ h: "Tag" }, { h: "Period" }, { h: "Seeds", r: true }, { h: "Matched through LPAD", r: true }, { h: "Integer IN count", r: true }, { h: "Agree" }, { h: "loc = US-state", r: true }, { h: "loc differs", r: true }, { h: "loc missing", r: true }, { h: "ms", r: true }],
        lpad.map((x) => {
          const l = loc[`${x.tag}.${x.period}`] ?? {};
          return [tagShort(x.tag), esc(x.period), num(x.seeds), num(x.lpad_matched), num(x.in_count), yes(x.agree), num(l.equal), num(l.different), num(l.missing), num(x.elapsed_ms)];
        }),
      )
    : "";
  const any = Object.entries(r.cik_any_tag ?? {}).map(([p, x]) => `${esc(p)}: ${esc(fmtNum(x.seeds_with_a_fact))} of ${esc(fmtNum(x.seeds))} seeds have a fact under some tag (${esc(fmtMs(x.elapsed_ms))})`).join("; ");
  const sic = r.sic ?? {};
  const st = r.station ?? {};
  const stmts = Array.isArray(j.statements) ? j.statements : [];
  return panel(
    "join_map",
    "Join map, measured in Lightning SQL",
    `${esc(fmtNum(stmts.length))} one-off reader statements at ${esc(fmtTime(j.measured_at, true))}, ${esc(fmtNum(j.elapsed_s, 1))} s wall, bound ${esc(fmtNum(j.bound_s))} s each, login ${esc(j.login ?? "")}`,
    `<h3 class="sub-h">frames cik (LPAD) to submissions cik, and loc to the business-address state</h3>${lpadTable}
    <p class="small">No-LPAD control (CAST(cik AS STRING) = cik): ${num(r.cik_no_lpad_control?.matched)} matched in ${esc(fmtMs(r.cik_no_lpad_control?.elapsed_ms))}. ${esc(any)}. Rows whose loc differs: ${Array.isArray(r.loc_differing_rows) && r.loc_differing_rows.length ? esc(fmtNum(r.loc_differing_rows.length)) : "none"}.</p>
    <h3 class="sub-h">SIC foreign key</h3><p class="small">${num(sic.joined)} of ${num(sic.seeds)} seeds join cw.sic_codes in ${esc(fmtMs(sic.elapsed_ms))}; orphans: ${Array.isArray(sic.orphans) && sic.orphans.length ? sic.orphans.map((o) => `<strong>${esc(o.name)}</strong> (<code>${esc(o.cik)}</code>, SIC ${esc(o.sic)})`).join(", ") : "none"}.${sic.recorded_run_dq ? ` Recorded RUN DQ: ${esc(fmtNum(sic.recorded_run_dq.result?.total))} / ${esc(fmtNum(sic.recorded_run_dq.result?.valid))} / ${esc(fmtNum(sic.recorded_run_dq.result?.invalid))} in ${esc(fmtMs(Number(sic.recorded_run_dq.elapsed_s) * 1000))}. ${esc(sic.recorded_run_dq.note ?? "")}` : ""}</p>
    <h3 class="sub-h">Stations to states</h3><p class="small">${st.skipped ? "skipped" : `${num(st.present)} of ${num(st.seed_stations)} seed stations present in the USL station table (${num(st.usl_rows)} rows), ${num(st.state_equal)} with the same state, ${esc(fmtNum((st.state_different ?? []).length))} different, ${esc(fmtNum((st.missing ?? []).length))} missing${Array.isArray(st.extra_in_usl) && st.extra_in_usl.length ? `; extra in the USL: ${st.extra_in_usl.map((x) => `<code>${esc(x)}</code>`).join(", ")}` : ""}; ${esc(fmtMs(st.elapsed_ms))}${st.timeout ? " (timed out)" : ""}${st.error ? `; error ${esc(st.error)}` : ""}`}</p>
    ${stmts.length ? `<details class="steps-wrap"><summary>Show the ${esc(fmtNum(stmts.length))} statements</summary>${table([{ h: "Statement" }, { h: "Group" }, { h: "Elapsed", r: true }, { h: "Rows", r: true }, { h: "Measured" }, { h: "sha256" }, { h: "SQL" }], stmts.map((s) => [`<code>${esc(s.id)}</code>`, esc(s.group ?? ""), esc(fmtMs(s.elapsed_ms)), num(s.row_count), s.timeout ? `<span class="cross">timeout</span>` : s.error ? `<span class="cross">${esc(s.error)}</span>` : yes(s.measured), `<code class="hash">${esc(String(s.sql_sha256 ?? "").slice(0, 12))}</code>`, `<details class="raw"><summary>SQL</summary><pre>${esc(s.sql)}</pre></details>`]))}</details>` : ""}`,
  );
}

function inputsPanel(i) {
  const runs = Array.isArray(i.runs) ? i.runs : [];
  return panel(
    "inputs",
    "Inputs",
    `${esc(fmtNum(runs.length))} runs, DQ file ${i.dq_file ? "present" : "absent"}, join map ${i.joinmap_file ? "present" : "absent"}, seeds ${esc(fmtNum(i.seeds?.utilities))} utilities and ${esc(fmtNum(i.seeds?.stations))} stations`,
    runs.length ? table([{ h: "Run" }, { h: "Utility" }, { h: "Period" }, { h: "Claim" }, { h: "Started" }, { h: "Source" }], runs.map((r) => [`<code>${esc(r.run_id)}</code>`, esc(r.utility ?? r.cik), esc(r.period), `<q>${esc(r.claim)}</q>`, esc(fmtTime(r.started_at)), esc(r.source ?? "")])) : NONE,
  );
}

const KNOWN = ["generated_at", "label", "totals", "runs", "cold_vs_warm", "attribution", "peers", "coverage", "dq", "join_map", "inputs"];

/** Pure: the report, one panel per section. */
export function renderReport(rep) {
  if (!rep || typeof rep !== "object") return `<p class="muted">The report is empty.</p>`;
  const out = [];
  out.push(`<p class="small muted">Generated ${esc(fmtTime(rep.generated_at, true))}${rep.label ? `; every figure is <span class="label">${esc(rep.label)}</span>` : ""}.</p>`);
  if (rep.totals && typeof rep.totals === "object") out.push(totalsPanel(rep.totals));
  if (isTable(rep.runs)) out.push(runsPanel(rep.runs));
  if (rep.cold_vs_warm && typeof rep.cold_vs_warm === "object") out.push(coldWarmPanel(rep.cold_vs_warm));
  if (isTable(rep.attribution)) out.push(attributionPanel(rep.attribution));
  if (rep.peers && typeof rep.peers === "object") out.push(peersPanel(rep.peers));
  if (rep.coverage && typeof rep.coverage === "object") out.push(coveragePanel(rep.coverage));
  if (rep.dq && typeof rep.dq === "object") out.push(dqPanel(rep.dq));
  if (rep.join_map && typeof rep.join_map === "object") out.push(joinMapPanel(rep.join_map));
  if (rep.inputs && typeof rep.inputs === "object") out.push(inputsPanel(rep.inputs));
  for (const [k, v] of Object.entries(rep)) if (!KNOWN.includes(k)) out.push(panel(k, k.replaceAll("_", " "), "", generic(v)));
  return out.join("");
}

export function mount(el, ctx) {
  el.innerHTML = `<h1 class="view-h">Evaluation <span class="view-h__sub">measured only; nothing is estimated in the report's place</span></h1><div id="eval"><p class="muted" role="status">Loading the report…</p></div>`;
  api("/api/eval").then((r) => {
    const box = el.querySelector("#eval");
    if (r.status === 404) {
      box.innerHTML = `<section class="panel"><p class="nm">Not yet measured.</p><p class="small muted">The evaluation script writes <code>eval/report.json</code> under the data directory; until it has run there is nothing to show, and nothing is estimated in its place.</p></section>`;
    } else if (!r.ok) {
      box.innerHTML = renderError(r);
    } else {
      const d = r.data ?? {};
      const rep = d.report && typeof d.report === "object" ? d.report : d;
      const head = d.report ? `<p class="small muted">From <code>${esc(d.file ?? "eval/report.json")}</code>${d.updated_at ? `, updated ${esc(fmtTime(d.updated_at, true))}` : ""}.</p>` : "";
      box.innerHTML = `${head}${renderReport(rep)}`;
    }
    ctx.setTitle("Evaluation");
  });
}
