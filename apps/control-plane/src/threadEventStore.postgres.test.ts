// @effect-diagnostics nodeBuiltinImport:off -- Real PostgreSQL coverage loads checked-in migrations and creates an isolated schema.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { CloudThreadCommand, CloudThreadEvent, type WorkspaceId } from "@t3tools/contracts/cloud";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

import { Database, DatabaseError, type DatabaseService } from "./database.ts";
import { make, ThreadEventStoreError } from "./threadEventStore.ts";

const postgresUrl = process.env.AGENTSIN_TEST_POSTGRES_URL;

const decodeCommand = Schema.decodeUnknownSync(CloudThreadCommand);
const decodeEvent = Schema.decodeUnknownSync(CloudThreadEvent);
const workspaceId = "33333333-3333-4333-8333-333333333333" as WorkspaceId;
const environmentId = "real-postgres-environment" as EnvironmentId;
const instant = "2026-08-27T12:00:00.000Z";
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Json));
const legacyThreadId = "legacy-upgrade-thread" as ThreadId;

const canonicalJson = (value: Schema.Json): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const fingerprintJson = (value: Schema.Json) =>
  NodeCrypto.createHash("sha256").update(canonicalJson(value)).digest("hex");

const identity = (threadId: ThreadId) => ({ workspaceId, environmentId, threadId });
const command = (threadId: ThreadId, commandId: string) =>
  decodeCommand({
    schemaVersion: 1,
    workspaceId,
    environmentId,
    threadId,
    command: { type: "thread.archive", commandId, threadId },
    enqueuedAt: instant,
  });
const event = (threadId: ThreadId, sequence: number, eventId: string) =>
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
const legacyEnvelope = event(legacyThreadId, 0, "legacy-event-0");
const legacyJson = Schema.decodeUnknownSync(Schema.Json)(legacyEnvelope);

const makeDatabase = (pool: Pool): DatabaseService => ({
  pool,
  query: <Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: ReadonlyArray<unknown> = [],
  ) =>
    Effect.tryPromise({
      try: async () => (await pool.query<Row>(text, [...values])).rows,
      catch: (cause) => new DatabaseError({ operation: text, cause }),
    }),
  ping: Effect.void,
});

const makeBlockedCommandLockDatabase = (pool: Pool, blockedCommandId: string) => {
  const acquired = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const interceptedPool = {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (text: string, values: ReadonlyArray<unknown> = []) => {
          const result = await client.query(text, [...values]);
          const sql = text.replaceAll(/\s+/g, " ").trim();
          if (
            sql.startsWith("INSERT INTO cloud_thread_command_lock") &&
            values[1] === "command_id" &&
            values[2] === blockedCommandId
          ) {
            acquired.resolve();
            await release.promise;
          }
          return result;
        },
        release: () => client.release(),
      } as unknown as PoolClient;
    },
  } as unknown as Pool;
  return {
    database: { ...makeDatabase(pool), pool: interceptedPool },
    acquired: acquired.promise,
    release: () => release.resolve(),
  };
};

interface RealPostgresFixture {
  readonly admin: Pool;
  readonly pool: Pool;
  readonly schema: string;
  readonly freshPool: Pool;
  readonly freshSchema: string;
}

const realPostgresFixture = (url: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async (): Promise<RealPostgresFixture> => {
        const schema = `agentsin_b2_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
        const freshSchema = `${schema}_fresh`;
        const admin = new Pool({ connectionString: url, max: 1 });
        await admin.query(`CREATE SCHEMA "${schema}"`);
        await admin.query(`CREATE SCHEMA "${freshSchema}"`);
        const pool = new Pool({
          connectionString: url,
          max: 8,
          options: `-c search_path=${schema}`,
          connectionTimeoutMillis: 5_000,
          query_timeout: 10_000,
          statement_timeout: 10_000,
        });
        const freshPool = new Pool({
          connectionString: url,
          max: 2,
          options: `-c search_path=${freshSchema}`,
          connectionTimeoutMillis: 5_000,
          query_timeout: 10_000,
          statement_timeout: 10_000,
        });
        const [workspaceMigration, threadStoreMigration, integrityMigration] = await Promise.all([
          NodeFSP.readFile(new URL("./migrations/0001-workspaces.sql", import.meta.url), "utf8"),
          NodeFSP.readFile(
            new URL("./migrations/0002-cloud-thread-store.sql", import.meta.url),
            "utf8",
          ),
          NodeFSP.readFile(
            new URL("./migrations/0003-thread-integrity-locks.sql", import.meta.url),
            "utf8",
          ),
        ]);
        await pool.query('CREATE TABLE "user" (id text PRIMARY KEY)');
        await pool.query(workspaceMigration);
        await pool.query(threadStoreMigration);
        await pool.query(threadStoreMigration);
        await pool.query('INSERT INTO "user" (id) VALUES ($1)', ["real-postgres-user"]);
        await pool.query("INSERT INTO workspace (id, owner_user_id, name) VALUES ($1, $2, $3)", [
          workspaceId,
          "real-postgres-user",
          "Real PostgreSQL workspace",
        ]);
        await pool.query(
          `INSERT INTO cloud_thread
             (workspace_id, thread_id, environment_id, next_event_sequence)
           VALUES ($1, $2, $3, 1)`,
          [workspaceId, legacyThreadId, environmentId],
        );
        await pool.query(
          `INSERT INTO cloud_thread_event
             (workspace_id, thread_id, environment_id, sequence, event_id, fingerprint,
              envelope, occurred_at, received_at)
           VALUES ($1, $2, $3, 0, $4, $5, $6::jsonb, $7, $8)`,
          [
            workspaceId,
            legacyThreadId,
            environmentId,
            "legacy-event-0",
            fingerprintJson(legacyJson),
            encodeJson(legacyJson),
            instant,
            instant,
          ],
        );
        await pool.query(integrityMigration);
        await pool.query(integrityMigration);
        await freshPool.query('CREATE TABLE "user" (id text PRIMARY KEY)');
        await freshPool.query(workspaceMigration);
        await freshPool.query(threadStoreMigration);
        await freshPool.query(integrityMigration);
        await freshPool.query(integrityMigration);
        await freshPool.query('INSERT INTO "user" (id) VALUES ($1)', ["fresh-postgres-user"]);
        await freshPool.query(
          "INSERT INTO workspace (id, owner_user_id, name) VALUES ($1, $2, $3)",
          [workspaceId, "fresh-postgres-user", "Fresh PostgreSQL workspace"],
        );
        return { admin, pool, schema, freshPool, freshSchema };
      },
      catch: (cause) => new DatabaseError({ operation: "create real PostgreSQL fixture", cause }),
    }),
    ({ admin, pool, schema, freshPool, freshSchema }) =>
      Effect.tryPromise({
        try: async () => {
          await pool.end();
          await freshPool.end();
          await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          await admin.query(`DROP SCHEMA IF EXISTS "${freshSchema}" CASCADE`);
          await admin.end();
        },
        catch: (cause) =>
          new DatabaseError({ operation: "dispose real PostgreSQL fixture", cause }),
      }).pipe(Effect.catch(() => Effect.void)),
  );

const query = <Row extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  text: string,
  values: ReadonlyArray<unknown> = [],
) =>
  Effect.tryPromise({
    try: () => pool.query<Row>(text, [...values]),
    catch: (cause) => new DatabaseError({ operation: text, cause }),
  });

const expectReplayFailure = (
  replay: Effect.Effect<unknown, ThreadEventStoreError>,
  code: ThreadEventStoreError["code"],
) =>
  replay.pipe(
    Effect.result,
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) expect(result.failure.code).toBe(code);
      }),
    ),
    Effect.asVoid,
  );

it.effect(
  "uses real PostgreSQL locks and detects adversarial stored-row corruption when configured",
  () => {
    if (postgresUrl === undefined) return Effect.void;

    return Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* realPostgresFixture(postgresUrl);
        const store = yield* make().pipe(
          Effect.provideService(Database, makeDatabase(fixture.pool)),
        );
        const freshStore = yield* make().pipe(
          Effect.provideService(Database, makeDatabase(fixture.freshPool)),
        );
        const freshThread = "fresh-migration-thread" as ThreadId;
        yield* freshStore.createThread(identity(freshThread));
        yield* freshStore.appendEvents({
          identity: identity(freshThread),
          events: [event(freshThread, 0, "fresh-event-0")],
        });
        expect(yield* freshStore.replay(workspaceId, freshThread)).toHaveLength(1);

        const backfilled = yield* query<{
          readonly occurred_at_text: string;
          readonly received_at_text: string;
        }>(
          fixture.pool,
          `SELECT occurred_at_text, received_at_text
             FROM cloud_thread_event
            WHERE workspace_id = $1 AND thread_id = $2`,
          [workspaceId, legacyThreadId],
        );
        expect(backfilled.rows[0]).toEqual({
          occurred_at_text: instant,
          received_at_text: instant,
        });
        expect(yield* store.replay(workspaceId, legacyThreadId)).toHaveLength(1);
        yield* store.appendEvents({
          identity: identity(legacyThreadId),
          events: [event(legacyThreadId, 1, "legacy-event-1")],
        });
        expect(
          (yield* store.replay(workspaceId, legacyThreadId)).map(
            (envelope) => envelope.event.sequence,
          ),
        ).toEqual([0, 1]);

        const firstThread = "real-command-a" as ThreadId;
        const secondThread = "real-command-b" as ThreadId;
        yield* store.createThread(identity(firstThread));
        yield* store.createThread(identity(secondThread));

        const submissions = yield* Effect.all(
          [
            store
              .submitCommand({
                idempotencyKey: "shared/full:key/🔥",
                envelope: command(firstThread, "real-command/one:🔥"),
              })
              .pipe(Effect.result),
            store
              .submitCommand({
                idempotencyKey: "shared/full:key/🔥",
                envelope: command(secondThread, "real-command/two:🔥"),
              })
              .pipe(Effect.result),
          ],
          { concurrency: "unbounded" },
        );
        expect(submissions.filter(Result.isSuccess)).toHaveLength(1);
        const rejected = submissions.find(Result.isFailure);
        expect(rejected?.failure.code).toBe("idempotencyConflict");
        expect(rejected?.failure.code).not.toBe("databaseFailure");

        const thirdThread = "real-command-c" as ThreadId;
        const fourthThread = "real-command-d" as ThreadId;
        yield* store.createThread(identity(thirdThread));
        yield* store.createThread(identity(fourthThread));
        const sharedCommandIdSubmissions = yield* Effect.all(
          [
            store
              .submitCommand({
                idempotencyKey: "cross-thread/key:a/🔥",
                envelope: command(thirdThread, "shared-cross-thread/command:🔥"),
              })
              .pipe(Effect.result),
            store
              .submitCommand({
                idempotencyKey: "cross-thread/key:b/🔥",
                envelope: command(fourthThread, "shared-cross-thread/command:🔥"),
              })
              .pipe(Effect.result),
          ],
          { concurrency: "unbounded" },
        );
        expect(sharedCommandIdSubmissions.filter(Result.isSuccess)).toHaveLength(1);
        const rejectedCommandId = sharedCommandIdSubmissions.find(Result.isFailure);
        expect(rejectedCommandId?.failure.code).toBe("idempotencyConflict");
        expect(rejectedCommandId?.failure.code).not.toBe("databaseFailure");

        const fullKeyThread = "real-command-full-key" as ThreadId;
        yield* store.createThread(identity(fullKeyThread));
        expect(
          yield* store.submitCommand({
            idempotencyKey: "same:value/with:delimiters/🔥",
            envelope: command(fullKeyThread, "same:value/with:delimiters/🔥"),
          }),
        ).toEqual({
          disposition: "accepted",
          commandId: "same:value/with:delimiters/🔥",
        });
        const fullKeyLocks = yield* query<{
          readonly lock_kind: string;
          readonly lock_value: string;
        }>(
          fixture.pool,
          `SELECT lock_kind, lock_value
             FROM cloud_thread_command_lock
            WHERE workspace_id = $1
              AND lock_value = 'same:value/with:delimiters/🔥'
            ORDER BY lock_kind`,
          [workspaceId],
        );
        expect(fullKeyLocks.rows).toEqual([
          { lock_kind: "command_id", lock_value: "same:value/with:delimiters/🔥" },
          { lock_kind: "idempotency_key", lock_value: "same:value/with:delimiters/🔥" },
        ]);
        yield* query(
          fixture.pool,
          `UPDATE cloud_thread_command_lock
              SET last_used_at = '2026-08-25T00:00:00.000Z'
            WHERE workspace_id = $1`,
          [workspaceId],
        );
        expect(yield* store.pruneExpiredCommandLocks(workspaceId, instant, 2)).toBe(2);
        expect(yield* store.pruneExpiredCommandLocks(workspaceId, instant, 1_000)).toBe(4);
        const remainingLocks = yield* query<{ readonly count: string }>(
          fixture.pool,
          "SELECT count(*)::text AS count FROM cloud_thread_command_lock WHERE workspace_id = $1",
          [workspaceId],
        );
        expect(remainingLocks.rows[0]?.count).toBe("0");
        expect(
          yield* store.submitCommand({
            idempotencyKey: "same:value/with:delimiters/🔥",
            envelope: command(fullKeyThread, "same:value/with:delimiters/🔥"),
          }),
        ).toEqual({
          disposition: "duplicate",
          commandId: "same:value/with:delimiters/🔥",
        });

        const pruneRaceCommandId = "prune-race/full:command/🔥";
        const pruneRaceIdempotency = "prune-race/full:idempotency/🔥";
        const pruneRaceThread = "prune-race-first" as ThreadId;
        const pruneRaceCompetitorThread = "prune-race-competitor" as ThreadId;
        yield* store.createThread(identity(pruneRaceThread));
        yield* store.createThread(identity(pruneRaceCompetitorThread));
        yield* query(
          fixture.pool,
          "DELETE FROM cloud_thread_command_lock WHERE workspace_id = $1",
          [workspaceId],
        );
        yield* query(
          fixture.pool,
          `INSERT INTO cloud_thread_command_lock
             (workspace_id, lock_kind, lock_value, last_used_at)
           VALUES
             ($1, 'command_id', $2, '2026-08-25T00:00:00.000Z'),
             ($1, 'idempotency_key', $3, '2026-08-25T00:00:00.000Z')`,
          [workspaceId, pruneRaceCommandId, pruneRaceIdempotency],
        );
        const barrier = makeBlockedCommandLockDatabase(fixture.pool, pruneRaceCommandId);
        const blockedStore = yield* make().pipe(Effect.provideService(Database, barrier.database));
        const interleaving = yield* Effect.gen(function* () {
          const firstFiber = yield* Effect.forkChild(
            blockedStore.submitCommand({
              idempotencyKey: pruneRaceIdempotency,
              envelope: command(pruneRaceThread, pruneRaceCommandId),
            }),
            { startImmediately: true },
          );
          yield* Effect.promise(() => barrier.acquired);
          const competitorFiber = yield* Effect.forkChild(
            store
              .submitCommand({
                idempotencyKey: "prune-race/competitor:key/🔥",
                envelope: command(pruneRaceCompetitorThread, pruneRaceCommandId),
              })
              .pipe(Effect.result),
            { startImmediately: true },
          );
          const pruned = yield* store.pruneExpiredCommandLocks(workspaceId, instant, 100);
          const rowsWhileAcquired = yield* query<{
            readonly lock_kind: string;
            readonly lock_value: string;
          }>(
            fixture.pool,
            `SELECT lock_kind, lock_value
               FROM cloud_thread_command_lock
              WHERE workspace_id = $1
              ORDER BY lock_kind, lock_value`,
            [workspaceId],
          );
          return { competitorFiber, firstFiber, pruned, rowsWhileAcquired: rowsWhileAcquired.rows };
        }).pipe(Effect.ensuring(Effect.sync(barrier.release)));
        expect(interleaving.pruned).toBe(1);
        expect(interleaving.rowsWhileAcquired).toEqual([
          { lock_kind: "command_id", lock_value: pruneRaceCommandId },
        ]);
        expect(yield* Fiber.join(interleaving.firstFiber)).toEqual({
          disposition: "accepted",
          commandId: pruneRaceCommandId,
        });
        const competitor = yield* Fiber.join(interleaving.competitorFiber);
        expect(Result.isFailure(competitor)).toBe(true);
        if (Result.isFailure(competitor)) {
          expect(competitor.failure.code).toBe("idempotencyConflict");
          expect(competitor.failure.code).not.toBe("databaseFailure");
        }
        expect(
          yield* store.submitCommand({
            idempotencyKey: pruneRaceIdempotency,
            envelope: command(pruneRaceThread, pruneRaceCommandId),
          }),
        ).toEqual({ disposition: "duplicate", commandId: pruneRaceCommandId });

        const replayThread = "real-replay-thread" as ThreadId;
        yield* store.createThread(identity(replayThread));
        yield* store.appendEvents({
          identity: identity(replayThread),
          events: [event(replayThread, 0, "real-event-0")],
        });
        expect(yield* store.replay(workspaceId, replayThread)).toHaveLength(1);
        const originalRow = yield* query<{
          readonly fingerprint: string;
          readonly envelope: unknown;
        }>(
          fixture.pool,
          "SELECT fingerprint, envelope FROM cloud_thread_event WHERE workspace_id = $1 AND thread_id = $2",
          [workspaceId, replayThread],
        );
        const originalFingerprint = originalRow.rows[0]?.fingerprint;
        const originalEnvelope = originalRow.rows[0]?.envelope;
        expect(originalFingerprint).toBeTypeOf("string");
        expect(originalEnvelope).toBeTypeOf("object");

        yield* query(
          fixture.pool,
          "UPDATE cloud_thread_event SET event_id = 'corrupt-id' WHERE workspace_id = $1 AND thread_id = $2",
          [workspaceId, replayThread],
        );
        yield* expectReplayFailure(store.replay(workspaceId, replayThread), "eventConflict");
        yield* query(
          fixture.pool,
          "UPDATE cloud_thread_event SET event_id = 'real-event-0', fingerprint = 'corrupt' WHERE workspace_id = $1 AND thread_id = $2",
          [workspaceId, replayThread],
        );
        yield* expectReplayFailure(store.replay(workspaceId, replayThread), "eventConflict");
        yield* query(
          fixture.pool,
          `UPDATE cloud_thread_event
            SET fingerprint = $3,
                occurred_at = occurred_at + interval '1 second'
          WHERE workspace_id = $1 AND thread_id = $2`,
          [workspaceId, replayThread, originalFingerprint],
        );
        yield* expectReplayFailure(store.replay(workspaceId, replayThread), "eventConflict");
        yield* query(
          fixture.pool,
          `UPDATE cloud_thread_event
            SET occurred_at = occurred_at_text::timestamptz,
                received_at = received_at + interval '1 second'
          WHERE workspace_id = $1 AND thread_id = $2`,
          [workspaceId, replayThread],
        );
        yield* expectReplayFailure(store.replay(workspaceId, replayThread), "eventConflict");
        yield* query(
          fixture.pool,
          `UPDATE cloud_thread_event
            SET received_at = received_at_text::timestamptz,
                envelope = jsonb_set(envelope, '{environmentId}', '"corrupt-environment"'::jsonb)
          WHERE workspace_id = $1 AND thread_id = $2`,
          [workspaceId, replayThread],
        );
        yield* expectReplayFailure(store.replay(workspaceId, replayThread), "tenantMismatch");
        yield* query(
          fixture.pool,
          `UPDATE cloud_thread_event
            SET envelope = $3::jsonb,
                fingerprint = $4,
                sequence = 1
          WHERE workspace_id = $1 AND thread_id = $2`,
          [workspaceId, replayThread, encodeJson(originalEnvelope), originalFingerprint],
        );
        yield* expectReplayFailure(store.replay(workspaceId, replayThread), "replayGap");
      }),
    );
  },
);
