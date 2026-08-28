import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import {
  PROVIDER_LOGIN_HOME,
  PROVIDER_LOGIN_TMPDIR,
  validateProviderCredentialLoginRunnerPolicy,
  type ProviderCredentialLoginRunnerSecurityPolicy,
} from "./providerCredentialLoginRunner.ts";

const securePolicy = (): ProviderCredentialLoginRunnerSecurityPolicy => ({
  isolationMode: "dedicated-container",
  emptyHome: true,
  repositoryMounts: 0,
  credentialMounts: 0,
  dropSupplementaryGroups: true,
  maxRuntimeMs: 15 * 60_000,
  maxOutputBytes: 64 * 1024,
  maxProfileBytes: 1024 * 1024,
  maxConcurrentRuns: 16,
  executableSha256Allowlist: new Set(["a".repeat(64)]),
  allowedDomains: new Set(["auth.openai.com"]),
  environment: {
    inherit: false,
    variables: {
      HOME: PROVIDER_LOGIN_HOME,
      TMPDIR: PROVIDER_LOGIN_TMPDIR,
      PATH: "/opt/agentsin/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      NO_COLOR: "1",
    },
  },
});

it.effect("accepts a bounded credential-only runner policy", () =>
  validateProviderCredentialLoginRunnerPolicy(securePolicy()),
);

it.effect("fails closed when executable or network allowlists are empty", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      validateProviderCredentialLoginRunnerPolicy({
        ...securePolicy(),
        executableSha256Allowlist: new Set(),
        allowedDomains: new Set(),
      }),
    );
    expect(Result.isFailure(result)).toBe(true);
  }),
);

it.effect("rejects an unbounded runner", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      validateProviderCredentialLoginRunnerPolicy({
        ...securePolicy(),
        maxRuntimeMs: Number.MAX_SAFE_INTEGER,
      }),
    );
    expect(Result.isFailure(result)).toBe(true);
  }),
);

it.effect("rejects inherited, credential-bearing, and endpoint-overriding environments", () =>
  Effect.gen(function* () {
    const inherited = yield* Effect.result(
      validateProviderCredentialLoginRunnerPolicy({
        ...securePolicy(),
        environment: {
          ...securePolicy().environment,
          inherit: true,
        },
      } as unknown as ProviderCredentialLoginRunnerSecurityPolicy),
    );
    expect(Result.isFailure(inherited)).toBe(true);

    for (const name of [
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "OPENAI_BASE_URL",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_CUSTOM_HEADERS",
      "AZURE_OPENAI_ENDPOINT",
      "AWS_SECRET_ACCESS_KEY",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "HTTPS_PROXY",
    ]) {
      const result = yield* Effect.result(
        validateProviderCredentialLoginRunnerPolicy({
          ...securePolicy(),
          environment: {
            inherit: false,
            variables: { ...securePolicy().environment.variables, [name]: "must-not-inherit" },
          },
        }),
      );
      expect(Result.isFailure(result), name).toBe(true);
    }
  }),
);
