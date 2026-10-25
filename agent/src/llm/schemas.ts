// JSON schemas for every structured Nemotron job, their TypeScript shapes, and a small
// validator for the schema subset we use. Ollama's `format` constrains decoding with the
// same schema, but the host still validates: constrained decoding can stop early
// (num_predict) and an older Ollama build may ignore keywords it does not support.
// Adapted from Weather-or-Not and ClearShelf (same author, Apache-2.0); the jobs are Crosswalk's.

export type JsonSchema = { [key: string]: unknown };

// ---------- the discovery loop ----------

/** The host-run tools of one question (SPEC section 3, decision D8). The planner picks from a dynamic subset. */
export const TOOL_NAMES = [
  "search_catalogue",
  "probe_source",
  "propose_keys",
  "measure_key",
  "register_source",
  "compile_usl",
  "answer",
  "not_tested",
  "finalize",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** The checklist items of one question, in fallback order (SPEC section 3). */
export const CHECKLIST_ITEMS = [
  "sources_found",
  "shapes_probed",
  "keys_proposed",
  "keys_measured",
  "sources_registered",
  "usl_built",
  "dq_run",
  "answered",
  "not_tested_listed",
  "note_written",
] as const;
export type ChecklistItemId = (typeof CHECKLIST_ITEMS)[number];

/** The closed transform set (agent/src/tools/transforms.ts), canonical spellings only. */
export const TRANSFORM_PATTERN = "^(identity|upper|lpad10|substr\\([1-9][0-9]*,[1-9][0-9]*\\)|strip_prefix\\('US-'\\)|yyyymmdd_to_date|iso_to_quarter)$";
const OBJECT_PATTERN = "^cw\\.[A-Za-z0-9_]+$";
const COLUMN_PATTERN = "^[A-Za-z_][A-Za-z0-9_]*$";
export const MAX_KEY_CHOICES = 6;

/** One join-key choice: left column, right column, one transform from the closed set. */
export interface KeyChoiceInput {
  left: { object: string; column: string };
  right: { object: string; column: string };
  transform: string;
}

const sideSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["object", "column"],
  properties: { object: { type: "string", pattern: OBJECT_PATTERN }, column: { type: "string", pattern: COLUMN_PATTERN } },
};

/** propose_keys: at most six {left, right, transform} choices. */
export const keyChoicesSchema: JsonSchema = {
  type: "array",
  minItems: 1,
  maxItems: MAX_KEY_CHOICES,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["left", "right", "transform"],
    properties: { left: sideSchema, right: sideSchema, transform: { type: "string", pattern: TRANSFORM_PATTERN } },
  },
};

/** answer: the calendar quarter the question asks about (frames spelling; FEMA reads any quarter). */
export const answerParamsSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["quarter"],
  properties: { quarter: { type: "string", pattern: "^CY[0-9]{4}Q[1-4]$" } },
};

// ---------- Job 1: planner (one Markovian step) ----------

export interface PlannerAction {
  tool: ToolName;
  input: {
    query?: string;
    object?: string;
    choices?: KeyChoiceInput[];
    key?: string;
    catalogue_id?: string;
    quarter?: string;
    tag?: string;
    period?: string;
  };
}
export interface PlannerState {
  focus: string;
  hypotheses: string[];
  evidence_ids: string[];
  open_contradictions: string[];
  checklist: Record<string, boolean>;
  next: string;
}
export interface PlannerOutput {
  thought: string;
  action: PlannerAction | null;
  state: PlannerState;
  done: boolean;
}

export const THOUGHT_MAX_WORDS = 60;

const plannerInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: { type: "string", minLength: 1, maxLength: 120 },
    object: { type: "string", pattern: OBJECT_PATTERN },
    choices: keyChoicesSchema,
    key: { type: "string", pattern: "^[kbc][0-9]{1,2}$" },
    catalogue_id: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
    quarter: { type: "string", pattern: "^CY[0-9]{4}Q[1-4]$" },
    tag: { enum: ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RegulatedAndUnregulatedOperatingRevenue"] },
    period: { type: "string", pattern: "^CY[0-9]{4}Q[1-3]$" },
  },
};

/**
 * Builds the planner schema for one chunk. `tools` is the dynamic enum: only the tools
 * the host will accept at this point of the chain. `evidenceIds` is the same idea for
 * citations: the model can only cite ids the host has recorded.
 */
export function plannerSchema(tools: readonly string[], evidenceIds: readonly string[] = []): JsonSchema {
  if (tools.length === 0) throw new Error("plannerSchema: at least one tool is required");
  for (const t of tools) {
    if (!(TOOL_NAMES as readonly string[]).includes(t)) throw new Error(`plannerSchema: unknown tool ${t}`);
  }
  const checklistProps: Record<string, JsonSchema> = {};
  for (const item of CHECKLIST_ITEMS) checklistProps[item] = { type: "boolean" };
  return {
    type: "object",
    additionalProperties: false,
    required: ["thought", "action", "state", "done"],
    properties: {
      thought: { type: "string", minLength: 1, maxLength: 420 },
      action: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["tool", "input"],
            properties: { tool: { enum: [...tools] }, input: plannerInputSchema },
          },
          { type: "null" },
        ],
      },
      state: {
        type: "object",
        additionalProperties: false,
        required: ["focus", "hypotheses", "evidence_ids", "open_contradictions", "checklist", "next"],
        properties: {
          focus: { type: "string", minLength: 1, maxLength: 80 },
          hypotheses: { type: "array", maxItems: 5, items: { type: "string", maxLength: 200 } },
          evidence_ids:
            evidenceIds.length > 0
              ? { type: "array", maxItems: evidenceIds.length, items: { enum: [...evidenceIds] } }
              : { type: "array", maxItems: 0, items: { type: "string" } },
          open_contradictions: { type: "array", maxItems: 6, items: { type: "string", maxLength: 240 } },
          checklist: {
            type: "object",
            additionalProperties: false,
            required: [...CHECKLIST_ITEMS],
            properties: checklistProps,
          },
          next: { type: "string", maxLength: 240 },
        },
      },
      done: { type: "boolean" },
    },
  };
}

// ---------- Job 2: memo ----------

export interface MemoOutput {
  memo: string;
}

/** 150 to 250 words of prose; the bounds leave room for the model to miss the target by a little (the host counts the words). */
export const memoSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["memo"],
  properties: {
    memo: { type: "string", minLength: 200, maxLength: 2600 },
  },
};

// ---------- Job 3: H-MEM minerFn ----------

// The vendored H-MEM reference parses the miner's reply with parseStrictJsonArray,
// so the miner returns a bare JSON array of short memory statements.
export const minerSchema: JsonSchema = {
  type: "array",
  maxItems: 12,
  items: { type: "string", minLength: 1, maxLength: 300 },
};

// ---------- Validator (the subset of JSON Schema used above) ----------

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function matchesType(v: unknown, t: string): boolean {
  const actual = typeOf(v);
  if (t === "number") return actual === "number" || actual === "integer";
  return actual === t;
}

/** Returns a list of error strings; an empty list means the value is valid. */
export function validate(schema: JsonSchema, value: unknown, path = "$"): string[] {
  const errors: string[] = [];

  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf as JsonSchema[];
    const ok = branches.some((b) => validate(b, value, path).length === 0);
    if (!ok) errors.push(`${path}: matches no allowed shape`);
    return errors;
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${path}: expected ${types.join("|")}, got ${typeOf(value)}`);
      return errors;
    }
  }

  if (Array.isArray(schema.enum)) {
    if (!(schema.enum as unknown[]).some((e) => e === value)) {
      errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
      return errors;
    }
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${path}: shorter than ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${path}: longer than ${schema.maxLength}`);
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern as string, "u").test(value)) {
      errors.push(`${path}: does not match ${schema.pattern}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${path}: fewer than ${schema.minItems} items`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`${path}: more than ${schema.maxItems} items`);
    }
    if (schema.items && typeof schema.items === "object") {
      value.forEach((item, i) => errors.push(...validate(schema.items as JsonSchema, item, `${path}[${i}]`)));
    }
  }

  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const key of (schema.required ?? []) as string[]) {
      if (!(key in obj)) errors.push(`${path}.${key}: required`);
    }
    for (const [key, v] of Object.entries(obj)) {
      if (key in props) {
        errors.push(...validate(props[key], v, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key}: not allowed`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        errors.push(...validate(schema.additionalProperties as JsonSchema, v, `${path}.${key}`));
      }
    }
  }

  return errors;
}

export function wordCount(text: string): number {
  const t = text.trim();
  return t === "" ? 0 : t.split(/\s+/u).length;
}

/** Semantic checks the schema cannot express. */
export function plannerSemanticErrors(out: PlannerOutput): string[] {
  const errors: string[] = [];
  if (wordCount(out.thought) > THOUGHT_MAX_WORDS) errors.push(`thought: more than ${THOUGHT_MAX_WORDS} words`);
  if (out.done && out.action !== null) errors.push("done is true but an action is set");
  return errors;
}
