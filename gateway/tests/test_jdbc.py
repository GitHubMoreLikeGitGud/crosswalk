import os

import pytest

from gateway import jdbc
from gateway.jdbc import ZetarisError, apply_user_agent, split_statements


def test_split_drops_comments_and_respects_quotes():
    text = "-- c1\nSELECT 'a;b' AS x;\n/* block; */ SELECT \"c;d\";\nSELECT 3"
    assert split_statements(text) == ["SELECT 'a;b' AS x", 'SELECT "c;d"', "SELECT 3"]


def test_split_keeps_compile_usl_whole():
    text = ("COMPILE USL u DEPLOY NAMESPACE lightning.metastore.n DDL\nCREATE TABLE a (x int);\n"
            "CREATE TABLE b (y int);\nUPDATE USL lightning.metastore.n.u SET DESCRIPTION x;")
    parts = split_statements(text)
    assert len(parts) == 2
    assert parts[0].count("CREATE TABLE") == 2 and not parts[0].endswith(";")


def test_user_agent_substitution(monkeypatch):
    monkeypatch.setenv("CW_USER_AGENT", "Crosswalk/0.1 test")
    assert apply_user_agent('user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"') == 'user-agent "Crosswalk/0.1 test"'
    assert apply_user_agent("SELECT 1") == "SELECT 1"


@pytest.mark.parametrize("ua", ["", "Crosswalk/0.1 <owner-contact>", 'Crosswalk "x"'])
def test_user_agent_refuses_placeholders(monkeypatch, ua):
    monkeypatch.setenv("CW_USER_AGENT", ua)
    with pytest.raises(ZetarisError):
        apply_user_agent('user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"')


def test_load_env_strips_crlf_and_does_not_override(tmp_path, monkeypatch):
    env = tmp_path / ".env.local"
    env.write_bytes(b'A_CW_TEST=from_file\r\nB_CW_TEST="quoted"\r\n# C_CW_TEST=x\r\n')
    monkeypatch.setenv("A_CW_TEST", "preset")
    monkeypatch.delenv("B_CW_TEST", raising=False)
    monkeypatch.delenv("C_CW_TEST", raising=False)
    jdbc.load_env(env)
    assert os.environ["A_CW_TEST"] == "preset"
    assert os.environ["B_CW_TEST"] == "quoted"
    assert "C_CW_TEST" not in os.environ
    monkeypatch.delenv("B_CW_TEST")
