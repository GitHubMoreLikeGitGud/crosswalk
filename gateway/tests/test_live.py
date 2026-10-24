"""Live checks against the local Zetaris instance. Run with WON_LIVE=1."""

import os

import pytest

from gateway.app import Gateway, TemplateRequest
from gateway.jdbc import load_env

pytestmark = pytest.mark.skipif(os.environ.get("WON_LIVE") != "1", reason="set WON_LIVE=1 to run against Zetaris")


@pytest.fixture(scope="module")
def gw():
    load_env()
    return Gateway()


def test_select1(gw):
    status, body = gw.run_template(TemplateRequest(template_id="select1"))
    assert status == 200 and body["rows"] == [[1]]


def test_show_databases(gw):
    status, body = gw.run_template(TemplateRequest(template_id="show_databases"))
    assert status == 200 and body["row_count"] >= 1 and body["columns"]
