// The answer gated on the join map (agent/src/tools/discovery.ts answerGate): the FEMA selection needs the
// FEMA FIPS key VERIFIED (the FEMA state codes join the state reference: form), the revenue column needs the CIK
// key VERIFIED, the weather column the station key VERIFIED (measured in this run or recalled). The FEMA state key
// against the states the seed utilities serve measures coverage: it is reported with its orphans, and withholds the
// FEMA selection (which joins on that state code) only when it was measured or recalled with 0 matched rows.
// The last two tests replay the committed redacted server fixtures (synthetic values) offline.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { replayAnswer, type SavedRunForGate } from "../src/eval/gateReplay.ts";
import { answer, answerGate, type MeasureResult, type TemplatePort, type TemplateReply } from "../src/tools/discovery.ts";

const RUN = "r-test";
const Q = "CY2025Q1";

function key(route: string, verdict: "VERIFIED" | "PARTIAL" | "REJECTED", matched: number, rows: number, fromMemory: string | null = null, orphans: string[] = [], quarter = Q): [string, MeasureResult] {
  const k = `${route}@${route === "station" ? "all" : quarter}`;
  return [k, { key: k, route, status: "measured", verdict, matched_rows: matched, left_rows: rows, orphans, from_memory: fromMemory } as unknown as MeasureResult];
}

const FEMA_REPLY = { columns: ["cik", "name", "ticker", "state", "declarations", "severe_storm"], rows: [["0000000001", "UTILITY ONE", "ONE", "OK", 1, 1]] };
const REV = (period: string) => ({ columns: ["cik", "xbrl_tag", "val", "accn"], rows: [["0000000001", "Revenues", period === Q ? 110 : 100, `0000000000-00-00000${period === Q ? 1 : 2}`]] });

function port(resolve: (id: string, params: Record<string, string>) => { columns: string[]; rows: unknown[][] }): TemplatePort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async template(id: string, params: Record<string, string> = {}): Promise<TemplateReply> {
      calls.push(id);
      const r = resolve(id, params);
      return { ...r, row_count: r.rows.length, elapsed_ms: 1, sql: `SELECT /* ${id} */ 1`, cache_state: "hit" } as TemplateReply;
    },
  };
}
const WX = (year: string) => ({ columns: ["station_id", "hdd", "cdd", "coverage"], rows: [["USW00099001", year === "2025" ? 1100 : 1000, 10, 1]] });
const fixturePort = () => port((id, params) => (id === "answer_fema_utilities" ? FEMA_REPLY : id === "answer_revenue" ? REV(params.period!) : id === "weather_quarter" ? WX(params.year!) : { columns: [], rows: [] }));
const STATIONS = { "0000000001": ["USW00099001"] };

describe("answerGate", () => {
  it("warm Q1 2024 shape: the FEMA FIPS key VERIFIED (recalled) passes the FEMA selection; the FEMA state key REJECTED 8 of 11 is coverage, reported with its orphans", () => {
    const W = "CY2024Q1";
    const g = answerGate(W, new Map([
      key("cik", "VERIFIED", 42, 43, "mem-59", [], W),
      key("fema_fips", "VERIFIED", 8, 8, "mem-65", [], W),
      key("fema_state", "REJECTED", 8, 11, null, ["AK", "ME", "VT"], W),
      key("station", "VERIFIED", 56, 56, "mem-61"),
    ]));
    expect(g.fema).toMatchObject({ key: "fema_fips@CY2024Q1", need: "VERIFIED", verdict: "VERIFIED", matched_rows: 8, left_rows: 8, recalled: true, ok: true });
    expect(g.fema.note).toBe("FEMA selection: key fema_fips@CY2024Q1 VERIFIED (8 of 8), recalled from memory");
    expect(g.fema_coverage).toEqual({
      key: "fema_state@CY2024Q1",
      verdict: "REJECTED",
      matched_rows: 8,
      left_rows: 11,
      orphans: ["AK", "ME", "VT"],
      recalled: false,
      note: "FEMA coverage (reported, not gated): key fema_state@CY2024Q1 REJECTED (8 of 11); declared states no seed utility serves: AK, ME, VT",
    });
    expect([g.revenue.ok, g.weather.ok]).toEqual([true, true]);
  });
  it("a REJECTED FEMA FIPS key withholds the FEMA selection, even with the coverage key VERIFIED", () => {
    const g = answerGate(Q, new Map([key("cik", "VERIFIED", 42, 43), key("fema_fips", "REJECTED", 2, 8), key("fema_state", "VERIFIED", 8, 8)]));
    expect(g.fema.ok).toBe(false);
    expect(g.fema.note).toBe("FEMA selection withheld: key fema_fips@CY2025Q1 is REJECTED (2 of 8), and the answer needs it VERIFIED");
    expect(g.fema_coverage).toMatchObject({ verdict: "VERIFIED", orphans: [] });
  });
  it("a PARTIAL FEMA FIPS key does not pass: the FEMA selection needs the codes to join the state reference", () => {
    expect(answerGate(Q, new Map([key("fema_fips", "PARTIAL", 7, 8), key("fema_state", "VERIFIED", 8, 8)])).fema.ok).toBe(false);
  });
  it("cold Q1 2025 shape: the FEMA FIPS key VERIFIED passes; the PARTIAL coverage key (orphan AK) is reported", () => {
    const g = answerGate(Q, new Map([key("cik", "VERIFIED", 42, 43), key("fema_fips", "VERIFIED", 8, 8), key("fema_state", "PARTIAL", 7, 8, null, ["AK"])]));
    expect(g.fema).toMatchObject({ ok: true, key: "fema_fips@CY2025Q1" });
    expect(g.fema.note).toBe("FEMA selection: key fema_fips@CY2025Q1 VERIFIED (8 of 8)");
    expect(g.fema_coverage.note).toBe("FEMA coverage (reported, not gated): key fema_state@CY2025Q1 PARTIAL (7 of 8); declared states no seed utility serves: AK");
  });
  it("a recalled VERIFIED CIK key passes and is named as recalled", () => {
    const g = answerGate(Q, new Map([key("cik", "VERIFIED", 42, 43, "mem-59"), key("fema_fips", "VERIFIED", 8, 8)]));
    expect(g.revenue).toMatchObject({ ok: true, recalled: true });
    expect(g.revenue.note).toContain("recalled from memory");
  });
  it("the weather column needs the station key VERIFIED", () => {
    expect(answerGate(Q, new Map([key("station", "VERIFIED", 56, 56)])).weather).toMatchObject({ key: "station@all", ok: true });
    expect(answerGate(Q, new Map([key("station", "PARTIAL", 50, 56)])).weather.ok).toBe(false);
  });
  it("a PARTIAL CIK key does not pass: the revenue column needs VERIFIED", () => {
    expect(answerGate(Q, new Map([key("cik", "PARTIAL", 40, 43)])).revenue.ok).toBe(false);
  });
  it("keys not measured in the run do not pass; an unmeasured coverage key is reported as such", () => {
    const g = answerGate(Q, new Map());
    expect(g.fema.ok).toBe(false);
    expect(g.revenue.ok).toBe(false);
    expect(g.fema.note).toBe("FEMA selection withheld: key fema_fips@CY2025Q1 is not measured in this run, and the answer needs it VERIFIED");
    expect(g.fema_coverage).toMatchObject({ verdict: null, orphans: [], note: "FEMA coverage (reported, not gated): key fema_state@CY2025Q1 not measured in this run" });
  });
  it("a key measured for another quarter does not pass", () => {
    const g = answerGate("CY2024Q1", new Map([key("cik", "VERIFIED", 42, 43), key("fema_fips", "VERIFIED", 8, 8)]));
    expect([g.fema.ok, g.revenue.ok]).toEqual([false, false]);
  });
  it("an empty state join withholds the FEMA selection: the FEMA state key measured or recalled with 0 matched rows, even with the FIPS key VERIFIED", () => {
    const g = answerGate(Q, new Map([key("cik", "VERIFIED", 42, 43), key("fema_fips", "VERIFIED", 8, 8), key("fema_state", "REJECTED", 0, 8, null, ["AK", "CA"])]));
    expect(g.fema).toMatchObject({ key: "fema_fips@CY2025Q1", verdict: "VERIFIED", ok: false });
    expect(g.fema.note).toBe("FEMA selection withheld: key fema_fips@CY2025Q1 is VERIFIED (8 of 8), but the selection joins on the state code and key fema_state@CY2025Q1 is REJECTED (0 of 8): the state join returns no rows");
    expect(g.fema_coverage.note).toBe("FEMA coverage (the state join returns no rows, so it withholds the FEMA selection): key fema_state@CY2025Q1 REJECTED (0 of 8); declared states no seed utility serves: AK, CA");
    expect(g.revenue.ok).toBe(true);
    expect(answerGate(Q, new Map([key("fema_fips", "VERIFIED", 8, 8, "mem-65"), key("fema_state", "REJECTED", 0, 8, "mem-66")])).fema.ok).toBe(false);
  });
  it("a state join with rows never withholds: the warm shape (REJECTED 8 of 11), the cold shape (PARTIAL 7 of 8), REJECTED 1 of 8 and an absent FEMA state key all pass on the FIPS key VERIFIED", () => {
    const W = "CY2024Q1";
    expect(answerGate(W, new Map([key("fema_fips", "VERIFIED", 8, 8, "mem-65", [], W), key("fema_state", "REJECTED", 8, 11, null, ["AK", "ME", "VT"], W)])).fema.ok).toBe(true);
    expect(answerGate(Q, new Map([key("fema_fips", "VERIFIED", 8, 8), key("fema_state", "PARTIAL", 7, 8, null, ["AK"])])).fema.ok).toBe(true);
    expect(answerGate(Q, new Map([key("fema_fips", "VERIFIED", 8, 8), key("fema_state", "REJECTED", 1, 8)])).fema.ok).toBe(true);
    const absent = answerGate(Q, new Map([key("fema_fips", "VERIFIED", 8, 8)]));
    expect(absent.fema).toMatchObject({ ok: true, note: "FEMA selection: key fema_fips@CY2025Q1 VERIFIED (8 of 8)" });
    expect(absent.fema_coverage.note).toBe("FEMA coverage (reported, not gated): key fema_state@CY2025Q1 not measured in this run");
  });
});

describe("answer under the gate", () => {
  it("a REJECTED FEMA FIPS key withholds the FEMA selection: no statement runs and no row is returned", async () => {
    const g = fixturePort();
    const r = await answer({ quarter: Q }, { gateway: g, runId: RUN, gate: answerGate(Q, new Map([key("cik", "VERIFIED", 42, 43), key("fema_fips", "REJECTED", 1, 8), key("fema_state", "VERIFIED", 8, 8)])) });
    expect(g.calls).toEqual([]);
    expect(r.rows).toEqual([]);
    expect(r.gate?.fema.ok).toBe(false);
    expect(r.gate?.fema.note).toMatch(/^FEMA selection withheld: key fema_fips@CY2025Q1 is REJECTED \(1 of 8\)/u);
  });
  it("an empty state join (FEMA state key 0 matched rows) withholds the FEMA selection: no statement runs and no row is returned", async () => {
    const g = fixturePort();
    const r = await answer({ quarter: Q }, { gateway: g, runId: RUN, stationsByCik: STATIONS, gate: answerGate(Q, new Map([key("cik", "VERIFIED", 42, 43), key("fema_fips", "VERIFIED", 8, 8), key("fema_state", "REJECTED", 0, 8), key("station", "VERIFIED", 56, 56)])) });
    expect(g.calls).toEqual([]);
    expect(r.rows).toEqual([]);
    expect(r.weather_status).toBe("not_tested");
    expect(r.gate?.fema.note).toMatch(/^FEMA selection withheld: key fema_fips@CY2025Q1 is VERIFIED \(8 of 8\), but .*the state join returns no rows$/u);
  });
  it("a REJECTED coverage key does not withhold: the FEMA selection runs and the answer equals the ungated answer", async () => {
    const g = fixturePort();
    const r = await answer({ quarter: Q }, { gateway: g, runId: RUN, gate: answerGate(Q, new Map([key("cik", "VERIFIED", 42, 43), key("fema_fips", "VERIFIED", 8, 8), key("fema_state", "REJECTED", 8, 11, null, ["AK", "ME", "VT"]), key("station", "VERIFIED", 56, 56)])) });
    const plain = await answer({ quarter: Q }, { gateway: fixturePort(), runId: RUN });
    expect(g.calls).toEqual(["answer_fema_utilities", "answer_revenue", "answer_revenue"]);
    expect(r.rows).toEqual(plain.rows);
    expect(r.gate?.fema_coverage).toMatchObject({ verdict: "REJECTED", orphans: ["AK", "ME", "VT"] });
  });
  it("a REJECTED CIK key withholds the revenue column: the FEMA rows stay, no revenue statement runs", async () => {
    const g = fixturePort();
    const r = await answer({ quarter: Q }, { gateway: g, runId: RUN, gate: answerGate(Q, new Map([key("cik", "REJECTED", 0, 43), key("fema_fips", "VERIFIED", 8, 8)])) });
    expect(g.calls).toEqual(["answer_fema_utilities"]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.revenue).toBeNull();
    expect(r.rows[0]!.revenue_note).toMatch(/^Revenue column withheld: key cik@CY2025Q1 is REJECTED \(0 of 43\)/u);
  });
  it("a REJECTED station key withholds the weather column: no weather statement runs", async () => {
    const g = fixturePort();
    const r = await answer({ quarter: Q }, { gateway: g, runId: RUN, stationsByCik: STATIONS, gate: answerGate(Q, new Map([key("cik", "VERIFIED", 42, 43), key("fema_fips", "VERIFIED", 8, 8), key("station", "REJECTED", 0, 56)])) });
    expect(g.calls).toEqual(["answer_fema_utilities", "answer_revenue", "answer_revenue"]);
    expect(r.weather_status).toBe("not_tested");
    expect(r.rows[0]!.weather_note).toMatch(/^Weather column withheld: key station@all is REJECTED \(0 of 56\)/u);
  });
  it("with every key passing, the answer equals the ungated answer", async () => {
    const gated = await answer({ quarter: Q }, { gateway: fixturePort(), runId: RUN, stationsByCik: STATIONS, gate: answerGate(Q, new Map([key("cik", "VERIFIED", 42, 43), key("fema_fips", "VERIFIED", 8, 8), key("fema_state", "PARTIAL", 7, 8, null, ["AK"]), key("station", "VERIFIED", 56, 56)])) });
    const plain = await answer({ quarter: Q }, { gateway: fixturePort(), runId: RUN, stationsByCik: STATIONS });
    expect(gated.rows).toEqual(plain.rows);
    expect(gated.weather_status).toBe("measured");
    expect(gated.rows[0]!.revenue!.change).toBeCloseTo(0.1, 12);
  });
});

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as SavedRunForGate;

describe("the redacted saved runs replayed under the gate", () => {
  it("cold Q1 2025: every key passes, coverage PARTIAL 7 of 8 (AK) is reported, and the 12-row answer is unchanged", async () => {
    const { gate, saved, replayed } = await replayAnswer(fixture("server-run-cold.json"));
    expect(gate.fema).toMatchObject({ ok: true, key: "fema_fips@CY2025Q1", verdict: "VERIFIED", matched_rows: 8, left_rows: 8 });
    expect(gate.fema_coverage).toMatchObject({ key: "fema_state@CY2025Q1", verdict: "PARTIAL", matched_rows: 7, left_rows: 8, orphans: ["AK"] });
    expect(gate.revenue).toMatchObject({ ok: true, verdict: "VERIFIED", matched_rows: 42, left_rows: 43 });
    expect(gate.weather).toMatchObject({ ok: true, verdict: "VERIFIED", matched_rows: 56, left_rows: 56 });
    expect(saved).toHaveLength(12);
    expect(replayed).toEqual(saved);
  });
  it("warm Q1 2024: the FEMA FIPS key (recalled) passes, the coverage key REJECTED 8 of 11 (AK, ME, VT) is reported, and the 16-row answer is unchanged", async () => {
    const { gate, saved, replayed } = await replayAnswer(fixture("server-run-warm.json"));
    expect(gate.fema).toMatchObject({ ok: true, key: "fema_fips@CY2024Q1", verdict: "VERIFIED", matched_rows: 8, left_rows: 8, recalled: true });
    expect(gate.fema_coverage).toMatchObject({ key: "fema_state@CY2024Q1", verdict: "REJECTED", matched_rows: 8, left_rows: 11, orphans: ["AK", "ME", "VT"] });
    expect(gate.revenue).toMatchObject({ ok: true, verdict: "VERIFIED", recalled: true });
    expect(saved).toHaveLength(16);
    expect(replayed).toEqual(saved);
  });
});
