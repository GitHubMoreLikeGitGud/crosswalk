# Cursor task files

Crosswalk is developed in a Cursor workspace with project rules in `.cursor/rules` and `AGENTS.md`. Larger pieces of work are written up as task files in this folder and handed to Cursor Agent, which runs headless against the repository. Each task file is a self-contained brief: Cursor Agent reads it, does the work, and runs the listed checks until they pass. The task files and their commits are the record of how Cursor was used; the summary is `docs/how-cursor-was-used.md` (written when the tasks have run). Nothing else in this repository is built by Cursor Agent.

The deterministic tools of the discovery loop are the Cursor tasks: the closed transform set with the match-rate SQL renderer and parser (C1), the USL plan validator and DDL renderer (C2), the FEMA and station parsers with quarter bucketing (C3), the catalogue search ranking and the probe's candidate key columns (C4), the deterministic key-proposal baseline the planner is scored against (C5), and the verifier that checks the words of the run's note against the measured facts (C6). One screen of the analyst UI is a Cursor task too: the join map (C7). Their expected values come from known-answer fixtures in `agent/test/fixtures/crosswalk-*.json` that were computed independently of the code under test (`agent/test/fixtures/make_crosswalk_fixtures.py`, `make_discovery_fixtures.py`), so a task is green only when the implementation reproduces the method's values.

## File naming

- One file per task: `Cn-<short-slug>.md`, for example `C1-transforms-and-match-sql.md`.
- `n` is the task number from the build plan. Numbers are never reused; a task that needs a second pass gets a new section in the same file, not a new number.
- This `README.md` describes the convention and is not a task.

## Sections in a task file

Every task file uses these headings, in this order:

1. **Goal.** One or two sentences: what exists when the task is done.
2. **Workspace.** The folder Cursor Agent runs in. Usually the repository root; a task that works in another folder says so here.
3. **Read first.** The files to read before starting: `AGENTS.md`, the relevant `.cursor/rules/*.mdc`, and any sample data or guides.
4. **Inputs.** Sample responses, contracts, schemas or fixtures the task builds from, with their paths, and the method's rules where the task implements them.
5. **Deliverables.** The exact paths to create or change. Anything not listed is out of bounds.
6. **Constraints.** Task-specific rules on top of the project rules (for example "no new dependencies", "no network", "never edit `engines/`").
7. **Checks.** The commands that must pass, such as `cd agent && npx vitest run <filter>` and `npx tsc --noEmit -p tsconfig.tools.json`. The task is done when they are green. Tests are never weakened or skipped to get there.
8. **Out of scope.** What the task must not do.
9. **Commit.** The commit message the reviewer uses: `Cn: <task> (Cursor Agent)`.

A task file names environment variables (for example `ZETARIS_JDBC_JAR`) but never contains their values. Credentials stay in `.env.local`, which is gitignored. A task file never carries extracted SEC or FEMA values; fixtures are synthetic and labelled so.

## Running a task

From the repository root, in PowerShell:

```powershell
& "$env:LOCALAPPDATA\cursor-agent\cursor-agent.cmd" -p --trust --force --workspace . --output-format text "Read docs/cursor-tasks/<file>.md and complete it. Run the listed checks until green. Do not commit; leave the changes in the working tree."
```

- Keep the prompt short; the task file carries the detail. Windows limits the length of a command line.
- Never put secrets in the prompt.
- The prompt says "Do not commit". Without that sentence Cursor Agent commits by itself with an automatic co-author trailer; the repository uses plain commit messages, so the reviewer commits.
- A task whose **Workspace** is another folder is run with `--workspace <that folder>`.

## Review and commit

1. Before the run: commit or stash everything, so the diff afterwards shows only Cursor Agent's work.
2. After the run: review `git status` and `git diff`. Check that only the paths under **Deliverables** changed, that the checks pass when run again by hand, that the implementation follows the method as written (not only that the tests pass), and that no secret, private path or source data was added.
3. Stage the deliverables by explicit path (`git add <path> ...`, never `git add -A`) and commit with the message from the task file: `Cn: <task> (Cursor Agent)`. Plain messages only, with no trailers. Reviewer fixes go in a separate commit, `Cn review: <what>`.
4. Transcripts of runs are kept privately, outside the repository. Each transcript starts with the exact command line of the run (no secrets), followed by the start time, wall time and exit code.
5. The run record (wall time, exit code, what was reviewed, what was corrected) is appended to the task file under **Run record**.

## Task index

| Task | File | Scope | Status |
|---|---|---|---|
| C1 | [`C1-transforms-and-match-sql.md`](C1-transforms-and-match-sql.md) | the closed transform set as named functions with their Lightning SQL expressions, the match-rate statement renderer over two cached views, the result parser and verdict rule, tests against synthetic rows | run 2026-10-25 (199.4 s, exit 0); committed `bf07fa5`, review `f5295cf` |
| C2 | [`C2-usl-renderer.md`](C2-usl-renderer.md) | USL plan schema, validator (identifiers, types, PK/FK references, closed transform set, reserved words, namespace) and renderer to the one-statement `COMPILE USL` DDL plus description statements, tests | run 2026-10-25 (153.8 s, exit 0); committed `780d725`, review `92d0971` |
| C3 | [`C3-fema-and-stations.md`](C3-fema-and-stations.md) | OpenFEMA row parsing, DR filter, quarter bucketing from ISO dates, per-state declaration counts by incident type; the fixed-width `ghcnd-stations.txt` parser and its SUBSTR view text; tests | run 2026-10-25 (289.3 s, exit 0); committed `2a8c52b`, review `5237c2a` |
| C4 | [`C4-catalogue-search-and-probe-columns.md`](C4-catalogue-search-and-probe-columns.md) | the catalogue builders (curated catalogue, registered Zetaris objects, live OpenFEMA dataset list, getting-started manifest), token-overlap ranking with `known_to_fail` flagged as negative memory, and the probe's candidate key columns from DESCRIBE names; tests on fixtures | run 2026-10-25 (119.7 s, exit 0); committed `4421365`, review `eb17ca9` |
| C5 | [`C5-baseline-key-proposals.md`](C5-baseline-key-proposals.md) | the deterministic key-proposal baseline (key classes from column names, transforms from sample values, orientation, score, sort); every run scores the planner's proposals against it; tests on fixtures | run 2026-10-25 (92.0 s, exit 0); committed `1cef0cb`, no review change |
| C6 | [`C6-note-word-verifier.md`](C6-note-word-verifier.md) | the note word verifier: verdict counts against the join map, revenue direction words against each utility's sign, counts of utilities, states and declarations against the answer; the one-repair feedback and the 250-word template cap; tests on fixtures | run 2026-10-25 (148 s, exit 0); committed `965f892`, review `c090bc1` |
| C7 | [`C7-join-map-screen.md`](C7-join-map-screen.md) | the Join map screen of the analyst UI: verdict summary and the model-against-baseline proposal table, a small graph of the tables and keys, one row per key with both rates, the verdict and its plain-word definition, orphans, measured or recalled, the SQL behind a toggle; render tests on fixtures built from the server's own view code | run 2026-10-25 (234.7 s, exit 0); committed `d9c00d8`, review `d9901e9` |

The inherited task files of the sister entry (degree days, attribution, like-for-like revenue) are not part of this repository; their tools remain in `agent/src/tools/` as inherited code until the Crosswalk agent lane replaces them.
