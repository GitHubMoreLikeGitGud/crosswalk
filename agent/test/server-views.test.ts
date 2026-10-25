// The server's read-side views (agent/src/ops) on small synthetic inputs: the SGT formatter, the
// join-map orientation reader on each statement shape, the replay pairing, the telemetry and answer
// views on a run with fields missing, the cell-id grammar and the USL view without a plan.

import { describe, expect, it } from "vitest";
import { answerView, cellEvidence, CELL_ID } from "../src/ops/cells.ts";
import { canonicalRow, joinMapView, sourcesOf } from "../src/ops/joinmap.ts";
import { replayEvents, telemetryView } from "../src/ops/replay.ts";
import { asRun } from "../src/ops/runShape.ts";
import { seconds, sgt } from "../src/ops/time.ts";
import { uslView } from "../src/ops/usl.ts";

const COUNTS = (l: string, r: string) => `SELECT COUNT(DISTINCT l.k) AS left_keys, COUNT(DISTINCT CASE WHEN r.k IS NOT NULL THEN l.k END) AS matched_keys FROM ${l} l LEFT JOIN ${r} r ON r.k = l.k`;

describe("ops/time", () => {
  it("formats any offset as Singapore time and never guesses", () => {
    expect(sgt("2026-10-25T06:57:17.802Z")).toBe("2026-10-25 14:57:17 SGT");
    expect(sgt("2026-10-25T15:00:34+0800")).toBe("2026-10-25 15:00:34 SGT");
    expect(sgt("2026-10-25T15:00:34+08:00")).toBe("2026-10-25 15:00:34 SGT");
    expect(sgt("2026-12-31T20:00:00-05:00")).toBe("2027-01-01 09:00:00 SGT");
    expect(sgt(null)).toBeNull();
    expect(sgt("not a time")).toBeNull();
    expect(seconds(402894)).toBe(402.9);
    expect(seconds(undefined)).toBeNull();
  });
});

describe("ops/joinmap", () => {
  it("reads the counted and matched sources of the subquery, bare-table and inner-join shapes", () => {
    const a = sourcesOf(COUNTS("(SELECT DISTINCT cik AS k FROM cw.seed_x)", "(SELECT DISTINCT LPAD(CAST(cik AS STRING), 10, '0') AS k FROM cw.frames_a UNION SELECT DISTINCT LPAD(CAST(cik AS STRING), 10, '0') AS k FROM cw.frames_b)"));
    expect(a?.counted.objects).toEqual(["cw.seed_x"]);
    expect(a?.other.objects).toEqual(["cw.frames_a", "cw.frames_b"]);
    const b = sourcesOf("SELECT COUNT(DISTINCT l.k) AS left_keys FROM (SELECT DISTINCT id AS k, state FROM cw.seed_s) l LEFT JOIN cw.inventory r ON r.id = l.k");
    expect(b?.other.objects).toEqual(["cw.inventory"]);
    const c = sourcesOf("SELECT COUNT(DISTINCT l.cik) AS left_keys FROM (SELECT DISTINCT cik, SUBSTR(loc, 4, 2) AS s FROM cw.frames_a) l JOIN cw.seed_x r ON r.cik = l.cik");
    expect(c?.counted.objects).toEqual(["cw.frames_a"]);
    // The generic match_rate statement (C1 matchRateSql shape): aliases inside the subqueries too.
    const d = sourcesOf("SELECT COUNT(DISTINCT l.k) AS left_keys, COUNT(DISTINCT CASE WHEN r.k IS NOT NULL THEN l.k END) AS matched_keys FROM (SELECT DISTINCT LPAD(CAST(l.`cik` AS STRING), 10, '0') AS k FROM cw.frames_a l WHERE LPAD(CAST(l.`cik` AS STRING), 10, '0') IS NOT NULL) l LEFT JOIN (SELECT DISTINCT CAST(r.`cik` AS STRING) AS k FROM cw.seed_x r) r ON r.k = l.k");
    expect(d?.counted.objects).toEqual(["cw.frames_a"]);
    expect(d?.other.objects).toEqual(["cw.seed_x"]);
    expect(canonicalRow({ key: "m1", left: "cw.frames_a.cik", right: "cw.seed_x.cik", transform: "lpad10", sql: d ? "SELECT COUNT(DISTINCT l.k) AS left_keys FROM (SELECT DISTINCT LPAD(CAST(l.`cik` AS STRING), 10, '0') AS k FROM cw.frames_a l) l LEFT JOIN (SELECT DISTINCT CAST(r.`cik` AS STRING) AS k FROM cw.seed_x r) r ON r.k = l.k" : null })).toMatchObject({ orientation: "as_recorded", transform_applies_to: "left" });
    expect(sourcesOf("SELECT 1")).toBeNull();
    expect(sourcesOf(null)).toBeNull();
  });

  it("swaps a row recorded the other way round, keeps one recorded the right way and says when it could not read the statement", () => {
    const sql = COUNTS("(SELECT DISTINCT cik AS k FROM cw.seed_x)", "(SELECT DISTINCT LPAD(CAST(cik AS STRING), 10, '0') AS k FROM cw.frames_a)");
    const swapped = canonicalRow({ key: "cik@P", left: "cw.frames_a.cik", right: "cw.seed_x.cik", transform: "lpad10", sql, verdict: "VERIFIED", status: "measured" });
    expect(swapped).toMatchObject({ orientation: "swapped", left: { object: "cw.seed_x", column: "cik" }, right: { object: "cw.frames_a", column: "cik" }, transform_applies_to: "right" });
    const kept = canonicalRow({ key: "cik@P", left: "cw.seed_x.cik", right: "cw.frames_a.cik", transform: "lpad10", sql });
    expect(kept.orientation).toBe("as_recorded");
    // The statement does not show the function: the loop's transform_on is used, read through the swap.
    const plain = COUNTS("(SELECT DISTINCT code AS k FROM cw.seed_x)", "(SELECT DISTINCT code AS k FROM cw.ref)");
    expect(canonicalRow({ key: "c@all", left: "cw.ref.code", right: "cw.seed_x.code", transform: "upper", transform_on: "left", sql: plain })).toMatchObject({ orientation: "swapped", transform_applies_to: "right" });
    expect(canonicalRow({ key: "c@all", left: "cw.seed_x.code", right: "cw.ref.code", transform: "identity", transform_on: "left", sql: plain }).transform_applies_to).toBeNull();
    const unread = canonicalRow({ key: "x@all", left: "cw.a.x", right: "cw.b.y", transform: "identity", sql: null, status: "unmeasurable" });
    expect(unread).toMatchObject({ orientation: "unread", left: { ref: "cw.a.x" }, verdict: null, verdict_definition: null, provenance: "not measured (unmeasurable)" });
  });

  it("counts verdicts and survives a run without a join map", () => {
    expect(joinMapView(asRun({ run_id: "r1" })).counts).toEqual({ keys: 0, verified: 0, partial: 0, rejected: 0, other: 0, measured_in_run: 0, recalled: 0 });
  });
});

describe("ops/replay", () => {
  it("pairs each planner call with the tool step of the same position in its chunk and closes every chunk", () => {
    const run = asRun({
      run_id: "r1",
      chunks: [{ chunk: 1, carryover_in_tokens: 0, carryover_out_tokens: 40, task_complete: false }, { chunk: 2, carryover_in_tokens: 40, carryover_out_tokens: 50, task_complete: true }],
      planner_calls: [{ chunk: 1, call: 2, chosen: { tool: "probe_source" } }, { chunk: 1, call: 1, chosen: { tool: "search_catalogue" } }, { chunk: 2, call: 1, chosen: null, valid: false }],
      chain: [{ chunk: 1, seq: 1, tool: "search_catalogue" }, { chunk: 1, seq: 2, tool: "probe_source" }, { chunk: 2, seq: 3, tool: "finalize", source: "fallback" }],
    });
    const evs = replayEvents(run);
    expect(evs.map((e) => `${e.type}${e.data.tool ? `:${e.data.tool}` : ""}`)).toEqual([
      "run_started",
      "chunk_start",
      "planner:search_catalogue",
      "tool:search_catalogue",
      "planner:probe_source",
      "tool:probe_source",
      "chunk_end",
      "chunk_start",
      "planner",
      "tool:finalize",
      "chunk_end",
      "run_finished",
    ]);
    expect(evs.every((e) => e.data.replay === true && e.data.run_id === "r1")).toBe(true);
    expect(evs[10]!.data).toMatchObject({ state_tokens: 50, complete: true });
  });

  it("telemetry of a run with missing fields is nulls, not an error", () => {
    const t = telemetryView(asRun({ run_id: "r1" }));
    expect(t).toMatchObject({ run_id: "r1", chunks: null, skipped_chunks: 0, tokens: { total: null }, tokens_per_s: { planner_median: null }, wall_s: null, cloud_model_calls: 0 });
  });
});

describe("ops/cells", () => {
  it("accepts only the three cell-id forms", () => {
    for (const ok of ["0000004904.declarations", "0000004904.weather_change", "key.cik@CY2025Q1", "key.station@all", "ev-r20261025T14571773a0-07"]) expect(CELL_ID.test(ok), ok).toBe(true);
    for (const bad of ["4904.declarations", "0000004904.revenue", "key.CIK@x", "key.cik@CY2025Q1/..", "ev-r1-01", "../etc", ""]) expect(CELL_ID.test(bad), bad).toBe(false);
    expect(cellEvidence(asRun({ run_id: "r1" }), "../x")).toBeNull();
    expect(cellEvidence(asRun({ run_id: "r1" }), "0000000001.declarations")).toBeNull();
  });

  it("accepts the join map's cell id of a generic pair key (match_rate) and refuses pairs outside cw. or the closed transform set", () => {
    const pairs = ["key.pair:cw.utility_states.state~cw.states.code|identity", "key.pair:cw.frames_revenues_cy2025q1.cik~cw.utility_states.cik|lpad10", "key.pair:cw.a.b~cw.c.d|substr(4,2)", "key.pair:cw.a.b~cw.c.d|strip_prefix('US-')"];
    for (const ok of pairs) expect(CELL_ID.test(ok), ok).toBe(true);
    for (const bad of ["key.pair:won.a.b~cw.c.d|identity", "key.pair:cw.a.b~cw.c.d|drop", "key.pair:cw.a.b~cw.c.d|identity/..", "key.pair:cw.A.b~cw.c.d|identity"]) expect(CELL_ID.test(bad), bad).toBe(false);
    const route = "pair:cw.utility_states.state~cw.states.code|identity";
    const run = asRun({ run_id: "r1", join_map: [{ key: route, label: "synthetic pair", matched_rows: 43, left_rows: 43, rate: 1, verdict: "VERIFIED", orphans: [], sql: "SELECT 1" }] });
    expect(cellEvidence(run, `key.${route}`)).toMatchObject({ kind: "join_key", label: `${route}: 43 of 43 rows matched`, value: { rate: 1, verdict: "VERIFIED" } });
  });

  it("an answer value without a recorded statement says so instead of showing an empty drawer", () => {
    const run = asRun({ run_id: "r1", quarter: "CY2025Q1", answer: { quarter: "CY2025Q1", previous: "CY2024Q1", rows: [{ cik: "0000000001", name: "Synthetic Power Co", declarations: 1, provenance: {} }] } });
    const c = cellEvidence(run, "0000000001.declarations");
    expect(c).toMatchObject({ value: 1, statements: [], cell_rows_complete: false, missing: ["no statement recorded for declarations"] });
    expect(answerView(run).rows[0]!.cells.revenue_change).toBe("0000000001.revenue_change");
    expect(answerView(asRun({ run_id: "r2" }))).toMatchObject({ answered: false, rows: [] });
  });
});

describe("ops/usl", () => {
  it("renders the DQ parts without a plan and leaves invalid rows unmapped when the columns are unknown", () => {
    const v = uslView(null, { ran_at: "2026-01-01T00:00:00Z", rules: [{ rule: "t.c", total: 2, valid: 1, invalid: 1, elapsed_s: 1.5 }], invalid_rows: [{ rule: "t.c", row: ["a"] }] }, null);
    expect(v).toMatchObject({ usl: null, tables: [], fks: [], live_rules: null, onboarding_dq: { ran_at_sgt: "2026-01-01 08:00:00 SGT", invalid_total: 1, rules: [{ rule: "t.c", elapsed_ms: 1500 }] } });
    expect(v.invalid_rows).toEqual([{ rule: "t.c", table: "t", columns: [], row: ["a"], values: null }]);
  });

  it("dates the live rules by the run's first dq_run statement, else by the run's start", () => {
    const rules = [{ rule: "t.c", total: 1, valid: 1, invalid: 0, elapsed_ms: 5 }];
    const withStatements = asRun({ run_id: "r1", started_at: "2026-01-01T00:00:00Z", usl: { live_rules_run: rules, provenance: [{ template: "dq_run", executed_at: "2026-01-01T08:03:08+0800" }, { template: "dq_run", executed_at: "2026-01-01T08:03:05+0800" }, { template: "usl_model", executed_at: "2026-01-01T08:01:00+0800" }] } });
    expect(uslView(null, null, withStatements).live_rules).toMatchObject({ at: "2026-01-01T08:03:05+0800", at_sgt: "2026-01-01 08:03:05 SGT" });
    const without = asRun({ run_id: "r2", started_at: "2026-01-01T00:00:00Z", usl: { live_rules_run: rules } });
    expect(uslView(null, null, without).live_rules).toMatchObject({ at_sgt: "2026-01-01 08:00:00 SGT" });
  });
});
