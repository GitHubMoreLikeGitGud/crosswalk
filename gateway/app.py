"""Crosswalk Zetaris gateway: named templates over JDBC, on 127.0.0.1:8803.

Adapted from Weather-or-Not and ClearShelf (same author, Apache-2.0).

    .venv/Scripts/python -m gateway.app

Endpoints: GET /health; POST /sql/template (reader statements only: the agent sends a
template id and parameters, never SQL text); POST /registrar/<action> (a registrar plan
from gateway/templates.py, run under a medium-risk execution contract; gateway/registrar.py).
"""

from __future__ import annotations

import os
import threading
import time
from contextlib import asynccontextmanager
from typing import Callable

from fastapi import Body, FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import allowlist, cache, templates
from . import registrar as registrar_mod
from .jdbc import LightningConnection, QueryTimeout, ZetarisError, load_env
from .sqllog import log_statement, sha256

SERVICE = "crosswalk-gateway"
PORT = int(os.environ.get("CW_GATEWAY_PORT", "8803"))
MAX_ROWS = 200
FETCH_LIMIT = 10_000
QUERY_TIMEOUT_S = float(os.environ.get("GATEWAY_QUERY_TIMEOUT_S", "60"))
CACHE_TIMEOUT_S = 600.0  # a station-filtered view over the 9 parquet files of a GHCN year
RETRY_BASE_S = 60.0  # a failed CACHE waits this long before the next try, doubling each time
RETRY_MAX_S = 900.0
TEMPLATE_ROLES = ("reader", "registrar")
# Objects the warm-up keeps cached in the driver (SchemaStore views and raw CW_* tables the
# reader templates read). CW_CACHE_TARGETS (comma-separated qualified names) overrides it for
# a run. SEC: the views of won-reference/01_won_sec_create.sql, 02_won_dns_create.sql and
# 06_won_sec_seeds_create.sql (the frames periods of the two comparison quarters for the three
# revenue tags; the submissions profile of every seed utility; companyconcept of the four Day-0
# utilities plus the demo and warm-run utilities; the SIC reference). Periods and filers the
# registrar adds at run time are cached by the plan itself and re-cached here only if listed.
SEC_TAGS = ("Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RegulatedAndUnregulatedOperatingRevenue")
SEC_PERIODS = ("CY2025Q1", "CY2024Q1")
SEC_UTILITIES = templates.SEED_CIKS  # the 43 seeds of seeds/utilities.json (submissions views)
# Duke Energy, Southern Co, Xcel Energy, Entergy (Day 0); FirstEnergy and American Electric Power (Day 1) under the tags each filer uses.
SEC_CONCEPTS = tuple((c, "Revenues") for c in ("0001326160", "0000092122", "0000072903", "0000065984", "0001031296", "0000004904")) + (
    ("0001326160", "RegulatedAndUnregulatedOperatingRevenue"), ("0000072903", "RegulatedAndUnregulatedOperatingRevenue"),
    ("0001031296", "RevenueFromContractWithCustomerExcludingAssessedTax"), ("0000004904", "RevenueFromContractWithCustomerExcludingAssessedTax"))
# The Crosswalk objects registered on Day 0 (zetaris/manifest.json): the six frames views and the 43
# submission views (03_cw_sec), the SIC reference (04_cw_dns), the FEMA quarter and the catalogue (01_cw_fema),
# the seed views (05_cw_seeds; seed_utilities reads the 43 submission views, so it comes after them) and the
# stations inventory last (02_cw_stations; its CACHE scans the 11 MB file on S3, about 12 s). No companyconcept
# views are registered for Crosswalk. CW_CACHE_TARGETS overrides either way.
CACHE_TARGETS: tuple[str, ...] = templates.cache_targets_for(
    [(t, p) for t in SEC_TAGS for p in SEC_PERIODS], [], list(SEC_UTILITIES)) + (
    "cw.fema_declarations_dr_2025q1", "cw.fema_catalogue",
    "cw.states", "cw.utility_states", "cw.seed_stations", "cw.seed_utilities", "cw.seed_utility_names",
    "cw.stations",
)


class TemplateRequest(BaseModel):
    template_id: str
    params: dict[str, str] = Field(default_factory=dict)
    role: str = "reader"


def cache_targets() -> list[str]:
    """The cache targets, each checked against the registrar CACHE shape (a name outside
    cw.* / CW_*.* is a configuration error and raises allowlist.Refused)."""
    env = os.environ.get("CW_CACHE_TARGETS", "").strip()
    names = [x.strip() for x in env.split(",") if x.strip()] if env else list(CACHE_TARGETS)
    for n in names:
        allowlist.check(f"CACHE TABLE {n}", "registrar")
    return names


class Gateway:
    """One persistent connection per role, each behind its own lock."""

    def __init__(self, connect: Callable[[str], LightningConnection] | None = None,
                 storage: Callable[[], dict | None] | None = None) -> None:
        self._connect = connect or self._default_connect
        self._storage = storage or cache.spark_storage
        self._conns: dict[str, LightningConnection] = {}
        self._lock = threading.Lock()
        self._warm_lock = threading.Lock()
        self.reader_mode = "not_connected"
        self.last_app_id: str | None = None  # driver app whose warm-up left nothing failed or waiting
        self.last_warmup: dict | None = None
        self._retry: dict[str, tuple[int, float]] = {}  # target -> (failures so far, earliest next try)
        self._clock: Callable[[], float] = time.monotonic

    # -- connections --------------------------------------------------------

    def _default_connect(self, role: str) -> LightningConnection:
        if role == "reader":
            user = os.environ.get("ZETARIS_READER_USERNAME", "")
            pw = os.environ.get("ZETARIS_READER_PASSWORD", "")
            if user and len(pw) >= 8:  # Zetaris passwords are at least 8 characters
                c = LightningConnection(user, pw, name="reader")
                try:
                    c.connect()
                    self.reader_mode = "reader_user"
                    return c
                except ZetarisError:
                    self.reader_mode = "admin_fallback: reader login failed"
            else:
                self.reader_mode = "admin_fallback: no reader credentials"
        c = LightningConnection.from_env("admin")
        c.name = role
        return c

    def conn(self, role: str) -> LightningConnection:
        with self._lock:
            if role not in self._conns:
                self._conns[role] = self._connect(role)
            return self._conns[role]

    def _execute(self, role: str, sql: str, timeout_s: float, max_rows: int | None = None, rewarm: bool = True):
        """Execute; if it fails and the connection no longer answers SELECT 1,
        reconnect once and retry. A reconnect asks for a warm-up, which runs only
        if the driver restarted (the cache is driver-wide, not per session)."""
        c = self.conn(role)
        try:
            return c.execute(sql, timeout_s=timeout_s, max_rows=max_rows)
        except QueryTimeout:
            raise
        except ZetarisError as first:
            alive = True
            try:
                c.execute("SELECT 1", timeout_s=10)
            except ZetarisError:
                alive = False
            if alive:
                raise first
            c.close()
            if rewarm:
                self.start_warmup()
            return c.execute(sql, timeout_s=timeout_s, max_rows=max_rows)

    # -- warm-up ------------------------------------------------------------

    @staticmethod
    def _pending(targets: list[str], storage: dict) -> list[str]:
        return [t for t in targets if t.lower() not in storage["cached"]]

    def warmup(self, force: bool = False) -> dict:
        """CACHE TABLE every target that the driver does not hold in memory. A call
        for the driver app already warmed sends nothing while every target is cached.
        A failed CACHE leaves the app not warmed; later calls retry it after
        RETRY_BASE_S, doubling up to RETRY_MAX_S (force retries now)."""
        if not self._warm_lock.acquire(blocking=False):
            return {"skipped": "warm-up already running"}
        try:
            storage = self._storage()
            if storage is None:
                self.last_warmup = {"at": cache.now_iso(), "skipped": "spark ui unreachable"}
                return self.last_warmup
            app_id = storage["app_id"]
            targets_error = None
            try:
                targets = cache_targets()
            except allowlist.Refused as e:
                targets, targets_error = [], str(e)[:300]
            for t in [t for t in self._retry if t.lower() in storage["cached"]]:
                del self._retry[t]
            pending = self._pending(targets, storage)
            if not force and not pending and targets_error is None and app_id == self.last_app_id:
                return {"skipped": f"already warmed for driver app {app_id}"}
            now = self._clock()
            waiting = {t: round(self._retry[t][1] - now, 1) for t in pending
                       if not force and t in self._retry and self._retry[t][1] > now}
            todo = [t for t in pending if t not in waiting]
            done, failed = [], {}
            for t in todo:
                sql = f"CACHE TABLE {t}"
                entry = {"source_file": "gateway.warmup", "role": "registrar", "sql": sql, "timeout_s": CACHE_TIMEOUT_S}
                try:
                    res = self._execute("registrar", sql, timeout_s=CACHE_TIMEOUT_S, rewarm=False)
                    entry.update(elapsed_ms=res.elapsed_ms, executed_at=res.executed_at, error=None)
                    done.append(t)
                    self._retry.pop(t, None)
                except ZetarisError as e:
                    entry.update(error=str(e))
                    failed[t] = str(e)[:200]
                    n = self._retry.get(t, (0, 0.0))[0] + 1
                    self._retry[t] = (n, self._clock() + min(RETRY_BASE_S * 2 ** (n - 1), RETRY_MAX_S))
                log_statement(entry)
            result = {"at": cache.now_iso(), "app_id": app_id,
                      "already_cached": sum(1 for t in targets if t.lower() in storage["cached"]),
                      "cached_now": done, "failed": failed, "retry_in_s": waiting}
            if targets_error is not None:
                result["targets_error"] = targets_error
            if not failed and not waiting and targets_error is None:
                self.last_app_id = app_id
            self.last_warmup = result
            return result
        finally:
            self._warm_lock.release()

    def start_warmup(self) -> None:
        if self._warm_lock.locked():
            return
        threading.Thread(target=self.warmup, daemon=True, name="gateway-warmup").start()

    # -- endpoints ----------------------------------------------------------

    def health(self) -> dict:
        out: dict = {"ok": False, "service": SERVICE, "checked_at": cache.now_iso()}
        try:
            res = self._execute("reader", "SELECT 1", timeout_s=15)
            out["zetaris"] = {"select1": res.rows[0][0] if res.rows else None, "elapsed_ms": res.elapsed_ms}
            out["ok"] = bool(res.rows and res.rows[0][0] == 1)
        except ZetarisError as e:
            out["zetaris"] = {"error": str(e)[:300]}
        out["reader_mode"] = self.reader_mode
        storage = self._storage()
        out["cache"] = (
            {"app_id": storage["app_id"], "cached_tables": sorted(storage["cached"])} if storage else {"error": "spark ui unreachable"}
        )
        out["templates"] = sorted(templates.TEMPLATES)
        out["onboarding_only_templates"] = sorted(t.id for t in templates.TEMPLATES.values() if t.onboarding_only)
        out["registrar_actions"] = list(templates.registrar_actions())
        out["last_warmup"] = self.last_warmup
        return out

    def run_template(self, req: TemplateRequest) -> tuple[int, dict]:
        out: dict = {
            "template_id": req.template_id, "role": req.role, "columns": [], "rows": [], "row_count": 0,
            "truncated": False, "elapsed_ms": 0, "sql": None, "sql_sha256": None, "objects": [], "raw_objects": [],
            "executed_at": cache.now_iso(), "cache_state": "unknown", "cache_detail": {}, "source_cached_at": {}, "error": None,
        }
        if req.role not in TEMPLATE_ROLES:
            out["error"] = f"role must be one of {TEMPLATE_ROLES}"
            return 400, out
        try:
            t, sql = templates.render(req.template_id, req.params)
        except templates.BadParams as e:
            out["error"] = str(e)
            return 400, out
        params = templates.resolved_params(t, req.params)  # request values plus the DERIVED placeholders (quarter_slug)
        out.update(sql=sql, sql_sha256=sha256(sql), objects=cache.resolve(t.objects, params), raw_objects=cache.resolve(t.raw_objects, params))
        log = {"source_file": "gateway.template", "template_id": t.id, "role": req.role, "params": req.params,
               "sql": sql, "sql_sha256": out["sql_sha256"], "timeout_s": t.timeout_s or QUERY_TIMEOUT_S}
        try:
            kind = allowlist.check(sql, req.role)
        except allowlist.Refused as e:
            out["error"] = f"refused: {e}"
            log_statement({**log, "error": out["error"], "refused": True})
            return 403, out
        if kind != "read":
            out["error"] = "refused: registrar statements run through /registrar/<action> under a contract"
            log_statement({**log, "error": out["error"], "refused": True})
            return 403, out
        storage = self._storage()
        hold = None
        if storage is not None:
            try:
                targets = cache_targets()
            except allowlist.Refused:
                targets = []
            pending = self._pending(targets, storage)
            if pending or storage["app_id"] != self.last_app_id:
                self.start_warmup()  # first run, driver restart, evicted or failed CACHE
            waiting = {p.lower() for p in pending}
            uncached = [o for o in out["raw_objects"] if o.lower() in waiting]
            if uncached:
                # An uncached REST table is fetched from its source on every read.
                hold = (f"warming: {len(uncached)} object(s) not cached yet "
                        f"({', '.join(uncached[:3])}{', ...' if len(uncached) > 3 else ''}); retry after the warm-up")
        state, detail, cached_at = cache.cache_state(t.raw_objects, params, storage)
        out.update(cache_state=state, cache_detail=detail, source_cached_at=cached_at)
        if hold:
            out.update(error=hold, cache_state="miss")
            log_statement({**log, "error": hold, "sent": False, "cache_state": "miss"})
            return 503, out
        status = 200
        try:
            res = self._execute(req.role, sql, timeout_s=t.timeout_s or QUERY_TIMEOUT_S, max_rows=FETCH_LIMIT)
            out.update(columns=res.columns, rows=res.rows[:MAX_ROWS], row_count=res.row_count,
                       truncated=res.row_count > MAX_ROWS, elapsed_ms=res.elapsed_ms, executed_at=res.executed_at)
        except QueryTimeout as e:
            out["error"], status = f"timeout: {e}", 504
        except ZetarisError as e:
            out["error"], status = str(e)[:1000], 502
        log_statement({**log, "elapsed_ms": out["elapsed_ms"], "row_count": out["row_count"], "executed_at": out["executed_at"],
                       "cache_state": state, "error": out["error"]})
        return status, out


def create_app(gateway: Gateway | None = None, warm_on_start: bool = True, registrar=None) -> FastAPI:
    load_env()
    gw = gateway or Gateway()

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        if warm_on_start:
            gw.start_warmup()
        yield

    api = FastAPI(title="Crosswalk Zetaris gateway", version="0.1.0", lifespan=lifespan)
    api.state.gateway = gw

    @api.get("/health")
    def health() -> JSONResponse:
        body = gw.health()
        return JSONResponse(body, status_code=200 if body["ok"] else 503)

    @api.post("/sql/template")
    def sql_template(req: TemplateRequest) -> JSONResponse:
        status, body = gw.run_template(req)
        return JSONResponse(body, status_code=status)

    # Registrar plans (gateway/registrar.py): each call needs a medium-risk execution contract.
    reg = registrar if registrar is not None else registrar_mod.Registrar(gw)
    api.state.registrar = reg

    @api.post("/registrar/{action}")
    def registrar_action(action: str, body: dict = Body(...)) -> JSONResponse:
        status, out = reg.run(action, body)
        return JSONResponse(out, status_code=status)

    return api


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("gateway.app:app", host="127.0.0.1", port=PORT, log_level="info")
