# C2: USL plan schema, validator and DDL renderer

## Goal

`agent/src/tools/uslPlan.ts` exists and is unit-tested: it defines the plan schema `{usl, namespace, tables: [{name, source, description?, columns: [{name, type, nullable?, description?}], pk: string[]}], fks: [{from, to, transform, match_rate?, verdict?}]}`, validates a plan against a closed grammar (identifiers, column types, primary and foreign key references, the closed transform set, reserved words, the namespace), and renders the validated plan into the ONE-statement `COMPILE USL ... DDL` text that Zetaris Lightning 2.4.3.1 accepts, plus the `UPDATE USL ... SET TABLE | COLUMN DESCRIPTION` statements for the descriptions. The model never writes DDL: this renderer is the only path from verified keys to a semantic layer. No model calls, no network, no database connection.

## Workspace

This repository (`agent/` is the Node 22 + TypeScript package; run commands from `agent/`). Other work may be in progress in the working tree while this task runs. Leave every file that is not under **Deliverables** alone.

## Read first

- `AGENTS.md`, `.cursor/rules/style.mdc`, `.cursor/rules/safety.mdc` and the "Writing SQL" and "Objects we own" sections of `.cursor/rules/zetaris.mdc`.
- `zetaris/sql/won-reference/05_won_usl_create.sql`: the sister entry's USL DDL that compiled on Zetaris 2.4.3.1. The shape to reproduce is its `COMPILE USL IF NOT EXISTS <usl> DEPLOY NAMESPACE <namespace> DDL` statement with `CREATE TABLE` parts separated by `;` (one statement overall, no trailing `;`), inline `NOT NULL PRIMARY KEY` for a single-column key, a table-level `PRIMARY KEY (a, b)` for a composite key, inline `FOREIGN KEY REFERENCES <table>(<column>)`, and its `UPDATE USL ... SET TABLE DESCRIPTION` lines. Note its caveats: `tag` is a reserved word (the column is `xbrl_tag`), descriptions are unquoted text without semicolons or apostrophes.
- `agent/src/tools/transforms.ts` from task C1 (`isTransformSpec`) if it exists in the working tree; otherwise accept exactly the seven canonical spellings listed in `AGENTS.md` rule 4 with a local check, so this task does not depend on C1's timing.
- `agent/test/fixtures/crosswalk-usl-plan.json` (the fixture; described under **Inputs**) and `agent/test/fixtures/make_crosswalk_fixtures.py` (how it was produced; do not port its code).
- `agent/test/degree-days.test.ts` for the test style.

## Inputs

### Validation rules (the closed grammar)

Throw a `PlanError` carrying a `code` from this list and a plain message naming the offending table, column or key:

| code | when |
|---|---|
| `bad_shape` | the plan is not an object with string `usl` and `namespace`, a non-empty `tables` array and an `fks` array; a table without `columns` or `pk`; a column without `name` and `type` |
| `bad_identifier` | a table or column name not matching `^[a-z][a-z0-9_]{0,62}$` (lower-case snake case; Lightning folds identifiers) |
| `reserved_word` | a table or column name in `RESERVED = ["tag", "table", "select", "from", "where", "group", "order", "by", "key", "primary", "foreign", "references", "create", "usl", "namespace", "ddl", "date", "time", "user"]` |
| `duplicate_table` | two tables with the same name; also `duplicate_column` for two columns of one table |
| `bad_type` | a column type outside `varchar(n)` with `n` 1 to 4000, `int`, `double` |
| `unknown_column` | a `pk` entry, or either side of an fk, naming a column its table does not have |
| `unknown_table` | an fk `from` or `to` naming a table the plan does not have |
| `bad_key_ref` | an fk `from` or `to` not of the form `table.column`; an empty `pk` |
| `unknown_transform` | an fk `transform` outside the closed set |
| `bad_namespace` | `namespace` other than `lightning.metastore.crosswalk`; `usl` not matching the identifier rule |
| `bad_verdict` | an fk that carries `verdict` `REJECTED` (only VERIFIED or PARTIAL keys may enter the layer) |

A valid plan is returned frozen as `UslPlan` with defaults applied (`nullable: true` unless the column is in the pk or `nullable: false`).

### Rendering rules

`renderCompileUsl(plan)` returns one statement:

```
COMPILE USL IF NOT EXISTS <usl> DEPLOY NAMESPACE <namespace> DDL
CREATE TABLE <table> (
    <column> <type>[ NOT NULL][ PRIMARY KEY][ FOREIGN KEY REFERENCES <table>(<column>)],
    ...[,
    PRIMARY KEY (<a>, <b>)]
);
CREATE TABLE ... (
    ...
)
```

Tables in plan order; columns in plan order; a single-column pk is rendered inline as `NOT NULL PRIMARY KEY` on that column (and never also at table level); a composite pk is rendered as the last line `PRIMARY KEY (a, b)` with its columns `NOT NULL`; an fk whose `from` is `<this table>.<column>` is rendered inline on that column as `FOREIGN KEY REFERENCES <to table>(<to column>)`; the parts are joined with `;\n` and the text has no trailing `;`. The transform of an fk is not part of the DDL (Zetaris compares the activated columns as rendered by the activation queries); it is returned by `fkLines(plan)` for the join map as `"<from> -> <to> (<transform>)"`.

`renderDescriptions(plan)` returns one `UPDATE USL <namespace>.<usl>.<table> SET TABLE DESCRIPTION <text>` statement per table with a description and one `UPDATE USL <namespace>.<usl>.<table>.<column> SET COLUMN DESCRIPTION <text>` per column with a description, in plan order (an optional plan-level `description` renders first as `UPDATE USL <namespace>.<usl> SET DESCRIPTION <text>`). This is the grammar that compiled on Zetaris 2.4.3.1 in `zetaris/sql/won-reference/05_won_usl_create.sql`; the `<usl> NAMESPACE <namespace>` form belongs to `LOAD USL` only. (The first version of this task and its fixture had the LOAD USL form here; corrected by the reviewer after the run.) Description text is unquoted: apostrophes are dropped, semicolons become commas, runs of whitespace collapse to one space, and the text is trimmed.

### Fixture `agent/test/fixtures/crosswalk-usl-plan.json`

Synthetic. Keys: `plan` (the eight Crosswalk tables `state`, `sic_code`, `utility`, `utility_state`, `fema_declaration`, `station`, `revenue_quarter`, `weather_quarter` and eight fks), `expected{table_order[], fk_lines[], ddl_must_contain[], ddl_must_not_contain[], description_statements[]}` and `invalid_plans[]` as `{name, plan, error_code}` (nine cases: duplicate table, fk to an unknown table, fk to an unknown column, transform outside the set, pk naming a missing column, the reserved word `tag`, a hyphenated table name, the type `text`, the sister entry's namespace).

Read it with `JSON.parse(readFileSync(new URL("./fixtures/crosswalk-usl-plan.json", import.meta.url), "utf8"))`.

## Deliverables

| File | Contents |
|---|---|
| `agent/src/tools/uslPlan.ts` | Exports: the types `UslPlan`, `UslTable`, `UslColumn`, `UslFk`; `RESERVED`; `class PlanError extends Error { code: string }`; `validatePlan(input: unknown): UslPlan`; `renderCompileUsl(plan: UslPlan): string`; `renderDescriptions(plan: UslPlan): string[]`; `fkLines(plan: UslPlan): string[]`; `cleanDescription(text: string): string`. |
| `agent/test/usl-plan.test.ts` | vitest suite with at least the cases below. |

### Test cases that must exist

- `validatePlan(fixture.plan)` succeeds; its table names equal `expected.table_order`; `fkLines` equals `expected.fk_lines`.
- `renderCompileUsl` of the valid plan contains every string in `expected.ddl_must_contain`, none of `expected.ddl_must_not_contain`, starts with `COMPILE USL IF NOT EXISTS crosswalk_usl DEPLOY NAMESPACE lightning.metastore.crosswalk DDL`, has exactly 8 `CREATE TABLE` parts, exactly 7 `;` characters (between the parts) and does not end with `;`; `state.code` appears as `code varchar(2) NOT NULL PRIMARY KEY` and `utility_state` ends with `PRIMARY KEY (cik, state)` with both columns `NOT NULL`.
- `renderDescriptions` of the valid plan starts with the three statements in `expected.description_statements` in that order, and `cleanDescription("It's a test; really  ")` is `Its a test, really`.
- For every `invalid_plans[]` entry: `validatePlan(plan)` throws a `PlanError` whose `code` equals `error_code`.
- An fk with `verdict: "REJECTED"` throws `bad_verdict`; an fk with `verdict: "PARTIAL"` is accepted.
- Column defaults: a pk column is `nullable: false`; a plain column is `nullable: true`; a `varchar(4001)` is `bad_type`; `varchar(0)` is `bad_type`.

## Constraints

- No model calls, no network, no database access, no new dependencies, nothing added to `package.json`. Pure functions. ES modules, TypeScript run by tsx; `node:` builtins only.
- Never put a credential, a `User-Agent` string or a local path in code, tests or fixtures.
- The fixture files and `make_crosswalk_fixtures.py` are inputs: do not edit them or regenerate them.
- Do not edit `engines/`, `gateway/`, `zetaris/`, `.env.local`, `agent/package.json`, `agent/tsconfig.json`, `agent/tsconfig.tools.json`, the existing tests, or anything outside **Deliverables**.

## Checks

From `agent/`:

- `npx vitest run usl-plan` is green.
- `npx tsc --noEmit -p tsconfig.tools.json` reports no errors.

## Out of scope

The activation queries (`ACTIVATE USL TABLE ... AS SELECT ...`, written by the Zetaris lane from raw tables), `REGISTER DQ` statements, the gateway plan that sends the DDL, the match-rate renderer (C1), FEMA and station parsing (C3).

## Commit

`C2: USL plan validator and DDL renderer (Cursor Agent)`

Do not commit; leave the changes in the working tree.

## Run record

- Run 2026-10-25, Cursor Agent CLI 2026.10.22-27dcf5f (model Auto), headless with the prompt from `README.md`: 153.8 s wall, exit 0, no commit (as asked), only the two deliverables added. Cursor reported `npx vitest run usl-plan` 15/15 and the tools type-check clean; it imported `isTransformSpec` from C1's `transforms.ts`, which was in the working tree.
- Reviewed by hand against this file and `zetaris/sql/won-reference/05_won_usl_create.sql` (the full DDL of the fixture plan was rendered and read against the sister's compiled statement); checks re-run: 15 passed, tsc exit 0. Committed unchanged as `780d725` (`C2: USL plan validator and DDL renderer (Cursor Agent)`).
- Corrected in `92d0971` (`C2 review`): the first version of this task and its fixture gave `renderDescriptions` the `LOAD USL` grammar (`<usl> NAMESPACE <namespace>`); the `UPDATE USL` statements that compiled on 2.4.3.1 address the object by its dotted path (`<namespace>.<usl>.<table>[.<column>] SET [TABLE | COLUMN] DESCRIPTION <text>`), so the renderer, the generator's three expected statements and the Rendering rules paragraph above were changed to that grammar (a task defect, not Cursor's); an optional plan-level `description` renders first as `UPDATE USL <namespace>.<usl> SET DESCRIPTION <text>`; the test file added to `tsconfig.tools.json`. After: 17 passed, tsc exit 0.
