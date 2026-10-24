// A synthetic question for the tool-chain tests: a target utility, peers with a known
// growth-to-weather relation, frames facts under three tags, a companyconcept window with a
// recast comparative and an own-period restatement, and degree-day rows per station and
// quarter. Every value is made up (fake CIKs 0000000001..); nothing comes from the SEC or NOAA.
import type { Seeds, SeedStation, SeedUtility } from "../../src/seeds.ts";
import { REVENUE_TAGS, type RevenueTag } from "../../src/tools/frames.ts";
import { missing, type Reply, type Resolver } from "./fakeGateway.ts";

export const TARGET = "0000000001";
export const PERIOD = "CY2025Q1";
export const PREV = "CY2024Q1";

interface Peer {
  cik: string;
  name: string;
  sic: string;
  tag: RevenueTag | null;
  /** Degree-day change of the peer's one station. */
  dw: number;
  /** Revenue growth; null: no current fact. */
  g: number | null;
  /** The previous quarter's fact is missing (excluded). */
  noPrevious?: boolean;
}

const PEERS: Peer[] = [
  { cik: "0000000002", name: "Peer Two Power", sic: "4911", tag: "Revenues", dw: 0.1, g: 0.07 },
  { cik: "0000000003", name: "Peer Three Energy", sic: "4931", tag: "Revenues", dw: 0.2, g: 0.12 },
  { cik: "0000000004", name: "Peer Four Electric", sic: "4911", tag: "RevenueFromContractWithCustomerExcludingAssessedTax", dw: 0.05, g: 0.045 },
  { cik: "0000000005", name: "Peer Five Utilities", sic: "4932", tag: "Revenues", dw: 0.15, g: 0.095 },
  { cik: "0000000006", name: "Peer Six Light", sic: "4911", tag: "RegulatedAndUnregulatedOperatingRevenue", dw: 0.0, g: 0.02 },
  { cik: "0000000007", name: "Peer Seven Grid", sic: "4931", tag: "Revenues", dw: 0.25, g: 0.145 },
  { cik: "0000000008", name: "Peer Eight Holdings", sic: "4911", tag: "Revenues", dw: 0.12, g: 0.08 },
  { cik: "0000000009", name: "Gas Nine", sic: "4900", tag: "Revenues", dw: 0.1, g: 0.06 },
  { cik: "0000000010", name: "Peer Ten No Current", sic: "4911", tag: "Revenues", dw: 0.1, g: null },
  { cik: "0000000011", name: "Peer Eleven No Previous", sic: "4911", tag: "Revenues", dw: 0.1, g: 0.05, noPrevious: true },
  { cik: "0000000012", name: "Peer Twelve Outlier", sic: "4911", tag: "Revenues", dw: 0.1, g: 0.9 },
];

const station = (n: number) => `USW${String(n).padStart(8, "0")}`;

export function syntheticSeeds(): Seeds {
  const utilities: SeedUtility[] = [
    {
      cik: TARGET,
      name: "Target Electric Corp",
      ticker: "TGT",
      sic: "4911",
      sic_description: "Electric Services",
      hq_state: "AA",
      states_served: ["AA", "BB"],
      states_source: "synthetic",
      states_note: null,
      flags: [],
      curated: true,
      station_ids: [station(1), station(2)],
    },
    ...PEERS.map((p, i) => ({
      cik: p.cik,
      name: p.name,
      ticker: null,
      sic: p.sic,
      sic_description: null,
      hq_state: `S${i}`,
      states_served: [`S${i}`],
      states_source: "synthetic",
      states_note: null,
      flags: [],
      curated: true,
      station_ids: [station(10 + i)],
    })),
  ];
  const stations: SeedStation[] = [
    { id: station(1), state: "AA", name: "Station One" },
    { id: station(2), state: "BB", name: "Station Two" },
    ...PEERS.map((_, i) => ({ id: station(10 + i), state: `S${i}`, name: `Station ${10 + i}` })),
  ];
  return { generatedAt: "2026-10-24T00:00:00Z", peerSic: ["4911", "4931", "4932"], utilities, stations, stationById: new Map(stations.map((s) => [s.id, s])) };
}

/** Degree days such that the station's TDD change is `dw`: previous 2000, current 2000 * (1 + dw). */
function weatherRow(id: string, year: number, dw: number): unknown[] {
  const tdd = year === 2025 ? 2000 * (1 + dw) : 2000;
  return [id, year, 1, tdd - 10, 10, year === 2025 ? 90 : 91, year === 2025 ? 90 : 91, 1];
}

export const TARGET_DW = 0.18;
/** The target's two stations: changes 0.16 and 0.20 average to TARGET_DW. */
const TARGET_STATION_DW: Record<string, number> = { [station(1)]: 0.16, [station(2)]: 0.2 };

export const TARGET_FACTS = {
  prevOriginal: { accn: "0000000001-24-000001", filed: "2024-05-01", val: 1_000_000_000 },
  prevComparative: { accn: "0000000001-25-000001", filed: "2025-05-01", val: 980_000_000 },
  current: { accn: "0000000001-25-000001", filed: "2025-05-01", val: 1_150_000_000 },
  currentLater: { accn: "0000000001-26-000001", filed: "2026-05-01", val: 1_149_000_000 },
};

const CONCEPT_COLS = ["fy", "fp", "form", "filed", "accn", "start", "end", "val"];
const FRAMES_COLS = ["cik", "entityName", "loc", "start", "end", "val", "accn"];
const WEATHER_COLS = ["station_id", "year", "quarter", "hdd", "cdd", "days_observed", "days_in_quarter", "coverage"];

function framesRows(tag: RevenueTag, period: string, seeds: Seeds): unknown[][] {
  const rows: unknown[][] = [];
  const isCurrent = period === PERIOD;
  const [start, end] = isCurrent ? ["2025-01-01", "2025-03-31"] : ["2024-01-01", "2024-03-31"];
  if (tag === "Revenues") {
    // The frames serve the most recently filed fact.
    const t = isCurrent ? TARGET_FACTS.currentLater : TARGET_FACTS.prevComparative;
    rows.push([1, "Target Electric Corp", "US-AA", start, end, t.val, t.accn]);
  }
  for (const p of PEERS) {
    if (p.tag !== tag) continue;
    if (isCurrent && p.g === null) continue;
    if (!isCurrent && p.noPrevious) continue;
    const prev = 500_000_000;
    const val = isCurrent ? prev * (1 + (p.g ?? 0)) : prev;
    const u = seeds.utilities.find((x) => x.cik === p.cik)!;
    rows.push([Number(p.cik), u.name, `US-${u.hq_state}`, start, end, val, `${p.cik}-${isCurrent ? "26" : "25"}-000001`]);
  }
  return rows;
}

export function syntheticResolver(seeds: Seeds, opts: { missingFrames?: Set<string>; missingConcept?: boolean; missingSubmission?: boolean } = {}): Resolver {
  const framesMissing = opts.missingFrames ?? new Set<string>();
  return (templateId, params): Reply | undefined => {
    switch (templateId) {
      case "submission": {
        if (opts.missingSubmission) return missing(`won.submission_${params.cik10}`);
        const u = seeds.utilities.find((x) => x.cik === params.cik10);
        return u ? { columns: ["cik", "name", "sic", "sicDescription", "state"], rows: [[Number(u.cik), u.name, u.sic, "Electric Services", u.hq_state]] } : { columns: ["cik", "name", "sic", "sicDescription", "state"], rows: [] };
      }
      case "frames_fact": {
        if (framesMissing.has(`${params.tag}|${params.period}`)) return missing(`won.frames_${params.tag}_${params.period}`);
        const rows = framesRows(params.tag as RevenueTag, params.period!, seeds).filter((r) => String(r[0]).padStart(10, "0") === params.cik10);
        return { columns: FRAMES_COLS, rows };
      }
      case "frames_seeds": {
        if (framesMissing.has(`${params.tag}|${params.period}`)) return missing(`won.frames_${params.tag}_${params.period}`);
        return { columns: FRAMES_COLS, rows: framesRows(params.tag as RevenueTag, params.period!, seeds) };
      }
      case "concept_window": {
        if (params.cik10 !== TARGET) return missing(`won.concept_${params.cik10}_${params.tag}`);
        if (params.tag !== "Revenues") return missing(`won.concept_${params.cik10}_${params.tag}`);
        if (opts.missingConcept) return missing(`won.concept_${params.cik10}_${params.tag}`);
        const f = TARGET_FACTS;
        return {
          columns: CONCEPT_COLS,
          rows: [
            [2024, "Q1", "10-Q", f.prevOriginal.filed, f.prevOriginal.accn, "2024-01-01", "2024-03-31", f.prevOriginal.val],
            [2024, "FY", "10-K", "2025-02-15", "0000000001-25-000000", "2024-01-01", "2024-12-31", 4_000_000_000],
            [2025, "Q1", "10-Q", f.prevComparative.filed, f.prevComparative.accn, "2024-01-01", "2024-03-31", f.prevComparative.val],
            [2025, "Q1", "10-Q", f.current.filed, f.current.accn, "2025-01-01", "2025-03-31", f.current.val],
            [2026, "Q1", "10-Q", f.currentLater.filed, f.currentLater.accn, "2025-01-01", "2025-03-31", f.currentLater.val],
          ],
        };
      }
      case "weather_quarter": {
        const year = Number(params.year);
        const ids = params.station_list!.split(",");
        const rows = ids.map((id) => {
          const dw = TARGET_STATION_DW[id] ?? PEERS[Number(id.slice(3)) - 10]?.dw ?? 0;
          return weatherRow(id, year, dw);
        });
        return { columns: WEATHER_COLS, rows, elapsed_ms: 25 };
      }
      default:
        return undefined;
    }
  };
}

/** The peers the synthetic data should keep, by construction: SIC in set, both quarters, |g| < 60%. */
export const EXPECTED_PEERS = PEERS.filter((p) => ["4911", "4931", "4932"].includes(p.sic) && p.g !== null && !p.noPrevious && Math.abs(p.g) < 0.6).map((p) => p.cik);
export const ALL_TAGS = REVENUE_TAGS;
