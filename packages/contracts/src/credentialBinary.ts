/**
 * Mutable binary side-channel used only for provider credential bytes.
 * Structured routing metadata remains on the normal schema-validated relay.
 */
const MAGIC = new Uint8Array([0x41, 0x49, 0x43, 0x31]);
const PREFIX_BYTES = 12;
export const MAX_CREDENTIAL_BINARY_BYTES = 1024 * 1024;
export const MAX_CREDENTIAL_BINARY_HEADER_BYTES = 16 * 1024;
export const CREDENTIAL_CHANNEL_EXPORTER_LABEL = "EXPORTER-AgentsInCloud-ProviderCredentials-v1";

export type CredentialBinaryKind = "materialize";

export interface CredentialBinaryHeader {
  readonly version: 1;
  readonly kind: CredentialBinaryKind;
  readonly operationId: string;
  readonly routeGeneration: number;
  readonly payloadBytes: number;
  readonly control: unknown;
  readonly nonceHex: string;
  readonly authTagHex: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

const validHeader = (value: unknown): value is CredentialBinaryHeader => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    candidate.kind === "materialize" &&
    typeof candidate.operationId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(candidate.operationId) &&
    Number.isSafeInteger(candidate.routeGeneration) &&
    (candidate.routeGeneration as number) > 0 &&
    Number.isSafeInteger(candidate.payloadBytes) &&
    (candidate.payloadBytes as number) >= 0 &&
    (candidate.payloadBytes as number) <= MAX_CREDENTIAL_BINARY_BYTES &&
    typeof candidate.control === "object" &&
    candidate.control !== null &&
    typeof candidate.nonceHex === "string" &&
    /^[0-9a-f]{24}$/.test(candidate.nonceHex) &&
    typeof candidate.authTagHex === "string" &&
    /^[0-9a-f]{32}$/.test(candidate.authTagHex)
  );
};

/** Caller owns the returned frame and must wipe it after the transport callback. */
export const encodeCredentialBinaryFrame = (
  header: Omit<CredentialBinaryHeader, "version" | "payloadBytes">,
  payload: Uint8Array,
): Uint8Array => {
  if (payload.byteLength > MAX_CREDENTIAL_BINARY_BYTES)
    throw new Error("credential payload too large");
  const complete: CredentialBinaryHeader = {
    version: 1,
    ...header,
    payloadBytes: payload.byteLength,
  };
  const headerBytes = textEncoder.encode(JSON.stringify(complete));
  if (headerBytes.byteLength > MAX_CREDENTIAL_BINARY_HEADER_BYTES)
    throw new Error("credential header too large");
  const frame = new Uint8Array(PREFIX_BYTES + headerBytes.byteLength + payload.byteLength);
  frame.set(MAGIC, 0);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  view.setUint32(4, headerBytes.byteLength, false);
  view.setUint32(8, payload.byteLength, false);
  frame.set(headerBytes, PREFIX_BYTES);
  frame.set(payload, PREFIX_BYTES + headerBytes.byteLength);
  headerBytes.fill(0);
  return frame;
};

/** Decoding consumes and wipes the input frame while returning one owned payload copy. */
export const consumeCredentialBinaryFrame = (
  frame: Uint8Array,
): { readonly header: CredentialBinaryHeader; readonly payload: Uint8Array } => {
  try {
    if (frame.byteLength < PREFIX_BYTES || !MAGIC.every((byte, index) => frame[index] === byte))
      throw new Error("invalid credential frame magic");
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const headerLength = view.getUint32(4, false);
    const payloadLength = view.getUint32(8, false);
    if (
      headerLength > MAX_CREDENTIAL_BINARY_HEADER_BYTES ||
      payloadLength > MAX_CREDENTIAL_BINARY_BYTES ||
      PREFIX_BYTES + headerLength + payloadLength !== frame.byteLength
    )
      throw new Error("invalid credential frame length");
    const parsed: unknown = JSON.parse(
      textDecoder.decode(frame.subarray(PREFIX_BYTES, PREFIX_BYTES + headerLength)),
    );
    if (!validHeader(parsed) || parsed.payloadBytes !== payloadLength)
      throw new Error("invalid credential frame header");
    return {
      header: parsed,
      payload: frame.slice(PREFIX_BYTES + headerLength),
    };
  } finally {
    frame.fill(0);
  }
};

export const isCredentialBinaryFrame = (frame: Uint8Array): boolean =>
  frame.byteLength >= MAGIC.byteLength && MAGIC.every((byte, index) => frame[index] === byte);

export const credentialBinaryAad = (input: {
  readonly kind: CredentialBinaryKind;
  readonly operationId: string;
  readonly routeGeneration: number;
  readonly control: unknown;
}): Uint8Array =>
  textEncoder.encode(
    JSON.stringify([
      "agentsin-cloud-provider-credential-v1",
      input.kind,
      input.operationId,
      input.routeGeneration,
      input.control,
    ]),
  );
