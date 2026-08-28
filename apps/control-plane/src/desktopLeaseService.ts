// @effect-diagnostics nodeBuiltinImport:off -- Opaque resume proofs use audited HMAC/SHA-256 at the service boundary.
import * as NodeCrypto from "node:crypto";

import {
  type DesktopAuthorityCommand,
  type DesktopControlBinding,
  type DesktopControlClientFrame,
  type DesktopControllerState,
  type DesktopInputPermit,
  type DesktopLeaseIdempotencyKey,
  type DesktopLeaseResumeToken,
} from "@t3tools/contracts/desktop-lease";
import type { DesktopLeaseId } from "@t3tools/contracts/cloud";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  DesktopLeaseRepositoryError,
  type DesktopLeaseActor,
  type DesktopLeaseRecord,
  type DesktopLeaseRepository,
} from "./desktopLeaseRepository.ts";
import type { ActiveWorkerRoute, WorkerRouteRegistry } from "./workerRelay.ts";

export interface DesktopControlPrincipal extends DesktopLeaseActor {
  readonly binding: DesktopControlBinding;
}

export interface DesktopControlResult {
  readonly state: DesktopControllerState;
  readonly resumeToken?: DesktopLeaseResumeToken;
}

export interface DesktopLeaseService {
  readonly current: (
    principal: DesktopControlPrincipal,
  ) => Effect.Effect<DesktopControlResult, DesktopLeaseServiceError>;
  readonly acquire: (
    principal: DesktopControlPrincipal,
    idempotencyKey: DesktopLeaseIdempotencyKey,
  ) => Effect.Effect<DesktopControlResult, DesktopLeaseServiceError>;
  readonly heartbeat: (
    principal: DesktopControlPrincipal,
    input: Extract<DesktopControlClientFrame, { readonly type: "desktop.control.heartbeat" }>,
  ) => Effect.Effect<DesktopControlResult, DesktopLeaseServiceError>;
  readonly release: (
    principal: DesktopControlPrincipal,
    input: Extract<DesktopControlClientFrame, { readonly type: "desktop.control.release" }>,
  ) => Effect.Effect<DesktopControlResult, DesktopLeaseServiceError>;
  readonly resume: (
    principal: DesktopControlPrincipal,
    input: Extract<DesktopControlClientFrame, { readonly type: "desktop.control.resume" }>,
  ) => Effect.Effect<DesktopControlResult, DesktopLeaseServiceError>;
  readonly disconnect: (
    principal: DesktopControlPrincipal,
  ) => Effect.Effect<void, DesktopLeaseServiceError>;
  readonly authorizeAndDispatchInput: (
    principal: DesktopControlPrincipal,
    dispatch: (permit: DesktopInputPermit) => boolean,
  ) => Effect.Effect<void, DesktopLeaseServiceError>;
  readonly authorizeAgentInput: (
    binding: DesktopControlBinding,
  ) => Effect.Effect<void, DesktopLeaseServiceError>;
  readonly synchronizeRoute: (
    route: ActiveWorkerRoute,
  ) => Effect.Effect<void, DesktopLeaseServiceError>;
  readonly revokeBinding: (
    binding: DesktopControlBinding,
    reason: string,
  ) => Effect.Effect<void, DesktopLeaseServiceError>;
  readonly revokeCurrent: (input: {
    readonly workspaceId: DesktopControlBinding["workspaceId"];
    readonly threadId: DesktopControlBinding["threadId"];
    readonly sandboxId?: DesktopControlBinding["sandboxId"];
    readonly reason: string;
  }) => Effect.Effect<void, DesktopLeaseServiceError>;
  readonly sweepExpired: Effect.Effect<number, DesktopLeaseServiceError>;
  readonly purgeRetention: Effect.Effect<number, DesktopLeaseServiceError>;
}

export class DesktopLeaseServiceError extends Schema.TaggedErrorClass<DesktopLeaseServiceError>()(
  "DesktopLeaseServiceError",
  {
    code: Schema.Literals([
      "conflict",
      "forbidden",
      "notFound",
      "staleBinding",
      "expired",
      "routeUnavailable",
      "databaseFailure",
    ]),
    retryable: Schema.Boolean,
    operation: Schema.String,
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {}

const isDesktopLeaseServiceError = Schema.is(DesktopLeaseServiceError);

export interface DesktopLeaseServiceOptions {
  readonly repository: DesktopLeaseRepository;
  readonly routes: WorkerRouteRegistry;
  readonly tokenSecret: string;
  readonly now?: () => number;
  readonly nextLeaseId?: () => DesktopLeaseId;
  readonly ttlMs?: number;
  readonly disconnectGraceMs?: number;
  readonly sweepLimit?: number;
  readonly retentionMs?: number;
  readonly retentionLimit?: number;
}

const DEFAULT_TTL_MS = 45_000;
const DEFAULT_DISCONNECT_GRACE_MS = 10_000;
const DEFAULT_SWEEP_LIMIT = 100;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_RETENTION_LIMIT = 500;

const routeMatchesBinding = (route: ActiveWorkerRoute, binding: DesktopControlBinding) =>
  route.lease.workspaceId === binding.workspaceId &&
  route.lease.threadId === binding.threadId &&
  route.lease.reservationId === binding.attemptId &&
  route.lease.environmentId === binding.environmentId &&
  route.lease.environmentRevisionId === binding.environmentRevisionId &&
  route.lease.sandboxId === binding.sandboxId &&
  route.lease.workerId === binding.workerId &&
  route.lease.routeGeneration === binding.routeGeneration;

export const desktopBindingForRoute = (route: ActiveWorkerRoute): DesktopControlBinding => ({
  workspaceId: route.lease.workspaceId,
  threadId: route.lease.threadId,
  attemptId: route.lease.reservationId,
  environmentId: route.lease.environmentId,
  environmentRevisionId: route.lease.environmentRevisionId,
  sandboxId: route.lease.sandboxId,
  workerId: route.lease.workerId,
  routeGeneration: route.lease.routeGeneration,
});

const authorityRevisionForUser = (lease: DesktopLeaseRecord) =>
  (lease.generation * 2 - 1) as DesktopAuthorityCommand["authorityRevision"];
const authorityRevisionForAgent = (lease: DesktopLeaseRecord) =>
  (lease.generation * 2) as DesktopAuthorityCommand["authorityRevision"];

const mapRepositoryError = (operation: string, cause: unknown) => {
  const error =
    cause instanceof DesktopLeaseRepositoryError
      ? cause
      : new DesktopLeaseRepositoryError("databaseFailure", "Desktop lease repository failed", {
          cause,
        });
  return new DesktopLeaseServiceError({
    code: error.code === "transportRejected" ? "routeUnavailable" : error.code,
    retryable: error.code === "databaseFailure" || error.code === "transportRejected",
    operation,
    cause: error,
  });
};

const validateLimits = (input: {
  readonly ttlMs: number;
  readonly disconnectGraceMs: number;
  readonly sweepLimit: number;
  readonly retentionMs: number;
  readonly retentionLimit: number;
}) => {
  if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 5_000 || input.ttlMs > 300_000) {
    throw new RangeError("desktop lease ttlMs is outside the supported range");
  }
  if (
    !Number.isSafeInteger(input.disconnectGraceMs) ||
    input.disconnectGraceMs < 1_000 ||
    input.disconnectGraceMs > input.ttlMs
  ) {
    throw new RangeError("desktop lease disconnectGraceMs is outside the supported range");
  }
  if (!Number.isSafeInteger(input.sweepLimit) || input.sweepLimit < 1 || input.sweepLimit > 1_000) {
    throw new RangeError("desktop lease sweepLimit is outside the supported range");
  }
  if (
    !Number.isSafeInteger(input.retentionMs) ||
    input.retentionMs < 86_400_000 ||
    input.retentionMs > 365 * 86_400_000
  ) {
    throw new RangeError("desktop lease retentionMs is outside the supported range");
  }
  if (
    !Number.isSafeInteger(input.retentionLimit) ||
    input.retentionLimit < 1 ||
    input.retentionLimit > 10_000
  ) {
    throw new RangeError("desktop lease retentionLimit is outside the supported range");
  }
};

export const makeDesktopLeaseService = (
  options: DesktopLeaseServiceOptions,
): DesktopLeaseService => {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const disconnectGraceMs = options.disconnectGraceMs ?? DEFAULT_DISCONNECT_GRACE_MS;
  const sweepLimit = options.sweepLimit ?? DEFAULT_SWEEP_LIMIT;
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const retentionLimit = options.retentionLimit ?? DEFAULT_RETENTION_LIMIT;
  validateLimits({ ttlMs, disconnectGraceMs, sweepLimit, retentionMs, retentionLimit });
  if (Buffer.byteLength(options.tokenSecret) < 32) {
    throw new RangeError("desktop lease token secret must contain at least 32 bytes");
  }
  const now = options.now ?? (() => DateTime.toEpochMillis(DateTime.nowUnsafe()));
  const nextLeaseId = options.nextLeaseId ?? (() => NodeCrypto.randomUUID() as DesktopLeaseId);
  const tails = new Map<string, Promise<void>>();
  const threadKey = (binding: DesktopControlBinding) =>
    `${binding.workspaceId}\0${binding.threadId}`;
  const isoNow = () => DateTime.formatIso(DateTime.makeUnsafe(now()));
  const after = (milliseconds: number) =>
    DateTime.formatIso(DateTime.makeUnsafe(now() + milliseconds));
  const tokenFor = (lease: Pick<DesktopLeaseRecord, "leaseId" | "actor">) =>
    NodeCrypto.createHmac("sha256", options.tokenSecret)
      .update("agents-in-cloud/desktop-lease/acquire/v2\0")
      .update(lease.leaseId)
      .update("\0")
      .update(lease.actor.userId)
      .update("\0")
      .update(lease.actor.authSessionId)
      .update("\0")
      .update(lease.actor.clientId)
      .digest("base64url") as DesktopLeaseResumeToken;
  const rotatedTokenFor = (input: {
    readonly leaseId: DesktopLeaseId;
    readonly generation: DesktopInputPermit["generation"];
    readonly actor: DesktopLeaseActor;
    readonly idempotencyKey: DesktopLeaseIdempotencyKey;
  }) =>
    NodeCrypto.createHmac("sha256", options.tokenSecret)
      .update("agents-in-cloud/desktop-lease/resume/v2\0")
      .update(input.leaseId)
      .update("\0")
      .update(String(input.generation))
      .update("\0")
      .update(input.actor.userId)
      .update("\0")
      .update(input.actor.authSessionId)
      .update("\0")
      .update(input.idempotencyKey)
      .digest("base64url") as DesktopLeaseResumeToken;
  const tokenHash = (token: string) => NodeCrypto.createHash("sha256").update(token).digest("hex");

  const serialize = <A>(
    binding: DesktopControlBinding,
    operation: string,
    task: () => Effect.Effect<A, DesktopLeaseServiceError>,
  ): Effect.Effect<A, DesktopLeaseServiceError> =>
    Effect.tryPromise<A, DesktopLeaseServiceError>({
      try: async () => {
        const key = threadKey(binding);
        const previous = tails.get(key) ?? Promise.resolve();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const queued = previous.catch(() => undefined).then(() => gate);
        tails.set(key, queued);
        await previous.catch(() => undefined);
        try {
          return await Effect.runPromise(task());
        } finally {
          release();
          if (tails.get(key) === queued) tails.delete(key);
        }
      },
      catch: (cause) =>
        isDesktopLeaseServiceError(cause)
          ? cause
          : new DesktopLeaseServiceError({
              code: "databaseFailure",
              retryable: true,
              operation,
              cause,
            }),
    });

  const routeFor = (binding: DesktopControlBinding) => {
    const route = options.routes.get(binding.workspaceId, binding.sandboxId);
    if (route === undefined || !routeMatchesBinding(route, binding)) {
      return Effect.fail(
        new DesktopLeaseServiceError({
          code: "routeUnavailable",
          retryable: true,
          operation: "resolve-desktop-route",
        }),
      );
    }
    return Effect.succeed(route);
  };

  const userAuthority = (lease: DesktopLeaseRecord): DesktopAuthorityCommand => ({
    type: "desktop.authority",
    controller: "user",
    authorityRevision: authorityRevisionForUser(lease),
    leaseId: lease.leaseId,
    generation: lease.generation,
    binding: lease.binding,
    expiresAt: lease.expiresAt,
  });
  const agentAuthority = (lease: DesktopLeaseRecord): DesktopAuthorityCommand => ({
    type: "desktop.authority",
    controller: "agent",
    authorityRevision: authorityRevisionForAgent(lease),
    binding: lease.binding,
  });

  const sendAuthority = (
    command: DesktopAuthorityCommand,
  ): Effect.Effect<void, DesktopLeaseServiceError> =>
    Effect.gen(function* () {
      const route = yield* routeFor(command.binding);
      if (!route.send(command)) {
        return yield* new DesktopLeaseServiceError({
          code: "routeUnavailable",
          retryable: true,
          operation: "send-desktop-authority",
        });
      }
    });

  const expireDueAuthority = (binding: DesktopControlBinding) =>
    Effect.gen(function* () {
      const lease = yield* repository("expire-desktop-lease", () =>
        options.repository.expireCurrent({ binding, now: isoNow() }),
      );
      if (lease?.state === "expired") yield* sendAuthority(agentAuthority(lease));
      return lease;
    });

  const publicState = (
    lease: DesktopLeaseRecord | undefined,
    principal: Pick<DesktopControlPrincipal, "userId" | "authSessionId" | "clientId">,
    observedAt: string,
  ): DesktopControllerState => {
    if (lease === undefined || lease.state !== "active") {
      return { controller: "agent", observedAt };
    }
    const publicLease = {
      leaseId: lease.leaseId,
      generation: lease.generation,
      binding: lease.binding,
      expiresAt: lease.expiresAt,
    };
    if (lease.connectionState === "disconnected") {
      return {
        controller: "disconnected",
        lease: publicLease,
        resumableByCurrentSession:
          lease.actor.userId === principal.userId &&
          lease.actor.authSessionId === principal.authSessionId,
        observedAt,
      };
    }
    return {
      controller: "user",
      lease: publicLease,
      heldByCurrentClient:
        lease.actor.userId === principal.userId &&
        lease.actor.authSessionId === principal.authSessionId &&
        lease.actor.clientId === principal.clientId,
      observedAt,
    };
  };

  const repository = <A>(operation: string, effect: () => Promise<A>) =>
    Effect.tryPromise({ try: effect, catch: (cause) => mapRepositoryError(operation, cause) });

  const current: DesktopLeaseService["current"] = (principal) =>
    serialize(principal.binding, "current-desktop-lease", () =>
      Effect.gen(function* () {
        const lease = yield* repository("current-desktop-lease", () =>
          options.repository.current({
            workspaceId: principal.binding.workspaceId,
            threadId: principal.binding.threadId,
            now: isoNow(),
          }),
        );
        const currentLease =
          lease !== undefined && lease.expiresAt <= isoNow()
            ? yield* expireDueAuthority(lease.binding)
            : lease;
        return {
          state: publicState(
            currentLease?.state === "active" ? currentLease : undefined,
            principal,
            isoNow(),
          ),
        };
      }),
    );

  const acquire: DesktopLeaseService["acquire"] = (principal, idempotencyKey) =>
    serialize(principal.binding, "acquire-desktop-lease", () =>
      Effect.gen(function* () {
        yield* routeFor(principal.binding);
        const leaseId = nextLeaseId();
        const token = tokenFor({ leaseId, actor: principal });
        const result = yield* repository("acquire-desktop-lease", () =>
          options.repository.acquire({
            binding: principal.binding,
            actor: principal,
            leaseId,
            resumeSecretHash: tokenHash(token),
            idempotencyKey,
            now: isoNow(),
            expiresAt: after(ttlMs),
          }),
        );
        yield* routeFor(result.lease.binding);
        if (result.disposition === "applied") yield* sendAuthority(userAuthority(result.lease));
        const resumeToken = tokenFor(result.lease);
        return {
          state: publicState(result.lease, principal, isoNow()),
          resumeToken,
        };
      }),
    );

  const heartbeat: DesktopLeaseService["heartbeat"] = (principal, input) =>
    serialize(principal.binding, "heartbeat-desktop-lease", () =>
      Effect.gen(function* () {
        yield* routeFor(principal.binding);
        const result = yield* repository("heartbeat-desktop-lease", () =>
          options.repository.heartbeat({
            leaseId: input.leaseId,
            generation: input.generation,
            binding: principal.binding,
            actor: principal,
            idempotencyKey: input.idempotencyKey,
            now: isoNow(),
            expiresAt: after(ttlMs),
          }),
        );
        yield* sendAuthority(userAuthority(result.lease));
        return { state: publicState(result.lease, principal, isoNow()) };
      }),
    );

  const release: DesktopLeaseService["release"] = (principal, input) =>
    serialize(principal.binding, "release-desktop-lease", () =>
      Effect.gen(function* () {
        const result = yield* repository("release-desktop-lease", () =>
          options.repository.release({
            leaseId: input.leaseId,
            generation: input.generation,
            binding: principal.binding,
            actor: principal,
            idempotencyKey: input.idempotencyKey,
            now: isoNow(),
          }),
        );
        yield* sendAuthority(agentAuthority(result.lease));
        return { state: publicState(undefined, principal, isoNow()) };
      }),
    );

  const resume: DesktopLeaseService["resume"] = (principal, input) =>
    serialize(principal.binding, "resume-desktop-lease", () =>
      Effect.gen(function* () {
        yield* routeFor(principal.binding);
        const nextResumeToken = rotatedTokenFor({
          leaseId: input.leaseId,
          generation: input.generation,
          actor: principal,
          idempotencyKey: input.idempotencyKey,
        });
        const result = yield* repository("resume-desktop-lease", () =>
          options.repository.resume({
            leaseId: input.leaseId,
            generation: input.generation,
            binding: principal.binding,
            actor: principal,
            resumeSecretHash: tokenHash(input.resumeToken),
            nextResumeSecretHash: tokenHash(nextResumeToken),
            idempotencyKey: input.idempotencyKey,
            now: isoNow(),
            expiresAt: after(ttlMs),
          }),
        );
        if (result.disposition === "applied") yield* sendAuthority(userAuthority(result.lease));
        return {
          state: publicState(result.lease, principal, isoNow()),
          resumeToken: nextResumeToken,
        };
      }),
    );

  const disconnect: DesktopLeaseService["disconnect"] = (principal) =>
    serialize(principal.binding, "disconnect-desktop-lease", () =>
      repository("disconnect-desktop-lease", () =>
        options.repository.disconnect({
          binding: principal.binding,
          actor: principal,
          idempotencyKey:
            `disconnect:${principal.authSessionId}:${principal.clientId}` as DesktopLeaseIdempotencyKey,
          now: isoNow(),
          graceExpiresAt: after(disconnectGraceMs),
        }),
      ).pipe(Effect.asVoid),
    );

  const authorizeAndDispatchInput: DesktopLeaseService["authorizeAndDispatchInput"] = (
    principal,
    dispatch,
  ) =>
    serialize(principal.binding, "authorize-desktop-input", () =>
      Effect.gen(function* () {
        yield* routeFor(principal.binding);
        const permit = yield* repository("authorize-desktop-input", () =>
          options.repository.authorizeUserInput({
            binding: principal.binding,
            actor: principal,
            now: isoNow(),
          }),
        );
        if (!dispatch(permit)) {
          return yield* new DesktopLeaseServiceError({
            code: "routeUnavailable",
            retryable: true,
            operation: "dispatch-desktop-input",
          });
        }
      }),
    );

  const authorizeAgentInput: DesktopLeaseService["authorizeAgentInput"] = (binding) =>
    serialize(binding, "authorize-agent-desktop-input", () =>
      Effect.gen(function* () {
        yield* expireDueAuthority(binding);
        yield* repository("authorize-agent-desktop-input", () =>
          options.repository.authorizeAgentInput({ binding, now: isoNow() }),
        );
      }),
    );

  const synchronizeRoute: DesktopLeaseService["synchronizeRoute"] = (route) => {
    const binding = desktopBindingForRoute(route);
    return serialize(binding, "synchronize-desktop-route", () =>
      Effect.gen(function* () {
        const authority = yield* repository("rebind-desktop-route", () =>
          options.repository.rebindRoute({
            binding,
            now: isoNow(),
            idempotencyKey:
              `rebind:${binding.attemptId}:${binding.routeGeneration}` as DesktopLeaseIdempotencyKey,
          }),
        );
        if (authority.lease === undefined) {
          if (
            !route.send({
              type: "desktop.authority",
              controller: "agent",
              authorityRevision: (authority.latestGeneration *
                2) as DesktopAuthorityCommand["authorityRevision"],
              binding,
            })
          ) {
            return yield* new DesktopLeaseServiceError({
              code: "routeUnavailable",
              retryable: true,
              operation: "synchronize-desktop-route",
            });
          }
          return;
        }
        if (!route.send(userAuthority(authority.lease))) {
          return yield* new DesktopLeaseServiceError({
            code: "routeUnavailable",
            retryable: true,
            operation: "synchronize-desktop-route",
          });
        }
      }),
    );
  };

  const revokeBinding: DesktopLeaseService["revokeBinding"] = (binding, reason) =>
    serialize(binding, "revoke-desktop-binding", () =>
      repository("revoke-desktop-binding", () =>
        options.repository.revokeBinding({
          binding,
          now: isoNow(),
          idempotencyKey:
            `revoke:${binding.attemptId}:${binding.routeGeneration}:${reason}` as DesktopLeaseIdempotencyKey,
        }),
      ).pipe(Effect.asVoid),
    );

  const revokeCurrent: DesktopLeaseService["revokeCurrent"] = (input) => {
    const lockBinding = {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      attemptId: "revocation-scope",
      environmentId: "revocation-scope",
      environmentRevisionId: "revocation-scope",
      sandboxId: input.sandboxId ?? "revocation-scope",
      workerId: "revocation-scope",
      routeGeneration: 1,
    } as DesktopControlBinding;
    return serialize(lockBinding, "revoke-current-desktop-lease", () =>
      repository("revoke-current-desktop-lease", () =>
        options.repository.revokeCurrent({
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          ...(input.sandboxId === undefined ? {} : { sandboxId: input.sandboxId }),
          now: isoNow(),
          idempotencyKey:
            `revoke-current:${input.threadId}:${input.sandboxId ?? "all"}:${input.reason}` as DesktopLeaseIdempotencyKey,
        }),
      ).pipe(Effect.asVoid),
    );
  };

  const sweepExpired = repository("sweep-desktop-leases", () =>
    options.repository.sweepExpired({ now: isoNow(), limit: sweepLimit }),
  ).pipe(
    Effect.tap((leases) =>
      Effect.forEach(
        leases,
        (lease) => sendAuthority(agentAuthority(lease)).pipe(Effect.catch(() => Effect.void)),
        { concurrency: 8, discard: true },
      ),
    ),
    Effect.map((leases) => leases.length),
  );

  const purgeRetention = repository("purge-desktop-lease-retention", () =>
    options.repository.purgeEndedBefore({
      before: DateTime.formatIso(DateTime.makeUnsafe(now() - retentionMs)),
      limit: retentionLimit,
    }),
  );

  return {
    current,
    acquire,
    heartbeat,
    release,
    resume,
    disconnect,
    authorizeAndDispatchInput,
    authorizeAgentInput,
    synchronizeRoute,
    revokeBinding,
    revokeCurrent,
    sweepExpired,
    purgeRetention,
  };
};
