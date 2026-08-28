import {
  type EvmAddress,
  MONAD_MAINNET_CHAIN_ID,
  MONAD_MAINNET_NATIVE_USDC,
} from "@t3tools/contracts/cloud";
import type {
  UserOwnedWallet,
  WalletDelegatedAuthorization,
  WalletOperationId,
  WalletRecoveryAttemptId,
  WalletTransferResult,
} from "@t3tools/contracts/wallet";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  disabledTurnkeyWalletAdapter,
  type CustodyDelegatedAuthorization,
  type CustodyDelegatedAuthorizationStatus,
  type CustodyDelegationRevocationStatus,
  type CustodyChargeStatus,
  type CustodyChargeSubmission,
  type CustodyProvisionedWallet,
  type CustodyRecoveryInitiation,
  type WalletCustodyAdapter,
  WalletCustodyError,
  type WalletOwnerAuthorization,
  type WalletProvisioningMaterial,
  type WalletRecoveryCompletionMaterial,
  type WalletRecoveryInitiationMaterial,
} from "./walletCustodyAdapter.ts";

export const TURNKEY_PRODUCTION_API_BASE_URL = "https://api.turnkey.com" as const;

/** The ABI names are policy-facing only; names do not change the transfer selector. */
export const TURNKEY_USDC_TRANSFER_INTERFACE = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "dst", type: "address" },
      { name: "wad", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export interface TurnkeyDelegatedPolicyDocument {
  readonly policyName: string;
  readonly effect: "EFFECT_ALLOW";
  readonly consensus: string;
  readonly condition: string;
  readonly time?: string;
  readonly notes: string;
}

const escapePolicyString = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");

/**
 * Compile the enclave-enforced per-transfer policy. Cumulative UTC-day spend
 * is transactional control-plane state because Turnkey's documented policy
 * language does not expose an aggregate daily-spend counter.
 */
export const compileTurnkeyDelegatedUsdcPolicy = (input: {
  readonly delegatedUserRef: string;
  readonly authorization: WalletDelegatedAuthorization;
  readonly timePoliciesEnabled: boolean;
}): TurnkeyDelegatedPolicyDocument => {
  const authorization = input.authorization;
  const condition = [
    "activity.kind == 'SIGN_TRANSACTION'",
    `eth.tx.chain_id == ${MONAD_MAINNET_CHAIN_ID}`,
    `eth.tx.to == '${MONAD_MAINNET_NATIVE_USDC}'`,
    "eth.tx.value == 0",
    "eth.tx.function_name == 'transfer'",
    `eth.tx.contract_call_args['dst'] == '${authorization.treasuryAddress}'`,
    "eth.tx.contract_call_args['wad'] > 0",
    `eth.tx.contract_call_args['wad'] <= ${authorization.perChargeLimitMicroUsdc}`,
  ].join(" && ");
  return {
    policyName: `Agents in Cloud settlement ${authorization.authorizationId}`,
    effect: "EFFECT_ALLOW",
    consensus: `approvers.any(user, user.id == '${escapePolicyString(input.delegatedUserRef)}')`,
    condition,
    ...(input.timePoliciesEnabled
      ? {
          time: `time.now >= Timestamp('${authorization.startsAt}') && time.now < Timestamp('${authorization.expiresAt}')`,
        }
      : {}),
    notes:
      "Allows only bounded native Circle USDC settlement to the configured treasury on Monad mainnet.",
  };
};

/**
 * Authenticated Turnkey operations. Implementations own SDK request stamping;
 * raw signing material is never part of this interface or returned to callers.
 */
export interface TurnkeyWalletGateway {
  readonly validate: Effect.Effect<void, WalletCustodyError>;
  readonly createSubOrganizationWallet: (input: {
    readonly operationId: WalletOperationId;
    readonly parentOrganizationId: string;
    readonly subOrganizationName: string;
    readonly ownerUserId: string;
    readonly material: WalletProvisioningMaterial;
    readonly account: {
      readonly curve: "CURVE_SECP256K1";
      readonly pathFormat: "PATH_FORMAT_BIP32";
      readonly path: "m/44'/60'/0'/0/0";
      readonly addressFormat: "ADDRESS_FORMAT_ETHEREUM";
    };
    readonly recovery: { readonly emailEnabled: true; readonly passkeyRequired: true };
  }) => Effect.Effect<CustodyProvisionedWallet, WalletCustodyError>;
  readonly configureDelegatedAccess: (input: {
    readonly operationId: WalletOperationId;
    readonly wallet: UserOwnedWallet;
    readonly ownerAuthorization: WalletOwnerAuthorization;
    readonly credentialExpiresAt: string;
    readonly smartContractAddress: typeof MONAD_MAINNET_NATIVE_USDC;
    readonly smartContractInterface: typeof TURNKEY_USDC_TRANSFER_INTERFACE;
    readonly authorization: WalletDelegatedAuthorization;
    readonly policyFor: (delegatedUserRef: string) => TurnkeyDelegatedPolicyDocument;
  }) => Effect.Effect<CustodyDelegatedAuthorization, WalletCustodyError>;
  readonly getDelegatedAccessConfiguration: (
    input: Parameters<WalletCustodyAdapter["getDelegatedAuthorizationStatus"]>[0],
  ) => Effect.Effect<CustodyDelegatedAuthorizationStatus, WalletCustodyError>;
  /** Revokes the delegated credential, delegated user, and policy as one idempotent workflow. */
  readonly revokeDelegatedAccess: (
    input: Parameters<WalletCustodyAdapter["revokeDelegatedAuthorization"]>[0],
  ) => Effect.Effect<CustodyDelegationRevocationStatus, WalletCustodyError>;
  readonly getDelegatedAccessRevocation: (
    input: Parameters<WalletCustodyAdapter["getDelegationRevocationStatus"]>[0],
  ) => Effect.Effect<CustodyDelegationRevocationStatus, WalletCustodyError>;
  readonly initEmailRecovery: (input: {
    readonly operationId: WalletOperationId;
    readonly recoveryAttemptId: WalletRecoveryAttemptId;
    readonly wallet: UserOwnedWallet;
    readonly material: WalletRecoveryInitiationMaterial;
  }) => Effect.Effect<CustodyRecoveryInitiation, WalletCustodyError>;
  readonly recoverUser: (input: {
    readonly operationId: WalletOperationId;
    readonly recoveryAttemptId: WalletRecoveryAttemptId;
    readonly wallet: UserOwnedWallet;
    readonly material: WalletRecoveryCompletionMaterial;
  }) => Effect.Effect<{ readonly providerActivityRef: string }, WalletCustodyError>;
  readonly submitUserUsdcTransfer: (
    input: Parameters<WalletCustodyAdapter["withdraw"]>[0],
  ) => Effect.Effect<WalletTransferResult, WalletCustodyError>;
  readonly submitDelegatedUsdcTransfer: (
    input: Parameters<WalletCustodyAdapter["charge"]>[0],
  ) => Effect.Effect<CustodyChargeSubmission, WalletCustodyError>;
  readonly getDelegatedUsdcTransferStatus: (
    input: Parameters<WalletCustodyAdapter["getChargeStatus"]>[0],
  ) => Effect.Effect<CustodyChargeStatus, WalletCustodyError>;
}

export interface TurnkeyProductionConfiguration {
  readonly apiBaseUrl: typeof TURNKEY_PRODUCTION_API_BASE_URL;
  readonly parentOrganizationId: string;
  readonly treasuryAddress: EvmAddress;
  /** Opaque KMS/secret-broker reference. It is not usable by sandbox workers. */
  readonly delegatedCredentialSecretRef: string;
  readonly timePoliciesEnabled: boolean;
  readonly gateway: TurnkeyWalletGateway;
  readonly now?: () => string;
}

const invalid = (operation: string, code: WalletCustodyError["code"] = "configurationInvalid") =>
  Effect.fail(new WalletCustodyError({ code, operation, retryable: false, outcome: "notApplied" }));

const exactBinding = (input: { readonly chainId: number; readonly tokenContract: string }) =>
  input.chainId === MONAD_MAINNET_CHAIN_ID &&
  input.tokenContract.toLowerCase() === MONAD_MAINNET_NATIVE_USDC.toLowerCase();

const isBefore = (left: string, right: string) => {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime < rightTime;
};

/**
 * Build the production adapter only from an already-authenticated gateway.
 * Passing no configuration is a supported deployment state and fails closed.
 */
export const makeTurnkeyWalletAdapter = (
  config?: TurnkeyProductionConfiguration,
): WalletCustodyAdapter => {
  if (config === undefined) return disabledTurnkeyWalletAdapter;
  const now = config.now ?? (() => DateTime.formatIso(DateTime.nowUnsafe()));
  const validateConfiguration = Effect.gen(function* () {
    if (
      config.apiBaseUrl !== TURNKEY_PRODUCTION_API_BASE_URL ||
      config.parentOrganizationId.trim().length === 0 ||
      config.delegatedCredentialSecretRef.trim().length === 0 ||
      !/^0x[0-9a-fA-F]{40}$/.test(config.treasuryAddress)
    ) {
      return yield* invalid("validate-configuration");
    }
    yield* config.gateway.validate;
  });
  const validateAuthorization = (authorization: WalletDelegatedAuthorization) =>
    Effect.gen(function* () {
      if (
        authorization.treasuryAddress.toLowerCase() !== config.treasuryAddress.toLowerCase() ||
        !exactBinding(authorization.binding) ||
        authorization.perChargeLimitMicroUsdc <= 0 ||
        authorization.dailyLimitMicroUsdc < authorization.perChargeLimitMicroUsdc ||
        !isBefore(authorization.startsAt, authorization.expiresAt)
      ) {
        return yield* invalid("validate-delegated-authorization", "policyRejected");
      }
    });
  return {
    provider: "turnkey",
    validateConfiguration,
    provision: (input) =>
      validateConfiguration.pipe(
        Effect.andThen(
          config.gateway.createSubOrganizationWallet({
            operationId: input.operationId,
            parentOrganizationId: config.parentOrganizationId,
            subOrganizationName: `agentsin-${input.workspaceId}-${input.operationId}`,
            ownerUserId: input.ownerUserId,
            material: input.material,
            account: {
              curve: "CURVE_SECP256K1",
              pathFormat: "PATH_FORMAT_BIP32",
              path: "m/44'/60'/0'/0/0",
              addressFormat: "ADDRESS_FORMAT_ETHEREUM",
            },
            recovery: { emailEnabled: true, passkeyRequired: true },
          }),
        ),
      ),
    configureDelegatedAuthorization: (input) =>
      validateConfiguration.pipe(
        Effect.andThen(validateAuthorization(input.authorization)),
        Effect.andThen(
          config.gateway.configureDelegatedAccess({
            operationId: input.operationId,
            wallet: input.wallet,
            ownerAuthorization: input.ownerAuthorization,
            credentialExpiresAt: input.authorization.expiresAt,
            smartContractAddress: MONAD_MAINNET_NATIVE_USDC,
            smartContractInterface: TURNKEY_USDC_TRANSFER_INTERFACE,
            authorization: input.authorization,
            policyFor: (delegatedUserRef) =>
              compileTurnkeyDelegatedUsdcPolicy({
                delegatedUserRef,
                authorization: input.authorization,
                timePoliciesEnabled: config.timePoliciesEnabled,
              }),
          }),
        ),
      ),
    getDelegatedAuthorizationStatus: (input) =>
      validateConfiguration.pipe(
        Effect.andThen(validateAuthorization(input.authorization)),
        Effect.andThen(config.gateway.getDelegatedAccessConfiguration(input)),
      ),
    revokeDelegatedAuthorization: (input) =>
      validateConfiguration.pipe(
        Effect.andThen(
          input.authorization.providerPolicyRef !== undefined &&
            input.authorization.providerDelegatedUserRef !== undefined &&
            input.authorization.providerDelegatedCredentialRef !== undefined
            ? config.gateway.revokeDelegatedAccess(input)
            : invalid("revoke-delegated-access", "policyRejected"),
        ),
      ),
    getDelegationRevocationStatus: (input) =>
      validateConfiguration.pipe(
        Effect.andThen(
          input.authorization.providerPolicyRef !== undefined &&
            input.authorization.providerDelegatedUserRef !== undefined &&
            input.authorization.providerDelegatedCredentialRef !== undefined
            ? config.gateway.getDelegatedAccessRevocation(input)
            : invalid("get-delegated-access-revocation", "policyRejected"),
        ),
      ),
    beginRecovery: (input) =>
      validateConfiguration.pipe(Effect.andThen(config.gateway.initEmailRecovery(input))),
    completeRecovery: (input) =>
      validateConfiguration.pipe(Effect.andThen(config.gateway.recoverUser(input))),
    withdraw: (input) =>
      validateConfiguration.pipe(
        Effect.andThen(
          exactBinding(input.binding)
            ? config.gateway.submitUserUsdcTransfer(input)
            : invalid("withdraw-binding"),
        ),
      ),
    charge: (input) =>
      validateConfiguration.pipe(
        Effect.andThen(validateAuthorization(input.authorization)),
        Effect.andThen(
          input.destination.toLowerCase() === config.treasuryAddress.toLowerCase() &&
            input.amountMicroUsdc > 0 &&
            input.amountMicroUsdc <= input.authorization.perChargeLimitMicroUsdc &&
            !isBefore(input.submittedAt, input.authorization.startsAt) &&
            isBefore(input.submittedAt, input.authorization.expiresAt) &&
            isBefore(now(), input.authorization.expiresAt) &&
            exactBinding(input.binding)
            ? config.gateway.submitDelegatedUsdcTransfer(input)
            : invalid("charge-policy", "policyRejected"),
        ),
      ),
    getChargeStatus: (input) =>
      validateConfiguration.pipe(
        Effect.andThen(validateAuthorization(input.authorization)),
        Effect.andThen(config.gateway.getDelegatedUsdcTransferStatus(input)),
      ),
  };
};
