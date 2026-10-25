import json
from datetime import datetime, timedelta, timezone

import pytest

from gateway import contracts, templates
from gateway.contracts import (POLICY_PACK_VERSION, ContractError, Verifier, canonical_json, check_request,
                               signature_for, verify_contract)
from gateway.templates import Plan, Step

# Test secret only, shared with agent/test/fixtures/contract-vector.ts.
SECRET = "test" * 10
T0 = datetime(2026, 10, 25, 10, 0, 0, tzinfo=timezone.utc)
ACTION = "register_frames"
PARAMS = {"tag": "Revenues", "period": "CY2025Q1"}
PLAN = Plan(ACTION, {"tag": "tag", "period": "period"}, (Step("registrar_frames_table", skip_exists=True),))

# The same contract as agent/test/fixtures/contract-vector.ts; both sides must give VECTOR_SIGNATURE.
VECTOR = {
    "contractId": "c-vector-0001",
    "traceId": "t-vector",
    "intent": {"primary": ACTION,
               "parameters": {**PARAMS, "note": "Café \"quoted\" \\ tab\t line\n é ü \U0001F36B"}},
    "risk": {"level": "medium", "flags": ["vector"], "approvals": []},
    "toolPlan": [{"tool": "registrar.register_frames", "input": PARAMS}],
    "scope": {"user": "cw-agent", "surface": "cw-agent", "capabilities": [ACTION]},
    "issuedAt": "2026-10-25T10:00:00.000Z",
    "expiresAt": "2026-10-25T10:15:00.000Z",
    "policyPackVersion": POLICY_PACK_VERSION,
    "signedBy": "scout",
}
VECTOR_SIGNATURE = "5ee92a7e14ec244da0ae603ef465588a0b4d223635187afc37a73a26ac5feeba"


@pytest.fixture(autouse=True)
def frames_plan(monkeypatch):
    """Registrar actions come from the plan registry; the tests register one plan."""
    monkeypatch.setitem(templates.REGISTRAR_PLANS, ACTION, PLAN)


def signed(c: dict) -> dict:
    return {**c, "signature": signature_for(c, SECRET)}


def contract(action=ACTION, params=None, level=None, surface="cw-agent", approvals=None,
             issued=T0, ttl=timedelta(minutes=15)) -> dict:
    params = params if params is not None else dict(PARAMS)
    return signed({
        "contractId": "c-test-1", "traceId": "t-test",
        "intent": {"primary": action, "parameters": params},
        "risk": {"level": level or contracts.risk_level(action) or "medium", "flags": [], "approvals": approvals or []},
        "toolPlan": [{"tool": f"registrar.{action}", "input": params}],
        "scope": {"user": "cw-agent", "surface": surface, "capabilities": [action]},
        "issuedAt": issued.isoformat().replace("+00:00", "Z"),
        "expiresAt": (issued + ttl).isoformat().replace("+00:00", "Z"),
        "policyPackVersion": POLICY_PACK_VERSION, "signedBy": "scout",
    })


def test_shared_vector_matches_typescript():
    assert signature_for(VECTOR, SECRET) == VECTOR_SIGNATURE


def test_canonical_json_rules():
    assert canonical_json({"b": 1, "a": {"d": [1, "x"], "c": None}}) == '{"a":{"c":null,"d":[1,"x"]},"b":1}'
    assert canonical_json({"s": 'é"\\\n\u0001'}) == '{"s":"é\\"\\\\\\n\\u0001"}'
    with pytest.raises(ContractError):
        canonical_json({"x": 1.5})
    with pytest.raises(ContractError):
        canonical_json({"x": "\ud800"})
    with pytest.raises(ContractError):
        canonical_json({"é": 1})


def test_risk_classes_follow_the_plan_registry():
    assert contracts.risk_level("read") == "low"
    assert contracts.risk_level(ACTION) == "medium"
    assert contracts.risk_level("register_off") is None
    assert ACTION in contracts.registrar_actions() and set(contracts.registrar_actions()) == set(templates.REGISTRAR_PLANS)


def test_accepts_a_valid_registrar_contract():
    assert verify_contract(contract(), ACTION, PARAMS, SECRET, T0 + timedelta(seconds=5)) is None


@pytest.mark.parametrize("mutate,code", [
    (lambda c: {**c, "intent": {**c["intent"], "parameters": {"tag": "Revenues", "period": "CY2024Q1"}}}, "bad_signature"),
    (lambda c: {**c, "signedBy": "someone"}, "wrong_signer"),
    (lambda c: {**c, "policyPackVersion": "clearshelf-scout-subset@1"}, "wrong_policy_pack"),
    (lambda c: {k: v for k, v in c.items() if k != "signature"}, "malformed"),
    (lambda c: None, "missing"),
    (lambda c: "contract", "malformed"),
])
def test_refuses_tampered_or_missing(mutate, code):
    r = verify_contract(mutate(contract()), ACTION, {"tag": "Revenues", "period": "CY2024Q1"}, SECRET, T0)
    assert r is not None and r.code == code


def test_refuses_expired_early_long_ttl_and_wrong_secret():
    assert verify_contract(contract(), ACTION, PARAMS, SECRET, T0 + timedelta(minutes=15)).code == "expired"
    assert verify_contract(contract(), ACTION, PARAMS, SECRET, T0 - timedelta(minutes=5)).code == "not_yet_valid"
    assert verify_contract(contract(ttl=timedelta(minutes=16)), ACTION, PARAMS, SECRET, T0).code == "ttl_too_long"
    assert verify_contract(contract(), ACTION, PARAMS, SECRET + "x", T0).code == "bad_signature"


def test_refuses_wrong_action_parameters_risk_and_surface():
    assert verify_contract(contract(), "register_off", PARAMS, SECRET, T0).code == "wrong_action"
    assert verify_contract(contract(action="register_off", level="medium"), "register_off", PARAMS, SECRET, T0).code == "wrong_action"
    assert verify_contract(contract(), ACTION, {**PARAMS, "period": "CY2024Q1"}, SECRET, T0).code == "parameter_mismatch"
    assert verify_contract(contract(level="low"), ACTION, PARAMS, SECRET, T0).code == "risk_mismatch"
    assert verify_contract(contract(surface="clearshelf-agent"), ACTION, PARAMS, SECRET, T0).code == "out_of_scope"


def test_high_risk_needs_an_analyst_approval_on_the_ui_surface(monkeypatch):
    monkeypatch.setitem(contracts.RISK_CLASSES, "override_recast", "high")
    p = {"cik": "0001326160", "period": "CY2025Q1"}
    no_approval = contract("override_recast", p, surface="cw-ui")
    assert verify_contract(no_approval, "override_recast", p, SECRET, T0).code == "approval_missing"
    approval = [{"kind": "analyst-approval", "by": "analyst", "at": "2026-10-25T10:00:00.000Z", "decision": "approve", "reason": "original filing is the like-for-like base"}]
    assert verify_contract(contract("override_recast", p, surface="cw-ui", approvals=approval), "override_recast", p, SECRET, T0) is None
    assert verify_contract(contract("override_recast", p, surface="cw-agent", approvals=approval), "override_recast", p, SECRET, T0).code == "approval_missing"


def test_verifier_logs_consumes_and_refuses_replay(tmp_path):
    v = Verifier(SECRET, "test", tmp_path, clock=lambda: T0 + timedelta(seconds=1))
    c = contract()
    assert v.verify(c, ACTION, PARAMS) is None
    v.consume(c)
    assert v.verify(c, ACTION, PARAMS).code == "replayed"
    log = [json.loads(line) for line in (tmp_path / "verifier-test.jsonl").read_text(encoding="utf-8").splitlines()]
    assert [(e["ok"], e["code"]) for e in log] == [(True, None), (False, "replayed")]
    assert SECRET not in (tmp_path / "verifier-test.jsonl").read_text(encoding="utf-8")
    assert Verifier(SECRET, "test", tmp_path, clock=lambda: T0).verify(c, ACTION, PARAMS).code == "replayed"


def test_check_request_refuses_unknown_actions_and_bad_contracts(tmp_path):
    v = Verifier(SECRET, "test", tmp_path, clock=lambda: T0 + timedelta(seconds=1))
    status, body = check_request(contract(), "register_off", PARAMS, verifier=v)
    assert status == 403 and body["code"] == "wrong_action"
    status, body = check_request(None, ACTION, PARAMS, verifier=v)
    assert status == 403 and body["code"] == "missing"
    assert check_request(contract(), ACTION, PARAMS, verifier=v) == (200, None)


def test_load_secret_reads_the_won_key(monkeypatch):
    monkeypatch.delenv("CW_CONTRACT_SECRET", raising=False)
    with pytest.raises(ContractError):
        contracts.load_secret()
    monkeypatch.setenv("CW_CONTRACT_SECRET", "short")
    with pytest.raises(ContractError):
        contracts.load_secret()
    monkeypatch.setenv("CW_CONTRACT_SECRET", SECRET)
    assert contracts.load_secret() == SECRET
