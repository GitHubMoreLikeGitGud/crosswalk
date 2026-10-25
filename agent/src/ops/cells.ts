// The Answer table and its per-cell provenance drawer (SPEC D20): every value names the Lightning SQL
// statement(s) it came from, the Zetaris object, the rows behind that one cell, the statement's ms,
// its cache state and the times. Cell ids:
//   <cik10>.<field>   an answer value (declarations, revenue_current, revenue_previous, revenue_change,
//                     weather_current, weather_previous, weather_change)
//   key.<route>       a join-map row (key.cik@CY2025Q1)
//   ev-<run>-<n>      one evidence record
// When the saved run kept fewer rows than the statement returned, the drawer says so and names
// what is missing for that cell instead of presenting a partial row set as complete.

import type { EvidenceRecord } from "../evidence/store.ts";
import type { AnswerRowIn, ProvenanceIn, RunIn } from "./runShape.ts";
import { sgt } from "./time.ts";

export const ANSWER_FIELDS = ["declarations", "revenue_current", "revenue_previous", "revenue_change", "weather_current", "weather_previous", "weather_change"] as const;
export type AnswerField = (typeof ANSWER_FIELDS)[number];

/** Accepted cell ids (checked before any lookup; nothing else reaches the run). */
export const CELL_ID = /^(?:\d{10}\.(?:declarations|revenue_current|revenue_previous|revenue_change|weather_current|weather_previous|weather_change)|key\.[a-z_]+@[A-Za-z0-9]+|ev-r\d{8}T\d{6}[0-9a-f]{4}-\d{2,4})$/u;

export interface StatementView {
  evidence_id: string | null;
  template: string | null;
  params: Record<string, string> | null;
  sql: string | null;
  sql_sha256: string | null;
  zetaris_object: string | null;
  zetaris_objects: string[];
  source_url: string | null;
  licence: string | null;
  columns: string[];
  /** The rows behind this cell (filtered from the statement's rows). */
  rows: unknown[][];
  /** Rows the statement returned / rows the saved run kept. */
  row_count: number | null;
  rows_in_run: number;
  rows_truncated: boolean;
  elapsed_ms: number | null;
  executed_at: string | null;
  executed_at_sgt: string | null;
  cache_state: string | null;
  /** When the gateway last cached the source object; null when the gateway did not report it. */
  source_cached_at: string | null;
  source_cached_at_sgt: string | null;
  note: string | null;
}

export interface CellEvidence {
  run_id: string;
  cell: string;
  kind: "answer" | "join_key" | "evidence";
  subject: string;
  field: string | null;
  label: string;
  value: unknown;
  derivation: string | null;
  statements: StatementView[];
  cell_rows_complete: boolean;
  missing: string[];
}

const DERIVATION: Record<AnswerField, string> = {
  declarations: "Major-disaster (DR) declarations counted as distinct disaster numbers per served state, summed over the utility's served states.",
  revenue_current: "The value of the first available revenue tag (Revenues, then RevenueFromContractWithCustomerExcludingAssessedTax, then RegulatedAndUnregulatedOperatingRevenue) for this CIK in the asked quarter.",
  revenue_previous: "The same rule for the same quarter a year earlier.",
  revenue_change: "current / previous - 1, computed only when the first available tag is the same in both quarters.",
  weather_current: "Total degree days (HDD + CDD, base 65 F) averaged over the utility's seed stations that report both years with coverage of at least 0.9.",
  weather_previous: "The same average for the same quarter a year earlier.",
  weather_change: "current / previous - 1 of the station-average total degree days.",
};

function evidenceFor(run: RunIn, p: ProvenanceIn): EvidenceRecord | undefined {
  return (run.evidence ?? []).find((e) => (e.kind === "zetaris_sql" || e.kind === "dq") && e.template_id === p.template && (e.sql ?? "") === (p.sql ?? ""));
}

function statementOf(run: RunIn, p: ProvenanceIn, keep: (cols: string[], row: unknown[]) => boolean): StatementView {
  const ev = evidenceFor(run, p);
  const pRows = p.rows ?? [];
  const eRows = ev?.rows ?? [];
  const rows = eRows.length > pRows.length ? eRows : pRows;
  const columns = (p.columns ?? ev?.columns ?? []).map(String);
  const rowCount = typeof p.row_count === "number" ? p.row_count : typeof ev?.row_count === "number" ? ev.row_count : null;
  const executed = p.executed_at ?? ev?.queried_at ?? null;
  const cached = ev?.source_cached_at ?? null;
  return {
    evidence_id: ev?.id ?? null,
    template: p.template ?? ev?.template_id ?? null,
    params: p.params ?? ev?.params ?? null,
    sql: p.sql ?? ev?.sql ?? null,
    sql_sha256: ev?.sql_sha256 ?? null,
    zetaris_object: ev?.zetaris_object ?? null,
    zetaris_objects: ev?.zetaris_objects ?? (ev?.zetaris_object ? [ev.zetaris_object] : []),
    source_url: ev?.source_url ?? null,
    licence: ev?.licence ?? null,
    columns,
    rows: rows.filter((r) => keep(columns, r)),
    row_count: rowCount,
    rows_in_run: rows.length,
    rows_truncated: rowCount !== null && rowCount > rows.length,
    elapsed_ms: typeof p.elapsed_ms === "number" ? p.elapsed_ms : (ev?.elapsed_ms ?? null),
    executed_at: executed,
    executed_at_sgt: sgt(executed),
    cache_state: p.cache_state ?? ev?.cache_state ?? null,
    source_cached_at: cached,
    source_cached_at_sgt: sgt(cached),
    note: cached ? null : "the gateway did not report a cache time for this source; cache_state is the statement's",
  };
}

function colIs(name: string, test: (v: unknown) => boolean) {
  return (cols: string[], row: unknown[]) => {
    const i = cols.findIndex((c) => c.toLowerCase() === name);
    return i >= 0 && test(row[i]);
  };
}

function weatherProv(run: RunIn, row: AnswerRowIn, which: "current" | "previous"): ProvenanceIn | undefined {
  const quarter = which === "current" ? run.answer?.quarter ?? run.quarter : run.answer?.previous ?? run.previous_quarter;
  const year = /^CY(\d{4})Q/u.exec(quarter ?? "")?.[1];
  const list = row.provenance?.weather ?? [];
  return list.find((p) => p.params?.year === year) ?? list[which === "current" ? 0 : 1];
}

function answerCell(run: RunIn, cell: string, cik: string, field: AnswerField): CellEvidence | null {
  const row = (run.answer?.rows ?? []).find((r) => r.cik === cik);
  if (!row) return null;
  const prov = row.provenance ?? {};
  const byCik = colIs("cik", (v) => String(v) === cik);
  const stations = new Set(row.weather?.stations ?? []);
  const byStation = colIs("station_id", (v) => stations.has(String(v)));
  const provs: { p: ProvenanceIn | undefined; keep: (c: string[], r: unknown[]) => boolean }[] = [];
  let value: unknown = null;
  let label = "";
  const q = run.answer?.quarter ?? run.quarter ?? "";
  const pq = run.answer?.previous ?? run.previous_quarter ?? "";
  const tag = row.revenue?.tag ?? null;
  switch (field) {
    case "declarations":
      provs.push({ p: prov.declarations, keep: byCik });
      value = row.declarations ?? null;
      label = `Major-disaster declarations in ${q} in the states ${row.name} serves`;
      break;
    case "revenue_current":
      provs.push({ p: prov.revenue_current, keep: byCik });
      value = row.revenue?.current ?? null;
      label = `Revenue ${q}${tag ? ` (${tag})` : ""}`;
      break;
    case "revenue_previous":
      provs.push({ p: prov.revenue_previous, keep: byCik });
      value = row.revenue?.previous ?? null;
      label = `Revenue ${pq}${tag ? ` (${tag})` : ""}`;
      break;
    case "revenue_change":
      provs.push({ p: prov.revenue_current, keep: byCik }, { p: prov.revenue_previous, keep: byCik });
      value = row.revenue?.change ?? null;
      label = `Revenue change ${pq} to ${q}`;
      break;
    case "weather_current":
      provs.push({ p: weatherProv(run, row, "current"), keep: byStation });
      value = row.weather?.tdd_current ?? null;
      label = `Total degree days ${q} (station average)`;
      break;
    case "weather_previous":
      provs.push({ p: weatherProv(run, row, "previous"), keep: byStation });
      value = row.weather?.tdd_previous ?? null;
      label = `Total degree days ${pq} (station average)`;
      break;
    case "weather_change":
      provs.push({ p: weatherProv(run, row, "current"), keep: byStation }, { p: weatherProv(run, row, "previous"), keep: byStation });
      value = row.weather?.change ?? null;
      label = `Total degree days change ${pq} to ${q}`;
      break;
  }
  const statements = provs.filter((x): x is { p: ProvenanceIn; keep: (c: string[], r: unknown[]) => boolean } => !!x.p).map((x) => statementOf(run, x.p, x.keep));
  const missing: string[] = [];
  for (const s of statements) {
    if (field.startsWith("weather")) {
      const i = s.columns.findIndex((c) => c.toLowerCase() === "station_id");
      const seen = new Set(s.rows.map((r) => String(r[i])));
      for (const st of [...stations].sort()) if (!seen.has(st) && s.rows_truncated) missing.push(`${st} (${s.params?.year ?? "?"}): row not kept in the saved run`);
    } else if (!s.rows.length && s.rows_truncated) missing.push(`${cik} (${s.params?.period ?? s.params?.quarter ?? "?"}): row not kept in the saved run`);
  }
  if (!statements.length) missing.push(`no statement recorded for ${field}${row.revenue_note || row.weather_note ? ` (${row.revenue_note ?? row.weather_note})` : ""}`);
  return { run_id: run.run_id, cell, kind: "answer", subject: `${row.name}${row.ticker ? ` (${row.ticker})` : ""}`, field, label, value, derivation: DERIVATION[field], statements, cell_rows_complete: missing.length === 0, missing };
}

function keyCell(run: RunIn, cell: string, route: string): CellEvidence | null {
  const k = (run.join_map ?? []).find((r) => r.key === route);
  if (!k) return null;
  const statements: StatementView[] = [];
  for (const sql of [k.sql, k.sql_orphans]) {
    if (!sql) continue;
    const ev = (run.evidence ?? []).find((e) => e.kind === "zetaris_sql" && e.sql === sql);
    const st = statementOf(run, { template: ev?.template_id, params: ev?.params, sql, elapsed_ms: ev?.elapsed_ms, executed_at: ev?.queried_at ?? null, cache_state: ev?.cache_state ?? null, row_count: ev?.row_count, columns: ev?.columns, rows: ev?.rows }, () => true);
    if (!ev) st.note = k.from_memory ? `measured in an earlier run (recalled from memory ${k.from_memory}${k.measured_as ? `, measured as ${k.measured_as}` : ""}); no statement in this run` : "statement text recorded on the join-map row; no evidence record in this run";
    statements.push(st);
  }
  return {
    run_id: run.run_id,
    cell,
    kind: "join_key",
    subject: k.label ?? route,
    field: null,
    label: `${route}: ${k.matched_rows ?? "?"} of ${k.left_rows ?? "?"} rows matched`,
    value: { rate: k.rate ?? null, rate_distinct: k.rate_distinct ?? null, verdict: k.verdict ?? null, orphans: k.orphans ?? [] },
    derivation: "rate = matched rows / rows of the left table; the verdict follows the thresholds of the join map",
    statements,
    cell_rows_complete: true,
    missing: [],
  };
}

function evidenceCell(run: RunIn, cell: string): CellEvidence | null {
  const ev = (run.evidence ?? []).find((e) => e.id === cell);
  if (!ev) return null;
  const st = statementOf(run, { template: ev.template_id, params: ev.params, sql: ev.sql, elapsed_ms: ev.elapsed_ms, executed_at: ev.queried_at, cache_state: ev.cache_state ?? null, row_count: ev.row_count, columns: ev.columns, rows: ev.rows }, () => true);
  return { run_id: run.run_id, cell, kind: "evidence", subject: ev.zetaris_object ?? ev.kind, field: null, label: ev.claim, value: null, derivation: ev.derived_from?.length ? `derived from ${ev.derived_from.join(", ")}` : null, statements: ev.sql ? [st] : [], cell_rows_complete: !st.rows_truncated, missing: [] };
}

/** The provenance drawer for one cell; null when the run has no such cell. */
export function cellEvidence(run: RunIn, cell: string): CellEvidence | null {
  if (!CELL_ID.test(cell)) return null;
  if (cell.startsWith("ev-")) return evidenceCell(run, cell);
  if (cell.startsWith("key.")) return keyCell(run, cell, cell.slice(4));
  const [cik, field] = cell.split(".") as [string, AnswerField];
  return answerCell(run, cell, cik, field);
}

/** The Answer table with the cell id of every value. */
export function answerView(run: RunIn) {
  const a = run.answer;
  return {
    run_id: run.run_id,
    quarter: a?.quarter ?? run.quarter ?? null,
    previous: a?.previous ?? run.previous_quarter ?? null,
    weather_status: a?.weather_status ?? null,
    answered: !!a,
    rows: (a?.rows ?? []).map((r) => ({
      cik: r.cik,
      name: r.name,
      ticker: r.ticker ?? null,
      states: r.states ?? [],
      declarations: r.declarations ?? null,
      by_incident_type: r.by_incident_type ?? null,
      revenue: r.revenue ?? null,
      revenue_note: r.revenue_note ?? null,
      weather: r.weather ?? null,
      weather_note: r.weather_note ?? null,
      cells: Object.fromEntries(ANSWER_FIELDS.map((f) => [f, `${r.cik}.${f}`])) as Record<AnswerField, string>,
    })),
    not_tested: run.not_tested ?? [],
    definitions: DERIVATION,
  };
}
