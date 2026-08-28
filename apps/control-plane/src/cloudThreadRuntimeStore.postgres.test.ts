// @effect-diagnostics nodeBuiltinImport:off -- Real PostgreSQL coverage loads isolated migrations.
// @effect-diagnostics preferSchemaOverJson:off -- A SQL jsonb fixture needs its wire representation.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { WorkspaceId } from "@t3tools/contracts/cloud";
import type { WorkerInstanceId } from "@t3tools/contracts/worker";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Pool } from "pg";

import { lockCloudThreadMutation } from "./cloudThreadMutationLock.ts";
import {
  CloudThreadRuntimeStoreError,
  makePostgresCloudThreadRuntimeStore,
} from "./cloudThreadRuntimeStore.ts";

const postgresUrl = process.env.AGENTSIN_TEST_POSTGRES_URL;
const workspaceId = "77777777-7777-4777-8777-777777777777" as WorkspaceId;
const threadId = "runtime-thread" as ThreadId;
const environmentId = "runtime-environment" as EnvironmentId;
const attemptId = "runtime-attempt";
const sandboxId = "runtime-sandbox";
const initialWorkerId = "runtime-worker-1" as WorkerInstanceId;
const instant = "2026-08-28T12:00:00.000Z";

interface Fixture {
  readonly admin: Pool;
  readonly pool: Pool;
  readonly schema: string;
}

const fixture = (url: string) =>
  Effect.acquireRelease(
    Effect.promise(async (): Promise<Fixture> => {
      const schema = `agentsin_c4_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
      const admin = new Pool({ connectionString: url, max: 1 });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const pool = new Pool({
        connectionString: url,
        max: 8,
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
          "0011-desktop-leases.sql",
          "0013-cloud-thread-runtime.sql",
        ].map((filename) =>
          NodeFSP.readFile(new URL(`./migrations/${filename}`, import.meta.url), "utf8"),
        ),
      );
      await pool.query('CREATE TABLE "user" (id text PRIMARY KEY)');
      for (const migration of migrations) await pool.query(migration);
      await pool.query('INSERT INTO "user" (id) VALUES ($1)', ["runtime-user"]);
      await pool.query("INSERT INTO workspace (id, owner_user_id, name) VALUES ($1,$2,$3)", [
        workspaceId,
        "runtime-user",
        "Runtime workspace",
      ]);
      await pool.query(
        `INSERT INTO cloud_thread (workspace_id, thread_id, environment_id)
         VALUES ($1,$2,$3)`,
        [workspaceId, threadId, environmentId],
      );
      await pool.query(
        `INSERT INTO cloud_thread_lifecycle_attempt (
          workspace_id, thread_id, attempt_id, idempotency_key, request_fingerprint,
          environment_id, environment_revision_id, environment_revision_hash, project_id,
          provider_instance_id, provider_driver, repository_identity, workspace_directory,
          sandbox_id, provider_handle, worker_id, sealed_bootstrap_ref,
          state, is_current, created_at, updated_at, completed_at
        ) VALUES (
          $1,$2,$3,'runtime-create','runtime-fingerprint',$4,'runtime-revision',
          'sha256:runtime','runtime-project','codex-personal','codex',$5::jsonb,
          '/workspace/agentsin-cloud',$6,$6,$7,'sealed/runtime-worker-1',
          'ready',true,$8::timestamptz,$8::timestamptz,$8::timestamptz
        )`,
        [
          workspaceId,
          threadId,
          attemptId,
          environmentId,
          JSON.stringify({
            canonicalKey: "github.com/jarrodwatts/agentsin-cloud",
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: "https://github.com/jarrodwatts/agentsin-cloud",
            },
          }),
          sandboxId,
          initialWorkerId,
          instant,
        ],
      );
      return { admin, pool, schema };
    }),
    ({ admin, pool, schema }) =>
      Effect.promise(async () => {
        await pool.end().catch(() => undefined);
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
        await admin.end().catch(() => undefined);
      }),
  );

const withPostgres = (use: (value: Fixture) => Effect.Effect<void, never, never>) => {
  if (postgresUrl === undefined) return Effect.void;
  return Effect.scoped(Effect.flatMap(fixture(postgresUrl), use));
};

const rejected = <A>(promise: Promise<A>) =>
  promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );

it.effect("claims idle pause at exactly fifteen minutes and never before", () =>
  withPostgres(({ pool }) =>
    Effect.promise(async () => {
      const store = makePostgresCloudThreadRuntimeStore(pool);
      expect(await store.claimIdlePauses("2026-08-28T12:14:59.999Z")).toHaveLength(0);
      const claimed = await store.claimIdlePauses("2026-08-28T12:15:00.000Z");
      expect(claimed).toHaveLength(1);
      expect(claimed[0]).toMatchObject({
        state: "pause_dispatched",
        transitionId: "pause:runtime-attempt:1",
        generation: 1,
      });
      expect(await store.claimIdlePauses("2026-08-28T12:30:00.000Z")).toHaveLength(0);
    }),
  ),
);

it.effect("uses expiring agent and preview claims without trusting transient presence", () =>
  withPostgres(({ pool }) =>
    Effect.promise(async () => {
      const store = makePostgresCloudThreadRuntimeStore(pool);
      const started = {
        type: "started" as const,
        workspaceId,
        threadId,
        attemptId,
        eventId: "activity-start",
        activityId: "agent-turn",
        source: "agent" as const,
        generation: 1,
        leaseMs: 60_000,
        occurredAt: "2026-08-28T12:10:00.000Z",
        expiresAt: "2026-08-28T12:11:00.000Z",
      };
      await store.recordActivity(started);
      await store.recordActivity(started);
      expect(await store.claimIdlePauses("2026-08-28T12:25:59.999Z")).toHaveLength(0);
      expect(await store.claimIdlePauses("2026-08-28T12:26:00.000Z")).toHaveLength(1);
    }),
  ),
);

it.effect("replays delayed activity delivery with its original server timing", () =>
  withPostgres(({ pool }) =>
    Effect.promise(async () => {
      const store = makePostgresCloudThreadRuntimeStore(pool);
      const first = await store.recordActivity({
        type: "started",
        workspaceId,
        threadId,
        attemptId,
        eventId: "delayed-retry-start",
        activityId: "delayed-retry-agent",
        source: "agent",
        generation: 1,
        leaseMs: 60_000,
        occurredAt: "2026-08-28T12:01:00.000Z",
        expiresAt: "2026-08-28T12:02:00.000Z",
      });
      const replay = await store.recordActivity({
        type: "started",
        workspaceId,
        threadId,
        attemptId,
        eventId: "delayed-retry-start",
        activityId: "delayed-retry-agent",
        source: "agent",
        generation: 1,
        leaseMs: 60_000,
        occurredAt: "2026-08-28T12:10:00.000Z",
        expiresAt: "2026-08-28T12:11:00.000Z",
      });

      expect(first).toMatchObject({
        disposition: "applied",
        event: {
          occurredAt: "2026-08-28T12:01:00.000Z",
          expiresAt: "2026-08-28T12:02:00.000Z",
        },
      });
      expect(replay).toMatchObject({
        disposition: "replayed",
        event: {
          occurredAt: "2026-08-28T12:01:00.000Z",
          expiresAt: "2026-08-28T12:02:00.000Z",
        },
      });
      const persisted = await pool.query<{
        readonly occurred_at: string;
        readonly expires_at: string;
      }>(
        `SELECT
           to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at,
           to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at
           FROM cloud_thread_runtime_activity_event
          WHERE workspace_id = $1 AND event_id = $2`,
        [workspaceId, "delayed-retry-start"],
      );
      expect(persisted.rows[0]).toEqual({
        occurred_at: "2026-08-28T12:01:00.000Z",
        expires_at: "2026-08-28T12:02:00.000Z",
      });
    }),
  ),
);

it.effect("serializes concurrent active claims against idle pause and rejects stale workers", () =>
  withPostgres(({ pool }) =>
    Effect.promise(async () => {
      const store = makePostgresCloudThreadRuntimeStore(pool);
      const preview = {
        type: "started" as const,
        workspaceId,
        threadId,
        attemptId,
        eventId: "preview-start",
        activityId: "preview-service",
        source: "preview" as const,
        generation: 1,
        leaseMs: 300_500,
        occurredAt: "2026-08-28T12:14:59.500Z",
        expiresAt: "2026-08-28T12:20:00.000Z",
      };
      await store.recordActivity(preview);
      expect(await store.claimIdlePauses("2026-08-28T12:15:00.000Z")).toHaveLength(0);

      const stale = await rejected(
        store.recordActivity({
          ...preview,
          eventId: "stale-heartbeat",
          type: "heartbeat",
          generation: 2,
          leaseMs: 360_000,
          occurredAt: "2026-08-28T12:15:00.000Z",
          expiresAt: "2026-08-28T12:21:00.000Z",
        }),
      );
      expect(stale).toBeInstanceOf(CloudThreadRuntimeStoreError);
      expect((stale as CloudThreadRuntimeStoreError).code).toBe("staleGeneration");
    }),
  ),
);

it.effect("allows exactly one winner when activity starts at the idle boundary", () =>
  withPostgres(({ pool }) =>
    Effect.promise(async () => {
      const store = makePostgresCloudThreadRuntimeStore(pool);
      const lock = await pool.connect();
      await lock.query("BEGIN");
      await lock.query(
        `SELECT thread_id FROM cloud_thread_runtime
          WHERE workspace_id = $1 AND thread_id = $2 FOR UPDATE`,
        [workspaceId, threadId],
      );

      const activityPromise = store.recordActivity({
        type: "started",
        workspaceId,
        threadId,
        attemptId,
        eventId: "boundary-start",
        activityId: "boundary-agent",
        source: "agent",
        generation: 1,
        leaseMs: 60_000,
        occurredAt: "2026-08-28T12:15:00.000Z",
        expiresAt: "2026-08-28T12:16:00.000Z",
      });
      const pausePromise = store.claimIdlePauses("2026-08-28T12:15:00.000Z");
      await lock.query("COMMIT");
      lock.release();

      const [activity, pause] = await Promise.allSettled([activityPromise, pausePromise]);
      if (pause.status === "fulfilled" && pause.value.length === 1) {
        expect(activity.status).toBe("rejected");
        expect((activity as PromiseRejectedResult).reason).toBeInstanceOf(
          CloudThreadRuntimeStoreError,
        );
      } else {
        expect(pause.status).toBe("fulfilled");
        expect(pause.status === "fulfilled" ? pause.value : []).toHaveLength(0);
        expect(activity.status).toBe("fulfilled");
      }
    }),
  ),
);

it.effect("counts an unexpired desktop control lease as authoritative activity", () =>
  withPostgres(({ pool }) =>
    Effect.promise(async () => {
      const store = makePostgresCloudThreadRuntimeStore(pool);
      await pool.query(
        `INSERT INTO cloud_desktop_lease (
          workspace_id, thread_id, lease_id, generation, acquire_idempotency_key,
          acquire_fingerprint, attempt_id, environment_id, environment_revision_id,
          sandbox_id, worker_id, route_generation, holder_user_id, holder_auth_session_id,
          holder_client_id, resume_secret_hash, connection_state, state, acquired_at,
          heartbeat_at, expires_at, updated_at
        ) VALUES (
          $1,$2,$3,1,'desktop-acquire',$4,$5,$6,'runtime-revision',$7,$8,1,
          'runtime-user','runtime-session','runtime-client',$9,'connected','active',
          $10::timestamptz,$10::timestamptz,$11::timestamptz,$10::timestamptz
        )`,
        [
          workspaceId,
          threadId,
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          "a".repeat(64),
          attemptId,
          environmentId,
          sandboxId,
          initialWorkerId,
          "b".repeat(64),
          instant,
          "2026-08-28T12:16:00.000Z",
        ],
      );
      expect(await store.claimIdlePauses("2026-08-28T12:15:00.000Z")).toHaveLength(0);
      expect(await store.claimIdlePauses("2026-08-28T12:30:59.999Z")).toHaveLength(0);
      expect(await store.claimIdlePauses("2026-08-28T12:31:00.000Z")).toHaveLength(1);
    }),
  ),
);

it.effect("rechecks desktop control after waiting on the shared pause fence", () =>
  withPostgres(({ pool, schema }) =>
    Effect.promise(async () => {
      const holder = await pool.connect();
      let reachedPauseFence!: () => void;
      const pauseReachedFence = new Promise<void>((resolve) => {
        reachedPauseFence = resolve;
      });
      const observedPool = new Pool({
        connectionString: postgresUrl!,
        max: 1,
        options: `-c search_path=${schema}`,
        connectionTimeoutMillis: 5_000,
        query_timeout: 10_000,
        statement_timeout: 10_000,
      });
      observedPool.on("connect", (client) => {
        const query = client.query.bind(client);
        client.query = ((...args: unknown[]) => {
          if (typeof args[0] === "string" && args[0].includes("pg_advisory_xact_lock")) {
            reachedPauseFence();
          }
          return Reflect.apply(query, client, args);
        }) as typeof client.query;
      });

      try {
        await holder.query("BEGIN");
        await lockCloudThreadMutation(holder, { workspaceId, threadId });
        const claim = makePostgresCloudThreadRuntimeStore(observedPool).claimIdlePauses(
          "2026-08-28T12:15:00.000Z",
        );
        await pauseReachedFence;
        await holder.query(
          `INSERT INTO cloud_desktop_lease (
            workspace_id, thread_id, lease_id, generation, acquire_idempotency_key,
            acquire_fingerprint, attempt_id, environment_id, environment_revision_id,
            sandbox_id, worker_id, route_generation, holder_user_id, holder_auth_session_id,
            holder_client_id, resume_secret_hash, connection_state, state, acquired_at,
            heartbeat_at, expires_at, updated_at
          ) VALUES (
            $1,$2,$3,1,'racing-desktop-acquire',$4,$5,$6,'runtime-revision',$7,$8,1,
            'runtime-user','runtime-session','runtime-client',$9,'connected','active',
            $10::timestamptz,$10::timestamptz,$11::timestamptz,$10::timestamptz
          )`,
          [
            workspaceId,
            threadId,
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "c".repeat(64),
            attemptId,
            environmentId,
            sandboxId,
            initialWorkerId,
            "d".repeat(64),
            instant,
            "2026-08-28T12:16:00.000Z",
          ],
        );
        await holder.query("COMMIT");

        expect(await claim).toHaveLength(0);
        expect(
          await makePostgresCloudThreadRuntimeStore(pool).getCurrent(workspaceId, threadId),
        ).toMatchObject({ state: "running" });
      } finally {
        await holder.query("ROLLBACK").catch(() => undefined);
        holder.release();
        await observedPool.end().catch(() => undefined);
      }
    }),
  ),
);

it.effect("coalesces a resume race and fences the replaced worker generation", () =>
  withPostgres(({ pool }) =>
    Effect.promise(async () => {
      const store = makePostgresCloudThreadRuntimeStore(pool);
      let runtime = (await store.claimIdlePauses("2026-08-28T12:15:00.000Z"))[0]!;
      runtime = await store.recordPauseStep(runtime, "route_fenced", "2026-08-28T12:15:00.100Z");
      runtime = await store.recordPauseStep(
        runtime,
        "credentials_scrubbed",
        "2026-08-28T12:15:00.200Z",
      );

      const queued = await store.requestResume({
        workspaceId,
        threadId,
        attemptId,
        requestId: "resume-message",
        reason: "message",
        requestedAt: "2026-08-28T12:15:00.250Z",
      });
      expect(queued.disposition).toBe("pending");

      runtime = await store.markPaused(runtime, "2026-08-28T12:15:00.300Z");
      runtime = (await store.claimPendingResume(runtime, "2026-08-28T12:15:00.400Z"))!;
      expect(runtime).toMatchObject({ state: "resume_dispatched", generation: 2 });
      runtime = await store.markProviderResumed(runtime, "2026-08-28T12:15:00.500Z");
      runtime = await store.recordResumeBootstrap(
        runtime,
        "runtime-worker-2" as WorkerInstanceId,
        "sealed/runtime-worker-2",
        "2026-08-28T12:15:00.600Z",
      );
      runtime = await store.markRunning(runtime, "2026-08-28T12:15:00.700Z");
      expect(runtime).toMatchObject({
        state: "running",
        generation: 2,
        workerId: "runtime-worker-2",
      });

      const attempt = await pool.query<{ readonly worker_id: string }>(
        `SELECT worker_id FROM cloud_thread_lifecycle_attempt
          WHERE workspace_id = $1 AND attempt_id = $2`,
        [workspaceId, attemptId],
      );
      expect(attempt.rows[0]?.worker_id).toBe("runtime-worker-2");

      const stale = await rejected(
        store.recordActivity({
          type: "started",
          workspaceId,
          threadId,
          attemptId,
          eventId: "old-worker-start",
          activityId: "old-worker",
          source: "agent",
          generation: 1,
          leaseMs: 60_000,
          occurredAt: "2026-08-28T12:15:01.000Z",
          expiresAt: "2026-08-28T12:16:01.000Z",
        }),
      );
      expect((stale as CloudThreadRuntimeStoreError).code).toBe("staleGeneration");
    }),
  ),
);
