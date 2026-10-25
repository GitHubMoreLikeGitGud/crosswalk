/** OpenFEMA DisasterDeclarationsSummaries v2 row parsing and DR quarter roll-ups. */

export interface FemaRow {
  disasterNumber: number;
  state: string;
  fipsStateCode: string | null;
  fipsCountyCode: string | null;
  declarationDate: string;
  incidentType: string;
  declarationType: string;
  designatedArea: string | null;
}

export interface StateDeclarations {
  state: string;
  declarations: number;
  rows: number;
  disaster_numbers: number[];
  by_incident_type: Record<string, number>;
}

/** Calendar quarter as a SEC frames period id from the first seven chars `yyyy-mm`. */
export function quarterOf(iso: string): string {
  if (iso.length < 7) {
    throw new Error(`declaration date too short: ${iso}`);
  }
  const year = iso.slice(0, 4);
  const monthStr = iso.slice(5, 7);
  const month = Number(monthStr);
  if (!/^\d{4}$/.test(year) || !/^\d{2}$/.test(monthStr) || Number.isNaN(month)) {
    throw new Error(`invalid declaration date month: ${iso}`);
  }
  const quarter = Math.floor((month + 2) / 3);
  return `CY${year}Q${quarter}`;
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

export function fromGatewayRows(rows: Record<string, unknown>[]): FemaRow[] {
  return rows.map((row, i) => {
    if (
      row.disasterNumber === undefined ||
      row.disasterNumber === null ||
      row.state === undefined ||
      row.state === null ||
      row.declarationDate === undefined ||
      row.declarationDate === null ||
      row.declarationType === undefined ||
      row.declarationType === null
    ) {
      throw new Error(`FEMA row ${i} missing required field`);
    }
    const disasterNumber = Number(row.disasterNumber);
    if (Number.isNaN(disasterNumber)) {
      throw new Error(`FEMA row ${i} has non-numeric disasterNumber`);
    }
    return {
      disasterNumber,
      state: String(row.state),
      fipsStateCode: nullableString(row.fipsStateCode),
      fipsCountyCode: nullableString(row.fipsCountyCode),
      declarationDate: String(row.declarationDate),
      incidentType: String(row.incidentType ?? ""),
      declarationType: String(row.declarationType),
      designatedArea: nullableString(row.designatedArea),
    };
  });
}

export function onlyMajorDisasters(rows: FemaRow[]): FemaRow[] {
  return rows.filter((r) => r.declarationType === "DR");
}

export function declarationsByState(
  rows: FemaRow[],
  period: string,
): StateDeclarations[] {
  const filtered = onlyMajorDisasters(rows).filter(
    (r) => quarterOf(r.declarationDate) === period,
  );

  type Acc = {
    rows: number;
    disasters: Set<number>;
    byType: Map<string, Set<number>>;
  };
  const byState = new Map<string, Acc>();

  for (const r of filtered) {
    let acc = byState.get(r.state);
    if (!acc) {
      acc = { rows: 0, disasters: new Set(), byType: new Map() };
      byState.set(r.state, acc);
    }
    acc.rows += 1;
    acc.disasters.add(r.disasterNumber);
    let typeSet = acc.byType.get(r.incidentType);
    if (!typeSet) {
      typeSet = new Set();
      acc.byType.set(r.incidentType, typeSet);
    }
    typeSet.add(r.disasterNumber);
  }

  const entries: StateDeclarations[] = [];
  for (const [state, acc] of byState) {
    const disaster_numbers = [...acc.disasters].sort((a, b) => a - b);
    const by_incident_type: Record<string, number> = {};
    for (const key of [...acc.byType.keys()].sort()) {
      by_incident_type[key] = acc.byType.get(key)!.size;
    }
    entries.push({
      state,
      declarations: acc.disasters.size,
      rows: acc.rows,
      disaster_numbers,
      by_incident_type,
    });
  }

  entries.sort((a, b) => {
    if (b.declarations !== a.declarations) return b.declarations - a.declarations;
    return a.state < b.state ? -1 : a.state > b.state ? 1 : 0;
  });
  return entries;
}

export function statesOutsideReference(
  entries: StateDeclarations[],
  referenceCodes: string[],
): string[] {
  const ref = new Set(referenceCodes);
  return entries
    .map((e) => e.state)
    .filter((s) => !ref.has(s))
    .sort();
}
