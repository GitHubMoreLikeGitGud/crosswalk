import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  baselineProposals,
  keyClassOf,
  toKeyProposal,
  transformFromSamples,
  type BaselineChoice,
  type ProbeSummary,
} from "../src/tools/baselineKeys.ts";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/crosswalk-discovery.json", import.meta.url), "utf8"),
) as {
  baseline: {
    key_class: { object: string; column: string; expected: string | null }[];
    transform: {
      a: string[];
      b: string[];
      expected: [string, "a" | "b" | null];
    }[];
    cases: {
      name: string;
      probes: ProbeSummary[];
      limit: number;
      expected: BaselineChoice[];
    }[];
  };
};

describe("keyClassOf", () => {
  it("reproduces every baseline.key_class case", () => {
    for (const c of fixture.baseline.key_class) {
      expect(keyClassOf(c.object, c.column)).toBe(c.expected);
    }
  });
});

describe("transformFromSamples", () => {
  it("reproduces every baseline.transform case as [transform, side]", () => {
    for (const c of fixture.baseline.transform) {
      const { transform, side } = transformFromSamples(c.a, c.b);
      expect([transform, side]).toEqual(c.expected);
    }
  });
});

describe("baselineProposals", () => {
  it("reproduces every baseline.cases entry", () => {
    for (const c of fixture.baseline.cases) {
      expect(baselineProposals(c.probes, c.limit)).toEqual(c.expected);
    }
  });

  it("toKeyProposal accepts every demo_shape_limit_6 result", () => {
    const demo = fixture.baseline.cases.find((c) => c.name === "demo_shape_limit_6");
    expect(demo).toBeDefined();
    for (const choice of baselineProposals(demo!.probes, demo!.limit)) {
      expect(() => toKeyProposal(choice)).not.toThrow();
    }
  });

  it("won_object_refused names no won. object", () => {
    const won = fixture.baseline.cases.find((c) => c.name === "won_object_refused");
    expect(won).toBeDefined();
    const results = baselineProposals(won!.probes, won!.limit);
    for (const r of results) {
      expect(r.left.object.toLowerCase().startsWith("won.")).toBe(false);
      expect(r.right.object.toLowerCase().startsWith("won.")).toBe(false);
    }
  });

  it("returns [] for empty probes or a single probe", () => {
    expect(baselineProposals([])).toEqual([]);
    expect(
      baselineProposals([
        {
          object: "cw.seed_utilities",
          candidates: [{ column: "cik", distinct: 43, rows: 43, samples: ["0009000001"] }],
        },
      ]),
    ).toEqual([]);
  });
});
