import { expect, it } from "@effect/vitest";
import { WorkerCertificateBootstrapRequest } from "@t3tools/contracts/worker";
import type { ThreadId } from "@t3tools/contracts";
import type { SandboxId, WorkspaceId } from "@t3tools/contracts/cloud";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Pool } from "pg";

import { type ControlPlaneConfigShape } from "./config.ts";
import { type DatabaseService } from "./database.ts";
import { makeMemoryEphemeralCoordination } from "./ephemeralCoordination.ts";
import { makeApplication } from "./main.ts";
import { type ThreadEventStoreService } from "./threadEventStore.ts";
import {
  makeWorkerControlPlaneRuntime,
  type WorkerProductionDependencies,
} from "./workerProduction.ts";
import { WorkerRelayServerError } from "./workerRelay.ts";
import { type WorkspaceRepositoryService } from "./workspaces.ts";

const encodeBootstrapRequest = Schema.encodeUnknownSync(
  Schema.fromJsonString(WorkerCertificateBootstrapRequest),
);

const config: ControlPlaneConfigShape = {
  port: 8787,
  host: "127.0.0.1",
  databaseUrl: new URL("postgresql://localhost/agents_in_cloud"),
  betterAuthSecret: "a-secure-secret-that-is-at-least-32-characters",
  betterAuthUrl: new URL("https://control.example.com"),
  githubClientId: "github-client-id",
  githubClientSecret: "github-client-secret",
  passkeyRpId: "control.example.com",
  passkeyRpName: "Agents in Cloud",
  desktopAuthCallbackUrl: new URL("agentsincloud://auth/callback"),
  desktopAuthHandoffSecret: "a-separate-handoff-secret-that-is-at-least-32-characters",
  desktopAuthHandoffTtlSeconds: 120,
  maxRequestBodyBytes: 1_024 * 1_024,
  requestTimeoutMs: 15_000,
  headersTimeoutMs: 10_000,
  workerMtlsPort: 9443,
  workerMtlsHost: "127.0.0.1",
  workerMtlsServerCertificateFile: "/run/secrets/worker-server.crt",
  workerMtlsServerKeyFile: "/run/secrets/worker-server.key",
  workerMtlsClientCaFile: "/run/secrets/worker-client-ca.crt",
  workerProcessInstanceId: "railway-replica-1",
  workerCertificateSignerKmsKeyId: "kms://worker-issuer-production",
};

const workspaces: WorkspaceRepositoryService = {
  ensureForUser: () =>
    Effect.succeed({
      id: "workspace-1",
      ownerUserId: "user-1",
      name: "Ada's workspace",
      createdAt: "2026-08-27T00:00:00.000Z",
    }),
  findForUser: () => Effect.void.pipe(Effect.as(undefined)),
};

const threadEvents = {
  submitCommand: () => Effect.die("not used by the health-route composition test"),
  replayAfter: () => Effect.die("not used by the health-route composition test"),
} as unknown as ThreadEventStoreService;
const coordination = makeMemoryEphemeralCoordination().service;

const workerProduction: WorkerProductionDependencies = {
  signer: {
    kmsKeyId: config.workerCertificateSignerKmsKeyId,
    issue: () => Effect.die("not used by the composition test"),
  },
  reservations: {
    verifyActive: () => Effect.void,
  },
  recovery: {
    recover: () => Effect.succeed([]),
    handleOutbound: () => Effect.succeed({ type: "accepted" }),
    claimCommand: () =>
      Effect.fail(new WorkerRelayServerError({ code: "internal", operation: "composition-test" })),
  },
};

it.effect("wires auth, services, and HTTP routes without opening a listener", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const pool = yield* Effect.acquireRelease(
        Effect.sync(() => new Pool({ connectionString: config.databaseUrl.toString(), max: 1 })),
        (activePool) => Effect.promise(() => activePool.end()),
      );
      const database: DatabaseService = {
        pool,
        query: <Row>() => Effect.succeed([] as ReadonlyArray<Row>),
        ping: Effect.void,
      };
      const application = makeApplication({
        config,
        database,
        workspaces,
        threadEvents,
        coordination,
      });
      const response = yield* Effect.promise(() =>
        application.handle(new Request("https://control.example.com/healthz")),
      );

      expect(application.auth.handler).toBeTypeOf("function");
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toEqual({
        service: "control-plane",
        status: "ok",
      });
    }),
  ),
);

it.effect(
  "constructs worker identity, relay, and public bootstrap routing from production seams",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const pool = yield* Effect.acquireRelease(
          Effect.sync(() => new Pool({ connectionString: config.databaseUrl.toString(), max: 1 })),
          (activePool) => Effect.promise(() => activePool.end()),
        );
        const database: DatabaseService = {
          pool,
          query: <Row>() => Effect.succeed([] as ReadonlyArray<Row>),
          ping: Effect.void,
        };
        const worker = yield* makeWorkerControlPlaneRuntime({
          config,
          database,
          threadEvents,
          production: workerProduction,
          coordination,
        });
        const application = makeApplication({
          config,
          database,
          workspaces,
          threadEvents,
          worker,
          coordination,
        });
        const response = yield* Effect.promise(() =>
          application.handle(
            new Request("https://control.example.com/api/v1/worker-certificates/bootstrap", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: encodeBootstrapRequest({
                schemaVersion: 1,
                token: "invalid-bootstrap-token-value-0001",
                publicKeySpkiDerBase64: "aGVsbG8=",
              }),
            }),
          ),
        );

        expect(worker.relay.processInstanceId).toBe(config.workerProcessInstanceId);
        expect(response.status).toBe(401);
        expect(yield* Effect.promise(() => response.json())).toEqual({
          error: "invalid_or_used_bootstrap",
        });
      }),
    ),
);

it.effect("fails closed when the injected signer does not match the configured KMS identity", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const pool = yield* Effect.acquireRelease(
        Effect.sync(() => new Pool({ connectionString: config.databaseUrl.toString(), max: 1 })),
        (activePool) => Effect.promise(() => activePool.end()),
      );
      const database: DatabaseService = {
        pool,
        query: <Row>() => Effect.succeed([] as ReadonlyArray<Row>),
        ping: Effect.void,
      };
      const result = yield* Effect.exit(
        makeWorkerControlPlaneRuntime({
          config,
          database,
          threadEvents,
          production: {
            ...workerProduction,
            signer: { ...workerProduction.signer, kmsKeyId: "kms://unexpected-key" },
          },
          coordination,
        }),
      );

      expect(result._tag).toBe("Failure");
    }),
  ),
);

it.effect(
  "composes transient replacement and terminal coordination with the worker lifecycle",
  () =>
    Effect.gen(function* () {
      const pool = {
        connect: async () => ({
          query: async () => ({ rows: [] }),
          release: () => undefined,
        }),
      } as unknown as Pool;
      const database: DatabaseService = {
        pool,
        query: <Row>() => Effect.succeed([] as ReadonlyArray<Row>),
        ping: Effect.void,
      };
      const coordinationHarness = makeMemoryEphemeralCoordination();
      const worker = yield* makeWorkerControlPlaneRuntime({
        config,
        database,
        threadEvents,
        production: workerProduction,
        coordination: coordinationHarness.service,
      });
      const workspaceId = "00000000-0000-4000-8000-000000000001" as WorkspaceId;
      const threadId = "composition-thread" as ThreadId;
      const sandboxId = "composition-sandbox" as SandboxId;
      const route = {
        workspaceId,
        threadId,
        connectionId: "connection-1",
        processInstanceId: config.workerProcessInstanceId,
        generation: 1,
        ttlMs: 5_000,
      };
      yield* coordinationHarness.service.publishRoute(route);
      yield* worker.relay.pauseThread(workspaceId, threadId);
      expect(yield* coordinationHarness.service.getRoute(workspaceId, threadId)).toBeUndefined();

      yield* coordinationHarness.service.publishRoute({
        ...route,
        connectionId: "connection-2",
        generation: 2,
      });
      coordinationHarness.setAvailable(false);
      yield* worker.routeLifecycle.fenceSandboxForReplacement({
        workspaceId,
        threadId,
        sandboxId,
        reason: "sandbox_replaced",
      });
      coordinationHarness.setAvailable(true);
      expect(
        yield* coordinationHarness.service.publishRoute({
          ...route,
          connectionId: "connection-3",
          generation: 3,
        }),
      ).toBe("refreshed");
      expect(yield* coordinationHarness.service.getRoute(workspaceId, threadId)).toMatchObject({
        connectionId: "connection-3",
        generation: 3,
      });

      coordinationHarness.setAvailable(false);
      expect(
        (yield* Effect.exit(
          worker.relay.retireThreadTerminal(workspaceId, threadId, sandboxId, "thread_destroyed"),
        ))._tag,
      ).toBe("Failure");
      coordinationHarness.setAvailable(true);
      yield* worker.relay.retireThreadTerminal(
        workspaceId,
        threadId,
        sandboxId,
        "thread_destroyed",
      );
      expect(
        yield* coordinationHarness.service.publishRoute({
          ...route,
          connectionId: "stale-worker",
          generation: 999,
        }),
      ).toBe("stale");
    }),
);
