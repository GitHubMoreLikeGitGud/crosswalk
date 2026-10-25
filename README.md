# Crosswalk

[![ci](https://github.com/GitHubMoreLikeGitGud/crosswalk/actions/workflows/ci.yml/badge.svg)](https://github.com/GitHubMoreLikeGitGud/crosswalk/actions/workflows/ci.yml)

**Crosswalk works out how FEMA, SEC and NOAA data join before it answers a question that needs all three: it measures each join key in Zetaris Lightning SQL (or recalls one an earlier run verified), names the rows that fall out, answers each column only through a key that passed, and leaves a governed semantic layer behind.**

Open Agent Hackathon 2026, Track 1: Solving Fragmented Intelligence. Team: Umar Mohktar, Singapore - solo.

Demo video (3:29): https://youtu.be/AJyT-ar1LBs · Deck (PDF): [`docs/deck/Crosswalk.pdf`](docs/deck/Crosswalk.pdf) · Evaluation: [`docs/eval-report.md`](docs/eval-report.md) · The demo case step by step: [`docs/demo-case.md`](docs/demo-case.md) · How Cursor was used: [`docs/how-cursor-was-used.md`](docs/how-cursor-was-used.md)

**Why it matters.** SEC publishes a company's number unpadded in one API and as a ten-digit string in another. Joined as published, 0 of 43 utilities match, and the revenue column of a cross-agency answer silently comes back empty; with the transform Crosswalk measured (zero-padding to ten digits), 42 of 43 match and the one that does not, IDACORP, is named. A state utility-commission analyst who asks which utilities served states with FEMA major-disaster declarations in Q1 2025 gets 12 utilities in 7 states, each number one click from the Lightning SQL behind it.

![The Crosswalk answer screen for a saved cold run of Q1 2025, shown as a replay: twelve investor-owned electric utilities that served states with FEMA major-disaster declarations, with the declarations per state by incident type, the revenue change against Q1 2024 under the tag each one reports (Sempra not compared), and the degree-day change at their weather stations; every number opens the Lightning SQL that produced it.](docs/deck/img/answer.png)

**The problem.** An analyst at a state utility commission, with no data engineer on call, gets a question that crosses three agencies: *"Which investor-owned electric utilities served states with FEMA major-disaster declarations in Q1 2025, what did the weather at their stations do that quarter, and did their revenue hold up year on year?"* FEMA names states by two-letter code and by FIPS number, SEC EDGAR names a company by an unpadded integer CIK in one API and a ten-digit string in another, NOAA names weather by station id. Nobody has written down which columns join, under which transform, and which rows drop out. Crosswalk finds that out first, measures it, and only then answers.

**The demo result.** The FEMA join selects 12 utilities in the 7 declared states that the seed utilities serve (CA, KY, MO, OK, OR, SC, WV): revenue rose for 9 of them against Q1 2024, fell for Edison International (-6.55%) and Portland General Electric (-0.11%), and is not compared for Sempra (it reported under a different tag a year earlier), while total degree days at their stations rose for all 12 (+1.13% to +22.89%). Before answering, the agent measured seven governed join keys in Lightning SQL: five VERIFIED, FEMA state to served state PARTIAL (Alaska has a declaration and no seed utility serves it), and the CIK control without zero-padding REJECTED (0 of 43 rows), with IDACORP (no Q1 2025 revenue fact) and MGE Energy (SIC 4900, a code on SEC's own SIC list that the third-party company_dns reference lacks) named as the orphans. The answer reads each column only through a key that passed: the FEMA selection through the FEMA state key (PARTIAL or better), revenue through the padded CIK key and weather through the station key (both VERIFIED). The gate was added after the evaluation runs: replayed offline under it, the six cold runs give the same 12-row answer, and the warm Q1 2024 run's FEMA selection is withheld ([Evaluation](#evaluation)).

*Words used here.* **VERIFIED**: at least 95% of the counted table's rows (of its distinct key values, for a pair measured by the generic `match_rate` statement) find a match under the key's transform; **PARTIAL**: 80% to 95%, usable with care; **REJECTED**: under 80%, the key does not join. An **orphan** is a row whose key value has no match on the other side. **DQ invalid** is a row that breaks a foreign-key rule when Zetaris runs the semantic layer's data-quality check. A **cold** run remembers nothing and measures every key; a **warm** run recalls the keys an earlier run VERIFIED and skips re-measuring them.

**What you would see**

1. **Discovery:** a live timeline in which the agent searches a catalogue, probes the shape of each cached Zetaris view, proposes join keys, and has every proposal measured in Lightning SQL ("42 of 43 rows (97.7%), VERIFIED").
2. **Join map:** every key with its match rate, its verdict defined in plain words beside it and its orphans by name; the semantic layer screen shows the governed model, the data-quality results and MGE Energy as the one invalid row (a gap in the company_dns SIC list, see [Data quality](#zetaris-the-data-layer)).
3. **Answer:** the 12-row table; click any number for the SQL that produced it, the rows, the time it took and the cache state.

<details>
<summary><b>Verify in 3 minutes</b> (no Zetaris, no GPU): 376 agent tests, 24 UI tests, 381 gateway tests and the three Meterless conformance suites on a fresh clone</summary>

Node 22.12 or newer, Python 3.12, git. Measured on a fresh clone of commit `522a81c`, Windows 11, Node 22.13.1, Python 3.12.0, Git Bash:

```bash
cd agent && npm ci && npm test && npm run typecheck && cd ..   # found 0 vulnerabilities; Test Files 27 passed (27), Tests 376 passed (376); tsc exit 0
node --test ui/test/*.test.mjs                                 # tests 24, pass 24, fail 0
(cd engines/hmem/reference && npm install && npx tsx ../conformance/runner.ts)          # 13/13 checks passed
(cd engines/markovian/reference && npm install && npx tsx ../conformance/runner.ts)     # 8/8 checks passed
(cd engines/world-model/reference && npm install && npx tsx ../conformance/runner.ts && npx tsx scripts/idempotency-check.ts)   # 8/8 checks passed; diff: empty
git checkout -- engines                                        # npm install rewrites the licence field of the vendored lock files
python -m venv .venv && .venv/Scripts/pip install -r gateway/requirements-dev.txt   # macOS/Linux: .venv/bin/
.venv/Scripts/python -X utf8 -m pytest gateway/tests -q        # 381 passed, 2 skipped (the 2 need a live Zetaris)
```

Wall time on that clone: 51 s from `git clone` to the last test, the Python package install included; `git status` was clean afterwards. The same steps run in CI on `windows-latest` ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)), plus the agent and UI suites again with the clock moved forward 400 days (no test reads today's date); the CI run on `fd172e9`, the commit with the answer gate and the demo run, passed.

</details>

## What is per-question and what is generic

- **Per-question** (written for the demo question): the seeds (43 utilities with their served states and stations, 56 stations), the discovery catalogue, the governed USL plan, the seven governed join-map statements, the three answer statements (`answer_fema_utilities`, `answer_revenue`, `weather_quarter`), the registrar plans (`register_fema`, `register_frames`, `register_submission`, `register_stations`, `register_ghcn`), and the answer gate's three keys.
- **Generic** (any pair of cached views): the closed transform set and its match-rate renderer, the gateway's `match_rate` template with its orphan sample (every model proposal goes through it), the probe heuristic, the deterministic baseline proposer, the verdict rule, the USL plan validator and DDL renderer, `RUN DQ` on the plan's foreign keys, the key memories in H-MEM and the dated key edges in the World Model.
- **A new question** therefore needs its sources registered (a registrar plan per source), seeds for any hand-curated bridge, its answer statements and their gate keys; discovery, measurement, memory and the semantic-layer comparison run unchanged. This path has not been exercised on a second question beyond a change of quarter.

## Contents

[Per-question and generic](#what-is-per-question-and-what-is-generic) · [What it does](#what-it-does) · [What is new](#what-is-new) · [Quickstart](#quickstart) · [Architecture](#architecture) · [Zetaris](#zetaris-the-data-layer) · [Meterless](#meterless-reasoning-memory-and-contracts) · [NVIDIA](#nvidia-nemotron-3-nano-4b-locally) · [Cursor](#how-cursor-was-used) · [Evaluation](#evaluation) · [Limitations](#limitations) · [What did not go well](#what-did-not-go-well) · [Not measured](#not-measured) · [Responsible use](#responsible-use) · [Dependencies](#dependencies-and-licences) · [Data and licences](#data-and-licences) · [Pre-existing code](#pre-existing-code) · [Licence](#licence)

## What it does

For a calendar quarter, Crosswalk answers the demo question above over four public sources (OpenFEMA disaster declarations, SEC EDGAR XBRL frames and submissions, NOAA GHCN-Daily weather and the company_dns SIC list), all read through Zetaris Lightning. The product is not only the answer table: it is the discovery that produced it, the join map, and the governed semantic layer that a colleague can query afterwards.

- **Bounded discovery, every step a tool.** The agent runs six discovery tools over a fixed catalogue: `search_catalogue` (our registered Zetaris objects, the Zetaris getting-started manifest and the live OpenFEMA dataset list), `probe_source` (DESCRIBE, five rows and distinct counts of the candidate key columns), `propose_keys` (up to six `{left, right, transform}` choices from an enumerated menu of the probed columns and a closed transform set), `measure_key` (the match-rate statement in Lightning SQL over two cached views), `register_source` (a catalogue source registered and cached under a signed contract) and `compile_usl` (the semantic-layer model rendered from the verified keys and compared with the governed one). Then `answer`, `not_tested` and `finalize`. The fixed order of these steps is a checklist; the model chooses within it and proposes keys, and nothing it proposes is used unmeasured.
- **Every key measured, with its orphans.** For the seven governed keys, a named join-map statement counts matched rows over the rows of the table being counted (the snapshot's 43 filers, the 56 seed stations; the two FEMA keys count the quarter's distinct declared states), with the distinct-value reading shown beside it. Every other pair, which includes every model proposal and the baseline's generic pairs, goes through the gateway's generic `match_rate` statement, which counts distinct key values (nulls dropped), and its verdict uses that distinct-key rate (`agent/src/tools/discovery.ts`, `measureGeneric`). Up to 10 orphans are listed either way. The closed transform set is `identity`, `upper`, `lpad10`, `substr(start,len)`, `strip_prefix('US-')`, `yyyymmdd_to_date`, `iso_to_quarter`.
- **A governed semantic layer.** `crosswalk_usl` in Zetaris (7 tables, 6 foreign keys) is compiled and activated from the cached views at onboarding, where every foreign-key rule's data-quality check runs (`RUN DQ`, bounded at 900 s). On each question, `compile_usl` renders the model from the keys this run verified, compares it with the governed one, and runs the two fast DQ rules live.
- **An answer gated on the join map.** The `answer` step reads this run's join map before it runs a statement: the FEMA selection needs the FEMA state key at PARTIAL or better (PARTIAL is said to be usable with care), the revenue column needs the padded CIK key VERIFIED, and the weather column needs the station key VERIFIED, each measured in the run or recalled. A key that fails withholds its part of the answer, and the Not-tested list says which key and why (`answerGate` in `agent/src/tools/discovery.ts`; unit tests with REJECTED fixtures in `agent/test/answer-gate.test.ts`).
- **A cited answer.** For each utility with a served state that has a major-disaster (DR) declaration in the quarter: the declarations by incident type, the revenue change year on year under the first available XBRL tag (named, and not compared when the tag differs between the years), and the change in total heating plus cooling degree days at its seed stations. Every number links to the Lightning SQL statement that produced it, its rows, its time and its cache state. A Not-tested list names what the method does not see.
- **Memory for the next question.** VERIFIED keys are stored in H-MEM with the SQL that measured them; a warm run recalls them and skips re-measuring. Views registered at run time become probe targets for later runs.

## What is new

Crosswalk reuses the scaffolding of the author's earlier entries (see [Pre-existing code](#pre-existing-code)). New in this entry:

- **Join discovery as the product.** Catalogue search, shape probes, key proposals from an enumerated menu, match rates measured in Lightning SQL with named orphans, run-time registration under a contract, and a semantic-layer comparison, each as an agent action with its own evidence.
- **The join map as the main artefact**, with both rates, the verdict defined next to it, the orphans, and who proposed the key (the model, the deterministic baseline or the host's control).
- **A scored model decision.** Every run records how many keys the model proposed and how many were VERIFIED, PARTIAL or REJECTED, next to a deterministic column-name baseline on the same probes. The published result is that the baseline wins (see [Evaluation](#evaluation)).
- **Negative memories from the vendor's own notes.** The getting-started manifest's `known_to_fail` notes are seeded into H-MEM as negative memories and flagged in catalogue search. No catalogue search in the saved runs hit one (0 flagged results in any of the 19 saved runs of 25 Oct, the two runs recorded for the video included); the flagging is exercised by unit tests only.
- **Cold against warm on a second question.** The Q1 2024 question recalls the keys the Q1 2025 run verified, skips their measure steps (6 skipped in the Day-2 warm run; 8 in the warm Q1 2023 run recorded for the video, outside the evaluation) and registers what the new quarter needs.
- **An answer gated on its keys.** Each answer column runs only through a key the join map passed in the same run or recalled (see [What it does](#what-it-does)).
- **A note whose words are checked.** The model's note is checked for numbers and for words: verdict counts, revenue direction words per utility, and counts of utilities, states and declarations must match the run; a failing draft gets one repair, then a 250-word template.

## Quickstart

### A. Without Zetaris or a GPU

The [Verify in 3 minutes](#crosswalk) box above. Then the analyst UI starts on the committed demo run (below):

```bash
cd agent && npm run dev        # http://127.0.0.1:8804
```

Real runs are not committed (they hold SEC values, which are queried live and not redistributed). One redacted run is: [`docs/demo-run/`](docs/demo-run/) holds the Day-2 cold run `r20261025T1546471209` of the demo question with its revenue values, accession numbers and degree days replaced by synthetic numbers that keep each change's sign (written by `scripts/make_demo_run.py`, the same redaction as the server test fixtures). While `data/runs/` has no run of its own, the server lists it under a REPLAY banner that says "redacted demo run (synthetic revenue and weather values)", so all five screens open on a fresh clone; the USL screen reads the onboarding DQ counts from the same folder while `data/dq/latest.json` is absent. The first run you save replaces it in the list. Checked on a fresh clone on 25 Oct with the UI on a spare port (`UI_PORT`) and no gateway: `/api/runs` listed the one demo run and the Answer screen showed the 12-row replay. Without a gateway `/api/health` reports `gateway_ok: false`.

### B. Full stack: Zetaris, gateway, agent and UI

**Prerequisites**

- Docker Desktop with the Zetaris platform installed locally: Zetaris 2.4.3.1 with the `ui`, `api`, `driver` and `postgres` containers (UI on `localhost:3000`, JDBC on `localhost:10000`). The bundle, which includes the JDBC driver JAR, comes from the "Run locally" page of a Zetaris Cloud account.
- Java 11 or newer (tested with 21), Python 3.12, Node 22.12 or newer.
- [Ollama](https://ollama.com) (tested with 0.40.7) and `ollama pull nemotron-3-nano:4b`.
- Tested on Windows 11. The commands are PowerShell; on macOS or Linux use `.venv/bin/`.

**Steps**

```powershell
Copy-Item .env.local.example .env.local
#   ZETARIS_JDBC_JAR, ZETARIS_ADMIN_USERNAME/_PASSWORD   the driver JAR and your Zetaris login
#   CW_USER_AGENT        "<application name> <operator contact>", the User-Agent SEC EDGAR asks for
#   CW_CONTRACT_SECRET   python -c "import secrets; print(secrets.token_hex(32))"

python -m venv .venv
.venv\Scripts\pip install -r gateway\requirements.txt

# Zetaris objects in the manifest's order (zetaris/manifest.json); --dry-run prints the statements first
foreach ($f in "01_cw_fema","02_cw_stations","03_cw_sec","04_cw_dns","05_cw_seeds","08_cw_seed_names","09_cw_ghcn","10_cw_seed_snapshot") {
  .venv\Scripts\python -X utf8 -m gateway.run_sql "zetaris\sql\$($f)_create.sql" --skip-exists
}
.venv\Scripts\python -X utf8 -m gateway.run_sql zetaris\sql\07_cw_usl_create.sql --skip-exists --timeout 900

.venv\Scripts\python -X utf8 -m gateway.app            # terminal 1: gateway on 127.0.0.1:8803, re-caches the views at start

cd agent
npm ci
cmd /c "npm run onboard"                               # idempotent: register_source per source, USL check, RUN DQ x 6, data/dq/latest.json
cmd /c "npm run ask -- --quarter CY2025Q1 --cold"      # the demo question, cold
cmd /c "npm run ask -- --quarter CY2024Q1"             # the second question, warm
npm run dev                                            # terminal 2: http://127.0.0.1:8804
```

- PowerShell drops the `--` of `npm run ask -- ...`; `cmd /c` keeps it.
- `npm run onboard` took 501.5 s on 25 Oct (most of it the six `RUN DQ` statements); `npm run onboard -- --skip-dq` is the 32-second idempotency check. Onboarding and a question never run at the same time (a lock file).
- Every statement the runner and the gateway send is checked against `gateway/allowlist.py` (hosts `www.fema.gov`, `data.sec.gov`, `company-dns.mediumroast.io` and the `noaa-ghcn-pds` bucket; only `CW_*` databases, the `cw` container and the `lightning.metastore.crosswalk` namespace) and logged with its sha256 to `data/evidence/sql_log.jsonl`.
- The SQL files carry a User-Agent placeholder that is filled from `CW_USER_AGENT` on the wire only.

**Command line** (from `agent/`): `npm run replay -- <run_id>` prints a saved run without the model or the gateway; `npm run cli -- runs` lists runs; `npm run cli -- why <memory_id>` prints the ledger of one memory; `npm run cli -- known --left <object.column> --right <object.column>` answers "what did we know about this key, and since when" (a period-specific view is named by its family, for example `--left cw.seed_submissions_snapshot.cik10 --right "cw.frames_*_CY2025Q1.cik"`). The HTTP API the UI is built on is in [`docs/api.md`](docs/api.md).

## Architecture

![Crosswalk architecture: OpenFEMA, SEC EDGAR, NOAA GHCN-Daily and the company_dns SIC list are read only through Zetaris Lightning, as REST and filestore tables, cached SchemaStore views and the crosswalk_usl semantic layer with foreign-key DQ rules; a gateway exposes named SQL templates and contract-checked registrar plans; the agent runs six discovery tools in a Markovian loop with Nemotron proposing keys, H-MEM keeping verified keys and the World Model keeping key edges with their dates; the analyst reads the join map and the cited answer in the UI.](docs/architecture.png)

The figure is drawn by [`docs/architecture.py`](docs/architecture.py) ([SVG](docs/architecture.svg)). A question runs like this:

1. **Zetaris** federates the sources as Lightning REST tables (OpenFEMA, SEC frames and submissions, company_dns) and filestore tables (the GHCN station inventory as a one-column CSV, GHCN-Daily parquet by year and element), flattens and caches them as SchemaStore views in the container `cw`, and models them in the `crosswalk_usl` Unified Semantic Layer with primary and foreign keys whose DQ rules list the invalid rows.
2. **The gateway** (`gateway/`, Python, FastAPI + JDBC, `127.0.0.1:8803`) is the only route to Zetaris. The agent sends a template id and parameters, never SQL; the gateway checks every parameter against a fixed pattern (object names against the manifest, transforms against the closed set, columns against DESCRIBE), runs one of 59 named templates and logs the statement with its sha256. Registrar plans run only under a signed medium-risk contract.
3. **The discovery loop** (`agent/src/loop/`) runs the vendored Markovian orchestrator: at most 12 chunks, an 800-token carried state, up to three tool calls per chunk. Nemotron chooses the next step among those the checklist allows and proposes keys; an invalid reply gets one repair round, and a second failure makes the host take the next checklist step itself (a fallback step, counted).
4. **Deterministic tools** (`agent/src/tools/`) render the match-rate SQL, parse its result and apply the verdict rule, rank the catalogue, pick candidate key columns, compute the baseline proposals, render and validate the USL plan, and build the answer.
5. **H-MEM and the World Model** (`agent/src/memory/`, `agent/src/world/`) keep VERIFIED keys and registered sources with their Zetaris provenance, and a graph of datasets, columns, utilities, states and declarations whose `crosswalks_to` edges carry the transform, the rate and the time of measurement.
6. **The server and the analyst UI** (`agent/src/server.ts`, `ui/`, plain HTML and ES modules over server-sent events, `127.0.0.1:8804`): Ask, Discovery timeline, Join map, USL and DQ, Answer with a per-cell provenance drawer, and a telemetry footer. Saved runs replay without the model under a REPLAY banner; a run in progress shows LIVE; never both.

| Path | What it holds |
|---|---|
| `agent/` | Node 22 + TypeScript (tsx, no runtime dependencies): loop, tools, memory, World Model, contracts, evidence, server, CLI, evaluation; tests in `agent/test/` |
| `gateway/` | Python 3.12 Zetaris gateway: templates, allowlist, registrar, contract check, JDBC channel, SQL runner; tests in `gateway/tests/` |
| `zetaris/` | Lightning SQL `NN_cw_*_create.sql` / `_select.sql` pairs, the manifest, verified counts and timings ([`zetaris/README.md`](zetaris/README.md)) |
| `seeds/` | 43 utilities (CIK, name, ticker, SIC, states served, station ids), 56 GHCN stations, 50 states + DC, the discovery catalogue, the governed USL plan |
| `scripts/` | onboarding helpers, warm-up, snapshot and SQL generators, join-map measurement (not part of the agent) |
| `ui/` | analyst UI, no build step |
| `engines/` | Meterless H-MEM, Markovian and World Model reference engines, vendored unchanged |
| `docs/` | evaluation report and its JSON, demo case, API, conformance, architecture figure, Cursor task files |

Everything under `data/` is runtime state and gitignored: runs, evidence, the SQL log, H-MEM, the World Model, the DQ file and the contract ledgers.

## Zetaris: the data layer

Zetaris is Crosswalk's only runtime path to data. Instance: local Docker, Zetaris Lightning 2.4.3.1 over JDBC. Counts and timings below come from [`zetaris/README.md`](zetaris/README.md) unless another file is named.

| Object | Source | Measured |
|---|---|---|
| `CW_FEMA.declarations_dr_<quarter>` -> `cw.fema_declarations_dr_<quarter>` | OpenFEMA `DisasterDeclarationsSummaries`, DR declarations dated in the quarter (`$filter` percent-encoded) | Q1 2025: 116 county rows, 10 declarations, 8 states; Q1 2024 (registered through the gateway's `register_source` endpoint by an operator call before the first question run; every run found it already registered): 72 rows, 14 declarations, 11 states. Both equal the same URL fetched outside Zetaris |
| `CW_FEMA.datasets_catalogue` -> `cw.fema_catalogue` | OpenFEMA dataset list | 44 rows, 43 distinct names |
| `CW_GHCN.ghcnd_stations_txt` -> `cw.stations` | `ghcnd-stations.txt` as a one-column CSV with a delimiter that never occurs, parsed by `SUBSTR` | 133,039 rows; the 56 seed stations all present with the same state |
| `CW_SEC.frames_<tag>_<period>` -> `cw.frames_<tag>_<period>` | SEC XBRL frames, three revenue tags x CY2025Q1 and CY2024Q1 (plus CY2023Q1 and CY2022Q1, registered at run time) | 1,937 / 2,095 / 2,546 / 2,654 / 20 / 22 facts, one row per filer |
| `CW_SEC.submissions_<cik10>` -> `cw.submission_<cik10>` | SEC submissions, 43 seed utilities | read once at onboarding into the snapshot view `cw.seed_submissions_snapshot` (43 rows), which the question path reads |
| `CW_DNS.sic_codes_v4_raw` -> `cw.sic_codes` | company_dns SIC list | 1,005 codes |
| `CW_GHCN.ghcn_<year>_<element>` -> `cw.ghcn_<year>_<element>` | GHCN-Daily parquet, 2024 and 2025, TMAX and TMIN, filtered to the seed stations plus one validation station | 57 stations each; degree days equal an independent parquet read to 0.01 |
| `cw.states`, `cw.utility_states`, `cw.seed_stations`, `cw.seed_utility_names` | the committed seed files as inline `VALUES` views | 51, 97 pairs, 56, 43 rows |

Every view is cached; the gateway's warm-up keeps 63 cache targets (its `/health` reported 63 already cached on 25 Oct).

**The match-rate statement.** `measure_key` sends the gateway one of the named join-map templates for the governed keys or the generic `match_rate` template for any other valid proposal. Each counts the left table's rows that find a match after the transform, the distinct-value reading beside it, and lists up to 10 orphans in a second statement. Cross-source joins run only over cached views. 0 of 399 question-path statements in the evaluation took over 20 s; the slowest is the two-view degree-day statement (18,135 ms) ([`docs/eval-report.md`](docs/eval-report.md), section 6).

**The semantic layer** `lightning.metastore.crosswalk.crosswalk_usl` (`zetaris/sql/07_cw_usl_create.sql`): one `COMPILE USL` statement, every table and column described, each table activated from the cached views (a raw REST table would re-fetch its endpoint on every read). Seven tables:

| `state` | `sic_code` | `utility` | `utility_state` | `fema_declaration` | `station` | `revenue_quarter` |
|---|---|---|---|---|---|---|
| 51 | 1,005 | 43 | 97 | 116 | 56 | 133 |

**Data quality.** The onboarding pass (`npm run onboard`, 25 Oct 13:46 SGT; results in `data/dq/latest.json`) ran `RUN DQ` on the six foreign-key rules:

| Rule | Total / valid / invalid | Time |
|---|---|---|
| `utility.sic` -> `sic_code` | 43 / 42 / **1** | 135.5 s |
| `utility_state.cik` -> `utility` | 97 / 97 / 0 | 72.0 s |
| `utility_state.state` -> `state` | 97 / 97 / 0 | 0.9 s |
| `fema_declaration.state` -> `state` | 116 / 116 / 0 | 2.9 s |
| `station.state` -> `state` | 56 / 56 / 0 | 37.7 s |
| `revenue_quarter.cik` -> `utility` | 133 / 133 / 0 | 84.5 s |

`SHOW DQ INVALID RECORD` names the one invalid row: MGE Energy (`0001161728`, SIC 4900, absent from the company_dns SIC list). **DQ caught a gap in the third-party reference, not an error in MGE Energy's data:** an outside check (`scripts/sic_outside_check.py`, 25 Oct, both lists fetched over HTTPS outside Zetaris) found 4900 on SEC's own SIC code list ("ELECTRIC, GAS & SANITARY SERVICES"), and 172 of the 444 codes on SEC's list missing from company_dns's 1,005; the codes are in [`docs/eval/sic-check.json`](docs/eval/sic-check.json). The other three seed SIC codes (4911, 4931, 4932) are on both lists. **What runs live on a question and what is read from that file:** `compile_usl` runs `fema_declaration.state` and `utility_state.state` live in every run (116 / 116 / 0 and 97 / 97 / 0 in the Day-2 runs); the other four rules, and the MGE row, are read from the onboarding file and shown with its date. The question path never reads the USL tables themselves (a read of `utility` takes about 62 s because it resolves 43 submission views); the answer reads the cached views, and the USL is the governed copy a colleague queries.

**Run-time registration.** `register_source` maps a catalogue id to a registrar plan (`register_fema`, `register_frames`, `register_submission`, `register_stations`, `register_ghcn`), signs a medium-risk contract and creates the REST or filestore table, its view and its cache. A Day-1 warm run (`r20261025T1413091c1c`) registered the three CY2023Q1 frames views this way (2,206, 2,755 and 22 rows, about 1 s each). In the Day-2 evaluation runs every registration answered `already_registered`. The warm Q1 2023 run recorded for the video (`r20261025T183917676f`, not part of the evaluation) registered FEMA Q1 2023 in 1.6 s and the three CY2022Q1 frames views in 1.1 to 1.4 s each ([`docs/video/shotlist.md`](docs/video/shotlist.md)).

**What we learned on 2.4.3.1** (each recorded in `zetaris/README.md` with the statement that showed it): a view may be referenced once per statement; `DESCRIBE BY` text accepts letters, digits, spaces and `_ . - ,` only; `CREATE LIGHTNING DATABASE` and `CREATE SCHEMASTORE CONTAINER` take no `IF NOT EXISTS`; the OpenFEMA `$filter` must be percent-encoded and its `metadata.count` is not a row count; a USL read pays one hop per source view, so the 43-view `utility` table is read at onboarding only.

## Meterless: reasoning, memory and contracts

The engines come from [Meterless/Meterless](https://github.com/Meterless/Meterless) at commit `1742dec56a66e58eef9dda2d2b865823758ca8cd`, vendored unchanged ([`engines/UPSTREAM.md`](engines/UPSTREAM.md)); Crosswalk extends them only from `agent/src/`, and `git diff -- engines/` is empty. Conformance output: [`docs/conformance.md`](docs/conformance.md).

| Engine | How Crosswalk uses it | Where | Conformance |
|---|---|---|---|
| **Markovian**, vendored | One question is one chain of bounded chunks (at most 12, carried state at most 800 tokens, planner output budget 3,072 tokens). The cold Day-2 runs used 9 or 10 chunks, the warm run 8 with 6 measure steps skipped from memory. | `agent/src/loop/` | 8/8 |
| **H-MEM**, vendored and extended by subclass | `key_verified` memories (left, right, transform, rate, verdict, orphans, the measuring SQL, the run and time) and `source_access` memories (a view registered at run time); a warm run recalls VERIFIED keys whose families the question reads and skips their measure steps, each recalled key shown as recalled with the key it was measured as. At boot the store is seeded from the getting-started manifest and its `known_to_fail` notes as negative memories. `why <memory_id>` prints the ledger. | `agent/src/memory/` | 13/13 vendored; 13/13 with the Crosswalk subclass through the engine's own runner |
| **World Model**, vendored and wrapped | Entities dataset, column, utility, state and declaration; edges `has_column`, `crosswalks_to` (transform, rate, verdict, valid from the measurement time), `serves` and `declared_in` (valid from the declaration date). `known --left --right` answers "what did we know about this key, and since when". | `agent/src/world/` | 8/8; idempotency check `diff: empty` |
| **Scout Intent**, partial reimplementation (no reference engine is vendored) | HMAC-signed, single-use execution contracts that expire within 15 minutes: medium risk for every `register_source` call, verified by the Python gateway with a shared test vector. An integrity check, not cryptographic-grade security. | `agent/src/contract/`, `gateway/contracts.py` | none (partial, labelled) |

## NVIDIA: Nemotron 3 Nano 4B, locally

**In one line:** every key the model proposed was measured in Lightning SQL before anything could use it, and the 7 of its 11 proposals that do not join were REJECTED there; on this question that guard, not the model, carries the result, since the deterministic baseline proposed more keys that join (25 of 30 VERIFIED against 3 of 11) and the no-model run reaches the same answer faster (below).

`nemotron-3-nano:4b` (Q4_K_M) runs in local Ollama (tested with 0.40.7): temperature 0, seed 7, `num_ctx` 8192, JSON-schema output validated on the host, one call at a time. The model host must be a loopback address; any other host is refused and counted (0 in every run), so cloud model calls are 0 by construction. Nemotron does two jobs and computes nothing:

1. **The planner** (think on): picks the next step among those the checklist allows, and in `propose_keys` chooses up to six `{left, right, transform}` pairs from an enumerated menu of the probed columns, so an invented view or column cannot be expressed. Every valid proposal is measured in Lightning SQL before anything uses it.
2. **The note** (think off): 100 to 250 words from the tool outputs. Every number must match a tool output and the words are checked against the run's facts; a failing draft gets one repair, then the template note.

Measured ([`docs/eval-report.md`](docs/eval-report.md), section 5; one run per setting on the same code):

| Setting | Wall | Output tokens | Median planner tokens/s | Model proposals: made / VERIFIED / PARTIAL / REJECTED | Answer |
|---|---|---|---|---|---|
| think on | 275.2 s | 22,047 | 132.9 | 1 / 0 / 1 / 0 | the 12-row answer |
| think off | 227.9 s | 15,813 | 133.1 | 2 / 1 / 0 / 1 | identical |
| no model (the baseline proposes, the host takes every step) | 88.4 s | 0 | n/a | n/a | identical |

The model holds 2,881 MiB of VRAM (Ollama's figure at context 8192). The 47.3 s gap between think on and think off is the size of the spread between the four think-on cold runs (38.1 s), so with one think-off run it is not claimed as an effect of thinking. The no-model run reaches the same answer and the same governed keys in 32% of the think-on wall time.

## How Cursor was used

Developed in Cursor; details in [docs/how-cursor-was-used.md](docs/how-cursor-was-used.md). Seven headless Cursor Agent tasks (C1 to C7, 25 Oct 2026) wrote the closed transform set and the match-rate SQL renderer, the USL plan validator and renderer, the FEMA and station parsers, the catalogue ranking and probe heuristic, the deterministic key-proposal baseline, the note word verifier and the join map screen; 3,208 of the 3,400 lines in their 21 files are still Cursor Agent's at `078f890`. The page lists each task's commits, wall time, what the reviewer changed and what was not built by Cursor Agent.

## Evaluation

All numbers are measured unless labelled otherwise. Day 0, Day 1 and Day 2 are the three build sessions of 25 Oct 2026 (SGT); the evaluation runs are the Day-2 runs. The full report is [`docs/eval-report.md`](docs/eval-report.md), generated by `agent/src/eval/run.ts` from seven saved Day-2 runs; its summary JSON and the side files are indexed in [`docs/eval/README.md`](docs/eval/README.md). The runs used code `6652e2f`, `ee04b0c` and `fc130bd`; between `fc130bd` and `cc0ac3c`, the code outside `docs/` changed only in the server's view functions (`agent/src/ops/cells.ts`, `agent/src/ops/usl.ts`), the UI, the header labels of the CLI replay (`agent/src/cli.ts`), the evaluation tools (`agent/src/eval/`), tests and CI; besides that, the configuration example dropped one unused key, two Zetaris SQL files changed in comments only, and one unused inherited script was removed from `scripts/`. After `cc0ac3c`, the answer gate was added (`agent/src/tools/discovery.ts`, `agent/src/loop/tools.ts`), with the committed demo run's fallback in the run store and the server (`agent/src/ops/runStore.ts`, `agent/src/runtime.ts`, `agent/src/server.ts`) and its run label (`ui/lib.js`), the offline replay (`agent/src/eval/gateReplay.ts`) and two scripts (`scripts/make_demo_run.py`, `scripts/sic_outside_check.py`); no saved run used that code.

**Reproducible.** 6 cold runs of the demo question (think on, think off, no model) give the same 12-row answer in every field and the same numbers and orphans for the 7 governed join-map keys; all 7 Day-2 answers equal the Day-1 reference runs.

**The join map** (every cold run):

| Key | Counted table -> other table | Transform | Matched / rows | Verdict | Orphans |
|---|---|---|---|---|---|
| (a) cik | submissions snapshot `cik10` -> frames `cik` (three tags) | lpad10 | 42 / 43 | VERIFIED | IDACORP (no CY2025Q1 fact under any tag) |
| (a) control | the same, without padding | identity | 0 / 43 | REJECTED | all 43 |
| (b) loc | frames `loc` -> submissions business state | substr(4,2) | 42 / 42 | VERIFIED | none |
| (c) FEMA state | FEMA `state` -> served states | identity | 7 / 8 | PARTIAL | AK |
| (c) FEMA FIPS | FEMA `fips_state_code` -> state reference | identity | 8 / 8 | VERIFIED | none |
| (d) station | seed station id -> GHCN inventory id | identity | 56 / 56 | VERIFIED | none |
| (e) SIC | submissions `sic` -> SIC reference, by utility rows (3 of 4 distinct codes) | identity | 42 / 43 | VERIFIED | MGE Energy (4900) |

In the warm Q1 2024 run the FEMA state key measures 8 of 11 = 0.727, REJECTED (AK, ME and VT have declarations and no seed utility); that run, saved before the answer gate existed, answered for 16 utilities and listed weather as Not-tested (GHCN 2023 is not registered).

**The answer gate, replayed on the saved runs.** The gate was added after the Day-2 runs, so none of them ran under it. `agent/src/eval/gateReplay.ts` replays a saved run offline: it computes the gate from the run's own join map and serves the answer's FEMA and revenue statements from the rows the run saved (no gateway, no model). On the seven Day-2 runs (`cd agent && npx tsx src/eval/gateReplay.ts <run.json> ...`, 25 Oct):

| Runs | FEMA state key | CIK key | Station key | Answer under the gate |
|---|---|---|---|---|
| the six cold Q1 2025 runs | PARTIAL 7/8, passes (usable with care) | VERIFIED 42/43, passes | VERIFIED 56/56, passes | identical to the saved 12 rows in every FEMA and revenue field |
| the warm Q1 2024 run | REJECTED 8/11, **withheld** | VERIFIED 42/43 (recalled), passes | VERIFIED 56/56 (recalled), passes | no table: the FEMA selection is withheld, where the saved run listed 16 utilities |

The weather statements are not replayed (a run keeps only the first 20 rows of each statement, and the weather statements return 28); the weather path runs unchanged when its key passes. The same replay runs in the unit tests on the committed redacted fixtures (`agent/test/answer-gate.test.ts`).

**The model against the deterministic baseline.** On the same probes, over the five cold runs with the model: the deterministic name-and-statistics baseline proposed 30 keys and 25 were VERIFIED; the model proposed 11 and 3 were VERIFIED (1 PARTIAL, 7 REJECTED, 0 unmeasurable). **The baseline wins.** Every key the model got VERIFIED (the FEMA FIPS key, `utility_states.state ~ states.code`, `hq_state ~ seed_stations.state`) was also measured from a baseline proposal (its scored six or its measure queue) in the same run, so the runs show no key the model found that the baseline missed. Counted as distinct keys over the five runs (`docs/eval/summary.json`, `l2.keys_found`), the baseline's scored proposals VERIFIED 6 distinct keys (cik, loc, station, sic and two generic pairs) and the model's 3, with no key in both: the model's three are the governed FEMA FIPS key and two generic state-code pairs, each outside the baseline's scored six but named on the same join-map row as a baseline proposal from its measure queue (ranks 7 to 24). The model is kept as a second proposer whose every proposal is measured in Lightning SQL before anything uses it; nothing it proposes is trusted unmeasured.

| Cold run (setting) | Model: made / VERIFIED / PARTIAL / REJECTED | Baseline: made / VERIFIED / PARTIAL / REJECTED |
|---|---|---|
| `r20261025T1546471209` (think on) | 2 / 0 / 0 / 2 | 6 / 5 / 0 / 1 |
| `r20261025T155141e122` (think on) | 3 / 1 / 0 / 2 | 6 / 5 / 0 / 1 |
| `r20261025T160020a0bc` (think on) | 3 / 1 / 0 / 2 | 6 / 5 / 0 / 1 |
| `r20261025T160836e4df` (think on) | 1 / 0 / 1 / 0 | 6 / 5 / 0 / 1 |
| `r20261025T161313168c` (think off) | 2 / 1 / 0 / 1 | 6 / 5 / 0 / 1 |
| **Total** | **11 / 3 / 1 / 7** | **30 / 25 / 0 / 5** |

**Against doing it by hand.** The five keys were also found and verified by hand through the same gateway, one statement at a time, each result read before choosing the next: 27 statements, 2 lookups, 24 decisions, 179.5 s from the first step to the last statement. The agent's cold run takes 247.7 to 285.8 s with the model (median 275.8 s, 60 statements), 194.1 s warm and 88.4 s with no model, and asks the user for none of the 24 decisions. **The 179.5 s is not a person's time:** the hand session ran statements prepared in advance as gateway templates, so it does not time writing or reading SQL, and no comparison of a person's speed with the agent's is made here. What the agent adds is everything after the keys: every key measured with its orphans, the governed USL and its DQ, the 12-row answer with a citation per number, a checked note, and memory that makes the next question skip the measured keys.

| | Statements | Decisions asked of the user | Wall | Also produces |
|---|---|---|---|---|
| By hand (pre-written statements) | 27 | 24 | 179.5 s | the five keys and their orphans |
| Agent, cold, think on (median) | 60 | 0 | 275.8 s | keys, answer with provenance, USL check, live DQ, checked note |
| Agent, warm (Q1 2024) | 46 | 0 | 194.1 s | the same for Q1 2024, verified keys recalled (saved before the answer gate, which now withholds its FEMA selection) |
| Agent, cold, no model | 56 | 0 | 88.4 s | the same answer and governed keys, template note |

**Outside checks.** OpenFEMA fetched over HTTPS outside Zetaris equals the cached views in both quarters (Q1 2025: 116 rows / 10 declarations / 8 states; Q1 2024: 72 / 14 / 11; per-state counts equal). Two utilities' FY2024 10-K service territories, read from SEC EDGAR: Evergy's (KS, MO) equals the seed; PPL's names Virginia as well, which the seed leaves out; no Virginia major-disaster declaration is dated in either quarter, so neither answer changes. SEC's own SIC code list against the company_dns list the SIC rule reads: 4900 (MGE Energy's code) is on SEC's list and not on company_dns's, one of 172 such codes ([`docs/eval/sic-check.json`](docs/eval/sic-check.json)).

## Limitations

- **States, not counties.** Declarations are joined to utilities by state; the counties a declaration names are not matched to service territories. Served states are curated from each utility's 10-K into `seeds/utilities.json` (43 utilities); the outside check found one state missing (PPL, Virginia).
- **Revenue is not disaster impact.** Fuel and purchased-power clauses move revenue; frames serve the latest filed value per quarter, so restated comparatives are not reconciled; a utility whose first available tag differs between the years is not compared (Sempra in Q1 2025). All of this is on the answer's Not-tested list.
- **Only major-disaster (DR) declarations** are read; emergency (EM) and fire-management (FM) declarations are left out.
- **A VERIFIED rate measures containment, not meaning.** Two lists of US state codes overlap, so `utility_states.state ~ seed_stations.state` (43 of 43) is VERIFIED although nobody would join on it; the join map shows such generic pairs beside the governed keys without saying so.
- **The gate reads coverage as well as form.** The FEMA state key's rate is the share of the quarter's declared states that some seed utility serves, so a quarter whose declarations fall outside the seed utilities' states is withheld even though the two-letter codes join (Q1 2024: 8 of 11). The gate covers the three keys the answer joins on, not the other pairs on the map.
- **Recalled keys are not re-measured.** A warm run uses a recalled key with the numbers of the run that measured it, on that run's views (the CIK key measured on the CY2025Q1 frames is used for CY2024Q1); the join map marks it as recalled with the key it was measured as, and the gate accepts it.
- **The model's proposals are weaker than the baseline's** on this data (above), and 2 to 8 checklist steps per run were taken by the host after invalid planner replies.
- **The live DQ covers two rules**; the other four and the MGE finding come from the onboarding file, dated on screen.
- **Warm-run weather** is Not-tested when the year-earlier GHCN views are not among the objects the agent knows (its manifest and its own run-time registrations). The 2022 and 2023 views registered by an operator call before the video was recorded are therefore invisible to it, and the recorded Q1 2023 answer lists weather as Not-tested, saying the views are not registered.
- **No least-privilege reader.** The gateway runs read templates on the admin login behind its reader allowlist; `/health` reports `admin_fallback`.
- **One question at a time**, one local GPU, 43 seed utilities and 56 stations, Q1 2024 and Q1 2025 cached (plus what warm runs registered: the CY2023Q1 and CY2022Q1 frames and FEMA Q1 2023). Tested on Windows 11 only.

## What did not go well

- **The model loses the key-proposal comparison** (3 of 11 VERIFIED against 25 of 30), and the no-model run reaches the identical answer and governed keys in 88.4 s against 247.7 to 285.8 s with the model. On this question the planner and the note add time, not keys.
- **Model choices nobody would try:** `utility_states.cik ~ states.fips` (0 of 43), `utility_states.state ~` the FEMA `fips_state_code` (0 of 43), the frames `cik ~ sic_codes.code` under lpad10 (0 of 1,937). Lightning SQL rejects each, which is the design, but each costs a planner step and a statement.
- **Planner replies:** 125 of 157 planner calls were valid over the six runs with the model; the host took 2 to 8 checklist steps itself per run.
- **The note:** the model's draft was replaced by the template in 3 of the 6 runs with the model. One earlier draft said revenue "held up" while EIX and POR fell and passed the verifier of that commit; the rule was fixed (`c090bc1`) and the later runs carry the fix.
- **The model unloaded and reloaded mid-run** (the card memory fell by about 3,150 MiB for about two seconds, 3 times with think on and 2 with think off). The agent's host-RAM guard is the likely cause, but its events are not saved in the run file, so the cause is not verified.
- **`cw.stations` is the slow object:** probing it costs about 27 s per cold run, and the two degree-day statements take about 18 s each.
- **"Source cached at: not reported by the gateway"** in every provenance drawer of the saved runs. The gateway reports, per source object, the time of the last `CACHE TABLE` statement in its SQL log since the Zetaris driver started, and returned none (0 of 60 statements in the cold run `r20261025T1546471209`, 0 of 46 in the warm run); each statement's own cache state, `hit` or `miss`, is reported. Finding why needs the running gateway, so the drawer still says "not reported".
- **An earlier version read `cw.seed_utilities` on the question path** (about 17 s per statement, 11 statements per run, cold runs of 403 to 452 s on Day 1). The question path now reads a snapshot taken at onboarding; 0 such reads in the Day-2 runs.

## Not measured

- A person's time to find, write and read the manual-baseline SQL (the 179.5 s session ran pre-written statements).
- More than one run per ablation setting; think off or no model on the warm question; a second quantisation of the model.
- Revenue against the companies' own 10-Q figures; the served states of the other 41 seed utilities against their 10-Ks.
- A run-time registration in the Day-2 runs (they all answered `already_registered`; the evidence is the Day-1 warm run and the warm run recorded for the video).
- The full onboarding DQ pass on Day 2 (the DQ file is from 25 Oct 13:46 SGT), and statement times under concurrent questions.
- A from-scratch install of the Zetaris objects on a new instance (Quickstart B is the order in which they were created on 25 Oct).
- A live question under the answer gate: the gate is unit-tested and replayed offline on the saved runs (above), but no run with the live stack has gone through it.

## Responsible use

- The model never computes a number and never writes SQL or DDL. Match rates, counts, DQ results and every answer value come from Lightning SQL through the gateway; the note's numbers and words are checked against the run.
- Every verdict word is defined where it is shown, the orphans are named, and the "no" results (REJECTED, PARTIAL, DQ invalid, not compared) are shown as plainly as the VERIFIED ones.
- The utilities in the answer are whoever the FEMA join selects; none is hand-picked.
- Source etiquette: SEC EDGAR with the declared User-Agent, queried live and never redistributed; the SQL runner (`gateway/run_sql.py`) spaces the statements that may call SEC EDGAR at least 0.1 s apart (the SEC's 10 requests per second), while Zetaris's own re-reads of its SEC REST tables are not paced by Crosswalk (on Day 0 one `RUN DQ` re-read the 43 submission endpoints in a burst and one call was refused, as `zetaris/README.md` records); OpenFEMA cited as the source and nothing presented as FEMA-endorsed; GHCN read anonymously from the public bucket; company_dns called with an identifying User-Agent.
- Secrets (`CW_USER_AGENT`, `CW_CONTRACT_SECRET`, the Zetaris login) live only in `.env.local`, which is gitignored; the SQL files carry a placeholder filled on the wire only.
- The planner's `thought` is shown as the model's plan, never as a fact; replayed runs are labelled REPLAY.

## Dependencies and licences

| Component | Version | Licence |
|---|---|---|
| Node.js | 22.12 or newer (tested 22.13.1) | MIT |
| tsx, vitest, vite, @types/node (dev only; the agent has no runtime dependencies) | 4.23.15, 5.0.3, 7.3.7, 22.20.5 | MIT |
| TypeScript (dev only) | 7.0.2 | Apache-2.0 |
| FastAPI, pytest (dev) | 0.161.1, 9.1.1 | MIT |
| uvicorn, httpx (dev) | 0.54.0, 0.28.1 | BSD-3-Clause |
| JayDeBeApi | 1.2.3 | LGPL-3.0 |
| JPype1 | 1.7.1 | Apache-2.0 |
| Meterless reference engines (vendored) | commit `1742dec` | Apache-2.0 |
| Ollama | 0.40.7 | MIT |
| NVIDIA Nemotron 3 Nano 4B (`nemotron-3-nano:4b`, not redistributed) | the Ollama build | NVIDIA Open Model License |
| Zetaris platform and JDBC driver (not redistributed) | 2.4.3.1 | Zetaris terms |
| Java runtime | 11 or newer (tested 21) | per distribution |
| Python | 3.12 | PSF |

## Data and licences

- **SEC EDGAR** (XBRL frames, submissions): a work of the US government. Queried live through Zetaris with a declared User-Agent under the SEC's fair-access policy (at most 10 requests per second), never redistributed. The repository commits no extracted SEC values: `docs/` cites revenue only as year-on-year percentage changes, and `seeds/utilities.json` holds public identifiers (CIK, name, ticker, SIC, headquarters state) with the curated states served and station ids. No real run is committed; the one run in `docs/demo-run/` carries synthetic revenue values, accession numbers and degree days.
- **OpenFEMA** (`DisasterDeclarationsSummaries`, `OpenFemaDataSets`): public US federal data, no key. FEMA is cited as the source; this project is not endorsed by FEMA.
- **NOAA GHCN-Daily**, from the Registry of Open Data on AWS (`noaa-ghcn-pds`): CC0-1.0, a work of the US government; cite NOAA National Centers for Environmental Information (Menne et al. 2012, GHCN-Daily Version 3, in [`NOTICE`](NOTICE)). `seeds/stations.json` holds station ids, names and states from `ghcnd-stations.txt`.
- **company_dns**: an Apache-2.0 service serving the SEC's SIC code list.
- **Zetaris getting-started repository** (Apache-2.0): its data manifest and `known_to_fail` notes are read at boot when `ZETARIS_GETTING_STARTED_DIR` is set, to seed the catalogue and H-MEM; nothing from it is redistributed.
- No personal data is read or stored.

## Pre-existing code

Crosswalk was written for this hackathon on 25 Oct 2026, on top of declared pre-existing code:

- **The Meterless reference engines** H-MEM, Markovian and World Model (Apache-2.0), vendored unchanged in `engines/`: 60 files, 13,189 lines (`git ls-files engines | xargs wc -l`), of which 59 files and 13,153 lines are the vendored engines and one, `engines/UPSTREAM.md` (36 lines), is the vendoring note.
- **`gateway/jdbc.py`**, adapted from `scripts/zetaris_sql.py` in the [Zetaris getting-started repository](https://github.com/zetaris/getting-started) (Apache-2.0): the `.env.local` loader, the statement splitter and the JayDeBeApi channel, with Windows JDK discovery, column names and timings, a bounded wait with statement cancel and a lock per connection added.
- **Scaffolding from the author's two earlier entries** (Apache-2.0, same author): [Weather-or-Not](https://github.com/GitHubMoreLikeGitGud/weather-or-not) (Track 2), whose repository was copied as the starting point, and [ClearShelf](https://github.com/GitHubMoreLikeGitGud/clearshelf) (Track 3), where that scaffolding began: the gateway pattern (templates, allowlist, registrar, contract check, cache, SQL runner), the agent server and SSE pattern, the Markovian generator and telemetry, the H-MEM facade and World Model wrapper patterns, the evidence store, the contract module and injection guard, the CLI and config, the UI shell and `ui/lib.js`, and the 43-utility and 56-station seeds. Measured at `078f890`:
  - 26 files carry the header "Adapted from Weather-or-Not and ClearShelf", 8,523 lines in all (7,698 non-blank), counting what was rewritten in them: `git grep -l "Adapted from Weather-or-Not and ClearShelf" -- . ':!README.md' ':!AGENTS.md' ':!.cursor' ':!metadata.json' | xargs wc -l`.
  - Of the 222 tracked files outside `engines/` (59,599 lines), 109 exist at the same path in Weather-or-Not (commit `0a7ea45`); they hold 28,744 lines, of which 21,626 are unchanged from Weather-or-Not and 25 files are unchanged entirely (counted per file with `git diff --no-index --numstat --ignore-cr-at-eol <weather-or-not file> <crosswalk file>`). The unchanged files include the seeds, the injection guard and its tests, `gateway/sqllog.py`, `agent/src/tools/frames.ts`, the evidence drawer view and test fixtures of the earlier question (degree days, attribution, a recast example, a food-label injection set) that remain in `agent/test/fixtures/`.
  - `zetaris/sql/won-reference/` holds Weather-or-Not's verified SQL as a reference only, never run here: 14 files, 2,532 lines.

Everything specific to Crosswalk is new: the Zetaris objects and the USL, the join-map and discovery templates, the six discovery tools and their checklist, the key memories and the World Model's key edges, the baseline and its scoring, the note verifier, the five analyst screens, the evaluation and this documentation.

## Licence

Apache-2.0, see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
