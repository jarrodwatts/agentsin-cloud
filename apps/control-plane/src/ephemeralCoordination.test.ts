import { expect, it } from "@effect/vitest";
import type { ThreadId } from "@t3tools/contracts";
import type { WorkspaceId } from "@t3tools/contracts/cloud";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import {
  CONTROL_MUTATION_RATE_POLICY,
  encodeKeyPart,
  makeCoordinationKeyspace,
  makeMemoryEphemeralCoordination,
  PRESENCE_HEARTBEAT_RATE_POLICY,
} from "./ephemeralCoordination.ts";

const workspaceA = "00000000-0000-4000-8000-000000000001" as WorkspaceId;
const workspaceB = "00000000-0000-4000-8000-000000000002" as WorkspaceId;
const thread = "thread-1" as ThreadId;

const route = {
  workspaceId: workspaceA,
  threadId: thread,
  connectionId: "connection-1",
  processInstanceId: "railway-1",
  generation: 1,
  ttlMs: 1_000,
};

const scope = {
  workspaceId: workspaceA,
  resourceKind: "desktop-control",
  resourceId: thread,
};

const acquire = {
  ...scope,
  leaseId: "lease-1",
  holderId: "client-1",
  ttlMs: 1_000,
};

const withClock = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(Effect.provide(TestClock.layer()));

it.effect("atomically replaces routes only with a newer fencing generation", () =>
  withClock(
    Effect.gen(function* () {
      const coordination = makeMemoryEphemeralCoordination().service;

      expect(yield* coordination.publishRoute(route)).toBe("applied");
      expect(yield* coordination.publishRoute(route)).toBe("refreshed");
      expect(
        yield* coordination.publishRoute({
          ...route,
          connectionId: "conflicting-same-generation",
        }),
      ).toBe("stale");
      expect(
        yield* coordination.publishRoute({
          ...route,
          connectionId: "connection-2",
          processInstanceId: "railway-2",
          generation: 2,
        }),
      ).toBe("refreshed");

      const active = yield* coordination.getRoute(workspaceA, thread);
      expect(active?.connectionId).toBe("connection-2");
      expect(active?.generation).toBe(2);
      expect(
        yield* coordination.removeRoute({
          workspaceId: workspaceA,
          threadId: thread,
          connectionId: "connection-1",
          generation: 1,
        }),
      ).toBe(false);
      expect((yield* coordination.getRoute(workspaceA, thread))?.generation).toBe(2);
    }),
  ),
);

it.effect("expires route and presence independently without polling", () =>
  withClock(
    Effect.gen(function* () {
      const coordination = makeMemoryEphemeralCoordination().service;
      yield* coordination.publishRoute(route);
      yield* coordination.heartbeatPresence({
        workspaceId: workspaceA,
        threadId: thread,
        connectionId: "connection-1",
        kind: "desktop",
        generation: 1,
        ttlMs: 500,
      });

      yield* TestClock.adjust("500 millis");
      expect(
        yield* coordination.getPresence({
          workspaceId: workspaceA,
          threadId: thread,
          connectionId: "connection-1",
        }),
      ).toBeUndefined();
      expect(yield* coordination.getRoute(workspaceA, thread)).toBeDefined();

      yield* TestClock.adjust("500 millis");
      expect(yield* coordination.getRoute(workspaceA, thread)).toBeUndefined();
    }),
  ),
);

it.effect("retains route fencing after TTL expiry without retaining a live route", () =>
  withClock(
    Effect.gen(function* () {
      const coordination = makeMemoryEphemeralCoordination().service;
      yield* coordination.publishRoute({ ...route, generation: 2 });
      yield* TestClock.adjust("1 second");
      expect(yield* coordination.getRoute(workspaceA, thread)).toBeUndefined();

      expect(yield* coordination.publishRoute(route)).toBe("stale");
      expect(
        yield* coordination.publishRoute({
          ...route,
          connectionId: "same-generation-impostor",
          generation: 2,
        }),
      ).toBe("stale");
      expect(yield* coordination.publishRoute({ ...route, generation: 2 })).toBe("applied");
    }),
  ),
);

it.effect("fences stale presence heartbeats and disconnect cleanup", () =>
  withClock(
    Effect.gen(function* () {
      const coordination = makeMemoryEphemeralCoordination().service;
      const heartbeat = {
        workspaceId: workspaceA,
        threadId: thread,
        connectionId: "connection-1",
        kind: "desktop" as const,
        generation: 2,
        ttlMs: 1_000,
      };
      expect(yield* coordination.heartbeatPresence(heartbeat)).toBe("applied");
      expect(yield* coordination.heartbeatPresence({ ...heartbeat, generation: 1 })).toBe("stale");
      expect(yield* coordination.removePresence({ ...heartbeat, generation: 1 })).toBe(false);
      expect(yield* coordination.removePresence(heartbeat)).toBe(true);
      expect(
        yield* coordination.getPresence({
          workspaceId: workspaceA,
          threadId: thread,
          connectionId: "connection-1",
        }),
      ).toBeUndefined();
    }),
  ),
);

it.effect("keeps identical thread and connection ids isolated by workspace", () =>
  withClock(
    Effect.gen(function* () {
      const coordination = makeMemoryEphemeralCoordination().service;
      yield* coordination.publishRoute(route);
      yield* coordination.publishRoute({
        ...route,
        workspaceId: workspaceB,
        connectionId: "workspace-b-connection",
      });

      expect((yield* coordination.getRoute(workspaceA, thread))?.connectionId).toBe("connection-1");
      expect((yield* coordination.getRoute(workspaceB, thread))?.connectionId).toBe(
        "workspace-b-connection",
      );
    }),
  ),
);

it.effect("rejects ill-formed Unicode instead of collapsing key identities", () =>
  withClock(
    Effect.gen(function* () {
      const coordination = makeMemoryEphemeralCoordination().service;
      const replacement = yield* coordination.publishRoute({ ...route, connectionId: "\ufffd" });
      expect(replacement).toBe("applied");
      for (const connectionId of ["\ud800", "\udc00"]) {
        expect(
          (yield* Effect.exit(coordination.publishRoute({ ...route, connectionId })))._tag,
        ).toBe("Failure");
      }
      expect(encodeKeyPart("\ufffd")).not.toBe(encodeKeyPart("valid"));
    }),
  ),
);

it.effect("allows exactly one duplicate lease acquisition and issues a 256-bit capability", () =>
  withClock(
    Effect.gen(function* () {
      const coordination = makeMemoryEphemeralCoordination().service;
      const first = yield* coordination.acquireLease(acquire);
      const duplicate = yield* coordination.acquireLease(acquire);
      const contender = yield* coordination.acquireLease({
        ...acquire,
        leaseId: "lease-2",
        holderId: "client-2",
      });

      expect(first.acquired).toBe(true);
      expect(duplicate).toEqual({ acquired: false });
      if (first.acquired) {
        expect(first.leaseToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      }
      expect(contender).toEqual({ acquired: false });
    }),
  ),
);

it.effect("never accepts a caller-selected lease capability", () =>
  withClock(
    Effect.gen(function* () {
      const coordination = makeMemoryEphemeralCoordination().service;
      const callerSelected = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      const untrustedRequest = {
        ...acquire,
        leaseToken: callerSelected,
      };
      const acquired = yield* coordination.acquireLease(untrustedRequest);
      expect(acquired.acquired).toBe(true);
      if (acquired.acquired) expect(acquired.leaseToken).not.toBe(callerSelected);
    }),
  ),
);

it.effect("allows expired lease takeover and fences every stale holder mutation", () =>
  withClock(
    Effect.gen(function* () {
      const coordination = makeMemoryEphemeralCoordination().service;
      const first = yield* coordination.acquireLease(acquire);
      if (!first.acquired) return;

      yield* TestClock.adjust("1 second");
      const second = yield* coordination.acquireLease({
        ...acquire,
        leaseId: "lease-2",
        holderId: "client-2",
      });
      expect(second.acquired).toBe(true);
      if (!second.acquired) return;
      expect(second.lease.generation).toBe(first.lease.generation + 1);

      expect(
        yield* coordination.heartbeatLease({
          ...scope,
          holderId: acquire.holderId,
          leaseToken: first.leaseToken,
          generation: first.lease.generation,
          ttlMs: 1_000,
        }),
      ).toEqual({ status: "fenced" });
      expect(
        yield* coordination.releaseLease({
          ...scope,
          holderId: acquire.holderId,
          leaseToken: first.leaseToken,
          generation: first.lease.generation,
        }),
      ).toBe("fenced");
      expect((yield* coordination.getLease(scope))?.holderId).toBe("client-2");
    }),
  ),
);

it.effect("retires thread coordination with bounded tombstones", () =>
  withClock(
    Effect.gen(function* () {
      const coordination = makeMemoryEphemeralCoordination().service;
      yield* coordination.publishRoute(route);
      const lease = yield* coordination.acquireLease(acquire);
      expect(lease.acquired).toBe(true);
      yield* coordination.retireThreadTerminal(workspaceA, thread);
      expect(yield* coordination.getRoute(workspaceA, thread)).toBeUndefined();
      expect(yield* coordination.getLease(scope)).toBeUndefined();
      expect(yield* coordination.publishRoute({ ...route, generation: 99 })).toBe("stale");
      expect(yield* coordination.acquireLease(acquire)).toEqual({ acquired: false });
    }),
  ),
);

it.effect("clears pause state without a terminal tombstone or lost fencing", () =>
  withClock(
    Effect.gen(function* () {
      const coordination = makeMemoryEphemeralCoordination().service;
      yield* coordination.publishRoute({ ...route, generation: 4 });
      yield* coordination.heartbeatPresence({
        workspaceId: workspaceA,
        threadId: thread,
        connectionId: route.connectionId,
        kind: "worker",
        generation: 4,
        ttlMs: 1_000,
      });
      yield* coordination.clearThreadTransient(workspaceA, thread);

      expect(yield* coordination.getRoute(workspaceA, thread)).toBeUndefined();
      expect(
        yield* coordination.getPresence({
          workspaceId: workspaceA,
          threadId: thread,
          connectionId: route.connectionId,
        }),
      ).toBeUndefined();
      expect(yield* coordination.publishRoute({ ...route, generation: 3 })).toBe("stale");
      expect(yield* coordination.publishRoute({ ...route, generation: 5 })).toBe("applied");
    }),
  ),
);

it.effect("renews and releases a lease only with its holder capability", () =>
  withClock(
    Effect.gen(function* () {
      const coordination = makeMemoryEphemeralCoordination().service;
      const acquired = yield* coordination.acquireLease(acquire);
      if (!acquired.acquired) return;

      expect(
        yield* coordination.heartbeatLease({
          ...scope,
          holderId: acquire.holderId,
          leaseToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          generation: acquired.lease.generation,
          ttlMs: 1_000,
        }),
      ).toEqual({ status: "fenced" });
      yield* TestClock.adjust("250 millis");
      const renewed = yield* coordination.heartbeatLease({
        ...scope,
        holderId: acquire.holderId,
        leaseToken: acquired.leaseToken,
        generation: acquired.lease.generation,
        ttlMs: 1_000,
      });
      expect(renewed.status).toBe("renewed");
      expect(
        yield* coordination.releaseLease({
          ...scope,
          holderId: acquire.holderId,
          leaseToken: acquired.leaseToken,
          generation: acquired.lease.generation,
        }),
      ).toBe("released");
      expect(yield* coordination.getLease(scope)).toBeUndefined();
    }),
  ),
);

it.effect("enforces deterministic fixed-window rate-limit boundaries and retry-after", () =>
  withClock(
    Effect.gen(function* () {
      const coordination = makeMemoryEphemeralCoordination().service;
      const input = {
        workspaceId: workspaceA,
        subjectKind: "session",
        subjectId: "session-1",
        policy: { ...CONTROL_MUTATION_RATE_POLICY, limit: 3, windowMs: 1_000 },
      };

      expect((yield* coordination.consumeRateLimit({ ...input, cost: 2 })).remaining).toBe(1);
      const boundary = yield* coordination.consumeRateLimit(input);
      expect(boundary).toMatchObject({ allowed: true, remaining: 0, degraded: false });
      const blocked = yield* coordination.consumeRateLimit(input);
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterMs).toBe(1_000);

      yield* TestClock.adjust("1 second");
      expect(yield* coordination.consumeRateLimit(input)).toMatchObject({
        allowed: true,
        remaining: 2,
      });
    }),
  ),
);

it.effect("makes outage behavior explicit at each limiter call site", () =>
  withClock(
    Effect.gen(function* () {
      const harness = makeMemoryEphemeralCoordination();
      harness.setAvailable(false);
      const common = {
        workspaceId: workspaceA,
        subjectKind: "session",
        subjectId: "session-1",
      };

      expect(
        yield* harness.service.consumeRateLimit({
          ...common,
          policy: PRESENCE_HEARTBEAT_RATE_POLICY,
        }),
      ).toMatchObject({ allowed: true, degraded: true, retryAfterMs: 0 });
      expect(
        (yield* Effect.exit(
          harness.service.consumeRateLimit({
            ...common,
            policy: CONTROL_MUTATION_RATE_POLICY,
          }),
        ))._tag,
      ).toBe("Failure");
      expect((yield* Effect.exit(harness.service.ping))._tag).toBe("Failure");
    }),
  ),
);

it.effect("models restart as total ephemeral loss without inventing authoritative state", () =>
  withClock(
    Effect.gen(function* () {
      const harness = makeMemoryEphemeralCoordination();
      yield* harness.service.publishRoute(route);
      yield* harness.service.acquireLease(acquire);
      yield* harness.service.consumeRateLimit({
        workspaceId: workspaceA,
        subjectKind: "session",
        subjectId: "session-1",
        policy: CONTROL_MUTATION_RATE_POLICY,
      });

      harness.reset();

      expect(yield* harness.service.getRoute(workspaceA, thread)).toBeUndefined();
      expect(yield* harness.service.getLease(scope)).toBeUndefined();
      expect(
        yield* harness.service.consumeRateLimit({
          workspaceId: workspaceA,
          subjectKind: "session",
          subjectId: "session-1",
          policy: CONTROL_MUTATION_RATE_POLICY,
        }),
      ).toMatchObject({ remaining: CONTROL_MUTATION_RATE_POLICY.limit - 1 });
    }),
  ),
);

it("uses a versioned namespace and never embeds raw scoped identifiers in keys", () => {
  const keyspace = makeCoordinationKeyspace("agents-in-cloud");
  const key = keyspace.lease(scope);

  expect(key).toContain("agents-in-cloud:v1:lease:");
  expect(key).not.toContain(workspaceA);
  expect(key).not.toContain(scope.resourceKind);
  expect(key).not.toContain(scope.resourceId);
  expect(encodeKeyPart("same")).toBe("c2FtZQ");
});
