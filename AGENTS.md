# Crosswalk: rules for coding agents

Crosswalk answers a cross-agency question nobody has a data engineer for (Open Agent Hackathon 2026, Track 1: Solving Fragmented Intelligence). The demo question: which investor-owned electric utilities served states with FEMA major-disaster declarations in Q1 2025, what did the weather at their stations do that quarter, and did their revenue hold up year on year? The product is not the answer table alone: it is the discovery that produced it (a bounded catalogue search, shape probes, join-key proposals measured in Lightning SQL as match rates with named orphans), the join map, and the governed Zetaris semantic layer (a USL with primary and foreign keys and data-quality rules) that colleagues can query afterwards. The topic rules live in `.cursor/rules/*.mdc`; this file is the summary that always applies.

## Layout

| Path | What it holds |
|---|---|
| `engines/` | Meterless reference engines (H-MEM, Markovian, World Model) and their conformance suites, vendored unchanged. See `engines/UPSTREAM.md`. Never edited. |
| `gateway/` | Python 3.12 Zetaris gateway (FastAPI + JayDeBeApi) on 127.0.0.1:8803: named SQL templates, allowlist, registrar plans, execution-contract checks, `run_sql` for the SQL files. Env prefix `CW_`. |
| `zetaris/` | `manifest.json` and `sql/NN_cw_*_create.sql` / `_select.sql` pairs with verified counts in `README.md` (written by the Zetaris lane). `sql/won-reference/` holds the sister entry's verified SQL, unchanged, as a reference only. |
| `agent/` | Node 22 + TypeScript (tsx, no runtime dependencies): the discovery loop (Markovian), H-MEM facade, World Model wrapper, deterministic tools (`src/tools/`), model client, gateway client, evidence store, server and CLI. Tests in `agent/test/`. |
| `ui/` | Plain HTML, CSS and ES modules, no build step, served by the agent server on 127.0.0.1:8804. Screens: Ask, Discovery timeline, Join map, USL & DQ, Answer; telemetry footer. |
| `seeds/` | Committed inputs: `utilities.json` (43 utilities: CIK, name, ticker, SIC, states served, station ids; curated from public filings), `stations.json` (56 GHCN stations with state), `states.json` (50 states + DC with FIPS codes), `catalogue.json` (the discovery catalogue: sources, licences, status, traps). No SEC fact values. |
| `scripts/` | Dev-time scripts (seed curation, cache warm-up, an operator's registrar call, one-off checks). Not part of the agent. |
| `docs/` | Cursor task files, how the tools were built, demo case, evaluation report, deck and video material. |
| `data/` | Runtime state (runs, evidence, SQL log, H-MEM, World Model, contract ledgers, logs). Gitignored entirely. |

## Rules that always apply

1. **Zetaris SQL.** Lightning SQL only (not Spark or Hive SQL). One statement per call, no trailing semicolon, qualified names. A multi-table `COMPILE USL` is sent as one statement. The agent never writes SQL: it sends a template id and parameters to the gateway, or a structured proposal that a deterministic renderer turns into SQL; the gateway validates every parameter against a fixed pattern. Details in `.cursor/rules/zetaris.mdc`.
2. **Zetaris scope.** Touch only the `CW_*` Lightning databases (`CW_FEMA`, `CW_SEC`, `CW_DNS`, `CW_GHCN`), the SchemaStore container `cw` and the namespace `lightning.metastore.crosswalk`. `COMPANY_DNS` may be read if the instance has it. Never `DROP`, `GRANT`, `REVOKE` or `INVALIDATE CACHE` from code, anywhere. Never call port 8889. The instance, its driver cache and the local Ollama are shared with the sister entry Weather-or-Not (`WON_*`, `won`, `lightning.metastore.weatherornot`, gateway 8793, UI 8794): never read, cache, uncache, drop or alter any of its objects, never stop its gateway.
3. **Engines are read-only.** Never edit anything under `engines/`. Extend from `agent/src/` (subclass, wrap, compose). Details in `.cursor/rules/meterless.mdc`.
4. **Discovery is bounded and the model never computes.** The six discovery tools are host-run and deterministic: `search_catalogue(query)` (the getting-started manifest, our registered objects, the live OpenFEMA catalogue), `probe_source(object)` (DESCRIBE, five rows, distinct counts of candidate key columns), `propose_keys()` (the model proposes up to six `{left, right, transform}` choices, schema-validated against the closed transform set), `measure_key(proposal)` (the match-rate statement over two cached views: distinct left keys, matched keys, orphan sample), `register_source(spec)` (registrar plan under a signed medium-risk contract, catalogue sources only), `compile_usl(plan)` (DDL rendered from verified keys, COMPILE, ACTIVATE from raw tables, RUN DQ bounded). Nemotron picks and proposes; it never writes DDL or SQL and never produces a number. Closed transform set: `identity`, `upper`, `lpad10`, `substr(start,len)`, `strip_prefix('US-')`, `yyyymmdd_to_date`, `iso_to_quarter`. A key is VERIFIED at a match rate of 0.95 or more, PARTIAL at 0.80 or more (named as such in the join map), REJECTED below. Details in `.cursor/rules/safety.mdc`.
5. **One data path.** At runtime the agent reads OpenFEMA, SEC EDGAR, NOAA GHCN and company_dns only through Zetaris (via the gateway). Cross-source joins and match rates run over CACHED views; raw cross-source joins are never issued; USL activation is always from raw tables. The only exception is dev-time curation in `scripts/`. The model runs in local Ollama on 127.0.0.1:11434 only; zero cloud model calls.
6. **Source etiquette and licences.** SEC EDGAR: at most 10 requests per second, always with the declared `User-Agent` from `CW_USER_AGENT`; queried live, never redistributed (no extracted fact values in the repository; counts and schemas are fine). NOAA GHCN-Daily is CC0 and read anonymously from the public bucket. company_dns is Apache-2.0 and called with an identifying `User-Agent`. OpenFEMA is public US federal data, no key; FEMA is cited as the source and nothing is presented as FEMA-endorsed. Never invent or reuse a contact. Details in `.cursor/rules/data-licences.mdc`.
7. **Secrets.** Credentials, `CW_USER_AGENT` and `CW_CONTRACT_SECRET` live only in `.env.local` (gitignored). Never put them in prompts, logs, code, tests, fixtures, SQL files or commit messages; the SQL files carry the placeholder `YOUR_APP_NAME YOUR_CONTACT_EMAIL`, filled on the wire only.
8. **Public text.** Repository files name no development assistant, model vendor or coding tool; the one exception is the sentence stating that the project was developed in Cursor, in `README.md` and `docs/how-cursor-was-used.md`. Sponsor technology is named (Zetaris Lightning, the Meterless engines, NVIDIA Nemotron via Ollama). No local paths, drive letters, contact addresses or secrets. Dominion Energy is never the demo pick; the demo utilities are whoever the FEMA join selects, never hand-picked.
9. **Integrity.** Report only measured numbers, each with its label (`measured` or `estimated`). Match rates, orphans, counts and DQ results come from Lightning SQL through the gateway and are cited by their SQL text. Never fabricate filing values, declarations or station data. Synthetic fixtures are labelled synthetic. The answer card carries a Not-tested list (county geography, non-DR declarations, fuel pass-through, recasts).

## Inherited code (same author)

The scaffold is Weather-or-Not's (gateway, engines, loop, memory, world, server, UI shell, evidence store), which in turn came from ClearShelf; files keep the header note "Adapted from Weather-or-Not and ClearShelf (same author, Apache-2.0)" and the lineage is declared under pre-existing code in `metadata.json` and the README. Modules that are specific to Weather-or-Not's question (degree-day attribution, like-for-like revenue, the recast rule, its planner and memo prompts, its reader templates in `gateway/templates.py` marked "inherited; Day-1 lane replaces") stay only until the Crosswalk agent lane replaces them; do not extend them.

## Commands

```bash
# Agent (Node 22)
cd agent && npm ci && npm test
cd agent && npm run typecheck                       # whole tree
cd agent && npx tsc --noEmit -p tsconfig.tools.json  # deterministic tools only

# Gateway (Python 3.12, venv at the repo root)
python -m venv .venv && .venv/Scripts/pip install -r gateway/requirements-dev.txt
.venv/Scripts/python -X utf8 -m pytest gateway/tests -q
.venv/Scripts/python -X utf8 -m gateway.app          # 127.0.0.1:8803, reads .env.local (CW_GATEWAY_PORT overrides)
.venv/Scripts/python -m gateway.run_sql zetaris/sql/<file>.sql --dry-run

# Known-answer fixtures for the Cursor tasks (independent of the TypeScript under test)
python agent/test/fixtures/make_crosswalk_fixtures.py

# Meterless conformance (once per engine: cd engines/<engine>/reference && npm install; then git checkout -- engines)
cd engines/hmem/reference && npx tsx ../conformance/runner.ts
```

## Git

- Stage explicit paths only (`git add <path> ...`), never `git add -A` or `git add .`.
- Plain commit messages, no trailers. Cursor Agent task prompts say "Do not commit"; the reviewer commits the task's files as `Cn: <task> (Cursor Agent)` and any fixes in a separate commit.
- Never commit `.env.local`, anything under `data/`, extracted SEC or FEMA data, transcripts or notes.
- `AGENTS.md` and `.cursor/rules/` are the only agent instruction files in this repository; do not add others.
