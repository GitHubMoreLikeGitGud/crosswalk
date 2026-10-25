// Writes the UI test fixtures from the server's committed, already-redacted saved-run fixtures
// (agent/test/fixtures/server-run-*.json, synthetic revenue and weather values) through the
// server's own view functions, so the UI tests read exactly the payloads the routes send.
// Run from agent/:  npx tsx ../ui/test/make_ui_fixtures.ts   (deterministic; --check compares)

import { readFileSync, writeFileSync } from "node:fs";
import { answerView, cellEvidence } from "../../agent/src/ops/cells.ts";
import { joinMapView } from "../../agent/src/ops/joinmap.ts";
import { replayEvents, telemetryView } from "../../agent/src/ops/replay.ts";
import { asRun } from "../../agent/src/ops/runShape.ts";
import { uslView, type DqFile, type UslPlanFile } from "../../agent/src/ops/usl.ts";

const here = (p: string) => new URL(p, import.meta.url);
const read = (p: URL) => JSON.parse(readFileSync(p, "utf8"));

const cold = asRun(read(here("../../agent/test/fixtures/server-run-cold.json")));
const warm = asRun(read(here("../../agent/test/fixtures/server-run-warm.json")));
const dq = read(here("../../agent/test/fixtures/server-dq-latest.json")) as DqFile;
const plan = read(here("../../seeds/usl-plan.json")) as UslPlanFile;

const firstRow = answerView(cold).rows[0] as { cells: Record<string, string> };

const out: Record<string, unknown> = {
  "joinmap-cold.json": joinMapView(cold),
  "joinmap-warm.json": joinMapView(warm),
  "answer-cold.json": answerView(cold),
  "usl.json": uslView(plan, dq, cold),
  "telemetry-cold.json": telemetryView(cold),
  "telemetry-warm.json": telemetryView(warm),
  "events-warm.json": { events: replayEvents(warm), skipped_steps: (warm as { skipped_steps?: unknown }).skipped_steps ?? [] },
  "cell-revenue-change.json": cellEvidence(cold, firstRow.cells.revenue_change!),
};

const check = process.argv.includes("--check");
let differ = 0;
for (const [name, value] of Object.entries(out)) {
  const text = `${JSON.stringify({ fixture: "synthetic: built by ui/test/make_ui_fixtures.ts from the redacted server fixtures", ...(value as object) }, null, 1)}\n`;
  const path = here(`fixtures/${name}`);
  if (check) {
    let old = "";
    try {
      old = readFileSync(path, "utf8");
    } catch {
      old = "";
    }
    if (old !== text) {
      differ++;
      console.log(`differs: ${name}`);
    }
  } else {
    writeFileSync(path, text);
    console.log(`wrote ${name} (${text.length} bytes)`);
  }
}
if (check) {
  console.log(differ ? `${differ} fixture(s) differ` : "fixtures up to date");
  process.exit(differ ? 1 : 0);
}
