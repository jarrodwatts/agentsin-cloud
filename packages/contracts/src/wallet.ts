/**
 * Provider-neutral contracts for the user-owned hosted wallet.
 *
 * Provider credentials, passkey assertions, recovery bundles, and signing
 * material are intentionally absent from this wire-safe module.
 *
 * @module wallet
 */
import * as Schema from "effect/Schema";

import { AuthSessionId, IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  EvmAddress,
  EvmTransactionHash,
  MicroUsdc,
  MONAD_MAINNET_CHAIN_ID,
  MONAD_MAINNET_NATIVE_USDC,
  WorkspaceId,
} from "./cloud.ts";

/** Canonical UTC form used for policy and approval comparisons. */
export const WalletIsoDateTime = IsoDateTime.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
);
export type WalletIsoDateTime = typeof WalletIsoDateTime.Type;

const makeWalletEntityId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.check(
    Schema.isMaxLength(96),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  ).pipe(Schema.brand(brand));

export const WalletId = makeWalletEntityId("WalletId");
export type WalletId = typeof WalletId.Type;
export const WalletOperationId = makeWalletEntityId("WalletOperationId");
export type WalletOperationId = typeof WalletOperationId.Type;
export const WalletRecoveryAttemptId = makeWalletEntityId("WalletRecoveryAttemptId");
export type WalletRecoveryAttemptId = typeof WalletRecoveryAttemptId.Type;
export const WalletDelegatedAuthorizationId = makeWalletEntityId("WalletDelegatedAuthorizationId");
export type WalletDelegatedAuthorizationId = typeof WalletDelegatedAuthorizationId.Type;
export const WalletSpendReservationId = makeWalletEntityId("WalletSpendReservationId");
export type WalletSpendReservationId = typeof WalletSpendReservationId.Type;

export const WalletIdempotencyKey = TrimmedNonEmptyString.check(Schema.isMaxLength(256)).pipe(
  Schema.brand("WalletIdempotencyKey"),
);
export type WalletIdempotencyKey = typeof WalletIdempotencyKey.Type;

export const WalletRequestFingerprint = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/),
).pipe(Schema.brand("WalletRequestFingerprint"));
export type WalletRequestFingerprint = typeof WalletRequestFingerprint.Type;

export const WalletProvider = Schema.Literal("turnkey");
export type WalletProvider = typeof WalletProvider.Type;
export const WalletLifecycleState = Schema.Literals([
  "provisioning",
  "active",
  "recoveryPending",
  "frozen",
]);
export type WalletLifecycleState = typeof WalletLifecycleState.Type;

export const WalletProviderReference = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export type WalletProviderReference = typeof WalletProviderReference.Type;

export const WalletProviderEffectStatus = Schema.Literals([
  "applied",
  "notApplied",
  "stillUnknown",
]);
export type WalletProviderEffectStatus = typeof WalletProviderEffectStatus.Type;

/** Provider evidence safe to persist and use for monotonic reconciliation. */
export const WalletProviderEffectEvidence = Schema.Struct({
  providerActivityRef: WalletProviderReference,
  status: WalletProviderEffectStatus,
  observedAt: WalletIsoDateTime,
  txHash: Schema.optionalKey(EvmTransactionHash),
}).check(
  Schema.makeFilter(
    (input) =>
      (input.status === "applied" ? input.txHash !== undefined : true) ||
      "applied provider evidence requires a transaction hash",
    { identifier: "WalletProviderAppliedTransaction" },
  ),
);
export type WalletProviderEffectEvidence = typeof WalletProviderEffectEvidence.Type;

/** Metadata safe to persist. No private key, API key, stamp, or recovery bundle is included. */
export const UserOwnedWallet = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  walletId: WalletId,
  workspaceId: WorkspaceId,
  ownerUserId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  provider: WalletProvider,
  providerOrganizationRef: WalletProviderReference,
  providerWalletRef: WalletProviderReference,
  address: EvmAddress,
  state: WalletLifecycleState,
  recoveryMethod: Schema.Literal("passkeyAndEmail"),
  recoveryEnabled: Schema.Boolean,
  createdAt: WalletIsoDateTime,
  updatedAt: WalletIsoDateTime,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type UserOwnedWallet = typeof UserOwnedWallet.Type;

export const MonadUsdcBinding = Schema.Struct({
  namespace: Schema.Literal("eip155"),
  chain: Schema.Literal("monad"),
  chainId: Schema.Literal(MONAD_MAINNET_CHAIN_ID),
  network: Schema.Literal("monad-mainnet"),
  asset: Schema.Literal("USDC"),
  tokenContract: Schema.Literal(MONAD_MAINNET_NATIVE_USDC),
  tokenDecimals: Schema.Literal(6),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type MonadUsdcBinding = typeof MonadUsdcBinding.Type;

export const MONAD_USDC_BINDING = Schema.decodeUnknownSync(MonadUsdcBinding)({
  namespace: "eip155",
  chain: "monad",
  chainId: MONAD_MAINNET_CHAIN_ID,
  network: "monad-mainnet",
  asset: "USDC",
  tokenContract: MONAD_MAINNET_NATIVE_USDC,
  tokenDecimals: 6,
});

export const WalletDirectDepositInstructions = Schema.Struct({
  walletId: WalletId,
  address: EvmAddress,
  binding: MonadUsdcBinding,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type WalletDirectDepositInstructions = typeof WalletDirectDepositInstructions.Type;

/**
 * The complete delegated-settlement envelope. The control plane enforces the
 * cumulative UTC-day ceiling; the Turnkey policy constrains each decoded USDC
 * transfer to the same chain, contract, treasury, per-transfer ceiling, and
 * authorization lifetime.
 */
export const WalletDelegatedAuthorization = Schema.Struct({
  authorizationId: WalletDelegatedAuthorizationId,
  walletId: WalletId,
  workspaceId: WorkspaceId,
  binding: MonadUsdcBinding,
  treasuryAddress: EvmAddress,
  perChargeLimitMicroUsdc: MicroUsdc,
  dailyLimitMicroUsdc: MicroUsdc,
  startsAt: WalletIsoDateTime,
  expiresAt: WalletIsoDateTime,
  policyRevision: PositiveInt,
  providerPolicyRef: Schema.optionalKey(WalletProviderReference),
  providerDelegatedUserRef: Schema.optionalKey(WalletProviderReference),
  providerDelegatedCredentialRef: Schema.optionalKey(WalletProviderReference),
  state: Schema.Literals(["pending", "active", "expired", "revoked"]),
  createdAt: WalletIsoDateTime,
  updatedAt: WalletIsoDateTime,
})
  .check(
    Schema.makeFilter(
      (input) => input.perChargeLimitMicroUsdc > 0 || "per-charge limit must be greater than zero",
      { identifier: "WalletDelegatedPerChargePositive" },
    ),
    Schema.makeFilter(
      (input) =>
        input.dailyLimitMicroUsdc >= input.perChargeLimitMicroUsdc ||
        "daily limit must be at least the per-charge limit",
      { identifier: "WalletDelegatedDailyLimit" },
    ),
    Schema.makeFilter(
      (input) => input.startsAt < input.expiresAt || "delegated authorization must expire",
      { identifier: "WalletDelegatedLifetime" },
    ),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });
export type WalletDelegatedAuthorization = typeof WalletDelegatedAuthorization.Type;

export const WalletConfigureDelegationRequest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  operationId: WalletOperationId,
  idempotencyKey: WalletIdempotencyKey,
  requestFingerprint: WalletRequestFingerprint,
  workspaceId: WorkspaceId,
  walletId: WalletId,
  authorization: WalletDelegatedAuthorization,
  requestedAt: WalletIsoDateTime,
})
  .check(
    Schema.makeFilter(
      (input) =>
        (input.workspaceId === input.authorization.workspaceId &&
          input.walletId === input.authorization.walletId) ||
        "delegation request must match its authorization",
      { identifier: "WalletDelegationRequestBinding" },
    ),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });
export type WalletConfigureDelegationRequest = typeof WalletConfigureDelegationRequest.Type;

export const WalletProvisionRequest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  operationId: WalletOperationId,
  idempotencyKey: WalletIdempotencyKey,
  requestFingerprint: WalletRequestFingerprint,
  workspaceId: WorkspaceId,
  ownerUserId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  requestedAt: WalletIsoDateTime,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type WalletProvisionRequest = typeof WalletProvisionRequest.Type;

export const WalletProvisionResult = Schema.Struct({
  wallet: UserOwnedWallet,
  deposit: WalletDirectDepositInstructions,
  disposition: Schema.Literals(["created", "duplicate"]),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type WalletProvisionResult = typeof WalletProvisionResult.Type;

export const WalletRecoveryState = Schema.Literals(["initiated", "completed", "expired", "failed"]);
export type WalletRecoveryState = typeof WalletRecoveryState.Type;

export const WalletRecoveryMetadata = Schema.Struct({
  recoveryAttemptId: WalletRecoveryAttemptId,
  walletId: WalletId,
  workspaceId: WorkspaceId,
  state: WalletRecoveryState,
  providerActivityRef: Schema.optionalKey(WalletProviderReference),
  initiatedAt: WalletIsoDateTime,
  expiresAt: WalletIsoDateTime,
  completedAt: Schema.optionalKey(WalletIsoDateTime),
  failedAt: Schema.optionalKey(WalletIsoDateTime),
}).check(
  Schema.makeFilter(
    (input) => input.initiatedAt < input.expiresAt || "recovery attempt must expire",
    { identifier: "WalletRecoveryLifetime" },
  ),
  Schema.makeFilter(
    (input) =>
      (input.state === "completed"
        ? input.completedAt !== undefined && input.failedAt === undefined
        : input.state === "failed"
          ? input.failedAt !== undefined && input.completedAt === undefined
          : input.completedAt === undefined && input.failedAt === undefined) ||
      "recovery terminal timestamps must match state",
    { identifier: "WalletRecoveryTerminalState" },
  ),
);
export type WalletRecoveryMetadata = typeof WalletRecoveryMetadata.Type;

export const WalletRecoveryBeginRequest = Schema.Struct({
  operationId: WalletOperationId,
  recoveryAttemptId: WalletRecoveryAttemptId,
  walletId: WalletId,
  workspaceId: WorkspaceId,
  idempotencyKey: WalletIdempotencyKey,
  requestFingerprint: WalletRequestFingerprint,
  requestedAt: WalletIsoDateTime,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type WalletRecoveryBeginRequest = typeof WalletRecoveryBeginRequest.Type;

export const WalletRecoveryCompleteRequest = Schema.Struct({
  operationId: WalletOperationId,
  recoveryAttemptId: WalletRecoveryAttemptId,
  walletId: WalletId,
  workspaceId: WorkspaceId,
  idempotencyKey: WalletIdempotencyKey,
  requestFingerprint: WalletRequestFingerprint,
  requestedAt: WalletIsoDateTime,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type WalletRecoveryCompleteRequest = typeof WalletRecoveryCompleteRequest.Type;

export const WalletWithdrawalApproval = Schema.Struct({
  approvalId: makeWalletEntityId("WalletWithdrawalApprovalId"),
  walletId: WalletId,
  workspaceId: WorkspaceId,
  destination: EvmAddress,
  amountMicroUsdc: MicroUsdc,
  approvedByUserId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  approvedByAuthSessionId: AuthSessionId,
  approvedAt: WalletIsoDateTime,
  expiresAt: WalletIsoDateTime,
  requestFingerprint: WalletRequestFingerprint,
}).check(
  Schema.makeFilter(
    (input) => input.amountMicroUsdc > 0 || "withdrawal amount must be greater than zero",
    { identifier: "WalletWithdrawalPositive" },
  ),
  Schema.makeFilter(
    (input) => input.approvedAt < input.expiresAt || "withdrawal approval must expire",
    { identifier: "WalletWithdrawalApprovalLifetime" },
  ),
);
export type WalletWithdrawalApproval = typeof WalletWithdrawalApproval.Type;

export const WalletWithdrawalRequest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  operationId: WalletOperationId,
  idempotencyKey: WalletIdempotencyKey,
  requestFingerprint: WalletRequestFingerprint,
  workspaceId: WorkspaceId,
  walletId: WalletId,
  approval: WalletWithdrawalApproval,
  requestedAt: WalletIsoDateTime,
})
  .check(
    Schema.makeFilter(
      (input) =>
        (input.workspaceId === input.approval.workspaceId &&
          input.walletId === input.approval.walletId &&
          input.requestFingerprint === input.approval.requestFingerprint) ||
        "withdrawal request must match its approval",
      { identifier: "WalletWithdrawalApprovalBinding" },
    ),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });
export type WalletWithdrawalRequest = typeof WalletWithdrawalRequest.Type;

export const WalletTransferResult = Schema.Struct({
  operationId: WalletOperationId,
  walletId: WalletId,
  workspaceId: WorkspaceId,
  binding: MonadUsdcBinding,
  destination: EvmAddress,
  amountMicroUsdc: MicroUsdc,
  txHash: EvmTransactionHash,
  submittedAt: WalletIsoDateTime,
  disposition: Schema.Literals(["submitted", "duplicate"]),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type WalletTransferResult = typeof WalletTransferResult.Type;

export const WalletDelegatedChargeRequest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  reservationId: WalletSpendReservationId,
  idempotencyKey: WalletIdempotencyKey,
  requestFingerprint: WalletRequestFingerprint,
  workspaceId: WorkspaceId,
  walletId: WalletId,
  authorizationId: WalletDelegatedAuthorizationId,
  binding: MonadUsdcBinding,
  destination: EvmAddress,
  amountMicroUsdc: MicroUsdc,
  requestedAt: WalletIsoDateTime,
})
  .check(
    Schema.makeFilter(
      (input) => input.amountMicroUsdc > 0 || "delegated charge must be greater than zero",
      { identifier: "WalletDelegatedChargePositive" },
    ),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });
export type WalletDelegatedChargeRequest = typeof WalletDelegatedChargeRequest.Type;

export const WalletDelegatedSpendReservation = Schema.Struct({
  reservationId: WalletSpendReservationId,
  workspaceId: WorkspaceId,
  walletId: WalletId,
  authorizationId: WalletDelegatedAuthorizationId,
  utcDay: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
  amountMicroUsdc: MicroUsdc,
  state: Schema.Literals(["reserved", "submitted", "released"]),
  idempotencyKey: WalletIdempotencyKey,
  requestFingerprint: WalletRequestFingerprint,
  createdAt: WalletIsoDateTime,
  updatedAt: WalletIsoDateTime,
  txHash: Schema.optionalKey(EvmTransactionHash),
  providerActivityRef: Schema.optionalKey(WalletProviderReference),
  providerStatus: Schema.optionalKey(WalletProviderEffectStatus),
  providerObservedAt: Schema.optionalKey(WalletIsoDateTime),
})
  .check(
    Schema.makeFilter(
      (input) =>
        (input.providerActivityRef === undefined
          ? input.providerStatus === undefined && input.providerObservedAt === undefined
          : input.providerStatus !== undefined && input.providerObservedAt !== undefined) ||
        "provider evidence fields must be persisted together",
      { identifier: "WalletDelegatedSpendEvidence" },
    ),
    Schema.makeFilter(
      (input) =>
        (input.state === "submitted"
          ? input.txHash !== undefined && input.providerStatus === "applied"
          : input.state === "released"
            ? input.txHash === undefined && input.providerStatus === "notApplied"
            : input.txHash === undefined &&
              (input.providerStatus === undefined || input.providerStatus === "stillUnknown")) ||
        "reservation state must match provider evidence",
      { identifier: "WalletDelegatedSpendState" },
    ),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });
export type WalletDelegatedSpendReservation = typeof WalletDelegatedSpendReservation.Type;

export const WalletChargeReconciliationResult = Schema.Struct({
  reservation: WalletDelegatedSpendReservation,
  status: WalletProviderEffectStatus,
  transfer: Schema.optionalKey(WalletTransferResult),
  disposition: Schema.Literals(["updated", "duplicate"]),
}).check(
  Schema.makeFilter(
    (input) =>
      (input.status === "applied" ? input.transfer !== undefined : input.transfer === undefined) ||
      "only applied reconciliation returns a transfer",
    { identifier: "WalletChargeReconciliationTransfer" },
  ),
);
export type WalletChargeReconciliationResult = typeof WalletChargeReconciliationResult.Type;
