# Zetaris objects for Weather-or-Not

Lightning SQL for every Zetaris object the agent reads, as `NN_*_create.sql` / `NN_*_select.sql` pairs in `sql/`, in the getting-started style (header: source, licence, format, docs, rate limit, status, caveats). One statement per JDBC call, no trailing semicolon, qualified names. Every statement is checked against the gateway allowlist (`gateway/allowlist.py`) and logged to `data/evidence/sql_log.jsonl`; REST statements carry the User-Agent placeholder `YOUR_APP_NAME YOUR_CONTACT_EMAIL`, which the runner and the gateway replace from `WON_USER_AGENT` in `.env.local` at run time (never a literal in this repository).

```bash
.venv/Scripts/python -m gateway.run_sql zetaris/sql/01_won_sec_create.sql --dry-run
.venv/Scripts/python -m gateway.run_sql zetaris/sql/01_won_sec_create.sql --skip-exists
.venv/Scripts/python -m gateway.run_sql zetaris/sql/01_won_sec_select.sql
```

The runner waits at least 0.1 s between statements that may call SEC EDGAR (10 requests per second), bounds `RUN DQ` / `SHOW DQ` at 120 s and everything else at 600 s, and treats "already exists" as done with `--skip-exists` (neither `CREATE LIGHTNING DATABASE` nor `CREATE SCHEMASTORE CONTAINER` accepts `IF NOT EXISTS` on 2.4.3.1: parse error `mismatched input 'not'`).

| Script | Objects |
|---|---|
| `01_won_sec` | Lightning database `WON_SEC`; SchemaStore container `won`; frames `WON_SEC.frames_<tag>_<period>` and views `won.frames_<tag>_<period>` for the three revenue tags x CY2025Q1, CY2024Q1; companyconcept `WON_SEC.concept_<cik10>_<tag>` and views `won.concept_<cik10>_<tag>` for the four Day-0 utilities; submissions `WON_SEC.submissions_<cik10>` and views `won.submission_<cik10>`; every view cached |
| `02_won_dns` | Lightning database `WON_DNS`; `WON_DNS.sic_codes_v4_raw` (company_dns V4, cached); view `won.sic_codes` (code, description, division, division_desc, major_group, major_group_desc; cached) |
| `03_won_frames_runtime_template` | The four statements the gateway registrar issues for a new frames period (documentation of `gateway/templates.py` `register_frames`; not run by the runner) |
| `04_won_ghcn` | Lightning database `WON_GHCN`; filestore tables `WON_GHCN.ghcn_2024_tmax`, `ghcn_2024_tmin`, `ghcn_2025_tmax`, `ghcn_2025_tmin` (NOAA GHCN-Daily parquet, public S3); station-filtered views `won.ghcn_<year>_<element>` (cached); `_select` holds the count gates and the degree-day validation queries |
| `05_won_usl` | Namespace `lightning.metastore.weatherornot`; USL `weather_or_not_usl` with `sic_code`, `utility`, `station`, `weather_quarter`, `revenue_quarter`, descriptions on the model and every table and column; activations of `station` and `weather_quarter` from the GHCN views and of `sic_code`, `utility`, `revenue_quarter` from the SEC and SIC views; DQ rule `coverage_ok`; `_select` runs LIST DQ, RUN DQ, SHOW DQ and the USL joins |
| `06_won_sec_seeds` | The submissions profile of the 39 seed utilities that `01` does not register (so `01` + `06` cover all 43 of `seeds/utilities.json`) and the companyconcept history of the demo and warm-run utilities (FirstEnergy, American Electric Power) under the two tags each uses; every view cached. `_select` counts them, lists the seeds present per frames period and extends the join map to the 43 seeds |

Onboarding order: `01`, `02`, `04`, `06`, then `05` (its SEC-side activations read the `06` views). After `05`, `scripts/dq_onboard.py` runs the onboarding DQ pass and writes `data/dq/latest.json` (see "DQ gate" below).

## SEC EDGAR and SIC (gates G3, G4, G5, G7; Fri 24 Oct 2026, 17:1x SGT, Zetaris 2.4.3.1 local Docker)

### Objects

- `WON_SEC` (REST, host `data.sec.gov`), 61 raw tables after Day 1: 6 frames of the two comparison quarters plus `frames_Revenues_CY2025Q2` and `frames_Revenues_CY2024Q2` registered at run time (G7, Day 0 and Day 1); 10 companyconcept (Duke Energy, Southern Co, Xcel Energy, Entergy, FirstEnergy, American Electric Power under the tags each uses); 43 submissions (every seed of `seeds/utilities.json`).
- `WON_DNS` (REST, host `company-dns.mediumroast.io`), `sic_codes_v4_raw`.
- Container `won` (shared with the GHCN views), 62 SEC/SIC views, all cached (66 `won.*` in-memory tables with the four GHCN views). The Spark UI storage tab (`127.0.0.1:4040`, the cache truth source) lists every one as an `In-memory table`; frames views 143-193 KB each, concept views 4-11 KB, submission views about 1.2 KB, `won.sic_codes` 54 KB, `WON_DNS.sic_codes_v4_raw` 255 KB: about 1.5 MB of SEC/SIC cache in all.

Inferred shapes (`DESCRIBE`): frames raw `data array<struct<accn, cik:bigint, end, entityName, loc, start, val>>` (`val` was inferred `double` for CY2025Q1 and `bigint` for CY2025Q2: cast it downstream); companyconcept raw `units struct<USD:array<struct<accn, end, filed, form, fp, frame, fy:bigint, start, val:bigint>>>` (`frame` is missing from some filers' facts, so the views never select it); the `won.submission_*` views are five strings (`cik` is the zero-padded 10-digit string).

### Verified counts (Zetaris vs the source response fetched independently with the same User-Agent, same day)

| Object | Zetaris | Source | |
|---|---|---|---|
| `won.frames_Revenues_CY2025Q1` | 1,937 | 1,937 (`data` length) | match |
| `won.frames_Revenues_CY2024Q1` | 2,095 | 2,095 | match |
| `won.frames_RevenueFromContractWithCustomerExcludingAssessedTax_CY2025Q1` | 2,546 | 2,546 | match |
| `won.frames_RevenueFromContractWithCustomerExcludingAssessedTax_CY2024Q1` | 2,654 | 2,654 | match |
| `won.frames_RegulatedAndUnregulatedOperatingRevenue_CY2025Q1` | 20 | 20 | match |
| `won.frames_RegulatedAndUnregulatedOperatingRevenue_CY2024Q1` | 22 | 22 | match |
| `won.frames_Revenues_CY2025Q2` (G7, registered through the gateway, Day 0) | 1,941 | 1,941 | match |
| `won.frames_Revenues_CY2024Q2` (G7, registered through the gateway, Day 1) | 2,018 | 2,018 | match |
| `won.concept_0001326160_Revenues` / `_RegulatedAndUnregulatedOperatingRevenue` (Duke Energy) | 70 / 170 | 70 / 170 (`units.USD` length) | match |
| `won.concept_0000092122_Revenues` (Southern Co) | 293 | 293 | match |
| `won.concept_0000072903_Revenues` / `_RegulatedAndUnregulatedOperatingRevenue` (Xcel Energy) | 210 / 115 | 210 / 115 | match |
| `won.concept_0000065984_Revenues` (Entergy) | 98 | 98 | match |
| `won.concept_0001031296_Revenues` / `_RevenueFromContractWithCustomerExcludingAssessedTax` (FirstEnergy) | 194 / 42 | 194 / 42 | match |
| `won.concept_0000004904_Revenues` / `_RevenueFromContractWithCustomerExcludingAssessedTax` (American Electric Power) | 304 / 18 | 304 / 18 | match |
| `won.submission_<cik10>` x 43 (one `UNION ALL` over the 43 views, `06_won_sec_seeds_select.sql`) | 43 rows, one per seed; 42 with SIC 4911 / 4931 / 4932, MGE Energy 4900 | same | match |
| `won.sic_codes` | 1,005 (1,005 distinct 4-digit codes) | 1,005 (`total`) | match |

Seeds present per frames period (the `frames_seeds` template: the 43 seed CIKs compared as integers; one row per seed filer that reported under the tag):

| Tag | CY2025Q1 | CY2024Q1 | CY2024Q2 |
|---|---|---|---|
| `Revenues` | 34 | 35 | 36 |
| `RevenueFromContractWithCustomerExcludingAssessedTax` | 21 | 23 | |
| `RegulatedAndUnregulatedOperatingRevenue` | 9 | 11 | |

Across the three tags, 42 of the 43 seeds have a CY2025Q1 fact (IDACORP has none under any of them) and all 43 have a CY2024Q1 fact (measured with a `UNION` of the three seed-filtered views per period). With each filer's first available tag (method step 1), the target, MGE Energy (SIC 4900, never a peer) and Oncor (its CY2025Q1 tag `Revenues` has no CY2024Q1 fact) taken out, that is the 39-peer universe of the demo case. Both quarters' facts came back with `val` as a double (the template casts it: the view infers `bigint` for CY2024Q1 and `double` for CY2025Q1).

A frames period is one fact per filer: 1,937 facts = 1,937 distinct `cik` in Revenues CY2025Q1. The frames API aligns fiscal quarters to the calendar quarter, so `start` ranges from 2024-11-23 and `end` to 2025-05-11 in that period; the method's 3-month check uses the `start`/`end` columns, not the frame name. 1,742 of the 1,937 facts carry a US state in `loc` (`US-XX`); 195 carry a country code.

Which tag a utility reports its quarterly revenue under differs: Duke Energy and Xcel Energy have no quarterly `Revenues` facts and report `RegulatedAndUnregulatedOperatingRevenue` (CY2025Q1 8,249,000,000 and 3,906,000,000); Southern Co and Entergy report `Revenues` (7,775,000,000 and 2,846,874,000). The companyconcept endpoint answers 404 for a tag a filer never used (Southern Co: only `Revenues`; Entergy: no `RegulatedAndUnregulatedOperatingRevenue`), so concept tables exist per (filer, tag) and are registered on demand (`register_concept`). Like-for-like (method step 2): Southern Co's CY2024Q1 value is 6,646,000,000 both as first filed (accn 0000092122-24-000042, filed 2024-05-02) and as the comparative in the CY2025Q1 filing (0000092122-25-000042); Duke's is 7,671,000,000 in both filings; Entergy's CY2024Q1 `Revenues` fact exists only in the 2025 filing (the 2024 filing used `RevenueFromContractWithCustomerExcludingAssessedTax`), a tag switch the recast check has to treat as "comparative only".

### Join map (measured in Lightning SQL, four utilities)

| Check | Result |
|---|---|
| frames `LPAD(CAST(cik AS STRING), 10, '0')` = submissions `cik`, CY2025Q1 | Revenues 2 of 4 (Southern, Entergy); RevenueFromContract... 0 of 4; RegulatedAndUnregulated... 2 of 4 (Duke, Xcel): 4 of 4 across the probe order |
| the same join without LPAD (`CAST(cik AS STRING) = cik`) | 0 (the formats differ: integer vs zero-padded string) |
| frames `loc` = `'US-' + submissions business state` | 4 of 4 agree (US-LA, US-MN, US-GA, US-NC) |
| submissions `sic` = `won.sic_codes.code` | 4 of 4 join; descriptions agree up to case and "&" vs "and" (4931 "Electric & Other Services Combined" vs "Electric and Other Services Combined"); all division E, major group 49 |

Extended to the 43 seeds on Day 1 (`06_won_sec_seeds_select.sql`): submissions `sic` joins `won.sic_codes` for 42 of 43 (MGE Energy's SIC `4900` has no row in the company_dns V4 list, so it is the one SIC orphan the USL FK rule reports, below); frames `loc` agrees with the submissions business state for 34 of the 34 seeds present in Revenues CY2025Q1.

### Timings (JDBC statement time, one connection)

- `CREATE LIGHTNING REST TABLE`: frames 338-1,421 ms (median about 450 ms), companyconcept 328-467 ms, submissions 313-388 ms, company_dns V4 1,484 ms. `CREATE SCHEMASTORE VIEW` 55-80 ms (no source call).
- `CACHE TABLE` on a view: frames 237-1,304 ms, concept 221-340 ms, submission 327-348 ms, `won.sic_codes` 200 ms; `CACHE TABLE WON_DNS.sic_codes_v4_raw` 566 ms. The whole of `01_won_sec_create.sql` (50 statements, 16 SEC requests for CREATE and 16 for CACHE) ran in under a minute.
- Cached reads: `COUNT(*)` 150-250 ms; a filer lookup 160-230 ms; the LPAD join of a frames view with the four submission views 450-890 ms; the four-way loc agreement query 891 ms. `DESCRIBE` on a raw table 26-37 ms, on a view 97-120 ms.
- Through the gateway (`POST /sql/template`, 127.0.0.1:8793): 200-370 ms wall for `frames_count`, `frames_fact`, `concept_history` (293 rows), `submission`, `sic`, all with `cache_state: hit`.
- `06_won_sec_seeds_create.sql` (129 statements: 39 submissions and 4 companyconcept tables, each table + view + CACHE) ran in 49 s wall: `CREATE LIGHTNING REST TABLE` submissions median 358 ms (166 to 3,211), concept 315-383 ms; views 52-85 ms; `CACHE` submissions median 290 ms, concept 217-259 ms; 86 SEC requests, no error. A `UNION ALL` over the 43 cached submission views answers in 6.4 to 7.4 s (about 150 ms per cached REST view).

### Run-time registration (G7)

`POST /registrar/register_frames {"tag": "Revenues", "period": "CY2025Q2", "contract": ...}` with a signed medium-risk execution contract (`scripts/registrar_call.py` signs one from `WON_CONTRACT_SECRET`) returned 200 in 1.2 s wall: `registrar_frames_table` 469 ms, `registrar_frames_view` 58 ms, `registrar_frames_describe` 112 ms (7 columns returned to the caller), `registrar_frames_cache` 379 ms. The new objects are `WON_SEC.frames_Revenues_CY2025Q2` and `won.frames_Revenues_CY2025Q2` (Data Explorer: WON_SEC, and the `won` container); `frames_count` for the period then answered 1,941 from cache (152 ms statement), equal to the source. The reply and the SQL log keep the User-Agent placeholder; the declared value went to Zetaris only. Refusals checked: period `CY2025Q4` 400 `bad_params` before any contract check; valid parameters without a contract 403 `missing`; a registrar template through `/sql/template` 403; `sic` with a quote in the code 400; a reader template over an unregistered filer 502 `TABLE_OR_VIEW_NOT_FOUND` with `cache_state: miss` (the agent then calls `register_concept`).

Repeated on Day 1 for a second unregistered period, `Revenues` / `CY2024Q2`: 200 in 1.08 s wall, steps `registrar_frames_table` 426 ms, `registrar_frames_view` 53 ms, `registrar_frames_describe` 100 ms (7 columns, `val bigint`), `registrar_frames_cache` 305 ms, nothing skipped; `frames_count` then 2,018 from cache (149 ms) = the source response's `data` length fetched the same minute, and `frames_seeds` 36 seed rows (218 ms). Objects: `WON_SEC.frames_Revenues_CY2024Q2`, `won.frames_Revenues_CY2024Q2`.

### Gateway templates (`gateway/templates.py`)

Reader (`POST /sql/template`): `frames_period(tag, period)` -> cik, entityName, loc, start, end, val, accn (the HTTP reply holds the first 200 rows, `row_count` the total); `frames_seeds(tag, period)` -> the same columns with `val` cast to DOUBLE, filtered to the 43 seed CIKs of `seeds/utilities.json` (`CAST(cik AS BIGINT) IN (...)`, the list read from the seed file when the gateway starts), so the peer universe comes back in one reply of at most 43 rows, never cut by the 200-row cap (live 34 rows in 236 ms wall for Revenues CY2025Q1); `frames_count(tag, period)`; `frames_fact(tag, period, cik10)`; `concept_history(cik10, tag)` -> fy, fp, form, filed, accn, start, end, val; `submission(cik10)` -> cik, name, sic, sicDescription, state; `sic(code)`; `usl_revenue(cik10, period)` and `usl_utility(cik10)` read the governed USL copies (below). Registrar plans (`POST /registrar/<action>`, each: raw table -> view -> DESCRIBE -> CACHE, the two CREATEs skipping "already exists", CACHE bounded at 600 s): `register_frames(tag, period)`, `register_concept(cik10, tag)`, `register_submission(cik10)`. Parameters: `tag` is a 3-value enum, `period` matches `^CY\d{4}Q[1-3]$`, `cik10` `^\d{10}$`, `sic` `^\d{4}$`. The warm-up (`CACHE_TARGETS` in `gateway/app.py`: the 6 frames views, 10 concept views, 43 submission views, `won.sic_codes` and the 4 GHCN views, 64 in all) re-caches them after a driver restart; a period registered at run time is cached by its plan and is not in the list.

The gateway reply holds at most 200 rows (`MAX_ROWS`, one cap for every template; there is no per-template cap). `frames_period` exceeds it for every frames period (about 1,900 to 2,600 facts) and is kept for counts and spot checks; `frames_seeds` is the template the agent uses for the peer set and cannot exceed the seed count.

## NOAA GHCN-Daily parquet (gate G2; Fri 24 Oct 2026, 17:0x to 17:2x SGT, Zetaris 2.4.3.1 local Docker)

### Objects

- `WON_GHCN` (FILESTORE, PARQUET, public bucket `s3a://noaa-ghcn-pds/parquet/by_year/YEAR=<yyyy>/ELEMENT=<TMAX|TMIN>/`, endpoint `s3.us-east-1.amazonaws.com`, no credentials): `ghcn_2025_tmax`, `ghcn_2025_tmin`, `ghcn_2024_tmax`, `ghcn_2024_tmin`. Each partition is 9 parquet files, about 14.9 MB and 4.31 to 4.37 million rows (every station worldwide); a station's days are spread over the 9 files. Inferred schema (`DESCRIBE`, 7 columns): `ID string, DATE string (yyyymmdd), DATA_VALUE bigint (tenths of a degree C), M_FLAG, Q_FLAG, S_FLAG, OBS_TIME string`. The raw tables are never cached.
- Views `won.ghcn_2025_tmax`, `won.ghcn_2025_tmin`, `won.ghcn_2024_tmax`, `won.ghcn_2024_tmin` (same 7 columns, `WHERE ID IN (...)` over the 56 seed stations of `seeds/stations.json` plus `USW00013740`, Richmond VA, the validation station of the degree-day check; no seed utility uses it). All four cached; the Spark UI storage tab lists each as an `In-memory table` of 264 to 269 KB (2 partitions).

### Verified counts (Zetaris vs pyarrow over the same files, anonymous S3, same day)

| Check | Zetaris | pyarrow | |
|---|---|---|---|
| `WON_GHCN.ghcn_2025_tmax` rows with `ID = 'USW00013740'` (raw table, S3 scan) | 365 | 365 (9 files) | match |
| `won.ghcn_2025_tmax` rows / distinct stations / dates | 20,801 / 57 / 20250101 to 20251231 | 20,436 seed rows + 365 | match |
| `won.ghcn_2025_tmin` | 20,799 / 57 | 20,434 + 365 | match |
| `won.ghcn_2024_tmax` | 20,859 / 57 / 20240101 to 20241231 | 20,493 + 366 | match |
| `won.ghcn_2024_tmin` | 20,858 / 57 | 20,492 + 366 | match |

2025 is a complete year in the parquet (through 2025-12-31). Every seed station is present in all four partitions.

### Degree days in Lightning SQL (the `weather_quarter` template, `04_won_ghcn_select.sql` query 5)

Per station and quarter: `TMAX` joined to `TMIN` on `ID` and `DATE`, days with a non-empty `Q_FLAG` on either element dropped, `Tmean F = ((TMAX + TMIN) / 2) / 10 * 9 / 5 + 32`, `HDD = SUM(GREATEST(0, 65 - Tmean F))`, `CDD = SUM(GREATEST(0, Tmean F - 65))`, the quarter from `substr(DATE, 5, 2)`, `coverage = days_observed / days in the quarter` (Q1 90 or 91 in a leap year, Q2 91, Q3 92). The same arithmetic, in the same evaluation order, as `agent/src/tools/degreeDays.ts`.

| Station, quarter | Zetaris HDD / CDD / days / coverage | pyarrow | |
|---|---|---|---|
| USW00013740 (Richmond VA), 2025 Q1 | 2022.69 / 22.08 / 90 / 1.0 | 2022.69 / 22.08 / 90 / 1.0 | match to 0.01 |
| USW00013722 (Raleigh NC), 2025 Q1 | 1538.88 / 28.41 / 90 / 1.0 | 1538.88 / 28.41 / 90 / 1.0 | match to 0.01 |

#### Parity with the TypeScript reference (checked 24 Oct 2026, 19:3x SGT)

Three paths computed USW00013740, 2025 Q1 and agree to the printed precision: the tool's own SQL text, `degreeDaySql({ year: 2025, quarter: 1, stations: ["USW00013740"] })` from `agent/src/tools/degreeDays.ts` (CASE WHEN form, explicit date bounds, `COUNT(*) / 90.0`), run over JDBC with `gateway.run_sql --sql`; the gateway's `weather_quarter` template for the same station and quarter through `POST /sql/template` (GREATEST form, month filter); and `degreeDaysFromDaily()` over the station's 2025 daily rows read from the same parquet files with pyarrow (365 TMAX and 365 TMIN days, none quality-flagged).

| Path | HDD | CDD | days observed | coverage | time |
|---|---|---|---|---|---|
| `degreeDaySql` text over JDBC | 2022.69 | 22.08 | 90 | 1.00 | 61.9 s statement (a second filestore query ran at the same time; see below) |
| `weather_quarter` template through the gateway | 2022.69 | 22.08 | 90 | 1.00 | 22.8 s statement, 30.1 s wall, cache hit, instance under load |
| `degreeDaysFromDaily` over the pyarrow rows | 2022.69 (2022.6900000000007) | 22.08 (22.079999999999984) | 90 | 1.00 | about 35 s to read the two partitions |

So the BIGINT sum divided by the `2.0` literal is a double in Lightning, `Q_FLAG` arrives null or empty, `COUNT(*) / 90.0` is a real division, and the two SQL forms and the TypeScript arithmetic round the same way. Two filestore queries sent at the same time (one through the gateway, one over JDBC) slowed each other down (61.9 s for the JDBC one; the gateway call hit its 60 s bound and was retried alone): the agent sends its GHCN queries one at a time.

### Timings (JDBC statement time)

- `CREATE LIGHTNING DATABASE` 158 ms; `CREATE LIGHTNING FILESTORE TABLE` 4.5 to 7.0 s each (partition listing and schema inference); `DESCRIBE` 52 to 133 ms; `CREATE SCHEMASTORE VIEW` 3.0 to 3.1 s each.
- `CACHE TABLE` on a view: 42.1 / 45.4 / 41.0 / 43.2 s (2025 TMAX, 2025 TMIN, 2024 TMAX, 2024 TMIN); each scans the 9 files of its partition once.
- Uncached `COUNT(*) ... WHERE ID = ...` on a raw table: 29.4 s.
- Reads of a cached view: `COUNT(*)` 8.8 to 10.8 s; the two-view degree-day join for one quarter 19.0 s. The Spark SQL UI shows these queries executing in Spark in about 70 ms from `Scan In-memory table won.ghcn_...` (the parquet scan node outputs 0 rows): the cache is used, and the remaining 9 s per view is spent before Spark execution, resolving the filestore source, once per filestore table the query references (one view about 9 s, two views about 19 s). This is a property of the filestore source on this instance, not a cache miss; the agent therefore asks for all of a period's stations in one `weather_quarter` call (up to 40 ids) instead of one call per utility.

### Gateway templates and warm-up

- `weather_quarter(year, quarter, station_list)`: the degree-day query above over `won.ghcn_<year>_tmax` and `won.ghcn_<year>_tmin`; `station_list` is 1 to 40 station ids separated by commas (`^US[A-Z0-9]{9}(,US[A-Z0-9]{9}){0,39}$`), rendered as a quoted `IN` list. Returns `station_id, year, quarter, hdd, cdd, days_observed, days_in_quarter, coverage`.
- `usl_describe()`: `LOAD USL weather_or_not_usl NAMESPACE lightning.metastore.weatherornot`. `dq_invalid()`: `SHOW DQ INVALID RECORD coverage_ok TABLE ...weather_quarter` (the all-rules form did not return within 900 s; see G6). `dq_run_coverage()`: `RUN DQ coverage_ok TABLE ...weather_quarter`.
- `CACHE_TARGETS` in `gateway/app.py` ends with the four GHCN views (`templates.GHCN_VIEWS`, 2025 first), so the warm-up re-caches them after a driver restart (about 3 minutes for the four). `scripts/warmup.py` does the same from the command line and prints per-view timings and in-memory sizes (`--force` re-caches everything, `--refresh` uncaches first). Live: 21 targets (17 SEC/SIC views + 4 GHCN views) all already cached, `COUNT(*)` 140 to 260 ms on the SEC views and 8.9 to 9.1 s on the GHCN views, 38.9 s in all, no failures.
- Through the gateway (`POST /sql/template`, 127.0.0.1:8793): `weather_quarter` for 2025 Q1 and 2024 Q1 with two stations answered in 18.3 s and 17.6 s wall (statement 18.3 s and 17.5 s), `cache_state: hit`, values equal to the runner's; `usl_describe` 43 ms wall; `select1` 60 ms.
- A cached derived view holding the whole degree-day table (`won.weather_quarter`, 342 rows) was tried and abandoned: reads of it took 109 s (its CACHE 109 s, a filtered read 108 s), slower than the two-view join, because every view layer resolves the filestore sources again. It remains on the instance uncached (no DROP is issued by this repository) and nothing reads it.

## USL weather_or_not_usl (gate G6; Fri 24 Oct 2026, 17:3x to 18:0x SGT)

### Model

`lightning.metastore.weatherornot.weather_or_not_usl` (usl id 1825), compiled and deployed as ONE statement with five tables (`05_won_usl_create.sql`):

| Table | Key | Foreign keys | Activated from | Rows |
|---|---|---|---|---|
| `sic_code(code, description)` | PK `code` | | `won.sic_codes` (company_dns V4) | 1,005 |
| `utility(cik, name, ticker, sic, hq_state)` | PK `cik` | `sic` -> `sic_code.code` | `UNION ALL` of the 43 `won.submission_<cik10>` views, LEFT JOIN an inline `VALUES` list of (cik, ticker) from `seeds/utilities.json` (40 seeds have a ticker) | 43 |
| `station(id, state, name)` | PK `id` | | `won.ghcn_2025_tmax` (DISTINCT `ID`) joined to an inline `VALUES` list of the 57 seed stations (state, name) | 57 |
| `weather_quarter(station_id, year, quarter, hdd, cdd, days_observed, coverage)` | PK `(station_id, year, quarter)` | `station_id` -> `station.id` | the four `won.ghcn_<year>_<element>` views: TMAX x TMIN joins for 2025 and 2024, Q1 to Q3, same arithmetic as the `weather_quarter` template | 342 |
| `revenue_quarter(cik, xbrl_tag, year, quarter, val, accn, filed, is_comparative)` | PK `(cik, xbrl_tag, year, quarter, accn)` | `cik` -> `utility.cik` | `UNION ALL` of the six frames views of CY2025Q1 and CY2024Q1 (three tags), filtered to the 43 seed CIKs so the FK holds; `val` cast to DOUBLE; `is_comparative` = the accession number's filing year (characters 12-13) is later than the period's year; `filed` NULL (not in frames) | 133 |

`revenue_quarter` by tag and period: `Revenues` 34 (CY2025Q1) / 35 (CY2024Q1), `RevenueFromContractWithCustomerExcludingAssessedTax` 21 / 23, `RegulatedAndUnregulatedOperatingRevenue` 9 / 11; 128 of the 133 rows are comparatives (the frames endpoint serves the most recently filed fact, which today is the 2026 10-Q comparative for CY2025Q1 and the 2025 10-Q comparative for CY2024Q1). The like-for-like value of the current period therefore comes from `concept_history` (the fy2025 filing), as SPEC section 11 requires; `revenue_quarter` is the governed, DQ-checked copy of what frames served.

Findings while compiling:
- Table-level composite primary keys (`PRIMARY KEY (station_id, year, quarter)`) are accepted by Zetaris 2.4.3.1; `LOAD USL` returns them as the table's `primaryKey.columns`. `boolean`, `int`, `double` and `varchar(n)` columns are accepted.
- The first COMPILE failed with `Invalid DDL statement. Please provide a valid CREATE TABLE statement using Spark SQL or ANSI SQL syntax` because a column was named `tag`: `tag` is a reserved word in the Lightning catalog parser (an `UPDATE USL ... revenue_quarter.tag SET COLUMN DESCRIPTION` fails with `no viable alternative at input`). The column is therefore `xbrl_tag`; nothing else changed.
- `COMPILE USL IF NOT EXISTS` on the deployed model is a 28 ms no-op that returns the model JSON. `CREATE NAMESPACE IF NOT EXISTS` is idempotent (parent `lightning.metastore` first).
- Descriptions on the model, every table and every column: 31 `UPDATE USL ... SET [TABLE | COLUMN] DESCRIPTION <unquoted text>` statements, 14 to 38 ms each (a quoted string would be stored with its quotes; the text carries no semicolon or apostrophe). `LOAD USL` (32 ms) returns them, so the planner prompt can be built from the model.
- An inline table `SELECT ... FROM VALUES (...), (...) AS seed(id, state, name)` is accepted in an activation query (and in a plain SELECT: 142 ms).

### Timings (JDBC statement time)

| Statement | Time |
|---|---|
| `COMPILE USL ... DEPLOY` (5 tables) | 161 ms |
| `ACTIVATE USL TABLE ...station` | 9.0 s (one GHCN view behind it) |
| `ACTIVATE USL TABLE ...weather_quarter` | 35.5 s (four GHCN views) |
| `REGISTER DQ coverage_ok TABLE ...weather_quarter AS coverage >= 0.9` | 184.1 s (the rule is evaluated on registration) |
| `ACTIVATE USL TABLE ...sic_code` (Day 1) | 220 ms |
| `ACTIVATE USL TABLE ...utility` (43 cached REST views) | 5.2 s |
| `ACTIVATE USL TABLE ...revenue_quarter` (6 cached REST views) | 749 ms |
| `SHOW NAMESPACES OR TABLES IN lightning.metastore.weatherornot` | 106 ms |
| `SELECT COUNT(*), COUNT(state) FROM ...station` | 44.1 s (57 / 57) |
| `SELECT id, state, name FROM ...station ORDER BY id` | 87.7 s (57 rows) |
| `SELECT COUNT(*) FROM ...sic_code` | 319 ms (1,005) |
| `SELECT COUNT(*), COUNT(ticker), COUNT(DISTINCT sic) FROM ...utility` | 45.5 s (43 / 40 / 4) |
| `SELECT ... FROM ...utility WHERE cik = '0001031296'` (the `usl_utility` template) | 45.5 s by JDBC, 51.4 s through the gateway (Day 0); 141.4 s by JDBC on Day 1 with the instance idle, so the template's bound is 300 s |
| `SELECT xbrl_tag, year, quarter, COUNT(*) ... FROM ...revenue_quarter GROUP BY ...` | 4.1 s (6 groups, 133 rows) |
| `SELECT ... FROM ...revenue_quarter WHERE cik = ... AND period` (the `usl_revenue` template) | 2.2 s by JDBC; 4.2 s (FirstEnergy, 1 row) and 2.3 s (AEP, 2 rows) through the gateway |
| `revenue_quarter` JOIN `utility` LEFT JOIN `sic_code` for two filers | 43.7 s (4 rows) |

Every read of a USL table pays a USL-layer hop per source view: over the filestore views that hop is the 9 s resolution described above (the `station` table answers in 44 to 88 s, `weather_quarter` in minutes), and over cached REST views it is about one second per view (the `utility` table over 43 submission views answers in 45 to 51 s, `revenue_quarter` over 6 frames views in 2 to 4 s). The DQ templates (`dq_run_coverage`, `dq_invalid`) therefore carry a 600 s bound (`Template.timeout_s`, `DQ_TIMEOUT_S`), `usl_utility` 300 s (it took 45 s on Day 0 and 141 s on Day 1), the other templates keep the gateway default of 60 s, and the agent's client waits up to 630 s for the DQ templates (`TEMPLATE_TIMEOUT_MS`). The fast paths for the agent are the `weather_quarter` template over the views (about 18 s per quarter for any station list), `frames_seeds` (about 0.2 s) and `submission` (about 0.2 s); the USL tables are the governed, DQ-checked copies read for evidence (`usl_revenue` in seconds) or at onboarding.

### Verification (`05_won_usl_select.sql`)

Run with `--timeout 600` (a read of a USL table over the filestore views takes minutes; the runner's RUN/SHOW DQ default of 120 s is too short here).

| Check | Result | Time |
|---|---|---|
| `SHOW NAMESPACES OR TABLES IN lightning.metastore.weatherornot` | `weather_or_not_usl`, 5 tables | 106 ms |
| `LOAD USL` | the model with every description | 32 ms |
| `station`: rows, rows with a state | 57 / 57 | 44.1 s |
| `station` rows ordered by id | 57 (Norfolk and Richmond both VA) | 87.7 s |
| `weather_quarter`: rows, stations, min coverage, rows below 0.9 | 342 (57 x 2 years x Q1-Q3) / 57 / 0.9556 / 0 | 186.2 s |
| `weather_quarter` for USW00013740, six quarters | 2024 Q1 1672.53 / 9.18 / 91 d; Q2 185.28 / 639.81 / 91; Q3 0.51 / 1123.68 / 92; 2025 Q1 2022.69 / 22.08 / 90; Q2 226.92 / 574.80 / 91; Q3 7.14 / 951.39 / 92; coverage 1.0: every value equals the pyarrow computation | 180.2 s |
| Join map, station -> state coverage (`station` LEFT JOIN `weather_quarter` by state) | 43 states, 57 stations, 342 station-quarters, 342 with coverage >= 0.9 (two-station states: CA, FL, IL, IN, MD, MI, MN, NJ, OH, PA, SD, TX, VA, WI) | 240.2 s |
| `LIST DQ USL` | 9 rules: 5 primary keys (two composite, named `station_id,year,quarter` and `cik,xbrl_tag,year,quarter,accn`), 3 foreign keys (`sic`, `station_id`, `cik`), custom `coverage_ok` | 19 ms |
| `RUN DQ id TABLE ...station` | Primary Key Constraint: 57 total, 57 valid, 0 invalid | 85.9 s |
| `RUN DQ coverage_ok TABLE ...weather_quarter` | Custom Data Quality: 342 total, 342 valid, 0 invalid (a first attempt with a 300 s bound timed out and was cancelled; the completed run is this one) | 361.4 s |
| `SHOW DQ ALL INVALID TABLE ...weather_quarter` | did not return within 900 s (cancelled). The Spark UI shows the USL relation materialised once per rule evaluation (about 3 minutes each; three rules on the table), so the all-rules form takes about 18 minutes here and is not usable as a per-question gate | > 900 s |
| plain-SQL equivalent of `coverage_ok` on the USL table (`WHERE NOT (coverage >= 0.9)`) | 0 rows (agrees with RUN DQ) | 187.9 s |
| `SHOW DQ INVALID RECORD coverage_ok TABLE ...weather_quarter` (the gateway's `dq_invalid`) | 0 rows | 181.5 s |
| Join inside the USL (`weather_quarter` x `station` by state, six Duke Energy states): mean TDD per state and quarter | 36 rows. Q1 TDD 2024 -> 2025: NC 1343.49 -> 1567.29, SC 1180.77 -> 1384.56, FL 599.39 -> 632.17, IN 2160.14 -> 2511.24, OH 2398.56 -> 2848.91, KY 1837.05 -> 2158.83 (colder Q1 in every state; one station-quarter at coverage 0.9889, the rest 1.0) | 224.3 s |
| `weather_quarter` for USW00013740 after the re-activation with double arithmetic | the same six quarters, now as doubles (2025 Q1 HDD 2022.6900000000012, CDD 22.079999999999984, 90 days): equal to pyarrow to 0.01 | 179.8 s |

Two statements failed on the first pass and were corrected in the file: an aggregate over the USL table's double columns (`AVG(w.hdd + w.cdd)`, with or without `ROUND`) raised `java.math.BigDecimal is not a valid external type for schema of double` while encoding the result (the USL layer carries `double` columns as decimals; the query now casts the operands with `CAST(... AS DOUBLE)` inside the aggregate), and the first `RUN DQ coverage_ok` did not return within 300 s (re-run with a longer bound, above). The FK rule `station_id` on `weather_quarter` was not run separately (each DQ run on that table takes about six minutes). The `SHOW DQ ALL INVALID` statement stays in the file for completeness; on this table it did not return within 900 s, so the gateway's `dq_invalid` template reads the single `coverage_ok` rule (`SHOW DQ INVALID RECORD coverage_ok`, 181 s live). The primary-key and station foreign-key rules hold by construction (`weather_quarter` and `station` derive from the same views) and are checked by `RUN DQ` at onboarding, not per question.

### SEC-side verification and DQ (Day 1, `05_won_usl_select.sql` checks 9 to 12)

| Check | Result | Time |
|---|---|---|
| `RUN DQ sic TABLE ...utility` (FK `sic` -> `sic_code.code`) | Foreign Key Constraint: 43 total, 42 valid, **1 invalid** | 79.1 s |
| `SHOW DQ INVALID RECORD sic TABLE ...utility` | 1 row: `0001161728 MGE ENERGY INC, MGEE, 4900, WI` (SIC 4900 is not in the company_dns V4 list; MGE Energy is a target-only seed flagged `kept_despite_sic`, never a peer) | 93.3 s |
| `RUN DQ cik TABLE ...revenue_quarter` (one call evaluated both rules named by the column: the composite PK and the FK `cik` -> `utility.cik`) | Primary Key Constraint 133 / 133 / 0; Foreign Key Constraint 133 / 133 / 0 | 53.8 s |
| `RUN DQ code TABLE ...sic_code` (PK) | 1,005 / 1,005 / 0 | 0.7 s |
| `usl_utility` for FirstEnergy | `0001031296, FIRSTENERGY CORP, FE, 4911, OH` | 45.5 s (Day 0); 141.4 s on Day 1, same row |
| `usl_revenue` for FirstEnergy CY2025Q1 | `Revenues, 2025, 1, 3765000000.0, 0001031296-26-000085, filed NULL, is_comparative true` | 2.2 s |
| `usl_revenue` for AEP CY2025Q1 (through the gateway) | two rows, both from `0000004904-26-000034`: `Revenues` 5,463,000,000 and `RevenueFromContractWithCustomerExcludingAssessedTax` 5,631,000,000 (the 2025 10-Q reported 5,463,400,000 and 5,631,600,000: the live multi-filing conflict, visible in `concept_history`) | 2.3 s |
| `revenue_quarter` JOIN `utility` LEFT JOIN `sic_code`, FirstEnergy and AEP, `Revenues` | 4 rows: both `Electric Services`; FE 3,287,000,000 (2024 Q1, accn `-25-000017`) and 3,765,000,000 (2025 Q1, `-26-000085`); AEP 5,025,700,000 and 5,463,000,000 | 43.7 s |

The one invalid FK row is a real finding, not a defect of the model: the SPEC's DQ gate names "SIC orphan" as a reason to withhold a verdict, and MGE Energy is the seed that trips it. The agent sees it either in `data/dq/latest.json` (the coverage rule) or, for the SIC rule, in this onboarding record; `get_peers` already excludes SIC 4900 from the peer set.

### DQ gate (SPEC section 11.7)

The per-question gate never runs a DQ statement. `scripts/dq_onboard.py` runs `dq_run_coverage` (`RUN DQ coverage_ok`) and `dq_invalid` (`SHOW DQ INVALID RECORD coverage_ok`) on the USL `weather_quarter` table at onboarding and after a registration that changes it, and writes `data/dq/latest.json` (`ran_at`, `rule`, `table`, `elapsed_s`, `ok`, `run` with total / valid / invalid, `invalid_rows` as station-quarter records, `statements` with each SQL text, sha256 and time); `scripts/warmup.py` runs it at the end unless `--skip-dq` is given. The agent's `dq_gate(cik)` reads that file plus the `coverage` column of its own `weather_quarter` result (the same rule, `coverage >= 0.9`), and the answer card states the DQ run time. Expected duration on this instance: `RUN DQ` 6 to 9 min and `SHOW DQ INVALID RECORD` about 3 min (each materialises the four GHCN filestore views again), so a full pass is 9 to 12 min, `--skip-run` about 3 min; both measured passes are in the table below. While it runs, cached template reads still answer in 0.2 s but `/health` (which also polls the Spark UI storage API) took 14 to 23 s, so the pass belongs to onboarding, never to a demo. The PK and FK rules hold by construction (`weather_quarter` and `station` derive from the same views; `revenue_quarter` is filtered to the seed CIKs that make up `utility`) and are checked once by `RUN DQ` at onboarding, above.

| `scripts/dq_onboard.py` run | RUN DQ coverage_ok | SHOW DQ INVALID RECORD coverage_ok | Total |
|---|---|---|---|
| Day 0 (by hand, same statements) | 361 s, 342 / 342 / 0 | 181 s, 0 rows | about 9 min |
| Day 1 (the script, `data/dq/latest.json`) | 557 s, 342 / 342 / 0 | 182 s, 0 rows | 739 s (12.3 min; other cached reads ran on the driver during the first minutes) |

### GHCN cost table (what every weather read costs on this instance)

| Read | Zetaris wall time | Spark execution | Why |
|---|---|---|---|
| `COUNT(*)` on one cached GHCN view | 8.8 to 10.8 s | about 70 ms | one filestore table resolved before execution (about 9 s each) |
| `weather_quarter` template (TMAX view JOIN TMIN view, any station list up to 40) | 17.6 to 19.0 s per (year, quarter) | about 210 ms | two filestore tables resolved |
| a cached derived view over the four views (tried, abandoned) | 109 s | 1.3 s | four tables, one more view layer |
| USL `station` (one view) | 44 to 88 s | | USL layer plus one resolution |
| USL `weather_quarter` (four views) | about 3 min | | USL layer plus four resolutions |
| `RUN DQ coverage_ok` on USL `weather_quarter` | 361 s | | the USL relation is materialised twice |
| `SHOW DQ INVALID RECORD coverage_ok` | 181 s | | one materialisation |
| `SHOW DQ ALL INVALID` (three rules) | did not return within 900 s | | one materialisation per rule, about 3 min each |
| `CACHE TABLE` of one GHCN view (after a driver restart) | 41 to 45 s | | scans the 9 parquet files of the partition on S3 |

So a question costs two `weather_quarter` calls (current and previous quarter, every station of the target and its peers in one list) of about 18 s each, and nothing else touches the GHCN side at run time. Live on Day 1 through the gateway: 2025 Q1 and 2024 Q1 for FirstEnergy's nine stations in 18.2 s and 18.2 s wall (`cache_state: hit`), coverage 1.0 at every station in both quarters.

### What the agent should know

- Peers: `frames_seeds(tag, period)` once per tag and period (about 0.2 s, at most 43 rows), pooled across the three tags with each filer's first available tag.
- Weather numbers: one `weather_quarter` call per (year, quarter) with every station the question needs (up to 40 ids, about 18 s), not one call per utility.
- DQ gate: `dq_run_coverage` (361 s) and `dq_invalid` (181 s) are onboarding or warm-up checks, bounded at 600 s, run by `scripts/dq_onboard.py` into `data/dq/latest.json`; the per-question coverage check uses the `coverage` column the `weather_quarter` template already returns (the same rule, `coverage >= 0.9`).
- The USL tables are the governed copies (keys, descriptions, DQ): `usl_revenue(cik10, period)` answers in 2 to 4 s and is the evidence-drawer read; `usl_utility(cik10)` took 45 s on Day 0 and 141 s on Day 1 (use `submission(cik10)` on the hot path); `weather_quarter` as a USL table takes about three minutes.
- `revenue_quarter.xbrl_tag` is the tag column (`tag` is a reserved word). `is_comparative` is derived from the accession number's filing year; `filed` is NULL because frames do not carry it (use `concept_history` for filing dates).

