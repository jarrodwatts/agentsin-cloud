import type {
  CommandId,
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import {
  EnvironmentRevision,
  type EnvironmentRevisionId,
  type SandboxProvider,
  type SandboxProviderSandbox,
  type WorkspaceId,
} from "@t3tools/contracts/cloud";
import type { WorkerBootstrap, WorkerInstanceId } from "@t3tools/contracts/worker";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  CloudThreadLifecycleDependencyError,
  makeCloudThreadLifecycle,
  type CloudThreadLifecycleClock,
  type VerifiedWorkerPrincipal,
  type WorkerConnectionContext,
} from "./cloudThreadLifecycle.ts";
import type {
  CloudThreadLifecycleAttempt,
  CloudThreadLifecycleState,
  CloudThreadLifecycleStep,
  CloudThreadLifecycleStore,
  ReserveCloudThreadLifecycleInput,
} from "./cloudThreadLifecycleStore.ts";
import { ThreadEventStoreError, type ThreadEventStoreService } from "./threadEventStore.ts";
import type { WorkspaceRepositoryService } from "./workspaces.ts";

const NOW = "2026-08-27T12:00:00.000Z";
const workspaceId = "11111111-1111-4111-8111-111111111111" as WorkspaceId;
const otherWorkspaceId = "22222222-2222-4222-8222-222222222222" as WorkspaceId;
const threadId = "thread-c3" as ThreadId;
const environmentId = "environment-c3" as EnvironmentId;
const projectId = "project-c3" as ProjectId;
const revisionId = "revision-c3" as EnvironmentRevisionId;
const providerInstanceId = "codex_personal" as ProviderInstanceId;
const authenticatedWorkerConnection = {} as WorkerConnectionContext;
const unauthenticatedWorkerConnection = {} as WorkerConnectionContext;

const decodeRevision = Schema.decodeUnknownSync(EnvironmentRevision);
const revision = decodeRevision({
  revisionId,
  blueprintId: "blueprint-c3",
  workspaceId,
  revision: 1,
  contentHash: "sha256:revision-c3",
  blueprint: {
    schemaVersion: 1,
    blueprintId: "blueprint-c3",
    workspaceId,
    name: "C3 environment",
    repositoryIdentity: {
      canonicalKey: "github.com/jarrodwatts/agentsin-cloud",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/jarrodwatts/agentsin-cloud",
      },
    },
    image: "e2b://agents-in-cloud/build-c3",
    workspaceDirectory: "/workspace/agentsin-cloud",
    resources: { cpuCores: 4, memoryMiB: 8192, storageMiB: 32768 },
    setupCommands: [],
    runtimes: [],
    packages: [],
    pluginRefs: [],
    secretRefs: ["provider-profile/codex_personal"],
    verificationCommands: [],
    providerInstances: [{ instanceId: providerInstanceId, driver: "codex" }],
    createdAt: NOW,
    updatedAt: NOW,
  },
  buildStatus: "ready",
  buildSummary: { message: "ready", warningCount: 0, errorCount: 0, recentLines: [] },
  buildLogArtifact: {
    storage: "r2",
    bucket: "builds",
    objectKey: "c3.log",
    contentHash: "sha256:log",
    sizeBytes: 0,
  },
  createdAt: NOW,
});

const createInput = (
  overrides: Partial<
    Parameters<ReturnType<typeof makeCloudThreadLifecycle>["createThread"]>[1]
  > = {},
) => ({
  requestId: "create-c3" as CommandId,
  idempotencyKey: "create-c3-idempotency",
  threadId,
  environmentId,
  environmentRevisionId: revisionId,
  projectId,
  providerInstanceId,
  ...overrides,
});

class MutableClock implements CloudThreadLifecycleClock {
  private milliseconds = Date.parse(NOW);
  now = () => DateTime.toDate(DateTime.makeUnsafe(this.milliseconds));
  advance(milliseconds: number) {
    this.milliseconds += milliseconds;
  }
}

interface StepState {
  status: "pending" | "processing" | "completed" | "failed";
  leaseExpiresAt?: string;
}

class InMemoryLifecycleStore implements CloudThreadLifecycleStore {
  private attempts = new Map<string, CloudThreadLifecycleAttempt>();
  private idempotency = new Map<string, string>();
  private steps = new Map<string, StepState>();
  private tail = Promise.resolve();
  failRecordSandboxOnce = false;
  currentReadCount = 0;

  private key(workspace: WorkspaceId, attemptId: string) {
    return `${workspace}/${attemptId}`;
  }
  private stepKey(attempt: CloudThreadLifecycleAttempt, step: CloudThreadLifecycleStep) {
    return `${this.key(attempt.workspaceId, attempt.attemptId)}/${step}`;
  }
  private locked<A>(use: () => A | Promise<A>) {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(use).finally(release);
  }
  private update(
    attempt: CloudThreadLifecycleAttempt,
    patch: Partial<CloudThreadLifecycleAttempt>,
  ) {
    const updated = { ...attempt, ...patch };
    this.attempts.set(this.key(attempt.workspaceId, attempt.attemptId), updated);
    return updated;
  }

  reserve = (input: ReserveCloudThreadLifecycleInput) =>
    this.locked(() => {
      const current = [...this.attempts.values()].find(
        (attempt) =>
          attempt.workspaceId === input.workspaceId &&
          attempt.threadId === input.threadId &&
          attempt.isCurrent,
      );
      if (current !== undefined) {
        if (current.requestFingerprint !== input.requestFingerprint) {
          throw new Error("conflict");
        }
        return { disposition: "existing" as const, attempt: current };
      }
      const idempotentId = this.idempotency.get(`${input.workspaceId}/${input.idempotencyKey}`);
      if (idempotentId !== undefined) {
        return {
          disposition: "existing" as const,
          attempt: this.attempts.get(this.key(input.workspaceId, idempotentId))!,
        };
      }
      const attempt: CloudThreadLifecycleAttempt = {
        ...input,
        state: "reserved",
        isCurrent: true,
        updatedAt: input.createdAt,
      };
      this.attempts.set(this.key(input.workspaceId, input.attemptId), attempt);
      this.idempotency.set(`${input.workspaceId}/${input.idempotencyKey}`, input.attemptId);
      this.steps.set(this.stepKey(attempt, "create_sandbox"), { status: "pending" });
      return { disposition: "created" as const, attempt };
    });

  getCurrent = async (workspace: WorkspaceId, thread: ThreadId) => {
    this.currentReadCount += 1;
    return [...this.attempts.values()].find(
      (attempt) =>
        attempt.workspaceId === workspace && attempt.threadId === thread && attempt.isCurrent,
    );
  };
  getAttempt = async (workspace: WorkspaceId, attemptId: string) =>
    this.attempts.get(this.key(workspace, attemptId));

  claim = (
    attempt: CloudThreadLifecycleAttempt,
    step: CloudThreadLifecycleStep,
    expectedState: CloudThreadLifecycleState,
    dispatchedState: CloudThreadLifecycleState,
    now: string,
    leaseExpiresAt: string,
  ) =>
    this.locked(() => {
      const current = this.attempts.get(this.key(attempt.workspaceId, attempt.attemptId))!;
      const stepState = this.steps.get(this.stepKey(current, step));
      if (current.state !== expectedState || stepState?.status !== "pending") return false;
      stepState.status = "processing";
      stepState.leaseExpiresAt = leaseExpiresAt;
      this.update(current, { state: dispatchedState, updatedAt: now });
      return true;
    });

  recordSandbox = (
    attempt: CloudThreadLifecycleAttempt,
    sandbox: SandboxProviderSandbox,
    now: string,
  ) =>
    this.locked(() => {
      if (this.failRecordSandboxOnce) {
        this.failRecordSandboxOnce = false;
        throw new Error("database unavailable after remote create");
      }
      const current = this.attempts.get(this.key(attempt.workspaceId, attempt.attemptId))!;
      const updated = this.update(current, {
        sandboxId: sandbox.sandboxId,
        providerHandle: sandbox.providerHandle,
        state: "sandbox_ready",
        updatedAt: now,
      });
      this.steps.set(this.stepKey(updated, "create_sandbox"), { status: "completed" });
      this.steps.set(this.stepKey(updated, "issue_bootstrap"), { status: "pending" });
      return updated;
    });

  recordBootstrap = (
    attempt: CloudThreadLifecycleAttempt,
    workerId: WorkerInstanceId,
    sealedBootstrapRef: string,
    now: string,
  ) =>
    this.locked(() => {
      const current = this.attempts.get(this.key(attempt.workspaceId, attempt.attemptId))!;
      const updated = this.update(current, {
        workerId,
        sealedBootstrapRef,
        state: "bootstrap_ready",
        updatedAt: now,
      });
      this.steps.set(this.stepKey(updated, "issue_bootstrap"), { status: "completed" });
      this.steps.set(this.stepKey(updated, "start_worker"), { status: "pending" });
      return updated;
    });

  markReady = (attempt: CloudThreadLifecycleAttempt, now: string) =>
    this.locked(() => {
      const current = this.attempts.get(this.key(attempt.workspaceId, attempt.attemptId))!;
      const updated = this.update(current, { state: "ready", updatedAt: now });
      this.steps.set(this.stepKey(updated, "start_worker"), { status: "completed" });
      return updated;
    });

  resetStep = (
    attempt: CloudThreadLifecycleAttempt,
    step: CloudThreadLifecycleStep,
    resetState: CloudThreadLifecycleState,
    now: string,
    errorCode: string,
  ) =>
    this.locked(() => {
      const current = this.attempts.get(this.key(attempt.workspaceId, attempt.attemptId))!;
      const updated = this.update(current, {
        state: resetState,
        failureCode: errorCode,
        updatedAt: now,
      });
      this.steps.set(this.stepKey(updated, step), { status: "pending" });
      return updated;
    });

  markCleanupRequired = (attempt: CloudThreadLifecycleAttempt, now: string, errorCode: string) =>
    this.locked(() =>
      this.update(this.attempts.get(this.key(attempt.workspaceId, attempt.attemptId))!, {
        state: "cleanup_required",
        failureCode: errorCode,
        updatedAt: now,
      }),
    );

  markFailed = (attempt: CloudThreadLifecycleAttempt, now: string, errorCode: string) =>
    this.locked(() =>
      this.update(this.attempts.get(this.key(attempt.workspaceId, attempt.attemptId))!, {
        state: "failed",
        isCurrent: false,
        failureCode: errorCode,
        updatedAt: now,
      }),
    );

  listRecoverable = async (now: string, limit: number) =>
    [...this.attempts.values()]
      .filter((attempt) => {
        if (!attempt.isCurrent) return false;
        return [...this.steps.entries()].some(
          ([key, step]) =>
            key.startsWith(`${this.key(attempt.workspaceId, attempt.attemptId)}/`) &&
            (step.status === "pending" ||
              (step.status === "processing" && (step.leaseExpiresAt ?? now) <= now)),
        );
      })
      .slice(0, limit);

  forceState(attemptId: string, state: CloudThreadLifecycleState, step: CloudThreadLifecycleStep) {
    const attempt = this.attempts.get(this.key(workspaceId, attemptId))!;
    this.update(attempt, { state });
    this.steps.set(this.stepKey(attempt, step), {
      status: "processing",
      leaseExpiresAt: NOW,
    });
  }
}

const sandboxFor = (sandboxId = "sandbox-c3"): SandboxProviderSandbox => ({
  sandboxId: sandboxId as SandboxProviderSandbox["sandboxId"],
  workspaceId,
  environmentId,
  infrastructureProvider: "e2b",
  workspace: {
    workspaceId,
    projectId,
    threadId,
    repositoryIdentity: revision.blueprint.repositoryIdentity!,
    workspaceDirectory: revision.blueprint.workspaceDirectory,
  },
  binding: { workspaceId, threadId, sandboxId: sandboxId as SandboxProviderSandbox["sandboxId"] },
  revisionId,
  providerHandle: sandboxId,
  state: "ready",
  createdAt: NOW,
  updatedAt: NOW,
});

const makeHarness = () => {
  const lifecycle = new InMemoryLifecycleStore();
  const clock = new MutableClock();
  let createCalls = 0;
  let destroyCalls = 0;
  let bootstrapCalls = 0;
  let startCalls = 0;
  let routeFenceCalls = 0;
  let inspectStatus: "running" | "absent" | "unknown" = "absent";
  let createFailure: { code: string; retryable: boolean } | undefined;
  let bootstrapFailure: CloudThreadLifecycleDependencyError | undefined;
  let startFailure: CloudThreadLifecycleDependencyError | undefined;
  let routeFenceFailure: CloudThreadLifecycleDependencyError | undefined;
  const compensationOrder: Array<"fence" | "destroy"> = [];
  let verifiedPrincipal: VerifiedWorkerPrincipal | undefined;
  let createGate: Promise<void> | undefined;
  const reservations = new Map<
    string,
    {
      readonly state: "active";
      readonly identity: import("@t3tools/e2b-sandbox").SandboxIdentityRecord;
    }
  >();
  const threadEnvironments = new Map<string, EnvironmentId>();
  const events = [
    {
      schemaVersion: 1,
      workspaceId,
      environmentId,
      threadId,
      event: {
        type: "thread.deleted" as const,
        sequence: 0,
        eventId: "event-c3" as EventId,
        aggregateKind: "thread" as const,
        aggregateId: threadId,
        occurredAt: NOW,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: { threadId, deletedAt: NOW },
      },
      receivedAt: NOW,
    },
  ];

  const provider = {
    capabilities: ["create", "connect", "destroy"],
    create: (request) =>
      Effect.tryPromise({
        try: async () => {
          createCalls += 1;
          await createGate;
          if (createFailure !== undefined) {
            const failure = createFailure;
            createFailure = undefined;
            throw failure;
          }
          const sandbox = sandboxFor();
          reservations.set(`${request.workspaceId}/${request.requestId}`, {
            state: "active",
            identity: {
              reservationId: request.requestId,
              sandboxId: sandbox.sandboxId,
              provider: "e2b",
              workspaceId,
              environmentId,
              projectId,
              threadId,
              revisionId,
              repositoryIdentity: revision.blueprint.repositoryIdentity!,
              workspaceDirectory: revision.blueprint.workspaceDirectory,
              providerHandle: sandbox.providerHandle,
              createdAt: NOW,
            },
          });
          return {
            type: "created" as const,
            requestId: request.requestId,
            workspaceId,
            sandbox,
            completedAt: NOW,
          };
        },
        catch: (cause) => ({
          code:
            typeof cause === "object" && cause !== null && "code" in cause
              ? String(cause.code)
              : "E2B_TIMEOUT",
          message: "create failed",
          retryable:
            typeof cause === "object" && cause !== null && "retryable" in cause
              ? Boolean(cause.retryable)
              : true,
        }),
      }),
    connect: (request) =>
      Effect.succeed({
        type: "connected" as const,
        requestId: request.requestId,
        workspaceId,
        sandboxId: request.sandboxId,
        connection: { transport: "http" as const, endpoint: "https://sandbox.example" },
        completedAt: NOW,
      }),
    destroy: (request) => {
      compensationOrder.push("destroy");
      destroyCalls += 1;
      return Effect.succeed({
        type: "destroyed" as const,
        requestId: request.requestId,
        workspaceId,
        environmentId,
        sandboxId: request.sandboxId,
        completedAt: NOW,
      });
    },
    execute: () => Effect.die("unused"),
    files: () => Effect.die("unused"),
    pty: () => Effect.die("unused"),
    pause: () => Effect.die("unused"),
    resume: () => Effect.die("unused"),
    snapshot: () => Effect.die("unused"),
    desktop: () => Effect.die("unused"),
    ports: () => Effect.die("unused"),
    usage: () => Effect.die("unused"),
  } satisfies SandboxProvider;

  const workspaces: WorkspaceRepositoryService = {
    ensureForUser: () => Effect.die("unused"),
    findForUser: (userId) =>
      Effect.succeed(
        userId === "user-1"
          ? { id: workspaceId, ownerUserId: userId, name: "one", createdAt: NOW }
          : userId === "user-2"
            ? { id: otherWorkspaceId, ownerUserId: userId, name: "two", createdAt: NOW }
            : undefined,
      ),
  };

  const threadEvents = {
    createThread: ({
      workspaceId: routedWorkspace,
      threadId: routedThread,
      environmentId: routedEnvironment,
    }: {
      readonly workspaceId: WorkspaceId;
      readonly threadId: ThreadId;
      readonly environmentId: EnvironmentId;
    }) => {
      const key = `${routedWorkspace}/${routedThread}`;
      const existing = threadEnvironments.get(key);
      if (existing !== undefined && existing !== routedEnvironment) {
        return Effect.fail(
          new ThreadEventStoreError({
            code: "environmentMismatch",
            operation: "create-thread",
            workspaceId: routedWorkspace,
            threadId: routedThread,
          }),
        );
      }
      threadEnvironments.set(key, routedEnvironment);
      return Effect.succeed(existing === undefined ? ("created" as const) : ("existing" as const));
    },
    replayAfter: (
      routedWorkspace: WorkspaceId,
      routedThread: ThreadId,
      after: number,
      limit: number,
    ) => {
      if (routedWorkspace !== workspaceId || routedThread !== threadId) {
        return Effect.fail(
          new ThreadEventStoreError({
            code: "notFound",
            operation: "replay",
            workspaceId: routedWorkspace,
            threadId: routedThread,
          }),
        );
      }
      const selected = events.slice(after + 1, after + 1 + limit);
      return Effect.succeed({
        events: selected,
        nextSequence: after + 1 + selected.length,
        hasMore: false,
      });
    },
    listPendingThreadCommands: () => Effect.succeed([]),
  } as unknown as ThreadEventStoreService;

  const service = makeCloudThreadLifecycle({
    workspaces,
    threadEvents,
    lifecycle,
    revisions: {
      get: (routedWorkspace, routedRevision) =>
        Effect.succeed(
          routedWorkspace === workspaceId && routedRevision === revisionId ? revision : undefined,
        ),
    },
    sandbox: provider,
    reservations: {
      inspect: async (routedWorkspace, reservationId) =>
        reservations.get(`${routedWorkspace}/${reservationId}`),
    },
    bootstrapIssuer: {
      issue: (input) => {
        bootstrapCalls += 1;
        if (bootstrapFailure !== undefined) {
          const failure = bootstrapFailure;
          bootstrapFailure = undefined;
          return Effect.fail(failure);
        }
        const workerId = `worker-${input.attemptId}` as WorkerInstanceId;
        const bootstrap: WorkerBootstrap = {
          schemaVersion: 1,
          workerId,
          workspaceId: input.workspaceId,
          environmentId: input.environmentId,
          environmentRevisionId: input.environmentRevisionId,
          threadId: input.threadId,
          sandboxId: input.sandboxId,
          reservationId: input.attemptId as WorkerBootstrap["reservationId"],
          provider: { instanceId: input.providerInstanceId, driver: input.providerDriver },
          workspaceDirectory: input.workspaceDirectory,
          bootstrapEndpoint: "https://control.example.com/api/v1/worker-certificates/bootstrap",
          relayEndpoint: "wss://control.example/worker",
          relayServerSpkiSha256: "sha256/47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
          relayCredentialRef: `relay-${input.attemptId}` as WorkerBootstrap["relayCredentialRef"],
          secretLeaseRef: `secret-${input.attemptId}` as WorkerBootstrap["secretLeaseRef"],
          issuedAt: NOW,
          expiresAt: "2026-08-27T13:00:00.000Z",
        };
        verifiedPrincipal = {
          generation: input.attemptId,
          workspaceId: input.workspaceId,
          environmentId: input.environmentId,
          environmentRevisionId: input.environmentRevisionId,
          threadId: input.threadId,
          sandboxId: input.sandboxId,
          workerId,
          providerInstanceId: input.providerInstanceId,
          providerDriver: input.providerDriver,
        };
        return Effect.succeed({ bootstrap, sealedBootstrapRef: `sealed/${input.attemptId}` });
      },
    },
    workerGateway: {
      start: () => {
        startCalls += 1;
        if (startFailure !== undefined) {
          const failure = startFailure;
          startFailure = undefined;
          return Effect.fail(failure);
        }
        inspectStatus = "running";
        return Effect.void;
      },
      inspect: () => Effect.succeed(inspectStatus),
      authorizeReconnect: (connection) =>
        connection === authenticatedWorkerConnection && verifiedPrincipal !== undefined
          ? Effect.succeed(verifiedPrincipal)
          : Effect.fail(
              new CloudThreadLifecycleDependencyError({
                code: "worker-credential-invalid",
                retryable: false,
                outcome: "confirmed",
              }),
            ),
    },
    workerRoutes: {
      fenceSandboxForReplacement: () => {
        routeFenceCalls += 1;
        compensationOrder.push("fence");
        if (routeFenceFailure !== undefined) {
          const failure = routeFenceFailure;
          routeFenceFailure = undefined;
          return Effect.fail(failure);
        }
        return Effect.void;
      },
    },
    clock,
    stepLeaseMs: 1_000,
  });

  return {
    service,
    lifecycle,
    clock,
    reservations,
    counts: () => ({ createCalls, destroyCalls, bootstrapCalls, startCalls, routeFenceCalls }),
    compensationOrder: () => compensationOrder,
    setCreateFailure: (failure: { code: string; retryable: boolean }) => {
      createFailure = failure;
    },
    setBootstrapFailure: (failure: CloudThreadLifecycleDependencyError) => {
      bootstrapFailure = failure;
    },
    setStartFailure: (failure: CloudThreadLifecycleDependencyError) => {
      startFailure = failure;
    },
    setRouteFenceFailure: (failure: CloudThreadLifecycleDependencyError) => {
      routeFenceFailure = failure;
    },
    setInspectStatus: (status: typeof inspectStatus) => {
      inspectStatus = status;
    },
    setCreateGate: (gate: Promise<void> | undefined) => {
      createGate = gate;
    },
    setVerifiedPrincipal: (principal: VerifiedWorkerPrincipal) => {
      verifiedPrincipal = principal;
    },
  };
};

it.effect("creates exactly one E2B sandbox for concurrent same-thread requests", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = makeHarness();
      const gate = Promise.withResolvers<void>();
      harness.setCreateGate(gate.promise);
      const first = yield* Effect.forkChild(harness.service.createThread("user-1", createInput()));
      yield* Effect.yieldNow;
      const second = yield* Effect.forkChild(
        harness.service.createThread(
          "user-1",
          createInput({ requestId: "create-c3-2" as CommandId }),
        ),
      );
      yield* Effect.yieldNow;
      expect(harness.counts().createCalls).toBe(1);
      gate.resolve();
      const [firstResult, secondResult] = yield* Effect.all([
        Fiber.join(first),
        Fiber.join(second),
      ]);
      expect(firstResult.state).toBe("ready");
      expect(["create_dispatched", "ready"]).toContain(secondResult.state);
      expect(harness.counts().createCalls).toBe(1);
    }),
  ),
);

it.effect("returns the existing mapping for duplicate idempotent create", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const first = yield* harness.service.createThread("user-1", createInput());
    const duplicate = yield* harness.service.createThread("user-1", createInput());
    expect(duplicate).toEqual(first);
    expect(harness.counts()).toMatchObject({ createCalls: 1, bootstrapCalls: 1, startCalls: 1 });
  }),
);

it.effect("repairs a database failure after remote create without another E2B call", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    harness.lifecycle.failRecordSandboxOnce = true;
    const failed = yield* Effect.result(harness.service.createThread("user-1", createInput()));
    expect(Result.isFailure(failed)).toBe(true);
    harness.clock.advance(2_000);
    yield* harness.service.recoverPending();
    const current = yield* Effect.promise(() =>
      harness.lifecycle.getCurrent(workspaceId, threadId),
    );
    expect(current?.state).toBe("ready");
    expect(harness.counts().createCalls).toBe(1);
  }),
);

it.effect("preserves the thread fence when E2B cleanup is uncertain", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    harness.setCreateFailure({ code: "E2B_ORPHAN_CLEANUP_REQUIRED", retryable: true });
    const result = yield* harness.service.createThread("user-1", createInput());
    expect(result.state).toBe("cleanup_required");
    const retry = yield* harness.service.createThread("user-1", createInput());
    expect(retry.state).toBe("cleanup_required");
    expect(harness.counts().createCalls).toBe(1);
  }),
);

it.effect("retries an idempotent bootstrap failure without replacing the sandbox", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    harness.setBootstrapFailure(
      new CloudThreadLifecycleDependencyError({
        code: "secret-broker-unavailable",
        retryable: true,
        outcome: "confirmed",
      }),
    );
    const first = yield* harness.service.createThread("user-1", createInput());
    expect(first.state).toBe("sandbox_ready");
    const retry = yield* harness.service.createThread("user-1", createInput());
    expect(retry.state).toBe("ready");
    expect(harness.counts()).toMatchObject({ createCalls: 1, bootstrapCalls: 2, startCalls: 1 });
  }),
);

it.effect("fences transient worker routing before compensation destroys a sandbox", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    harness.setBootstrapFailure(
      new CloudThreadLifecycleDependencyError({
        code: "worker-bootstrap-invalid",
        retryable: false,
        outcome: "confirmed",
      }),
    );

    const result = yield* harness.service.createThread("user-1", createInput());

    expect(result.state).toBe("failed");
    expect(harness.compensationOrder()).toEqual(["fence", "destroy"]);
    expect(harness.counts()).toMatchObject({ routeFenceCalls: 1, destroyCalls: 1 });
  }),
);

it.effect("preserves the sandbox cleanup fence when worker route fencing is uncertain", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    harness.setBootstrapFailure(
      new CloudThreadLifecycleDependencyError({
        code: "worker-bootstrap-invalid",
        retryable: false,
        outcome: "confirmed",
      }),
    );
    harness.setRouteFenceFailure(
      new CloudThreadLifecycleDependencyError({
        code: "worker-route-fence-failed",
        retryable: true,
        outcome: "uncertain",
      }),
    );

    const result = yield* harness.service.createThread("user-1", createInput());

    expect(result.state).toBe("cleanup_required");
    expect(harness.compensationOrder()).toEqual(["fence"]);
    expect(harness.counts()).toMatchObject({ routeFenceCalls: 1, destroyCalls: 0 });
  }),
);

it.effect("recovers an uncertain worker start by inspecting the same worker identity", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    harness.setStartFailure(
      new CloudThreadLifecycleDependencyError({
        code: "worker-start-timeout",
        retryable: true,
        outcome: "uncertain",
      }),
    );
    const first = yield* harness.service.createThread("user-1", createInput());
    expect(first.state).toBe("worker_start_dispatched");
    harness.setInspectStatus("running");
    harness.clock.advance(2_000);
    yield* harness.service.recoverPending();
    const current = yield* Effect.promise(() =>
      harness.lifecycle.getCurrent(workspaceId, threadId),
    );
    expect(current?.state).toBe("ready");
    expect(harness.counts().startCalls).toBe(1);
  }),
);

it.effect("derives tenant routing instead of trusting another workspace", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* harness.service.createThread("user-1", createInput());
    const denied = yield* Effect.result(harness.service.connectThread("user-2", threadId, -1));
    expect(Result.isFailure(denied)).toBe(true);
    if (Result.isFailure(denied)) expect(denied.failure.code).toBe("notFound");
  }),
);

it.effect("rejects stale worker generation and identity on reconnect", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* harness.service.createThread("user-1", createInput());
    const current = (yield* Effect.promise(() =>
      harness.lifecycle.getCurrent(workspaceId, threadId),
    ))!;
    harness.setVerifiedPrincipal({
      generation: "stale-generation",
      workspaceId,
      environmentId,
      environmentRevisionId: revisionId,
      threadId,
      sandboxId: current.sandboxId!,
      workerId: current.workerId!,
      providerInstanceId,
      providerDriver: revision.blueprint.providerInstances[0]!.driver,
    });
    const staleGeneration = yield* Effect.result(
      harness.service.reconnectWorker({
        afterSequence: -1,
        connection: authenticatedWorkerConnection,
      }),
    );
    expect(Result.isFailure(staleGeneration)).toBe(true);
    if (Result.isFailure(staleGeneration)) expect(staleGeneration.failure.code).toBe("staleWorker");

    harness.setVerifiedPrincipal({
      generation: current.attemptId,
      workspaceId,
      environmentId,
      environmentRevisionId: revisionId,
      threadId,
      sandboxId: current.sandboxId!,
      workerId: "stale-worker" as WorkerInstanceId,
      providerInstanceId,
      providerDriver: revision.blueprint.providerInstances[0]!.driver,
    });
    const stale = yield* Effect.result(
      harness.service.reconnectWorker({
        afterSequence: -1,
        connection: authenticatedWorkerConnection,
      }),
    );
    expect(Result.isFailure(stale)).toBe(true);
    if (Result.isFailure(stale)) expect(stale.failure.code).toBe("staleWorker");
  }),
);

it.effect("replays authoritative state to an mTLS-authenticated worker reconnect", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* harness.service.createThread("user-1", createInput());
    const reconnected = yield* harness.service.reconnectWorker({
      afterSequence: -1,
      connection: authenticatedWorkerConnection,
    });
    expect(reconnected.commands).toEqual([]);
    expect(reconnected.replay.events).toHaveLength(1);
    expect(reconnected.replay.nextSequence).toBe(1);
  }),
);

it.effect("rejects an unverified worker credential before reading tenant state", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* harness.service.createThread("user-1", createInput());
    const readsBeforeReconnect = harness.lifecycle.currentReadCount;
    const denied = yield* Effect.result(
      harness.service.reconnectWorker({
        afterSequence: -1,
        connection: unauthenticatedWorkerConnection,
      }),
    );
    expect(Result.isFailure(denied)).toBe(true);
    if (Result.isFailure(denied)) expect(denied.failure.code).toBe("unauthorized");
    expect(harness.lifecycle.currentReadCount).toBe(readsBeforeReconnect);
  }),
);

it.effect("replays durable events to an authenticated desktop connection", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* harness.service.createThread("user-1", createInput());
    const connected = yield* harness.service.connectThread("user-1", threadId, -1);
    expect(connected.replay.events).toHaveLength(1);
    expect(connected.replayCursor).toBe(0);
    expect(connected.connection.endpoint).toBe("https://sandbox.example");
  }),
);

it.effect("keeps the recovery job idempotent after readiness", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* harness.service.createThread("user-1", createInput());
    harness.clock.advance(2_000);
    expect(yield* harness.service.recoverPending()).toBe(0);
    expect(yield* harness.service.recoverPending()).toBe(0);
    expect(harness.counts()).toMatchObject({ createCalls: 1, bootstrapCalls: 1, startCalls: 1 });
  }),
);
