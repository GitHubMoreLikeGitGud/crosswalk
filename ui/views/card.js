// The answer card: the one-sentence verdict, the three-part split as ranges, the claim verdict,
// growth with both accession numbers and the recast flag, weather with stations and coverage, the
// peers table, the DQ panel, the Not tested list and the memo. Every number is a button that opens
// the evidence drawer. renderCard is pure.

import { apiText, confidenceChip, dqChip, esc, evidenceChips, fmtMillions, fmtMs, fmtNum, fmtPct, fmtRange, fmtTime, hyphenJoin, idHtml, linkMemoryIds, numBtn, renderError, tag, tagShort, verdictChip } from "../lib.js";
import { flash } from "./drawer.js";
import { ruleWording } from "./memory.js";
import { loadRun, pickRunId, sectionEvidence, setCurrentRun } from "./runs.js";
import { replayRows } from "./stream.js";

const PARTS = [
  { key: "weather", name: "Weather", what: "the degree-day change times the peer sensitivity" },
  { key: "industry", name: "Industry-wide", what: "the median peer growth after its own weather part" },
  { key: "remainder", name: "Company-specific remainder", what: "what neither weather nor the industry explains" },
];

/** The verdict in one sentence, with the claim's own words. */
export function verdictSentence(card) {
  const a = card?.attribution ?? {};
  const v = card?.verdict ?? {};
  const g = card?.growth?.g;
  const w = a.weather;
  const r = a.ranges?.weather;
  const name = card?.utility?.name ?? "the utility";
  if (v.withheld_reason) return `${name}'s revenue change of ${fmtPct(g)} cannot be attributed: ${v.withheld_reason}.`;
  const dir = typeof g === "number" ? (g >= 0 ? "rose" : "fell") : "changed";
  const verdict = String(v.verdict ?? "").replaceAll("_", " ");
  return `${name}'s revenue ${dir} ${fmtPct(g)} year on year; weather is consistent with ${fmtPct(w)} of that ${r ? fmtRange(r.lo, r.hi) : ""}, so the claim "${v.claim ?? ""}" is ${verdict} with ${v.confidence ?? "unstated"} confidence.`;
}

/** A horizontal range glyph: the point and its 10th to 90th percentile range on a shared axis. */
function rangeGlyph(point, lo, hi, axis, label) {
  const W = 220;
  const H = 18;
  const x = (v) => 6 + ((v - axis.min) / (axis.max - axis.min || 1)) * (W - 12);
  const zero = x(0);
  return `<svg class="rng" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}"><line class="rng__axis" x1="6" x2="${W - 6}" y1="${H / 2}" y2="${H / 2}"/><line class="rng__zero" x1="${zero.toFixed(1)}" x2="${zero.toFixed(1)}" y1="2" y2="${H - 2}"/><line class="rng__band" x1="${x(lo).toFixed(1)}" x2="${x(hi).toFixed(1)}" y1="${H / 2}" y2="${H / 2}"/><circle class="rng__pt" cx="${x(point).toFixed(1)}" cy="${H / 2}" r="4"/></svg>`;
}

function splitBlock(run, ev) {
  const a = run.card?.attribution ?? {};
  const g = run.card?.growth?.g;
  const vals = [g, a.weather, a.industry, a.remainder, ...PARTS.flatMap((p) => [a.ranges?.[p.key]?.lo, a.ranges?.[p.key]?.hi])].filter((v) => typeof v === "number");
  const axis = { min: Math.min(0, ...vals) - 0.01, max: Math.max(0, ...vals) + 0.01 };
  const parts = PARTS.map((p) => {
    const v = a[p.key];
    const r = a.ranges?.[p.key];
    const text = `${p.name}: ${fmtPct(v)} ${r ? fmtRange(r.lo, r.hi) : ""}`;
    return `<div class="part part--${p.key}">
      <h3 class="part__name">${esc(p.name)}</h3>
      <p class="part__val">${numBtn(run.run_id, ev.attribution, `<span class="fig fig--xl">${esc(fmtPct(v))}</span>`, text)}</p>
      <p class="part__range">${r ? numBtn(run.run_id, ev.attribution, esc(fmtRange(r.lo, r.hi)), `${p.name} range`) : `<span class="muted">no range</span>`}</p>
      ${r ? rangeGlyph(v, r.lo, r.hi, axis, `${text}; the vertical line marks zero`) : ""}
      <p class="part__what small muted">${esc(p.what)}</p>
    </div>`;
  }).join("");
  const bs = a.bootstrap ?? {};
  return `<section class="panel split" aria-labelledby="split-h">
    <div class="split__head"><h2 class="panel__h" id="split-h">The change, split three ways</h2>${confidenceChip(a.confidence ?? run.card?.verdict?.confidence)} <span class="panel__note">of a ${numBtn(run.run_id, ev.growth, `<span class="fig">${esc(fmtPct(g))}</span>`, "like-for-like revenue growth")} like-for-like change; ranges are the 10th to 90th percentile of ${numBtn(run.run_id, ev.attribution, esc(fmtNum(bs.valid)), "valid bootstrap resamples")} of ${numBtn(run.run_id, ev.attribution, esc(fmtNum(bs.resamples)), "bootstrap resamples")} peer resamples (seed ${esc(bs.seed ?? "")})</span></div>
    <div class="parts">${parts}</div>
    <p class="split__beta small">Peer sensitivity beta (OLS slope of growth on the degree-day change over ${numBtn(run.run_id, ev.peers, esc(fmtNum(a.peers)), "peers used")} peers) ${numBtn(run.run_id, ev.attribution, `<span class="fig fig--s">${esc(fmtNum(a.beta, 3))}</span>`, "beta")} <span class="muted">(range ${numBtn(run.run_id, ev.attribution, esc(fmtNum(a.ranges?.beta?.lo, 3)), "beta range low")} to ${numBtn(run.run_id, ev.attribution, esc(fmtNum(a.ranges?.beta?.hi, 3)), "beta range high")}; Theil-Sen ${numBtn(run.run_id, ev.attribution, esc(fmtNum(a.theil_sen, 3)), "Theil-Sen slope")})</span>. Confidence ${esc(a.confidence ?? "")} from the range width, the peer count and coverage ${numBtn(run.run_id, ev.weather, esc(fmtNum(a.coverage, 3)), "station coverage")}.</p>
  </section>`;
}

function claimBlock(run, ev) {
  const v = run.card?.verdict ?? {};
  return `<section class="panel claim" aria-labelledby="claim-h">
    <h2 class="panel__h" id="claim-h">Claim <q>${esc(v.claim ?? run.claim ?? "")}</q></h2>
    <p class="claim__row">${verdictChip(v.verdict, { large: true })} ${confidenceChip(v.confidence)}</p>
    <p>Weather over growth, |weather| / |g| = ${numBtn(run.run_id, ev.verdict, `<span class="fig fig--s">${esc(fmtNum(v.ratio, 2))}</span>`, "claim ratio")}: supported at 0.5 or more, partly supported at 0.2, the same sign required. ${v.withheld_reason ? `<span class="warn-text">Withheld: ${esc(v.withheld_reason)}</span>` : ""}</p>
    <p class="small muted">The wording is "consistent with": the split is a statistical attribution over the peer set, not a causal proof.</p>
  </section>`;
}

function growthBlock(run, ev) {
  const g = run.card?.growth ?? {};
  const conflicts = Array.isArray(run.card?.recast_conflicts) ? run.card.recast_conflicts : [];
  const sameAccn = g.previous_comparative_accn && g.previous_comparative_accn === g.current_accn;
  return `<section class="panel growth" aria-labelledby="growth-h">
    <h2 class="panel__h" id="growth-h">Revenue, like for like <span class="panel__note">tag ${tagShort(g.tag)}</span></h2>
    <div class="growth__nums">
      <div><span class="k">${esc(run.period)}</span>${numBtn(run.run_id, ev.growth, `<span class="fig">${esc(fmtMillions(g.rev_current))}</span>`, "current quarter revenue")}</div>
      <div><span class="k">${esc(run.previous_period)}</span>${numBtn(run.run_id, ev.growth, `<span class="fig">${esc(fmtMillions(g.rev_previous))}</span>`, "previous quarter revenue")}</div>
      <div><span class="k">change</span>${numBtn(run.run_id, ev.growth, `<span class="fig">${esc(fmtPct(g.g))}</span>`, "like-for-like growth")}</div>
    </div>
    <dl class="kv accns">
      <div class="kv__row"><dt>Current quarter from its own filing</dt><dd><code>${idHtml(g.current_accn)}</code>${g.current_filed ? ` <span class="muted">filed ${esc(g.current_filed)}</span>` : ""}</dd></div>
      <div class="kv__row"><dt>Previous quarter, comparative column</dt><dd><code>${idHtml(g.previous_comparative_accn)}</code>${sameAccn ? ` <span class="muted">(the same filing)</span>` : ""}</dd></div>
      <div class="kv__row"><dt>Previous quarter, original filing</dt><dd><code>${idHtml(g.previous_original_accn)}</code></dd></div>
    </dl>
    <p class="growth__flags">${g.recast ? `<span class="chip chip--mid" data-recast="yes">Recast: the comparative differs from the original</span>` : `<span class="chip chip--neutral" data-recast="no">No recast: the comparative equals the original</span>`}${conflicts.length ? ` <a class="chip chip--bad chip--link" href="#/memory/${esc(run.run_id)}">${esc(fmtNum(conflicts.length))} restatement conflict${conflicts.length === 1 ? "" : "s"} on record</a>` : ""}${g.tag_switch_note ? `<span class="small warn-text">${esc(g.tag_switch_note)}</span>` : ""}</p>
    <p class="small muted">Rule R1: the current quarter as reported in its own filing; the previous quarter as that filing restates it. A later restatement is recorded as a conflict, never applied silently.</p>
  </section>`;
}

function conflictsBlock(run) {
  const list = Array.isArray(run.card?.recast_conflicts) ? run.card.recast_conflicts : [];
  if (!list.length) return "";
  return `<section class="panel panel--alert conflicts-card" aria-labelledby="conf-h">
    <h2 class="panel__h" id="conf-h">Restatement conflict${list.length === 1 ? "" : "s"} <span class="panel__note">two filings, two values for the same quarter</span></h2>
    ${list
      .map(
        (c) => `<div class="conflict">
      <p class="conflict__lead"><code>${idHtml(c.id)}</code> ${esc(c.period)} under ${tagShort(c.tag)} (${esc(String(c.scope ?? "").replaceAll("_", " "))}) ${c.status === "overridden" ? `<span class="chip chip--mid" data-status="overridden">overridden by ${esc(c.override?.by ?? "the analyst")}</span>` : `<span class="chip chip--neutral" data-status="${esc(c.status ?? "")}">resolved by rule ${esc(c.rule)}</span>`}</p>
      <div class="sides">
        <div class="side${c.chosen === "own_filing" ? " side--chosen" : ""}"><span class="side__k">Own filing${c.chosen === "own_filing" ? ` <span class="side__use">in use</span>` : ""}</span><span class="fig">${esc(fmtMillions(c.own_filing?.val))}</span><br><code>${idHtml(c.own_filing?.accn)}</code> <span class="muted">filed ${esc(c.own_filing?.filed)}</span><br>${linkMemoryIds(c.own_filing_memory)}</div>
        <div class="side${c.chosen === "later_filing" ? " side--chosen" : ""}"><span class="side__k">Later filing${c.chosen === "later_filing" ? ` <span class="side__use">in use</span>` : ""}</span><span class="fig">${esc(fmtMillions(c.later_filing?.val))}</span><br><code>${idHtml(c.later_filing?.accn)}</code> <span class="muted">filed ${esc(c.later_filing?.filed)}</span><br>${linkMemoryIds(c.later_filing_memory)}</div>
      </div>
      <p class="small">Rule ${esc(c.rule)}: ${esc(ruleWording(c))}. Used: <strong>${esc(String(c.chosen ?? "").replaceAll("_", " "))}</strong>, ${esc(fmtMillions(c.chosen_val))}.${c.status === "overridden" && c.override ? ` <span class="warn-text">Overridden by ${esc(c.override.by)}: ${esc(c.override.reason)}; this card's numbers still follow the rule until a re-run.</span>` : ""} ${evidenceChips(run.run_id, c.evidence_ids)} <a href="#/memory/${esc(run.run_id)}">${c.status === "overridden" ? "Re-run on the Memory screen" : "Override on the Memory screen"}</a></p>
    </div>`,
      )
      .join("")}
  </section>`;
}

function weatherBlock(run, ev) {
  const w = run.card?.weather ?? {};
  const u = run.card?.utility ?? {};
  const states = Array.isArray(u.states_served) ? u.states_served : [];
  return `<section class="panel weather" aria-labelledby="weather-h">
    <h2 class="panel__h" id="weather-h">Degree days <span class="panel__note">heating plus cooling, computed in Lightning SQL over NOAA GHCN-Daily</span></h2>
    <div class="growth__nums">
      <div><span class="k">${esc(run.previous_period)}</span>${numBtn(run.run_id, ev.weather, `<span class="fig">${esc(fmtNum(w.tdd_previous))}</span>`, "previous quarter degree days")}</div>
      <div><span class="k">${esc(run.period)}</span>${numBtn(run.run_id, ev.weather, `<span class="fig">${esc(fmtNum(w.tdd_current))}</span>`, "current quarter degree days")}</div>
      <div><span class="k">change</span>${numBtn(run.run_id, ev.weather, `<span class="fig">${esc(fmtPct(w.delta_w))}</span>`, "degree-day change")}</div>
      <div><span class="k">coverage</span>${numBtn(run.run_id, ev.weather, `<span class="fig">${esc(fmtNum(w.coverage, 3))}</span>`, "station coverage, minimum over stations and quarters")}</div>
    </div>
    <p class="small">${esc(fmtNum((w.stations_used ?? []).length))} stations in ${esc(fmtNum(states.length))} states (${esc(states.join(", "))}); a day with a GHCN quality flag on either temperature element is dropped, and coverage reports how many days remain.</p>
    <ul class="stations">${(w.stations_used ?? []).map((s) => `<li><code>${esc(s)}</code></li>`).join("")}${(w.stations_missing ?? []).map((s) => `<li class="stations__missing"><code>${esc(s)}</code> <span class="warn-text">no rows</span></li>`).join("")}</ul>
  </section>`;
}

const TAG_ORDER = ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RegulatedAndUnregulatedOperatingRevenue"];

function peersBlock(run, ev) {
  const p = run.card?.peers ?? {};
  const list = [...(Array.isArray(p.list) ? p.list : [])].sort((a, b) => (b.g ?? 0) - (a.g ?? 0));
  const byTag = p.by_tag ?? {};
  const target = run.card?.attribution?.target;
  return `<section class="panel peers" aria-labelledby="peers-h">
    <h2 class="panel__h" id="peers-h">Peer set <span class="panel__note">${numBtn(run.run_id, ev.peers, `<span class="fig fig--s">${esc(fmtNum(p.count))}</span>`, "peer count")} peers, ${esc(fmtNum(p.with_weather))} with weather; ${TAG_ORDER.filter((t) => byTag[t]).map((t) => `${esc(fmtNum(byTag[t]))} under ${tagShort(t)}`).join(", ")}</span></h2>
    <p class="small muted">Each peer uses its own first available tag (Revenues, then RFC, then RUOR); SIC 4911, 4931 or 4932; both quarters present; |g| under 60%. Growth and degree-day change are like for like.</p>
    <div class="table-wrap"><table class="num peers__t"><thead><tr><th scope="col">Peer</th><th scope="col">Tag</th><th scope="col" class="r">Growth g</th><th scope="col" class="r">Degree days dw</th></tr></thead><tbody>
      ${target ? `<tr class="peers__target"><th scope="row">${esc(run.card?.utility?.name ?? "target")} <span class="tag tag--neutral">target</span></th><td>${tagShort(run.card?.growth?.tag)}</td><td class="r">${esc(fmtPct(target.g))}</td><td class="r">${esc(fmtPct(target.dw))}</td></tr>` : ""}
      ${list.map((x) => `<tr><th scope="row">${esc(x.name)} <code class="small muted">${esc(x.cik)}</code></th><td>${tagShort(x.tag)}</td><td class="r">${esc(fmtPct(x.g))}</td><td class="r">${esc(fmtPct(x.dw))}</td></tr>`).join("")}
    </tbody></table></div>
    ${Array.isArray(p.excluded) && p.excluded.length ? `<h3 class="sub-h">Excluded (${esc(fmtNum(p.excluded.length))})</h3><ul class="excluded">${p.excluded.map((x) => `<li><code class="small">${esc(x.cik)}</code> ${esc(x.reason)}</li>`).join("")}</ul>` : ""}
    <p class="small">${evidenceChips(run.run_id, ev.peers, { max: 3 })}</p>
  </section>`;
}

function dqBlock(run, ev) {
  const d = run.card?.dq ?? {};
  const invalid = Array.isArray(d.invalidForTarget) ? d.invalidForTarget : [];
  return `<section class="panel dq" aria-labelledby="dq-h">
    <h2 class="panel__h" id="dq-h">Data-quality gate ${dqChip(d.label)}</h2>
    <dl class="kv">
      <div class="kv__row"><dt>Rule</dt><dd><code>${esc(d.rule)}</code> <span class="muted">(${esc(d.basis)})</span></dd></div>
      <div class="kv__row"><dt>Onboarding run</dt><dd>${esc(fmtTime(d.ranAt, true))}, ${numBtn(run.run_id, ev.dq, esc(fmtMs(Number(d.elapsedS) * 1000)), "DQ run time")}</dd></div>
      <div class="kv__row"><dt>Rows</dt><dd>${numBtn(run.run_id, ev.dq, esc(fmtNum(d.run?.total)), "DQ rows checked")} checked, ${numBtn(run.run_id, ev.dq, esc(fmtNum(d.run?.valid)), "DQ valid rows")} valid, ${numBtn(run.run_id, ev.dq, esc(fmtNum(d.run?.invalid)), "DQ invalid rows")} invalid</dd></div>
      <div class="kv__row"><dt>This utility</dt><dd>coverage ${numBtn(run.run_id, ev.dq, esc(fmtNum(d.targetCoverage, 4)), "target coverage")}${invalid.length ? `; <span class="warn-text">${esc(fmtNum(invalid.length))} invalid row${invalid.length === 1 ? "" : "s"} name its stations</span>` : "; none of its stations is named by an invalid row"}</dd></div>
    </dl>
    ${invalid.length ? `<ul class="excluded">${invalid.map((r) => `<li><code>${esc(JSON.stringify(r))}</code></li>`).join("")}</ul>` : ""}
    <p class="small muted">${esc(d.note ?? "")}</p>
  </section>`;
}

function notTestedBlock(run, ev) {
  const items = Array.isArray(run.card?.not_tested) ? run.card.not_tested : [];
  return `<section class="panel nt" aria-labelledby="nt-h">
    <h2 class="panel__h" id="nt-h">Not tested <span class="panel__note">${esc(fmtNum(items.length))} items the method does not reach</span> ${evidenceChips(run.run_id, ev.not_tested)}</h2>
    <ol class="nt__list">${items.map((t) => `<li>${esc(t)}</li>`).join("")}</ol>
  </section>`;
}

function memoBlock(run, ev) {
  const m = run.card?.memo ?? {};
  const paras = String(m.text ?? "").split(/\n\s*\n/u).filter(Boolean);
  return `<section class="panel memo" aria-labelledby="memo-h">
    <div class="memo__head"><h2 class="panel__h" id="memo-h">Memo ${tag(m.source === "model" ? "written by the model" : "template memo", m.source === "model" ? "model" : "neutral")} <span class="panel__note">${esc(fmtNum(m.words))} words, ${esc(fmtNum(m.attempts))} attempt${m.attempts === 1 ? "" : "s"}; every number string-matched to a tool output</span></h2>
      <div class="memo__acts"><button type="button" class="btn btn--small" data-copy-memo="${esc(run.run_id)}">Copy as markdown</button> <a class="btn btn--small btn--ghost" href="/api/run/${esc(run.run_id)}/memo.md" target="_blank" rel="noreferrer">Open memo.md</a> ${evidenceChips(run.run_id, ev.memo)}</div></div>
    <div class="memo__text">${paras.map((p) => `<p>${esc(hyphenJoin(p))}</p>`).join("")}</div>
    <p class="small muted">Shown with a cosmetic hyphen join (a word, a hyphen, a space, a word); the saved text is the model's own.</p>
  </section>`;
}

function checklistStrip(run) {
  const items = Array.isArray(run.checklist) ? run.checklist : [];
  return `<ul class="checklist" aria-label="Checklist">${items.map((c) => `<li class="cl cl--${esc(c.status)}" title="${esc(c.note ?? "")}">${esc(String(c.id).replaceAll("_", " "))}${c.note ? ` <span class="cl__note">(${esc(c.note)})</span>` : ""}</li>`).join("")}</ul>`;
}

/** Pure: the whole card for one saved run. */
export function renderCard(run) {
  const ev = sectionEvidence(run);
  const u = run.card?.utility ?? {};
  const skipped = Array.isArray(run.skipped_steps) ? run.skipped_steps : run.skipped_steps ? [run.skipped_steps] : [];
  return `
    <header class="card-head">
      <div>
        <p class="card-head__kicker">${esc(run.period)} vs ${esc(run.previous_period)} <span class="muted">·</span> claim <q>${esc(run.claim)}</q></p>
        <h1 class="card-head__name">${esc(u.name ?? run.cik)} <span class="card-head__tick">${u.ticker ? esc(u.ticker) : ""}</span></h1>
        <p class="card-head__meta">CIK <code>${esc(u.cik ?? run.cik)}</code> · SIC ${esc(u.sic ?? "")} · HQ ${esc(u.hq_state ?? "")} · run <code>${idHtml(run.run_id)}</code> · ${esc(fmtTime(run.started_at))} · ${esc(fmtMs(run.wall_ms))} · ${esc(fmtNum(run.markovian?.chunks ?? (run.chunks ?? []).length))} chunks${run.saved?.source ? ` · saved by the ${esc(run.saved.source)}` : ""} ${tag("replay of a saved run", "replay")}</p>
      </div>
      <div class="card-head__acts"><a class="btn btn--small" href="#/memory/${esc(run.run_id)}">Memory and why</a> <a class="btn btn--small" href="#/graph/${esc(u.cik ?? run.cik)}">Graph</a></div>
    </header>
    <section class="verdict panel panel--verdict" aria-labelledby="verdict-h">
      <h2 class="sr-only" id="verdict-h">Verdict</h2>
      <p class="verdict__sentence">${esc(verdictSentence(run.card))}</p>
      <p class="verdict__meta">${verdictChip(run.card?.verdict?.verdict)} ${confidenceChip(run.card?.verdict?.confidence)} ${dqChip(run.card?.dq?.label)} ${skipped.length ? tag(`${skipped.length} step${skipped.length === 1 ? "" : "s"} skipped from memory`, "memory") : ""} <span class="small muted">Every figure below is a button: it opens the evidence that produced it.</span></p>
    </section>
    ${splitBlock(run, ev)}
    <div class="card-grid">
      <div class="card-main">
        ${claimBlock(run, ev)}
        ${growthBlock(run, ev)}
        ${conflictsBlock(run)}
        ${weatherBlock(run, ev)}
        ${peersBlock(run, ev)}
      </div>
      <div class="card-side">
        ${dqBlock(run, ev)}
        ${notTestedBlock(run, ev)}
        ${memoBlock(run, ev)}
      </div>
    </div>
    <section class="panel" aria-labelledby="steps-h">
      <h2 class="panel__h" id="steps-h">How the answer was reached <span class="panel__note">${esc(fmtNum((run.planner_calls ?? []).length))} planner calls, ${esc(fmtNum((run.timeline ?? []).length))} tool steps</span></h2>
      ${checklistStrip(run)}
      ${skipped.length ? `<p class="small">Skipped from memory: ${skipped.map((s) => `${esc(s.item)} (${linkMemoryIds(s.memoryId)}: ${esc(s.note)})`).join("; ")}</p>` : ""}
      <details class="steps-wrap"><summary>Show the timeline</summary><ol class="stream stream--tall" aria-label="Investigation steps">${replayRows(run)}</ol></details>
    </section>`;
}

export function mount(el, ctx) {
  el.innerHTML = `<p class="muted" role="status">Loading the run…</p>`;
  (async () => {
    const id = await pickRunId(ctx.params.run);
    if (!id) {
      el.innerHTML = `<h1 class="view-h">Answer card</h1><p class="msg msg--warn">No saved run yet. <a href="#/ask">Ask a question</a>.</p>`;
      return;
    }
    const r = await loadRun(id);
    if (!r.ok) {
      el.innerHTML = `<h1 class="view-h">Answer card</h1>${renderError(r)}`;
      return;
    }
    setCurrentRun(id);
    if (ctx.params.run !== id) history.replaceState(null, "", `#/card/${id}`);
    el.innerHTML = renderCard(r.data);
    ctx.setTitle(`${r.data.card?.utility?.ticker ?? r.data.cik} ${r.data.period} card`);
    ctx.setFooterRun(r.data);
  })();
  const onClick = async (e) => {
    const b = e.target instanceof Element ? e.target.closest("[data-copy-memo]") : null;
    if (!b) return;
    const id = b.getAttribute("data-copy-memo");
    const r = await apiText(`/api/run/${encodeURIComponent(id)}/memo.md`);
    if (!r.ok) {
      flash(b, r.status === 404 ? "No memo.md" : "Fetch failed");
      return;
    }
    try {
      await navigator.clipboard.writeText(r.text);
      flash(b, "Copied");
    } catch {
      flash(b, "Copy failed");
    }
  };
  el.addEventListener("click", onClick);
  return () => el.removeEventListener("click", onClick);
}
