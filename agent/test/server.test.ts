// The analyst-UI server against a mocked runtime: no model, no gateway, no real H-MEM or
// World Model. Synthetic run, utility and conflict values only (no SEC or NOAA figures).
// WON_DATA_DIR points at a temporary directory for the whole file; config.ts resolves its paths
// at import time, so every runtime import below is dynamic and comes after the assignment.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunResult } from "../src/loop/investigate.ts";
import type { AskFn, ServerRuntime, WonServer } from "../src/server.ts";

const DATA = mkdtempSync(join(tmpdir(), "won-server-data-"));
process.env.WON_DATA_DIR = DATA;

const { DATA_DIR, DATA_PATHS } = await import("../src/config.ts");
const { ContractVerifier } = await import("../src/contract/scout.ts");
const { RunStore } = await import("../src/ops/runStore.ts");
const { createServer, renderMemoMarkdown } = await import("../src/server.ts");
const { VECTOR_SECRET } = await import("./fixtures/contract-vector.ts");

const RUN = "r20260101T0000000001";
const CIK = "0000000001";
const CONFLICT = "rc-0123456789ab";

function syntheticRun(id: string, over: Partial<Pick<RunResult, "cik" | "period" | "claim">> = {}): RunResult {
  const ev1 = `ev-${id}-01`;
  const ev2 = `ev-${id}-02`;
  return {
    run_id: id,
    cik: over.cik ?? CIK,
    period: over.period ?? "CY2025Q1",
    previous_period: "CY2024Q1",
    claim: over.claim ?? "colder weather",
    started_at: "2026-01-01T00:00:00.000Z",
    finished_at: "2026-01-01T00:01:00.000Z",
    wall_ms: 60000,
    card: {
      question: "Synthetic question about a synthetic utility",
      utility: { cik: over.cik ?? CIK, name: "Synthetic Power Co", ticker: "SYN", sic: "4911", hq_state: "XX", states_served: ["XX"], stations: ["USW00000001"], flags: ["synthetic"] },
      verdict: { claim: "colder weather", verdict: "supported", ratio: 0.5, confidence: "high", withheld_reason: null },
      growth: { tag: "Revenues", g: 0.1, rev_current: 1100, rev_previous: 1000, current_accn: "0000000001-25-000001", current_filed: "2025-05-01", previous_original_accn: "0000000001-24-000001", previous_comparative_accn: "0000000001-25-000001", recast: false, tag_switch_note: null },
      weather: { delta_w: 0.2, tdd_current: 1200, tdd_previous: 1000, coverage: 1, stations_used: ["USW00000001"], stations_missing: [] },
      peers: { count: 1, by_tag: { Revenues: 1 }, with_weather: 1, excluded: [], list: [{ cik: "0000000002", name: "Synthetic Peer", tag: "Revenues", g: 0.05, dw: 0.1 }] },
      attribution: {
        weather: 0.05,
        industry: 0.03,
        remainder: 0.02,
        beta: 0.5,
        theil_sen: 0.4,
        peers: 1,
        confidence: "high",
        ranges: { weather: { lo: 0.01, hi: 0.09 }, industry: { lo: -0.01, hi: 0.07 }, remainder: { lo: -0.05, hi: 0.09 }, beta: { lo: 0.1, hi: 0.9 } },
        bootstrap: { valid: 300, resamples: 300, seed: 7 },
        claim: { ratio: 0.5, verdict: "supported" },
      },
      dq: null,
      recast_conflicts: [],
      not_tested: ["synthetic item not tested"],
      memo: { text: "Synthetic memo: revenue +10.0%, degree days +20.0%.", source: "template", words: 7, attempts: 0, attempts_detail: [] },
      claims: [{ text: "Synthetic claim", evidenceIds: [ev1] }],
      gaps: [],
    },
    checklist: [],
    checklist_complete: true,
    skipped_steps: [],
    timeline: [],
    markovian: { run_id: "m-1", status: "completed", error: null, chunk_config: { chunkSize: 3000, maxChunks: 10, carryoverTokens: 800, overlapTokens: 0 }, chunks: 2, engine_estimate: { total_tokens_used: 0, tokens_saved: 0, efficiency_percent: 0, label: "estimated" } },
    chunks: [],
    planner_calls: [],
    tool_calls: [],
    chart: [{ chunk: 0, measured: 1, estimated: 2 }],
    summary: { planner_calls: 2, planner_valid: 2 },
    telemetry: { model: null, think: false, median_planner_tokens_per_s: null, memo_tokens_per_s: null, cloud_model_calls: 0, refused_model_hosts: 0, refused_gateway_hosts: 0, memory_context_chars: 0 },
    memory: { ids: ["mem-1"], facts_total: 1, conflicts: 0, skipped_steps: 0 },
    world: null,
    timings_ms: {},
    evidence_ids: [ev1, ev2],
    evidence: [
      {
        id: ev1,
        run_id: id,
        kind: "zetaris_sql",
        claim: "synthetic frames row",
        queried_at: "2026-01-01T00:00:01+00:00",
        template_id: "frames_fact",
        params: { tag: "Revenues", period: "CY2025Q1", cik10: CIK },
        sql: "SELECT 1",
        sql_sha256: "ab".repeat(32),
        zetaris_object: "won.frames_Revenues_CY2025Q1",
        source_url: "https://data.sec.gov/api/xbrl/frames/us-gaap/Revenues/USD/CY2025Q1.json",
        licence: "synthetic licence text",
        source_cached_at: null,
        rows: [],
        row_count: 0,
        elapsed_ms: 12,
        cache_state: "hit",
      },
      { id: ev2, run_id: id, kind: "tool", claim: "synthetic attribution", queried_at: "2026-01-01T00:00:02+00:00", derived_from: [ev1] },
    ],
    evidence_file: null,
    quality: { e_cov: 1, claims: 1, e_complete: 1, records: 2, incomplete_records: {} },
  } as unknown as RunResult;
}

function syntheticConflict() {
  return {
    id: CONFLICT,
    kind: "recast_comparative",
    cik: CIK,
    tag: "Revenues",
    period: "CY2025Q1",
    scope: "current_period",
    own_filing_memory: "mem-1",
    later_filing_memory: "mem-2",
    own_filing: { val: 1100, accn: "0000000001-25-000001", filed: "2025-05-01", fy: 2025, fp: "Q1", form: "10-Q" },
    later_filing: { val: 1101, accn: "0000000001-26-000001", filed: "2026-05-01", fy: 2026, fp: "Q1", form: "10-Q" },
    rule: "R1",
    rule_text: "R1 synthetic",
    chosen: "own_filing" as string,
    chosen_val: 1100,
    status: "resolved_by_rule" as string,
    detected_at: "2026-01-01T00:00:30.000Z",
    run_id: RUN,
    evidence_ids: [] as string[],
    override: undefined as undefined | Record<string, unknown>,
  };
}

function fakeRuntime(root: string) {
  const runs = new RunStore(join(root, "runs"));
  runs.save(syntheticRun(RUN), { source: "test" });
  const conflict = syntheticConflict();
  const overrides: unknown[] = [];
  const hmem = {
    why: (id: string) =>
      id === "mem-1"
        ? { memory: { id, content: "synthetic fact" }, provenance: { zetaris_object: "won.frames_Revenues_CY2025Q1" }, ledger: [], conflicts: [], related: { supersedes: null, supersededBy: null }, lines: ["synthetic fact (source synthetic)"] }
        : { memory: null, provenance: null, ledger: [], conflicts: [], related: { supersedes: null, supersededBy: null }, lines: [`No memory ${id}.`] },
    recasts: {
      all: () => [conflict],
      get: (id: string) => (id === conflict.id ? conflict : undefined),
      override: (id: string, o: { chosen: string; reason: string; by?: string; contractId?: string | null }) => {
        if (id !== conflict.id) throw new Error(`no recast conflict ${id}`);
        conflict.chosen = o.chosen;
        conflict.chosen_val = o.chosen === "own_filing" ? conflict.own_filing.val : conflict.later_filing.val;
        conflict.status = "overridden";
        conflict.override = { by: o.by ?? "analyst", chosen: o.chosen, reason: o.reason, at: "2026-01-01T00:02:00.000Z", contract_id: o.contractId ?? null };
        overrides.push({ id, ...o });
        return conflict;
      },
    },
  };
  const world = {
    exportGraph: () => ({ nodes: [{ id: `utility:sec:${CIK}`, type: "utility", name: "Synthetic Power Co", attrs: {} }], edges: [], events: 3, byType: { utility: 1, station: 1 }, edgeTypes: { serves: 1 } }),
    neighbourhood: (cik: string) => (cik === CIK ? { utility: { id: `utility:sec:${CIK}`, type: "utility", name: "Synthetic Power Co" }, edges: [{ type: "serves", dir: "out", other: "state:us:XX", otherType: "state", otherName: "XX", attrs: {}, validFrom: "2024-01-01" }] } : { utility: null, edges: [] }),
    timeline: (cik: string) => (cik === CIK ? [{ seq: 1, at: "2024-01-01T00:00:00.000Z", kind: "upsertEntity", summary: "utility synthetic" }] : []),
  };
  const gateway = { baseUrl: "http://127.0.0.1:8793", health: async () => ({ ok: true, templates: Array.from({ length: 28 }, (_, i) => `t${i}`) }) };
  const seeds = {
    generatedAt: "synthetic",
    peerSic: ["4911"],
    utilities: [{ cik: CIK, name: "Synthetic Power Co", ticker: "SYN", sic: "4911", sic_description: null, hq_state: "XX", states_served: ["XX"], states_source: "synthetic", states_note: null, flags: ["synthetic"], curated: false, station_ids: ["USW00000001"] }],
    stations: [],
    stationById: new Map(),
  };
  const rt = { gateway, ollama: { model: "test-model" }, hmem, world, runs, seeds } as unknown as ServerRuntime;
  return { rt, runs, overrides, conflict };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A question runner that emits the loop events and saves a synthetic run; `delayMs` keeps the server busy. */
function fakeAsk(opts: { fail?: boolean; delayMs?: number } = {}): AskFn {
  return async (rt, req) => {
    const emit = req.onEvent!;
    await sleep(opts.delayMs ?? 5);
    emit({ type: "chunk_start", chunk: 0, carryover_tokens: 0 });
    emit({ type: "planner", chunk: 0, call: 1, valid: true, attempts: 1, tool: "get_weather", thought: "synthetic plan", prompt_tokens: 10, eval_tokens: 5, tokens_per_s: 100 });
    emit({ type: "tool", chunk: 0, seq: 1, tool: "get_weather", source: "model", fallback_reason: null, ok: true, fact: "synthetic fact", evidence_ids: [], latency_ms: 1 });
    emit({ type: "chunk_end", chunk: 0, state_tokens: 10, complete: true });
    if (opts.fail) throw new Error("synthetic failure");
    const saved = rt.runs.save(syntheticRun(req.runId!, { cik: req.cik, period: req.period, claim: req.claim }), { source: "server" });
    return { result: saved, evidence: null as never, seed: null };
  };
}

let app: WonServer | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function start(o: { ask?: AskFn; defaultVerifier?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "won-server-"));
  const uiDir = join(root, "ui");
  mkdirSync(uiDir);
  writeFileSync(join(uiDir, "index.html"), "<!doctype html><title>won-test</title>");
  writeFileSync(join(uiDir, "app.js"), "export const x = 1;");
  writeFileSync(join(root, "secret.txt"), "not served");
  const fake = fakeRuntime(root);
  const verifier = o.defaultVerifier ? undefined : new ContractVerifier(VECTOR_SECRET, "server", join(root, "contracts"));
  app = createServer({ runtime: fake.rt, ask: o.ask ?? fakeAsk(), verifier, uiDir });
  const port = await app.listen(0);
  return { ...fake, root, port, base: `http://127.0.0.1:${port}`, verifierLog: join(root, "contracts", "verifier-server.jsonl"), usedLedger: join(root, "contracts", "used-server.jsonl") };
}

async function call(base: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text) as Record<string, any>;
  } catch {
    // not JSON (markdown, html)
  }
  return { status: res.status, body: json, text, type: res.headers.get("content-type") ?? "" };
}

/** Raw request with a chosen Host header (fetch does not allow overriding it). */
function rawGet(port: number, path: string, host: string): Promise<{ status: number; text: string }> {
  return new Promise((ok, fail) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += String(c)));
      res.on("end", () => ok({ status: res.statusCode ?? 0, text: buf }));
    });
    req.on("error", fail);
    req.end();
  });
}

/** Reads /api/events for `ms` milliseconds (or until `until` appears in the stream). */
function readSse(port: number, path: string, headers: Record<string, string>, ms: number, until?: string): Promise<string> {
  return new Promise((ok, fail) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let buf = "";
      const done = () => {
        req.destroy();
        ok(buf);
      };
      const timer = setTimeout(done, ms);
      res.on("data", (c) => {
        buf += String(c);
        if (until && buf.includes(until)) {
          clearTimeout(timer);
          done();
        }
      });
    });
    req.on("error", (e) => (String(e).includes("socket hang up") || String(e).includes("aborted") ? undefined : fail(e)));
    req.end();
  });
}

async function waitIdle(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (!app!.busy) return;
    await sleep(10);
  }
  throw new Error("server stayed busy");
}

function eventsOf(text: string): { id: number; type: string; data: Record<string, any> }[] {
  return text
    .split("\n\n")
    .filter((b) => b.includes("event: "))
    .map((b) => {
      const id = Number(/^id: (\d+)$/mu.exec(b)?.[1]);
      const type = /^event: (.+)$/mu.exec(b)![1]!;
      const data = JSON.parse(/^data: (.+)$/mu.exec(b)![1]!) as Record<string, any>;
      return { id, type, data };
    });
}

describe("server: reads", () => {
  it("WON_DATA_DIR points config and the stores at the temporary directory", () => {
    expect(DATA_DIR).toBe(DATA);
    expect(DATA_PATHS.runs.startsWith(DATA)).toBe(true);
    expect(DATA_PATHS.lock).toBe(join(DATA, "agent.lock"));
    expect(DATA_PATHS.evalReport).toBe(join(DATA, "eval", "report.json"));
  });

  it("GET /api/health names the model, the gateway's template count, the run count and the data dir", async () => {
    const { base } = await start();
    const r = await call(base, "/api/health");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, model: "test-model", gateway_ok: true, gateway_templates: 28, runs: 1, data_dir: DATA, busy_run_id: null });
  });

  it("GET /api/runs, /api/run/:id and the 404 and 400 cases", async () => {
    const { base } = await start();
    const list = await call(base, "/api/runs");
    expect(list.status).toBe(200);
    expect(list.body.runs).toHaveLength(1);
    expect(list.body.runs[0]).toMatchObject({ run_id: RUN, cik: CIK, verdict: "supported", source: "test" });
    const run = await call(base, `/api/run/${RUN}`);
    expect(run.status).toBe(200);
    expect(run.body.run_id).toBe(RUN);
    expect(run.body.saved.source).toBe("test");
    expect(run.body.card.memo.text).toContain("Synthetic memo");
    expect((await call(base, "/api/run/r20260101T0000009999")).status).toBe(404);
    expect((await call(base, "/api/run/not-a-run")).status).toBe(400);
    expect((await call(base, "/api/run/not-a-run")).body.error).toBeTypeOf("string");
  });

  it("GET /api/run/:id/evidence/:eid serves one record; unknown ids are 404", async () => {
    const { base } = await start();
    const one = await call(base, `/api/run/${RUN}/evidence/ev-${RUN}-01`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ id: `ev-${RUN}-01`, template_id: "frames_fact", zetaris_object: "won.frames_Revenues_CY2025Q1", elapsed_ms: 12 });
    const all = await call(base, `/api/run/${RUN}/evidence`);
    expect(all.body.records).toHaveLength(2);
    expect((await call(base, `/api/run/${RUN}/evidence/ev-${RUN}-99`)).status).toBe(404);
    expect((await call(base, `/api/run/${RUN}/evidence/nonsense`)).status).toBe(400);
    expect((await call(base, `/api/run/r20260101T0000009999/evidence/ev-${RUN}-01`)).status).toBe(404);
  });

  it("GET /api/run/:id/memo.md renders the memo with a citations table (ids, Zetaris objects, endpoints, retrieval times)", async () => {
    const { base } = await start();
    const r = await call(base, `/api/run/${RUN}/memo.md`);
    expect(r.status).toBe(200);
    expect(r.type).toContain("text/markdown");
    expect(r.text).toContain("# Weather-or-Not memo: Synthetic Power Co");
    expect(r.text).toContain("Synthetic memo: revenue +10.0%, degree days +20.0%.");
    expect(r.text).toContain("## Citations");
    expect(r.text).toContain(`| ev-${RUN}-01 | zetaris_sql | frames_fact | won.frames_Revenues_CY2025Q1 | https://data.sec.gov/api/xbrl/frames/us-gaap/Revenues/USD/CY2025Q1.json | 2026-01-01T00:00:01+00:00 | 12 ms |`);
    expect(r.text).toContain(`| ev-${RUN}-02 | tool | from ev-${RUN}-01 |`);
    expect(r.text).toContain("| Weather | +5.0% | [+1.0%, +9.0%] |");
    expect(r.text).toContain("- synthetic item not tested");
    expect(r.text).toContain("- synthetic licence text");
    expect(renderMemoMarkdown(syntheticRun(RUN))).toBe(r.text);
    expect((await call(base, "/api/run/r20260101T0000009999/memo.md")).status).toBe(404);
  });

  it("GET /api/why/:memId returns the trace, 404 for an unknown memory, 400 for a bad id", async () => {
    const { base } = await start();
    const ok = await call(base, "/api/why/mem-1");
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ memory_id: "mem-1", memory: { id: "mem-1" }, lines: ["synthetic fact (source synthetic)"] });
    expect((await call(base, "/api/why/mem-404")).status).toBe(404);
    expect((await call(base, "/api/why/evil")).status).toBe(400);
    const conflicts = await call(base, "/api/conflicts");
    expect(conflicts.body.conflicts).toHaveLength(1);
    expect(conflicts.body.conflicts[0].id).toBe(CONFLICT);
  });

  it("GET /api/world gives counts, /api/world/:cik the neighbourhood and timeline, 404 for a stranger", async () => {
    const { base } = await start();
    const w = await call(base, "/api/world");
    expect(w.status).toBe(200);
    expect(w.body).toMatchObject({ entities: { utility: 1, station: 1 }, edges: { serves: 1 }, events: 3, nodes_total: 1, edges_total: 0 });
    expect(w.body.graph).toBeUndefined();
    expect((await call(base, "/api/world?full=1")).body.graph.nodes).toHaveLength(1);
    const u = await call(base, `/api/world/${CIK}`);
    expect(u.status).toBe(200);
    expect(u.body.neighbourhood.utility.name).toBe("Synthetic Power Co");
    expect(u.body.neighbourhood.edges[0]).toMatchObject({ type: "serves", otherName: "XX" });
    expect(u.body.timeline).toHaveLength(1);
    expect((await call(base, "/api/world/1")).status).toBe(200);
    expect((await call(base, "/api/world/0000000009")).status).toBe(404);
    expect((await call(base, "/api/world/abc")).status).toBe(400);
  });

  it("GET /api/telemetry carries the latest run's summary, telemetry, chart and skipped steps", async () => {
    const { base } = await start();
    const t = await call(base, "/api/telemetry");
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ model: "test-model", runs: 1, run_id: RUN, chunks: 2, summary: { planner_calls: 2 }, telemetry: { cloud_model_calls: 0 }, skipped_steps: [] });
    expect(t.body.chart).toHaveLength(1);
  });

  it("GET /api/eval is 404 until eval/report.json exists under WON_DATA_DIR, then serves it", async () => {
    const { base } = await start();
    expect(existsSync(DATA_PATHS.evalReport)).toBe(false);
    const miss = await call(base, "/api/eval");
    expect(miss.status).toBe(404);
    expect(miss.body.error).toContain("no evaluation report yet");
    mkdirSync(DATA_PATHS.eval, { recursive: true });
    writeFileSync(DATA_PATHS.evalReport, JSON.stringify({ synthetic: true, measured: [] }));
    const hit = await call(base, "/api/eval");
    expect(hit.status).toBe(200);
    expect(hit.body).toMatchObject({ file: "eval/report.json", report: { synthetic: true } });
  });

  it("GET /api/seeds lists the seed utilities with their latest run per period", async () => {
    const { base } = await start();
    const r = await call(base, "/api/seeds");
    expect(r.status).toBe(200);
    expect(r.body.utilities[0]).toMatchObject({ cik: CIK, ticker: "SYN", latest_run_id: { CY2025Q1: RUN } });
  });
});

describe("server: ask and the event stream", () => {
  it("POST /api/ask answers 202 {run_id}, 409 {busy_run_id} while running, then run_finished with every event carrying run_id", async () => {
    const { base, port } = await start({ ask: fakeAsk({ delayMs: 150 }) });
    const a = await call(base, "/api/ask", { cik: "1", period: "CY2025Q1", claim: "colder weather" });
    expect(a.status).toBe(202);
    expect(a.body.run_id).toMatch(/^r\d{8}T\d{6}[0-9a-f]{4}$/u);
    expect(a.body).toMatchObject({ cik: CIK, period: "CY2025Q1", claim: "colder weather", utility: "Synthetic Power Co" });
    const b = await call(base, "/api/ask", { utility: "SYN", period: "CY2025Q1" });
    expect(b.status).toBe(409);
    expect(b.body).toMatchObject({ busy_run_id: a.body.run_id, code: "busy" });
    expect(b.body.error).toBeTypeOf("string");
    await waitIdle();
    const text = await readSse(port, "/api/events", { "last-event-id": "0" }, 1500, "event: run_finished");
    const evs = eventsOf(text);
    expect(evs.map((e) => e.type)).toEqual(["run_started", "chunk_start", "planner", "tool", "chunk_end", "run_finished"]);
    for (const e of evs) expect(e.data.run_id).toBe(a.body.run_id);
    expect(evs[2]!.data).toMatchObject({ tool: "get_weather", thought: "synthetic plan", valid: true });
    expect(evs[5]!.data).toMatchObject({ verdict: "supported", confidence: "high", chunks: 2, cik: CIK });
    const runs = await call(base, "/api/runs");
    expect(runs.body.runs).toHaveLength(2);
    const mine = runs.body.runs.find((r: { run_id: string }) => r.run_id === a.body.run_id);
    expect(mine).toMatchObject({ run_id: a.body.run_id, source: "server", verdict: "supported" });
    expect((await call(base, `/api/run/${a.body.run_id}`)).status).toBe(200);
    // Idle again: the next question is accepted.
    expect((await call(base, "/api/ask", { cik: CIK, period: "CY2025Q2" })).status).toBe(202);
    await waitIdle();
  });

  it("a failing run publishes run_failed and frees the server", async () => {
    const { base, port } = await start({ ask: fakeAsk({ fail: true }) });
    const a = await call(base, "/api/ask", { cik: CIK, period: "CY2025Q1" });
    expect(a.status).toBe(202);
    await waitIdle();
    const evs = eventsOf(await readSse(port, "/api/events", { "last-event-id": "0" }, 1500, "event: run_failed"));
    expect(evs.map((e) => e.type)).toEqual(["run_started", "chunk_start", "planner", "tool", "chunk_end", "run_failed"]);
    expect(evs[5]!.data).toMatchObject({ run_id: a.body.run_id, error: "synthetic failure" });
    expect((await call(base, "/api/ask", { cik: CIK, period: "CY2025Q1" })).status).toBe(202);
    await waitIdle();
  });

  it("validates the question: cik or utility, a CY period, max_chunks 1 to 10", async () => {
    const { base } = await start();
    expect((await call(base, "/api/ask", { period: "CY2025Q1" })).status).toBe(400);
    expect((await call(base, "/api/ask", { cik: CIK })).status).toBe(400);
    expect((await call(base, "/api/ask", { cik: CIK, period: "2025Q1" })).status).toBe(400);
    expect((await call(base, "/api/ask", { cik: CIK, period: "CY2025Q4" })).status).toBe(400);
    expect((await call(base, "/api/ask", { cik: "12345678901", period: "CY2025Q1" })).status).toBe(400);
    expect((await call(base, "/api/ask", { utility: "Nobody Energy", period: "CY2025Q1" })).status).toBe(400);
    expect((await call(base, "/api/ask", { cik: CIK, period: "CY2025Q1", max_chunks: 11 })).status).toBe(400);
    expect(app!.busy).toBeNull();
  });

  it("streams events over SSE; a new connection gets no history, Last-Event-ID and ?since replay the missed events", async () => {
    const { base, port } = await start();
    await call(base, "/api/ask", { cik: CIK, period: "CY2025Q1" });
    await waitIdle();
    const fresh = await readSse(port, "/api/events", {}, 250);
    expect(fresh).toContain("retry: 3000");
    expect(fresh).not.toMatch(/^id: /mu);
    const replay = await readSse(port, "/api/events", { "last-event-id": "2" }, 1000, "event: run_finished");
    const ids = eventsOf(replay).map((e) => e.id);
    expect(ids[0]).toBe(3);
    expect(ids).not.toContain(2);
    const since = eventsOf(await readSse(port, "/api/events?since=4", {}, 250)).map((e) => e.id);
    expect(since).toEqual([5, 6]);
  });
});

describe("server: the signed override path", () => {
  it("refuses an override without a valid contract: 403, logged, nothing written", async () => {
    const { base, overrides, verifierLog } = await start();
    const r1 = await call(base, "/api/override", { conflict_id: CONFLICT, chosen: "later_filing", reason: "no contract" });
    expect(r1.status).toBe(403);
    expect(r1.body).toMatchObject({ code: "missing" });
    expect(r1.body.error).toContain("refused");
    const r2 = await call(base, "/api/override", { conflict_id: CONFLICT, chosen: "later_filing", reason: "forged", contract: { contractId: "c-x", signature: "0".repeat(64) } });
    expect(r2.status).toBe(403);
    expect(r2.body.code).toBe("malformed");
    expect(overrides).toHaveLength(0);
    const log = readFileSync(verifierLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(log.map((e) => [e.verifier, e.action, e.ok, e.code])).toEqual([
      ["server", "override_recast", false, "missing"],
      ["server", "override_recast", false, "malformed"],
    ]);
    expect((await call(base, "/api/override", { conflict_id: "bad", chosen: "later_filing", reason: "x" })).status).toBe(400);
    expect((await call(base, "/api/override", { conflict_id: CONFLICT, chosen: "sideways", reason: "x" })).status).toBe(400);
  });

  it("signs a high-risk override_recast contract for the analyst, then applies the override once", async () => {
    const { base, port, overrides, conflict, usedLedger } = await start();
    const params = { conflict_id: CONFLICT, chosen: "later_filing", reason: "the later filing corrects a typo" };
    const signed = await call(base, "/api/approvals/sign", { action: "override_recast", params });
    expect(signed.status).toBe(200);
    const contract = signed.body.contract;
    expect(contract).toMatchObject({ intent: { primary: "override_recast", parameters: params }, risk: { level: "high" }, scope: { user: "analyst", surface: "won-ui" }, signedBy: "scout" });
    expect(contract.risk.approvals[0]).toMatchObject({ kind: "analyst-approval", by: "analyst", decision: "approve", reason: params.reason });
    expect(contract.signature).toMatch(/^[0-9a-f]{64}$/u);
    // A different chosen side than the contract names: parameter mismatch, nothing written.
    const tampered = await call(base, "/api/override", { ...params, chosen: "own_filing", contract });
    expect(tampered.status).toBe(403);
    expect(tampered.body.code).toBe("parameter_mismatch");
    expect(overrides).toHaveLength(0);
    const ok = await call(base, "/api/override", { ...params, contract });
    expect(ok.status).toBe(200);
    expect(ok.body.conflict).toMatchObject({ id: CONFLICT, status: "overridden", chosen: "later_filing", chosen_val: 1101, override: { by: "analyst", contract_id: contract.contractId } });
    expect(ok.body.contract_id).toBe(contract.contractId);
    expect(overrides).toHaveLength(1);
    expect(conflict.status).toBe("overridden");
    const evs = eventsOf(await readSse(port, "/api/events", { "last-event-id": "0" }, 500));
    expect(evs.map((e) => e.type)).toEqual(["override"]);
    expect(evs[0]!.data).toMatchObject({ run_id: RUN, conflict_id: CONFLICT, chosen: "later_filing", by: "analyst", contract_id: contract.contractId });
    const again = await call(base, "/api/override", { ...params, contract });
    expect(again.status).toBe(403);
    expect(again.body.code).toBe("replayed");
    expect(overrides).toHaveLength(1);
    expect(readFileSync(usedLedger, "utf8")).toContain(contract.contractId);
  });

  it("an unknown conflict is 404 even with a valid contract; sign rejects other actions and bad parameters", async () => {
    const { base } = await start();
    const params = { conflict_id: "rc-ffffffffffff", chosen: "own_filing", reason: "testing" };
    const signed = await call(base, "/api/approvals/sign", { action: "override_recast", params });
    expect(signed.status).toBe(200);
    expect((await call(base, "/api/override", { ...params, contract: signed.body.contract })).status).toBe(404);
    expect((await call(base, "/api/approvals/sign", { action: "register_frames", params: { tag: "Revenues", period: "CY2025Q1" } })).status).toBe(400);
    expect((await call(base, "/api/approvals/sign", { action: "override_recast", params: { conflict_id: CONFLICT, chosen: "own_filing" } })).status).toBe(400);
    expect((await call(base, "/api/approvals/sign", { action: "override_recast", params: { conflict_id: CONFLICT, chosen: "own_filing", reason: "  " } })).status).toBe(400);
    expect((await call(base, "/api/approvals/sign", { action: "override_recast", params: { ...params, extra: "x" } })).status).toBe(400);
  });

  it("the default verifier keeps its ledger under WON_DATA_DIR/contracts", async () => {
    process.env.WON_CONTRACT_SECRET = VECTOR_SECRET;
    try {
      const { base } = await start({ defaultVerifier: true });
      expect((await call(base, "/api/override", { conflict_id: CONFLICT, chosen: "later_filing", reason: "no contract" })).status).toBe(403);
      const log = join(DATA_PATHS.contracts, "verifier-server.jsonl");
      expect(existsSync(log)).toBe(true);
      expect(readFileSync(log, "utf8")).toContain('"code":"missing"');
    } finally {
      delete process.env.WON_CONTRACT_SECRET;
    }
  });
});

describe("server: transport safety and static files", () => {
  it("answers only to its own Host and refuses foreign origins and non-JSON writes", async () => {
    const { base, port } = await start();
    expect((await rawGet(port, "/api/health", "evil.example")).status).toBe(421);
    expect((await rawGet(port, "/api/health", `127.0.0.1:${port}`)).status).toBe(200);
    expect((await rawGet(port, "/api/health", `localhost:${port}`)).status).toBe(200);
    const cross = await call(base, "/api/ask", { cik: CIK, period: "CY2025Q1" }, { origin: "http://evil.example" });
    expect(cross.status).toBe(403);
    expect(cross.body.code).toBe("origin");
    const same = await call(base, "/api/runs", undefined, { origin: `http://127.0.0.1:${port}` });
    expect(same.status).toBe(200);
    const text = await fetch(`${base}/api/ask`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect(text.status).toBe(415);
    const bad = await fetch(`${base}/api/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: "[1,2]" });
    expect(bad.status).toBe(400);
    expect(app!.busy).toBeNull();
  });

  it("serves the UI directory with content types and nothing outside it", async () => {
    const { base, port } = await start();
    const idx = await fetch(`${base}/`);
    expect(idx.status).toBe(200);
    expect(idx.headers.get("content-type")).toContain("text/html");
    expect(await idx.text()).toContain("<title>won-test</title>");
    const js = await fetch(`${base}/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    const head = await fetch(`${base}/app.js`, { method: "HEAD" });
    expect(head.status).toBe(200);
    const host = `127.0.0.1:${port}`;
    // Encoded parent segments, drive letters and network paths are refused outright.
    for (const p of ["/..%2fsecret.txt", "/..%5csecret.txt", "/%2e%2e%2fsecret.txt", "/C:/Windows/win.ini", "/c%3a/Windows/win.ini", "/%5c%5cserver%5cshare", "/index.html%00.txt"]) {
      const r = await rawGet(port, p, host);
      expect(r.status, p).toBe(403);
      expect(r.text, p).not.toContain("not served");
    }
    // Dot segments (literal or %2e-encoded) are collapsed and a leading // is read as a host by the URL parser before the file lookup: they never leave ui/.
    for (const p of ["/../secret.txt", "/ui/../secret.txt", "/../../secret.txt", "/%2e%2e/secret.txt", "//127.0.0.1/share/x"]) {
      const r = await rawGet(port, p, host);
      expect([403, 404], p).toContain(r.status);
      expect(r.text, p).not.toContain("not served");
    }
    expect((await rawGet(port, "/missing.css", host)).status).toBe(404);
    expect((await rawGet(port, "/api/nope", host)).status).toBe(404);
    expect(JSON.parse((await rawGet(port, "/api/nope", host)).text).error).toContain("no route");
  });

  it("serves nothing when no UI directory is configured", async () => {
    const root = mkdtempSync(join(tmpdir(), "won-server-noui-"));
    const fake = fakeRuntime(root);
    app = createServer({ runtime: fake.rt, ask: fakeAsk(), verifier: new ContractVerifier(VECTOR_SECRET, "server", join(root, "contracts")), uiDir: null });
    const port = await app.listen(0);
    expect((await rawGet(port, "/", `127.0.0.1:${port}`)).status).toBe(404);
    expect((await rawGet(port, "/api/health", `127.0.0.1:${port}`)).status).toBe(200);
  });
});
