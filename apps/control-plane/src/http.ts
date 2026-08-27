import {
  DesktopAuthExchangeRequest,
  DesktopAuthInitiateRequest,
  GitHubThreadWorkflowSubmissionRequest,
} from "@t3tools/contracts/cloud";
import type { AuthSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ControlPlaneConfigShape } from "./config.ts";
import type { DatabaseService } from "./database.ts";
import { makeAuth } from "./auth.ts";
import {
  beginDesktopAuthHandoff,
  completeDesktopAuthHandoff,
  DesktopAuthHandoffError,
  verifyDesktopAuthHandoff,
  verifyDesktopAuthInitiation,
} from "./desktopAuth.ts";
import {
  ensureWorkspaceForUser,
  WorkspaceRepository,
  type WorkspaceRepositoryService,
} from "./workspaces.ts";

export interface AuthSession {
  readonly session?: { readonly id: string };
  readonly user: {
    readonly id: string;
    readonly name: string;
  };
}

export interface ControlPlaneAuth {
  readonly handler: (request: Request) => Promise<Response>;
  readonly api: {
    readonly getSession: (input: {
      readonly headers: Headers;
      readonly signal?: AbortSignal;
    }) => Promise<AuthSession | null>;
    readonly generateOneTimeToken: (input: {
      readonly headers: Headers;
    }) => Promise<{ readonly token: string }>;
  };
}

export interface RequestHandlerDependencies {
  readonly auth: ControlPlaneAuth;
  readonly config: ControlPlaneConfigShape;
  readonly database: DatabaseService;
  readonly workspaces: WorkspaceRepositoryService;
  readonly cloudRpc?: {
    readonly handleHttp: (request: Request) => Effect.Effect<Response | undefined, never>;
  };
  readonly workerBootstrap?: {
    readonly handleHttp: (request: Request) => Effect.Effect<Response | undefined, never>;
  };
  readonly githubWorkflow?: {
    readonly execute: (input: {
      readonly actorUserId: string;
      readonly authSessionId: AuthSessionId;
      readonly workspaceId: GitHubThreadWorkflowSubmissionRequest["command"]["workspaceId"];
      readonly idempotencyKey: string;
      readonly command: GitHubThreadWorkflowSubmissionRequest["command"];
    }) => Effect.Effect<unknown, { readonly code: string }>;
  };
}

class RequestHandlerError extends Schema.TaggedErrorClass<RequestHandlerError>()(
  "RequestHandlerError",
  {
    cause: Schema.Unknown,
    status: Schema.optional(Schema.Int),
    publicCode: Schema.optional(Schema.String),
  },
) {}

const isRequestHandlerError = Schema.is(RequestHandlerError);

export const jsonResponse = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });

const encodeOneTimeTokenVerification = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ token: Schema.String })),
);

const desktopHandoffOptions = (config: ControlPlaneConfigShape) => ({
  authOrigin: config.betterAuthUrl,
  callbackUrl: config.desktopAuthCallbackUrl,
  secret: config.desktopAuthHandoffSecret,
  ttlSeconds: config.desktopAuthHandoffTtlSeconds,
});

const decodeJsonBody = <A>(schema: Schema.Decoder<A, never>, request: Request) =>
  Effect.tryPromise({
    try: () => request.json() as Promise<unknown>,
    catch: (cause) =>
      new RequestHandlerError({ cause, status: 400, publicCode: "invalid_request_body" }),
  }).pipe(
    Effect.flatMap((value) => Schema.decodeUnknownEffect(schema)(value)),
    Effect.mapError(
      (cause) =>
        new RequestHandlerError({ cause, status: 400, publicCode: "invalid_request_body" }),
    ),
  );

const hasBrowserOrigin = (request: Request) => request.headers.has("origin");

const isInternalOneTimeTokenRoute = (pathname: string) =>
  ["/api/auth/one-time-token/generate", "/api/auth/one-time-token/verify"].some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );

const dispatch = (request: Request, dependencies: RequestHandlerDependencies) =>
  Effect.gen(function* () {
    const { pathname } = new URL(request.url);

    if (pathname === "/health" || pathname === "/healthz") {
      return jsonResponse({ service: "control-plane", status: "ok" });
    }

    if (pathname === "/ready" || pathname === "/readyz") {
      return yield* dependencies.database.ping.pipe(
        Effect.map(() => jsonResponse({ service: "control-plane", status: "ready" })),
        Effect.orElseSucceed(() => jsonResponse({ status: "not_ready" }, 503)),
      );
    }

    if (pathname === "/api/desktop-auth/initiate" && request.method === "POST") {
      if (hasBrowserOrigin(request)) return jsonResponse({ error: "forbidden" }, 403);
      const body = yield* decodeJsonBody<DesktopAuthInitiateRequest>(
        DesktopAuthInitiateRequest,
        request,
      );
      const initiation = yield* Effect.try({
        try: () => beginDesktopAuthHandoff(body, desktopHandoffOptions(dependencies.config)),
        catch: (cause) =>
          new RequestHandlerError({ cause, status: 400, publicCode: "invalid_handoff" }),
      });
      return jsonResponse({
        browserUrl: initiation.browserUrl.toString(),
        expiresAt: initiation.expiresAt,
      });
    }

    if (pathname === "/desktop-auth/complete" && request.method === "GET") {
      const state = new URL(request.url).searchParams.get("state");
      if (state === null) return jsonResponse({ error: "invalid_handoff" }, 400);
      yield* Effect.try({
        try: () =>
          verifyDesktopAuthInitiation(state, {
            secret: dependencies.config.desktopAuthHandoffSecret,
          }),
        catch: (cause) =>
          new RequestHandlerError({ cause, status: 400, publicCode: "invalid_handoff" }),
      });
      const session = yield* Effect.tryPromise({
        try: () => dependencies.auth.api.getSession({ headers: request.headers }),
        catch: (cause) => new RequestHandlerError({ cause }),
      });
      if (session === null) return jsonResponse({ error: "authentication_required" }, 401);

      const generated = yield* Effect.tryPromise({
        try: () => dependencies.auth.api.generateOneTimeToken({ headers: request.headers }),
        catch: (cause) => new RequestHandlerError({ cause }),
      });
      const callbackUrl = yield* Effect.try({
        try: () =>
          completeDesktopAuthHandoff(
            state,
            generated.token,
            desktopHandoffOptions(dependencies.config),
          ),
        catch: (cause) =>
          new RequestHandlerError({ cause, status: 400, publicCode: "invalid_handoff" }),
      });
      return new Response(null, {
        status: 303,
        headers: {
          "cache-control": "no-store",
          location: callbackUrl.toString(),
          "referrer-policy": "no-referrer",
        },
      });
    }

    if (pathname === "/api/desktop-auth/exchange" && request.method === "POST") {
      if (hasBrowserOrigin(request)) return jsonResponse({ error: "forbidden" }, 403);
      const body = yield* decodeJsonBody<DesktopAuthExchangeRequest>(
        DesktopAuthExchangeRequest,
        request,
      );
      const oneTimeToken = yield* Effect.try({
        try: () =>
          verifyDesktopAuthHandoff(body.handoff, body.codeVerifier, {
            secret: dependencies.config.desktopAuthHandoffSecret,
          }),
        catch: (cause) =>
          new RequestHandlerError({
            cause:
              cause instanceof DesktopAuthHandoffError
                ? cause.code
                : "invalid desktop auth handoff",
            status: 400,
            publicCode: "invalid_handoff",
          }),
      });
      const verificationRequest = new Request(
        new URL("/api/auth/one-time-token/verify", dependencies.config.betterAuthUrl),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: encodeOneTimeTokenVerification({ token: oneTimeToken }),
          signal: request.signal,
        },
      );
      const verificationResponse = yield* Effect.tryPromise({
        try: () => dependencies.auth.handler(verificationRequest),
        catch: (cause) => new RequestHandlerError({ cause }),
      });
      if (!verificationResponse.ok) {
        return jsonResponse({ error: "invalid_handoff" }, 400);
      }
      const headers = new Headers(verificationResponse.headers);
      headers.set("cache-control", "no-store");
      return new Response(verificationResponse.body, {
        status: verificationResponse.status,
        headers,
      });
    }

    if (isInternalOneTimeTokenRoute(pathname)) {
      return jsonResponse({ error: "not_found" }, 404);
    }

    if (pathname === "/api/auth" || pathname.startsWith("/api/auth/")) {
      return yield* Effect.tryPromise({
        try: () => dependencies.auth.handler(request),
        catch: (cause) => new RequestHandlerError({ cause }),
      });
    }

    if (pathname === "/api/workspace" && request.method === "GET") {
      const session = yield* Effect.tryPromise({
        try: () => dependencies.auth.api.getSession({ headers: request.headers }),
        catch: (cause) => new RequestHandlerError({ cause }),
      });
      if (session === null) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }

      const workspace = yield* ensureWorkspaceForUser({
        id: session.user.id,
        name: session.user.name,
      }).pipe(Effect.provideService(WorkspaceRepository, dependencies.workspaces));
      return jsonResponse({ workspace });
    }

    if (pathname === "/api/v1/github/thread-workflow" && request.method === "POST") {
      if (dependencies.githubWorkflow === undefined)
        return jsonResponse({ error: "not_found" }, 404);
      const session = yield* Effect.tryPromise({
        try: () =>
          dependencies.auth.api.getSession({ headers: request.headers, signal: request.signal }),
        catch: (cause) => new RequestHandlerError({ cause }),
      });
      if (session === null || session.session?.id === undefined)
        return jsonResponse({ error: "unauthorized" }, 401);
      const body = yield* decodeJsonBody<GitHubThreadWorkflowSubmissionRequest>(
        GitHubThreadWorkflowSubmissionRequest,
        request,
      );
      const workspace = yield* dependencies.workspaces
        .findForUser(session.user.id)
        .pipe(Effect.mapError((cause) => new RequestHandlerError({ cause })));
      if (workspace === undefined || workspace.id !== body.command.workspaceId)
        return jsonResponse({ error: "forbidden" }, 403);
      const result = yield* dependencies.githubWorkflow
        .execute({
          actorUserId: session.user.id,
          authSessionId: session.session.id as AuthSessionId,
          workspaceId: body.command.workspaceId,
          idempotencyKey: body.idempotencyKey,
          command: body.command,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new RequestHandlerError({
                cause,
                status:
                  cause.code === "unauthorized" || cause.code === "repositoryDenied"
                    ? 403
                    : cause.code === "notFound"
                      ? 404
                      : cause.code === "conflict"
                        ? 409
                        : cause.code === "approvalRequired" || cause.code === "approvalExpired"
                          ? 412
                          : 503,
                publicCode: cause.code,
              }),
          ),
        );
      return jsonResponse(result);
    }

    if (dependencies.cloudRpc !== undefined) {
      const cloudResponse = yield* dependencies.cloudRpc.handleHttp(request);
      if (cloudResponse !== undefined) return cloudResponse;
    }

    if (dependencies.workerBootstrap !== undefined) {
      const workerResponse = yield* dependencies.workerBootstrap.handleHttp(request);
      if (workerResponse !== undefined) return workerResponse;
    }

    return jsonResponse({ error: "not_found" }, 404);
  });

/**
 * Adapt the Effect request program to Better Auth's standard fetch handler
 * shape. Every non-auth failure becomes a generic response so database or
 * provider details never cross the HTTP boundary.
 */
export const makeRequestHandler =
  (dependencies: RequestHandlerDependencies) => (request: Request) =>
    Effect.runPromise(dispatch(request, dependencies), { signal: request.signal }).catch(
      (cause: unknown) => {
        if (request.signal.aborted) return Promise.reject(request.signal.reason);
        return isRequestHandlerError(cause) && cause.status !== undefined
          ? jsonResponse({ error: cause.publicCode ?? "invalid_request" }, cause.status)
          : jsonResponse({ error: "internal_server_error" }, 500);
      },
    );

export type AuthInstance = ReturnType<typeof makeAuth>;
