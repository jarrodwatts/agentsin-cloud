// @effect-diagnostics nodeBuiltinImport:off -- This is the direct Node HTTPS/TLS and WebSocket transport boundary.
// @effect-diagnostics globalTimers:off -- Handshake/request deadlines are bounded and cleared on settlement.
// @effect-diagnostics effectSucceedWithVoid:off -- The optional route handler deliberately returns typed undefined.
import * as NodeHttps from "node:https";
import type * as NodeHttp from "node:http";
import type * as NodeStream from "node:stream";
import type * as NodeTls from "node:tls";

import {
  WorkerCertificateBootstrapRequest,
  WorkerCertificateRotationRequest,
  WorkerCommandClaimRequest,
  WorkerGitHubTokenRedeemRequest,
  WORKER_GITHUB_TOKEN_REDEEM_PATH,
} from "@t3tools/contracts/worker";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import type { WorkerIdentityService } from "./workerIdentity.ts";
import type { GitHubTokenLeaseBroker } from "./githubTokenLeaseBroker.ts";
import type { WorkerRelay, WorkerRelaySocket } from "./workerRelay.ts";

export const WORKER_BOOTSTRAP_PATH = "/api/v1/worker-certificates/bootstrap";
export const WORKER_ROTATE_PATH = "/api/v1/worker-certificates/rotate";
export const WORKER_CLAIM_PATH = "/api/v1/worker-commands/claim";
export const WORKER_RELAY_PATH = "/api/v1/worker-relay";

export interface WorkerMtlsServerLimits {
  readonly maxBodyBytes: number;
  readonly maxConnections: number;
  readonly maxPendingHandshakes: number;
  readonly authenticationTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly headersTimeoutMs: number;
  readonly tlsHandshakeTimeoutMs: number;
}

export const DEFAULT_WORKER_MTLS_SERVER_LIMITS: WorkerMtlsServerLimits = {
  maxBodyBytes: 64 * 1024,
  maxConnections: 2_000,
  maxPendingHandshakes: 128,
  authenticationTimeoutMs: 5_000,
  requestTimeoutMs: 10_000,
  headersTimeoutMs: 5_000,
  tlsHandshakeTimeoutMs: 5_000,
};

export interface WorkerMtlsConnectionAdmission {
  readonly handshakeComplete: () => void;
  readonly close: () => void;
}

/** Pure, teardown-safe admission accounting for raw TCP and TLS handshakes. */
export const makeWorkerMtlsConnectionAdmission = (
  limits: Pick<WorkerMtlsServerLimits, "maxConnections" | "maxPendingHandshakes">,
) => {
  let total = 0;
  let pending = 0;
  const pendingAdmissions = new Set<WorkerMtlsConnectionAdmission>();
  const admit = (): WorkerMtlsConnectionAdmission | undefined => {
    if (total >= limits.maxConnections || pending >= limits.maxPendingHandshakes) {
      return undefined;
    }
    total += 1;
    pending += 1;
    let open = true;
    let handshakePending = true;
    const admission: WorkerMtlsConnectionAdmission = {
      handshakeComplete: () => {
        if (!open || !handshakePending) return;
        handshakePending = false;
        pending -= 1;
        pendingAdmissions.delete(admission);
      },
      close: () => {
        if (!open) return;
        open = false;
        total -= 1;
        if (handshakePending) {
          handshakePending = false;
          pending -= 1;
          pendingAdmissions.delete(admission);
        }
      },
    };
    pendingAdmissions.add(admission);
    return admission;
  };
  return {
    admit,
    completeNextHandshake: () => pendingAdmissions.values().next().value?.handshakeComplete(),
    totalConnections: () => total,
    pendingHandshakes: () => pending,
  } as const;
};

const bootstrapDecoder = Schema.decodeUnknownSync(WorkerCertificateBootstrapRequest);
const rotationDecoder = Schema.decodeUnknownSync(WorkerCertificateRotationRequest);
const claimDecoder = Schema.decodeUnknownSync(WorkerCommandClaimRequest);
const githubTokenRedeemDecoder = Schema.decodeUnknownSync(WorkerGitHubTokenRedeemRequest);
const decodeUnknownJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

class WorkerMtlsTransportError extends Schema.TaggedErrorClass<WorkerMtlsTransportError>()(
  "WorkerMtlsTransportError",
  { operation: Schema.String, cause: Schema.optionalKey(Schema.Unknown) },
) {}

const noStoreJson = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });

const decodeBoundedRequest = async (request: Request, maxBytes: number) => {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("body too large");
  if (request.body === null) throw new Error("request body is required");
  const reader = request.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("body too large");
        throw new Error("body too large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(
    Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      total,
    ).toString("utf8"),
  ) as unknown;
};

/** Public HTTPS route. The token is single-use and its value is never logged. */
export const makeWorkerBootstrapHandler =
  (input: { readonly identities: WorkerIdentityService; readonly maxBodyBytes?: number }) =>
  (request: Request): Effect.Effect<Response | undefined, never> => {
    const url = new URL(request.url);
    if (url.pathname !== WORKER_BOOTSTRAP_PATH) return Effect.succeed(undefined);
    if (request.method !== "POST") return Effect.succeed(noStoreJson({ error: "not_found" }, 404));
    return Effect.tryPromise(() =>
      decodeBoundedRequest(
        request,
        input.maxBodyBytes ?? DEFAULT_WORKER_MTLS_SERVER_LIMITS.maxBodyBytes,
      ),
    ).pipe(
      Effect.flatMap((unknown) =>
        Effect.try({
          try: () => bootstrapDecoder(unknown),
          catch: (cause) => new WorkerMtlsTransportError({ operation: "decode-bootstrap", cause }),
        }),
      ),
      Effect.flatMap((body) => input.identities.exchangeBootstrapToken(body)),
      Effect.map((grant) => noStoreJson(grant)),
      Effect.catch((cause) =>
        Effect.succeed(
          noStoreJson(
            {
              error:
                typeof cause === "object" &&
                cause !== null &&
                "code" in cause &&
                cause.code === "replayed"
                  ? "invalid_or_used_bootstrap"
                  : "certificate_exchange_failed",
            },
            401,
          ),
        ),
      ),
    );
  };

const peerSanUris = (subjectAltName: string | undefined): ReadonlyArray<string> =>
  (subjectAltName ?? "")
    .split(", ")
    .filter((entry) => entry.startsWith("URI:"))
    .map((entry) => entry.slice(4));

const authenticatePeer = (socket: NodeTls.TLSSocket, identities: WorkerIdentityService) =>
  Effect.gen(function* () {
    if (!socket.authorized) {
      return yield* new WorkerMtlsTransportError({ operation: "authenticate-peer" });
    }
    const peer = socket.getPeerCertificate();
    if (peer.raw === undefined || peer.fingerprint256 === undefined) {
      return yield* new WorkerMtlsTransportError({ operation: "read-peer-certificate" });
    }
    const now = yield* identities.clock.now;
    return yield* identities.authenticateCertificate({
      fingerprint: peer.fingerprint256,
      sanUris: peerSanUris(peer.subjectaltname),
      now,
    });
  });

const rawData = (data: RawData): Uint8Array => {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
};

const adaptWebSocket = (webSocket: WebSocket): WorkerRelaySocket => ({
  send: (payload, complete) => {
    if (webSocket.readyState !== WebSocket.OPEN) {
      complete(new Error("socket is not open"));
      return;
    }
    webSocket.send(payload, (error) => complete(error ?? undefined));
  },
  close: (code, reason) => {
    if (webSocket.readyState === WebSocket.OPEN || webSocket.readyState === WebSocket.CONNECTING) {
      webSocket.close(code, reason);
    }
  },
  onMessage: (listener) => {
    const receive = (data: RawData, binary: boolean) => listener(rawData(data), binary);
    webSocket.on("message", receive);
    return () => webSocket.off("message", receive);
  },
  onClose: (listener) => {
    webSocket.on("close", listener);
    return () => webSocket.off("close", listener);
  },
});

const readNodeBody = (request: NodeHttp.IncomingMessage, maxBytes: number): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    let total = 0;
    const fail = () => {
      request.removeAllListeners("data");
      request.resume();
      reject(new Error("invalid request body"));
    };
    request.on("data", (chunk: Buffer) => {
      if (total + chunk.byteLength > maxBytes) {
        fail();
        return;
      }
      total += chunk.byteLength;
      chunks.push(chunk);
    });
    request.once("end", () => resolve(Buffer.concat(chunks, total)));
    request.once("aborted", fail);
    request.once("error", fail);
  });

const writeResponse = async (response: NodeHttp.ServerResponse, result: Response) => {
  response.statusCode = result.status;
  result.headers.forEach((value, name) => response.setHeader(name, value));
  response.end(Buffer.from(await result.arrayBuffer()));
};

const rejectUpgrade = (socket: NodeStream.Duplex, status: 401 | 404 | 429 | 500 | 504) => {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`,
  );
};

export interface CreateWorkerMtlsServerOptions {
  readonly tls: NodeTls.TlsOptions;
  readonly identities: WorkerIdentityService;
  readonly relay: WorkerRelay;
  readonly githubTokenLeases?: Pick<GitHubTokenLeaseBroker, "redeem">;
  readonly limits?: Partial<WorkerMtlsServerLimits>;
}

/**
 * Creates the dedicated direct TLS service. Railway must expose this TCP port
 * without HTTP TLS termination. `requestCert` and `rejectUnauthorized` are
 * forced on; the ordinary control-plane `/healthz` remains the deployment
 * health endpoint.
 */
export const createWorkerMtlsServer = (options: CreateWorkerMtlsServerOptions) => {
  const limits = { ...DEFAULT_WORKER_MTLS_SERVER_LIMITS, ...options.limits };
  const webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: options.relay.limits.maxFrameBytes,
    perMessageDeflate: false,
  });
  let activeConnections = 0;
  let pendingAuthentications = 0;
  const connectionAdmission = makeWorkerMtlsConnectionAdmission(limits);
  const admissions = new WeakMap<NodeStream.Duplex, WorkerMtlsConnectionAdmission>();

  const server = NodeHttps.createServer(
    {
      ...options.tls,
      requestCert: true,
      rejectUnauthorized: true,
      handshakeTimeout: limits.tlsHandshakeTimeoutMs,
    },
    (request, response) => {
      const socket = request.socket as NodeTls.TLSSocket;
      const url = new URL(request.url ?? "/", "https://worker.invalid");
      if (
        ![WORKER_ROTATE_PATH, WORKER_CLAIM_PATH, WORKER_GITHUB_TOKEN_REDEEM_PATH].includes(
          url.pathname,
        ) ||
        request.method !== "POST"
      ) {
        response.writeHead(404, { "cache-control": "no-store" }).end();
        return;
      }
      const task = Effect.gen(function* () {
        const certificate = yield* authenticatePeer(socket, options.identities);
        const bytes = yield* Effect.tryPromise(() => readNodeBody(request, limits.maxBodyBytes));
        const unknown = yield* Effect.try({
          try: () => decodeUnknownJson(Buffer.from(bytes).toString("utf8")),
          catch: (cause) => new WorkerMtlsTransportError({ operation: "decode-request", cause }),
        });
        if (url.pathname === WORKER_ROTATE_PATH) {
          const body = yield* Effect.try(() => rotationDecoder(unknown));
          const grant = yield* options.identities.rotateCertificate({
            current: certificate,
            publicKeySpkiDerBase64: body.publicKeySpkiDerBase64,
          });
          return noStoreJson(grant);
        }
        if (url.pathname === WORKER_GITHUB_TOKEN_REDEEM_PATH) {
          if (options.githubTokenLeases === undefined) {
            return yield* new WorkerMtlsTransportError({ operation: "github-token-unconfigured" });
          }
          const body = yield* Effect.try(() => githubTokenRedeemDecoder(unknown));
          const now = yield* options.identities.clock.now;
          const materialized = yield* options.githubTokenLeases.redeem(certificate, body, now);
          return noStoreJson({
            schemaVersion: 1,
            token: Redacted.value(materialized.token),
            expiresAt: materialized.expiresAt,
          });
        }
        const body = yield* Effect.try(() => claimDecoder(unknown));
        const claim = yield* options.relay.claimCommand(certificate, body.command);
        return noStoreJson({ schemaVersion: 1, claim });
      }).pipe(
        Effect.timeout(`${limits.requestTimeoutMs} millis`),
        Effect.orElseSucceed(() => noStoreJson({ error: "unauthorized" }, 401)),
      );
      void Effect.runPromise(task)
        .then((result) => writeResponse(response, result))
        .catch(() => response.destroy());
    },
  );
  server.maxConnections = limits.maxConnections;
  server.requestTimeout = limits.requestTimeoutMs;
  server.headersTimeout = limits.headersTimeoutMs;

  // Bound raw TCP/TLS clients before HTTP parsing or WebSocket authentication.
  // Railway must expose this as a direct TCP listener so application code sees
  // the real client-certificate handshake rather than a proxy header.
  server.on("connection", (socket) => {
    const admission = connectionAdmission.admit();
    if (admission === undefined) {
      socket.destroy();
      return;
    }
    admissions.set(socket, admission);
    socket.once("close", admission.close);
  });
  server.on("secureConnection", (socket) => {
    const admission = admissions.get(socket);
    if (admission === undefined) connectionAdmission.completeNextHandshake();
    else admission.handshakeComplete();
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "https://worker.invalid");
    if (url.pathname !== WORKER_RELAY_PATH) {
      rejectUpgrade(socket, 404);
      return;
    }
    if (
      activeConnections + pendingAuthentications >= limits.maxConnections ||
      pendingAuthentications >= limits.maxPendingHandshakes
    ) {
      rejectUpgrade(socket, 429);
      return;
    }
    pendingAuthentications += 1;
    let settled = false;
    const deadline = setTimeout(() => {
      settled = true;
      pendingAuthentications -= 1;
      rejectUpgrade(socket, 504);
    }, limits.authenticationTimeoutMs);
    const tlsSocket = socket as NodeTls.TLSSocket;
    void Effect.runPromise(authenticatePeer(tlsSocket, options.identities)).then(
      (certificate) => {
        if (settled || socket.destroyed) return;
        settled = true;
        clearTimeout(deadline);
        pendingAuthentications -= 1;
        webSockets.handleUpgrade(request, socket, head, (webSocket) => {
          activeConnections += 1;
          webSocket.once("close", () => {
            activeConnections -= 1;
          });
          webSockets.emit("connection", webSocket, request);
          void Effect.runPromise(options.relay.open(certificate, adaptWebSocket(webSocket))).catch(
            () => webSocket.close(1011, "relay_open_failed"),
          );
        });
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        pendingAuthentications -= 1;
        rejectUpgrade(socket, 401);
      },
    );
  });

  return {
    server,
    limits,
    activeConnections: () => activeConnections,
    pendingHandshakes: () => connectionAdmission.pendingHandshakes() + pendingAuthentications,
    totalConnections: connectionAdmission.totalConnections,
    close: () => {
      for (const client of webSockets.clients) client.terminate();
      webSockets.close();
      return new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
  } as const;
};
