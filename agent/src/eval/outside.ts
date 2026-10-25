// Outside checks (judge lesson L4): numbers the agent did not compute, fetched over HTTPS outside
// Zetaris and compared with what Zetaris holds.
//   1. OpenFEMA DisasterDeclarationsSummaries, major-disaster (DR) filter, per quarter: rows,
//      distinct disasterNumber, distinct states, per-state declarations; compared with the cached
//      view through the gateway's reader template fema_declarations(quarter).
//   2. One utility's served states from its own FY2024 Form 10-K (SEC EDGAR, the declared
//      User-Agent from CW_USER_AGENT in the environment; skipped when it is unset): the sentences
//      of the filing that name a service territory or customers in a state, against the states
//      seeds/utilities.json lists for it.
// Writes docs/eval/outside-checks.json (counts and state codes only: no SEC fact value).
//
//   npx tsx src/eval/outside.ts [--quarters CY2025Q1,CY2024Q1] [--ciks 0001711269] [--out <file>]

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, REPO_ROOT } from "../config.ts";
import { GatewayClient } from "../zetaris/client.ts";

const STATES: Record<string, string> = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA", Colorado: "CO", Connecticut: "CT",
  Delaware: "DE", Florida: "FL", Georgia: "GA", Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA",
  Kansas: "KS", Kentucky: "KY", Louisiana: "LA", Maine: "ME", Maryland: "MD", Massachusetts: "MA", Michigan: "MI",
  Minnesota: "MN", Mississippi: "MS", Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV",
  "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY", "North Carolina": "NC",
  "North Dakota": "ND", Ohio: "OH", Oklahoma: "OK", Oregon: "OR", Pennsylvania: "PA", "Rhode Island": "RI",
  "South Carolina": "SC", "South Dakota": "SD", Tennessee: "TN", Texas: "TX", Utah: "UT", Vermont: "VT",
  Virginia: "VA", Washington: "WA", "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY", "District of Columbia": "DC",
};

/** The OpenFEMA URL of the registrar plan register_fema (gateway/templates.py FEMA_ENDPOINT) for one quarter. */
export function femaUrl(quarter: string): string {
  const m = /^CY(\d{4})Q([1-4])$/u.exec(quarter);
  if (!m) throw new Error(`bad quarter ${quarter}`);
  const year = Number(m[1]);
  const q = Number(m[2]);
  const sm = (q - 1) * 3 + 1;
  const em = sm + 3 > 12 ? 1 : sm + 3;
  const ey = sm + 3 > 12 ? year + 1 : year;
  const iso = (y: number, mo: number) => `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-01T00%3A00%3A00.000Z`;
  return (
    "https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries?%24filter=declarationType%20eq%20%27DR%27" +
    `%20and%20declarationDate%20ge%20%27${iso(year, sm)}%27%20and%20declarationDate%20lt%20%27${iso(ey, em)}%27&%24top=1000`
  );
}

export interface FemaCounts {
  rows: number;
  declarations: number;
  states: number;
  by_state: Record<string, number>;
}

/** Rows, distinct disaster numbers, distinct states and declarations per state (distinct disaster numbers). */
export function femaCounts(rows: { disasterNumber: number | string; state: string }[]): FemaCounts {
  const per = new Map<string, Set<string>>();
  const all = new Set<string>();
  for (const r of rows) {
    const d = String(r.disasterNumber);
    all.add(d);
    if (!per.has(r.state)) per.set(r.state, new Set());
    per.get(r.state)!.add(d);
  }
  const by_state: Record<string, number> = {};
  for (const s of [...per.keys()].sort()) by_state[s] = per.get(s)!.size;
  return { rows: rows.length, declarations: all.size, states: per.size, by_state };
}

/** Plain text of an HTML filing: tags dropped, the common entities decoded, whitespace collapsed. */
export function htmlText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&#160;|&nbsp;|&#xa0;/giu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&#8217;|&rsquo;/gu, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/gu, '"')
    .replace(/&#\d+;|&[a-z]+;/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Sentences that name a service territory or customers together with at least one state, and the states they name. */
export function serviceSentences(text: string, limit = 8): { sentences: string[]; states: string[] } {
  const names = Object.keys(STATES).sort((a, b) => b.length - a.length);
  const sentences: string[] = [];
  const found = new Set<string>();
  for (const s of text.split(/(?<=[.;])\s+/u)) {
    if (s.length > 600) continue;
    if (!/(service territor|customers in|serves? |serving |retail electric)/iu.test(s)) continue;
    let rest = s;
    const here: string[] = [];
    for (const n of names) {
      const re = new RegExp(`\\b${n}\\b`, "gu");
      if (re.test(rest)) {
        here.push(STATES[n]!);
        rest = rest.replace(re, " ");
      }
    }
    if (!here.length) continue;
    here.forEach((c) => found.add(c));
    if (sentences.length < limit) sentences.push(s);
  }
  return { sentences, states: [...found].sort() };
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.split("?")[0]}`);
  return res.json();
}

async function femaCheck(gw: GatewayClient, quarter: string) {
  const t0 = performance.now();
  const body = (await getJson(femaUrl(quarter))) as { DisasterDeclarationsSummaries: { disasterNumber: number; state: string }[] };
  const fetchMs = Math.round(performance.now() - t0);
  const outside = femaCounts(body.DisasterDeclarationsSummaries);
  const z = await gw.template("fema_declarations", { quarter });
  const iD = z.columns.indexOf("disaster_number");
  const iS = z.columns.indexOf("state");
  const zetaris = femaCounts(z.rows.map((r) => ({ disasterNumber: String(r[iD]), state: String(r[iS]) })));
  const equal = JSON.stringify(outside) === JSON.stringify(zetaris);
  return {
    quarter,
    outside: { source: "OpenFEMA API over HTTPS (DisasterDeclarationsSummaries, declarationType DR, declarationDate in the quarter)", url: femaUrl(quarter), fetch_ms: fetchMs, ...outside },
    zetaris: { template: "fema_declarations", object: z.objects[0] ?? null, sql: z.sql, elapsed_ms: z.elapsed_ms, cache_state: z.cache_state, ...zetaris },
    equal,
  };
}

async function tenKCheck(cik10: string, ua: string, seed: { ticker: string; name: string; states_served: string[]; states_source: string }) {
  const h = { "user-agent": ua };
  const sub = (await getJson(`https://data.sec.gov/submissions/CIK${cik10}.json`, h)) as {
    filings: { recent: { form: string[]; filingDate: string[]; reportDate: string[]; accessionNumber: string[]; primaryDocument: string[] } };
  };
  const r = sub.filings.recent;
  let i = -1;
  for (let k = 0; k < r.form.length; k++) {
    if (r.form[k] === "10-K" && (r.reportDate[k] ?? "").startsWith("2024-12")) {
      i = k;
      break;
    }
  }
  if (i < 0) return { cik: cik10, ticker: seed.ticker, error: "no FY2024 10-K in the recent filings" };
  await new Promise((res) => setTimeout(res, 250));
  const url = `https://www.sec.gov/Archives/edgar/data/${Number(cik10)}/${r.accessionNumber[i]!.replace(/-/gu, "")}/${r.primaryDocument[i]}`;
  const t0 = performance.now();
  const res = await fetch(url, { headers: { ...h, accept: "text/html" }, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) return { cik: cik10, ticker: seed.ticker, error: `HTTP ${res.status} for the 10-K document` };
  const html = await res.text();
  const fetchMs = Math.round(performance.now() - t0);
  const s = serviceSentences(htmlText(html));
  const seedSet = new Set(seed.states_served);
  return {
    cik: cik10,
    ticker: seed.ticker,
    name: seed.name,
    filing: { form: "10-K", report_date: r.reportDate[i], filing_date: r.filingDate[i], bytes: html.length, fetch_ms: fetchMs },
    seed_states: [...seed.states_served].sort(),
    seed_source: seed.states_source,
    filing_states: s.states,
    in_filing_not_in_seed: s.states.filter((c) => !seedSet.has(c)),
    in_seed_not_in_filing: [...seedSet].filter((c) => !s.states.includes(c)).sort(),
    service_sentences_found: s.sentences.length,
    equal: s.states.length === seedSet.size && s.states.every((c) => seedSet.has(c)),
    // The sentences stay in the run output (stdout), not in the committed file.
    _sentences: s.sentences,
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  let quarters = ["CY2025Q1", "CY2024Q1"];
  let ciks = ["0001711269"];
  let out = join(REPO_ROOT, "docs", "eval", "outside-checks.json");
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const v = argv[i + 1];
    if (a === "--quarters" && v) (quarters = v.split(",")), i++;
    else if (a === "--ciks" && v) (ciks = v.split(",")), i++;
    else if (a === "--out" && v) (out = resolve(v)), i++;
    else throw new Error(`unknown argument ${a}`);
  }
  const cfg = loadConfig();
  const gw = new GatewayClient({ baseUrl: cfg.gatewayUrl });
  const fema = [];
  for (const q of quarters) fema.push(await femaCheck(gw, q));
  const seeds = (JSON.parse(readFileSync(join(REPO_ROOT, "seeds", "utilities.json"), "utf8")) as { utilities: { cik: string; ticker: string; name: string; states_served: string[]; states_source: string }[] }).utilities;
  const ua = process.env.CW_USER_AGENT?.trim();
  const tenK = [];
  for (const c of ciks) {
    const seed = seeds.find((u) => u.cik === c);
    if (!seed) throw new Error(`cik ${c} is not a seed utility`);
    if (!ua) {
      tenK.push({ cik: c, ticker: seed.ticker, not_run: "CW_USER_AGENT is not set (SEC fair access needs the declared User-Agent)" });
      continue;
    }
    tenK.push(await tenKCheck(c, ua, seed));
  }
  for (const t of tenK) {
    const sentences = (t as { _sentences?: string[] })._sentences ?? [];
    console.log(`10-K ${t.ticker}: ${sentences.length} service sentence(s)`);
    for (const s of sentences) console.log(`  - ${s.slice(0, 400)}`);
  }
  const doc = {
    label: "measured",
    note: "Fetched outside Zetaris over HTTPS and compared with the cached views read through the gateway. Counts and state codes only.",
    fema,
    ten_k: tenK.map((t) => {
      const { _sentences, ...rest } = t as Record<string, unknown> & { _sentences?: string[] };
      return rest;
    }),
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  for (const f of fema) console.log(`FEMA ${f.quarter}: outside rows ${f.outside.rows} / declarations ${f.outside.declarations} / states ${f.outside.states}; Zetaris ${f.zetaris.rows} / ${f.zetaris.declarations} / ${f.zetaris.states}; equal ${f.equal}`);
  for (const t of doc.ten_k) console.log(`10-K ${String(t.ticker)}: ${JSON.stringify({ seed: t.seed_states, filing: t.filing_states, equal: t.equal, not_run: t.not_run, error: t.error })}`);
  console.log(`wrote ${out}`);
}

const invoked = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invoked) await main();
