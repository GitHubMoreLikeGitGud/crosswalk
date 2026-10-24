/** Like-for-like revenue from companyconcept history with recast rule R1. No network. */

import {
  framePeriod,
  growth,
  type Period,
} from "./frames.ts";

export type { Period };

export interface ConceptFact {
  start?: string;
  end: string;
  val: number;
  accn: string;
  fy: number;
  fp: string;
  form: string;
  filed: string;
  frame?: string;
}

export interface CompanyConcept {
  cik: number;
  taxonomy: string;
  tag: string;
  entityName: string;
  units: { USD?: ConceptFact[] };
}

const MS_PER_DAY = 86_400_000;

/** Calendar fiscal years are assumed (seed utilities are calendar-year filers). */
function parseUtcYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
}

function daysBetween(start: string, end: string): number {
  return Math.round(
    (parseUtcYmd(end).getTime() - parseUtcYmd(start).getTime()) / MS_PER_DAY,
  );
}

function quarterEnd(year: number, quarter: 1 | 2 | 3 | 4): Date {
  const monthDay: Record<1 | 2 | 3 | 4, [number, number]> = {
    1: [3, 31],
    2: [6, 30],
    3: [9, 30],
    4: [12, 31],
  };
  const [m, d] = monthDay[quarter];
  return new Date(Date.UTC(year, m - 1, d));
}

function withinDays(a: Date, b: Date, maxDays: number): boolean {
  return Math.abs(a.getTime() - b.getTime()) / MS_PER_DAY <= maxDays;
}

function fpForPeriod(period: Period): string {
  return period.quarter === null ? "FY" : `Q${period.quarter}`;
}

export function matchesPeriod(fact: ConceptFact, period: Period): boolean {
  if (fact.start === undefined || fact.start === "") return false;
  const duration = daysBetween(fact.start, fact.end);
  const end = parseUtcYmd(fact.end);

  if (period.quarter === null) {
    if (duration < 350 || duration > 380) return false;
    return withinDays(end, new Date(Date.UTC(period.year, 11, 31)), 15);
  }

  if (duration < 80 || duration > 100) return false;
  return withinDays(end, quarterEnd(period.year, period.quarter), 15);
}

export function factsForPeriod(
  concept: CompanyConcept,
  period: Period,
): ConceptFact[] {
  const usd = concept.units.USD ?? [];
  return usd.filter((f) => matchesPeriod(f, period));
}

export function originalFact(facts: ConceptFact[]): ConceptFact | null {
  if (facts.length === 0) return null;
  let best = facts[0]!;
  for (let i = 1; i < facts.length; i++) {
    const f = facts[i]!;
    if (
      f.filed < best.filed ||
      (f.filed === best.filed && f.accn < best.accn)
    ) {
      best = f;
    }
  }
  return best;
}

export function comparativeFact(
  facts: ConceptFact[],
  period: Period,
): ConceptFact | null {
  const fy = period.year + 1;
  const fp = fpForPeriod(period);
  const candidates = facts.filter((f) => f.fy === fy && f.fp === fp);
  if (candidates.length === 0) return null;
  let best = candidates[0]!;
  for (let i = 1; i < candidates.length; i++) {
    const f = candidates[i]!;
    if (
      f.filed > best.filed ||
      (f.filed === best.filed && f.accn > best.accn)
    ) {
      best = f;
    }
  }
  return best;
}

export function currentFact(
  facts: ConceptFact[],
  period: Period,
): ConceptFact | null {
  if (facts.length === 0) return null;
  const fp = fpForPeriod(period);
  const preferred = facts.filter(
    (f) => f.fy === period.year && f.fp === fp,
  );
  const pool = preferred.length > 0 ? preferred : facts;
  let best = pool[0]!;
  for (let i = 1; i < pool.length; i++) {
    const f = pool[i]!;
    if (
      f.filed > best.filed ||
      (f.filed === best.filed && f.accn > best.accn)
    ) {
      best = f;
    }
  }
  return best;
}

export interface RecastCheck {
  period: string;
  conflict: "recast_comparative";
  rule: "R1";
  recast: boolean;
  original: ConceptFact | null;
  comparative: ConceptFact | null;
  chosen: number | null;
  note: string;
}

export function checkRecast(
  concept: CompanyConcept,
  previous: Period,
): RecastCheck {
  const facts = factsForPeriod(concept, previous);
  const original = originalFact(facts);
  const comparative = comparativeFact(facts, previous);
  const recast =
    comparative !== null &&
    original !== null &&
    comparative.val !== original.val;
  const chosen =
    comparative !== null
      ? comparative.val
      : original !== null
        ? original.val
        : null;

  let note: string;
  if (comparative === null) {
    note =
      original === null
        ? "No original or comparative fact for this period."
        : "No comparative in a later filing; using the originally reported value.";
  } else if (original === null || comparative.val === original.val) {
    note =
      "Comparative equals the originally reported value; no recast.";
  } else {
    note = `Recast: originally ${original.val}, comparative ${comparative.val}; rule R1 uses the comparative.`;
  }

  return {
    period: framePeriod(previous),
    conflict: "recast_comparative",
    rule: "R1",
    recast,
    original,
    comparative,
    chosen,
    note,
  };
}

export interface LikeForLike {
  tag: string;
  current: Period;
  previous: Period;
  rev_current: number;
  rev_previous: number;
  growth: number;
  current_accn: string;
  current_filed: string;
  recast: RecastCheck;
}

export function likeForLikeGrowth(
  concept: CompanyConcept,
  current: Period,
): LikeForLike {
  const previous: Period = {
    year: current.year - 1,
    quarter: current.quarter,
  };
  const currentFacts = factsForPeriod(concept, current);
  const cur = currentFact(currentFacts, current);
  if (cur === null) {
    throw new Error(`no fact for current period ${framePeriod(current)}`);
  }
  const recast = checkRecast(concept, previous);
  if (recast.original === null) {
    throw new Error(`no original fact for previous period ${framePeriod(previous)}`);
  }
  if (recast.chosen === null) {
    throw new Error(`no chosen previous revenue for ${framePeriod(previous)}`);
  }
  return {
    tag: concept.tag,
    current,
    previous,
    rev_current: cur.val,
    rev_previous: recast.chosen,
    growth: growth(cur.val, recast.chosen),
    current_accn: cur.accn,
    current_filed: cur.filed,
    recast,
  };
}
