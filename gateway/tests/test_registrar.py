"""Registrar endpoint: contract first, then the plan's registrar statements (fake Zetaris; synthetic data)."""

import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from gateway import registrar, templates
from gateway.app import Gateway, create_app
from gateway.contracts import POLICY_PACK_VERSION, Verifier, signature_for
from gateway.jdbc import QueryResult, ZetarisError
from gateway.templates import Plan, Step, Template

SECRET = "test" * 10
ACTION = "register_frames"
UA = "WeatherOrNot/0.1 test"

FRAMES_TEMPLATES = [
    Template("registrar_frames_table",
             'CREATE LIGHTNING REST TABLE frames_{tag}_{period} FROM WON_SEC REQUEST( '
             'endpoint "https://data.sec.gov/api/xbrl/frames/us-gaap/{tag}/USD/{period}.json", method "get", '
             'response_type "json", http_encoding "URLENCODED" ) HEADER ( user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL" ) BODY ()',
             {"tag": "tag", "period": "period"}, ("WON_SEC.frames_{tag}_{period}",), (), "raw frames table", "registrar"),
    Template("registrar_frames_view",
             "CREATE SCHEMASTORE VIEW frames_{tag}_{period} WITH CONTAINER won AS SELECT f.cik, f.entityName, f.loc, f.val, f.accn "
             "FROM WON_SEC.frames_{tag}_{period} LATERAL VIEW explode(data) AS f",
             {"tag": "tag", "period": "period"}, ("won.frames_{tag}_{period}",), ("WON_SEC.frames_{tag}_{period}",), "flattened view", "registrar"),
    Template("registrar_frames_describe", "DESCRIBE won.frames_{tag}_{period}", {"tag": "tag", "period": "period"},
             ("won.frames_{tag}_{period}",), (), "columns of the view (no source call)", "reader"),
    Template("registrar_frames_cache", "CACHE TABLE won.frames_{tag}_{period}", {"tag": "tag", "period": "period"},
             ("won.frames_{tag}_{period}",), ("won.frames_{tag}_{period}",), "cache the view", "registrar"),
]
FRAMES_PLAN = Plan(ACTION, {"tag": "tag", "period": "period"},
                   (Step("registrar_frames_table", skip_exists=True), Step("registrar_frames_view", skip_exists=True),
                    Step("registrar_frames_describe"), Step("registrar_frames_cache", timeout_s=600.0)),
                   "Register one SEC frames period: raw REST table, flattened view, DESCRIBE, CACHE.")


def contract(action, params, cid="c-reg-1", issued=None):
    issued = issued or datetime.now(timezone.utc)
    c = {
        "contractId": cid, "traceId": "t-reg",
        "intent": {"primary": action, "parameters": params},
        "risk": {"level": "medium", "flags": [], "approvals": []},
        "toolPlan": [{"tool": f"registrar.{action}", "input": params}],
        "scope": {"user": "won-agent", "surface": "won-agent", "capabilities": [action]},
        "issuedAt": issued.isoformat().replace("+00:00", "Z"),
        "expiresAt": (issued + timedelta(minutes=15)).isoformat().replace("+00:00", "Z"),
        "policyPackVersion": POLICY_PACK_VERSION, "signedBy": "scout",
    }
    return {**c, "signature": signature_for(c, SECRET)}


class FakeZetaris:
    """Records every statement; `fail` maps a statement prefix to the error it raises (each time)."""

    def __init__(self, fail=None, storage=None):
        self.sql = []
        self.fail = dict(fail or {})
        self.storage = storage

    def execute(self, sql, timeout_s=None, max_rows=None):
        self.sql.append(sql)
        for prefix, error in self.fail.items():
            if sql.startswith(prefix):
                raise ZetarisError(error)
        if sql.startswith("CACHE TABLE ") and self.storage is not None:
            self.storage["cached"].add(sql.split()[-1].lower())
        rows = [["cik", "bigint", None], ["val", "double", None]] if sql.startswith("DESCRIBE") else []
        return QueryResult(sql=sql, columns=["col_name", "data_type", "comment"] if rows else [], rows=rows, row_count=len(rows),
                           elapsed_ms=7, executed_at="2026-10-24T18:00:00+0800")

    def close(self):
        pass


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setenv("WON_USER_AGENT", UA)
    for t in FRAMES_TEMPLATES:
        monkeypatch.setitem(templates.TEMPLATES, t.id, t)
    monkeypatch.setitem(templates.REGISTRAR_PLANS, ACTION, FRAMES_PLAN)
    storage = {"app_id": "local-1", "started_at_ms": 0, "cached": set()}
    conn = FakeZetaris(storage=storage)
    gw = Gateway(connect=lambda role: conn, storage=lambda: storage)
    gw.start_warmup = lambda: None
    verifier = Verifier(SECRET, name="test", directory=tmp_path / "contracts")
    reg = registrar.Registrar(gw, verifier=verifier)
    client = TestClient(create_app(gw, warm_on_start=False, registrar=reg))
    return client, conn, storage, verifier


P = {"tag": "Revenues", "period": "CY2025Q1"}


def sent(conn):
    """Statements other than the gateway's SELECT 1 liveness probe after an error."""
    return [s for s in conn.sql if s != "SELECT 1"]


def test_every_registrar_call_needs_its_own_contract_and_sends_nothing_without_it(setup):
    client, conn, _, verifier = setup
    r = client.post(f"/registrar/{ACTION}", json=P)
    assert r.status_code == 403 and r.json()["code"] == "missing"
    r = client.post(f"/registrar/{ACTION}", json={**P, "contract": contract(ACTION, {"tag": "Revenues", "period": "CY2024Q1"})})
    assert r.status_code == 403 and r.json()["code"] == "parameter_mismatch"
    r = client.post(f"/registrar/{ACTION}", json={**P, "contract": contract("register_off", P)})
    assert r.status_code == 403 and r.json()["code"] == "wrong_action"
    assert conn.sql == []
    assert [e["ok"] for e in verifier.entries] == [False] * 3


def test_unknown_actions_and_bad_params_are_refused_before_the_contract_check(setup):
    client, conn, _, verifier = setup
    r = client.post("/registrar/register_off", json={"gtin": "0816929000119", "contract": contract("register_off", {})})
    assert r.status_code == 404 and r.json()["code"] == "unknown_action"
    for bad in ({"tag": "Revenues", "period": "CY2025Q4"}, {"tag": "NetIncomeLoss", "period": "CY2025Q1"}, {"tag": "Revenues"},
                {"tag": "Revenues'; DROP TABLE t", "period": "CY2025Q1"}):
        r = client.post(f"/registrar/{ACTION}", json={**bad, "contract": contract(ACTION, bad)})
        assert r.status_code == 400 and r.json()["code"] == "bad_params"
    assert conn.sql == [] and verifier.entries == []


def test_register_frames_runs_the_plan_in_order_with_the_declared_user_agent(setup, temp_sql_log):
    client, conn, storage, _ = setup
    c = contract(ACTION, P)
    r = client.post(f"/registrar/{ACTION}", json={**P, "contract": c})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["action"] == ACTION and body["params"] == P and body["contract_id"] == "c-reg-1" and body["skipped"] == []
    assert [s["template_id"] for s in body["steps"]] == [s.template_id for s in FRAMES_PLAN.steps]
    assert [s["kind"] for s in body["steps"]] == ["register", "register", "read", "register"]
    assert conn.sql[0].startswith("CREATE LIGHTNING REST TABLE frames_Revenues_CY2025Q1 FROM WON_SEC")
    assert f'user-agent "{UA}"' in conn.sql[0] and "YOUR_APP_NAME" not in conn.sql[0]
    assert conn.sql[1].startswith("CREATE SCHEMASTORE VIEW frames_Revenues_CY2025Q1 WITH CONTAINER won AS SELECT")
    assert conn.sql[2] == "DESCRIBE won.frames_Revenues_CY2025Q1"
    assert conn.sql[3] == "CACHE TABLE won.frames_Revenues_CY2025Q1"
    assert body["steps"][2]["rows"] == [["cik", "bigint", None], ["val", "double", None]]
    assert "won.frames_revenues_cy2025q1" in storage["cached"]
    # The reply and the log keep the placeholder; the declared User-Agent went on the wire only.
    assert "YOUR_APP_NAME YOUR_CONTACT_EMAIL" in body["steps"][0]["sql"] and UA not in r.text
    log = temp_sql_log.read_text(encoding="utf-8")
    assert UA not in log
    rows = [json.loads(x) for x in log.splitlines()]
    assert len(rows) == 4 and all(x["role"] == "registrar" and x["source_file"] == "gateway.registrar" and x["action"] == ACTION for x in rows)
    assert [x["timeout_s"] for x in rows] == [120.0, 120.0, 120.0, 600.0]
    # One-shot: the same contract is refused afterwards, and nothing more is sent.
    n = len(conn.sql)
    again = client.post(f"/registrar/{ACTION}", json={**P, "contract": c})
    assert again.status_code == 403 and again.json()["code"] == "replayed"
    assert len(conn.sql) == n


def test_skip_exists_treats_an_existing_object_as_done(setup):
    client, conn, _, _ = setup
    conn.fail = {"CREATE LIGHTNING REST TABLE": "Table frames_Revenues_CY2025Q1 already exists in WON_SEC"}
    r = client.post(f"/registrar/{ACTION}", json={**P, "contract": contract(ACTION, P)})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["skipped"] == ["registrar_frames_table"] and body["steps"][0]["skipped_exists"] is True
    assert [s.split()[0] for s in sent(conn)] == ["CREATE", "CREATE", "DESCRIBE", "CACHE"]


def test_a_failing_step_stops_the_plan_reports_502_and_spends_the_contract(setup, temp_sql_log):
    client, conn, _, _ = setup
    conn.fail = {"CACHE TABLE": "HTTP 403 from data.sec.gov: missing User-Agent"}
    c = contract(ACTION, P)
    r = client.post(f"/registrar/{ACTION}", json={**P, "contract": c})
    assert r.status_code == 502
    body = r.json()
    assert body["code"] == "registrar_failed" and "HTTP 403" in body["error"]
    assert [s["template_id"] for s in body["steps"]] == [s.template_id for s in FRAMES_PLAN.steps]
    assert "error" in body["steps"][-1]
    rows = [json.loads(x) for x in temp_sql_log.read_text(encoding="utf-8").splitlines()]
    assert rows[-1]["error"].startswith("HTTP 403") and rows[-1]["timeout"] is False
    again = client.post(f"/registrar/{ACTION}", json={**P, "contract": c})
    assert again.status_code == 403 and again.json()["code"] == "replayed"


def test_a_failing_first_step_without_skip_exists_sends_nothing_else(setup):
    client, conn, _, _ = setup
    conn.fail = {"CREATE LIGHTNING REST TABLE": "connect timed out"}
    r = client.post(f"/registrar/{ACTION}", json={**P, "contract": contract(ACTION, P)})
    assert r.status_code == 502 and len(sent(conn)) == 1


def test_a_step_that_cannot_be_rendered_or_allowlisted_is_a_plan_error_that_sends_nothing(setup, monkeypatch):
    client, conn, _, _ = setup
    c = contract(ACTION, P)
    bad_host = Template("registrar_frames_table",
                        'CREATE LIGHTNING REST TABLE frames_{tag}_{period} FROM WON_SEC REQUEST( endpoint "https://example.org/{period}.json" ) '
                        'HEADER ( user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL" ) BODY ()',
                        {"tag": "tag", "period": "period"}, ("WON_SEC.frames_{tag}_{period}",), (), "host outside the allowlist", "registrar")
    monkeypatch.setitem(templates.TEMPLATES, bad_host.id, bad_host)
    r = client.post(f"/registrar/{ACTION}", json={**P, "contract": c})
    assert r.status_code == 500 and r.json()["code"] == "bad_plan" and "not allowlisted" in r.json()["error"]
    assert r.json()["steps"] == [] and conn.sql == []
    # Without the declared User-Agent no SEC statement is built at all.
    monkeypatch.setitem(templates.TEMPLATES, FRAMES_TEMPLATES[0].id, FRAMES_TEMPLATES[0])
    monkeypatch.delenv("WON_USER_AGENT")
    r = client.post(f"/registrar/{ACTION}", json={**P, "contract": c})
    assert r.status_code == 500 and r.json()["code"] == "bad_plan" and "WON_USER_AGENT" in r.json()["error"]
    assert conn.sql == []
    # Nothing was sent, so the same contract still runs the plan once the fault is fixed.
    monkeypatch.setenv("WON_USER_AGENT", UA)
    r = client.post(f"/registrar/{ACTION}", json={**P, "contract": c})
    assert r.status_code == 200 and len(conn.sql) == 4


def test_registrar_templates_never_run_through_sql_template(setup):
    client, conn, _, _ = setup
    r = client.post("/sql/template", json={"template_id": "registrar_frames_cache", "params": P, "role": "registrar"})
    assert r.status_code == 403 and "/registrar/" in r.json()["error"] and conn.sql == []
    r = client.post("/sql/template", json={"template_id": "registrar_frames_table", "params": P, "role": "reader"})
    assert r.status_code == 403 and conn.sql == []
    # A reader template that belongs to the plan runs normally.
    r = client.post("/sql/template", json={"template_id": "registrar_frames_describe", "params": P})
    assert r.status_code == 200 and conn.sql == ["DESCRIBE won.frames_Revenues_CY2025Q1"]


def test_health_lists_the_registrar_actions(setup):
    client, _, _, _ = setup
    body = client.get("/health").json()
    assert ACTION in body["registrar_actions"] and "registrar_frames_cache" in body["templates"]
