"""Named templates. The agent sends a template id and parameters, never SQL.

Adapted from Weather-or-Not and ClearShelf (same author, Apache-2.0).

Parameters are validated by regex before they are substituted, so a value can only ever be
a 10-digit CIK (or a list of them), one of three revenue tags, a CY frame period, a year, a
quarter number, a GHCN station id (or a list) or element, a SIC code, a FEMA quarter, one of
the six USL foreign-key rules, a column name, or a cw.* view that zetaris/manifest.json lists.
Reader templates run through POST /sql/template. A registrar plan (REGISTRAR_PLANS) is a short
ordered list of registrar templates that POST /registrar/<action> runs under an execution
contract (gateway/registrar.py); register_source dispatches a catalogue id
(seeds/catalogue.json) to one of those plans (SOURCE_PLANS).

Reader templates, by purpose:
- discovery probes: describe_object, sample_rows, distinct_counts over a manifest view (cw_object);
- the join map: joinmap_* over cached views (zetaris/sql/06_cw_joinmap_select.sql);
- the answer: answer_fema_utilities, answer_revenue, seed_utility_names, weather_quarter;
- the governed USL: usl_tables, usl_dq_rules, usl_model (each under 3 s), and dq_run / dq_invalid
  (RUN DQ / SHOW DQ INVALID RECORD per foreign-key rule, minutes, onboarding_only).
Templates marked onboarding_only are refused on the agent's question path.

SEC objects: raw REST tables CW_SEC.frames_<tag>_<period>, CW_SEC.concept_<cik10>_<tag>,
CW_SEC.submissions_<cik10>, CW_DNS.sic_codes_v4_raw; flattened, cached SchemaStore views
cw.frames_<tag>_<period>, cw.concept_<cik10>_<tag>, cw.submission_<cik10>, cw.sic_codes.
The User-Agent in a REST statement is the placeholder YOUR_APP_NAME YOUR_CONTACT_EMAIL, filled
from CW_USER_AGENT on the wire only (gateway/jdbc.py apply_user_agent); it is never a literal
here or in a committed SQL file.

GHCN (zetaris/sql/09_cw_ghcn_*.sql, the shape of won-reference/04_won_ghcn_*.sql): weather_quarter
computes degree days in Lightning SQL over the cached station-filtered views cw.ghcn_<year>_<element>
for a quoted station list (the station_list kind, rendered by RENDERERS).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

SEEDS_PATH = Path(__file__).resolve().parent.parent / "seeds" / "utilities.json"


def load_seed_ciks(path: Path = SEEDS_PATH) -> tuple[str, ...]:
    """The 10-digit CIKs of seeds/utilities.json in file order (the peer universe; the
    frames_seeds template and the USL utility activation use the same list)."""
    utilities = json.loads(path.read_text(encoding="utf-8"))["utilities"]
    ciks = tuple(u["cik"] for u in utilities)
    bad = [c for c in ciks if not re.fullmatch(r"\d{10}", c)]
    if bad or len(set(ciks)) != len(ciks):
        raise ValueError(f"seeds/utilities.json: every cik must be a distinct 10-digit string (bad: {bad[:3]})")
    return ciks


SEED_CIKS: tuple[str, ...] = load_seed_ciks()
# frames carry cik as an integer: the IN list holds the seeds as integers (1326160, 92122, ...).
SEED_CIK_INTS_SQL = ", ".join(str(int(c)) for c in SEED_CIKS)

STATIONS_PATH = Path(__file__).resolve().parent.parent / "seeds" / "stations.json"
# The validation station of the sister entry's degree-day check (Richmond, VA): kept in the GHCN
# views so that weather_quarter can be compared with its published values. No seed utility uses it.
VALIDATION_STATION = "USW00013740"


def load_seed_stations(path: Path = STATIONS_PATH) -> tuple[str, ...]:
    """The GHCN ids of seeds/stations.json, sorted, plus VALIDATION_STATION: the filter of the
    station views cw.ghcn_<year>_<element> (one station's days are spread over 9 parquet files)."""
    ids = {s["id"] for s in json.loads(path.read_text(encoding="utf-8"))["stations"]}
    bad = [i for i in ids if not re.fullmatch(r"US[A-Z0-9]{9}", i)]
    if bad:
        raise ValueError(f"seeds/stations.json: every id must be a US GHCN id (bad: {bad[:3]})")
    return tuple(sorted(ids | {VALIDATION_STATION}))


GHCN_STATIONS: tuple[str, ...] = load_seed_stations()
GHCN_STATIONS_SQL = ", ".join(f"'{s}'" for s in GHCN_STATIONS)

MANIFEST_PATH = Path(__file__).resolve().parent.parent / "zetaris" / "manifest.json"
# How a manifest name pattern's <placeholder> matches (lower case: Lightning folds identifier case).
MANIFEST_PLACEHOLDERS = {
    "tag": r"(revenues|revenuefromcontractwithcustomerexcludingassessedtax|regulatedandunregulatedoperatingrevenue)",
    "period": r"cy\d{4}q[1-3]",
    "cik10": r"\d{10}",
    "quarter_slug": r"\d{4}q[1-4]",
    "year": r"20\d{2}",
    "element": r"(tmax|tmin)",
}


def _manifest_names(node) -> list[str]:
    """Every "cw.<name>" string under an `objects` entry of the manifest (raw CW_* tables excluded)."""
    if isinstance(node, str):
        return [node] if node.startswith("cw.") else []
    if isinstance(node, list):
        return [n for x in node for n in _manifest_names(x)]
    if isinstance(node, dict):
        return [n for x in node.values() for n in _manifest_names(x)]
    return []


def load_manifest_views(path: Path = MANIFEST_PATH) -> tuple[frozenset[str], tuple[re.Pattern, ...]]:
    """The SchemaStore view names zetaris/manifest.json lists (lower case) and its name patterns
    (cw.frames_<tag>_<period>, cw.fema_declarations_dr_<quarter_slug>, ...) as regular expressions."""
    data = json.loads(path.read_text(encoding="utf-8"))
    exact, patterns = set(), []
    for src in data.get("sources", []):
        for name in _manifest_names(src.get("objects", {})):
            name = name.lower()
            if "<" not in name:
                exact.add(name)
                continue
            parts = re.split(r"<(\w+)>", name)
            rx = "".join(re.escape(p) if i % 2 == 0 else MANIFEST_PLACEHOLDERS[p] for i, p in enumerate(parts))
            patterns.append(re.compile(rx))
    return frozenset(exact), tuple(patterns)


MANIFEST_VIEWS, MANIFEST_VIEW_PATTERNS = load_manifest_views()


def in_manifest(name: str) -> bool:
    n = name.lower()
    return n in MANIFEST_VIEWS or any(p.fullmatch(n) for p in MANIFEST_VIEW_PATTERNS)


# The six foreign-key rules of the governed USL (zetaris/sql/07_cw_usl_create.sql; LIST DQ USL names a rule
# after its column, so RUN DQ <column> TABLE <table> runs that column's PK and FK checks together).
DQ_RULES = ("utility.sic", "utility_state.cik", "utility_state.state", "fema_declaration.state", "station.state",
            "revenue_quarter.cik")

PARAM_PATTERNS = {
    "cik10": re.compile(r"^\d{10}$"),
    "tag": re.compile(r"^(Revenues|RevenueFromContractWithCustomerExcludingAssessedTax|RegulatedAndUnregulatedOperatingRevenue)$"),
    "period": re.compile(r"^CY\d{4}Q[1-3]$"),
    "year": re.compile(r"^20\d{2}$"),
    "quarter": re.compile(r"^[1-3]$"),
    "station": re.compile(r"^US[A-Z0-9]{9}$"),
    "station_list": re.compile(r"^US[A-Z0-9]{9}(,US[A-Z0-9]{9}){0,59}$"),  # 1 to 60 ids, comma-separated (56 seed stations)
    "element": re.compile(r"^(TMAX|TMIN)$"),
    "sic": re.compile(r"^\d{4}$"),
    "fema_quarter": re.compile(r"^CY\d{4}Q[1-4]$"),  # a calendar quarter of FEMA declarations (any quarter, unlike period)
    "cw_object": re.compile(r"^cw\.[a-z0-9_]+$"),  # a SchemaStore view in container cw, lower case; must also be in the manifest
    "column": re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$"),  # a column name, written back-quoted
    "cik_list": re.compile(r"^\d{10}(,\d{10}){0,59}$"),  # 1 to 60 ten-digit CIKs, comma-separated (43 seed utilities)
    "dq_rule": re.compile(r"^(utility\.sic|utility_state\.cik|utility_state\.state|fema_declaration\.state|station\.state|revenue_quarter\.cik)$"),
    "catalogue_id": re.compile(r"^[a-z][a-z0-9_]{0,63}$"),  # an entry id of seeds/catalogue.json (register_source)
}

# How a validated value is written into the SQL. A kind not listed here is substituted as is;
# a station_list or cik_list becomes a quoted IN list ('USW00013740', 'USW00013722'); a column is back-quoted.
RENDERERS = {
    "station_list": lambda v: ", ".join(f"'{s}'" for s in v.split(",")),
    "cik_list": lambda v: ", ".join(f"'{s}'" for s in v.split(",")),
    "column": lambda v: f"`{v}`",
}


def _manifest_check(value: str) -> None:
    if not in_manifest(value):
        raise BadParams(f"cw_object {value!r} is not a view zetaris/manifest.json lists")


# Checks beyond the pattern (kind -> function raising BadParams).
CHECKS = {"cw_object": _manifest_check}


def fema_quarter_bounds(value: str) -> dict[str, str]:
    """Extra placeholders derived from a validated fema_quarter CY<yyyy>Q<n>: {quarter_slug} (2025q1, the
    object-name suffix), {quarter_start} and {quarter_end} (ISO instants, [start, end) of the quarter)."""
    year, q = int(value[2:6]), int(value[7])
    start_month = 3 * q - 2
    end_year, end_month = (year + 1, 1) if q == 4 else (year, start_month + 3)
    return {
        "quarter_slug": f"{year}q{q}",
        "quarter_start": f"{year:04d}-{start_month:02d}-01T00%3A00%3A00.000Z",
        "quarter_end": f"{end_year:04d}-{end_month:02d}-01T00%3A00%3A00.000Z",
    }


def dq_rule_parts(value: str) -> dict[str, str]:
    """{dq_table} and {dq_name} of a validated dq_rule <table>.<column> (the rule is named after its column)."""
    table, column = value.split(".")
    return {"dq_table": table, "dq_name": column}


# Placeholders derived from a validated value (kind -> function); render() substitutes them too.
DERIVED = {
    "fema_quarter": fema_quarter_bounds,
    "element": lambda v: {"element_lc": v.lower()},  # object names are lower case: cw.ghcn_2025_tmax
    "dq_rule": dq_rule_parts,
}


class BadParams(ValueError):
    pass


@dataclass(frozen=True)
class Template:
    id: str
    sql: str
    params: dict[str, str]  # parameter name -> PARAM_PATTERNS kind
    objects: tuple[str, ...]  # what the statement reads or creates (USL tables, views), for the evidence drawer
    raw_objects: tuple[str, ...]  # cached raw tables or views behind it; "{name}" takes the validated parameter
    description: str = ""
    role: str = "reader"  # reader templates run via /sql/template; registrar templates only inside a plan
    timeout_s: float | None = None  # bounded wait for this template; None = the gateway's default (60 s)
    onboarding_only: bool = False  # minutes-long DQ: the onboarding path only, refused on the agent's question path


@dataclass(frozen=True)
class Step:
    template_id: str
    skip_exists: bool = False  # Zetaris's "already exists" counts as done
    timeout_s: float = 120.0


@dataclass(frozen=True)
class Plan:
    action: str
    params: dict[str, str]  # parameter name -> PARAM_PATTERNS kind; every step's params are a subset
    steps: tuple[Step, ...]
    description: str = ""


def _t(id: str, sql: str, params: dict[str, str], objects: tuple[str, ...], raw: tuple[str, ...],
       description: str, role: str = "reader", timeout_s: float | None = None, onboarding_only: bool = False) -> Template:
    return Template(id, " ".join(sql.split()), params, objects, raw, description, role, timeout_s, onboarding_only)


# RUN DQ / SHOW DQ INVALID RECORD on a USL table whose parent is utility re-read the 43 submission views
# (live 2026-10-25: 72-151 s, SHOW DQ INVALID RECORD sic 149 s); every DQ statement is bounded at 900 s.
DQ_TIMEOUT_S = 900.0


UA_HEADER = 'HEADER ( user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL" )'
REST_REQUEST_TAIL = f'method "get", response_type "json", http_encoding "URLENCODED" ) {UA_HEADER} BODY ()'

# Object names (one spelling, used by the SQL files, the templates and the cache targets).
FRAMES_RAW = "CW_SEC.frames_{tag}_{period}"
FRAMES_VIEW = "cw.frames_{tag}_{period}"
CONCEPT_RAW = "CW_SEC.concept_{cik10}_{tag}"
CONCEPT_VIEW = "cw.concept_{cik10}_{tag}"
SUBMISSIONS_RAW = "CW_SEC.submissions_{cik10}"
SUBMISSION_VIEW = "cw.submission_{cik10}"
SIC_RAW = "CW_DNS.sic_codes_v4_raw"
SIC_VIEW = "cw.sic_codes"

FRAMES_COLUMNS = "cik, `entityName`, loc, `start`, `end`, val, accn"
SUBMISSION_COLUMNS = "cik, name, sic, `sicDescription`, state"
SIC_COLUMNS = "code, description, division, division_desc, major_group, major_group_desc"

_TP = {"tag": "tag", "period": "period"}
_CT = {"cik10": "cik10", "tag": "tag"}
_C = {"cik10": "cik10"}
_YE = {"year": "year", "element": "element"}
_OBJ = {"object": "cw_object"}
_RULE = {"rule": "dq_rule"}

# Crosswalk objects (zetaris/sql/01_cw_fema_*.sql, 02_cw_stations_*.sql, 05_cw_seeds_*.sql, 06_cw_joinmap_select.sql).
FEMA_RAW = "CW_FEMA.declarations_dr_{quarter_slug}"
FEMA_VIEW = "cw.fema_declarations_dr_{quarter_slug}"
FEMA_CATALOGUE_RAW = "CW_FEMA.datasets_catalogue"
FEMA_CATALOGUE_VIEW = "cw.fema_catalogue"
STATIONS_RAW = "CW_GHCN.ghcnd_stations_txt"
STATIONS_VIEW = "cw.stations"
SEED_UTILITIES_VIEW = "cw.seed_utilities"
UTILITY_STATES_VIEW = "cw.utility_states"
SEED_STATIONS_VIEW = "cw.seed_stations"
STATES_VIEW = "cw.states"
SEED_NAMES_VIEW = "cw.seed_utility_names"  # zetaris/sql/08_cw_seed_names_create.sql: cik, name, ticker, sic of the 43 seeds
GHCN_RAW = "CW_GHCN.ghcn_{year}_{element_lc}"
GHCN_VIEW = "cw.ghcn_{year}_{element_lc}"
GHCN_PATH = "s3a://noaa-ghcn-pds/parquet/by_year/YEAR={year}/ELEMENT={element}/"
REVENUE_TAGS = ("Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RegulatedAndUnregulatedOperatingRevenue")
FEMA_COLUMNS = ("disaster_number, state, declaration_date, incident_type, declaration_title, declaration_type, "
                "fips_state_code, fips_county_code, designated_area")
FEMA_ENDPOINT = ("https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries?%24filter=declarationType%20eq%20%27DR%27"
                 "%20and%20declarationDate%20ge%20%27{quarter_start}%27%20and%20declarationDate%20lt%20%27{quarter_end}%27&%24top=1000")
_FQ = {"quarter": "fema_quarter"}
_NONE = {}
# The three CY2025Q1-style frames views of one period as one key set, LPAD applied to the integer cik.
_FRAMES_CIKS = " UNION ".join(
    f"SELECT DISTINCT LPAD(CAST(cik AS STRING), 10, '0') AS k FROM cw.frames_{t}_{{period}}"
    for t in ("Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RegulatedAndUnregulatedOperatingRevenue"))
_FRAMES_CIKS_NO_LPAD = " UNION ".join(
    f"SELECT DISTINCT CAST(cik AS STRING) AS k FROM cw.frames_{t}_{{period}}"
    for t in ("Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RegulatedAndUnregulatedOperatingRevenue"))
_FRAMES_LOCS = " UNION ".join(
    f"SELECT DISTINCT LPAD(CAST(cik AS STRING), 10, '0') AS cik, loc, SUBSTR(loc, 4, 2) AS loc_state FROM cw.frames_{t}_{{period}}"
    for t in ("Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RegulatedAndUnregulatedOperatingRevenue"))
_FRAMES_VIEWS_OF_PERIOD = tuple(
    f"cw.frames_{t}_{{period}}" for t in ("Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RegulatedAndUnregulatedOperatingRevenue"))
_MATCH = "SELECT COUNT(DISTINCT l.k) AS left_keys, COUNT(DISTINCT CASE WHEN r.k IS NOT NULL THEN l.k END) AS matched_keys"

# GHCN and the USL (zetaris/sql/07_cw_usl_*.sql, 09_cw_ghcn_*.sql).
USL = "lightning.metastore.crosswalk.crosswalk_usl"
USL_NAMESPACE = "lightning.metastore.crosswalk"
GHCN_VIEWS = ("cw.ghcn_2025_tmax", "cw.ghcn_2025_tmin", "cw.ghcn_2024_tmax", "cw.ghcn_2024_tmin")  # warm-up order
# The USL utility table is activated over the submission view of every seed (07_cw_usl_create.sql).
USL_UTILITY_VIEWS = tuple(SUBMISSION_VIEW.format(cik10=c) for c in SEED_CIKS)
# Tmean in F from the two GHCN values in tenths of a degree C, base 65 F (the sister entry's
# degree-day arithmetic, validated there against pyarrow to 0.01).
_TMEAN_F = "(((x.DATA_VALUE + n.DATA_VALUE) / 2.0) / 10.0 * 9.0 / 5.0 + 32)"
_DAYS_IN_QUARTER = "CASE {quarter} WHEN 1 THEN CASE WHEN {year} % 4 = 0 THEN 91 ELSE 90 END WHEN 2 THEN 91 ELSE 92 END"
# The answer's revenue: per cik the first tag with a fact in the period (Revenues, then RFC, then RUOR),
# each frames view referenced once (Lightning 2.4.3.1 resolves a view only once per statement).
_REVENUE_UNION = " UNION ALL ".join(
    f"SELECT LPAD(CAST(cik AS STRING), 10, '0') AS cik, '{t}' AS xbrl_tag, CAST(val AS DOUBLE) AS val, accn, {i} AS pri "
    f"FROM cw.frames_{t}_{{period}}" for i, t in enumerate(REVENUE_TAGS, start=1))
_INCIDENTS = ("Severe Storm", "Fire", "Flood")

TEMPLATES: dict[str, Template] = {
    t.id: t
    for t in [
        _t("select1", "SELECT 1 AS ok", {}, (), (), "Connectivity check."),
        _t("show_databases", "SHOW LIGHTNING DATABASES", {}, (), (), "The Lightning databases the instance holds."),
        # -- weather per station-quarter over the cached GHCN station views (09_cw_ghcn_*.sql; about 19 s per call) --
        _t(
            "weather_quarter",
            f"""SELECT x.ID AS station_id, {{year}} AS year, {{quarter}} AS quarter,
                SUM(GREATEST(0, 65 - {_TMEAN_F})) AS hdd,
                SUM(GREATEST(0, {_TMEAN_F} - 65)) AS cdd,
                COUNT(*) AS days_observed,
                {_DAYS_IN_QUARTER} AS days_in_quarter,
                COUNT(*) / CAST({_DAYS_IN_QUARTER} AS DOUBLE) AS coverage
                FROM cw.ghcn_{{year}}_tmax x
                JOIN cw.ghcn_{{year}}_tmin n ON n.ID = x.ID AND n.DATE = x.DATE
                WHERE x.ID IN ({{station_list}})
                AND CAST(substr(x.DATE, 5, 2) AS INT) BETWEEN 3 * {{quarter}} - 2 AND 3 * {{quarter}}
                AND (x.Q_FLAG IS NULL OR x.Q_FLAG = '')
                AND (n.Q_FLAG IS NULL OR n.Q_FLAG = '')
                GROUP BY x.ID ORDER BY x.ID""",
            {"year": "year", "quarter": "quarter", "station_list": "station_list"},
            ("cw.ghcn_{year}_tmax", "cw.ghcn_{year}_tmin"), ("cw.ghcn_{year}_tmax", "cw.ghcn_{year}_tmin"),
            "HDD, CDD, days observed and coverage per station for one quarter, computed in Lightning SQL over the "
            "cached station-filtered GHCN views (TMAX joined to TMIN on ID and DATE; quality-flagged days dropped).",
        ),
        # -- discovery probes over one manifest view (probe_source): columns, five rows, key-column counts ---------
        _t("describe_object", "DESCRIBE {object}", _OBJ, ("{object}",), ("{object}",),
           "Columns and types of one cw.* view that zetaris/manifest.json lists (DESCRIBE)."),
        _t("sample_rows", "SELECT * FROM {object} LIMIT 5", _OBJ, ("{object}",), ("{object}",),
           "Five rows of one cw.* manifest view, every column (the shape probe)."),
        _t("distinct_counts",
           "SELECT COUNT(*) AS row_count, COUNT(DISTINCT {column}) AS distinct_values, COUNT({column}) AS non_null, "
           "COUNT({column}) / CAST(COUNT(*) AS DOUBLE) AS non_null_share FROM {object}",
           {"object": "cw_object", "column": "column"}, ("{object}",), ("{object}",),
           "Rows, distinct values, non-null values and the non-null share of one column of a cw.* manifest view "
           "(a candidate key column of probe_source)."),
        # -- frames (cw.frames_<tag>_<period>) -------------------------------------------------------------------------
        _t("frames_period", f"SELECT {FRAMES_COLUMNS} FROM {FRAMES_VIEW} ORDER BY cik", _TP, (FRAMES_VIEW,), (FRAMES_VIEW,),
           "Every fact in one frames period: cik, entityName, loc, start, end, val, accn (the HTTP reply holds the first 200 rows; row_count is the total)."),
        _t("frames_count", f"SELECT COUNT(*) AS n FROM {FRAMES_VIEW}", _TP, (FRAMES_VIEW,), (FRAMES_VIEW,),
           "Facts in one frames period (compare with the source response's data length)."),
        _t("frames_fact", f"SELECT {FRAMES_COLUMNS} FROM {FRAMES_VIEW} WHERE LPAD(CAST(cik AS STRING), 10, '0') = '{{cik10}}'",
           {**_TP, "cik10": "cik10"}, (FRAMES_VIEW,), (FRAMES_VIEW,),
           "One filer's fact in a frames period (frames carry cik as an integer; LPAD makes the 10-digit key)."),
        # -- SEC submissions: the filer's profile ---------------------------------------------------
        _t("submission", f"SELECT {SUBMISSION_COLUMNS} FROM {SUBMISSION_VIEW}", _C, (SUBMISSION_VIEW,), (SUBMISSION_VIEW,),
           "A filer's cik, name, sic, sicDescription and business state (no street fields)."),
        # -- SIC reference (company_dns V4) ----------------------------------------------------------
        _t("sic", f"SELECT {SIC_COLUMNS} FROM {SIC_VIEW} WHERE code = '{{code}}'", {"code": "sic"}, (SIC_VIEW,), (SIC_VIEW,),
           "One SIC code with its description, division (letter) and major group (2-digit)."),
        # -- the answer (question path; cached views only, sub-second) -------------------------------------------------
        _t("seed_utility_names", f"SELECT cik, name, ticker, sic FROM {SEED_NAMES_VIEW} ORDER BY cik", {}, (SEED_NAMES_VIEW,), (SEED_NAMES_VIEW,),
           "The 43 seed utilities' 10-digit cik, name, ticker and SIC from the cached VALUES view of seeds/utilities.json "
           "(never cw.seed_utilities, which resolves 43 submission views on every read)."),
        _t("answer_fema_utilities",
           f"SELECT us.cik, n.name, n.ticker, us.state, f.declarations, f.severe_storm, f.fire, f.flood, f.other_incidents "
           f"FROM {UTILITY_STATES_VIEW} us JOIN (SELECT state, COUNT(DISTINCT disaster_number) AS declarations, "
           + ", ".join(f"COUNT(DISTINCT CASE WHEN incident_type = '{i}' THEN disaster_number END) AS {i.lower().replace(' ', '_')}"
                       for i in _INCIDENTS)
           + ", COUNT(DISTINCT CASE WHEN incident_type NOT IN ("
           + ", ".join(f"'{i}'" for i in _INCIDENTS)
           + f") THEN disaster_number END) AS other_incidents FROM {FEMA_VIEW} GROUP BY state) f ON f.state = us.state "
           f"JOIN {SEED_NAMES_VIEW} n ON n.cik = us.cik ORDER BY f.declarations DESC, n.name, us.state",
           {"quarter": "fema_quarter"}, (UTILITY_STATES_VIEW, FEMA_VIEW, SEED_NAMES_VIEW), (UTILITY_STATES_VIEW, FEMA_VIEW, SEED_NAMES_VIEW),
           "One row per (seed utility, served state) whose state has at least one major-disaster (DR) declaration in the "
           "quarter: cik, name, ticker, state, declarations (distinct disaster_number) and their count by incident type "
           "(severe_storm, fire, flood, other_incidents); sorted by declarations descending, then name."),
        _t("answer_revenue",
           f"SELECT cik, xbrl_tag, val, accn FROM (SELECT cik, xbrl_tag, val, accn, ROW_NUMBER() OVER (PARTITION BY cik ORDER BY pri) AS rn "
           f"FROM ({_REVENUE_UNION}) u WHERE u.cik IN ({{cik_list}})) r WHERE rn = 1 ORDER BY cik",
           {"period": "period", "cik_list": "cik_list"}, _FRAMES_VIEWS_OF_PERIOD, _FRAMES_VIEWS_OF_PERIOD,
           "Per cik in the list, the first revenue tag with a frames fact in the period (Revenues, then "
           "RevenueFromContractWithCustomerExcludingAssessedTax, then RegulatedAndUnregulatedOperatingRevenue): cik (10-digit), "
           "xbrl_tag, val (DOUBLE, USD), accn. A cik with no fact under any of the three tags is absent from the rows."),
        # -- the governed USL: table list, rules and model (each under 3 s live) ------------------------------------------
        _t("usl_tables", f"SHOW NAMESPACES OR TABLES IN {USL}", {}, (USL,), (),
           "The governed USL's tables (name, type, activated); row counts come from the onboarding DQ file."),
        _t("usl_dq_rules", f"LIST DQ USL {USL}", {}, (USL,), (),
           "The USL's data-quality rules: primary and foreign keys, each named after its column(s), with its table and type."),
        _t("usl_model", f"LOAD USL crosswalk_usl NAMESPACE {USL_NAMESPACE}", {}, (USL,), (),
           "The governed USL as JSON (tables, columns, keys, descriptions): what compile_usl diffs a rendered plan against."),
        # -- DQ per foreign-key rule (onboarding path only: 1 s to 2.5 min; never on the question path) ---------------------
        _t("dq_run", f"RUN DQ {{dq_name}} TABLE {USL}.{{dq_table}}", _RULE, (USL,), (),
           "Run one foreign-key rule <table>.<column> of the USL (with the PK rule of the same column): total, valid and "
           "invalid records. Onboarding only.", timeout_s=DQ_TIMEOUT_S, onboarding_only=True),
        _t("dq_invalid", f"SHOW DQ INVALID RECORD {{dq_name}} TABLE {USL}.{{dq_table}}", _RULE, (USL,), (),
           "The rows that fail one foreign-key rule <table>.<column> (utility.sic: MGE Energy, SIC 4900). Onboarding only.",
           timeout_s=DQ_TIMEOUT_S, onboarding_only=True),
        # -- Crosswalk reads (zetaris/sql/01, 02, 05, 06): FEMA declarations, the catalogue, the stations inventory --
        _t("fema_declarations", f"SELECT {FEMA_COLUMNS} FROM {FEMA_VIEW} ORDER BY disaster_number, fips_county_code",
           {"quarter": "fema_quarter"}, (FEMA_VIEW,), (FEMA_VIEW,),
           "Every major-disaster designated area declared in one calendar quarter (cached OpenFEMA view): disaster_number, state, "
           "declaration_date, incident_type, declaration_title, declaration_type, fips_state_code, fips_county_code, designated_area."),
        _t("fema_by_state", f"SELECT state, COUNT(*) AS designated_areas, COUNT(DISTINCT disaster_number) AS declarations "
           f"FROM {FEMA_VIEW} GROUP BY state ORDER BY state",
           {"quarter": "fema_quarter"}, (FEMA_VIEW,), (FEMA_VIEW,),
           "Designated areas and distinct declarations per state for one quarter's major disasters."),
        _t("catalogue_list", f"SELECT name, version, title, api_endpoint, last_dataset_refresh FROM {FEMA_CATALOGUE_VIEW} ORDER BY name, version",
           {}, (FEMA_CATALOGUE_VIEW,), (FEMA_CATALOGUE_VIEW,),
           "The OpenFEMA dataset catalogue (one row per dataset and version): the live part of search_catalogue."),
        _t("stations_lookup", f"SELECT id, state, name, latitude, longitude FROM {STATIONS_VIEW} WHERE id IN ({{ids}}) ORDER BY id",
           {"ids": "station_list"}, (STATIONS_VIEW,), (STATIONS_VIEW,),
           "Station id, state (columns 39-40 of ghcnd-stations.txt), name and coordinates for up to 60 GHCN station ids "
           "(the cached one-column CSV parsed with SUBSTR; about 8 s of filestore resolution per call)."),
        # -- the join map: match rate = matched distinct left keys / distinct left keys, over cached views only ------------
        _t("joinmap_cik", f"{_MATCH} FROM (SELECT DISTINCT cik AS k FROM {SEED_UTILITIES_VIEW}) l LEFT JOIN ({_FRAMES_CIKS}) r ON r.k = l.k",
           {"period": "period"}, (SEED_UTILITIES_VIEW,) + _FRAMES_VIEWS_OF_PERIOD, (SEED_UTILITIES_VIEW,) + _FRAMES_VIEWS_OF_PERIOD,
           "Key (a): seed submissions cik (10-digit string) vs frames cik under lpad10, over the three frames views of one period."),
        _t("joinmap_cik_orphans", f"SELECT u.cik AS orphan_cik, u.name FROM {SEED_UTILITIES_VIEW} u LEFT JOIN ({_FRAMES_CIKS}) r ON r.k = u.cik "
           f"WHERE r.k IS NULL ORDER BY u.cik LIMIT 10",
           {"period": "period"}, (SEED_UTILITIES_VIEW,) + _FRAMES_VIEWS_OF_PERIOD, (SEED_UTILITIES_VIEW,) + _FRAMES_VIEWS_OF_PERIOD,
           "Key (a) orphans: seed filers with no fact in the period under any of the three tags."),
        _t("joinmap_cik_control", f"{_MATCH} FROM (SELECT DISTINCT cik AS k FROM {SEED_UTILITIES_VIEW}) l LEFT JOIN ({_FRAMES_CIKS_NO_LPAD}) r ON r.k = l.k",
           {"period": "period"}, (SEED_UTILITIES_VIEW,) + _FRAMES_VIEWS_OF_PERIOD, (SEED_UTILITIES_VIEW,) + _FRAMES_VIEWS_OF_PERIOD,
           "Key (a) control: the same pair under identity (CAST(cik AS STRING), no LPAD); the integer cik never equals the zero-padded string."),
        _t("joinmap_loc", f"SELECT COUNT(DISTINCT l.cik) AS left_keys, COUNT(DISTINCT CASE WHEN l.loc_state = r.hq_state THEN l.cik END) AS matched_keys "
           f"FROM ({_FRAMES_LOCS}) l JOIN {SEED_UTILITIES_VIEW} r ON r.cik = l.cik",
           {"period": "period"}, (SEED_UTILITIES_VIEW,) + _FRAMES_VIEWS_OF_PERIOD, (SEED_UTILITIES_VIEW,) + _FRAMES_VIEWS_OF_PERIOD,
           "Key (b): frames loc US-XX under substr(4,2) vs the submissions business-address state, for the seed filers present in the period."),
        _t("joinmap_fema_state", f"{_MATCH} FROM (SELECT DISTINCT state AS k FROM {FEMA_VIEW}) l "
           f"LEFT JOIN (SELECT DISTINCT state AS k FROM {UTILITY_STATES_VIEW}) r ON r.k = l.k",
           {"quarter": "fema_quarter"}, (FEMA_VIEW, UTILITY_STATES_VIEW), (FEMA_VIEW, UTILITY_STATES_VIEW),
           "Key (c): FEMA state (two letters) vs the seed utilities' served states under identity."),
        _t("joinmap_fema_state_orphans", f"SELECT l.k AS orphan_state FROM (SELECT DISTINCT state AS k FROM {FEMA_VIEW}) l "
           f"LEFT JOIN (SELECT DISTINCT state AS k FROM {UTILITY_STATES_VIEW}) r ON r.k = l.k WHERE r.k IS NULL ORDER BY l.k LIMIT 10",
           {"quarter": "fema_quarter"}, (FEMA_VIEW, UTILITY_STATES_VIEW), (FEMA_VIEW, UTILITY_STATES_VIEW),
           "Key (c) orphans: FEMA states no seed utility serves."),
        _t("joinmap_fema_fips", f"{_MATCH} FROM (SELECT DISTINCT fips_state_code AS k FROM {FEMA_VIEW}) l "
           f"LEFT JOIN (SELECT DISTINCT fips AS k FROM {STATES_VIEW}) r ON r.k = l.k",
           {"quarter": "fema_quarter"}, (FEMA_VIEW, STATES_VIEW), (FEMA_VIEW, STATES_VIEW),
           "Key (c, FIPS): FEMA fipsStateCode vs the state reference FIPS (two-digit strings) under identity."),
        _t("joinmap_station", f"SELECT COUNT(DISTINCT l.k) AS left_keys, COUNT(DISTINCT CASE WHEN r.id IS NOT NULL THEN l.k END) AS matched_keys, "
           f"COUNT(DISTINCT CASE WHEN r.state = l.state THEN l.k END) AS state_equal "
           f"FROM (SELECT DISTINCT id AS k, state FROM {SEED_STATIONS_VIEW}) l LEFT JOIN {STATIONS_VIEW} r ON r.id = l.k",
           {}, (SEED_STATIONS_VIEW, STATIONS_VIEW), (SEED_STATIONS_VIEW, STATIONS_VIEW),
           "Key (d): seed station id vs the stations inventory id under identity, with the count of matched stations whose state agrees."),
        _t("joinmap_sic", f"{_MATCH}, COUNT(DISTINCT l.cik) AS left_rows, COUNT(DISTINCT CASE WHEN r.k IS NOT NULL THEN l.cik END) AS matched_rows "
           f"FROM (SELECT cik, sic AS k FROM {SEED_UTILITIES_VIEW}) l LEFT JOIN (SELECT DISTINCT code AS k FROM {SIC_VIEW}) r ON r.k = l.k",
           {}, (SEED_UTILITIES_VIEW, SIC_VIEW), (SEED_UTILITIES_VIEW, SIC_VIEW),
           "Key (e): submissions SIC vs sic_codes.code under identity, as distinct codes (left_keys) and as utilities (left_rows)."),
        _t("joinmap_sic_orphans", f"SELECT l.sic AS orphan_sic, l.cik, l.name FROM {SEED_UTILITIES_VIEW} l "
           f"LEFT JOIN (SELECT DISTINCT code AS k FROM {SIC_VIEW}) r ON r.k = l.sic WHERE r.k IS NULL ORDER BY l.sic, l.cik LIMIT 10",
           {}, (SEED_UTILITIES_VIEW, SIC_VIEW), (SEED_UTILITIES_VIEW, SIC_VIEW),
           "Key (e) orphans: seed utilities whose SIC the reference lacks (MGE Energy, 4900)."),
        # -- registrar templates: only inside a plan (POST /registrar/<action>) ----------------------
        _t("registrar_ghcn_table",
           f'CREATE LIGHTNING FILESTORE TABLE ghcn_{{year}}_{{element_lc}} FROM CW_GHCN FORMAT PARQUET OPTIONS ( PATH "{GHCN_PATH}", '
           f'inferSchema "true", isS3BucketPublic "true", useS3PathStyleAccess "true", s3Endpoint "s3.us-east-1.amazonaws.com" )',
           _YE, (GHCN_RAW,), (), "One GHCN-Daily year and element (9 parquet files, every station worldwide) as a filestore table.", "registrar"),
        _t("registrar_ghcn_view",
           f"CREATE SCHEMASTORE VIEW ghcn_{{year}}_{{element_lc}} WITH CONTAINER cw AS SELECT ID, DATE, DATA_VALUE, M_FLAG, Q_FLAG, S_FLAG, OBS_TIME "
           f"FROM {GHCN_RAW} WHERE ID IN ({GHCN_STATIONS_SQL})",
           _YE, (GHCN_VIEW,), (GHCN_RAW,),
           f"The {len(GHCN_STATIONS)} station ids of seeds/stations.json plus the validation station, filtered from the year's parquet.",
           "registrar"),
        _t("registrar_ghcn_describe", f"DESCRIBE {GHCN_VIEW}", _YE, (GHCN_VIEW,), (), "Columns of the GHCN station view."),
        _t("registrar_ghcn_cache", f"CACHE TABLE {GHCN_VIEW}", _YE, (GHCN_VIEW,), (GHCN_VIEW,),
           "Cache the station view (one scan of the 9 parquet files).", "registrar"),
        _t("registrar_fema_table",
           f'CREATE LIGHTNING REST TABLE declarations_dr_{{quarter_slug}} FROM CW_FEMA REQUEST( endpoint "{FEMA_ENDPOINT}", {REST_REQUEST_TAIL}',
           {"quarter": "fema_quarter"}, (FEMA_RAW,), (), "One quarter of FEMA major-disaster declarations as a raw REST table (filter percent-encoded).", "registrar"),
        _t("registrar_fema_view",
           f"CREATE SCHEMASTORE VIEW fema_declarations_dr_{{quarter_slug}} WITH CONTAINER cw AS SELECT d.`disasterNumber` AS disaster_number, "
           f"d.state AS state, d.`declarationDate` AS declaration_date, d.`incidentType` AS incident_type, d.`declarationTitle` AS declaration_title, "
           f"d.`declarationType` AS declaration_type, d.`fipsStateCode` AS fips_state_code, d.`fipsCountyCode` AS fips_county_code, "
           f"d.`designatedArea` AS designated_area FROM {FEMA_RAW} LATERAL VIEW explode(`DisasterDeclarationsSummaries`) AS d",
           {"quarter": "fema_quarter"}, (FEMA_VIEW,), (FEMA_RAW,), "The declarations exploded, one row per designated area.", "registrar"),
        _t("registrar_fema_describe", f"DESCRIBE {FEMA_VIEW}", {"quarter": "fema_quarter"}, (FEMA_VIEW,), (), "Columns of the FEMA view."),
        _t("registrar_fema_cache", f"CACHE TABLE {FEMA_VIEW}", {"quarter": "fema_quarter"}, (FEMA_VIEW,), (FEMA_VIEW,), "Cache the FEMA view.", "registrar"),
        _t("registrar_stations_table",
           f'CREATE LIGHTNING FILESTORE TABLE ghcnd_stations_txt FROM CW_GHCN FORMAT CSV OPTIONS ( PATH "s3a://noaa-ghcn-pds/ghcnd-stations.txt", '
           f'delimiter "|", quote "", header "false", inferSchema "false", isS3BucketPublic "true", useS3PathStyleAccess "true", s3Endpoint "s3.us-east-1.amazonaws.com" )',
           {}, (STATIONS_RAW,), (), "The GHCN station inventory as a one-column CSV (a delimiter that never occurs in the file).", "registrar"),
        _t("registrar_stations_view",
           f"CREATE SCHEMASTORE VIEW stations WITH CONTAINER cw AS SELECT SUBSTR(_c0, 1, 11) AS id, SUBSTR(_c0, 39, 2) AS state, "
           f"TRIM(SUBSTR(_c0, 42, 30)) AS name, CAST(TRIM(SUBSTR(_c0, 13, 8)) AS DOUBLE) AS latitude, CAST(TRIM(SUBSTR(_c0, 22, 9)) AS DOUBLE) AS longitude "
           f"FROM {STATIONS_RAW}",
           {}, (STATIONS_VIEW,), (STATIONS_RAW,), "The inventory parsed with SUBSTR (1-based spans from readme.txt).", "registrar"),
        _t("registrar_stations_describe", f"DESCRIBE {STATIONS_VIEW}", {}, (STATIONS_VIEW,), (), "Columns of the stations view."),
        _t("registrar_stations_cache", f"CACHE TABLE {STATIONS_VIEW}", {}, (STATIONS_VIEW,), (STATIONS_VIEW,), "Cache the stations view (one S3 scan).", "registrar"),
        _t("registrar_frames_table",
           f'CREATE LIGHTNING REST TABLE frames_{{tag}}_{{period}} FROM CW_SEC REQUEST( '
           f'endpoint "https://data.sec.gov/api/xbrl/frames/us-gaap/{{tag}}/USD/{{period}}.json", {REST_REQUEST_TAIL}',
           _TP, (FRAMES_RAW,), (), "One SEC frames period as a raw REST table.", "registrar"),
        _t("registrar_frames_view",
           f"CREATE SCHEMASTORE VIEW frames_{{tag}}_{{period}} WITH CONTAINER cw AS SELECT f.cik AS cik, f.`entityName` AS `entityName`, "
           f"f.loc AS loc, f.`start` AS `start`, f.`end` AS `end`, f.val AS val, f.accn AS accn FROM {FRAMES_RAW} LATERAL VIEW explode(data) AS f",
           _TP, (FRAMES_VIEW,), (FRAMES_RAW,), "The frames period flattened (LATERAL VIEW explode(data)).", "registrar"),
        _t("registrar_frames_describe", f"DESCRIBE {FRAMES_VIEW}", _TP, (FRAMES_VIEW,), (), "Columns of the frames view."),
        _t("registrar_frames_cache", f"CACHE TABLE {FRAMES_VIEW}", _TP, (FRAMES_VIEW,), (FRAMES_VIEW,), "Cache the frames view.", "registrar"),
        _t("registrar_concept_table",
           f'CREATE LIGHTNING REST TABLE concept_{{cik10}}_{{tag}} FROM CW_SEC REQUEST( '
           f'endpoint "https://data.sec.gov/api/xbrl/companyconcept/CIK{{cik10}}/us-gaap/{{tag}}.json", {REST_REQUEST_TAIL}',
           _CT, (CONCEPT_RAW,), (), "One filer's companyconcept history for one tag as a raw REST table.", "registrar"),
        _t("registrar_concept_view",
           f"CREATE SCHEMASTORE VIEW concept_{{cik10}}_{{tag}} WITH CONTAINER cw AS SELECT f.fy AS fy, f.fp AS fp, f.form AS form, "
           f"f.filed AS filed, f.accn AS accn, f.`start` AS `start`, f.`end` AS `end`, f.val AS val FROM {CONCEPT_RAW} LATERAL VIEW explode(units.USD) AS f",
           _CT, (CONCEPT_VIEW,), (CONCEPT_RAW,), "The companyconcept USD facts flattened (LATERAL VIEW explode(units.USD)).", "registrar"),
        _t("registrar_concept_describe", f"DESCRIBE {CONCEPT_VIEW}", _CT, (CONCEPT_VIEW,), (), "Columns of the concept view."),
        _t("registrar_concept_cache", f"CACHE TABLE {CONCEPT_VIEW}", _CT, (CONCEPT_VIEW,), (CONCEPT_VIEW,), "Cache the concept view.", "registrar"),
        _t("registrar_submission_table",
           f'CREATE LIGHTNING REST TABLE submissions_{{cik10}} FROM CW_SEC REQUEST( '
           f'endpoint "https://data.sec.gov/submissions/CIK{{cik10}}.json", {REST_REQUEST_TAIL}',
           _C, (SUBMISSIONS_RAW,), (), "One filer's submissions profile as a raw REST table.", "registrar"),
        _t("registrar_submission_view",
           f"CREATE SCHEMASTORE VIEW submission_{{cik10}} WITH CONTAINER cw AS SELECT cik AS cik, name AS name, sic AS sic, "
           f"`sicDescription` AS `sicDescription`, addresses.business.`stateOrCountry` AS state FROM {SUBMISSIONS_RAW}",
           _C, (SUBMISSION_VIEW,), (SUBMISSIONS_RAW,), "The profile scalars only: cik, name, sic, sicDescription, business state.", "registrar"),
        _t("registrar_submission_describe", f"DESCRIBE {SUBMISSION_VIEW}", _C, (SUBMISSION_VIEW,), (), "Columns of the submission view."),
        _t("registrar_submission_cache", f"CACHE TABLE {SUBMISSION_VIEW}", _C, (SUBMISSION_VIEW,), (SUBMISSION_VIEW,), "Cache the submission view.", "registrar"),
    ]
}


def _plan(action: str, params: dict[str, str], prefix: str, description: str) -> Plan:
    """Raw REST table -> flattened view -> DESCRIBE -> CACHE. The two CREATEs treat "already
    exists" as done, so re-registering a period the instance already holds only re-caches it."""
    return Plan(action, params, (Step(f"{prefix}_table", skip_exists=True), Step(f"{prefix}_view", skip_exists=True),
                                 Step(f"{prefix}_describe"), Step(f"{prefix}_cache", timeout_s=600.0)), description)


REGISTRAR_PLANS: dict[str, Plan] = {
    p.action: p
    for p in [
        _plan("register_frames", _TP, "registrar_frames",
              "Register one SEC frames period (tag, period): raw REST table, flattened view, DESCRIBE, CACHE. One SEC request per CREATE/CACHE."),
        _plan("register_concept", _CT, "registrar_concept",
              "Register one filer's companyconcept history (cik10, tag): raw REST table, flattened view, DESCRIBE, CACHE."),
        _plan("register_submission", _C, "registrar_submission",
              "Register one filer's submissions profile (cik10): raw REST table, scalar view, DESCRIBE, CACHE."),
        _plan("register_fema", _FQ, "registrar_fema",
              "Register one calendar quarter of FEMA major-disaster declarations (quarter CY<yyyy>Q<n>): raw REST table, exploded view, DESCRIBE, CACHE."),
        _plan("register_stations", _NONE, "registrar_stations",
              "Register the GHCN station inventory ghcnd-stations.txt: one-column CSV filestore table, SUBSTR view, DESCRIBE, CACHE."),
        _plan("register_ghcn", _YE, "registrar_ghcn",
              "Register one GHCN-Daily year and element (year, element TMAX | TMIN): parquet filestore table, station-filtered view, "
              "DESCRIBE, CACHE (about 40 s for the CACHE)."),
    ]
}

# register_source: a catalogue id of seeds/catalogue.json -> the registrar plan that registers it. The agent names
# the source it found (search_catalogue) and the plan's parameters; it never names a statement. Catalogue entries
# not listed here (the catalogues, sec_companyconcept, the known_to_fail pudl, the USL) cannot be registered.
REGISTER_SOURCE = "register_source"
SOURCE_PLANS: dict[str, str] = {
    "openfema_disaster_declarations": "register_fema",
    "noaa_ghcn_stations": "register_stations",
    "sec_frames": "register_frames",
    "sec_submissions": "register_submission",
    "noaa_ghcn_by_year": "register_ghcn",
}
CATALOGUE_PATH = Path(__file__).resolve().parent.parent / "seeds" / "catalogue.json"


def catalogue_entries(path: Path = CATALOGUE_PATH) -> dict[str, dict]:
    """seeds/catalogue.json entries by id (read per call: lane edits to statuses apply without a restart)."""
    return {e["id"]: e for e in json.loads(path.read_text(encoding="utf-8"))["entries"]}


def registrar_actions() -> tuple[str, ...]:
    """Every action POST /registrar/<action> accepts: the plans plus the register_source dispatch."""
    return tuple(sorted(REGISTRAR_PLANS)) + (REGISTER_SOURCE,)


def cache_targets_for(frames: list[tuple[str, str]], concepts: list[tuple[str, str]], submissions: list[str]) -> tuple[str, ...]:
    """The cached view names the warm-up keeps in the driver, from (tag, period), (cik10, tag) and cik10 lists."""
    out = [FRAMES_VIEW.format(tag=t, period=p) for t, p in frames]
    out += [CONCEPT_VIEW.format(cik10=c, tag=t) for c, t in concepts]
    out += [SUBMISSION_VIEW.format(cik10=c) for c in submissions]
    return tuple(out + [SIC_VIEW])


def validate_param(kind: str, value: object) -> str:
    if kind not in PARAM_PATTERNS:
        raise BadParams(f"unknown parameter kind: {kind}")
    if not isinstance(value, str):
        raise BadParams(f"{kind} must be a string")
    if not PARAM_PATTERNS[kind].fullmatch(value):  # fullmatch: "$" alone would let a trailing newline through
        raise BadParams(f"invalid {kind}: {value[:40]!r}")
    if kind in CHECKS:
        CHECKS[kind](value)
    return value


def render(template_id: str, params: dict | None) -> tuple[Template, str]:
    """The template and its SQL with validated parameters substituted."""
    t = TEMPLATES.get(template_id)
    if t is None:
        raise BadParams(f"unknown template: {template_id}")
    params = params or {}
    extra = set(params) - set(t.params)
    missing = set(t.params) - set(params)
    if extra or missing:
        raise BadParams(f"template {template_id} takes {sorted(t.params)}; missing {sorted(missing)}, unexpected {sorted(extra)}")
    values = {name: validate_param(kind, params[name]) for name, kind in t.params.items()}
    sql = t.sql
    for name, value in values.items():
        sql = sql.replace("{" + name + "}", RENDERERS.get(t.params[name], lambda v: v)(value))
        for extra, rendered in DERIVED.get(t.params[name], lambda v: {})(value).items():
            sql = sql.replace("{" + extra + "}", rendered)
    return t, sql


def resolved_params(t: Template, params: dict | None) -> dict[str, str]:
    """The request parameters plus the placeholders DERIVED from them, so that object names such as
    cw.fema_declarations_dr_{quarter_slug} resolve the same way the SQL does."""
    out = dict(params or {})
    for name, kind in t.params.items():
        if name in out and kind in DERIVED:
            out.update(DERIVED[kind](validate_param(kind, out[name])))
    return out


def plan_params(plan: Plan, body: dict) -> dict[str, str]:
    """The plan's parameters taken from a request body and validated; BadParams otherwise."""
    return {name: validate_param(kind, body.get(name)) for name, kind in plan.params.items()}
