import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  attributionSections,
  buildReport,
  coveragePerUtility,
  renderMarkdown,
  runMode,
  stationCoverage,
  summariseRun,
  type EvalRun,
  type JoinMapFile,
  type SeedStation,
  type SeedUtility,
} from "../src/eval/report.ts";

// A trimmed copy of a saved run (fixtures/eval-run.json): accession numbers kept, filing values,
// memo text and most rows removed; degree-day rows kept for 12 stations.
const fixture = (): EvalRun => JSON.parse(readFileSync(new URL("./fixtures/eval-run.json", import.meta.url), "utf8")) as EvalRun;
const utilities = (JSON.parse(readFileSync(new URL("../../seeds/utilities.json", import.meta.url), "utf8")) as { utilities: SeedUtility[] }).utilities;
const stations = (JSON.parse(readFileSync(new URL("../../seeds/stations.json", import.meta.url), "utf8")) as { stations: SeedStation[] }).stations;

function coldClone(run: EvalRun, id: string, startedAt: string): EvalRun {
  const c = JSON.parse(JSON.stringify(run)) as EvalRun;
  c.run_id = id;
  c.started_at = startedAt;
  c.skipped_steps = [];
  c.summary = { ...c.summary, chunks: 5, planner_calls: 9, planner_valid_first_try: 9, planner_repaired: 0 };
  c.wall_ms = 84146;
  return c;
}

describe("eval report: per-run summary", () => {
  it("reads planner validity, memo outcome, E-complete and E-cov from the run file", () => {
    const run = fixture();
    const s = summariseRun(run, "fixture");
    expect(s.run_id).toBe(run.run_id);
    expect(s.mode).toBe("warm");
    expect(runMode(run)).toBe("warm");
    expect(s.chunks).toBe(4);
    expect(s.planner_calls).toBe(8);
    expect(s.valid_first_try).toBe(7);
    expect(s.repaired).toBe(1);
    expect(s.repairs_think_off).toBeNull();
    expect(s.fallbacks).toBe(0);
    expect(s.memo.source).toBe("model");
    expect(s.memo.words).toBe(184);
    expect(s.memo.attempts).toBe(1);
    expect(s.memo.drafts).toEqual([{ attempt: 1, ok: true, words: 184, unknown_numbers: 0 }]);
    expect(s.evidence.records).toBe(20);
    expect(s.evidence.complete_fields).toBe(20);
    expect(s.evidence.unresolved_object_names).toBe(0);
    expect(s.evidence.e_complete).toBe(20);
    expect(s.evidence.e_complete_ratio).toBe(1);
    expect(s.evidence.matches_run_quality).toBe(true);
    expect(s.claims).toMatchObject({ total: 19, with_evidence: 19, e_cov: 1, matches_run_quality: true });
    expect(s.skipped_steps).toEqual([{ item: "tag_chosen", memoryId: "mem-49" }]);
    expect(s.weather_quarter_ms.current).toBeGreaterThan(10_000);
    expect(s.weather_quarter_ms.previous).toBeGreaterThan(10_000);
    expect(s.cloud_model_calls).toBe(0);
    expect(s.refused_hosts).toBe(0);
    expect(s.model).toBe("nemotron-3-nano:4b");
  });

  it("counts an unresolved object name ({tag}) and a missing required field as incomplete", () => {
    const run = fixture();
    const sql = run.evidence.find((e) => e.kind === "zetaris_sql")!;
    sql.zetaris_object = "won.frames_{tag}_{period}";
    const tool = run.evidence.find((e) => e.kind === "tool")!;
    delete (tool as { derived_from?: string[] }).derived_from;
    const s = summariseRun(run, "fixture");
    expect(s.evidence.unresolved_object_names).toBe(1);
    expect(s.evidence.complete_fields).toBe(19);
    expect(s.evidence.e_complete).toBe(18);
    expect(s.evidence.matches_run_quality).toBe(false);
  });

  it("E-cov drops when a claim cites nothing", () => {
    const run = fixture();
    run.card.claims[0]!.evidenceIds = [];
    const s = summariseRun(run, "fixture");
    expect(s.claims.with_evidence).toBe(18);
    expect(s.claims.e_cov).toBeCloseTo(18 / 19, 12);
  });
});

describe("eval report: coverage per utility", () => {
  it("takes the minimum over a utility's stations per period and marks utilities whose stations are not all in the rows", () => {
    const run = fixture();
    const cov = stationCoverage(run);
    expect(Object.keys(cov).sort()).toEqual(["CY2024Q1", "CY2025Q1"]);
    expect(cov["CY2025Q1"]!.size).toBe(12);
    const section = coveragePerUtility(run, utilities, ["CY2025Q1", "CY2024Q1"]);
    expect(section.from_run).toBe(run.run_id);
    expect(section.utilities).toHaveLength(utilities.length);
    const fe = section.utilities.find((u) => u.cik === "0001031296")!;
    expect(fe.complete).toBe(true);
    expect(fe.stations).toBe(9);
    expect(fe.coverage["CY2025Q1"]).toBe(1);
    expect(fe.coverage["CY2024Q1"]).toBe(1);
    expect(fe.min).toBe(1);
    const kept = new Set(cov["CY2025Q1"]!.keys());
    const expectedComplete = utilities.filter((u) => u.station_ids.every((s) => kept.has(s))).length;
    expect(section.summary.with_every_station).toBe(expectedComplete);
    expect(section.summary.not_covered).toBe(utilities.length - expectedComplete);
    const partial = section.utilities.find((u) => !u.complete)!;
    expect(partial.min).toBeNull();
    expect(partial.present).toBeLessThan(partial.stations);
  });

  it("with no run every utility is not covered", () => {
    const section = coveragePerUtility(null, utilities, ["CY2025Q1", "CY2024Q1"]);
    expect(section.from_run).toBeNull();
    expect(section.summary.with_every_station).toBe(0);
    expect(section.summary.min_coverage).toBeNull();
  });
});

describe("eval report: attribution", () => {
  it("quotes the latest run's attribution with its bootstrap and says whether every run of the utility agrees", () => {
    const run = fixture();
    const one = attributionSections([run]);
    expect(one).toHaveLength(1);
    expect(one[0]!.from_run).toBe(run.run_id);
    expect(one[0]!.beta).toBe(run.card.attribution!.beta);
    expect(one[0]!.bootstrap).toEqual({ resamples: 300, valid: 300, skipped_zero_variance: 0, seed: 7 });
    expect(one[0]!.weather.lo).toBe(run.card.attribution!.ranges.weather.lo);
    expect(one[0]!.identical_across_runs).toBe(true);
    const earlier = coldClone(run, "r-earlier", "2026-10-24T12:00:00.000Z");
    earlier.card.attribution!.beta = 0.4;
    const two = attributionSections([run, earlier]);
    expect(two[0]!.from_run).toBe(run.run_id);
    expect(two[0]!.runs).toEqual(["r-earlier", run.run_id]);
    expect(two[0]!.identical_across_runs).toBe(false);
  });
});

describe("eval report: whole report and markdown", () => {
  it("marks absent inputs as not measured, names the runs it used and compares cold with warm", () => {
    const warm = fixture();
    const cold = coldClone(warm, "r-cold-fixture", "2026-10-24T12:00:00.000Z");
    const report = buildReport({ runs: [{ run: warm, source: "fixture" }, { run: cold, source: "fixture" }], dq: null, joinmap: null, utilities, stations, now: new Date("2026-10-24T14:00:00Z") });
    expect(report.inputs.runs.map((r) => r.run_id)).toEqual(["r-cold-fixture", warm.run_id]);
    expect(report.inputs.dq_file).toBe(false);
    expect(report.join_map).toBeNull();
    expect(report.dq).toBeNull();
    expect(report.peers?.count).toBe(39);
    expect(report.peers?.excluded).toHaveLength(3);
    expect(report.peers?.identical_across_runs).toBe(true);
    expect(report.totals).toMatchObject({ runs: 2, planner_calls: 17, valid_first_try: 16, repaired: 1, repairs_think_off: null, fallbacks: 0, memo_drafts: 2, memo_drafts_with_unknown_numbers: 0, cloud_model_calls: 0 });
    const withThinkOff = coldClone(warm, "r-think-off", "2026-10-24T12:10:00.000Z");
    withThinkOff.summary.planner_repairs_think_off = 1;
    const r2 = buildReport({ runs: [{ run: warm, source: "fixture" }, { run: withThinkOff, source: "fixture" }], dq: null, joinmap: null, utilities, stations });
    expect(r2.totals.repairs_think_off).toBe(1);
    expect(renderMarkdown(r2)).toContain("(1 of them with think off)");
    expect(report.cold_vs_warm.all.cold.chunks_mean).toBe(5);
    expect(report.cold_vs_warm.all.warm.chunks_mean).toBe(4);
    expect(report.cold_vs_warm.all.cold.run_ids).toEqual(["r-cold-fixture"]);
    expect(report.cold_vs_warm.per_cik["0001031296"]!.warm.runs).toBe(1);
    const md = renderMarkdown(report);
    expect(md).toContain("# Weather-or-Not evaluation report");
    expect(md).toContain(warm.run_id);
    expect(md).toContain("Not measured (no join-map file)");
    expect(md).toContain("Not measured (no DQ onboarding file)");
    expect(md).toContain("| all, cold | 1 | 5.00 |");
    expect(md).toContain("| all, warm | 1 | 4.00 |");
    expect(md).not.toMatch(/\{\w+\}/u);
    expect(md).not.toMatch(/[A-Za-z]:\\/u);
    expect(md).not.toMatch(/@\w+\./u);
  });

  it("renders the join map and the DQ file when present", () => {
    const run = fixture();
    const joinmap: JoinMapFile = {
      measured_at: "2026-10-24T21:00:00+0800",
      bound_s: 60,
      login: "admin",
      elapsed_s: 12.3,
      statements: [{ id: "usl_station_rows", group: "station_state", elapsed_ms: 44736, row_count: 57, measured: true, timeout: false, error: null, sql_sha256: "00" }],
      results: {
        seeds: 43,
        cik_lpad: { "Revenues.CY2025Q1": { tag: "Revenues", period: "CY2025Q1", seeds: 43, lpad_matched: 34, in_count: 34, agree: true, elapsed_ms: 6271 } },
        cik_no_lpad_control: { matched: 0, elapsed_ms: 6281, measured: true },
        cik_any_tag: { CY2025Q1: { seeds_with_a_fact: 42, seeds: 43, elapsed_ms: 508, measured: true } },
        loc: { "Revenues.CY2025Q1": { tag: "Revenues", period: "CY2025Q1", present: 34, equal: 34, different: 0, missing: 0, elapsed_ms: 6271 } },
        loc_differing_rows: [],
        sic: {
          measured: true,
          seeds: 43,
          orphans: [{ cik: "0001161728", name: "MGE ENERGY INC", sic: "4900" }],
          joined: 42,
          elapsed_ms: 6834,
          recorded_run_dq: { source: "test", statement: "RUN DQ sic TABLE t", result: { type: "Foreign Key Constraint", total: 43, valid: 42, invalid: 1 }, elapsed_s: 79.1, invalid_record: { cik: "0001161728", name: "MGE ENERGY INC", ticker: "MGEE", sic: "4900", hq_state: "WI" }, invalid_record_statement: "SHOW DQ INVALID RECORD sic TABLE t", invalid_record_elapsed_s: 93.3, note: "note" },
        },
        station: { seed_stations: 56, measured: false, elapsed_ms: 60000, bound_s: 60, timeout: true, error: "timeout", skipped: false },
      },
    };
    const dq = { ran_at: "2026-10-24T19:31:39+0800", rule: "coverage_ok", table: "t.weather_quarter", elapsed_s: 739.3, ok: true, run: { total: 342, valid: 342, invalid: 0, elapsed_s: 557.2 }, invalid_rows: [], statements: [{ template_id: "dq_run_coverage", elapsed_s: 557.2, row_count: 1, error: null }] };
    const report = buildReport({ runs: [{ run, source: "fixture" }], dq, joinmap, utilities, stations });
    expect(report.dq?.sic_fk?.result.invalid).toBe(1);
    const md = renderMarkdown(report);
    expect(md).toContain("| Revenues | CY2025Q1 | 43 | 34 | 34 | yes | 6,271 |");
    expect(md).toContain("Control without LPAD (integer string against the zero-padded cik): 0 matched");
    expect(md).toContain("Not measured: the statement exceeded the 60 s bound");
    expect(md).toContain("orphan(s): MGE ENERGY INC (CIK 0001161728, SIC 4900)");
    expect(md).toContain("RUN DQ 342 total / 342 valid / 0 invalid in 557.2 s");
  });
});
