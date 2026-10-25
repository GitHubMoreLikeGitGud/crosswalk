/** Rank discovery-catalogue entries by token overlap; flag known_to_fail as negative. */

export interface CatalogueEntry {
  id: string;
  kind: string;
  object: string | null;
  status: string;
  licence: string;
  note: string;
}

export interface CatalogueHit extends CatalogueEntry {
  score: number;
  negative: boolean;
}

export const STOPWORDS: readonly string[] = [
  "a",
  "an",
  "the",
  "of",
  "in",
  "on",
  "and",
  "or",
  "for",
  "to",
  "by",
  "with",
  "what",
  "which",
  "did",
  "do",
  "does",
  "their",
  "that",
  "this",
  "is",
  "are",
  "was",
  "were",
  "how",
  "at",
  "from",
  "as",
  "it",
  "its",
  "per",
];

const STOPWORD_SET = new Set(STOPWORDS);

const STATUS_RANK: Record<string, number> = {
  verified: 0,
  listed: 1,
  unverified: 2,
  deprecated: 3,
  known_to_fail: 4,
};

function requireObject(input: unknown, label: string): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }
  return input as Record<string, unknown>;
}

function requireStringId(id: unknown, label: string): string {
  if (typeof id !== "string") {
    throw new Error(`${label} entry missing string id`);
  }
  return id;
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Extract the Lightning object name from a catalogue `zetaris_object` line. */
export function objectOf(zetarisObject: unknown): string | null {
  if (typeof zetarisObject !== "string" || !zetarisObject.trim()) {
    return null;
  }
  let s = zetarisObject;
  const arrow = s.indexOf("->");
  if (arrow >= 0) {
    s = s.slice(arrow + 2);
  }
  s = s.trim();
  if (!s) return null;
  return s.split(/\s+/, 1)[0]!;
}

export function tokenize(text: string): string[] {
  const spaced = (text || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const out: string[] = [];
  for (const raw of spaced.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOPWORD_SET.has(raw)) continue;
    let tok = raw;
    if (tok.endsWith("ies") && tok.length > 4) {
      tok = tok.slice(0, -3) + "y";
    } else if (tok.endsWith("s") && !tok.endsWith("ss") && tok.length > 3) {
      tok = tok.slice(0, -1);
    }
    if (!out.includes(tok)) out.push(tok);
  }
  return out;
}

function entryTokens(entry: CatalogueEntry): Set<string> {
  return new Set(
    tokenize(
      [entry.id, entry.kind, entry.object ?? "", entry.note].join(" "),
    ),
  );
}

export function entriesFromCatalogue(catalogue: unknown): CatalogueEntry[] {
  const obj = requireObject(catalogue, "catalogue");
  if (!Array.isArray(obj.entries)) {
    throw new Error("catalogue.entries must be an array");
  }
  return obj.entries.map((raw, i) => {
    const e = requireObject(raw, `catalogue.entries[${i}]`);
    return {
      id: requireStringId(e.id, "catalogue"),
      kind: optionalString(e.kind),
      object: objectOf(e.zetaris_object),
      status: optionalString(e.status),
      licence: optionalString(e.licence),
      note: optionalString(e.note),
    };
  });
}

const MANIFEST_OBJECT_KEYS = ["views", "view", "frames", "submission", "usl"] as const;

function collectObjectNames(objects: unknown): string[] {
  if (objects === null || typeof objects !== "object" || Array.isArray(objects)) {
    return [];
  }
  const objs = objects as Record<string, unknown>;
  const names: string[] = [];
  for (const key of MANIFEST_OBJECT_KEYS) {
    const v = objs[key];
    if (typeof v === "string") {
      names.push(v);
    } else if (Array.isArray(v)) {
      for (const x of v) {
        if (typeof x === "string") names.push(x);
      }
    }
  }
  return names;
}

export function entriesFromManifest(manifest: unknown): CatalogueEntry[] {
  const obj = requireObject(manifest, "manifest");
  if (!Array.isArray(obj.sources)) {
    throw new Error("manifest.sources must be an array");
  }
  const out: CatalogueEntry[] = [];
  for (let i = 0; i < obj.sources.length; i++) {
    const s = requireObject(obj.sources[i], `manifest.sources[${i}]`);
    const id = requireStringId(s.id, "manifest");
    const names = collectObjectNames(s.objects);
    const base = {
      kind: "registered_view",
      status: optionalString(s.status),
      licence: "",
      note: optionalString(s.summary),
    };
    if (names.length > 0) {
      for (const name of names) {
        out.push({ id: `${id}:${name}`, object: name, ...base });
      }
    } else {
      out.push({ id, object: null, ...base });
    }
  }
  return out;
}

export function entriesFromGettingStarted(manifest: unknown): CatalogueEntry[] {
  const obj = requireObject(manifest, "getting-started manifest");
  if (!Array.isArray(obj.sources)) {
    throw new Error("getting-started manifest.sources must be an array");
  }
  return obj.sources.map((raw, i) => {
    const s = requireObject(raw, `getting-started sources[${i}]`);
    return {
      id: `gs:${requireStringId(s.id, "getting-started")}`,
      kind: optionalString(s.kind),
      object: null,
      status: optionalString(s.status),
      licence: "",
      note: optionalString(s.summary),
    };
  });
}

export function entriesFromFemaCatalogue(
  rows: Record<string, unknown>[],
): CatalogueEntry[] {
  if (!Array.isArray(rows)) {
    throw new Error("fema catalogue rows must be an array");
  }
  return rows.map((r) => {
    const title = r.title == null ? "" : String(r.title);
    const endpoint = r.api_endpoint == null ? "" : String(r.api_endpoint);
    const note = (endpoint ? `${title} ${endpoint}` : title).trim();
    return {
      id: `openfema:${r.name}@v${r.version}`,
      kind: "openfema_dataset",
      object: null,
      status: "listed",
      licence: "",
      note,
    };
  });
}

export function searchCatalogue(
  query: string,
  entries: readonly CatalogueEntry[],
  limit = 8,
): { hits: CatalogueHit[] } {
  const q = tokenize(query);
  const hits: CatalogueHit[] = [];
  for (const e of entries) {
    const tokens = entryTokens(e);
    const score = q.reduce((n, t) => n + (tokens.has(t) ? 1 : 0), 0);
    if (score === 0) continue;
    hits.push({
      ...e,
      note: e.note.slice(0, 200),
      score,
      negative: e.status === "known_to_fail",
    });
  }
  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ra = STATUS_RANK[a.status] ?? 5;
    const rb = STATUS_RANK[b.status] ?? 5;
    if (ra !== rb) return ra - rb;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
  return { hits: hits.slice(0, limit) };
}
