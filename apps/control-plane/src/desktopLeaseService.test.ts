import type { AuthSessionId, ThreadId } from "@t3tools/contracts";
import type {
  DesktopAuthorityCommand,
  DesktopControlBinding,
  DesktopControlClientId,
  DesktopLeaseGeneration,
  DesktopLeaseIdempotencyKey,
} from "@t3tools/contracts/desktop-lease";
import type { DesktopLeaseId, WorkspaceId } from "@t3tools/contracts/cloud";
import type { WorkerRelayInbound } from "@t3tools/contracts/worker";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import type { DesktopLeaseRecord, DesktopLeaseRepository } from "./desktopLeaseRepository.ts";
import { makeDesktopLeaseService, type DesktopControlPrincipal } from "./desktopLeaseService.ts";
import { makeInMemoryWorkerRouteRegistry, type ActiveWorkerRoute } from "./workerRelay.ts";

const workspaceId = "99999999-9999-4999-8999-999999999999" as WorkspaceId;
const threadId = "desktop-service-thread" as ThreadId;
const binding: DesktopControlBinding = {
  workspaceId,
  threadId,
  attemptId: "attempt-1",
  environmentId: "environment-1" as never,
  environmentRevisionId: "revision-1" as never,
  sandboxId: "sandbox-1" as never,
  workerId: "worker-1",
  routeGeneration: 1,
};
const actor = (session: string, client: string): DesktopControlPrincipal => ({
  userId: "user-1",
  authSessionId: session as AuthSessionId,
  clientId: client as DesktopControlClientId,
  binding,
});

const makeRepository = () => {
  let lease: DesktopLeaseRecord | undefined;
  let generation = 0;
  const repository: DesktopLeaseRepository = {
    current: async () => lease,
    expireCurrent: async (input) => {
      if (
        lease === undefined ||
        lease.state !== "active" ||
        lease.binding.routeGeneration !== input.binding.routeGeneration ||
        lease.expiresAt > input.now
      ) {
        return lease;
      }
      lease = {
        ...lease,
        state: "expired",
        endedAt: input.now,
        releaseReason:
          lease.connectionState === "disconnected" ? "holderDisconnected" : "heartbeatExpired",
        updatedAt: input.now,
      };
      return lease;
    },
    acquire: async (input) => {
      if (lease?.state === "active") throw new Error("held");
      generation += 1;
      lease = {
        leaseId: input.leaseId,
        binding: input.binding,
        generation: generation as DesktopLeaseGeneration,
        actor: input.actor,
        connectionState: "connected",
        state: "active",
        acquiredAt: input.now,
        heartbeatAt: input.now,
        expiresAt: input.expiresAt,
        updatedAt: input.now,
      };
      return { disposition: "applied", lease };
    },
    heartbeat: async (input) => {
      if (
        lease === undefined ||
        lease.state !== "active" ||
        lease.generation !== input.generation ||
        lease.actor.clientId !== input.actor.clientId
      ) {
        throw new Error("stale");
      }
      lease = {
        ...lease,
        heartbeatAt: input.now,
        expiresAt: input.expiresAt,
        updatedAt: input.now,
      };
      return { disposition: "applied", lease };
    },
    release: async (input) => {
      if (lease === undefined || lease.generation !== input.generation) throw new Error("stale");
      lease = {
        ...lease,
        state: "released",
        endedAt: input.now,
        releaseReason: "released",
        updatedAt: input.now,
      };
      return { disposition: "applied", lease };
    },
    disconnect: async (input) => {
      if (lease?.actor.clientId !== input.actor.clientId || lease.state !== "active") return lease;
      lease = {
        ...lease,
        connectionState: "disconnected",
        disconnectedAt: input.now,
        expiresAt: input.graceExpiresAt,
        updatedAt: input.now,
      };
      return lease;
    },
    resume: async (input) => {
      if (
        lease === undefined ||
        lease.state !== "active" ||
        lease.connectionState !== "disconnected" ||
        lease.actor.authSessionId !== input.actor.authSessionId ||
        lease.generation !== input.generation
      ) {
        throw new Error("forbidden");
      }
      generation += 1;
      lease = {
        ...lease,
        generation: generation as DesktopLeaseGeneration,
        actor: input.actor,
        connectionState: "connected",
        heartbeatAt: input.now,
        expiresAt: input.expiresAt,
        updatedAt: input.now,
      };
      return { disposition: "applied", lease };
    },
    rebindRoute: async (input) => {
      if (
        lease !== undefined &&
        lease.state === "active" &&
        lease.binding.routeGeneration === input.binding.routeGeneration
      ) {
        return { lease, latestGeneration: generation };
      }
      generation += 1;
      if (lease === undefined || lease.state !== "active") return { latestGeneration: generation };
      lease = {
        ...lease,
        generation: generation as DesktopLeaseGeneration,
        binding: input.binding,
        updatedAt: input.now,
      };
      return { lease, latestGeneration: generation };
    },
    authorizeUserInput: async (input) => {
      if (
        lease === undefined ||
        lease.state !== "active" ||
        lease.connectionState !== "connected" ||
        lease.actor.clientId !== input.actor.clientId
      ) {
        throw new Error("forbidden");
      }
      return {
        leaseId: lease.leaseId,
        generation: lease.generation,
        authorityRevision: (lease.generation * 2 - 1) as never,
        binding: lease.binding,
        expiresAt: lease.expiresAt,
      };
    },
    authorizeAgentInput: async () => {
      if (lease?.state === "active") throw new Error("paused");
    },
    revokeBinding: async (input) => {
      if (lease === undefined || lease.state !== "active") return undefined;
      lease = { ...lease, state: "revoked", endedAt: input.now, releaseReason: "revoked" };
      return lease;
    },
    revokeCurrent: async (input) => {
      if (lease === undefined || lease.state !== "active") return undefined;
      lease = { ...lease, state: "revoked", endedAt: input.now, releaseReason: "revoked" };
      return lease;
    },
    sweepExpired: async () => [],
    purgeEndedBefore: async () => 0,
  };
  return { repository, current: () => lease };
};

const makeHarness = () => {
  const routes = makeInMemoryWorkerRouteRegistry();
  const repository = makeRepository();
  const frames: Array<WorkerRelayInbound> = [];
  const route: ActiveWorkerRoute = {
    lease: {
      workspaceId,
      threadId,
      environmentId: binding.environmentId,
      environmentRevisionId: binding.environmentRevisionId,
      sandboxId: binding.sandboxId,
      reservationId: binding.attemptId as never,
      workerId: binding.workerId as never,
      providerInstanceId: "codex_personal" as never,
      providerDriver: "codex" as never,
      certificateFingerprint: "fingerprint",
      certificateGeneration: 1,
      processInstanceId: "process-1",
      leaseGeneration: 1,
      routeGeneration: 1,
      state: "connected",
      connectedAt: "2026-08-27T12:00:00.000Z",
      lastSeenAt: "2026-08-27T12:00:00.000Z",
      heartbeatSequence: 1,
      confirmedEventCursor: -1,
    },
    send: (frame) => {
      frames.push(frame);
      return true;
    },
    close: () => undefined,
  };
  routes.activate(route);
  const service = makeDesktopLeaseService({
    repository: repository.repository,
    routes,
    tokenSecret: "test-desktop-token-secret-with-at-least-32-bytes",
    now: () => Date.parse("2026-08-27T12:00:00.000Z"),
    nextLeaseId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as DesktopLeaseId,
    ttlMs: 30_000,
    disconnectGraceMs: 5_000,
  });
  return { service, frames, repository, route };
};

const authorityFrames = (frames: ReadonlyArray<WorkerRelayInbound>) =>
  frames.filter((frame): frame is DesktopAuthorityCommand => frame.type === "desktop.authority");

it.effect("linearizes release before restoring agent authority and fences subsequent input", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const principal = actor("auth-1", "client-1");
    const acquired = yield* harness.service.acquire(
      principal,
      "acquire-1" as DesktopLeaseIdempotencyKey,
    );
    expect(acquired.state.controller).toBe("user");
    let dispatched = 0;
    yield* harness.service.authorizeAndDispatchInput(principal, () => {
      dispatched += 1;
      return true;
    });
    const active = harness.repository.current()!;
    yield* harness.service.release(principal, {
      protocolVersion: 1,
      type: "desktop.control.release",
      requestId: "release-request" as never,
      leaseId: active.leaseId,
      generation: active.generation,
      idempotencyKey: "release-1" as DesktopLeaseIdempotencyKey,
    });
    expect(harness.repository.current()?.state).toBe("released");
    expect(authorityFrames(harness.frames).map((frame) => frame.controller)).toEqual([
      "user",
      "agent",
    ]);
    expect(dispatched).toBe(1);
    expect(
      Exit.isFailure(
        yield* Effect.exit(harness.service.authorizeAndDispatchInput(principal, () => true)),
      ),
    ).toBe(true);
  }),
);

it.effect(
  "uses disconnected grace and resumes only the same auth session with a new generation",
  () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const first = actor("auth-1", "client-1");
      const acquisition = yield* harness.service.acquire(
        first,
        "acquire-1" as DesktopLeaseIdempotencyKey,
      );
      const before = harness.repository.current()!;
      yield* harness.service.disconnect(first);
      const current = yield* harness.service.current(actor("auth-1", "client-2"));
      expect(current.state).toMatchObject({
        controller: "disconnected",
        resumableByCurrentSession: true,
      });
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            harness.service.resume(actor("auth-2", "client-2"), {
              protocolVersion: 1,
              type: "desktop.control.resume",
              requestId: "foreign" as never,
              leaseId: before.leaseId,
              generation: before.generation,
              resumeToken: "x".repeat(43) as never,
              idempotencyKey: "foreign" as DesktopLeaseIdempotencyKey,
            }),
          ),
        ),
      ).toBe(true);
      const resumed = yield* harness.service.resume(actor("auth-1", "client-2"), {
        protocolVersion: 1,
        type: "desktop.control.resume",
        requestId: "resume" as never,
        leaseId: before.leaseId,
        generation: before.generation,
        resumeToken: acquisition.resumeToken!,
        idempotencyKey: "resume" as DesktopLeaseIdempotencyKey,
      });
      expect(resumed.state).toMatchObject({ controller: "user", heldByCurrentClient: true });
      expect(harness.repository.current()!.generation).toBeGreaterThan(before.generation);
    }),
);

it.effect("route synchronization is monotonic and a stale route cannot receive authority", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const principal = actor("auth-1", "client-1");
    yield* harness.service.acquire(principal, "acquire-1" as DesktopLeaseIdempotencyKey);
    (harness.route.lease as { routeGeneration: number }).routeGeneration = 2;
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          harness.service.heartbeat(principal, {
            protocolVersion: 1,
            type: "desktop.control.heartbeat",
            requestId: "heartbeat" as never,
            leaseId: harness.repository.current()!.leaseId,
            generation: harness.repository.current()!.generation,
            idempotencyKey: "heartbeat" as DesktopLeaseIdempotencyKey,
          }),
        ),
      ),
    ).toBe(true);
  }),
);
