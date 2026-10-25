// Saved runs: data/runs/<runId>/run.json (the whole RunResult: card, memo, chunks, evidence
// ids and records, telemetry) and data/runs/index.json (every run and the latest per
// quarter and mode). The CLI's replay and the server's /api/runs read from here.
// Adapted from Weather-or-Not and ClearShelf (same author, Apache-2.0).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DATA_DIR_URL, REPO_ROOT_URL } from "../config.ts";
import type { RunResult } from "../loop/investigate.ts";

export interface RunOrigin {
  source: "cli" | "server" | "test" | "demo";
  note?: string;
}

export interface RunIndexEntry {
  run_id: string;
  quarter: string;
  mode: string;
  question: string;
  utilities: number;
  keys: number;
  skipped: number;
  started_at: string;
  wall_ms: number;
  chunks: number;
  memo_source: string | null;
  source: RunOrigin["source"];
}

export interface RunIndex {
  runs: RunIndexEntry[];
  latest: Record<string, string>;
}

export type SavedRun = RunResult & { saved: RunOrigin & { at: string } };

export const RUNS_DIR = fileURLToPath(new URL("runs/", DATA_DIR_URL));
/** One redacted saved run committed for a fresh clone (scripts/make_demo_run.py); listed only while RUNS_DIR holds no run. */
export const DEMO_RUNS_DIR = fileURLToPath(new URL("docs/demo-run/runs/", REPO_ROOT_URL));
/** The onboarding DQ counts that go with the demo run, read only while data/dq/latest.json is absent. */
export const DEMO_DQ_FILE = fileURLToPath(new URL("docs/demo-run/dq/latest.json", REPO_ROOT_URL));

export class RunStore {
  readonly dir: string | null;
  private readonly mem = new Map<string, SavedRun>();
  private index: RunIndex = { runs: [], latest: {} };

  private readonly demoDir: string | null;

  /** `dir` null keeps runs in memory only (tests). `demoDir`, when given, is read only while this store holds no run. */
  constructor(dir: string | null = RUNS_DIR, demoDir: string | null = null) {
    this.dir = dir ? dir.replace(/[\\/]$/u, "") : null;
    this.demoDir = demoDir && existsSync(`${demoDir.replace(/[\\/]$/u, "")}/index.json`) ? demoDir.replace(/[\\/]$/u, "") : null;
    if (this.dir) {
      mkdirSync(this.dir, { recursive: true });
      this.reloadIndex();
    }
  }

  /** The committed demo store, while this store has no run of its own. */
  private demo(): RunStore | null {
    if (!this.demoDir || this.mem.size > 0 || this.index.runs.length > 0) return null;
    return new RunStore(this.demoDir);
  }

  /** True while the listed runs are the committed demo run. */
  servingDemo(): boolean {
    this.reloadIndex();
    return this.demo() !== null;
  }

  private get indexPath(): string | null {
    return this.dir ? `${this.dir}/index.json` : null;
  }

  private reloadIndex(): void {
    const p = this.indexPath;
    if (!p || !existsSync(p)) return;
    try {
      const idx = JSON.parse(readFileSync(p, "utf8")) as RunIndex;
      this.index = { runs: idx.runs ?? [], latest: idx.latest ?? {} };
    } catch {
      // an unreadable index is rebuilt from the next saves
    }
  }

  private write(path: string, text: string): void {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, path);
  }

  /** Saves the run under data/runs/<id>/run.json and makes it the latest for its utility and period. */
  save(r: RunResult, origin: RunOrigin): SavedRun {
    const run: SavedRun = { ...r, saved: { ...origin, at: new Date().toISOString() } };
    this.mem.set(r.run_id, run);
    this.reloadIndex();
    const entry: RunIndexEntry = {
      run_id: r.run_id,
      quarter: r.quarter,
      mode: r.mode,
      question: r.question,
      utilities: r.answer?.rows.length ?? 0,
      keys: r.join_map.length,
      skipped: r.telemetry.skipped_chunks,
      started_at: r.started_at,
      wall_ms: r.wall_ms,
      chunks: r.markovian.chunks,
      memo_source: r.memo?.source ?? null,
      source: origin.source,
    };
    this.index.runs = [...this.index.runs.filter((x) => x.run_id !== r.run_id), entry];
    this.index.latest[`${r.quarter}|${r.mode}`] = r.run_id;
    if (this.dir) {
      mkdirSync(`${this.dir}/${r.run_id}`, { recursive: true });
      this.write(`${this.dir}/${r.run_id}/run.json`, `${JSON.stringify(run, null, 2)}\n`);
      this.write(this.indexPath!, `${JSON.stringify(this.index, null, 1)}\n`);
    }
    return run;
  }

  load(id: string): SavedRun | null {
    const m = this.mem.get(id);
    if (m) return m;
    if (!this.dir) return null;
    const p = `${this.dir}/${id}/run.json`;
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")) as SavedRun;
    this.reloadIndex();
    return this.demo()?.load(id) ?? null;
  }

  list(): RunIndexEntry[] {
    this.reloadIndex();
    const demo = this.demo();
    if (demo) return demo.list();
    return [...this.index.runs].sort((a, b) => b.started_at.localeCompare(a.started_at));
  }

  latestId(quarter: string, mode = "cold"): string | null {
    this.reloadIndex();
    return this.index.latest[`${quarter}|${mode}`] ?? this.demo()?.latestId(quarter, mode) ?? null;
  }

  latest(quarter: string, mode = "cold"): SavedRun | null {
    const id = this.latestId(quarter, mode);
    return id ? this.load(id) : null;
  }

  /** The path of a saved run's file. */
  pathOf(id: string): string | null {
    return this.dir ? `${this.dir}/${id}/run.json` : null;
  }
}
