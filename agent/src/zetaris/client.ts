// HTTP client for the Zetaris gateway (127.0.0.1:8803). The agent sends a template id
// and parameters, never SQL text. Parameters are checked here with the gateway's own
// patterns before any request, so a bad CIK or period fails fast and locally; the gateway
// checks them again. Only loopback gateway hosts are accepted.
// Adapted from Weather-or-Not and ClearShelf (same author, Apache-2.0).

import { DEFAULT_GATEWAY_URL } from "../config.ts";

export type Role = "reader" | "registrar";
export type CacheState = "hit" | "miss" | "unknown" | string;

/** The gateway's POST /sql/template response body. */
export interface TemplateResponse {
  template_id: string;
  role: Role;
  columns: string[];
  rows: unknown[][];
  row_count: number;
  truncated: boolean;
  elapsed_ms: number;
  sql: string | null;
  sql_sha256: string | null;
  objects: string[];
  raw_objects: string[];
  executed_at: string;
  cache_state: CacheState;
  cache_detail: Record<string, string>;
  source_cached_at: Record<string, string>;
  error: string | null;
}

export interface TemplateResult extends TemplateResponse {
  params: Record<string, string>;
  http_status: number;
  wall_ms: number;
  /** HTTP 503 "warming" replies that were waited out before this result. */
  warm_retries: number;
}

/** One step of a registrar plan as the gateway reports it (POST /registrar/<action>). */
export interface RegistrarStep {
  template_id: string;
  kind: string;
  sql: string;
  sql_sha256: string;
  objects: string[];
  elapsed_ms?: number;
  executed_at?: string;
  row_count?: number;
  columns?: string[];
  rows?: unknown[][];
  skipped_exists?: boolean;
  error?: string;
}

export interface RegistrarResponse {
  action: string;
  params: Record<string, string>;
  contract_id: string;
  steps: RegistrarStep[];
  skipped: string[];
  error?: string;
  code?: string;
  /** register_source only: the catalogue entry, the plan it ran, and whether the view already existed
   *  (then only DESCRIBE, plus CACHE if the driver had evicted it, was sent). */
  catalogue_id?: string;
  dispatched_to?: string;
  already_registered?: boolean;
}

export interface RegistrarResult extends RegistrarResponse {
  http_status: number;
  wall_ms: number;
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly response?: Partial<TemplateResponse> | Partial<RegistrarResponse>,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

// Same patterns as gateway/templates.py PARAM_PATTERNS.
export const PARAM_PATTERNS = {
  cik10: /^\d{10}$/u,
  tag: /^(Revenues|RevenueFromContractWithCustomerExcludingAssessedTax|RegulatedAndUnregulatedOperatingRevenue)$/u,
  period: /^CY\d{4}Q[1-3]$/u,
  year: /^20\d{2}$/u,
  quarter: /^[1-3]$/u,
  station: /^US[A-Z0-9]{9}$/u,
  station_list: /^US[A-Z0-9]{9}(,US[A-Z0-9]{9}){0,59}$/u,
  element: /^(TMAX|TMIN)$/u,
  sic: /^\d{4}$/u,
  fema_quarter: /^CY\d{4}Q[1-4]$/u,
  // A cw.* SchemaStore view, lower case (Lightning folds identifier case: pass cw.frames_revenues_cy2025q1). The
  // gateway also requires it to be a view zetaris/manifest.json lists; won.*, clearshelf_* and unlisted names are refused.
  cw_object: /^cw\.[a-z0-9_]+$/u,
  column: /^[A-Za-z][A-Za-z0-9_]{0,63}$/u,
  cik_list: /^\d{10}(,\d{10}){0,59}$/u,
  dq_rule: /^(utility\.sic|utility_state\.cik|utility_state\.state|fema_declaration\.state|station\.state|revenue_quarter\.cik)$/u,
  catalogue_id: /^[a-z][a-z0-9_]{0,63}$/u,
} as const;
export type ParamKind = keyof typeof PARAM_PATTERNS;

/** Parameter kinds per reader template id, mirroring gateway/templates.py TEMPLATES: the
 *  templates the agent may call through POST /sql/template. The registrar_* step templates
 *  of gateway/templates.py run only inside a plan (GatewayClient.registrar) and are not
 *  listed here. agent/test/zetaris-client.test.ts checks this map against the Python file. */
export const TEMPLATE_PARAMS: Record<string, Record<string, ParamKind>> = {
  select1: {},
  show_databases: {},
  // GHCN degree days over the cached cw.ghcn_<year>_<element> views (zetaris/sql/09_cw_ghcn_*.sql):
  // station_id, year, quarter, hdd, cdd, days_observed, days_in_quarter, coverage per station,
  // about 19 s for any station list (1 to 60 ids), so one call per (year, quarter).
  weather_quarter: { year: "year", quarter: "quarter", station_list: "station_list" },
  // Discovery probes over one manifest view (probe_source): DESCRIBE; five rows; rows, distinct values,
  // non-null values and the non-null share of one column.
  describe_object: { object: "cw_object" },
  sample_rows: { object: "cw_object" },
  distinct_counts: { object: "cw_object", column: "column" },
  // SEC frames (cw.frames_<tag>_<period>): cik, entityName, loc, start, end, val, accn.
  // frames_period holds every filer (the reply carries the first 200 rows; row_count is the total).
  frames_period: { tag: "tag", period: "period" },
  frames_count: { tag: "tag", period: "period" },
  frames_fact: { tag: "tag", period: "period", cik10: "cik10" },
  // SEC submissions (cw.submission_<cik10>): cik, name, sic, sicDescription, state.
  submission: { cik10: "cik10" },
  // SIC reference (cw.sic_codes): code, description, division, division_desc, major_group, major_group_desc.
  sic: { code: "sic" },
  // The answer (question path, cached views, sub-second): the seed names; one row per (utility, served state)
  // with that quarter's DR declarations (cik, name, ticker, state, declarations, severe_storm, fire, flood,
  // other_incidents; declarations desc, name); per cik the first revenue tag with a frames fact (cik, xbrl_tag, val, accn).
  seed_utility_names: {},
  answer_fema_utilities: { quarter: "fema_quarter" },
  answer_revenue: { period: "period", cik_list: "cik_list" },
  // The governed USL (each under 3 s): tables, DQ rules, the model as JSON (compile_usl diffs against it).
  usl_tables: {},
  usl_dq_rules: {},
  usl_model: {},
  // RUN DQ / SHOW DQ INVALID RECORD for one of the six FK rules: minutes, onboarding only (ONBOARDING_ONLY_TEMPLATES).
  dq_run: { rule: "dq_rule" },
  dq_invalid: { rule: "dq_rule" },
  // Crosswalk reads (zetaris/sql/01_cw_fema, 02_cw_stations, 05_cw_seeds): one quarter of FEMA major-disaster
  // declarations (cw.fema_declarations_dr_<yyyy>q<n>), the OpenFEMA catalogue, the stations inventory lookup.
  fema_declarations: { quarter: "fema_quarter" },
  fema_by_state: { quarter: "fema_quarter" },
  catalogue_list: {},
  stations_lookup: { ids: "station_list" },
  // The join map (zetaris/sql/06_cw_joinmap_select.sql): left_keys and matched_keys per key, plus orphan samples.
  joinmap_cik: { period: "period" },
  joinmap_cik_orphans: { period: "period" },
  joinmap_loc: { period: "period" },
  joinmap_fema_state: { quarter: "fema_quarter" },
  joinmap_fema_state_orphans: { quarter: "fema_quarter" },
  joinmap_station: {},
  joinmap_sic: {},
  joinmap_sic_orphans: {},
};

/** The templates gateway/templates.py marks onboarding_only (minutes-long DQ statements): the
 *  onboarding path runs them; the agent's question path refuses them (SPEC D2, D6). */
export const ONBOARDING_ONLY_TEMPLATES: readonly string[] = ["dq_invalid", "dq_run"];

export function isOnboardingOnly(templateId: string): boolean {
  return ONBOARDING_ONLY_TEMPLATES.includes(templateId);
}

/** Client-side bound per template id where the gateway sets its own bound (gateway/templates.py
 *  timeout_s), always a little longer than the gateway's so the gateway's reply arrives first:
 *  RUN DQ / SHOW DQ INVALID RECORD on a USL table whose parent is utility re-read the 43 submission
 *  views (72 to 151 s measured; bound 900 s). Other templates use GatewayClientOptions.timeoutMs. */
export const TEMPLATE_TIMEOUT_MS: Record<string, number> = {
  dq_run: 930_000,
  dq_invalid: 930_000,
};

/** Parameter kinds per registrar action, mirroring gateway/templates.py REGISTRAR_PLANS. Each
 *  plan runs raw REST table -> flattened view -> DESCRIBE -> CACHE under one signed contract
 *  (the two CREATEs treat "already exists" as done, so re-registering only re-caches). */
export const REGISTRAR_PARAMS: Record<string, Record<string, ParamKind>> = {
  register_frames: { tag: "tag", period: "period" },
  register_concept: { cik10: "cik10", tag: "tag" },
  register_submission: { cik10: "cik10" },
  register_fema: { quarter: "fema_quarter" },
  register_stations: {},
  register_ghcn: { year: "year", element: "element" },
};

/** register_source: a seeds/catalogue.json entry id -> the registrar plan the gateway dispatches it to
 *  (gateway/templates.py SOURCE_PLANS). The contract names action "register_source" with parameters
 *  { catalogue_id, ...the plan's parameters }; an object that already exists answers already_registered. */
export const REGISTER_SOURCE_ACTION = "register_source";
export const SOURCE_PLANS: Record<string, string> = {
  openfema_disaster_declarations: "register_fema",
  noaa_ghcn_stations: "register_stations",
  sec_frames: "register_frames",
  sec_submissions: "register_submission",
  noaa_ghcn_by_year: "register_ghcn",
};

export function validateSourceParams(catalogueId: string, params: Record<string, string>): string {
  validateParam("catalogue_id", catalogueId);
  const action = SOURCE_PLANS[catalogueId];
  if (!action) throw new BadParams(`catalogue entry ${catalogueId} cannot be registered (no registrar plan)`);
  validateRegistrarParams(action, params);
  return action;
}

export class BadParams extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadParams";
  }
}

export function validateParam(kind: ParamKind, value: string): string {
  if (typeof value !== "string" || !PARAM_PATTERNS[kind].test(value)) {
    throw new BadParams(`invalid ${kind}: ${JSON.stringify(String(value).slice(0, 40))}`);
  }
  return value;
}

function validateParams(kinds: Record<string, ParamKind> | undefined, params: Record<string, string>, what: string): void {
  if (!kinds) throw new BadParams(`unknown ${what}`);
  const extra = Object.keys(params).filter((k) => !(k in kinds));
  const missing = Object.keys(kinds).filter((k) => !(k in params));
  if (extra.length || missing.length) {
    throw new BadParams(`${what} takes [${Object.keys(kinds).join(", ")}]; missing [${missing}], unexpected [${extra}]`);
  }
  for (const [name, kind] of Object.entries(kinds)) validateParam(kind, params[name]!);
}

export function validateTemplateParams(templateId: string, params: Record<string, string>): void {
  validateParams(TEMPLATE_PARAMS[templateId], params, `template ${templateId}`);
}

export function validateRegistrarParams(action: string, params: Record<string, string>): void {
  validateParams(REGISTRAR_PARAMS[action], params, `registrar action ${action}`);
}

export function rowsAsObjects(res: Pick<TemplateResponse, "columns" | "rows">): Record<string, unknown>[] {
  return res.rows.map((r) => Object.fromEntries(res.columns.map((c, i) => [c, r[i] ?? null])));
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
let refusedGatewayHosts = 0;

/** Attempts to reach a non-loopback gateway host since the process started. */
export function refusedGatewayHostAttempts(): number {
  return refusedGatewayHosts;
}

export interface GatewayClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Client-side bound per request; the gateway bounds each query at 60 s itself. */
  timeoutMs?: number;
  /** Registrar plans CACHE parquet views; their client-side bound is longer. */
  registrarTimeoutMs?: number;
  /** How many HTTP 503 "warming" replies to wait out, and how long between them. */
  warmRetries?: number;
  warmDelayMs?: number;
}

export class GatewayClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly registrarTimeoutMs: number;
  private readonly warmRetries: number;
  private readonly warmDelayMs: number;

  constructor(opts: GatewayClientOptions = {}) {
    const base = new URL(opts.baseUrl ?? process.env.GATEWAY_URL ?? DEFAULT_GATEWAY_URL);
    if (!LOOPBACK_HOSTS.has(base.hostname)) {
      refusedGatewayHosts++;
      throw new GatewayError(`refusing non-local gateway host ${base.hostname}`, 0);
    }
    this.baseUrl = base.origin;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.registrarTimeoutMs = opts.registrarTimeoutMs ?? 900_000;
    this.warmRetries = opts.warmRetries ?? 6;
    this.warmDelayMs = opts.warmDelayMs ?? 10_000;
  }

  async health(): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(30_000) });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new GatewayError(`gateway /health HTTP ${res.status}`, res.status, body as Partial<TemplateResponse>);
    return body;
  }

  /** Runs one named reader template. Throws GatewayError on any non-200 reply (after waiting out warm-up 503s). */
  async template(templateId: string, params: Record<string, string> = {}, role: Role = "reader"): Promise<TemplateResult> {
    validateTemplateParams(templateId, params);
    let warm = 0;
    for (;;) {
      const started = performance.now();
      const res = await this.fetchImpl(`${this.baseUrl}/sql/template`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ template_id: templateId, params, role }),
        signal: AbortSignal.timeout(TEMPLATE_TIMEOUT_MS[templateId] ?? this.timeoutMs),
      });
      const wall = performance.now() - started;
      let body: TemplateResponse;
      try {
        body = (await res.json()) as TemplateResponse;
      } catch {
        throw new GatewayError(`gateway ${templateId}: non-JSON reply (HTTP ${res.status})`, res.status);
      }
      if (res.status === 503 && String(body.error ?? "").startsWith("warming") && warm < this.warmRetries) {
        warm++;
        await new Promise((r) => setTimeout(r, this.warmDelayMs));
        continue;
      }
      if (res.status !== 200 || body.error) {
        throw new GatewayError(`gateway ${templateId} HTTP ${res.status}: ${String(body.error ?? "").slice(0, 300)}`, res.status, body);
      }
      return { ...body, params, http_status: res.status, wall_ms: Math.round(wall), warm_retries: warm };
    }
  }

  /**
   * Runs one registrar plan (POST /registrar/<action>) under a signed execution contract
   * (agent/src/contract/scout.ts). The contract names the same action and parameters; the
   * gateway refuses anything else and never accepts a contract twice. Throws GatewayError on
   * any non-200 reply, with the steps that ran so far in `response`.
   */
  async registrar(action: string, params: Record<string, string>, contract: Record<string, unknown>): Promise<RegistrarResult> {
    validateRegistrarParams(action, params);
    return this.postRegistrar(action, params, contract);
  }

  /**
   * register_source(catalogue_id, params): the gateway dispatches the catalogue entry to its registrar plan
   * (SOURCE_PLANS) under a contract for action "register_source" whose parameters are
   * { catalogue_id, ...params }. Idempotent: an existing view answers already_registered: true.
   */
  async registerSource(catalogueId: string, params: Record<string, string>, contract: Record<string, unknown>): Promise<RegistrarResult> {
    validateSourceParams(catalogueId, params);
    return this.postRegistrar(REGISTER_SOURCE_ACTION, { catalogue_id: catalogueId, ...params }, contract);
  }

  private async postRegistrar(action: string, params: Record<string, string>, contract: Record<string, unknown>): Promise<RegistrarResult> {
    const started = performance.now();
    const res = await this.fetchImpl(`${this.baseUrl}/registrar/${encodeURIComponent(action)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...params, contract }),
      signal: AbortSignal.timeout(this.registrarTimeoutMs),
    });
    const wall = performance.now() - started;
    let body: RegistrarResponse;
    try {
      body = (await res.json()) as RegistrarResponse;
    } catch {
      throw new GatewayError(`gateway registrar ${action}: non-JSON reply (HTTP ${res.status})`, res.status);
    }
    if (res.status !== 200 || body.error) {
      throw new GatewayError(`gateway registrar ${action} HTTP ${res.status}: ${String(body.error ?? "").slice(0, 300)}`, res.status, body);
    }
    return { ...body, http_status: res.status, wall_ms: Math.round(wall) };
  }
}
