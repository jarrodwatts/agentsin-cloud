// @effect-diagnostics nodeBuiltinImport:off -- Tests calculate known SHA-256 fixtures.
import * as NodeCrypto from "node:crypto";

import { expect, it } from "@effect/vitest";
import type { ThreadId } from "@t3tools/contracts";
import type { WorkspaceId } from "@t3tools/contracts/cloud";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { makeMemoryArtifactRepository } from "./artifactRepository.ts";
import { artifactObjectKey } from "./artifactKeys.ts";
import {
  makeArtifactStorage,
  makeMemoryArtifactStorage,
  type UploadArtifactInput,
} from "./artifactStorage.ts";
import { makeMemoryObjectStorage } from "./r2ObjectStore.ts";

const workspaceId = "00000000-0000-4000-8000-000000000001" as WorkspaceId;
const otherWorkspaceId = "00000000-0000-4000-8000-000000000002" as WorkspaceId;
const threadId = "artifact-thread" as ThreadId;
const otherThreadId = "artifact-thread-two" as ThreadId;
const bytes = new TextEncoder().encode("durable artifact bytes");
const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const body = (value = bytes) =>
  (async function* () {
    yield value;
  })();
const upload = (overrides: Partial<UploadArtifactInput> = {}): UploadArtifactInput => ({
  workspaceId,
  threadId,
  artifactId: "terminal-chunk-1",
  idempotencyKey: "delivery-1",
  kind: "terminal-chunk",
  byteLength: bytes.byteLength,
  sha256: digest,
  mediaType: "text/plain",
  body: body(),
  ...overrides,
});

it.effect("fails closed when the parent thread has not been authorized", () =>
  Effect.gen(function* () {
    const harness = makeMemoryArtifactStorage({ authorizedThreads: [] });
    const result = yield* Effect.result(harness.service.upload(upload()));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.code).toBe("notFound");
    expect(harness.objects.keys()).toEqual([]);
  }),
);

it.effect("uploads immutably and treats duplicate delivery as an idempotent retry", () =>
  Effect.gen(function* () {
    const harness = makeMemoryArtifactStorage({
      authorizedThreads: [
        { workspaceId, threadId },
        { workspaceId, threadId: otherThreadId },
      ],
    });
    const first = yield* harness.service.upload(upload());
    const duplicate = yield* harness.service.upload(upload({ body: body() }));
    expect(first.disposition).toBe("created");
    expect(duplicate.disposition).toBe("existing");
    expect(duplicate.artifact).toEqual(first.artifact);
    expect(harness.objects.keys()).toEqual([first.artifact.objectKey]);
  }),
);

it.effect("scopes artifact and idempotency identities to their thread", () =>
  Effect.gen(function* () {
    const harness = makeMemoryArtifactStorage({
      authorizedThreads: [
        { workspaceId, threadId },
        { workspaceId, threadId: otherThreadId },
      ],
    });
    const first = yield* harness.service.upload(upload());
    const second = yield* harness.service.upload(upload({ threadId: otherThreadId, body: body() }));
    expect(second.disposition).toBe("created");
    expect(second.artifact.objectKey).not.toBe(first.artifact.objectKey);
    expect(harness.objects.keys()).toHaveLength(2);
  }),
);

it.effect(
  "fails closed when an artifact or idempotency key is reused with conflicting content",
  () =>
    Effect.gen(function* () {
      const harness = makeMemoryArtifactStorage({ authorizedThreads: [{ workspaceId, threadId }] });
      yield* harness.service.upload(upload());
      const changed = new TextEncoder().encode("different bytes");
      const result = yield* Effect.result(
        harness.service.upload(
          upload({
            body: body(changed),
            byteLength: changed.byteLength,
            sha256: NodeCrypto.createHash("sha256").update(changed).digest("hex"),
          }),
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.code).toBe("conflict");
    }),
);

it.effect(
  "enforces workspace isolation for read and delete even when the object key is known",
  () =>
    Effect.gen(function* () {
      const harness = makeMemoryArtifactStorage({ authorizedThreads: [{ workspaceId, threadId }] });
      const stored = yield* harness.service.upload(upload());
      expect(stored.artifact.objectKey.length).toBeGreaterThan(20);
      const read = yield* Effect.result(
        harness.service.download(otherWorkspaceId, threadId, stored.artifact.artifactId),
      );
      const remove = yield* Effect.result(
        harness.service.delete(otherWorkspaceId, threadId, stored.artifact.artifactId),
      );
      expect(Result.isFailure(read)).toBe(true);
      expect(Result.isFailure(remove)).toBe(true);
      expect(
        (yield* harness.service.download(workspaceId, threadId, stored.artifact.artifactId)).bytes,
      ).toEqual(bytes);
    }),
);

it.effect("verifies downloaded length and SHA-256 instead of trusting object metadata", () =>
  Effect.gen(function* () {
    const harness = makeMemoryArtifactStorage({ authorizedThreads: [{ workspaceId, threadId }] });
    const stored = yield* harness.service.upload(upload());
    harness.objects.corrupt(stored.artifact.objectKey, new TextEncoder().encode("corrupt"));
    const result = yield* Effect.result(
      harness.service.download(workspaceId, threadId, stored.artifact.artifactId),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.code).toBe("integrity");
  }),
);

it.effect("bounds declared and streamed bodies and honors an aborted operation", () =>
  Effect.gen(function* () {
    const harness = makeMemoryArtifactStorage({
      maxArtifactBytes: 1_024,
      authorizedThreads: [{ workspaceId, threadId }],
    });
    const declared = yield* Effect.result(harness.service.upload(upload({ byteLength: 1_025 })));
    expect(Result.isFailure(declared)).toBe(true);
    if (Result.isFailure(declared)) expect(declared.failure.code).toBe("tooLarge");

    const invalidExpiry = yield* Effect.result(
      harness.service.upload(
        upload({ artifactId: "bad-expiry", idempotencyKey: "bad-expiry", expiresAt: "0" }),
      ),
    );
    expect(Result.isFailure(invalidExpiry)).toBe(true);
    if (Result.isFailure(invalidExpiry)) expect(invalidExpiry.failure.code).toBe("invalidInput");

    const offsetExpiry = yield* Effect.result(
      harness.service.upload(
        upload({
          artifactId: "offset-expiry",
          idempotencyKey: "offset-expiry",
          expiresAt: "2026-08-27T00:00:00.000+00:00",
        }),
      ),
    );
    expect(Result.isFailure(offsetExpiry)).toBe(true);
    if (Result.isFailure(offsetExpiry)) expect(offsetExpiry.failure.code).toBe("invalidInput");

    const invertedRetention = yield* Effect.result(
      harness.service.upload(
        upload({
          artifactId: "inverted-retention",
          idempotencyKey: "inverted-retention",
          retentionUntil: "2026-08-28T00:00:00.000Z",
          expiresAt: "2026-08-27T00:00:00.000Z",
        }),
      ),
    );
    expect(Result.isFailure(invertedRetention)).toBe(true);
    if (Result.isFailure(invertedRetention)) {
      expect(invertedRetention.failure.code).toBe("invalidInput");
    }

    const oversizedBody = new Uint8Array(1_025);
    const streamed = yield* Effect.result(
      harness.service.upload(
        upload({
          artifactId: "streamed-too-large",
          idempotencyKey: "streamed-too-large",
          byteLength: 1_024,
          sha256: NodeCrypto.createHash("sha256").update(oversizedBody).digest("hex"),
          body: body(oversizedBody),
        }),
      ),
    );
    expect(Result.isFailure(streamed)).toBe(true);
    if (Result.isFailure(streamed)) expect(streamed.failure.code).toBe("tooLarge");

    const controller = new AbortController();
    controller.abort(new Error("deadline"));
    const aborted = yield* Effect.result(
      harness.service.upload(
        upload({ artifactId: "aborted", idempotencyKey: "aborted", signal: controller.signal }),
      ),
    );
    expect(Result.isFailure(aborted)).toBe(true);
    if (Result.isFailure(aborted)) expect(aborted.failure.code).toBe("timeout");
  }),
);

it.effect("returns a typed invalid-input failure when the encoded object key is too large", () =>
  Effect.gen(function* () {
    const longThreadId = "🚀".repeat(100) as ThreadId;
    const harness = makeMemoryArtifactStorage({
      authorizedThreads: [{ workspaceId, threadId: longThreadId }],
    });
    const result = yield* Effect.result(
      harness.service.upload(
        upload({
          threadId: longThreadId,
          artifactId: "🚀".repeat(100),
          idempotencyKey: "long-key-delivery",
        }),
      ),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.code).toBe("invalidInput");
    expect(harness.objects.keys()).toEqual([]);
  }),
);

it.effect("rejects an upload whose streamed digest or length differs from its declaration", () =>
  Effect.gen(function* () {
    const harness = makeMemoryArtifactStorage({ authorizedThreads: [{ workspaceId, threadId }] });
    const sameLengthWrongBody = new Uint8Array(bytes.byteLength).fill(7);
    const digestMismatch = yield* Effect.result(
      harness.service.upload(upload({ body: body(sameLengthWrongBody) })),
    );
    expect(Result.isFailure(digestMismatch)).toBe(true);
    if (Result.isFailure(digestMismatch)) expect(digestMismatch.failure.code).toBe("integrity");

    const shortBody = bytes.slice(0, bytes.byteLength - 1);
    const lengthMismatch = yield* Effect.result(
      harness.service.upload(
        upload({ artifactId: "short-body", idempotencyKey: "short-body", body: body(shortBody) }),
      ),
    );
    expect(Result.isFailure(lengthMismatch)).toBe(true);
    if (Result.isFailure(lengthMismatch)) expect(lengthMismatch.failure.code).toBe("integrity");
  }),
);

it.effect("recovers a payload uploaded before the metadata completion transaction", () =>
  Effect.gen(function* () {
    const repository = makeMemoryArtifactRepository([{ workspaceId, threadId }]);
    const objects = makeMemoryObjectStorage();
    const service = makeArtifactStorage({
      repository,
      objects: objects.service,
      clock: { now: () => "2026-08-27T00:00:00.000Z" },
    });
    const objectKey = artifactObjectKey(
      { workspaceId, threadId },
      "terminal-chunk",
      "partial",
      digest,
    );
    yield* repository.reserve({
      workspaceId,
      threadId,
      artifactId: "partial",
      idempotencyKey: "partial-delivery",
      kind: "terminal-chunk",
      objectKey,
      byteLength: bytes.byteLength,
      sha256: digest,
      mediaType: "text/plain",
      createdAt: "2026-08-27T00:00:00.000Z",
    });
    yield* repository.markUploading(workspaceId, threadId, "partial", "2026-08-27T00:00:00.000Z");
    yield* objects.service.putImmutable({
      key: objectKey,
      body: body(),
      byteLength: bytes.byteLength,
      sha256: digest,
      mediaType: "text/plain",
    });
    const recovered = yield* service.reconcile(workspaceId, threadId, "partial");
    expect(recovered.state).toBe("complete");
    expect((yield* service.download(workspaceId, threadId, "partial")).bytes).toEqual(bytes);
  }),
);

it.effect("deletes explicitly and idempotently without making deleted metadata visible", () =>
  Effect.gen(function* () {
    const harness = makeMemoryArtifactStorage({ authorizedThreads: [{ workspaceId, threadId }] });
    yield* harness.service.upload(upload());
    expect(yield* harness.service.delete(workspaceId, threadId, "terminal-chunk-1")).toBe(
      "deleted",
    );
    expect(yield* harness.service.delete(workspaceId, threadId, "terminal-chunk-1")).toBe(
      "already-deleted",
    );
    expect(yield* harness.service.list(workspaceId, threadId)).toEqual([]);
  }),
);

it.effect("fails unsupported conditional deletion without hiding or mutating the artifact", () =>
  Effect.gen(function* () {
    const repository = makeMemoryArtifactRepository([{ workspaceId, threadId }]);
    const objects = makeMemoryObjectStorage();
    const service = makeArtifactStorage({
      repository,
      objects: { ...objects.service, supportsConditionalDelete: false },
      clock: { now: () => "2026-08-27T00:00:00.000Z" },
    });
    yield* service.upload(upload());
    const result = yield* Effect.result(service.delete(workspaceId, threadId, "terminal-chunk-1"));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.code).toBe("conflict");
    expect((yield* repository.get(workspaceId, threadId, "terminal-chunk-1"))?.state).toBe(
      "complete",
    );
    expect(yield* service.list(workspaceId, threadId)).toHaveLength(1);
    expect(objects.keys()).toHaveLength(1);
  }),
);
