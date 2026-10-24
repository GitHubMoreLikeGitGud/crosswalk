"""Known-answer fixture generator for the deterministic tools (tasks C1 to C3).

Writes the JSON fixtures next to this file. Every expected number in those files is
computed here, in Python, from the formulas in the build method, independently of the
TypeScript under test. The series are synthetic: no NOAA or SEC data is copied.

Run from the repository root:  python agent/test/fixtures/make_fixtures.py
"""

from __future__ import annotations

import json
import math
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
MASK = 0xFFFFFFFF


# ---------------------------------------------------------------- seeded PRNG (mulberry32)
def imul(a: int, b: int) -> int:
    return ((a & MASK) * (b & MASK)) & MASK


def mulberry32(seed: int):
    """Bit-exact replica of the JavaScript mulberry32 used by the tools (seed 7)."""
    a = seed & MASK

    def rnd() -> float:
        nonlocal a
        a = (a + 0x6D2B79F5) & MASK
        t = imul(a ^ (a >> 15), a | 1)
        t = ((t + imul(t ^ (t >> 7), t | 61)) ^ t) & MASK
        return ((t ^ (t >> 14)) & MASK) / 4294967296

    return rnd


# ---------------------------------------------------------------- statistics helpers
def percentile_type7(values: list[float], p: float) -> float:
    v = sorted(values)
    if not v:
        raise ValueError("empty")
    h = (len(v) - 1) * p
    lo = math.floor(h)
    hi = min(lo + 1, len(v) - 1)
    return v[lo] + (h - lo) * (v[hi] - v[lo])


def median(values: list[float]) -> float:
    v = sorted(values)
    n = len(v)
    if n == 0:
        raise ValueError("empty")
    mid = n // 2
    return v[mid] if n % 2 == 1 else (v[mid - 1] + v[mid]) / 2


def ols_slope(xs: list[float], ys: list[float]) -> float | None:
    n = len(xs)
    xbar = sum(xs) / n
    ybar = sum(ys) / n
    sxx = sum((x - xbar) ** 2 for x in xs)
    if sxx == 0:
        return None
    sxy = sum((x - xbar) * (y - ybar) for x, y in zip(xs, ys))
    return sxy / sxx


def theil_sen(xs: list[float], ys: list[float]) -> float | None:
    slopes = []
    for i in range(len(xs)):
        for j in range(i + 1, len(xs)):
            if xs[j] != xs[i]:
                slopes.append((ys[j] - ys[i]) / (xs[j] - xs[i]))
    return median(slopes) if slopes else None


def attribution(target: dict, peers: list[dict], resamples: int = 300, seed: int = 7) -> dict:
    xs = [p["dw"] for p in peers]
    ys = [p["g"] for p in peers]
    beta = ols_slope(xs, ys)
    ts = theil_sen(xs, ys)
    weather = beta * target["dw"]
    industry = median([y - beta * x for x, y in zip(xs, ys)])
    remainder = target["g"] - weather - industry

    rnd = mulberry32(seed)
    n = len(peers)
    b_betas, b_weather, b_industry = [], [], []
    skipped = 0
    for _ in range(resamples):
        idx = [math.floor(rnd() * n) for _ in range(n)]
        rx = [xs[i] for i in idx]
        ry = [ys[i] for i in idx]
        b = ols_slope(rx, ry)
        if b is None:
            skipped += 1
            continue
        b_betas.append(b)
        b_weather.append(b * target["dw"])
        b_industry.append(median([y - b * x for x, y in zip(rx, ry)]))

    def rng(vals):
        return {"lo": percentile_type7(vals, 0.10), "hi": percentile_type7(vals, 0.90)}

    beta_r, weather_r, industry_r = rng(b_betas), rng(b_weather), rng(b_industry)
    remainder_r = {
        "lo": target["g"] - weather_r["hi"] - industry_r["hi"],
        "hi": target["g"] - weather_r["lo"] - industry_r["lo"],
    }
    return {
        "beta": beta,
        "theil_sen": ts,
        "weather": weather,
        "industry": industry,
        "remainder": remainder,
        "bootstrap": {
            "resamples": resamples,
            "valid": len(b_betas),
            "skipped_zero_variance": skipped,
            "beta": beta_r,
            "weather": weather_r,
            "industry": industry_r,
            "remainder": remainder_r,
        },
    }


# ---------------------------------------------------------------- degree days
def tenths_c_to_f(tenths: float) -> float:
    return tenths / 10 * 9 / 5 + 32


def quarter_bounds(year: int, quarter: int) -> tuple[date, date]:
    start = date(year, 3 * (quarter - 1) + 1, 1)
    end = date(year + 1, 1, 1) - timedelta(days=1) if quarter == 4 else date(year, 3 * quarter + 1, 1) - timedelta(days=1)
    return start, end


def synth_series(station: str, year: int, quarter: int, seed: int, base_tmean_c: float, swing_c: float,
                 missing_tmin: list[int], bad_qflag_tmax: list[int]) -> list[dict]:
    """Daily TMAX/TMIN in tenths of a degree C with a seasonal ramp and seeded jitter."""
    start, end = quarter_bounds(year, quarter)
    rnd = mulberry32(seed)
    rows = []
    d = start
    i = 0
    while d <= end:
        frac = i / max(1, (end - start).days)
        tmean = base_tmean_c + swing_c * frac + (rnd() - 0.5) * 6.0
        spread = 4.0 + rnd() * 6.0
        tmax = round((tmean + spread / 2) * 10)
        tmin = round((tmean - spread / 2) * 10)
        row = {
            "ID": station,
            "DATE": d.strftime("%Y%m%d"),
            "TMAX": tmax,
            "TMIN": tmin,
            "TMAX_Q_FLAG": "",
            "TMIN_Q_FLAG": "",
        }
        if i in missing_tmin:
            row["TMIN"] = None
        if i in bad_qflag_tmax:
            row["TMAX_Q_FLAG"] = "X"
        rows.append(row)
        d += timedelta(days=1)
        i += 1
    return rows


def degree_days(rows: list[dict], year: int, quarter: int) -> dict:
    start, end = quarter_bounds(year, quarter)
    days_in_quarter = (end - start).days + 1
    hdd = cdd = 0.0
    observed = 0
    for r in rows:
        if r["TMAX"] is None or r["TMIN"] is None:
            continue
        if r["TMAX_Q_FLAG"] or r["TMIN_Q_FLAG"]:
            continue
        tmean_f = tenths_c_to_f((r["TMAX"] + r["TMIN"]) / 2)
        hdd += max(0.0, 65 - tmean_f)
        cdd += max(0.0, tmean_f - 65)
        observed += 1
    return {
        "station_id": rows[0]["ID"],
        "year": year,
        "quarter": quarter,
        "hdd": hdd,
        "cdd": cdd,
        "days_observed": observed,
        "days_in_quarter": days_in_quarter,
        "coverage": observed / days_in_quarter,
    }


def build_degree_days() -> dict:
    series = {
        # station, year, quarter, seed, base C, swing C, missing TMIN day indexes, bad TMAX Q_FLAG indexes
        ("USW00099001", 2025, 1): (11, 2.0, 10.0, [10, 40], [75]),
        ("USW00099001", 2024, 1): (12, 0.0, 9.0, [], [20]),
        ("USW00099002", 2025, 1): (13, 12.0, 8.0, [5], []),
        ("USW00099002", 2024, 1): (14, 14.0, 7.0, [], []),
        ("USW00099001", 2025, 3): (15, 24.0, -3.0, [], []),
    }
    daily = {}
    expected = []
    for (station, year, quarter), (seed, base, swing, miss, bad) in series.items():
        rows = synth_series(station, year, quarter, seed, base, swing, miss, bad)
        daily[f"{station}:{year}:Q{quarter}"] = rows
        expected.append(degree_days(rows, year, quarter))

    def tdd(station, year):
        e = next(x for x in expected if x["station_id"] == station and x["year"] == year and x["quarter"] == 1)
        return e["hdd"] + e["cdd"]

    def cov(station, year):
        e = next(x for x in expected if x["station_id"] == station and x["year"] == year and x["quarter"] == 1)
        return e["coverage"]

    stations = ["USW00099001", "USW00099002"]
    tdd_2025 = sum(tdd(s, 2025) for s in stations) / len(stations)
    tdd_2024 = sum(tdd(s, 2024) for s in stations) / len(stations)
    utility = {
        "cik": "0009999999",
        "stations": stations,
        "year": 2025,
        "quarter": 1,
        "tdd_current": tdd_2025,
        "tdd_previous": tdd_2024,
        "delta_w": (tdd_2025 - tdd_2024) / tdd_2024,
        "coverage_current": min(cov(s, 2025) for s in stations),
        "coverage_previous": min(cov(s, 2024) for s in stations),
        "coverage": min(min(cov(s, 2025), cov(s, 2024)) for s in stations),
    }
    conversions = [
        {"tenths_c": 0, "f": 32.0},
        {"tenths_c": 1000, "f": 212.0},
        {"tenths_c": -400, "f": -40.0},
        {"tenths_c": 183, "f": tenths_c_to_f(183)},
        {"tenths_c": 184, "f": tenths_c_to_f(184)},
    ]
    return {
        "synthetic": True,
        "note": "Synthetic daily series in the shape of the GHCN by_year parquet (DATA_VALUE in tenths of a degree C). Station ids are made up. Expected values come from make_fixtures.py.",
        "days_in_quarter": {"2024": [91, 91, 92, 92], "2025": [90, 91, 92, 92]},
        "conversions": conversions,
        "daily": daily,
        "expected": expected,
        "utility": utility,
    }


# ---------------------------------------------------------------- attribution
def build_attribution() -> dict:
    three = {
        "name": "three-peer hand case",
        "target": {"cik": "0000000100", "g": 0.09, "dw": 0.08, "coverage": 0.97},
        "peers": [
            {"cik": "0000000001", "g": -0.05, "dw": -0.10},
            {"cik": "0000000002", "g": 0.01, "dw": 0.00},
            {"cik": "0000000003", "g": 0.10, "dw": 0.10},
        ],
    }
    three["expected"] = attribution(three["target"], three["peers"])
    three["expected"]["hand"] = {
        "beta": 0.75,
        "theil_sen": 0.75,
        "weather": 0.06,
        "industry": 0.025,
        "remainder": 0.005,
        "claim_ratio": 0.06 / 0.09,
        "claim_verdict": "supported",
        "confidence": "low",
        "why_low": "3 peers is fewer than 12",
    }

    rnd = mulberry32(99)
    peers30 = []
    for p in range(30):
        dw = round(-0.15 + 0.01 * p, 6)
        noise = (rnd() - 0.5) * 0.04
        g = 0.8 * dw + 0.02 + noise
        peers30.append({"cik": f"{p + 1:010d}", "g": g, "dw": dw})
    thirty = {
        "name": "thirty-peer synthetic case",
        "target": {"cik": "0000000100", "g": 0.11, "dw": 0.10, "coverage": 0.97},
        "peers": peers30,
    }
    thirty["expected"] = attribution(thirty["target"], thirty["peers"])
    e = thirty["expected"]
    ratio = abs(e["weather"]) / abs(thirty["target"]["g"])
    e["claim_ratio"] = ratio
    e["claim_verdict"] = "supported" if ratio >= 0.5 else ("partly supported" if ratio >= 0.2 else "not supported")
    excludes_zero = e["bootstrap"]["beta"]["lo"] > 0 or e["bootstrap"]["beta"]["hi"] < 0
    e["beta_interval_excludes_zero"] = excludes_zero
    e["confidence"] = "high" if excludes_zero else "medium"

    peer_rows = {
        "target_cik": "0000000100",
        "seed_ciks": ["0000000100", "0000000001", "0000000002", "0000000003", "0000000004", "0000000005", "0000000006"],
        "rows": [
            {"cik": "0000000100", "sic": "4911", "rev_current": 1.09e9, "rev_previous": 1.0e9},
            {"cik": "0000000001", "sic": "4911", "rev_current": 9.5e8, "rev_previous": 1.0e9},
            {"cik": "0000000002", "sic": "4931", "rev_current": 1.01e9, "rev_previous": 1.0e9},
            {"cik": "0000000003", "sic": "4932", "rev_current": 1.10e9, "rev_previous": 1.0e9},
            {"cik": "0000000004", "sic": "4911", "rev_current": 1.70e9, "rev_previous": 1.0e9},
            {"cik": "0000000005", "sic": "4911", "rev_current": 1.02e9, "rev_previous": None},
            {"cik": "0000000006", "sic": "4941", "rev_current": 1.03e9, "rev_previous": 1.0e9},
            {"cik": "0000000007", "sic": "4911", "rev_current": 1.04e9, "rev_previous": 1.0e9},
        ],
        "expected_peers": [
            {"cik": "0000000001", "g": -0.05},
            {"cik": "0000000002", "g": 0.01},
            {"cik": "0000000003", "g": 0.10},
        ],
        "expected_excluded": [
            {"cik": "0000000100", "reason": "excluded: target"},
            {"cik": "0000000004", "reason": "excluded: |g| >= 60% (0.7000)"},
            {"cik": "0000000005", "reason": "excluded: previous period missing"},
            {"cik": "0000000006", "reason": "excluded: SIC 4941 not in 4911, 4931, 4932"},
            {"cik": "0000000007", "reason": "excluded: not in seed list"},
        ],
    }

    prng_first5 = []
    r7 = mulberry32(7)
    for _ in range(5):
        prng_first5.append(r7())

    return {
        "synthetic": True,
        "note": "Hand case: beta 0.75, Theil-Sen 0.75, weather 0.06, industry 0.025, remainder 0.005 (see make_fixtures.py). Bootstrap numbers assume mulberry32 seed 7, 300 resamples of n draws each with floor(r*n), zero-variance resamples skipped, type-7 percentiles.",
        "prng_seed7_first5": prng_first5,
        "cases": [three, thirty],
        "peer_set": peer_rows,
        "confidence_cases": [
            {"peers": 25, "coverage": 0.96, "beta_lo": 0.2, "beta_hi": 1.1, "expected": "high"},
            {"peers": 25, "coverage": 0.96, "beta_lo": -0.1, "beta_hi": 1.1, "expected": "medium"},
            {"peers": 25, "coverage": 0.94, "beta_lo": 0.2, "beta_hi": 1.1, "expected": "medium"},
            {"peers": 15, "coverage": 0.92, "beta_lo": 0.2, "beta_hi": 1.1, "expected": "medium"},
            {"peers": 15, "coverage": 0.85, "beta_lo": 0.2, "beta_hi": 1.1, "expected": "low"},
            {"peers": 11, "coverage": 0.99, "beta_lo": 0.2, "beta_hi": 1.1, "expected": "low"},
        ],
        # Boundary cases use ratios that are exact in binary floating point (0.25 / 0.5 and
        # 0.2 / 1.0), so the thresholds can be compared exactly without an epsilon.
        "claim_cases": [
            {"g": 0.5, "weather": 0.25, "expected": "supported", "ratio": 0.5},
            {"g": 0.5, "weather": 0.245, "expected": "partly supported", "ratio": 0.49},
            {"g": 1.0, "weather": 0.2, "expected": "partly supported", "ratio": 0.2},
            {"g": 1.0, "weather": 0.19, "expected": "not supported", "ratio": 0.19},
            {"g": 0.10, "weather": -0.08, "expected": "not supported", "ratio": 0.8},
            {"g": -0.10, "weather": -0.06, "expected": "supported", "ratio": 0.6},
            {"g": 0.0, "weather": 0.01, "expected": "not supported", "ratio": None},
        ],
    }


# ---------------------------------------------------------------- companyconcept with a recast
def build_companyconcept() -> dict:
    def fact(start, end, val, accn, fy, fp, form, filed, frame=None):
        f = {"start": start, "end": end, "val": val, "accn": accn, "fy": fy, "fp": fp, "form": form, "filed": filed}
        if frame:
            f["frame"] = frame
        return f

    usd = [
        # FY2023 as first reported (10-K for 2023) and as the comparative in the 2024 10-K (equal: no recast)
        fact("2023-01-01", "2023-12-31", 3_900_000_000, "0009999999-24-000001", 2023, "FY", "10-K", "2024-02-22", "CY2023"),
        fact("2023-01-01", "2023-12-31", 3_900_000_000, "0009999999-25-000001", 2024, "FY", "10-K", "2025-02-20"),
        # 2024 quarters as first reported
        fact("2024-01-01", "2024-03-31", 1_000_000_000, "0009999999-24-000002", 2024, "Q1", "10-Q", "2024-05-01", "CY2024Q1"),
        fact("2024-04-01", "2024-06-30", 900_000_000, "0009999999-24-000003", 2024, "Q2", "10-Q", "2024-08-01", "CY2024Q2"),
        fact("2024-01-01", "2024-06-30", 1_900_000_000, "0009999999-24-000003", 2024, "Q2", "10-Q", "2024-08-01"),
        fact("2024-07-01", "2024-09-30", 1_200_000_000, "0009999999-24-000004", 2024, "Q3", "10-Q", "2024-10-31", "CY2024Q3"),
        fact("2024-01-01", "2024-09-30", 3_100_000_000, "0009999999-24-000004", 2024, "Q3", "10-Q", "2024-10-31"),
        # FY2024
        fact("2024-01-01", "2024-12-31", 4_100_000_000, "0009999999-25-000001", 2024, "FY", "10-K", "2025-02-20", "CY2024"),
        # Q1 2025 10-Q: current quarter plus the Q1 2024 comparative, which was RECAST (1.00e9 -> 0.98e9)
        fact("2025-01-01", "2025-03-31", 1_100_000_000, "0009999999-25-000002", 2025, "Q1", "10-Q", "2025-05-02", "CY2025Q1"),
        fact("2024-01-01", "2024-03-31", 980_000_000, "0009999999-25-000002", 2025, "Q1", "10-Q", "2025-05-02"),
        # Q2 2025 10-Q: current quarter plus an UNCHANGED Q2 2024 comparative and the 6-month figures
        fact("2025-04-01", "2025-06-30", 950_000_000, "0009999999-25-000003", 2025, "Q2", "10-Q", "2025-08-01", "CY2025Q2"),
        fact("2024-04-01", "2024-06-30", 900_000_000, "0009999999-25-000003", 2025, "Q2", "10-Q", "2025-08-01"),
        fact("2025-01-01", "2025-06-30", 2_050_000_000, "0009999999-25-000003", 2025, "Q2", "10-Q", "2025-08-01"),
        fact("2024-01-01", "2024-06-30", 1_880_000_000, "0009999999-25-000003", 2025, "Q2", "10-Q", "2025-08-01"),
    ]
    concept = {
        "cik": 9999999,
        "taxonomy": "us-gaap",
        "tag": "Revenues",
        "label": "Revenues",
        "description": "Synthetic fixture in the shape of a companyconcept response. Not SEC data.",
        "entityName": "Synthetic Utility Holdings (fixture)",
        "units": {"USD": usd},
    }
    g = (1_100_000_000 - 980_000_000) / 980_000_000
    expected = {
        "cy2024q1_original": {"val": 1_000_000_000, "accn": "0009999999-24-000002", "filed": "2024-05-01", "fy": 2024, "fp": "Q1"},
        "cy2024q1_comparative_in_cy2025q1_filing": {"val": 980_000_000, "accn": "0009999999-25-000002", "filed": "2025-05-02", "fy": 2025, "fp": "Q1"},
        "cy2024q1_recast": True,
        "cy2024q1_r1_value": 980_000_000,
        "cy2025q1_value": 1_100_000_000,
        "cy2025q1_accn": "0009999999-25-000002",
        "growth_like_for_like": g,
        "growth_naive_original": 0.10,
        "cy2024q2_recast": False,
        "cy2024q2_value": 900_000_000,
        "cy2024q3_value": 1_200_000_000,
        "cy2024q3_note": "the 9-month fact 2024-01-01..2024-09-30 must not match Q3",
        "cy2025q3_value": None,
        "fy2024_value": 4_100_000_000,
        "fy2023_recast": False,
        "fy2023_value": 3_900_000_000,
        "fy2024_accn": "0009999999-25-000001",
    }
    return {"synthetic": True, "concept": concept, "expected": expected}


def main() -> None:
    out = {
        "degree-days.json": build_degree_days(),
        "attribution.json": build_attribution(),
        "companyconcept-recast.json": build_companyconcept(),
    }
    for name, payload in out.items():
        path = HERE / name
        path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {path.name} ({path.stat().st_size} bytes)")
    dd = out["degree-days.json"]
    for e in dd["expected"]:
        print(f"  {e['station_id']} {e['year']} Q{e['quarter']}: HDD {e['hdd']:.4f} CDD {e['cdd']:.4f} days {e['days_observed']}/{e['days_in_quarter']} cov {e['coverage']:.4f}")
    u = dd["utility"]
    print(f"  utility TDD {u['tdd_current']:.4f} vs {u['tdd_previous']:.4f} delta_w {u['delta_w']:.6f} coverage {u['coverage']:.4f}")
    at = out["attribution.json"]
    print("  prng seed 7 first 5:", at["prng_seed7_first5"])
    for c in at["cases"]:
        e = c["expected"]
        print(f"  {c['name']}: beta {e['beta']:.6f} TS {e['theil_sen']:.6f} weather {e['weather']:.6f} industry {e['industry']:.6f} remainder {e['remainder']:.6f} "
              f"beta10-90 [{e['bootstrap']['beta']['lo']:.6f}, {e['bootstrap']['beta']['hi']:.6f}] valid {e['bootstrap']['valid']} skipped {e['bootstrap']['skipped_zero_variance']}")
    print("  companyconcept growth like-for-like:", out["companyconcept-recast.json"]["expected"]["growth_like_for_like"])


if __name__ == "__main__":
    main()
