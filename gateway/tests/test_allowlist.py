import pytest

from gateway import allowlist
from gateway.allowlist import Refused, check

U = allowlist.USL  # lightning.metastore.crosswalk.crosswalk_usl
NS = allowlist.NAMESPACE

FRAMES = "https://data.sec.gov/api/xbrl/frames/us-gaap/Revenues/USD/CY2025Q1.json"
CONCEPT = "https://data.sec.gov/api/xbrl/companyconcept/CIK0001326160/us-gaap/Revenues.json"
SUBMISSIONS = "https://data.sec.gov/submissions/CIK0001326160.json"
DNS = "https://company-dns.mediumroast.io/V4.0/sic/description/electric"
GHCN = "s3a://noaa-ghcn-pds/parquet/by_year/YEAR=2025/ELEMENT=TMAX/"


def rest(url: str, db: str = "CW_SEC", tail: str = "") -> str:
    return (f'CREATE LIGHTNING REST TABLE t1 FROM {db} REQUEST( endpoint "{url}", method "get", '
            f'response_type "json", http_encoding "URLENCODED" ) HEADER ( user-agent "Crosswalk/0.1 test" ) BODY (){tail}')


def filestore(path: str, db: str = "CW_GHCN", fmt: str = "PARQUET", extra: str = "") -> str:
    return (f'CREATE LIGHTNING FILESTORE TABLE ghcn_2025_tmax FROM {db} FORMAT {fmt} OPTIONS ( PATH "{path}", '
            f'inferSchema "true", isS3BucketPublic "true", useS3PathStyleAccess "true", '
            f's3Endpoint "s3.us-east-1.amazonaws.com"{extra} )')


@pytest.mark.parametrize("sql", [
    "SELECT 1",
    "SELECT cik, val FROM cw.frames_revenues_cy2025q1 WHERE cik = 1326160",
    "SHOW LIGHTNING DATABASES",
    "SHOW TABLES IN CW_SEC",
    "SHOW CACHE TABLES",
    "DESCRIBE CW_GHCN.ghcn_2025_tmax",
    f"LOAD USL crosswalk_usl NAMESPACE {NS}",
    f"LIST DQ USL {U}",
    f"RUN DQ coverage_ok TABLE {U}.weather_quarter",
    f"SHOW DQ INVALID RECORD coverage_ok TABLE {U}.weather_quarter",
    f"SHOW DQ ALL INVALID TABLE {U}.weather_quarter",
])
def test_reader_reads(sql):
    assert check(sql, "reader") == "read"


@pytest.mark.parametrize("sql", [
    "DROP LIGHTNING DATABASE CW_SEC",
    "drop view cw.frames_revenues_cy2025q1",
    "GRANT SELECT ON x TO y",
    "REVOKE USER a FROM ROLE b",
    "INVALIDATE CACHE",
    'OFFSITE CACHE TABLE cw.frames_revenues_cy2025q1 TO MEMORY WITH (expireInSec "-1")',
    "SELECT 1;",
    "SELECT 1; SELECT 2",
    "SELECT * FROM x WHERE url = 'http://localhost:8889/'",
    "",
])
def test_always_refused(sql):
    for role in allowlist.ROLES:
        with pytest.raises(Refused):
            check(sql, role)


def test_semicolon_inside_literal_is_one_statement():
    assert check("SELECT 'a;b' AS x", "reader") == "read"


def test_select_with_a_write_keyword_is_refused():
    with pytest.raises(Refused):
        check("SELECT 1 FROM t WHERE 1 = 1 UNION ALL DROP TABLE t", "reader")
    assert check("SELECT 'DROP' AS word", "reader") == "read"


def test_reader_cannot_register_or_cache():
    for sql in (rest(FRAMES), filestore(GHCN), "CACHE TABLE cw.frames_revenues_cy2025q1",
                "CREATE LIGHTNING DATABASE CW_SEC", "CREATE SCHEMASTORE CONTAINER cw"):
        with pytest.raises(Refused):
            check(sql, "reader")


@pytest.mark.parametrize("url,db", [
    (FRAMES, "CW_SEC"), (CONCEPT, "CW_SEC"), (SUBMISSIONS, "CW_SEC"), (DNS, "CW_DNS"), (FRAMES, "cw_sec"),
])
def test_registrar_rest_hosts(url, db):
    assert check(rest(url, db), "registrar") == "register"


@pytest.mark.parametrize("url", [
    "https://evil.example.com/x.json",
    "http://data.sec.gov/submissions/CIK0001326160.json",
    "https://data.sec.gov:8443/submissions/CIK0001326160.json",
    "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany",
    "https://data.sec.gov.example.net/x.json",
    "http://localhost:8888/api",
    "https://world.openfoodfacts.org/api/v2/product/1.json",
])
def test_registrar_rest_hosts_refused(url):
    with pytest.raises(Refused):
        check(rest(url), "registrar")


@pytest.mark.parametrize("db", ["SEC_DATA", "CLEARSHELF_FDA", "NY_TAXI", "WON", "CW_"])
def test_registrar_rest_database_must_be_won(db):
    with pytest.raises(Refused):
        check(rest(FRAMES, db), "registrar")


def test_registrar_rest_refuses_auth_and_a_second_endpoint():
    with pytest.raises(Refused):
        check(rest(FRAMES, tail=" AUTH BY sec_token"), "registrar")
    two = rest(FRAMES).replace('method "get"', f'method "get", endpoint "{SUBMISSIONS}"')
    with pytest.raises(Refused):
        check(two, "registrar")


def test_registrar_filestore_bucket():
    assert check(filestore(GHCN), "registrar") == "register"
    assert check(filestore("s3a://noaa-ghcn-pds/csv/by_year/2025.csv", fmt="CSV"), "registrar") == "register"
    assert check(filestore(GHCN.replace("TMAX", "TMIN"), db="cw_ghcn"), "registrar") == "register"


@pytest.mark.parametrize("sql", [
    filestore("s3a://pudl.catalyst.coop/stable/x.parquet"),
    filestore("s3a://noaa-ghcn-pds-mirror/parquet/x/"),
    filestore("s3://noaa-ghcn-pds/parquet/by_year/YEAR=2025/ELEMENT=TMAX/"),
    filestore(GHCN, db="NOAA_GHCN_S3"),
    filestore(GHCN, fmt="JSON"),
    filestore(GHCN, extra=', awsAccessKeyId "AKIAEXAMPLE", awsSecretAccessKey "example-secret"'),
    filestore(GHCN, extra=', aws_secret_access_key "example-secret"'),
    filestore(GHCN, extra=', sourceTable "cw.weather_2025"'),
    filestore(GHCN, extra=f', PATH "{GHCN}"'),
])
def test_registrar_filestore_refused(sql):
    with pytest.raises(Refused):
        check(sql, "registrar")


def test_registrar_cache_scope():
    for sql in ("CACHE TABLE cw.frames_revenues_cy2025q1", "CACHE TABLE CW_GHCN.ghcn_2025_tmax",
                "UNCACHE TABLE IF EXISTS cw.weather_2025", "uncache table cw_sec.submissions_0001326160",
                "UNCACHE LIGHTNING FILESTORE TABLE ghcn_2025_tmax FROM CW_GHCN"):
        assert check(sql, "registrar") == "register"
    for sql in ("CACHE TABLE ny_taxi.trips", "CACHE TABLE clearshelf_fda.enforcement_undeclared",
                "CACHE TABLE edgar.apple_revenue_table", "CACHE TABLE cw.x.y", "CACHE TABLE wonder.x",
                "UNCACHE LIGHTNING FILESTORE TABLE t FROM NOAA_GHCN_S3"):
        with pytest.raises(Refused):
            check(sql, "registrar")


def test_registrar_database_container_namespace():
    for sql in ('CREATE LIGHTNING DATABASE CW_SEC DESCRIBE BY "Crosswalk - SEC EDGAR XBRL REST tables"',
                "CREATE LIGHTNING DATABASE CW_GHCN",
                "CREATE LIGHTNING DATABASE IF NOT EXISTS CW_DNS DESCRIBE BY 'company_dns SIC codes'",
                "CREATE SCHEMASTORE CONTAINER cw",
                "CREATE NAMESPACE IF NOT EXISTS lightning.metastore",
                f"CREATE NAMESPACE IF NOT EXISTS {NS}"):
        assert check(sql, "registrar") == "register"
    for sql in ('CREATE LIGHTNING DATABASE SEC_DATA DESCRIBE BY "x"', "CREATE LIGHTNING DATABASE CLEARSHELF_X",
                "CREATE LIGHTNING DATABASE CW_SEC WITH (x 'y')", "CREATE SCHEMASTORE CONTAINER edgar",
                "CREATE SCHEMASTORE CONTAINER cw extra", "CREATE NAMESPACE IF NOT EXISTS lightning.metastore.clearshelf"):
        with pytest.raises(Refused):
            check(sql, "registrar")


def test_registrar_schemastore_views():
    ok = [
        "CREATE SCHEMASTORE VIEW frames_revenues_cy2025q1 WITH CONTAINER cw AS SELECT f.cik, f.entityName, f.loc, f.val, f.accn "
        "FROM CW_SEC.frames_revenues_cy2025q1 LATERAL VIEW explode(data) AS f",
        "CREATE OR REPLACE SCHEMASTORE VIEW weather_2025_tmax WITH CONTAINER cw AS SELECT ID, DATE, DATA_VALUE "
        "FROM CW_GHCN.ghcn_2025_tmax WHERE ID IN ('USW00013740', 'USW00013722')",
        "CREATE SCHEMASTORE VIEW cw.station_days AS SELECT ID, COUNT(*) AS n FROM CW_GHCN.ghcn_2025_tmax GROUP BY ID",
    ]
    for sql in ok:
        assert check(sql, "registrar") == "register"
    bad = [
        "CREATE SCHEMASTORE VIEW x WITH CONTAINER edgar AS SELECT 1",
        "CREATE SCHEMASTORE VIEW clearshelf.x AS SELECT 1",
        "CREATE SCHEMASTORE VIEW x WITH CONTAINER cw AS SELECT * FROM t WHERE 1 = 1 UNION ALL DELETE FROM t",
        "CREATE SCHEMASTORE VIEW x WITH CONTAINER cw AS SELECT 1 FROM t; DROP TABLE t",
        "CREATE SCHEMASTORE VIEW x WITH CONTAINER cw AS VALUES (1)",
    ]
    for sql in bad:
        with pytest.raises(Refused):
            check(sql, "registrar")


COMPILE_OK = (f"COMPILE USL IF NOT EXISTS crosswalk_usl DEPLOY NAMESPACE {NS} DDL\n"
              "CREATE TABLE sic_code (code varchar(4) NOT NULL PRIMARY KEY, description varchar(200));\n"
              "CREATE TABLE utility (cik varchar(10) NOT NULL PRIMARY KEY, sic varchar(4) FOREIGN KEY REFERENCES sic_code(code))")


def test_registrar_compile_activate_register_dq():
    assert check(COMPILE_OK, "registrar") == "register"
    assert check(f"ACTIVATE USL TABLE {U}.weather_quarter AS SELECT station_id, year, quarter, hdd, cdd FROM cw.weather_quarter", "registrar") == "register"
    assert check(f"REGISTER DQ coverage_ok TABLE {U}.weather_quarter AS coverage >= 0.9", "registrar") == "register"
    assert check(f"REGISTER DQ known_tag TABLE {U}.revenue_quarter AS tag IN ('SELECT','DROP')", "registrar") == "register"
    with pytest.raises(Refused):
        check(f"REGISTER DQ station_known TABLE {U}.weather_quarter AS station_id IN (SELECT id FROM {U}.station)", "registrar")
    with pytest.raises(Refused):
        check(f"REGISTER DQ r TABLE {U}.weather_quarter AS coverage >= 0.9 OR DROP", "registrar")
    with pytest.raises(Refused):
        check("REGISTER DQ r TABLE lightning.metastore.clearshelf.clearance_usl.product AS gtin IS NOT NULL", "registrar")
    with pytest.raises(Refused):
        check("ACTIVATE USL TABLE lightning.metastore.other.usl.t AS SELECT 1", "registrar")
    with pytest.raises(Refused):
        check(f"ACTIVATE USL TABLE {U}.weather_quarter AS SELECT 1 FROM t WHERE 1 = 1 UNION ALL DELETE FROM t", "registrar")


@pytest.mark.parametrize("tail", [
    "; DROP TABLE cw.weather_2025",
    ";\nGRANT ALL ON x TO y",
    "; CREATE TABLE b (y int); INVALIDATE CACHE",
    ";; CREATE TABLE b (y int)",
    "; CREATE TABLE b (y int) ; ",
    f"; REMOVE USL crosswalk_usl NAMESPACE {NS}",
    "; CREATE TABLE b (y int, z int DROP)",
])
def test_compile_refuses_anything_but_create_table_parts(tail):
    for head in (f"COMPILE USL crosswalk_usl DEPLOY NAMESPACE {NS} DDL CREATE TABLE x (a int)",
                 f"COMPILE USL IF NOT EXISTS crosswalk_usl DEPLOY NAMESPACE {NS} DDL\nCREATE TABLE x (a int)"):
        for role in ("registrar", "onboard"):
            with pytest.raises(Refused):
                check(head + tail, role)


def test_compile_scope_and_literal_semicolons():
    ok = (f"COMPILE USL crosswalk_usl DEPLOY NAMESPACE {NS} DDL "
          "CREATE TABLE x (a varchar(5) DEFAULT 'a;b'); CREATE TABLE y (b int)")
    assert check(ok, "registrar") == "register"
    for bad in (f"COMPILE USL other DEPLOY NAMESPACE {NS} DDL CREATE TABLE x (a int)",
                "COMPILE USL crosswalk_usl DEPLOY NAMESPACE lightning.metastore.clearshelf DDL CREATE TABLE x (a int)",
                f"COMPILE USL crosswalk_usl DEPLOY NAMESPACE {NS} DDL DROP TABLE x"):
        with pytest.raises(Refused):
            check(bad, "onboard")


COVERAGE_UPDATE = f"UPDATE DQ coverage_ok TABLE {U}.weather_quarter SET NAME = coverage_ok, EXPRESSION = coverage >= 0.95 AND days_observed > 0"


def test_onboarding_only_statements():
    for sql in (COVERAGE_UPDATE,
                f"UPDATE USL {U}.weather_quarter SET TABLE DESCRIPTION 'Degree days per station and quarter'",
                f"UPDATE USL {U}.weather_quarter.coverage SET COLUMN DESCRIPTION 'days_observed over days in the quarter'",
                f"REMOVE USL crosswalk_usl NAMESPACE {NS}"):
        for role in ("reader", "registrar"):
            with pytest.raises(Refused):
                check(sql, role)
        assert check(sql, "onboard") == "onboard"
    with pytest.raises(Refused):
        check(f"REMOVE USL other NAMESPACE {NS}", "onboard")
    with pytest.raises(Refused):
        check("REMOVE USL clearance_usl NAMESPACE lightning.metastore.clearshelf", "onboard")


@pytest.mark.parametrize("sql", [
    f"UPDATE DQ coverage_ok TABLE {U}.weather_quarter SET NAME = other_rule, EXPRESSION = coverage >= 0.9",
    "UPDATE DQ coverage_ok TABLE lightning.metastore.other.usl.t SET NAME = coverage_ok, EXPRESSION = coverage >= 0.9",
    f"UPDATE DQ coverage_ok TABLE {U}.weather_quarter SET NAME = coverage_ok, EXPRESSION = station_id IN (SELECT id FROM {U}.station)",
    f"UPDATE DQ coverage_ok TABLE {U}.weather_quarter SET NAME = coverage_ok, EXPRESSION = coverage >= 0.9 OR DROP",
    f"UPDATE DQ coverage_ok TABLE {U}.weather_quarter SET EXPRESSION = coverage >= 0.9",
    f"UPDATE DQ coverage_ok TABLE {U}.weather_quarter SET NAME = coverage_ok",
    f"{COVERAGE_UPDATE};",
])
def test_update_dq_refused_shapes(sql):
    with pytest.raises(Refused):
        check(sql, "onboard")


def test_update_dq_keywords_inside_literals_are_data():
    sql = f"UPDATE DQ known_tag TABLE {U}.revenue_quarter SET NAME = known_tag, EXPRESSION = tag IN ('SELECT','DROP')"
    assert check(sql, "onboard") == "onboard"


def test_unknown_role():
    with pytest.raises(Refused):
        check("SELECT 1", "admin")
