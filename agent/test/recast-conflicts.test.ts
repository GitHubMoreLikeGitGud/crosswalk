import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HMEM, PROVENANCE_HISTORY, provenanceOf, type CwProvenance } from "../src/memory/hmemFacade.ts";
import { ruleR1 } from "../src/memory/recastConflicts.ts";
import type { EvidenceRecord } from "../src/evidence/store.ts";

let t = 1_700_000_000_000;
const clock = () => (t += 1000);

function memory(): HMEM {
  return new HMEM({ actor: "cw-agent", clock });
}

const prov: CwProvenance = {
  zetaris_object: "cw.concept_0000000001_Revenues",
  sql_sha256: "abc",
  endpoint: "https://data.sec.gov/api/xbrl/companyconcept/CIK0000000001/us-gaap/Revenues.json",
  accn: "0000000001-24-000001",
  filed: "2024-05-01",
  licence: "SEC",
  retrieved_at: "2026-10-24T20:00:00+08:00",
  latency_ms: 180,
  cache_state: "hit",
  evidence_id: "ev-1",
  template_id: "concept_window",
  run_id: "r1",
};

const own = { val: 1_000_000_000, accn: "0000000001-24-000001", filed: "2024-05-01", fy: 2024, fp: "Q1", form: "10-Q" };
const later = { val: 980_000_000, accn: "0000000001-25-000001", filed: "2025-05-01", fy: 2025, fp: "Q1", form: "10-Q" };

describe("rule R1", () => {
  it("uses the later filing's comparative for the previous quarter and the own filing for the current quarter", () => {
    expect(ruleR1("previous_period", 2025).chosen).toBe("later_filing");
    expect(ruleR1("current_period", 2025).chosen).toBe("own_filing");
    expect(ruleR1("previous_period", 2025).text).toContain("fy2025");
  });
});

describe("recast conflicts in H-MEM", () => {
  it("records both values as facts, resolves by R1, supersedes the loser and logs it in the ledger", () => {
    const h = memory();
    const a = h.addFact({ content: "Revenues CY2024Q1: 1000000000 in 0000000001-24-000001", source: "zetaris:cw.concept_0000000001_Revenues", label: "fact", provenance: prov, refs: ["ev-1"], key: "a" });
    const b = h.addFact({ content: "Revenues CY2024Q1: 980000000 as the comparative in 0000000001-25-000001", source: "zetaris:cw.concept_0000000001_Revenues", label: "fact", provenance: { ...prov, accn: later.accn, filed: later.filed }, refs: ["ev-1"], key: "b" });
    const { conflict, created } = h.recasts.record({ cik: "0000000001", tag: "Revenues", period: "CY2024Q1", scope: "previous_period", currentYear: 2025, ownFilingMemory: a.memory.id, laterFilingMemory: b.memory.id, ownFiling: own, laterFiling: later, runId: "r1", evidenceIds: ["ev-1"] });
    expect(created).toBe(true);
    expect(conflict.kind).toBe("recast_comparative");
    expect(conflict.rule).toBe("R1");
    expect(conflict.chosen).toBe("later_filing");
    expect(conflict.chosen_val).toBe(980_000_000);
    expect(conflict.status).toBe("resolved_by_rule");
    expect(h.store.get(a.memory.id)!.supersededBy).toBe(b.memory.id);
    expect(h.store.get(b.memory.id)!.supersededBy).toBeUndefined();
    const actions = h.ledger.history(a.memory.id).map((e) => e.action);
    expect(actions).toContain("conflict_detected");
    expect(actions).toContain("conflict_resolved");
    const resolved = h.ledger.history(a.memory.id).find((e) => e.action === "conflict_resolved")!;
    expect(resolved.actor).toBe("cw-agent");
    expect(resolved.details).toMatchObject({ conflictId: conflict.id, rule: "R1", winner: b.memory.id });
    // Idempotent: the same pair is one record.
    const again = h.recasts.record({ cik: "0000000001", tag: "Revenues", period: "CY2024Q1", scope: "previous_period", currentYear: 2025, ownFilingMemory: a.memory.id, laterFilingMemory: b.memory.id, ownFiling: own, laterFiling: later, evidenceIds: ["ev-2"] });
    expect(again.created).toBe(false);
    expect(again.conflict.evidence_ids).toEqual(["ev-1", "ev-2"]);
    expect(h.recasts.all()).toHaveLength(1);
    // why() shows the provenance, the conflict and the ledger.
    const why = h.why(a.memory.id);
    expect(why.provenance?.sql_sha256).toBe("abc");
    expect(why.conflicts).toHaveLength(1);
    expect(why.lines.join("\n")).toMatch(/R1/u);
    expect(why.lines.join("\n")).toMatch(/Superseded by/u);
  });

  it("keeps the current quarter's own value when a later filing restates it", () => {
    const h = memory();
    const a = h.addFact({ content: "cur own", source: "zetaris:x", label: "f", provenance: prov, refs: [], key: "c1" });
    const b = h.addFact({ content: "cur later", source: "zetaris:x", label: "f", provenance: prov, refs: [], key: "c2" });
    const { conflict } = h.recasts.record({ cik: "0000000001", tag: "Revenues", period: "CY2025Q1", scope: "current_period", currentYear: 2025, ownFilingMemory: a.memory.id, laterFilingMemory: b.memory.id, ownFiling: { ...own, val: 5_463_400_000 }, laterFiling: { ...later, val: 5_463_000_000 } });
    expect(conflict.chosen).toBe("own_filing");
    expect(conflict.chosen_val).toBe(5_463_400_000);
    expect(h.store.get(b.memory.id)!.supersededBy).toBe(a.memory.id);
  });

  it("lets the analyst override the resolution with a reason, logged as the analyst", () => {
    const h = memory();
    const a = h.addFact({ content: "own", source: "zetaris:x", label: "f", provenance: prov, refs: [], key: "o1" });
    const b = h.addFact({ content: "later", source: "zetaris:x", label: "f", provenance: prov, refs: [], key: "o2" });
    const { conflict } = h.recasts.record({ cik: "0000000001", tag: "Revenues", period: "CY2024Q1", scope: "previous_period", currentYear: 2025, ownFilingMemory: a.memory.id, laterFilingMemory: b.memory.id, ownFiling: own, laterFiling: later });
    expect(() => h.recasts.override(conflict.id, { chosen: "own_filing", reason: "  " })).toThrow(/reason/u);
    const o = h.recasts.override(conflict.id, { chosen: "own_filing", reason: "the restatement reclassified a pass-through item" });
    expect(o.status).toBe("overridden");
    expect(o.chosen).toBe("own_filing");
    expect(o.chosen_val).toBe(own.val);
    expect(o.override?.by).toBe("analyst");
    expect(h.store.get(b.memory.id)!.supersededBy).toBe(a.memory.id);
    expect(h.store.get(a.memory.id)!.supersededBy).toBeUndefined();
    const last = h.ledger.history(b.memory.id).filter((e) => e.action === "conflict_resolved").pop()!;
    expect(last.actor).toBe("analyst");
    expect(last.details).toMatchObject({ override: true, reason: "the restatement reclassified a pass-through item" });
    expect(() => h.recasts.override("rc-nope", { chosen: "own_filing", reason: "x" })).toThrow(/no recast conflict/u);
    expect(() => h.recasts.override(conflict.id, { chosen: "both" as never, reason: "x" })).toThrow(/chosen must be own_filing or later_filing/u);
  });

  it("records the contract id of the override and keeps it when the same pair is recorded again (D4)", () => {
    const h = memory();
    const a = h.addFact({ content: "own", source: "zetaris:x", label: "f", provenance: prov, refs: [], key: "k1" });
    const b = h.addFact({ content: "later", source: "zetaris:x", label: "f", provenance: prov, refs: [], key: "k2" });
    const input = { cik: "0000000001", tag: "Revenues", period: "CY2025Q1", scope: "current_period" as const, currentYear: 2025, ownFilingMemory: a.memory.id, laterFilingMemory: b.memory.id, ownFiling: { ...own, val: 5_463_400_000 }, laterFiling: { ...later, val: 5_463_000_000 } };
    const { conflict } = h.recasts.record(input);
    const o = h.recasts.override(conflict.id, { chosen: "later_filing", reason: "the later filing corrected a booking error", by: "analyst", contractId: "c-abc-12345678" });
    expect(o).toMatchObject({ status: "overridden", chosen: "later_filing", chosen_val: 5_463_000_000 });
    expect(o.override).toMatchObject({ by: "analyst", chosen: "later_filing", reason: "the later filing corrected a booking error", contract_id: "c-abc-12345678" });
    expect(h.store.get(a.memory.id)!.supersededBy).toBe(b.memory.id);
    const last = h.ledger.history(a.memory.id).filter((e) => e.action === "conflict_resolved").pop()!;
    expect(last.actor).toBe("analyst");
    expect(last.details).toMatchObject({ override: true, contract_id: "c-abc-12345678", chosen_val: 5_463_000_000 });
    // A later run records the same pair: the override stands.
    const again = h.recasts.record(input);
    expect(again.created).toBe(false);
    expect(again.conflict.status).toBe("overridden");
    expect(again.conflict.chosen_val).toBe(5_463_000_000);
    expect(h.why(a.memory.id).lines.join("\n")).toMatch(/overridden by analyst/u);
  });

  it("remembers the tag and station choices and logs their reads", () => {
    const h = memory();
    expect(h.tagChoice("0000000001", "CY2025Q1")).toBeNull();
    const r = h.rememberTagChoice("0000000001", "CY2025Q1", "Revenues", prov, ["ev-1"]);
    expect(r.created).toBe(true);
    const again = h.rememberTagChoice("0000000001", "CY2025Q1", "Revenues", prov, ["ev-1"]);
    expect(again.created).toBe(false);
    const got = h.tagChoice("0000000001", "CY2025Q1")!;
    expect(got.tag).toBe("Revenues");
    expect(h.ledger.history(got.memory.id).some((e) => e.action === "read")).toBe(true);
    h.rememberStationChoice("0000000001", ["USW00000002", "USW00000001"], null, []);
    expect(h.stationChoice("0000000001")!.stations).toEqual(["USW00000001", "USW00000002"]);
    expect(h.memoryContext({ cik: "0000000001", period: "CY2025Q1" })).toContain("REMEMBERED FROM EARLIER RUNS");
  });

  it("refreshes a fact's provenance on reconfirmation: the latest retrieval wins, earlier ones are kept in history, capped (D1)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cw-hmem-"));
    const h = new HMEM({ actor: "cw-agent", clock, persistDir: dir });
    const first = { ...prov, zetaris_object: "cw.concept_{cik10}_{tag}", evidence_id: "ev-1", run_id: "r1", retrieved_at: "2026-10-24T20:30:00+08:00" };
    const a = h.addFact({ content: "Revenues CY2025Q1: 5463400000", source: "zetaris:cw.concept", label: "fact", provenance: first, refs: ["ev-1"], key: "v1" });
    expect(a.created).toBe(true);
    expect(h.provenanceFor(a.memory.id)).toEqual(first);
    expect(h.provenanceFor(a.memory.id)!.history).toBeUndefined();
    // The same fact again from a later run with the filled object name.
    const second = { ...prov, zetaris_object: "cw.concept_0000000001_Revenues", evidence_id: "ev-9", run_id: "r2", retrieved_at: "2026-10-24T21:40:00+08:00", latency_ms: 219 };
    const again = h.addFact({ content: "Revenues CY2025Q1: 5463400000", source: "zetaris:cw.concept", label: "fact", provenance: second, refs: ["ev-9"], key: "v1" });
    expect(again.created).toBe(false);
    expect(again.memory.id).toBe(a.memory.id);
    const p = h.provenanceFor(a.memory.id)!;
    expect(p).toMatchObject(second);
    expect(p.zetaris_object).toBe("cw.concept_0000000001_Revenues");
    expect(p.history).toEqual([first]);
    // why() prints the current provenance, not the placeholder, and names the kept history.
    const why = h.why(a.memory.id).lines.join("\n");
    expect(why).toContain("Provenance: cw.concept_0000000001_Revenues");
    expect(why).not.toContain("{cik10}");
    expect(why).toContain("1 earlier retrieval(s) kept, the first 2026-10-24T20:30:00+08:00");
    expect(h.why(a.memory.id).provenance).toEqual(p);
    // Persisted: provenance.json carries the same shape and no placeholder at the top level.
    const onDisk = JSON.parse(readFileSync(path.join(dir, "provenance.json"), "utf8")) as Record<string, { zetaris_object: string; history?: unknown[] }>;
    expect(onDisk[a.memory.id]!.zetaris_object).toBe("cw.concept_0000000001_Revenues");
    expect(onDisk[a.memory.id]!.history).toHaveLength(1);
    // A reload sees the refreshed provenance.
    expect(new HMEM({ actor: "cw-agent", clock, persistDir: dir }).provenanceFor(a.memory.id)).toEqual(p);
    // Reconfirming with the same evidence changes nothing; without provenance keeps the latest.
    h.addFact({ content: "Revenues CY2025Q1: 5463400000", source: "zetaris:cw.concept", label: "fact", provenance: second, refs: ["ev-9"], key: "v1" });
    h.addFact({ content: "Revenues CY2025Q1: 5463400000", source: "zetaris:cw.concept", label: "fact", provenance: null, refs: [], key: "v1" });
    expect(h.provenanceFor(a.memory.id)).toEqual(p);
    // The history is capped at PROVENANCE_HISTORY, most recent first.
    for (let i = 0; i < PROVENANCE_HISTORY + 3; i++) {
      h.addFact({ content: "Revenues CY2025Q1: 5463400000", source: "zetaris:cw.concept", label: "fact", provenance: { ...second, evidence_id: `ev-${100 + i}`, run_id: `r${3 + i}`, retrieved_at: `2026-10-25T0${i}:00:00+08:00` }, refs: [], key: "v1" });
    }
    const capped = h.provenanceFor(a.memory.id)!;
    expect(capped.evidence_id).toBe(`ev-${100 + PROVENANCE_HISTORY + 2}`);
    expect(capped.history).toHaveLength(PROVENANCE_HISTORY);
    expect(capped.history![0]!.evidence_id).toBe(`ev-${100 + PROVENANCE_HISTORY + 1}`);
    expect(capped.history!.every((x) => !("history" in x))).toBe(true);
    const reads = h.ledger.history(a.memory.id).filter((e) => e.action === "read" && (e.details as { provenance_refreshed?: boolean })?.provenance_refreshed);
    expect(reads.length).toBe(PROVENANCE_HISTORY + 3);
  });

  it("builds provenance from an evidence record", () => {
    const ev = { id: "ev-9", run_id: "r", kind: "zetaris_sql", claim: "c", queried_at: "t", zetaris_object: "cw.x", sql_sha256: "s", source_url: "u", licence: "l", elapsed_ms: 5, cache_state: "hit", template_id: "frames_fact" } as EvidenceRecord;
    expect(provenanceOf(ev, { accn: "a", filed: "f" })).toEqual({ zetaris_object: "cw.x", sql_sha256: "s", endpoint: "u", accn: "a", filed: "f", licence: "l", retrieved_at: "t", latency_ms: 5, cache_state: "hit", evidence_id: "ev-9", template_id: "frames_fact", run_id: "r" });
  });
});
