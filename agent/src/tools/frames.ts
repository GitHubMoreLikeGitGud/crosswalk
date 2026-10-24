/** SEC frames helpers: period ids, CIK padding, tag probing, row parsing. No network. */

export const REVENUE_TAGS = [
  "Revenues",
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "RegulatedAndUnregulatedOperatingRevenue",
] as const;

export type RevenueTag = (typeof REVENUE_TAGS)[number];

export const TAG_SLUGS: Record<RevenueTag, string> = {
  Revenues: "revenues",
  RevenueFromContractWithCustomerExcludingAssessedTax: "rfc",
  RegulatedAndUnregulatedOperatingRevenue: "regrev",
};

/** Registrar accepts only Q1–Q3 calendar frames (not FY or Q4). */
export const FRAME_PERIOD_RE = /^CY\d{4}Q[1-3]$/;

/** Calendar fiscal years are assumed (seed utilities are calendar-year filers). */
export type Period = { year: number; quarter: 1 | 2 | 3 | 4 | null };

export function framePeriod(period: Period): string {
  if (period.quarter === null) return `CY${period.year}`;
  return `CY${period.year}Q${period.quarter}`;
}

export function parseFramePeriod(id: string): Period {
  const fy = /^CY(\d{4})$/.exec(id);
  if (fy) return { year: Number(fy[1]), quarter: null };
  const q = /^CY(\d{4})Q([1-4])$/.exec(id);
  if (q) {
    return { year: Number(q[1]), quarter: Number(q[2]) as 1 | 2 | 3 | 4 };
  }
  throw new Error(`invalid frame period: ${id}`);
}

export function frameTableName(tag: RevenueTag, period: Period): string {
  const slug = TAG_SLUGS[tag];
  if (period.quarter === null) return `frames_${slug}_cy${period.year}`;
  return `frames_${slug}_cy${period.year}q${period.quarter}`;
}

export function frameUrl(tag: RevenueTag, period: Period): string {
  return `https://data.sec.gov/api/xbrl/frames/us-gaap/${tag}/USD/${framePeriod(period)}.json`;
}

export function conceptUrl(cik: number | string, tag: RevenueTag): string {
  return `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik10(cik)}/us-gaap/${tag}.json`;
}

export function submissionsUrl(cik: number | string): string {
  return `https://data.sec.gov/submissions/CIK${cik10(cik)}.json`;
}

export function cik10(cik: number | string): string {
  const raw = String(cik).trim();
  if (!/^\d{1,10}$/.test(raw)) {
    throw new Error(`invalid CIK: ${cik}`);
  }
  return raw.padStart(10, "0");
}

export function locToState(loc: string | null | undefined): string | null {
  if (loc == null) return null;
  const m = /^US-([A-Z]{2})$/.exec(loc);
  return m ? m[1]! : null;
}

export interface FrameFact {
  accn: string;
  cik: number;
  entityName: string;
  loc: string | null;
  start: string;
  end: string;
  val: number;
}

export interface FrameRow {
  cik10: string;
  entityName: string;
  state: string | null;
  start: string;
  end: string;
  val: number;
  accn: string;
}

export function parseFrameRows(rows: Record<string, unknown>[]): FrameRow[] {
  return rows.map((row) => {
    if (row.cik === undefined || row.cik === null || row.cik === "") {
      throw new Error("frame row missing cik");
    }
    if (row.val === undefined || row.val === null || row.val === "") {
      throw new Error("frame row missing val");
    }
    if (row.accn === undefined || row.accn === null || row.accn === "") {
      throw new Error("frame row missing accn");
    }
    const val = typeof row.val === "number" ? row.val : Number(row.val);
    if (!Number.isFinite(val)) throw new Error("frame row val is not finite");
    const loc =
      row.loc === undefined || row.loc === null ? null : String(row.loc);
    return {
      cik10: cik10(row.cik as number | string),
      entityName: String(row.entityName ?? ""),
      state: locToState(loc),
      start: String(row.start ?? ""),
      end: String(row.end ?? ""),
      val,
      accn: String(row.accn),
    };
  });
}

export function probeTag(
  values: Partial<Record<RevenueTag, number | null | undefined>>,
): { tag: RevenueTag; val: number } | null {
  for (const tag of REVENUE_TAGS) {
    const v = values[tag];
    if (typeof v === "number" && Number.isFinite(v)) {
      return { tag, val: v };
    }
  }
  return null;
}

export function growth(revCurrent: number, revPrevious: number): number {
  if (!(Number.isFinite(revPrevious) && revPrevious > 0)) {
    throw new Error("rev_previous must be a positive finite number");
  }
  return (revCurrent - revPrevious) / revPrevious;
}
