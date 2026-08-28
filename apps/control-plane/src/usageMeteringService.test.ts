import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  UsageAccrual,
  VerifiedE2bUsageEvidence,
  type UsageAccrualId,
  type UsageEvidenceId,
  type UsageSampleId,
  type WorkspaceId,
  type SandboxId,
} from "@t3tools/contracts/cloud";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import type { StoredUsageAccrual, UsageLedgerRepository } from "./usageLedgerRepository.ts";
import {
  makeUsageMeteringService,
  unavailableVerifiedE2bUsageSource,
  usageMeteringRequestFingerprint,
  type UsageMeteringRequest,
  type VerifiedE2bUsageSource,
} from "./usageMeteringService.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111" as WorkspaceId;
const environmentId = "environment-a" as EnvironmentId;
const threadId = "thread-a" as ThreadId;
const sandboxId = "sandbox-a" as SandboxId;
const request: UsageMeteringRequest = {
  workspaceId,
  environmentId,
  threadId,
  sandboxId,
  evidenceId: "evidence-a" as UsageEvidenceId,
  intervalStart: "2026-08-28T00:00:00.000Z",
  intervalEnd: "2026-08-28T00:05:00.000Z",
  idempotencyKey: "sample-once",
};
const evidence = Schema.decodeUnknownSync(VerifiedE2bUsageEvidence)({
  evidenceId: request.evidenceId,
  revision: 1,
  infrastructureProvider: "e2b",
  verification: "e2b-authenticated-billing-record",
  payloadSha256: "a".repeat(64),
  intervalStart: request.intervalStart,
  intervalEnd: request.intervalEnd,
  upstreamMicroUsdc: 1_000,
  observedAt: "2026-08-28T00:05:01.000Z",
});

const accrual = Schema.decodeUnknownSync(UsageAccrual)({
  accrualId: "accrual-a",
  sampleId: "sample-a",
  workspaceId,
  environmentId,
  threadId,
  sandboxId,
  evidence,
  previousUpstreamMicroUsdc: 0,
  previousMarkupMicroUsdc: 0,
  previousTotalMicroUsdc: 0,
  upstreamMicroUsdc: 1_000,
  markupBasisPoints: 500,
  markupRounding: "half-up-to-nearest-micro-usdc",
  markupMicroUsdc: 50,
  totalMicroUsdc: 1_050,
  upstreamDeltaMicroUsdc: 1_000,
  markupDeltaMicroUsdc: 50,
  totalDeltaMicroUsdc: 1_050,
  payloadSha256: "b".repeat(64),
  recordedAt: "2026-08-28T00:05:02.000Z",
});

const service = (repository: UsageLedgerRepository, source: VerifiedE2bUsageSource) =>
  makeUsageMeteringService({
    repository,
    source,
    now: () => "2026-08-28T00:05:02.000Z",
    sampleId: () => "sample-a" as UsageSampleId,
    accrualId: () => "accrual-a" as UsageAccrualId,
  });

it.effect("fails closed when no authenticated E2B billing source is configured", () => {
  const repository: UsageLedgerRepository = {
    getByIdempotencyKey: () => Effect.sync((): StoredUsageAccrual | undefined => undefined),
    appendVerifiedUsage: () => Effect.die("must not append unverifiable usage"),
  };
  return Effect.gen(function* () {
    const result = yield* Effect.exit(
      service(repository, unavailableVerifiedE2bUsageSource).accrue(
        { service: "e2b-usage-sampler", workspaceId },
        request,
      ),
    );
    expect(Exit.isFailure(result)).toBe(true);
  });
});

it.effect("rejects source identity or interval substitution before persistence", () => {
  const repository: UsageLedgerRepository = {
    getByIdempotencyKey: () => Effect.sync((): StoredUsageAccrual | undefined => undefined),
    appendVerifiedUsage: () => Effect.die("must not append mismatched usage"),
  };
  const source: VerifiedE2bUsageSource = {
    read: () =>
      Effect.succeed({
        ...evidence,
        evidenceId: "different-evidence" as UsageEvidenceId,
      }),
  };
  return Effect.gen(function* () {
    const result = yield* Effect.exit(
      service(repository, source).accrue({ service: "e2b-usage-sampler", workspaceId }, request),
    );
    expect(Exit.isFailure(result)).toBe(true);
  });
});

it.effect("returns an idempotent result without reading E2B again", () => {
  let reads = 0;
  const repository: UsageLedgerRepository = {
    getByIdempotencyKey: () =>
      Effect.succeed({
        disposition: "duplicate",
        requestFingerprint: usageMeteringRequestFingerprint(request),
        accrual,
      }),
    appendVerifiedUsage: () => Effect.die("duplicate must not append"),
  };
  const source: VerifiedE2bUsageSource = {
    read: () => {
      reads += 1;
      return Effect.succeed(evidence);
    },
  };
  return Effect.gen(function* () {
    const result = yield* service(repository, source).accrue(
      { service: "e2b-usage-sampler", workspaceId },
      request,
    );
    expect(result).toEqual({ disposition: "duplicate", accrual });
    expect(reads).toBe(0);
  });
});
