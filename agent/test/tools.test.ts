// The tool chain against a mocked gateway: a deterministic run (no model, every step is the
// fallback) must complete the checklist, record evidence with every required field, build the
// peer set and the attribution, record the recast conflicts, remember the tag for a warm run,
// and ingest a World Model that a second run does not change.
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EvidenceStore, missingFields } from "../src/evidence/store.ts";
import { investigate, type RunResult } from "../src/loop/investigate.ts";
import { memoMaterial, newQuestionContext, NOT_TESTED, runTool, toolDef, type ToolDeps } from "../src/loop/tools.ts";
import { HMEM } from "../src/memory/hmemFacade.ts";
import { unknownNumbers } from "../src/llm/memo.ts";
import { attribute } from "../src/tools/attribution.ts";
import { WeatherWorld } from "../src/world/world.ts";
import { fakeGateway, type FakeGateway } from "./helpers/fakeGateway.ts";
import { EXPECTED_PEERS, PERIOD, syntheticResolver, syntheticSeeds, TARGET, TARGET_DW, TARGET_FACTS } from "./helpers/syntheticQuestion.ts";

let clockMs = 1_700_000_000_000;
const clock = () => (clockMs += 1000);

function dqFile(invalid: Record<string, unknown>[] = []): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cw-dq-"));
  const file = path.join(dir, "latest.json");
  writeFileSync(
    file,
    JSON.stringify({
      ran_at: "2026-10-24T19:31:39+0800",
      rule: "coverage_ok",
      table: "lightning.metastore.crosswalk.crosswalk_usl.weather_quarter",
      elapsed_s: 739.3,
      ok: true,
      run: { total: 342, valid: 342 - invalid.length, invalid: invalid.length },
      invalid_rows: invalid,
      statements: [
        { template_id: "dq_run_coverage", sql: "RUN DQ coverage_ok TABLE t", sql_sha256: "a1", started_at: "2026-10-24T19:31:39+0800", elapsed_s: 557.2, columns: ["name"], rows: [["coverage_ok"]], row_count: 1, error: null },
        { template_id: "dq_invalid", sql: "SHOW DQ INVALID RECORD coverage_ok TABLE t", sql_sha256: "b2", started_at: "2026-10-24T19:40:57+0800", elapsed_s: 181.7, columns: ["station_id"], rows: invalid.map((r) => [r.station_id]), row_count: invalid.length, error: null },
      ],
    }),
  );
  return file;
}

interface Harness {
  gw: FakeGateway;
  deps: ToolDeps;
  hmem: HMEM;
  world: WeatherWorld;
}

function harness(opts: { registrar?: boolean; missingFrames?: Set<string>; missingConcept?: boolean; dq?: string | null; hmem?: HMEM; world?: WeatherWorld } = {}): Harness {
  const seeds = syntheticSeeds();
  const gw = fakeGateway(syntheticResolver(seeds, { missingFrames: opts.missingFrames, missingConcept: opts.missingConcept }));
  const hmem = opts.hmem ?? new HMEM({ actor: "cw-agent", clock });
  const world = opts.world ?? new WeatherWorld({ directory: null, clock: () => new Date(clock()) });
  const deps: ToolDeps = {
    gateway: gw.client,
    ollama: null,
    evidence: new EvidenceStore(`r${Math.random().toString(36).slice(2, 8)}`, null),
    seeds,
    hmem,
    world,
    dqFile: opts.dq === null ? path.join(os.tmpdir(), "cw-no-such-dq.json") : (opts.dq ?? dqFile()),
    ...(opts.registrar
      ? {
          registrar: {
            register: async (action: string, params: Record<string, string>) => {
              gw.registered.add(`${action}:${JSON.stringify(params)}`);
              return { action, params, contract_id: "c-test", steps: [{ template_id: `registrar_${action}_table`, kind: "register", sql: "CREATE x", sql_sha256: "s", objects: [], elapsed_ms: 3 }], skipped: [], http_status: 200, wall_ms: 9 };
            },
          },
        }
      : {}),
  };
  return { gw, deps, hmem, world };
}

async function run(h: Harness): Promise<RunResult> {
  return investigate({ cik: TARGET, period: PERIOD, claim: "colder weather", historyDir: null }, h.deps);
}

describe("the tool chain on the synthetic question (no model: every step is the deterministic fallback)", () => {
  it("completes the checklist with the expected peers, growth, weather, attribution and verdict", async () => {
    const h = harness();
    const r = await run(h);
    expect(r.checklist_complete).toBe(true);
    expect(r.markovian.status).toBe("completed");
    expect(r.timeline.map((t) => t.tool)).toEqual(["resolve_utility", "probe_revenue_tag", "get_revenue", "get_peers", "get_weather", "dq_gate", "attribute", "not_tested", "finalize"]);
    expect(r.timeline.every((t) => t.source === "fallback" && t.ok)).toBe(true);
    expect(r.markovian.chunks).toBe(5);
    const c = r.card;
    expect(c.utility?.name).toBe("Target Electric Corp");
    expect(c.growth).toMatchObject({ tag: "Revenues", rev_current: TARGET_FACTS.current.val, rev_previous: TARGET_FACTS.prevComparative.val, current_accn: TARGET_FACTS.current.accn, recast: true });
    expect(c.growth!.g).toBeCloseTo((TARGET_FACTS.current.val - TARGET_FACTS.prevComparative.val) / TARGET_FACTS.prevComparative.val, 12);
    expect(c.peers!.count).toBe(EXPECTED_PEERS.length);
    expect(c.peers!.list.map((p) => p.cik).sort()).toEqual([...EXPECTED_PEERS].sort());
    expect(c.peers!.by_tag).toEqual({ Revenues: 5, RevenueFromContractWithCustomerExcludingAssessedTax: 1, RegulatedAndUnregulatedOperatingRevenue: 1 });
    const reasons = c.peers!.excluded.map((x) => x.reason).join("\n");
    expect(reasons).toMatch(/Gas Nine: excluded: SIC 4900/u);
    expect(reasons).toMatch(/Peer Ten No Current: excluded: current period missing \(no fact under any of the three tags\)/u);
    expect(reasons).toMatch(/Peer Eleven No Previous: excluded: previous period missing \(tag Revenues\)/u);
    expect(reasons).toMatch(/Peer Twelve Outlier: excluded: \|g\| >= 60%/u);
    expect(c.weather!.delta_w).toBeCloseTo(TARGET_DW, 9);
    expect(c.weather!.coverage).toBe(1);
    expect(c.weather!.stations_used).toEqual(["USW00000001", "USW00000002"]);
    // Two weather_quarter calls, one per quarter, each with the union of target and peer stations.
    const wq = h.gw.calls.filter((x) => x.template_id === "weather_quarter");
    expect(wq.map((x) => x.params.year)).toEqual(["2025", "2024"]);
    expect(wq[0]!.params.station_list!.split(",")).toHaveLength(2 + EXPECTED_PEERS.length);
    // The attribution equals the deterministic module on the same inputs.
    const peers = c.peers!.list.map((p) => ({ cik: p.cik, g: p.g, dw: p.dw! }));
    const expected = attribute({ cik: TARGET, g: c.growth!.g, dw: c.weather!.delta_w, coverage: 1 }, peers, { resamples: 300, seed: 7 });
    expect(c.attribution!.beta).toBeCloseTo(expected.beta, 12);
    expect(c.attribution!.weather).toBeCloseTo(expected.weather, 12);
    expect(c.attribution!.ranges).toEqual(expected.ranges);
    expect(c.attribution!.peers).toBe(7);
    expect(c.verdict!.verdict).toBe(expected.claim.verdict);
    expect(c.verdict!.confidence).toBe(expected.confidence);
    expect(c.dq!.label).toBe("pass");
    expect(c.dq!.basis).toBe("onboarding+coverage");
    expect(c.not_tested).toEqual(NOT_TESTED);
    expect(c.memo!.source).toBe("template");
    expect(c.memo!.attempts).toBe(0);
    expect(r.telemetry.cloud_model_calls).toBe(0);
    expect(r.summary.planner_calls).toBe(0);
  });

  it("records every number the memo may use and the template memo uses only those", async () => {
    const h = harness();
    const r2 = await run(h);
    expect(r2.card.memo!.text.length).toBeGreaterThan(100);
    const allowed = (r2.evidence.find((e) => e.details?.tool === "memo")!.details!.allowed as { text: string }[]).map((a) => a.text);
    expect(unknownNumbers(r2.card.memo!.text, allowed.map((text) => ({ label: "", text })))).toEqual([]);
    expect(allowed).toContain("1,150.0");
    expect(allowed).toContain("980.0");
    expect(allowed).toContain("7");
  });

  it("records the recast comparative and the own-period restatement as conflicts resolved by R1, with both values in memory", async () => {
    const h = harness();
    const r = await run(h);
    expect(r.card.recast_conflicts).toHaveLength(2);
    const prev = r.card.recast_conflicts.find((c) => c.scope === "previous_period")!;
    expect(prev).toMatchObject({ period: "CY2024Q1", chosen: "later_filing", chosen_val: TARGET_FACTS.prevComparative.val, status: "resolved_by_rule" });
    expect(prev.own_filing.accn).toBe(TARGET_FACTS.prevOriginal.accn);
    expect(prev.later_filing.accn).toBe(TARGET_FACTS.prevComparative.accn);
    const cur = r.card.recast_conflicts.find((c) => c.scope === "current_period")!;
    expect(cur).toMatchObject({ period: PERIOD, chosen: "own_filing", chosen_val: TARGET_FACTS.current.val });
    expect(cur.later_filing.val).toBe(TARGET_FACTS.currentLater.val);
    expect(h.hmem.store.get(prev.own_filing_memory)!.supersededBy).toBe(prev.later_filing_memory);
    expect(h.hmem.store.get(cur.later_filing_memory)!.supersededBy).toBe(cur.own_filing_memory);
    expect(h.hmem.why(prev.own_filing_memory).provenance?.accn).toBe(TARGET_FACTS.prevOriginal.accn);
    expect(r.card.growth!.rev_current).toBe(TARGET_FACTS.current.val);
    // The World Model holds the recasts edges.
    expect(h.world.exportGraph().edgeTypes.recasts).toBe(2);
  });

  it("writes evidence with every required field and a Zetaris record per gateway call", async () => {
    const h = harness();
    const r = await run(h);
    expect(r.quality.e_complete).toBe(1);
    expect(r.quality.e_cov).toBe(1);
    for (const e of r.evidence) expect(missingFields(e), e.id).toEqual([]);
    const sql = r.evidence.filter((e) => e.kind === "zetaris_sql");
    expect(sql.length).toBe(h.gw.calls.length);
    for (const e of sql) {
      expect(e.sql_sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(e.params).toBeDefined();
      expect(e.elapsed_ms).toBeGreaterThan(0);
      expect(e.cache_state).toBe("hit");
      expect(e.licence).toBeTruthy();
    }
    expect(r.evidence.filter((e) => e.kind === "dq")).toHaveLength(2);
    expect(r.evidence.filter((e) => e.kind === "dq").every((e) => e.reused)).toBe(true);
  });

  it("remembers the tag so a second run skips the probe step and re-ingests the World Model without a new event", async () => {
    const h = harness();
    const r1 = await run(h);
    expect(r1.skipped_steps).toEqual([]);
    expect(h.gw.calls.filter((x) => x.template_id === "frames_fact")).toHaveLength(1);
    const events = h.world.eventCount();
    const h2 = harness({ hmem: h.hmem, world: h.world });
    const r2 = await run(h2);
    expect(r2.skipped_steps).toHaveLength(1);
    expect(r2.skipped_steps[0]).toMatchObject({ item: "tag_chosen" });
    expect(r2.timeline.map((t) => t.tool)).toEqual(["resolve_utility", "get_revenue", "get_peers", "get_weather", "dq_gate", "attribute", "not_tested", "finalize"]);
    expect(r2.markovian.chunks).toBe(4);
    expect(h2.gw.calls.filter((x) => x.template_id === "frames_fact")).toHaveLength(0);
    expect(r2.evidence.filter((e) => e.kind === "memory")).toHaveLength(1);
    expect(h.world.eventCount()).toBe(events);
    expect(r2.card.recast_conflicts).toHaveLength(2);
    expect(h.hmem.recasts.all()).toHaveLength(2);
    expect(r2.memory!.conflicts).toBe(2);
  });

  it("get_revenue honours an analyst override: the overridden conflict's chosen_val replaces R1's value and growth is recomputed (D4)", async () => {
    const h = harness();
    const r1 = await run(h);
    const cur = r1.card.recast_conflicts.find((c) => c.scope === "current_period")!;
    expect(r1.card.growth!.rev_current).toBe(TARGET_FACTS.current.val);
    h.hmem.recasts.override(cur.id, { chosen: "later_filing", reason: "the later filing corrected a booking error", by: "analyst", contractId: "c-test-override" });
    const h2 = harness({ hmem: h.hmem, world: h.world });
    const r2 = await run(h2);
    const g = r2.card.growth!;
    expect(g.rev_current).toBe(TARGET_FACTS.currentLater.val);
    expect(g.rev_previous).toBe(TARGET_FACTS.prevComparative.val);
    expect(g.g).toBeCloseTo((TARGET_FACTS.currentLater.val - TARGET_FACTS.prevComparative.val) / TARGET_FACTS.prevComparative.val, 12);
    const conflict = r2.card.recast_conflicts.find((c) => c.id === cur.id)!;
    expect(conflict).toMatchObject({ status: "overridden", chosen: "later_filing", chosen_val: TARGET_FACTS.currentLater.val });
    expect(conflict.override).toMatchObject({ by: "analyst", contract_id: "c-test-override" });
    const ov = r2.evidence.find((e) => e.details?.tool === "override_recast")!;
    expect(ov.claim).toContain(cur.id);
    expect(ov.claim).toContain("c-test-override");
    expect(ov.details).toMatchObject({ conflict_id: cur.id, chosen: "later_filing", chosen_val: TARGET_FACTS.currentLater.val, growth_rule_r1: r1.card.growth!.g, growth_overridden: g.g });
    expect(r2.card.claims.some((c) => c.evidenceIds.includes(ov.id))).toBe(true);
    // The attribution and the memo material follow the overridden growth.
    expect(r2.evidence.find((e) => e.details?.tool === "attribution")!.claim).toContain(`of g ${((g.g >= 0 ? "+" : "") + (g.g * 100).toFixed(1))}%`);
    const memoDetails = r2.evidence.find((e) => e.details?.tool === "memo")!.details!;
    const allowed = (memoDetails.allowed as { text: string }[]).map((a) => a.text);
    expect(allowed).toContain("1,149.0");
    // The conflict finding names R1's value and the analyst's value, not the overridden value twice.
    expect((memoDetails.findings as string[]).find((f) => f.includes("overridden by the analyst"))).toContain("rule R1 keeps 1,150.0 million, overridden by the analyst to 1,149.0 million");
    // The previous-period conflict was not overridden and still follows R1.
    expect(r2.card.recast_conflicts.find((c) => c.scope === "previous_period")!.status).toBe("resolved_by_rule");
    expect(h.hmem.recasts.all()).toHaveLength(2);
  });

  it("withholds the verdict when an invalid coverage row names one of the utility's stations", async () => {
    const h = harness({ dq: dqFile([{ station_id: "USW00000002", year: 2024, quarter: 1, coverage: 0.85 }]) });
    const r = await run(h);
    expect(r.card.dq!.label).toBe("withheld");
    expect(r.card.dq!.invalidForTarget).toHaveLength(1);
    expect(r.card.verdict!.verdict).toBe("withheld");
    expect(r.card.verdict!.withheld_reason).toMatch(/DQ gate/u);
    expect(r.card.attribution).not.toBeNull();
    expect(r.checklist_complete).toBe(true);
  });

  it("passes on the coverage column alone when the onboarding file is missing, and says so", async () => {
    const h = harness({ dq: null });
    const r = await run(h);
    expect(r.card.dq!.label).toBe("pass");
    expect(r.card.dq!.basis).toBe("coverage only");
    expect(r.card.gaps.join("\n")).toMatch(/no DQ onboarding result/u);
    expect(r.evidence.filter((e) => e.kind === "dq")).toHaveLength(0);
  });

  it("registers a missing frames period through the registrar, then probes again", async () => {
    const h = harness({ registrar: true, missingFrames: new Set(["Revenues|CY2025Q1"]) });
    // The fake resolver keeps reporting the period missing, so the chain registers it once, then the probe falls through to the next tags.
    const r = await run(h);
    const tools = r.timeline.map((t) => t.tool);
    expect(tools.slice(0, 3)).toEqual(["resolve_utility", "probe_revenue_tag", "register_frames"]);
    expect(r.evidence.some((e) => e.kind === "registrar" && e.claim.includes("register_frames"))).toBe(true);
    expect(h.gw.registered.has('register_frames:{"tag":"Revenues","period":"CY2025Q1"}')).toBe(true);
  });

  it("without a registrar, a missing frames period ends the tag probe as failed and the card says why", async () => {
    const h = harness({ missingFrames: new Set(["Revenues|CY2025Q1", "RevenueFromContractWithCustomerExcludingAssessedTax|CY2025Q1", "RegulatedAndUnregulatedOperatingRevenue|CY2025Q1"]) });
    const r = await run(h);
    expect(r.checklist.find((i) => i.id === "tag_chosen")!.status).toBe("failed");
    expect(r.checklist.find((i) => i.id === "revenue_like_for_like")!.status).toBe("na");
    expect(r.card.verdict!.verdict).toBe("withheld");
    expect(r.card.memo).not.toBeNull();
    expect(r.checklist_complete).toBe(true);
  });

  it("registers a missing companyconcept view inside get_revenue when a registrar is wired", async () => {
    const h = harness({ registrar: true });
    const ctx = newQuestionContext(TARGET, PERIOD, "x", h.deps.evidence);
    await runTool(toolDef("resolve_utility")!, {}, ctx, h.deps);
    await runTool(toolDef("probe_revenue_tag")!, {}, ctx, h.deps);
    // Switch the gateway to a resolver that reports the concept view missing on the first read only.
    let first = true;
    const seeds = syntheticSeeds();
    const base = syntheticResolver(seeds);
    const gw = fakeGateway((t, p) => {
      if (t === "concept_window" && first) {
        first = false;
        return { error: "TABLE_OR_VIEW_NOT_FOUND cw.concept", status: 502 };
      }
      return base(t, p);
    });
    const out = await runTool(toolDef("get_revenue")!, {}, ctx, { ...h.deps, gateway: gw.client });
    expect(out.ok).toBe(true);
    expect(ctx.registered.map((x) => x.action)).toEqual(["register_concept"]);
    expect(gw.calls.filter((c) => c.template_id === "concept_window").length).toBeGreaterThanOrEqual(2);
  });

  it("fails a step twice before giving up on it, and still finalizes", async () => {
    const seeds = syntheticSeeds();
    const base = syntheticResolver(seeds);
    const gw = fakeGateway((t, p) => (t === "weather_quarter" ? { error: "timeout: no result within 60 s", status: 504 } : base(t, p)));
    const h = harness();
    const r = await investigate({ cik: TARGET, period: PERIOD, claim: "x", historyDir: null }, { ...h.deps, gateway: gw.client });
    const weatherCalls = r.timeline.filter((t) => t.tool === "get_weather");
    expect(weatherCalls).toHaveLength(2);
    expect(weatherCalls.every((t) => !t.ok)).toBe(true);
    expect(r.checklist.find((i) => i.id === "weather_target")!.status).toBe("failed");
    expect(r.checklist.find((i) => i.id === "attribution_done")!.status).toBe("failed");
    expect(r.card.verdict!.verdict).toBe("withheld");
    expect(r.card.gaps.join("\n")).toMatch(/get_weather failed twice/u);
    expect(r.checklist_complete).toBe(true);
  });

  it("fills the gateway's object placeholders with the parameters in the evidence record", () => {
    const store = new EvidenceStore("rph", null);
    const res = {
      template_id: "weather_quarter",
      role: "reader" as const,
      columns: ["station_id"],
      rows: [["USW00000001"]],
      row_count: 1,
      truncated: false,
      elapsed_ms: 10,
      sql: "SELECT 1",
      sql_sha256: "s",
      objects: ["cw.ghcn_{year}_tmax", "cw.ghcn_{year}_tmin"],
      raw_objects: ["cw.ghcn_2025_tmax", "cw.ghcn_2025_tmin"],
      executed_at: "t",
      cache_state: "hit",
      cache_detail: {},
      source_cached_at: { "cw.ghcn_2025_tmax": "c" },
      error: null,
      params: { year: "2025", quarter: "1", station_list: "USW00000001" },
      http_status: 200,
      wall_ms: 12,
      warm_retries: 0,
    };
    const ev = store.fromTemplate(res, "x");
    expect(ev.zetaris_object).toBe("cw.ghcn_2025_tmax");
    expect(ev.zetaris_objects).toEqual(["cw.ghcn_2025_tmax", "cw.ghcn_2025_tmin"]);
    expect(ev.source_url).toContain("YEAR=2025/ELEMENT=TMAX");
    expect(ev.source_cached_at).toBe("c");
  });

  it("memoMaterial names the allowed numbers from the tool outputs", async () => {
    const h = harness();
    const ctx = newQuestionContext(TARGET, PERIOD, "colder weather", h.deps.evidence);
    for (const name of ["resolve_utility", "probe_revenue_tag", "get_revenue", "get_peers", "get_weather", "dq_gate", "attribute", "not_tested"] as const) await runTool(toolDef(name)!, {}, ctx, h.deps);
    const m = memoMaterial(ctx);
    const texts = m.allowed.map((a) => a.text);
    expect(texts).toContain("+17.3%");
    expect(texts).toContain("+18.0%");
    expect(texts).toContain("1.00");
    for (const f of m.findings) expect(unknownNumbers(f, m.allowed), f).toEqual([]);
  });
});
