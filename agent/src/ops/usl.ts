// The USL & DQ screen (SPEC D6, D20, L5): the governed model (tables, keys, foreign keys) as compiled,
// the onboarding DQ results read from <data>/dq/latest.json with their date, the two rules a run
// executed live with that run's id and time, and the invalid rows mapped to their table's columns.
// Each source is labelled with where it comes from, so the screen never presents a file result as a
// live one.

import { existsSync, readFileSync } from "node:fs";
import type { DqRuleIn, RunIn } from "./runShape.ts";
import { sgt } from "./time.ts";

export interface UslPlanFile {
  usl: string;
  namespace: string;
  description?: string;
  tables: { name: string; source?: string; description?: string; columns: { name: string; type: string; nullable?: boolean }[]; pk: string[] }[];
  fks: { from: string; to: string; transform?: string }[];
}

export interface DqFile {
  ran_at?: string;
  rules?: DqRuleIn[];
  invalid_rows?: { rule: string; row: unknown[] }[];
}

export const USL_DEFINITIONS = {
  onboarding: "Run by the onboarding command (npm run onboard): it confirms the sources and the governed USL, then runs every DQ rule one at a time (each bounded at 900 s). The screen reads the saved results; no question re-runs them.",
  live: "Run live inside a question by compile_usl: only the two rules that finish in a few seconds.",
  dq_invalid: "A row whose foreign-key value has no match in the referenced table (for example a SIC code missing from the SIC reference).",
  governed: "The USL compiled on the Zetaris instance; compile_usl compares the plan rendered from a run's verified keys against it and compiles nothing when they match.",
} as const;

export function readJsonFile<T>(path: string | null | undefined): T | null {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function ruleView(r: DqRuleIn) {
  const ms = typeof r.elapsed_ms === "number" ? r.elapsed_ms : typeof r.elapsed_s === "number" ? Math.round(r.elapsed_s * 1000) : null;
  return { rule: r.rule, total: r.total ?? null, valid: r.valid ?? null, invalid: r.invalid ?? null, elapsed_ms: ms, sql: r.sql ?? null, error: r.error ?? null, attempts: r.attempts ?? null };
}

/**
 * @param plan the governed plan (seeds/usl-plan.json); null renders the DQ parts only
 * @param dq the onboarding DQ file; null when onboarding has not run
 * @param liveRun the latest saved run whose compile_usl ran the live rules; null when none has
 */
export function uslView(plan: UslPlanFile | null, dq: DqFile | null, liveRun: RunIn | null) {
  const qualified = plan ? `${plan.namespace}.${plan.usl}` : null;
  const dqRules = (dq?.rules ?? []).map(ruleView);
  const liveRules = (liveRun?.usl?.live_rules_run ?? []).map(ruleView);
  const tables = (plan?.tables ?? []).map((t) => ({
    name: t.name,
    source: t.source ?? null,
    description: t.description ?? null,
    columns: t.columns,
    pk: t.pk,
    fks: (plan?.fks ?? []).filter((f) => f.from.startsWith(`${t.name}.`)).map((f) => ({ column: f.from.slice(t.name.length + 1), references: f.to, transform: f.transform ?? "identity" })),
    query_in_zetaris: qualified ? `SELECT * FROM ${qualified}.${t.name} LIMIT 10` : null,
  }));
  const fks = (plan?.fks ?? []).map((f) => {
    const onboarding = dqRules.find((r) => r.rule === f.from) ?? null;
    const live = liveRules.find((r) => r.rule === f.from) ?? null;
    return { from: f.from, to: f.to, transform: f.transform ?? "identity", from_table: f.from.split(".")[0]!, to_table: f.to.split(".")[0]!, onboarding, live };
  });
  const columnsOf = (rule: string) => {
    const table = rule.split(".")[0]!;
    return plan?.tables.find((t) => t.name === table)?.columns.map((c) => c.name) ?? [];
  };
  const invalid = (dq?.invalid_rows ?? []).map((r) => {
    const cols = columnsOf(r.rule);
    const values = cols.length === r.row.length ? Object.fromEntries(cols.map((c, i) => [c, r.row[i]])) : null;
    return { rule: r.rule, table: r.rule.split(".")[0]!, columns: cols, row: r.row, values };
  });
  return {
    usl: plan?.usl ?? null,
    namespace: plan?.namespace ?? null,
    qualified,
    description: plan?.description ?? null,
    tables,
    fks,
    erd: { nodes: tables.map((t) => t.name), edges: fks.map((f) => ({ from: f.from_table, to: f.to_table, label: `${f.from} -> ${f.to}${f.transform !== "identity" ? ` (${f.transform})` : ""}` })) },
    onboarding_dq: dq
      ? { source: "dq/latest.json (written by npm run onboard)", ran_at: dq.ran_at ?? null, ran_at_sgt: sgt(dq.ran_at), rules: dqRules, invalid_total: dqRules.reduce((a, r) => a + (r.invalid ?? 0), 0) }
      : null,
    live_rules: liveRun
      ? { source: `compile_usl in run ${liveRun.run_id}`, run_id: liveRun.run_id, at: liveRun.started_at ?? null, at_sgt: sgt(liveRun.started_at), status: liveRun.usl?.status ?? null, note: liveRun.usl?.note ?? null, rules: liveRules }
      : null,
    invalid_rows: invalid,
    definitions: USL_DEFINITIONS,
  };
}
