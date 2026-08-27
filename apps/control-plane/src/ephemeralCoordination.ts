// @effect-diagnostics nodeBuiltinImport:off -- Lease capabilities are hashed at the process boundary before entering coordination storage.
import * as NodeCrypto from "node:crypto";

import type { ThreadId } from "@t3tools/contracts";
import type { WorkspaceId } from "@t3tools/contracts/cloud";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const EPHEMERAL_MIN_TTL_MS = 250;
export const EPHEMERAL_MAX_TTL_MS = 24 * 60 * 60_000;
export const EPHEMERAL_MAX_FIELD_LENGTH = 512;
export const EPHEMERAL_LEASE_CAPABILITY_BYTES = 32;
export const EPHEMERAL_LEASE_CAPABILITY_LENGTH = 43;
export const EPHEMERAL_FENCE_RETENTION_MS = 24 * 60 * 60_000;

export type CoordinationFailureMode = "failClosed" | "failOpen";

export class EphemeralCoordinationError extends Schema.TaggedErrorClass<EphemeralCoordinationError>()(
  "EphemeralCoordinationError",
  {
    code: Schema.Literals(["invalidInput", "unavailable", "corruptState"]),
    operation: Schema.String,
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {}

export interface ConnectionRoute {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly connectionId: string;
  readonly processInstanceId: string;
  readonly generation: number;
  readonly observedAtEpochMs: number;
  readonly expiresAtEpochMs: number;
}

export interface PublishRouteInput {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly connectionId: string;
  readonly processInstanceId: string;
  /** Fencing generation issued by the authoritative worker lifecycle. */
  readonly generation: number;
  readonly ttlMs: number;
}

export type RouteWriteResult = "applied" | "refreshed" | "stale";

export interface RouteFence {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly connectionId: string;
  readonly generation: number;
}

export type PresenceKind = "desktop" | "worker" | "automation";

export interface PresenceRecord {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly connectionId: string;
  readonly kind: PresenceKind;
  readonly generation: number;
  readonly heartbeatAtEpochMs: number;
  readonly expiresAtEpochMs: number;
}

export interface PresenceHeartbeatInput {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly connectionId: string;
  readonly kind: PresenceKind;
  readonly generation: number;
  readonly ttlMs: number;
}

export type PresenceWriteResult = "applied" | "refreshed" | "stale";

export interface LeaseScope {
  readonly workspaceId: WorkspaceId;
  readonly resourceKind: string;
  readonly resourceId: string;
}

export interface LeaseRecord extends LeaseScope {
  readonly leaseId: string;
  readonly holderId: string;
  readonly generation: number;
  readonly acquiredAtEpochMs: number;
  readonly heartbeatAtEpochMs: number;
  readonly expiresAtEpochMs: number;
}

export interface AcquireLeaseInput extends LeaseScope {
  readonly leaseId: string;
  readonly holderId: string;
  readonly ttlMs: number;
}

export type LeaseAcquireResult =
  | { readonly acquired: true; readonly lease: LeaseRecord; readonly leaseToken: string }
  | { readonly acquired: false };

export interface LeaseMutationInput extends LeaseScope {
  readonly holderId: string;
  readonly leaseToken: string;
  readonly generation: number;
}

export interface LeaseHeartbeatInput extends LeaseMutationInput {
  readonly ttlMs: number;
}

export type LeaseHeartbeatResult =
  | { readonly status: "renewed"; readonly lease: LeaseRecord }
  | { readonly status: "missing" | "fenced" };

export type LeaseReleaseResult = "released" | "missing" | "fenced";

export interface RateLimitPolicy {
  readonly name: string;
  readonly limit: number;
  readonly windowMs: number;
  /** Every call site must choose whether an unavailable Valkey permits the operation. */
  readonly failureMode: CoordinationFailureMode;
}

export interface RateLimitInput {
  readonly workspaceId: WorkspaceId;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly policy: RateLimitPolicy;
  readonly cost?: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly retryAfterMs: number;
  /** True only when a fail-open policy allowed work without a store decision. */
  readonly degraded: boolean;
}

export interface EphemeralCoordinationService {
  readonly publishRoute: (
    input: PublishRouteInput,
  ) => Effect.Effect<RouteWriteResult, EphemeralCoordinationError>;
  readonly getRoute: (
    workspaceId: WorkspaceId,
    threadId: ThreadId,
  ) => Effect.Effect<ConnectionRoute | undefined, EphemeralCoordinationError>;
  readonly removeRoute: (fence: RouteFence) => Effect.Effect<boolean, EphemeralCoordinationError>;
  readonly heartbeatPresence: (
    input: PresenceHeartbeatInput,
  ) => Effect.Effect<PresenceWriteResult, EphemeralCoordinationError>;
  readonly getPresence: (
    input: Pick<PresenceHeartbeatInput, "workspaceId" | "threadId" | "connectionId">,
  ) => Effect.Effect<PresenceRecord | undefined, EphemeralCoordinationError>;
  readonly removePresence: (
    input: Pick<PresenceHeartbeatInput, "workspaceId" | "threadId" | "connectionId" | "generation">,
  ) => Effect.Effect<boolean, EphemeralCoordinationError>;
  readonly acquireLease: (
    input: AcquireLeaseInput,
  ) => Effect.Effect<LeaseAcquireResult, EphemeralCoordinationError>;
  readonly getLease: (
    scope: LeaseScope,
  ) => Effect.Effect<LeaseRecord | undefined, EphemeralCoordinationError>;
  readonly heartbeatLease: (
    input: LeaseHeartbeatInput,
  ) => Effect.Effect<LeaseHeartbeatResult, EphemeralCoordinationError>;
  readonly releaseLease: (
    input: LeaseMutationInput,
  ) => Effect.Effect<LeaseReleaseResult, EphemeralCoordinationError>;
  readonly consumeRateLimit: (
    input: RateLimitInput,
  ) => Effect.Effect<RateLimitDecision, EphemeralCoordinationError>;
  /** Transient pause/disconnect cleanup; preserves fences and never tombstones the thread. */
  readonly clearThreadTransient: (
    workspaceId: WorkspaceId,
    threadId: ThreadId,
  ) => Effect.Effect<void, EphemeralCoordinationError>;
  /** Terminal cleanup called only after the authoritative thread is permanently retired. */
  readonly retireThreadTerminal: (
    workspaceId: WorkspaceId,
    threadId: ThreadId,
  ) => Effect.Effect<void, EphemeralCoordinationError>;
  readonly ping: Effect.Effect<void, EphemeralCoordinationError>;
}

export class EphemeralCoordination extends Context.Service<
  EphemeralCoordination,
  EphemeralCoordinationService
>()("@agentsin-cloud/control-plane/ephemeralCoordination") {}

interface StoredLease extends LeaseRecord {
  readonly tokenHash: string;
}

interface StoredRateLimit {
  readonly count: number;
  readonly expiresAtEpochMs: number;
}

const failure = (code: EphemeralCoordinationError["code"], operation: string, cause?: unknown) =>
  new EphemeralCoordinationError({
    code,
    operation,
    ...(cause === undefined ? {} : { cause }),
  });

const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

const hasLoneSurrogate = (value: string) => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
};

export const validCoordinationField = (value: string) =>
  value.length > 0 &&
  value.length <= EPHEMERAL_MAX_FIELD_LENGTH &&
  !value.includes("\u0000") &&
  !hasLoneSurrogate(value);

const validTtl = (ttlMs: number) =>
  Number.isSafeInteger(ttlMs) && ttlMs >= EPHEMERAL_MIN_TTL_MS && ttlMs <= EPHEMERAL_MAX_TTL_MS;

const validPositive = (value: number) => Number.isSafeInteger(value) && value > 0;

const validateFields = (operation: string, fields: ReadonlyArray<string>) =>
  fields.every(validCoordinationField)
    ? Effect.void
    : Effect.fail(failure("invalidInput", operation, "invalid scoped identifier"));

const validateGeneration = (operation: string, generation: number) =>
  validPositive(generation)
    ? Effect.void
    : Effect.fail(failure("invalidInput", operation, "generation must be a positive integer"));

const validateTtl = (operation: string, ttlMs: number) =>
  validTtl(ttlMs)
    ? Effect.void
    : Effect.fail(
        failure(
          "invalidInput",
          operation,
          `ttlMs must be an integer between ${EPHEMERAL_MIN_TTL_MS} and ${EPHEMERAL_MAX_TTL_MS}`,
        ),
      );

const validateLeaseToken = (operation: string, leaseToken: string) =>
  leaseToken.length === EPHEMERAL_LEASE_CAPABILITY_LENGTH &&
  validCoordinationField(leaseToken) &&
  /^[A-Za-z0-9_-]+$/.test(leaseToken)
    ? Effect.void
    : Effect.fail(
        failure(
          "invalidInput",
          operation,
          "leaseToken must be a server-issued 256-bit base64url capability",
        ),
      );

export const encodeKeyPart = (value: string) => {
  if (!validCoordinationField(value)) throw new TypeError("invalid coordination key field");
  return Buffer.from(value, "utf8").toString("base64url");
};

export const issueLeaseCapability = () =>
  NodeCrypto.randomBytes(EPHEMERAL_LEASE_CAPABILITY_BYTES).toString("base64url");

export interface CoordinationKeyspace {
  readonly route: (workspaceId: WorkspaceId, threadId: ThreadId) => string;
  readonly routeFence: (workspaceId: WorkspaceId, threadId: ThreadId) => string;
  readonly presence: (workspaceId: WorkspaceId, threadId: ThreadId, connectionId: string) => string;
  readonly lease: (scope: LeaseScope) => string;
  readonly leaseGeneration: (scope: LeaseScope) => string;
  readonly rateLimit: (input: RateLimitInput) => string;
  readonly retiredThread: (workspaceId: WorkspaceId, threadId: ThreadId) => string;
  readonly threadPresenceIndex: (workspaceId: WorkspaceId, threadId: ThreadId) => string;
  readonly threadLeaseIndex: (workspaceId: WorkspaceId, threadId: ThreadId) => string;
}

export const makeCoordinationKeyspace = (namespace: string): CoordinationKeyspace => {
  const prefix = `${namespace}:v1`;
  const part = encodeKeyPart;
  return {
    route: (workspaceId, threadId) => `${prefix}:route:${part(workspaceId)}:${part(threadId)}`,
    routeFence: (workspaceId, threadId) =>
      `${prefix}:route-fence:${part(workspaceId)}:${part(threadId)}`,
    presence: (workspaceId, threadId, connectionId) =>
      `${prefix}:presence:${part(workspaceId)}:${part(threadId)}:${part(connectionId)}`,
    lease: (scope) =>
      `${prefix}:lease:${part(scope.workspaceId)}:${part(scope.resourceKind)}:${part(scope.resourceId)}`,
    leaseGeneration: (scope) =>
      `${prefix}:lease-generation:${part(scope.workspaceId)}:${part(scope.resourceKind)}:${part(scope.resourceId)}`,
    rateLimit: (input) =>
      `${prefix}:rate:${part(input.workspaceId)}:${part(input.subjectKind)}:${part(input.subjectId)}:${part(input.policy.name)}`,
    retiredThread: (workspaceId, threadId) =>
      `${prefix}:retired-thread:${part(workspaceId)}:${part(threadId)}`,
    threadPresenceIndex: (workspaceId, threadId) =>
      `${prefix}:thread-presence:${part(workspaceId)}:${part(threadId)}`,
    threadLeaseIndex: (workspaceId, threadId) =>
      `${prefix}:thread-lease:${part(workspaceId)}:${part(threadId)}`,
  };
};

const routeScopeFields = (input: Pick<PublishRouteInput, "workspaceId" | "threadId">) => [
  input.workspaceId,
  input.threadId,
];

const presenceScopeFields = (
  input: Pick<PresenceHeartbeatInput, "workspaceId" | "threadId" | "connectionId">,
) => [input.workspaceId, input.threadId, input.connectionId];

const leaseScopeFields = (input: LeaseScope) => [
  input.workspaceId,
  input.resourceKind,
  input.resourceId,
];

/** Deterministic fake used by unit tests; `reset` models complete Valkey loss/restart. */
export const makeMemoryEphemeralCoordination = () => {
  const routes = new Map<string, ConnectionRoute>();
  const routeFences = new Map<
    string,
    Pick<ConnectionRoute, "connectionId" | "processInstanceId" | "generation"> & {
      readonly expiresAtEpochMs: number;
    }
  >();
  const presence = new Map<string, PresenceRecord>();
  const leases = new Map<string, StoredLease>();
  const leaseGenerations = new Map<
    string,
    { readonly generation: number; readonly expiresAtEpochMs: number }
  >();
  const rateLimits = new Map<string, StoredRateLimit>();
  const retiredThreads = new Map<string, number>();
  const keys = makeCoordinationKeyspace("memory");
  let available = true;

  const ensureAvailable = (operation: string) =>
    available ? Effect.void : Effect.fail(failure("unavailable", operation));

  const current = Effect.map(Clock.currentTimeMillis, Number);

  const pruneRetained = (now: number) => {
    for (const [key, record] of routeFences) {
      if (record.expiresAtEpochMs <= now) routeFences.delete(key);
    }
    for (const [key, record] of leaseGenerations) {
      if (record.expiresAtEpochMs <= now) leaseGenerations.delete(key);
    }
    for (const [key, expiresAt] of retiredThreads) {
      if (expiresAt <= now) retiredThreads.delete(key);
    }
  };

  const isRetired = (workspaceId: WorkspaceId, threadId: ThreadId, now: number) => {
    const key = keys.retiredThread(workspaceId, threadId);
    const expiresAt = retiredThreads.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= now) {
      retiredThreads.delete(key);
      return false;
    }
    return true;
  };

  const live = <A extends { readonly expiresAtEpochMs: number }>(
    records: Map<string, A>,
    key: string,
    now: number,
  ) => {
    const record = records.get(key);
    if (record !== undefined && record.expiresAtEpochMs <= now) {
      records.delete(key);
      return undefined;
    }
    return record;
  };

  const service: EphemeralCoordinationService = {
    publishRoute: (input) =>
      Effect.gen(function* () {
        yield* ensureAvailable("publish-route");
        yield* validateFields("publish-route", [
          ...routeScopeFields(input),
          input.connectionId,
          input.processInstanceId,
        ]);
        yield* validateGeneration("publish-route", input.generation);
        yield* validateTtl("publish-route", input.ttlMs);
        const now = yield* current;
        pruneRetained(now);
        if (isRetired(input.workspaceId, input.threadId, now)) return "stale";
        const key = keys.route(input.workspaceId, input.threadId);
        const fenceKey = keys.routeFence(input.workspaceId, input.threadId);
        const fence = live(routeFences, fenceKey, now);
        if (fence !== undefined && fence.generation > input.generation) return "stale";
        if (
          fence !== undefined &&
          fence.generation === input.generation &&
          (fence.connectionId !== input.connectionId ||
            fence.processInstanceId !== input.processInstanceId)
        ) {
          return "stale";
        }
        const prior = live(routes, key, now);
        if (prior !== undefined && prior.generation > input.generation) return "stale";
        if (
          prior !== undefined &&
          prior.generation === input.generation &&
          (prior.connectionId !== input.connectionId ||
            prior.processInstanceId !== input.processInstanceId)
        ) {
          return "stale";
        }
        const refreshed = prior !== undefined;
        routeFences.set(fenceKey, {
          connectionId: input.connectionId,
          processInstanceId: input.processInstanceId,
          generation: input.generation,
          expiresAtEpochMs: now + EPHEMERAL_FENCE_RETENTION_MS,
        });
        routes.set(key, {
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          connectionId: input.connectionId,
          processInstanceId: input.processInstanceId,
          generation: input.generation,
          observedAtEpochMs: now,
          expiresAtEpochMs: now + input.ttlMs,
        });
        return refreshed ? "refreshed" : "applied";
      }),
    getRoute: (workspaceId, threadId) =>
      Effect.gen(function* () {
        yield* ensureAvailable("get-route");
        yield* validateFields("get-route", [workspaceId, threadId]);
        return live(routes, keys.route(workspaceId, threadId), yield* current);
      }),
    removeRoute: (input) =>
      Effect.gen(function* () {
        yield* ensureAvailable("remove-route");
        yield* validateFields("remove-route", [...routeScopeFields(input), input.connectionId]);
        yield* validateGeneration("remove-route", input.generation);
        const key = keys.route(input.workspaceId, input.threadId);
        const prior = live(routes, key, yield* current);
        if (
          prior === undefined ||
          prior.generation !== input.generation ||
          prior.connectionId !== input.connectionId
        ) {
          return false;
        }
        routes.delete(key);
        return true;
      }),
    heartbeatPresence: (input) =>
      Effect.gen(function* () {
        yield* ensureAvailable("heartbeat-presence");
        yield* validateFields("heartbeat-presence", presenceScopeFields(input));
        yield* validateGeneration("heartbeat-presence", input.generation);
        yield* validateTtl("heartbeat-presence", input.ttlMs);
        const now = yield* current;
        pruneRetained(now);
        if (isRetired(input.workspaceId, input.threadId, now)) return "stale";
        const key = keys.presence(input.workspaceId, input.threadId, input.connectionId);
        const prior = live(presence, key, now);
        if (prior !== undefined && prior.generation > input.generation) return "stale";
        if (
          prior !== undefined &&
          prior.generation === input.generation &&
          prior.kind !== input.kind
        ) {
          return "stale";
        }
        const refreshed = prior !== undefined;
        presence.set(key, {
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          connectionId: input.connectionId,
          kind: input.kind,
          generation: input.generation,
          heartbeatAtEpochMs: now,
          expiresAtEpochMs: now + input.ttlMs,
        });
        return refreshed ? "refreshed" : "applied";
      }),
    getPresence: (input) =>
      Effect.gen(function* () {
        yield* ensureAvailable("get-presence");
        yield* validateFields("get-presence", presenceScopeFields(input));
        return live(
          presence,
          keys.presence(input.workspaceId, input.threadId, input.connectionId),
          yield* current,
        );
      }),
    removePresence: (input) =>
      Effect.gen(function* () {
        yield* ensureAvailable("remove-presence");
        yield* validateFields("remove-presence", presenceScopeFields(input));
        yield* validateGeneration("remove-presence", input.generation);
        const key = keys.presence(input.workspaceId, input.threadId, input.connectionId);
        const prior = live(presence, key, yield* current);
        if (prior === undefined || prior.generation !== input.generation) return false;
        presence.delete(key);
        return true;
      }),
    acquireLease: (input) =>
      Effect.gen(function* () {
        yield* ensureAvailable("acquire-lease");
        yield* validateFields("acquire-lease", [
          ...leaseScopeFields(input),
          input.leaseId,
          input.holderId,
        ]);
        yield* validateTtl("acquire-lease", input.ttlMs);
        const now = yield* current;
        pruneRetained(now);
        if (isRetired(input.workspaceId, input.resourceId as ThreadId, now)) {
          return { acquired: false };
        }
        const key = keys.lease(input);
        const prior = live(leases, key, now);
        const leaseToken = issueLeaseCapability();
        const tokenHash = sha256(leaseToken);
        if (prior !== undefined) {
          return { acquired: false };
        }
        const priorGeneration = live(leaseGenerations, key, now)?.generation ?? 0;
        const generation = priorGeneration + 1;
        leaseGenerations.set(key, {
          generation,
          expiresAtEpochMs: now + EPHEMERAL_FENCE_RETENTION_MS,
        });
        const stored: StoredLease = {
          workspaceId: input.workspaceId,
          resourceKind: input.resourceKind,
          resourceId: input.resourceId,
          leaseId: input.leaseId,
          holderId: input.holderId,
          tokenHash,
          generation,
          acquiredAtEpochMs: now,
          heartbeatAtEpochMs: now,
          expiresAtEpochMs: now + input.ttlMs,
        };
        leases.set(key, stored);
        const { tokenHash: _hidden, ...lease } = stored;
        return { acquired: true, lease, leaseToken };
      }),
    getLease: (scope) =>
      Effect.gen(function* () {
        yield* ensureAvailable("get-lease");
        yield* validateFields("get-lease", leaseScopeFields(scope));
        const stored = live(leases, keys.lease(scope), yield* current);
        if (stored === undefined) return undefined;
        const { tokenHash: _hidden, ...lease } = stored;
        return lease;
      }),
    heartbeatLease: (input) =>
      Effect.gen(function* () {
        yield* ensureAvailable("heartbeat-lease");
        yield* validateFields("heartbeat-lease", [...leaseScopeFields(input), input.holderId]);
        yield* validateLeaseToken("heartbeat-lease", input.leaseToken);
        yield* validateGeneration("heartbeat-lease", input.generation);
        yield* validateTtl("heartbeat-lease", input.ttlMs);
        const now = yield* current;
        const key = keys.lease(input);
        const prior = live(leases, key, now);
        if (prior === undefined) return { status: "missing" };
        if (
          prior.generation !== input.generation ||
          prior.holderId !== input.holderId ||
          prior.tokenHash !== sha256(input.leaseToken)
        ) {
          return { status: "fenced" };
        }
        const stored: StoredLease = {
          ...prior,
          heartbeatAtEpochMs: now,
          expiresAtEpochMs: now + input.ttlMs,
        };
        leases.set(key, stored);
        leaseGenerations.set(key, {
          generation: prior.generation,
          expiresAtEpochMs: now + EPHEMERAL_FENCE_RETENTION_MS,
        });
        const { tokenHash: _hidden, ...lease } = stored;
        return { status: "renewed", lease };
      }),
    releaseLease: (input) =>
      Effect.gen(function* () {
        yield* ensureAvailable("release-lease");
        yield* validateFields("release-lease", [...leaseScopeFields(input), input.holderId]);
        yield* validateLeaseToken("release-lease", input.leaseToken);
        yield* validateGeneration("release-lease", input.generation);
        const key = keys.lease(input);
        const prior = live(leases, key, yield* current);
        if (prior === undefined) return "missing";
        if (
          prior.generation !== input.generation ||
          prior.holderId !== input.holderId ||
          prior.tokenHash !== sha256(input.leaseToken)
        ) {
          return "fenced";
        }
        leases.delete(key);
        return "released";
      }),
    consumeRateLimit: (input) =>
      Effect.gen(function* () {
        const cost = input.cost ?? 1;
        yield* validateFields("consume-rate-limit", [
          input.workspaceId,
          input.subjectKind,
          input.subjectId,
          input.policy.name,
        ]);
        if (
          !validPositive(input.policy.limit) ||
          !validTtl(input.policy.windowMs) ||
          !validPositive(cost)
        ) {
          return yield* failure("invalidInput", "consume-rate-limit", "invalid policy or cost");
        }
        if (!available) {
          if (input.policy.failureMode === "failOpen") {
            return {
              allowed: true,
              limit: input.policy.limit,
              remaining: 0,
              retryAfterMs: 0,
              degraded: true,
            };
          }
          return yield* failure("unavailable", "consume-rate-limit");
        }
        const now = yield* current;
        const key = keys.rateLimit(input);
        const prior = live(rateLimits, key, now);
        const count = prior?.count ?? 0;
        const expiresAtEpochMs = prior?.expiresAtEpochMs ?? now + input.policy.windowMs;
        const retryAfterMs = Math.max(1, expiresAtEpochMs - now);
        if (count + cost > input.policy.limit) {
          return {
            allowed: false,
            limit: input.policy.limit,
            remaining: Math.max(0, input.policy.limit - count),
            retryAfterMs,
            degraded: false,
          };
        }
        const nextCount = count + cost;
        rateLimits.set(key, { count: nextCount, expiresAtEpochMs });
        return {
          allowed: true,
          limit: input.policy.limit,
          remaining: input.policy.limit - nextCount,
          retryAfterMs,
          degraded: false,
        };
      }),
    clearThreadTransient: (workspaceId, threadId) =>
      Effect.gen(function* () {
        yield* ensureAvailable("clear-thread-transient");
        yield* validateFields("clear-thread-transient", [workspaceId, threadId]);
        routes.delete(keys.route(workspaceId, threadId));
        for (const [key, record] of presence) {
          if (record.workspaceId === workspaceId && record.threadId === threadId)
            presence.delete(key);
        }
      }),
    retireThreadTerminal: (workspaceId, threadId) =>
      Effect.gen(function* () {
        yield* ensureAvailable("retire-thread-terminal");
        yield* validateFields("retire-thread-terminal", [workspaceId, threadId]);
        const now = yield* current;
        pruneRetained(now);
        routes.delete(keys.route(workspaceId, threadId));
        routeFences.delete(keys.routeFence(workspaceId, threadId));
        for (const [key, record] of presence) {
          if (record.workspaceId === workspaceId && record.threadId === threadId)
            presence.delete(key);
        }
        for (const [key, record] of leases) {
          if (record.workspaceId === workspaceId && record.resourceId === threadId) {
            leases.delete(key);
            leaseGenerations.delete(key);
          }
        }
        retiredThreads.set(
          keys.retiredThread(workspaceId, threadId),
          now + EPHEMERAL_FENCE_RETENTION_MS,
        );
      }),
    ping: Effect.suspend(() => ensureAvailable("ping")),
  };

  return {
    service,
    reset: () => {
      routes.clear();
      routeFences.clear();
      presence.clear();
      leases.clear();
      leaseGenerations.clear();
      rateLimits.clear();
      retiredThreads.clear();
    },
    setAvailable: (next: boolean) => {
      available = next;
    },
  };
};

/** Public RPC mutations and ownership changes cannot bypass protection during an outage. */
export const CONTROL_MUTATION_RATE_POLICY: RateLimitPolicy = {
  name: "control-mutation",
  limit: 60,
  windowMs: 60_000,
  failureMode: "failClosed",
};

/** Presence is advisory, so dropping limiter state must not disconnect a healthy client. */
export const PRESENCE_HEARTBEAT_RATE_POLICY: RateLimitPolicy = {
  name: "presence-heartbeat",
  limit: 120,
  windowMs: 60_000,
  failureMode: "failOpen",
};
