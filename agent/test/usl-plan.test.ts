import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PlanError,
  cleanDescription,
  fkLines,
  renderCompileUsl,
  renderDescriptions,
  validatePlan,
} from "../src/tools/uslPlan.ts";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/crosswalk-usl-plan.json", import.meta.url), "utf8"),
) as {
  plan: unknown;
  expected: {
    table_order: string[];
    fk_lines: string[];
    ddl_must_contain: string[];
    ddl_must_not_contain: string[];
    description_statements: string[];
  };
  invalid_plans: { name: string; plan: unknown; error_code: string }[];
};

describe("validatePlan", () => {
  it("accepts the fixture plan and preserves table order", () => {
    const plan = validatePlan(fixture.plan);
    expect(plan.tables.map((t) => t.name)).toEqual(fixture.expected.table_order);
    expect(fkLines(plan)).toEqual(fixture.expected.fk_lines);
  });

  it.each(fixture.invalid_plans)("$name → $error_code", ({ plan, error_code }) => {
    expect(() => validatePlan(plan)).toThrow(PlanError);
    try {
      validatePlan(plan);
    } catch (e) {
      expect(e).toBeInstanceOf(PlanError);
      expect((e as PlanError).code).toBe(error_code);
    }
  });

  it("rejects an fk with verdict REJECTED", () => {
    const input = structuredClone(fixture.plan) as {
      fks: { from: string; to: string; transform: string; verdict?: string }[];
    };
    input.fks[0]!.verdict = "REJECTED";
    expect(() => validatePlan(input)).toThrow(PlanError);
    try {
      validatePlan(input);
    } catch (e) {
      expect((e as PlanError).code).toBe("bad_verdict");
    }
  });

  it("accepts an fk with verdict PARTIAL", () => {
    const input = structuredClone(fixture.plan) as {
      fks: { from: string; to: string; transform: string; verdict?: string }[];
    };
    input.fks[0]!.verdict = "PARTIAL";
    const plan = validatePlan(input);
    expect(plan.fks[0]!.verdict).toBe("PARTIAL");
  });

  it("applies nullable defaults and rejects out-of-range varchar", () => {
    const base = {
      usl: "crosswalk_usl",
      namespace: "lightning.metastore.crosswalk",
      tables: [
        {
          name: "t",
          source: "cw.t",
          columns: [
            { name: "id", type: "varchar(10)" },
            { name: "note", type: "varchar(20)" },
          ],
          pk: ["id"],
        },
      ],
      fks: [],
    };
    const plan = validatePlan(base);
    expect(plan.tables[0]!.columns[0]!.nullable).toBe(false);
    expect(plan.tables[0]!.columns[1]!.nullable).toBe(true);

    expect(() =>
      validatePlan({
        ...base,
        tables: [
          {
            name: "t",
            source: "cw.t",
            columns: [{ name: "id", type: "varchar(4001)" }],
            pk: ["id"],
          },
        ],
      }),
    ).toThrow(PlanError);
    try {
      validatePlan({
        ...base,
        tables: [
          {
            name: "t",
            source: "cw.t",
            columns: [{ name: "id", type: "varchar(4001)" }],
            pk: ["id"],
          },
        ],
      });
    } catch (e) {
      expect((e as PlanError).code).toBe("bad_type");
    }

    try {
      validatePlan({
        ...base,
        tables: [
          {
            name: "t",
            source: "cw.t",
            columns: [{ name: "id", type: "varchar(0)" }],
            pk: ["id"],
          },
        ],
      });
    } catch (e) {
      expect((e as PlanError).code).toBe("bad_type");
      return;
    }
    expect.fail("expected PlanError for varchar(0)");
  });
});

describe("renderCompileUsl", () => {
  it("matches fixture DDL must-contain / must-not and shape rules", () => {
    const plan = validatePlan(fixture.plan);
    const ddl = renderCompileUsl(plan);
    for (const s of fixture.expected.ddl_must_contain) {
      expect(ddl).toContain(s);
    }
    for (const s of fixture.expected.ddl_must_not_contain) {
      expect(ddl).not.toContain(s);
    }
    expect(ddl.startsWith(
      "COMPILE USL IF NOT EXISTS crosswalk_usl DEPLOY NAMESPACE lightning.metastore.crosswalk DDL",
    )).toBe(true);
    expect((ddl.match(/CREATE TABLE/g) ?? []).length).toBe(8);
    expect((ddl.match(/;/g) ?? []).length).toBe(7);
    expect(ddl.endsWith(";")).toBe(false);
    expect(ddl).toContain("code varchar(2) NOT NULL PRIMARY KEY");
    const usBlock = ddl.slice(ddl.indexOf("CREATE TABLE utility_state"));
    const usEnd = usBlock.indexOf("\nCREATE TABLE ");
    const utilityState = usEnd === -1 ? usBlock : usBlock.slice(0, usEnd);
    expect(utilityState).toMatch(/PRIMARY KEY \(cik, state\)\s*\)/);
    expect(utilityState).toContain("cik varchar(10) NOT NULL");
    expect(utilityState).toContain("state varchar(2) NOT NULL");
  });
});

describe("renderDescriptions and cleanDescription", () => {
  it("emits the fixture description statements first and cleans text", () => {
    const plan = validatePlan(fixture.plan);
    const stmts = renderDescriptions(plan);
    expect(stmts.slice(0, 3)).toEqual(fixture.expected.description_statements);
    expect(cleanDescription("It's a test; really  ")).toBe("Its a test, really");
  });

  it("addresses the object by its dotted path, the grammar that compiled on 2.4.3.1", () => {
    const plan = validatePlan(fixture.plan);
    const stmts = renderDescriptions(plan);
    expect(stmts[0]).toMatch(
      /^UPDATE USL lightning\.metastore\.crosswalk\.crosswalk_usl\.state SET TABLE DESCRIPTION /,
    );
    expect(stmts[1]).toMatch(
      /^UPDATE USL lightning\.metastore\.crosswalk\.crosswalk_usl\.state\.code SET COLUMN DESCRIPTION /,
    );
    for (const s of stmts) {
      expect(s).not.toContain(" NAMESPACE ");
      expect(s).not.toContain(";");
      expect(s).not.toContain("'");
    }
  });

  it("renders a model-level description first when the plan carries one", () => {
    const input = { ...(fixture.plan as object), description: "Crosswalk's model; v1" };
    const stmts = renderDescriptions(validatePlan(input));
    expect(stmts[0]).toBe(
      "UPDATE USL lightning.metastore.crosswalk.crosswalk_usl SET DESCRIPTION Crosswalks model, v1",
    );
    expect(stmts.slice(1, 4)).toEqual(fixture.expected.description_statements);
    expect(validatePlan(fixture.plan).description).toBeUndefined();
  });
});
