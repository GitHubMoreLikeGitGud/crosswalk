import { describe, expect, it } from "vitest";
import {
  FRAME_PERIOD_RE,
  cik10,
  conceptUrl,
  framePeriod,
  frameTableName,
  frameUrl,
  growth,
  locToState,
  parseFramePeriod,
  parseFrameRows,
  probeTag,
  submissionsUrl,
} from "../src/tools/frames.ts";

describe("cik10", () => {
  it("pads a number and keeps a padded string", () => {
    expect(cik10(1326160)).toBe("0001326160");
    expect(cik10("0001326160")).toBe("0001326160");
  });

  it("throws on empty, too long, or non-digit input", () => {
    expect(() => cik10("")).toThrow();
    expect(() => cik10("12345678901")).toThrow();
    expect(() => cik10("12a")).toThrow();
  });
});

describe("locToState", () => {
  it("extracts a US state code and rejects others", () => {
    expect(locToState("US-NC")).toBe("NC");
    expect(locToState("GB")).toBeNull();
    expect(locToState("us-nc")).toBeNull();
    expect(locToState(null)).toBeNull();
  });
});

describe("framePeriod and parseFramePeriod", () => {
  it("formats quarters and fiscal years", () => {
    expect(framePeriod({ year: 2025, quarter: 1 })).toBe("CY2025Q1");
    expect(framePeriod({ year: 2024, quarter: null })).toBe("CY2024");
  });

  it("round-trips and rejects bad ids", () => {
    expect(parseFramePeriod("CY2025Q1")).toEqual({ year: 2025, quarter: 1 });
    expect(parseFramePeriod("CY2024")).toEqual({ year: 2024, quarter: null });
    expect(() => parseFramePeriod("cy2025q1")).toThrow();
    expect(() => parseFramePeriod("CY2025Q5")).toThrow();
    expect(() => parseFramePeriod("2025Q1")).toThrow();
  });

  it("FRAME_PERIOD_RE accepts Q1–Q3 only", () => {
    expect(FRAME_PERIOD_RE.test("CY2025Q1")).toBe(true);
    expect(FRAME_PERIOD_RE.test("CY2025Q4")).toBe(false);
    expect(FRAME_PERIOD_RE.test("CY2024")).toBe(false);
    expect(FRAME_PERIOD_RE.test("CY2025Q1 ")).toBe(false);
  });
});

describe("frameTableName and URLs", () => {
  it("builds table names from tag slugs", () => {
    expect(frameTableName("Revenues", { year: 2025, quarter: 1 })).toBe(
      "frames_revenues_cy2025q1",
    );
    expect(
      frameTableName("RevenueFromContractWithCustomerExcludingAssessedTax", {
        year: 2025,
        quarter: 1,
      }),
    ).toBe("frames_rfc_cy2025q1");
    expect(frameTableName("Revenues", { year: 2024, quarter: null })).toBe(
      "frames_revenues_cy2024",
    );
  });

  it("builds the three data.sec.gov URLs", () => {
    expect(frameUrl("Revenues", { year: 2025, quarter: 1 })).toBe(
      "https://data.sec.gov/api/xbrl/frames/us-gaap/Revenues/USD/CY2025Q1.json",
    );
    expect(conceptUrl(1326160, "Revenues")).toBe(
      "https://data.sec.gov/api/xbrl/companyconcept/CIK0001326160/us-gaap/Revenues.json",
    );
    expect(submissionsUrl(1326160)).toBe(
      "https://data.sec.gov/submissions/CIK0001326160.json",
    );
  });
});

describe("probeTag", () => {
  it("picks the first finite tag in REVENUE_TAGS order", () => {
    expect(
      probeTag({
        Revenues: null,
        RevenueFromContractWithCustomerExcludingAssessedTax: 5,
      }),
    ).toEqual({
      tag: "RevenueFromContractWithCustomerExcludingAssessedTax",
      val: 5,
    });
    expect(probeTag({})).toBeNull();
    expect(
      probeTag({
        Revenues: 1,
        RevenueFromContractWithCustomerExcludingAssessedTax: 5,
      }),
    ).toEqual({ tag: "Revenues", val: 1 });
    expect(probeTag({ Revenues: Number.NaN })).toBeNull();
  });
});

describe("growth", () => {
  it("computes like-for-like growth and rejects non-positive previous", () => {
    expect(growth(1.1e9, 0.98e9)).toBeCloseTo(0.12244897959183673, 15);
    expect(() => growth(1, 0)).toThrow();
    expect(() => growth(1, -5)).toThrow();
  });
});

describe("parseFrameRows", () => {
  it("pads cik, converts loc, coerces string val, keeps accn", () => {
    expect(
      parseFrameRows([
        {
          cik: 1326160,
          entityName: "Acme",
          loc: "US-NC",
          start: "2025-01-01",
          end: "2025-03-31",
          val: "1100000000",
          accn: "0001326160-25-000001",
        },
      ]),
    ).toEqual([
      {
        cik10: "0001326160",
        entityName: "Acme",
        state: "NC",
        start: "2025-01-01",
        end: "2025-03-31",
        val: 1100000000,
        accn: "0001326160-25-000001",
      },
    ]);
  });

  it("throws on a row without accn", () => {
    expect(() =>
      parseFrameRows([
        {
          cik: 1,
          entityName: "X",
          loc: null,
          start: "2025-01-01",
          end: "2025-03-31",
          val: 1,
        },
      ]),
    ).toThrow();
  });
});
