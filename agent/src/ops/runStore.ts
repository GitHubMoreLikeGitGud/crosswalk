// Saved runs: data/runs/<runId>/run.json (the whole RunResult: card, memo, chunks, evidence
// ids and records, telemetry) and data/runs/index.json (every run and the latest per
// utility and period). The CLI's replay and the server's /api/runs read from here.
// Adapted from Weather-or-Not and ClearShelf (same author, Apache-2.0).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DATA_DIR_URL } from "../config.ts";
import type { RunResult } from "../loop/investigate.ts";

export interface RunOrigin {
  source: "cli" | "server" | "test";
  note?: string;
}

export interface RunIndexEntry {
  run_id: string;
  cik: string;
  period: string;
  claim: string;
  utility: string | null;
  verdict: string | null;
  confidence: string | null;
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

export class RunStore {
  readonly dir: string | null;
  private readonly mem = new Map<string, SavedRun>();
  private index: RunIndex = { runs: [], latest: {} };

  /** `dir` null keeps runs in memory only (tests). */
  constructor(dir: string | null = RUNS_DIR) {
    this.dir = dir ? dir.replace(/[\\/]$/u, "") : null;
    if (this.dir) {
      mkdirSync(this.dir, { recursive: true });
      this.reloadIndex();
    }
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
      cik: r.cik,
      period: r.period,
      claim: r.claim,
      utility: r.card.utility?.name ?? null,
      verdict: r.card.verdict?.verdict ?? null,
      confidence: r.card.verdict?.confidence ?? null,
      started_at: r.started_at,
      wall_ms: r.wall_ms,
      chunks: r.markovian.chunks,
      memo_source: r.card.memo?.source ?? null,
      source: origin.source,
    };
    this.index.runs = [...this.index.runs.filter((x) => x.run_id !== r.run_id), entry];
    this.index.latest[`${r.cik}|${r.period}`] = r.run_id;
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
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as SavedRun) : null;
  }

  list(): RunIndexEntry[] {
    this.reloadIndex();
    return [...this.index.runs].sort((a, b) => b.started_at.localeCompare(a.started_at));
  }

  latestId(cik: string, period: string): string | null {
    this.reloadIndex();
    return this.index.latest[`${cik}|${period}`] ?? null;
  }

  latest(cik: string, period: string): SavedRun | null {
    const id = this.latestId(cik, period);
    return id ? this.load(id) : null;
  }

  /** The path of a saved run's file. */
  pathOf(id: string): string | null {
    return this.dir ? `${this.dir}/${id}/run.json` : null;
  }
}
