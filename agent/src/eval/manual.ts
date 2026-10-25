// Manual baseline (judge lesson L6): the statements a data person runs by hand to find and verify
// the five join keys with the same sources, one statement at a time through the gateway's reader
// templates (DESCRIBE, SELECT ... LIMIT 5, distinct counts, a match-rate count and its orphans),
// with what each result showed and the decision taken after reading it. The session log is
// <data>/eval/manual-session.jsonl; `finish` writes docs/eval/manual-baseline.json.
//
//   npx tsx src/eval/manual.ts run <template> [name=value ...]     one statement, printed
//   npx tsx src/eval/manual.ts lookup "<what was looked up>"        a lookup without a statement
//   npx tsx src/eval/manual.ts note <n> --result "<text>" --decision "<text>"
//   npx tsx src/eval/manual.ts key <key> <VERDICT> <matched> <total> [orphan ...]
//   npx tsx src/eval/manual.ts finish --label "<label>" --note "<text>"

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_PATHS, loadConfig, REPO_ROOT } from "../config.ts";
import { GatewayClient } from "../zetaris/client.ts";
import type { ManualSession, ManualStep } from "./report.ts";

const LOG = join(DATA_PATHS.eval, "manual-session.jsonl");

interface LogLine {
  kind: "step" | "note" | "key";
  step?: ManualStep;
  n?: number;
  result?: string;
  decision?: string;
  key?: { key: string; verdict: string; matched: number; total: number; orphans: string[] };
}

function readLog(): LogLine[] {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf8")
    .split(/\r?\n/u)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LogLine);
}

function append(line: LogLine): void {
  mkdirSync(dirname(LOG), { recursive: true });
  appendFileSync(LOG, `${JSON.stringify(line)}\n`, "utf8");
}

function flag(argv: string[], name: string): string {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : "";
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [cmd, ...rest] = argv;
  const steps = readLog().filter((l) => l.kind === "step").length;
  if (cmd === "run") {
    const template = rest[0]!;
    const params: Record<string, string> = {};
    for (const p of rest.slice(1)) {
      const i = p.indexOf("=");
      params[p.slice(0, i)] = p.slice(i + 1);
    }
    const gw = new GatewayClient({ baseUrl: loadConfig().gatewayUrl });
    const at = new Date().toISOString();
    const t0 = performance.now();
    let step: ManualStep;
    try {
      const r = await gw.template(template, params);
      step = { n: steps + 1, at, template, params, elapsed_ms: r.elapsed_ms, wall_ms: Math.round(performance.now() - t0), rows: r.row_count, result: "", decision: "" };
      console.log(`#${step.n} ${template} ${r.elapsed_ms} ms, ${r.row_count} rows, cache ${r.cache_state}`);
      console.log(`sql: ${r.sql}`);
      console.log(r.columns.join(" | "));
      for (const row of r.rows.slice(0, 15)) console.log(row.map((v) => String(v)).join(" | "));
    } catch (e) {
      step = { n: steps + 1, at, template, params, elapsed_ms: 0, wall_ms: Math.round(performance.now() - t0), rows: 0, result: "", decision: "", error: (e as Error).message.slice(0, 300) };
      console.log(`#${step.n} ${template} failed: ${step.error}`);
    }
    append({ kind: "step", step });
    return;
  }
  if (cmd === "lookup") {
    const step: ManualStep = { n: steps + 1, at: new Date().toISOString(), template: "lookup", params: { what: rest[0] ?? "" }, elapsed_ms: 0, rows: 0, result: "", decision: "" };
    append({ kind: "step", step });
    console.log(`#${step.n} lookup: ${rest[0]}`);
    return;
  }
  if (cmd === "note") {
    append({ kind: "note", n: Number(rest[0]), result: flag(rest, "--result"), decision: flag(rest, "--decision") });
    return;
  }
  if (cmd === "key") {
    const [key, verdict, matched, total, ...orphans] = rest;
    append({ kind: "key", key: { key: key!, verdict: verdict!, matched: Number(matched), total: Number(total), orphans } });
    return;
  }
  if (cmd === "finish") {
    const log = readLog();
    const byN = new Map<number, ManualStep>();
    for (const l of log) if (l.kind === "step" && l.step) byN.set(l.step.n, l.step);
    for (const l of log) {
      if (l.kind !== "note" || !byN.has(l.n!)) continue;
      const s = byN.get(l.n!)!;
      if (l.result) s.result = l.result;
      if (l.decision) s.decision = l.decision;
    }
    const all = [...byN.values()].sort((a, b) => a.n - b.n);
    const last = all[all.length - 1]!;
    const session: ManualSession = {
      label: flag(rest, "--label") || "measured",
      note: flag(rest, "--note"),
      started_at: all[0]!.at,
      finished_at: new Date(Date.parse(last.at) + (last.wall_ms ?? last.elapsed_ms)).toISOString(),
      steps: all,
      keys: log.filter((l) => l.kind === "key").map((l) => l.key!),
    };
    const out = resolve(flag(rest, "--out") || join(REPO_ROOT, "docs", "eval", "manual-baseline.json"));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(session, null, 2)}\n`, "utf8");
    console.log(`wrote ${out}: ${all.length} steps, ${session.keys.length} keys`);
    return;
  }
  throw new Error("usage: manual.ts run <template> [k=v ...] | lookup <what> | note <n> --result <t> --decision <t> | key <key> <VERDICT> <matched> <total> [orphans] | finish --label <l> --note <t>");
}

const invoked = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invoked) await main();
