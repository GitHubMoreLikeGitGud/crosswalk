/** Closed set of join-key transforms and their Lightning SQL expressions. */

export const TRANSFORM_NAMES = [
  "identity",
  "upper",
  "lpad10",
  "substr",
  "strip_prefix",
  "yyyymmdd_to_date",
  "iso_to_quarter",
] as const;

export type TransformName = (typeof TRANSFORM_NAMES)[number];

export interface Transform {
  spec: string;
  name: TransformName;
  args: number[] | string[];
  apply(v: unknown): string | null;
  sql(x: string): string;
}

function nullIn(v: unknown): v is null | undefined {
  return v === null || v === undefined;
}

/** Pass-through: fixture expects numeric identity unchanged; SQL still CAST AS STRING. */
export function identity(): Transform {
  return {
    spec: "identity",
    name: "identity",
    args: [],
    apply(v: unknown): string | null {
      if (nullIn(v)) return null;
      return v as string;
    },
    sql(x: string): string {
      return `CAST(${x} AS STRING)`;
    },
  };
}

export function upper(): Transform {
  return {
    spec: "upper",
    name: "upper",
    args: [],
    apply(v: unknown): string | null {
      if (nullIn(v)) return null;
      return String(v).toUpperCase();
    },
    sql(x: string): string {
      return `UPPER(CAST(${x} AS STRING))`;
    },
  };
}

export function lpad10(): Transform {
  return {
    spec: "lpad10",
    name: "lpad10",
    args: [],
    apply(v: unknown): string | null {
      if (nullIn(v)) return null;
      return String(v).padStart(10, "0");
    },
    sql(x: string): string {
      return `LPAD(CAST(${x} AS STRING), 10, '0')`;
    },
  };
}

export function substr(start: number, len: number): Transform {
  if (!Number.isInteger(start) || !Number.isInteger(len) || start < 1 || len < 1) {
    throw new Error("substr start and len must be integers 1 or more");
  }
  return {
    spec: `substr(${start},${len})`,
    name: "substr",
    args: [start, len],
    apply(v: unknown): string | null {
      if (nullIn(v)) return null;
      const s = String(v);
      return s.substring(start - 1, start - 1 + len);
    },
    sql(x: string): string {
      return `SUBSTR(CAST(${x} AS STRING), ${start}, ${len})`;
    },
  };
}

export function stripPrefixUS(): Transform {
  const prefix = "US-";
  return {
    spec: "strip_prefix('US-')",
    name: "strip_prefix",
    args: [prefix],
    apply(v: unknown): string | null {
      if (nullIn(v)) return null;
      const s = String(v);
      return s.startsWith(prefix) ? s.slice(prefix.length) : null;
    },
    sql(x: string): string {
      return `CASE WHEN CAST(${x} AS STRING) LIKE 'US-%' THEN SUBSTR(CAST(${x} AS STRING), 4) END`;
    },
  };
}

export function yyyymmddToDate(): Transform {
  return {
    spec: "yyyymmdd_to_date",
    name: "yyyymmdd_to_date",
    args: [],
    apply(v: unknown): string | null {
      if (nullIn(v)) return null;
      const s = String(v);
      return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    },
    sql(x: string): string {
      return `CONCAT(SUBSTR(${x}, 1, 4), '-', SUBSTR(${x}, 5, 2), '-', SUBSTR(${x}, 7, 2))`;
    },
  };
}

export function isoToQuarter(): Transform {
  return {
    spec: "iso_to_quarter",
    name: "iso_to_quarter",
    args: [],
    apply(v: unknown): string | null {
      if (nullIn(v)) return null;
      const s = String(v);
      const year = s.slice(0, 4);
      const month = Number(s.slice(5, 7));
      const q = Math.floor((month + 2) / 3);
      return `CY${year}Q${q}`;
    },
    sql(x: string): string {
      return `CONCAT('CY', SUBSTR(${x}, 1, 4), 'Q', CAST(FLOOR((CAST(SUBSTR(${x}, 6, 2) AS INT) + 2) / 3) AS INT))`;
    },
  };
}

const SIMPLE: Record<string, () => Transform> = {
  identity,
  upper,
  lpad10,
  yyyymmdd_to_date: yyyymmddToDate,
  iso_to_quarter: isoToQuarter,
  "strip_prefix('US-')": stripPrefixUS,
};

const SUBSTR_RE = /^substr\((\d+),(\d+)\)$/;

export function parseTransform(spec: string): Transform {
  if (Object.prototype.hasOwnProperty.call(SIMPLE, spec)) {
    return SIMPLE[spec]();
  }
  const m = SUBSTR_RE.exec(spec);
  if (m) {
    const start = Number(m[1]);
    const len = Number(m[2]);
    if (start < 1 || len < 1) {
      throw new Error(`not a transform: ${spec}`);
    }
    return substr(start, len);
  }
  throw new Error(`not a transform: ${spec}`);
}

export function isTransformSpec(spec: string): boolean {
  try {
    parseTransform(spec);
    return true;
  } catch {
    return false;
  }
}
