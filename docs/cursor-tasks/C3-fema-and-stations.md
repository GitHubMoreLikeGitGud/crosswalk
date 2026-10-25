# C3: OpenFEMA declarations and the GHCN station list

## Goal

`agent/src/tools/fema.ts` and `agent/src/tools/stations.ts` exist and are unit-tested. `fema.ts` parses rows in the shape of OpenFEMA `DisasterDeclarationsSummaries` v2, keeps major disasters (`declarationType` `DR`), buckets ISO declaration dates into calendar quarters spelled like SEC frames periods (`CY2025Q1`), and counts declarations per state as DISTINCT disaster numbers by incident type (one disaster covers many county rows). `stations.ts` parses lines of NOAA's fixed-width `ghcnd-stations.txt` (id columns 1-11, latitude 13-20, longitude 22-30, elevation 32-37, state 39-40, name 42-71) and renders the Lightning SQL view text that does the same with `SUBSTR` over a one-column CSV table. No model calls, no network, no database connection.

## Workspace

This repository (`agent/` is the Node 22 + TypeScript package; run commands from `agent/`). Other work may be in progress in the working tree while this task runs. Leave every file that is not under **Deliverables** alone.

## Read first

- `AGENTS.md`, `.cursor/rules/style.mdc`, `.cursor/rules/safety.mdc`, `.cursor/rules/data-licences.mdc` and the "Writing SQL" section of `.cursor/rules/zetaris.mdc`.
- `seeds/catalogue.json` entries `openfema_disaster_declarations` and `noaa_ghcn_stations` (the shapes and traps).
- `agent/test/fixtures/crosswalk-fema.json` and `agent/test/fixtures/crosswalk-stations.json` (the fixtures; described under **Inputs**) and `agent/test/fixtures/make_crosswalk_fixtures.py` (how they were produced; do not port its code).
- `agent/src/tools/degreeDays.ts` and `agent/test/degree-days.test.ts` for the SQL-rendering and test style.

## Inputs

### FEMA rows and the method

A row has at least `disasterNumber` (integer), `state` (two letters), `fipsStateCode` (two-digit string), `fipsCountyCode`, `declarationDate` (ISO timestamp `yyyy-mm-ddThh:mm:ss.sssZ`), `incidentType`, `declarationType` (`DR` major disaster, `EM` emergency, `FM` fire management), `designatedArea`. The gateway returns such rows from the cached view (values may arrive as numbers or strings; `disasterNumber` is coerced with `Number`, the rest with `String`; a row missing `disasterNumber`, `state`, `declarationDate` or `declarationType` throws).

- `quarterOf(iso)`: from the first 7 characters `yyyy-mm`, `CY<yyyy>Q<floor((mm + 2) / 3)>`; `2025-03-31T23:59:59.000Z` is `CY2025Q1`, `2025-04-01T00:00:00.000Z` is `CY2025Q2`, `2024-12-31` is `CY2024Q4`; an input shorter than 7 characters or with a non-numeric month throws.
- `onlyMajorDisasters(rows)`: `declarationType === "DR"`.
- `declarationsByState(rows, period)`: over the DR rows whose `quarterOf(declarationDate)` equals `period`, one entry per state with `declarations` = the number of DISTINCT `disasterNumber`, `rows` = the number of county rows, `disaster_numbers` sorted ascending, `by_incident_type` = `{incidentType: distinct disaster count}` with keys sorted; entries sorted by `declarations` descending, then `state` ascending.
- `statesOutsideReference(entries, referenceCodes)`: the states of the entries that are not in the reference list (territories such as `PR` are expected orphans), sorted.
- `fromGatewayRows(rows)`: the coercion described above.

### Fixture `agent/test/fixtures/crosswalk-fema.json`

Synthetic (`"synthetic": true`): 20 rows for nine made-up disasters 9001-9009 (KY twice with two incident types, CA, OK on 31 March and on 1 April, SC in December 2024, an `EM` and an `FM` row, a `PR` row). `expected`: `rows_total` 20, `dr_rows`, `dr_disasters`, `q1_2025_dr_rows`, `q1_2025_dr_disasters`, `q1_2025_states`, `quarter_of` (every date in the file to its period), `by_state_q1_2025[]` (`{state, declarations, rows, disaster_numbers, by_incident_type}` in the sort order above), `states_outside_reference` against the five reference states `KY, CA, OK, SC, OR`.

### Station lines and the method

`ghcnd-stations.txt` is fixed width, one station per line, 85 characters: id 1-11, latitude 13-20, longitude 22-30, elevation 32-37, state 39-40, name 42-71, GSN flag 73-75, HCN/CRN flag 77-79, WMO id 81-85 (1-based, inclusive). `parseStationLine(line)` returns `{id, lat, lon, elev, state, name}` with `id = line.slice(0, 11)`, `lat = Number(line.slice(12, 20))`, `lon = Number(line.slice(21, 30))`, `elev = Number(line.slice(31, 37))`, `state = line.slice(38, 40).trim() || null` (non-US stations have no state), `name = line.slice(41, 71).trim()`; a line shorter than 71 characters, or an id not matching `^[A-Z0-9]{11}$`, or a non-numeric coordinate throws. `parseStations(text)` parses every non-empty line. `isUsStation(id)` is `id.startsWith("US")`.

`stationsViewSql(rawTable = "CW_GHCN.stations_raw", column = "line")` renders ONE statement, no semicolon:

```sql
SELECT SUBSTR(line, 1, 11) AS id,
       CAST(TRIM(SUBSTR(line, 13, 8)) AS DOUBLE) AS lat,
       CAST(TRIM(SUBSTR(line, 22, 9)) AS DOUBLE) AS lon,
       CAST(TRIM(SUBSTR(line, 32, 6)) AS DOUBLE) AS elev,
       SUBSTR(line, 39, 2) AS state,
       TRIM(SUBSTR(line, 42, 30)) AS name
FROM CW_GHCN.stations_raw
```

with `rawTable` validated against `^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$` and `column` against `^[A-Za-z_][A-Za-z0-9_]*$`; names starting with `WON_` are refused. `stationsViewSql` is the body the Zetaris lane wraps in `CREATE SCHEMASTORE VIEW stations WITH CONTAINER cw AS ...`.

### Fixture `agent/test/fixtures/crosswalk-stations.json`

Synthetic: six 85-character `lines` (two NC/GA/TX stations, a name of exactly 30 characters, a Canadian station with a blank state, a territory station `AS`, an Alaska station), `expected[]` (the parsed records in the same order), `us_station_ids`, `state_counts`, `bad_lines[]` (`{line, reason}`), `view_sql_must_contain[]`.

## Deliverables

| File | Contents |
|---|---|
| `agent/src/tools/fema.ts` | Exports: `interface FemaRow { disasterNumber: number; state: string; fipsStateCode: string | null; fipsCountyCode: string | null; declarationDate: string; incidentType: string; declarationType: string; designatedArea: string | null }`; `quarterOf(iso: string): string`; `fromGatewayRows(rows: Record<string, unknown>[]): FemaRow[]`; `onlyMajorDisasters(rows: FemaRow[]): FemaRow[]`; `interface StateDeclarations { state: string; declarations: number; rows: number; disaster_numbers: number[]; by_incident_type: Record<string, number> }`; `declarationsByState(rows: FemaRow[], period: string): StateDeclarations[]`; `statesOutsideReference(entries: StateDeclarations[], referenceCodes: string[]): string[]`. |
| `agent/src/tools/stations.ts` | Exports: `STATION_COLUMNS` (the 1-based column spans), `interface Station { id: string; lat: number; lon: number; elev: number; state: string | null; name: string }`; `parseStationLine(line: string): Station`; `parseStations(text: string): Station[]`; `isUsStation(id: string): boolean`; `stationsViewSql(rawTable?: string, column?: string): string`. |
| `agent/test/fema.test.ts` | vitest suite with at least the cases below. |
| `agent/test/stations.test.ts` | vitest suite with at least the cases below. |

### Test cases that must exist

`fema.test.ts`:
- `quarterOf` reproduces every entry of `expected.quarter_of`; the boundary pairs (31 March / 1 April, 31 December) are asserted explicitly; `quarterOf("2025")` and `quarterOf("2025-xx-01")` throw.
- `onlyMajorDisasters(fromGatewayRows(rows))` has `expected.dr_rows` rows and `expected.dr_disasters` distinct disaster numbers.
- `declarationsByState(rows, "CY2025Q1")` equals `expected.by_state_q1_2025` (deep equality, order included); the sum of `rows` equals `expected.q1_2025_dr_rows`; the states equal `expected.q1_2025_states` when sorted.
- `statesOutsideReference` against `["KY", "CA", "OK", "SC", "OR"]` equals `expected.states_outside_reference`.
- `fromGatewayRows` accepts `disasterNumber` as the string `"9001"` and throws on a row without `declarationType`.
- A KY disaster counted once although it has five county rows (assert `declarations` 2 and `rows` 8 for KY from the fixture's expected entry rather than by hand-typed numbers).

`stations.test.ts`:
- Every `lines[i]` parses to `expected[i]` (numbers within 1e-9; `state` `null` for the Canadian line; the 30-character name intact).
- `parseStations(lines.join("\n") + "\n")` returns six records; `us_station_ids` and `state_counts` reproduce.
- Every `bad_lines[].line` throws.
- `stationsViewSql()` contains every string in `view_sql_must_contain` and no `;`; `stationsViewSql("CW_GHCN.stations_2026", "txt")` uses both names; `stationsViewSql("WON_GHCN.stations_raw")`, `stationsViewSql("stations_raw")` and `stationsViewSql("CW_GHCN.x; DROP")` throw.

## Constraints

- No model calls, no network, no database access, no new dependencies, nothing added to `package.json`. Pure functions. ES modules, TypeScript run by tsx; `node:` builtins only.
- Never put a credential, a `User-Agent` string or a local path in code, tests or fixtures. Never add real FEMA rows or real station lines: the fixtures are synthetic.
- The fixture files and `make_crosswalk_fixtures.py` are inputs: do not edit them or regenerate them.
- Do not edit `engines/`, `gateway/`, `zetaris/`, `.env.local`, `agent/package.json`, `agent/tsconfig.json`, `agent/tsconfig.tools.json`, the existing tests, or anything outside **Deliverables**.

## Checks

From `agent/`:

- `npx vitest run fema` is green.
- `npx vitest run stations` is green.
- `npx tsc --noEmit -p tsconfig.tools.json` reports no errors.

## Out of scope

Registering the FEMA REST table or the station CSV in Zetaris (the Zetaris lane), the `$filter` URL (in `seeds/catalogue.json`), the weather and revenue parts of the answer, the match-rate renderer (C1), the USL renderer (C2).

## Commit

`C3: FEMA declarations and GHCN station parsers (Cursor Agent)`

Do not commit; leave the changes in the working tree.

## Run record

- Run 2026-10-25, Cursor Agent CLI 2026.10.22-27dcf5f (model Auto), headless with the prompt from `README.md`: 289.3 s wall, exit 0, no commit (as asked), only the four deliverables added. Cursor reported `npx vitest run fema` 9 and `npx vitest run stations` 7 passed and the tools type-check clean, and noted that it had dropped `TRIM(...)` from the name column of `stationsViewSql` because the fixture's `view_sql_must_contain` asked for the bare `SUBSTR(line, 42, 30) AS name`.
- Reviewed by hand against this file; checks re-run: 16 passed, tsc exit 0. Committed unchanged as `2a8c52b` (`C3: FEMA declarations and GHCN station parsers (Cursor Agent)`).
- Corrected in `5237c2a` (`C3 review`): the fixture fragment was the defect, not the task text, so the generator now expects `TRIM(SUBSTR(line, 42, 30)) AS name` (regenerated, one line changed) and the view trims the name as `parseStationLine` does; a blank coordinate field throws (`Number("        ")` is 0, while `CAST(TRIM('') AS DOUBLE)` is NULL in SQL); `quarterOf` throws on a month outside 1 to 12; the `WON_` refusal is case-insensitive and also covers the `won` container; the two test files added to `tsconfig.tools.json`. After: 21 passed, tsc exit 0.
