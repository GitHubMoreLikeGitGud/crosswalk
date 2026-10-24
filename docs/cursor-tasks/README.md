# Cursor task files

Weather-or-Not was developed in a Cursor workspace with project rules in `.cursor/rules` and `AGENTS.md`. Larger pieces of work are written up as task files in this folder and handed to Cursor Agent, which runs headless against the repository. Each task file is a self-contained brief: Cursor Agent reads it, does the work, and runs the listed checks until they pass. The task files and their commits are the record of how Cursor was used; the summary is [`docs/how-cursor-was-used.md`](../how-cursor-was-used.md). Cursor Agent ran C1, C2 and C3 (24 Oct 2026). Nothing else in this repository was built by Cursor Agent.

The deterministic tools (degree days, attribution, like-for-like revenue) are the three Cursor tasks. Their expected numbers come from known-answer fixtures in `agent/test/fixtures/` that were computed independently of the code under test (`make_fixtures.py`), so a task is green only when the implementation reproduces the method's numbers.

## File naming

- One file per task: `Cn-<short-slug>.md`, for example `C1-degree-days.md`.
- `n` is the task number from the build plan. Numbers are never reused; a task that needs a second pass gets a new section in the same file, not a new number.
- This `README.md` describes the convention and is not a task.

## Sections in a task file

Every task file uses these headings, in this order:

1. **Goal.** One or two sentences: what exists when the task is done.
2. **Workspace.** The folder Cursor Agent runs in. Usually the repository root; a task that works in another folder says so here.
3. **Read first.** The files to read before starting: `AGENTS.md`, the relevant `.cursor/rules/*.mdc`, and any sample data or guides.
4. **Inputs.** Sample responses, contracts, schemas or fixtures the task builds from, with their paths, and the method's formulas where the task implements arithmetic.
5. **Deliverables.** The exact paths to create or change. Anything not listed is out of bounds.
6. **Constraints.** Task-specific rules on top of the project rules (for example "no new dependencies", "no network", "never edit `engines/`").
7. **Checks.** The commands that must pass, such as `cd agent && npx vitest run <filter>` and `npx tsc --noEmit -p tsconfig.tools.json`. The task is done when they are green. Tests are never weakened or skipped to get there.
8. **Out of scope.** What the task must not do.
9. **Commit.** The commit message the reviewer uses: `Cn: <task> (Cursor Agent)`.

A task file names environment variables (for example `ZETARIS_JDBC_JAR`) but never contains their values. Credentials stay in `.env.local`, which is gitignored. A task file never carries extracted SEC values; fixtures are synthetic and labelled so.

## Running a task

From the repository root, in PowerShell:

```powershell
& "$env:LOCALAPPDATA\cursor-agent\cursor-agent.cmd" -p --trust --force --workspace . --output-format text "Read docs/cursor-tasks/<file>.md and complete it. Run the listed checks until green. Do not commit; leave the changes in the working tree."
```

- Keep the prompt short; the task file carries the detail. Windows limits the length of a command line.
- Never put secrets in the prompt.
- The prompt says "Do not commit". Without that sentence Cursor Agent commits by itself with an automatic co-author trailer (it did so on C1); the repository uses plain commit messages, so the reviewer commits.
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
| C1 | [`C1-degree-days.md`](C1-degree-days.md) | degree-day SQL template text, TypeScript reference implementation, utility aggregation, tests against synthetic daily series for two made-up stations | done 2026-10-24 (122.4 s, exit 0, 13 tests green), commit `1a8743c`; two reviewer fixes in `2b2533b` (see the run record) |
| C2 | [`C2-attribution.md`](C2-attribution.md) | peer set, OLS and Theil-Sen slope, seeded bootstrap ranges, three-way split, confidence labels, claim verdict, tests against hand-computed cases | done 2026-10-24 (198.1 s, exit 0, 13 tests green), commit `4d83e2e`; one reviewer fix to the claim thresholds and the fixture in `1ced57c` (see the run record) |
| C3 | [`C3-recast-and-frames.md`](C3-recast-and-frames.md) | companyconcept history parsing, period matching, recast detection and rule R1, tag probing, frames helpers, tests with a recast fixture | done 2026-10-24 (163.3 s, exit 0, 22 tests green), commit `222843d`; no reviewer change needed (see the run record) |

No further task files were written: the gateway tests, the Zetaris SQL checks and the UI were built outside Cursor Agent.
