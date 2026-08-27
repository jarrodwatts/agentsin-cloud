// @effect-diagnostics nodeBuiltinImport:off -- This test exercises the native HTTP upgrade boundary.
import * as NodeHttp from "node:http";

import type { ThreadId } from "@t3tools/contracts";
import {
  CloudThreadStreamSubscribe,
  CloudThreadStreamServerFrame,
  type WorkspaceId,
} from "@t3tools/contracts/cloud";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { WebSocket } from "ws";

import { makeCloudRpc } from "./cloudRpc.ts";
import { attachCloudRpcWebSocket } from "./cloudRpcWebSocket.ts";
import type { ControlPlaneAuth } from "./http.ts";
import type { ThreadEventStoreService } from "./threadEventStore.ts";
import type { WorkspaceRepositoryService } from "./workspaces.ts";

const workspaceId = "workspace-ws" as WorkspaceId;
const threadId = "thread-ws" as ThreadId;
const decodeServerFrame = Schema.decodeUnknownSync(
  Schema.fromJsonString(CloudThreadStreamServerFrame),
);
const encodeSubscribe = Schema.encodeUnknownSync(Schema.fromJsonString(CloudThreadStreamSubscribe));

class WebSocketTestError extends Schema.TaggedErrorClass<WebSocketTestError>()(
  "WebSocketTestError",
  { operation: Schema.String, cause: Schema.Unknown },
) {}

const auth: ControlPlaneAuth = {
  handler: async () => new Response(null),
  api: {
    getSession: async ({ headers }) =>
      headers.get("authorization") === "Bearer desktop-token"
        ? { user: { id: "user-1", name: "Ada" } }
        : null,
    generateOneTimeToken: async () => ({ token: "unused" }),
  },
};

const workspaces: WorkspaceRepositoryService = {
  ensureForUser: () =>
    Effect.succeed({
      id: workspaceId,
      ownerUserId: "user-1",
      name: "Ada's workspace",
      createdAt: "2026-08-27T12:00:00.000Z",
    }),
  findForUser: () => Effect.void.pipe(Effect.as(undefined)),
};

const eventStore = {
  replayAfter: (routedWorkspace: WorkspaceId, routedThread: ThreadId, afterSequence: number) =>
    routedWorkspace === workspaceId && routedThread === threadId && afterSequence === -1
      ? Effect.succeed({ events: [], nextSequence: 0, hasMore: false })
      : Effect.die("unexpected replay request"),
} as unknown as ThreadEventStoreService;

const listen = (server: NodeHttp.Server) =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      }),
    catch: (cause) => new WebSocketTestError({ operation: "listen", cause }),
  });

const closeServer = (server: NodeHttp.Server) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );

const open = (url: string) =>
  Effect.tryPromise({
    try: () =>
      new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(url, {
          headers: { authorization: "Bearer desktop-token" },
        });
        socket.once("open", () => resolve(socket));
        socket.once("error", reject);
      }),
    catch: (cause) => new WebSocketTestError({ operation: "open", cause }),
  });

const upgradeStatus = (url: string) =>
  Effect.promise(
    () =>
      new Promise<number | undefined>((resolve) => {
        const socket = new WebSocket(url, {
          headers: { authorization: "Bearer desktop-token" },
        });
        socket.once("unexpected-response", (_request, response) => {
          resolve(response.statusCode);
          socket.terminate();
        });
        socket.once("error", () => undefined);
      }),
  );

const waitForFrame = (socket: WebSocket, type: CloudThreadStreamServerFrame["type"]) =>
  new Promise<CloudThreadStreamServerFrame>((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      try {
        const frame = decodeServerFrame(data.toString());
        if (frame.type !== type) return;
        socket.off("message", onMessage);
        socket.off("error", reject);
        resolve(frame);
      } catch (cause) {
        socket.off("message", onMessage);
        socket.off("error", reject);
        reject(cause);
      }
    };
    socket.on("message", onMessage);
    socket.once("error", reject);
  });

const receive = (receipt: Promise<CloudThreadStreamServerFrame>) =>
  Effect.tryPromise({
    try: () => receipt,
    catch: (cause) => new WebSocketTestError({ operation: "receive", cause }),
  });

it.effect("authenticates upgrades and enforces the native max-payload boundary", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.sync(() => NodeHttp.createServer((_request, response) => response.end())),
        closeServer,
      );
      const rpc = makeCloudRpc({
        auth,
        hostedOrigin: "https://control.example.com",
        workspaces,
        eventStore,
        limits: { maxFrameBytes: 256 },
      });
      const attachment = yield* Effect.acquireRelease(
        Effect.sync(() =>
          attachCloudRpcWebSocket({
            server,
            rpc,
            baseUrl: new URL("https://control.example.com"),
            authenticationTimeoutMs: 1_000,
          }),
        ),
        (attachment) => Effect.sync(attachment.detach),
      );
      void attachment;
      yield* listen(server);
      const address = server.address();
      if (address === null || typeof address === "string") return yield* Effect.die("no address");
      const url = `ws://127.0.0.1:${address.port}/api/v1/thread-events`;

      const unauthorizedStatus = yield* Effect.promise(
        () =>
          new Promise<number | undefined>((resolve) => {
            const unauthorized = new WebSocket(url);
            unauthorized.once("unexpected-response", (_request, response) => {
              resolve(response.statusCode);
              unauthorized.terminate();
            });
            unauthorized.once("error", () => undefined);
          }),
      );
      expect(unauthorizedStatus).toBe(403);

      const socket = yield* open(url);
      const caughtUpReceipt = waitForFrame(socket, "caughtUp");
      socket.send(
        encodeSubscribe({
          protocolVersion: 1,
          type: "subscribe",
          threadId,
          afterSequence: -1,
        }),
      );
      const caughtUp = yield* receive(caughtUpReceipt);
      expect(caughtUp).toMatchObject({ type: "caughtUp", lastSequence: -1 });
      socket.close(1000, "complete");

      const oversized = yield* open(url);
      const closed = new Promise<number>((resolve) => {
        oversized.once("close", (code) => resolve(code));
      });
      oversized.send("x".repeat(257));
      expect(yield* Effect.promise(() => closed)).toBe(1009);
    }),
  ),
);

it.effect("retains timed-out authorization capacity across request waves", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let activeAuthorizations = 0;
      const stalledAuth: ControlPlaneAuth = {
        handler: async () => new Response(null),
        api: {
          getSession: ({ signal }) =>
            new Promise((_resolve, reject) => {
              activeAuthorizations += 1;
              signal?.addEventListener(
                "abort",
                () => {
                  activeAuthorizations -= 1;
                  reject(new Error("authorization aborted"));
                },
                { once: true },
              );
            }),
          generateOneTimeToken: async () => ({ token: "unused" }),
        },
      };
      const server = yield* Effect.acquireRelease(
        Effect.sync(() => NodeHttp.createServer((_request, response) => response.end())),
        closeServer,
      );
      const rpc = makeCloudRpc({
        auth: stalledAuth,
        hostedOrigin: "https://control.example.com",
        workspaces,
        eventStore,
      });
      const attachment = yield* Effect.acquireRelease(
        Effect.sync(() =>
          attachCloudRpcWebSocket({
            server,
            rpc,
            baseUrl: new URL("https://control.example.com"),
            authenticationTimeoutMs: 10,
            maxPendingUpgrades: 2,
          }),
        ),
        (current) => Effect.sync(current.detach),
      );
      yield* listen(server);
      const address = server.address();
      if (address === null || typeof address === "string") return yield* Effect.die("no address");
      const url = `ws://127.0.0.1:${address.port}/api/v1/thread-events`;

      expect(
        yield* Effect.all([upgradeStatus(url), upgradeStatus(url)], { concurrency: "unbounded" }),
      ).toEqual([504, 504]);
      expect(activeAuthorizations).toBe(2);
      expect(attachment.pendingUpgradeCount()).toBe(2);

      expect(yield* upgradeStatus(url)).toBe(429);
      expect(yield* upgradeStatus(url)).toBe(429);
      expect(activeAuthorizations).toBe(2);
      expect(attachment.pendingUpgradeCount()).toBe(2);

      attachment.detach();
      expect(activeAuthorizations).toBe(0);
      yield* Effect.promise(attachment.waitForPendingSettled);
      expect(attachment.pendingUpgradeCount()).toBe(0);
    }),
  ),
);

it.effect("retains disconnected authorization work until its ignored-signal promise settles", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let activeAuthorizations = 0;
      let startedAuthorizations = 0;
      const startWaiters = new Map<number, () => void>();
      const resolvers: Array<() => void> = [];
      const waitForStarts = (count: number) => {
        if (startedAuthorizations >= count) return Promise.resolve();
        return new Promise<void>((resolve) => startWaiters.set(count, resolve));
      };
      const ignoringSignalAuth: ControlPlaneAuth = {
        handler: async () => new Response(null),
        api: {
          getSession: () =>
            new Promise((resolve) => {
              activeAuthorizations += 1;
              startedAuthorizations += 1;
              for (const [count, notify] of startWaiters) {
                if (startedAuthorizations < count) continue;
                startWaiters.delete(count);
                notify();
              }
              let settled = false;
              resolvers.push(() => {
                if (settled) return;
                settled = true;
                activeAuthorizations -= 1;
                resolve({ user: { id: "user-1", name: "Ada" } });
              });
            }),
          generateOneTimeToken: async () => ({ token: "unused" }),
        },
      };
      const server = yield* Effect.acquireRelease(
        Effect.sync(() => NodeHttp.createServer((_request, response) => response.end())),
        closeServer,
      );
      const rpc = makeCloudRpc({
        auth: ignoringSignalAuth,
        hostedOrigin: "https://control.example.com",
        workspaces,
        eventStore,
      });
      const attachment = yield* Effect.acquireRelease(
        Effect.sync(() =>
          attachCloudRpcWebSocket({
            server,
            rpc,
            baseUrl: new URL("https://control.example.com"),
            authenticationTimeoutMs: 1_000,
            maxPendingUpgrades: 2,
          }),
        ),
        (current) => Effect.sync(current.detach),
      );
      yield* listen(server);
      const address = server.address();
      if (address === null || typeof address === "string") return yield* Effect.die("no address");
      const url = `ws://127.0.0.1:${address.port}/api/v1/thread-events`;

      const connectAndDisconnect = (expectedStarts: number) =>
        Effect.promise(async () => {
          const socket = new WebSocket(url, {
            headers: { authorization: "Bearer desktop-token" },
          });
          const terminated = new Promise<void>((resolve) => {
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              resolve();
            };
            socket.once("error", finish);
            socket.once("close", finish);
          });
          await waitForStarts(expectedStarts);
          socket.terminate();
          await terminated;
        });

      yield* connectAndDisconnect(1);
      yield* connectAndDisconnect(2);
      expect(activeAuthorizations).toBe(2);
      expect(attachment.pendingUpgradeCount()).toBe(2);
      expect(yield* upgradeStatus(url)).toBe(429);
      expect(yield* upgradeStatus(url)).toBe(429);

      for (const resolve of resolvers.splice(0)) resolve();
      yield* Effect.promise(attachment.waitForPendingSettled);
      expect(activeAuthorizations).toBe(0);
      expect(attachment.pendingUpgradeCount()).toBe(0);

      const recovered = new WebSocket(url, {
        headers: { authorization: "Bearer desktop-token" },
      });
      const recoveredOpen = new Promise<void>((resolve, reject) => {
        recovered.once("open", resolve);
        recovered.once("error", reject);
      });
      yield* Effect.promise(() => waitForStarts(3));
      resolvers.shift()?.();
      yield* Effect.promise(() => recoveredOpen);
      recovered.close(1000, "complete");
      expect(activeAuthorizations).toBe(0);
      expect(attachment.pendingUpgradeCount()).toBe(0);
    }),
  ),
);

it.effect("aborts and destroys an in-flight upgrade without a late connection on detach", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let activeAuthorizations = 0;
      let resolveAuthorization: (() => void) | undefined;
      let notifyStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });
      const delayedAuth: ControlPlaneAuth = {
        handler: async () => new Response(null),
        api: {
          getSession: () =>
            new Promise((resolve) => {
              activeAuthorizations += 1;
              let settled = false;
              notifyStarted?.();
              resolveAuthorization = () => {
                if (settled) return;
                settled = true;
                activeAuthorizations -= 1;
                resolve({ user: { id: "user-1", name: "Ada" } });
              };
            }),
          generateOneTimeToken: async () => ({ token: "unused" }),
        },
      };
      const server = yield* Effect.acquireRelease(
        Effect.sync(() => NodeHttp.createServer((_request, response) => response.end())),
        closeServer,
      );
      const baseRpc = makeCloudRpc({
        auth: delayedAuth,
        hostedOrigin: "https://control.example.com",
        workspaces,
        eventStore,
      });
      let openedConnections = 0;
      const openAuthorizedSocket = baseRpc.openAuthorizedSocket;
      const rpc = {
        ...baseRpc,
        openAuthorizedSocket: (...args: Parameters<typeof openAuthorizedSocket>) => {
          openedConnections += 1;
          return openAuthorizedSocket(...args);
        },
      };
      const attachment = yield* Effect.acquireRelease(
        Effect.sync(() =>
          attachCloudRpcWebSocket({
            server,
            rpc,
            baseUrl: new URL("https://control.example.com"),
            authenticationTimeoutMs: 1_000,
          }),
        ),
        (current) => Effect.sync(current.detach),
      );
      yield* listen(server);
      const address = server.address();
      if (address === null || typeof address === "string") return yield* Effect.die("no address");
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/thread-events`, {
        headers: { authorization: "Bearer desktop-token" },
      });
      const terminated = new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        socket.once("error", finish);
        socket.once("close", finish);
      });

      yield* Effect.promise(() => started);
      expect(attachment.pendingUpgradeCount()).toBe(1);
      attachment.detach();
      yield* Effect.promise(() => terminated);
      expect(activeAuthorizations).toBe(1);
      expect(attachment.pendingUpgradeCount()).toBe(1);
      resolveAuthorization?.();
      yield* Effect.promise(attachment.waitForPendingSettled);

      expect(activeAuthorizations).toBe(0);
      expect(attachment.pendingUpgradeCount()).toBe(0);
      expect(openedConnections).toBe(0);
    }),
  ),
);
