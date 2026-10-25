# C7: the join map screen

## Goal

`ui/views/joinmap.js` renders the Join map screen of the analyst UI from `GET /api/joinmap/<run>`: a summary of the verdicts and of who proposed the keys (the model against the name-match baseline), a small graph of the tables and the keys between them, and a table with one row per key (left and right column, transform in plain words, the rate over rows and the distinct rate, the verdict colour with its plain-word definition beside it, orphans, where the numbers come from, and the SQL behind a toggle). Its pure render functions are tested with Node's built-in test runner on fixtures built from the server's own view code.

## Workspace

This repository. The UI is plain ES modules served as static files by `agent/src/server.ts`; there is no build step and no framework. Other work is in progress in the working tree while this task runs (`ui/app.js`, `ui/lib.js`, `ui/index.html`, `ui/styles.css`, the other files under `ui/views/`, `agent/src/eval/`, `docs/eval*`). Leave every file that is not under **Deliverables** alone, even if a check reports an error in it.

## Read first

- `AGENTS.md`, `.cursor/rules/style.mdc`, `.cursor/rules/safety.mdc`.
- `agent/src/ops/joinmap.ts`: how the server builds the payload (canonical orientation, both rates, the verdict definitions with the code's thresholds, recalled vs measured).
- `ui/lib.js`: use only its exports `esc` (escapes text and attribute values; every value from the payload goes through it) and `api` (`await api(path)` resolves to `{ ok, status, data }`). Do not edit `ui/lib.js`.
- `ui/styles.css`: the colour tokens (`--good`, `--good-bg`, `--good-edge`, `--mid*`, `--bad*`, `--neutral*`, `--memory*`, `--model*`, `--ink`, `--ink-2`, `--ink-3`, `--rule`, `--surface`, `--surface-2`, `--code-bg`, `--font-mono`, `--font-serif`, `--r`) and the existing classes `panel`, `panel__h`, `view-h`, `table-wrap`, `chip chip--good|mid|bad|neutral`, `muted`, `small`, `tnum`. Do not edit `ui/styles.css`.

## Inputs

### The payload

`ui/test/fixtures/joinmap-cold.json` (a cold run: every key measured in the run) and `ui/test/fixtures/joinmap-warm.json` (a warm run: five keys recalled from memory, two measured). Both were written by `ui/test/make_ui_fixtures.ts` through the server's `joinMapView`; do not edit or regenerate them. Fields used:

- `counts {keys, verified, partial, rejected, other, measured_in_run, recalled}`.
- `proposals {model, baseline}`, each `null` or `{proposed_by, made, valid, verified, partial, rejected, invalid_schema, unmeasurable}`.
- `definitions {VERIFIED, PARTIAL, REJECTED, rate, rate_distinct, orphan, left, recalled, measured}`: plain-word text from the server. Show it; never write your own definition of a verdict.
- `rows[]`: `{id, key, label, left {object, column, ref}, right {object, column, ref}, transform, transform_applies_to ("left" | "right" | "both" | null), orientation, proposed_by (string[]), status, verdict ("VERIFIED" | "PARTIAL" | "REJECTED" | other or null), verdict_definition, rate, matched_rows, left_rows, rate_distinct, matched_keys, left_keys, orphans (string[]), recalled (boolean), memory_id, measured_as, provenance, sql, sql_orphans, elapsed_ms}`. Any of the numbers may be `null`.

### Rules for the words on screen

- Row number: rows keep payload order and are numbered 1..n; the same number labels the row's edge in the graph.
- Verdict class: `VERIFIED` -> `good`, `PARTIAL` -> `mid`, `REJECTED` -> `bad`, anything else -> `neutral`. The verdict is always a word in a chip, never colour alone, and the row's `verdict_definition` (else `definitions[verdict]`) is printed next to it.
- Rate over rows: `"<matched_rows> of <left_rows> rows (<rate as a percentage with one decimal>)"`, e.g. `42 of 43 rows (97.7%)`; distinct rate: `"<matched_keys> of <left_keys> distinct values (<pct>)"`. A null count gives `not measured`. Percentages: `(x * 100).toFixed(1) + "%"`.
- Transform words (`transformWords(t)`): `identity` -> `as is`; `upper` -> `upper-cased`; `lpad10` -> `padded to 10 digits with leading zeros`; `substr(s,l)` -> `characters s to s+l-1` (e.g. `substr(4,2)` -> `characters 4 to 5`); `strip_prefix` or `strip_prefix(...)` -> `prefix removed`; `yyyymmdd_to_date` -> `read as a date`; `iso_to_quarter` -> `bucketed to a calendar quarter`; anything else -> the name itself. Show the transform name in monospace with the words beside it, and, when `transform_applies_to` is `left` or `right`, `on the left column` / `on the right column`.
- Proposer words (`proposerWords(list)`): `planner` -> `the model`; `baseline` and `baseline (queue)` -> `name-match baseline`; `control` -> `control (deliberately without the transform)`; others as written; duplicates removed, joined with `, `.
- Provenance: `recalled === true` -> `Recalled from memory` (with `definitions.recalled` as the explanation); else `Measured in this run` plus `in <elapsed_ms> ms` (or `in <s> s` with one decimal at 1000 ms and above) when elapsed_ms is a number.
- Orphans: up to 10 listed (monospace); none -> `none`. Beside them the definition `definitions.orphan` once in the table header's help line, not per row.
- SQL: a `<details>` element per row whose `<summary>` reads `SQL`; inside, `sql` in a `<pre><code>` and, when present, `sql_orphans` under the line `Orphans listed by:`. Closed by default.
- Engineering ids: the row `id`, the `key` route, `memory_id` and `measured_as` are engineering detail. Wrap each in an element with class `eng` (the shell hides `.eng` unless the analyst turns on "Show engineering detail"). No other text is hidden.

### The summary

- One sentence: `<keys> keys: <verified> VERIFIED, <partial> PARTIAL, <rejected> REJECTED` (plus `, <other> other` when other > 0), then `<measured_in_run> measured in this run, <recalled> recalled from memory`.
- A small table "Who proposed the keys" with columns `Proposer`, `Made`, `Valid`, `VERIFIED`, `PARTIAL`, `REJECTED`, `Unmeasurable` and rows `The model (NVIDIA Nemotron 3 Nano 4B)` and `Name-match baseline (no model)`; a null side shows `not recorded` across. Under it one line: `Both sides propose from the same probed columns; every proposal is measured by the same Lightning SQL statement.`

### The graph

`renderJoinGraph(data)` returns an inline `<svg>` with `viewBox="0 0 960 400"`, `role="img"` and an `aria-label` that lists every key in words (`1: <left ref> to <right ref>, <verdict>; 2: ...`). Nodes are the distinct objects (`left.object` and `right.object`) in order of first appearance, placed evenly on an ellipse centred at (480, 200) with radii 360 and 150, starting at the top and going clockwise; each node is a rounded rectangle with the object name (drop a leading `cw.`) in 13 px text, wide enough for its text (8 px per character + 20 px). Each key is a straight line between its two node centres drawn before the nodes (so nodes sit on top), stroke by verdict class (`var(--good-edge)`, `var(--mid-edge)`, `var(--bad-edge)`, `var(--neutral-edge)`), width 2.5, dashed (`6 4`) when REJECTED; at the line's midpoint a small circle (r 11) with the row number. Two keys between the same pair of objects are offset so their numbers do not overlap (shift the second midpoint label 24 px along the line, the third 48 px, and so on). Below the svg a legend: the three verdict colours with their words.

### Layout and classes

The screen is one `<section class="jm">`: `<h1 class="view-h">Join map</h1>` with a one-line subtitle (`Which columns join which, measured in Lightning SQL over cached views.`), then `.panel` blocks: summary, graph, the table (inside `.table-wrap`), and a definitions list (`<dl>`) with every entry of `definitions`. Classes for the CSS file: prefix `jm-` (for example `jm-table`, `jm-rate`, `jm-def`, `jm-orphans`, `jm-graph`, `jm-legend`). The table must fit 1366 px wide without the page scrolling sideways: let long refs and SQL wrap (`overflow-wrap: anywhere` on refs, `white-space: pre-wrap` on SQL), keep the definition text at 12.5 px.

## Deliverables

| File | Contents |
|---|---|
| `ui/views/joinmap.js` | ES module. Exports `transformWords(t)`, `proposerWords(list)`, `verdictClass(v)`, `rateText(matched, total, rate, unit)` (unit `rows` or `distinct values`), `renderSummary(data)`, `renderJoinGraph(data)`, `renderJoinTable(data)`, `renderJoinMap(data)` (the whole section), and `mount(el, ctx)`: `ctx.run` is a run id string; it sets `el.innerHTML` to a loading line, fetches `/api/joinmap/<ctx.run>` with `api`, renders `renderJoinMap(data)` or an error line (`<p class="msg msg--error" role="alert">` with the server's `error` text) and returns a cleanup function. Calls `ctx.setTitle?.("Join map")`. No DOM access at import time (the tests import it in Node). |
| `ui/views/joinmap.css` | The styles for the `jm-` classes, using only the tokens above (the shell links this file). |
| `ui/test/joinmap.test.mjs` | `node:test` + `node:assert/strict` suite (no dependencies) with at least the cases below. |

### Test cases that must exist

- `transformWords`: every rule above, including `substr(4,2)` and an unknown name.
- `proposerWords`: `["planner", "baseline (queue)", "baseline"]` -> `the model, name-match baseline`.
- `rateText(42, 43, 42/43, "rows")` -> `42 of 43 rows (97.7%)`; null counts -> `not measured`.
- Cold fixture: `renderJoinTable` has exactly `counts.keys` body rows; every row shows its verdict word and its definition text; the PARTIAL row lists its orphan; every row has a closed `<details>` whose `<pre>` contains the row's SQL (escaped); the sum of VERIFIED/PARTIAL/REJECTED chips equals the counts.
- Warm fixture: the recalled rows say `Recalled from memory` and their memory id is inside an element with class `eng`; the measured rows say `Measured in this run`.
- `renderJoinGraph`: one `<line` per key, one node per distinct object, REJECTED lines dashed, the aria-label names every key.
- `renderSummary`: the counts sentence for both fixtures and the two proposer rows with their numbers.
- Escaping: a row whose label and orphans contain `<script>` renders no raw `<script` tag.
- Engineering ids: no row `id` or `key` route appears in the output outside an element with class `eng`.

## Constraints

- No dependencies, no build step, no framework, nothing added to any `package.json`. Plain ES modules; `node:` builtins only in the test.
- Every payload value goes through `esc`. No `innerHTML` with unescaped data, no inline event handlers, no external fonts or scripts.
- Do not edit `ui/lib.js`, `ui/app.js`, `ui/index.html`, `ui/styles.css`, any other view, the fixtures or their generator, anything under `agent/`, `gateway/`, `engines/`, `zetaris/`, `seeds/`, `.env.local`, or anything outside **Deliverables**.

## Checks

From the repository root:

- `node --test ui/test/joinmap.test.mjs` is green.
- `node -e "import('./ui/views/joinmap.js').then(m => console.log(Object.keys(m).sort().join(',')))"` prints the exports and does not throw.

## Out of scope

The shell (routing, the run picker, the REPLAY/LIVE banner, the engineering toggle, the footer), the other screens, the provenance drawer, any server route, the CSS of anything outside `jm-`.

## Commit

`C7: join map screen (Cursor Agent)`

Do not commit; leave the changes in the working tree.

## Run record

- Run 2026-10-25 16:09:50 SGT, Cursor Agent CLI (model Auto): 234.7 s wall, exit 0, no commit (as asked), only the three deliverables added. Cursor reported `node --test ui/test/joinmap.test.mjs` 10 of 10 passed and the export check printing `mount,proposerWords,rateText,renderJoinGraph,renderJoinMap,renderJoinTable,renderSummary,transformWords,verdictClass`.
- Reviewed by hand against this file (transform words, proposer words, rate text, verdict class and the definition beside every chip, provenance words, the SQL toggle, the `eng` wrapping of row ids, key routes, memory ids and `measured_as`, the ellipse layout and the label offsets, escaping) and in the browser on the saved cold and warm runs at 1920x1080 and 1366x768 (no horizontal scroll, no engineering id visible with the toggle off). Checks re-run: 10 passed. Committed unchanged as `d9c00d8` (`C7: join map screen (Cursor Agent)`).
- Review correction (`d9901e9`, `C7 review: ...`): on the real cold run three keys join the same two tables (cik, loc and the no-pad control), and their lines were drawn on top of each other, so a dashed REJECTED line hid under a VERIFIED one; each further key between the same pair is now offset 7 px perpendicular to the line (its number moves with it). Orphans wrap inline instead of one per line (ten CIKs made rows 220 px tall), and the generic `left ~ right under transform` label is not repeated under the two columns it already names. One test added; `node --test ui/test/joinmap.test.mjs` 11 passed.
- Used by the host: `ui/app.js` mounts it as the Join map screen with the run picked in the top bar; `ui/index.html` links `views/joinmap.css`.
