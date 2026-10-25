# How Cursor was used

Crosswalk was developed in a Cursor workspace with project rules in `.cursor/rules` and `AGENTS.md`. Cursor Agent wrote the deterministic pieces the model is never allowed to do, and one screen of the analyst UI: the closed transform set with the match-rate SQL renderer (C1), the semantic-layer plan validator and DDL renderer (C2), the FEMA and station parsers (C3), the catalogue ranking and probe heuristic (C4), the deterministic key-proposal baseline the model is scored against (C5), the verifier that checks the words of the run's note (C6) and the join map screen (C7). Seven headless runs on 25 Oct 2026, across all three build days of the entry (Day 0: C1 to C3, Day 1: C4 and C5, Day 2: C6 and C7), every one exit 0 on the first attempt. This page lists every task, its commits, what the reviewer changed afterwards, and what was not built by Cursor Agent.

## How the workspace is set up

- **`AGENTS.md`** (repository root): the rules that always apply: the layout, Lightning SQL rules, Zetaris scope (only the `CW_*` databases, the `cw` container and the `crosswalk` namespace; never `DROP`), the read-only engines, "discovery is bounded and the model never computes", one data path, source etiquette, secrets, public text and integrity.
- **`.cursor/rules/`**, five project rules: `safety.mdc` (the method's integrity: closed transform set, verdict thresholds, the model never writes SQL or computes a number), `style.mdc` (languages, tests, commit conventions), `zetaris.mdc` (Lightning SQL for the gateway, the SQL files and the USL), `meterless.mdc` (the engines' contracts and the never-edit rule for `engines/`) and `data-licences.mdc` (licences, attribution, what data may be committed).
- **Task files** in [`docs/cursor-tasks/`](cursor-tasks/README.md), each a self-contained brief with the same sections: goal, workspace, files to read, inputs, deliverables, constraints, checks, out of scope, commit message. The inputs include the method's rules and a known-answer fixture whose expected values were computed independently of the code under test (Python generators in `agent/test/fixtures/` and `ui/test/`), so a task is green only when the implementation reproduces the method's values. The fixtures are synthetic, or for C7 built by the server's own view code from redacted saved runs.
- **The run.** Cursor Agent CLI 2026.10.22, Pro plan, model Auto, headless from the repository root, the same short prompt every time:

  ```powershell
  & "$env:LOCALAPPDATA\cursor-agent\cursor-agent.cmd" -p --trust --force --workspace . --output-format text "Read docs/cursor-tasks/<file>.md and complete it. Run the listed checks until green. Do not commit; leave the changes in the working tree."
  ```

- **Review.** Before each run the tree was committed, so the diff afterwards shows only Cursor Agent's work. Each run's changes were checked against the method in the build spec, re-run by hand, and committed unchanged as `Cn: <task> (Cursor Agent)`. Corrections went into separate `Cn review: ...` commits, so the history shows what Cursor Agent wrote and what changed later. The run record of each task (wall time, exit code, what was reviewed, what was corrected) is appended to its task file.

## Tasks run by Cursor Agent

| Task | What Cursor Agent produced | Commit | Run | Corrected afterwards |
|---|---|---|---|---|
| **C1** transforms and match-rate SQL ([task file](cursor-tasks/C1-transforms-and-match-sql.md)) | `agent/src/tools/transforms.ts`: the seven transforms of the closed set as named functions with their Lightning SQL expressions and a parser that accepts canonical spellings only. `agent/src/tools/matchRate.ts`: proposal validation, the two match-rate statements (counts and orphans) over two cached views, the result parser, the verdict rule and an in-memory reference of the method. 30 tests. | `bf07fa5` | 199.4 s, exit 0 | `f5295cf`: `identity` stringifies again (the fixture generator was wrong, not Cursor Agent); `substr(01,2)` refused as non-canonical; an invalid month gives `null` like Lightning's `CAST`; a `null` count throws instead of reading as 0; the refusal of the sister project's objects made case-insensitive. 35 tests after the review. |
| **C2** USL renderer ([task file](cursor-tasks/C2-usl-renderer.md)) | `agent/src/tools/uslPlan.ts`: the plan validator (identifiers, reserved words, types, primary and foreign keys, closed transform set, namespace) and the renderer to the one-statement `COMPILE USL` DDL plus description statements. 15 tests. | `780d725` | 153.8 s, exit 0 | `92d0971`: the description statements use the `UPDATE USL <ns>.<usl>.<table>` grammar that compiles on 2.4.3.1 (the task file and the fixture both prescribed `LOAD USL`'s grammar; Cursor Agent followed the task); an optional model description added. |
| **C3** FEMA and station parsers ([task file](cursor-tasks/C3-fema-and-stations.md)) | `agent/src/tools/fema.ts`: OpenFEMA row parsing, the DR filter, quarter bucketing from ISO dates, declarations per state by incident type. `agent/src/tools/stations.ts`: the fixed-width `ghcnd-stations.txt` parser and its `SUBSTR` view text. 16 tests. | `2a8c52b` | 289.3 s, exit 0 | `5237c2a`: the view keeps `TRIM` on the station name (a fixture defect); a blank latitude, longitude or elevation throws instead of parsing as 0; month 13 throws; the sister-project refusal extended. |
| **C4** catalogue search and probe columns ([task file](cursor-tasks/C4-catalogue-search-and-probe-columns.md)) | `agent/src/tools/catalogueSearch.ts`: the four catalogue builders (curated catalogue, registered Zetaris objects, live OpenFEMA dataset list, getting-started manifest) and token-overlap ranking with `known_to_fail` entries flagged. `agent/src/tools/probeHeuristic.ts`: candidate key columns from DESCRIBE names. 10 tests. | `4421365` | 119.7 s, exit 0 | `eb17ca9`: a catalogue line with a second `->` keeps everything after the first one; one test. |
| **C5** baseline key proposals ([task file](cursor-tasks/C5-baseline-key-proposals.md)) | `agent/src/tools/baselineKeys.ts`: the deterministic baseline (key classes from column names, transforms from sample values, orientation, score, sort) that every run scores the model against. 6 tests. | `1cef0cb` | 92.0 s, exit 0 | Nothing. |
| **C6** note word verifier ([task file](cursor-tasks/C6-note-word-verifier.md)) | `agent/src/llm/noteCheck.ts`: verdict counts against the join map, revenue direction words against each utility's sign, counts of utilities, states and declarations against the answer, the repair feedback and the 250-word cap. 39 tests. | `965f892` | 148 s, exit 0 | `c090bc1`: a direction word with no utility before it and several after it is checked against each of them (a live note had said revenue "held up" while two utilities fell); oracle and three cases added. |
| **C7** join map screen ([task file](cursor-tasks/C7-join-map-screen.md)) | `ui/views/joinmap.js` and `joinmap.css`: the verdict summary, the model-against-baseline proposal table, a small graph of tables and keys, one row per key with both rates, the verdict and its plain-word definition, orphans, measured or recalled, the SQL behind a toggle. `ui/test/joinmap.test.mjs`: 10 tests. | `d9c00d8` | 234.7 s, exit 0 | `d9901e9`: keys between the same two tables drawn as parallel lines instead of on top of each other (the dashed REJECTED control was hidden under the VERIFIED key), orphans wrap inline, a repeated label removed; one test. The scripted edit rewrote the files with CRLF; `0895579` restored LF with no content change. |

Commits marked `(Cursor Agent)`: `git log --grep "(Cursor Agent)"` lists `bf07fa5`, `780d725`, `2a8c52b`, `4421365`, `1cef0cb`, `965f892` and `d9c00d8`.

Wall time of the seven runs: 199.4 + 153.8 + 289.3 + 119.7 + 92.0 + 148 + 234.7 = 1,236.9 s of Cursor Agent time; no re-runs and no task-file clarification were needed. In three runs (C1, C3 and the C2 grammar) Cursor Agent flagged or followed an inconsistency between the task file and its fixture; in each case the reviewer's fixture or task file was at fault.

**How much of it is still in the tree.** At commit `078f890`, `git blame -w --ignore-rev 0895579` attributes 3,208 of the 3,400 lines in the 21 files to the seven Cursor Agent commits:

| Task | Files (Cursor Agent's lines / lines now) | Total |
|---|---|---|
| C1 | `transforms.ts` 175/181, `matchRate.ts` 169/177, `transforms.test.ts` 58/74, `match-rate.test.ts` 147/170 | 549 / 602 |
| C2 | `uslPlan.ts` 343/361, `usl-plan.test.ts` 168/194 | 511 / 555 |
| C3 | `fema.ts` 139/140, `stations.ts` 80/96, `fema.test.ts` 119/126, `stations.test.ts` 97/115 | 435 / 477 |
| C4 | `catalogueSearch.ts` 248/251, `probeHeuristic.ts` 68/68, `catalogue-search.test.ts` 108/112, `probe-heuristic.test.ts` 39/39 | 463 / 470 |
| C5 | `baselineKeys.ts` 232/232, `baseline-keys.test.ts` 84/84 | 316 / 316 |
| C6 | `noteCheck.ts` 280/288, `note-check.test.ts` 94/94 | 374 / 382 |
| C7 | `joinmap.js` 301/313, `joinmap.css` 62/64, `joinmap.test.mjs` 197/221 | 560 / 598 |

All of these suites run in `npm test` (agent, 25 files / 360 tests) and `node --test ui/test/*.test.mjs` (24 tests) on a fresh clone.

**How the pieces are used at run time** (written outside Cursor Agent): `measure_key` renders C1's statement shapes through the gateway's `match_rate` template (the gateway tests assert the same SQL strings); `compile_usl` renders the governed plan with C2 and compares it with the compiled USL; `search_catalogue` and `probe_source` call C4; C5 is both the fallback for `propose_keys` and the baseline every run scores the model against (the comparison in [`eval-report.md`](eval-report.md), section 2, which the baseline wins); `finalize` checks every model draft with C6 before the note is kept; C7 is the Join map screen.

## What Cursor Agent did not write

Everything else was written outside the seven Cursor Agent runs:

- the task files, the known-answer fixtures and their generators;
- the Zetaris objects: every Lightning SQL pair in `zetaris/sql/`, the `crosswalk_usl` model and its DQ rules, `zetaris/README.md` and the manifest;
- the gateway (`gateway/`: templates including the join-map and `match_rate` statements, allowlist, registrar and `register_source`, contract check, JDBC channel, tests) and the scripts (`scripts/`: snapshot and SQL generators, warm-up, DQ onboarding);
- the discovery loop (`agent/src/loop/`: the six discovery tools, the checklist, the answer), the planner and note jobs (`agent/src/llm/` except `noteCheck.ts`), the key memories (`agent/src/memory/`), the World Model wrapper (`agent/src/world/`), the contracts, the evidence store, the runtime and the CLI;
- the server (`agent/src/server.ts`, `agent/src/ops/`) and the analyst UI except the join map view (`ui/`);
- the evaluation (`agent/src/eval/`, `docs/eval-report.md`, `docs/eval/`);
- this documentation, the README, `metadata.json`, `NOTICE`, the architecture figure, the deck and the video.

The vendored Meterless engines in `engines/` were written by neither; the scaffolding adapted from the author's earlier entries is declared in the README's [pre-existing code](../README.md#pre-existing-code) section.
