// @effect-diagnostics nodeBuiltinImport:off -- This file is the native Node HTTP adapter boundary.
// @effect-diagnostics globalTimers:off -- The timer directly aborts the Fetch request shared with Node and Better Auth.
import * as NodeHttp from "node:http";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { makeAuth } from "./auth.ts";
import { r2ArtifactConfigLayer } from "./artifactConfig.ts";
import { makeArtifactOutboxProcessor, startArtifactOutboxDrain } from "./artifactOutbox.ts";
import { makePostgresArtifactRepository } from "./artifactRepository.ts";
import { ArtifactStorage, productionArtifactStorageLayer } from "./artifactStorage.ts";
import { makeCloudRpc, type ThreadEventSignalHub } from "./cloudRpc.ts";
import { attachCloudRpcWebSocket } from "./cloudRpcWebSocket.ts";
import {
  makeCloudThreadLifecycle,
  type CloudThreadLifecycleDependencies,
} from "./cloudThreadLifecycle.ts";
import {
  makePostgresCloudThreadLifecycleStore,
  type CloudThreadLifecycleStore,
} from "./cloudThreadLifecycleStore.ts";
import { inspectE2bReservation } from "./sandboxIdentityStore.ts";
import { ControlPlaneConfig, layer as controlPlaneConfigLayer } from "./config.ts";
import { Database, layer as databaseLayer } from "./database.ts";
import {
  EphemeralCoordination,
  type EphemeralCoordinationService,
} from "./ephemeralCoordination.ts";
import { E2bSandboxConfig, e2bSandboxConfigLayer } from "./e2bSandboxConfig.ts";
import {
  makeHostedE2bProviderService,
  makeMaterializingWorkerGateway,
  type HostedE2bProviderDependencies,
} from "./e2bSandboxProduction.ts";
import { makeRequestHandler, type AuthInstance } from "./http.ts";
import { makeInspectorBridge, type InspectorInputAuthorizer } from "./inspectorBridge.ts";
import { currentOnrampProductionPolicyLayer, OnrampProductionPolicy } from "./onrampPolicy.ts";
import { makePostgresDesktopLeaseRepository } from "./desktopLeaseRepository.ts";
import { makeDesktopLeaseService, type DesktopLeaseService } from "./desktopLeaseService.ts";
import {
  layer as threadEventStoreLayer,
  ThreadEventStore,
  type ThreadEventStoreService,
} from "./threadEventStore.ts";
import {
  ensureWorkspaceForUser,
  layer as workspaceRepositoryLayer,
  WorkspaceRepository,
  type WorkspaceRepositoryService,
} from "./workspaces.ts";
import { createWorkerMtlsServer } from "./workerMtlsServer.ts";
import type { ProviderCredentialKeyEncryption } from "./providerCredentialEnvelope.ts";
import type { ProviderCredentialLoginRunner } from "./providerCredentialLoginRunner.ts";
import { makeProviderCredentialService } from "./providerCredentialService.ts";
import { makePostgresProviderCredentialStore } from "./providerCredentialStore.ts";
import {
  makeB4ProviderCredentialWorkerTransport,
  makeLifecycleProviderCredentialTargetAuthorizer,
  makeProviderLoginCoordinator,
} from "./providerCredentialProduction.ts";
import { makeProviderCredentialRpc } from "./providerCredentialRpc.ts";
import {
  makeWorkerControlPlaneRuntime,
  type WorkerControlPlaneRuntime,
  type WorkerProductionDependencies,
} from "./workerProduction.ts";
import { WorkerRelayServerError } from "./workerRelay.ts";
import { loadWorkerMtlsTlsOptions } from "./workerTlsFiles.ts";
import { productionLayer as valkeyProductionLayer } from "./valkeyCoordination.ts";
import { makeGitHubWorkflowStore } from "./githubThreadWorkflowStore.ts";
import { makeGitHubWorkflowAuthority } from "./githubWorkflowAuthority.ts";
import { makeGitHubThreadWorkflow } from "./githubThreadWorkflow.ts";
import { makePostgresGitHubTokenLeaseBroker } from "./githubTokenLeaseBroker.ts";

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

class ServerStartupError extends Schema.TaggedErrorClass<ServerStartupError>()(
  "ServerStartupError",
  { cause: Schema.Unknown },
) {}

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("request body exceeds configured limit");
    this.name = "RequestBodyTooLargeError";
  }
}

export class RequestBodyReadError extends Error {
  constructor() {
    super("request body could not be read");
    this.name = "RequestBodyReadError";
  }
}

export class RequestProcessingTimeoutError extends Error {
  constructor() {
    super("request processing exceeded configured deadline");
    this.name = "RequestProcessingTimeoutError";
  }
}

export class ClientDisconnectedError extends Error {
  constructor() {
    super("client disconnected before the response completed");
    this.name = "ClientDisconnectedError";
  }
}

export const readBody = (
  request: NodeHttp.IncomingMessage,
  maxBytes: number,
): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const drainWithoutBuffering = () => {
      const swallowDrainError = () => undefined;
      request.once("error", swallowDrainError);
      request.once("close", () => request.removeListener("error", swallowDrainError));
      request.resume();
    };
    const declaredLength = Number(request.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      drainWithoutBuffering();
      reject(new RequestBodyTooLargeError());
      return;
    }

    const chunks: Array<Buffer> = [];
    let receivedBytes = 0;
    let settled = false;

    const cleanup = () => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("aborted", onAborted);
      request.removeListener("close", onClose);
      request.removeListener("error", onError);
    };
    const fail = (cause: RequestBodyTooLargeError | RequestBodyReadError) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (cause instanceof RequestBodyTooLargeError) drainWithoutBuffering();
      reject(cause);
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      if (receivedBytes + buffer.byteLength > maxBytes) {
        fail(new RequestBodyTooLargeError());
        return;
      }
      receivedBytes += buffer.byteLength;
      chunks.push(buffer);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, receivedBytes));
    };
    const onAborted = () => fail(new RequestBodyReadError());
    const onClose = () => fail(new RequestBodyReadError());
    const onError = () => fail(new RequestBodyReadError());

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("close", onClose);
    request.once("error", onError);
  });

export const toFetchRequest = async (
  request: NodeHttp.IncomingMessage,
  baseUrl: URL,
  maxBodyBytes: number,
  signal?: AbortSignal,
): Promise<Request> => {
  const url = new URL(request.url ?? "/", baseUrl);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) {
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
  }

  const method = request.method ?? "GET";
  const receivedBody = await readBody(request, maxBodyBytes);
  const body = method === "GET" || method === "HEAD" ? undefined : receivedBody;
  return new Request(url, {
    method,
    headers,
    body,
    signal,
    ...(body === undefined ? {} : { duplex: "half" }),
  } as RequestInit);
};

export const writeFetchResponse = async (
  response: NodeHttp.ServerResponse,
  fetchResponse: Response,
  signal?: AbortSignal,
) => {
  const body = Buffer.from(await fetchResponse.arrayBuffer());
  if (signal?.aborted || response.destroyed || response.writableEnded) return;
  response.statusCode = fetchResponse.status;
  fetchResponse.headers.forEach((value, name) => {
    if (name !== "set-cookie") response.setHeader(name, value);
  });
  const cookies = fetchResponse.headers.getSetCookie();
  if (cookies.length > 0) response.setHeader("set-cookie", cookies);
  response.end(body);
};

export const configureServerTimeouts = (
  server: NodeHttp.Server,
  config: { readonly requestTimeoutMs: number; readonly headersTimeoutMs: number },
) => {
  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = config.headersTimeoutMs;
};

export const requestFailureResponse = (cause: unknown) => {
  const bodyReadFailure = cause instanceof RequestBodyReadError;
  const bodyTooLarge = cause instanceof RequestBodyTooLargeError;
  const processingTimeout = cause instanceof RequestProcessingTimeoutError;
  return new Response(
    encodeJson({
      error: bodyTooLarge
        ? "request_body_too_large"
        : bodyReadFailure
          ? "invalid_request_body"
          : processingTimeout
            ? "request_processing_timeout"
            : "internal_server_error",
    }),
    {
      status: bodyTooLarge ? 413 : bodyReadFailure ? 400 : processingTimeout ? 504 : 500,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        ...(bodyTooLarge || bodyReadFailure ? { connection: "close" } : {}),
      },
    },
  );
};

const abortReason = (signal: AbortSignal) =>
  signal.reason instanceof Error ? signal.reason : new ClientDisconnectedError();

const raceWithAbort = <A>(operation: Promise<A>, signal: AbortSignal): Promise<A> =>
  new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    if (signal.aborted) {
      void operation.catch(() => undefined);
      reject(abortReason(signal));
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (cause: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(cause);
      },
    );
  });

const responseIsWritable = (response: NodeHttp.ServerResponse) =>
  !response.destroyed && !response.writableEnded;

export interface NodeRequestLifecycleOptions {
  readonly baseUrl: URL;
  readonly maxBodyBytes: number;
  readonly processingTimeoutMs: number;
  readonly handle: (request: Request) => Promise<Response>;
}

/**
 * Own one cancellation scope for the native request boundary. Incoming body
 * limits settle first; the application deadline begins only after upload.
 * Socket/response close is used instead of IncomingMessage `close`, which also
 * fires for successfully consumed requests on current Node releases.
 */
export const handleNodeRequest = async (
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  options: NodeRequestLifecycleOptions,
) => {
  const controller = new AbortController();
  const disconnect = () => {
    if (!controller.signal.aborted) controller.abort(new ClientDisconnectedError());
  };
  request.once("aborted", disconnect);
  request.socket?.once("close", disconnect);
  response.once("close", disconnect);

  let deadline: NodeJS.Timeout | undefined;
  const cleanup = () => {
    if (deadline !== undefined) clearTimeout(deadline);
    request.removeListener("aborted", disconnect);
    request.socket?.removeListener("close", disconnect);
    response.removeListener("close", disconnect);
  };

  try {
    const fetchRequest = await toFetchRequest(
      request,
      options.baseUrl,
      options.maxBodyBytes,
      controller.signal,
    );
    deadline = setTimeout(() => {
      if (!controller.signal.aborted) controller.abort(new RequestProcessingTimeoutError());
    }, options.processingTimeoutMs);

    const fetchResponse = await raceWithAbort(options.handle(fetchRequest), controller.signal);
    if (!responseIsWritable(response)) return;
    await raceWithAbort(
      writeFetchResponse(response, fetchResponse, controller.signal),
      controller.signal,
    );
  } catch (cause) {
    if (cause instanceof ClientDisconnectedError || !responseIsWritable(response)) return;
    if (response.headersSent) {
      response.end();
      return;
    }
    try {
      await writeFetchResponse(response, requestFailureResponse(cause));
    } catch {
      if (responseIsWritable(response) && response.headersSent) response.end();
    }
  } finally {
    cleanup();
  }
};

const listen = (
  config: {
    readonly host: string;
    readonly port: number;
    readonly maxRequestBodyBytes: number;
    readonly requestTimeoutMs: number;
    readonly headersTimeoutMs: number;
  },
  baseUrl: URL,
  handle: (request: Request) => Promise<Response>,
) =>
  Effect.tryPromise({
    try: () =>
      new Promise<NodeHttp.Server>((resolve, reject) => {
        const server = NodeHttp.createServer((request, response) => {
          void handleNodeRequest(request, response, {
            baseUrl,
            maxBodyBytes: config.maxRequestBodyBytes,
            processingTimeoutMs: config.requestTimeoutMs,
            handle,
          });
        });
        configureServerTimeouts(server, config);
        server.once("error", reject);
        server.listen(config.port, config.host, () => resolve(server));
      }),
    catch: (cause) => new ServerStartupError({ cause }),
  });

const listenWorkerMtls = (
  workerMtls: ReturnType<typeof createWorkerMtlsServer>,
  config: Pick<import("./config.ts").ControlPlaneConfigShape, "workerMtlsHost" | "workerMtlsPort">,
) =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        const onError = (cause: Error) => reject(cause);
        workerMtls.server.once("error", onError);
        workerMtls.server.listen(config.workerMtlsPort, config.workerMtlsHost, () => {
          workerMtls.server.removeListener("error", onError);
          resolve();
        });
      }),
    catch: (cause) => new ServerStartupError({ cause }),
  });

const closeWorkerMtls = (workerMtls: ReturnType<typeof createWorkerMtlsServer>) =>
  Effect.tryPromise(() => workerMtls.close()).pipe(Effect.catch(() => Effect.void));

const persistenceLayer = Layer.merge(workspaceRepositoryLayer, threadEventStoreLayer).pipe(
  Layer.provideMerge(databaseLayer),
);
const artifactStorageLayer = productionArtifactStorageLayer.pipe(
  Layer.provideMerge(databaseLayer),
  Layer.provideMerge(r2ArtifactConfigLayer),
);

export const runtimeLayer = Layer.mergeAll(
  persistenceLayer,
  valkeyProductionLayer,
  artifactStorageLayer,
  currentOnrampProductionPolicyLayer,
  e2bSandboxConfigLayer,
).pipe(Layer.provideMerge(controlPlaneConfigLayer));

export interface ControlPlaneApplicationDependencies {
  readonly config: import("./config.ts").ControlPlaneConfigShape;
  readonly database: import("./database.ts").DatabaseService;
  readonly workspaces: WorkspaceRepositoryService;
  readonly threadEvents: ThreadEventStoreService;
  readonly threadEventSignals?: ThreadEventSignalHub;
  readonly worker?: WorkerControlPlaneRuntime;
  readonly coordination: EphemeralCoordinationService;
  readonly githubWorkflow?: ReturnType<typeof makeGitHubThreadWorkflow>;
  readonly providerCredentialRuntime?: {
    readonly service: ReturnType<typeof makeProviderCredentialService>;
    readonly logins: ReturnType<typeof makeProviderLoginCoordinator>;
  };
  readonly inspector?: {
    readonly lifecycle: CloudThreadLifecycleStore;
    readonly artifacts: import("./artifactStorage.ts").ArtifactStorageService;
    readonly inputAuthorizer?: InspectorInputAuthorizer;
    readonly desktopControl?: DesktopLeaseService;
  };
  readonly threadLifecycle?: ReturnType<typeof makeCloudThreadLifecycle>;
}

/**
 * Compose the server-owned auth callback and HTTP routes in one place. Keeping
 * this wiring pure makes startup auditable and lets tests exercise it without
 * opening a listener or connecting to Railway.
 */
export const makeApplication = ({
  config,
  database,
  workspaces,
  threadEvents,
  threadEventSignals,
  worker,
  coordination,
  githubWorkflow,
  providerCredentialRuntime,
  inspector,
  threadLifecycle,
}: ControlPlaneApplicationDependencies): {
  readonly auth: AuthInstance;
  readonly handle: (request: Request) => Promise<Response>;
  readonly cloudRpc: ReturnType<typeof makeCloudRpc>;
  readonly inspector: ReturnType<typeof makeInspectorBridge> | undefined;
} => {
  const auth = makeAuth({
    config,
    pool: database.pool,
    onUserCreated: (event) =>
      Effect.runPromise(
        ensureWorkspaceForUser({ id: event.userId, name: event.userName }).pipe(
          Effect.provideService(WorkspaceRepository, workspaces),
          Effect.asVoid,
        ),
      ),
  });

  const cloudRpc = makeCloudRpc({
    auth,
    hostedOrigin: config.betterAuthUrl.origin,
    workspaces,
    eventStore: threadEvents,
    coordination,
    ...(threadLifecycle === undefined ? {} : { lifecycle: threadLifecycle }),
    ...(threadEventSignals === undefined ? {} : { signals: threadEventSignals }),
  });
  const providerCredentials =
    providerCredentialRuntime === undefined
      ? undefined
      : makeProviderCredentialRpc({
          auth,
          hostedOrigin: config.betterAuthUrl.origin,
          workspaces,
          service: providerCredentialRuntime.service,
          logins: providerCredentialRuntime.logins,
        });
  const inspectorBridge =
    inspector === undefined || worker === undefined
      ? undefined
      : makeInspectorBridge({
          auth,
          hostedOrigin: config.betterAuthUrl.origin,
          workspaces,
          lifecycle: inspector.lifecycle,
          routes: worker.relay.routes,
          artifacts: inspector.artifacts,
          ...(inspector.desktopControl === undefined
            ? {}
            : { desktopControl: inspector.desktopControl }),
          ...(inspector.inputAuthorizer === undefined
            ? {}
            : { inputAuthorizer: inspector.inputAuthorizer }),
        });

  return {
    auth,
    cloudRpc,
    inspector: inspectorBridge,
    handle: makeRequestHandler({
      auth,
      config,
      database,
      workspaces,
      cloudRpc,
      ...(inspectorBridge === undefined ? {} : { inspector: inspectorBridge }),
      ...(worker === undefined ? {} : { workerBootstrap: worker.workerBootstrap }),
      ...(githubWorkflow === undefined ? {} : { githubWorkflow }),
      ...(providerCredentials === undefined ? {} : { providerCredentials }),
    }),
  };
};

/**
 * Railway production composition. The ordinary HTTPS health/RPC listener and
 * direct client-certificate TLS listener have independent ports and shutdown
 * lifecycles. The caller must inject the deployment KMS envelope adapter, a
 * hardened credential-only login job runner, and the C1/C3 reservation and
 * recovery boundaries; there is deliberately no development CA or permissive
 * fallback.
 */
export interface HostedProductionDependencies extends WorkerProductionDependencies {
  readonly providerCredentialKeyEncryption: ProviderCredentialKeyEncryption;
  readonly providerCredentialLoginRunner: ProviderCredentialLoginRunner;
  readonly e2b: Omit<HostedE2bProviderDependencies, "config" | "database" | "ptyOwnerId" | "sdk">;
  readonly cloudThreadLifecycle: Omit<
    CloudThreadLifecycleDependencies,
    | "workspaces"
    | "threadEvents"
    | "lifecycle"
    | "sandbox"
    | "reservations"
    | "workerRoutes"
    | "clock"
  >;
}

export const makeCloudThreadRecoveryLoop = (
  recoverPending: () => Effect.Effect<number, unknown>,
  minimumDelayMs = 5_000,
  failureDelayMs = 30_000,
): Effect.Effect<never, never> => {
  const loop = (): Effect.Effect<never, never> =>
    Effect.suspend(() =>
      recoverPending().pipe(
        Effect.flatMap((recovered) => Effect.sleep(recovered >= 25 ? 100 : minimumDelayMs)),
        Effect.catch((cause) =>
          Effect.logError("Cloud thread lifecycle recovery failed", cause).pipe(
            Effect.andThen(Effect.sleep(failureDelayMs)),
          ),
        ),
        Effect.andThen(loop()),
      ),
    );
  return loop();
};

export const makeProgram = (production: HostedProductionDependencies) =>
  Effect.gen(function* () {
    const config = yield* ControlPlaneConfig;
    const database = yield* Database;
    const workspaces = yield* WorkspaceRepository;
    const threadEvents = yield* ThreadEventStore;
    const artifactStorage = yield* ArtifactStorage;
    const e2bConfig = yield* E2bSandboxConfig;
    yield* OnrampProductionPolicy;
    const artifactOutbox = makeArtifactOutboxProcessor({
      repository: makePostgresArtifactRepository(database),
      storage: artifactStorage,
      leaseMs: Math.max(180_000, config.requestTimeoutMs * 2),
    });
    yield* startArtifactOutboxDrain(artifactOutbox);
    const coordination = yield* EphemeralCoordination;
    yield* coordination.ping;
    const e2b = yield* makeHostedE2bProviderService({
      ...production.e2b,
      config: e2bConfig,
      database,
      ptyOwnerId: config.workerProcessInstanceId,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerStartupError({
            cause: { message: "E2B provider startup validation failed", error: cause },
          }),
      ),
    );
    yield* Effect.addFinalizer(() =>
      e2b.shutdown.pipe(Effect.catch((cause) => Effect.logError("E2B PTY handoff failed", cause))),
    );
    const worker = yield* makeWorkerControlPlaneRuntime({
      config,
      database,
      threadEvents,
      production,
      coordination,
    });
    yield* worker.relay.initialize;
    const githubTokenLeases = makePostgresGitHubTokenLeaseBroker({
      database,
      vault: production.github.tokenVault,
    });
    const githubWorkflow = makeGitHubThreadWorkflow({
      workspaces,
      store: makeGitHubWorkflowStore(database),
      authority: makeGitHubWorkflowAuthority(database),
      tokens: production.github.tokens,
      tokenLeases: githubTokenLeases,
      github: production.github.client,
      worker: worker.githubWorker,
      clock: { now: Date.now },
    });
    if (
      production.providerCredentialKeyEncryption.kmsKeyId.trim().length === 0 ||
      production.providerCredentialKeyEncryption.activeKeyVersion.trim().length === 0
    ) {
      return yield* new ServerStartupError({
        cause: "KMS-backed provider credential encryption is required",
      });
    }
    const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
    yield* production.providerCredentialLoginRunner.validateConfiguration.pipe(
      Effect.mapError(
        (cause) =>
          new ServerStartupError({
            cause: {
              message: "Provider credential login runner security validation failed",
              error: cause,
            },
          }),
      ),
    );
    const lifecycle = makePostgresCloudThreadLifecycleStore(database.pool);
    const upstreamWorkerGateway = production.cloudThreadLifecycle.workerGateway;
    const threadLifecycle = makeCloudThreadLifecycle({
      ...production.cloudThreadLifecycle,
      workspaces,
      threadEvents,
      lifecycle,
      sandbox: e2b.provider,
      reservations: {
        inspect: (workspaceId, reservationId) =>
          inspectE2bReservation(database.pool, workspaceId, reservationId),
      },
      workerGateway: makeMaterializingWorkerGateway(e2b, upstreamWorkerGateway),
      workerRoutes: worker.routeLifecycle,
      clock: { now: () => DateTime.toDate(DateTime.nowUnsafe()) },
    });
    worker.bindLifecycleRecovery((identity, confirmedEventCursor) =>
      threadLifecycle
        .reconnectVerifiedWorker(
          {
            generation: identity.reservationId,
            workspaceId: identity.workspaceId,
            environmentId: identity.environmentId,
            environmentRevisionId: identity.environmentRevisionId,
            threadId: identity.threadId,
            sandboxId: identity.sandboxId,
            workerId: identity.workerId,
            providerInstanceId: identity.providerInstanceId,
            providerDriver: identity.providerDriver,
          },
          confirmedEventCursor,
        )
        .pipe(
          Effect.map(({ commands }) => commands),
          Effect.mapError(
            (cause) =>
              new WorkerRelayServerError({
                code: cause.code === "staleWorker" ? "leaseFenced" : "internal",
                operation: "recover-cloud-thread-lifecycle",
                cause,
              }),
          ),
        ),
    );
    yield* Effect.forkScoped(makeCloudThreadRecoveryLoop(() => threadLifecycle.recoverPending()));
    const desktopControl = makeDesktopLeaseService({
      repository: makePostgresDesktopLeaseRepository(database.pool),
      routes: worker.relay.routes,
      tokenSecret: config.betterAuthSecret,
    });
    const unsubscribeDesktopReconnect = worker.relay.onAuthenticatedReconnect(
      (identity, reconnectTransport) =>
        desktopControl
          .synchronizeRoute({
            lease: identity,
            send: (frame) =>
              frame.type === "desktop.authority" && reconnectTransport.sendDesktopAuthority(frame),
            close: () => undefined,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new WorkerRelayServerError({
                  code: "internal",
                  operation: "synchronize-desktop-authority",
                  cause,
                }),
            ),
          ),
    );
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribeDesktopReconnect));
    const unsubscribeDesktopRouteLoss = worker.relay.onBeforeRouteLoss((input) =>
      desktopControl
        .revokeCurrent({
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          ...(input.sandboxId === undefined ? {} : { sandboxId: input.sandboxId }),
          reason: input.reason,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new WorkerRelayServerError({
                code: "internal",
                operation: "revoke-desktop-authority-before-route-loss",
                cause,
              }),
          ),
        ),
    );
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribeDesktopRouteLoss));
    yield* Effect.forkScoped(
      Effect.sleep("5 seconds").pipe(
        Effect.andThen(desktopControl.sweepExpired),
        Effect.catch((cause) => Effect.logError("Desktop lease expiry sweep failed", cause)),
        Effect.forever,
      ),
    );
    yield* Effect.forkScoped(
      desktopControl.purgeRetention.pipe(
        Effect.catch((cause) => Effect.logError("Desktop lease retention purge failed", cause)),
        Effect.andThen(
          Effect.sleep("24 hours").pipe(
            Effect.andThen(desktopControl.purgeRetention),
            Effect.catch((cause) => Effect.logError("Desktop lease retention purge failed", cause)),
            Effect.forever,
          ),
        ),
      ),
    );
    const credentialTargets = makeLifecycleProviderCredentialTargetAuthorizer({
      lifecycle,
      relay: worker.relay,
      now,
    });
    const credentialLogins = makeProviderLoginCoordinator({
      pool: database.pool,
      targets: credentialTargets,
      runner: production.providerCredentialLoginRunner,
      now,
      keyEncryption: production.providerCredentialKeyEncryption,
    });
    yield* Effect.addFinalizer(() => credentialLogins.shutdown.pipe(Effect.orDie));
    const providerCredentials = makeProviderCredentialService({
      logins: credentialLogins,
      store: makePostgresProviderCredentialStore(database.pool),
      keyEncryption: production.providerCredentialKeyEncryption,
      authorizer: credentialTargets,
      worker: makeB4ProviderCredentialWorkerTransport(worker.relay),
      now,
    });
    yield* Effect.forkScoped(
      Effect.sleep("30 seconds").pipe(
        Effect.andThen(providerCredentials.sweepExpired),
        Effect.andThen(credentialLogins.sweepExpired),
        Effect.catch((cause) => Effect.logError("Provider credential expiry sweep failed", cause)),
        Effect.forever,
      ),
    );
    yield* Effect.forkScoped(
      credentialLogins.purgeTerminalHistory.pipe(
        Effect.catch((cause) =>
          Effect.logError("Provider credential login retention purge failed", cause),
        ),
        Effect.andThen(
          Effect.sleep("24 hours").pipe(
            Effect.andThen(credentialLogins.purgeTerminalHistory),
            Effect.catch((cause) =>
              Effect.logError("Provider credential login retention purge failed", cause),
            ),
            Effect.forever,
          ),
        ),
      ),
    );
    const unsubscribeCredentialReconnect = worker.relay.onAuthenticatedReconnect(
      (identity, reconnectTransport) =>
        providerCredentials
          .reconcileWorker({
            workspaceId: identity.workspaceId,
            sandboxId: identity.sandboxId,
            workerOverride: makeB4ProviderCredentialWorkerTransport(reconnectTransport, identity),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new WorkerRelayServerError({
                  code: "internal",
                  operation: "reconcile-provider-credentials",
                  cause,
                }),
            ),
          ),
    );
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribeCredentialReconnect));
    const unsubscribeCredentialRouteLoss = worker.relay.onBeforeRouteLoss((input) =>
      providerCredentials.cleanupLifecycle(input).pipe(
        Effect.mapError(
          (cause) =>
            new WorkerRelayServerError({
              code: "internal",
              operation: "cleanup-provider-credentials-before-route-loss",
              cause,
            }),
        ),
      ),
    );
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribeCredentialRouteLoss));

    const workerTls = yield* loadWorkerMtlsTlsOptions(config);
    const workerMtls = createWorkerMtlsServer({
      tls: workerTls,
      identities: worker.identities,
      relay: worker.relay,
      githubTokenLeases,
    });
    yield* Effect.acquireRelease(listenWorkerMtls(workerMtls, config), () =>
      closeWorkerMtls(workerMtls).pipe(
        Effect.ensuring(Effect.sync(() => worker.githubWorker.close())),
      ),
    );

    const { handle, cloudRpc, inspector } = makeApplication({
      config,
      database,
      workspaces,
      threadEvents,
      worker,
      coordination,
      githubWorkflow,
      providerCredentialRuntime: { service: providerCredentials, logins: credentialLogins },
      threadLifecycle,
      inspector: {
        lifecycle,
        artifacts: artifactStorage,
        desktopControl,
      },
    });
    worker.relay.setInspectorFrameHandler(inspector?.inspectorFrames);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        worker.relay.setInspectorFrameHandler(undefined);
        inspector?.dispose();
      }),
    );
    const server = yield* Effect.acquireRelease(
      listen(config, config.betterAuthUrl, handle),
      (activeServer) =>
        Effect.callback<void, never>((resume) => {
          activeServer.close(() => resume(Effect.void));
        }),
    );
    const cloudRpcWebSocket = attachCloudRpcWebSocket({
      server,
      rpc: cloudRpc,
      baseUrl: config.betterAuthUrl,
      authenticationTimeoutMs: config.requestTimeoutMs,
      ...(inspector === undefined ? {} : { inspector }),
    });

    yield* Effect.addFinalizer(() => Effect.sync(() => cloudRpcWebSocket.detach()));
    yield* Effect.logInfo("Control plane listeners ready", {
      host: config.host,
      port: config.port,
      workerMtlsHost: config.workerMtlsHost,
      workerMtlsPort: config.workerMtlsPort,
    });
    return yield* Effect.never;
  });

/**
 * The repository has no KMS vendor adapter or C1/C3 implementation yet. A
 * deployment launcher must import `makeProgram` and supply those capabilities;
 * running this module directly fails closed instead of minting development
 * certificates or accepting unauthenticated workers.
 */
export const program = Effect.fail(
  new ServerStartupError({
    cause: "worker production dependencies are required; use makeProgram from the Railway launcher",
  }),
);

if (import.meta.main) {
  program.pipe(Effect.scoped, Effect.provide(runtimeLayer), NodeRuntime.runMain);
}
