// @effect-diagnostics nodeBuiltinImport:off -- Test fixtures calculate manifest integrity hashes.
import * as NodeCrypto from "node:crypto";

import { expect, it } from "@effect/vitest";
import type { ThreadId } from "@t3tools/contracts";
import type { WorkspaceId } from "@t3tools/contracts/cloud";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import type { ArtifactRecord } from "./artifactRepository.ts";
import { makeMemoryArtifactStorage } from "./artifactStorage.ts";
import {
  buildThreadExport,
  createThreadExport,
  MAX_THREAD_EXPORT_RECORDS,
  redactThreadExportValue,
  THREAD_EXPORT_SOURCE_TABLES,
  type ThreadExportIntent,
  type ThreadExportSnapshot,
  type ThreadExportSource,
} from "./threadExport.ts";

const workspaceId = "00000000-0000-4000-8000-000000000001" as WorkspaceId;
const threadId = "export-thread" as ThreadId;
const instant = "2026-08-27T00:00:00.000Z";
const artifact: ArtifactRecord = {
  workspaceId,
  threadId,
  artifactId: "diff-1",
  idempotencyKey: "diff-delivery-1",
  kind: "diff",
  state: "complete",
  objectKey: "v1/safe-object-reference",
  byteLength: 123,
  sha256: "d".repeat(64),
  mediaType: "text/x-diff",
  etag: '"etag"',
  createdAt: instant,
  updatedAt: instant,
  completedAt: instant,
};
const priorExport = { ...artifact, artifactId: "old-export", kind: "thread-export" as const };

const snapshot: ThreadExportSnapshot = {
  commands: [
    { id: "command-2", timestamp: "2026-08-27T00:00:02.000Z" },
    { id: "command-1", timestamp: "2026-08-27T00:00:01.000Z" },
  ],
  events: [
    { id: "event-2", sequence: 2, timestamp: instant },
    { id: "event-1", sequence: 1, timestamp: instant },
  ],
  approvals: [{ id: "approval-1", timestamp: instant }],
  checkpoints: [{ id: "checkpoint-1", sequence: 2, timestamp: instant }],
  artifacts: [priorExport, artifact],
};

it("builds deterministic ordered manifests and excludes prior exports", () => {
  const first = buildThreadExport({
    workspaceId,
    threadId,
    exportId: "export-1",
    createdAt: instant,
    snapshot,
  });
  const second = buildThreadExport({
    workspaceId,
    threadId,
    exportId: "export-1",
    createdAt: instant,
    snapshot: { ...snapshot, commands: snapshot.commands.toReversed() },
  });
  expect(first.bytes).toEqual(second.bytes);
  expect(first.sha256).toBe(NodeCrypto.createHash("sha256").update(first.bytes).digest("hex"));
  const text = new TextDecoder().decode(first.bytes);
  expect(text).not.toContain("old-export");
  expect(text.indexOf('"id":"command-1"')).toBeLessThan(text.indexOf('"id":"command-2"'));
});

it("never exports provider-shaped payloads regardless of aliases or encoding", () => {
  const adversarial = {
    accessKeyId: "AKIA1234567890123456",
    passphrase: "correct horse battery staple",
    data: "opaque-data",
    blob: "opaque-blob",
    Headers: { Authorization: "Bearer token" },
    provider: `sk-ant-${"a".repeat(40)}`,
    github: `github_pat_${"b".repeat(40)}`,
    turnkey: `tk_${"c".repeat(40)}`,
    base64: "QWxhZGRpbjpvcGVuIHNlc2FtZQ==",
    unknownEncryptedEnvelope: { value: "not-recognizable" },
  };
  const redacted = JSON.stringify(redactThreadExportValue(adversarial));
  expect(redacted).toBe('{"omitted":"provider-shaped-payload"}');
  for (const value of Object.values(adversarial)) {
    if (typeof value === "string") expect(redacted).not.toContain(value);
  }
});

it("bounds row count and honors cancellation", () => {
  const tooMany = Array.from({ length: MAX_THREAD_EXPORT_RECORDS + 1 }, (_, index) => ({
    id: `event-${index}`,
    sequence: index,
    timestamp: instant,
  }));
  expect(() =>
    buildThreadExport({
      workspaceId,
      threadId,
      exportId: "oversized",
      createdAt: instant,
      snapshot: { commands: [], events: tooMany, approvals: [], checkpoints: [], artifacts: [] },
    }),
  ).toThrow();
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  expect(() =>
    buildThreadExport({
      workspaceId,
      threadId,
      exportId: "aborted",
      createdAt: instant,
      snapshot,
      signal: controller.signal,
    }),
  ).toThrow();
});

it("bounds per-record and aggregate canonical bytes", () => {
  expect(() =>
    buildThreadExport({
      workspaceId,
      threadId,
      exportId: "oversized-field",
      createdAt: instant,
      snapshot: {
        commands: [{ id: "x".repeat(1_025), timestamp: instant }],
        events: [],
        approvals: [],
        checkpoints: [],
        artifacts: [],
      },
    }),
  ).toThrow();
  const aggregate = Array.from({ length: MAX_THREAD_EXPORT_RECORDS }, (_, index) => ({
    id: `${index.toString().padStart(5, "0")}-${"x".repeat(894)}`,
    timestamp: instant,
  }));
  expect(() =>
    buildThreadExport({
      workspaceId,
      threadId,
      exportId: "oversized-aggregate",
      createdAt: instant,
      snapshot: {
        commands: aggregate,
        events: [],
        approvals: [],
        checkpoints: [],
        artifacts: [],
      },
    }),
  ).toThrow();
});

it.effect("reuses the frozen export intent across completed retries", () =>
  Effect.gen(function* () {
    const storage = makeMemoryArtifactStorage({
      authorizedThreads: [{ workspaceId, threadId }],
    });
    let prepared: ThreadExportIntent | undefined;
    let currentSnapshot = snapshot;
    const source: ThreadExportSource = {
      prepare: (input) => {
        prepared ??= { createdAt: input.createdAt, snapshot: currentSnapshot };
        return Effect.succeed(prepared);
      },
    };
    const options = {
      source,
      storage: storage.service,
      workspaceId,
      threadId,
      exportId: "export-1",
      idempotencyKey: "export-delivery-1",
      createdAt: instant,
    } as const;
    const first = yield* createThreadExport(options);
    currentSnapshot = {
      ...snapshot,
      events: [...snapshot.events, { id: "later", timestamp: instant }],
    };
    const retry = yield* createThreadExport({
      ...options,
      createdAt: "2026-08-28T00:00:00.000Z",
    });
    expect(retry.disposition).toBe("existing");
    expect(retry.bytes).toEqual(first.bytes);
    expect(retry.sha256).toBe(first.sha256);
  }),
);

it.effect("returns a typed failure when export preparation is aborted", () => {
  const controller = new AbortController();
  controller.abort();
  const source: ThreadExportSource = {
    prepare: () => Effect.die(new Error("must not run")),
  };
  const storage = makeMemoryArtifactStorage({ authorizedThreads: [{ workspaceId, threadId }] });
  return Effect.gen(function* () {
    const result = yield* Effect.result(
      createThreadExport({
        source,
        storage: storage.service,
        workspaceId,
        threadId,
        exportId: "cancelled",
        idempotencyKey: "cancelled",
        createdAt: instant,
        signal: controller.signal,
      }),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.code).toBe("aborted");
  });
});

it.effect("rejects storage identities before creating a durable export intent", () =>
  Effect.gen(function* () {
    let prepareCalls = 0;
    const source: ThreadExportSource = {
      prepare: () => {
        prepareCalls += 1;
        return Effect.succeed({ createdAt: instant, snapshot });
      },
    };
    const storage = makeMemoryArtifactStorage({ authorizedThreads: [{ workspaceId, threadId }] });
    for (const input of [
      { exportId: "x".repeat(257), idempotencyKey: "valid" },
      { exportId: "valid", idempotencyKey: "x".repeat(257) },
    ]) {
      const result = yield* Effect.result(
        createThreadExport({
          source,
          storage: storage.service,
          workspaceId,
          threadId,
          ...input,
          createdAt: instant,
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.code).toBe("invalidRecord");
    }
    expect(prepareCalls).toBe(0);
  }),
);

it.effect(
  "normalizes UTC export instants and rejects timezone-dependent values before prepare",
  () =>
    Effect.gen(function* () {
      const preparedAt: Array<string> = [];
      const source: ThreadExportSource = {
        prepare: (input) => {
          preparedAt.push(input.createdAt);
          return Effect.succeed({ createdAt: input.createdAt, snapshot });
        },
      };
      const storage = makeMemoryArtifactStorage({ authorizedThreads: [{ workspaceId, threadId }] });
      yield* createThreadExport({
        source,
        storage: storage.service,
        workspaceId,
        threadId,
        exportId: "canonical-time",
        idempotencyKey: "canonical-time",
        createdAt: "2026-08-27T00:00:00Z",
      });
      expect(preparedAt).toEqual([instant]);

      const timezoneDependent = yield* Effect.result(
        createThreadExport({
          source,
          storage: storage.service,
          workspaceId,
          threadId,
          exportId: "timezone-dependent",
          idempotencyKey: "timezone-dependent",
          createdAt: "2026-08-27 00:00:00",
        }),
      );
      expect(Result.isFailure(timezoneDependent)).toBe(true);
      if (Result.isFailure(timezoneDependent)) {
        expect(timezoneDependent.failure.code).toBe("invalidRecord");
      }
      expect(preparedAt).toEqual([instant]);
    }),
);

it("queries only the audited durable thread and artifact tables", () => {
  expect(THREAD_EXPORT_SOURCE_TABLES).toEqual([
    "cloud_thread_command",
    "cloud_thread_event",
    "cloud_thread_approval",
    "cloud_thread_checkpoint",
    "cloud_thread_artifact",
  ]);
});
