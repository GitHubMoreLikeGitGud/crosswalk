/** Peer-set attribution: OLS / Theil-Sen sensitivity, three-way split, seeded bootstrap. */

export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function median(values: number[]): number {
  if (values.length === 0) throw new Error("median of empty array");
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  if (v.length % 2 === 1) return v[mid]!;
  return (v[mid - 1]! + v[mid]!) / 2;
}

/** Type-7 percentile (linear interpolation). */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) throw new Error("percentile of empty array");
  const v = [...values].sort((a, b) => a - b);
  const h = (v.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, v.length - 1);
  return v[lo]! + (h - lo) * (v[hi]! - v[lo]!);
}

export function olsSlope(xs: number[], ys: number[]): number | null {
  if (xs.length < 2 || ys.length < 2 || xs.length !== ys.length) return null;
  const n = xs.length;
  let xbar = 0;
  let ybar = 0;
  for (let i = 0; i < n; i++) {
    xbar += xs[i]!;
    ybar += ys[i]!;
  }
  xbar /= n;
  ybar /= n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - xbar;
    sxx += dx * dx;
    sxy += dx * (ys[i]! - ybar);
  }
  if (sxx === 0) return null;
  return sxy / sxx;
}

export function theilSen(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length) return null;
  const slopes: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length; j++) {
      if (xs[j] !== xs[i]) {
        slopes.push((ys[j]! - ys[i]!) / (xs[j]! - xs[i]!));
      }
    }
  }
  return slopes.length === 0 ? null : median(slopes);
}

export const PEER_SICS = ["4911", "4931", "4932"] as const;
export const MAX_ABS_PEER_GROWTH = 0.6;

export interface RevenueRow {
  cik: string;
  sic: string | null;
  rev_current: number | null;
  rev_previous: number | null;
}

export interface PeerGrowth {
  cik: string;
  g: number;
  rev_current: number;
  rev_previous: number;
}

export interface Exclusion {
  cik: string;
  reason: string;
}

export function peerSet(
  rows: RevenueRow[],
  targetCik: string,
  seedCiks: string[],
): { peers: PeerGrowth[]; excluded: Exclusion[] } {
  const seed = new Set(seedCiks);
  const peers: PeerGrowth[] = [];
  const excluded: Exclusion[] = [];

  for (const row of rows) {
    if (row.cik === targetCik) {
      excluded.push({ cik: row.cik, reason: "excluded: target" });
      continue;
    }
    if (!seed.has(row.cik)) {
      excluded.push({ cik: row.cik, reason: "excluded: not in seed list" });
      continue;
    }
    if (row.sic === null || !(PEER_SICS as readonly string[]).includes(row.sic)) {
      const sicLabel = row.sic ?? "null";
      excluded.push({
        cik: row.cik,
        reason: `excluded: SIC ${sicLabel} not in 4911, 4931, 4932`,
      });
      continue;
    }
    if (row.rev_previous === null) {
      excluded.push({ cik: row.cik, reason: "excluded: previous period missing" });
      continue;
    }
    if (row.rev_current === null) {
      excluded.push({ cik: row.cik, reason: "excluded: current period missing" });
      continue;
    }
    if (!(row.rev_previous > 0)) {
      excluded.push({ cik: row.cik, reason: "excluded: previous revenue not positive" });
      continue;
    }
    const g = (row.rev_current - row.rev_previous) / row.rev_previous;
    if (Math.abs(g) >= MAX_ABS_PEER_GROWTH) {
      excluded.push({
        cik: row.cik,
        reason: `excluded: |g| >= 60% (${g.toFixed(4)})`,
      });
      continue;
    }
    peers.push({
      cik: row.cik,
      g,
      rev_current: row.rev_current,
      rev_previous: row.rev_previous,
    });
  }

  return { peers, excluded };
}

export interface PeerPoint {
  cik: string;
  g: number;
  dw: number;
}

export interface TargetPoint extends PeerPoint {
  coverage: number;
}

export interface Range {
  lo: number;
  hi: number;
}

export type Confidence = "high" | "medium" | "low";
export type ClaimVerdict = "supported" | "partly supported" | "not supported";

export function confidenceLabel(
  peers: number,
  coverage: number,
  betaRange: Range,
): Confidence {
  const excludesZero = betaRange.lo > 0 || betaRange.hi < 0;
  if (peers >= 20 && coverage >= 0.95 && excludesZero) return "high";
  if (peers >= 12 && coverage >= 0.9) return "medium";
  return "low";
}

export function claimVerdict(
  g: number,
  weather: number,
): { ratio: number | null; verdict: ClaimVerdict } {
  if (g === 0) {
    return { ratio: null, verdict: "not supported" };
  }
  const ratio = Math.abs(weather) / Math.abs(g);
  const same = Math.sign(weather) === Math.sign(g);
  if (same && ratio >= 0.5) return { ratio, verdict: "supported" };
  if (same && ratio >= 0.2) return { ratio, verdict: "partly supported" };
  return { ratio, verdict: "not supported" };
}

export interface Attribution {
  target: TargetPoint;
  peers: number;
  beta: number;
  theil_sen: number | null;
  weather: number;
  industry: number;
  remainder: number;
  ranges: {
    beta: Range;
    weather: Range;
    industry: Range;
    remainder: Range;
  };
  bootstrap: {
    resamples: number;
    valid: number;
    skipped_zero_variance: number;
    seed: number;
  };
  coverage: number;
  confidence: Confidence;
  claim: { ratio: number | null; verdict: ClaimVerdict };
}

export function attribute(
  target: TargetPoint,
  peers: PeerPoint[],
  options?: { resamples?: number; seed?: number },
): Attribution {
  const resamples = options?.resamples ?? 300;
  const seed = options?.seed ?? 7;

  if (peers.length < 2) {
    throw new Error("attribute requires at least 2 peers");
  }

  const xs = peers.map((p) => p.dw);
  const ys = peers.map((p) => p.g);
  const beta = olsSlope(xs, ys);
  if (beta === null) {
    throw new Error("attribute requires non-zero Sxx across peers");
  }
  const theil_sen = theilSen(xs, ys);
  const weather = beta * target.dw;
  const industry = median(ys.map((y, i) => y - beta * xs[i]!));
  const remainder = target.g - weather - industry;

  const rng = mulberry32(seed);
  const n = peers.length;
  const bBetas: number[] = [];
  const bWeather: number[] = [];
  const bIndustry: number[] = [];
  let skipped = 0;

  for (let r = 0; r < resamples; r++) {
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      idx.push(Math.floor(rng() * n));
    }
    const rx = idx.map((i) => xs[i]!);
    const ry = idx.map((i) => ys[i]!);
    const b = olsSlope(rx, ry);
    if (b === null) {
      skipped += 1;
      continue;
    }
    bBetas.push(b);
    bWeather.push(b * target.dw);
    bIndustry.push(median(ry.map((y, i) => y - b * rx[i]!)));
  }

  if (bBetas.length === 0) {
    throw new Error("attribute: no valid bootstrap resamples");
  }

  const betaRange: Range = {
    lo: percentile(bBetas, 0.1),
    hi: percentile(bBetas, 0.9),
  };
  const weatherRange: Range = {
    lo: percentile(bWeather, 0.1),
    hi: percentile(bWeather, 0.9),
  };
  const industryRange: Range = {
    lo: percentile(bIndustry, 0.1),
    hi: percentile(bIndustry, 0.9),
  };
  const remainderRange: Range = {
    lo: target.g - weatherRange.hi - industryRange.hi,
    hi: target.g - weatherRange.lo - industryRange.lo,
  };

  const claim = claimVerdict(target.g, weather);
  const confidence = confidenceLabel(peers.length, target.coverage, betaRange);

  return {
    target,
    peers: peers.length,
    beta,
    theil_sen,
    weather,
    industry,
    remainder,
    ranges: {
      beta: betaRange,
      weather: weatherRange,
      industry: industryRange,
      remainder: remainderRange,
    },
    bootstrap: {
      resamples,
      valid: bBetas.length,
      skipped_zero_variance: skipped,
      seed,
    },
    coverage: target.coverage,
    confidence,
    claim,
  };
}
