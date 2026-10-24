import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  analystApproval,
  canonicalJson,
  ContractVerifier,
  issueContract,
  loadContractSecret,
  OVERRIDE_RECAST_PARAMS,
  overrideRecastParamErrors,
  overrideRecastParams,
  POLICY_PACK_VERSION,
  RECAST_SIDES,
  REGISTRAR_ACTIONS,
  riskOf,
  signatureFor,
  signContract,
  SURFACES,
  verifyContract,
  type ExecutionContract,
  type UnsignedContract,
} from "../src/contract/scout.ts";
import { VECTOR, VECTOR_ACTION, VECTOR_PARAMS, VECTOR_SECRET, VECTOR_SIGNATURE } from "./fixtures/contract-vector.ts";

// Test secret only; the real one lives in .env.local.
const SECRET = VECTOR_SECRET;
const T0 = new Date("2026-10-25T10:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

describe("canonical JSON", () => {
  it("sorts keys at every level and drops undefined members", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, "x"], c: null }, u: undefined })).toBe('{"a":{"c":null,"d":[1,"x"]},"b":1}');
  });
  it("escapes like JSON.stringify and keeps non-ASCII as is", () => {
    expect(canonicalJson({ s: 'é"\\\n\u0001' })).toBe('{"s":"é\\"\\\\\\n\\u0001"}');
  });
  it("refuses floats, lone surrogates and non-ASCII keys", () => {
    expect(() => canonicalJson({ x: 1.5 })).toThrow(/integers/);
    expect(() => canonicalJson({ x: "\uD800" })).toThrow(/surrogate/);
    expect(() => canonicalJson({ "é": 1 })).toThrow(/ASCII/);
  });
  it("matches the shared test vector of gateway/tests/test_contracts.py", () => {
    expect(signatureFor(VECTOR, SECRET)).toBe(VECTOR_SIGNATURE);
  });
});

describe("policy", () => {
  it("names the Weather-or-Not policy pack, surfaces and risk classes", () => {
    expect(POLICY_PACK_VERSION).toBe("weather-or-not-scout-subset@1");
    expect([...SURFACES]).toEqual(["won-ui", "won-agent"]);
    expect([...REGISTRAR_ACTIONS]).toEqual(["register_frames", "register_concept", "register_submission"]);
    for (const a of REGISTRAR_ACTIONS) expect(riskOf(a)).toBe("medium");
    expect(riskOf("read")).toBe("low");
    expect(riskOf("override_recast")).toBe("high");
    expect(riskOf("register_off")).toBeNull();
  });
});

const PARAMS = { ...VECTOR_PARAMS };
const expectFrames = { action: VECTOR_ACTION, params: PARAMS };

function frames(now = T0, params: Record<string, string> = PARAMS): ExecutionContract {
  return issueContract({ action: "register_frames", parameters: params, user: "won-agent", surface: "won-agent", now }, SECRET);
}

const OVERRIDE_PARAMS = { conflict_id: "rc-0123456789ab", chosen: "own_filing", reason: "The original filing is the like-for-like base for this period." };
const expectOverride = { action: "override_recast" as const, params: OVERRIDE_PARAMS };

function override(now = T0, reason = "The original filing is the like-for-like base for this period."): ExecutionContract {
  return issueContract(
    { action: "override_recast", parameters: OVERRIDE_PARAMS, user: "analyst", surface: "won-ui", approvals: [analystApproval(reason, now)], now },
    SECRET,
  );
}

describe("issue and verify", () => {
  it("accepts a medium-risk registrar contract from the agent surface", () => {
    const c = frames();
    expect(c.risk.level).toBe("medium");
    expect(c.toolPlan).toEqual([{ tool: "registrar.register_frames", input: PARAMS }]);
    expect(c.scope.capabilities).toEqual(["register_frames"]);
    expect(verifyContract(c, expectFrames, SECRET, at(5000)).ok).toBe(true);
  });

  it("accepts an analyst-approved high-risk override on the UI surface", () => {
    const c = override();
    expect(c.toolPlan).toEqual([{ tool: "agent.override_recast", input: OVERRIDE_PARAMS }]);
    expect(verifyContract(c, expectOverride, SECRET, at(60_000)).ok).toBe(true);
    expect(overrideRecastParams(c)).toEqual({ conflict_id: "rc-0123456789ab", chosen: "own_filing", reason: OVERRIDE_PARAMS.reason });
  });

  it("override_recast takes conflict_id, chosen (own_filing | later_filing) and reason, and nothing else (D4)", () => {
    expect([...OVERRIDE_RECAST_PARAMS]).toEqual(["conflict_id", "chosen", "reason"]);
    expect([...RECAST_SIDES]).toEqual(["own_filing", "later_filing"]);
    expect(overrideRecastParamErrors(OVERRIDE_PARAMS)).toEqual([]);
    expect(overrideRecastParamErrors({ ...OVERRIDE_PARAMS, chosen: "later_filing" })).toEqual([]);
    expect(overrideRecastParamErrors({ ...OVERRIDE_PARAMS, chosen: "neither" })).toEqual(["chosen must be one of own_filing | later_filing"]);
    expect(overrideRecastParamErrors({ ...OVERRIDE_PARAMS, conflict_id: "mem-62" })).toEqual(["conflict_id is not a recast conflict id (rc-<12 hex>)"]);
    expect(overrideRecastParamErrors({ ...OVERRIDE_PARAMS, reason: "   " })).toEqual(["reason is empty"]);
    expect(overrideRecastParamErrors({ conflict_id: "rc-0123456789ab", chosen: "own_filing" })).toEqual(["reason missing"]);
    expect(overrideRecastParamErrors({ ...OVERRIDE_PARAMS, cik: "0001326160" })).toEqual(["unexpected parameter cik"]);
    // Issuing refuses bad parameters; a signed contract with bad parameters is refused on verification.
    expect(() => issueContract({ action: "override_recast", parameters: { cik: "0001326160", period: "CY2025Q1" }, user: "analyst", surface: "won-ui", approvals: [analystApproval("ok", T0)], now: T0 }, SECRET)).toThrow(/conflict_id missing/);
    expect(() => issueContract({ action: "override_recast", parameters: { ...OVERRIDE_PARAMS, chosen: "both" }, user: "analyst", surface: "won-ui", approvals: [analystApproval("ok", T0)], now: T0 }, SECRET)).toThrow(/chosen must be one of/);
    const c = override();
    const bad = signContract({ ...c, intent: { ...c.intent, parameters: { ...OVERRIDE_PARAMS, chosen: "both" } } } as UnsignedContract, SECRET);
    expect(verifyContract(bad, { action: "override_recast", params: {} }, SECRET, at(1000))).toMatchObject({ ok: false, code: "parameter_mismatch" });
    expect(() => overrideRecastParams(bad)).toThrow(/chosen must be one of/);
    // The registrar vector is untouched by the override parameters.
    expect(signatureFor(VECTOR, SECRET)).toBe(VECTOR_SIGNATURE);
  });

  it("never issues a high-risk contract without an analyst approval with a reason, or off the UI surface", () => {
    expect(() => issueContract({ action: "override_recast", parameters: OVERRIDE_PARAMS, user: "x", surface: "won-ui", now: T0 }, SECRET)).toThrow(/analyst approval/);
    expect(() => override(T0, "  ")).toThrow(/analyst approval/);
    expect(() =>
      issueContract(
        { action: "override_recast", parameters: OVERRIDE_PARAMS, user: "agent", surface: "won-agent", approvals: [analystApproval("ok", T0)], now: T0 },
        SECRET,
      ),
    ).toThrow(/analyst UI/);
  });

  it("takes the risk level from the action, never from the caller", () => {
    const c = issueContract({ action: "read", parameters: { cik10: "0001326160" }, user: "agent", surface: "won-agent", now: T0 }, SECRET);
    expect(c.risk.level).toBe("low");
    const forged = signContract({ ...c, intent: { ...c.intent, primary: "override_recast" } } as UnsignedContract, SECRET);
    expect(verifyContract(forged, { action: "override_recast", params: {} }, SECRET, at(1000))).toMatchObject({ ok: false, code: "risk_mismatch" });
  });

  it("refuses a mutated contract, a wrong secret, an expired or early one, and a long TTL", () => {
    const c = frames();
    const mutated = { ...c, intent: { ...c.intent, parameters: { ...c.intent.parameters, period: "CY2024Q1" } } };
    expect(verifyContract(mutated, { ...expectFrames, params: { ...PARAMS, period: "CY2024Q1" } }, SECRET, at(1000))).toMatchObject({ ok: false, code: "bad_signature" });
    expect(verifyContract(c, expectFrames, `${SECRET}x`, at(1000))).toMatchObject({ ok: false, code: "bad_signature" });
    expect(verifyContract(c, expectFrames, SECRET, at(15 * 60_000))).toMatchObject({ ok: false, code: "expired" });
    expect(verifyContract(c, expectFrames, SECRET, at(-5 * 60_000))).toMatchObject({ ok: false, code: "not_yet_valid" });
    const long = signContract({ ...c, expiresAt: at(16 * 60_000).toISOString() } as UnsignedContract, SECRET);
    expect(verifyContract(long, expectFrames, SECRET, at(1000))).toMatchObject({ ok: false, code: "ttl_too_long" });
  });

  it("refuses another signer, another policy pack and another surface", () => {
    const c = frames();
    const signer = signContract({ ...c, signedBy: "someone" } as unknown as UnsignedContract, SECRET);
    expect(verifyContract(signer, expectFrames, SECRET, at(1000))).toMatchObject({ ok: false, code: "wrong_signer" });
    const pack = signContract({ ...c, policyPackVersion: "clearshelf-scout-subset@1" } as UnsignedContract, SECRET);
    expect(verifyContract(pack, expectFrames, SECRET, at(1000))).toMatchObject({ ok: false, code: "wrong_policy_pack" });
    const surface = signContract({ ...c, scope: { ...c.scope, surface: "clearshelf-agent" } } as unknown as UnsignedContract, SECRET);
    expect(verifyContract(surface, expectFrames, SECRET, at(1000))).toMatchObject({ ok: false, code: "out_of_scope" });
  });

  it("refuses a contract for another action, unknown action, other parameters or a missing capability", () => {
    const c = frames();
    expect(verifyContract(c, { action: "register_concept", params: {} }, SECRET, at(1000))).toMatchObject({ ok: false, code: "wrong_action" });
    expect(verifyContract(c, { action: "register_off" as never, params: {} }, SECRET, at(1000))).toMatchObject({ ok: false, code: "wrong_action" });
    expect(verifyContract(c, { ...expectFrames, params: { ...PARAMS, period: "CY2024Q1" } }, SECRET, at(1000))).toMatchObject({ ok: false, code: "parameter_mismatch" });
    const noCap = signContract({ ...c, scope: { ...c.scope, capabilities: ["read"] } } as UnsignedContract, SECRET);
    expect(verifyContract(noCap, expectFrames, SECRET, at(1000))).toMatchObject({ ok: false, code: "out_of_scope" });
  });

  it("refuses a high-risk contract whose approval was stripped, or that was moved to the agent surface, and re-signed", () => {
    const c = override();
    const stripped = signContract({ ...c, risk: { ...c.risk, approvals: [] } } as UnsignedContract, SECRET);
    expect(verifyContract(stripped, expectOverride, SECRET, at(1000))).toMatchObject({ ok: false, code: "approval_missing" });
    const moved = signContract({ ...c, scope: { ...c.scope, surface: "won-agent" } } as UnsignedContract, SECRET);
    expect(verifyContract(moved, expectOverride, SECRET, at(1000))).toMatchObject({ ok: false, code: "approval_missing" });
  });

  it("refuses missing and malformed contracts", () => {
    expect(verifyContract(undefined, expectFrames, SECRET, T0)).toMatchObject({ ok: false, code: "missing" });
    expect(verifyContract({ contractId: "x" }, expectFrames, SECRET, T0)).toMatchObject({ ok: false, code: "malformed" });
    expect(verifyContract("register_frames", expectFrames, SECRET, T0)).toMatchObject({ ok: false, code: "malformed" });
  });
});

describe("contract secret", () => {
  const saved = process.env.WON_CONTRACT_SECRET;
  afterEach(() => {
    if (saved === undefined) delete process.env.WON_CONTRACT_SECRET;
    else process.env.WON_CONTRACT_SECRET = saved;
  });

  it("reads WON_CONTRACT_SECRET from the environment and refuses a short one", () => {
    process.env.WON_CONTRACT_SECRET = SECRET;
    expect(loadContractSecret()).toBe(SECRET);
    process.env.WON_CONTRACT_SECRET = "short";
    expect(() => loadContractSecret()).toThrow(/32 characters/);
  });
});

describe("ContractVerifier", () => {
  it("logs every verdict, consumes contracts once and refuses a replay", () => {
    const dir = mkdtempSync(join(tmpdir(), "won-contract-"));
    const v = new ContractVerifier(SECRET, "test", dir, () => at(1000));
    const c = frames();
    expect(v.verify(c, expectFrames).ok).toBe(true);
    v.consume(c);
    expect(v.verify(c, expectFrames)).toMatchObject({ ok: false, code: "replayed" });
    expect(v.verify(null, { action: "register_submission", params: { cik10: "0001326160" } })).toMatchObject({ ok: false, code: "missing" });
    const log = readFileSync(join(dir, "verifier-test.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log.map((e) => [e.ok, e.code])).toEqual([
      [true, null],
      [false, "replayed"],
      [false, "missing"],
    ]);
    expect(readFileSync(join(dir, "verifier-test.jsonl"), "utf8")).not.toContain(SECRET);
    // A new verifier on the same directory still refuses the consumed contract.
    const v2 = new ContractVerifier(SECRET, "test", dir, () => at(2000));
    expect(v2.verify(c, expectFrames)).toMatchObject({ ok: false, code: "replayed" });
    expect(v2.isUsed(c.contractId)).toBe(true);
  });

  it("issues with its own secret and accepts what it issued", () => {
    const v = new ContractVerifier(SECRET, "test", null, () => T0);
    const c = v.issue({ action: "register_concept", parameters: { cik10: "0001326160", tag: "Revenues" }, user: "won-agent", surface: "won-agent" });
    expect(v.verify(c, { action: "register_concept", params: { cik10: "0001326160", tag: "Revenues" } }).ok).toBe(true);
  });
});
