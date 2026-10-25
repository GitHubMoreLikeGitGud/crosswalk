"""Crosswalk demo pick. Dev-time curation, not part of the agent.

Implements the attribution method of the build spec (section 2) in plain Python (json, pyarrow)
directly against the SEC XBRL frames API and the NOAA GHCN parquet, for every seed utility and
for Q1-Q3 of the target year against the year before. Its only purpose is to choose the demo
utility and quarter from live data before the agent exists. At run time the agent reproduces
these numbers through Zetaris Lightning; nothing here is imported by the agent.

Method (per target T and quarter Q, year y vs y-1)
  revenue    frames us-gaap/<tag>/USD/CY<y>Q<n>, tag probed in order Revenues ->
             RevenueFromContractWithCustomerExcludingAssessedTax -> RegulatedAndUnregulatedOperatingRevenue;
             the y-1 value comes from the same tag's CY<y-1>Q<n> frame (the frames API serves the
             most recently filed fact, i.e. normally the comparative as restated in the current filing)
  g          (rev_y - rev_{y-1}) / rev_{y-1}
  weather    per station and quarter: Tmean = (TMAX + TMIN) / 2 in tenths degC, converted to F;
             HDD = sum max(0, 65 - Tmean_F), CDD = sum max(0, Tmean_F - 65); only days with both
             TMAX and TMIN; coverage = days_observed / days_in_quarter.
             TDD_u = mean over the utility's stations of (HDD + CDD); dw_u = (TDD_y - TDD_{y-1}) / TDD_{y-1}
  peers      seed utilities with SIC 4911/4931/4932, not T, both periods present, |g| < 60%
  beta       OLS slope of g_p on dw_p across peers (Theil-Sen median slope printed as a cross-check)
  split      weather_T = beta * dw_T; industry = median_p(g_p - beta * dw_p); remainder = g_T - weather - industry
  ranges     300 bootstrap resamples of the peer set, seed 7, 10th-90th percentiles
  labels     high: peers >= 20, coverage >= 0.95, beta range excludes 0; medium: peers >= 12, coverage >= 0.9; else low
  claim      "it was the weather": supported if same sign and |weather| >= 0.5 |g|; partly if 0.2 <= ratio < 0.5

Run from the repo root (seeds/ must exist, see scripts/curate-seeds.py):
  .venv/Scripts/python scripts/demo_pick.py --out <private notes path>/DEMO-PICK.md

Raw SEC responses and the filtered GHCN rows are cached in data/curation/ (gitignored). The report
contains SEC fact values and must stay in the private notes until the agent reproduces them.
CW_USER_AGENT is read from .env.local and never printed.
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import html
import json
import math
import random
import re
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

TAGS = [
    "Revenues",
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "RegulatedAndUnregulatedOperatingRevenue",
]
FRAMES_URL = "https://data.sec.gov/api/xbrl/frames/us-gaap/{tag}/USD/{period}.json"
CONCEPT_URL = "https://data.sec.gov/api/xbrl/companyconcept/CIK{cik10}/us-gaap/{tag}.json"
INDEX_URL = "https://www.sec.gov/Archives/edgar/data/{cik}/{accn}/index.json"
DOC_URL = "https://www.sec.gov/Archives/edgar/data/{cik}/{accn}/{name}"
GHCN_BUCKET_PREFIX = "noaa-ghcn-pds/parquet/by_year/YEAR={year}/ELEMENT={element}/"
S3_REGION = "us-east-1"

PEER_SIC = {"4911", "4931", "4932"}
BASE_F = 65.0
MAX_ABS_G = 0.60
BOOT_N = 300
BOOT_SEED = 7
SEC_MIN_INTERVAL_S = 0.2
QUARTER_END = {1: "03-31", 2: "06-30", 3: "09-30"}


# ----------------------------------------------------------------------------- helpers
def load_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
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

    def get_bytes(self, url: str) -> bytes:
        wait = SEC_MIN_INTERVAL_S - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)
        req = urllib.request.Request(url, headers={"User-Agent": self.ua, "Accept-Encoding": "gzip, deflate"})
        for attempt in range(3):
            self._last = time.monotonic()
            self.requests += 1
            try:
                with urllib.request.urlopen(req, timeout=120) as resp:
                    body = resp.read()
                    if resp.headers.get("Content-Encoding") == "gzip":
                        body = gzip.decompress(body)
                return body
            except urllib.error.HTTPError as e:
                if e.code in (429, 503) and attempt < 2:
                    time.sleep(2.0 * (attempt + 1))
                    continue
                raise
        raise RuntimeError("unreachable")

    def get_json(self, url: str, cache: Path):
        if cache.exists() and not self.refetch:
            return json.loads(cache.read_text(encoding="utf-8"))
        try:
            data = json.loads(self.get_bytes(url).decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                data = {"_http": 404}
            else:
                raise
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(data), encoding="utf-8")
        return data

    def get_text(self, url: str, cache: Path) -> str:
        if cache.exists() and not self.refetch:
            return cache.read_text(encoding="utf-8")
        text = self.get_bytes(url).decode("utf-8", errors="replace")
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(text, encoding="utf-8")
        return text


def days_in_quarter(year: int, q: int) -> int:
    if q == 1:
        return 91 if (year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)) else 90
    return {2: 91, 3: 92, 4: 92}[q]


def median(xs: list[float]) -> float:
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else 0.5 * (s[n // 2 - 1] + s[n // 2])


def percentile(xs: list[float], p: float) -> float:
    s = sorted(xs)
    if not s:
        return math.nan
    idx = p * (len(s) - 1)
    lo, hi = math.floor(idx), math.ceil(idx)
    return s[lo] if lo == hi else s[lo] + (s[hi] - s[lo]) * (idx - lo)


def ols_slope(xs: list[float], ys: list[float]) -> float | None:
    n = len(xs)
    if n < 3:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return None
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx


def theil_sen(xs: list[float], ys: list[float]) -> float | None:
    slopes = [(ys[j] - ys[i]) / (xs[j] - xs[i])
              for i in range(len(xs)) for j in range(i + 1, len(xs)) if xs[j] != xs[i]]
    return median(slopes) if slopes else None


def pct(x: float | None, nd: int = 1) -> str:
    return "n/a" if x is None or (isinstance(x, float) and math.isnan(x)) else f"{100 * x:+.{nd}f}%"


def rng(lo: float, hi: float) -> str:
    return f"[{pct(lo)}, {pct(hi)}]"


# ----------------------------------------------------------------------------- weather
def load_ghcn(year: int, element: str, station_ids: list[str], refetch: bool):
    """Filtered rows for the seed stations, from the curate-seeds cache or straight from S3."""
    import pyarrow as pa
    import pyarrow.dataset as pds
    import pyarrow.fs as pafs
    import pyarrow.parquet as pq

    cache = GHCN_DIR / f"ghcn_{year}_{element}_candidates.parquet"
    ids_file = cache.with_suffix(".ids.json")
    if cache.exists() and ids_file.exists() and not refetch and set(station_ids) <= set(json.loads(ids_file.read_text())):
        return pq.read_table(cache), "cache"
    fs = pafs.S3FileSystem(anonymous=True, region=S3_REGION)
    prefix = GHCN_BUCKET_PREFIX.format(year=year, element=element)
    files = [f.path for f in fs.get_file_info(pafs.FileSelector(prefix)) if f.path.endswith(".parquet")]
    table = pds.dataset(files, filesystem=fs, format="parquet").to_table(
        columns=["ID", "DATE", "DATA_VALUE", "Q_FLAG"], filter=pds.field("ID").isin(pa.array(station_ids)))
    GHCN_DIR.mkdir(parents=True, exist_ok=True)
    pq.write_table(table, cache)
    ids_file.write_text(json.dumps(sorted(station_ids)))
    return table, f"s3 ({len(files)} files)"


def station_quarters(years: list[int], quarters: list[int], station_ids: list[str], refetch: bool, log: list[str]):
    """-> {(station, year, q): {hdd, cdd, days, coverage, flagged}}"""
    out: dict[tuple, dict] = {}
    for year in years:
        tmax, src1 = load_ghcn(year, "TMAX", station_ids, refetch)
        tmin, src2 = load_ghcn(year, "TMIN", station_ids, refetch)
        log.append(f"GHCN {year}: TMAX {tmax.num_rows} rows ({src1}), TMIN {tmin.num_rows} rows ({src2})")
        maxes: dict[tuple, int] = {}
        flagged: dict[tuple, bool] = {}
        for sid, d, v, qf in zip(tmax.column("ID").to_pylist(), tmax.column("DATE").to_pylist(),
                                 tmax.column("DATA_VALUE").to_pylist(), tmax.column("Q_FLAG").to_pylist()):
            maxes[(sid, d)] = v
            flagged[(sid, d)] = bool(qf and qf.strip())
        acc: dict[tuple, dict] = {}
        for sid, d, v, qf in zip(tmin.column("ID").to_pylist(), tmin.column("DATE").to_pylist(),
                                 tmin.column("DATA_VALUE").to_pylist(), tmin.column("Q_FLAG").to_pylist()):
            if (sid, d) not in maxes:
                continue
            q = (int(d[4:6]) - 1) // 3 + 1
            if q not in quarters:
                continue
            tmean_f = ((maxes[(sid, d)] + v) / 2.0) / 10.0 * 9.0 / 5.0 + 32.0
            a = acc.setdefault((sid, year, q), {"hdd": 0.0, "cdd": 0.0, "days": 0, "flagged": 0})
            a["hdd"] += max(0.0, BASE_F - tmean_f)
            a["cdd"] += max(0.0, tmean_f - BASE_F)
            a["days"] += 1
            a["flagged"] += int(flagged[(sid, d)] or bool(qf and qf.strip()))
        for key, a in acc.items():
            a["coverage"] = a["days"] / days_in_quarter(key[1], key[2])
            out[key] = a
    return out


def utility_weather(u: dict, sq: dict, year: int, q: int):
    rows = [sq.get((sid, year, q)) for sid in u["station_ids"]]
    rows = [r for r in rows if r]
    if not rows:
        return None
    return {
        "tdd": sum(r["hdd"] + r["cdd"] for r in rows) / len(rows),
        "hdd": sum(r["hdd"] for r in rows) / len(rows),
        "cdd": sum(r["cdd"] for r in rows) / len(rows),
        "coverage_min": min(r["coverage"] for r in rows),
        "coverage_mean": sum(r["coverage"] for r in rows) / len(rows),
        "stations": len(rows),
    }


# ----------------------------------------------------------------------------- revenue
def load_frames(sec: SecClient, year: int, quarters: list[int], log: list[str]):
    """-> frames[tag][period][cik_int] = fact"""
    frames: dict[str, dict[str, dict[int, dict]]] = {}
    for tag in TAGS:
        frames[tag] = {}
        for y in (year - 1, year):
            for q in quarters:
                period = f"CY{y}Q{q}"
                data = sec.get_json(FRAMES_URL.format(tag=tag, period=period), SEC_DIR / "frames" / f"{tag}_{period}.json")
                facts = {int(f["cik"]): f for f in data.get("data", [])} if "_http" not in data else {}
                frames[tag][period] = facts
                log.append(f"frames {tag} {period}: {len(facts)} facts" + (" (HTTP 404)" if "_http" in data else ""))
    return frames


def revenue_growth(frames, cik: int, year: int, q: int):
    """Probe the tags in order on the current-year frame; the y-1 value must use the same tag."""
    cur_p, prev_p = f"CY{year}Q{q}", f"CY{year - 1}Q{q}"
    for tag in TAGS:
        cur = frames[tag][cur_p].get(cik)
        if cur is None:
            continue
        prev = frames[tag][prev_p].get(cik)
        if prev is None or not prev.get("val"):
            return {"tag": tag, "status": f"{tag}: no {prev_p} fact", "g": None}
        return {
            "tag": tag, "status": "ok",
            "g": (cur["val"] - prev["val"]) / prev["val"],
            "val_cur": cur["val"], "val_prev": prev["val"],
            "accn_cur": cur["accn"], "accn_prev": prev["accn"],
            "prev_from_current_filing": cur["accn"] == prev["accn"],
            "loc": cur.get("loc"),
        }
    return {"tag": None, "status": f"no revenue fact in {cur_p} under {len(TAGS)} tags", "g": None}


# ----------------------------------------------------------------------------- attribution
def attribute(target: dict, peers: list[dict]) -> dict:
    xs = [p["dw"] for p in peers]
    ys = [p["g"] for p in peers]
    beta = ols_slope(xs, ys)
    ts = theil_sen(xs, ys)
    g_t, dw_t = target["g"], target["dw"]
    res = {"n_peers": len(peers), "beta": beta, "theil_sen": ts}
    if beta is None:
        return {**res, "weather": None, "industry": None, "remainder": None}
    weather = beta * dw_t
    industry = median([y - beta * x for x, y in zip(xs, ys)])
    remainder = g_t - weather - industry
    r = random.Random(BOOT_SEED)
    b_beta, b_weather, b_industry = [], [], []
    for _ in range(BOOT_N):
        idx = [r.randrange(len(peers)) for _ in peers]
        bx, by = [xs[i] for i in idx], [ys[i] for i in idx]
        bb = ols_slope(bx, by)
        if bb is None:
            continue
        b_beta.append(bb)
        b_weather.append(bb * dw_t)
        b_industry.append(median([y - bb * x for x, y in zip(bx, by)]))
    beta_lo, beta_hi = percentile(b_beta, 0.10), percentile(b_beta, 0.90)
    w_lo, w_hi = percentile(b_weather, 0.10), percentile(b_weather, 0.90)
    i_lo, i_hi = percentile(b_industry, 0.10), percentile(b_industry, 0.90)
    r_lo, r_hi = g_t - w_hi - i_hi, g_t - w_lo - i_lo
    cov = target["coverage"]
    beta_excludes_0 = (beta_lo > 0) or (beta_hi < 0)
    if len(peers) >= 20 and cov >= 0.95 and beta_excludes_0:
        conf = "high"
    elif len(peers) >= 12 and cov >= 0.90:
        conf = "medium"
    else:
        conf = "low"
    ratio = abs(weather) / abs(g_t) if g_t else math.inf
    clarity = 0.0 if ratio in (0.0, math.inf) else (ratio if ratio <= 1 else 1 / ratio)
    same_sign = (weather > 0) == (g_t > 0)
    if same_sign and ratio >= 0.5:
        claim = "supported"
    elif same_sign and ratio >= 0.2:
        claim = "partly supported"
    else:
        claim = "not supported"
    return {
        **res, "weather": weather, "industry": industry, "remainder": remainder,
        "beta_range": (beta_lo, beta_hi), "weather_range": (w_lo, w_hi),
        "industry_range": (i_lo, i_hi), "remainder_range": (r_lo, r_hi),
        "beta_excludes_0": beta_excludes_0, "confidence": conf, "ratio": ratio, "clarity": clarity, "claim": claim,
        "bootstrap_used": len(b_beta),
    }


# ----------------------------------------------------------------------------- deep checks
def quarter_facts(data: dict, end: str) -> list[dict]:
    """All 3-month USD facts in a companyconcept response that end on `end`, oldest filing first."""
    facts = []
    for f in (data.get("units", {}) or {}).get("USD", []):
        if f.get("end") != end or not f.get("start"):
            continue
        days = (dt.date.fromisoformat(f["end"]) - dt.date.fromisoformat(f["start"])).days
        if 80 <= days <= 100:
            facts.append({k: f.get(k) for k in ("fy", "fp", "form", "filed", "accn", "val")})
    facts.sort(key=lambda f: f["filed"])
    return facts


def recast_check(sec: SecClient, cik10: str, tag: str, year: int, q: int) -> dict:
    """Like-for-like per the spec: the current filing is the 10-Q filed in `year` for the quarter; its
    comparative column is rule R1's prior-year value. Also reports whether the frames API's values (the
    most recently filed facts) differ from that filing, and whether the prior-year original was recast."""
    data = sec.get_json(CONCEPT_URL.format(cik10=cik10, tag=tag), SEC_DIR / "concept" / f"CIK{cik10}_{tag}.json")
    end_prev, end_cur = f"{year - 1}-{QUARTER_END[q]}", f"{year}-{QUARTER_END[q]}"
    prev_facts, cur_facts = quarter_facts(data, end_prev), quarter_facts(data, end_cur)
    current = next((f for f in cur_facts if f["form"].startswith("10-Q") and f["filed"][:4] == str(year)), None)
    restated_cur = next((f for f in reversed(cur_facts) if current and f["filed"] > current["filed"]), None)
    original_prev = prev_facts[0] if prev_facts else None
    comparative = next((f for f in prev_facts if current and f["accn"] == current["accn"]), None)
    recast = bool(original_prev and comparative and original_prev["val"] != comparative["val"])
    g_r1 = None
    if current and comparative and comparative["val"]:
        g_r1 = (current["val"] - comparative["val"]) / comparative["val"]
    return {
        "period_end": end_prev, "filings": prev_facts, "original": original_prev, "comparative": comparative,
        "recast": recast, "current": current, "current_restated_later": restated_cur,
        "current_recast": bool(current and restated_cur and restated_cur["val"] != current["val"]),
        "g_r1": g_r1,
    }


SENTENCE_RE = re.compile(r"(?<=[.!?])\s+(?=[A-Z(])")
WEATHER_RE = re.compile(r"\b(weather|temperatures?|heating degree|cooling degree|degree[- ]days?)\b", re.I)


def weather_sentences(sec: SecClient, cik: int, accn: str, limit: int = 6) -> dict:
    """Pull sentences mentioning weather from the 10-Q primary document (largest non-exhibit .htm)."""
    accn_nd = accn.replace("-", "")
    try:
        index = sec.get_json(INDEX_URL.format(cik=cik, accn=accn_nd), SEC_DIR / "filings" / f"{accn_nd}.index.json")
    except urllib.error.HTTPError as e:
        return {"error": f"index HTTP {e.code}"}
    items = (index.get("directory") or {}).get("item") or []
    htm = [i for i in items if i["name"].lower().endswith(".htm") and not re.search(r"ex[-_]?\d|exhibit|_ex", i["name"].lower())]
    if not htm:
        return {"error": "no .htm in filing index"}
    doc = max(htm, key=lambda i: int(i.get("size") or 0))
    raw = sec.get_text(DOC_URL.format(cik=cik, accn=accn_nd, name=doc["name"]), SEC_DIR / "filings" / f"{accn_nd}_{doc['name']}")
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", raw, flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text)
    sentences = [s.strip() for s in SENTENCE_RE.split(text)]
    hits = [s for s in sentences if WEATHER_RE.search(s) and 40 <= len(s) <= 700]
    keywords = ("revenue", "sales", "margin", "milder", "colder", "warmer", "favorable", "unfavorable", "degree", "million", "%")
    scored = sorted(hits, key=lambda s: -sum(w in s.lower() for w in keywords))
    return {"document": doc["name"], "accn": accn, "weather_mentions": len(hits), "sentences": scored[:limit]}


# ----------------------------------------------------------------------------- report
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--year", type=int, default=2025)
    ap.add_argument("--quarters", default="1,2,3")
    ap.add_argument("--top", type=int, default=3, help="how many recommended picks to detail")
    ap.add_argument("--deep", type=int, default=14, help="how many ranked candidates get the companyconcept and 10-Q checks")
    ap.add_argument("--detail", default="", help="comma list of TICKER:Q that get a full detail block regardless of rank")
    ap.add_argument("--min-peers", type=int, default=20)
    ap.add_argument("--min-coverage", type=float, default=0.95)
    ap.add_argument("--min-abs-g", type=float, default=0.02,
                    help="ranking preference (not an eligibility rule): a visible revenue swing of at least this size")
    ap.add_argument("--refetch", action="store_true")
    ap.add_argument("--out", default=None, help="markdown report path (private notes); default: data/curation/DEMO-PICK.md")
    args = ap.parse_args()
    cmdline = "python scripts/demo_pick.py " + " ".join(sys.argv[1:])

    quarters = [int(x) for x in args.quarters.split(",")]
    env = load_env(ROOT / ".env.local")
    sec = SecClient(env.get("CW_USER_AGENT", ""), refetch=args.refetch)
    utilities = json.loads((SEEDS_DIR / "utilities.json").read_text(encoding="utf-8"))["utilities"]
    stations = json.loads((SEEDS_DIR / "stations.json").read_text(encoding="utf-8"))["stations"]
    station_ids = [s["id"] for s in stations]
    log: list[str] = []
    t0 = time.monotonic()

    print("== weather (GHCN parquet)")
    sq = station_quarters([args.year - 1, args.year], quarters, station_ids, args.refetch, log)
    for line in log:
        print("  " + line)
    low_cov = sorted((k, v["coverage"]) for k, v in sq.items() if v["coverage"] < args.min_coverage)
    flagged_rows = sum(v["flagged"] for v in sq.values())
    print(f"  station-quarters: {len(sq)}; below coverage {args.min_coverage}: {len(low_cov)}; Q_FLAG-flagged days: {flagged_rows}")

    print("== revenue (SEC frames)")
    n0 = len(log)
    frames = load_frames(sec, args.year, quarters, log)
    for line in log[n0:]:
        print("  " + line)

    # per utility and quarter
    rows: list[dict] = []
    for u in utilities:
        cik = int(u["cik"])
        label = u["ticker"] or u["name"].split()[0][:6].upper()
        for q in quarters:
            rev = revenue_growth(frames, cik, args.year, q)
            w_cur, w_prev = utility_weather(u, sq, args.year, q), utility_weather(u, sq, args.year - 1, q)
            dw = None
            if w_cur and w_prev and w_prev["tdd"] > 0:
                dw = (w_cur["tdd"] - w_prev["tdd"]) / w_prev["tdd"]
            rows.append({
                "cik": u["cik"], "ticker": label, "name": u["name"], "sic": u["sic"], "flags": u["flags"],
                "q": q, "tag": rev["tag"], "rev_status": rev["status"], "g": rev["g"], "rev": rev,
                "dw": dw, "w_cur": w_cur, "w_prev": w_prev,
                "coverage": min(w_cur["coverage_min"], w_prev["coverage_min"]) if (w_cur and w_prev) else 0.0,
            })

    # attribution for every candidate target
    results: list[dict] = []
    for t in rows:
        if t["g"] is None or t["dw"] is None:
            continue
        peers, excluded = [], []
        for p in rows:
            if p["q"] != t["q"] or p["cik"] == t["cik"]:
                continue
            if p["sic"] not in PEER_SIC:
                excluded.append(f"{p['ticker']}: SIC {p['sic']} not in peer set")
            elif p["g"] is None:
                excluded.append(f"{p['ticker']}: {p['rev_status']}")
            elif p["dw"] is None:
                excluded.append(f"{p['ticker']}: no weather")
            elif abs(p["g"]) >= MAX_ABS_G:
                excluded.append(f"{p['ticker']}: |g| = {pct(p['g'])} >= 60%")
            else:
                peers.append(p)
        a = attribute(t, peers)
        same_tag = sum(1 for p in peers if p["tag"] == t["tag"])
        eligible = (a["n_peers"] >= args.min_peers and t["coverage"] >= args.min_coverage
                    and a["weather"] is not None and "never_demo" not in t["flags"])
        results.append({**t, "attr": a, "peers": peers, "excluded": excluded, "peers_same_tag": same_tag, "eligible": eligible})

    # rank: eligible first, unflagged first, visible swings first, then clarity (|weather|/|g_T| folded
    # around 1, so weather explaining roughly the whole change ranks highest), then the size of the weather part
    results.sort(key=lambda r: (
        not r["eligible"],
        bool(r["flags"]),
        abs(r["g"]) < args.min_abs_g,
        -(r["attr"].get("clarity") or 0.0),
        -abs(r["attr"]["weather"] or 0.0),
    ))

    # deep checks on the top eligible candidates plus any requested ones
    wanted = {tuple(x.split(":")) for x in args.detail.split(",") if ":" in x}
    requested = [r for r in results if (r["ticker"], str(r["q"])) in wanted]
    deep = [r for r in results if r["eligible"]][: args.deep]
    deep += [r for r in requested if r not in deep]
    print(f"== deep checks on {len(deep)} candidates (companyconcept + 10-Q text of the filing made in {args.year})")
    for r in deep:
        try:
            r["recast"] = recast_check(sec, r["cik"], r["tag"], args.year, r["q"])
        except Exception as e:  # report, do not abort the pick
            r["recast"] = {"error": f"{type(e).__name__}: {e}"}
        cur = (r["recast"].get("current") or {}) if "error" not in r["recast"] else {}
        try:
            r["mdna"] = weather_sentences(sec, int(r["cik"]), cur.get("accn") or r["rev"]["accn_cur"])
            if not cur.get("accn"):
                r["mdna"]["note"] = "filing made in the target year not found in companyconcept; used the frames accession"
        except Exception as e:
            r["mdna"] = {"error": f"{type(e).__name__}: {e}"}
        rc = r["recast"]
        g_r1 = rc.get("g_r1")
        print(f"  {r['ticker']} Q{r['q']}: g frames {pct(r['g'], 2)} vs R1 {pct(g_r1, 2)}; prior-year recast={rc.get('recast')}; "
              f"current value restated later={rc.get('current_recast')}; 10-Q {r['mdna'].get('document', r['mdna'].get('error'))} "
              f"weather mentions={r['mdna'].get('weather_mentions', '-')}")

    elapsed = round(time.monotonic() - t0, 1)
    run_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()

    # table
    hdr = (f"{'utility':<7}{'Q':<3}{'g_T':>8} {'weather':>8} {'w range':<18}{'industry':>9} {'i range':<18}{'remain':>8} "
           f"{'clar':>5}{'peers':>6}{'same':>5} {'cov':>5} {'conf':<7}{'claim':<17}{'beta':>7}{'TS':>7}  flags")
    lines = [hdr]
    for r in results:
        a = r["attr"]
        if a["weather"] is None:
            lines.append(f"{r['ticker']:<7}Q{r['q']:<2}{pct(r['g']):>8} {'n/a':>8} {'':<18}{'':>9} {'':<18}{'':>8} {'':>5}{a['n_peers']:>6}")
            continue
        flags = ",".join(r["flags"]) + ("" if r["eligible"] else " (not eligible)")
        lines.append(
            f"{r['ticker']:<7}Q{r['q']:<2}{pct(r['g']):>8} {pct(a['weather']):>8} {rng(*a['weather_range']):<18}"
            f"{pct(a['industry']):>9} {rng(*a['industry_range']):<18}{pct(a['remainder']):>8} "
            f"{a['clarity']:>5.2f}{a['n_peers']:>6}{r['peers_same_tag']:>5} {r['coverage']:>5.3f} {a['confidence']:<7}{a['claim']:<17}"
            f"{a['beta']:>7.3f}{(a['theil_sen'] if a['theil_sen'] is not None else math.nan):>7.3f}  {flags}")
    table = "\n".join(lines)
    print("\n== ranked candidates (eligible, unflagged, |g_T| >= min first; then clarity, then |weather|)")
    print(table)

    no_rev = [r for r in rows if r["g"] is None]
    md = []
    md.append(f"# DEMO-PICK: Crosswalk demo candidate ranking (private; holds SEC fact values)\n")
    md.append(f"Generated {run_at} by `{cmdline}` in {elapsed} s ({sec.requests} SEC requests this run; cached responses reused).  ")
    md.append(f"Year {args.year} vs {args.year - 1}, quarters {quarters}. Seeds: {len(utilities)} utilities, {len(stations)} stations. "
              f"Eligibility: peers >= {args.min_peers}, target coverage >= {args.min_coverage}, not Dominion.\n")
    md.append("## Inputs\n")
    md.extend(f"- {l}" for l in log)
    md.append(f"- station-quarters computed: {len(sq)}; below coverage {args.min_coverage}: "
              f"{', '.join(f'{k[0]} {k[1]}Q{k[2]} {c:.3f}' for k, c in low_cov) or 'none'}; days with a Q_FLAG: {flagged_rows}")
    md.append(f"- utilities without a usable revenue pair: " + (", ".join(f"{r['ticker']} Q{r['q']} ({r['rev_status']})" for r in no_rev) or "none"))
    md.append("\n## Ranked table\n\n```\n" + table + "\n```\n")
    md.append("Columns: g_T = YoY revenue growth; weather = beta x dw_T; industry = median peer growth net of weather; "
              "remain = g_T - weather - industry; clar = |weather|/|g_T| folded around 1 (1.00 = weather explains the whole change); "
              "peers = peer count after exclusions; same = peers that use the target's tag; "
              "cov = min station coverage over both periods; beta = OLS slope of g on dw; TS = Theil-Sen slope. Ranges are bootstrap 10th-90th "
              f"({BOOT_N} resamples, seed {BOOT_SEED}). Rank order: eligible, unflagged, |g_T| >= {args.min_abs_g:.0%} first, then clarity, then |weather|.\n")

    detail_rows = [x for x in results if x["eligible"]][: args.top]
    detail_rows += [r for r in requested if r not in detail_rows]
    md.append(f"## Top {args.top} by script ranking" + (f" plus requested detail ({args.detail})" if requested else "") + "\n")
    for r in detail_rows:
        a, rv = r["attr"], r["rev"]
        md.append(f"### {r['name']} ({r['ticker']}, CIK {r['cik']}) Q{r['q']} {args.year} vs {args.year - 1}\n")
        md.append(f"- revenue tag `{r['tag']}` (frames, most recently filed facts): {rv['val_cur']:,.0f} vs {rv['val_prev']:,.0f} USD -> g_T = {pct(r['g'], 2)}; "
                  f"frames accn {rv['accn_cur']} / {rv['accn_prev']}")
        rc = r.get("recast") or {}
        if rc.get("current"):
            c, cp = rc["current"], rc.get("comparative")
            cp_val = f"{cp['val']:,.0f}" if cp else "missing"
            md.append(f"- like-for-like (companyconcept, filing made in {args.year}: {c['form']} filed {c['filed']} accn {c['accn']}): "
                      f"{c['val']:,.0f} vs comparative {cp_val} USD -> g_R1 = {pct(rc.get('g_r1'), 2)}; "
                      f"matches frames: {rc.get('g_r1') is not None and abs(rc['g_r1'] - r['g']) < 1e-9}; "
                      f"current value restated in a later filing: {rc.get('current_recast')}"
                      + (f" ({rc['current_restated_later']['val']:,.0f} in {rc['current_restated_later']['accn']})" if rc.get("current_restated_later") else ""))
        wc, wp = r["w_cur"], r["w_prev"]
        md.append(f"- weather: TDD {wc['tdd']:.0f} vs {wp['tdd']:.0f} (HDD {wc['hdd']:.0f}/{wp['hdd']:.0f}, CDD {wc['cdd']:.0f}/{wp['cdd']:.0f}) "
                  f"over {wc['stations']} stations -> dw_T = {pct(r['dw'], 2)}; coverage min {r['coverage']:.3f}")
        md.append(f"- peers {a['n_peers']} ({r['peers_same_tag']} on the same tag); beta OLS {a['beta']:.3f} {rng(*a['beta_range'])} "
                  f"(Theil-Sen {a['theil_sen']:.3f}); beta range excludes 0: {a['beta_excludes_0']}; bootstrap resamples used {a['bootstrap_used']}")
        md.append(f"- split: weather {pct(a['weather'], 2)} {rng(*a['weather_range'])}; industry {pct(a['industry'], 2)} {rng(*a['industry_range'])}; "
                  f"remainder {pct(a['remainder'], 2)} {rng(*a['remainder_range'])}")
        md.append(f"- confidence {a['confidence']}; claim 'it was the weather': {a['claim']} (|weather|/|g_T| = {a['ratio']:.2f})")
        md.append("- excluded from peers: " + "; ".join(r["excluded"]))
        rc = r.get("recast")
        if rc:
            if "error" in rc:
                md.append(f"- recast check: {rc['error']}")
            else:
                fl = "; ".join(f"fy{f['fy']} {f['fp']} {f['form']} filed {f['filed']} {f['accn']} val {f['val']:,.0f}" for f in rc["filings"])
                md.append(f"- recast check (companyconcept, period ending {rc['period_end']}): recast={rc['recast']}; {fl}")
        m = r.get("mdna")
        if m:
            if "error" in m:
                md.append(f"- 10-Q text check: {m['error']}")
            else:
                md.append(f"- 10-Q `{m['document']}` (accn {m['accn']}): {m['weather_mentions']} sentences mention weather, temperatures or degree days"
                          + (f"; {m['note']}" if m.get("note") else "") + ". Best matches:")
                md.extend(f"  > {s}" for s in m["sentences"])
        md.append("")

    md.append("## All eligible candidates in rank order\n")
    for r in [x for x in results if x["eligible"]]:
        a = r["attr"]
        md.append(f"- {r['ticker']} Q{r['q']}: g {pct(r['g'])}, weather {pct(a['weather'])} {rng(*a['weather_range'])}, "
                  f"peers {a['n_peers']}, cov {r['coverage']:.3f}, {a['confidence']}, {a['claim']}")
    md.append("\n## Not eligible\n")
    for r in [x for x in results if not x["eligible"]]:
        a = r["attr"]
        why = []
        if a["n_peers"] < args.min_peers:
            why.append(f"peers {a['n_peers']}")
        if r["coverage"] < args.min_coverage:
            why.append(f"coverage {r['coverage']:.3f}")
        if "never_demo" in r["flags"]:
            why.append("never the demo pick")
        if a["weather"] is None:
            why.append("no beta")
        md.append(f"- {r['ticker']} Q{r['q']}: {', '.join(why)}")

    md.append("\n## Open questions for the agent lanes (from this run)\n")
    same_tag_gap = [r for r in results if r["eligible"] and r["peers_same_tag"] < args.min_peers]
    md.append(f"- Peer set and tags: {len(same_tag_gap)} of {sum(r['eligible'] for r in results)} eligible candidates use a revenue tag "
              f"that fewer than {args.min_peers} peers share (column `same`). If `get_peers(period, tag)` restricts peers to the target's "
              "tag, those targets fall below the peer floor; probing each peer's tag in the same order (as this script does) keeps all peers.")
    md.append(f"- Which filing: the frames API serves the most recently filed fact for a period. Today that means the CY{args.year}Q<n> "
              f"values come from the {args.year + 1} 10-Qs' comparative columns and the CY{args.year - 1}Q<n> values from the {args.year} "
              f"10-Qs' comparative columns ({sum(1 for r in results if r['rev']['prev_from_current_filing'])} of {len(results)} rows have both "
              f"values from one filing). The spec's like-for-like step must take the current value from the filing made in {args.year} "
              f"(companyconcept, fy={args.year}) and the prior-year value from that filing's comparative; the detail blocks show g_R1 next to the frames g.")
    md.append(f"- Q_FLAG: {flagged_rows} station-days in the computed quarters carry a GHCN quality flag; the method (and this script) keeps them. "
              "Decide whether the Lightning SQL filters Q_FLAG = '' and keep both sides consistent.")
    md.append("- Coverage is the minimum over the target's stations and both periods; the bootstrap resamples peers only (not stations).")

    out = Path(args.out) if args.out else CUR / "DEMO-PICK.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(md) + "\n", encoding="utf-8")
    (CUR / "demo_pick.results.json").write_text(json.dumps(
        [{k: v for k, v in r.items() if k not in ("peers", "w_cur", "w_prev")} for r in results], indent=1, default=str), encoding="utf-8")
    print(f"\n  wrote {out} ({len(results)} candidate rows, {sum(r['eligible'] for r in results)} eligible) in {elapsed} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
