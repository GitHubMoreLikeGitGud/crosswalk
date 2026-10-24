// Evaluation report: measured numbers only, every one read from a file (saved runs, the DQ
// onboarding file, the join-map measurements) and never typed by hand. The pure functions here
// take parsed documents and return the report document and its markdown; run.ts does the I/O.

import { missingFields, type EvidenceRecord } from "../evidence/store.ts";

/** The parts of a saved run.json the evaluation reads (a trimmed fixture satisfies it). */
export interface EvalRun {
  run_id: string;
  cik: string;
  period: string;
  previous_period: string;
  claim: string;
  started_at: string;
  wall_ms: number;
  skipped_steps: { item: string; memoryId: string; note: string }[];
  summary: {
    chunks: number;
    planner_calls: number;
    planner_valid: number;
    planner_valid_first_try: number;
    planner_repaired: number;
    /** Repair rounds run with think off after an empty, length-cut reply (absent in runs before that change). */
    planner_repairs_think_off?: number;
    fallback_steps: number;
    tool_calls: number;
    tool_calls_by_model: number;
    tool_failures: number;
    median_planner_tokens_per_s: number | null;
    max_carryover_tokens_estimated?: number;
    saving_vs_naive_estimated?: number;
  };
  telemetry: { model: string | null; think: boolean; memo_tokens_per_s: number | null; cloud_model_calls: number; refused_model_hosts: number; refused_gateway_hosts: number };
  timings_ms: Record<string, number>;
  card: {
    utility: { cik: string; name: string | null; stations: string[] } | null;
    verdict: { claim: string; verdict: string; ratio: number | null; confidence: string; withheld_reason: string | null } | null;
    growth: { tag: string; g: number; current_accn: string; previous_original_accn: string | null; previous_comparative_accn: string | null; recast: boolean } | null;
    weather: { delta_w: number; coverage: number; stations_used: string[]; stations_missing: string[] } | null;
    peers: { count: number; by_tag: Record<string, number>; with_weather: number; excluded: { cik: string; reason: string }[] } | null;
    attribution: {
      beta: number;
      theil_sen: number;
      weather: number;
      industry: number;
      remainder: number;
      ranges: Record<"beta" | "weather" | "industry" | "remainder", { lo: number; hi: number }>;
      bootstrap: { resamples: number; valid: number; skipped_zero_variance: number; seed: number };
      coverage: number;
      confidence: string;
      claim: { ratio: number; verdict: string };
    } | null;
    dq: { label: string; ranAt: string | null; elapsedS: number | null; run: { total: number; valid: number; invalid: number } | null; invalidRows: number; targetCoverage: number | null } | null;
    recast_conflicts: unknown[];
    memo: { source: "model" | "template"; words: number; attempts: number; attempts_detail: unknown[] } | null;
    claims: { text: string; evidenceIds: string[] }[];
  };
  evidence: EvidenceRecord[];
  quality?: { e_cov: number; e_complete: number; claims: number; records: number };
}

export interface SeedUtility {
  cik: string;
  name: string;
  station_ids: string[];
}

export interface SeedStation {
  id: string;
  state: string;
  name: string;
}

export interface DqFile {
  ran_at: string;
  rule: string;
  table: string;
  elapsed_s: number;
  ok: boolean;
  run: { total: number; valid: number; invalid: number; elapsed_s: number } | null;
  invalid_rows: unknown[];
  statements: { template_id: string; elapsed_s: number | null; row_count?: number; error: string | null }[];
}

/** scripts/eval_joinmap.py output (data/eval/joinmap.json). */
export interface JoinMapFile {
  measured_at: string;
  bound_s: number;
  login: string | null;
  elapsed_s: number | null;
  statements: { id: string; group: string; tag?: string; period?: string; elapsed_ms: number | null; row_count: number | null; measured: boolean; timeout: boolean; error: string | null; sql_sha256: string }[];
  results: {
    seeds: number;
    cik_lpad: Record<string, { tag: string; period: string; seeds: number; lpad_matched?: number; in_count?: number | null; agree?: boolean | null; measured?: boolean; elapsed_ms: number | null }>;
    cik_no_lpad_control: { matched: number | null; elapsed_ms: number | null; measured: boolean };
    cik_any_tag: Record<string, { seeds_with_a_fact: number | null; seeds: number; elapsed_ms: number | null; measured: boolean }>;
    loc: Record<string, { tag: string; period: string; present?: number; equal?: number; different?: number; missing?: number; measured?: boolean; elapsed_ms?: number | null }>;
    loc_differing_rows: { tag: string; period: string; cik: string; name: string; loc: string | null; state: string }[];
    sic: {
      measured: boolean;
      seeds: number;
      orphans: { cik: string; name: string; sic: string }[];
      joined: number | null;
      elapsed_ms: number | null;
      recorded_run_dq: { source: string; statement: string; result: { type: string; total: number; valid: number; invalid: number }; elapsed_s: number; invalid_record: Record<string, string>; invalid_record_statement: string; invalid_record_elapsed_s: number; note: string };
    };
    station: {
      seed_stations: number;
      measured: boolean;
      elapsed_ms: number | null;
      bound_s: number | null;
      timeout: boolean;
      error: string | null;
      skipped: boolean;
      usl_rows?: number;
      present?: number;
      state_equal?: number;
      state_different?: { id: string; seed_state: string; usl_state: string }[];
      missing?: string[];
      extra_in_usl?: string[];
    };
  } | null;
}

export interface RunSummary {
  run_id: string;
  cik: string;
  utility: string | null;
  period: string;
  claim: string;
  started_at: string;
  source: string;
  mode: "cold" | "warm";
  chunks: number;
  wall_ms: number;
  planner_calls: number;
  valid_first_try: number;
  repaired: number;
  repairs_think_off: number | null;
  fallbacks: number;
  tool_calls: number;
  tool_calls_by_model: number;
  median_tokens_per_s: number | null;
  memo: { source: "model" | "template" | null; words: number | null; attempts: number | null; tokens_per_s: number | null; drafts: { attempt: number; ok: boolean; words: number | null; unknown_numbers: number }[] };
  evidence: { records: number; complete_fields: number; unresolved_object_names: number; e_complete: number; e_complete_ratio: number; matches_run_quality: boolean | null };
  claims: { total: number; with_evidence: number; e_cov: number; matches_run_quality: boolean | null };
  skipped_steps: { item: string; memoryId: string }[];
  weather_quarter_ms: { current: number | null; previous: number | null };
  memo_ms: number | null;
  verdict: string | null;
  confidence: string | null;
  dq_label: string | null;
  recast_conflicts: number;
  cloud_model_calls: number;
  refused_hosts: number;
  model: string | null;
  think: boolean;
}

export interface UtilityCoverage {
  cik: string;
  name: string;
  stations: number;
  present: number;
  coverage: Record<string, number | null>;
  min: number | null;
  complete: boolean;
}

export interface CoverageSection {
  from_run: string | null;
  periods: string[];
  stations_in_rows: Record<string, number>;
  utilities: UtilityCoverage[];
  summary: { utilities: number; with_every_station: number; min_coverage: number | null; below_0_9: number; not_covered: number };
}

export interface AttributionSection {
  cik: string;
  utility: string | null;
  from_run: string;
  runs: string[];
  identical_across_runs: boolean;
  tag: string | null;
  g: number | null;
  recast: boolean | null;
  current_accn: string | null;
  previous_original_accn: string | null;
  previous_comparative_accn: string | null;
  delta_w: number | null;
  peers: number | null;
  beta: number;
  beta_range: { lo: number; hi: number };
  theil_sen: number;
  weather: { value: number; lo: number; hi: number };
  industry: { value: number; lo: number; hi: number };
  remainder: { value: number; lo: number; hi: number };
  bootstrap: { resamples: number; valid: number; skipped_zero_variance: number; seed: number };
  coverage: number;
  confidence: string;
  ratio: number;
  verdict: string;
  recast_conflicts: number;
}

export interface ModeStats {
  runs: number;
  run_ids: string[];
  chunks_mean: number | null;
  wall_ms_mean: number | null;
  wall_ms_min: number | null;
  wall_ms_max: number | null;
  planner_calls_mean: number | null;
  skipped_steps_mean: number | null;
}

export interface EvalReport {
  generated_at: string;
  label: "measured";
  inputs: {
    runs: { run_id: string; cik: string; utility: string | null; period: string; claim: string; started_at: string; source: string }[];
    dq_file: boolean;
    joinmap_file: boolean;
    seeds: { utilities: number; stations: number };
  };
  join_map: JoinMapFile | null;
  peers: { from_run: string; target: string; utility: string | null; period: string; count: number; by_tag: Record<string, number>; with_weather: number; excluded: { cik: string; reason: string }[]; identical_across_runs: boolean; runs: string[] } | null;
  coverage: CoverageSection;
  attribution: AttributionSection[];
  dq: (DqFile & { sic_fk: JoinMapFile["results"] extends infer R ? (R extends { sic: { recorded_run_dq: infer Q } } ? Q | null : null) : null }) | null;
  runs: RunSummary[];
  totals: {
    runs: number;
    planner_calls: number;
    valid_first_try: number;
    repaired: number;
    repairs_think_off: number | null;
    fallbacks: number;
    tool_calls_by_model: number;
    memo_drafts: number;
    memo_drafts_with_unknown_numbers: number;
    model_memos: number;
    template_memos: number;
    evidence_records: number;
    evidence_complete: number;
    claims: number;
    claims_with_evidence: number;
    cloud_model_calls: number;
    refused_hosts: number;
  };
  cold_vs_warm: { all: { cold: ModeStats; warm: ModeStats }; per_cik: Record<string, { utility: string | null; cold: ModeStats; warm: ModeStats }> };
}

export interface BuildInputs {
  runs: { run: EvalRun; source: string }[];
  dq: DqFile | null;
  joinmap: JoinMapFile | null;
  utilities: SeedUtility[];
  stations: SeedStation[];
  now?: Date;
}

const PLACEHOLDER = /\{\w+\}/u;

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function byStart(a: { started_at: string }, b: { started_at: string }): number {
  return a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0;
}

export function runMode(run: Pick<EvalRun, "skipped_steps">): "cold" | "warm" {
  return run.skipped_steps.length ? "warm" : "cold";
}

interface DraftDetail {
  attempt?: number;
  ok?: boolean;
  wordCount?: number;
  unknownNumbers?: unknown[];
}

export function summariseRun(run: EvalRun, source: string): RunSummary {
  const records = run.evidence ?? [];
  let completeFields = 0;
  let unresolved = 0;
  let complete = 0;
  for (const rec of records) {
    const missing = missingFields(rec);
    const placeholder = typeof rec.zetaris_object === "string" && PLACEHOLDER.test(rec.zetaris_object);
    if (!missing.length) completeFields += 1;
    if (placeholder) unresolved += 1;
    if (!missing.length && !placeholder) complete += 1;
  }
  const claims = run.card.claims ?? [];
  const withEvidence = claims.filter((c) => c.evidenceIds.length > 0).length;
  const eCov = claims.length ? withEvidence / claims.length : 0;
  const eComplete = records.length ? complete / records.length : 0;
  const q = run.quality;
  const drafts = ((run.card.memo?.attempts_detail ?? []) as DraftDetail[]).map((d, i) => ({
    attempt: d.attempt ?? i + 1,
    ok: d.ok === true,
    words: typeof d.wordCount === "number" ? d.wordCount : null,
    unknown_numbers: Array.isArray(d.unknownNumbers) ? d.unknownNumbers.length : 0,
  }));
  return {
    run_id: run.run_id,
    cik: run.cik,
    utility: run.card.utility?.name ?? null,
    period: run.period,
    claim: run.claim,
    started_at: run.started_at,
    source,
    mode: runMode(run),
    chunks: run.summary.chunks,
    wall_ms: run.wall_ms,
    planner_calls: run.summary.planner_calls,
    valid_first_try: run.summary.planner_valid_first_try,
    repaired: run.summary.planner_repaired,
    repairs_think_off: typeof run.summary.planner_repairs_think_off === "number" ? run.summary.planner_repairs_think_off : null,
    fallbacks: run.summary.fallback_steps,
    tool_calls: run.summary.tool_calls,
    tool_calls_by_model: run.summary.tool_calls_by_model,
    median_tokens_per_s: run.summary.median_planner_tokens_per_s,
    memo: {
      source: run.card.memo?.source ?? null,
      words: run.card.memo?.words ?? null,
      attempts: run.card.memo?.attempts ?? null,
      tokens_per_s: run.telemetry.memo_tokens_per_s,
      drafts,
    },
    evidence: {
      records: records.length,
      complete_fields: completeFields,
      unresolved_object_names: unresolved,
      e_complete: complete,
      e_complete_ratio: eComplete,
      matches_run_quality: q ? q.records === records.length && Math.abs(q.e_complete - completeFields / Math.max(1, records.length)) < 1e-9 : null,
    },
    claims: { total: claims.length, with_evidence: withEvidence, e_cov: eCov, matches_run_quality: q ? q.claims === claims.length && Math.abs(q.e_cov - eCov) < 1e-9 : null },
    skipped_steps: run.skipped_steps.map((s) => ({ item: s.item, memoryId: s.memoryId })),
    weather_quarter_ms: { current: run.timings_ms["weather_quarter.current"] ?? null, previous: run.timings_ms["weather_quarter.previous"] ?? null },
    memo_ms: run.timings_ms["memo"] ?? null,
    verdict: run.card.verdict?.verdict ?? null,
    confidence: run.card.verdict?.confidence ?? null,
    dq_label: run.card.dq?.label ?? null,
    recast_conflicts: run.card.recast_conflicts?.length ?? 0,
    cloud_model_calls: run.telemetry.cloud_model_calls,
    refused_hosts: run.telemetry.refused_model_hosts + run.telemetry.refused_gateway_hosts,
    model: run.telemetry.model,
    think: run.telemetry.think,
  };
}

/** Station coverage per period from a run's weather_quarter evidence rows. */
export function stationCoverage(run: EvalRun): Record<string, Map<string, number>> {
  const out: Record<string, Map<string, number>> = {};
  for (const rec of run.evidence ?? []) {
    if (rec.template_id !== "weather_quarter" || !rec.rows || !rec.columns) continue;
    const year = rec.params?.year;
    const quarter = rec.params?.quarter;
    if (!year || !quarter) continue;
    const period = `CY${year}Q${quarter}`;
    const si = rec.columns.indexOf("station_id");
    const ci = rec.columns.indexOf("coverage");
    if (si < 0 || ci < 0) continue;
    const m = out[period] ?? new Map<string, number>();
    for (const row of rec.rows) {
      const id = row[si];
      const cov = row[ci];
      if (typeof id === "string" && typeof cov === "number") m.set(id, cov);
    }
    out[period] = m;
  }
  return out;
}

/** Utility coverage = min over its stations per period (SPEC 11.8); min of the two periods. */
export function coveragePerUtility(run: EvalRun | null, utilities: SeedUtility[], periods: string[]): CoverageSection {
  const cov = run ? stationCoverage(run) : {};
  const rows: UtilityCoverage[] = utilities.map((u) => {
    const perPeriod: Record<string, number | null> = {};
    let present = u.station_ids.length;
    for (const p of periods) {
      const m = cov[p];
      const values = u.station_ids.map((s) => m?.get(s)).filter((v): v is number => typeof v === "number");
      present = Math.min(present, values.length);
      perPeriod[p] = values.length === u.station_ids.length && values.length > 0 ? Math.min(...values) : null;
    }
    const mins = periods.map((p) => perPeriod[p]).filter((v): v is number => typeof v === "number");
    const complete = mins.length === periods.length && periods.length > 0;
    return { cik: u.cik, name: u.name, stations: u.station_ids.length, present, coverage: perPeriod, min: complete ? Math.min(...mins) : null, complete };
  });
  const mins = rows.map((r) => r.min).filter((v): v is number => typeof v === "number");
  return {
    from_run: run?.run_id ?? null,
    periods,
    stations_in_rows: Object.fromEntries(periods.map((p) => [p, cov[p]?.size ?? 0])),
    utilities: rows,
    summary: {
      utilities: rows.length,
      with_every_station: rows.filter((r) => r.complete).length,
      min_coverage: mins.length ? Math.min(...mins) : null,
      below_0_9: mins.filter((v) => v < 0.9).length,
      not_covered: rows.filter((r) => !r.complete).length,
    },
  };
}

function attributionKey(run: EvalRun): string {
  const a = run.card.attribution;
  return a ? JSON.stringify([a.beta, a.weather, a.industry, a.remainder, a.ranges, a.bootstrap]) : "";
}

export function attributionSections(runs: EvalRun[]): AttributionSection[] {
  const byCik = new Map<string, EvalRun[]>();
  for (const r of runs) {
    if (!r.card.attribution) continue;
    const list = byCik.get(r.cik) ?? [];
    list.push(r);
    byCik.set(r.cik, list);
  }
  const out: AttributionSection[] = [];
  for (const [cik, list] of byCik) {
    list.sort(byStart);
    const latest = list[list.length - 1]!;
    const a = latest.card.attribution!;
    const keys = new Set(list.map(attributionKey));
    out.push({
      cik,
      utility: latest.card.utility?.name ?? null,
      from_run: latest.run_id,
      runs: list.map((r) => r.run_id),
      identical_across_runs: keys.size === 1,
      tag: latest.card.growth?.tag ?? null,
      g: latest.card.growth?.g ?? null,
      recast: latest.card.growth?.recast ?? null,
      current_accn: latest.card.growth?.current_accn ?? null,
      previous_original_accn: latest.card.growth?.previous_original_accn ?? null,
      previous_comparative_accn: latest.card.growth?.previous_comparative_accn ?? null,
      delta_w: latest.card.weather?.delta_w ?? null,
      peers: latest.card.peers?.count ?? null,
      beta: a.beta,
      beta_range: a.ranges.beta,
      theil_sen: a.theil_sen,
      weather: { value: a.weather, ...a.ranges.weather },
      industry: { value: a.industry, ...a.ranges.industry },
      remainder: { value: a.remainder, ...a.ranges.remainder },
      bootstrap: a.bootstrap,
      coverage: a.coverage,
      confidence: a.confidence,
      ratio: a.claim.ratio,
      verdict: a.claim.verdict,
      recast_conflicts: latest.card.recast_conflicts?.length ?? 0,
    });
  }
  return out.sort((x, y) => (x.cik < y.cik ? -1 : 1));
}

function modeStats(list: RunSummary[]): ModeStats {
  const walls = list.map((r) => r.wall_ms);
  return {
    runs: list.length,
    run_ids: list.map((r) => r.run_id),
    chunks_mean: mean(list.map((r) => r.chunks)),
    wall_ms_mean: mean(walls),
    wall_ms_min: walls.length ? Math.min(...walls) : null,
    wall_ms_max: walls.length ? Math.max(...walls) : null,
    planner_calls_mean: mean(list.map((r) => r.planner_calls)),
    skipped_steps_mean: mean(list.map((r) => r.skipped_steps.length)),
  };
}

export function buildReport(inputs: BuildInputs): EvalReport {
  const sorted = [...inputs.runs].sort((a, b) => byStart(a.run, b.run));
  const runs = sorted.map((r) => summariseRun(r.run, r.source));
  const evalRuns = sorted.map((r) => r.run);

  // Peers: the latest run of the demo utility (FirstEnergy when present, else the latest run).
  const withPeers = evalRuns.filter((r) => r.card.peers);
  const feRuns = withPeers.filter((r) => r.cik === "0001031296");
  const peerPool = feRuns.length ? feRuns : withPeers;
  const peerRun = peerPool.length ? peerPool[peerPool.length - 1]! : null;
  const peerKeys = new Set(peerPool.map((r) => JSON.stringify([r.card.peers!.count, r.card.peers!.by_tag, r.card.peers!.excluded])));

  // Coverage: the latest run whose weather rows cover both periods for the most stations.
  const periods = evalRuns.length ? [evalRuns[evalRuns.length - 1]!.period, evalRuns[evalRuns.length - 1]!.previous_period] : ["CY2025Q1", "CY2024Q1"];
  let coverageRun: EvalRun | null = null;
  let best = -1;
  for (const r of evalRuns) {
    const cov = stationCoverage(r);
    const n = Math.min(...periods.map((p) => cov[p]?.size ?? 0));
    if (n >= best) {
      best = n;
      coverageRun = r;
    }
  }

  const cold = runs.filter((r) => r.mode === "cold");
  const warm = runs.filter((r) => r.mode === "warm");
  const perCik: EvalReport["cold_vs_warm"]["per_cik"] = {};
  for (const cik of new Set(runs.map((r) => r.cik))) {
    const mine = runs.filter((r) => r.cik === cik);
    perCik[cik] = { utility: mine[mine.length - 1]!.utility, cold: modeStats(mine.filter((r) => r.mode === "cold")), warm: modeStats(mine.filter((r) => r.mode === "warm")) };
  }

  const drafts = runs.flatMap((r) => r.memo.drafts);
  const sicFk = inputs.joinmap?.results?.sic.recorded_run_dq ?? null;
  return {
    generated_at: (inputs.now ?? new Date()).toISOString(),
    label: "measured",
    inputs: {
      runs: runs.map((r) => ({ run_id: r.run_id, cik: r.cik, utility: r.utility, period: r.period, claim: r.claim, started_at: r.started_at, source: r.source })),
      dq_file: inputs.dq !== null,
      joinmap_file: inputs.joinmap !== null,
      seeds: { utilities: inputs.utilities.length, stations: inputs.stations.length },
    },
    join_map: inputs.joinmap,
    peers: peerRun
      ? {
          from_run: peerRun.run_id,
          target: peerRun.cik,
          utility: peerRun.card.utility?.name ?? null,
          period: peerRun.period,
          count: peerRun.card.peers!.count,
          by_tag: peerRun.card.peers!.by_tag,
          with_weather: peerRun.card.peers!.with_weather,
          excluded: peerRun.card.peers!.excluded,
          identical_across_runs: peerKeys.size === 1,
          runs: peerPool.map((r) => r.run_id),
        }
      : null,
    coverage: coveragePerUtility(coverageRun, inputs.utilities, periods),
    attribution: attributionSections(evalRuns),
    dq: inputs.dq ? { ...inputs.dq, sic_fk: sicFk } : null,
    runs,
    totals: {
      runs: runs.length,
      planner_calls: runs.reduce((a, r) => a + r.planner_calls, 0),
      valid_first_try: runs.reduce((a, r) => a + r.valid_first_try, 0),
      repaired: runs.reduce((a, r) => a + r.repaired, 0),
      repairs_think_off: runs.some((r) => r.repairs_think_off !== null) ? runs.reduce((a, r) => a + (r.repairs_think_off ?? 0), 0) : null,
      fallbacks: runs.reduce((a, r) => a + r.fallbacks, 0),
      tool_calls_by_model: runs.reduce((a, r) => a + r.tool_calls_by_model, 0),
      memo_drafts: drafts.length,
      memo_drafts_with_unknown_numbers: drafts.filter((d) => d.unknown_numbers > 0).length,
      model_memos: runs.filter((r) => r.memo.source === "model").length,
      template_memos: runs.filter((r) => r.memo.source === "template").length,
      evidence_records: runs.reduce((a, r) => a + r.evidence.records, 0),
      evidence_complete: runs.reduce((a, r) => a + r.evidence.e_complete, 0),
      claims: runs.reduce((a, r) => a + r.claims.total, 0),
      claims_with_evidence: runs.reduce((a, r) => a + r.claims.with_evidence, 0),
      cloud_model_calls: runs.reduce((a, r) => a + r.cloud_model_calls, 0),
      refused_hosts: runs.reduce((a, r) => a + r.refused_hosts, 0),
    },
    cold_vs_warm: { all: { cold: modeStats(cold), warm: modeStats(warm) }, per_cik: perCik },
  };
}

// ---- markdown ----

const pct = (x: number | null | undefined, d = 2): string => (typeof x === "number" ? `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%` : "n/a");
const num = (x: number | null | undefined, d = 4): string => (typeof x === "number" ? x.toFixed(d) : "n/a");
const int = (x: number | null | undefined): string => (typeof x === "number" ? x.toLocaleString("en-US") : "n/a");
const ms = (x: number | null | undefined): string => (typeof x === "number" ? `${(x / 1000).toFixed(1)} s` : "n/a");
const range = (r: { value: number; lo: number; hi: number }): string => `${pct(r.value)} [${pct(r.lo)}, ${pct(r.hi)}]`;
const tagShort = (t: string): string => (t === "RevenueFromContractWithCustomerExcludingAssessedTax" ? "RFC" : t === "RegulatedAndUnregulatedOperatingRevenue" ? "RUOR" : t);

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}

export function renderMarkdown(r: EvalReport): string {
  const out: string[] = [];
  out.push("# Weather-or-Not evaluation report");
  out.push("");
  out.push(`Generated ${r.generated_at}. Every number below is measured and read from a file: the saved runs under data/runs, the DQ onboarding file (data/dq/latest.json) and the join-map measurements (data/eval/joinmap.json, one-off Lightning SQL statements under the reader allowlist). Nothing is typed by hand; "not measured" marks what the files do not hold.`);
  out.push("");
  out.push("## Runs used");
  out.push("");
  out.push(table(["Run", "Utility", "CIK", "Period", "Claim", "Started", "Source"], r.inputs.runs.map((x) => [x.run_id, x.utility ?? "", x.cik, x.period, x.claim, x.started_at, x.source])));
  out.push("");
  out.push(`Seeds: ${r.inputs.seeds.utilities} utilities, ${r.inputs.seeds.stations} stations. DQ file ${r.inputs.dq_file ? "present" : "absent"}; join-map file ${r.inputs.joinmap_file ? "present" : "absent"}.`);
  out.push("");

  out.push("## 1. Join map (Lightning SQL over the seed objects)");
  out.push("");
  const jm = r.join_map;
  if (!jm?.results) {
    out.push("Not measured (no join-map file).");
  } else {
    const res = jm.results;
    out.push(`Measured ${jm.measured_at}; bound ${jm.bound_s} s per statement; ${jm.statements.length} statements in ${jm.elapsed_s ?? "n/a"} s wall; login ${jm.login ?? "n/a"} under the reader allowlist.`);
    out.push("");
    out.push("### 1a. Frames `cik` (LPAD to 10 digits) against the seeds' submission views");
    out.push("");
    out.push(
      table(
        ["Tag", "Period", "Seeds", "LPAD join matched", "Integer IN count (frames_seeds)", "Agree", "Statement ms"],
        Object.values(res.cik_lpad).map((c) => [tagShort(c.tag), c.period, String(c.seeds), c.measured === false ? "not measured" : int(c.lpad_matched), c.measured === false ? "not measured" : int(c.in_count ?? null), c.measured === false ? "" : c.agree ? "yes" : "no", c.measured === false ? "" : int(c.elapsed_ms)]),
      ),
    );
    out.push("");
    out.push(`Control without LPAD (integer string against the zero-padded cik): ${res.cik_no_lpad_control.measured ? `${int(res.cik_no_lpad_control.matched)} matched (${int(res.cik_no_lpad_control.elapsed_ms)} ms)` : "not measured"}.`);
    out.push("");
    out.push(
      table(
        ["Period", "Seeds with a fact under any of the three tags", "Seeds", "Statement ms"],
        Object.entries(res.cik_any_tag).map(([p, v]) => [p, v.measured ? int(v.seeds_with_a_fact) : "not measured", String(v.seeds), v.measured ? int(v.elapsed_ms) : ""]),
      ),
    );
    out.push("");
    out.push("### 1b. Frames `loc` (US-XX) against the business-address state of the submission view");
    out.push("");
    out.push(
      table(
        ["Tag", "Period", "Seeds present", "Equal", "Different", "Missing"],
        Object.values(res.loc).map((l) => (l.measured === false ? [tagShort(l.tag), l.period, "not measured", "", "", ""] : [tagShort(l.tag), l.period, int(l.present), int(l.equal), int(l.different), int(l.missing)])),
      ),
    );
    out.push("");
    if (res.loc_differing_rows.length) {
      out.push(table(["Tag", "Period", "CIK", "Name", "Frames loc", "Business state"], res.loc_differing_rows.map((x) => [tagShort(x.tag), x.period, x.cik, x.name, x.loc ?? "(null)", x.state])));
    } else {
      out.push("No differing or missing `loc` rows were listed (the listing statement runs only where a count says there are any).");
    }
    out.push("");
    out.push("### 1c. Station to state (USL station table against seeds/stations.json)");
    out.push("");
    const st = res.station;
    if (st.skipped) out.push("Skipped on this run (--skip-station).");
    else if (!st.measured) out.push(`Not measured: the statement ${st.timeout ? `exceeded the ${st.bound_s} s bound` : "failed"} (${st.elapsed_ms ?? "n/a"} ms). The USL station table resolves a GHCN filestore view on every read (44 to 88 s on this instance in the onboarding record).`);
    else {
      out.push(`${int(st.usl_rows)} USL rows in ${int(st.elapsed_ms)} ms; ${int(st.present)} of ${st.seed_stations} seed stations present, ${int(st.state_equal)} with the same state, ${st.state_different?.length ?? 0} with a different state, ${st.missing?.length ?? 0} missing; ${st.extra_in_usl?.length ?? 0} USL station(s) not in the seed file (${(st.extra_in_usl ?? []).join(", ") || "none"}).`);
      if (st.state_different?.length) {
        out.push("");
        out.push(table(["Station", "Seed state", "USL state"], st.state_different.map((d) => [d.id, d.seed_state, d.usl_state])));
      }
    }
    out.push("");
    out.push("### 1d. SIC foreign key (submissions `sic` against the company_dns SIC list)");
    out.push("");
    const sic = res.sic;
    if (sic.measured) out.push(`Plain SQL (LEFT JOIN won.sic_codes, ${int(sic.elapsed_ms)} ms): ${int(sic.joined)} of ${sic.seeds} seeds join; orphan(s): ${sic.orphans.map((o) => `${o.name} (CIK ${o.cik}, SIC ${o.sic})`).join("; ") || "none"}.`);
    else out.push("Plain-SQL orphan check: not measured.");
    const q = sic.recorded_run_dq;
    out.push("");
    out.push(`Recorded (not re-run; ${q.source}): \`${q.statement}\` -> ${q.result.type} ${q.result.total} total / ${q.result.valid} valid / ${q.result.invalid} invalid in ${q.elapsed_s} s; \`${q.invalid_record_statement}\` -> ${q.invalid_record.name} (CIK ${q.invalid_record.cik}, SIC ${q.invalid_record.sic}, ${q.invalid_record.hq_state}) in ${q.invalid_record_elapsed_s} s. ${q.note}`);
  }
  out.push("");

  out.push("## 2. Peers per tag and exclusions");
  out.push("");
  if (!r.peers) out.push("Not measured (no run with a peer set).");
  else {
    out.push(`From run ${r.peers.from_run} (${r.peers.utility ?? r.peers.target}, ${r.peers.period}): ${r.peers.count} peers, ${r.peers.with_weather} with weather; the peer set is ${r.peers.identical_across_runs ? "identical" : "NOT identical"} across the ${r.peers.runs.length} run(s) of this utility.`);
    out.push("");
    out.push(table(["Tag", "Peers"], Object.entries(r.peers.by_tag).map(([t, n]) => [tagShort(t), String(n)])));
    out.push("");
    out.push(table(["Excluded CIK", "Reason (from the card)"], r.peers.excluded.map((e) => [e.cik, e.reason])));
  }
  out.push("");

  out.push("## 3. Weather coverage per utility");
  out.push("");
  const c = r.coverage;
  out.push(`From the weather_quarter evidence rows of run ${c.from_run ?? "n/a"} (${c.periods.map((p) => `${p}: ${c.stations_in_rows[p] ?? 0} stations`).join("; ")}). Utility coverage is the minimum over its stations, then the minimum of the two periods. ${c.summary.with_every_station} of ${c.summary.utilities} utilities have every station in the rows${c.summary.not_covered ? ` (${c.summary.not_covered} not fully covered by these rows)` : ""}; lowest utility coverage ${num(c.summary.min_coverage)}; ${c.summary.below_0_9} below 0.9.`);
  out.push("");
  out.push(table(["CIK", "Utility", "Stations", ...c.periods, "Min"], c.utilities.map((u) => [u.cik, u.name, String(u.stations), ...c.periods.map((p) => num(u.coverage[p])), u.complete ? num(u.min) : `not covered (${u.present}/${u.stations} stations)`])));
  out.push("");

  out.push("## 4. Attribution with bootstrap ranges");
  out.push("");
  if (!r.attribution.length) out.push("Not measured (no run with an attribution).");
  for (const a of r.attribution) {
    out.push(`### ${a.utility ?? a.cik} (CIK ${a.cik}), run ${a.from_run}`);
    out.push("");
    out.push(
      table(
        ["Quantity", "Value"],
        [
          ["Revenue tag", a.tag ?? "n/a"],
          ["g (year on year)", pct(a.g)],
          ["Accession numbers", `current ${a.current_accn ?? "n/a"}; previous original ${a.previous_original_accn ?? "n/a"}; previous comparative ${a.previous_comparative_accn ?? "n/a"}; recast ${a.recast === null ? "n/a" : a.recast ? "yes" : "no"}`],
          ["Degree-day change", pct(a.delta_w)],
          ["Peers", int(a.peers)],
          ["beta [range]", `${num(a.beta)} [${num(a.beta_range.lo)}, ${num(a.beta_range.hi)}]`],
          ["Theil-Sen slope", num(a.theil_sen)],
          ["Weather", range(a.weather)],
          ["Industry", range(a.industry)],
          ["Remainder", range(a.remainder)],
          ["Bootstrap", `${a.bootstrap.valid} of ${a.bootstrap.resamples} resamples valid, ${a.bootstrap.skipped_zero_variance} skipped (zero variance), seed ${a.bootstrap.seed}`],
          ["Coverage", num(a.coverage)],
          ["Confidence", a.confidence],
          ["Claim ratio / verdict", `${num(a.ratio, 3)} / ${a.verdict}`],
          ["Recast conflicts on the card", String(a.recast_conflicts)],
          ["Identical across runs", `${a.identical_across_runs ? "yes" : "no"} (${a.runs.length} run(s): ${a.runs.join(", ")})`],
        ],
      ),
    );
    out.push("");
  }

  out.push("## 5. Data quality");
  out.push("");
  if (!r.dq) out.push("Not measured (no DQ onboarding file).");
  else {
    out.push(`Rule \`${r.dq.rule}\` on \`${r.dq.table}\`, run ${r.dq.ran_at}, ${r.dq.elapsed_s} s in all, ok ${r.dq.ok}; RUN DQ ${r.dq.run ? `${r.dq.run.total} total / ${r.dq.run.valid} valid / ${r.dq.run.invalid} invalid in ${r.dq.run.elapsed_s} s` : "not run"}; ${r.dq.invalid_rows.length} invalid station-quarter(s).`);
    out.push("");
    out.push(table(["Statement", "Seconds", "Rows", "Error"], r.dq.statements.map((s) => [s.template_id, String(s.elapsed_s ?? "n/a"), String(s.row_count ?? "n/a"), s.error ?? ""])));
    out.push("");
    if (r.dq.sic_fk) out.push(`Utility FK rule (recorded at onboarding, see 1d): ${r.dq.sic_fk.result.total} / ${r.dq.sic_fk.result.valid} / ${r.dq.sic_fk.result.invalid}; the invalid row is ${r.dq.sic_fk.invalid_record.name} (SIC ${r.dq.sic_fk.invalid_record.sic}).`);
  }
  out.push("");

  out.push("## 6. Per run");
  out.push("");
  out.push(
    table(
      ["Run", "Utility", "Mode", "Chunks", "Wall", "Planner calls", "Valid first try", "Repaired", "Repaired with think off", "Fallbacks", "Median tok/s", "Memo", "E-complete", "E-cov", "Skipped steps", "Verdict"],
      r.runs.map((x) => [
        x.run_id,
        x.utility ?? x.cik,
        x.mode,
        String(x.chunks),
        ms(x.wall_ms),
        String(x.planner_calls),
        String(x.valid_first_try),
        String(x.repaired),
        x.repairs_think_off === null ? "not recorded" : String(x.repairs_think_off),
        String(x.fallbacks),
        num(x.median_tokens_per_s, 1),
        x.memo.source ? `${x.memo.source}, ${x.memo.words} words, ${x.memo.attempts} attempt(s)` : "n/a",
        `${x.evidence.e_complete}/${x.evidence.records}${x.evidence.unresolved_object_names ? ` (${x.evidence.unresolved_object_names} unresolved object names)` : ""}`,
        `${x.claims.with_evidence}/${x.claims.total} (${num(x.claims.e_cov, 3)})`,
        x.skipped_steps.map((s) => `${s.item} (${s.memoryId})`).join("; ") || "none",
        `${x.verdict ?? "n/a"} / ${x.confidence ?? "n/a"} / DQ ${x.dq_label ?? "n/a"}`,
      ]),
    ),
  );
  out.push("");
  out.push("Memo drafts (word count, numbers not found in any tool output):");
  out.push("");
  out.push(table(["Run", "Draft", "Words", "Unknown numbers", "Kept"], r.runs.flatMap((x) => x.memo.drafts.map((d) => [x.run_id, String(d.attempt), String(d.words ?? "n/a"), String(d.unknown_numbers), d.ok ? "yes" : "no"]))));
  out.push("");
  out.push("Degree-day statements and memo time per run:");
  out.push("");
  out.push(table(["Run", "weather_quarter current", "weather_quarter previous", "Memo", "Model", "Think", "Cloud model calls", "Refused hosts", "Recast conflicts"], r.runs.map((x) => [x.run_id, ms(x.weather_quarter_ms.current), ms(x.weather_quarter_ms.previous), ms(x.memo_ms), x.model ?? "n/a", x.think ? "on" : "off", String(x.cloud_model_calls), String(x.refused_hosts), String(x.recast_conflicts)])));
  out.push("");
  const t = r.totals;
  out.push(`Totals over ${t.runs} run(s): ${t.planner_calls} planner calls, ${t.valid_first_try} valid on the first reply, ${t.repaired} repaired${t.repairs_think_off === null ? "" : ` (${t.repairs_think_off} of them with think off)`}, ${t.fallbacks} deterministic fallback(s); ${t.tool_calls_by_model} tool calls chosen by the model; memo drafts ${t.memo_drafts} (${t.memo_drafts_with_unknown_numbers} with an unknown number), ${t.model_memos} model memo(s) kept, ${t.template_memos} template memo(s); evidence ${t.evidence_complete}/${t.evidence_records} complete; claims ${t.claims_with_evidence}/${t.claims} cited; cloud model calls ${t.cloud_model_calls}; refused hosts ${t.refused_hosts}.`);
  out.push("");

  out.push("## 7. Cold against warm");
  out.push("");
  out.push("A warm run is one that skipped at least one checklist step from memory (the remembered revenue tag).");
  out.push("");
  const modeRow = (label: string, m: ModeStats) => [label, String(m.runs), num(m.chunks_mean, 2), ms(m.wall_ms_mean), m.wall_ms_min === null ? "n/a" : `${ms(m.wall_ms_min)} to ${ms(m.wall_ms_max)}`, num(m.planner_calls_mean, 2), num(m.skipped_steps_mean, 2), m.run_ids.join(", ") || "none"];
  const rows: string[][] = [modeRow("all, cold", r.cold_vs_warm.all.cold), modeRow("all, warm", r.cold_vs_warm.all.warm)];
  for (const [cik, v] of Object.entries(r.cold_vs_warm.per_cik)) {
    rows.push(modeRow(`${v.utility ?? cik}, cold`, v.cold), modeRow(`${v.utility ?? cik}, warm`, v.warm));
  }
  out.push(table(["Group", "Runs", "Chunks (mean)", "Wall (mean)", "Wall (min to max)", "Planner calls (mean)", "Skipped steps (mean)", "Runs"], rows));
  out.push("");
  return out.join("\n");
}
