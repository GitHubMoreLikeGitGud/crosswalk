"""Call a Weather-or-Not gateway registrar plan with a freshly signed execution contract.

    .venv/Scripts/python scripts/registrar_call.py register_frames tag=Revenues period=CY2025Q2
    .venv/Scripts/python scripts/registrar_call.py register_submission cik10=0000753308 --note "seed utility"

An operator's tool for registering a Zetaris object by hand (a frames period, a filer's
companyconcept history or submissions profile) through the same contract-checked endpoint the
agent uses; the agent signs its own contracts (agent/src/contract/scout.ts). Reads
WON_CONTRACT_SECRET and GATEWAY_URL from .env.local (gateway.jdbc.load_env), posts
POST <gateway>/registrar/<action> and prints the reply as JSON. The reply keeps the User-Agent
placeholder; the declared value goes to Zetaris only. Exit status 0 on HTTP 200.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib import error, request

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from gateway import contracts, templates  # noqa: E402
from gateway.jdbc import load_env  # noqa: E402

DEFAULT_GATEWAY = "http://127.0.0.1:8793"


def make_contract(action: str, params: dict[str, str], secret: str, note: str | None = None, ttl_s: int = 600) -> dict:
    issued = datetime.now(timezone.utc)
    iso = lambda t: t.isoformat(timespec="seconds").replace("+00:00", "Z")  # noqa: E731
    c = {
        "contractId": f"ops-{uuid.uuid4()}",
        "traceId": f"ops-{issued.strftime('%Y%m%dT%H%M%SZ')}",
        "intent": {"primary": action, "parameters": params},
        "risk": {"level": contracts.risk_level(action) or "medium", "flags": [], "approvals": []},
        "toolPlan": [{"tool": f"registrar.{action}", "input": params}],
        "scope": {"user": "operator", "surface": "won-agent", "capabilities": [action]},
        "issuedAt": iso(issued),
        "expiresAt": iso(issued + timedelta(seconds=ttl_s)),
        "policyPackVersion": contracts.POLICY_PACK_VERSION,
        "signedBy": "scout",
    }
    if note:
        c["note"] = note
    return {**c, "signature": contracts.signature_for(c, secret)}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("action", help="a registrar plan: " + ", ".join(sorted(templates.REGISTRAR_PLANS)))
    p.add_argument("params", nargs="*", help="name=value pairs, the plan's parameters")
    p.add_argument("--gateway", default=None, help=f"gateway base URL (default GATEWAY_URL or {DEFAULT_GATEWAY})")
    p.add_argument("--note", default=None)
    p.add_argument("--timeout", type=float, default=900.0, help="seconds to wait for the reply (the CACHE step may take minutes)")
    args = p.parse_args(argv)
    load_env()
    plan = templates.REGISTRAR_PLANS.get(args.action)
    if plan is None:
        p.error(f"unknown action {args.action!r}; known: {sorted(templates.REGISTRAR_PLANS)}")
    params: dict[str, str] = {}
    for kv in args.params:
        if "=" not in kv:
            p.error(f"parameter must be name=value: {kv!r}")
        k, v = kv.split("=", 1)
        params[k] = v
    try:
        params = templates.plan_params(plan, params)
    except templates.BadParams as e:
        p.error(str(e))
    secret = contracts.load_secret()
    body = {**params, "contract": make_contract(args.action, params, secret, args.note)}
    base = (args.gateway or os.environ.get("GATEWAY_URL") or DEFAULT_GATEWAY).rstrip("/")
    req = request.Request(f"{base}/registrar/{args.action}", data=json.dumps(body).encode("utf-8"),
                          headers={"Content-Type": "application/json"}, method="POST")
    try:
        with request.urlopen(req, timeout=args.timeout) as r:
            status, text = r.status, r.read().decode("utf-8")
    except error.HTTPError as e:
        status, text = e.code, e.read().decode("utf-8", "replace")
    try:
        reply = json.loads(text)
    except ValueError:
        reply = {"raw": text}
    print(json.dumps({"status": status, "contract_id": body["contract"]["contractId"], "reply": reply}, indent=2, ensure_ascii=False))
    return 0 if status == 200 else 1


if __name__ == "__main__":
    sys.exit(main())
