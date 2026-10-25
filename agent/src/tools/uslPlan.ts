/** USL plan schema, closed-grammar validator, and COMPILE / DESCRIPTION renderers. */

import { isTransformSpec } from "./transforms.ts";

export const RESERVED = [
  "tag",
  "table",
  "select",
  "from",
  "where",
  "group",
  "order",
  "by",
  "key",
  "primary",
  "foreign",
  "references",
  "create",
  "usl",
  "namespace",
  "ddl",
  "date",
  "time",
  "user",
] as const;

const IDENT_RE = /^[a-z][a-z0-9_]{0,62}$/;
const KEY_REF_RE = /^([a-z][a-z0-9_]{0,62})\.([a-z][a-z0-9_]{0,62})$/;
const VARCHAR_RE = /^varchar\((\d+)\)$/;
const NAMESPACE = "lightning.metastore.crosswalk";

export type ColumnType = `varchar(${number})` | "int" | "double";

export interface UslColumn {
  name: string;
  type: ColumnType;
  nullable: boolean;
  description?: string;
}

export interface UslTable {
  name: string;
  source: string;
  description?: string;
  columns: UslColumn[];
  pk: string[];
}

export interface UslFk {
  from: string;
  to: string;
  transform: string;
  match_rate?: number;
  verdict?: "VERIFIED" | "PARTIAL";
}

export interface UslPlan {
  usl: string;
  namespace: string;
  description?: string;
  tables: UslTable[];
  fks: UslFk[];
}

export class PlanError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PlanError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new PlanError(code, message);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function assertIdent(name: string, label: string): void {
  if (!IDENT_RE.test(name)) {
    fail("bad_identifier", `${label} is not a lower-case snake identifier: ${name}`);
  }
  if ((RESERVED as readonly string[]).includes(name)) {
    fail("reserved_word", `${label} is a reserved word: ${name}`);
  }
}

function parseType(type: unknown, columnLabel: string): ColumnType {
  if (typeof type !== "string") {
    fail("bad_type", `${columnLabel} has a non-string type`);
  }
  if (type === "int" || type === "double") {
    return type;
  }
  const m = VARCHAR_RE.exec(type);
  if (!m) {
    fail("bad_type", `${columnLabel} has unsupported type: ${type}`);
  }
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 1 || n > 4000) {
    fail("bad_type", `${columnLabel} has unsupported type: ${type}`);
  }
  return type as ColumnType;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const v of Object.values(value as object)) {
      deepFreeze(v);
    }
  }
  return value;
}

export function validatePlan(input: unknown): UslPlan {
  if (!isPlainObject(input)) {
    fail("bad_shape", "plan is not an object");
  }
  const { usl, namespace, tables, fks } = input;
  if (typeof usl !== "string" || typeof namespace !== "string") {
    fail("bad_shape", "plan needs string usl and namespace");
  }
  if (!Array.isArray(tables) || tables.length === 0 || !Array.isArray(fks)) {
    fail("bad_shape", "plan needs a non-empty tables array and an fks array");
  }

  if (namespace !== NAMESPACE) {
    fail("bad_namespace", `namespace must be ${NAMESPACE}: ${namespace}`);
  }
  if (!IDENT_RE.test(usl)) {
    fail("bad_namespace", `usl is not a lower-case snake identifier: ${usl}`);
  }
  if ((RESERVED as readonly string[]).includes(usl)) {
    fail("reserved_word", `usl is a reserved word: ${usl}`);
  }

  const tableByName = new Map<string, UslTable>();
  const outTables: UslTable[] = [];

  for (const raw of tables) {
    if (!isPlainObject(raw)) {
      fail("bad_shape", "table entry is not an object");
    }
    if (typeof raw.name !== "string" || typeof raw.source !== "string") {
      fail("bad_shape", "table needs name and source");
    }
    if (!Array.isArray(raw.columns) || !Array.isArray(raw.pk)) {
      fail("bad_shape", `table ${raw.name} needs columns and pk`);
    }
    assertIdent(raw.name, `table ${raw.name}`);
    if (tableByName.has(raw.name)) {
      fail("duplicate_table", `duplicate table: ${raw.name}`);
    }

    if (raw.pk.length === 0) {
      fail("bad_key_ref", `table ${raw.name} has an empty pk`);
    }

    const colNames = new Set<string>();
    const columns: UslColumn[] = [];
    for (const col of raw.columns) {
      if (!isPlainObject(col) || typeof col.name !== "string" || typeof col.type !== "string") {
        fail("bad_shape", `table ${raw.name} has a column without name and type`);
      }
      assertIdent(col.name, `column ${raw.name}.${col.name}`);
      if (colNames.has(col.name)) {
        fail("duplicate_column", `duplicate column: ${raw.name}.${col.name}`);
      }
      colNames.add(col.name);
      const type = parseType(col.type, `column ${raw.name}.${col.name}`);
      const inPk = (raw.pk as unknown[]).includes(col.name);
      let nullable = true;
      if (inPk || col.nullable === false) {
        nullable = false;
      } else if (col.nullable === true) {
        nullable = true;
      }
      const column: UslColumn = { name: col.name, type, nullable };
      if (typeof col.description === "string") {
        column.description = col.description;
      }
      columns.push(column);
    }

    const pk: string[] = [];
    for (const p of raw.pk) {
      if (typeof p !== "string") {
        fail("bad_key_ref", `table ${raw.name} has a non-string pk entry`);
      }
      if (!colNames.has(p)) {
        fail("unknown_column", `pk ${raw.name}.${p} names a missing column`);
      }
      pk.push(p);
    }

    const table: UslTable = {
      name: raw.name,
      source: raw.source,
      columns,
      pk,
    };
    if (typeof raw.description === "string") {
      table.description = raw.description;
    }
    tableByName.set(table.name, table);
    outTables.push(table);
  }

  const outFks: UslFk[] = [];
  for (const raw of fks) {
    if (!isPlainObject(raw)) {
      fail("bad_shape", "fk entry is not an object");
    }
    if (typeof raw.from !== "string" || typeof raw.to !== "string" || typeof raw.transform !== "string") {
      fail("bad_shape", "fk needs from, to and transform");
    }
    const fromMatch = KEY_REF_RE.exec(raw.from);
    const toMatch = KEY_REF_RE.exec(raw.to);
    if (!fromMatch || !toMatch) {
      fail("bad_key_ref", `fk from/to must be table.column: ${raw.from} -> ${raw.to}`);
    }
    const [, fromTable, fromCol] = fromMatch;
    const [, toTable, toCol] = toMatch;
    if (!tableByName.has(fromTable!) || !tableByName.has(toTable!)) {
      fail(
        "unknown_table",
        `fk names an unknown table: ${raw.from} -> ${raw.to}`,
      );
    }
    const left = tableByName.get(fromTable!)!;
    const right = tableByName.get(toTable!)!;
    if (!left.columns.some((c) => c.name === fromCol) || !right.columns.some((c) => c.name === toCol)) {
      fail(
        "unknown_column",
        `fk names an unknown column: ${raw.from} -> ${raw.to}`,
      );
    }
    if (!isTransformSpec(raw.transform)) {
      fail("unknown_transform", `fk transform outside the closed set: ${raw.transform}`);
    }
    if (raw.verdict === "REJECTED") {
      fail("bad_verdict", `fk ${raw.from} -> ${raw.to} carries REJECTED`);
    }
    if (raw.verdict !== undefined && raw.verdict !== "VERIFIED" && raw.verdict !== "PARTIAL") {
      fail("bad_verdict", `fk ${raw.from} -> ${raw.to} has unknown verdict: ${String(raw.verdict)}`);
    }

    const fk: UslFk = {
      from: raw.from,
      to: raw.to,
      transform: raw.transform,
    };
    if (typeof raw.match_rate === "number") {
      fk.match_rate = raw.match_rate;
    }
    if (raw.verdict === "VERIFIED" || raw.verdict === "PARTIAL") {
      fk.verdict = raw.verdict;
    }
    outFks.push(fk);
  }

  const plan: UslPlan = { usl, namespace, tables: outTables, fks: outFks };
  if (typeof input.description === "string") {
    plan.description = input.description;
  }
  return deepFreeze(plan);
}

function fksForTable(plan: UslPlan, tableName: string): Map<string, UslFk> {
  const map = new Map<string, UslFk>();
  for (const fk of plan.fks) {
    const m = KEY_REF_RE.exec(fk.from);
    if (m && m[1] === tableName) {
      map.set(m[2]!, fk);
    }
  }
  return map;
}

function renderColumn(
  col: UslColumn,
  pk: string[],
  fkByCol: Map<string, UslFk>,
): string {
  const parts: string[] = [col.name, col.type];
  const singlePk = pk.length === 1 && pk[0] === col.name;
  const inCompositePk = pk.length > 1 && pk.includes(col.name);
  if (!col.nullable || singlePk || inCompositePk) {
    parts.push("NOT NULL");
  }
  if (singlePk) {
    parts.push("PRIMARY KEY");
  }
  const fk = fkByCol.get(col.name);
  if (fk) {
    const to = KEY_REF_RE.exec(fk.to)!;
    parts.push(`FOREIGN KEY REFERENCES ${to[1]}(${to[2]})`);
  }
  return parts.join(" ");
}

export function renderCompileUsl(plan: UslPlan): string {
  const blocks: string[] = [];
  for (const table of plan.tables) {
    const fkByCol = fksForTable(plan, table.name);
    const lines = table.columns.map((c) => `    ${renderColumn(c, table.pk, fkByCol)}`);
    if (table.pk.length > 1) {
      lines.push(`    PRIMARY KEY (${table.pk.join(", ")})`);
    }
    blocks.push(`CREATE TABLE ${table.name} (\n${lines.join(",\n")}\n)`);
  }
  return (
    `COMPILE USL IF NOT EXISTS ${plan.usl} DEPLOY NAMESPACE ${plan.namespace} DDL\n` +
    blocks.join(";\n")
  );
}

export function cleanDescription(text: string): string {
  return text
    .replace(/'/g, "")
    .replace(/;/g, ",")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The grammar Zetaris 2.4.3.1 accepted live (sister entry's 05_won_usl_create.sql): the
 * object is addressed by its dotted path namespace.usl[.table[.column]], then SET
 * [TABLE | COLUMN] DESCRIPTION and the unquoted text. "<usl> NAMESPACE <ns>" is LOAD USL's
 * grammar, not UPDATE USL's.
 */
export function renderDescriptions(plan: UslPlan): string[] {
  const out: string[] = [];
  const model = `${plan.namespace}.${plan.usl}`;
  if (plan.description !== undefined) {
    out.push(`UPDATE USL ${model} SET DESCRIPTION ${cleanDescription(plan.description)}`);
  }
  for (const table of plan.tables) {
    if (table.description !== undefined) {
      out.push(
        `UPDATE USL ${model}.${table.name} SET TABLE DESCRIPTION ${cleanDescription(table.description)}`,
      );
    }
    for (const col of table.columns) {
      if (col.description !== undefined) {
        out.push(
          `UPDATE USL ${model}.${table.name}.${col.name} SET COLUMN DESCRIPTION ${cleanDescription(col.description)}`,
        );
      }
    }
  }
  return out;
}

export function fkLines(plan: UslPlan): string[] {
  return plan.fks.map((fk) => `${fk.from} -> ${fk.to} (${fk.transform})`);
}
