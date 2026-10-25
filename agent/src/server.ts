// Crosswalk agent server: the HTTP API for the analyst UI, server-sent events on
// /api/events and the static UI files (ui/), on 127.0.0.1 only (UI_PORT, default 8804).
//
// Safety:
// - The server holds one runtime for its lifetime (it takes <data>/agent.lock) and runs one
//   model job at a time: POST /api/ask answers 202 {run_id} or 409 {busy_run_id}.
// - The analyst's override of a recast resolution runs only through POST /api/override with a
//   signed high-risk contract (POST /api/approvals/sign issues it for the local demo identity
//   "analyst"; a real deployment needs SSO). Without a valid contract the reply is 403, the
//   refusal is logged in <data>/contracts/verifier-server.jsonl and nothing is written.
// - Requests must name this server as Host (DNS rebinding) and, for writes, come with a JSON
//   body and no foreign Origin (cross-site requests).
// - Static files come from ui/ only: parent, absolute and drive paths are refused.
//
//   npx tsx src/server.ts            (npm run dev)
//
// Adapted from Weather-or-Not and ClearShelf (same author, Apache-2.0).

import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DATA_DIR, DATA_PATHS, loadConfig, REPO_ROOT_URL } from "./config.ts";
import { analystApproval, APPROVAL_SURFACE, APPROVER, ContractError, ContractVerifier, loadContractSecret, type RecastSide } from "./contract/scout.ts";
import { newRunId, type EvidenceRecord } from "./evidence/store.ts";
import type { LoopEvent } from "./loop/generator.ts";
import type { RunResult } from "./loop/investigate.ts";
import { num, pct } from "./loop/tools.ts";
import type { SavedRun } from "./ops/runStore.ts";
import { ask as runAsk, openRuntime, type AskOutcome, type AskRequest, type Runtime } from "./runtime.ts";
import { findUtility } from "./seeds.ts";
import { PARAM_PATTERNS } from "./zetaris/client.ts";

// ---------- events ----------

export interface BusEvent {
  id: number;
  type: string;
  at: string;
  data: Record<string, unknown>;
}

/** Server-sent events with a ring of the last `keep` events; a reconnect replays from Last-Event-ID. */
export class EventBus {
  private seq = 0;
  private readonly ring: BusEvent[] = [];
  private readonly clients = new Set<ServerResponse>();

  constructor(private readonly keep = 500) {}

  publish(type: string, data: Record<string, unknown>): BusEvent {
    const e: BusEvent = { id: ++this.seq, type, at: new Date().toISOString(), data };
    this.ring.push(e);
    if (this.ring.length > this.keep) this.ring.splice(0, this.ring.length - this.keep);
    for (const c of this.clients) EventBus.write(c, e);
    return e;
  }

  recent(after = 0): BusEvent[] {
    return this.ring.filter((e) => e.id > after);
  }

  private static write(res: ServerResponse, e: BusEvent): void {
    res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify({ ...e.data, at: e.at })}\n\n`);
  }

  attach(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write("retry: 3000\n\n");
    // Only a reconnect (Last-Event-ID) or an explicit ?since gets the missed events; a new
    // connection starts with what happens from now on.
    const since = req.headers["last-event-id"] ?? new URL(req.url ?? "/", "http://x").searchParams.get("since");
    if (since !== undefined && since !== null && since !== "") {
      const last = Number(since);
      for (const e of this.recent(Number.isFinite(last) ? last : 0)) EventBus.write(res, e);
    }
    this.clients.add(res);
    const beat = setInterval(() => res.write(`: keep-alive ${Date.now()}\n\n`), 15_000);
    req.on("close", () => {
      clearInterval(beat);
      this.clients.delete(res);
    });
  }

  get listeners(): number {
    return this.clients.size;
  }

  closeAll(): void {
    for (const c of this.clients) c.end();
    this.clients.clear();
  }
}

// ---------- server ----------

/** What the routes need from the runtime (runtime.ts); tests pass a mock. */
export type ServerRuntime = Pick<Runtime, "gateway" | "ollama" | "hmem" | "world" | "runs" | "seeds">;

export type AskFn = (rt: ServerRuntime, req: AskRequest, origin: { source: "server"; note?: string }) => Promise<AskOutcome>;

export interface ServerDeps {
  runtime: ServerRuntime;
  /** The question runner (runtime.ts ask); tests pass a stub. */
  ask?: AskFn;
  /** Verifies and issues override contracts; default: the agent's secret, ledger under <data>/contracts (verifier-server.jsonl, used-server.jsonl). */
  verifier?: ContractVerifier;
  bus?: EventBus;
  /** ui/ directory to serve; null serves no files. */
  uiDir?: string | null;
  /** <data>/eval/report.json for GET /api/eval; null serves none. */
  evalReport?: string | null;
  /** <data>/evidence/ for records a saved run does not carry inline; null reads none. */
  evidenceDir?: string | null;
  log?: (line: string) => void;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = "error",
  ) {
    super(message);
  }
}

const MAX_BODY = 256 * 1024;
const RUN_ID = /^r\d{8}T\d{6}[0-9a-f]{4}$/u;
const EV_ID = /^ev-r\d{8}T\d{6}[0-9a-f]{4}-\d{2,4}$/u;
const MEM_ID = /^mem-\d{1,9}$/u;
const CONFLICT_ID = /^rc-[0-9a-f]{12}$/u;
const CIK = /^\d{1,10}$/u;
const SIDES: readonly RecastSide[] = ["own_filing", "later_filing"];
const OVERRIDE_PARAMS = ["conflict_id", "chosen", "reason"] as const;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, text: string, contentType: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const ct = String(req.headers["content-type"] ?? "");
  if (!ct.toLowerCase().startsWith("application/json")) throw new HttpError(415, "send a JSON body (content-type: application/json)", "content_type");
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY) throw new HttpError(413, "body too large", "too_large");
    chunks.push(c as Buffer);
  }
  if (!n) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "body is not a JSON object", "bad_json");
  }
}

function s(v: unknown, name: string, required = true): string {
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, `${name} is required`, "missing_field");
    return "";
  }
  if (typeof v !== "string") throw new HttpError(400, `${name} must be a string`, "bad_field");
  return v;
}

/** The override_recast parameters (D4): conflict_id, chosen, reason; nothing else. */
function overrideParamErrors(params: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of OVERRIDE_PARAMS) if (typeof params[k] !== "string" || params[k] === "") out.push(`${k} is required`);
  if (typeof params.conflict_id === "string" && !CONFLICT_ID.test(params.conflict_id)) out.push("conflict_id is not a recast conflict id (rc-<12 hex>)");
  if (typeof params.chosen === "string" && !(SIDES as readonly string[]).includes(params.chosen)) out.push(`chosen must be ${SIDES.join(" or ")}`);
  if (typeof params.reason === "string" && params.reason.trim().length === 0) out.push("reason is empty");
  for (const k of Object.keys(params)) if (!(OVERRIDE_PARAMS as readonly string[]).includes(k)) out.push(`unexpected parameter ${k}`);
  return out;
}

function cell(v: unknown): string {
  return String(v ?? "").replace(/\r?\n/gu, " ").replace(/\|/gu, "\\|");
}

/**
 * The saved memo as markdown: the verdict, the memo text, the attribution ranges, the
 * card's cited claims, the Not-tested list, the recast conflicts, then a citations table with
 * every evidence id of the run, its Zetaris object, endpoint, retrieval time and latency.
 */
export function renderMemoMarkdown(run: RunResult | SavedRun, records: EvidenceRecord[] = run.evidence ?? []): string {
  const c = run.card;
  const out: string[] = [];
  out.push(`# Crosswalk note: ${run.quarter} vs ${run.previous_quarter}`);
  out.push("");
  out.push(`Run \`${run.run_id}\` (${run.mode}), started ${run.started_at}, ${run.wall_ms} ms wall, ${run.markovian.chunks} chunk(s); model ${run.telemetry.model ?? "none"}; note ${run.memo ? `${run.memo.source}, ${run.memo.words} words` : "none"}.`);
  out.push("");
  out.push(`**Question.** ${run.question}`);
  out.push("");
  out.push("## Note");
  out.push("");
  out.push(run.memo?.text ?? "_No note was written for this run._");
  out.push("");
  out.push("## Join map");
  out.push("");
  out.push("| Key | Left | Right | Transform | Matched / left | Rate | Verdict | Orphans |");
  out.push("|---|---|---|---|---|---|---|---|");
  for (const k of run.join_map) out.push(`| ${cell(k.key)} | ${cell(k.left)} | ${cell(k.right)} | ${cell(k.transform)} | ${k.matched_rows ?? "?"} / ${k.left_rows ?? "?"} | ${k.rate === null ? "n/a" : num(k.rate, 3)} | ${cell(k.verdict ?? k.status)}${k.from_memory ? " (recalled)" : ""} | ${cell(k.orphans.join("; "))} |`);
  out.push("");
  if (run.answer) {
    out.push("## Answer");
    out.push("");
    for (const r of run.answer.rows) out.push(`- ${r.name}${r.ticker ? ` (${r.ticker})` : ""}: ${r.declarations} declaration(s) in ${r.states.map((s) => s.state).join(", ")}; revenue ${r.revenue?.change !== null && r.revenue?.change !== undefined ? `${pct(r.revenue.change)} under ${r.revenue.tag}` : `not compared (${r.revenue?.note ?? r.revenue_note ?? "n/a"})`}${r.weather ? `; degree days ${pct(r.weather.change)}` : ""}`);
    out.push("");
  }
  if (c.claims.length) {
    out.push("## Cited claims");
    out.push("");
    for (const k of c.claims) out.push(`- ${k.text} [${k.evidenceIds.join(", ") || "no evidence"}]`);
    out.push("");
  }
  out.push("## Not tested");
  out.push("");
  if (run.not_tested.length) for (const n of run.not_tested) out.push(`- ${n}`);
  else out.push("- (none listed)");
  out.push("");
  if (c.gaps.length) {
    out.push("## Gaps");
    out.push("");
    for (const g of c.gaps) out.push(`- ${g}`);
    out.push("");
  }
  out.push("## Citations");
  out.push("");
  out.push(`Every number above comes from one of these ${records.length} evidence records of run \`${run.run_id}\` (E-cov ${num(run.quality.e_cov, 2)}, E-complete ${num(run.quality.e_complete, 2)}).`);
  out.push("");
  out.push("| Evidence | Kind | Template or tool | Zetaris object | Endpoint | Retrieved | Latency | SQL sha256 |");
  out.push("|---|---|---|---|---|---|---|---|");
  for (const e of records) {
    const what = e.template_id ?? (e.kind === "model" ? e.model?.name ?? "model" : (e.derived_from?.length ? `from ${e.derived_from.join(", ")}` : e.kind));
    out.push(`| ${cell(e.id)} | ${cell(e.kind)} | ${cell(what)} | ${cell(e.zetaris_object ?? "")} | ${cell(e.source_url ?? "")} | ${cell(e.queried_at)} | ${e.elapsed_ms === undefined ? "" : `${e.elapsed_ms} ms`} | ${cell(e.sql_sha256 ? e.sql_sha256.slice(0, 12) : "")} |`);
  }
  const licences = [...new Set(records.map((e) => e.licence).filter((x): x is string => !!x))];
  if (licences.length) {
    out.push("");
    out.push("Licences of the sources read:");
    out.push("");
    for (const l of licences) out.push(`- ${l}`);
  }
  out.push("");
  return out.join("\n");
}

export interface CwServer {
  server: http.Server;
  bus: EventBus;
  /** The run in progress, or null. */
  readonly busy: string | null;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

export function createServer(deps: ServerDeps): CwServer {
  const rt = deps.runtime;
  const bus = deps.bus ?? new EventBus();
  const log = deps.log ?? (() => {});
  const askFn: AskFn = deps.ask ?? (runAsk as unknown as AskFn);
  const uiDir = deps.uiDir === undefined ? fileURLToPath(new URL("ui/", REPO_ROOT_URL)) : deps.uiDir;
  const evalReport = deps.evalReport === undefined ? DATA_PATHS.evalReport : deps.evalReport;
  const evidenceDir = deps.evidenceDir === undefined ? DATA_PATHS.evidence : deps.evidenceDir;
  let verifier: ContractVerifier | null = deps.verifier ?? null;
  const verifierOf = (): ContractVerifier => {
    // The secret is read on first use, so a server without .env.local still serves reads.
    if (!verifier) verifier = new ContractVerifier(loadContractSecret(), "server", DATA_PATHS.contracts);
    return verifier;
  };
  let port = 0;
  let busy: string | null = null;

  function hostOk(req: IncomingMessage): boolean {
    const h = String(req.headers.host ?? "").toLowerCase();
    return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  }

  function originOk(req: IncomingMessage): boolean {
    const o = req.headers.origin;
    if (!o) return true;
    return o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
  }

  function runOf(id: string): SavedRun {
    if (!RUN_ID.test(id)) throw new HttpError(400, "bad run id", "bad_id");
    const r = rt.runs.load(id);
    if (!r) throw new HttpError(404, `no saved run ${id}`, "not_found");
    return r;
  }

  /** The run's evidence: inline in run.json, else the evidence file of the run. */
  function evidenceOf(run: SavedRun): EvidenceRecord[] {
    if (Array.isArray(run.evidence) && run.evidence.length) return run.evidence;
    if (!evidenceDir) return [];
    const p = `${evidenceDir.replace(/[\\/]$/u, "")}/${run.run_id}.jsonl`;
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as EvidenceRecord);
  }

  function finishedSummary(r: RunResult): Record<string, unknown> {
    return {
      run_id: r.run_id,
      quarter: r.quarter,
      mode: r.mode,
      question: r.question,
      utilities: r.answer?.rows.length ?? 0,
      keys: r.join_map.length,
      wall_ms: r.wall_ms,
      chunks: r.markovian.chunks,
      checklist_complete: r.checklist_complete,
      memo_source: r.memo?.source ?? null,
      memo_words: r.memo?.words ?? null,
      skipped_chunks: r.telemetry.skipped_chunks,
      skipped_steps: r.skipped_steps.length,
      evidence_records: r.evidence_ids.length,
      memory_ids: r.memory?.ids ?? [],
    };
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const p = url.pathname;
    const m = req.method ?? "GET";
    if (m !== "GET" && m !== "HEAD" && !originOk(req)) throw new HttpError(403, "cross-origin request refused", "origin");

    if (m === "GET" && p === "/api/events") return bus.attach(req, res);

    if (m === "GET" && p === "/api/health") {
      let gatewayOk = false;
      let gatewayTemplates: number | null = null;
      let gatewayError: string | null = null;
      try {
        const h = await rt.gateway.health();
        gatewayOk = h.ok === true;
        gatewayTemplates = Array.isArray(h.templates) ? h.templates.length : null;
      } catch (e) {
        gatewayError = (e as Error).message.slice(0, 200);
      }
      return send(res, 200, {
        ok: true,
        service: "crosswalk-agent",
        model: rt.ollama?.model ?? null,
        gateway: rt.gateway.baseUrl,
        gateway_ok: gatewayOk,
        gateway_templates: gatewayTemplates,
        gateway_error: gatewayError,
        runs: rt.runs.list().length,
        data_dir: DATA_DIR,
        busy_run_id: busy,
        sse_listeners: bus.listeners,
      });
    }

    if (m === "POST" && p === "/api/ask") {
      const b = await readJson(req);
      const quarter = s(b.quarter, "quarter");
      if (!PARAM_PATTERNS.fema_quarter.test(quarter)) throw new HttpError(400, "quarter must look like CY2025Q1", "bad_quarter");
      const mode = b.mode === "cold" ? "cold" : "warm";
      let maxChunks: number | undefined;
      if (b.max_chunks !== undefined && b.max_chunks !== null && b.max_chunks !== "") {
        const n = Number(b.max_chunks);
        if (!Number.isInteger(n) || n < 1 || n > 12) throw new HttpError(400, "max_chunks must be an integer from 1 to 12", "bad_field");
        maxChunks = n;
      }
      const think = typeof b.think === "boolean" ? b.think : undefined;
      if (busy) return send(res, 409, { error: `a run is in progress (${busy}); one model job at a time`, code: "busy", busy_run_id: busy });
      const runId = newRunId();
      busy = runId;
      const startedAt = new Date().toISOString();
      bus.publish("run_started", { run_id: runId, quarter, mode, max_chunks: maxChunks ?? null, think: think ?? null, started_at: startedAt });
      log(`run ${runId} started: ${quarter} ${mode}`);
      void (async () => {
        try {
          const o = await askFn(rt, { quarter, mode, maxChunks, think, runId, onEvent: (e: LoopEvent) => bus.publish(e.type, { ...e, run_id: runId }) }, { source: "server" });
          const summary = finishedSummary(o.result);
          if (o.result.run_id !== runId) summary.announced_run_id = runId;
          bus.publish("run_finished", summary);
          log(`run ${o.result.run_id} finished in ${o.result.wall_ms} ms, ${o.result.markovian.chunks} chunk(s)`);
        } catch (e) {
          const error = (e as Error).message.slice(0, 500);
          log(`run ${runId} failed: ${error}`);
          bus.publish("run_failed", { run_id: runId, quarter, mode, error });
        } finally {
          busy = null;
        }
      })();
      return send(res, 202, { run_id: runId, quarter, mode, started_at: startedAt, state: "running" });
    }

    if (m === "GET" && p === "/api/runs") return send(res, 200, { runs: rt.runs.list(), busy_run_id: busy });

    if (m === "GET" && p === "/api/seeds") {
      return send(res, 200, {
        utilities: rt.seeds.utilities.map((u) => ({ cik: u.cik, name: u.name, ticker: u.ticker, sic: u.sic, hq_state: u.hq_state, states_served: u.states_served, station_ids: u.station_ids, flags: u.flags })),
      });
    }

    const rm = /^\/api\/run\/([^/]+)$/u.exec(p);
    if (m === "GET" && rm) return send(res, 200, runOf(rm[1]!));

    const rmm = /^\/api\/run\/([^/]+)\/memo\.md$/u.exec(p);
    if (m === "GET" && rmm) {
      const run = runOf(rmm[1]!);
      return sendText(res, 200, renderMemoMarkdown(run, evidenceOf(run)), MIME[".md"]!, { "content-disposition": `inline; filename="${run.run_id}-memo.md"` });
    }

    const rme = /^\/api\/run\/([^/]+)\/evidence(?:\/([^/]+))?$/u.exec(p);
    if (m === "GET" && rme) {
      const run = runOf(rme[1]!);
      const recs = evidenceOf(run);
      if (rme[2] === undefined) return send(res, 200, { run_id: run.run_id, records: recs });
      if (!EV_ID.test(rme[2])) throw new HttpError(400, "bad evidence id", "bad_id");
      const one = recs.find((r) => r.id === rme[2]);
      if (!one) throw new HttpError(404, `no evidence record ${rme[2]} in run ${run.run_id}`, "not_found");
      return send(res, 200, one);
    }

    const wy = /^\/api\/why\/([^/]+)$/u.exec(p);
    if (m === "GET" && wy) {
      if (!MEM_ID.test(wy[1]!)) throw new HttpError(400, "bad memory id (mem-N)", "bad_id");
      const t = rt.hmem.why(wy[1]!);
      if (!t.memory) throw new HttpError(404, `no memory ${wy[1]}`, "not_found");
      return send(res, 200, { memory_id: wy[1], ...t });
    }

    if (m === "GET" && p === "/api/conflicts") return send(res, 200, { conflicts: [] });

    if (m === "GET" && p === "/api/world") {
      const g = rt.world.exportGraph();
      const full = url.searchParams.get("full") === "1";
      return send(res, 200, { entities: g.byType, edges: g.edgeTypes, events: g.events, nodes_total: g.nodes.length, edges_total: g.edges.length, ...(full ? { graph: { nodes: g.nodes, edges: g.edges } } : {}) });
    }

    const wc = /^\/api\/world\/([^/]+)$/u.exec(p);
    if (m === "GET" && wc) {
      if (!CIK.test(wc[1]!)) throw new HttpError(400, "bad cik", "bad_cik");
      const cik = wc[1]!.padStart(10, "0");
      const history = rt.world.utilityHistory(cik);
      if (!history.length) throw new HttpError(404, `no utility with CIK ${cik} in the World Model`, "not_found");
      return send(res, 200, { cik, history });
    }

    if (m === "GET" && p === "/api/telemetry") {
      const list = rt.runs.list();
      const latest = list[0] ? rt.runs.load(list[0].run_id) : null;
      return send(res, 200, {
        model: rt.ollama?.model ?? null,
        runs: list.length,
        busy_run_id: busy,
        run_id: latest?.run_id ?? null,
        quarter: latest?.quarter ?? null,
        mode: latest?.mode ?? null,
        started_at: latest?.started_at ?? null,
        wall_ms: latest?.wall_ms ?? null,
        chunks: latest?.markovian.chunks ?? null,
        summary: latest?.summary ?? null,
        telemetry: latest?.telemetry ?? null,
        chart: latest?.chart ?? [],
        skipped_steps: latest?.skipped_steps ?? [],
      });
    }

    if (m === "GET" && p === "/api/eval") {
      if (!evalReport || !existsSync(evalReport)) throw new HttpError(404, "no evaluation report yet (eval/report.json under the data directory)", "not_found");
      let body: unknown;
      try {
        body = JSON.parse(readFileSync(evalReport, "utf8"));
      } catch (e) {
        throw new HttpError(500, `evaluation report is not valid JSON: ${(e as Error).message.slice(0, 120)}`, "bad_report");
      }
      return send(res, 200, { file: "eval/report.json", updated_at: new Date(statSync(evalReport).mtimeMs).toISOString(), report: body });
    }

    if (m === "POST" && p === "/api/approvals/sign") {
      const b = await readJson(req);
      const action = s(b.action, "action");
      if (action !== "override_recast") throw new HttpError(400, "action must be override_recast (the only high-risk action)", "bad_action");
      const raw = b.params;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "params must be an object of strings", "bad_field");
      const params = raw as Record<string, unknown>;
      const errors = overrideParamErrors(params);
      if (errors.length) throw new HttpError(400, `override_recast parameters: ${errors.join("; ")}`, "bad_params");
      const parameters = { conflict_id: params.conflict_id as string, chosen: params.chosen as string, reason: (params.reason as string).trim() };
      try {
        const contract = verifierOf().issue({ action: "override_recast", parameters, user: APPROVER, surface: APPROVAL_SURFACE, approvals: [analystApproval(parameters.reason)], flags: ["analyst_override"] });
        log(`contract ${contract.contractId} signed for override_recast ${parameters.conflict_id} -> ${parameters.chosen} (expires ${contract.expiresAt})`);
        return send(res, 200, { contract, expires_at: contract.expiresAt });
      } catch (e) {
        if (e instanceof ContractError) throw new HttpError(400, e.message, "contract");
        throw e;
      }
    }

    if (m === "POST" && p === "/api/override") {
      const b = await readJson(req);
      const params = { conflict_id: s(b.conflict_id, "conflict_id"), chosen: s(b.chosen, "chosen"), reason: s(b.reason, "reason").trim() };
      const errors = overrideParamErrors(params);
      if (errors.length) throw new HttpError(400, `override_recast parameters: ${errors.join("; ")}`, "bad_params");
      // Every verification, accepted or refused, lands in <data>/contracts/verifier-server.jsonl.
      const v = verifierOf().verify(b.contract, { action: "override_recast", params });
      if (!v.ok) {
        log(`override of ${params.conflict_id} refused (${v.code}): ${v.reason}`);
        throw new HttpError(403, `refused: ${v.reason}`, v.code);
      }
      // Crosswalk keeps no recast conflicts (the inherited route stays until the Day-2 server rewrite).
      throw new HttpError(404, `no recast conflict ${params.conflict_id}`, "not_found");
    }

    if (p.startsWith("/api/")) throw new HttpError(404, `no route ${m} ${p}`, "not_found");

    // ---- static UI ----
    if ((m === "GET" || m === "HEAD") && uiDir) {
      const root = resolve(uiDir);
      let rel: string;
      try {
        rel = decodeURIComponent(p === "/" ? "/index.html" : p);
      } catch {
        throw new HttpError(400, "bad path encoding", "bad_path");
      }
      // Parent segments, drive or scheme separators, backslashes and network paths never leave ui/.
      if (rel.includes("\0") || rel.includes("..") || rel.includes(":") || rel.includes("\\") || rel.startsWith("//")) throw new HttpError(403, "outside the UI directory", "forbidden");
      const file = resolve(root, `.${rel}`);
      if (!file.startsWith(root + sep)) throw new HttpError(403, "outside the UI directory", "forbidden");
      if (existsSync(file) && statSync(file).isFile()) {
        res.writeHead(200, { "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        if (m === "HEAD") return void res.end();
        createReadStream(file).pipe(res);
        return;
      }
    }
    throw new HttpError(404, "not found", "not_found");
  }

  const server = http.createServer((req, res) => {
    if (!hostOk(req)) return send(res, 421, { error: "unknown Host; Crosswalk answers on 127.0.0.1 only", code: "host" });
    route(req, res).catch((e: unknown) => {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, code: e.code });
      log(`error ${req.method} ${req.url}: ${(e as Error).stack ?? e}`);
      if (!res.headersSent) send(res, 500, { error: (e as Error).message.slice(0, 300), code: "internal" });
      else res.end();
    });
  });

  return {
    server,
    bus,
    get busy() {
      return busy;
    },
    listen(p: number, host = "127.0.0.1"): Promise<number> {
      if (host !== "127.0.0.1" && host !== "localhost") throw new Error("Crosswalk listens on 127.0.0.1 only");
      return new Promise((ok, fail) => {
        server.once("error", fail);
        server.listen(p, host, () => {
          const a = server.address();
          port = typeof a === "object" && a ? a.port : p;
          ok(port);
        });
      });
    },
    close(): Promise<void> {
      bus.closeAll();
      return new Promise((ok) => server.close(() => ok()));
    },
  };
}

export async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = (l: string) => process.stderr.write(`${new Date().toISOString()} ${l}\n`);
  // One process holds <data>/hmem and <data>/world: the server takes <data>/agent.lock for its lifetime.
  const rt = openRuntime({ command: "server", log });
  const app = createServer({ runtime: rt, log });
  let bound: number;
  try {
    bound = await app.listen(cfg.uiPort);
  } catch (e) {
    rt.close();
    throw e;
  }
  log(`Crosswalk agent server on http://127.0.0.1:${bound} (pid ${process.pid}; gateway ${rt.gateway.baseUrl}; model ${rt.ollama?.model ?? "none"}; data ${DATA_DIR}; ${rt.runs.list().length} saved run(s))`);
  const stop = () => {
    void app.close();
    rt.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url.toLowerCase() === pathToFileURL(resolve(process.argv[1])).href.toLowerCase()) {
  main().catch((e) => {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  });
}
