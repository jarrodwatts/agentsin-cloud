// @effect-diagnostics schemaSyncInEffect:off -- Test fixtures exercise the sync decoder boundary directly.
import { expect, it } from "@effect/vitest";
import { WorkerBootstrap } from "@t3tools/contracts/worker";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  WORKER_BOOTSTRAP_FILE_ENV,
  WORKER_BOOTSTRAP_MAX_BYTES,
  decodeWorkerBootstrapText,
  loadWorkerBootstrap,
  type WorkerBootstrapFileSource,
} from "./bootstrap.ts";
import { redactLogFields } from "./redaction.ts";

const bootstrapJson = {
  schemaVersion: 1,
  workerId: "worker-1",
  workspaceId: "workspace-1",
  environmentId: "environment-1",
  environmentRevisionId: "revision-1",
  threadId: "thread-1",
  sandboxId: "sandbox-1",
  reservationId: "command-reserve-1",
  provider: { instanceId: "codex_personal", driver: "codex" },
  workspaceDirectory: "/workspace/project",
  bootstrapEndpoint: "https://control.example.com/api/v1/worker-certificates/bootstrap",
  relayEndpoint: "wss://control.example.com/worker",
  relayServerSpkiSha256: "sha256/47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
  relayCredentialRef: "relay-ref-1",
  secretLeaseRef: "lease-ref-1",
  issuedAt: "2026-08-27T00:25:00.000Z",
  expiresAt: "2026-08-27T00:40:00.000Z",
};

const encodeBootstrap = Schema.encodeUnknownSync(Schema.fromJsonString(WorkerBootstrap));
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeBootstrap = Schema.decodeUnknownSync(WorkerBootstrap);

const makeSource = (input: {
  readonly text: string;
  readonly bytes?: number;
  readonly mode?: number;
  readonly onOpen?: () => void;
  readonly onRead?: (maxBytes: number) => void;
  readonly onClose?: () => void;
}): WorkerBootstrapFileSource => ({
  currentUid: 501,
  openNoFollow: () =>
    Effect.acquireRelease(
      Effect.sync(() => {
        input.onOpen?.();
        return {
          stat: Effect.succeed({
            bytes: input.bytes ?? Buffer.byteLength(input.text),
            mode: input.mode ?? 0o100600,
            ownerUid: 501,
            regularFile: true,
          }),
          readBounded: (maxBytes) =>
            Effect.sync(() => {
              input.onRead?.(maxBytes);
              return input.text;
            }),
        };
      }),
      () => Effect.sync(() => input.onClose?.()),
    ),
});

it.effect("loads only a sealed, owner-only bootstrap file", () =>
  Effect.gen(function* () {
    let opens = 0;
    let reads = 0;
    let closes = 0;
    let readLimit = 0;
    const source = makeSource({
      text: encodeBootstrap(decodeBootstrap(bootstrapJson)),
      onOpen: () => {
        opens += 1;
      },
      onRead: (maxBytes) => {
        reads += 1;
        readLimit = maxBytes;
      },
      onClose: () => {
        closes += 1;
      },
    });
    const bootstrap = yield* loadWorkerBootstrap({
      env: { [WORKER_BOOTSTRAP_FILE_ENV]: "/run/secrets/worker-bootstrap.json" },
      nowIso: "2026-08-27T00:30:00.000Z",
      source,
    });
    expect(bootstrap.threadId).toBe("thread-1");
    expect(bootstrap.provider.instanceId).toBe("codex_personal");
    expect({ opens, reads, closes }).toEqual({ opens: 1, reads: 1, closes: 1 });
    expect(readLimit).toBe(WORKER_BOOTSTRAP_MAX_BYTES);
  }),
);

it.effect("rejects insecure metadata, expired identities, and oversized files", () =>
  Effect.gen(function* () {
    let insecureCloses = 0;
    const baseSource = makeSource({
      text: encodeUnknownJson(bootstrapJson),
      mode: 0o100644,
      onClose: () => {
        insecureCloses += 1;
      },
    });
    const insecure = yield* Effect.exit(
      loadWorkerBootstrap({
        env: { [WORKER_BOOTSTRAP_FILE_ENV]: "/run/secrets/bootstrap.json" },
        nowIso: "2026-08-27T00:30:00.000Z",
        source: baseSource,
      }),
    );
    const oversized = yield* Effect.exit(
      loadWorkerBootstrap({
        env: { [WORKER_BOOTSTRAP_FILE_ENV]: "/run/secrets/bootstrap.json" },
        nowIso: "2026-08-27T00:30:00.000Z",
        source: makeSource({
          text: encodeUnknownJson(bootstrapJson),
          bytes: WORKER_BOOTSTRAP_MAX_BYTES + 1,
        }),
      }),
    );
    const expired = yield* Effect.exit(
      decodeWorkerBootstrapText(encodeUnknownJson(bootstrapJson), "2026-08-27T02:00:00.000Z"),
    );
    expect(insecure._tag).toBe("Failure");
    expect(insecureCloses).toBe(1);
    expect(oversized._tag).toBe("Failure");
    expect(expired._tag).toBe("Failure");
  }),
);

it.effect("canonicalizes valid instants and rejects invalid, future, and overlong identities", () =>
  Effect.gen(function* () {
    const canonicalized = yield* decodeWorkerBootstrapText(
      encodeUnknownJson({
        ...bootstrapJson,
        issuedAt: "2026-08-26T20:25:00-04:00",
        expiresAt: "2026-08-26T20:40:00-04:00",
      }),
      "2026-08-27T00:30:00.000Z",
    );
    expect(canonicalized.issuedAt).toBe("2026-08-27T00:25:00.000Z");
    expect(canonicalized.expiresAt).toBe("2026-08-27T00:40:00.000Z");
    for (const invalid of [
      { ...bootstrapJson, issuedAt: "2026-02-30T00:25:00.000Z" },
      { ...bootstrapJson, issuedAt: "not-an-instant" },
      {
        ...bootstrapJson,
        issuedAt: "2026-08-27T00:32:00.000Z",
        expiresAt: "2026-08-27T00:40:00.000Z",
      },
      {
        ...bootstrapJson,
        issuedAt: "2026-08-27T00:10:00.000Z",
        expiresAt: "2026-08-27T00:40:00.000Z",
      },
    ]) {
      expect(
        (yield* Effect.exit(
          decodeWorkerBootstrapText(encodeUnknownJson(invalid), "2026-08-27T00:30:00.000Z"),
        ))._tag,
      ).toBe("Failure");
    }
  }),
);

it.effect("rejects wallet material before schema decoding and redacts log secrets", () =>
  Effect.gen(function* () {
    const wallet = yield* Effect.exit(
      decodeWorkerBootstrapText(
        encodeUnknownJson({ ...bootstrapJson, walletPrivateKey: `0x${"a".repeat(64)}` }),
        "2026-08-27T00:30:00.000Z",
      ),
    );
    expect(wallet._tag).toBe("Failure");
    expect(
      redactLogFields({
        authorization: "Bearer abc.def",
        message: `failed for 0x${"b".repeat(64)}`,
        nested: { providerProfile: "opaque-profile", detail: "safe" },
        threadId: "thread-1",
      }),
    ).toEqual({
      authorization: "[REDACTED]",
      message: "failed for [REDACTED]",
      nested: { providerProfile: "[REDACTED]", detail: "safe" },
      threadId: "thread-1",
    });
  }),
);
