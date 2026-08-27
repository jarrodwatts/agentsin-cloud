// @effect-diagnostics globalTimersInEffect:off -- Pending relay requests have a bounded deadline and cleanup.
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { SandboxId, WorkspaceId } from "@t3tools/contracts/cloud";
import {
  WorkerRelayGitHubCommandDelivery,
  type WorkerGitHubCommand,
  type WorkerGitHubRouteBinding,
  type WorkerRelayGitHubCommandResult,
} from "@t3tools/contracts/worker";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ActiveWorkerLease } from "./workerIdentity.ts";
import type { WorkerRouteRegistry } from "./workerRelay.ts";

const encodeDelivery = Schema.encodeSync(Schema.fromJsonString(WorkerRelayGitHubCommandDelivery));

export interface GitHubWorkerTarget {
  readonly workspaceId: WorkspaceId;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly sandboxId: SandboxId;
}

export interface GitHubWorkerDispatcherLimits {
  readonly maxPendingGlobal: number;
  readonly maxPendingPerWorkspace: number;
  readonly maxPendingPerRoute: number;
  readonly maxPendingBytesGlobal: number;
  readonly maxPendingBytesPerWorkspace: number;
  readonly maxPendingBytesPerRoute: number;
  readonly maxOperationBytes: number;
  readonly maxTimeoutMs: number;
}

export const DEFAULT_GITHUB_WORKER_DISPATCHER_LIMITS: GitHubWorkerDispatcherLimits = {
  maxPendingGlobal: 2_048,
  maxPendingPerWorkspace: 128,
  maxPendingPerRoute: 64,
  maxPendingBytesGlobal: 4 * 1024 * 1024,
  maxPendingBytesPerWorkspace: 512 * 1024,
  maxPendingBytesPerRoute: 256 * 1024,
  maxOperationBytes: 64 * 1024,
  maxTimeoutMs: 60_000,
};

export class GitHubWorkerDispatchError extends Schema.TaggedErrorClass<GitHubWorkerDispatchError>()(
  "GitHubWorkerDispatchError",
  {
    code: Schema.Literals([
      "workerUnavailable",
      "identityMismatch",
      "capacityExceeded",
      "timeout",
      "workerRejected",
    ]),
    retryable: Schema.Boolean,
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {}

interface PendingOperation {
  readonly key: string;
  readonly routeKey: string;
  readonly workspaceKey: string;
  readonly target: GitHubWorkerTarget;
  readonly commandId: string;
  readonly bytes: number;
  readonly settle: (
    result: Effect.Effect<WorkerRelayGitHubCommandResult, GitHubWorkerDispatchError>,
  ) => void;
}

const matchesTarget = (identity: GitHubWorkerTarget, principal: ActiveWorkerLease) =>
  identity.workspaceId === principal.workspaceId &&
  identity.environmentId === principal.environmentId &&
  identity.threadId === principal.threadId &&
  identity.sandboxId === principal.sandboxId;

export const githubWorkerRouteBinding = (lease: ActiveWorkerLease): WorkerGitHubRouteBinding => ({
  workerId: lease.workerId,
  reservationId: lease.reservationId,
  environmentRevisionId: lease.environmentRevisionId,
  providerInstanceId: lease.providerInstanceId,
  providerDriver: lease.providerDriver,
  processInstanceId: lease.processInstanceId,
  certificateFingerprint: lease.certificateFingerprint,
  certificateGeneration: lease.certificateGeneration,
  leaseGeneration: lease.leaseGeneration,
  routeGeneration: lease.routeGeneration,
});

const sameRouteBinding = (left: ActiveWorkerLease, right: ActiveWorkerLease) =>
  left.environmentRevisionId === right.environmentRevisionId &&
  left.reservationId === right.reservationId &&
  left.workerId === right.workerId &&
  left.providerInstanceId === right.providerInstanceId &&
  left.providerDriver === right.providerDriver &&
  left.processInstanceId === right.processInstanceId &&
  left.certificateFingerprint === right.certificateFingerprint &&
  left.certificateGeneration === right.certificateGeneration &&
  left.leaseGeneration === right.leaseGeneration &&
  left.routeGeneration === right.routeGeneration &&
  matchesTarget(left, right);
const matchesCommandRoute = (command: WorkerGitHubCommand, lease: ActiveWorkerLease) =>
  command.type !== "github.git.push" ||
  (command.routeBinding.environmentRevisionId === lease.environmentRevisionId &&
    command.routeBinding.reservationId === lease.reservationId &&
    command.routeBinding.workerId === lease.workerId &&
    command.routeBinding.providerInstanceId === lease.providerInstanceId &&
    command.routeBinding.providerDriver === lease.providerDriver &&
    command.routeBinding.processInstanceId === lease.processInstanceId &&
    command.routeBinding.certificateFingerprint === lease.certificateFingerprint &&
    command.routeBinding.certificateGeneration === lease.certificateGeneration &&
    command.routeBinding.leaseGeneration === lease.leaseGeneration &&
    command.routeBinding.routeGeneration === lease.routeGeneration);

const routeKey = (lease: ActiveWorkerLease) =>
  JSON.stringify([
    lease.workspaceId,
    lease.environmentId,
    lease.threadId,
    lease.sandboxId,
    lease.environmentRevisionId,
    lease.reservationId,
    lease.workerId,
    lease.providerInstanceId,
    lease.providerDriver,
    lease.processInstanceId,
    lease.certificateFingerprint,
    lease.certificateGeneration,
    lease.leaseGeneration,
    lease.routeGeneration,
  ]);
const operationKey = (lease: ActiveWorkerLease, operationId: string) =>
  `${routeKey(lease)}\0${operationId}`;

export const makeGitHubWorkerDispatcher = (input: {
  readonly routes: WorkerRouteRegistry;
  readonly timeoutMs?: number;
  readonly limits?: Partial<GitHubWorkerDispatcherLimits>;
}) => {
  const pending = new Map<string, PendingOperation>();
  const workspaceCounts = new Map<string, number>();
  const workspaceBytes = new Map<string, number>();
  const routeCounts = new Map<string, number>();
  const routeBytes = new Map<string, number>();
  let totalBytes = 0;
  const limits = { ...DEFAULT_GITHUB_WORKER_DISPATCHER_LIMITS, ...input.limits };
  const timeoutMs = Math.min(
    Math.max(1, input.timeoutMs ?? limits.maxTimeoutMs),
    limits.maxTimeoutMs,
  );

  const adjust = (map: Map<string, number>, key: string, delta: number) => {
    const next = (map.get(key) ?? 0) + delta;
    if (next <= 0) map.delete(key);
    else map.set(key, next);
  };
  const release = (operation: PendingOperation) => {
    if (!pending.delete(operation.key)) return;
    totalBytes -= operation.bytes;
    adjust(workspaceCounts, operation.workspaceKey, -1);
    adjust(workspaceBytes, operation.workspaceKey, -operation.bytes);
    adjust(routeCounts, operation.routeKey, -1);
    adjust(routeBytes, operation.routeKey, -operation.bytes);
  };
  const failRoute = (removedRouteKey: string) => {
    for (const operation of pending.values()) {
      if (operation.routeKey !== removedRouteKey) continue;
      operation.settle(
        Effect.fail(new GitHubWorkerDispatchError({ code: "workerUnavailable", retryable: true })),
      );
    }
  };
  const unsubscribe = input.routes.subscribeRemoval(({ route }) =>
    failRoute(routeKey(route.lease)),
  );

  const dispatchToRoute = (
    target: GitHubWorkerTarget,
    selectedRoute: NonNullable<ReturnType<WorkerRouteRegistry["get"]>>,
    selectedLease: ActiveWorkerLease,
    command: WorkerGitHubCommand,
  ): Effect.Effect<WorkerRelayGitHubCommandResult, GitHubWorkerDispatchError> => {
    if (
      command.workspaceId !== target.workspaceId ||
      command.environmentId !== target.environmentId ||
      command.threadId !== target.threadId ||
      command.sandboxId !== target.sandboxId ||
      !matchesCommandRoute(command, selectedLease)
    ) {
      return Effect.fail(
        new GitHubWorkerDispatchError({ code: "identityMismatch", retryable: false }),
      );
    }
    return Effect.suspend(() => {
      const route = input.routes.get(target.workspaceId, target.sandboxId);
      if (
        route === undefined ||
        route !== selectedRoute ||
        route.lease.state !== "connected" ||
        !matchesTarget(target, route.lease) ||
        !sameRouteBinding(selectedLease, route.lease)
      ) {
        return Effect.fail(
          new GitHubWorkerDispatchError({ code: "workerUnavailable", retryable: true }),
        );
      }
      const key = operationKey(route.lease, command.operationId);
      const activeRouteKey = routeKey(route.lease);
      const workspaceKey = target.workspaceId;
      const bytes = Buffer.byteLength(encodeDelivery({ type: "github.command", command }));
      if (
        pending.has(key) ||
        bytes > limits.maxOperationBytes ||
        pending.size >= limits.maxPendingGlobal ||
        (workspaceCounts.get(workspaceKey) ?? 0) >= limits.maxPendingPerWorkspace ||
        (routeCounts.get(activeRouteKey) ?? 0) >= limits.maxPendingPerRoute ||
        totalBytes + bytes > limits.maxPendingBytesGlobal ||
        (workspaceBytes.get(workspaceKey) ?? 0) + bytes > limits.maxPendingBytesPerWorkspace ||
        (routeBytes.get(activeRouteKey) ?? 0) + bytes > limits.maxPendingBytesPerRoute
      ) {
        return Effect.fail(
          new GitHubWorkerDispatchError({ code: "capacityExceeded", retryable: true }),
        );
      }
      return Effect.callback<WorkerRelayGitHubCommandResult, GitHubWorkerDispatchError>(
        (resume) => {
          let settled = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const operation: PendingOperation = {
            key,
            routeKey: activeRouteKey,
            workspaceKey,
            target,
            commandId: command.commandId,
            bytes,
            settle: (result) => {
              if (settled) return;
              settled = true;
              if (timer !== undefined) clearTimeout(timer);
              release(operation);
              resume(result);
            },
          };
          pending.set(key, operation);
          totalBytes += bytes;
          adjust(workspaceCounts, workspaceKey, 1);
          adjust(workspaceBytes, workspaceKey, bytes);
          adjust(routeCounts, activeRouteKey, 1);
          adjust(routeBytes, activeRouteKey, bytes);
          timer = setTimeout(
            () =>
              operation.settle(
                Effect.fail(new GitHubWorkerDispatchError({ code: "timeout", retryable: true })),
              ),
            timeoutMs,
          );
          if (!route.send({ type: "github.command", command })) {
            operation.settle(
              Effect.fail(
                new GitHubWorkerDispatchError({ code: "workerUnavailable", retryable: true }),
              ),
            );
          }
          return Effect.sync(() => {
            if (settled) return;
            settled = true;
            if (timer !== undefined) clearTimeout(timer);
            release(operation);
          });
        },
      );
    });
  };

  const prepare = (
    target: GitHubWorkerTarget,
  ): Effect.Effect<
    {
      readonly lease: ActiveWorkerLease;
      readonly dispatch: (
        command: WorkerGitHubCommand,
      ) => Effect.Effect<WorkerRelayGitHubCommandResult, GitHubWorkerDispatchError>;
    },
    GitHubWorkerDispatchError
  > =>
    Effect.suspend(() => {
      const route = input.routes.get(target.workspaceId, target.sandboxId);
      if (
        route === undefined ||
        route.lease.state !== "connected" ||
        !matchesTarget(target, route.lease)
      ) {
        return Effect.fail(
          new GitHubWorkerDispatchError({ code: "workerUnavailable", retryable: true }),
        );
      }
      const lease = { ...route.lease } as ActiveWorkerLease;
      return Effect.succeed({
        lease,
        dispatch: (command) => dispatchToRoute(target, route, lease, command),
      });
    });

  const dispatch = (
    target: GitHubWorkerTarget,
    command: WorkerGitHubCommand,
  ): Effect.Effect<WorkerRelayGitHubCommandResult, GitHubWorkerDispatchError> =>
    prepare(target).pipe(Effect.flatMap((prepared) => prepared.dispatch(command)));

  const handleResult = (
    principal: ActiveWorkerLease,
    result: WorkerRelayGitHubCommandResult,
  ): Effect.Effect<void, GitHubWorkerDispatchError> => {
    const operation = pending.get(operationKey(principal, result.operationId));
    if (
      operation === undefined ||
      operation.commandId !== result.commandId ||
      !matchesTarget(operation.target, principal)
    ) {
      return Effect.fail(
        new GitHubWorkerDispatchError({ code: "identityMismatch", retryable: false }),
      );
    }
    operation.settle(
      result.status === "failed"
        ? Effect.fail(
            new GitHubWorkerDispatchError({
              code:
                result.code === "identityMismatch" ||
                result.code === "repositoryMismatch" ||
                result.code === "ambiguousIntent" ||
                result.code === "invalidHistory"
                  ? "identityMismatch"
                  : "workerRejected",
              retryable: result.retryable,
              cause: result,
            }),
          )
        : Effect.succeed(result),
    );
    return Effect.void;
  };

  const close = () => {
    unsubscribe();
    for (const operation of pending.values()) {
      operation.settle(
        Effect.fail(new GitHubWorkerDispatchError({ code: "workerUnavailable", retryable: true })),
      );
    }
  };

  return {
    dispatch,
    prepare,
    handleResult,
    close,
    pendingCount: () => pending.size,
    pendingBytes: () => totalBytes,
  } as const;
};

export type GitHubWorkerDispatcher = ReturnType<typeof makeGitHubWorkerDispatcher>;
