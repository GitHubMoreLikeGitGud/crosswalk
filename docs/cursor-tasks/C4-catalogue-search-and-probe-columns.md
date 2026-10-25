# C4: catalogue search ranking and the probe's candidate key columns

## Goal

`agent/src/tools/catalogueSearch.ts` and `agent/src/tools/probeHeuristic.ts` exist and are unit-tested. `catalogueSearch.ts` turns the three discovery catalogues (the committed `seeds/catalogue.json`, the registered objects of `zetaris/manifest.json` and the rows of the cached OpenFEMA dataset catalogue `cw.fema_catalogue`, plus the optional getting-started manifest) into one list of entries and ranks them for a query by simple token overlap, flagging `known_to_fail` entries as negative memories. `probeHeuristic.ts` picks at most three candidate join-key columns of a described object from the column names alone. Both are the deterministic cores of the discovery tools `search_catalogue(query)` and `probe_source(object)`; no model calls, no network, no database connection.

## Workspace

This repository (`agent/` is the Node 22 + TypeScript package; run commands from `agent/`). Other work may be in progress in the working tree while this task runs (for example under `agent/src/loop/`, `agent/src/zetaris/` and `gateway/`). Leave every file that is not under **Deliverables** alone, even if a check reports an error in it.

## Read first

- `AGENTS.md`, `.cursor/rules/style.mdc`, `.cursor/rules/safety.mdc`.
- `seeds/catalogue.json` (field meanings under `fields`) and `zetaris/manifest.json` (the `sources[].objects` shapes).
- `agent/test/fixtures/crosswalk-discovery.json`, sections `search` and `probe` (described under **Inputs**), and `agent/test/fixtures/make_crosswalk_fixtures.py` for the fixture style. `agent/test/fixtures/make_discovery_fixtures.py` produced the fixture; do not port its code, implement the rules below.
- `agent/src/tools/fema.ts` and `agent/test/fema.test.ts` for the module and test style.

## Inputs

### Entries

One entry shape for every source: `{ id: string; kind: string; object: string | null; status: string; licence: string; note: string }`.

- `entriesFromCatalogue(catalogue)`: one entry per `catalogue.entries[]` item: `id`, `kind`, `status`, `licence` (empty string when absent), `note` (empty string when absent), and `object` from `zetaris_object`: absent or blank gives `null`; otherwise take the text after the first `->` when the text contains `->` (else the whole text), trim it, and keep everything up to the first whitespace. `"CW_FEMA.declarations_dr_2025q1 -> cw.fema_declarations_dr_2025q1 (cached; ...)"` gives `cw.fema_declarations_dr_2025q1`; `"lightning.metastore.crosswalk.crosswalk_usl (7 tables, ...)"` gives `lightning.metastore.crosswalk.crosswalk_usl`.
- `entriesFromManifest(manifest)`: for each `manifest.sources[]` item, collect the object names from `objects`, in this key order: `views` (array), `view` (string), `frames` (array), `submission` (array), `usl` (string); non-strings are skipped. If there is at least one name, one entry per name with `id` `"<source id>:<name>"`, `object` the name; otherwise one entry with `id` the source id and `object` `null`. Every entry from the manifest has `kind` `"registered_view"`, `status` the source's `status`, `licence` `""`, `note` the source's `summary`.
- `entriesFromGettingStarted(manifest)`: the getting-started manifest has the same `sources[]` shape: one entry per source with `id` `"gs:<source id>"`, `kind` the source's `kind`, `object` `null`, `status` the source's `status`, `licence` `""`, `note` the source's `summary`. (No per-object expansion.)
- `entriesFromFemaCatalogue(rows)`: rows of `cw.fema_catalogue` (`name`, `version`, `title`, `api_endpoint`, `last_dataset_refresh`; values may arrive as numbers or strings): `id` `"openfema:<name>@v<version>"`, `kind` `"openfema_dataset"`, `object` `null`, `status` `"listed"`, `licence` `""`, `note` = the title, followed by one space and the `api_endpoint` when the endpoint is non-empty (the result trimmed).

### Tokens and ranking

- `tokenize(text)`: (1) insert a space between a lower-case letter or digit and a following upper-case letter (`DisasterDeclarationsSummaries` -> `Disaster Declarations Summaries`); (2) lower-case; (3) split on every run of characters outside `[a-z0-9]`; (4) drop tokens shorter than 2 characters and the stopwords `a an the of in on and or for to by with what which did do does their that this is are was were how at from as it its per`; (5) stem: a token ending in `ies` and longer than 4 characters becomes the token without `ies` plus `y`; otherwise a token ending in `s` (but not `ss`) and longer than 3 characters loses the final `s`; (6) keep the first occurrence of each token, in order. `tokenize("the FEMA's Q1-2025 DR filter")` is `["fema", "q1", "2025", "dr", "filter"]`.
- An entry's token set is `tokenize` of its `id`, `kind`, `object` (empty string when `null`) and `note` joined with single spaces.
- `searchCatalogue(query, entries, limit = 8)`: the query tokens are `tokenize(query)`; an entry's `score` is the number of query tokens in its token set; entries with score 0 are dropped. Each hit is the entry with `note` cut to its first 200 characters, plus `score` and `negative` (`true` exactly when `status` is `known_to_fail`). Sort by score descending, then by status rank (`verified` 0, `listed` 1, `unverified` 2, `deprecated` 3, `known_to_fail` 4, anything else 5), then by `id` ascending (plain code-unit comparison, not locale), and keep the first `limit`. Returns `{ hits }`. Negative entries stay in the ranking: the flag is the negative memory, the caller tells the model never to propose them.

### Candidate key columns

`candidateKeyColumns(columns, limit = 3)` over the DESCRIBE result `[{ name, type }]`:
- skip a column whose type, lower-cased and cut at the first `(`, is `double`, `float` or `decimal`;
- normalise a name: lower-case, then remove every character outside `[a-z0-9]` (`disaster_number` -> `disasternumber`, `CIK` -> `cik`);
- the patterns, in priority order: `cik, state, id, code, fips, disasternumber, sic, loc, period`;
- tier 0: the normalised name equals a pattern (take the first such pattern); otherwise tier 1: the normalised name starts with or ends with a pattern (the first pattern in priority order that does); otherwise the column is not a candidate;
- sort candidates by tier, then pattern index, then the column's position in the input; return the first `limit` original column names.

`fips_state_code` is tier 1 with pattern `code` (`cik`, `state` and `id` neither start nor end `fipsstatecode`; `code` ends it, and `code` comes before `fips` in the priority order), so for the FEMA view the result is `["state", "disaster_number", "fips_state_code"]`.

### Fixture `agent/test/fixtures/crosswalk-discovery.json`

`synthetic: true` (the catalogue and manifest inside are copies of the committed files; every other value is made up).
- `search.inputs`: `catalogue`, `manifest`, `fema_catalogue_rows`, `getting_started`.
- `search.entries`: the expected concatenation `entriesFromCatalogue(catalogue)`, then `entriesFromManifest(manifest)`, then `entriesFromFemaCatalogue(fema_catalogue_rows)`, then `entriesFromGettingStarted(getting_started)`.
- `search.tokenize[]`: `{ text, expected }`.
- `search.cases[]`: `{ query, limit, expected }` where `expected` is the hit list.
- `probe.cases[]`: `{ object, columns, expected, expected_max_2 }` (`expected` with the default limit 3, `expected_max_2` with limit 2).

## Deliverables

| File | Contents |
|---|---|
| `agent/src/tools/catalogueSearch.ts` | Exports: `interface CatalogueEntry { id: string; kind: string; object: string \| null; status: string; licence: string; note: string }`; `interface CatalogueHit extends CatalogueEntry { score: number; negative: boolean }`; `STOPWORDS` (readonly string array); `tokenize(text: string): string[]`; `objectOf(zetarisObject: unknown): string \| null`; `entriesFromCatalogue(catalogue: unknown): CatalogueEntry[]`; `entriesFromManifest(manifest: unknown): CatalogueEntry[]`; `entriesFromGettingStarted(manifest: unknown): CatalogueEntry[]`; `entriesFromFemaCatalogue(rows: Record<string, unknown>[]): CatalogueEntry[]`; `searchCatalogue(query: string, entries: readonly CatalogueEntry[], limit?: number): { hits: CatalogueHit[] }`. A malformed input (not an object, `entries` or `sources` not an array, an entry without a string `id`) throws an `Error`. |
| `agent/src/tools/probeHeuristic.ts` | Exports: `KEY_PATTERNS` (the nine patterns in order); `interface DescribedColumn { name: string; type: string }`; `normaliseColumnName(name: string): string`; `candidateKeyColumns(columns: readonly DescribedColumn[], limit?: number): string[]`. |
| `agent/test/catalogue-search.test.ts` | vitest suite with at least the cases below. |
| `agent/test/probe-heuristic.test.ts` | vitest suite with at least the cases below. |

### Test cases that must exist

`catalogue-search.test.ts`:
- Every `search.tokenize[]` case reproduces.
- The four builders over `search.inputs` concatenated in the order above deep-equal `search.entries`.
- Every `search.cases[]` case: `searchCatalogue(query, search.entries, limit).hits` deep-equals `expected` (order included).
- The `pudl` hits are `negative: true` and `status: "known_to_fail"`; a query with no overlapping token returns `{ hits: [] }`.
- `objectOf` on the two examples above, on `undefined` and on `"   "`.
- `entriesFromCatalogue({})` and `entriesFromManifest({ sources: "x" })` throw.

`probe-heuristic.test.ts`:
- Every `probe.cases[]` case reproduces `expected` with the default limit and `expected_max_2` with limit 2.
- A `double` column named `cik_double` is never a candidate; an empty column list gives `[]`.

## Constraints

- No model calls, no network, no file or database access inside the two modules (the caller reads the files and passes the parsed JSON), no new dependencies, nothing added to `package.json`. Pure functions. ES modules, TypeScript run by tsx; `node:` builtins only (tests read the fixture with `node:fs`).
- Never put a credential, a `User-Agent` string or a local path in code or tests.
- The fixture files and the generators are inputs: do not edit or regenerate them.
- Do not edit `engines/`, `gateway/`, `zetaris/`, `seeds/`, `.env.local`, `agent/package.json`, `agent/tsconfig.json`, `agent/tsconfig.tools.json`, the existing tests, or anything outside **Deliverables**.

## Checks

From `agent/`:

- `npx vitest run catalogue-search` is green.
- `npx vitest run probe-heuristic` is green.
- `npx tsc --noEmit -p tsconfig.tools.json` reports no errors in the two deliverable modules (errors in files outside **Deliverables**, if another task is mid-edit, are not yours to fix).

## Out of scope

Calling the gateway (`catalogue_list`, `describe_object`, `sample_rows`, `distinct_counts` are wired by the host tool in `agent/src/tools/discovery.ts`), the key-proposal baseline (C5), the match-rate renderer (C1), memory seeding of the negative entries.

## Commit

`C4: catalogue search ranking and probe key columns (Cursor Agent)`

Do not commit; leave the changes in the working tree.
