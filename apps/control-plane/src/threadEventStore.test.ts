import {
  type ApprovalRequestId,
  type CheckpointRef,
  type EnvironmentId,
  type EventId,
  type ThreadId,
} from "@t3tools/contracts";
import { CloudThreadCommand, CloudThreadEvent, type WorkspaceId } from "@t3tools/contracts/cloud";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Pool } from "pg";

import { Database, DatabaseError, type DatabaseService } from "./database.ts";
import { make, ThreadEventStoreError } from "./threadEventStore.ts";

interface FakeThread {
  readonly environmentId: string;
  nextSequence: number;
}

interface FakeCommand {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
}

interface FakeCommandLock {
  readonly workspaceId: string;
  readonly kind: string;
  readonly value: string;
  lastUsedAt: string;
}

interface FakeEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly fingerprint: string;
  readonly envelope: unknown;
}

interface FakeOutbox {
  readonly outboxId: string;
  readonly workspaceId: string;
  readonly topic: string;
  readonly aggregateId: string;
  readonly dedupeKey: string;
  readonly payload: unknown;
  deliveredAt?: string;
}

interface FakeProjection {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly payload: ReadonlyArray<unknown>;
}

interface FakeState {
  readonly threads: Map<string, FakeThread>;
  readonly commands: Map<string, FakeCommand>;
  readonly commandKeys: Map<string, string>;
  readonly commandLocks: Map<string, FakeCommandLock>;
  readonly events: Map<string, FakeEvent>;
  readonly outbox: Map<string, FakeOutbox>;
  readonly approvals: Map<string, FakeProjection>;
  readonly checkpoints: Map<string, FakeProjection>;
  readonly lifecycles: Map<string, FakeProjection & { readonly fingerprint: string }>;
}

const emptyState = (): FakeState => ({
  threads: new Map(),
  commands: new Map(),
  commandKeys: new Map(),
  commandLocks: new Map(),
  events: new Map(),
  outbox: new Map(),
  approvals: new Map(),
  checkpoints: new Map(),
  lifecycles: new Map(),
});

const copyState = (state: FakeState): FakeState => ({
  threads: new Map([...state.threads].map(([key, value]) => [key, { ...value }])),
  commands: new Map(state.commands),
  commandKeys: new Map(state.commandKeys),
  commandLocks: new Map([...state.commandLocks].map(([key, value]) => [key, { ...value }])),
  events: new Map(state.events),
  outbox: new Map([...state.outbox].map(([key, value]) => [key, { ...value }])),
  approvals: new Map(state.approvals),
  checkpoints: new Map(state.checkpoints),
  lifecycles: new Map(state.lifecycles),
});

const threadKey = (workspaceId: string, threadId: string) => `${workspaceId}/${threadId}`;
const commandKey = (workspaceId: string, commandId: string) => `${workspaceId}/${commandId}`;
const commandLockKey = (workspaceId: string, kind: string, value: string) =>
  `${workspaceId}/${kind}/${value}`;
const eventKey = (workspaceId: string, eventId: string) => `${workspaceId}/${eventId}`;
const outboxKey = (workspaceId: string, dedupeKey: string) => `${workspaceId}/${dedupeKey}`;

class FakePostgres {
  private committed = emptyState();
  private transactionTail = Promise.resolve();
  private nextOutboxId = 1;
  failNextOutbox = false;
  failNextCommandLockReturn = false;

  readonly pool = {
    connect: async () => {
      let working: FakeState | undefined;
      let releaseTransaction: (() => void) | undefined;

      const query = async (text: string, values: ReadonlyArray<unknown> = []) => {
        const sql = text.replaceAll(/\s+/g, " ").trim();
        if (sql === "BEGIN") {
          const previous = this.transactionTail;
          this.transactionTail = new Promise<void>((resolve) => {
            releaseTransaction = resolve;
          });
          await previous;
          working = copyState(this.committed);
          return { rows: [] };
        }
        if (sql === "COMMIT") {
          if (working === undefined) throw new Error("commit without transaction");
          this.committed = working;
          working = undefined;
          releaseTransaction?.();
          return { rows: [] };
        }
        if (sql === "ROLLBACK") {
          working = undefined;
          releaseTransaction?.();
          return { rows: [] };
        }
        if (sql === "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY") {
          return { rows: [] };
        }
        if (working === undefined) throw new Error(`query outside transaction: ${sql}`);
        return this.execute(working, sql, values);
      };

      return { query, release: () => undefined };
    },
  };

  readonly database: DatabaseService = {
    pool: this.pool as unknown as Pool,
    query: <Row>(text: string, values: ReadonlyArray<unknown> = []) =>
      Effect.tryPromise({
        try: async () =>
          (await this.execute(this.committed, text.replaceAll(/\s+/g, " ").trim(), values))
            .rows as ReadonlyArray<Row>,
        catch: (cause) => new DatabaseError({ operation: text, cause }),
      }),
    ping: Effect.void,
  };

  snapshot() {
    return copyState(this.committed);
  }

  corruptEventSequence(workspaceId: string, eventId: string, sequence: number) {
    const key = eventKey(workspaceId, eventId);
    const event = this.committed.events.get(key);
    if (event === undefined) throw new Error("missing fake event");
    this.committed.events.set(key, { ...event, sequence });
  }

  ageCommandLocks(workspaceId: string, lastUsedAt: string) {
    for (const lock of this.committed.commandLocks.values()) {
      if (lock.workspaceId === workspaceId) lock.lastUsedAt = lastUsedAt;
    }
  }

  private async execute(
    state: FakeState,
    sql: string,
    values: ReadonlyArray<unknown>,
  ): Promise<{ readonly rows: Array<Record<string, unknown>> }> {
    if (sql.startsWith("INSERT INTO cloud_thread ")) {
      const [workspaceId, threadId, environmentId] = values.map(String);
      const key = threadKey(workspaceId!, threadId!);
      if (state.threads.has(key)) return { rows: [] };
      state.threads.set(key, { environmentId: environmentId!, nextSequence: 0 });
      return { rows: [{ thread_id: threadId }] };
    }
    if (sql.startsWith("INSERT INTO cloud_thread_command_lock")) {
      const [workspaceId, kind, value] = values.map(String);
      const key = commandLockKey(workspaceId!, kind!, value!);
      if (!state.commandLocks.has(key)) {
        state.commandLocks.set(key, {
          workspaceId: workspaceId!,
          kind: kind!,
          value: value!,
          lastUsedAt: "2026-08-27T12:00:00.000Z",
        });
      }
      const lock = state.commandLocks.get(key);
      if (lock !== undefined) lock.lastUsedAt = "2026-08-27T12:00:00.000Z";
      if (this.failNextCommandLockReturn) {
        this.failNextCommandLockReturn = false;
        return { rows: [] };
      }
      return { rows: [{ lock_kind: kind, lock_value: value }] };
    }
    if (sql.startsWith("WITH candidates AS ( SELECT workspace_id, lock_kind, lock_value")) {
      const [workspaceId, now, limit] = values;
      const cutoff =
        DateTime.toEpochMillis(DateTime.makeUnsafe(String(now))) - 24 * 60 * 60 * 1_000;
      const candidates = [...state.commandLocks.entries()]
        .filter(
          ([, lock]) =>
            lock.workspaceId === String(workspaceId) &&
            DateTime.toEpochMillis(DateTime.makeUnsafe(lock.lastUsedAt)) < cutoff,
        )
        .sort(([, left], [, right]) =>
          left.lastUsedAt < right.lastUsedAt
            ? -1
            : left.lastUsedAt > right.lastUsedAt
              ? 1
              : left.kind < right.kind
                ? -1
                : left.kind > right.kind
                  ? 1
                  : left.value < right.value
                    ? -1
                    : left.value > right.value
                      ? 1
                      : 0,
        )
        .slice(0, Number(limit));
      for (const [key] of candidates) state.commandLocks.delete(key);
      return { rows: candidates.map(([, lock]) => ({ lock_value: lock.value })) };
    }
    if (
      sql.startsWith("SELECT environment_id, next_event_sequence::text AS next_event_sequence") &&
      sql.includes("FROM cloud_thread WHERE")
    ) {
      const [workspaceId, threadId] = values.map(String);
      const thread = state.threads.get(threadKey(workspaceId!, threadId!));
      return {
        rows:
          thread === undefined
            ? []
            : [
                {
                  environment_id: thread.environmentId,
                  next_event_sequence: String(thread.nextSequence),
                },
              ],
      };
    }
    if (sql.startsWith("SELECT 1 FROM cloud_thread WHERE")) {
      const [workspaceId, addressedThreadId] = values.map(String);
      return {
        rows: state.threads.has(threadKey(workspaceId!, addressedThreadId!)) ? [{ one: 1 }] : [],
      };
    }
    if (sql.startsWith("SELECT command_id")) {
      const [workspaceId, commandId, idempotencyKey] = values.map(String);
      const byCommand = state.commands.get(commandKey(workspaceId!, commandId!));
      const mappedCommandId = state.commandKeys.get(`${workspaceId}/${idempotencyKey}`);
      const byIdempotency =
        mappedCommandId === undefined
          ? undefined
          : state.commands.get(commandKey(workspaceId!, mappedCommandId));
      return {
        rows: [...new Set([byCommand, byIdempotency].filter((row) => row !== undefined))].map(
          (row) => ({
            command_id: row.commandId,
            idempotency_key: row.idempotencyKey,
            fingerprint: row.fingerprint,
          }),
        ),
      };
    }
    if (sql.startsWith("INSERT INTO cloud_thread_command")) {
      const [workspaceId, , , commandId, idempotencyKey, commandFingerprint] = values.map(String);
      state.commands.set(commandKey(workspaceId!, commandId!), {
        commandId: commandId!,
        idempotencyKey: idempotencyKey!,
        fingerprint: commandFingerprint!,
      });
      state.commandKeys.set(`${workspaceId}/${idempotencyKey}`, commandId!);
      return { rows: [] };
    }
    if (sql.startsWith("SELECT event_id")) {
      const [workspaceId, incomingEventId] = values.map(String);
      const event = state.events.get(eventKey(workspaceId!, incomingEventId!));
      return {
        rows:
          event === undefined
            ? []
            : [
                {
                  event_id: event.eventId,
                  sequence: String(event.sequence),
                  fingerprint: event.fingerprint,
                },
              ],
      };
    }
    if (sql.startsWith("INSERT INTO cloud_thread_event")) {
      const [workspaceId, , , sequence, incomingEventId, eventFingerprint, envelope] = values;
      state.events.set(eventKey(String(workspaceId), String(incomingEventId)), {
        eventId: String(incomingEventId),
        sequence: Number(sequence),
        fingerprint: String(eventFingerprint),
        envelope: JSON.parse(String(envelope)) as unknown,
      });
      return { rows: [] };
    }
    if (sql.startsWith("UPDATE cloud_thread SET next_event_sequence")) {
      const [workspaceId, threadId, nextSequence] = values;
      const thread = state.threads.get(threadKey(String(workspaceId), String(threadId)));
      if (thread === undefined) throw new Error("missing fake thread");
      thread.nextSequence = Number(nextSequence);
      return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO cloud_thread_outbox")) {
      if (this.failNextOutbox) {
        this.failNextOutbox = false;
        throw new Error("injected outbox failure");
      }
      const [workspaceId, aggregateId, dedupeKey, payload] = values;
      const topic = sql.includes("'thread.command'") ? "thread.command" : "thread.event";
      const key = outboxKey(String(workspaceId), String(dedupeKey));
      if (state.outbox.has(key)) throw new Error("duplicate outbox delivery");
      state.outbox.set(key, {
        outboxId: `outbox-${this.nextOutboxId++}`,
        workspaceId: String(workspaceId),
        topic,
        aggregateId: String(aggregateId),
        dedupeKey: String(dedupeKey),
        payload: JSON.parse(String(payload)) as unknown,
      });
      return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO cloud_thread_approval")) {
      const [workspaceId, addressedThreadId, requestId] = values.map(String);
      const key = `${workspaceId}/${requestId}`;
      const existing = state.approvals.get(key);
      if (existing !== undefined && existing.threadId !== addressedThreadId) return { rows: [] };
      state.approvals.set(key, {
        workspaceId: workspaceId!,
        threadId: addressedThreadId!,
        payload: values,
      });
      return { rows: [{ request_id: requestId }] };
    }
    if (sql.startsWith("INSERT INTO cloud_thread_checkpoint")) {
      const [workspaceId, addressedThreadId, checkpointRef] = values.map(String);
      state.checkpoints.set(`${workspaceId}/${addressedThreadId}/${checkpointRef}`, {
        workspaceId: workspaceId!,
        threadId: addressedThreadId!,
        payload: values,
      });
      return { rows: [] };
    }
    if (sql.startsWith("SELECT thread_id, fingerprint")) {
      const [workspaceId, lifecycleId] = values.map(String);
      const existing = state.lifecycles.get(`${workspaceId}/${lifecycleId}`);
      return {
        rows:
          existing === undefined
            ? []
            : [{ thread_id: existing.threadId, fingerprint: existing.fingerprint }],
      };
    }
    if (sql.startsWith("INSERT INTO cloud_thread_runtime_lifecycle")) {
      const [workspaceId, addressedThreadId, lifecycleId, , , , lifecycleFingerprint] =
        values.map(String);
      state.lifecycles.set(`${workspaceId}/${lifecycleId}`, {
        workspaceId: workspaceId!,
        threadId: addressedThreadId!,
        fingerprint: lifecycleFingerprint!,
        payload: values,
      });
      return { rows: [] };
    }
    if (
      sql.startsWith("SELECT sequence::text AS sequence, environment_id, event_id, fingerprint")
    ) {
      const [workspaceId, threadId] = values.map(String);
      return {
        rows: [...state.events.values()]
          .filter(
            (event) =>
              String((event.envelope as { workspaceId: string }).workspaceId) === workspaceId &&
              String((event.envelope as { threadId: string }).threadId) === threadId,
          )
          .sort((left, right) => left.sequence - right.sequence)
          .map((event) => ({
            sequence: String(event.sequence),
            environment_id: String(
              (event.envelope as { readonly environmentId: string }).environmentId,
            ),
            event_id: event.eventId,
            fingerprint: event.fingerprint,
            occurred_at_text: String(
              (event.envelope as { readonly event: { readonly occurredAt: string } }).event
                .occurredAt,
            ),
            received_at_text: String(
              (event.envelope as { readonly receivedAt: string }).receivedAt,
            ),
            occurred_at_matches_text: true,
            received_at_matches_text: true,
            envelope: event.envelope,
          })),
      };
    }
    throw new Error(`unhandled fake SQL: ${sql}`);
  }
}

const decodeCommand = Schema.decodeUnknownSync(CloudThreadCommand);
const decodeEvent = Schema.decodeUnknownSync(CloudThreadEvent);

const workspaceA = "11111111-1111-4111-8111-111111111111" as WorkspaceId;
const workspaceB = "22222222-2222-4222-8222-222222222222" as WorkspaceId;
const threadId = "thread-b2" as ThreadId;
const environmentId = "environment-b2" as EnvironmentId;
const instant = "2026-08-27T12:00:00.000Z";

const identity = (workspaceId = workspaceA) => ({ workspaceId, threadId, environmentId });

const command = (commandId: string, workspaceId = workspaceA) =>
  decodeCommand({
    schemaVersion: 1,
    workspaceId,
    environmentId,
    threadId,
    command: { type: "thread.archive", commandId, threadId },
    enqueuedAt: instant,
  });

const event = (sequence: number, eventId = `event-${sequence}`, workspaceId = workspaceA) =>
  decodeEvent({
    schemaVersion: 1,
    workspaceId,
    environmentId,
    threadId,
    event: {
      type: "thread.archived",
      sequence,
      eventId,
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: instant,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: { threadId, archivedAt: instant, updatedAt: instant },
    },
    receivedAt: instant,
  });

const makeStore = (postgres: FakePostgres) =>
  make().pipe(Effect.provideService(Database, postgres.database));

it.effect("serializes concurrent event appends and safely deduplicates delivery", () => {
  const postgres = new FakePostgres();
  return Effect.gen(function* () {
    const store = yield* makeStore(postgres);
    yield* store.createThread(identity());
    const results = yield* Effect.all(
      [
        store.appendEvents({ identity: identity(), events: [event(0)] }),
        store.appendEvents({ identity: identity(), events: [event(0)] }),
      ],
      { concurrency: "unbounded" },
    );

    expect(results.map((result) => result.appended).sort()).toEqual([0, 1]);
    expect(results.map((result) => result.duplicates).sort()).toEqual([0, 1]);
    expect(postgres.snapshot().events).toHaveLength(1);
    expect(postgres.snapshot().outbox).toHaveLength(1);
  });
});

it.effect("enforces workspace-scoped command idempotency under concurrent retries", () => {
  const postgres = new FakePostgres();
  return Effect.gen(function* () {
    const store = yield* makeStore(postgres);
    yield* store.createThread(identity());
    const results = yield* Effect.all(
      [
        store.submitCommand({ idempotencyKey: "request-1", envelope: command("command-1") }),
        store.submitCommand({ idempotencyKey: "request-1", envelope: command("command-1") }),
      ],
      { concurrency: "unbounded" },
    );

    expect(results.map((result) => result.disposition).sort()).toEqual(["accepted", "duplicate"]);
    expect(postgres.snapshot().commands).toHaveLength(1);
    expect(postgres.snapshot().outbox).toHaveLength(1);

    const conflict = yield* store
      .submitCommand({ idempotencyKey: "request-1", envelope: command("command-2") })
      .pipe(Effect.flip);
    expect(conflict).toBeInstanceOf(ThreadEventStoreError);
    expect(conflict.code).toBe("idempotencyConflict");
  });
});

it.effect("retains full command lock identities for 24 hours and prunes in tenant batches", () => {
  const postgres = new FakePostgres();
  return Effect.gen(function* () {
    const store = yield* makeStore(postgres);
    yield* store.createThread(identity(workspaceA));
    yield* store.createThread(identity(workspaceB));
    yield* store.submitCommand({
      idempotencyKey: "workspace-a-lock",
      envelope: command("workspace-a-command", workspaceA),
    });
    yield* store.submitCommand({
      idempotencyKey: "workspace-b-lock",
      envelope: command("workspace-b-command", workspaceB),
    });
    expect(postgres.snapshot().commandLocks).toHaveLength(4);

    postgres.ageCommandLocks(workspaceA, "2026-08-25T11:59:59.000Z");
    expect(yield* store.pruneExpiredCommandLocks(workspaceA, instant, 1)).toBe(1);
    expect(postgres.snapshot().commandLocks).toHaveLength(3);
    expect(yield* store.pruneExpiredCommandLocks(workspaceA, instant, 1_000_000)).toBe(1);
    expect(postgres.snapshot().commandLocks).toHaveLength(2);
    expect(yield* store.pruneExpiredCommandLocks(workspaceB, instant, 1_000_000)).toBe(0);
  });
});

it.effect("rolls back instead of submitting without a returned full-key lock row", () => {
  const postgres = new FakePostgres();
  return Effect.gen(function* () {
    const store = yield* makeStore(postgres);
    yield* store.createThread(identity());
    postgres.failNextCommandLockReturn = true;

    const failure = yield* store
      .submitCommand({
        idempotencyKey: "missing-lock-return",
        envelope: command("missing-lock-command"),
      })
      .pipe(Effect.flip);
    expect(failure.code).toBe("databaseFailure");
    expect(postgres.snapshot().commandLocks).toHaveLength(0);
    expect(postgres.snapshot().commands).toHaveLength(0);
    expect(postgres.snapshot().outbox).toHaveLength(0);
  });
});

it.effect("rolls back the event when its outbox insert fails", () => {
  const postgres = new FakePostgres();
  return Effect.gen(function* () {
    const store = yield* makeStore(postgres);
    yield* store.createThread(identity());
    postgres.failNextOutbox = true;

    const failure = yield* store
      .appendEvents({ identity: identity(), events: [event(0)] })
      .pipe(Effect.flip);
    expect(failure.code).toBe("databaseFailure");
    expect(postgres.snapshot().events).toHaveLength(0);
    expect(postgres.snapshot().outbox).toHaveLength(0);
    expect(postgres.snapshot().threads.get(threadKey(workspaceA, threadId))?.nextSequence).toBe(0);

    const retry = yield* store.appendEvents({ identity: identity(), events: [event(0)] });
    expect(retry).toEqual({ appended: 1, duplicates: 0, nextSequence: 1 });
  });
});

it.effect("fails closed when another workspace addresses an existing thread", () => {
  const postgres = new FakePostgres();
  return Effect.gen(function* () {
    const store = yield* makeStore(postgres);
    yield* store.createThread(identity(workspaceA));

    const replayFailure = yield* store.replay(workspaceB, threadId).pipe(Effect.flip);
    expect(replayFailure.code).toBe("notFound");

    const commandFailure = yield* store
      .submitCommand({
        idempotencyKey: "workspace-b-request",
        envelope: command("workspace-b-command", workspaceB),
      })
      .pipe(Effect.flip);
    expect(commandFailure.code).toBe("notFound");
  });
});

it.effect("replays in sequence and rejects a corrupted gap", () => {
  const postgres = new FakePostgres();
  return Effect.gen(function* () {
    const store = yield* makeStore(postgres);
    yield* store.createThread(identity());
    yield* store.appendEvents({ identity: identity(), events: [event(0), event(1)] });

    const replay = yield* store.replay(workspaceA, threadId);
    expect(replay.map((envelope) => envelope.event.sequence)).toEqual([0, 1]);

    postgres.corruptEventSequence(workspaceA, "event-1", 2);
    const gap = yield* store.replay(workspaceA, threadId).pipe(Effect.flip);
    expect(gap.code).toBe("replayGap");
  });
});

it.effect("rejects non-contiguous new events without a partial commit", () => {
  const postgres = new FakePostgres();
  return Effect.gen(function* () {
    const store = yield* makeStore(postgres);
    yield* store.createThread(identity());

    const failure = yield* store
      .appendEvents({ identity: identity(), events: [event(0), event(2)] })
      .pipe(Effect.flip);
    expect(failure.code).toBe("sequenceConflict");
    expect(postgres.snapshot().events).toHaveLength(0);
    expect(postgres.snapshot().outbox).toHaveLength(0);
  });
});

it.effect("persists approvals, checkpoints, and idempotent runtime lifecycle records", () => {
  const postgres = new FakePostgres();
  return Effect.gen(function* () {
    const store = yield* makeStore(postgres);
    yield* store.createThread(identity());

    yield* store.saveApproval({
      workspaceId: workspaceA,
      threadId,
      requestId: "approval-1" as ApprovalRequestId,
      state: "approved",
      payload: { decision: "allow", audit: { z: 2, a: 1 } },
      requestedAt: instant,
      resolvedAt: instant,
    });
    yield* store.appendEvents({ identity: identity(), events: [event(0)] });
    yield* store.saveCheckpoint({
      workspaceId: workspaceA,
      threadId,
      checkpointRef: "checkpoint-1" as CheckpointRef,
      eventSequence: 0,
      turnCount: 1,
      payload: { ref: "refs/agents/checkpoint-1" },
      createdAt: instant,
    });
    const lifecycle = {
      workspaceId: workspaceA,
      threadId,
      lifecycleId: "lifecycle-1" as EventId,
      resourceKind: "sandbox" as const,
      resourceId: "sandbox-1",
      state: "running",
      payload: { provider: "e2b", details: { z: 2, a: 1 } },
      occurredAt: instant,
    };
    expect(yield* store.appendLifecycle(lifecycle)).toBe("appended");
    expect(
      yield* store.appendLifecycle({
        ...lifecycle,
        payload: { details: { a: 1, z: 2 }, provider: "e2b" },
      }),
    ).toBe("duplicate");

    const snapshot = postgres.snapshot();
    expect(snapshot.approvals).toHaveLength(1);
    expect(snapshot.approvals.values().next().value?.payload[4]).toBe(
      '{"audit":{"a":1,"z":2},"decision":"allow"}',
    );
    expect(snapshot.checkpoints).toHaveLength(1);
    expect(snapshot.lifecycles).toHaveLength(1);

    const conflict = yield* store
      .appendLifecycle({ ...lifecycle, state: "paused" })
      .pipe(Effect.flip);
    expect(conflict.code).toBe("eventConflict");
  });
});

it.effect("rejects every lossy or non-JSON projection payload as invalidRecord", () => {
  const postgres = new FakePostgres();
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  const sparse = Array.from<unknown>({ length: 1 });
  const invalidValues: ReadonlyArray<unknown> = [
    undefined,
    1n,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    { missing: undefined },
    sparse,
    cycle,
  ];

  return Effect.gen(function* () {
    const store = yield* makeStore(postgres);
    yield* store.createThread(identity());

    for (const [index, payload] of invalidValues.entries()) {
      const approvalFailure = yield* store
        .saveApproval({
          workspaceId: workspaceA,
          threadId,
          requestId: `invalid-approval-${index}` as ApprovalRequestId,
          state: "pending",
          payload,
          requestedAt: instant,
        })
        .pipe(Effect.flip);
      expect(approvalFailure.code).toBe("invalidRecord");

      const checkpointFailure = yield* store
        .saveCheckpoint({
          workspaceId: workspaceA,
          threadId,
          checkpointRef: `invalid-checkpoint-${index}` as CheckpointRef,
          eventSequence: 0,
          turnCount: 0,
          payload,
          createdAt: instant,
        })
        .pipe(Effect.flip);
      expect(checkpointFailure.code).toBe("invalidRecord");

      const lifecycleFailure = yield* store
        .appendLifecycle({
          workspaceId: workspaceA,
          threadId,
          lifecycleId: `invalid-lifecycle-${index}` as EventId,
          resourceKind: "worker",
          resourceId: "worker-1",
          state: "connecting",
          payload,
          occurredAt: instant,
        })
        .pipe(Effect.flip);
      expect(lifecycleFailure.code).toBe("invalidRecord");
    }

    const snapshot = postgres.snapshot();
    expect(snapshot.approvals).toHaveLength(0);
    expect(snapshot.checkpoints).toHaveLength(0);
    expect(snapshot.lifecycles).toHaveLength(0);
  });
});
