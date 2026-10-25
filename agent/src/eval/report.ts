// Evaluation report (SPEC D21): built from saved run files and the measured side files only
// (no gateway call, no model call). Sections: reproducibility of the cold question, the model's
// key proposals against the deterministic baseline (L2), outside checks (L4), the manual baseline
// (L6), the Nemotron ablation (L12), timings per tool and per statement class, what did not go well
// and what was not measured. Revenue appears only as the year-on-year change the answer shows; no
// filing value, accession number or sample row is copied into the report.

import { createHash } from "node:crypto";

// ---------- input shapes (loose: only the fields the report reads) ----------

export interface Proposals {
  proposed_by?: string;
  made?: number;
  valid?: number;
  verified?: number;
  partial?: number;
  rejected?: number;
  invalid_schema?: number;
  unmeasurable?: number;
  keys?: string[];
}

export interface JoinRow {
  id: string;
  key: string;
  label?: string;
  left?: string;
  right?: string;
  transform?: string;
  proposed_by?: string[];
  status?: string;
  verdict?: string | null;
  left_rows?: number | null;
  matched_rows?: number | null;
  left_keys?: number | null;
  matched_keys?: number | null;
  rate?: number | null;
  rate_distinct?: number | null;
  orphans?: unknown[];
  from_memory?: string | null;
  measured_as?: string | null;
}

export interface Statement {
  template?: string | null;
  elapsed_ms?: number | null;
  rows?: number | null;
  cache_state?: string | null;
}

export interface ToolCall {
  chunk?: number;
  seq?: number;
  tool: string;
  source?: string;
  ok?: boolean;
  latency_ms?: number;
  statements?: Statement[];
}

export interface PlannerCall {
  valid?: boolean;
  valid_first_try?: boolean;
  attempts?: number;
  repair_think_off?: boolean;
  think?: boolean;
  prompt_tokens?: number;
  eval_tokens?: number;
  wall_ms?: number;
  tokens_per_s?: number | null;
}

export interface AnswerRow {
  cik: string;
  name?: string;
  ticker?: string | null;
  states?: { state: string; declarations: number }[];
  declarations?: number;
  by_incident_type?: Record<string, number>;
  revenue?: { tag?: string; current?: number | null; previous?: number | null; change?: number | null; note?: string | null } | null;
  revenue_note?: string | null;
  weather?: { stations?: string[]; tdd_current?: number | null; tdd_previous?: number | null; change?: number | null } | null;
  weather_note?: string | null;
}

export interface EvalRun {
  run_id: string;
  quarter: string;
  previous_quarter?: string;
  mode: string;
  started_at: string;
  wall_ms: number;
  join_map?: JoinRow[];
  model_proposals?: Proposals | null;
  baseline_proposals?: Proposals | null;
  answer?: { rows: AnswerRow[]; weather_status?: string } | null;
  memo?: { source?: string; words?: number; attempts?: number; verifier?: { checked?: boolean; drafts_rejected_for_words?: number; final_issues?: unknown[] } | null } | null;
  not_tested?: string[];
  usl?: { matches_governed?: boolean; live_rules_run?: { rule: string; total?: number; valid?: number; invalid?: number; elapsed_ms?: number; error?: string | null }[] } | null;
  tool_calls_detail?: ToolCall[];
  planner_calls?: PlannerCall[];
  summary?: Record<string, number | null | undefined | object>;
  telemetry?: {
    chunks?: number;
    skipped_chunks?: number;
    tokens?: { planner_in?: number; planner_out?: number; memo_in?: number; memo_out?: number };
    model?: string | null;
    think?: boolean | null;
    median_planner_tokens_per_s?: number | null;
    memo_tokens_per_s?: number | null;
    cloud_model_calls?: number;
  };
  timings_ms?: Record<string, number>;
  checklist_complete?: boolean;
  registrations?: { status?: string; object?: string; rows?: number }[];
}

/** One selected run: who ran it, on which code, under which model setting. */
export interface SelectedRun {
  run_id: string;
  label: string;
  by: string;
  code: string;
  setting: "think_on" | "think_off" | "no_model";
  note?: string;
}

export interface Selection {
  runs: SelectedRun[];
  /** Day-1 reference runs whose answers the Day-2 runs are compared with (the binding numbers of SPEC 11.4). */
  references?: { run_id: string; label: string }[];
  did_not_go_well?: string[];
  not_measured?: string[];
}

/** nvidia-smi samples and Ollama /api/ps reads of one run (from the ablation driver). */
export interface GpuSamples {
  run_id: string;
  samples: { at: string; mem_mib: number; util_pct: number }[];
  ollama_before?: OllamaPs | null;
  ollama_mid?: OllamaPs | null;
  ollama_after?: OllamaPs | null;
}

export interface OllamaPs {
  models?: { name: string; size?: number; size_vram?: number; context_length?: number; details?: { parameter_size?: string; quantization_level?: string } }[];
}

export interface ManualStep {
  n: number;
  at: string;
  template: string;
  params: Record<string, string>;
  elapsed_ms: number;
  wall_ms?: number;
  rows: number;
  result: string;
  decision: string;
  key?: string | null;
  error?: string | null;
}

export interface ManualSession {
  label: string;
  note?: string;
  started_at: string;
  finished_at: string;
  steps: ManualStep[];
  keys: { key: string; verdict: string; matched: number; total: number; orphans: string[] }[];
}

export interface OutsideChecks {
  label?: string;
  fema: {
    quarter: string;
    outside: { rows: number; declarations: number; states: number; by_state: Record<string, number>; fetch_ms?: number };
    zetaris: { rows: number; declarations: number; states: number; by_state: Record<string, number>; elapsed_ms?: number; object?: string | null };
    equal: boolean;
  }[];
  ten_k: {
    ticker: string;
    name?: string;
    filing?: { form: string; report_date?: string; filing_date?: string };
    seed_states?: string[];
    filing_states?: string[];
    in_filing_not_in_seed?: string[];
    in_seed_not_in_filing?: string[];
    equal?: boolean;
    not_run?: string;
    error?: string;
  }[];
}

export interface BuildInputs {
  selection: Selection;
  runs: Map<string, EvalRun>;
  gpu: GpuSamples[];
  manual: ManualSession | null;
  outside: OutsideChecks | null;
}

// ---------- helpers ----------

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]!;
}

const round = (x: number | null | undefined, d: number): number | null => (typeof x === "number" ? Number(x.toFixed(d)) : null);

/** The family of a join-map key: a period or quarter suffix dropped, so cik@CY2025Q1 and cik@CY2024Q1 are one key. */
export function keyFamily(key: string): string {
  return key
    .replace(/@(CY\d{4}Q[1-4]|all)$/u, "")
    .replace(/_cy\d{4}q[1-4]/gu, "_<period>")
    .replace(/_dr_\d{4}q[1-4]/gu, "_dr_<quarter>");
}

/** Named join-map routes (the governed keys a-e, the FIPS key and the no-LPAD control). */
export const GOVERNED = ["cik", "loc", "fema_state", "fema_fips", "station", "sic", "cik_control"] as const;

export function isGoverned(key: string): boolean {
  return (GOVERNED as readonly string[]).includes(keyFamily(key));
}

/** The answer as the comparison sees it: every field of every row except provenance and timings. */
export function answerCanonical(run: EvalRun): unknown[] {
  return (run.answer?.rows ?? []).map((r) => ({
    cik: r.cik,
    ticker: r.ticker ?? null,
    name: r.name ?? null,
    states: (r.states ?? []).map((s) => [s.state, s.declarations]),
    declarations: r.declarations ?? null,
    by_incident_type: r.by_incident_type ?? null,
    revenue: r.revenue ? { tag: r.revenue.tag ?? null, current: r.revenue.current ?? null, previous: r.revenue.previous ?? null, change: r.revenue.change ?? null, note: r.revenue.note ?? null } : null,
    revenue_note: r.revenue_note ?? null,
    weather: r.weather ? { stations: r.weather.stations ?? [], tdd_current: r.weather.tdd_current ?? null, tdd_previous: r.weather.tdd_previous ?? null, change: r.weather.change ?? null } : null,
    weather_note: r.weather_note ?? null,
  }));
}

export function sha12(x: unknown): string {
  return createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 12);
}

/** One join-map row as the comparison sees it (labels and SQL text left out: the numbers and orphans). */
export function joinRowCanonical(r: JoinRow): unknown {
  return {
    verdict: r.verdict ?? null,
    left_rows: r.left_rows ?? null,
    matched_rows: r.matched_rows ?? null,
    left_keys: r.left_keys ?? null,
    matched_keys: r.matched_keys ?? null,
    orphans: r.orphans ?? [],
  };
}

export interface PairCompare {
  a: string;
  b: string;
  answer_rows: [number, number];
  answer_identical: boolean;
  answer_differences: string[];
  join_rows: [number, number];
  join_common: number;
  join_identical_on_common: boolean;
  governed_identical: boolean;
  governed_compared: number;
  only_in_a: string[];
  only_in_b: string[];
  /** Who proposed each key measured in one run only: model, baseline, or both (from the join-map row's proposed_by). */
  proposers: Record<string, string>;
}

export function proposerOf(r: JoinRow | undefined): string {
  const by = r?.proposed_by ?? [];
  const m = by.some((x) => x.startsWith("planner"));
  const b = by.some((x) => x.startsWith("baseline"));
  const c = by.some((x) => x.startsWith("control"));
  return m && b ? "model+baseline" : m ? "model" : b ? "baseline" : c ? "control" : "unknown";
}

export function compareRuns(a: EvalRun, b: EvalRun): PairCompare {
  const ca = answerCanonical(a);
  const cb = answerCanonical(b);
  const diffs: string[] = [];
  const byCik = (rows: unknown[]) => new Map(rows.map((r) => [(r as { cik: string }).cik, JSON.stringify(r)]));
  const ma = byCik(ca);
  const mb = byCik(cb);
  for (const [cik, v] of ma) if (mb.get(cik) !== v) diffs.push(cik);
  for (const cik of mb.keys()) if (!ma.has(cik)) diffs.push(cik);
  const ja = new Map((a.join_map ?? []).map((r) => [r.key, r]));
  const jb = new Map((b.join_map ?? []).map((r) => [r.key, r]));
  const common = [...ja.keys()].filter((k) => jb.has(k));
  const sameRow = (k: string) => JSON.stringify(joinRowCanonical(ja.get(k)!)) === JSON.stringify(joinRowCanonical(jb.get(k)!));
  const governed = common.filter(isGoverned);
  const govA = [...ja.keys()].filter(isGoverned).sort();
  const govB = [...jb.keys()].filter(isGoverned).sort();
  const proposers: Record<string, string> = {};
  for (const k of ja.keys()) if (!jb.has(k)) proposers[k] = proposerOf(ja.get(k));
  for (const k of jb.keys()) if (!ja.has(k)) proposers[k] = proposerOf(jb.get(k));
  return {
    proposers,
    a: a.run_id,
    b: b.run_id,
    answer_rows: [ca.length, cb.length],
    answer_identical: JSON.stringify(ca) === JSON.stringify(cb),
    answer_differences: [...new Set(diffs)],
    join_rows: [ja.size, jb.size],
    join_common: common.length,
    join_identical_on_common: common.every(sameRow),
    governed_identical: JSON.stringify(govA) === JSON.stringify(govB) && governed.every(sameRow),
    governed_compared: governed.length,
    only_in_a: [...ja.keys()].filter((k) => !jb.has(k)).sort(),
    only_in_b: [...jb.keys()].filter((k) => !ja.has(k)).sort(),
  };
}

export interface SideTally {
  proposed_by: string | null;
  made: number;
  valid: number | null;
  verified: number;
  partial: number;
  rejected: number;
  invalid_schema: number;
  unmeasurable: number;
  verified_keys: string[];
  recalled_keys: string[];
}

/** One side's tally of a run, plus the keys of that side the join map holds as VERIFIED (and which of them were recalled). */
export function sideTally(run: EvalRun, side: "model" | "baseline"): SideTally {
  const p = (side === "model" ? run.model_proposals : run.baseline_proposals) ?? {};
  const exact = new Map((run.join_map ?? []).map((r) => [r.key, r]));
  const family = new Map<string, JoinRow>();
  for (const r of run.join_map ?? []) if (!family.has(keyFamily(r.key))) family.set(keyFamily(r.key), r);
  // A recalled key is recorded under the asked quarter (cik@CY2024Q1) while the tally may name the measured one (cik@CY2025Q1).
  const rowOf = (k: string): JoinRow | undefined => exact.get(k) ?? family.get(keyFamily(k));
  const rows = { get: rowOf };
  const keys = p.keys ?? [];
  const verified = keys.filter((k) => rows.get(k)?.verdict === "VERIFIED");
  return {
    proposed_by: p.proposed_by ?? null,
    made: p.made ?? 0,
    valid: typeof p.valid === "number" ? p.valid : null,
    verified: p.verified ?? 0,
    partial: p.partial ?? 0,
    rejected: p.rejected ?? 0,
    invalid_schema: p.invalid_schema ?? 0,
    unmeasurable: p.unmeasurable ?? 0,
    verified_keys: verified.map(keyFamily).sort(),
    recalled_keys: verified.filter((k) => !!rows.get(k)?.from_memory).map(keyFamily).sort(),
  };
}

export interface L2Row {
  run_id: string;
  label: string;
  setting: string;
  mode: string;
  model: SideTally;
  baseline: SideTally;
}

export interface L2Section {
  rows: L2Row[];
  /** Over the runs with a model (think on or off), cold and warm. */
  totals: { model: Record<string, number>; baseline: Record<string, number> };
  /** Over the cold runs with a model (no recalled key on either side). */
  cold_totals: { model: Record<string, number>; baseline: Record<string, number> };
  keys_found: {
    model: string[];
    baseline: string[];
    only_model: string[];
    only_baseline: string[];
    both: string[];
    /** Model keys that no baseline proposal (its scored six or its measure queue) measured VERIFIED in any run. */
    model_beyond_any_baseline: string[];
  };
  winner: "model" | "baseline" | "tie";
  runs_counted: number;
  cold_runs_counted: number;
}

const TALLY_FIELDS = ["made", "valid", "verified", "partial", "rejected", "invalid_schema", "unmeasurable"] as const;

export function l2Section(runs: { sel: SelectedRun; run: EvalRun }[]): L2Section {
  const rows: L2Row[] = runs.map(({ sel, run }) => ({ run_id: run.run_id, label: sel.label, setting: sel.setting, mode: run.mode, model: sideTally(run, "model"), baseline: sideTally(run, "baseline") }));
  const withModel = rows.filter((r) => r.setting !== "no_model");
  const coldWithModel = withModel.filter((r) => r.mode === "cold");
  const sum = (list: L2Row[], side: "model" | "baseline") => {
    const out: Record<string, number> = {};
    for (const f of TALLY_FIELDS) out[f] = list.reduce((s, r) => s + ((r[side][f] as number | null) ?? 0), 0);
    return out;
  };
  // A key "found" by a side: VERIFIED in a run with a model where it was measured (not recalled), from that side's own proposals.
  const found = (side: "model" | "baseline") => {
    const s = new Set<string>();
    for (const r of withModel) for (const k of r[side].verified_keys) if (!r[side].recalled_keys.includes(k)) s.add(k);
    return [...s].sort();
  };
  const anyBaseline = new Set<string>();
  for (const { run } of runs) for (const j of run.join_map ?? []) if (j.verdict === "VERIFIED" && (j.proposed_by ?? []).some((x) => x.startsWith("baseline"))) anyBaseline.add(keyFamily(j.key));
  const m = found("model");
  const b = found("baseline");
  const totals = { model: sum(withModel, "model"), baseline: sum(withModel, "baseline") };
  const winner = totals.model.verified! > totals.baseline.verified! ? "model" : totals.model.verified! < totals.baseline.verified! ? "baseline" : "tie";
  return {
    rows,
    totals,
    cold_totals: { model: sum(coldWithModel, "model"), baseline: sum(coldWithModel, "baseline") },
    keys_found: { model: m, baseline: b, only_model: m.filter((k) => !b.includes(k)), only_baseline: b.filter((k) => !m.includes(k)), both: m.filter((k) => b.includes(k)), model_beyond_any_baseline: m.filter((k) => !anyBaseline.has(k)) },
    winner,
    runs_counted: withModel.length,
    cold_runs_counted: coldWithModel.length,
  };
}

export interface RunLine {
  run_id: string;
  label: string;
  by: string;
  code: string;
  setting: string;
  mode: string;
  quarter: string;
  started_at: string;
  wall_s: number;
  chunks: number | null;
  skipped_chunks: number | null;
  planner_calls: number;
  planner_valid: number;
  planner_valid_first_try: number;
  planner_repaired: number;
  fallback_steps: number | null;
  tokens: { planner_in: number; planner_out: number; memo_in: number; memo_out: number };
  median_planner_tok_s: number | null;
  memo_tok_s: number | null;
  statements: number;
  statement_ms: number;
  slowest_statement: { template: string; ms: number } | null;
  over_20s: number;
  answer_rows: number;
  answer_sha: string;
  join_rows: number;
  verdicts: Record<string, number>;
  note: { source: string | null; words: number | null; attempts: number | null; verifier_checked: boolean | null; drafts_rejected_for_words: number | null; final_issues: number | null };
  usl_matches_governed: boolean | null;
  live_dq: string[];
  checklist_complete: boolean | null;
  cloud_model_calls: number | null;
}

function statementsOf(run: EvalRun): (Statement & { tool: string })[] {
  const out: (Statement & { tool: string })[] = [];
  for (const t of run.tool_calls_detail ?? []) for (const s of t.statements ?? []) out.push({ ...s, tool: t.tool });
  return out;
}

export function runLine(sel: SelectedRun, run: EvalRun): RunLine {
  const sts = statementsOf(run).filter((s) => typeof s.elapsed_ms === "number");
  const slow = sts.reduce<(Statement & { tool: string }) | null>((m, s) => (!m || s.elapsed_ms! > m.elapsed_ms! ? s : m), null);
  const pc = run.planner_calls ?? [];
  const verdicts: Record<string, number> = {};
  for (const r of run.join_map ?? []) verdicts[r.verdict ?? "unmeasured"] = (verdicts[r.verdict ?? "unmeasured"] ?? 0) + 1;
  const num = (k: string): number | null => (typeof run.summary?.[k] === "number" ? (run.summary[k] as number) : null);
  return {
    run_id: run.run_id,
    label: sel.label,
    by: sel.by,
    code: sel.code,
    setting: sel.setting,
    mode: run.mode,
    quarter: run.quarter,
    started_at: run.started_at,
    wall_s: round(run.wall_ms / 1000, 1)!,
    chunks: run.telemetry?.chunks ?? null,
    skipped_chunks: run.telemetry?.skipped_chunks ?? null,
    planner_calls: pc.length,
    planner_valid: pc.filter((p) => p.valid).length,
    planner_valid_first_try: pc.filter((p) => p.valid_first_try).length,
    planner_repaired: pc.filter((p) => (p.attempts ?? 1) > 1 && p.valid).length,
    fallback_steps: num("fallback_steps"),
    tokens: {
      planner_in: run.telemetry?.tokens?.planner_in ?? 0,
      planner_out: run.telemetry?.tokens?.planner_out ?? 0,
      memo_in: run.telemetry?.tokens?.memo_in ?? 0,
      memo_out: run.telemetry?.tokens?.memo_out ?? 0,
    },
    median_planner_tok_s: round(run.telemetry?.median_planner_tokens_per_s ?? null, 1),
    memo_tok_s: round(run.telemetry?.memo_tokens_per_s ?? null, 1),
    statements: sts.length,
    statement_ms: sts.reduce((s, x) => s + x.elapsed_ms!, 0),
    slowest_statement: slow ? { template: slow.template ?? slow.tool, ms: slow.elapsed_ms! } : null,
    over_20s: sts.filter((s) => s.elapsed_ms! > 20_000).length,
    answer_rows: run.answer?.rows.length ?? 0,
    answer_sha: sha12(answerCanonical(run)),
    join_rows: run.join_map?.length ?? 0,
    verdicts,
    note: {
      source: run.memo?.source ?? null,
      words: run.memo?.words ?? null,
      attempts: run.memo?.attempts ?? null,
      verifier_checked: run.memo?.verifier?.checked ?? null,
      drafts_rejected_for_words: run.memo?.verifier?.drafts_rejected_for_words ?? null,
      final_issues: run.memo?.verifier ? (run.memo.verifier.final_issues ?? []).length : null,
    },
    usl_matches_governed: run.usl?.matches_governed ?? null,
    live_dq: (run.usl?.live_rules_run ?? []).map((l) => (l.error ? `${l.rule} failed` : `${l.rule} ${l.total}/${l.valid}/${l.invalid}`)),
    checklist_complete: run.checklist_complete ?? null,
    cloud_model_calls: run.telemetry?.cloud_model_calls ?? null,
  };
}

/** Statement class of a gateway template, for the timing table. */
export function statementClass(template: string | null | undefined): string {
  const t = template ?? "";
  if (["describe_object", "sample_rows", "distinct_counts"].includes(t)) return "probe";
  if (t.startsWith("joinmap_")) return "measure (named join-map statement)";
  if (t.startsWith("match_rate")) return "measure (generic match_rate)";
  if (t === "weather_quarter") return "answer (weather)";
  if (t.startsWith("answer_")) return "answer";
  if (t === "dq_run" || t === "dq_invalid") return "live DQ";
  if (t === "catalogue_list") return "catalogue";
  if (t === "lookup") return "lookup";
  if (t.startsWith("usl_")) return "USL read";
  if (!t) return "registrar plan (DESCRIBE, cache check)";
  return "other";
}

export interface TimingRow {
  name: string;
  class?: string;
  n: number;
  runs: number;
  median_ms: number | null;
  p90_ms: number | null;
  max_ms: number | null;
  total_ms: number;
}

function timingRow(name: string, xs: number[], runs: number, cls?: string): TimingRow {
  return { name, ...(cls ? { class: cls } : {}), n: xs.length, runs, median_ms: round(median(xs), 0), p90_ms: quantile(xs, 0.9), max_ms: xs.length ? Math.max(...xs) : null, total_ms: xs.reduce((s, x) => s + x, 0) };
}

export function toolTimings(runs: EvalRun[]): { tools: TimingRow[]; statements: TimingRow[]; classes: TimingRow[]; planner: TimingRow; over_20s: number } {
  const tools = new Map<string, number[]>();
  const st = new Map<string, number[]>();
  const cls = new Map<string, number[]>();
  const planner: number[] = [];
  let over = 0;
  for (const run of runs) {
    for (const t of run.tool_calls_detail ?? []) {
      if (typeof t.latency_ms === "number") (tools.get(t.tool) ?? tools.set(t.tool, []).get(t.tool)!).push(t.latency_ms);
      for (const s of t.statements ?? []) {
        if (typeof s.elapsed_ms !== "number") continue;
        const name = s.template ?? `${t.tool} (registrar)`;
        (st.get(name) ?? st.set(name, []).get(name)!).push(s.elapsed_ms);
        const c = statementClass(s.template);
        (cls.get(c) ?? cls.set(c, []).get(c)!).push(s.elapsed_ms);
        if (s.elapsed_ms > 20_000) over++;
      }
    }
    for (const p of run.planner_calls ?? []) if (typeof p.wall_ms === "number") planner.push(p.wall_ms);
  }
  const n = runs.length;
  const sortRows = (m: Map<string, number[]>, withClass: boolean) =>
    [...m.entries()].map(([k, v]) => timingRow(k, v, n, withClass ? statementClass(k.endsWith("(registrar)") ? null : k) : undefined)).sort((a, b) => b.total_ms - a.total_ms);
  return { tools: sortRows(tools, false), statements: sortRows(st, true), classes: sortRows(cls, false), planner: timingRow("planner call (model)", planner, n), over_20s: over };
}

export interface GpuSummary {
  run_id: string;
  samples: number;
  mem_first_mib: number | null;
  mem_peak_mib: number | null;
  mem_min_mib: number | null;
  util_median_pct: number | null;
  util_peak_pct: number | null;
  ollama_model: string | null;
  ollama_size_vram_mib: number | null;
  ollama_context: number | null;
  quantization: string | null;
  parameters: string | null;
  resident_before: boolean | null;
}

export function gpuSummary(g: GpuSamples): GpuSummary {
  const mem = g.samples.map((s) => s.mem_mib);
  const util = g.samples.map((s) => s.util_pct);
  const m = g.ollama_mid?.models?.[0] ?? g.ollama_after?.models?.[0] ?? g.ollama_before?.models?.[0] ?? null;
  return {
    run_id: g.run_id,
    samples: g.samples.length,
    mem_first_mib: mem[0] ?? null,
    mem_peak_mib: mem.length ? Math.max(...mem) : null,
    mem_min_mib: mem.length ? Math.min(...mem) : null,
    util_median_pct: median(util),
    util_peak_pct: util.length ? Math.max(...util) : null,
    ollama_model: m?.name ?? null,
    ollama_size_vram_mib: typeof m?.size_vram === "number" ? Math.round(m.size_vram / 1048576) : null,
    ollama_context: m?.context_length ?? null,
    quantization: m?.details?.quantization_level ?? null,
    parameters: m?.details?.parameter_size ?? null,
    resident_before: g.ollama_before ? (g.ollama_before.models ?? []).length > 0 : null,
  };
}

export interface ManualSummary {
  label: string;
  note: string | null;
  statements: number;
  failed_statements: number;
  lookups: number;
  statement_ms_total: number;
  session_wall_s: number;
  decisions: number;
  by_class: Record<string, number>;
  keys: ManualSession["keys"];
  steps: ManualStep[];
}

export function manualSummary(m: ManualSession): ManualSummary {
  const by: Record<string, number> = {};
  const sts = m.steps.filter((s) => s.template !== "lookup");
  for (const s of sts) by[statementClass(s.template)] = (by[statementClass(s.template)] ?? 0) + 1;
  return {
    label: m.label,
    note: m.note ?? null,
    statements: sts.length,
    failed_statements: sts.filter((s) => !!s.error).length,
    lookups: m.steps.length - sts.length,
    statement_ms_total: sts.reduce((s, x) => s + (x.elapsed_ms ?? 0), 0),
    session_wall_s: round((Date.parse(m.finished_at) - Date.parse(m.started_at)) / 1000, 1)!,
    decisions: m.steps.filter((s) => s.decision.trim() !== "").length,
    by_class: by,
    keys: m.keys,
    steps: m.steps,
  };
}

export interface EvalReport {
  title: string;
  generated_from: string;
  code: string[];
  runs: RunLine[];
  references: { run_id: string; label: string; answer_rows: number; answer_sha: string }[];
  reproducibility: { pairs: PairCompare[]; cold_runs: number; all_answers_identical: boolean; governed_join_map_identical: boolean; reference_matches: { run_id: string; reference: string; identical: boolean }[] };
  answer: { run_id: string; quarter: string; previous: string | null; weather_status: string | null; rows: { ticker: string | null; name: string | null; states: string; declarations: number | null; revenue_tag: string | null; revenue_change_pct: number | null; revenue_note: string | null; tdd_change_pct: number | null; stations: number | null }[] } | null;
  l2: L2Section;
  outside: OutsideChecks | null;
  manual: ManualSummary | null;
  agent_vs_manual: {
    cold_wall_s_median: number | null;
    warm_wall_s_median: number | null;
    cold_statements_median: number | null;
    warm_statements_median: number | null;
    cold_statement_s_median: number | null;
    warm_statement_s_median: number | null;
    no_model_wall_s: number | null;
    no_model_statements: number | null;
    no_model_statement_s: number | null;
    manual_statements: number | null;
    manual_statement_s: number | null;
    manual_session_s: number | null;
    manual_decisions: number | null;
  } | null;
  ablation: { setting: string; run_id: string; wall_s: number; chunks: number | null; planner_calls: number; planner_valid: number; planner_valid_first_try: number; planner_repaired: number; fallback_steps: number | null; tokens_out: number; median_tok_s: number | null; memo_tok_s: number | null; model: SideTally; note: RunLine["note"]; answer_identical_to_think_on: boolean | null; gpu: GpuSummary | null }[];
  timings: ReturnType<typeof toolTimings>;
  did_not_go_well: string[];
  not_measured: string[];
}

const TAG_SHORT: Record<string, string> = {
  Revenues: "Revenues",
  RevenueFromContractWithCustomerExcludingAssessedTax: "RFC",
  RegulatedAndUnregulatedOperatingRevenue: "RUOR",
};

export function buildReport(inp: BuildInputs): EvalReport {
  const chosen: { sel: SelectedRun; run: EvalRun }[] = [];
  for (const sel of inp.selection.runs) {
    const run = inp.runs.get(sel.run_id);
    if (!run) throw new Error(`selected run ${sel.run_id} has no run file`);
    chosen.push({ sel, run });
  }
  const lines = chosen.map(({ sel, run }) => runLine(sel, run));
  const cold = chosen.filter((c) => c.run.mode === "cold" && c.run.quarter === "CY2025Q1");
  const pairs: PairCompare[] = [];
  for (let i = 0; i < cold.length; i++) for (let j = i + 1; j < cold.length; j++) pairs.push(compareRuns(cold[i]!.run, cold[j]!.run));
  const refs = (inp.selection.references ?? []).filter((r) => inp.runs.has(r.run_id));
  const refMatches: { run_id: string; reference: string; identical: boolean }[] = [];
  for (const c of chosen) {
    for (const r of refs) {
      const ref = inp.runs.get(r.run_id)!;
      if (ref.quarter !== c.run.quarter) continue;
      refMatches.push({ run_id: c.run.run_id, reference: r.run_id, identical: JSON.stringify(answerCanonical(ref)) === JSON.stringify(answerCanonical(c.run)) });
    }
  }
  const answerRun = cold.find((c) => c.sel.setting === "think_on")?.run ?? cold[0]?.run ?? null;
  const answer = answerRun
    ? {
        run_id: answerRun.run_id,
        quarter: answerRun.quarter,
        previous: answerRun.previous_quarter ?? null,
        weather_status: answerRun.answer?.weather_status ?? null,
        rows: (answerRun.answer?.rows ?? []).map((r) => ({
          ticker: r.ticker ?? null,
          name: r.name ?? null,
          states: (r.states ?? []).map((s) => `${s.state} ${s.declarations}`).join(", "),
          declarations: r.declarations ?? null,
          revenue_tag: r.revenue?.tag ? (TAG_SHORT[r.revenue.tag] ?? r.revenue.tag) : null,
          revenue_change_pct: typeof r.revenue?.change === "number" ? round(r.revenue.change * 100, 2) : null,
          revenue_note: r.revenue?.change == null ? (r.revenue?.note ?? r.revenue_note ?? null) : null,
          tdd_change_pct: typeof r.weather?.change === "number" ? round(r.weather.change * 100, 2) : null,
          stations: r.weather?.stations?.length ?? null,
        })),
      }
    : null;
  const coldLines = lines.filter((l) => l.mode === "cold");
  const warmLines = lines.filter((l) => l.mode === "warm");
  const manual = inp.manual ? manualSummary(inp.manual) : null;
  const thinkOn = cold.find((c) => c.sel.setting === "think_on" && c.sel.by === "lane E") ?? cold.find((c) => c.sel.setting === "think_on");
  const gpuBy = new Map(inp.gpu.map((g) => [g.run_id, gpuSummary(g)]));
  const ablation = chosen
    .filter((c) => c.sel.by === "lane E" && c.run.mode === "cold")
    .map(({ sel, run }) => {
      const l = runLine(sel, run);
      return {
        setting: sel.setting,
        run_id: run.run_id,
        wall_s: l.wall_s,
        chunks: l.chunks,
        planner_calls: l.planner_calls,
        planner_valid: l.planner_valid,
        planner_valid_first_try: l.planner_valid_first_try,
        planner_repaired: l.planner_repaired,
        fallback_steps: l.fallback_steps,
        tokens_out: l.tokens.planner_out + l.tokens.memo_out,
        median_tok_s: l.median_planner_tok_s,
        memo_tok_s: l.memo_tok_s,
        model: sideTally(run, "model"),
        note: l.note,
        answer_identical_to_think_on: thinkOn && thinkOn.run.run_id !== run.run_id ? JSON.stringify(answerCanonical(thinkOn.run)) === JSON.stringify(answerCanonical(run)) : null,
        gpu: gpuBy.get(run.run_id) ?? null,
      };
    });
  return {
    title: "Crosswalk evaluation (Day 2)",
    generated_from: "saved run files (CW_DATA_DIR/runs/<id>/run.json), docs/eval/runs.json, docs/eval/outside-checks.json, docs/eval/manual-baseline.json and the ablation's nvidia-smi samples; no gateway or model call",
    code: [...new Set(inp.selection.runs.map((r) => r.code))],
    runs: lines,
    references: refs.map((r) => ({ run_id: r.run_id, label: r.label, answer_rows: inp.runs.get(r.run_id)!.answer?.rows.length ?? 0, answer_sha: sha12(answerCanonical(inp.runs.get(r.run_id)!)) })),
    reproducibility: {
      pairs,
      cold_runs: cold.length,
      all_answers_identical: pairs.every((p) => p.answer_identical),
      governed_join_map_identical: pairs.every((p) => p.governed_identical),
      reference_matches: refMatches,
    },
    answer,
    l2: l2Section(chosen),
    outside: inp.outside,
    manual,
    agent_vs_manual: manual
      ? {
          cold_wall_s_median: round(median(coldLines.filter((l) => l.setting === "think_on").map((l) => l.wall_s)), 1),
          warm_wall_s_median: round(median(warmLines.map((l) => l.wall_s)), 1),
          cold_statements_median: median(coldLines.filter((l) => l.setting === "think_on").map((l) => l.statements)),
          warm_statements_median: median(warmLines.map((l) => l.statements)),
          cold_statement_s_median: round(median(coldLines.filter((l) => l.setting === "think_on").map((l) => l.statement_ms / 1000)), 1),
          warm_statement_s_median: round(median(warmLines.map((l) => l.statement_ms / 1000)), 1),
          no_model_wall_s: coldLines.find((l) => l.setting === "no_model")?.wall_s ?? null,
          no_model_statements: coldLines.find((l) => l.setting === "no_model")?.statements ?? null,
          no_model_statement_s: round((coldLines.find((l) => l.setting === "no_model")?.statement_ms ?? NaN) / 1000, 1),
          manual_statements: manual.statements,
          manual_statement_s: round(manual.statement_ms_total / 1000, 1),
          manual_session_s: manual.session_wall_s,
          manual_decisions: manual.decisions,
        }
      : null,
    ablation,
    timings: toolTimings(chosen.map((c) => c.run)),
    did_not_go_well: inp.selection.did_not_go_well ?? [],
    not_measured: inp.selection.not_measured ?? [],
  };
}

// ---------- markdown ----------

const pct = (x: number | null | undefined, d = 2): string => (typeof x === "number" ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}%` : "n/a");
const s1 = (ms: number | null | undefined): string => (typeof ms === "number" ? `${(ms / 1000).toFixed(1)} s` : "n/a");
const intf = (x: number | null | undefined): string => (typeof x === "number" ? x.toLocaleString("en-US") : "n/a");
const yes = (b: boolean | null | undefined): string => (b === null || b === undefined ? "n/a" : b ? "yes" : "no");
const cell = (s: string): string => s.replace(/\|/gu, "\\|");

function table(header: string[], rows: string[][]): string {
  return [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
}

function tallyText(t: SideTally): string {
  return `${t.made} / ${t.valid ?? "n/a"} / ${t.verified} / ${t.partial} / ${t.rejected} / ${t.unmeasurable}`;
}

export function renderMarkdown(r: EvalReport): string {
  const out: string[] = [];
  const rp = r.reproducibility;
  const l2 = r.l2;
  const a = r.agent_vs_manual;
  const abl = (s: string) => r.ablation.find((x) => x.setting === s) ?? null;
  out.push(`# ${r.title}`);
  out.push("");
  out.push(
    `Every number below is measured and copied from a saved run file or a measured side file; nothing is projected or estimated unless it says so. Runs were made on code ${r.code.map((c) => `\`${c}\``).join(", ")} with \`nemotron-3-nano:4b\` through local Ollama (0 cloud model calls) and Zetaris Lightning 2.4.3.1 through the gateway. The summary JSON is \`docs/eval/summary.json\`; both files are regenerated from the saved runs with \`cd agent && npx tsx src/eval/run.ts --runs <dir of the ablation runs> --gpu <dir of its samples>\` (no gateway or model call). Revenue appears only as the year-on-year change the answer shows.`,
  );
  out.push("");
  out.push("## Headline");
  out.push("");
  out.push(`- **Reproducible:** ${rp.cold_runs} cold runs of the demo question (think on, think off, no model) give the same ${r.answer?.rows.length ?? "n/a"}-row answer in every field (${yes(rp.all_answers_identical)}) and the same numbers and orphans for the ${rp.pairs[0]?.governed_compared ?? "n/a"} governed join-map keys (${yes(rp.governed_join_map_identical)}).`);
  out.push(
    `- **Model vs baseline (L2):** over ${l2.cold_runs_counted} cold runs with the model, the model made ${l2.cold_totals.model.made} key proposals and ${l2.cold_totals.model.verified} were VERIFIED; the deterministic baseline made ${l2.cold_totals.baseline.made} and ${l2.cold_totals.baseline.verified} were VERIFIED. Winner on VERIFIED keys: ${l2.winner}. ${l2.keys_found.model_beyond_any_baseline.length ? `Keys only the model found VERIFIED: ${l2.keys_found.model_beyond_any_baseline.map(shortKey).join(", ")}.` : "Every key the model found VERIFIED was also measured from a baseline proposal (its scored six or its measure queue) in the same run."}`,
  );
  if (r.outside) out.push(`- **Outside checks (L4):** OpenFEMA over HTTPS equals the Zetaris cached views in ${r.outside.fema.filter((f) => f.equal).length} of ${r.outside.fema.length} quarters (rows, declarations, states, per-state counts); ${r.outside.ten_k.filter((k) => k.equal).length} of ${r.outside.ten_k.length} utilities' 10-K service states equal the seed (${r.outside.ten_k.filter((k) => !k.equal).map((k) => `${k.ticker}: the filing also names ${(k.in_filing_not_in_seed ?? []).join(", ")}`).join("; ") || "all equal"}).`);
  if (a) out.push(`- **Manual baseline (L6):** finding and verifying the five keys by hand took ${a.manual_statements} statements and ${a.manual_decisions} decisions (${a.manual_statement_s} s of statement time); the agent asks the user for none of them and runs the whole question in ${a.cold_wall_s_median} s (cold, median) or ${a.warm_wall_s_median} s (warm). A person's time to write and read that SQL is not measured.`);
  const on = abl("think_on");
  const off = abl("think_off");
  const nm = abl("no_model");
  if (on && off && nm) out.push(`- **Nemotron ablation (L12, one run each):** think on ${on.wall_s} s, think off ${off.wall_s} s, no model ${nm.wall_s} s, all with the same answer; ${on.median_tok_s ?? "n/a"} / ${off.median_tok_s ?? "n/a"} tok/s; the model holds ${intf(on.gpu?.ollama_size_vram_mib)} MiB of VRAM (Ollama, ${on.gpu?.quantization ?? "n/a"}, context ${on.gpu?.ollama_context ?? "n/a"}).`);
  out.push(`- **Statements:** ${r.timings.over_20s} of ${r.runs.reduce((s, l) => s + l.statements, 0)} question-path statements took over 20 s (slowest: ${r.timings.statements[0]?.name ?? "n/a"} at ${intf(r.timings.statements[0]?.max_ms)} ms).`);
  out.push("");
  out.push("## Runs");
  out.push("");
  out.push(
    table(
      ["Run", "Label", "Code", "Setting", "Mode", "Wall", "Chunks", "Skipped", "Planner calls (valid / first try)", "Fallback steps", "Statements (slowest)", "> 20 s", "Answer rows", "Join-map rows"],
      r.runs.map((l) => [
        `\`${l.run_id}\``,
        l.label,
        `\`${l.code}\``,
        l.setting.replace("_", " "),
        `${l.mode} ${l.quarter}`,
        `${l.wall_s.toFixed(1)} s`,
        String(l.chunks ?? "n/a"),
        String(l.skipped_chunks ?? "n/a"),
        `${l.planner_calls} (${l.planner_valid} / ${l.planner_valid_first_try})`,
        String(l.fallback_steps ?? "n/a"),
        `${l.statements} (${l.slowest_statement ? `${l.slowest_statement.template} ${intf(l.slowest_statement.ms)} ms` : "n/a"})`,
        String(l.over_20s),
        String(l.answer_rows),
        String(l.join_rows),
      ]),
    ),
  );
  out.push("");
  out.push("A fallback step is a checklist step the host took itself after the planner's reply was invalid twice or chose nothing; in the no-model run every step is a fallback step.");
  out.push("");

  // 1. reproducibility
  out.push("## 1. Reproducibility of the cold question");
  out.push("");
  out.push(
    `${rp.cold_runs} cold runs of the CY2025Q1 demo question, compared pairwise. The answer comparison covers every field of every row (utility, states, declarations by incident type, revenue tag, both values and the change, the stations, both degree-day totals and the change); the join-map comparison covers verdict, matched and total rows, matched and total distinct keys, and orphans for every key both runs measured. **All answers identical: ${yes(rp.all_answers_identical)}. Governed join-map keys identical in every pair: ${yes(rp.governed_join_map_identical)}.**`,
  );
  out.push("");
  const only = (keys: string[], p: PairCompare) => keys.map((k) => `${shortKey(k)} [${p.proposers[k] ?? "?"}]`).join(", ") || "none";
  out.push(
    table(
      ["Run A", "Run B", "Answer rows", "Answer identical", "Join-map rows", "Common keys", "Identical on common", "Governed keys compared (identical)", "Only in A [proposed by]", "Only in B [proposed by]"],
      rp.pairs.map((p) => [
        `\`${p.a}\``,
        `\`${p.b}\``,
        `${p.answer_rows[0]} / ${p.answer_rows[1]}`,
        yes(p.answer_identical),
        `${p.join_rows[0]} / ${p.join_rows[1]}`,
        String(p.join_common),
        yes(p.join_identical_on_common),
        `${p.governed_compared} (${yes(p.governed_identical)})`,
        only(p.only_in_a, p),
        only(p.only_in_b, p),
      ]),
    ),
  );
  out.push("");
  out.push(
    "Every key measured in two runs carries the same numbers and orphans in both. Keys measured in one run only are the model's own menu choices, or baseline pairs that depend on which views the planner probed first (the baseline scores pairs over the probed columns, so a different probe order gives it different candidates).",
  );
  if (r.references.length) {
    out.push("");
    out.push(`Against the Day-1 reference runs (code before the Day-2 fixes, same quarter): ${rp.reference_matches.filter((m) => m.identical).length} of ${rp.reference_matches.length} Day-2 answers identical (${rp.reference_matches.map((m) => `\`${m.run_id}\` vs \`${m.reference}\` ${m.identical ? "identical" : "DIFFERENT"}`).join("; ")}).`);
  }
  out.push("");
  if (r.answer) {
    out.push(`The answer (run \`${r.answer.run_id}\`, ${r.answer.quarter} against ${r.answer.previous}; weather ${r.answer.weather_status}):`);
    out.push("");
    out.push(
      table(
        ["Utility", "Declared states served (declarations)", "Revenue change (tag)", "Weather: degree-day change (stations)"],
        r.answer.rows.map((x) => [
          `${x.ticker ?? x.name}`,
          x.states,
          x.revenue_change_pct !== null ? `${pct(x.revenue_change_pct)} (${x.revenue_tag})` : `not compared (${x.revenue_tag} now, a different tag a year earlier)`,
          x.tdd_change_pct !== null ? `${pct(x.tdd_change_pct)} (${x.stations})` : "n/a",
        ]),
      ),
    );
    out.push("");
  }

  // 2. L2
  out.push("## 2. The model's key proposals against the deterministic baseline (L2)");
  out.push("");
  out.push(
    "Both sides propose join keys from the same probes in the same run, and every valid proposal is measured by the same Lightning SQL statement (a named join-map statement for the governed keys, the generic `match_rate` statement otherwise). The model chooses from an enumerated menu of the probed columns and the closed transform set; the baseline is the deterministic column-name heuristic (its top six are scored). Columns: made / valid / VERIFIED / PARTIAL / REJECTED / unmeasurable. In the warm run the baseline's VERIFIED keys are recalled from memory (measured in an earlier run), not re-measured.",
  );
  out.push("");
  out.push(
    table(
      ["Run", "Setting", "Mode", "Model", "Model VERIFIED keys", "Baseline", "Baseline VERIFIED keys"],
      l2.rows.map((x) => [
        `\`${x.run_id}\``,
        x.setting.replace("_", " "),
        x.mode,
        x.setting === "no_model" ? "n/a (no model)" : tallyText(x.model),
        x.setting === "no_model" ? "n/a" : x.model.verified_keys.map(shortKey).join(", ") || "none",
        tallyText(x.baseline),
        `${x.baseline.verified_keys.map(shortKey).join(", ") || "none"}${x.baseline.recalled_keys.length ? ` (${x.baseline.recalled_keys.length} recalled)` : ""}`,
      ]),
    ),
  );
  out.push("");
  const ct = l2.cold_totals;
  const t = l2.totals;
  out.push(
    `Cold runs with the model (${l2.cold_runs_counted}): model made ${ct.model.made}, valid ${ct.model.valid}, VERIFIED ${ct.model.verified}, PARTIAL ${ct.model.partial}, REJECTED ${ct.model.rejected}, unmeasurable ${ct.model.unmeasurable}, invalid schema ${ct.model.invalid_schema}; baseline made ${ct.baseline.made}, valid ${ct.baseline.valid}, VERIFIED ${ct.baseline.verified}, PARTIAL ${ct.baseline.partial}, REJECTED ${ct.baseline.rejected}, unmeasurable ${ct.baseline.unmeasurable}. With the warm run (${l2.runs_counted} runs): model VERIFIED ${t.model.verified} of ${t.model.made}, baseline ${t.baseline.verified} of ${t.baseline.made}. **Winner on VERIFIED keys: ${l2.winner}.**`,
  );
  out.push("");
  out.push(
    `Distinct keys each side found VERIFIED by measuring them (runs with the model): model ${l2.keys_found.model.map(shortKey).join(", ") || "none"}; baseline ${l2.keys_found.baseline.map(shortKey).join(", ") || "none"}. Model keys outside the baseline's scored six: ${l2.keys_found.only_model.map(shortKey).join(", ") || "none"}; of these, VERIFIED by no baseline proposal at all (scored six or measure queue) in any run: ${l2.keys_found.model_beyond_any_baseline.map(shortKey).join(", ") || "none"}.`,
  );
  out.push("");

  // 3. outside checks
  out.push("## 3. Outside checks (L4)");
  out.push("");
  if (r.outside) {
    out.push("Numbers the agent did not compute, fetched over HTTPS outside Zetaris (`agent/src/eval/outside.ts`) and compared with the cached views read through the gateway (`docs/eval/outside-checks.json`). The OpenFEMA URL is the registrar's own (major-disaster filter, declaration date inside the quarter).");
    out.push("");
    out.push(
      table(
        ["Quarter", "OpenFEMA API: rows / declarations / states", "Zetaris cached view: rows / declarations / states", "Per-state declarations equal", "Equal"],
        r.outside.fema.map((f) => [
          f.quarter,
          `${f.outside.rows} / ${f.outside.declarations} / ${f.outside.states}`,
          `${f.zetaris.rows} / ${f.zetaris.declarations} / ${f.zetaris.states}`,
          yes(JSON.stringify(f.outside.by_state) === JSON.stringify(f.zetaris.by_state)),
          yes(f.equal),
        ]),
      ),
    );
    out.push("");
    out.push(
      "Served states: the seed notes cite each utility's FY2024 Form 10-K (Item 1, service territory). For two utilities in the answer, the filing was fetched from SEC EDGAR with the declared User-Agent and every sentence naming a service territory or customers together with a state was read; the states those sentences name are compared with the seed.",
    );
    out.push("");
    out.push(
      table(
        ["Utility", "Filing", "States in the seed", "States the filing names in service sentences", "In the filing only", "Equal", "Changes an answer"],
        r.outside.ten_k.map((k) => {
          const extra = k.in_filing_not_in_seed ?? [];
          const hit = r.outside!.fema.filter((f) => extra.some((s) => (f.outside.by_state[s] ?? 0) > 0)).map((f) => f.quarter);
          return [
            `${k.ticker}${k.name ? ` (${k.name})` : ""}`,
            k.filing ? `${k.filing.form} for ${k.filing.report_date}, filed ${k.filing.filing_date}` : (k.not_run ?? k.error ?? "n/a"),
            (k.seed_states ?? []).join(", ") || "n/a",
            (k.filing_states ?? []).join(", ") || "n/a",
            extra.join(", ") || "none",
            yes(k.equal),
            extra.length ? (hit.length ? `yes (${hit.join(", ")})` : `no: ${extra.join(", ")} has no major-disaster declaration in ${r.outside!.fema.map((f) => f.quarter).join(" or ")}`) : "no",
          ];
        }),
      ),
    );
    out.push("");
  } else {
    out.push("Not run.");
    out.push("");
  }

  // 4. manual baseline
  out.push("## 4. Manual baseline: the five keys by hand (L6)");
  out.push("");
  if (r.manual && a) {
    const m = r.manual;
    out.push(m.note ?? "");
    out.push("");
    out.push(
      `**Measured:** ${m.statements} statements (${Object.entries(m.by_class).map(([k, v]) => `${v} ${k}`).join(", ")}; ${m.failed_statements} refused or failed), ${m.lookups} lookups without a statement, ${(m.statement_ms_total / 1000).toFixed(1)} s of statement time, ${m.decisions} decisions, ${m.session_wall_s.toFixed(1)} s from the first step to the end of the last statement.`,
    );
    out.push("");
    out.push(
      table(
        ["", "Statements", "Statement time", "Decisions asked of the user", "Wall", "Also produces"],
        [
          ["By hand (this session)", String(a.manual_statements), `${a.manual_statement_s} s`, String(a.manual_decisions), `${a.manual_session_s} s (not a person's time: SQL pre-written, reading time not human)`, "the five keys and their orphans"],
          ["Agent, cold (think on, median)", String(a.cold_statements_median), `${a.cold_statement_s_median} s`, "0 (one command)", `${a.cold_wall_s_median} s`, "keys, answer table with provenance, USL check, live DQ, checked note"],
          ["Agent, warm", String(a.warm_statements_median), `${a.warm_statement_s_median} s`, "0 (one command)", `${a.warm_wall_s_median} s`, "the same for Q1 2024, with the verified keys recalled from memory"],
          ["Agent, cold, no model", String(a.no_model_statements), `${a.no_model_statement_s} s`, "0 (one command)", `${a.no_model_wall_s} s`, "the same answer and governed keys, template note"],
        ],
      ),
    );
    out.push("");
    out.push(table(["Key", "Verdict", "Matched / total", "Orphans"], m.keys.map((k) => [k.key, k.verdict, `${k.matched} / ${k.total}`, k.orphans.join(", ") || "none"])));
    out.push("");
    out.push("Each verdict, count and orphan found by hand equals the agent's join-map row for the same key in every cold run of section 1.");
    out.push("");
    out.push(
      table(
        ["#", "Statement", "Parameters", "ms", "Rows", "What it showed", "Decision"],
        m.steps.map((s) => [String(s.n), s.template, Object.entries(s.params).map(([k, v]) => `${k}=${v}`).join(" "), intf(s.elapsed_ms), String(s.rows), s.result, s.decision || "-"]),
      ),
    );
    out.push("");
  } else {
    out.push("Not run.");
    out.push("");
  }

  // 5. ablation
  out.push("## 5. Nemotron ablation on the cold question (L12)");
  out.push("");
  out.push(
    "The same cold CY2025Q1 question three times on the same code, one after another, with the GPU sampled every 500 ms by `nvidia-smi` (whole-card memory and utilisation) and Ollama's `/api/ps` read before, 60 s into and after each run. Think on and think off apply to the planner (the note is always written with think off). No model: the host takes every checklist step (the baseline's six proposals stand in for the model's) and the note is the template. Tokens and tok/s are Ollama's counts (`eval_count`, `eval_duration`).",
  );
  out.push("");
  out.push(
    table(
      ["Setting", "Run", "Wall", "Chunks", "Planner calls (valid / first try / repaired)", "Fallback steps", "Output tokens", "Median planner tok/s", "Note tok/s", "Model proposals m/v/V/P/R/u", "Note (verifier)", "Answer = think on", "Card VRAM first / peak (MiB)", "GPU util median / peak"],
      r.ablation.map((x) => [
        x.setting.replace("_", " "),
        `\`${x.run_id}\``,
        `${x.wall_s.toFixed(1)} s`,
        String(x.chunks ?? "n/a"),
        `${x.planner_calls} (${x.planner_valid} / ${x.planner_valid_first_try} / ${x.planner_repaired})`,
        String(x.fallback_steps ?? "n/a"),
        intf(x.tokens_out),
        x.median_tok_s?.toFixed(1) ?? "n/a",
        x.memo_tok_s?.toFixed(1) ?? "n/a",
        x.setting === "no_model" ? "n/a (no model)" : tallyText(x.model),
        `${x.note.source ?? "n/a"} ${x.note.words ?? "?"} words${x.note.verifier_checked ? `; drafts rejected for words ${x.note.drafts_rejected_for_words}, final issues ${x.note.final_issues}` : ""}`,
        x.answer_identical_to_think_on === null ? "(reference)" : yes(x.answer_identical_to_think_on),
        x.gpu ? `${intf(x.gpu.mem_first_mib)} / ${intf(x.gpu.mem_peak_mib)}` : "not measured",
        x.gpu ? `${x.gpu.util_median_pct ?? "n/a"}% / ${x.gpu.util_peak_pct ?? "n/a"}%` : "not measured",
      ]),
    ),
  );
  out.push("");
  const g = on?.gpu ?? off?.gpu ?? null;
  if (g) {
    out.push(
      `The model: Ollama reports \`${g.ollama_model}\` (${g.parameters}, ${g.quantization}) resident with ${intf(g.ollama_size_vram_mib)} MiB in VRAM at context ${g.ollama_context}, the same before, during and after each run; it stayed resident through all three runs (Ollama keep-alive), so the whole-card numbers include it in every row, the no-model row too, and they move with other programs on the card (desktop, browsers): the card's peak is not the model's peak. GPU utilisation separates the settings: the no-model run leaves the card at the desktop's idle level.`,
    );
    out.push("");
  }
  const onWalls = r.runs.filter((l) => l.mode === "cold" && l.setting === "think_on").map((l) => l.wall_s);
  if (on && off && nm && onWalls.length) {
    out.push(
      `One run per setting. The ${onWalls.length} cold think-on runs in this report took ${Math.min(...onWalls).toFixed(1)}-${Math.max(...onWalls).toFixed(1)} s, a spread of ${(Math.max(...onWalls) - Math.min(...onWalls)).toFixed(1)} s within one setting; the ${(on.wall_s - off.wall_s).toFixed(1)} s gap between the think-on and think-off runs is ${Math.abs(on.wall_s - off.wall_s) <= Math.max(...onWalls) - Math.min(...onWalls) ? "inside" : "of the same size as"} that spread, and with one think-off run it is not claimed as an effect of thinking. What the runs do show: output tokens (${intf(on.tokens_out)} think on, ${intf(off.tokens_out)} think off), fallback steps (${on.fallback_steps} and ${off.fallback_steps}), and the no-model run, which reaches the same answer and governed keys in ${(nm.wall_s / on.wall_s * 100).toFixed(0)}% of the think-on wall time.`,
    );
  }
  out.push("");

  // 6. timings
  out.push("## 6. Timings per tool and per statement class");
  out.push("");
  const tm = r.timings;
  out.push(`Over the ${r.runs.length} runs above. Statements over 20 s: ${tm.over_20s}. Planner calls: ${tm.planner.n}, median ${s1(tm.planner.median_ms)}, p90 ${s1(tm.planner.p90_ms)}, max ${s1(tm.planner.max_ms)}. A tool's time includes its statements; \`finalize\` includes the note (model drafts and the verifier).`);
  out.push("");
  out.push(table(["Tool", "Calls", "Median", "p90", "Max", "Total"], tm.tools.map((x) => [x.name, String(x.n), s1(x.median_ms), s1(x.p90_ms), s1(x.max_ms), s1(x.total_ms)])));
  out.push("");
  out.push(table(["Statement class", "Statements", "Median ms", "p90 ms", "Max ms", "Total"], tm.classes.map((x) => [x.name, String(x.n), intf(x.median_ms), intf(x.p90_ms), intf(x.max_ms), s1(x.total_ms)])));
  out.push("");
  out.push(table(["Template", "Class", "Statements", "Median ms", "p90 ms", "Max ms"], tm.statements.map((x) => [x.name, x.class ?? "", String(x.n), intf(x.median_ms), intf(x.p90_ms), intf(x.max_ms)])));
  out.push("");

  // 7.
  out.push("## 7. What did not go well");
  out.push("");
  for (const d of r.did_not_go_well) out.push(`- ${d}`);
  out.push("");
  out.push("## Not measured");
  out.push("");
  for (const d of r.not_measured) out.push(`- ${d}`);
  return out.join("\n");
}

/** A join-map key in short form for tables: pair keys keep their columns, named routes their family. */
export function shortKey(key: string): string {
  const m = /^pair:(.+)\|(.+)$/u.exec(key);
  if (m) return `${m[1]!.replace(/~/u, " ~ ")} (${m[2]})`;
  return key;
}
