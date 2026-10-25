# C1: The closed transform set and the match-rate SQL renderer

## Goal

`agent/src/tools/transforms.ts` and `agent/src/tools/matchRate.ts` exist and are unit-tested. `transforms.ts` holds the closed set of key transforms as named TypeScript functions together with the Lightning SQL expression each one renders, and a parser that turns a transform spec string (for example `substr(4,2)`) into a validated transform. `matchRate.ts` turns a join-key proposal `{leftObject, leftColumn, rightObject, rightColumn, transform}` into the two Lightning SQL statements that measure it over two cached views (distinct left keys and matched distinct keys; an orphan sample of 10), parses the gateway's result rows into a `MatchResult` with the rate and the verdict (VERIFIED at 0.95 or more, PARTIAL at 0.80 or more, REJECTED below), and holds a pure TypeScript reference implementation of the same measurement over in-memory rows (used to test the method against synthetic rows with known answers). No model calls, no network, no database connection.

## Workspace

This repository (`agent/` is the Node 22 + TypeScript package; run commands from `agent/`). Other work may be in progress in the working tree while this task runs (`gateway/`, `zetaris/`, `ui/`). Leave every file that is not under **Deliverables** alone.

## Read first

- `AGENTS.md`, `.cursor/rules/style.mdc`, `.cursor/rules/safety.mdc` and the "Writing SQL" and "Gateway contract" sections of `.cursor/rules/zetaris.mdc`.
- `agent/tsconfig.json`, `agent/tsconfig.tools.json` and `agent/package.json` (ES modules, `.ts` import extensions, `@types/node`, vitest 5, TypeScript 7).
- `agent/test/fixtures/crosswalk-transforms.json` (the fixture; described under **Inputs**) and `agent/test/fixtures/make_crosswalk_fixtures.py` (how the expected values were produced; read it to understand the fixture, do not port its code).
- `agent/src/tools/degreeDays.ts` and `agent/test/degree-days.test.ts` for the SQL-rendering and test style used here (validate first, interpolate after; plain `describe`/`it`; expected values explained in comments). Those files are inherited code and are not to be changed.

## Inputs

### The transform set (closed; implement exactly these)

Each transform maps one key value (string, number or null) to a key string or `null`. `null` in means `null` out; a `null` key is never counted. SQL expressions take the column expression `x` (an already-validated qualified column such as `l.cik`) and return a string.

| Spec | TypeScript | Lightning SQL (shape; whitespace is free) |
|---|---|---|
| `identity` | `String(v)` | `CAST(x AS STRING)` |
| `upper` | `String(v).toUpperCase()` | `UPPER(CAST(x AS STRING))` |
| `lpad10` | `String(v).padStart(10, "0")` | `LPAD(CAST(x AS STRING), 10, '0')` |
| `substr(start,len)` | `String(v).substring(start - 1, start - 1 + len)` (1-based `start`, both integers 1 or more) | `SUBSTR(CAST(x AS STRING), start, len)` |
| `strip_prefix('US-')` | the value without the prefix when it starts with it, else `null` (a non-US `loc` has no state) | `CASE WHEN CAST(x AS STRING) LIKE 'US-%' THEN SUBSTR(CAST(x AS STRING), 4) END` |
| `yyyymmdd_to_date` | `yyyy-mm-dd` from an 8-character `yyyymmdd` string | `CONCAT(SUBSTR(x, 1, 4), '-', SUBSTR(x, 5, 2), '-', SUBSTR(x, 7, 2))` |
| `iso_to_quarter` | `CY<yyyy>Q<n>` with `n = floor((month + 2) / 3)` from the first 7 characters of an ISO date or timestamp (`2025-03-18T00:00:00.000Z` -> `CY2025Q1`) | `CONCAT('CY', SUBSTR(x, 1, 4), 'Q', CAST(FLOOR((CAST(SUBSTR(x, 6, 2) AS INT) + 2) / 3) AS INT))` |

`strip_prefix` accepts only the prefix `US-` (the spec string is exactly `strip_prefix('US-')`); `substr` takes two positive integers. Anything else (`to_quarter`, `substr(0,2)`, `lower`, `substr(4, 2)` with a space, an empty string) is not a transform and is refused with a plain `Error`. The spec string of a transform is its canonical spelling as listed.

### Match rate (the method)

For a proposal, the left key of a row is `transform(leftColumn)`; rows whose key is `null` are dropped. `left_keys` = the number of distinct left keys; `matched_keys` = the number of distinct left keys that equal (string equality) some distinct value of `rightColumn` on the right side (right `null` values are ignored, right values compared as strings); `rate = matched_keys / left_keys` (0 when there are no left keys); `orphans` = the unmatched left keys sorted ascending as strings, the first 10, with `orphans_total` the full count; `verdict` = `VERIFIED` when `rate >= 0.95`, `PARTIAL` when `rate >= 0.80`, else `REJECTED`. Thresholds are exported constants.

### The two statements the renderer produces

Over two cached views, with `T(l.<leftColumn>)` the SQL of the transform:

```sql
SELECT COUNT(DISTINCT l.k) AS left_keys,
       COUNT(DISTINCT CASE WHEN r.k IS NOT NULL THEN l.k END) AS matched_keys
FROM (SELECT DISTINCT T(l.<leftColumn>) AS k FROM <leftObject> l) l
LEFT JOIN (SELECT DISTINCT CAST(r.<rightColumn> AS STRING) AS k FROM <rightObject> r) r ON r.k = l.k
```

```sql
SELECT l.k AS orphan
FROM (SELECT DISTINCT T(l.<leftColumn>) AS k FROM <leftObject> l) l
LEFT JOIN (SELECT DISTINCT CAST(r.<rightColumn> AS STRING) AS k FROM <rightObject> r) r ON r.k = l.k
WHERE r.k IS NULL AND l.k IS NOT NULL ORDER BY l.k LIMIT 10
```

Add `WHERE l.k IS NOT NULL` to the counts' left subquery as well (a `null` key is never counted). Each statement is ONE Lightning SQL statement: no semicolon anywhere, no comments. Validation before any interpolation (throw `Error` with a plain message): object names match `^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$` (a qualified `container.view` or `DATABASE.table`), column names match `^[A-Za-z_][A-Za-z0-9_]*$` and are rendered inside backticks (frames columns such as `entityName` are camel-case), the transform is from the closed set, and an object name starting with `WON_` or `won.` is refused (another project's objects on the shared instance).

### Fixture `agent/test/fixtures/crosswalk-transforms.json`

Synthetic (`"synthetic": true`). Keys:

- `thresholds`: `{verified: 0.95, partial: 0.8}`.
- `transforms`: object keyed by spec string, each an array of `{input, expected}` (inputs may be strings, integers or `null`; `expected` is a string or `null`).
- `match_rate_cases[]`: `{name, proposal{leftObject, leftColumn, rightObject, rightColumn, transform}, left_rows[], right_rows[], expected{left_keys, matched_keys, rate, orphans[], orphans_total, verdict}, note}`. Six cases: `cik_lpad10_partial` (7 keys, 6 matched, orphan `0009999999`), `loc_strip_prefix_verified` (3 keys, rate 1; `CA-ON` and `null` produce no key), `sic_identity_verified_with_orphan` (21 keys, 20 matched, orphan `4900`), `fips_identity_rejected` (5 keys, 3 matched, orphans `2` and `6`), `date_iso_to_quarter_rejected` (2 keys, 1 matched, orphan `CY2024Q4`), `state_upper_verified` (4 keys including the empty string, 3 matched, REJECTED despite its name's "verified" prefix: the expected verdict in the file is the truth).

Read it in the test with `JSON.parse(readFileSync(new URL("./fixtures/crosswalk-transforms.json", import.meta.url), "utf8"))` (no `resolveJsonModule`, no JSON imports).

## Deliverables

| File | Contents |
|---|---|
| `agent/src/tools/transforms.ts` | The transform module below. |
| `agent/src/tools/matchRate.ts` | The renderer, parser and reference implementation below. |
| `agent/test/transforms.test.ts` | vitest suite for the transforms. |
| `agent/test/match-rate.test.ts` | vitest suite for the renderer, parser and reference implementation. |

### transforms.ts

Exports (names fixed; the agent lane imports them):

- `TRANSFORM_NAMES = ["identity", "upper", "lpad10", "substr", "strip_prefix", "yyyymmdd_to_date", "iso_to_quarter"] as const` and `type TransformName`.
- `interface Transform { spec: string; name: TransformName; args: number[] | string[]; apply(v: unknown): string | null; sql(x: string): string }`.
- `parseTransform(spec: string): Transform` — accepts exactly the canonical spellings above; throws otherwise. `substr(start,len)` with integers 1 or more and no spaces; `strip_prefix('US-')` only.
- `isTransformSpec(spec: string): boolean`.
- The seven implementations as named functions as well: `identity`, `upper`, `lpad10`, `substr(start, len)` (returns a `Transform`), `stripPrefixUS`, `yyyymmddToDate`, `isoToQuarter`.

### matchRate.ts

- `VERIFIED_THRESHOLD = 0.95`, `PARTIAL_THRESHOLD = 0.8`, `ORPHAN_SAMPLE = 10`.
- `interface KeyProposal { leftObject: string; leftColumn: string; rightObject: string; rightColumn: string; transform: string }`.
- `validateProposal(p: unknown): KeyProposal` — the validation rules above; throws `Error` with a plain message.
- `matchRateSql(p: KeyProposal): { counts: string; orphans: string }` — the two statements above.
- `type Verdict = "VERIFIED" | "PARTIAL" | "REJECTED"`; `verdictFor(rate: number): Verdict`.
- `interface MatchResult { proposal: KeyProposal; left_keys: number; matched_keys: number; rate: number; orphans: string[]; orphans_total: number | null; verdict: Verdict }` (`orphans_total` is `null` when it comes from the SQL sample, since the sample is capped).
- `parseMatchRows(p: KeyProposal, countRows: Record<string, unknown>[], orphanRows: Record<string, unknown>[]): MatchResult` — from the gateway's rows (values may arrive as numbers or numeric strings; coerce with `Number`, throw on NaN, a missing column, or more than one count row); orphans are the `orphan` column as strings.
- `measureInMemory(p: KeyProposal, leftRows: Record<string, unknown>[], rightRows: Record<string, unknown>[]): MatchResult` — the reference implementation of the method over in-memory rows.

### Test cases that must exist

`agent/test/transforms.test.ts`:
- Every `transforms[spec][]` pair: `parseTransform(spec).apply(input)` equals `expected` (strict equality, `null` included).
- `parseTransform` refuses `to_quarter`, `lower`, `substr(0,2)`, `substr(4, 2)`, `substr(4)`, `strip_prefix('CA-')`, `strip_prefix(US-)`, `""`, `identity;`.
- Each transform's `sql("l.cik")` contains the expected function (`LPAD(`, `UPPER(`, `SUBSTR(`, `LIKE 'US-%'`, `CONCAT(`, `FLOOR(`) and no `;`.

`agent/test/match-rate.test.ts`:
- For every `match_rate_cases[]` entry: `measureInMemory(proposal, left_rows, right_rows)` reproduces `expected` (`left_keys`, `matched_keys`, `orphans`, `orphans_total`, `verdict` exact; `rate` within 1e-12).
- `verdictFor(0.95)` is VERIFIED, `verdictFor(0.9499)` PARTIAL, `verdictFor(0.8)` PARTIAL, `verdictFor(0.7999)` REJECTED, `verdictFor(0)` REJECTED.
- `matchRateSql` for the `cik_lpad10_partial` proposal: `counts` contains `COUNT(DISTINCT l.k) AS left_keys`, `COUNT(DISTINCT CASE WHEN r.k IS NOT NULL THEN l.k END) AS matched_keys`, `LPAD(CAST(l.\`cik\` AS STRING), 10, '0')`, `FROM cw.frames_revenues_cy2025q1 l`, `FROM cw.utility_profiles r`, `ON r.k = l.k`, and no `;`; `orphans` contains `WHERE r.k IS NULL`, `ORDER BY l.k`, `LIMIT 10`. For the `loc_strip_prefix_verified` proposal the counts statement contains `LIKE 'US-%'`.
- `validateProposal` refuses: an object without a dot, with a quote, a space or a semicolon (for example `cw.frames; DROP TABLE x`), a column with a hyphen or a quote, a transform outside the set, and the objects `won.frames_revenues_cy2025q1` and `WON_SEC.frames`.
- `parseMatchRows` accepts numbers and numeric strings (`{left_keys: "7", matched_keys: 6}`), computes `rate` 6/7 and verdict PARTIAL, lists the orphan rows, sets `orphans_total` to `null`, and throws on a missing column or two count rows.

## Constraints

- No model calls, no network, no database access, no new dependencies, nothing added to `package.json`. Pure functions. ES modules, TypeScript run by tsx; `node:` builtins only.
- Never put a credential, a `User-Agent` string or a local path in code, tests or fixtures.
- The fixture files and `make_crosswalk_fixtures.py` are inputs: do not edit them or regenerate them.
- Do not edit `engines/`, `gateway/`, `zetaris/`, `.env.local`, `agent/package.json`, `agent/tsconfig.json`, `agent/tsconfig.tools.json`, the existing tests, or anything outside **Deliverables**. (`tsconfig.tools.json` already includes `src/tools/**/*.ts`; the reviewer adds the new test files to it.)

## Checks

From `agent/`:

- `npx vitest run transforms` is green.
- `npx vitest run match-rate` is green.
- `npx tsc --noEmit -p tsconfig.tools.json` reports no errors.

## Out of scope

The gateway template or plan that runs the rendered statements (the Zetaris lane adds it), the discovery loop that calls `measure_key`, the USL renderer (C2), FEMA and station parsing (C3).

## Commit

`C1: transform set and match-rate SQL renderer (Cursor Agent)`

Do not commit; leave the changes in the working tree.
