import { expect, it } from "@effect/vitest";

import { openCredentialBinaryFrame, sealCredentialBinaryFrame } from "./credentialRelayCrypto.ts";

const control = {
  type: "provider.credentials.command",
  operation: "materialize",
  operationId: "materialization-1",
  routeGeneration: 7,
};

it("round-trips an operation-bound binary credential frame", () => {
  const key = new Uint8Array(32).fill(7);
  const plaintext = Buffer.from("opaque-provider-profile");
  const frame = sealCredentialBinaryFrame({
    key,
    kind: "materialize",
    operationId: "materialization-1",
    routeGeneration: 7,
    control,
    plaintext,
  });
  const encryptedCopy = frame.slice();
  expect(Buffer.from(encryptedCopy).includes(plaintext)).toBe(false);
  const opened = openCredentialBinaryFrame({ key, frame });
  expect(frame.every((byte) => byte === 0)).toBe(true);
  expect(opened.header.control).toEqual(control);
  expect(Buffer.from(opened.plaintext).toString("utf8")).toBe("opaque-provider-profile");
  opened.plaintext.fill(0);
  encryptedCopy.fill(0);
  plaintext.fill(0);
  key.fill(0);
});

it("rejects tampering and consumes the encrypted frame", () => {
  const key = new Uint8Array(32).fill(9);
  const frame = sealCredentialBinaryFrame({
    key,
    kind: "materialize",
    operationId: "materialization-2",
    routeGeneration: 1,
    control,
    plaintext: Buffer.from("credential"),
  });
  frame[frame.byteLength - 1]! ^= 1;
  expect(() => openCredentialBinaryFrame({ key, frame })).toThrow();
  expect(frame.every((byte) => byte === 0)).toBe(true);
  key.fill(0);
});

it("rejects an invalid TLS exporter key without consuming caller plaintext", () => {
  const plaintext = Buffer.from("credential");
  expect(() =>
    sealCredentialBinaryFrame({
      key: new Uint8Array(31),
      kind: "materialize",
      operationId: "materialization-3",
      routeGeneration: 1,
      control,
      plaintext,
    }),
  ).toThrow();
  expect(Buffer.from(plaintext).toString("utf8")).toBe("credential");
  plaintext.fill(0);
});
