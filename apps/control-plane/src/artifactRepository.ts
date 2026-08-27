import type { ThreadId } from "@t3tools/contracts";
import type { WorkspaceId } from "@t3tools/contracts/cloud";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { PoolClient, QueryResultRow } from "pg";

import type { DatabaseService } from "./database.ts";
import type { ArtifactKind } from "./artifactKeys.ts";

export type ArtifactState =
  | "reserved"
  | "uploading"
  | "complete"
  | "delete_pending"
  | "deleted"
  | "failed";

export interface ArtifactRecord {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly artifactId: string;
  readonly idempotencyKey: string;
  readonly kind: ArtifactKind;
  readonly state: ArtifactState;
  readonly objectKey: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly mediaType: string;
  readonly etag?: string;
  readonly objectVersion?: string;
  readonly retentionUntil?: string;
  readonly expiresAt?: string;
  readonly failureCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
  readonly deletedAt?: string;
}

export interface ReserveArtifactInput extends Omit<
  ArtifactRecord,
  "state" | "etag" | "objectVersion" | "failureCode" | "updatedAt" | "completedAt" | "deletedAt"
> {}

export interface ArtifactOutboxRecord {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly artifactId: string;
  readonly operation: "verify_upload" | "delete_object";
  readonly attemptCount: number;
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
}

export class ArtifactRepositoryError extends Schema.TaggedErrorClass<ArtifactRepositoryError>()(
  "ArtifactRepositoryError",
  {
    code: Schema.Literals(["notFound", "tenantMismatch", "conflict", "databaseFailure"]),
    operation: Schema.String,
    retryable: Schema.Boolean,
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {}

export interface ArtifactRepository {
  readonly reserve: (
    input: ReserveArtifactInput,
  ) => Effect.Effect<
    { readonly disposition: "created" | "existing"; readonly record: ArtifactRecord },
    ArtifactRepositoryError
  >;
  readonly markUploading: (
    workspaceId: WorkspaceId,
    threadId: ThreadId,
    artifactId: string,
    now: string,
  ) => Effect.Effect<ArtifactRecord, ArtifactRepositoryError>;
  readonly complete: (
    workspaceId: WorkspaceId,
    threadId: ThreadId,
    artifactId: string,
    object: { readonly etag: string; readonly versionId?: string },
    now: string,
  ) => Effect.Effect<ArtifactRecord, ArtifactRepositoryError>;
  readonly fail: (
    workspaceId: WorkspaceId,
    threadId: ThreadId,
    artifactId: string,
    code: string,
    now: string,
  ) => Effect.Effect<void, ArtifactRepositoryError>;
  readonly get: (
    workspaceId: WorkspaceId,
    threadId: ThreadId,
    artifactId: string,
  ) => Effect.Effect<ArtifactRecord | undefined, ArtifactRepositoryError>;
  readonly beginDelete: (
    workspaceId: WorkspaceId,
    threadId: ThreadId,
    artifactId: string,
    now: string,
  ) => Effect.Effect<ArtifactRecord, ArtifactRepositoryError>;
  readonly markDeleted: (
    workspaceId: WorkspaceId,
    threadId: ThreadId,
    artifactId: string,
    now: string,
  ) => Effect.Effect<ArtifactRecord, ArtifactRepositoryError>;
  readonly listComplete: (
    workspaceId: WorkspaceId,
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<ArtifactRecord>, ArtifactRepositoryError>;
  readonly claimOutbox: (input: {
    readonly now: string;
    readonly leaseExpiresAt: string;
    readonly limit: number;
    readonly maxAttempts: number;
  }) => Effect.Effect<ReadonlyArray<ArtifactOutboxRecord>, ArtifactRepositoryError>;
  readonly renewOutbox: (
    item: ArtifactOutboxRecord,
    now: string,
    leaseExpiresAt: string,
  ) => Effect.Effect<void, ArtifactRepositoryError>;
  readonly completeOutbox: (
    item: ArtifactOutboxRecord,
    now: string,
  ) => Effect.Effect<void, ArtifactRepositoryError>;
  readonly failOutbox: (
    item: ArtifactOutboxRecord,
    now: string,
    availableAt: string,
    errorCode: string,
  ) => Effect.Effect<void, ArtifactRepositoryError>;
  readonly requeueExpiredOutbox: (
    now: string,
    limit: number,
  ) => Effect.Effect<number, ArtifactRepositoryError>;
}

const failure = (
  code: ArtifactRepositoryError["code"],
  operation: string,
  retryable: boolean,
  cause?: unknown,
) =>
  new ArtifactRepositoryError({
    code,
    operation,
    retryable,
    ...(cause === undefined ? {} : { cause }),
  });
const isArtifactRepositoryError = Schema.is(ArtifactRepositoryError);

interface ArtifactRow extends QueryResultRow {
  readonly workspace_id: string;
  readonly thread_id: string;
  readonly artifact_id: string;
  readonly idempotency_key: string;
  readonly kind: ArtifactKind;
  readonly state: ArtifactState;
  readonly object_key: string;
  readonly byte_length: string;
  readonly sha256: string;
  readonly media_type: string;
  readonly etag: string | null;
  readonly object_version: string | null;
  readonly retention_until: string | null;
  readonly expires_at: string | null;
  readonly failure_code: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
  readonly deleted_at: string | null;
}

interface ArtifactOutboxRow extends QueryResultRow {
  readonly workspace_id: string;
  readonly thread_id: string;
  readonly artifact_id: string;
  readonly operation: ArtifactOutboxRecord["operation"];
  readonly attempt_count: number;
  readonly lease_token: string;
  readonly lease_expires_at: string;
}

const outboxFromRow = (row: ArtifactOutboxRow): ArtifactOutboxRecord => ({
  workspaceId: row.workspace_id as WorkspaceId,
  threadId: row.thread_id as ThreadId,
  artifactId: row.artifact_id,
  operation: row.operation,
  attemptCount: row.attempt_count,
  leaseToken: row.lease_token,
  leaseExpiresAt: row.lease_expires_at,
});

const utcTimestamp = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const columns = `workspace_id::text AS workspace_id, thread_id, artifact_id, idempotency_key,
  kind, state, object_key, byte_length::text AS byte_length, sha256, media_type, etag,
  object_version, ${utcTimestamp("retention_until")} AS retention_until,
  ${utcTimestamp("expires_at")} AS expires_at, failure_code,
  ${utcTimestamp("created_at")} AS created_at,
  ${utcTimestamp("updated_at")} AS updated_at,
  ${utcTimestamp("completed_at")} AS completed_at,
  ${utcTimestamp("deleted_at")} AS deleted_at`;

const fromRow = (row: ArtifactRow): ArtifactRecord => ({
  workspaceId: row.workspace_id as WorkspaceId,
  threadId: row.thread_id as ThreadId,
  artifactId: row.artifact_id,
  idempotencyKey: row.idempotency_key,
  kind: row.kind,
  state: row.state,
  objectKey: row.object_key,
  byteLength: Number(row.byte_length),
  sha256: row.sha256,
  mediaType: row.media_type,
  ...(row.etag === null ? {} : { etag: row.etag }),
  ...(row.object_version === null ? {} : { objectVersion: row.object_version }),
  ...(row.retention_until === null ? {} : { retentionUntil: row.retention_until }),
  ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
  ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  ...(row.deleted_at === null ? {} : { deletedAt: row.deleted_at }),
});

const sameReservation = (record: ArtifactRecord, input: ReserveArtifactInput) =>
  record.workspaceId === input.workspaceId &&
  record.threadId === input.threadId &&
  record.artifactId === input.artifactId &&
  record.idempotencyKey === input.idempotencyKey &&
  record.kind === input.kind &&
  record.objectKey === input.objectKey &&
  record.byteLength === input.byteLength &&
  record.sha256 === input.sha256 &&
  record.mediaType === input.mediaType &&
  record.retentionUntil === input.retentionUntil &&
  record.expiresAt === input.expiresAt;

const transaction = <A>(
  database: DatabaseService,
  operation: string,
  use: (client: PoolClient) => Promise<A>,
): Effect.Effect<A, ArtifactRepositoryError> =>
  Effect.tryPromise({
    try: async () => {
      const client = await database.pool.connect();
      try {
        await client.query("BEGIN");
        const value = await use(client);
        await client.query("COMMIT");
        return value;
      } catch (cause) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw cause;
      } finally {
        client.release();
      }
    },
    catch: (cause) =>
      isArtifactRepositoryError(cause) ? cause : failure("databaseFailure", operation, true, cause),
  });

const selectOne = async (
  client: Pick<PoolClient, "query">,
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  artifactId: string,
  lock: boolean,
) => {
  const result = await client.query<ArtifactRow>(
    `SELECT ${columns} FROM cloud_thread_artifact
      WHERE workspace_id = $1 AND thread_id = $2 AND artifact_id = $3${lock ? " FOR UPDATE" : ""}`,
    [workspaceId, threadId, artifactId],
  );
  return result.rows[0] === undefined ? undefined : fromRow(result.rows[0]);
};

export const makePostgresArtifactRepository = (database: DatabaseService): ArtifactRepository => ({
  reserve: (input) =>
    transaction(database, "reserve-artifact", async (client) => {
      const thread = await client.query(
        `SELECT thread_id FROM cloud_thread
          WHERE workspace_id = $1 AND thread_id = $2
          FOR UPDATE`,
        [input.workspaceId, input.threadId],
      );
      if (thread.rowCount !== 1) throw failure("notFound", "reserve-artifact", false);
      const existingResult = await client.query<ArtifactRow>(
        `SELECT ${columns} FROM cloud_thread_artifact
          WHERE workspace_id = $1 AND thread_id = $2
            AND (artifact_id = $3 OR idempotency_key = $4)
          ORDER BY artifact_id
          FOR UPDATE`,
        [input.workspaceId, input.threadId, input.artifactId, input.idempotencyKey],
      );
      if (existingResult.rows.length > 0) {
        if (existingResult.rows.length !== 1) throw failure("conflict", "reserve-artifact", false);
        const existing = fromRow(existingResult.rows[0]!);
        if (!sameReservation(existing, input) || existing.state === "deleted") {
          throw failure("conflict", "reserve-artifact", false);
        }
        return { disposition: "existing" as const, record: existing };
      }
      const inserted = await client.query<ArtifactRow>(
        `INSERT INTO cloud_thread_artifact
          (workspace_id, thread_id, artifact_id, idempotency_key, kind, state, object_key,
           byte_length, sha256, media_type, retention_until, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'reserved', $6, $7, $8, $9, $10, $11, $12, $12)
         RETURNING ${columns}`,
        [
          input.workspaceId,
          input.threadId,
          input.artifactId,
          input.idempotencyKey,
          input.kind,
          input.objectKey,
          input.byteLength,
          input.sha256,
          input.mediaType,
          input.retentionUntil ?? null,
          input.expiresAt ?? null,
          input.createdAt,
        ],
      );
      const insertedOutbox = await client.query(
        `INSERT INTO cloud_thread_artifact_outbox
          (workspace_id, thread_id, artifact_id, operation, status,
           available_at, created_at, updated_at)
         VALUES ($1, $2, $3, 'verify_upload', 'pending', $4, $4, $4)`,
        [input.workspaceId, input.threadId, input.artifactId, input.createdAt],
      );
      if (insertedOutbox.rowCount !== 1) throw failure("conflict", "reserve-artifact", false);
      return { disposition: "created" as const, record: fromRow(inserted.rows[0]!) };
    }),
  markUploading: (workspaceId, threadId, artifactId, now) =>
    transaction(database, "mark-artifact-uploading", async (client) => {
      const updated = await client.query<ArtifactRow>(
        `UPDATE cloud_thread_artifact
            SET state = 'uploading', failure_code = NULL, updated_at = $4
          WHERE workspace_id = $1 AND thread_id = $2 AND artifact_id = $3
            AND state IN ('reserved', 'uploading', 'failed')
          RETURNING ${columns}`,
        [workspaceId, threadId, artifactId, now],
      );
      if (updated.rows[0] !== undefined) {
        const retriedOutbox = await client.query(
          `UPDATE cloud_thread_artifact_outbox
              SET status = CASE WHEN status = 'failed' THEN 'pending' ELSE status END,
                  attempt_count = CASE WHEN status = 'failed' THEN 0 ELSE attempt_count END,
                  available_at = CASE WHEN status = 'failed' THEN $4 ELSE available_at END,
                  last_error_code = CASE WHEN status = 'failed' THEN NULL ELSE last_error_code END,
                  lease_token = CASE WHEN status = 'failed' THEN NULL ELSE lease_token END,
                  lease_expires_at = CASE WHEN status = 'failed' THEN NULL ELSE lease_expires_at END,
                  updated_at = $4
            WHERE workspace_id = $1 AND thread_id = $2 AND artifact_id = $3
              AND operation = 'verify_upload'`,
          [workspaceId, threadId, artifactId, now],
        );
        if (retriedOutbox.rowCount !== 1) {
          throw failure("conflict", "retry-artifact-outbox", false);
        }
        return fromRow(updated.rows[0]);
      }
      const existing = await selectOne(client, workspaceId, threadId, artifactId, true);
      if (existing?.state === "complete") return existing;
      throw failure("notFound", "mark-artifact-uploading", false);
    }),
  complete: (workspaceId, threadId, artifactId, object, now) =>
    transaction(database, "complete-artifact", async (client) => {
      const existing = await selectOne(client, workspaceId, threadId, artifactId, true);
      if (existing === undefined) throw failure("notFound", "complete-artifact", false);
      if (existing.state === "complete") {
        if (existing.etag !== object.etag || existing.objectVersion !== object.versionId) {
          throw failure("conflict", "complete-artifact", false);
        }
        return existing;
      }
      if (!["reserved", "uploading", "failed"].includes(existing.state)) {
        throw failure("conflict", "complete-artifact", false);
      }
      const updated = await client.query<ArtifactRow>(
        `UPDATE cloud_thread_artifact
            SET state = 'complete', etag = $4, object_version = $5, failure_code = NULL,
                completed_at = $6, updated_at = $6
          WHERE workspace_id = $1 AND thread_id = $2 AND artifact_id = $3
          RETURNING ${columns}`,
        [workspaceId, threadId, artifactId, object.etag, object.versionId ?? null, now],
      );
      const completedOutbox = await client.query(
        `UPDATE cloud_thread_artifact_outbox
            SET status = 'completed', completed_at = $4, updated_at = $4,
                lease_token = NULL, lease_expires_at = NULL, last_error_code = NULL
          WHERE workspace_id = $1 AND thread_id = $2 AND artifact_id = $3
            AND operation = 'verify_upload'`,
        [workspaceId, threadId, artifactId, now],
      );
      if (completedOutbox.rowCount !== 1) {
        throw failure("conflict", "complete-artifact-outbox", false);
      }
      return fromRow(updated.rows[0]!);
    }),
  fail: (workspaceId, threadId, artifactId, code, now) =>
    transaction(database, "fail-artifact", async (client) => {
      const result = await client.query(
        `UPDATE cloud_thread_artifact
            SET state = 'failed', failure_code = $4, updated_at = $5
          WHERE workspace_id = $1 AND thread_id = $2 AND artifact_id = $3
            AND state IN ('reserved', 'uploading', 'failed')`,
        [workspaceId, threadId, artifactId, code, now],
      );
      if (result.rowCount !== 1) throw failure("notFound", "fail-artifact", false);
      const failedOutbox = await client.query(
        `UPDATE cloud_thread_artifact_outbox
            SET status = 'failed', last_error_code = $4, updated_at = $5,
                lease_token = NULL, lease_expires_at = NULL
          WHERE workspace_id = $1 AND thread_id = $2 AND artifact_id = $3
            AND operation = 'verify_upload'`,
        [workspaceId, threadId, artifactId, code, now],
      );
      if (failedOutbox.rowCount !== 1) throw failure("conflict", "fail-artifact-outbox", false);
    }),
  get: (workspaceId, threadId, artifactId) =>
    Effect.tryPromise({
      try: async () => {
        const rows = await database.pool.query<ArtifactRow>(
          `SELECT ${columns} FROM cloud_thread_artifact
            WHERE workspace_id = $1 AND thread_id = $2 AND artifact_id = $3`,
          [workspaceId, threadId, artifactId],
        );
        return rows.rows[0] === undefined ? undefined : fromRow(rows.rows[0]);
      },
      catch: (cause) => failure("databaseFailure", "get-artifact", true, cause),
    }),
  beginDelete: (workspaceId, threadId, artifactId, now) =>
    transaction(database, "begin-delete-artifact", async (client) => {
      const existing = await selectOne(client, workspaceId, threadId, artifactId, true);
      if (existing === undefined) throw failure("notFound", "begin-delete-artifact", false);
      if (existing.state === "deleted" || existing.state === "delete_pending") return existing;
      if (existing.state !== "complete") throw failure("conflict", "begin-delete-artifact", false);
      const updated = await client.query<ArtifactRow>(
        `UPDATE cloud_thread_artifact SET state = 'delete_pending', updated_at = $4
          WHERE workspace_id = $1 AND thread_id = $2 AND artifact_id = $3
          RETURNING ${columns}`,
        [workspaceId, threadId, artifactId, now],
      );
      const insertedOutbox = await client.query(
        `INSERT INTO cloud_thread_artifact_outbox
          (workspace_id, thread_id, artifact_id, operation, status,
           available_at, created_at, updated_at)
         VALUES ($1, $2, $3, 'delete_object', 'pending', $4, $4, $4)
         ON CONFLICT (workspace_id, thread_id, artifact_id, operation) DO NOTHING`,
        [workspaceId, threadId, artifactId, now],
      );
      if (insertedOutbox.rowCount !== 1) {
        throw failure("conflict", "begin-delete-artifact-outbox", false);
      }
      return fromRow(updated.rows[0]!);
    }),
  markDeleted: (workspaceId, threadId, artifactId, now) =>
    transaction(database, "mark-artifact-deleted", async (client) => {
      const updated = await client.query<ArtifactRow>(
        `UPDATE cloud_thread_artifact
            SET state = 'deleted', deleted_at = COALESCE(deleted_at, $4), updated_at = $4
          WHERE workspace_id = $1 AND thread_id = $2 AND artifact_id = $3
            AND state IN ('delete_pending', 'deleted')
          RETURNING ${columns}`,
        [workspaceId, threadId, artifactId, now],
      );
      if (updated.rows[0] === undefined) throw failure("notFound", "mark-artifact-deleted", false);
      const completedOutbox = await client.query(
        `UPDATE cloud_thread_artifact_outbox
            SET status = 'completed', completed_at = $4, updated_at = $4,
                lease_token = NULL, lease_expires_at = NULL
          WHERE workspace_id = $1 AND thread_id = $2 AND artifact_id = $3
            AND operation = 'delete_object'`,
        [workspaceId, threadId, artifactId, now],
      );
      if (completedOutbox.rowCount !== 1) {
        throw failure("conflict", "complete-artifact-outbox", false);
      }
      return fromRow(updated.rows[0]);
    }),
  listComplete: (workspaceId, threadId) =>
    Effect.tryPromise({
      try: async () => {
        const result = await database.pool.query<ArtifactRow>(
          `SELECT ${columns} FROM cloud_thread_artifact
            WHERE workspace_id = $1 AND thread_id = $2 AND state = 'complete'
            ORDER BY created_at, artifact_id`,
          [workspaceId, threadId],
        );
        return result.rows.map(fromRow);
      },
      catch: (cause) => failure("databaseFailure", "list-complete-artifacts", true, cause),
    }),
  claimOutbox: (input) =>
    transaction(database, "claim-artifact-outbox", async (client) => {
      if (
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 100 ||
        !Number.isSafeInteger(input.maxAttempts) ||
        input.maxAttempts < 1 ||
        input.maxAttempts > 100
      ) {
        throw failure("conflict", "claim-artifact-outbox", false);
      }
      const claimed = await client.query<ArtifactOutboxRow>(
        `WITH candidates AS (
           SELECT workspace_id, thread_id, artifact_id, operation
             FROM cloud_thread_artifact_outbox
            WHERE attempt_count < $3 AND available_at <= $1
              AND (
                status IN ('pending', 'failed') OR
                (status = 'processing' AND lease_expires_at <= $1)
              )
            ORDER BY available_at, created_at, workspace_id, thread_id, artifact_id, operation
            FOR UPDATE SKIP LOCKED
            LIMIT $2
         )
         UPDATE cloud_thread_artifact_outbox AS outbox
            SET status = 'processing', attempt_count = outbox.attempt_count + 1,
                lease_token = gen_random_uuid(), lease_expires_at = $4,
                updated_at = $1, last_error_code = NULL
           FROM candidates
          WHERE outbox.workspace_id = candidates.workspace_id
            AND outbox.thread_id = candidates.thread_id
            AND outbox.artifact_id = candidates.artifact_id
            AND outbox.operation = candidates.operation
         RETURNING outbox.workspace_id::text AS workspace_id, outbox.thread_id,
                   outbox.artifact_id, outbox.operation, outbox.attempt_count,
                   outbox.lease_token::text AS lease_token,
                   ${utcTimestamp("outbox.lease_expires_at")} AS lease_expires_at`,
        [input.now, input.limit, input.maxAttempts, input.leaseExpiresAt],
      );
      return claimed.rows.map(outboxFromRow);
    }),
  renewOutbox: (item, now, leaseExpiresAt) =>
    transaction(database, "renew-artifact-outbox", async (client) => {
      const renewed = await client.query(
        `UPDATE cloud_thread_artifact_outbox
            SET lease_expires_at = $6, updated_at = $5
          WHERE workspace_id = $1 AND thread_id = $2 AND artifact_id = $3
            AND operation = $4 AND status = 'processing' AND lease_token = $7`,
        [
          item.workspaceId,
          item.threadId,
          item.artifactId,
          item.operation,
          now,
          leaseExpiresAt,
          item.leaseToken,
        ],
      );
      if (renewed.rowCount !== 1) throw failure("conflict", "renew-artifact-outbox", false);
    }),
  completeOutbox: (item, now) =>
    transaction(database, "complete-artifact-outbox", async (client) => {
      const completed = await client.query(
        `UPDATE cloud_thread_artifact_outbox
            SET status = 'completed', completed_at = COALESCE(completed_at, $5),
                updated_at = $5, lease_token = NULL, lease_expires_at = NULL
          WHERE workspace_id = $1 AND thread_id = $2 AND artifact_id = $3
            AND operation = $4 AND status = 'processing' AND lease_token = $6`,
        [item.workspaceId, item.threadId, item.artifactId, item.operation, now, item.leaseToken],
      );
      if (completed.rowCount === 1) return;
      const existing = await client.query(
        `SELECT 1 FROM cloud_thread_artifact_outbox
          WHERE workspace_id = $1 AND thread_id = $2 AND artifact_id = $3
            AND operation = $4 AND status = 'completed'`,
        [item.workspaceId, item.threadId, item.artifactId, item.operation],
      );
      if (existing.rowCount !== 1) throw failure("conflict", "complete-artifact-outbox", false);
    }),
  failOutbox: (item, now, availableAt, errorCode) =>
    transaction(database, "fail-artifact-outbox", async (client) => {
      const failed = await client.query(
        `UPDATE cloud_thread_artifact_outbox
            SET status = 'failed', available_at = $6, last_error_code = $7,
                updated_at = $5, lease_token = NULL, lease_expires_at = NULL
          WHERE workspace_id = $1 AND thread_id = $2 AND artifact_id = $3
            AND operation = $4 AND status = 'processing' AND lease_token = $8`,
        [
          item.workspaceId,
          item.threadId,
          item.artifactId,
          item.operation,
          now,
          availableAt,
          errorCode,
          item.leaseToken,
        ],
      );
      if (failed.rowCount !== 1) throw failure("conflict", "fail-artifact-outbox", false);
    }),
  requeueExpiredOutbox: (now, limit) =>
    transaction(database, "requeue-expired-artifact-outbox", async (client) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw failure("conflict", "requeue-expired-artifact-outbox", false);
      }
      const requeued = await client.query(
        `WITH expired AS (
           SELECT workspace_id, thread_id, artifact_id, operation
             FROM cloud_thread_artifact_outbox
            WHERE status = 'processing' AND lease_expires_at <= $1
            ORDER BY lease_expires_at
            FOR UPDATE SKIP LOCKED
            LIMIT $2
         )
         UPDATE cloud_thread_artifact_outbox AS outbox
            SET status = 'failed', available_at = $1, updated_at = $1,
                lease_token = NULL, lease_expires_at = NULL,
                last_error_code = 'lease_expired'
           FROM expired
          WHERE outbox.workspace_id = expired.workspace_id
            AND outbox.thread_id = expired.thread_id
            AND outbox.artifact_id = expired.artifact_id
            AND outbox.operation = expired.operation`,
        [now, limit],
      );
      return requeued.rowCount ?? 0;
    }),
});

interface MemoryOutboxRecord {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly artifactId: string;
  readonly operation: ArtifactOutboxRecord["operation"];
  status: "pending" | "processing" | "completed" | "failed";
  attemptCount: number;
  availableAt: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  lastErrorCode?: string;
}

export interface MemoryArtifactRepositoryHarness extends ArtifactRepository {
  readonly authorizeThread: (workspaceId: WorkspaceId, threadId: ThreadId) => void;
  readonly outboxSnapshot: () => ReadonlyArray<Readonly<MemoryOutboxRecord>>;
}

export const makeMemoryArtifactRepository = (
  initialThreads: ReadonlyArray<{
    readonly workspaceId: WorkspaceId;
    readonly threadId: ThreadId;
  }> = [],
): MemoryArtifactRepositoryHarness => {
  const records = new Map<string, ArtifactRecord>();
  const idempotency = new Map<string, string>();
  const authorizedThreads = new Set(
    initialThreads.map(({ workspaceId, threadId }) => `${workspaceId}\u0000${threadId}`),
  );
  const outbox = new Map<string, MemoryOutboxRecord>();
  const keyFor = (workspaceId: WorkspaceId, threadId: ThreadId, artifactId: string) =>
    `${workspaceId}\u0000${threadId}\u0000${artifactId}`;
  const idempotencyKeyFor = (
    workspaceId: WorkspaceId,
    threadId: ThreadId,
    idempotencyKey: string,
  ) => `${workspaceId}\u0000${threadId}\u0000${idempotencyKey}`;
  const scoped = (workspaceId: WorkspaceId, threadId: ThreadId, artifactId: string) => {
    return records.get(keyFor(workspaceId, threadId, artifactId));
  };
  const outboxKey = (
    workspaceId: WorkspaceId,
    threadId: ThreadId,
    artifactId: string,
    operation: ArtifactOutboxRecord["operation"],
  ) => `${workspaceId}\u0000${threadId}\u0000${artifactId}\u0000${operation}`;
  const setOutbox = (
    workspaceId: WorkspaceId,
    threadId: ThreadId,
    artifactId: string,
    operation: ArtifactOutboxRecord["operation"],
    now: string,
  ) => {
    const key = outboxKey(workspaceId, threadId, artifactId, operation);
    if (!outbox.has(key)) {
      outbox.set(key, {
        workspaceId,
        threadId,
        artifactId,
        operation,
        status: "pending",
        attemptCount: 0,
        availableAt: now,
      });
    }
  };
  return {
    authorizeThread: (workspaceId, threadId) => {
      authorizedThreads.add(`${workspaceId}\u0000${threadId}`);
    },
    outboxSnapshot: () => [...outbox.values()].map((item) => ({ ...item })),
    reserve: (input) =>
      Effect.gen(function* () {
        if (!authorizedThreads.has(`${input.workspaceId}\u0000${input.threadId}`)) {
          return yield* failure("notFound", "reserve-artifact", false);
        }
        const key = keyFor(input.workspaceId, input.threadId, input.artifactId);
        const existingKey = idempotency.get(
          idempotencyKeyFor(input.workspaceId, input.threadId, input.idempotencyKey),
        );
        const existing =
          records.get(key) ?? (existingKey === undefined ? undefined : records.get(existingKey));
        if (existing !== undefined) {
          if (!sameReservation(existing, input) || existing.state === "deleted") {
            return yield* failure("conflict", "reserve-artifact", false);
          }
          return { disposition: "existing" as const, record: existing };
        }
        const record: ArtifactRecord = {
          ...input,
          state: "reserved",
          updatedAt: input.createdAt,
        };
        records.set(key, record);
        idempotency.set(
          idempotencyKeyFor(input.workspaceId, input.threadId, input.idempotencyKey),
          key,
        );
        setOutbox(
          input.workspaceId,
          input.threadId,
          input.artifactId,
          "verify_upload",
          input.createdAt,
        );
        return { disposition: "created" as const, record };
      }),
    markUploading: (workspaceId, threadId, artifactId, now) =>
      Effect.gen(function* () {
        const record = scoped(workspaceId, threadId, artifactId);
        if (record === undefined) return yield* failure("notFound", "mark-uploading", false);
        if (record.state === "complete") return record;
        if (!["reserved", "uploading", "failed"].includes(record.state)) {
          return yield* failure("conflict", "mark-uploading", false);
        }
        const pending = outbox.get(outboxKey(workspaceId, threadId, artifactId, "verify_upload"));
        if (pending === undefined) {
          return yield* failure("conflict", "retry-artifact-outbox", false);
        }
        if (pending.status === "failed") {
          pending.status = "pending";
          pending.attemptCount = 0;
          pending.availableAt = now;
          delete pending.lastErrorCode;
          delete pending.leaseToken;
          delete pending.leaseExpiresAt;
        }
        const { failureCode: _failureCode, ...withoutFailure } = record;
        const next: ArtifactRecord = {
          ...withoutFailure,
          state: "uploading",
          updatedAt: now,
        };
        records.set(keyFor(workspaceId, threadId, artifactId), next);
        return next;
      }),
    complete: (workspaceId, threadId, artifactId, object, now) =>
      Effect.gen(function* () {
        const record = scoped(workspaceId, threadId, artifactId);
        if (record === undefined) return yield* failure("notFound", "complete", false);
        if (record.state === "complete") {
          if (record.etag !== object.etag || record.objectVersion !== object.versionId) {
            return yield* failure("conflict", "complete", false);
          }
          return record;
        }
        if (!["reserved", "uploading", "failed"].includes(record.state)) {
          return yield* failure("conflict", "complete", false);
        }
        const { failureCode: _failureCode, ...withoutFailure } = record;
        const next: ArtifactRecord = {
          ...withoutFailure,
          state: "complete",
          etag: object.etag,
          ...(object.versionId === undefined ? {} : { objectVersion: object.versionId }),
          completedAt: now,
          updatedAt: now,
        };
        records.set(keyFor(workspaceId, threadId, artifactId), next);
        const pending = outbox.get(outboxKey(workspaceId, threadId, artifactId, "verify_upload"));
        if (pending !== undefined) {
          pending.status = "completed";
          delete pending.leaseToken;
          delete pending.leaseExpiresAt;
        }
        return next;
      }),
    fail: (workspaceId, threadId, artifactId, code, now) =>
      Effect.gen(function* () {
        const record = scoped(workspaceId, threadId, artifactId);
        if (record === undefined || !["reserved", "uploading", "failed"].includes(record.state)) {
          return yield* failure("notFound", "fail", false);
        }
        records.set(keyFor(workspaceId, threadId, artifactId), {
          ...record,
          state: "failed",
          failureCode: code,
          updatedAt: now,
        });
        const pending = outbox.get(outboxKey(workspaceId, threadId, artifactId, "verify_upload"));
        if (pending !== undefined) {
          pending.status = "failed";
          pending.availableAt = now;
          pending.lastErrorCode = code;
          delete pending.leaseToken;
          delete pending.leaseExpiresAt;
        }
      }),
    get: (workspaceId, threadId, artifactId) =>
      Effect.succeed(scoped(workspaceId, threadId, artifactId)),
    beginDelete: (workspaceId, threadId, artifactId, now) =>
      Effect.gen(function* () {
        const record = scoped(workspaceId, threadId, artifactId);
        if (record === undefined) return yield* failure("notFound", "begin-delete", false);
        if (record.state === "deleted" || record.state === "delete_pending") return record;
        if (record.state !== "complete") return yield* failure("conflict", "begin-delete", false);
        const next = { ...record, state: "delete_pending" as const, updatedAt: now };
        records.set(keyFor(workspaceId, threadId, artifactId), next);
        setOutbox(workspaceId, threadId, artifactId, "delete_object", now);
        return next;
      }),
    markDeleted: (workspaceId, threadId, artifactId, now) =>
      Effect.gen(function* () {
        const record = scoped(workspaceId, threadId, artifactId);
        if (record === undefined || !["delete_pending", "deleted"].includes(record.state)) {
          return yield* failure("notFound", "mark-deleted", false);
        }
        const next = {
          ...record,
          state: "deleted" as const,
          deletedAt: record.deletedAt ?? now,
          updatedAt: now,
        };
        records.set(keyFor(workspaceId, threadId, artifactId), next);
        const pending = outbox.get(outboxKey(workspaceId, threadId, artifactId, "delete_object"));
        if (pending !== undefined) {
          pending.status = "completed";
          delete pending.leaseToken;
          delete pending.leaseExpiresAt;
        }
        return next;
      }),
    listComplete: (workspaceId, threadId) =>
      Effect.succeed(
        [...records.values()]
          .filter(
            (record) =>
              record.workspaceId === workspaceId &&
              record.threadId === threadId &&
              record.state === "complete",
          )
          .sort(
            (left, right) =>
              (left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0) ||
              (left.artifactId < right.artifactId
                ? -1
                : left.artifactId > right.artifactId
                  ? 1
                  : 0),
          ),
      ),
    claimOutbox: (input) =>
      Effect.sync(() => {
        const candidates = [...outbox.values()]
          .filter(
            (item) =>
              item.attemptCount < input.maxAttempts &&
              item.availableAt <= input.now &&
              (["pending", "failed"].includes(item.status) ||
                (item.status === "processing" &&
                  item.leaseExpiresAt !== undefined &&
                  item.leaseExpiresAt <= input.now)),
          )
          .sort((left, right) =>
            left.availableAt < right.availableAt
              ? -1
              : left.availableAt > right.availableAt
                ? 1
                : 0,
          )
          .slice(0, input.limit);
        return candidates.map((item, index) => {
          item.status = "processing";
          item.attemptCount += 1;
          item.leaseToken = `memory-lease-${item.attemptCount}-${index}-${item.artifactId}`;
          item.leaseExpiresAt = input.leaseExpiresAt;
          return {
            workspaceId: item.workspaceId,
            threadId: item.threadId,
            artifactId: item.artifactId,
            operation: item.operation,
            attemptCount: item.attemptCount,
            leaseToken: item.leaseToken,
            leaseExpiresAt: item.leaseExpiresAt,
          };
        });
      }),
    renewOutbox: (item, _now, leaseExpiresAt) =>
      Effect.gen(function* () {
        const current = outbox.get(
          outboxKey(item.workspaceId, item.threadId, item.artifactId, item.operation),
        );
        if (current?.status !== "processing" || current.leaseToken !== item.leaseToken) {
          return yield* failure("conflict", "renew-artifact-outbox", false);
        }
        current.leaseExpiresAt = leaseExpiresAt;
      }),
    completeOutbox: (item, _now) =>
      Effect.gen(function* () {
        const current = outbox.get(
          outboxKey(item.workspaceId, item.threadId, item.artifactId, item.operation),
        );
        if (
          current === undefined ||
          (current.status !== "completed" &&
            (current.status !== "processing" || current.leaseToken !== item.leaseToken))
        ) {
          return yield* failure("conflict", "complete-artifact-outbox", false);
        }
        current.status = "completed";
        delete current.leaseToken;
        delete current.leaseExpiresAt;
      }),
    failOutbox: (item, _now, availableAt, errorCode) =>
      Effect.gen(function* () {
        const current = outbox.get(
          outboxKey(item.workspaceId, item.threadId, item.artifactId, item.operation),
        );
        if (
          current === undefined ||
          current.status !== "processing" ||
          current.leaseToken !== item.leaseToken
        ) {
          return yield* failure("conflict", "fail-artifact-outbox", false);
        }
        current.status = "failed";
        current.availableAt = availableAt;
        current.lastErrorCode = errorCode;
        delete current.leaseToken;
        delete current.leaseExpiresAt;
      }),
    requeueExpiredOutbox: (now, limit) =>
      Effect.sync(() => {
        const expired = [...outbox.values()]
          .filter(
            (item) =>
              item.status === "processing" &&
              item.leaseExpiresAt !== undefined &&
              item.leaseExpiresAt <= now,
          )
          .slice(0, limit);
        for (const item of expired) {
          item.status = "failed";
          item.availableAt = now;
          item.lastErrorCode = "lease_expired";
          delete item.leaseToken;
          delete item.leaseExpiresAt;
        }
        return expired.length;
      }),
  };
};
