"""Named templates. The agent sends a template id and parameters, never SQL.

Adapted from Weather-or-Not and ClearShelf (same author, Apache-2.0).

Parameters are validated by regex before they are substituted, so a value can only ever be
a 10-digit CIK, one of three revenue tags, a CY frame period, a year, a quarter number, a
GHCN station id or a GHCN element. Reader templates run through POST /sql/template. A
registrar plan (REGISTRAR_PLANS) is a short ordered list of registrar templates that
POST /registrar/<action> runs under an execution contract (gateway/registrar.py), for
example the frames table + view + cache of a period the agent has not registered yet.

Inherited from Weather-or-Not (same author): the reader templates below are that entry's question-specific reads
(frames_*, concept_*, submission, sic, weather_quarter, usl_*, dq_*); the Day-1 Crosswalk lane replaces them with the
discovery reads (catalogue, DESCRIBE/probe, match-rate over cached views, USL compile and DQ). The registrar plans
register_frames / register_concept / register_submission stay. Reference SQL: zetaris/sql/won-reference/.

SEC objects (reference: won-reference/01_won_sec_*.sql, 02_won_dns_*.sql, 03_won_frames_runtime_template.sql,
06_won_sec_seeds_*.sql): raw REST tables CW_SEC.frames_<tag>_<period>, CW_SEC.concept_<cik10>_<tag>,
CW_SEC.submissions_<cik10>, CW_DNS.sic_codes_v4_raw; flattened, cached SchemaStore views
cw.frames_<tag>_<period>, cw.concept_<cik10>_<tag>, cw.submission_<cik10>, cw.sic_codes.
frames_seeds filters a frames period to the seed utilities (SEED_CIKS, read from seeds/utilities.json
at import), so the peer universe comes back in one reply under the gateway's row cap.
The User-Agent in a REST statement is the placeholder YOUR_APP_NAME YOUR_CONTACT_EMAIL, filled
from CW_USER_AGENT on the wire only (gateway/jdbc.py apply_user_agent); it is never a literal
here or in a committed SQL file.

GHCN and USL (reference: won-reference/04_won_ghcn_*.sql, 05_won_usl_*.sql): weather_quarter computes degree
days in Lightning SQL over the cached station views cw.ghcn_<year>_<element> for a quoted
station list (the station_list kind, rendered by RENDERERS); usl_describe, dq_invalid and
dq_run_coverage read the USL lightning.metastore.crosswalk.crosswalk_usl.
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
}

# How a validated value is written into the SQL. A kind not listed here is substituted as is;
# a station_list becomes a quoted IN list ('USW00013740', 'USW00013722').
RENDERERS = {
    "station_list": lambda v: ", ".join(f"'{s}'" for s in v.split(",")),
}


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


# Placeholders derived from a validated value (kind -> function); render() substitutes them too.
DERIVED = {"fema_quarter": fema_quarter_bounds}


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
       description: str, role: str = "reader", timeout_s: float | None = None) -> Template:
    return Template(id, " ".join(sql.split()), params, objects, raw, description, role, timeout_s)


# A read of a USL table activated over the GHCN views, and RUN / SHOW DQ on it, materialise the
# table from the filestore sources again (live: REGISTER DQ 184 s, RUN DQ coverage_ok 361 s), so
# the DQ templates get a longer bound than the 60 s default.
DQ_TIMEOUT_S = 600.0


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
# frames `val` is inferred bigint for some periods and double for others: the seeds template casts it.
FRAMES_SEEDS_COLUMNS = "cik, `entityName`, loc, `start`, `end`, CAST(val AS DOUBLE) AS val, accn"
CONCEPT_COLUMNS = "fy, fp, form, filed, accn, `start`, `end`, val"
UTILITY_COLUMNS = "cik, name, ticker, sic, hq_state"
REVENUE_COLUMNS = "cik, xbrl_tag, year, quarter, val, accn, filed, is_comparative"
SUBMISSION_COLUMNS = "cik, name, sic, `sicDescription`, state"
SIC_COLUMNS = "code, description, division, division_desc, major_group, major_group_desc"

_TP = {"tag": "tag", "period": "period"}
_CT = {"cik10": "cik10", "tag": "tag"}
_C = {"cik10": "cik10"}

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
_FRAMES_LOCS = " UNION ".join(
    f"SELECT DISTINCT LPAD(CAST(cik AS STRING), 10, '0') AS cik, loc, SUBSTR(loc, 4, 2) AS loc_state FROM cw.frames_{t}_{{period}}"
    for t in ("Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RegulatedAndUnregulatedOperatingRevenue"))
_FRAMES_VIEWS_OF_PERIOD = tuple(
    f"cw.frames_{t}_{{period}}" for t in ("Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RegulatedAndUnregulatedOperatingRevenue"))
_MATCH = "SELECT COUNT(DISTINCT l.k) AS left_keys, COUNT(DISTINCT CASE WHEN r.k IS NOT NULL THEN l.k END) AS matched_keys"

# GHCN and the USL (reference SQL: zetaris/sql/won-reference/04_won_ghcn_*.sql, 05_won_usl_*.sql).
USL = "lightning.metastore.crosswalk.crosswalk_usl"
GHCN_VIEWS = ("cw.ghcn_2025_tmax", "cw.ghcn_2025_tmin", "cw.ghcn_2024_tmax", "cw.ghcn_2024_tmin")  # warm-up order
# The SEC-side USL tables are activated over cached REST views (05_won_usl_create.sql steps 6 to 8):
# utility over the submission view of every seed, revenue_quarter over the six frames views of the
# two comparison quarters. A read of them is answered from those caches.
USL_UTILITY_VIEWS = tuple(SUBMISSION_VIEW.format(cik10=c) for c in SEED_CIKS)
USL_REVENUE_VIEWS = tuple(
    FRAMES_VIEW.format(tag=t, period=p)
    for t in ("Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RegulatedAndUnregulatedOperatingRevenue")
    for p in ("CY2025Q1", "CY2024Q1"))
# Tmean in F from the two GHCN values in tenths of a degree C, in the evaluation order of
# agent/src/tools/degreeDays.ts so both paths round identically.
_TMEAN_F = "(((x.DATA_VALUE + n.DATA_VALUE) / 2.0) / 10.0 * 9.0 / 5.0 + 32)"
_DAYS_IN_QUARTER = "CASE {quarter} WHEN 1 THEN CASE WHEN {year} % 4 = 0 THEN 91 ELSE 90 END WHEN 2 THEN 91 ELSE 92 END"

TEMPLATES: dict[str, Template] = {
    t.id: t
    for t in [
        _t("select1", "SELECT 1 AS ok", {}, (), (), "Connectivity check."),
        _t("show_databases", "SHOW LIGHTNING DATABASES", {}, (), (), "The Lightning databases the instance holds."),
        # -- inherited; Day-1 lane replaces: weather_quarter (Weather-or-Not's degree days; reference 04_won_ghcn_*.sql) --
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
        # -- inherited; Day-1 lane replaces: usl_describe, dq_invalid, dq_run_coverage (reference 05_won_usl_*.sql) ---
        _t("usl_describe", "LOAD USL crosswalk_usl NAMESPACE lightning.metastore.crosswalk", {}, (USL,), (),
           "The USL model as JSON: tables, columns, keys and descriptions (the planner's map)."),
        # SHOW DQ ALL INVALID (every rule) materialises the table once per rule and did not return within
        # 900 s live; the single-rule form returned in 181 s, so the gate reads the coverage rule alone.
        _t("dq_invalid", f"SHOW DQ INVALID RECORD coverage_ok TABLE {USL}.weather_quarter", {}, (f"{USL}.weather_quarter",), GHCN_VIEWS,
           "Every weather_quarter row that fails the coverage_ok rule (coverage below 0.9); empty when the gate passes.",
           timeout_s=DQ_TIMEOUT_S),
        _t("dq_run_coverage", f"RUN DQ coverage_ok TABLE {USL}.weather_quarter", {}, (f"{USL}.weather_quarter",), GHCN_VIEWS,
           "Run the coverage_ok rule: total, valid and invalid counts.", timeout_s=DQ_TIMEOUT_S),
        # -- inherited; Day-1 lane replaces: frames_period, frames_count, frames_fact, frames_seeds -------------------
        _t("frames_period", f"SELECT {FRAMES_COLUMNS} FROM {FRAMES_VIEW} ORDER BY cik", _TP, (FRAMES_VIEW,), (FRAMES_VIEW,),
           "Every fact in one frames period: cik, entityName, loc, start, end, val, accn (the HTTP reply holds the first 200 rows; row_count is the total)."),
        _t("frames_count", f"SELECT COUNT(*) AS n FROM {FRAMES_VIEW}", _TP, (FRAMES_VIEW,), (FRAMES_VIEW,),
           "Facts in one frames period (compare with the source response's data length)."),
        _t("frames_fact", f"SELECT {FRAMES_COLUMNS} FROM {FRAMES_VIEW} WHERE LPAD(CAST(cik AS STRING), 10, '0') = '{{cik10}}'",
           {**_TP, "cik10": "cik10"}, (FRAMES_VIEW,), (FRAMES_VIEW,),
           "One filer's fact in a frames period (frames carry cik as an integer; LPAD makes the 10-digit key)."),
        # The peer universe in one call: the facts of the seed utilities (seeds/utilities.json) in a frames
        # period. At most one row per seed, so the reply is never cut at the gateway's 200-row cap.
        _t("frames_seeds", f"SELECT {FRAMES_SEEDS_COLUMNS} FROM {FRAMES_VIEW} WHERE CAST(cik AS BIGINT) IN ({SEED_CIK_INTS_SQL}) ORDER BY cik",
           _TP, (FRAMES_VIEW,), (FRAMES_VIEW,),
           f"The seed utilities' facts in one frames period ({len(SEED_CIKS)} CIKs from seeds/utilities.json compared as integers): "
           "cik, entityName, loc, start, end, val (cast to DOUBLE), accn. One row per seed filer present; never more than the seed count."),
        # -- inherited; Day-1 lane replaces: concept_history, concept_window --------------------------------------------
        _t("concept_history", f"SELECT {CONCEPT_COLUMNS} FROM {CONCEPT_VIEW} ORDER BY `end`, filed, accn", _CT, (CONCEPT_VIEW,), (CONCEPT_VIEW,),
           "Every USD fact a filer reported for one tag, across filings: fy, fp, form, filed, accn, start, end, val."),
        # The like-for-like window: the facts whose period ends in a year or the year before (the current
        # quarter and the previous quarter in every filing that reports them). A long history is cut at the
        # gateway's 200-row cap in concept_history (AEP Revenues holds 304 facts), so the agent reads this.
        _t("concept_window",
           f"SELECT {CONCEPT_COLUMNS} FROM {CONCEPT_VIEW} WHERE CAST(substr(`end`, 1, 4) AS INT) BETWEEN {{year}} - 1 AND {{year}} ORDER BY `end`, filed, accn",
           {**_CT, "year": "year"}, (CONCEPT_VIEW,), (CONCEPT_VIEW,),
           "One filer's USD facts for one tag whose period end falls in the given year or the year before, across filings "
           "(fy, fp, form, filed, accn, start, end, val): the like-for-like window, always under the gateway row cap."),
        # -- SEC submissions: the filer's profile ---------------------------------------------------
        _t("submission", f"SELECT {SUBMISSION_COLUMNS} FROM {SUBMISSION_VIEW}", _C, (SUBMISSION_VIEW,), (SUBMISSION_VIEW,),
           "A filer's cik, name, sic, sicDescription and business state (no street fields)."),
        # -- SIC reference (company_dns V4) ----------------------------------------------------------
        _t("sic", f"SELECT {SIC_COLUMNS} FROM {SIC_VIEW} WHERE code = '{{code}}'", {"code": "sic"}, (SIC_VIEW,), (SIC_VIEW,),
           "One SIC code with its description, division (letter) and major group (2-digit)."),
        # -- the governed copies in the USL (keys, descriptions, DQ rules) -------------------------
        # The USL layer visits each of the 43 source views on every read (live 45 s on Day 0, 141 s on Day 1), so this is the governed
        # copy for the evidence drawer, not the hot path: submission(cik10) answers the same profile in 0.2 s.
        _t("usl_utility", f"SELECT {UTILITY_COLUMNS} FROM {USL}.utility WHERE cik = '{{cik10}}'", _C, (f"{USL}.utility",), USL_UTILITY_VIEWS,
           "One seed utility from the USL utility table (cik, name, ticker, sic, hq_state; sic is the FK to sic_code). "
           "Slow (45 s to about 2.5 min measured): the governed copy, not the hot path.", timeout_s=300.0),
        _t("usl_revenue",
           f"SELECT {REVENUE_COLUMNS} FROM {USL}.revenue_quarter WHERE cik = '{{cik10}}' "
           f"AND CONCAT('CY', CAST(year AS STRING), 'Q', CAST(quarter AS STRING)) = '{{period}}' ORDER BY xbrl_tag, accn",
           {"cik10": "cik10", "period": "period"}, (f"{USL}.revenue_quarter",), USL_REVENUE_VIEWS,
           "One filer's revenue facts for one calendar quarter from the USL revenue_quarter table, every tag it reported under "
           "(val as DOUBLE, accn of the filing frames served, is_comparative when that filing is later than the period's year)."),
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
        # -- DQ on the Crosswalk USL: the FK rule sic on utility (expect one invalid row, MGE Energy) ---------------------
        _t("dq_run_sic", f"RUN DQ sic TABLE {USL}.utility", {}, (f"{USL}.utility",), (SEED_UTILITIES_VIEW, SIC_VIEW),
           "Run the FK rule utility.sic -> sic_code.sic: total, valid and invalid counts.", timeout_s=DQ_TIMEOUT_S),
        _t("dq_invalid_sic", f"SHOW DQ INVALID RECORD sic TABLE {USL}.utility", {}, (f"{USL}.utility",), (SEED_UTILITIES_VIEW, SIC_VIEW),
           "Every utility row that fails the FK rule sic (the SIC orphans).", timeout_s=DQ_TIMEOUT_S),
        # -- registrar templates: only inside a plan (POST /registrar/<action>) ----------------------
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
    ]
}


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
    if not PARAM_PATTERNS[kind].match(value):
        raise BadParams(f"invalid {kind}: {value[:40]!r}")
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


def plan_params(plan: Plan, body: dict) -> dict[str, str]:
    """The plan's parameters taken from a request body and validated; BadParams otherwise."""
    return {name: validate_param(kind, body.get(name)) for name, kind in plan.params.items()}
