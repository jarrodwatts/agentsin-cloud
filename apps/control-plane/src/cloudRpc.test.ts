import type { CommandId, EnvironmentId, EventId, ThreadId } from "@t3tools/contracts";
import {
  type CloudThreadCommand,
  type CloudThreadEvent,
  CloudThreadStreamServerFrame,
  type WorkspaceId,
} from "@t3tools/contracts/cloud";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

import type { ControlPlaneAuth } from "./http.ts";
import { makeCloudRpc, makeThreadEventSignalHub, type CloudRpcSocket } from "./cloudRpc.ts";
import { makeMemoryEphemeralCoordination } from "./ephemeralCoordination.ts";
import { ThreadEventStoreError, type ThreadEventStoreService } from "./threadEventStore.ts";
import type { WorkspaceRepositoryService } from "./workspaces.ts";

const NOW = "2026-08-27T12:00:00.000Z";
const workspaceId = "workspace-1" as WorkspaceId;
const otherWorkspaceId = "workspace-2" as WorkspaceId;
const threadId = "thread-b3" as ThreadId;
const environmentId = "environment-b3" as EnvironmentId;
const decodeServerFrameJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(CloudThreadStreamServerFrame),
);

const command = (commandId: string, routedWorkspace = workspaceId): CloudThreadCommand => ({
  schemaVersion: 1,
  workspaceId: routedWorkspace,
  environmentId,
  threadId,
  command: { type: "thread.archive", commandId: commandId as CommandId, threadId },
  enqueuedAt: NOW,
});

const event = (sequence: number): CloudThreadEvent => ({
  schemaVersion: 1,
  workspaceId,
  environmentId,
  threadId,
  event: {
    sequence,
    eventId: `event-${sequence}` as EventId,
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: NOW,
    commandId: `command-${sequence}` as CommandId,
    causationEventId: null,
    correlationId: `command-${sequence}` as CommandId,
    metadata: {},
    type: "thread.deleted",
    payload: { threadId, deletedAt: NOW },
  },
  receivedAt: NOW,
});

interface FakeThreadState {
  readonly events: Array<CloudThreadEvent>;
  readonly commands: Map<string, CloudThreadCommand>;
}

class FakeThreadStore {
  private readonly state: FakeThreadState;
  submitCalls = 0;

  constructor(
    state: FakeThreadState = {
      events: [],
      commands: new Map(),
    },
  ) {
    this.state = state;
  }

  get events() {
    return this.state.events;
  }

  get commands() {
    return this.state.commands;
  }

  readonly service = {
    submitCommand: ({
      idempotencyKey,
      envelope,
    }: {
      readonly idempotencyKey: string;
      readonly envelope: CloudThreadCommand;
    }) => {
      this.submitCalls += 1;
      if (envelope.workspaceId !== workspaceId || envelope.threadId !== threadId) {
        return Effect.fail(
          new ThreadEventStoreError({
            code: "notFound",
            operation: "submit-command",
            workspaceId: envelope.workspaceId,
            threadId: envelope.threadId,
          }),
        );
      }
      const existing = this.commands.get(idempotencyKey);
      if (existing !== undefined) {
        return Effect.succeed({
          disposition: "duplicate" as const,
          commandId: existing.command.commandId,
        });
      }
      this.commands.set(idempotencyKey, envelope);
      return Effect.succeed({
        disposition: "accepted" as const,
        commandId: envelope.command.commandId,
      });
    },
    replayAfter: (
      routedWorkspace: WorkspaceId,
      routedThread: ThreadId,
      afterSequence: number,
      limit: number,
    ) => {
      if (routedWorkspace !== workspaceId || routedThread !== threadId) {
        return Effect.fail(
          new ThreadEventStoreError({
            code: "notFound",
            operation: "replay-events-after",
            workspaceId: routedWorkspace,
            threadId: routedThread,
          }),
        );
      }
      if (afterSequence + 1 > this.events.length) {
        return Effect.fail(
          new ThreadEventStoreError({
            code: "replayGap",
            operation: "replay-events-after",
            workspaceId: routedWorkspace,
            threadId: routedThread,
          }),
        );
      }
      const selected = this.events.slice(afterSequence + 1, afterSequence + 1 + limit);
      const nextSequence = afterSequence + 1 + selected.length;
      return Effect.succeed({
        events: selected,
        nextSequence,
        hasMore: nextSequence < this.events.length,
      });
    },
    appendEvents: ({ events }: { readonly events: ReadonlyArray<CloudThreadEvent> }) => {
      this.events.push(...events);
      return Effect.succeed({
        appended: events.length,
        duplicates: 0,
        nextSequence: this.events.length,
      });
    },
  } as unknown as ThreadEventStoreService;
}

class FakeSocket implements CloudRpcSocket {
  readonly sent: Array<CloudThreadStreamServerFrame> = [];
  readonly closes: Array<{ readonly code: number; readonly reason: string }> = [];
  private readonly messageListeners = new Set<
    (payload: string | Uint8Array, binary: boolean) => void
  >();
  private readonly closeListeners = new Set<() => void>();
  private readonly closeWaiters: Array<
    (close: { readonly code: number; readonly reason: string }) => void
  > = [];
  private readonly pendingSends: Array<(error?: Error) => void> = [];
  private readonly frameWaiters = new Map<
    CloudThreadStreamServerFrame["type"],
    Array<(frame: CloudThreadStreamServerFrame) => void>
  >();

  private readonly delaySends: boolean;

  constructor(delaySends = false) {
    this.delaySends = delaySends;
  }

  readonly send = (payload: string, complete: (error?: Error) => void) => {
    const frame = decodeServerFrameJson(payload);
    this.sent.push(frame);
    const waiter = this.frameWaiters.get(frame.type)?.shift();
    waiter?.(frame);
    if (this.delaySends) this.pendingSends.push(complete);
    else complete();
  };

  readonly close = (code: number, reason: string) => {
    const close = { code, reason };
    this.closes.push(close);
    for (const waiter of this.closeWaiters.splice(0)) waiter(close);
    for (const listener of this.closeListeners) listener();
  };

  readonly onMessage = (listener: (payload: string | Uint8Array, binary: boolean) => void) => {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  };

  readonly onClose = (listener: () => void) => {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  };

  emit(frame: unknown, binary = false) {
    const payload = typeof frame === "string" ? frame : JSON.stringify(frame);
    for (const listener of this.messageListeners) listener(payload, binary);
  }

  waitForFrame(type: CloudThreadStreamServerFrame["type"]) {
    const existing = this.sent.findLast((frame) => frame.type === type);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise<CloudThreadStreamServerFrame>((resolve) => {
      const entries = this.frameWaiters.get(type) ?? [];
      entries.push(resolve);
      this.frameWaiters.set(type, entries);
    });
  }

  waitForNextFrame(type: CloudThreadStreamServerFrame["type"]) {
    return new Promise<CloudThreadStreamServerFrame>((resolve) => {
      const entries = this.frameWaiters.get(type) ?? [];
      entries.push(resolve);
      this.frameWaiters.set(type, entries);
    });
  }

  waitForClose() {
    const existing = this.closes.at(-1);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise<{ readonly code: number; readonly reason: string }>((resolve) => {
      this.closeWaiters.push(resolve);
    });
  }

  flushOne() {
    this.pendingSends.shift()?.();
  }
}

const auth = (session = true): ControlPlaneAuth => ({
  handler: async () => new Response(null),
  api: {
    getSession: async ({ headers }) =>
      session && headers.get("authorization") === "Bearer signed-desktop-bearer"
        ? { user: { id: "user-1", name: "Ada" } }
        : null,
    generateOneTimeToken: async () => ({ token: "unused" }),
  },
});

const workspaces: WorkspaceRepositoryService = {
  ensureForUser: () =>
    Effect.succeed({
      id: workspaceId,
      ownerUserId: "user-1",
      name: "Ada's workspace",
      createdAt: NOW,
    }),
  findForUser: () => Effect.void.pipe(Effect.as(undefined)),
};

const authorizationHeaders = () => ({ authorization: "Bearer signed-desktop-bearer" });

const request = (body: unknown, headers: Record<string, string> = authorizationHeaders()) =>
  new Request(`https://control.example.com/api/v1/threads/${threadId}/commands`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const submission = (envelope = command("command-1")) => ({
  protocolVersion: 1,
  idempotencyKey: "desktop-command-1",
  envelope,
});

const subscribe = (afterSequence: number) => ({
  protocolVersion: 1,
  type: "subscribe",
  threadId,
  afterSequence,
});

it.effect("authenticates B1 desktop bearers and preserves command idempotency", () => {
  const store = new FakeThreadStore();
  const rpc = makeCloudRpc({
    auth: auth(),
    hostedOrigin: "https://control.example.com",
    workspaces,
    eventStore: store.service,
  });
  return Effect.gen(function* () {
    const accepted = yield* rpc.handleHttp(request(submission()));
    expect(accepted?.status).toBe(202);
    expect(yield* Effect.promise(() => accepted!.json())).toEqual({
      protocolVersion: 1,
      disposition: "accepted",
      commandId: "command-1",
    });

    const duplicate = yield* rpc.handleHttp(request(submission()));
    expect(duplicate?.status).toBe(200);
    expect(
      (yield* Effect.promise(() => duplicate!.json())) as { disposition: string },
    ).toMatchObject({ disposition: "duplicate" });
    expect(store.commands).toHaveLength(1);
  });
});

it.effect(
  "fails closed before persistence when the production mutation limiter is unavailable",
  () => {
    const store = new FakeThreadStore();
    const harness = makeMemoryEphemeralCoordination();
    harness.setAvailable(false);
    const rpc = makeCloudRpc({
      auth: auth(),
      hostedOrigin: "https://control.example.com",
      workspaces,
      eventStore: store.service,
      coordination: harness.service,
    });
    return Effect.gen(function* () {
      expect((yield* rpc.handleHttp(request(submission())))?.status).toBe(503);
      expect(store.submitCalls).toBe(0);
    });
  },
);

it.effect("returns retry-after without persisting when the mutation boundary is exhausted", () => {
  const store = new FakeThreadStore();
  const base = makeMemoryEphemeralCoordination().service;
  const rpc = makeCloudRpc({
    auth: auth(),
    hostedOrigin: "https://control.example.com",
    workspaces,
    eventStore: store.service,
    coordination: {
      ...base,
      consumeRateLimit: () =>
        Effect.succeed({
          allowed: false,
          limit: 60,
          remaining: 0,
          retryAfterMs: 12_345,
          degraded: false,
        }),
    },
  });
  return Effect.gen(function* () {
    const response = yield* rpc.handleHttp(request(submission()));
    expect(response?.status).toBe(429);
    expect(response?.headers.get("retry-after")).toBe("13");
    expect(yield* Effect.promise(() => response!.json())).toMatchObject({ retryAfterMs: 12_345 });
    expect(store.submitCalls).toBe(0);
  });
});

it.effect("denies unauthenticated, cross-origin, and spoofed-workspace commands", () => {
  const store = new FakeThreadStore();
  const make = (authenticated = true) =>
    makeCloudRpc({
      auth: auth(authenticated),
      hostedOrigin: "https://control.example.com",
      workspaces,
      eventStore: store.service,
    });
  return Effect.gen(function* () {
    const unauthorized = yield* make(false).handleHttp(request(submission()));
    expect(unauthorized?.status).toBe(401);

    const crossOrigin = yield* make().handleHttp(
      request(submission(), {
        ...authorizationHeaders(),
        origin: "https://attacker.example",
      }),
    );
    expect(crossOrigin?.status).toBe(403);

    const spoofed = yield* make().handleHttp(
      request(submission(command("command-spoof", otherWorkspaceId))),
    );
    expect(spoofed?.status).toBe(404);
    expect(store.submitCalls).toBe(0);
  });
});

it.effect("rejects malformed and oversized command bodies before persistence", () => {
  const store = new FakeThreadStore();
  const rpc = makeCloudRpc({
    auth: auth(),
    hostedOrigin: "https://control.example.com",
    workspaces,
    eventStore: store.service,
    limits: { maxCommandBodyBytes: 128 },
  });
  return Effect.gen(function* () {
    const malformed = new Request(
      `https://control.example.com/api/v1/threads/${threadId}/commands`,
      {
        method: "POST",
        headers: { ...authorizationHeaders(), "content-type": "application/json" },
        body: "not-json",
      },
    );
    expect((yield* rpc.handleHttp(malformed))?.status).toBe(400);
    expect((yield* rpc.handleHttp(request(submission())))?.status).toBe(413);
    expect(store.submitCalls).toBe(0);
  });
});

it.effect("replays before live tail and polls a separate store without loss or duplication", () => {
  vi.useFakeTimers();
  const state: FakeThreadState = { events: [], commands: new Map() };
  const reader = new FakeThreadStore(state);
  const writer = new FakeThreadStore(state);
  reader.events.push(event(0), event(1));
  const rpc = makeCloudRpc({
    auth: auth(),
    hostedOrigin: "https://control.example.com",
    workspaces,
    eventStore: reader.service,
    limits: { eventPollIntervalMs: 25 },
  });
  return Effect.gen(function* () {
    const principal = yield* rpc.authorizeWebSocket(new Headers(authorizationHeaders()));
    const first = new FakeSocket();
    rpc.openAuthorizedSocket(first, principal);
    first.emit(subscribe(-1));
    yield* Effect.promise(() => first.waitForFrame("caughtUp"));
    expect(
      first.sent
        .filter((frame) => frame.type === "event")
        .map((frame) => frame.event.event.sequence),
    ).toEqual([0, 1]);
    first.close(1000, "client_close");

    reader.events.push(event(2));
    const reconnected = new FakeSocket();
    rpc.openAuthorizedSocket(reconnected, principal);
    reconnected.emit(subscribe(1));
    yield* Effect.promise(() => reconnected.waitForFrame("caughtUp"));
    expect(
      reconnected.sent
        .filter((frame) => frame.type === "event")
        .map((frame) => frame.event.event.sequence),
    ).toEqual([2]);

    yield* writer.service.appendEvents({
      identity: { workspaceId, threadId, environmentId },
      events: [event(3)],
    });
    const liveCaughtUp = reconnected.waitForNextFrame("caughtUp");
    yield* Effect.promise(() => vi.advanceTimersByTimeAsync(25));
    yield* Effect.promise(() => liveCaughtUp);
    expect(
      reconnected.sent
        .filter((frame) => frame.type === "event")
        .map((frame) => frame.event.event.sequence),
    ).toEqual([2, 3]);
    reconnected.close(1000, "complete");
    expect(rpc.activeConnections()).toBe(0);
  }).pipe(Effect.ensuring(Effect.sync(() => vi.useRealTimers())));
});

it.effect("keeps concurrent subscribers ordered from the same durable source", () => {
  const store = new FakeThreadStore();
  store.events.push(event(0), event(1), event(2));
  const rpc = makeCloudRpc({
    auth: auth(),
    hostedOrigin: "https://control.example.com",
    workspaces,
    eventStore: store.service,
  });
  return Effect.gen(function* () {
    const principal = yield* rpc.authorizeWebSocket(new Headers(authorizationHeaders()));
    const left = new FakeSocket();
    const right = new FakeSocket();
    rpc.openAuthorizedSocket(left, principal);
    rpc.openAuthorizedSocket(right, principal);
    left.emit(subscribe(-1));
    right.emit(subscribe(-1));
    yield* Effect.promise(() =>
      Promise.all([left.waitForFrame("caughtUp"), right.waitForFrame("caughtUp")]),
    );

    for (const socket of [left, right]) {
      expect(
        socket.sent
          .filter((frame) => frame.type === "event")
          .map((frame) => frame.event.event.sequence),
      ).toEqual([0, 1, 2]);
      socket.close(1000, "complete");
    }
    expect(rpc.activeConnections()).toBe(0);
  });
});

it.effect("bounds slow consumers and cleans connection and subscription state", () => {
  const store = new FakeThreadStore();
  store.events.push(event(0), event(1), event(2));
  const signals = makeThreadEventSignalHub();
  const rpc = makeCloudRpc({
    auth: auth(),
    hostedOrigin: "https://control.example.com",
    workspaces,
    eventStore: store.service,
    signals,
    limits: { maxQueuedFrames: 2, maxQueuedBytes: 1_000_000 },
  });
  return Effect.gen(function* () {
    const principal = yield* rpc.authorizeWebSocket(new Headers(authorizationHeaders()));
    const socket = new FakeSocket(true);
    rpc.openAuthorizedSocket(socket, principal);
    socket.emit(subscribe(-1));
    expect(yield* Effect.promise(() => socket.waitForClose())).toEqual({
      code: 4413,
      reason: "slow_consumer",
    });
    expect(rpc.activeConnections()).toBe(0);
    expect(signals.subscriberCount()).toBe(0);
  });
});

it.effect("closes malformed, binary, oversized, replay-gap, and excess connections", () => {
  const store = new FakeThreadStore();
  const rpc = makeCloudRpc({
    auth: auth(),
    hostedOrigin: "https://control.example.com",
    workspaces,
    eventStore: store.service,
    limits: { maxFrameBytes: 256, maxConnections: 1, maxConnectionsPerWorkspace: 1 },
  });
  return Effect.gen(function* () {
    const principal = yield* rpc.authorizeWebSocket(new Headers(authorizationHeaders()));
    const malformed = new FakeSocket();
    rpc.openAuthorizedSocket(malformed, principal);
    malformed.emit("{");
    expect(yield* Effect.promise(() => malformed.waitForClose())).toEqual({
      code: 4400,
      reason: "invalid_frame",
    });

    const binary = new FakeSocket();
    rpc.openAuthorizedSocket(binary, principal);
    binary.emit("binary", true);
    expect(binary.closes).toContainEqual({ code: 1003, reason: "binary_forbidden" });

    const oversized = new FakeSocket();
    rpc.openAuthorizedSocket(oversized, principal);
    oversized.emit("x".repeat(257));
    expect(oversized.closes).toContainEqual({ code: 1009, reason: "frame_too_large" });

    const occupied = new FakeSocket();
    rpc.openAuthorizedSocket(occupied, principal);
    const excess = new FakeSocket();
    rpc.openAuthorizedSocket(excess, principal);
    expect(excess.closes).toContainEqual({ code: 4429, reason: "connection_limit" });
    occupied.close(1000, "done");

    const gap = new FakeSocket();
    rpc.openAuthorizedSocket(gap, principal);
    gap.emit(subscribe(0));
    yield* Effect.promise(() => gap.waitForFrame("error"));
    expect(gap.closes).toContainEqual({ code: 4409, reason: "replayGap" });
  });
});

it.effect(
  "requires heartbeat acknowledgement and releases a disconnected socket exactly once",
  () => {
    vi.useFakeTimers();
    return Effect.gen(function* () {
      const store = new FakeThreadStore();
      const signals = makeThreadEventSignalHub();
      const rpc = makeCloudRpc({
        auth: auth(),
        hostedOrigin: "https://control.example.com",
        workspaces,
        eventStore: store.service,
        signals,
        limits: { heartbeatIntervalMs: 10 },
      });
      const principal = yield* rpc.authorizeWebSocket(new Headers(authorizationHeaders()));
      const socket = new FakeSocket();
      rpc.openAuthorizedSocket(socket, principal);
      socket.emit(subscribe(-1));
      yield* Effect.promise(() => socket.waitForFrame("caughtUp"));

      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(10));
      const heartbeat = yield* Effect.promise(() => socket.waitForFrame("heartbeat"));
      if (heartbeat.type !== "heartbeat") throw new Error("expected heartbeat");
      socket.emit({ protocolVersion: 1, type: "heartbeatAck", nonce: heartbeat.nonce });
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(10));
      yield* Effect.promise(() => socket.waitForFrame("heartbeat"));
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(10));

      expect(socket.closes).toContainEqual({ code: 4408, reason: "heartbeat_timeout" });
      expect(rpc.activeConnections()).toBe(0);
      expect(signals.subscriberCount()).toBe(0);
    }).pipe(Effect.ensuring(Effect.sync(() => vi.useRealTimers())));
  },
);
