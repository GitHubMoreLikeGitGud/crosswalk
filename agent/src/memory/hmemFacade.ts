// Weather-or-Not's H-MEM: the vendored reference HMEM, subclassed. The reference contract
// is unchanged (the engine's conformance suite runs against this module); the subclass adds
// what the weather-attribution agent needs:
//   - facts with Zetaris provenance {zetaris_object, sql_sha256, endpoint, accn, filed,
//     licence, retrieved_at, latency_ms, cache_state}, deduplicated per fact key so a re-run
//     reconfirms a fact instead of duplicating it; a reconfirmation with new provenance
//     refreshes it (the latest retrieval wins, the earlier ones are kept in `history`, at
//     most PROVENANCE_HISTORY entries);
//   - the recast_comparative conflicts (recastConflicts.ts), resolved by rule R1, with the
//     analyst override hook;
//   - tag_choice and station_choice facts that persist across runs, so a warm run skips the
//     probe step and the ledger shows the read;
//   - why(factId): the memory, its provenance, its ledger history and the conflicts it is in;
//   - source notes seeded at boot (seed.ts) and retrieved per tool for the planner's context.
// Runtime state lives in data/hmem (gitignored): state.json and ledger.jsonl from the
// reference, plus provenance.json, recast_conflicts.json and seed.json.
// Adapted from ClearShelf (same author, Apache-2.0).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  HMEM as ReferenceHMEM,
  type HMEMOptions,
  type LedgerEntry,
  type MemoryRecord,
  type MemoryType,
  type ProvenanceOrigin,
} from "../../../engines/hmem/reference/src/index.ts";
import { DATA_DIR_URL } from "../config.ts";
import type { EvidenceRecord } from "../evidence/store.ts";
import type { RevenueTag } from "../tools/frames.ts";
import { RecastConflictService, type RecastConflict } from "./recastConflicts.ts";

export type { HMEMOptions, LedgerEntry, MemoryRecord } from "../../../engines/hmem/reference/src/index.ts";
export type { RecastConflict } from "./recastConflicts.ts";

export const HMEM_DIR = fileURLToPath(new URL("hmem/", DATA_DIR_URL));
export const AGENT_ACTOR = "won-agent";
export const ANALYST = "analyst";

/** Retrieval threshold for loop context; the reference default (0.35) suits short memories, not source notes. */
export const CONTEXT_THRESHOLD = 0.2;

/** Which seeded source notes a tool depends on (source tags of the notes). */
export const TOOL_SOURCES: Readonly<Record<string, string[]>> = {
  resolve_utility: ["sec", "zetaris"],
  probe_revenue_tag: ["sec"],
  register_frames: ["sec", "zetaris"],
  get_revenue: ["sec"],
  get_peers: ["sec", "company_dns"],
  get_weather: ["noaa", "zetaris"],
  dq_gate: ["zetaris"],
};

const sha = (s: string, n = 12) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, n);
const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

// ---------------------------------------------------------------- provenance

/** What every fact records about where its number came from (SPEC 7). */
export interface WonProvenance {
  zetaris_object: string | null;
  sql_sha256: string | null;
  endpoint: string | null;
  accn: string | null;
  filed: string | null;
  licence: string | null;
  retrieved_at: string;
  latency_ms: number | null;
  cache_state: string | null;
  evidence_id: string | null;
  template_id: string | null;
  run_id: string | null;
}

/** Earlier retrievals kept per fact when its provenance is refreshed (D1). */
export const PROVENANCE_HISTORY = 5;

/** What provenance.json holds per memory: the latest retrieval, plus the earlier ones (most recent first). */
export interface StoredProvenance extends WonProvenance {
  history?: WonProvenance[];
}

/** Provenance from a Zetaris evidence record (plus the filing the fact names, when it names one). */
export function provenanceOf(ev: EvidenceRecord, extra: { accn?: string | null; filed?: string | null } = {}): WonProvenance {
  return {
    zetaris_object: ev.zetaris_object ?? null,
    sql_sha256: ev.sql_sha256 ?? null,
    endpoint: ev.source_url ?? null,
    accn: extra.accn ?? null,
    filed: extra.filed ?? null,
    licence: ev.licence ?? null,
    retrieved_at: ev.queried_at,
    latency_ms: ev.elapsed_ms ?? null,
    cache_state: ev.cache_state ?? null,
    evidence_id: ev.id,
    template_id: ev.template_id ?? null,
    run_id: ev.run_id,
  };
}

// ---------------------------------------------------------------- facts

export interface FactInput {
  /** One sentence. */
  content: string;
  /** "zetaris:<object>", "tool:<name>", "seed:<file>". */
  source: string;
  label: string;
  provenance?: WonProvenance | null;
  /** Evidence ids and other references. */
  refs?: string[];
  tags?: string[];
  /** Dedupe key; default: the source and the content. */
  key?: string;
  confidence?: number;
  type?: MemoryType;
  layer?: "working" | "long_term";
  origin?: ProvenanceOrigin;
}

export interface FactResult {
  memory: MemoryRecord;
  created: boolean;
}

export interface WhyTrace {
  memory: MemoryRecord | null;
  /** The latest retrieval; `history` holds the earlier ones. */
  provenance: StoredProvenance | null;
  ledger: LedgerEntry[];
  conflicts: RecastConflict[];
  /** Memories this one superseded or is superseded by. */
  related: { supersedes: string | null; supersededBy: string | null };
  lines: string[];
}

export interface WonHMEMOptions extends HMEMOptions {
  persistDir?: string;
}

export class HMEM extends ReferenceHMEM {
  readonly actor: string;
  readonly persistDir: string | null;
  readonly recasts: RecastConflictService;
  private provenance: Record<string, StoredProvenance> = {};
  private seeded: Record<string, { sha12: string; memoryIds: string[]; via: string; at: string }> = {};

  constructor(opts: WonHMEMOptions = {}) {
    super(opts);
    this.actor = opts.actor ?? "system";
    this.persistDir = opts.persistDir ?? null;
    if (this.persistDir) {
      const p = path.join(this.persistDir, "provenance.json");
      if (existsSync(p)) this.provenance = JSON.parse(readFileSync(p, "utf8")) as typeof this.provenance;
      const s = path.join(this.persistDir, "seed.json");
      if (existsSync(s)) this.seeded = JSON.parse(readFileSync(s, "utf8")) as typeof this.seeded;
    }
    this.recasts = new RecastConflictService({ store: this.store, ledger: this.ledger, clock: this.clock, actor: this.actor }, this.persistDir);
  }

  private writeFile(name: string, data: unknown): void {
    if (!this.persistDir) return;
    mkdirSync(this.persistDir, { recursive: true });
    writeFileSync(path.join(this.persistDir, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  /**
   * Runs `fn` with every reference service logging as `actor` (the reference fixes the
   * actor at construction). Synchronous only, so no other write can interleave.
   */
  withActor<T>(actor: string, fn: () => T): T {
    const services = [this.store, this.retrieval, this.conflicts, this.sleep, this.dreaming] as unknown as { actor?: unknown }[];
    if (typeof services[0]!.actor !== "string") throw new Error("H-MEM facade: the reference store no longer carries an actor field; withActor cannot attribute writes");
    const saved = services.map((s) => s.actor);
    for (const s of services) if (typeof s.actor === "string") s.actor = actor;
    try {
      const out = fn();
      if (out instanceof Promise) throw new Error("withActor takes a synchronous function");
      return out;
    } finally {
      services.forEach((s, i) => {
        if (typeof saved[i] === "string") s.actor = saved[i];
      });
    }
  }

  byTag(tag: string): MemoryRecord | undefined {
    return this.store.all().find((m) => m.tags.includes(tag));
  }

  allByTag(tag: string): MemoryRecord[] {
    return this.store.all().filter((m) => m.tags.includes(tag));
  }

  // ------------------------------------------------------------ facts

  static factKey(f: FactInput): string {
    return sha(stable({ source: f.source, key: f.key ?? f.content }));
  }

  /**
   * Adds a fact the agent relies on, or reconfirms it with the new evidence (refs merged, an
   * update logged). A reconfirmation that carries provenance refreshes the stored provenance:
   * the latest retrieval wins and the earlier ones move to `history` (D1).
   */
  addFact(f: FactInput): FactResult {
    const key = HMEM.factKey(f);
    const existing = this.byTag(`fact:${key}`);
    const refs = (f.refs ?? []).filter((r) => !!r);
    if (existing) {
      const old = existing.provenance.refs ?? [];
      const fresh = refs.filter((r) => !old.includes(r));
      const refreshed = f.provenance ? this.refreshProvenance(existing.id, f.provenance) : false;
      if (fresh.length) {
        this.store.update(existing.id, { provenance: { ...existing.provenance, refs: [...old, ...fresh].slice(0, 12) } });
      } else {
        this.store.touch(existing.id);
        this.ledger.log(existing.id, "read", this.actor, { details: { reconfirmed: true, ...(refreshed ? { provenance_refreshed: true } : {}) } });
      }
      return { memory: existing, created: false };
    }
    const memory = this.store.add({
      content: f.content,
      type: f.type ?? "factual",
      layer: f.layer ?? "working",
      tags: ["kind:fact", `fact:${key}`, ...(f.tags ?? [])],
      confidence: f.confidence ?? 0.8,
      source: f.source,
      provenance: { origin: f.origin ?? "document", learnedAt: this.clock(), label: f.label, refs },
    });
    if (f.provenance) {
      this.provenance[memory.id] = f.provenance;
      this.writeFile("provenance.json", this.provenance);
    }
    return { memory, created: true };
  }

  /** Stores the latest provenance of a fact; the previous entry goes to the front of `history` (capped). Returns whether anything changed. */
  private refreshProvenance(memoryId: string, prov: WonProvenance): boolean {
    const prev = this.provenance[memoryId];
    if (prev && prev.evidence_id !== null && prev.evidence_id === prov.evidence_id && prev.retrieved_at === prov.retrieved_at) return false;
    let next: StoredProvenance = { ...prov };
    if (prev) {
      const { history: older = [], ...latest } = prev;
      next = { ...next, history: [latest, ...older].slice(0, PROVENANCE_HISTORY) };
    }
    this.provenance[memoryId] = next;
    this.writeFile("provenance.json", this.provenance);
    return true;
  }

  /** The latest provenance of a fact (with the earlier retrievals in `history`). */
  provenanceFor(memoryId: string): StoredProvenance | null {
    return this.provenance[memoryId] ?? null;
  }

  // ------------------------------------------------------------ choices that persist across runs

  rememberTagChoice(cik: string, period: string, tag: RevenueTag, prov: WonProvenance | null, refs: string[]): FactResult {
    return this.addFact({
      content: `Revenue tag for CIK ${cik} in ${period}: ${tag} (the first tag with a frames fact in the probe order Revenues, RevenueFromContractWithCustomerExcludingAssessedTax, RegulatedAndUnregulatedOperatingRevenue).`,
      source: `zetaris:${prov?.zetaris_object ?? "won.frames"}`,
      label: "tag_choice (SEC frames probe through Zetaris)",
      provenance: prov,
      refs,
      key: `tag_choice|${cik}|${period}`,
      tags: ["kind:tag_choice", `cik:${cik}`, `period:${period}`, `tag:${tag}`],
      layer: "long_term",
      confidence: 0.9,
    });
  }

  /** The remembered tag for a question, with the read logged in the ledger; null on a cold run. */
  tagChoice(cik: string, period: string): { tag: RevenueTag; memory: MemoryRecord } | null {
    const m = this.allByTag("kind:tag_choice").find((x) => x.tags.includes(`cik:${cik}`) && x.tags.includes(`period:${period}`) && !x.supersededBy);
    if (!m) return null;
    const tag = m.tags.find((t) => t.startsWith("tag:"))?.slice(4) as RevenueTag | undefined;
    if (!tag) return null;
    this.store.touch(m.id);
    this.ledger.log(m.id, "read", this.actor, { details: { use: "warm run: probe step skipped", cik, period } });
    return { tag, memory: m };
  }

  rememberStationChoice(cik: string, stations: string[], prov: WonProvenance | null, refs: string[]): FactResult {
    const list = [...stations].sort();
    return this.addFact({
      content: `Stations for CIK ${cik}: ${list.join(", ")} (GHCN first-order airport stations, one or two per served state, from the curated seed list).`,
      source: "seed:seeds/utilities.json",
      label: "station_choice",
      provenance: prov,
      refs,
      key: `station_choice|${cik}|${list.join(",")}`,
      tags: ["kind:station_choice", `cik:${cik}`, ...list.map((s) => `station:${s}`)],
      layer: "long_term",
      confidence: 0.9,
    });
  }

  stationChoice(cik: string): { stations: string[]; memory: MemoryRecord } | null {
    const m = this.allByTag("kind:station_choice").find((x) => x.tags.includes(`cik:${cik}`) && !x.supersededBy);
    if (!m) return null;
    this.store.touch(m.id);
    this.ledger.log(m.id, "read", this.actor, { details: { use: "warm run: station list recalled", cik } });
    return { stations: m.tags.filter((t) => t.startsWith("station:")).map((t) => t.slice(8)), memory: m };
  }

  // ------------------------------------------------------------ retrieval for the loop

  /** Source notes for a tool, by source tag, each logged as a ledger read. */
  notesForTool(tool: string, limit = 4): { memories: MemoryRecord[]; context: string } {
    const sources = TOOL_SOURCES[tool] ?? [];
    const picked: MemoryRecord[] = [];
    for (const src of sources) {
      for (const m of this.store.all()) {
        if (picked.length >= limit) break;
        if (m.supersededBy || picked.includes(m)) continue;
        if (m.tags.includes("kind:source_note") && m.tags.includes(`source:${src}`)) picked.push(m);
      }
    }
    for (const m of picked) {
      this.store.touch(m.id);
      this.ledger.log(m.id, "read", this.actor, { details: { tool } });
    }
    const context = picked.length ? ["[SOURCE NOTES]", ...picked.map((m) => `- ${m.content} <${m.id}; ${m.provenance.label}>`), "[/SOURCE NOTES]"].join("\n") : "";
    return { memories: picked, context };
  }

  /** Chunk-0 memory context: what earlier runs settled for this utility and the notes that matter. */
  memoryContext(s: { cik: string; period: string }): string {
    const parts: string[] = [];
    const known: string[] = [];
    const tag = this.allByTag("kind:tag_choice").find((x) => x.tags.includes(`cik:${s.cik}`) && x.tags.includes(`period:${s.period}`) && !x.supersededBy);
    if (tag) known.push(`- ${tag.content} <${tag.id}>`);
    const st = this.allByTag("kind:station_choice").find((x) => x.tags.includes(`cik:${s.cik}`) && !x.supersededBy);
    if (st) known.push(`- ${st.content} <${st.id}>`);
    if (known.length) parts.push(["[REMEMBERED FROM EARLIER RUNS]", ...known, "[/REMEMBERED FROM EARLIER RUNS]"].join("\n"));
    const rc = this.recasts.forCik(s.cik);
    if (rc.length) {
      parts.push(
        [
          "[RECAST CONFLICTS ON RECORD]",
          ...rc.map((c) => `- ${c.id}: ${c.tag} ${c.period} ${c.own_filing.val} in ${c.own_filing.accn} vs ${c.later_filing.val} in ${c.later_filing.accn}; ${c.status === "overridden" ? `overridden by ${c.override?.by}` : "resolved by rule R1"} (${c.chosen})`),
          "[/RECAST CONFLICTS ON RECORD]",
        ].join("\n"),
      );
    }
    const notes = this.store
      .all()
      .filter((m) => m.tags.includes("kind:source_note") && !m.supersededBy)
      .slice(0, 3);
    if (notes.length) parts.push(["[SOURCE NOTES]", ...notes.map((m) => `- ${m.content} <${m.id}>`), "[/SOURCE NOTES]"].join("\n"));
    return parts.join("\n");
  }

  // ------------------------------------------------------------ why

  /** "Why do you believe this?": the memory, its Zetaris provenance, the ledger history and the conflicts it is in. */
  why(memoryId: string): WhyTrace {
    const memory = this.store.get(memoryId) ?? null;
    const provenance = this.provenanceFor(memoryId);
    const ledger = this.ledger.history(memoryId);
    const conflicts = this.recasts.involving(memoryId);
    const lines: string[] = [];
    if (!memory) lines.push(`No memory ${memoryId}.`);
    else {
      lines.push(`${memory.content} (source ${memory.source}; ${memory.provenance.label}; learned ${new Date(memory.provenance.learnedAt).toISOString()}; confidence ${memory.confidence}).`);
      if (provenance) {
        const earlier = provenance.history?.length ?? 0;
        lines.push(
          `Provenance: ${provenance.zetaris_object ?? "no Zetaris object"}${provenance.sql_sha256 ? `, SQL sha256 ${provenance.sql_sha256.slice(0, 12)}` : ""}${provenance.endpoint ? `, endpoint ${provenance.endpoint}` : ""}${provenance.accn ? `, filing ${provenance.accn}${provenance.filed ? ` filed ${provenance.filed}` : ""}` : ""}; retrieved ${provenance.retrieved_at}${provenance.latency_ms !== null ? ` in ${provenance.latency_ms} ms` : ""}${provenance.cache_state ? `, cache ${provenance.cache_state}` : ""}${provenance.evidence_id ? ` (evidence ${provenance.evidence_id}${provenance.run_id ? `, run ${provenance.run_id}` : ""})` : ""}; licence: ${provenance.licence ?? "n/a"}${earlier ? `; ${earlier} earlier retrieval(s) kept, the first ${provenance.history![earlier - 1]!.retrieved_at}` : ""}.`,
        );
      }
      if (memory.provenance.refs?.length) lines.push(`Evidence: ${memory.provenance.refs.join(", ")}.`);
      for (const c of conflicts) {
        lines.push(
          `Conflict ${c.id} (${c.kind}, ${c.tag} ${c.period}): ${c.own_filing.val} in ${c.own_filing.accn} (filed ${c.own_filing.filed}) vs ${c.later_filing.val} in ${c.later_filing.accn} (filed ${c.later_filing.filed}); ${c.rule_text}; using ${c.chosen} = ${c.chosen_val}${c.override ? `; overridden by ${c.override.by} at ${c.override.at}: "${c.override.reason}"` : ""}.`,
        );
      }
      const reads = ledger.filter((e) => e.action === "read").length;
      const rest = ledger.filter((e) => e.action !== "read").map((e) => `${e.action} (${e.actor}, ${new Date(e.timestamp).toISOString().slice(0, 16)}Z)`);
      lines.push(`Ledger: ${[...rest, ...(reads ? [`read x${reads}`] : [])].join(" -> ") || "no entries"}.`);
      if (memory.supersededBy) lines.push(`Superseded by ${memory.supersededBy} (kept for the record, penalised in retrieval).`);
    }
    return { memory, provenance, ledger, conflicts, related: { supersedes: memory?.supersedes ?? null, supersededBy: memory?.supersededBy ?? null }, lines };
  }

  // ------------------------------------------------------------ seeding bookkeeping

  seededDocs(): Readonly<typeof this.seeded> {
    return this.seeded;
  }

  markSeeded(file: string, info: { sha12: string; memoryIds: string[]; via: string }): void {
    this.seeded[file] = { ...info, at: new Date(this.clock()).toISOString() };
    this.writeFile("seed.json", this.seeded);
  }
}

/** The agent's H-MEM: persisted under data/hmem, actor won-agent. */
export function openMemory(opts: { persistDir?: string | null; clock?: () => number } = {}): HMEM {
  const persistDir = opts.persistDir === undefined ? HMEM_DIR : opts.persistDir;
  return new HMEM({ persistDir: persistDir ?? undefined, actor: AGENT_ACTOR, clock: opts.clock });
}
