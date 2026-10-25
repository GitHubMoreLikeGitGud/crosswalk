"""The registrar endpoint: POST /registrar/<action> runs a registrar plan from
gateway/templates.py (an ordered list of registrar templates, for example the CREATE
LIGHTNING REST TABLE, CREATE SCHEMASTORE VIEW and CACHE TABLE of a frames period the agent
has not registered yet) under a medium-risk execution contract.

Adapted from Weather-or-Not and ClearShelf (same author, Apache-2.0).

Before any statement is sent: the plan's parameters are validated with the template
patterns (400), then the contract is checked for this action and these parameters
(gateway/contracts.py: 403 and logged; a consumed contract is never accepted again).
Statements run one at a time on the gateway's registrar connection under the registrar
allowlist, while the cache warm-up is held off, and each is logged to
data/evidence/sql_log.jsonl. A step marked skip_exists treats Zetaris's "already exists"
as done. Once a statement has been sent, the contract is consumed whether or not the
remaining steps succeed.

POST /registrar/register_source takes a catalogue id of seeds/catalogue.json plus the parameters
of the plan it maps to (templates.SOURCE_PLANS), under a contract for action register_source whose
parameters are {catalogue_id, ...plan parameters}. It is idempotent: the plan's DESCRIBE step runs
first, and a view that already exists answers already_registered: true (with a CACHE only if the
driver no longer holds it) instead of running the CREATE statements again.
"""

from __future__ import annotations

import re
import threading
from typing import Callable

from . import allowlist, cache, contracts, templates
from .jdbc import QueryTimeout, ZetarisError, apply_user_agent
from .sqllog import log_statement, sha256

LOCK_WAIT_S = 600.0
ALREADY_EXISTS = re.compile(r"already exist", re.I)
NOT_FOUND = re.compile(r"TABLE_OR_VIEW_NOT_FOUND|cannot be found|not found|does not exist", re.I)
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
        if action == templates.REGISTER_SOURCE:
            return self.run_source(body)
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

    def run_source(self, body) -> tuple[int, dict]:
        """register_source: catalogue id -> registrar plan, under a register_source contract."""
        if not isinstance(body, dict):
            return _bad("bad_body", "the request body must be a JSON object")
        try:
            cid = templates.validate_param("catalogue_id", body.get("catalogue_id"))
        except templates.BadParams as e:
            return _bad("bad_params", str(e))
        entry = templates.catalogue_entries().get(cid)
        if entry is None:
            return _bad("unknown_source", f"no seeds/catalogue.json entry {cid!r}", 404)
        if entry.get("status") == "known_to_fail":
            return _bad("known_to_fail", f"catalogue entry {cid} is known_to_fail; it is never registered", 403)
        plan = self.plans().get(templates.SOURCE_PLANS.get(cid, ""))
        if plan is None:
            return _bad("not_registrable", f"catalogue entry {cid} has no registrar plan; registrable: {sorted(templates.SOURCE_PLANS)}")
        try:
            params = templates.plan_params(plan, body)
        except templates.BadParams as e:
            return _bad("bad_params", str(e))
        status, refusal = contracts.check_request(body.get("contract"), templates.REGISTER_SOURCE, {"catalogue_id": cid, **params},
                                                  self._verifier)
        if refusal:
            return status, refusal
        head = {"action": templates.REGISTER_SOURCE, "catalogue_id": cid, "dispatched_to": plan.action}
        return self._exclusive(lambda: self._run_source_plan(head, plan, params, body["contract"]))

    def _run_source_plan(self, head: dict, plan: templates.Plan, params: dict[str, str], contract: dict) -> tuple[int, dict]:
        """DESCRIBE first: an existing view answers already_registered (CACHE only if evicted); else the whole plan."""
        kinds = {s.template_id: templates.TEMPLATES[s.template_id].sql.split()[0].upper() for s in plan.steps}
        describe = [s for s in plan.steps if kinds[s.template_id] == "DESCRIBE"]
        cache_steps = [s for s in plan.steps if kinds[s.template_id] == "CACHE"]
        if describe:
            status, out = self._run_plan(plan, params, contract, steps=tuple(describe), consume=False, missing_ok=True)
            if status == 200 and not out.get("missing"):
                pending = [s for s in cache_steps if not self._cached(s, params)]
                if pending:
                    status, more = self._run_plan(plan, params, contract, steps=tuple(pending), consume=False)
                    out["steps"] += more["steps"]
                    if status != 200:
                        self._consume(contract)
                        return status, {**out, **head, "already_registered": True, "error": more.get("error"), "code": more.get("code")}
                self._consume(contract)
                return 200, {**out, **head, "already_registered": True, "cache_ok": not pending or status == 200}
            if status != 200:
                self._consume(contract)
                return status, {**out, **head}
            first = out["steps"]
            status, out = self._run_plan(plan, params, contract)
            return status, {**out, **head, "already_registered": False, "steps": first + out["steps"]}
        status, out = self._run_plan(plan, params, contract)
        return status, {**out, **head, "already_registered": False}

    def _cached(self, step: templates.Step, params: dict[str, str]) -> bool:
        """True if the driver holds the object the CACHE step names (Spark UI storage; unknown counts as not cached)."""
        storage = self.gw._storage()
        if storage is None:
            return False
        t = templates.TEMPLATES[step.template_id]
        names = [o.lower() for o in cache.resolve(t.objects, templates.resolved_params(t, {k: params[k] for k in t.params}))]
        return bool(names) and all(n in storage["cached"] for n in names)

    def _run_plan(self, plan: templates.Plan, params: dict[str, str], contract: dict, steps: tuple[templates.Step, ...] | None = None,
                  consume: bool = True, missing_ok: bool = False) -> tuple[int, dict]:
        """Run the plan's steps (or `steps`) in order. missing_ok: a "not found" error is reported as
        out["missing"] = True with status 200 (the existence probe of register_source)."""
        out: dict = {"action": plan.action, "params": params, "contract_id": contract["contractId"], "steps": [], "skipped": []}
        sent = False
        try:
            for step in (steps if steps is not None else plan.steps):
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
                    if missing_ok and NOT_FOUND.search(str(e)):
                        log_statement({**entry, "error": str(e), "missing": True})
                        out["steps"].append({**event, "missing": True, "error": str(e)[:300]})
                        out["missing"] = True
                        return 200, out
                    log_statement({**entry, "error": str(e), "timeout": isinstance(e, QueryTimeout)})
                    out["steps"].append({**event, "error": str(e)[:1000]})
                    return 502, {**out, "error": str(e)[:1000], "code": "registrar_failed"}
                log_statement({**entry, "elapsed_ms": res.elapsed_ms, "row_count": res.row_count,
                               "executed_at": res.executed_at, "error": None})
                out["steps"].append({**event, "elapsed_ms": res.elapsed_ms, "executed_at": res.executed_at,
                                     "row_count": res.row_count, "columns": res.columns, "rows": res.rows[:HEAD_ROWS]})
            return 200, out
        finally:
            if sent and consume:
                self._consume(contract)  # statements were sent: the contract is spent either way
