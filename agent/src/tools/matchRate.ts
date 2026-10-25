/** Match-rate SQL renderer, result parser, and in-memory reference measurement. */

import { isTransformSpec, parseTransform } from "./transforms.ts";

export const VERIFIED_THRESHOLD = 0.95;
export const PARTIAL_THRESHOLD = 0.8;
export const ORPHAN_SAMPLE = 10;

export interface KeyProposal {
  leftObject: string;
  leftColumn: string;
  rightObject: string;
  rightColumn: string;
  transform: string;
}

export type Verdict = "VERIFIED" | "PARTIAL" | "REJECTED";

export interface MatchResult {
  proposal: KeyProposal;
  left_keys: number;
  matched_keys: number;
  rate: number;
  orphans: string[];
  orphans_total: number | null;
  verdict: Verdict;
}

const OBJECT_RE = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/;
const COLUMN_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertObjectName(name: string, label: string): void {
  if (typeof name !== "string" || !OBJECT_RE.test(name)) {
    throw new Error(`invalid ${label}: ${name}`);
  }
  // Lightning folds identifier case: refuse the sister project's objects in any spelling.
  if (/^won[_.]/i.test(name)) {
    throw new Error(`refused object: ${name}`);
  }
}

function assertColumnName(name: string, label: string): void {
  if (typeof name !== "string" || !COLUMN_RE.test(name)) {
    throw new Error(`invalid ${label}: ${name}`);
  }
}

export function validateProposal(p: unknown): KeyProposal {
  if (p === null || typeof p !== "object") {
    throw new Error("proposal must be an object");
  }
  const o = p as Record<string, unknown>;
  const leftObject = o.leftObject;
  const leftColumn = o.leftColumn;
  const rightObject = o.rightObject;
  const rightColumn = o.rightColumn;
  const transform = o.transform;
  if (typeof leftObject !== "string") throw new Error("invalid leftObject");
  if (typeof leftColumn !== "string") throw new Error("invalid leftColumn");
  if (typeof rightObject !== "string") throw new Error("invalid rightObject");
  if (typeof rightColumn !== "string") throw new Error("invalid rightColumn");
  if (typeof transform !== "string") throw new Error("invalid transform");
  assertObjectName(leftObject, "leftObject");
  assertObjectName(rightObject, "rightObject");
  assertColumnName(leftColumn, "leftColumn");
  assertColumnName(rightColumn, "rightColumn");
  if (!isTransformSpec(transform)) {
    throw new Error(`invalid transform: ${transform}`);
  }
  return { leftObject, leftColumn, rightObject, rightColumn, transform };
}

export function verdictFor(rate: number): Verdict {
  if (rate >= VERIFIED_THRESHOLD) return "VERIFIED";
  if (rate >= PARTIAL_THRESHOLD) return "PARTIAL";
  return "REJECTED";
}

function colRef(alias: string, column: string): string {
  return `${alias}.\`${column}\``;
}

export function matchRateSql(p: KeyProposal): { counts: string; orphans: string } {
  const proposal = validateProposal(p);
  const t = parseTransform(proposal.transform);
  const leftCol = colRef("l", proposal.leftColumn);
  const rightCol = colRef("r", proposal.rightColumn);
  const leftExpr = t.sql(leftCol);
  const leftSub = `(SELECT DISTINCT ${leftExpr} AS k FROM ${proposal.leftObject} l WHERE ${leftExpr} IS NOT NULL) l`;
  const rightSub = `(SELECT DISTINCT CAST(${rightCol} AS STRING) AS k FROM ${proposal.rightObject} r) r`;
  const counts =
    `SELECT COUNT(DISTINCT l.k) AS left_keys, ` +
    `COUNT(DISTINCT CASE WHEN r.k IS NOT NULL THEN l.k END) AS matched_keys ` +
    `FROM ${leftSub} LEFT JOIN ${rightSub} ON r.k = l.k`;
  const orphans =
    `SELECT l.k AS orphan FROM ${leftSub} LEFT JOIN ${rightSub} ON r.k = l.k ` +
    `WHERE r.k IS NULL AND l.k IS NOT NULL ORDER BY l.k LIMIT ${ORPHAN_SAMPLE}`;
  return { counts, orphans };
}

function coerceCount(row: Record<string, unknown>, col: string): number {
  if (!(col in row)) {
    throw new Error(`missing column: ${col}`);
  }
  const raw = row[col];
  if (raw === null || raw === undefined || raw === "") {
    throw new Error(`null ${col}`);
  }
  const n = Number(raw);
  if (Number.isNaN(n)) {
    throw new Error(`invalid ${col}: ${raw}`);
  }
  return n;
}

export function parseMatchRows(
  p: KeyProposal,
  countRows: Record<string, unknown>[],
  orphanRows: Record<string, unknown>[],
): MatchResult {
  const proposal = validateProposal(p);
  if (countRows.length !== 1) {
    throw new Error(`expected one count row, got ${countRows.length}`);
  }
  const left_keys = coerceCount(countRows[0], "left_keys");
  const matched_keys = coerceCount(countRows[0], "matched_keys");
  const rate = left_keys === 0 ? 0 : matched_keys / left_keys;
  const orphans = orphanRows.map((r) => {
    if (!("orphan" in r)) throw new Error("missing column: orphan");
    return String(r.orphan);
  });
  return {
    proposal,
    left_keys,
    matched_keys,
    rate,
    orphans,
    orphans_total: null,
    verdict: verdictFor(rate),
  };
}

export function measureInMemory(
  p: KeyProposal,
  leftRows: Record<string, unknown>[],
  rightRows: Record<string, unknown>[],
): MatchResult {
  const proposal = validateProposal(p);
  const t = parseTransform(proposal.transform);
  const leftKeySet = new Set<string>();
  for (const row of leftRows) {
    const key = t.apply(row[proposal.leftColumn]);
    if (key === null) continue;
    leftKeySet.add(String(key));
  }
  const rightKeySet = new Set<string>();
  for (const row of rightRows) {
    const v = row[proposal.rightColumn];
    if (v === null || v === undefined) continue;
    rightKeySet.add(String(v));
  }
  const leftKeys = [...leftKeySet].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const matched = leftKeys.filter((k) => rightKeySet.has(k));
  const orphanAll = leftKeys.filter((k) => !rightKeySet.has(k));
  const left_keys = leftKeys.length;
  const matched_keys = matched.length;
  const rate = left_keys === 0 ? 0 : matched_keys / left_keys;
  return {
    proposal,
    left_keys,
    matched_keys,
    rate,
    orphans: orphanAll.slice(0, ORPHAN_SAMPLE),
    orphans_total: orphanAll.length,
    verdict: verdictFor(rate),
  };
}
