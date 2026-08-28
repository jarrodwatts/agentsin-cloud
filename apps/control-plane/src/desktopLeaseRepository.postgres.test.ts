// @effect-diagnostics nodeBuiltinImport:off -- Real PostgreSQL coverage loads checked-in migrations into an isolated schema.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";

import type { AuthSessionId, ThreadId } from "@t3tools/contracts";
import type {
  DesktopAuthorityCommand,
  DesktopControlBinding,
  DesktopControlClientId,
  DesktopLeaseIdempotencyKey,
} from "@t3tools/contracts/desktop-lease";
import type { DesktopLeaseId, WorkspaceId } from "@t3tools/contracts/cloud";
import {
  InspectorClientFrame,
  InspectorServerFrame,
  type InspectorWorkerFrame,
} from "@t3tools/contracts/inspector";
import type { WorkerRelayInbound } from "@t3tools/contracts/worker";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Pool } from "pg";
import { WebSocket } from "ws";

import { makeAgentComputerInputGate } from "../../worker/src/AgentComputerInputGate.ts";
import type { ArtifactStorageService } from "./artifactStorage.ts";
import type {
  CloudThreadLifecycleAttempt,
  CloudThreadLifecycleStore,
} from "./cloudThreadLifecycleStore.ts";
import { makePostgresCloudThreadRuntimeStore } from "./cloudThreadRuntimeStore.ts";
import { makeCloudRpc } from "./cloudRpc.ts";
import { attachCloudRpcWebSocket } from "./cloudRpcWebSocket.ts";
import {
  DesktopLeaseRepositoryError,
  makePostgresDesktopLeaseRepository,
} from "./desktopLeaseRepository.ts";
import { makeDesktopLeaseService, type DesktopControlPrincipal } from "./desktopLeaseService.ts";
import type { ControlPlaneAuth } from "./http.ts";
import { makeInspectorBridge } from "./inspectorBridge.ts";
import type { ThreadEventStoreService } from "./threadEventStore.ts";
import { makeInMemoryWorkerRouteRegistry, type ActiveWorkerRoute } from "./workerRelay.ts";
import type { WorkspaceRepositoryService } from "./workspaces.ts";

const postgresUrl = process.env.AGENTSIN_TEST_POSTGRES_URL;
const workspaceA = "77777777-7777-4777-8777-777777777777" as WorkspaceId;
const workspaceB = "88888888-8888-4888-8888-888888888888" as WorkspaceId;
const threadId = "desktop-control-thread" as ThreadId;
const now = "2026-08-27T12:00:00.000Z";
const soon = "2026-08-27T12:00:30.000Z";
const later = "2026-08-27T12:01:00.000Z";
const encodeInspectorClient = Schema.encodeUnknownSync(Schema.fromJsonString(InspectorClientFrame));
const decodeInspectorServer = Schema.decodeUnknownSync(Schema.fromJsonString(InspectorServerFrame));

const binding = (workspaceId: WorkspaceId, routeGeneration = 1): DesktopControlBinding => ({
  workspaceId,
  threadId,
  attemptId: workspaceId === workspaceA ? "attempt-a" : "attempt-b",
  environmentId:
    workspaceId === workspaceA ? ("environment-a" as never) : ("environment-b" as never),
  environmentRevisionId: "revision-1" as never,
  sandboxId: workspaceId === workspaceA ? ("sandbox-a" as never) : ("sandbox-b" as never),
  workerId: workspaceId === workspaceA ? "worker-a" : "worker-b",
  routeGeneration,
});

const actor = (userId: string, authSessionId: string, clientId: string) => ({
  userId,
  authSessionId: authSessionId as AuthSessionId,
  clientId: clientId as DesktopControlClientId,
});

const principal = (
  routeBinding: DesktopControlBinding,
  authSessionId: string,
  clientId: string,
): DesktopControlPrincipal => ({
  ...actor("user-a", authSessionId, clientId),
  binding: routeBinding,
});

const routeFor = (
  routeBinding: DesktopControlBinding,
  send: ActiveWorkerRoute["send"],
): ActiveWorkerRoute => ({
  lease: {
    workspaceId: routeBinding.workspaceId,
    threadId: routeBinding.threadId,
    environmentId: routeBinding.environmentId,
    environmentRevisionId: routeBinding.environmentRevisionId,
    sandboxId: routeBinding.sandboxId,
    reservationId: routeBinding.attemptId as never,
    workerId: routeBinding.workerId as never,
    providerInstanceId: "codex_personal" as never,
    providerDriver: "codex" as never,
    certificateFingerprint: "fingerprint",
    certificateGeneration: 1,
    processInstanceId: `process-${routeBinding.routeGeneration}`,
    leaseGeneration: 1,
    routeGeneration: routeBinding.routeGeneration,
    state: "connected",
    connectedAt: now,
    lastSeenAt: now,
    heartbeatSequence: 1,
    confirmedEventCursor: -1,
  },
  send,
  close: () => undefined,
});

const captureAuthority =
  (frames: Array<DesktopAuthorityCommand>): ActiveWorkerRoute["send"] =>
  (frame) => {
    if (frame.type === "desktop.authority") frames.push(frame);
    return true;
  };

const acquireInput = (
  workspaceId: WorkspaceId,
  leaseId: string,
  key: string,
  holder = actor(workspaceId === workspaceA ? "user-a" : "user-b", "auth-1", "client-1"),
) => ({
  binding: binding(workspaceId),
  actor: holder,
  leaseId: leaseId as DesktopLeaseId,
  resumeSecretHash: "a".repeat(64),
  idempotencyKey: key as DesktopLeaseIdempotencyKey,
  now,
  expiresAt: soon,
});

const rejection = <A>(promise: Promise<A>) =>
  promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );

const withPostgres = <E>(use: (pool: Pool) => Effect.Effect<void, E>) => {
  if (postgresUrl === undefined) return Effect.void;
  return Effect.scoped(
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        const schema = `agentsin_c7_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
        const admin = new Pool({ connectionString: postgresUrl, max: 1 });
        await admin.query(`CREATE SCHEMA "${schema}"`);
        const pool = new Pool({
          connectionString: postgresUrl,
          max: 12,
          options: `-c search_path=${schema}`,
          connectionTimeoutMillis: 5_000,
          query_timeout: 10_000,
          statement_timeout: 10_000,
        });
        await pool.query('CREATE TABLE "user" (id text PRIMARY KEY)');
        for (const filename of [
          "0001-workspaces.sql",
          "0002-cloud-thread-store.sql",
          "0004-cloud-thread-lifecycle.sql",
          "0011-desktop-leases.sql",
          "0013-cloud-thread-runtime.sql",
        ]) {
          await pool.query(
            await NodeFSP.readFile(new URL(`./migrations/${filename}`, import.meta.url), "utf8"),
          );
        }
        await pool.query('INSERT INTO "user" (id) VALUES ($1), ($2)', ["user-a", "user-b"]);
        await pool.query(
          "INSERT INTO workspace (id, owner_user_id, name) VALUES ($1, $2, $3), ($4, $5, $6)",
          [workspaceA, "user-a", "A", workspaceB, "user-b", "B"],
        );
        for (const workspaceId of [workspaceA, workspaceB]) {
          const route = binding(workspaceId);
          await pool.query(
            "INSERT INTO cloud_thread (workspace_id, thread_id, environment_id) VALUES ($1, $2, $3)",
            [workspaceId, threadId, route.environmentId],
          );
          await pool.query(
            `INSERT INTO cloud_thread_lifecycle_attempt
              (workspace_id, thread_id, attempt_id, idempotency_key, request_fingerprint,
               environment_id, environment_revision_id, environment_revision_hash, project_id,
               provider_instance_id, provider_driver, repository_identity, workspace_directory,
               sandbox_id, provider_handle, worker_id, sealed_bootstrap_ref, state, is_current,
               created_at, updated_at, completed_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'codex', $11, $12,
                     $13, $14, $15, $16, 'ready', true, $17, $17, $17)`,
            [
              workspaceId,
              threadId,
              route.attemptId,
              `lifecycle-${workspaceId}`,
              `fingerprint-${workspaceId}`,
              route.environmentId,
              route.environmentRevisionId,
              "revision-hash",
              "project-1",
              "codex_personal",
              { canonicalKey: "github.com/jarrodwatts/agentsin-cloud" },
              "/workspace/project",
              route.sandboxId,
              `provider-${workspaceId}`,
              route.workerId,
              `bootstrap-${workspaceId}`,
              now,
            ],
          );
        }
        return { admin, pool, schema };
      }),
      ({ pool }) => use(pool),
      ({ admin, pool, schema }) =>
        Effect.promise(async () => {
          await pool.end().catch(() => undefined);
          await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
          await admin.end().catch(() => undefined);
        }),
    ),
  );
};

it.effect(
  "serializes simultaneous takeovers while allowing the same thread id in another tenant",
  () =>
    withPostgres((pool) =>
      Effect.promise(async () => {
        const repository = makePostgresDesktopLeaseRepository(pool);
        const attempts = await Promise.allSettled([
          repository.acquire(
            acquireInput(workspaceA, "10000000-0000-4000-8000-000000000001", "take-a"),
          ),
          repository.acquire(
            acquireInput(workspaceA, "10000000-0000-4000-8000-000000000002", "take-b"),
          ),
        ]);
        expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        const failure = attempts.find((result) => result.status === "rejected");
        expect(failure?.status === "rejected" && failure.reason).toBeInstanceOf(
          DesktopLeaseRepositoryError,
        );
        const otherTenant = await repository.acquire(
          acquireInput(workspaceB, "10000000-0000-4000-8000-000000000003", "take-a"),
        );
        expect(otherTenant.lease.binding.workspaceId).toBe(workspaceB);
      }),
    ),
);

it.effect("rejects desktop acquisition and renewal after the durable pause fence wins", () =>
  withPostgres((pool) =>
    Effect.promise(async () => {
      const repository = makePostgresDesktopLeaseRepository(pool);
      const acquired = await repository.acquire(
        acquireInput(workspaceA, "11000000-0000-4000-8000-000000000001", "pause-race-acquire"),
      );
      const runtimeStore = makePostgresCloudThreadRuntimeStore(pool);
      const claimed = await runtimeStore.claimIdlePauses("2026-08-27T12:15:30.000Z");
      expect(claimed.some((runtime) => runtime.workspaceId === workspaceA)).toBe(true);

      await expect(
        repository.heartbeat({
          leaseId: acquired.lease.leaseId,
          generation: acquired.lease.generation,
          binding: binding(workspaceA),
          actor: acquired.lease.actor,
          idempotencyKey: "pause-race-heartbeat" as DesktopLeaseIdempotencyKey,
          now: "2026-08-27T12:15:31.000Z",
          expiresAt: "2026-08-27T12:16:01.000Z",
        }),
      ).rejects.toMatchObject({ code: "staleBinding" });
      await expect(
        repository.acquire(
          acquireInput(workspaceA, "11000000-0000-4000-8000-000000000002", "pause-race-reacquire"),
        ),
      ).rejects.toMatchObject({ code: "staleBinding" });
    }),
  ),
);

it.effect(
  "recovers an acquire idempotently for a replacement socket in the same auth session",
  () =>
    withPostgres((pool) =>
      Effect.promise(async () => {
        const repository = makePostgresDesktopLeaseRepository(pool);
        const original = actor("user-a", "auth-acquire-recovery", "client-original");
        const replacement = actor("user-a", "auth-acquire-recovery", "client-replacement");
        const acquired = await repository.acquire(
          acquireInput(
            workspaceA,
            "15000000-0000-4000-8000-000000000001",
            "recover-acquire",
            original,
          ),
        );
        await repository.disconnect({
          binding: binding(workspaceA),
          actor: original,
          idempotencyKey: "recover-acquire-disconnect" as DesktopLeaseIdempotencyKey,
          now,
          graceExpiresAt: soon,
        });

        const replayed = await repository.acquire(
          acquireInput(
            workspaceA,
            "15000000-0000-4000-8000-000000000002",
            "recover-acquire",
            replacement,
          ),
        );
        const duplicate = await repository.acquire(
          acquireInput(
            workspaceA,
            "15000000-0000-4000-8000-000000000003",
            "recover-acquire",
            replacement,
          ),
        );
        expect(replayed).toMatchObject({
          disposition: "replayed",
          lease: {
            leaseId: acquired.lease.leaseId,
            generation: acquired.lease.generation,
            connectionState: "disconnected",
            actor: { clientId: original.clientId },
          },
        });
        expect(duplicate).toEqual(replayed);

        await expect(
          repository.acquire(
            acquireInput(
              workspaceA,
              "15000000-0000-4000-8000-000000000004",
              "recover-acquire",
              actor("user-a", "auth-foreign", "client-foreign"),
            ),
          ),
        ).rejects.toMatchObject({ code: "conflict" });
        await expect(
          repository.acquire({
            ...acquireInput(
              workspaceA,
              "15000000-0000-4000-8000-000000000005",
              "recover-acquire",
              replacement,
            ),
            binding: binding(workspaceA, 2),
          }),
        ).rejects.toMatchObject({ code: "conflict" });
      }),
    ),
);

it.effect("fences disconnect, same-session resume, foreign actors, and retained generations", () =>
  withPostgres((pool) =>
    Effect.promise(async () => {
      const repository = makePostgresDesktopLeaseRepository(pool);
      const holder = actor("user-a", "auth-1", "client-1");
      const acquired = await repository.acquire(
        acquireInput(workspaceA, "20000000-0000-4000-8000-000000000001", "acquire-1", holder),
      );
      await repository.disconnect({
        binding: binding(workspaceA),
        actor: holder,
        idempotencyKey: "disconnect" as DesktopLeaseIdempotencyKey,
        now,
        graceExpiresAt: soon,
      });
      const foreign = await rejection(
        repository.resume({
          leaseId: acquired.lease.leaseId,
          generation: acquired.lease.generation,
          binding: binding(workspaceA),
          actor: actor("user-a", "auth-2", "client-2"),
          resumeSecretHash: "a".repeat(64),
          nextResumeSecretHash: "b".repeat(64),
          idempotencyKey: "foreign-resume" as DesktopLeaseIdempotencyKey,
          now,
          expiresAt: soon,
        }),
      );
      expect(foreign).toBeInstanceOf(DesktopLeaseRepositoryError);
      const resumed = await repository.resume({
        leaseId: acquired.lease.leaseId,
        generation: acquired.lease.generation,
        binding: binding(workspaceA),
        actor: actor("user-a", "auth-1", "client-2"),
        resumeSecretHash: "a".repeat(64),
        nextResumeSecretHash: "b".repeat(64),
        idempotencyKey: "resume-1" as DesktopLeaseIdempotencyKey,
        now,
        expiresAt: soon,
      });
      expect(resumed.lease.generation).toBeGreaterThan(acquired.lease.generation);
      expect(
        await rejection(
          repository.heartbeat({
            leaseId: resumed.lease.leaseId,
            generation: acquired.lease.generation,
            binding: binding(workspaceA),
            actor: actor("user-a", "auth-1", "client-2"),
            idempotencyKey: "stale-heartbeat" as DesktopLeaseIdempotencyKey,
            now,
            expiresAt: soon,
          }),
        ),
      ).toBeInstanceOf(DesktopLeaseRepositoryError);
      await repository.release({
        leaseId: resumed.lease.leaseId,
        generation: resumed.lease.generation,
        binding: binding(workspaceA),
        actor: actor("user-a", "auth-1", "client-2"),
        idempotencyKey: "release-1" as DesktopLeaseIdempotencyKey,
        now,
      });
      await repository.purgeEndedBefore({ before: later, limit: 100 });
      const next = await repository.acquire(
        acquireInput(workspaceA, "20000000-0000-4000-8000-000000000002", "acquire-2", holder),
      );
      expect(next.lease.generation).toBeGreaterThan(resumed.lease.generation);
    }),
  ),
);

it.effect("expires disconnected authority durably and rejects stale lifecycle bindings", () =>
  withPostgres((pool) =>
    Effect.promise(async () => {
      const repository = makePostgresDesktopLeaseRepository(pool);
      const holder = actor("user-a", "auth-1", "client-1");
      const acquired = await repository.acquire(
        acquireInput(workspaceA, "30000000-0000-4000-8000-000000000001", "expire-acquire", holder),
      );
      expect(
        await rejection(repository.authorizeAgentInput({ binding: binding(workspaceA), now })),
      ).toBeInstanceOf(DesktopLeaseRepositoryError);
      const swept = await repository.sweepExpired({ now: later, limit: 10 });
      expect(swept.map((lease) => lease.leaseId)).toContain(acquired.lease.leaseId);
      await repository.authorizeAgentInput({ binding: binding(workspaceA), now: later });
      expect(
        await rejection(
          repository.authorizeUserInput({
            binding: { ...binding(workspaceA), environmentRevisionId: "revision-stale" as never },
            actor: holder,
            now,
          }),
        ),
      ).toBeInstanceOf(DesktopLeaseRepositoryError);
    }),
  ),
);

it.effect("restores worker agent authority when current observes a lease past TTL", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      let clock = Date.parse(now);
      const gate = makeAgentComputerInputGate();
      const frames: Array<DesktopAuthorityCommand> = [];
      const routes = makeInMemoryWorkerRouteRegistry();
      const routeBinding = binding(workspaceA);
      routes.activate(routeFor(routeBinding, captureAuthority(frames)));
      const service = makeDesktopLeaseService({
        repository: makePostgresDesktopLeaseRepository(pool),
        routes,
        tokenSecret: "real-postgres-desktop-token-secret-at-least-32-bytes",
        now: () => clock,
        nextLeaseId: () => "40000000-0000-4000-8000-000000000001" as DesktopLeaseId,
        ttlMs: 5_000,
        disconnectGraceMs: 1_000,
      });
      const holder = principal(routeBinding, "auth-expiry", "client-expiry");
      yield* service.acquire(holder, "expiry-acquire" as DesktopLeaseIdempotencyKey);
      yield* gate.update(frames[0]!);
      expect(gate.snapshot().controller).toBe("user");

      clock += 5_001;
      const observed = yield* service.current(holder);
      yield* gate.update(frames[1]!);
      expect(observed.state.controller).toBe("agent");
      expect(gate.snapshot()).toMatchObject({ controller: "agent", binding: routeBinding });
      yield* gate.authorizeAgentInput(routeBinding, DateTime.formatIso(DateTime.makeUnsafe(clock)));
    }),
  ),
);

it.effect("advances authority generations for user and agent route reconnects", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const repository = makePostgresDesktopLeaseRepository(pool);
      const routes = makeInMemoryWorkerRouteRegistry();
      const userGate = makeAgentComputerInputGate();
      const userFrames: Array<DesktopAuthorityCommand> = [];
      const userRoute1 = binding(workspaceA, 1);
      routes.activate(routeFor(userRoute1, captureAuthority(userFrames)));
      const service = makeDesktopLeaseService({
        repository,
        routes,
        tokenSecret: "real-postgres-desktop-token-secret-at-least-32-bytes",
        now: () => Date.parse(now),
        nextLeaseId: () => "50000000-0000-4000-8000-000000000001" as DesktopLeaseId,
        ttlMs: 30_000,
        disconnectGraceMs: 5_000,
      });
      yield* service.acquire(
        principal(userRoute1, "auth-user-route", "client-user-route"),
        "user-route-acquire" as DesktopLeaseIdempotencyKey,
      );
      yield* userGate.update(userFrames[0]!);
      const userRoute2 = binding(workspaceA, 2);
      routes.activate(routeFor(userRoute2, captureAuthority(userFrames)));
      yield* service.synchronizeRoute(routes.get(workspaceA, userRoute2.sandboxId)!);
      const firstUser = userFrames[0]!;
      const reboundUser = userFrames.at(-1)!;
      yield* userGate.update(reboundUser);
      expect(reboundUser.authorityRevision).toBeGreaterThan(firstUser.authorityRevision);
      expect(userGate.snapshot()).toMatchObject({ controller: "user", binding: userRoute2 });
      yield* userGate.update(firstUser);
      expect(userGate.snapshot()).toMatchObject({ binding: userRoute2 });

      const agentGate = makeAgentComputerInputGate();
      const agentFrames: Array<DesktopAuthorityCommand> = [];
      const agentRoute1 = binding(workspaceB, 1);
      routes.activate(routeFor(agentRoute1, captureAuthority(agentFrames)));
      yield* service.synchronizeRoute(routes.get(workspaceB, agentRoute1.sandboxId)!);
      yield* agentGate.update(agentFrames[0]!);
      const agentRoute2 = binding(workspaceB, 2);
      routes.activate(routeFor(agentRoute2, captureAuthority(agentFrames)));
      yield* service.synchronizeRoute(routes.get(workspaceB, agentRoute2.sandboxId)!);
      const firstAgent = agentFrames[0]!;
      const reboundAgent = agentFrames.at(-1)!;
      yield* agentGate.update(reboundAgent);
      expect(reboundAgent.authorityRevision).toBeGreaterThan(firstAgent.authorityRevision);
      expect(agentGate.snapshot()).toMatchObject({ controller: "agent", binding: agentRoute2 });
      yield* agentGate.update(firstAgent);
      expect(agentGate.snapshot()).toMatchObject({ binding: agentRoute2 });
    }),
  ),
);

it.effect("recovers a lost resume response on a new socket without replaying authority", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const routeBinding = binding(workspaceA);
      const routes = makeInMemoryWorkerRouteRegistry();
      const gate = makeAgentComputerInputGate();
      const authorityFrames: Array<DesktopAuthorityCommand> = [];
      routes.activate(routeFor(routeBinding, captureAuthority(authorityFrames)));
      const service = makeDesktopLeaseService({
        repository: makePostgresDesktopLeaseRepository(pool),
        routes,
        tokenSecret: "real-postgres-desktop-token-secret-at-least-32-bytes",
        now: () => Date.parse(now),
        nextLeaseId: () => "60000000-0000-4000-8000-000000000001" as DesktopLeaseId,
        ttlMs: 30_000,
        disconnectGraceMs: 5_000,
      });
      const client1 = principal(routeBinding, "auth-proof", "client-proof-1");
      const client2LostSocket = principal(routeBinding, "auth-proof", "client-proof-2a");
      const client2RecoveredSocket = principal(routeBinding, "auth-proof", "client-proof-2b");
      const acquired = yield* service.acquire(
        client1,
        "proof-acquire" as DesktopLeaseIdempotencyKey,
      );
      if (acquired.state.controller !== "user" || acquired.resumeToken === undefined) {
        throw new Error("expected acquired user lease");
      }
      expect(authorityFrames).toHaveLength(1);
      yield* gate.update(authorityFrames[0]!);
      const originalProof = acquired.resumeToken;
      const originalLease = acquired.state.lease;
      yield* service.disconnect(client1);
      expect(authorityFrames).toHaveLength(1);
      const resumeFrame = {
        protocolVersion: 1 as const,
        type: "desktop.control.resume" as const,
        requestId: "proof-resume-request" as never,
        leaseId: originalLease.leaseId,
        generation: originalLease.generation,
        resumeToken: originalProof,
        idempotencyKey: "proof-resume" as DesktopLeaseIdempotencyKey,
      };
      const resumed = yield* service.resume(client2LostSocket, resumeFrame);
      expect(resumed.resumeToken).toBeDefined();
      expect(resumed.resumeToken).not.toBe(originalProof);
      if (resumed.state.controller !== "user") throw new Error("expected resumed user lease");
      const committedGeneration = resumed.state.lease.generation;
      expect(authorityFrames).toHaveLength(2);
      yield* gate.update(authorityFrames[1]!);
      expect(gate.snapshot()).toMatchObject({
        controller: "user",
        generation: committedGeneration,
      });

      // The committed response is lost and its socket closes. The exact retry
      // arrives through a newly authenticated socket with a new server id.
      yield* service.disconnect(client2LostSocket);
      expect(
        yield* Effect.exit(
          service.resume(
            principal(routeBinding, "auth-foreign", "client-proof-foreign"),
            resumeFrame,
          ),
        ),
      ).toMatchObject({ _tag: "Failure" });
      expect(authorityFrames).toHaveLength(2);
      const recovered = yield* service.resume(client2RecoveredSocket, resumeFrame);
      const duplicateRecovery = yield* service.resume(client2RecoveredSocket, resumeFrame);
      expect(authorityFrames).toHaveLength(2);
      expect(recovered.resumeToken).toBe(resumed.resumeToken);
      expect(duplicateRecovery.resumeToken).toBe(resumed.resumeToken);
      expect(recovered.state).toMatchObject({
        controller: "disconnected",
        lease: { generation: committedGeneration },
      });
      expect(duplicateRecovery.state).toMatchObject({
        lease: { generation: committedGeneration },
      });
      if (recovered.state.controller !== "disconnected" || recovered.resumeToken === undefined) {
        throw new Error("expected recoverable disconnected lease");
      }

      // The recovered proof performs the normal, fenced handoff to this socket.
      const reclaimed = yield* service.resume(client2RecoveredSocket, {
        protocolVersion: 1,
        type: "desktop.control.resume",
        requestId: "proof-reclaim-request" as never,
        leaseId: recovered.state.lease.leaseId,
        generation: recovered.state.lease.generation,
        resumeToken: recovered.resumeToken,
        idempotencyKey: "proof-reclaim" as DesktopLeaseIdempotencyKey,
      });
      expect(reclaimed.state).toMatchObject({ controller: "user", heldByCurrentClient: true });
      if (reclaimed.state.controller !== "user") throw new Error("expected reclaimed user lease");
      expect(reclaimed.state.lease.generation).toBeGreaterThan(committedGeneration);
      expect(authorityFrames).toHaveLength(3);
      yield* gate.update(authorityFrames[2]!);
      expect(gate.snapshot()).toMatchObject({
        controller: "user",
        generation: reclaimed.state.lease.generation,
      });

      // After the new holder disconnects, the original proof cannot reclaim
      // the public current generation under a fresh idempotency key.
      yield* service.disconnect(client2RecoveredSocket);
      expect(authorityFrames).toHaveLength(3);
      const publicCurrent = yield* service.current(client1);
      if (publicCurrent.state.controller !== "disconnected") throw new Error("expected disconnect");
      expect(
        yield* Effect.exit(
          service.resume(client1, {
            ...resumeFrame,
            requestId: "proof-replay-request" as never,
            generation: publicCurrent.state.lease.generation,
            idempotencyKey: "proof-replay" as DesktopLeaseIdempotencyKey,
          }),
        ),
      ).toMatchObject({ _tag: "Failure" });
      expect(authorityFrames).toHaveLength(3);
    }),
  ),
);

it.effect("recovers a lost acquire response across an authenticated WebSocket replacement", () =>
  withPostgres((pool) =>
    Effect.scoped(
      Effect.gen(function* () {
        const routeBinding = binding(workspaceA);
        const routes = makeInMemoryWorkerRouteRegistry();
        const gate = makeAgentComputerInputGate();
        const authorityFrames: Array<DesktopAuthorityCommand> = [];
        const workerCommands: Array<WorkerRelayInbound> = [];
        const workerWaiters: Array<(frame: WorkerRelayInbound) => void> = [];
        const nextWorkerCommand = () => {
          const frame = workerCommands.shift();
          if (frame !== undefined) return Promise.resolve(frame);
          return new Promise<WorkerRelayInbound>((resolve) => workerWaiters.push(resolve));
        };
        routes.activate(
          routeFor(routeBinding, (frame) => {
            if (frame.type === "desktop.authority") authorityFrames.push(frame);
            else {
              const waiter = workerWaiters.shift();
              if (waiter === undefined) workerCommands.push(frame);
              else waiter(frame);
            }
            return true;
          }),
        );
        const service = makeDesktopLeaseService({
          repository: makePostgresDesktopLeaseRepository(pool),
          routes,
          tokenSecret: "real-postgres-desktop-token-secret-at-least-32-bytes",
          now: () => Date.parse(now),
          nextLeaseId: () => "70000000-0000-4000-8000-000000000001" as DesktopLeaseId,
          ttlMs: 30_000,
          disconnectGraceMs: 5_000,
        });

        let acquireCommitted!: () => void;
        const acquireCommittedPromise = new Promise<void>((resolve) => {
          acquireCommitted = resolve;
        });
        let releaseAcquireResponse!: () => void;
        const acquireResponseBarrier = new Promise<void>((resolve) => {
          releaseAcquireResponse = resolve;
        });
        let disconnected!: () => void;
        const disconnectedPromise = new Promise<void>((resolve) => {
          disconnected = resolve;
        });
        let acquireCalls = 0;
        const desktopControl = {
          ...service,
          acquire: (desktopPrincipal, idempotencyKey) =>
            Effect.gen(function* () {
              const result = yield* service.acquire(desktopPrincipal, idempotencyKey);
              acquireCalls += 1;
              if (acquireCalls === 1) {
                acquireCommitted();
                yield* Effect.promise(() => acquireResponseBarrier);
              }
              return result;
            }),
          disconnect: (desktopPrincipal) =>
            service.disconnect(desktopPrincipal).pipe(Effect.tap(() => Effect.sync(disconnected))),
        } satisfies typeof service;

        const attempt: CloudThreadLifecycleAttempt = {
          workspaceId: workspaceA,
          threadId,
          attemptId: routeBinding.attemptId,
          idempotencyKey: "wss-attempt",
          requestFingerprint: "wss-attempt-fingerprint",
          environmentId: routeBinding.environmentId,
          environmentRevisionId: routeBinding.environmentRevisionId,
          environmentRevisionHash: "revision-hash",
          projectId: "project-1" as never,
          providerInstanceId: "codex_personal" as never,
          providerDriver: "codex" as never,
          repositoryIdentity: {
            canonicalKey: "github.com/jarrodwatts/agentsin-cloud",
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: "https://github.com/jarrodwatts/agentsin-cloud.git",
            },
          },
          workspaceDirectory: "/workspace/project",
          state: "ready",
          isCurrent: true,
          sandboxId: routeBinding.sandboxId,
          providerHandle: "e2b-handle-a",
          workerId: routeBinding.workerId as never,
          sealedBootstrapRef: "bootstrap-a",
          createdAt: now,
          updatedAt: now,
        };
        const auth: ControlPlaneAuth = {
          handler: async () => new Response(),
          api: {
            getSession: async ({ headers }) => {
              const token = headers.get("authorization");
              return token === "Bearer auth-session-a"
                ? {
                    user: { id: "user-a", name: "User A" },
                    session: { id: "auth-session-a" },
                  }
                : null;
            },
            generateOneTimeToken: async () => ({ token: "unused" }),
          },
        };
        const workspaces = {
          ensureForUser: () =>
            Effect.succeed({
              id: workspaceA,
              ownerUserId: "user-a",
              name: "Workspace A",
              createdAt: now,
            }),
        } as unknown as WorkspaceRepositoryService;
        const lifecycle = {
          getCurrent: async (requestedWorkspace: WorkspaceId, requestedThread: ThreadId) =>
            requestedWorkspace === workspaceA && requestedThread === threadId ? attempt : undefined,
        } as CloudThreadLifecycleStore;
        const artifacts = {
          upload: () => Effect.die("unexpected artifact upload"),
          download: () => Effect.die("unexpected artifact download"),
        } as unknown as ArtifactStorageService;
        const clientIds = ["socket-client-1", "socket-client-2"] as const;
        let clientIndex = 0;
        const bridge = makeInspectorBridge({
          auth,
          hostedOrigin: "https://control.example.com",
          workspaces,
          lifecycle,
          routes,
          artifacts,
          desktopControl,
          limits: { heartbeatIntervalMs: 60_000, reconnectGraceMs: 10_000 },
          nextSessionId: () => "inspector-acquire-recovery" as never,
          nextClientId: () => clientIds[clientIndex++]! as DesktopControlClientId,
          nowMs: () => Date.parse(now),
        });
        yield* Effect.addFinalizer(() => Effect.sync(bridge.dispose));

        const eventStore = {
          replayAfter: () => Effect.succeed({ events: [], nextSequence: 0, hasMore: false }),
        } as unknown as ThreadEventStoreService;
        const rpc = makeCloudRpc({
          auth,
          hostedOrigin: "https://control.example.com",
          workspaces,
          eventStore,
        });
        const server = yield* Effect.acquireRelease(
          Effect.sync(() => NodeHttp.createServer((_request, response) => response.end())),
          (server) =>
            Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  server.close(() => resolve());
                }),
            ),
        );
        const attachment = yield* Effect.acquireRelease(
          Effect.sync(() =>
            attachCloudRpcWebSocket({
              server,
              rpc,
              inspector: bridge,
              baseUrl: new URL("https://control.example.com"),
              authenticationTimeoutMs: 1_000,
            }),
          ),
          (activeAttachment) => Effect.sync(activeAttachment.detach),
        );
        void attachment;
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              server.once("error", reject);
              server.listen(0, "127.0.0.1", () => resolve());
            }),
        );
        const address = server.address();
        if (address === null || typeof address === "string") return yield* Effect.die("no address");
        const url = `ws://127.0.0.1:${address.port}/api/v1/inspector?threadId=${threadId}&attemptId=${routeBinding.attemptId}`;
        const openSocket = () =>
          new Promise<WebSocket>((resolve, reject) => {
            const socket = new WebSocket(url, {
              headers: {
                authorization: "Bearer auth-session-a",
                origin: "https://control.example.com",
              },
            });
            socket.once("open", () => resolve(socket));
            socket.once("error", reject);
          });
        const receiveFrame = (socket: WebSocket, type: InspectorServerFrame["type"]) =>
          new Promise<InspectorServerFrame>((resolve, reject) => {
            const onMessage = (payload: WebSocket.RawData) => {
              try {
                const frame = decodeInspectorServer(payload.toString());
                if (frame.type !== type) return;
                socket.off("message", onMessage);
                socket.off("error", onError);
                resolve(frame);
              } catch (cause) {
                onError(cause);
              }
            };
            const onError = (cause: unknown) => {
              socket.off("message", onMessage);
              reject(cause);
            };
            socket.on("message", onMessage);
            socket.once("error", onError);
          });
        const send = (socket: WebSocket, frame: InspectorClientFrame) =>
          socket.send(encodeInspectorClient(frame));
        const workerReady = (
          sessionId: Extract<
            WorkerRelayInbound,
            { readonly type: "inspector.command" }
          >["command"]["sessionId"],
          sequence: number,
        ): InspectorWorkerFrame => ({
          type: "inspector.ready",
          binding: {
            protocolVersion: 1,
            workspaceId: workspaceA,
            threadId,
            attemptId: routeBinding.attemptId as never,
            environmentId: routeBinding.environmentId,
            environmentRevisionId: routeBinding.environmentRevisionId,
            providerInstanceId: "codex_personal" as never,
            providerDriver: "codex" as never,
            sandboxId: routeBinding.sandboxId,
            workerId: routeBinding.workerId as never,
            routeGeneration: routeBinding.routeGeneration,
          },
          sessionId,
          sequence,
          emittedAt: now,
          capabilities: {
            terminal: true,
            files: true,
            ports: true,
            browserFrames: false,
            browserInput: false,
            desktopFrames: false,
            desktopInput: false,
            desktopBackend: "unsupported",
          },
        });

        const firstSocket = yield* Effect.promise(openSocket);
        const firstOpened = receiveFrame(firstSocket, "inspector.opened");
        send(firstSocket, {
          protocolVersion: 1,
          type: "inspector.open",
          threadId,
          attemptId: routeBinding.attemptId as never,
          resumeAfterSequence: -1,
        });
        const firstOpenCommand = yield* Effect.promise(nextWorkerCommand);
        if (
          firstOpenCommand.type !== "inspector.command" ||
          firstOpenCommand.command.type !== "inspector.open"
        ) {
          return yield* Effect.die("expected inspector open command");
        }
        yield* bridge.inspectorFrames.handleFrame(
          routes.get(workspaceA, routeBinding.sandboxId)!.lease,
          workerReady(firstOpenCommand.command.sessionId, 0),
        );
        const opened = yield* Effect.promise(() => firstOpened);
        if (opened.type !== "inspector.opened")
          return yield* Effect.die("expected inspector opened");

        const acquireFrame = {
          protocolVersion: 1 as const,
          type: "desktop.control.acquire" as const,
          requestId: "lost-acquire-request" as never,
          idempotencyKey: "lost-acquire-idempotency" as DesktopLeaseIdempotencyKey,
        };
        send(firstSocket, acquireFrame);
        yield* Effect.promise(() => acquireCommittedPromise);
        expect(authorityFrames).toHaveLength(1);
        yield* gate.update(authorityFrames[0]!);
        expect(gate.snapshot()).toMatchObject({ controller: "user", generation: 1 });
        const firstClosed = new Promise<void>((resolve) =>
          firstSocket.once("close", () => resolve()),
        );
        firstSocket.terminate();
        yield* Effect.promise(() => firstClosed);
        yield* Effect.promise(() => disconnectedPromise);
        releaseAcquireResponse();
        yield* bridge.drain;

        const secondSocket = yield* Effect.promise(openSocket);
        yield* Effect.addFinalizer(() => Effect.sync(() => secondSocket.terminate()));
        const secondOpened = receiveFrame(secondSocket, "inspector.opened");
        send(secondSocket, {
          protocolVersion: 1,
          type: "inspector.open",
          threadId,
          attemptId: routeBinding.attemptId as never,
          sessionId: opened.sessionId,
          resumeAfterSequence: opened.sequence,
        });
        const secondOpenCommand = yield* Effect.promise(nextWorkerCommand);
        if (
          secondOpenCommand.type !== "inspector.command" ||
          secondOpenCommand.command.type !== "inspector.open"
        ) {
          return yield* Effect.die("expected resumed inspector open command");
        }
        yield* bridge.inspectorFrames.handleFrame(
          routes.get(workspaceA, routeBinding.sandboxId)!.lease,
          workerReady(secondOpenCommand.command.sessionId, 1),
        );
        yield* Effect.promise(() => secondOpened);

        const recoveredResponse = receiveFrame(secondSocket, "desktop.control.state");
        send(secondSocket, acquireFrame);
        const recovered = yield* Effect.promise(() => recoveredResponse);
        expect(authorityFrames).toHaveLength(1);
        if (
          recovered.type !== "desktop.control.state" ||
          recovered.state.controller !== "disconnected" ||
          recovered.resumeToken === undefined
        ) {
          return yield* Effect.die("expected disconnected acquire recovery proof");
        }
        expect(recovered.state.lease).toMatchObject({ generation: 1 });

        const resumedResponse = receiveFrame(secondSocket, "desktop.control.state");
        send(secondSocket, {
          protocolVersion: 1,
          type: "desktop.control.resume",
          requestId: "lost-acquire-resume-request" as never,
          leaseId: recovered.state.lease.leaseId,
          generation: recovered.state.lease.generation,
          resumeToken: recovered.resumeToken,
          idempotencyKey: "lost-acquire-resume" as DesktopLeaseIdempotencyKey,
        });
        const resumed = yield* Effect.promise(() => resumedResponse);
        expect(authorityFrames).toHaveLength(2);
        yield* gate.update(authorityFrames[1]!);
        if (resumed.type !== "desktop.control.state" || resumed.state.controller !== "user") {
          return yield* Effect.die("expected resumed user authority");
        }
        expect(resumed.state).toMatchObject({ heldByCurrentClient: true });
        expect(resumed.state.lease.generation).toBeGreaterThan(1);
        expect(gate.snapshot()).toMatchObject({
          controller: "user",
          generation: resumed.state.lease.generation,
        });
        yield* gate.update(authorityFrames[0]!);
        expect(gate.snapshot()).toMatchObject({ generation: resumed.state.lease.generation });

        const staleInput = yield* Effect.exit(
          service.authorizeAndDispatchInput(
            principal(routeBinding, "auth-session-a", "socket-client-1"),
            () => true,
          ),
        );
        expect(staleInput).toMatchObject({ _tag: "Failure" });
        const staleProof = yield* Effect.exit(
          service.resume(principal(routeBinding, "auth-session-a", "socket-client-1"), {
            protocolVersion: 1,
            type: "desktop.control.resume",
            requestId: "lost-acquire-stale-proof" as never,
            leaseId: resumed.state.lease.leaseId,
            generation: resumed.state.lease.generation,
            resumeToken: recovered.resumeToken,
            idempotencyKey: "lost-acquire-stale-proof" as DesktopLeaseIdempotencyKey,
          }),
        );
        expect(staleProof).toMatchObject({ _tag: "Failure" });
        expect(authorityFrames).toHaveLength(2);
      }),
    ),
  ),
);
