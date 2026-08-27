// @effect-diagnostics globalTimers:off -- AbortSignal.timeout enforces the configured object-store deadline.
// @effect-diagnostics nodeBuiltinImport:off -- SHA-256 verifies streamed object payloads at the adapter boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeStream from "node:stream";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type {
  DeleteObjectCommandInput,
  DeleteObjectCommandOutput,
  GetObjectCommandInput,
  GetObjectCommandOutput,
  HeadObjectCommandInput,
  HeadObjectCommandOutput,
  PutObjectCommandInput,
  PutObjectCommandOutput,
} from "@aws-sdk/client-s3";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { R2ArtifactConfigShape } from "./artifactConfig.ts";

export class ObjectStoreError extends Schema.TaggedErrorClass<ObjectStoreError>()(
  "ObjectStoreError",
  {
    code: Schema.Literals(["notFound", "conflict", "tooLarge", "integrity", "timeout", "io"]),
    operation: Schema.String,
    retryable: Schema.Boolean,
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {}

export type ArtifactByteSource = AsyncIterable<Uint8Array>;

export interface ObjectMetadata {
  readonly byteLength: number;
  readonly sha256: string;
  readonly mediaType: string;
  readonly etag: string;
  readonly versionId?: string;
}

export interface ObjectWriteRequest extends Pick<
  ObjectMetadata,
  "byteLength" | "sha256" | "mediaType"
> {
  readonly key: string;
  readonly body: ArtifactByteSource;
  readonly signal?: AbortSignal;
}

export interface ObjectReadResult extends ObjectMetadata {
  readonly body: ArtifactByteSource;
}

export interface ObjectStorage {
  readonly bucket: string;
  readonly maxArtifactBytes: number;
  readonly supportsConditionalDelete: boolean;
  readonly putImmutable: (
    request: ObjectWriteRequest,
  ) => Effect.Effect<
    { readonly disposition: "created" | "existing" } & ObjectMetadata,
    ObjectStoreError
  >;
  readonly head: (
    key: string,
    signal?: AbortSignal,
  ) => Effect.Effect<ObjectMetadata | undefined, ObjectStoreError>;
  readonly get: (
    key: string,
    signal?: AbortSignal,
  ) => Effect.Effect<ObjectReadResult, ObjectStoreError>;
  readonly delete: (
    key: string,
    expected: Pick<ObjectMetadata, "byteLength" | "sha256" | "etag" | "versionId">,
    signal?: AbortSignal,
  ) => Effect.Effect<void, ObjectStoreError>;
}

const failure = (
  code: ObjectStoreError["code"],
  operation: string,
  retryable: boolean,
  cause?: unknown,
) =>
  new ObjectStoreError({ code, operation, retryable, ...(cause === undefined ? {} : { cause }) });
const isObjectStoreError = Schema.is(ObjectStoreError);

const ITERATOR_CLEANUP_TIMEOUT_MS = 100;

const closeIteratorBestEffort = async (iterator: AsyncIterator<Uint8Array>) => {
  if (iterator.return === undefined) return;
  let cleanup: Promise<unknown>;
  try {
    cleanup = Promise.resolve(iterator.return());
  } catch {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cleanup.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ITERATOR_CLEANUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const nextWithSignal = (
  iterator: AsyncIterator<Uint8Array>,
  signal?: AbortSignal,
): Promise<IteratorResult<Uint8Array>> => {
  if (signal?.aborted) {
    return Promise.reject(failure("timeout", "read-object-body", true, signal.reason));
  }
  let pending: Promise<IteratorResult<Uint8Array>>;
  try {
    pending = Promise.resolve(iterator.next());
  } catch (cause) {
    return Promise.reject(cause);
  }
  if (signal === undefined) return pending;
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(failure("timeout", "read-object-body", true, signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (result) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (cause: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(cause);
      },
    );
    if (signal.aborted) onAbort();
  });
};

export const readBoundedAndHash = async (
  source: ArtifactByteSource,
  maximumBytes: number,
  signal?: AbortSignal,
) => {
  const chunks: Array<Uint8Array> = [];
  const hash = NodeCrypto.createHash("sha256");
  let byteLength = 0;
  const iterator = source[Symbol.asyncIterator]();
  let exhausted = false;
  try {
    for (;;) {
      const item = await nextWithSignal(iterator, signal);
      if (item.done) {
        exhausted = true;
        break;
      }
      const chunk = item.value;
      if (!(chunk instanceof Uint8Array)) {
        throw failure("integrity", "read-object-body", false, "body yielded a non-byte chunk");
      }
      byteLength += chunk.byteLength;
      if (byteLength > maximumBytes) throw failure("tooLarge", "read-object-body", false);
      hash.update(chunk);
      chunks.push(chunk);
    }
  } finally {
    if (!exhausted) await closeIteratorBestEffort(iterator);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, byteLength, sha256: hash.digest("hex") };
};

const bodyFromBytes = async function* (bytes: Uint8Array): ArtifactByteSource {
  yield bytes;
};

const sameMetadata = (
  left: Pick<ObjectMetadata, "byteLength" | "sha256" | "mediaType">,
  right: Pick<ObjectMetadata, "byteLength" | "sha256" | "mediaType">,
) =>
  left.byteLength === right.byteLength &&
  left.sha256 === right.sha256 &&
  left.mediaType === right.mediaType;

interface MemoryObjectStorageHarness {
  readonly service: ObjectStorage;
  readonly corrupt: (key: string, bytes: Uint8Array) => void;
  readonly keys: () => ReadonlyArray<string>;
}

/** Strict deterministic object boundary for local development and tests. */
export const makeMemoryObjectStorage = (
  maxArtifactBytes = 16 * 1_024 * 1_024,
  requestTimeoutMs = 30_000,
): MemoryObjectStorageHarness => {
  const objects = new Map<
    string,
    { readonly metadata: ObjectMetadata; readonly bytes: Uint8Array }
  >();
  const writeTails = new Map<string, Promise<void>>();
  const serializeWrite = async <A>(key: string, task: () => Promise<A>) => {
    const previous = writeTails.get(key) ?? Promise.resolve();
    const current = Promise.withResolvers<void>();
    writeTails.set(key, current.promise);
    await previous;
    try {
      return await task();
    } finally {
      current.resolve();
      if (writeTails.get(key) === current.promise) writeTails.delete(key);
    }
  };
  const service: ObjectStorage = {
    bucket: "memory-artifacts",
    maxArtifactBytes,
    supportsConditionalDelete: true,
    putImmutable: (request) =>
      Effect.tryPromise({
        try: async () => {
          const boundedSignal = timeoutSignal(requestTimeoutMs, request.signal);
          return serializeWrite(request.key, async () => {
            if (request.byteLength > maxArtifactBytes) {
              throw failure("tooLarge", "put-immutable", false);
            }
            const existing = objects.get(request.key);
            if (existing !== undefined) {
              if (!sameMetadata(existing.metadata, request)) {
                throw failure("conflict", "put-immutable", false);
              }
              const verified = await readBoundedAndHash(
                bodyFromBytes(existing.bytes),
                maxArtifactBytes,
                boundedSignal,
              );
              if (
                verified.byteLength !== request.byteLength ||
                verified.sha256 !== request.sha256
              ) {
                throw failure("conflict", "put-immutable", false);
              }
              return { disposition: "existing" as const, ...existing.metadata };
            }
            const read = await readBoundedAndHash(request.body, maxArtifactBytes, boundedSignal);
            if (read.byteLength !== request.byteLength || read.sha256 !== request.sha256) {
              throw failure("integrity", "put-immutable", false);
            }
            const metadata: ObjectMetadata = {
              byteLength: request.byteLength,
              sha256: request.sha256,
              mediaType: request.mediaType,
              etag: `"${request.sha256}"`,
              versionId: `memory-${request.sha256}`,
            };
            objects.set(request.key, { metadata, bytes: read.bytes.slice() });
            return { disposition: "created" as const, ...metadata };
          });
        },
        catch: (cause) =>
          isObjectStoreError(cause) ? cause : failure("io", "put-immutable", true, cause),
      }),
    head: (key, signal) => {
      const boundedSignal = timeoutSignal(requestTimeoutMs, signal);
      return boundedSignal.aborted
        ? Effect.fail(failure("timeout", "head-object", true, boundedSignal.reason))
        : Effect.succeed(objects.get(key)?.metadata);
    },
    get: (key, signal) => {
      const boundedSignal = timeoutSignal(requestTimeoutMs, signal);
      if (boundedSignal.aborted) {
        return Effect.fail(failure("timeout", "get-object", true, boundedSignal.reason));
      }
      const object = objects.get(key);
      return object === undefined
        ? Effect.fail(failure("notFound", "get-object", false))
        : Effect.succeed({
            ...object.metadata,
            body: deadlineBody(bodyFromBytes(object.bytes.slice()), boundedSignal),
          });
    },
    delete: (key, expected, signal) => {
      const boundedSignal = timeoutSignal(requestTimeoutMs, signal);
      if (boundedSignal.aborted) {
        return Effect.fail(failure("timeout", "delete-object", true, boundedSignal.reason));
      }
      const object = objects.get(key);
      if (object === undefined) return Effect.void;
      if (
        object.metadata.byteLength !== expected.byteLength ||
        object.metadata.sha256 !== expected.sha256 ||
        object.metadata.etag !== expected.etag ||
        object.metadata.versionId !== expected.versionId
      ) {
        return Effect.fail(failure("conflict", "delete-object", false));
      }
      objects.delete(key);
      return Effect.void;
    },
  };
  return {
    service,
    corrupt: (key, bytes) => {
      const object = objects.get(key);
      if (object !== undefined) objects.set(key, { ...object, bytes: bytes.slice() });
    },
    keys: () => [...objects.keys()].sort(),
  };
};

const httpStatus = (cause: unknown) => {
  if (typeof cause !== "object" || cause === null || !("$metadata" in cause)) return undefined;
  const metadata = cause.$metadata;
  if (typeof metadata !== "object" || metadata === null || !("httpStatusCode" in metadata)) {
    return undefined;
  }
  return typeof metadata.httpStatusCode === "number" ? metadata.httpStatusCode : undefined;
};

const toObjectMetadata = (input: {
  readonly ContentLength?: number | undefined;
  readonly ContentType?: string | undefined;
  readonly ETag?: string | undefined;
  readonly VersionId?: string | undefined;
  readonly Metadata?: Record<string, string> | undefined;
}): ObjectMetadata | undefined => {
  const sha256 = input.Metadata?.["sha256"];
  if (
    input.ContentLength === undefined ||
    input.ContentType === undefined ||
    input.ETag === undefined ||
    sha256 === undefined
  ) {
    return undefined;
  }
  return {
    byteLength: input.ContentLength,
    sha256,
    mediaType: input.ContentType,
    etag: input.ETag,
    ...(input.VersionId === undefined ? {} : { versionId: input.VersionId }),
  };
};

const timeoutSignal = (timeoutMs: number, signal?: AbortSignal) =>
  signal === undefined
    ? AbortSignal.timeout(timeoutMs)
    : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);

const deadlineBody = (source: ArtifactByteSource, signal: AbortSignal): ArtifactByteSource =>
  (async function* () {
    const iterator = source[Symbol.asyncIterator]();
    let exhausted = false;
    try {
      for (;;) {
        const item = await nextWithSignal(iterator, signal);
        if (item.done) {
          exhausted = true;
          return;
        }
        yield item.value;
      }
    } finally {
      if (!exhausted) await closeIteratorBestEffort(iterator);
    }
  })();

const ioFailure = (cause: unknown, operation: string, signal?: AbortSignal) => {
  const name =
    typeof cause === "object" && cause !== null && "name" in cause ? cause.name : undefined;
  return signal?.aborted || name === "AbortError" || name === "TimeoutError"
    ? failure("timeout", operation, true, cause)
    : failure("io", operation, true, cause);
};

export interface R2ObjectBoundary {
  readonly head: (
    input: HeadObjectCommandInput,
    signal: AbortSignal,
  ) => Promise<HeadObjectCommandOutput>;
  readonly put: (
    input: PutObjectCommandInput,
    signal: AbortSignal,
  ) => Promise<PutObjectCommandOutput>;
  readonly get: (
    input: GetObjectCommandInput,
    signal: AbortSignal,
  ) => Promise<GetObjectCommandOutput>;
  readonly delete: (
    input: DeleteObjectCommandInput,
    signal: AbortSignal,
  ) => Promise<DeleteObjectCommandOutput>;
}

const verifiedUploadBody = (options: {
  readonly source: ArtifactByteSource;
  readonly expectedByteLength: number;
  readonly expectedSha256: string;
  readonly maximumBytes: number;
  readonly signal: AbortSignal;
}): ArtifactByteSource =>
  (async function* () {
    const hash = NodeCrypto.createHash("sha256");
    let byteLength = 0;
    for await (const chunk of options.source) {
      if (options.signal.aborted) {
        throw failure("timeout", "put-object-body", true, options.signal.reason);
      }
      if (!(chunk instanceof Uint8Array)) {
        throw failure("integrity", "put-object-body", false, "body yielded a non-byte chunk");
      }
      byteLength += chunk.byteLength;
      if (byteLength > options.maximumBytes) {
        throw failure("tooLarge", "put-object-body", false);
      }
      hash.update(chunk);
      yield chunk;
    }
    if (
      byteLength !== options.expectedByteLength ||
      hash.digest("hex") !== options.expectedSha256
    ) {
      throw failure("integrity", "put-object-body", false);
    }
  })();

const makeAwsR2Boundary = (client: S3Client): R2ObjectBoundary => ({
  head: (input, signal) => client.send(new HeadObjectCommand(input), { abortSignal: signal }),
  put: (input, signal) => client.send(new PutObjectCommand(input), { abortSignal: signal }),
  get: (input, signal) => client.send(new GetObjectCommand(input), { abortSignal: signal }),
  delete: (input, signal) => client.send(new DeleteObjectCommand(input), { abortSignal: signal }),
});

/** Injectable R2 adapter boundary used to prove streamed integrity without network access. */
export const makeR2ObjectStorageWithBoundary = (
  config: R2ArtifactConfigShape,
  boundary: R2ObjectBoundary,
  capabilities: { readonly conditionalDelete: boolean } = { conditionalDelete: false },
): ObjectStorage => {
  const head = (key: string, signal?: AbortSignal) => {
    const boundedSignal = timeoutSignal(config.requestTimeoutMs, signal);
    return Effect.tryPromise({
      try: async () => {
        try {
          const response = await boundary.head({ Bucket: config.bucket, Key: key }, boundedSignal);
          const metadata = toObjectMetadata(response);
          if (metadata === undefined) throw failure("integrity", "head-object", false);
          return metadata;
        } catch (cause) {
          if (httpStatus(cause) === 404) return undefined;
          throw cause;
        }
      },
      catch: (cause) =>
        isObjectStoreError(cause) ? cause : ioFailure(cause, "head-object", boundedSignal),
    });
  };

  const getWithSignal = async (key: string, boundedSignal: AbortSignal) => {
    const response = await boundary.get({ Bucket: config.bucket, Key: key }, boundedSignal);
    const metadata = toObjectMetadata(response);
    if (metadata === undefined || response.Body === undefined) {
      throw failure("integrity", "get-object", false);
    }
    return {
      ...metadata,
      body: deadlineBody(response.Body as ArtifactByteSource, boundedSignal),
    };
  };

  return {
    bucket: config.bucket,
    maxArtifactBytes: config.maxArtifactBytes,
    supportsConditionalDelete: capabilities.conditionalDelete,
    putImmutable: (request) => {
      const boundedSignal = timeoutSignal(config.requestTimeoutMs, request.signal);
      return Effect.tryPromise({
        try: async () => {
          if (request.byteLength > config.maxArtifactBytes) {
            throw failure("tooLarge", "put-immutable", false);
          }
          try {
            const response = await boundary.put(
              {
                Bucket: config.bucket,
                Key: request.key,
                Body: NodeStream.Readable.from(
                  verifiedUploadBody({
                    source: deadlineBody(request.body, boundedSignal),
                    expectedByteLength: request.byteLength,
                    expectedSha256: request.sha256,
                    maximumBytes: config.maxArtifactBytes,
                    signal: boundedSignal,
                  }),
                ),
                ContentLength: request.byteLength,
                ContentType: request.mediaType,
                IfNoneMatch: "*",
                Metadata: { sha256: request.sha256 },
              },
              boundedSignal,
            );
            if (response.ETag === undefined) throw failure("integrity", "put-immutable", false);
            return {
              disposition: "created" as const,
              byteLength: request.byteLength,
              sha256: request.sha256,
              mediaType: request.mediaType,
              etag: response.ETag,
              ...(response.VersionId === undefined ? {} : { versionId: response.VersionId }),
            };
          } catch (cause) {
            if (httpStatus(cause) !== 412) throw cause;
            let existing: ObjectReadResult;
            try {
              existing = await getWithSignal(request.key, boundedSignal);
            } catch (readCause) {
              throw isObjectStoreError(readCause)
                ? readCause
                : ioFailure(readCause, "put-immutable", boundedSignal);
            }
            if (!sameMetadata(existing, request)) {
              throw failure("conflict", "put-immutable", false, cause);
            }
            let verified: Awaited<ReturnType<typeof readBoundedAndHash>>;
            try {
              verified = await readBoundedAndHash(
                existing.body,
                config.maxArtifactBytes,
                boundedSignal,
              );
            } catch (readCause) {
              throw isObjectStoreError(readCause)
                ? readCause
                : ioFailure(readCause, "put-immutable", boundedSignal);
            }
            if (verified.byteLength !== request.byteLength || verified.sha256 !== request.sha256) {
              throw failure("conflict", "put-immutable", false, cause);
            }
            const { body: _body, ...metadata } = existing;
            return { disposition: "existing" as const, ...metadata };
          }
        },
        catch: (cause) =>
          isObjectStoreError(cause) ? cause : ioFailure(cause, "put-immutable", boundedSignal),
      });
    },
    head,
    get: (key, signal) => {
      const boundedSignal = timeoutSignal(config.requestTimeoutMs, signal);
      return Effect.tryPromise({
        try: async () => {
          try {
            return await getWithSignal(key, boundedSignal);
          } catch (cause) {
            if (httpStatus(cause) === 404) throw failure("notFound", "get-object", false);
            throw cause;
          }
        },
        catch: (cause) =>
          isObjectStoreError(cause) ? cause : ioFailure(cause, "get-object", boundedSignal),
      });
    },
    delete: (key, expected, signal) => {
      if (!capabilities.conditionalDelete) {
        return Effect.fail(failure("conflict", "conditional-delete-unsupported", false));
      }
      const boundedSignal = timeoutSignal(config.requestTimeoutMs, signal);
      return Effect.tryPromise({
        try: async () => {
          try {
            await boundary.delete(
              {
                Bucket: config.bucket,
                Key: key,
                IfMatch: expected.etag,
                ...(expected.versionId === undefined ? {} : { VersionId: expected.versionId }),
              },
              boundedSignal,
            );
          } catch (cause) {
            const status = httpStatus(cause);
            if (status === 404) return;
            if (status !== 412) throw cause;
            try {
              await boundary.head({ Bucket: config.bucket, Key: key }, boundedSignal);
            } catch (headCause) {
              if (httpStatus(headCause) === 404) return;
              throw headCause;
            }
            throw failure("conflict", "delete-object", false, cause);
          }
        },
        catch: (cause) =>
          isObjectStoreError(cause) ? cause : ioFailure(cause, "delete-object", boundedSignal),
      }).pipe(Effect.asVoid);
    },
  };
};

/** Cloudflare R2 S3-compatible adapter with explicit, non-ambient credentials. */
export const makeR2ObjectStorage = (config: R2ArtifactConfigShape): ObjectStorage => {
  const client = new S3Client({
    endpoint: config.endpoint.toString(),
    region: config.region,
    forcePathStyle: true,
    maxAttempts: 2,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  // R2 does not currently document an atomic If-Match or version-specific
  // DeleteObject contract. Deletion therefore remains fail-closed until a
  // production capability probe can enable it without a TOCTOU window.
  return makeR2ObjectStorageWithBoundary(config, makeAwsR2Boundary(client));
};
