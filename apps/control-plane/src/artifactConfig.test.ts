import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { r2ConfigFromEnv } from "./artifactConfig.ts";

const valid = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_ENDPOINT: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
  R2_ARTIFACT_BUCKET: "agentsin-cloud-artifacts",
  R2_ACCESS_KEY_ID: "0123456789abcdef",
  R2_SECRET_ACCESS_KEY: "a-secret-access-key-that-is-long-enough",
};

it.effect("loads explicit R2 credentials and bounded defaults", () =>
  Effect.gen(function* () {
    const config = yield* r2ConfigFromEnv(valid);
    expect(config.region).toBe("auto");
    expect(config.maxArtifactBytes).toBe(16 * 1_024 * 1_024);
    expect(config.requestTimeoutMs).toBe(30_000);
  }),
);

it.effect("fails closed when required R2 production configuration is incomplete", () =>
  Effect.gen(function* () {
    const { R2_SECRET_ACCESS_KEY: _removed, ...incomplete } = valid;
    expect((yield* Effect.exit(r2ConfigFromEnv(incomplete)))._tag).toBe("Failure");
  }),
);

it.effect("rejects endpoint substitution, credentials, paths, and unbounded limits", () =>
  Effect.gen(function* () {
    const wrongAccount = yield* Effect.exit(
      r2ConfigFromEnv({ ...valid, R2_ENDPOINT: "https://example.r2.cloudflarestorage.com" }),
    );
    const credentials = yield* Effect.exit(
      r2ConfigFromEnv({
        ...valid,
        R2_ENDPOINT:
          "https://user:password@0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
      }),
    );
    const path = yield* Effect.exit(
      r2ConfigFromEnv({ ...valid, R2_ENDPOINT: `${valid.R2_ENDPOINT}/bucket` }),
    );
    const unbounded = yield* Effect.exit(
      r2ConfigFromEnv({ ...valid, R2_MAX_ARTIFACT_BYTES: String(512 * 1_024 * 1_024) }),
    );
    expect(wrongAccount._tag).toBe("Failure");
    expect(credentials._tag).toBe("Failure");
    expect(path._tag).toBe("Failure");
    expect(unbounded._tag).toBe("Failure");
  }),
);
