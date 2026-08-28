// @effect-diagnostics nodeBuiltinImport:off -- Real PostgreSQL coverage loads checked-in migrations into an isolated schema.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import type {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { ProviderDriverKind, RepositoryIdentity } from "@t3tools/contracts";
import type { EnvironmentRevisionId, SandboxId, WorkspaceId } from "@t3tools/contracts/cloud";
import type { SandboxIdentityRecord, SandboxIdentityReservation } from "@t3tools/e2b-sandbox";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Pool } from "pg";

import {
  CloudThreadLifecycleStoreError,
  makePostgresCloudThreadLifecycleStore,
  type ReserveCloudThreadLifecycleInput,
} from "./cloudThreadLifecycleStore.ts";
import { inspectE2bReservation, makePostgresSandboxIdentityStore } from "./sandboxIdentityStore.ts";

const postgresUrl = process.env.AGENTSIN_TEST_POSTGRES_URL;
const instant = "2026-08-27T12:00:00.000Z";
const later = "2026-08-27T12:05:00.000Z";
const workspaceA = "44444444-4444-4444-8444-444444444444" as WorkspaceId;
const workspaceB = "55555555-5555-4555-8555-555555555555" as WorkspaceId;
const environmentA = "postgres-environment-a" as EnvironmentId;
const environmentB = "postgres-environment-b" as EnvironmentId;
const projectId = "postgres-project" as ProjectId;
const revisionId = "postgres-revision" as EnvironmentRevisionId;
const providerInstanceId = "codex_personal" as ProviderInstanceId;
const codexDriver = Schema.decodeUnknownSync(ProviderDriverKind)("codex");
const claudeDriver = Schema.decodeUnknownSync(ProviderDriverKind)("claude");
const repositoryIdentity = Schema.decodeUnknownSync(RepositoryIdentity)({
  canonicalKey: "github.com/jarrodwatts/agentsin-cloud",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "https://github.com/jarrodwatts/agentsin-cloud",
  },
});

const threads = {
  identityA: "postgres-identity-a" as ThreadId,
  identityCleanup: "postgres-identity-cleanup" as ThreadId,
  identityB: "postgres-identity-b" as ThreadId,
  lifecycleCurrent: "postgres-lifecycle-current" as ThreadId,
  lifecycleIdempotencyA: "postgres-lifecycle-idempotency-a" as ThreadId,
  lifecycleIdempotencyB: "postgres-lifecycle-idempotency-b" as ThreadId,
  lifecycleRollback: "postgres-lifecycle-rollback" as ThreadId,
  lifecycleLease: "postgres-lifecycle-lease" as ThreadId,
} as const;

interface PostgresFixture {
  readonly admin: Pool;
  readonly pool: Pool;
  readonly schema: string;
}

const postgresFixture = (url: string) =>
  Effect.acquireRelease(
    Effect.promise(async (): Promise<PostgresFixture> => {
      const schema = `agentsin_c3_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
      const admin = new Pool({ connectionString: url, max: 1 });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const pool = new Pool({
        connectionString: url,
        max: 12,
        options: `-c search_path=${schema}`,
        connectionTimeoutMillis: 5_000,
        query_timeout: 10_000,
        statement_timeout: 10_000,
      });
      const migrations = await Promise.all(
        [
          "0001-workspaces.sql",
          "0002-cloud-thread-store.sql",
          "0003-thread-integrity-locks.sql",
          "0004-cloud-thread-lifecycle.sql",
          "0015-e2b-template-identity.sql",
        ].map((filename) =>
          NodeFSP.readFile(new URL(`./migrations/${filename}`, import.meta.url), "utf8"),
        ),
      );
      await pool.query('CREATE TABLE "user" (id text PRIMARY KEY)');
      for (const migration of migrations) await pool.query(migration);
      await pool.query('INSERT INTO "user" (id) VALUES ($1), ($2)', ["postgres-a", "postgres-b"]);
      await pool.query(
        "INSERT INTO workspace (id, owner_user_id, name) VALUES ($1, $2, $3), ($4, $5, $6)",
        [workspaceA, "postgres-a", "Workspace A", workspaceB, "postgres-b", "Workspace B"],
      );
      for (const threadId of Object.values(threads)) {
        const workspaceId = threadId === threads.identityB ? workspaceB : workspaceA;
        const environmentId = workspaceId === workspaceA ? environmentA : environmentB;
        await pool.query(
          `INSERT INTO cloud_thread (workspace_id, thread_id, environment_id)
           VALUES ($1, $2, $3)`,
          [workspaceId, threadId, environmentId],
        );
      }
      return { admin, pool, schema };
    }),
    ({ admin, pool, schema }) =>
      Effect.promise(async () => {
        await pool.end().catch(() => undefined);
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
        await admin.end().catch(() => undefined);
      }),
  );

const withPostgres = (use: (fixture: PostgresFixture) => Effect.Effect<void, never, never>) => {
  if (postgresUrl === undefined) return Effect.void;
  return Effect.scoped(Effect.flatMap(postgresFixture(postgresUrl), use));
};

const reservation = (
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  reservationId: CommandId,
): SandboxIdentityReservation => ({
  reservationId,
  provider: "e2b",
  workspaceId,
  environmentId: workspaceId === workspaceA ? environmentA : environmentB,
  projectId,
  threadId,
  revisionId,
  providerTemplateId: "template-postgres-1",
  providerBuildId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  repositoryIdentity,
  workspaceDirectory: "/workspace/agentsin-cloud",
  requestedAt: instant,
});

const identity = (
  value: SandboxIdentityReservation,
  sandboxId: SandboxId,
): SandboxIdentityRecord => ({
  ...value,
  sandboxId,
  providerHandle: sandboxId,
  createdAt: instant,
});

const lifecycleInput = (
  threadId: ThreadId,
  attemptId: string,
  idempotencyKey: string,
  overrides: Partial<ReserveCloudThreadLifecycleInput> = {},
): ReserveCloudThreadLifecycleInput => ({
  workspaceId: workspaceA,
  threadId,
  attemptId,
  idempotencyKey,
  requestFingerprint: `fingerprint:${attemptId}`,
  environmentId: environmentA,
  environmentRevisionId: revisionId,
  environmentRevisionHash: "sha256:postgres-revision",
  projectId,
  providerInstanceId,
  providerDriver: codexDriver,
  repositoryIdentity,
  workspaceDirectory: "/workspace/agentsin-cloud",
  createdAt: instant,
  ...overrides,
});

const rejection = <A>(promise: Promise<A>) =>
  promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );

it.effect("tenant-scopes reservation identity and preserves the cleanup fence in PostgreSQL", () =>
  withPostgres((fixture) =>
    Effect.promise(async () => {
      const store = makePostgresSandboxIdentityStore(fixture.pool);
      const sharedReservationId = "shared-reservation" as CommandId;
      const reservationA = reservation(workspaceA, threads.identityA, sharedReservationId);
      const reservationB = reservation(workspaceB, threads.identityB, sharedReservationId);

      await Promise.all([store.reserve(reservationA), store.reserve(reservationB)]);
      expect(
        await inspectE2bReservation(fixture.pool, workspaceA, sharedReservationId),
      ).toMatchObject({ state: "reserved" });
      expect(
        await inspectE2bReservation(fixture.pool, workspaceB, sharedReservationId),
      ).toMatchObject({ state: "reserved" });

      const sandboxA = "postgres-sandbox-a" as SandboxId;
      await store.activateReservation(
        workspaceA,
        sharedReservationId,
        identity(reservationA, sandboxA),
      );
      expect(await store.reserve(reservationA)).toMatchObject({
        state: "active",
        identity: { sandboxId: sandboxA, threadId: threads.identityA },
      });
      await store.markReservationFailed(
        workspaceB,
        sharedReservationId,
        later,
        "remote-create-failed",
      );
      expect(
        await inspectE2bReservation(fixture.pool, workspaceA, sharedReservationId),
      ).toMatchObject({ state: "active" });
      expect(
        await inspectE2bReservation(fixture.pool, workspaceB, sharedReservationId),
      ).toMatchObject({ state: "failed" });
      expect(await store.get(workspaceB, sandboxA)).toBeUndefined();
      expect(await store.get(workspaceA, sandboxA)).toMatchObject({
        state: "active",
        identity: { workspaceId: workspaceA },
      });
      expect(await rejection(store.markDestroyed(workspaceB, sandboxA, later))).toBeInstanceOf(
        Error,
      );
      expect(
        await inspectE2bReservation(fixture.pool, workspaceA, sharedReservationId),
      ).toMatchObject({ state: "active" });

      const cleanupId = "cleanup-reservation" as CommandId;
      await store.reserve(reservation(workspaceA, threads.identityCleanup, cleanupId));
      await store.markReservationCleanupRequired({
        workspaceId: workspaceA,
        reservationId: cleanupId,
        reason: "remote-create-cleanup-uncertain",
        providerHandle: "postgres-sandbox-cleanup",
        reclaimMetadata: { agentsin_cloud_reservation_id: cleanupId },
        recordedAt: later,
      });
      expect(await store.get(workspaceA, "postgres-sandbox-cleanup" as SandboxId)).toMatchObject({
        state: "cleanup_required",
        identity: { sandboxId: "postgres-sandbox-cleanup" },
      });
      const fenced = await rejection(
        store.reserve(
          reservation(workspaceA, threads.identityCleanup, "cleanup-replacement" as CommandId),
        ),
      );
      expect(fenced).toBeInstanceOf(Error);
      await store.markReservationFailed(workspaceA, cleanupId, later, "remote-reclaimed");
      await store.reserve(
        reservation(workspaceA, threads.identityCleanup, "cleanup-replacement" as CommandId),
      );
    }),
  ),
);

it.effect("enforces current/idempotency fences and transaction rollback in PostgreSQL", () =>
  withPostgres((fixture) =>
    Effect.promise(async () => {
      const store = makePostgresCloudThreadLifecycleStore(fixture.pool);
      const first = lifecycleInput(
        threads.lifecycleCurrent,
        "concurrent-attempt-a",
        "concurrent-key-a",
      );
      const competing = lifecycleInput(
        threads.lifecycleCurrent,
        "concurrent-attempt-b",
        "concurrent-key-b",
        {
          requestFingerprint: "fingerprint:competing",
          providerInstanceId: "claude_personal" as ProviderInstanceId,
          providerDriver: claudeDriver,
        },
      );
      const concurrent = await Promise.allSettled([store.reserve(first), store.reserve(competing)]);
      expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(concurrent.filter((result) => result.status === "rejected")).toHaveLength(1);

      const current = await store.getCurrent(workspaceA, threads.lifecycleCurrent);
      expect(current).toBeDefined();
      await store.markFailed(current!, later, "confirmed-failure");
      await store.reserve(
        lifecycleInput(threads.lifecycleCurrent, "replacement-attempt", "replacement-key"),
      );
      const history = await fixture.pool.query<{
        readonly current_count: string;
        readonly total: string;
      }>(
        `SELECT count(*) FILTER (WHERE is_current)::text AS current_count, count(*)::text AS total
           FROM cloud_thread_lifecycle_attempt
          WHERE workspace_id = $1 AND thread_id = $2`,
        [workspaceA, threads.lifecycleCurrent],
      );
      expect(history.rows[0]).toEqual({ current_count: "1", total: "2" });

      await store.reserve(
        lifecycleInput(
          threads.lifecycleIdempotencyA,
          "idempotency-attempt-a",
          "shared-idempotency-key",
        ),
      );
      const idempotencyCollision = await rejection(
        store.reserve(
          lifecycleInput(
            threads.lifecycleIdempotencyB,
            "idempotency-attempt-b",
            "shared-idempotency-key",
          ),
        ),
      );
      expect(idempotencyCollision).toBeInstanceOf(CloudThreadLifecycleStoreError);
      expect((idempotencyCollision as CloudThreadLifecycleStoreError).code).toBe("conflict");

      await fixture.pool.query(`
        CREATE FUNCTION reject_lifecycle_outbox_for_test() RETURNS trigger AS $$
        BEGIN
          IF NEW.attempt_id = 'rollback-attempt' THEN
            RAISE EXCEPTION 'injected outbox failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER reject_lifecycle_outbox_for_test
          BEFORE INSERT ON cloud_thread_lifecycle_outbox
          FOR EACH ROW EXECUTE FUNCTION reject_lifecycle_outbox_for_test();
      `);
      const rolledBack = await rejection(
        store.reserve(
          lifecycleInput(threads.lifecycleRollback, "rollback-attempt", "rollback-idempotency"),
        ),
      );
      expect(rolledBack).toBeInstanceOf(CloudThreadLifecycleStoreError);
      const rollbackCount = await fixture.pool.query<{ readonly count: string }>(
        `SELECT count(*)::text AS count FROM cloud_thread_lifecycle_attempt
          WHERE workspace_id = $1 AND attempt_id = 'rollback-attempt'`,
        [workspaceA],
      );
      expect(rollbackCount.rows[0]?.count).toBe("0");
    }),
  ),
);

it.effect("discovers and reclaims an expired lifecycle lease in PostgreSQL", () =>
  withPostgres((fixture) =>
    Effect.promise(async () => {
      const store = makePostgresCloudThreadLifecycleStore(fixture.pool);
      const reserved = await store.reserve(
        lifecycleInput(threads.lifecycleLease, "lease-attempt", "lease-idempotency"),
      );
      expect(
        await store.claim(
          reserved.attempt,
          "create_sandbox",
          "reserved",
          "create_dispatched",
          instant,
          "2026-08-27T11:59:59.000Z",
        ),
      ).toBe(true);
      const recoverable = await store.listRecoverable(instant, 10);
      expect(recoverable.map((attempt) => attempt.attemptId)).toContain("lease-attempt");
      const dispatched = (await store.getAttempt(workspaceA, "lease-attempt"))!;
      const reset = await store.resetStep(
        dispatched,
        "create_sandbox",
        "reserved",
        later,
        "lease-expired",
      );
      expect(
        await store.claim(
          reset,
          "create_sandbox",
          "reserved",
          "create_dispatched",
          later,
          "2026-08-27T12:10:00.000Z",
        ),
      ).toBe(true);
    }),
  ),
);
