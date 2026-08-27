// @effect-diagnostics nodeBuiltinImport:off -- Conformance fixtures calculate SHA-256 digests.
import * as NodeCrypto from "node:crypto";

import { expect, it } from "@effect/vitest";
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
  makeMemoryObjectStorage,
  makeR2ObjectStorageWithBoundary,
  readBoundedAndHash,
  type R2ObjectBoundary,
} from "./r2ObjectStore.ts";

const bytes = new TextEncoder().encode("shared object conformance");
const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const body = async function* () {
  yield bytes;
};
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

const strictR2 = () => {
  let stored:
    | {
        readonly bytes: Uint8Array;
        readonly contentType: string;
        readonly sha256: string;
        readonly etag: string;
        readonly versionId: string;
      }
    | undefined;
  let activeWrite: Promise<void> | undefined;
  const notFound = () =>
    Object.assign(new Error("not found"), { $metadata: { httpStatusCode: 404 } });
  const boundary: R2ObjectBoundary = {
    put: async (input): Promise<PutObjectCommandOutput> => {
      for (;;) {
        if (stored !== undefined) {
          throw Object.assign(new Error("exists"), { $metadata: { httpStatusCode: 412 } });
        }
        if (activeWrite !== undefined) {
          await activeWrite;
          continue;
        }
        const completion = Promise.withResolvers<void>();
        activeWrite = completion.promise;
        try {
          const chunks: Array<Uint8Array> = [];
          for await (const chunk of input.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
          stored = {
            bytes: Buffer.concat(chunks).slice(),
            contentType: input.ContentType!,
            sha256: input.Metadata!.sha256!,
            etag: '"strict-etag"',
            versionId: "strict-version",
          };
          return { ETag: stored.etag, VersionId: stored.versionId, $metadata: {} };
        } finally {
          completion.resolve();
          if (activeWrite === completion.promise) activeWrite = undefined;
        }
      }
    },
    head: async (): Promise<HeadObjectCommandOutput> => {
      if (stored === undefined) throw notFound();
      return {
        ContentLength: stored.bytes.byteLength,
        ContentType: stored.contentType,
        ETag: stored.etag,
        VersionId: stored.versionId,
        Metadata: { sha256: stored.sha256 },
        $metadata: {},
      };
    },
    get: async (): Promise<GetObjectCommandOutput> => {
      if (stored === undefined) throw notFound();
      return {
        ContentLength: stored.bytes.byteLength,
        ContentType: stored.contentType,
        ETag: stored.etag,
        VersionId: stored.versionId,
        Metadata: { sha256: stored.sha256 },
        Body: (async function* () {
          yield stored!.bytes;
        })() as never,
        $metadata: {},
      };
    },
    delete: async (input): Promise<DeleteObjectCommandOutput> => {
      if (
        stored === undefined ||
        input.IfMatch !== stored.etag ||
        input.VersionId !== stored.versionId
      ) {
        throw Object.assign(new Error("precondition"), { $metadata: { httpStatusCode: 412 } });
      }
      stored = undefined;
      return { $metadata: {} };
    },
  };
  return {
    service: makeR2ObjectStorageWithBoundary(config, boundary, { conditionalDelete: true }),
    corrupt: (_key: string, replacement: Uint8Array) => {
      if (stored === undefined) throw new Error("strict object must exist before corruption");
      stored = { ...stored, bytes: replacement.slice() };
    },
  };
};

const adapters = [
  { name: "memory", make: () => makeMemoryObjectStorage(1_024) },
  { name: "strict-r2-boundary", make: strictR2 },
] as const;

for (const adapter of adapters) {
  it.effect(`${adapter.name} satisfies immutable integrity and conditional-delete semantics`, () =>
    Effect.gen(function* () {
      const harness = adapter.make();
      const storage = harness.service;
      const created = yield* storage.putImmutable({
        key: "v1/conformance",
        body: body(),
        byteLength: bytes.byteLength,
        sha256,
        mediaType: "text/plain",
      });
      expect(created.disposition).toBe("created");
      const duplicate = yield* storage.putImmutable({
        key: "v1/conformance",
        body: body(),
        byteLength: bytes.byteLength,
        sha256,
        mediaType: "text/plain",
      });
      expect(duplicate.disposition).toBe("existing");
      const conflict = yield* Effect.result(
        storage.putImmutable({
          key: "v1/conformance",
          body: body(),
          byteLength: bytes.byteLength,
          sha256: "f".repeat(64),
          mediaType: "text/plain",
        }),
      );
      expect(Result.isFailure(conflict)).toBe(true);
      harness.corrupt("v1/conformance", new Uint8Array(bytes.byteLength).fill(7));
      const corruptedDuplicate = yield* Effect.result(
        storage.putImmutable({
          key: "v1/conformance",
          body: body(),
          byteLength: bytes.byteLength,
          sha256,
          mediaType: "text/plain",
        }),
      );
      expect(Result.isFailure(corruptedDuplicate)).toBe(true);
      harness.corrupt("v1/conformance", bytes);
      yield* storage.delete("v1/conformance", created);
      yield* storage.delete("v1/conformance", created);
      expect(yield* storage.head("v1/conformance")).toBeUndefined();
    }),
  );

  it.effect(`${adapter.name} never replaces an object during concurrent immutable puts`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const identicalHarness = adapter.make();
        const identicalStarted = Promise.withResolvers<void>();
        const releaseIdentical = Promise.withResolvers<void>();
        const firstIdentical = yield* Effect.forkChild(
          identicalHarness.service.putImmutable({
            key: "v1/concurrent-identical",
            body: (async function* () {
              identicalStarted.resolve();
              await releaseIdentical.promise;
              yield bytes;
            })(),
            byteLength: bytes.byteLength,
            sha256,
            mediaType: "text/plain",
          }),
        );
        yield* Effect.promise(() => identicalStarted.promise);
        const secondIdentical = yield* Effect.forkChild(
          identicalHarness.service.putImmutable({
            key: "v1/concurrent-identical",
            body: body(),
            byteLength: bytes.byteLength,
            sha256,
            mediaType: "text/plain",
          }),
        );
        yield* Effect.yieldNow;
        releaseIdentical.resolve();
        const identical = yield* Effect.all([
          Fiber.join(firstIdentical),
          Fiber.join(secondIdentical),
        ]);
        expect(identical.map((result) => result.disposition).sort()).toEqual([
          "created",
          "existing",
        ]);

        const conflictHarness = adapter.make();
        const conflictStarted = Promise.withResolvers<void>();
        const releaseConflict = Promise.withResolvers<void>();
        const replacement = new TextEncoder().encode("replacement object");
        const replacementSha256 = NodeCrypto.createHash("sha256").update(replacement).digest("hex");
        const firstConflict = yield* Effect.forkChild(
          conflictHarness.service.putImmutable({
            key: "v1/concurrent-conflict",
            body: (async function* () {
              conflictStarted.resolve();
              await releaseConflict.promise;
              yield bytes;
            })(),
            byteLength: bytes.byteLength,
            sha256,
            mediaType: "text/plain",
          }),
        );
        yield* Effect.promise(() => conflictStarted.promise);
        const secondConflict = yield* Effect.forkChild(
          Effect.result(
            conflictHarness.service.putImmutable({
              key: "v1/concurrent-conflict",
              body: (async function* () {
                yield replacement;
              })(),
              byteLength: replacement.byteLength,
              sha256: replacementSha256,
              mediaType: "text/plain",
            }),
          ),
        );
        yield* Effect.yieldNow;
        releaseConflict.resolve();
        expect((yield* Fiber.join(firstConflict)).disposition).toBe("created");
        const conflict = yield* Fiber.join(secondConflict);
        expect(Result.isFailure(conflict)).toBe(true);
        if (Result.isFailure(conflict)) expect(conflict.failure.code).toBe("conflict");

        const stored = yield* conflictHarness.service.get("v1/concurrent-conflict");
        const verified = yield* Effect.promise(() =>
          readBoundedAndHash(stored.body, conflictHarness.service.maxArtifactBytes),
        );
        expect(verified.bytes).toEqual(bytes);
        expect(verified.sha256).toBe(sha256);
      }),
    ),
  );
}
