import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Pool } from "pg";

import { makeAuth } from "./auth.ts";
import type { ControlPlaneConfigShape } from "./config.ts";

const config: ControlPlaneConfigShape = {
  port: 8787,
  host: "127.0.0.1",
  databaseUrl: new URL("postgresql://localhost/agents_in_cloud"),
  betterAuthSecret: "a-secure-secret-that-is-at-least-32-characters",
  betterAuthUrl: new URL("https://control.example.com"),
  githubClientId: "github-client-id",
  githubClientSecret: "github-client-secret",
  passkeyRpId: "control.example.com",
  passkeyRpName: "Agents in Cloud",
  desktopAuthCallbackUrl: new URL("agentsincloud://auth/callback"),
  desktopAuthHandoffSecret: "a-separate-handoff-secret-that-is-at-least-32-characters",
  desktopAuthHandoffTtlSeconds: 120,
  maxRequestBodyBytes: 1_024 * 1_024,
  requestTimeoutMs: 15_000,
  headersTimeoutMs: 10_000,
};

it.effect("configures GitHub, email/password, and passkeys without fallback credentials", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const pool = yield* Effect.acquireRelease(
        Effect.sync(() => new Pool({ connectionString: config.databaseUrl.toString(), max: 1 })),
        (activePool) => Effect.promise(() => activePool.end()),
      );
      const auth = makeAuth({
        config,
        pool,
        onUserCreated: async () => undefined,
      });

      expect(auth.options.secret).toBe(config.betterAuthSecret);
      expect(auth.options.baseURL).toBe("https://control.example.com");
      expect(auth.options.trustedOrigins).toEqual(["https://control.example.com"]);
      expect(auth.options.socialProviders?.github).toMatchObject({
        clientId: "github-client-id",
        clientSecret: "github-client-secret",
        scope: ["read:user", "user:email"],
      });
      expect(auth.options.emailAndPassword).toMatchObject({
        enabled: true,
        minPasswordLength: 12,
      });
      expect(auth.options.rateLimit).toEqual({ enabled: true, window: 60, max: 100 });
      expect(auth.options.plugins?.some((plugin) => plugin.id === "passkey")).toBe(true);
      expect(auth.options.plugins?.some((plugin) => plugin.id === "bearer")).toBe(true);
      expect(auth.options.plugins?.some((plugin) => plugin.id === "one-time-token")).toBe(true);
      expect(auth.options.trustedOrigins).not.toContain(config.desktopAuthCallbackUrl.origin);
      expect(auth.api.generateOneTimeToken).toBeTypeOf("function");
      expect(auth.api.verifyOneTimeToken).toBeTypeOf("function");
    }),
  ),
);
