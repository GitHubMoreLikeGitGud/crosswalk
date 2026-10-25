// Non-secret runtime settings. Values already in the environment win; for the keys
// below that are unset, the repo-root .env.local is read. No other key is ever read
// from that file, so credentials and the contract secret never enter the agent process.
// Every runtime data path (runs, hmem, world, evidence, dq, contracts, agent.lock, eval,
// markovian) derives from CW_DATA_DIR (default <repo>/data), so a server and the CLI
// can work on separate copies of the state.
// Adapted from Weather-or-Not and ClearShelf (same author, Apache-2.0).

import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT_URL = new URL("../../", import.meta.url);
export const REPO_ROOT = fileURLToPath(REPO_ROOT_URL);

export const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8803";
export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
export const DEFAULT_MODEL = "nemotron-3-nano:4b";
export const DEFAULT_UI_PORT = 8804;

const ALLOWED_KEYS = [
  "GATEWAY_URL",
  "OLLAMA_URL",
  "CW_MODEL",
  "CW_MODEL_FALLBACK",
  "CW_THINK",
  "CW_MIN_AVAILABLE_RAM_MIB",
  "CW_DATA_DIR",
  "UI_PORT",
  "ZETARIS_GETTING_STARTED_DIR",
] as const;
type Key = (typeof ALLOWED_KEYS)[number];

export interface Config {
  gatewayUrl: string;
  ollamaUrl: string;
  model: string;
  repoRoot: string;
  dataDir: string;
  uiPort: number;
}

function parseEnvFile(text: string): Partial<Record<Key, string>> {
  const out: Partial<Record<Key, string>> = {};
  for (const line of text.split(/\r?\n/u)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/u.exec(line);
    if (!m) continue;
    const key = m[1] as Key;
    if (!(ALLOWED_KEYS as readonly string[]).includes(key)) continue;
    let value = m[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

let envFileApplied = false;

/** Copies the allowed keys of .env.local into the environment where the environment is silent (once). */
function applyEnvFile(): void {
  if (envFileApplied) return;
  envFileApplied = true;
  const envPath = fileURLToPath(new URL(".env.local", REPO_ROOT_URL));
  const fromFile = existsSync(envPath) ? parseEnvFile(readFileSync(envPath, "utf8")) : {};
  for (const key of ALLOWED_KEYS) {
    const v = fromFile[key];
    if (process.env[key] === undefined && v !== undefined && v !== "") process.env[key] = v;
  }
}

function resolveDataDir(): string {
  applyEnvFile();
  const raw = process.env.CW_DATA_DIR?.trim();
  return raw ? resolve(raw) : fileURLToPath(new URL("data", REPO_ROOT_URL));
}

/** The data directory: CW_DATA_DIR (environment, then .env.local; a relative value is taken from the working directory), default <repo>/data. Absolute, no trailing separator. */
export const DATA_DIR = resolveDataDir();
/** The same directory as a file URL with a trailing slash, so `new URL("runs/", DATA_DIR_URL)` names a child. */
export const DATA_DIR_URL = pathToFileURL(DATA_DIR.endsWith(sep) ? DATA_DIR : `${DATA_DIR}${sep}`);

/** A path under the data directory, from a relative POSIX-style path ("runs/", "dq/latest.json"). */
export function dataPath(rel: string): string {
  return fileURLToPath(new URL(rel, DATA_DIR_URL));
}

/** Every runtime data path, derived from DATA_DIR. Directories carry the platform's trailing separator. */
export const DATA_PATHS = {
  root: DATA_DIR,
  runs: dataPath("runs/"),
  hmem: dataPath("hmem/"),
  world: dataPath("world/"),
  evidence: dataPath("evidence/"),
  dq: dataPath("dq/"),
  dqLatest: dataPath("dq/latest.json"),
  contracts: dataPath("contracts/"),
  contractsLog: dataPath("contracts/issued-agent.jsonl"),
  lock: dataPath("agent.lock"),
  eval: dataPath("eval/"),
  evalReport: dataPath("eval/report.json"),
  markovian: dataPath("markovian/"),
} as const;

function parsePort(raw: string | undefined, fallback: number): number {
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

let loaded: Config | null = null;

export function loadConfig(): Config {
  if (loaded) return loaded;
  applyEnvFile();
  loaded = {
    gatewayUrl: process.env.GATEWAY_URL ?? DEFAULT_GATEWAY_URL,
    ollamaUrl: process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL,
    model: process.env.CW_MODEL ?? DEFAULT_MODEL,
    repoRoot: REPO_ROOT,
    dataDir: DATA_DIR,
    uiPort: parsePort(process.env.UI_PORT, DEFAULT_UI_PORT),
  };
  return loaded;
}
