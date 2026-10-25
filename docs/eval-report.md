# Crosswalk evaluation (Day 2)

Every number below is measured and copied from a saved run file or a measured side file; nothing is projected or estimated unless it says so. Runs were made on code `6652e2f`, `ee04b0c`, `fc130bd` with `nemotron-3-nano:4b` through local Ollama (0 cloud model calls) and Zetaris Lightning 2.4.3.1 through the gateway. The summary JSON is `docs/eval/summary.json`; both files are regenerated from the saved runs with `cd agent && npx tsx src/eval/run.ts --runs <dir of the ablation runs> --gpu <dir of its samples>` (no gateway or model call). Revenue appears only as the year-on-year change the answer shows.

Code: the agent, gateway, prompts, seeds and Zetaris SQL are the same at fc130bd (the last four runs) and at the commit that carries this report; between them only the UI, the Cursor task records, this report and its tools (agent/src/eval) changed. The first three runs used earlier Day-2 commits (6652e2f, ee04b0c) whose later changes touched the note, the memory context and the evidence labels, not the answer or the join-map statements.

## Headline

- **Reproducible:** 6 cold runs of the demo question (think on, think off, no model) give the same 12-row answer in every field (yes) and the same numbers and orphans for the 7 governed join-map keys (yes).
- **Model vs baseline (L2):** over 5 cold runs with the model, the model made 11 key proposals and 3 were VERIFIED; the deterministic baseline made 30 and 25 were VERIFIED. Winner on VERIFIED keys: baseline. Every key the model found VERIFIED was also measured from a baseline proposal (its scored six or its measure queue) in the same run.
- **Outside checks (L4):** OpenFEMA over HTTPS equals the Zetaris cached views in 2 of 2 quarters (rows, declarations, states, per-state counts); 1 of 2 utilities' 10-K service states equal the seed (PPL: the filing also names VA).
- **Manual baseline (L6):** finding and verifying the five keys by hand took 27 statements and 24 decisions (33.7 s of statement time); the agent asks the user for none of them and runs the whole question in 275.8 s (cold, median) or 194.1 s (warm). A person's time to write and read that SQL is not measured.
- **Nemotron ablation (L12, one run each):** think on 275.2 s, think off 227.9 s, no model 88.4 s, all with the same answer; 132.9 / 133.1 tok/s; the model holds 2,881 MiB of VRAM (Ollama, Q4_K_M, context 8192).
- **Statements:** 0 of 399 question-path statements took over 20 s (slowest: weather_quarter at 18,135 ms).

## Runs

| Run | Label | Code | Setting | Mode | Wall | Chunks | Skipped | Planner calls (valid / first try) | Fallback steps | Statements (slowest) | > 20 s | Answer rows | Join-map rows |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `r20261025T1546471209` | cold 1 | `6652e2f` | think on | cold CY2025Q1 | 285.8 s | 9 | 0 | 27 (22 / 18) | 5 | 60 (weather_quarter 18,135 ms) | 0 | 12 | 11 |
| `r20261025T155141e122` | cold 2 | `6652e2f` | think on | cold CY2025Q1 | 276.4 s | 9 | 0 | 27 (19 / 18) | 8 | 60 (weather_quarter 17,938 ms) | 0 | 12 | 11 |
| `r20261025T155631f0a7` | warm (CY2024Q1) | `ee04b0c` | think on | warm CY2024Q1 | 194.1 s | 8 | 6 | 22 (17 / 17) | 5 | 46 (distinct_counts 7,481 ms) | 0 | 16 | 9 |
| `r20261025T160020a0bc` | cold 3 | `fc130bd` | think on | cold CY2025Q1 | 247.7 s | 10 | 0 | 28 (26 / 25) | 2 | 61 (weather_quarter 18,090 ms) | 0 | 12 | 12 |
| `r20261025T160836e4df` | ablation: think on | `fc130bd` | think on | cold CY2025Q1 | 275.2 s | 9 | 0 | 25 (21 / 19) | 4 | 56 (weather_quarter 18,073 ms) | 0 | 12 | 9 |
| `r20261025T161313168c` | ablation: think off | `fc130bd` | think off | cold CY2025Q1 | 227.9 s | 10 | 0 | 28 (20 / 19) | 8 | 60 (weather_quarter 18,090 ms) | 0 | 12 | 12 |
| `r20261025T1617024020` | ablation: no model | `fc130bd` | no model | cold CY2025Q1 | 88.4 s | 9 | 0 | 0 (0 / 0) | 25 | 56 (weather_quarter 18,135 ms) | 0 | 12 | 9 |

A fallback step is a checklist step the host took itself after the planner's reply was invalid twice or chose nothing; in the no-model run every step is a fallback step.

## 1. Reproducibility of the cold question

6 cold runs of the CY2025Q1 demo question, compared pairwise. The answer comparison covers every field of every row (utility, states, declarations by incident type, revenue tag, both values and the change, the stations, both degree-day totals and the change); the join-map comparison covers verdict, matched and total rows, matched and total distinct keys, and orphans for every key both runs measured. **All answers identical: yes. Governed join-map keys identical in every pair: yes.**

| Run A | Run B | Answer rows | Answer identical | Join-map rows | Common keys | Identical on common | Governed keys compared (identical) | Only in A [proposed by] | Only in B [proposed by] |
|---|---|---|---|---|---|---|---|---|---|
| `r20261025T1546471209` | `r20261025T155141e122` | 12 / 12 | yes | 11 / 11 | 9 | yes | 7 (yes) | cw.frames_revenues_cy2025q1.cik ~ cw.sic_codes.code (lpad10) [model], cw.seed_submissions_snapshot.hq_state ~ cw.fema_declarations_dr_2025q1.state (identity) [model] | cw.utility_states.cik ~ cw.frames_revenues_cy2025q1.cik (lpad10) [model], cw.utility_states.state ~ cw.seed_submissions_snapshot.hq_state (identity) [model] |
| `r20261025T1546471209` | `r20261025T160020a0bc` | 12 / 12 | yes | 11 / 12 | 9 | yes | 7 (yes) | cw.frames_revenues_cy2025q1.cik ~ cw.sic_codes.code (lpad10) [model], cw.seed_submissions_snapshot.hq_state ~ cw.fema_declarations_dr_2025q1.state (identity) [model] | cw.utility_states.cik ~ cw.states.fips (identity) [model], cw.utility_states.state ~ cw.fema_declarations_dr_2025q1.fips_state_code (identity) [model], cw.utility_states.state ~ cw.states.code (identity) [model+baseline] |
| `r20261025T1546471209` | `r20261025T160836e4df` | 12 / 12 | yes | 11 / 9 | 9 | yes | 7 (yes) | cw.frames_revenues_cy2025q1.cik ~ cw.sic_codes.code (lpad10) [model], cw.seed_submissions_snapshot.hq_state ~ cw.fema_declarations_dr_2025q1.state (identity) [model] | none |
| `r20261025T1546471209` | `r20261025T161313168c` | 12 / 12 | yes | 11 / 12 | 9 | yes | 7 (yes) | cw.frames_revenues_cy2025q1.cik ~ cw.sic_codes.code (lpad10) [model], cw.seed_submissions_snapshot.hq_state ~ cw.fema_declarations_dr_2025q1.state (identity) [model] | cw.seed_submissions_snapshot.hq_state ~ cw.seed_stations.state (identity) [model+baseline], cw.utility_states.state ~ cw.seed_stations.state (identity) [baseline], cw.utility_states.state ~ cw.states.fips (identity) [model] |
| `r20261025T1546471209` | `r20261025T1617024020` | 12 / 12 | yes | 11 / 9 | 9 | yes | 7 (yes) | cw.frames_revenues_cy2025q1.cik ~ cw.sic_codes.code (lpad10) [model], cw.seed_submissions_snapshot.hq_state ~ cw.fema_declarations_dr_2025q1.state (identity) [model] | none |
| `r20261025T155141e122` | `r20261025T160020a0bc` | 12 / 12 | yes | 11 / 12 | 9 | yes | 7 (yes) | cw.utility_states.cik ~ cw.frames_revenues_cy2025q1.cik (lpad10) [model], cw.utility_states.state ~ cw.seed_submissions_snapshot.hq_state (identity) [model] | cw.utility_states.cik ~ cw.states.fips (identity) [model], cw.utility_states.state ~ cw.fema_declarations_dr_2025q1.fips_state_code (identity) [model], cw.utility_states.state ~ cw.states.code (identity) [model+baseline] |
| `r20261025T155141e122` | `r20261025T160836e4df` | 12 / 12 | yes | 11 / 9 | 9 | yes | 7 (yes) | cw.utility_states.cik ~ cw.frames_revenues_cy2025q1.cik (lpad10) [model], cw.utility_states.state ~ cw.seed_submissions_snapshot.hq_state (identity) [model] | none |
| `r20261025T155141e122` | `r20261025T161313168c` | 12 / 12 | yes | 11 / 12 | 9 | yes | 7 (yes) | cw.utility_states.cik ~ cw.frames_revenues_cy2025q1.cik (lpad10) [model], cw.utility_states.state ~ cw.seed_submissions_snapshot.hq_state (identity) [model] | cw.seed_submissions_snapshot.hq_state ~ cw.seed_stations.state (identity) [model+baseline], cw.utility_states.state ~ cw.seed_stations.state (identity) [baseline], cw.utility_states.state ~ cw.states.fips (identity) [model] |
| `r20261025T155141e122` | `r20261025T1617024020` | 12 / 12 | yes | 11 / 9 | 9 | yes | 7 (yes) | cw.utility_states.cik ~ cw.frames_revenues_cy2025q1.cik (lpad10) [model], cw.utility_states.state ~ cw.seed_submissions_snapshot.hq_state (identity) [model] | none |
| `r20261025T160020a0bc` | `r20261025T160836e4df` | 12 / 12 | yes | 12 / 9 | 9 | yes | 7 (yes) | cw.utility_states.cik ~ cw.states.fips (identity) [model], cw.utility_states.state ~ cw.fema_declarations_dr_2025q1.fips_state_code (identity) [model], cw.utility_states.state ~ cw.states.code (identity) [model+baseline] | none |
| `r20261025T160020a0bc` | `r20261025T161313168c` | 12 / 12 | yes | 12 / 12 | 9 | yes | 7 (yes) | cw.utility_states.cik ~ cw.states.fips (identity) [model], cw.utility_states.state ~ cw.fema_declarations_dr_2025q1.fips_state_code (identity) [model], cw.utility_states.state ~ cw.states.code (identity) [model+baseline] | cw.seed_submissions_snapshot.hq_state ~ cw.seed_stations.state (identity) [model+baseline], cw.utility_states.state ~ cw.seed_stations.state (identity) [baseline], cw.utility_states.state ~ cw.states.fips (identity) [model] |
| `r20261025T160020a0bc` | `r20261025T1617024020` | 12 / 12 | yes | 12 / 9 | 9 | yes | 7 (yes) | cw.utility_states.cik ~ cw.states.fips (identity) [model], cw.utility_states.state ~ cw.fema_declarations_dr_2025q1.fips_state_code (identity) [model], cw.utility_states.state ~ cw.states.code (identity) [model+baseline] | none |
| `r20261025T160836e4df` | `r20261025T161313168c` | 12 / 12 | yes | 9 / 12 | 9 | yes | 7 (yes) | none | cw.seed_submissions_snapshot.hq_state ~ cw.seed_stations.state (identity) [model+baseline], cw.utility_states.state ~ cw.seed_stations.state (identity) [baseline], cw.utility_states.state ~ cw.states.fips (identity) [model] |
| `r20261025T160836e4df` | `r20261025T1617024020` | 12 / 12 | yes | 9 / 9 | 9 | yes | 7 (yes) | none | none |
| `r20261025T161313168c` | `r20261025T1617024020` | 12 / 12 | yes | 12 / 9 | 9 | yes | 7 (yes) | cw.seed_submissions_snapshot.hq_state ~ cw.seed_stations.state (identity) [model+baseline], cw.utility_states.state ~ cw.seed_stations.state (identity) [baseline], cw.utility_states.state ~ cw.states.fips (identity) [model] | none |

Every key measured in two runs carries the same numbers and orphans in both. Keys measured in one run only are the model's own menu choices, or baseline pairs that depend on which views the planner probed first (the baseline scores pairs over the probed columns, so a different probe order gives it different candidates).

Against the Day-1 reference runs (code before the Day-2 fixes, same quarter): 7 of 7 Day-2 answers identical (`r20261025T1546471209` vs `r20261025T14571773a0` identical; `r20261025T155141e122` vs `r20261025T14571773a0` identical; `r20261025T155631f0a7` vs `r20261025T145128a180` identical; `r20261025T160020a0bc` vs `r20261025T14571773a0` identical; `r20261025T160836e4df` vs `r20261025T14571773a0` identical; `r20261025T161313168c` vs `r20261025T14571773a0` identical; `r20261025T1617024020` vs `r20261025T14571773a0` identical).

The answer (run `r20261025T1546471209`, CY2025Q1 against CY2024Q1; weather measured):

| Utility | Declared states served (declarations) | Revenue change (tag) | Weather: degree-day change (stations) |
|---|---|---|---|
| AEP | OK 1, WV 1 | +8.70% (Revenues) | +16.86% (9) |
| DUK | KY 1, SC 1 | +7.53% (RUOR) | +16.47% (9) |
| AEE | MO 1 | +15.47% (Revenues) | +17.20% (3) |
| D | SC 1 | +12.22% (Revenues) | +16.01% (3) |
| EIX | CA 1 | -6.55% (Revenues) | +2.96% (2) |
| EVRG | MO 1 | +3.27% (Revenues) | +22.89% (2) |
| FE | WV 1 | +14.54% (Revenues) | +16.19% (9) |
| OGE | OK 1 | +25.28% (Revenues) | +11.88% (1) |
| PCG | CA 1 | +2.08% (Revenues) | +2.96% (2) |
| POR | OR 1 | -0.11% (Revenues) | +1.13% (1) |
| PPL | KY 1 | +8.68% (Revenues) | +13.99% (4) |
| SRE | CA 1 | not compared (RFC now, a different tag a year earlier) | +2.96% (2) |

## 2. The model's key proposals against the deterministic baseline (L2)

Both sides propose join keys from the same probes in the same run, and every valid proposal is measured by the same Lightning SQL statement (a named join-map statement for the governed keys, the generic `match_rate` statement otherwise). The model chooses from an enumerated menu of the probed columns and the closed transform set; the baseline is the deterministic column-name heuristic (its top six are scored). Columns: made / valid / VERIFIED / PARTIAL / REJECTED / unmeasurable. In the warm run the baseline's VERIFIED keys are recalled from memory (measured in an earlier run), not re-measured.

| Run | Setting | Mode | Model | Model VERIFIED keys | Baseline | Baseline VERIFIED keys |
|---|---|---|---|---|---|---|
| `r20261025T1546471209` | think on | cold | 2 / 2 / 0 / 0 / 2 / 0 | none | 6 / 6 / 5 / 0 / 1 / 0 | cik, loc, cw.seed_submissions_snapshot.cik10 ~ cw.utility_states.cik (identity), sic, station |
| `r20261025T155141e122` | think on | cold | 3 / 3 / 1 / 0 / 2 / 0 | fema_fips | 6 / 6 / 5 / 0 / 1 / 0 | cik, loc, cw.seed_submissions_snapshot.cik10 ~ cw.utility_states.cik (identity), sic, station |
| `r20261025T155631f0a7` | think on | warm | 1 / 1 / 0 / 0 / 1 / 0 | none | 6 / 6 / 5 / 0 / 1 / 0 | cik, loc, cw.seed_submissions_snapshot.cik10 ~ cw.utility_states.cik (identity), sic, station (5 recalled) |
| `r20261025T160020a0bc` | think on | cold | 3 / 3 / 1 / 0 / 2 / 0 | cw.utility_states.state ~ cw.states.code (identity) | 6 / 6 / 5 / 0 / 1 / 0 | cik, loc, cw.seed_submissions_snapshot.cik10 ~ cw.utility_states.cik (identity), sic, station |
| `r20261025T160836e4df` | think on | cold | 1 / 1 / 0 / 1 / 0 / 0 | none | 6 / 6 / 5 / 0 / 1 / 0 | cik, loc, cw.seed_submissions_snapshot.cik10 ~ cw.utility_states.cik (identity), sic, station |
| `r20261025T161313168c` | think off | cold | 2 / 2 / 1 / 0 / 1 / 0 | cw.seed_submissions_snapshot.hq_state ~ cw.seed_stations.state (identity) | 6 / 6 / 5 / 0 / 1 / 0 | cik, cw.seed_submissions_snapshot.cik10 ~ cw.utility_states.cik (identity), cw.utility_states.state ~ cw.seed_stations.state (identity), sic, station |
| `r20261025T1617024020` | no model | cold | n/a (no model) | n/a | 6 / 6 / 5 / 0 / 1 / 0 | cik, loc, cw.seed_submissions_snapshot.cik10 ~ cw.utility_states.cik (identity), sic, station |

Cold runs with the model (5): model made 11, valid 11, VERIFIED 3, PARTIAL 1, REJECTED 7, unmeasurable 0, invalid schema 0; baseline made 30, valid 30, VERIFIED 25, PARTIAL 0, REJECTED 5, unmeasurable 0. With the warm run (6 runs): model VERIFIED 3 of 12, baseline 30 of 36. **Winner on VERIFIED keys: baseline.**

Distinct keys each side found VERIFIED by measuring them (runs with the model): model fema_fips, cw.seed_submissions_snapshot.hq_state ~ cw.seed_stations.state (identity), cw.utility_states.state ~ cw.states.code (identity); baseline cik, loc, cw.seed_submissions_snapshot.cik10 ~ cw.utility_states.cik (identity), cw.utility_states.state ~ cw.seed_stations.state (identity), sic, station. Model keys outside the baseline's scored six: fema_fips, cw.seed_submissions_snapshot.hq_state ~ cw.seed_stations.state (identity), cw.utility_states.state ~ cw.states.code (identity); of these, VERIFIED by no baseline proposal at all (scored six or measure queue) in any run: none.

## 3. Outside checks (L4)

Numbers the agent did not compute, fetched over HTTPS outside Zetaris (`agent/src/eval/outside.ts`) and compared with the cached views read through the gateway (`docs/eval/outside-checks.json`). The OpenFEMA URL is the registrar's own (major-disaster filter, declaration date inside the quarter).

| Quarter | OpenFEMA API: rows / declarations / states | Zetaris cached view: rows / declarations / states | Per-state declarations equal | Equal |
|---|---|---|---|---|
| CY2025Q1 | 116 / 10 / 8 | 116 / 10 / 8 | yes | yes |
| CY2024Q1 | 72 / 14 / 11 | 72 / 14 / 11 | yes | yes |

Served states: the seed notes cite each utility's FY2024 Form 10-K (Item 1, service territory). For two utilities in the answer, the filing was fetched from SEC EDGAR with the declared User-Agent and every sentence naming a service territory or customers together with a state was read; the states those sentences name are compared with the seed.

| Utility | Filing | States in the seed | States the filing names in service sentences | In the filing only | Equal | Changes an answer |
|---|---|---|---|---|---|---|
| EVRG (Evergy, Inc.) | 10-K for 2024-12-31, filed 2025-02-27 | KS, MO | KS, MO | none | yes | no |
| PPL (PPL Corp) | 10-K for 2024-12-31, filed 2025-02-13 | KY, PA, RI | KY, PA, RI, VA | VA | no | no: VA has no major-disaster declaration in CY2025Q1 or CY2024Q1 |

## 4. Manual baseline: the five keys by hand (L6)

The statements a data person needs to find and verify the five keys (a cik, b loc, c FEMA state, d station, e SIC) on the same cached views were run one at a time through the gateway (127.0.0.1:8803) after the ablation runs finished, each result read before the next statement was chosen. Measured: the statements, their gateway elapsed_ms, and the decisions taken. The session time (first step to the end of the last statement) is reported for completeness but is NOT a measure of how long a person would take: the SQL was not typed from scratch (each statement is a gateway reader template: DESCRIBE, SELECT ... LIMIT 5, distinct counts, the match-rate count and its orphans, or a named join-map statement where the counted side needs a transform the generic statement does not apply), so the time to write that SQL and to read results at human speed is not measured. Steps 8, 9, 11, 23, 28 and 29 use the named join-map statements because the comparison needs LPAD or SUBSTR on the right-hand side, a three-view union or a per-utility row count.

**Measured:** 27 statements (14 probe, 7 measure (generic match_rate), 6 measure (named join-map statement); 0 refused or failed), 2 lookups without a statement, 33.7 s of statement time, 24 decisions, 179.5 s from the first step to the end of the last statement.

|  | Statements | Statement time | Decisions asked of the user | Wall | Also produces |
|---|---|---|---|---|---|
| By hand (this session) | 27 | 33.7 s | 24 | 179.5 s (not a person's time: SQL pre-written, reading time not human) | the five keys and their orphans |
| Agent, cold (think on, median) | 60 | 86.1 s | 0 (one command) | 275.8 s | keys, answer table with provenance, USL check, live DQ, checked note |
| Agent, warm | 46 | 39.3 s | 0 (one command) | 194.1 s | the same for Q1 2024, with the verified keys recalled from memory |
| Agent, cold, no model | 56 | 85.7 s | 0 (one command) | 88.4 s | the same answer and governed keys, template note |

| Key | Verdict | Matched / total | Orphans |
|---|---|---|---|
| a: frames cik (LPAD 10) to submissions cik10 | VERIFIED | 42 / 43 | IDACORP 0001057877 |
| b: frames loc (SUBSTR 4,2) to submissions business state | VERIFIED | 42 / 42 | none |
| c: FEMA state to served state (utility_states) | PARTIAL | 7 / 8 | AK |
| c (reference): FEMA FIPS state code to the state reference | VERIFIED | 8 / 8 | none |
| d: seed station id to the GHCN inventory id | VERIFIED | 56 / 56 | none |
| e: submissions SIC to the SIC reference (utility rows; 3 of 4 codes) | VERIFIED | 42 / 43 | MGE ENERGY 0001161728 (4900) |

Each verdict, count and orphan found by hand equals the agent's join-map row for the same key in every cold run of section 1.

| # | Statement | Parameters | ms | Rows | What it showed | Decision |
|---|---|---|---|---|---|---|
| 1 | lookup | what=zetaris/manifest.json: the registered views and their sources | 0 | 0 | 10 sources; candidate views: cw.seed_submissions_snapshot (43 utilities), cw.frames_<tag>_<period> (SEC revenue), cw.fema_declarations_dr_2025q1, cw.utility_states, cw.states, cw.seed_stations, cw.stations, cw.sic_codes | start with the utility list (snapshot) and one revenue view |
| 2 | describe_object | object=cw.seed_submissions_snapshot | 84 | 6 | cik10, name, ticker, sic, hq_state, snapshot_at (all strings) | candidate keys: cik10 (to revenue), sic (to the SIC reference), hq_state (to the frames loc) |
| 3 | sample_rows | object=cw.seed_submissions_snapshot | 70 | 5 | cik10 is a 10-character zero-padded string; hq_state two letters; sic four digits | - |
| 4 | distinct_counts | object=cw.seed_submissions_snapshot column=cik10 | 114 | 1 | 43 rows, 43 distinct cik10, no nulls | cik10 is the utility's primary key |
| 5 | describe_object | object=cw.frames_revenues_cy2025q1 | 102 | 7 | cik is a bigint; loc a string | - |
| 6 | sample_rows | object=cw.frames_revenues_cy2025q1 | 145 | 5 | cik is an unpadded integer (2098); loc is 'US-CT' style; the view holds every SEC filer, not just utilities | first try: join the snapshot's cik10 to the frames cik as they are |
| 7 | match_rate | left_object=cw.seed_submissions_snapshot left_column=cik10 right_object=cw.frames_revenues_cy2025q1 right_column=cik transform=identity | 359 | 1 | 0 of 43 utilities match: the frames cik is not zero-padded | pad the frames cik to 10 digits (LPAD) and count the utilities found under any of the three revenue tags (one statement over the three frames views) |
| 8 | joinmap_cik | period=CY2025Q1 | 744 | 1 | 42 of 43 utilities found once the frames cik is padded | key a (cik, LPAD to 10) VERIFIED at 0.977; look at the one orphan |
| 9 | joinmap_cik_orphans | period=CY2025Q1 | 568 | 1 | IDACORP has no CY2025Q1 fact under any of the three tags | keep the orphan as a named gap, not a key failure |
| 10 | lookup | what=frames loc format: 'US-' plus the two-letter state (seen in the sample rows); the snapshot holds the business-address state hq_state | 0 | 0 |  | strip 'US-' (SUBSTR from 4, length 2) and compare with hq_state for the matched utilities |
| 11 | joinmap_loc | period=CY2025Q1 | 681 | 1 | 42 of 42 frames utilities report the same state as their business address | key b (loc SUBSTR(4,2) to hq_state) VERIFIED at 1.000 |
| 12 | describe_object | object=cw.fema_declarations_dr_2025q1 | 142 | 9 | state (two letters), fips_state_code (string), disaster_number | join on state; FIPS as a cross-check against the state reference |
| 13 | sample_rows | object=cw.fema_declarations_dr_2025q1 | 183 | 5 | one row per designated county; state two letters; fips_state_code two digits | count distinct states (not rows) when matching |
| 14 | describe_object | object=cw.utility_states | 50 | 2 | cik (string), state: one row per utility and served state | match the declared states against the served states |
| 15 | match_rate | left_object=cw.fema_declarations_dr_2025q1 left_column=state right_object=cw.utility_states right_column=state transform=identity | 326 | 1 | 7 of 8 declared states are served by a seed utility | key c is PARTIAL (0.875); list the orphan |
| 16 | match_rate_orphans | left_object=cw.fema_declarations_dr_2025q1 left_column=state right_object=cw.utility_states right_column=state transform=identity | 246 | 1 | AK is the orphan: no seed utility serves Alaska | keep AK as the named orphan of a PARTIAL key |
| 17 | match_rate | left_object=cw.fema_declarations_dr_2025q1 left_column=fips_state_code right_object=cw.states right_column=fips transform=identity | 234 | 1 | 8 of 8 declared FIPS state codes are in the state reference | the state reference (FIPS) is the governed parent of a declaration; VERIFIED 1.000 |
| 18 | describe_object | object=cw.states | 74 | 3 | code, name, fips (the reference used in step 17; described after the fact) | - |
| 19 | describe_object | object=cw.seed_stations | 82 | 3 | id, state, name: the 56 stations of the seed utilities | - |
| 20 | describe_object | object=cw.stations | 5,167 | 5 | id, state, name, latitude, longitude: the GHCN station inventory | join on the 11-character station id |
| 21 | sample_rows | object=cw.stations | 7,403 | 5 | ids are 11 characters; non-US stations have a blank state | match the seed ids against the inventory ids as they are (identity) |
| 22 | match_rate | left_object=cw.seed_stations left_column=id right_object=cw.stations right_column=id transform=identity | 7,855 | 1 | 56 of 56 seed station ids are in the inventory | key d (station id) VERIFIED at 1.000; check the seed's state against the inventory's state too |
| 23 | joinmap_station |  | 7,704 | 1 | 56 of 56 match, and the state agrees for all 56 | - |
| 24 | describe_object | object=cw.sic_codes | 101 | 6 | code (string), description, division, major group | join the snapshot's sic to code |
| 25 | sample_rows | object=cw.sic_codes | 141 | 5 | codes are four-character zero-padded strings, like the snapshot's sic | identity, no transform |
| 26 | match_rate | left_object=cw.seed_submissions_snapshot left_column=sic right_object=cw.sic_codes right_column=code transform=identity | 255 | 1 | 3 of 4 distinct SIC codes found (0.750 by codes) | a code count misreads an attribute key: count utilities (rows) instead |
| 27 | match_rate_orphans | left_object=cw.seed_submissions_snapshot left_column=sic right_object=cw.sic_codes right_column=code transform=identity | 260 | 1 | 4900 is the code the reference lacks | find which utilities carry 4900 and count matched utilities |
| 28 | joinmap_sic |  | 326 | 1 | 42 of 43 utilities carry a SIC code the reference holds (3 of 4 distinct codes) | key e (SIC) VERIFIED at 0.977 by utility rows, the code reading beside it |
| 29 | joinmap_sic_orphans |  | 264 | 1 | MGE Energy (0001161728) carries 4900, absent from the reference | keep MGE as the named orphan |

## 5. Nemotron ablation on the cold question (L12)

The same cold CY2025Q1 question three times on the same code, one after another, with the GPU sampled every 500 ms by `nvidia-smi` (whole-card memory and utilisation) and Ollama's `/api/ps` read before, 60 s into and after each run. Think on and think off apply to the planner (the note is always written with think off). No model: the host takes every checklist step (the baseline's six proposals stand in for the model's) and the note is the template. Tokens and tok/s are Ollama's counts (`eval_count`, `eval_duration`).

| Setting | Run | Wall | Chunks | Planner calls (valid / first try / repaired) | Fallback steps | Output tokens | Median planner tok/s | Note tok/s | Model proposals m/v/V/P/R/u | Note (verifier) | Answer = think on | Card VRAM first / peak (MiB) | Model unloaded mid-run (card drop) | GPU util median / peak |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| think on | `r20261025T160836e4df` | 275.2 s | 9 | 25 (21 / 19 / 2) | 4 | 22,047 | 132.9 | 137.7 | 1 / 1 / 0 / 1 / 0 / 0 | model 220 words; drafts rejected for words 1, final issues 0 | (reference) | 6,936 / 6,959 | 3 times (3,158 MiB) | 81% / 99% |
| think off | `r20261025T161313168c` | 227.9 s | 10 | 28 (20 / 19 / 1) | 8 | 15,813 | 133.1 | 137.1 | 2 / 2 / 1 / 0 / 1 / 0 | template 245 words; drafts rejected for words 2, final issues 0 | yes | 6,932 / 7,873 | 2 times (3,155 MiB) | 73% / 99% |
| no model | `r20261025T1617024020` | 88.4 s | 9 | 0 (0 / 0 / 0) | 25 | 0 | n/a | n/a | n/a (no model) | template 247 words; drafts rejected for words 0, final issues 0 | yes | 7,341 / 7,482 | no | 16% / 19% |

The model: Ollama reports `nemotron-3-nano:4b` (4.0B, Q4_K_M) with 2,881 MiB in VRAM at context 8192. In the runs with the model the card memory fell by about 3,158 MiB for about two seconds and came back (3 times with think on, 2 times with think off): the model was unloaded and loaded again mid-run. The agent's host-RAM guard (it unloads the model when free host RAM falls below 2,048 MiB) is the only unload path in the agent and its events are not saved in the run file, so that cause is likely but not verified. The drop is the card memory the loaded model holds, measured on the card; the card's first and peak figures move with other programs (desktop, browsers) and are not the model's. GPU utilisation separates the settings: the no-model run leaves the card at the desktop's idle level.

One run per setting. The 4 cold think-on runs in this report took 247.7-285.8 s, a spread of 38.1 s within one setting; the 47.3 s gap between the think-on and think-off runs is of the same size as that spread, and with one think-off run it is not claimed as an effect of thinking. What the runs do show: output tokens (22,047 think on, 15,813 think off), fallback steps (4 and 8), and the no-model run, which reaches the same answer and governed keys in 32% of the think-on wall time.

## 6. Timings per tool and per statement class

Over the 7 runs above. Statements over 20 s: 0. Planner calls: 157, median 4.5 s, p90 10.3 s, max 26.3 s. A tool's time includes its statements; `finalize` includes the note (model drafts and the verifier).

| Tool | Calls | Median | p90 | Max | Total |
|---|---|---|---|---|---|
| probe_source | 63 | 0.6 s | 27.2 s | 28.1 s | 226.7 s |
| answer | 7 | 37.4 s | 37.8 s | 37.8 s | 226.6 s |
| measure_key | 67 | 0.7 s | 1.5 s | 7.8 s | 86.1 s |
| finalize | 7 | 6.3 s | 10.1 s | 10.1 s | 44.5 s |
| compile_usl | 7 | 4.4 s | 5.6 s | 5.6 s | 31.7 s |
| register_source | 10 | 0.4 s | 0.5 s | 0.5 s | 4.2 s |
| search_catalogue | 7 | 0.2 s | 0.3 s | 0.3 s | 1.6 s |
| propose_keys | 7 | 0.0 s | 0.0 s | 0.0 s | 0.0 s |
| not_tested | 7 | 0.0 s | 0.0 s | 0.0 s | 0.0 s |

| Statement class | Statements | Median ms | p90 ms | Max ms | Total |
|---|---|---|---|---|---|
| probe | 245 | 106 | 4,995 | 7,735 | 217.5 s |
| answer (weather) | 12 | 18,042 | 18,135 | 18,135 | 215.9 s |
| measure (named join-map statement) | 63 | 356 | 804 | 7,783 | 72.2 s |
| live DQ | 14 | 1,752 | 4,619 | 4,804 | 31.2 s |
| answer | 21 | 469 | 509 | 523 | 9.5 s |
| measure (generic match_rate) | 37 | 245 | 325 | 457 | 9.3 s |
| catalogue | 7 | 180 | 214 | 214 | 1.3 s |

| Template | Class | Statements | Median ms | p90 ms | Max ms |
|---|---|---|---|---|---|
| weather_quarter | answer (weather) | 12 | 18,042 | 18,135 | 18,135 |
| distinct_counts | probe | 119 | 130 | 7,436 | 7,735 |
| sample_rows | probe | 63 | 139 | 7,283 | 7,607 |
| joinmap_station | measure (named join-map statement) | 6 | 7,702 | 7,783 | 7,783 |
| describe_object | probe | 63 | 98 | 4,913 | 5,066 |
| dq_run | live DQ | 14 | 1,752 | 4,619 | 4,804 |
| answer_revenue | answer | 14 | 494 | 516 | 523 |
| match_rate | measure (generic match_rate) | 23 | 245 | 325 | 457 |
| joinmap_cik_control | measure (named join-map statement) | 7 | 660 | 746 | 746 |
| joinmap_cik | measure (named join-map statement) | 6 | 715 | 804 | 804 |
| joinmap_loc | measure (named join-map statement) | 6 | 708 | 754 | 754 |
| joinmap_cik_orphans | measure (named join-map statement) | 6 | 609 | 691 | 691 |
| match_rate_orphans | measure (generic match_rate) | 14 | 247 | 314 | 393 |
| answer_fema_utilities | answer | 7 | 387 | 395 | 395 |
| joinmap_fema_state | measure (named join-map statement) | 7 | 291 | 320 | 320 |
| joinmap_sic | measure (named join-map statement) | 6 | 323 | 356 | 356 |
| joinmap_fema_state_orphans | measure (named join-map statement) | 7 | 245 | 273 | 273 |
| joinmap_fema_fips | measure (named join-map statement) | 6 | 281 | 311 | 311 |
| joinmap_sic_orphans | measure (named join-map statement) | 6 | 256 | 306 | 306 |
| catalogue_list | catalogue | 7 | 180 | 214 | 214 |

## 7. What did not go well

- The model loses the key-proposal comparison. Over the five cold runs with the model it made 11 proposals and 3 were VERIFIED; the deterministic baseline made 30 and 25 were VERIFIED. Every key the model got VERIFIED (the FEMA FIPS key, utility_states.state ~ states.code, hq_state ~ seed_stations.state) was also measured in the same run from the baseline's measure queue. On this data the runs do not show the model finding a key the baseline misses.
- The no-model run reached the identical answer and the same governed join-map keys in 88.4 s, against 247.7-285.8 s for the cold runs with the model. On this question the planner and the note add time, not keys; what the model adds is the choice among probed columns, and the runs measure that choice as weaker than the baseline's.
- Several model choices are pairs nobody would try: utility_states.cik ~ states.fips (0 of 43), utility_states.state ~ the FEMA fips_state_code (0 of 43), the frames cik ~ sic_codes.code under lpad10 (0 of 1,937). Lightning SQL refuses each as REJECTED, which is the design, but each costs a planner step and a statement.
- A VERIFIED rate measures value containment, not meaning: hq_state ~ seed_stations.state (28 of 28, model and baseline queue) and utility_states.state ~ seed_stations.state (43 of 43, baseline) are VERIFIED because two lists of US state codes overlap. Neither is a join key anyone would use, and the join map shows them beside the governed keys without saying so.
- The planner's replies: 125 of 157 planner calls were valid over the six runs with the model, and the host took 2 to 8 checklist steps itself per run (fallback steps), 8 in the think-off run.
- The note: the model's draft was replaced by the 250-word template in 3 of the 6 runs with the model (word or length issues). In cold 2 a draft saying revenue 'held up' while EIX and POR fell passed the verifier at that code; the rule gap was fixed afterwards (c090bc1), and the runs on fc130bd carry the fix.
- The curated served states have a gap the outside check found: PPL's FY2024 10-K names Virginia (Kentucky Utilities serves its Virginia customers as Old Dominion Power), which seeds/utilities.json leaves out. No Virginia major-disaster declaration is dated in Q1 2025 or Q1 2024, so neither answer changes; the seed file is not edited in this lane.
- cw.stations is the slow object: probing it costs about 27 s per cold run (DESCRIBE about 5 s, five rows about 7 s, two distinct counts about 7 s each) and its join-map statement 7.7 s; the two weather statements take 18 s each.
- The model was unloaded and loaded again mid-run: the card memory fell by about 3,150 MiB for about two seconds three times in the think-on run and twice in the think-off run. The likely cause is the agent's host-RAM guard (free host RAM was 4,528 MiB at the start of the think-on run on a machine with many other programs open; the guard unloads below 2,048 MiB), but its events are not saved in the run file, so the cause is not verified. The card's first and peak figures also move with other programs on the card (the no-model run's peak, 7,482 MiB, is above the think-on run's, 6,959 MiB).
- The manual baseline ran pre-written statements, so a person's time is not measured; the user gain is stated in statements and decisions, not minutes.

## Not measured

- A person's time to find, write and read the manual-baseline SQL (the session time in section 4 is not a person's time).
- More than one run per ablation setting, and think off or no model on the warm question.
- A second quantisation of the model (only Q4_K_M was run), and the model's own VRAM peak while generating: nvidia-smi samples the whole card, so only the unload drop (about 3,150 MiB) and Ollama's figure (2,881 MiB) are the model's.
- Revenue against the companies' own reports: the answer compares SEC frames values year on year under the first available tag; no 10-Q figure was checked.
- Served states of the other 41 seed utilities against their 10-Ks (two were checked).
- Run-time registration on Day 2: every registration in these runs answered already_registered; the evidence of a live registration is the Day-1 warm run r20261025T1413091c1c, and FEMA CY2023Q1 and frames CY2022Q1 stay unregistered for the recorded warm question (D19).
- The full onboarding DQ run on Day 2: the onboarding DQ file is from 25 Oct 13:46 SGT; each question runs the two fast DQ rules live.
- Statement times under concurrent question load: every run here ran alone.
