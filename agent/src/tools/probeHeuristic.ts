/** Pick candidate join-key columns from DESCRIBE names and types alone. */

export const KEY_PATTERNS = [
  "cik",
  "state",
  "id",
  "code",
  "fips",
  "disasternumber",
  "sic",
  "loc",
  "period",
] as const;

const NON_KEY_TYPES = new Set(["double", "float", "decimal"]);

export interface DescribedColumn {
  name: string;
  type: string;
}

export function normaliseColumnName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function candidateKeyColumns(
  columns: readonly DescribedColumn[],
  limit = 3,
): string[] {
  const ranked: { tier: number; patternIndex: number; position: number; name: string }[] =
    [];
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i]!;
    const baseType = col.type.toLowerCase().split("(", 1)[0]!;
    if (NON_KEY_TYPES.has(baseType)) continue;
    const n = normaliseColumnName(col.name);
    let found: { tier: number; patternIndex: number } | null = null;
    for (let p = 0; p < KEY_PATTERNS.length; p++) {
      if (n === KEY_PATTERNS[p]) {
        found = { tier: 0, patternIndex: p };
        break;
      }
    }
    if (found === null) {
      for (let p = 0; p < KEY_PATTERNS.length; p++) {
        const pat = KEY_PATTERNS[p]!;
        if (n.startsWith(pat) || n.endsWith(pat)) {
          found = { tier: 1, patternIndex: p };
          break;
        }
      }
    }
    if (found !== null) {
      ranked.push({
        tier: found.tier,
        patternIndex: found.patternIndex,
        position: i,
        name: col.name,
      });
    }
  }
  ranked.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.patternIndex !== b.patternIndex) return a.patternIndex - b.patternIndex;
    return a.position - b.position;
  });
  return ranked.slice(0, limit).map((r) => r.name);
}
