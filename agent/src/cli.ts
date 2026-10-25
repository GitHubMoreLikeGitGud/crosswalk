// Crosswalk command line.
//
//   npm run onboard [-- --skip-dq]
//        idempotent onboarding (never on the question path): register_source for every verified
//        catalogue source the manifest lists, verify the governed USL, RUN DQ for the six FK
//        rules (900 s bound each), SHOW DQ INVALID RECORD where a rule has invalid rows, and
//        write <data>/dq/latest.json
//   npm run ask -- --quarter CY2025Q1 [--cold] [--think on|off] [--max-chunks 12] [--no-model] [--json] [--out <file>]
//        the demo question of SPEC D9 for the quarter through the Markovian chain; --cold never
//        recalls key_verified memories (they are still written); the run is saved under
//        <data>/runs/<id>/run.json
//   npm run replay -- <run_id> [--json]          print a saved run (no model, no gateway)
//   npm run cli -- runs                          list the saved runs
//   npm run cli -- why <memory_id>               "why do you believe this?" for one memory
//   npm run cli -- known --cik <cik> | --left <object.column> --right <object.column>
//        "what did we know, and since when" from the World Model
//
// The commands that open <data>/hmem and <data>/world take <data>/agent.lock.
// Adapted from Weather-or-Not and ClearShelf (same author, Apache-2.0).

import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import type { EvidenceRecord } from "./evidence/store.ts";
import { OllamaClient } from "./llm/ollama.ts";
import type { RunResult } from "./loop/investigate.ts";
import { int, millions, pct } from "./loop/tools.ts";
import { RunStore } from "./ops/runStore.ts";
import { ask, onboard, openRuntime } from "./runtime.ts";
import { validateParam } from "./zetaris/client.ts";

interface Args {
  cmd: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const [cmd = "help", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { cmd, positional, flags };
}

function short(s: string, n: number): string {
  const t = s.replace(/\s+/gu, " ");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

const r3 = (x: number | null | undefined) => (x === null || x === undefined ? "n/a" : x.toFixed(3));

export function printRun(r: RunResult): string {
  const out: string[] = [];
  out.push(`Crosswalk  ${r.quarter} vs ${r.previous_quarter}  run ${r.run_id}  (${r.mode})`);
  out.push(`Question: ${r.question}`);
  out.push("");
  out.push("Join map (rate = matched rows / left rows, D1; distinct-key reading beside it):");
  for (const k of r.join_map) {
    out.push(`  ${k.id.padEnd(4)} ${(k.verdict ?? k.status).padEnd(9)} ${String(k.matched_rows ?? "?").padStart(3)}/${String(k.left_rows ?? "?").padEnd(3)} = ${r3(k.rate)}  (distinct ${k.matched_keys ?? "?"}/${k.left_keys ?? "?"})  ${k.left} ~ ${k.right} [${k.transform}]  by ${k.proposed_by.join("+") || "?"}${k.from_memory ? `  RECALLED ${k.from_memory} (measured as ${k.measured_as})` : `  ${k.elapsed_ms} ms`}`);
    if (k.orphans.length) out.push(`       orphans: ${k.orphans.join("; ")}`);
  }
  const mp = r.model_proposals;
  const bp = r.baseline_proposals;
  out.push(`Key proposals (L2): model ${mp.proposed_by ?? "none (fallback to baseline)"} made ${mp.made}: ${mp.verified} verified, ${mp.partial} partial, ${mp.rejected} rejected, ${mp.unmeasurable} not measurable, ${mp.invalid_schema} invalid; baseline made ${bp.made}: ${bp.verified} verified, ${bp.partial} partial, ${bp.rejected} rejected, ${bp.unmeasurable} not measurable`);
  out.push("Verdict mix (L3):");
  for (const v of r.verdict_mix) out.push(`  ${v.kind.padEnd(12)} ${v.subject}: ${short(v.detail, 160)}`);
  if (r.registrations.length) {
    out.push("Registrations (register_source under a signed medium-risk contract):");
    for (const g of r.registrations) out.push(`  ${g.status.padEnd(18)} ${g.catalogue_id} ${JSON.stringify(g.params)} -> ${g.object}${g.rows === null ? "" : ` (${g.rows} rows)`} ${g.elapsed_ms} ms, contract ${g.contract_id}`);
  }
  if (r.usl) {
    const u = r.usl;
    out.push(`USL: ${u.matches_governed ? "the plan from this run's keys MATCHES the governed crosswalk_usl" : `differs (${u.diff.missing_fks.join("; ")}); would compile as ${u.usl}`}`);
    for (const f of u.fks) out.push(`  ${f.satisfied ? "kept   " : "DROPPED"} ${f.fk}: ${f.basis}`);
    for (const l of u.live_rules_run) out.push(`  live DQ ${l.rule}: ${l.error ? `failed ${l.error}` : `${l.total} total, ${l.valid} valid, ${l.invalid} invalid, ${l.elapsed_ms} ms`}`);
    if (u.dq) out.push(`  onboarding DQ (${u.dq.ran_at}): ${u.dq.rules.map((x) => `${x.rule} ${x.valid}/${x.total}`).join(", ")}; invalid rows ${JSON.stringify(u.invalid_rows).slice(0, 200)}`);
  }
  if (r.answer) {
    const a = r.answer;
    out.push("");
    out.push(`Answer (${a.rows.length} utilities; weather ${a.weather_status}):`);
    for (const row of a.rows) {
      const rev = row.revenue;
      const revText = rev?.change !== null && rev?.change !== undefined ? `${millions(rev.previous!)}M -> ${millions(rev.current)}M ${pct(rev.change)} (${rev.tag})` : `not compared: ${rev?.note ?? row.revenue_note ?? "n/a"}`;
      const w = row.weather ? `TDD ${int(row.weather.tdd_previous)} -> ${int(row.weather.tdd_current)} (${pct(row.weather.change)}) over ${row.weather.stations.length} station(s)` : `weather ${row.weather_note ?? "n/a"}`;
      out.push(`  ${row.name}${row.ticker ? ` (${row.ticker})` : ""}: ${row.declarations} declaration(s) in ${row.states.map((s) => `${s.state} ${s.declarations}`).join(", ")}; revenue ${revText}; ${w}`);
    }
  }
  out.push("");
  out.push("Not tested:");
  for (const n of r.not_tested) out.push(`  - ${n}`);
  if (r.memo) {
    out.push("");
    out.push(`Note (${r.memo.source}, ${r.memo.words} words, ${r.memo.attempts} model attempt(s)):`);
    out.push(r.memo.text.split("\n").map((l) => `  ${l}`).join("\n"));
  }
  out.push("");
  out.push(`Markovian chain: ${r.markovian.status}, ${r.markovian.chunks} chunk(s), checklist ${r.checklist_complete ? "complete" : "INCOMPLETE"}; skipped from memory: ${r.telemetry.skipped_chunks}`);
  for (const t of r.chain) {
    out.push(`  chunk ${t.chunk} #${t.seq} ${t.source === "model" ? "model   " : "FALLBACK"} ${t.tool} ${short(JSON.stringify(t.input), 140)} ${t.latency_ms} ms${t.ok ? "" : "  (failed)"}`);
    if (t.thought) out.push(`         thought: ${short(t.thought, 160)}`);
    if (t.fallback_reason) out.push(`         why: ${short(t.fallback_reason, 160)}`);
    out.push(`         -> ${short(t.fact, 200)}`);
  }
  out.push("");
  out.push("Checklist:");
  for (const i of r.checklist) out.push(`  ${i.id.padEnd(20)} ${i.status}${i.note ? ` (${short(i.note, 100)})` : ""}`);
  const s = r.summary;
  out.push("");
  out.push(`Telemetry: chunks ${r.telemetry.chunks}, skipped_chunks ${r.telemetry.skipped_chunks}; planner calls ${s.planner_calls} (valid ${s.planner_valid}, first try ${s.planner_valid_first_try}, repaired ${s.planner_repaired}); tool calls ${s.tool_calls} (model ${s.tool_calls_by_model}, fallback ${s.fallback_steps}, failed ${s.tool_failures}); tokens planner ${r.telemetry.tokens.planner_in}/${r.telemetry.tokens.planner_out}, note ${r.telemetry.tokens.memo_in}/${r.telemetry.tokens.memo_out} (measured); median planner tok/s ${s.median_planner_tokens_per_s?.toFixed(1) ?? "n/a"}; model ${r.telemetry.model ?? "none"} think=${r.telemetry.think}; cloud model calls 0; wall ${r.wall_ms} ms`);
  out.push(`Tool timings (ms): ${Object.entries(r.timings_ms).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  if (r.memory) out.push(`H-MEM: ${r.memory.facts_total} memories in store, ${r.memory.skipped_steps} step(s) skipped from memory`);
  if (r.world) out.push(`World Model: ${r.world.events} events; entities ${JSON.stringify(r.world.entities)}; edges ${JSON.stringify(r.world.edges)}`);
  out.push(`E-cov ${r.card.claims.filter((x) => x.evidenceIds.length).length}/${r.quality.claims}; E-complete ${r.quality.records - Object.keys(r.quality.incomplete_records).length}/${r.quality.records}. Evidence: ${r.evidence_file ?? "(memory)"}`);
  if (r.card.gaps.length) {
    out.push("Gaps:");
    for (const g of r.card.gaps) out.push(`  - ${short(g, 220)}`);
  }
  out.push("");
  out.push("Statements behind the answer:");
  for (const e of r.evidence.filter((x) => x.kind === "zetaris_sql" && ["answer_fema_utilities", "answer_revenue", "weather_quarter"].includes(x.template_id ?? ""))) out.push(...evidenceLines(e));
  return out.join("\n");
}

function evidenceLines(e: EvidenceRecord): string[] {
  return [`  ${e.id} ${e.template_id} ${JSON.stringify(e.params ?? {}).slice(0, 120)}  rows ${e.row_count}  ${e.elapsed_ms} ms  cache ${e.cache_state}`, `      sql: ${short(e.sql ?? "", 400)}`];
}

const availableMiB = () => Math.round(os.freemem() / 1048576);

async function cmdAsk(flags: Record<string, string | boolean>, positional: string[] = []): Promise<number> {
  const cfg = loadConfig();
  // `npm run ask -- --quarter CY2024Q1`; a shell that eats the `--` leaves the quarter positional.
  const quarter = String(typeof flags.quarter === "string" ? flags.quarter : positional.find((p) => /^CY\d{4}Q[1-4]$/u.test(p)) ?? "CY2025Q1");
  validateParam("fema_quarter", quarter);
  const think = flags.think === "off" ? false : flags.think === "on" ? true : undefined;
  const ollama = flags["no-model"] ? null : new OllamaClient({ baseUrl: cfg.ollamaUrl, model: cfg.model });
  const mode = flags.cold ? "cold" : flags.warm ? "warm" : undefined;
  const rt = openRuntime({ command: `ask ${quarter} ${mode ?? "auto"}`, ollama });
  try {
    process.stderr.write(`available RAM ${availableMiB()} MiB; model ${ollama ? ollama.model : "none (deterministic run)"}; mode ${mode ?? "auto (warm when a verified key is remembered)"}\n`);
    const o = await ask(rt, {
      quarter,
      mode,
      think,
      maxChunks: typeof flags["max-chunks"] === "string" ? Number(flags["max-chunks"]) : undefined,
      onEvent: (e) => {
        if (e.type === "chunk_start") process.stderr.write(`chunk ${e.chunk} (carryover ${e.carryover_tokens} tok)\n`);
        if (e.type === "tool") process.stderr.write(`  c${e.chunk} ${e.source === "model" ? "model   " : "FALLBACK"} ${e.tool} (${e.latency_ms} ms)${e.ok ? "" : " failed"}: ${short(e.fact, 140)}\n`);
        if (e.type === "planner") process.stderr.write(`  c${e.chunk}.${e.call} planner ${e.valid ? "valid" : "INVALID"} (${e.attempts} repl${e.attempts === 1 ? "y" : "ies"}, ${e.prompt_tokens}/${e.eval_tokens} tok, ${e.tokens_per_s?.toFixed(1) ?? "n/a"} tok/s) -> ${e.tool ?? "no action"}\n`);
      },
    });
    if (o.seed) process.stderr.write(`memory seed: ${o.seed.documents.filter((d) => !d.skipped).length} new document(s), ${o.seed.totalMemories} memories${o.seed.missing.length ? `; missing ${o.seed.missing.join(", ")}` : ""}\n`);
    const r = o.result;
    if (typeof flags.out === "string") {
      mkdirSync(path.dirname(path.resolve(flags.out)), { recursive: true });
      writeFileSync(flags.out, `${JSON.stringify(r, null, 2)}\n`, "utf8");
    }
    console.log(flags.json ? JSON.stringify(r, null, 2) : printRun(r));
    console.log(`saved ${rt.runs.pathOf(r.run_id)}${typeof flags.out === "string" ? ` and ${flags.out}` : ""}`);
    return 0;
  } finally {
    rt.close();
  }
}

async function cmdOnboard(flags: Record<string, string | boolean>): Promise<number> {
  const rt = openRuntime({ command: "onboard", ollama: null });
  try {
    const t0 = performance.now();
    console.log("onboarding (registrations, governed USL check, RUN DQ for the six FK rules; never on the question path)");
    const r = await onboard(rt, { log: (l) => console.log(l), skipDq: !!flags["skip-dq"] });
    const failed = r.registrations.filter((x) => "error" in x).length;
    const invalid = r.dq.rules.reduce((s, x) => s + (x.invalid ?? 0), 0);
    console.log(`registrations: ${r.registrations.length} (${r.registrations.filter((x) => "status" in x && x.status === "registered").length} registered, ${r.registrations.filter((x) => "status" in x && x.status === "already_registered").length} already registered, ${failed} failed)`);
    console.log(`USL: ${r.usl.tables.length} tables, ${r.usl.rules} DQ rules, ok=${r.usl.ok}`);
    console.log(`DQ: ${r.dq.rules.length} rules, ${r.dq.rules.filter((x) => x.error).length} failed, ${invalid} invalid row(s): ${JSON.stringify(r.dq.invalid_rows)}`);
    console.log(`wrote ${r.dq_file}; wall ${Math.round(performance.now() - t0)} ms`);
    return failed || !r.usl.ok || r.dq.rules.some((x) => x.error) ? 3 : 0;
  } finally {
    rt.close();
  }
}

function cmdReplay(positional: string[], flags: Record<string, string | boolean>): number {
  const id = positional[0] ?? (typeof flags.run === "string" ? flags.run : "");
  const runs = new RunStore();
  if (!id) {
    console.error("replay needs a run id (npm run cli -- runs lists them)");
    return 2;
  }
  const r = runs.load(id);
  if (!r) {
    console.error(`no saved run ${id} under ${runs.dir}`);
    return 3;
  }
  console.log(flags.json ? JSON.stringify(r, null, 2) : `${printRun(r)}\n(replayed from ${runs.pathOf(id)}; saved ${r.saved.at}, source ${r.saved.source}; no model or gateway call)`);
  return 0;
}

function cmdRuns(): number {
  const runs = new RunStore();
  const list = runs.list();
  if (!list.length) console.log(`no saved runs under ${runs.dir}`);
  for (const e of list) console.log(`${e.run_id}  ${e.quarter} ${e.mode.padEnd(4)}  ${e.utilities} utilities  ${e.keys} keys  ${e.chunks} chunks  skipped ${e.skipped}  ${e.wall_ms} ms  note ${e.memo_source ?? "-"}  ${e.started_at}`);
  return 0;
}

async function cmdWhy(positional: string[], flags: Record<string, string | boolean>): Promise<number> {
  const id = positional[0] ?? "";
  if (!id) {
    console.error("why needs a memory id (mem-N)");
    return 2;
  }
  const rt = openRuntime({ command: `why ${id}`, ollama: null });
  try {
    const t = rt.hmem.why(id);
    console.log(flags.json ? JSON.stringify(t, null, 2) : [`Why ${id}:`, ...t.lines.map((l, i) => `${i + 1}. ${l}`)].join("\n"));
    return t.memory ? 0 : 3;
  } finally {
    rt.close();
  }
}

async function cmdKnown(flags: Record<string, string | boolean>): Promise<number> {
  const rt = openRuntime({ command: "known", ollama: null });
  try {
    const split = (s: string) => {
      const i = s.lastIndexOf(".");
      return { object: s.slice(0, i), column: s.slice(i + 1) };
    };
    const lines = typeof flags.cik === "string" ? rt.world.utilityHistory(flags.cik.padStart(10, "0")) : typeof flags.left === "string" && typeof flags.right === "string" ? rt.world.keyHistory(split(flags.left), split(flags.right)) : null;
    if (!lines) {
      console.error("known needs --cik <cik> or --left <object.column> --right <object.column>");
      return 2;
    }
    for (const l of lines) console.log(`${l.validFrom ?? "?"} -> ${l.validTo ?? "now"}  ${l.type}  ${l.from} -> ${l.to}  ${JSON.stringify(l.attrs).slice(0, 160)}  (${l.by ?? "?"})`);
    if (!lines.length) console.log("nothing known");
    return 0;
  } finally {
    rt.close();
  }
}

async function main(): Promise<number> {
  loadConfig();
  const { cmd, positional, flags } = parseArgs(process.argv.slice(2));
  switch (cmd) {
    case "ask":
      return cmdAsk(flags, positional);
    case "onboard":
      return cmdOnboard(flags);
    case "replay":
      return cmdReplay(positional, flags);
    case "runs":
      return cmdRuns();
    case "why":
      return cmdWhy(positional, flags);
    case "known":
      return cmdKnown(flags);
    default:
      console.log(
        [
          "usage: cli.ts ask --quarter CY2025Q1 [--cold] [--json] [--out <file>] [--think on|off] [--max-chunks 12] [--no-model]",
          "       cli.ts onboard [--skip-dq]",
          "       cli.ts replay <run_id> [--json]",
          "       cli.ts runs",
          "       cli.ts why <memory_id> [--json]",
          "       cli.ts known --cik <cik> | --left <object.column> --right <object.column>",
        ].join("\n"),
      );
      return cmd === "help" ? 0 : 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`error: ${(e as Error).message}`);
      process.exit(1);
    },
  );
}
