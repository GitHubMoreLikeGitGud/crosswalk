// The memo job (SPEC 2 step 12): Nemotron writes 150-250 words from the numbers the tools
// computed, think off, JSON output. The host checks every number in the draft by string
// match against the allowed numbers (the formatted tool outputs): a draft with any other
// number is rejected and the model gets one retry that names the rejected numbers; a
// second rejection falls back to the deterministic template memo. Length policy (D2): a
// draft whose numbers all match is kept at 100 to 250 words; below 100, above 250 or on an
// unknown number the draft is rejected (the retry asks for the 150-word target), and the
// template memo is the last resort. Nothing here computes.

import type { ChatResult, OllamaClient } from "./ollama.ts";
import { fenceUntrusted, loadPrompt } from "./prompts.ts";
import { memoSchema, wordCount, type MemoOutput } from "./schemas.ts";
import { jobSettings } from "./settings.ts";

/** One formatted tool output the memo may quote. */
export interface AllowedNumber {
  label: string;
  text: string;
}

export interface MemoInput {
  utility: string;
  cik: string;
  period: string;
  claim: string;
  verdict: string;
  confidence: string;
  dq: string;
  /** Lines the model explains, each naming its number(s) exactly as in `allowed`. */
  findings: string[];
  notTested: string[];
  allowed: AllowedNumber[];
}

export interface MemoAttempt {
  attempt: number;
  ok: boolean;
  parseError: string | null;
  schemaErrors: string[];
  unknownNumbers: string[];
  wordCount: number;
  metrics: ChatResult["metrics"] | null;
  promptSha256: string | null;
  error: string | null;
}

export interface MemoResult {
  text: string;
  source: "model" | "template";
  attempts: MemoAttempt[];
  allowed: AllowedNumber[];
  wordCount: number;
  model: string;
}

/** `min` is the target the model is asked for; `accept_min` is the shortest draft the host keeps. */
export const MEMO_WORDS = { min: 150, max: 250, accept_min: 100 } as const;

/** D2: a draft is kept when every number matches and it has 100 to 250 words. */
export function lengthAccepted(words: number): boolean {
  return words >= MEMO_WORDS.accept_min && words <= MEMO_WORDS.max;
}

/** Unicode minus and figure dashes read as a plain minus sign. */
function normaliseSigns(s: string): string {
  return s.replace(/[−‒–]/gu, "-");
}

/** Every number-like token in a text: optional sign, digits with thousands groups, optional decimals, optional percent sign. */
export function numberTokens(text: string): string[] {
  return [...normaliseSigns(text).matchAll(/[-+]?\d+(?:,\d{3})*(?:\.\d+)?%?/gu)].map((m) => m[0]);
}

/** A token with its leading plus sign removed (a minus sign stays): "+14.5%" and "14.5%" are the same number. */
export function normaliseNumber(token: string): string {
  return normaliseSigns(token).replace(/^\+/u, "");
}

/** The numbers in `memo` that are not in the allowed list, in order of appearance (each once). */
export function unknownNumbers(memo: string, allowed: readonly AllowedNumber[]): string[] {
  const ok = new Set(allowed.map((a) => normaliseNumber(a.text)));
  const out: string[] = [];
  for (const tok of numberTokens(memo)) {
    const n = normaliseNumber(tok);
    if (!ok.has(n) && !out.includes(tok)) out.push(tok);
  }
  return out;
}

/** Deterministic fallback: the same findings as prose, every number from the allowed list. */
export function templateMemo(m: MemoInput): string {
  const paras = [
    `Crosswalk checked ${m.utility}'s ${m.period} revenue change against management's claim of "${m.claim}". ${m.findings[0] ?? ""}`.trim(),
    m.findings.slice(1, 4).join(" "),
    m.findings.slice(4).join(" "),
    `Verdict: the claim is ${m.verdict}; confidence ${m.confidence}; data-quality gate ${m.dq}. Not tested: ${m.notTested.join("; ")}.`,
  ];
  return paras.filter((p) => p.trim().length > 0).join("\n\n");
}

function requestText(m: MemoInput, feedback: string | null): string {
  const allowed = m.allowed.map((a) => `- ${a.label}: ${a.text}`).join("\n");
  return [
    `Utility: ${fenceUntrusted(m.utility)} (CIK ${m.cik}), period ${m.period}.`,
    `Management's claim: ${fenceUntrusted(m.claim)}`,
    `Verdict (fixed, do not change): ${m.verdict}. Confidence label: ${m.confidence}. DQ gate: ${m.dq}.`,
    `FINDINGS (explain these):\n${m.findings.map((f) => `- ${f}`).join("\n")}`,
    `ALLOWED NUMBERS (the only numbers you may write, copied exactly):\n${allowed}`,
    `NOT TESTED:\n${m.notTested.map((n) => `- ${n}`).join("\n")}`,
    feedback,
    `Write the memo now as {"memo": "..."}: at least ${MEMO_WORDS.min + 20} words and at most ${MEMO_WORDS.max} words, one paragraph each for the revenue change and the weather, the peer sensitivity and the three parts with their ranges, the verdict with the confidence label and the DQ gate, and what was not tested.`,
  ]
    .filter((x): x is string => x !== null)
    .join("\n\n");
}

/**
 * Drafts the memo with the model (two attempts at most), checks every number by string
 * match and the word count, and falls back to the template memo. Every attempt is recorded
 * with its measured token counts so the run reports how often the model needed the retry.
 */
export async function writeMemo(ollama: OllamaClient | null, input: MemoInput, opts: { maxAttempts?: number; signal?: AbortSignal } = {}): Promise<MemoResult> {
  const attempts: MemoAttempt[] = [];
  const settings = jobSettings("memo");
  const max = ollama ? (opts.maxAttempts ?? 2) : 0;
  let feedback: string | null = null;
  for (let i = 1; i <= max; i++) {
    const messages = [
      { role: "system" as const, content: loadPrompt("memo") },
      { role: "user" as const, content: requestText(input, feedback) },
    ];
    let res: ChatResult;
    try {
      res = await ollama!.chat({ messages, schema: memoSchema, think: settings.think, options: { num_predict: settings.num_predict }, signal: opts.signal });
    } catch (e) {
      attempts.push({ attempt: i, ok: false, parseError: null, schemaErrors: [], unknownNumbers: [], wordCount: 0, metrics: null, promptSha256: null, error: (e as Error).message.slice(0, 200) });
      continue;
    }
    let value: MemoOutput | null = null;
    let parseError: string | null = null;
    try {
      value = JSON.parse(res.content.trim()) as MemoOutput;
    } catch (e) {
      parseError = `${(e as Error).message}${res.doneReason === "length" ? " (output cut at num_predict)" : ""}`;
    }
    const schemaErrors: string[] = [];
    if (value && (typeof value !== "object" || typeof value.memo !== "string")) schemaErrors.push("memo: not a string");
    const memo = value && typeof value.memo === "string" ? value.memo.trim() : "";
    const unknown = memo ? unknownNumbers(memo, input.allowed) : [];
    const words = wordCount(memo);
    const lengthOk = lengthAccepted(words);
    if (memo && !lengthOk) schemaErrors.push(`memo: ${words} words, wanted ${MEMO_WORDS.accept_min} to ${MEMO_WORDS.max}`);
    const ok = parseError === null && schemaErrors.length === 0 && unknown.length === 0;
    attempts.push({ attempt: i, ok, parseError, schemaErrors, unknownNumbers: unknown, wordCount: words, metrics: res.metrics, promptSha256: res.promptSha256, error: null });
    if (ok) return { text: memo, source: "model", attempts, allowed: input.allowed, wordCount: words, model: res.model };
    feedback = [
      "Your previous draft was rejected:",
      ...(parseError ? [`- it was not valid JSON (${parseError})`] : []),
      ...schemaErrors.map((e) => `- ${e}`),
      ...(memo && words < MEMO_WORDS.min ? [`- it had ${words} words; write at least ${MEMO_WORDS.min + 20} words this time, adding a paragraph on the industry-wide part and the remainder with their ranges and one on what was not tested, with the same numbers.`] : []),
      ...(memo && words > MEMO_WORDS.max ? [`- it had ${words} words; cut it to at most ${MEMO_WORDS.max} words.`] : []),
      ...(unknown.length ? [`- it contained numbers that are not in the ALLOWED NUMBERS list: ${unknown.join(", ")}. Remove them or replace them with listed numbers.`] : []),
    ].join("\n");
  }
  const text = templateMemo(input);
  return { text, source: "template", attempts, allowed: input.allowed, wordCount: wordCount(text), model: ollama?.model ?? "none" };
}
