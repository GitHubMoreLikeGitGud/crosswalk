import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  NOTE_MAX_WORDS,
  capWords,
  checkNoteWords,
  repairFeedback,
  splitSentences,
  type NoteFacts,
  type NoteIssue,
} from "../src/llm/noteCheck.ts";
import { wordCount } from "../src/llm/schemas.ts";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "crosswalk-notecheck.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  synthetic: boolean;
  max_words: number;
  facts: NoteFacts;
  sentences: { text: string; expected: string[] }[];
  checks: { name: string; text: string; expected: NoteIssue[] }[];
  cap: { name: string; paragraphs: string[]; max: number | null; expected: string; expected_words: number }[];
  feedback: { name: string; issues: NoteIssue[]; expected: string }[];
};

describe("noteCheck fixture", () => {
  it("is labelled synthetic", () => {
    expect(fixture.synthetic).toBe(true);
  });

  it("uses the documented word cap", () => {
    expect(NOTE_MAX_WORDS).toBe(fixture.max_words);
  });
});

describe("splitSentences", () => {
  for (const [i, c] of fixture.sentences.entries()) {
    it(`case ${i}`, () => {
      expect(splitSentences(c.text)).toEqual(c.expected);
    });
  }
});

describe("checkNoteWords", () => {
  for (const c of fixture.checks) {
    it(c.name, () => {
      expect(checkNoteWords(c.text, fixture.facts)).toEqual(c.expected);
    });
  }

  it("clean gives []", () => {
    const clean = fixture.checks.find((c) => c.name === "clean")!;
    expect(checkNoteWords(clean.text, fixture.facts)).toEqual([]);
  });

  it("collective_held gives one issue with subject all", () => {
    const c = fixture.checks.find((x) => x.name === "collective_held")!;
    const issues = checkNoteWords(c.text, fixture.facts);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.subject).toBe("all");
  });

  it("is pure: second call equals first and does not change facts", () => {
    const facts = structuredClone(fixture.facts);
    const snapshot = JSON.stringify(facts);
    const text = fixture.checks.find((c) => c.name === "mixed_kinds_same_sentence")!.text;
    const a = checkNoteWords(text, facts);
    const b = checkNoteWords(text, facts);
    expect(b).toEqual(a);
    expect(JSON.stringify(facts)).toBe(snapshot);
  });
});

describe("capWords", () => {
  for (const c of fixture.cap) {
    it(c.name, () => {
      const out = c.max === null ? capWords(c.paragraphs) : capWords(c.paragraphs, c.max);
      expect(out).toBe(c.expected);
      const words = wordCount(out);
      expect(words).toBe(c.expected_words);
      const limit = c.max === null ? NOTE_MAX_WORDS : c.max;
      expect(words).toBeLessThanOrEqual(limit);
    });
  }
});

describe("repairFeedback", () => {
  for (const c of fixture.feedback) {
    it(c.name, () => {
      expect(repairFeedback(c.issues)).toBe(c.expected);
    });
  }
});
