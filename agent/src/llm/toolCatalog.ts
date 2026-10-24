// What the planner is told about each tool and which checklist items each tool completes.
// The host runs the tools (loop/tools.ts); this file only describes them to the model.
// Adapted from ClearShelf (same author, Apache-2.0); the tools are Weather-or-Not's.

import type { ToolSpec } from "./prompts.ts";
import type { ChecklistItemId, ToolName } from "./schemas.ts";

export interface CatalogEntry {
  description: string;
  input: string;
  completes: ChecklistItemId[];
}

export const TOOL_CATALOG: Record<ToolName, CatalogEntry> = {
  resolve_utility: {
    description:
      "Look the utility up in the curated seed list (name, ticker, SIC, states served, GHCN stations) and read its SEC submissions profile (name, SIC, business state) through Zetaris.",
    input: "cik",
    completes: ["utility_resolved"],
  },
  probe_revenue_tag: {
    description:
      "Probe the SEC frames for the quarter in the fixed order Revenues, RevenueFromContractWithCustomerExcludingAssessedTax, RegulatedAndUnregulatedOperatingRevenue; the first tag with a value for this utility is its revenue tag (remembered for later runs).",
    input: "cik, period",
    completes: ["tag_chosen"],
  },
  register_frames: {
    description:
      "Register a missing SEC frames period in Zetaris through the gateway registrar under a medium-risk contract the host signs (raw REST table, flattened view, DESCRIBE, CACHE); then the probe or the peer read runs again.",
    input: "tag, period",
    completes: [],
  },
  get_revenue: {
    description:
      "Read the utility's companyconcept history for its tag through Zetaris and compute like-for-like growth: the current quarter from its own filing, the previous quarter as restated in that filing (rule R1); a restated comparative is recorded as a recast conflict in memory.",
    input: "cik, tag, period",
    completes: ["revenue_like_for_like"],
  },
  get_peers: {
    description:
      "Read the seed utilities' frames facts for both quarters under all three tags, give each peer its own first available tag, keep SIC 4911, 4931 and 4932 with both quarters present and |growth| below 60%, and record every exclusion with its reason.",
    input: "period",
    completes: ["peers_loaded"],
  },
  get_weather: {
    description:
      "Compute heating and cooling degree days in Lightning SQL over the cached GHCN views for every station of the utility and its peers, once per quarter (two calls), then the degree-day change per utility with its station coverage.",
    input: "cik, period",
    completes: ["weather_target", "weather_peers"],
  },
  dq_gate: {
    description:
      "Check the Zetaris data-quality gate: the onboarding run of the coverage_ok rule on the USL weather table and the coverage of the utility's own stations; the verdict is withheld while an invalid row concerns the utility.",
    input: "cik",
    completes: ["dq_checked"],
  },
  attribute: {
    description:
      "Split the utility's growth into a weather part (peer sensitivity times its degree-day change), an industry part (peer median net of weather) and a company-specific remainder, with bootstrap ranges (300 resamples, seed 7) and a confidence label.",
    input: "none",
    completes: ["attribution_done"],
  },
  not_tested: {
    description: "List what this analysis cannot see (fuel-cost pass-through inside revenue, rate cases, data-centre load, mergers, Q4, 10-year normals, states capped at 6, the Q_FLAG policy).",
    input: "none",
    completes: ["not_tested_listed"],
  },
  finalize: {
    description:
      "Record the claim verdict from the attribution (supported, partly supported, not supported; withheld while the DQ gate fails) and write the memo, every number string-matched against the tool outputs. Allowed only after every other checklist item is resolved.",
    input: "none",
    completes: ["claim_tested", "memo_written"],
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
