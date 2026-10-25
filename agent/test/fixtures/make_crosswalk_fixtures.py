"""Known-answer fixture generator for Crosswalk's deterministic tools (Cursor tasks C1 to C3).

Writes crosswalk-transforms.json, crosswalk-usl-plan.json, crosswalk-fema.json and
crosswalk-stations.json next to this file. Every expected value is computed here, in Python,
from the method as written in docs/cursor-tasks/C1-C3, independently of the TypeScript under
test. All rows are synthetic: no FEMA, SEC or NOAA data is copied (ids, names and dates are
made up; the shapes follow the public API documentation).

Run from the repository root:  python agent/test/fixtures/make_crosswalk_fixtures.py
"""

from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
VERIFIED, PARTIAL = 0.95, 0.80


# ---------------------------------------------------------------- the closed transform set
def identity(v):
    return v


def upper(v):
    return None if v is None else str(v).upper()


def lpad10(v):
    return None if v is None else str(v).rjust(10, "0")


def substr(start: int, length: int):
    def f(v):
        return None if v is None else str(v)[start - 1:start - 1 + length]
    return f


def strip_prefix(prefix: str):
    """The value without its prefix; None when the prefix is absent (a non-US loc has no state)."""
    def f(v):
        if v is None:
            return None
        s = str(v)
        return s[len(prefix):] if s.startswith(prefix) else None
    return f


def yyyymmdd_to_date(v):
    if v is None:
        return None
    s = str(v)
    return f"{s[0:4]}-{s[4:6]}-{s[6:8]}"


def iso_to_quarter(v):
    """'2025-03-18T00:00:00.000Z' -> 'CY2025Q1' (the SEC frames period spelling)."""
    if v is None:
        return None
    s = str(v)
    year, month = s[0:4], int(s[5:7])
    return f"CY{year}Q{(month + 2) // 3}"


TRANSFORMS = {
    "identity": identity,
    "upper": upper,
    "lpad10": lpad10,
    "substr(4,2)": substr(4, 2),
    "substr(1,11)": substr(1, 11),
    "substr(39,2)": substr(39, 2),
    "strip_prefix('US-')": strip_prefix("US-"),
    "yyyymmdd_to_date": yyyymmdd_to_date,
    "iso_to_quarter": iso_to_quarter,
}


def transform_cases() -> dict:
    inputs = {
        "identity": ["NC", "4911", 1326160, None],
        "upper": ["nc", "Nc", "NC", None],
        "lpad10": [1326160, "1326160", 92122, "0000092122", 4904, None],
        "substr(4,2)": ["US-NC", "US-GA", "CA-ON", "US", None],
        "substr(1,11)": ["USW00013740 35.8656  -78.7847  126.5 NC RALEIGH DURHAM INTL AP", "USC00011084", None],
        "substr(39,2)": ["USW00013740  35.8656  -78.7847  126.5 NC RALEIGH DURHAM INTL AP", None],
        "strip_prefix('US-')": ["US-NC", "US-TX", "CA-ON", "NC", "", None],
        "yyyymmdd_to_date": ["20250318", "20241231", None],
        "iso_to_quarter": ["2025-03-18T00:00:00.000Z", "2025-01-01T00:00:00.000Z", "2025-03-31T23:59:59.000Z",
                           "2025-04-01T00:00:00.000Z", "2024-12-31T00:00:00.000Z", "2025-09-30", "2025-10-01", None],
    }
    return {name: [{"input": v, "expected": TRANSFORMS[name](v)} for v in inputs[name]] for name in inputs}


# ---------------------------------------------------------------- match rate
def match_rate(left_values, right_values, transform) -> dict:
    """matched distinct left keys / distinct left keys, orphans sorted (first 10), verdict by the
    fixed thresholds. A left value whose transform is None has no key and is not counted."""
    left_keys = sorted({k for k in (transform(v) for v in left_values) if k is not None})
    right_keys = {str(v) for v in right_values if v is not None}
    matched = [k for k in left_keys if k in right_keys]
    orphans = [k for k in left_keys if k not in right_keys]
    rate = len(matched) / len(left_keys) if left_keys else 0.0
    verdict = "VERIFIED" if rate >= VERIFIED else ("PARTIAL" if rate >= PARTIAL else "REJECTED")
    return {"left_keys": len(left_keys), "matched_keys": len(matched), "rate": rate,
            "orphans": orphans[:10], "orphans_total": len(orphans), "verdict": verdict}


def match_rate_cases() -> list[dict]:
    cases = []

    def case(name, transform, left_object, left_column, right_object, right_column, left_values, right_values, note):
        cases.append({
            "name": name,
            "proposal": {"leftObject": left_object, "leftColumn": left_column, "rightObject": right_object,
                         "rightColumn": right_column, "transform": transform},
            "left_rows": [{left_column: v} for v in left_values],
            "right_rows": [{right_column: v} for v in right_values],
            "expected": match_rate(left_values, right_values, TRANSFORMS[transform]),
            "note": note,
        })

    # frames cik (integer) against submissions cik (10-digit string): one left filer without a profile
    case("cik_lpad10_partial", "lpad10", "cw.frames_revenues_cy2025q1", "cik", "cw.utility_profiles", "cik10",
         [1326160, 92122, 72903, 65984, 1031296, 4904, 9999999, 1326160],
         ["0001326160", "0000092122", "0000072903", "0000065984", "0001031296", "0000004904", "0000100122"],
         "7 distinct left keys, 6 matched (0.857): PARTIAL; the orphan is 0009999999. The duplicate 1326160 counts once.")
    # frames loc 'US-XX' against the state reference: a Canadian loc and a null have no key
    case("loc_strip_prefix_verified", "strip_prefix('US-')", "cw.frames_revenues_cy2025q1", "loc", "cw.states", "code",
         ["US-NC", "US-GA", "US-NC", "US-TX", "CA-ON", None],
         ["NC", "GA", "TX", "OH", "KY"],
         "3 distinct left keys (NC, GA, TX), all matched: VERIFIED at 1.0; CA-ON and null produce no key.")
    # SIC identity: one code absent from the reference (the MGE Energy 4900 pattern)
    sics = ["4911", "4931", "4932", "4911", "4900", "4924", "4941", "4953", "4961", "4991", "4922", "4923", "4925",
            "4939", "4950", "4952", "4955", "4959", "4971", "6512", "6798", "4910", "4911"]
    case("sic_identity_verified_with_orphan", "identity", "cw.utility_profiles", "sic", "cw.sic_codes", "code",
         sics, [s for s in sorted(set(sics)) if s != "4900"],
         "21 distinct codes, 20 matched (0.952): VERIFIED with 4900 named as the orphan.")
    # FIPS identity fails when one side drops the leading zero: identity is only right on 2-digit strings
    case("fips_identity_rejected", "identity", "cw.fema_declarations", "fipsStateCode", "cw.states", "fips",
         ["6", "40", "21", "54", "2", "40", "40"], ["06", "40", "21", "54", "02", "45"],
         "5 distinct left keys, 3 matched (0.6): REJECTED; orphans 2 and 6 show the missing zero padding.")
    # declarationDate bucketed to a frames period against revenue_quarter periods
    case("date_iso_to_quarter_rejected", "iso_to_quarter", "cw.fema_declarations", "declarationDate", "cw.revenue_quarter", "period",
         ["2025-03-18T00:00:00.000Z", "2025-01-12T00:00:00.000Z", "2024-12-20T00:00:00.000Z", "2025-02-03T00:00:00.000Z"],
         ["CY2025Q1", "CY2024Q1"],
         "2 distinct left keys (CY2025Q1, CY2024Q4), 1 matched (0.5): REJECTED; the orphan is CY2024Q4.")
    # upper on mixed-case state codes
    case("state_upper_verified", "upper", "cw.stations", "state", "cw.states", "code",
         ["nc", "NC", "Ga", "tx", None, ""], ["NC", "GA", "TX"],
         "Distinct left keys after upper: '', GA, NC, TX (4); 3 matched (0.75): REJECTED; the empty string is the orphan.")
    return cases


# ---------------------------------------------------------------- USL plan
def usl_plan() -> dict:
    tables = [
        {"name": "state", "source": "cw.states", "description": "The 50 states and DC with FIPS codes (seeds/states.json)",
         "columns": [{"name": "code", "type": "varchar(2)", "nullable": False, "description": "USPS two-letter code"},
                     {"name": "name", "type": "varchar(40)"},
                     {"name": "fips", "type": "varchar(2)", "description": "two-digit FIPS state code"}],
         "pk": ["code"]},
        {"name": "sic_code", "source": "cw.sic_codes",
         "columns": [{"name": "code", "type": "varchar(4)", "nullable": False}, {"name": "description", "type": "varchar(200)"}],
         "pk": ["code"]},
        {"name": "utility", "source": "cw.utility_profiles",
         "columns": [{"name": "cik", "type": "varchar(10)", "nullable": False}, {"name": "name", "type": "varchar(200)"},
                     {"name": "ticker", "type": "varchar(10)"}, {"name": "sic", "type": "varchar(4)"}, {"name": "hq_state", "type": "varchar(2)"}],
         "pk": ["cik"]},
        {"name": "utility_state", "source": "cw.utility_states",
         "columns": [{"name": "cik", "type": "varchar(10)", "nullable": False}, {"name": "state", "type": "varchar(2)", "nullable": False}],
         "pk": ["cik", "state"]},
        {"name": "fema_declaration", "source": "cw.fema_declarations_dr_2025q1",
         "columns": [{"name": "disaster_number", "type": "int", "nullable": False}, {"name": "state", "type": "varchar(2)", "nullable": False},
                     {"name": "declaration_date", "type": "varchar(10)"}, {"name": "incident_type", "type": "varchar(40)"},
                     {"name": "declaration_type", "type": "varchar(2)"}, {"name": "period", "type": "varchar(8)"}],
         "pk": ["disaster_number", "state"]},
        {"name": "station", "source": "cw.stations",
         "columns": [{"name": "id", "type": "varchar(11)", "nullable": False}, {"name": "state", "type": "varchar(2)"}, {"name": "name", "type": "varchar(60)"}],
         "pk": ["id"]},
        {"name": "revenue_quarter", "source": "cw.frames_seeds_union",
         "columns": [{"name": "cik", "type": "varchar(10)", "nullable": False}, {"name": "xbrl_tag", "type": "varchar(60)", "nullable": False},
                     {"name": "period", "type": "varchar(8)", "nullable": False}, {"name": "val", "type": "double"}, {"name": "accn", "type": "varchar(25)"}],
         "pk": ["cik", "xbrl_tag", "period"]},
        {"name": "weather_quarter", "source": "cw.weather_quarters",
         "columns": [{"name": "station_id", "type": "varchar(11)", "nullable": False}, {"name": "period", "type": "varchar(8)", "nullable": False},
                     {"name": "hdd", "type": "double"}, {"name": "cdd", "type": "double"}, {"name": "days_observed", "type": "int"}, {"name": "coverage", "type": "double"}],
         "pk": ["station_id", "period"]},
    ]
    fks = [
        {"from": "utility.sic", "to": "sic_code.code", "transform": "identity", "match_rate": 0.9767, "verdict": "VERIFIED"},
        {"from": "utility.hq_state", "to": "state.code", "transform": "identity"},
        {"from": "utility_state.cik", "to": "utility.cik", "transform": "identity"},
        {"from": "utility_state.state", "to": "state.code", "transform": "identity"},
        {"from": "fema_declaration.state", "to": "state.code", "transform": "identity"},
        {"from": "station.state", "to": "state.code", "transform": "identity"},
        {"from": "revenue_quarter.cik", "to": "utility.cik", "transform": "identity"},
        {"from": "weather_quarter.station_id", "to": "station.id", "transform": "identity"},
    ]
    plan = {"usl": "crosswalk_usl", "namespace": "lightning.metastore.crosswalk", "tables": tables, "fks": fks}

    def without(table_name, **changes):
        import copy
        p = copy.deepcopy(plan)
        for t in p["tables"]:
            if t["name"] == table_name:
                t.update(changes)
        return p

    import copy
    dup = copy.deepcopy(plan)
    dup["tables"].append(copy.deepcopy(tables[0]))
    unknown_table = copy.deepcopy(plan)
    unknown_table["fks"].append({"from": "utility.cik", "to": "filer.cik", "transform": "identity"})
    unknown_column = copy.deepcopy(plan)
    unknown_column["fks"].append({"from": "utility.cik", "to": "state.abbrev", "transform": "identity"})
    bad_transform = copy.deepcopy(plan)
    bad_transform["fks"].append({"from": "fema_declaration.declaration_date", "to": "revenue_quarter.period", "transform": "to_quarter"})
    pk_missing = without("station", pk=["station_id"])
    reserved = without("revenue_quarter", columns=[{"name": "cik", "type": "varchar(10)", "nullable": False}, {"name": "tag", "type": "varchar(60)"}], pk=["cik"])
    bad_ident = without("station", name="station-2025")
    bad_type = without("state", columns=[{"name": "code", "type": "text", "nullable": False}], pk=["code"])
    bad_ns = copy.deepcopy(plan)
    bad_ns["namespace"] = "lightning.metastore.weatherornot"
    invalid = [
        {"name": "duplicate table", "plan": dup, "error_code": "duplicate_table"},
        {"name": "fk to an unknown table", "plan": unknown_table, "error_code": "unknown_table"},
        {"name": "fk to an unknown column", "plan": unknown_column, "error_code": "unknown_column"},
        {"name": "fk transform outside the closed set", "plan": bad_transform, "error_code": "unknown_transform"},
        {"name": "pk names a column the table does not have", "plan": pk_missing, "error_code": "unknown_column"},
        {"name": "reserved word tag as a column name", "plan": reserved, "error_code": "reserved_word"},
        {"name": "table name with a hyphen", "plan": bad_ident, "error_code": "bad_identifier"},
        {"name": "column type outside varchar(n) | int | double", "plan": bad_type, "error_code": "bad_type"},
        {"name": "namespace outside lightning.metastore.crosswalk", "plan": bad_ns, "error_code": "bad_namespace"},
    ]
    expected = {
        "table_order": [t["name"] for t in tables],
        "fk_lines": [f"{f['from']} -> {f['to']} ({f['transform']})" for f in fks],
        "ddl_must_contain": [
            "COMPILE USL IF NOT EXISTS crosswalk_usl DEPLOY NAMESPACE lightning.metastore.crosswalk DDL",
            "CREATE TABLE state (",
            "code varchar(2) NOT NULL PRIMARY KEY",
            "sic varchar(4) FOREIGN KEY REFERENCES sic_code(code)",
            "PRIMARY KEY (cik, state)",
            "PRIMARY KEY (disaster_number, state)",
            "PRIMARY KEY (cik, xbrl_tag, period)",
            "station_id varchar(11) NOT NULL FOREIGN KEY REFERENCES station(id)",
        ],
        "ddl_must_not_contain": ["DROP", "GRANT", "REVOKE", "INVALIDATE", "weatherornot", "WON_", "won."],
        "ddl_statement_count_rule": "one statement: the CREATE TABLE parts are separated by ';' inside the DDL and the text has no trailing ';'",
        "description_statements": [
            "UPDATE USL crosswalk_usl NAMESPACE lightning.metastore.crosswalk SET TABLE DESCRIPTION state The 50 states and DC with FIPS codes (seeds/states.json)",
            "UPDATE USL crosswalk_usl NAMESPACE lightning.metastore.crosswalk SET COLUMN DESCRIPTION state.code USPS two-letter code",
            "UPDATE USL crosswalk_usl NAMESPACE lightning.metastore.crosswalk SET COLUMN DESCRIPTION state.fips two-digit FIPS state code",
        ],
        "description_rule": "unquoted text, no semicolon, no apostrophe (an apostrophe is dropped, a semicolon becomes a comma)",
    }
    return {"synthetic": True, "plan": plan, "expected": expected, "invalid_plans": invalid}


# ---------------------------------------------------------------- FEMA declarations
def fema_rows() -> list[dict]:
    def row(dn, state, fips, county, date, itype, dtype):
        return {"disasterNumber": dn, "state": state, "fipsStateCode": fips, "fipsCountyCode": county,
                "declarationDate": date, "incidentType": itype, "declarationType": dtype,
                "designatedArea": f"County {county} (synthetic)"}
    rows = []
    # DR 9001: severe storm in KY, 5 counties, Q1 2025
    for c in ("001", "003", "005", "007", "009"):
        rows.append(row(9001, "KY", "21", c, "2025-02-24T00:00:00.000Z", "Severe Storm", "DR"))
    # DR 9002: fire in CA, 2 counties, Q1 2025
    for c in ("037", "111"):
        rows.append(row(9002, "CA", "06", c, "2025-01-08T00:00:00.000Z", "Fire", "DR"))
    # DR 9003: flood in KY, 3 counties, Q1 2025 (second KY disaster, different incident type)
    for c in ("011", "013", "015"):
        rows.append(row(9003, "KY", "21", c, "2025-03-15T00:00:00.000Z", "Flood", "DR"))
    # DR 9004: severe storm in OK, 4 counties, dated 31 March (still Q1)
    for c in ("017", "019", "021", "023"):
        rows.append(row(9004, "OK", "40", c, "2025-03-31T00:00:00.000Z", "Severe Storm", "DR"))
    # DR 9005: severe storm in OK, 1 April (Q2: must be excluded from Q1)
    rows.append(row(9005, "OK", "40", "025", "2025-04-01T00:00:00.000Z", "Severe Storm", "DR"))
    # DR 9006: hurricane in SC, December 2024 (Q4 2024: excluded)
    for c in ("001", "003"):
        rows.append(row(9006, "SC", "45", c, "2024-12-20T00:00:00.000Z", "Hurricane", "DR"))
    # EM 9007: emergency in CA, Q1 2025 (not a major disaster: excluded by the DR filter)
    rows.append(row(9007, "CA", "06", "037", "2025-01-07T00:00:00.000Z", "Fire", "EM"))
    # FM 9008: fire management in OR, Q1 2025 (excluded by the DR filter)
    rows.append(row(9008, "OR", "41", "005", "2025-02-10T00:00:00.000Z", "Fire", "FM"))
    # DR 9009: a territory declaration (PR) in Q1 2025: counted per state, orphan against states.json
    rows.append(row(9009, "PR", "72", "127", "2025-02-01T00:00:00.000Z", "Flood", "DR"))
    return rows


def fema_expected(rows: list[dict]) -> dict:
    dr = [r for r in rows if r["declarationType"] == "DR"]
    q1 = [r for r in dr if iso_to_quarter(r["declarationDate"]) == "CY2025Q1"]
    per_state: dict[str, dict] = {}
    for r in q1:
        s = per_state.setdefault(r["state"], {"state": r["state"], "disasters": set(), "rows": 0, "by_incident_type": {}})
        s["disasters"].add(r["disasterNumber"])
        s["rows"] += 1
        s["by_incident_type"].setdefault(r["incidentType"], set()).add(r["disasterNumber"])
    by_state = []
    for s in sorted(per_state.values(), key=lambda x: (-len(x["disasters"]), x["state"])):
        by_state.append({"state": s["state"], "declarations": len(s["disasters"]), "rows": s["rows"],
                         "disaster_numbers": sorted(s["disasters"]),
                         "by_incident_type": {k: len(v) for k, v in sorted(s["by_incident_type"].items())}})
    return {
        "rows_total": len(rows),
        "dr_rows": len(dr),
        "dr_disasters": len({r["disasterNumber"] for r in dr}),
        "q1_2025_dr_rows": len(q1),
        "q1_2025_dr_disasters": len({r["disasterNumber"] for r in q1}),
        "q1_2025_states": sorted({r["state"] for r in q1}),
        "quarter_of": {r["declarationDate"]: iso_to_quarter(r["declarationDate"]) for r in rows},
        "by_state_q1_2025": by_state,
        "states_outside_reference": sorted({r["state"] for r in q1} - {"KY", "CA", "OK", "SC", "OR"}),
    }


def build_fema() -> dict:
    rows = fema_rows()
    return {
        "synthetic": True,
        "note": "Synthetic rows in the shape of OpenFEMA DisasterDeclarationsSummaries v2 (one row per designated county). Disaster numbers 9001-9009, dates and areas are made up. Expected values from make_crosswalk_fixtures.py: declarations are counted as DISTINCT disasterNumber per state (one disaster covers many counties), the DR filter keeps declarationType DR only, and the quarter comes from the first ten characters of the ISO date.",
        "response_shape": {"metadata": {"skip": 0, "top": 1000, "count": 0}, "DisasterDeclarationsSummaries": "rows[]"},
        "rows": rows,
        "expected": fema_expected(rows),
    }


# ---------------------------------------------------------------- ghcnd-stations.txt lines
def station_line(sid: str, lat: float, lon: float, elev: float, state: str, name: str, gsn: str = "", hcn: str = "", wmo: str = "") -> str:
    """The fixed-width layout of ghcnd-stations.txt: id 1-11, lat 13-20, lon 22-30, elev 32-37,
    state 39-40, name 42-71, GSN 73-75, HCN/CRN 77-79, WMO 81-85 (1-based, inclusive)."""
    line = f"{sid:<11} {lat:>8.4f} {lon:>9.4f} {elev:>6.1f} {state:<2} {name:<30} {gsn:<3} {hcn:<3} {wmo:<5}"
    assert len(line) == 85, len(line)
    return line


def parse_station(line: str) -> dict:
    return {"id": line[0:11], "lat": float(line[12:20]), "lon": float(line[21:30]), "elev": float(line[31:37]),
            "state": line[38:40].strip() or None, "name": line[41:71].strip()}


def build_stations() -> dict:
    lines = [
        station_line("USW00099001", 35.8656, -78.7847, 126.5, "NC", "SYNTHETIC CITY INTL AP", "", "HCN", "72306"),
        station_line("USW00099002", 33.6301, -84.4418, 308.2, "GA", "ANOTHER MADE UP FIELD"),
        station_line("USC00099003", 29.5333, -98.4700, 240.8, "TX", "A NAME THAT IS EXACTLY THIRTY", "GSN"),
        station_line("CA001234567", 45.3200, -75.6700, 114.0, "", "NON US STATION NO STATE", "", "", "71063"),
        station_line("USW00099004", -14.3310, -170.7105, 3.7, "AS", "PACIFIC TERRITORY STATION"),
        station_line("USW00099005", 61.1689, -149.9961, 36.6, "AK", "NORTHERN SYNTHETIC AP"),
    ]
    parsed = [parse_station(x) for x in lines]
    assert parsed[2]["name"] == "A NAME THAT IS EXACTLY THIRTY"
    return {
        "synthetic": True,
        "note": "Synthetic lines in the fixed-width layout of ghcnd-stations.txt (ids, coordinates and names are made up). Expected fields from make_crosswalk_fixtures.py with 1-based inclusive columns id 1-11, lat 13-20, lon 22-30, elev 32-37, state 39-40, name 42-71.",
        "columns": {"id": [1, 11], "lat": [13, 20], "lon": [22, 30], "elev": [32, 37], "state": [39, 40], "name": [42, 71]},
        "lines": lines,
        "expected": parsed,
        "us_station_ids": [p["id"] for p in parsed if p["id"].startswith("US")],
        "state_counts": {s: sum(1 for p in parsed if p["state"] == s) for s in sorted({p["state"] for p in parsed if p["state"]})},
        "bad_lines": [
            {"line": "USW00099001 35.8656", "reason": "shorter than the name column"},
            {"line": "", "reason": "empty"},
        ],
        "view_sql_must_contain": [
            "SUBSTR(line, 1, 11) AS id",
            "SUBSTR(line, 13, 8)",
            "SUBSTR(line, 22, 9)",
            "SUBSTR(line, 32, 6)",
            "SUBSTR(line, 39, 2) AS state",
            "SUBSTR(line, 42, 30) AS name",
            "FROM CW_GHCN.stations_raw",
        ],
    }


def main() -> None:
    out = {
        "crosswalk-transforms.json": {
            "synthetic": True,
            "note": "The closed transform set and match-rate cases for C1. Object names are the planned cw.* views; rows are made up. Expected values from make_crosswalk_fixtures.py.",
            "thresholds": {"verified": VERIFIED, "partial": PARTIAL},
            "transforms": transform_cases(),
            "match_rate_cases": match_rate_cases(),
        },
        "crosswalk-usl-plan.json": usl_plan(),
        "crosswalk-fema.json": build_fema(),
        "crosswalk-stations.json": build_stations(),
    }
    for name, payload in out.items():
        path = HERE / name
        path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {path.name} ({path.stat().st_size} bytes)")
    for c in out["crosswalk-transforms.json"]["match_rate_cases"]:
        e = c["expected"]
        print(f"  {c['name']}: {e['matched_keys']}/{e['left_keys']} = {e['rate']:.4f} {e['verdict']} orphans {e['orphans']}")
    f = out["crosswalk-fema.json"]["expected"]
    print(f"  fema: rows {f['rows_total']}, DR rows {f['dr_rows']}, Q1-2025 DR disasters {f['q1_2025_dr_disasters']} in {f['q1_2025_states']}")
    for s in f["by_state_q1_2025"]:
        print(f"    {s['state']}: {s['declarations']} declaration(s), {s['rows']} rows, {s['by_incident_type']}")
    print("  stations:", out["crosswalk-stations.json"]["state_counts"])


if __name__ == "__main__":
    main()
