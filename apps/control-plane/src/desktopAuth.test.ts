import { expect, it } from "@effect/vitest";

import {
  beginDesktopAuthHandoff,
  codeChallengeForVerifier,
  completeDesktopAuthHandoff,
  DesktopAuthHandoffError,
  verifyDesktopAuthHandoff,
} from "./desktopAuth.ts";

const secret = "a-separate-handoff-secret-that-is-at-least-32-characters";
const callbackUrl = new URL("agentsincloud://auth/callback");
const authOrigin = new URL("https://control.example.com");
const verifier = "v".repeat(64);

it("rejects expired and PKCE-mismatched signed handoffs", () => {
  const options = { authOrigin, callbackUrl, secret, ttlSeconds: 60, nowMs: 1_000 };
  const initiation = beginDesktopAuthHandoff(
    { codeChallenge: codeChallengeForVerifier(verifier), state: "s".repeat(32) },
    options,
  );
  const state = initiation.browserUrl.searchParams.get("state") ?? "";
  const callback = completeDesktopAuthHandoff(state, "one-time-token", options);
  const handoff = callback.searchParams.get("handoff") ?? "";

  expect(() =>
    verifyDesktopAuthHandoff(handoff, "x".repeat(64), { secret, nowMs: 2_000 }),
  ).toThrowError(DesktopAuthHandoffError);
  expect(() => verifyDesktopAuthHandoff(handoff, verifier, { secret, nowMs: 61_000 })).toThrowError(
    DesktopAuthHandoffError,
  );
  expect(verifyDesktopAuthHandoff(handoff, verifier, { secret, nowMs: 60_999 })).toBe(
    "one-time-token",
  );

  const lastCharacter = handoff.at(-1) ?? "";
  const base64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const finalCharacterIndex = base64UrlAlphabet.indexOf(lastCharacter);
  expect(finalCharacterIndex).toBeGreaterThanOrEqual(0);
  expect(finalCharacterIndex % 4).toBe(0);
  const nonCanonicalEquivalent = base64UrlAlphabet[finalCharacterIndex + 1];
  const tampered = `${handoff.slice(0, -1)}${nonCanonicalEquivalent}`;
  expect(() => verifyDesktopAuthHandoff(tampered, verifier, { secret, nowMs: 2_000 })).toThrowError(
    DesktopAuthHandoffError,
  );
});
