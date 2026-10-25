// Writes the evaluation report from files only: every data/runs/<id>/run.json (plus any extra
// directory of saved run files given with --runs), data/dq/latest.json and data/eval/joinmap.json
// (scripts/eval_joinmap.py). Outputs: data/eval/report.json, docs/eval-report.json (the same
// document) and docs/eval-report.md. No gateway call, no model call.
//
//   npx tsx src/eval/run.ts [--runs <dir>]... [--data <dir>] [--docs <dir>]
//
// The data directory is CW_DATA_DIR when set, else <repo>/data.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReport, renderMarkdown, type DqFile, type EvalRun, type JoinMapFile, type SeedStation, type SeedUtility } from "./report.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function isRun(x: unknown): x is EvalRun {
  const r = x as Partial<EvalRun> | null;
  return !!r && typeof r === "object" && typeof r.run_id === "string" && typeof r.cik === "string" && !!r.summary && !!r.card;
}

/** Run files in a directory: <dir>/<id>/run.json (the run store) and <dir>/*.json (saved copies). */
function collectRuns(dir: string, label: string): { run: EvalRun; source: string }[] {
  const out: { run: EvalRun; source: string }[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let doc: unknown;
    try {
      if (statSync(p).isDirectory()) {
        const f = join(p, "run.json");
        if (!existsSync(f)) continue;
        doc = readJson(f);
      } else if (name.endsWith(".json")) {
        doc = readJson(p);
      } else continue;
    } catch {
      continue;
    }
    if (isRun(doc)) out.push({ run: doc, source: label });
  }
  return out;
}

function parseArgs(argv: string[]): { runs: string[]; data: string; docs: string } {
  const extra: string[] = [];
  let data = process.env.CW_DATA_DIR ? resolve(process.env.CW_DATA_DIR) : join(REPO_ROOT, "data");
  let docs = join(REPO_ROOT, "docs");
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const v = argv[i + 1];
    if (a === "--runs" && v) {
      extra.push(resolve(v));
      i++;
    } else if (a === "--data" && v) {
      data = resolve(v);
      i++;
    } else if (a === "--docs" && v) {
      docs = resolve(v);
      i++;
    } else {
      throw new Error(`unknown argument ${a}`);
    }
  }
  return { runs: extra, data, docs };
}

export function main(argv = process.argv.slice(2)): void {
  const args = parseArgs(argv);
  const seen = new Map<string, { run: EvalRun; source: string }>();
  for (const r of collectRuns(join(args.data, "runs"), "data/runs")) seen.set(r.run.run_id, r);
  args.runs.forEach((dir, i) => {
    for (const r of collectRuns(dir, `saved copy ${i + 1}`)) if (!seen.has(r.run.run_id)) seen.set(r.run.run_id, r);
  });
  const dqPath = join(args.data, "dq", "latest.json");
  const jmPath = join(args.data, "eval", "joinmap.json");
  const dq = existsSync(dqPath) ? readJson<DqFile>(dqPath) : null;
  const joinmap = existsSync(jmPath) ? readJson<JoinMapFile>(jmPath) : null;
  const utilities = readJson<{ utilities: SeedUtility[] }>(join(REPO_ROOT, "seeds", "utilities.json")).utilities;
  const stations = readJson<{ stations: SeedStation[] }>(join(REPO_ROOT, "seeds", "stations.json")).stations;

  const report = buildReport({ runs: [...seen.values()], dq, joinmap, utilities, stations });
  const md = renderMarkdown(report);
  const json = `${JSON.stringify(report, null, 2)}\n`;

  const evalDir = join(args.data, "eval");
  mkdirSync(evalDir, { recursive: true });
  mkdirSync(args.docs, { recursive: true });
  writeFileSync(join(evalDir, "report.json"), json, "utf8");
  writeFileSync(join(args.docs, "eval-report.json"), json, "utf8");
  writeFileSync(join(args.docs, "eval-report.md"), `${md}\n`, "utf8");

  const t = report.totals;
  console.log(`runs ${report.runs.length} (${report.runs.map((r) => `${r.run_id} ${r.mode}`).join(", ")})`);
  console.log(`planner ${t.planner_calls} calls, ${t.valid_first_try} valid first try, ${t.repaired} repaired, ${t.fallbacks} fallback; evidence ${t.evidence_complete}/${t.evidence_records}; claims ${t.claims_with_evidence}/${t.claims}`);
  console.log(`coverage: ${report.coverage.summary.with_every_station}/${report.coverage.summary.utilities} utilities covered from run ${report.coverage.from_run ?? "n/a"}; dq ${dq ? "present" : "absent"}; joinmap ${joinmap ? "present" : "absent"}`);
  console.log(`wrote ${join(evalDir, "report.json")}, ${join(args.docs, "eval-report.json")}, ${join(args.docs, "eval-report.md")}`);
}

const invoked = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invoked) main();
