// Crosswalk's H-MEM: the vendored reference HMEM, subclassed. The reference contract is
// unchanged (the engine's conformance suite runs against this module); the subclass adds what
// the discovery loop needs:
//   - facts with Zetaris provenance {zetaris_object, sql_sha256, endpoint, licence,
//     retrieved_at, latency_ms, cache_state, evidence_id, template_id, run_id}, deduplicated per
//     fact key so a re-run reconfirms a fact instead of duplicating it; a reconfirmation with new
//     provenance refreshes it (the latest retrieval wins, the earlier ones are kept in `history`);
//   - key_verified memories {left, right, transform, rate, verdict, run_id, validFrom}: every key
//     measure_key measured, keyed by {left, right, transform} with period-specific view names
//     generalised to their family; a warm run recalls the VERIFIED ones instead of measuring again;
//   - source_access memories {object, registered_at, rows}: what register_source registered (or
//     found registered), so the next run knows the view exists and since when;
//   - why(memoryId): the memory, its provenance, its structured record and its ledger history;
//   - source notes and negative memories seeded at boot (seed.ts).
// Runtime state lives in <data>/hmem (gitignored): state.json and ledger.jsonl from the reference,
// plus provenance.json, keys.json, sources.json and seed.json.
// Adapted from Weather-or-Not and ClearShelf (same author, Apache-2.0).

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
import type { MeasureResult } from "../tools/discovery.ts";

export type { HMEMOptions, LedgerEntry, MemoryRecord } from "../../../engines/hmem/reference/src/index.ts";

export const HMEM_DIR = fileURLToPath(new URL("hmem/", DATA_DIR_URL));
export const AGENT_ACTOR = "cw-agent";

/** Which seeded source notes a tool depends on (source tags of the notes). */
export const TOOL_SOURCES: Readonly<Record<string, string[]>> = {
  search_catalogue: ["zetaris", "catalogue"],
  probe_source: ["zetaris"],
  measure_key: ["joinmap", "zetaris"],
  register_source: ["fema", "sec", "zetaris"],
  compile_usl: ["usl"],
  answer: ["fema", "sec", "noaa"],
};

const sha = (s: string, n = 12) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, n);
const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

// ---------------------------------------------------------------- provenance

/** What every fact records about where its number came from. */
export interface CwProvenance {
  zetaris_object: string | null;
  sql_sha256: string | null;
  endpoint: string | null;
  licence: string | null;
  retrieved_at: string;
  latency_ms: number | null;
  cache_state: string | null;
  evidence_id: string | null;
  template_id: string | null;
  run_id: string | null;
}

export const PROVENANCE_HISTORY = 5;

export interface StoredProvenance extends CwProvenance {
  history?: CwProvenance[];
}

/** Provenance from a Zetaris evidence record. */
export function provenanceOf(ev: EvidenceRecord): CwProvenance {
  return {
    zetaris_object: ev.zetaris_object ?? null,
    sql_sha256: ev.sql_sha256 ?? null,
    endpoint: ev.source_url ?? null,
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
  content: string;
  /** "zetaris:<object>", "tool:<name>", "seed:<file>". */
  source: string;
  label: string;
  provenance?: CwProvenance | null;
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

/** A key_verified memory's structured record (keys.json). */
export interface KeyVerifiedRecord {
  memory_key: string;
  left: string;
  right: string;
  transform: string;
  rate: number | null;
  rate_distinct: number | null;
  verdict: string | null;
  matched_rows: number | null;
  left_rows: number | null;
  orphans: string[];
  /** The route key it was measured as (cik@CY2025Q1): the period or quarter the rate holds for. */
  measured_as: string | null;
  run_id: string;
  /** When Lightning measured it (the measurement's own time). */
  validFrom: string;
  sql: string | null;
  evidence_ids: string[];
  result: MeasureResult;
  /** Earlier measurements of the same key (most recent first). */
  history: { rate: number | null; verdict: string | null; run_id: string; validFrom: string; measured_as: string | null }[];
}

/** A source_access memory's structured record (sources.json). */
export interface SourceAccessRecord {
  object: string;
  catalogue_id: string;
  params: Record<string, string>;
  status: string;
  registered_at: string;
  rows: number | null;
  run_id: string;
  contract_id: string | null;
  evidence_id: string | null;
  confirmed: { status: string; at: string; run_id: string }[];
}

export interface WhyTrace {
  memory: MemoryRecord | null;
  provenance: StoredProvenance | null;
  key: KeyVerifiedRecord | null;
  source: SourceAccessRecord | null;
  ledger: LedgerEntry[];
  related: { supersedes: string | null; supersededBy: string | null };
  lines: string[];
}

export interface CwHMEMOptions extends HMEMOptions {
  persistDir?: string;
}

const pct3 = (x: number | null) => (x === null ? "n/a" : x.toFixed(3));

export class HMEM extends ReferenceHMEM {
  readonly actor: string;
  readonly persistDir: string | null;
  private provenance: Record<string, StoredProvenance> = {};
  private keys: Record<string, KeyVerifiedRecord> = {};
  private sources: Record<string, SourceAccessRecord> = {};
  private seeded: Record<string, { sha12: string; memoryIds: string[]; via: string; at: string }> = {};

  constructor(opts: CwHMEMOptions = {}) {
    super(opts);
    this.actor = opts.actor ?? "system";
    this.persistDir = opts.persistDir ?? null;
    if (this.persistDir) {
      const read = <T>(name: string, fallback: T): T => {
        const p = path.join(this.persistDir!, name);
        return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : fallback;
      };
      this.provenance = read("provenance.json", {});
      this.keys = read("keys.json", {});
      this.sources = read("sources.json", {});
      this.seeded = read("seed.json", {});
    }
  }

  private writeFile(name: string, data: unknown): void {
    if (!this.persistDir) return;
    mkdirSync(this.persistDir, { recursive: true });
    writeFileSync(path.join(this.persistDir, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
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

  /** Adds a fact, or reconfirms it (refs merged, a read logged, provenance refreshed). */
  addFact(f: FactInput): FactResult {
    const key = HMEM.factKey(f);
    const existing = this.byTag(`fact:${key}`);
    const refs = (f.refs ?? []).filter((r) => !!r);
    if (existing) {
      const old = existing.provenance.refs ?? [];
      const fresh = refs.filter((r) => !old.includes(r));
      const refreshed = f.provenance ? this.refreshProvenance(existing.id, f.provenance) : false;
      if (fresh.length) {
        this.store.update(existing.id, { provenance: { ...existing.provenance, refs: [...old, ...fresh].slice(-12) } });
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

  private refreshProvenance(memoryId: string, prov: CwProvenance): boolean {
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

  provenanceFor(memoryId: string): StoredProvenance | null {
    return this.provenance[memoryId] ?? null;
  }

  // ------------------------------------------------------------ key_verified

  /**
   * Records one measured key (any verdict). The fact is keyed by {left, right, transform}; a later
   * measurement of the same key refreshes the record (the earlier one moves to `history`).
   */
  rememberKey(input: { memoryKey: string; result: MeasureResult; runId: string; at: string; evidenceIds: string[]; provenance: CwProvenance | null }): FactResult {
    const r = input.result;
    const p = r.proposal;
    const left = `${p.leftObject}.${p.leftColumn}`;
    const right = `${p.rightObject}.${p.rightColumn}`;
    const fr = this.addFact({
      content: `Join key ${input.memoryKey}: measured in Lightning SQL as ${r.key ?? "?"}, ${r.matched_rows ?? "?"} of ${r.left_rows ?? "?"} matched (${pct3(r.rate)}), ${r.verdict ?? "unmeasured"}${r.orphans.length ? `; orphans ${r.orphans.slice(0, 3).join("; ")}` : ""}.`,
      source: `zetaris:${p.leftObject.toLowerCase()}`,
      label: "key_verified (measure_key through the Zetaris gateway)",
      provenance: input.provenance,
      refs: input.evidenceIds,
      key: `key_verified|${input.memoryKey}`,
      tags: ["kind:key_verified", `keysig:${input.memoryKey}`],
      layer: "long_term",
      confidence: r.verdict === "VERIFIED" ? 0.95 : r.verdict === "PARTIAL" ? 0.8 : 0.6,
      origin: "plan_completion",
    });
    const prev = this.keys[fr.memory.id];
    const history = prev ? [{ rate: prev.rate, verdict: prev.verdict, run_id: prev.run_id, validFrom: prev.validFrom, measured_as: prev.measured_as }, ...prev.history].slice(0, PROVENANCE_HISTORY) : [];
    this.keys[fr.memory.id] = {
      memory_key: input.memoryKey,
      left,
      right,
      transform: p.transform,
      rate: r.rate,
      rate_distinct: r.rate_distinct,
      verdict: r.verdict,
      matched_rows: r.matched_rows,
      left_rows: r.left_rows,
      orphans: r.orphans,
      measured_as: r.key,
      run_id: input.runId,
      validFrom: input.at,
      sql: r.sql,
      evidence_ids: input.evidenceIds,
      result: { ...r, provenance: r.provenance.slice(0, 2), from_memory: null },
      history,
    };
    this.writeFile("keys.json", this.keys);
    return fr;
  }

  /** The remembered key under this memory key (any verdict), with the read logged; null when none. */
  recallKey(memoryKey: string, use = "warm run: measure step skipped"): { record: KeyVerifiedRecord; memory: MemoryRecord } | null {
    const m = this.allByTag(`keysig:${memoryKey}`).find((x) => !x.supersededBy);
    const record = m ? this.keys[m.id] : undefined;
    if (!m || !record) return null;
    this.store.touch(m.id);
    this.ledger.log(m.id, "read", this.actor, { details: { use, memory_key: memoryKey } });
    return { record, memory: m };
  }

  /** Every key_verified record (no ledger read). */
  keyRecords(): { memoryId: string; record: KeyVerifiedRecord }[] {
    return Object.entries(this.keys).map(([memoryId, record]) => ({ memoryId, record }));
  }

  // ------------------------------------------------------------ source_access

  rememberSource(input: { object: string; catalogueId: string; params: Record<string, string>; status: string; rows: number | null; runId: string; at: string; contractId: string | null; evidenceId: string | null }): FactResult {
    const object = input.object.toLowerCase();
    const fr = this.addFact({
      content: `Source ${object} (${input.catalogueId} ${JSON.stringify(input.params)}) is registered and cached in Zetaris${input.rows === null ? "" : ` (${input.rows} rows)`}; register_source answered ${input.status}.`,
      source: `zetaris:${object}`,
      label: "source_access (register_source through the gateway registrar)",
      refs: input.evidenceId ? [input.evidenceId] : [],
      key: `source_access|${object}`,
      tags: ["kind:source_access", `object:${object}`],
      layer: "long_term",
      confidence: 0.9,
      origin: "plan_completion",
    });
    const prev = this.sources[fr.memory.id];
    const confirmed = [{ status: input.status, at: input.at, run_id: input.runId }, ...(prev?.confirmed ?? [])].slice(0, PROVENANCE_HISTORY);
    this.sources[fr.memory.id] = prev && input.status === "already_registered"
      ? { ...prev, confirmed }
      : { object, catalogue_id: input.catalogueId, params: input.params, status: input.status, registered_at: prev?.registered_at ?? input.at, rows: input.rows ?? prev?.rows ?? null, run_id: input.runId, contract_id: input.contractId, evidence_id: input.evidenceId, confirmed };
    this.writeFile("sources.json", this.sources);
    return fr;
  }

  /** Every object a source_access memory says is registered (no ledger read). */
  sourceObjects(): string[] {
    return Object.values(this.sources).map((s) => s.object);
  }

  sourceAccess(object: string): { record: SourceAccessRecord; memoryId: string } | null {
    const m = this.byTag(`object:${object.toLowerCase()}`);
    const record = m ? this.sources[m.id] : undefined;
    return m && record ? { record, memoryId: m.id } : null;
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

  /** Chunk-0 memory context: keys earlier runs measured, sources they registered, and the negative memories. */
  memoryContext(limitChars = 1600): string {
    const parts: string[] = [];
    const keys = this.keyRecords().filter((k) => k.record.verdict === "VERIFIED");
    if (keys.length) parts.push(["[KEYS VERIFIED IN EARLIER RUNS]", ...keys.slice(0, 8).map((k) => `- ${k.record.left} ~ ${k.record.right} (${k.record.transform}): ${k.record.verdict} ${pct3(k.record.rate)} as ${k.record.measured_as} <${k.memoryId}>`), "[/KEYS VERIFIED IN EARLIER RUNS]"].join("\n"));
    const neg = this.allByTag("negative").filter((m) => m.tags.includes("source:catalogue")).slice(0, 3);
    if (neg.length) parts.push(["[NEGATIVE MEMORIES]", ...neg.map((m) => `- ${m.content} <${m.id}>`), "[/NEGATIVE MEMORIES]"].join("\n"));
    const out = parts.join("\n");
    return out.length > limitChars ? `${out.slice(0, limitChars - 1)}…` : out;
  }

  // ------------------------------------------------------------ why

  why(memoryId: string): WhyTrace {
    const memory = this.store.get(memoryId) ?? null;
    const provenance = this.provenanceFor(memoryId);
    const key = this.keys[memoryId] ?? null;
    const source = this.sources[memoryId] ?? null;
    const ledger = this.ledger.history(memoryId);
    const lines: string[] = [];
    if (!memory) lines.push(`No memory ${memoryId}.`);
    else {
      lines.push(`${memory.content} (source ${memory.source}; ${memory.provenance.label}; learned ${new Date(memory.provenance.learnedAt).toISOString()}; confidence ${memory.confidence}).`);
      if (key) lines.push(`Key ${key.left} ~ ${key.right} (${key.transform}): ${key.verdict} ${pct3(key.rate)} as ${key.measured_as}, run ${key.run_id}, valid from ${key.validFrom}${key.history.length ? `; ${key.history.length} earlier measurement(s), the first ${key.history[key.history.length - 1]!.validFrom}` : ""}.`);
      if (source) lines.push(`Source ${source.object}: ${source.status} at ${source.registered_at} in run ${source.run_id}${source.rows === null ? "" : `, ${source.rows} rows`}${source.contract_id ? `, contract ${source.contract_id}` : ""}; confirmed ${source.confirmed.length} time(s).`);
      if (provenance) lines.push(`Provenance: ${provenance.zetaris_object ?? "no Zetaris object"}${provenance.sql_sha256 ? `, SQL sha256 ${provenance.sql_sha256.slice(0, 12)}` : ""}; retrieved ${provenance.retrieved_at}${provenance.latency_ms !== null ? ` in ${provenance.latency_ms} ms` : ""}${provenance.evidence_id ? ` (evidence ${provenance.evidence_id}${provenance.run_id ? `, run ${provenance.run_id}` : ""})` : ""}.`);
      if (memory.provenance.refs?.length) lines.push(`Evidence: ${memory.provenance.refs.join(", ")}.`);
      const reads = ledger.filter((e) => e.action === "read").length;
      const rest = ledger.filter((e) => e.action !== "read").map((e) => `${e.action} (${e.actor}, ${new Date(e.timestamp).toISOString().slice(0, 16)}Z)`);
      lines.push(`Ledger: ${[...rest, ...(reads ? [`read x${reads}`] : [])].join(" -> ") || "no entries"}.`);
      if (memory.supersededBy) lines.push(`Superseded by ${memory.supersededBy}.`);
    }
    return { memory, provenance, key, source, ledger, related: { supersedes: memory?.supersedes ?? null, supersededBy: memory?.supersededBy ?? null }, lines };
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

/** The agent's H-MEM: persisted under <data>/hmem, actor cw-agent. */
export function openMemory(opts: { persistDir?: string | null; clock?: () => number } = {}): HMEM {
  const persistDir = opts.persistDir === undefined ? HMEM_DIR : opts.persistDir;
  return new HMEM({ persistDir: persistDir ?? undefined, actor: AGENT_ACTOR, clock: opts.clock });
}
