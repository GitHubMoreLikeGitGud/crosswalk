import { describe, expect, it } from "vitest";
import { CHECKLIST_ITEMS, memoSchema, minerSchema, plannerSchema, plannerSemanticErrors, validate, type PlannerOutput } from "../src/llm/schemas.ts";
import { OllamaClient, assertLoopbackUrl, parseJsonContent, refusedModelHostAttempts, resetRefusedModelHostAttempts } from "../src/llm/ollama.ts";
import { ADOPTED_JOB_SETTINGS, jobSettings, type JobName } from "../src/llm/settings.ts";
import { TOOL_CATALOG, toolSpecs } from "../src/llm/toolCatalog.ts";
import { loadPrompt, render, toolLines } from "../src/llm/prompts.ts";

const ALL_FALSE = Object.fromEntries(CHECKLIST_ITEMS.map((i) => [i, false]));

describe("planner schema", () => {
  it("builds a planner schema whose tool and evidence enums are dynamic and whose checklist is fixed", () => {
    const schema = plannerSchema(["resolve_utility", "not_tested"], ["ev-1"]);
    const out: PlannerOutput = {
      thought: "Resolve the utility first.",
      action: { tool: "resolve_utility", input: { cik: "0001031296" } },
      state: { utility: "0001031296", hypotheses: ["weather"], evidence_ids: ["ev-1"], open_contradictions: [], checklist: { ...ALL_FALSE }, next: "probe the tag" },
      done: false,
    };
    expect(validate(schema, out)).toEqual([]);
    expect(validate(schema, { ...out, action: null })).toEqual([]);
    expect(validate(schema, { ...out, action: { tool: "finalize", input: {} } })).toEqual(["$.action: matches no allowed shape"]);
    expect(validate(schema, { ...out, action: { tool: "resolve_utility", input: { cik: "1031296" } } })).toEqual(["$.action: matches no allowed shape"]);
    expect(validate(schema, { ...out, state: { ...out.state, evidence_ids: ["ev-9"] } }).length).toBe(1);
    expect(validate(schema, { ...out, state: { ...out.state, checklist: { utility_resolved: true } } }).length).toBeGreaterThan(0);
    expect(validate(plannerSchema(["resolve_utility"]), out).some((e) => e.includes("evidence_ids"))).toBe(true);
    expect(() => plannerSchema(["shell.exec"])).toThrow(/unknown tool/u);
    expect(() => plannerSchema([])).toThrow(/at least one tool/u);
  });

  it("accepts a tag only from the three-tag enum", () => {
    const schema = plannerSchema(["get_revenue"]);
    const base: PlannerOutput = { thought: "x", action: { tool: "get_revenue", input: { tag: "Revenues" } }, state: { utility: "u", hypotheses: [], evidence_ids: [], open_contradictions: [], checklist: { ...ALL_FALSE }, next: "" }, done: false };
    expect(validate(schema, base)).toEqual([]);
    expect(validate(schema, { ...base, action: { tool: "get_revenue", input: { tag: "NetIncomeLoss" } } })).toEqual(["$.action: matches no allowed shape"]);
  });

  it("flags long thoughts and done-with-action", () => {
    const base: PlannerOutput = {
      thought: Array(61).fill("word").join(" "),
      action: { tool: "resolve_utility", input: {} },
      state: { utility: "u", hypotheses: [], evidence_ids: [], open_contradictions: [], checklist: {}, next: "" },
      done: true,
    };
    expect(plannerSemanticErrors(base)).toHaveLength(2);
  });

  it("shapes the memo and the H-MEM miner reply", () => {
    expect(validate(memoSchema, { memo: "x".repeat(200) })).toEqual([]);
    expect(validate(memoSchema, { memo: "short" })).toHaveLength(1);
    expect(validate(minerSchema, ["Zetaris caches a view driver-wide."])).toEqual([]);
    expect(validate(minerSchema, { memories: [] })).toHaveLength(1);
  });
});

describe("tool catalog and prompts", () => {
  it("describes every tool and the checklist items it completes", () => {
    const names = Object.keys(TOOL_CATALOG);
    expect(names).toHaveLength(10);
    const completed = new Set(names.flatMap((n) => TOOL_CATALOG[n as keyof typeof TOOL_CATALOG].completes));
    for (const item of CHECKLIST_ITEMS) expect(completed.has(item), item).toBe(true);
    const lines = toolLines(toolSpecs(["resolve_utility", "finalize"]));
    expect(lines).toContain("- resolve_utility:");
    expect(lines).toContain("Completes: claim_tested, memo_written");
  });

  it("renders the planner and memo prompts for this domain, with no leftover from the sister project", () => {
    const planner = render(loadPrompt("planner"), { chain_label: "test", tools: "- x" });
    expect(planner).toContain("Weather-or-Not");
    expect(planner).toContain("finalize is used only after");
    const memo = loadPrompt("memo");
    expect(memo).toContain("ALLOWED NUMBERS");
    for (const text of [planner, memo]) expect(text).not.toMatch(/clearshelf|allergen|gtin|recall/iu);
    expect(() => render("{{missing}}", {})).toThrow(/no value/u);
  });
});

describe("job settings", () => {
  it("keeps the memo think off and forces think off everywhere with WON_THINK=off", () => {
    expect(jobSettings("memo", {}).think).toBe(false);
    expect(jobSettings("planner", {})).toEqual(ADOPTED_JOB_SETTINGS.planner);
    for (const job of Object.keys(ADOPTED_JOB_SETTINGS) as JobName[]) {
      expect(jobSettings(job, { WON_THINK: "off" }).think).toBe(false);
    }
  });
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function mockFetch(replies: Array<Record<string, unknown>>, seen: unknown[] = []): typeof fetch {
  let i = 0;
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/api/ps")) return json({ models: [] });
    seen.push(JSON.parse(String(init?.body)));
    const body = replies[Math.min(i++, replies.length - 1)];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

const reply = (content: string) => ({
  message: { role: "assistant", content, thinking: "t" },
  done_reason: "stop",
  prompt_eval_count: 100,
  prompt_eval_duration: 50_000_000,
  eval_count: 40,
  eval_duration: 400_000_000,
  load_duration: 1_000_000,
  total_duration: 500_000_000,
});

describe("OllamaClient", () => {
  it("refuses non-loopback hosts and counts every refused attempt", () => {
    resetRefusedModelHostAttempts();
    expect(() => assertLoopbackUrl("https://api.example.com")).toThrow(/non-local/u);
    expect(() => new OllamaClient({ baseUrl: "http://10.0.0.5:11434" })).toThrow(/non-local/u);
    expect(assertLoopbackUrl("http://127.0.0.1:11434").port).toBe("11434");
    expect(refusedModelHostAttempts()).toBe(2);
  });

  it("reports a failed /api/ps instead of reading it as no models", async () => {
    const client = new OllamaClient({ baseUrl: "http://127.0.0.1:11434", ramGuard: false, fetchImpl: (async () => json({ error: "boom" }, 500)) as typeof fetch });
    await expect(client.loaded()).rejects.toThrow(/HTTP 500/u);
  });

  it("sends schema, think and pinned options, and reports measured metrics", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const client = new OllamaClient({ baseUrl: "http://127.0.0.1:11434", model: "m", ramGuard: false, fetchImpl: mockFetch([reply('{"memo":"x"}')], seen) });
    const r = await client.chat({ messages: [{ role: "user", content: "hi" }], schema: memoSchema, think: true });
    expect(seen[0]!.format).toEqual(memoSchema);
    expect(seen[0]!.think).toBe(true);
    expect(seen[0]!.stream).toBe(false);
    expect(seen[0]!.options).toMatchObject({ temperature: 0, seed: 7, num_ctx: 8192 });
    expect(r.metrics.label).toBe("measured");
    expect(r.metrics.tokensPerSecond).toBeCloseTo(100, 5);
    expect(r.thinking).toBe("t");
  });

  it("retries an invalid reply once, then gives up", async () => {
    const ok = new OllamaClient({ baseUrl: "http://127.0.0.1:11434", ramGuard: false, fetchImpl: mockFetch([reply("not json"), reply(`{"memo":"${"y".repeat(200)}"}`)]) });
    const r1 = await ok.chatJson<{ memo: string }>({ messages: [], schema: memoSchema });
    expect(r1.ok).toBe(true);
    expect(r1.attempts).toHaveLength(2);
    const bad = new OllamaClient({ baseUrl: "http://127.0.0.1:11434", ramGuard: false, fetchImpl: mockFetch([reply('{"memo":"short"}')]) });
    const r2 = await bad.chatJson({ messages: [], schema: memoSchema });
    expect(r2.ok).toBe(false);
    expect(r2.attempts).toHaveLength(2);
  });

  it("parses fenced JSON defensively", () => {
    expect(parseJsonContent('```json\n{"a":1}\n```').value).toEqual({ a: 1 });
    expect(parseJsonContent("").error).toBe("empty content");
  });
});
