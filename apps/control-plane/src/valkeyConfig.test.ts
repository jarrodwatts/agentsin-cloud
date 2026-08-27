import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { fromEnv } from "./valkeyConfig.ts";

it.effect("loads a version-safe Valkey configuration with bounded deadlines", () =>
  Effect.gen(function* () {
    const config = yield* fromEnv({ VALKEY_URL: "rediss://default:secret@valkey.example:6380/0" });

    expect(config.tls).toBe(true);
    expect(config.host).toBe("valkey.example");
    expect(config.database).toBe(0);
    expect(config.namespace).toBe("agents-in-cloud");
    expect(config.connectTimeoutMs).toBe(5_000);
    expect(config.commandTimeoutMs).toBe(2_000);
  }),
);

it.effect("accepts Railway private redis URLs without exposing credentials to the keyspace", () =>
  Effect.gen(function* () {
    const config = yield* fromEnv({
      VALKEY_URL: "redis://default:secret@valkey.railway.internal:6379",
      VALKEY_NAMESPACE: "aic-prod",
      VALKEY_CONNECT_TIMEOUT_MS: "1000",
      VALKEY_COMMAND_TIMEOUT_MS: "750",
    });

    expect(config.host).toBe("valkey.railway.internal");
    expect(config.tls).toBe(false);
    expect(config.namespace).toBe("aic-prod");
    expect(config.connectTimeoutMs).toBe(1_000);
    expect(config.commandTimeoutMs).toBe(750);
  }),
);

it.effect("rejects missing, non-Valkey, fragmented, and unsafe namespace configuration", () =>
  Effect.gen(function* () {
    expect((yield* Effect.exit(fromEnv({})))._tag).toBe("Failure");
    expect((yield* Effect.exit(fromEnv({ VALKEY_URL: "https://example.com" })))._tag).toBe(
      "Failure",
    );
    expect((yield* Effect.exit(fromEnv({ VALKEY_URL: "redis://localhost#credential" })))._tag).toBe(
      "Failure",
    );
    expect(
      (yield* Effect.exit(
        fromEnv({ VALKEY_URL: "redis://localhost", VALKEY_NAMESPACE: "unsafe:version" }),
      ))._tag,
    ).toBe("Failure");
  }),
);

it.effect("rejects unbounded connection and command deadlines", () =>
  Effect.gen(function* () {
    expect(
      (yield* Effect.exit(
        fromEnv({ VALKEY_URL: "redis://localhost", VALKEY_CONNECT_TIMEOUT_MS: "0" }),
      ))._tag,
    ).toBe("Failure");
    expect(
      (yield* Effect.exit(
        fromEnv({ VALKEY_URL: "redis://localhost", VALKEY_COMMAND_TIMEOUT_MS: "60000" }),
      ))._tag,
    ).toBe("Failure");
  }),
);

it.effect("rejects URL options that could override the hardened client policy", () =>
  Effect.gen(function* () {
    const override =
      "redis://localhost:6379/0?enableOfflineQueue=true&maxRetriesPerRequest=null&connectTimeout=600000&commandTimeout=600000";
    expect((yield* Effect.exit(fromEnv({ VALKEY_URL: override })))._tag).toBe("Failure");
  }),
);

it.effect("rejects public plaintext endpoints, unsafe auth, and arbitrary databases", () =>
  Effect.gen(function* () {
    for (const url of [
      "redis://valkey.example.com/0",
      "redis://user@localhost/0",
      "rediss://default:secret@valkey.example.com/16",
      "rediss://default:secret@valkey.example.com/0/extra",
    ]) {
      expect((yield* Effect.exit(fromEnv({ VALKEY_URL: url })))._tag).toBe("Failure");
    }
  }),
);
