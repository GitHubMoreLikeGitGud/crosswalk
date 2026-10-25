/** NOAA GHCN fixed-width station list parser and Lightning SUBSTR view SQL. */

/** 1-based inclusive column spans for ghcnd-stations.txt. */
export const STATION_COLUMNS = {
  id: [1, 11] as const,
  lat: [13, 20] as const,
  lon: [22, 30] as const,
  elev: [32, 37] as const,
  state: [39, 40] as const,
  name: [42, 71] as const,
} as const;

export interface Station {
  id: string;
  lat: number;
  lon: number;
  elev: number;
  state: string | null;
  name: string;
}

const ID_RE = /^[A-Z0-9]{11}$/;
const TABLE_RE = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/;
const COLUMN_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Number("   ") is 0, not NaN: a blank coordinate field must throw, as CAST(TRIM('') AS DOUBLE) is NULL in SQL.
function numberField(raw: string, id: string): number {
  const s = raw.trim();
  const n = s === "" ? Number.NaN : Number(s);
  if (Number.isNaN(n)) {
    throw new Error(`non-numeric station coordinates in ${id}`);
  }
  return n;
}

export function parseStationLine(line: string): Station {
  if (line.length < 71) {
    throw new Error("station line shorter than name column");
  }
  const id = line.slice(0, 11);
  if (!ID_RE.test(id)) {
    throw new Error(`invalid station id: ${id}`);
  }
  const lat = numberField(line.slice(12, 20), id);
  const lon = numberField(line.slice(21, 30), id);
  const elev = numberField(line.slice(31, 37), id);
  const stateRaw = line.slice(38, 40).trim();
  return {
    id,
    lat,
    lon,
    elev,
    state: stateRaw || null,
    name: line.slice(41, 71).trim(),
  };
}

export function parseStations(text: string): Station[] {
  const out: Station[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) continue;
    out.push(parseStationLine(line));
  }
  return out;
}

export function isUsStation(id: string): boolean {
  return id.startsWith("US");
}

export function stationsViewSql(
  rawTable = "CW_GHCN.stations_raw",
  column = "line",
): string {
  if (!TABLE_RE.test(rawTable)) {
    throw new Error(`invalid rawTable: ${rawTable}`);
  }
  const db = rawTable.slice(0, rawTable.indexOf("."));
  // Lightning folds identifier case: the sister project's databases and container in any spelling.
  if (/^won(_|$)/i.test(db)) {
    throw new Error(`refused WON_ table: ${rawTable}`);
  }
  if (!COLUMN_RE.test(column)) {
    throw new Error(`invalid column: ${column}`);
  }

  return [
    `SELECT SUBSTR(${column}, 1, 11) AS id,`,
    `       CAST(TRIM(SUBSTR(${column}, 13, 8)) AS DOUBLE) AS lat,`,
    `       CAST(TRIM(SUBSTR(${column}, 22, 9)) AS DOUBLE) AS lon,`,
    `       CAST(TRIM(SUBSTR(${column}, 32, 6)) AS DOUBLE) AS elev,`,
    `       SUBSTR(${column}, 39, 2) AS state,`,
    `       TRIM(SUBSTR(${column}, 42, 30)) AS name`,
    `FROM ${rawTable}`,
  ].join("\n");
}
