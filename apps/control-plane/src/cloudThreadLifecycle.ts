// @effect-diagnostics nodeBuiltinImport:off -- Durable lifecycle request fingerprints use audited SHA-256.
import * as NodeCrypto from "node:crypto";

import type {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type {
  EnvironmentRevision,
  EnvironmentRevisionId,
  SandboxProvider,
  SandboxProviderError,
  SandboxProviderSandbox,
  WorkspaceId,
} from "@t3tools/contracts/cloud";
import {
  WorkerBootstrap,
  type WorkerDeliveryId,
  type WorkerInstanceId,
  type WorkerRelayCommandDelivery,
} from "@t3tools/contracts/worker";
import type { SandboxIdentityRecord } from "@t3tools/e2b-sandbox";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type {
  CloudThreadLifecycleAttempt,
  CloudThreadLifecycleState,
  CloudThreadLifecycleStore,
  ReserveCloudThreadLifecycleInput,
} from "./cloudThreadLifecycleStore.ts";
import { CloudThreadLifecycleStoreError } from "./cloudThreadLifecycleStore.ts";
import type {
  ReplayThreadEventsWindow,
  ThreadEventStoreError,
  ThreadEventStoreService,
} from "./threadEventStore.ts";
import type { WorkspaceRepositoryError, WorkspaceRepositoryService } from "./workspaces.ts";

export interface CreateCloudThreadInput {
  readonly requestId: CommandId;
  readonly idempotencyKey: string;
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly environmentRevisionId: EnvironmentRevisionId;
  readonly projectId: ProjectId;
  readonly providerInstanceId: ProviderInstanceId;
}

export interface CloudThreadLifecycleView {
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly environmentRevisionId: EnvironmentRevisionId;
  readonly state: CloudThreadLifecycleState;
  readonly sandboxId?: SandboxProviderSandbox["sandboxId"];
  readonly workerId?: WorkerInstanceId;
  readonly failureCode?: string;
  readonly replayCursor: number;
}

export interface ConnectedCloudThread extends CloudThreadLifecycleView {
  readonly connection: {
    readonly transport: "http" | "ssh" | "websocket";
    readonly endpoint: string;
    readonly credentialRef?: string;
    readonly expiresAt?: string;
  };
  readonly replay: ReplayThreadEventsWindow;
}

declare const WorkerConnectionContextTypeId: unique symbol;

/** Opaque capability created only after B4 authenticates the direct WSS/mTLS transport. */
export interface WorkerConnectionContext {
  readonly [WorkerConnectionContextTypeId]: "WorkerConnectionContext";
}

export interface WorkerReconnectClaim {
  readonly connection: WorkerConnectionContext;
  readonly afterSequence: number;
}

export interface WorkerReconnectReplay {
  readonly commands: ReadonlyArray<WorkerRelayCommandDelivery>;
  readonly replay: ReplayThreadEventsWindow;
}

export class CloudThreadLifecycleError extends Schema.TaggedErrorClass<CloudThreadLifecycleError>()(
  "CloudThreadLifecycleError",
  {
    code: Schema.Literals([
      "unauthorized",
      "notFound",
      "conflict",
      "invalidEnvironment",
      "notReady",
      "staleWorker",
      "dependencyFailure",
      "databaseFailure",
    ]),
    retryable: Schema.Boolean,
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {}

export class CloudThreadLifecycleDependencyError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly outcome: "confirmed" | "uncertain";

  constructor(options: {
    readonly code: string;
    readonly retryable: boolean;
    readonly outcome: "confirmed" | "uncertain";
  }) {
    super(options.code);
    this.name = "CloudThreadLifecycleDependencyError";
    this.code = options.code;
    this.retryable = options.retryable;
    this.outcome = options.outcome;
  }
}

export interface EnvironmentRevisionRepository {
  readonly get: (
    workspaceId: WorkspaceId,
    revisionId: EnvironmentRevisionId,
  ) => Effect.Effect<EnvironmentRevision | undefined, CloudThreadLifecycleDependencyError>;
}

export interface WorkerBootstrapIssue {
  readonly bootstrap: WorkerBootstrap;
  readonly sealedBootstrapRef: string;
}

export interface WorkerBootstrapIssuer {
  /** Idempotent for one attemptId. Raw provider credentials and wallet material are forbidden. */
  readonly issue: (input: {
    readonly attemptId: string;
    readonly workspaceId: WorkspaceId;
    readonly environmentId: EnvironmentId;
    readonly environmentRevisionId: EnvironmentRevisionId;
    readonly threadId: ThreadId;
    readonly sandboxId: SandboxProviderSandbox["sandboxId"];
    readonly providerInstanceId: ProviderInstanceId;
    readonly providerDriver: CloudThreadLifecycleAttempt["providerDriver"];
    readonly workspaceDirectory: string;
  }) => Effect.Effect<WorkerBootstrapIssue, CloudThreadLifecycleDependencyError>;
}

export interface WorkerConnectionGateway {
  /** Idempotent for one workerId; the sandbox receives only the sealed reference. */
  readonly start: (input: {
    readonly workspaceId: WorkspaceId;
    readonly threadId: ThreadId;
    readonly sandboxId: SandboxProviderSandbox["sandboxId"];
    readonly workerId: WorkerInstanceId;
    readonly sealedBootstrapRef: string;
  }) => Effect.Effect<void, CloudThreadLifecycleDependencyError>;
  readonly inspect: (input: {
    readonly workspaceId: WorkspaceId;
    readonly threadId: ThreadId;
    readonly sandboxId: SandboxProviderSandbox["sandboxId"];
    readonly workerId: WorkerInstanceId;
  }) => Effect.Effect<"running" | "absent" | "unknown", CloudThreadLifecycleDependencyError>;
  /**
   * B4 maps an already-authenticated WSS/mTLS channel to its server-created principal. Callers must
   * not derive authority from the bootstrap file or any client-supplied identity fields.
   */
  readonly authorizeReconnect: (
    connection: WorkerConnectionContext,
  ) => Effect.Effect<VerifiedWorkerPrincipal, CloudThreadLifecycleDependencyError>;
}

/** C3 invokes this only after it has selected the current sandbox for replacement cleanup. */
export interface WorkerRouteLifecycle {
  readonly fenceSandboxForReplacement: (input: {
    readonly workspaceId: WorkspaceId;
    readonly threadId: ThreadId;
    readonly sandboxId: SandboxProviderSandbox["sandboxId"];
    readonly reason: string;
  }) => Effect.Effect<void, CloudThreadLifecycleDependencyError>;
}

export interface VerifiedWorkerPrincipal {
  /** Lifecycle attempt ID. Each replacement worker gets a new immutable generation. */
  readonly generation: string;
  readonly workspaceId: WorkspaceId;
  readonly environmentId: EnvironmentId;
  readonly environmentRevisionId: EnvironmentRevisionId;
  readonly threadId: ThreadId;
  readonly sandboxId: SandboxProviderSandbox["sandboxId"];
  readonly workerId: WorkerInstanceId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerDriver: CloudThreadLifecycleAttempt["providerDriver"];
}

export interface SandboxReservationInspector {
  readonly inspect: (
    workspaceId: WorkspaceId,
    reservationId: CommandId,
  ) => Promise<
    | {
        readonly state: "reserved" | "active" | "cleanup_required" | "failed" | "destroyed";
        readonly identity?: SandboxIdentityRecord;
      }
    | undefined
  >;
}

export interface CloudThreadLifecycleClock {
  readonly now: () => Date;
}

export interface CloudThreadLifecycleDependencies {
  readonly workspaces: WorkspaceRepositoryService;
  readonly threadEvents: ThreadEventStoreService;
  readonly lifecycle: CloudThreadLifecycleStore;
  readonly revisions: EnvironmentRevisionRepository;
  readonly sandbox: SandboxProvider;
  readonly reservations: SandboxReservationInspector;
  readonly bootstrapIssuer: WorkerBootstrapIssuer;
  readonly workerGateway: WorkerConnectionGateway;
  readonly workerRoutes: WorkerRouteLifecycle;
  readonly clock: CloudThreadLifecycleClock;
  readonly stepLeaseMs?: number;
}

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

const decodeWorkerBootstrap = Schema.decodeUnknownEffect(WorkerBootstrap);

const fingerprint = (input: unknown) =>
  NodeCrypto.createHash("sha256").update(canonicalJson(input)).digest("hex");

const iso = (date: Date) => date.toISOString();
const addMillisecondsIso = (date: Date, milliseconds: number) =>
  DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(date), { milliseconds }));

const recoveredSandbox = (
  attempt: CloudThreadLifecycleAttempt,
  identity: SandboxIdentityRecord,
  updatedAt: string,
): SandboxProviderSandbox => ({
  sandboxId: identity.sandboxId,
  workspaceId: attempt.workspaceId,
  environmentId: attempt.environmentId,
  infrastructureProvider: "e2b",
  workspace: {
    workspaceId: attempt.workspaceId,
    projectId: attempt.projectId,
    threadId: attempt.threadId,
    repositoryIdentity: attempt.repositoryIdentity,
    workspaceDirectory: attempt.workspaceDirectory,
  },
  binding: {
    workspaceId: attempt.workspaceId,
    threadId: attempt.threadId,
    sandboxId: identity.sandboxId,
  },
  revisionId: attempt.environmentRevisionId,
  providerHandle: identity.providerHandle,
  state: "ready",
  createdAt: identity.createdAt,
  updatedAt,
});

const storeFailure = (cause: unknown) =>
  cause instanceof CloudThreadLifecycleStoreError
    ? new CloudThreadLifecycleError({
        code:
          cause.code === "conflict"
            ? "conflict"
            : cause.code === "notFound"
              ? "notFound"
              : "databaseFailure",
        retryable: cause.code === "databaseFailure",
        cause,
      })
    : new CloudThreadLifecycleError({ code: "databaseFailure", retryable: true, cause });

const storeEffect = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: storeFailure });

const mapWorkspaceFailure = (cause: WorkspaceRepositoryError) =>
  new CloudThreadLifecycleError({ code: "databaseFailure", retryable: true, cause });
const mapThreadStoreFailure = (cause: ThreadEventStoreError) =>
  new CloudThreadLifecycleError({
    code:
      cause.code === "notFound" || cause.code === "tenantMismatch"
        ? "notFound"
        : cause.code === "environmentMismatch" || cause.code === "idempotencyConflict"
          ? "conflict"
          : "databaseFailure",
    retryable: cause.code === "databaseFailure" || cause.code === "replayGap",
    cause,
  });

const lifecycleView = (
  attempt: CloudThreadLifecycleAttempt,
  replayCursor = -1,
): CloudThreadLifecycleView => ({
  threadId: attempt.threadId,
  environmentId: attempt.environmentId,
  environmentRevisionId: attempt.environmentRevisionId,
  state: attempt.state,
  ...(attempt.sandboxId === undefined ? {} : { sandboxId: attempt.sandboxId }),
  ...(attempt.workerId === undefined ? {} : { workerId: attempt.workerId }),
  ...(attempt.failureCode === undefined ? {} : { failureCode: attempt.failureCode }),
  replayCursor,
});

const providerFailureRequiresCleanup = (failure: SandboxProviderError) =>
  failure.code.includes("ORPHAN") || failure.code.includes("RECONCILIATION");

const validateBootstrap = (
  issue: WorkerBootstrapIssue,
  attempt: CloudThreadLifecycleAttempt,
): Effect.Effect<WorkerBootstrapIssue, CloudThreadLifecycleError> =>
  decodeWorkerBootstrap(issue.bootstrap).pipe(
    Effect.mapError(
      (cause) =>
        new CloudThreadLifecycleError({
          code: "dependencyFailure",
          retryable: false,
          cause,
        }),
    ),
    Effect.flatMap((bootstrap) =>
      bootstrap.workspaceId !== attempt.workspaceId ||
      bootstrap.environmentId !== attempt.environmentId ||
      bootstrap.environmentRevisionId !== attempt.environmentRevisionId ||
      bootstrap.threadId !== attempt.threadId ||
      bootstrap.sandboxId !== attempt.sandboxId ||
      bootstrap.provider.instanceId !== attempt.providerInstanceId ||
      bootstrap.provider.driver !== attempt.providerDriver ||
      bootstrap.workspaceDirectory !== attempt.workspaceDirectory ||
      issue.sealedBootstrapRef.trim().length === 0
        ? Effect.fail(
            new CloudThreadLifecycleError({
              code: "dependencyFailure",
              retryable: false,
              cause: "Worker bootstrap identity did not match the durable lifecycle attempt",
            }),
          )
        : Effect.succeed({ ...issue, bootstrap }),
    ),
  );

export const makeCloudThreadLifecycle = (dependencies: CloudThreadLifecycleDependencies) => {
  const stepLeaseMs = dependencies.stepLeaseMs ?? 30_000;

  const workspaceForUser = (userId: string) =>
    dependencies.workspaces.findForUser(userId).pipe(
      Effect.mapError(mapWorkspaceFailure),
      Effect.flatMap((workspace) =>
        workspace === undefined
          ? Effect.fail(
              new CloudThreadLifecycleError({
                code: "unauthorized",
                retryable: false,
              }),
            )
          : Effect.succeed(workspace.id as WorkspaceId),
      ),
    );

  const compensate = Effect.fn("CloudThreadLifecycle.compensate")(function* (
    attempt: CloudThreadLifecycleAttempt,
    errorCode: string,
  ) {
    const now = iso(dependencies.clock.now());
    if (attempt.sandboxId === undefined) {
      return yield* storeEffect(() => dependencies.lifecycle.markFailed(attempt, now, errorCode));
    }
    const fenced = yield* Effect.result(
      dependencies.workerRoutes.fenceSandboxForReplacement({
        workspaceId: attempt.workspaceId,
        threadId: attempt.threadId,
        sandboxId: attempt.sandboxId,
        reason: `compensate:${errorCode}`,
      }),
    );
    if (Result.isFailure(fenced)) {
      return yield* storeEffect(() =>
        dependencies.lifecycle.markCleanupRequired(
          attempt,
          now,
          `${errorCode}:worker-fence-uncertain`,
        ),
      );
    }
    const destroyed = yield* Effect.result(
      dependencies.sandbox.destroy({
        type: "destroy",
        requestId: `${attempt.attemptId}:compensate` as CommandId,
        workspaceId: attempt.workspaceId,
        environmentId: attempt.environmentId,
        sandboxId: attempt.sandboxId,
        requestedAt: now,
      }),
    );
    return Result.isSuccess(destroyed)
      ? yield* storeEffect(() => dependencies.lifecycle.markFailed(attempt, now, errorCode))
      : yield* storeEffect(() =>
          dependencies.lifecycle.markCleanupRequired(
            attempt,
            now,
            `${errorCode}:sandbox-cleanup-uncertain`,
          ),
        );
  });

  const reconcileCreateFailure = Effect.fn("CloudThreadLifecycle.reconcileCreateFailure")(
    function* (attempt: CloudThreadLifecycleAttempt, failure: SandboxProviderError) {
      const now = iso(dependencies.clock.now());
      if (providerFailureRequiresCleanup(failure)) {
        return yield* storeEffect(() =>
          dependencies.lifecycle.markCleanupRequired(attempt, now, failure.code),
        );
      }
      const reservation = yield* storeEffect(() =>
        dependencies.reservations.inspect(attempt.workspaceId, attempt.attemptId as CommandId),
      );
      if (reservation?.state === "active" && reservation.identity !== undefined) {
        const connected = yield* Effect.result(
          dependencies.sandbox.connect({
            type: "connect",
            requestId: `${attempt.attemptId}:recover-create` as CommandId,
            workspaceId: attempt.workspaceId,
            environmentId: attempt.environmentId,
            sandboxId: reservation.identity.sandboxId,
            requestedAt: now,
          }),
        );
        if (Result.isSuccess(connected)) {
          return yield* storeEffect(() =>
            dependencies.lifecycle.recordSandbox(
              attempt,
              recoveredSandbox(attempt, reservation.identity!, now),
              now,
            ),
          );
        }
        return yield* storeEffect(() =>
          dependencies.lifecycle.markCleanupRequired(
            attempt,
            now,
            `${failure.code}:active-sandbox-unreachable`,
          ),
        );
      }
      if (reservation?.state === "reserved" || reservation?.state === "cleanup_required") {
        return yield* storeEffect(() =>
          dependencies.lifecycle.markCleanupRequired(attempt, now, failure.code),
        );
      }
      return yield* storeEffect(() =>
        dependencies.lifecycle.markFailed(attempt, now, failure.code),
      );
    },
  );

  const advance = Effect.fn("CloudThreadLifecycle.advance")(function* (
    initial: CloudThreadLifecycleAttempt,
    revision: EnvironmentRevision,
  ) {
    let attempt = initial;
    for (let transitions = 0; transitions < 3; transitions += 1) {
      const nowDate = dependencies.clock.now();
      const now = iso(nowDate);
      const leaseExpiresAt = addMillisecondsIso(nowDate, stepLeaseMs);
      if (attempt.state === "reserved") {
        const claimed = yield* storeEffect(() =>
          dependencies.lifecycle.claim(
            attempt,
            "create_sandbox",
            "reserved",
            "create_dispatched",
            now,
            leaseExpiresAt,
          ),
        );
        if (!claimed) return attempt;
        attempt = (yield* storeEffect(() =>
          dependencies.lifecycle.getAttempt(attempt.workspaceId, attempt.attemptId),
        ))!;
        const created = yield* Effect.result(
          dependencies.sandbox.create({
            type: "create",
            requestId: attempt.attemptId as CommandId,
            workspaceId: attempt.workspaceId,
            environmentId: attempt.environmentId,
            workspace: {
              workspaceId: attempt.workspaceId,
              projectId: attempt.projectId,
              threadId: attempt.threadId,
              repositoryIdentity: attempt.repositoryIdentity,
              workspaceDirectory: attempt.workspaceDirectory,
            },
            revision,
            requestedAt: now,
          }),
        );
        if (Result.isFailure(created)) {
          return yield* reconcileCreateFailure(attempt, created.failure);
        }
        attempt = yield* storeEffect(() =>
          dependencies.lifecycle.recordSandbox(attempt, created.success.sandbox, now),
        );
        continue;
      }
      if (attempt.state === "sandbox_ready") {
        const claimed = yield* storeEffect(() =>
          dependencies.lifecycle.claim(
            attempt,
            "issue_bootstrap",
            "sandbox_ready",
            "bootstrap_dispatched",
            now,
            leaseExpiresAt,
          ),
        );
        if (!claimed) return attempt;
        attempt = (yield* storeEffect(() =>
          dependencies.lifecycle.getAttempt(attempt.workspaceId, attempt.attemptId),
        ))!;
        const issue = yield* Effect.result(
          dependencies.bootstrapIssuer
            .issue({
              attemptId: attempt.attemptId,
              workspaceId: attempt.workspaceId,
              environmentId: attempt.environmentId,
              environmentRevisionId: attempt.environmentRevisionId,
              threadId: attempt.threadId,
              sandboxId: attempt.sandboxId!,
              providerInstanceId: attempt.providerInstanceId,
              providerDriver: attempt.providerDriver,
              workspaceDirectory: attempt.workspaceDirectory,
            })
            .pipe(Effect.flatMap((value) => validateBootstrap(value, attempt))),
        );
        if (Result.isFailure(issue)) {
          const failure = issue.failure;
          if (failure instanceof CloudThreadLifecycleDependencyError && failure.retryable) {
            return yield* storeEffect(() =>
              dependencies.lifecycle.resetStep(
                attempt,
                "issue_bootstrap",
                "sandbox_ready",
                now,
                failure.code,
              ),
            );
          }
          return yield* compensate(
            attempt,
            failure instanceof CloudThreadLifecycleDependencyError
              ? failure.code
              : "worker-bootstrap-invalid",
          );
        }
        attempt = yield* storeEffect(() =>
          dependencies.lifecycle.recordBootstrap(
            attempt,
            issue.success.bootstrap.workerId,
            issue.success.sealedBootstrapRef,
            now,
          ),
        );
        continue;
      }
      if (attempt.state === "bootstrap_ready") {
        const claimed = yield* storeEffect(() =>
          dependencies.lifecycle.claim(
            attempt,
            "start_worker",
            "bootstrap_ready",
            "worker_start_dispatched",
            now,
            leaseExpiresAt,
          ),
        );
        if (!claimed) return attempt;
        attempt = (yield* storeEffect(() =>
          dependencies.lifecycle.getAttempt(attempt.workspaceId, attempt.attemptId),
        ))!;
        const started = yield* Effect.result(
          dependencies.workerGateway.start({
            workspaceId: attempt.workspaceId,
            threadId: attempt.threadId,
            sandboxId: attempt.sandboxId!,
            workerId: attempt.workerId!,
            sealedBootstrapRef: attempt.sealedBootstrapRef!,
          }),
        );
        if (Result.isFailure(started)) {
          if (started.failure.outcome === "uncertain") return attempt;
          if (started.failure.retryable) {
            return yield* storeEffect(() =>
              dependencies.lifecycle.resetStep(
                attempt,
                "start_worker",
                "bootstrap_ready",
                now,
                started.failure.code,
              ),
            );
          }
          return yield* compensate(attempt, started.failure.code);
        }
        attempt = yield* storeEffect(() => dependencies.lifecycle.markReady(attempt, now));
        continue;
      }
      return attempt;
    }
    return attempt;
  });

  const createThread = (userId: string, input: CreateCloudThreadInput) =>
    Effect.gen(function* () {
      const workspaceId = yield* workspaceForUser(userId);
      const revision = yield* dependencies.revisions
        .get(workspaceId, input.environmentRevisionId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new CloudThreadLifecycleError({
                code: "dependencyFailure",
                retryable: cause.retryable,
                cause,
              }),
          ),
        );
      if (
        revision === undefined ||
        revision.workspaceId !== workspaceId ||
        revision.revisionId !== input.environmentRevisionId ||
        revision.buildStatus !== "ready" ||
        revision.blueprint.repositoryIdentity === undefined
      ) {
        return yield* new CloudThreadLifecycleError({
          code: "invalidEnvironment",
          retryable: false,
        });
      }
      const provider = revision.blueprint.providerInstances.find(
        (candidate) => candidate.instanceId === input.providerInstanceId,
      );
      if (provider === undefined) {
        return yield* new CloudThreadLifecycleError({
          code: "invalidEnvironment",
          retryable: false,
        });
      }
      yield* dependencies.threadEvents
        .createThread({
          workspaceId,
          threadId: input.threadId,
          environmentId: input.environmentId,
        })
        .pipe(Effect.mapError(mapThreadStoreFailure));
      const createdAt = iso(dependencies.clock.now());
      const reservation: ReserveCloudThreadLifecycleInput = {
        workspaceId,
        threadId: input.threadId,
        attemptId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint({
          threadId: input.threadId,
          environmentId: input.environmentId,
          revisionId: revision.revisionId,
          revisionHash: revision.contentHash,
          projectId: input.projectId,
          providerInstanceId: provider.instanceId,
          providerDriver: provider.driver,
        }),
        environmentId: input.environmentId,
        environmentRevisionId: revision.revisionId,
        environmentRevisionHash: revision.contentHash,
        projectId: input.projectId,
        providerInstanceId: provider.instanceId,
        providerDriver: provider.driver,
        repositoryIdentity: revision.blueprint.repositoryIdentity,
        workspaceDirectory: revision.blueprint.workspaceDirectory,
        createdAt,
      };
      const reserved = yield* storeEffect(() => dependencies.lifecycle.reserve(reservation));
      const advanced = yield* advance(reserved.attempt, revision);
      return lifecycleView(advanced);
    });

  const connectThread = (userId: string, threadId: ThreadId, afterSequence: number) =>
    Effect.gen(function* () {
      const workspaceId = yield* workspaceForUser(userId);
      const attempt = yield* storeEffect(() =>
        dependencies.lifecycle.getCurrent(workspaceId, threadId),
      );
      if (attempt === undefined) {
        return yield* new CloudThreadLifecycleError({ code: "notFound", retryable: false });
      }
      if (
        attempt.state !== "ready" ||
        attempt.sandboxId === undefined ||
        attempt.workerId === undefined
      ) {
        return yield* new CloudThreadLifecycleError({ code: "notReady", retryable: true });
      }
      const [connected, replay] = yield* Effect.all([
        dependencies.sandbox
          .connect({
            type: "connect",
            requestId: `${attempt.attemptId}:desktop-connect` as CommandId,
            workspaceId,
            environmentId: attempt.environmentId,
            sandboxId: attempt.sandboxId,
            requestedAt: iso(dependencies.clock.now()),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new CloudThreadLifecycleError({
                  code: "dependencyFailure",
                  retryable: cause.retryable,
                  cause,
                }),
            ),
          ),
        dependencies.threadEvents
          .replayAfter(workspaceId, threadId, afterSequence, 256)
          .pipe(Effect.mapError(mapThreadStoreFailure)),
      ]);
      return {
        ...lifecycleView(attempt, replay.nextSequence - 1),
        connection: connected.connection,
        replay,
      } satisfies ConnectedCloudThread;
    });

  const reconnectWorker = (claim: WorkerReconnectClaim) =>
    Effect.gen(function* () {
      const principal = yield* dependencies.workerGateway
        .authorizeReconnect(claim.connection)
        .pipe(
          Effect.mapError(
            (cause) =>
              new CloudThreadLifecycleError({ code: "unauthorized", retryable: false, cause }),
          ),
        );
      const attempt = yield* storeEffect(() =>
        dependencies.lifecycle.getCurrent(principal.workspaceId, principal.threadId),
      );
      if (
        attempt === undefined ||
        attempt.state !== "ready" ||
        principal.generation !== attempt.attemptId ||
        principal.workspaceId !== attempt.workspaceId ||
        principal.environmentId !== attempt.environmentId ||
        principal.environmentRevisionId !== attempt.environmentRevisionId ||
        principal.threadId !== attempt.threadId ||
        principal.sandboxId !== attempt.sandboxId ||
        principal.workerId !== attempt.workerId ||
        principal.providerInstanceId !== attempt.providerInstanceId ||
        principal.providerDriver !== attempt.providerDriver
      ) {
        return yield* new CloudThreadLifecycleError({ code: "staleWorker", retryable: false });
      }
      const [pending, replay] = yield* Effect.all([
        dependencies.threadEvents
          .listPendingThreadCommands(attempt.workspaceId, attempt.threadId, 256)
          .pipe(Effect.mapError(mapThreadStoreFailure)),
        dependencies.threadEvents
          .replayAfter(attempt.workspaceId, attempt.threadId, claim.afterSequence, 256)
          .pipe(Effect.mapError(mapThreadStoreFailure)),
      ]);
      return {
        commands: pending.map(
          ({ outboxId, command }): WorkerRelayCommandDelivery => ({
            type: "thread.command",
            deliveryId: outboxId as WorkerDeliveryId,
            redelivered: true,
            command,
          }),
        ),
        replay,
      } satisfies WorkerReconnectReplay;
    });

  const recoverPending = (limit = 25) =>
    Effect.gen(function* () {
      const now = iso(dependencies.clock.now());
      const attempts = yield* storeEffect(() => dependencies.lifecycle.listRecoverable(now, limit));
      let recovered = 0;
      for (const initial of attempts) {
        let attempt = initial;
        if (attempt.state === "create_dispatched") {
          const reservation = yield* storeEffect(() =>
            dependencies.reservations.inspect(attempt.workspaceId, attempt.attemptId as CommandId),
          );
          if (reservation === undefined) {
            attempt = yield* storeEffect(() =>
              dependencies.lifecycle.resetStep(
                attempt,
                "create_sandbox",
                "reserved",
                now,
                "create-not-dispatched",
              ),
            );
          } else if (reservation.state === "active" && reservation.identity !== undefined) {
            const connected = yield* Effect.result(
              dependencies.sandbox.connect({
                type: "connect",
                requestId: `${attempt.attemptId}:recover` as CommandId,
                workspaceId: attempt.workspaceId,
                environmentId: attempt.environmentId,
                sandboxId: reservation.identity.sandboxId,
                requestedAt: now,
              }),
            );
            if (Result.isSuccess(connected)) {
              attempt = yield* storeEffect(() =>
                dependencies.lifecycle.recordSandbox(
                  attempt,
                  recoveredSandbox(attempt, reservation.identity!, now),
                  now,
                ),
              );
            } else {
              continue;
            }
          } else if (reservation.state === "reserved" || reservation.state === "cleanup_required") {
            yield* storeEffect(() =>
              dependencies.lifecycle.markCleanupRequired(
                attempt,
                now,
                "remote-create-cleanup-uncertain",
              ),
            );
            recovered += 1;
            continue;
          } else {
            yield* storeEffect(() =>
              dependencies.lifecycle.markFailed(attempt, now, "remote-create-failed"),
            );
            recovered += 1;
            continue;
          }
        } else if (attempt.state === "bootstrap_dispatched") {
          attempt = yield* storeEffect(() =>
            dependencies.lifecycle.resetStep(
              attempt,
              "issue_bootstrap",
              "sandbox_ready",
              now,
              "bootstrap-retry",
            ),
          );
        } else if (attempt.state === "worker_start_dispatched") {
          const status = yield* dependencies.workerGateway.inspect({
            workspaceId: attempt.workspaceId,
            threadId: attempt.threadId,
            sandboxId: attempt.sandboxId!,
            workerId: attempt.workerId!,
          });
          if (status === "running") {
            yield* storeEffect(() => dependencies.lifecycle.markReady(attempt, now));
            recovered += 1;
            continue;
          }
          if (status === "unknown") continue;
          attempt = yield* storeEffect(() =>
            dependencies.lifecycle.resetStep(
              attempt,
              "start_worker",
              "bootstrap_ready",
              now,
              "worker-absent",
            ),
          );
        }
        const revision = yield* dependencies.revisions.get(
          attempt.workspaceId,
          attempt.environmentRevisionId,
        );
        if (
          revision === undefined ||
          revision.contentHash !== attempt.environmentRevisionHash ||
          revision.revisionId !== attempt.environmentRevisionId
        ) {
          yield* storeEffect(() =>
            dependencies.lifecycle.markCleanupRequired(
              attempt,
              now,
              "immutable-environment-mismatch",
            ),
          );
          recovered += 1;
          continue;
        }
        const advanced = yield* advance(attempt, revision);
        if (advanced.state !== initial.state) recovered += 1;
      }
      return recovered;
    });

  return { createThread, connectThread, reconnectWorker, recoverPending };
};
