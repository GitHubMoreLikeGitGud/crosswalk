"""Seed curation, inherited from Weather-or-Not with the 43-utility and 56-station seeds. Dev-time curation, not part of the agent.

At run time the agent reads SEC EDGAR and NOAA GHCN only through Zetaris Lightning. This
script is the documented exception: a developer runs it once to choose which utilities and
weather stations go into seeds/, and to verify each identifier against the live sources.

What it does
  1. Resolves a hand-written list of US investor-owned electric utilities to 10-digit CIKs
     (SEC company_tickers.json), fetches https://data.sec.gov/submissions/CIK##########.json
     for each one at <= 5 requests per second with the declared User-Agent, and keeps only
     cik, name, sic, sicDescription and addresses.business.stateOrCountry.
  2. Drops any filer whose SIC is not 4911 / 4931 / 4932 / 4991 unless it is listed in
     KEEP_DESPITE_SIC (with a note), and any filer with no 10-K/10-Q filed since 2025.
  3. Verifies a hand-written list of first-order airport GHCN stations (USW ids) against the
     NOAA parquet on S3 (anonymous, us-east-1): the station must have >= 350 TMAX days in
     2024 and >= 270 TMAX days in 2025. The official state and name come from
     ghcnd-stations.txt. Failing stations are dropped; the next candidate for that state is used.
  4. Writes seeds/utilities.json and seeds/stations.json (identifiers, names, states and
     station ids only; no SEC fact values) and prints a verification table.

Run from the repo root:
  .venv/Scripts/python scripts/curate-seeds.py            # full run (network)
  .venv/Scripts/python scripts/curate-seeds.py --refetch  # ignore the local cache

Raw responses are cached in data/curation/ (gitignored). The service-territory states are
curated from each company's FY2024 Form 10-K, Item 1 (Business) service-territory text and are
labelled curated:true in the output. CW_USER_AGENT is read from .env.local and never printed.
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CUR = ROOT / "data" / "curation"
SEC_DIR = CUR / "sec"
GHCN_DIR = CUR / "ghcn"
SEEDS_DIR = ROOT / "seeds"

TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik10}.json"
STATIONS_TXT_URL = "https://noaa-ghcn-pds.s3.amazonaws.com/ghcnd-stations.txt"
GHCN_BUCKET_PREFIX = "noaa-ghcn-pds/parquet/by_year/YEAR={year}/ELEMENT={element}/"
S3_REGION = "us-east-1"

ELECTRIC_SIC = {"4911", "4931", "4932", "4991"}
PEER_SIC = {"4911", "4931", "4932"}
MIN_DAYS_2024 = 350
MIN_DAYS_2025 = 270
MIN_QUARTER_COVERAGE = 0.95  # days with both TMAX and TMIN, each of Q1-Q3 in 2024 and 2025
SEC_MIN_INTERVAL_S = 0.2  # 5 requests per second, half the SEC limit of 10

STATES_SOURCE = (
    "FY2024 Form 10-K Item 1 (Business) service-territory description; "
    "hand-curated 2026-10-24, electric service states only, capped at 6"
)

# ticker (None for debt-only filers), CIK (None = resolve from the ticker), electric service
# states (1-6, largest first), note, flags.
CANDIDATES = [
    ("DUK", 1326160, ["NC", "SC", "FL", "IN", "OH", "KY"],
     "Duke Energy Carolinas and Progress (NC, SC), Duke Energy Florida, Indiana, Ohio and Kentucky", []),
    ("SO", 92122, ["GA", "AL", "MS"],
     "Georgia Power, Alabama Power, Mississippi Power; gas distribution (IL, GA, VA, TN) not listed", []),
    ("NEE", 753308, ["FL"],
     "Florida Power & Light including former Gulf Power; NextEra Energy Resources is wholesale nationwide", []),
    ("AEP", 4904, ["OH", "TX", "VA", "WV", "IN", "OK"],
     "AEP Ohio, AEP Texas, Appalachian Power (VA, WV), Indiana Michigan Power, PSO; MI, KY, TN, LA, AR omitted by the cap", []),
    ("XEL", 72903, ["MN", "CO", "TX", "NM", "WI", "ND"],
     "NSP-Minnesota (MN, ND, SD), PSCo (CO), SPS (TX, NM), NSP-Wisconsin (WI, MI); SD and MI omitted by the cap", []),
    ("ETR", 65984, ["AR", "LA", "MS", "TX"],
     "Entergy Arkansas, Louisiana, Mississippi, Texas", []),
    ("EVRG", 1711269, ["KS", "MO"],
     "Evergy Kansas Central, Evergy Metro, Evergy Missouri West", []),
    ("AEE", 1002910, ["MO", "IL"],
     "Ameren Missouri, Ameren Illinois", []),
    ("CMS", 811156, ["MI"], "Consumers Energy", []),
    ("DTE", 936340, ["MI"], "DTE Electric and DTE Gas", []),
    ("WEC", 783325, ["WI", "MI"],
     "We Energies, Wisconsin Public Service, Upper Michigan Energy Resources; gas in IL and MN not listed", []),
    ("LNT", 352541, ["IA", "WI"],
     "Interstate Power and Light (IA), Wisconsin Power and Light (WI)", []),
    ("PPL", 922224, ["PA", "KY", "RI"],
     "PPL Electric Utilities (PA), LG&E and KU (KY), Rhode Island Energy (RI, since 2022)", []),
    ("FE", 1031296, ["OH", "PA", "NJ", "WV", "MD"],
     "Ohio Edison, CEI, Toledo Edison; Penn Power, Penelec, Met-Ed, West Penn; JCP&L; Mon Power; Potomac Edison", []),
    ("PEG", 788784, ["NJ"], "Public Service Electric and Gas", []),
    ("ED", 1047862, ["NY"],
     "Consolidated Edison of New York; Orange and Rockland (NY, small NJ) folded into NY", []),
    ("ES", 72741, ["CT", "MA", "NH"],
     "Connecticut Light and Power, NSTAR Electric (MA), Public Service of New Hampshire", []),
    ("EXC", 1109357, ["IL", "PA", "MD", "NJ", "DE"],
     "ComEd (IL), PECO (PA), BGE (MD), Atlantic City Electric (NJ), Delmarva (DE, MD), Pepco (DC, MD); DC covered by MD stations", []),
    ("EIX", 827052, ["CA"], "Southern California Edison", []),
    ("PCG", 1004980, ["CA"], "Pacific Gas and Electric", []),
    ("SRE", 1032208, ["CA"],
     "SDG&E and SoCalGas (CA); Oncor (TX) is equity-accounted; Sempra Infrastructure is not weather-driven", ["gas_heavy"]),
    ("PNW", 764622, ["AZ"], "Arizona Public Service", []),
    ("POR", 784977, ["OR"], "Portland General Electric", []),
    ("IDA", 1057877, ["ID"], "Idaho Power (ID; small OR footprint omitted)", []),
    ("NWE", None, ["MT", "SD"], "NorthWestern Energy electric (MT, SD); gas NE omitted", []),
    ("BKH", 1130464, ["SD", "WY", "CO"],
     "Black Hills Power (SD, WY), Cheyenne Light (WY), Black Hills Colorado Electric; gas in AR, IA, KS, NE omitted", ["gas_heavy"]),
    ("AVA", 104918, ["WA", "ID"], "Avista Utilities (WA, ID); Alaska Electric Light and Power omitted", []),
    ("OGE", 1021635, ["OK"], "Oklahoma Gas and Electric (OK; small western AR footprint omitted)", []),
    ("CNP", 1130310, ["TX", "IN"],
     "CenterPoint Houston Electric (TX), SIGECO (IN); gas in MN, OH, IN, TX, LA, MS not listed", ["gas_heavy"]),
    ("VST", 1692819, ["TX", "IL", "PA", "OH"],
     "Competitive generator and retailer; ERCOT retail plus PJM and MISO generation", ["competitive"]),
    ("NRG", 1013871, ["TX"],
     "Competitive retailer and generator; largest retail base in TX, national retail", ["competitive"]),
    ("HE", 354707, ["HI"],
     "Hawaiian Electric (Oahu, Maui County, Hawaii Island); bank segment sold 2025", ["non_utility_segment"]),
    ("ALE", 66756, ["MN", "WI"], "Minnesota Power (MN), Superior Water Light and Power (WI)", []),
    ("OTTR", 1466593, ["MN", "ND", "SD"],
     "Otter Tail Power; manufacturing and plastics segments are large", ["non_utility_segment"]),
    ("MGEE", 1161728, ["WI"], "Madison Gas and Electric", []),
    ("UTL", 755001, ["NH", "MA"], "Unitil electric (NH, MA); gas ME omitted", []),
    ("TXNM", 1108426, ["NM", "TX"], "PNM (NM), TNMP (TX); formerly PNM Resources", []),
    ("AGR", 1634997, ["NY", "CT", "ME", "MA"],
     "NYSEG and RG&E (NY), United Illuminating (CT), Central Maine Power (ME), Berkshire Gas (MA); taken private Dec 2024", []),
    ("D", 715957, ["VA", "NC", "SC"],
     "Dominion Energy Virginia (VA, NC), Dominion Energy South Carolina; peer only, never the demo pick", ["never_demo"]),
    ("CEG", 1868275, ["IL", "PA", "MD", "NY"],
     "Competitive generator and retailer", ["competitive"]),
    ("NI", 1111711, ["IN"], "NIPSCO electric (IN); gas in OH, PA, VA, KY, MD", ["gas_heavy"]),
    (None, 1193311, ["TX"], "Oncor Electric Delivery, transmission and distribution only; debt filer, no ticker", []),
    (None, 100122, ["AZ"], "Tucson Electric Power (Fortis); debt filer, no ticker", []),
    (None, 96271, ["FL"], "Tampa Electric (Emera); debt filer, no ticker", []),
]

# Filers kept although their SIC is outside ELECTRIC_SIC (well-known electric holding companies).
KEEP_DESPITE_SIC: dict[int, str] = {
    1161728: "MGE Energy (Madison Gas and Electric) is a combination electric and gas utility; EDGAR lists SIC 4900. "
             "Kept as a candidate target; excluded from the peer set by the SIC rule.",
}

# Candidate first-order airport stations per state, in priority order. The script keeps the first
# passing station(s): two for states served by three or more seed utilities, otherwise one.
STATION_CANDIDATES: dict[str, list[str]] = {
    "AL": ["USW00013876", "USW00013894", "USW00013895"],
    "AR": ["USW00013963", "USW00013964"],
    "AZ": ["USW00023183", "USW00023160"],
    "CA": ["USW00023174", "USW00023234", "USW00023188", "USW00023232"],
    "CO": ["USW00003017", "USW00093037", "USW00023066"],
    "CT": ["USW00014740", "USW00014758"],
    "DE": ["USW00013781"],
    "FL": ["USW00012839", "USW00012842", "USW00012815", "USW00013889"],
    "GA": ["USW00013874", "USW00003822", "USW00013873"],
    "HI": ["USW00022521", "USW00022516"],
    "IA": ["USW00014933", "USW00014943", "USW00014990"],
    "ID": ["USW00024131", "USW00024156"],
    "IL": ["USW00094846", "USW00093822", "USW00014842"],
    "IN": ["USW00093819", "USW00093817", "USW00014827"],
    "KS": ["USW00013996", "USW00003928"],
    "KY": ["USW00093821", "USW00093820", "USW00093814"],
    "LA": ["USW00012916", "USW00013970", "USW00013957"],
    "MA": ["USW00014739", "USW00014702"],
    "MD": ["USW00093721", "USW00093720"],
    "ME": ["USW00014764", "USW00014606"],
    "MI": ["USW00094847", "USW00014836", "USW00014826"],
    "MN": ["USW00014922", "USW00014913", "USW00014925"],
    "MO": ["USW00013994", "USW00003947", "USW00013995"],
    "MS": ["USW00003940", "USW00013865"],
    "MT": ["USW00024033", "USW00024143", "USW00024144"],
    "NC": ["USW00013722", "USW00013881", "USW00013723"],
    "ND": ["USW00024011", "USW00014914"],
    "NH": ["USW00014745", "USW00014710"],
    "NJ": ["USW00014734", "USW00093730", "USW00013735"],
    "NM": ["USW00023050", "USW00023049"],
    "NY": ["USW00094728", "USW00014733", "USW00014735", "USW00014768"],
    "OH": ["USW00014821", "USW00014820", "USW00093815", "USW00094830"],
    "OK": ["USW00013967", "USW00013968"],
    "OR": ["USW00024229", "USW00024221"],
    "PA": ["USW00013739", "USW00094823", "USW00014737"],
    "RI": ["USW00014765"],
    "SC": ["USW00013883", "USW00013880", "USW00003870"],
    "SD": ["USW00014944", "USW00024090"],
    "TX": ["USW00003927", "USW00012960", "USW00013904", "USW00012921"],
    "VA": ["USW00013737", "USW00013740"],
    "WA": ["USW00024233", "USW00024157"],
    "WI": ["USW00014839", "USW00014837", "USW00014898"],
    "WV": ["USW00013866", "USW00003860"],
    "WY": ["USW00024018", "USW00024089"],
}


# ----------------------------------------------------------------------------- helpers
def load_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


class SecClient:
    """Rate-limited HTTP client for SEC hosts (declared User-Agent, <= 5 req/s, gzip)."""

    def __init__(self, user_agent: str, refetch: bool = False):
        if not user_agent:
            sys.exit("CW_USER_AGENT missing from .env.local; refusing to call SEC without it")
        self.ua = user_agent
        self.refetch = refetch
        self._last = 0.0
        self.requests = 0

    def _get(self, url: str) -> bytes:
        wait = SEC_MIN_INTERVAL_S - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)
        req = urllib.request.Request(url, headers={
            "User-Agent": self.ua,
            "Accept-Encoding": "gzip, deflate",
            "Accept": "application/json",
        })
        self._last = time.monotonic()
        self.requests += 1
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read()
            if resp.headers.get("Content-Encoding") == "gzip":
                body = gzip.decompress(body)
        return body

    def get_json(self, url: str, cache: Path) -> dict:
        if cache.exists() and not self.refetch:
            return json.loads(cache.read_text(encoding="utf-8"))
        body = self._get(url)
        data = json.loads(body.decode("utf-8"))
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(data), encoding="utf-8")
        return data


def fetch_text(url: str, cache: Path, refetch: bool) -> str:
    if cache.exists() and not refetch:
        return cache.read_text(encoding="utf-8")
    with urllib.request.urlopen(url, timeout=120) as resp:
        text = resp.read().decode("utf-8")
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(text, encoding="utf-8")
    return text


def parse_stations_txt(text: str) -> dict[str, dict]:
    """ghcnd-stations.txt is fixed width: ID 1-11, LAT 13-20, LON 22-30, ELEV 32-37, STATE 39-40, NAME 42-71."""
    out: dict[str, dict] = {}
    for line in text.splitlines():
        if len(line) < 41:
            continue
        sid = line[0:11]
        if not sid.startswith("USW"):
            continue
        out[sid] = {
            "state": line[38:40].strip(),
            "name": line[41:71].strip(),
            "lat": float(line[12:20]),
            "lon": float(line[21:30]),
        }
    return out


# ----------------------------------------------------------------------------- SEC side
def trim_submissions(sub: dict) -> dict:
    """Keep only the fields the project needs. Street address fields are never stored."""
    recent = sub.get("filings", {}).get("recent", {})
    forms = recent.get("form", [])
    dates = recent.get("filingDate", [])
    periodic_since_2025 = sum(
        1 for f, d in zip(forms, dates) if f in ("10-K", "10-Q") and d >= "2025-01-01"
    )
    latest_periodic = max(
        (d for f, d in zip(forms, dates) if f in ("10-K", "10-Q")), default=None
    )
    return {
        "cik": str(sub.get("cik", "")).zfill(10),
        "name": sub.get("name"),
        "sic": str(sub.get("sic") or ""),
        "sicDescription": sub.get("sicDescription"),
        "hq_state": (sub.get("addresses") or {}).get("business", {}).get("stateOrCountry"),
        "tickers": sub.get("tickers") or [],
        "periodic_filings_since_2025": periodic_since_2025,
        "latest_periodic_filing": latest_periodic,
    }


def resolve_and_fetch_utilities(sec: SecClient) -> tuple[list[dict], list[dict]]:
    tickers = sec.get_json(TICKERS_URL, SEC_DIR / "company_tickers.json")
    by_ticker = {row["ticker"].upper(): int(row["cik_str"]) for row in tickers.values()}

    kept: list[dict] = []
    dropped: list[dict] = []
    for ticker, cik, states, note, flags in CANDIDATES:
        resolved = by_ticker.get(ticker.upper()) if ticker else None
        if cik is None and resolved is None:
            dropped.append({"ticker": ticker, "cik": None, "reason": "ticker not in company_tickers.json and no CIK given"})
            continue
        if cik is not None and resolved is not None and cik != resolved:
            print(f"  WARN {ticker}: hand-written CIK {cik} differs from company_tickers.json {resolved}; using the live one")
            cik = resolved
        if cik is None:
            cik = resolved
        cik10 = f"{cik:010d}"
        cache = SEC_DIR / "submissions" / f"CIK{cik10}.trimmed.json"
        if cache.exists() and not sec.refetch:
            info = json.loads(cache.read_text(encoding="utf-8"))
        else:
            try:
                raw = sec._get(SUBMISSIONS_URL.format(cik10=cik10))
            except urllib.error.HTTPError as e:
                dropped.append({"ticker": ticker, "cik": cik10, "reason": f"submissions HTTP {e.code}"})
                continue
            info = trim_submissions(json.loads(raw.decode("utf-8")))
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps(info, indent=1), encoding="utf-8")

        row = {
            "cik": info["cik"],
            "name": info["name"],
            "ticker": ticker,
            "sic": info["sic"],
            "sic_description": info["sicDescription"],
            "hq_state": info["hq_state"],
            "states_served": states,
            "states_source": STATES_SOURCE,
            "states_note": note,
            "flags": list(flags),
            "curated": True,
        }
        if info["periodic_filings_since_2025"] == 0:
            dropped.append({**row, "reason": f"no 10-K/10-Q since 2025 (latest {info['latest_periodic_filing']})"})
            continue
        if info["sic"] not in ELECTRIC_SIC:
            if cik in KEEP_DESPITE_SIC:
                row["flags"].append("kept_despite_sic")
                row["sic_note"] = KEEP_DESPITE_SIC[cik]
            else:
                dropped.append({**row, "reason": f"SIC {info['sic']} ({info['sicDescription']}) not electric"})
                continue
        if ticker and info["tickers"] and ticker.upper() not in [t.upper() for t in info["tickers"]]:
            print(f"  WARN {ticker}: submissions lists tickers {info['tickers']}")
        kept.append(row)
    return kept, dropped


# ----------------------------------------------------------------------------- GHCN side
def fetch_ghcn_partition(year: int, element: str, station_ids: list[str], refetch: bool):
    """Read one by_year/ELEMENT partition from S3 filtered to the candidate stations; cache locally."""
    import pyarrow as pa
    import pyarrow.dataset as pds
    import pyarrow.fs as pafs
    import pyarrow.parquet as pq

    cache = GHCN_DIR / f"ghcn_{year}_{element}_candidates.parquet"
    if cache.exists() and not refetch:
        t = pq.read_table(cache)
        have = set(t.column("ID").unique().to_pylist())
        if set(station_ids) <= have or cache.with_suffix(".ids.json").exists() and set(station_ids) <= set(
                json.loads(cache.with_suffix(".ids.json").read_text())):
            return t, None
    fs = pafs.S3FileSystem(anonymous=True, region=S3_REGION)
    prefix = GHCN_BUCKET_PREFIX.format(year=year, element=element)
    t0 = time.monotonic()
    files = [f.path for f in fs.get_file_info(pafs.FileSelector(prefix)) if f.path.endswith(".parquet")]
    dataset = pds.dataset(files, filesystem=fs, format="parquet")
    table = dataset.to_table(
        columns=["ID", "DATE", "DATA_VALUE", "Q_FLAG"],
        filter=pds.field("ID").isin(pa.array(station_ids)),
    )
    elapsed = time.monotonic() - t0
    GHCN_DIR.mkdir(parents=True, exist_ok=True)
    pq.write_table(table, cache)
    cache.with_suffix(".ids.json").write_text(json.dumps(sorted(station_ids)))
    return table, {"files": len(files), "rows": table.num_rows, "seconds": round(elapsed, 1)}


def dates_by_station(table) -> dict[str, set]:
    seen: dict[str, set] = {}
    for sid, d in zip(table.column("ID").to_pylist(), table.column("DATE").to_pylist()):
        seen.setdefault(sid, set()).add(d)
    return seen


def days_in_quarter(year: int, q: int) -> int:
    if q == 1:
        return 91 if (year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)) else 90
    return {2: 91, 3: 92, 4: 92}[q]


def station_passes(c: dict) -> bool:
    return (c["tmax_2024"] >= MIN_DAYS_2024 and c["tmax_2025"] >= MIN_DAYS_2025
            and c["min_quarter_cov"] >= MIN_QUARTER_COVERAGE)


def verify_stations(all_candidates: list[str], refetch: bool) -> tuple[dict[str, dict], list[dict]]:
    """Yearly TMAX/TMIN day counts plus, per quarter Q1-Q3 of both years, the share of days with
    BOTH elements present (the degree-day method needs both; this is the coverage the DQ gate tests)."""
    counts: dict[str, dict] = {sid: {} for sid in all_candidates}
    fetch_log: list[dict] = []
    dates: dict[tuple, dict[str, set]] = {}
    for year, element in [(2024, "TMAX"), (2025, "TMAX"), (2024, "TMIN"), (2025, "TMIN")]:
        table, stats = fetch_ghcn_partition(year, element, all_candidates, refetch)
        if stats:
            fetch_log.append({"year": year, "element": element, **stats})
            print(f"  GHCN {year} {element}: {stats['files']} files, {stats['rows']} candidate rows in {stats['seconds']} s")
        else:
            print(f"  GHCN {year} {element}: from local cache ({table.num_rows} rows)")
        dates[(year, element)] = dates_by_station(table)
        for sid in all_candidates:
            counts[sid][f"{element.lower()}_{year}"] = len(dates[(year, element)].get(sid, ()))
    for sid in all_candidates:
        covs = []
        for year in (2024, 2025):
            both = dates[(year, "TMAX")].get(sid, set()) & dates[(year, "TMIN")].get(sid, set())
            for q in (1, 2, 3):
                n = sum(1 for d in both if (int(d[4:6]) - 1) // 3 + 1 == q)
                cov = n / days_in_quarter(year, q)
                counts[sid][f"cov_{year}q{q}"] = round(cov, 3)
                covs.append(cov)
        counts[sid]["min_quarter_cov"] = round(min(covs), 3)
    return counts, fetch_log


# ----------------------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--refetch", action="store_true", help="ignore data/curation caches")
    ap.add_argument("--skip-ghcn", action="store_true", help="reuse seeds/stations.json instead of verifying stations")
    args = ap.parse_args()

    env = load_env(ROOT / ".env.local")
    sec = SecClient(env.get("CW_USER_AGENT", ""), refetch=args.refetch)
    SEC_DIR.mkdir(parents=True, exist_ok=True)
    run_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()

    print("== SEC submissions")
    utilities, dropped = resolve_and_fetch_utilities(sec)
    print(f"  kept {len(utilities)} of {len(CANDIDATES)} candidates; {sec.requests} SEC requests")
    for d in dropped:
        print(f"  DROP {d.get('ticker') or d.get('cik')}: {d['reason']}")

    needed_states = sorted({s for u in utilities for s in u["states_served"]})
    served_by = {s: sum(1 for u in utilities if s in u["states_served"]) for s in needed_states}
    missing_candidates = [s for s in needed_states if s not in STATION_CANDIDATES]
    if missing_candidates:
        sys.exit(f"no station candidates for states {missing_candidates}")

    print("== GHCN stations")
    stations_txt = fetch_text(STATIONS_TXT_URL, GHCN_DIR / "ghcnd-stations.txt", args.refetch)
    meta = parse_stations_txt(stations_txt)
    all_candidates = [sid for st in needed_states for sid in STATION_CANDIDATES[st]]
    unknown = [sid for sid in all_candidates if sid not in meta]
    for sid in unknown:
        print(f"  WARN {sid}: not in ghcnd-stations.txt")

    if args.skip_ghcn and (SEEDS_DIR / "stations.json").exists():
        prior = json.loads((SEEDS_DIR / "stations.json").read_text(encoding="utf-8"))
        chosen = prior["stations"]
        counts, fetch_log = {}, []
    else:
        counts, fetch_log = verify_stations(all_candidates, args.refetch)
        chosen = []
        for st in needed_states:
            want = 2 if served_by[st] >= 3 else 1
            got = 0
            for sid in STATION_CANDIDATES[st]:
                c = counts[sid]
                ok = station_passes(c) and sid in meta
                official_state = meta.get(sid, {}).get("state")
                if ok and official_state != st:
                    print(f"  WARN {sid}: listed under {st} but ghcnd-stations.txt says {official_state}; dropped")
                    ok = False
                if ok and got < want:
                    chosen.append({"id": sid, "state": st, "name": meta[sid]["name"]})
                    got += 1
            if got == 0:
                sys.exit(f"state {st}: no candidate station passed; add another candidate")

    chosen_ids = {s["id"] for s in chosen}
    by_state: dict[str, list[str]] = {}
    for s in chosen:
        by_state.setdefault(s["state"], []).append(s["id"])
    for u in utilities:
        u["station_ids"] = [sid for st in u["states_served"] for sid in by_state[st]]

    SEEDS_DIR.mkdir(parents=True, exist_ok=True)
    utilities_doc = {
        "generated_at": run_at,
        "generator": "scripts/curate-seeds.py (dev-time curation, not part of the agent)",
        "fields": {
            "cik": "10-digit SEC CIK, verified against data.sec.gov/submissions on generated_at",
            "name, sic, sic_description, hq_state": "copied from the submissions response",
            "states_served": "curated electric service states (see states_source); hq_state is not the service territory",
            "station_ids": "GHCN USW stations for states_served, from seeds/stations.json",
            "flags": "competitive = merchant generator/retailer; gas_heavy = large gas distribution share; "
                     "non_utility_segment = large non-utility business; never_demo = peer only",
        },
        "sic_filter": sorted(ELECTRIC_SIC),
        "peer_sic": sorted(PEER_SIC),
        "utilities": utilities,
    }
    stations_doc = {
        "generated_at": run_at,
        "generator": "scripts/curate-seeds.py (dev-time curation, not part of the agent)",
        "source": "NOAA GHCN-Daily, s3://noaa-ghcn-pds/parquet/by_year/YEAR=<yyyy>/ELEMENT=<TMAX|TMIN>/; "
                  "names and states from ghcnd-stations.txt",
        "verification": f"each station has >= {MIN_DAYS_2024} TMAX days in 2024, >= {MIN_DAYS_2025} TMAX days in 2025 and "
                        f">= {MIN_QUARTER_COVERAGE} coverage (days with both TMAX and TMIN) in each of Q1-Q3 2024 and 2025 "
                        "in the parquet (checked by this script with pyarrow; counts kept in the private run log)",
        "rule": "2 stations for states served by >= 3 seed utilities, otherwise 1; first-order airport stations only",
        "stations": chosen,
    }
    (SEEDS_DIR / "utilities.json").write_text(json.dumps(utilities_doc, indent=2) + "\n", encoding="utf-8")
    (SEEDS_DIR / "stations.json").write_text(json.dumps(stations_doc, indent=2) + "\n", encoding="utf-8")

    # verification tables (stdout only; the private notes copy them)
    print("\n== Utilities kept")
    print(f"{'cik':<11}{'tkr':<6}{'sic':<5}{'hq':<3} {'states':<20}{'stn':>4}  name / flags")
    for u in sorted(utilities, key=lambda r: r["name"]):
        flags = (" [" + ",".join(u["flags"]) + "]") if u["flags"] else ""
        print(f"{u['cik']:<11}{(u['ticker'] or '-'):<6}{u['sic']:<5}{u['hq_state']:<3} {','.join(u['states_served']):<20}"
              f"{len(u['station_ids']):>4}  {u['name']}{flags}")
    peer_pool = [u for u in utilities if u["sic"] in PEER_SIC]
    print(f"  {len(utilities)} utilities, {len(peer_pool)} with peer SIC {sorted(PEER_SIC)}, "
          f"{len(needed_states)} states, {len(chosen)} stations")

    if counts:
        print("\n== Stations verified (TMAX/TMIN days per year; minQ = lowest Q1-Q3 coverage with both elements)")
        print(f"{'id':<13}{'st':<3} {'tmax24':>6}{'tmax25':>6}{'tmin24':>6}{'tmin25':>6}{'minQ':>7}  status    name")
        for st in needed_states:
            for sid in STATION_CANDIDATES[st]:
                c = counts[sid]
                status = "KEPT" if sid in chosen_ids else ("ok-spare" if station_passes(c) else "FAIL")
                print(f"{sid:<13}{st:<3} {c['tmax_2024']:>6}{c['tmax_2025']:>6}{c['tmin_2024']:>6}{c['tmin_2025']:>6}"
                      f"{c['min_quarter_cov']:>7.3f}  {status:<9} {meta.get(sid, {}).get('name', '?')}")
        log = {"run_at": run_at, "fetch": fetch_log, "counts": counts, "chosen": sorted(chosen_ids),
               "dropped_utilities": dropped, "sec_requests": sec.requests}
        (CUR / "curate-seeds.log.json").write_text(json.dumps(log, indent=1), encoding="utf-8")
        print(f"\n  run log: data/curation/curate-seeds.log.json")
    print(f"  wrote seeds/utilities.json ({len(utilities)}) and seeds/stations.json ({len(chosen)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
