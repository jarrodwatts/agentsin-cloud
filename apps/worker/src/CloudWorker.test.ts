// @effect-diagnostics schemaSyncInEffect:off -- Wire fixtures intentionally use the sync encoder.
import { expect, it } from "@effect/vitest";
import { ProviderRuntimeEvent } from "@t3tools/contracts";
import {
  CloudThreadCommand as CloudThreadCommandSchema,
  CloudThreadEvent as CloudThreadEventSchema,
  type CloudThreadCommand,
  type CloudThreadEvent,
} from "@t3tools/contracts/cloud";
import {
  WorkerBootstrap,
  WorkerRelayInbound,
  type WorkerRelayOutbound,
} from "@t3tools/contracts/worker";
import type { InspectorWorkerCommand } from "@t3tools/contracts/inspector";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { runCloudWorker, type CloudWorkerDependencies } from "./CloudWorker.ts";
import { WorkerProtocolError, WorkerProviderError, WorkerRelayError } from "./errors.ts";
import type {
  WorkerProviderSession,
  WorkerRelayConnectInput,
  WorkerRelayConnection,
} from "./ports.ts";
import { WORKER_RELAY_FRAME_MAX_BYTES } from "./protocol.ts";
import { InspectorRuntimeError, type WorkerInspectorRuntime } from "./InspectorRuntime.ts";

const decodeBootstrap = Schema.decodeUnknownSync(WorkerBootstrap);
const decodeCloudCommand = Schema.decodeUnknownSync(CloudThreadCommandSchema);
const decodeCloudEvent = Schema.decodeUnknownSync(CloudThreadEventSchema);
const decodeInbound = Schema.decodeUnknownSync(WorkerRelayInbound);
const encodeInbound = Schema.encodeUnknownSync(Schema.fromJsonString(WorkerRelayInbound));
const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);
const isWorkerProviderError = Schema.is(WorkerProviderError);

const bootstrap = decodeBootstrap({
  schemaVersion: 1,
  workerId: "worker-1",
  workspaceId: "workspace-1",
  environmentId: "environment-1",
  environmentRevisionId: "revision-1",
  threadId: "thread-1",
  sandboxId: "sandbox-1",
  reservationId: "command-reserve-1",
  provider: { instanceId: "codex_personal", driver: "codex" },
  workspaceDirectory: "/workspace/project",
  bootstrapEndpoint: "https://control.example.com/api/v1/worker-certificates/bootstrap",
  relayEndpoint: "wss://control.example.com/worker",
  relayServerSpkiSha256: "sha256/47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
  relayCredentialRef: "relay-ref-1",
  secretLeaseRef: "lease-ref-1",
  issuedAt: "2026-08-27T00:00:00.000Z",
  expiresAt: "2026-08-27T01:00:00.000Z",
});

const interruptCommand = (id: string): CloudThreadCommand =>
  decodeCloudCommand({
    schemaVersion: 1,
    workspaceId: bootstrap.workspaceId,
    environmentId: bootstrap.environmentId,
    threadId: bootstrap.threadId,
    command: {
      type: "thread.turn.interrupt",
      commandId: id,
      threadId: bootstrap.threadId,
      createdAt: "2026-08-27T00:30:00.000Z",
    },
    enqueuedAt: "2026-08-27T00:30:00.000Z",
  });

const confirmedEvent = (sequence: number, eventId: string): CloudThreadEvent =>
  decodeCloudEvent({
    schemaVersion: 1,
    workspaceId: bootstrap.workspaceId,
    environmentId: bootstrap.environmentId,
    threadId: bootstrap.threadId,
    event: {
      sequence,
      eventId,
      aggregateKind: "thread",
      aggregateId: bootstrap.threadId,
      occurredAt: "2026-08-27T00:30:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.session-stop-requested",
      payload: {
        threadId: bootstrap.threadId,
        createdAt: "2026-08-27T00:30:00.000Z",
      },
    },
    receivedAt: "2026-08-27T00:30:00.000Z",
  });

const frame = (message: unknown): Uint8Array => Buffer.from(encodeInbound(decodeInbound(message)));

const runtimeEvent = (eventId: string, message: string) =>
  decodeRuntimeEvent({
    eventId,
    provider: bootstrap.provider.driver,
    providerInstanceId: bootstrap.provider.instanceId,
    threadId: bootstrap.threadId,
    createdAt: "2026-08-27T00:30:00.000Z",
    type: "runtime.warning",
    payload: { message },
  });

const NEVER_FRAME = Symbol("never-frame");
type FrameFixture = unknown | Uint8Array | null | typeof NEVER_FRAME;

interface HarnessOptions {
  readonly connections: ReadonlyArray<ReadonlyArray<FrameFixture>>;
  readonly dispatch?: (
    command: CloudThreadCommand,
    emit: Parameters<CloudWorkerDependencies["provider"]["start"]>[0]["emit"],
    startIndex: number,
  ) => Effect.Effect<void, WorkerProviderError | WorkerRelayError | WorkerProtocolError>;
  readonly claim?: (
    command: CloudThreadCommand,
    connectionIndex: number,
  ) => "execute" | "completed" | "in-flight";
  readonly failSend?: (message: WorkerRelayOutbound, connectionIndex: number) => boolean;
  readonly onSend?: (message: WorkerRelayOutbound, connectionIndex: number) => Effect.Effect<void>;
  readonly onProviderStart?: (
    emit: Parameters<CloudWorkerDependencies["provider"]["start"]>[0]["emit"],
    startIndex: number,
  ) => void;
  readonly maxPendingEventProposals?: number;
  readonly maxTrackedConfirmations?: number;
  readonly maxPendingEventAcks?: number;
  readonly heartbeatInterval?: Effect.Effect<void>;
  readonly inspector?: WorkerInspectorRuntime;
}

const makeHarness = (options: HarnessOptions) => {
  const sent: Array<WorkerRelayOutbound> = [];
  const sendAttempts: Array<{
    readonly connectionIndex: number;
    readonly message: WorkerRelayOutbound;
  }> = [];
  const connectInputs: Array<WorkerRelayConnectInput> = [];
  const claimed = new Set<string>();
  const observed: Array<CloudThreadEvent> = [];
  let connectionIndex = 0;
  let providerStarts = 0;
  let providerStops = 0;
  let scrubs = 0;
  let relayCloses = 0;
  let proposal = 0;

  const dependencies: CloudWorkerDependencies = {
    relay: {
      connect: (input) =>
        Effect.sync(() => {
          connectInputs.push(input);
          const currentConnectionIndex = connectionIndex++;
          const source = [...(options.connections[currentConnectionIndex] ?? [null])];
          const connection: WorkerRelayConnection = {
            credentialChannelKey: new Uint8Array(32),
            receive: Effect.suspend(() => {
              const next = source.shift() ?? null;
              if (next === NEVER_FRAME) return Effect.never;
              if (next === null) return Effect.succeed(Option.none());
              return Effect.succeed(Option.some(next instanceof Uint8Array ? next : frame(next)));
            }),
            claimCommand: (cloudCommand) =>
              Effect.sync(() => {
                const explicit = options.claim?.(cloudCommand, currentConnectionIndex);
                if (explicit !== undefined) return explicit;
                const commandId = cloudCommand.command.commandId;
                if (claimed.has(commandId)) return "completed" as const;
                claimed.add(commandId);
                return "execute" as const;
              }),
            send: (message) =>
              Effect.gen(function* () {
                sendAttempts.push({ connectionIndex: currentConnectionIndex, message });
                yield* options.onSend?.(message, currentConnectionIndex) ?? Effect.void;
                if (options.failSend?.(message, currentConnectionIndex) === true) {
                  return yield* new WorkerRelayError({
                    operation: "send",
                    retryable: true,
                    cause: "injected send failure",
                  });
                }
                sent.push(message);
              }),
            close: Effect.sync(() => {
              relayCloses += 1;
            }),
          };
          return connection;
        }),
    },
    provider: {
      start: ({ emit }) =>
        Effect.sync(() => {
          const startIndex = providerStarts++;
          options.onProviderStart?.(emit, startIndex);
          const session: WorkerProviderSession = {
            dispatch: (cloudCommand) =>
              (options.dispatch?.(cloudCommand, emit, startIndex) ?? Effect.void).pipe(
                Effect.mapError((cause) =>
                  isWorkerProviderError(cause)
                    ? cause
                    : new WorkerProviderError({
                        operation: "dispatch",
                        crashed: false,
                        cause,
                      }),
                ),
              ),
            health: Effect.succeed("ready"),
            stop: Effect.sync(() => {
              providerStops += 1;
            }),
          };
          return session;
        }),
    },
    secretLease: {
      materialize: () =>
        Effect.succeed({
          leaseRef: bootstrap.secretLeaseRef,
          credentialDirectory: "/run/agentsin/credentials",
          environmentVariableNames: ["CODEX_HOME"],
          containsWalletMaterial: false,
          makeInspectorOutputRedactor: () => (chunk) => chunk,
          scrub: Effect.sync(() => {
            scrubs += 1;
          }),
        }),
    },
    clock: { now: Effect.succeed("2026-08-27T00:30:00.000Z") },
    ids: {
      nextProposalId: Effect.sync(() => `proposal-${++proposal}` as never),
    },
    logger: {
      info: () => Effect.void,
      warn: () => Effect.void,
      error: () => Effect.void,
    },
    onCloudEvent: (event) =>
      Effect.sync(() => {
        observed.push(event);
      }),
    ...(options.inspector === undefined ? {} : { inspector: options.inspector }),
    options: {
      beforeReconnect: Effect.void,
      ...(options.maxPendingEventProposals === undefined
        ? {}
        : { maxPendingEventProposals: options.maxPendingEventProposals }),
      ...(options.maxTrackedConfirmations === undefined
        ? {}
        : { maxTrackedConfirmations: options.maxTrackedConfirmations }),
      ...(options.maxPendingEventAcks === undefined
        ? {}
        : { maxPendingEventAcks: options.maxPendingEventAcks }),
      ...(options.heartbeatInterval === undefined
        ? {}
        : { heartbeatInterval: options.heartbeatInterval }),
    },
  };

  return {
    dependencies,
    sent,
    sendAttempts,
    connectInputs,
    observed,
    counts: () => ({ providerStarts, providerStops, scrubs, relayCloses }),
  };
};

const inspectorOpenCommand = (workspaceId = bootstrap.workspaceId): InspectorWorkerCommand => ({
  type: "inspector.open",
  binding: {
    protocolVersion: 1,
    workspaceId,
    threadId: bootstrap.threadId,
    attemptId: "attempt-1" as never,
    environmentId: bootstrap.environmentId,
    environmentRevisionId: bootstrap.environmentRevisionId,
    providerInstanceId: bootstrap.provider.instanceId,
    providerDriver: bootstrap.provider.driver,
    sandboxId: bootstrap.sandboxId,
    workerId: bootstrap.workerId as never,
    routeGeneration: 1,
  },
  sessionId: "session-1" as never,
  resumeAfterSequence: -1,
});

it.effect("routes inspector commands only through the sealed worker identity", () => {
  const handled: Array<InspectorWorkerCommand> = [];
  let closed = 0;
  const inspector: WorkerInspectorRuntime = {
    handle: (command, sink) => {
      handled.push(command);
      return sink
        .emit({
          type: "inspector.ready",
          binding: command.binding,
          sessionId: command.sessionId,
          sequence: 0,
          emittedAt: "2026-08-27T00:30:00.000Z",
          capabilities: {
            terminal: true,
            files: true,
            ports: false,
            browserFrames: false,
            browserInput: false,
            desktopFrames: false,
            desktopInput: false,
            desktopBackend: "unsupported",
          },
        })
        .pipe(Effect.catch(() => Effect.void));
    },
    drain: Effect.void,
    close: Effect.sync(() => {
      closed += 1;
    }),
  };
  const harness = makeHarness({
    connections: [
      [
        { type: "inspector.command", command: inspectorOpenCommand() },
        { type: "worker.shutdown", reason: "test complete" },
      ],
    ],
    inspector,
  });
  return runCloudWorker(bootstrap, harness.dependencies).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        expect(handled).toHaveLength(1);
        expect(harness.sent.some((message) => message.type === "inspector.frame")).toBe(true);
        expect(closed).toBe(1);
      }),
    ),
  );
});

it.effect("rejects every sealed inspector binding mismatch before dispatch", () =>
  Effect.gen(function* () {
    const valid = inspectorOpenCommand();
    if (valid.type !== "inspector.open") return;
    const mismatches = [
      { workspaceId: "workspace-forged" as never },
      { threadId: "thread-forged" as never },
      { environmentId: "environment-forged" as never },
      { environmentRevisionId: "revision-forged" as never },
      { providerInstanceId: "provider-forged" as never },
      { providerDriver: "claude" as never },
      { sandboxId: "sandbox-forged" as never },
      { workerId: "worker-forged" as never },
    ];
    for (const mismatch of mismatches) {
      const command = { ...valid, binding: { ...valid.binding, ...mismatch } };
      const harness = makeHarness({
        connections: [
          [
            { type: "inspector.command", command },
            { type: "worker.shutdown", reason: "must not be reached" },
          ],
        ],
      });
      const result = yield* Effect.result(runCloudWorker(bootstrap, harness.dependencies));
      expect(result._tag).toBe("Failure");
    }
  }),
);

it.effect("deduplicates replayed commands through the authoritative relay claim", () => {
  const first = interruptCommand("command-1");
  const harness = makeHarness({
    connections: [
      [
        { type: "thread.command", deliveryId: "delivery-1", redelivered: false, command: first },
        null,
      ],
      [
        { type: "thread.command", deliveryId: "delivery-2", redelivered: true, command: first },
        { type: "replay.complete", confirmedThroughSequence: -1 },
        { type: "worker.shutdown", reason: "test complete" },
      ],
    ],
  });
  return runCloudWorker(bootstrap, harness.dependencies).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        const acks = harness.sent.filter((message) => message.type === "thread.command.ack");
        expect(acks.map((ack) => ack.status)).toEqual(["accepted", "duplicate"]);
        expect(harness.connectInputs).toHaveLength(2);
        expect(harness.counts()).toEqual({
          providerStarts: 1,
          providerStops: 1,
          scrubs: 1,
          relayCloses: 2,
        });
      }),
    ),
  );
});

it.effect(
  "publishes confirmed events monotonically when acknowledgements arrive out of order",
  () => {
    const harness = makeHarness({
      connections: [
        [
          {
            type: "thread.events.confirmed",
            proposalId: "proposal-2",
            events: [confirmedEvent(1, "event-1")],
          },
          {
            type: "thread.events.confirmed",
            proposalId: "proposal-1",
            events: [confirmedEvent(0, "event-0")],
          },
          { type: "replay.complete", confirmedThroughSequence: 1 },
          { type: "worker.shutdown", reason: "test complete" },
        ],
      ],
    });
    return runCloudWorker(bootstrap, harness.dependencies).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(harness.observed.map((event) => event.event.sequence)).toEqual([0, 1]);
          const eventAcks = harness.sent.filter((message) => message.type === "thread.events.ack");
          expect(eventAcks.map((ack) => ack.confirmedThroughSequence)).toEqual([-1, 1]);
          expect(eventAcks.map((ack) => ack.eventIds)).toEqual([["event-1"], ["event-0"]]);
        }),
      ),
    );
  },
);

it.effect("restarts a crashed provider without retrying the failed command", () => {
  const first = interruptCommand("command-crash");
  const second = interruptCommand("command-after-restart");
  const harness = makeHarness({
    connections: [
      [
        { type: "thread.command", deliveryId: "delivery-1", redelivered: false, command: first },
        { type: "thread.command", deliveryId: "delivery-2", redelivered: false, command: second },
        { type: "replay.complete", confirmedThroughSequence: -1 },
        { type: "worker.shutdown", reason: "test complete" },
      ],
    ],
    dispatch: (_command, _emit, startIndex) =>
      startIndex === 0
        ? Effect.fail(
            new WorkerProviderError({ operation: "dispatch", crashed: true, cause: "exit 137" }),
          )
        : Effect.void,
  });
  return runCloudWorker(bootstrap, harness.dependencies).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        const acks = harness.sent.filter((message) => message.type === "thread.command.ack");
        expect(acks.map((ack) => ack.status)).toEqual(["failed", "accepted"]);
        expect(harness.counts().providerStarts).toBe(2);
      }),
    ),
  );
});

it.effect("bounds pending provider proposals and scrubs credentials on overflow", () => {
  const harness = makeHarness({
    connections: [
      [
        { type: "replay.complete", confirmedThroughSequence: -1 },
        {
          type: "thread.command",
          deliveryId: "delivery-1",
          redelivered: false,
          command: interruptCommand("command-1"),
        },
        { type: "worker.shutdown", reason: "test complete" },
      ],
    ],
    maxPendingEventProposals: 1,
    dispatch: (_command, emit) =>
      emit(runtimeEvent("provider-event-1", "first"), "command-1" as never).pipe(
        Effect.andThen(emit(runtimeEvent("provider-event-2", "second"))),
        Effect.asVoid,
      ),
  });
  return runCloudWorker(bootstrap, harness.dependencies).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        expect(
          harness.sent.filter((message) => message.type === "provider.event.proposed"),
        ).toHaveLength(1);
        expect(harness.counts().providerStarts).toBe(2);
        expect(harness.counts().scrubs).toBe(1);
      }),
    ),
  );
});

it.effect("admits concurrent proposals atomically at the exact queue capacity", () =>
  Effect.gen(function* () {
    const arrivals = yield* Ref.make(0);
    const releaseIds = yield* Deferred.make<void>();
    const outcomes: Array<string> = [];
    const harness = makeHarness({
      connections: [
        [
          { type: "replay.complete", confirmedThroughSequence: -1 },
          {
            type: "thread.command",
            deliveryId: "delivery-capacity",
            redelivered: false,
            command: interruptCommand("command-capacity"),
          },
          { type: "worker.shutdown", reason: "test complete" },
        ],
      ],
      maxPendingEventProposals: 1,
      dispatch: (_command, emit) =>
        Effect.all(
          [
            Effect.exit(emit(runtimeEvent("provider-event-capacity-1", "first"))),
            Effect.exit(emit(runtimeEvent("provider-event-capacity-2", "second"))),
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.tap((results) =>
            Effect.sync(() => {
              outcomes.push(...results.map((result) => result._tag));
            }),
          ),
          Effect.asVoid,
        ),
    });
    const dependencies: CloudWorkerDependencies = {
      ...harness.dependencies,
      ids: {
        nextProposalId: Effect.gen(function* () {
          const arrival = yield* Ref.updateAndGet(arrivals, (value) => value + 1);
          if (arrival === 2) yield* Deferred.succeed(releaseIds, undefined);
          yield* Deferred.await(releaseIds);
          return `proposal-capacity-${arrival}` as never;
        }),
      },
    };

    yield* runCloudWorker(bootstrap, dependencies);

    expect(outcomes.sort()).toEqual(["Failure", "Success"]);
    expect(
      harness.sendAttempts.filter(({ message }) => message.type === "provider.event.proposed"),
    ).toHaveLength(1);
    expect(
      harness.sent.findLast((message) => message.type === "worker.heartbeat")?.health
        .pendingEventProposals,
    ).toBe(1);
  }),
);

it.effect("rejects duplicate proposal ids under concurrent emission", () =>
  Effect.gen(function* () {
    const arrivals = yield* Ref.make(0);
    const releaseIds = yield* Deferred.make<void>();
    const outcomes: Array<string> = [];
    const harness = makeHarness({
      connections: [
        [
          { type: "replay.complete", confirmedThroughSequence: -1 },
          {
            type: "thread.command",
            deliveryId: "delivery-duplicate-proposal",
            redelivered: false,
            command: interruptCommand("command-duplicate-proposal"),
          },
          { type: "worker.shutdown", reason: "test complete" },
        ],
      ],
      maxPendingEventProposals: 2,
      dispatch: (_command, emit) =>
        Effect.all(
          [
            Effect.exit(emit(runtimeEvent("provider-event-duplicate-1", "first"))),
            Effect.exit(emit(runtimeEvent("provider-event-duplicate-2", "second"))),
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.tap((results) =>
            Effect.sync(() => {
              outcomes.push(...results.map((result) => result._tag));
            }),
          ),
          Effect.asVoid,
        ),
    });
    const dependencies: CloudWorkerDependencies = {
      ...harness.dependencies,
      ids: {
        nextProposalId: Effect.gen(function* () {
          const arrival = yield* Ref.updateAndGet(arrivals, (value) => value + 1);
          if (arrival === 2) yield* Deferred.succeed(releaseIds, undefined);
          yield* Deferred.await(releaseIds);
          return "proposal-duplicate" as never;
        }),
      },
    };

    yield* runCloudWorker(bootstrap, dependencies);

    expect(outcomes.sort()).toEqual(["Failure", "Success"]);
    expect(
      harness.sendAttempts.filter(({ message }) => message.type === "provider.event.proposed"),
    ).toHaveLength(1);
  }),
);

it.effect("preserves proposal admission order across a reconnecting failed drain", () => {
  const harness = makeHarness({
    connections: [
      [
        {
          type: "thread.command",
          deliveryId: "delivery-backlog",
          redelivered: false,
          command: interruptCommand("command-backlog"),
        },
        {
          type: "thread.command",
          deliveryId: "delivery-newer",
          redelivered: false,
          command: interruptCommand("command-newer"),
        },
        { type: "replay.complete", confirmedThroughSequence: -1 },
      ],
      [
        { type: "replay.complete", confirmedThroughSequence: -1 },
        { type: "worker.shutdown", reason: "test complete" },
      ],
    ],
    dispatch: (command, emit) =>
      emit(
        runtimeEvent(
          command.command.commandId === "command-backlog"
            ? "provider-event-backlog"
            : "provider-event-newer",
          "queued while replaying",
        ),
      ).pipe(Effect.asVoid),
    failSend: (message, connectionIndex) =>
      connectionIndex === 0 && message.type === "provider.event.proposed",
  });

  return runCloudWorker(bootstrap, harness.dependencies).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        const proposalAttempts = harness.sendAttempts.flatMap(({ connectionIndex, message }) =>
          message.type === "provider.event.proposed"
            ? [{ connectionIndex, eventId: message.runtimeEvent.eventId }]
            : [],
        );
        expect(proposalAttempts).toEqual([
          { connectionIndex: 0, eventId: "provider-event-backlog" },
          { connectionIndex: 1, eventId: "provider-event-backlog" },
          { connectionIndex: 1, eventId: "provider-event-newer" },
        ]);
      }),
    ),
  );
});

it.effect("drains reconnect backlog before a concurrent live proposal", () =>
  Effect.gen(function* () {
    const liveIdRequested = yield* Deferred.make<void>();
    const idSequence = yield* Ref.make(0);
    let liveEmit: Parameters<CloudWorkerDependencies["provider"]["start"]>[0]["emit"] | undefined;
    const harness = makeHarness({
      connections: [
        [
          {
            type: "thread.command",
            deliveryId: "delivery-reconnect-backlog",
            redelivered: false,
            command: interruptCommand("command-reconnect-backlog"),
          },
          {
            type: "thread.events.confirmed",
            proposalId: "proposal-from-prior-worker",
            events: [confirmedEvent(0, "event-from-prior-worker")],
          },
          { type: "replay.complete", confirmedThroughSequence: 0 },
          { type: "worker.shutdown", reason: "test complete" },
        ],
      ],
      onProviderStart: (emit) => {
        liveEmit = emit;
      },
      dispatch: (_command, emit) =>
        emit(runtimeEvent("provider-event-reconnect-backlog", "older backlog")).pipe(Effect.asVoid),
      onSend: (message) => {
        if (message.type !== "thread.events.ack") return Effect.void;
        const emit = liveEmit;
        if (emit === undefined) return Effect.die("provider emit was not captured");
        return Effect.gen(function* () {
          yield* emit(runtimeEvent("provider-event-live", "newer live event")).pipe(
            Effect.asVoid,
            Effect.forkChild,
          );
          yield* Deferred.await(liveIdRequested);
          yield* Effect.yieldNow;
        });
      },
    });
    const dependencies: CloudWorkerDependencies = {
      ...harness.dependencies,
      ids: {
        nextProposalId: Ref.updateAndGet(idSequence, (value) => value + 1).pipe(
          Effect.tap((value) =>
            value === 2 ? Deferred.succeed(liveIdRequested, undefined) : Effect.void,
          ),
          Effect.map((value) => `proposal-transition-${value}` as never),
        ),
      },
    };

    yield* runCloudWorker(bootstrap, dependencies);

    expect(
      harness.sent.flatMap((message) =>
        message.type === "provider.event.proposed" ? [message.runtimeEvent.eventId] : [],
      ),
    ).toEqual(["provider-event-reconnect-backlog", "provider-event-live"]);
  }),
);

it.effect("rejects malformed and oversized relay frames and still cleans up", () =>
  Effect.gen(function* () {
    for (const invalid of [Buffer.from("{"), new Uint8Array(WORKER_RELAY_FRAME_MAX_BYTES + 1)]) {
      const harness = makeHarness({ connections: [[invalid]] });
      const exit = yield* Effect.exit(runCloudWorker(bootstrap, harness.dependencies));
      expect(exit._tag).toBe("Failure");
      expect(harness.counts().providerStops).toBe(1);
      expect(harness.counts().scrubs).toBe(1);
    }
  }),
);

it.effect("rejects commands whose workspace identity differs from the sealed bootstrap", () => {
  let dispatches = 0;
  const command = decodeCloudCommand({
    ...interruptCommand("command-tampered"),
    workspaceId: "workspace-other",
  });
  const harness = makeHarness({
    connections: [
      [
        {
          type: "thread.command",
          deliveryId: "delivery-tampered",
          redelivered: false,
          command,
        },
        { type: "worker.shutdown", reason: "test complete" },
      ],
    ],
    dispatch: () =>
      Effect.sync(() => {
        dispatches += 1;
      }),
  });
  return runCloudWorker(bootstrap, harness.dependencies).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        const acks = harness.sent.filter((message) => message.type === "thread.command.ack");
        expect(acks.map((ack) => ack.status)).toEqual(["rejected"]);
        expect(dispatches).toBe(0);
      }),
    ),
  );
});

it.effect("rejects and scrubs a secret lease containing wallet material", () => {
  let scrubs = 0;
  const harness = makeHarness({ connections: [[]] });
  const dependencies: CloudWorkerDependencies = {
    ...harness.dependencies,
    secretLease: {
      materialize: () =>
        Effect.succeed({
          leaseRef: bootstrap.secretLeaseRef,
          credentialDirectory: "/run/agentsin/credentials",
          environmentVariableNames: ["WALLET_PRIVATE_KEY"],
          containsWalletMaterial: false,
          makeInspectorOutputRedactor: () => (chunk) => chunk,
          scrub: Effect.sync(() => {
            scrubs += 1;
          }),
        }),
    },
  };
  return Effect.exit(runCloudWorker(bootstrap, dependencies)).pipe(
    Effect.tap((exit) =>
      Effect.sync(() => {
        expect(exit._tag).toBe("Failure");
        expect(scrubs).toBe(1);
        expect(harness.connectInputs).toHaveLength(0);
      }),
    ),
  );
});

it.effect("scrubs provider credentials before a failing inspector factory runs", () => {
  const harness = makeHarness({ connections: [[]] });
  let factoryObservedScrub = false;
  const dependencies: CloudWorkerDependencies = {
    ...harness.dependencies,
    inspectorFactory: {
      make: () =>
        Effect.sync(() => {
          factoryObservedScrub = harness.counts().scrubs === 1;
        }).pipe(
          Effect.andThen(
            Effect.fail(
              new InspectorRuntimeError({
                code: "unsupported",
                retryable: false,
                operation: "injected-factory-failure",
              }),
            ),
          ),
        ),
    },
  };
  return Effect.exit(runCloudWorker(bootstrap, dependencies)).pipe(
    Effect.tap((exit) =>
      Effect.sync(() => {
        expect(exit._tag).toBe("Failure");
        expect(factoryObservedScrub).toBe(true);
        expect(harness.counts()).toMatchObject({ providerStarts: 1, providerStops: 1, scrubs: 1 });
        expect(harness.connectInputs).toHaveLength(0);
      }),
    ),
  );
});

it.effect("requests replay from the last control-plane-confirmed durable sequence", () => {
  const harness = makeHarness({
    connections: [
      [
        {
          type: "thread.events.confirmed",
          proposalId: "proposal-1",
          events: [confirmedEvent(0, "event-0")],
        },
        null,
      ],
      [{ type: "replay.complete", confirmedThroughSequence: 0 }, null],
      [
        { type: "replay.complete", confirmedThroughSequence: 0 },
        { type: "worker.shutdown", reason: "test complete" },
      ],
    ],
  });
  return runCloudWorker(bootstrap, harness.dependencies).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        expect(harness.connectInputs.map((input) => input.confirmedThroughSequence)).toEqual([
          -1, -1, 0,
        ]);
      }),
    ),
  );
});

it.effect("enters reconciliation instead of replaying an in-flight command side effect", () => {
  let dispatches = 0;
  const harness = makeHarness({
    connections: [
      [
        { type: "replay.complete", confirmedThroughSequence: -1 },
        {
          type: "thread.command",
          deliveryId: "delivery-in-flight",
          redelivered: true,
          command: interruptCommand("command-in-flight"),
        },
        {
          type: "thread.command",
          deliveryId: "delivery-blocked",
          redelivered: false,
          command: interruptCommand("command-blocked"),
        },
        { type: "worker.shutdown", reason: "test complete" },
      ],
    ],
    claim: () => "in-flight",
    dispatch: () =>
      Effect.sync(() => {
        dispatches += 1;
      }),
  });
  return runCloudWorker(bootstrap, harness.dependencies).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        const acks = harness.sent.filter((message) => message.type === "thread.command.ack");
        expect(acks.map((ack) => ack.status)).toEqual([
          "needs-reconciliation",
          "needs-reconciliation",
        ]);
        expect(dispatches).toBe(0);
        const health = harness.sent.filter((message) => message.type === "worker.heartbeat");
        expect(health.at(-1)?.health).toMatchObject({
          recoveryState: "needs-reconciliation",
          ready: false,
        });
      }),
    ),
  );
});

it.effect(
  "retains an acknowledgement across send failure before advancing the replay cursor",
  () => {
    const confirmation = {
      type: "thread.events.confirmed",
      proposalId: "proposal-ack",
      events: [confirmedEvent(0, "event-0")],
    };
    const harness = makeHarness({
      connections: [
        [confirmation, { type: "replay.complete", confirmedThroughSequence: 0 }],
        [confirmation, { type: "replay.complete", confirmedThroughSequence: 0 }, null],
        [
          { type: "replay.complete", confirmedThroughSequence: 0 },
          { type: "worker.shutdown", reason: "test complete" },
        ],
      ],
      failSend: (message, connectionIndex) =>
        connectionIndex === 0 && message.type === "thread.events.ack",
    });
    return runCloudWorker(bootstrap, harness.dependencies).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(harness.observed.map((event) => event.event.sequence)).toEqual([0]);
          expect(harness.connectInputs.map((input) => input.confirmedThroughSequence)).toEqual([
            -1, -1, 0,
          ]);
          const ackAttempts = harness.sendAttempts.filter(
            ({ message }) => message.type === "thread.events.ack",
          );
          expect(ackAttempts).toHaveLength(2);
          expect(
            ackAttempts.map(({ message }) =>
              message.type === "thread.events.ack" ? message.eventIds : [],
            ),
          ).toEqual([["event-0"], ["event-0"]]);
        }),
      ),
    );
  },
);

it.effect("acks every event in an out-of-order multi-event proposal", () => {
  const harness = makeHarness({
    connections: [
      [
        {
          type: "thread.events.confirmed",
          proposalId: "proposal-batch",
          events: [confirmedEvent(1, "event-1"), confirmedEvent(0, "event-0")],
        },
        { type: "replay.complete", confirmedThroughSequence: 1 },
        { type: "worker.shutdown", reason: "test complete" },
      ],
    ],
  });
  return runCloudWorker(bootstrap, harness.dependencies).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        const acks = harness.sent.filter((message) => message.type === "thread.events.ack");
        expect(acks).toHaveLength(1);
        expect(acks[0]).toMatchObject({
          eventIds: ["event-0", "event-1"],
          confirmedThroughSequence: 1,
        });
      }),
    ),
  );
});

it.effect("fails closed when cumulative out-of-order confirmation state exceeds its bound", () => {
  const harness = makeHarness({
    connections: [
      [
        {
          type: "thread.events.confirmed",
          proposalId: "proposal-10",
          events: [confirmedEvent(10, "event-10")],
        },
        {
          type: "thread.events.confirmed",
          proposalId: "proposal-11",
          events: [confirmedEvent(11, "event-11")],
        },
        {
          type: "thread.events.confirmed",
          proposalId: "proposal-12",
          events: [confirmedEvent(12, "event-12")],
        },
      ],
    ],
    maxTrackedConfirmations: 2,
  });
  return Effect.exit(runCloudWorker(bootstrap, harness.dependencies)).pipe(
    Effect.tap((exit) =>
      Effect.sync(() => {
        expect(exit._tag).toBe("Failure");
        expect(harness.observed).toHaveLength(0);
      }),
    ),
  );
});

it.effect("keeps provider ingestion alive and replays queued proposals after relay loss", () => {
  const harness = makeHarness({
    connections: [
      [
        { type: "replay.complete", confirmedThroughSequence: -1 },
        {
          type: "thread.command",
          deliveryId: "delivery-event",
          redelivered: false,
          command: interruptCommand("command-event"),
        },
        NEVER_FRAME,
      ],
      [
        { type: "replay.complete", confirmedThroughSequence: -1 },
        {
          type: "thread.events.confirmed",
          proposalId: "proposal-1",
          events: [confirmedEvent(0, "event-0")],
        },
        { type: "worker.shutdown", reason: "test complete" },
      ],
    ],
    failSend: (message, connectionIndex) =>
      connectionIndex === 0 && message.type === "provider.event.proposed",
    dispatch: (_command, emit) =>
      emit(runtimeEvent("provider-event-outage", "relay unavailable")).pipe(Effect.asVoid),
  });
  return runCloudWorker(bootstrap, harness.dependencies).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        const proposals = harness.sent.filter(
          (message) => message.type === "provider.event.proposed",
        );
        expect(proposals).toHaveLength(1);
        expect(proposals[0]).toMatchObject({ proposalId: "proposal-1" });
        expect(harness.counts().providerStarts).toBe(1);
        expect(harness.connectInputs).toHaveLength(2);
        expect(
          harness.sent.some(
            (message) =>
              message.type === "worker.heartbeat" &&
              !message.health.ready &&
              message.health.pendingEventProposals === 1,
          ),
        ).toBe(true);
      }),
    ),
  );
});

it.effect("emits periodic idle heartbeats and cancels the heartbeat fiber on shutdown", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      const idle = yield* Deferred.make<void>();
      let heartbeats = 0;
      const harness = makeHarness({
        connections: [[{ type: "replay.complete", confirmedThroughSequence: -1 }, NEVER_FRAME]],
        onSend: (message) =>
          Effect.gen(function* () {
            if (message.type === "worker.ready") yield* Deferred.succeed(ready, undefined);
            if (message.type === "worker.heartbeat") {
              heartbeats += 1;
              if (heartbeats === 2) yield* Deferred.succeed(idle, undefined);
            }
          }),
      });
      const fiber = yield* runCloudWorker(bootstrap, harness.dependencies).pipe(Effect.forkScoped);
      yield* Deferred.await(ready);
      yield* Deferred.await(idle);
      const beforeIdleAdvance = heartbeats;
      yield* TestClock.adjust("15 seconds");
      expect(heartbeats).toBeGreaterThan(beforeIdleAdvance);
      yield* Fiber.interrupt(fiber);
      expect(harness.counts()).toMatchObject({
        providerStops: 1,
        scrubs: 1,
        relayCloses: 1,
      });
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);
