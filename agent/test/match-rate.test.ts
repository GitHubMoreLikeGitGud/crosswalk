import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  matchRateSql,
  measureInMemory,
  parseMatchRows,
  validateProposal,
  verdictFor,
  type KeyProposal,
} from "../src/tools/matchRate.ts";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/crosswalk-transforms.json", import.meta.url), "utf8"),
) as {
  match_rate_cases: {
    name: string;
    proposal: KeyProposal;
    left_rows: Record<string, unknown>[];
    right_rows: Record<string, unknown>[];
    expected: {
      left_keys: number;
      matched_keys: number;
      rate: number;
      orphans: string[];
      orphans_total: number;
      verdict: string;
    };
  }[];
};

describe("measureInMemory", () => {
  for (const c of fixture.match_rate_cases) {
    it(`reproduces ${c.name}`, () => {
      const got = measureInMemory(c.proposal, c.left_rows, c.right_rows);
      expect(got.left_keys).toBe(c.expected.left_keys);
      expect(got.matched_keys).toBe(c.expected.matched_keys);
      expect(got.orphans).toEqual(c.expected.orphans);
      expect(got.orphans_total).toBe(c.expected.orphans_total);
      expect(got.verdict).toBe(c.expected.verdict);
      expect(Math.abs(got.rate - c.expected.rate)).toBeLessThan(1e-12);
    });
  }
});

describe("verdictFor", () => {
  it("applies the fixed thresholds", () => {
    expect(verdictFor(0.95)).toBe("VERIFIED");
    expect(verdictFor(0.9499)).toBe("PARTIAL");
    expect(verdictFor(0.8)).toBe("PARTIAL");
    expect(verdictFor(0.7999)).toBe("REJECTED");
    expect(verdictFor(0)).toBe("REJECTED");
  });
});

describe("matchRateSql", () => {
  const cik = fixture.match_rate_cases.find((c) => c.name === "cik_lpad10_partial")!;
  const loc = fixture.match_rate_cases.find((c) => c.name === "loc_strip_prefix_verified")!;

  it("renders counts and orphans for cik_lpad10_partial", () => {
    const { counts, orphans } = matchRateSql(cik.proposal);
    expect(counts).toContain("COUNT(DISTINCT l.k) AS left_keys");
    expect(counts).toContain(
      "COUNT(DISTINCT CASE WHEN r.k IS NOT NULL THEN l.k END) AS matched_keys",
    );
    expect(counts).toContain("LPAD(CAST(l.`cik` AS STRING), 10, '0')");
    expect(counts).toContain("FROM cw.frames_revenues_cy2025q1 l");
    expect(counts).toContain("FROM cw.utility_profiles r");
    expect(counts).toContain("ON r.k = l.k");
    expect(counts).not.toContain(";");
    expect(orphans).toContain("WHERE r.k IS NULL");
    expect(orphans).toContain("ORDER BY l.k");
    expect(orphans).toContain("LIMIT 10");
    expect(orphans).not.toContain(";");
  });

  it("renders strip_prefix for loc_strip_prefix_verified", () => {
    const { counts } = matchRateSql(loc.proposal);
    expect(counts).toContain("LIKE 'US-%'");
  });
});

describe("validateProposal", () => {
  const base: KeyProposal = {
    leftObject: "cw.frames_revenues_cy2025q1",
    leftColumn: "cik",
    rightObject: "cw.utility_profiles",
    rightColumn: "cik10",
    transform: "lpad10",
  };

  it("refuses bad object and column names and transforms", () => {
    expect(() => validateProposal({ ...base, leftObject: "frames" })).toThrow(Error);
    expect(() => validateProposal({ ...base, leftObject: "cw.frames'x" })).toThrow(Error);
    expect(() => validateProposal({ ...base, leftObject: "cw.frames revenues" })).toThrow(Error);
    expect(() =>
      validateProposal({ ...base, leftObject: "cw.frames; DROP TABLE x" }),
    ).toThrow(Error);
    expect(() => validateProposal({ ...base, leftColumn: "entity-name" })).toThrow(Error);
    expect(() => validateProposal({ ...base, leftColumn: "cik'" })).toThrow(Error);
    expect(() => validateProposal({ ...base, transform: "lower" })).toThrow(Error);
    expect(() =>
      validateProposal({ ...base, leftObject: "won.frames_revenues_cy2025q1" }),
    ).toThrow(Error);
    expect(() => validateProposal({ ...base, rightObject: "WON_SEC.frames" })).toThrow(Error);
    expect(() => validateProposal({ ...base, rightObject: "won_sec.frames" })).toThrow(Error);
    expect(() => validateProposal({ ...base, rightObject: "Won.frames" })).toThrow(Error);
  });
});

describe("parseMatchRows", () => {
  const proposal: KeyProposal = {
    leftObject: "cw.frames_revenues_cy2025q1",
    leftColumn: "cik",
    rightObject: "cw.utility_profiles",
    rightColumn: "cik10",
    transform: "lpad10",
  };

  it("accepts numbers and numeric strings and sets orphans_total null", () => {
    const got = parseMatchRows(
      proposal,
      [{ left_keys: "7", matched_keys: 6 }],
      [{ orphan: "0009999999" }],
    );
    expect(got.left_keys).toBe(7);
    expect(got.matched_keys).toBe(6);
    expect(got.rate).toBe(6 / 7);
    expect(got.verdict).toBe("PARTIAL");
    expect(got.orphans).toEqual(["0009999999"]);
    expect(got.orphans_total).toBeNull();
  });

  it("throws on a missing column", () => {
    expect(() => parseMatchRows(proposal, [{ left_keys: 7 }], [])).toThrow(Error);
  });

  it("throws on a null count instead of reading it as zero", () => {
    expect(() => parseMatchRows(proposal, [{ left_keys: null, matched_keys: 6 }], [])).toThrow(
      Error,
    );
    expect(() => parseMatchRows(proposal, [{ left_keys: 7, matched_keys: "" }], [])).toThrow(
      Error,
    );
  });

  it("throws on two count rows", () => {
    expect(() =>
      parseMatchRows(
        proposal,
        [
          { left_keys: 7, matched_keys: 6 },
          { left_keys: 7, matched_keys: 6 },
        ],
        [],
      ),
    ).toThrow(Error);
  });
});
