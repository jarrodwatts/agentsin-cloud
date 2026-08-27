// @effect-diagnostics nodeBuiltinImport:off -- Export manifests use audited SHA-256 and UTF-8 encoding.
import * as NodeCrypto from "node:crypto";

import type { ThreadId } from "@t3tools/contracts";
import type { WorkspaceId } from "@t3tools/contracts/cloud";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";

import type { ArtifactRecord } from "./artifactRepository.ts";
import { threadExportObjectKey, validateArtifactKeyIdentity } from "./artifactKeys.ts";
import type { ArtifactStorageService } from "./artifactStorage.ts";
import type { DatabaseService } from "./database.ts";

export const MAX_THREAD_EXPORT_RECORDS = 10_000;
export const MAX_THREAD_EXPORT_BYTES = 8 * 1_024 * 1_024;
const MAX_EXPORT_FIELD_BYTES = 1_024;

export interface ThreadExportRecord {
  readonly id: string;
  readonly sequence?: number;
  readonly timestamp: string;
}

export interface ThreadExportArtifact {
  readonly artifactId: string;
  readonly kind: ArtifactRecord["kind"];
  readonly objectKey: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly mediaType: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
}

export interface ThreadExportSnapshot {
  readonly commands: ReadonlyArray<ThreadExportRecord>;
  readonly events: ReadonlyArray<ThreadExportRecord>;
  readonly approvals: ReadonlyArray<ThreadExportRecord>;
  readonly checkpoints: ReadonlyArray<ThreadExportRecord>;
  readonly artifacts: ReadonlyArray<ThreadExportArtifact>;
}

export interface ThreadExportIntent {
  readonly createdAt: string;
  readonly snapshot: ThreadExportSnapshot;
}

export interface ThreadExportSource {
  readonly prepare: (input: {
    readonly workspaceId: WorkspaceId;
    readonly threadId: ThreadId;
    readonly exportId: string;
    readonly idempotencyKey: string;
    readonly createdAt: string;
    readonly signal?: AbortSignal;
  }) => Effect.Effect<ThreadExportIntent, ThreadExportError>;
}

export class ThreadExportError extends Schema.TaggedErrorClass<ThreadExportError>()(
  "ThreadExportError",
  {
    code: Schema.Literals([
      "notFound",
      "invalidRecord",
      "idempotencyConflict",
      "resourceLimit",
      "aborted",
      "databaseFailure",
      "storageFailure",
    ]),
    operation: Schema.String,
    retryable: Schema.Boolean,
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {}

const failure = (
  code: ThreadExportError["code"],
  operation: string,
  retryable: boolean,
  cause?: unknown,
) =>
  new ThreadExportError({ code, operation, retryable, ...(cause === undefined ? {} : { cause }) });
const isThreadExportError = Schema.is(ThreadExportError);

const validateExportStorageIdentity = (input: {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly exportId: string;
  readonly idempotencyKey: string;
}) => {
  try {
    validateArtifactKeyIdentity(input.idempotencyKey, "idempotencyKey");
    threadExportObjectKey(input, input.exportId, "0".repeat(64));
  } catch (cause) {
    throw failure("invalidRecord", "validate-thread-export-identity", false, cause);
  }
};

const compareCodeUnits = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

const canonicalJson = (value: Schema.Json): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const sha256 = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

const checkSignal = (signal?: AbortSignal) => {
  if (signal?.aborted) throw failure("aborted", "build-thread-export", true, signal.reason);
};

const boundedField = (value: string, field: string) => {
  if (
    value.length === 0 ||
    !value.isWellFormed() ||
    new TextEncoder().encode(value).byteLength > MAX_EXPORT_FIELD_BYTES
  ) {
    throw failure("invalidRecord", `validate-export-${field}`, false);
  }
  return value;
};

const decodeUtcInstant = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString);
const utcInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const normalizeUtcInstant = (value: string, field: string) => {
  if (!utcInstant.test(value)) {
    throw failure("invalidRecord", `validate-export-${field}`, false);
  }
  try {
    return DateTime.formatIso(decodeUtcInstant(value));
  } catch (cause) {
    throw failure("invalidRecord", `validate-export-${field}`, false, cause);
  }
};

/** Unknown provider payloads are never copied into portable exports. */
export const redactThreadExportValue = (_value: unknown): Schema.Json => ({
  omitted: "provider-shaped-payload",
});

const normalizeRecords = (records: ReadonlyArray<ThreadExportRecord>, signal?: AbortSignal) =>
  [...records]
    .sort(
      (left, right) =>
        (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER) ||
        compareCodeUnits(left.timestamp, right.timestamp) ||
        compareCodeUnits(left.id, right.id),
    )
    .map((record) => {
      checkSignal(signal);
      if (
        record.sequence !== undefined &&
        (!Number.isSafeInteger(record.sequence) || record.sequence < 0)
      ) {
        throw failure("invalidRecord", "validate-export-sequence", false);
      }
      return {
        id: boundedField(record.id, "id"),
        ...(record.sequence === undefined ? {} : { sequence: record.sequence }),
        timestamp: normalizeUtcInstant(record.timestamp, "timestamp"),
        payload: redactThreadExportValue(undefined),
      };
    });

export const buildThreadExport = (input: {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly exportId: string;
  readonly createdAt: string;
  readonly snapshot: ThreadExportSnapshot;
  readonly signal?: AbortSignal;
}) => {
  checkSignal(input.signal);
  const totalRecords =
    input.snapshot.commands.length +
    input.snapshot.events.length +
    input.snapshot.approvals.length +
    input.snapshot.checkpoints.length +
    input.snapshot.artifacts.length;
  if (totalRecords > MAX_THREAD_EXPORT_RECORDS) {
    throw failure("resourceLimit", "build-thread-export", false);
  }
  const artifacts = [...input.snapshot.artifacts]
    .filter((artifact) => artifact.kind !== "thread-export")
    .sort(
      (left, right) =>
        compareCodeUnits(left.createdAt, right.createdAt) ||
        compareCodeUnits(left.artifactId, right.artifactId),
    )
    .map((artifact) => {
      checkSignal(input.signal);
      return {
        artifactId: boundedField(artifact.artifactId, "artifact-id"),
        kind: artifact.kind,
        objectKey: boundedField(artifact.objectKey, "object-key"),
        byteLength: artifact.byteLength,
        sha256: artifact.sha256,
        mediaType: boundedField(artifact.mediaType, "media-type"),
        createdAt: normalizeUtcInstant(artifact.createdAt, "artifact-created-at"),
        ...(artifact.expiresAt === undefined
          ? {}
          : { expiresAt: normalizeUtcInstant(artifact.expiresAt, "artifact-expires-at") }),
      };
    });
  const records = {
    commands: normalizeRecords(input.snapshot.commands, input.signal),
    events: normalizeRecords(input.snapshot.events, input.signal),
    approvals: normalizeRecords(input.snapshot.approvals, input.signal),
    checkpoints: normalizeRecords(input.snapshot.checkpoints, input.signal),
  };
  const base = {
    schemaVersion: 1,
    exportId: boundedField(input.exportId, "export-id"),
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    createdAt: normalizeUtcInstant(input.createdAt, "created-at"),
    counts: {
      commands: records.commands.length,
      events: records.events.length,
      approvals: records.approvals.length,
      checkpoints: records.checkpoints.length,
      artifacts: artifacts.length,
    },
    records,
    artifacts,
  } satisfies Schema.Json;
  const canonicalBase = canonicalJson(base);
  if (new TextEncoder().encode(canonicalBase).byteLength > MAX_THREAD_EXPORT_BYTES) {
    throw failure("resourceLimit", "build-thread-export", false);
  }
  const contentDigest = sha256(canonicalBase);
  const manifest = {
    ...base,
    integrity: { algorithm: "sha256", contentDigest },
  } satisfies Schema.Json;
  const bytes = new TextEncoder().encode(canonicalJson(manifest));
  if (bytes.byteLength > MAX_THREAD_EXPORT_BYTES) {
    throw failure("resourceLimit", "build-thread-export", false);
  }
  return { manifest, bytes, sha256: sha256(bytes) };
};

export const createThreadExport = (options: {
  readonly source: ThreadExportSource;
  readonly storage: ArtifactStorageService;
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly exportId: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly signal?: AbortSignal;
}) =>
  Effect.gen(function* () {
    if (options.signal?.aborted) {
      return yield* failure("aborted", "prepare-thread-export", true, options.signal.reason);
    }
    yield* Effect.try({
      try: () => validateExportStorageIdentity(options),
      catch: (cause) => failure("invalidRecord", "validate-thread-export-identity", false, cause),
    });
    const createdAt = yield* Effect.try({
      try: () => normalizeUtcInstant(options.createdAt, "created-at"),
      catch: (cause) =>
        isThreadExportError(cause)
          ? cause
          : failure("invalidRecord", "validate-export-created-at", false, cause),
    });
    const intent = yield* options.source.prepare({
      workspaceId: options.workspaceId,
      threadId: options.threadId,
      exportId: options.exportId,
      idempotencyKey: options.idempotencyKey,
      createdAt,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const built = yield* Effect.try({
      try: () =>
        buildThreadExport({
          workspaceId: options.workspaceId,
          threadId: options.threadId,
          exportId: options.exportId,
          createdAt: intent.createdAt,
          snapshot: intent.snapshot,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
      catch: (cause) =>
        isThreadExportError(cause)
          ? cause
          : failure("invalidRecord", "build-thread-export", false, cause),
    });
    const body = async function* () {
      yield built.bytes;
    };
    const stored = yield* options.storage
      .upload({
        workspaceId: options.workspaceId,
        threadId: options.threadId,
        artifactId: options.exportId,
        idempotencyKey: options.idempotencyKey,
        kind: "thread-export",
        byteLength: built.bytes.byteLength,
        sha256: built.sha256,
        mediaType: "application/vnd.agentsin-cloud.thread-export+json",
        body: body(),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      .pipe(
        Effect.mapError((cause) =>
          failure("storageFailure", "store-thread-export", cause.retryable, cause),
        ),
      );
    return { ...built, artifact: stored.artifact, disposition: stored.disposition };
  });

interface ExportRow extends QueryResultRow {
  readonly id: string | null;
  readonly sequence: string | null;
  readonly timestamp: string;
}

interface ExportArtifactRow extends QueryResultRow {
  readonly artifact_id: string | null;
  readonly kind: ArtifactRecord["kind"];
  readonly object_key: string | null;
  readonly byte_length: string;
  readonly sha256: string;
  readonly media_type: string | null;
  readonly expires_at: string | null;
  readonly created_at: string;
}

interface ExportIntentRow extends QueryResultRow {
  readonly export_id: string;
  readonly idempotency_key: string;
  readonly created_at: string;
  readonly snapshot: unknown;
}

const ExportTables = {
  commands: "cloud_thread_command",
  events: "cloud_thread_event",
  approvals: "cloud_thread_approval",
  checkpoints: "cloud_thread_checkpoint",
  artifacts: "cloud_thread_artifact",
} as const;

/** Audited allowlist: credential, GitHub-token, provider-profile, wallet, and raw payload tables are excluded. */
export const THREAD_EXPORT_SOURCE_TABLES = Object.freeze(Object.values(ExportTables));

const exportRecords = (rows: ReadonlyArray<ExportRow>): ReadonlyArray<ThreadExportRecord> =>
  rows.map((row) => {
    if (row.id === null) throw failure("invalidRecord", "prepare-thread-export", false);
    return {
      id: row.id,
      ...(row.sequence === null ? {} : { sequence: Number(row.sequence) }),
      timestamp: row.timestamp,
    };
  });

const artifactFromExportRow = (row: ExportArtifactRow): ThreadExportArtifact => {
  if (row.artifact_id === null || row.object_key === null || row.media_type === null) {
    throw failure("invalidRecord", "prepare-thread-export", false);
  }
  return {
    artifactId: row.artifact_id,
    kind: row.kind,
    objectKey: row.object_key,
    byteLength: Number(row.byte_length),
    sha256: row.sha256,
    mediaType: row.media_type,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    createdAt: row.created_at,
  };
};

const asObject = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw failure("invalidRecord", "decode-export-intent", false);
  }
  return value as Record<string, unknown>;
};

const decodeRecord = (value: unknown): ThreadExportRecord => {
  const object = asObject(value);
  if (
    typeof object.id !== "string" ||
    typeof object.timestamp !== "string" ||
    (object.sequence !== undefined && typeof object.sequence !== "number")
  ) {
    throw failure("invalidRecord", "decode-export-intent", false);
  }
  return {
    id: object.id,
    timestamp: object.timestamp,
    ...(object.sequence === undefined ? {} : { sequence: object.sequence }),
  };
};

const decodeArtifact = (value: unknown): ThreadExportArtifact => {
  const object = asObject(value);
  const requiredStrings = [
    "artifactId",
    "kind",
    "objectKey",
    "sha256",
    "mediaType",
    "createdAt",
  ] as const;
  if (
    requiredStrings.some((key) => typeof object[key] !== "string") ||
    typeof object.byteLength !== "number"
  ) {
    throw failure("invalidRecord", "decode-export-intent", false);
  }
  return object as unknown as ThreadExportArtifact;
};

const decodeSnapshot = (value: unknown): ThreadExportSnapshot => {
  const object = asObject(value);
  const array = (key: string) => {
    const entry = object[key];
    if (!Array.isArray(entry)) throw failure("invalidRecord", "decode-export-intent", false);
    return entry;
  };
  return {
    commands: array("commands").map(decodeRecord),
    events: array("events").map(decodeRecord),
    approvals: array("approvals").map(decodeRecord),
    checkpoints: array("checkpoints").map(decodeRecord),
    artifacts: array("artifacts").map(decodeArtifact),
  };
};

const utcTimestamp = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const queryWithAbort = <Row extends QueryResultRow>(
  client: PoolClient,
  text: string,
  values: ReadonlyArray<unknown>,
  signal?: AbortSignal,
) => {
  if (signal === undefined) return client.query<Row>(text, [...values]);
  if (signal.aborted) {
    return Promise.reject(failure("aborted", "prepare-thread-export", true, signal.reason));
  }
  const pending = client.query<Row>(text, [...values]);
  return new Promise<QueryResult<Row>>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(failure("aborted", "prepare-thread-export", true, signal.reason));
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

const exportLockValues = (input: Parameters<ThreadExportSource["prepare"]>[0]) =>
  [input.workspaceId, input.threadId] as const;
const acquireExportLockSql =
  "SELECT pg_advisory_lock(hashtextextended($1::text || chr(31) || $2, 0))";
const releaseExportLockSql =
  "SELECT pg_advisory_unlock(hashtextextended($1::text || chr(31) || $2, 0)) AS unlocked";

const snapshotTransaction = async (
  client: PoolClient,
  input: Parameters<ThreadExportSource["prepare"]>[0],
): Promise<ThreadExportIntent> => {
  await queryWithAbort(
    client,
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ",
    [],
    input.signal,
  );
  try {
    const thread = await queryWithAbort(
      client,
      "SELECT thread_id FROM cloud_thread WHERE workspace_id = $1 AND thread_id = $2",
      [input.workspaceId, input.threadId],
      input.signal,
    );
    if (thread.rowCount !== 1) throw failure("notFound", "prepare-thread-export", false);
    const existing = await queryWithAbort<ExportIntentRow>(
      client,
      `SELECT export_id, idempotency_key, ${utcTimestamp("created_at")} AS created_at, snapshot
         FROM cloud_thread_export_intent
        WHERE workspace_id = $1 AND thread_id = $2
          AND (export_id = $3 OR idempotency_key = $4)
        FOR UPDATE`,
      [input.workspaceId, input.threadId, input.exportId, input.idempotencyKey],
      input.signal,
    );
    if (existing.rows[0] !== undefined) {
      const row = existing.rows[0];
      if (row.export_id !== input.exportId || row.idempotency_key !== input.idempotencyKey) {
        throw failure("idempotencyConflict", "prepare-thread-export", false);
      }
      await queryWithAbort(client, "COMMIT", [], input.signal);
      return { createdAt: row.created_at, snapshot: decodeSnapshot(row.snapshot) };
    }
    let remainingRows = MAX_THREAD_EXPORT_RECORDS;
    const consumeRows = <Row>(rows: ReadonlyArray<Row>): ReadonlyArray<Row> => {
      if (rows.length > remainingRows) {
        throw failure("resourceLimit", "prepare-thread-export", false);
      }
      remainingRows -= rows.length;
      return rows;
    };
    const commands = await queryWithAbort<ExportRow>(
      client,
      `SELECT CASE WHEN octet_length(command_id) <= $4 THEN command_id END AS id,
              NULL::bigint AS sequence, ${utcTimestamp("created_at")} AS timestamp
         FROM ${ExportTables.commands}
        WHERE workspace_id = $1 AND thread_id = $2
        ORDER BY created_at, command_id LIMIT $3`,
      [input.workspaceId, input.threadId, remainingRows + 1, MAX_EXPORT_FIELD_BYTES],
      input.signal,
    );
    const commandRows = consumeRows(commands.rows);
    const events = await queryWithAbort<ExportRow>(
      client,
      `SELECT CASE WHEN octet_length(event_id) <= $4 THEN event_id END AS id,
              sequence::text AS sequence, ${utcTimestamp("received_at")} AS timestamp
         FROM ${ExportTables.events}
        WHERE workspace_id = $1 AND thread_id = $2
        ORDER BY sequence, event_id LIMIT $3`,
      [input.workspaceId, input.threadId, remainingRows + 1, MAX_EXPORT_FIELD_BYTES],
      input.signal,
    );
    const eventRows = consumeRows(events.rows);
    const approvals = await queryWithAbort<ExportRow>(
      client,
      `SELECT CASE WHEN octet_length(request_id) <= $4 THEN request_id END AS id,
              NULL::bigint AS sequence, ${utcTimestamp("requested_at")} AS timestamp
         FROM ${ExportTables.approvals}
        WHERE workspace_id = $1 AND thread_id = $2
        ORDER BY requested_at, request_id LIMIT $3`,
      [input.workspaceId, input.threadId, remainingRows + 1, MAX_EXPORT_FIELD_BYTES],
      input.signal,
    );
    const approvalRows = consumeRows(approvals.rows);
    const checkpoints = await queryWithAbort<ExportRow>(
      client,
      `SELECT CASE WHEN octet_length(checkpoint_ref) <= $4 THEN checkpoint_ref END AS id,
              event_sequence::text AS sequence, ${utcTimestamp("created_at")} AS timestamp
         FROM ${ExportTables.checkpoints}
        WHERE workspace_id = $1 AND thread_id = $2
        ORDER BY event_sequence, checkpoint_ref LIMIT $3`,
      [input.workspaceId, input.threadId, remainingRows + 1, MAX_EXPORT_FIELD_BYTES],
      input.signal,
    );
    const checkpointRows = consumeRows(checkpoints.rows);
    const artifacts = await queryWithAbort<ExportArtifactRow>(
      client,
      `SELECT CASE WHEN octet_length(artifact_id) <= $4 THEN artifact_id END AS artifact_id,
              kind,
              CASE WHEN octet_length(object_key) <= $5 THEN object_key END AS object_key,
              byte_length::text AS byte_length, sha256,
              CASE WHEN octet_length(media_type) <= $6 THEN media_type END AS media_type,
              ${utcTimestamp("expires_at")} AS expires_at,
              ${utcTimestamp("created_at")} AS created_at
         FROM ${ExportTables.artifacts}
        WHERE workspace_id = $1 AND thread_id = $2 AND state = 'complete'
          AND kind <> 'thread-export'
        ORDER BY created_at, artifact_id LIMIT $3`,
      [input.workspaceId, input.threadId, remainingRows + 1, MAX_EXPORT_FIELD_BYTES, 1_024, 255],
      input.signal,
    );
    const artifactRows = consumeRows(artifacts.rows);
    const snapshot: ThreadExportSnapshot = {
      commands: exportRecords(commandRows),
      events: exportRecords(eventRows),
      approvals: exportRecords(approvalRows),
      checkpoints: exportRecords(checkpointRows),
      artifacts: artifactRows.map(artifactFromExportRow),
    };
    buildThreadExport({ ...input, snapshot });
    const snapshotJson = JSON.stringify(snapshot);
    if (new TextEncoder().encode(snapshotJson).byteLength > MAX_THREAD_EXPORT_BYTES) {
      throw failure("resourceLimit", "prepare-thread-export", false);
    }
    const inserted = await queryWithAbort<ExportIntentRow>(
      client,
      `INSERT INTO cloud_thread_export_intent
        (workspace_id, thread_id, export_id, idempotency_key, created_at, snapshot)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING export_id, idempotency_key, ${utcTimestamp("created_at")} AS created_at, snapshot`,
      [
        input.workspaceId,
        input.threadId,
        input.exportId,
        input.idempotencyKey,
        input.createdAt,
        snapshotJson,
      ],
      input.signal,
    );
    await queryWithAbort(client, "COMMIT", [], input.signal);
    const row = inserted.rows[0]!;
    return { createdAt: row.created_at, snapshot: decodeSnapshot(row.snapshot) };
  } catch (cause) {
    if (!input.signal?.aborted) await client.query("ROLLBACK").catch(() => undefined);
    throw cause;
  }
};

export const makePostgresThreadExportSource = (database: DatabaseService): ThreadExportSource => ({
  prepare: (input) =>
    Effect.tryPromise({
      try: async () => {
        validateExportStorageIdentity(input);
        const normalizedInput = {
          ...input,
          createdAt: normalizeUtcInstant(input.createdAt, "created-at"),
        };
        const client = await database.pool.connect();
        let destroy = false;
        try {
          await queryWithAbort(
            client,
            acquireExportLockSql,
            exportLockValues(normalizedInput),
            normalizedInput.signal,
          );
          let intent: ThreadExportIntent | undefined;
          let primaryFailure: unknown;
          try {
            intent = await snapshotTransaction(client, normalizedInput);
          } catch (cause) {
            primaryFailure = cause;
          }
          let unlockFailure: unknown;
          if (normalizedInput.signal?.aborted) {
            destroy = true;
          } else {
            try {
              const released = await client.query<{ readonly unlocked: boolean }>(
                releaseExportLockSql,
                [...exportLockValues(normalizedInput)],
              );
              if (released.rows[0]?.unlocked !== true) {
                destroy = true;
                unlockFailure = new Error(
                  "thread export advisory lock was not held by its session",
                );
              }
            } catch (cause) {
              destroy = true;
              unlockFailure = cause;
            }
          }
          if (primaryFailure !== undefined) throw primaryFailure;
          if (unlockFailure !== undefined) throw unlockFailure;
          if (intent === undefined) {
            throw new Error("thread export transaction completed without an intent");
          }
          return intent;
        } catch (cause) {
          destroy ||= input.signal?.aborted === true;
          throw cause;
        } finally {
          client.release(destroy);
        }
      },
      catch: (cause) =>
        isThreadExportError(cause)
          ? cause
          : failure("databaseFailure", "prepare-thread-export", true, cause),
    }),
});
