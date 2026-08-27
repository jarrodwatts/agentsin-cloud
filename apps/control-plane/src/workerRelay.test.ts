// @effect-diagnostics runEffectInsideEffect:off -- Native fake socket callbacks resolve test Effects deterministically.
import { expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import type { WorkerRelayOutbound } from "@t3tools/contracts/worker";

import {
  WorkerIdentityError,
  type WorkerCertificateRecord,
  type WorkerIdentityService,
} from "./workerIdentity.ts";
import {
  makeInMemoryWorkerRouteRegistry,
  makeWorkerRelay,
  WorkerRelayServerError,
  type WorkerOutboundAcceptance,
  type WorkerRecoverySource,
  type WorkerRelaySocket,
} from "./workerRelay.ts";

const certificate = {
  workspaceId: "00000000-0000-4000-8000-000000000001",
  threadId: "thread-1",
  environmentId: "environment-1",
  environmentRevisionId: "revision-1",
  sandboxId: "sandbox-1",
  reservationId: "command-reserve-1",
  workerId: "worker-1",
  providerInstanceId: "codex_personal",
  providerDriver: "codex",
  certificateFingerprint: "aa",
  certificateGeneration: 1,
  identityBinding: "binding",
  sanUri: "spiffe://agentsin.cloud/workers/binding",
  publicKeySpkiSha256: "spki",
  notBefore: "2026-08-27T12:00:00.000Z",
  notAfter: "2026-08-27T14:00:00.000Z",
} as WorkerCertificateRecord;

const health = {
  workerId: certificate.workerId,
  workspaceId: certificate.workspaceId,
  environmentId: certificate.environmentId,
  environmentRevisionId: certificate.environmentRevisionId,
  threadId: certificate.threadId,
  sandboxId: certificate.sandboxId,
  providerState: "ready" as const,
  relayState: "connected" as const,
  recoveryState: "healthy" as const,
  ready: true,
  queuedCommands: 0,
  pendingEventProposals: 0,
  confirmedThroughSequence: 7,
  providerRestartCount: 0,
  observedAt: "2026-08-27T13:00:00.000Z",
};

class FakeSocket implements WorkerRelaySocket {
  readonly sent: Array<unknown> = [];
  readonly closes: Array<{ readonly code: number; readonly reason: string }> = [];
  private readonly messages = new Set<(payload: Uint8Array, binary: boolean) => void>();
  private readonly closeListeners = new Set<() => void>();
  private closeWaiter: (() => void) | undefined;

  send(payload: string, complete: (error?: Error) => void) {
    this.sent.push(JSON.parse(payload) as unknown);
    complete();
  }

  close(code: number, reason: string) {
    this.closes.push({ code, reason });
    for (const listener of this.closeListeners) listener();
    this.closeWaiter?.();
  }

  onMessage(listener: (payload: Uint8Array, binary: boolean) => void) {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }

  onClose(listener: () => void) {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  emit(value: unknown) {
    const payload = Buffer.from(JSON.stringify(value));
    for (const listener of this.messages) listener(payload, false);
  }

  waitForClose() {
    if (this.closes.length > 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.closeWaiter = resolve;
    });
  }
}

const makeHarness = (input?: {
  readonly heartbeatTimeoutMs?: number;
  readonly onOutbound?: () => void;
  readonly recover?: WorkerRecoverySource["recover"];
  readonly acceptOutbound?: (
    message: WorkerRelayOutbound,
  ) => Effect.Effect<WorkerOutboundAcceptance, WorkerRelayServerError>;
  readonly onSaveCursors?: () => void;
}) => {
  let generation = 0;
  let heartbeatSequence = 0;
  let disconnects = 0;
  let processRecoveries = 0;
  const recoveredCursors: Array<number> = [];
  const savedCursors: Array<{
    readonly confirmedEventCursor?: number;
    readonly commandDeliveryId?: string;
  }> = [];
  const identities = {
    activateLease: (record: WorkerCertificateRecord, processInstanceId: string) =>
      Effect.succeed({
        ...record,
        processInstanceId,
        leaseGeneration: ++generation,
        state: "connected" as const,
        connectedAt: "2026-08-27T13:00:00.000Z",
        lastSeenAt: "2026-08-27T13:00:00.000Z",
        heartbeatSequence: 0,
        confirmedEventCursor: 7,
        lastCommandDeliveryId: "delivery-7",
      }),
    recordHeartbeat: (
      lease: { readonly leaseGeneration: number },
      message: { readonly heartbeatSequence: number },
    ) =>
      message.heartbeatSequence > heartbeatSequence
        ? Effect.sync(() => {
            heartbeatSequence = message.heartbeatSequence;
            return { ...certificate, ...lease };
          })
        : Effect.fail(new WorkerIdentityError({ code: "leaseFenced", operation: "heartbeat" })),
    disconnectLease: () =>
      Effect.sync(() => {
        disconnects += 1;
        return true;
      }),
    fenceSandbox: () => Effect.succeed([]),
    clock: { now: Effect.succeed("2026-08-27T13:00:00.000Z") },
    repository: {
      saveCursors: (lease: object, cursors: (typeof savedCursors)[number]) =>
        Effect.sync(() => {
          savedCursors.push(cursors);
          input?.onSaveCursors?.();
          return lease;
        }),
      recoverProcess: () =>
        Effect.sync(() => {
          processRecoveries += 1;
          return [];
        }),
    },
  } as unknown as WorkerIdentityService;
  const defaultAcceptance = (message: WorkerRelayOutbound): WorkerOutboundAcceptance => {
    if (message.type === "thread.events.ack") {
      return { type: "event-cursor", confirmedThroughSequence: message.confirmedThroughSequence };
    }
    if (message.type === "thread.command.ack") {
      return { type: "command-delivery", deliveryId: message.deliveryId };
    }
    return { type: "accepted" };
  };
  const recovery: WorkerRecoverySource = {
    recover:
      input?.recover ??
      ((_identity, cursors) =>
        Effect.sync(() => {
          recoveredCursors.push(cursors.confirmedEventCursor);
          return [];
        })),
    handleOutbound: (_identity, message) =>
      Effect.sync(() => input?.onOutbound?.()).pipe(
        Effect.andThen(
          input?.acceptOutbound === undefined
            ? Effect.succeed(defaultAcceptance(message))
            : input.acceptOutbound(message),
        ),
      ),
    claimCommand: () => Effect.succeed("execute"),
  };
  const relay = makeWorkerRelay({
    identities,
    recovery,
    processInstanceId: "railway-replica-1",
    limits: { heartbeatTimeoutMs: input?.heartbeatTimeoutMs ?? 45_000 },
  });
  return {
    relay,
    recoveredCursors,
    heartbeatSequence: () => heartbeatSequence,
    disconnects: () => disconnects,
    processRecoveries: () => processRecoveries,
    savedCursors,
  };
};

it("keeps the newer route when an older connection finishes activation late", () => {
  const routes = makeInMemoryWorkerRouteRegistry();
  const lease = {
    ...certificate,
    processInstanceId: "railway-replica-1",
    state: "connected" as const,
    connectedAt: "2026-08-27T13:00:00.000Z",
    lastSeenAt: "2026-08-27T13:00:00.000Z",
    heartbeatSequence: 0,
    confirmedEventCursor: 7,
  };
  const newer = {
    lease: { ...lease, leaseGeneration: 3 },
    send: () => true,
    close: () => undefined,
  };
  const older = {
    lease: { ...lease, leaseGeneration: 2 },
    send: () => true,
    close: () => undefined,
  };

  expect(routes.activate(newer)).toEqual({ accepted: true });
  expect(routes.activate(older)).toEqual({ accepted: false });
  expect(routes.get(certificate.workspaceId, certificate.sandboxId)).toBe(newer);
});

it.effect(
  "replays from the authoritative cursor and deterministically replaces an old socket",
  () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const first = new FakeSocket();
      const second = new FakeSocket();
      const firstConnection = yield* harness.relay.open(certificate, first);
      const secondConnection = yield* harness.relay.open(certificate, second);

      expect(harness.recoveredCursors).toEqual([7, 7]);
      expect(first.closes).toContainEqual({ code: 4009, reason: "worker_replaced" });
      expect(second.sent).toContainEqual({
        type: "replay.complete",
        confirmedThroughSequence: 7,
      });
      expect(harness.relay.routes.size()).toBe(1);

      firstConnection.close();
      expect(harness.relay.routes.size()).toBe(1);
      secondConnection.close();
      expect(harness.relay.routes.size()).toBe(0);
    }),
);

it.effect("reconstructs routing from durable state after a relay process restart", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const socket = new FakeSocket();
    yield* harness.relay.open(certificate, socket);
    expect(harness.relay.routes.size()).toBe(1);

    yield* harness.relay.initialize;

    expect(harness.processRecoveries()).toBe(1);
    expect(socket.closes).toContainEqual({ code: 1012, reason: "relay_restart" });
    expect(harness.relay.routes.size()).toBe(0);
  }),
);

it.effect("publishes a route only after ordered replay is ready", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const replay =
        yield* Deferred.make<ReadonlyArray<{ type: "worker.shutdown"; reason: string }>>();
      const harness = makeHarness({ recover: () => Deferred.await(replay) });
      const socket = new FakeSocket();
      const opening = yield* harness.relay.open(certificate, socket).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      expect(harness.relay.routes.size()).toBe(0);
      yield* Deferred.succeed(replay, [{ type: "worker.shutdown", reason: "replayed" }]);
      yield* Fiber.join(opening);

      expect(socket.sent).toEqual([
        { type: "worker.shutdown", reason: "replayed" },
        { type: "replay.complete", confirmedThroughSequence: 7 },
      ]);
      expect(harness.relay.routes.size()).toBe(1);
    }),
  ),
);

it.effect("closes and never publishes a route when recovery fails", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      recover: () =>
        Effect.fail(new WorkerRelayServerError({ code: "internal", operation: "recover-test" })),
    });
    const socket = new FakeSocket();
    const result = yield* Effect.result(harness.relay.open(certificate, socket));

    expect(Result.isFailure(result)).toBe(true);
    expect(socket.closes).toContainEqual({ code: 1011, reason: "relay_recovery_failed" });
    expect(harness.relay.routes.size()).toBe(0);
  }),
);

it.effect("persists only the authoritative cursor accepted after durable validation", () =>
  Effect.gen(function* () {
    let saved: (() => void) | undefined;
    const cursorSaved = new Promise<void>((resolve) => {
      saved = resolve;
    });
    const harness = makeHarness({
      onSaveCursors: () => saved?.(),
      acceptOutbound: (message) =>
        Effect.succeed(
          message.type === "thread.events.ack"
            ? { type: "event-cursor" as const, confirmedThroughSequence: 7 }
            : { type: "accepted" as const },
        ),
    });
    const socket = new FakeSocket();
    yield* harness.relay.open(certificate, socket);
    socket.emit({
      type: "thread.events.ack",
      proposalId: "proposal-1",
      eventIds: ["event-1"],
      confirmedThroughSequence: 999_999,
      acknowledgedAt: "2026-08-27T13:00:00.000Z",
    });
    yield* Effect.promise(() => cursorSaved);

    expect(harness.savedCursors).toEqual([{ confirmedEventCursor: 7 }]);
  }),
);

it.effect("persists a valid C2 heartbeat and fails closed on a replayed sequence", () =>
  Effect.gen(function* () {
    let outbound = 0;
    let resumeOutbound: (() => void) | undefined;
    const handled = new Promise<void>((resolve) => {
      resumeOutbound = resolve;
    });
    const harness = makeHarness({
      onOutbound: () => {
        outbound += 1;
        resumeOutbound?.();
      },
    });
    const socket = new FakeSocket();
    const connection = yield* harness.relay.open(certificate, socket);
    socket.emit({ type: "worker.heartbeat", heartbeatSequence: 1, health });
    yield* Effect.promise(() => handled);
    expect(harness.heartbeatSequence()).toBe(1);
    expect(outbound).toBe(1);

    socket.emit({ type: "worker.heartbeat", heartbeatSequence: 1, health });
    yield* Effect.promise(() => socket.waitForClose());
    expect(socket.closes.at(-1)).toEqual({ code: 4400, reason: "invalid_worker_frame" });
    connection.close();
  }),
);

it.effect("poisons queued work after the first invalid frame without later durable mutation", () =>
  Effect.gen(function* () {
    let outbound = 0;
    const harness = makeHarness({ onOutbound: () => (outbound += 1) });
    const socket = new FakeSocket();
    yield* harness.relay.open(certificate, socket);

    socket.emit({ type: "not-a-worker-frame" });
    socket.emit({ type: "worker.heartbeat", heartbeatSequence: 1, health });
    socket.emit({
      type: "thread.events.ack",
      proposalId: "proposal-late",
      eventIds: ["event-late"],
      confirmedThroughSequence: 8,
      acknowledgedAt: "2026-08-27T13:00:00.000Z",
    });
    yield* Effect.promise(() => socket.waitForClose());
    yield* Effect.yieldNow;

    expect(socket.closes.at(-1)).toEqual({ code: 4400, reason: "invalid_worker_frame" });
    expect(harness.heartbeatSequence()).toBe(0);
    expect(harness.savedCursors).toEqual([]);
    expect(outbound).toBe(0);
  }),
);

it.effect("times out an idle worker without sleeping", () =>
  Effect.gen(function* () {
    vi.useFakeTimers();
    try {
      const harness = makeHarness({ heartbeatTimeoutMs: 100 });
      const socket = new FakeSocket();
      yield* harness.relay.open(certificate, socket);
      yield* Effect.sync(() => vi.advanceTimersByTime(100));
      yield* Effect.promise(() => socket.waitForClose());
      expect(socket.closes.at(-1)).toEqual({ code: 4408, reason: "heartbeat_timeout" });
    } finally {
      vi.useRealTimers();
    }
  }),
);
