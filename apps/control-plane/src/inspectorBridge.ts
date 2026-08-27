// @effect-diagnostics nodeBuiltinImport:off -- Inspector ids and content digests are generated at the Node boundary.
// @effect-diagnostics globalTimers:off -- Heartbeat and reconnect-grace timers are bounded and cleared by session cleanup.
// @effect-diagnostics runEffectInsideEffect:off -- Native socket and worker-route callbacks re-enter the composed service.
import * as NodeCrypto from "node:crypto";

import { ThreadId } from "@t3tools/contracts";
import {
  INSPECTOR_MAX_ARTIFACT_TRANSFER_BYTES,
  INSPECTOR_MAX_ARTIFACT_BYTES_PER_SESSION,
  INSPECTOR_MAX_ARTIFACTS_PER_SESSION,
  INSPECTOR_MAX_FRAME_BYTES,
  INSPECTOR_MAX_INFLIGHT_REQUESTS,
  INSPECTOR_MAX_REQUESTS_PER_MINUTE,
  INSPECTOR_PROTOCOL_VERSION,
  InspectorAttemptId,
  InspectorArtifactId,
  InspectorClientFrame,
  type InspectorOperation,
  type InspectorRequestId,
  type InspectorRouteBinding,
  type InspectorServerFrame,
  type InspectorSessionId,
  type InspectorWorkerFrame,
} from "@t3tools/contracts/inspector";
import type { WorkspaceId } from "@t3tools/contracts/cloud";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ArtifactStorageService } from "./artifactStorage.ts";
import type {
  CloudThreadLifecycleAttempt,
  CloudThreadLifecycleStore,
} from "./cloudThreadLifecycleStore.ts";
import { isTrustedCloudRpcOrigin, type CloudRpcSocket } from "./cloudRpc.ts";
import type { ControlPlaneAuth } from "./http.ts";
import type { ActiveWorkerRoute, WorkerRouteRegistry } from "./workerRelay.ts";
import type { WorkspaceRepositoryService } from "./workspaces.ts";

export class InspectorBridgeError extends Schema.TaggedErrorClass<InspectorBridgeError>()(
  "InspectorBridgeError",
  {
    code: Schema.Literals([
      "unauthorized",
      "forbidden",
      "invalidRequest",
      "identityMismatch",
      "notFound",
      "staleRoute",
      "slowConsumer",
      "unavailable",
      "internal",
    ]),
    status: Schema.Int,
    retryable: Schema.Boolean,
    operation: Schema.String,
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {}

export interface InspectorPrincipal {
  readonly workspaceId: WorkspaceId;
  readonly userId: string;
  readonly threadId: ThreadId;
  readonly attempt: CloudThreadLifecycleAttempt;
}

export interface InspectorBridgeLimits {
  readonly maxFrameBytes: number;
  readonly maxQueuedFrames: number;
  readonly maxQueuedBytes: number;
  readonly maxInboundFrames: number;
  readonly maxInboundBytes: number;
  readonly maxSessions: number;
  readonly maxSessionsPerWorkspace: number;
  readonly heartbeatIntervalMs: number;
  readonly reconnectGraceMs: number;
  readonly maxInflightRequestsPerSession: number;
  readonly maxRequestsPerMinutePerSession: number;
  readonly maxRequestsPerMinutePerWorkspace: number;
  readonly maxArtifactsPerSession: number;
  readonly maxArtifactBytesPerSession: number;
  readonly maxActiveTerminalsPerSession: number;
  readonly maxActiveTerminalsPerWorkspace: number;
  readonly maxClosedSessionTombstones: number;
  readonly closedSessionTombstoneTtlMs: number;
}

export const DEFAULT_INSPECTOR_BRIDGE_LIMITS: InspectorBridgeLimits = {
  maxFrameBytes: INSPECTOR_MAX_FRAME_BYTES,
  maxQueuedFrames: 128,
  maxQueuedBytes: 2 * 1024 * 1024,
  maxInboundFrames: 64,
  maxInboundBytes: 512 * 1024,
  maxSessions: 1_000,
  maxSessionsPerWorkspace: 10,
  heartbeatIntervalMs: 30_000,
  reconnectGraceMs: 30_000,
  maxInflightRequestsPerSession: INSPECTOR_MAX_INFLIGHT_REQUESTS,
  maxRequestsPerMinutePerSession: INSPECTOR_MAX_REQUESTS_PER_MINUTE,
  maxRequestsPerMinutePerWorkspace: 600,
  maxArtifactsPerSession: INSPECTOR_MAX_ARTIFACTS_PER_SESSION,
  maxArtifactBytesPerSession: INSPECTOR_MAX_ARTIFACT_BYTES_PER_SESSION,
  maxActiveTerminalsPerSession: 4,
  maxActiveTerminalsPerWorkspace: 16,
  maxClosedSessionTombstones: 1_024,
  closedSessionTombstoneTtlMs: 60_000,
};

export interface InspectorInputAuthorizer {
  readonly authorize: (input: {
    readonly principal: InspectorPrincipal;
    readonly sessionId: InspectorSessionId;
    readonly operation: Extract<
      InspectorOperation,
      { readonly type: "browser.input" | "desktop.input" }
    >;
  }) => Effect.Effect<void, InspectorBridgeError>;
}

const denyInteractiveInput: InspectorInputAuthorizer = {
  authorize: () =>
    Effect.fail(
      new InspectorBridgeError({
        code: "forbidden",
        status: 403,
        retryable: false,
        operation: "authorize-interactive-input",
      }),
    ),
};

class BoundedInspectorWriter {
  private readonly queue: Array<{ readonly payload: string; readonly bytes: number }> = [];
  private queuedBytes = 0;
  private sending = false;
  private closed = false;
  private readonly socket: CloudRpcSocket;
  private readonly limits: InspectorBridgeLimits;
  private readonly fail: () => void;

  constructor(socket: CloudRpcSocket, limits: InspectorBridgeLimits, fail: () => void) {
    this.socket = socket;
    this.limits = limits;
    this.fail = fail;
  }

  send(frame: InspectorServerFrame) {
    if (this.closed) return false;
    const payload = JSON.stringify(frame);
    const bytes = Buffer.byteLength(payload);
    if (
      bytes > this.limits.maxFrameBytes ||
      this.queue.length >= this.limits.maxQueuedFrames ||
      this.queuedBytes + bytes > this.limits.maxQueuedBytes
    ) {
      this.fail();
      return false;
    }
    this.queue.push({ payload, bytes });
    this.queuedBytes += bytes;
    this.drain();
    return true;
  }

  dispose() {
    this.closed = true;
    this.queue.length = 0;
    this.queuedBytes = 0;
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
      this.queuedBytes -= next.bytes;
      this.drain();
    });
  }
}

interface InspectorClientConnection {
  readonly socket: CloudRpcSocket;
  readonly writer: BoundedInspectorWriter;
  readonly cleanupListeners: () => void;
}

interface InspectorSessionRecord {
  readonly sessionId: InspectorSessionId;
  readonly principal: InspectorPrincipal;
  binding: InspectorRouteBinding;
  route: ActiveWorkerRoute | undefined;
  connection: InspectorClientConnection | undefined;
  lastDeliveredSequence: number;
  lastWorkerSequence: number;
  pendingHeartbeat: string | undefined;
  heartbeat: ReturnType<typeof setInterval> | undefined;
  grace: ReturnType<typeof setTimeout> | undefined;
  processing: Promise<void>;
  readonly inflightRequests: Set<string>;
  readonly requestOperations: Map<
    string,
    | {
        readonly kind: "terminal.open";
        readonly terminalId: string;
        state: "reserved" | "active" | "cancelled" | "closing";
      }
    | { readonly kind: "terminal.close"; readonly terminalId: string }
    | { readonly kind: "other" }
  >;
  readonly activeTerminalIds: Set<string>;
  requestWindowStartedAt: number;
  requestsInWindow: number;
  artifactCount: number;
  artifactBytes: number;
}

interface ClosedSessionTombstone {
  readonly binding: InspectorRouteBinding;
  readonly expiresAt: number;
}

interface RequestWindow {
  startedAt: number;
  count: number;
}

const decodeClientFrame = Schema.decodeUnknownSync(Schema.fromJsonString(InspectorClientFrame));
const decodeAttemptId = Schema.decodeUnknownSync(InspectorAttemptId);
const decodeArtifactId = Schema.decodeUnknownSync(InspectorArtifactId);
const decodeThreadId = Schema.decodeUnknownSync(ThreadId);
const nowIso = () => DateTime.formatIso(DateTime.nowUnsafe());
const isInspectorBridgeError = Schema.is(InspectorBridgeError);

const failure = (
  code: InspectorBridgeError["code"],
  status: number,
  retryable: boolean,
  operation: string,
  cause?: unknown,
) =>
  new InspectorBridgeError({
    code,
    status,
    retryable,
    operation,
    ...(cause === undefined ? {} : { cause }),
  });

const bindingFor = (
  attempt: CloudThreadLifecycleAttempt,
  route: ActiveWorkerRoute,
): InspectorRouteBinding => ({
  protocolVersion: INSPECTOR_PROTOCOL_VERSION,
  workspaceId: attempt.workspaceId,
  threadId: attempt.threadId,
  attemptId: decodeAttemptId(attempt.attemptId),
  environmentId: attempt.environmentId,
  environmentRevisionId: attempt.environmentRevisionId,
  providerInstanceId: attempt.providerInstanceId,
  providerDriver: attempt.providerDriver,
  sandboxId: route.lease.sandboxId,
  workerId: route.lease.workerId as never,
  routeGeneration: route.lease.routeGeneration,
});

const routeMatchesAttempt = (route: ActiveWorkerRoute, attempt: CloudThreadLifecycleAttempt) =>
  attempt.isCurrent &&
  attempt.state === "ready" &&
  attempt.sandboxId !== undefined &&
  attempt.workerId !== undefined &&
  route.lease.workspaceId === attempt.workspaceId &&
  route.lease.threadId === attempt.threadId &&
  route.lease.sandboxId === attempt.sandboxId &&
  route.lease.workerId === attempt.workerId &&
  route.lease.environmentId === attempt.environmentId &&
  route.lease.environmentRevisionId === attempt.environmentRevisionId &&
  route.lease.providerInstanceId === attempt.providerInstanceId &&
  route.lease.providerDriver === attempt.providerDriver;

const sameAttemptBinding = (
  left: CloudThreadLifecycleAttempt,
  right: CloudThreadLifecycleAttempt,
) =>
  left.attemptId === right.attemptId &&
  left.workspaceId === right.workspaceId &&
  left.threadId === right.threadId &&
  left.environmentId === right.environmentId &&
  left.environmentRevisionId === right.environmentRevisionId &&
  left.providerInstanceId === right.providerInstanceId &&
  left.providerDriver === right.providerDriver &&
  left.sandboxId === right.sandboxId &&
  left.workerId === right.workerId;

const sameInspectorBinding = (left: InspectorRouteBinding, right: InspectorRouteBinding) =>
  left.protocolVersion === right.protocolVersion &&
  left.workspaceId === right.workspaceId &&
  left.threadId === right.threadId &&
  left.attemptId === right.attemptId &&
  left.environmentId === right.environmentId &&
  left.environmentRevisionId === right.environmentRevisionId &&
  left.providerInstanceId === right.providerInstanceId &&
  left.providerDriver === right.providerDriver &&
  left.sandboxId === right.sandboxId &&
  String(left.workerId) === String(right.workerId) &&
  left.routeGeneration === right.routeGeneration;

const routeMatchesBinding = (route: ActiveWorkerRoute["lease"], binding: InspectorRouteBinding) =>
  route.workspaceId === binding.workspaceId &&
  route.threadId === binding.threadId &&
  route.sandboxId === binding.sandboxId &&
  String(route.workerId) === String(binding.workerId) &&
  route.environmentId === binding.environmentId &&
  route.environmentRevisionId === binding.environmentRevisionId &&
  route.providerInstanceId === binding.providerInstanceId &&
  route.providerDriver === binding.providerDriver &&
  route.routeGeneration === binding.routeGeneration;

const bytesSource = (bytes: Uint8Array): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    yield bytes;
  },
});

const inspectorDownloadAllowed = (kind: string, mediaType: string) =>
  kind === "terminal-chunk"
    ? mediaType === "text/plain"
    : kind === "screenshot" &&
      ["application/octet-stream", "image/jpeg", "image/png", "image/webp", "video/mp4"].includes(
        mediaType,
      );

export interface MakeInspectorBridgeOptions {
  readonly auth: ControlPlaneAuth;
  readonly hostedOrigin: string;
  readonly workspaces: WorkspaceRepositoryService;
  readonly lifecycle: CloudThreadLifecycleStore;
  readonly routes: WorkerRouteRegistry;
  readonly artifacts: ArtifactStorageService;
  readonly inputAuthorizer?: InspectorInputAuthorizer;
  readonly limits?: Partial<InspectorBridgeLimits>;
  readonly nextSessionId?: () => InspectorSessionId;
  readonly nowMs?: () => number;
}

export const makeInspectorBridge = (options: MakeInspectorBridgeOptions) => {
  const limits = { ...DEFAULT_INSPECTOR_BRIDGE_LIMITS, ...options.limits };
  for (const [name, value, maximum] of [
    ["maxInflightRequestsPerSession", limits.maxInflightRequestsPerSession, 64],
    ["maxRequestsPerMinutePerSession", limits.maxRequestsPerMinutePerSession, 10_000],
    ["maxRequestsPerMinutePerWorkspace", limits.maxRequestsPerMinutePerWorkspace, 100_000],
    ["maxArtifactsPerSession", limits.maxArtifactsPerSession, 10_000],
    ["maxArtifactBytesPerSession", limits.maxArtifactBytesPerSession, 1024 * 1024 * 1024],
    ["maxActiveTerminalsPerSession", limits.maxActiveTerminalsPerSession, 32],
    ["maxActiveTerminalsPerWorkspace", limits.maxActiveTerminalsPerWorkspace, 256],
    ["maxClosedSessionTombstones", limits.maxClosedSessionTombstones, 16_384],
    ["closedSessionTombstoneTtlMs", limits.closedSessionTombstoneTtlMs, 300_000],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new RangeError(`${name} is outside the supported range`);
    }
  }
  const inputAuthorizer = options.inputAuthorizer ?? denyInteractiveInput;
  const sessions = new Map<InspectorSessionId, InspectorSessionRecord>();
  const workspaceSessions = new Map<WorkspaceId, number>();
  const workspaceRequestWindows = new Map<WorkspaceId, RequestWindow>();
  const workspaceActiveTerminals = new Map<WorkspaceId, number>();
  const closedSessions = new Map<InspectorSessionId, ClosedSessionTombstone>();
  const backgroundTasks = new Set<Promise<unknown>>();
  const nowMs = options.nowMs ?? Date.now;
  const nextSessionId =
    options.nextSessionId ?? (() => NodeCrypto.randomUUID() as InspectorSessionId);

  const currentRoute = (principal: InspectorPrincipal) =>
    Effect.tryPromise({
      try: () => options.lifecycle.getCurrent(principal.workspaceId, principal.threadId),
      catch: (cause) => failure("internal", 500, true, "read-current-attempt", cause),
    }).pipe(
      Effect.flatMap((attempt) => {
        if (
          attempt === undefined ||
          !sameAttemptBinding(attempt, principal.attempt) ||
          !attempt.isCurrent ||
          attempt.sandboxId === undefined
        ) {
          return Effect.fail(failure("notFound", 404, false, "authorize-current-attempt"));
        }
        const route = options.routes.get(principal.workspaceId, attempt.sandboxId);
        return route !== undefined && routeMatchesAttempt(route, attempt)
          ? Effect.succeed({ attempt, route })
          : Effect.fail(failure("staleRoute", 409, true, "authorize-current-route"));
      }),
    );

  const authorizeWebSocket = (
    headers: Headers,
    requested: { readonly threadId: ThreadId; readonly attemptId: string },
    signal?: AbortSignal,
  ) => {
    if (!isTrustedCloudRpcOrigin(headers, options.hostedOrigin)) {
      return Effect.fail(failure("forbidden", 403, false, "authorize-origin"));
    }
    return Effect.tryPromise({
      try: (internalSignal) =>
        options.auth.api.getSession({ headers, signal: signal ?? internalSignal }),
      catch: (cause) => failure("internal", 500, true, "authenticate", cause),
    }).pipe(
      Effect.flatMap((session) =>
        session === null
          ? Effect.fail(failure("unauthorized", 401, false, "authenticate"))
          : options.workspaces.ensureForUser(session.user).pipe(
              Effect.mapError((cause) =>
                failure("internal", 500, true, "resolve-workspace", cause),
              ),
              Effect.flatMap((workspace) =>
                Effect.tryPromise({
                  try: () =>
                    options.lifecycle.getCurrent(workspace.id as WorkspaceId, requested.threadId),
                  catch: (cause) => failure("internal", 500, true, "read-current-attempt", cause),
                }).pipe(
                  Effect.flatMap((attempt) => {
                    if (
                      attempt === undefined ||
                      !attempt.isCurrent ||
                      attempt.state !== "ready" ||
                      attempt.attemptId !== requested.attemptId ||
                      attempt.sandboxId === undefined ||
                      attempt.workerId === undefined
                    ) {
                      return Effect.fail(
                        failure("notFound", 404, false, "authorize-current-attempt"),
                      );
                    }
                    const route = options.routes.get(attempt.workspaceId, attempt.sandboxId);
                    if (route === undefined || !routeMatchesAttempt(route, attempt)) {
                      return Effect.fail(
                        failure("staleRoute", 409, true, "authorize-current-route"),
                      );
                    }
                    return Effect.succeed({
                      workspaceId: attempt.workspaceId,
                      userId: session.user.id,
                      threadId: requested.threadId,
                      attempt,
                    } satisfies InspectorPrincipal);
                  }),
                ),
              ),
            ),
      ),
    );
  };

  const handleHttp = (request: Request): Effect.Effect<Response | undefined, never> => {
    const url = new URL(request.url);
    const match = /^\/api\/v1\/inspector\/artifacts\/([^/]+)$/u.exec(url.pathname);
    if (match === null) return Effect.sync(() => undefined);
    const requestOrigin = request.headers.get("origin");
    const corsOrigin =
      requestOrigin !== null && isTrustedCloudRpcOrigin(request.headers, options.hostedOrigin)
        ? requestOrigin
        : undefined;
    if (request.method === "OPTIONS") {
      if (
        requestOrigin === null ||
        !isTrustedCloudRpcOrigin(request.headers, options.hostedOrigin)
      ) {
        return Effect.succeed(
          Response.json(
            { error: "forbidden" },
            { status: 403, headers: { "cache-control": "no-store" } },
          ),
        );
      }
      return Effect.succeed(
        new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-headers": "Authorization",
            "access-control-allow-methods": "GET",
            "access-control-allow-origin": requestOrigin,
            "access-control-max-age": "600",
            vary: "Origin",
          },
        }),
      );
    }
    if (request.method !== "GET") {
      return Effect.succeed(
        Response.json(
          { error: "method_not_allowed" },
          {
            status: 405,
            headers: {
              "cache-control": "no-store",
              ...(corsOrigin === undefined
                ? {}
                : { "access-control-allow-origin": corsOrigin, vary: "Origin" }),
            },
          },
        ),
      );
    }
    return Effect.gen(function* () {
      if (!isTrustedCloudRpcOrigin(request.headers, options.hostedOrigin)) {
        return yield* failure("forbidden", 403, false, "authorize-artifact-origin");
      }
      const requested = yield* Effect.try({
        try: () => ({
          artifactId: decodeArtifactId(match[1]),
          threadId: decodeThreadId(url.searchParams.get("threadId")),
          attemptId: decodeAttemptId(url.searchParams.get("attemptId")),
        }),
        catch: (cause) => failure("invalidRequest", 400, false, "decode-artifact-request", cause),
      });
      const session = yield* Effect.tryPromise({
        try: (signal) => options.auth.api.getSession({ headers: request.headers, signal }),
        catch: (cause) => failure("internal", 500, true, "authenticate-artifact", cause),
      });
      if (session === null) {
        return yield* failure("unauthorized", 401, false, "authenticate-artifact");
      }
      const workspace = yield* options.workspaces
        .ensureForUser(session.user)
        .pipe(
          Effect.mapError((cause) =>
            failure("internal", 500, true, "resolve-artifact-workspace", cause),
          ),
        );
      const attempt = yield* Effect.tryPromise({
        try: () => options.lifecycle.getCurrent(workspace.id as WorkspaceId, requested.threadId),
        catch: (cause) => failure("internal", 500, true, "read-artifact-attempt", cause),
      });
      if (
        attempt === undefined ||
        !attempt.isCurrent ||
        attempt.attemptId !== requested.attemptId
      ) {
        return yield* failure("notFound", 404, false, "authorize-artifact");
      }
      const downloaded = yield* options.artifacts
        .download(attempt.workspaceId, attempt.threadId, requested.artifactId, request.signal)
        .pipe(
          Effect.mapError((cause) =>
            cause.code === "notFound" || cause.code === "tenantMismatch"
              ? failure("notFound", 404, false, "download-artifact")
              : failure("unavailable", 503, cause.retryable, "download-artifact", cause),
          ),
        );
      if (!inspectorDownloadAllowed(downloaded.artifact.kind, downloaded.artifact.mediaType)) {
        return yield* failure("notFound", 404, false, "authorize-artifact-kind");
      }
      return new Response(Uint8Array.from(downloaded.bytes).buffer, {
        status: 200,
        headers: {
          "cache-control": "private, no-store",
          "content-length": String(downloaded.bytes.byteLength),
          "content-type": downloaded.artifact.mediaType,
          "content-disposition":
            downloaded.artifact.mediaType === "application/octet-stream" ? "attachment" : "inline",
          "x-content-type-options": "nosniff",
          "x-content-sha256": downloaded.artifact.sha256,
          ...(corsOrigin === undefined
            ? {}
            : {
                "access-control-allow-origin": corsOrigin,
                "access-control-expose-headers": "Content-Length, Content-Type, X-Content-Sha256",
                vary: "Origin",
              }),
        },
      });
    }).pipe(
      Effect.catch((cause) => {
        const error = isInspectorBridgeError(cause)
          ? cause
          : failure("internal", 500, true, "download-artifact", cause);
        return Effect.succeed(
          Response.json(
            { error: error.code, retryable: error.retryable },
            {
              status: error.status,
              headers: {
                "cache-control": "no-store",
                ...(corsOrigin === undefined
                  ? {}
                  : { "access-control-allow-origin": corsOrigin, vary: "Origin" }),
              },
            },
          ),
        );
      }),
    );
  };

  const sendWorker = (
    record: InspectorSessionRecord,
    command: Parameters<ActiveWorkerRoute["send"]>[0],
  ) => {
    const route = record.route;
    if (route === undefined || route.lease.routeGeneration !== record.binding.routeGeneration) {
      return false;
    }
    return route.send(command);
  };

  const decrementWorkspace = (workspaceId: WorkspaceId) => {
    const next = (workspaceSessions.get(workspaceId) ?? 1) - 1;
    if (next <= 0) workspaceSessions.delete(workspaceId);
    else workspaceSessions.set(workspaceId, next);
  };

  const releaseTerminal = (record: InspectorSessionRecord, terminalId: string) => {
    if (!record.activeTerminalIds.delete(terminalId)) return;
    const workspaceId = record.principal.workspaceId;
    const next = (workspaceActiveTerminals.get(workspaceId) ?? 1) - 1;
    if (next <= 0) workspaceActiveTerminals.delete(workspaceId);
    else workspaceActiveTerminals.set(workspaceId, next);
  };

  const admitRequest = (record: InspectorSessionRecord, operation: InspectorOperation) => {
    const requestId = operation.requestId;
    const current = nowMs();
    if (current - record.requestWindowStartedAt >= 60_000) {
      record.requestWindowStartedAt = current;
      record.requestsInWindow = 0;
    }
    const workspaceWindow = workspaceRequestWindows.get(record.principal.workspaceId);
    const activeWorkspaceWindow =
      workspaceWindow === undefined || current - workspaceWindow.startedAt >= 60_000
        ? { startedAt: current, count: 0 }
        : workspaceWindow;
    workspaceRequestWindows.set(record.principal.workspaceId, activeWorkspaceWindow);
    if (
      record.inflightRequests.has(requestId) ||
      record.inflightRequests.size >= limits.maxInflightRequestsPerSession ||
      record.requestsInWindow >= limits.maxRequestsPerMinutePerSession ||
      activeWorkspaceWindow.count >= limits.maxRequestsPerMinutePerWorkspace
    ) {
      return false;
    }
    if (operation.type === "terminal.open") {
      if (
        record.activeTerminalIds.has(operation.terminalId) ||
        record.activeTerminalIds.size >= limits.maxActiveTerminalsPerSession ||
        (workspaceActiveTerminals.get(record.principal.workspaceId) ?? 0) >=
          limits.maxActiveTerminalsPerWorkspace
      ) {
        return false;
      }
      record.activeTerminalIds.add(operation.terminalId);
      workspaceActiveTerminals.set(
        record.principal.workspaceId,
        (workspaceActiveTerminals.get(record.principal.workspaceId) ?? 0) + 1,
      );
      record.requestOperations.set(requestId, {
        kind: "terminal.open",
        terminalId: operation.terminalId,
        state: "reserved",
      });
    } else if (operation.type === "terminal.close") {
      record.requestOperations.set(requestId, {
        kind: "terminal.close",
        terminalId: operation.terminalId,
      });
    } else {
      record.requestOperations.set(requestId, { kind: "other" });
    }
    record.inflightRequests.add(requestId);
    record.requestsInWindow += 1;
    activeWorkspaceWindow.count += 1;
    return true;
  };

  const pruneTombstones = () => {
    const current = nowMs();
    for (const [sessionId, tombstone] of closedSessions) {
      if (tombstone.expiresAt <= current) closedSessions.delete(sessionId);
    }
    while (closedSessions.size >= limits.maxClosedSessionTombstones) {
      const oldest = closedSessions.keys().next().value;
      if (oldest === undefined) break;
      closedSessions.delete(oldest);
    }
  };

  const removeSession = (
    record: InspectorSessionRecord,
    reason: "timeout" | "closed" | "replaced",
  ) => {
    if (!sessions.delete(record.sessionId)) return;
    pruneTombstones();
    closedSessions.set(record.sessionId, {
      binding: record.binding,
      expiresAt: nowMs() + limits.closedSessionTombstoneTtlMs,
    });
    if (record.heartbeat !== undefined) clearInterval(record.heartbeat);
    if (record.grace !== undefined) clearTimeout(record.grace);
    record.connection?.writer.dispose();
    record.connection?.cleanupListeners();
    record.connection = undefined;
    sendWorker(record, {
      type: "inspector.command",
      command: {
        type: "inspector.close",
        binding: record.binding,
        sessionId: record.sessionId,
        reason,
      },
    });
    for (const terminalId of record.activeTerminalIds) releaseTerminal(record, terminalId);
    record.requestOperations.clear();
    record.inflightRequests.clear();
    decrementWorkspace(record.principal.workspaceId);
  };

  const disconnectClient = (record: InspectorSessionRecord, expected?: CloudRpcSocket) => {
    if (
      record.connection === undefined ||
      (expected !== undefined && record.connection.socket !== expected)
    ) {
      return;
    }
    record.connection.writer.dispose();
    record.connection.cleanupListeners();
    record.connection = undefined;
    record.pendingHeartbeat = undefined;
    if (record.heartbeat !== undefined) clearInterval(record.heartbeat);
    record.heartbeat = undefined;
    if (record.grace !== undefined) clearTimeout(record.grace);
    record.grace = setTimeout(() => removeSession(record, "timeout"), limits.reconnectGraceMs);
    record.grace.unref?.();
  };

  const beginTerminalClose = (
    record: InspectorSessionRecord,
    replacedRequestId: string,
    operation: Extract<
      InspectorSessionRecord["requestOperations"] extends Map<string, infer Entry> ? Entry : never,
      { readonly kind: "terminal.open" }
    >,
  ) => {
    if (operation.state === "closing") return true;
    const requestId = NodeCrypto.randomUUID() as InspectorRequestId;
    operation.state = "closing";
    record.requestOperations.delete(replacedRequestId);
    record.inflightRequests.delete(replacedRequestId);
    record.requestOperations.set(requestId, {
      kind: "terminal.close",
      terminalId: operation.terminalId,
    });
    record.inflightRequests.add(requestId);
    const sent = sendWorker(record, {
      type: "inspector.command",
      command: {
        type: "inspector.request",
        binding: record.binding,
        sessionId: record.sessionId,
        operation: {
          type: "terminal.close",
          requestId,
          terminalId: operation.terminalId as never,
        },
      },
    });
    if (!sent) {
      record.requestOperations.delete(requestId);
      record.inflightRequests.delete(requestId);
    }
    return sent;
  };

  const clientPayload = (
    frame: Exclude<
      InspectorWorkerFrame,
      {
        readonly type:
          | "inspector.ready"
          | "inspector.heartbeat"
          | "inspector.artifact.proposed"
          | "inspector.resume-rejected";
      }
    >,
  ): Extract<InspectorServerFrame, { readonly type: "inspector.data" }>["payload"] => {
    switch (frame.type) {
      case "inspector.ack":
        return { type: "ack", requestId: frame.requestId };
      case "inspector.error":
        return {
          type: "error",
          ...(frame.requestId === undefined ? {} : { requestId: frame.requestId }),
          code: frame.code,
          retryable: frame.retryable,
          detail: frame.detail,
        };
      case "terminal.chunk":
        return {
          type: "terminal.chunk",
          requestId: frame.requestId,
          terminalId: frame.terminalId,
          stream: frame.stream,
          data: frame.data,
        };
      case "terminal.retired":
        return {
          type: "terminal.retired",
          terminalId: frame.terminalId,
          reason: frame.reason,
        };
      case "files.entries":
        return {
          type: "files.entries",
          requestId: frame.requestId,
          path: frame.path,
          entries: frame.entries,
        };
      case "files.contents":
        return {
          type: "files.contents",
          requestId: frame.requestId,
          path: frame.path,
          encoding: frame.encoding,
          contents: frame.contents,
          sha256: frame.sha256,
          eof: frame.eof,
        };
      case "ports.snapshot":
        return { type: "ports.snapshot", requestId: frame.requestId, ports: frame.ports };
      case "inspector.complete":
        return { type: "complete", requestId: frame.requestId };
    }
  };

  const handleArtifact = (
    record: InspectorSessionRecord,
    frame: Extract<InspectorWorkerFrame, { readonly type: "inspector.artifact.proposed" }>,
  ) =>
    Effect.gen(function* () {
      const bytes = yield* Effect.try({
        try: () => Buffer.from(frame.base64, "base64"),
        catch: (cause) => failure("invalidRequest", 400, false, "decode-artifact", cause),
      });
      if (
        bytes.byteLength > INSPECTOR_MAX_ARTIFACT_TRANSFER_BYTES ||
        bytes.byteLength !== frame.artifact.byteLength ||
        NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== frame.artifact.sha256
      ) {
        return yield* failure("invalidRequest", 400, false, "verify-artifact");
      }
      if (
        record.artifactCount >= limits.maxArtifactsPerSession ||
        record.artifactBytes + bytes.byteLength > limits.maxArtifactBytesPerSession
      ) {
        return yield* failure("slowConsumer", 429, false, "artifact-quota");
      }
      yield* options.artifacts
        .upload({
          workspaceId: record.principal.workspaceId,
          threadId: record.principal.threadId,
          artifactId: frame.artifact.artifactId,
          idempotencyKey: `${record.sessionId}:${frame.sequence}`,
          kind: frame.artifact.kind === "terminal-chunk" ? "terminal-chunk" : "screenshot",
          byteLength: bytes.byteLength,
          sha256: frame.artifact.sha256,
          mediaType: frame.artifact.mediaType,
          body: bytesSource(bytes),
        })
        .pipe(
          Effect.mapError((cause) =>
            failure("unavailable", 503, cause.retryable, "store-artifact", cause),
          ),
        );
      record.artifactCount += 1;
      record.artifactBytes += bytes.byteLength;
      const connection = record.connection;
      if (
        connection?.writer.send({
          protocolVersion: INSPECTOR_PROTOCOL_VERSION,
          type: "inspector.data",
          binding: record.binding,
          sessionId: record.sessionId,
          sequence: frame.sequence,
          payload: {
            type: "artifact",
            requestId: frame.requestId,
            artifact: frame.artifact,
          },
        })
      ) {
        record.lastDeliveredSequence = frame.sequence;
      }
    });

  const validateFrameIdentity = (
    route: ActiveWorkerRoute["lease"],
    record: InspectorSessionRecord,
    frame: InspectorWorkerFrame,
  ) => {
    if (
      !routeMatchesBinding(route, record.binding) ||
      !sameInspectorBinding(frame.binding, record.binding)
    ) {
      return Effect.fail(
        failure("identityMismatch", 400, false, "validate-inspector-frame-binding"),
      );
    }
    return Effect.void;
  };

  const handleFrame = (route: ActiveWorkerRoute["lease"], frame: InspectorWorkerFrame) =>
    Effect.gen(function* () {
      const record = sessions.get(frame.sessionId);
      if (record === undefined) {
        pruneTombstones();
        const tombstone = closedSessions.get(frame.sessionId);
        if (
          tombstone !== undefined &&
          tombstone.expiresAt > nowMs() &&
          sameInspectorBinding(frame.binding, tombstone.binding) &&
          routeMatchesBinding(route, tombstone.binding)
        ) {
          return;
        }
        return yield* failure("identityMismatch", 400, false, "validate-inspector-frame-binding");
      }
      yield* validateFrameIdentity(route, record, frame);
      if (frame.type === "inspector.resume-rejected") {
        if (
          frame.requestedAfterSequence !== record.lastDeliveredSequence ||
          (frame.reason === "history-evicted" &&
            (frame.latestSequence < frame.requestedAfterSequence ||
              frame.earliestAvailableSequence <= frame.requestedAfterSequence + 1)) ||
          (frame.reason === "session-unavailable" &&
            (frame.earliestAvailableSequence !== -1 || frame.latestSequence !== -1))
        ) {
          return yield* failure(
            "identityMismatch",
            400,
            false,
            "validate-inspector-resume-rejection",
          );
        }
        record.lastWorkerSequence = frame.latestSequence;
        record.lastDeliveredSequence = frame.latestSequence;
        record.connection?.writer.send({
          protocolVersion: INSPECTOR_PROTOCOL_VERSION,
          type: "inspector.resume-rejected",
          binding: record.binding,
          sessionId: record.sessionId,
          requestedAfterSequence: frame.requestedAfterSequence,
          earliestAvailableSequence: frame.earliestAvailableSequence,
          latestSequence: frame.latestSequence,
          reason: frame.reason,
        });
        if (frame.reason === "session-unavailable") {
          record.connection?.socket.close(4409, "inspector_resume_unavailable");
          removeSession(record, "closed");
        }
        return;
      }
      if (frame.sequence !== record.lastWorkerSequence + 1) {
        return yield* failure("identityMismatch", 400, false, "validate-inspector-frame-sequence");
      }
      record.lastWorkerSequence = frame.sequence;
      if (frame.type === "inspector.heartbeat") return;
      if (frame.type === "inspector.ready") {
        const connection = record.connection;
        if (
          connection?.writer.send({
            protocolVersion: INSPECTOR_PROTOCOL_VERSION,
            type: "inspector.opened",
            binding: record.binding,
            sessionId: record.sessionId,
            sequence: frame.sequence,
            resumedThroughSequence: record.lastDeliveredSequence,
            capabilities: frame.capabilities,
          })
        ) {
          record.lastDeliveredSequence = frame.sequence;
        }
        return;
      }
      if (frame.type === "inspector.artifact.proposed") {
        yield* handleArtifact(record, frame);
        return;
      }
      if (frame.type === "terminal.retired") {
        releaseTerminal(record, frame.terminalId);
        for (const [requestId, operation] of record.requestOperations) {
          if (operation.kind !== "other" && operation.terminalId === frame.terminalId) {
            record.requestOperations.delete(requestId);
            record.inflightRequests.delete(requestId);
          }
        }
      }
      if (frame.type === "inspector.ack") {
        const operation = record.requestOperations.get(frame.requestId);
        if (operation?.kind === "terminal.open") {
          if (operation.state === "cancelled") {
            if (!beginTerminalClose(record, frame.requestId, operation)) {
              record.connection?.socket.close(4413, "worker_backpressure");
              removeSession(record, "closed");
              return;
            }
          } else if (operation.state === "reserved") {
            operation.state = "active";
          }
        }
      }
      if (frame.type === "inspector.error" && frame.requestId !== undefined) {
        const operation = record.requestOperations.get(frame.requestId);
        if (
          operation?.kind === "terminal.open" &&
          (operation.state === "reserved" || operation.state === "cancelled")
        ) {
          releaseTerminal(record, operation.terminalId);
        }
        record.requestOperations.delete(frame.requestId);
        record.inflightRequests.delete(frame.requestId);
      }
      if (frame.type === "inspector.complete") {
        const operation = record.requestOperations.get(frame.requestId);
        if (
          operation?.kind === "terminal.open" &&
          (operation.state === "reserved" || operation.state === "cancelled")
        ) {
          releaseTerminal(record, operation.terminalId);
        }
        record.requestOperations.delete(frame.requestId);
        record.inflightRequests.delete(frame.requestId);
      }
      const connection = record.connection;
      if (
        connection?.writer.send({
          protocolVersion: INSPECTOR_PROTOCOL_VERSION,
          type: "inspector.data",
          binding: record.binding,
          sessionId: record.sessionId,
          sequence: frame.sequence,
          payload: clientPayload(frame),
        })
      ) {
        record.lastDeliveredSequence = frame.sequence;
      }
      if (frame.type === "inspector.error" && frame.requestId === undefined) {
        connection?.socket.close(4409, "inspector_resume_unavailable");
        removeSession(record, "closed");
      }
    });

  const processWorkerFrame = (route: ActiveWorkerRoute["lease"], frame: InspectorWorkerFrame) => {
    const record = sessions.get(frame.sessionId);
    const task =
      record === undefined
        ? Effect.runPromise(handleFrame(route, frame))
        : record.processing.then(() => Effect.runPromise(handleFrame(route, frame)));
    if (record !== undefined) record.processing = task.catch(() => undefined);
    return Effect.tryPromise({
      try: () => task,
      catch: (cause) =>
        isInspectorBridgeError(cause)
          ? cause
          : failure("internal", 500, true, "process-worker-frame", cause),
    });
  };

  const openAuthorizedSocket = (socket: CloudRpcSocket, principal: InspectorPrincipal) => {
    let record: InspectorSessionRecord | undefined;
    let closed = false;
    let inboundFrames = 0;
    let inboundBytes = 0;
    let processing = Promise.resolve();

    const close = (code: number, reason: string) => {
      if (closed) return;
      closed = true;
      socket.close(code, reason);
      if (record !== undefined) disconnectClient(record, socket);
      else {
        removeMessage();
        removeClose();
      }
    };

    const attachRecord = (target: InspectorSessionRecord, writer: BoundedInspectorWriter) => {
      if (target.connection !== undefined) {
        const previous = target.connection;
        target.connection.writer.dispose();
        target.connection.cleanupListeners();
        previous.socket.close(4009, "inspector_reconnected");
      }
      if (target.heartbeat !== undefined) clearInterval(target.heartbeat);
      target.heartbeat = undefined;
      target.pendingHeartbeat = undefined;
      if (target.grace !== undefined) clearTimeout(target.grace);
      target.grace = undefined;
      target.connection = {
        socket,
        writer,
        cleanupListeners: () => {
          removeMessage();
          removeClose();
        },
      };
      target.heartbeat = setInterval(() => {
        if (target.connection?.socket !== socket) return;
        if (target.pendingHeartbeat !== undefined) {
          close(4408, "heartbeat_timeout");
          return;
        }
        const nonce = NodeCrypto.randomUUID();
        target.pendingHeartbeat = nonce;
        writer.send({
          protocolVersion: INSPECTOR_PROTOCOL_VERSION,
          type: "inspector.heartbeat",
          sessionId: target.sessionId,
          nonce: nonce as never,
          sentAt: nowIso(),
        });
      }, limits.heartbeatIntervalMs);
      target.heartbeat.unref?.();
    };

    const onMessage = (payload: string | Uint8Array, binary: boolean) => {
      if (closed) return;
      const bytes = typeof payload === "string" ? Buffer.byteLength(payload) : payload.byteLength;
      if (
        binary ||
        bytes > limits.maxFrameBytes ||
        inboundFrames >= limits.maxInboundFrames ||
        inboundBytes + bytes > limits.maxInboundBytes
      ) {
        close(binary ? 1003 : bytes > limits.maxFrameBytes ? 1009 : 4413, "invalid_or_full");
        return;
      }
      inboundFrames += 1;
      inboundBytes += bytes;
      processing = processing
        .then(async () => {
          if (closed) return;
          const frame = decodeClientFrame(
            typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8"),
          );
          if (record === undefined) {
            if (
              frame.type !== "inspector.open" ||
              frame.threadId !== principal.threadId ||
              frame.attemptId !== principal.attempt.attemptId
            ) {
              close(4404, "invalid_inspector_open");
              return;
            }
            const resumed =
              frame.sessionId === undefined ? undefined : sessions.get(frame.sessionId);
            if (
              resumed !== undefined &&
              (resumed.principal.workspaceId !== principal.workspaceId ||
                resumed.principal.userId !== principal.userId ||
                resumed.principal.threadId !== principal.threadId ||
                resumed.principal.attempt.attemptId !== principal.attempt.attemptId)
            ) {
              close(4404, "inspector_session_not_found");
              return;
            }
            if (resumed === undefined) {
              if (frame.sessionId !== undefined || frame.resumeAfterSequence !== -1) {
                close(4404, "inspector_session_not_found");
                return;
              }
              if (
                sessions.size >= limits.maxSessions ||
                (workspaceSessions.get(principal.workspaceId) ?? 0) >=
                  limits.maxSessionsPerWorkspace
              ) {
                close(4429, "inspector_connection_limit");
                return;
              }
              const selected = await Effect.runPromise(currentRoute(principal));
              const sessionId = nextSessionId();
              record = {
                sessionId,
                principal,
                binding: bindingFor(selected.attempt, selected.route),
                route: selected.route,
                connection: undefined,
                lastDeliveredSequence: frame.resumeAfterSequence,
                lastWorkerSequence: frame.resumeAfterSequence,
                pendingHeartbeat: undefined,
                heartbeat: undefined,
                grace: undefined,
                processing: Promise.resolve(),
                inflightRequests: new Set(),
                requestOperations: new Map(),
                activeTerminalIds: new Set(),
                requestWindowStartedAt: nowMs(),
                requestsInWindow: 0,
                artifactCount: 0,
                artifactBytes: 0,
              };
              sessions.set(sessionId, record);
              workspaceSessions.set(
                principal.workspaceId,
                (workspaceSessions.get(principal.workspaceId) ?? 0) + 1,
              );
            } else {
              record = resumed;
              if (frame.resumeAfterSequence > record.lastDeliveredSequence) {
                close(4409, "invalid_resume_cursor");
                return;
              }
              const selected = await Effect.runPromise(currentRoute(principal));
              record.route = selected.route;
              record.binding = bindingFor(selected.attempt, selected.route);
              record.lastDeliveredSequence = frame.resumeAfterSequence;
              record.lastWorkerSequence = frame.resumeAfterSequence;
            }
            const writer = new BoundedInspectorWriter(socket, limits, () =>
              close(4413, "slow_consumer"),
            );
            attachRecord(record, writer);
            if (
              !sendWorker(record, {
                type: "inspector.command",
                command: {
                  type: "inspector.open",
                  binding: record.binding,
                  sessionId: record.sessionId,
                  resumeAfterSequence: frame.resumeAfterSequence,
                },
              })
            ) {
              close(4413, "worker_backpressure");
            }
            return;
          }
          if (frame.type === "inspector.heartbeat.ack") {
            if (frame.sessionId !== record.sessionId || frame.nonce !== record.pendingHeartbeat) {
              close(4400, "invalid_heartbeat_ack");
              return;
            }
            record.pendingHeartbeat = undefined;
            return;
          }
          if (frame.type === "inspector.open" || frame.sessionId !== record.sessionId) {
            close(4400, "invalid_inspector_frame");
            return;
          }
          if (frame.type === "inspector.request") {
            const selected = await Effect.runPromise(currentRoute(principal));
            if (
              !routeMatchesAttempt(selected.route, selected.attempt) ||
              selected.route.lease.routeGeneration !== record.binding.routeGeneration ||
              selected.attempt.attemptId !== record.binding.attemptId
            ) {
              close(4409, "stale_worker_route");
              return;
            }
            if (
              frame.operation.type === "browser.input" ||
              frame.operation.type === "desktop.input"
            ) {
              await Effect.runPromise(
                inputAuthorizer.authorize({
                  principal,
                  sessionId: record.sessionId,
                  operation: frame.operation,
                }),
              );
            }
            if (!admitRequest(record, frame.operation)) {
              close(4429, "inspector_request_limit");
              return;
            }
            if (
              !sendWorker(record, {
                type: "inspector.command",
                command: {
                  type: "inspector.request",
                  binding: record.binding,
                  sessionId: record.sessionId,
                  operation: frame.operation,
                },
              })
            ) {
              const failed = record.requestOperations.get(frame.operation.requestId);
              if (failed?.kind === "terminal.open" && failed.state === "reserved") {
                releaseTerminal(record, failed.terminalId);
              }
              record.requestOperations.delete(frame.operation.requestId);
              record.inflightRequests.delete(frame.operation.requestId);
              close(4413, "worker_backpressure");
            }
            return;
          }
          const cancelled = sendWorker(record, {
            type: "inspector.command",
            command: {
              type: "inspector.cancel",
              binding: record.binding,
              sessionId: record.sessionId,
              requestId: frame.requestId,
            },
          });
          if (!cancelled) {
            close(4413, "worker_backpressure");
            return;
          }
          const operation = record.requestOperations.get(frame.requestId);
          if (operation?.kind === "terminal.open") {
            if (operation.state === "reserved") {
              operation.state = "cancelled";
            } else if (operation.state === "active") {
              operation.state = "cancelled";
              if (!beginTerminalClose(record, frame.requestId, operation)) {
                close(4413, "worker_backpressure");
              }
            }
          }
        })
        .catch((cause: unknown) => {
          if (closed) return;
          const error = isInspectorBridgeError(cause)
            ? cause
            : failure("invalidRequest", 400, false, "process-client-frame", cause);
          close(
            error.code === "forbidden"
              ? 4403
              : error.code === "staleRoute" || error.code === "notFound"
                ? 4409
                : 4400,
            error.code,
          );
        })
        .finally(() => {
          inboundFrames -= 1;
          inboundBytes -= bytes;
        });
      const currentProcessing = processing;
      backgroundTasks.add(currentProcessing);
      void currentProcessing.finally(() => backgroundTasks.delete(currentProcessing));
    };

    const removeMessage = socket.onMessage(onMessage);
    const removeClose = socket.onClose(() => {
      if (closed) return;
      closed = true;
      if (record !== undefined) disconnectClient(record, socket);
      else {
        removeMessage();
        removeClose();
      }
    });
    return () => close(1001, "inspector_closing");
  };

  const removeRouteActivation = options.routes.subscribeActivation((route) => {
    for (const record of sessions.values()) {
      if (
        route.lease.workspaceId !== record.principal.workspaceId ||
        route.lease.threadId !== record.principal.threadId ||
        route.lease.routeGeneration <= record.binding.routeGeneration
      ) {
        continue;
      }
      if (
        route.lease.sandboxId !== record.principal.attempt.sandboxId ||
        route.lease.workerId !== record.principal.attempt.workerId
      ) {
        record.connection?.socket.close(4409, "stale_worker_route");
        removeSession(record, "replaced");
        continue;
      }
      const reactivation = Effect.runPromise(
        Effect.tryPromise({
          try: () =>
            options.lifecycle.getCurrent(record.principal.workspaceId, record.principal.threadId),
          catch: (cause) => failure("internal", 500, true, "reactivate-current-attempt", cause),
        }).pipe(
          Effect.flatMap((attempt) => {
            const latestRoute = options.routes.get(route.lease.workspaceId, route.lease.sandboxId);
            if (
              sessions.get(record.sessionId) !== record ||
              latestRoute?.lease.routeGeneration !== route.lease.routeGeneration
            ) {
              return Effect.void;
            }
            if (
              attempt === undefined ||
              !sameAttemptBinding(attempt, record.principal.attempt) ||
              !routeMatchesAttempt(route, attempt)
            ) {
              return Effect.fail(failure("staleRoute", 409, false, "reactivate-binding"));
            }
            record.route = route;
            record.binding = bindingFor(attempt, route);
            record.lastWorkerSequence = record.lastDeliveredSequence;
            return sendWorker(record, {
              type: "inspector.command",
              command: {
                type: "inspector.open",
                binding: record.binding,
                sessionId: record.sessionId,
                resumeAfterSequence: record.lastDeliveredSequence,
              },
            })
              ? Effect.void
              : Effect.fail(failure("slowConsumer", 429, true, "reactivate-send"));
          }),
          Effect.catch(() =>
            Effect.sync(() => {
              record.connection?.socket.close(4409, "stale_worker_route");
              removeSession(record, "replaced");
            }),
          ),
        ),
      );
      backgroundTasks.add(reactivation);
      void reactivation.finally(() => backgroundTasks.delete(reactivation));
    }
  });
  const removeRouteRemoval = options.routes.subscribeRemoval(({ route }) => {
    for (const record of sessions.values()) {
      if (
        record.route?.lease.workspaceId === route.lease.workspaceId &&
        record.route.lease.sandboxId === route.lease.sandboxId &&
        record.route.lease.routeGeneration === route.lease.routeGeneration
      ) {
        record.route = undefined;
      }
    }
  });

  return {
    authorizeWebSocket,
    handleHttp,
    openAuthorizedSocket,
    inspectorFrames: { handleFrame: processWorkerFrame },
    drain: Effect.promise(() => Promise.allSettled(backgroundTasks).then(() => undefined)),
    dispose: () => {
      removeRouteActivation();
      removeRouteRemoval();
      for (const record of sessions.values()) removeSession(record, "closed");
    },
    activeSessions: () => sessions.size,
    limits,
  } as const;
};

export type InspectorBridge = ReturnType<typeof makeInspectorBridge>;
