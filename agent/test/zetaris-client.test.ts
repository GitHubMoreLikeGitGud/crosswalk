// The gateway client's parameter map must mirror gateway/templates.py exactly: the same
// parameter kinds and patterns, the same reader template ids with the same parameter names
// and kinds, the same registrar plans. The Python file is parsed here (a small tokenizer for
// the _t(...) and _plan(...) calls) so that a template added on one side fails this test.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BadParams,
  PARAM_PATTERNS,
  REGISTRAR_PARAMS,
  TEMPLATE_PARAMS,
  TEMPLATE_TIMEOUT_MS,
  validateRegistrarParams,
  validateTemplateParams,
} from "../src/zetaris/client.ts";

const PY = readFileSync(new URL("../../gateway/templates.py", import.meta.url), "utf8");

/** The top-level arguments of the call whose "(" is at `open` (strings and nesting respected). */
function splitArgs(src: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let cur = "";
  let i = open;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '"' || ch === "'") {
      const q = src.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
      const end = src.indexOf(q, i + q.length);
      if (end < 0) throw new Error("unterminated string");
      cur += src.slice(i, end + q.length);
      i = end + q.length;
      continue;
    }
    if (ch === "#") {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      if (!(depth === 1 && ch === "(")) cur += ch;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        args.push(cur.trim());
        return args;
      }
      cur += ch;
    } else if (ch === "," && depth === 1) {
      args.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
    i++;
  }
  throw new Error("unbalanced call");
}

type Kinds = Record<string, string>;

/** A Python dict literal of string pairs, an alias such as _TP, or a literal with **_ALIAS spreads. */
function parseDict(expr: string, aliases: Record<string, Kinds>): Kinds {
  const e = expr.trim();
  if (/^_[A-Z]+$/u.test(e)) {
    const a = aliases[e];
    if (!a) throw new Error(`unknown alias ${e}`);
    return { ...a };
  }
  if (!e.startsWith("{") || !e.endsWith("}")) throw new Error(`not a dict: ${e}`);
  const out: Kinds = {};
  const inner = e.slice(1, -1).trim();
  if (!inner) return out;
  for (const item of inner.split(",")) {
    const t = item.trim();
    if (!t) continue;
    const spread = /^\*\*(_[A-Z]+)$/u.exec(t);
    if (spread) {
      Object.assign(out, parseDict(spread[1]!, aliases));
      continue;
    }
    const kv = /^"(\w+)":\s*"(\w+)"$/u.exec(t);
    if (!kv) throw new Error(`unexpected dict item: ${t}`);
    out[kv[1]!] = kv[2]!;
  }
  return out;
}

const ALIASES: Record<string, Kinds> = {};
for (const m of PY.matchAll(/^(_[A-Z]+) = (\{.*\})\s*$/gmu)) ALIASES[m[1]!] = parseDict(m[2]!, {});

const DQ_TIMEOUT_S = Number(/^DQ_TIMEOUT_S = ([\d.]+)$/mu.exec(PY)![1]);

interface PyTemplate {
  id: string;
  params: Kinds;
  registrarRole: boolean;
  /** The template's own gateway bound in seconds (timeout_s=...), or null for the gateway default. */
  timeoutS: number | null;
}

function timeoutOf(args: string[]): number | null {
  const a = args.find((x) => x.startsWith("timeout_s="));
  if (!a) return null;
  const v = a.slice("timeout_s=".length).trim();
  return v === "DQ_TIMEOUT_S" ? DQ_TIMEOUT_S : Number(v);
}

const PY_TEMPLATES: PyTemplate[] = [];
for (const m of PY.matchAll(/\b_t\(\s*"/gu)) {
  const args = splitArgs(PY, m.index! + 2);
  PY_TEMPLATES.push({
    id: JSON.parse(args[0]!) as string,
    params: parseDict(args[2]!, ALIASES),
    registrarRole: args.slice(5).some((a) => a === '"registrar"' || a === 'role="registrar"'),
    timeoutS: timeoutOf(args),
  });
}

const PY_PLANS: Record<string, Kinds> = {};
for (const m of PY.matchAll(/_plan\("(\w+)", (_[A-Z]+),/gu)) PY_PLANS[m[1]!] = parseDict(m[2]!, ALIASES);

const PY_PATTERNS: Record<string, string> = {};
for (const m of PY.matchAll(/^\s+"(\w+)": re\.compile\(r"([^"]*)"\)/gmu)) PY_PATTERNS[m[1]!] = m[2]!;

const byId = (list: PyTemplate[]) => Object.fromEntries(list.map((t) => [t.id, t.params]));

describe("gateway/templates.py is parsed", () => {
  it("finds the parameter kinds, the templates and the plans", () => {
    expect(Object.keys(PY_PATTERNS).length).toBeGreaterThanOrEqual(9);
    expect(PY_TEMPLATES.length).toBeGreaterThanOrEqual(12);
    expect(Object.keys(PY_PLANS).length).toBeGreaterThanOrEqual(3);
    expect(DQ_TIMEOUT_S).toBeGreaterThan(0);
  });
});

describe("PARAM_PATTERNS mirror gateway/templates.py", () => {
  it("has the same kinds with the same regular expressions", () => {
    expect(Object.keys(PARAM_PATTERNS).sort()).toEqual(Object.keys(PY_PATTERNS).sort());
    for (const [kind, re] of Object.entries(PARAM_PATTERNS)) expect(re.source, kind).toBe(PY_PATTERNS[kind]);
  });
});

describe("TEMPLATE_PARAMS mirror the reader templates", () => {
  const steps = PY_TEMPLATES.filter((t) => t.id.startsWith("registrar_"));
  const readers = PY_TEMPLATES.filter((t) => !t.id.startsWith("registrar_"));

  it("lists every template the agent may call, with the gateway's parameter names and kinds", () => {
    expect(Object.keys(TEMPLATE_PARAMS).sort()).toEqual(readers.map((t) => t.id).sort());
    expect(TEMPLATE_PARAMS).toEqual(byId(readers));
  });

  it("leaves the registrar plan steps to GatewayClient.registrar", () => {
    expect(steps.length).toBeGreaterThan(0);
    for (const t of PY_TEMPLATES) if (t.registrarRole) expect(t.id).toMatch(/^registrar_/u);
    for (const t of steps) expect(TEMPLATE_PARAMS).not.toHaveProperty(t.id);
  });

  it("waits longer than the gateway's own bound for exactly the reader templates that have one", () => {
    const bounded = Object.fromEntries(readers.filter((t) => t.timeoutS !== null).map((t) => [t.id, t.timeoutS!]));
    expect(Object.keys(bounded)).toContain("dq_invalid");
    expect(Object.keys(TEMPLATE_TIMEOUT_MS).sort()).toEqual(Object.keys(bounded).sort());
    for (const [id, ms] of Object.entries(TEMPLATE_TIMEOUT_MS)) expect(ms, id).toBeGreaterThan(bounded[id]! * 1000);
  });
});

describe("REGISTRAR_PARAMS mirror the registrar plans", () => {
  it("has the same actions with the same parameter names and kinds", () => {
    expect(REGISTRAR_PARAMS).toEqual(PY_PLANS);
  });
});

describe("local validation fails fast", () => {
  it("accepts the gateway's own parameter shapes", () => {
    expect(() => validateTemplateParams("weather_quarter", { year: "2025", quarter: "1", station_list: "USW00013740,USW00013722" })).not.toThrow();
    expect(() => validateTemplateParams("frames_fact", { tag: "Revenues", period: "CY2025Q1", cik10: "0001031296" })).not.toThrow();
    expect(() => validateTemplateParams("sic", { code: "4911" })).not.toThrow();
    expect(() => validateRegistrarParams("register_concept", { cik10: "0000004904", tag: "RegulatedAndUnregulatedOperatingRevenue" })).not.toThrow();
  });

  it("refuses unknown templates and actions, missing or extra names, and values outside the patterns", () => {
    expect(() => validateTemplateParams("frames_seeds", {})).toThrow(BadParams);
    expect(() => validateRegistrarParams("register_off", {})).toThrow(BadParams);
    expect(() => validateTemplateParams("frames_count", { tag: "Revenues" })).toThrow(/missing \[period\]/u);
    expect(() => validateTemplateParams("select1", { x: "1" })).toThrow(/unexpected \[x\]/u);
    expect(() => validateTemplateParams("sic", { code: "49A1" })).toThrow(/invalid sic/u);
    expect(() => validateTemplateParams("frames_count", { tag: "Revenue", period: "CY2025Q1" })).toThrow(/invalid tag/u);
    expect(() => validateRegistrarParams("register_frames", { tag: "Revenues", period: "CY2025Q4" })).toThrow(/invalid period/u);
    const tooMany = Array.from({ length: 61 }, (_, i) => `USW${String(i).padStart(8, "0")}`).join(",");
    expect(() => validateTemplateParams("weather_quarter", { year: "2025", quarter: "1", station_list: tooMany })).toThrow(/invalid station_list/u);
  });
});
