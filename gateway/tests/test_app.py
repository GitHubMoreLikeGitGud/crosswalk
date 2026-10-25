import json

import pytest
from fastapi.testclient import TestClient

from gateway import allowlist, templates
from gateway import app as app_module
from gateway.app import Gateway, TemplateRequest, create_app
from gateway.jdbc import QueryResult, QueryTimeout, ZetarisError
from gateway.templates import Template

FRAMES = "cw.frames_revenues_cy2025q1"
GHCN = "cw_ghcn.ghcn_2025_tmax"
STORAGE = {"app_id": "local-1", "started_at_ms": 0, "cached": {FRAMES, GHCN}}
CONTRACT_KEYS = {"columns", "rows", "row_count", "truncated", "elapsed_ms", "sql", "sql_sha256", "objects", "raw_objects",
                 "executed_at", "cache_state", "cache_detail", "source_cached_at", "error"}
# A reader template over a cached view, as the Zetaris lane will add them.
FRAMES_COUNT = Template("frames_count", "SELECT COUNT(*) AS n FROM cw.frames_{tag}_{period}", {"tag": "tag", "period": "period"},
                        ("cw.frames_{tag}_{period}",), ("cw.frames_{tag}_{period}",), "facts in one frames period")
P = {"tag": "Revenues", "period": "CY2025Q1"}


@pytest.fixture(autouse=True)
def no_targets(monkeypatch):
    monkeypatch.delenv("CW_CACHE_TARGETS", raising=False)
    monkeypatch.setattr(app_module, "CACHE_TARGETS", ())


class FakeConn:
    def __init__(self, rows=None, fail=None):
        self.rows = rows if rows is not None else [[1]]
        self.fail = fail
        self.sql = []
        self.closed = 0

    def execute(self, sql, timeout_s=None, max_rows=None):
        self.sql.append(sql)
        if self.fail and sql != "SELECT 1":
            raise self.fail
        return QueryResult(sql=sql, columns=["c"], rows=self.rows, row_count=len(self.rows), elapsed_ms=5,
                           executed_at="2026-10-24T17:00:00+0800")

    def close(self):
        self.closed += 1


class CachingConn(FakeConn):
    """CACHE TABLE adds the table to `storage` (as the Spark UI then lists it); a table in
    `fail` answers CACHE with an error that many times."""

    def __init__(self, storage=None, fail=None):
        super().__init__(rows=[])
        self.storage = storage
        self.fail_cache = dict(fail or {})

    def execute(self, sql, timeout_s=None, max_rows=None):
        self.sql.append(sql)
        if sql.startswith("CACHE TABLE "):
            table = sql.split()[-1]
            if self.fail_cache.get(table, 0) > 0:
                self.fail_cache[table] -= 1
                raise ZetarisError("HTTP 503 from data.sec.gov")
            if self.storage is not None:
                self.storage["cached"].add(table.lower())
        return QueryResult(sql=sql, rows=[], elapsed_ms=5, executed_at="2026-10-24T17:00:00+0800")


def client(conn, storage=STORAGE):
    gw = Gateway(connect=lambda role: conn, storage=lambda: storage)
    gw.start_warmup = lambda: None  # no background warm-up sending statements mid-test
    return TestClient(create_app(gw, warm_on_start=False)), gw


def fresh(storage):
    return {**storage, "cached": set(storage["cached"])}


def test_health_ok():
    c, _ = client(FakeConn())
    r = c.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and body["zetaris"]["select1"] == 1 and body["service"] == "crosswalk-gateway"
    assert FRAMES in body["cache"]["cached_tables"]
    assert {"select1", "show_databases", "frames_period", "describe_object", "answer_fema_utilities", "submission", "sic"} <= set(body["templates"])
    assert body["registrar_actions"] == sorted(templates.REGISTRAR_PLANS) + ["register_source"] and "register_ghcn" in body["registrar_actions"]
    assert body["onboarding_only_templates"] == ["dq_invalid", "dq_run"]


def test_health_down():
    class Down(FakeConn):
        def execute(self, sql, timeout_s=None, max_rows=None):
            raise ZetarisError("connect failed")

    c, _ = client(Down(), storage=None)
    r = c.get("/health")
    assert r.status_code == 503 and r.json()["ok"] is False


def test_template_contract_and_log(temp_sql_log):
    conn = FakeConn()
    c, _ = client(conn)
    r = c.post("/sql/template", json={"template_id": "select1"})
    assert r.status_code == 200
    body = r.json()
    assert CONTRACT_KEYS <= set(body)
    assert body["rows"] == [[1]] and body["sql"] == "SELECT 1 AS ok" and body["cache_state"] == "unknown"
    assert conn.sql == ["SELECT 1 AS ok"]
    logged = [json.loads(line) for line in temp_sql_log.read_text(encoding="utf-8").splitlines()]
    assert logged[-1]["template_id"] == "select1" and logged[-1]["sql_sha256"] == body["sql_sha256"] and logged[-1]["role"] == "reader"


def test_rows_are_capped_and_the_count_kept():
    conn = FakeConn(rows=[[str(i)] for i in range(250)])
    c, _ = client(conn)
    body = c.post("/sql/template", json={"template_id": "show_databases"}).json()
    assert len(body["rows"]) == 200 and body["row_count"] == 250 and body["truncated"] is True


def test_template_bad_params_never_reach_zetaris():
    conn = FakeConn()
    c, _ = client(conn)
    for req in ({"template_id": "select1", "params": {"x": "1"}},
                {"template_id": "select1", "role": "onboard"},
                {"template_id": "product", "params": {"gtin": "0816929000119"}},
                {"template_id": "frames_count", "params": {"tag": "Revenues", "period": "CY2025Q1' OR 1=1 --"}}):
        r = c.post("/sql/template", json=req)
        assert r.status_code == 400, req
    assert conn.sql == []


def test_cached_view_template_reports_hit_and_resolved_raw_objects(monkeypatch, temp_sql_log):
    monkeypatch.setitem(templates.TEMPLATES, FRAMES_COUNT.id, FRAMES_COUNT)
    conn = FakeConn(rows=[[1937]])
    c, _ = client(conn)
    body = c.post("/sql/template", json={"template_id": "frames_count", "params": P}).json()
    assert body["rows"] == [[1937]] and body["cache_state"] == "hit"
    assert body["objects"] == ["cw.frames_Revenues_CY2025Q1"] and body["raw_objects"] == ["cw.frames_Revenues_CY2025Q1"]
    assert conn.sql == ["SELECT COUNT(*) AS n FROM cw.frames_Revenues_CY2025Q1"]
    body = c.post("/sql/template", json={"template_id": "frames_count", "params": {**P, "period": "CY2024Q1"}}).json()
    assert body["cache_state"] == "miss" and body["cache_detail"] == {"cw.frames_Revenues_CY2024Q1": "miss"}


def test_derived_placeholder_resolves_in_raw_objects_and_cache_state(temp_sql_log):
    # fema_by_state names its view through the DERIVED placeholder {quarter_slug}; the cache check must see
    # the resolved name, or every FEMA read reports a miss while the view is cached.
    storage = {"app_id": "local-1", "started_at_ms": 0, "cached": {"cw.fema_declarations_dr_2025q1"}}
    conn = FakeConn(rows=[["KY", 69, 1]])
    c, _ = client(conn, storage)
    body = c.post("/sql/template", json={"template_id": "fema_by_state", "params": {"quarter": "CY2025Q1"}}).json()
    assert body["rows"] == [["KY", 69, 1]] and body["cache_state"] == "hit"
    assert body["raw_objects"] == ["cw.fema_declarations_dr_2025q1"]
    assert body["cache_detail"] == {"cw.fema_declarations_dr_2025q1": "hit"}
    assert "cw.fema_declarations_dr_2025q1" in conn.sql[-1] and "{quarter_slug}" not in conn.sql[-1]
    body = c.post("/sql/template", json={"template_id": "fema_by_state", "params": {"quarter": "CY2024Q1"}}).json()
    assert body["cache_state"] == "miss" and body["cache_detail"] == {"cw.fema_declarations_dr_2024q1": "miss"}


def test_a_template_bound_overrides_the_gateway_default(temp_sql_log):
    class Timed(FakeConn):
        def __init__(self):
            super().__init__(rows=[["sic", "utility", "Foreign Key Constraint", 43, 42, 1]])
            self.timeouts = []

        def execute(self, sql, timeout_s=None, max_rows=None):
            self.timeouts.append(timeout_s)
            return super().execute(sql, timeout_s, max_rows)

    conn = Timed()
    c, _ = client(conn)
    assert c.post("/sql/template", json={"template_id": "dq_run", "params": {"rule": "utility.sic"}}).status_code == 200
    assert c.post("/sql/template", json={"template_id": "select1"}).status_code == 200
    assert conn.timeouts == [templates.DQ_TIMEOUT_S, app_module.QUERY_TIMEOUT_S]
    logged = [json.loads(line) for line in temp_sql_log.read_text(encoding="utf-8").splitlines()]
    assert [r["timeout_s"] for r in logged[-2:]] == [templates.DQ_TIMEOUT_S, app_module.QUERY_TIMEOUT_S]


def test_template_zetaris_error_is_502():
    conn = FakeConn(fail=ZetarisError("FIELD_NOT_FOUND"))
    c, _ = client(conn)
    r = c.post("/sql/template", json={"template_id": "show_databases"})
    assert r.status_code == 502 and "FIELD_NOT_FOUND" in r.json()["error"]


def test_template_timeout_is_504():
    conn = FakeConn(fail=QueryTimeout("no result within 60 s"))
    c, _ = client(conn)
    r = c.post("/sql/template", json={"template_id": "show_databases"})
    assert r.status_code == 504


def test_reconnects_once_when_connection_is_dead():
    class Flaky(FakeConn):
        def __init__(self):
            super().__init__()
            self.dead = True

        def execute(self, sql, timeout_s=None, max_rows=None):
            if self.dead:
                raise ZetarisError("connection reset")
            return super().execute(sql, timeout_s, max_rows)

        def close(self):
            self.dead = False

    conn = Flaky()
    gw = Gateway(connect=lambda role: conn, storage=lambda: None)
    assert gw._execute("reader", "SELECT 1", timeout_s=5).rows == [[1]]


def test_query_error_on_live_connection_is_not_retried():
    conn = FakeConn(fail=ZetarisError("syntax error"))
    gw = Gateway(connect=lambda role: conn, storage=lambda: None)
    with pytest.raises(ZetarisError):
        gw._execute("reader", "SELECT nope", timeout_s=5)
    assert conn.closed == 0


def test_default_cache_targets_are_the_sec_views_and_pass_the_cache_shape():
    targets = app_module.templates.cache_targets_for(
        [(t, p) for t in app_module.SEC_TAGS for p in app_module.SEC_PERIODS], list(app_module.SEC_CONCEPTS), list(app_module.SEC_UTILITIES))
    assert len(app_module.SEC_CONCEPTS) == 10 and app_module.SEC_UTILITIES == templates.SEED_CIKS and len(templates.SEED_CIKS) == 43
    assert len(targets) == len(set(targets)) == 6 + 10 + 43 + 1
    assert "cw.frames_Revenues_CY2025Q1" in targets and "cw.submission_0001326160" in targets and targets[-1] == "cw.sic_codes"
    assert "cw.submission_0001031296" in targets and "cw.concept_0000004904_RevenueFromContractWithCustomerExcludingAssessedTax" in targets
    for name in targets:
        assert allowlist.check(f"CACHE TABLE {name}", "registrar") == "register"


def test_cache_targets_come_from_the_constant_or_the_environment(monkeypatch):
    assert app_module.cache_targets() == []
    monkeypatch.setattr(app_module, "CACHE_TARGETS", (FRAMES, "CW_GHCN.ghcn_2025_tmax"))
    assert app_module.cache_targets() == [FRAMES, "CW_GHCN.ghcn_2025_tmax"]
    monkeypatch.setenv("CW_CACHE_TARGETS", " cw.weather_2025 ,cw.frames_revenues_cy2024q1 ")
    assert app_module.cache_targets() == ["cw.weather_2025", "cw.frames_revenues_cy2024q1"]
    monkeypatch.setenv("CW_CACHE_TARGETS", "ny_taxi.trips")
    with pytest.raises(allowlist.Refused):
        app_module.cache_targets()


def test_warmup_caches_only_missing(monkeypatch):
    monkeypatch.setenv("CW_CACHE_TARGETS", f"{FRAMES},cw.frames_revenues_cy2024q1")
    conn = FakeConn(rows=[])
    gw = Gateway(connect=lambda role: conn, storage=lambda: STORAGE)
    result = gw.warmup()
    assert result["cached_now"] == ["cw.frames_revenues_cy2024q1"] and result["already_cached"] == 1
    assert conn.sql == ["CACHE TABLE cw.frames_revenues_cy2024q1"]


def test_warmup_runs_once_per_driver_app(monkeypatch):
    monkeypatch.setenv("CW_CACHE_TARGETS", f"{FRAMES},{GHCN},cw.frames_revenues_cy2024q1")
    storage = fresh(STORAGE)
    conn = CachingConn(storage=storage)
    gw = Gateway(connect=lambda role: conn, storage=lambda: storage)
    first = gw.warmup()
    assert first["cached_now"] == ["cw.frames_revenues_cy2024q1"] and gw.last_app_id == "local-1"
    sent = list(conn.sql)
    assert gw.warmup()["skipped"].startswith("already warmed") and conn.sql == sent
    assert gw.last_warmup == first  # a skipped call does not replace the last result
    gw.warmup(force=True)  # nothing left to cache
    assert conn.sql == sent
    storage.update(app_id="local-2", cached=set())  # driver restart drops every cache
    gw.warmup()
    assert conn.sql[len(sent):] == [f"CACHE TABLE {FRAMES}", f"CACHE TABLE {GHCN}", "CACHE TABLE cw.frames_revenues_cy2024q1"]
    assert gw.last_app_id == "local-2"


def test_failed_cache_is_retried_with_backoff_not_dropped(monkeypatch, temp_sql_log):
    """A failed CACHE (the source answered 503) keeps the app not warmed; the next tries
    wait RETRY_BASE_S, then twice that, and the app is warmed once it succeeds."""
    bad = "cw.frames_revenues_cy2024q1"
    monkeypatch.setenv("CW_CACHE_TARGETS", f"{FRAMES},{bad}")
    storage = fresh(STORAGE)
    conn = CachingConn(storage=storage, fail={bad: 2})
    gw = Gateway(connect=lambda role: conn, storage=lambda: storage)
    clock = [1000.0]
    gw._clock = lambda: clock[0]
    first = gw.warmup()
    assert bad in first["failed"] and gw.last_app_id is None
    n = len(conn.sql)
    second = gw.warmup()  # same driver, inside the backoff: nothing is sent
    assert second["retry_in_s"] == {bad: app_module.RETRY_BASE_S} and conn.sql[n:] == []
    clock[0] += app_module.RETRY_BASE_S
    third = gw.warmup()
    assert bad in third["failed"] and conn.sql[n:].count(f"CACHE TABLE {bad}") == 1
    assert gw.warmup()["retry_in_s"] == {bad: 2 * app_module.RETRY_BASE_S}
    clock[0] += 2 * app_module.RETRY_BASE_S
    fourth = gw.warmup()
    assert fourth["cached_now"] == [bad] and fourth["failed"] == {} and gw.last_app_id == "local-1"
    assert gw.warmup()["skipped"].startswith("already warmed")
    logged = [json.loads(line) for line in temp_sql_log.read_text(encoding="utf-8").splitlines()]
    assert all(r["source_file"] == "gateway.warmup" and r["role"] == "registrar" for r in logged)


def test_a_bad_target_name_is_reported_and_never_sent(monkeypatch):
    monkeypatch.setenv("CW_CACHE_TARGETS", "ny_taxi.trips")
    conn = FakeConn(rows=[])
    gw = Gateway(connect=lambda role: conn, storage=lambda: fresh(STORAGE))
    result = gw.warmup()
    assert "ny_taxi.trips" in result["targets_error"] and conn.sql == [] and gw.last_app_id is None


def test_templates_over_a_pending_target_wait_for_the_warmup(monkeypatch, temp_sql_log):
    """While a cache target the template reads is not in the driver, the template gets 503
    and starts a warm-up; nothing reaches Zetaris. A template over other objects runs."""
    monkeypatch.setitem(templates.TEMPLATES, FRAMES_COUNT.id, FRAMES_COUNT)
    monkeypatch.setenv("CW_CACHE_TARGETS", FRAMES)
    storage = {"app_id": "local-1", "started_at_ms": 0, "cached": set()}
    conn = CachingConn(storage=storage)
    gw = Gateway(connect=lambda role: conn, storage=lambda: storage)
    started = []
    gw.start_warmup = lambda: started.append(1)
    status, body = gw.run_template(TemplateRequest(template_id="frames_count", params=P))
    assert status == 503 and body["error"].startswith("warming: ") and started and conn.sql == []
    assert body["cache_state"] == "miss" and body["cache_detail"] == {"cw.frames_Revenues_CY2025Q1": "miss"}
    logged = [json.loads(line) for line in temp_sql_log.read_text(encoding="utf-8").splitlines()]
    assert logged[-1]["template_id"] == "frames_count" and logged[-1]["sent"] is False
    status, _ = gw.run_template(TemplateRequest(template_id="select1"))
    assert status == 200  # reads no cache target
    gw.warmup()
    started.clear()
    status, body = gw.run_template(TemplateRequest(template_id="frames_count", params=P))
    assert status == 200 and body["cache_state"] == "hit" and not started
    # A period that is not a cache target is read live (miss, not held): the registrar caches it on registration.
    status, body = gw.run_template(TemplateRequest(template_id="frames_count", params={**P, "period": "CY2024Q1"}))
    assert status == 200 and body["cache_state"] == "miss"


def test_a_request_warms_a_driver_the_start_could_not_see(monkeypatch):
    monkeypatch.setitem(templates.TEMPLATES, FRAMES_COUNT.id, FRAMES_COUNT)
    monkeypatch.setenv("CW_CACHE_TARGETS", FRAMES)
    state = {"storage": None}
    conn = CachingConn()
    gw = Gateway(connect=lambda role: conn, storage=lambda: state["storage"])
    assert gw.warmup()["skipped"] == "spark ui unreachable" and gw.last_app_id is None
    state["storage"] = {"app_id": "local-new", "started_at_ms": 0, "cached": set()}
    started = []
    gw.start_warmup = lambda: started.append(1)
    status, _ = gw.run_template(TemplateRequest(template_id="frames_count", params=P))
    assert status == 503 and started and conn.sql == []


def test_spark_ui_down_gives_unknown_cache_state_and_still_runs(monkeypatch):
    monkeypatch.setitem(templates.TEMPLATES, FRAMES_COUNT.id, FRAMES_COUNT)
    conn = FakeConn(rows=[[1937]])
    c, _ = client(conn, storage=None)
    body = c.post("/sql/template", json={"template_id": "frames_count", "params": P}).json()
    assert body["rows"] == [[1937]] and body["cache_state"] == "unknown"
    assert body["cache_detail"] == {"cw.frames_Revenues_CY2025Q1": "spark_ui_unreachable"}


def test_reconnect_does_not_rewarm_the_same_driver(monkeypatch):
    monkeypatch.setenv("CW_CACHE_TARGETS", f"{FRAMES},cw.frames_revenues_cy2024q1")
    storage = fresh(STORAGE)
    conn = CachingConn(storage=storage)
    gw = Gateway(connect=lambda role: conn, storage=lambda: storage)
    gw.warmup()
    n = len(conn.sql)
    gw.warmup()  # what start_warmup() runs after a reconnect
    assert conn.sql[n:] == []
