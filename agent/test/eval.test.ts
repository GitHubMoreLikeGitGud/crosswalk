import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  answerCanonical,
  buildReport,
  compareRuns,
  gpuSummary,
  isGoverned,
  keyFamily,
  l2Section,
  manualSummary,
  median,
  renderMarkdown,
  sideTally,
  statementClass,
  toolTimings,
  type EvalRun,
  type ManualSession,
  type Selection,
  type SelectedRun,
} from "../src/eval/report.ts";
import { readGpuDir } from "../src/eval/run.ts";
import { femaCounts, femaUrl, htmlText, serviceSentences } from "../src/eval/outside.ts";

// Synthetic-value copies of two saved runs (fixtures/make_server_fixtures.py): structure, SQL text,
// counts and timings from the runs; revenue values, accession numbers and degree days synthetic.
const load = (f: string): EvalRun => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8")) as EvalRun;
const cold = () => load("server-run-cold.json");
const warm = () => load("server-run-warm.json");
const clone = (r: EvalRun, id: string): EvalRun => ({ ...(JSON.parse(JSON.stringify(r)) as EvalRun), run_id: id });
const sel = (run_id: string, setting: SelectedRun["setting"] = "think_on", by = "lane E"): SelectedRun => ({ run_id, label: run_id, by, code: "abc1234", setting });

describe("eval report: keys", () => {
  it("folds periods and quarters into the key family", () => {
    expect(keyFamily("cik@CY2025Q1")).toBe("cik");
    expect(keyFamily("station@all")).toBe("station");
    expect(keyFamily("pair:cw.frames_revenues_cy2024q1.cik~cw.utility_states.cik|lpad10")).toBe("pair:cw.frames_revenues_<period>.cik~cw.utility_states.cik|lpad10");
    expect(keyFamily("pair:cw.utility_states.state~cw.fema_declarations_dr_2025q1.state|identity")).toBe("pair:cw.utility_states.state~cw.fema_declarations_dr_<quarter>.state|identity");
    expect(isGoverned("fema_fips@CY2024Q1")).toBe(true);
    expect(isGoverned("pair:cw.utility_states.state~cw.states.code|identity")).toBe(false);
  });

  it("classes statements by template", () => {
    expect(statementClass("distinct_counts")).toBe("probe");
    expect(statementClass("joinmap_cik_orphans")).toBe("measure (named join-map statement)");
    expect(statementClass("match_rate_orphans")).toBe("measure (generic match_rate)");
    expect(statementClass("weather_quarter")).toBe("answer (weather)");
    expect(statementClass("answer_revenue")).toBe("answer");
    expect(statementClass("dq_run")).toBe("live DQ");
    expect(statementClass(null)).toBe("registrar plan (DESCRIBE, cache check)");
  });
});

describe("eval report: reproducibility", () => {
  it("finds two copies of a run identical on the answer and the join map", () => {
    const p = compareRuns(cold(), clone(cold(), "r2"));
    expect(p.answer_identical).toBe(true);
    expect(p.answer_rows).toEqual([12, 12]);
    expect(p.join_common).toBe(7);
    expect(p.join_identical_on_common).toBe(true);
    expect(p.governed_identical).toBe(true);
    expect(p.governed_compared).toBe(7);
  });

  it("names the utility whose answer row differs and a key only one run measured", () => {
    const b = clone(cold(), "r2");
    b.answer!.rows[0]!.revenue!.change = 0.5;
    b.join_map!.push({ id: "k9", key: "pair:cw.utility_states.state~cw.states.code|identity", proposed_by: ["planner", "baseline (queue)"], verdict: "VERIFIED", left_rows: 43, matched_rows: 43, orphans: [] });
    const p = compareRuns(cold(), b);
    expect(p.answer_identical).toBe(false);
    expect(p.answer_differences).toEqual([cold().answer!.rows[0]!.cik]);
    expect(p.only_in_b).toEqual(["pair:cw.utility_states.state~cw.states.code|identity"]);
    expect(p.proposers).toEqual({ "pair:cw.utility_states.state~cw.states.code|identity": "model+baseline" });
    expect(p.governed_identical).toBe(true);
  });

  it("flags a governed key whose numbers moved", () => {
    const b = clone(cold(), "r2");
    const sic = b.join_map!.find((r) => r.key === "sic@all")!;
    sic.matched_rows = 41;
    const p = compareRuns(cold(), b);
    expect(p.governed_identical).toBe(false);
    expect(p.join_identical_on_common).toBe(false);
  });

  it("compares answers without provenance or timings", () => {
    const b = clone(cold(), "r2");
    (b.answer!.rows[0] as unknown as { provenance: unknown }).provenance = { changed: true };
    expect(JSON.stringify(answerCanonical(b))).toBe(JSON.stringify(answerCanonical(cold())));
  });
});

describe("eval report: L2 tallies", () => {
  it("reads each side's tally and the keys the join map holds VERIFIED", () => {
    const m = sideTally(cold(), "model");
    expect(m).toMatchObject({ proposed_by: "planner", made: 3, verified: 0, partial: 1, unmeasurable: 2, verified_keys: [] });
    const b = sideTally(cold(), "baseline");
    expect(b.verified).toBe(3);
    expect(b.verified_keys).toEqual(["cik", "sic", "station"]);
    expect(b.recalled_keys).toEqual([]);
  });

  it("matches a recalled key recorded under the asked quarter and marks it recalled", () => {
    const b = sideTally(warm(), "baseline");
    expect(b.verified_keys).toEqual(["cik", "loc", "sic", "station"]);
    expect(b.recalled_keys).toEqual(["cik", "loc", "sic", "station"]);
  });

  it("sums both sides, counts only measured keys as found, and names the winner", () => {
    const s = l2Section([
      { sel: sel(cold().run_id), run: cold() },
      { sel: sel(warm().run_id), run: warm() },
    ]);
    expect(s.runs_counted).toBe(2);
    expect(s.totals.model).toMatchObject({ made: 5, verified: 0, partial: 1, unmeasurable: 3, invalid_schema: 1 });
    expect(s.totals.baseline).toMatchObject({ made: 12, verified: 7 });
    expect(s.winner).toBe("baseline");
    expect(s.keys_found.baseline).toEqual(["cik", "sic", "station"]);
    expect(s.keys_found.only_model).toEqual([]);
  });
});

describe("eval report: timings, GPU, manual baseline", () => {
  it("aggregates tool latencies and statement times and counts statements over 20 s", () => {
    const t = toolTimings([cold(), warm()]);
    expect(t.over_20s).toBe(0);
    const weather = t.statements.find((x) => x.name === "weather_quarter")!;
    expect(weather.class).toBe("answer (weather)");
    // two weather statements in the cold run; the warm question's weather is Not-tested
    expect(weather.n).toBe(2);
    expect(t.tools.find((x) => x.name === "answer")!.n).toBe(2);
    expect(t.planner.n).toBe(cold().planner_calls!.length + warm().planner_calls!.length);
    expect(median([3, 1, 2, 10])).toBe(2.5);
  });

  it("summarises nvidia-smi samples and the Ollama residency", () => {
    const g = gpuSummary({
      run_id: "r1",
      samples: [
        { at: "a", mem_mib: 6900, util_pct: 10 },
        { at: "b", mem_mib: 7400, util_pct: 90 },
        { at: "c", mem_mib: 7100, util_pct: 40 },
      ],
      ollama_before: { models: [] },
      ollama_mid: { models: [{ name: "m", size_vram: 3 * 1048576, context_length: 8192, details: { parameter_size: "4.0B", quantization_level: "Q4_K_M" } }] },
    });
    expect(g).toMatchObject({ samples: 3, mem_first_mib: 6900, mem_peak_mib: 7400, util_median_pct: 40, util_peak_pct: 90, ollama_size_vram_mib: 3, resident_before: false, quantization: "Q4_K_M" });
    const d = gpuSummary({ run_id: "r2", samples: [6900, 3800, 6900, 3790, 6950].map((mem_mib, i) => ({ at: String(i), mem_mib, util_pct: 50 })) });
    expect(d).toMatchObject({ unload_dips: 2, card_drop_mib: 3110 });
    expect(g.unload_dips).toBe(0);
    expect(g.card_drop_mib).toBeNull();
  });

  it("reads the driver log, the samples and the run id of each ablation run", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-gpu-"));
    try {
      writeFileSync(join(dir, "driver.log"), `\uFEFFstart think_on-1 2026-01-01T00:00:00.000 ollama_ps_before {"models":[]}\nend think_on-1 2026-01-01T00:04:00.000 exit 0 shell_s 240 ollama_ps_mid {"models":[{"name":"m","size_vram":1048576}]} ollama_ps_after {"models":[]}\n`);
      writeFileSync(join(dir, "think_on-1.out"), "saved X:/d/runs/r20260101T000000abcd/run.json\n");
      writeFileSync(join(dir, "think_on-1.smi.csv"), "2026/01/01 00:00:00.000, 6900, 12\n2026/01/01 00:00:00.500, 7300, 88\n");
      const g = readGpuDir(dir);
      expect(g).toHaveLength(1);
      expect(g[0]!.run_id).toBe("r20260101T000000abcd");
      expect(g[0]!.samples.map((s) => s.mem_mib)).toEqual([6900, 7300]);
      expect(gpuSummary(g[0]!).ollama_size_vram_mib).toBe(1);
      expect(gpuSummary(g[0]!).resident_before).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts statements, lookups and decisions of the manual session", () => {
    const m: ManualSession = {
      label: "measured",
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T00:10:00.000Z",
      steps: [
        { n: 1, at: "2026-01-01T00:00:00.000Z", template: "lookup", params: { what: "manifest" }, elapsed_ms: 0, rows: 0, result: "18 views", decision: "probe the snapshot" },
        { n: 2, at: "2026-01-01T00:01:00.000Z", template: "describe_object", params: { object: "cw.states" }, elapsed_ms: 80, rows: 3, result: "code, name, fips", decision: "" },
        { n: 3, at: "2026-01-01T00:02:00.000Z", template: "match_rate", params: {}, elapsed_ms: 400, rows: 1, result: "43/43", decision: "VERIFIED", error: null },
      ],
      keys: [{ key: "d station", verdict: "VERIFIED", matched: 56, total: 56, orphans: [] }],
    };
    const s = manualSummary(m);
    expect(s).toMatchObject({ statements: 2, lookups: 1, statement_ms_total: 480, decisions: 2, session_wall_s: 600 });
    expect(s.by_class).toEqual({ probe: 1, "measure (generic match_rate)": 1 });
  });
});

describe("eval report: outside checks", () => {
  it("renders the registrar's OpenFEMA URL for a quarter", () => {
    expect(femaUrl("CY2025Q1")).toContain("declarationDate%20ge%20%272025-01-01T00%3A00%3A00.000Z%27%20and%20declarationDate%20lt%20%272025-04-01T00%3A00%3A00.000Z%27");
    expect(femaUrl("CY2024Q4")).toContain("lt%20%272025-01-01T00%3A00%3A00.000Z%27");
    expect(() => femaUrl("2025Q1")).toThrow();
  });

  it("counts rows, distinct declarations and states", () => {
    expect(
      femaCounts([
        { disasterNumber: 1, state: "CA" },
        { disasterNumber: 1, state: "CA" },
        { disasterNumber: 2, state: "AK" },
        { disasterNumber: 3, state: "AK" },
      ]),
    ).toEqual({ rows: 4, declarations: 3, states: 2, by_state: { AK: 2, CA: 1 } });
  });

  it("finds the states named in service sentences of a filing", () => {
    const text = htmlText("<p>The company serves customers in Kansas&#160;and Missouri.</p><p>West Virginia is mentioned elsewhere.</p><div>Its service territory covers West Virginia; it is regulated.</div>");
    const s = serviceSentences(text);
    expect(s.states).toEqual(["KS", "MO", "WV"]);
    expect(s.sentences).toHaveLength(2);
  });
});

describe("eval report: build and render", () => {
  const selection: Selection = {
    runs: [sel("r20261025T14571773a0"), { ...sel("rCOPY"), setting: "no_model" }, { ...sel("r20261025T145128a180"), by: "lane F" }],
    references: [{ run_id: "r20261025T14571773a0", label: "Day-1 reference" }],
    did_not_go_well: ["one thing"],
    not_measured: ["another thing"],
  };
  const runs = new Map<string, EvalRun>([
    ["r20261025T14571773a0", cold()],
    ["rCOPY", clone(cold(), "rCOPY")],
    ["r20261025T145128a180", warm()],
  ]);

  it("builds every section from the selected runs", () => {
    const r = buildReport({ selection, runs, gpu: [], manual: null, outside: null });
    expect(r.runs).toHaveLength(3);
    expect(r.reproducibility.cold_runs).toBe(2);
    expect(r.reproducibility.all_answers_identical).toBe(true);
    expect(r.reproducibility.reference_matches.filter((m) => m.identical)).toHaveLength(2);
    expect(r.answer!.rows).toHaveLength(12);
    expect(r.ablation.map((a) => a.setting)).toEqual(["think_on", "no_model"]);
    expect(r.ablation[1]!.answer_identical_to_think_on).toBe(true);
    expect(r.l2.runs_counted).toBe(2);
    expect(r.l2.cold_runs_counted).toBe(1);
    expect(r.l2.rows).toHaveLength(3);
  });

  it("refuses a selection that names a run without a file", () => {
    expect(() => buildReport({ selection: { runs: [sel("rMISSING")] }, runs, gpu: [], manual: null, outside: null })).toThrow(/rMISSING/u);
  });

  it("renders the seven sections and copies no revenue value or accession number", () => {
    const md = renderMarkdown(buildReport({ selection, runs, gpu: [], manual: null, outside: null }));
    for (const h of ["## 1. Reproducibility", "## 2. The model's key proposals", "## 3. Outside checks", "## 4. Manual baseline", "## 5. Nemotron ablation", "## 6. Timings", "## 7. What did not go well", "## Not measured"]) expect(md).toContain(h);
    const values = cold().answer!.rows.flatMap((r) => [r.revenue?.current, r.revenue?.previous]).filter((v): v is number => typeof v === "number");
    for (const v of values) expect(md).not.toContain(String(v));
    expect(md).not.toMatch(/\d{10}-\d{2}-\d{6}/u);
    expect(md).toContain("+4.00% (Revenues)");
  });
});

// The directory helper is used by run.ts only through readGpuDir; keep mkdirSync referenced for a nested layout check.
describe("eval report: nested GPU directory", () => {
  it("returns nothing for a directory without a driver log", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-gpu-"));
    try {
      mkdirSync(join(dir, "sub"));
      expect(readGpuDir(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
