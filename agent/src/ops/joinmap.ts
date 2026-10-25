// The join map as the UI shows it (SPEC D1, D18, L9): every key in its canonical orientation
// (left = the table whose rows the measuring statement counts), both rates, the verdict with its
// rule in plain words, the orphans, whether the row was measured in this run or recalled from
// memory, and the SQL that measured it.
//
// Orientation is read from the measuring statement itself, not from whoever proposed the pair:
// every join-map statement counts the rows of its `l` source (COUNT(DISTINCT l.k) / l.cik), so
// the objects inside that source are the left side. A row whose recorded left object is in the
// `r` source is swapped; a statement that cannot be read keeps the recorded orientation and says so.

import { PARTIAL_THRESHOLD, VERIFIED_THRESHOLD } from "../tools/matchRate.ts";
import type { JoinRowIn, RunIn } from "./runShape.ts";

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Plain-word definitions shown next to every label (L9); the thresholds are the code's own. */
export const JOINMAP_DEFINITIONS = {
  VERIFIED: `At least ${pct(VERIFIED_THRESHOLD)} of the left table's rows found a match on the right under this transform. Safe to join on; any rows that did not match are listed as orphans.`,
  PARTIAL: `Between ${pct(PARTIAL_THRESHOLD)} and ${pct(VERIFIED_THRESHOLD)} of the left table's rows found a match. Usable with care: the orphans listed drop out of any join on this key.`,
  REJECTED: `Fewer than ${pct(PARTIAL_THRESHOLD)} of the left table's rows found a match. This key does not join the two tables with this transform.`,
  rate: "Match rate = matched rows / rows of the left table. The verdict is read from this rate.",
  rate_distinct: "The same count over distinct key values instead of rows. Shown beside the verdict, never used for it (it misreads a column such as SIC, where 43 utilities share 4 codes).",
  orphan: "A left-table value with no match on the right side (at most 10 are listed).",
  left: "The left table is the one whose rows the measuring statement counts.",
  recalled: "Not measured in this run: recalled from a key memory that an earlier run measured as VERIFIED. The numbers, orphans and SQL are those of that earlier measurement.",
  measured: "Measured in this run by the Lightning SQL statement shown, over cached views.",
} as const;

export interface SideRef {
  object: string;
  column: string;
  ref: string;
}

export interface JoinMapRowView {
  id: string | null;
  key: string;
  cell: string;
  label: string | null;
  left: SideRef;
  right: SideRef;
  transform: string;
  transform_applies_to: "left" | "right" | "both" | null;
  orientation: "as_recorded" | "swapped" | "unread";
  proposed_by: string[];
  status: string | null;
  verdict: string | null;
  verdict_definition: string | null;
  rate: number | null;
  matched_rows: number | null;
  left_rows: number | null;
  rate_distinct: number | null;
  matched_keys: number | null;
  left_keys: number | null;
  extra: Record<string, number>;
  orphans: string[];
  recalled: boolean;
  memory_id: string | null;
  measured_as: string | null;
  provenance: string;
  sql: string | null;
  sql_orphans: string | null;
  elapsed_ms: number | null;
}

export interface JoinMapView {
  run_id: string;
  quarter: string | null;
  mode: string | null;
  rows: JoinMapRowView[];
  counts: { keys: number; verified: number; partial: number; rejected: number; other: number; measured_in_run: number; recalled: number };
  proposals: { model: unknown; baseline: unknown };
  definitions: typeof JOINMAP_DEFINITIONS;
}

function splitRef(ref: string): SideRef {
  const i = ref.lastIndexOf(".");
  return i > 0 ? { object: ref.slice(0, i), column: ref.slice(i + 1), ref } : { object: ref, column: "", ref };
}

interface Source {
  text: string;
  alias: string | null;
  objects: string[];
}

const IDENT = /^[A-Za-z_][\w.]*/u;

function readSource(sql: string, start: number): { src: Source; end: number } | null {
  let i = start;
  while (i < sql.length && /\s/u.test(sql[i]!)) i++;
  let text: string;
  if (sql[i] === "(") {
    let depth = 0;
    let j = i;
    for (; j < sql.length; j++) {
      if (sql[j] === "(") depth++;
      else if (sql[j] === ")" && --depth === 0) break;
    }
    if (j >= sql.length) return null;
    text = sql.slice(i + 1, j);
    i = j + 1;
  } else {
    const m = IDENT.exec(sql.slice(i));
    if (!m) return null;
    text = m[0];
    i += m[0].length;
  }
  const rest = sql.slice(i);
  const am = /^\s+(?:AS\s+)?([A-Za-z_]\w*)/iu.exec(rest);
  const alias = am && !/^(LEFT|RIGHT|INNER|JOIN|ON|WHERE|GROUP|ORDER|UNION)$/iu.test(am[1]!) ? am[1]! : null;
  if (alias) i += am![0].length;
  const objects = text.startsWith("SELECT") || /\bFROM\b/iu.test(text) ? [...text.matchAll(/\bFROM\s+([A-Za-z_][\w.]*)/giu)].map((m) => m[1]!.toLowerCase()) : [text.toLowerCase()];
  return { src: { text, alias, objects }, end: i };
}

/** The counted (`l`) and matched (`r`) sources of a join-map statement; null when the statement does not have that shape. */
export function sourcesOf(sql: string | null | undefined): { counted: Source; other: Source } | null {
  if (!sql) return null;
  let depth = 0;
  let from = -1;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && /^\sFROM\s/iu.test(sql.slice(i, i + 6))) {
      from = i + 5;
      break;
    }
  }
  if (from < 0) return null;
  const a = readSource(sql, from);
  if (!a) return null;
  const jm = /^\s*(?:LEFT\s+(?:OUTER\s+)?|INNER\s+)?JOIN\s/iu.exec(sql.slice(a.end));
  if (!jm) return null;
  const b = readSource(sql, a.end + jm[0].length);
  if (!b) return null;
  const [counted, other] = b.src.alias?.toLowerCase() === "l" && a.src.alias?.toLowerCase() !== "l" ? [b.src, a.src] : [a.src, b.src];
  return { counted, other };
}

const TRANSFORM_SQL: Record<string, RegExp> = {
  lpad10: /\bLPAD\s*\(/iu,
  upper: /\bUPPER\s*\(/iu,
  substr: /\bSUBSTR(?:ING)?\s*\(/iu,
  strip_prefix: /\b(?:SUBSTR(?:ING)?|REGEXP_REPLACE|REPLACE)\s*\(/iu,
  yyyymmdd_to_date: /\b(?:TO_DATE|CAST|SUBSTR)\s*\(/iu,
  iso_to_quarter: /\bSUBSTR(?:ING)?\s*\(/iu,
};

/** Which side the transform's SQL function sits on; the counted source is always the left side. */
function transformSide(transform: string, counted: Source, other: Source): JoinMapRowView["transform_applies_to"] {
  const name = transform.replace(/\(.*$/u, "").trim();
  const re = TRANSFORM_SQL[name];
  if (!re) return null;
  const inCounted = re.test(counted.text);
  const inOther = re.test(other.text);
  if (inCounted && inOther) return "both";
  if (!inCounted && !inOther) return null;
  return inCounted ? "left" : "right";
}

/** One join-map row in canonical orientation. */
export function canonicalRow(r: JoinRowIn): JoinMapRowView {
  const recordedLeft = splitRef(r.left);
  const recordedRight = splitRef(r.right);
  const src = sourcesOf(r.sql);
  let left = recordedLeft;
  let right = recordedRight;
  let orientation: JoinMapRowView["orientation"] = "unread";
  let applies: JoinMapRowView["transform_applies_to"] = null;
  if (src) {
    const lo = recordedLeft.object.toLowerCase();
    const ro = recordedRight.object.toLowerCase();
    if (src.counted.objects.includes(lo)) orientation = "as_recorded";
    else if (src.counted.objects.includes(ro)) {
      orientation = "swapped";
      left = recordedRight;
      right = recordedLeft;
    }
    if (orientation !== "unread") applies = transformSide(r.transform, src.counted, src.other);
  }
  const verdict = r.verdict ?? null;
  const recalled = !!r.from_memory;
  const measuredAs = r.measured_as ?? null;
  return {
    id: r.id ?? null,
    key: r.key,
    cell: `key.${r.key}`,
    label: r.label ?? null,
    left,
    right,
    transform: r.transform,
    transform_applies_to: applies,
    orientation,
    proposed_by: r.proposed_by ?? [],
    status: r.status ?? null,
    verdict,
    verdict_definition: verdict && verdict in JOINMAP_DEFINITIONS ? JOINMAP_DEFINITIONS[verdict as "VERIFIED" | "PARTIAL" | "REJECTED"] : null,
    rate: r.rate ?? null,
    matched_rows: r.matched_rows ?? null,
    left_rows: r.left_rows ?? null,
    rate_distinct: r.rate_distinct ?? null,
    matched_keys: r.matched_keys ?? null,
    left_keys: r.left_keys ?? null,
    extra: r.extra ?? {},
    orphans: r.orphans ?? [],
    recalled,
    memory_id: r.from_memory ?? null,
    measured_as: measuredAs,
    provenance: recalled ? `recalled from memory ${r.from_memory}${measuredAs ? `; measured as ${measuredAs} in an earlier run` : ""}` : r.status === "measured" ? "measured in this run" : `not measured (${r.status ?? "unknown"})`,
    sql: r.sql ?? null,
    sql_orphans: r.sql_orphans ?? null,
    elapsed_ms: typeof r.elapsed_ms === "number" ? r.elapsed_ms : null,
  };
}

export function joinMapView(run: RunIn & { model_proposals?: unknown; baseline_proposals?: unknown }): JoinMapView {
  const rows = (run.join_map ?? []).map(canonicalRow);
  const count = (v: string) => rows.filter((r) => r.verdict === v).length;
  return {
    run_id: run.run_id,
    quarter: run.quarter ?? null,
    mode: run.mode ?? null,
    rows,
    counts: {
      keys: rows.length,
      verified: count("VERIFIED"),
      partial: count("PARTIAL"),
      rejected: count("REJECTED"),
      other: rows.filter((r) => !["VERIFIED", "PARTIAL", "REJECTED"].includes(r.verdict ?? "")).length,
      measured_in_run: rows.filter((r) => !r.recalled && r.status === "measured").length,
      recalled: rows.filter((r) => r.recalled).length,
    },
    proposals: { model: run.model_proposals ?? null, baseline: run.baseline_proposals ?? null },
    definitions: JOINMAP_DEFINITIONS,
  };
}
