// @effect-diagnostics nodeBuiltinImport:off -- This is the native Node/WebSocket transport adapter.
// @effect-diagnostics globalTimers:off -- Upgrade authentication has the same bounded deadline as HTTP requests.
import type * as NodeHttp from "node:http";
import type * as NodeStream from "node:stream";

import { ThreadId } from "@t3tools/contracts";
import { InspectorAttemptId } from "@t3tools/contracts/inspector";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import {
  CloudRpcError,
  isCloudRpcError,
  type AuthorizedCloudWorkspace,
  type CloudRpc,
  type CloudRpcSocket,
} from "./cloudRpc.ts";
import {
  InspectorBridgeError,
  type InspectorBridge,
  type InspectorPrincipal,
} from "./inspectorBridge.ts";

const CLOUD_THREAD_EVENTS_PATH = "/api/v1/thread-events";
const INSPECTOR_PATH = "/api/v1/inspector";
const decodeThreadId = Schema.decodeUnknownSync(ThreadId);
const decodeAttemptId = Schema.decodeUnknownSync(InspectorAttemptId);

const requestHeaders = (request: NodeHttp.IncomingMessage) => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
};

const rawData = (data: RawData): string | Uint8Array => {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
};

export const adaptWebSocket = (socket: WebSocket): CloudRpcSocket => {
  // `ws` emits protocol/transport errors separately from close. Contain that
  // native EventEmitter channel; the close listener owns application cleanup.
  const containTransportError = () => undefined;
  socket.on("error", containTransportError);
  socket.once("close", () => socket.off("error", containTransportError));

  return {
    send: (payload, complete) => {
      if (socket.readyState !== WebSocket.OPEN) {
        complete(new Error("socket is not open"));
        return;
      }
      socket.send(payload, (error) => complete(error ?? undefined));
    },
    close: (code, reason) => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(code, reason);
      }
    },
    onMessage: (listener) => {
      const onMessage = (data: RawData, binary: boolean) =>
        listener(binary ? rawData(data) : Buffer.from(rawData(data)).toString("utf8"), binary);
      socket.on("message", onMessage);
      return () => socket.off("message", onMessage);
    },
    onClose: (listener) => {
      socket.on("close", listener);
      return () => socket.off("close", listener);
    },
  };
};

const rejectUpgrade = (
  socket: NodeStream.Duplex,
  status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 504,
) => {
  if (socket.destroyed) return;
  const label =
    status === 401
      ? "Unauthorized"
      : status === 403
        ? "Forbidden"
        : status === 404
          ? "Not Found"
          : status === 409
            ? "Conflict"
            : status === 429
              ? "Too Many Requests"
              : status === 504
                ? "Gateway Timeout"
                : status === 500
                  ? "Internal Server Error"
                  : "Bad Request";
  socket.end(
    `HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`,
  );
};

const statusFor = (error: CloudRpcError): 401 | 403 | 429 | 500 =>
  error.status === 401 ? 401 : error.status === 403 ? 403 : error.status === 429 ? 429 : 500;
const isInspectorBridgeError = Schema.is(InspectorBridgeError);
const inspectorStatusFor = (error: InspectorBridgeError): 400 | 401 | 403 | 404 | 409 | 429 | 500 =>
  error.status === 400 ||
  error.status === 401 ||
  error.status === 403 ||
  error.status === 404 ||
  error.status === 409 ||
  error.status === 429
    ? error.status
    : 500;

export interface AttachCloudRpcWebSocketOptions {
  readonly server: NodeHttp.Server;
  readonly rpc: CloudRpc;
  readonly baseUrl: URL;
  readonly authenticationTimeoutMs: number;
  readonly maxPendingUpgrades?: number;
  readonly inspector?: Pick<
    InspectorBridge,
    "authorizeWebSocket" | "openAuthorizedSocket" | "limits"
  >;
}

export interface CloudRpcWebSocketAttachment {
  readonly detach: () => void;
  readonly pendingUpgradeCount: () => number;
  readonly waitForPendingSettled: () => Promise<void>;
}

interface PendingUpgrade {
  readonly socket: NodeStream.Duplex;
  readonly abort: AbortController;
  readonly deadline: ReturnType<typeof setTimeout>;
  readonly onSocketClose: () => void;
  readonly onSocketError: () => void;
  readonly abandon: () => void;
  task?: Promise<void>;
}

type AuthorizedUpgrade =
  | { readonly type: "events"; readonly principal: AuthorizedCloudWorkspace }
  | { readonly type: "inspector"; readonly principal: InspectorPrincipal };

export const attachCloudRpcWebSocket = ({
  server,
  rpc,
  baseUrl,
  authenticationTimeoutMs,
  maxPendingUpgrades = 64,
  inspector,
}: AttachCloudRpcWebSocketOptions): CloudRpcWebSocketAttachment => {
  const webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: rpc.limits.maxFrameBytes,
    perMessageDeflate: false,
  });
  const inspectorWebSockets =
    inspector === undefined
      ? undefined
      : new WebSocketServer({
          noServer: true,
          maxPayload: inspector.limits.maxFrameBytes,
          perMessageDeflate: false,
        });
  const pendingUpgrades = new Set<PendingUpgrade>();
  const pendingSettledWaiters = new Set<() => void>();
  let attached = true;

  const onUpgrade = (
    request: NodeHttp.IncomingMessage,
    socket: NodeStream.Duplex,
    head: Buffer,
  ) => {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", baseUrl);
    } catch {
      rejectUpgrade(socket, 400);
      return;
    }
    const inspectorRequest = url.pathname === INSPECTOR_PATH;
    if (url.pathname !== CLOUD_THREAD_EVENTS_PATH && !inspectorRequest) {
      rejectUpgrade(socket, 404);
      return;
    }
    if (inspectorRequest && inspector === undefined) {
      rejectUpgrade(socket, 404);
      return;
    }
    if (request.method !== "GET") {
      rejectUpgrade(socket, 400);
      return;
    }
    if (!attached) {
      socket.destroy();
      return;
    }
    if (pendingUpgrades.size >= maxPendingUpgrades) {
      rejectUpgrade(socket, 429);
      return;
    }

    const abort = new AbortController();
    const onSocketError = () => undefined;
    let abandoned = false;
    let timedOut = false;
    const abandon = () => {
      abandoned = true;
      // This is a best-effort cancellation hint. The record remains counted
      // until the original authorization promise actually settles.
      abort.abort();
    };
    const onSocketClose = () => {
      if (!timedOut) abandon();
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      abandoned = true;
      rejectUpgrade(socket, 504);
    }, authenticationTimeoutMs);
    const pending: PendingUpgrade = {
      socket,
      abort,
      deadline,
      onSocketClose,
      onSocketError,
      abandon,
    };
    pendingUpgrades.add(pending);
    socket.once("close", onSocketClose);
    socket.on("error", onSocketError);

    const authorization: Effect.Effect<AuthorizedUpgrade, CloudRpcError | InspectorBridgeError> =
      inspectorRequest
        ? Effect.try({
            try: () => ({
              threadId: decodeThreadId(url.searchParams.get("threadId")),
              attemptId: decodeAttemptId(url.searchParams.get("attemptId")),
            }),
            catch: () =>
              new InspectorBridgeError({
                code: "invalidRequest",
                status: 400,
                retryable: false,
                operation: "decode-inspector-upgrade",
              }),
          }).pipe(
            Effect.flatMap((requested) =>
              inspector!.authorizeWebSocket(requestHeaders(request), requested, abort.signal),
            ),
            Effect.map((principal) => ({ type: "inspector" as const, principal })),
          )
        : rpc
            .authorizeWebSocket(requestHeaders(request), abort.signal)
            .pipe(Effect.map((principal) => ({ type: "events" as const, principal })));

    const task = Effect.runPromise(authorization)
      .then(
        (authorized) => {
          if (!attached || abandoned || socket.destroyed) return;
          if (authorized.type === "inspector") {
            inspectorWebSockets!.handleUpgrade(request, socket, head, (webSocket) => {
              inspectorWebSockets!.emit("connection", webSocket, request);
              inspector!.openAuthorizedSocket(adaptWebSocket(webSocket), authorized.principal);
            });
            return;
          }
          webSockets.handleUpgrade(request, socket, head, (webSocket) => {
            webSockets.emit("connection", webSocket, request);
            rpc.openAuthorizedSocket(adaptWebSocket(webSocket), authorized.principal);
          });
        },
        (cause: unknown) => {
          if (!attached || abandoned) return;
          rejectUpgrade(
            socket,
            isCloudRpcError(cause)
              ? statusFor(cause)
              : isInspectorBridgeError(cause)
                ? inspectorStatusFor(cause)
                : 500,
          );
        },
      )
      .finally(() => {
        clearTimeout(deadline);
        socket.off("close", onSocketClose);
        socket.off("error", onSocketError);
        pendingUpgrades.delete(pending);
        if (pendingUpgrades.size === 0) {
          for (const notify of pendingSettledWaiters) notify();
          pendingSettledWaiters.clear();
        }
      });
    pending.task = task;
    void task;
  };

  server.on("upgrade", onUpgrade);
  const detach = () => {
    if (!attached) return;
    attached = false;
    server.off("upgrade", onUpgrade);
    for (const pending of pendingUpgrades) {
      clearTimeout(pending.deadline);
      pending.abandon();
      pending.socket.destroy();
    }
    // Finalization must not wait indefinitely for an unresponsive peer to
    // acknowledge a close frame; every session still receives its close event.
    for (const client of webSockets.clients) client.terminate();
    webSockets.close();
    if (inspectorWebSockets !== undefined) {
      for (const client of inspectorWebSockets.clients) client.terminate();
      inspectorWebSockets.close();
    }
  };
  return {
    detach,
    pendingUpgradeCount: () => pendingUpgrades.size,
    waitForPendingSettled: () =>
      pendingUpgrades.size === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => pendingSettledWaiters.add(resolve)),
  };
};
