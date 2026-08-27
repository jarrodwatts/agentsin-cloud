import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Pool } from "pg";

import { type ControlPlaneConfigShape } from "./config.ts";
import { type DatabaseService } from "./database.ts";
import { makeApplication } from "./main.ts";
import { type WorkspaceRepositoryService } from "./workspaces.ts";

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
};

const workspaces: WorkspaceRepositoryService = {
  ensureForUser: () =>
    Effect.succeed({
      id: "workspace-1",
      ownerUserId: "user-1",
      name: "Ada's workspace",
      createdAt: "2026-08-27T00:00:00.000Z",
    }),
  findForUser: () => Effect.void.pipe(Effect.as(undefined)),
};

it.effect("wires auth, services, and HTTP routes without opening a listener", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const pool = yield* Effect.acquireRelease(
        Effect.sync(() => new Pool({ connectionString: config.databaseUrl.toString(), max: 1 })),
        (activePool) => Effect.promise(() => activePool.end()),
      );
      const database: DatabaseService = {
        pool,
        query: <Row>() => Effect.succeed([] as ReadonlyArray<Row>),
        ping: Effect.void,
      };
      const application = makeApplication({ config, database, workspaces });
      const response = yield* Effect.promise(() =>
        application.handle(new Request("https://control.example.com/healthz")),
      );

      expect(application.auth.handler).toBeTypeOf("function");
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toEqual({
        service: "control-plane",
        status: "ok",
      });
    }),
  ),
);
