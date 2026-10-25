# The demo case, step by step

The question (binding for the entry): *"Which investor-owned electric utilities served states with FEMA major-disaster declarations in Q1 2025, what did the weather at their stations do that quarter, and did their revenue hold up year on year?"*

The user is an analyst with no data engineer on call: at a research desk, a state utility commission, a newsroom or a small fund. The question needs three agencies' data that nobody has joined before: FEMA declarations (by state code, FIPS code and county), SEC EDGAR revenue (by an unpadded integer CIK in the frames API and a ten-digit string in the submissions API) and NOAA weather (by station id). Which utilities appear is decided by the FEMA join over the 43 seed utilities' served states; none is hand-picked.

This page walks through one saved cold run and one warm run. The runs themselves are not committed (they hold SEC values, which are queried live and not redistributed); every number below is copied from them or from [`eval-report.md`](eval-report.md), which reads the same runs, and revenue appears only as a year-on-year change.

| Run | What | Code | Wall | Chunks |
|---|---|---|---|---|
| `r20261025T160020a0bc` | cold, Q1 2025 (the run on the README's answer image and the deck) | `fc130bd` | 247.7 s | 10 |
| `r20261025T155631f0a7` | warm, Q1 2024 | `ee04b0c` | 194.1 s | 8, 6 measure steps skipped |

Words used below: a key is **VERIFIED** when at least 95% of the counted table's rows find a match under its transform, **PARTIAL** at 80% to 95%, **REJECTED** below 80%; an **orphan** is a row whose key value finds no match; **DQ invalid** is a row that breaks a foreign-key rule of the semantic layer; a **cold** run measures every key, a **warm** run recalls keys an earlier run VERIFIED.

## 1. The cold run, step by step

28 tool calls in 10 Markovian chunks; the model chose 26 of them, the host took 2 itself after invalid planner replies (fallback steps); 0 cloud model calls.

| Chunk | Tool (chosen by) | What it did | Time |
|---|---|---|---|
| 1 | `search_catalogue` (model) | 8 hits over the curated catalogue (11 entries), the registered Zetaris objects (18), the live OpenFEMA dataset list (44) and the Zetaris getting-started manifest (23); 0 flagged `known_to_fail`; 9 views to probe | 0.3 s |
| 1-4 | `probe_source` x 9 (7 model, 2 fallback) | DESCRIBE, five rows and distinct counts of the candidate key columns for `cw.seed_submissions_snapshot` (keys `sic`, `cik10`, `hq_state`), `cw.frames_Revenues_CY2025Q1` (`cik`, `loc`), `cw.utility_states` (`cik`, `state`), `cw.states` (`code`, `fips`), `cw.fema_declarations_dr_2025q1` (`state`, `disaster_number`, `fips_state_code`), `cw.seed_stations`, `cw.stations` (28.1 s: the station inventory is the slow object), `cw.sic_codes` and `cw.fema_catalogue` | 0.3-28.1 s each |
| 2 | `register_source` (model) | `openfema_disaster_declarations` for CY2025Q1 under a signed contract: `already_registered` (116 rows) | 0.4 s |
| 4 | `propose_keys` (model) | the model chose 3 pairs from the menu of probed columns; the baseline's 6 are scored beside them | 0 s |
| 5-8 | `measure_key` x 12 | every proposal and the governed keys measured in Lightning SQL (table below) | 0.2-7.8 s each |
| 9 | `compile_usl` (model) | the model rendered from this run's VERIFIED keys equals the governed `crosswalk_usl`; the two live DQ rules ran | 5.6 s |
| 9 | `answer` (model) | 12 utilities; weather measured | 37.4 s |
| 9 | `not_tested` (model) | 4 items | 0 s |
| 10 | `finalize` (model) | the model's first draft was rejected (it said 11 utilities where the answer has 12, and ran to 329 words); the repaired draft was rejected for length (264 words); the 247-word template note was kept | 9.9 s |

## 2. The join map

Measured in this run, each by one Lightning SQL statement over two cached views (plus one for the orphans). Left is the table whose rows are counted.

| Key | Left -> right | Transform | Matched / rows | Distinct values | Verdict | Orphans | Proposed by |
|---|---|---|---|---|---|---|---|
| (a) cik | `cw.seed_submissions_snapshot.cik10` -> frames `cik`, three tags | lpad10 | 42 / 43 | 42 / 43 | VERIFIED | IDACORP (`0001057877`): no CY2025Q1 fact under any of the three tags | baseline |
| (a) control | the same, without padding | identity | 0 / 43 | 0 / 43 | **REJECTED** | all 43 | the host's control |
| (b) loc | frames `loc` -> `hq_state` | substr(4,2) | 42 / 42 | 42 / 42 | VERIFIED | none | baseline |
| (c) FEMA state | `cw.fema_declarations_dr_2025q1.state` -> `cw.utility_states.state` | identity | 7 / 8 | 7 / 8 | **PARTIAL** | AK: Alaska has a declaration and no seed utility serves it | baseline (queue) |
| (c) FEMA FIPS | `fips_state_code` -> `cw.states.fips` | identity | 8 / 8 | 8 / 8 | VERIFIED | none | baseline (queue) |
| (d) station | `cw.seed_stations.id` -> `cw.stations.id` | identity | 56 / 56 | 56 / 56 | VERIFIED | none | baseline |
| (e) SIC | `cw.seed_submissions_snapshot.sic` -> `cw.sic_codes.code` | identity | 42 / 43 | 3 / 4 | VERIFIED by rows | MGE Energy (`0001161728`, SIC 4900) | baseline |
| pair | `cw.seed_submissions_snapshot.cik10` -> `cw.utility_states.cik` | identity | 43 / 43 | 43 / 43 | VERIFIED | none | baseline |
| pair | `cw.utility_states.state` -> `cw.states.code` | identity | 43 / 43 | 43 / 43 | VERIFIED | none | model (and the baseline's queue) |
| pair | `cw.frames_Revenues_CY2025Q1.cik` -> `cw.utility_states.cik` | lpad10 | 34 / 1,937 | 34 / 1,937 | REJECTED | every SEC filer that is not a seed utility | baseline |
| pair | `cw.utility_states.cik` -> `cw.states.fips` | identity | 0 / 43 | 0 / 43 | REJECTED | all | model |
| pair | `cw.utility_states.state` -> FEMA `fips_state_code` | identity | 0 / 43 | 0 / 43 | REJECTED | all | model |

The first seven rows are the governed keys; their numbers are identical in every Day-2 cold run ([`eval-report.md`](eval-report.md), section 1). Two readings need a word:

- **SIC by rows, not by codes.** 43 utilities share 4 SIC codes; counting distinct codes gives 3 of 4 = 0.750, which would REJECT a key that holds for 42 of 43 utilities. The verdict is read from the rows (0.977), and the code reading is printed beside it.
- **The REJECTED frames-to-utility pair is not a failed CIK join.** It counts every SEC filer in the frames view (1,937), of which 34 are seed utilities; the same CIK join counted from the utility side is key (a), VERIFIED.

**Model against baseline in this run:** the model proposed 3 pairs, 1 VERIFIED (`utility_states.state ~ states.code`, which the baseline's queue also held) and 2 REJECTED; the baseline's scored six gave 5 VERIFIED and 1 REJECTED. Over the five cold runs with the model the baseline wins, 25 of 30 against 3 of 11 ([`eval-report.md`](eval-report.md), section 2).

## 3. The semantic layer and its data quality

`compile_usl` rendered the USL model from the keys this run verified and compared it with the governed `lightning.metastore.crosswalk.crosswalk_usl` (7 tables, 6 foreign keys): **matches the governed USL**. Each foreign key rests on evidence of this run or of onboarding:

| Foreign key | Rests on |
|---|---|
| `utility.sic -> sic_code` | key (e) measured VERIFIED in this run |
| `utility_state.cik -> utility` | onboarding DQ: 97 of 97 valid |
| `utility_state.state -> state` | **live DQ in this run**: 97 of 97 valid |
| `fema_declaration.state -> state` | **live DQ in this run**: 116 of 116 valid |
| `station.state -> state` | key (d) measured VERIFIED in this run |
| `revenue_quarter.cik -> utility` (lpad10) | key (a) measured VERIFIED in this run |

The onboarding pass (`npm run onboard`, 25 Oct 2026 13:46 SGT) ran all six rules with `RUN DQ`; one row is **DQ invalid**: `utility.sic` 43 total / 42 valid / 1 invalid, and `SHOW DQ INVALID RECORD` names MGE Energy (`0001161728`, MGEE, SIC 4900), whose code is not in the company_dns SIC list. It is the same company the SIC key lists as its orphan: the join map found it by measuring, the semantic layer by its rule. The gap is in the reference, not in MGE Energy's filing: 4900 is on SEC's own SIC code list, and 172 of that list's 444 codes are missing from company_dns (`scripts/sic_outside_check.py`, [`eval/sic-check.json`](eval/sic-check.json)).

## 4. The answer

For each utility with a served state that has a major-disaster (DR) declaration dated in Q1 2025 (the FEMA join over the 43 seed utilities' served states; Dominion Energy appears because the join selects it through South Carolina, like every other row):

| Utility | Declared states served (declarations, type) | Revenue change against Q1 2024 (tag) | Degree-day change at its stations (stations) |
|---|---|---|---|
| AEP | OK 1 severe storm, WV 1 severe storm | +8.70% (Revenues) | +16.86% (9) |
| DUK | KY 1 severe storm, SC 1 flood | +7.53% (RUOR) | +16.47% (9) |
| AEE | MO 1 severe storm | +15.47% (Revenues) | +17.20% (3) |
| D | SC 1 flood | +12.22% (Revenues) | +16.01% (3) |
| EIX | CA 1 fire | **-6.55%** (Revenues) | +2.96% (2) |
| EVRG | MO 1 severe storm | +3.27% (Revenues) | +22.89% (2) |
| FE | WV 1 severe storm | +14.54% (Revenues) | +16.19% (9) |
| OGE | OK 1 severe storm | +25.28% (Revenues) | +11.88% (1) |
| PCG | CA 1 fire | +2.08% (Revenues) | +2.96% (2) |
| POR | OR 1 fire | **-0.11%** (Revenues) | +1.13% (1) |
| PPL | KY 1 severe storm | +8.68% (Revenues) | +13.99% (4) |
| SRE | CA 1 fire | **not compared**: RFC now, Revenues a year earlier | +2.96% (2) |

RUOR is `RegulatedAndUnregulatedOperatingRevenue`, RFC `RevenueFromContractWithCustomerExcludingAssessedTax`. The revenue value is the first available of `Revenues`, RFC, RUOR for the CIK in the quarter, compared only when the same tag is first in both quarters. The degree-day change is the change in total heating plus cooling degree days (base 65 F) averaged over the utility's seed stations that report both years with coverage of at least 0.9, computed in Lightning SQL over the cached GHCN views.

In words: 12 utilities served 7 states with major-disaster declarations in Q1 2025; revenue rose for 9, fell for 2 and is not compared for 1; degree days rose at every utility's stations. Every number in the table opens a provenance drawer with the Lightning SQL that produced it, its rows, the time it took, the Zetaris object, its cache time, the source endpoint and the licence.

**Not tested** (on the answer screen and in the note): county geography (declarations are joined by state, not to service territories); non-major declarations (EM and FM are left out); fuel-cost pass-through (revenue is not a measure of disaster impact); recasts (frames serve the latest filed value; restated comparatives are not reconciled).

## 5. The warm run: the same question for Q1 2024

`r20261025T155631f0a7`, 194.1 s, 8 chunks.

- **Recalled, not re-measured.** Six measure steps were skipped because their keys were remembered as VERIFIED: cik, station, the snapshot-to-served-state CIK pair, SIC, loc and the FEMA FIPS key. Each recalled row names the key it was measured as (for example `cik@CY2025Q1`) and carries that run's numbers, labelled recalled.
- **Measured again, and a new no.** The FEMA state key is measured live for the new quarter: 8 of 11 = 0.727, **REJECTED**; Alaska, Maine and Vermont have Q1 2024 declarations and no seed utility serves them. The unpadded CIK control is REJECTED again (0 of 43).
- **Registration.** The run sent `register_source` for the FEMA CY2024Q1 view and the three CY2023Q1 frames views (the year-earlier revenue); all four answered `already_registered`. The Day-1 warm run `r20261025T1413091c1c` is the one that registered the three frames views at run time under signed contracts (2,206, 2,755 and 22 rows, about 1 s each).
- **The answer.** 16 utilities (PPL first, with 3 declarations in Rhode Island). Weather is **Not-tested** for this quarter: the GHCN views of 2023 are not registered, so the year-on-year weather change is not computed, and the answer says so instead of leaving the column empty.
- **The note.** The model's note was kept (250 words) after the word check.

## 6. Outside checks

Numbers the agent did not compute, fetched outside Zetaris and compared ([`eval-report.md`](eval-report.md), section 3; [`eval/outside-checks.json`](eval/outside-checks.json)):

- **OpenFEMA over HTTPS**, the registrar's own URL: Q1 2025 116 rows / 10 declarations / 8 states, Q1 2024 72 / 14 / 11, equal to the cached Zetaris views, state by state.
- **Two utilities' service territories from their FY2024 10-K** (SEC EDGAR): Evergy names Kansas and Missouri, equal to the seed. PPL names Kentucky, Pennsylvania, Rhode Island **and Virginia**; the seed leaves Virginia out. No Virginia major-disaster declaration is dated in Q1 2025 or Q1 2024, so neither answer changes, and the gap is published rather than patched.
- **By hand:** the five keys found and verified one statement at a time through the gateway gave the same verdicts, counts and orphans as the agent's join map (27 statements, 24 decisions; [`eval-report.md`](eval-report.md), section 4).

## 7. Reproduce it

With the full stack (README, Quickstart B), from `agent/`:

```powershell
cmd /c "npm run ask -- --quarter CY2025Q1 --cold"   # the cold run
cmd /c "npm run ask -- --quarter CY2024Q1"          # the warm run (recalls the keys the cold run verified)
npm run replay -- <run_id>                          # print a saved run without the model or the gateway
```

Six cold runs of the Q1 2025 question (think on, think off, no model) gave the identical 12-row answer and identical governed keys ([`eval-report.md`](eval-report.md), section 1).
