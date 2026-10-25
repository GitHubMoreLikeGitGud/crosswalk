// The discovery graph: datasets, columns, measured keys (crosswalks_to with transform, rate, verdict,
// validFrom), utilities serving states and declarations; idempotent re-ingest; and the "what did we know,
// and since when" queries for a key and for a utility. Synthetic values throughout; the clock is injected.
import { describe, expect, it } from "vitest";
import { CrosswalkWorld, type KeyInput } from "../src/world/world.ts";

const clock = () => new Date("2026-10-25T12:00:00Z");

const key = (over: Partial<KeyInput> = {}): KeyInput => ({
  left: { object: "cw.seed_utilities", column: "cik" },
  right: { object: "cw.frames_Revenues_CY2025Q1", column: "cik" },
  transform: "lpad10",
  memoryKey: "cw.frames_revenues_<period>.cik|cw.seed_utilities.cik|lpad10",
  rate: 42 / 43,
  rate_distinct: 42 / 43,
  verdict: "VERIFIED",
  matched_rows: 42,
  left_rows: 43,
  measured_as: "cik@CY2025Q1",
  orphans: ["0009000043 (SYN Q)"],
  run_id: "r-1",
  at: "2026-10-25T05:00:00.000Z",
  sqlSha256: "abc",
  ...over,
});

describe("CrosswalkWorld", () => {
  it("ingests datasets, a key, a utility and a declaration, and re-ingesting the same batch writes nothing", async () => {
    const w = new CrosswalkWorld({ directory: null, clock });
    const batch = {
      runId: "r-1",
      datasets: [{ object: "cw.seed_utilities", columns: [{ name: "cik", type: "string" }] }],
      keys: [key()],
      utilities: [{ cik: "0009000001", name: "SYN A", ticker: "SA", statesServed: ["CA", "OR"], curatedAt: "2026-10-24T00:00:00Z" }],
      declarations: [{ disaster_number: "9001", state: "CA", declaration_date: "2025-01-08", incident_type: "Fire", title: "SYN FIRE", designated_areas: 1, quarter: "CY2025Q1", sqlSha256: null }],
    };
    const d1 = await w.ingest(batch);
    expect(d1.changed).toBe(true);
    const g = w.exportGraph();
    expect(g.byType).toMatchObject({ dataset: 1, utility: 1, declaration: 1 });
    expect(g.edgeTypes).toMatchObject({ has_column: 1, crosswalks_to: 1, serves: 2, declared_in: 1 });
    const d2 = await w.ingest(batch);
    expect(d2.appended).toBe(0);
    expect(d2.changed).toBe(false);
  });

  it("answers what we knew about a key, and since when, across two measurements", async () => {
    const w = new CrosswalkWorld({ directory: null, clock });
    await w.ingest({ keys: [key()] });
    await w.ingest({ keys: [key({ rate: 1, matched_rows: 43, verdict: "VERIFIED", run_id: "r-2", at: "2026-10-26T05:00:00.000Z", orphans: [] })] });
    const h = w.keyHistory({ object: "cw.seed_utilities", column: "cik" }, { object: "cw.frames_Revenues_CY2025Q1", column: "cik" });
    expect(h).toHaveLength(2);
    expect(h[0]).toMatchObject({ type: "crosswalks_to", validFrom: "2026-10-25T05:00:00.000Z", open: false });
    expect(h[0]!.attrs).toMatchObject({ matched_rows: 42, run_id: "r-1" });
    expect(h[1]).toMatchObject({ validFrom: "2026-10-26T05:00:00.000Z", open: true });
  });

  it("answers what we knew about a utility: the states it serves and the declarations in them", async () => {
    const w = new CrosswalkWorld({ directory: null, clock });
    await w.ingest({
      utilities: [{ cik: "0009000001", name: "SYN A", ticker: "SA", statesServed: ["CA"], curatedAt: "2026-10-24T00:00:00Z" }],
      declarations: [
        { disaster_number: "9001", state: "CA", declaration_date: "2025-01-08", incident_type: "Fire", title: null, designated_areas: 2, quarter: "CY2025Q1", sqlSha256: null },
        { disaster_number: "9002", state: "AK", declaration_date: "2025-02-01", incident_type: "Flood", title: null, designated_areas: 1, quarter: "CY2025Q1", sqlSha256: null },
      ],
    });
    const h = w.utilityHistory("0009000001");
    expect(h.map((l) => l.type).sort()).toEqual(["declared_in", "serves"]);
    expect(h.find((l) => l.type === "declared_in")).toMatchObject({ validFrom: "2025-01-08T00:00:00.000Z", to: "CA" });
  });
});
