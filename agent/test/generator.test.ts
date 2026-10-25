// The planner session against a scripted model: the repair round after an empty reply cut at
// num_predict runs with think off and the same schema and prompt plus the repair note (D3);
// a repair after any other error keeps think on; the planner output budget is 3,072 tokens.
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EvidenceStore } from "../src/evidence/store.ts";
import { OllamaClient } from "../src/llm/ollama.ts";
import { CHECKLIST_ITEMS } from "../src/llm/schemas.ts";
import { ADOPTED_JOB_SETTINGS } from "../src/llm/settings.ts";
import { repairWithoutThinking } from "../src/loop/generator.ts";
import { investigate } from "../src/loop/investigate.ts";
import type { ToolDeps } from "../src/loop/tools.ts";
import { HMEM } from "../src/memory/hmemFacade.ts";
import { WeatherWorld } from "../src/world/world.ts";
import { fakeGateway } from "./helpers/fakeGateway.ts";
import { PERIOD, syntheticResolver, syntheticSeeds, TARGET } from "./helpers/syntheticQuestion.ts";

let clockMs = 1_700_000_000_000;
const clock = () => (clockMs += 1000);

interface Scripted {
  content: string;
  done_reason: string;
}

interface SeenRequest {
  think: boolean;
  format: unknown;
  messages: { role: string; content: string }[];
  options: Record<string, unknown>;
}

const checklist = Object.fromEntries(CHECKLIST_ITEMS.map((i) => [i, false]));
const noAction = JSON.stringify({ thought: "The host runs the next step.", action: null, state: { utility: "Target", hypotheses: [], evidence_ids: [], open_contradictions: [], checklist, next: "next" }, done: false });
const resolve = JSON.stringify({ thought: "Resolve the utility first.", action: { tool: "resolve_utility", input: { cik: TARGET } }, state: { utility: "Target", hypotheses: ["weather"], evidence_ids: [], open_contradictions: [], checklist, next: "probe the tag" }, done: false });

/** A model whose first replies follow the script, then always a valid reply with no action (the host falls back). */
function scriptedModel(script: Scripted[]): { ollama: OllamaClient; seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/api/ps")) return new Response(JSON.stringify({ models: [] }), { status: 200 });
    const body = JSON.parse(String(init?.body ?? "{}")) as SeenRequest;
    seen.push(body);
    const s = script[i++] ?? { content: noAction, done_reason: "stop" };
    return new Response(
      JSON.stringify({ message: { role: "assistant", content: s.content, thinking: s.content === "" ? "..." : "" }, done_reason: s.done_reason, prompt_eval_count: 1500, prompt_eval_duration: 100_000_000, eval_count: s.content === "" ? 3072 : 300, eval_duration: 2_000_000_000, total_duration: 2_200_000_000 }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { ollama: new OllamaClient({ baseUrl: "http://127.0.0.1:11434", model: "m", ramGuard: false, fetchImpl }), seen };
}

function deps(ollama: OllamaClient): ToolDeps {
  const seeds = syntheticSeeds();
  return {
    gateway: fakeGateway(syntheticResolver(seeds)).client,
    ollama,
    evidence: new EvidenceStore(`r${Math.random().toString(36).slice(2, 8)}`, null),
    seeds,
    hmem: new HMEM({ actor: "cw-agent", clock }),
    world: new WeatherWorld({ directory: null, clock: () => new Date(clock()) }),
    dqFile: path.join(os.tmpdir(), "cw-no-such-dq.json"),
  };
}

describe("planner repair policy (D3)", () => {
  it("asks the planner for 3,072 output tokens with think on", () => {
    expect(ADOPTED_JOB_SETTINGS.planner).toEqual({ think: true, num_predict: 3072 });
  });

  it("turns think off for the repair only after an empty reply cut at num_predict", () => {
    expect(repairWithoutThinking({ content: "", doneReason: "length" }, true)).toBe(true);
    expect(repairWithoutThinking({ content: "  \n", doneReason: "length" }, true)).toBe(true);
    expect(repairWithoutThinking({ content: "", doneReason: "stop" }, true)).toBe(false);
    expect(repairWithoutThinking({ content: "{\"thought\": \"cut", doneReason: "length" }, true)).toBe(false);
    expect(repairWithoutThinking({ content: "", doneReason: "length" }, false)).toBe(false);
  });

  it("repairs an empty length-cut reply with think off, the same schema and prompt plus the repair note; a wrong-tag repair keeps think on", async () => {
    const { ollama, seen } = scriptedModel([
      // call 1.1: empty reply, the thinking ate the budget -> repair with think off, valid.
      { content: "", done_reason: "length" },
      { content: resolve, done_reason: "stop" },
      // call 1.2: not JSON -> repair with think on, then a valid no-action reply (fallback step).
      { content: "I would probe the tag next.", done_reason: "stop" },
      { content: noAction, done_reason: "stop" },
    ]);
    const r = await investigate({ cik: TARGET, period: PERIOD, claim: "colder weather", historyDir: null, think: true }, deps(ollama));
    expect(r.checklist_complete).toBe(true);

    const first = r.planner_calls[0]!;
    expect(first).toMatchObject({ chunk: 1, call: 1, attempts: 2, valid: true, valid_first_try: false, think: true, repair_think_off: true });
    expect(first.first_errors).toEqual(["parse: empty content (output cut at num_predict)"]);
    expect(first.chosen).toEqual({ tool: "resolve_utility", input: { cik: TARGET } });
    expect(r.timeline[0]).toMatchObject({ tool: "resolve_utility", source: "model" });

    const [a, b] = seen;
    expect(a!.think).toBe(true);
    expect(b!.think).toBe(false);
    expect(a!.options.num_predict).toBe(3072);
    expect(b!.options.num_predict).toBe(3072);
    expect(b!.format).toEqual(a!.format);
    expect(b!.messages.slice(0, 2)).toEqual(a!.messages);
    expect(b!.messages).toHaveLength(4);
    expect(b!.messages[2]).toEqual({ role: "assistant", content: "" });
    expect(b!.messages[3]!.content).toMatch(/^That reply is not valid: parse: empty content \(output cut at num_predict\)\. Reply again with one JSON object/u);

    const second = r.planner_calls[1]!;
    expect(second).toMatchObject({ chunk: 1, call: 2, attempts: 2, valid: true, valid_first_try: false, repair_think_off: false });
    expect(seen[2]!.think).toBe(true);
    expect(seen[3]!.think).toBe(true);
    expect(seen[3]!.messages[3]!.content).toMatch(/^That reply is not valid: parse: /u);

    expect(r.summary.planner_repaired).toBe(2);
    expect(r.summary.planner_repairs_think_off).toBe(1);
    // Every later call was valid first try with no action, so the host took the fallback steps.
    expect(r.planner_calls.slice(2).every((c) => c.valid_first_try && !c.repair_think_off)).toBe(true);
    expect(r.summary.fallback_steps).toBe(r.summary.tool_calls - 1);
    // Every planner request (the memo job has its own budget) carried the raised budget.
    const planner = seen.filter((s) => "thought" in ((s.format as { properties?: Record<string, unknown> }).properties ?? {}));
    expect(planner.length).toBe(r.planner_calls.reduce((n, c) => n + c.attempts, 0));
    expect(planner.every((s) => s.options.num_predict === 3072)).toBe(true);
    expect(seen.length - planner.length).toBe(r.card.memo!.attempts);
  });

  it("counts a think-off repair that still fails, and the fallback step that follows", async () => {
    const { ollama } = scriptedModel([
      { content: "", done_reason: "length" },
      { content: "", done_reason: "length" },
    ]);
    const r = await investigate({ cik: TARGET, period: PERIOD, claim: "colder weather", historyDir: null, think: true }, deps(ollama));
    const first = r.planner_calls[0]!;
    expect(first).toMatchObject({ attempts: 2, valid: false, valid_first_try: false, repair_think_off: true });
    expect(r.timeline[0]).toMatchObject({ tool: "resolve_utility", source: "fallback" });
    expect(r.timeline[0]!.fallback_reason).toMatch(/planner reply invalid after a repair round/u);
    expect(r.summary.planner_repaired).toBe(0);
    expect(r.summary.planner_repairs_think_off).toBe(1);
    expect(r.checklist_complete).toBe(true);
  });
});
