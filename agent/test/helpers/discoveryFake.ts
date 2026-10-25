// The synthetic discovery fake shared by the loop tests (made-up CIKs, station ids and values): the probe
// shapes, the join-map replies, the answer replies and a registrar that answers already_registered.
import { readFileSync } from "node:fs";
import { EvidenceStore } from "../../src/evidence/store.ts";
import type { RegistrarPort, ToolDeps } from "../../src/loop/tools.ts";
import { loadSeeds } from "../../src/seeds.ts";
import type { RegistrarResult } from "../../src/zetaris/client.ts";
import { fakeGateway, type Reply } from "./fakeGateway.ts";
export const repo = new URL("../../../", import.meta.url);
export const manifest = JSON.parse(readFileSync(new URL("zetaris/manifest.json", repo), "utf8"));
export const NOW = new Date("2026-10-25T12:00:00+08:00");
export const Q = "CY2025Q1";

const S = (n: string) => ({ name: n, type: "string" });
const SHAPES: Record<string, { cols: { name: string; type: string }[]; rows: unknown[][]; distinct: Record<string, [number, number]> }> = {
  "cw.seed_submissions_snapshot": { cols: ["cik10", "name", "ticker", "sic", "hq_state", "snapshot_at"].map(S), rows: [["0009000001", "SYN A", "SA", "4911", "CA", "2026-10-25T12:00:00+0800"], ["0009000002", "SYN B", null, "4900", "OH", "2026-10-25T12:00:00+0800"]], distinct: { cik10: [43, 43], sic: [43, 4], hq_state: [43, 30] } },
  "cw.frames_revenues_cy2025q1": { cols: [{ name: "cik", type: "bigint" }, S("entityName"), S("loc"), S("accn"), { name: "val", type: "double" }], rows: [[9000001, "SYN A", "US-CA", "x", 1], [12345, "SYN Z", "US-NY", "y", 2]], distinct: { cik: [1900, 1900], loc: [1900, 55] } },
  "cw.fema_declarations_dr_2025q1": { cols: ["disaster_number", "state", "incident_type", "fips_state_code"].map(S), rows: [["9001", "KY", "Flood", "21"], ["9002", "AK", "Fire", "02"]], distinct: { state: [116, 8], disaster_number: [116, 10], fips_state_code: [116, 8] } },
  "cw.utility_states": { cols: ["cik", "state"].map(S), rows: [["0009000001", "CA"], ["0009000002", "OH"]], distinct: { cik: [97, 43], state: [97, 43] } },
  "cw.states": { cols: ["code", "name", "fips"].map(S), rows: [["CA", "California", "06"], ["OH", "Ohio", "39"]], distinct: { code: [51, 51], fips: [51, 51] } },
  "cw.seed_stations": { cols: ["id", "state", "name"].map(S), rows: [["USW00099001", "CA", "SYN 1"], ["USW00099002", "OH", "SYN 2"]], distinct: { state: [56, 43], id: [56, 56] } },
  "cw.stations": { cols: [S("id"), S("state"), S("name"), { name: "latitude", type: "double" }], rows: [["USW00099001", "CA", "SYN 1", 1.5], ["CA000000001", "", "SYN 3", 2.5]], distinct: { state: [133000, 60], id: [133000, 133000] } },
  "cw.sic_codes": { cols: ["code", "description"].map(S), rows: [["4911", "Electric"], ["4900", "x"]], distinct: { code: [1005, 1005] } },
};

export function resolve(id: string, p: Record<string, string>): Reply | undefined {
  const shape = p.object ? SHAPES[p.object] : undefined;
  switch (id) {
    case "catalogue_list":
      return { columns: ["name", "version", "title", "api_endpoint", "last_dataset_refresh"], rows: [["DisasterDeclarationsSummaries", 2, "Disaster Declarations Summaries (synthetic)", "", "2026-10-25"]] };
    case "describe_object":
      return shape && { columns: ["col_name", "data_type", "comment"], rows: shape.cols.map((c) => [c.name, c.type, null]) };
    case "sample_rows":
      return shape && { columns: shape.cols.map((c) => c.name), rows: shape.rows };
    case "distinct_counts": {
      const d = shape?.distinct[p.column!];
      return d && { columns: ["row_count", "distinct_values", "non_null", "non_null_share"], rows: [[d[0], d[1], d[0], 1]] };
    }
    case "joinmap_cik":
      return { columns: ["left_keys", "matched_keys"], rows: [[43, 42]] };
    case "joinmap_cik_orphans":
      return { columns: ["orphan_cik", "name"], rows: [["0009000043", "SYN Q"]] };
    case "joinmap_cik_control":
      return { columns: ["left_keys", "matched_keys"], rows: [[43, 0]] };
    case "joinmap_fema_fips":
      return { columns: ["left_keys", "matched_keys"], rows: [[8, 8]] };
    case "joinmap_loc":
      return { columns: ["left_keys", "matched_keys"], rows: [[42, 42]] };
    case "joinmap_fema_state":
      return { columns: ["left_keys", "matched_keys"], rows: [[8, 7]] };
    case "joinmap_fema_state_orphans":
      return { columns: ["orphan_state"], rows: [["AK"]] };
    case "joinmap_station":
      return { columns: ["left_keys", "matched_keys", "state_equal"], rows: [[56, 56, 56]] };
    case "joinmap_sic":
      return { columns: ["left_keys", "matched_keys", "left_rows", "matched_rows"], rows: [[4, 3, 43, 42]] };
    case "joinmap_sic_orphans":
      return { columns: ["orphan_sic", "cik", "name"], rows: [["4900", "0009000002", "SYN B"]] };
    // D16: any other pair; synthetic rule: the same column name on both sides matches every key, otherwise half do.
    case "match_rate":
      return { columns: ["left_keys", "matched_keys"], rows: [[40, p.left_column === p.right_column ? 40 : 20]] };
    case "match_rate_orphans":
      return { columns: ["orphan"], rows: [["SYN-ORPHAN"]] };
    case "dq_run":
      return { columns: ["total", "valid", "invalid"], rows: [[97, 97, 0]] };
    case "answer_fema_utilities":
      return { columns: ["cik", "name", "ticker", "state", "declarations", "severe_storm", "fire", "flood", "other_incidents"], rows: [["0009000001", "SYN A", "SA", "CA", 1, 0, 1, 0, 0]] };
    case "answer_revenue":
      return { columns: ["cik", "xbrl_tag", "val", "accn"], rows: [["0009000001", "Revenues", p.period === Q ? 110 : 100, "a"]] };
    default:
      return undefined;
  }
}

export function registrar(alreadyRegistered = true): RegistrarPort & { calls: { action: string; params: Record<string, string> }[] } {
  const calls: { action: string; params: Record<string, string> }[] = [];
  return {
    calls,
    async register(action, params): Promise<RegistrarResult> {
      calls.push({ action, params });
      return { action, params, contract_id: "c-test", steps: [{ template_id: "registrar_fema_describe", kind: "describe", sql: "DESCRIBE x", sql_sha256: "0", objects: [] }], skipped: [], already_registered: alreadyRegistered, http_status: 200, wall_ms: 9 };
    },
  };
}

export function deps(over: Partial<ToolDeps> = {}): ToolDeps & { fake: ReturnType<typeof fakeGateway> } {
  const fake = fakeGateway(resolve);
  const evidence = new EvidenceStore("r-test", null);
  return { fake, gateway: fake.client, ollama: null, evidence, seeds: loadSeeds(), registrar: registrar(), catalogue: { catalogue: JSON.parse(readFileSync(new URL("seeds/catalogue.json", repo), "utf8")), manifest, gettingStarted: null }, dqFile: "no-such-file.json", ...over };
}
