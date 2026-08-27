// @effect-diagnostics nodeBuiltinImport:off -- This file is the native Node HTTP adapter boundary.
// @effect-diagnostics globalTimers:off -- The timer directly aborts the Fetch request shared with Node and Better Auth.
import * as NodeHttp from "node:http";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { makeAuth } from "./auth.ts";
import { makeCloudRpc, type ThreadEventSignalHub } from "./cloudRpc.ts";
import { attachCloudRpcWebSocket } from "./cloudRpcWebSocket.ts";
import { ControlPlaneConfig, layer as controlPlaneConfigLayer } from "./config.ts";
import { Database, layer as databaseLayer } from "./database.ts";
import {
  EphemeralCoordination,
  type EphemeralCoordinationService,
} from "./ephemeralCoordination.ts";
import { makeRequestHandler, type AuthInstance } from "./http.ts";
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
import {
  makeWorkerControlPlaneRuntime,
  type WorkerControlPlaneRuntime,
  type WorkerProductionDependencies,
} from "./workerProduction.ts";
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

export const runtimeLayer = Layer.merge(persistenceLayer, valkeyProductionLayer).pipe(
  Layer.provideMerge(controlPlaneConfigLayer),
);

export interface ControlPlaneApplicationDependencies {
  readonly config: import("./config.ts").ControlPlaneConfigShape;
  readonly database: import("./database.ts").DatabaseService;
  readonly workspaces: WorkspaceRepositoryService;
  readonly threadEvents: ThreadEventStoreService;
  readonly threadEventSignals?: ThreadEventSignalHub;
  readonly worker?: WorkerControlPlaneRuntime;
  readonly coordination: EphemeralCoordinationService;
  readonly githubWorkflow?: ReturnType<typeof makeGitHubThreadWorkflow>;
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
}: ControlPlaneApplicationDependencies): {
  readonly auth: AuthInstance;
  readonly handle: (request: Request) => Promise<Response>;
  readonly cloudRpc: ReturnType<typeof makeCloudRpc>;
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
    ...(threadEventSignals === undefined ? {} : { signals: threadEventSignals }),
  });

  return {
    auth,
    cloudRpc,
    handle: makeRequestHandler({
      auth,
      config,
      database,
      workspaces,
      cloudRpc,
      ...(worker === undefined ? {} : { workerBootstrap: worker.workerBootstrap }),
      ...(githubWorkflow === undefined ? {} : { githubWorkflow }),
    }),
  };
};

/**
 * Railway production composition. The ordinary HTTPS health/RPC listener and
 * direct client-certificate TLS listener have independent ports and shutdown
 * lifecycles. The caller must inject the deployment KMS signer plus C1/C3
 * reservation/recovery boundaries; there is deliberately no development CA
 * or permissive fallback.
 */
export const makeProgram = (production: WorkerProductionDependencies) =>
  Effect.gen(function* () {
    const config = yield* ControlPlaneConfig;
    const database = yield* Database;
    const workspaces = yield* WorkspaceRepository;
    const threadEvents = yield* ThreadEventStore;
    const coordination = yield* EphemeralCoordination;
    yield* coordination.ping;
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

    const { handle, cloudRpc } = makeApplication({
      config,
      database,
      workspaces,
      threadEvents,
      worker,
      coordination,
      githubWorkflow,
    });
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
