import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  declarationsByState,
  fromGatewayRows,
  onlyMajorDisasters,
  quarterOf,
  statesOutsideReference,
  type FemaRow,
  type StateDeclarations,
} from "../src/tools/fema.ts";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/crosswalk-fema.json", import.meta.url), "utf8"),
) as {
  synthetic: boolean;
  rows: Record<string, unknown>[];
  expected: {
    rows_total: number;
    dr_rows: number;
    dr_disasters: number;
    q1_2025_dr_rows: number;
    q1_2025_dr_disasters: number;
    q1_2025_states: string[];
    quarter_of: Record<string, string>;
    by_state_q1_2025: StateDeclarations[];
    states_outside_reference: string[];
  };
};

const rows: FemaRow[] = fromGatewayRows(fixture.rows);

describe("quarterOf", () => {
  it("reproduces every expected.quarter_of entry", () => {
    for (const [iso, period] of Object.entries(fixture.expected.quarter_of)) {
      expect(quarterOf(iso)).toBe(period);
    }
  });

  it("asserts Q1/Q2 and Q4 boundaries explicitly", () => {
    expect(quarterOf("2025-03-31T23:59:59.000Z")).toBe("CY2025Q1");
    expect(quarterOf("2025-04-01T00:00:00.000Z")).toBe("CY2025Q2");
    expect(quarterOf("2024-12-31")).toBe("CY2024Q4");
  });

  it("throws on short or non-numeric month input", () => {
    expect(() => quarterOf("2025")).toThrow();
    expect(() => quarterOf("2025-xx-01")).toThrow();
  });

  it("throws on a month outside 1 to 12 instead of inventing a fifth quarter", () => {
    expect(() => quarterOf("2025-13-01")).toThrow();
    expect(() => quarterOf("2025-00-15")).toThrow();
    expect(quarterOf("2025-12-01")).toBe("CY2025Q4");
    expect(quarterOf("2025-01-01")).toBe("CY2025Q1");
  });
});

describe("onlyMajorDisasters", () => {
  it("keeps DR rows and distinct disaster counts from the fixture", () => {
    const dr = onlyMajorDisasters(rows);
    expect(dr).toHaveLength(fixture.expected.dr_rows);
    const distinct = new Set(dr.map((r) => r.disasterNumber));
    expect(distinct.size).toBe(fixture.expected.dr_disasters);
  });
});

describe("declarationsByState", () => {
  it("equals by_state_q1_2025 with matching row and state totals", () => {
    const got = declarationsByState(rows, "CY2025Q1");
    expect(got).toEqual(fixture.expected.by_state_q1_2025);
    expect(got.reduce((sum, e) => sum + e.rows, 0)).toBe(
      fixture.expected.q1_2025_dr_rows,
    );
    expect([...got.map((e) => e.state)].sort()).toEqual(
      [...fixture.expected.q1_2025_states].sort(),
    );
  });

  it("counts a KY disaster once across five county rows", () => {
    const ky = fixture.expected.by_state_q1_2025.find((e) => e.state === "KY");
    expect(ky).toBeDefined();
    const got = declarationsByState(rows, "CY2025Q1").find((e) => e.state === "KY");
    expect(got?.declarations).toBe(ky!.declarations);
    expect(got?.rows).toBe(ky!.rows);
  });
});

describe("statesOutsideReference", () => {
  it("flags PR against the five reference states", () => {
    const entries = declarationsByState(rows, "CY2025Q1");
    expect(
      statesOutsideReference(entries, ["KY", "CA", "OK", "SC", "OR"]),
    ).toEqual(fixture.expected.states_outside_reference);
  });
});

describe("fromGatewayRows", () => {
  it("accepts disasterNumber as the string \"9001\"", () => {
    const [first] = fromGatewayRows([
      {
        disasterNumber: "9001",
        state: "KY",
        fipsStateCode: "21",
        fipsCountyCode: "001",
        declarationDate: "2025-02-24T00:00:00.000Z",
        incidentType: "Severe Storm",
        declarationType: "DR",
        designatedArea: "County 001 (synthetic)",
      },
    ]);
    expect(first.disasterNumber).toBe(9001);
  });

  it("throws on a row without declarationType", () => {
    expect(() =>
      fromGatewayRows([
        {
          disasterNumber: 9001,
          state: "KY",
          declarationDate: "2025-02-24T00:00:00.000Z",
        },
      ]),
    ).toThrow();
  });
});
