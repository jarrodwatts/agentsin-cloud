// @effect-diagnostics nodeBuiltinImport:off -- Non-secret heartbeat correlation uses Node's UUID generator.
// @effect-diagnostics globalTimers:off -- WebSocket heartbeats are transport deadlines cleaned up with each connection.
import * as NodeCrypto from "node:crypto";

import type { ThreadId } from "@t3tools/contracts";
import {
  CLOUD_DESKTOP_RPC_VERSION,
  CreateCloudThreadRequest,
  CloudThreadCommandSubmissionRequest,
  CloudThreadStreamClientFrame,
  type CloudThreadStreamErrorCode,
  type CloudThreadStreamServerFrame,
  WorkspaceId,
  type WorkspaceId as WorkspaceIdType,
} from "@t3tools/contracts/cloud";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ControlPlaneAuth } from "./http.ts";
import {
  CONTROL_MUTATION_RATE_POLICY,
  type EphemeralCoordinationService,
} from "./ephemeralCoordination.ts";
import { type ThreadEventStoreError, type ThreadEventStoreService } from "./threadEventStore.ts";
import type { WorkspaceRepositoryService } from "./workspaces.ts";

export const DEFAULT_CLOUD_RPC_LIMITS = {
  maxCommandBodyBytes: 256 * 1_024,
  maxFrameBytes: 64 * 1_024,
  maxQueuedFrames: 128,
  maxQueuedBytes: 512 * 1_024,
  replayBatchSize: 256,
  maxConnections: 1_000,
  maxConnectionsPerWorkspace: 20,
  eventPollIntervalMs: 1_000,
  heartbeatIntervalMs: 30_000,
} as const;

export interface CloudRpcLimits {
  readonly maxCommandBodyBytes: number;
  readonly maxFrameBytes: number;
  readonly maxQueuedFrames: number;
  readonly maxQueuedBytes: number;
  readonly replayBatchSize: number;
  readonly maxConnections: number;
  readonly maxConnectionsPerWorkspace: number;
  readonly eventPollIntervalMs: number;
  readonly heartbeatIntervalMs: number;
}

export interface CloudRpcSocket {
  readonly send: (payload: string, complete: (error?: Error) => void) => void;
  readonly close: (code: number, reason: string) => void;
  readonly onMessage: (
    listener: (payload: string | Uint8Array, binary: boolean) => void,
  ) => () => void;
  readonly onClose: (listener: () => void) => () => void;
}

export interface AuthorizedCloudWorkspace {
  readonly workspaceId: WorkspaceIdType;
  readonly userId: string;
}

export interface ThreadEventSignalHub {
  readonly subscribe: (
    workspaceId: WorkspaceIdType,
    threadId: ThreadId,
    listener: () => void,
  ) => () => void;
  readonly publish: (workspaceId: WorkspaceIdType, threadId: ThreadId) => void;
  readonly subscriberCount: () => number;
}

export const makeThreadEventSignalHub = (): ThreadEventSignalHub => {
  const listeners = new Map<string, Set<() => void>>();
  const keyFor = (workspaceId: WorkspaceIdType, threadId: ThreadId) =>
    JSON.stringify([workspaceId, threadId]);
  return {
    subscribe: (workspaceId, threadId, listener) => {
      const key = keyFor(workspaceId, threadId);
      const entries = listeners.get(key) ?? new Set<() => void>();
      entries.add(listener);
      listeners.set(key, entries);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        entries.delete(listener);
        if (entries.size === 0) listeners.delete(key);
      };
    },
    publish: (workspaceId, threadId) => {
      for (const listener of listeners.get(keyFor(workspaceId, threadId)) ?? []) listener();
    },
    subscriberCount: () =>
      [...listeners.values()].reduce((total, entries) => total + entries.size, 0),
  };
};

export class CloudRpcError extends Schema.TaggedErrorClass<CloudRpcError>()("CloudRpcError", {
  code: Schema.Literals([
    "unauthorized",
    "forbidden",
    "invalidRequest",
    "notFound",
    "replayGap",
    "slowConsumer",
    "connectionLimit",
    "rateLimited",
    "internalError",
  ]),
  status: Schema.Int,
  retryable: Schema.Boolean,
}) {}

const decoder = <A>(schema: Schema.Decoder<A, never>) => Schema.decodeUnknownEffect(schema);
const decodeCommandSubmission = decoder(CloudThreadCommandSubmissionRequest);
const decodeClientFrameJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CloudThreadStreamClientFrame),
);
const decodeWorkspaceId = decoder(WorkspaceId);
const decodeUnknownJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
export const isCloudRpcError = Schema.is(CloudRpcError);

const trustedDesktopOrigins = new Set([
  "t3code://app",
  "t3code-dev://app",
  "agentsincloud://app",
  "agentsincloud-dev://app",
]);

const hasBearer = (headers: Headers) => /^Bearer\s+\S+$/u.test(headers.get("authorization") ?? "");

export const isTrustedCloudRpcOrigin = (headers: Headers, hostedOrigin: string) => {
  const origin = headers.get("origin");
  if (origin === null) return hasBearer(headers);
  return origin === hostedOrigin || trustedDesktopOrigins.has(origin);
};

const jsonResponse = (
  body: unknown,
  status = 200,
  origin?: string,
  extraHeaders: Readonly<Record<string, string>> = {},
) =>
  Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
      ...(origin === undefined
        ? {}
        : {
            "access-control-allow-origin": origin,
            vary: "Origin",
          }),
    },
  });

const publicError = (error: CloudRpcError, origin?: string) =>
  jsonResponse({ error: error.code, retryable: error.retryable }, error.status, origin);

const mapStoreError = (error: ThreadEventStoreError) => {
  if (error.code === "notFound" || error.code === "tenantMismatch") {
    return new CloudRpcError({ code: "notFound", status: 404, retryable: false });
  }
  if (error.code === "replayGap" || error.code === "sequenceConflict") {
    return new CloudRpcError({ code: "replayGap", status: 409, retryable: true });
  }
  if (error.code === "invalidRecord" || error.code === "idempotencyConflict") {
    return new CloudRpcError({ code: "invalidRequest", status: 409, retryable: false });
  }
  return new CloudRpcError({ code: "internalError", status: 500, retryable: true });
};

const readBoundedJson = (request: Request, maxBytes: number) =>
  Effect.tryPromise({
    try: async () => {
      const declared = Number(request.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new CloudRpcError({ code: "invalidRequest", status: 413, retryable: false });
      }
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength > maxBytes) {
        throw new CloudRpcError({ code: "invalidRequest", status: 413, retryable: false });
      }
      return decodeUnknownJson(new TextDecoder().decode(bytes));
    },
    catch: (cause) =>
      isCloudRpcError(cause)
        ? cause
        : new CloudRpcError({ code: "invalidRequest", status: 400, retryable: false }),
  });

class ConnectionLimiter {
  private total = 0;
  private readonly byWorkspace = new Map<WorkspaceIdType, number>();
  private readonly limits: CloudRpcLimits;

  constructor(limits: CloudRpcLimits) {
    this.limits = limits;
  }

  acquire(workspaceId: WorkspaceIdType): (() => void) | undefined {
    const workspaceCount = this.byWorkspace.get(workspaceId) ?? 0;
    if (
      this.total >= this.limits.maxConnections ||
      workspaceCount >= this.limits.maxConnectionsPerWorkspace
    ) {
      return undefined;
    }
    this.total += 1;
    this.byWorkspace.set(workspaceId, workspaceCount + 1);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.total -= 1;
      const remaining = (this.byWorkspace.get(workspaceId) ?? 1) - 1;
      if (remaining === 0) this.byWorkspace.delete(workspaceId);
      else this.byWorkspace.set(workspaceId, remaining);
    };
  }

  activeConnections() {
    return this.total;
  }
}

class BoundedSocketWriter {
  private readonly queue: Array<{ readonly payload: string; readonly bytes: number }> = [];
  private queuedBytes = 0;
  private sending = false;
  private closed = false;
  private readonly socket: CloudRpcSocket;
  private readonly limits: CloudRpcLimits;
  private readonly onFailure: (code: number, reason: string) => void;

  constructor(
    socket: CloudRpcSocket,
    limits: CloudRpcLimits,
    onFailure: (code: number, reason: string) => void,
  ) {
    this.socket = socket;
    this.limits = limits;
    this.onFailure = onFailure;
  }

  enqueue(frame: CloudThreadStreamServerFrame) {
    if (this.closed) return false;
    const payload = JSON.stringify(frame);
    const bytes = Buffer.byteLength(payload);
    if (bytes > this.limits.maxFrameBytes) {
      this.fail(4500, "server_frame_too_large");
      return false;
    }
    if (
      this.queue.length >= this.limits.maxQueuedFrames ||
      this.queuedBytes + bytes > this.limits.maxQueuedBytes
    ) {
      this.fail(4413, "slow_consumer");
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

  private fail(code: number, reason: string) {
    if (this.closed) return;
    this.dispose();
    this.onFailure(code, reason);
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
        this.fail(4500, "transport_failure");
        return;
      }
      this.queue.shift();
      this.queuedBytes -= next.bytes;
      this.drain();
    });
  }
}

export interface MakeCloudRpcOptions {
  readonly auth: ControlPlaneAuth;
  readonly hostedOrigin: string;
  readonly workspaces: WorkspaceRepositoryService;
  readonly eventStore: ThreadEventStoreService;
  readonly signals?: ThreadEventSignalHub;
  readonly coordination?: EphemeralCoordinationService;
  readonly lifecycle?: {
    readonly createThread: (
      userId: string,
      input: CreateCloudThreadRequest,
    ) => Effect.Effect<unknown, { readonly code: string; readonly retryable: boolean }>;
  };
  readonly limits?: Partial<CloudRpcLimits>;
}

export const makeCloudRpc = (options: MakeCloudRpcOptions) => {
  const configuredLimits = { ...DEFAULT_CLOUD_RPC_LIMITS, ...options.limits };
  const limits: CloudRpcLimits = {
    ...configuredLimits,
    // A broken caller must not turn the durable recheck into a busy loop.
    eventPollIntervalMs:
      Number.isFinite(configuredLimits.eventPollIntervalMs) &&
      configuredLimits.eventPollIntervalMs >= 25
        ? configuredLimits.eventPollIntervalMs
        : DEFAULT_CLOUD_RPC_LIMITS.eventPollIntervalMs,
  };
  const signals = options.signals ?? makeThreadEventSignalHub();
  const limiter = new ConnectionLimiter(limits);

  const authenticate = (headers: Headers, externalSignal?: AbortSignal) =>
    Effect.tryPromise({
      try: (signal) => options.auth.api.getSession({ headers, signal: externalSignal ?? signal }),
      catch: () => new CloudRpcError({ code: "internalError", status: 500, retryable: true }),
    }).pipe(
      Effect.flatMap((session) =>
        session === null
          ? Effect.fail(new CloudRpcError({ code: "unauthorized", status: 401, retryable: false }))
          : options.workspaces.ensureForUser(session.user).pipe(
              Effect.mapError(
                () => new CloudRpcError({ code: "internalError", status: 500, retryable: true }),
              ),
              Effect.flatMap((workspace) =>
                decodeWorkspaceId(workspace.id).pipe(
                  Effect.mapError(
                    () =>
                      new CloudRpcError({
                        code: "internalError",
                        status: 500,
                        retryable: false,
                      }),
                  ),
                  Effect.map((workspaceId) => ({ workspaceId, userId: session.user.id })),
                ),
              ),
            ),
      ),
    );

  const authorize = (headers: Headers, signal?: AbortSignal) =>
    isTrustedCloudRpcOrigin(headers, options.hostedOrigin)
      ? authenticate(headers, signal)
      : Effect.fail(new CloudRpcError({ code: "forbidden", status: 403, retryable: false }));

  const handleHttp = (request: Request): Effect.Effect<Response | undefined, never> => {
    const url = new URL(request.url);
    if (url.pathname === "/api/v1/threads" && request.method === "OPTIONS") {
      const requestOrigin = request.headers.get("origin") ?? undefined;
      if (
        requestOrigin === undefined ||
        !isTrustedCloudRpcOrigin(request.headers, options.hostedOrigin)
      ) {
        return Effect.succeed(jsonResponse({ error: "forbidden" }, 403));
      }
      return Effect.succeed(
        new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": requestOrigin,
            "access-control-allow-headers": "authorization, content-type",
            "access-control-allow-methods": "POST, OPTIONS",
            "access-control-max-age": "600",
            vary: "Origin",
          },
        }),
      );
    }
    if (url.pathname === "/api/v1/threads" && request.method === "POST") {
      const requestOrigin = request.headers.get("origin") ?? undefined;
      return Effect.gen(function* () {
        const principal = yield* authorize(request.headers, request.signal);
        if (options.lifecycle === undefined) {
          return yield* new CloudRpcError({
            code: "internalError",
            status: 503,
            retryable: true,
          });
        }
        if (options.coordination !== undefined) {
          const decision = yield* options.coordination
            .consumeRateLimit({
              workspaceId: principal.workspaceId,
              subjectKind: "user",
              subjectId: principal.userId,
              policy: CONTROL_MUTATION_RATE_POLICY,
            })
            .pipe(
              Effect.mapError(
                () =>
                  new CloudRpcError({
                    code: "internalError",
                    status: 503,
                    retryable: true,
                  }),
              ),
            );
          if (!decision.allowed) {
            return jsonResponse(
              { error: "rateLimited", retryable: true, retryAfterMs: decision.retryAfterMs },
              429,
              requestOrigin,
              { "retry-after": String(Math.max(1, Math.ceil(decision.retryAfterMs / 1_000))) },
            );
          }
        }
        const input = yield* readBoundedJson(request, limits.maxCommandBodyBytes).pipe(
          Effect.flatMap(decoder(CreateCloudThreadRequest)),
          Effect.mapError((error) =>
            isCloudRpcError(error)
              ? error
              : new CloudRpcError({ code: "invalidRequest", status: 400, retryable: false }),
          ),
        );
        const view = yield* options.lifecycle.createThread(principal.userId, input).pipe(
          Effect.mapError(
            (cause) =>
              new CloudRpcError({
                code:
                  cause.code === "unauthorized"
                    ? "forbidden"
                    : cause.code === "notFound"
                      ? "notFound"
                      : cause.code === "conflict" || cause.code === "invalidEnvironment"
                        ? "invalidRequest"
                        : "internalError",
                status:
                  cause.code === "unauthorized"
                    ? 403
                    : cause.code === "notFound"
                      ? 404
                      : cause.code === "conflict" || cause.code === "invalidEnvironment"
                        ? 409
                        : 503,
                retryable: cause.retryable,
              }),
          ),
        );
        return jsonResponse(view, 201, requestOrigin);
      }).pipe(
        Effect.catch((error) => Effect.succeed(publicError(error, requestOrigin))),
        Effect.catchCause(() =>
          Effect.succeed(
            publicError(
              new CloudRpcError({ code: "internalError", status: 500, retryable: true }),
              requestOrigin,
            ),
          ),
        ),
      );
    }
    const match = /^\/api\/v1\/threads\/([^/]+)\/commands$/u.exec(url.pathname);
    if (match === null) return Effect.sync(() => undefined);
    const requestOrigin = request.headers.get("origin") ?? undefined;
    if (request.method === "OPTIONS") {
      if (
        requestOrigin === undefined ||
        !isTrustedCloudRpcOrigin(request.headers, options.hostedOrigin)
      ) {
        return Effect.succeed(jsonResponse({ error: "forbidden" }, 403));
      }
      return Effect.succeed(
        new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-headers": "Authorization, Content-Type",
            "access-control-allow-methods": "POST",
            "access-control-allow-origin": requestOrigin,
            "access-control-max-age": "600",
            vary: "Origin",
          },
        }),
      );
    }
    if (request.method !== "POST") {
      return Effect.succeed(jsonResponse({ error: "method_not_allowed" }, 405, requestOrigin));
    }

    return Effect.gen(function* () {
      const principal = yield* authorize(request.headers);
      const submitted = yield* readBoundedJson(request, limits.maxCommandBodyBytes).pipe(
        Effect.flatMap(decodeCommandSubmission),
        Effect.mapError((error) =>
          isCloudRpcError(error)
            ? error
            : new CloudRpcError({ code: "invalidRequest", status: 400, retryable: false }),
        ),
      );
      const routeThreadId = yield* Effect.try({
        try: () => decodeURIComponent(match[1]!),
        catch: () => new CloudRpcError({ code: "invalidRequest", status: 400, retryable: false }),
      });
      if (
        submitted.envelope.workspaceId !== principal.workspaceId ||
        submitted.envelope.threadId !== routeThreadId
      ) {
        return yield* new CloudRpcError({ code: "notFound", status: 404, retryable: false });
      }
      if (options.coordination !== undefined) {
        const decision = yield* options.coordination
          .consumeRateLimit({
            workspaceId: principal.workspaceId,
            subjectKind: "user",
            subjectId: principal.userId,
            policy: CONTROL_MUTATION_RATE_POLICY,
          })
          .pipe(
            Effect.mapError(
              () =>
                new CloudRpcError({
                  code: "internalError",
                  status: 503,
                  retryable: true,
                }),
            ),
          );
        if (!decision.allowed) {
          return jsonResponse(
            { error: "rateLimited", retryable: true, retryAfterMs: decision.retryAfterMs },
            429,
            requestOrigin,
            { "retry-after": String(Math.max(1, Math.ceil(decision.retryAfterMs / 1_000))) },
          );
        }
      }
      const result = yield* options.eventStore
        .submitCommand({
          idempotencyKey: submitted.idempotencyKey,
          envelope: { ...submitted.envelope, workspaceId: principal.workspaceId },
        })
        .pipe(Effect.mapError(mapStoreError));
      return jsonResponse(
        {
          protocolVersion: CLOUD_DESKTOP_RPC_VERSION,
          disposition: result.disposition,
          commandId: result.commandId,
        },
        result.disposition === "accepted" ? 202 : 200,
        requestOrigin,
      );
    }).pipe(
      Effect.catch((error) => Effect.succeed(publicError(error, requestOrigin))),
      Effect.catchCause(() =>
        Effect.succeed(
          publicError(
            new CloudRpcError({ code: "internalError", status: 500, retryable: true }),
            requestOrigin,
          ),
        ),
      ),
    );
  };

  const openAuthorizedSocket = (socket: CloudRpcSocket, principal: AuthorizedCloudWorkspace) => {
    const releaseConnection = limiter.acquire(principal.workspaceId);
    if (releaseConnection === undefined) {
      socket.close(4429, "connection_limit");
      return () => undefined;
    }

    const abort = new AbortController();
    let disposed = false;
    let subscribed = false;
    let cursor = -1;
    let threadId: ThreadId | undefined;
    let unsubscribeSignal: (() => void) | undefined;
    let pumping = false;
    let pumpAgain = false;
    let initialReplayAcknowledged = false;
    let eventPoll: ReturnType<typeof setTimeout> | undefined;
    let pendingHeartbeat: string | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      abort.abort();
      if (heartbeat !== undefined) clearInterval(heartbeat);
      if (eventPoll !== undefined) clearTimeout(eventPoll);
      unsubscribeMessage();
      unsubscribeClose();
      unsubscribeSignal?.();
      writer.dispose();
      releaseConnection();
    };
    const close = (code: number, reason: string) => {
      if (disposed) return;
      socket.close(code, reason);
      cleanup();
    };
    const writer = new BoundedSocketWriter(socket, limits, close);

    const failStream = (error: CloudRpcError) => {
      writer.enqueue({
        protocolVersion: CLOUD_DESKTOP_RPC_VERSION,
        type: "error",
        code: error.code as CloudThreadStreamErrorCode,
        retryable: error.retryable,
      });
      close(
        error.code === "notFound"
          ? 4404
          : error.code === "replayGap"
            ? 4409
            : error.code === "slowConsumer"
              ? 4413
              : 4500,
        error.code,
      );
    };

    const schedulePoll = () => {
      if (disposed || !subscribed || eventPoll !== undefined) return;
      eventPoll = setTimeout(() => {
        eventPoll = undefined;
        pump();
      }, limits.eventPollIntervalMs);
      eventPoll.unref?.();
    };

    const pump = () => {
      if (disposed || threadId === undefined) return;
      if (pumping) {
        pumpAgain = true;
        return;
      }
      pumping = true;
      pumpAgain = false;
      void Effect.runPromise(
        Effect.gen(function* () {
          let delivered = 0;
          let window = yield* options.eventStore
            .replayAfter(principal.workspaceId, threadId!, cursor, limits.replayBatchSize)
            .pipe(Effect.mapError(mapStoreError));
          while (true) {
            if (disposed) return;
            for (const event of window.events) {
              if (event.event.sequence !== cursor + 1) {
                return yield* new CloudRpcError({
                  code: "replayGap",
                  status: 409,
                  retryable: true,
                });
              }
              if (
                !writer.enqueue({
                  protocolVersion: CLOUD_DESKTOP_RPC_VERSION,
                  type: "event",
                  event,
                })
              ) {
                return;
              }
              cursor = event.event.sequence;
              delivered += 1;
            }
            if (!window.hasMore) break;
            window = yield* options.eventStore
              .replayAfter(principal.workspaceId, threadId!, cursor, limits.replayBatchSize)
              .pipe(Effect.mapError(mapStoreError));
          }
          if (!disposed && (!initialReplayAcknowledged || delivered > 0)) {
            writer.enqueue({
              protocolVersion: CLOUD_DESKTOP_RPC_VERSION,
              type: "caughtUp",
              threadId: threadId!,
              lastSequence: cursor,
            });
            initialReplayAcknowledged = true;
          }
        }),
        { signal: abort.signal },
      ).then(
        () => {
          pumping = false;
          if (pumpAgain) pump();
          else schedulePoll();
        },
        (cause: unknown) => {
          pumping = false;
          if (disposed || abort.signal.aborted) return;
          failStream(
            isCloudRpcError(cause)
              ? cause
              : new CloudRpcError({ code: "internalError", status: 500, retryable: true }),
          );
        },
      );
    };

    const onMessage = (payload: string | Uint8Array, binary: boolean) => {
      if (disposed) return;
      const bytes = typeof payload === "string" ? Buffer.byteLength(payload) : payload.byteLength;
      if (binary || bytes > limits.maxFrameBytes) {
        close(
          bytes > limits.maxFrameBytes ? 1009 : 1003,
          bytes > limits.maxFrameBytes ? "frame_too_large" : "binary_forbidden",
        );
        return;
      }
      void Effect.runPromise(decodeClientFrameJson(payload)).then(
        (frame) => {
          if (disposed) return;
          if (frame.type === "subscribe") {
            if (subscribed) {
              close(4400, "duplicate_subscription");
              return;
            }
            subscribed = true;
            threadId = frame.threadId;
            cursor = frame.afterSequence;
            writer.enqueue({
              protocolVersion: CLOUD_DESKTOP_RPC_VERSION,
              type: "subscribed",
              threadId,
              afterSequence: cursor,
            });
            unsubscribeSignal = signals.subscribe(principal.workspaceId, threadId, () => {
              if (eventPoll !== undefined) {
                clearTimeout(eventPoll);
                eventPoll = undefined;
              }
              pump();
            });
            pump();
            return;
          }
          if (!subscribed || frame.nonce !== pendingHeartbeat) {
            close(4400, "invalid_heartbeat_ack");
            return;
          }
          pendingHeartbeat = undefined;
        },
        () => close(4400, "invalid_frame"),
      );
    };

    const unsubscribeMessage = socket.onMessage(onMessage);
    const unsubscribeClose = socket.onClose(cleanup);
    heartbeat = setInterval(() => {
      if (disposed) return;
      if (pendingHeartbeat !== undefined) {
        close(4408, "heartbeat_timeout");
        return;
      }
      const nonce = NodeCrypto.randomUUID();
      pendingHeartbeat = nonce;
      writer.enqueue({
        protocolVersion: CLOUD_DESKTOP_RPC_VERSION,
        type: "heartbeat",
        nonce,
        sentAt: DateTime.formatIso(DateTime.nowUnsafe()),
      });
    }, limits.heartbeatIntervalMs);

    return cleanup;
  };

  return {
    handleHttp,
    authorizeWebSocket: (headers: Headers, signal?: AbortSignal) => authorize(headers, signal),
    openAuthorizedSocket,
    signals,
    activeConnections: () => limiter.activeConnections(),
    limits,
  };
};

export type CloudRpc = ReturnType<typeof makeCloudRpc>;
