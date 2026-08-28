// @effect-diagnostics globalDate:off -- The injected clock deliberately returns native Date values.
import type {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import type {
  EnvironmentRevisionId,
  SandboxId,
  SandboxProvider,
  SandboxProviderSandbox,
  WorkspaceId,
} from "@t3tools/contracts/cloud";
import type { WorkerBootstrap, WorkerInstanceId } from "@t3tools/contracts/worker";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  CloudThreadLifecycleDependencyError,
  type WorkerConnectionGateway,
  type WorkerRouteLifecycle,
} from "./cloudThreadLifecycle.ts";
import {
  makeCloudThreadRuntime,
  type RuntimeWorkerRecovery,
  type RuntimeWorkerBootstrapIssuer,
  type WorkerCredentialLifecycle,
} from "./cloudThreadRuntime.ts";
import type {
  CloudThreadActivityEvent,
  CloudThreadResumeClaim,
  CloudThreadResumeRequest,
  CloudThreadRuntimeRecord,
  CloudThreadRuntimeStore,
} from "./cloudThreadRuntimeStore.ts";

const workspaceId = "88888888-8888-4888-8888-888888888888" as WorkspaceId;
const threadId = "runtime-unit-thread" as ThreadId;
const environmentId = "runtime-unit-environment" as EnvironmentId;
const environmentRevisionId = "runtime-unit-revision" as EnvironmentRevisionId;
const sandboxId = "runtime-unit-sandbox" as SandboxId;
const attemptId = "runtime-unit-attempt";
const workerId = "runtime-unit-worker-1" as WorkerInstanceId;
const instant = "2026-08-28T12:15:00.000Z";

const runtime = (state: CloudThreadRuntimeRecord["state"]): CloudThreadRuntimeRecord => ({
  workspaceId,
  threadId,
  attemptId,
  environmentId,
  environmentRevisionId,
  sandboxId,
  workerId,
  sealedBootstrapRef: "sealed/runtime-unit-worker-1",
  providerInstanceId: "codex-personal" as CloudThreadRuntimeRecord["providerInstanceId"],
  providerDriver: "codex" as ProviderDriverKind,
  generation: 1,
  state,
  lastActivityAt: "2026-08-28T12:00:00.000Z",
  ...(state === "running" ? { idleSince: "2026-08-28T12:00:00.000Z" } : {}),
  ...(state === "running"
    ? {}
    : {
        transitionId: `pause:${attemptId}:1`,
        transitionKind: "pause" as const,
        transitionStartedAt: instant,
      }),
  updatedAt: instant,
});

const sandbox = (
  value: CloudThreadRuntimeRecord,
  state: "ready" | "suspended",
): SandboxProviderSandbox => ({
  sandboxId: value.sandboxId,
  workspaceId: value.workspaceId,
  environmentId: value.environmentId,
  infrastructureProvider: "e2b",
  workspace: {
    workspaceId: value.workspaceId,
    projectId: "runtime-project" as ProjectId,
    threadId: value.threadId,
    repositoryIdentity: {
      canonicalKey: "github.com/jarrodwatts/agentsin-cloud",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/jarrodwatts/agentsin-cloud",
      },
    },
    workspaceDirectory: "/workspace/agentsin-cloud",
  },
  binding: {
    workspaceId: value.workspaceId,
    threadId: value.threadId,
    sandboxId: value.sandboxId,
  },
  revisionId: value.environmentRevisionId,
  providerHandle: "e2b-provider-handle",
  state,
  createdAt: "2026-08-28T11:00:00.000Z",
  updatedAt: instant,
});

const bootstrap = (
  value: CloudThreadRuntimeRecord,
  nextWorkerId: WorkerInstanceId,
): WorkerBootstrap => ({
  schemaVersion: 1,
  workerId: nextWorkerId,
  workspaceId: value.workspaceId,
  environmentId: value.environmentId,
  environmentRevisionId: value.environmentRevisionId,
  threadId: value.threadId,
  sandboxId: value.sandboxId,
  reservationId: value.attemptId as CommandId,
  provider: { instanceId: value.providerInstanceId, driver: value.providerDriver },
  workspaceDirectory: "/workspace/agentsin-cloud",
  bootstrapEndpoint: "https://control.agentsin.cloud/bootstrap",
  relayEndpoint: "wss://worker.agentsin.cloud/relay",
  relayServerSpkiSha256: `sha256/${"A".repeat(43)}=`,
  relayCredentialRef: "relay/runtime-worker-2" as WorkerBootstrap["relayCredentialRef"],
  secretLeaseRef: "secrets/runtime-worker-2" as WorkerBootstrap["secretLeaseRef"],
  issuedAt: instant,
  expiresAt: "2026-08-28T12:20:00.000Z",
});

const makeStore = (initial: CloudThreadRuntimeRecord) => {
  let current = initial;
  let idleClaimed = false;
  const store: CloudThreadRuntimeStore = {
    getCurrent: () => Promise.resolve(current),
    recordActivity: (_event: CloudThreadActivityEvent) => Promise.resolve(current),
    claimIdlePauses: () => {
      if (idleClaimed || current.state !== "running") return Promise.resolve([]);
      idleClaimed = true;
      const { idleSince: _idleSince, ...active } = current;
      current = {
        ...active,
        state: "pause_dispatched",
        transitionId: `pause:${attemptId}:1`,
        transitionKind: "pause",
        transitionStartedAt: instant,
      };
      return Promise.resolve([current]);
    },
    recordPauseStep: (value, step, occurredAt) => {
      current = {
        ...value,
        ...(step === "route_fenced"
          ? { routeFencedAt: occurredAt }
          : { credentialsScrubbedAt: occurredAt }),
        updatedAt: occurredAt,
      };
      return Promise.resolve(current);
    },
    markPaused: (value, occurredAt) => {
      current = {
        ...value,
        state: "paused",
        providerCompletedAt: occurredAt,
        updatedAt: occurredAt,
      };
      return Promise.resolve(current);
    },
    requestResume: (_request: CloudThreadResumeRequest): Promise<CloudThreadResumeClaim> => {
      if (current.state === "running")
        return Promise.resolve({ disposition: "running", runtime: current });
      if (current.state === "pause_dispatched") {
        return Promise.resolve({ disposition: "pending", runtime: current });
      }
      if (current.state === "paused") {
        const { providerCompletedAt: _providerCompletedAt, ...paused } = current;
        current = {
          ...paused,
          generation: current.generation + 1,
          state: "resume_dispatched",
          transitionId: `resume:${attemptId}:${current.generation + 1}`,
          transitionKind: "resume",
          transitionStartedAt: instant,
        };
        return Promise.resolve({ disposition: "claimed", runtime: current });
      }
      return Promise.resolve({ disposition: "joined", runtime: current });
    },
    claimPendingResume: () => Promise.resolve(undefined),
    markProviderResumed: (value, occurredAt) => {
      current = {
        ...value,
        state: "resume_bootstrap_dispatched",
        providerCompletedAt: occurredAt,
      };
      return Promise.resolve(current);
    },
    recordResumeBootstrap: (value, nextWorkerId, sealedBootstrapRef, occurredAt) => {
      current = {
        ...value,
        state: "resume_worker_start_dispatched",
        workerId: nextWorkerId,
        sealedBootstrapRef,
        updatedAt: occurredAt,
      };
      return Promise.resolve(current);
    },
    markRunning: (value, occurredAt) => {
      const {
        transitionId: _transitionId,
        transitionKind: _transitionKind,
        transitionStartedAt: _transitionStartedAt,
        routeFencedAt: _routeFencedAt,
        credentialsScrubbedAt: _credentialsScrubbedAt,
        providerCompletedAt: _providerCompletedAt,
        ...resumed
      } = value;
      current = {
        ...resumed,
        state: "running",
        idleSince: occurredAt,
        updatedAt: occurredAt,
      };
      return Promise.resolve(current);
    },
    markReconciliationRequired: (value, failureCode, occurredAt) => {
      current = {
        ...value,
        state: "reconciliation_required",
        failureCode,
        updatedAt: occurredAt,
      };
      return Promise.resolve(current);
    },
    listRecoverable: () =>
      Promise.resolve(
        current.state === "pause_dispatched" ||
          current.state === "resume_dispatched" ||
          current.state === "resume_bootstrap_dispatched" ||
          current.state === "resume_worker_start_dispatched"
          ? [current]
          : [],
      ),
  };
  return { store, current: () => current };
};

const dependencyError = (options: {
  readonly code: string;
  readonly retryable: boolean;
  readonly outcome: "confirmed" | "uncertain";
}) => new CloudThreadLifecycleDependencyError(options);

it.effect("fences routes and credentials before an idempotent pause retry", () =>
  Effect.gen(function* () {
    const state = makeStore(runtime("running"));
    const calls: string[] = [];
    let pauseCalls = 0;
    const provider = {
      pause: (request: Parameters<SandboxProvider["pause"]>[0]) => {
        pauseCalls += 1;
        calls.push(`pause:${request.requestId}`);
        return pauseCalls === 1
          ? Effect.fail({ code: "E2B_TIMEOUT", message: "timeout", retryable: true })
          : Effect.succeed({
              type: "paused" as const,
              requestId: request.requestId,
              workspaceId,
              sandbox: sandbox(state.current(), "suspended"),
              completedAt: instant,
            });
      },
    } as unknown as SandboxProvider;
    const service = makeCloudThreadRuntime({
      store: state.store,
      sandbox: provider,
      bootstrapIssuer: {} as RuntimeWorkerBootstrapIssuer,
      workerGateway: {} as WorkerConnectionGateway,
      workerRecovery: {} as RuntimeWorkerRecovery,
      workerRoutes: {
        fenceSandboxForReplacement: () => {
          calls.push("route-fence");
          return Effect.void;
        },
      } as WorkerRouteLifecycle,
      workerCredentials: {
        scrubForPause: () => {
          calls.push("credential-scrub");
          return Effect.void;
        },
      } as WorkerCredentialLifecycle,
      clock: { now: () => new Date(instant) },
    });

    expect(yield* service.pauseIdle()).toMatchObject({ claimed: 1, pending: 1 });
    expect(state.current().state).toBe("pause_dispatched");
    expect(yield* service.recoverPending()).toMatchObject({ claimed: 1, completed: 1 });
    expect(state.current().state).toBe("paused");
    expect(calls).toEqual([
      "route-fence",
      "credential-scrub",
      "pause:pause:runtime-unit-attempt:1:provider",
      "pause:pause:runtime-unit-attempt:1:provider",
    ]);
  }),
);

it.effect("assigns activity time in the control plane and bounds worker leases", () =>
  Effect.gen(function* () {
    const state = makeStore(runtime("running"));
    let recorded: CloudThreadActivityEvent | undefined;
    const store: CloudThreadRuntimeStore = {
      ...state.store,
      recordActivity: (event) => {
        recorded = event;
        return Promise.resolve(state.current());
      },
    };
    const service = makeCloudThreadRuntime({
      store,
      sandbox: {} as SandboxProvider,
      bootstrapIssuer: {} as RuntimeWorkerBootstrapIssuer,
      workerGateway: {} as WorkerConnectionGateway,
      workerRecovery: {} as RuntimeWorkerRecovery,
      workerRoutes: {} as WorkerRouteLifecycle,
      workerCredentials: {} as WorkerCredentialLifecycle,
      clock: { now: () => new Date(instant) },
    });
    yield* service.recordActivity({
      type: "started",
      workspaceId,
      threadId,
      attemptId,
      eventId: "server-timed-start",
      activityId: "server-timed-agent",
      source: "agent",
      generation: 1,
      leaseMs: 60_000,
    });
    expect(recorded).toMatchObject({
      occurredAt: instant,
      expiresAt: "2026-08-28T12:16:00.000Z",
    });
    const invalid = yield* Effect.exit(
      service.recordActivity({
        type: "heartbeat",
        workspaceId,
        threadId,
        attemptId,
        eventId: "unbounded-heartbeat",
        activityId: "server-timed-agent",
        generation: 1,
        leaseMs: 5 * 60_000 + 1,
      }),
    );
    expect(Exit.isFailure(invalid)).toBe(true);
  }),
);

it.effect("reconciles a lost worker-start response without starting a second worker", () =>
  Effect.gen(function* () {
    const state = makeStore({
      ...runtime("paused"),
      routeFencedAt: instant,
      credentialsScrubbedAt: instant,
      providerCompletedAt: instant,
    });
    const nextWorkerId = "runtime-unit-worker-2" as WorkerInstanceId;
    const starts: WorkerInstanceId[] = [];
    const provider = {
      resume: (request: Parameters<SandboxProvider["resume"]>[0]) =>
        Effect.succeed({
          type: "resumed" as const,
          requestId: request.requestId,
          workspaceId,
          sandbox: sandbox(state.current(), "ready"),
          completedAt: instant,
        }),
    } as unknown as SandboxProvider;
    const gateway = {
      start: (input: { readonly workerId: WorkerInstanceId }) => {
        starts.push(input.workerId);
        return Effect.fail(
          dependencyError({
            code: "worker-start-response-lost",
            retryable: true,
            outcome: "uncertain",
          }),
        );
      },
      inspect: () => Effect.succeed("running" as const),
    } as unknown as WorkerConnectionGateway;
    const service = makeCloudThreadRuntime({
      store: state.store,
      sandbox: provider,
      bootstrapIssuer: {
        issue: () =>
          Effect.succeed({
            bootstrap: bootstrap(state.current(), nextWorkerId),
            sealedBootstrapRef: "sealed/runtime-unit-worker-2",
          }),
      },
      workerGateway: gateway,
      workerRecovery: { confirmRecovered: () => Effect.void },
      workerRoutes: {} as WorkerRouteLifecycle,
      workerCredentials: {} as WorkerCredentialLifecycle,
      clock: { now: () => new Date(instant) },
    });

    const first = yield* Effect.exit(
      service.requestResume({
        workspaceId,
        threadId,
        attemptId,
        requestId: "resume-inspector",
        reason: "inspector",
        requestedAt: instant,
      }),
    );
    expect(Exit.isFailure(first)).toBe(true);
    expect(state.current()).toMatchObject({
      state: "resume_worker_start_dispatched",
      generation: 2,
      workerId: nextWorkerId,
    });
    expect(yield* service.recoverPending()).toMatchObject({ claimed: 1, completed: 1 });
    expect(state.current().state).toBe("running");
    expect(starts).toEqual([nextWorkerId]);
  }),
);
