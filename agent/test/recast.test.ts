import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { growth } from "../src/tools/frames.ts";
import {
  checkRecast,
  comparativeFact,
  currentFact,
  factsForPeriod,
  likeForLikeGrowth,
  matchesPeriod,
  originalFact,
  type CompanyConcept,
  type ConceptFact,
} from "../src/tools/recast.ts";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/companyconcept-recast.json", import.meta.url), "utf8"),
) as {
  concept: CompanyConcept;
  expected: {
    growth_like_for_like: number;
    cy2025q1_accn: string;
  };
};

const concept = fixture.concept;

function fact(partial: Partial<ConceptFact> & Pick<ConceptFact, "end" | "val" | "accn" | "fy" | "fp" | "form" | "filed">): ConceptFact {
  return partial;
}

describe("factsForPeriod", () => {
  it("keeps quarterly and FY facts and excludes YTD spans", () => {
    expect(factsForPeriod(concept, { year: 2024, quarter: 1 })).toHaveLength(2);
    expect(factsForPeriod(concept, { year: 2024, quarter: 2 })).toHaveLength(2);
    expect(factsForPeriod(concept, { year: 2024, quarter: 3 })).toHaveLength(1);
    expect(factsForPeriod(concept, { year: 2024, quarter: null })).toHaveLength(1);
    expect(factsForPeriod(concept, { year: 2023, quarter: null })).toHaveLength(2);
    expect(factsForPeriod(concept, { year: 2025, quarter: 3 })).toHaveLength(0);
  });
});

describe("originalFact, comparativeFact, currentFact", () => {
  it("picks original, comparative, and current for Q1 2024/2025", () => {
    const q1_2024 = factsForPeriod(concept, { year: 2024, quarter: 1 });
    const orig = originalFact(q1_2024);
    expect(orig?.accn).toBe("0009999999-24-000002");
    expect(orig?.val).toBe(1e9);

    const comp = comparativeFact(q1_2024, { year: 2024, quarter: 1 });
    expect(comp?.accn).toBe("0009999999-25-000002");
    expect(comp?.val).toBe(0.98e9);

    const q1_2025 = factsForPeriod(concept, { year: 2025, quarter: 1 });
    const cur = currentFact(q1_2025, { year: 2025, quarter: 1 });
    expect(cur?.accn).toBe("0009999999-25-000002");
    expect(cur?.val).toBe(1.1e9);

    const q3_2024 = factsForPeriod(concept, { year: 2024, quarter: 3 });
    expect(comparativeFact(q3_2024, { year: 2024, quarter: 3 })).toBeNull();
  });
});

describe("checkRecast", () => {
  it("detects the Q1 2024 recast under rule R1", () => {
    const r = checkRecast(concept, { year: 2024, quarter: 1 });
    expect(r.recast).toBe(true);
    expect(r.chosen).toBe(980000000);
    expect(r.conflict).toBe("recast_comparative");
    expect(r.rule).toBe("R1");
    expect(r.original?.accn).toBe("0009999999-24-000002");
    expect(r.comparative?.accn).toBe("0009999999-25-000002");
    expect(r.period).toBe("CY2024Q1");
  });

  it("keeps equal comparative as R1 without a recast flag", () => {
    const q2 = checkRecast(concept, { year: 2024, quarter: 2 });
    expect(q2.recast).toBe(false);
    expect(q2.chosen).toBe(900000000);
    expect(q2.comparative).not.toBeNull();

    const fy = checkRecast(concept, { year: 2023, quarter: null });
    expect(fy.recast).toBe(false);
    expect(fy.chosen).toBe(3900000000);
  });

  it("uses the original when there is no comparative", () => {
    const q3 = checkRecast(concept, { year: 2024, quarter: 3 });
    expect(q3.comparative).toBeNull();
    expect(q3.recast).toBe(false);
    expect(q3.chosen).toBe(1200000000);
  });
});

describe("likeForLikeGrowth", () => {
  it("applies R1 for Q1 2025 vs recast Q1 2024", () => {
    const lfl = likeForLikeGrowth(concept, { year: 2025, quarter: 1 });
    expect(lfl.rev_current).toBe(1.1e9);
    expect(lfl.rev_previous).toBe(0.98e9);
    expect(lfl.growth).toBeCloseTo(fixture.expected.growth_like_for_like, 15);
    expect(lfl.current_accn).toBe(fixture.expected.cy2025q1_accn);
    expect(lfl.recast.recast).toBe(true);
    expect(growth(1.1e9, 1e9)).toBe(0.1);
  });

  it("throws when the current period has no fact", () => {
    expect(() => likeForLikeGrowth(concept, { year: 2025, quarter: 3 })).toThrow();
  });

  it("computes FY 2024 vs FY 2023 without a recast", () => {
    const lfl = likeForLikeGrowth(concept, { year: 2024, quarter: null });
    expect(lfl.rev_current).toBe(4.1e9);
    expect(lfl.rev_previous).toBe(3.9e9);
    expect(lfl.growth).toBeCloseTo(growth(4.1e9, 3.9e9), 15);
    expect(lfl.recast.recast).toBe(false);
  });
});

describe("matchesPeriod edge cases", () => {
  it("rejects missing start and end too far from the quarter close", () => {
    expect(
      matchesPeriod(
        fact({
          end: "2024-03-31",
          val: 1,
          accn: "a",
          fy: 2024,
          fp: "Q1",
          form: "10-Q",
          filed: "2024-05-01",
        }),
        { year: 2024, quarter: 1 },
      ),
    ).toBe(false);

    expect(
      matchesPeriod(
        fact({
          start: "2024-01-01",
          end: "2024-04-20",
          val: 1,
          accn: "a",
          fy: 2024,
          fp: "Q1",
          form: "10-Q",
          filed: "2024-05-01",
        }),
        { year: 2024, quarter: 1 },
      ),
    ).toBe(false);
  });

  it("accepts a 95-day span ending 10 days after Mar 31", () => {
    // 2024-01-06 .. 2024-04-10 = 95 days; Apr 10 is 10 days after Mar 31.
    expect(
      matchesPeriod(
        fact({
          start: "2024-01-06",
          end: "2024-04-10",
          val: 1,
          accn: "a",
          fy: 2024,
          fp: "Q1",
          form: "10-Q",
          filed: "2024-05-01",
        }),
        { year: 2024, quarter: 1 },
      ),
    ).toBe(true);
  });
});
