// @effect-diagnostics nodeBuiltinImport:off -- Lease capabilities are hashed before crossing the Valkey boundary.
import * as NodeCrypto from "node:crypto";

import { ThreadId } from "@t3tools/contracts";
import { WorkspaceId } from "@t3tools/contracts/cloud";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { Redis, type RedisOptions } from "ioredis";

import {
  EPHEMERAL_MAX_TTL_MS,
  EPHEMERAL_MIN_TTL_MS,
  EPHEMERAL_FENCE_RETENTION_MS,
  EPHEMERAL_LEASE_CAPABILITY_LENGTH,
  EphemeralCoordination,
  EphemeralCoordinationError,
  makeCoordinationKeyspace,
  issueLeaseCapability,
  validCoordinationField,
  type ConnectionRoute,
  type EphemeralCoordinationService,
  type LeaseRecord,
  type PresenceRecord,
  type RateLimitDecision,
} from "./ephemeralCoordination.ts";
import {
  layer as valkeyConfigLayer,
  ValkeyConfig,
  type ValkeyConfigShape,
} from "./valkeyConfig.ts";

export interface ValkeyCommandClient {
  readonly get: (key: string) => Promise<string | null>;
  readonly eval: (
    script: string,
    numberOfKeys: number,
    ...arguments_: ReadonlyArray<string>
  ) => Promise<unknown>;
  readonly ping: () => Promise<string>;
}

interface StoredLease extends LeaseRecord {
  readonly tokenHash: string;
}

const EpochMs = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

const ConnectionRouteJson = Schema.fromJsonString(
  Schema.Struct({
    workspaceId: WorkspaceId,
    threadId: ThreadId,
    connectionId: Schema.String,
    processInstanceId: Schema.String,
    generation: PositiveInt,
    observedAtEpochMs: EpochMs,
    expiresAtEpochMs: EpochMs,
  }),
);

const PresenceRecordJson = Schema.fromJsonString(
  Schema.Struct({
    workspaceId: WorkspaceId,
    threadId: ThreadId,
    connectionId: Schema.String,
    kind: Schema.Literals(["desktop", "worker", "automation"]),
    generation: PositiveInt,
    heartbeatAtEpochMs: EpochMs,
    expiresAtEpochMs: EpochMs,
  }),
);

const StoredLeaseJson = Schema.fromJsonString(
  Schema.Struct({
    workspaceId: WorkspaceId,
    resourceKind: Schema.String,
    resourceId: Schema.String,
    leaseId: Schema.String,
    holderId: Schema.String,
    tokenHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    generation: PositiveInt,
    acquiredAtEpochMs: EpochMs,
    heartbeatAtEpochMs: EpochMs,
    expiresAtEpochMs: EpochMs,
  }),
);

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const failure = (code: EphemeralCoordinationError["code"], operation: string, cause?: unknown) =>
  new EphemeralCoordinationError({
    code,
    operation,
    ...(cause === undefined ? {} : { cause }),
  });

const attempt = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      failure(
        cause instanceof Error && cause.name === "ReplyError" ? "corruptState" : "unavailable",
        operation,
        cause,
      ),
  });

const decode = <A>(schema: Schema.Decoder<A, never>, value: unknown, operation: string) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) => failure("corruptState", operation, cause)),
  );

const statusNumber = (value: unknown, operation: string) =>
  typeof value === "number" && Number.isSafeInteger(value)
    ? Effect.succeed(value)
    : typeof value === "string" && /^-?\d+$/.test(value)
      ? Effect.succeed(Number(value))
      : Effect.fail(failure("corruptState", operation, "Valkey returned an invalid status"));

const tuple = (value: unknown, length: number, operation: string) =>
  Array.isArray(value) && value.length === length
    ? Effect.succeed(value as ReadonlyArray<unknown>)
    : Effect.fail(failure("corruptState", operation, "Valkey returned an invalid tuple"));

const validateFields = (operation: string, values: ReadonlyArray<string>) =>
  values.every(validCoordinationField)
    ? Effect.void
    : Effect.fail(failure("invalidInput", operation, "invalid scoped identifier"));

const validatePositive = (operation: string, value: number, name: string) =>
  Number.isSafeInteger(value) && value > 0
    ? Effect.void
    : Effect.fail(failure("invalidInput", operation, `${name} must be a positive integer`));

const validateTtl = (operation: string, ttlMs: number) =>
  Number.isSafeInteger(ttlMs) && ttlMs >= EPHEMERAL_MIN_TTL_MS && ttlMs <= EPHEMERAL_MAX_TTL_MS
    ? Effect.void
    : Effect.fail(failure("invalidInput", operation, "ttl is outside the supported range"));

const validateLeaseToken = (operation: string, leaseToken: string) =>
  leaseToken.length === EPHEMERAL_LEASE_CAPABILITY_LENGTH &&
  validCoordinationField(leaseToken) &&
  /^[A-Za-z0-9_-]+$/.test(leaseToken)
    ? Effect.void
    : Effect.fail(failure("invalidInput", operation, "lease capability is invalid"));

const hashToken = (token: string) => NodeCrypto.createHash("sha256").update(token).digest("hex");

const ROUTE_PUBLISH_SCRIPT = `
if redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
local fence = redis.call('GET', KEYS[2])
if fence then
  local decodedFence = cjson.decode(fence)
  local incomingGeneration = tonumber(ARGV[1])
  if tonumber(decodedFence.generation) > incomingGeneration then return 0 end
  if tonumber(decodedFence.generation) == incomingGeneration and
     (decodedFence.connectionId ~= ARGV[2] or decodedFence.processInstanceId ~= ARGV[3]) then
    return 0
  end
end
local current = redis.call('GET', KEYS[1])
if current then
  local decoded = cjson.decode(current)
  local incomingGeneration = tonumber(ARGV[1])
  if tonumber(decoded.generation) > incomingGeneration then return 0 end
  if tonumber(decoded.generation) == incomingGeneration and
     (decoded.connectionId ~= ARGV[2] or decoded.processInstanceId ~= ARGV[3]) then return 0 end
  redis.call('SET', KEYS[2], ARGV[5], 'PX', ARGV[7])
  redis.call('SET', KEYS[1], ARGV[4], 'PX', ARGV[6])
  return 2
end
redis.call('SET', KEYS[2], ARGV[5], 'PX', ARGV[7])
redis.call('SET', KEYS[1], ARGV[4], 'PX', ARGV[6])
return 1
`;

const ROUTE_REMOVE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local decoded = cjson.decode(current)
if tonumber(decoded.generation) ~= tonumber(ARGV[1]) or decoded.connectionId ~= ARGV[2] then
  return 0
end
redis.call('DEL', KEYS[1])
return 1
`;

const PRESENCE_PUBLISH_SCRIPT = `
if redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
local current = redis.call('GET', KEYS[1])
if current then
  local decoded = cjson.decode(current)
  local incomingGeneration = tonumber(ARGV[1])
  if tonumber(decoded.generation) > incomingGeneration then return 0 end
  if tonumber(decoded.generation) == incomingGeneration and decoded.kind ~= ARGV[2] then return 0 end
  redis.call('SET', KEYS[1], ARGV[3], 'PX', ARGV[4])
  redis.call('SADD', KEYS[2], KEYS[1])
  redis.call('PEXPIRE', KEYS[2], ARGV[5])
  return 2
end
redis.call('SET', KEYS[1], ARGV[3], 'PX', ARGV[4])
redis.call('SADD', KEYS[2], KEYS[1])
redis.call('PEXPIRE', KEYS[2], ARGV[5])
return 1
`;

const PRESENCE_REMOVE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local decoded = cjson.decode(current)
if tonumber(decoded.generation) ~= tonumber(ARGV[1]) then return 0 end
redis.call('DEL', KEYS[1])
return 1
`;

const LEASE_ACQUIRE_SCRIPT = `
if redis.call('EXISTS', KEYS[4]) == 1 then return {0, ''} end
local current = redis.call('GET', KEYS[1])
if current then
  local decoded = cjson.decode(current)
  if decoded.leaseId == ARGV[1] and decoded.holderId == ARGV[2] and decoded.tokenHash == ARGV[3] then
    return {2, current}
  end
  return {0, ''}
end
local generation = redis.call('INCR', KEYS[2])
redis.call('PEXPIRE', KEYS[2], ARGV[6])
local decoded = cjson.decode(ARGV[4])
decoded.generation = generation
local encoded = cjson.encode(decoded)
redis.call('SET', KEYS[1], encoded, 'PX', ARGV[5])
redis.call('SADD', KEYS[3], KEYS[1], KEYS[2])
redis.call('PEXPIRE', KEYS[3], ARGV[6])
return {1, encoded}
`;

const CLEAR_THREAD_TRANSIENT_SCRIPT = `
local presence = redis.call('SMEMBERS', KEYS[1])
for _, key in ipairs(presence) do redis.call('DEL', key) end
redis.call('DEL', KEYS[1], KEYS[2])
return #presence
`;

const RETIRE_THREAD_TERMINAL_SCRIPT = `
local presence = redis.call('SMEMBERS', KEYS[1])
local leases = redis.call('SMEMBERS', KEYS[2])
for _, key in ipairs(presence) do redis.call('DEL', key) end
for _, key in ipairs(leases) do redis.call('DEL', key) end
redis.call('DEL', KEYS[1], KEYS[2], KEYS[3], KEYS[4])
redis.call('SET', KEYS[5], 'retired', 'PX', ARGV[1])
return #presence + #leases
`;

const LEASE_HEARTBEAT_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return {0, ''} end
local decoded = cjson.decode(current)
if tonumber(decoded.generation) ~= tonumber(ARGV[1]) or
   decoded.holderId ~= ARGV[2] or decoded.tokenHash ~= ARGV[3] then
  return {-1, ''}
end
decoded.heartbeatAtEpochMs = tonumber(ARGV[4])
decoded.expiresAtEpochMs = tonumber(ARGV[5])
local encoded = cjson.encode(decoded)
redis.call('SET', KEYS[1], encoded, 'PX', ARGV[6])
redis.call('PEXPIRE', KEYS[2], ARGV[7])
redis.call('PEXPIRE', KEYS[3], ARGV[7])
return {1, encoded}
`;

const LEASE_RELEASE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local decoded = cjson.decode(current)
if tonumber(decoded.generation) ~= tonumber(ARGV[1]) or
   decoded.holderId ~= ARGV[2] or decoded.tokenHash ~= ARGV[3] then
  return -1
end
redis.call('DEL', KEYS[1])
return 1
`;

const RATE_LIMIT_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 1 then ttl = tonumber(ARGV[3]) end
local cost = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
if current + cost > limit then
  if redis.call('EXISTS', KEYS[1]) == 0 then
    redis.call('SET', KEYS[1], '0', 'PX', ARGV[3])
  end
  return {0, current, ttl}
end
local next = redis.call('INCRBY', KEYS[1], cost)
if current == 0 then redis.call('PEXPIRE', KEYS[1], ARGV[3]) end
ttl = redis.call('PTTL', KEYS[1])
return {1, next, ttl}
`;

const publicLease = (stored: StoredLease): LeaseRecord => {
  const { tokenHash: _hidden, ...lease } = stored;
  return lease;
};

export const makeValkeyEphemeralCoordinationFromClient = (
  client: ValkeyCommandClient,
  namespace: string,
): EphemeralCoordinationService => {
  const keys = makeCoordinationKeyspace(namespace);

  const getDecoded = <A>(
    key: string,
    schema: Schema.Decoder<A, never>,
    operation: string,
  ): Effect.Effect<A | undefined, EphemeralCoordinationError> =>
    attempt(operation, () => client.get(key)).pipe(
      Effect.flatMap((value) =>
        value === null ? Effect.sync(() => undefined) : decode(schema, value, operation),
      ),
    );

  const service: EphemeralCoordinationService = {
    publishRoute: (input) =>
      Effect.gen(function* () {
        yield* validateFields("publish-route", [
          input.workspaceId,
          input.threadId,
          input.connectionId,
          input.processInstanceId,
        ]);
        yield* validatePositive("publish-route", input.generation, "generation");
        yield* validateTtl("publish-route", input.ttlMs);
        const now = Number(yield* Clock.currentTimeMillis);
        const route: ConnectionRoute = {
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          connectionId: input.connectionId,
          processInstanceId: input.processInstanceId,
          generation: input.generation,
          observedAtEpochMs: now,
          expiresAtEpochMs: now + input.ttlMs,
        };
        const fence = {
          connectionId: input.connectionId,
          processInstanceId: input.processInstanceId,
          generation: input.generation,
        };
        const raw = yield* attempt("publish-route", () =>
          client.eval(
            ROUTE_PUBLISH_SCRIPT,
            3,
            keys.route(input.workspaceId, input.threadId),
            keys.routeFence(input.workspaceId, input.threadId),
            keys.retiredThread(input.workspaceId, input.threadId),
            String(input.generation),
            input.connectionId,
            input.processInstanceId,
            encodeJson(route),
            encodeJson(fence),
            String(input.ttlMs),
            String(EPHEMERAL_FENCE_RETENTION_MS),
          ),
        );
        const status = yield* statusNumber(raw, "publish-route");
        return status === 1 ? "applied" : status === 2 ? "refreshed" : "stale";
      }),
    getRoute: (workspaceId, threadId) =>
      validateFields("get-route", [workspaceId, threadId]).pipe(
        Effect.andThen(
          getDecoded(keys.route(workspaceId, threadId), ConnectionRouteJson, "get-route"),
        ),
      ),
    removeRoute: (input) =>
      Effect.gen(function* () {
        yield* validateFields("remove-route", [
          input.workspaceId,
          input.threadId,
          input.connectionId,
        ]);
        yield* validatePositive("remove-route", input.generation, "generation");
        const raw = yield* attempt("remove-route", () =>
          client.eval(
            ROUTE_REMOVE_SCRIPT,
            1,
            keys.route(input.workspaceId, input.threadId),
            String(input.generation),
            input.connectionId,
          ),
        );
        return (yield* statusNumber(raw, "remove-route")) === 1;
      }),
    heartbeatPresence: (input) =>
      Effect.gen(function* () {
        yield* validateFields("heartbeat-presence", [
          input.workspaceId,
          input.threadId,
          input.connectionId,
        ]);
        yield* validatePositive("heartbeat-presence", input.generation, "generation");
        yield* validateTtl("heartbeat-presence", input.ttlMs);
        const now = Number(yield* Clock.currentTimeMillis);
        const record: PresenceRecord = {
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          connectionId: input.connectionId,
          kind: input.kind,
          generation: input.generation,
          heartbeatAtEpochMs: now,
          expiresAtEpochMs: now + input.ttlMs,
        };
        const raw = yield* attempt("heartbeat-presence", () =>
          client.eval(
            PRESENCE_PUBLISH_SCRIPT,
            3,
            keys.presence(input.workspaceId, input.threadId, input.connectionId),
            keys.threadPresenceIndex(input.workspaceId, input.threadId),
            keys.retiredThread(input.workspaceId, input.threadId),
            String(input.generation),
            input.kind,
            encodeJson(record),
            String(input.ttlMs),
            String(EPHEMERAL_FENCE_RETENTION_MS),
          ),
        );
        const status = yield* statusNumber(raw, "heartbeat-presence");
        return status === 1 ? "applied" : status === 2 ? "refreshed" : "stale";
      }),
    getPresence: (input) =>
      validateFields("get-presence", [input.workspaceId, input.threadId, input.connectionId]).pipe(
        Effect.andThen(
          getDecoded(
            keys.presence(input.workspaceId, input.threadId, input.connectionId),
            PresenceRecordJson,
            "get-presence",
          ),
        ),
      ),
    removePresence: (input) =>
      Effect.gen(function* () {
        yield* validateFields("remove-presence", [
          input.workspaceId,
          input.threadId,
          input.connectionId,
        ]);
        yield* validatePositive("remove-presence", input.generation, "generation");
        const raw = yield* attempt("remove-presence", () =>
          client.eval(
            PRESENCE_REMOVE_SCRIPT,
            1,
            keys.presence(input.workspaceId, input.threadId, input.connectionId),
            String(input.generation),
          ),
        );
        return (yield* statusNumber(raw, "remove-presence")) === 1;
      }),
    acquireLease: (input) =>
      Effect.gen(function* () {
        yield* validateFields("acquire-lease", [
          input.workspaceId,
          input.resourceKind,
          input.resourceId,
          input.leaseId,
          input.holderId,
        ]);
        yield* validateTtl("acquire-lease", input.ttlMs);
        const now = Number(yield* Clock.currentTimeMillis);
        const leaseToken = issueLeaseCapability();
        const tokenHash = hashToken(leaseToken);
        const withoutGeneration = {
          workspaceId: input.workspaceId,
          resourceKind: input.resourceKind,
          resourceId: input.resourceId,
          leaseId: input.leaseId,
          holderId: input.holderId,
          tokenHash,
          generation: 1,
          acquiredAtEpochMs: now,
          heartbeatAtEpochMs: now,
          expiresAtEpochMs: now + input.ttlMs,
        };
        const raw = yield* attempt("acquire-lease", () =>
          client.eval(
            LEASE_ACQUIRE_SCRIPT,
            4,
            keys.lease(input),
            keys.leaseGeneration(input),
            keys.threadLeaseIndex(input.workspaceId, input.resourceId as ThreadId),
            keys.retiredThread(input.workspaceId, input.resourceId as ThreadId),
            input.leaseId,
            input.holderId,
            tokenHash,
            encodeJson(withoutGeneration),
            String(input.ttlMs),
            String(EPHEMERAL_FENCE_RETENTION_MS),
          ),
        );
        const response = yield* tuple(raw, 2, "acquire-lease");
        const status = yield* statusNumber(response[0], "acquire-lease");
        if (status === 0) return { acquired: false };
        const stored = yield* decode(StoredLeaseJson, response[1], "acquire-lease");
        return {
          acquired: true,
          lease: publicLease(stored),
          leaseToken,
        };
      }),
    getLease: (scope) =>
      Effect.gen(function* () {
        yield* validateFields("get-lease", [
          scope.workspaceId,
          scope.resourceKind,
          scope.resourceId,
        ]);
        const stored = yield* getDecoded(keys.lease(scope), StoredLeaseJson, "get-lease");
        return stored === undefined ? undefined : publicLease(stored);
      }),
    heartbeatLease: (input) =>
      Effect.gen(function* () {
        yield* validateFields("heartbeat-lease", [
          input.workspaceId,
          input.resourceKind,
          input.resourceId,
          input.holderId,
        ]);
        yield* validateLeaseToken("heartbeat-lease", input.leaseToken);
        yield* validatePositive("heartbeat-lease", input.generation, "generation");
        yield* validateTtl("heartbeat-lease", input.ttlMs);
        const now = Number(yield* Clock.currentTimeMillis);
        const tokenHash = hashToken(input.leaseToken);
        const raw = yield* attempt("heartbeat-lease", () =>
          client.eval(
            LEASE_HEARTBEAT_SCRIPT,
            3,
            keys.lease(input),
            keys.threadLeaseIndex(input.workspaceId, input.resourceId as ThreadId),
            keys.leaseGeneration(input),
            String(input.generation),
            input.holderId,
            tokenHash,
            String(now),
            String(now + input.ttlMs),
            String(input.ttlMs),
            String(EPHEMERAL_FENCE_RETENTION_MS),
          ),
        );
        const response = yield* tuple(raw, 2, "heartbeat-lease");
        const status = yield* statusNumber(response[0], "heartbeat-lease");
        if (status === 0) return { status: "missing" };
        if (status === -1) return { status: "fenced" };
        const stored = yield* decode(StoredLeaseJson, response[1], "heartbeat-lease");
        return { status: "renewed", lease: publicLease(stored) };
      }),
    releaseLease: (input) =>
      Effect.gen(function* () {
        yield* validateFields("release-lease", [
          input.workspaceId,
          input.resourceKind,
          input.resourceId,
          input.holderId,
        ]);
        yield* validateLeaseToken("release-lease", input.leaseToken);
        yield* validatePositive("release-lease", input.generation, "generation");
        const tokenHash = hashToken(input.leaseToken);
        const raw = yield* attempt("release-lease", () =>
          client.eval(
            LEASE_RELEASE_SCRIPT,
            1,
            keys.lease(input),
            String(input.generation),
            input.holderId,
            tokenHash,
          ),
        );
        const status = yield* statusNumber(raw, "release-lease");
        return status === 1 ? "released" : status === -1 ? "fenced" : "missing";
      }),
    consumeRateLimit: (input) => {
      const operation = "consume-rate-limit";
      const execute: Effect.Effect<RateLimitDecision, EphemeralCoordinationError> = Effect.gen(
        function* () {
          const cost = input.cost ?? 1;
          yield* validateFields(operation, [
            input.workspaceId,
            input.subjectKind,
            input.subjectId,
            input.policy.name,
          ]);
          yield* validatePositive(operation, input.policy.limit, "limit");
          yield* validatePositive(operation, cost, "cost");
          yield* validateTtl(operation, input.policy.windowMs);
          const raw = yield* attempt(operation, () =>
            client.eval(
              RATE_LIMIT_SCRIPT,
              1,
              keys.rateLimit(input),
              String(cost),
              String(input.policy.limit),
              String(input.policy.windowMs),
            ),
          );
          const response = yield* tuple(raw, 3, operation);
          const allowed = (yield* statusNumber(response[0], operation)) === 1;
          const count = yield* statusNumber(response[1], operation);
          const retryAfterMs = Math.max(1, yield* statusNumber(response[2], operation));
          return {
            allowed,
            limit: input.policy.limit,
            remaining: Math.max(0, input.policy.limit - count),
            retryAfterMs,
            degraded: false,
          };
        },
      );
      return execute.pipe(
        Effect.catch((error) =>
          error.code === "unavailable" && input.policy.failureMode === "failOpen"
            ? Effect.succeed({
                allowed: true,
                limit: input.policy.limit,
                remaining: 0,
                retryAfterMs: 0,
                degraded: true,
              })
            : Effect.fail(error),
        ),
      );
    },
    clearThreadTransient: (workspaceId, threadId) =>
      validateFields("clear-thread-transient", [workspaceId, threadId]).pipe(
        Effect.andThen(
          attempt("clear-thread-transient", () =>
            client.eval(
              CLEAR_THREAD_TRANSIENT_SCRIPT,
              2,
              keys.threadPresenceIndex(workspaceId, threadId),
              keys.route(workspaceId, threadId),
            ),
          ),
        ),
        Effect.asVoid,
      ),
    retireThreadTerminal: (workspaceId, threadId) =>
      validateFields("retire-thread-terminal", [workspaceId, threadId]).pipe(
        Effect.andThen(
          attempt("retire-thread-terminal", () =>
            client.eval(
              RETIRE_THREAD_TERMINAL_SCRIPT,
              5,
              keys.threadPresenceIndex(workspaceId, threadId),
              keys.threadLeaseIndex(workspaceId, threadId),
              keys.route(workspaceId, threadId),
              keys.routeFence(workspaceId, threadId),
              keys.retiredThread(workspaceId, threadId),
              String(EPHEMERAL_FENCE_RETENTION_MS),
            ),
          ),
        ),
        Effect.asVoid,
      ),
    ping: attempt("ping", () => client.ping()).pipe(Effect.asVoid),
  };

  return service;
};

const commandClient = (client: Redis): ValkeyCommandClient => ({
  get: (key) => client.get(key),
  eval: (script, numberOfKeys, ...arguments_) =>
    client.eval(script, numberOfKeys, ...arguments_) as Promise<unknown>,
  ping: () => client.ping(),
});

export const makeRedisOptions = (config: ValkeyConfigShape): RedisOptions => ({
  host: config.host,
  port: config.port,
  db: config.database,
  ...(config.username === undefined ? {} : { username: config.username }),
  ...(config.password === undefined ? {} : { password: config.password }),
  ...(config.tls ? { tls: {} } : {}),
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: config.connectTimeoutMs,
  commandTimeout: config.commandTimeoutMs,
  autoResendUnfulfilledCommands: false,
  autoResubscribe: false,
  connectionName: "agents-in-cloud-control-plane",
});

/** Production adapter. It connects eagerly and fails deployment startup if Valkey is unavailable. */
export const makeValkeyEphemeralCoordination = (
  config: ValkeyConfigShape,
): Effect.Effect<EphemeralCoordinationService, EphemeralCoordinationError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const client = new Redis(makeRedisOptions(config));
        try {
          await client.connect();
          await client.ping();
          return client;
        } catch (cause) {
          client.disconnect(false);
          throw cause;
        }
      },
      catch: (cause) => failure("unavailable", "connect", cause),
    }),
    (client) =>
      Effect.tryPromise(() => client.quit()).pipe(
        Effect.catch(() => Effect.sync(() => client.disconnect(false))),
        Effect.asVoid,
      ),
  ).pipe(
    Effect.map((client) =>
      makeValkeyEphemeralCoordinationFromClient(commandClient(client), config.namespace),
    ),
  );

/** Railway composition seam; deliberately separate from PostgreSQL's authoritative layer. */
export const layer = Layer.effect(
  EphemeralCoordination,
  Effect.gen(function* () {
    const config = yield* ValkeyConfig;
    return yield* makeValkeyEphemeralCoordination(config);
  }),
);

export const productionLayer = layer.pipe(Layer.provide(valkeyConfigLayer));
