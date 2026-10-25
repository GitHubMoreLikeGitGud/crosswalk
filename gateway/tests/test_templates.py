import pytest

from gateway import allowlist, templates
from gateway.templates import BadParams, Plan, Step, Template, render

SAMPLES = {"cik10": "0001326160", "tag": "Revenues", "period": "CY2025Q1", "year": "2025", "quarter": "1",
           "station": "USW00013740", "station_list": "USW00013740,USW00013722", "element": "TMAX", "sic": "4931",
           "fema_quarter": "CY2025Q1", "cw_object": "cw.states", "column": "state", "cik_list": "0001326160,0000092122",
           "dq_rule": "utility.sic", "catalogue_id": "sec_frames"}
USL = "lightning.metastore.crosswalk.crosswalk_usl"

FRAMES_CREATE = Template(
    "registrar_frames_table",
    'CREATE LIGHTNING REST TABLE frames_{tag}_{period} FROM CW_SEC REQUEST( '
    'endpoint "https://data.sec.gov/api/xbrl/frames/us-gaap/{tag}/USD/{period}.json", method "get", '
    'response_type "json", http_encoding "URLENCODED" ) HEADER ( user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL" ) BODY ()',
    {"tag": "tag", "period": "period"}, ("CW_SEC.frames_{tag}_{period}",), (), "One SEC frames period as a raw REST table.", "registrar")


def test_sample_params_cover_every_kind():
    assert set(SAMPLES) == set(templates.PARAM_PATTERNS)


@pytest.mark.parametrize("tid", sorted(templates.TEMPLATES))
def test_every_template_renders_and_passes_its_role(tid):
    t = templates.TEMPLATES[tid]
    params = {name: SAMPLES[kind] for name, kind in t.params.items()}
    _, sql = render(tid, params)
    assert "{" not in sql
    assert t.role in ("reader", "registrar")
    assert allowlist.check(sql, t.role) == ("read" if t.role == "reader" else "register")


@pytest.mark.parametrize("action", sorted(templates.REGISTRAR_PLANS))
def test_every_plan_step_is_a_known_template_the_plan_parameters_cover(action):
    plan = templates.REGISTRAR_PLANS[action]
    assert plan.action == action and plan.steps
    for step in plan.steps:
        t = templates.TEMPLATES[step.template_id]
        assert all(plan.params.get(name) == kind for name, kind in t.params.items())


def test_connectivity_templates():
    assert render("select1", {})[1] == "SELECT 1 AS ok"
    assert render("show_databases", None)[1] == "SHOW LIGHTNING DATABASES"


def test_weather_quarter_reads_the_cached_views_of_its_year_for_a_quoted_station_list():
    from gateway import cache

    params = {"year": "2025", "quarter": "1", "station_list": "USW00013740,USW00013722"}
    t, sql = render("weather_quarter", params)
    assert t.role == "reader" and allowlist.check(sql, "reader") == "read"
    assert "FROM cw.ghcn_2025_tmax x JOIN cw.ghcn_2025_tmin n ON n.ID = x.ID AND n.DATE = x.DATE" in sql
    assert "WHERE x.ID IN ('USW00013740', 'USW00013722')" in sql
    assert "BETWEEN 3 * 1 - 2 AND 3 * 1" in sql  # the quarter's months from substr(DATE, 5, 2)
    assert "CASE 1 WHEN 1 THEN CASE WHEN 2025 % 4 = 0 THEN 91 ELSE 90 END WHEN 2 THEN 91 ELSE 92 END AS days_in_quarter" in sql
    # The arithmetic of agent/src/tools/degreeDays.ts: Tmean F from tenths of a degree C, base 65 F.
    assert "(((x.DATA_VALUE + n.DATA_VALUE) / 2.0) / 10.0 * 9.0 / 5.0 + 32)" in sql
    assert "SUM(GREATEST(0, 65 - (((x.DATA_VALUE" in sql and "AS hdd" in sql and "AS cdd" in sql
    assert "(x.Q_FLAG IS NULL OR x.Q_FLAG = '')" in sql and "(n.Q_FLAG IS NULL OR n.Q_FLAG = '')" in sql
    assert sql.endswith("GROUP BY x.ID ORDER BY x.ID")
    assert cache.resolve(t.raw_objects, params) == ["cw.ghcn_2025_tmax", "cw.ghcn_2025_tmin"]
    _, sql_2024 = render("weather_quarter", {**params, "year": "2024", "quarter": "3", "station_list": "USW00013740"})
    assert "FROM cw.ghcn_2024_tmax x JOIN cw.ghcn_2024_tmin n" in sql_2024 and "IN ('USW00013740')" in sql_2024
    assert "BETWEEN 3 * 3 - 2 AND 3 * 3" in sql_2024


def test_weather_quarter_refuses_an_unquoted_or_injected_station_list():
    for bad in ("USW00013740;USW00013722", "USW00013740') OR ('1'='1", "USW00013740, USW00013722", "'USW00013740'"):
        with pytest.raises(BadParams):
            render("weather_quarter", {"year": "2025", "quarter": "1", "station_list": bad})


@pytest.mark.parametrize("kind,value,ok", [
    ("cik10", "0001326160", True), ("cik10", "1326160", False), ("cik10", "CIK0001326160", False), ("cik10", "0001326160 ", False),
    ("tag", "Revenues", True), ("tag", "RevenueFromContractWithCustomerExcludingAssessedTax", True),
    ("tag", "RegulatedAndUnregulatedOperatingRevenue", True), ("tag", "revenues", False), ("tag", "Revenues'", False),
    ("tag", "NetIncomeLoss", False),
    ("period", "CY2025Q1", True), ("period", "CY2024Q3", True), ("period", "CY2025Q4", False), ("period", "CY2025", False),
    ("period", "cy2025q1", False), ("period", "CY2025Q1I", False),
    ("year", "2025", True), ("year", "2099", True), ("year", "1999", False), ("year", "20251", False),
    ("quarter", "1", True), ("quarter", "3", True), ("quarter", "4", False), ("quarter", "Q1", False),
    ("station", "USW00013740", True), ("station", "USC00011084", True), ("station", "usw00013740", False),
    ("station", "USW0001374", False), ("station", "CA001012345", False), ("station", "USW00013740'", False),
    ("station_list", "USW00013740", True), ("station_list", "USW00013740,USW00013722", True),
    ("station_list", ",".join(["USW00013740"] * 60), True), ("station_list", ",".join(["USW00013740"] * 61), False),
    ("station_list", "USW00013740,", False), ("station_list", "USW00013740, USW00013722", False),
    ("station_list", "USW00013740,usw00013722", False), ("station_list", "USW00013740','USW00013722", False),
    ("station_list", "", False),
    ("element", "TMAX", True), ("element", "TMIN", True), ("element", "PRCP", False), ("element", "tmax", False),
    ("sic", "4931", True), ("sic", "0111", True), ("sic", "491", False), ("sic", "49311", False), ("sic", "4931'", False),
    ("fema_quarter", "CY2025Q1", True), ("fema_quarter", "CY2024Q4", True), ("fema_quarter", "CY2025Q5", False),
    ("fema_quarter", "2025Q1", False), ("fema_quarter", "CY2025Q1'", False), ("fema_quarter", "CY2025Q1\n", False),
    ("cw_object", "cw.states", True), ("cw_object", "cw.fema_declarations_dr_2025q1", True),
    ("cw_object", "cw.frames_revenues_cy2025q1", True), ("cw_object", "cw.submission_0001326160", True),
    ("cw_object", "cw.States", False), ("cw_object", "CW.states", False), ("cw_object", "won.ghcn_2025_tmax", False),
    ("cw_object", "cw.states;", False), ("cw_object", "cw.states\n", False), ("cw_object", "cw.clearshelf_items", False),
    ("cw_object", "cw.won_states", False), ("cw_object", "cw.probe_values", False), ("cw_object", "cw.frames_netincomeloss_cy2025q1", False),
    ("column", "state", True), ("column", "entityName", True), ("column", "disaster_number", True), ("column", "_c0", False),
    ("column", "state`", False), ("column", "a b", False), ("column", "x" * 65, False),
    ("cik_list", "0001326160", True), ("cik_list", "0001326160,0000092122", True), ("cik_list", ",".join(["0001326160"] * 60), True),
    ("cik_list", ",".join(["0001326160"] * 61), False), ("cik_list", "1326160", False), ("cik_list", "0001326160, 0000092122", False),
    ("cik_list", "0001326160','0000092122", False),
    ("dq_rule", "utility.sic", True), ("dq_rule", "revenue_quarter.cik", True), ("dq_rule", "station.state", True),
    ("dq_rule", "utility.cik", False), ("dq_rule", "weather_quarter.coverage_ok", False), ("dq_rule", "utility.sic TABLE x", False),
    ("catalogue_id", "sec_frames", True), ("catalogue_id", "noaa_ghcn_by_year", True), ("catalogue_id", "Sec_frames", False),
    ("catalogue_id", "sec-frames", False),
])
def test_param_patterns(kind, value, ok):
    if ok:
        assert templates.validate_param(kind, value) == value
    else:
        with pytest.raises(BadParams):
            templates.validate_param(kind, value)


def test_non_string_and_unknown_kind_are_refused():
    with pytest.raises(BadParams):
        templates.validate_param("year", 2025)
    with pytest.raises(BadParams):
        templates.validate_param("gtin", "0816929000119")


@pytest.mark.parametrize("tid,params", [
    ("select1", {"extra": "x"}),
    ("nope", {}),
    ("registrar_frames_table", {"tag": "Revenues"}),
    ("registrar_frames_table", {"tag": "Revenues", "period": "CY2025Q4"}),
    ("registrar_frames_table", {"tag": "Revenues", "period": "CY2025Q1", "x": "1"}),
    ("registrar_frames_table", {"tag": "Revenues'; DROP TABLE t", "period": "CY2025Q1"}),
])
def test_bad_params(monkeypatch, tid, params):
    monkeypatch.setitem(templates.TEMPLATES, FRAMES_CREATE.id, FRAMES_CREATE)
    with pytest.raises(BadParams):
        render(tid, params)


def test_a_registrar_template_substitutes_only_validated_values(monkeypatch):
    monkeypatch.setitem(templates.TEMPLATES, FRAMES_CREATE.id, FRAMES_CREATE)
    t, sql = render("registrar_frames_table", {"tag": "RevenueFromContractWithCustomerExcludingAssessedTax", "period": "CY2024Q2"})
    assert t.role == "registrar" and "{" not in sql
    assert "frames_RevenueFromContractWithCustomerExcludingAssessedTax_CY2024Q2 FROM CW_SEC" in sql
    assert 'endpoint "https://data.sec.gov/api/xbrl/frames/us-gaap/RevenueFromContractWithCustomerExcludingAssessedTax/USD/CY2024Q2.json"' in sql
    assert allowlist.check(sql, "registrar") == "register"
    with pytest.raises(allowlist.Refused):
        allowlist.check(sql, "reader")


def test_reader_templates_read_the_cached_views_with_the_agreed_columns():
    _, sql = render("frames_period", {"tag": "Revenues", "period": "CY2025Q1"})
    assert sql == "SELECT cik, `entityName`, loc, `start`, `end`, val, accn FROM cw.frames_Revenues_CY2025Q1 ORDER BY cik"
    _, sql = render("frames_fact", {"tag": "RegulatedAndUnregulatedOperatingRevenue", "period": "CY2024Q1", "cik10": "0001326160"})
    assert sql.endswith("FROM cw.frames_RegulatedAndUnregulatedOperatingRevenue_CY2024Q1 WHERE LPAD(CAST(cik AS STRING), 10, '0') = '0001326160'")
    _, sql = render("submission", {"cik10": "0000065984"})
    assert sql == "SELECT cik, name, sic, `sicDescription`, state FROM cw.submission_0000065984"
    assert "street" not in sql.lower()
    _, sql = render("sic", {"code": "4911"})
    assert sql == "SELECT code, description, division, division_desc, major_group, major_group_desc FROM cw.sic_codes WHERE code = '4911'"
    for tid in ("frames_period", "frames_count", "frames_fact", "submission", "sic"):
        assert templates.TEMPLATES[tid].role == "reader"


def test_seed_ciks_come_from_the_seed_file_as_ten_digit_strings(tmp_path):
    assert len(templates.SEED_CIKS) == 43 and len(set(templates.SEED_CIKS)) == 43
    assert all(len(c) == 10 and c.isdigit() for c in templates.SEED_CIKS)
    assert {"0001031296", "0000004904", "0001326160", "0000715957"} <= set(templates.SEED_CIKS)  # FirstEnergy, AEP, Duke, Dominion
    assert templates.SEED_CIK_INTS_SQL.split(", ") == [str(int(c)) for c in templates.SEED_CIKS]
    bad = tmp_path / "utilities.json"
    bad.write_text('{"utilities": [{"cik": "1326160"}]}', encoding="utf-8")
    with pytest.raises(ValueError):
        templates.load_seed_ciks(bad)
    bad.write_text('{"utilities": [{"cik": "0001326160"}, {"cik": "0001326160"}]}', encoding="utf-8")
    with pytest.raises(ValueError):
        templates.load_seed_ciks(bad)


def test_registrar_plans_register_table_view_describe_cache_in_order():
    for action, params in (("register_frames", {"tag": "tag", "period": "period"}), ("register_concept", {"cik10": "cik10", "tag": "tag"}),
                           ("register_submission", {"cik10": "cik10"})):
        plan = templates.REGISTRAR_PLANS[action]
        assert plan.params == params
        kinds = [templates.TEMPLATES[s.template_id].sql.split()[0] for s in plan.steps]
        assert kinds == ["CREATE", "CREATE", "DESCRIBE", "CACHE"]
        assert [s.skip_exists for s in plan.steps] == [True, True, False, False]
        assert plan.steps[-1].timeout_s == 600.0
        assert [templates.TEMPLATES[s.template_id].role for s in plan.steps] == ["registrar", "registrar", "reader", "registrar"]
    _, table = render("registrar_frames_table", {"tag": "Revenues", "period": "CY2025Q2"})
    assert 'endpoint "https://data.sec.gov/api/xbrl/frames/us-gaap/Revenues/USD/CY2025Q2.json"' in table
    assert 'user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"' in table and table.endswith("BODY ()")
    _, view = render("registrar_frames_view", {"tag": "Revenues", "period": "CY2025Q2"})
    assert view.startswith("CREATE SCHEMASTORE VIEW frames_Revenues_CY2025Q2 WITH CONTAINER cw AS SELECT")
    assert "FROM CW_SEC.frames_Revenues_CY2025Q2 LATERAL VIEW explode(data) AS f" in view
    _, view = render("registrar_concept_view", {"cik10": "0001326160", "tag": "Revenues"})
    assert "LATERAL VIEW explode(units.USD) AS f" in view and "frame" not in view  # not every filer's facts carry `frame`
    _, view = render("registrar_submission_view", {"cik10": "0001326160"})
    assert "addresses.business.`stateOrCountry` AS state" in view and "street" not in view.lower()


def test_user_agent_is_a_placeholder_in_every_template():
    for t in templates.TEMPLATES.values():
        if "user-agent" in t.sql:
            assert 'user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"' in t.sql
        assert "@" not in t.sql


def test_cache_targets_for_builds_the_view_names():
    out = templates.cache_targets_for([("Revenues", "CY2025Q1")], [("0001326160", "Revenues")], ["0000092122"])
    assert out == ("cw.frames_Revenues_CY2025Q1", "cw.concept_0001326160_Revenues", "cw.submission_0000092122", "cw.sic_codes")
    for name in out:
        assert allowlist.check(f"CACHE TABLE {name}", "registrar") == "register"


def test_plan_params_take_the_plan_parameters_from_a_request_body():
    plan = Plan("register_frames", {"tag": "tag", "period": "period"}, (Step("registrar_frames_table", skip_exists=True),))
    body = {"tag": "Revenues", "period": "CY2025Q1", "contract": {"contractId": "c-1"}}
    assert templates.plan_params(plan, body) == {"tag": "Revenues", "period": "CY2025Q1"}
    for bad in ({"tag": "Revenues"}, {"tag": "Revenues", "period": "CY2025Q4"}, {"tag": 1, "period": "CY2025Q1"}):
        with pytest.raises(BadParams):
            templates.plan_params(plan, bad)


def test_fema_quarter_derives_the_object_suffix_and_the_percent_encoded_quarter_bounds():
    assert templates.fema_quarter_bounds("CY2025Q1") == {
        "quarter_slug": "2025q1", "quarter_start": "2025-01-01T00%3A00%3A00.000Z", "quarter_end": "2025-04-01T00%3A00%3A00.000Z"}
    assert templates.fema_quarter_bounds("CY2024Q4") == {
        "quarter_slug": "2024q4", "quarter_start": "2024-10-01T00%3A00%3A00.000Z", "quarter_end": "2025-01-01T00%3A00%3A00.000Z"}
    _, table = render("registrar_fema_table", {"quarter": "CY2025Q1"})
    assert table.startswith("CREATE LIGHTNING REST TABLE declarations_dr_2025q1 FROM CW_FEMA REQUEST(")
    assert ("%24filter=declarationType%20eq%20%27DR%27%20and%20declarationDate%20ge%20%272025-01-01T00%3A00%3A00.000Z%27"
            "%20and%20declarationDate%20lt%20%272025-04-01T00%3A00%3A00.000Z%27&%24top=1000") in table
    assert " " not in table.split('endpoint "')[1].split('"')[0]  # the URL carries no raw space, $ or quote
    assert "$" not in table and "{" not in table
    _, view = render("registrar_fema_view", {"quarter": "CY2025Q1"})
    assert view.startswith("CREATE SCHEMASTORE VIEW fema_declarations_dr_2025q1 WITH CONTAINER cw AS SELECT")
    assert "LATERAL VIEW explode(`DisasterDeclarationsSummaries`) AS d" in view and "FROM CW_FEMA.declarations_dr_2025q1" in view
    assert render("fema_by_state", {"quarter": "CY2025Q1"})[1].endswith("FROM cw.fema_declarations_dr_2025q1 GROUP BY state ORDER BY state")


def test_crosswalk_reader_templates_read_the_cached_views():
    _, sql = render("fema_declarations", {"quarter": "CY2025Q1"})
    assert sql.startswith("SELECT disaster_number, state, declaration_date, incident_type") and "FROM cw.fema_declarations_dr_2025q1" in sql
    assert render("catalogue_list", {})[1] == ("SELECT name, version, title, api_endpoint, last_dataset_refresh FROM cw.fema_catalogue "
                                               "ORDER BY name, version")
    _, sql = render("stations_lookup", {"ids": "USW00013740,USW00013722"})
    assert "FROM cw.stations WHERE id IN ('USW00013740', 'USW00013722') ORDER BY id" in sql
    with pytest.raises(BadParams):
        render("stations_lookup", {"ids": "USW00013740','USW00013722"})


def test_joinmap_templates_measure_distinct_left_keys_over_cached_views():
    _, a = render("joinmap_cik", {"period": "CY2025Q1"})
    assert a.startswith("SELECT COUNT(DISTINCT l.k) AS left_keys, COUNT(DISTINCT CASE WHEN r.k IS NOT NULL THEN l.k END) AS matched_keys")
    assert "FROM (SELECT DISTINCT cik AS k FROM cw.seed_utilities) l LEFT JOIN (" in a
    assert a.count("LPAD(CAST(cik AS STRING), 10, '0')") == 3 and "cw.frames_Revenues_CY2025Q1" in a
    assert "cw.frames_RegulatedAndUnregulatedOperatingRevenue_CY2025Q1" in a and "CY2024" not in a
    _, b = render("joinmap_loc", {"period": "CY2024Q1"})
    assert "SUBSTR(loc, 4, 2) AS loc_state" in b and "l.loc_state = r.hq_state" in b and "CY2024Q1" in b
    _, c = render("joinmap_fema_state", {"quarter": "CY2025Q1"})
    assert "FROM (SELECT DISTINCT state AS k FROM cw.fema_declarations_dr_2025q1) l" in c and "cw.utility_states" in c
    _, d = render("joinmap_station", {})
    assert "FROM cw.seed_stations) l LEFT JOIN cw.stations r ON r.id = l.k" in d and "state_equal" in d
    _, e = render("joinmap_sic", {})
    assert "cw.seed_utilities" in e and "cw.sic_codes" in e and "left_rows" in e
    for tid in ("joinmap_cik_orphans", "joinmap_fema_state_orphans", "joinmap_sic_orphans"):
        params = {name: SAMPLES[kind] for name, kind in templates.TEMPLATES[tid].params.items()}
        sql = render(tid, params)[1]
        assert sql.endswith("LIMIT 10") and "IS NULL" in sql
    _, ctl = render("joinmap_cik_control", {"period": "CY2025Q1"})
    assert ctl.count("CAST(cik AS STRING) AS k") == 3 and "LPAD" not in ctl and ctl.count("cw.seed_utilities") == 1
    _, fips = render("joinmap_fema_fips", {"quarter": "CY2024Q1"})
    assert "SELECT DISTINCT fips_state_code AS k FROM cw.fema_declarations_dr_2024q1) l" in fips
    assert "LEFT JOIN (SELECT DISTINCT fips AS k FROM cw.states) r ON r.k = l.k" in fips
    for tid in ("joinmap_cik_control", "joinmap_fema_fips"):
        assert templates.TEMPLATES[tid].role == "reader" and "CW_" not in templates.TEMPLATES[tid].sql
    # a view is referenced once per statement (a second reference to cw.seed_utilities fails to resolve on 2.4.3.1)
    assert render("joinmap_cik_orphans", {"period": "CY2025Q1"})[1].count("cw.seed_utilities") == 1
    for tid in ("joinmap_cik", "joinmap_loc", "joinmap_fema_state", "joinmap_station", "joinmap_sic"):
        assert templates.TEMPLATES[tid].role == "reader" and "CW_" not in templates.TEMPLATES[tid].sql  # cached views only, never raw tables


def test_crosswalk_registrar_plans():
    fema = templates.REGISTRAR_PLANS["register_fema"]
    assert fema.params == {"quarter": "fema_quarter"}
    assert [templates.TEMPLATES[s.template_id].sql.split()[0] for s in fema.steps] == ["CREATE", "CREATE", "DESCRIBE", "CACHE"]
    stations = templates.REGISTRAR_PLANS["register_stations"]
    assert stations.params == {}
    _, table = render("registrar_stations_table", {})
    assert table.startswith("CREATE LIGHTNING FILESTORE TABLE ghcnd_stations_txt FROM CW_GHCN FORMAT CSV OPTIONS (")
    assert 'PATH "s3a://noaa-ghcn-pds/ghcnd-stations.txt"' in table and 'delimiter "|"' in table and 'quote ""' in table
    assert allowlist.check(table, "registrar") == "register"
    _, view = render("registrar_stations_view", {})
    assert "SUBSTR(_c0, 1, 11) AS id, SUBSTR(_c0, 39, 2) AS state" in view and "FROM CW_GHCN.ghcnd_stations_txt" in view


def test_inherited_question_templates_are_gone():
    for tid in ("usl_describe", "dq_run_coverage", "usl_utility", "usl_revenue", "concept_history", "concept_window",
                "frames_seeds", "dq_run_sic", "dq_invalid_sic"):
        assert tid not in templates.TEMPLATES
    for tid in ("frames_period", "frames_count", "frames_fact", "weather_quarter"):
        assert tid in templates.TEMPLATES


def test_probe_templates_take_a_manifest_view():
    from gateway import cache

    t, sql = render("describe_object", {"object": "cw.fema_declarations_dr_2025q1"})
    assert sql == "DESCRIBE cw.fema_declarations_dr_2025q1" and allowlist.check(sql, "reader") == "read"
    assert cache.resolve(t.raw_objects, {"object": "cw.fema_declarations_dr_2025q1"}) == ["cw.fema_declarations_dr_2025q1"]
    assert render("sample_rows", {"object": "cw.utility_states"})[1] == "SELECT * FROM cw.utility_states LIMIT 5"
    _, sql = render("distinct_counts", {"object": "cw.frames_revenues_cy2025q1", "column": "entityName"})
    assert sql == ("SELECT COUNT(*) AS row_count, COUNT(DISTINCT `entityName`) AS distinct_values, COUNT(`entityName`) AS non_null, "
                   "COUNT(`entityName`) / CAST(COUNT(*) AS DOUBLE) AS non_null_share FROM cw.frames_revenues_cy2025q1")
    assert allowlist.check(sql, "reader") == "read"


@pytest.mark.parametrize("obj", ["won.ghcn_2025_tmax", "WON.ghcn_2025_tmax", "cw.won_seed_utilities"])
def test_probe_templates_refuse_the_sister_entrys_objects(obj):
    for tid in ("describe_object", "sample_rows"):
        with pytest.raises(BadParams):
            render(tid, {"object": obj})
    with pytest.raises(BadParams):
        render("distinct_counts", {"object": obj, "column": "ID"})


@pytest.mark.parametrize("obj", ["cw.clearshelf_products", "cw.probe_values", "cw.seed_utilities_x", "cw.ghcn_2025_prcp",
                                 "cw.states union select 1", "CW_SEC.frames_Revenues_CY2025Q1"])
def test_probe_templates_refuse_anything_not_in_the_manifest(obj):
    with pytest.raises(BadParams):
        render("describe_object", {"object": obj})


def test_manifest_names_and_patterns(tmp_path):
    m = tmp_path / "manifest.json"
    m.write_text('{"sources": [{"objects": {"raw": "CW_X.t", "container": "cw", "views": ["cw.A_b"], '
                 '"frames": ["cw.frames_<tag>_<period>"], "fema": "cw.fema_declarations_dr_<quarter_slug>"}}]}', encoding="utf-8")
    exact, patterns = templates.load_manifest_views(m)
    assert exact == frozenset({"cw.a_b"})
    assert [p.pattern for p in patterns] == [
        r"cw\.frames_(revenues|revenuefromcontractwithcustomerexcludingassessedtax|regulatedandunregulatedoperatingrevenue)_cy\d{4}q[1-3]",
        r"cw\.fema_declarations_dr_\d{4}q[1-4]"]
    assert templates.in_manifest("cw.states") and templates.in_manifest("cw.frames_Revenues_CY2024Q1")
    assert not templates.in_manifest("cw.frames_Revenues_CY2024Q4") and not templates.in_manifest("won.states")


def test_answer_templates_read_cached_views_only():
    from gateway import cache

    t, sql = render("answer_fema_utilities", {"quarter": "CY2025Q1"})
    assert t.role == "reader" and allowlist.check(sql, "reader") == "read" and "CW_" not in sql
    assert "FROM cw.utility_states us JOIN (SELECT state, COUNT(DISTINCT disaster_number) AS declarations" in sql
    assert "COUNT(DISTINCT CASE WHEN incident_type = 'Severe Storm' THEN disaster_number END) AS severe_storm" in sql
    assert "AS fire" in sql and "AS flood" in sql and "NOT IN ('Severe Storm', 'Fire', 'Flood')" in sql and "AS other_incidents" in sql
    assert "FROM cw.fema_declarations_dr_2025q1 GROUP BY state) f ON f.state = us.state" in sql
    assert "JOIN cw.seed_utility_names n ON n.cik = us.cik ORDER BY f.declarations DESC, n.name, us.state" in sql
    assert "seed_utilities " not in sql  # never the 17-second UNION view
    assert cache.resolve(t.raw_objects, templates.resolved_params(t, {"quarter": "CY2024Q1"}))[1] == "cw.fema_declarations_dr_2024q1"
    t, sql = render("answer_revenue", {"period": "CY2024Q1", "cik_list": "0001326160,0000092122"})
    assert allowlist.check(sql, "reader") == "read"
    assert "ROW_NUMBER() OVER (PARTITION BY cik ORDER BY pri) AS rn" in sql and sql.endswith("WHERE rn = 1 ORDER BY cik")
    assert "WHERE u.cik IN ('0001326160', '0000092122')" in sql
    for i, tag in enumerate(("Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RegulatedAndUnregulatedOperatingRevenue"), 1):
        assert sql.count(f"FROM cw.frames_{tag}_CY2024Q1") == 1  # each view referenced once per statement
        assert f"'{tag}' AS xbrl_tag, CAST(val AS DOUBLE) AS val, accn, {i} AS pri" in sql
    assert sql.count("LPAD(CAST(cik AS STRING), 10, '0') AS cik") == 3
    with pytest.raises(BadParams):
        render("answer_revenue", {"period": "CY2024Q1", "cik_list": "1326160"})
    with pytest.raises(BadParams):
        render("answer_fema_utilities", {"quarter": "2025Q1"})
    assert render("seed_utility_names", {})[1] == "SELECT cik, name, ticker, sic FROM cw.seed_utility_names ORDER BY cik"


def test_usl_templates_and_onboarding_only_dq():
    assert render("usl_tables", {})[1] == f"SHOW NAMESPACES OR TABLES IN {USL}"
    assert render("usl_dq_rules", {})[1] == f"LIST DQ USL {USL}"
    assert render("usl_model", {})[1] == "LOAD USL crosswalk_usl NAMESPACE lightning.metastore.crosswalk"
    expected = {"utility.sic": "sic TABLE " + USL + ".utility", "utility_state.cik": "cik TABLE " + USL + ".utility_state",
                "utility_state.state": "state TABLE " + USL + ".utility_state",
                "fema_declaration.state": "state TABLE " + USL + ".fema_declaration",
                "station.state": "state TABLE " + USL + ".station", "revenue_quarter.cik": "cik TABLE " + USL + ".revenue_quarter"}
    assert set(expected) == set(templates.DQ_RULES)
    for rule, tail in expected.items():
        assert render("dq_run", {"rule": rule})[1] == f"RUN DQ {tail}"
        assert render("dq_invalid", {"rule": rule})[1] == f"SHOW DQ INVALID RECORD {tail}"
    for tid in ("dq_run", "dq_invalid"):
        t = templates.TEMPLATES[tid]
        assert t.onboarding_only and t.timeout_s == templates.DQ_TIMEOUT_S == 900.0 and t.role == "reader"
        with pytest.raises(BadParams):
            render(tid, {"rule": "weather_quarter.coverage_ok"})
    onboarding = {t.id for t in templates.TEMPLATES.values() if t.onboarding_only}
    assert onboarding == {"dq_run", "dq_invalid"}


def test_register_ghcn_plan_filters_the_seed_stations_from_one_year_and_element():
    plan = templates.REGISTRAR_PLANS["register_ghcn"]
    assert plan.params == {"year": "year", "element": "element"}
    assert [s.template_id for s in plan.steps] == ["registrar_ghcn_table", "registrar_ghcn_view", "registrar_ghcn_describe", "registrar_ghcn_cache"]
    _, table = render("registrar_ghcn_table", {"year": "2024", "element": "TMIN"})
    assert table.startswith("CREATE LIGHTNING FILESTORE TABLE ghcn_2024_tmin FROM CW_GHCN FORMAT PARQUET OPTIONS (")
    assert 'PATH "s3a://noaa-ghcn-pds/parquet/by_year/YEAR=2024/ELEMENT=TMIN/"' in table and 'isS3BucketPublic "true"' in table
    assert allowlist.check(table, "registrar") == "register"
    _, view = render("registrar_ghcn_view", {"year": "2024", "element": "TMIN"})
    assert view.startswith("CREATE SCHEMASTORE VIEW ghcn_2024_tmin WITH CONTAINER cw AS SELECT ID, DATE, DATA_VALUE")
    assert "FROM CW_GHCN.ghcn_2024_tmin WHERE ID IN ('USW00003017'," in view and allowlist.check(view, "registrar") == "register"
    assert len(templates.GHCN_STATIONS) == 57 and templates.VALIDATION_STATION in templates.GHCN_STATIONS
    assert render("registrar_ghcn_cache", {"year": "2025", "element": "TMAX"})[1] == "CACHE TABLE cw.ghcn_2025_tmax"
    t = templates.TEMPLATES["registrar_ghcn_cache"]
    assert templates.resolved_params(t, {"year": "2025", "element": "TMAX"})["element_lc"] == "tmax"


def test_register_source_names_catalogue_entries_and_plans():
    entries = templates.catalogue_entries()
    for cid, action in templates.SOURCE_PLANS.items():
        assert cid in entries and entries[cid]["status"] != "known_to_fail"
        assert action in templates.REGISTRAR_PLANS
        assert templates.validate_param("catalogue_id", cid) == cid
    assert set(templates.SOURCE_PLANS.values()) == {"register_fema", "register_stations", "register_frames", "register_submission", "register_ghcn"}
    assert "pudl" in entries and "pudl" not in templates.SOURCE_PLANS
    assert templates.registrar_actions()[-1] == "register_source" and "register_ghcn" in templates.registrar_actions()
