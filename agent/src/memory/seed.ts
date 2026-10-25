// First-boot seed for H-MEM, so source-access knowledge shows up as cited memories when
// the agent picks tools (graft 4):
//   - the Zetaris getting-started `open_data/manifest.json` (ZETARIS_GETTING_STARTED_DIR):
//     one fact per source, parsed rather than mined because the file is structured; a
//     `known_to_fail` source becomes a negative memory (low confidence, tagged);
//   - every `known_to_fail/ISSUE*.md` in that repository, mined with the reference's
//     model-free path (deterministic at boot; no model time);
//   - Crosswalk's Day-0 PRECHECKS (below), each with the gate that measured it, tagged `prior`;
//   - every known_to_fail entry of seeds/catalogue.json as a negative memory.
// Every memory carries provenance origin "document" and refs [file, sha256]. Seeding is
// idempotent: a document whose sha256 is already recorded in seed.json is skipped.
// Run it directly (from agent/): npx tsx src/memory/seed.ts
// Adapted from Weather-or-Not and ClearShelf (same author, Apache-2.0).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { loadConfig, REPO_ROOT } from "../config.ts";
import { openMemory, type HMEM } from "./hmemFacade.ts";

export type SourceTag = "fema" | "sec" | "noaa" | "zetaris" | "company_dns" | "joinmap" | "usl" | "catalogue";

export interface SourceFinding {
  id: string;
  source: SourceTag;
  text: string;
  /** Where and when it was measured. */
  label: string;
  refs: string[];
}

/**
 * The Day-0 PRECHECKS (DAY0-VERDICT and JOINMAP-DAY0, re-measured 25 Oct 2026): PRIOR facts, tagged
 * `prior`. They are what the team measured before any agent run, never this run's measurements: the
 * run's join map comes from measure_key, and the note quotes only the run's own tool outputs.
 */
export const SOURCE_FINDINGS: readonly SourceFinding[] = [
  { id: "prior-fema-2025q1", source: "fema", text: "Prior (Day-0 precheck): the OpenFEMA Q1-2025 major-disaster (DR) filter returns 116 designated-area rows, 10 declarations, 8 states (AK CA KY MO OK OR SC WV); metadata.count is not a row count.", label: "Day-0 gate G1, measured 2026-10-25 (prior)", refs: ["gate:G1", "zetaris/sql/01_cw_fema_create.sql"] },
  { id: "prior-stations", source: "noaa", text: "Prior (Day-0 precheck): ghcnd-stations.txt registered as a one-column CSV with delimiter '|' has 133,039 rows; the 56 seed stations are all present with equal states; any cw.stations read costs 7-9 s of filestore resolution.", label: "Day-0 gate G2, measured 2026-10-25 (prior)", refs: ["gate:G2"] },
  { id: "prior-key-cik", source: "joinmap", text: "Prior (Day-0 precheck): seed submissions cik vs frames cik under lpad10 matched 42 of 43 (VERIFIED), orphan IDACORP 0001057877 with no CY2025Q1 fact; without LPAD the control matched 0 of 43 (REJECTED).", label: "JOINMAP-DAY0 key (a), measured 2026-10-25 (prior)", refs: ["gate:G3", "zetaris/sql/06_cw_joinmap_select.sql"] },
  { id: "prior-key-loc", source: "joinmap", text: "Prior (Day-0 precheck): frames loc under substr(4,2) vs the submissions business-address state matched 42 of 42 seed filers present in CY2025Q1 (VERIFIED).", label: "JOINMAP-DAY0 key (b), measured 2026-10-25 (prior)", refs: ["gate:G3"] },
  { id: "prior-key-fema-state", source: "joinmap", text: "Prior (Day-0 precheck): FEMA state vs the seed utilities' served states matched 7 of 8 (PARTIAL), orphan AK (no seed utility serves Alaska); FEMA fipsStateCode vs the state reference matched 8 of 8.", label: "JOINMAP-DAY0 key (c), measured 2026-10-25 (prior)", refs: ["gate:G3"] },
  { id: "prior-key-station", source: "joinmap", text: "Prior (Day-0 precheck): seed station id vs the GHCN inventory matched 56 of 56 with 56 states equal (VERIFIED).", label: "JOINMAP-DAY0 key (d), measured 2026-10-25 (prior)", refs: ["gate:G3"] },
  { id: "prior-key-sic", source: "joinmap", text: "Prior (Day-0 precheck): submissions SIC vs company_dns sic_codes matched 42 of 43 utilities (VERIFIED by rows, D1) and 3 of 4 distinct codes; orphan MGE Energy, SIC 4900.", label: "JOINMAP-DAY0 key (e), measured 2026-10-25 (prior)", refs: ["gate:G3", "SPEC:D1"] },
  { id: "prior-usl-dq", source: "usl", text: "Prior (Day-0 precheck): the governed USL lightning.metastore.crosswalk.crosswalk_usl has 7 tables and 6 FK rules, activated from cached views; RUN DQ utility.sic gives 1 invalid row (MGE Energy) in about 150 s, the other five FK rules 0 invalid; DQ runs only on the onboarding path.", label: "Day-0 gate G4, measured 2026-10-25 (prior)", refs: ["gate:G4", "SPEC:D2", "SPEC:D6"] },
  { id: "zetaris-seed-utilities-17s", source: "zetaris", text: "Any statement that reads cw.seed_utilities costs about 17 s even though it is cached (the 43 submission views behind it are resolved on every read); the answer path reads cw.seed_utility_names instead.", label: "Day-0 lane V timings, measured 2026-10-25", refs: ["SPEC:D5"] },
  { id: "zetaris-view-once", source: "zetaris", text: "On Lightning 2.4.3.1 a view may be referenced only once per statement; a second reference fails with MISSING_ATTRIBUTES.RESOLVED_ATTRIBUTE_APPEAR_IN_OPERATION.", label: "Day-0 lane Z, measured 2026-10-25", refs: ["SPEC:D11"] },
  { id: "sec-frames-tags", source: "sec", text: "Quarterly revenue in SEC frames sits under one of three tags (Revenues, RevenueFromContractWithCustomerExcludingAssessedTax, RegulatedAndUnregulatedOperatingRevenue); each utility uses its first available tag, and a year-earlier value under a different tag is named, not compared.", label: "Day-0 lane Z and the sister entry, measured 2026-10-25", refs: ["gateway/templates.py"] },
  { id: "noaa-ghcn-years", source: "noaa", text: "GHCN-Daily parquet by_year is registered for 2024 and 2025 (TMAX, TMIN, 57 stations each, about 55 s per registration); weather for a quarter needs both its year and the year before.", label: "Day-1 lane G, measured 2026-10-25", refs: ["zetaris/sql/09_cw_ghcn_create.sql"] },
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
  /** Repository root holding seeds/catalogue.json (default: this repository). */
  repoRoot?: string;
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
          tags: ["kind:source_note", `finding:${f.id}`, `source:${f.source}`, ...(f.id.startsWith("prior-") ? ["prior"] : [])],
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

  // 4. seeds/catalogue.json: every known_to_fail entry is a negative memory ("pudl: known_to_fail, <reason>").
  const catFile = path.join(opts.repoRoot ?? REPO_ROOT, "seeds", "catalogue.json");
  if (existsSync(catFile)) {
    const text = readFileSync(catFile, "utf8").replace(/\r\n/gu, "\n");
    const ckey = "seeds/catalogue.json#known_to_fail";
    const csha = sha256(text).slice(0, 12);
    if (already(ckey, csha)) {
      reports.push({ file: ckey, sha12: csha, via: "parsed", memories: seeded[ckey]!.memoryIds.length, skipped: true, wallMs: 0 });
    } else {
      const entries = ((JSON.parse(text) as { entries?: { id: string; status?: string; note?: string; verified_how?: string; kind?: string }[] }).entries ?? []).filter((e) => e.status === "known_to_fail");
      const ids: string[] = [];
      for (const e of entries) {
        const existing = hmem.store.all().find((m) => m.tags.includes(`catalogue:${e.id}`) && m.tags.includes("negative"));
        if (existing) {
          ids.push(existing.id);
          continue;
        }
        ids.push(
          hmem.add({
            content: `${e.id}: known_to_fail, ${(e.note ?? e.verified_how ?? "marked known_to_fail in the catalogue").trim()}`,
            type: "factual",
            layer: "long_term",
            tags: ["document", "negative", "known_to_fail", "source:catalogue", `catalogue:${e.id}`],
            confidence: 0.3,
            source: "document:seeds/catalogue.json",
            provenance: { origin: "document", learnedAt: hmem.clock(), label: "parsed from seeds/catalogue.json (known_to_fail: a negative memory)", refs: ["seeds/catalogue.json", sha256(text)] },
          }).id,
        );
      }
      hmem.markSeeded(ckey, { sha12: csha, memoryIds: ids, via: "parsed" });
      reports.push({ file: ckey, sha12: csha, via: "parsed", memories: ids.length, skipped: false, wallMs: 0 });
      log(`  ${ckey}: ${ids.length} negative memories`);
    }
  } else {
    missing.push("seeds/catalogue.json");
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
