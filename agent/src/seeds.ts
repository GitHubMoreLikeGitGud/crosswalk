// The curated seed lists (seeds/utilities.json, seeds/stations.json): CIKs, names, tickers,
// SIC codes, states served (from public 10-K service-territory descriptions, labelled
// curated) and GHCN station ids. No SEC fact values. Read once per process.

import { readFileSync } from "node:fs";
import { REPO_ROOT_URL } from "./config.ts";

export interface SeedUtility {
  cik: string;
  name: string;
  ticker: string | null;
  sic: string;
  sic_description: string | null;
  hq_state: string | null;
  states_served: string[];
  states_source: string;
  states_note: string | null;
  flags: string[];
  curated: boolean;
  station_ids: string[];
}

export interface SeedStation {
  id: string;
  state: string;
  name: string;
}

export interface Seeds {
  generatedAt: string;
  peerSic: string[];
  utilities: SeedUtility[];
  stations: SeedStation[];
  stationById: Map<string, SeedStation>;
}

let cached: Seeds | null = null;

interface RawUtility extends Omit<SeedUtility, "ticker" | "flags" | "states_note" | "sic_description" | "hq_state"> {
  ticker?: string | null;
  flags?: string[];
  states_note?: string | null;
  sic_description?: string | null;
  hq_state?: string | null;
}

export function loadSeeds(root: URL = REPO_ROOT_URL): Seeds {
  if (cached) return cached;
  const u = JSON.parse(readFileSync(new URL("seeds/utilities.json", root), "utf8")) as { generated_at?: string; peer_sic?: string[]; utilities: RawUtility[] };
  const s = JSON.parse(readFileSync(new URL("seeds/stations.json", root), "utf8")) as { stations: SeedStation[] };
  const utilities: SeedUtility[] = u.utilities.map((x) => ({
    ...x,
    ticker: x.ticker && x.ticker !== "-" ? x.ticker : null,
    flags: x.flags ?? [],
    states_note: x.states_note ?? null,
    sic_description: x.sic_description ?? null,
    hq_state: x.hq_state ?? null,
  }));
  for (const x of utilities) {
    if (!/^\d{10}$/u.test(x.cik)) throw new Error(`seeds/utilities.json: cik must be 10 digits: ${x.cik}`);
  }
  cached = {
    generatedAt: u.generated_at ?? "1970-01-01T00:00:00Z",
    peerSic: u.peer_sic ?? ["4911", "4931", "4932"],
    utilities,
    stations: s.stations,
    stationById: new Map(s.stations.map((st) => [st.id, st])),
  };
  return cached;
}

/** Test helper. */
export function resetSeedsCache(): void {
  cached = null;
}

/** A seed utility by 10-digit CIK, ticker (case-insensitive) or a unique name substring. */
export function findUtility(seeds: Seeds, query: string): SeedUtility | null {
  const q = query.trim();
  if (/^\d{1,10}$/u.test(q)) {
    const cik = q.padStart(10, "0");
    return seeds.utilities.find((u) => u.cik === cik) ?? null;
  }
  const byTicker = seeds.utilities.find((u) => u.ticker && u.ticker.toLowerCase() === q.toLowerCase());
  if (byTicker) return byTicker;
  const hits = seeds.utilities.filter((u) => u.name.toLowerCase().includes(q.toLowerCase()));
  return hits.length === 1 ? hits[0]! : null;
}

export function stationsOf(seeds: Seeds, ids: readonly string[]): { id: string; state: string; name: string | null }[] {
  return ids.map((id) => {
    const s = seeds.stationById.get(id);
    return { id, state: s?.state ?? "??", name: s?.name ?? null };
  });
}
