import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ControlPlaneConfigShape } from "./config.ts";
import { DatabaseError, type DatabaseService } from "./database.ts";
import { codeChallengeForVerifier } from "./desktopAuth.ts";
import {
  type AuthSession,
  type ControlPlaneAuth,
  jsonResponse,
  makeRequestHandler,
} from "./http.ts";
import { type WorkspaceRepositoryService } from "./workspaces.ts";

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeTokenBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ token: Schema.optional(Schema.String) })),
);

const makeDatabase = (ping: DatabaseService["ping"] = Effect.void): DatabaseService => ({
  pool: undefined as never,
  query: <Row>() => Effect.succeed([] as ReadonlyArray<Row>),
  ping,
});

const config: ControlPlaneConfigShape = {
  port: 8787,
  host: "127.0.0.1",
  databaseUrl: new URL("postgresql://localhost/agents_in_cloud"),
  betterAuthSecret: "a-secure-secret-that-is-at-least-32-characters",
  betterAuthUrl: new URL("https://control.example.com"),
  githubClientId: "github-client-id",
  githubClientSecret: "github-client-secret",
  passkeyRpId: "control.example.com",
  passkeyRpName: "Agents in Cloud",
  desktopAuthCallbackUrl: new URL("agentsincloud://auth/callback"),
  desktopAuthHandoffSecret: "a-separate-handoff-secret-that-is-at-least-32-characters",
  desktopAuthHandoffTtlSeconds: 120,
  maxRequestBodyBytes: 1_024 * 1_024,
  requestTimeoutMs: 15_000,
  headersTimeoutMs: 10_000,
  workerMtlsPort: 9443,
  workerMtlsHost: "127.0.0.1",
  workerMtlsServerCertificateFile: "/run/secrets/worker-server.crt",
  workerMtlsServerKeyFile: "/run/secrets/worker-server.key",
  workerMtlsClientCaFile: "/run/secrets/worker-client-ca.crt",
  workerProcessInstanceId: "railway-replica-1",
  workerCertificateSignerKmsKeyId: "kms://worker-issuer-production",
};

const workspace = {
  id: "workspace-1",
  ownerUserId: "user-1",
  name: "Ada's workspace",
  createdAt: "2026-08-27T00:00:00.000Z",
};

const workspaces: WorkspaceRepositoryService = {
  ensureForUser: () => Effect.succeed(workspace),
  findForUser: () => Effect.succeed(workspace),
};

const request = (path: string, init?: RequestInit) =>
  new Request(`https://control.example.com${path}`, init);

const body = (response: Response) =>
  Effect.promise(() => response.json() as Promise<Record<string, unknown>>);

const makeAuth = (session: AuthSession | null): ControlPlaneAuth => ({
  handler: async () => new Response("auth route", { status: 201 }),
  api: {
    getSession: async () => session,
    generateOneTimeToken: async () => ({ token: "one-time-token" }),
  },
});

it.effect("serves health and readiness probes", () =>
  Effect.gen(function* () {
    const handler = makeRequestHandler({
      auth: makeAuth(null),
      config,
      database: makeDatabase(),
      workspaces,
    });
    const health = yield* Effect.promise(() => handler(request("/health")));
    const ready = yield* Effect.promise(() => handler(request("/ready")));

    expect(health.status).toBe(200);
    expect(yield* body(health)).toEqual({ service: "control-plane", status: "ok" });
    expect(ready.status).toBe(200);
    expect(yield* body(ready)).toEqual({ service: "control-plane", status: "ready" });
  }),
);

it.effect("returns 503 when the database readiness check fails", () =>
  Effect.gen(function* () {
    const handler = makeRequestHandler({
      auth: makeAuth(null),
      config,
      database: makeDatabase(
        Effect.fail(new DatabaseError({ operation: "SELECT 1", cause: "offline" })),
      ),
      workspaces,
    });
    const response = yield* Effect.promise(() => handler(request("/readyz")));

    expect(response.status).toBe(503);
    expect(yield* body(response)).toEqual({ status: "not_ready" });
  }),
);

it("interrupts Effect request work when the Fetch request is aborted", async () => {
  const controller = new AbortController();
  const handler = makeRequestHandler({
    auth: makeAuth(null),
    config,
    database: makeDatabase(Effect.never),
    workspaces,
  });
  const reason = new Error("client disconnected");
  const pending = handler(request("/ready", { signal: controller.signal }));

  controller.abort(reason);

  await expect(pending).rejects.toBe(reason);
});

it.effect("delegates Better Auth routes without exposing them to workspace routing", () =>
  Effect.gen(function* () {
    const handler = makeRequestHandler({
      auth: makeAuth(null),
      config,
      database: makeDatabase(),
      workspaces,
    });
    const response = yield* Effect.promise(() => handler(request("/api/auth/sign-in/github")));

    expect(response.status).toBe(201);
    expect(yield* Effect.promise(() => response.text())).toBe("auth route");
  }),
);

it.effect("denies workspace access without a session", () =>
  Effect.gen(function* () {
    let ensureCalls = 0;
    const handler = makeRequestHandler({
      auth: makeAuth(null),
      config,
      database: makeDatabase(),
      workspaces: {
        ...workspaces,
        ensureForUser: () => {
          ensureCalls += 1;
          return Effect.succeed(workspace);
        },
      },
    });
    const response = yield* Effect.promise(() => handler(request("/api/workspace")));

    expect(response.status).toBe(401);
    expect(yield* body(response)).toEqual({ error: "unauthorized" });
    expect(ensureCalls).toBe(0);
  }),
);

it.effect("returns the authenticated user's workspace", () =>
  Effect.gen(function* () {
    const handler = makeRequestHandler({
      auth: makeAuth({ user: { id: "user-1", name: "Ada" } }),
      config,
      database: makeDatabase(),
      workspaces,
    });
    const response = yield* Effect.promise(() => handler(request("/api/workspace")));

    expect(response.status).toBe(200);
    expect(yield* body(response)).toEqual({ workspace });
  }),
);

it.effect("derives GitHub workflow actor and session identity from Better Auth", () =>
  Effect.gen(function* () {
    let received: Record<string, unknown> | undefined;
    const handler = makeRequestHandler({
      auth: makeAuth({
        user: { id: "user-1", name: "Ada" },
        session: { id: "session-authoritative" },
      }),
      config,
      database: makeDatabase(),
      workspaces,
      githubWorkflow: {
        execute: (input) =>
          Effect.sync(() => {
            received = input;
            return { disposition: "accepted" };
          }),
      },
    });
    const response = yield* Effect.promise(() =>
      handler(
        request("/api/v1/github/thread-workflow", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: encodeJson({
            idempotencyKey: "idem-http-1",
            command: {
              type: "github.branch.create",
              commandId: "command-http-1",
              workspaceId: "workspace-1",
              environmentId: "environment-1",
              threadId: "thread-1",
              repository: {
                provider: "github",
                host: "github.com",
                installationId: "installation-1",
                owner: "jarrodwatts",
                name: "agentsin-cloud",
                canonicalKey: "github.com/jarrodwatts/agentsin-cloud",
              },
              approvalId: "approval-http-1",
              requestedAt: "2026-08-27T12:00:00.000Z",
              threadSlug: "HTTP workflow",
              baseSha: "a".repeat(40),
            },
          }),
        }),
      ),
    );
    expect(response.status).toBe(200);
    expect(received).toMatchObject({
      actorUserId: "user-1",
      authSessionId: "session-authoritative",
      workspaceId: "workspace-1",
    });
  }),
);

it.effect("returns a generic error when an auth handler fails", () =>
  Effect.gen(function* () {
    const handler = makeRequestHandler({
      auth: {
        handler: async () => {
          throw new Error("provider details must not escape");
        },
        api: {
          getSession: async () => null,
          generateOneTimeToken: async () => ({ token: "one-time-token" }),
        },
      },
      config,
      database: makeDatabase(),
      workspaces,
    });
    const response = yield* Effect.promise(() => handler(request("/api/auth/callback/github")));

    expect(response.status).toBe(500);
    expect(yield* body(response)).toEqual({ error: "internal_server_error" });
  }),
);

it.effect("completes a hosted, PKCE-bound desktop handoff exactly once", () =>
  Effect.gen(function* () {
    const codeVerifier = "v".repeat(64);
    let consumed = false;
    const auth: ControlPlaneAuth = {
      api: {
        getSession: async () => ({ user: { id: "user-1", name: "Ada" } }),
        generateOneTimeToken: async () => ({ token: "server-one-time-token" }),
      },
      handler: async (authRequest) => {
        const submitted = decodeTokenBody(await authRequest.text());
        if (submitted.token !== "server-one-time-token" || consumed) {
          return jsonResponse({ error: "invalid_token" }, 400);
        }
        consumed = true;
        const headers = new Headers({
          "content-type": "application/json",
          "set-auth-token": "signed-desktop-bearer",
        });
        headers.append("set-cookie", "session=one; HttpOnly; Secure; Path=/");
        headers.append("set-cookie", "csrf=two; HttpOnly; Secure; Path=/");
        return new Response(encodeJson({ user: { id: "user-1" } }), { headers });
      },
    };
    const handler = makeRequestHandler({ auth, config, database: makeDatabase(), workspaces });

    const initiate = yield* Effect.promise(() =>
      handler(
        request("/api/desktop-auth/initiate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: encodeJson({
            codeChallenge: codeChallengeForVerifier(codeVerifier),
            state: "s".repeat(32),
          }),
        }),
      ),
    );
    const initiation = (yield* body(initiate)) as { readonly browserUrl: string };
    expect(new URL(initiation.browserUrl).origin).toBe(config.betterAuthUrl.origin);

    const complete = yield* Effect.promise(() =>
      handler(new Request(initiation.browserUrl, { headers: { cookie: "browser-session=valid" } })),
    );
    expect(complete.status).toBe(303);
    const callback = new URL(complete.headers.get("location") ?? "");
    expect(`${callback.protocol}//${callback.hostname}${callback.pathname}`).toBe(
      "agentsincloud://auth/callback",
    );
    expect(callback.searchParams.get("state")).toBe("s".repeat(32));
    const handoff = callback.searchParams.get("handoff");
    expect(handoff).not.toBeNull();

    const exchangeRequest = () =>
      request("/api/desktop-auth/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: encodeJson({ handoff, codeVerifier }),
      });
    const exchanged = yield* Effect.promise(() => handler(exchangeRequest()));
    expect(exchanged.status).toBe(200);
    expect(exchanged.headers.get("set-auth-token")).toBe("signed-desktop-bearer");

    const replay = yield* Effect.promise(() => handler(exchangeRequest()));
    expect(replay.status).toBe(400);
    expect(yield* body(replay)).toEqual({ error: "invalid_handoff" });
  }),
);

it.effect("rejects browser-origin, tampered, and direct one-time-token exchanges", () =>
  Effect.gen(function* () {
    let authHandlerCalls = 0;
    const auth: ControlPlaneAuth = {
      ...makeAuth({ user: { id: "user-1", name: "Ada" } }),
      handler: async () => {
        authHandlerCalls += 1;
        return new Response(null, { status: 204 });
      },
    };
    const handler = makeRequestHandler({ auth, config, database: makeDatabase(), workspaces });
    const verifier = "v".repeat(64);
    const initiateBody = encodeJson({
      codeChallenge: codeChallengeForVerifier(verifier),
      state: "s".repeat(32),
    });

    const browserInitiate = yield* Effect.promise(() =>
      handler(
        request("/api/desktop-auth/initiate", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "t3code://app",
          },
          body: initiateBody,
        }),
      ),
    );
    expect(browserInitiate.status).toBe(403);

    const directVerify = yield* Effect.promise(() =>
      handler(
        request("/api/auth/one-time-token/verify", {
          method: "POST",
          body: encodeJson({ token: "stolen" }),
        }),
      ),
    );
    expect(directVerify.status).toBe(404);

    const initiate = yield* Effect.promise(() =>
      handler(
        request("/api/desktop-auth/initiate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: initiateBody,
        }),
      ),
    );
    const { browserUrl } = (yield* body(initiate)) as { readonly browserUrl: string };
    const complete = yield* Effect.promise(() => handler(new Request(browserUrl)));
    const callback = new URL(complete.headers.get("location") ?? "");
    const handoff = callback.searchParams.get("handoff") ?? "";
    const tampered = `${handoff.slice(0, -1)}${handoff.endsWith("A") ? "B" : "A"}`;
    const invalid = yield* Effect.promise(() =>
      handler(
        request("/api/desktop-auth/exchange", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: encodeJson({ handoff: tampered, codeVerifier: verifier }),
        }),
      ),
    );
    expect(invalid.status).toBe(400);
    expect(yield* body(invalid)).toEqual({ error: "invalid_handoff" });
    expect(authHandlerCalls).toBe(0);
  }),
);
