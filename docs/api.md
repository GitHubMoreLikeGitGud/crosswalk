# Crosswalk HTTP API

The agent server (`agent/src/server.ts`, `cd agent && npm run dev`) serves the analyst UI and this API on `127.0.0.1:8804` (`UI_PORT`). It is the contract the UI is built on; the UI uses nothing else. All responses are JSON unless noted, every error is `{error, code}` with an HTTP status, and every response carries `cache-control: no-store` and `x-content-type-options: nosniff`. Times are ISO 8601 UTC, with an `_sgt` twin (Singapore time) wherever a screen shows the time.

Example payloads below are shapes, not data: the field values come from the synthetic UI fixtures in `ui/test/fixtures/` (built by `ui/test/make_ui_fixtures.ts` with the server's own view functions from redacted saved runs: revenue values and accession numbers are replaced).

## Safety rules (every route)

| Rule | Behaviour |
|---|---|
| Loopback only | The server listens on `127.0.0.1`; `listen()` refuses any other host. |
| Host check (DNS rebinding) | `Host` must be `127.0.0.1:<port>` or `localhost:<port>`, else `421 {code: "host"}`. |
| CORS closed | No `Access-Control-*` header is ever sent. A foreign `Origin` (including `null`) or `Sec-Fetch-Site: cross-site` gives `403 {code: "origin"}` on any method; `OPTIONS` gives `405`. |
| Writes | The only write is `POST /api/ask`. It needs `content-type: application/json` (`415` otherwise), a JSON object body (`400 bad_json`) of at most 256 KiB (`413`). |
| Id grammar | Run ids `r<yyyymmdd>T<hhmmss><4 hex>`, memory ids `mem-<n>`, CIKs of 1 to 10 digits and cell ids (below) are checked before any lookup (`400 bad_id`). |
| Static files | Served from `ui/` only; parent segments, drive or scheme separators, backslashes, NUL and network paths give `403`. |
| One job at a time | The server holds `<data>/agent.lock` for its lifetime and runs one model job at a time (`409 busy`). |
| Unknown routes | `/api/...` with GET or POST gives `404 not_found`; other methods `405`. |

## Routes

| Method and path | Returns |
|---|---|
| `GET /api/health` | `{ok, service: "crosswalk-agent", model, gateway, gateway_ok, gateway_templates, gateway_error, runs, data_dir, dq_file, usl_plan, ui, busy_run_id, sse_listeners}`. `gateway_ok` is false when the gateway on `GATEWAY_URL` does not answer; the server still serves saved runs. |
| `POST /api/ask` | Body `{quarter: "CY2025Q1", mode?: "cold" \| "warm", max_chunks?: 1-12, think?: boolean}`; `quarter` must match `^CY\d{4}Q[1-4]$`; `mode` defaults to warm (a warm run recalls VERIFIED keys once any is remembered). `202 {run_id, quarter, mode, started_at, started_at_sgt, state: "running", events: "/api/runs/<id>/events"}`, or `409 {code: "busy", busy_run_id}` while a run is in progress. The run then publishes `run_started`, chunk, planner and tool events, and `run_finished` (or `run_failed`). |
| `GET /api/events` | Server-sent events: every live event of every run. `Last-Event-ID` or `?since=<id>` replays the in-memory ring. |
| `GET /api/runs` | `{runs: [...], running, busy_run_id}`: saved runs newest first (`run_id, quarter, mode, started_at, started_at_sgt, wall_s, ...`), plus the run in progress. |
| `GET /api/runs/:id` | The saved `run.json` (chain, tool calls with SQL and ms, join map, model and baseline proposals, verdict mix, registrations, USL result, answer with provenance, note, Not-tested list, telemetry). `?slim=1` leaves out `evidence`, `planner_calls`, `tool_calls` and `tool_calls_detail`. A run still in progress answers `202 {run_id, state: "running", events}`. |
| `GET /api/runs/:id/events` | Server-sent events of one run: live while it runs, else replayed from `run.json`. A replay starts with `event: stream` `{run_id, mode: "replay", replay: true, events: <n>}`; every event carries `replay: true` and an `id` from 1, so `Last-Event-ID` resumes. `?delay_ms=0-2000` paces the replay (`400` outside the range). Event types: `run_started`, `chunk_start`, `planner`, `tool`, `chunk_end`, `run_finished` (live runs also `run_failed`). |
| `GET /api/runs/:id/telemetry` | The footer: `{run_id, quarter, mode, started_at, started_at_sgt, chunks, max_chunks, skipped_chunks, skipped_note, tokens {planner_in, planner_out, memo_in, memo_out, total}, tokens_per_s {planner_median, memo}, wall_ms, wall_s, model, think, planner_calls, planner_valid, fallback_steps, cloud_model_calls, labels}`. |
| `GET /api/runs/:id/memo.md` | `text/markdown`: the note, the join map (canonical orientation), the answer, the cited claims, the Not-tested list and a citations table (evidence id, kind, template, Zetaris object, endpoint, retrieval time in SGT, latency, SQL sha256), then the licences of the sources read. |
| `GET /api/runs/:id/evidence` | `{run_id, records: [...]}`: every evidence record of the run (SQL text and sha256, template and parameters, Zetaris object, rows, ms, cache state, source endpoint, licence, retrieval time). |
| `GET /api/telemetry` | `{model, runs, busy_run_id, latest}`: the footer of the newest saved run. |
| `GET /api/joinmap/:run` | `{run_id, quarter, mode, rows, counts, proposals, definitions}`. Each row is in the canonical orientation (left = the table whose rows are counted): `{id, key, cell, label, left {object, column, ref}, right {...}, transform, orientation, proposed_by, status, verdict, verdict_definition, rate, matched_rows, left_rows, rate_distinct, matched_keys, left_keys, orphans, recalled, memory_id, measured_as, provenance, sql, sql_orphans, elapsed_ms}`. `counts` = `{keys, verified, partial, rejected, other, measured_in_run, recalled}`; `proposals` = the model's and the baseline's `{made, verified, partial, rejected, invalid_schema, unmeasurable, keys, choices}`; `definitions` holds the plain-word text of VERIFIED, PARTIAL, REJECTED, rate, rate_distinct, orphan, left, recalled and measured that the screen prints. |
| `GET /api/answer/:run` | `{run_id, quarter, previous, weather_status, answered, rows, not_tested, definitions}`. A row: `{cik, name, ticker, states [{state, declarations, by_incident_type}], declarations, by_incident_type, revenue {tag, current, previous, change, note}, weather {stations, tdd_current, tdd_previous, change}, weather_note, cells {declarations, revenue_current, revenue_previous, revenue_change, weather_current, weather_previous, weather_change}}`; each `cells` value is the cell id for the drawer. |
| `GET /api/evidence/:run/:cell` | The provenance drawer of one cell: `{run_id, cell, kind, subject, field, label, value, derivation, statements: [{evidence_id, template, params, sql, sql_sha256, zetaris_object, zetaris_objects, source_url, licence, columns, rows, row_count, rows_in_run, rows_truncated, elapsed_ms, executed_at, executed_at_sgt, cache_state, source_cached_at, source_cached_at_sgt, note}], cell_rows_complete, missing}`. `404` if the run has no such cell. |
| `GET /api/usl` | `{usl, namespace, qualified, description, tables, fks, erd {nodes, edges}, onboarding_dq {source, ran_at, ran_at_sgt, rules}, live_rules, invalid_rows, definitions}`: the governed plan (`seeds/usl-plan.json`), the onboarding DQ file (`<data>/dq/latest.json`) and the two rules run live by the newest run that ran them, dated by that run's first `dq_run` statement. `?run=<id>` picks the run. |
| `GET /api/why/:memId` | `{memory_id, memory, ...}`: the H-MEM ledger trace of one memory ("why do you believe this?"). |
| `GET /api/world` | `{entities, edges, events, nodes_total, edges_total}`: World Model counts by type; `?full=1` adds the graph. |
| `GET /api/world/:cik` | `{cik, history}`: what the World Model knew about one utility, and since when. |
| `GET /api/eval` | `{file, updated_at, updated_at_sgt, report}` from `<data>/eval/report.json`; `404` when there is none. |
| `GET /api/seeds` | `{utilities: [{cik, name, ticker, sic, hq_state, states_served, station_ids, flags}]}`: the 43 seed utilities. |
| `GET /`, `GET /<file>` | The UI from `ui/` (also `HEAD`). |

## Cell ids

`GET /api/evidence/:run/:cell` accepts:

- `<cik10>.<field>` with field `declarations`, `revenue_current`, `revenue_previous`, `revenue_change`, `weather_current`, `weather_previous` or `weather_change`;
- `key.<route>@<period>` for a governed join-map key, for example `key.cik@CY2025Q1` or `key.station@all`;
- `key.pair:<cw.object>.<column>~<cw.object>.<column>|<transform>` for a generic pair measured by the `match_rate` template, with the transform from the closed set (`identity`, `upper`, `lpad10`, `substr(a,b)`, `strip_prefix('US-')`, `yyyymmdd_to_date`, `iso_to_quarter`);
- an evidence id `ev-<run id>-<nn>`.

The id is URL-decoded before the check; anything else gives `400 bad_id`.

## Example: one join-map row (shape)

```json
{
  "id": "k1",
  "key": "fema_state@CY2025Q1",
  "label": "(c) FEMA state vs the states the seed utilities serve",
  "left": { "object": "cw.fema_declarations_dr_2025q1", "column": "state" },
  "right": { "object": "cw.utility_states", "column": "state" },
  "transform": "identity",
  "proposed_by": ["planner", "baseline (queue)"],
  "verdict": "PARTIAL",
  "verdict_definition": "Between 80% and 95% of the left table's rows found a match. Usable with care: the orphans listed drop out of any join on this key.",
  "rate": 0.875, "matched_rows": 7, "left_rows": 8,
  "rate_distinct": 0.875, "matched_keys": 7, "left_keys": 8,
  "orphans": ["AK"],
  "recalled": false,
  "provenance": "measured in this run",
  "sql": "SELECT COUNT(DISTINCT l.k) AS left_keys, ... FROM (SELECT DISTINCT state AS k FROM cw.fema_declarations_dr_2025q1) l LEFT JOIN (SELECT DISTINCT state AS k FROM cw.utility_states) r ON r.k = l.k",
  "elapsed_ms": 640
}
```

## Command line equivalents

From `agent/`: `npm run ask -- --quarter CY2025Q1 [--cold] [--think on|off] [--max-chunks 12] [--no-model] [--json] [--out <file>]` (from PowerShell, wrap it in `cmd /c "..."`), `npm run replay -- <run_id>`, `npm run cli -- runs`, `npm run cli -- why <memory_id>`, `npm run cli -- known --cik <cik>` or `--left <object.column> --right <object.column>`, and `npm run onboard [-- --skip-dq] [-- --refresh-snapshot]`.
