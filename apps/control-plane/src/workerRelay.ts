// @effect-diagnostics nodeBuiltinImport:off -- Relay frame sizing and connection ids use Node primitives at the transport boundary.
// @effect-diagnostics globalTimers:off -- Heartbeat deadlines are per-connection and cleared during deterministic cleanup.
// @effect-diagnostics globalTimersInEffect:off -- Credential deadlines are relay-owned native boundary timers.
// @effect-diagnostics runEffectInsideEffect:off -- Native WebSocket callbacks re-enter the fully constructed Effect service.
import * as NodeCrypto from "node:crypto";

import type { CloudThreadCommand } from "@t3tools/contracts/cloud";
import type { InspectorWorkerFrame } from "@t3tools/contracts/inspector";
import {
  WorkerRelayInbound,
  WorkerRelayOutbound,
  type WorkerProviderCredentialCommand,
  type WorkerProviderCredentialResult,
  type WorkerCommandClaimResponse,
  type WorkerDeliveryId,
  type WorkerRelayGitHubCommandResult,
} from "@t3tools/contracts/worker";
import { sealCredentialBinaryFrame } from "@t3tools/shared/credentialRelayCrypto";
import * as Deferred from "effect/Deferred";
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
import type { Secret } from "./providerSecrets.ts";

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
  /** TLS-exported channel key; the mTLS adapter zeroizes it on socket close. */
  readonly credentialChannelKey: Uint8Array;
  readonly send: (payload: string | Uint8Array, complete: (error?: Error) => void) => void;
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
  readonly maxPendingCredentialOperations: number;
  readonly maxPendingCredentialOperationsPerWorkspace: number;
  readonly maxPendingCredentialOperationsPerRoute: number;
  readonly maxPendingCredentialBytes: number;
  readonly maxPendingCredentialBytesPerWorkspace: number;
  readonly maxPendingCredentialBytesPerRoute: number;
  readonly credentialOperationTimeoutMs: number;
}

export const DEFAULT_WORKER_RELAY_LIMITS: WorkerRelayLimits = {
  maxFrameBytes: 2 * 1024 * 1024,
  maxQueuedFrames: 128,
  maxQueuedBytes: 2 * 1024 * 1024,
  heartbeatTimeoutMs: 45_000,
  maxPendingCredentialOperations: 64,
  maxPendingCredentialOperationsPerWorkspace: 16,
  maxPendingCredentialOperationsPerRoute: 8,
  maxPendingCredentialBytes: 32 * 1024 * 1024,
  maxPendingCredentialBytesPerWorkspace: 8 * 1024 * 1024,
  maxPendingCredentialBytesPerRoute: 4 * 1024 * 1024,
  credentialOperationTimeoutMs: 120_000,
};

export interface ActiveWorkerRoute {
  readonly lease: ActiveWorkerLease;
  readonly send: (frame: WorkerRelayInbound) => boolean;
  readonly sendCredential?: (
    command: Extract<WorkerProviderCredentialCommand, { readonly operation: "materialize" }>,
    plaintext: Uint8Array,
  ) => boolean;
  readonly close: (code: number, reason: string) => void;
}

export interface WorkerRouteActivation {
  readonly accepted: boolean;
  readonly displaced?: ActiveWorkerRoute;
}

export interface WorkerRouteRemoval {
  readonly route: ActiveWorkerRoute;
  readonly reason: "deactivated" | "replaced" | "sandbox-closed" | "cleared";
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
  readonly subscribeRemoval: (listener: (removal: WorkerRouteRemoval) => void) => () => void;
  readonly subscribeActivation: (listener: (route: ActiveWorkerRoute) => void) => () => void;
  readonly size: () => number;
}

export const makeInMemoryWorkerRouteRegistry = (): WorkerRouteRegistry => {
  const routes = new Map<string, ActiveWorkerRoute>();
  const removalListeners = new Set<(removal: WorkerRouteRemoval) => void>();
  const activationListeners = new Set<(route: ActiveWorkerRoute) => void>();
  const key = (workspaceId: string, sandboxId: string) => `${workspaceId}\0${sandboxId}`;
  const removed = (route: ActiveWorkerRoute, reason: WorkerRouteRemoval["reason"]) => {
    for (const listener of removalListeners) listener({ route, reason });
  };
  return {
    activate: (route) => {
      const routeKey = key(route.lease.workspaceId, route.lease.sandboxId);
      const previous = routes.get(routeKey);
      if (previous !== undefined && previous.lease.routeGeneration >= route.lease.routeGeneration) {
        return { accepted: false };
      }
      routes.set(routeKey, route);
      for (const listener of activationListeners) listener(route);
      if (previous !== undefined) removed(previous, "replaced");
      return {
        accepted: true,
        ...(previous === undefined ? {} : { displaced: previous }),
      };
    },
    deactivate: (lease) => {
      const routeKey = key(lease.workspaceId, lease.sandboxId);
      if (routes.get(routeKey)?.lease.routeGeneration === lease.routeGeneration) {
        const route = routes.get(routeKey);
        routes.delete(routeKey);
        if (route !== undefined) removed(route, "deactivated");
      }
    },
    get: (workspaceId, sandboxId) => routes.get(key(workspaceId, sandboxId)),
    closeSandbox: (workspaceId, sandboxId, reason) => {
      const route = routes.get(key(workspaceId, sandboxId));
      if (route === undefined) return;
      routes.delete(key(workspaceId, sandboxId));
      removed(route, "sandbox-closed");
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
      for (const route of routes.values()) {
        removed(route, "cleared");
        route.close(1012, "relay_restart");
      }
      routes.clear();
    },
    subscribeRemoval: (listener) => {
      removalListeners.add(listener);
      return () => removalListeners.delete(listener);
    },
    subscribeActivation: (listener) => {
      activationListeners.add(listener);
      return () => activationListeners.delete(listener);
    },
    size: () => routes.size,
  };
};

const decodeOutbound = Schema.decodeUnknownSync(Schema.fromJsonString(WorkerRelayOutbound));
const encodeInbound = Schema.encodeUnknownSync(Schema.fromJsonString(WorkerRelayInbound));

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
  if (message.type === "inspector.frame") {
    return (
      message.frame.binding.workspaceId === certificate.workspaceId &&
      message.frame.binding.threadId === certificate.threadId &&
      message.frame.binding.environmentId === certificate.environmentId &&
      message.frame.binding.environmentRevisionId === certificate.environmentRevisionId &&
      message.frame.binding.providerInstanceId === certificate.providerInstanceId &&
      message.frame.binding.providerDriver === certificate.providerDriver &&
      message.frame.binding.sandboxId === certificate.sandboxId &&
      String(message.frame.binding.workerId) === String(certificate.workerId)
    );
  }
  return true;
};

const sameActiveLease = (left: ActiveWorkerLease, right: ActiveWorkerLease) =>
  left.workspaceId === right.workspaceId &&
  left.threadId === right.threadId &&
  left.environmentId === right.environmentId &&
  left.environmentRevisionId === right.environmentRevisionId &&
  left.sandboxId === right.sandboxId &&
  left.reservationId === right.reservationId &&
  left.workerId === right.workerId &&
  left.providerInstanceId === right.providerInstanceId &&
  left.providerDriver === right.providerDriver &&
  left.certificateFingerprint === right.certificateFingerprint &&
  left.certificateGeneration === right.certificateGeneration &&
  left.leaseGeneration === right.leaseGeneration &&
  left.routeGeneration === right.routeGeneration &&
  left.processInstanceId === right.processInstanceId &&
  left.state === "connected";

class BoundedWriter {
  private readonly queue: Array<{
    readonly payload: string | Uint8Array;
    readonly bytes: number;
  }> = [];
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
    const payload = encodeInbound(frame);
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

  sendCiphertext(payload: Uint8Array) {
    if (
      this.closed ||
      payload.byteLength > this.limits.maxFrameBytes ||
      this.queue.length >= this.limits.maxQueuedFrames ||
      this.bytes + payload.byteLength > this.limits.maxQueuedBytes
    ) {
      payload.fill(0);
      this.fail();
      return false;
    }
    this.queue.push({ payload, bytes: payload.byteLength });
    this.bytes += payload.byteLength;
    this.drain();
    return true;
  }

  dispose() {
    this.closed = true;
    for (const entry of this.queue) {
      if (entry.payload instanceof Uint8Array) entry.payload.fill(0);
    }
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
      if (next.payload instanceof Uint8Array) next.payload.fill(0);
      this.drain();
    });
  }
}

export interface MakeWorkerRelayOptions {
  readonly identities: WorkerIdentityService;
  readonly recovery: WorkerRecoverySource;
  readonly githubResults?: {
    readonly handleResult: (
      identity: ActiveWorkerLease,
      result: WorkerRelayGitHubCommandResult,
    ) => Effect.Effect<void, { readonly _tag: string }>;
  };
  readonly inspectorFrames?: {
    readonly handleFrame: (
      identity: ActiveWorkerLease,
      frame: InspectorWorkerFrame,
    ) => Effect.Effect<
      void,
      { readonly _tag: string; readonly code?: string; readonly operation?: string }
    >;
  };
  readonly processInstanceId?: string;
  readonly routes?: WorkerRouteRegistry;
  readonly coordination?: EphemeralCoordinationService;
  readonly limits?: Partial<WorkerRelayLimits>;
}

export interface WorkerRouteLossInput {
  readonly workspaceId: WorkerIdentity["workspaceId"];
  readonly threadId: WorkerIdentity["threadId"];
  readonly sandboxId?: WorkerIdentity["sandboxId"];
  readonly reason: "paused" | "destroyed" | "replaced";
}

export const makeWorkerRelay = (options: MakeWorkerRelayOptions) => {
  const routes = options.routes ?? makeInMemoryWorkerRouteRegistry();
  const limits = { ...DEFAULT_WORKER_RELAY_LIMITS, ...options.limits };
  const processInstanceId = options.processInstanceId ?? NodeCrypto.randomUUID();
  const coordination = options.coordination;
  type PendingCredentialOperation = {
    readonly identity: ActiveWorkerLease;
    readonly operation: WorkerProviderCredentialCommand["operation"];
    readonly generation?: number;
    readonly result: Deferred.Deferred<WorkerProviderCredentialResult, WorkerRelayServerError>;
    readonly bytes: number;
    readonly timeout: ReturnType<typeof setTimeout>;
  };
  type CredentialAdmission = {
    readonly token: string;
    readonly identity: ActiveWorkerLease;
    readonly operationId: string;
    readonly commandFingerprint: string;
    readonly bytes: number;
    readonly timeout: ReturnType<typeof setTimeout>;
  };
  const pendingCredentialOperations = new Map<string, PendingCredentialOperation>();
  const credentialAdmissions = new Map<string, CredentialAdmission>();
  const provisionalCredentialRoutes = new Map<string, ActiveWorkerRoute>();
  const reconnectListeners = new Set<
    (
      identity: ActiveWorkerLease,
      transport: {
        readonly sendCredentialCommand: typeof sendCredentialCommand;
      },
    ) => Effect.Effect<void, WorkerRelayServerError>
  >();
  const routeLossListeners = new Set<
    (input: WorkerRouteLossInput) => Effect.Effect<void, WorkerRelayServerError>
  >();

  const credentialKey = (identity: ActiveWorkerLease, operationId: string) =>
    `${identity.workspaceId}\0${identity.threadId}\0${identity.sandboxId}\0${identity.workerId}\0${identity.certificateGeneration}\0${identity.leaseGeneration}\0${identity.routeGeneration}\0${operationId}`;
  const routeKey = (identity: Pick<ActiveWorkerLease, "workspaceId" | "sandboxId">) =>
    `${identity.workspaceId}\0${identity.sandboxId}`;
  const sameCredentialRoute = (left: ActiveWorkerLease, right: ActiveWorkerLease) =>
    left.workspaceId === right.workspaceId &&
    left.threadId === right.threadId &&
    left.sandboxId === right.sandboxId &&
    left.workerId === right.workerId &&
    left.certificateGeneration === right.certificateGeneration &&
    left.leaseGeneration === right.leaseGeneration &&
    left.routeGeneration === right.routeGeneration;
  const rejectPendingCredentials = (
    matches: (pending: PendingCredentialOperation) => boolean,
    operation: string,
  ) => {
    for (const [key, pending] of pendingCredentialOperations) {
      if (!matches(pending)) continue;
      pendingCredentialOperations.delete(key);
      clearTimeout(pending.timeout);
      Deferred.doneUnsafe(
        pending.result,
        Effect.fail(new WorkerRelayServerError({ code: "transportFailed", operation })),
      );
    }
  };
  const rejectCredentialAdmissions = (matches: (admission: CredentialAdmission) => boolean) => {
    for (const [token, admission] of credentialAdmissions) {
      if (!matches(admission)) continue;
      credentialAdmissions.delete(token);
      clearTimeout(admission.timeout);
    }
  };

  const credentialUsage = (identity: ActiveWorkerLease) => {
    let globalBytes = 0;
    let workspaceCount = 0;
    let workspaceBytes = 0;
    let routeCount = 0;
    let routeBytes = 0;
    const visit = (entry: Pick<PendingCredentialOperation, "identity" | "bytes">) => {
      globalBytes += entry.bytes;
      if (entry.identity.workspaceId === identity.workspaceId) {
        workspaceCount += 1;
        workspaceBytes += entry.bytes;
      }
      if (sameCredentialRoute(entry.identity, identity)) {
        routeCount += 1;
        routeBytes += entry.bytes;
      }
    };
    for (const pending of pendingCredentialOperations.values()) visit(pending);
    for (const admission of credentialAdmissions.values()) visit(admission);
    return {
      count: pendingCredentialOperations.size + credentialAdmissions.size,
      globalBytes,
      workspaceCount,
      workspaceBytes,
      routeCount,
      routeBytes,
    };
  };

  const acceptCredentialResult = (
    lease: ActiveWorkerLease,
    result: WorkerProviderCredentialResult,
  ) =>
    Effect.gen(function* () {
      const operationKey = credentialKey(lease, result.operationId);
      const pending = pendingCredentialOperations.get(operationKey);
      if (
        pending === undefined ||
        !sameCredentialRoute(pending.identity, lease) ||
        result.routeGeneration !== lease.routeGeneration ||
        ("profileGeneration" in result && pending.generation !== result.profileGeneration)
      ) {
        return yield* new WorkerRelayServerError({
          code: "identityMismatch",
          operation: "provider-credential-result",
        });
      }
      if (result.operation !== pending.operation) {
        return yield* new WorkerRelayServerError({
          code: "invalidFrame",
          operation: "provider-credential-result-kind",
        });
      }
      pendingCredentialOperations.delete(operationKey);
      clearTimeout(pending.timeout);
      yield* Deferred.succeed(pending.result, result);
    });

  const validateActiveLease = (lease: ActiveWorkerLease) =>
    options.identities.repository.validateActiveLease(lease).pipe(
      Effect.mapError(
        (cause) =>
          new WorkerRelayServerError({
            code: "leaseFenced",
            operation: "validate-active-lease",
            cause,
          }),
      ),
      Effect.flatMap((current) =>
        sameActiveLease(current, lease)
          ? Effect.succeed(current)
          : Effect.fail(
              new WorkerRelayServerError({
                code: "leaseFenced",
                operation: "validate-active-lease-identity",
              }),
            ),
      ),
    );
  let inspectorFrames = options.inspectorFrames;

  const open = (certificate: WorkerCertificateRecord, socket: WorkerRelaySocket) =>
    Effect.gen(function* () {
      const lease = yield* options.identities.activateLease(certificate, processInstanceId);
      let closed = false;
      let heartbeatDeadline: ReturnType<typeof setTimeout> | undefined;
      let inboundFrames = 0;
      let inboundBytes = 0;
      let poisoned = false;
      let routeReady = false;
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
        const provisionalKey = routeKey(lease);
        if (
          provisionalCredentialRoutes.get(provisionalKey)?.lease.routeGeneration ===
          lease.routeGeneration
        ) {
          provisionalCredentialRoutes.delete(provisionalKey);
        }
        if (removeEphemeralRoute !== undefined) {
          void Effect.runPromise(removeEphemeralRoute.pipe(Effect.ignore));
        }
        if (removeEphemeralPresence !== undefined) {
          void Effect.runPromise(removeEphemeralPresence.pipe(Effect.ignore));
        }
        rejectPendingCredentials(
          (pending) => sameCredentialRoute(pending.identity, lease),
          "provider-credential-route-lost",
        );
        rejectCredentialAdmissions((admission) => sameCredentialRoute(admission.identity, lease));
        void Effect.runPromise(
          options.identities.disconnectLease(lease, state).pipe(Effect.ignore),
        );
      };
      function close(code: number, reason: string) {
        cleanup(code === 4408 ? "timed_out" : "disconnected");
        socket.close(code, reason);
      }
      const failFencedOpen = (operation: string, cause?: unknown) =>
        Effect.gen(function* () {
          close(4009, "worker_replaced");
          if (removeEphemeralRoute !== undefined) yield* removeEphemeralRoute.pipe(Effect.ignore);
          return yield* new WorkerRelayServerError({
            code: "leaseFenced",
            operation,
            ...(cause === undefined ? {} : { cause }),
          });
        });
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
          if (
            message.type === "inspector.frame" &&
            message.frame.binding.routeGeneration !== lease.routeGeneration
          ) {
            return yield* new WorkerRelayServerError({
              code: "identityMismatch",
              operation: "validate-inspector-route-generation",
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
            if (coordination !== undefined && routeReady) {
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

          if (message.type === "provider.credentials.result") {
            yield* acceptCredentialResult(lease, message);
            return;
          }
          const acceptance = yield* message.type === "github.command.result"
            ? options.githubResults === undefined
              ? Effect.fail(
                  new WorkerRelayServerError({
                    code: "invalidFrame",
                    operation: "github-result-unconfigured",
                  }),
                )
              : options.githubResults.handleResult(lease, message).pipe(
                  Effect.as({ type: "accepted" } as const),
                  Effect.mapError(
                    (cause) =>
                      new WorkerRelayServerError({
                        code: "identityMismatch",
                        operation: "github-result",
                        cause,
                      }),
                  ),
                )
            : message.type === "inspector.frame"
              ? inspectorFrames === undefined
                ? Effect.fail(
                    new WorkerRelayServerError({
                      code: "invalidFrame",
                      operation: "inspector-frame-unconfigured",
                    }),
                  )
                : inspectorFrames.handleFrame(lease, message.frame).pipe(
                    Effect.as({ type: "accepted" } as const),
                    Effect.catch((cause) =>
                      cause.code === "identityMismatch" || cause.code === "invalidRequest"
                        ? Effect.fail(
                            new WorkerRelayServerError({
                              code:
                                cause.code === "identityMismatch"
                                  ? "identityMismatch"
                                  : "invalidFrame",
                              operation: cause.operation ?? "inspector-frame",
                              cause,
                            }),
                          )
                        : // Session expiry, stale route generations, artifact quotas,
                          // and late cleanup frames are scoped inspector failures.
                          Effect.succeed({ type: "accepted" } as const),
                    ),
                  )
              : options.recovery.handleOutbound(certificate, message);
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

      const route: ActiveWorkerRoute = {
        lease,
        send: (frame) => writer.send(frame),
        sendCredential: (command, plaintext) =>
          writer.sendCiphertext(
            sealCredentialBinaryFrame({
              key: socket.credentialChannelKey,
              kind: "materialize",
              operationId: command.operationId,
              routeGeneration: command.routeGeneration,
              control: command,
              plaintext,
            }),
          ),
        close,
      };
      const activeRoute = routes.get(lease.workspaceId, lease.sandboxId);
      const provisionalKey = routeKey(lease);
      const previousProvisional = provisionalCredentialRoutes.get(provisionalKey);
      if (
        (activeRoute !== undefined && activeRoute.lease.routeGeneration >= lease.routeGeneration) ||
        (previousProvisional !== undefined &&
          previousProvisional.lease.routeGeneration >= lease.routeGeneration)
      ) {
        close(4009, "worker_replaced");
        return yield* new WorkerRelayServerError({
          code: "leaseFenced",
          operation: "provisional-route",
        });
      }
      provisionalCredentialRoutes.set(provisionalKey, route);
      previousProvisional?.close(4009, "worker_replaced");

      // Receive is installed before recovery and reconciliation so an immediate
      // worker result cannot be lost while the route is still provisional.
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

      const reconnectTransport = {
        sendCredentialCommand: (input: Parameters<typeof sendCredentialCommandWithRoute>[0]) =>
          sendCredentialCommandWithRoute(input, route),
      };
      for (const listener of reconnectListeners) {
        yield* listener(lease, reconnectTransport).pipe(
          Effect.tapError(() => Effect.sync(() => close(1011, "relay_reconciliation_failed"))),
        );
      }

      if (provisionalCredentialRoutes.get(provisionalKey) !== route) {
        return yield* failFencedOpen("publish-provisional-route");
      }
      yield* validateActiveLease(lease).pipe(
        Effect.catch((cause) => failFencedOpen("publish-active-lease", cause)),
      );

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
      yield* validateActiveLease(lease).pipe(
        Effect.catch((cause) => failFencedOpen("published-active-lease", cause)),
      );
      if (provisionalCredentialRoutes.get(provisionalKey) !== route) {
        return yield* failFencedOpen("activate-provisional-route");
      }
      provisionalCredentialRoutes.delete(provisionalKey);
      const activation = routes.activate(route);
      if (!activation.accepted) {
        return yield* failFencedOpen("activate-route");
      }
      activation.displaced?.close(4009, "worker_replaced");
      routeReady = true;
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
    Effect.tap(() =>
      Effect.sync(() => {
        rejectPendingCredentials(() => true, "provider-credential-relay-reset");
        rejectCredentialAdmissions(() => true);
        routes.clear();
      }),
    ),
  );

  const beforeRouteLoss = (input: WorkerRouteLossInput) =>
    Effect.forEach(routeLossListeners, (listener) => listener(input), {
      concurrency: 1,
      discard: true,
    });

  const closeProvisionalSandbox = (
    workspaceId: WorkerIdentity["workspaceId"],
    sandboxId: WorkerIdentity["sandboxId"],
    reason: string,
  ) => {
    for (const [key, route] of provisionalCredentialRoutes) {
      if (route.lease.workspaceId !== workspaceId || route.lease.sandboxId !== sandboxId) continue;
      provisionalCredentialRoutes.delete(key);
      route.close(4009, reason);
    }
  };

  const fenceSandboxForReplacement = (
    workspaceId: WorkerIdentity["workspaceId"],
    threadId: WorkerIdentity["threadId"],
    sandboxId: WorkerIdentity["sandboxId"],
    reason: string,
  ) =>
    beforeRouteLoss({ workspaceId, threadId, sandboxId, reason: "replaced" }).pipe(
      Effect.andThen(options.identities.fenceSandbox(workspaceId, sandboxId, reason)),
      Effect.tap(() =>
        Effect.sync(() => {
          closeProvisionalSandbox(workspaceId, sandboxId, "worker_fenced");
          routes.closeSandbox(workspaceId, sandboxId, "worker_fenced");
        }),
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
    beforeRouteLoss({ workspaceId, threadId, reason: "paused" }).pipe(
      Effect.andThen(Effect.sync(() => routes.closeThread(workspaceId, threadId, "worker_paused"))),
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
    beforeRouteLoss({ workspaceId, threadId, sandboxId, reason: "destroyed" }).pipe(
      Effect.andThen(options.identities.fenceSandbox(workspaceId, sandboxId, reason)),
      Effect.tap(() =>
        Effect.sync(() => routes.closeThread(workspaceId, threadId, "thread_retired")),
      ),
      Effect.andThen(
        coordination === undefined
          ? Effect.void
          : coordination.retireThreadTerminal(workspaceId, threadId),
      ),
    );

  const reserveCredentialCommand = (input: {
    readonly identity: ActiveWorkerLease;
    readonly command: WorkerProviderCredentialCommand;
  }) =>
    Effect.gen(function* () {
      if (
        input.command.providerInstanceId !== input.identity.providerInstanceId ||
        input.command.providerDriver !== input.identity.providerDriver ||
        input.command.routeGeneration !== input.identity.routeGeneration
      ) {
        return yield* new WorkerRelayServerError({
          code: "identityMismatch",
          operation: "provider-credential-admission",
        });
      }
      const route = routes.get(input.identity.workspaceId, input.identity.sandboxId);
      if (route === undefined || !sameCredentialRoute(route.lease, input.identity)) {
        return yield* new WorkerRelayServerError({
          code: "leaseFenced",
          operation: "provider-credential-admission",
        });
      }
      const encoded = encodeInbound(input.command);
      const bytes = Buffer.byteLength(encoded, "utf8");
      const usage = credentialUsage(input.identity);
      if (
        usage.count >= limits.maxPendingCredentialOperations ||
        usage.workspaceCount >= limits.maxPendingCredentialOperationsPerWorkspace ||
        usage.routeCount >= limits.maxPendingCredentialOperationsPerRoute ||
        usage.globalBytes + bytes > limits.maxPendingCredentialBytes ||
        usage.workspaceBytes + bytes > limits.maxPendingCredentialBytesPerWorkspace ||
        usage.routeBytes + bytes > limits.maxPendingCredentialBytesPerRoute
      ) {
        return yield* new WorkerRelayServerError({
          code: "queueFull",
          operation: "provider-credential-admission-budget",
        });
      }
      const operationKey = credentialKey(input.identity, input.command.operationId);
      if (
        pendingCredentialOperations.has(operationKey) ||
        [...credentialAdmissions.values()].some(
          (entry) =>
            entry.operationId === input.command.operationId &&
            sameCredentialRoute(entry.identity, input.identity),
        )
      ) {
        return yield* new WorkerRelayServerError({
          code: "queueFull",
          operation: "provider-credential-admission-duplicate",
        });
      }
      const token = NodeCrypto.randomUUID();
      const timeout = setTimeout(() => {
        const current = credentialAdmissions.get(token);
        if (current === undefined) return;
        credentialAdmissions.delete(token);
      }, limits.credentialOperationTimeoutMs);
      timeout.unref();
      credentialAdmissions.set(token, {
        token,
        identity: input.identity,
        operationId: input.command.operationId,
        commandFingerprint: NodeCrypto.createHash("sha256").update(encoded).digest("hex"),
        bytes,
        timeout,
      });
      return {
        token,
        release: Effect.sync(() => {
          const current = credentialAdmissions.get(token);
          if (current === undefined) return;
          credentialAdmissions.delete(token);
          clearTimeout(current.timeout);
        }),
      } as const;
    });

  const sendCredentialCommandWithRoute = (
    input: {
      readonly identity: ActiveWorkerLease;
      readonly command: WorkerProviderCredentialCommand;
      readonly admissionToken?: string;
      readonly credentialPayload?: Secret<Uint8Array>;
    },
    routeOverride?: ActiveWorkerRoute,
  ) =>
    Effect.gen(function* () {
      if (
        input.command.providerInstanceId !== input.identity.providerInstanceId ||
        input.command.providerDriver !== input.identity.providerDriver ||
        input.command.routeGeneration !== input.identity.routeGeneration
      ) {
        return yield* new WorkerRelayServerError({
          code: "identityMismatch",
          operation: "provider-credential-command",
        });
      }
      const route =
        routeOverride ?? routes.get(input.identity.workspaceId, input.identity.sandboxId);
      if (
        route === undefined ||
        !sameCredentialRoute(route.lease, input.identity) ||
        route.lease.providerInstanceId !== input.identity.providerInstanceId
      ) {
        return yield* new WorkerRelayServerError({
          code: "leaseFenced",
          operation: "provider-credential-command",
        });
      }
      const operationKey = credentialKey(input.identity, input.command.operationId);
      if (pendingCredentialOperations.has(operationKey)) {
        return yield* new WorkerRelayServerError({
          code: "queueFull",
          operation: "provider-credential-command-duplicate",
        });
      }
      const secretBytes = input.credentialPayload?.withValue((bytes) => bytes.byteLength) ?? 0;
      if (
        (input.command.operation === "materialize") !== (input.credentialPayload !== undefined) ||
        (input.command.operation === "materialize" &&
          input.command.credentialPayloadBytes !== secretBytes)
      ) {
        return yield* new WorkerRelayServerError({
          code: "invalidFrame",
          operation: "provider-credential-command-payload",
        });
      }
      const commandBytes = Buffer.byteLength(encodeInbound(input.command), "utf8") + secretBytes;
      if (input.admissionToken !== undefined) {
        const admission = credentialAdmissions.get(input.admissionToken);
        const fingerprint = NodeCrypto.createHash("sha256")
          .update(encodeInbound(input.command))
          .digest("hex");
        if (
          admission === undefined ||
          !sameCredentialRoute(admission.identity, input.identity) ||
          admission.operationId !== input.command.operationId ||
          admission.commandFingerprint !== fingerprint
        ) {
          return yield* new WorkerRelayServerError({
            code: "leaseFenced",
            operation: "provider-credential-admission-consume",
          });
        }
        credentialAdmissions.delete(input.admissionToken);
        clearTimeout(admission.timeout);
      } else {
        const usage = credentialUsage(input.identity);
        if (
          usage.count >= limits.maxPendingCredentialOperations ||
          usage.workspaceCount >= limits.maxPendingCredentialOperationsPerWorkspace ||
          usage.routeCount >= limits.maxPendingCredentialOperationsPerRoute ||
          usage.globalBytes + commandBytes > limits.maxPendingCredentialBytes ||
          usage.workspaceBytes + commandBytes > limits.maxPendingCredentialBytesPerWorkspace ||
          usage.routeBytes + commandBytes > limits.maxPendingCredentialBytesPerRoute
        ) {
          return yield* new WorkerRelayServerError({
            code: "queueFull",
            operation: "provider-credential-command-budget",
          });
        }
      }
      const result = yield* Deferred.make<WorkerProviderCredentialResult, WorkerRelayServerError>();
      const timeout = setTimeout(() => {
        const pending = pendingCredentialOperations.get(operationKey);
        if (pending === undefined) return;
        pendingCredentialOperations.delete(operationKey);
        Deferred.doneUnsafe(
          pending.result,
          Effect.fail(
            new WorkerRelayServerError({
              code: "transportFailed",
              operation: "provider-credential-command-timeout",
            }),
          ),
        );
      }, limits.credentialOperationTimeoutMs);
      timeout.unref();
      pendingCredentialOperations.set(operationKey, {
        identity: input.identity,
        operation: input.command.operation,
        generation: input.command.profileGeneration,
        result,
        bytes: commandBytes,
        timeout,
      });
      let sent: boolean;
      if (input.command.operation === "materialize" && input.credentialPayload !== undefined) {
        const sendCredential = route.sendCredential;
        if (sendCredential === undefined) {
          return yield* new WorkerRelayServerError({
            code: "transportFailed",
            operation: "provider-credential-binary-channel",
          });
        }
        const command = input.command;
        sent = input.credentialPayload.withValue((plaintext) => sendCredential(command, plaintext));
      } else {
        sent = route.send(input.command);
      }
      if (!sent) {
        pendingCredentialOperations.delete(operationKey);
        clearTimeout(timeout);
        return yield* new WorkerRelayServerError({
          code: "queueFull",
          operation: "provider-credential-command-send",
        });
      }
      return yield* Deferred.await(result).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            const pending = pendingCredentialOperations.get(operationKey);
            if (pending !== undefined) clearTimeout(pending.timeout);
            pendingCredentialOperations.delete(operationKey);
          }),
        ),
      );
    });

  const sendCredentialCommand = (input: Parameters<typeof sendCredentialCommandWithRoute>[0]) =>
    sendCredentialCommandWithRoute(input);

  const onAuthenticatedReconnect = (
    listener: (
      identity: ActiveWorkerLease,
      transport: {
        readonly sendCredentialCommand: typeof sendCredentialCommand;
      },
    ) => Effect.Effect<void, WorkerRelayServerError>,
  ) => {
    reconnectListeners.add(listener);
    return () => reconnectListeners.delete(listener);
  };

  const onBeforeRouteLoss = (
    listener: (input: WorkerRouteLossInput) => Effect.Effect<void, WorkerRelayServerError>,
  ) => {
    routeLossListeners.add(listener);
    return () => routeLossListeners.delete(listener);
  };

  return {
    initialize,
    open,
    claimCommand,
    pauseThread,
    fenceSandboxForReplacement,
    retireThreadTerminal,
    sendCredentialCommand,
    reserveCredentialCommand,
    onAuthenticatedReconnect,
    onBeforeRouteLoss,
    routes,
    limits,
    processInstanceId,
    setInspectorFrameHandler: (handler: MakeWorkerRelayOptions["inspectorFrames"] | undefined) => {
      inspectorFrames = handler;
    },
  } as const;
};

export type WorkerRelay = ReturnType<typeof makeWorkerRelay>;

export const isWorkerIdentityFailure = Schema.is(WorkerIdentityError);
