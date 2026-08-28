import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { UsageAccrual, UsageAccrualSettlementInput, VerifiedE2bUsageEvidence } from "./cloud.ts";

const decodeEvidence = Schema.decodeUnknownSync(VerifiedE2bUsageEvidence);
const decodeAccrual = Schema.decodeUnknownSync(UsageAccrual);
const decodeSettlementInput = Schema.decodeUnknownSync(UsageAccrualSettlementInput);

const evidence = {
  evidenceId: "e2b-charge-1",
  revision: 1,
  infrastructureProvider: "e2b",
  verification: "e2b-authenticated-billing-record",
  payloadSha256: "a".repeat(64),
  intervalStart: "2026-08-28T00:00:00.000Z",
  intervalEnd: "2026-08-28T00:05:00.000Z",
  upstreamMicroUsdc: 1_010,
  observedAt: "2026-08-28T00:05:01.000Z",
} as const;

const accrual = {
  accrualId: "accrual-1",
  sampleId: "sample-1",
  workspaceId: "workspace-1",
  environmentId: "environment-1",
  threadId: "thread-1",
  sandboxId: "sandbox-1",
  evidence,
  pricingScope: { kind: "workspace", workspaceId: "workspace-1" },
  pricingVersion: 1,
  pricingSequence: 1,
  evidencePreviousUpstreamMicroUsdc: 0,
  evidenceUpstreamMicroUsdc: 1_010,
  markupBasisPoints: 500,
  markupRounding: "half-up-to-nearest-micro-usdc",
  upstreamDeltaMicroUsdc: 1_010,
  cumulativeUpstreamBeforeMicroUsdc: 0,
  cumulativeUpstreamAfterMicroUsdc: 1_010,
  cumulativeMarkupBeforeMicroUsdc: 0,
  cumulativeMarkupAfterMicroUsdc: 51,
  cumulativeTotalBeforeMicroUsdc: 0,
  cumulativeTotalAfterMicroUsdc: 1_061,
  markupDeltaMicroUsdc: 51,
  totalDeltaMicroUsdc: 1_061,
  payloadSha256: "b".repeat(64),
  recordedAt: "2026-08-28T00:05:02.000Z",
} as const;

describe("verified cloud usage contracts", () => {
  it("accepts exact E2B evidence and immutable 5% accrual input", () => {
    expect(decodeEvidence(evidence)).toEqual(evidence);
    expect(decodeAccrual(accrual).cumulativeTotalAfterMicroUsdc).toBe(1_061);
  });

  it("rejects monitoring estimates, malformed evidence, and invalid monetary arithmetic", () => {
    expect(() =>
      decodeEvidence({ ...evidence, verification: "locally-estimated-from-cpu" }),
    ).toThrow();
    expect(() => decodeEvidence({ ...evidence, intervalEnd: evidence.intervalStart })).toThrow();
    expect(() => decodeEvidence({ ...evidence, payloadSha256: "not-sha256" })).toThrow();
    expect(() => decodeAccrual({ ...accrual, cumulativeMarkupAfterMicroUsdc: 50 })).toThrow();
    expect(() => decodeAccrual({ ...accrual, totalDeltaMicroUsdc: 1_060 })).toThrow();
  });

  it("requires correction revisions to bind a prior sample and exact prior totals", () => {
    const correction = {
      ...accrual,
      accrualId: "accrual-2",
      sampleId: "sample-2",
      priorSampleId: "sample-1",
      evidence: {
        ...evidence,
        revision: 2,
        payloadSha256: "c".repeat(64),
        upstreamMicroUsdc: 1_000,
      },
      pricingSequence: 2,
      evidencePreviousUpstreamMicroUsdc: 1_010,
      evidenceUpstreamMicroUsdc: 1_000,
      upstreamDeltaMicroUsdc: -10,
      cumulativeUpstreamBeforeMicroUsdc: 1_010,
      cumulativeUpstreamAfterMicroUsdc: 1_000,
      cumulativeMarkupBeforeMicroUsdc: 51,
      cumulativeMarkupAfterMicroUsdc: 50,
      cumulativeTotalBeforeMicroUsdc: 1_061,
      cumulativeTotalAfterMicroUsdc: 1_050,
      markupDeltaMicroUsdc: -1,
      totalDeltaMicroUsdc: -11,
    } as const;
    expect(decodeAccrual(correction).totalDeltaMicroUsdc).toBe(-11);
    expect(() => decodeAccrual({ ...correction, priorSampleId: undefined })).toThrow();
    const settlementInput = {
      accrualId: correction.accrualId,
      workspaceId: correction.workspaceId,
      pricingScope: correction.pricingScope,
      pricingVersion: correction.pricingVersion,
      pricingSequence: correction.pricingSequence,
      receiptInputSha256: correction.payloadSha256,
      totalDeltaMicroUsdc: correction.totalDeltaMicroUsdc,
      walletLedgerAmountMicroUsdc: 11,
      direction: "credit",
    } as const;
    expect(() => decodeSettlementInput(settlementInput)).not.toThrow();
    expect(() =>
      decodeSettlementInput({ ...settlementInput, walletLedgerAmountMicroUsdc: 10 }),
    ).toThrow();
  });
});
