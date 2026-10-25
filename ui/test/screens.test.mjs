// Render tests for the Ask, Discovery, USL and DQ, Answer screens, the provenance drawer, the
// banner and the footer, on fixtures built from the server's own view functions (synthetic values).
// Run from the repository root: node --test ui/test/

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { fmtPct, fmtSgt, quarterWords, runWords } from "../lib.js";
import { DEMO_QUESTION, parseQuestion, questionFor, renderRuns } from "../views/ask.js";
import { answerSummary, renderAnswer, typesWords } from "../views/answer.js";
import { bannerHtml } from "../views/banner.js";
import { renderCell, valueWords } from "../views/provenance.js";
import { renderFooter } from "../views/telemetry.js";
import { keyWords, measureWords, pendingRow, renderEvent, renderSkipped, renderSkippedBlock, stripRefs, summaryLine } from "../views/timeline.js";
import { invalidWords, renderUsl } from "../views/usl.js";

const fx = (name) => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8"));
const answer = fx("answer-cold.json");
const usl = fx("usl.json");
const telCold = fx("telemetry-cold.json");
const telWarm = fx("telemetry-warm.json");
const events = fx("events-warm.json");
const cell = fx("cell-revenue-change.json");

/** The text a viewer sees with "Show engineering detail" off: tags stripped, .eng spans removed. */
function visible(html) {
  let s = String(html).replace(/<div class="kv__row eng-row">[\s\S]*?<\/div>/gu, "");
  for (;;) {
    const next = s.replace(/<span class="eng">(?:(?!<span class="eng">)[\s\S])*?<\/span>/u, (m) => {
      const opens = (m.match(/<span\b/gu) ?? []).length;
      const closes = (m.match(/<\/span>/gu) ?? []).length;
      return opens === closes ? "" : m;
    });
    if (next === s) break;
    s = next;
  }
  return s.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ");
}

const ENG_IDS = /r\d{8}T\d{6}[0-9a-f]{4}|ev-r\d{8}|pair:|@CY\d{4}Q\d\b|@all\b|[0-9a-f]{64}/u;

test("one time zone: every time is SGT, from an ISO instant or the server's SGT string", () => {
  assert.equal(fmtSgt("2026-10-25T08:00:20.595Z"), "25 Oct 2026 16:00:20 SGT");
  assert.equal(fmtSgt("2026-10-25 16:00:20 SGT"), "25 Oct 2026 16:00:20 SGT");
  assert.equal(fmtSgt("2026-10-25T15:03:12+0800", { seconds: false }), "25 Oct 2026 15:03 SGT");
  assert.equal(fmtSgt(null), "");
  assert.equal(quarterWords("CY2025Q1"), "Q1 2025");
  assert.equal(runWords({ mode: "warm", quarter: "CY2024Q1", started_at_sgt: "2026-10-25 15:56:31 SGT" }), "Warm run, Q1 2024, 25 Oct 2026 15:56 SGT");
});

test("banner: REPLAY or LIVE, never both, nothing for an unknown mode", () => {
  const r = bannerHtml("replay", "saved");
  const l = bannerHtml("live", "now");
  assert.ok(r.includes("REPLAY") && !r.includes("LIVE"));
  assert.ok(l.includes("LIVE") && !l.includes("REPLAY"));
  assert.equal(bannerHtml("both", "x"), "");
  assert.ok(!bannerHtml("replay", "<b>x</b>").includes("<b>"));
});

test("ask: the question box accepts only the supported shape with one quarter", () => {
  assert.deepEqual(parseQuestion(DEMO_QUESTION), { ok: true, quarter: "CY2025Q1" });
  assert.deepEqual(parseQuestion(questionFor("CY2023Q3")), { ok: true, quarter: "CY2023Q3" });
  assert.deepEqual(parseQuestion("  " + DEMO_QUESTION.replace("Q1 2025", "Q4  2024").toUpperCase()), { ok: true, quarter: "CY2024Q4" }, "case and spacing do not matter");
  assert.equal(parseQuestion("").ok, false);
  assert.equal(parseQuestion("What is the revenue of AEP in Q1 2025?").ok, false);
  assert.equal(parseQuestion(DEMO_QUESTION.replace("Q1 2025", "Q5 2025")).ok, false);
  assert.equal(parseQuestion(`${DEMO_QUESTION} And Q2 2025?`).ok, false);
  assert.equal(parseQuestion(DEMO_QUESTION.replace("weather", "rainfall")).ok, false);
});

test("ask: the saved-runs table names runs in words; ids only as engineering detail", () => {
  const html = renderRuns([{ run_id: "r20261025T160020a0bc", quarter: "CY2025Q1", mode: "cold", started_at_sgt: "2026-10-25 16:00:20 SGT", wall_s: 247.7, utilities: 12, keys: 12, skipped: 0 }]);
  assert.ok(visible(html).includes("Cold run, Q1 2025, 25 Oct 2026 16:00 SGT"));
  assert.ok(!ENG_IDS.test(visible(html)));
  assert.ok(html.includes("r20261025T160020a0bc"));
});

test("answer: one row per utility, every number opens its cell, the summary counts the signs", () => {
  const html = renderAnswer(answer, DEMO_QUESTION);
  assert.equal((html.match(/<tr>/gu) ?? []).length - 1, answer.rows.length);
  for (const r of answer.rows) {
    assert.ok(html.includes(`data-cell="${r.cells.declarations}"`));
    if (typeof r.revenue?.change === "number") {
      assert.ok(html.includes(`data-cell="${r.cells.revenue_change}"`));
      assert.ok(html.includes(fmtPct(r.revenue.change, 2)));
    }
  }
  const s = answerSummary(answer);
  const ch = answer.rows.map((r) => r.revenue?.change);
  assert.equal(s.rose, ch.filter((x) => typeof x === "number" && x > 0).length);
  assert.equal(s.fell, ch.filter((x) => typeof x === "number" && x < 0).length);
  assert.equal(s.not_compared, ch.filter((x) => typeof x !== "number").length);
  assert.ok(visible(html).includes(`rose for ${s.rose}, fell for ${s.fell}`));
  assert.ok(visible(html).includes("not compared"));
  for (const nt of answer.not_tested) assert.ok(html.includes(nt.slice(0, 40).replaceAll("'", "&#39;")));
  assert.ok(!ENG_IDS.test(visible(html)));
  assert.equal(typesWords({ severe_storm: 2, fire: 0, flood: 1, other_incidents: 0 }), "2 severe storm, 1 flood");
});

test("usl: governed tables, both rule sources with their SGT times, the MGE row explained in words", () => {
  const html = renderUsl(usl);
  const v = visible(html);
  for (const t of usl.tables) assert.ok(html.includes(`<h3 class="erd__name">${t.name}</h3>`));
  assert.ok(v.includes(`At onboarding, ${fmtSgt(usl.onboarding_dq.ran_at_sgt)}`));
  assert.ok(v.includes(`Live in this run, ${fmtSgt(usl.live_rules.at_sgt)}`));
  assert.equal((html.match(/class="dq__live"/gu) ?? []).length, usl.live_rules.rules.length);
  const words = invalidWords(usl.invalid_rows[0], usl);
  assert.match(words, /^MGE ENERGY INC \(MGEE\) has sic 4900, and the sic_code table has no row with that value/u);
  assert.ok(words.includes("4911, 4931 and 4932"));
  assert.ok(v.includes("matches the governed USL"));
  assert.ok(!ENG_IDS.test(v));
});

test("timeline: model choices, tool rows with their time, evidence ids only as engineering detail", () => {
  const rows = events.events.map((e) => renderEvent(e.type, e.data)).join("");
  const tools = events.events.filter((e) => e.type === "tool");
  assert.equal((rows.match(/data-tool="/gu) ?? []).length, tools.length);
  assert.ok(rows.includes("its plan, not a fact"));
  assert.ok(rows.includes(`${tools[0].data.latency_ms} ms`));
  assert.ok(!ENG_IDS.test(visible(rows)), visible(rows).match(ENG_IDS)?.[0]);
  assert.equal(stripRefs("probe x: 6 cols [ev-r20261025T145128a180-08]"), "probe x: 6 cols");
  const fb = events.events.find((e) => e.type === "tool" && e.data.source === "fallback");
  if (fb) assert.ok(renderEvent("tool", fb.data).includes("host fallback step"));
});

test("timeline: a skipped measure step says it was verified earlier and names its memory", () => {
  const steps = events.skipped_steps;
  assert.ok(steps.length >= 1);
  const block = renderSkippedBlock(steps);
  for (const s of steps) assert.ok(block.includes(`skipped: verified earlier, memory ${s.memoryId}`));
  assert.equal((block.match(/class="tl tl--skip"/gu) ?? []).length, steps.length);
  const loc = renderSkipped({ memoryId: "mem-80", note: "measure_key b6 skipped: loc@CY2024Q1 (cw.frames_Revenues_CY2024Q1.loc ~ cw.seed_submissions_snapshot.hq_state, substr(4,2)) VERIFIED 42/42 as loc@CY2025Q1 recalled from memory" });
  assert.ok(visible(loc).includes("cw.frames_Revenues_CY2024Q1.loc to cw.seed_submissions_snapshot.hq_state (substr(4,2)): VERIFIED, 42 of 42 rows"));
  assert.ok(!ENG_IDS.test(visible(loc)));
  assert.equal(renderSkippedBlock([]), "");
  assert.equal(summaryLine({ chunks: 8, tools: 22, fallback: 5, planner: 22, invalid: 5 }, 6), "8 chunks, 22 model replies (5 invalid), 22 tool steps (5 run by the host after an invalid reply), 6 measure steps skipped as verified earlier");
  assert.ok(pendingRow("measure_key").includes("Running: Measure a key in Lightning SQL"));
  assert.ok(pendingRow(null).includes("The model is choosing the next step"));
});

test("timeline: measure facts in words, routes kept for engineering detail", () => {
  assert.equal(keyWords("pair:cw.a.x~cw.b.y|lpad10"), "cw.a.x to cw.b.y (lpad10)");
  assert.equal(keyWords("sic@all"), "industry code against the SIC reference");
  assert.equal(keyWords("fema_state@CY2025Q1"), "FEMA declaration state against the states the utilities serve, Q1 2025");
  const m = measureWords("b13 fema_state@CY2025Q1: 0.875 PARTIAL, orphan AK");
  assert.equal(m.text, "FEMA declaration state against the states the utilities serve, Q1 2025: PARTIAL at 87.5% of the left table's rows; first orphan AK");
  assert.equal(m.ids, "b13 fema_state@CY2025Q1");
  const row = renderEvent("tool", { tool: "measure_key", source: "model", ok: true, fact: "b13 fema_state@CY2025Q1: 0.875 PARTIAL, orphan AK [ev-r20261025T160020a0bc-40]", evidence_ids: ["ev-r20261025T160020a0bc-40"], latency_ms: 645 });
  assert.ok(!ENG_IDS.test(visible(row)));
  assert.ok(row.includes("fema_state@CY2025Q1"));
});

test("provenance drawer: value, derivation, statement with object, rows, time, SGT run time and cache state", () => {
  const html = renderCell(cell);
  const v = visible(html);
  const s = cell.statements[0];
  assert.ok(v.includes(valueWords(cell.field, cell.value)));
  assert.ok(v.includes(cell.derivation.slice(0, 30)));
  assert.ok(html.includes(s.zetaris_object));
  assert.ok(v.includes(fmtSgt(s.executed_at_sgt)));
  assert.ok(v.includes(`statement cache ${s.cache_state}`));
  assert.ok(v.includes("not reported by the gateway"));
  assert.ok(html.includes("<summary>Lightning SQL</summary>"));
  assert.ok(!ENG_IDS.test(v));
  assert.ok(html.includes(s.evidence_id) && html.includes(s.sql_sha256));
  const partial = renderCell({ ...cell, cell_rows_complete: false, missing: ["USW00093817 (2025): row not kept in the saved run"] });
  assert.ok(visible(partial).includes("USW00093817 (2025)"));
});

test("footer: chunks, skipped steps, tokens, tok/s, wall, model, cloud calls; labels say measured", () => {
  const c = visible(renderFooter(telCold, "Cold run"));
  const w = visible(renderFooter(telWarm, "Warm run"));
  assert.ok(c.includes(`${telCold.chunks} of ${telCold.max_chunks}`));
  assert.ok(w.includes(`Skipped ${telWarm.skipped_chunks}`));
  assert.ok(c.includes("measured"));
  assert.ok(c.includes("Cloud model calls 0"));
  assert.ok(visible(renderFooter(null)).includes("not measured"));
});
