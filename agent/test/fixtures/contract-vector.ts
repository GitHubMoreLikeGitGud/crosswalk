// Shared with gateway/tests/test_contracts.py: the same contract and test secret must give
// the same HMAC in TypeScript and Python. Synthetic values; the secret is a test secret only.
import { POLICY_PACK_VERSION, type UnsignedContract } from "../../src/contract/scout.ts";

export const VECTOR_SECRET = "test".repeat(10);
export const VECTOR_ACTION = "register_frames" as const;
export const VECTOR_PARAMS = { tag: "Revenues", period: "CY2025Q1" } as const;

export const VECTOR: UnsignedContract = {
  contractId: "c-vector-0001",
  traceId: "t-vector",
  intent: { primary: VECTOR_ACTION, parameters: { ...VECTOR_PARAMS, note: "Café \"quoted\" \\ tab\t line\n é ü \u{1F36B}" } },
  risk: { level: "medium", flags: ["vector"], approvals: [] },
  toolPlan: [{ tool: "registrar.register_frames", input: { ...VECTOR_PARAMS } }],
  scope: { user: "won-agent", surface: "won-agent", capabilities: [VECTOR_ACTION] },
  issuedAt: "2026-10-25T10:00:00.000Z",
  expiresAt: "2026-10-25T10:15:00.000Z",
  policyPackVersion: POLICY_PACK_VERSION,
  signedBy: "scout",
};

export const VECTOR_SIGNATURE = "d866632ded462eab3818c913692f3e81c7ca47d8f4da94e826977a791744faeb";
