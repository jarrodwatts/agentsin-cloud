import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { fromEnv } from "./config.ts";

const validEnv = {
  DATABASE_URL: "postgresql://localhost/agents_in_cloud",
  BETTER_AUTH_SECRET: "a-secure-secret-that-is-at-least-32-characters",
  BETTER_AUTH_URL: "https://control.example.com",
  GITHUB_CLIENT_ID: "github-client-id",
  GITHUB_CLIENT_SECRET: "github-client-secret",
  DESKTOP_AUTH_CALLBACK_URL: "agentsincloud://auth/callback",
  DESKTOP_AUTH_HANDOFF_SECRET: "a-separate-handoff-secret-that-is-at-least-32-characters",
};

it.effect("loads typed configuration and applies safe defaults", () =>
  Effect.gen(function* () {
    const config = yield* fromEnv(validEnv);

    expect(config.port).toBe(8787);
    expect(config.host).toBe("0.0.0.0");
    expect(config.databaseUrl).toBeInstanceOf(URL);
    expect(config.databaseUrl.toString()).toBe(validEnv.DATABASE_URL);
    expect(config.betterAuthUrl.origin).toBe("https://control.example.com");
    expect(config.passkeyRpId).toBe("control.example.com");
    expect(config.passkeyRpName).toBe("Agents in Cloud");
    expect(config.desktopAuthCallbackUrl.toString()).toBe("agentsincloud://auth/callback");
    expect(config.desktopAuthHandoffTtlSeconds).toBe(120);
    expect(config.maxRequestBodyBytes).toBe(1_024 * 1_024);
    expect(config.requestTimeoutMs).toBe(15_000);
    expect(config.headersTimeoutMs).toBe(10_000);
  }),
);

it.effect("rejects an auth secret shorter than Better Auth's minimum", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(fromEnv({ ...validEnv, BETTER_AUTH_SECRET: "too-short" }));

    expect(result._tag).toBe("Failure");
  }),
);

it.effect("rejects whitespace-only auth secrets", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(fromEnv({ ...validEnv, BETTER_AUTH_SECRET: " ".repeat(40) }));

    expect(result._tag).toBe("Failure");
  }),
);

it.effect("rejects missing provider credentials instead of starting partially configured", () =>
  Effect.gen(function* () {
    const { GITHUB_CLIENT_SECRET: _removed, ...withoutGitHubSecret } = validEnv;
    const result = yield* Effect.exit(fromEnv(withoutGitHubSecret));

    expect(result._tag).toBe("Failure");
  }),
);

it.effect("rejects malformed URLs and invalid ports", () =>
  Effect.gen(function* () {
    const invalidUrl = yield* Effect.exit(fromEnv({ ...validEnv, DATABASE_URL: "not-a-url" }));
    const invalidPort = yield* Effect.exit(fromEnv({ ...validEnv, PORT: "70000" }));

    expect(invalidUrl._tag).toBe("Failure");
    expect(invalidPort._tag).toBe("Failure");
  }),
);

it.effect("rejects non-Postgres databases and unsafe public auth origins", () =>
  Effect.gen(function* () {
    const sqlite = yield* Effect.exit(
      fromEnv({ ...validEnv, DATABASE_URL: "https://database.example.com" }),
    );
    const insecureOrigin = yield* Effect.exit(
      fromEnv({ ...validEnv, BETTER_AUTH_URL: "http://control.example.com" }),
    );
    const originWithPath = yield* Effect.exit(
      fromEnv({ ...validEnv, BETTER_AUTH_URL: "https://control.example.com/auth" }),
    );

    expect(sqlite._tag).toBe("Failure");
    expect(insecureOrigin._tag).toBe("Failure");
    expect(originWithPath._tag).toBe("Failure");
  }),
);

it.effect("rejects unsafe desktop callbacks and unbounded HTTP limits", () =>
  Effect.gen(function* () {
    const httpsCallback = yield* Effect.exit(
      fromEnv({ ...validEnv, DESKTOP_AUTH_CALLBACK_URL: "https://evil.example.com/callback" }),
    );
    const callbackWithQuery = yield* Effect.exit(
      fromEnv({
        ...validEnv,
        DESKTOP_AUTH_CALLBACK_URL: "agentsincloud://auth/callback?wallet=1",
      }),
    );
    const unlimitedBody = yield* Effect.exit(fromEnv({ ...validEnv, MAX_REQUEST_BODY_BYTES: "0" }));
    const excessiveTtl = yield* Effect.exit(
      fromEnv({ ...validEnv, DESKTOP_AUTH_HANDOFF_TTL_SECONDS: "3600" }),
    );
    const invertedTimeouts = yield* Effect.exit(
      fromEnv({ ...validEnv, REQUEST_TIMEOUT_MS: "5000", HEADERS_TIMEOUT_MS: "6000" }),
    );
    const reusedSecret = yield* Effect.exit(
      fromEnv({
        ...validEnv,
        DESKTOP_AUTH_HANDOFF_SECRET: validEnv.BETTER_AUTH_SECRET,
      }),
    );

    expect(httpsCallback._tag).toBe("Failure");
    expect(callbackWithQuery._tag).toBe("Failure");
    expect(unlimitedBody._tag).toBe("Failure");
    expect(excessiveTtl._tag).toBe("Failure");
    expect(invertedTimeouts._tag).toBe("Failure");
    expect(reusedSecret._tag).toBe("Failure");
  }),
);
