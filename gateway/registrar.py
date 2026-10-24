"""The registrar endpoint: POST /registrar/<action> runs a registrar plan from
gateway/templates.py (an ordered list of registrar templates, for example the CREATE
LIGHTNING REST TABLE, CREATE SCHEMASTORE VIEW and CACHE TABLE of a frames period the agent
has not registered yet) under a medium-risk execution contract.

Adapted from ClearShelf (same author, Apache-2.0).

Before any statement is sent: the plan's parameters are validated with the template
patterns (400), then the contract is checked for this action and these parameters
(gateway/contracts.py: 403 and logged; a consumed contract is never accepted again).
Statements run one at a time on the gateway's registrar connection under the registrar
allowlist, while the cache warm-up is held off, and each is logged to
data/evidence/sql_log.jsonl. A step marked skip_exists treats Zetaris's "already exists"
as done. Once a statement has been sent, the contract is consumed whether or not the
remaining steps succeed.
"""

from __future__ import annotations

import re
import threading
from typing import Callable

from . import allowlist, contracts, templates
from .jdbc import QueryTimeout, ZetarisError, apply_user_agent
from .sqllog import log_statement, sha256

LOCK_WAIT_S = 600.0
ALREADY_EXISTS = re.compile(r"already exist", re.I)
HEAD_ROWS = 20


def _bad(code: str, error: str, status: int = 400) -> tuple[int, dict]:
    return status, {"error": error, "code": code}


class Registrar:
    def __init__(self, gateway, verifier: contracts.Verifier | None = None,
                 plans: dict[str, templates.Plan] | None = None) -> None:
        self.gw = gateway
        self._verifier = verifier
        self._plans = plans
        self._lock = threading.Lock()

    def plans(self) -> dict[str, templates.Plan]:
        return self._plans if self._plans is not None else templates.REGISTRAR_PLANS

    # -- shared steps -----------------------------------------------------------

    def _verifier_or_default(self) -> contracts.Verifier:
        return self._verifier or contracts.default_verifier()

    def _consume(self, raw) -> None:
        self._verifier_or_default().consume(raw)

    def _exclusive(self, fn: Callable[[], tuple[int, dict]]) -> tuple[int, dict]:
        """One registrar call at a time, and never while the warm-up sends its CACHE statements."""
        if not self._lock.acquire(timeout=LOCK_WAIT_S):
            return _bad("busy", "another registrar call is running", 503)
        try:
            if not self.gw._warm_lock.acquire(timeout=LOCK_WAIT_S):
                return _bad("busy", "the cache warm-up is running; retry", 503)
            try:
                return fn()
            finally:
                self.gw._warm_lock.release()
        finally:
            self._lock.release()

    # -- endpoint ---------------------------------------------------------------

    def run(self, action: str, body) -> tuple[int, dict]:
        plan = self.plans().get(action)
        if plan is None:
            return _bad("unknown_action", f"no registrar plan named {action!r}; known: {sorted(self.plans())}", 404)
        if not isinstance(body, dict):
            return _bad("bad_body", "the request body must be a JSON object")
        try:
            params = templates.plan_params(plan, body)
        except templates.BadParams as e:
            return _bad("bad_params", str(e))
        status, refusal = contracts.check_request(body.get("contract"), action, params, self._verifier)
        if refusal:
            return status, refusal
        return self._exclusive(lambda: self._run_plan(plan, params, body["contract"]))

    def _run_plan(self, plan: templates.Plan, params: dict[str, str], contract: dict) -> tuple[int, dict]:
        out: dict = {"action": plan.action, "params": params, "contract_id": contract["contractId"], "steps": [], "skipped": []}
        sent = False
        try:
            for step in plan.steps:
                t = templates.TEMPLATES.get(step.template_id)
                if t is None:
                    return 500, {**out, "error": f"plan {plan.action} names an unknown template {step.template_id}", "code": "bad_plan"}
                try:
                    _, sql = templates.render(t.id, {k: params[k] for k in t.params})
                    # The User-Agent placeholder is filled on the wire only; the log and the reply keep the placeholder.
                    wire = apply_user_agent(sql)
                    kind = allowlist.check(wire, "registrar")
                except (KeyError, templates.BadParams, allowlist.Refused, ZetarisError) as e:
                    # A plan or environment error, found before anything is sent: the contract stays unspent.
                    return 500, {**out, "error": f"plan {plan.action} step {t.id} cannot run: {e}", "code": "bad_plan"}
                entry = {"source_file": "gateway.registrar", "role": "registrar", "action": plan.action, "template_id": t.id,
                         "sql": sql, "sql_sha256": sha256(sql), "timeout_s": step.timeout_s}
                event: dict = {"template_id": t.id, "kind": kind, "sql": sql, "sql_sha256": entry["sql_sha256"], "objects": list(t.objects)}
                sent = True
                try:
                    res = self.gw._execute("registrar", wire, timeout_s=step.timeout_s, rewarm=False)
                except ZetarisError as e:
                    if step.skip_exists and ALREADY_EXISTS.search(str(e)):
                        log_statement({**entry, "error": str(e), "skipped_exists": True})
                        out["skipped"].append(t.id)
                        out["steps"].append({**event, "skipped_exists": True})
                        continue
                    log_statement({**entry, "error": str(e), "timeout": isinstance(e, QueryTimeout)})
                    out["steps"].append({**event, "error": str(e)[:1000]})
                    return 502, {**out, "error": str(e)[:1000], "code": "registrar_failed"}
                log_statement({**entry, "elapsed_ms": res.elapsed_ms, "row_count": res.row_count,
                               "executed_at": res.executed_at, "error": None})
                out["steps"].append({**event, "elapsed_ms": res.elapsed_ms, "executed_at": res.executed_at,
                                     "row_count": res.row_count, "columns": res.columns, "rows": res.rows[:HEAD_ROWS]})
            return 200, out
        finally:
            if sent:
                self._consume(contract)  # statements were sent: the contract is spent either way
