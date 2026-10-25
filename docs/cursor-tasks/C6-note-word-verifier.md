# C6: the note word verifier

## Goal

`agent/src/llm/noteCheck.ts` exists and is unit-tested: given the note the model drafted at the end of a run and the facts the tools measured, it lists every place where the note's WORDS contradict those facts (the note's numbers are already string-matched to tool outputs elsewhere). Three checks: verdict counts ("four keys verified" while the join map has five), revenue direction words per utility ("revenue held up" while two utilities fell), and counts of states, utilities and declarations ("the 12 served states" while the answer has 7). It also builds the one-repair feedback for the model and caps the deterministic template note at 250 words. No model calls, no network, no file access.

## Workspace

This repository (`agent/` is the Node 22 + TypeScript package; run commands from `agent/`). Other work is in progress in the working tree while this task runs (under `agent/src/loop/`, `agent/src/tools/`, `agent/src/server.ts`, `gateway/`, `ui/` and elsewhere). Leave every file that is not under **Deliverables** alone, even if a check reports an error in it.

## Read first

- `AGENTS.md`, `.cursor/rules/style.mdc`, `.cursor/rules/safety.mdc`.
- `agent/src/llm/memo.ts` (the note job; the host wires your module into it after review) and `agent/src/llm/schemas.ts` (`wordCount`).
- `agent/test/fixtures/crosswalk-notecheck.json` (described under **Inputs**). `agent/test/fixtures/make_notecheck_fixtures.py` produced it; do not port its code line by line, implement the rules below (they are the same rules).

## Inputs

### Types

```ts
export interface NoteUtility { ticker: string | null; name: string; revenue_change: number | null; declarations: number; states: number }
export interface NoteFacts {
  verdicts: { VERIFIED: number; PARTIAL: number; REJECTED: number }; // join-map rows per verdict
  utilities: NoteUtility[];                                           // the answer rows, in answer order
  totals: { utilities: number; states: number; declarations: number };
}
export interface NoteIssue { kind: "verdict_count" | "count" | "direction"; sentence: number; subject: string; claimed: string; expected: string }
```

`label(u)` is `u.ticker` when it is a non-empty string, else `u.name`.

### Sentences

`splitSentences(text)`: split on the regular expression `/(?<=[.!?])\s+|\n+/u`, trim every piece, drop empty pieces. A decimal point followed by a digit never splits ("8.7%" stays whole). Sentence indexes in issues are 0-based positions in this list.

### Number tokens

`N` = one or more digits, or one of the words `zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty` (any case); its value is the integer or the word's position in that list. A number token never starts right after a word character or a dot (lookbehind `(?<![\w.])`), so "0.977" and "lpad10" give no token. A match is skipped entirely when the sentence text before the token ends with the word `of` and whitespace (`/\bof\s+$/i`): "42 of 43 VERIFIED" claims nothing.

### Utility mentions (per sentence)

For every utility in facts order: its ticker when the ticker has two or more characters, matched case-sensitively as a whole token (`(?<![A-Za-z0-9])TICKER(?![A-Za-z0-9])`), and its name matched case-insensitively the same way (escape regular-expression characters). A mention is its start offset and the utility's index. `before(pos)`: among mentions with start < pos, the one with the largest start (tie: the smallest utility index); `after(pos)`: among mentions with start > pos, the smallest start (tie: smallest index).

### Check 1: verdict counts

Regular expression (case-insensitive), with `N` as above:
`(?<![\w.])N((?:\s+(?:keys|key|join|were|are|is|was|with|of|the|them|measured|as|matches)){0,3})\s+(verified|partially|partial|rejected)\b`
Each match (not skipped by the `of` rule) claims `value(N)` keys of verdict `VERIFIED`, `PARTIAL` (for `partial` and `partially`) or `REJECTED`. When the value differs from `facts.verdicts[verdict]`: issue `{kind: "verdict_count", subject: <VERDICT>, claimed: <N as written, lower-cased>, expected: String(<facts count>)}`.

### Check 2: counts of utilities, states, declarations

Regular expression (case-insensitive): `(?<![\w.])N((?:\s+[A-Za-z][A-Za-z-]*){0,2}?)\s+(utilities|states|declarations)\b` (at most two words between the number and the noun, lazily).
For `declarations` and `states`: when `before(match start)` names a utility, the claim is about that utility and is compared with its `declarations` or `states`, subject `"<label>:<noun>"`; otherwise it is compared with `facts.totals[noun]`, subject `<noun>`. `utilities` is always compared with `facts.totals.utilities`, subject `"utilities"`. A difference gives `{kind: "count", subject, claimed: <N lower-cased>, expected: String(<actual>)}`.

### Check 3: revenue direction words

Only in a sentence that contains `revenue` or `revenues` (`/\brevenues?\b/i`) and does not contain `degree`, `degrees`, `weather` or `temperature` (`/\b(degree|degrees|weather|temperature)\b/i`).
Words (case-insensitive): `/\b(rose|grew|increased|gained|fell|declined|decreased|dropped|held)\b|\b(up|down)(?=\s+[-+]?\d)/i` (`up` and `down` count only when a number follows). Positive words `rose grew increased gained up` need change > 0; negative words `fell declined decreased dropped down` need change < 0; `held` needs change >= 0; a null change never satisfies a word.
Attachment: `before(word start)`, else `after(word start)`. Attached to a utility that does not satisfy the word: `{kind: "direction", subject: label, claimed: <word lower-cased>, expected: "rose" | "fell" | "unchanged" | "not compared"}` (the sign of its change: > 0, < 0, = 0, null). Attached to no utility: a claim about all of them; the utilities whose change is not null and does not satisfy the word, in facts order, give ONE issue `{kind: "direction", subject: "all", claimed, expected: <their labels joined with ", ">}`; none: no issue.

### Order

`checkNoteWords(text, facts)` returns the issues sorted by sentence index, then by the match start offset inside the sentence, then by kind (`verdict_count`, `count`, `direction`). Each issue object has exactly the five fields, in the order of the `NoteIssue` interface.

### Repair feedback

`repairFeedback(issues)`: `""` for no issue; otherwise the line `Your previous draft contradicts the tool outputs:` followed by one line per issue, joined with `\n`, where `n` = sentence + 1:
- verdict_count: `- sentence n: you wrote <claimed> <subject> keys; the join map has <expected>.`
- count: `- sentence n: you wrote <claimed> <subject>; the answer has <expected>.`
- direction: `- sentence n: "<claimed>" for <subject> contradicts the revenue change (<expected>).`

### Template cap

`NOTE_MAX_WORDS = 250`. `capWords(paragraphs, max = NOTE_MAX_WORDS)`: words are whitespace-separated tokens. Walk the paragraphs in order and each paragraph's sentences (`splitSentences`) in order, keeping a running word total; keep a sentence while total + its words <= max; at the first sentence that does not fit, stop entirely (nothing after it is kept, not even shorter sentences). The result is each paragraph's kept sentences joined with one space, the non-empty paragraphs joined with `\n\n`. If nothing was kept and at least one sentence exists, return the first `max` words of the first sentence joined with single spaces. No sentence: `""`.

### Fixture `agent/test/fixtures/crosswalk-notecheck.json`

`synthetic: true`. `max_words`; `facts` (one `NoteFacts` used by every check case); `sentences[]` `{text, expected}`; `checks[]` `{name, text, expected}` (expected issues); `cap[]` `{name, paragraphs, max, expected, expected_words}` (`max: null` means call with the default); `feedback[]` `{name, issues, expected}`.

## Deliverables

| File | Contents |
|---|---|
| `agent/src/llm/noteCheck.ts` | Exports: the four types above; `NOTE_MAX_WORDS`; `splitSentences(text: string): string[]`; `checkNoteWords(text: string, facts: NoteFacts): NoteIssue[]`; `repairFeedback(issues: readonly NoteIssue[]): string`; `capWords(paragraphs: readonly string[], max?: number): string`. |
| `agent/test/note-check.test.ts` | vitest suite with at least the cases below. |

### Test cases that must exist

- Every `sentences[]`, `checks[]`, `cap[]` and `feedback[]` case reproduces (deep equality; for `cap[]` also the word count of the result equals `expected_words` and is at most `max` or `NOTE_MAX_WORDS`).
- The `clean` case gives `[]`; the `collective_held` case gives one issue with subject `all`.
- The fixture is labelled synthetic (`synthetic === true`).
- Purity: calling `checkNoteWords` twice on the same input gives equal results and does not change `facts`.

## Constraints

- No model calls, no network, no file or database access inside the module, no new dependencies, nothing added to `package.json`. Pure functions. ES modules, TypeScript run by tsx; `node:` builtins only (the test reads the fixture with `node:fs`).
- Do not edit `memo.ts`, `schemas.ts` or any other existing file; the host wires the module in after review.
- The fixture and its generator are inputs: do not edit or regenerate them.
- Do not edit `engines/`, `gateway/`, `zetaris/`, `seeds/`, `.env.local`, `agent/package.json`, `agent/tsconfig.json`, `agent/tsconfig.tools.json`, the existing tests, or anything outside **Deliverables**.

## Checks

From `agent/`:

- `npx vitest run note-check` is green.
- `npx tsc --noEmit` reports no error in the two deliverables (errors in files outside **Deliverables**, if another lane is mid-edit, are not yours to fix).

## Out of scope

Calling the model, the retry loop and the choice between the draft and the template (memo.ts, the host), the number check (memo.ts `unknownNumbers`), building `NoteFacts` from a run (the finalize tool), the planner prompt.

## Commit

`C6: note word verifier (Cursor Agent)`

Do not commit; leave the changes in the working tree.

## Run record

- Run 2026-10-25 15:24:17 SGT, Cursor Agent CLI (model Auto): 148 s wall, exit 0, no commit (as asked), only the two deliverables added. Cursor reported `npx vitest run note-check` 39 passed and `npx tsc --noEmit` clean.
- Reviewed by hand against this file (sentence split, number tokens and the `of` skip, the three checks with their attachment rules, the order, the feedback lines, the cap); checks re-run: 39 passed. Committed unchanged as `965f892` (`C6: note word verifier (Cursor Agent)`). No correction was needed.
- Used by the host: `agent/src/llm/memo.ts` rejects a draft whose words contradict the run's facts, gives the model one repair with `repairFeedback`, then falls back to the template capped with `capWords`; `agent/src/loop/tools.ts` (`noteFacts`) builds the facts from the join map and the answer.
- Review correction (lane F, after the second cold run of Day 2, commit `C6 review`): the model's note "their revenue held up year on year with AEP +8.7%, ..., EIX -6.5%, ..." passed, because a direction word with no utility before it attached to the first utility after it (AEP). Rule added to **Check 3**: when no utility is mentioned before the word and two or more distinct utilities are mentioned after it in the sentence, the word is checked against each of them (an uncompared one fails, as it does alone), one issue `{kind: "direction", subject: "listed", claimed, expected: <violators in facts order joined with ", ">}`; with exactly one utility after it, the attachment is unchanged. The oracle got the same rule and three new cases (`listed_after_held`, `listed_after_all_true`, `listed_after_not_compared`); the 20 original cases are unchanged. Re-checked offline with the corrected verifier: the Day-2 cold-2 note (`held` for EIX, POR), the Day-1 cold V2 note (`12` states, the answer has 7) and the Day-1 cold A note (`four` VERIFIED, the join map has 5) are all flagged.
