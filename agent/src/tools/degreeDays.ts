/** Heating/cooling degree days: Lightning SQL template and pure reference arithmetic. */

export const DEGREE_DAY_BASE_F = 65;

export type Quarter = 1 | 2 | 3 | 4;

const STATION_RE = /^[A-Z0-9]{11}$/;
const TABLE_RE = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/;

export function tenthsCToF(tenths: number): number {
  // Same evaluation order as the SQL expression, so both paths round identically.
  return tenths / 10 * 9 / 5 + 32;
}

function isQuarter(q: number): q is Quarter {
  return q === 1 || q === 2 || q === 3 || q === 4;
}

/** Inclusive calendar day count for a quarter (leap-aware). */
export function daysInQuarter(year: number, quarter: Quarter): number {
  const { start, end } = quarterBounds(year, quarter);
  const s = parseYmd(start);
  const e = parseYmd(end);
  return Math.round((e.getTime() - s.getTime()) / 86_400_000) + 1;
}

export function quarterBounds(
  year: number,
  quarter: Quarter,
): { start: string; end: string } {
  const startMonth = 3 * (quarter - 1) + 1;
  const start = ymd(year, startMonth, 1);
  let end: string;
  if (quarter === 4) {
    end = ymd(year, 12, 31);
  } else {
    const nextMonth = 3 * quarter + 1;
    // day 0 of next month = last day of previous
    end = ymd(year, nextMonth, 0);
  }
  return { start, end };
}

function ymd(year: number, month: number, day: number): string {
  const d = new Date(Date.UTC(year, month - 1, day));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${dd}`;
}

function parseYmd(s: string): Date {
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  return new Date(Date.UTC(y, m - 1, d));
}

export interface DegreeDaySqlParams {
  year: number;
  quarter: Quarter;
  stations: string[];
  tmaxTable?: string;
  tminTable?: string;
}

export function degreeDaySql(params: DegreeDaySqlParams): string {
  const { year, quarter, stations } = params;
  if (!Number.isInteger(year) || year < 1900 || year > 2100) {
    throw new Error("year must be an integer from 1900 to 2100");
  }
  if (!isQuarter(quarter)) {
    throw new Error("quarter must be 1 to 4");
  }
  if (!stations.length) {
    throw new Error("stations must be non-empty");
  }
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of stations) {
    if (!STATION_RE.test(id)) {
      throw new Error(`invalid station id: ${id}`);
    }
    if (!seen.has(id)) {
      seen.add(id);
      unique.push(id);
    }
  }

  const defaultTmax = `won.ghcn_${year}_tmax`;
  const defaultTmin = `won.ghcn_${year}_tmin`;
  const tmaxTable = params.tmaxTable ?? defaultTmax;
  const tminTable = params.tminTable ?? defaultTmin;
  if (!TABLE_RE.test(tmaxTable)) {
    throw new Error(`invalid tmaxTable: ${tmaxTable}`);
  }
  if (!TABLE_RE.test(tminTable)) {
    throw new Error(`invalid tminTable: ${tminTable}`);
  }

  const { start, end } = quarterBounds(year, quarter);
  const days = daysInQuarter(year, quarter);
  const stationList = unique.map((id) => `'${id}'`).join(", ");
  const tmeanF =
    "(((x.DATA_VALUE + n.DATA_VALUE) / 2.0) / 10.0 * 9.0 / 5.0 + 32)";

  return [
    `SELECT x.ID AS station_id, ${year} AS year, ${quarter} AS quarter,`,
    `  SUM(CASE WHEN ${tmeanF} < ${DEGREE_DAY_BASE_F} THEN ${DEGREE_DAY_BASE_F} - ${tmeanF} ELSE 0 END) AS hdd,`,
    `  SUM(CASE WHEN ${tmeanF} > ${DEGREE_DAY_BASE_F} THEN ${tmeanF} - ${DEGREE_DAY_BASE_F} ELSE 0 END) AS cdd,`,
    `  COUNT(*) AS days_observed,`,
    `  ${days} AS days_in_quarter,`,
    `  COUNT(*) / ${days}.0 AS coverage`,
    `FROM ${tmaxTable} x`,
    `JOIN ${tminTable} n ON n.ID = x.ID AND n.DATE = x.DATE`,
    `WHERE x.ID IN (${stationList})`,
    `  AND x.DATE >= '${start}' AND x.DATE <= '${end}'`,
    `  AND (x.Q_FLAG IS NULL OR x.Q_FLAG = '')`,
    `  AND (n.Q_FLAG IS NULL OR n.Q_FLAG = '')`,
    `GROUP BY x.ID`,
  ].join("\n");
}

export interface DailyRow {
  ID: string;
  DATE: string;
  TMAX: number | null;
  TMIN: number | null;
  TMAX_Q_FLAG?: string | null;
  TMIN_Q_FLAG?: string | null;
}

export interface StationQuarter {
  station_id: string;
  year: number;
  quarter: Quarter;
  hdd: number;
  cdd: number;
  days_observed: number;
  days_in_quarter: number;
  coverage: number;
}

function qFlagFailed(flag: string | null | undefined): boolean {
  return flag != null && flag !== "";
}

export function degreeDaysFromDaily(
  stationId: string,
  rows: DailyRow[],
  year: number,
  quarter: Quarter,
): StationQuarter {
  const { start, end } = quarterBounds(year, quarter);
  const days_in_quarter = daysInQuarter(year, quarter);
  let hdd = 0;
  let cdd = 0;
  let days_observed = 0;

  for (const r of rows) {
    if (r.ID !== stationId) continue;
    if (r.DATE < start || r.DATE > end) continue;
    if (r.TMAX == null || r.TMIN == null) continue;
    if (qFlagFailed(r.TMAX_Q_FLAG) || qFlagFailed(r.TMIN_Q_FLAG)) continue;

    const tmeanF = tenthsCToF((r.TMAX + r.TMIN) / 2);
    hdd += Math.max(0, DEGREE_DAY_BASE_F - tmeanF);
    cdd += Math.max(0, tmeanF - DEGREE_DAY_BASE_F);
    days_observed += 1;
  }

  return {
    station_id: stationId,
    year,
    quarter,
    hdd,
    cdd,
    days_observed,
    days_in_quarter,
    coverage: days_observed / days_in_quarter,
  };
}

const STATION_COLUMNS = [
  "station_id",
  "year",
  "quarter",
  "hdd",
  "cdd",
  "days_observed",
  "days_in_quarter",
  "coverage",
] as const;

export function stationQuarterFromRow(row: Record<string, unknown>): StationQuarter {
  const out: Record<string, unknown> = {};
  for (const col of STATION_COLUMNS) {
    if (!(col in row) || row[col] === undefined || row[col] === null) {
      throw new Error(`missing column: ${col}`);
    }
    if (col === "station_id") {
      out[col] = String(row[col]);
      continue;
    }
    const n = Number(row[col]);
    if (Number.isNaN(n)) {
      throw new Error(`invalid numeric column: ${col}`);
    }
    out[col] = n;
  }
  const quarter = out.quarter as number;
  if (!isQuarter(quarter)) {
    throw new Error("quarter must be 1 to 4");
  }
  return {
    station_id: out.station_id as string,
    year: out.year as number,
    quarter,
    hdd: out.hdd as number,
    cdd: out.cdd as number,
    days_observed: out.days_observed as number,
    days_in_quarter: out.days_in_quarter as number,
    coverage: out.coverage as number,
  };
}

export interface UtilityTdd {
  cik: string;
  year: number;
  quarter: Quarter;
  tdd: number;
  coverage: number;
  stations_used: string[];
  stations_missing: string[];
}

export function utilityTdd(
  cik: string,
  stations: string[],
  rows: StationQuarter[],
  year: number,
  quarter: Quarter,
): UtilityTdd {
  const stations_used: string[] = [];
  const stations_missing: string[] = [];
  const used: StationQuarter[] = [];

  for (const id of stations) {
    const match = rows.find(
      (r) => r.station_id === id && r.year === year && r.quarter === quarter,
    );
    if (match) {
      stations_used.push(id);
      used.push(match);
    } else {
      stations_missing.push(id);
    }
  }

  if (used.length === 0) {
    throw new Error("no station has a row for the requested year and quarter");
  }

  const tdd = used.reduce((sum, r) => sum + r.hdd + r.cdd, 0) / used.length;
  const coverage = Math.min(...used.map((r) => r.coverage));

  return {
    cik,
    year,
    quarter,
    tdd,
    coverage,
    stations_used,
    stations_missing,
  };
}

export function utilityWeatherChange(
  current: UtilityTdd,
  previous: UtilityTdd,
): { delta_w: number; coverage: number } {
  if (previous.tdd === 0) {
    throw new Error("previous.tdd must not be 0");
  }
  return {
    delta_w: (current.tdd - previous.tdd) / previous.tdd,
    coverage: Math.min(current.coverage, previous.coverage),
  };
}
