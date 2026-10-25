// The discovery graph on the vendored World Model reference (event-sourced, bitemporal).
// Entities: dataset (a cached Zetaris view, zetaris:<object>), column (zetaris:<object>.<column>),
// utility (sec:cik), state (us:XX), declaration (fema:<disaster_number>). Relationships:
// has_column (dataset -> column), crosswalks_to (column -> column: one measured join key, with
// transform, rate, verdict and validFrom = when Lightning measured it), serves (utility -> state,
// from the curated 10-K service-territory seeds), declared_in (declaration -> state, validFrom =
// the declaration date). Every write carries provenance whose `at` is the source record's own time
// (the measurement time, the declaration date, the seed file's generation time), never the
// retrieval time, so re-ingesting the same rows writes nothing (the reference idempotency check).
//
// "What did we know, and since when": keyHistory() and utilityHistory() list every edge about a key
// or a utility, open and closed, with its validFrom/validTo and the run that wrote it.
//
// Two rulings on top of the reference, kept from ClearShelf: multi-valued relations carry a
// per-target context "<scope>#<key>", and an edge whose attributes change is closed by relating
// the same context to the target "retracted" at the new source time.
// Adapted from Weather-or-Not and ClearShelf (same author, Apache-2.0).

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
} from "../../../engines/world-model/reference/src/index.ts";
import { DATA_DIR_URL } from "../config.ts";

export const WORLD_NAMESPACE = "crosswalk";
export const WORLD_DIR = fileURLToPath(new URL("world/", DATA_DIR_URL));
export const RETRACTED = "retracted";

// ---------------------------------------------------------------- ids

export const datasetId = (object: string): string => externalId("dataset", "zetaris", object.toLowerCase());
export const columnId = (object: string, column: string): string => externalId("column", "zetaris", `${object.toLowerCase()}.${column.toLowerCase()}`);
export const utilityId = (cik: string): string => externalId("utility", "sec", cik);
export const stateId = (st: string): string => externalId("state", "us", st);
export const declarationId = (n: string | number): string => externalId("declaration", "fema", String(n));

// ---------------------------------------------------------------- inputs

export interface DatasetInput {
  object: string;
  columns: { name: string; type: string }[];
  licence?: string | null;
  url?: string | null;
}

export interface KeyInput {
  left: { object: string; column: string };
  right: { object: string; column: string };
  transform: string;
  memoryKey: string;
  rate: number | null;
  rate_distinct: number | null;
  verdict: string | null;
  matched_rows: number | null;
  left_rows: number | null;
  measured_as: string | null;
  orphans: string[];
  run_id: string;
  /** When Lightning measured it. */
  at: string;
  sqlSha256: string | null;
}

export interface UtilityInput {
  cik: string;
  name: string;
  ticker: string | null;
  statesServed: string[];
  curatedAt: string;
}

export interface DeclarationInput {
  disaster_number: string;
  state: string;
  declaration_date: string;
  incident_type: string | null;
  title: string | null;
  designated_areas: number;
  quarter: string;
  sqlSha256: string | null;
}

export interface WorldBatch {
  datasets?: DatasetInput[];
  keys?: KeyInput[];
  utilities?: UtilityInput[];
  declarations?: DeclarationInput[];
  /** Where the batch came from (the run id), recorded on every edge's provenance. */
  runId?: string;
}

export interface IngestDelta {
  eventsBefore: number;
  eventsAfter: number;
  appended: number;
  changed: boolean;
  writes: { entities: number; edges: number; retractions: number; kept: number };
}

export interface KnowledgeLine {
  type: string;
  from: string;
  to: string;
  attrs: Record<string, unknown>;
  validFrom: string | null;
  validTo: string | null;
  by: string | null;
  open: boolean;
}

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
const cleanAttrs = (a: Record<string, unknown>) => Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined));
const attrsSubset = (want: Record<string, unknown>, have: Record<string, unknown>) => Object.entries(want).every(([k, v]) => canonicalJson(have[k] ?? null) === canonicalJson(v ?? null));

interface StateShape {
  entities: Entity[];
  relationships: Relationship[];
  facts: Fact[];
}

export interface CrosswalkWorldOptions {
  /** Directory for `.world/crosswalk.json`; null keeps everything in memory. */
  directory?: string | null;
  clock?: () => Date;
}

export class CrosswalkWorld {
  readonly wm: WorldModel;
  readonly directory: string | null;
  private counts = { entities: 0, edges: 0, retractions: 0, kept: 0 };

  constructor(opts: CrosswalkWorldOptions = {}) {
    this.directory = opts.directory === undefined ? WORLD_DIR : opts.directory;
    this.wm = new WorldModel({ storage: this.directory ? "local" : "memory", namespace: WORLD_NAMESPACE, directory: this.directory ?? undefined, conflictPolicy: "most-recent-wins", clock: opts.clock });
  }

  shape(): StateShape {
    return this.wm.stateShape() as StateShape;
  }

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

  private openEdgeAt(from: string, type: string, context: string): Relationship | undefined {
    const f = this.resolve(from);
    return this.shape().relationships.find((r) => r.from === f && r.type === type && (r.context ?? "") === context && !r.validTo);
  }

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

  /** One edge in a per-target context; "sync" closes and replaces it when its target or attributes differ. */
  private async setEdge(from: string, type: string, to: string, context: string, attrs: Record<string, unknown>, source: Provenance, mode: "add" | "sync", validFrom?: string): Promise<"kept" | "written"> {
    const target = this.resolve(to);
    const cur = this.openEdgeAt(from, type, context);
    const clean = cleanAttrs(attrs);
    if (cur && cur.to !== RETRACTED) {
      const same = cur.to === target && canonicalJson(cur.attrs ?? {}) === canonicalJson(clean);
      if (same || mode === "add" || (source.at as string) <= (cur.validFrom ?? "")) {
        this.counts.kept++;
        return "kept";
      }
      if (cur.to === target) {
        await this.wm.relate({ from, type, to: RETRACTED, context, validFrom: source.at as string, source });
        this.counts.retractions++;
      }
    }
    await this.wm.relate({ from, type, to: target, context, attrs: clean, validFrom: validFrom ?? (source.at as string), source });
    this.counts.edges++;
    return "written";
  }

  async ingest(batch: WorldBatch): Promise<IngestDelta> {
    this.counts = { entities: 0, edges: 0, retractions: 0, kept: 0 };
    const eventsBefore = this.eventCount();
    const stateBefore = this.stateHash();
    const by = batch.runId ? `cw-agent:${batch.runId}` : "cw-agent";
    for (const d of batch.datasets ?? []) {
      const src: Provenance = { kind: "api", by: `zetaris:${d.object.toLowerCase()}`, at: UNKNOWN_AT, url: d.url ?? undefined };
      const did = await this.upsert({ type: "dataset", externalKey: { system: "zetaris", id: d.object.toLowerCase() }, name: d.object, attrs: { object: d.object.toLowerCase(), licence: d.licence ?? undefined }, source: src });
      for (const c of d.columns) {
        const cid = await this.upsert({ type: "column", externalKey: { system: "zetaris", id: `${d.object.toLowerCase()}.${c.name.toLowerCase()}` }, name: `${d.object}.${c.name}`, attrs: { column: c.name, type: c.type }, source: src });
        await this.setEdge(did, "has_column", cid, `col#${c.name.toLowerCase()}`, {}, src, "add");
      }
    }
    for (const k of batch.keys ?? []) {
      const at = toIsoUtc(k.at) ?? UNKNOWN_AT;
      const src: Provenance = { kind: "api", by, at, checksum: k.sqlSha256 ?? undefined };
      const l = await this.upsert({ type: "column", externalKey: { system: "zetaris", id: `${k.left.object.toLowerCase()}.${k.left.column.toLowerCase()}` }, name: `${k.left.object}.${k.left.column}`, attrs: { column: k.left.column }, source: src });
      const r = await this.upsert({ type: "column", externalKey: { system: "zetaris", id: `${k.right.object.toLowerCase()}.${k.right.column.toLowerCase()}` }, name: `${k.right.object}.${k.right.column}`, attrs: { column: k.right.column }, source: src });
      await this.setEdge(l, "crosswalks_to", r, `key#${k.memoryKey}`, { transform: k.transform, rate: k.rate, rate_distinct: k.rate_distinct, verdict: k.verdict, matched_rows: k.matched_rows, left_rows: k.left_rows, measured_as: k.measured_as, orphans: k.orphans.slice(0, 5), run_id: k.run_id }, src, "sync");
    }
    for (const u of batch.utilities ?? []) {
      const at = toIsoUtc(u.curatedAt) ?? UNKNOWN_AT;
      const src: Provenance = { kind: "file", by: "seeds/utilities.json (curated from public 10-K service-territory descriptions)", at };
      const uid = await this.upsert({ type: "utility", externalKey: { system: "sec", id: u.cik }, name: u.name, attrs: { cik: u.cik, ticker: u.ticker, states_served: [...u.statesServed].sort() }, source: src });
      for (const st of u.statesServed) {
        const sid = await this.upsert({ type: "state", externalKey: { system: "us", id: st }, name: st, attrs: { code: st }, source: src });
        await this.setEdge(uid, "serves", sid, `serves#${st}`, { basis: "10-K service territory (curated seed)" }, src, "add");
      }
    }
    for (const d of batch.declarations ?? []) {
      const at = toIsoUtc(d.declaration_date) ?? UNKNOWN_AT;
      const src: Provenance = { kind: "api", by: `zetaris:cw.fema_declarations_dr (${d.quarter})`, at, checksum: d.sqlSha256 ?? undefined };
      const did = await this.upsert({ type: "declaration", externalKey: { system: "fema", id: d.disaster_number }, name: d.title ? `DR-${d.disaster_number} ${d.title}` : `DR-${d.disaster_number}`, attrs: { disaster_number: d.disaster_number, incident_type: d.incident_type ?? undefined, declaration_date: d.declaration_date, quarter: d.quarter }, source: src });
      const sid = await this.upsert({ type: "state", externalKey: { system: "us", id: d.state }, name: d.state, attrs: { code: d.state }, source: src });
      await this.setEdge(did, "declared_in", sid, `declared#${d.state}`, { designated_areas: d.designated_areas }, src, "sync", at);
    }
    return { eventsBefore, eventsAfter: this.eventCount(), appended: this.eventCount() - eventsBefore, changed: stateBefore !== this.stateHash(), writes: { ...this.counts } };
  }

  // ------------------------------------------------------------ "what did we know, and since when"

  private lines(filter: (r: Relationship) => boolean): KnowledgeLine[] {
    const shape = this.shape();
    const name = (id: string) => shape.entities.find((e) => e.id === id)?.name ?? id;
    return shape.relationships
      .filter((r) => r.to !== RETRACTED && filter(r))
      .map((r) => ({ type: r.type, from: name(r.from), to: name(r.to), attrs: r.attrs ?? {}, validFrom: r.validFrom ?? null, validTo: r.validTo ?? null, by: (r as { source?: Provenance }).source?.by ?? null, open: !r.validTo }))
      .sort((a, b) => (a.validFrom ?? "").localeCompare(b.validFrom ?? ""));
  }

  /** Every crosswalks_to edge between the two columns (either direction), open and closed, oldest first. */
  keyHistory(left: { object: string; column: string }, right: { object: string; column: string }): KnowledgeLine[] {
    const a = this.resolve(columnId(left.object, left.column));
    const b = this.resolve(columnId(right.object, right.column));
    return this.lines((r) => r.type === "crosswalks_to" && ((r.from === a && r.to === b) || (r.from === b && r.to === a)));
  }

  /** Every edge about a utility and the declarations in the states it serves, open and closed, oldest first. */
  utilityHistory(cik: string): KnowledgeLine[] {
    const uid = this.resolve(utilityId(cik));
    const states = new Set(this.shape().relationships.filter((r) => r.from === uid && r.type === "serves" && r.to !== RETRACTED).map((r) => r.to));
    return this.lines((r) => r.from === uid || r.to === uid || (r.type === "declared_in" && states.has(r.to)));
  }

  /** Nodes and edges for GET /api/world. */
  exportGraph(): { nodes: { id: string; type: string; name: string | null; attrs: Record<string, unknown> }[]; edges: Relationship[]; events: number; byType: Record<string, number>; edgeTypes: Record<string, number> } {
    const shape = this.shape();
    const byType: Record<string, number> = {};
    for (const e of shape.entities) byType[e.type] = (byType[e.type] ?? 0) + 1;
    const edgeTypes: Record<string, number> = {};
    for (const r of shape.relationships.filter((x) => x.to !== RETRACTED && !x.validTo)) edgeTypes[r.type] = (edgeTypes[r.type] ?? 0) + 1;
    return { nodes: shape.entities.map((e) => ({ id: e.id, type: e.type, name: e.name ?? null, attrs: e.attrs })), edges: shape.relationships, events: this.eventCount(), byType, edgeTypes };
  }
}
