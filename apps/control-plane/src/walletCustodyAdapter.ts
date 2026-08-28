// @effect-diagnostics nodeBuiltinImport:off -- Deterministic fake identifiers are derived with SHA-256.
import * as NodeCrypto from "node:crypto";

import type { EvmAddress, MicroUsdc, WorkspaceId } from "@t3tools/contracts/cloud";
import { EvmTransactionHash } from "@t3tools/contracts/cloud";
import type {
  MonadUsdcBinding,
  UserOwnedWallet,
  WalletDelegatedAuthorization,
  WalletOperationId,
  WalletRecoveryAttemptId,
  WalletDelegatedSpendReservation,
  WalletProviderEffectEvidence,
  WalletTransferResult,
} from "@t3tools/contracts/wallet";
import {
  WalletIsoDateTime,
  WalletProviderEffectStatus,
  WalletProviderReference,
} from "@t3tools/contracts/wallet";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { Secret } from "./providerSecrets.ts";

export interface WalletOwnerAuthorization {
  /** Opaque user-held Turnkey stamp or assertion. Never persisted or logged. */
  readonly stamp: Secret<Uint8Array>;
}

export interface WalletProvisioningMaterial extends WalletOwnerAuthorization {
  /** Used by Turnkey only. The control plane stores no email address in wallet tables. */
  readonly recoveryEmail: Secret<string>;
  /** Opaque WebAuthn registration payload consumed by the Turnkey adapter. */
  readonly passkeyRegistration: Secret<Uint8Array>;
}

export interface WalletRecoveryInitiationMaterial {
  readonly recoveryEmail: Secret<string>;
  readonly targetPublicKey: Secret<string>;
}

export interface WalletRecoveryCompletionMaterial {
  readonly encryptedRecoveryBundle: Secret<string>;
}

export interface CustodyProvisionedWallet {
  readonly providerOrganizationRef: string;
  readonly providerWalletRef: string;
  readonly address: EvmAddress;
  readonly providerActivityRef: string;
}

export interface CustodyDelegatedAuthorization {
  readonly providerPolicyRef: string;
  readonly providerDelegatedUserRef: string;
  readonly providerDelegatedCredentialRef: string;
  readonly providerActivityRef: string;
}

export interface CustodyDelegatedAuthorizationStatus {
  readonly status: "applied" | "notApplied" | "stillUnknown";
  readonly observedAt: string;
  readonly providerActivityRef?: string;
  readonly providerPolicyRef?: string;
  readonly providerDelegatedUserRef?: string;
  readonly providerDelegatedCredentialRef?: string;
}

export interface CustodyRecoveryInitiation {
  readonly providerActivityRef: string;
  readonly expiresAt: string;
}

export interface CustodyDelegationRevocationStatus {
  readonly providerActivityRef: string;
  readonly status: "applied" | "notApplied" | "stillUnknown";
  readonly observedAt: string;
}

export interface CustodyChargeSubmission {
  readonly transfer: WalletTransferResult;
  readonly evidence: WalletProviderEffectEvidence;
}

export interface CustodyChargeStatus {
  readonly evidence: WalletProviderEffectEvidence;
}

export interface WalletCustodyAdapter {
  readonly provider: "turnkey";
  readonly validateConfiguration: Effect.Effect<void, WalletCustodyError>;
  readonly provision: (input: {
    readonly operationId: WalletOperationId;
    readonly workspaceId: WorkspaceId;
    readonly ownerUserId: string;
    readonly material: WalletProvisioningMaterial;
  }) => Effect.Effect<CustodyProvisionedWallet, WalletCustodyError>;
  readonly configureDelegatedAuthorization: (input: {
    readonly operationId: WalletOperationId;
    readonly wallet: UserOwnedWallet;
    readonly authorization: WalletDelegatedAuthorization;
    readonly ownerAuthorization: WalletOwnerAuthorization;
  }) => Effect.Effect<CustodyDelegatedAuthorization, WalletCustodyError>;
  /** Reconciles the idempotent configuration operation without creating new access. */
  readonly getDelegatedAuthorizationStatus: (input: {
    readonly operationId: WalletOperationId;
    readonly wallet: UserOwnedWallet;
    readonly authorization: WalletDelegatedAuthorization;
    readonly providerActivityRef?: string;
    readonly observedAt: string;
  }) => Effect.Effect<CustodyDelegatedAuthorizationStatus, WalletCustodyError>;
  /** Idempotent by operationId and the authorization's provider references. */
  readonly revokeDelegatedAuthorization: (input: {
    readonly operationId: WalletOperationId;
    readonly wallet: UserOwnedWallet;
    readonly authorization: WalletDelegatedAuthorization;
    readonly requestedAt: string;
  }) => Effect.Effect<CustodyDelegationRevocationStatus, WalletCustodyError>;
  readonly getDelegationRevocationStatus: (input: {
    readonly wallet: UserOwnedWallet;
    readonly authorization: WalletDelegatedAuthorization;
    readonly providerActivityRef: string;
    readonly observedAt: string;
  }) => Effect.Effect<CustodyDelegationRevocationStatus, WalletCustodyError>;
  readonly beginRecovery: (input: {
    readonly operationId: WalletOperationId;
    readonly recoveryAttemptId: WalletRecoveryAttemptId;
    readonly wallet: UserOwnedWallet;
    readonly material: WalletRecoveryInitiationMaterial;
  }) => Effect.Effect<CustodyRecoveryInitiation, WalletCustodyError>;
  readonly completeRecovery: (input: {
    readonly operationId: WalletOperationId;
    readonly recoveryAttemptId: WalletRecoveryAttemptId;
    readonly wallet: UserOwnedWallet;
    readonly material: WalletRecoveryCompletionMaterial;
  }) => Effect.Effect<{ readonly providerActivityRef: string }, WalletCustodyError>;
  readonly withdraw: (input: {
    readonly operationId: WalletOperationId;
    readonly wallet: UserOwnedWallet;
    readonly binding: MonadUsdcBinding;
    readonly destination: EvmAddress;
    readonly amountMicroUsdc: MicroUsdc;
    readonly ownerAuthorization: WalletOwnerAuthorization;
    readonly submittedAt: string;
  }) => Effect.Effect<WalletTransferResult, WalletCustodyError>;
  readonly charge: (input: {
    readonly operationId: WalletOperationId;
    readonly wallet: UserOwnedWallet;
    readonly authorization: WalletDelegatedAuthorization;
    readonly binding: MonadUsdcBinding;
    readonly destination: EvmAddress;
    readonly amountMicroUsdc: MicroUsdc;
    readonly submittedAt: string;
  }) => Effect.Effect<CustodyChargeSubmission, WalletCustodyError>;
  readonly getChargeStatus: (input: {
    readonly wallet: UserOwnedWallet;
    readonly authorization: WalletDelegatedAuthorization;
    readonly reservation: WalletDelegatedSpendReservation;
    readonly providerActivityRef: string;
    readonly observedAt: string;
  }) => Effect.Effect<CustodyChargeStatus, WalletCustodyError>;
}

export class WalletCustodyError extends Schema.TaggedErrorClass<WalletCustodyError>()(
  "WalletCustodyError",
  {
    code: Schema.Literals([
      "configurationMissing",
      "configurationInvalid",
      "authorizationRejected",
      "policyRejected",
      "providerUnavailable",
      "providerRejected",
      "invalidResponse",
    ]),
    operation: Schema.String,
    retryable: Schema.Boolean,
    outcome: Schema.Literals(["notApplied", "uncertain"]),
    providerActivityRef: Schema.optionalKey(WalletProviderReference),
    providerStatus: Schema.optionalKey(WalletProviderEffectStatus),
    observedAt: Schema.optionalKey(WalletIsoDateTime),
    txHash: Schema.optionalKey(EvmTransactionHash),
    providerPolicyRef: Schema.optionalKey(WalletProviderReference),
    providerDelegatedUserRef: Schema.optionalKey(WalletProviderReference),
    providerDelegatedCredentialRef: Schema.optionalKey(WalletProviderReference),
  },
) {}

const disabled = (operation: string) =>
  Effect.fail(
    new WalletCustodyError({
      code: "configurationMissing",
      operation,
      retryable: false,
      outcome: "notApplied",
    }),
  );

/** Fail-closed adapter used whenever production Turnkey configuration is absent. */
export const disabledTurnkeyWalletAdapter: WalletCustodyAdapter = {
  provider: "turnkey",
  validateConfiguration: disabled("validate-configuration"),
  provision: () => disabled("provision"),
  configureDelegatedAuthorization: () => disabled("configure-delegated-authorization"),
  getDelegatedAuthorizationStatus: () => disabled("get-delegated-authorization-status"),
  revokeDelegatedAuthorization: () => disabled("revoke-delegated-authorization"),
  getDelegationRevocationStatus: () => disabled("get-delegation-revocation-status"),
  beginRecovery: () => disabled("begin-recovery"),
  completeRecovery: () => disabled("complete-recovery"),
  withdraw: () => disabled("withdraw"),
  charge: () => disabled("charge"),
  getChargeStatus: () => disabled("get-charge-status"),
};

export interface FakeWalletCustodyCall {
  readonly operation:
    | "provision"
    | "configureDelegatedAuthorization"
    | "getDelegatedAuthorizationStatus"
    | "revokeDelegatedAuthorization"
    | "getDelegationRevocationStatus"
    | "beginRecovery"
    | "completeRecovery"
    | "withdraw"
    | "charge"
    | "getChargeStatus";
  readonly operationId: WalletOperationId;
  readonly workspaceId: WorkspaceId;
  readonly walletId?: UserOwnedWallet["walletId"];
  readonly amountMicroUsdc?: MicroUsdc;
  readonly destination?: EvmAddress;
}

export interface FakeWalletCustodyAdapter extends WalletCustodyAdapter {
  readonly calls: ReadonlyArray<FakeWalletCustodyCall>;
}

const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const providerRef = (kind: string, operationId: WalletOperationId) =>
  `${kind}_${digest(operationId).slice(0, 24)}`;
const addressFor = (operationId: WalletOperationId) =>
  `0x${digest(`address:${operationId}`).slice(0, 40)}` as EvmAddress;
const hashFor = (operationId: WalletOperationId) =>
  `0x${digest(`transaction:${operationId}`)}` as EvmTransactionHash;

/** Deterministic, credential-blind adapter for service and repository tests. */
export const makeFakeWalletCustodyAdapter = (): FakeWalletCustodyAdapter => {
  const calls: Array<FakeWalletCustodyCall> = [];
  return {
    provider: "turnkey",
    validateConfiguration: Effect.void,
    get calls() {
      return calls;
    },
    provision: (input) => {
      calls.push({
        operation: "provision",
        operationId: input.operationId,
        workspaceId: input.workspaceId,
      });
      return Effect.succeed({
        providerOrganizationRef: providerRef("organization", input.operationId),
        providerWalletRef: providerRef("wallet", input.operationId),
        address: addressFor(input.operationId),
        providerActivityRef: providerRef("activity", input.operationId),
      });
    },
    configureDelegatedAuthorization: (input) => {
      calls.push({
        operation: "configureDelegatedAuthorization",
        operationId: input.operationId,
        workspaceId: input.wallet.workspaceId,
        walletId: input.wallet.walletId,
      });
      return Effect.succeed({
        providerPolicyRef: providerRef("policy", input.operationId),
        providerDelegatedUserRef: providerRef("user", input.operationId),
        providerDelegatedCredentialRef: providerRef("credential", input.operationId),
        providerActivityRef: providerRef("activity", input.operationId),
      });
    },
    getDelegatedAuthorizationStatus: (input) => {
      calls.push({
        operation: "getDelegatedAuthorizationStatus",
        operationId: input.operationId,
        workspaceId: input.wallet.workspaceId,
        walletId: input.wallet.walletId,
      });
      return Effect.succeed({
        status: "applied",
        observedAt: input.observedAt,
        providerActivityRef:
          input.providerActivityRef ?? providerRef("activity", input.operationId),
        providerPolicyRef: providerRef("policy", input.operationId),
        providerDelegatedUserRef: providerRef("user", input.operationId),
        providerDelegatedCredentialRef: providerRef("credential", input.operationId),
      });
    },
    revokeDelegatedAuthorization: (input) => {
      calls.push({
        operation: "revokeDelegatedAuthorization",
        operationId: input.operationId,
        workspaceId: input.wallet.workspaceId,
        walletId: input.wallet.walletId,
      });
      return Effect.succeed({
        providerActivityRef: providerRef("revoke", input.operationId),
        status: "applied",
        observedAt: input.requestedAt,
      });
    },
    getDelegationRevocationStatus: (input) => {
      calls.push({
        operation: "getDelegationRevocationStatus",
        operationId:
          `status_${digest(input.providerActivityRef).slice(0, 24)}` as WalletOperationId,
        workspaceId: input.wallet.workspaceId,
        walletId: input.wallet.walletId,
      });
      return Effect.succeed({
        providerActivityRef: input.providerActivityRef,
        status: "applied",
        observedAt: input.observedAt,
      });
    },
    beginRecovery: (input) => {
      calls.push({
        operation: "beginRecovery",
        operationId: input.operationId,
        workspaceId: input.wallet.workspaceId,
        walletId: input.wallet.walletId,
      });
      return Effect.succeed({
        providerActivityRef: providerRef("activity", input.operationId),
        expiresAt: "2026-08-28T00:15:00.000Z",
      });
    },
    completeRecovery: (input) => {
      calls.push({
        operation: "completeRecovery",
        operationId: input.operationId,
        workspaceId: input.wallet.workspaceId,
        walletId: input.wallet.walletId,
      });
      return Effect.succeed({ providerActivityRef: providerRef("activity", input.operationId) });
    },
    withdraw: (input) => {
      calls.push({
        operation: "withdraw",
        operationId: input.operationId,
        workspaceId: input.wallet.workspaceId,
        walletId: input.wallet.walletId,
        amountMicroUsdc: input.amountMicroUsdc,
        destination: input.destination,
      });
      return Effect.succeed({
        operationId: input.operationId,
        walletId: input.wallet.walletId,
        workspaceId: input.wallet.workspaceId,
        binding: input.binding,
        destination: input.destination,
        amountMicroUsdc: input.amountMicroUsdc,
        txHash: hashFor(input.operationId),
        submittedAt: input.submittedAt,
        disposition: "submitted",
      });
    },
    charge: (input) => {
      calls.push({
        operation: "charge",
        operationId: input.operationId,
        workspaceId: input.wallet.workspaceId,
        walletId: input.wallet.walletId,
        amountMicroUsdc: input.amountMicroUsdc,
        destination: input.destination,
      });
      const txHash = hashFor(input.operationId);
      return Effect.succeed({
        transfer: {
          operationId: input.operationId,
          walletId: input.wallet.walletId,
          workspaceId: input.wallet.workspaceId,
          binding: input.binding,
          destination: input.destination,
          amountMicroUsdc: input.amountMicroUsdc,
          txHash,
          submittedAt: input.submittedAt,
          disposition: "submitted",
        },
        evidence: {
          providerActivityRef: providerRef("charge", input.operationId),
          status: "applied",
          observedAt: input.submittedAt,
          txHash,
        },
      });
    },
    getChargeStatus: (input) => {
      calls.push({
        operation: "getChargeStatus",
        operationId:
          `status_${digest(input.providerActivityRef).slice(0, 24)}` as WalletOperationId,
        workspaceId: input.wallet.workspaceId,
        walletId: input.wallet.walletId,
      });
      const operationId =
        `spend_${digest(input.reservation.reservationId).slice(0, 32)}` as WalletOperationId;
      return Effect.succeed({
        evidence: {
          providerActivityRef: input.providerActivityRef,
          status: "applied",
          observedAt: input.observedAt,
          txHash: hashFor(operationId),
        },
      });
    },
  };
};
