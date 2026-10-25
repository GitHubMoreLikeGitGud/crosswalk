import { describe, expect, it } from "vitest";
import { Checklist, FINAL_ITEMS, MIN_MEASURED_KEYS, QUESTION_ITEMS } from "../src/loop/checklist.ts";
import { CHECKLIST_ITEMS } from "../src/llm/schemas.ts";
import { TOOL_CATALOG } from "../src/llm/toolCatalog.ts";

describe("the discovery checklist", () => {
  it("has the ten items in the schema's order, each completed by a catalogued tool", () => {
    expect(QUESTION_ITEMS.map((i) => i.id)).toEqual([...CHECKLIST_ITEMS]);
    expect(CHECKLIST_ITEMS).toEqual(["sources_found", "shapes_probed", "keys_proposed", "keys_measured", "sources_registered", "usl_built", "dq_run", "answered", "not_tested_listed", "note_written"]);
    for (const item of QUESTION_ITEMS) for (const t of item.tools) expect(TOOL_CATALOG[t].completes, `${t} -> ${item.id}`).toContain(item.id);
    expect(FINAL_ITEMS).toEqual(["note_written"]);
    expect(MIN_MEASURED_KEYS).toBe(5);
    expect(QUESTION_ITEMS.find((i) => i.id === "keys_measured")!.label).toContain("at least 5 keys");
  });

  it("keeps the final item closed until every other item is resolved", () => {
    const cl = Checklist.question();
    expect(cl.firstPending()!.id).toBe("sources_found");
    for (const id of CHECKLIST_ITEMS) if (id !== "note_written") cl.set(id, id === "sources_registered" ? "unavailable" : "done");
    expect(cl.readyForFinal()).toBe(true);
    expect(cl.complete()).toBe(false);
    expect(cl.unresolvedGaps().map((i) => i.id)).toEqual(["sources_registered", "note_written"]);
    cl.set("note_written", "done");
    expect(cl.complete()).toBe(true);
  });

  it("fails an item on the second failed attempt and reports it compactly", () => {
    const cl = Checklist.question();
    expect(cl.fail("keys_proposed", "no valid choice")).toBe("pending");
    expect(cl.compact().keys_proposed).toBe("todo (attempt 1 failed: no valid choice)");
    expect(cl.fail("keys_proposed", "no valid choice")).toBe("failed");
    expect(cl.notes()).toEqual(["keys_proposed failed: no valid choice"]);
    expect(cl.booleans().keys_proposed).toBe(true);
  });
});
