// Saved runs replayed offline under the answer gate (agent/src/tools/discovery.ts answerGate): the gate is
// computed from the run's own join map, and the answer's FEMA and revenue statements are served from the rows
// the run saved, so no gateway or model is called. Prints, per run, the gate (the FEMA form key, with the FEMA
// coverage key beside it as reported, not gated) and whether the FEMA selection and the revenue column come out
// as the run saved them. The weather column's station key is checked at the gate,
// but the weather statements are not replayed: a run saves only the first 20 rows of each statement.
// Usage (from agent/):  npx tsx src/eval/gateReplay.ts <run.json> [<run.json> ...]

import { readFileSync } from "node:fs";
import { answer, answerGate, type MeasureResult, type TemplatePort, type TemplateReply } from "../tools/discovery.ts";

interface SavedProv {
  template: string;
  params: Record<string, string>;
  columns: string[];
  rows: unknown[][];
}
interface SavedRow {
  cik: string;
  name: string;
  ticker: string | null;
  states: unknown;
  declarations: number;
  by_incident_type: unknown;
  revenue: unknown;
  revenue_note: string | null;
  provenance: { declarations: SavedProv; revenue_current: SavedProv | null; revenue_previous: SavedProv | null };
}
export interface SavedRunForGate {
  run_id?: string;
  quarter: string;
  join_map: MeasureResult[];
  answer: { rows: SavedRow[] } | null;
}

const pick = (x: Omit<SavedRow, "provenance">) => ({ cik: x.cik, name: x.name, ticker: x.ticker, states: x.states, declarations: x.declarations, by_incident_type: x.by_incident_type, revenue: x.revenue, revenue_note: x.revenue_note });

export async function replayAnswer(run: SavedRunForGate) {
  const measured = new Map(run.join_map.filter((k) => k.key).map((k) => [k.key!, k]));
  const gate = answerGate(run.quarter, measured);
  const rows = run.answer?.rows ?? [];
  const provs = rows.flatMap((r) => [r.provenance.declarations, r.provenance.revenue_current, r.provenance.revenue_previous]).filter((p): p is SavedProv => !!p);
  const port: TemplatePort = {
    async template(id: string, params: Record<string, string> = {}): Promise<TemplateReply> {
      const p = provs.find((x) => x.template === id && JSON.stringify(x.params) === JSON.stringify(params));
      if (!p) throw new Error(`no saved statement for ${id} ${JSON.stringify(params)}`);
      if (p.rows.length >= 20) throw new Error(`${id}: the run saved only the first 20 rows`);
      return { columns: p.columns, rows: p.rows, row_count: p.rows.length, elapsed_ms: 0, sql: "", executed_at: null, cache_state: null } as unknown as TemplateReply;
    },
  };
  const r = await answer({ quarter: run.quarter }, { gateway: port, runId: run.run_id ?? "replay", gate });
  return { gate, saved: rows.map(pick), replayed: r.rows.map(pick) };
}

async function main(): Promise<void> {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error("usage: npx tsx src/eval/gateReplay.ts <run.json> [...]");
    process.exit(2);
  }
  for (const f of files) {
    const run = JSON.parse(readFileSync(f, "utf8")) as SavedRunForGate & { mode?: string };
    const { gate, saved, replayed } = await replayAnswer(run);
    const same = JSON.stringify(saved) === JSON.stringify(replayed);
    const cov = gate.fema_coverage;
    const coverage = `coverage ${cov.verdict ?? "not measured"}${cov.verdict ? ` ${cov.matched_rows}/${cov.left_rows}` : ""}${cov.orphans.length ? `, orphans ${cov.orphans.join(" ")}` : ""}, reported`;
    console.log(`${run.run_id} ${run.quarter} ${run.mode ?? ""}: FEMA ${gate.fema.ok ? "pass" : "WITHHELD"} (form ${gate.fema.verdict ?? "not measured"} ${gate.fema.matched_rows}/${gate.fema.left_rows}${gate.fema.recalled ? ", recalled" : ""}; ${coverage}); revenue ${gate.revenue.ok ? "pass" : "WITHHELD"} (${gate.revenue.verdict ?? "not measured"} ${gate.revenue.matched_rows}/${gate.revenue.left_rows}${gate.revenue.recalled ? ", recalled" : ""}); weather ${gate.weather.ok ? "pass" : "WITHHELD"} (${gate.weather.verdict ?? "not measured"} ${gate.weather.matched_rows}/${gate.weather.left_rows}${gate.weather.recalled ? ", recalled" : ""}); saved ${saved.length} rows, replayed ${replayed.length}; ${same ? "identical" : "DIFFERENT"}`);
  }
}

if (process.argv[1] && /gateReplay\.ts$/u.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
