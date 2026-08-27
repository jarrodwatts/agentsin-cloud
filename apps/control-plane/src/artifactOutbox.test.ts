// @effect-diagnostics nodeBuiltinImport:off -- Test fixtures calculate artifact SHA-256 digests.
import * as NodeCrypto from "node:crypto";

import { expect, it } from "@effect/vitest";
import type { ThreadId } from "@t3tools/contracts";
import type { WorkspaceId } from "@t3tools/contracts/cloud";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";

import { makeArtifactOutboxProcessor, startArtifactOutboxDrain } from "./artifactOutbox.ts";
import { makeMemoryArtifactRepository } from "./artifactRepository.ts";
import { artifactObjectKey } from "./artifactKeys.ts";
import { ArtifactStorageError, makeArtifactStorage } from "./artifactStorage.ts";
import { makeMemoryObjectStorage } from "./r2ObjectStore.ts";

const workspaceId = "00000000-0000-4000-8000-000000000001" as WorkspaceId;
const threadId = "outbox-thread" as ThreadId;
const instant = "2026-08-27T00:00:00.000Z";
const epoch = DateTime.toEpochMillis(DateTime.makeUnsafe(instant));
const bytes = new TextEncoder().encode("outbox recovery");
const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const byteBody = async function* () {
  yield bytes;
};

const makeHarness = () => {
  const repository = makeMemoryArtifactRepository([{ workspaceId, threadId }]);
  const objects = makeMemoryObjectStorage();
  const storage = makeArtifactStorage({
    repository,
    objects: objects.service,
    clock: { now: () => instant },
  });
  return { repository, objects, storage };
};

it.effect("drains the PUT-before-complete crash window exactly once", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const objectKey = artifactObjectKey({ workspaceId, threadId }, "diff", "crash-put", sha256);
    yield* harness.repository.reserve({
      workspaceId,
      threadId,
      artifactId: "crash-put",
      idempotencyKey: "crash-put",
      kind: "diff",
      objectKey,
      byteLength: bytes.byteLength,
      sha256,
      mediaType: "text/x-diff",
      createdAt: instant,
    });
    yield* harness.repository.markUploading(workspaceId, threadId, "crash-put", instant);
    yield* harness.objects.service.putImmutable({
      key: objectKey,
      body: byteBody(),
      byteLength: bytes.byteLength,
      sha256,
      mediaType: "text/x-diff",
    });
    const processor = makeArtifactOutboxProcessor({
      repository: harness.repository,
      storage: harness.storage,
      clock: { now: () => epoch },
    });
    expect(harness.repository.outboxSnapshot()).toMatchObject([
      { artifactId: "crash-put", status: "pending", attemptCount: 0 },
    ]);
    expect(yield* processor.runOnce).toBe(1);
    expect(yield* processor.runOnce).toBe(0);
    expect((yield* harness.storage.download(workspaceId, threadId, "crash-put")).bytes).toEqual(
      bytes,
    );
  }),
);

it.effect("drains delete-pending after a crash using the stored object identity", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* harness.storage.upload({
      workspaceId,
      threadId,
      artifactId: "delete-crash",
      idempotencyKey: "delete-crash",
      kind: "diff",
      byteLength: bytes.byteLength,
      sha256,
      mediaType: "text/x-diff",
      body: byteBody(),
    });
    yield* harness.repository.beginDelete(workspaceId, threadId, "delete-crash", instant);
    const processor = makeArtifactOutboxProcessor({
      repository: harness.repository,
      storage: harness.storage,
      clock: { now: () => epoch },
    });
    expect(yield* processor.runOnce).toBe(1);
    expect(harness.objects.keys()).toEqual([]);
  }),
);

it.effect("renews an active lease while a bounded storage operation is still running", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const objectKey = artifactObjectKey({ workspaceId, threadId }, "diff", "slow-put", sha256);
    yield* harness.repository.reserve({
      workspaceId,
      threadId,
      artifactId: "slow-put",
      idempotencyKey: "slow-put",
      kind: "diff",
      objectKey,
      byteLength: bytes.byteLength,
      sha256,
      mediaType: "text/x-diff",
      createdAt: instant,
    });
    yield* harness.repository.markUploading(workspaceId, threadId, "slow-put", instant);
    yield* harness.objects.service.putImmutable({
      key: objectKey,
      body: byteBody(),
      byteLength: bytes.byteLength,
      sha256,
      mediaType: "text/x-diff",
    });
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let current = epoch;
    let renewals = 0;
    const repository = {
      ...harness.repository,
      renewOutbox: (...args: Parameters<typeof harness.repository.renewOutbox>) =>
        Effect.sync(() => {
          renewals += 1;
        }).pipe(Effect.andThen(harness.repository.renewOutbox(...args))),
    };
    const storage = {
      ...harness.storage,
      reconcile: (...args: Parameters<typeof harness.storage.reconcile>) =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(harness.storage.reconcile(...args)),
        ),
    };
    const processor = makeArtifactOutboxProcessor({
      repository,
      storage,
      clock: { now: () => current },
      leaseMs: 90,
      renewalMs: 30,
    });
    const running = yield* Effect.forkChild(processor.runOnce, { startImmediately: true });
    yield* Deferred.await(started);
    yield* Effect.yieldNow;
    current += 30;
    yield* TestClock.adjust("30 millis");
    expect(renewals).toBe(1);
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(running)).toBe(1);
    expect(harness.repository.outboxSnapshot()[0]?.status).toBe("completed");
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("interrupts the production drain when its application scope closes", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    const drain = Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Deferred.succeed(stopped, undefined));
        yield* Deferred.succeed(started, undefined);
        return yield* Effect.never;
      }),
    );
    const drainFiber = yield* Effect.scoped(
      Effect.gen(function* () {
        const fiber = yield* startArtifactOutboxDrain({ runOnce: Effect.succeed(0), drain });
        yield* Deferred.await(started);
        return fiber;
      }),
    );
    yield* Fiber.await(drainFiber);
    expect(yield* Deferred.isDone(stopped)).toBe(true);
  }),
);

it.effect(
  "leases exclude duplicate consumers and expired work is requeued with bounded attempts",
  () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const objectKey = artifactObjectKey({ workspaceId, threadId }, "diff", "lease", sha256);
      yield* harness.repository.reserve({
        workspaceId,
        threadId,
        artifactId: "lease",
        idempotencyKey: "lease",
        kind: "diff",
        objectKey,
        byteLength: bytes.byteLength,
        sha256,
        mediaType: "text/x-diff",
        createdAt: instant,
      });
      const first = yield* harness.repository.claimOutbox({
        now: instant,
        leaseExpiresAt: "2026-08-27T00:00:01.000Z",
        limit: 1,
        maxAttempts: 2,
      });
      expect(first).toHaveLength(1);
      expect(
        yield* harness.repository.claimOutbox({
          now: instant,
          leaseExpiresAt: "2026-08-27T00:00:01.000Z",
          limit: 1,
          maxAttempts: 2,
        }),
      ).toEqual([]);
      expect(yield* harness.repository.requeueExpiredOutbox("2026-08-27T00:00:02.000Z", 10)).toBe(
        1,
      );
      const second = yield* harness.repository.claimOutbox({
        now: "2026-08-27T00:00:02.000Z",
        leaseExpiresAt: "2026-08-27T00:00:03.000Z",
        limit: 1,
        maxAttempts: 2,
      });
      expect(second[0]?.attemptCount).toBe(2);
      const staleRenew = yield* Effect.result(
        harness.repository.renewOutbox(first[0]!, instant, "2026-08-27T00:00:04.000Z"),
      );
      expect(Result.isFailure(staleRenew)).toBe(true);
      yield* harness.repository.failOutbox(
        second[0]!,
        instant,
        "2026-08-27T00:00:04.000Z",
        "exhausted",
      );
      expect(
        yield* harness.repository.claimOutbox({
          now: "2026-08-27T00:00:05.000Z",
          leaseExpiresAt: "2026-08-27T00:00:06.000Z",
          limit: 1,
          maxAttempts: 2,
        }),
      ).toEqual([]);
    }),
);

it.effect("an explicit upload retry resets an exhausted verify lease", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* harness.repository.reserve({
      workspaceId,
      threadId,
      artifactId: "explicit-retry",
      idempotencyKey: "explicit-retry",
      kind: "diff",
      objectKey: artifactObjectKey({ workspaceId, threadId }, "diff", "explicit-retry", sha256),
      byteLength: bytes.byteLength,
      sha256,
      mediaType: "text/x-diff",
      createdAt: instant,
    });
    yield* harness.repository.markUploading(workspaceId, threadId, "explicit-retry", instant);
    const exhausted = yield* harness.repository.claimOutbox({
      now: instant,
      leaseExpiresAt: "2026-08-27T00:01:00.000Z",
      limit: 1,
      maxAttempts: 1,
    });
    yield* harness.repository.failOutbox(exhausted[0]!, instant, instant, "transient_failure");
    expect(
      yield* harness.repository.claimOutbox({
        now: instant,
        leaseExpiresAt: "2026-08-27T00:01:00.000Z",
        limit: 1,
        maxAttempts: 1,
      }),
    ).toEqual([]);

    yield* harness.repository.markUploading(workspaceId, threadId, "explicit-retry", instant);
    const retried = yield* harness.repository.claimOutbox({
      now: instant,
      leaseExpiresAt: "2026-08-27T00:01:00.000Z",
      limit: 1,
      maxAttempts: 1,
    });
    expect(retried).toHaveLength(1);
    expect(retried[0]?.attemptCount).toBe(1);
  }),
);

it.effect("records the discriminating storage error code for retry diagnostics", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* harness.repository.reserve({
      workspaceId,
      threadId,
      artifactId: "diagnostic-code",
      idempotencyKey: "diagnostic-code",
      kind: "diff",
      objectKey: artifactObjectKey({ workspaceId, threadId }, "diff", "diagnostic-code", sha256),
      byteLength: bytes.byteLength,
      sha256,
      mediaType: "text/x-diff",
      createdAt: instant,
    });
    const processor = makeArtifactOutboxProcessor({
      repository: harness.repository,
      storage: {
        ...harness.storage,
        reconcile: () =>
          Effect.fail(
            new ArtifactStorageError({
              code: "timeout",
              operation: "test-reconcile",
              retryable: true,
            }),
          ),
      },
      clock: { now: () => epoch },
    });
    expect(yield* processor.runOnce).toBe(1);
    expect(harness.repository.outboxSnapshot()[0]?.lastErrorCode).toBe("timeout");
  }),
);
