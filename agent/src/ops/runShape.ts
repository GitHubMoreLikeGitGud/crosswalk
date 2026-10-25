// The parts of a saved run (data/runs/<id>/run.json) that the server's read routes use.
// Written as a loose structural shape on purpose: the loop that writes run.json changes on its own
// schedule, and a field it renames or drops must turn into a null on a screen, not into a crash or a
// type error here. Every reader below treats every field as optional.

import type { EvidenceRecord } from "../evidence/store.ts";

export interface ProvenanceIn {
  template?: string;
  params?: Record<string, string>;
  sql?: string;
  elapsed_ms?: number;
  run_id?: string;
  executed_at?: string | null;
  cache_state?: string | null;
  row_count?: number;
  columns?: string[];
  rows?: unknown[][];
}

export interface JoinRowIn {
  id?: string;
  key: string;
  label?: string | null;
  left: string;
  right: string;
  transform: string;
  proposed_by?: string[];
  status?: string;
  left_rows?: number | null;
  matched_rows?: number | null;
  rate?: number | null;
  left_keys?: number | null;
  matched_keys?: number | null;
  rate_distinct?: number | null;
  verdict?: string | null;
  orphans?: string[];
  extra?: Record<string, number>;
  measured_as?: string | null;
  sql?: string | null;
  sql_orphans?: string | null;
  elapsed_ms?: number;
  from_memory?: string | null;
  memory_key?: string;
}

export interface AnswerRowIn {
  cik: string;
  name: string;
  ticker?: string | null;
  states?: { state: string; declarations: number; by_incident_type?: Record<string, number> }[];
  declarations?: number;
  by_incident_type?: Record<string, number>;
  revenue?: { tag?: string | null; current?: number | null; previous?: number | null; change?: number | null; current_accn?: string | null; previous_accn?: string | null; note?: string | null } | null;
  revenue_note?: string | null;
  weather?: { stations?: string[]; tdd_current?: number | null; tdd_previous?: number | null; change?: number | null } | null;
  weather_note?: string | null;
  provenance?: { declarations?: ProvenanceIn; revenue_current?: ProvenanceIn; revenue_previous?: ProvenanceIn; weather?: ProvenanceIn[] };
}

export interface DqRuleIn {
  rule: string;
  total?: number | null;
  valid?: number | null;
  invalid?: number | null;
  elapsed_ms?: number | null;
  elapsed_s?: number | null;
  sql?: string | null;
  error?: string | null;
  attempts?: number;
}

export interface UslIn {
  status?: string;
  matches_governed?: boolean;
  usl?: string;
  note?: string;
  compiled?: boolean;
  fks?: { fk: string; transform?: string; support?: Record<string, unknown>; satisfied?: boolean; basis?: string }[];
  dq?: { ran_at?: string; rules?: DqRuleIn[] } | null;
  invalid_rows?: { rule: string; row: unknown[] }[];
  live_rules_run?: DqRuleIn[];
  provenance?: ProvenanceIn[];
  elapsed_ms?: number;
}

export interface TimelineIn {
  chunk: number;
  seq: number;
  source?: string;
  tool: string;
  input?: Record<string, unknown>;
  thought?: string | null;
  fallback_reason?: string | null;
  ok?: boolean;
  fact?: string;
  evidence_ids?: string[];
  latency_ms?: number;
}

export interface ChunkIn {
  chunk: number;
  started_at?: string;
  wall_ms?: number;
  carryover_in_tokens?: number;
  carryover_out_tokens?: number;
  task_complete?: boolean;
}

export interface PlannerIn {
  chunk: number;
  call: number;
  attempts?: number;
  valid?: boolean;
  chosen?: { tool?: string } | null;
  thought?: string | null;
  prompt_tokens?: number;
  eval_tokens?: number;
  tokens_per_s?: number | null;
}

export interface TelemetryIn {
  chunks?: number;
  skipped_chunks?: number;
  skipped_note?: string;
  tokens?: { planner_in?: number; planner_out?: number; memo_in?: number; memo_out?: number };
  wall_ms?: number;
  model?: string | null;
  think?: boolean;
  median_planner_tokens_per_s?: number | null;
  memo_tokens_per_s?: number | null;
  cloud_model_calls?: number;
}

export interface RunIn {
  run_id: string;
  question?: string;
  quarter?: string;
  previous_quarter?: string;
  mode?: string;
  started_at?: string;
  finished_at?: string;
  wall_ms?: number;
  chain?: TimelineIn[];
  chunks?: ChunkIn[];
  planner_calls?: PlannerIn[];
  join_map?: JoinRowIn[];
  answer?: { quarter?: string; previous?: string; rows?: AnswerRowIn[]; weather_status?: string; elapsed_ms?: number } | null;
  usl?: UslIn | null;
  telemetry?: TelemetryIn;
  summary?: Record<string, unknown>;
  markovian?: { chunks?: number; status?: string; chunk_config?: { maxChunks?: number } };
  checklist_complete?: boolean;
  memo?: { text?: string; source?: string; words?: number } | null;
  not_tested?: string[];
  skipped_steps?: { item: string; memoryId: string; note: string }[];
  evidence?: EvidenceRecord[];
  evidence_ids?: string[];
  saved?: { source?: string; at?: string };
}

/** A saved run as the read routes see it. */
export function asRun(v: unknown): RunIn {
  return v as RunIn;
}
