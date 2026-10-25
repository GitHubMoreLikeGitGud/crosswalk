// The answer gated on the join map (agent/src/tools/discovery.ts answerGate): the FEMA selection needs the
// FEMA state key at PARTIAL or better, the revenue column needs the CIK key VERIFIED (measured in this run or
// recalled). The last two tests replay the committed redacted server fixtures (synthetic values) offline.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { replayAnswer, type SavedRunForGate } from "../src/eval/gateReplay.ts";
import { answer, answerGate, type MeasureResult, type TemplatePort, type TemplateReply } from "../src/tools/discovery.ts";

const RUN = "r-test";
const Q = "CY2025Q1";

function key(route: string, verdict: "VERIFIED" | "PARTIAL" | "REJECTED", matched: number, rows: number, fromMemory: string | null = null): [string, MeasureResult] {
  const k = `${route}@${Q}`;
  return [k, { key: k, route, status: "measured", verdict, matched_rows: matched, left_rows: rows, from_memory: fromMemory } as unknown as MeasureResult];
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
const fixturePort = () => port((id, params) => (id === "answer_fema_utilities" ? FEMA_REPLY : id === "answer_revenue" ? REV(params.period!) : { columns: [], rows: [] }));

describe("answerGate", () => {
  it("passes a VERIFIED CIK key and a PARTIAL FEMA state key, the latter labelled usable with care", () => {
    const g = answerGate(Q, new Map([key("cik", "VERIFIED", 42, 43), key("fema_state", "PARTIAL", 7, 8)]));
    expect(g.revenue.ok).toBe(true);
    expect(g.fema.ok).toBe(true);
    expect(g.fema.note).toBe("FEMA selection: key fema_state@CY2025Q1 PARTIAL (7 of 8); usable with care");
  });
  it("a recalled VERIFIED CIK key passes and is named as recalled", () => {
    const g = answerGate(Q, new Map([key("cik", "VERIFIED", 42, 43, "mem-59"), key("fema_state", "VERIFIED", 8, 8)]));
    expect(g.revenue).toMatchObject({ ok: true, recalled: true });
    expect(g.revenue.note).toContain("recalled from memory");
  });
  it("a PARTIAL CIK key does not pass: the revenue column needs VERIFIED", () => {
    expect(answerGate(Q, new Map([key("cik", "PARTIAL", 40, 43)])).revenue.ok).toBe(false);
  });
  it("keys not measured in the run do not pass", () => {
    const g = answerGate(Q, new Map());
    expect(g.fema.ok).toBe(false);
    expect(g.revenue.ok).toBe(false);
    expect(g.fema.note).toBe("FEMA selection withheld: key fema_state@CY2025Q1 is not measured in this run, and the answer needs it PARTIAL or better");
  });
  it("a key measured for another quarter does not pass", () => {
    const g = answerGate("CY2024Q1", new Map([key("cik", "VERIFIED", 42, 43), key("fema_state", "VERIFIED", 8, 8)]));
    expect([g.fema.ok, g.revenue.ok]).toEqual([false, false]);
  });
});

describe("answer under the gate", () => {
  it("a REJECTED FEMA state key withholds the FEMA selection: no statement runs and no row is returned", async () => {
    const g = fixturePort();
    const r = await answer({ quarter: Q }, { gateway: g, runId: RUN, gate: answerGate(Q, new Map([key("cik", "VERIFIED", 42, 43), key("fema_state", "REJECTED", 1, 8)])) });
    expect(g.calls).toEqual([]);
    expect(r.rows).toEqual([]);
    expect(r.gate?.fema.ok).toBe(false);
    expect(r.gate?.fema.note).toMatch(/^FEMA selection withheld: key fema_state@CY2025Q1 is REJECTED \(1 of 8\)/u);
  });
  it("a REJECTED CIK key withholds the revenue column: the FEMA rows stay, no revenue statement runs", async () => {
    const g = fixturePort();
    const r = await answer({ quarter: Q }, { gateway: g, runId: RUN, gate: answerGate(Q, new Map([key("cik", "REJECTED", 0, 43), key("fema_state", "VERIFIED", 8, 8)])) });
    expect(g.calls).toEqual(["answer_fema_utilities"]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.revenue).toBeNull();
    expect(r.rows[0]!.revenue_note).toMatch(/^Revenue column withheld: key cik@CY2025Q1 is REJECTED \(0 of 43\)/u);
  });
  it("with both keys passing, the answer equals the ungated answer", async () => {
    const gated = await answer({ quarter: Q }, { gateway: fixturePort(), runId: RUN, gate: answerGate(Q, new Map([key("cik", "VERIFIED", 42, 43), key("fema_state", "PARTIAL", 7, 8)])) });
    const plain = await answer({ quarter: Q }, { gateway: fixturePort(), runId: RUN });
    expect(gated.rows).toEqual(plain.rows);
    expect(gated.rows[0]!.revenue!.change).toBeCloseTo(0.1, 12);
  });
});

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as SavedRunForGate;

describe("the redacted saved runs replayed under the gate", () => {
  it("cold Q1 2025: both keys pass and the 12-row answer is unchanged", async () => {
    const { gate, saved, replayed } = await replayAnswer(fixture("server-run-cold.json"));
    expect(gate.fema).toMatchObject({ ok: true, verdict: "PARTIAL", matched_rows: 7, left_rows: 8 });
    expect(gate.revenue).toMatchObject({ ok: true, verdict: "VERIFIED", matched_rows: 42, left_rows: 43 });
    expect(saved).toHaveLength(12);
    expect(replayed).toEqual(saved);
  });
  it("warm Q1 2024: the FEMA state key is REJECTED (8 of 11), so the gate withholds the FEMA selection", async () => {
    const { gate, saved, replayed } = await replayAnswer(fixture("server-run-warm.json"));
    expect(gate.fema).toMatchObject({ ok: false, verdict: "REJECTED", matched_rows: 8, left_rows: 11 });
    expect(gate.revenue).toMatchObject({ ok: true, verdict: "VERIFIED", recalled: true });
    expect(saved).toHaveLength(16);
    expect(replayed).toEqual([]);
  });
});
