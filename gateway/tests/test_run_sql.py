import json

import pytest

from gateway import run_sql
from gateway.jdbc import QueryResult

FRAMES_URL = "https://data.sec.gov/api/xbrl/frames/us-gaap/Revenues/USD/CY2025Q1.json"
SEC_FILE = f'''
CREATE LIGHTNING REST TABLE frames_revenues_cy2025q1 FROM CW_SEC REQUEST(
    endpoint "{FRAMES_URL}", method "get", response_type "json", http_encoding "URLENCODED"
) HEADER ( user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL" ) BODY ();
DESCRIBE CW_SEC.frames_revenues_cy2025q1;
CACHE TABLE CW_SEC.frames_revenues_cy2025q1;
SELECT COUNT(*) AS n FROM CW_SEC.frames_revenues_cy2025q1;
UNCACHE TABLE CW_SEC.frames_revenues_cy2025q1;
SELECT 1;
RUN DQ coverage_ok TABLE lightning.metastore.crosswalk.crosswalk_usl.weather_quarter
'''


class FakeConnection:
    instances: list = []

    def __init__(self):
        self.calls = []

    @classmethod
    def from_env(cls, role="admin"):
        c = cls()
        cls.instances.append(c)
        return c

    def execute(self, sql, timeout_s=None, max_rows=None):
        self.calls.append((sql, timeout_s))
        rows = [[3, 2, 1]] if sql.startswith("RUN DQ") else [[1]]
        return QueryResult(sql=sql, columns=["a", "b", "c"][: len(rows[0])], rows=rows, row_count=1, elapsed_ms=1,
                           executed_at="2026-10-24T17:00:00+0800")

    def close(self):
        pass


@pytest.fixture
def runner(tmp_path, monkeypatch):
    monkeypatch.setattr(run_sql, "load_env", lambda *a, **k: None)
    monkeypatch.setenv("CW_USER_AGENT", "Crosswalk/0.1 test")
    monkeypatch.setattr(run_sql, "LightningConnection", FakeConnection)
    sleeps = []
    monkeypatch.setattr(run_sql.time, "sleep", lambda s: sleeps.append(s))
    FakeConnection.instances = []
    f = tmp_path / "t.sql"
    f.write_text(SEC_FILE, encoding="utf-8")
    return f, sleeps


def test_sec_statements_are_spaced_without_a_flag(runner, temp_sql_log):
    f, sleeps = runner
    assert run_sql.main([str(f)]) == 0
    # CREATE (first, no wait), DESCRIBE, CACHE, SELECT COUNT on the SEC table: three waits of at least 0.1 s
    assert len(sleeps) == 3 and all(s >= 0.09 for s in sleeps)
    logged = [json.loads(line) for line in temp_sql_log.read_text(encoding="utf-8").splitlines()]
    spaced = [r["sql"].split()[0] for r in logged if "spaced_s" in r]
    assert spaced == ["DESCRIBE", "CACHE", "SELECT"]


def test_user_agent_is_filled_on_the_wire_and_kept_out_of_the_log(runner, temp_sql_log):
    f, _ = runner
    assert run_sql.main([str(f)]) == 0
    create = FakeConnection.instances[-1].calls[0][0]
    assert 'user-agent "Crosswalk/0.1 test"' in create and "YOUR_APP_NAME" not in create
    log = temp_sql_log.read_text(encoding="utf-8")
    assert "YOUR_APP_NAME YOUR_CONTACT_EMAIL" in log and "Crosswalk/0.1 test" not in log


def test_spacing_flag_only_raises_the_sec_floor(runner):
    f, sleeps = runner
    assert run_sql.main([str(f), "--spacing", "0.05"]) == 0
    assert len(sleeps) == 3 and all(s >= 0.09 for s in sleeps)
    sleeps.clear()
    assert run_sql.main([str(f), "--spacing", "2"]) == 0
    assert all(s >= 1.9 for s in sleeps)


def test_dq_timeout_default_and_logged(runner, temp_sql_log):
    f, _ = runner
    assert run_sql.main([str(f)]) == 0
    calls = dict(FakeConnection.instances[-1].calls)
    assert calls["RUN DQ coverage_ok TABLE lightning.metastore.crosswalk.crosswalk_usl.weather_quarter"] == 120.0
    assert calls["SELECT 1"] == 600.0
    logged = [json.loads(line) for line in temp_sql_log.read_text(encoding="utf-8").splitlines()]
    assert all("timeout_s" in r for r in logged)
    assert run_sql.main([str(f), "--timeout", "30"]) == 0
    assert {t for _, t in FakeConnection.instances[-1].calls} == {30.0}


def test_count_and_run_dq_log_their_values(runner, temp_sql_log):
    f, _ = runner
    assert run_sql.main([str(f)]) == 0
    logged = {r["sql"].split()[0] + " " + r["sql"].split()[1]: r
              for r in (json.loads(line) for line in temp_sql_log.read_text(encoding="utf-8").splitlines())}
    assert logged["RUN DQ"]["result_head"] == [[3, 2, 1]]
    assert logged["SELECT COUNT(*)"]["result_head"] == [[1]]
    assert "result_head" not in logged["SELECT 1"]


def test_dry_run_sends_nothing(runner, capsys):
    f, _ = runner
    assert run_sql.main([str(f), "--dry-run"]) == 0
    assert FakeConnection.instances == []
    out = capsys.readouterr().out
    assert "SEC-spaced >= 0.1 s" in out and "YOUR_APP_NAME" in out
