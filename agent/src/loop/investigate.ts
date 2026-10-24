// One question as a Markovian chain (SPEC 7). The vendored Markovian orchestrator runs
// unchanged; our generator (generator.ts) plans each chunk with local Nemotron and executes
// the chosen tools (tools.ts). The run stops when the checklist is complete. A chain that
// ends any other way (max chunks, an error, an abort) still gets a card: the host runs
// finalize itself, and the open items are reported as gaps.
// Adapted from ClearShelf (same author, Apache-2.0).

import { fileURLToPath } from "node:url";
import { Markovian, type ChunkConfig, type MarkovianRun } from "../../../engines/markovian/reference/src/index.ts";
import { DATA_DIR_URL } from "../config.ts";
import { missingFields, type EvidenceRecord } from "../evidence/store.ts";
import { refusedModelHostAttempts } from "../llm/ollama.ts";
import type { RecastConflict } from "../memory/recastConflicts.ts";
import type { Attribution } from "../tools/attribution.ts";
import { refusedGatewayHostAttempts } from "../zetaris/client.ts";
import { PlannerSession, type LoopEvent, type TimelineEntry } from "./generator.ts";
import type { ChartPoint, ChunkRecord, PlannerCallRecord, TelemetrySummary, ToolCallRecord } from "./telemetry.ts";
import { applyMemory, newQuestionContext, runTool, toolDef, type CardClaim, type DqResult, type QuestionContext, type ToolDeps, type Verdict } from "./tools.ts";

/**
 * SPEC 7: carryover 800 tokens, at most 10 chunks. The vendored engine rejects any chunkSize
 * below framing (400) + carryover + output budget (1200) = 2400; chunkSize only feeds the
 * engine's own estimated savings figure, so it is set to 3000.
 */
export const QUESTION_CHUNK_CONFIG: ChunkConfig = { chunkSize: 3000, maxChunks: 10, carryoverTokens: 800, overlapTokens: 0 };

export const DEFAULT_HISTORY_DIR = fileURLToPath(new URL("markovian/", DATA_DIR_URL));

export interface InvestigateOptions {
  cik: string;
  period: string;
  claim: string;
  maxChunks?: number;
  /** H-MEM context for chunk 0; default: the facade's memoryContext for this utility. */
  memoryContext?: string;
  onEvent?: (e: LoopEvent) => void;
  abortSignal?: AbortSignal;
  /** Planner think mode; defaults to the adopted planner setting (WON_THINK=off forces off). */
  think?: boolean;
  /** Where the engine persists its run history (history.json); null keeps it in memory. */
  historyDir?: string | null;
}

export interface RunCard {
  question: string;
  utility: { cik: string; name: string | null; ticker: string | null; sic: string | null; hq_state: string | null; states_served: string[]; stations: string[]; flags: string[] } | null;
  verdict: Verdict | null;
  growth: { tag: string; g: number; rev_current: number; rev_previous: number; current_accn: string; current_filed: string; previous_original_accn: string | null; previous_comparative_accn: string | null; recast: boolean; tag_switch_note: string | null } | null;
  weather: { delta_w: number; tdd_current: number; tdd_previous: number; coverage: number; stations_used: string[]; stations_missing: string[] } | null;
  peers: { count: number; by_tag: Record<string, number>; with_weather: number; excluded: { cik: string; reason: string }[]; list: { cik: string; name: string; tag: string; g: number; dw: number | null }[] } | null;
  attribution: Attribution | null;
  dq: DqResult | null;
  recast_conflicts: RecastConflict[];
  not_tested: string[];
  memo: { text: string; source: "model" | "template"; words: number; attempts: number; attempts_detail: unknown[] } | null;
  claims: CardClaim[];
  gaps: string[];
}

export interface RunResult {
  run_id: string;
  cik: string;
  period: string;
  previous_period: string;
  claim: string;
  started_at: string;
  finished_at: string;
  wall_ms: number;
  card: RunCard;
  checklist: Array<{ id: string; status: string; note: string | null; evidenceIds: string[] }>;
  checklist_complete: boolean;
  skipped_steps: { item: string; memoryId: string; note: string }[];
  timeline: TimelineEntry[];
  markovian: { run_id: string; status: MarkovianRun["status"]; error: string | null; chunk_config: ChunkConfig; chunks: number; engine_estimate: { total_tokens_used: number; tokens_saved: number; efficiency_percent: number; label: "estimated" } };
  chunks: ChunkRecord[];
  planner_calls: PlannerCallRecord[];
  tool_calls: ToolCallRecord[];
  chart: ChartPoint[];
  summary: TelemetrySummary;
  telemetry: { model: string | null; think: boolean; median_planner_tokens_per_s: number | null; memo_tokens_per_s: number | null; cloud_model_calls: 0; refused_model_hosts: number; refused_gateway_hosts: number; memory_context_chars: number };
  memory: { ids: string[]; facts_total: number; conflicts: number; skipped_steps: number } | null;
  world: { events: number; entities: Record<string, number>; edges: Record<string, number> } | null;
  timings_ms: Record<string, number>;
  evidence_ids: string[];
  evidence: EvidenceRecord[];
  evidence_file: string | null;
  quality: { e_cov: number; claims: number; e_complete: number; records: number; incomplete_records: Record<string, string[]> };
}

export function questionText(ctx: Pick<QuestionContext, "period" | "prevPeriod" | "claim">, name: string | null, cik: string): string {
  return `${name ?? `CIK ${cik}`}'s ${ctx.period} revenue changed year on year (${ctx.prevPeriod} to ${ctx.period}) and management credits "${ctx.claim}". How much of the change is weather?`;
}

export function goalText(ctx: QuestionContext): string {
  return `Check CIK ${ctx.cik}'s claim that "${ctx.claim}" explains its ${ctx.period} revenue change against ${ctx.prevPeriod}: work through the host checklist with the allowed tools, one tool per step, then call finalize. Deterministic tools compute every number; you plan the steps, keep hypotheses and note contradictions between sources.`;
}

export async function investigate(opts: InvestigateOptions, deps: ToolDeps): Promise<RunResult> {
  const t0 = performance.now();
  const ctx = newQuestionContext(opts.cik, opts.period, opts.claim, deps.evidence);
  applyMemory(ctx, deps);
  const chunkConfig: ChunkConfig = { ...QUESTION_CHUNK_CONFIG, ...(opts.maxChunks ? { maxChunks: opts.maxChunks } : {}) };
  const goal = goalText(ctx);
  const session = new PlannerSession(ctx, deps, {
    goal,
    chainLabel: `one utility (CIK ${ctx.cik}) and one quarter (${ctx.period} against ${ctx.prevPeriod})`,
    carryoverTokens: chunkConfig.carryoverTokens,
    onEvent: opts.onEvent,
    abortSignal: opts.abortSignal,
    think: opts.think,
  });

  let memoryContext = opts.memoryContext;
  if (memoryContext === undefined && deps.hmem) {
    try {
      memoryContext = deps.hmem.memoryContext({ cik: ctx.cik, period: ctx.period });
    } catch (e) {
      ctx.gaps.push(`memory context for chunk 0 failed: ${(e as Error).message.slice(0, 160)}`);
    }
  }
  if (memoryContext) session.seedBaseline(memoryContext);

  const historyDir = opts.historyDir === undefined ? DEFAULT_HISTORY_DIR : opts.historyDir;
  const markovian = new Markovian({ chunkConfig, generator: session.generator, ...(historyDir ? { historyDir } : {}) });
  const run = await markovian.run({
    goal,
    mode: "RESEARCH",
    memoryContext,
    stopWhen: () => ctx.checklist.complete(),
    reflect: false,
    abortSignal: opts.abortSignal,
  });

  const checklistComplete = ctx.checklist.complete();
  if (!checklistComplete) {
    const open = ctx.checklist.pending().map((i) => i.id);
    ctx.gaps.push(`chain ended ${run.status} after ${run.chunks.length} chunk(s)${run.error ? ` (${run.error.slice(0, 160)})` : ""}; open items: ${open.join(", ") || "none"}`);
    for (const id of open) if (id !== "claim_tested" && id !== "memo_written" && id !== "not_tested_listed") ctx.checklist.set(id, "failed", `not reached before the chain ended (${run.status})`);
    if (ctx.checklist.get("not_tested_listed").status === "pending") await runTool(toolDef("not_tested")!, {}, ctx, deps);
    if (ctx.checklist.get("memo_written").status === "pending") await runTool(toolDef("finalize")!, {}, ctx, deps);
  }

  const tel = session.telemetry;
  const mine = deps.evidence.all().slice(ctx.evStart);
  const incomplete: Record<string, string[]> = {};
  for (const r of mine) {
    const m = missingFields(r);
    if (m.length) incomplete[r.id] = m;
  }
  const u = ctx.utility;
  const rev = ctx.revenue;
  const w = ctx.weather;
  const byTag: Record<string, number> = {};
  for (const p of ctx.peers) byTag[p.tag] = (byTag[p.tag] ?? 0) + 1;
  const memoAttempts = ctx.memo?.attempts ?? [];
  const memoTps = memoAttempts.length ? memoAttempts[memoAttempts.length - 1]!.metrics?.tokensPerSecond ?? null : null;
  const world = deps.world ? deps.world.exportGraph() : null;
  const finished = new Date().toISOString();
  return {
    run_id: deps.evidence.runId,
    cik: ctx.cik,
    period: ctx.period,
    previous_period: ctx.prevPeriod,
    claim: ctx.claim,
    started_at: ctx.startedAt,
    finished_at: finished,
    wall_ms: Math.round(performance.now() - t0),
    card: {
      question: questionText(ctx, u?.name ?? null, ctx.cik),
      utility: u ? { cik: u.cik, name: ctx.profile?.name ?? u.name, ticker: u.ticker, sic: ctx.profile?.sic ?? u.sic, hq_state: ctx.profile?.state ?? u.hq_state, states_served: u.states_served, stations: u.station_ids, flags: u.flags } : null,
      verdict: ctx.verdict,
      growth: rev
        ? {
            tag: rev.tag,
            g: rev.growth,
            rev_current: rev.rev_current,
            rev_previous: rev.rev_previous,
            current_accn: rev.current_accn,
            current_filed: rev.current_filed,
            previous_original_accn: rev.recast.original?.accn ?? null,
            previous_comparative_accn: rev.recast.comparative?.accn ?? null,
            recast: rev.recast.recast,
            tag_switch_note: ctx.tagSwitchNote,
          }
        : null,
      weather: w ? { delta_w: w.target.delta_w, tdd_current: w.target.current.tdd, tdd_previous: w.target.previous.tdd, coverage: w.target.coverage, stations_used: w.target.current.stations_used, stations_missing: w.target.current.stations_missing } : null,
      peers: ctx.checklist.isDone("peers_loaded")
        ? { count: ctx.peers.length, by_tag: byTag, with_weather: ctx.peers.filter((p) => p.dw !== null).length, excluded: ctx.excluded, list: ctx.peers.map((p) => ({ cik: p.cik, name: p.name, tag: p.tag, g: p.g, dw: p.dw })) }
        : null,
      attribution: ctx.attribution,
      dq: ctx.dq,
      recast_conflicts: ctx.conflicts,
      not_tested: ctx.notTested,
      memo: ctx.memo ? { text: ctx.memo.text, source: ctx.memo.source, words: ctx.memo.wordCount, attempts: ctx.memo.attempts.length, attempts_detail: ctx.memo.attempts } : null,
      claims: ctx.card,
      gaps: ctx.gaps,
    },
    checklist: ctx.checklist.snapshot(),
    checklist_complete: checklistComplete,
    skipped_steps: ctx.skipped,
    timeline: session.timeline,
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
    summary: tel.summary(),
    telemetry: {
      model: deps.ollama?.model ?? null,
      think: tel.plannerCalls[0]?.think ?? false,
      median_planner_tokens_per_s: tel.summary().median_planner_tokens_per_s,
      memo_tokens_per_s: memoTps,
      cloud_model_calls: 0,
      refused_model_hosts: refusedModelHostAttempts(),
      refused_gateway_hosts: refusedGatewayHostAttempts(),
      memory_context_chars: memoryContext?.length ?? 0,
    },
    memory: deps.hmem ? { ids: ctx.memoryIds, facts_total: deps.hmem.store.all().length, conflicts: ctx.conflicts.length, skipped_steps: ctx.skipped.length } : null,
    world: world ? { events: world.events, entities: world.byType, edges: world.edgeTypes } : null,
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
