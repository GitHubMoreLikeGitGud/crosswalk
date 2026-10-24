// The agent runtime shared by the CLI and the server: the gateway client, the Ollama client,
// H-MEM (data/hmem), the World Model (data/world), the run store (data/runs) and the
// registrar port that signs execution contracts. Commands that open data/hmem and
// data/world take data/agent.lock, so two processes never write the stores at once.
// Adapted from ClearShelf (same author, Apache-2.0).

import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DATA_DIR_URL, loadConfig } from "./config.ts";
import { issueContract, loadContractSecret } from "./contract/scout.ts";
import { EvidenceStore } from "./evidence/store.ts";
import { OllamaClient } from "./llm/ollama.ts";
import { investigate, type InvestigateOptions, type RunResult } from "./loop/investigate.ts";
import type { RegistrarAction, RegistrarPort, ToolDeps } from "./loop/tools.ts";
import { openMemory, type HMEM } from "./memory/hmemFacade.ts";
import { seedMemory, type SeedReport } from "./memory/seed.ts";
import { RunStore } from "./ops/runStore.ts";
import { loadSeeds, type Seeds } from "./seeds.ts";
import { WeatherWorld } from "./world/world.ts";
import { GatewayClient, type RegistrarResult } from "./zetaris/client.ts";

export const LOCK_FILE = fileURLToPath(new URL("agent.lock", DATA_DIR_URL));
export const CONTRACTS_LOG = fileURLToPath(new URL("contracts/issued-agent.jsonl", DATA_DIR_URL));

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

/** Takes data/agent.lock; refuses while another live process holds it. */
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
      // a stale or unreadable lock is replaced
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

/** Signs a medium-risk contract for a registrar plan and posts it; the contract id and parameters are logged (never the signature). */
export function registrarPort(gateway: GatewayClient, user = "won-agent"): RegistrarPort {
  return {
    async register(action: RegistrarAction, params: Record<string, string>): Promise<RegistrarResult> {
      const contract = issueContract({ action, parameters: params, user, surface: "won-agent" }, loadContractSecret());
      mkdirSync(fileURLToPath(new URL("contracts/", DATA_DIR_URL)), { recursive: true });
      appendFileSync(CONTRACTS_LOG, `${JSON.stringify({ contractId: contract.contractId, action, params, issuedAt: contract.issuedAt, expiresAt: contract.expiresAt })}\n`, "utf8");
      return gateway.registrar(action, params, contract as unknown as Record<string, unknown>);
    },
  };
}

export interface Runtime {
  gateway: GatewayClient;
  ollama: OllamaClient | null;
  hmem: HMEM;
  world: WeatherWorld;
  runs: RunStore;
  seeds: Seeds;
  registrar: RegistrarPort;
  lock: AgentLock | null;
  log: (line: string) => void;
  close(): void;
}

export interface RuntimeOptions {
  command?: string;
  /** false: no lock (tests). */
  lock?: boolean;
  /** null: no model (deterministic run). */
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
    const hmem = openMemory();
    const world = new WeatherWorld();
    return {
      gateway,
      ollama,
      hmem,
      world,
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
  cik: string;
  period: string;
  claim: string;
  think?: boolean;
  maxChunks?: number;
  onEvent?: InvestigateOptions["onEvent"];
  abortSignal?: AbortSignal;
  /** Skip the boot seed (tests). */
  noSeed?: boolean;
  /** The run id to use (the server announces it before the run starts); default: a new id. */
  runId?: string;
}

export interface AskOutcome {
  result: RunResult;
  evidence: EvidenceStore;
  seed: SeedReport | null;
}

/** Seeds memory (idempotent), runs the question and saves the run. */
export async function ask(rt: Runtime, req: AskRequest, origin: { source: "cli" | "server"; note?: string } = { source: "cli" }): Promise<AskOutcome> {
  const seed = req.noSeed ? null : await seedMemory(rt.hmem, { log: () => {} });
  const evidence = new EvidenceStore(req.runId);
  const deps: ToolDeps = { gateway: rt.gateway, ollama: rt.ollama, evidence, seeds: rt.seeds, hmem: rt.hmem, world: rt.world, registrar: rt.registrar, log: rt.log };
  const result = await investigate({ cik: req.cik, period: req.period, claim: req.claim, think: req.think, maxChunks: req.maxChunks, onEvent: req.onEvent, abortSignal: req.abortSignal }, deps);
  rt.runs.save(result, origin);
  return { result, evidence, seed };
}
