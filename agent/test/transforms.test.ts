import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTransform } from "../src/tools/transforms.ts";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/crosswalk-transforms.json", import.meta.url), "utf8"),
) as {
  transforms: Record<string, { input: unknown; expected: unknown }[]>;
};

describe("parseTransform apply", () => {
  it("matches every transforms[spec][] pair", () => {
    for (const [spec, pairs] of Object.entries(fixture.transforms)) {
      const t = parseTransform(spec);
      for (const { input, expected } of pairs) {
        expect(t.apply(input)).toBe(expected);
      }
    }
  });
});

describe("parseTransform refuses invalid specs", () => {
  for (const bad of [
    "to_quarter",
    "lower",
    "substr(0,2)",
    "substr(4, 2)",
    "substr(4)",
    "strip_prefix('CA-')",
    "strip_prefix(US-)",
    "",
    "identity;",
  ]) {
    it(`refuses ${JSON.stringify(bad)}`, () => {
      expect(() => parseTransform(bad)).toThrow(Error);
    });
  }
});

describe("transform sql", () => {
  const cases: { spec: string; needle: string }[] = [
    { spec: "identity", needle: "CAST(" },
    { spec: "upper", needle: "UPPER(" },
    { spec: "lpad10", needle: "LPAD(" },
    { spec: "substr(4,2)", needle: "SUBSTR(" },
    { spec: "strip_prefix('US-')", needle: "LIKE 'US-%'" },
    { spec: "yyyymmdd_to_date", needle: "CONCAT(" },
    { spec: "iso_to_quarter", needle: "FLOOR(" },
  ];

  for (const { spec, needle } of cases) {
    it(`${spec} sql contains ${needle} and no semicolon`, () => {
      const sql = parseTransform(spec).sql("l.cik");
      expect(sql).toContain(needle);
      expect(sql).not.toContain(";");
    });
  }
});
