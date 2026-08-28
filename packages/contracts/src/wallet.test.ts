import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  MONAD_USDC_BINDING,
  UserOwnedWallet,
  WalletDelegatedAuthorization,
  WalletDelegatedSpendReservation,
  WalletProviderEffectEvidence,
  WalletWithdrawalRequest,
} from "./wallet.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const walletId = "wallet-a";
const decodeUserOwnedWallet = Schema.decodeUnknownSync(UserOwnedWallet);
const decodeDelegatedAuthorization = Schema.decodeUnknownSync(WalletDelegatedAuthorization);
const decodeWithdrawalRequest = Schema.decodeUnknownSync(WalletWithdrawalRequest);
const decodeSpendReservation = Schema.decodeUnknownSync(WalletDelegatedSpendReservation);
const decodeProviderEvidence = Schema.decodeUnknownSync(WalletProviderEffectEvidence);

describe("wallet contracts", () => {
  it("decodes safe user-owned wallet metadata without credential fields", () => {
    const wallet = decodeUserOwnedWallet({
      schemaVersion: 1,
      walletId,
      workspaceId,
      ownerUserId: "user-a",
      provider: "turnkey",
      providerOrganizationRef: "org-a",
      providerWalletRef: "provider-wallet-a",
      address: "0x1111111111111111111111111111111111111111",
      state: "active",
      recoveryMethod: "passkeyAndEmail",
      recoveryEnabled: true,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    });
    expect(wallet.provider).toBe("turnkey");
    expect(Object.keys(wallet)).not.toEqual(
      expect.arrayContaining(["privateKey", "credential", "secret", "mnemonic"]),
    );
  });

  it("rejects a delegated authorization without bounded positive spend", () => {
    const base = {
      authorizationId: "authorization-a",
      walletId,
      workspaceId,
      binding: MONAD_USDC_BINDING,
      treasuryAddress: "0x2222222222222222222222222222222222222222",
      perChargeLimitMicroUsdc: 250_000,
      dailyLimitMicroUsdc: 1_000_000,
      startsAt: "2026-08-28T00:00:00.000Z",
      expiresAt: "2026-09-28T00:00:00.000Z",
      policyRevision: 1,
      state: "pending",
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    };
    expect(decodeDelegatedAuthorization(base)).toMatchObject({ perChargeLimitMicroUsdc: 250_000 });
    expect(() =>
      decodeDelegatedAuthorization({ ...base, perChargeLimitMicroUsdc: 1_000_001 }),
    ).toThrow();
    expect(() => decodeDelegatedAuthorization({ ...base, expiresAt: base.startsAt })).toThrow();
    expect(() =>
      decodeDelegatedAuthorization({ ...base, expiresAt: "not-a-canonical-utc-time" }),
    ).toThrow();
  });

  it("binds withdrawal approval to the exact tenant, wallet, and fingerprint", () => {
    const approval = {
      approvalId: "approval-a",
      walletId,
      workspaceId,
      destination: "0x3333333333333333333333333333333333333333",
      amountMicroUsdc: 100_000,
      approvedByUserId: "user-a",
      approvedByAuthSessionId: "session-a",
      approvedAt: "2026-08-28T00:00:00.000Z",
      expiresAt: "2026-08-28T00:05:00.000Z",
      requestFingerprint: "a".repeat(64),
    };
    expect(() =>
      decodeWithdrawalRequest({
        schemaVersion: 1,
        operationId: "operation-a",
        idempotencyKey: "withdraw-a",
        requestFingerprint: "b".repeat(64),
        workspaceId,
        walletId,
        approval,
        requestedAt: "2026-08-28T00:00:01.000Z",
      }),
    ).toThrow();
  });

  it("requires terminal provider evidence before a spend is submitted or released", () => {
    const reservation = {
      reservationId: "reservation-a",
      workspaceId,
      walletId,
      authorizationId: "authorization-a",
      utcDay: "2026-08-28",
      amountMicroUsdc: 100_000,
      state: "reserved",
      idempotencyKey: "reservation-once",
      requestFingerprint: "a".repeat(64),
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    };
    expect(decodeSpendReservation(reservation).state).toBe("reserved");
    expect(() => decodeSpendReservation({ ...reservation, state: "released" })).toThrow();
    expect(() =>
      decodeSpendReservation({
        ...reservation,
        state: "submitted",
        txHash: `0x${"b".repeat(64)}`,
        providerActivityRef: "activity-a",
        providerStatus: "stillUnknown",
        providerObservedAt: "2026-08-28T00:00:01.000Z",
      }),
    ).toThrow();
    expect(() =>
      decodeProviderEvidence({
        providerActivityRef: "activity-a",
        status: "applied",
        observedAt: "2026-08-28T00:00:01.000Z",
      }),
    ).toThrow();
    expect(
      decodeSpendReservation({
        ...reservation,
        state: "released",
        providerActivityRef: "activity-a",
        providerStatus: "notApplied",
        providerObservedAt: "2026-08-28T00:00:01.000Z",
      }).state,
    ).toBe("released");
  });

  it("rejects excess fields that could smuggle credential material", () => {
    expect(() =>
      decodeUserOwnedWallet({
        schemaVersion: 1,
        walletId,
        workspaceId,
        ownerUserId: "user-a",
        provider: "turnkey",
        providerOrganizationRef: "org-a",
        providerWalletRef: "provider-wallet-a",
        address: "0x1111111111111111111111111111111111111111",
        state: "active",
        recoveryMethod: "passkeyAndEmail",
        recoveryEnabled: true,
        createdAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T00:00:00.000Z",
        privateKey: "must-not-cross-the-wire",
      }),
    ).toThrow();
  });
});
