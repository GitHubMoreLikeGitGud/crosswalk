// Crosswalk agent server: the HTTP API for the analyst UI, server-sent events and the static UI
// files (ui/), on 127.0.0.1 only (UI_PORT, default 8804).
//
// Routes (SPEC D20; all JSON unless noted, errors are {error, code}):
//   GET  /api/health                  model, gateway reachability, saved runs, busy run
//   POST /api/ask                     {quarter, mode?, max_chunks?, think?} -> 202 {run_id} | 409 {busy_run_id}
//   GET  /api/events                  SSE: every live event of every run (Last-Event-ID / ?since replay the ring)
//   GET  /api/runs                    saved runs, newest first, plus the run in progress
//   GET  /api/runs/:id                one saved run (run.json; ?slim=1 leaves out evidence and call records)
//   GET  /api/runs/:id/events         SSE chunk stream of one run: live while it runs, else replayed from run.json (replay: true)
//   GET  /api/runs/:id/telemetry      footer telemetry of one run
//   GET  /api/runs/:id/memo.md        the note as markdown with its citations (text/markdown)
//   GET  /api/runs/:id/evidence       every evidence record of the run
//   GET  /api/telemetry               footer telemetry of the latest saved run
//   GET  /api/joinmap/:run            join map in canonical orientation, both rates, verdict definitions
//   GET  /api/answer/:run             answer table with a cell id per value
//   GET  /api/evidence/:run/:cell     provenance drawer of one cell (SQL, object, rows, ms, cache state and times)
//   GET  /api/usl                     governed USL, onboarding DQ file, the last live rules, invalid rows (?run= picks the run)
//   GET  /api/why/:memId, /api/world, /api/world/:cik, /api/eval, /api/seeds
//
// Safety:
// - The server holds one runtime for its lifetime (it takes <data>/agent.lock) and runs one model
//   job at a time.
// - Requests must name this server as Host (DNS rebinding). CORS is closed: no Access-Control
//   header is ever sent, a request carrying a foreign Origin or a cross-site Sec-Fetch-Site is
//   refused (any method), OPTIONS is refused, and writes need a JSON body.
// - Run ids, cell ids and memory ids are checked against fixed patterns before any lookup; static
//   files come from ui/ only (parent, absolute, drive and network paths are refused).
//
//   npx tsx src/server.ts            (npm run dev)
//
// Adapted from Weather-or-Not and ClearShelf (same author, Apache-2.0).

import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DATA_DIR, DATA_PATHS, loadConfig, REPO_ROOT, REPO_ROOT_URL } from "./config.ts";
import { newRunId, type EvidenceRecord } from "./evidence/store.ts";
import type { LoopEvent } from "./loop/generator.ts";
import { answerView, CELL_ID, cellEvidence } from "./ops/cells.ts";
import { canonicalRow, joinMapView } from "./ops/joinmap.ts";
import { finishedSummary, replayEvents, telemetryView, type StreamEvent } from "./ops/replay.ts";
import { asRun, type RunIn } from "./ops/runShape.ts";
import { DEMO_DQ_FILE, type SavedRun } from "./ops/runStore.ts";
import { sgt, seconds } from "./ops/time.ts";
import { readJsonFile, uslView, type DqFile, type UslPlanFile } from "./ops/usl.ts";
import { ask as runAsk, openRuntime, type AskOutcome, type AskRequest, type Runtime } from "./runtime.ts";
import { PARAM_PATTERNS } from "./zetaris/client.ts";

// ---------- events ----------

export interface BusEvent {
  id: number;
  type: string;
  at: string;
  data: Record<string, unknown>;
}

const TERMINAL = new Set(["run_finished", "run_failed"]);

interface Client {
  res: ServerResponse;
  runId: string | null;
}

/** Server-sent events with a ring of the last `keep` events; a reconnect replays from Last-Event-ID. */
export class EventBus {
  private seq = 0;
  private readonly ring: BusEvent[] = [];
  private readonly clients = new Set<Client>();

  constructor(private readonly keep = 500) {}

  publish(type: string, data: Record<string, unknown>): BusEvent {
    const e: BusEvent = { id: ++this.seq, type, at: new Date().toISOString(), data };
    this.ring.push(e);
    if (this.ring.length > this.keep) this.ring.splice(0, this.ring.length - this.keep);
    for (const c of this.clients) {
      if (c.runId !== null && e.data.run_id !== c.runId) continue;
      EventBus.write(c.res, e);
      if (c.runId !== null && TERMINAL.has(e.type)) {
        c.res.end();
        this.clients.delete(c);
      }
    }
    return e;
  }

  recent(after = 0, runId: string | null = null): BusEvent[] {
    return this.ring.filter((e) => e.id > after && (runId === null || e.data.run_id === runId));
  }

  /** True when the ring holds a run_finished or run_failed event of this run. */
  ended(runId: string): boolean {
    return this.ring.some((e) => e.data.run_id === runId && TERMINAL.has(e.type));
  }

  static write(res: ServerResponse, e: BusEvent): void {
    res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify({ ...e.data, at: e.at })}\n\n`);
  }

  static open(res: ServerResponse): void {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no", "x-content-type-options": "nosniff" });
    res.write("retry: 3000\n\n");
  }

  private hold(req: IncomingMessage, client: Client): void {
    this.clients.add(client);
    const beat = setInterval(() => client.res.write(": keep-alive\n\n"), 15_000);
    const drop = () => {
      clearInterval(beat);
      this.clients.delete(client);
    };
    req.on("close", drop);
    client.res.on("close", drop);
  }

  /** Every run's events. Only a reconnect (Last-Event-ID) or an explicit ?since gets missed events. */
  attach(req: IncomingMessage, res: ServerResponse): void {
    EventBus.open(res);
    const since = req.headers["last-event-id"] ?? new URL(req.url ?? "/", "http://x").searchParams.get("since");
    if (since !== undefined && since !== null && since !== "") {
      const last = Number(since);
      for (const e of this.recent(Number.isFinite(last) ? last : 0)) EventBus.write(res, e);
    }
    this.hold(req, { res, runId: null });
  }

  /** One live run's events from its start (or after Last-Event-ID); the stream ends with the run. */
  attachRun(req: IncomingMessage, res: ServerResponse, runId: string): void {
    EventBus.open(res);
    res.write(`event: stream\ndata: ${JSON.stringify({ run_id: runId, mode: "live", replay: false })}\n\n`);
    const raw = req.headers["last-event-id"];
    const last = raw === undefined ? 0 : Number(raw);
    const past = this.recent(Number.isFinite(last) ? last : 0, runId);
    for (const e of past) EventBus.write(res, e);
    if (past.some((e) => TERMINAL.has(e.type)) || this.ended(runId)) return void res.end();
    this.hold(req, { res, runId });
  }

  get listeners(): number {
    return this.clients.size;
  }

  closeAll(): void {
    for (const c of this.clients) c.res.end();
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
  bus?: EventBus;
  /** ui/ directory to serve; null serves no files. */
  uiDir?: string | null;
  /** <data>/eval/report.json for GET /api/eval; null serves none. */
  evalReport?: string | null;
  /** <data>/evidence/ for records a saved run does not carry inline; null reads none. */
  evidenceDir?: string | null;
  /** <data>/dq/latest.json (the onboarding DQ results); null reads none. */
  dqFile?: string | null;
  /** seeds/usl-plan.json (the governed USL); null reads none. */
  uslPlanFile?: string | null;
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
const MEM_ID = /^mem-\d{1,9}$/u;
const CIK = /^\d{1,10}$/u;
const MAX_REPLAY_DELAY_MS = 2000;
const LIVE_RULE_SCAN = 25;
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
const SLIM_DROP = ["evidence", "planner_calls", "tool_calls", "tool_calls_detail"] as const;

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

function s(v: unknown, name: string): string {
  if (v === undefined || v === null || v === "") throw new HttpError(400, `${name} is required`, "missing_field");
  if (typeof v !== "string") throw new HttpError(400, `${name} must be a string`, "bad_field");
  return v;
}

function cell(v: unknown): string {
  return String(v ?? "").replace(/\r?\n/gu, " ").replace(/\|/gu, "\\|");
}

const fix = (x: number | null | undefined, d: number) => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(d) : "n/a");
const signedPct = (x: number | null | undefined) => (typeof x === "number" && Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%` : "n/a");

/**
 * The saved note as markdown: the note, the join map (canonical orientation), the answer, the cited
 * claims, the Not-tested list, then a citations table with every evidence id of the run, its Zetaris
 * object, endpoint, retrieval time (SGT) and latency.
 */
export function renderMemoMarkdown(runIn: unknown, records?: EvidenceRecord[]): string {
  const run = runIn as RunIn & { card?: { claims?: { text: string; evidenceIds: string[] }[]; gaps?: string[] } };
  const recs = records ?? run.evidence ?? [];
  const out: string[] = [];
  out.push(`# Crosswalk note: ${run.quarter ?? "?"} vs ${run.previous_quarter ?? "?"}`);
  out.push("");
  out.push(`Run \`${run.run_id}\` (${run.mode ?? "?"}), started ${sgt(run.started_at) ?? "?"}, ${seconds(run.wall_ms) ?? "?"} s wall, ${run.markovian?.chunks ?? "?"} chunk(s); model ${run.telemetry?.model ?? "none"}; note ${run.memo ? `${run.memo.source}, ${run.memo.words} words` : "none"}.`);
  out.push("");
  out.push(`**Question.** ${run.question ?? ""}`);
  out.push("");
  out.push("## Note");
  out.push("");
  out.push(run.memo?.text ?? "_No note was written for this run._");
  out.push("");
  out.push("## Join map");
  out.push("");
  out.push("Left is the table whose rows are counted; rate = matched rows / left rows.");
  out.push("");
  out.push("| Key | Left | Right | Transform | Matched / left | Rate | Distinct | Verdict | Orphans |");
  out.push("|---|---|---|---|---|---|---|---|---|");
  for (const k of (run.join_map ?? []).map(canonicalRow)) {
    out.push(`| ${cell(k.key)} | ${cell(k.left.ref)} | ${cell(k.right.ref)} | ${cell(k.transform)} | ${k.matched_rows ?? "?"} / ${k.left_rows ?? "?"} | ${fix(k.rate, 3)} | ${k.matched_keys ?? "?"} / ${k.left_keys ?? "?"} | ${cell(k.verdict ?? k.status)}${k.recalled ? ` (recalled; measured as ${cell(k.measured_as)})` : ""} | ${cell(k.orphans.join("; "))} |`);
  }
  out.push("");
  if (run.answer?.rows?.length) {
    out.push("## Answer");
    out.push("");
    for (const r of run.answer.rows) {
      const rev = typeof r.revenue?.change === "number" ? `${signedPct(r.revenue.change)} under ${r.revenue.tag}` : `not compared (${r.revenue?.note ?? r.revenue_note ?? "n/a"})`;
      out.push(`- ${r.name}${r.ticker ? ` (${r.ticker})` : ""}: ${r.declarations ?? "?"} declaration(s) in ${(r.states ?? []).map((x) => x.state).join(", ")}; revenue ${rev}${r.weather ? `; degree days ${signedPct(r.weather.change)}` : ""}`);
    }
    out.push("");
  }
  const claims = run.card?.claims ?? [];
  if (claims.length) {
    out.push("## Cited claims");
    out.push("");
    for (const k of claims) out.push(`- ${k.text} [${k.evidenceIds.join(", ") || "no evidence"}]`);
    out.push("");
  }
  out.push("## Not tested");
  out.push("");
  if (run.not_tested?.length) for (const n of run.not_tested) out.push(`- ${n}`);
  else out.push("- (none listed)");
  out.push("");
  const gaps = run.card?.gaps ?? [];
  if (gaps.length) {
    out.push("## Gaps");
    out.push("");
    for (const g of gaps) out.push(`- ${g}`);
    out.push("");
  }
  out.push("## Citations");
  out.push("");
  out.push(`Every number above comes from one of these ${recs.length} evidence records of run \`${run.run_id}\`. Times are Singapore time (SGT).`);
  out.push("");
  out.push("| Evidence | Kind | Template or tool | Zetaris object | Endpoint | Retrieved | Latency | SQL sha256 |");
  out.push("|---|---|---|---|---|---|---|---|");
  for (const e of recs) {
    const what = e.template_id ?? (e.kind === "model" ? e.model?.name ?? "model" : e.derived_from?.length ? `from ${e.derived_from.join(", ")}` : e.kind);
    out.push(`| ${cell(e.id)} | ${cell(e.kind)} | ${cell(what)} | ${cell(e.zetaris_object ?? "")} | ${cell(e.source_url ?? "")} | ${cell(sgt(e.queried_at) ?? e.queried_at)} | ${e.elapsed_ms === undefined ? "" : `${e.elapsed_ms} ms`} | ${cell(e.sql_sha256 ? e.sql_sha256.slice(0, 12) : "")} |`);
  }
  const licences = [...new Set(recs.map((e) => e.licence).filter((x): x is string => !!x && x !== "none"))];
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

const DEFAULT_USL_PLAN = fileURLToPath(new URL("seeds/usl-plan.json", REPO_ROOT_URL));

export function createServer(deps: ServerDeps): CwServer {
  const rt = deps.runtime;
  const bus = deps.bus ?? new EventBus();
  const log = deps.log ?? (() => {});
  const askFn: AskFn = deps.ask ?? (runAsk as unknown as AskFn);
  const uiDir = deps.uiDir === undefined ? fileURLToPath(new URL("ui/", REPO_ROOT_URL)) : deps.uiDir;
  const evalReport = deps.evalReport === undefined ? DATA_PATHS.evalReport : deps.evalReport;
  const evidenceDir = deps.evidenceDir === undefined ? DATA_PATHS.evidence : deps.evidenceDir;
  const dqFile = deps.dqFile === undefined ? DATA_PATHS.dqLatest : deps.dqFile;
  const uslPlanFile = deps.uslPlanFile === undefined ? DEFAULT_USL_PLAN : deps.uslPlanFile;
  let port = 0;
  let busy: { run_id: string; quarter: string; mode: string; started_at: string } | null = null;

  function hostOk(req: IncomingMessage): boolean {
    const h = String(req.headers.host ?? "").toLowerCase();
    return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  }

  /** CORS closed: no foreign Origin and no cross-site fetch, for any method. */
  function originOk(req: IncomingMessage): boolean {
    if (String(req.headers["sec-fetch-site"] ?? "").toLowerCase() === "cross-site") return false;
    const o = req.headers.origin;
    if (!o) return true;
    return o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
  }

  function runOf(id: string): SavedRun {
    if (!RUN_ID.test(id)) throw new HttpError(400, "bad run id", "bad_id");
    const r = rt.runs.load(id);
    if (!r) throw new HttpError(404, busy?.run_id === id ? `run ${id} is still running` : `no saved run ${id}`, busy?.run_id === id ? "running" : "not_found");
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

  /** The latest saved run (index order) whose compile_usl ran the live DQ rules. */
  function latestLiveRulesRun(): RunIn | null {
    for (const e of rt.runs.list().slice(0, LIVE_RULE_SCAN)) {
      const r = rt.runs.load(e.run_id);
      if (r?.usl?.live_rules_run?.length) return asRun(r);
    }
    return null;
  }

  function streamReplay(req: IncomingMessage, res: ServerResponse, run: RunIn, delayMs: number): void {
    const events: StreamEvent[] = replayEvents(run);
    const raw = req.headers["last-event-id"];
    const last = raw === undefined ? 0 : Number(raw);
    EventBus.open(res);
    res.write(`event: stream\ndata: ${JSON.stringify({ run_id: run.run_id, mode: "replay", replay: true, events: events.length })}\n\n`);
    let i = Number.isFinite(last) && last > 0 ? last : 0;
    let closed = false;
    req.on("close", () => (closed = true));
    const writeNext = (): void => {
      if (closed) return;
      if (i >= events.length) return void res.end();
      const e = events[i]!;
      i += 1;
      res.write(`id: ${i}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
      if (delayMs > 0) setTimeout(writeNext, delayMs);
      else writeNext();
    };
    writeNext();
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const p = url.pathname;
    const m = req.method ?? "GET";
    if (!originOk(req)) throw new HttpError(403, "cross-origin request refused", "origin");
    if (m === "OPTIONS") throw new HttpError(405, "no cross-origin requests (CORS is closed)", "method");

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
        data_dir: process.env.CW_DATA_DIR ? "CW_DATA_DIR" : "default (data/ in the repository)",
        dq_file: !!dqFile && existsSync(dqFile),
        usl_plan: !!uslPlanFile && existsSync(uslPlanFile),
        ui: !!uiDir && existsSync(uiDir),
        busy_run_id: busy?.run_id ?? null,
        sse_listeners: bus.listeners,
      });
    }

    if (m === "POST" && p === "/api/ask") {
      const b = await readJson(req);
      const quarter = s(b.quarter, "quarter");
      if (!PARAM_PATTERNS.fema_quarter.test(quarter)) throw new HttpError(400, "quarter must look like CY2025Q1", "bad_quarter");
      if (b.mode !== undefined && b.mode !== "cold" && b.mode !== "warm") throw new HttpError(400, "mode must be cold or warm", "bad_field");
      const mode = b.mode === "cold" ? "cold" : "warm";
      let maxChunks: number | undefined;
      if (b.max_chunks !== undefined && b.max_chunks !== null && b.max_chunks !== "") {
        const n = Number(b.max_chunks);
        if (!Number.isInteger(n) || n < 1 || n > 12) throw new HttpError(400, "max_chunks must be an integer from 1 to 12", "bad_field");
        maxChunks = n;
      }
      const think = typeof b.think === "boolean" ? b.think : undefined;
      if (busy) return send(res, 409, { error: `a run is in progress (${busy.run_id}); one model job at a time`, code: "busy", busy_run_id: busy.run_id });
      const runId = newRunId();
      const startedAt = new Date().toISOString();
      busy = { run_id: runId, quarter, mode, started_at: startedAt };
      bus.publish("run_started", { run_id: runId, quarter, mode, max_chunks: maxChunks ?? null, think: think ?? null, started_at: startedAt, started_at_sgt: sgt(startedAt), replay: false });
      log(`run ${runId} started: ${quarter} ${mode}`);
      void (async () => {
        try {
          const o = await askFn(rt, { quarter, mode, maxChunks, think, runId, onEvent: (e: LoopEvent) => bus.publish(e.type, { ...e, run_id: runId, replay: false }) }, { source: "server" });
          const summary = finishedSummary(asRun(o.result));
          if (o.result.run_id !== runId) summary.announced_run_id = runId;
          busy = null;
          bus.publish("run_finished", { ...summary, run_id: runId, replay: false });
          log(`run ${o.result.run_id} finished in ${o.result.wall_ms} ms`);
        } catch (e) {
          const error = (e as Error).message.slice(0, 500);
          log(`run ${runId} failed: ${error}`);
          busy = null;
          bus.publish("run_failed", { run_id: runId, quarter, mode, error, replay: false });
        }
      })();
      return send(res, 202, { run_id: runId, quarter, mode, started_at: startedAt, started_at_sgt: sgt(startedAt), state: "running", events: `/api/runs/${runId}/events` });
    }

    if (m === "GET" && p === "/api/runs") {
      const runs = rt.runs.list().map((r) => ({ ...r, started_at_sgt: sgt(r.started_at), wall_s: seconds(r.wall_ms) }));
      return send(res, 200, { runs, running: busy ? { ...busy, started_at_sgt: sgt(busy.started_at) } : null, busy_run_id: busy?.run_id ?? null });
    }

    if (m === "GET" && p === "/api/telemetry") {
      const list = rt.runs.list();
      const latest = list[0] ? rt.runs.load(list[0].run_id) : null;
      return send(res, 200, { model: rt.ollama?.model ?? null, runs: list.length, busy_run_id: busy?.run_id ?? null, latest: latest ? telemetryView(asRun(latest)) : null });
    }

    let mt = /^\/api\/runs\/([^/]+)(?:\/(events|telemetry|memo\.md|evidence))?$/u.exec(p);
    if (m === "GET" && mt) {
      const id = mt[1]!;
      const sub = mt[2];
      if (!RUN_ID.test(id)) throw new HttpError(400, "bad run id", "bad_id");
      if (sub === "events") {
        if (busy?.run_id === id || (bus.recent(0, id).length && !rt.runs.load(id))) return bus.attachRun(req, res, id);
        const run = runOf(id);
        const d = Number(url.searchParams.get("delay_ms") ?? 0);
        if (!Number.isInteger(d) || d < 0 || d > MAX_REPLAY_DELAY_MS) throw new HttpError(400, `delay_ms must be an integer from 0 to ${MAX_REPLAY_DELAY_MS}`, "bad_field");
        return streamReplay(req, res, asRun(run), d);
      }
      if (sub === undefined && busy?.run_id === id && !rt.runs.load(id)) return send(res, 202, { run_id: id, state: "running", events: `/api/runs/${id}/events` });
      const run = runOf(id);
      if (sub === "telemetry") return send(res, 200, telemetryView(asRun(run)));
      if (sub === "memo.md") return sendText(res, 200, renderMemoMarkdown(run, evidenceOf(run)), MIME[".md"]!, { "content-disposition": `inline; filename="${run.run_id}-memo.md"` });
      if (sub === "evidence") return send(res, 200, { run_id: run.run_id, records: evidenceOf(run) });
      if (url.searchParams.get("slim") === "1") {
        const slim: Record<string, unknown> = { ...run };
        for (const k of SLIM_DROP) delete slim[k];
        return send(res, 200, slim);
      }
      return send(res, 200, run);
    }

    mt = /^\/api\/joinmap\/([^/]+)$/u.exec(p);
    if (m === "GET" && mt) return send(res, 200, joinMapView(asRun(runOf(mt[1]!))));

    mt = /^\/api\/answer\/([^/]+)$/u.exec(p);
    if (m === "GET" && mt) return send(res, 200, answerView(asRun(runOf(mt[1]!))));

    mt = /^\/api\/evidence\/([^/]+)\/([^/]+)$/u.exec(p);
    if (m === "GET" && mt) {
      const run = runOf(mt[1]!);
      let c: string;
      try {
        c = decodeURIComponent(mt[2]!);
      } catch {
        throw new HttpError(400, "bad cell id encoding", "bad_id");
      }
      if (!CELL_ID.test(c)) throw new HttpError(400, "bad cell id (<cik10>.<field>, key.<route> or an evidence id)", "bad_id");
      const shaped = asRun({ ...run, evidence: evidenceOf(run) });
      const out = cellEvidence(shaped, c);
      if (!out) throw new HttpError(404, `no cell ${c} in run ${run.run_id}`, "not_found");
      return send(res, 200, out);
    }

    if (m === "GET" && p === "/api/usl") {
      const pick = url.searchParams.get("run");
      const liveRun = pick ? asRun(runOf(pick)) : latestLiveRulesRun();
      const dq = readJsonFile<DqFile>(dqFile) ?? (deps.dqFile === undefined && rt.runs.servingDemo?.() ? readJsonFile<DqFile>(DEMO_DQ_FILE) : null);
      return send(res, 200, uslView(readJsonFile<UslPlanFile>(uslPlanFile), dq, liveRun));
    }

    if (m === "GET" && p === "/api/seeds") {
      return send(res, 200, {
        utilities: rt.seeds.utilities.map((u) => ({ cik: u.cik, name: u.name, ticker: u.ticker, sic: u.sic, hq_state: u.hq_state, states_served: u.states_served, station_ids: u.station_ids, flags: u.flags })),
      });
    }

    mt = /^\/api\/why\/([^/]+)$/u.exec(p);
    if (m === "GET" && mt) {
      if (!MEM_ID.test(mt[1]!)) throw new HttpError(400, "bad memory id (mem-N)", "bad_id");
      const t = rt.hmem.why(mt[1]!);
      if (!t.memory) throw new HttpError(404, `no memory ${mt[1]}`, "not_found");
      return send(res, 200, { memory_id: mt[1], ...t });
    }

    if (m === "GET" && p === "/api/world") {
      const g = rt.world.exportGraph();
      const full = url.searchParams.get("full") === "1";
      return send(res, 200, { entities: g.byType, edges: g.edgeTypes, events: g.events, nodes_total: g.nodes.length, edges_total: g.edges.length, ...(full ? { graph: { nodes: g.nodes, edges: g.edges } } : {}) });
    }

    mt = /^\/api\/world\/([^/]+)$/u.exec(p);
    if (m === "GET" && mt) {
      if (!CIK.test(mt[1]!)) throw new HttpError(400, "bad cik", "bad_cik");
      const cik = mt[1]!.padStart(10, "0");
      const history = rt.world.utilityHistory(cik);
      if (!history.length) throw new HttpError(404, `no utility with CIK ${cik} in the World Model`, "not_found");
      return send(res, 200, { cik, history });
    }

    if (m === "GET" && p === "/api/eval") {
      if (!evalReport || !existsSync(evalReport)) throw new HttpError(404, "no evaluation report yet (eval/report.json under the data directory)", "not_found");
      let body: unknown;
      try {
        body = JSON.parse(readFileSync(evalReport, "utf8"));
      } catch (e) {
        throw new HttpError(500, `evaluation report is not valid JSON: ${(e as Error).message.slice(0, 120)}`, "bad_report");
      }
      const updated = new Date(statSync(evalReport).mtimeMs).toISOString();
      return send(res, 200, { file: "eval/report.json", updated_at: updated, updated_at_sgt: sgt(updated), report: body });
    }

    if (p.startsWith("/api/")) throw new HttpError(m === "GET" || m === "POST" ? 404 : 405, `no route ${m} ${p}`, m === "GET" || m === "POST" ? "not_found" : "method");

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
      if (e instanceof HttpError) return res.headersSent ? void res.end() : send(res, e.status, { error: e.message, code: e.code });
      log(`error ${req.method} ${req.url}: ${(e as Error).stack ?? e}`);
      if (!res.headersSent) send(res, 500, { error: (e as Error).message.slice(0, 300), code: "internal" });
      else res.end();
    });
  });

  return {
    server,
    bus,
    get busy() {
      return busy?.run_id ?? null;
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
  const log = (l: string) => process.stderr.write(`${sgt(new Date().toISOString())} ${l}\n`);
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
  log(`Crosswalk agent server on http://127.0.0.1:${bound} (pid ${process.pid}; gateway ${rt.gateway.baseUrl}; model ${rt.ollama?.model ?? "none"}; data ${DATA_DIR === `${REPO_ROOT}data` ? "data/" : "CW_DATA_DIR"}; ${rt.runs.list().length} saved run(s))`);
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
