import type { ThreadId } from "@t3tools/contracts";
import type { WorkspaceId } from "@t3tools/contracts/cloud";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { R2ArtifactConfig } from "./artifactConfig.ts";
import {
  ArtifactRepositoryError,
  makeMemoryArtifactRepository,
  makePostgresArtifactRepository,
  type ArtifactRecord,
  type ArtifactRepository,
} from "./artifactRepository.ts";
import {
  artifactObjectKey,
  threadExportObjectKey,
  validateArtifactKeyIdentity,
  type ArtifactKind,
} from "./artifactKeys.ts";
import { Database } from "./database.ts";
import {
  makeMemoryObjectStorage,
  makeR2ObjectStorage,
  ObjectStoreError,
  readBoundedAndHash,
  type ArtifactByteSource,
  type ObjectStorage,
} from "./r2ObjectStore.ts";

export class ArtifactStorageError extends Schema.TaggedErrorClass<ArtifactStorageError>()(
  "ArtifactStorageError",
  {
    code: Schema.Literals([
      "notFound",
      "tenantMismatch",
      "conflict",
      "invalidInput",
      "tooLarge",
      "integrity",
      "timeout",
      "unavailable",
    ]),
    operation: Schema.String,
    retryable: Schema.Boolean,
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {}

export interface UploadArtifactInput {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly artifactId: string;
  readonly idempotencyKey: string;
  readonly kind: ArtifactKind;
  readonly byteLength: number;
  readonly sha256: string;
  readonly mediaType: string;
  readonly body: ArtifactByteSource;
  readonly retentionUntil?: string;
  readonly expiresAt?: string;
  readonly signal?: AbortSignal;
}

export interface ArtifactStorageService {
  readonly upload: (
    input: UploadArtifactInput,
  ) => Effect.Effect<
    { readonly disposition: "created" | "existing"; readonly artifact: ArtifactRecord },
    ArtifactStorageError
  >;
  readonly download: (
    workspaceId: WorkspaceId,
    threadId: ThreadId,
    artifactId: string,
    signal?: AbortSignal,
  ) => Effect.Effect<
    { readonly artifact: ArtifactRecord; readonly bytes: Uint8Array },
    ArtifactStorageError
  >;
  readonly reconcile: (
    workspaceId: WorkspaceId,
    threadId: ThreadId,
    artifactId: string,
    signal?: AbortSignal,
  ) => Effect.Effect<ArtifactRecord, ArtifactStorageError>;
  readonly delete: (
    workspaceId: WorkspaceId,
    threadId: ThreadId,
    artifactId: string,
    signal?: AbortSignal,
  ) => Effect.Effect<"deleted" | "already-deleted", ArtifactStorageError>;
  readonly list: (
    workspaceId: WorkspaceId,
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<ArtifactRecord>, ArtifactStorageError>;
}

export class ArtifactStorage extends Context.Service<ArtifactStorage, ArtifactStorageService>()(
  "@agentsin-cloud/control-plane/artifactStorage",
) {}

const failure = (
  code: ArtifactStorageError["code"],
  operation: string,
  retryable: boolean,
  cause?: unknown,
) =>
  new ArtifactStorageError({
    code,
    operation,
    retryable,
    ...(cause === undefined ? {} : { cause }),
  });
const isArtifactStorageError = Schema.is(ArtifactStorageError);
const isObjectStoreError = Schema.is(ObjectStoreError);

const fromRepositoryError = (cause: ArtifactRepositoryError, operation: string) =>
  failure(
    cause.code === "databaseFailure" ? "unavailable" : cause.code,
    operation,
    cause.retryable,
    cause,
  );

const fromObjectStoreError = (cause: ObjectStoreError, operation: string) =>
  failure(cause.code === "io" ? "unavailable" : cause.code, operation, cause.retryable, cause);

const validMediaType = (value: string) =>
  value.length <= 255 &&
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:; ?[a-z0-9!#$&^_.+-]+=[A-Za-z0-9!#$&^_.+-]+)*$/i.test(
    value,
  );

const decodeInstant = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString);
const canonicalUtcInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const parseInstant = (value: string) => {
  if (!canonicalUtcInstant.test(value)) return undefined;
  try {
    const instant = decodeInstant(value);
    return {
      canonical: DateTime.formatIso(instant),
      epochMillis: DateTime.toEpochMillis(instant),
    };
  } catch {
    return undefined;
  }
};

const validateUpload = (input: UploadArtifactInput, maximumBytes: number) =>
  Effect.try({
    try: () => {
      const retentionUntil =
        input.retentionUntil === undefined ? undefined : parseInstant(input.retentionUntil);
      const expiresAt = input.expiresAt === undefined ? undefined : parseInstant(input.expiresAt);
      validateArtifactKeyIdentity(input.workspaceId, "workspaceId");
      validateArtifactKeyIdentity(input.threadId, "threadId");
      validateArtifactKeyIdentity(input.artifactId, "artifactId");
      validateArtifactKeyIdentity(input.idempotencyKey, "idempotencyKey");
      if (
        !Number.isSafeInteger(input.byteLength) ||
        input.byteLength < 0 ||
        input.byteLength > maximumBytes ||
        !/^[0-9a-f]{64}$/.test(input.sha256) ||
        !validMediaType(input.mediaType) ||
        (input.retentionUntil !== undefined && retentionUntil === undefined) ||
        (input.expiresAt !== undefined && expiresAt === undefined) ||
        (retentionUntil !== undefined &&
          expiresAt !== undefined &&
          retentionUntil.epochMillis > expiresAt.epochMillis)
      ) {
        throw failure(
          input.byteLength > maximumBytes ? "tooLarge" : "invalidInput",
          "validate-upload",
          false,
        );
      }
      return {
        objectKey:
          input.kind === "thread-export"
            ? threadExportObjectKey(input, input.artifactId, input.sha256)
            : artifactObjectKey(input, input.kind, input.artifactId, input.sha256),
        ...(retentionUntil === undefined ? {} : { retentionUntil: retentionUntil.canonical }),
        ...(expiresAt === undefined ? {} : { expiresAt: expiresAt.canonical }),
      };
    },
    catch: (cause) =>
      isArtifactStorageError(cause)
        ? cause
        : failure("invalidInput", "validate-upload", false, cause),
  });

const exactObject = (
  record: ArtifactRecord,
  object: { readonly byteLength: number; readonly sha256: string; readonly mediaType: string },
) =>
  record.byteLength === object.byteLength &&
  record.sha256 === object.sha256 &&
  record.mediaType === object.mediaType;

export const makeArtifactStorage = (options: {
  readonly repository: ArtifactRepository;
  readonly objects: ObjectStorage;
  readonly clock?: { readonly now: () => string };
}): ArtifactStorageService => {
  const now = options.clock?.now ?? (() => DateTime.formatIso(DateTime.nowUnsafe()));
  return {
    upload: (input) =>
      Effect.gen(function* () {
        const validated = yield* validateUpload(input, options.objects.maxArtifactBytes);
        const createdAt = now();
        const reservation = yield* options.repository
          .reserve({
            workspaceId: input.workspaceId,
            threadId: input.threadId,
            artifactId: input.artifactId,
            idempotencyKey: input.idempotencyKey,
            kind: input.kind,
            objectKey: validated.objectKey,
            byteLength: input.byteLength,
            sha256: input.sha256,
            mediaType: input.mediaType,
            ...(validated.retentionUntil === undefined
              ? {}
              : { retentionUntil: validated.retentionUntil }),
            ...(validated.expiresAt === undefined ? {} : { expiresAt: validated.expiresAt }),
            createdAt,
          })
          .pipe(Effect.mapError((cause) => fromRepositoryError(cause, "reserve-artifact")));
        if (reservation.record.state === "complete") {
          return { disposition: "existing" as const, artifact: reservation.record };
        }
        const uploading = yield* options.repository
          .markUploading(input.workspaceId, input.threadId, input.artifactId, now())
          .pipe(Effect.mapError((cause) => fromRepositoryError(cause, "mark-artifact-uploading")));
        if (uploading.state === "complete") {
          return { disposition: "existing" as const, artifact: uploading };
        }
        const object = yield* options.objects
          .putImmutable({
            key: uploading.objectKey,
            body: input.body,
            byteLength: uploading.byteLength,
            sha256: uploading.sha256,
            mediaType: uploading.mediaType,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          })
          .pipe(
            Effect.mapError((cause) => fromObjectStoreError(cause, "upload-artifact")),
            Effect.tapError((cause) =>
              options.repository
                .fail(input.workspaceId, input.threadId, input.artifactId, cause.code, now())
                .pipe(Effect.catch(() => Effect.void)),
            ),
          );
        const artifact = yield* options.repository
          .complete(
            input.workspaceId,
            input.threadId,
            input.artifactId,
            {
              etag: object.etag,
              ...(object.versionId === undefined ? {} : { versionId: object.versionId }),
            },
            now(),
          )
          .pipe(Effect.mapError((cause) => fromRepositoryError(cause, "complete-artifact")));
        return {
          disposition:
            reservation.disposition === "existing" || object.disposition === "existing"
              ? "existing"
              : "created",
          artifact,
        };
      }),
    download: (workspaceId, threadId, artifactId, signal) =>
      Effect.gen(function* () {
        validateArtifactKeyIdentity(artifactId, "artifactId");
        const artifact = yield* options.repository
          .get(workspaceId, threadId, artifactId)
          .pipe(Effect.mapError((cause) => fromRepositoryError(cause, "get-artifact")));
        if (artifact === undefined || artifact.state !== "complete") {
          return yield* failure("notFound", "download-artifact", false);
        }
        const object = yield* options.objects
          .get(artifact.objectKey, signal)
          .pipe(Effect.mapError((cause) => fromObjectStoreError(cause, "download-artifact")));
        if (!exactObject(artifact, object)) {
          return yield* failure("integrity", "download-artifact", false);
        }
        const downloaded = yield* Effect.tryPromise({
          try: () => readBoundedAndHash(object.body, options.objects.maxArtifactBytes, signal),
          catch: (cause) =>
            isObjectStoreError(cause)
              ? fromObjectStoreError(cause, "download-artifact")
              : failure("unavailable", "download-artifact", true, cause),
        });
        if (
          downloaded.byteLength !== artifact.byteLength ||
          downloaded.sha256 !== artifact.sha256
        ) {
          return yield* failure("integrity", "download-artifact", false);
        }
        return { artifact, bytes: downloaded.bytes };
      }),
    reconcile: (workspaceId, threadId, artifactId, signal) =>
      Effect.gen(function* () {
        const artifact = yield* options.repository
          .get(workspaceId, threadId, artifactId)
          .pipe(Effect.mapError((cause) => fromRepositoryError(cause, "reconcile-artifact")));
        if (artifact === undefined) {
          return yield* failure("notFound", "reconcile-artifact", false);
        }
        if (artifact.state === "complete") return artifact;
        if (!["reserved", "uploading", "failed"].includes(artifact.state)) {
          return yield* failure("conflict", "reconcile-artifact", false);
        }
        const object = yield* options.objects
          .get(artifact.objectKey, signal)
          .pipe(Effect.mapError((cause) => fromObjectStoreError(cause, "reconcile-artifact")));
        if (!exactObject(artifact, object)) {
          yield* options.repository
            .fail(workspaceId, threadId, artifactId, "integrity", now())
            .pipe(Effect.catch(() => Effect.void));
          return yield* failure("integrity", "reconcile-artifact", false);
        }
        const downloaded = yield* Effect.tryPromise({
          try: () => readBoundedAndHash(object.body, options.objects.maxArtifactBytes, signal),
          catch: (cause) =>
            isObjectStoreError(cause)
              ? fromObjectStoreError(cause, "reconcile-artifact")
              : failure("unavailable", "reconcile-artifact", true, cause),
        });
        if (
          downloaded.byteLength !== artifact.byteLength ||
          downloaded.sha256 !== artifact.sha256
        ) {
          yield* options.repository
            .fail(workspaceId, threadId, artifactId, "integrity", now())
            .pipe(Effect.catch(() => Effect.void));
          return yield* failure("integrity", "reconcile-artifact", false);
        }
        return yield* options.repository
          .complete(
            workspaceId,
            threadId,
            artifactId,
            {
              etag: object.etag,
              ...(object.versionId === undefined ? {} : { versionId: object.versionId }),
            },
            now(),
          )
          .pipe(Effect.mapError((cause) => fromRepositoryError(cause, "reconcile-artifact")));
      }),
    delete: (workspaceId, threadId, artifactId, signal) =>
      Effect.gen(function* () {
        if (!options.objects.supportsConditionalDelete) {
          const current = yield* options.repository
            .get(workspaceId, threadId, artifactId)
            .pipe(Effect.mapError((cause) => fromRepositoryError(cause, "delete-artifact")));
          if (current === undefined) return yield* failure("notFound", "delete-artifact", false);
          if (current.state === "deleted") return "already-deleted" as const;
          return yield* failure("conflict", "conditional-delete-unsupported", false);
        }
        const artifact = yield* options.repository
          .beginDelete(workspaceId, threadId, artifactId, now())
          .pipe(Effect.mapError((cause) => fromRepositoryError(cause, "delete-artifact")));
        if (artifact.state === "deleted") return "already-deleted" as const;
        if (artifact.etag === undefined) {
          return yield* failure("integrity", "delete-artifact", false);
        }
        yield* options.objects
          .delete(
            artifact.objectKey,
            {
              byteLength: artifact.byteLength,
              sha256: artifact.sha256,
              etag: artifact.etag,
              ...(artifact.objectVersion === undefined
                ? {}
                : { versionId: artifact.objectVersion }),
            },
            signal,
          )
          .pipe(Effect.mapError((cause) => fromObjectStoreError(cause, "delete-artifact")));
        yield* options.repository
          .markDeleted(workspaceId, threadId, artifactId, now())
          .pipe(Effect.mapError((cause) => fromRepositoryError(cause, "delete-artifact")));
        return "deleted" as const;
      }),
    list: (workspaceId, threadId) =>
      options.repository
        .listComplete(workspaceId, threadId)
        .pipe(Effect.mapError((cause) => fromRepositoryError(cause, "list-artifacts"))),
  };
};

export const makeProductionArtifactStorage = Effect.fn("ArtifactStorage.production")(function* () {
  const config = yield* R2ArtifactConfig;
  const database = yield* Database;
  return ArtifactStorage.of(
    makeArtifactStorage({
      repository: makePostgresArtifactRepository(database),
      objects: makeR2ObjectStorage(config),
    }),
  );
});

export const productionArtifactStorageLayer = Layer.effect(
  ArtifactStorage,
  makeProductionArtifactStorage(),
);

export const makeMemoryArtifactStorage = (options: {
  readonly maxArtifactBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly authorizedThreads: ReadonlyArray<{
    readonly workspaceId: WorkspaceId;
    readonly threadId: ThreadId;
  }>;
}) => {
  const objects = makeMemoryObjectStorage(options.maxArtifactBytes, options.requestTimeoutMs);
  const repository = makeMemoryArtifactRepository(options.authorizedThreads);
  return {
    service: makeArtifactStorage({
      repository,
      objects: objects.service,
      clock: { now: () => "2026-08-27T00:00:00.000Z" },
    }),
    objects,
    repository,
  };
};
