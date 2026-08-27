// @effect-diagnostics nodeBuiltinImport:off -- Test KMS uses local crypto only for deterministic seam coverage.
import * as NodeCrypto from "node:crypto";

import type { ProviderInstanceRef } from "@t3tools/contracts";
import type { AgentProfileId, WorkspaceId } from "@t3tools/contracts/cloud";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  openProviderCredentialPayload,
  ProviderCredentialEnvelopeError,
  sealProviderCredentialPayload,
  type ProviderCredentialEnvelopeContext,
  type ProviderCredentialCrypto,
  type ProviderCredentialKeyEncryption,
} from "./providerCredentialEnvelope.ts";
import { Secret, redactProviderLogFields } from "./providerSecrets.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111" as WorkspaceId;
const profileId = "profile-a" as AgentProfileId;
const provider = { instanceId: "codex_work", driver: "codex" } as ProviderInstanceRef;
const context: ProviderCredentialEnvelopeContext = { workspaceId, profileId, provider };
const kmsAad = (value: ProviderCredentialEnvelopeContext) =>
  Buffer.from(
    [value.workspaceId, value.profileId, value.provider.instanceId, value.provider.driver]
      .map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`)
      .join("|"),
  );

const testKeyEncryption = (
  version = "test-v1",
  key = NodeCrypto.randomBytes(32),
): ProviderCredentialKeyEncryption => ({
  kmsKeyId: "test-kms-key",
  activeKeyVersion: version,
  wrap: (dek, envelopeContext) =>
    Effect.sync(() =>
      dek.withValue((bytes) => {
        const nonce = NodeCrypto.randomBytes(12);
        const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, nonce);
        cipher.setAAD(kmsAad(envelopeContext));
        const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
        return {
          keyVersion: version,
          wrappedKey: Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]),
        };
      }),
    ),
  unwrap: (wrapped, envelopeContext) =>
    wrapped.keyVersion !== version
      ? Effect.fail(
          new ProviderCredentialEnvelopeError({
            code: "keyUnavailable",
            operation: "test-unwrap",
          }),
        )
      : Effect.try({
          try: () => {
            const nonce = wrapped.wrappedKey.slice(0, 12);
            const tag = wrapped.wrappedKey.slice(12, 28);
            const ciphertext = wrapped.wrappedKey.slice(28);
            const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, nonce);
            decipher.setAAD(kmsAad(envelopeContext));
            decipher.setAuthTag(tag);
            return Secret.make<Uint8Array>(
              Buffer.concat([decipher.update(ciphertext), decipher.final()]),
            );
          },
          catch: (cause) =>
            new ProviderCredentialEnvelopeError({
              code: "integrityFailure",
              operation: "test-unwrap",
              cause,
            }),
        }),
});

it.effect("round-trips an opaque profile through a separately wrapped per-profile DEK", () =>
  Effect.gen(function* () {
    const keyEncryption = testKeyEncryption();
    const plaintext = Buffer.from('{"access_token":"super-secret-token"}');
    const envelope = yield* sealProviderCredentialPayload({
      plaintext: Secret.make<Uint8Array>(plaintext),
      context,
      keyEncryption,
    });
    expect(plaintext.every((byte) => byte === 0)).toBe(true);
    const opened = yield* openProviderCredentialPayload({ envelope, context, keyEncryption });
    expect(opened.withValue((bytes) => Buffer.from(bytes).toString("utf8"))).toBe(
      '{"access_token":"super-secret-token"}',
    );
  }),
);

it.effect("fails closed for tampering, context swaps, and stale KMS key versions", () =>
  Effect.gen(function* () {
    const keyEncryption = testKeyEncryption();
    const envelope = yield* sealProviderCredentialPayload({
      plaintext: Secret.make<Uint8Array>(Buffer.from("opaque-profile")),
      context,
      keyEncryption,
    });
    const tampered = {
      ...envelope,
      ciphertext: Uint8Array.from(envelope.ciphertext, (byte, index) =>
        index === 0 ? byte ^ 1 : byte,
      ),
    };
    expect(
      (yield* Effect.exit(
        openProviderCredentialPayload({ envelope: tampered, context, keyEncryption }),
      ))._tag,
    ).toBe("Failure");
    expect(
      (yield* Effect.exit(
        openProviderCredentialPayload({
          envelope,
          context: { ...context, profileId: "profile-b" as AgentProfileId },
          keyEncryption,
        }),
      ))._tag,
    ).toBe("Failure");
    expect(
      (yield* Effect.exit(
        openProviderCredentialPayload({
          envelope: { ...envelope, keyVersion: "retired-v0" },
          context,
          keyEncryption,
        }),
      ))._tag,
    ).toBe("Failure");
  }),
);

it.effect("zeroizes DEKs across wrap, version, encrypt, and decrypt failures", () =>
  Effect.gen(function* () {
    const observed: Array<Uint8Array> = [];
    const failingWrap: ProviderCredentialKeyEncryption = {
      kmsKeyId: "test-kms-key",
      activeKeyVersion: "test-v1",
      wrap: (dek) => {
        dek.withValue((bytes) => observed.push(bytes));
        return Effect.fail(
          new ProviderCredentialEnvelopeError({
            code: "keyUnavailable",
            operation: "test-wrap",
          }),
        );
      },
      unwrap: () => Effect.die("unused"),
    };
    yield* Effect.exit(
      sealProviderCredentialPayload({
        plaintext: Secret.make<Uint8Array>(Buffer.from("secret")),
        context,
        keyEncryption: failingWrap,
      }),
    );
    expect([...observed[0]!]).toEqual(Array.from({ length: 32 }, () => 0));

    const wrongVersion: ProviderCredentialKeyEncryption = {
      ...failingWrap,
      wrap: (dek) => {
        dek.withValue((bytes) => observed.push(bytes));
        return Effect.succeed({ keyVersion: "stale-v0", wrappedKey: new Uint8Array(32) });
      },
    };
    yield* Effect.exit(
      sealProviderCredentialPayload({
        plaintext: Secret.make<Uint8Array>(Buffer.from("secret")),
        context,
        keyEncryption: wrongVersion,
      }),
    );
    expect([...observed[1]!]).toEqual(Array.from({ length: 32 }, () => 0));

    const cryptoFailure: ProviderCredentialCrypto = {
      randomBytes: (length) => new Uint8Array(length).fill(7),
      encrypt: () => {
        throw new Error("encrypt failed");
      },
      decrypt: () => {
        throw new Error("decrypt failed");
      },
    };
    const wrapping: ProviderCredentialKeyEncryption = {
      ...wrongVersion,
      wrap: (dek) => {
        dek.withValue((bytes) => observed.push(bytes));
        return Effect.succeed({ keyVersion: "test-v1", wrappedKey: new Uint8Array(32) });
      },
      unwrap: () => {
        const bytes = new Uint8Array(32).fill(9);
        observed.push(bytes);
        return Effect.succeed(Secret.make<Uint8Array>(bytes));
      },
    };
    const encrypted = yield* Effect.exit(
      sealProviderCredentialPayload({
        plaintext: Secret.make<Uint8Array>(Buffer.from("secret")),
        context,
        keyEncryption: wrapping,
      }),
    );
    expect(encrypted._tag).toBe("Success");
    const failedSeal = yield* Effect.exit(
      sealProviderCredentialPayload({
        plaintext: Secret.make<Uint8Array>(Buffer.from("secret")),
        context,
        keyEncryption: wrapping,
        crypto: cryptoFailure,
      }),
    );
    expect(failedSeal._tag).toBe("Failure");
    expect([...observed.at(-1)!]).toEqual(Array.from({ length: 32 }, () => 0));

    const goodEnvelope = yield* sealProviderCredentialPayload({
      plaintext: Secret.make<Uint8Array>(Buffer.from("secret")),
      context,
      keyEncryption: testKeyEncryption(),
    });
    const failedOpen = yield* Effect.exit(
      openProviderCredentialPayload({
        envelope: goodEnvelope,
        context,
        keyEncryption: wrapping,
        crypto: cryptoFailure,
      }),
    );
    expect(failedOpen._tag).toBe("Failure");
    expect([...observed.at(-1)!]).toEqual(Array.from({ length: 32 }, () => 0));
  }),
);

it("redacts typed secrets and common credential forms without serializing plaintext", () => {
  const secret = Secret.make("provider-private-value");
  expect(String(secret)).toBe("[REDACTED]");
  expect(JSON.stringify(secret)).toBe('"[REDACTED]"');
  expect(
    redactProviderLogFields({
      credential: secret,
      nested: { authorization: "Bearer abc.def.ghi" },
      message: "Bearer abcdef 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }),
  ).toEqual({
    credential: "[REDACTED]",
    nested: { authorization: "[REDACTED]" },
    message: "[REDACTED] [REDACTED]",
  });
});

export { testKeyEncryption };
