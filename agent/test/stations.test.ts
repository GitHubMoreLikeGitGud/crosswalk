import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isUsStation,
  parseStationLine,
  parseStations,
  stationsViewSql,
  type Station,
} from "../src/tools/stations.ts";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/crosswalk-stations.json", import.meta.url), "utf8"),
) as {
  synthetic: boolean;
  lines: string[];
  expected: Station[];
  us_station_ids: string[];
  state_counts: Record<string, number>;
  bad_lines: { line: string; reason: string }[];
  view_sql_must_contain: string[];
};

describe("parseStationLine", () => {
  it("parses every lines[i] to expected[i]", () => {
    for (let i = 0; i < fixture.lines.length; i++) {
      const got = parseStationLine(fixture.lines[i]!);
      const exp = fixture.expected[i]!;
      expect(got.id).toBe(exp.id);
      expect(got.lat).toBeCloseTo(exp.lat, 9);
      expect(got.lon).toBeCloseTo(exp.lon, 9);
      expect(got.elev).toBeCloseTo(exp.elev, 9);
      expect(got.state).toBe(exp.state);
      expect(got.name).toBe(exp.name);
    }
  });

  it("keeps a 30-character name and null state for the Canadian line", () => {
    const rawName = fixture.lines[2]!.slice(41, 71);
    expect(rawName.length).toBe(30);
    const nameLine = parseStationLine(fixture.lines[2]!);
    expect(nameLine.name).toBe(fixture.expected[2]!.name);
    expect(nameLine.name).toBe(rawName.trim());

    const canadian = parseStationLine(fixture.lines[3]!);
    expect(canadian.state).toBeNull();
    expect(canadian.id).toBe("CA001234567");
  });
});

describe("parseStations and isUsStation", () => {
  it("parses joined text and reproduces us_station_ids and state_counts", () => {
    const stations = parseStations(fixture.lines.join("\n") + "\n");
    expect(stations).toHaveLength(6);

    const usIds = stations.filter((s) => isUsStation(s.id)).map((s) => s.id);
    expect(usIds).toEqual(fixture.us_station_ids);

    const counts: Record<string, number> = {};
    for (const s of stations) {
      if (s.state == null) continue;
      counts[s.state] = (counts[s.state] ?? 0) + 1;
    }
    expect(counts).toEqual(fixture.state_counts);
  });
});

describe("bad lines", () => {
  it("throws on every bad_lines[].line", () => {
    for (const { line } of fixture.bad_lines) {
      expect(() => parseStationLine(line)).toThrow();
    }
  });

  it("throws on a blank coordinate field instead of reading it as 0", () => {
    const good = fixture.lines[0]!;
    const blankLat = good.slice(0, 12) + " ".repeat(8) + good.slice(20);
    expect(blankLat.length).toBe(good.length);
    expect(() => parseStationLine(blankLat)).toThrow();
    const blankElev = good.slice(0, 31) + " ".repeat(6) + good.slice(37);
    expect(() => parseStationLine(blankElev)).toThrow();
  });
});

describe("stationsViewSql", () => {
  it("contains required fragments and no semicolon", () => {
    const sql = stationsViewSql();
    for (const frag of fixture.view_sql_must_contain) {
      expect(sql).toContain(frag);
    }
    expect(sql).not.toContain(";");
  });

  it("uses custom rawTable and column names", () => {
    const sql = stationsViewSql("CW_GHCN.stations_2026", "txt");
    expect(sql).toContain("FROM CW_GHCN.stations_2026");
    expect(sql).toContain("SUBSTR(txt, 1, 11)");
    expect(sql).toContain("SUBSTR(txt, 13, 8)");
    expect(sql).toContain("SUBSTR(txt, 42, 30)");
  });

  it("refuses WON_ tables, unqualified names, and injection", () => {
    expect(() => stationsViewSql("WON_GHCN.stations_raw")).toThrow();
    expect(() => stationsViewSql("won_ghcn.stations_raw")).toThrow();
    expect(() => stationsViewSql("won.stations")).toThrow();
    expect(() => stationsViewSql("stations_raw")).toThrow();
    expect(() => stationsViewSql("CW_GHCN.x; DROP")).toThrow();
    expect(() => stationsViewSql("CW_GHCN.stations_raw", "line; DROP")).toThrow();
  });

  it("trims the name in SQL as parseStationLine does, so both paths agree", () => {
    const sql = stationsViewSql();
    expect(sql).toContain("TRIM(SUBSTR(line, 42, 30)) AS name");
    expect(sql.split("\n")[0]).toBe("SELECT SUBSTR(line, 1, 11) AS id,");
  });
});
