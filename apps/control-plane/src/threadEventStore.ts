// @effect-diagnostics nodeBuiltinImport:off -- PostgreSQL idempotency fingerprints use Node's audited SHA-256 implementation.
import * as NodeCrypto from "node:crypto";

import type {
  ApprovalRequestId,
  CheckpointRef,
  EnvironmentId,
  EventId,
  IsoDateTime,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { CloudThreadCommand, CloudThreadEvent, type WorkspaceId } from "@t3tools/contracts/cloud";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { PoolClient, QueryResultRow } from "pg";

import { Database } from "./database.ts";

export const ThreadEventStoreErrorCode = Schema.Literals([
  "notFound",
  "tenantMismatch",
  "environmentMismatch",
  "idempotencyConflict",
  "sequenceConflict",
  "eventConflict",
  "replayGap",
  "databaseFailure",
  "invalidRecord",
]);
export type ThreadEventStoreErrorCode = typeof ThreadEventStoreErrorCode.Type;

export class ThreadEventStoreError extends Schema.TaggedErrorClass<ThreadEventStoreError>()(
  "ThreadEventStoreError",
  {
    code: ThreadEventStoreErrorCode,
    operation: Schema.String,
    workspaceId: Schema.String,
    threadId: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {}

export interface CloudThreadIdentity {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
}

export interface SubmitThreadCommandInput {
  readonly idempotencyKey: string;
  readonly envelope: CloudThreadCommand;
}

export interface CommandSubmissionResult {
  readonly disposition: "accepted" | "duplicate";
  readonly commandId: string;
}

export interface AppendThreadEventsInput {
  readonly identity: CloudThreadIdentity;
  readonly events: ReadonlyArray<CloudThreadEvent>;
}

export interface AppendThreadEventsResult {
  readonly appended: number;
  readonly duplicates: number;
  readonly nextSequence: number;
}

export interface ReplayThreadEventsWindow {
  readonly events: ReadonlyArray<CloudThreadEvent>;
  /** The sequence to request next, not the last sequence returned. */
  readonly nextSequence: number;
  readonly hasMore: boolean;
}

export interface PersistedThreadApproval {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly requestId: ApprovalRequestId;
  readonly state: "pending" | "approved" | "rejected" | "expired";
  readonly payload: unknown;
  readonly requestedAt: IsoDateTime;
  readonly resolvedAt?: IsoDateTime;
}

export interface PersistedThreadCheckpoint {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly checkpointRef: CheckpointRef;
  readonly eventSequence: number;
  readonly turnId?: TurnId;
  readonly turnCount: number;
  readonly payload: unknown;
  readonly createdAt: IsoDateTime;
}

export interface PersistedRuntimeLifecycle {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly lifecycleId: EventId;
  readonly resourceKind: "sandbox" | "worker";
  readonly resourceId: string;
  readonly state: string;
  readonly payload: unknown;
  readonly occurredAt: IsoDateTime;
}

export interface ThreadOutboxMessage {
  readonly outboxId: string;
  readonly workspaceId: WorkspaceId;
  readonly topic: string;
  readonly aggregateId: string;
  readonly dedupeKey: string;
  readonly payload: unknown;
  readonly attemptCount: number;
  readonly createdAt: string;
}

export interface PendingThreadCommand {
  readonly outboxId: string;
  readonly command: CloudThreadCommand;
  readonly attemptCount: number;
}

export interface ThreadEventStoreService {
  readonly createThread: (
    identity: CloudThreadIdentity,
  ) => Effect.Effect<"created" | "existing", ThreadEventStoreError>;
  readonly submitCommand: (
    input: SubmitThreadCommandInput,
  ) => Effect.Effect<CommandSubmissionResult, ThreadEventStoreError>;
  readonly appendEvents: (
    input: AppendThreadEventsInput,
  ) => Effect.Effect<AppendThreadEventsResult, ThreadEventStoreError>;
  readonly replay: (
    workspaceId: WorkspaceId,
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<CloudThreadEvent>, ThreadEventStoreError>;
  readonly replayAfter: (
    workspaceId: WorkspaceId,
    threadId: ThreadId,
    afterSequence: number,
    limit: number,
  ) => Effect.Effect<ReplayThreadEventsWindow, ThreadEventStoreError>;
  readonly saveApproval: (
    approval: PersistedThreadApproval,
  ) => Effect.Effect<void, ThreadEventStoreError>;
  readonly saveCheckpoint: (
    checkpoint: PersistedThreadCheckpoint,
  ) => Effect.Effect<void, ThreadEventStoreError>;
  readonly appendLifecycle: (
    lifecycle: PersistedRuntimeLifecycle,
  ) => Effect.Effect<"appended" | "duplicate", ThreadEventStoreError>;
  readonly listPendingOutbox: (
    workspaceId: WorkspaceId,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<ThreadOutboxMessage>, ThreadEventStoreError>;
  readonly listPendingThreadCommands: (
    workspaceId: WorkspaceId,
    threadId: ThreadId,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<PendingThreadCommand>, ThreadEventStoreError>;
  readonly markOutboxDelivered: (
    workspaceId: WorkspaceId,
    outboxId: string,
    deliveredAt: IsoDateTime,
  ) => Effect.Effect<void, ThreadEventStoreError>;
  readonly pruneExpiredCommandLocks: (
    workspaceId: WorkspaceId,
    now: IsoDateTime,
    limit: number,
  ) => Effect.Effect<number, ThreadEventStoreError>;
}

export class ThreadEventStore extends Context.Service<ThreadEventStore, ThreadEventStoreService>()(
  "@agentsin-cloud/control-plane/threadEventStore",
) {}

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (Predicate.isObject(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

interface NormalizedJson {
  readonly value: Schema.Json;
  readonly text: string;
  readonly fingerprint: string;
}

const decodeJson = Schema.decodeUnknownSync(Schema.Json);

const normalizeJson = (
  value: unknown,
  operation: string,
  workspaceId: string,
  threadId?: string,
): Effect.Effect<NormalizedJson, ThreadEventStoreError> =>
  Effect.try({
    try: () => {
      const decoded = decodeJson(value);
      const text = canonicalJson(decoded);
      return {
        value: decoded,
        text,
        fingerprint: NodeCrypto.createHash("sha256").update(text).digest("hex"),
      };
    },
    catch: (cause) => fail("invalidRecord", operation, workspaceId, threadId, cause),
  });

const fail = (
  code: ThreadEventStoreErrorCode,
  operation: string,
  workspaceId: string,
  threadId?: string,
  cause?: unknown,
) =>
  new ThreadEventStoreError({
    code,
    operation,
    workspaceId,
    ...(threadId === undefined ? {} : { threadId }),
    ...(cause === undefined ? {} : { cause }),
  });

type SqlClient = Pick<PoolClient, "query">;

const query = <Row extends QueryResultRow = QueryResultRow>(
  client: SqlClient,
  operation: string,
  workspaceId: string,
  threadId: string | undefined,
  text: string,
  values: ReadonlyArray<unknown> = [],
) =>
  Effect.tryPromise({
    try: async () => (await client.query<Row>(text, [...values])).rows,
    catch: (cause) => fail("databaseFailure", operation, workspaceId, threadId, cause),
  });

const transact = <A>(
  database: Database["Service"],
  operation: string,
  workspaceId: string,
  threadId: string | undefined,
  use: (client: SqlClient) => Effect.Effect<A, ThreadEventStoreError>,
): Effect.Effect<A, ThreadEventStoreError> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => database.pool.connect(),
      catch: (cause) => fail("databaseFailure", operation, workspaceId, threadId, cause),
    }),
    (client) =>
      query(client, operation, workspaceId, threadId, "BEGIN").pipe(
        Effect.flatMap(() => use(client)),
        Effect.tap(() => query(client, operation, workspaceId, threadId, "COMMIT")),
        Effect.catch((cause) =>
          query(client, operation, workspaceId, threadId, "ROLLBACK").pipe(
            Effect.catch(() => Effect.void),
            Effect.flatMap(() => Effect.fail(cause)),
          ),
        ),
      ),
    (client) =>
      query(client, operation, workspaceId, threadId, "ROLLBACK").pipe(
        Effect.catch(() => Effect.void),
        Effect.andThen(Effect.sync(() => client.release())),
      ),
  );

interface ThreadRow extends QueryResultRow {
  readonly environment_id: string;
  readonly next_event_sequence: string;
}

interface ExistingCommandRow extends QueryResultRow {
  readonly command_id: string;
  readonly idempotency_key: string;
  readonly fingerprint: string;
}

interface CommandLockRow extends QueryResultRow {
  readonly lock_kind: string;
  readonly lock_value: string;
}

interface ExistingEventRow extends QueryResultRow {
  readonly event_id: string;
  readonly sequence: string;
  readonly fingerprint: string;
}

interface EventEnvelopeRow extends QueryResultRow {
  readonly sequence: string;
  readonly environment_id: string;
  readonly event_id: string;
  readonly fingerprint: string;
  readonly occurred_at_text: string;
  readonly received_at_text: string;
  readonly occurred_at_matches_text: boolean;
  readonly received_at_matches_text: boolean;
  readonly envelope: unknown;
}

interface ExistingLifecycleRow extends QueryResultRow {
  readonly thread_id: string;
  readonly fingerprint: string;
}

interface OutboxRow extends QueryResultRow {
  readonly outbox_id: string;
  readonly workspace_id: string;
  readonly topic: string;
  readonly aggregate_id: string;
  readonly dedupe_key: string;
  readonly payload: unknown;
  readonly attempt_count: number;
  readonly created_at: string;
}

interface PendingCommandOutboxRow extends QueryResultRow {
  readonly outbox_id: string;
  readonly payload: unknown;
  readonly attempt_count: number;
}

const safeInteger = (
  value: string,
  operation: string,
  workspaceId: string,
  threadId: string,
): Effect.Effect<number, ThreadEventStoreError> => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? Effect.succeed(parsed)
    : Effect.fail(fail("invalidRecord", operation, workspaceId, threadId, value));
};

const selectThreadForUpdate = (
  client: SqlClient,
  operation: string,
  identity: CloudThreadIdentity,
) =>
  query<ThreadRow>(
    client,
    operation,
    identity.workspaceId,
    identity.threadId,
    `SELECT environment_id, next_event_sequence::text AS next_event_sequence
       FROM cloud_thread
      WHERE workspace_id = $1 AND thread_id = $2
      FOR UPDATE`,
    [identity.workspaceId, identity.threadId],
  ).pipe(
    Effect.flatMap((rows) => {
      const row = rows[0];
      if (row === undefined) {
        return Effect.fail(fail("notFound", operation, identity.workspaceId, identity.threadId));
      }
      if (row.environment_id !== identity.environmentId) {
        return Effect.fail(
          fail("environmentMismatch", operation, identity.workspaceId, identity.threadId),
        );
      }
      return safeInteger(
        row.next_event_sequence,
        operation,
        identity.workspaceId,
        identity.threadId,
      );
    }),
  );

const lockWorkspaceCommandIdentities = Effect.fn("ThreadEventStore.lockWorkspaceCommandIdentities")(
  function* (
    client: SqlClient,
    workspaceId: WorkspaceId,
    threadId: ThreadId,
    commandId: string,
    idempotencyKey: string,
  ) {
    const operation = "submit-command";
    const lockKeys = [
      { kind: "command_id", value: commandId },
      { kind: "idempotency_key", value: idempotencyKey },
    ].sort((left, right) =>
      left.kind < right.kind
        ? -1
        : left.kind > right.kind
          ? 1
          : left.value < right.value
            ? -1
            : left.value > right.value
              ? 1
              : 0,
    );
    for (const lockKey of lockKeys) {
      const locked = yield* query<CommandLockRow>(
        client,
        operation,
        workspaceId,
        threadId,
        `INSERT INTO cloud_thread_command_lock (workspace_id, lock_kind, lock_value)
         VALUES ($1, $2, $3)
         ON CONFLICT (workspace_id, lock_kind, lock_value) DO UPDATE
           SET last_used_at = now()
         RETURNING lock_kind, lock_value`,
        [workspaceId, lockKey.kind, lockKey.value],
      );
      const acquired = locked[0];
      if (
        locked.length !== 1 ||
        acquired?.lock_kind !== lockKey.kind ||
        acquired.lock_value !== lockKey.value
      ) {
        return yield* fail("databaseFailure", operation, workspaceId, threadId, {
          reason: "command lock acquisition returned no matching row",
          lockKind: lockKey.kind,
          lockValue: lockKey.value,
        });
      }
    }
  },
);

const decodeCloudThreadEvent = Schema.decodeUnknownEffect(CloudThreadEvent);
const decodeCloudThreadCommand = Schema.decodeUnknownEffect(CloudThreadCommand);
const ThreadCommandIdempotencyKey = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
);
const decodeThreadCommandIdempotencyKey = Schema.decodeUnknownEffect(ThreadCommandIdempotencyKey);

const validateEnvelopeIdentity = Effect.fn("ThreadEventStore.validateEnvelopeIdentity")(function* (
  envelope: CloudThreadCommand,
) {
  const decoded = yield* decodeCloudThreadCommand(envelope).pipe(
    Effect.mapError((cause) =>
      fail("invalidRecord", "submit-command", envelope.workspaceId, envelope.threadId, cause),
    ),
  );
  return decoded;
});

const validateAppendInput = Effect.fn("ThreadEventStore.validateAppendInput")(function* (
  input: AppendThreadEventsInput,
) {
  const decoded: Array<CloudThreadEvent> = [];
  for (const envelope of input.events) {
    const event = yield* decodeCloudThreadEvent(envelope).pipe(
      Effect.mapError((cause) =>
        fail(
          "invalidRecord",
          "append-events",
          input.identity.workspaceId,
          input.identity.threadId,
          cause,
        ),
      ),
    );
    if (
      event.workspaceId !== input.identity.workspaceId ||
      event.threadId !== input.identity.threadId
    ) {
      return yield* fail(
        "tenantMismatch",
        "append-events",
        input.identity.workspaceId,
        input.identity.threadId,
      );
    }
    if (event.environmentId !== input.identity.environmentId) {
      return yield* fail(
        "environmentMismatch",
        "append-events",
        input.identity.workspaceId,
        input.identity.threadId,
      );
    }
    decoded.push(event);
  }
  return decoded;
});

export const make = Effect.fn("ThreadEventStore.make")(function* () {
  const database = yield* Database;

  const createThread: ThreadEventStoreService["createThread"] = (identity) => {
    const operation = "create-thread";
    return transact(database, operation, identity.workspaceId, identity.threadId, (client) =>
      query(
        client,
        operation,
        identity.workspaceId,
        identity.threadId,
        `INSERT INTO cloud_thread (workspace_id, thread_id, environment_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (workspace_id, thread_id) DO NOTHING
         RETURNING thread_id`,
        [identity.workspaceId, identity.threadId, identity.environmentId],
      ).pipe(
        Effect.flatMap((inserted) =>
          selectThreadForUpdate(client, operation, identity).pipe(
            Effect.as(inserted.length === 0 ? "existing" : "created"),
          ),
        ),
      ),
    );
  };

  const submitCommand: ThreadEventStoreService["submitCommand"] = (input) =>
    Effect.gen(function* () {
      const idempotencyKey = yield* decodeThreadCommandIdempotencyKey(input.idempotencyKey).pipe(
        Effect.mapError((cause) =>
          fail(
            "invalidRecord",
            "submit-command",
            input.envelope.workspaceId,
            input.envelope.threadId,
            cause,
          ),
        ),
      );
      const envelope = yield* validateEnvelopeIdentity(input.envelope);
      const operation = "submit-command";
      const commandId = envelope.command.commandId;
      const normalizedEnvelope = yield* normalizeJson(
        envelope,
        operation,
        envelope.workspaceId,
        envelope.threadId,
      );
      const envelopeFingerprint = normalizedEnvelope.fingerprint;
      const identity: CloudThreadIdentity = envelope;
      return yield* transact(
        database,
        operation,
        envelope.workspaceId,
        envelope.threadId,
        (client) =>
          lockWorkspaceCommandIdentities(
            client,
            envelope.workspaceId,
            envelope.threadId,
            commandId,
            idempotencyKey,
          ).pipe(
            Effect.andThen(selectThreadForUpdate(client, operation, identity)),
            Effect.flatMap(() =>
              query<ExistingCommandRow>(
                client,
                operation,
                envelope.workspaceId,
                envelope.threadId,
                `SELECT command_id, idempotency_key, fingerprint
                     FROM cloud_thread_command
                    WHERE workspace_id = $1
                      AND (command_id = $2 OR idempotency_key = $3)
                    FOR UPDATE`,
                [envelope.workspaceId, commandId, idempotencyKey],
              ),
            ),
            Effect.flatMap((existing) => {
              if (existing.length > 0) {
                const exactDuplicate = existing.every(
                  (row) =>
                    row.command_id === commandId &&
                    row.idempotency_key === idempotencyKey &&
                    row.fingerprint === envelopeFingerprint,
                );
                return exactDuplicate
                  ? Effect.succeed<CommandSubmissionResult>({
                      disposition: "duplicate",
                      commandId,
                    })
                  : Effect.fail(
                      fail(
                        "idempotencyConflict",
                        operation,
                        envelope.workspaceId,
                        envelope.threadId,
                      ),
                    );
              }

              return query(
                client,
                operation,
                envelope.workspaceId,
                envelope.threadId,
                `INSERT INTO cloud_thread_command
                    (workspace_id, thread_id, environment_id, command_id, idempotency_key,
                     fingerprint, envelope, enqueued_at)
                   VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
                [
                  envelope.workspaceId,
                  envelope.threadId,
                  envelope.environmentId,
                  commandId,
                  idempotencyKey,
                  envelopeFingerprint,
                  normalizedEnvelope.text,
                  envelope.enqueuedAt,
                ],
              ).pipe(
                Effect.flatMap(() =>
                  query(
                    client,
                    operation,
                    envelope.workspaceId,
                    envelope.threadId,
                    `INSERT INTO cloud_thread_outbox
                        (workspace_id, topic, aggregate_id, dedupe_key, payload)
                       VALUES ($1, 'thread.command', $2, $3, $4::jsonb)`,
                    [
                      envelope.workspaceId,
                      envelope.threadId,
                      `command:${commandId}`,
                      normalizedEnvelope.text,
                    ],
                  ),
                ),
                Effect.as<CommandSubmissionResult>({ disposition: "accepted", commandId }),
              );
            }),
          ),
      );
    });

  const appendEvents: ThreadEventStoreService["appendEvents"] = (input) =>
    validateAppendInput(input).pipe(
      Effect.flatMap((events) => {
        const operation = "append-events";
        return transact(
          database,
          operation,
          input.identity.workspaceId,
          input.identity.threadId,
          (client) =>
            selectThreadForUpdate(client, operation, input.identity).pipe(
              Effect.flatMap((initialNextSequence) =>
                Effect.gen(function* () {
                  let nextSequence = initialNextSequence;
                  let appended = 0;
                  let duplicates = 0;

                  for (const envelope of events) {
                    const normalizedEnvelope = yield* normalizeJson(
                      envelope,
                      operation,
                      input.identity.workspaceId,
                      input.identity.threadId,
                    );
                    const incomingFingerprint = normalizedEnvelope.fingerprint;
                    const existing = yield* query<ExistingEventRow>(
                      client,
                      operation,
                      input.identity.workspaceId,
                      input.identity.threadId,
                      `SELECT event_id, sequence::text AS sequence, fingerprint
                         FROM cloud_thread_event
                        WHERE workspace_id = $1 AND event_id = $2
                        FOR UPDATE`,
                      [input.identity.workspaceId, envelope.event.eventId],
                    );
                    const existingEvent = existing[0];
                    if (existingEvent !== undefined) {
                      const existingSequence = yield* safeInteger(
                        existingEvent.sequence,
                        operation,
                        input.identity.workspaceId,
                        input.identity.threadId,
                      );
                      if (
                        existingEvent.event_id !== envelope.event.eventId ||
                        existingSequence !== envelope.event.sequence ||
                        existingEvent.fingerprint !== incomingFingerprint
                      ) {
                        return yield* fail(
                          "eventConflict",
                          operation,
                          input.identity.workspaceId,
                          input.identity.threadId,
                        );
                      }
                      duplicates += 1;
                      continue;
                    }

                    if (envelope.event.sequence !== nextSequence) {
                      return yield* fail(
                        "sequenceConflict",
                        operation,
                        input.identity.workspaceId,
                        input.identity.threadId,
                        { expected: nextSequence, received: envelope.event.sequence },
                      );
                    }

                    yield* query(
                      client,
                      operation,
                      input.identity.workspaceId,
                      input.identity.threadId,
                      `INSERT INTO cloud_thread_event
                        (workspace_id, thread_id, environment_id, sequence, event_id, fingerprint,
                         envelope, occurred_at, occurred_at_text, received_at, received_at_text)
                       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)`,
                      [
                        input.identity.workspaceId,
                        input.identity.threadId,
                        input.identity.environmentId,
                        envelope.event.sequence,
                        envelope.event.eventId,
                        incomingFingerprint,
                        normalizedEnvelope.text,
                        envelope.event.occurredAt,
                        envelope.event.occurredAt,
                        envelope.receivedAt,
                        envelope.receivedAt,
                      ],
                    );
                    yield* query(
                      client,
                      operation,
                      input.identity.workspaceId,
                      input.identity.threadId,
                      `INSERT INTO cloud_thread_outbox
                        (workspace_id, topic, aggregate_id, dedupe_key, payload)
                       VALUES ($1, 'thread.event', $2, $3, $4::jsonb)`,
                      [
                        input.identity.workspaceId,
                        input.identity.threadId,
                        `event:${envelope.event.eventId}`,
                        normalizedEnvelope.text,
                      ],
                    );
                    appended += 1;
                    nextSequence += 1;
                  }

                  if (appended > 0) {
                    yield* query(
                      client,
                      operation,
                      input.identity.workspaceId,
                      input.identity.threadId,
                      `UPDATE cloud_thread
                          SET next_event_sequence = $3, updated_at = now()
                        WHERE workspace_id = $1 AND thread_id = $2`,
                      [input.identity.workspaceId, input.identity.threadId, nextSequence],
                    );
                  }

                  return { appended, duplicates, nextSequence };
                }),
              ),
            ),
        );
      }),
    );

  const replay: ThreadEventStoreService["replay"] = (workspaceId, threadId) => {
    const operation = "replay-events";
    return transact(database, operation, workspaceId, threadId, (client) =>
      query(
        client,
        operation,
        workspaceId,
        threadId,
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      ).pipe(
        Effect.flatMap(() =>
          query<ThreadRow>(
            client,
            operation,
            workspaceId,
            threadId,
            `SELECT environment_id, next_event_sequence::text AS next_event_sequence
               FROM cloud_thread
              WHERE workspace_id = $1 AND thread_id = $2`,
            [workspaceId, threadId],
          ),
        ),
        Effect.flatMap((threads) => {
          const thread = threads[0];
          if (thread === undefined) {
            return Effect.fail(fail("notFound", operation, workspaceId, threadId));
          }
          return safeInteger(thread.next_event_sequence, operation, workspaceId, threadId).pipe(
            Effect.flatMap((nextSequence) =>
              query<EventEnvelopeRow>(
                client,
                operation,
                workspaceId,
                threadId,
                `SELECT sequence::text AS sequence, environment_id, event_id, fingerprint,
                        occurred_at_text, received_at_text,
                        occurred_at = occurred_at_text::timestamptz AS occurred_at_matches_text,
                        received_at = received_at_text::timestamptz AS received_at_matches_text,
                        envelope
                   FROM cloud_thread_event
                  WHERE workspace_id = $1 AND thread_id = $2
                  ORDER BY sequence ASC`,
                [workspaceId, threadId],
              ).pipe(
                Effect.flatMap((rows) =>
                  Effect.gen(function* () {
                    if (rows.length !== nextSequence) {
                      return yield* fail("replayGap", operation, workspaceId, threadId, {
                        expectedLength: nextSequence,
                        receivedLength: rows.length,
                      });
                    }
                    const events: Array<CloudThreadEvent> = [];
                    for (const [index, row] of rows.entries()) {
                      const sequence = yield* safeInteger(
                        row.sequence,
                        operation,
                        workspaceId,
                        threadId,
                      );
                      if (sequence !== index) {
                        return yield* fail("replayGap", operation, workspaceId, threadId, {
                          expected: index,
                          received: sequence,
                        });
                      }
                      const normalizedEnvelope = yield* normalizeJson(
                        row.envelope,
                        operation,
                        workspaceId,
                        threadId,
                      );
                      const envelope = yield* decodeCloudThreadEvent(normalizedEnvelope.value).pipe(
                        Effect.mapError((cause) =>
                          fail("invalidRecord", operation, workspaceId, threadId, cause),
                        ),
                      );
                      if (
                        envelope.workspaceId !== workspaceId ||
                        envelope.threadId !== threadId ||
                        envelope.environmentId !== thread.environment_id ||
                        row.environment_id !== thread.environment_id ||
                        envelope.event.sequence !== sequence
                      ) {
                        return yield* fail("tenantMismatch", operation, workspaceId, threadId);
                      }
                      if (
                        row.event_id !== envelope.event.eventId ||
                        row.fingerprint !== normalizedEnvelope.fingerprint ||
                        row.occurred_at_text !== envelope.event.occurredAt ||
                        row.received_at_text !== envelope.receivedAt ||
                        !row.occurred_at_matches_text ||
                        !row.received_at_matches_text
                      ) {
                        return yield* fail("eventConflict", operation, workspaceId, threadId);
                      }
                      events.push(envelope);
                    }
                    return events;
                  }),
                ),
              ),
            ),
          );
        }),
      ),
    );
  };

  const replayAfter: ThreadEventStoreService["replayAfter"] = (
    workspaceId,
    threadId,
    afterSequence,
    limit,
  ) => {
    const operation = "replay-events-after";
    if (!Number.isSafeInteger(afterSequence) || afterSequence < -1) {
      return Effect.fail(fail("invalidRecord", operation, workspaceId, threadId));
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      return Effect.fail(fail("invalidRecord", operation, workspaceId, threadId));
    }
    return transact(database, operation, workspaceId, threadId, (client) =>
      query(
        client,
        operation,
        workspaceId,
        threadId,
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      ).pipe(
        Effect.flatMap(() =>
          query<ThreadRow>(
            client,
            operation,
            workspaceId,
            threadId,
            `SELECT environment_id, next_event_sequence::text AS next_event_sequence
               FROM cloud_thread
              WHERE workspace_id = $1 AND thread_id = $2`,
            [workspaceId, threadId],
          ),
        ),
        Effect.flatMap((threads) => {
          const thread = threads[0];
          if (thread === undefined) {
            return Effect.fail(fail("notFound", operation, workspaceId, threadId));
          }
          return safeInteger(thread.next_event_sequence, operation, workspaceId, threadId).pipe(
            Effect.flatMap((durableNextSequence) => {
              const requestedNextSequence = afterSequence + 1;
              if (requestedNextSequence > durableNextSequence) {
                return Effect.fail(
                  fail("replayGap", operation, workspaceId, threadId, {
                    durableNextSequence,
                    requestedNextSequence,
                  }),
                );
              }
              const expectedCount = Math.min(limit, durableNextSequence - requestedNextSequence);
              return query<EventEnvelopeRow>(
                client,
                operation,
                workspaceId,
                threadId,
                `SELECT sequence::text AS sequence, environment_id, event_id, fingerprint,
                        occurred_at_text, received_at_text,
                        occurred_at = occurred_at_text::timestamptz AS occurred_at_matches_text,
                        received_at = received_at_text::timestamptz AS received_at_matches_text,
                        envelope
                   FROM cloud_thread_event
                  WHERE workspace_id = $1 AND thread_id = $2 AND sequence >= $3
                  ORDER BY sequence ASC
                  LIMIT $4`,
                [workspaceId, threadId, requestedNextSequence, limit],
              ).pipe(
                Effect.flatMap((rows) =>
                  Effect.gen(function* () {
                    if (rows.length !== expectedCount) {
                      return yield* fail("replayGap", operation, workspaceId, threadId, {
                        expectedCount,
                        receivedCount: rows.length,
                      });
                    }
                    const events: Array<CloudThreadEvent> = [];
                    for (const [index, row] of rows.entries()) {
                      const expectedSequence = requestedNextSequence + index;
                      const sequence = yield* safeInteger(
                        row.sequence,
                        operation,
                        workspaceId,
                        threadId,
                      );
                      if (sequence !== expectedSequence) {
                        return yield* fail("replayGap", operation, workspaceId, threadId, {
                          expected: expectedSequence,
                          received: sequence,
                        });
                      }
                      const normalizedEnvelope = yield* normalizeJson(
                        row.envelope,
                        operation,
                        workspaceId,
                        threadId,
                      );
                      const envelope = yield* decodeCloudThreadEvent(normalizedEnvelope.value).pipe(
                        Effect.mapError((cause) =>
                          fail("invalidRecord", operation, workspaceId, threadId, cause),
                        ),
                      );
                      if (
                        envelope.workspaceId !== workspaceId ||
                        envelope.threadId !== threadId ||
                        envelope.environmentId !== thread.environment_id ||
                        row.environment_id !== thread.environment_id ||
                        envelope.event.sequence !== sequence
                      ) {
                        return yield* fail("tenantMismatch", operation, workspaceId, threadId);
                      }
                      if (
                        row.event_id !== envelope.event.eventId ||
                        row.fingerprint !== normalizedEnvelope.fingerprint ||
                        row.occurred_at_text !== envelope.event.occurredAt ||
                        row.received_at_text !== envelope.receivedAt ||
                        !row.occurred_at_matches_text ||
                        !row.received_at_matches_text
                      ) {
                        return yield* fail("eventConflict", operation, workspaceId, threadId);
                      }
                      events.push(envelope);
                    }
                    const nextSequence = requestedNextSequence + events.length;
                    return {
                      events,
                      nextSequence,
                      hasMore: nextSequence < durableNextSequence,
                    };
                  }),
                ),
              );
            }),
          );
        }),
      ),
    );
  };

  const saveApproval: ThreadEventStoreService["saveApproval"] = (approval) => {
    const operation = "save-approval";
    return Effect.gen(function* () {
      const payload = yield* normalizeJson(
        approval.payload,
        operation,
        approval.workspaceId,
        approval.threadId,
      );
      return yield* database
        .query(
          `INSERT INTO cloud_thread_approval
          (workspace_id, thread_id, request_id, state, payload, requested_at, resolved_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
         ON CONFLICT (workspace_id, request_id) DO UPDATE
           SET state = EXCLUDED.state,
               payload = EXCLUDED.payload,
               resolved_at = EXCLUDED.resolved_at,
               updated_at = now()
         WHERE cloud_thread_approval.thread_id = EXCLUDED.thread_id
         RETURNING request_id`,
          [
            approval.workspaceId,
            approval.threadId,
            approval.requestId,
            approval.state,
            payload.text,
            approval.requestedAt,
            approval.resolvedAt ?? null,
          ],
        )
        .pipe(
          Effect.mapError((cause) =>
            fail("databaseFailure", operation, approval.workspaceId, approval.threadId, cause),
          ),
          Effect.flatMap((rows) =>
            rows.length === 1
              ? Effect.void
              : Effect.fail(
                  fail("tenantMismatch", operation, approval.workspaceId, approval.threadId),
                ),
          ),
        );
    });
  };

  const saveCheckpoint: ThreadEventStoreService["saveCheckpoint"] = (checkpoint) => {
    const operation = "save-checkpoint";
    return Effect.gen(function* () {
      const payload = yield* normalizeJson(
        checkpoint.payload,
        operation,
        checkpoint.workspaceId,
        checkpoint.threadId,
      );
      return yield* database
        .query(
          `INSERT INTO cloud_thread_checkpoint
          (workspace_id, thread_id, checkpoint_ref, event_sequence, turn_id, turn_count,
           payload, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         ON CONFLICT (workspace_id, thread_id, checkpoint_ref) DO UPDATE
           SET event_sequence = EXCLUDED.event_sequence,
               turn_id = EXCLUDED.turn_id,
               turn_count = EXCLUDED.turn_count,
               payload = EXCLUDED.payload,
               created_at = EXCLUDED.created_at`,
          [
            checkpoint.workspaceId,
            checkpoint.threadId,
            checkpoint.checkpointRef,
            checkpoint.eventSequence,
            checkpoint.turnId ?? null,
            checkpoint.turnCount,
            payload.text,
            checkpoint.createdAt,
          ],
        )
        .pipe(
          Effect.mapError((cause) =>
            fail("databaseFailure", operation, checkpoint.workspaceId, checkpoint.threadId, cause),
          ),
          Effect.asVoid,
        );
    });
  };

  const appendLifecycle: ThreadEventStoreService["appendLifecycle"] = (lifecycle) => {
    const operation = "append-runtime-lifecycle";
    return Effect.gen(function* () {
      const payload = yield* normalizeJson(
        lifecycle.payload,
        operation,
        lifecycle.workspaceId,
        lifecycle.threadId,
      );
      const normalizedLifecycle = yield* normalizeJson(
        { ...lifecycle, payload: payload.value },
        operation,
        lifecycle.workspaceId,
        lifecycle.threadId,
      );
      const lifecycleFingerprint = normalizedLifecycle.fingerprint;
      return yield* transact(
        database,
        operation,
        lifecycle.workspaceId,
        lifecycle.threadId,
        (client) =>
          query(
            client,
            operation,
            lifecycle.workspaceId,
            lifecycle.threadId,
            `SELECT 1
             FROM cloud_thread
            WHERE workspace_id = $1 AND thread_id = $2
            FOR UPDATE`,
            [lifecycle.workspaceId, lifecycle.threadId],
          ).pipe(
            Effect.flatMap((thread) => {
              if (thread.length === 0) {
                return Effect.fail(
                  fail("notFound", operation, lifecycle.workspaceId, lifecycle.threadId),
                );
              }
              return query<ExistingLifecycleRow>(
                client,
                operation,
                lifecycle.workspaceId,
                lifecycle.threadId,
                `SELECT thread_id, fingerprint
               FROM cloud_thread_runtime_lifecycle
              WHERE workspace_id = $1 AND lifecycle_id = $2
              FOR UPDATE`,
                [lifecycle.workspaceId, lifecycle.lifecycleId],
              ).pipe(
                Effect.flatMap((existing) => {
                  const row = existing[0];
                  if (row !== undefined) {
                    return row.thread_id === lifecycle.threadId &&
                      row.fingerprint === lifecycleFingerprint
                      ? Effect.succeed<"appended" | "duplicate">("duplicate")
                      : Effect.fail(
                          fail(
                            "eventConflict",
                            operation,
                            lifecycle.workspaceId,
                            lifecycle.threadId,
                          ),
                        );
                  }
                  return query(
                    client,
                    operation,
                    lifecycle.workspaceId,
                    lifecycle.threadId,
                    `INSERT INTO cloud_thread_runtime_lifecycle
                  (workspace_id, thread_id, lifecycle_id, resource_kind, resource_id, state,
                   fingerprint, payload, occurred_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
                    [
                      lifecycle.workspaceId,
                      lifecycle.threadId,
                      lifecycle.lifecycleId,
                      lifecycle.resourceKind,
                      lifecycle.resourceId,
                      lifecycle.state,
                      lifecycleFingerprint,
                      payload.text,
                      lifecycle.occurredAt,
                    ],
                  ).pipe(Effect.as<"appended" | "duplicate">("appended"));
                }),
              );
            }),
          ),
      );
    });
  };

  const listPendingOutbox: ThreadEventStoreService["listPendingOutbox"] = (workspaceId, limit) => {
    const operation = "list-pending-outbox";
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    return database
      .query<OutboxRow>(
        `SELECT outbox_id::text AS outbox_id, workspace_id::text AS workspace_id, topic,
                aggregate_id, dedupe_key, payload, attempt_count,
                created_at::text AS created_at
           FROM cloud_thread_outbox
          WHERE workspace_id = $1 AND delivered_at IS NULL AND available_at <= now()
          ORDER BY available_at ASC, created_at ASC
          LIMIT $2`,
        [workspaceId, boundedLimit],
      )
      .pipe(
        Effect.mapError((cause) =>
          fail("databaseFailure", operation, workspaceId, undefined, cause),
        ),
        Effect.map((rows) =>
          rows.map((row) => ({
            outboxId: row.outbox_id,
            workspaceId: row.workspace_id as WorkspaceId,
            topic: row.topic,
            aggregateId: row.aggregate_id,
            dedupeKey: row.dedupe_key,
            payload: row.payload,
            attemptCount: row.attempt_count,
            createdAt: row.created_at,
          })),
        ),
      );
  };

  const listPendingThreadCommands: ThreadEventStoreService["listPendingThreadCommands"] = (
    workspaceId,
    threadId,
    limit,
  ) => {
    const operation = "list-pending-thread-commands";
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      return Effect.fail(fail("invalidRecord", operation, workspaceId, threadId));
    }
    return transact(database, operation, workspaceId, threadId, (client) =>
      query<ThreadRow>(
        client,
        operation,
        workspaceId,
        threadId,
        `SELECT environment_id, next_event_sequence::text AS next_event_sequence
           FROM cloud_thread
          WHERE workspace_id = $1 AND thread_id = $2`,
        [workspaceId, threadId],
      ).pipe(
        Effect.flatMap((threads) => {
          const thread = threads[0];
          if (thread === undefined) {
            return Effect.fail(fail("notFound", operation, workspaceId, threadId));
          }
          return query<PendingCommandOutboxRow>(
            client,
            operation,
            workspaceId,
            threadId,
            `SELECT outbox_id::text AS outbox_id, payload, attempt_count
               FROM cloud_thread_outbox
              WHERE workspace_id = $1
                AND topic = 'thread.command'
                AND aggregate_id = $2
                AND delivered_at IS NULL
                AND available_at <= now()
              ORDER BY available_at ASC, created_at ASC, outbox_id ASC
              LIMIT $3`,
            [workspaceId, threadId, limit],
          ).pipe(
            Effect.flatMap((rows) =>
              Effect.forEach(rows, (row) =>
                decodeCloudThreadCommand(row.payload).pipe(
                  Effect.mapError((cause) =>
                    fail("invalidRecord", operation, workspaceId, threadId, cause),
                  ),
                  Effect.flatMap((command) =>
                    command.workspaceId !== workspaceId ||
                    command.threadId !== threadId ||
                    command.environmentId !== thread.environment_id
                      ? Effect.fail(fail("tenantMismatch", operation, workspaceId, threadId))
                      : Effect.succeed({
                          outboxId: row.outbox_id,
                          command,
                          attemptCount: row.attempt_count,
                        }),
                  ),
                ),
              ),
            ),
          );
        }),
      ),
    );
  };

  const markOutboxDelivered: ThreadEventStoreService["markOutboxDelivered"] = (
    workspaceId,
    outboxId,
    deliveredAt,
  ) => {
    const operation = "mark-outbox-delivered";
    return database
      .query(
        `UPDATE cloud_thread_outbox
            SET delivered_at = $3
          WHERE workspace_id = $1 AND outbox_id = $2 AND delivered_at IS NULL
          RETURNING outbox_id`,
        [workspaceId, outboxId, deliveredAt],
      )
      .pipe(
        Effect.mapError((cause) =>
          fail("databaseFailure", operation, workspaceId, undefined, cause),
        ),
        Effect.flatMap((rows) =>
          rows.length === 1 ? Effect.void : Effect.fail(fail("notFound", operation, workspaceId)),
        ),
      );
  };

  const pruneExpiredCommandLocks: ThreadEventStoreService["pruneExpiredCommandLocks"] = (
    workspaceId,
    now,
    limit,
  ) => {
    const operation = "prune-expired-command-locks";
    const boundedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(1_000, Math.trunc(limit)))
      : 1;
    return database
      .query(
        `WITH candidates AS (
           SELECT workspace_id, lock_kind, lock_value
             FROM cloud_thread_command_lock
            WHERE workspace_id = $1
              AND last_used_at < $2::timestamptz - interval '24 hours'
            ORDER BY last_used_at ASC, lock_kind ASC, lock_value ASC
            FOR UPDATE SKIP LOCKED
            LIMIT $3
         )
         DELETE FROM cloud_thread_command_lock AS command_lock
          USING candidates
          WHERE command_lock.workspace_id = candidates.workspace_id
            AND command_lock.lock_kind = candidates.lock_kind
            AND command_lock.lock_value = candidates.lock_value
         RETURNING command_lock.lock_value`,
        [workspaceId, now, boundedLimit],
      )
      .pipe(
        Effect.mapError((cause) =>
          fail("databaseFailure", operation, workspaceId, undefined, cause),
        ),
        Effect.map((rows) => rows.length),
      );
  };

  return ThreadEventStore.of({
    createThread,
    submitCommand,
    appendEvents,
    replay,
    replayAfter,
    saveApproval,
    saveCheckpoint,
    appendLifecycle,
    listPendingOutbox,
    listPendingThreadCommands,
    markOutboxDelivered,
    pruneExpiredCommandLocks,
  });
});

export const layer = Layer.effect(ThreadEventStore, make());
