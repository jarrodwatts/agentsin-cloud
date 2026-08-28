import type { EvmAddress, MicroUsdc, WorkspaceId } from "@t3tools/contracts/cloud";
import {
  MONAD_USDC_BINDING,
  type UserOwnedWallet,
  type WalletDelegatedAuthorization,
  type WalletOperationId,
} from "@t3tools/contracts/wallet";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeFakeWalletCustodyAdapter, WalletCustodyError } from "./walletCustodyAdapter.ts";
import { Secret, redactProviderLogFields } from "./providerSecrets.ts";
import {
  compileTurnkeyDelegatedUsdcPolicy,
  makeTurnkeyWalletAdapter,
  TURNKEY_PRODUCTION_API_BASE_URL,
  type TurnkeyWalletGateway,
} from "./walletTurnkey.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111" as WorkspaceId;
const treasury = "0x1111111111111111111111111111111111111111" as EvmAddress;
const operationId = "wallet-operation-a" as WalletOperationId;
const now = "2026-08-28T12:00:00.000Z";

const wallet: UserOwnedWallet = {
  schemaVersion: 1,
  walletId: "wallet-a" as UserOwnedWallet["walletId"],
  workspaceId,
  ownerUserId: "user-a",
  provider: "turnkey",
  providerOrganizationRef: "organization-a",
  providerWalletRef: "wallet-ref-a",
  address: "0x2222222222222222222222222222222222222222" as EvmAddress,
  state: "active",
  recoveryMethod: "passkeyAndEmail",
  recoveryEnabled: true,
  createdAt: now,
  updatedAt: now,
};

const authorization: WalletDelegatedAuthorization = {
  authorizationId: "authorization-a" as WalletDelegatedAuthorization["authorizationId"],
  walletId: wallet.walletId,
  workspaceId,
  binding: MONAD_USDC_BINDING,
  treasuryAddress: treasury,
  perChargeLimitMicroUsdc: 250_000 as MicroUsdc,
  dailyLimitMicroUsdc: 1_000_000 as MicroUsdc,
  startsAt: "2026-08-28T00:00:00.000Z",
  expiresAt: "2026-08-29T00:00:00.000Z",
  policyRevision: 1,
  state: "active",
  createdAt: now,
  updatedAt: now,
};

const makeGateway = (captured: Array<unknown>): TurnkeyWalletGateway => ({
  validate: Effect.void,
  createSubOrganizationWallet: (input) => {
    captured.push(input);
    return Effect.succeed({
      providerOrganizationRef: "organization-a",
      providerWalletRef: "wallet-ref-a",
      address: wallet.address,
      providerActivityRef: "activity-a",
    });
  },
  configureDelegatedAccess: (input) => {
    captured.push(input);
    return Effect.succeed({
      providerPolicyRef: "policy-a",
      providerDelegatedUserRef: "delegated-user-a",
      providerDelegatedCredentialRef: "credential-a",
      providerActivityRef: "activity-a",
    });
  },
  getDelegatedAccessConfiguration: (input) => {
    captured.push(input);
    return Effect.succeed({
      status: "applied",
      observedAt: input.observedAt,
      providerActivityRef: input.providerActivityRef ?? "activity-a",
      providerPolicyRef: "policy-a",
      providerDelegatedUserRef: "delegated-user-a",
      providerDelegatedCredentialRef: "credential-a",
    });
  },
  revokeDelegatedAccess: (input) => {
    captured.push(input);
    return Effect.succeed({
      providerActivityRef: `revoke-${input.operationId}`,
      status: "applied",
      observedAt: input.requestedAt,
    });
  },
  getDelegatedAccessRevocation: (input) => {
    captured.push(input);
    return Effect.succeed({
      providerActivityRef: input.providerActivityRef,
      status: "applied",
      observedAt: input.observedAt,
    });
  },
  initEmailRecovery: () =>
    Effect.succeed({ providerActivityRef: "recovery-a", expiresAt: authorization.expiresAt }),
  recoverUser: () => Effect.succeed({ providerActivityRef: "recovery-a" }),
  submitUserUsdcTransfer: () => Effect.die(new Error("user transfer is outside this test")),
  submitDelegatedUsdcTransfer: () =>
    Effect.die(new Error("delegated transfer is outside this test")),
  getDelegatedUsdcTransferStatus: () =>
    Effect.die(new Error("delegated transfer status is outside this test")),
});

const productionAdapter = (captured: Array<unknown>, timePoliciesEnabled = false) =>
  makeTurnkeyWalletAdapter({
    apiBaseUrl: TURNKEY_PRODUCTION_API_BASE_URL,
    parentOrganizationId: "parent-organization",
    treasuryAddress: treasury,
    delegatedCredentialSecretRef: "kms://wallet/delegated-credential",
    timePoliciesEnabled,
    gateway: makeGateway(captured),
    now: () => now,
  });

it.effect("fails closed when production Turnkey configuration is absent", () =>
  Effect.gen(function* () {
    const adapter = makeTurnkeyWalletAdapter();
    const error = yield* Effect.flip(adapter.validateConfiguration);
    expect(error).toBeInstanceOf(WalletCustodyError);
    expect(error.code).toBe("configurationMissing");
    expect(error.outcome).toBe("notApplied");
  }),
);

it("compiles an exact Monad USDC transfer policy and gates optional Turnkey time policies", () => {
  const policy = compileTurnkeyDelegatedUsdcPolicy({
    delegatedUserRef: "delegated-user-a",
    authorization,
    timePoliciesEnabled: false,
  });
  expect(policy.condition).toContain("activity.kind == 'SIGN_TRANSACTION'");
  expect(policy.condition).toContain("eth.tx.chain_id == 143");
  expect(policy.condition).toContain(MONAD_USDC_BINDING.tokenContract);
  expect(policy.condition).toContain("eth.tx.value == 0");
  expect(policy.condition).toContain("eth.tx.function_name == 'transfer'");
  expect(policy.condition).toContain(`['dst'] == '${treasury}'`);
  expect(policy.condition).toContain("['wad'] <= 250000");
  expect(policy.time).toBeUndefined();

  const timeBound = compileTurnkeyDelegatedUsdcPolicy({
    delegatedUserRef: "delegated-user-a",
    authorization,
    timePoliciesEnabled: true,
  });
  expect(timeBound.time).toContain(authorization.startsAt);
  expect(timeBound.time).toContain(authorization.expiresAt);
});

it.effect(
  "requests a user sub-organization, passkey/email recovery, and one Ethereum account",
  () =>
    Effect.gen(function* () {
      const captured: Array<unknown> = [];
      const recoveryEmail = Secret.make("wallet-owner@example.test");
      const passkeyRegistration = Secret.make<Uint8Array>(new Uint8Array([1, 2, 3]));
      const stamp = Secret.make<Uint8Array>(new Uint8Array([4, 5, 6]));
      yield* productionAdapter(captured).provision({
        operationId,
        workspaceId,
        ownerUserId: "user-a",
        material: { recoveryEmail, passkeyRegistration, stamp },
      });
      const input = captured[0] as {
        readonly account: { readonly path: string; readonly addressFormat: string };
        readonly recovery: { readonly emailEnabled: boolean; readonly passkeyRequired: boolean };
      };
      expect(input.account).toEqual({
        curve: "CURVE_SECP256K1",
        pathFormat: "PATH_FORMAT_BIP32",
        path: "m/44'/60'/0'/0/0",
        addressFormat: "ADDRESS_FORMAT_ETHEREUM",
      });
      expect(input.recovery).toEqual({ emailEnabled: true, passkeyRequired: true });
    }),
);

it.effect("binds delegated credentials to authorization expiry and exact USDC policy inputs", () =>
  Effect.gen(function* () {
    const captured: Array<unknown> = [];
    yield* productionAdapter(captured).configureDelegatedAuthorization({
      operationId,
      wallet,
      authorization,
      ownerAuthorization: { stamp: Secret.make<Uint8Array>(new Uint8Array([7])) },
    });
    const input = captured[0] as {
      readonly credentialExpiresAt: string;
      readonly smartContractAddress: string;
      readonly policyFor: (ref: string) => { readonly condition: string };
    };
    expect(input.credentialExpiresAt).toBe(authorization.expiresAt);
    expect(input.smartContractAddress).toBe(MONAD_USDC_BINDING.tokenContract);
    expect(input.policyFor("delegated-a").condition).toContain(`['dst'] == '${treasury}'`);
  }),
);

it.effect("requires persisted delegated provider references for idempotent revocation", () =>
  Effect.gen(function* () {
    const captured: Array<unknown> = [];
    const adapter = productionAdapter(captured);
    const persistedAuthorization: WalletDelegatedAuthorization = {
      ...authorization,
      providerPolicyRef: "policy-a",
      providerDelegatedUserRef: "delegated-user-a",
      providerDelegatedCredentialRef: "credential-a",
    };
    const result = yield* adapter.revokeDelegatedAuthorization({
      operationId,
      wallet,
      authorization: persistedAuthorization,
      requestedAt: now,
    });
    expect(result.status).toBe("applied");
    expect(captured[0]).toMatchObject({
      operationId,
      authorization: {
        providerPolicyRef: "policy-a",
        providerDelegatedUserRef: "delegated-user-a",
        providerDelegatedCredentialRef: "credential-a",
      },
    });

    const rejected = yield* Effect.flip(
      adapter.revokeDelegatedAuthorization({
        operationId,
        wallet,
        authorization,
        requestedAt: now,
      }),
    );
    expect(rejected.code).toBe("policyRejected");
    expect(captured).toHaveLength(1);
  }),
);

it.effect("reconciles a lost delegation response by the original provider operation", () =>
  Effect.gen(function* () {
    const captured: Array<unknown> = [];
    const result = yield* productionAdapter(captured).getDelegatedAuthorizationStatus({
      operationId,
      wallet,
      authorization,
      observedAt: now,
    });
    expect(result).toMatchObject({
      status: "applied",
      providerActivityRef: "activity-a",
      providerDelegatedCredentialRef: "credential-a",
    });
    expect(captured[0]).toMatchObject({ operationId, wallet, authorization });
  }),
);

it.effect("rejects a delegated authorization for a different treasury", () =>
  Effect.gen(function* () {
    const badAuthorization = {
      ...authorization,
      treasuryAddress: "0x3333333333333333333333333333333333333333" as EvmAddress,
    };
    const error = yield* Effect.flip(
      productionAdapter([]).configureDelegatedAuthorization({
        operationId,
        wallet,
        authorization: badAuthorization,
        ownerAuthorization: { stamp: Secret.make<Uint8Array>(new Uint8Array([8])) },
      }),
    );
    expect(error.code).toBe("policyRejected");
  }),
);

it.effect("keeps deterministic adapter call records and log redaction free of wallet secrets", () =>
  Effect.gen(function* () {
    const adapter = makeFakeWalletCustodyAdapter();
    yield* adapter.provision({
      operationId,
      workspaceId,
      ownerUserId: "user-a",
      material: {
        recoveryEmail: Secret.make("wallet-owner@example.test"),
        passkeyRegistration: Secret.make<Uint8Array>(new Uint8Array([1, 2, 3])),
        stamp: Secret.make<Uint8Array>(new Uint8Array([4, 5, 6])),
      },
    });
    expect(adapter.calls[0]).toEqual({ operation: "provision", operationId, workspaceId });
    const redacted = redactProviderLogFields({
      email: "wallet-owner@example.test",
      stamp: "opaque-stamp",
      recoveryBundle: "opaque-bundle",
      workspaceId,
    });
    expect(redacted.email).toBe("[REDACTED]");
    expect(redacted.stamp).toBe("[REDACTED]");
    expect(redacted.recoveryBundle).toBe("[REDACTED]");
    expect(redacted.workspaceId).toBe(workspaceId);
  }),
);
