// @effect-diagnostics nodeBuiltinImport:off -- The real PostgreSQL fixture reads checked-in migrations and hashes bytes.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import { expect, it } from "@effect/vitest";
import type { ThreadId } from "@t3tools/contracts";
import type { WorkspaceId } from "@t3tools/contracts/cloud";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { Pool, type QueryResultRow } from "pg";

import { makePostgresArtifactRepository } from "./artifactRepository.ts";
import { artifactObjectKey } from "./artifactKeys.ts";
import { makeArtifactStorage } from "./artifactStorage.ts";
import { DatabaseError, type DatabaseService } from "./database.ts";
import { makeMemoryObjectStorage } from "./r2ObjectStore.ts";
import { createThreadExport, makePostgresThreadExportSource } from "./threadExport.ts";

const postgresUrl = process.env.AGENTSIN_TEST_POSTGRES_URL;
const workspaceId = "00000000-0000-4000-8000-000000000001" as WorkspaceId;
const otherWorkspaceId = "00000000-0000-4000-8000-000000000002" as WorkspaceId;
const threadId = "artifact-pg-thread" as ThreadId;
const otherThreadId = "artifact-pg-thread-two" as ThreadId;
const instant = "2026-08-27T00:00:00.000Z";

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

const makeCoordinatedExportSource = (pool: Pool) => {
  const firstInsertReached = Promise.withResolvers<void>();
  const releaseFirstInsert = Promise.withResolvers<void>();
  const secondLockAttempted = Promise.withResolvers<void>();
  let insertAttempts = 0;
  let lockAttempts = 0;
  const coordinatedPool = new Proxy(pool, {
    get: (target, property) => {
      if (property !== "connect") {
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async () => {
        const client = await target.connect();
        return new Proxy(client, {
          get: (clientTarget, clientProperty) => {
            if (clientProperty !== "query") {
              const value: unknown = Reflect.get(clientTarget, clientProperty, clientTarget);
              return typeof value === "function" ? value.bind(clientTarget) : value;
            }
            return async (text: string, values: ReadonlyArray<unknown> = []) => {
              if (text.includes("pg_advisory_lock(") || text.includes("pg_advisory_xact_lock(")) {
                lockAttempts += 1;
                if (lockAttempts === 2) secondLockAttempted.resolve();
              }
              if (text.includes("INSERT INTO cloud_thread_export_intent")) {
                insertAttempts += 1;
                if (insertAttempts === 1) {
                  firstInsertReached.resolve();
                  await releaseFirstInsert.promise;
                }
              }
              return clientTarget.query(text, [...values]);
            };
          },
        });
      };
    },
  }) as Pool;
  return {
    source: makePostgresThreadExportSource({
      ...makeDatabase(pool),
      pool: coordinatedPool,
    }),
    firstInsertReached: firstInsertReached.promise,
    releaseFirstInsert: releaseFirstInsert.resolve,
    secondLockAttempted: secondLockAttempted.promise,
    insertAttempts: () => insertAttempts,
  };
};

it.effect(
  "persists verified metadata and outbox completion in real PostgreSQL when configured",
  () => {
    if (postgresUrl === undefined) return Effect.void;
    return Effect.scoped(
      Effect.gen(function* () {
        const schema = `agentsin_b6_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
        const admin = yield* Effect.acquireRelease(
          Effect.promise(() =>
            Promise.resolve(new Pool({ connectionString: postgresUrl, max: 1 })),
          ),
          (pool) => Effect.promise(() => pool.end()),
        );
        yield* Effect.promise(() => admin.query(`CREATE SCHEMA "${schema}"`));
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)).pipe(
            Effect.asVoid,
          ),
        );
        const pool = yield* Effect.acquireRelease(
          Effect.promise(() =>
            Promise.resolve(
              new Pool({
                connectionString: postgresUrl,
                max: 4,
                options: `-c search_path=${schema} -c timezone=Pacific/Honolulu -c DateStyle=SQL,DMY`,
                connectionTimeoutMillis: 5_000,
                query_timeout: 10_000,
                statement_timeout: 10_000,
              }),
            ),
          ),
          (active) => Effect.promise(() => active.end()),
        );
        const [workspaceMigration, threadMigration, artifactMigration] = yield* Effect.promise(() =>
          Promise.all([
            NodeFSP.readFile(new URL("./migrations/0001-workspaces.sql", import.meta.url), "utf8"),
            NodeFSP.readFile(
              new URL("./migrations/0002-cloud-thread-store.sql", import.meta.url),
              "utf8",
            ),
            NodeFSP.readFile(
              new URL("./migrations/0010-artifact-storage.sql", import.meta.url),
              "utf8",
            ),
          ]),
        );
        yield* Effect.promise(() => pool.query('CREATE TABLE "user" (id text PRIMARY KEY)'));
        yield* Effect.promise(() => pool.query(workspaceMigration));
        yield* Effect.promise(() => pool.query(threadMigration));
        yield* Effect.promise(() => pool.query(artifactMigration));
        yield* Effect.promise(() =>
          pool.query("ALTER TABLE cloud_thread_artifact_outbox DROP COLUMN lease_token"),
        );
        yield* Effect.promise(() =>
          pool.query("DROP INDEX cloud_thread_artifact_outbox_claim_idx"),
        );
        yield* Effect.promise(() => pool.query(artifactMigration));
        const upgradedOutbox = yield* Effect.promise(() =>
          pool.query<{ readonly column_name: string }>(
            `SELECT column_name FROM information_schema.columns
              WHERE table_schema = $1 AND table_name = 'cloud_thread_artifact_outbox'
                AND column_name = 'lease_token'`,
            [schema],
          ),
        );
        const upgradedClaimIndex = yield* Effect.promise(() =>
          pool.query<{ readonly indexname: string }>(
            `SELECT indexname FROM pg_indexes
              WHERE schemaname = $1 AND indexname = 'cloud_thread_artifact_outbox_claim_idx'`,
            [schema],
          ),
        );
        expect(upgradedOutbox.rows).toHaveLength(1);
        expect(upgradedClaimIndex.rows).toHaveLength(1);
        yield* Effect.promise(() =>
          pool.query('INSERT INTO "user" (id) VALUES ($1), ($2)', ["user-1", "user-2"]),
        );
        yield* Effect.promise(() =>
          pool.query(
            "INSERT INTO workspace (id, owner_user_id, name) VALUES ($1, $2, $3), ($4, $5, $6)",
            [workspaceId, "user-1", "Workspace one", otherWorkspaceId, "user-2", "Workspace two"],
          ),
        );
        yield* Effect.promise(() =>
          pool.query(
            `INSERT INTO cloud_thread (workspace_id, thread_id, environment_id)
           VALUES ($1, $2, 'environment-1'), ($1, $3, 'environment-3'),
                  ($4, $2, 'environment-2')`,
            [workspaceId, threadId, otherThreadId, otherWorkspaceId],
          ),
        );

        const objects = makeMemoryObjectStorage();
        const repository = makePostgresArtifactRepository(makeDatabase(pool));
        const service = makeArtifactStorage({
          repository,
          objects: objects.service,
          clock: { now: () => instant },
        });
        const bytes = new TextEncoder().encode("postgres artifact");
        const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
        const first = yield* service.upload({
          workspaceId,
          threadId,
          artifactId: "pg-artifact",
          idempotencyKey: "pg-delivery",
          kind: "diff",
          byteLength: bytes.byteLength,
          sha256,
          mediaType: "text/x-diff",
          retentionUntil: "2026-08-28T00:00:00Z",
          expiresAt: "2026-08-29T00:00:00Z",
          body: (async function* () {
            yield bytes;
          })(),
        });
        expect(first.artifact.state).toBe("complete");
        expect(first.artifact.retentionUntil).toBe("2026-08-28T00:00:00.000Z");
        expect(first.artifact.expiresAt).toBe("2026-08-29T00:00:00.000Z");
        const outbox = yield* Effect.promise(() =>
          pool.query<{ readonly status: string; readonly completed_at: string | null }>(
            `SELECT status, completed_at::text AS completed_at
             FROM cloud_thread_artifact_outbox
            WHERE workspace_id = $1 AND thread_id = $2 AND artifact_id = $3
              AND operation = 'verify_upload'`,
            [workspaceId, threadId, "pg-artifact"],
          ),
        );
        expect(outbox.rows).toHaveLength(1);
        expect(outbox.rows[0]?.status).toBe("completed");
        expect(outbox.rows[0]?.completed_at).not.toBeNull();

        const duplicate = yield* service.upload({
          workspaceId,
          threadId,
          artifactId: "pg-artifact",
          idempotencyKey: "pg-delivery",
          kind: "diff",
          byteLength: bytes.byteLength,
          sha256,
          mediaType: "text/x-diff",
          retentionUntil: "2026-08-28T00:00:00Z",
          expiresAt: "2026-08-29T00:00:00Z",
          body: (async function* () {
            yield bytes;
          })(),
        });
        expect(duplicate.disposition).toBe("existing");

        const otherThread = yield* service.upload({
          workspaceId,
          threadId: otherThreadId,
          artifactId: "pg-artifact",
          idempotencyKey: "pg-delivery",
          kind: "diff",
          byteLength: bytes.byteLength,
          sha256,
          mediaType: "text/x-diff",
          body: (async function* () {
            yield bytes;
          })(),
        });
        expect(otherThread.disposition).toBe("created");
        expect(otherThread.artifact.objectKey).not.toBe(first.artifact.objectKey);

        const crossTenant = yield* Effect.result(
          service.download(otherWorkspaceId, threadId, "pg-artifact"),
        );
        expect(Result.isFailure(crossTenant)).toBe(true);

        const conflictBytes = new TextEncoder().encode("conflicting postgres artifact");
        const conflict = yield* Effect.result(
          service.upload({
            workspaceId,
            threadId,
            artifactId: "other-artifact",
            idempotencyKey: "pg-delivery",
            kind: "diff",
            byteLength: conflictBytes.byteLength,
            sha256: NodeCrypto.createHash("sha256").update(conflictBytes).digest("hex"),
            mediaType: "text/x-diff",
            body: (async function* () {
              yield conflictBytes;
            })(),
          }),
        );
        expect(Result.isFailure(conflict)).toBe(true);
        if (Result.isFailure(conflict)) expect(conflict.failure.code).toBe("conflict");

        yield* Effect.promise(() =>
          pool.query(
            `INSERT INTO cloud_thread_command
               (workspace_id, thread_id, environment_id, command_id, idempotency_key,
                fingerprint, envelope, enqueued_at, created_at)
             VALUES ($1, $2, 'environment-1', 'command-1', 'command-delivery-1', $3,
               '{"prompt":"safe","providerToken":"must-redact"}'::jsonb, $4, $4)`,
            [workspaceId, threadId, "a".repeat(64), instant],
          ),
        );
        yield* Effect.promise(() =>
          pool.query(
            `INSERT INTO cloud_thread_event
               (workspace_id, thread_id, environment_id, sequence, event_id, fingerprint,
                envelope, occurred_at, received_at, created_at)
             VALUES ($1, $2, 'environment-1', 0, 'event-1', $3,
               '{"message":"event"}'::jsonb, $4, $4, $4)`,
            [workspaceId, threadId, "b".repeat(64), instant],
          ),
        );
        yield* Effect.promise(() =>
          pool.query(
            `INSERT INTO cloud_thread_approval
               (workspace_id, thread_id, request_id, state, payload, requested_at)
             VALUES ($1, $2, 'approval-1', 'approved', '{"wallet":"must-redact"}'::jsonb, $3)`,
            [workspaceId, threadId, instant],
          ),
        );
        yield* Effect.promise(() =>
          pool.query(
            `INSERT INTO cloud_thread_checkpoint
               (workspace_id, thread_id, checkpoint_ref, event_sequence, turn_count, payload,
                created_at)
             VALUES ($1, $2, 'checkpoint-1', 0, 1,
               '{"summary":"checkpoint"}'::jsonb, $3)`,
            [workspaceId, threadId, instant],
          ),
        );
        const exportSource = makePostgresThreadExportSource(makeDatabase(pool));
        for (const invalidIdentity of [
          { exportId: "x".repeat(257), idempotencyKey: "valid-export-delivery" },
          { exportId: "valid-export", idempotencyKey: "x".repeat(257) },
        ]) {
          const invalidExport = yield* Effect.result(
            createThreadExport({
              source: exportSource,
              storage: service,
              workspaceId,
              threadId,
              ...invalidIdentity,
              createdAt: instant,
            }),
          );
          expect(Result.isFailure(invalidExport)).toBe(true);
        }
        const poisonedIntents = yield* Effect.promise(() =>
          pool.query<{ readonly count: string }>(
            `SELECT count(*)::text AS count FROM cloud_thread_export_intent
              WHERE workspace_id = $1 AND thread_id = $2`,
            [workspaceId, threadId],
          ),
        );
        expect(poisonedIntents.rows[0]?.count).toBe("0");

        const identical = makeCoordinatedExportSource(pool);
        const firstIdentical = yield* Effect.forkChild(
          identical.source.prepare({
            workspaceId,
            threadId,
            exportId: "pg-concurrent-identical",
            idempotencyKey: "pg-concurrent-identical-delivery",
            createdAt: instant,
          }),
        );
        yield* Effect.promise(() => identical.firstInsertReached);
        const secondIdentical = yield* Effect.forkChild(
          identical.source.prepare({
            workspaceId,
            threadId,
            exportId: "pg-concurrent-identical",
            idempotencyKey: "pg-concurrent-identical-delivery",
            createdAt: "2026-08-28T00:00:00.000Z",
          }),
        );
        yield* Effect.promise(() => identical.secondLockAttempted);
        identical.releaseFirstInsert();
        const [firstIdenticalIntent, secondIdenticalIntent] = yield* Effect.all([
          Fiber.join(firstIdentical),
          Fiber.join(secondIdentical),
        ]);
        expect(secondIdenticalIntent).toEqual(firstIdenticalIntent);
        expect(identical.insertAttempts()).toBe(1);

        const conflicting = makeCoordinatedExportSource(pool);
        const firstConflict = yield* Effect.forkChild(
          conflicting.source.prepare({
            workspaceId,
            threadId,
            exportId: "pg-concurrent-conflict-winner",
            idempotencyKey: "pg-concurrent-conflict-delivery",
            createdAt: instant,
          }),
        );
        yield* Effect.promise(() => conflicting.firstInsertReached);
        const secondConflict = yield* Effect.forkChild(
          Effect.result(
            conflicting.source.prepare({
              workspaceId,
              threadId,
              exportId: "pg-concurrent-conflict-loser",
              idempotencyKey: "pg-concurrent-conflict-delivery",
              createdAt: instant,
            }),
          ),
        );
        yield* Effect.promise(() => conflicting.secondLockAttempted);
        conflicting.releaseFirstInsert();
        yield* Fiber.join(firstConflict);
        const conflictResult = yield* Fiber.join(secondConflict);
        expect(Result.isFailure(conflictResult)).toBe(true);
        if (Result.isFailure(conflictResult)) {
          expect(conflictResult.failure.code).toBe("idempotencyConflict");
          expect(conflictResult.failure.retryable).toBe(false);
        }
        expect(conflicting.insertAttempts()).toBe(1);

        const prepared = yield* exportSource.prepare({
          workspaceId,
          threadId,
          exportId: "pg-export",
          idempotencyKey: "pg-export-delivery",
          createdAt: instant,
        });
        const snapshot = prepared.snapshot;
        expect(snapshot.commands).toHaveLength(1);
        expect(snapshot.events).toHaveLength(1);
        expect(snapshot.approvals).toHaveLength(1);
        expect(snapshot.checkpoints).toHaveLength(1);
        expect(snapshot.artifacts).toHaveLength(1);
        expect(snapshot.events[0]?.timestamp).toBe(instant);
        const retryIntent = yield* exportSource.prepare({
          workspaceId,
          threadId,
          exportId: "pg-export",
          idempotencyKey: "pg-export-delivery",
          createdAt: "2026-08-28T00:00:00.000Z",
        });
        expect(retryIntent).toEqual(prepared);
        const utcPool = yield* Effect.acquireRelease(
          Effect.promise(() =>
            Promise.resolve(
              new Pool({
                connectionString: postgresUrl,
                max: 1,
                options: `-c search_path=${schema} -c timezone=UTC -c DateStyle=ISO,MDY`,
                connectionTimeoutMillis: 5_000,
                query_timeout: 10_000,
                statement_timeout: 10_000,
              }),
            ),
          ),
          (active) => Effect.promise(() => active.end()),
        );
        const utcIntent = yield* makePostgresThreadExportSource(makeDatabase(utcPool)).prepare({
          workspaceId,
          threadId,
          exportId: "pg-export-utc",
          idempotencyKey: "pg-export-utc-delivery",
          createdAt: instant,
        });
        expect(utcIntent.snapshot.events[0]?.timestamp).toBe(
          prepared.snapshot.events[0]?.timestamp,
        );
        for (const source of [
          exportSource,
          makePostgresThreadExportSource(makeDatabase(utcPool)),
        ]) {
          const timezoneDependent = yield* Effect.result(
            source.prepare({
              workspaceId,
              threadId,
              exportId: `timezone-dependent-${NodeCrypto.randomUUID()}`,
              idempotencyKey: `timezone-dependent-${NodeCrypto.randomUUID()}`,
              createdAt: "2026-08-27 00:00:00",
            }),
          );
          expect(Result.isFailure(timezoneDependent)).toBe(true);
          if (Result.isFailure(timezoneDependent)) {
            expect(timezoneDependent.failure.code).toBe("invalidRecord");
          }
        }
        yield* Effect.promise(() =>
          pool.query(
            `INSERT INTO cloud_thread_approval
               (workspace_id, thread_id, request_id, state, payload, requested_at)
             VALUES ($1, $2, $3, 'approved', '{}'::jsonb, $4)`,
            [workspaceId, threadId, "x".repeat(1_025), instant],
          ),
        );
        const oversizedRecord = yield* Effect.result(
          exportSource.prepare({
            workspaceId,
            threadId,
            exportId: "pg-export-oversized",
            idempotencyKey: "pg-export-oversized-delivery",
            createdAt: instant,
          }),
        );
        expect(Result.isFailure(oversizedRecord)).toBe(true);
        if (Result.isFailure(oversizedRecord)) {
          expect(oversizedRecord.failure.code).toBe("invalidRecord");
        }

        const crashId = "pg-crash-put";
        const crashKey = artifactObjectKey({ workspaceId, threadId }, "diff", crashId, sha256);
        yield* repository.reserve({
          workspaceId,
          threadId,
          artifactId: crashId,
          idempotencyKey: crashId,
          kind: "diff",
          objectKey: crashKey,
          byteLength: bytes.byteLength,
          sha256,
          mediaType: "text/x-diff",
          createdAt: instant,
        });
        yield* repository.markUploading(workspaceId, threadId, crashId, instant);
        yield* objects.service.putImmutable({
          key: crashKey,
          body: (async function* () {
            yield bytes;
          })(),
          byteLength: bytes.byteLength,
          sha256,
          mediaType: "text/x-diff",
        });
        const claimInput = {
          now: instant,
          leaseExpiresAt: "2026-08-27T00:01:00.000Z",
          limit: 10,
          maxAttempts: 3,
        } as const;
        const [consumerOne, consumerTwo] = yield* Effect.all(
          [repository.claimOutbox(claimInput), repository.claimOutbox(claimInput)],
          { concurrency: "unbounded" },
        );
        expect(
          [...consumerOne, ...consumerTwo].filter((item) => item.artifactId === crashId),
        ).toHaveLength(1);
        const crashClaim = [...consumerOne, ...consumerTwo].find(
          (item) => item.artifactId === crashId,
        )!;
        yield* service.reconcile(workspaceId, threadId, crashId);
        yield* repository.completeOutbox(crashClaim, instant);

        const deleteId = "pg-delete-pending";
        yield* service.upload({
          workspaceId,
          threadId,
          artifactId: deleteId,
          idempotencyKey: deleteId,
          kind: "diff",
          byteLength: bytes.byteLength,
          sha256,
          mediaType: "text/x-diff",
          body: (async function* () {
            yield bytes;
          })(),
        });
        yield* repository.beginDelete(workspaceId, threadId, deleteId, instant);
        const deleteClaims = yield* repository.claimOutbox({ ...claimInput, limit: 10 });
        const deleteClaim = deleteClaims.find((item) => item.artifactId === deleteId)!;
        yield* service.delete(workspaceId, threadId, deleteId);
        yield* repository.completeOutbox(deleteClaim, instant);
        expect(objects.keys()).not.toContain(
          artifactObjectKey({ workspaceId, threadId }, "diff", deleteId, sha256),
        );

        const leaseId = "pg-expired-lease";
        yield* repository.reserve({
          workspaceId,
          threadId,
          artifactId: leaseId,
          idempotencyKey: leaseId,
          kind: "diff",
          objectKey: artifactObjectKey({ workspaceId, threadId }, "diff", leaseId, sha256),
          byteLength: bytes.byteLength,
          sha256,
          mediaType: "text/x-diff",
          createdAt: instant,
        });
        const firstLease = yield* repository.claimOutbox({ ...claimInput, limit: 1 });
        expect(firstLease).toHaveLength(1);
        yield* repository.renewOutbox(
          firstLease[0]!,
          "2026-08-27T00:00:30.000Z",
          "2026-08-27T00:03:00.000Z",
        );
        expect(yield* repository.requeueExpiredOutbox("2026-08-27T00:02:00.000Z", 10)).toBe(0);
        expect(yield* repository.requeueExpiredOutbox("2026-08-27T00:03:00.000Z", 10)).toBe(1);
        const reclaimed = yield* repository.claimOutbox({
          ...claimInput,
          now: "2026-08-27T00:03:00.000Z",
          leaseExpiresAt: "2026-08-27T00:04:00.000Z",
          limit: 1,
        });
        expect(reclaimed[0]?.attemptCount).toBe(2);
        yield* repository.completeOutbox(reclaimed[0]!, "2026-08-27T00:03:00.000Z");

        const retryId = "pg-explicit-retry";
        yield* repository.reserve({
          workspaceId,
          threadId,
          artifactId: retryId,
          idempotencyKey: retryId,
          kind: "diff",
          objectKey: artifactObjectKey({ workspaceId, threadId }, "diff", retryId, sha256),
          byteLength: bytes.byteLength,
          sha256,
          mediaType: "text/x-diff",
          createdAt: instant,
        });
        yield* repository.markUploading(workspaceId, threadId, retryId, instant);
        const exhaustedRetry = yield* repository.claimOutbox({
          ...claimInput,
          limit: 1,
          maxAttempts: 1,
        });
        expect(exhaustedRetry[0]?.artifactId).toBe(retryId);
        yield* repository.failOutbox(exhaustedRetry[0]!, instant, instant, "transient_failure");
        expect(yield* repository.claimOutbox({ ...claimInput, limit: 1, maxAttempts: 1 })).toEqual(
          [],
        );
        yield* repository.markUploading(workspaceId, threadId, retryId, instant);
        const explicitRetry = yield* repository.claimOutbox({
          ...claimInput,
          limit: 1,
          maxAttempts: 1,
        });
        expect(explicitRetry[0]?.artifactId).toBe(retryId);
        expect(explicitRetry[0]?.attemptCount).toBe(1);
      }),
    );
  },
);
