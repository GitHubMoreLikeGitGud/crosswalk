// The planner session against a scripted model over the synthetic discovery fake: the repair round
// after an empty reply cut at num_predict runs with think off and the same schema and prompt plus the
// repair note (D3); a repair after any other error keeps think on; the planner output budget is 3,072
// tokens; the host context shows the probed columns when propose_keys is allowed; the run JSON carries
// the scored proposals, the join map and the verdict mix.
import { describe, expect, it } from "vitest";
import { OllamaClient } from "../src/llm/ollama.ts";
import { CHECKLIST_ITEMS } from "../src/llm/schemas.ts";
import { ADOPTED_JOB_SETTINGS } from "../src/llm/settings.ts";
import { repairWithoutThinking, toolContext } from "../src/loop/generator.ts";
import { investigate } from "../src/loop/investigate.ts";
import { allowedTools, newQuestionContext } from "../src/loop/tools.ts";
import { deps, manifest, NOW, Q } from "./helpers/discoveryFake.ts";

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
const state = (focus: string) => ({ focus, hypotheses: [], evidence_ids: [], open_contradictions: [], checklist, next: "next" });
const noAction = JSON.stringify({ thought: "The host runs the next step.", action: null, state: state("next step"), done: false });
const search = JSON.stringify({ thought: "Search the catalogue first.", action: { tool: "search_catalogue", input: { query: "FEMA disaster declarations utilities" } }, state: state("search"), done: false });

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

const QUESTION = "Which utilities served states with FEMA major disaster declarations?";

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

  it("repairs an empty length-cut reply with think off, the same schema and prompt plus the repair note; a parse-error repair keeps think on", async () => {
    const { ollama, seen } = scriptedModel([
      { content: "", done_reason: "length" },
      { content: search, done_reason: "stop" },
      { content: "I would probe next.", done_reason: "stop" },
      { content: noAction, done_reason: "stop" },
    ]);
    const r = await investigate({ question: QUESTION, quarter: Q, historyDir: null, think: true, now: NOW }, deps({ ollama }));
    expect(r.checklist_complete).toBe(true);
    const first = r.planner_calls[0]!;
    expect(first).toMatchObject({ chunk: 1, call: 1, attempts: 2, valid: true, valid_first_try: false, think: true, repair_think_off: true });
    expect(first.first_errors).toEqual(["parse: empty content (output cut at num_predict)"]);
    expect(r.chain[0]).toMatchObject({ tool: "search_catalogue", source: "model" });
    const [a, b] = seen;
    expect(a!.think).toBe(true);
    expect(b!.think).toBe(false);
    expect(a!.options.num_predict).toBe(3072);
    expect(b!.format).toEqual(a!.format);
    expect(b!.messages.slice(0, 2)).toEqual(a!.messages);
    expect(b!.messages[3]!.content).toMatch(/^That reply is not valid: parse: empty content \(output cut at num_predict\)\. Reply again with one JSON object/u);
    const second = r.planner_calls[1]!;
    expect(second).toMatchObject({ chunk: 1, call: 2, attempts: 2, valid: true, valid_first_try: false, repair_think_off: false });
    expect(seen[2]!.think).toBe(true);
    expect(seen[3]!.think).toBe(true);
    expect(r.summary.planner_repaired).toBe(2);
    expect(r.summary.planner_repairs_think_off).toBe(1);
    expect(r.markovian.chunks).toBeLessThanOrEqual(12);
    const planner = seen.filter((s) => "thought" in ((s.format as { properties?: Record<string, unknown> }).properties ?? {}));
    expect(planner.every((s) => s.options.num_predict === 3072)).toBe(true);
    expect(seen.length - planner.length).toBe(r.memo!.attempts);
  });

  it("counts a think-off repair that still fails, and the fallback step that follows", async () => {
    const { ollama } = scriptedModel([
      { content: "", done_reason: "length" },
      { content: "", done_reason: "length" },
    ]);
    const r = await investigate({ question: QUESTION, quarter: Q, historyDir: null, think: true, now: NOW }, deps({ ollama }));
    expect(r.planner_calls[0]).toMatchObject({ attempts: 2, valid: false, valid_first_try: false, repair_think_off: true });
    expect(r.chain[0]).toMatchObject({ tool: "search_catalogue", source: "fallback" });
    expect(r.chain[0]!.fallback_reason).toMatch(/planner reply invalid after a repair round/u);
    expect(r.checklist_complete).toBe(true);
  });
});

describe("the run JSON (L2, L3)", () => {
  it("records the baseline's scored proposals, the join map with the control, and the verdict mix", async () => {
    const r = await investigate({ question: QUESTION, quarter: Q, historyDir: null, now: NOW }, deps());
    expect(r.checklist_complete).toBe(true);
    expect(r.model_proposals.proposed_by).toBeNull();
    expect(r.baseline_proposals.made).toBe(6);
    expect(r.baseline_proposals.verified).toBeGreaterThanOrEqual(4);
    const control = r.join_map.find((k) => k.key.startsWith("cik_control"));
    expect(control).toMatchObject({ verdict: "REJECTED", matched_rows: 0, left_rows: 43, transform: "identity" });
    expect(r.verdict_mix.map((v) => v.kind)).toEqual(expect.arrayContaining(["REJECTED", "PARTIAL", "ABSENT"]));
    expect(r.telemetry.skipped_chunks).toBe(0);
    expect(r.tool_calls_detail.filter((t) => t.tool === "measure_key").every((t) => t.statements.length >= 1 && t.statements.every((s) => (s.sql ?? "").length > 0))).toBe(true);
  });

  it("shows the probed columns to the planner when propose_keys is allowed", () => {
    const d = deps();
    const ctx = newQuestionContext(QUESTION, Q, d.evidence, { now: NOW, manifest });
    ctx.probes.set("cw.states", { object: "cw.states", columns: [], sample: { columns: [], rows: [] }, candidates: [{ column: "fips", rows: 51, distinct: 51, non_null: 51, samples: ["06"] }], provenance: [], elapsed_ms: 0 });
    const tools = allowedTools(ctx, d).filter((t) => t.name === "search_catalogue");
    expect(toolContext(ctx, tools)).toBeNull();
    const text = toolContext(ctx, [{ ...tools[0]!, name: "propose_keys" }]);
    expect(text).toContain("cw.states: fips: 51 of 51; 06");
  });
});
