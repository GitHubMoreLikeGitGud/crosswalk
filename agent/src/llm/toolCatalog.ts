// What the planner is told about each tool and which checklist items each tool completes.
// The host runs the tools (loop/tools.ts); this file only describes them to the model.
// Descriptions stay under 60 words each: the planner is a 4B model.
// Adapted from Weather-or-Not and ClearShelf (same author, Apache-2.0); the tools are Crosswalk's.

import type { ToolSpec } from "./prompts.ts";
import type { ChecklistItemId, ToolName } from "./schemas.ts";

export interface CatalogEntry {
  description: string;
  input: string;
  completes: ChecklistItemId[];
}

export const DESCRIPTION_MAX_WORDS = 60;

export const TOOL_CATALOG: Record<ToolName, CatalogEntry> = {
  search_catalogue: {
    description:
      "Search the discovery catalogue (curated sources, the Zetaris objects already registered, the live OpenFEMA dataset list) by keywords. Hits marked known_to_fail are negative memories: never use them.",
    input: "query",
    completes: ["sources_found"],
  },
  probe_source: {
    description:
      "Probe one registered Zetaris view: its columns, five sample rows, and row, distinct and non-null counts of up to three candidate key columns.",
    input: "object",
    completes: ["shapes_probed"],
  },
  propose_keys: {
    description:
      "Propose up to six join keys between probed views, each {left: {object, column}, right: {object, column}, transform} with a transform from the closed set: identity, upper, lpad10, substr(start,len), strip_prefix('US-'), yyyymmdd_to_date, iso_to_quarter. A deterministic baseline is proposed beside yours and scored the same way.",
    input: "choices",
    completes: ["keys_proposed"],
  },
  measure_key: {
    description:
      "Measure one proposed key in Lightning SQL over cached views: matched rows over left rows, the distinct-key reading, orphans. VERIFIED at 0.95, PARTIAL at 0.80, REJECTED below. A key verified in an earlier run is recalled from memory.",
    input: "key",
    completes: ["keys_measured"],
  },
  register_source: {
    description:
      "Register a catalogue source the question needs (a FEMA quarter, SEC frames of a period) in Zetaris under a signed contract; an object that exists answers already_registered.",
    input: "catalogue_id, quarter | tag, period",
    completes: ["sources_registered"],
  },
  compile_usl: {
    description:
      "Render the semantic layer from the keys this run verified, compare it with the governed crosswalk_usl, run the two fast foreign-key DQ rules live and read the onboarding DQ results with their invalid rows.",
    input: "none",
    completes: ["usl_built", "dq_run"],
  },
  answer: {
    description:
      "Answer the question with fixed SQL over cached views: utilities serving states with major-disaster declarations in the quarter, declarations by incident type, revenue year on year under a named tag, station weather when available. Every cell cites its statement.",
    input: "quarter",
    completes: ["answered"],
  },
  not_tested: {
    description: "List what this answer cannot see: county geography, non-major declarations, fuel-cost pass-through, recasts, and weather when the station tables are missing.",
    input: "none",
    completes: ["not_tested_listed"],
  },
  finalize: {
    description:
      "Score the proposed keys against the baseline and write the note, every number string-matched against the tool outputs. Allowed only after every other checklist item is resolved.",
    input: "none",
    completes: ["note_written"],
  },
};

export function toolSpecs(tools: readonly ToolName[]): ToolSpec[] {
  return tools.map((name) => {
    const entry = TOOL_CATALOG[name];
    return { name, description: entry.description, input: entry.input, completes: entry.completes };
  });
}

/** Checklist items a tool call completes. */
export function completedBy(tool: ToolName): ChecklistItemId[] {
  return TOOL_CATALOG[tool].completes;
}
