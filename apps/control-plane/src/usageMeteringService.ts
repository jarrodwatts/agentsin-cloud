// @effect-diagnostics nodeBuiltinImport:off -- Stable SHA-256 fingerprints idempotent sampler requests.
import * as NodeCrypto from "node:crypto";

import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  VerifiedE2bUsageEvidence,
  type UsageAccrual,
  type UsageAccrualId,
  type UsageEvidenceId,
  type UsageSampleId,
  type WorkspaceId,
  type SandboxId,
} from "@t3tools/contracts/cloud";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  type AppendVerifiedUsageInput,
  type UsageLedgerRepository,
  UsageLedgerRepositoryError,
} from "./usageLedgerRepository.ts";

export class VerifiedE2bUsageSourceError extends Schema.TaggedErrorClass<VerifiedE2bUsageSourceError>()(
  "VerifiedE2bUsageSourceError",
  {
    code: Schema.Literals(["unavailable", "notFound", "unverified", "providerFailure"]),
    retryable: Schema.Boolean,
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {}

export interface VerifiedE2bUsageSourceRequest {
  readonly workspaceId: WorkspaceId;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly sandboxId: SandboxId;
  readonly evidenceId: UsageEvidenceId;
  readonly intervalStart: string;
  readonly intervalEnd: string;
}

export interface VerifiedE2bUsageSource {
  readonly read: (
    request: VerifiedE2bUsageSourceRequest,
  ) => Effect.Effect<VerifiedE2bUsageEvidence, VerifiedE2bUsageSourceError>;
}

export interface UsageMeteringRequest extends VerifiedE2bUsageSourceRequest {
  readonly idempotencyKey: string;
}

export interface UsageMeteringPrincipal {
  readonly service: "e2b-usage-sampler";
  readonly workspaceId: WorkspaceId;
}

export class UsageMeteringServiceError extends Schema.TaggedErrorClass<UsageMeteringServiceError>()(
  "UsageMeteringServiceError",
  {
    code: Schema.Literals([
      "forbidden",
      "invalidRequest",
      "idempotencyConflict",
      "unverifiedUsage",
      "invalidSequence",
      "staleSandbox",
      "unavailable",
      "databaseFailure",
    ]),
    operation: Schema.String,
    retryable: Schema.Boolean,
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {}

export interface UsageMeteringService {
  readonly accrue: (
    principal: UsageMeteringPrincipal,
    request: UsageMeteringRequest,
  ) => Effect.Effect<
    { readonly disposition: "created" | "duplicate"; readonly accrual: UsageAccrual },
    UsageMeteringServiceError
  >;
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
  throw new TypeError("unsupported usage request fingerprint value");
};

export const usageMeteringRequestFingerprint = (request: UsageMeteringRequest) =>
  NodeCrypto.createHash("sha256")
    .update("agents-in-cloud/usage-metering-request/v1\0")
    .update(canonical(request))
    .digest("hex");

const serviceError = (
  code: UsageMeteringServiceError["code"],
  operation: string,
  retryable: boolean,
  cause?: unknown,
) =>
  new UsageMeteringServiceError({
    code,
    operation,
    retryable,
    ...(cause === undefined ? {} : { cause }),
  });

const mapRepositoryError = (error: UsageLedgerRepositoryError) => {
  switch (error.code) {
    case "conflict":
      return serviceError("idempotencyConflict", error.operation, false, error);
    case "invalidEvidenceRevision":
    case "outOfOrder":
      return serviceError("invalidSequence", error.operation, false, error);
    case "staleSandbox":
      return serviceError("staleSandbox", error.operation, false, error);
    case "moneyOverflow":
      return serviceError("invalidRequest", error.operation, false, error);
    case "databaseFailure":
      return serviceError("databaseFailure", error.operation, error.retryable, error);
  }
};

const mapSourceError = (error: VerifiedE2bUsageSourceError) =>
  serviceError(
    error.code === "unavailable" || error.code === "providerFailure"
      ? "unavailable"
      : "unverifiedUsage",
    "read-verified-e2b-usage",
    error.retryable,
    error,
  );

const canonicalIso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const validIso = (value: string) => canonicalIso.test(value);
const decodeVerifiedEvidence = Schema.decodeUnknownSync(VerifiedE2bUsageEvidence);

export const makeUsageMeteringService = (options: {
  readonly repository: UsageLedgerRepository;
  readonly source: VerifiedE2bUsageSource;
  readonly now: () => string;
  readonly sampleId: (request: UsageMeteringRequest) => UsageSampleId;
  readonly accrualId: (request: UsageMeteringRequest) => UsageAccrualId;
}): UsageMeteringService => ({
  accrue: (principal, request) =>
    Effect.gen(function* () {
      if (
        principal.service !== "e2b-usage-sampler" ||
        principal.workspaceId !== request.workspaceId
      ) {
        return yield* serviceError("forbidden", "authorize-usage-sampler", false);
      }
      if (
        request.idempotencyKey.length === 0 ||
        request.idempotencyKey.length > 256 ||
        !validIso(request.intervalStart) ||
        !validIso(request.intervalEnd) ||
        request.intervalStart >= request.intervalEnd
      ) {
        return yield* serviceError("invalidRequest", "validate-usage-request", false);
      }

      const requestFingerprint = usageMeteringRequestFingerprint(request);
      const existing = yield* options.repository
        .getByIdempotencyKey(request.workspaceId, request.idempotencyKey)
        .pipe(Effect.mapError(mapRepositoryError));
      if (existing !== undefined) {
        if (existing.requestFingerprint !== requestFingerprint) {
          return yield* serviceError("idempotencyConflict", "replay-usage-request", false);
        }
        return { disposition: "duplicate" as const, accrual: existing.accrual };
      }

      const evidence = yield* options.source.read(request).pipe(Effect.mapError(mapSourceError));
      const verified = yield* Effect.try({
        try: () => decodeVerifiedEvidence(evidence),
        catch: (cause) =>
          serviceError("unverifiedUsage", "decode-verified-e2b-usage", false, cause),
      });
      if (
        verified.evidenceId !== request.evidenceId ||
        verified.intervalStart !== request.intervalStart ||
        verified.intervalEnd !== request.intervalEnd
      ) {
        return yield* serviceError("unverifiedUsage", "bind-verified-e2b-usage", false);
      }
      const recordedAt = options.now();
      if (!validIso(recordedAt) || recordedAt < verified.observedAt) {
        return yield* serviceError("invalidRequest", "validate-usage-recorded-at", false);
      }

      const append: AppendVerifiedUsageInput = {
        workspaceId: request.workspaceId,
        environmentId: request.environmentId,
        threadId: request.threadId,
        sandboxId: request.sandboxId,
        idempotencyKey: request.idempotencyKey,
        requestFingerprint,
        sampleId: options.sampleId(request),
        accrualId: options.accrualId(request),
        evidence: verified,
        recordedAt,
      };
      const stored = yield* options.repository
        .appendVerifiedUsage(append)
        .pipe(Effect.mapError(mapRepositoryError));
      return { disposition: stored.disposition, accrual: stored.accrual };
    }),
});

/** Production remains fail-closed until E2B exposes and operators configure an authoritative cost feed. */
export const unavailableVerifiedE2bUsageSource: VerifiedE2bUsageSource = {
  read: () =>
    Effect.fail(new VerifiedE2bUsageSourceError({ code: "unavailable", retryable: true })),
};
