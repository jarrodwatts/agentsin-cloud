// @effect-diagnostics nodeBuiltinImport:off -- AES-GCM seals provider bytes at the Node mTLS relay boundary.
import * as NodeCrypto from "node:crypto";

import {
  consumeCredentialBinaryFrame,
  credentialBinaryAad,
  encodeCredentialBinaryFrame,
  type CredentialBinaryHeader,
  type CredentialBinaryKind,
} from "@t3tools/contracts/credential-binary";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;

const assertKey = (key: Uint8Array) => {
  if (key.byteLength !== KEY_BYTES) throw new Error("invalid credential channel key");
};

const fromHex = (value: string, bytes: number) => {
  const decoded = Buffer.from(value, "hex");
  if (decoded.byteLength !== bytes) {
    decoded.fill(0);
    throw new Error("invalid credential frame cryptographic metadata");
  }
  return decoded;
};

/** Caller owns and must wipe both the plaintext input and returned frame. */
export const sealCredentialBinaryFrame = (input: {
  readonly key: Uint8Array;
  readonly kind: CredentialBinaryKind;
  readonly operationId: string;
  readonly routeGeneration: number;
  readonly control: unknown;
  readonly plaintext: Uint8Array;
}): Uint8Array => {
  assertKey(input.key);
  const nonce = NodeCrypto.randomBytes(NONCE_BYTES);
  const aad = credentialBinaryAad(input);
  const chunks: Array<Buffer> = [];
  let ciphertext: Buffer | undefined;
  try {
    const cipher = NodeCrypto.createCipheriv("aes-256-gcm", input.key, nonce);
    cipher.setAAD(aad);
    chunks.push(cipher.update(input.plaintext), cipher.final());
    ciphertext = Buffer.concat(chunks);
    const authTag = cipher.getAuthTag();
    try {
      return encodeCredentialBinaryFrame(
        {
          kind: input.kind,
          operationId: input.operationId,
          routeGeneration: input.routeGeneration,
          control: input.control,
          nonceHex: nonce.toString("hex"),
          authTagHex: authTag.toString("hex"),
        },
        ciphertext,
      );
    } finally {
      authTag.fill(0);
    }
  } finally {
    aad.fill(0);
    nonce.fill(0);
    for (const chunk of chunks) chunk.fill(0);
    ciphertext?.fill(0);
  }
};

/** Decoding consumes and wipes the encrypted frame. Caller owns and must wipe plaintext. */
export const openCredentialBinaryFrame = (input: {
  readonly key: Uint8Array;
  readonly frame: Uint8Array;
}): { readonly header: CredentialBinaryHeader; readonly plaintext: Uint8Array } => {
  assertKey(input.key);
  const decoded = consumeCredentialBinaryFrame(input.frame);
  const nonce = fromHex(decoded.header.nonceHex, NONCE_BYTES);
  const authTag = fromHex(decoded.header.authTagHex, 16);
  const aad = credentialBinaryAad({
    kind: decoded.header.kind,
    operationId: decoded.header.operationId,
    routeGeneration: decoded.header.routeGeneration,
    control: decoded.header.control,
  });
  const chunks: Array<Buffer> = [];
  let plaintext: Buffer | undefined;
  try {
    const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", input.key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    chunks.push(decipher.update(decoded.payload), decipher.final());
    plaintext = Buffer.concat(chunks);
    return { header: decoded.header, plaintext };
  } catch (cause) {
    plaintext?.fill(0);
    throw cause;
  } finally {
    decoded.payload.fill(0);
    aad.fill(0);
    nonce.fill(0);
    authTag.fill(0);
    for (const chunk of chunks) {
      if (chunk !== plaintext) chunk.fill(0);
    }
  }
};
