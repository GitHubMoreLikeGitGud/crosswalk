// Writes the evaluation report from files only: the runs named in docs/eval/runs.json, read from
// <data>/runs/<id>/run.json (data = CW_DATA_DIR, else <repo>/data) or from any extra directory given
// with --runs; docs/eval/outside-checks.json (src/eval/outside.ts); docs/eval/manual-baseline.json
// (src/eval/manual.ts); and the ablation driver's GPU samples (--gpu <dir>: driver.log plus one
// <tag>.smi.csv and <tag>.out per run). Outputs: docs/eval-report.md, docs/eval/summary.json and
// <data>/eval/report.json (served by GET /api/eval). No gateway call, no model call.
//
//   npx tsx src/eval/run.ts [--runs <dir>]... [--gpu <dir>]... [--data <dir>] [--docs <dir>]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReport, renderMarkdown, type EvalRun, type GpuSamples, type ManualSession, type OllamaPs, type OutsideChecks, type Selection } from "./report.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function findRun(id: string, dirs: string[]): EvalRun | null {
  for (const d of dirs) {
    const p = join(d, id, "run.json");
    if (existsSync(p)) return readJson<EvalRun>(p);
  }
  return null;
}

function parsePs(text: string | undefined): OllamaPs | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as OllamaPs;
  } catch {
    return null;
  }
}

/** GPU samples of the ablation driver: driver.log names each tag's start and end with Ollama /api/ps reads; <tag>.out names the run id. */
export function readGpuDir(dir: string): GpuSamples[] {
  const log = join(dir, "driver.log");
  if (!existsSync(log)) return [];
  const starts = new Map<string, string>();
  const ends = new Map<string, string>();
  for (const line of readFileSync(log, "utf8").replace(/^﻿/u, "").split(/\r?\n/u)) {
    const s = /^﻿?start (\S+) \S+ ollama_ps_before (.*)$/u.exec(line);
    if (s) starts.set(s[1]!, s[2]!);
    const e = /^﻿?end (\S+) .*? ollama_ps_mid (.*)$/u.exec(line);
    if (e) ends.set(e[1]!, e[2]!);
  }
  const out: GpuSamples[] = [];
  for (const tag of starts.keys()) {
    const outFile = join(dir, `${tag}.out`);
    const smiFile = join(dir, `${tag}.smi.csv`);
    if (!existsSync(outFile) || !existsSync(smiFile)) continue;
    const m = /runs[\\/](r\d{8}T\d{6}[0-9a-f]{4})[\\/]run\.json/u.exec(readFileSync(outFile, "utf8"));
    if (!m) continue;
    const samples = readFileSync(smiFile, "utf8")
      .split(/\r?\n/u)
      .map((l) => l.split(",").map((x) => x.trim()))
      .filter((p) => p.length === 3 && /^\d+$/u.test(p[1]!) && /^\d+$/u.test(p[2]!))
      .map((p) => ({ at: p[0]!, mem_mib: Number(p[1]), util_pct: Number(p[2]) }));
    const [mid, after] = (ends.get(tag) ?? "").split(" ollama_ps_after ");
    out.push({ run_id: m[1]!, samples, ollama_before: parsePs(starts.get(tag)), ollama_mid: parsePs(mid), ollama_after: parsePs(after) });
  }
  return out;
}

function parseArgs(argv: string[]): { runs: string[]; gpu: string[]; data: string; docs: string } {
  const runs: string[] = [];
  const gpu: string[] = [];
  let data = process.env.CW_DATA_DIR ? resolve(process.env.CW_DATA_DIR) : join(REPO_ROOT, "data");
  let docs = join(REPO_ROOT, "docs");
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const v = argv[i + 1];
    if (a === "--runs" && v) (runs.push(resolve(v)), i++);
    else if (a === "--gpu" && v) (gpu.push(resolve(v)), i++);
    else if (a === "--data" && v) (data = resolve(v), i++);
    else if (a === "--docs" && v) (docs = resolve(v), i++);
    else throw new Error(`unknown argument ${a}`);
  }
  return { runs, gpu, data, docs };
}

export function main(argv = process.argv.slice(2)): void {
  const args = parseArgs(argv);
  const evalDocs = join(args.docs, "eval");
  const selection = readJson<Selection>(join(evalDocs, "runs.json"));
  const dirs = [join(args.data, "runs"), ...args.runs];
  const runs = new Map<string, EvalRun>();
  for (const id of [...selection.runs.map((r) => r.run_id), ...(selection.references ?? []).map((r) => r.run_id)]) {
    const run = findRun(id, dirs);
    if (run) runs.set(id, run);
  }
  const outsidePath = join(evalDocs, "outside-checks.json");
  const manualPath = join(evalDocs, "manual-baseline.json");
  const report = buildReport({
    selection,
    runs,
    gpu: args.gpu.flatMap(readGpuDir),
    manual: existsSync(manualPath) ? readJson<ManualSession>(manualPath) : null,
    outside: existsSync(outsidePath) ? readJson<OutsideChecks>(outsidePath) : null,
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  mkdirSync(join(args.data, "eval"), { recursive: true });
  writeFileSync(join(args.data, "eval", "report.json"), json, "utf8");
  writeFileSync(join(evalDocs, "summary.json"), json, "utf8");
  writeFileSync(join(args.docs, "eval-report.md"), `${renderMarkdown(report)}\n`, "utf8");
  console.log(`runs ${report.runs.length}: ${report.runs.map((r) => `${r.run_id} ${r.mode} ${r.setting} ${r.wall_s} s`).join("; ")}`);
  console.log(`reproducibility: ${report.reproducibility.pairs.length} pairs, answers identical ${report.reproducibility.all_answers_identical}, governed keys identical ${report.reproducibility.governed_join_map_identical}`);
  console.log(`L2: model ${JSON.stringify(report.l2.totals.model)} baseline ${JSON.stringify(report.l2.totals.baseline)} winner ${report.l2.winner}`);
  console.log(`ablation: ${report.ablation.map((a) => `${a.setting} ${a.wall_s} s peak ${a.gpu?.mem_peak_mib ?? "n/a"} MiB`).join("; ")}`);
  console.log(`wrote docs/eval-report.md, docs/eval/summary.json and ${join(args.data, "eval", "report.json")}`);
}

const invoked = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invoked) main();
