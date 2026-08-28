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
  type CentralCredentialRevoker,
  type RuntimeWorkerRecovery,
  type RuntimeWorkerBootstrapIssuer,
  type WorkerCredentialLifecycle,
} from "./cloudThreadRuntime.ts";
import type {
  CloudThreadActivityEvent,
  CloudThreadResumeClaim,
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
    recordActivity: (event: CloudThreadActivityEvent) =>
      Promise.resolve({ disposition: "applied", runtime: current, event }),
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
    recordContainmentOutcome: (value, step, outcome, errorCode, occurredAt) => {
      const receipt =
        outcome !== "succeeded"
          ? {}
          : step === "route_fence"
            ? { routeFencedAt: occurredAt }
            : step === "credential_revoke"
              ? { credentialsRevokedAt: occurredAt }
              : step === "credential_scrub"
                ? { credentialsScrubbedAt: occurredAt }
                : step === "provider_pause"
                  ? { providerCompletedAt: occurredAt }
                  : { sandboxDestroyedAt: occurredAt };
      current = {
        ...value,
        ...receipt,
        ...(errorCode === undefined ? {} : { failureCode: errorCode }),
        updatedAt: occurredAt,
      };
      return Promise.resolve(current);
    },
    markPaused: (value, occurredAt) => {
      current = {
        ...value,
        state: "paused",
        updatedAt: occurredAt,
      };
      return Promise.resolve(current);
    },
    requestResume: (request): Promise<CloudThreadResumeClaim> => {
      if (current.state === "running")
        return Promise.resolve({ disposition: "running", runtime: current, request });
      if (current.state === "pause_dispatched") {
        return Promise.resolve({ disposition: "pending", runtime: current, request });
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
        return Promise.resolve({ disposition: "claimed", runtime: current, request });
      }
      return Promise.resolve({ disposition: "joined", runtime: current, request });
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
        credentialsRevokedAt: _credentialsRevokedAt,
        credentialsScrubbedAt: _credentialsScrubbedAt,
        providerCompletedAt: _providerCompletedAt,
        sandboxDestroyedAt: _sandboxDestroyedAt,
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
          (current.state === "reconciliation_required" &&
            current.transitionKind === "pause" &&
            (current.routeFencedAt === undefined ||
              current.credentialsRevokedAt === undefined ||
              (current.sandboxDestroyedAt === undefined &&
                (current.providerCompletedAt === undefined ||
                  current.credentialsScrubbedAt === undefined)))) ||
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
      centralCredentialRevoker: {
        revokeForContainment: () => {
          calls.push("credential-revoke");
          return Effect.void;
        },
      },
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
      "credential-revoke",
      "route-fence",
      "credential-scrub",
      "pause:pause:runtime-unit-attempt:1:provider-pause",
      "pause:pause:runtime-unit-attempt:1:provider-pause",
    ]);
  }),
);

it.effect("quarantines and destroys after confirmed fence and scrub failures", () =>
  Effect.gen(function* () {
    const state = makeStore(runtime("running"));
    const calls: string[] = [];
    let routeAttempts = 0;
    const service = makeCloudThreadRuntime({
      store: state.store,
      sandbox: {
        pause: () => {
          calls.push("provider-pause");
          return Effect.die("pause must not run with an unsanitized sandbox");
        },
        destroy: (request: Parameters<SandboxProvider["destroy"]>[0]) => {
          calls.push(`provider-destroy:${request.requestId}`);
          return Effect.succeed({
            type: "destroyed" as const,
            requestId: request.requestId,
            workspaceId,
            environmentId,
            sandboxId,
            completedAt: instant,
          });
        },
      } as unknown as SandboxProvider,
      bootstrapIssuer: {} as RuntimeWorkerBootstrapIssuer,
      workerGateway: {} as WorkerConnectionGateway,
      workerRecovery: {} as RuntimeWorkerRecovery,
      workerRoutes: {
        fenceSandboxForReplacement: () => {
          routeAttempts += 1;
          calls.push("route-fence");
          return routeAttempts === 1
            ? Effect.fail(
                dependencyError({
                  code: "route-fence-denied",
                  retryable: false,
                  outcome: "confirmed",
                }),
              )
            : Effect.void;
        },
      } as WorkerRouteLifecycle,
      centralCredentialRevoker: {
        revokeForContainment: () => {
          calls.push("central-revoke");
          return Effect.void;
        },
      },
      workerCredentials: {
        scrubForPause: () => {
          calls.push("credential-scrub");
          return Effect.fail(
            dependencyError({
              code: "sandbox-scrub-denied",
              retryable: false,
              outcome: "confirmed",
            }),
          );
        },
      },
      clock: { now: () => new Date(instant) },
    });

    expect(yield* service.pauseIdle()).toMatchObject({ claimed: 1, reconciliationRequired: 1 });
    expect(state.current()).toMatchObject({
      state: "reconciliation_required",
      credentialsRevokedAt: instant,
      sandboxDestroyedAt: instant,
    });
    expect(state.current().routeFencedAt).toBeUndefined();
    expect(yield* service.recoverPending()).toMatchObject({
      claimed: 1,
      reconciliationRequired: 1,
    });
    expect(state.current()).toMatchObject({
      state: "reconciliation_required",
      routeFencedAt: instant,
      credentialsRevokedAt: instant,
      sandboxDestroyedAt: instant,
    });
    expect(yield* service.recoverPending()).toMatchObject({ claimed: 0 });
    expect(calls).toEqual([
      "central-revoke",
      "route-fence",
      "credential-scrub",
      "provider-destroy:pause:runtime-unit-attempt:1:provider-destroy",
      "route-fence",
    ]);
  }),
);

it.effect("assigns activity time in the control plane and bounds worker leases", () =>
  Effect.gen(function* () {
    const state = makeStore(runtime("running"));
    let recorded: CloudThreadActivityEvent | undefined;
    let resumeRequestedAt: string | undefined;
    const store: CloudThreadRuntimeStore = {
      ...state.store,
      recordActivity: (event) => {
        recorded = event;
        return Promise.resolve({ disposition: "applied", runtime: state.current(), event });
      },
      requestResume: (event) => {
        resumeRequestedAt = event.requestedAt;
        return state.store.requestResume(event);
      },
    };
    const service = makeCloudThreadRuntime({
      store,
      sandbox: {} as SandboxProvider,
      bootstrapIssuer: {} as RuntimeWorkerBootstrapIssuer,
      workerGateway: {} as WorkerConnectionGateway,
      workerRecovery: {} as RuntimeWorkerRecovery,
      workerRoutes: {} as WorkerRouteLifecycle,
      centralCredentialRevoker: {} as CentralCredentialRevoker,
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
    const resume = yield* service.requestResume({
      workspaceId,
      threadId,
      attemptId,
      requestId: "server-timed-resume",
      reason: "message",
    });
    expect(resumeRequestedAt).toBe(instant);
    expect(resume.request.requestedAt).toBe(instant);
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
      centralCredentialRevoker: {} as CentralCredentialRevoker,
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
