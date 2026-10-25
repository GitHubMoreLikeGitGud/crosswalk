# Crosswalk: rules for coding agents

Crosswalk checks a US electric utility's claim that a revenue swing was "the weather" (Open Agent Hackathon 2026, Track 2: The Agent That Can Explain Why). It splits the year-on-year change into a weather part, an industry-wide part and a company-specific remainder, with every number backed by the Lightning SQL that produced it, an H-MEM trust ledger behind every fact, and an explicit "Not tested" list. The topic rules live in `.cursor/rules/*.mdc`; this file is the summary that always applies.

## Layout

| Path | What it holds |
|---|---|
| `engines/` | Meterless reference engines (H-MEM, Markovian, World Model) and their conformance suites, vendored unchanged. See `engines/UPSTREAM.md`. |
| `gateway/` | Python 3.12 Zetaris gateway (FastAPI + JayDeBeApi) on 127.0.0.1:8803: named SQL templates, allowlist, registrar plans, execution-contract checks, `run_sql` for the SQL files. |
| `zetaris/` | `manifest.json`, `sql/NN_won_*_create.sql` / `_select.sql` pairs, `README.md` with verified counts and timings. |
| `agent/` | Node 22 + TypeScript (run with tsx, no runtime dependencies): Markovian loop, H-MEM facade, World Model wrapper, deterministic tools (`src/tools/`), model client, gateway client, evidence store, server and CLI. Tests in `agent/test/`. |
| `ui/` | Plain HTML, CSS and ES modules, no build step, served by the agent server on 127.0.0.1:8804. |
| `seeds/` | Committed: `utilities.json` (CIK, name, ticker, SIC, states served, station ids; curated from public filings and labelled as such) and `stations.json` (GHCN station ids, state, name). No SEC fact values. |
| `scripts/` | Dev-time curation (`curate-seeds.py`, `demo_pick.py`), cache warm-up (`warmup.py`), an operator's registrar call (`registrar_call.py`). Not part of the agent. |
| `docs/` | Cursor task files, how the tools were built, demo case, evaluation report, deck and video material. |
| `data/` | Runtime state (runs, evidence, SQL log, H-MEM, contract ledgers, logs). Gitignored entirely. |

## Rules that always apply

1. **Zetaris SQL.** Lightning SQL only (not Spark or Hive SQL). One statement per call, no trailing semicolon, qualified names. A multi-table `COMPILE USL` is sent as one statement. The agent never builds SQL: it sends a template id and parameters to the gateway, and the gateway validates every parameter against a fixed pattern before substitution. Details in `.cursor/rules/zetaris.mdc`.
2. **Zetaris scope.** Touch only the `CW_*` Lightning databases, the SchemaStore container `cw` and the namespace `lightning.metastore.crosswalk`. `COMPANY_DNS` may be read if the instance has it. Never `DROP`, `GRANT`, `REVOKE` or `INVALIDATE CACHE` from code, anywhere. Never call port 8889. Never touch another project's databases or cached tables on the shared driver.
3. **Engines are read-only.** Never edit anything under `engines/`. Extend from `agent/src/` (subclass, wrap, compose). Details in `.cursor/rules/meterless.mdc`.
4. **The model never decides and never computes.** Nemotron plans, reads tool results, picks the next hypothesis and writes the explanation. Degree days are computed in Lightning SQL, growth, peers, the recast rule and the attribution with its bootstrap ranges in deterministic TypeScript (`agent/src/tools/`). Every number in the memo must equal a tool output (string match; one retry, then a template memo). Results carry ranges and confidence labels, never a point estimate alone, and a "Not tested" list. Details in `.cursor/rules/safety.mdc`.
5. **One data path.** At runtime the agent reads SEC EDGAR, NOAA GHCN and company_dns only through Zetaris (via the gateway). The only exception is the dev-time curation in `scripts/`. The model runs in local Ollama on 127.0.0.1:11434 only; zero cloud model calls.
6. **Source etiquette.** SEC EDGAR: at most 10 requests per second, always with the declared `User-Agent` from `CW_USER_AGENT`; SEC data is queried live and never redistributed (no extracted fact values in the repository; counts and schemas are fine). NOAA GHCN-Daily parquet is read anonymously from the public bucket. company_dns is called with an identifying `User-Agent`. Never invent or reuse a contact. Details in `.cursor/rules/data-licences.mdc`.
7. **Secrets.** Credentials, `CW_USER_AGENT` and `CW_CONTRACT_SECRET` live only in `.env.local` (gitignored). Never put them in prompts, logs, code, tests, fixtures, SQL files or commit messages; the SQL files carry the placeholder `YOUR_APP_NAME YOUR_CONTACT_EMAIL`, filled on the wire only.
8. **Public text.** Repository files name no AI assistant, model vendor or coding tool; the one exception is the sentence stating that the project was developed in Cursor, in `README.md` and `docs/how-cursor-was-used.md`. No local paths, no contact addresses, no secrets. Dominion Energy is never the demo case.
9. **Integrity.** Report only measured numbers, each with its label (`measured` or `estimated`). Never fabricate filing values, management quotes or analyst history. Synthetic fixtures are labelled synthetic. Wording for attribution results: "consistent with", "accounts for roughly".

## Commands

```bash
# Agent (Node 22)
cd agent && npm ci && npm test
cd agent && npm run typecheck                       # whole tree
cd agent && npx tsc --noEmit -p tsconfig.tools.json  # deterministic tools only
cd agent && npm run ask -- --cik 0001031296 --period CY2025Q1 --claim "colder weather"

# Gateway (Python 3.12, venv at the repo root)
python -m venv .venv && .venv/Scripts/pip install -r gateway/requirements.txt
.venv/Scripts/python -X utf8 -m pytest gateway/tests -q
.venv/Scripts/python -X utf8 -m gateway.app          # 127.0.0.1:8803, reads .env.local
.venv/Scripts/python -m gateway.run_sql zetaris/sql/01_won_sec_create.sql --dry-run
.venv/Scripts/python scripts/warmup.py               # re-CACHE every view before a demo

# Meterless conformance (once per engine: cd engines/<engine>/reference && npm install)
cd engines/hmem/reference && npx tsx ../conformance/runner.ts
```

## Git

- Stage explicit paths only (`git add <path> ...`), never `git add -A` or `git add .`.
- Plain commit messages, no trailers. Cursor Agent task prompts say "Do not commit"; the reviewer commits the task's files as `Cn: <task> (Cursor Agent)` and any fixes in a separate commit.
- Never commit `.env.local`, anything under `data/`, extracted SEC data, transcripts or notes.
- `AGENTS.md` and `.cursor/rules/` are the only agent instruction files in this repository; do not add others.
