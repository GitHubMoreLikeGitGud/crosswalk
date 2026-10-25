// Note word verifier: lists places where a draft note's words contradict measured facts.
// Numbers are checked elsewhere by string match; this module is pure (no model, network, or I/O).

export interface NoteUtility {
  ticker: string | null;
  name: string;
  revenue_change: number | null;
  declarations: number;
  states: number;
}

export interface NoteFacts {
  verdicts: { VERIFIED: number; PARTIAL: number; REJECTED: number };
  utilities: NoteUtility[];
  totals: { utilities: number; states: number; declarations: number };
}

export interface NoteIssue {
  kind: "verdict_count" | "count" | "direction";
  sentence: number;
  subject: string;
  claimed: string;
  expected: string;
}

export const NOTE_MAX_WORDS = 250;

const NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
  "nineteen", "twenty",
] as const;

const N = `(\\d+|${NUMBER_WORDS.join("|")})`;
const VERDICT_FILLERS =
  "keys|key|join|were|are|is|was|with|of|the|them|measured|as|matches";
const VERDICT_RE = new RegExp(
  `(?<![\\w.])${N}((?:\\s+(?:${VERDICT_FILLERS})){0,3})\\s+(verified|partially|partial|rejected)\\b`,
  "gi",
);
const COUNT_RE = new RegExp(
  `(?<![\\w.])${N}((?:\\s+[A-Za-z][A-Za-z-]*){0,2}?)\\s+(utilities|states|declarations)\\b`,
  "gi",
);
const DIRECTION_RE =
  /\b(rose|grew|increased|gained|fell|declined|decreased|dropped|held)\b|\b(up|down)(?=\s+[-+]?\d)/gi;
const OF_BEFORE = /\bof\s+$/i;
const REVENUE_CONTEXT = /\brevenues?\b/i;
const NOT_REVENUE_CONTEXT = /\b(degree|degrees|weather|temperature)\b/i;
const SENTENCE_SPLIT = /(?<=[.!?])\s+|\n+/u;

const POSITIVE = new Set(["rose", "grew", "increased", "gained", "up"]);
const NEGATIVE = new Set(["fell", "declined", "decreased", "dropped", "down"]);
const KIND_ORDER: Record<NoteIssue["kind"], number> = {
  verdict_count: 0,
  count: 1,
  direction: 2,
};

function numberValue(token: string): number {
  const t = token.toLowerCase();
  if (/^\d+$/u.test(t)) return Number(t);
  return NUMBER_WORDS.indexOf(t as (typeof NUMBER_WORDS)[number]);
}

function label(u: NoteUtility): string {
  return u.ticker ? u.ticker : u.name;
}

type Mention = { start: number; index: number };

function mentions(sentence: string, utilities: readonly NoteUtility[]): Mention[] {
  const out: Mention[] = [];
  for (let i = 0; i < utilities.length; i++) {
    const u = utilities[i]!;
    const pats: RegExp[] = [];
    if (u.ticker && u.ticker.length >= 2) {
      pats.push(new RegExp(`(?<![A-Za-z0-9])${escapeRe(u.ticker)}(?![A-Za-z0-9])`, "g"));
    }
    pats.push(new RegExp(`(?<![A-Za-z0-9])${escapeRe(u.name)}(?![A-Za-z0-9])`, "gi"));
    for (const p of pats) {
      for (const m of sentence.matchAll(p)) {
        out.push({ start: m.index!, index: i });
      }
    }
  }
  const seen = new Set<string>();
  const uniq: Mention[] = [];
  for (const m of out.sort((a, b) => a.start - b.start || a.index - b.index)) {
    const key = `${m.start}:${m.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(m);
  }
  return uniq;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function before(ms: readonly Mention[], pos: number): number | null {
  const cands = ms.filter((m) => m.start < pos);
  if (cands.length === 0) return null;
  const best = Math.max(...cands.map((c) => c.start));
  return Math.min(...cands.filter((c) => c.start === best).map((c) => c.index));
}

function after(ms: readonly Mention[], pos: number): number | null {
  const cands = ms.filter((m) => m.start > pos);
  if (cands.length === 0) return null;
  const best = Math.min(...cands.map((c) => c.start));
  return Math.min(...cands.filter((c) => c.start === best).map((c) => c.index));
}

function directionOf(change: number | null): string {
  if (change === null) return "not compared";
  return change > 0 ? "rose" : change < 0 ? "fell" : "unchanged";
}

function satisfies(word: string, change: number | null): boolean {
  if (change === null) return false;
  if (POSITIVE.has(word)) return change > 0;
  if (NEGATIVE.has(word)) return change < 0;
  return change >= 0; // held
}

export function splitSentences(text: string): string[] {
  return text.split(SENTENCE_SPLIT).map((s) => s.trim()).filter((s) => s.length > 0);
}

export function checkNoteWords(text: string, facts: NoteFacts): NoteIssue[] {
  const utilities = facts.utilities;
  type Raw = { si: number; start: number; kind: NoteIssue["kind"]; subject: string; claimed: string; expected: string };
  const raw: Raw[] = [];

  for (const [si, s] of splitSentences(text).entries()) {
    const ms = mentions(s, utilities);

    for (const m of s.matchAll(VERDICT_RE)) {
      if (OF_BEFORE.test(s.slice(0, m.index!))) continue;
      const word = m[3]!.toLowerCase();
      const verdict = word.startsWith("partial") ? "PARTIAL" : (word.toUpperCase() as keyof NoteFacts["verdicts"]);
      const claimed = numberValue(m[1]!);
      const actual = facts.verdicts[verdict];
      if (claimed !== actual) {
        raw.push({
          si,
          start: m.index!,
          kind: "verdict_count",
          subject: verdict,
          claimed: m[1]!.toLowerCase(),
          expected: String(actual),
        });
      }
    }

    for (const m of s.matchAll(COUNT_RE)) {
      if (OF_BEFORE.test(s.slice(0, m.index!))) continue;
      const noun = m[3]!.toLowerCase() as "utilities" | "states" | "declarations";
      const claimed = numberValue(m[1]!);
      let subject: string;
      let actual: number;
      if (noun === "utilities") {
        subject = "utilities";
        actual = facts.totals.utilities;
      } else {
        const ui = before(ms, m.index!);
        if (ui === null) {
          subject = noun;
          actual = facts.totals[noun];
        } else {
          subject = `${label(utilities[ui]!)}:${noun}`;
          actual = utilities[ui]![noun];
        }
      }
      if (claimed !== actual) {
        raw.push({
          si,
          start: m.index!,
          kind: "count",
          subject,
          claimed: m[1]!.toLowerCase(),
          expected: String(actual),
        });
      }
    }

    if (REVENUE_CONTEXT.test(s) && !NOT_REVENUE_CONTEXT.test(s)) {
      for (const m of s.matchAll(DIRECTION_RE)) {
        const word = (m[1] ?? m[2]!).toLowerCase();
        let ui = before(ms, m.index!);
        if (ui === null) ui = after(ms, m.index!);
        if (ui !== null) {
          const u = utilities[ui]!;
          if (!satisfies(word, u.revenue_change)) {
            raw.push({
              si,
              start: m.index!,
              kind: "direction",
              subject: label(u),
              claimed: word,
              expected: directionOf(u.revenue_change),
            });
          }
        } else {
          const bad = utilities
            .filter((u) => u.revenue_change !== null && !satisfies(word, u.revenue_change))
            .map((u) => label(u));
          if (bad.length > 0) {
            raw.push({
              si,
              start: m.index!,
              kind: "direction",
              subject: "all",
              claimed: word,
              expected: bad.join(", "),
            });
          }
        }
      }
    }
  }

  raw.sort((a, b) => a.si - b.si || a.start - b.start || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  return raw.map(({ kind, si, subject, claimed, expected }) => ({
    kind,
    sentence: si,
    subject,
    claimed,
    expected,
  }));
}

export function repairFeedback(issues: readonly NoteIssue[]): string {
  if (issues.length === 0) return "";
  const lines = ["Your previous draft contradicts the tool outputs:"];
  for (const i of issues) {
    const n = i.sentence + 1;
    if (i.kind === "verdict_count") {
      lines.push(`- sentence ${n}: you wrote ${i.claimed} ${i.subject} keys; the join map has ${i.expected}.`);
    } else if (i.kind === "count") {
      lines.push(`- sentence ${n}: you wrote ${i.claimed} ${i.subject}; the answer has ${i.expected}.`);
    } else {
      lines.push(`- sentence ${n}: "${i.claimed}" for ${i.subject} contradicts the revenue change (${i.expected}).`);
    }
  }
  return lines.join("\n");
}

export function capWords(paragraphs: readonly string[], max: number = NOTE_MAX_WORDS): string {
  const kept: string[][] = [];
  let total = 0;
  let stop = false;
  let firstSentence: string | null = null;

  for (const p of paragraphs) {
    const cur: string[] = [];
    for (const s of splitSentences(p)) {
      if (firstSentence === null) firstSentence = s;
      const w = s.split(/\s+/u).filter((t) => t.length > 0).length;
      if (stop || total + w > max) {
        stop = true;
        break;
      }
      cur.push(s);
      total += w;
    }
    kept.push(cur);
    if (stop) break;
  }

  if (total === 0 && firstSentence !== null) {
    return firstSentence.split(/\s+/u).filter((t) => t.length > 0).slice(0, max).join(" ");
  }
  return kept
    .filter((c) => c.length > 0)
    .map((c) => c.join(" "))
    .join("\n\n");
}
