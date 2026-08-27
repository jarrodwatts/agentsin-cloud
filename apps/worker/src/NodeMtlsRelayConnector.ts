// @effect-diagnostics nodeBuiltinImport:off -- This is the worker's Node HTTPS/TLS/WebSocket adapter.
// @effect-diagnostics globalTimers:off -- Certificate rotation and handshake deadlines are scoped to each connection.
// @effect-diagnostics globalTimersInEffect:off -- Native WebSocket rotation closes the transport and triggers durable replay.
import * as NodeCrypto from "node:crypto";
import * as NodeHttps from "node:https";
import * as NodeTls from "node:tls";

import { CREDENTIAL_CHANNEL_EXPORTER_LABEL } from "@t3tools/contracts/credential-binary";
import {
  WorkerCertificateGrant,
  WorkerCommandClaimResponse,
  WorkerGitHubTokenRedeemResponse,
  WorkerRelayOutbound,
  WORKER_GITHUB_TOKEN_REDEEM_PATH,
} from "@t3tools/contracts/worker";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import WebSocket, { type RawData } from "ws";

import { WorkerRelayError } from "./errors.ts";
import {
  WorkerGitHubTokenLeaseError,
  type WorkerGitHubTokenLeaseBroker,
} from "./GitHubGitExecutor.ts";
import {
  generateWorkerKeyPair,
  persistBootstrappedWorkerMtlsCredential,
  type WorkerMtlsCredential,
  type WorkerMtlsCredentialStore,
} from "./MtlsCredentials.ts";
import type { WorkerCommandClaim, WorkerRelayConnection, WorkerRelayConnector } from "./ports.ts";
import { WORKER_RELAY_FRAME_MAX_BYTES, WORKER_RELAY_OUTBOUND_MAX_BYTES } from "./protocol.ts";

const WORKER_ROTATE_PATH = "/api/v1/worker-certificates/rotate";
const WORKER_CLAIM_PATH = "/api/v1/worker-commands/claim";

export interface NodeMtlsRelayLimits {
  readonly maxResponseBytes: number;
  readonly maxFrameBytes: number;
  readonly maxQueuedFrames: number;
  readonly maxQueuedBytes: number;
  readonly handshakeTimeoutMs: number;
  readonly requestTimeoutMs: number;
}

export const DEFAULT_NODE_MTLS_RELAY_LIMITS: NodeMtlsRelayLimits = {
  maxResponseBytes: 128 * 1024,
  maxFrameBytes: WORKER_RELAY_FRAME_MAX_BYTES,
  maxQueuedFrames: 128,
  maxQueuedBytes: 2 * 1024 * 1024,
  handshakeTimeoutMs: 5_000,
  requestTimeoutMs: 10_000,
};

/** Pure accounting seam used to bound concurrent native WebSocket sends. */
export const makeOutboundFrameBudget = (
  limits: Pick<NodeMtlsRelayLimits, "maxQueuedFrames" | "maxQueuedBytes">,
) => {
  let frames = 0;
  let bytes = 0;
  const releases = new Set<() => void>();
  return {
    acquire: (payloadBytes: number): (() => void) | undefined => {
      if (
        !Number.isSafeInteger(payloadBytes) ||
        payloadBytes < 0 ||
        frames >= limits.maxQueuedFrames ||
        bytes + payloadBytes > limits.maxQueuedBytes
      ) {
        return undefined;
      }
      frames += 1;
      bytes += payloadBytes;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        frames -= 1;
        bytes -= payloadBytes;
        releases.delete(release);
      };
      releases.add(release);
      return release;
    },
    clear: () => {
      for (const release of releases) release();
    },
    pendingFrames: () => frames,
    pendingBytes: () => bytes,
  } as const;
};

const decodeGrant = Schema.decodeUnknownSync(WorkerCertificateGrant);
const decodeClaim = Schema.decodeUnknownSync(WorkerCommandClaimResponse);
const decodeGitHubToken = Schema.decodeUnknownSync(WorkerGitHubTokenRedeemResponse);
const encodeOutbound = Schema.encodeUnknownSync(Schema.fromJsonString(WorkerRelayOutbound));

const failure = (operation: string, retryable: boolean, cause?: unknown) =>
  new WorkerRelayError({
    operation,
    retryable,
    ...(cause === undefined ? {} : { cause }),
  });

export const certificateSpkiPin = (certificate: NodeTls.PeerCertificate) => {
  const parsed = new NodeCrypto.X509Certificate(certificate.raw);
  const spki = parsed.publicKey.export({ type: "spki", format: "der" });
  return `sha256/${NodeCrypto.createHash("sha256").update(spki).digest("base64")}`;
};

const checkPinnedServer =
  (expected: string) => (hostname: string, certificate: NodeTls.PeerCertificate) => {
    const standard = NodeTls.checkServerIdentity(hostname, certificate);
    if (standard !== undefined) return standard;
    return certificateSpkiPin(certificate) === expected
      ? undefined
      : new Error("relay server pin mismatch");
  };

const httpsJson = <A>(input: {
  readonly url: URL;
  readonly body: unknown;
  readonly maxResponseBytes: number;
  readonly timeoutMs: number;
  readonly decoder: (value: unknown) => A;
  readonly pin?: string;
  readonly credential?: WorkerMtlsCredential;
}): Promise<A> =>
  new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(input.body));
    const request = NodeHttps.request(
      input.url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(payload.byteLength),
        },
        ...(input.pin === undefined ? {} : { checkServerIdentity: checkPinnedServer(input.pin) }),
        ...(input.credential === undefined
          ? {}
          : {
              cert: input.credential.grant.certificateChainPem,
              key: input.credential.privateKeyPem,
            }),
      },
      (response) => {
        const chunks: Array<Buffer> = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > input.maxResponseBytes) {
            response.destroy(new Error("response exceeds limit"));
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () => {
          if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
            reject(new Error(`request failed with status ${response.statusCode ?? 500}`));
            return;
          }
          try {
            resolve(
              input.decoder(JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown),
            );
          } catch (cause) {
            reject(cause);
          }
        });
      },
    );
    request.setTimeout(input.timeoutMs, () => request.destroy(new Error("request timed out")));
    request.once("error", reject);
    request.end(payload);
  });

const directUrl = (relayEndpoint: string, path: string) => {
  const url = new URL(relayEndpoint);
  url.protocol = "https:";
  url.pathname = path;
  url.search = "";
  url.hash = "";
  return url;
};

const rawData = (data: RawData): Uint8Array => {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
};

export interface MakeNodeMtlsRelayConnectorOptions {
  readonly credentials: WorkerMtlsCredentialStore;
  readonly now?: () => number;
  readonly limits?: Partial<NodeMtlsRelayLimits>;
}

export const makeNodeMtlsRelayConnector = (
  options: MakeNodeMtlsRelayConnectorOptions,
): WorkerRelayConnector => {
  const limits = { ...DEFAULT_NODE_MTLS_RELAY_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;

  const ensureCredential = (input: Parameters<WorkerRelayConnector["connect"]>[0]) =>
    Effect.gen(function* () {
      let credential = yield* options.credentials.loadCertificate(input.credentialRef);
      if (credential === undefined) {
        const token = yield* options.credentials.loadBootstrapToken(input.credentialRef);
        const keyPair = generateWorkerKeyPair();
        const grant = yield* Effect.tryPromise({
          try: () =>
            httpsJson({
              url: new URL(input.identity.bootstrapEndpoint),
              body: {
                schemaVersion: 1,
                token,
                publicKeySpkiDerBase64: keyPair.publicKeySpkiDerBase64,
              },
              maxResponseBytes: limits.maxResponseBytes,
              timeoutMs: limits.requestTimeoutMs,
              decoder: decodeGrant,
            }),
          catch: (cause) => failure("bootstrap-certificate", false, cause),
        });
        credential = { ...keyPair, grant };
        yield* persistBootstrappedWorkerMtlsCredential(
          options.credentials,
          input.credentialRef,
          credential,
        );
      }
      if (Date.parse(credential.grant.notAfter) <= now()) {
        return yield* failure("load-certificate", false, "worker certificate expired");
      }
      if (Date.parse(credential.grant.notBefore) > now() + 30_000) {
        return yield* failure("load-certificate", false, "worker certificate is not yet valid");
      }
      if (Date.parse(credential.grant.rotateAfter) <= now()) {
        const currentCredential = credential;
        const grant = yield* Effect.tryPromise({
          try: () =>
            httpsJson({
              url: directUrl(input.identity.relayEndpoint, WORKER_ROTATE_PATH),
              body: {
                schemaVersion: 1,
                publicKeySpkiDerBase64: currentCredential.publicKeySpkiDerBase64,
              },
              maxResponseBytes: limits.maxResponseBytes,
              timeoutMs: limits.requestTimeoutMs,
              decoder: decodeGrant,
              pin: input.identity.relayServerSpkiSha256,
              credential: currentCredential,
            }),
          catch: (cause) => failure("rotate-certificate", true, cause),
        });
        credential = { ...credential, grant };
        yield* options.credentials.saveCertificate(input.credentialRef, credential);
      }
      return credential as WorkerMtlsCredential;
    });

  return {
    connect: (input) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const credential = yield* ensureCredential(input);
          const connected = yield* Effect.callback<
            { readonly socket: WebSocket; readonly credentialChannelKey: Uint8Array },
            WorkerRelayError
          >((resume) => {
            const clientOptions: WebSocket.ClientOptions = {
              cert: credential.grant.certificateChainPem,
              key: credential.privateKeyPem,
              rejectUnauthorized: true,
              // @types/ws incorrectly narrows Node's callback to boolean. `ws`
              // forwards it to tls.connect, whose runtime contract is Error | undefined.
              checkServerIdentity: checkPinnedServer(
                input.identity.relayServerSpkiSha256,
              ) as unknown as NonNullable<WebSocket.ClientOptions["checkServerIdentity"]>,
              handshakeTimeout: limits.handshakeTimeoutMs,
              maxPayload: limits.maxFrameBytes,
              perMessageDeflate: false,
            };
            const webSocket = new WebSocket(input.identity.relayEndpoint, clientOptions);
            const opened = () => {
              try {
                const tlsSocket = (
                  webSocket as WebSocket & { readonly _socket?: NodeTls.TLSSocket }
                )._socket;
                if (tlsSocket === undefined || !tlsSocket.authorized) {
                  throw new Error("authenticated TLS socket unavailable");
                }
                const credentialChannelKey = tlsSocket.exportKeyingMaterial(
                  32,
                  CREDENTIAL_CHANNEL_EXPORTER_LABEL,
                  Buffer.alloc(0),
                );
                cleanup();
                resume(Effect.succeed({ socket: webSocket, credentialChannelKey }));
              } catch (cause) {
                cleanup();
                webSocket.terminate();
                resume(Effect.fail(failure("credential-channel", false, cause)));
              }
            };
            const failed = (cause: Error) => {
              cleanup();
              resume(Effect.fail(failure("connect", true, cause)));
            };
            const cleanup = () => {
              webSocket.off("open", opened);
              webSocket.off("error", failed);
            };
            webSocket.once("open", opened);
            webSocket.once("error", failed);
            return Effect.sync(() => {
              cleanup();
              webSocket.terminate();
            });
          });
          const { socket, credentialChannelKey } = connected;

          const queue: Array<Uint8Array> = [];
          const outboundBudget = makeOutboundFrameBudget(limits);
          let queuedBytes = 0;
          let closed = false;
          let pending:
            | ((effect: Effect.Effect<Option.Option<Uint8Array>, WorkerRelayError>) => void)
            | undefined;
          const rotationDelay = Math.max(0, Date.parse(credential.grant.rotateAfter) - now());
          const rotation = setTimeout(
            () => socket.close(4001, "certificate_rotation"),
            rotationDelay,
          );
          const clearInboundQueue = () => {
            for (const frame of queue) frame.fill(0);
            queue.length = 0;
            queuedBytes = 0;
          };
          socket.on("message", (data, _binary) => {
            if (closed) return;
            const frame = rawData(data);
            if (
              frame.byteLength > limits.maxFrameBytes ||
              queue.length >= limits.maxQueuedFrames ||
              queuedBytes + frame.byteLength > limits.maxQueuedBytes
            ) {
              frame.fill(0);
              socket.close(4413, "relay_queue_full");
              return;
            }
            if (pending !== undefined) {
              const complete = pending;
              pending = undefined;
              complete(Effect.succeed(Option.some(frame)));
              return;
            }
            queue.push(frame);
            queuedBytes += frame.byteLength;
          });
          socket.once("close", () => {
            closed = true;
            credentialChannelKey.fill(0);
            clearInboundQueue();
            clearTimeout(rotation);
            outboundBudget.clear();
            if (pending !== undefined) {
              const complete = pending;
              pending = undefined;
              complete(Effect.succeed(Option.none()));
            }
          });

          const connection: WorkerRelayConnection = {
            credentialChannelKey,
            receive: Effect.callback((resume) => {
              const frame = queue.shift();
              if (frame !== undefined) {
                queuedBytes -= frame.byteLength;
                resume(Effect.succeed(Option.some(frame)));
              } else if (closed) {
                resume(Effect.succeed(Option.none()));
              } else if (pending !== undefined) {
                resume(Effect.fail(failure("receive", false, "concurrent receive")));
              } else {
                pending = resume;
              }
            }),
            claimCommand: (command) =>
              Effect.tryPromise({
                try: () =>
                  httpsJson({
                    url: directUrl(input.identity.relayEndpoint, WORKER_CLAIM_PATH),
                    body: { schemaVersion: 1, command },
                    maxResponseBytes: limits.maxResponseBytes,
                    timeoutMs: limits.requestTimeoutMs,
                    decoder: decodeClaim,
                    pin: input.identity.relayServerSpkiSha256,
                    credential,
                  }),
                catch: (cause) => failure("claim-command", true, cause),
              }).pipe(Effect.map((response): WorkerCommandClaim => response.claim)),
            send: (message: WorkerRelayOutbound) =>
              Effect.callback<void, WorkerRelayError>((resume) => {
                const payload = encodeOutbound(message);
                const payloadBytes = Buffer.byteLength(payload);
                if (payloadBytes > WORKER_RELAY_OUTBOUND_MAX_BYTES) {
                  resume(Effect.fail(failure("send", false, "outbound frame exceeds limit")));
                  return;
                }
                if (socket.readyState !== WebSocket.OPEN) {
                  resume(Effect.fail(failure("send", true, "socket is closed")));
                  return;
                }
                const releaseBudget = outboundBudget.acquire(payloadBytes);
                if (releaseBudget === undefined) {
                  resume(Effect.fail(failure("send", true, "outbound queue exceeds limit")));
                  return;
                }
                try {
                  socket.send(payload, (error) => {
                    releaseBudget();
                    resume(
                      error === undefined ? Effect.void : Effect.fail(failure("send", true, error)),
                    );
                  });
                } catch (cause) {
                  releaseBudget();
                  resume(Effect.fail(failure("send", true, cause)));
                }
              }),
            close: Effect.sync(() => {
              clearTimeout(rotation);
              credentialChannelKey.fill(0);
              clearInboundQueue();
              if (socket.readyState === WebSocket.OPEN) socket.close(1000, "worker_closing");
              else if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
            }),
          };
          return connection;
        }),
        (connection) => connection.close,
      ),
  };
};

/** Redeems one approval-bound token over the same pinned worker mTLS channel. */
export const makeNodeMtlsGitHubTokenLeaseBroker = (input: {
  readonly credentials: WorkerMtlsCredentialStore;
  readonly limits?: Partial<NodeMtlsRelayLimits>;
}): WorkerGitHubTokenLeaseBroker => {
  const limits = { ...DEFAULT_NODE_MTLS_RELAY_LIMITS, ...input.limits };
  return {
    materialize: (request, identity) =>
      Effect.gen(function* () {
        const credential = yield* input.credentials
          .loadCertificate(identity.relayCredentialRef)
          .pipe(
            Effect.mapError(
              () => new WorkerGitHubTokenLeaseError({ reason: "worker certificate unavailable" }),
            ),
          );
        if (credential === undefined) {
          return yield* new WorkerGitHubTokenLeaseError({
            reason: "worker certificate unavailable",
          });
        }
        const response = yield* Effect.tryPromise({
          try: () =>
            httpsJson({
              url: directUrl(identity.relayEndpoint, WORKER_GITHUB_TOKEN_REDEEM_PATH),
              body: request,
              maxResponseBytes: limits.maxResponseBytes,
              timeoutMs: limits.requestTimeoutMs,
              decoder: decodeGitHubToken,
              pin: identity.relayServerSpkiSha256,
              credential,
            }),
          catch: () => new WorkerGitHubTokenLeaseError({ reason: "token lease redemption failed" }),
        });
        return {
          token: Redacted.make(response.token),
          expiresAt: response.expiresAt,
          scrub: Effect.void,
        };
      }),
  };
};
