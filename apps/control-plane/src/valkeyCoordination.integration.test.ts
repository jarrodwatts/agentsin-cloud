import * as NodeCrypto from "node:crypto";

import type { ThreadId } from "@t3tools/contracts";
import type { WorkspaceId } from "@t3tools/contracts/cloud";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { Redis } from "ioredis";

import { makeCoordinationKeyspace } from "./ephemeralCoordination.ts";
import { fromEnv } from "./valkeyConfig.ts";
import { makeRedisOptions, makeValkeyEphemeralCoordination } from "./valkeyCoordination.ts";

const integrationUrl = process.env.AGENTSIN_TEST_VALKEY_URL;

describe.skipIf(integrationUrl === undefined)("Valkey production adapter", () => {
  it.effect("executes atomic routing, TTL, lease fencing, limiting, reconnect, and cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* fromEnv({
          VALKEY_URL: integrationUrl,
          VALKEY_NAMESPACE: `aic-test-${NodeCrypto.randomBytes(8).toString("hex")}`,
          VALKEY_CONNECT_TIMEOUT_MS: "1000",
          VALKEY_COMMAND_TIMEOUT_MS: "500",
        });
        const coordination = yield* makeValkeyEphemeralCoordination(config);
        const raw = new Redis(makeRedisOptions(config));
        yield* Effect.acquireRelease(
          Effect.promise(async () => {
            await raw.connect();
            return raw;
          }),
          (client) => Effect.tryPromise(() => client.quit()).pipe(Effect.ignore),
        );

        const workspaceId = "00000000-0000-4000-8000-000000000001" as WorkspaceId;
        const threadId = `thread-${NodeCrypto.randomUUID()}` as ThreadId;
        const keys = makeCoordinationKeyspace(config.namespace);
        const route = {
          workspaceId,
          threadId,
          connectionId: "connection-1",
          processInstanceId: "replica-1",
          generation: 1,
          ttlMs: 5_000,
        };

        expect(yield* coordination.publishRoute(route)).toBe("applied");
        expect(yield* coordination.publishRoute({ ...route, connectionId: "stale" })).toBe("stale");
        expect(
          yield* coordination.publishRoute({
            ...route,
            connectionId: "connection-2",
            processInstanceId: "replica-2",
            generation: 2,
          }),
        ).toBe("refreshed");
        expect(
          yield* Effect.promise(() => raw.pttl(keys.route(workspaceId, threadId))),
        ).toBeGreaterThan(0);
        const expireBefore = Number(yield* Clock.currentTimeMillis) - 1;
        yield* Effect.promise(() => raw.pexpireat(keys.route(workspaceId, threadId), expireBefore));
        expect(yield* coordination.getRoute(workspaceId, threadId)).toBeUndefined();
        expect(yield* coordination.publishRoute(route)).toBe("stale");
        expect(
          yield* Effect.promise(() => raw.pttl(keys.routeFence(workspaceId, threadId))),
        ).toBeGreaterThan(0);

        const leaseScope = {
          workspaceId,
          resourceKind: "desktop-control",
          resourceId: threadId,
        };
        const acquisitions = yield* Effect.all(
          Array.from({ length: 8 }, (_, index) =>
            coordination.acquireLease({
              ...leaseScope,
              leaseId: `lease-${index}`,
              holderId: `holder-${index}`,
              ttlMs: 5_000,
            }),
          ),
          { concurrency: "unbounded" },
        );
        const winner = acquisitions.find((result) => result.acquired);
        expect(acquisitions.filter((result) => result.acquired)).toHaveLength(1);
        if (winner === undefined || !winner.acquired) throw new Error("lease winner missing");
        yield* Effect.promise(() => raw.del(keys.lease(leaseScope)));
        const takeover = yield* coordination.acquireLease({
          ...leaseScope,
          leaseId: "takeover",
          holderId: "takeover-holder",
          ttlMs: 5_000,
        });
        expect(takeover.acquired).toBe(true);
        expect(
          yield* coordination.releaseLease({
            ...leaseScope,
            holderId: winner.lease.holderId,
            generation: winner.lease.generation,
            leaseToken: winner.leaseToken,
          }),
        ).toBe("fenced");

        const rateInput = {
          workspaceId,
          subjectKind: "integration",
          subjectId: threadId,
          policy: {
            name: "integration-boundary",
            limit: 2,
            windowMs: 5_000,
            failureMode: "failClosed" as const,
          },
        };
        expect((yield* coordination.consumeRateLimit(rateInput)).allowed).toBe(true);
        expect((yield* coordination.consumeRateLimit(rateInput)).allowed).toBe(true);
        const blocked = yield* coordination.consumeRateLimit(rateInput);
        expect(blocked.allowed).toBe(false);
        expect(blocked.retryAfterMs).toBeGreaterThan(0);

        expect(yield* coordination.publishRoute({ ...route, generation: 3 })).toBe("applied");
        yield* coordination.heartbeatPresence({
          workspaceId,
          threadId,
          connectionId: "worker-presence",
          kind: "worker",
          generation: 3,
          ttlMs: 5_000,
        });
        yield* coordination.clearThreadTransient(workspaceId, threadId);
        expect(yield* coordination.getRoute(workspaceId, threadId)).toBeUndefined();
        expect(
          yield* Effect.promise(() => raw.exists(keys.retiredThread(workspaceId, threadId))),
        ).toBe(0);
        expect(yield* coordination.publishRoute({ ...route, generation: 4 })).toBe("applied");

        yield* coordination.retireThreadTerminal(workspaceId, threadId);
        expect(yield* coordination.getRoute(workspaceId, threadId)).toBeUndefined();
        expect(yield* coordination.getLease(leaseScope)).toBeUndefined();
        expect(yield* coordination.publishRoute({ ...route, generation: 99 })).toBe("stale");
        expect(
          yield* Effect.promise(() => raw.pttl(keys.retiredThread(workspaceId, threadId))),
        ).toBeGreaterThan(0);
        expect(
          yield* Effect.promise(() => raw.exists(keys.routeFence(workspaceId, threadId))),
        ).toBe(0);
        expect(yield* Effect.promise(() => raw.exists(keys.leaseGeneration(leaseScope)))).toBe(0);

        raw.disconnect(false);
        yield* Effect.promise(() => raw.connect());
        expect(yield* Effect.promise(() => raw.ping())).toBe("PONG");
        raw.disconnect(false);
        yield* Effect.promise(() => expect(raw.get("offline-command")).rejects.toThrow());

        const deadlineClient = new Redis(makeRedisOptions({ ...config, commandTimeoutMs: 250 }));
        yield* Effect.acquireRelease(
          Effect.promise(() => deadlineClient.connect()),
          () => Effect.sync(() => deadlineClient.disconnect(false)),
        );
        const startedAt = Number(yield* Clock.currentTimeMillis);
        yield* Effect.promise(() =>
          expect(deadlineClient.blpop(`${config.namespace}:never`, 1)).rejects.toThrow(),
        );
        const completedAt = Number(yield* Clock.currentTimeMillis);
        expect(completedAt - startedAt).toBeLessThan(900);
      }),
    ),
  );
});
