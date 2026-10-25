// A saved run as the chunk stream it produced live (SPEC D20): the same event types and payload
// fields the loop publishes (chunk_start, planner, tool, chunk_end, then run_finished), rebuilt from
// run.json and marked replay: true, so the Discovery timeline renders a live run and a replay with
// one code path and shows a REPLAY banner for the second. Also the footer telemetry of a run.

import type { RunIn } from "./runShape.ts";
import { seconds, sgt } from "./time.ts";

export interface StreamEvent {
  type: string;
  data: Record<string, unknown>;
}

/** The summary published with run_finished (live) and at the end of a replay. */
export function finishedSummary(r: RunIn): Record<string, unknown> {
  return {
    run_id: r.run_id,
    quarter: r.quarter ?? null,
    mode: r.mode ?? null,
    question: r.question ?? null,
    utilities: r.answer?.rows?.length ?? 0,
    keys: r.join_map?.length ?? 0,
    wall_ms: r.wall_ms ?? null,
    chunks: r.markovian?.chunks ?? r.telemetry?.chunks ?? null,
    checklist_complete: r.checklist_complete ?? null,
    memo_source: r.memo?.source ?? null,
    memo_words: r.memo?.words ?? null,
    skipped_chunks: r.telemetry?.skipped_chunks ?? 0,
    skipped_steps: r.skipped_steps?.length ?? 0,
    evidence_records: r.evidence_ids?.length ?? r.evidence?.length ?? 0,
  };
}

/**
 * The events of a saved run in the order the loop emitted them: per chunk, chunk_start, then each
 * planner call followed by the tool step it chose (planner calls and tool steps are paired by
 * their order within the chunk), then chunk_end; run_started first and run_finished last.
 */
export function replayEvents(r: RunIn): StreamEvent[] {
  const out: StreamEvent[] = [];
  const base = { run_id: r.run_id, replay: true };
  out.push({ type: "run_started", data: { ...base, quarter: r.quarter ?? null, mode: r.mode ?? null, started_at: r.started_at ?? null, started_at_sgt: sgt(r.started_at) } });
  const chunkNos = new Set<number>();
  for (const c of r.chunks ?? []) chunkNos.add(c.chunk);
  for (const p of r.planner_calls ?? []) chunkNos.add(p.chunk);
  for (const t of r.chain ?? []) chunkNos.add(t.chunk);
  for (const n of [...chunkNos].sort((a, b) => a - b)) {
    const rec = (r.chunks ?? []).find((c) => c.chunk === n);
    out.push({ type: "chunk_start", data: { ...base, chunk: n, carryover_tokens: rec?.carryover_in_tokens ?? 0, recorded_at: rec?.started_at ?? null, recorded_at_sgt: sgt(rec?.started_at) } });
    const planners = (r.planner_calls ?? []).filter((p) => p.chunk === n).sort((a, b) => a.call - b.call);
    const tools = (r.chain ?? []).filter((t) => t.chunk === n).sort((a, b) => a.seq - b.seq);
    for (let i = 0; i < Math.max(planners.length, tools.length); i++) {
      const p = planners[i];
      if (p) out.push({ type: "planner", data: { ...base, chunk: n, call: p.call, valid: p.valid ?? false, attempts: p.attempts ?? 1, tool: p.chosen?.tool ?? null, thought: p.thought ?? null, prompt_tokens: p.prompt_tokens ?? 0, eval_tokens: p.eval_tokens ?? 0, tokens_per_s: p.tokens_per_s ?? null } });
      const t = tools[i];
      if (t) out.push({ type: "tool", data: { ...base, chunk: n, seq: t.seq, tool: t.tool, source: t.source ?? "model", fallback_reason: t.fallback_reason ?? null, ok: t.ok ?? false, fact: t.fact ?? "", evidence_ids: t.evidence_ids ?? [], latency_ms: t.latency_ms ?? 0 } });
    }
    out.push({ type: "chunk_end", data: { ...base, chunk: n, state_tokens: rec?.carryover_out_tokens ?? 0, complete: rec?.task_complete ?? false } });
  }
  out.push({ type: "run_finished", data: { ...base, ...finishedSummary(r), finished_at: r.finished_at ?? null, finished_at_sgt: sgt(r.finished_at) } });
  return out;
}

export interface TelemetryView {
  run_id: string;
  quarter: string | null;
  mode: string | null;
  started_at: string | null;
  started_at_sgt: string | null;
  chunks: number | null;
  max_chunks: number | null;
  skipped_chunks: number;
  skipped_note: string | null;
  tokens: { planner_in: number | null; planner_out: number | null; memo_in: number | null; memo_out: number | null; total: number | null };
  tokens_per_s: { planner_median: number | null; memo: number | null };
  wall_ms: number | null;
  wall_s: number | null;
  model: string | null;
  think: boolean | null;
  planner_calls: number | null;
  planner_valid: number | null;
  fallback_steps: number | null;
  cloud_model_calls: number;
  labels: Record<string, string>;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Footer telemetry of one run, from its run.json (SPEC D20: chunks, skipped chunks, tokens, tok/s, wall). */
export function telemetryView(r: RunIn): TelemetryView {
  const t = r.telemetry ?? {};
  const tk = t.tokens ?? {};
  const parts = [tk.planner_in, tk.planner_out, tk.memo_in, tk.memo_out].map(num);
  const total = parts.every((x) => x === null) ? null : parts.reduce<number>((a, b) => a + (b ?? 0), 0);
  const s = r.summary ?? {};
  const round1 = (x: number | null | undefined) => (typeof x === "number" ? Math.round(x * 10) / 10 : null);
  const wall = num(t.wall_ms) ?? num(r.wall_ms);
  return {
    run_id: r.run_id,
    quarter: r.quarter ?? null,
    mode: r.mode ?? null,
    started_at: r.started_at ?? null,
    started_at_sgt: sgt(r.started_at),
    chunks: num(t.chunks) ?? num(r.markovian?.chunks),
    max_chunks: num(r.markovian?.chunk_config?.maxChunks),
    skipped_chunks: num(t.skipped_chunks) ?? 0,
    skipped_note: t.skipped_note ?? null,
    tokens: { planner_in: parts[0]!, planner_out: parts[1]!, memo_in: parts[2]!, memo_out: parts[3]!, total },
    tokens_per_s: { planner_median: round1(t.median_planner_tokens_per_s), memo: round1(t.memo_tokens_per_s) },
    wall_ms: wall,
    wall_s: seconds(wall),
    model: t.model ?? null,
    think: typeof t.think === "boolean" ? t.think : null,
    planner_calls: num(s.planner_calls),
    planner_valid: num(s.planner_valid),
    fallback_steps: num(s.fallback_steps),
    cloud_model_calls: num(t.cloud_model_calls) ?? 0,
    labels: {
      tokens: "measured (Ollama prompt_eval_count and eval_count, summed over the run)",
      tokens_per_s: "measured: median over the run's planner calls; the note's rate separately",
      wall: "measured: the loop's wall time, from the start of the run to its last step",
      skipped_chunks: "measure_key steps not run because the key was recalled as VERIFIED from memory",
    },
  };
}
