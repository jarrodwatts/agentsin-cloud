import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { e2bSandboxConfigFromEnv } from "./e2bSandboxConfig.ts";

it.effect("loads the required E2B credential and bounded active timeout", () =>
  Effect.gen(function* () {
    const config = yield* e2bSandboxConfigFromEnv({
      E2B_API_KEY: "e2b-production-api-key-value",
      E2B_ACTIVE_TIMEOUT_MS: "1800000",
    });

    expect(config).toEqual({
      apiKey: "e2b-production-api-key-value",
      activeTimeoutMs: 1_800_000,
    });
  }),
);

it.effect("fails closed when the E2B credential is absent or malformed", () =>
  Effect.gen(function* () {
    expect((yield* Effect.exit(e2bSandboxConfigFromEnv({})))._tag).toBe("Failure");
    expect((yield* Effect.exit(e2bSandboxConfigFromEnv({ E2B_API_KEY: "short" })))._tag).toBe(
      "Failure",
    );
    expect(
      (yield* Effect.exit(
        e2bSandboxConfigFromEnv({ E2B_API_KEY: "e2b-valid-length\nwith-control" }),
      ))._tag,
    ).toBe("Failure");
  }),
);

it.effect("rejects unbounded E2B active timeouts", () =>
  Effect.gen(function* () {
    const tooShort = yield* Effect.exit(
      e2bSandboxConfigFromEnv({
        E2B_API_KEY: "e2b-production-api-key-value",
        E2B_ACTIVE_TIMEOUT_MS: "1",
      }),
    );
    const tooLong = yield* Effect.exit(
      e2bSandboxConfigFromEnv({
        E2B_API_KEY: "e2b-production-api-key-value",
        E2B_ACTIVE_TIMEOUT_MS: String(24 * 60 * 60 * 1_000 + 1),
      }),
    );

    expect(tooShort._tag).toBe("Failure");
    expect(tooLong._tag).toBe("Failure");
  }),
);
