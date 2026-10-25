// The discovery-loop registry (agent/src/loop/tools.ts) driven by the deterministic fallback alone, over a fake
// gateway with synthetic replies (made-up CIKs, station ids and values): every checklist item resolves, the
// baseline's keys are measured through the join-map templates, the onboarding-only DQ templates are refused on
// the question path, and the planner's choices are checked and scored.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EvidenceStore } from "../src/evidence/store.ts";
import { plannerSchema, validate } from "../src/llm/schemas.ts";
import { TOOL_CATALOG } from "../src/llm/toolCatalog.ts";
import { allowedTools, completeInput, fallbackStep, memoryKeyOf, newQuestionContext, questionPort, runTool, snapshotTakenAt, toolDef, type KeyMemoryPort, type RegistrarPort, type ToolDeps } from "../src/loop/tools.ts";
import { loadSeeds } from "../src/seeds.ts";
import type { MeasureResult } from "../src/tools/discovery.ts";
import type { RegistrarResult } from "../src/zetaris/client.ts";
import { fakeGateway, type Reply } from "./helpers/fakeGateway.ts";

const repo = new URL("../../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("zetaris/manifest.json", repo), "utf8"));
const NOW = new Date("2026-10-25T12:00:00+08:00");
const Q = "CY2025Q1";
const KEYS9 = ["cik@CY2025Q1", "cik_control@CY2025Q1", "fema_fips@CY2025Q1", "fema_state@CY2025Q1", "loc@CY2025Q1",
  "pair:cw.frames_revenues_cy2025q1.cik~cw.utility_states.cik|lpad10", "pair:cw.seed_submissions_snapshot.cik10~cw.utility_states.cik|identity", "sic@all", "station@all"];

const S = (n: string) => ({ name: n, type: "string" });
const SHAPES: Record<string, { cols: { name: string; type: string }[]; rows: unknown[][]; distinct: Record<string, [number, number]> }> = {
  "cw.seed_submissions_snapshot": { cols: ["cik10", "name", "ticker", "sic", "hq_state", "snapshot_at"].map(S), rows: [["0009000001", "SYN A", "SA", "4911", "CA", "2026-10-25T12:00:00+0800"], ["0009000002", "SYN B", null, "4900", "OH", "2026-10-25T12:00:00+0800"]], distinct: { cik10: [43, 43], sic: [43, 4], hq_state: [43, 30] } },
  "cw.frames_revenues_cy2025q1": { cols: [{ name: "cik", type: "bigint" }, S("entityName"), S("loc"), S("accn"), { name: "val", type: "double" }], rows: [[9000001, "SYN A", "US-CA", "x", 1], [12345, "SYN Z", "US-NY", "y", 2]], distinct: { cik: [1900, 1900], loc: [1900, 55] } },
  "cw.fema_declarations_dr_2025q1": { cols: ["disaster_number", "state", "incident_type", "fips_state_code"].map(S), rows: [["9001", "KY", "Flood", "21"], ["9002", "AK", "Fire", "02"]], distinct: { state: [116, 8], disaster_number: [116, 10], fips_state_code: [116, 8] } },
  "cw.utility_states": { cols: ["cik", "state"].map(S), rows: [["0009000001", "CA"], ["0009000002", "OH"]], distinct: { cik: [97, 43], state: [97, 43] } },
  "cw.states": { cols: ["code", "name", "fips"].map(S), rows: [["CA", "California", "06"], ["OH", "Ohio", "39"]], distinct: { code: [51, 51], fips: [51, 51] } },
  "cw.seed_stations": { cols: ["id", "state", "name"].map(S), rows: [["USW00099001", "CA", "SYN 1"], ["USW00099002", "OH", "SYN 2"]], distinct: { state: [56, 43], id: [56, 56] } },
  "cw.stations": { cols: [S("id"), S("state"), S("name"), { name: "latitude", type: "double" }], rows: [["USW00099001", "CA", "SYN 1", 1.5], ["CA000000001", "", "SYN 3", 2.5]], distinct: { state: [133000, 60], id: [133000, 133000] } },
  "cw.sic_codes": { cols: ["code", "description"].map(S), rows: [["4911", "Electric"], ["4900", "x"]], distinct: { code: [1005, 1005] } },
};

function resolve(id: string, p: Record<string, string>): Reply | undefined {
  const shape = p.object ? SHAPES[p.object] : undefined;
  switch (id) {
    case "catalogue_list":
      return { columns: ["name", "version", "title", "api_endpoint", "last_dataset_refresh"], rows: [["DisasterDeclarationsSummaries", 2, "Disaster Declarations Summaries (synthetic)", "", "2026-10-25"]] };
    case "describe_object":
      return shape && { columns: ["col_name", "data_type", "comment"], rows: shape.cols.map((c) => [c.name, c.type, null]) };
    case "sample_rows":
      return shape && { columns: shape.cols.map((c) => c.name), rows: shape.rows };
    case "distinct_counts": {
      const d = shape?.distinct[p.column!];
      return d && { columns: ["row_count", "distinct_values", "non_null", "non_null_share"], rows: [[d[0], d[1], d[0], 1]] };
    }
    case "joinmap_cik":
      return { columns: ["left_keys", "matched_keys"], rows: [[43, 42]] };
    case "joinmap_cik_orphans":
      return { columns: ["orphan_cik", "name"], rows: [["0009000043", "SYN Q"]] };
    case "joinmap_cik_control":
      return { columns: ["left_keys", "matched_keys"], rows: [[43, 0]] };
    case "joinmap_fema_fips":
      return { columns: ["left_keys", "matched_keys"], rows: [[8, 8]] };
    case "joinmap_loc":
      return { columns: ["left_keys", "matched_keys"], rows: [[42, 42]] };
    case "joinmap_fema_state":
      return { columns: ["left_keys", "matched_keys"], rows: [[8, 7]] };
    case "joinmap_fema_state_orphans":
      return { columns: ["orphan_state"], rows: [["AK"]] };
    case "joinmap_station":
      return { columns: ["left_keys", "matched_keys", "state_equal"], rows: [[56, 56, 56]] };
    case "joinmap_sic":
      return { columns: ["left_keys", "matched_keys", "left_rows", "matched_rows"], rows: [[4, 3, 43, 42]] };
    case "joinmap_sic_orphans":
      return { columns: ["orphan_sic", "cik", "name"], rows: [["4900", "0009000002", "SYN B"]] };
    // D16: any other pair; synthetic rule: the same column name on both sides matches every key, otherwise half do.
    case "match_rate":
      return { columns: ["left_keys", "matched_keys"], rows: [[40, p.left_column === p.right_column ? 40 : 20]] };
    case "match_rate_orphans":
      return { columns: ["orphan"], rows: [["SYN-ORPHAN"]] };
    case "dq_run":
      return { columns: ["total", "valid", "invalid"], rows: [[97, 97, 0]] };
    case "answer_fema_utilities":
      return { columns: ["cik", "name", "ticker", "state", "declarations", "severe_storm", "fire", "flood", "other_incidents"], rows: [["0009000001", "SYN A", "SA", "CA", 1, 0, 1, 0, 0]] };
    case "answer_revenue":
      return { columns: ["cik", "xbrl_tag", "val", "accn"], rows: [["0009000001", "Revenues", p.period === Q ? 110 : 100, "a"]] };
    default:
      return undefined;
  }
}

function registrar(alreadyRegistered = true): RegistrarPort & { calls: { action: string; params: Record<string, string> }[] } {
  const calls: { action: string; params: Record<string, string> }[] = [];
  return {
    calls,
    async register(action, params): Promise<RegistrarResult> {
      calls.push({ action, params });
      return { action, params, contract_id: "c-test", steps: [{ template_id: "registrar_fema_describe", kind: "describe", sql: "DESCRIBE x", sql_sha256: "0", objects: [] }], skipped: [], already_registered: alreadyRegistered, http_status: 200, wall_ms: 9 };
    },
  };
}

function deps(over: Partial<ToolDeps> = {}): ToolDeps & { fake: ReturnType<typeof fakeGateway> } {
  const fake = fakeGateway(resolve);
  const evidence = new EvidenceStore("r-test", null);
  return { fake, gateway: fake.client, ollama: null, evidence, seeds: loadSeeds(), registrar: registrar(), catalogue: { catalogue: JSON.parse(readFileSync(new URL("seeds/catalogue.json", repo), "utf8")), manifest, gettingStarted: null }, dqFile: "no-such-file.json", ...over };
}

async function runFallback(d: ToolDeps, ctx = newQuestionContext("Which utilities served states with FEMA major disaster declarations?", Q, d.evidence, { now: NOW, manifest })) {
  const steps: string[] = [];
  for (let i = 0; i < 60; i++) {
    const s = fallbackStep(ctx, d);
    if (!s) break;
    steps.push(s.tool.name);
    await runTool(s.tool, s.input, ctx, d);
  }
  return { ctx, steps };
}

describe("the discovery loop on the fallback alone", () => {
  it("resolves every checklist item with the baseline's keys and cites every statement", async () => {
    const d = deps();
    const { ctx, steps } = await runFallback(d);
    expect(ctx.checklist.complete()).toBe(true);
    expect(ctx.checklist.snapshot().map((i) => [i.id, i.status])).toEqual([
      ["sources_found", "done"], ["shapes_probed", "done"], ["keys_proposed", "done"], ["keys_measured", "done"], ["sources_registered", "done"],
      ["usl_built", "done"], ["dq_run", "done"], ["answered", "done"], ["not_tested_listed", "done"], ["note_written", "done"],
    ]);
    // The question's eight source views first; the search adds the registered views it ranked (here one more, which the fake cannot describe).
    expect(ctx.targets.slice(0, 8)).toEqual(["cw.seed_submissions_snapshot", "cw.frames_Revenues_CY2025Q1", "cw.fema_declarations_dr_2025q1", "cw.utility_states", "cw.states", "cw.seed_stations", "cw.stations", "cw.sic_codes"]);
    expect(steps.filter((s) => s === "probe_source")).toHaveLength(ctx.targets.length);
    expect(ctx.probes.size).toBe(8);
    // Every baseline proposal of the scored six is measured (named statements or match_rate, D16), plus the named FEMA keys of ranks 7-24 and the identity control of the lpad10 key (L3).
    expect(steps.filter((s) => s === "measure_key")).toHaveLength(9);
    expect(ctx.proposals.proposedBy).toBe("baseline");
    expect([...ctx.measured.keys()].sort()).toEqual(KEYS9);
    // D18: every join-map row in the canonical orientation (the counted side on the left), whoever proposed it.
    expect(ctx.measured.get("cik@CY2025Q1")!.orientation).toEqual({ left: "cw.seed_submissions_snapshot.cik10", right: "cw.frames_*_CY2025Q1.cik", transform_on: "right" });
    expect(ctx.measured.get("fema_state@CY2025Q1")!.orientation).toEqual({ left: "cw.fema_declarations_dr_2025q1.state", right: "cw.utility_states.state", transform_on: "left" });
    // D15: nothing on the question path names cw.seed_utilities.
    expect(d.fake.calls.some((c) => JSON.stringify(c.params).includes("cw.seed_utilities"))).toBe(false);
    expect(ctx.measured.get("cik_control@CY2025Q1")!.verdict).toBe("REJECTED");
    expect(ctx.measured.get("fema_state@CY2025Q1")!.verdict).toBe("PARTIAL");
    expect(ctx.measured.get("sic@all")!.rate_distinct).toBe(0.75);
    expect(ctx.usl!.matches_governed).toBe(true);
    expect(ctx.registrations.map((r) => [r.object, r.status])).toEqual([["cw.fema_declarations_dr_2025q1", "already_registered"]]);
    expect(ctx.answer!.rows[0]!.revenue!.change).toBeCloseTo(0.1, 12);
    expect(ctx.notTested.at(-1)).toMatch(/^Weather/u);
    expect(ctx.comparison!.baseline).toMatchObject({ proposals: 6, routed: 6, measured: 6, verified: 5, rejected: 1, unmeasured: 0 });
    expect(ctx.comparison!.planner.proposals).toBe(0);
    const probed = d.fake.calls.filter((c) => c.template_id === "describe_object").map((c) => c.params.object);
    expect(probed).toContain("cw.frames_revenues_cy2025q1");
    expect(d.fake.calls.filter((c) => c.template_id === "dq_run").map((c) => c.params.rule)).toEqual(["fema_declaration.state", "utility_state.state"]);
    const sql = d.evidence.all().filter((e) => e.kind === "zetaris_sql");
    // One evidence record per statement that answered (the fake has no reply for the extra view and for the optional row-count read).
    expect(sql.length).toBe(d.fake.calls.filter((c) => resolve(c.template_id, c.params) !== undefined).length);
    expect(sql.every((e) => (e.sql ?? "").length > 0 && e.run_id === "r-test")).toBe(true);
    expect(ctx.startedAt).toBe(NOW.toISOString());
  });

  it("a warm run recalls verified keys from memory and skips their measure steps", async () => {
    const memory = new Map<string, MeasureResult>();
    const port: KeyMemoryPort = {
      recall: (k) => (memory.has(k) && memory.get(k)!.verdict === "VERIFIED" ? { result: memory.get(k)!, memoryId: `mem-${memory.get(k)!.key}` } : null),
      remember: (m) => {
        memory.set(memoryKeyOf(m.proposal), m);
        return `mem-${m.key}`;
      },
    };
    await runFallback(deps({ keyMemory: port }));
    expect([...memory.values()].map((m) => m.key).sort()).toEqual(KEYS9);
    expect(memory.has("cw.frames_revenues_<period>.cik|cw.seed_submissions_snapshot.cik10|lpad10")).toBe(true);
    // verified() lists the same memories again: one memory is one skipped step, never two.
    port.verified = () => [...memory.entries()].filter(([, m]) => m.verdict === "VERIFIED").map(([k, m]) => ({ memoryKey: k, result: m, memoryId: `mem-${m.key}` }));
    const warm = deps({ keyMemory: port });
    const { ctx, steps } = await runFallback(warm);
    expect(ctx.checklist.complete()).toBe(true);
    const skipped = ctx.skipped.filter((s) => s.item === "keys_measured").length;
    // VERIFIED keys are recalled; the PARTIAL FEMA key, the REJECTED control and the REJECTED generic pair are measured again.
    expect(skipped).toBe(6);
    expect(steps.filter((s) => s === "measure_key")).toHaveLength(3);
    expect(ctx.measured.get("cik@CY2025Q1")!.from_memory).toBe("mem-cik@CY2025Q1");
  });

  it("without a registrar the registration item is unavailable, never silently passed", async () => {
    const { ctx } = await runFallback(deps({ registrar: undefined }));
    expect(ctx.checklist.get("sources_registered").status).toBe("unavailable");
    expect(ctx.checklist.isDone("answered")).toBe(true);
  });
});

describe("the registry", () => {
  it("checks the planner's choices and scores them against the baseline", async () => {
    const d = deps();
    const ctx = newQuestionContext("q", Q, d.evidence, { now: NOW, manifest });
    for (let i = 0; i < 12; i++) {
      const s = fallbackStep(ctx, d)!;
      if (s.tool.name === "propose_keys") break;
      await runTool(s.tool, s.input, ctx, d);
    }
    const propose = toolDef("propose_keys")!;
    const c = (lo: string, lc: string, ro: string, rc: string, t: string) => ({ left: { object: lo, column: lc }, right: { object: ro, column: rc }, transform: t });
    const out = await runTool(propose, { choices: [c("cw.fema_declarations_dr_2025q1", "state", "cw.utility_states", "state", "identity"), c("cw.seed_submissions_snapshot", "cik10", "cw.frames_Revenues_CY2025Q1", "cik", "identity"), c("cw.states", "code", "cw.utility_states", "state", "identity"), c("won.x", "a", "cw.states", "code", "identity")] }, ctx, d);
    expect(out.ok).toBe(true);
    expect(ctx.proposals.proposedBy).toBe("planner");
    // The cik pair without lpad10 is measurable now: it is the control (joinmap_cik_control).
    // D16: a pair no named statement measures is measured through match_rate under its generic key.
    expect(ctx.proposals.model.map((m) => m.route)).toEqual(["fema_state@CY2025Q1", "cik_control@CY2025Q1", "pair:cw.states.code~cw.utility_states.state|identity"]);
    expect(ctx.unmeasurable.get("k3")).toBeUndefined();
    expect(ctx.proposals.rejected).toHaveLength(1);
    expect(allowedTools(ctx, d).map((t) => t.name)).toContain("measure_key");
    // Not-tested depends on the answer (weather measured or not), so it waits for it.
    expect(allowedTools(ctx, d).map((t) => t.name)).not.toContain("not_tested");
    expect(completeInput(toolDef("measure_key")!, {}, ctx).key).toBe("k1");
  });

  it("refuses onboarding-only templates on the question path", async () => {
    const d = deps();
    await expect(questionPort(d.gateway).template("dq_run", { rule: "utility.sic" })).rejects.toThrow(/onboarding-only/u);
  });

  it("names the nine tools and keeps every description under 60 words", () => {
    expect(Object.keys(TOOL_CATALOG)).toEqual(["search_catalogue", "probe_source", "propose_keys", "measure_key", "register_source", "compile_usl", "answer", "not_tested", "finalize"]);
    for (const [name, e] of Object.entries(TOOL_CATALOG)) expect(e.description.split(/\s+/u).length, name).toBeLessThan(60);
  });

  it("validates a planner step that proposes keys", () => {
    const schema = plannerSchema(["propose_keys"]);
    const base = { thought: "Propose the cik key.", state: { focus: "Q1 2025 FEMA", hypotheses: [], evidence_ids: [], open_contradictions: [], checklist: Object.fromEntries(["sources_found", "shapes_probed", "keys_proposed", "keys_measured", "sources_registered", "usl_built", "dq_run", "answered", "not_tested_listed", "note_written"].map((k) => [k, false])), next: "" }, done: false };
    const ok = { ...base, action: { tool: "propose_keys", input: { choices: [{ left: { object: "cw.frames_Revenues_CY2025Q1", column: "cik" }, right: { object: "cw.seed_utilities", column: "cik" }, transform: "lpad10" }] } } };
    expect(validate(schema, ok)).toEqual([]);
    const bad = { ...base, action: { tool: "propose_keys", input: { choices: [{ left: { object: "cw.a", column: "x" }, right: { object: "cw.b", column: "y" }, transform: "substr(0,2)" }] } } };
    expect(validate(schema, bad)).toEqual(["$.action: matches no allowed shape"]);
  });
});

describe("D15 snapshot provenance", () => {
  it("reads the onboarding snapshot time the generator recorded in the manifest", () => {
    expect(snapshotTakenAt(manifest)).toMatch(/^2026-10-25T\d{2}:\d{2}:\d{2}\+0800$/u);
    expect(snapshotTakenAt({ sources: [] })).toBeNull();
  });
});
