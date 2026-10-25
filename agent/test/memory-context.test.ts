// The memory context of chunk 0 (agent/src/memory/hmemFacade.ts): VERIFIED keys of earlier runs, never a key on
// cw.seed_utilities (D15: the question path reads its onboarding snapshot). In-memory store, injected clock.
import { describe, expect, it } from "vitest";
import { openMemory } from "../src/memory/hmemFacade.ts";
import type { MeasureResult } from "../src/tools/discovery.ts";

const AT = Date.parse("2026-10-25T12:00:00+08:00");

function measured(leftObject: string, leftColumn: string, rightObject: string, rightColumn: string, key: string): MeasureResult {
  return { key, route: key.split("@")[0]!, label: key, proposal: { leftObject, leftColumn, rightObject, rightColumn, transform: "lpad10" }, status: "measured", reason: null, measured_as: key, orientation: null,
    left_rows: 43, matched_rows: 42, left_keys: 43, matched_keys: 42, rate: 42 / 43, rate_distinct: 42 / 43, verdict: "VERIFIED", orphans: [], extra: {}, sql: "SELECT 1", sql_orphans: null, proposal_sql: "SELECT 1", elapsed_ms: 1, provenance: [], from_memory: null };
}

describe("memory context", () => {
  it("lists VERIFIED keys of earlier runs but never one remembered on cw.seed_utilities", () => {
    const hmem = openMemory({ persistDir: null, clock: () => AT });
    hmem.rememberKey({ memoryKey: "old", result: measured("cw.frames_Revenues_CY2025Q1", "cik", "cw.seed_utilities", "cik", "cik@CY2025Q1"), runId: "r-day1", at: "2026-10-25T06:00:00Z", evidenceIds: [], provenance: null });
    hmem.rememberKey({ memoryKey: "new", result: measured("cw.frames_Revenues_CY2025Q1", "cik", "cw.seed_submissions_snapshot", "cik10", "cik@CY2025Q1"), runId: "r-day2", at: "2026-10-25T07:00:00Z", evidenceIds: [], provenance: null });
    const ctx = hmem.memoryContext();
    expect(ctx).toContain("cw.seed_submissions_snapshot.cik10");
    expect(ctx).not.toMatch(/cw\.seed_utilities\b/u);
  });
});
