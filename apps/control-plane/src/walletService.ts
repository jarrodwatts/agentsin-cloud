// @effect-diagnostics nodeBuiltinImport:off -- IDs and canonical request fingerprints use Node crypto.
import * as NodeCrypto from "node:crypto";

import type { AuthSessionId } from "@t3tools/contracts";
import type { EvmAddress, MicroUsdc, WorkspaceId } from "@t3tools/contracts/cloud";
import {
  MONAD_USDC_BINDING,
  type UserOwnedWallet,
  type WalletChargeReconciliationResult,
  type WalletConfigureDelegationRequest,
  type WalletDelegatedAuthorization,
  type WalletDelegatedChargeRequest,
  type WalletDelegatedSpendReservation,
  type WalletDirectDepositInstructions,
  type WalletId,
  type WalletOperationId,
  type WalletProvisionRequest,
  type WalletProvisionResult,
  type WalletRecoveryBeginRequest,
  type WalletRecoveryCompleteRequest,
  type WalletRecoveryMetadata,
  type WalletProviderEffectEvidence,
  type WalletRequestFingerprint,
  type WalletTransferResult,
  type WalletWithdrawalRequest,
} from "@t3tools/contracts/wallet";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  type WalletCustodyAdapter,
  WalletCustodyError,
  type WalletOwnerAuthorization,
  type WalletProvisioningMaterial,
  type WalletRecoveryCompletionMaterial,
  type WalletRecoveryInitiationMaterial,
} from "./walletCustodyAdapter.ts";
import {
  type WalletAuditActor,
  type WalletDelegationConfigurationEvidence,
  type WalletOperationKind,
  type WalletOperationRecord,
  type WalletRepository,
  type WalletRepositoryError,
} from "./walletRepository.ts";

export interface WalletPrincipal {
  readonly workspaceId: WorkspaceId;
  readonly userId: string;
  readonly authSessionId: AuthSessionId;
}

/**
 * Control-plane identity for automated infrastructure settlement. The caller
 * is authorized by the composition root; this value is never accepted from a
 * sandbox worker or public request body.
 */
export interface WalletSettlementPrincipal {
  readonly service: "billing-settlement";
  readonly workspaceId: WorkspaceId;
}

export interface WalletService {
  readonly provision: (
    principal: WalletPrincipal,
    request: WalletProvisionRequest,
    material: WalletProvisioningMaterial,
  ) => Effect.Effect<WalletProvisionResult, WalletServiceError>;
  readonly getWallet: (
    principal: WalletPrincipal,
    walletId: WalletId,
  ) => Effect.Effect<UserOwnedWallet, WalletServiceError>;
  readonly directDepositInstructions: (
    principal: WalletPrincipal,
    walletId: WalletId,
  ) => Effect.Effect<WalletDirectDepositInstructions, WalletServiceError>;
  readonly configureDelegation: (
    principal: WalletPrincipal,
    request: WalletConfigureDelegationRequest,
    ownerAuthorization: WalletOwnerAuthorization,
  ) => Effect.Effect<WalletDelegatedAuthorization, WalletServiceError>;
  readonly beginRecovery: (
    principal: WalletPrincipal,
    request: WalletRecoveryBeginRequest,
    material: WalletRecoveryInitiationMaterial,
  ) => Effect.Effect<WalletRecoveryMetadata, WalletServiceError>;
  readonly completeRecovery: (
    principal: WalletPrincipal,
    request: WalletRecoveryCompleteRequest,
    material: WalletRecoveryCompletionMaterial,
  ) => Effect.Effect<WalletRecoveryMetadata, WalletServiceError>;
  readonly withdraw: (
    principal: WalletPrincipal,
    request: WalletWithdrawalRequest,
    ownerAuthorization: WalletOwnerAuthorization,
  ) => Effect.Effect<WalletTransferResult, WalletServiceError>;
  readonly charge: (
    principal: WalletSettlementPrincipal,
    request: WalletDelegatedChargeRequest,
  ) => Effect.Effect<WalletTransferResult, WalletServiceError>;
  readonly reconcileCharge: (
    principal: WalletSettlementPrincipal,
    reservationId: WalletDelegatedSpendReservation["reservationId"],
  ) => Effect.Effect<WalletChargeReconciliationResult, WalletServiceError>;
}

export class WalletServiceError extends Schema.TaggedErrorClass<WalletServiceError>()(
  "WalletServiceError",
  {
    code: Schema.Literals([
      "forbidden",
      "notFound",
      "invalidRequest",
      "idempotencyConflict",
      "operationPending",
      "operationFailed",
      "authorizationExpired",
      "policyViolation",
      "dailyLimitExceeded",
      "providerUnavailable",
      "databaseFailure",
    ]),
    operation: Schema.String,
    retryable: Schema.Boolean,
  },
) {}

const isWalletServiceError = Schema.is(WalletServiceError);

export interface WalletServiceOptions {
  readonly repository: WalletRepository;
  readonly custody: WalletCustodyAdapter;
  readonly now?: () => string;
  readonly nextAuditEventId?: () => string;
  readonly walletIdForOperation?: (operationId: WalletOperationId) => WalletId;
  readonly requestClockSkewMs?: number;
  readonly authorizeSettlement: (
    principal: WalletSettlementPrincipal,
    target: { readonly workspaceId: WorkspaceId; readonly walletId?: WalletId },
  ) => Effect.Effect<void, WalletServiceError>;
}

const stablePart = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "string") return `s:${value.length}:${value}`;
  if (typeof value === "number") return `n:${value}`;
  if (typeof value === "boolean") return `b:${value ? 1 : 0}`;
  if (Array.isArray(value)) return `a:${value.map(stablePart).join("|")}`;
  if (typeof value === "object") {
    return `o:${Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${stablePart(key)}=${stablePart(child)}`)
      .join("|")}`;
  }
  throw new TypeError("unsupported wallet fingerprint value");
};

/** Canonical SHA-256 binding for idempotent, approval-bearing wallet requests. */
export const walletRequestFingerprint = (value: unknown): WalletRequestFingerprint =>
  NodeCrypto.createHash("sha256")
    .update("agents-in-cloud/wallet-request/v1\0")
    .update(stablePart(value))
    .digest("hex") as WalletRequestFingerprint;

const serviceError = (operation: string, code: WalletServiceError["code"], retryable = false) =>
  new WalletServiceError({ operation, code, retryable });

const isBefore = (left: string, right: string) => {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime < rightTime;
};

const mapRepositoryError = (operation: string, error: WalletRepositoryError) => {
  const code =
    error.code === "idempotencyConflict"
      ? "idempotencyConflict"
      : error.code === "operationPending"
        ? "operationPending"
        : error.code === "notFound"
          ? "notFound"
          : error.code === "dailyLimitExceeded"
            ? "dailyLimitExceeded"
            : error.code === "policyViolation" || error.code === "stateConflict"
              ? "policyViolation"
              : "databaseFailure";
  return serviceError(operation, code, error.retryable);
};

const mapCustodyError = (operation: string, error: WalletCustodyError) =>
  serviceError(
    operation,
    error.code === "policyRejected" || error.code === "authorizationRejected"
      ? "policyViolation"
      : "providerUnavailable",
    error.retryable,
  );

const operationFrom = (input: {
  readonly workspaceId: WorkspaceId;
  readonly operationId: WalletOperationId;
  readonly walletId: WalletId;
  readonly kind: WalletOperationKind;
  readonly idempotencyKey: WalletOperationRecord["idempotencyKey"];
  readonly requestFingerprint: WalletRequestFingerprint;
  readonly requestedAt: string;
  readonly amountMicroUsdc?: MicroUsdc;
  readonly destination?: EvmAddress;
}): WalletOperationRecord => ({
  ...input,
  state: "pending",
});

const delegatedSpendOperationId = (
  reservationId: WalletDelegatedSpendReservation["reservationId"],
) =>
  `spend_${NodeCrypto.createHash("sha256").update(reservationId).digest("hex").slice(0, 32)}` as WalletOperationId;

export const makeWalletService = (options: WalletServiceOptions): WalletService => {
  const now = options.now ?? (() => DateTime.formatIso(DateTime.nowUnsafe()));
  const nextAuditEventId = options.nextAuditEventId ?? NodeCrypto.randomUUID;
  const walletIdForOperation =
    options.walletIdForOperation ??
    ((operationId: WalletOperationId) =>
      `wallet_${NodeCrypto.createHash("sha256").update(operationId).digest("hex").slice(0, 32)}` as WalletId);
  const requestClockSkewMs = options.requestClockSkewMs ?? 5 * 60_000;
  if (
    !Number.isSafeInteger(requestClockSkewMs) ||
    requestClockSkewMs < 0 ||
    requestClockSkewMs > 15 * 60_000
  ) {
    throw new RangeError("wallet request clock skew must be between zero and fifteen minutes");
  }
  const actorFor = (principal: WalletPrincipal): WalletAuditActor => ({
    userId: principal.userId,
    authSessionId: principal.authSessionId,
  });
  const authorizePrincipal = (
    principal: WalletPrincipal,
    workspaceId: WorkspaceId,
    ownerUserId?: string,
  ) =>
    principal.workspaceId === workspaceId &&
    (ownerUserId === undefined || principal.userId === ownerUserId)
      ? Effect.void
      : Effect.fail(serviceError("authorize-wallet-principal", "forbidden"));
  const validateRequestedAt = (requestedAt: string) => {
    const requested = Date.parse(requestedAt);
    const current = Date.parse(now());
    return Number.isFinite(requested) && Math.abs(requested - current) <= requestClockSkewMs
      ? Effect.void
      : Effect.fail(serviceError("validate-wallet-request-time", "invalidRequest"));
  };
  const requireWallet = (workspaceId: WorkspaceId, walletId: WalletId) =>
    options.repository.getWallet(workspaceId, walletId).pipe(
      Effect.mapError((error) => mapRepositoryError("get-wallet", error)),
      Effect.flatMap((wallet) =>
        wallet === undefined
          ? Effect.fail(serviceError("get-wallet", "notFound"))
          : Effect.succeed(wallet),
      ),
    );
  const failNotApplied = (
    operation: WalletOperationRecord,
    custodyError: WalletCustodyError,
  ): Effect.Effect<never, WalletServiceError> => {
    const mapped = mapCustodyError(operation.kind, custodyError);
    if (custodyError.outcome === "uncertain") {
      return Effect.fail(serviceError(operation.kind, "operationPending", true));
    }
    return options.repository
      .failOperation({
        workspaceId: operation.workspaceId,
        operationId: operation.operationId,
        walletId: operation.walletId,
        errorCode: custodyError.code,
        failedAt: now(),
        auditEventId: nextAuditEventId(),
      })
      .pipe(Effect.ignore, Effect.andThen(Effect.fail(mapped)));
  };
  const reserve = (operation: WalletOperationRecord) =>
    options.repository
      .reserveOperation(operation)
      .pipe(Effect.mapError((error) => mapRepositoryError(operation.kind, error)));
  const duplicateOperation = <A>(
    operation: WalletOperationRecord,
    load: () => Effect.Effect<A | undefined, WalletServiceError>,
  ) =>
    operation.state === "pending"
      ? Effect.fail(serviceError(operation.kind, "operationPending", true))
      : operation.state === "failed"
        ? Effect.fail(serviceError(operation.kind, "operationFailed"))
        : load().pipe(
            Effect.flatMap((result) =>
              result === undefined
                ? Effect.fail(serviceError(operation.kind, "databaseFailure", true))
                : Effect.succeed(result),
            ),
          );
  const custodyEvidenceFromError = (
    error: WalletCustodyError,
  ): WalletProviderEffectEvidence | undefined =>
    error.providerActivityRef === undefined ||
    error.providerStatus === undefined ||
    error.observedAt === undefined
      ? undefined
      : {
          providerActivityRef: error.providerActivityRef,
          status: error.providerStatus,
          observedAt: error.observedAt,
          ...(error.txHash === undefined ? {} : { txHash: error.txHash }),
        };
  const delegationEvidenceFromError = (
    error: WalletCustodyError,
  ): WalletDelegationConfigurationEvidence | undefined =>
    error.providerStatus === undefined || error.observedAt === undefined
      ? undefined
      : {
          status: error.providerStatus,
          observedAt: error.observedAt,
          ...(error.providerActivityRef === undefined
            ? {}
            : { providerActivityRef: error.providerActivityRef }),
          ...(error.providerPolicyRef === undefined
            ? {}
            : { providerPolicyRef: error.providerPolicyRef }),
          ...(error.providerDelegatedUserRef === undefined
            ? {}
            : { providerDelegatedUserRef: error.providerDelegatedUserRef }),
          ...(error.providerDelegatedCredentialRef === undefined
            ? {}
            : { providerDelegatedCredentialRef: error.providerDelegatedCredentialRef }),
        };
  const revokeAuthorization = (
    operation: WalletOperationRecord,
    wallet: UserOwnedWallet,
    authorization: WalletDelegatedAuthorization,
  ): Effect.Effect<void, WalletServiceError> =>
    Effect.gen(function* () {
      const existing = yield* options.repository
        .getDelegationRevocation(wallet.workspaceId, wallet.walletId, authorization.authorizationId)
        .pipe(Effect.mapError((error) => mapRepositoryError(operation.kind, error)));
      if (existing?.providerStatus === "applied") return;
      const status = yield* (
        existing?.providerStatus === "stillUnknown"
          ? options.custody.getDelegationRevocationStatus({
              wallet,
              authorization,
              providerActivityRef: existing.providerActivityRef,
              observedAt: now(),
            })
          : options.custody.revokeDelegatedAuthorization({
              operationId: operation.operationId,
              wallet,
              authorization,
              requestedAt: operation.requestedAt,
            })
      ).pipe(
        Effect.catch((error) => {
          const evidence = custodyEvidenceFromError(error);
          if (evidence === undefined) return failNotApplied(operation, error);
          return options.repository
            .recordDelegationRevocation({
              operation,
              authorization,
              providerActivityRef: evidence.providerActivityRef,
              providerStatus: evidence.status,
              requestedAt: operation.requestedAt,
              observedAt: evidence.observedAt,
              auditEventId: nextAuditEventId(),
            })
            .pipe(
              Effect.mapError((repositoryError) =>
                mapRepositoryError(operation.kind, repositoryError),
              ),
              Effect.andThen(Effect.fail(serviceError(operation.kind, "operationPending", true))),
            );
        }),
      );
      const recorded = yield* options.repository
        .recordDelegationRevocation({
          operation,
          authorization,
          providerActivityRef: status.providerActivityRef,
          providerStatus: status.status,
          requestedAt: operation.requestedAt,
          observedAt: status.observedAt,
          auditEventId: nextAuditEventId(),
        })
        .pipe(Effect.mapError((error) => mapRepositoryError(operation.kind, error)));
      if (recorded.providerStatus !== "applied") {
        return yield* serviceError(operation.kind, "operationPending", true);
      }
    });
  const validateFingerprint = (actual: WalletRequestFingerprint, input: unknown) =>
    actual === walletRequestFingerprint(input)
      ? Effect.void
      : Effect.fail(serviceError("validate-wallet-fingerprint", "invalidRequest"));

  return {
    provision: (principal, request, material) =>
      Effect.gen(function* () {
        yield* authorizePrincipal(principal, request.workspaceId, request.ownerUserId);
        yield* validateRequestedAt(request.requestedAt);
        yield* validateFingerprint(request.requestFingerprint, {
          schemaVersion: request.schemaVersion,
          operationId: request.operationId,
          idempotencyKey: request.idempotencyKey,
          workspaceId: request.workspaceId,
          ownerUserId: request.ownerUserId,
          requestedAt: request.requestedAt,
        });
        const walletId = walletIdForOperation(request.operationId);
        const operation = operationFrom({
          workspaceId: request.workspaceId,
          operationId: request.operationId,
          walletId,
          kind: "provision",
          idempotencyKey: request.idempotencyKey,
          requestFingerprint: request.requestFingerprint,
          requestedAt: request.requestedAt,
        });
        yield* options.custody.validateConfiguration.pipe(
          Effect.mapError((error) => mapCustodyError("provision", error)),
        );
        const reservation = yield* options.repository
          .reserveProvision({ operation, ownerUserId: request.ownerUserId })
          .pipe(Effect.mapError((error) => mapRepositoryError("provision", error)));
        if (reservation.wallet !== undefined) {
          return {
            wallet: reservation.wallet,
            deposit: {
              walletId: reservation.wallet.walletId,
              address: reservation.wallet.address,
              binding: MONAD_USDC_BINDING,
            },
            disposition: "duplicate" as const,
          };
        }
        if (reservation.operation === undefined) {
          return yield* serviceError("provision", "databaseFailure", true);
        }
        const reservedOperation = reservation.operation;
        if (reservation.disposition === "duplicate") {
          const wallet = yield* duplicateOperation(reservedOperation, () =>
            options.repository
              .getWallet(request.workspaceId, reservedOperation.walletId)
              .pipe(Effect.mapError((error) => mapRepositoryError("provision", error))),
          );
          return {
            wallet,
            deposit: { walletId, address: wallet.address, binding: MONAD_USDC_BINDING },
            disposition: "duplicate" as const,
          };
        }
        const provisioned = yield* options.custody
          .provision({
            operationId: request.operationId,
            workspaceId: request.workspaceId,
            ownerUserId: request.ownerUserId,
            material,
          })
          .pipe(Effect.catch((error) => failNotApplied(reservedOperation, error)));
        const completedAt = now();
        const wallet = yield* options.repository
          .completeProvision({
            operation: reservedOperation,
            wallet: {
              schemaVersion: 1,
              walletId,
              workspaceId: request.workspaceId,
              ownerUserId: request.ownerUserId,
              provider: "turnkey",
              providerOrganizationRef: provisioned.providerOrganizationRef,
              providerWalletRef: provisioned.providerWalletRef,
              address: provisioned.address,
              state: "active",
              recoveryMethod: "passkeyAndEmail",
              recoveryEnabled: true,
              createdAt: completedAt,
              updatedAt: completedAt,
            },
            providerActivityRef: provisioned.providerActivityRef,
            actor: actorFor(principal),
            auditEventId: nextAuditEventId(),
          })
          .pipe(Effect.mapError((error) => mapRepositoryError("provision", error)));
        return {
          wallet,
          deposit: { walletId, address: wallet.address, binding: MONAD_USDC_BINDING },
          disposition: "created" as const,
        };
      }),
    getWallet: (principal, walletId) =>
      Effect.gen(function* () {
        const wallet = yield* requireWallet(principal.workspaceId, walletId);
        yield* authorizePrincipal(principal, wallet.workspaceId, wallet.ownerUserId);
        return wallet;
      }),
    directDepositInstructions: (principal, walletId) =>
      Effect.gen(function* () {
        const wallet = yield* requireWallet(principal.workspaceId, walletId);
        yield* authorizePrincipal(principal, wallet.workspaceId, wallet.ownerUserId);
        return { walletId, address: wallet.address, binding: MONAD_USDC_BINDING };
      }),
    configureDelegation: (principal, request, ownerAuthorization) =>
      Effect.gen(function* () {
        yield* authorizePrincipal(principal, request.workspaceId);
        yield* validateRequestedAt(request.requestedAt);
        yield* validateFingerprint(request.requestFingerprint, {
          schemaVersion: request.schemaVersion,
          operationId: request.operationId,
          idempotencyKey: request.idempotencyKey,
          workspaceId: request.workspaceId,
          walletId: request.walletId,
          authorization: {
            authorizationId: request.authorization.authorizationId,
            treasuryAddress: request.authorization.treasuryAddress,
            perChargeLimitMicroUsdc: request.authorization.perChargeLimitMicroUsdc,
            dailyLimitMicroUsdc: request.authorization.dailyLimitMicroUsdc,
            startsAt: request.authorization.startsAt,
            expiresAt: request.authorization.expiresAt,
            policyRevision: request.authorization.policyRevision,
          },
          requestedAt: request.requestedAt,
        });
        const wallet = yield* requireWallet(request.workspaceId, request.walletId);
        yield* authorizePrincipal(principal, wallet.workspaceId, wallet.ownerUserId);
        if (
          (wallet.state !== "active" && wallet.state !== "frozen") ||
          request.authorization.state !== "pending" ||
          request.authorization.workspaceId !== request.workspaceId ||
          request.authorization.walletId !== request.walletId ||
          !isBefore(request.authorization.startsAt, request.authorization.expiresAt) ||
          !isBefore(now(), request.authorization.expiresAt)
        ) {
          return yield* serviceError("configure-delegation", "policyViolation");
        }
        const operation = operationFrom({
          workspaceId: request.workspaceId,
          operationId: request.operationId,
          walletId: request.walletId,
          kind: "delegationConfigure",
          idempotencyKey: request.idempotencyKey,
          requestFingerprint: request.requestFingerprint,
          requestedAt: request.requestedAt,
        });
        yield* options.custody.validateConfiguration.pipe(
          Effect.mapError((error) => mapCustodyError("configure-delegation", error)),
        );
        const reservation = yield* options.repository
          .reserveDelegationConfiguration({
            operation,
            authorization: request.authorization,
          })
          .pipe(Effect.mapError((error) => mapRepositoryError("configure-delegation", error)));
        if (reservation.authorization !== undefined) return reservation.authorization;
        if (reservation.operation === undefined || reservation.intent === undefined) {
          return yield* serviceError("configure-delegation", "databaseFailure", true);
        }
        const reservedOperation = reservation.operation;
        if (reservation.disposition === "duplicate" && reservedOperation.state !== "pending") {
          return yield* duplicateOperation(reservedOperation, () =>
            options.repository
              .getDelegatedAuthorization(
                request.workspaceId,
                request.walletId,
                request.authorization.authorizationId,
              )
              .pipe(Effect.mapError((error) => mapRepositoryError("configure-delegation", error))),
          );
        }
        let intent = reservation.intent;
        let shouldSubmitConfiguration = false;
        if (intent.state === "reserved") {
          const activeAuthorization = yield* options.repository
            .getActiveDelegatedAuthorization(request.workspaceId, request.walletId)
            .pipe(Effect.mapError((error) => mapRepositoryError("configure-delegation", error)));
          if (
            activeAuthorization !== undefined &&
            activeAuthorization.authorizationId !== request.authorization.authorizationId
          ) {
            yield* revokeAuthorization(reservedOperation, wallet, activeAuthorization);
          }
          intent = yield* options.repository
            .beginDelegationConfigurationAttempt({
              operation: reservedOperation,
              attemptedAt: now(),
            })
            .pipe(Effect.mapError((error) => mapRepositoryError("configure-delegation", error)));
          shouldSubmitConfiguration = true;
        }
        if (intent.state === "attempting") {
          const evidence = yield* shouldSubmitConfiguration
            ? options.custody
                .configureDelegatedAuthorization({
                  operationId: request.operationId,
                  wallet,
                  authorization: request.authorization,
                  ownerAuthorization,
                })
                .pipe(
                  Effect.map(
                    (configured): WalletDelegationConfigurationEvidence => ({
                      status: "applied",
                      observedAt: now(),
                      providerActivityRef: configured.providerActivityRef,
                      providerPolicyRef: configured.providerPolicyRef,
                      providerDelegatedUserRef: configured.providerDelegatedUserRef,
                      providerDelegatedCredentialRef: configured.providerDelegatedCredentialRef,
                    }),
                  ),
                  Effect.catch((error) => {
                    const observed = delegationEvidenceFromError(error);
                    return observed === undefined
                      ? failNotApplied(reservedOperation, error)
                      : Effect.succeed(observed);
                  }),
                )
            : options.custody
                .getDelegatedAuthorizationStatus({
                  operationId: request.operationId,
                  wallet,
                  authorization: request.authorization,
                  ...(intent.evidence?.providerActivityRef === undefined
                    ? {}
                    : { providerActivityRef: intent.evidence.providerActivityRef }),
                  observedAt: now(),
                })
                .pipe(
                  Effect.map((status): WalletDelegationConfigurationEvidence => status),
                  Effect.catch((error) => {
                    const observed = delegationEvidenceFromError(error);
                    return observed === undefined
                      ? Effect.fail(mapCustodyError("configure-delegation-status", error))
                      : Effect.succeed(observed);
                  }),
                );
          intent = yield* options.repository
            .recordDelegationConfigurationEvidence({
              operation: reservedOperation,
              evidence,
            })
            .pipe(Effect.mapError((error) => mapRepositoryError("configure-delegation", error)));
        }
        if (intent.evidence?.status === "notApplied") {
          return yield* failNotApplied(
            reservedOperation,
            new WalletCustodyError({
              code: "providerRejected",
              operation: "configure-delegation",
              retryable: false,
              outcome: "notApplied",
            }),
          );
        }
        if (intent.state !== "providerApplied" || intent.evidence?.status !== "applied") {
          return yield* serviceError("configure-delegation", "operationPending", true);
        }
        const evidence = intent.evidence;
        if (
          evidence.providerActivityRef === undefined ||
          evidence.providerPolicyRef === undefined ||
          evidence.providerDelegatedUserRef === undefined ||
          evidence.providerDelegatedCredentialRef === undefined
        ) {
          return yield* serviceError("configure-delegation", "databaseFailure", true);
        }
        const completedAt = now();
        return yield* options.repository
          .completeDelegation({
            operation: reservedOperation,
            authorization: request.authorization,
            provider: {
              policyRef: evidence.providerPolicyRef,
              delegatedUserRef: evidence.providerDelegatedUserRef,
              delegatedCredentialRef: evidence.providerDelegatedCredentialRef,
              activityRef: evidence.providerActivityRef,
            },
            actor: actorFor(principal),
            completedAt,
            auditEventId: nextAuditEventId(),
          })
          .pipe(Effect.mapError((error) => mapRepositoryError("configure-delegation", error)));
      }),
    beginRecovery: (principal, request, material) =>
      Effect.gen(function* () {
        yield* authorizePrincipal(principal, request.workspaceId);
        yield* validateRequestedAt(request.requestedAt);
        yield* validateFingerprint(request.requestFingerprint, {
          operationId: request.operationId,
          recoveryAttemptId: request.recoveryAttemptId,
          walletId: request.walletId,
          workspaceId: request.workspaceId,
          idempotencyKey: request.idempotencyKey,
          requestedAt: request.requestedAt,
        });
        const wallet = yield* requireWallet(request.workspaceId, request.walletId);
        yield* authorizePrincipal(principal, wallet.workspaceId, wallet.ownerUserId);
        const operation = operationFrom({
          workspaceId: request.workspaceId,
          operationId: request.operationId,
          walletId: request.walletId,
          kind: "recoveryBegin",
          idempotencyKey: request.idempotencyKey,
          requestFingerprint: request.requestFingerprint,
          requestedAt: request.requestedAt,
        });
        yield* options.custody.validateConfiguration.pipe(
          Effect.mapError((error) => mapCustodyError("begin-recovery", error)),
        );
        const reservation = yield* reserve(operation);
        if (reservation.disposition === "duplicate" && reservation.operation.state !== "pending") {
          return yield* duplicateOperation(reservation.operation, () =>
            options.repository
              .getRecovery(request.workspaceId, request.recoveryAttemptId)
              .pipe(Effect.mapError((error) => mapRepositoryError("begin-recovery", error))),
          );
        }
        const initiated = yield* options.custody
          .beginRecovery({
            operationId: request.operationId,
            recoveryAttemptId: request.recoveryAttemptId,
            wallet,
            material,
          })
          .pipe(Effect.catch((error) => failNotApplied(reservation.operation, error)));
        const initiatedAt = now();
        if (!isBefore(initiatedAt, initiated.expiresAt)) {
          return yield* failNotApplied(
            reservation.operation,
            new WalletCustodyError({
              code: "invalidResponse",
              operation: "begin-recovery",
              retryable: false,
              outcome: "notApplied",
            }),
          );
        }
        return yield* options.repository
          .completeRecoveryBegin({
            operation: reservation.operation,
            recovery: {
              recoveryAttemptId: request.recoveryAttemptId,
              walletId: request.walletId,
              workspaceId: request.workspaceId,
              state: "initiated",
              providerActivityRef: initiated.providerActivityRef,
              initiatedAt,
              expiresAt: initiated.expiresAt,
            },
            actor: actorFor(principal),
            auditEventId: nextAuditEventId(),
          })
          .pipe(Effect.mapError((error) => mapRepositoryError("begin-recovery", error)));
      }),
    completeRecovery: (principal, request, material) =>
      Effect.gen(function* () {
        yield* authorizePrincipal(principal, request.workspaceId);
        yield* validateRequestedAt(request.requestedAt);
        yield* validateFingerprint(request.requestFingerprint, {
          operationId: request.operationId,
          recoveryAttemptId: request.recoveryAttemptId,
          walletId: request.walletId,
          workspaceId: request.workspaceId,
          idempotencyKey: request.idempotencyKey,
          requestedAt: request.requestedAt,
        });
        const wallet = yield* requireWallet(request.workspaceId, request.walletId);
        yield* authorizePrincipal(principal, wallet.workspaceId, wallet.ownerUserId);
        const operation = operationFrom({
          workspaceId: request.workspaceId,
          operationId: request.operationId,
          walletId: request.walletId,
          kind: "recoveryComplete",
          idempotencyKey: request.idempotencyKey,
          requestFingerprint: request.requestFingerprint,
          requestedAt: request.requestedAt,
        });
        yield* options.custody.validateConfiguration.pipe(
          Effect.mapError((error) => mapCustodyError("complete-recovery", error)),
        );
        const reservation = yield* options.repository
          .reserveDelegationConfiguration({ operation })
          .pipe(Effect.mapError((error) => mapRepositoryError("complete-recovery", error)));
        if (reservation.operation === undefined || reservation.intent === undefined) {
          return yield* serviceError("complete-recovery", "databaseFailure", true);
        }
        const reservedOperation = reservation.operation;
        if (reservation.disposition === "duplicate" && reservedOperation.state !== "pending") {
          return yield* duplicateOperation(reservedOperation, () =>
            options.repository
              .getRecovery(request.workspaceId, request.recoveryAttemptId)
              .pipe(Effect.mapError((error) => mapRepositoryError("complete-recovery", error))),
          );
        }
        const recovery = yield* options.repository
          .getRecovery(request.workspaceId, request.recoveryAttemptId)
          .pipe(Effect.mapError((error) => mapRepositoryError("complete-recovery", error)));
        if (
          recovery === undefined ||
          recovery.walletId !== request.walletId ||
          recovery.state !== "initiated"
        ) {
          yield* options.repository
            .failOperation({
              workspaceId: request.workspaceId,
              operationId: request.operationId,
              walletId: request.walletId,
              errorCode: "recoveryNotFound",
              failedAt: now(),
              auditEventId: nextAuditEventId(),
            })
            .pipe(Effect.mapError((error) => mapRepositoryError("complete-recovery", error)));
          return yield* serviceError("complete-recovery", "notFound");
        }
        if (!isBefore(now(), recovery.expiresAt)) {
          yield* options.repository
            .failOperation({
              workspaceId: request.workspaceId,
              operationId: request.operationId,
              walletId: request.walletId,
              errorCode: "recoveryExpired",
              failedAt: now(),
              auditEventId: nextAuditEventId(),
            })
            .pipe(Effect.mapError((error) => mapRepositoryError("complete-recovery", error)));
          return yield* serviceError("complete-recovery", "authorizationExpired");
        }
        const activeAuthorization = yield* options.repository
          .getActiveDelegatedAuthorization(request.workspaceId, request.walletId)
          .pipe(Effect.mapError((error) => mapRepositoryError("complete-recovery", error)));
        if (activeAuthorization !== undefined) {
          yield* revokeAuthorization(reservedOperation, wallet, activeAuthorization);
        }
        const completed = yield* options.custody
          .completeRecovery({
            operationId: request.operationId,
            recoveryAttemptId: request.recoveryAttemptId,
            wallet,
            material,
          })
          .pipe(Effect.catch((error) => failNotApplied(reservedOperation, error)));
        return yield* options.repository
          .completeRecovery({
            operation: reservedOperation,
            recoveryAttemptId: request.recoveryAttemptId,
            providerActivityRef: completed.providerActivityRef,
            actor: actorFor(principal),
            completedAt: now(),
            auditEventId: nextAuditEventId(),
          })
          .pipe(Effect.mapError((error) => mapRepositoryError("complete-recovery", error)));
      }),
    withdraw: (principal, request, ownerAuthorization) =>
      Effect.gen(function* () {
        yield* authorizePrincipal(
          principal,
          request.workspaceId,
          request.approval.approvedByUserId,
        );
        yield* validateRequestedAt(request.requestedAt);
        yield* validateFingerprint(request.requestFingerprint, {
          schemaVersion: request.schemaVersion,
          operationId: request.operationId,
          idempotencyKey: request.idempotencyKey,
          workspaceId: request.workspaceId,
          walletId: request.walletId,
          destination: request.approval.destination,
          amountMicroUsdc: request.approval.amountMicroUsdc,
          approvalId: request.approval.approvalId,
          approvedByUserId: request.approval.approvedByUserId,
          approvedByAuthSessionId: request.approval.approvedByAuthSessionId,
          approvedAt: request.approval.approvedAt,
          expiresAt: request.approval.expiresAt,
          requestedAt: request.requestedAt,
        });
        if (
          request.approval.approvedByAuthSessionId !== principal.authSessionId ||
          !isBefore(now(), request.approval.expiresAt) ||
          request.approval.amountMicroUsdc <= 0
        ) {
          return yield* serviceError("withdraw", "authorizationExpired");
        }
        const wallet = yield* requireWallet(request.workspaceId, request.walletId);
        yield* authorizePrincipal(principal, wallet.workspaceId, wallet.ownerUserId);
        if (wallet.state !== "active") return yield* serviceError("withdraw", "policyViolation");
        const operation = operationFrom({
          workspaceId: request.workspaceId,
          operationId: request.operationId,
          walletId: request.walletId,
          kind: "withdrawal",
          idempotencyKey: request.idempotencyKey,
          requestFingerprint: request.requestFingerprint,
          requestedAt: request.requestedAt,
          amountMicroUsdc: request.approval.amountMicroUsdc,
          destination: request.approval.destination,
        });
        const reservation = yield* reserve(operation);
        if (reservation.disposition === "duplicate") {
          return yield* duplicateOperation(reservation.operation, () => {
            const duplicate = reservation.operation;
            return Effect.succeed(
              duplicate.txHash === undefined ||
                duplicate.amountMicroUsdc === undefined ||
                duplicate.destination === undefined ||
                duplicate.completedAt === undefined
                ? undefined
                : {
                    operationId: duplicate.operationId,
                    walletId: duplicate.walletId,
                    workspaceId: duplicate.workspaceId,
                    binding: MONAD_USDC_BINDING,
                    destination: duplicate.destination,
                    amountMicroUsdc: duplicate.amountMicroUsdc,
                    txHash: duplicate.txHash,
                    submittedAt: duplicate.completedAt,
                    disposition: "duplicate" as const,
                  },
            );
          });
        }
        const transfer = yield* options.custody
          .withdraw({
            operationId: request.operationId,
            wallet,
            binding: MONAD_USDC_BINDING,
            destination: request.approval.destination,
            amountMicroUsdc: request.approval.amountMicroUsdc,
            ownerAuthorization,
            submittedAt: now(),
          })
          .pipe(Effect.catch((error) => failNotApplied(reservation.operation, error)));
        return yield* options.repository
          .completeWithdrawal({
            operation: reservation.operation,
            transfer,
            actor: actorFor(principal),
            auditEventId: nextAuditEventId(),
          })
          .pipe(Effect.mapError((error) => mapRepositoryError("withdraw", error)));
      }),
    charge: (principal, untrustedRequest) =>
      Effect.gen(function* () {
        yield* options.authorizeSettlement(principal, {
          workspaceId: untrustedRequest.workspaceId,
          walletId: untrustedRequest.walletId,
        });
        const effectiveNow = now();
        yield* validateRequestedAt(untrustedRequest.requestedAt);
        yield* validateFingerprint(untrustedRequest.requestFingerprint, {
          schemaVersion: untrustedRequest.schemaVersion,
          reservationId: untrustedRequest.reservationId,
          idempotencyKey: untrustedRequest.idempotencyKey,
          workspaceId: untrustedRequest.workspaceId,
          walletId: untrustedRequest.walletId,
          authorizationId: untrustedRequest.authorizationId,
          binding: untrustedRequest.binding,
          destination: untrustedRequest.destination,
          amountMicroUsdc: untrustedRequest.amountMicroUsdc,
          requestedAt: untrustedRequest.requestedAt,
        });
        const request = { ...untrustedRequest, requestedAt: effectiveNow };
        const operationId = delegatedSpendOperationId(request.reservationId);
        const wallet = yield* requireWallet(request.workspaceId, request.walletId);
        if (wallet.state !== "active") return yield* serviceError("charge", "policyViolation");
        const authorization = yield* options.repository
          .getDelegatedAuthorization(request.workspaceId, request.walletId, request.authorizationId)
          .pipe(Effect.mapError((error) => mapRepositoryError("charge", error)));
        if (authorization === undefined) return yield* serviceError("charge", "notFound");
        yield* options.custody.validateConfiguration.pipe(
          Effect.mapError((error) => mapCustodyError("charge", error)),
        );
        const utcDay = effectiveNow.slice(0, 10);
        const reservation = yield* options.repository
          .reserveDelegatedSpend({
            request,
            operationId,
            utcDay,
            auditEventId: nextAuditEventId(),
          })
          .pipe(Effect.mapError((error) => mapRepositoryError("charge", error)));
        if (reservation.disposition === "duplicate") {
          if (reservation.reservation.state === "released") {
            return yield* serviceError("charge", "operationFailed");
          }
          if (reservation.reservation.state !== "submitted") {
            return yield* serviceError("charge", "operationPending", true);
          }
          if (reservation.reservation.txHash === undefined) {
            return yield* serviceError("charge", "databaseFailure", true);
          }
          return {
            operationId,
            walletId: request.walletId,
            workspaceId: request.workspaceId,
            binding: MONAD_USDC_BINDING,
            destination: request.destination,
            amountMicroUsdc: reservation.reservation.amountMicroUsdc,
            txHash: reservation.reservation.txHash,
            submittedAt: reservation.reservation.updatedAt,
            disposition: "duplicate" as const,
          };
        }
        const submission = yield* options.custody
          .charge({
            operationId,
            wallet,
            authorization,
            binding: request.binding,
            destination: request.destination,
            amountMicroUsdc: request.amountMicroUsdc,
            submittedAt: effectiveNow,
          })
          .pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                const evidence = custodyEvidenceFromError(error);
                if (evidence === undefined) {
                  return yield* serviceError(
                    "charge",
                    error.outcome === "uncertain" ? "operationPending" : "providerUnavailable",
                    true,
                  );
                }
                const recorded = yield* options.repository
                  .recordDelegatedSpendEvidence({
                    workspaceId: request.workspaceId,
                    reservationId: request.reservationId,
                    evidence,
                    auditEventId: nextAuditEventId(),
                  })
                  .pipe(Effect.mapError((cause) => mapRepositoryError("charge", cause)));
                if (
                  recorded.reservation.state === "submitted" &&
                  recorded.reservation.txHash !== undefined
                ) {
                  return {
                    transfer: {
                      operationId,
                      walletId: request.walletId,
                      workspaceId: request.workspaceId,
                      binding: MONAD_USDC_BINDING,
                      destination: authorization.treasuryAddress,
                      amountMicroUsdc: recorded.reservation.amountMicroUsdc,
                      txHash: recorded.reservation.txHash,
                      submittedAt: recorded.reservation.updatedAt,
                      disposition: "submitted" as const,
                    },
                    evidence,
                  };
                }
                return yield* serviceError(
                  "charge",
                  recorded.reservation.state === "released"
                    ? "providerUnavailable"
                    : "operationPending",
                  recorded.reservation.state !== "released",
                );
              }),
            ),
          );
        if (
          submission.evidence.status !== "applied" ||
          submission.evidence.txHash !== submission.transfer.txHash ||
          submission.transfer.destination !== authorization.treasuryAddress
        ) {
          return yield* serviceError("charge", "providerUnavailable", true);
        }
        yield* options.repository
          .recordDelegatedSpendEvidence({
            workspaceId: request.workspaceId,
            reservationId: request.reservationId,
            evidence: submission.evidence,
            auditEventId: nextAuditEventId(),
          })
          .pipe(Effect.mapError((error) => mapRepositoryError("charge", error)));
        return submission.transfer;
      }),
    reconcileCharge: (principal, reservationId) =>
      Effect.gen(function* () {
        const existing = yield* options.repository
          .getDelegatedSpend(principal.workspaceId, reservationId)
          .pipe(Effect.mapError((error) => mapRepositoryError("reconcile-charge", error)));
        if (existing === undefined) return yield* serviceError("reconcile-charge", "notFound");
        yield* options.authorizeSettlement(principal, {
          workspaceId: existing.workspaceId,
          walletId: existing.walletId,
        });
        const wallet = yield* requireWallet(existing.workspaceId, existing.walletId);
        const authorization = yield* options.repository
          .getDelegatedAuthorization(
            existing.workspaceId,
            existing.walletId,
            existing.authorizationId,
          )
          .pipe(Effect.mapError((error) => mapRepositoryError("reconcile-charge", error)));
        if (authorization === undefined) {
          return yield* serviceError("reconcile-charge", "notFound");
        }
        const toTransfer = (
          spend: WalletDelegatedSpendReservation,
          disposition: WalletTransferResult["disposition"],
        ): WalletTransferResult | undefined =>
          spend.state !== "submitted" || spend.txHash === undefined
            ? undefined
            : {
                operationId: delegatedSpendOperationId(spend.reservationId),
                walletId: spend.walletId,
                workspaceId: spend.workspaceId,
                binding: MONAD_USDC_BINDING,
                destination: authorization.treasuryAddress,
                amountMicroUsdc: spend.amountMicroUsdc,
                txHash: spend.txHash,
                submittedAt: spend.updatedAt,
                disposition,
              };
        if (existing.state !== "reserved") {
          const transfer = toTransfer(existing, "duplicate");
          const terminalStatus =
            existing.state === "submitted" ? ("applied" as const) : ("notApplied" as const);
          return {
            reservation: existing,
            status: terminalStatus,
            ...(transfer === undefined ? {} : { transfer }),
            disposition: "duplicate" as const,
          };
        }
        if (existing.providerActivityRef === undefined) {
          return yield* serviceError("reconcile-charge", "operationPending", true);
        }
        yield* options.custody.validateConfiguration.pipe(
          Effect.mapError((error) => mapCustodyError("reconcile-charge", error)),
        );
        const status = yield* options.custody
          .getChargeStatus({
            wallet,
            authorization,
            reservation: existing,
            providerActivityRef: existing.providerActivityRef,
            observedAt: now(),
          })
          .pipe(
            Effect.catch((error) => {
              const evidence = custodyEvidenceFromError(error);
              return evidence === undefined
                ? Effect.fail(mapCustodyError("reconcile-charge", error))
                : Effect.succeed({ evidence });
            }),
          );
        if (status.evidence.providerActivityRef !== existing.providerActivityRef) {
          return yield* serviceError("reconcile-charge", "providerUnavailable", true);
        }
        const recorded = yield* options.repository
          .recordDelegatedSpendEvidence({
            workspaceId: existing.workspaceId,
            reservationId,
            evidence: status.evidence,
            auditEventId: nextAuditEventId(),
          })
          .pipe(Effect.mapError((error) => mapRepositoryError("reconcile-charge", error)));
        const transfer = toTransfer(recorded.reservation, "submitted");
        return {
          reservation: recorded.reservation,
          status: status.evidence.status,
          ...(transfer === undefined ? {} : { transfer }),
          disposition: recorded.disposition,
        };
      }).pipe(
        Effect.mapError((error) =>
          isWalletServiceError(error) ? error : mapRepositoryError("reconcile-charge", error),
        ),
      ),
  };
};
