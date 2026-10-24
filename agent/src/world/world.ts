// The utility graph on the vendored World Model reference (event-sourced, bitemporal).
// Entities: utility (sec:cik), state (us:XX), station (ghcn:id), sic (code), filing
// (sec:accn), quarter (cy:CYyyyyQn). Relationships: serves (utility -> state, with the
// validity window of the 10-K description), represented_by (state -> station), peer_of
// (utility -> utility, per question period, with g, dw and the peer's tag), reported_in
// (utility -> filing, per tag and period, with the value), recasts (filing -> filing, the
// later filing restates the earlier filing's value for a period), classified_as (utility ->
// sic) and observed_in (station -> quarter, with the degree days). Every write carries
// provenance whose `at` is the source record's own date (the filing's filed date, the
// quarter's end, the seed file's generation time), never the retrieval time, so re-ingesting
// the same rows writes nothing (the reference idempotency check).
//
// Two rulings on top of the reference, kept from ClearShelf:
// - The reference closes an open edge when a new edge has the same (from, type, context)
//   and a different target. Multi-valued relations here carry a per-target context
//   "<scope>#<key>" so every target keeps its own open edge.
// - An edge whose attributes change is closed by relating the same context to the target
//   "retracted" at the new source time; "retracted" is never an entity.
// Adapted from ClearShelf (same author, Apache-2.0).

import { fileURLToPath } from "node:url";
import {
  WorldModel,
  canonicalJson,
  externalId,
  sha256Hex,
  type Entity,
  type Fact,
  type Provenance,
  type Relationship,
  type WorldEvent,
} from "../../../engines/world-model/reference/src/index.ts";
import { DATA_DIR_URL } from "../config.ts";
import type { StationQuarter } from "../tools/degreeDays.ts";

export const WORLD_NAMESPACE = "weatherornot";
export const WORLD_DIR = fileURLToPath(new URL("world/", DATA_DIR_URL));
export const RETRACTED = "retracted";

// ---------------------------------------------------------------- ids

export const utilityId = (cik: string): string => externalId("utility", "sec", cik);
export const stateId = (st: string): string => externalId("state", "us", st);
export const stationId = (id: string): string => externalId("station", "ghcn", id);
export const sicId = (code: string): string => externalId("sic", "code", code);
export const filingId = (accn: string): string => externalId("filing", "sec", accn);
export const quarterId = (period: string): string => externalId("quarter", "cy", period);

// ---------------------------------------------------------------- inputs

/** Where a row came from: the Zetaris object, the statement hash, the source endpoint and the evidence id. */
export interface SourceMeta {
  object: string;
  sqlSha256: string;
  url?: string;
  evidenceId?: string;
}

export interface UtilityInput {
  cik: string;
  name: string;
  ticker: string | null;
  sic: string | null;
  sicDescription?: string | null;
  hqState: string | null;
  statesServed: string[];
  stations: { id: string; state: string; name: string | null }[];
  flags: string[];
  /** The seed file's generation time (the observation time of the curated facts). */
  curatedAt: string;
  /** Where the served states were read from (the 10-K description), and the fiscal year it covers. */
  statesBasis: string;
  servesFrom: string;
  /** The SEC submissions row read through Zetaris, when it was read. */
  profile?: { name: string; sic: string | null; sicDescription: string | null; state: string | null; meta: SourceMeta; at: string } | null;
}

export interface FilingFact {
  accn: string;
  filed: string | null;
  fy: number | null;
  fp: string | null;
  form: string | null;
  start: string | null;
  end: string;
  val: number;
}

export interface FilingFactsInput {
  cik: string;
  tag: string;
  period: string;
  facts: FilingFact[];
  meta: SourceMeta;
}

export interface RecastInput {
  cik: string;
  tag: string;
  period: string;
  from: { accn: string; val: number; filed: string | null };
  to: { accn: string; val: number; filed: string | null };
  rule: string;
  chosen: string;
  meta: SourceMeta;
}

export interface PeersInput {
  targetCik: string;
  period: string;
  /** The period's end date: the observation time of the comparison. */
  at: string;
  peers: { cik: string; g: number; dw: number | null; tag: string }[];
  meta: SourceMeta;
}

export interface WeatherInput {
  period: string;
  year: number;
  quarter: number;
  /** The quarter's end date. */
  at: string;
  rows: StationQuarter[];
  meta: SourceMeta;
}

export interface WorldBatch {
  utilities?: UtilityInput[];
  filings?: FilingFactsInput[];
  recasts?: RecastInput[];
  peers?: PeersInput[];
  weather?: WeatherInput[];
}

export interface IngestDelta {
  eventsBefore: number;
  eventsAfter: number;
  appended: number;
  stateBefore: string;
  stateAfter: string;
  changed: boolean;
  writes: { entities: number; edges: number; retractions: number; kept: number };
}

// ---------------------------------------------------------------- helpers

/** Any source date as a full UTC ISO string: YYYY-MM-DD, YYYYMMDD or ISO. */
export function toIsoUtc(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === "") return null;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(s)) return `${s}T00:00:00.000Z`;
  if (/^\d{8}$/u.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00.000Z`;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

const UNKNOWN_AT = "1970-01-01T00:00:00.000Z";

function cleanAttrs(a: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined));
}

function attrsSubset(want: Record<string, unknown>, have: Record<string, unknown>): boolean {
  return Object.entries(want).every(([k, v]) => canonicalJson(have[k] ?? null) === canonicalJson(v ?? null));
}

function ctxOf(scope: string, key: string): string {
  return `${scope}#${key}`;
}

function provenance(meta: SourceMeta, at: string, by?: string): Provenance {
  return { kind: "api", by: by ?? `zetaris:${meta.object}`, at, url: meta.url, checksum: meta.sqlSha256 };
}

/** The last day of a CY period (CY2025Q1 -> 2025-03-31). */
export function periodEnd(period: string): string {
  const m = /^CY(\d{4})Q([1-3])$/u.exec(period);
  if (!m) throw new Error(`invalid period ${period}`);
  const year = Number(m[1]);
  const q = Number(m[2]);
  const last = new Date(Date.UTC(year, 3 * q, 0));
  return last.toISOString().slice(0, 10);
}

interface StateShape {
  entities: Entity[];
  relationships: Relationship[];
  facts: Fact[];
}

export interface TimelineLine {
  seq: number;
  at: string;
  kind: string;
  summary: string;
}

// ---------------------------------------------------------------- the graph

export interface WeatherWorldOptions {
  /** Directory for `.world/weatherornot.json`; null keeps everything in memory. */
  directory?: string | null;
  clock?: () => Date;
}

export class WeatherWorld {
  readonly wm: WorldModel;
  readonly directory: string | null;
  private counts = { entities: 0, edges: 0, retractions: 0, kept: 0 };

  constructor(opts: WeatherWorldOptions = {}) {
    this.directory = opts.directory === undefined ? WORLD_DIR : opts.directory;
    this.wm = new WorldModel({
      storage: this.directory ? "local" : "memory",
      namespace: WORLD_NAMESPACE,
      directory: this.directory ?? undefined,
      conflictPolicy: "most-recent-wins",
      clock: opts.clock,
    });
  }

  // ------------------------------------------------------------ reads

  shape(): StateShape {
    return this.wm.stateShape() as StateShape;
  }

  /** sha256 of the canonical state shape (the idempotency diff surface). */
  stateHash(): string {
    return sha256Hex(this.wm.stateShapeCanonical());
  }

  eventCount(): number {
    return this.wm.events().length;
  }

  entity(id: string): Entity | undefined {
    return this.wm.view("graph").entity(id);
  }

  private resolve(id: string): string {
    return this.entity(id)?.id ?? id;
  }

  /** Open (current) edges, optionally filtered; retraction sentinels excluded. */
  edges(filter: { from?: string; to?: string; type?: string; contextPrefix?: string; includeClosed?: boolean } = {}): Relationship[] {
    const from = filter.from ? this.resolve(filter.from) : undefined;
    const to = filter.to ? this.resolve(filter.to) : undefined;
    return this.shape().relationships.filter(
      (r) =>
        r.to !== RETRACTED &&
        (filter.includeClosed || !r.validTo) &&
        (!from || r.from === from) &&
        (!to || r.to === to) &&
        (!filter.type || r.type === filter.type) &&
        (!filter.contextPrefix || (r.context ?? "").startsWith(filter.contextPrefix)),
    );
  }

  private openEdgeAt(from: string, type: string, context: string): Relationship | undefined {
    const f = this.resolve(from);
    return this.shape().relationships.find((r) => r.from === f && r.type === type && (r.context ?? "") === context && !r.validTo);
  }

  // ------------------------------------------------------------ idempotent writes

  private async upsert(input: { type: string; externalKey: { system: string; id: string }; name?: string | null; attrs: Record<string, unknown>; source: Provenance }): Promise<string> {
    const attrs = cleanAttrs(input.attrs);
    const name = input.name?.trim() || undefined;
    const id = externalId(input.type, input.externalKey.system, input.externalKey.id);
    const cur = this.entity(id);
    if (cur && (!name || cur.name === name || cur.aliases.includes(name)) && attrsSubset(attrs, cur.attrs)) {
      this.counts.kept++;
      return cur.id;
    }
    const e = await this.wm.upsertEntity({ type: input.type, externalKey: input.externalKey, name, attrs, source: input.source });
    this.counts.entities++;
    return e.id;
  }

  private async retract(from: string, type: string, context: string, source: Provenance): Promise<void> {
    await this.wm.relate({ from, type, to: RETRACTED, context, validFrom: source.at as string, source });
    this.counts.retractions++;
  }

  /**
   * One edge in a per-target context. "add" keeps any open edge already there; "sync"
   * replaces it when its target or attributes differ (retraction, then the new edge).
   */
  private async setEdge(from: string, type: string, to: string, scope: string, key: string, attrs: Record<string, unknown>, source: Provenance, mode: "add" | "sync", validFrom?: string): Promise<"kept" | "written" | "same_time"> {
    const context = ctxOf(scope, key);
    const target = this.resolve(to);
    const cur = this.openEdgeAt(from, type, context);
    const clean = cleanAttrs(attrs);
    const from_ = validFrom ?? (source.at as string);
    if (cur && cur.to !== RETRACTED) {
      const same = cur.to === target && canonicalJson(cur.attrs ?? {}) === canonicalJson(clean);
      if (same || mode === "add") {
        this.counts.kept++;
        return "kept";
      }
      if (cur.to === target) {
        if ((source.at as string) <= (cur.validFrom ?? "")) {
          this.counts.kept++;
          return "same_time";
        }
        await this.retract(from, type, context, source);
      }
    }
    await this.wm.relate({ from, type, to: target, context, attrs: clean, validFrom: from_, source });
    this.counts.edges++;
    return "written";
  }

  // ------------------------------------------------------------ ingest

  async ingestUtility(u: UtilityInput): Promise<string> {
    const at = toIsoUtc(u.curatedAt) ?? UNKNOWN_AT;
    const seedSrc: Provenance = { kind: "file", by: "seeds/utilities.json (curated from public 10-K service-territory descriptions)", at };
    const uid = await this.upsert({
      type: "utility",
      externalKey: { system: "sec", id: u.cik },
      name: u.name,
      attrs: { cik: u.cik, ticker: u.ticker, sic: u.sic, hq_state: u.hqState, flags: u.flags, states_served: [...u.statesServed].sort(), states_basis: u.statesBasis },
      source: seedSrc,
    });
    if (u.profile) {
      const p = u.profile;
      const src = provenance(p.meta, toIsoUtc(p.at) ?? at);
      await this.upsert({
        type: "utility",
        externalKey: { system: "sec", id: u.cik },
        name: p.name,
        attrs: { sec_name: p.name, sec_sic: p.sic, sec_sic_description: p.sicDescription, sec_business_state: p.state },
        source: src,
      });
      if (p.sic) {
        const sid = await this.upsert({ type: "sic", externalKey: { system: "code", id: p.sic }, name: p.sicDescription ?? null, attrs: { code: p.sic, description: p.sicDescription ?? undefined }, source: src });
        await this.setEdge(uid, "classified_as", sid, "sic", "sec", { basis: "SEC submissions profile" }, src, "sync");
      }
    } else if (u.sic) {
      const sid = await this.upsert({ type: "sic", externalKey: { system: "code", id: u.sic }, name: u.sicDescription ?? null, attrs: { code: u.sic, description: u.sicDescription ?? undefined }, source: seedSrc });
      await this.setEdge(uid, "classified_as", sid, "sic", "seed", { basis: "seed list" }, seedSrc, "add");
    }
    const servesFrom = toIsoUtc(u.servesFrom) ?? at;
    for (const st of u.statesServed) {
      const sid = await this.upsert({ type: "state", externalKey: { system: "us", id: st }, name: st, attrs: { code: st }, source: seedSrc });
      await this.setEdge(uid, "serves", sid, "serves", st, { basis: u.statesBasis }, seedSrc, "add", servesFrom);
    }
    for (const s of u.stations) {
      const sid = await this.upsert({ type: "station", externalKey: { system: "ghcn", id: s.id }, name: s.name ?? s.id, attrs: { ghcn_id: s.id, state: s.state }, source: seedSrc });
      await this.setEdge(stateId(s.state), "represented_by", sid, "station", s.id, { basis: "seeds/stations.json (first-order airport stations verified in the 2024 and 2025 parquet)" }, seedSrc, "add");
    }
    return uid;
  }

  async ingestFilingFacts(f: FilingFactsInput): Promise<void> {
    const uid = utilityId(f.cik);
    for (const fact of f.facts) {
      const at = toIsoUtc(fact.filed) ?? toIsoUtc(fact.end) ?? UNKNOWN_AT;
      const src = provenance(f.meta, at);
      // Unknown fields stay absent (never null), so a frames row that names only the accession number
      // does not overwrite what the companyconcept row already recorded about the filing.
      const fid = await this.upsert({
        type: "filing",
        externalKey: { system: "sec", id: fact.accn },
        name: fact.form ? `${fact.form} ${fact.accn}` : null,
        attrs: { accn: fact.accn, cik: f.cik, filed: fact.filed ?? undefined, fy: fact.fy ?? undefined, fp: fact.fp ?? undefined, form: fact.form ?? undefined },
        source: src,
      });
      await this.setEdge(uid, "reported_in", fid, "reported", `${f.tag}|${f.period}|${fact.accn}`, { tag: f.tag, period: f.period, val: fact.val, start: fact.start, end: fact.end }, src, "sync");
    }
  }

  async ingestRecast(r: RecastInput): Promise<void> {
    const at = toIsoUtc(r.to.filed) ?? UNKNOWN_AT;
    const src = provenance(r.meta, at, "won-agent:recast-rule");
    for (const side of [r.from, r.to]) {
      await this.upsert({ type: "filing", externalKey: { system: "sec", id: side.accn }, name: null, attrs: { accn: side.accn, cik: r.cik }, source: provenance(r.meta, toIsoUtc(side.filed) ?? at) });
    }
    await this.setEdge(filingId(r.to.accn), "recasts", filingId(r.from.accn), "recast", `${r.tag}|${r.period}`, { tag: r.tag, period: r.period, from_val: r.from.val, to_val: r.to.val, rule: r.rule, chosen: r.chosen }, src, "sync");
  }

  async ingestPeers(p: PeersInput): Promise<void> {
    const at = toIsoUtc(p.at) ?? UNKNOWN_AT;
    const src = provenance(p.meta, at, "won-agent:peer-set");
    const tid = utilityId(p.targetCik);
    for (const peer of p.peers) {
      await this.setEdge(tid, "peer_of", utilityId(peer.cik), "peer", `${p.period}|${peer.cik}`, { period: p.period, g: peer.g, dw: peer.dw, tag: peer.tag }, src, "sync");
    }
  }

  async ingestWeather(w: WeatherInput): Promise<void> {
    const at = toIsoUtc(w.at) ?? UNKNOWN_AT;
    const src = provenance(w.meta, at);
    const qid = await this.upsert({ type: "quarter", externalKey: { system: "cy", id: w.period }, name: w.period, attrs: { year: w.year, quarter: w.quarter, end: w.at }, source: src });
    for (const r of w.rows) {
      const sid = await this.upsert({ type: "station", externalKey: { system: "ghcn", id: r.station_id }, name: null, attrs: { ghcn_id: r.station_id }, source: src });
      await this.setEdge(sid, "observed_in", qid, "obs", w.period, { hdd: r.hdd, cdd: r.cdd, days_observed: r.days_observed, days_in_quarter: r.days_in_quarter, coverage: r.coverage }, src, "sync");
    }
  }

  /** Ingests one batch; the delta is empty when the same rows were ingested before. */
  async ingest(batch: WorldBatch): Promise<IngestDelta> {
    this.counts = { entities: 0, edges: 0, retractions: 0, kept: 0 };
    const eventsBefore = this.eventCount();
    const stateBefore = this.stateHash();
    for (const u of batch.utilities ?? []) await this.ingestUtility(u);
    for (const f of batch.filings ?? []) await this.ingestFilingFacts(f);
    for (const r of batch.recasts ?? []) await this.ingestRecast(r);
    for (const p of batch.peers ?? []) await this.ingestPeers(p);
    for (const w of batch.weather ?? []) await this.ingestWeather(w);
    const stateAfter = this.stateHash();
    return {
      eventsBefore,
      eventsAfter: this.eventCount(),
      appended: this.eventCount() - eventsBefore,
      stateBefore,
      stateAfter,
      changed: stateBefore !== stateAfter,
      writes: { ...this.counts },
    };
  }

  // ------------------------------------------------------------ views

  /** The utility, its open edges and the entities at their other end (the Graph tab's list). */
  neighbourhood(cik: string): { utility: Entity | null; edges: { type: string; dir: "out" | "in"; other: string; otherType: string | null; otherName: string | null; attrs: Record<string, unknown>; validFrom: string | null }[] } {
    const uid = utilityId(cik);
    const shape = this.shape();
    const byId = new Map(shape.entities.map((e) => [e.id, e]));
    const edges = shape.relationships
      .filter((r) => !r.validTo && r.to !== RETRACTED && (r.from === uid || r.to === uid))
      .map((r) => {
        const dir: "out" | "in" = r.from === uid ? "out" : "in";
        const other = dir === "out" ? r.to : r.from;
        const oe = byId.get(other);
        return { type: r.type, dir, other, otherType: oe?.type ?? null, otherName: oe?.name ?? null, attrs: r.attrs ?? {}, validFrom: r.validFrom ?? null };
      })
      .sort((a, b) => a.type.localeCompare(b.type) || a.other.localeCompare(b.other));
    return { utility: byId.get(uid) ?? null, edges };
  }

  /** Source-time ordered events about a utility and the filings, peers, states and stations around it. */
  timeline(cik: string): TimelineLine[] {
    const uid = utilityId(cik);
    const related = new Set<string>([uid]);
    for (const r of this.shape().relationships) {
      if (r.from === uid) related.add(r.to);
      if (r.to === uid) related.add(r.from);
    }
    const label = (id: string) => {
      const e = this.entity(id);
      return e?.name ? `${e.type} "${e.name}"` : id;
    };
    const out: TimelineLine[] = [];
    for (const e of this.wm.events() as readonly WorldEvent[]) {
      const p = e.payload as unknown as Record<string, unknown>;
      let summary: string | null = null;
      if (e.kind === "upsertEntity" && related.has(String(p.id))) summary = `${p.type} ${p.id}${p.name ? ` "${p.name}"` : ""}`;
      else if (e.kind === "relate" && (related.has(String(p.from)) || related.has(String(p.to)))) {
        summary =
          p.to === RETRACTED
            ? `${label(String(p.from))} -${p.type}-> (earlier edge closed)`
            : `${label(String(p.from))} -${p.type}-> ${label(String(p.to))}${p.attrs && Object.keys(p.attrs as object).length ? ` ${canonicalJson(p.attrs)}` : ""}`;
      }
      if (summary) out.push({ seq: e.seq, at: e.at, kind: e.kind, summary });
    }
    return out.sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq);
  }

  /** Nodes and edges for GET /api/world. */
  exportGraph(): { nodes: { id: string; type: string; name: string | null; attrs: Record<string, unknown> }[]; edges: Relationship[]; events: number; byType: Record<string, number>; edgeTypes: Record<string, number> } {
    const shape = this.shape();
    const byType: Record<string, number> = {};
    for (const e of shape.entities) byType[e.type] = (byType[e.type] ?? 0) + 1;
    const edgeTypes: Record<string, number> = {};
    for (const r of this.edges()) edgeTypes[r.type] = (edgeTypes[r.type] ?? 0) + 1;
    return {
      nodes: shape.entities.map((e) => ({ id: e.id, type: e.type, name: e.name ?? null, attrs: e.attrs })),
      edges: shape.relationships,
      events: this.eventCount(),
      byType,
      edgeTypes,
    };
  }
}
