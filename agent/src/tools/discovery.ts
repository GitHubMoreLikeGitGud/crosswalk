/**
 * The discovery tools of the Crosswalk loop (SPEC section 3 and decision D8), host-run and
 * deterministic: search_catalogue, probe_source, propose_keys, measure_key, register_source,
 * compile_usl, answer, not_tested. The model never writes SQL and never produces a number here:
 * every statement is a named gateway template with validated parameters, every number comes back
 * from Lightning SQL or from the C1-C5 functions, and every result carries the provenance of the
 * statements behind it ({template, params, sql, elapsed_ms, run_id}).
 *
 * The gateway and the registrar are ports (structural types the GatewayClient and the runtime's
 * contract-signing registrar satisfy), so the tools are unit-tested on fixtures without Zetaris.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KeyChoice, ProbeSummary } from "./baselineKeys.ts";
import {
  entriesFromCatalogue,
  entriesFromFemaCatalogue,
  entriesFromGettingStarted,
  entriesFromManifest,
  searchCatalogue,
  type CatalogueEntry,
  type CatalogueHit,
} from "./catalogueSearch.ts";
import { matchRateSql, validateProposal, verdictFor, ORPHAN_SAMPLE, type KeyProposal, type Verdict } from "./matchRate.ts";
import { candidateKeyColumns, type DescribedColumn } from "./probeHeuristic.ts";
import { renderCompileUsl, validatePlan, type UslFk, type UslPlan } from "./uslPlan.ts";

// ---------- ports and provenance ----------

/** What a gateway template call returns (the GatewayClient's TemplateResult satisfies it). */
export interface TemplateReply {
  columns: string[];
  rows: unknown[][];
  row_count?: number;
  elapsed_ms: number;
  sql: string | null;
  executed_at?: string;
  cache_state?: string;
}

export interface TemplatePort {
  template(templateId: string, params?: Record<string, string>): Promise<TemplateReply>;
}

/** What the registrar returns (the GatewayClient's RegistrarResult satisfies it; the extra fields are optional). */
export interface RegistrarReply {
  action: string;
  params: Record<string, string>;
  contract_id: string;
  steps: { template_id: string; sql: string; elapsed_ms?: number; row_count?: number; skipped_exists?: boolean }[];
  wall_ms?: number;
  already_registered?: boolean;
  object?: string;
  rows?: number | null;
}

/** Signs a medium-risk contract for the action and posts it (agent/src/runtime.ts registrarPort). */
export interface RegistrarPortLike {
  register(action: string, params: Record<string, string>): Promise<RegistrarReply>;
}

export interface Provenance {
  template: string;
  params: Record<string, string>;
  sql: string;
  elapsed_ms: number;
  run_id: string;
  executed_at: string | null;
  cache_state: string | null;
  /** The rows the statement returned (count, and the first rows for the evidence record). */
  row_count?: number;
  columns?: string[];
  rows?: unknown[][];
}

export class DiscoveryRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DiscoveryRefusal";
  }
}

async function call(port: TemplatePort, runId: string, template: string, params: Record<string, string>): Promise<{ reply: TemplateReply; prov: Provenance; rows: Record<string, unknown>[] }> {
  const reply = await port.template(template, params);
  const prov: Provenance = {
    template,
    params: { ...params },
    sql: reply.sql ?? "",
    elapsed_ms: reply.elapsed_ms,
    run_id: runId,
    executed_at: reply.executed_at ?? null,
    cache_state: reply.cache_state ?? null,
    row_count: reply.rows.length,
    columns: [...reply.columns],
    rows: reply.rows.slice(0, 20),
  };
  const rows = reply.rows.map((r) => Object.fromEntries(reply.columns.map((c, i) => [c, r[i] ?? null])));
  return { reply, prov, rows };
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function lowerKeys(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]));
}

function pick(row: Record<string, unknown>, names: readonly string[]): unknown {
  const r = lowerKeys(row);
  for (const n of names) if (n in r) return r[n];
  return undefined;
}

// ---------- names the tools share ----------

export const REVENUE_TAGS = ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RegulatedAndUnregulatedOperatingRevenue"] as const;
/** The frames periods registered and cached on Day 0 (zetaris/manifest.json, source cw_sec). */
export const FRAMES_PERIODS_REGISTERED = ["CY2025Q1", "CY2024Q1"] as const;
const QUARTER_RE = /^CY(\d{4})Q([1-4])$/u;
const FRAMES_RE = /^cw\.frames_(Revenues|RevenueFromContractWithCustomerExcludingAssessedTax|RegulatedAndUnregulatedOperatingRevenue)_(CY\d{4}Q[1-3])$/iu;
const FEMA_RE = /^cw\.fema_declarations_dr_(\d{4})q([1-4])$/iu;
const REFUSED_OBJECT = /^(won[_.]|clearshelf)/iu;

export function quarterSlug(quarter: string): string {
  const m = QUARTER_RE.exec(quarter);
  if (!m) throw new DiscoveryRefusal("bad_params", `quarter must be CY<yyyy>Q<n>: ${quarter}`);
  return `${m[1]}q${m[2]}`;
}

export function previousYear(quarter: string): string {
  const m = QUARTER_RE.exec(quarter);
  if (!m) throw new DiscoveryRefusal("bad_params", `quarter must be CY<yyyy>Q<n>: ${quarter}`);
  return `CY${Number(m[1]) - 1}Q${m[2]}`;
}

/** The Zetaris objects the manifest says are registered and cached: concrete cw.* views, the frames pattern expanded over the registered periods. */
export function registeredObjects(manifest: unknown): string[] {
  const out: string[] = [];
  const sources = (manifest as { sources?: unknown })?.sources;
  if (!Array.isArray(sources)) throw new Error("manifest has no sources array");
  for (const s of sources as { objects?: Record<string, unknown> }[]) {
    const o = s.objects ?? {};
    const names: string[] = [];
    for (const key of ["views", "view", "frames"]) {
      const v = o[key];
      if (typeof v === "string") names.push(v);
      else if (Array.isArray(v)) names.push(...v.filter((x): x is string => typeof x === "string"));
    }
    for (const n of names) {
      if (n === "cw.frames_<tag>_<period>") {
        for (const p of FRAMES_PERIODS_REGISTERED) for (const t of REVENUE_TAGS) out.push(`cw.frames_${t}_${p}`);
      } else if (/^cw\.[A-Za-z0-9_]+$/u.test(n)) {
        out.push(n);
      }
    }
  }
  return [...new Set(out)];
}

// ---------- search_catalogue ----------

export interface CatalogueInputs {
  catalogue: unknown;
  manifest: unknown;
  gettingStarted: unknown | null;
}

/** seeds/catalogue.json, zetaris/manifest.json and, when the directory is given and present, the getting-started manifest. */
export function loadCatalogueInputs(repoRoot: string, gettingStartedDir: string | null = null): CatalogueInputs {
  const read = (p: string) => JSON.parse(readFileSync(p, "utf8")) as unknown;
  const gsPath = gettingStartedDir ? join(gettingStartedDir, "open_data", "manifest.json") : null;
  return {
    catalogue: read(join(repoRoot, "seeds", "catalogue.json")),
    manifest: read(join(repoRoot, "zetaris", "manifest.json")),
    gettingStarted: gsPath && existsSync(gsPath) ? read(gsPath) : null,
  };
}

export interface SearchResult {
  query: string;
  hits: CatalogueHit[];
  sources: { catalogue: number; registered: number; fema_catalogue: number | null; getting_started: number | null };
  fema_catalogue_error: string | null;
  provenance: Provenance[];
}

/** Fills the licence of registered views and OpenFEMA datasets from the catalogue entry that owns them. */
function withLicences(entries: CatalogueEntry[], catalogueEntries: CatalogueEntry[]): CatalogueEntry[] {
  const byObject = new Map(catalogueEntries.filter((e) => e.object).map((e) => [e.object!.toLowerCase(), e.licence]));
  const byId = new Map(catalogueEntries.map((e) => [e.id, e.licence]));
  return entries.map((e) => {
    if (e.licence) return e;
    if (e.kind === "openfema_dataset") return { ...e, licence: byId.get("openfema_catalogue") ?? "" };
    if (e.id.startsWith("gs:")) return { ...e, licence: byId.get("getting_started_manifest") ?? "" };
    return { ...e, licence: (e.object && byObject.get(e.object.toLowerCase())) || "" };
  });
}

export async function searchCatalogueTool(query: string, inputs: CatalogueInputs, opts: { gateway?: TemplatePort | null; runId: string; limit?: number }): Promise<SearchResult> {
  const cat = entriesFromCatalogue(inputs.catalogue);
  const reg = entriesFromManifest(inputs.manifest);
  const gs = inputs.gettingStarted ? entriesFromGettingStarted(inputs.gettingStarted) : [];
  let fema: CatalogueEntry[] = [];
  let femaError: string | null = null;
  const provenance: Provenance[] = [];
  if (opts.gateway) {
    try {
      const r = await call(opts.gateway, opts.runId, "catalogue_list", {});
      fema = entriesFromFemaCatalogue(r.rows);
      provenance.push(r.prov);
    } catch (e) {
      femaError = (e as Error).message.slice(0, 200);
    }
  } else {
    femaError = "no gateway";
  }
  const entries = withLicences([...cat, ...reg, ...fema, ...gs], cat);
  return {
    query,
    hits: searchCatalogue(query, entries, opts.limit ?? 8).hits,
    sources: { catalogue: cat.length, registered: reg.length, fema_catalogue: femaError ? null : fema.length, getting_started: inputs.gettingStarted ? gs.length : null },
    fema_catalogue_error: femaError,
    provenance,
  };
}

// ---------- probe_source ----------

export interface ProbeColumnStat {
  column: string;
  rows: number | null;
  distinct: number | null;
  non_null: number | null;
  samples: string[];
}

export interface ProbeResult {
  object: string;
  columns: DescribedColumn[];
  sample: { columns: string[]; rows: unknown[][] };
  candidates: ProbeColumnStat[];
  provenance: Provenance[];
  elapsed_ms: number;
}

/** DESCRIBE output: one row per column (name, type); Spark-style section rows (#, blank) are skipped. */
export function parseDescribe(reply: Pick<TemplateReply, "columns" | "rows">): DescribedColumn[] {
  const out: DescribedColumn[] = [];
  for (const r of reply.rows) {
    const name = r[0] === null || r[0] === undefined ? "" : String(r[0]).trim();
    if (!name || name.startsWith("#")) continue;
    out.push({ name, type: r[1] === null || r[1] === undefined ? "" : String(r[1]).trim() });
  }
  return out;
}

/** The distinct_counts reply: row count, distinct values and non-null values of one column (named columns, else positional). */
export function parseDistinct(reply: Pick<TemplateReply, "columns" | "rows">): { rows: number | null; distinct: number | null; non_null: number | null } {
  const row = reply.rows[0];
  if (!row) return { rows: null, distinct: null, non_null: null };
  const obj = Object.fromEntries(reply.columns.map((c, i) => [c, row[i] ?? null]));
  let rows = num(pick(obj, ["rows", "row_count", "n", "total", "count"]));
  let distinct = num(pick(obj, ["distinct", "distinct_count", "distinct_values", "distinct_keys", "n_distinct"]));
  let nonNull = num(pick(obj, ["non_null", "non_null_count", "not_null", "nonnull"]));
  const share = num(pick(obj, ["non_null_share", "not_null_share", "nonnull_share"]));
  if (nonNull === null && share !== null && rows !== null) nonNull = Math.round(share * rows);
  if (rows === null && distinct === null && row.length >= 2) {
    rows = num(row[0]);
    distinct = num(row[1]);
    nonNull = row.length >= 3 ? num(row[2]) : null;
    if (nonNull !== null && nonNull <= 1 && rows !== null && rows > 1) nonNull = Math.round(nonNull * rows);
  }
  return { rows, distinct, non_null: nonNull };
}

export function assertProbeable(object: string, allowed: ReadonlySet<string>): void {
  if (typeof object !== "string" || !/^cw\.[A-Za-z0-9_]+$/u.test(object)) {
    throw new DiscoveryRefusal("not_allowed", `object must be a cw.<view> name: ${String(object).slice(0, 80)}`);
  }
  if (REFUSED_OBJECT.test(object) || REFUSED_OBJECT.test(object.slice(3))) throw new DiscoveryRefusal("not_allowed", `refused object: ${object}`);
  const lower = new Set([...allowed].map((o) => o.toLowerCase()));
  if (!lower.has(object.toLowerCase())) throw new DiscoveryRefusal("not_in_manifest", `object is not a registered view in the manifest: ${object}`);
}

export async function probeSource(object: string, opts: { gateway: TemplatePort; allowed: ReadonlySet<string>; runId: string; maxColumns?: number }): Promise<ProbeResult> {
  assertProbeable(object, opts.allowed);
  const t0 = performance.now();
  const provenance: Provenance[] = [];
  // Lightning folds identifier case; the gateway's cw_object kind is lower case (cw.frames_revenues_cy2025q1).
  const name = object.toLowerCase();
  const d = await call(opts.gateway, opts.runId, "describe_object", { object: name });
  provenance.push(d.prov);
  const columns = parseDescribe(d.reply);
  const s = await call(opts.gateway, opts.runId, "sample_rows", { object: name });
  provenance.push(s.prov);
  const sampleRows = s.reply.rows.slice(0, 5);
  const candidates: ProbeColumnStat[] = [];
  for (const column of candidateKeyColumns(columns, opts.maxColumns ?? 3)) {
    const c = await call(opts.gateway, opts.runId, "distinct_counts", { object: name, column });
    provenance.push(c.prov);
    const idx = s.reply.columns.findIndex((x) => x.toLowerCase() === column.toLowerCase());
    const samples = idx < 0 ? [] : sampleRows.map((r) => r[idx]).filter((v) => v !== null && v !== undefined).map((v) => String(v));
    candidates.push({ column, ...parseDistinct(c.reply), samples });
  }
  return { object, columns, sample: { columns: s.reply.columns, rows: sampleRows }, candidates, provenance, elapsed_ms: Math.round(performance.now() - t0) };
}

/** The probe as the C5 baseline reads it. */
export function probeSummary(p: Pick<ProbeResult, "object" | "candidates">): ProbeSummary {
  return { object: p.object, candidates: p.candidates.map((c) => ({ column: c.column, distinct: c.distinct, rows: c.rows, samples: c.samples })) };
}

// ---------- propose_keys ----------

export const MAX_PROPOSALS = 6;

export interface AcceptedChoice extends KeyChoice {
  proposal: KeyProposal;
  route: string | null;
}

export interface ProposalCheck {
  accepted: AcceptedChoice[];
  rejected: { choice: unknown; error: string }[];
}

export function toProposal(choice: unknown): KeyProposal {
  const c = choice as { left?: { object?: unknown; column?: unknown }; right?: { object?: unknown; column?: unknown }; transform?: unknown };
  if (!c || typeof c !== "object" || !c.left || !c.right) throw new Error("a choice is {left: {object, column}, right: {object, column}, transform}");
  return validateProposal({ leftObject: c.left.object, leftColumn: c.left.column, rightObject: c.right.object, rightColumn: c.right.column, transform: c.transform });
}

/** Validates the planner's (or the baseline's) choices: at most six, closed transform set, probed objects only, no duplicates. */
export function proposeKeys(choices: unknown, opts: { probed: ReadonlySet<string>; knownTemplates?: ReadonlySet<string> }): ProposalCheck {
  const out: ProposalCheck = { accepted: [], rejected: [] };
  if (!Array.isArray(choices)) {
    out.rejected.push({ choice: choices, error: "choices must be an array" });
    return out;
  }
  const probed = new Set([...opts.probed].map((o) => o.toLowerCase()));
  const seen = new Set<string>();
  choices.forEach((choice, i) => {
    if (i >= MAX_PROPOSALS) {
      out.rejected.push({ choice, error: `more than ${MAX_PROPOSALS} choices` });
      return;
    }
    let p: KeyProposal;
    try {
      p = toProposal(choice);
    } catch (e) {
      out.rejected.push({ choice, error: (e as Error).message.slice(0, 160) });
      return;
    }
    if (p.leftObject.toLowerCase() === p.rightObject.toLowerCase()) {
      out.rejected.push({ choice, error: "left and right name the same object" });
      return;
    }
    for (const o of [p.leftObject, p.rightObject]) {
      if (!probed.has(o.toLowerCase())) {
        out.rejected.push({ choice, error: `object not probed in this run: ${o}` });
        return;
      }
    }
    const sig = signature(p);
    if (seen.has(sig)) {
      out.rejected.push({ choice, error: "duplicate of an earlier choice" });
      return;
    }
    seen.add(sig);
    out.accepted.push({ left: { object: p.leftObject, column: p.leftColumn }, right: { object: p.rightObject, column: p.rightColumn }, transform: p.transform, proposal: p, route: routeKeyOf(p, opts.knownTemplates) });
  });
  return out;
}

/** The unordered pair plus the transform: two choices that differ only in orientation are one key. */
export function signature(p: KeyProposal): string {
  const a = `${p.leftObject.toLowerCase()}.${p.leftColumn.toLowerCase()}`;
  const b = `${p.rightObject.toLowerCase()}.${p.rightColumn.toLowerCase()}`;
  return `${a < b ? `${a}|${b}` : `${b}|${a}`}|${p.transform}`;
}

// ---------- measure_key: proposals routed to the join-map statements ----------

interface Side {
  object: RegExp;
  column: string;
}

export interface KeyRoute {
  id: string;
  label: string;
  a: Side;
  b: Side;
  transforms: readonly string[];
  template: string;
  orphanTemplate: string | null;
  /** How the gateway statement measures the key (its left side is the side whose rows must find a partner). */
  measuredAs: string;
  params(p: KeyProposal): Record<string, string>;
  /** The scope a verified key holds for (the frames period or the FEMA quarter), part of the memory key. */
  scope(p: KeyProposal): string;
  /** D18: the canonical orientation of the measured statement (left = the side whose rows are counted), whoever proposed the pair. */
  orient(p: KeyProposal): Orientation;
}

/** How a join-map row reads: the counted side on the left, and the side the transform is applied to. */
export interface Orientation {
  left: string;
  right: string;
  transform_on: "left" | "right";
}

/** D15: the onboarding snapshot of cw.seed_utilities that the question path reads. */
export const SNAPSHOT = "cw.seed_submissions_snapshot";
/** Views the question path never reads (cw.seed_utilities resolves 43 submission views per read; D15). */
export const QUESTION_PATH_REFUSED: ReadonlySet<string> = new Set(["cw.seed_utilities"]);
/** The gateway template that measures any proposal outside the named join-map statements (D16). */
export const GENERIC_TEMPLATE = "match_rate";
export const GENERIC_ORPHANS_TEMPLATE = "match_rate_orphans";

function framesAll(p: KeyProposal): string {
  return `cw.frames_*_${framesPeriod(p)}`;
}

function framesPeriod(p: KeyProposal): string {
  for (const o of [p.leftObject, p.rightObject]) {
    const m = FRAMES_RE.exec(o);
    if (m) return m[2]!.toUpperCase();
  }
  throw new DiscoveryRefusal("bad_params", "no frames object in the proposal");
}

function femaQuarter(p: KeyProposal): string {
  for (const o of [p.leftObject, p.rightObject]) {
    const m = FEMA_RE.exec(o);
    if (m) return `CY${m[1]}Q${m[2]}`;
  }
  throw new DiscoveryRefusal("bad_params", "no FEMA declarations object in the proposal");
}

const exact = (name: string) => new RegExp(`^${name.replace(/\./gu, "\\.")}$`, "iu");

/** The join-map statements of zetaris/sql/06_cw_joinmap_select.sql as gateway templates (SPEC section 2 keys a-e). */
export const KEY_ROUTES: readonly KeyRoute[] = [
  {
    id: "cik",
    label: "(a) cik: submissions cik vs frames cik under lpad10",
    a: { object: exact(SNAPSHOT), column: "cik10" },
    b: { object: FRAMES_RE, column: "cik" },
    transforms: ["lpad10"],
    template: "joinmap_cik",
    orphanTemplate: "joinmap_cik_orphans",
    measuredAs: "left cw.seed_submissions_snapshot.cik10 (43 seed filers, SEC submissions snapshot taken at onboarding); right LPAD(frames cik) over the three frames views of the period",
    orient: (p) => ({ left: `${SNAPSHOT}.cik10`, right: `${framesAll(p)}.cik`, transform_on: "right" }),
    params: (p) => ({ period: framesPeriod(p) }),
    scope: (p) => framesPeriod(p),
  },
  {
    id: "cik_control",
    label: "(a, control) cik without lpad10",
    a: { object: exact(SNAPSHOT), column: "cik10" },
    b: { object: FRAMES_RE, column: "cik" },
    transforms: ["identity"],
    template: "joinmap_cik_control",
    orphanTemplate: null,
    measuredAs: "left cw.seed_submissions_snapshot.cik10; right CAST(frames cik AS STRING) over the three frames views of the period",
    orient: (p) => ({ left: `${SNAPSHOT}.cik10`, right: `${framesAll(p)}.cik`, transform_on: "right" }),
    params: (p) => ({ period: framesPeriod(p) }),
    scope: (p) => framesPeriod(p),
  },
  {
    id: "loc",
    label: "(b) frames loc under substr(4,2) vs submissions business state",
    a: { object: FRAMES_RE, column: "loc" },
    b: { object: exact(SNAPSHOT), column: "hq_state" },
    transforms: ["substr(4,2)"],
    template: "joinmap_loc",
    orphanTemplate: null,
    measuredAs: "left the seed filers present in the period's frames with SUBSTR(loc, 4, 2); right cw.seed_submissions_snapshot.hq_state",
    orient: (p) => ({ left: `${framesAll(p)}.loc`, right: `${SNAPSHOT}.hq_state`, transform_on: "left" }),
    params: (p) => ({ period: framesPeriod(p) }),
    scope: (p) => framesPeriod(p),
  },
  {
    id: "fema_state",
    label: "(c) FEMA state vs the states the seed utilities serve",
    a: { object: FEMA_RE, column: "state" },
    b: { object: exact("cw.utility_states"), column: "state" },
    transforms: ["identity"],
    template: "joinmap_fema_state",
    orphanTemplate: "joinmap_fema_state_orphans",
    measuredAs: "left the distinct FEMA declaration states of the quarter; right cw.utility_states.state",
    orient: (p) => ({ left: `cw.fema_declarations_dr_${quarterSlug(femaQuarter(p))}.state`, right: "cw.utility_states.state", transform_on: "left" }),
    params: (p) => ({ quarter: femaQuarter(p) }),
    scope: (p) => femaQuarter(p),
  },
  {
    id: "fema_fips",
    label: "(c, FIPS) FEMA fipsStateCode vs the state reference",
    a: { object: FEMA_RE, column: "fips_state_code" },
    b: { object: exact("cw.states"), column: "fips" },
    transforms: ["identity"],
    template: "joinmap_fema_fips",
    orphanTemplate: null,
    measuredAs: "left the distinct FEMA fipsStateCode values of the quarter; right cw.states.fips",
    orient: (p) => ({ left: `cw.fema_declarations_dr_${quarterSlug(femaQuarter(p))}.fips_state_code`, right: "cw.states.fips", transform_on: "left" }),
    params: (p) => ({ quarter: femaQuarter(p) }),
    scope: (p) => femaQuarter(p),
  },
  {
    id: "station",
    label: "(d) seed station id vs the GHCN station inventory",
    a: { object: exact("cw.seed_stations"), column: "id" },
    b: { object: exact("cw.stations"), column: "id" },
    transforms: ["identity"],
    template: "joinmap_station",
    orphanTemplate: null,
    measuredAs: "left cw.seed_stations.id (56); right cw.stations.id (ghcnd-stations.txt), with the count whose state agrees",
    orient: () => ({ left: "cw.seed_stations.id", right: "cw.stations.id", transform_on: "left" }),
    params: () => ({}),
    scope: () => "all",
  },
  {
    id: "sic",
    label: "(e) submissions SIC vs the SIC reference",
    a: { object: exact(SNAPSHOT), column: "sic" },
    b: { object: exact("cw.sic_codes"), column: "code" },
    transforms: ["identity"],
    template: "joinmap_sic",
    orphanTemplate: "joinmap_sic_orphans",
    measuredAs: "left the 43 seed utilities' sic (rows; SEC submissions snapshot taken at onboarding) and its distinct codes; right cw.sic_codes.code",
    orient: () => ({ left: `${SNAPSHOT}.sic`, right: "cw.sic_codes.code", transform_on: "left" }),
    params: () => ({}),
    scope: () => "all",
  },
];

const sideMatches = (s: Side, object: string, column: string) => s.object.test(object) && s.column === column.toLowerCase();

/** The route that measures a proposal (unordered pair, same transform), or null; a route whose template the gateway lacks is skipped. */
export function routeOf(p: KeyProposal, knownTemplates?: ReadonlySet<string>): KeyRoute | null {
  for (const r of KEY_ROUTES) {
    if (knownTemplates && !knownTemplates.has(r.template)) continue;
    if (!r.transforms.includes(p.transform)) continue;
    const fwd = sideMatches(r.a, p.leftObject, p.leftColumn) && sideMatches(r.b, p.rightObject, p.rightColumn);
    const rev = sideMatches(r.b, p.leftObject, p.leftColumn) && sideMatches(r.a, p.rightObject, p.rightColumn);
    if (fwd || rev) return r;
  }
  return null;
}

export function routeKey(r: KeyRoute, p: KeyProposal): string {
  return `${r.id}@${r.scope(p)}`;
}

/** The key of a pair no named statement measures: the proposal as given (match_rate counts its left side). */
export function genericKey(p: KeyProposal): string {
  return `pair:${p.leftObject.toLowerCase()}.${p.leftColumn.toLowerCase()}~${p.rightObject.toLowerCase()}.${p.rightColumn.toLowerCase()}|${p.transform}`;
}

/** True when the gateway (as the client mirrors it) has the generic match_rate template; an absent set means yes. */
export function genericAvailable(knownTemplates?: ReadonlySet<string>): boolean {
  return !knownTemplates || knownTemplates.has(GENERIC_TEMPLATE);
}

/** The measurement key of a proposal: its named join-map route when one exists, else the generic pair key (D16), else null. */
export function routeKeyOf(p: KeyProposal, knownTemplates?: ReadonlySet<string>): string | null {
  const r = routeOf(p, knownTemplates);
  if (r) return routeKey(r, p);
  return genericAvailable(knownTemplates) ? genericKey(p) : null;
}

export interface MeasureResult {
  key: string | null;
  route: string | null;
  label: string | null;
  proposal: KeyProposal;
  status: "measured" | "unmeasurable";
  reason: string | null;
  measured_as: string | null;
  /** D18: the canonical orientation of the statement that ran (null when nothing ran). */
  orientation: Orientation | null;
  left_rows: number | null;
  matched_rows: number | null;
  left_keys: number | null;
  matched_keys: number | null;
  /** D1: matched rows / rows of the left table's primary key (equal to the key reading when the template has no row columns). */
  rate: number | null;
  rate_distinct: number | null;
  verdict: Verdict | null;
  orphans: string[];
  extra: Record<string, number>;
  sql: string | null;
  sql_orphans: string | null;
  /** The C1 rendering of the proposal itself (the statement shape; `sql` is what ran). */
  proposal_sql: string;
  elapsed_ms: number;
  provenance: Provenance[];
  from_memory: string | null;
}

function orphanText(row: Record<string, unknown>): string {
  const vals = Object.values(row).map((v) => (v === null || v === undefined ? "" : String(v)));
  const [first, ...rest] = vals;
  const tail = rest.filter((x) => x !== "");
  return tail.length ? `${first} (${tail.join(", ")})` : `${first}`;
}

export async function measureKey(p: KeyProposal, opts: { gateway: TemplatePort; runId: string; knownTemplates?: ReadonlySet<string> }): Promise<MeasureResult> {
  const proposal = validateProposal(p);
  const proposalSql = matchRateSql(proposal).counts;
  const route = routeOf(proposal, opts.knownTemplates);
  const base: MeasureResult = {
    key: null,
    route: null,
    label: null,
    proposal,
    status: "unmeasurable",
    reason: null,
    measured_as: null,
    orientation: null,
    left_rows: null,
    matched_rows: null,
    left_keys: null,
    matched_keys: null,
    rate: null,
    rate_distinct: null,
    verdict: null,
    orphans: [],
    extra: {},
    sql: null,
    sql_orphans: null,
    proposal_sql: proposalSql,
    elapsed_ms: 0,
    provenance: [],
    from_memory: null,
  };
  if (!route) {
    if (!genericAvailable(opts.knownTemplates)) {
      return { ...base, reason: "no gateway join-map statement measures this pair under this transform (the gateway runs named templates only)" };
    }
    return measureGeneric(proposal, base, opts);
  }
  const t0 = performance.now();
  const params = route.params(proposal);
  const counts = await call(opts.gateway, opts.runId, route.template, params);
  const row = counts.rows[0];
  if (counts.rows.length !== 1 || !row) throw new Error(`${route.template}: expected one count row, got ${counts.rows.length}`);
  const leftKeys = num(pick(row, ["left_keys"]));
  const matchedKeys = num(pick(row, ["matched_keys"]));
  if (leftKeys === null || matchedKeys === null) throw new Error(`${route.template}: null left_keys or matched_keys`);
  const leftRows = num(pick(row, ["left_rows"])) ?? leftKeys;
  const matchedRows = num(pick(row, ["matched_rows"])) ?? matchedKeys;
  const extra: Record<string, number> = {};
  const stateEqual = num(pick(row, ["state_equal"]));
  if (stateEqual !== null) extra.state_equal = stateEqual;
  const provenance = [counts.prov];
  let orphans: string[] = [];
  let sqlOrphans: string | null = null;
  if (route.orphanTemplate && matchedRows < leftRows) {
    const o = await call(opts.gateway, opts.runId, route.orphanTemplate, params);
    provenance.push(o.prov);
    orphans = o.rows.slice(0, ORPHAN_SAMPLE).map(orphanText);
    sqlOrphans = o.prov.sql;
  }
  const rate = leftRows === 0 ? 0 : matchedRows / leftRows;
  return {
    ...base,
    key: routeKey(route, proposal),
    route: route.id,
    label: route.label,
    status: "measured",
    measured_as: route.measuredAs,
    orientation: route.orient(proposal),
    left_rows: leftRows,
    matched_rows: matchedRows,
    left_keys: leftKeys,
    matched_keys: matchedKeys,
    rate,
    rate_distinct: leftKeys === 0 ? 0 : matchedKeys / leftKeys,
    verdict: verdictFor(rate),
    orphans,
    extra,
    sql: counts.prov.sql,
    sql_orphans: sqlOrphans,
    elapsed_ms: Math.round(performance.now() - t0),
    provenance,
  };
}

/**
 * D16: a proposal no named join-map statement measures goes through the gateway's match_rate template: C1's
 * statement over the two views as proposed (the transform on the left column, the left side counted), the
 * columns checked against DESCRIBE by the gateway, bounded at 60 s. A refusal (an unknown column, a view
 * outside the manifest) comes back as unmeasurable with the gateway's reason, never as a number.
 */
async function measureGeneric(proposal: KeyProposal, base: MeasureResult, opts: { gateway: TemplatePort; runId: string }): Promise<MeasureResult> {
  const t0 = performance.now();
  const params = {
    left_object: proposal.leftObject.toLowerCase(),
    left_column: proposal.leftColumn,
    right_object: proposal.rightObject.toLowerCase(),
    right_column: proposal.rightColumn,
    transform: proposal.transform,
  };
  for (const o of [params.left_object, params.right_object]) {
    if (QUESTION_PATH_REFUSED.has(o)) return { ...base, reason: `${o} is read once at onboarding only (D15); the question path reads ${SNAPSHOT}` };
  }
  let counts: Awaited<ReturnType<typeof call>>;
  try {
    counts = await call(opts.gateway, opts.runId, GENERIC_TEMPLATE, params);
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 400) return { ...base, reason: `match_rate refused: ${(e as Error).message.slice(0, 200)}` };
    throw e;
  }
  const row = counts.rows[0];
  if (counts.rows.length !== 1 || !row) throw new Error(`${GENERIC_TEMPLATE}: expected one count row, got ${counts.rows.length}`);
  const leftKeys = num(pick(row, ["left_keys"]));
  const matchedKeys = num(pick(row, ["matched_keys"]));
  if (leftKeys === null || matchedKeys === null) throw new Error(`${GENERIC_TEMPLATE}: null left_keys or matched_keys`);
  const provenance = [counts.prov];
  let orphans: string[] = [];
  let sqlOrphans: string | null = null;
  if (matchedKeys < leftKeys) {
    const o = await call(opts.gateway, opts.runId, GENERIC_ORPHANS_TEMPLATE, params);
    provenance.push(o.prov);
    orphans = o.rows.slice(0, ORPHAN_SAMPLE).map(orphanText);
    sqlOrphans = o.prov.sql;
  }
  const rate = leftKeys === 0 ? 0 : matchedKeys / leftKeys;
  const left = `${proposal.leftObject}.${proposal.leftColumn}`;
  const right = `${proposal.rightObject}.${proposal.rightColumn}`;
  return {
    ...base,
    key: genericKey(proposal),
    route: GENERIC_TEMPLATE,
    label: `${left} ~ ${right} under ${proposal.transform}`,
    status: "measured",
    measured_as: `left the distinct values of ${left} under ${proposal.transform} (nulls dropped); right the distinct values of ${right} (match_rate, one key per row)`,
    orientation: { left, right, transform_on: "left" },
    left_rows: leftKeys,
    matched_rows: matchedKeys,
    left_keys: leftKeys,
    matched_keys: matchedKeys,
    rate,
    rate_distinct: rate,
    verdict: verdictFor(rate),
    orphans,
    sql: counts.prov.sql,
    sql_orphans: sqlOrphans,
    elapsed_ms: Math.round(performance.now() - t0),
    provenance,
  };
}

/** L2: the planner's proposals against the deterministic baseline's, scored by the same measured join map. */
export interface SideScore {
  proposals: number;
  routed: number;
  measured: number;
  verified: number;
  partial: number;
  rejected: number;
  unmeasured: number;
  keys: string[];
}

export function scoreProposals(choices: readonly KeyChoice[], measured: ReadonlyMap<string, MeasureResult>, knownTemplates?: ReadonlySet<string>): SideScore {
  const s: SideScore = { proposals: choices.length, routed: 0, measured: 0, verified: 0, partial: 0, rejected: 0, unmeasured: 0, keys: [] };
  for (const c of choices) {
    let p: KeyProposal;
    try {
      p = toProposal(c);
    } catch {
      s.unmeasured++;
      continue;
    }
    const key = routeKeyOf(p, knownTemplates);
    if (!key) {
      s.unmeasured++;
      continue;
    }
    s.routed++;
    const m = measured.get(key);
    if (!m || m.status !== "measured") {
      s.unmeasured++;
      continue;
    }
    s.measured++;
    if (!s.keys.includes(m.key!)) s.keys.push(m.key!);
    if (m.verdict === "VERIFIED") s.verified++;
    else if (m.verdict === "PARTIAL") s.partial++;
    else s.rejected++;
  }
  return s;
}

// ---------- register_source ----------

interface PlanSpec {
  plan: string;
  params: Record<string, RegExp>;
  object(p: Record<string, string>): string;
}

/** Catalogue id -> the gateway registrar plan behind register_source (D8). Nothing else is registrable. */
export const REGISTRABLE: Record<string, PlanSpec> = {
  openfema_disaster_declarations: { plan: "register_fema", params: { quarter: /^CY\d{4}Q[1-4]$/u }, object: (p) => `cw.fema_declarations_dr_${quarterSlug(p.quarter!)}` },
  noaa_ghcn_stations: { plan: "register_stations", params: {}, object: () => "cw.stations" },
  sec_frames: {
    plan: "register_frames",
    params: { tag: /^(Revenues|RevenueFromContractWithCustomerExcludingAssessedTax|RegulatedAndUnregulatedOperatingRevenue)$/u, period: /^CY\d{4}Q[1-3]$/u },
    object: (p) => `cw.frames_${p.tag}_${p.period}`,
  },
  sec_submissions: { plan: "register_submission", params: { cik10: /^\d{10}$/u }, object: (p) => `cw.submission_${p.cik10}` },
  noaa_ghcn_by_year: { plan: "register_ghcn", params: { year: /^20\d{2}$/u, element: /^(TMAX|TMIN)$/u }, object: (p) => `cw.ghcn_${p.year}_${p.element!.toLowerCase()}` },
};

export interface RegisterResult {
  status: "registered" | "already_registered";
  catalogue_id: string;
  plan: string;
  params: Record<string, string>;
  object: string;
  rows: number | null;
  elapsed_ms: number;
  contract_id: string;
  steps: { template_id: string; elapsed_ms: number | null; skipped_exists: boolean }[];
  sql: string[];
  provenance: Provenance[];
}

/** The catalogue entry and plan for a registration, or a DiscoveryRefusal (unknown id, known_to_fail, not registrable, bad parameters). */
export function registrationPlan(catalogueId: string, params: Record<string, string>, catalogue: unknown): { spec: PlanSpec; object: string } {
  const entries = (catalogue as { entries?: { id: string; status: string }[] })?.entries;
  if (!Array.isArray(entries)) throw new Error("catalogue has no entries array");
  const entry = entries.find((e) => e.id === catalogueId);
  if (!entry) throw new DiscoveryRefusal("unknown_source", `not a catalogue id: ${catalogueId}`);
  if (entry.status === "known_to_fail") throw new DiscoveryRefusal("known_to_fail", `${catalogueId} is known_to_fail in the catalogue (negative memory): never registered`);
  const spec = REGISTRABLE[catalogueId];
  if (!spec) throw new DiscoveryRefusal("not_registrable", `${catalogueId} has no registrar plan`);
  const extra = Object.keys(params).filter((k) => !(k in spec.params));
  const missing = Object.keys(spec.params).filter((k) => !(k in params));
  if (extra.length || missing.length) throw new DiscoveryRefusal("bad_params", `${catalogueId} takes [${Object.keys(spec.params).join(", ")}]; missing [${missing.join(", ")}], unexpected [${extra.join(", ")}]`);
  for (const [k, re] of Object.entries(spec.params)) {
    if (typeof params[k] !== "string" || !re.test(params[k]!)) throw new DiscoveryRefusal("bad_params", `invalid ${k}: ${String(params[k]).slice(0, 40)}`);
  }
  return { spec, object: spec.object(params) };
}

export async function registerSource(catalogueId: string, params: Record<string, string>, opts: { registrar: RegistrarPortLike; catalogue: unknown; gateway?: TemplatePort | null; runId: string }): Promise<RegisterResult> {
  const { spec, object } = registrationPlan(catalogueId, params, opts.catalogue);
  const t0 = performance.now();
  const reply = await opts.registrar.register("register_source", { catalogue_id: catalogueId, ...params });
  const steps = reply.steps.map((s) => ({ template_id: s.template_id, elapsed_ms: s.elapsed_ms ?? null, skipped_exists: !!s.skipped_exists }));
  const already = reply.already_registered === true || (steps.length > 0 && steps.every((s) => s.skipped_exists));
  const provenance: Provenance[] = reply.steps.map((s) => ({ template: s.template_id, params: { ...reply.params }, sql: s.sql, elapsed_ms: s.elapsed_ms ?? 0, run_id: opts.runId, executed_at: null, cache_state: null }));
  let rows: number | null = typeof reply.rows === "number" ? reply.rows : null;
  if (rows === null && opts.gateway) {
    try {
      if (spec.plan === "register_fema") {
        const r = await call(opts.gateway, opts.runId, "fema_by_state", { quarter: params.quarter! });
        provenance.push(r.prov);
        rows = r.rows.reduce((s, x) => s + (num(pick(x, ["designated_areas"])) ?? 0), 0);
      } else if (spec.plan === "register_frames") {
        const r = await call(opts.gateway, opts.runId, "frames_count", { tag: params.tag!, period: params.period! });
        provenance.push(r.prov);
        rows = num(pick(r.rows[0] ?? {}, ["n"]));
      }
    } catch {
      rows = null;
    }
  }
  return {
    status: already ? "already_registered" : "registered",
    catalogue_id: catalogueId,
    plan: spec.plan,
    params: { ...params },
    object: reply.object ?? object,
    rows,
    elapsed_ms: reply.wall_ms ?? Math.round(performance.now() - t0),
    contract_id: reply.contract_id,
    steps,
    sql: reply.steps.map((s) => s.sql),
    provenance,
  };
}

/** The registrations a question needs: the FEMA view of its quarter (always sent, so the registrar path runs under contract) and any frames view of the two periods the manifest does not list. */
export function registrationsNeeded(quarter: string, registered: ReadonlySet<string>): { catalogue_id: string; params: Record<string, string>; object: string }[] {
  const out: { catalogue_id: string; params: Record<string, string>; object: string }[] = [
    { catalogue_id: "openfema_disaster_declarations", params: { quarter }, object: `cw.fema_declarations_dr_${quarterSlug(quarter)}` },
  ];
  const lower = new Set([...registered].map((o) => o.toLowerCase()));
  const m = QUARTER_RE.exec(quarter)!;
  if (m[2] === "4") return out;
  for (const period of [quarter, previousYear(quarter)]) {
    for (const tag of REVENUE_TAGS) {
      const object = `cw.frames_${tag}_${period}`;
      if (!lower.has(object.toLowerCase())) out.push({ catalogue_id: "sec_frames", params: { tag, period }, object });
    }
  }
  return out;
}

// ---------- compile_usl ----------

export const GOVERNED_USL = "crosswalk_usl";
/** The two sub-3-second DQ rules compile_usl runs live (D6); every other rule is read from the onboarding file. */
export const LIVE_DQ_RULES = ["fema_declaration.state", "utility_state.state"] as const;

export type FkSupport = { kind: "key"; route: string } | { kind: "live_dq"; rule: string } | { kind: "onboarding_dq"; rule: string };

/** What each governed foreign key rests on: a key measured in this run, a DQ rule run live, or the onboarding DQ run. */
export const FK_SUPPORT: Record<string, FkSupport> = {
  "utility.sic -> sic_code.sic": { kind: "key", route: "sic" },
  "revenue_quarter.cik -> utility.cik": { kind: "key", route: "cik" },
  "station.state -> state.code": { kind: "key", route: "station" },
  "fema_declaration.state -> state.code": { kind: "live_dq", rule: "fema_declaration.state" },
  "utility_state.state -> state.code": { kind: "live_dq", rule: "utility_state.state" },
  "utility_state.cik -> utility.cik": { kind: "onboarding_dq", rule: "utility_state.cik" },
};

export interface DqRuleResult {
  rule: string;
  total: number | null;
  valid: number | null;
  invalid: number | null;
  elapsed_ms: number | null;
  sql: string | null;
  error: string | null;
}

export interface DqFileSummary {
  ran_at: string | null;
  rules: DqRuleResult[];
  invalid_rows: unknown[];
}

/**
 * data/dq/latest.json as the onboarding run writes it: {ran_at, rules: [{rule, total, valid, invalid,
 * elapsed_s | elapsed_ms, sql}], invalid_rows: [...]}; the sister's single-rule shape {rule, run: {total,
 * valid, invalid}} is read too. Null when the file is absent or unreadable.
 */
export function readDqFile(path: string | null | undefined): DqFileSummary | null {
  if (!path || !existsSync(path)) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const rules: DqRuleResult[] = [];
  const toRule = (r: Record<string, unknown>): DqRuleResult => ({
    rule: String(r.rule ?? ""),
    total: num(r.total),
    valid: num(r.valid),
    invalid: num(r.invalid),
    elapsed_ms: num(r.elapsed_ms) ?? (num(r.elapsed_s) === null ? null : Math.round(num(r.elapsed_s)! * 1000)),
    sql: typeof r.sql === "string" ? r.sql : null,
    error: typeof r.error === "string" ? r.error : null,
  });
  if (Array.isArray(raw.rules)) for (const r of raw.rules as Record<string, unknown>[]) rules.push(toRule(r));
  else if (raw.run && typeof raw.run === "object") rules.push(toRule({ rule: raw.rule, ...(raw.run as Record<string, unknown>), elapsed_s: raw.elapsed_s }));
  return { ran_at: typeof raw.ran_at === "string" ? raw.ran_at : null, rules, invalid_rows: Array.isArray(raw.invalid_rows) ? raw.invalid_rows : [] };
}

/** The RUN DQ reply: total, valid, invalid (named columns, else the first three values). */
export function parseDqRun(reply: Pick<TemplateReply, "columns" | "rows">): { total: number | null; valid: number | null; invalid: number | null } {
  // Lightning 2.4.3.1 answers RUN DQ with one row per constraint (name, table, type, total_record, valid_record,
  // invalid_record): the primary-key row first, then the foreign-key row. The FK row is the rule's result.
  const typeIdx = reply.columns.findIndex((c) => c.toLowerCase() === "type");
  const fkRow = typeIdx >= 0 ? reply.rows.find((r) => /foreign/iu.test(String(r[typeIdx] ?? ""))) : undefined;
  const row = fkRow ?? reply.rows[0];
  if (!row) return { total: null, valid: null, invalid: null };
  const obj = Object.fromEntries(reply.columns.map((c, i) => [c, row[i] ?? null]));
  const total = num(pick(obj, ["total", "total_record", "total_records", "total_count"]));
  const valid = num(pick(obj, ["valid", "valid_record", "valid_records", "valid_count"]));
  const invalid = num(pick(obj, ["invalid", "invalid_record", "invalid_records", "invalid_count"]));
  if (total !== null || valid !== null || invalid !== null) return { total, valid, invalid };
  return { total: num(row[0]), valid: num(row[1]), invalid: num(row[2]) };
}

export interface FkCheck {
  fk: string;
  transform: string;
  support: FkSupport | null;
  satisfied: boolean;
  basis: string;
}

export interface CompileResult {
  status: "matches_governed" | "new_version";
  matches_governed: boolean;
  usl: string;
  ddl: string;
  governed_ddl: string;
  diff: { missing_fks: string[]; extra_fks: string[] };
  fks: FkCheck[];
  dq: DqFileSummary | null;
  invalid_rows: unknown[];
  live_rules_run: DqRuleResult[];
  compiled: false;
  note: string;
  provenance: Provenance[];
  elapsed_ms: number;
}

const fkName = (fk: UslFk) => `${fk.from} -> ${fk.to}`;
const share = (r: { total: number | null; valid: number | null }) => (r.total && r.valid !== null ? r.valid / r.total : null);

export async function compileUsl(input: { governed: unknown; measured: Iterable<MeasureResult>; gateway: TemplatePort | null; runId: string; dqFile?: string | null; nextVersion?: number }): Promise<CompileResult> {
  const t0 = performance.now();
  const governed = validatePlan(input.governed);
  const governedDdl = renderCompileUsl(governed);
  const verifiedRoutes = new Set<string>();
  for (const m of input.measured) if (m.status === "measured" && m.route && (m.verdict === "VERIFIED" || m.verdict === "PARTIAL")) verifiedRoutes.add(m.route);
  const provenance: Provenance[] = [];
  const live: DqRuleResult[] = [];
  for (const rule of LIVE_DQ_RULES) {
    if (!input.gateway) {
      live.push({ rule, total: null, valid: null, invalid: null, elapsed_ms: null, sql: null, error: "no gateway" });
      continue;
    }
    try {
      const r = await call(input.gateway, input.runId, "dq_run", { rule });
      provenance.push(r.prov);
      live.push({ rule, ...parseDqRun(r.reply), elapsed_ms: r.reply.elapsed_ms, sql: r.prov.sql, error: null });
    } catch (e) {
      live.push({ rule, total: null, valid: null, invalid: null, elapsed_ms: null, sql: null, error: (e as Error).message.slice(0, 200) });
    }
  }
  const dq = readDqFile(input.dqFile ?? null);
  const fks: FkCheck[] = governed.fks.map((fk) => {
    const support = FK_SUPPORT[fkName(fk)] ?? null;
    let satisfied = false;
    let basis = "no support rule";
    if (support?.kind === "key") {
      satisfied = verifiedRoutes.has(support.route);
      basis = satisfied ? `key ${support.route} measured VERIFIED or PARTIAL in this run` : `key ${support.route} not measured VERIFIED or PARTIAL in this run`;
    } else if (support?.kind === "live_dq") {
      const r = live.find((x) => x.rule === support.rule);
      const s = r ? share(r) : null;
      satisfied = s !== null && s >= 0.95;
      basis = r?.error ? `live DQ ${support.rule} failed: ${r.error}` : `live DQ ${support.rule}: ${r?.valid ?? "?"} of ${r?.total ?? "?"} valid`;
    } else if (support?.kind === "onboarding_dq") {
      const r = dq?.rules.find((x) => x.rule === support.rule);
      const s = r ? share(r) : null;
      satisfied = r ? s !== null && s >= 0.95 : true;
      basis = r ? `onboarding DQ ${support.rule}: ${r.valid ?? "?"} of ${r.total ?? "?"} valid` : "both sides come from seeds/utilities.json (no onboarding DQ result on disk)";
    }
    return { fk: fkName(fk), transform: fk.transform, support, satisfied, basis };
  });
  const keep = new Set(fks.filter((f) => f.satisfied).map((f) => f.fk));
  const missing = fks.filter((f) => !f.satisfied).map((f) => f.fk);
  const matches = missing.length === 0;
  const usl = matches ? governed.usl : `${GOVERNED_USL}_v${input.nextVersion ?? 2}`;
  const runPlan: UslPlan = validatePlan({ ...structuredClone(governed), usl, fks: governed.fks.filter((fk) => keep.has(fkName(fk))).map((fk) => ({ ...fk })) });
  const ddl = renderCompileUsl(runPlan);
  return {
    status: matches ? "matches_governed" : "new_version",
    matches_governed: matches,
    usl,
    ddl,
    governed_ddl: governedDdl,
    diff: { missing_fks: missing, extra_fks: [] },
    fks,
    dq,
    invalid_rows: dq?.invalid_rows ?? [],
    live_rules_run: live,
    compiled: false,
    note: matches
      ? `the plan rendered from this run's verified keys equals the governed ${governed.namespace}.${governed.usl}; nothing to compile`
      : `the plan differs from the governed model (missing ${missing.join("; ")}); it compiles as ${usl} at onboarding (never DROP, never ALTER)`,
    provenance,
    elapsed_ms: Math.round(performance.now() - t0),
  };
}

// ---------- answer ----------

export interface AnswerCell<T> {
  value: T;
  provenance: Provenance;
}

export interface RevenueCell {
  tag: string;
  current: number;
  previous: number | null;
  change: number | null;
  current_accn: string | null;
  previous_accn: string | null;
  note: string | null;
}

export interface WeatherCell {
  stations: string[];
  tdd_current: number;
  tdd_previous: number;
  change: number;
}

export interface AnswerRow {
  cik: string;
  name: string;
  ticker: string | null;
  states: { state: string; declarations: number; by_incident_type: Record<string, number> }[];
  declarations: number;
  by_incident_type: Record<string, number>;
  revenue: RevenueCell | null;
  revenue_note: string | null;
  weather: WeatherCell | null;
  weather_note: string | null;
  provenance: { declarations: Provenance; revenue_current: Provenance | null; revenue_previous: Provenance | null; weather: Provenance[] };
}

export interface AnswerResult {
  quarter: string;
  previous: string;
  rows: AnswerRow[];
  weather_status: "measured" | "not_tested";
  provenance: Provenance[];
  elapsed_ms: number;
  /** The join-map checks the answer was gated on (absent in runs saved before the gate). */
  gate?: AnswerGate | null;
}

/** One join the answer depends on, checked against this run's join map (a key measured in this run, or recalled as VERIFIED). */
export interface AnswerGateCheck {
  key: string;
  need: "VERIFIED";
  verdict: Verdict | null;
  matched_rows: number | null;
  left_rows: number | null;
  recalled: boolean;
  ok: boolean;
  note: string;
}

/** A join-map key reported beside the gate and never used to withhold: its rate measures coverage, not whether the codes join. */
export interface AnswerCoverage {
  key: string;
  verdict: Verdict | null;
  matched_rows: number | null;
  left_rows: number | null;
  orphans: string[];
  recalled: boolean;
  note: string;
}

/** The FEMA selection needs the FEMA state codes to join the state reference (fema_fips VERIFIED: form); the revenue column needs the CIK key VERIFIED; the weather column needs the station key VERIFIED. The FEMA state key against the states the seed utilities serve (fema_state) measures coverage and is only reported. */
export interface AnswerGate {
  fema: AnswerGateCheck;
  revenue: AnswerGateCheck;
  weather: AnswerGateCheck;
  fema_coverage: AnswerCoverage;
}

export function answerGate(quarter: string, measured: ReadonlyMap<string, MeasureResult>): AnswerGate {
  const read = (route: "fema_fips" | "fema_state" | "cik" | "station") => {
    const key = `${route}@${route === "station" ? "all" : quarter}`;
    const m = measured.get(key);
    const verdict = m && m.status === "measured" ? m.verdict : null;
    const counts = m && m.matched_rows !== null && m.left_rows !== null ? ` (${m.matched_rows} of ${m.left_rows})` : "";
    const recalled = !!m?.from_memory;
    const state = verdict ? `${verdict}${counts}${recalled ? ", recalled from memory" : ""}` : "not measured in this run";
    return { key, m, verdict, recalled, state };
  };
  const check = (route: "fema_fips" | "cik" | "station", what: string): AnswerGateCheck => {
    const { key, m, verdict, recalled, state } = read(route);
    const ok = verdict === "VERIFIED";
    const note = ok ? `${what}: key ${key} ${state}` : `${what} withheld: key ${key} is ${state}, and the answer needs it VERIFIED`;
    return { key, need: "VERIFIED", verdict, matched_rows: m?.matched_rows ?? null, left_rows: m?.left_rows ?? null, recalled, ok, note };
  };
  const cov = read("fema_state");
  const orphans = cov.verdict ? [...(cov.m?.orphans ?? [])] : [];
  const fema_coverage: AnswerCoverage = {
    key: cov.key,
    verdict: cov.verdict,
    matched_rows: cov.m?.matched_rows ?? null,
    left_rows: cov.m?.left_rows ?? null,
    orphans,
    recalled: cov.recalled,
    note: `FEMA coverage (reported, not gated): key ${cov.key} ${cov.state}${orphans.length ? `; declared states no seed utility serves: ${orphans.join(", ")}` : ""}`,
  };
  return { fema: check("fema_fips", "FEMA selection"), revenue: check("cik", "Revenue column"), weather: check("station", "Weather column"), fema_coverage };
}

const FEMA_BASE_COLUMNS = new Set(["cik", "name", "ticker", "state", "declarations"]);

/** answer_fema_utilities rows grouped per utility: served states with declarations, distinct declarations summed over states, incident types summed. */
export function groupFemaRows(rows: Record<string, unknown>[]): Omit<AnswerRow, "revenue" | "revenue_note" | "weather" | "weather_note" | "provenance">[] {
  const byCik = new Map<string, Omit<AnswerRow, "revenue" | "revenue_note" | "weather" | "weather_note" | "provenance">>();
  for (const raw of rows) {
    const r = lowerKeys(raw);
    const cik = String(r.cik ?? "");
    if (!/^\d{10}$/u.test(cik)) throw new Error(`answer_fema_utilities: bad cik ${cik}`);
    const declarations = num(r.declarations) ?? 0;
    const byType: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (FEMA_BASE_COLUMNS.has(k.toLowerCase())) continue;
      const n = num(v);
      if (n !== null) byType[k] = n;
    }
    const u = byCik.get(cik) ?? { cik, name: String(r.name ?? ""), ticker: r.ticker === null || r.ticker === undefined || r.ticker === "" ? null : String(r.ticker), states: [], declarations: 0, by_incident_type: {} };
    u.states.push({ state: String(r.state ?? ""), declarations, by_incident_type: byType });
    u.declarations += declarations;
    for (const [k, v] of Object.entries(byType)) u.by_incident_type[k] = (u.by_incident_type[k] ?? 0) + v;
    byCik.set(cik, u);
  }
  const out = [...byCik.values()];
  for (const u of out) u.states.sort((a, b) => (a.state < b.state ? -1 : a.state > b.state ? 1 : 0));
  out.sort((a, b) => b.declarations - a.declarations || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.cik < b.cik ? -1 : 1));
  return out;
}

/** Year-on-year revenue under the tag the current quarter reports (like-for-like tag; a different tag a year earlier is named, not compared). */
export function revenueCell(cur: Record<string, unknown> | undefined, prev: Record<string, unknown> | undefined): { cell: RevenueCell | null; note: string | null } {
  if (!cur) return { cell: null, note: "no revenue fact in the current quarter under Revenues, RevenueFromContractWithCustomerExcludingAssessedTax or RegulatedAndUnregulatedOperatingRevenue" };
  const tag = String(pick(cur, ["xbrl_tag", "tag"]) ?? "");
  const current = num(pick(cur, ["val"]));
  if (current === null) return { cell: null, note: "current revenue value is null" };
  const curAccn = pick(cur, ["accn"]);
  if (!prev) return { cell: { tag, current, previous: null, change: null, current_accn: curAccn ? String(curAccn) : null, previous_accn: null, note: "no fact a year earlier" }, note: null };
  const prevTag = String(pick(prev, ["xbrl_tag", "tag"]) ?? "");
  const previous = num(pick(prev, ["val"]));
  const prevAccn = pick(prev, ["accn"]);
  if (prevTag !== tag) {
    return { cell: { tag, current, previous: null, change: null, current_accn: curAccn ? String(curAccn) : null, previous_accn: prevAccn ? String(prevAccn) : null, note: `a year earlier the first available tag is ${prevTag}, not ${tag}: not compared` }, note: null };
  }
  const change = previous === null || previous === 0 ? null : current / previous - 1;
  return { cell: { tag, current, previous, change, current_accn: curAccn ? String(curAccn) : null, previous_accn: prevAccn ? String(prevAccn) : null, note: null }, note: null };
}

/** Mean total degree days (HDD + CDD) over a utility's stations that report in both years with coverage >= 0.9, and the change. */
export function weatherCell(stations: readonly string[], current: Record<string, unknown>[], previous: Record<string, unknown>[]): { cell: WeatherCell | null; note: string | null } {
  const tdd = (rows: Record<string, unknown>[]) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const id = String(pick(r, ["station_id", "id"]) ?? "");
      const cov = num(pick(r, ["coverage"]));
      const hdd = num(pick(r, ["hdd"]));
      const cdd = num(pick(r, ["cdd"]));
      if (hdd === null || cdd === null || (cov !== null && cov < 0.9)) continue;
      m.set(id, hdd + cdd);
    }
    return m;
  };
  const c = tdd(current);
  const p = tdd(previous);
  const used = stations.filter((s) => c.has(s) && p.has(s));
  if (used.length === 0) return { cell: null, note: "no station of the utility reports both years with coverage of at least 0.9" };
  const mc = used.reduce((s, x) => s + c.get(x)!, 0) / used.length;
  const mp = used.reduce((s, x) => s + p.get(x)!, 0) / used.length;
  if (mp === 0) return { cell: null, note: "zero degree days a year earlier" };
  return { cell: { stations: used, tdd_current: mc, tdd_previous: mp, change: mc / mp - 1 }, note: null };
}

export async function answer(params: { quarter: string }, opts: { gateway: TemplatePort; runId: string; stationsByCik?: Record<string, string[]> | null; gate?: AnswerGate | null }): Promise<AnswerResult> {
  const t0 = performance.now();
  const quarter = params.quarter;
  quarterSlug(quarter);
  const previous = previousYear(quarter);
  const provenance: Provenance[] = [];
  const gate = opts.gate ?? null;
  if (gate && !gate.fema.ok) return { quarter, previous, rows: [], weather_status: "not_tested", provenance, elapsed_ms: Math.round(performance.now() - t0), gate };
  const f = await call(opts.gateway, opts.runId, "answer_fema_utilities", { quarter });
  provenance.push(f.prov);
  const grouped = groupFemaRows(f.rows);
  const ciks = grouped.map((g) => g.cik);
  const revenue = new Map<string, { cur?: Record<string, unknown>; prev?: Record<string, unknown> }>();
  let curProv: Provenance | null = null;
  let prevProv: Provenance | null = null;
  const qn = QUARTER_RE.exec(quarter)![2];
  const revenueGated = !!gate && !gate.revenue.ok;
  if (ciks.length && qn !== "4" && !revenueGated) {
    const cikList = ciks.join(",");
    const c = await call(opts.gateway, opts.runId, "answer_revenue", { period: quarter, cik_list: cikList });
    const p = await call(opts.gateway, opts.runId, "answer_revenue", { period: previous, cik_list: cikList });
    curProv = c.prov;
    prevProv = p.prov;
    provenance.push(c.prov, p.prov);
    for (const r of c.rows) revenue.set(String(pick(r, ["cik"])), { ...(revenue.get(String(pick(r, ["cik"])))), cur: r });
    for (const r of p.rows) revenue.set(String(pick(r, ["cik"])), { ...(revenue.get(String(pick(r, ["cik"])))), prev: r });
  }
  let weatherStatus: AnswerResult["weather_status"] = "not_tested";
  const weatherRows: { cur: Record<string, unknown>[]; prev: Record<string, unknown>[]; prov: Provenance[] } = { cur: [], prev: [], prov: [] };
  const weatherGated = !!gate && !gate.weather.ok;
  if (opts.stationsByCik && qn !== "4" && !weatherGated) {
    const union = [...new Set(ciks.flatMap((c) => opts.stationsByCik![c] ?? []))].sort();
    if (union.length > 0 && union.length <= 60) {
      const m = QUARTER_RE.exec(quarter)!;
      const wc = await call(opts.gateway, opts.runId, "weather_quarter", { year: m[1]!, quarter: m[2]!, station_list: union.join(",") });
      const wp = await call(opts.gateway, opts.runId, "weather_quarter", { year: String(Number(m[1]) - 1), quarter: m[2]!, station_list: union.join(",") });
      weatherRows.cur = wc.rows;
      weatherRows.prev = wp.rows;
      weatherRows.prov = [wc.prov, wp.prov];
      provenance.push(wc.prov, wp.prov);
      weatherStatus = "measured";
    }
  }
  const rows: AnswerRow[] = grouped.map((g) => {
    const rv = revenue.get(g.cik) ?? {};
    const { cell, note } = qn === "4" ? { cell: null, note: "the frames API has no three-month fourth-quarter frame" } : revenueGated ? { cell: null, note: gate!.revenue.note } : revenueCell(rv.cur, rv.prev);
    const w = weatherStatus === "measured" ? weatherCell(opts.stationsByCik![g.cik] ?? [], weatherRows.cur, weatherRows.prev) : { cell: null, note: weatherGated ? gate!.weather.note : "not tested" };
    return {
      ...g,
      revenue: cell,
      revenue_note: note,
      weather: w.cell,
      weather_note: w.note,
      provenance: { declarations: f.prov, revenue_current: rv.cur ? curProv : null, revenue_previous: rv.prev ? prevProv : null, weather: weatherStatus === "measured" ? weatherRows.prov : [] },
    };
  });
  return { quarter, previous, rows, weather_status: weatherStatus, provenance, elapsed_ms: Math.round(performance.now() - t0), ...(gate ? { gate } : {}) };
}

// ---------- not_tested ----------

export const NOT_TESTED_BASE = [
  "County geography: declarations are joined to utilities by state; the counties a declaration names are not matched to service territories.",
  "Non-major declarations: only major-disaster (DR) declarations are read; emergency (EM) and fire-management (FM) declarations are left out.",
  "Fuel-cost pass-through: revenue moves with fuel and purchased-power clauses, so a revenue change is not a measure of disaster impact.",
  "Recasts: frames serve the latest filed value for each quarter; restated comparatives are not reconciled, and each value names its tag.",
] as const;

export const NOT_TESTED_WEATHER = "Weather at the utilities' stations: the GHCN station tables were not registered and cached in time, so the weather column is not computed.";

export function notTested(opts: { weather: boolean }): string[] {
  return opts.weather ? [...NOT_TESTED_BASE] : [...NOT_TESTED_BASE, NOT_TESTED_WEATHER];
}
