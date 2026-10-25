"""Outside check of the SIC reference: the company_dns SIC list against the SEC's own SIC code list.

The DQ rule utility.sic -> sic_code flags MGE Energy (SIC 4900) as the one invalid row. This script
asks whether 4900 is a valid SEC code that the company_dns list leaves out. It fetches, over HTTPS
and outside Zetaris, the company_dns V4 list (the endpoint CW_DNS.sic_codes_v4_raw reads) and the
SEC's "Standard Industrial Classification (SIC) Code List" page, both with the declared User-Agent
from CW_USER_AGENT in .env.local (sent on the wire only, never written), and writes the codes the
SEC lists that company_dns does not to docs/eval/sic-check.json. Codes and industry titles only.

Run from the repository root:  python -X utf8 scripts/sic_outside_check.py
"""

from __future__ import annotations

import html
import json
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DNS_URL = "https://company-dns.mediumroast.io/V4.0/na/sic/code/%25"
SEC_URL = "https://www.sec.gov/search-filings/standard-industrial-classification-sic-code-list"
OUT = ROOT / "docs" / "eval" / "sic-check.json"


def user_agent() -> str:
    env = ROOT / ".env.local"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            m = re.match(r"^\s*CW_USER_AGENT\s*=\s*(.*)$", line)
            if m:
                return m.group(1).strip().strip('"').strip("'")
    sys.exit("CW_USER_AGENT is not set in .env.local")


def get(url: str, ua: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": ua, "Accept-Encoding": "identity"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def sec_codes(page: str) -> dict[str, dict[str, str]]:
    out: dict[str, dict[str, str]] = {}
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", page, re.S):
        cells = [html.unescape(re.sub(r"<[^>]+>", "", c)).strip() for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, re.S)]
        if len(cells) >= 3 and re.fullmatch(r"\d{3,4}", cells[0]):
            out[cells[0].zfill(4)] = {"office": cells[1], "title": cells[2]}
    return out


def main() -> None:
    ua = user_agent()
    dns = json.loads(get(DNS_URL, ua))["data"]
    dns_codes = {str(r["class_id"]).zfill(4) for r in dns}
    sec = sec_codes(get(SEC_URL, ua))
    if len(sec) < 100:
        sys.exit(f"parsed only {len(sec)} SEC codes; the page layout may have changed")
    missing = sorted(set(sec) - dns_codes)
    seeds = json.loads((ROOT / "seeds" / "utilities.json").read_text(encoding="utf-8"))
    seed_rows = seeds["utilities"] if isinstance(seeds, dict) else seeds
    seed_sics = sorted({str(u["sic"]).zfill(4) for u in seed_rows if u.get("sic") is not None})
    result = {
        "label": "measured",
        "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "method": "both lists fetched over HTTPS outside Zetaris with the declared User-Agent (not recorded); SEC codes parsed from the page's table; company_dns codes are its class_id values",
        "sources": {"company_dns": DNS_URL, "sec": SEC_URL},
        "company_dns_codes": len(dns_codes),
        "sec_codes": len(sec),
        "sec_codes_missing_from_company_dns": len(missing),
        "seed_utility_sics": [{"sic": s, "on_sec_list": s in sec, "in_company_dns": s in dns_codes, "sec_title": sec.get(s, {}).get("title")} for s in seed_sics],
        "missing": [{"sic": c, **sec[c]} for c in missing],
    }
    OUT.write_text(json.dumps(result, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    print(f"company_dns {len(dns_codes)} codes; SEC {len(sec)} codes; {len(missing)} SEC codes missing from company_dns")
    for s in result["seed_utility_sics"]:
        print(f"seed SIC {s['sic']}: on the SEC list {s['on_sec_list']}, in company_dns {s['in_company_dns']} ({s['sec_title']})")
    print(f"wrote {OUT.relative_to(ROOT).as_posix()}")


if __name__ == "__main__":
    main()
