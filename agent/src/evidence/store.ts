// Evidence records and their JSONL store (data/evidence/<runId>.jsonl, gitignored).
// Every claim on a card cites one or more of these ids. A Zetaris record carries the
// template id and parameters, the SQL text and its sha256, the rows (at most
// MAX_EVIDENCE_ROWS), the Zetaris object, the raw source objects, the source endpoint and
// licence, the latency and cache state, and both timestamps: when the gateway ran the query
// (queried_at, the retrieval time) and when it last cached the source.
// Adapted from Weather-or-Not and ClearShelf (same author, Apache-2.0); the sources are Crosswalk's.

import { appendFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DATA_DIR_URL } from "../config.ts";
import type { TemplateResult } from "../zetaris/client.ts";

export type EvidenceKind = "zetaris_sql" | "dq" | "tool" | "model" | "memory" | "world_model" | "registrar";

export interface EvidenceModel {
  name: string;
  think: boolean;
  prompt_sha256: string;
  /** Summed over every attempt of the call (see `attempts`). */
  tokens_in: number;
  tokens_out: number;
  attempts: number;
  eval_ms: number;
  tokens_per_s: number | null;
  label: "measured";
}

export interface SourceRef {
  object: string;
  url: string;
  licence: string;
  cached_at: string | null;
}

export interface EvidenceRecord {
  id: string;
  run_id: string;
  kind: EvidenceKind;
  claim: string;
  /** The retrieval time (the gateway's executed_at for a statement). */
  queried_at: string;
  template_id?: string;
  params?: Record<string, string>;
  sql?: string;
  sql_sha256?: string;
  zetaris_object?: string;
  /** Every Zetaris object the statement reads; zetaris_object is the one the claim is about. */
  zetaris_objects?: string[];
  raw_objects?: string[];
  /** The source endpoint behind the Zetaris object (the SEC URL, the S3 prefix). */
  source_url?: string;
  licence?: string;
  source_cached_at?: string | null;
  sources?: SourceRef[];
  rows?: unknown[][];
  columns?: string[];
  row_count?: number;
  /** Statement latency as the gateway measured it. */
  elapsed_ms?: number;
  cache_state?: string;
  /** dq records: whether the result came from Zetaris DQ or from the plain-SQL equivalent. */
  dq_source?: "zetaris_dq" | "dq_equivalent_sql";
  /** True when a result from an earlier run (the DQ onboarding file) was reused. */
  reused?: boolean;
  model?: EvidenceModel;
  /** Evidence this record was computed from (tool, model and memory records). */
  derived_from?: string[];
  details?: Record<string, unknown>;
}

/** The seed universe is 43 filers and the station union 56 ids: a template reply fits whole. */
export const MAX_EVIDENCE_ROWS = 60;

export const LICENCES = {
  sec: "SEC EDGAR (US government work, public domain); fair-access policy: at most 10 requests per second with a declared User-Agent; queried live, never redistributed",
  noaa: "NOAA GHCN-Daily on the AWS Open Data public bucket (US government work, public domain; cite NOAA NCEI)",
  dns: "company_dns (Apache-2.0) serving the US SIC code list",
  usl: "Crosswalk USL (governed copies of the SEC, FEMA, NOAA and seed objects above)",
  fema: "OpenFEMA (US government work, public domain; FEMA cited as the source, not an endorsement)",
  seeds: "Crosswalk seed files (Apache-2.0), curated from public records",
} as const;

const S3_GHCN = "s3a://noaa-ghcn-pds/parquet/by_year";

/** Source endpoint and licence for a raw Zetaris object (as the gateway names it). */
export function sourceFor(rawObject: string): { url: string; licence: string } {
  const o = rawObject;
  let m = /^cw\.frames_([A-Za-z]+)_(CY\d{4}Q[1-3])$/u.exec(o);
  if (m) return { url: `https://data.sec.gov/api/xbrl/frames/us-gaap/${m[1]}/USD/${m[2]}.json`, licence: LICENCES.sec };
  m = /^cw\.concept_(\d{10})_([A-Za-z]+)$/u.exec(o);
  if (m) return { url: `https://data.sec.gov/api/xbrl/companyconcept/CIK${m[1]}/us-gaap/${m[2]}.json`, licence: LICENCES.sec };
  m = /^cw\.submission_(\d{10})$/u.exec(o);
  if (m) return { url: `https://data.sec.gov/submissions/CIK${m[1]}.json`, licence: LICENCES.sec };
  if (o === "cw.sic_codes" || o === "CW_DNS.sic_codes_v4_raw") return { url: "https://company-dns.mediumroast.io/V4.0/na/sic/code/%25", licence: LICENCES.dns };
  m = /^cw\.ghcn_(\d{4})_(tmax|tmin)$/u.exec(o);
  if (m) return { url: `${S3_GHCN}/YEAR=${m[1]}/ELEMENT=${m[2]!.toUpperCase()}/`, licence: LICENCES.noaa };
  if (o.startsWith("lightning.metastore.crosswalk.")) return { url: "zetaris-usl:crosswalk_usl", licence: LICENCES.usl };
  m = /^cw\.fema_declarations_dr_(\d{4})q([1-4])$/iu.exec(o);
  if (m) return { url: `https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries (declarationType DR, ${m[1]} Q${m[2]})`, licence: LICENCES.fema };
  if (o.toLowerCase() === "cw.fema_catalogue") return { url: "https://www.fema.gov/api/open/v1/OpenFemaDataSets", licence: LICENCES.fema };
  if (o.toLowerCase() === "cw.stations") return { url: "https://noaa-ghcn-pds.s3.amazonaws.com/ghcnd-stations.txt", licence: LICENCES.noaa };
  if (["cw.seed_utilities", "cw.seed_utility_names", "cw.utility_states"].includes(o.toLowerCase())) return { url: "seeds/utilities.json (curated from public 10-K filings; cw.seed_utilities also reads the SEC submissions views)", licence: LICENCES.seeds };
  if (o.toLowerCase() === "cw.seed_stations") return { url: "seeds/stations.json", licence: LICENCES.seeds };
  if (o.toLowerCase() === "cw.states") return { url: "seeds/states.json (US Census FIPS codes)", licence: LICENCES.seeds };
  return { url: "unknown", licence: "unknown" };
}

const ALWAYS: (keyof EvidenceRecord)[] = ["id", "run_id", "kind", "claim", "queried_at"];
const SQL_FIELDS: (keyof EvidenceRecord)[] = [
  "template_id",
  "params",
  "sql",
  "sql_sha256",
  "zetaris_object",
  "raw_objects",
  "source_url",
  "licence",
  "source_cached_at",
  "rows",
  "row_count",
  "elapsed_ms",
  "cache_state",
];

/** Fields a record of this kind must carry. */
export function requiredFields(kind: EvidenceKind): (keyof EvidenceRecord)[] {
  if (kind === "zetaris_sql") return [...ALWAYS, ...SQL_FIELDS];
  if (kind === "dq") return [...ALWAYS, ...SQL_FIELDS, "dq_source"];
  if (kind === "model") return [...ALWAYS, "model", "derived_from"];
  return [...ALWAYS, "derived_from"];
}

export function missingFields(rec: EvidenceRecord): string[] {
  const missing: string[] = requiredFields(rec.kind).filter((k) => !(k in rec) || rec[k] === undefined);
  if (rec.kind === "model" && rec.model) {
    for (const k of ["name", "think", "prompt_sha256", "tokens_in", "tokens_out", "label"] as const) {
      if (rec.model[k] === undefined) missing.push(`model.${k}`);
    }
  }
  return missing;
}

export function newRunId(now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}T${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `r${stamp}${randomBytes(2).toString("hex")}`;
}

/** Local time with its UTC offset, e.g. 2026-10-24T10:12:03+08:00. */
export function localIso(d = new Date()): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const p = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const local = new Date(d.getTime() + off * 60_000).toISOString().slice(0, 19);
  return `${local}${sign}${p(off / 60)}:${p(off % 60)}`;
}

export type NewEvidence = Omit<EvidenceRecord, "id" | "run_id" | "queried_at"> & { queried_at?: string };

export class EvidenceStore {
  readonly runId: string;
  readonly path: string | null;
  private readonly records: EvidenceRecord[] = [];

  /** `dir` null keeps the records in memory only (tests). */
  constructor(runId = newRunId(), dir: string | null = fileURLToPath(new URL("evidence/", DATA_DIR_URL))) {
    this.runId = runId;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      this.path = `${dir.replace(/[\\/]$/u, "")}/${runId}.jsonl`;
    } else {
      this.path = null;
    }
  }

  add(e: NewEvidence): EvidenceRecord {
    const id = `ev-${this.runId}-${String(this.records.length + 1).padStart(2, "0")}`;
    const rec: EvidenceRecord = { id, run_id: this.runId, ...e, queried_at: e.queried_at ?? localIso() };
    this.records.push(rec);
    if (this.path) appendFileSync(this.path, `${JSON.stringify(rec)}\n`, "utf8");
    return rec;
  }

  /**
   * A record for one gateway template result: the SQL and its hash, the rows, the Zetaris
   * object, the source endpoint and licence, the latency, the cache state and both times.
   */
  fromTemplate(res: TemplateResult, claim: string, opts: { kind?: "zetaris_sql" | "dq"; dqSource?: "zetaris_dq" | "dq_equivalent_sql"; details?: Record<string, unknown> } = {}): EvidenceRecord {
    const details: Record<string, unknown> = { ...(opts.details ?? {}) };
    // The gateway names a template's objects with their parameter placeholders (cw.ghcn_{year}_tmax); the record names the object read.
    const fill = (o: string) => o.replace(/\{(\w+)\}/gu, (m, k: string) => res.params[k] ?? m);
    const objects = res.objects.map(fill);
    const raw = res.raw_objects.map(fill);
    const sources: SourceRef[] = raw.map((o, i) => ({ object: o, ...sourceFor(o), cached_at: res.source_cached_at?.[o] ?? res.source_cached_at?.[res.raw_objects[i]!] ?? null }));
    const primary = sources[0];
    if (res.truncated) details.truncated_by_gateway = true;
    if (res.warm_retries) details.warm_retries = res.warm_retries;
    details.wall_ms = res.wall_ms;
    return this.add({
      kind: opts.kind ?? "zetaris_sql",
      claim,
      template_id: res.template_id,
      params: res.params,
      sql: res.sql ?? "",
      sql_sha256: res.sql_sha256 ?? "",
      zetaris_object: objects[0] ?? "",
      zetaris_objects: objects,
      raw_objects: raw,
      source_url: primary?.url ?? "none",
      licence: primary?.licence ?? "none",
      source_cached_at: primary?.cached_at ?? null,
      sources,
      columns: res.columns,
      rows: res.rows.slice(0, MAX_EVIDENCE_ROWS),
      row_count: res.row_count,
      elapsed_ms: res.elapsed_ms,
      cache_state: res.cache_state,
      queried_at: res.executed_at,
      ...(opts.kind === "dq" ? { dq_source: opts.dqSource ?? "zetaris_dq" } : {}),
      ...(Object.keys(details).length ? { details } : {}),
    });
  }

  all(): readonly EvidenceRecord[] {
    return this.records;
  }

  get(id: string): EvidenceRecord | undefined {
    return this.records.find((r) => r.id === id);
  }
}
