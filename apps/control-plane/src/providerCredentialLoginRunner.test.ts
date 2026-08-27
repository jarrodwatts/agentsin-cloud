import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import {
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
