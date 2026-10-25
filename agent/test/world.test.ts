import { describe, expect, it } from "vitest";
import { periodEnd, utilityId, WeatherWorld, type WorldBatch } from "../src/world/world.ts";

const meta = { object: "cw.frames_Revenues_CY2025Q1", sqlSha256: "deadbeef", url: "https://data.sec.gov/x", evidenceId: "ev-1" };

function batch(): WorldBatch {
  return {
    utilities: [
      {
        cik: "0000000001",
        name: "Target Electric Corp",
        ticker: "TGT",
        sic: "4911",
        sicDescription: "Electric Services",
        hqState: "AA",
        statesServed: ["AA", "BB"],
        stations: [
          { id: "USW00000001", state: "AA", name: "Station One" },
          { id: "USW00000002", state: "BB", name: "Station Two" },
        ],
        flags: [],
        curatedAt: "2026-10-24T00:00:00Z",
        statesBasis: "synthetic",
        servesFrom: "2024-01-01",
        profile: { name: "TARGET ELECTRIC CORP", sic: "4911", sicDescription: "Electric Services", state: "AA", meta, at: "2026-10-24T20:00:00+08:00" },
      },
      { cik: "0000000002", name: "Peer Two", ticker: null, sic: "4931", hqState: "CC", statesServed: ["CC"], stations: [{ id: "USW00000010", state: "CC", name: null }], flags: [], curatedAt: "2026-10-24T00:00:00Z", statesBasis: "synthetic", servesFrom: "2024-01-01", profile: null },
    ],
    filings: [
      { cik: "0000000001", tag: "Revenues", period: "CY2025Q1", facts: [{ accn: "0000000001-25-000001", filed: "2025-05-01", fy: 2025, fp: "Q1", form: "10-Q", start: "2025-01-01", end: "2025-03-31", val: 1_150_000_000 }], meta },
      { cik: "0000000001", tag: "Revenues", period: "CY2024Q1", facts: [{ accn: "0000000001-24-000001", filed: "2024-05-01", fy: 2024, fp: "Q1", form: "10-Q", start: "2024-01-01", end: "2024-03-31", val: 1_000_000_000 }, { accn: "0000000001-25-000001", filed: "2025-05-01", fy: 2025, fp: "Q1", form: "10-Q", start: "2024-01-01", end: "2024-03-31", val: 980_000_000 }], meta },
    ],
    recasts: [{ cik: "0000000001", tag: "Revenues", period: "CY2024Q1", from: { accn: "0000000001-24-000001", val: 1_000_000_000, filed: "2024-05-01" }, to: { accn: "0000000001-25-000001", val: 980_000_000, filed: "2025-05-01" }, rule: "R1", chosen: "later_filing", meta }],
    peers: [{ targetCik: "0000000001", period: "CY2025Q1", at: "2025-03-31", peers: [{ cik: "0000000002", g: 0.07, dw: 0.1, tag: "Revenues" }], meta }],
    weather: [
      { period: "CY2025Q1", year: 2025, quarter: 1, at: "2025-03-31", rows: [{ station_id: "USW00000001", year: 2025, quarter: 1, hdd: 2300, cdd: 10, days_observed: 90, days_in_quarter: 90, coverage: 1 }], meta },
      { period: "CY2024Q1", year: 2024, quarter: 1, at: "2024-03-31", rows: [{ station_id: "USW00000001", year: 2024, quarter: 1, hdd: 1990, cdd: 10, days_observed: 91, days_in_quarter: 91, coverage: 1 }], meta },
    ],
  };
}

describe("WeatherWorld", () => {
  it("ingests the entities and relationships with source-time provenance", async () => {
    const w = new WeatherWorld({ directory: null });
    const d = await w.ingest(batch());
    expect(d.appended).toBeGreaterThan(0);
    expect(d.changed).toBe(true);
    const g = w.exportGraph();
    expect(g.byType).toMatchObject({ utility: 2, state: 3, station: 3, sic: 2, filing: 2, quarter: 2 });
    expect(g.edgeTypes).toMatchObject({ serves: 3, represented_by: 3, reported_in: 3, recasts: 1, peer_of: 1, observed_in: 2, classified_as: 2 });
    const serves = w.edges({ from: utilityId("0000000001"), type: "serves" });
    expect(serves).toHaveLength(2);
    expect(serves[0]!.validFrom).toBe("2024-01-01T00:00:00.000Z");
    const reported = w.edges({ from: utilityId("0000000001"), type: "reported_in" });
    expect(reported.map((r) => r.validFrom).sort()).toEqual(["2024-05-01T00:00:00.000Z", "2025-05-01T00:00:00.000Z", "2025-05-01T00:00:00.000Z"]);
    const n = w.neighbourhood("0000000001");
    expect(n.utility?.name).toBe("TARGET ELECTRIC CORP");
    expect(n.utility?.aliases).toContain("Target Electric Corp");
    expect(n.edges.some((e) => e.type === "peer_of" && e.attrs.g === 0.07)).toBe(true);
    expect(w.timeline("0000000001").length).toBeGreaterThan(5);
    expect(periodEnd("CY2025Q1")).toBe("2025-03-31");
    expect(periodEnd("CY2024Q2")).toBe("2024-06-30");
  });

  it("re-ingesting the same rows appends no event and leaves the state hash unchanged (the reference idempotency check)", async () => {
    const w = new WeatherWorld({ directory: null });
    await w.ingest(batch());
    const d2 = await w.ingest(batch());
    expect(d2.appended).toBe(0);
    expect(d2.changed).toBe(false);
    expect(d2.stateBefore).toBe(d2.stateAfter);
    expect(d2.writes.entities + d2.writes.edges + d2.writes.retractions).toBe(0);
    expect(d2.writes.kept).toBeGreaterThan(0);
  });

  it("closes an edge whose attributes change at a later source time and keeps the earlier one in the history", async () => {
    const w = new WeatherWorld({ directory: null });
    await w.ingest(batch());
    const b = batch();
    b.peers![0]!.at = "2025-06-30";
    b.peers![0]!.peers[0]!.g = 0.071;
    const d = await w.ingest(b);
    expect(d.appended).toBeGreaterThan(0);
    const open = w.edges({ from: utilityId("0000000001"), type: "peer_of" });
    expect(open).toHaveLength(1);
    expect(open[0]!.attrs?.g).toBe(0.071);
    const all = w.edges({ from: utilityId("0000000001"), type: "peer_of", includeClosed: true });
    expect(all.length).toBe(2);
    expect(all.some((r) => r.validTo)).toBe(true);
  });
});
