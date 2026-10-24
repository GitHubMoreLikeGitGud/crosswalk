// The recast_comparative conflict (SPEC 2 step 2): the same quarter's revenue carries two
// values in two filings. Both values stay in memory as facts; the conflict record names
// both memories and both accession numbers, and rule R1 resolves it: the value as reported
// in the filing of the period under question (its own 10-Q), which for the previous
// quarter is the comparative column of that filing and for the current quarter is its own
// original value (a later restatement never overrides it). The losing memory is marked
// supersededBy (kept and penalised, never deleted), as the reference engine resolves
// conflicts. The analyst can override the resolution (actor "analyst"); the override is
// logged in the trust ledger and in the conflict record.
// Runtime state: data/hmem/recast_conflicts.json (gitignored).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { MemoryStoreService, TrustLedgerService } from "../../../engines/hmem/reference/src/index.ts";

export type RecastSide = "own_filing" | "later_filing";

export interface RecastValue {
  val: number;
  accn: string;
  filed: string;
  fy: number;
  fp: string;
  form: string;
}

export interface RecastConflict {
  id: string;
  kind: "recast_comparative";
  cik: string;
  tag: string;
  /** The quarter whose value differs between the two filings (CY2024Q1). */
  period: string;
  /** Whether that quarter is the previous or the current quarter of the question. */
  scope: "previous_period" | "current_period";
  /** Memory ids: the value in the quarter's own filing and the value in the later filing. */
  own_filing_memory: string;
  later_filing_memory: string;
  own_filing: RecastValue;
  later_filing: RecastValue;
  rule: "R1";
  rule_text: string;
  /** Which side the analysis uses. */
  chosen: RecastSide;
  chosen_val: number;
  status: "resolved_by_rule" | "overridden";
  detected_at: string;
  run_id: string | null;
  evidence_ids: string[];
  override?: { by: string; chosen: RecastSide; reason: string; at: string; contract_id: string | null };
}

export interface RecastConflictHost {
  store: MemoryStoreService;
  ledger: TrustLedgerService;
  clock: () => number;
  actor: string;
}

const sha12 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12);

/** Rule R1 for a scope: the filing of the question's current year decides. */
export function ruleR1(scope: RecastConflict["scope"], currentYear: number): { chosen: RecastSide; text: string } {
  if (scope === "previous_period") {
    return { chosen: "later_filing", text: `R1: use the comparative as reported in the fy${currentYear} filing (the question's own filing), not the previous year's original` };
  }
  return { chosen: "own_filing", text: `R1: use the current quarter's value as reported in its own fy${currentYear} filing; a later restatement is recorded, not applied` };
}

export class RecastConflictService {
  private conflicts: RecastConflict[] = [];
  private readonly file: string | null;

  constructor(
    private readonly host: RecastConflictHost,
    persistDir: string | null,
  ) {
    this.file = persistDir ? path.join(persistDir, "recast_conflicts.json") : null;
    if (this.file && existsSync(this.file)) {
      this.conflicts = (JSON.parse(readFileSync(this.file, "utf8")) as { conflicts: RecastConflict[] }).conflicts ?? [];
    }
  }

  private persist(): void {
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify({ conflicts: this.conflicts }, null, 2)}\n`, "utf8");
  }

  all(): readonly RecastConflict[] {
    return this.conflicts;
  }

  get(id: string): RecastConflict | undefined {
    return this.conflicts.find((c) => c.id === id);
  }

  forCik(cik: string): RecastConflict[] {
    return this.conflicts.filter((c) => c.cik === cik);
  }

  /** The conflicts whose memories include `memoryId`. */
  involving(memoryId: string): RecastConflict[] {
    return this.conflicts.filter((c) => c.own_filing_memory === memoryId || c.later_filing_memory === memoryId);
  }

  static idFor(cik: string, tag: string, period: string, ownAccn: string, laterAccn: string): string {
    return `rc-${sha12(`${cik}|${tag}|${period}|${ownAccn}|${laterAccn}`)}`;
  }

  /**
   * Records a conflict between two value memories and resolves it by R1. Idempotent: the
   * same pair of filings for the same quarter is recorded once; a second run returns the
   * existing record (and an override, once made, stands).
   */
  record(input: {
    cik: string;
    tag: string;
    period: string;
    scope: RecastConflict["scope"];
    currentYear: number;
    ownFilingMemory: string;
    laterFilingMemory: string;
    ownFiling: RecastValue;
    laterFiling: RecastValue;
    runId?: string | null;
    evidenceIds?: string[];
  }): { conflict: RecastConflict; created: boolean } {
    const id = RecastConflictService.idFor(input.cik, input.tag, input.period, input.ownFiling.accn, input.laterFiling.accn);
    const existing = this.get(id);
    if (existing) {
      const add = (input.evidenceIds ?? []).filter((e) => !existing.evidence_ids.includes(e));
      if (add.length) {
        existing.evidence_ids.push(...add);
        this.persist();
      }
      return { conflict: existing, created: false };
    }
    const { chosen, text } = ruleR1(input.scope, input.currentYear);
    const now = new Date(this.host.clock()).toISOString();
    const conflict: RecastConflict = {
      id,
      kind: "recast_comparative",
      cik: input.cik,
      tag: input.tag,
      period: input.period,
      scope: input.scope,
      own_filing_memory: input.ownFilingMemory,
      later_filing_memory: input.laterFilingMemory,
      own_filing: input.ownFiling,
      later_filing: input.laterFiling,
      rule: "R1",
      rule_text: text,
      chosen,
      chosen_val: chosen === "own_filing" ? input.ownFiling.val : input.laterFiling.val,
      status: "resolved_by_rule",
      detected_at: now,
      run_id: input.runId ?? null,
      evidence_ids: [...(input.evidenceIds ?? [])],
    };
    this.host.ledger.log(conflict.own_filing_memory, "conflict_detected", this.host.actor, {
      details: { conflictId: id, kind: conflict.kind, with: conflict.later_filing_memory, period: input.period, tag: input.tag, own_filing: input.ownFiling, later_filing: input.laterFiling },
    });
    this.apply(conflict, this.host.actor, { rule: "R1", rule_text: text });
    this.conflicts.push(conflict);
    this.persist();
    return { conflict, created: true };
  }

  /** Marks the losing memory supersededBy the chosen one and logs the resolution. */
  private apply(c: RecastConflict, actor: string, details: Record<string, unknown>): void {
    const winner = c.chosen === "own_filing" ? c.own_filing_memory : c.later_filing_memory;
    const loser = c.chosen === "own_filing" ? c.later_filing_memory : c.own_filing_memory;
    const w = this.host.store.get(winner);
    const l = this.host.store.get(loser);
    if (w && w.supersededBy) this.host.store.update(winner, { supersededBy: undefined });
    if (l) this.host.store.update(loser, { supersededBy: winner });
    this.host.ledger.log(loser, "conflict_resolved", actor, { details: { conflictId: c.id, winner, loser, chosen: c.chosen, chosen_val: c.chosen_val, ...details } });
  }

  /**
   * The analyst's override of a resolution (the only write path, called by the server under
   * a verified high-risk override_recast contract whose id is recorded): the chosen side
   * wins, the ledger records who and why, and get_revenue uses chosen_val on the next run.
   */
  override(id: string, o: { chosen: RecastSide; reason: string; by?: string; contractId?: string | null }): RecastConflict {
    const c = this.get(id);
    if (!c) throw new Error(`no recast conflict ${id}`);
    if (o.chosen !== "own_filing" && o.chosen !== "later_filing") throw new Error(`chosen must be own_filing or later_filing, got ${String(o.chosen)}`);
    if (typeof o.reason !== "string" || !o.reason.trim()) throw new Error("an override needs a reason");
    const by = o.by ?? "analyst";
    c.chosen = o.chosen;
    c.chosen_val = o.chosen === "own_filing" ? c.own_filing.val : c.later_filing.val;
    c.status = "overridden";
    c.override = { by, chosen: o.chosen, reason: o.reason.trim(), at: new Date(this.host.clock()).toISOString(), contract_id: o.contractId ?? null };
    this.apply(c, by, { override: true, reason: c.override.reason, contract_id: c.override.contract_id });
    this.persist();
    return c;
  }
}
