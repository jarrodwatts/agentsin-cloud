// @effect-diagnostics nodeBuiltinImport:off -- Relay frame sizing and connection ids use Node primitives at the transport boundary.
// @effect-diagnostics globalTimers:off -- Heartbeat deadlines are per-connection and cleared during deterministic cleanup.
// @effect-diagnostics runEffectInsideEffect:off -- Native WebSocket callbacks re-enter the fully constructed Effect service.
import * as NodeCrypto from "node:crypto";

import type { CloudThreadCommand } from "@t3tools/contracts/cloud";
import {
  WorkerRelayOutbound,
  type WorkerCommandClaimResponse,
  type WorkerDeliveryId,
  type WorkerRelayInbound,
} from "@t3tools/contracts/worker";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  PRESENCE_HEARTBEAT_RATE_POLICY,
  type EphemeralCoordinationService,
} from "./ephemeralCoordination.ts";
import {
  WorkerIdentityError,
  type ActiveWorkerLease,
  type WorkerCertificateRecord,
  type WorkerIdentity,
  type WorkerIdentityService,
} from "./workerIdentity.ts";

export class WorkerRelayServerError extends Schema.TaggedErrorClass<WorkerRelayServerError>()(
  "WorkerRelayServerError",
  {
    code: Schema.Literals([
      "invalidFrame",
      "frameTooLarge",
      "queueFull",
      "transportFailed",
      "identityMismatch",
      "leaseFenced",
      "internal",
    ]),
    operation: Schema.String,
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {}

const isWorkerRelayServerError = Schema.is(WorkerRelayServerError);

export interface WorkerRelaySocket {
  readonly send: (payload: string, complete: (error?: Error) => void) => void;
  readonly close: (code: number, reason: string) => void;
  readonly onMessage: (listener: (payload: Uint8Array, binary: boolean) => void) => () => void;
  readonly onClose: (listener: () => void) => () => void;
}

/** Server-derived identity available only after TLS and certificate-store verification. */
export interface AuthenticatedWorkerPrincipal extends WorkerIdentity {
  readonly certificateFingerprint: string;
  readonly certificateGeneration: number;
}

/** Durable validation result returned before relay-owned cursors are advanced. */
export type WorkerOutboundAcceptance =
  | { readonly type: "accepted" }
  | { readonly type: "event-cursor"; readonly confirmedThroughSequence: number }
  | { readonly type: "command-delivery"; readonly deliveryId: WorkerDeliveryId };

export interface WorkerRecoverySource {
  readonly recover: (
    identity: AuthenticatedWorkerPrincipal,
    cursors: {
      readonly confirmedEventCursor: number;
      readonly lastCommandDeliveryId?: string;
    },
  ) => Effect.Effect<ReadonlyArray<WorkerRelayInbound>, WorkerRelayServerError>;
  readonly handleOutbound: (
    identity: AuthenticatedWorkerPrincipal,
    message: WorkerRelayOutbound,
  ) => Effect.Effect<WorkerOutboundAcceptance, WorkerRelayServerError>;
  readonly claimCommand: (
    identity: AuthenticatedWorkerPrincipal,
    command: CloudThreadCommand,
  ) => Effect.Effect<WorkerCommandClaimResponse["claim"], WorkerRelayServerError>;
}

export interface WorkerRelayLimits {
  readonly maxFrameBytes: number;
  readonly maxQueuedFrames: number;
  readonly maxQueuedBytes: number;
  readonly heartbeatTimeoutMs: number;
}

export const DEFAULT_WORKER_RELAY_LIMITS: WorkerRelayLimits = {
  maxFrameBytes: 512 * 1024,
  maxQueuedFrames: 128,
  maxQueuedBytes: 2 * 1024 * 1024,
  heartbeatTimeoutMs: 45_000,
};

export interface ActiveWorkerRoute {
  readonly lease: ActiveWorkerLease;
  readonly send: (frame: WorkerRelayInbound) => boolean;
  readonly close: (code: number, reason: string) => void;
}

export interface WorkerRouteActivation {
  readonly accepted: boolean;
  readonly displaced?: ActiveWorkerRoute;
}

export interface WorkerRouteRegistry {
  readonly activate: (route: ActiveWorkerRoute) => WorkerRouteActivation;
  readonly deactivate: (lease: ActiveWorkerLease) => void;
  readonly get: (
    workspaceId: WorkerIdentity["workspaceId"],
    sandboxId: WorkerIdentity["sandboxId"],
  ) => ActiveWorkerRoute | undefined;
  readonly closeSandbox: (
    workspaceId: WorkerIdentity["workspaceId"],
    sandboxId: WorkerIdentity["sandboxId"],
    reason: string,
  ) => void;
  readonly closeThread: (
    workspaceId: WorkerIdentity["workspaceId"],
    threadId: WorkerIdentity["threadId"],
    reason: string,
  ) => void;
  readonly clear: () => void;
  readonly size: () => number;
}

export const makeInMemoryWorkerRouteRegistry = (): WorkerRouteRegistry => {
  const routes = new Map<string, ActiveWorkerRoute>();
  const key = (workspaceId: string, sandboxId: string) => `${workspaceId}\0${sandboxId}`;
  return {
    activate: (route) => {
      const routeKey = key(route.lease.workspaceId, route.lease.sandboxId);
      const previous = routes.get(routeKey);
      if (previous !== undefined && previous.lease.leaseGeneration >= route.lease.leaseGeneration) {
        return { accepted: false };
      }
      routes.set(routeKey, route);
      return {
        accepted: true,
        ...(previous === undefined ? {} : { displaced: previous }),
      };
    },
    deactivate: (lease) => {
      const routeKey = key(lease.workspaceId, lease.sandboxId);
      if (routes.get(routeKey)?.lease.leaseGeneration === lease.leaseGeneration) {
        routes.delete(routeKey);
      }
    },
    get: (workspaceId, sandboxId) => routes.get(key(workspaceId, sandboxId)),
    closeSandbox: (workspaceId, sandboxId, reason) => {
      const route = routes.get(key(workspaceId, sandboxId));
      if (route === undefined) return;
      routes.delete(key(workspaceId, sandboxId));
      route.close(4003, reason);
    },
    closeThread: (workspaceId, threadId, reason) => {
      for (const [routeKey, route] of routes) {
        if (route.lease.workspaceId !== workspaceId || route.lease.threadId !== threadId) continue;
        routes.delete(routeKey);
        route.close(4003, reason);
      }
    },
    clear: () => {
      for (const route of routes.values()) route.close(1012, "relay_restart");
      routes.clear();
    },
    size: () => routes.size,
  };
};

const decodeOutbound = Schema.decodeUnknownSync(Schema.fromJsonString(WorkerRelayOutbound));

const sameRuntimeIdentity = (
  certificate: WorkerCertificateRecord,
  message: WorkerRelayOutbound,
) => {
  if (message.type === "worker.heartbeat" || message.type === "worker.ready") {
    return (
      message.health.workerId === certificate.workerId &&
      message.health.workspaceId === certificate.workspaceId &&
      message.health.environmentId === certificate.environmentId &&
      message.health.environmentRevisionId === certificate.environmentRevisionId &&
      message.health.threadId === certificate.threadId &&
      message.health.sandboxId === certificate.sandboxId
    );
  }
  if (message.type === "provider.event.proposed") {
    return (
      message.runtimeEvent.threadId === certificate.threadId &&
      message.runtimeEvent.provider === certificate.providerDriver &&
      (message.runtimeEvent.providerInstanceId === undefined ||
        message.runtimeEvent.providerInstanceId === certificate.providerInstanceId)
    );
  }
  return true;
};

class BoundedWriter {
  private readonly queue: Array<{ readonly payload: string; readonly bytes: number }> = [];
  private bytes = 0;
  private sending = false;
  private closed = false;

  private readonly socket: WorkerRelaySocket;
  private readonly limits: WorkerRelayLimits;
  private readonly fail: () => void;

  constructor(socket: WorkerRelaySocket, limits: WorkerRelayLimits, fail: () => void) {
    this.socket = socket;
    this.limits = limits;
    this.fail = fail;
  }

  send(frame: WorkerRelayInbound) {
    if (this.closed) return false;
    const payload = JSON.stringify(frame);
    const bytes = Buffer.byteLength(payload);
    if (
      bytes > this.limits.maxFrameBytes ||
      this.queue.length >= this.limits.maxQueuedFrames ||
      this.bytes + bytes > this.limits.maxQueuedBytes
    ) {
      this.fail();
      return false;
    }
    this.queue.push({ payload, bytes });
    this.bytes += bytes;
    this.drain();
    return true;
  }

  dispose() {
    this.closed = true;
    this.queue.length = 0;
    this.bytes = 0;
  }

  private drain() {
    if (this.closed || this.sending) return;
    const next = this.queue[0];
    if (next === undefined) return;
    this.sending = true;
    this.socket.send(next.payload, (error) => {
      this.sending = false;
      if (this.closed) return;
      if (error !== undefined) {
        this.fail();
        return;
      }
      this.queue.shift();
      this.bytes -= next.bytes;
      this.drain();
    });
  }
}

export interface MakeWorkerRelayOptions {
  readonly identities: WorkerIdentityService;
  readonly recovery: WorkerRecoverySource;
  readonly processInstanceId?: string;
  readonly routes?: WorkerRouteRegistry;
  readonly coordination?: EphemeralCoordinationService;
  readonly limits?: Partial<WorkerRelayLimits>;
}

export const makeWorkerRelay = (options: MakeWorkerRelayOptions) => {
  const routes = options.routes ?? makeInMemoryWorkerRouteRegistry();
  const limits = { ...DEFAULT_WORKER_RELAY_LIMITS, ...options.limits };
  const processInstanceId = options.processInstanceId ?? NodeCrypto.randomUUID();
  const coordination = options.coordination;

  const open = (certificate: WorkerCertificateRecord, socket: WorkerRelaySocket) =>
    Effect.gen(function* () {
      const lease = yield* options.identities.activateLease(certificate, processInstanceId);
      let closed = false;
      let heartbeatDeadline: ReturnType<typeof setTimeout> | undefined;
      let inboundFrames = 0;
      let inboundBytes = 0;
      let poisoned = false;
      let processing = Promise.resolve();

      const writer = new BoundedWriter(socket, limits, () => close(4413, "slow_consumer"));
      const routeConnectionId = `${lease.workerId}:${lease.leaseGeneration}`;

      const removeEphemeralRoute = coordination?.removeRoute({
        workspaceId: lease.workspaceId,
        threadId: lease.threadId,
        connectionId: routeConnectionId,
        generation: lease.routeGeneration,
      });
      const removeEphemeralPresence = coordination?.removePresence({
        workspaceId: lease.workspaceId,
        threadId: lease.threadId,
        connectionId: routeConnectionId,
        generation: lease.routeGeneration,
      });

      const cleanup = (state: "disconnected" | "timed_out") => {
        if (closed) return;
        closed = true;
        if (heartbeatDeadline !== undefined) clearTimeout(heartbeatDeadline);
        writer.dispose();
        routes.deactivate(lease);
        if (removeEphemeralRoute !== undefined) {
          void Effect.runPromise(removeEphemeralRoute.pipe(Effect.ignore));
        }
        if (removeEphemeralPresence !== undefined) {
          void Effect.runPromise(removeEphemeralPresence.pipe(Effect.ignore));
        }
        void Effect.runPromise(
          options.identities.disconnectLease(lease, state).pipe(Effect.ignore),
        );
      };
      function close(code: number, reason: string) {
        cleanup(code === 4408 ? "timed_out" : "disconnected");
        socket.close(code, reason);
      }
      const armHeartbeatDeadline = () => {
        if (heartbeatDeadline !== undefined) clearTimeout(heartbeatDeadline);
        heartbeatDeadline = setTimeout(
          () => close(4408, "heartbeat_timeout"),
          limits.heartbeatTimeoutMs,
        );
      };

      const processFrame = (payload: Uint8Array, binary: boolean) =>
        Effect.gen(function* () {
          if (binary || payload.byteLength > limits.maxFrameBytes) {
            return yield* new WorkerRelayServerError({
              code: payload.byteLength > limits.maxFrameBytes ? "frameTooLarge" : "invalidFrame",
              operation: "receive",
            });
          }
          const message = yield* Effect.try({
            try: () => decodeOutbound(Buffer.from(payload).toString("utf8")),
            catch: (cause) =>
              new WorkerRelayServerError({ code: "invalidFrame", operation: "decode", cause }),
          });
          if (!sameRuntimeIdentity(certificate, message)) {
            return yield* new WorkerRelayServerError({
              code: "identityMismatch",
              operation: "validate-frame",
            });
          }
          if (message.type === "worker.heartbeat") {
            yield* options.identities.recordHeartbeat(lease, message).pipe(
              Effect.mapError(
                (cause) =>
                  new WorkerRelayServerError({
                    code: "leaseFenced",
                    operation: "heartbeat",
                    cause,
                  }),
              ),
            );
            if (coordination !== undefined) {
              // Presence is advisory: an established healthy socket remains usable during
              // a transient Valkey outage, while its cross-replica route expires naturally.
              yield* coordination
                .publishRoute({
                  workspaceId: lease.workspaceId,
                  threadId: lease.threadId,
                  connectionId: routeConnectionId,
                  processInstanceId,
                  generation: lease.routeGeneration,
                  ttlMs: limits.heartbeatTimeoutMs,
                })
                .pipe(Effect.catch(() => Effect.void));
              const presenceDecision = yield* coordination.consumeRateLimit({
                workspaceId: lease.workspaceId,
                subjectKind: "worker",
                subjectId: lease.workerId,
                policy: PRESENCE_HEARTBEAT_RATE_POLICY,
              });
              if (presenceDecision.allowed) {
                yield* coordination
                  .heartbeatPresence({
                    workspaceId: lease.workspaceId,
                    threadId: lease.threadId,
                    connectionId: routeConnectionId,
                    kind: "worker",
                    generation: lease.routeGeneration,
                    ttlMs: limits.heartbeatTimeoutMs,
                  })
                  .pipe(
                    Effect.catch((error) =>
                      error.code === "unavailable" ? Effect.void : Effect.fail(error),
                    ),
                  );
              }
            }
            armHeartbeatDeadline();
          }

          const acceptance = yield* options.recovery.handleOutbound(certificate, message);
          if (message.type === "thread.events.ack") {
            if (
              acceptance.type !== "event-cursor" ||
              acceptance.confirmedThroughSequence > message.confirmedThroughSequence
            ) {
              return yield* new WorkerRelayServerError({
                code: "invalidFrame",
                operation: "validate-event-cursor",
              });
            }
            const now = yield* options.identities.clock.now;
            yield* options.identities.repository
              .saveCursors(
                lease,
                { confirmedEventCursor: acceptance.confirmedThroughSequence },
                now,
              )
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new WorkerRelayServerError({
                      code: "leaseFenced",
                      operation: "event-cursor",
                      cause,
                    }),
                ),
              );
          } else if (message.type === "thread.command.ack") {
            if (
              acceptance.type !== "command-delivery" ||
              acceptance.deliveryId !== message.deliveryId
            ) {
              return yield* new WorkerRelayServerError({
                code: "invalidFrame",
                operation: "validate-command-cursor",
              });
            }
            const now = yield* options.identities.clock.now;
            yield* options.identities.repository
              .saveCursors(lease, { commandDeliveryId: acceptance.deliveryId }, now)
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new WorkerRelayServerError({
                      code: "leaseFenced",
                      operation: "command-cursor",
                      cause,
                    }),
                ),
              );
          } else if (acceptance.type !== "accepted") {
            return yield* new WorkerRelayServerError({
              code: "invalidFrame",
              operation: "validate-outbound-acceptance",
            });
          }
        });

      const removeClose = socket.onClose(() => cleanup("disconnected"));
      const recovered = yield* options.recovery
        .recover(certificate, {
          confirmedEventCursor: lease.confirmedEventCursor,
          ...(lease.lastCommandDeliveryId === undefined
            ? {}
            : { lastCommandDeliveryId: lease.lastCommandDeliveryId }),
        })
        .pipe(Effect.tapError(() => Effect.sync(() => close(1011, "relay_recovery_failed"))));
      for (const frame of recovered) {
        if (!writer.send(frame)) {
          return yield* new WorkerRelayServerError({
            code: "queueFull",
            operation: "enqueue-replay",
          });
        }
      }
      if (
        !writer.send({
          type: "replay.complete",
          confirmedThroughSequence: lease.confirmedEventCursor,
        })
      ) {
        return yield* new WorkerRelayServerError({
          code: "queueFull",
          operation: "enqueue-replay-complete",
        });
      }

      if (coordination !== undefined) {
        const published = yield* coordination
          .publishRoute({
            workspaceId: lease.workspaceId,
            threadId: lease.threadId,
            connectionId: routeConnectionId,
            processInstanceId,
            generation: lease.routeGeneration,
            ttlMs: limits.heartbeatTimeoutMs,
          })
          .pipe(Effect.tapError(() => Effect.sync(() => close(1011, "route_publish_failed"))));
        if (published === "stale") {
          close(4009, "worker_replaced");
          return yield* new WorkerRelayServerError({
            code: "leaseFenced",
            operation: "publish-route",
          });
        }
      }
      const route: ActiveWorkerRoute = {
        lease,
        send: (frame) => writer.send(frame),
        close,
      };
      const activation = routes.activate(route);
      if (!activation.accepted) {
        close(4009, "worker_replaced");
        return yield* new WorkerRelayServerError({
          code: "leaseFenced",
          operation: "activate-route",
        });
      }
      activation.displaced?.close(4009, "worker_replaced");

      const removeMessage = socket.onMessage((payload, binary) => {
        if (closed) return;
        if (
          inboundFrames >= limits.maxQueuedFrames ||
          inboundBytes + payload.byteLength > limits.maxQueuedBytes
        ) {
          close(4413, "inbound_queue_full");
          return;
        }
        inboundFrames += 1;
        inboundBytes += payload.byteLength;
        processing = processing
          .then(async () => {
            if (closed || poisoned) return;
            try {
              await Effect.runPromise(processFrame(payload, binary));
            } catch {
              poisoned = true;
              close(4400, "invalid_worker_frame");
            }
          })
          .finally(() => {
            inboundFrames -= 1;
            inboundBytes -= payload.byteLength;
          });
      });
      armHeartbeatDeadline();

      return {
        lease,
        close: () => {
          removeMessage();
          removeClose();
          close(1001, "relay_closing");
        },
      };
    }).pipe(
      Effect.mapError((cause) =>
        isWorkerRelayServerError(cause)
          ? cause
          : new WorkerRelayServerError({ code: "internal", operation: "open", cause }),
      ),
    );

  const claimCommand = (certificate: WorkerCertificateRecord, command: CloudThreadCommand) => {
    if (
      command.workspaceId !== certificate.workspaceId ||
      command.threadId !== certificate.threadId ||
      command.environmentId !== certificate.environmentId
    ) {
      return Effect.fail(
        new WorkerRelayServerError({ code: "identityMismatch", operation: "claim-command" }),
      );
    }
    return options.recovery.claimCommand(certificate, command);
  };

  const initialize = options.identities.clock.now.pipe(
    Effect.flatMap((now) => options.identities.repository.recoverProcess(processInstanceId, now)),
    Effect.tap(() => Effect.sync(() => routes.clear())),
  );

  const fenceSandboxForReplacement = (
    workspaceId: WorkerIdentity["workspaceId"],
    threadId: WorkerIdentity["threadId"],
    sandboxId: WorkerIdentity["sandboxId"],
    reason: string,
  ) =>
    options.identities.fenceSandbox(workspaceId, sandboxId, reason).pipe(
      Effect.tap(() =>
        Effect.sync(() => routes.closeSandbox(workspaceId, sandboxId, "worker_fenced")),
      ),
      Effect.tap((identities) =>
        identities.some((identity) => identity.threadId !== threadId)
          ? Effect.fail(
              new WorkerRelayServerError({
                code: "identityMismatch",
                operation: "fence-sandbox-for-replacement",
              }),
            )
          : Effect.void,
      ),
      Effect.tap(() =>
        coordination === undefined
          ? Effect.void
          : coordination
              .clearThreadTransient(workspaceId, threadId)
              .pipe(
                Effect.catch(() =>
                  Effect.logWarning("Valkey transient cleanup failed after sandbox replacement"),
                ),
              ),
      ),
    );

  const pauseThread = (
    workspaceId: WorkerIdentity["workspaceId"],
    threadId: WorkerIdentity["threadId"],
  ) =>
    Effect.sync(() => routes.closeThread(workspaceId, threadId, "worker_paused")).pipe(
      Effect.andThen(
        coordination === undefined
          ? Effect.void
          : coordination
              .clearThreadTransient(workspaceId, threadId)
              .pipe(
                Effect.catch(() => Effect.logWarning("Valkey transient cleanup failed on pause")),
              ),
      ),
    );

  const retireThreadTerminal = (
    workspaceId: WorkerIdentity["workspaceId"],
    threadId: WorkerIdentity["threadId"],
    sandboxId: WorkerIdentity["sandboxId"],
    reason: string,
  ) =>
    options.identities.fenceSandbox(workspaceId, sandboxId, reason).pipe(
      Effect.tap(() =>
        Effect.sync(() => routes.closeThread(workspaceId, threadId, "thread_retired")),
      ),
      Effect.andThen(
        coordination === undefined
          ? Effect.void
          : coordination.retireThreadTerminal(workspaceId, threadId),
      ),
    );

  return {
    initialize,
    open,
    claimCommand,
    pauseThread,
    fenceSandboxForReplacement,
    retireThreadTerminal,
    routes,
    limits,
    processInstanceId,
  } as const;
};

export type WorkerRelay = ReturnType<typeof makeWorkerRelay>;

export const isWorkerIdentityFailure = Schema.is(WorkerIdentityError);
