// Crosswalk command line.
//
//   npm run ask -- --cik 0001031296 --period CY2025Q1 --claim "colder weather" [--json] [--out <file>]
//                  [--utility FE|"FirstEnergy"] [--think on|off] [--max-chunks 10] [--no-model]
//        one question through the Markovian chain with Nemotron planning, the deterministic tools,
//        H-MEM provenance and the World Model; the run is saved under data/runs/<id>/run.json
//   npm run replay -- <run_id> [--json]          print a saved run (no model, no gateway)
//   npm run warmup -- [--no-model] [--wait-s 180] gateway warm-up, model load, memory seed, store status
//   npm run cli -- why <memory_id>               "why do you believe this?" ledger trace for one fact
//   npm run cli -- runs                          list the saved runs
//
// The commands that open data/hmem and data/world (ask, warmup, why) take data/agent.lock.
// Adapted from Weather-or-Not and ClearShelf (same author, Apache-2.0).

import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, REPO_ROOT_URL } from "./config.ts";
import type { EvidenceRecord } from "./evidence/store.ts";
import { DEFAULT_OPTIONS, OllamaClient } from "./llm/ollama.ts";
import type { RunResult } from "./loop/investigate.ts";
import { pct, millions, num, int } from "./loop/tools.ts";
import { seedMemory } from "./memory/seed.ts";
import { RunStore } from "./ops/runStore.ts";
import { findUtility, loadSeeds } from "./seeds.ts";
import { ask, openRuntime } from "./runtime.ts";
import { GatewayClient, validateParam } from "./zetaris/client.ts";

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

function bar(x: number, lo: number, hi: number, scale = 0.2): string {
  const width = 24;
  const cell = (v: number) => Math.max(0, Math.min(width, Math.round(((v + scale) / (2 * scale)) * width)));
  const line = Array.from({ length: width + 1 }, () => " ");
  for (let i = cell(lo); i <= cell(hi); i++) line[i] = "-";
  line[cell(0)] = "|";
  line[cell(x)] = "#";
  return line.join("");
}

export function printRun(r: RunResult): string {
  const c = r.card;
  const out: string[] = [];
  out.push(`Crosswalk  ${c.utility?.name ?? r.cik} (CIK ${r.cik})  ${r.period} vs ${r.previous_period}  run ${r.run_id}`);
  out.push(`Question: ${c.question}`);
  out.push("");
  const v = c.verdict;
  out.push(`VERDICT on "${r.claim}": ${v ? v.verdict.toUpperCase() : "none"}${v?.confidence ? `  (confidence ${v.confidence})` : ""}${v?.withheld_reason ? `  ${v.withheld_reason}` : ""}`);
  if (c.growth) {
    const g = c.growth;
    out.push(`Revenue (${g.tag}): ${millions(g.rev_previous)}M -> ${millions(g.rev_current)}M, like-for-like g ${pct(g.g)}  [current ${g.current_accn} filed ${g.current_filed}; previous ${g.recast ? "RECAST, comparative" : "comparative"} ${g.previous_comparative_accn ?? "none"}, original ${g.previous_original_accn ?? "none"}]`);
    if (g.tag_switch_note) out.push(`  note: ${g.tag_switch_note}`);
  }
  if (c.weather) {
    const w = c.weather;
    out.push(`Weather: TDD ${int(w.tdd_previous)} -> ${int(w.tdd_current)} (${pct(w.delta_w)}) over ${w.stations_used.length} stations, coverage ${num(w.coverage)}${w.stations_missing.length ? `; no rows for ${w.stations_missing.join(", ")}` : ""}`);
  }
  if (c.attribution) {
    const a = c.attribution;
    const rr = a.ranges;
    out.push(`Attribution (${a.peers} peers, beta ${num(a.beta, 3)} [${num(rr.beta.lo, 3)}, ${num(rr.beta.hi, 3)}], Theil-Sen ${a.theil_sen === null ? "n/a" : num(a.theil_sen, 3)}; bootstrap ${a.bootstrap.valid}/${a.bootstrap.resamples} seed ${a.bootstrap.seed}; ranges 10th-90th):`);
    out.push(`  weather   ${pct(a.weather).padStart(7)}  [${pct(rr.weather.lo)}, ${pct(rr.weather.hi)}]  ${bar(a.weather, rr.weather.lo, rr.weather.hi)}`);
    out.push(`  industry  ${pct(a.industry).padStart(7)}  [${pct(rr.industry.lo)}, ${pct(rr.industry.hi)}]  ${bar(a.industry, rr.industry.lo, rr.industry.hi)}`);
    out.push(`  remainder ${pct(a.remainder).padStart(7)}  [${pct(rr.remainder.lo)}, ${pct(rr.remainder.hi)}]  ${bar(a.remainder, rr.remainder.lo, rr.remainder.hi)}`);
    out.push(`  claim ratio |weather|/|g| = ${a.claim.ratio === null ? "n/a" : num(a.claim.ratio)} -> ${a.claim.verdict}`);
  }
  if (c.peers) {
    out.push(`Peers: ${c.peers.count} (${Object.entries(c.peers.by_tag).map(([t, n]) => `${n} ${t}`).join(", ")}), ${c.peers.with_weather} with weather`);
    for (const x of c.peers.excluded) out.push(`  excluded: ${x.reason}`);
  }
  if (c.dq) out.push(`DQ gate: ${c.dq.label} (${c.dq.basis}) ${c.dq.note}`);
  for (const k of c.recast_conflicts) {
    out.push(`Recast conflict ${k.id} (${k.scope}, ${k.tag} ${k.period}): ${k.own_filing.val} in ${k.own_filing.accn} (filed ${k.own_filing.filed}) vs ${k.later_filing.val} in ${k.later_filing.accn} (filed ${k.later_filing.filed}); ${k.rule_text}; using ${k.chosen} = ${k.chosen_val}; ${k.status}${k.override ? ` by ${k.override.by}: ${k.override.reason}` : ""}`);
  }
  out.push("");
  out.push("Not tested:");
  for (const n of c.not_tested) out.push(`  - ${n}`);
  if (c.memo) {
    out.push("");
    out.push(`Memo (${c.memo.source}, ${c.memo.words} words, ${c.memo.attempts} model attempt(s)):`);
    out.push(c.memo.text.split("\n").map((l) => `  ${l}`).join("\n"));
  }
  out.push("");
  out.push(`Markovian chain: ${r.markovian.status}, ${r.markovian.chunks} chunk(s), checklist ${r.checklist_complete ? "complete" : "INCOMPLETE"}; config ${JSON.stringify(r.markovian.chunk_config)}; skipped from memory: ${r.skipped_steps.length ? r.skipped_steps.map((s) => `${s.item} (${s.memoryId})`).join(", ") : "none"}`);
  for (const t of r.timeline) {
    out.push(`  chunk ${t.chunk} #${t.seq} ${t.source === "model" ? "model   " : "FALLBACK"} ${t.tool} ${JSON.stringify(t.input)} ${t.latency_ms} ms${t.ok ? "" : "  (failed)"}`);
    if (t.thought) out.push(`         thought: ${short(t.thought, 160)}`);
    if (t.fallback_reason) out.push(`         why: ${short(t.fallback_reason, 160)}`);
    out.push(`         -> ${short(t.fact, 200)}`);
  }
  out.push("");
  out.push("Checklist:");
  for (const i of r.checklist) out.push(`  ${i.id.padEnd(22)} ${i.status}${i.note ? ` (${short(i.note, 90)})` : ""}`);
  out.push("");
  out.push("Per chunk (planner tokens measured by Ollama; baseline and carryover estimated chars/4):");
  out.push("  chunk | calls | tools | fallback | prompt tok (1st call) | prompt tok (all) | eval tok | naive est. | carry in/out est. | tool ms");
  for (const ch of r.chunks) {
    out.push(
      `  ${String(ch.chunk).padStart(5)} | ${String(ch.planner_calls).padStart(5)} | ${String(ch.tool_calls).padStart(5)} | ${String(ch.fallback_steps).padStart(8)} | ${String(ch.first_prompt_tokens).padStart(21)} | ${String(ch.prompt_tokens).padStart(16)} | ${String(ch.eval_tokens).padStart(8)} | ${String(ch.naive_prompt_tokens_estimated).padStart(10)} | ${`${ch.carryover_in_tokens}/${ch.carryover_out_tokens}`.padStart(17)} | ${String(ch.tool_latency_ms).padStart(7)}`,
    );
  }
  const s = r.summary;
  out.push("");
  out.push(
    `Summary: planner calls ${s.planner_calls} (valid ${s.planner_valid}, first try ${s.planner_valid_first_try}, repaired ${s.planner_repaired}); tool calls ${s.tool_calls} (model ${s.tool_calls_by_model}, fallback ${s.fallback_steps}, failed ${s.tool_failures}); planner tokens in/out ${s.planner_prompt_tokens}/${s.planner_eval_tokens} (measured); memo tokens in/out ${s.tool_model_tokens_in}/${s.tool_model_tokens_out}; first-call prompts ${s.markovian_prompt_tokens_estimated} vs naive ${s.naive_prompt_tokens_estimated} (estimated), saving ${s.saving_vs_naive_estimated}; max carryover ${s.max_carryover_tokens_estimated} (estimated); median planner tok/s ${s.median_planner_tokens_per_s?.toFixed(1) ?? "n/a"}; memo tok/s ${r.telemetry.memo_tokens_per_s?.toFixed(1) ?? "n/a"}; model ${r.telemetry.model ?? "none"} think=${r.telemetry.think}; cloud model calls ${r.telemetry.cloud_model_calls} (refused hosts ${r.telemetry.refused_model_hosts}); wall ${r.wall_ms} ms`,
  );
  out.push(`Tool timings (ms, measured): ${Object.entries(r.timings_ms).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  if (r.memory) out.push(`H-MEM: ${r.memory.ids.length} memories touched this run, ${r.memory.facts_total} in store, ${r.memory.conflicts} recast conflict(s), ${r.memory.skipped_steps} step(s) skipped from memory`);
  if (r.world) out.push(`World Model: ${r.world.events} events; entities ${JSON.stringify(r.world.entities)}; edges ${JSON.stringify(r.world.edges)}`);
  out.push(`E-cov ${c.claims.filter((x) => x.evidenceIds.length).length}/${r.quality.claims}; E-complete ${r.quality.records - Object.keys(r.quality.incomplete_records).length}/${r.quality.records}. Evidence: ${r.evidence_file ?? "(memory)"}`);
  if (c.gaps.length) {
    out.push("Gaps:");
    for (const g of c.gaps) out.push(`  - ${short(g, 220)}`);
  }
  out.push("");
  out.push("Evidence:");
  for (const e of r.evidence) out.push(...evidenceLines(e));
  return out.join("\n");
}

function evidenceLines(e: EvidenceRecord): string[] {
  if (e.kind === "zetaris_sql" || e.kind === "dq") {
    return [
      `  ${e.id} ${e.kind} ${e.template_id} ${JSON.stringify(e.params ?? {})}  ${e.zetaris_object}  rows ${e.row_count}  ${e.elapsed_ms} ms  cache ${e.cache_state}${e.reused ? " (reused)" : ""}`,
      `      sql: ${short(e.sql ?? "", 180)}`,
      `      sql_sha256 ${e.sql_sha256}  retrieved ${e.queried_at}  source cached ${e.source_cached_at ?? "n/a"}`,
      `      endpoint ${short(e.source_url ?? "", 120)}  licence: ${short(e.licence ?? "", 100)}`,
    ];
  }
  if (e.model) return [`  ${e.id} ${e.kind}  ${e.model.name} think=${e.model.think} tokens in/out ${e.model.tokens_in}/${e.model.tokens_out} (${e.model.label}, ${e.model.attempts} attempt(s), ${e.model.tokens_per_s?.toFixed(1) ?? "n/a"} tok/s)  ${short(e.claim, 140)}`];
  return [`  ${e.id} ${e.kind}  from [${(e.derived_from ?? []).join(", ")}]  ${short(e.claim, 160)}`];
}

const availableMiB = () => Math.round(os.freemem() / 1048576);

async function cmdAsk(flags: Record<string, string | boolean>): Promise<number> {
  const cfg = loadConfig();
  const seeds = loadSeeds();
  let cik = typeof flags.cik === "string" ? flags.cik.padStart(10, "0") : "";
  if (!cik && typeof flags.utility === "string") {
    const u = findUtility(seeds, flags.utility);
    if (!u) {
      console.error(`no seed utility matches "${flags.utility}"`);
      return 2;
    }
    cik = u.cik;
  }
  validateParam("cik10", cik);
  const period = validateParam("period", String(flags.period ?? ""));
  const claim = String(flags.claim ?? "the weather");
  const think = flags.think === "off" ? false : flags.think === "on" ? true : undefined;
  const ollama = flags["no-model"] ? null : new OllamaClient({ baseUrl: cfg.ollamaUrl, model: cfg.model });
  const rt = openRuntime({ command: `ask ${cik} ${period}`, ollama });
  try {
    process.stderr.write(`available RAM ${availableMiB()} MiB; model ${ollama ? ollama.model : "none (deterministic run)"}\n`);
    const o = await ask(rt, {
      cik,
      period,
      claim,
      think,
      maxChunks: typeof flags["max-chunks"] === "string" ? Number(flags["max-chunks"]) : undefined,
      onEvent: (e) => {
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
  for (const e of list) console.log(`${e.run_id}  ${e.cik} ${e.period}  ${(e.utility ?? "?").padEnd(28)} ${(e.verdict ?? "-").padEnd(16)} ${(e.confidence ?? "-").padEnd(6)} ${e.chunks} chunks  ${e.wall_ms} ms  memo ${e.memo_source ?? "-"}  ${e.started_at}`);
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

async function cmdWarmup(flags: Record<string, string | boolean>): Promise<number> {
  const cfg = loadConfig();
  const gateway = new GatewayClient({ baseUrl: cfg.gatewayUrl });
  const waitS = Number(typeof flags["wait-s"] === "string" ? flags["wait-s"] : 180);
  let ok = true;
  // 1. Gateway: Zetaris answers and the warm-up has cached every target.
  const t0 = performance.now();
  let h: Record<string, unknown> | null = null;
  for (;;) {
    try {
      h = await gateway.health();
    } catch (e) {
      h = { ok: false, error: (e as Error).message.slice(0, 200) };
    }
    const lw = (h.last_warmup ?? null) as Record<string, unknown> | null;
    const failed = !!lw?.failed && Object.keys(lw.failed as object).length > 0;
    const warm = !!h.ok && !!lw && !failed;
    if (warm || performance.now() - t0 > waitS * 1000) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  const lw = (h?.last_warmup ?? null) as Record<string, unknown> | null;
  console.log(`gateway ${gateway.baseUrl}: ok=${String(h?.ok)}; templates ${(h?.templates as unknown[] | undefined)?.length ?? "?"}; last warm-up ${JSON.stringify(lw)?.slice(0, 300)}`);
  if (!h?.ok || (lw && lw.failed && Object.keys(lw.failed as object).length)) ok = false;
  // 2. Model: loaded for 30 min.
  const ollama = new OllamaClient({ baseUrl: cfg.ollamaUrl, model: cfg.model });
  if (!flags["no-model"]) {
    const free = availableMiB();
    const r = await fetch(`${cfg.ollamaUrl}/api/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: ollama.model, keep_alive: "30m", options: { num_ctx: DEFAULT_OPTIONS.num_ctx } }), signal: AbortSignal.timeout(180_000) });
    const loaded = (await ollama.loaded()).find((m) => m.name === ollama.model);
    console.log(`model ${ollama.model}: HTTP ${r.status}; loaded ${loaded ? `${Math.round(loaded.size / 1048576)} MiB (${Math.round(loaded.size_vram / 1048576)} MiB in VRAM), context ${loaded.context_length ?? "?"}` : "no"}; free RAM before ${free} MiB`);
    if (!loaded) ok = false;
  }
  // 3. Memory and World Model: seeded and readable (seeding is idempotent).
  const rt = openRuntime({ command: "warmup", ollama: null, gateway });
  try {
    const seed = await seedMemory(rt.hmem, { log: () => {} });
    console.log(`H-MEM ${rt.hmem.persistDir}: ${rt.hmem.store.all().length} memories; seed documents ${seed.documents.length} (${seed.documents.filter((d) => d.skipped).length} already seeded${seed.missing.length ? `; missing: ${seed.missing.join(", ")}` : ""}); ${rt.hmem.recasts.all().length} recast conflict(s) on record; ledger ${rt.hmem.ledger.all().length} entries`);
    const g = rt.world.exportGraph();
    console.log(`World Model ${rt.world.directory}: ${g.nodes.length} entities ${JSON.stringify(g.byType)}, ${g.edges.length} edges, ${g.events} events`);
    console.log(`runs: ${rt.runs.list().length} saved under ${rt.runs.dir}`);
  } finally {
    rt.close();
  }
  console.log(ok ? "warm-up OK" : "warm-up INCOMPLETE (see above)");
  return ok ? 0 : 3;
}

async function main(): Promise<number> {
  loadConfig();
  const { cmd, positional, flags } = parseArgs(process.argv.slice(2));
  switch (cmd) {
    case "ask":
      return cmdAsk(flags);
    case "replay":
      return cmdReplay(positional, flags);
    case "runs":
      return cmdRuns();
    case "why":
      return cmdWhy(positional, flags);
    case "warmup":
      return cmdWarmup(flags);
    default:
      console.log(
        [
          'usage: cli.ts ask --cik 0001031296 --period CY2025Q1 --claim "colder weather" [--utility FE] [--json] [--out <file>] [--think on|off] [--max-chunks 10] [--no-model]',
          "       cli.ts replay <run_id> [--json]",
          "       cli.ts runs",
          "       cli.ts why <memory_id> [--json]",
          "       cli.ts warmup [--no-model] [--wait-s 180]",
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
