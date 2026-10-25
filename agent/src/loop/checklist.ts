// The checklist of required steps for one question, owned by the host. The model sees it
// but never changes it: a tool result resolves an item, and the deterministic fallback step
// is always "the first available tool for the first open item".
//
// Status of an item:
//   pending      not done yet
//   done         a tool completed it (evidence ids attached)
//   na           does not apply to this question (no registrar wired, so nothing to register)
//   unavailable  the component is not wired in this build (recorded as a gap, never silently passed)
//   failed       the tool failed twice; the card reports the gap
// Adapted from Weather-or-Not and ClearShelf (same author, Apache-2.0); the items are Crosswalk's.

import { CHECKLIST_ITEMS, type ChecklistItemId, type ToolName } from "../llm/schemas.ts";

export type ItemStatus = "pending" | "done" | "na" | "unavailable" | "failed";

export interface ItemDef {
  id: ChecklistItemId;
  /** What the step establishes, in a few words (shown to the model and on the timeline). */
  label: string;
  /** Tools that can complete it; the first available one is the fallback step. */
  tools: ToolName[];
}

export interface ChecklistItem extends ItemDef {
  status: ItemStatus;
  note: string | null;
  evidenceIds: string[];
  /** Failed tool attempts so far; the second failure resolves the item as failed. */
  failures: number;
}

/** keys_measured needs this many measured keys (D14: a join map with >= 5 measured keys). */
export const MIN_MEASURED_KEYS = 5;

/** The steps of one question (SPEC section 3), in the order the fallback works through them. */
export const QUESTION_ITEMS: readonly ItemDef[] = [
  { id: "sources_found", label: "candidate sources found in the catalogue (negative memories flagged)", tools: ["search_catalogue"] },
  { id: "shapes_probed", label: "every target view described, sampled and its candidate key columns counted", tools: ["probe_source"] },
  { id: "keys_proposed", label: "up to six join keys proposed (planner, or the deterministic baseline as the fallback)", tools: ["propose_keys"] },
  { id: "keys_measured", label: `at least ${MIN_MEASURED_KEYS} keys measured in Lightning SQL (or recalled as verified from memory)`, tools: ["measure_key"] },
  { id: "sources_registered", label: "the sources the question needs registered (already_registered counts)", tools: ["register_source"] },
  { id: "usl_built", label: "semantic layer rendered from the verified keys: matches the governed model or a new version", tools: ["compile_usl"] },
  { id: "dq_run", label: "foreign-key DQ: two rules run live, the rest from the onboarding run", tools: ["compile_usl"] },
  { id: "answered", label: "answer table with per-cell provenance", tools: ["answer"] },
  { id: "not_tested_listed", label: "what the answer cannot see, listed", tools: ["not_tested"] },
  { id: "note_written", label: "note written, proposals scored against the baseline", tools: ["finalize"] },
];

/** The items that must be last; they may run only when every other item is resolved. */
export const FINAL_ITEMS: readonly ChecklistItemId[] = ["note_written"];

export class Checklist {
  private readonly items: ChecklistItem[];

  constructor(defs: readonly ItemDef[] = QUESTION_ITEMS) {
    this.items = defs.map((d) => ({ ...d, tools: [...d.tools], status: "pending", note: null, evidenceIds: [], failures: 0 }));
    for (const id of CHECKLIST_ITEMS) if (!this.has(id)) throw new Error(`checklist is missing item ${id}`);
  }

  static question(): Checklist {
    return new Checklist(QUESTION_ITEMS);
  }

  all(): readonly ChecklistItem[] {
    return this.items;
  }

  has(id: string): boolean {
    return this.items.some((i) => i.id === id);
  }

  get(id: string): ChecklistItem {
    const item = this.items.find((i) => i.id === id);
    if (!item) throw new Error(`checklist has no item ${id}`);
    return item;
  }

  set(id: string, status: ItemStatus, note: string | null = null, evidenceIds: string[] = []): void {
    const item = this.get(id);
    item.status = status;
    item.note = note;
    if (evidenceIds.length) item.evidenceIds = [...new Set([...item.evidenceIds, ...evidenceIds])];
  }

  /** Records a failed attempt; the second failure resolves the item as failed. Returns the new status. */
  fail(id: string, error: string): ItemStatus {
    const item = this.get(id);
    item.failures += 1;
    if (item.failures >= 2) {
      item.status = "failed";
      item.note = error;
    } else {
      item.note = `attempt ${item.failures} failed: ${error}`;
    }
    return item.status;
  }

  isResolved(id: string): boolean {
    return this.get(id).status !== "pending";
  }

  isDone(id: string): boolean {
    return this.get(id).status === "done";
  }

  pending(): ChecklistItem[] {
    return this.items.filter((i) => i.status === "pending");
  }

  /** Every item except the final ones is resolved, so finalize may run. */
  readyForFinal(): boolean {
    return this.items.every((i) => FINAL_ITEMS.includes(i.id) || i.status !== "pending");
  }

  /** Every item is resolved and the final items are done. */
  complete(): boolean {
    return this.items.every((i) => i.status !== "pending") && FINAL_ITEMS.every((id) => this.get(id).status === "done");
  }

  /** The first open item, in checklist order: what the deterministic fallback step works on. */
  firstPending(): ChecklistItem | undefined {
    return this.items.find((i) => i.status === "pending" && (!FINAL_ITEMS.includes(i.id) || this.readyForFinal()));
  }

  /** The model's view: resolved items are true. */
  booleans(): Record<string, boolean> {
    return Object.fromEntries(this.items.map((i) => [i.id, i.status !== "pending"]));
  }

  /** Compact status for the carryover state: "done", "todo", or the status with its note. */
  compact(): Record<string, string> {
    return Object.fromEntries(
      this.items.map((i) => {
        if (i.status === "pending") return [i.id, i.failures ? `todo (${i.note ?? "retry"})`.slice(0, 90) : "todo"];
        if (i.status === "done") return [i.id, i.note ? `done (${i.note})`.slice(0, 90) : "done"];
        return [i.id, `${i.status === "na" ? "n/a" : i.status}: ${i.note ?? ""}`.slice(0, 90)];
      }),
    );
  }

  /** Lines explaining the items that are resolved without being done. */
  notes(): string[] {
    return this.items.filter((i) => i.status !== "pending" && i.status !== "done").map((i) => `${i.id} ${i.status === "na" ? "n/a" : i.status}: ${i.note ?? ""}`);
  }

  /** Items that ended unavailable, failed or open: they are reported as gaps on the card. */
  unresolvedGaps(): ChecklistItem[] {
    return this.items.filter((i) => i.status === "unavailable" || i.status === "failed" || i.status === "pending");
  }

  snapshot(): Array<Pick<ChecklistItem, "id" | "status" | "note" | "evidenceIds">> {
    return this.items.map((i) => ({ id: i.id, status: i.status, note: i.note, evidenceIds: [...i.evidenceIds] }));
  }
}
