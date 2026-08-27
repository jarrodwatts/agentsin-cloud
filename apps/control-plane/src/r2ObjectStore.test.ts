// @effect-diagnostics nodeBuiltinImport:off -- Tests calculate known SHA-256 fixtures.
import * as NodeCrypto from "node:crypto";

import { expect, it, vi } from "@effect/vitest";
import type {
  DeleteObjectCommandOutput,
  GetObjectCommandOutput,
  HeadObjectCommandOutput,
  PutObjectCommandOutput,
} from "@aws-sdk/client-s3";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";

import type { R2ArtifactConfigShape } from "./artifactConfig.ts";
import {
  makeR2ObjectStorageWithBoundary,
  readBoundedAndHash,
  type ArtifactByteSource,
  type R2ObjectBoundary,
} from "./r2ObjectStore.ts";

const bytes = new TextEncoder().encode("adapter verified body");
const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const body = (value: Uint8Array): ArtifactByteSource =>
  (async function* () {
    yield value;
  })();

const config: R2ArtifactConfigShape = {
  accountId: "a".repeat(32),
  endpoint: new URL(`https://${"a".repeat(32)}.r2.cloudflarestorage.com`),
  bucket: "artifacts",
  accessKeyId: "a".repeat(16),
  secretAccessKey: "s".repeat(32),
  region: "auto",
  maxArtifactBytes: 1_024,
  requestTimeoutMs: 5_000,
};

const unused = async (): Promise<never> => {
  throw new Error("unexpected R2 boundary operation");
};

const consumingBoundary = (): R2ObjectBoundary => ({
  head: unused as () => Promise<HeadObjectCommandOutput>,
  get: unused as () => Promise<GetObjectCommandOutput>,
  delete: unused as () => Promise<DeleteObjectCommandOutput>,
  put: async (input): Promise<PutObjectCommandOutput> => {
    for await (const _chunk of input.Body as AsyncIterable<Uint8Array>) {
      // A strict fake emulates the SDK consuming the entire request stream before succeeding.
    }
    return { ETag: '"strict-fake"', $metadata: {} };
  },
});

const preconditionBoundary = (get: R2ObjectBoundary["get"]): R2ObjectBoundary => ({
  head: unused as () => Promise<HeadObjectCommandOutput>,
  delete: unused as () => Promise<DeleteObjectCommandOutput>,
  put: async () => {
    throw Object.assign(new Error("already exists"), { $metadata: { httpStatusCode: 412 } });
  },
  get,
});

const immutableRequest = (signal?: AbortSignal) => ({
  key: "v1/existing",
  body: body(bytes),
  byteLength: bytes.byteLength,
  sha256: digest,
  mediaType: "text/plain",
  ...(signal === undefined ? {} : { signal }),
});

it.effect("verifies actual streamed length and digest inside the R2 adapter", () =>
  Effect.gen(function* () {
    const storage = makeR2ObjectStorageWithBoundary(config, consumingBoundary());
    const wrongDigestBody = new Uint8Array(bytes.byteLength).fill(7);
    const digestMismatch = yield* Effect.result(
      storage.putImmutable({
        key: "v1/test",
        body: body(wrongDigestBody),
        byteLength: bytes.byteLength,
        sha256: digest,
        mediaType: "text/plain",
      }),
    );
    expect(Result.isFailure(digestMismatch)).toBe(true);
    if (Result.isFailure(digestMismatch)) expect(digestMismatch.failure.code).toBe("integrity");

    const lengthMismatch = yield* Effect.result(
      storage.putImmutable({
        key: "v1/test-short",
        body: body(bytes.slice(0, -1)),
        byteLength: bytes.byteLength,
        sha256: digest,
        mediaType: "text/plain",
      }),
    );
    expect(Result.isFailure(lengthMismatch)).toBe(true);
    if (Result.isFailure(lengthMismatch)) expect(lengthMismatch.failure.code).toBe("integrity");
  }),
);

it.effect("rejects a 412 object whose forged metadata is not bound to its bytes", () =>
  Effect.gen(function* () {
    const wrong = new Uint8Array(bytes.byteLength).fill(9);
    const boundary: R2ObjectBoundary = {
      head: async () => ({
        ContentLength: bytes.byteLength,
        ContentType: "text/plain",
        ETag: '"replacement"',
        Metadata: { sha256: digest },
        $metadata: {},
      }),
      delete: unused as () => Promise<DeleteObjectCommandOutput>,
      put: async () => {
        throw Object.assign(new Error("already exists"), { $metadata: { httpStatusCode: 412 } });
      },
      get: async () => ({
        ContentLength: bytes.byteLength,
        ContentType: "text/plain",
        ETag: '"forged"',
        VersionId: "forged-version",
        Metadata: { sha256: digest },
        Body: body(wrong) as never,
        $metadata: {},
      }),
    };
    const result = yield* Effect.result(
      makeR2ObjectStorageWithBoundary(config, boundary).putImmutable({
        key: "v1/existing",
        body: body(bytes),
        byteLength: bytes.byteLength,
        sha256: digest,
        mediaType: "text/plain",
      }),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.code).toBe("conflict");
      expect(result.failure.retryable).toBe(false);
    }
  }),
);

it.effect("preserves a caller abort while verifying a 412 object", () =>
  Effect.gen(function* () {
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled"));
    const boundary = preconditionBoundary(async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    const result = yield* Effect.result(
      makeR2ObjectStorageWithBoundary(config, boundary).putImmutable(
        immutableRequest(controller.signal),
      ),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.code).toBe("timeout");
      expect(result.failure.retryable).toBe(true);
    }
  }),
);

it.effect("preserves a verification timeout after a 412 object", () =>
  Effect.gen(function* () {
    const boundary = preconditionBoundary(
      (_input, signal) =>
        new Promise<GetObjectCommandOutput>((_resolve, reject) => {
          const rejectTimeout = () =>
            reject(Object.assign(new Error("deadline exceeded"), { name: "AbortError" }));
          if (signal.aborted) {
            rejectTimeout();
            return;
          }
          signal.addEventListener("abort", rejectTimeout, { once: true });
        }),
    );
    const result = yield* Effect.result(
      makeR2ObjectStorageWithBoundary({ ...config, requestTimeoutMs: 10 }, boundary).putImmutable(
        immutableRequest(),
      ),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.code).toBe("timeout");
      expect(result.failure.retryable).toBe(true);
    }
  }),
);

it.effect("preserves retryable verification I/O after a 412 object", () =>
  Effect.gen(function* () {
    const boundary = preconditionBoundary(async () => {
      throw new Error("R2 transport unavailable");
    });
    const result = yield* Effect.result(
      makeR2ObjectStorageWithBoundary(config, boundary).putImmutable(immutableRequest()),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.code).toBe("io");
      expect(result.failure.retryable).toBe(true);
    }
  }),
);

it.effect("observes a late body rejection after aborting 412 verification", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = Promise.withResolvers<void>();
      const late = Promise.withResolvers<IteratorResult<Uint8Array>>();
      const responseBody: ArtifactByteSource = {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            started.resolve();
            return late.promise;
          },
          return: async () => ({ done: true, value: undefined }),
        }),
      };
      const boundary = preconditionBoundary(async () => ({
        ContentLength: bytes.byteLength,
        ContentType: "text/plain",
        ETag: '"existing"',
        Metadata: { sha256: digest },
        Body: responseBody as never,
        $metadata: {},
      }));
      const controller = new AbortController();
      const verifying = yield* Effect.forkChild(
        Effect.result(
          makeR2ObjectStorageWithBoundary(config, boundary).putImmutable(
            immutableRequest(controller.signal),
          ),
        ),
      );
      yield* Effect.promise(() => started.promise);
      controller.abort(new Error("caller cancelled in flight"));
      const result = yield* Fiber.join(verifying);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.code).toBe("timeout");
        expect(result.failure.retryable).toBe(true);
      }
      late.reject(new Error("body rejected after cancellation"));
      yield* Effect.promise(() => Promise.resolve());
    }),
  ),
);

it.effect("uses atomic ETag and version preconditions when deleting", () =>
  Effect.gen(function* () {
    const boundary: R2ObjectBoundary = {
      head: async () => ({
        ContentLength: bytes.byteLength,
        ContentType: "text/plain",
        ETag: '"replacement"',
        Metadata: { sha256: digest },
        $metadata: {},
      }),
      get: unused as () => Promise<GetObjectCommandOutput>,
      put: unused as () => Promise<PutObjectCommandOutput>,
      delete: async (input) => {
        expect(input.IfMatch).toBe('"etag-v1"');
        expect(input.VersionId).toBe("version-v1");
        throw Object.assign(new Error("replaced"), { $metadata: { httpStatusCode: 412 } });
      },
    };
    const result = yield* Effect.result(
      makeR2ObjectStorageWithBoundary(config, boundary, { conditionalDelete: true }).delete(
        "v1/delete",
        {
          byteLength: bytes.byteLength,
          sha256: digest,
          etag: '"etag-v1"',
          versionId: "version-v1",
        },
      ),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.code).toBe("conflict");
  }),
);

it.effect("fails closed before calling an R2 boundary without proven conditional delete", () =>
  Effect.gen(function* () {
    let deleteCalls = 0;
    const boundary: R2ObjectBoundary = {
      head: unused as () => Promise<HeadObjectCommandOutput>,
      get: unused as () => Promise<GetObjectCommandOutput>,
      put: unused as () => Promise<PutObjectCommandOutput>,
      delete: async () => {
        deleteCalls += 1;
        return { $metadata: {} };
      },
    };
    const result = yield* Effect.result(
      makeR2ObjectStorageWithBoundary(config, boundary).delete("v1/delete", {
        byteLength: bytes.byteLength,
        sha256: digest,
        etag: '"etag-v1"',
      }),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.code).toBe("conflict");
    expect(deleteCalls).toBe(0);
  }),
);

it.effect("bounds a response body that never yields and honors caller abort", () =>
  Effect.gen(function* () {
    const stalled: ArtifactByteSource = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
      }),
    };
    const boundary: R2ObjectBoundary = {
      head: unused as () => Promise<HeadObjectCommandOutput>,
      put: unused as () => Promise<PutObjectCommandOutput>,
      delete: unused as () => Promise<DeleteObjectCommandOutput>,
      get: async () => ({
        ContentLength: bytes.byteLength,
        ContentType: "text/plain",
        ETag: '"stalled"',
        Metadata: { sha256: digest },
        Body: stalled as never,
        $metadata: {},
      }),
    };
    const shortConfig = { ...config, requestTimeoutMs: 20 };
    const storage = makeR2ObjectStorageWithBoundary(shortConfig, boundary);
    const received = yield* storage.get("v1/stalled");
    const timeout = yield* Effect.result(
      Effect.tryPromise(() => readBoundedAndHash(received.body, 1_024)),
    );
    expect(Result.isFailure(timeout)).toBe(true);

    const controller = new AbortController();
    const receivedAgain = yield* storage.get("v1/stalled-again", controller.signal);
    controller.abort(new Error("caller cancelled"));
    const aborted = yield* Effect.result(
      Effect.tryPromise(() => readBoundedAndHash(receivedAgain.body, 1_024)),
    );
    expect(Result.isFailure(aborted)).toBe(true);
  }),
);

it("does not advance a source when bounded reading is already aborted", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled before reading"));
  let nextCalls = 0;
  let late: PromiseWithResolvers<IteratorResult<Uint8Array>> | undefined;
  const source: ArtifactByteSource = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        nextCalls += 1;
        late = Promise.withResolvers<IteratorResult<Uint8Array>>();
        return late.promise;
      },
      return: async () => ({ done: true, value: undefined }),
    }),
  };
  await expect(readBoundedAndHash(source, 1_024, controller.signal)).rejects.toMatchObject({
    _tag: "ObjectStoreError",
    code: "timeout",
    retryable: true,
  });
  expect(nextCalls).toBe(0);
  if (late !== undefined) {
    late.reject(new Error("late rejection from an incorrectly advanced source"));
    await Promise.resolve();
  }
});

it.effect("closes source iterators after an oversized body and an early consumer stop", () =>
  Effect.gen(function* () {
    let oversizedReturns = 0;
    const oversized: ArtifactByteSource = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false, value: new Uint8Array(2) }),
        return: async () => {
          oversizedReturns += 1;
          return { done: true, value: undefined };
        },
      }),
    };
    const result = yield* Effect.result(Effect.tryPromise(() => readBoundedAndHash(oversized, 1)));
    expect(Result.isFailure(result)).toBe(true);
    expect(oversizedReturns).toBe(1);

    let earlyStopReturns = 0;
    const responseBody: ArtifactByteSource = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false, value: bytes }),
        return: async () => {
          earlyStopReturns += 1;
          return { done: true, value: undefined };
        },
      }),
    };
    const boundary: R2ObjectBoundary = {
      head: unused as () => Promise<HeadObjectCommandOutput>,
      put: unused as () => Promise<PutObjectCommandOutput>,
      delete: unused as () => Promise<DeleteObjectCommandOutput>,
      get: async () => ({
        ContentLength: bytes.byteLength,
        ContentType: "text/plain",
        ETag: '"early-stop"',
        Metadata: { sha256: digest },
        Body: responseBody as never,
        $metadata: {},
      }),
    };
    const received = yield* makeR2ObjectStorageWithBoundary(config, boundary).get("v1/early-stop");
    yield* Effect.promise(async () => {
      for await (const _chunk of received.body) break;
    });
    expect(earlyStopReturns).toBe(1);
  }),
);

it("preserves the primary body error across hostile iterator cleanup", async () => {
  const sourceWithReturn = (
    close: () => Promise<IteratorResult<Uint8Array>>,
  ): ArtifactByteSource => ({
    [Symbol.asyncIterator]: () => ({
      next: async () => ({ done: false, value: new Uint8Array(2) }),
      return: close,
    }),
  });
  const assertTooLarge = async (source: ArtifactByteSource) => {
    await expect(readBoundedAndHash(source, 1)).rejects.toMatchObject({
      _tag: "ObjectStoreError",
      code: "tooLarge",
      retryable: false,
    });
  };

  await assertTooLarge(
    sourceWithReturn(() => {
      throw new Error("synchronous close failure");
    }),
  );
  await assertTooLarge(
    sourceWithReturn(() => Promise.reject(new Error("asynchronous close failure"))),
  );

  const delayedStarted = Promise.withResolvers<void>();
  const releaseDelayed = Promise.withResolvers<void>();
  const delayedResult = assertTooLarge(
    sourceWithReturn(async () => {
      delayedStarted.resolve();
      await releaseDelayed.promise;
      return { done: true, value: undefined };
    }),
  );
  await delayedStarted.promise;
  releaseDelayed.resolve();
  await delayedResult;

  vi.useFakeTimers();
  try {
    const stalledStarted = Promise.withResolvers<void>();
    const stalledResult = assertTooLarge(
      sourceWithReturn(() => {
        stalledStarted.resolve();
        return new Promise<IteratorResult<Uint8Array>>(() => undefined);
      }),
    );
    await stalledStarted.promise;
    await vi.advanceTimersByTimeAsync(100);
    await stalledResult;
  } finally {
    vi.useRealTimers();
  }
});
