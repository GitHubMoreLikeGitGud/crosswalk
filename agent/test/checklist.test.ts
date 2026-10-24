import { describe, expect, it } from "vitest";
import { EvidenceStore } from "../src/evidence/store.ts";
import { Checklist, FINAL_ITEMS, QUESTION_ITEMS } from "../src/loop/checklist.ts";
import { allowedTools, fallbackStep, newQuestionContext, type ToolDeps } from "../src/loop/tools.ts";
import { CHECKLIST_ITEMS } from "../src/llm/schemas.ts";
import { fakeGateway } from "./helpers/fakeGateway.ts";
import { syntheticSeeds, TARGET } from "./helpers/syntheticQuestion.ts";

function deps(withRegistrar = false): ToolDeps {
  const gw = fakeGateway(() => undefined);
  return { gateway: gw.client, ollama: null, evidence: new EvidenceStore("rtest", null), seeds: syntheticSeeds(), ...(withRegistrar ? { registrar: { register: async () => ({}) as never } } : {}) };
}

describe("checklist", () => {
  it("holds every schema item in fallback order and keeps the final items last", () => {
    const cl = Checklist.question();
    expect(cl.all().map((i) => i.id)).toEqual([...CHECKLIST_ITEMS]);
    expect(QUESTION_ITEMS.map((i) => i.id)).toEqual([...CHECKLIST_ITEMS]);
    expect(cl.complete()).toBe(false);
    expect(cl.readyForFinal()).toBe(false);
    expect(cl.firstPending()?.id).toBe("utility_resolved");
    for (const i of cl.all()) if (!FINAL_ITEMS.includes(i.id)) cl.set(i.id, "done");
    expect(cl.readyForFinal()).toBe(true);
    expect(cl.firstPending()?.id).toBe("claim_tested");
    cl.set("claim_tested", "done");
    cl.set("memo_written", "done");
    expect(cl.complete()).toBe(true);
  });

  it("fails an item on the second failed attempt and reports it as a gap", () => {
    const cl = Checklist.question();
    expect(cl.fail("weather_target", "timeout")).toBe("pending");
    expect(cl.compact().weather_target).toMatch(/^todo \(attempt 1 failed/u);
    expect(cl.fail("weather_target", "timeout")).toBe("failed");
    expect(cl.unresolvedGaps().map((i) => i.id)).toContain("weather_target");
    expect(cl.notes()).toEqual(["weather_target failed: timeout"]);
  });

  it("skips the final items while others are open and resolves without the final items being done", () => {
    const cl = Checklist.question();
    cl.set("not_tested_listed", "done");
    expect(cl.firstPending()?.id).toBe("utility_resolved");
    for (const id of CHECKLIST_ITEMS) if (!FINAL_ITEMS.includes(id)) cl.set(id, id === "attribution_done" ? "failed" : "done", id === "attribution_done" ? "no weather" : null);
    expect(cl.readyForFinal()).toBe(true);
    expect(cl.complete()).toBe(false);
  });
});

describe("deterministic fallback step", () => {
  it("walks the tools in checklist order from a fresh context", () => {
    const d = deps();
    const ctx = newQuestionContext(TARGET, "CY2025Q1", "colder weather", d.evidence);
    expect(allowedTools(ctx, d).map((t) => t.name)).toEqual(["resolve_utility", "not_tested"]);
    expect(fallbackStep(ctx, d)?.tool.name).toBe("resolve_utility");
    expect(fallbackStep(ctx, d)?.input).toEqual({ cik: TARGET });
    ctx.utility = d.seeds.utilities[0]!;
    ctx.checklist.set("utility_resolved", "done");
    expect(fallbackStep(ctx, d)?.tool.name).toBe("probe_revenue_tag");
    expect(fallbackStep(ctx, d)?.input).toEqual({ cik: TARGET, period: "CY2025Q1" });
    ctx.tag = "Revenues";
    ctx.checklist.set("tag_chosen", "done");
    expect(fallbackStep(ctx, d)?.tool.name).toBe("get_revenue");
    ctx.checklist.set("revenue_like_for_like", "done");
    expect(fallbackStep(ctx, d)?.tool.name).toBe("get_peers");
    ctx.checklist.set("peers_loaded", "done");
    expect(fallbackStep(ctx, d)?.tool.name).toBe("get_weather");
    // get_weather resolves two items; without a weather result the gate and the attribution stay unavailable.
    ctx.checklist.set("weather_target", "done");
    ctx.checklist.set("weather_peers", "done");
    expect(allowedTools(ctx, d).map((t) => t.name)).toEqual(["not_tested"]);
    expect(fallbackStep(ctx, d)?.tool.name).toBe("not_tested");
  });

  it("offers register_frames only while a frames period is missing and a registrar is wired", () => {
    const withReg = deps(true);
    const ctx = newQuestionContext(TARGET, "CY2025Q1", "x", withReg.evidence);
    ctx.utility = withReg.seeds.utilities[0]!;
    ctx.checklist.set("utility_resolved", "done");
    ctx.missingFrames.push({ tag: "Revenues", period: "CY2025Q1" });
    expect(allowedTools(ctx, withReg).map((t) => t.name)).toEqual(["register_frames", "not_tested"]);
    expect(fallbackStep(ctx, withReg)?.tool.name).toBe("register_frames");
    expect(fallbackStep(ctx, withReg)?.input).toEqual({ tag: "Revenues", period: "CY2025Q1" });
    const noReg = deps(false);
    const ctx2 = newQuestionContext(TARGET, "CY2025Q1", "x", noReg.evidence);
    ctx2.utility = noReg.seeds.utilities[0]!;
    ctx2.checklist.set("utility_resolved", "done");
    ctx2.missingFrames.push({ tag: "Revenues", period: "CY2025Q1" });
    expect(allowedTools(ctx2, noReg).map((t) => t.name)).toEqual(["not_tested"]);
  });

  it("allows finalize only when every other item is resolved", () => {
    const d = deps();
    const ctx = newQuestionContext(TARGET, "CY2025Q1", "x", d.evidence);
    for (const id of CHECKLIST_ITEMS) if (!FINAL_ITEMS.includes(id) && id !== "not_tested_listed") ctx.checklist.set(id, "failed", "test");
    expect(allowedTools(ctx, d).map((t) => t.name)).toEqual(["not_tested"]);
    ctx.checklist.set("not_tested_listed", "done");
    expect(allowedTools(ctx, d).map((t) => t.name)).toEqual(["finalize"]);
    expect(fallbackStep(ctx, d)?.item).toBe("claim_tested");
  });

  it("refuses a bad cik or period at context creation", () => {
    const ev = new EvidenceStore("r", null);
    expect(() => newQuestionContext("1031296", "CY2025Q1", "x", ev)).toThrow(/10 digits/u);
    expect(() => newQuestionContext(TARGET, "CY2025Q4", "x", ev)).toThrow(/Q1\.\.Q3/u);
    expect(() => newQuestionContext(TARGET, "CY2025", "x", ev)).toThrow(/Q1\.\.Q3/u);
  });
});
