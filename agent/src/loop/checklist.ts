// The checklist of required steps for one question, owned by the host. The model sees it
// but never changes it: a tool result resolves an item, and the deterministic fallback step
// is always "the first available tool for the first open item".
//
// Status of an item:
//   pending      not done yet
//   done         a tool completed it (evidence ids attached)
//   na           does not apply to this question (no revenue fact under any tag, so nothing to attribute)
//   unavailable  the component is not wired in this build (recorded as a gap, never silently passed)
//   failed       the tool failed twice; the card reports the gap
// Adapted from ClearShelf (same author, Apache-2.0); the items are Weather-or-Not's.

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

/** The steps of one question (SPEC 7), in the order the fallback works through them. */
export const QUESTION_ITEMS: readonly ItemDef[] = [
  { id: "utility_resolved", label: "utility found in the seed list and its SEC profile read", tools: ["resolve_utility"] },
  { id: "tag_chosen", label: "revenue tag probed in the fixed order (or recalled from memory)", tools: ["probe_revenue_tag", "register_frames"] },
  { id: "revenue_like_for_like", label: "like-for-like growth from companyconcept with the recast check", tools: ["get_revenue"] },
  { id: "peers_loaded", label: "peer set from the seed utilities' frames facts, pooled across tags", tools: ["get_peers", "register_frames"] },
  { id: "weather_target", label: "degree days of the utility's stations for both quarters (Lightning SQL)", tools: ["get_weather"] },
  { id: "weather_peers", label: "degree days of every peer's stations for both quarters", tools: ["get_weather"] },
  { id: "dq_checked", label: "Zetaris DQ gate (coverage_ok onboarding run and the utility's own coverage)", tools: ["dq_gate"] },
  { id: "attribution_done", label: "three-way split with bootstrap ranges and confidence label", tools: ["attribute"] },
  { id: "claim_tested", label: "claim verdict recorded", tools: ["finalize"] },
  { id: "not_tested_listed", label: "what the analysis cannot see, listed", tools: ["not_tested"] },
  { id: "memo_written", label: "memo written and every number string-matched", tools: ["finalize"] },
];

/** The items that must be last; they may run only when every other item is resolved. */
export const FINAL_ITEMS: readonly ChecklistItemId[] = ["claim_tested", "memo_written"];

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
