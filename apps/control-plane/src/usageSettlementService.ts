// @effect-diagnostics nodeBuiltinImport:off -- Receipt SHA-256 is a public audit digest, never a wallet key.
import * as NodeCrypto from "node:crypto";

import type {
  EvmTransactionHash,
  SettlementId,
  UsageEvidenceSha256,
  UsageSettlementReceipt,
  UsageSettlementReceiptPayload,
  UsageSettlementReceiptSignature,
  WorkspaceId,
} from "@t3tools/contracts/cloud";
import { UsageSettlementReceipt as UsageSettlementReceiptSchema } from "@t3tools/contracts/cloud";
import type { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  type UsageSettlementAttempt,
  type UsageSettlementRepository,
  UsageSettlementRepositoryError,
} from "./usageSettlementRepository.ts";

export interface MonadSettlementRequest {
  readonly settlementId: SettlementId;
  readonly idempotencyKey: string;
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly walletId: UsageSettlementAttempt["walletId"];
  readonly authorizationId: UsageSettlementAttempt["authorizationId"];
  readonly fromAddress: UsageSettlementAttempt["walletAddress"];
  readonly treasuryAddress: UsageSettlementAttempt["treasuryAddress"];
  readonly amountMicroUsdc: number;
  readonly providerActivityRef?: string;
}

export type MonadSettlementObservation =
  | {
      readonly status: "applied";
      readonly providerActivityRef: string;
      readonly txHash: EvmTransactionHash;
      readonly submittedAt: string;
    }
  | {
      readonly status: "notApplied";
      readonly providerActivityRef?: string;
    }
  | {
      readonly status: "insufficientBalance";
      readonly providerActivityRef?: string;
    }
  | {
      readonly status: "unknown";
      readonly providerActivityRef: string;
    };

export class MonadSettlementPortError extends Schema.TaggedErrorClass<MonadSettlementPortError>()(
  "MonadSettlementPortError",
  {
    code: Schema.String,
    outcome: Schema.Literals(["notApplied", "uncertain"]),
    retryable: Schema.Boolean,
  },
) {}

/** Production adapts this port to WalletService/Turnkey. Its implementation must be idempotent. */
export interface MonadSettlementPort {
  readonly inspect: (
    request: MonadSettlementRequest,
  ) => Effect.Effect<MonadSettlementObservation, MonadSettlementPortError>;
  readonly submit: (
    request: MonadSettlementRequest,
  ) => Effect.Effect<MonadSettlementObservation, MonadSettlementPortError>;
}

export class SettlementReceiptSignerError extends Schema.TaggedErrorClass<SettlementReceiptSignerError>()(
  "SettlementReceiptSignerError",
  { code: Schema.String, retryable: Schema.Boolean },
) {}

export interface SettlementReceiptSigner {
  readonly sign: (request: {
    readonly settlementId: SettlementId;
    readonly payloadSha256: UsageEvidenceSha256;
    readonly signedAt: string;
  }) => Effect.Effect<UsageSettlementReceiptSignature, SettlementReceiptSignerError>;
}

export class SettlementRuntimeBoundaryError extends Schema.TaggedErrorClass<SettlementRuntimeBoundaryError>()(
  "SettlementRuntimeBoundaryError",
  { code: Schema.String, retryable: Schema.Boolean },
) {}

/** Must durably pause the current runtime; destroying its workspace is forbidden. */
export interface SettlementRuntimeBoundary {
  readonly pauseForInsufficientBalance: (request: {
    readonly requestId: string;
    readonly settlementId: SettlementId;
    readonly workspaceId: WorkspaceId;
    readonly threadId: ThreadId;
    readonly requestedAt: string;
  }) => Effect.Effect<{ readonly pausedAt: string }, SettlementRuntimeBoundaryError>;
}

export class UsageSettlementServiceError extends Schema.TaggedErrorClass<UsageSettlementServiceError>()(
  "UsageSettlementServiceError",
  {
    code: Schema.Literals([
      "invalidRequest",
      "databaseFailure",
      "providerUnavailable",
      "reconciliationRequired",
      "pauseRequired",
      "signingUnavailable",
    ]),
    operation: Schema.String,
    retryable: Schema.Boolean,
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {}

export interface UsageSettlementSweepResult {
  readonly claimed: number;
  readonly finalized: number;
  readonly pending: number;
  readonly reconciliationRequired: number;
  readonly lowBalancePaused: number;
}

export interface UsageSettlementService {
  readonly settleReady: (request?: {
    readonly trigger?: "sandbox-paused" | "sandbox-closed";
    readonly workspaceId?: WorkspaceId;
    readonly threadId?: ThreadId;
    readonly limit?: number;
  }) => Effect.Effect<UsageSettlementSweepResult, UsageSettlementServiceError>;
  readonly recoverPending: (
    limit?: number,
  ) => Effect.Effect<UsageSettlementSweepResult, UsageSettlementServiceError>;
  readonly retryLowBalance: (
    workspaceId: WorkspaceId,
    settlementId: SettlementId,
  ) => Effect.Effect<UsageSettlementAttempt, UsageSettlementServiceError>;
}

const canonical = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  throw new TypeError("unsupported settlement receipt value");
};

export const settlementReceiptPayloadSha256 = (
  payload: UsageSettlementReceiptPayload,
): UsageEvidenceSha256 =>
  NodeCrypto.createHash("sha256")
    .update("agents-in-cloud/usage-settlement-receipt/v1\0")
    .update(canonical(payload))
    .digest("hex") as UsageEvidenceSha256;

const decodeSettlementReceipt = Schema.decodeUnknownSync(UsageSettlementReceiptSchema);

const serviceError = (
  code: UsageSettlementServiceError["code"],
  operation: string,
  retryable: boolean,
  cause?: unknown,
) =>
  new UsageSettlementServiceError({
    code,
    operation,
    retryable,
    ...(cause === undefined ? {} : { cause }),
  });

const repositoryEffect = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      serviceError(
        "databaseFailure",
        operation,
        !(cause instanceof UsageSettlementRepositoryError) || cause.code === "databaseFailure",
        cause,
      ),
  });

const validIso = (value: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);

const payloadFor = (attempt: UsageSettlementAttempt): UsageSettlementReceiptPayload => {
  const first = attempt.postings[0]!;
  const last = attempt.postings[attempt.postings.length - 1]!;
  return {
    schemaVersion: 1,
    settlementId: attempt.settlementId,
    workspaceId: attempt.workspaceId,
    threadId: attempt.threadId,
    infrastructureProvider: "e2b",
    evidenceRange: {
      firstSampleId: first.sampleId,
      lastSampleId: last.sampleId,
      firstEvidenceId: first.evidenceId,
      firstEvidenceRevision: first.evidenceRevision,
      lastEvidenceId: last.evidenceId,
      lastEvidenceRevision: last.evidenceRevision,
      firstPricingSequence: first.pricingSequence,
      lastPricingSequence: last.pricingSequence,
      accrualCount: attempt.postings.length,
      intervalStart: attempt.postings.reduce(
        (minimum, posting) => (posting.intervalStart < minimum ? posting.intervalStart : minimum),
        first.intervalStart,
      ),
      intervalEnd: attempt.postings.reduce(
        (maximum, posting) => (posting.intervalEnd > maximum ? posting.intervalEnd : maximum),
        first.intervalEnd,
      ),
    },
    postings: attempt.postings,
    upstreamMicroUsdc: attempt.upstreamDeltaMicroUsdc,
    markupMicroUsdc: attempt.markupDeltaMicroUsdc,
    totalMicroUsdc: attempt.totalDeltaMicroUsdc,
    txHash: attempt.txHash!,
    createdAt: attempt.createdAt,
    submittedAt: attempt.transferSubmittedAt!,
  };
};

const receiptFor = (
  attempt: UsageSettlementAttempt,
  signature: UsageSettlementReceiptSignature,
): UsageSettlementReceipt => {
  const payload = payloadFor(attempt);
  const payloadSha256 = settlementReceiptPayloadSha256(payload);
  return decodeSettlementReceipt({
    payload,
    payloadSha256,
    signature,
  });
};

export const makeUsageSettlementService = (options: {
  readonly repository: UsageSettlementRepository;
  readonly settlement: MonadSettlementPort;
  readonly signer: SettlementReceiptSigner;
  readonly runtime: SettlementRuntimeBoundary;
  readonly processorId: string;
  readonly now: () => string;
  readonly leaseMs?: number;
}): UsageSettlementService => {
  const leaseMs = options.leaseMs ?? 60_000;
  const release = (attempt: UsageSettlementAttempt, failureCode: string) =>
    repositoryEffect("release-settlement-lease", () =>
      options.repository.releaseLease(attempt, options.processorId, failureCode, options.now()),
    );

  const pauseForLowBalance = (
    initial: UsageSettlementAttempt,
  ): Effect.Effect<UsageSettlementAttempt, UsageSettlementServiceError> =>
    Effect.gen(function* () {
      const pending =
        initial.state === "low-balance-pause-pending"
          ? initial
          : yield* repositoryEffect("mark-low-balance-pause-pending", () =>
              options.repository.markLowBalancePausePending(
                initial,
                options.processorId,
                "insufficient-balance",
                options.now(),
              ),
            );
      const paused = yield* options.runtime
        .pauseForInsufficientBalance({
          requestId: `low-balance:${pending.settlementId}`,
          settlementId: pending.settlementId,
          workspaceId: pending.workspaceId,
          threadId: pending.threadId,
          requestedAt: options.now(),
        })
        .pipe(
          Effect.mapError((cause) =>
            serviceError("pauseRequired", "pause-insufficient-balance", cause.retryable, cause),
          ),
          Effect.tapError(() => release(pending, "low-balance-pause-failed")),
        );
      return yield* repositoryEffect("mark-low-balance-paused", () =>
        options.repository.markLowBalancePaused(pending, options.processorId, paused.pausedAt),
      );
    });

  const finalize = (
    attempt: UsageSettlementAttempt,
  ): Effect.Effect<UsageSettlementAttempt, UsageSettlementServiceError> =>
    Effect.gen(function* () {
      if (attempt.txHash === undefined || attempt.transferSubmittedAt === undefined) {
        return yield* serviceError(
          "reconciliationRequired",
          "finalize-settlement-without-transfer",
          false,
        );
      }
      const unsignedPayload = payloadFor(attempt);
      const payloadSha256 = settlementReceiptPayloadSha256(unsignedPayload);
      const signedAt = options.now();
      const signature = yield* options.signer
        .sign({ settlementId: attempt.settlementId, payloadSha256, signedAt })
        .pipe(
          Effect.mapError((cause) =>
            serviceError("signingUnavailable", "sign-settlement-receipt", cause.retryable, cause),
          ),
          Effect.tapError(() => release(attempt, "receipt-signing-failed")),
        );
      if (signature.payloadHash !== payloadSha256 || signature.signedAt !== signedAt) {
        yield* release(attempt, "receipt-signature-mismatch");
        return yield* serviceError(
          "signingUnavailable",
          "validate-settlement-receipt-signature",
          false,
        );
      }
      if (!validIso(signature.signedAt) || signature.signedAt < attempt.transferSubmittedAt) {
        yield* release(attempt, "receipt-signature-time-invalid");
        return yield* serviceError(
          "signingUnavailable",
          "validate-settlement-receipt-signature-time",
          false,
        );
      }
      const receipt = yield* Effect.try({
        try: () => receiptFor(attempt, signature),
        catch: (cause) =>
          serviceError("signingUnavailable", "validate-settlement-receipt", false, cause),
      }).pipe(Effect.tapError(() => release(attempt, "receipt-invalid")));
      return yield* repositoryEffect("finalize-settlement", () =>
        options.repository.finalize(attempt, options.processorId, receipt, options.now()),
      );
    });

  const requestFor = (attempt: UsageSettlementAttempt): MonadSettlementRequest => ({
    settlementId: attempt.settlementId,
    idempotencyKey: attempt.requestFingerprint,
    workspaceId: attempt.workspaceId,
    threadId: attempt.threadId,
    walletId: attempt.walletId,
    authorizationId: attempt.authorizationId,
    fromAddress: attempt.walletAddress,
    treasuryAddress: attempt.treasuryAddress,
    amountMicroUsdc: attempt.totalDeltaMicroUsdc,
    ...(attempt.providerActivityRef === undefined
      ? {}
      : { providerActivityRef: attempt.providerActivityRef }),
  });

  const observe = (
    attempt: UsageSettlementAttempt,
    observation: MonadSettlementObservation,
  ): Effect.Effect<UsageSettlementAttempt, UsageSettlementServiceError> => {
    switch (observation.status) {
      case "applied":
        if (
          !validIso(observation.submittedAt) ||
          observation.submittedAt < attempt.createdAt ||
          (attempt.providerActivityRef !== undefined &&
            attempt.providerActivityRef !== observation.providerActivityRef)
        ) {
          if (
            attempt.providerActivityRef !== undefined &&
            attempt.providerActivityRef !== observation.providerActivityRef
          ) {
            return repositoryEffect("mark-provider-activity-conflict", () =>
              options.repository.markReconciliationRequired(
                attempt,
                options.processorId,
                undefined,
                "provider-activity-identity-mismatch",
                options.now(),
              ),
            );
          }
          return repositoryEffect("mark-invalid-transfer-reconciliation", () =>
            options.repository.markReconciliationRequired(
              attempt,
              options.processorId,
              attempt.providerActivityRef === undefined
                ? observation.providerActivityRef
                : undefined,
              "provider-transfer-timestamp-invalid",
              options.now(),
            ),
          );
        }
        return repositoryEffect("record-settlement-transfer", () =>
          options.repository.recordTransfer(
            attempt,
            options.processorId,
            observation,
            options.now(),
          ),
        ).pipe(Effect.flatMap(finalize));
      case "insufficientBalance":
        if (
          attempt.providerActivityRef !== undefined &&
          observation.providerActivityRef !== attempt.providerActivityRef
        ) {
          return repositoryEffect("mark-balance-activity-conflict", () =>
            options.repository.markReconciliationRequired(
              attempt,
              options.processorId,
              undefined,
              "provider-activity-identity-mismatch",
              options.now(),
            ),
          );
        }
        return pauseForLowBalance(attempt);
      case "unknown":
        return repositoryEffect("mark-settlement-reconciliation", () =>
          options.repository.markReconciliationRequired(
            attempt,
            options.processorId,
            attempt.providerActivityRef === undefined ? observation.providerActivityRef : undefined,
            attempt.providerActivityRef === undefined ||
              attempt.providerActivityRef === observation.providerActivityRef
              ? "provider-outcome-unknown"
              : "provider-activity-identity-mismatch",
            options.now(),
          ),
        );
      case "notApplied":
        if (
          attempt.providerActivityRef !== undefined &&
          observation.providerActivityRef !== attempt.providerActivityRef
        ) {
          return repositoryEffect("mark-not-applied-activity-conflict", () =>
            options.repository.markReconciliationRequired(
              attempt,
              options.processorId,
              undefined,
              "provider-activity-identity-mismatch",
              options.now(),
            ),
          );
        }
        return options.settlement.submit(requestFor(attempt)).pipe(
          Effect.mapError((cause) =>
            serviceError(
              cause.outcome === "uncertain" ? "reconciliationRequired" : "providerUnavailable",
              "submit-settlement-transfer",
              cause.retryable,
              cause,
            ),
          ),
          Effect.catch((cause) =>
            cause.code === "reconciliationRequired"
              ? repositoryEffect("mark-submit-reconciliation", () =>
                  options.repository.markReconciliationRequired(
                    attempt,
                    options.processorId,
                    undefined,
                    "provider-submit-uncertain",
                    options.now(),
                  ),
                )
              : release(attempt, "provider-submit-not-applied").pipe(
                  Effect.andThen(Effect.fail(cause)),
                ),
          ),
          Effect.flatMap((submitted) =>
            "state" in submitted ? Effect.succeed(submitted) : observe(attempt, submitted),
          ),
        );
    }
  };

  const process = (
    initial: UsageSettlementAttempt,
  ): Effect.Effect<UsageSettlementAttempt, UsageSettlementServiceError> =>
    Effect.gen(function* () {
      if (initial.state === "finalized") return initial;
      if (initial.state === "low-balance-pause-pending") return yield* pauseForLowBalance(initial);
      if (initial.state === "transfer-applied") return yield* finalize(initial);
      const pending =
        initial.state === "reserved" || initial.state === "low-balance-paused"
          ? yield* repositoryEffect("mark-settlement-submission-pending", () =>
              options.repository.setSubmissionPending(initial, options.processorId, options.now()),
            )
          : initial;
      const inspected = yield* options.settlement.inspect(requestFor(pending)).pipe(
        Effect.mapError((cause) =>
          serviceError(
            cause.outcome === "uncertain" ? "reconciliationRequired" : "providerUnavailable",
            "inspect-settlement-transfer",
            cause.retryable,
            cause,
          ),
        ),
        Effect.catch((cause) =>
          cause.code === "reconciliationRequired"
            ? repositoryEffect("mark-inspection-reconciliation", () =>
                options.repository.markReconciliationRequired(
                  pending,
                  options.processorId,
                  undefined,
                  "provider-inspection-uncertain",
                  options.now(),
                ),
              )
            : release(pending, "provider-inspection-not-applied").pipe(
                Effect.andThen(Effect.fail(cause)),
              ),
        ),
      );
      return "state" in inspected ? inspected : yield* observe(pending, inspected);
    });

  const summarize = (
    attempts: ReadonlyArray<UsageSettlementAttempt>,
  ): UsageSettlementSweepResult => ({
    claimed: attempts.length,
    finalized: attempts.filter((attempt) => attempt.state === "finalized").length,
    pending: attempts.filter((attempt) =>
      ["reserved", "submission-pending", "transfer-applied", "low-balance-pause-pending"].includes(
        attempt.state,
      ),
    ).length,
    reconciliationRequired: attempts.filter(
      (attempt) => attempt.state === "reconciliation-required",
    ).length,
    lowBalancePaused: attempts.filter((attempt) => attempt.state === "low-balance-paused").length,
  });

  const processAll = (attempts: ReadonlyArray<UsageSettlementAttempt>) =>
    Effect.forEach(
      attempts,
      (attempt) =>
        Effect.result(process(attempt)).pipe(
          Effect.flatMap((result) =>
            Result.isSuccess(result)
              ? Effect.succeed(result.success)
              : repositoryEffect("reload-failed-settlement", () =>
                  options.repository.get(attempt.workspaceId, attempt.settlementId),
                ).pipe(
                  Effect.flatMap((stored) =>
                    stored === undefined ? Effect.fail(result.failure) : Effect.succeed(stored),
                  ),
                ),
          ),
        ),
      { concurrency: 4 },
    ).pipe(Effect.map(summarize));

  const leaseWindow = () => {
    const now = options.now();
    if (
      !validIso(now) ||
      options.processorId.trim().length === 0 ||
      options.processorId.length > 128 ||
      !Number.isSafeInteger(leaseMs) ||
      leaseMs <= 0
    ) {
      throw new TypeError("settlement clock, processor identity, or lease is invalid");
    }
    return {
      now,
      leaseExpiresAt: DateTime.formatIso(
        DateTime.add(DateTime.makeUnsafe(now), { milliseconds: leaseMs }),
      ),
    };
  };

  return {
    settleReady: (request = {}) =>
      Effect.gen(function* () {
        if (
          !Number.isSafeInteger(request.limit ?? 25) ||
          (request.limit ?? 25) < 1 ||
          (request.limit ?? 25) > 100 ||
          (request.trigger !== undefined &&
            (request.workspaceId === undefined || request.threadId === undefined))
        ) {
          return yield* serviceError("invalidRequest", "validate-settlement-sweep", false);
        }
        const { now, leaseExpiresAt } = yield* Effect.try({
          try: leaseWindow,
          catch: (cause) => serviceError("invalidRequest", "settlement-clock", false, cause),
        });
        const attempts = yield* repositoryEffect("claim-ready-settlements", () =>
          options.repository.claimReady({
            processorId: options.processorId,
            now,
            leaseExpiresAt,
            limit: request.limit ?? 25,
            ...(request.trigger === undefined ? {} : { trigger: request.trigger }),
            ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
            ...(request.threadId === undefined ? {} : { threadId: request.threadId }),
          }),
        );
        return yield* processAll(attempts);
      }),
    recoverPending: (limit = 25) =>
      Effect.gen(function* () {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
          return yield* serviceError("invalidRequest", "validate-settlement-recovery", false);
        }
        const { now, leaseExpiresAt } = yield* Effect.try({
          try: leaseWindow,
          catch: (cause) => serviceError("invalidRequest", "settlement-clock", false, cause),
        });
        const attempts = yield* repositoryEffect("claim-recoverable-settlements", () =>
          options.repository.claimRecoverable(options.processorId, now, leaseExpiresAt, limit),
        );
        return yield* processAll(attempts);
      }),
    retryLowBalance: (workspaceId, settlementId) =>
      Effect.gen(function* () {
        const { now, leaseExpiresAt } = yield* Effect.try({
          try: leaseWindow,
          catch: (cause) => serviceError("invalidRequest", "settlement-clock", false, cause),
        });
        const attempt = yield* repositoryEffect("claim-low-balance-settlement", () =>
          options.repository.claimLowBalance(
            workspaceId,
            settlementId,
            options.processorId,
            now,
            leaseExpiresAt,
          ),
        );
        return yield* process(attempt);
      }),
  };
};
