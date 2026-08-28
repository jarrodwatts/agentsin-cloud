import type { CommandId } from "@t3tools/contracts";
import type {
  SandboxProvider,
  SandboxProviderError,
  SandboxProviderSandbox,
} from "@t3tools/contracts/cloud";
import { WorkerBootstrap, type WorkerInstanceId } from "@t3tools/contracts/worker";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  CloudThreadLifecycleDependencyError,
  type WorkerBootstrapIssue,
  type WorkerConnectionGateway,
  type WorkerRouteLifecycle,
} from "./cloudThreadLifecycle.ts";
import {
  CloudThreadRuntimeStoreError,
  type CloudThreadActivityEvent,
  type CloudThreadContainmentOutcome,
  type CloudThreadContainmentStep,
  type CloudThreadResumeEvent,
  type CloudThreadResumeRequest,
  type CloudThreadRuntimeRecord,
  type CloudThreadRuntimeStore,
} from "./cloudThreadRuntimeStore.ts";

export interface RuntimeWorkerBootstrapIssuer {
  /** Idempotent for issuanceId while retaining the original E2B reservation identity. */
  readonly issue: (input: {
    readonly issuanceId: string;
    readonly reservationId: CommandId;
    readonly workspaceId: CloudThreadRuntimeRecord["workspaceId"];
    readonly environmentId: CloudThreadRuntimeRecord["environmentId"];
    readonly environmentRevisionId: CloudThreadRuntimeRecord["environmentRevisionId"];
    readonly threadId: CloudThreadRuntimeRecord["threadId"];
    readonly sandboxId: CloudThreadRuntimeRecord["sandboxId"];
    readonly providerInstanceId: CloudThreadRuntimeRecord["providerInstanceId"];
    readonly providerDriver: CloudThreadRuntimeRecord["providerDriver"];
  }) => Effect.Effect<WorkerBootstrapIssue, CloudThreadLifecycleDependencyError>;
}

export interface WorkerCredentialLifecycle {
  /**
   * Removes sandbox-local provider/GitHub/plugin material before pause through the trusted E2B
   * control path. This must not depend on the worker route, which has already been fenced.
   */
  readonly scrubForPause: (input: {
    readonly workspaceId: CloudThreadRuntimeRecord["workspaceId"];
    readonly threadId: CloudThreadRuntimeRecord["threadId"];
    readonly sandboxId: CloudThreadRuntimeRecord["sandboxId"];
    readonly workerId: WorkerInstanceId;
    readonly transitionId: string;
  }) => Effect.Effect<void, CloudThreadLifecycleDependencyError>;
}

export interface CentralCredentialRevoker {
  /**
   * Revokes broker grants and credential material outside the sandbox. This operation is
   * idempotent for transitionId and must not depend on the worker route or sandbox process.
   */
  readonly revokeForContainment: (input: {
    readonly workspaceId: CloudThreadRuntimeRecord["workspaceId"];
    readonly threadId: CloudThreadRuntimeRecord["threadId"];
    readonly sandboxId: CloudThreadRuntimeRecord["sandboxId"];
    readonly workerId: WorkerInstanceId;
    readonly transitionId: string;
  }) => Effect.Effect<void, CloudThreadLifecycleDependencyError>;
}

export interface RuntimeWorkerRecovery {
  /** Completes only after B4 has authenticated the new worker and replayed durable thread state. */
  readonly confirmRecovered: (input: {
    readonly workspaceId: CloudThreadRuntimeRecord["workspaceId"];
    readonly threadId: CloudThreadRuntimeRecord["threadId"];
    readonly sandboxId: CloudThreadRuntimeRecord["sandboxId"];
    readonly workerId: WorkerInstanceId;
    readonly generation: number;
  }) => Effect.Effect<void, CloudThreadLifecycleDependencyError>;
}

export type CloudThreadActivitySignal =
  | {
      readonly type: "started";
      readonly workspaceId: CloudThreadRuntimeRecord["workspaceId"];
      readonly threadId: CloudThreadRuntimeRecord["threadId"];
      readonly attemptId: string;
      readonly eventId: string;
      readonly activityId: string;
      readonly source: "agent" | "preview";
      readonly generation: number;
      readonly leaseMs: number;
    }
  | {
      readonly type: "heartbeat";
      readonly workspaceId: CloudThreadRuntimeRecord["workspaceId"];
      readonly threadId: CloudThreadRuntimeRecord["threadId"];
      readonly attemptId: string;
      readonly eventId: string;
      readonly activityId: string;
      readonly generation: number;
      readonly leaseMs: number;
    }
  | {
      readonly type: "ended";
      readonly workspaceId: CloudThreadRuntimeRecord["workspaceId"];
      readonly threadId: CloudThreadRuntimeRecord["threadId"];
      readonly attemptId: string;
      readonly eventId: string;
      readonly activityId: string;
      readonly generation: number;
    };

export interface CloudThreadRuntimeClock {
  readonly now: () => Date;
}

export interface CloudThreadRuntimeDependencies {
  readonly store: CloudThreadRuntimeStore;
  readonly sandbox: SandboxProvider;
  readonly bootstrapIssuer: RuntimeWorkerBootstrapIssuer;
  readonly workerGateway: WorkerConnectionGateway;
  readonly workerRecovery: RuntimeWorkerRecovery;
  readonly workerRoutes: WorkerRouteLifecycle;
  readonly centralCredentialRevoker: CentralCredentialRevoker;
  readonly workerCredentials: WorkerCredentialLifecycle;
  readonly clock: CloudThreadRuntimeClock;
}

export class CloudThreadRuntimeError extends Schema.TaggedErrorClass<CloudThreadRuntimeError>()(
  "CloudThreadRuntimeError",
  {
    code: Schema.Literals([
      "notFound",
      "conflict",
      "staleGeneration",
      "dependencyFailure",
      "databaseFailure",
      "reconciliationRequired",
    ]),
    retryable: Schema.Boolean,
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {}
const isCloudThreadRuntimeError = Schema.is(CloudThreadRuntimeError);

export interface CloudThreadRuntimeSweepResult {
  readonly claimed: number;
  readonly completed: number;
  readonly pending: number;
  readonly reconciliationRequired: number;
}

const iso = (date: Date) => date.toISOString();
const MAX_ACTIVITY_LEASE_MS = 5 * 60_000;
const decodeBootstrap = Schema.decodeUnknownEffect(WorkerBootstrap);

const storeFailure = (cause: unknown) =>
  cause instanceof CloudThreadRuntimeStoreError
    ? new CloudThreadRuntimeError({
        code:
          cause.code === "notFound"
            ? "notFound"
            : cause.code === "staleGeneration"
              ? "staleGeneration"
              : cause.code === "conflict"
                ? "conflict"
                : "databaseFailure",
        retryable: cause.code === "databaseFailure",
        cause,
      })
    : new CloudThreadRuntimeError({ code: "databaseFailure", retryable: true, cause });

const storeEffect = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: storeFailure });

const dependencyFailure = (cause: unknown, retryable: boolean) =>
  new CloudThreadRuntimeError({ code: "dependencyFailure", retryable, cause });

const reconcile = (
  dependencies: CloudThreadRuntimeDependencies,
  runtime: CloudThreadRuntimeRecord,
  code: string,
) =>
  storeEffect(() =>
    dependencies.store.markReconciliationRequired(runtime, code, iso(dependencies.clock.now())),
  ).pipe(
    Effect.andThen(
      Effect.fail(
        new CloudThreadRuntimeError({
          code: "reconciliationRequired",
          retryable: false,
          cause: code,
        }),
      ),
    ),
  );

const handleDependencyFailure = (
  dependencies: CloudThreadRuntimeDependencies,
  runtime: CloudThreadRuntimeRecord,
  failure: CloudThreadLifecycleDependencyError,
) =>
  failure.retryable || failure.outcome === "uncertain"
    ? Effect.fail(dependencyFailure(failure, true))
    : reconcile(dependencies, runtime, failure.code);

const handleProviderFailure = (
  dependencies: CloudThreadRuntimeDependencies,
  runtime: CloudThreadRuntimeRecord,
  failure: SandboxProviderError,
) =>
  failure.retryable
    ? Effect.fail(dependencyFailure(failure, true))
    : reconcile(dependencies, runtime, failure.code);

const validateSandbox = (
  runtime: CloudThreadRuntimeRecord,
  sandbox: SandboxProviderSandbox,
  expectedState: "ready" | "suspended",
) =>
  sandbox.workspaceId === runtime.workspaceId &&
  sandbox.environmentId === runtime.environmentId &&
  sandbox.workspace.threadId === runtime.threadId &&
  sandbox.binding.workspaceId === runtime.workspaceId &&
  sandbox.binding.threadId === runtime.threadId &&
  sandbox.sandboxId === runtime.sandboxId &&
  sandbox.binding.sandboxId === runtime.sandboxId &&
  sandbox.revisionId === runtime.environmentRevisionId &&
  sandbox.infrastructureProvider === "e2b" &&
  sandbox.state === expectedState;

const validateResumeBootstrap = (
  runtime: CloudThreadRuntimeRecord,
  issue: WorkerBootstrapIssue,
): Effect.Effect<WorkerBootstrapIssue, CloudThreadRuntimeError> =>
  decodeBootstrap(issue.bootstrap).pipe(
    Effect.mapError((cause) => dependencyFailure(cause, false)),
    Effect.flatMap((bootstrap) =>
      bootstrap.workerId === runtime.workerId ||
      bootstrap.workspaceId !== runtime.workspaceId ||
      bootstrap.environmentId !== runtime.environmentId ||
      bootstrap.environmentRevisionId !== runtime.environmentRevisionId ||
      bootstrap.threadId !== runtime.threadId ||
      bootstrap.sandboxId !== runtime.sandboxId ||
      bootstrap.reservationId !== runtime.attemptId ||
      bootstrap.provider.instanceId !== runtime.providerInstanceId ||
      bootstrap.provider.driver !== runtime.providerDriver ||
      issue.sealedBootstrapRef.trim().length === 0
        ? Effect.fail(
            dependencyFailure("Resume bootstrap did not match its durable E2B runtime", false),
          )
        : Effect.succeed({ ...issue, bootstrap }),
    ),
  );

export const makeCloudThreadRuntime = (dependencies: CloudThreadRuntimeDependencies) => {
  const processResume = Effect.fn("CloudThreadRuntime.processResume")(function* (
    initial: CloudThreadRuntimeRecord,
    recovery: boolean,
  ) {
    let runtime = initial;
    if (runtime.state === "resume_dispatched") {
      const resumed = yield* Effect.result(
        dependencies.sandbox.resume({
          type: "resume",
          requestId: `${runtime.transitionId}:provider` as CommandId,
          workspaceId: runtime.workspaceId,
          environmentId: runtime.environmentId,
          sandboxId: runtime.sandboxId,
          requestedAt: runtime.transitionStartedAt!,
        }),
      );
      if (Result.isFailure(resumed)) {
        return yield* handleProviderFailure(dependencies, runtime, resumed.failure);
      }
      if (!validateSandbox(runtime, resumed.success.sandbox, "ready")) {
        return yield* reconcile(dependencies, runtime, "resume-identity-mismatch");
      }
      runtime = yield* storeEffect(() =>
        dependencies.store.markProviderResumed(runtime, resumed.success.completedAt),
      );
    }

    if (runtime.state === "resume_bootstrap_dispatched") {
      const issued = yield* Effect.result(
        dependencies.bootstrapIssuer
          .issue({
            issuanceId: runtime.transitionId!,
            reservationId: runtime.attemptId as CommandId,
            workspaceId: runtime.workspaceId,
            environmentId: runtime.environmentId,
            environmentRevisionId: runtime.environmentRevisionId,
            threadId: runtime.threadId,
            sandboxId: runtime.sandboxId,
            providerInstanceId: runtime.providerInstanceId,
            providerDriver: runtime.providerDriver,
          })
          .pipe(Effect.flatMap((value) => validateResumeBootstrap(runtime, value))),
      );
      if (Result.isFailure(issued)) {
        const failure = issued.failure;
        if (failure instanceof CloudThreadLifecycleDependencyError) {
          return yield* handleDependencyFailure(dependencies, runtime, failure);
        }
        return yield* reconcile(dependencies, runtime, "resume-bootstrap-invalid");
      }
      runtime = yield* storeEffect(() =>
        dependencies.store.recordResumeBootstrap(
          runtime,
          issued.success.bootstrap.workerId,
          issued.success.sealedBootstrapRef,
          iso(dependencies.clock.now()),
        ),
      );
    }

    if (runtime.state === "resume_worker_start_dispatched") {
      if (recovery) {
        const inspected = yield* Effect.result(
          dependencies.workerGateway.inspect({
            workspaceId: runtime.workspaceId,
            threadId: runtime.threadId,
            sandboxId: runtime.sandboxId,
            workerId: runtime.workerId,
          }),
        );
        if (Result.isFailure(inspected)) {
          return yield* handleDependencyFailure(dependencies, runtime, inspected.failure);
        }
        if (inspected.success === "running") {
          const recovered = yield* Effect.result(
            dependencies.workerRecovery.confirmRecovered({
              workspaceId: runtime.workspaceId,
              threadId: runtime.threadId,
              sandboxId: runtime.sandboxId,
              workerId: runtime.workerId,
              generation: runtime.generation,
            }),
          );
          if (Result.isFailure(recovered)) {
            return yield* handleDependencyFailure(dependencies, runtime, recovered.failure);
          }
          return yield* storeEffect(() =>
            dependencies.store.markRunning(runtime, iso(dependencies.clock.now())),
          );
        }
        if (inspected.success === "unknown") return runtime;
      }

      const started = yield* Effect.result(
        dependencies.workerGateway.start({
          workspaceId: runtime.workspaceId,
          environmentId: runtime.environmentId,
          threadId: runtime.threadId,
          sandboxId: runtime.sandboxId,
          workerId: runtime.workerId,
          sealedBootstrapRef: runtime.sealedBootstrapRef,
        }),
      );
      if (Result.isFailure(started)) {
        return yield* handleDependencyFailure(dependencies, runtime, started.failure);
      }
      const recovered = yield* Effect.result(
        dependencies.workerRecovery.confirmRecovered({
          workspaceId: runtime.workspaceId,
          threadId: runtime.threadId,
          sandboxId: runtime.sandboxId,
          workerId: runtime.workerId,
          generation: runtime.generation,
        }),
      );
      if (Result.isFailure(recovered)) {
        return yield* handleDependencyFailure(dependencies, runtime, recovered.failure);
      }
      runtime = yield* storeEffect(() =>
        dependencies.store.markRunning(runtime, iso(dependencies.clock.now())),
      );
    }
    return runtime;
  });

  const processPause = Effect.fn("CloudThreadRuntime.processPause")(function* (
    initial: CloudThreadRuntimeRecord,
  ) {
    let runtime = initial;
    if (
      runtime.transitionKind !== "pause" ||
      (runtime.state !== "pause_dispatched" && runtime.state !== "reconciliation_required")
    ) {
      return runtime;
    }
    const failures: Array<{
      readonly step: CloudThreadContainmentStep;
      readonly code: string;
      readonly retryable: boolean;
      readonly cause: unknown;
    }> = [];
    const recordOutcome = (
      step: CloudThreadContainmentStep,
      outcome: CloudThreadContainmentOutcome,
      errorCode: string | undefined,
      occurredAt = iso(dependencies.clock.now()),
    ) =>
      storeEffect(() =>
        dependencies.store.recordContainmentOutcome(runtime, step, outcome, errorCode, occurredAt),
      );
    const dependencyOutcome = (failure: CloudThreadLifecycleDependencyError) =>
      failure.outcome === "uncertain"
        ? ("uncertain_failure" as const)
        : failure.retryable
          ? ("retryable_failure" as const)
          : ("confirmed_failure" as const);

    if (runtime.credentialsRevokedAt === undefined) {
      const revoked = yield* Effect.result(
        dependencies.centralCredentialRevoker.revokeForContainment({
          workspaceId: runtime.workspaceId,
          threadId: runtime.threadId,
          sandboxId: runtime.sandboxId,
          workerId: runtime.workerId,
          transitionId: runtime.transitionId!,
        }),
      );
      if (Result.isFailure(revoked)) {
        runtime = yield* recordOutcome(
          "credential_revoke",
          dependencyOutcome(revoked.failure),
          revoked.failure.code,
        );
        failures.push({
          step: "credential_revoke",
          code: revoked.failure.code,
          retryable: revoked.failure.retryable || revoked.failure.outcome === "uncertain",
          cause: revoked.failure,
        });
      } else {
        runtime = yield* recordOutcome("credential_revoke", "succeeded", undefined);
      }
    }

    if (runtime.routeFencedAt === undefined) {
      const fenced = yield* Effect.result(
        dependencies.workerRoutes.fenceSandboxForReplacement({
          workspaceId: runtime.workspaceId,
          threadId: runtime.threadId,
          sandboxId: runtime.sandboxId,
          reason: `idle-pause:${runtime.transitionId}`,
        }),
      );
      if (Result.isFailure(fenced)) {
        runtime = yield* recordOutcome(
          "route_fence",
          dependencyOutcome(fenced.failure),
          fenced.failure.code,
        );
        failures.push({
          step: "route_fence",
          code: fenced.failure.code,
          retryable: fenced.failure.retryable || fenced.failure.outcome === "uncertain",
          cause: fenced.failure,
        });
      } else {
        runtime = yield* recordOutcome("route_fence", "succeeded", undefined);
      }
    }

    if (runtime.credentialsScrubbedAt === undefined && runtime.sandboxDestroyedAt === undefined) {
      const scrubbed = yield* Effect.result(
        dependencies.workerCredentials.scrubForPause({
          workspaceId: runtime.workspaceId,
          threadId: runtime.threadId,
          sandboxId: runtime.sandboxId,
          workerId: runtime.workerId,
          transitionId: runtime.transitionId!,
        }),
      );
      if (Result.isFailure(scrubbed)) {
        runtime = yield* recordOutcome(
          "credential_scrub",
          dependencyOutcome(scrubbed.failure),
          scrubbed.failure.code,
        );
        failures.push({
          step: "credential_scrub",
          code: scrubbed.failure.code,
          retryable: scrubbed.failure.retryable || scrubbed.failure.outcome === "uncertain",
          cause: scrubbed.failure,
        });
      } else {
        runtime = yield* recordOutcome("credential_scrub", "succeeded", undefined);
      }
    }

    let forceDestroy =
      runtime.credentialsScrubbedAt === undefined && runtime.sandboxDestroyedAt === undefined;
    if (
      runtime.providerCompletedAt === undefined &&
      runtime.sandboxDestroyedAt === undefined &&
      !forceDestroy
    ) {
      const paused = yield* Effect.result(
        dependencies.sandbox.pause({
          type: "pause",
          requestId: `${runtime.transitionId}:provider-pause` as CommandId,
          workspaceId: runtime.workspaceId,
          environmentId: runtime.environmentId,
          sandboxId: runtime.sandboxId,
          requestedAt: runtime.transitionStartedAt!,
        }),
      );
      if (Result.isFailure(paused)) {
        const outcome = paused.failure.retryable ? "retryable_failure" : "confirmed_failure";
        runtime = yield* recordOutcome("provider_pause", outcome, paused.failure.code);
        failures.push({
          step: "provider_pause",
          code: paused.failure.code,
          retryable: paused.failure.retryable,
          cause: paused.failure,
        });
        forceDestroy = !paused.failure.retryable;
      } else if (!validateSandbox(runtime, paused.success.sandbox, "suspended")) {
        runtime = yield* recordOutcome(
          "provider_pause",
          "confirmed_failure",
          "pause-identity-mismatch",
        );
        failures.push({
          step: "provider_pause",
          code: "pause-identity-mismatch",
          retryable: false,
          cause: "pause-identity-mismatch",
        });
        forceDestroy = true;
      } else {
        runtime = yield* recordOutcome(
          "provider_pause",
          "succeeded",
          undefined,
          paused.success.completedAt,
        );
      }
    }

    if (forceDestroy && runtime.sandboxDestroyedAt === undefined) {
      const destroyed = yield* Effect.result(
        dependencies.sandbox.destroy({
          type: "destroy",
          requestId: `${runtime.transitionId}:provider-destroy` as CommandId,
          workspaceId: runtime.workspaceId,
          environmentId: runtime.environmentId,
          sandboxId: runtime.sandboxId,
          requestedAt: runtime.transitionStartedAt!,
        }),
      );
      if (Result.isFailure(destroyed)) {
        runtime = yield* recordOutcome(
          "provider_destroy",
          destroyed.failure.retryable ? "retryable_failure" : "confirmed_failure",
          destroyed.failure.code,
        );
        failures.push({
          step: "provider_destroy",
          code: destroyed.failure.code,
          retryable: destroyed.failure.retryable,
          cause: destroyed.failure,
        });
      } else if (
        destroyed.success.workspaceId !== runtime.workspaceId ||
        destroyed.success.environmentId !== runtime.environmentId ||
        destroyed.success.sandboxId !== runtime.sandboxId
      ) {
        runtime = yield* recordOutcome(
          "provider_destroy",
          "confirmed_failure",
          "destroy-identity-mismatch",
        );
        failures.push({
          step: "provider_destroy",
          code: "destroy-identity-mismatch",
          retryable: false,
          cause: "destroy-identity-mismatch",
        });
      } else {
        runtime = yield* recordOutcome(
          "provider_destroy",
          "succeeded",
          undefined,
          destroyed.success.completedAt,
        );
      }
    }

    if (
      runtime.routeFencedAt !== undefined &&
      runtime.credentialsRevokedAt !== undefined &&
      runtime.credentialsScrubbedAt !== undefined &&
      runtime.providerCompletedAt !== undefined &&
      runtime.sandboxDestroyedAt === undefined
    ) {
      runtime = yield* storeEffect(() =>
        dependencies.store.markPaused(runtime, iso(dependencies.clock.now())),
      );
      const pending = yield* storeEffect(() =>
        dependencies.store.claimPendingResume(runtime, iso(dependencies.clock.now())),
      );
      return pending === undefined ? runtime : yield* processResume(pending, false);
    }

    if (
      runtime.routeFencedAt !== undefined &&
      runtime.credentialsRevokedAt !== undefined &&
      runtime.sandboxDestroyedAt !== undefined
    ) {
      return yield* storeEffect(() =>
        dependencies.store.markReconciliationRequired(
          runtime,
          "sandbox-destroyed-for-containment",
          iso(dependencies.clock.now()),
        ),
      );
    }

    const confirmed = failures.find((failure) => !failure.retryable);
    if (confirmed !== undefined) {
      return yield* storeEffect(() =>
        dependencies.store.markReconciliationRequired(
          runtime,
          `${confirmed.step}:${confirmed.code}`,
          iso(dependencies.clock.now()),
        ),
      );
    }
    const retryable = failures[0];
    return retryable === undefined ? runtime : yield* dependencyFailure(retryable.cause, true);
  });

  const summarize = (results: ReadonlyArray<Result.Result<CloudThreadRuntimeRecord, unknown>>) => ({
    completed: results.filter(
      (result) =>
        Result.isSuccess(result) &&
        (result.success.state === "paused" || result.success.state === "running"),
    ).length,
    pending: results.filter(
      (result) =>
        (Result.isFailure(result) &&
          !(
            isCloudThreadRuntimeError(result.failure) &&
            result.failure.code === "reconciliationRequired"
          )) ||
        (Result.isSuccess(result) &&
          result.success.state !== "paused" &&
          result.success.state !== "running" &&
          result.success.state !== "reconciliation_required"),
    ).length,
    reconciliationRequired: results.filter(
      (result) =>
        (Result.isSuccess(result) && result.success.state === "reconciliation_required") ||
        (Result.isFailure(result) &&
          isCloudThreadRuntimeError(result.failure) &&
          result.failure.code === "reconciliationRequired"),
    ).length,
  });

  const recordActivity = (signal: CloudThreadActivitySignal) =>
    Effect.gen(function* () {
      if (
        signal.type !== "ended" &&
        (!Number.isSafeInteger(signal.leaseMs) ||
          signal.leaseMs <= 0 ||
          signal.leaseMs > MAX_ACTIVITY_LEASE_MS)
      ) {
        return yield* new CloudThreadRuntimeError({
          code: "conflict",
          retryable: false,
          cause: "Activity lease must be between one millisecond and five minutes",
        });
      }
      const now = dependencies.clock.now();
      const event: CloudThreadActivityEvent =
        signal.type === "ended"
          ? { ...signal, occurredAt: iso(now) }
          : {
              ...signal,
              occurredAt: iso(now),
              expiresAt: DateTime.formatIso(
                DateTime.add(DateTime.makeUnsafe(now), { milliseconds: signal.leaseMs }),
              ),
            };
      return yield* storeEffect(() => dependencies.store.recordActivity(event));
    });

  const requestResume = (request: CloudThreadResumeRequest) =>
    Effect.gen(function* () {
      const event: CloudThreadResumeEvent = {
        ...request,
        requestedAt: iso(dependencies.clock.now()),
      };
      const claim = yield* storeEffect(() => dependencies.store.requestResume(event));
      if (claim.disposition === "claimed" || claim.disposition === "joined") {
        const runtime = yield* processResume(claim.runtime, claim.disposition === "joined");
        return { ...claim, runtime };
      }
      return claim;
    });

  const pauseIdle = (limit = 25) =>
    Effect.gen(function* () {
      const claims = yield* storeEffect(() =>
        dependencies.store.claimIdlePauses(iso(dependencies.clock.now()), undefined, limit),
      );
      const results = yield* Effect.forEach(
        claims,
        (runtime) => Effect.result(processPause(runtime)),
        {
          concurrency: 3,
        },
      );
      return {
        claimed: claims.length,
        ...summarize(results),
      } satisfies CloudThreadRuntimeSweepResult;
    });

  const recoverPending = (limit = 25) =>
    Effect.gen(function* () {
      const recoverable = yield* storeEffect(() => dependencies.store.listRecoverable(limit));
      const results = yield* Effect.forEach(
        recoverable,
        (runtime) =>
          Effect.result(
            runtime.transitionKind === "pause"
              ? processPause(runtime)
              : processResume(runtime, true),
          ),
        { concurrency: 3 },
      );
      return {
        claimed: recoverable.length,
        ...summarize(results),
      } satisfies CloudThreadRuntimeSweepResult;
    });

  return { recordActivity, requestResume, pauseIdle, recoverPending };
};
