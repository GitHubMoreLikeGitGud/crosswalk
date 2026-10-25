# C5: the deterministic key-proposal baseline

## Goal

`agent/src/tools/baselineKeys.ts` exists and is unit-tested: from the probes of the discovery loop alone (candidate key columns, their distinct counts and a few sample values), with no model, it proposes join keys in the same `{left, right, transform}` shape the planner uses. Every run measures the planner's proposals against this baseline on the same probes (how many of each side's proposals the join map verifies), so the model's one real decision is scored against the strongest rule we can write down. No model calls, no network, no database connection.

## Workspace

This repository (`agent/` is the Node 22 + TypeScript package; run commands from `agent/`). Other work may be in progress in the working tree while this task runs (for example under `agent/src/loop/`, `agent/src/zetaris/` and `gateway/`). Leave every file that is not under **Deliverables** alone, even if a check reports an error in it.

## Read first

- `AGENTS.md`, `.cursor/rules/style.mdc`, `.cursor/rules/safety.mdc`.
- `agent/src/tools/transforms.ts` and `agent/src/tools/matchRate.ts` (C1: the closed transform set, `validateProposal`, the `won` refusal).
- `agent/test/fixtures/crosswalk-discovery.json`, section `baseline` (described under **Inputs**). `agent/test/fixtures/make_discovery_fixtures.py` produced it; do not port its code, implement the rules below.

## Inputs

### Probes

`interface ProbeColumn { column: string; distinct: number | null; rows: number | null; samples: string[] }` and `interface ProbeSummary { object: string; candidates: ProbeColumn[] }`: one summary per probed object, in the order the objects were probed; `candidates` are the probe's candidate key columns with their distinct and row counts (`null` when unknown) and up to five sample values as strings (nulls dropped).

### Key class of a column

`keyClassOf(object, column)`, with `n` = the column name lower-cased with every character outside `[a-z0-9]` removed and `o` = the object name lower-cased; the first rule that applies wins:
1. `n` contains `cik` -> `cik`
2. `n` starts with `fips` -> `fips_county` if `n` contains `county`, else `fips_state`
3. `n` contains `sic` -> `sic`
4. `n` is `loc` -> `state` (a location code; the transform comes from the samples)
5. `n` is `state` or ends with `state` -> `state`
6. `n` is `code` -> `state` if `o` contains `state`, `sic` if `o` contains `sic`, else `null`
7. `n` is `id` and `o` contains `station` -> `station_id`
8. otherwise `null` (no proposal for that column).

### Transform from samples

`transformFromSamples(a, b)` returns `{ transform, side }` (`side` `"a"`, `"b"` or `null`), first rule that applies:
1. every value of `a` matches `^\d{1,9}$` and every value of `b` matches `^\d{10}$` -> `lpad10` on `a`
2. the same with `a` and `b` swapped -> `lpad10` on `b`
3. every value of `a` matches `^US-[A-Z]{2}$` and every value of `b` matches `^[A-Z]{2}$` -> `substr(4,2)` on `a`
4. the same swapped -> `substr(4,2)` on `b`
5. otherwise `identity`, side `null`.
"Every value" of an empty list is false (an empty sample never earns a transform).

### Proposals

`baselineProposals(probes, limit = 6)`:
1. Drop every probe whose object matches `/^won[_.]/i` (the sister entry's objects are never proposed).
2. For every pair of remaining probes `(A, B)` with `A` before `B` in the input and different object names, for every candidate column `a` of `A` with a non-null key class, for every candidate column `b` of `B` with the SAME key class: one proposal.
3. Orientation: with `{transform, side} = transformFromSamples(a.samples, b.samples)`, the transformed side is the left (`side` `"a"`: left `A.a`, right `B.b`; `"b"`: left `B.b`, right `A.a`). For `identity`: left is `B.b` when both distinct counts are known and `b.distinct < a.distinct`; otherwise left is `A.a`.
4. Score and reasons (in this order): `+2` and reason `"samples need <transform>"` when the transform is not `identity`; `+1` and `"same column name"` when the two normalised column names are equal; `+1` and `"right side has at least as many distinct keys"` when both distinct counts of the oriented pair are known and right >= left; `+1` and `"specific key class <class>"` when the class is one of `cik`, `station_id`, `sic`, `fips_state`, `fips_county`.
5. Sort by score descending, then by the class order `cik, station_id, sic, state, fips_state, fips_county`, then the input position of the LEFT object, then the input position of the RIGHT object, then the left column name, then the right column name (plain code-unit comparisons), and keep the first `limit`.
6. Each result is `{ left: { object, column }, right: { object, column }, transform, key_class, score, reasons }`; `left`/`right`/`transform` pass `validateProposal` from `matchRate.ts` after mapping to its flat shape (`leftObject`, `leftColumn`, `rightObject`, `rightColumn`, `transform`).

`toKeyProposal(choice)` maps one result to the flat `KeyProposal` of `matchRate.ts` (and validates it with `validateProposal`).

### Fixture `agent/test/fixtures/crosswalk-discovery.json`, section `baseline`

`synthetic: true` (made-up CIKs such as `0009000001`, made-up station ids).
- `key_class[]`: `{ object, column, expected }` (`expected` may be `null`).
- `transform[]`: `{ a, b, expected }` where `expected` is `[transform, side]`.
- `cases[]`: `{ name, probes, limit, expected }`: the demo-shaped probe set with limits 6 and 30, the same probes with every sample emptied (identity only), and a set containing a `won.` object.

## Deliverables

| File | Contents |
|---|---|
| `agent/src/tools/baselineKeys.ts` | Exports: `KEY_CLASSES` (the six classes in the sort order); `type KeyClass`; `interface ProbeColumn`; `interface ProbeSummary`; `interface KeyChoice { left: { object: string; column: string }; right: { object: string; column: string }; transform: string }`; `interface BaselineChoice extends KeyChoice { key_class: KeyClass; score: number; reasons: string[] }`; `keyClassOf(object: string, column: string): KeyClass \| null`; `transformFromSamples(a: readonly string[], b: readonly string[]): { transform: string; side: "a" \| "b" \| null }`; `baselineProposals(probes: readonly ProbeSummary[], limit?: number): BaselineChoice[]`; `toKeyProposal(choice: KeyChoice): KeyProposal` (the type from `matchRate.ts`). |
| `agent/test/baseline-keys.test.ts` | vitest suite with at least the cases below. |

### Test cases that must exist

- Every `key_class[]` and `transform[]` case reproduces (`transform` cases compared as `[transform, side]`).
- Every `cases[]` entry: `baselineProposals(probes, limit)` deep-equals `expected` (order, scores and reasons included).
- For the `demo_shape_limit_6` case every result passes `toKeyProposal` without throwing; the `won_object_refused` case names no `won.` object.
- `baselineProposals([])` is `[]`; a single probe gives `[]`.

## Constraints

- No model calls, no network, no file or database access inside the module, no new dependencies, nothing added to `package.json`. Pure functions. ES modules, TypeScript run by tsx; `node:` builtins only (the test reads the fixture with `node:fs`).
- Import from `./matchRate.ts` only what you need (`validateProposal`, the `KeyProposal` type); do not edit C1-C3 files.
- The fixture files and the generators are inputs: do not edit or regenerate them.
- Do not edit `engines/`, `gateway/`, `zetaris/`, `seeds/`, `.env.local`, `agent/package.json`, `agent/tsconfig.json`, `agent/tsconfig.tools.json`, the existing tests, or anything outside **Deliverables**.

## Checks

From `agent/`:

- `npx vitest run baseline-keys` is green.
- `npx tsc --noEmit -p tsconfig.tools.json` reports no errors in the deliverable module (errors in files outside **Deliverables**, if another task is mid-edit, are not yours to fix).

## Out of scope

Measuring the proposals (the host tool `measure_key` routes them to the gateway's join-map statements), the planner prompt, the comparison report, the catalogue search and probe heuristics (C4).

## Commit

`C5: deterministic key-proposal baseline (Cursor Agent)`

Do not commit; leave the changes in the working tree.
