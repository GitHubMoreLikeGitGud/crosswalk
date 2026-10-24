import { describe, expect, it } from "vitest";
import { lengthAccepted, MEMO_WORDS, numberTokens, templateMemo, unknownNumbers, writeMemo, type MemoInput } from "../src/llm/memo.ts";
import { OllamaClient } from "../src/llm/ollama.ts";
import { wordCount } from "../src/llm/schemas.ts";

const input: MemoInput = {
  utility: "Target Electric Corp",
  cik: "0000000001",
  period: "CY2025Q1",
  claim: "colder weather",
  verdict: "supported",
  confidence: "high",
  dq: "pass",
  findings: ["Revenue rose from 1,000.0 million to 1,150.0 million, a like-for-like change of +15.0%.", "The weather part is +9.0% [+2.0%, +14.0%]."],
  notTested: ["Fuel-cost pass-through inside revenue", "Rate cases"],
  allowed: [
    { label: "year", text: "2025" },
    { label: "previous year", text: "2024" },
    { label: "quarter", text: "1" },
    { label: "revenue current", text: "1,150.0" },
    { label: "revenue previous", text: "1,000.0" },
    { label: "g", text: "+15.0%" },
    { label: "weather", text: "+9.0%" },
    { label: "weather lo", text: "+2.0%" },
    { label: "weather hi", text: "+14.0%" },
  ],
};

const reply = (content: string) => ({ message: { role: "assistant", content }, done_reason: "stop", prompt_eval_count: 500, prompt_eval_duration: 100_000_000, eval_count: 200, eval_duration: 2_000_000_000, total_duration: 2_200_000_000 });

function ollamaWith(contents: string[]): OllamaClient {
  let i = 0;
  const fetchImpl = (async (url: string | URL | Request) => {
    if (String(url).endsWith("/api/ps")) return new Response(JSON.stringify({ models: [] }), { status: 200 });
    return new Response(JSON.stringify(reply(contents[Math.min(i++, contents.length - 1)]!)), { status: 200 });
  }) as typeof fetch;
  return new OllamaClient({ baseUrl: "http://127.0.0.1:11434", model: "m", ramGuard: false, fetchImpl });
}

const words = (n: number, lead: string) => `${lead} ${Array.from({ length: n }, (_, i) => String.fromCharCode(97 + (i % 26)).repeat(3 + (i % 4))).join(" ")}.`;
/** A memo of exactly `n` words that opens with `lead` (the lead carries the numbers). */
const exactWords = (n: number, lead: string) => words(n - wordCount(lead), lead);
const ALL_MATCH = "Weather accounts for roughly +9.0% [+2.0%, +14.0%] of the +15.0% change in Q1 2025 versus 2024 from 1,000.0 million to 1,150.0 million, consistent with the claim.";

describe("memo number check", () => {
  it("finds every number-like token, with sign and percent sign", () => {
    expect(numberTokens("Revenue rose +15.0% to 1,150.0 million in Q1 2025 (−2.6%).")).toEqual(["+15.0%", "1,150.0", "1", "2025", "-2.6%"]);
  });

  it("accepts only the allowed numbers, ignoring a leading plus sign but not the percent sign", () => {
    expect(unknownNumbers("In Q1 2025 revenue rose 15.0% to 1,150.0 million; weather +9.0% [+2.0%, +14.0%].", input.allowed)).toEqual([]);
    expect(unknownNumbers("Revenue rose 15.0 percent, about 14.5% of 3,765 million.", input.allowed)).toEqual(["15.0", "14.5%", "3,765"]);
    expect(unknownNumbers("A 10-Q filing.", input.allowed)).toEqual(["10"]);
  });

  it("writes the template memo from the findings with the allowed numbers only", () => {
    const t = templateMemo(input);
    expect(unknownNumbers(t, input.allowed)).toEqual([]);
    expect(t).toContain("supported");
    expect(t).toContain("Not tested");
  });
});

describe("writeMemo", () => {
  it("keeps a first draft whose numbers all match", async () => {
    const memo = words(160, "Weather accounts for roughly +9.0% [+2.0%, +14.0%] of the +15.0% change in Q1 2025 versus 2024 from 1,000.0 million to 1,150.0 million, consistent with the claim.");
    const r = await writeMemo(ollamaWith([JSON.stringify({ memo })]), input);
    expect(r.source).toBe("model");
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]!.ok).toBe(true);
    expect(r.attempts[0]!.metrics?.tokensPerSecond).toBeCloseTo(100, 5);
  });

  it("rejects a draft with a number that is not a tool output, retries once with the rejected numbers named, then keeps the retry", async () => {
    const bad = words(160, "Revenue rose 14.5% from 3,287 million, consistent with the claim.");
    const good = words(160, "Revenue rose +15.0% from 1,000.0 million to 1,150.0 million; weather +9.0% [+2.0%, +14.0%].");
    const r = await writeMemo(ollamaWith([JSON.stringify({ memo: bad }), JSON.stringify({ memo: good })]), input);
    expect(r.source).toBe("model");
    expect(r.attempts).toHaveLength(2);
    expect(r.attempts[0]!.ok).toBe(false);
    expect(r.attempts[0]!.unknownNumbers).toEqual(["14.5%", "3,287"]);
    expect(r.attempts[1]!.ok).toBe(true);
  });

  it("falls back to the template memo after two rejected drafts, recording both", async () => {
    const bad = words(160, "Revenue rose 14.5% last year.");
    const r = await writeMemo(ollamaWith([JSON.stringify({ memo: bad }), "not json at all"]), input);
    expect(r.source).toBe("template");
    expect(r.attempts).toHaveLength(2);
    expect(r.attempts[0]!.unknownNumbers).toEqual(["14.5%"]);
    expect(r.attempts[1]!.parseError).toMatch(/JSON/u);
    expect(unknownNumbers(r.text, input.allowed)).toEqual([]);
  });

  it("rejects a draft far outside the word budget", async () => {
    const r = await writeMemo(ollamaWith([JSON.stringify({ memo: words(400, "Long memo at +15.0%.") })]), input, { maxAttempts: 1 });
    expect(r.source).toBe("template");
    expect(r.attempts[0]!.schemaErrors[0]).toMatch(/words/u);
  });

  describe("length policy (D2): kept at 100 to 250 words when every number matches", () => {
    it("accepts exactly the band edges and nothing outside them", () => {
      expect(MEMO_WORDS).toEqual({ min: 150, max: 250, accept_min: 100 });
      expect(lengthAccepted(99)).toBe(false);
      expect(lengthAccepted(100)).toBe(true);
      expect(lengthAccepted(135)).toBe(true);
      expect(lengthAccepted(250)).toBe(true);
      expect(lengthAccepted(251)).toBe(false);
    });

    it("keeps a 100-word first draft and a 250-word first draft", async () => {
      for (const n of [100, 250]) {
        const memo = exactWords(n, ALL_MATCH);
        expect(wordCount(memo)).toBe(n);
        const r = await writeMemo(ollamaWith([JSON.stringify({ memo })]), input);
        expect(r.source, `${n} words`).toBe("model");
        expect(r.attempts).toHaveLength(1);
        expect(r.wordCount).toBe(n);
      }
    });

    it("rejects a 99-word draft, asks for the 150-word target with the paragraphs to add, then keeps a 100-word retry", async () => {
      const short = exactWords(99, ALL_MATCH);
      const seen: string[] = [];
      let i = 0;
      const replies = [JSON.stringify({ memo: short }), JSON.stringify({ memo: exactWords(100, ALL_MATCH) })];
      const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: { content: string }[] };
        seen.push(body.messages?.map((m) => m.content).join("\n") ?? "");
        return new Response(JSON.stringify(reply(replies[Math.min(i++, replies.length - 1)]!)), { status: 200 });
      }) as typeof fetch;
      const r = await writeMemo(new OllamaClient({ baseUrl: "http://127.0.0.1:11434", model: "m", ramGuard: false, fetchImpl }), input);
      expect(r.source).toBe("model");
      expect(r.attempts).toHaveLength(2);
      expect(r.attempts[0]!.ok).toBe(false);
      expect(r.attempts[0]!.schemaErrors[0]).toBe("memo: 99 words, wanted 100 to 250");
      expect(r.attempts[0]!.unknownNumbers).toEqual([]);
      expect(seen[1]).toContain("it had 99 words; write at least 170 words this time, adding a paragraph on the industry-wide part and the remainder with their ranges and one on what was not tested, with the same numbers.");
      expect(r.attempts[1]!.ok).toBe(true);
      expect(r.wordCount).toBe(100);
    });

    it("rejects a 251-word draft and asks for a cut to 250", async () => {
      const r = await writeMemo(ollamaWith([JSON.stringify({ memo: exactWords(251, ALL_MATCH) })]), input, { maxAttempts: 1 });
      expect(r.source).toBe("template");
      expect(r.attempts[0]!.schemaErrors[0]).toBe("memo: 251 words, wanted 100 to 250");
    });

    it("never keeps a draft with an unknown number, whatever its length", async () => {
      for (const n of [100, 180, 250]) {
        const memo = exactWords(n, "Revenue rose 14.5% from 3,287 million, consistent with the claim.");
        const r = await writeMemo(ollamaWith([JSON.stringify({ memo })]), input, { maxAttempts: 1 });
        expect(r.source, `${n} words`).toBe("template");
        expect(r.attempts[0]!.unknownNumbers).toEqual(["14.5%", "3,287"]);
      }
    });
  });

  it("uses the template when no model is wired", async () => {
    const r = await writeMemo(null, input);
    expect(r.source).toBe("template");
    expect(r.attempts).toHaveLength(0);
  });
});
