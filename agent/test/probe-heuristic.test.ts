import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  candidateKeyColumns,
  type DescribedColumn,
} from "../src/tools/probeHeuristic.ts";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/crosswalk-discovery.json", import.meta.url), "utf8"),
) as {
  synthetic: boolean;
  probe: {
    cases: {
      object: string;
      columns: DescribedColumn[];
      expected: string[];
      expected_max_2: string[];
    }[];
  };
};

describe("candidateKeyColumns", () => {
  it("reproduces every probe.cases expected and expected_max_2", () => {
    for (const c of fixture.probe.cases) {
      expect(candidateKeyColumns(c.columns)).toEqual(c.expected);
      expect(candidateKeyColumns(c.columns, 2)).toEqual(c.expected_max_2);
    }
  });

  it("skips double-typed columns even when the name matches a pattern", () => {
    expect(
      candidateKeyColumns([{ name: "cik_double", type: "double" }]),
    ).toEqual([]);
  });

  it("returns [] for an empty column list", () => {
    expect(candidateKeyColumns([])).toEqual([]);
  });
});
