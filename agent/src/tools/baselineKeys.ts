/** Deterministic join-key proposals from probe summaries alone (no model). */

import { validateProposal, type KeyProposal } from "./matchRate.ts";

export const KEY_CLASSES = [
  "cik",
  "station_id",
  "sic",
  "state",
  "fips_state",
  "fips_county",
] as const;

export type KeyClass = (typeof KEY_CLASSES)[number];

const SPECIFIC = new Set<KeyClass>([
  "cik",
  "station_id",
  "sic",
  "fips_state",
  "fips_county",
]);

const REFUSED = /^won[_.]/i;

const SHORT_INT = /^\d{1,9}$/;
const CIK10 = /^\d{10}$/;
const US_LOC = /^US-[A-Z]{2}$/;
const STATE2 = /^[A-Z]{2}$/;

export interface ProbeColumn {
  column: string;
  distinct: number | null;
  rows: number | null;
  samples: string[];
}

export interface ProbeSummary {
  object: string;
  candidates: ProbeColumn[];
}

export interface KeyChoice {
  left: { object: string; column: string };
  right: { object: string; column: string };
  transform: string;
}

export interface BaselineChoice extends KeyChoice {
  key_class: KeyClass;
  score: number;
  reasons: string[];
}

function norm(column: string): string {
  return column.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function keyClassOf(object: string, column: string): KeyClass | null {
  const n = norm(column);
  const o = object.toLowerCase();
  if (n.includes("cik")) return "cik";
  if (n.startsWith("fips")) return n.includes("county") ? "fips_county" : "fips_state";
  if (n.includes("sic")) return "sic";
  if (n === "loc") return "state";
  if (n === "state" || n.endsWith("state")) return "state";
  if (n === "code") {
    if (o.includes("state")) return "state";
    if (o.includes("sic")) return "sic";
    return null;
  }
  if (n === "id" && o.includes("station")) return "station_id";
  return null;
}

function allMatch(rx: RegExp, values: readonly string[]): boolean {
  return values.length > 0 && values.every((v) => rx.test(v));
}

export function transformFromSamples(
  a: readonly string[],
  b: readonly string[],
): { transform: string; side: "a" | "b" | null } {
  if (allMatch(SHORT_INT, a) && allMatch(CIK10, b)) return { transform: "lpad10", side: "a" };
  if (allMatch(SHORT_INT, b) && allMatch(CIK10, a)) return { transform: "lpad10", side: "b" };
  if (allMatch(US_LOC, a) && allMatch(STATE2, b)) return { transform: "substr(4,2)", side: "a" };
  if (allMatch(US_LOC, b) && allMatch(STATE2, a)) return { transform: "substr(4,2)", side: "b" };
  return { transform: "identity", side: null };
}

function distinctOf(c: ProbeColumn): number | null {
  return typeof c.distinct === "number" ? c.distinct : null;
}

export function baselineProposals(
  probes: readonly ProbeSummary[],
  limit = 6,
): BaselineChoice[] {
  const usable: { index: number; probe: ProbeSummary }[] = [];
  for (let i = 0; i < probes.length; i++) {
    const p = probes[i]!;
    if (!REFUSED.test(p.object)) usable.push({ index: i, probe: p });
  }

  type Scored = BaselineChoice & {
    _sort: [number, number, number, number, string, string];
  };
  const out: Scored[] = [];

  for (let ai = 0; ai < usable.length; ai++) {
    for (let bi = ai + 1; bi < usable.length; bi++) {
      const ia = usable[ai]!.index;
      const ib = usable[bi]!.index;
      const pa = usable[ai]!.probe;
      const pb = usable[bi]!.probe;
      if (pa.object === pb.object) continue;

      for (const ca of pa.candidates) {
        const cls = keyClassOf(pa.object, ca.column);
        if (cls === null) continue;
        for (const cb of pb.candidates) {
          if (keyClassOf(pb.object, cb.column) !== cls) continue;

          const { transform, side } = transformFromSamples(ca.samples, cb.samples);
          const da = distinctOf(ca);
          const db = distinctOf(cb);

          let leftObj: ProbeSummary;
          let leftCol: ProbeColumn;
          let rightObj: ProbeSummary;
          let rightCol: ProbeColumn;
          let il: number;
          let ir: number;

          if (side === "a") {
            leftObj = pa;
            leftCol = ca;
            rightObj = pb;
            rightCol = cb;
            il = ia;
            ir = ib;
          } else if (side === "b") {
            leftObj = pb;
            leftCol = cb;
            rightObj = pa;
            rightCol = ca;
            il = ib;
            ir = ia;
          } else {
            const aFirst = !(da !== null && db !== null && db < da);
            if (aFirst) {
              leftObj = pa;
              leftCol = ca;
              rightObj = pb;
              rightCol = cb;
              il = ia;
              ir = ib;
            } else {
              leftObj = pb;
              leftCol = cb;
              rightObj = pa;
              rightCol = ca;
              il = ib;
              ir = ia;
            }
          }

          const reasons: string[] = [];
          let score = 0;
          if (transform !== "identity") {
            score += 2;
            reasons.push(`samples need ${transform}`);
          }
          if (norm(ca.column) === norm(cb.column)) {
            score += 1;
            reasons.push("same column name");
          }
          const dl = distinctOf(leftCol);
          const dr = distinctOf(rightCol);
          if (dl !== null && dr !== null && dr >= dl) {
            score += 1;
            reasons.push("right side has at least as many distinct keys");
          }
          if (SPECIFIC.has(cls)) {
            score += 1;
            reasons.push(`specific key class ${cls}`);
          }

          out.push({
            left: { object: leftObj.object, column: leftCol.column },
            right: { object: rightObj.object, column: rightCol.column },
            transform,
            key_class: cls,
            score,
            reasons,
            _sort: [
              -score,
              KEY_CLASSES.indexOf(cls),
              il,
              ir,
              leftCol.column,
              rightCol.column,
            ],
          });
        }
      }
    }
  }

  out.sort((x, y) => {
    const a = x._sort;
    const b = y._sort;
    for (let i = 0; i < 4; i++) {
      if (a[i]! !== b[i]!) return (a[i] as number) - (b[i] as number);
    }
    if (a[4] !== b[4]) return a[4]! < b[4]! ? -1 : 1;
    if (a[5] !== b[5]) return a[5]! < b[5]! ? -1 : 1;
    return 0;
  });

  return out.slice(0, limit).map(({ _sort: _, ...rest }) => rest);
}

export function toKeyProposal(choice: KeyChoice): KeyProposal {
  return validateProposal({
    leftObject: choice.left.object,
    leftColumn: choice.left.column,
    rightObject: choice.right.object,
    rightColumn: choice.right.column,
    transform: choice.transform,
  });
}
