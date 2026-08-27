import * as NodeCrypto from "node:crypto";

import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

const HANDOFF_AUDIENCE = "agentsin-cloud-desktop-auth";

const currentEpochMillis = () => DateTime.toEpochMillis(DateTime.nowUnsafe());
const JsonUnknown = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeUnknownSync(JsonUnknown);
const decodeJson = Schema.decodeUnknownSync(JsonUnknown);

interface InitiationPayload {
  readonly audience: typeof HANDOFF_AUDIENCE;
  readonly kind: "initiation";
  readonly nonce: string;
  readonly clientState: string;
  readonly codeChallenge: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

interface ExchangePayload extends Omit<InitiationPayload, "kind"> {
  readonly kind: "exchange";
  readonly oneTimeToken: string;
}

type HandoffPayload = InitiationPayload | ExchangePayload;

export class DesktopAuthHandoffError extends Error {
  readonly code:
    | "invalid_handoff"
    | "expired_handoff"
    | "invalid_code_verifier"
    | "invalid_code_challenge";

  constructor(code: DesktopAuthHandoffError["code"]) {
    super(code);
    this.name = "DesktopAuthHandoffError";
    this.code = code;
  }
}

const signPayload = (encodedPayload: string, secret: string) =>
  NodeCrypto.createHmac("sha256", secret)
    .update("agents-in-cloud/desktop-auth/v1\0")
    .update(encodedPayload)
    .digest("base64url");

const encodeToken = (payload: HandoffPayload, secret: string) => {
  const encodedPayload = Buffer.from(encodeJson(payload)).toString("base64url");
  return `${encodedPayload}.${signPayload(encodedPayload, secret)}`;
};

const isPayload = (value: unknown): value is HandoffPayload => {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Partial<HandoffPayload>;
  return (
    payload.audience === HANDOFF_AUDIENCE &&
    (payload.kind === "initiation" || payload.kind === "exchange") &&
    typeof payload.nonce === "string" &&
    typeof payload.clientState === "string" &&
    typeof payload.codeChallenge === "string" &&
    typeof payload.issuedAt === "number" &&
    Number.isSafeInteger(payload.issuedAt) &&
    typeof payload.expiresAt === "number" &&
    Number.isSafeInteger(payload.expiresAt) &&
    (payload.kind !== "exchange" || typeof payload.oneTimeToken === "string")
  );
};

const decodeToken = (token: string, secret: string, nowMs: number): HandoffPayload => {
  const parts = token.split(".");
  if (parts.length !== 2) throw new DesktopAuthHandoffError("invalid_handoff");
  const [encodedPayload, suppliedSignature] = parts;
  if (
    encodedPayload === undefined ||
    suppliedSignature === undefined ||
    !/^[A-Za-z0-9_-]+$/.test(encodedPayload) ||
    !/^[A-Za-z0-9_-]{43}$/.test(suppliedSignature)
  ) {
    throw new DesktopAuthHandoffError("invalid_handoff");
  }

  const expectedSignature = Buffer.from(signPayload(encodedPayload, secret), "base64url");
  const receivedSignature = Buffer.from(suppliedSignature, "base64url");
  if (
    receivedSignature.toString("base64url") !== suppliedSignature ||
    expectedSignature.length !== receivedSignature.length ||
    !NodeCrypto.timingSafeEqual(expectedSignature, receivedSignature)
  ) {
    throw new DesktopAuthHandoffError("invalid_handoff");
  }

  try {
    const parsed = decodeJson(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    if (!isPayload(parsed)) throw new DesktopAuthHandoffError("invalid_handoff");
    if (parsed.expiresAt * 1_000 <= nowMs) {
      throw new DesktopAuthHandoffError("expired_handoff");
    }
    return parsed;
  } catch (cause) {
    if (cause instanceof DesktopAuthHandoffError) throw cause;
    throw new DesktopAuthHandoffError("invalid_handoff");
  }
};

export const codeChallengeForVerifier = (codeVerifier: string) =>
  NodeCrypto.createHash("sha256").update(codeVerifier, "ascii").digest("base64url");

const matchesCodeChallenge = (codeVerifier: string, expectedChallenge: string) => {
  const actual = Buffer.from(codeChallengeForVerifier(codeVerifier), "base64url");
  const expected = Buffer.from(expectedChallenge, "base64url");
  return actual.length === expected.length && NodeCrypto.timingSafeEqual(actual, expected);
};

export interface DesktopAuthHandoffOptions {
  readonly authOrigin: URL;
  readonly callbackUrl: URL;
  readonly secret: string;
  readonly ttlSeconds: number;
  readonly nowMs?: number;
}

export const beginDesktopAuthHandoff = (
  input: { readonly codeChallenge: string; readonly state: string },
  options: DesktopAuthHandoffOptions,
) => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge)) {
    throw new DesktopAuthHandoffError("invalid_code_challenge");
  }
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(input.state)) {
    throw new DesktopAuthHandoffError("invalid_handoff");
  }
  const nowMs = options.nowMs ?? currentEpochMillis();
  const issuedAt = Math.floor(nowMs / 1_000);
  const expiresAt = issuedAt + options.ttlSeconds;
  const state = encodeToken(
    {
      audience: HANDOFF_AUDIENCE,
      kind: "initiation",
      nonce: NodeCrypto.randomBytes(24).toString("base64url"),
      clientState: input.state,
      codeChallenge: input.codeChallenge,
      issuedAt,
      expiresAt,
    },
    options.secret,
  );
  const browserUrl = new URL("/desktop-auth/complete", options.authOrigin);
  browserUrl.searchParams.set("state", state);
  return {
    browserUrl,
    expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAt * 1_000)),
  };
};

export const verifyDesktopAuthInitiation = (
  state: string,
  options: Pick<DesktopAuthHandoffOptions, "secret" | "nowMs">,
) => {
  const payload = decodeToken(state, options.secret, options.nowMs ?? currentEpochMillis());
  if (payload.kind !== "initiation") throw new DesktopAuthHandoffError("invalid_handoff");
  return payload;
};

export const completeDesktopAuthHandoff = (
  state: string,
  oneTimeToken: string,
  options: DesktopAuthHandoffOptions,
) => {
  const nowMs = options.nowMs ?? currentEpochMillis();
  const initiation = verifyDesktopAuthInitiation(state, { secret: options.secret, nowMs });
  if (oneTimeToken.length === 0) {
    throw new DesktopAuthHandoffError("invalid_handoff");
  }
  const handoff = encodeToken(
    {
      ...initiation,
      kind: "exchange",
      oneTimeToken,
    },
    options.secret,
  );
  const callbackUrl = new URL(options.callbackUrl);
  callbackUrl.searchParams.set("handoff", handoff);
  callbackUrl.searchParams.set("state", initiation.clientState);
  return callbackUrl;
};

export const verifyDesktopAuthHandoff = (
  handoff: string,
  codeVerifier: string,
  options: Pick<DesktopAuthHandoffOptions, "secret" | "nowMs">,
) => {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(codeVerifier)) {
    throw new DesktopAuthHandoffError("invalid_code_verifier");
  }
  const payload = decodeToken(handoff, options.secret, options.nowMs ?? currentEpochMillis());
  if (payload.kind !== "exchange" || !matchesCodeChallenge(codeVerifier, payload.codeChallenge)) {
    throw new DesktopAuthHandoffError("invalid_code_verifier");
  }
  return payload.oneTimeToken;
};
