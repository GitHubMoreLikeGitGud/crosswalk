import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEGREE_DAY_BASE_F,
  daysInQuarter,
  degreeDaySql,
  degreeDaysFromDaily,
  quarterBounds,
  stationQuarterFromRow,
  tenthsCToF,
  utilityTdd,
  utilityWeatherChange,
  type DailyRow,
  type Quarter,
  type StationQuarter,
} from "../src/tools/degreeDays.ts";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/degree-days.json", import.meta.url), "utf8"),
) as {
  conversions: { tenths_c: number; f: number }[];
  days_in_quarter: Record<string, number[]>;
  daily: Record<string, DailyRow[]>;
  expected: StationQuarter[];
  utility: {
    cik: string;
    stations: string[];
    year: number;
    quarter: Quarter;
    tdd_current: number;
    tdd_previous: number;
    delta_w: number;
    coverage_current: number;
    coverage_previous: number;
    coverage: number;
  };
};

describe("tenthsCToF", () => {
  it("matches every conversions[] pair", () => {
    for (const { tenths_c, f } of fixture.conversions) {
      expect(tenthsCToF(tenths_c)).toBeCloseTo(f, 10);
    }
  });
});

describe("daysInQuarter and quarterBounds", () => {
  it("matches all eight days_in_quarter pairs", () => {
    for (const [yearStr, counts] of Object.entries(fixture.days_in_quarter)) {
      const year = Number(yearStr);
      for (let q = 1; q <= 4; q++) {
        expect(daysInQuarter(year, q as Quarter)).toBe(counts[q - 1]);
      }
    }
  });

  it("returns inclusive yyyymmdd bounds", () => {
    expect(quarterBounds(2024, 1)).toEqual({ start: "20240101", end: "20240331" });
    expect(quarterBounds(2025, 4)).toEqual({ start: "20251001", end: "20251231" });
  });
});

describe("degreeDaysFromDaily", () => {
  it("matches every expected[] series", () => {
    for (const exp of fixture.expected) {
      const key = `${exp.station_id}:${exp.year}:Q${exp.quarter}`;
      const rows = fixture.daily[key];
      const got = degreeDaysFromDaily(exp.station_id, rows, exp.year, exp.quarter as Quarter);
      expect(got.station_id).toBe(exp.station_id);
      expect(got.year).toBe(exp.year);
      expect(got.quarter).toBe(exp.quarter);
      expect(got.hdd).toBeCloseTo(exp.hdd, 6);
      expect(got.cdd).toBeCloseTo(exp.cdd, 6);
      expect(got.days_observed).toBe(exp.days_observed);
      expect(got.days_in_quarter).toBe(exp.days_in_quarter);
      expect(got.coverage).toBeCloseTo(exp.coverage, 9);
    }
  });

  it("observes 87 of 90 for USW00099001 2025 Q1 and ignores out-of-quarter / other-station rows", () => {
    const key = "USW00099001:2025:Q1";
    const base = fixture.daily[key];
    const got = degreeDaysFromDaily("USW00099001", base, 2025, 1);
    expect(got.days_observed).toBe(87);
    expect(got.days_in_quarter).toBe(90);

    const padded: DailyRow[] = [
      ...base,
      {
        ID: "USW00099001",
        DATE: "20250401",
        TMAX: 200,
        TMIN: 100,
        TMAX_Q_FLAG: "",
        TMIN_Q_FLAG: "",
      },
      {
        ID: "USW00099002",
        DATE: "20250115",
        TMAX: 200,
        TMIN: 100,
        TMAX_Q_FLAG: "",
        TMIN_Q_FLAG: "",
      },
    ];
    const again = degreeDaysFromDaily("USW00099001", padded, 2025, 1);
    expect(again).toEqual(got);
  });
});

describe("utilityTdd and utilityWeatherChange", () => {
  const q1 = fixture.expected.filter((e) => e.quarter === 1) as StationQuarter[];
  const u = fixture.utility;

  it("reproduces the utility block for 2025 Q1 vs 2024 Q1", () => {
    const current = utilityTdd(u.cik, u.stations, q1, 2025, 1);
    const previous = utilityTdd(u.cik, u.stations, q1, 2024, 1);
    expect(current.tdd).toBeCloseTo(u.tdd_current, 9);
    expect(previous.tdd).toBeCloseTo(u.tdd_previous, 9);
    expect(current.coverage).toBeCloseTo(u.coverage_current, 9);
    expect(previous.coverage).toBeCloseTo(u.coverage_previous, 9);

    const change = utilityWeatherChange(current, previous);
    expect(change.delta_w).toBeCloseTo(u.delta_w, 9);
    expect(change.coverage).toBeCloseTo(u.coverage, 9);
  });

  it("lists stations without a row in stations_missing", () => {
    const got = utilityTdd(u.cik, [...u.stations, "USW00099099"], q1, 2025, 1);
    expect(got.stations_missing).toEqual(["USW00099099"]);
    expect(got.stations_used).toEqual(u.stations);
  });

  it("throws when no station has a row", () => {
    expect(() => utilityTdd(u.cik, ["USW00099099"], q1, 2025, 1)).toThrow();
  });
});

describe("stationQuarterFromRow", () => {
  it("accepts numbers and numeric strings", () => {
    const fromNums = stationQuarterFromRow({
      station_id: "USW00099001",
      year: 2025,
      quarter: 1,
      hdd: 10,
      cdd: 2,
      days_observed: 5,
      days_in_quarter: 90,
      coverage: 5 / 90,
    });
    expect(fromNums.hdd).toBe(10);
    expect(fromNums.quarter).toBe(1);

    const fromStrs = stationQuarterFromRow({
      station_id: "USW00099001",
      year: "2025",
      quarter: "1",
      hdd: "10",
      cdd: "2",
      days_observed: "5",
      days_in_quarter: "90",
      coverage: String(5 / 90),
    });
    expect(fromStrs).toEqual(fromNums);
  });

  it("throws on a missing column", () => {
    expect(() =>
      stationQuarterFromRow({
        station_id: "USW00099001",
        year: 2025,
        quarter: 1,
        hdd: 10,
        cdd: 2,
        days_observed: 5,
        days_in_quarter: 90,
      }),
    ).toThrow();
  });

  it("throws on a null column instead of reading it as 0", () => {
    expect(() =>
      stationQuarterFromRow({
        station_id: "USW00099001",
        year: 2025,
        quarter: 1,
        hdd: null,
        cdd: 2,
        days_observed: 5,
        days_in_quarter: 90,
        coverage: 5 / 90,
      }),
    ).toThrow(/hdd/);
  });
});

describe("degreeDaySql", () => {
  it("renders 2025 Q1 with defaults, deduped stations, and required fragments", () => {
    const sql = degreeDaySql({
      year: 2025,
      quarter: 1,
      stations: ["USW00013740", "USW00094728", "USW00013740"],
    });
    expect(sql).toContain("won.ghcn_2025_tmax");
    expect(sql).toContain("won.ghcn_2025_tmin");
    expect(sql.match(/'USW00013740'/g)?.length).toBe(1);
    expect(sql).toContain("'USW00094728'");
    expect(sql).toContain("'20250101'");
    expect(sql).toContain("'20250331'");
    expect(sql).toContain("90 AS days_in_quarter");
    expect(sql).toContain("/ 90.0");
    expect(sql).toMatch(/\(x\.Q_FLAG IS NULL OR x\.Q_FLAG = ''\)/);
    expect(sql).toMatch(/\(n\.Q_FLAG IS NULL OR n\.Q_FLAG = ''\)/);
    expect(sql).toContain("GROUP BY x.ID");
    expect(sql).not.toContain(";");

    const aliases = [
      "station_id",
      "year",
      "quarter",
      "hdd",
      "cdd",
      "days_observed",
      "days_in_quarter",
      "coverage",
    ];
    let last = -1;
    for (const a of aliases) {
      const idx = sql.indexOf(`AS ${a}`);
      expect(idx).toBeGreaterThan(last);
      last = idx;
    }

    expect(DEGREE_DAY_BASE_F).toBe(65);
  });

  it("uses 91 days for 2024 Q1 and custom table names when given", () => {
    const sql2024 = degreeDaySql({
      year: 2024,
      quarter: 1,
      stations: ["USW00013740"],
    });
    expect(sql2024).toContain("91 AS days_in_quarter");
    expect(sql2024).toContain("/ 91.0");

    const custom = degreeDaySql({
      year: 2025,
      quarter: 1,
      stations: ["USW00013740"],
      tmaxTable: "cache.tmax_view",
      tminTable: "cache.tmin_view",
    });
    expect(custom).toContain("cache.tmax_view");
    expect(custom).toContain("cache.tmin_view");
    expect(custom).not.toContain("won.ghcn_2025_tmax");
  });

  it("throws on invalid inputs", () => {
    expect(() => degreeDaySql({ year: 2025, quarter: 1, stations: [] })).toThrow();
    expect(() =>
      degreeDaySql({
        year: 2025,
        quarter: 1,
        stations: ["USW00013740'; DROP TABLE x --"],
      }),
    ).toThrow();
    expect(() =>
      degreeDaySql({ year: 2025, quarter: 1, stations: ["usw00013740"] }),
    ).toThrow();
    expect(() =>
      degreeDaySql({ year: 2025, quarter: 5 as Quarter, stations: ["USW00013740"] }),
    ).toThrow();
    expect(() =>
      degreeDaySql({ year: 2025.5, quarter: 1, stations: ["USW00013740"] }),
    ).toThrow();
    expect(() =>
      degreeDaySql({
        year: 2025,
        quarter: 1,
        stations: ["USW00013740"],
        tmaxTable: "won.ghcn'bad",
      }),
    ).toThrow();
    expect(() =>
      degreeDaySql({
        year: 2025,
        quarter: 1,
        stations: ["USW00013740"],
        tmaxTable: "won.ghcn bad",
      }),
    ).toThrow();
    expect(() =>
      degreeDaySql({
        year: 2025,
        quarter: 1,
        stations: ["USW00013740"],
        tmaxTable: "nodot",
      }),
    ).toThrow();
  });
});
