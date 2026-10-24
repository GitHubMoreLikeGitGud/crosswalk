import pytest

from gateway import allowlist, templates
from gateway.templates import BadParams, Plan, Step, Template, render

SAMPLES = {"cik10": "0001326160", "tag": "Revenues", "period": "CY2025Q1", "year": "2025", "quarter": "1",
           "station": "USW00013740", "station_list": "USW00013740,USW00013722", "element": "TMAX", "sic": "4931"}
USL = "lightning.metastore.weatherornot.weather_or_not_usl"

FRAMES_CREATE = Template(
    "registrar_frames_table",
    'CREATE LIGHTNING REST TABLE frames_{tag}_{period} FROM WON_SEC REQUEST( '
    'endpoint "https://data.sec.gov/api/xbrl/frames/us-gaap/{tag}/USD/{period}.json", method "get", '
    'response_type "json", http_encoding "URLENCODED" ) HEADER ( user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL" ) BODY ()',
    {"tag": "tag", "period": "period"}, ("WON_SEC.frames_{tag}_{period}",), (), "One SEC frames period as a raw REST table.", "registrar")


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
    assert "FROM won.ghcn_2025_tmax x JOIN won.ghcn_2025_tmin n ON n.ID = x.ID AND n.DATE = x.DATE" in sql
    assert "WHERE x.ID IN ('USW00013740', 'USW00013722')" in sql
    assert "BETWEEN 3 * 1 - 2 AND 3 * 1" in sql  # the quarter's months from substr(DATE, 5, 2)
    assert "CASE 1 WHEN 1 THEN CASE WHEN 2025 % 4 = 0 THEN 91 ELSE 90 END WHEN 2 THEN 91 ELSE 92 END AS days_in_quarter" in sql
    # The arithmetic of agent/src/tools/degreeDays.ts: Tmean F from tenths of a degree C, base 65 F.
    assert "(((x.DATA_VALUE + n.DATA_VALUE) / 2.0) / 10.0 * 9.0 / 5.0 + 32)" in sql
    assert "SUM(GREATEST(0, 65 - (((x.DATA_VALUE" in sql and "AS hdd" in sql and "AS cdd" in sql
    assert "(x.Q_FLAG IS NULL OR x.Q_FLAG = '')" in sql and "(n.Q_FLAG IS NULL OR n.Q_FLAG = '')" in sql
    assert sql.endswith("GROUP BY x.ID ORDER BY x.ID")
    assert cache.resolve(t.raw_objects, params) == ["won.ghcn_2025_tmax", "won.ghcn_2025_tmin"]
    _, sql_2024 = render("weather_quarter", {**params, "year": "2024", "quarter": "3", "station_list": "USW00013740"})
    assert "FROM won.ghcn_2024_tmax x JOIN won.ghcn_2024_tmin n" in sql_2024 and "IN ('USW00013740')" in sql_2024
    assert "BETWEEN 3 * 3 - 2 AND 3 * 3" in sql_2024


def test_weather_quarter_refuses_an_unquoted_or_injected_station_list():
    for bad in ("USW00013740;USW00013722", "USW00013740') OR ('1'='1", "USW00013740, USW00013722", "'USW00013740'"):
        with pytest.raises(BadParams):
            render("weather_quarter", {"year": "2025", "quarter": "1", "station_list": bad})


def test_usl_and_dq_templates_render_to_fixed_reader_statements():
    assert render("usl_describe", {})[1] == "LOAD USL weather_or_not_usl NAMESPACE lightning.metastore.weatherornot"
    assert render("dq_invalid", {})[1] == f"SHOW DQ INVALID RECORD coverage_ok TABLE {USL}.weather_quarter"
    assert render("dq_run_coverage", {})[1] == f"RUN DQ coverage_ok TABLE {USL}.weather_quarter"
    for tid in ("usl_describe", "dq_invalid", "dq_run_coverage"):
        t = templates.TEMPLATES[tid]
        assert allowlist.check(t.sql, "reader") == "read" and t.params == {}
    assert templates.TEMPLATES["dq_invalid"].raw_objects == templates.GHCN_VIEWS
    # DQ on a USL table over the filestore views is slow (minutes); the other templates keep the gateway default.
    assert templates.TEMPLATES["dq_invalid"].timeout_s == templates.TEMPLATES["dq_run_coverage"].timeout_s == templates.DQ_TIMEOUT_S == 600.0
    assert templates.TEMPLATES["usl_describe"].timeout_s is None and templates.TEMPLATES["weather_quarter"].timeout_s is None


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
    assert "frames_RevenueFromContractWithCustomerExcludingAssessedTax_CY2024Q2 FROM WON_SEC" in sql
    assert 'endpoint "https://data.sec.gov/api/xbrl/frames/us-gaap/RevenueFromContractWithCustomerExcludingAssessedTax/USD/CY2024Q2.json"' in sql
    assert allowlist.check(sql, "registrar") == "register"
    with pytest.raises(allowlist.Refused):
        allowlist.check(sql, "reader")


def test_reader_templates_read_the_cached_views_with_the_agreed_columns():
    _, sql = render("frames_period", {"tag": "Revenues", "period": "CY2025Q1"})
    assert sql == "SELECT cik, `entityName`, loc, `start`, `end`, val, accn FROM won.frames_Revenues_CY2025Q1 ORDER BY cik"
    _, sql = render("frames_fact", {"tag": "RegulatedAndUnregulatedOperatingRevenue", "period": "CY2024Q1", "cik10": "0001326160"})
    assert sql.endswith("FROM won.frames_RegulatedAndUnregulatedOperatingRevenue_CY2024Q1 WHERE LPAD(CAST(cik AS STRING), 10, '0') = '0001326160'")
    t, sql = render("concept_history", {"cik10": "0000092122", "tag": "Revenues"})
    assert sql.startswith("SELECT fy, fp, form, filed, accn, `start`, `end`, val FROM won.concept_0000092122_Revenues")
    assert t.raw_objects == ("won.concept_{cik10}_{tag}",)
    t, sql = render("concept_window", {"cik10": "0000004904", "tag": "Revenues", "year": "2025"})
    assert sql == ("SELECT fy, fp, form, filed, accn, `start`, `end`, val FROM won.concept_0000004904_Revenues "
                   "WHERE CAST(substr(`end`, 1, 4) AS INT) BETWEEN 2025 - 1 AND 2025 ORDER BY `end`, filed, accn")
    assert t.raw_objects == ("won.concept_{cik10}_{tag}",) and allowlist.check(sql, "reader") == "read"
    with pytest.raises(BadParams):
        render("concept_window", {"cik10": "0000004904", "tag": "Revenues", "year": "1999"})
    _, sql = render("submission", {"cik10": "0000065984"})
    assert sql == "SELECT cik, name, sic, `sicDescription`, state FROM won.submission_0000065984"
    assert "street" not in sql.lower()
    _, sql = render("sic", {"code": "4911"})
    assert sql == "SELECT code, description, division, division_desc, major_group, major_group_desc FROM won.sic_codes WHERE code = '4911'"
    for tid in ("frames_period", "frames_count", "frames_fact", "concept_history", "concept_window", "submission", "sic"):
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


def test_frames_seeds_filters_a_period_to_the_seed_ciks_as_integers_and_casts_val():
    from gateway import cache

    t, sql = render("frames_seeds", {"tag": "Revenues", "period": "CY2025Q1"})
    assert t.role == "reader" and allowlist.check(sql, "reader") == "read"
    assert sql.startswith("SELECT cik, `entityName`, loc, `start`, `end`, CAST(val AS DOUBLE) AS val, accn FROM won.frames_Revenues_CY2025Q1 WHERE CAST(cik AS BIGINT) IN (")
    assert sql.endswith(") ORDER BY cik")
    in_list = sql.split("IN (")[1].split(")")[0].split(", ")
    assert len(in_list) == 43 and all(x.isdigit() for x in in_list) and "1031296" in in_list and "4904" in in_list
    assert "'" not in sql  # integers, never quoted strings
    assert cache.resolve(t.raw_objects, {"tag": "Revenues", "period": "CY2025Q1"}) == ["won.frames_Revenues_CY2025Q1"]
    _, sql2 = render("frames_seeds", {"tag": "RegulatedAndUnregulatedOperatingRevenue", "period": "CY2024Q1"})
    assert "FROM won.frames_RegulatedAndUnregulatedOperatingRevenue_CY2024Q1 WHERE" in sql2


def test_usl_reader_templates_read_the_governed_sec_tables():
    t, sql = render("usl_utility", {"cik10": "0001031296"})
    assert sql == f"SELECT cik, name, ticker, sic, hq_state FROM {USL}.utility WHERE cik = '0001031296'"
    assert t.role == "reader" and allowlist.check(sql, "reader") == "read" and t.objects == (f"{USL}.utility",)
    assert len(t.raw_objects) == 43 and "won.submission_0001031296" in t.raw_objects and t.timeout_s == 300.0
    t, sql = render("usl_revenue", {"cik10": "0000004904", "period": "CY2025Q1"})
    assert sql == (f"SELECT cik, xbrl_tag, year, quarter, val, accn, filed, is_comparative FROM {USL}.revenue_quarter "
                   "WHERE cik = '0000004904' AND CONCAT('CY', CAST(year AS STRING), 'Q', CAST(quarter AS STRING)) = 'CY2025Q1' ORDER BY xbrl_tag, accn")
    assert allowlist.check(sql, "reader") == "read" and t.objects == (f"{USL}.revenue_quarter",)
    assert len(t.raw_objects) == 6 and "won.frames_Revenues_CY2024Q1" in t.raw_objects
    with pytest.raises(BadParams):
        render("usl_revenue", {"cik10": "0000004904", "period": "CY2025Q4"})
    with pytest.raises(BadParams):
        render("usl_utility", {"cik10": "4904"})


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
    assert view.startswith("CREATE SCHEMASTORE VIEW frames_Revenues_CY2025Q2 WITH CONTAINER won AS SELECT")
    assert "FROM WON_SEC.frames_Revenues_CY2025Q2 LATERAL VIEW explode(data) AS f" in view
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
    assert out == ("won.frames_Revenues_CY2025Q1", "won.concept_0001326160_Revenues", "won.submission_0000092122", "won.sic_codes")
    for name in out:
        assert allowlist.check(f"CACHE TABLE {name}", "registrar") == "register"


def test_plan_params_take_the_plan_parameters_from_a_request_body():
    plan = Plan("register_frames", {"tag": "tag", "period": "period"}, (Step("registrar_frames_table", skip_exists=True),))
    body = {"tag": "Revenues", "period": "CY2025Q1", "contract": {"contractId": "c-1"}}
    assert templates.plan_params(plan, body) == {"tag": "Revenues", "period": "CY2025Q1"}
    for bad in ({"tag": "Revenues"}, {"tag": "Revenues", "period": "CY2025Q4"}, {"tag": 1, "period": "CY2025Q1"}):
        with pytest.raises(BadParams):
            templates.plan_params(plan, bad)
