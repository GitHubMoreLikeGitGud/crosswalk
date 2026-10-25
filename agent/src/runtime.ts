// The agent runtime shared by the CLI and the server: the gateway client, the Ollama client,
// H-MEM (<data>/hmem), the World Model (<data>/world), the run store (<data>/runs) and the
// registrar port that signs execution contracts. Commands that open <data>/hmem and
// <data>/world take <data>/agent.lock, so two processes never write the stores at once.
// Adapted from Weather-or-Not and ClearShelf (same author, Apache-2.0).

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR_URL, loadConfig, REPO_ROOT } from "./config.ts";
import { issueContract, loadContractSecret } from "./contract/scout.ts";
import { EvidenceStore } from "./evidence/store.ts";
import { OllamaClient } from "./llm/ollama.ts";
import { demoQuestion, investigate, type InvestigateOptions, type RunResult } from "./loop/investigate.ts";
import { memoryKeyOf, type KeyMemoryPort, type RegistrarAction, type RegistrarPort, type ToolDeps } from "./loop/tools.ts";
import { openMemory, provenanceOf, type HMEM } from "./memory/hmemFacade.ts";
import { seedMemory, type SeedReport } from "./memory/seed.ts";
import { RunStore } from "./ops/runStore.ts";
import { loadSeeds, type Seeds } from "./seeds.ts";
import { loadCatalogueInputs, registeredObjects, registrationPlan, registerSource, readDqFile, parseDqRun, type RegisterResult } from "./tools/discovery.ts";
import { CrosswalkWorld, type DeclarationInput } from "./world/world.ts";
import { GatewayClient, type RegistrarResult } from "./zetaris/client.ts";

export const LOCK_FILE = fileURLToPath(new URL("agent.lock", DATA_DIR_URL));
export const CONTRACTS_LOG = fileURLToPath(new URL("contracts/issued-agent.jsonl", DATA_DIR_URL));
export const DQ_FILE = fileURLToPath(new URL("dq/latest.json", DATA_DIR_URL));

export interface AgentLock {
  file: string;
  release(): void;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Takes <data>/agent.lock; refuses while another live process holds it. */
export function acquireLock(command: string, file = LOCK_FILE): AgentLock {
  mkdirSync(fileURLToPath(DATA_DIR_URL), { recursive: true });
  if (existsSync(file)) {
    try {
      const held = JSON.parse(readFileSync(file, "utf8")) as { pid: number; command: string; at: string };
      if (held.pid !== process.pid && pidAlive(held.pid)) {
        throw new Error(`data/agent.lock is held by pid ${held.pid} (${held.command}, since ${held.at}); stop it or wait for it to finish`);
      }
    } catch (e) {
      if ((e as Error).message.includes("agent.lock is held")) throw e;
    }
  }
  writeFileSync(file, `${JSON.stringify({ pid: process.pid, command, at: new Date().toISOString() })}\n`, "utf8");
  let released = false;
  return {
    file,
    release() {
      if (released) return;
      released = true;
      try {
        if (existsSync(file)) unlinkSync(file);
      } catch {
        // nothing to do
      }
    },
  };
}

/** Signs a medium-risk contract for register_source and posts it; the contract id and parameters are logged (never the signature). */
export function registrarPort(gateway: GatewayClient, user = "cw-agent"): RegistrarPort {
  return {
    async register(action: RegistrarAction, params: Record<string, string>): Promise<RegistrarResult> {
      const contract = issueContract({ action, parameters: params, user, surface: "cw-agent" }, loadContractSecret());
      mkdirSync(fileURLToPath(new URL("contracts/", DATA_DIR_URL)), { recursive: true });
      appendFileSync(CONTRACTS_LOG, `${JSON.stringify({ contractId: contract.contractId, action, params, issuedAt: contract.issuedAt, expiresAt: contract.expiresAt })}\n`, "utf8");
      const { catalogue_id: id, ...rest } = params;
      return gateway.registerSource(id!, rest, contract as unknown as Record<string, unknown>);
    },
  };
}

/** key_verified memories as the loop's KeyMemoryPort; `recall: false` (a cold run) remembers but never recalls. */
export function keyMemoryPort(hmem: HMEM, runId: string, opts: { recall: boolean; evidence?: EvidenceStore }): KeyMemoryPort {
  return {
    recall(memoryKey) {
      if (!opts.recall) return null;
      const r = hmem.recallKey(memoryKey);
      return r && r.record.verdict === "VERIFIED" ? { result: r.record.result, memoryId: r.memory.id } : null;
    },
    remember(result, evidenceIds) {
      const ev = opts.evidence?.all().find((e) => evidenceIds.includes(e.id) && e.kind === "zetaris_sql");
      return hmem.rememberKey({ memoryKey: memoryKeyOf(result.proposal), result, runId, at: ev?.queried_at ?? new Date().toISOString(), evidenceIds, provenance: ev ? provenanceOf(ev) : null }).memory.id;
    },
    verified() {
      if (!opts.recall) return [];
      return hmem
        .keyRecords()
        .filter((k) => k.record.verdict === "VERIFIED")
        .map((k) => {
          hmem.recallKey(k.record.memory_key, "warm run: verified key of the question's source family recalled");
          return { memoryKey: k.record.memory_key, result: k.record.result, memoryId: k.memoryId };
        });
    },
  };
}

export interface Runtime {
  gateway: GatewayClient;
  ollama: OllamaClient | null;
  hmem: HMEM;
  world: CrosswalkWorld;
  runs: RunStore;
  seeds: Seeds;
  registrar: RegistrarPort;
  lock: AgentLock | null;
  log: (line: string) => void;
  close(): void;
}

export interface RuntimeOptions {
  command?: string;
  lock?: boolean;
  ollama?: OllamaClient | null;
  gateway?: GatewayClient;
  log?: (line: string) => void;
}

export function openRuntime(o: RuntimeOptions = {}): Runtime {
  const cfg = loadConfig();
  const lock = o.lock === false ? null : acquireLock(o.command ?? process.argv.slice(2).join(" "));
  try {
    const gateway = o.gateway ?? new GatewayClient({ baseUrl: cfg.gatewayUrl });
    const ollama = o.ollama === undefined ? new OllamaClient({ baseUrl: cfg.ollamaUrl, model: cfg.model }) : o.ollama;
    return {
      gateway,
      ollama,
      hmem: openMemory(),
      world: new CrosswalkWorld(),
      runs: new RunStore(),
      seeds: loadSeeds(),
      registrar: registrarPort(gateway),
      lock,
      log: o.log ?? ((l) => process.stderr.write(`${l}\n`)),
      close() {
        lock?.release();
      },
    };
  } catch (e) {
    lock?.release();
    throw e;
  }
}

export interface AskRequest {
  quarter: string;
  /** Default: the demo question of SPEC D9 for the quarter. */
  question?: string;
  /** "cold": key_verified memories are written but never recalled; "warm" (default): verified keys are recalled. */
  mode?: "cold" | "warm";
  think?: boolean;
  maxChunks?: number;
  onEvent?: InvestigateOptions["onEvent"];
  abortSignal?: AbortSignal;
  noSeed?: boolean;
  runId?: string;
}

export interface AskOutcome {
  result: RunResult;
  evidence: EvidenceStore;
  seed: SeedReport | null;
}

/** The declarations of the quarter as World Model entities (one gateway read, off the checklist). */
async function declarationsOf(gateway: GatewayClient, quarter: string): Promise<DeclarationInput[]> {
  const r = await gateway.template("fema_declarations", { quarter });
  const cols = r.columns.map((c) => c.toLowerCase());
  const at = (row: unknown[], c: string) => row[cols.indexOf(c)];
  const by = new Map<string, DeclarationInput>();
  for (const row of r.rows) {
    const n = String(at(row, "disaster_number"));
    const st = String(at(row, "state"));
    const k = `${n}|${st}`;
    const cur = by.get(k);
    if (cur) cur.designated_areas += 1;
    else by.set(k, { disaster_number: n, state: st, declaration_date: String(at(row, "declaration_date") ?? "").slice(0, 10), incident_type: (at(row, "incident_type") as string | null) ?? null, title: (at(row, "declaration_title") as string | null) ?? null, designated_areas: 1, quarter, sqlSha256: null });
  }
  return [...by.values()];
}

/** Seeds memory (idempotent), runs the question, records source_access memories, ingests the World Model and saves the run. */
export async function ask(rt: Runtime, req: AskRequest, origin: { source: "cli" | "server"; note?: string } = { source: "cli" }): Promise<AskOutcome> {
  const seed = req.noSeed ? null : await seedMemory(rt.hmem, { log: () => {} });
  const evidence = new EvidenceStore(req.runId);
  // Cold when asked, or when no VERIFIED key is remembered yet; warm otherwise.
  const mode = req.mode ?? (rt.hmem.keyRecords().some((k) => k.record.verdict === "VERIFIED") ? "warm" : "cold");
  const keyMemory = keyMemoryPort(rt.hmem, evidence.runId, { recall: mode === "warm", evidence });
  const deps: ToolDeps = { gateway: rt.gateway, ollama: rt.ollama, evidence, seeds: rt.seeds, registrar: rt.registrar, keyMemory, weather: true, dqFile: DQ_FILE, log: rt.log, registeredExtra: rt.hmem.sourceObjects() };
  const question = req.question ?? demoQuestion(req.quarter);
  const memoryContext = rt.hmem.memoryContext();
  const result = await investigate({ question, quarter: req.quarter, think: req.think, maxChunks: req.maxChunks, onEvent: req.onEvent, abortSignal: req.abortSignal, mode, memoryContext: memoryContext || undefined }, deps);
  // source_access memories for every registration the run made or confirmed.
  for (const r of result.registrations) {
    rt.hmem.rememberSource({ object: r.object, catalogueId: r.catalogue_id, params: r.params, status: r.status, rows: r.rows, runId: result.run_id, at: result.finished_at, contractId: r.contract_id, evidenceId: null });
  }
  // World Model: datasets probed, keys measured, utilities answered, the quarter's declarations.
  let delta: unknown = null;
  try {
    const probed = result.evidence.filter((e) => e.kind === "tool" && (e.details as { tool?: string })?.tool === "probe_source");
    const datasets = probed.map((e) => {
      const d = e.details as { object: string; columns: { name: string; type: string }[] };
      return { object: d.object, columns: d.columns };
    });
    const keys = result.join_map
      .filter((k) => k.status === "measured" && !k.from_memory)
      .map((k) => {
        const [lo, ...lc] = k.left.split(".");
        const [ro, ...rc] = k.right.split(".");
        const lObj = `${lo}.${lc.slice(0, -1).join(".")}`;
        const rObj = `${ro}.${rc.slice(0, -1).join(".")}`;
        return { left: { object: lObj, column: lc[lc.length - 1]! }, right: { object: rObj, column: rc[rc.length - 1]! }, transform: k.transform, memoryKey: k.memory_key, rate: k.rate, rate_distinct: k.rate_distinct, verdict: k.verdict, matched_rows: k.matched_rows, left_rows: k.left_rows, measured_as: k.measured_as, orphans: k.orphans, run_id: result.run_id, at: result.finished_at, sqlSha256: null };
      });
    const utilities = (result.answer?.rows ?? []).map((row) => {
      const s = rt.seeds.utilities.find((u) => u.cik === row.cik);
      return { cik: row.cik, name: row.name, ticker: row.ticker, statesServed: s?.states_served ?? row.states.map((x) => x.state), curatedAt: rt.seeds.generatedAt };
    });
    const declarations = await declarationsOf(rt.gateway, req.quarter).catch(() => []);
    delta = await rt.world.ingest({ runId: result.run_id, datasets, keys, utilities, declarations });
  } catch (e) {
    result.card.gaps.push(`World Model ingest failed: ${(e as Error).message.slice(0, 160)}`);
  }
  const g = rt.world.exportGraph();
  result.world = { events: g.events, entities: g.byType, edges: g.edgeTypes, delta };
  result.memory = { ids: [...new Set([...result.skipped_steps.map((s) => s.memoryId)])], facts_total: rt.hmem.store.all().length, skipped_steps: result.skipped_steps.length };
  rt.runs.save(result, origin);
  return { result, evidence, seed };
}

// ---------------------------------------------------------------- onboarding (never on the question path)

export const DQ_RULES = ["utility.sic", "utility_state.cik", "utility_state.state", "fema_declaration.state", "station.state", "revenue_quarter.cik"] as const;

export interface OnboardReport {
  started_at: string;
  wall_ms: number;
  registrations: (RegisterResult | { catalogue_id: string; params: Record<string, string>; object: string; error: string })[];
  usl: { tables: string[]; rules: number; ok: boolean; elapsed_ms: number };
  dq: { ran_at: string; rules: { rule: string; total: number | null; valid: number | null; invalid: number | null; elapsed_s: number; sql: string | null; error: string | null; attempts: number }[]; invalid_rows: { rule: string; row: unknown[] }[] };
  dq_file: string;
  snapshot: SnapshotReport;
}

/** The onboarding snapshot cw.seed_submissions_snapshot (D15), as scripts/make_cw_snapshot.py reports it. */
export interface SnapshotReport {
  view: string;
  status: "registered" | "already_registered" | "refreshed" | "failed" | string;
  rows: number | null;
  snapshot_at: string | null;
  /** The one read of cw.seed_utilities (a first onboarding without a snapshot file, or --refresh-snapshot); null otherwise. */
  read: { sql: string; rows: number; elapsed_ms: number; wall_ms: number; snapshot_at: string } | null;
  statements: { sql: string; elapsed_ms: number; wall_ms: number }[];
  error: string | null;
}

/**
 * D15: make sure cw.seed_submissions_snapshot exists (DESCRIBE; CREATE + CACHE from the committed snapshot file when absent).
 * Only `refresh` (npm run onboard -- --refresh-snapshot) reads cw.seed_utilities again and replaces the view. The script uses
 * the gateway's onboard allowlist and logs every statement to data/evidence/sql_log.jsonl.
 */
export function ensureSnapshot(opts: { refresh: boolean; log?: (l: string) => void }): SnapshotReport {
  const py = join(REPO_ROOT, ".venv", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");
  const args = ["-X", "utf8", join(REPO_ROOT, "scripts", "make_cw_snapshot.py"), "--apply", ...(opts.refresh ? ["--read"] : [])];
  const r = spawnSync(existsSync(py) ? py : "python", args, { cwd: REPO_ROOT, encoding: "utf8", timeout: 300_000 });
  const lines = (r.stdout ?? "").split(/\r?\n/u).filter((l) => l.trim().startsWith("{"));
  const base: SnapshotReport = { view: "cw.seed_submissions_snapshot", status: "failed", rows: null, snapshot_at: null, read: null, statements: [], error: null };
  if (r.status !== 0 || !lines.length) return { ...base, error: `make_cw_snapshot.py exit ${r.status}: ${(r.stderr ?? "").split(/\r?\n/u).filter((l) => l && !l.startsWith("SLF4J")).slice(-2).join(" ").slice(0, 300)}` };
  const out = JSON.parse(lines[lines.length - 1]!) as Partial<SnapshotReport>;
  return { ...base, ...out, error: null };
}

/**
 * npm run onboard (idempotent): register_source for every verified catalogue source the manifest
 * lists that Zetaris lacks (already_registered when present), verify the governed USL (LOAD USL /
 * SHOW TABLES; it is never re-compiled, never dropped, never altered), RUN DQ for the six FK rules
 * one at a time (900 s bound, one retry on a source error), SHOW DQ INVALID RECORD for every rule
 * with invalid rows, and write <data>/dq/latest.json.
 */
export async function onboard(rt: Runtime, opts: { log?: (l: string) => void; skipDq?: boolean; refreshSnapshot?: boolean; snapshot?: typeof ensureSnapshot } = {}): Promise<OnboardReport> {
  const log = opts.log ?? rt.log;
  const t0 = performance.now();
  const started = new Date().toISOString();
  const evidence = new EvidenceStore();
  const inputs = loadCatalogueInputs(REPO_ROOT);
  const registered = registeredObjects(inputs.manifest);
  // The registrable sources of the catalogue, one plan per concrete object the manifest lists.
  const wanted: { catalogue_id: string; params: Record<string, string> }[] = [{ catalogue_id: "noaa_ghcn_stations", params: {} }];
  for (const o of registered) {
    let m = /^cw\.fema_declarations_dr_(\d{4})q([1-4])$/u.exec(o);
    if (m) wanted.push({ catalogue_id: "openfema_disaster_declarations", params: { quarter: `CY${m[1]}Q${m[2]}` } });
    m = /^cw\.frames_([A-Za-z]+)_(CY\d{4}Q[1-3])$/u.exec(o);
    if (m) wanted.push({ catalogue_id: "sec_frames", params: { tag: m[1]!, period: m[2]! } });
    m = /^cw\.ghcn_(\d{4})_(tmax|tmin)$/u.exec(o);
    if (m) wanted.push({ catalogue_id: "noaa_ghcn_by_year", params: { year: m[1]!, element: m[2]!.toUpperCase() } });
  }
  const registrations: OnboardReport["registrations"] = [];
  for (const w of wanted) {
    const entry = (inputs.catalogue as { entries: { id: string; status: string }[] }).entries.find((e) => e.id === w.catalogue_id);
    if (entry?.status !== "verified") continue;
    const { object } = registrationPlan(w.catalogue_id, w.params, inputs.catalogue);
    try {
      const r = await registerSource(w.catalogue_id, w.params, { registrar: rt.registrar as never, catalogue: inputs.catalogue, gateway: null, runId: evidence.runId });
      registrations.push(r);
      rt.hmem.rememberSource({ object: r.object, catalogueId: r.catalogue_id, params: r.params, status: r.status, rows: r.rows, runId: evidence.runId, at: new Date().toISOString(), contractId: r.contract_id, evidenceId: null });
      log(`  register_source ${w.catalogue_id} ${JSON.stringify(w.params)}: ${r.status} ${r.object} (${r.elapsed_ms} ms)`);
    } catch (e) {
      registrations.push({ ...w, object, error: (e as Error).message.slice(0, 200) });
      log(`  register_source ${w.catalogue_id} ${JSON.stringify(w.params)}: FAILED ${(e as Error).message.slice(0, 160)}`);
    }
  }
  // D15: the SEC submissions snapshot the question path reads instead of cw.seed_utilities (idempotent; refreshed only on request).
  const snapshot = (opts.snapshot ?? ensureSnapshot)({ refresh: !!opts.refreshSnapshot, log });
  log(`  snapshot ${snapshot.view}: ${snapshot.status} (${snapshot.rows ?? "?"} rows, taken ${snapshot.snapshot_at ?? "?"})${snapshot.read ? `; cw.seed_utilities read once in ${snapshot.read.elapsed_ms} ms` : ""}${snapshot.error ? ` FAILED ${snapshot.error}` : ""}`);
  // The governed USL: verified, never recompiled here (it exists; a differing plan would compile as crosswalk_usl_v<n>).
  const u0 = performance.now();
  let tables: string[] = [];
  let rules = 0;
  try {
    const t = await rt.gateway.template("usl_tables", {});
    tables = t.rows.map((r) => String(r[r.length > 1 ? 1 : 0] ?? r[0]));
    const d = await rt.gateway.template("usl_dq_rules", {});
    rules = d.rows.length;
    log(`  USL lightning.metastore.crosswalk.crosswalk_usl: ${tables.length} tables, ${rules} DQ rules (${Math.round(performance.now() - u0)} ms)`);
  } catch (e) {
    log(`  USL check FAILED: ${(e as Error).message.slice(0, 200)}`);
  }
  const usl = { tables, rules, ok: tables.length >= 7, elapsed_ms: Math.round(performance.now() - u0) };
  // RUN DQ, one rule at a time, bounded and retried once (D2).
  const previous = readDqFile(DQ_FILE);
  const dqRules: OnboardReport["dq"]["rules"] = [];
  const invalidRows: OnboardReport["dq"]["invalid_rows"] = [];
  if (opts.skipDq && previous) {
    log("  DQ skipped (--skip-dq); the previous file stays");
  } else {
    for (const rule of DQ_RULES) {
      let attempts = 0;
      let last: OnboardReport["dq"]["rules"][number] | null = null;
      while (attempts < 2) {
        attempts += 1;
        const s = performance.now();
        try {
          const r = await rt.gateway.template("dq_run", { rule });
          const p = parseDqRun(r);
          last = { rule, ...p, elapsed_s: Math.round(performance.now() - s) / 1000, sql: r.sql ?? null, error: null, attempts };
          break;
        } catch (e) {
          last = { rule, total: null, valid: null, invalid: null, elapsed_s: Math.round(performance.now() - s) / 1000, sql: null, error: (e as Error).message.slice(0, 200), attempts };
        }
      }
      dqRules.push(last!);
      log(`  RUN DQ ${rule}: ${last!.error ? `FAILED ${last!.error}` : `${last!.total} total, ${last!.valid} valid, ${last!.invalid} invalid`} (${last!.elapsed_s} s, ${attempts} attempt(s))`);
      if (!last!.error && (last!.invalid ?? 0) > 0) {
        const s = performance.now();
        try {
          const inv = await rt.gateway.template("dq_invalid", { rule });
          for (const row of inv.rows) invalidRows.push({ rule, row });
          log(`  SHOW DQ INVALID RECORD ${rule}: ${inv.rows.length} row(s) ${JSON.stringify(inv.rows).slice(0, 200)} (${Math.round((performance.now() - s) / 100) / 10} s)`);
        } catch (e) {
          log(`  SHOW DQ INVALID RECORD ${rule}: FAILED ${(e as Error).message.slice(0, 160)}`);
        }
      }
    }
    mkdirSync(fileURLToPath(new URL("dq/", DATA_DIR_URL)), { recursive: true });
    writeFileSync(DQ_FILE, `${JSON.stringify({ ran_at: started, rules: dqRules, invalid_rows: invalidRows }, null, 2)}\n`, "utf8");
  }
  const file = readDqFile(DQ_FILE);
  return {
    started_at: started,
    wall_ms: Math.round(performance.now() - t0),
    registrations,
    usl,
    dq: { ran_at: file?.ran_at ?? started, rules: dqRules.length ? dqRules : (file?.rules ?? []).map((r) => ({ rule: r.rule, total: r.total, valid: r.valid, invalid: r.invalid, elapsed_s: (r.elapsed_ms ?? 0) / 1000, sql: r.sql, error: r.error, attempts: 1 })), invalid_rows: invalidRows.length ? invalidRows : ((file?.invalid_rows ?? []) as { rule: string; row: unknown[] }[]) },
    dq_file: DQ_FILE,
    snapshot,
  };
}
