// First-boot seed for H-MEM, so source-access knowledge shows up as cited memories when
// the agent picks tools (graft 4):
//   - the Zetaris getting-started `open_data/manifest.json` (ZETARIS_GETTING_STARTED_DIR):
//     one fact per source, parsed rather than mined because the file is structured; a
//     `known_to_fail` source becomes a negative memory (low confidence, tagged);
//   - every `known_to_fail/ISSUE*.md` in that repository, mined with the reference's
//     model-free path (deterministic at boot; no model time);
//   - Crosswalk's own measured source findings (below), each with the gate that measured it.
// Every memory carries provenance origin "document" and refs [file, sha256]. Seeding is
// idempotent: a document whose sha256 is already recorded in seed.json is skipped.
// Run it directly (from agent/): npx tsx src/memory/seed.ts
// Adapted from Weather-or-Not and ClearShelf (same author, Apache-2.0).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../config.ts";
import { openMemory, type HMEM } from "./hmemFacade.ts";

export type SourceTag = "sec" | "noaa" | "zetaris" | "company_dns";

export interface SourceFinding {
  id: string;
  source: SourceTag;
  text: string;
  /** Where and when it was measured. */
  label: string;
  refs: string[];
}

/** Measured on Day 0 and Day 1 (24 Oct 2026) against the live sources and the local Zetaris. */
export const SOURCE_FINDINGS: readonly SourceFinding[] = [
  {
    id: "noaa-by-station-stale",
    source: "noaa",
    text: "The GHCN-Daily by_station CSVs on the public bucket were last modified 2025-02-09, while the parquet by_year partitions (YEAR=2025/ELEMENT=TMAX, 9 files, 14.9 MB) were current on 2026-10-24; Crosswalk reads the parquet by_year partitions only.",
    label: "Day-0 prechecks, measured 2026-10-24",
    refs: ["PRECHECKS", "zetaris/sql/04_won_ghcn_create.sql"],
  },
  {
    id: "noaa-filestore-9s",
    source: "noaa",
    text: "Any read of a Zetaris filestore table pays about 9 s per table per view level in Zetaris's own resolution (Spark itself runs the cached scan in under a second); the two-view degree-day join takes about 19 s for any station list, so weather_quarter is called once per (year, quarter) with every station in one list.",
    label: "Day-0 gate G2, measured 2026-10-24",
    refs: ["gate:G2", "zetaris/README.md"],
  },
  {
    id: "noaa-q-flag",
    source: "noaa",
    text: "Degree days drop a day when either TMAX or TMIN carries a non-empty Q_FLAG; days_observed over days_in_quarter is the coverage, and a utility's coverage is the minimum over its stations and then over the two quarters.",
    label: "SPEC section 11 item 8",
    refs: ["agent/src/tools/degreeDays.ts"],
  },
  {
    id: "sec-frames-latest-filing",
    source: "sec",
    text: "The SEC frames endpoint serves the most recently filed fact for a period: on 2026-10-24 the CY2025Q1 values came from the 2026 10-Q comparative columns, so the like-for-like step reads the current filing's value through companyconcept and uses the frames for probing and peers only.",
    label: "Lane S demo pick, measured 2026-10-24",
    refs: ["docs/demo-case.md", "agent/src/tools/recast.ts"],
  },
  {
    id: "sec-frames-val-type",
    source: "sec",
    text: "frames val is inferred double for some periods and bigint for others (CY2025Q1 double, CY2025Q2 bigint); the gateway casts it to DOUBLE and joins on LPAD(CAST(cik AS STRING), 10, '0').",
    label: "Day-0 gate G3, measured 2026-10-24",
    refs: ["gate:G3", "gateway/templates.py"],
  },
  {
    id: "sec-ruor-filers",
    source: "sec",
    text: "Duke Energy and Xcel Energy report quarterly revenue only under RegulatedAndUnregulatedOperatingRevenue (20 facts in CY2025Q1), so peers pool across the three tags, each peer with its own first available tag.",
    label: "Day-0 gate G3 and lane S, measured 2026-10-24",
    refs: ["gate:G3", "SPEC:11.2"],
  },
  {
    id: "sec-entergy-tag-switch",
    source: "sec",
    text: "Entergy's CY2024Q1 Revenues fact exists only in the 2025 filing; the 2024 filing reported the same value under RevenueFromContractWithCustomerExcludingAssessedTax, so a comparative-only history under one tag can be a tag switch, not a recast.",
    label: "Day-0 gate G4, measured 2026-10-24",
    refs: ["gate:G4", "SPEC:11.5"],
  },
  {
    id: "sec-fair-access",
    source: "sec",
    text: "SEC EDGAR fair access: at most 10 requests per second with a declared User-Agent; the gateway spaces statements that name data.sec.gov at 0.1 s and fills the User-Agent on the wire only.",
    label: "gateway/run_sql.py and gateway/jdbc.py",
    refs: ["gateway/run_sql.py"],
  },
  {
    id: "zetaris-concept-row-cap",
    source: "zetaris",
    text: "The gateway caps a reply at 200 rows; concept_history is cut for long histories (AEP Revenues holds 304 facts), so get_revenue reads concept_window(cik10, tag, year), the facts whose period ends in the year or the year before.",
    label: "Day-1 agent lane, measured 2026-10-24",
    refs: ["gateway/templates.py"],
  },
  {
    id: "zetaris-dq-minutes",
    source: "zetaris",
    text: "On the USL weather_quarter table RUN DQ coverage_ok took 361 to 557 s, SHOW DQ INVALID RECORD coverage_ok 181 s and SHOW DQ ALL INVALID did not return within 900 s; the per-question DQ gate reads the onboarding result in data/dq/latest.json plus the coverage column of its own weather_quarter result.",
    label: "Day-0 gate G6 and Day-1 Z2, measured 2026-10-24",
    refs: ["gate:G6", "scripts/dq_onboard.py"],
  },
  {
    id: "zetaris-no-if-not-exists",
    source: "zetaris",
    text: "CREATE LIGHTNING DATABASE IF NOT EXISTS is a parse error on Zetaris 2.4.3.1; the registrar plans treat an 'already exists' error on a CREATE as done and only re-cache.",
    label: "Day-0 gate G3, measured 2026-10-24",
    refs: ["gate:G3", "gateway/registrar.py"],
  },
  {
    id: "zetaris-concurrent-filestore",
    source: "zetaris",
    text: "Two GHCN filestore queries at the same time slow each other (61.9 s and a 60 s gateway timeout observed); the agent serialises its two weather_quarter calls and never runs the onboarding DQ pass during a question.",
    label: "Day-1 hygiene lane, measured 2026-10-24",
    refs: ["HYGIENE-RESULTS"],
  },
  {
    id: "dns-sic-4900-absent",
    source: "company_dns",
    text: "company_dns V4 lists 1,005 SIC codes and has no code 4900; MGE Energy (SIC 4900) fails the USL utility foreign-key rule and is outside the peer SIC set 4911, 4931, 4932.",
    label: "Day-1 Z2 RUN DQ, measured 2026-10-24",
    refs: ["zetaris/README.md"],
  },
];

export interface SeedDocReport {
  file: string;
  sha12: string;
  via: "parsed" | "model-free" | "listed";
  memories: number;
  skipped: boolean;
  wallMs: number;
}

export interface SeedReport {
  documents: SeedDocReport[];
  missing: string[];
  totalMemories: number;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function findIssues(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) findIssues(p, out);
    else if (/^ISSUE.*\.md$/u.test(name) && path.basename(dir) === "known_to_fail") out.push(p);
  }
  return out;
}

export interface SeedOptions {
  /** Root of the Zetaris getting-started repository (env ZETARIS_GETTING_STARTED_DIR). */
  gettingStartedDir?: string | null;
  log?: (line: string) => void;
}

interface ManifestSource {
  id: string;
  kind?: string;
  status?: string;
  summary?: string;
  replaced_by?: string;
  requires?: string[];
  script?: string;
}

/** Seeds H-MEM once; documents already seeded with the same content are skipped. */
export async function seedMemory(hmem: HMEM, opts: SeedOptions = {}): Promise<SeedReport> {
  const log = opts.log ?? (() => {});
  const gs = opts.gettingStartedDir ?? process.env.ZETARIS_GETTING_STARTED_DIR ?? null;
  const reports: SeedDocReport[] = [];
  const missing: string[] = [];
  const seeded = hmem.seededDocs();
  const already = (key: string, sha12: string) => seeded[key]?.sha12 === sha12;

  // 1. The getting-started manifest, one fact per source; known_to_fail sources are negative memories.
  if (gs && existsSync(path.join(gs, "open_data", "manifest.json"))) {
    const file = path.join(gs, "open_data", "manifest.json");
    const text = readFileSync(file, "utf8");
    const key = "zetaris-getting-started/open_data/manifest.json";
    const sha12 = sha256(text).slice(0, 12);
    const t0 = performance.now();
    if (already(key, sha12)) {
      reports.push({ file: key, sha12, via: "parsed", memories: seeded[key]!.memoryIds.length, skipped: true, wallMs: 0 });
    } else {
      const manifest = JSON.parse(text) as { sources?: ManifestSource[] };
      const ids: string[] = [];
      for (const s of manifest.sources ?? []) {
        const negative = s.status === "known_to_fail";
        const m = hmem.add({
          content: negative
            ? `Zetaris getting-started source "${s.id}" (${s.kind ?? "unknown kind"}) is known to fail${s.replaced_by ? ` (replaced by ${s.replaced_by})` : ""}: ${s.summary ?? ""}`.trim()
            : `Zetaris getting-started source "${s.id}" (${s.kind ?? "unknown kind"}) is ${s.status ?? "unknown"}${s.replaced_by ? `, replaced by ${s.replaced_by}` : ""}${s.requires?.length ? `, requires ${s.requires.join(", ")}` : ""}: ${s.summary ?? ""}`.trim(),
          type: "factual",
          layer: "working",
          tags: ["document", `file:${key}`, "via:parsed", "source:zetaris", `zetaris-source:${s.id}`, `status:${s.status ?? "unknown"}`, ...(negative ? ["negative"] : [])],
          confidence: negative ? 0.3 : 0.8,
          source: `document:${key}`,
          provenance: { origin: "document", learnedAt: hmem.clock(), label: `parsed from ${key}${negative ? " (known_to_fail: a negative memory)" : ""}`, refs: [key, sha256(text), ...(s.script ? [s.script] : [])] },
        });
        ids.push(m.id);
      }
      hmem.markSeeded(key, { sha12, memoryIds: ids, via: "parsed" });
      reports.push({ file: key, sha12, via: "parsed", memories: ids.length, skipped: false, wallMs: Math.round(performance.now() - t0) });
      log(`  ${key}: ${ids.length} source facts (parsed)`);
    }
  } else {
    missing.push("zetaris-getting-started/open_data/manifest.json (set ZETARIS_GETTING_STARTED_DIR)");
  }

  // 2. Known-to-fail issue reports, mined with the reference's model-free path.
  if (gs) {
    for (const f of findIssues(path.join(gs, "open_data"))) {
      const key = `zetaris-getting-started/${path.relative(gs, f).replace(/\\/gu, "/")}`;
      const text = readFileSync(f, "utf8").replace(/\r\n/gu, "\n");
      const sha12 = sha256(text).slice(0, 12);
      if (already(key, sha12)) {
        reports.push({ file: key, sha12, via: "model-free", memories: seeded[key]!.memoryIds.length, skipped: true, wallMs: 0 });
        continue;
      }
      const t0 = performance.now();
      const window = text.slice(0, 8000);
      const items = hmem.mining.mineModelFree(window);
      const ids = items.map(
        (content) =>
          hmem.add({
            content,
            type: "factual",
            layer: "working",
            tags: ["document", `file:${key}`, "via:model-free", "source:zetaris", "known_to_fail", "negative"],
            confidence: 0.5,
            source: `document:${key}`,
            provenance: { origin: "document", learnedAt: hmem.clock(), label: `mined from ${key} (model-free)`, refs: [key, sha256(text)] },
          }).id,
      );
      hmem.markSeeded(key, { sha12, memoryIds: ids, via: "model-free" });
      reports.push({ file: key, sha12, via: "model-free", memories: ids.length, skipped: false, wallMs: Math.round(performance.now() - t0) });
      log(`  ${key}: ${ids.length} memories (model-free)`);
    }
  }

  // 3. Our measured source findings.
  const fkey = "crosswalk/source-findings";
  const fsha = sha256(JSON.stringify(SOURCE_FINDINGS)).slice(0, 12);
  if (already(fkey, fsha)) {
    reports.push({ file: fkey, sha12: fsha, via: "listed", memories: seeded[fkey]!.memoryIds.length, skipped: true, wallMs: 0 });
  } else {
    const ids: string[] = [];
    for (const f of SOURCE_FINDINGS) {
      const existing = hmem.store.all().find((m) => m.tags.includes(`finding:${f.id}`));
      if (existing) {
        ids.push(existing.id);
        continue;
      }
      ids.push(
        hmem.add({
          content: f.text,
          type: "factual",
          layer: "long_term",
          tags: ["kind:source_note", `finding:${f.id}`, `source:${f.source}`],
          confidence: 0.85,
          source: "document:crosswalk-source-findings",
          provenance: { origin: "document", learnedAt: hmem.clock(), label: f.label, refs: f.refs },
        }).id,
      );
    }
    hmem.markSeeded(fkey, { sha12: fsha, memoryIds: ids, via: "listed" });
    reports.push({ file: fkey, sha12: fsha, via: "listed", memories: ids.length, skipped: false, wallMs: 0 });
    log(`  ${fkey}: ${ids.length} findings`);
  }

  return { documents: reports, missing, totalMemories: hmem.store.all().length };
}

async function main(): Promise<void> {
  loadConfig();
  const hmem = openMemory();
  console.log(`H-MEM ${hmem.persistDir} (${hmem.store.all().length} memories on load)`);
  const t0 = performance.now();
  const r = await seedMemory(hmem, { log: (l) => console.log(l) });
  for (const d of r.documents) console.log(`${d.skipped ? "skip" : "seed"} ${d.file} via ${d.via}: ${d.memories} memories, ${d.wallMs} ms`);
  for (const m of r.missing) console.log(`missing: ${m}`);
  console.log(`total memories ${r.totalMemories}, ledger entries ${hmem.ledger.all().length}, ${Math.round(performance.now() - t0)} ms`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
