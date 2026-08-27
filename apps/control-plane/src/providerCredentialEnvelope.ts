// @effect-diagnostics nodeBuiltinImport:off -- Envelope encryption is an audited Node crypto boundary.
import * as NodeCrypto from "node:crypto";

import type { AgentProfileId, WorkspaceId } from "@t3tools/contracts/cloud";
import type { ProviderInstanceRef } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { Secret } from "./providerSecrets.ts";

const ENVELOPE_VERSION = 1 as const;
const DEK_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
export const MAX_PROVIDER_PROFILE_BYTES = 1024 * 1024;

export interface ProviderCredentialEnvelopeContext {
  readonly workspaceId: WorkspaceId;
  readonly profileId: AgentProfileId;
  readonly provider: ProviderInstanceRef;
}

export const providerCredentialEnvelopeAad = (
  context: ProviderCredentialEnvelopeContext,
  keyVersion: string,
): Uint8Array =>
  Buffer.from(
    [
      "agents-in-cloud/provider-profile",
      "1",
      context.workspaceId,
      context.profileId,
      context.provider.instanceId,
      context.provider.driver,
      keyVersion,
    ]
      .map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`)
      .join("|"),
    "utf8",
  );

export interface WrappedDataEncryptionKey {
  readonly keyVersion: string;
  readonly wrappedKey: Uint8Array;
}

/** Deployment adapter backed by a non-exportable KMS key-encryption key. */
export interface ProviderCredentialKeyEncryption {
  /** Deployment KMS key identity; raw KEK material is never accepted. */
  readonly kmsKeyId: string;
  readonly activeKeyVersion: string;
  readonly wrap: (
    dataEncryptionKey: Secret<Uint8Array>,
    context: ProviderCredentialEnvelopeContext,
  ) => Effect.Effect<WrappedDataEncryptionKey, ProviderCredentialEnvelopeError>;
  readonly unwrap: (
    wrapped: WrappedDataEncryptionKey,
    context: ProviderCredentialEnvelopeContext,
  ) => Effect.Effect<Secret<Uint8Array>, ProviderCredentialEnvelopeError>;
}

export interface ProviderCredentialEnvelope {
  readonly envelopeVersion: typeof ENVELOPE_VERSION;
  readonly keyVersion: string;
  readonly wrappedKey: Uint8Array;
  readonly nonce: Uint8Array;
  readonly authTag: Uint8Array;
  readonly ciphertext: Uint8Array;
}

export const isProviderCredentialEnvelopeMetadataValid = (envelope: ProviderCredentialEnvelope) =>
  envelope.envelopeVersion === ENVELOPE_VERSION &&
  envelope.keyVersion.trim().length >= 1 &&
  envelope.keyVersion.length <= 256 &&
  envelope.wrappedKey.byteLength >= DEK_BYTES &&
  envelope.wrappedKey.byteLength <= 16_384 &&
  envelope.nonce.byteLength === NONCE_BYTES &&
  envelope.authTag.byteLength === TAG_BYTES &&
  envelope.ciphertext.byteLength >= 1 &&
  envelope.ciphertext.byteLength <= MAX_PROVIDER_PROFILE_BYTES;

export interface ProviderCredentialCrypto {
  readonly randomBytes: (length: number) => Uint8Array;
  readonly encrypt: (input: {
    readonly key: Uint8Array;
    readonly nonce: Uint8Array;
    readonly aad: Uint8Array;
    readonly plaintext: Uint8Array;
  }) => { readonly ciphertext: Uint8Array; readonly authTag: Uint8Array };
  readonly decrypt: (input: {
    readonly key: Uint8Array;
    readonly nonce: Uint8Array;
    readonly aad: Uint8Array;
    readonly authTag: Uint8Array;
    readonly ciphertext: Uint8Array;
  }) => Uint8Array;
}

export const nodeProviderCredentialCrypto: ProviderCredentialCrypto = {
  randomBytes: NodeCrypto.randomBytes,
  encrypt: ({ key, nonce, aad, plaintext }) => {
    const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, nonce, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(aad);
    return {
      ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]),
      authTag: cipher.getAuthTag(),
    };
  },
  decrypt: ({ key, nonce, aad, authTag, ciphertext }) => {
    const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  },
};

export class ProviderCredentialEnvelopeError extends Schema.TaggedErrorClass<ProviderCredentialEnvelopeError>()(
  "ProviderCredentialEnvelopeError",
  {
    code: Schema.Literals(["invalidPayload", "keyUnavailable", "integrityFailure"]),
    operation: Schema.String,
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {}

const wipe = (value: Secret<Uint8Array>) =>
  Effect.sync(() => value.withValue((bytes) => bytes.fill(0)));

export const sealProviderCredentialPayload = (input: {
  readonly plaintext: Secret<Uint8Array>;
  readonly context: ProviderCredentialEnvelopeContext;
  readonly keyEncryption: ProviderCredentialKeyEncryption;
  readonly crypto?: ProviderCredentialCrypto;
}): Effect.Effect<ProviderCredentialEnvelope, ProviderCredentialEnvelopeError> =>
  Effect.suspend(() => {
    const bytes = input.plaintext.withValue((value) => value);
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_PROVIDER_PROFILE_BYTES) {
      return Effect.fail(
        new ProviderCredentialEnvelopeError({
          code: "invalidPayload",
          operation: "seal",
        }),
      );
    }
    const crypto = input.crypto ?? nodeProviderCredentialCrypto;
    const dek = Secret.make(crypto.randomBytes(DEK_BYTES));
    return Effect.gen(function* () {
      const wrapped = yield* input.keyEncryption.wrap(dek, input.context);
      if (wrapped.keyVersion !== input.keyEncryption.activeKeyVersion) {
        return yield* new ProviderCredentialEnvelopeError({
          code: "keyUnavailable",
          operation: "seal-key-version",
        });
      }
      return yield* Effect.try({
        try: () =>
          dek.withValue((key): ProviderCredentialEnvelope => {
            const nonce = crypto.randomBytes(NONCE_BYTES);
            const aad = providerCredentialEnvelopeAad(input.context, wrapped.keyVersion);
            try {
              const encrypted = crypto.encrypt({ key, nonce, aad, plaintext: bytes });
              return {
                envelopeVersion: ENVELOPE_VERSION,
                keyVersion: wrapped.keyVersion,
                wrappedKey: wrapped.wrappedKey,
                nonce,
                authTag: encrypted.authTag,
                ciphertext: encrypted.ciphertext,
              };
            } finally {
              aad.fill(0);
            }
          }),
        catch: (cause) =>
          new ProviderCredentialEnvelopeError({
            code: "integrityFailure",
            operation: "seal",
            cause,
          }),
      });
    }).pipe(Effect.ensuring(wipe(dek)));
  }).pipe(Effect.ensuring(wipe(input.plaintext)));

export const openProviderCredentialPayload = (input: {
  readonly envelope: ProviderCredentialEnvelope;
  readonly context: ProviderCredentialEnvelopeContext;
  readonly keyEncryption: ProviderCredentialKeyEncryption;
  readonly crypto?: ProviderCredentialCrypto;
}): Effect.Effect<Secret<Uint8Array>, ProviderCredentialEnvelopeError> =>
  Effect.gen(function* () {
    if (
      input.envelope.envelopeVersion !== ENVELOPE_VERSION ||
      input.envelope.nonce.byteLength !== NONCE_BYTES ||
      input.envelope.authTag.byteLength !== TAG_BYTES ||
      input.envelope.ciphertext.byteLength < 1 ||
      input.envelope.ciphertext.byteLength > MAX_PROVIDER_PROFILE_BYTES
    ) {
      return yield* new ProviderCredentialEnvelopeError({
        code: "integrityFailure",
        operation: "validate-envelope",
      });
    }
    const dek = yield* input.keyEncryption.unwrap(
      { keyVersion: input.envelope.keyVersion, wrappedKey: input.envelope.wrappedKey },
      input.context,
    );
    return yield* Effect.try({
      try: () =>
        dek.withValue((key) => {
          const crypto = input.crypto ?? nodeProviderCredentialCrypto;
          const aad = providerCredentialEnvelopeAad(input.context, input.envelope.keyVersion);
          try {
            const plaintext = crypto.decrypt({
              key,
              nonce: input.envelope.nonce,
              aad,
              authTag: input.envelope.authTag,
              ciphertext: input.envelope.ciphertext,
            });
            return Secret.make<Uint8Array>(plaintext);
          } finally {
            aad.fill(0);
          }
        }),
      catch: (cause) =>
        new ProviderCredentialEnvelopeError({
          code: "integrityFailure",
          operation: "open",
          cause,
        }),
    }).pipe(Effect.ensuring(wipe(dek)));
  });
