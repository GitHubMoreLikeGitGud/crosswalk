// One question as a Markovian chain (SPEC section 3). The vendored Markovian orchestrator runs
// unchanged; our generator (generator.ts) plans each chunk with local Nemotron and executes the
// chosen discovery tools (tools.ts). The run stops when the checklist is complete. A chain that
// ends any other way (max chunks, an error, an abort) still gets a result: the host runs
// not_tested and finalize itself, and the open items are reported as gaps.
//
// The run JSON carries the chain, every tool call with its SQL and ms, the join map, the scored
// key proposals of the model and of the deterministic baseline (L2), the verdict mix (every no or
// partly the run produced, L3), the registrations, the USL comparison with its DQ results, the
// answer table with per-cell provenance, the note, the Not-tested list and the telemetry.
// Adapted from Weather-or-Not and ClearShelf (same author, Apache-2.0).

import { fileURLToPath } from "node:url";
import { Markovian, type ChunkConfig, type MarkovianRun } from "../../../engines/markovian/reference/src/index.ts";
import { DATA_DIR_URL } from "../config.ts";
import { missingFields, type EvidenceRecord } from "../evidence/store.ts";
import { refusedModelHostAttempts } from "../llm/ollama.ts";
import type { AnswerResult, CompileResult, MeasureResult, RegisterResult, SideScore } from "../tools/discovery.ts";
import { refusedGatewayHostAttempts } from "../zetaris/client.ts";
import { PlannerSession, type LoopEvent, type TimelineEntry } from "./generator.ts";
import type { ChartPoint, ChunkRecord, PlannerCallRecord, TelemetrySummary, ToolCallRecord } from "./telemetry.ts";
import { BASELINE_SCORED, compareProposals, memoryKeyOf, newQuestionContext, runTool, toolDef, type CardClaim, type QuestionContext, type ToolDeps } from "./tools.ts";

/** D10: carryover 800 tokens, at most 12 chunks. chunkSize only feeds the engine's own estimate (it must exceed 2400). */
export const QUESTION_CHUNK_CONFIG: ChunkConfig = { chunkSize: 3000, maxChunks: 12, carryoverTokens: 800, overlapTokens: 0 };

export const DEFAULT_HISTORY_DIR = fileURLToPath(new URL("markovian/", DATA_DIR_URL));

/** SPEC D9: the demo question, text fixed; the quarter is the only variable. */
export function demoQuestion(quarter: string): string {
  const m = /^CY(\d{4})Q([1-4])$/u.exec(quarter);
  if (!m) throw new Error(`quarter must be CY<yyyy>Q<n>: ${quarter}`);
  return `Which investor-owned electric utilities served states with FEMA major-disaster declarations in Q${m[2]} ${m[1]}, what did the weather at their stations do that quarter, and did their revenue hold up year on year?`;
}

export interface InvestigateOptions {
  question: string;
  quarter: string;
  maxChunks?: number;
  /** H-MEM context for chunk 0. */
  memoryContext?: string;
  onEvent?: (e: LoopEvent) => void;
  abortSignal?: AbortSignal;
  think?: boolean;
  /** Where the engine persists its run history; null keeps it in memory. */
  historyDir?: string | null;
  /** Set by the caller: "cold" (no key recall) or "warm" (key_verified memories recalled). */
  mode?: "cold" | "warm";
  now?: Date;
}

export interface JoinMapRow {
  id: string;
  key: string;
  label: string | null;
  left: string;
  right: string;
  transform: string;
  proposed_by: string[];
  status: string;
  left_rows: number | null;
  matched_rows: number | null;
  rate: number | null;
  left_keys: number | null;
  matched_keys: number | null;
  rate_distinct: number | null;
  verdict: string | null;
  orphans: string[];
  extra: Record<string, number>;
  measured_as: string | null;
  sql: string | null;
  sql_orphans: string | null;
  elapsed_ms: number;
  from_memory: string | null;
  memory_key: string;
}

export interface ProposalTally {
  proposed_by: string | null;
  made: number;
  verified: number;
  partial: number;
  rejected: number;
  invalid_schema: number;
  unmeasurable: number;
  keys: string[];
  choices: unknown[];
}

export interface VerdictMixItem {
  kind: "REJECTED" | "PARTIAL" | "DQ_INVALID" | "ABSENT" | "NOT_COMPARED";
  subject: string;
  detail: string;
  evidence_ids: string[];
}

export interface ToolCallDetail {
  chunk: number;
  seq: number;
  tool: string;
  source: "model" | "fallback";
  input: Record<string, unknown>;
  ok: boolean;
  latency_ms: number;
  fact: string;
  evidence_ids: string[];
  statements: { evidence_id: string; template: string | null; sql: string | null; elapsed_ms: number | null; rows: number | null; cache_state: string | null }[];
}

export interface RunResult {
  run_id: string;
  question: string;
  quarter: string;
  previous_quarter: string;
  mode: "cold" | "warm";
  started_at: string;
  finished_at: string;
  wall_ms: number;
  chain: TimelineEntry[];
  tool_calls_detail: ToolCallDetail[];
  join_map: JoinMapRow[];
  model_proposals: ProposalTally;
  baseline_proposals: ProposalTally;
  verdict_mix: VerdictMixItem[];
  registrations: RegisterResult[];
  usl: Omit<CompileResult, "governed_ddl"> | null;
  answer: AnswerResult | null;
  memo: { text: string; source: "model" | "template"; words: number; attempts: number; attempts_detail: unknown[] } | null;
  not_tested: string[];
  card: { claims: CardClaim[]; gaps: string[] };
  checklist: Array<{ id: string; status: string; note: string | null; evidenceIds: string[] }>;
  checklist_complete: boolean;
  skipped_steps: { item: string; memoryId: string; note: string }[];
  markovian: { run_id: string; status: MarkovianRun["status"]; error: string | null; chunk_config: ChunkConfig; chunks: number; engine_estimate: { total_tokens_used: number; tokens_saved: number; efficiency_percent: number; label: "estimated" } };
  chunks: ChunkRecord[];
  planner_calls: PlannerCallRecord[];
  tool_calls: ToolCallRecord[];
  chart: ChartPoint[];
  summary: TelemetrySummary;
  telemetry: {
    chunks: number;
    skipped_chunks: number;
    skipped_note: string;
    tokens: { planner_in: number; planner_out: number; memo_in: number; memo_out: number };
    wall_ms: number;
    model: string | null;
    think: boolean;
    median_planner_tokens_per_s: number | null;
    memo_tokens_per_s: number | null;
    cloud_model_calls: 0;
    refused_model_hosts: number;
    refused_gateway_hosts: number;
    memory_context_chars: number;
  };
  memory: { ids: string[]; facts_total: number; skipped_steps: number } | null;
  world: { events: number; entities: Record<string, number>; edges: Record<string, number>; delta: unknown } | null;
  timings_ms: Record<string, number>;
  evidence_ids: string[];
  evidence: EvidenceRecord[];
  evidence_file: string | null;
  quality: { e_cov: number; claims: number; e_complete: number; records: number; incomplete_records: Record<string, string[]> };
}

export function goalText(ctx: QuestionContext): string {
  return `Answer the question for ${ctx.quarter} (against ${ctx.previous}) by discovering how the sources join: work through the host checklist with the allowed tools, one tool per step, then call finalize. Deterministic tools and Lightning SQL compute every number; you choose the steps and propose the join keys.`;
}

function tally(by: string | null, choices: readonly unknown[], score: SideScore, invalid: number): ProposalTally {
  return { proposed_by: by, made: choices.length + invalid, verified: score.verified, partial: score.partial, rejected: score.rejected, invalid_schema: invalid, unmeasurable: score.unmeasured, keys: score.keys, choices: [...choices] };
}

/** The join map: every measured (or recalled) key, with who proposed it. */
export function joinMapOf(ctx: QuestionContext): JoinMapRow[] {
  const by = new Map<string, Set<string>>();
  const ids = new Map<string, string>();
  const note = (route: string | null, who: string, id: string) => {
    if (!route) return;
    if (!by.has(route)) by.set(route, new Set());
    by.get(route)!.add(who);
    if (!ids.has(route)) ids.set(route, id);
  };
  for (const c of ctx.proposals.model) note(c.route, ctx.proposals.proposedBy ?? "planner", c.id);
  ctx.proposals.baseline.forEach((c, i) => note(c.route, i < BASELINE_SCORED ? "baseline" : "baseline (queue)", c.id));
  const rows: JoinMapRow[] = [];
  for (const [route, m] of ctx.measured) {
    const p = m.proposal;
    if (!by.has(route)) note(route, m.from_memory && !route.includes("control") ? "memory" : "control", route.startsWith("cik_control") ? "c1" : `m${rows.length + 1}`);
    rows.push({
      id: ids.get(route) ?? route,
      key: route,
      label: m.label,
      left: `${p.leftObject}.${p.leftColumn}`,
      right: `${p.rightObject}.${p.rightColumn}`,
      transform: p.transform,
      proposed_by: [...(by.get(route) ?? [])],
      status: m.status,
      left_rows: m.left_rows,
      matched_rows: m.matched_rows,
      rate: m.rate,
      left_keys: m.left_keys,
      matched_keys: m.matched_keys,
      rate_distinct: m.rate_distinct,
      verdict: m.verdict,
      orphans: m.orphans,
      extra: m.extra,
      measured_as: m.key,
      sql: m.sql,
      sql_orphans: m.sql_orphans,
      elapsed_ms: m.elapsed_ms,
      from_memory: m.from_memory,
      memory_key: memoryKeyOf(p),
    });
  }
  return rows;
}

/** L3: every no or partly the run produced, with the evidence behind it. */
export function verdictMixOf(ctx: QuestionContext, evidence: readonly EvidenceRecord[]): VerdictMixItem[] {
  const out: VerdictMixItem[] = [];
  const evFor = (route: string) => evidence.filter((e) => e.kind === "tool" && (e.details as { measure?: MeasureResult } | undefined)?.measure?.key === route).map((e) => e.id);
  for (const [route, m] of ctx.measured) {
    if (m.status !== "measured") continue;
    if (m.verdict === "REJECTED") out.push({ kind: "REJECTED", subject: route, detail: `${m.label}: ${m.matched_rows} of ${m.left_rows} matched (${m.rate?.toFixed(3)})${m.from_memory ? " (recalled)" : ""}`, evidence_ids: evFor(route) });
    if (m.verdict === "PARTIAL") out.push({ kind: "PARTIAL", subject: route, detail: `${m.label}: ${m.matched_rows} of ${m.left_rows} matched (${m.rate?.toFixed(3)}); orphans ${m.orphans.join("; ") || "none listed"}`, evidence_ids: evFor(route) });
    if (m.verdict === "VERIFIED" && m.orphans.length) out.push({ kind: "ABSENT", subject: route, detail: `${m.label}: VERIFIED with orphan(s) ${m.orphans.join("; ")}${m.from_memory ? ` (recalled; measured as ${m.key})` : ""}`, evidence_ids: evFor(route) });
  }
  const u = ctx.usl;
  for (const r of u?.invalid_rows ?? []) out.push({ kind: "DQ_INVALID", subject: "onboarding DQ", detail: `invalid row ${JSON.stringify(r)}`, evidence_ids: [] });
  for (const r of u?.dq?.rules ?? []) if ((r.invalid ?? 0) > 0 && !(u?.invalid_rows ?? []).length) out.push({ kind: "DQ_INVALID", subject: r.rule, detail: `${r.invalid} invalid of ${r.total}`, evidence_ids: [] });
  for (const row of ctx.answer?.rows ?? []) {
    if (row.revenue?.change === null || row.revenue?.change === undefined) out.push({ kind: "NOT_COMPARED", subject: `${row.name} revenue`, detail: row.revenue?.note ?? row.revenue_note ?? "no value", evidence_ids: [] });
  }
  return out;
}

export async function investigate(opts: InvestigateOptions, deps: ToolDeps): Promise<RunResult> {
  const t0 = performance.now();
  const ctx = newQuestionContext(opts.question, opts.quarter, deps.evidence, { now: opts.now });
  const chunkConfig: ChunkConfig = { ...QUESTION_CHUNK_CONFIG, ...(opts.maxChunks ? { maxChunks: opts.maxChunks } : {}) };
  const goal = goalText(ctx);
  const session = new PlannerSession(ctx, deps, {
    goal,
    chainLabel: `one quarter (${ctx.quarter} against ${ctx.previous})`,
    carryoverTokens: chunkConfig.carryoverTokens,
    onEvent: opts.onEvent,
    abortSignal: opts.abortSignal,
    think: opts.think,
  });
  const memoryContext = opts.memoryContext;
  if (memoryContext) session.seedBaseline(memoryContext);

  const historyDir = opts.historyDir === undefined ? DEFAULT_HISTORY_DIR : opts.historyDir;
  const markovian = new Markovian({ chunkConfig, generator: session.generator, ...(historyDir ? { historyDir } : {}) });
  const run = await markovian.run({ goal, mode: "RESEARCH", memoryContext, stopWhen: () => ctx.checklist.complete(), reflect: false, abortSignal: opts.abortSignal });

  const checklistComplete = ctx.checklist.complete();
  if (!checklistComplete) {
    const open = ctx.checklist.pending().map((i) => i.id);
    ctx.gaps.push(`chain ended ${run.status} after ${run.chunks.length} chunk(s)${run.error ? ` (${run.error.slice(0, 160)})` : ""}; open items: ${open.join(", ") || "none"}`);
    for (const id of open) if (id !== "note_written" && id !== "not_tested_listed") ctx.checklist.set(id, "failed", `not reached before the chain ended (${run.status})`);
    if (ctx.checklist.get("not_tested_listed").status === "pending") await runTool(toolDef("not_tested")!, {}, ctx, deps);
    if (ctx.checklist.get("note_written").status === "pending") await runTool(toolDef("finalize")!, {}, ctx, deps);
  }

  const tel = session.telemetry;
  const mine = deps.evidence.all().slice(ctx.evStart);
  const byId = new Map(mine.map((e) => [e.id, e]));
  const incomplete: Record<string, string[]> = {};
  for (const r of mine) {
    const m = missingFields(r);
    if (m.length) incomplete[r.id] = m;
  }
  const comparison = ctx.comparison ?? compareProposals(ctx);
  const invalidPlanner = ctx.proposals.proposedBy === "planner" ? ctx.proposals.rejected.length : 0;
  const plannerChoices = ctx.proposals.proposedBy === "planner" ? ctx.proposals.model.map((a) => ({ id: a.id, left: a.left, right: a.right, transform: a.transform, route: a.route })) : [];
  const baseTop = ctx.proposals.baseline.slice(0, BASELINE_SCORED).map((b) => ({ id: b.id, left: b.left, right: b.right, transform: b.transform, route: b.route, score: b.score }));
  const proposeCalls = tel.plannerCalls.filter((p) => p.chosen?.tool === "propose_keys" || (p.first_errors ?? []).some((e) => e.includes("choices")));
  const plannerSchemaInvalid = proposeCalls.filter((p) => !p.valid).length;
  const memoAttempts = ctx.memo?.attempts ?? [];
  const memoTps = memoAttempts.length ? memoAttempts[memoAttempts.length - 1]!.metrics?.tokensPerSecond ?? null : null;
  const summary = tel.summary();
  const skippedMeasures = ctx.skipped.filter((s) => s.item === "keys_measured").length;
  const toolDetails: ToolCallDetail[] = session.timeline.map((t) => ({
    chunk: t.chunk,
    seq: t.seq,
    tool: t.tool,
    source: t.source,
    input: t.input,
    ok: t.ok,
    latency_ms: t.latency_ms,
    fact: t.fact,
    evidence_ids: t.evidence_ids,
    statements: t.evidence_ids
      .map((id) => byId.get(id))
      .filter((e): e is EvidenceRecord => !!e && (e.kind === "zetaris_sql" || e.kind === "registrar"))
      .map((e) => ({ evidence_id: e.id, template: e.template_id ?? null, sql: e.sql ?? null, elapsed_ms: e.elapsed_ms ?? null, rows: e.row_count ?? null, cache_state: e.cache_state ?? null })),
  }));
  const finished = new Date().toISOString();
  const wall = Math.round(performance.now() - t0);
  const usl = ctx.usl ? (({ governed_ddl: _g, ...rest }) => rest)(ctx.usl) : null;
  return {
    run_id: deps.evidence.runId,
    question: ctx.question,
    quarter: ctx.quarter,
    previous_quarter: ctx.previous,
    mode: opts.mode ?? (deps.keyMemory ? "warm" : "cold"),
    started_at: ctx.startedAt,
    finished_at: finished,
    wall_ms: wall,
    chain: session.timeline,
    tool_calls_detail: toolDetails,
    join_map: joinMapOf(ctx),
    model_proposals: tally(ctx.proposals.proposedBy === "planner" ? "planner" : null, plannerChoices, comparison.planner, invalidPlanner + plannerSchemaInvalid),
    baseline_proposals: tally("baseline", baseTop, comparison.baseline, 0),
    verdict_mix: verdictMixOf(ctx, mine),
    registrations: ctx.registrations,
    usl,
    answer: ctx.answer,
    memo: ctx.memo ? { text: ctx.memo.text, source: ctx.memo.source, words: ctx.memo.wordCount, attempts: ctx.memo.attempts.length, attempts_detail: ctx.memo.attempts } : null,
    not_tested: ctx.notTested,
    card: { claims: ctx.card, gaps: ctx.gaps },
    checklist: ctx.checklist.snapshot(),
    checklist_complete: checklistComplete,
    skipped_steps: ctx.skipped,
    markovian: {
      run_id: run.id,
      status: run.status,
      error: run.error ?? null,
      chunk_config: run.chunkConfig,
      chunks: run.chunks.length,
      engine_estimate: { total_tokens_used: run.totalTokensUsed, tokens_saved: run.totalTokensSaved, efficiency_percent: Number(run.efficiencyPercent.toFixed(1)), label: "estimated" },
    },
    chunks: tel.chunks,
    planner_calls: tel.plannerCalls,
    tool_calls: tel.toolCalls,
    chart: tel.chart(),
    summary,
    telemetry: {
      chunks: run.chunks.length,
      skipped_chunks: skippedMeasures,
      skipped_note: "measure_key steps not run because the key was recalled as VERIFIED from key_verified memory (each is one planner step plus one or two Lightning statements)",
      tokens: { planner_in: summary.planner_prompt_tokens, planner_out: summary.planner_eval_tokens, memo_in: summary.tool_model_tokens_in, memo_out: summary.tool_model_tokens_out },
      wall_ms: wall,
      model: deps.ollama?.model ?? null,
      think: tel.plannerCalls[0]?.think ?? false,
      median_planner_tokens_per_s: summary.median_planner_tokens_per_s,
      memo_tokens_per_s: memoTps,
      cloud_model_calls: 0,
      refused_model_hosts: refusedModelHostAttempts(),
      refused_gateway_hosts: refusedGatewayHostAttempts(),
      memory_context_chars: memoryContext?.length ?? 0,
    },
    memory: null,
    world: null,
    timings_ms: ctx.timings,
    evidence_ids: mine.map((r) => r.id),
    evidence: [...mine],
    evidence_file: deps.evidence.path,
    quality: {
      e_cov: ctx.card.length ? ctx.card.filter((c) => c.evidenceIds.length).length / ctx.card.length : 1,
      claims: ctx.card.length,
      e_complete: mine.length ? (mine.length - Object.keys(incomplete).length) / mine.length : 1,
      records: mine.length,
      incomplete_records: incomplete,
    },
  };
}
