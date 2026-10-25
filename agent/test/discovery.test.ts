// The host-run discovery tools (agent/src/tools/discovery.ts) over a fake gateway port; expected values come
// from agent/test/fixtures/make_discovery_fixtures.py (section "tools"), computed independently in Python.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { baselineProposals, type ProbeSummary } from "../src/tools/baselineKeys.ts";
import {
  answer,
  compileUsl,
  DiscoveryRefusal,
  measureKey,
  notTested,
  NOT_TESTED_WEATHER,
  parseDistinct,
  probeSource,
  proposeKeys,
  registeredObjects,
  registerSource,
  registrationsNeeded,
  scoreProposals,
  searchCatalogueTool,
  toProposal,
  type MeasureResult,
  type RegistrarReply,
  type TemplatePort,
  type TemplateReply,
} from "../src/tools/discovery.ts";
import { renderCompileUsl, validatePlan } from "../src/tools/uslPlan.ts";

const fx = JSON.parse(readFileSync(new URL("./fixtures/crosswalk-discovery.json", import.meta.url), "utf8"));
const T = fx.tools;
const repo = new URL("../../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("zetaris/manifest.json", repo), "utf8"));
const catalogue = JSON.parse(readFileSync(new URL("seeds/catalogue.json", repo), "utf8"));
const RUN = "r-test";

type Reply = { columns: string[]; rows: unknown[][] };
function port(resolve: (id: string, params: Record<string, string>) => Reply | Error): TemplatePort & { calls: { id: string; params: Record<string, string> }[] } {
  const calls: { id: string; params: Record<string, string> }[] = [];
  return {
    calls,
    async template(id: string, params: Record<string, string> = {}): Promise<TemplateReply> {
      calls.push({ id, params });
      const r = resolve(id, params);
      if (r instanceof Error) throw r;
      return { ...r, row_count: r.rows.length, elapsed_ms: 11, sql: `SELECT /* ${id} */ ${JSON.stringify(params)}`, executed_at: "2026-10-25T12:00:00+08:00", cache_state: "hit" };
    },
  };
}

describe("registered objects and the governed plan", () => {
  it("expands the manifest's views and frames pattern (the manifest copy the fixture was generated from)", () => {
    expect([...registeredObjects(fx.search.inputs.manifest)].sort()).toEqual(T.registered_objects);
    expect(registeredObjects(manifest)).toEqual(expect.arrayContaining(["cw.seed_utilities", "cw.frames_Revenues_CY2025Q1", "cw.stations"]));
  });
  it("seeds/usl-plan.json renders the COMPILE statement of 07_cw_usl_create.sql exactly", () => {
    const plan = validatePlan(JSON.parse(readFileSync(new URL("seeds/usl-plan.json", repo), "utf8")));
    expect(plan.tables).toHaveLength(T.governed.tables);
    expect(plan.fks).toHaveLength(T.governed.fks);
    expect(renderCompileUsl(plan)).toBe(T.governed.compile_sql);
  });
});

describe("measure_key", () => {
  for (const c of T.measure) {
    it(c.name, async () => {
      const g = port((id) => {
        if (id.endsWith("_orphans")) return c.replies.orphans ?? new Error(`unexpected orphan call ${id}`);
        return c.replies.counts ?? new Error(`unexpected call ${id}`);
      });
      const m = await measureKey(toProposal(c.proposal), { gateway: g, runId: RUN, knownTemplates: new Set(c.known_templates) });
      expect(m.status).toBe(c.expected.status);
      expect(m.route).toBe(c.expected.route);
      expect(m.key).toBe(c.expected.key);
      expect(m.proposal_sql).toMatch(/^SELECT COUNT\(DISTINCT l\.k\)/u);
      if (c.expected.status === "unmeasurable") {
        expect(g.calls).toHaveLength(0);
        expect(m.reason).toMatch(/no gateway join-map statement/u);
        return;
      }
      for (const k of ["left_rows", "matched_rows", "left_keys", "matched_keys", "verdict", "orphans", "extra"]) expect((m as unknown as Record<string, unknown>)[k]).toEqual(c.expected[k]);
      expect(m.rate).toBeCloseTo(c.expected.rate, 12);
      expect(m.rate_distinct).toBeCloseTo(c.expected.rate_distinct, 12);
      expect(m.sql).toContain(g.calls[0]!.id);
      expect(m.provenance.every((p) => p.run_id === RUN && p.sql.length > 0)).toBe(true);
      expect(m.provenance).toHaveLength(c.replies.orphans ? 2 : 1);
    });
  }
  it("refuses a won object before any call", async () => {
    const g = port(() => new Error("no call expected"));
    await expect(measureKey({ leftObject: "won.seed_utilities", leftColumn: "cik", rightObject: "cw.sic_codes", rightColumn: "code", transform: "identity" }, { gateway: g, runId: RUN })).rejects.toThrow(/refused/u);
  });
});

describe("compile_usl", () => {
  const governed = JSON.parse(readFileSync(new URL("seeds/usl-plan.json", repo), "utf8"));
  for (const c of T.compile) {
    it(c.name, async () => {
      let dqFile: string | null = null;
      if (c.onboarding) {
        dqFile = join(mkdtempSync(join(tmpdir(), "cw-dq-")), "latest.json");
        writeFileSync(dqFile, JSON.stringify(c.onboarding));
      }
      const g = port((id, params) => (id === "dq_run" ? c.live[params.rule!] ?? new Error(`no rule ${params.rule}`) : new Error(`unexpected ${id}`)));
      const measured: MeasureResult[] = c.verified_routes.map((route: string) => ({ status: "measured", route, verdict: "VERIFIED" }) as unknown as MeasureResult);
      const r = await compileUsl({ governed, measured, gateway: g, runId: RUN, dqFile });
      expect(r.status).toBe(c.expected.status);
      expect(r.matches_governed).toBe(c.expected.matches_governed);
      expect(r.usl).toBe(c.expected.usl);
      expect(r.diff.missing_fks).toEqual(c.expected.missing_fks);
      expect((r.ddl.match(/FOREIGN KEY REFERENCES/gu) ?? []).length).toBe(c.expected.fks_in_ddl);
      expect(g.calls.map((x) => x.params.rule)).toEqual(["fema_declaration.state", "utility_state.state"]);
      expect(r.live_rules_run.map((x) => x.total)).toEqual(Object.values(c.live).map((v) => (v as Reply).rows[0]![0]));
      if (r.matches_governed) expect(r.ddl).toBe(T.governed.compile_sql);
      else expect(r.ddl.startsWith("COMPILE USL IF NOT EXISTS crosswalk_usl_v2 ")).toBe(true);
      expect(r.compiled).toBe(false);
      if (c.onboarding) {
        expect(r.dq?.rules.find((x) => x.rule === "utility.sic")?.invalid).toBe(1);
        expect(r.invalid_rows).toHaveLength(1);
      } else {
        expect(r.dq).toBeNull();
      }
    });
  }
});

describe("answer and not_tested", () => {
  const A = T.answer;
  const replies = (id: string, params: Record<string, string>): Reply | Error => {
    if (id === "answer_fema_utilities") return A.replies.fema;
    if (id === "answer_revenue") return params.period === "CY2025Q1" ? A.replies.revenue_current : A.replies.revenue_previous;
    if (id === "weather_quarter") return params.year === "2025" ? A.replies.weather_current : A.replies.weather_previous;
    return new Error(`unexpected ${id}`);
  };
  it("assembles the table with per-cell provenance", async () => {
    const g = port(replies);
    const r = await answer({ quarter: A.quarter }, { gateway: g, runId: RUN, stationsByCik: A.stations_by_cik });
    expect(r.rows.map((x) => x.cik)).toEqual(A.expected_order);
    expect(r.weather_status).toBe("measured");
    expect(g.calls.find((c) => c.id === "answer_revenue")!.params.cik_list).toBe(A.expected_order.join(","));
    expect(g.calls.filter((c) => c.id === "weather_quarter").map((c) => c.params)).toEqual([
      { year: "2025", quarter: "1", station_list: "USW00099001,USW00099002,USW00099003" },
      { year: "2024", quarter: "1", station_list: "USW00099001,USW00099002,USW00099003" },
    ]);
    r.rows.forEach((row, i) => {
      const e = A.expected[i];
      expect({ name: row.name, ticker: row.ticker, states: row.states, declarations: row.declarations, by_incident_type: row.by_incident_type }).toEqual({ name: e.name, ticker: e.ticker, states: e.states, declarations: e.declarations, by_incident_type: e.by_incident_type });
      if (e.revenue === null) expect(row.revenue).toBeNull();
      else {
        expect({ ...row.revenue!, change: null }).toEqual({ ...e.revenue, change: null });
        if (e.revenue.change === null) expect(row.revenue!.change).toBeNull();
        else expect(row.revenue!.change).toBeCloseTo(e.revenue.change, 12);
      }
      if (e.weather === null) expect(row.weather).toBeNull();
      else {
        expect(row.weather!.stations).toEqual(e.weather.stations);
        expect(row.weather!.tdd_current).toBeCloseTo(e.weather.tdd_current, 9);
        expect(row.weather!.change).toBeCloseTo(e.weather.change, 12);
        expect(row.provenance.weather).toHaveLength(2);
      }
      expect(row.provenance.declarations.template).toBe("answer_fema_utilities");
      expect(row.provenance.declarations.run_id).toBe(RUN);
      if (row.revenue) expect(row.provenance.revenue_current?.params.period).toBe("CY2025Q1");
    });
  });
  it("without stations the weather column is not tested and listed", async () => {
    const g = port(replies);
    const r = await answer({ quarter: A.quarter }, { gateway: g, runId: RUN });
    expect(r.weather_status).toBe("not_tested");
    expect(g.calls.some((c) => c.id === "weather_quarter")).toBe(false);
    expect(notTested({ weather: false })).toContain(NOT_TESTED_WEATHER);
    expect(notTested({ weather: true })).not.toContain(NOT_TESTED_WEATHER);
    expect(notTested({ weather: true }).map((x) => x.split(":")[0])).toEqual(["County geography", "Non-major declarations", "Fuel-cost pass-through", "Recasts"]);
  });
  it("refuses a malformed quarter", async () => {
    await expect(answer({ quarter: "2025Q1" }, { gateway: port(replies), runId: RUN })).rejects.toThrow(DiscoveryRefusal);
  });
});

describe("register_source", () => {
  const reg = (reply: Partial<RegistrarReply>) => {
    const calls: { action: string; params: Record<string, string> }[] = [];
    return {
      calls,
      async register(action: string, params: Record<string, string>): Promise<RegistrarReply> {
        calls.push({ action, params });
        return { action, params, contract_id: "c-test", steps: [{ template_id: "registrar_fema_describe", sql: "DESCRIBE cw.fema_declarations_dr_2025q1", elapsed_ms: 40 }], wall_ms: 120, ...reply };
      },
    };
  };
  it("needs per question quarter", () => {
    const registered = new Set<string>(T.registered_objects);
    for (const c of T.registrations) expect(registrationsNeeded(c.quarter, registered)).toEqual(c.expected);
  });
  it("already_registered through the registrar under a register_source contract", async () => {
    const r = reg({ already_registered: true });
    const out = await registerSource("openfema_disaster_declarations", { quarter: "CY2025Q1" }, { registrar: r, catalogue, runId: RUN });
    expect(r.calls).toEqual([{ action: "register_source", params: { catalogue_id: "openfema_disaster_declarations", quarter: "CY2025Q1" } }]);
    expect(out).toMatchObject({ status: "already_registered", object: "cw.fema_declarations_dr_2025q1", plan: "register_fema", contract_id: "c-test", elapsed_ms: 120, rows: null });
  });
  it("registered, with the row count read back", async () => {
    const r = reg({ already_registered: false });
    const g = port((id) => (id === "fema_by_state" ? { columns: ["state", "designated_areas", "declarations"], rows: [["CA", 3, 1], ["KY", 9, 2]] } : new Error(id)));
    const out = await registerSource("openfema_disaster_declarations", { quarter: "CY2024Q1" }, { registrar: r, catalogue, gateway: g, runId: RUN });
    expect(out.status).toBe("registered");
    expect(out.object).toBe("cw.fema_declarations_dr_2024q1");
    expect(out.rows).toBe(12);
    expect(out.provenance.map((p) => p.template)).toEqual(["registrar_fema_describe", "fema_by_state"]);
  });
  it("refuses known_to_fail, unknown, unregistrable and malformed requests before any contract", async () => {
    const r = reg({});
    const cases: [string, Record<string, string>, string][] = [
      ["pudl", {}, "known_to_fail"],
      ["nope", {}, "unknown_source"],
      ["crosswalk_usl", {}, "not_registrable"],
      ["openfema_disaster_declarations", { quarter: "2025Q1" }, "bad_params"],
      ["sec_frames", { tag: "Revenues" }, "bad_params"],
    ];
    for (const [id, params, code] of cases) {
      await expect(registerSource(id, params, { registrar: r, catalogue, runId: RUN })).rejects.toMatchObject({ code });
    }
    expect(r.calls).toHaveLength(0);
  });
});

describe("probe_source, propose_keys, scoring", () => {
  const allowed = new Set(registeredObjects(manifest));
  it("describes, samples and counts up to three candidate columns (lower-case object names)", async () => {
    const g = port((id, params) => {
      if (id === "describe_object") return { columns: ["col_name", "data_type", "comment"], rows: [["cik", "bigint", null], ["entityName", "string", null], ["loc", "string", null], ["val", "double", null], ["", "", null], ["# Partition", "", null]] };
      if (id === "sample_rows") return { columns: ["cik", "entityName", "loc", "val"], rows: [[1234567, "A", "US-CA", 1.5], [7654321, "B", "US-OH", 2], [111, "C", null, 3]] };
      if (id === "distinct_counts") return { columns: ["row_count", "distinct_values", "non_null", "non_null_share"], rows: [[1900, params.column === "cik" ? 1900 : 55, 1899, 0.9995]] };
      return new Error(id);
    });
    const p = await probeSource("cw.frames_Revenues_CY2025Q1", { gateway: g, allowed, runId: RUN });
    expect(g.calls.map((c) => c.params.object)).toEqual(Array(4).fill("cw.frames_revenues_cy2025q1"));
    expect(p.columns.map((c) => c.name)).toEqual(["cik", "entityName", "loc", "val"]);
    expect(p.candidates).toEqual([
      { column: "cik", rows: 1900, distinct: 1900, non_null: 1899, samples: ["1234567", "7654321", "111"] },
      { column: "loc", rows: 1900, distinct: 55, non_null: 1899, samples: ["US-CA", "US-OH"] },
    ]);
    expect(p.provenance).toHaveLength(4);
  });
  it("refuses won, clearshelf and unlisted objects", async () => {
    const g = port(() => new Error("no call expected"));
    for (const o of ["won.seed_utilities", "cw.clearshelf_x", "cw.not_in_manifest", "CW_SEC.frames_x"]) {
      await expect(probeSource(o, { gateway: g, allowed: new Set([...allowed, "cw.clearshelf_x"]), runId: RUN })).rejects.toBeInstanceOf(DiscoveryRefusal);
    }
    expect(g.calls).toHaveLength(0);
  });
  it("parses positional distinct counts", () => {
    expect(parseDistinct({ columns: ["a", "b", "c"], rows: [[10, 4, 9]] })).toEqual({ rows: 10, distinct: 4, non_null: 9 });
  });
  it("validates the planner's choices", () => {
    const probed = new Set(["cw.seed_utilities", "cw.frames_Revenues_CY2025Q1", "cw.sic_codes", "cw.utility_states"]);
    const c = (lo: string, lc: string, ro: string, rc: string, t: string) => ({ left: { object: lo, column: lc }, right: { object: ro, column: rc }, transform: t });
    const out = proposeKeys(
      [
        c("cw.frames_Revenues_CY2025Q1", "cik", "cw.seed_utilities", "cik", "lpad10"),
        c("cw.seed_utilities", "cik", "cw.frames_Revenues_CY2025Q1", "cik", "lpad10"),
        c("cw.seed_utilities", "sic", "cw.sic_codes", "code", "substr(1,04)"),
        c("cw.seed_utilities", "sic", "cw.stations", "id", "identity"),
        c("won.seed_utilities", "cik", "cw.seed_utilities", "cik", "identity"),
        c("cw.utility_states", "cik", "cw.seed_utilities", "cik", "identity"),
        c("cw.seed_utilities", "sic", "cw.sic_codes", "code", "identity"),
      ],
      { probed },
    );
    expect(out.accepted.map((a) => a.route)).toEqual(["cik@CY2025Q1", null]);
    expect(out.rejected.map((r) => r.error)).toEqual([
      "duplicate of an earlier choice",
      "invalid transform: substr(1,04)",
      "object not probed in this run: cw.stations",
      "refused object: won.seed_utilities",
      "more than 6 choices",
    ]);
    expect(proposeKeys("x", { probed }).rejected[0]!.error).toBe("choices must be an array");
  });
  it("scores the baseline's choices against the measured join map (L2)", () => {
    const demo = fx.baseline.cases.find((x: { name: string }) => x.name === "demo_shape_limit_6");
    const choices = baselineProposals(demo.probes as ProbeSummary[], 6);
    const measured = new Map<string, MeasureResult>();
    for (const [key, route, verdict] of [["cik@CY2025Q1", "cik", "VERIFIED"], ["station@all", "station", "VERIFIED"], ["sic@all", "sic", "VERIFIED"], ["loc@CY2025Q1", "loc", "VERIFIED"]] as const) {
      measured.set(key, { key, route, verdict, status: "measured" } as unknown as MeasureResult);
    }
    expect(scoreProposals(choices, measured)).toEqual({ proposals: 6, routed: 4, measured: 4, verified: 4, partial: 0, rejected: 0, unmeasured: 2, keys: ["cik@CY2025Q1", "station@all", "sic@all", "loc@CY2025Q1"] });
  });
});

describe("search_catalogue", () => {
  const inputs = { catalogue, manifest, gettingStarted: fx.search.inputs.getting_started };
  it("adds the live OpenFEMA catalogue rows and fills licences", async () => {
    const g = port((id) => (id === "catalogue_list" ? { columns: ["name", "version", "title", "api_endpoint", "last_dataset_refresh"], rows: fx.search.inputs.fema_catalogue_rows.map((r: Record<string, unknown>) => [r.name, r.version, r.title, r.api_endpoint, r.last_dataset_refresh]) } : new Error(id)));
    const r = await searchCatalogueTool("FEMA major disaster declarations by state", inputs, { gateway: g, runId: RUN });
    expect(r.sources.fema_catalogue).toBe(4);
    expect(r.sources.getting_started).toBe(3);
    expect(r.hits.some((h) => h.id === "openfema:DisasterDeclarationsSummaries@v2" && h.licence.startsWith("OpenFEMA"))).toBe(true);
    expect(r.hits.find((h) => h.id === "cw_fema:cw.fema_declarations_dr_2025q1")!.licence).toMatch(/^OpenFEMA/u);
    expect(r.provenance.map((p) => p.template)).toEqual(["catalogue_list"]);
  });
  it("still answers from the files when the gateway is down, and flags known_to_fail", async () => {
    const g = port(() => new Error("gateway HTTP 503"));
    const r = await searchCatalogueTool("electric utility data PUDL", inputs, { gateway: g, runId: RUN });
    expect(r.fema_catalogue_error).toMatch(/503/u);
    expect(r.sources.fema_catalogue).toBeNull();
    expect(r.hits.filter((h) => h.negative).map((h) => h.id)).toEqual(["gs:pudl", "pudl"]);
  });
});
