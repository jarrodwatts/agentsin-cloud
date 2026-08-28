import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { UsageAccrual, VerifiedE2bUsageEvidence } from "./cloud.ts";

const decodeEvidence = Schema.decodeUnknownSync(VerifiedE2bUsageEvidence);
const decodeAccrual = Schema.decodeUnknownSync(UsageAccrual);

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
  previousUpstreamMicroUsdc: 0,
  previousMarkupMicroUsdc: 0,
  previousTotalMicroUsdc: 0,
  upstreamMicroUsdc: 1_010,
  markupBasisPoints: 500,
  markupRounding: "half-up-to-nearest-micro-usdc",
  markupMicroUsdc: 51,
  totalMicroUsdc: 1_061,
  upstreamDeltaMicroUsdc: 1_010,
  markupDeltaMicroUsdc: 51,
  totalDeltaMicroUsdc: 1_061,
  payloadSha256: "b".repeat(64),
  recordedAt: "2026-08-28T00:05:02.000Z",
} as const;

describe("verified cloud usage contracts", () => {
  it("accepts exact E2B evidence and immutable 5% accrual input", () => {
    expect(decodeEvidence(evidence)).toEqual(evidence);
    expect(decodeAccrual(accrual).totalMicroUsdc).toBe(1_061);
  });

  it("rejects monitoring estimates, malformed evidence, and invalid monetary arithmetic", () => {
    expect(() =>
      decodeEvidence({ ...evidence, verification: "locally-estimated-from-cpu" }),
    ).toThrow();
    expect(() => decodeEvidence({ ...evidence, intervalEnd: evidence.intervalStart })).toThrow();
    expect(() => decodeEvidence({ ...evidence, payloadSha256: "not-sha256" })).toThrow();
    expect(() => decodeAccrual({ ...accrual, markupMicroUsdc: 50 })).toThrow();
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
      previousUpstreamMicroUsdc: 1_010,
      previousMarkupMicroUsdc: 51,
      previousTotalMicroUsdc: 1_061,
      upstreamMicroUsdc: 1_000,
      markupMicroUsdc: 50,
      totalMicroUsdc: 1_050,
      upstreamDeltaMicroUsdc: -10,
      markupDeltaMicroUsdc: -1,
      totalDeltaMicroUsdc: -11,
    } as const;
    expect(decodeAccrual(correction).totalDeltaMicroUsdc).toBe(-11);
    expect(() => decodeAccrual({ ...correction, priorSampleId: undefined })).toThrow();
  });
});
