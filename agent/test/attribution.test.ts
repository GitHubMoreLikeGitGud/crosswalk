import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  attribute,
  claimVerdict,
  confidenceLabel,
  median,
  mulberry32,
  olsSlope,
  peerSet,
  percentile,
  theilSen,
  type PeerPoint,
  type RevenueRow,
  type TargetPoint,
} from "../src/tools/attribution.ts";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/attribution.json", import.meta.url), "utf8"),
) as {
  prng_seed7_first5: number[];
  cases: {
    name: string;
    target: TargetPoint;
    peers: PeerPoint[];
    expected: {
      beta: number;
      theil_sen: number;
      weather: number;
      industry: number;
      remainder: number;
      bootstrap: {
        resamples: number;
        valid: number;
        skipped_zero_variance: number;
        beta: { lo: number; hi: number };
        weather: { lo: number; hi: number };
        industry: { lo: number; hi: number };
        remainder: { lo: number; hi: number };
      };
      hand?: {
        beta: number;
        theil_sen: number;
        weather: number;
        industry: number;
        remainder: number;
        claim_ratio: number;
        claim_verdict: string;
        confidence: string;
      };
      claim_ratio?: number;
      claim_verdict?: string;
      confidence?: string;
    };
  }[];
  peer_set: {
    target_cik: string;
    seed_ciks: string[];
    rows: RevenueRow[];
    expected_peers: { cik: string; g: number }[];
    expected_excluded: { cik: string; reason: string }[];
  };
  confidence_cases: {
    peers: number;
    coverage: number;
    beta_lo: number;
    beta_hi: number;
    expected: "high" | "medium" | "low";
  }[];
  claim_cases: {
    g: number;
    weather: number;
    expected: "supported" | "partly supported" | "not supported";
    ratio: number | null;
  }[];
};

describe("mulberry32", () => {
  it("seed 7 matches prng_seed7_first5 exactly", () => {
    const rng = mulberry32(7);
    for (const expected of fixture.prng_seed7_first5) {
      expect(rng()).toBe(expected);
    }
  });

  it("two generators from the same seed agree; seed 8 differs", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    const c = mulberry32(8);
    for (let i = 0; i < 5; i++) {
      const va = a();
      expect(b()).toBe(va);
      expect(c()).not.toBe(va);
    }
  });
});

describe("median and percentile", () => {
  it("median odd/even and empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(() => median([])).toThrow();
  });

  it("percentile type-7 at 0.1 and 0.9", () => {
    expect(percentile([1, 2, 3, 4, 5], 0.1)).toBe(1.4);
    expect(percentile([1, 2, 3, 4, 5], 0.9)).toBe(4.6);
  });
});

describe("olsSlope and theilSen", () => {
  it("three-peer hand case slopes are 0.75", () => {
    const xs = fixture.cases[0]!.peers.map((p) => p.dw);
    const ys = fixture.cases[0]!.peers.map((p) => p.g);
    expect(olsSlope(xs, ys)).toBeCloseTo(0.75, 12);
    expect(theilSen(xs, ys)).toBeCloseTo(0.75, 12);
  });

  it("returns null when Sxx is 0 / no distinct x", () => {
    expect(olsSlope([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(theilSen([1, 1, 1], [1, 2, 3])).toBeNull();
  });
});

describe("attribute", () => {
  it("matches cases[0] hand values, bootstrap and claim", () => {
    const c = fixture.cases[0]!;
    const result = attribute(c.target, c.peers);
    const hand = c.expected.hand!;
    expect(result.beta).toBeCloseTo(hand.beta, 12);
    expect(result.theil_sen).toBeCloseTo(hand.theil_sen, 12);
    expect(result.weather).toBeCloseTo(hand.weather, 12);
    expect(result.industry).toBeCloseTo(hand.industry, 12);
    expect(result.remainder).toBeCloseTo(hand.remainder, 12);

    const boot = c.expected.bootstrap;
    expect(result.ranges.beta.lo).toBeCloseTo(boot.beta.lo, 9);
    expect(result.ranges.beta.hi).toBeCloseTo(boot.beta.hi, 9);
    expect(result.ranges.weather.lo).toBeCloseTo(boot.weather.lo, 9);
    expect(result.ranges.weather.hi).toBeCloseTo(boot.weather.hi, 9);
    expect(result.ranges.industry.lo).toBeCloseTo(boot.industry.lo, 9);
    expect(result.ranges.industry.hi).toBeCloseTo(boot.industry.hi, 9);
    expect(result.ranges.remainder.lo).toBeCloseTo(boot.remainder.lo, 9);
    expect(result.ranges.remainder.hi).toBeCloseTo(boot.remainder.hi, 9);
    expect(result.bootstrap.valid).toBe(293);
    expect(result.bootstrap.skipped_zero_variance).toBe(7);
    expect(result.confidence).toBe("low");
    expect(result.claim.verdict).toBe("supported");
    expect(result.claim.ratio).toBeCloseTo(0.06 / 0.09, 12);
  });

  it("matches cases[1] point estimates, ranges and confidence", () => {
    const c = fixture.cases[1]!;
    const result = attribute(c.target, c.peers);
    const e = c.expected;
    expect(result.beta).toBeCloseTo(e.beta, 9);
    expect(result.theil_sen).toBeCloseTo(e.theil_sen, 9);
    expect(result.weather).toBeCloseTo(e.weather, 9);
    expect(result.industry).toBeCloseTo(e.industry, 9);
    expect(result.remainder).toBeCloseTo(e.remainder, 9);

    const boot = e.bootstrap;
    expect(result.ranges.beta.lo).toBeCloseTo(boot.beta.lo, 9);
    expect(result.ranges.beta.hi).toBeCloseTo(boot.beta.hi, 9);
    expect(result.ranges.weather.lo).toBeCloseTo(boot.weather.lo, 9);
    expect(result.ranges.weather.hi).toBeCloseTo(boot.weather.hi, 9);
    expect(result.ranges.industry.lo).toBeCloseTo(boot.industry.lo, 9);
    expect(result.ranges.industry.hi).toBeCloseTo(boot.industry.hi, 9);
    expect(result.ranges.remainder.lo).toBeCloseTo(boot.remainder.lo, 9);
    expect(result.ranges.remainder.hi).toBeCloseTo(boot.remainder.hi, 9);
    expect(result.bootstrap.valid).toBe(boot.valid);
    expect(result.bootstrap.skipped_zero_variance).toBe(boot.skipped_zero_variance);
    expect(result.confidence).toBe("high");
    expect(result.claim.verdict).toBe("supported");
  });

  it("is deterministic; seed 8 changes a range bound", () => {
    const c = fixture.cases[0]!;
    const a = attribute(c.target, c.peers);
    const b = attribute(c.target, c.peers);
    expect(a).toEqual(b);
    const other = attribute(c.target, c.peers, { seed: 8 });
    const changed =
      other.ranges.beta.lo !== a.ranges.beta.lo ||
      other.ranges.beta.hi !== a.ranges.beta.hi ||
      other.ranges.weather.lo !== a.ranges.weather.lo ||
      other.ranges.weather.hi !== a.ranges.weather.hi ||
      other.ranges.industry.lo !== a.ranges.industry.lo ||
      other.ranges.industry.hi !== a.ranges.industry.hi;
    expect(changed).toBe(true);
  });

  it("throws with one peer or zero-variance dw", () => {
    const target = fixture.cases[0]!.target;
    expect(() => attribute(target, [fixture.cases[0]!.peers[0]!])).toThrow();
    expect(() =>
      attribute(target, [
        { cik: "a", g: 0.1, dw: 0.5 },
        { cik: "b", g: 0.2, dw: 0.5 },
      ]),
    ).toThrow();
  });
});

describe("confidenceLabel and claimVerdict", () => {
  it("reproduces every confidence_cases entry", () => {
    for (const c of fixture.confidence_cases) {
      expect(
        confidenceLabel(c.peers, c.coverage, { lo: c.beta_lo, hi: c.beta_hi }),
      ).toBe(c.expected);
    }
  });

  it("reproduces every claim_cases entry", () => {
    for (const c of fixture.claim_cases) {
      const result = claimVerdict(c.g, c.weather);
      expect(result.verdict).toBe(c.expected);
      if (c.ratio === null) {
        expect(result.ratio).toBeNull();
      } else {
        expect(result.ratio).toBeCloseTo(c.ratio, 12);
      }
    }
  });
});

describe("peerSet", () => {
  it("matches expected_peers and expected_excluded", () => {
    const ps = fixture.peer_set;
    const { peers, excluded } = peerSet(ps.rows, ps.target_cik, ps.seed_ciks);
    expect(peers.length).toBe(ps.expected_peers.length);
    for (let i = 0; i < peers.length; i++) {
      expect(peers[i]!.cik).toBe(ps.expected_peers[i]!.cik);
      expect(peers[i]!.g).toBeCloseTo(ps.expected_peers[i]!.g, 12);
    }
    expect(excluded).toEqual(ps.expected_excluded);
  });
});
