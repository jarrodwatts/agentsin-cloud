import type { ThreadId } from "@t3tools/contracts";
import {
  InspectorClientFrame,
  type InspectorServerFrame,
  type InspectorWorkerFrame,
} from "@t3tools/contracts/inspector";
import type { WorkspaceId } from "@t3tools/contracts/cloud";
import type { WorkerRelayInbound } from "@t3tools/contracts/worker";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ArtifactStorageService, UploadArtifactInput } from "./artifactStorage.ts";
import type {
  CloudThreadLifecycleAttempt,
  CloudThreadLifecycleStore,
} from "./cloudThreadLifecycleStore.ts";
import type { CloudRpcSocket } from "./cloudRpc.ts";
import {
  InspectorBridgeError,
  makeInspectorBridge,
  type InspectorBridgeLimits,
} from "./inspectorBridge.ts";
import { makeInMemoryWorkerRouteRegistry, type ActiveWorkerRoute } from "./workerRelay.ts";

const workspaceId = "workspace-1" as WorkspaceId;
const threadId = "thread-1" as ThreadId;
const now = "2026-08-27T12:00:00.000Z";
const decodeServer = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeClient = Schema.encodeUnknownSync(Schema.fromJsonString(InspectorClientFrame));
const encodeUnknown = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const isInspectorBridgeError = Schema.is(InspectorBridgeError);

const attempt: CloudThreadLifecycleAttempt = {
  workspaceId,
  threadId,
  attemptId: "attempt-1",
  idempotencyKey: "idempotency-1",
  requestFingerprint: "fingerprint-1",
  environmentId: "environment-1" as never,
  environmentRevisionId: "revision-1" as never,
  environmentRevisionHash: "revision-hash-1",
  projectId: "project-1" as never,
  providerInstanceId: "codex_personal" as never,
  providerDriver: "codex" as never,
  repositoryIdentity: {
    canonicalKey: "github.com/jarrodwatts/agentsin-cloud",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/jarrodwatts/agentsin-cloud.git",
    },
  },
  workspaceDirectory: "/workspace/project",
  state: "ready",
  isCurrent: true,
  sandboxId: "sandbox-1" as never,
  providerHandle: "e2b-handle-1",
  workerId: "worker-1" as never,
  sealedBootstrapRef: "bootstrap-1",
  createdAt: now,
  updatedAt: now,
};

const lease = (routeGeneration: number) => ({
  workspaceId,
  threadId,
  environmentId: attempt.environmentId,
  environmentRevisionId: attempt.environmentRevisionId,
  sandboxId: attempt.sandboxId!,
  reservationId: "reservation-1" as never,
  workerId: attempt.workerId!,
  providerInstanceId: attempt.providerInstanceId,
  providerDriver: attempt.providerDriver,
  certificateFingerprint: "fingerprint-1",
  certificateGeneration: 1,
  identityBinding: "binding-1",
  sanUri: "spiffe://agentsin.cloud/workers/binding-1",
  publicKeySpkiSha256: "spki-1",
  notBefore: now,
  notAfter: "2026-08-27T13:00:00.000Z",
  processInstanceId: "process-1",
  leaseGeneration: routeGeneration,
  routeGeneration,
  state: "connected" as const,
  connectedAt: now,
  lastSeenAt: now,
  heartbeatSequence: 1,
  confirmedEventCursor: -1,
});

class FakeSocket implements CloudRpcSocket {
  readonly sent: Array<InspectorServerFrame> = [];
  readonly closes: Array<{ readonly code: number; readonly reason: string }> = [];
  private readonly messages = new Set<(payload: string | Uint8Array, binary: boolean) => void>();
  private readonly closeListeners = new Set<() => void>();
  holdSends = false;
  private readonly sendCompletions: Array<(error?: Error) => void> = [];

  send(payload: string, complete: (error?: Error) => void) {
    this.sent.push(decodeServer(payload) as InspectorServerFrame);
    if (this.holdSends) this.sendCompletions.push(complete);
    else complete();
  }
  close(code: number, reason: string) {
    this.closes.push({ code, reason });
  }
  onMessage(listener: (payload: string | Uint8Array, binary: boolean) => void) {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }
  onClose(listener: () => void) {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
  emit(frame: InspectorClientFrame) {
    for (const listener of this.messages) listener(encodeClient(frame), false);
  }
  disconnect() {
    for (const listener of this.closeListeners) listener();
  }
  flush() {
    for (const complete of this.sendCompletions.splice(0)) complete();
  }
}

const makeHarness = (input?: {
  readonly workspace?: WorkspaceId;
  readonly maxQueuedFrames?: number;
  readonly limits?: Partial<InspectorBridgeLimits>;
  readonly currentAttempt?: () => CloudThreadLifecycleAttempt | undefined;
  readonly nowMs?: () => number;
}) => {
  const routes = makeInMemoryWorkerRouteRegistry();
  const workerCommands: Array<WorkerRelayInbound> = [];
  const active: ActiveWorkerRoute = {
    lease: lease(1),
    send: (frame) => {
      workerCommands.push(frame);
      return true;
    },
    close: () => undefined,
  };
  routes.activate(active);
  const lifecycle = {
    getCurrent: async (workspace: WorkspaceId, thread: ThreadId) =>
      workspace === workspaceId && thread === threadId
        ? input?.currentAttempt === undefined
          ? attempt
          : input.currentAttempt()
        : undefined,
  } as CloudThreadLifecycleStore;
  const uploads: Array<{ readonly artifactId: string; readonly bytes: Uint8Array }> = [];
  const downloads: Array<{ readonly workspaceId: WorkspaceId; readonly threadId: ThreadId }> = [];
  const artifacts = {
    upload: (upload: UploadArtifactInput) =>
      Effect.promise(async () => {
        const chunks: Array<Uint8Array> = [];
        for await (const chunk of upload.body) chunks.push(chunk);
        uploads.push({ artifactId: upload.artifactId, bytes: Buffer.concat(chunks) });
        return {
          disposition: "created" as const,
          artifact: { artifactId: upload.artifactId } as never,
        };
      }),
    download: (downloadWorkspaceId: WorkspaceId, downloadThreadId: ThreadId) =>
      Effect.sync(() => {
        downloads.push({ workspaceId: downloadWorkspaceId, threadId: downloadThreadId });
        return {
          artifact: {
            kind: "screenshot",
            mediaType: "image/png",
            sha256: "8f8cbb7dcf46e0bc7d53265749a6c17d116093a6ba95e442764060c76fd4a86c",
          } as never,
          bytes: Buffer.from("png"),
        };
      }),
  } as unknown as ArtifactStorageService;
  const bridge = makeInspectorBridge({
    auth: {
      handler: async () => new Response(),
      api: {
        getSession: async () => ({ user: { id: "user-1", name: "User" } }),
        generateOneTimeToken: async () => ({ token: "token" }),
      },
    },
    hostedOrigin: "https://app.agentsin.cloud",
    workspaces: {
      ensureForUser: () =>
        Effect.succeed({
          id: input?.workspace ?? workspaceId,
          name: "Workspace",
          slug: "workspace",
          createdAt: now,
          updatedAt: now,
        }),
    } as never,
    lifecycle,
    routes,
    artifacts,
    limits: {
      heartbeatIntervalMs: 60_000,
      reconnectGraceMs: 10_000,
      ...(input?.maxQueuedFrames === undefined ? {} : { maxQueuedFrames: input.maxQueuedFrames }),
      ...input?.limits,
    },
    nextSessionId: () => "session-1" as never,
    ...(input?.nowMs === undefined ? {} : { nowMs: input.nowMs }),
  });
  return { bridge, routes, active, workerCommands, uploads, downloads };
};

const headers = new Headers({ authorization: "Bearer token" });
const openFrame = (
  sessionId?: string,
): Extract<InspectorClientFrame, { readonly type: "inspector.open" }> => ({
  protocolVersion: 1,
  type: "inspector.open",
  threadId,
  attemptId: "attempt-1" as never,
  ...(sessionId === undefined ? {} : { sessionId: sessionId as never }),
  resumeAfterSequence: -1,
});

const readyFrame = (routeGeneration = 1): InspectorWorkerFrame => ({
  type: "inspector.ready",
  binding: {
    protocolVersion: 1,
    workspaceId,
    threadId,
    attemptId: "attempt-1" as never,
    environmentId: "environment-1" as never,
    environmentRevisionId: "revision-1" as never,
    providerInstanceId: "codex_personal" as never,
    providerDriver: "codex" as never,
    sandboxId: "sandbox-1" as never,
    workerId: "worker-1" as never,
    routeGeneration,
  },
  sessionId: "session-1" as never,
  sequence: 0,
  emittedAt: now,
  capabilities: {
    terminal: true,
    files: true,
    ports: true,
    browserFrames: false,
    browserInput: false,
    desktopFrames: false,
    desktopInput: false,
    desktopBackend: "unsupported",
  },
});

const authorize = (bridge: ReturnType<typeof makeInspectorBridge>) =>
  bridge.authorizeWebSocket(headers, { threadId, attemptId: "attempt-1" });

it.effect("derives the workspace from auth and routes only to the current attempt", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const principal = yield* authorize(harness.bridge);
    const socket = new FakeSocket();
    harness.bridge.openAuthorizedSocket(socket, principal);
    socket.emit(openFrame());
    yield* harness.bridge.drain;
    expect(harness.workerCommands[0]).toMatchObject({
      type: "inspector.command",
      command: {
        type: "inspector.open",
        binding: {
          workspaceId,
          threadId,
          environmentId: attempt.environmentId,
          environmentRevisionId: attempt.environmentRevisionId,
          providerInstanceId: attempt.providerInstanceId,
          providerDriver: attempt.providerDriver,
          sandboxId: "sandbox-1",
          routeGeneration: 1,
        },
      },
    });
    yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, readyFrame());
    expect(socket.sent[0]).toMatchObject({
      type: "inspector.opened",
      sessionId: "session-1",
      sequence: 0,
      resumedThroughSequence: -1,
    });
    harness.bridge.dispose();
  }),
);

it.effect("does not disclose another workspace's current thread", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ workspace: "workspace-2" as WorkspaceId });
    const result = yield* Effect.result(authorize(harness.bridge));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(isInspectorBridgeError(result.failure)).toBe(true);
      expect(result.failure.code).toBe("notFound");
    }
    harness.bridge.dispose();
  }),
);

it.effect("rejects stale routes and denies interactive input until C7 grants a lease", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const principal = yield* authorize(harness.bridge);
    const socket = new FakeSocket();
    harness.bridge.openAuthorizedSocket(socket, principal);
    socket.emit(openFrame());
    yield* harness.bridge.drain;
    const stale = yield* Effect.result(
      harness.bridge.inspectorFrames.handleFrame(lease(2), readyFrame(2)),
    );
    expect(stale._tag).toBe("Failure");
    socket.emit({
      protocolVersion: 1,
      type: "inspector.request",
      sessionId: "session-1" as never,
      operation: {
        type: "desktop.input",
        requestId: "input-1" as never,
        input: { type: "text", text: "secret" },
      },
    });
    yield* harness.bridge.drain;
    expect(socket.closes.at(-1)).toEqual({ code: 4403, reason: "forbidden" });
    expect(
      harness.workerCommands.some(
        (frame) => frame.type === "inspector.command" && frame.command.type === "inspector.request",
      ),
    ).toBe(false);
    harness.bridge.dispose();
  }),
);

it.effect("classifies a current-route frame with a forged attempt binding as fatal", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const principal = yield* authorize(harness.bridge);
    const socket = new FakeSocket();
    harness.bridge.openAuthorizedSocket(socket, principal);
    socket.emit(openFrame());
    yield* harness.bridge.drain;
    const result = yield* Effect.result(
      harness.bridge.inspectorFrames.handleFrame(harness.active.lease, {
        ...readyFrame(),
        binding: { ...readyFrame().binding, attemptId: "attempt-forged" as never },
      }),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.code).toBe("identityMismatch");
    harness.bridge.dispose();
  }),
);

it.effect(
  "stores screenshot bytes through the artifact service and strips them from client frames",
  () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const principal = yield* authorize(harness.bridge);
      const socket = new FakeSocket();
      harness.bridge.openAuthorizedSocket(socket, principal);
      socket.emit(openFrame());
      yield* harness.bridge.drain;
      yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, readyFrame());
      const bytes = Buffer.from("png");
      yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, {
        type: "inspector.artifact.proposed",
        binding: readyFrame().binding,
        sessionId: "session-1" as never,
        sequence: 1,
        emittedAt: now,
        requestId: "capture-1" as never,
        artifact: {
          artifactId: "artifact-1" as never,
          kind: "desktop-frame",
          mediaType: "image/png",
          byteLength: bytes.byteLength,
          sha256: "8f8cbb7dcf46e0bc7d53265749a6c17d116093a6ba95e442764060c76fd4a86c",
        },
        base64: bytes.toString("base64"),
      });
      expect(harness.uploads).toHaveLength(1);
      expect(harness.uploads[0]?.bytes.toString()).toBe("png");
      expect(socket.sent.at(-1)).toMatchObject({
        type: "inspector.data",
        payload: { type: "artifact", artifact: { artifactId: "artifact-1" } },
      });
      expect(encodeUnknown(socket.sent.at(-1))).not.toContain("cG5n");
      harness.bridge.dispose();
    }),
);

it.effect("downloads inspector artifacts only through the authenticated thread tuple", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const anonymous = yield* harness.bridge.handleHttp(
      new Request(
        "https://app.agentsin.cloud/api/v1/inspector/artifacts/artifact-1?threadId=thread-1&attemptId=attempt-1",
      ),
    );
    expect(anonymous?.status).toBe(403);
    expect(harness.downloads).toHaveLength(0);
    const response = yield* harness.bridge.handleHttp(
      new Request(
        "https://app.agentsin.cloud/api/v1/inspector/artifacts/artifact-1?threadId=thread-1&attemptId=attempt-1",
        { headers },
      ),
    );
    expect(response?.status).toBe(200);
    expect(yield* Effect.promise(() => response!.text())).toBe("png");
    expect(harness.downloads).toEqual([{ workspaceId, threadId }]);
    harness.bridge.dispose();

    const foreign = makeHarness({ workspace: "workspace-2" as WorkspaceId });
    const denied = yield* foreign.bridge.handleHttp(
      new Request(
        "https://app.agentsin.cloud/api/v1/inspector/artifacts/artifact-1?threadId=thread-1&attemptId=attempt-1",
        { headers },
      ),
    );
    expect(denied?.status).toBe(404);
    expect(foreign.downloads).toHaveLength(0);
    foreign.bridge.dispose();
  }),
);

it.effect("rebinds a resumable session to a newer authenticated worker route", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const principal = yield* authorize(harness.bridge);
    const first = new FakeSocket();
    harness.bridge.openAuthorizedSocket(first, principal);
    first.emit(openFrame());
    yield* harness.bridge.drain;
    first.disconnect();

    const newerCommands: Array<WorkerRelayInbound> = [];
    const newer: ActiveWorkerRoute = {
      lease: lease(2),
      send: (frame) => {
        newerCommands.push(frame);
        return true;
      },
      close: () => undefined,
    };
    harness.routes.activate(newer);
    yield* harness.bridge.drain;
    expect(newerCommands[0]).toMatchObject({
      type: "inspector.command",
      command: { type: "inspector.open", binding: { routeGeneration: 2 } },
    });

    const resumed = new FakeSocket();
    harness.bridge.openAuthorizedSocket(resumed, principal);
    resumed.emit(openFrame("session-1"));
    yield* harness.bridge.drain;
    expect(newerCommands.at(-1)).toMatchObject({
      type: "inspector.command",
      command: { type: "inspector.open", sessionId: "session-1" },
    });
    harness.bridge.dispose();
  }),
);

it.effect("closes reactivation when any durable attempt binding changes", () =>
  Effect.gen(function* () {
    const mutations: ReadonlyArray<
      (value: CloudThreadLifecycleAttempt) => CloudThreadLifecycleAttempt
    > = [
      (value) => ({ ...value, attemptId: "attempt-forged" }),
      (value) => ({ ...value, environmentId: "environment-forged" as never }),
      (value) => ({ ...value, environmentRevisionId: "revision-forged" as never }),
      (value) => ({ ...value, providerInstanceId: "provider-forged" as never }),
      (value) => ({ ...value, providerDriver: "claude" as never }),
      (value) => ({ ...value, sandboxId: "sandbox-forged" as never }),
      (value) => ({ ...value, workerId: "worker-forged" as never }),
    ];
    for (const mutate of mutations) {
      let current = attempt;
      const harness = makeHarness({ currentAttempt: () => current });
      const principal = yield* authorize(harness.bridge);
      const socket = new FakeSocket();
      harness.bridge.openAuthorizedSocket(socket, principal);
      socket.emit(openFrame());
      yield* harness.bridge.drain;
      current = mutate(attempt);
      const changedRoute: ActiveWorkerRoute = {
        lease: {
          ...lease(2),
          environmentId: current.environmentId,
          environmentRevisionId: current.environmentRevisionId,
          providerInstanceId: current.providerInstanceId,
          providerDriver: current.providerDriver,
          sandboxId: current.sandboxId!,
          workerId: current.workerId!,
        },
        send: () => true,
        close: () => undefined,
      };
      harness.routes.activate(changedRoute);
      yield* harness.bridge.drain;
      expect(socket.closes.at(-1)).toEqual({ code: 4409, reason: "stale_worker_route" });
      expect(harness.bridge.activeSessions()).toBe(0);
      harness.bridge.dispose();
    }
  }),
);

it.effect("replaces an active client without letting the old close tear down the session", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const principal = yield* authorize(harness.bridge);
    const first = new FakeSocket();
    harness.bridge.openAuthorizedSocket(first, principal);
    first.emit(openFrame());
    yield* harness.bridge.drain;

    const resumed = new FakeSocket();
    harness.bridge.openAuthorizedSocket(resumed, principal);
    resumed.emit(openFrame("session-1"));
    yield* harness.bridge.drain;
    expect(first.closes.at(-1)).toEqual({ code: 4009, reason: "inspector_reconnected" });
    first.disconnect();
    expect(harness.bridge.activeSessions()).toBe(1);
    expect(
      harness.workerCommands.some(
        (frame) => frame.type === "inspector.command" && frame.command.type === "inspector.close",
      ),
    ).toBe(false);
    harness.bridge.dispose();
  }),
);

it.effect("closes a slow client instead of accumulating unbounded frames", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ maxQueuedFrames: 1 });
    const principal = yield* authorize(harness.bridge);
    const socket = new FakeSocket();
    socket.holdSends = true;
    harness.bridge.openAuthorizedSocket(socket, principal);
    socket.emit(openFrame());
    yield* harness.bridge.drain;
    yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, readyFrame());
    yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, {
      ...readyFrame(),
      type: "inspector.ack",
      sequence: 1,
      requestId: "request-1" as never,
    });
    expect(socket.closes.at(-1)).toEqual({ code: 4413, reason: "slow_consumer" });
    socket.flush();
    harness.bridge.dispose();
  }),
);

it.effect("enforces per-workspace request admission before worker dispatch", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      limits: {
        maxInflightRequestsPerSession: 8,
        maxRequestsPerMinutePerSession: 8,
        maxRequestsPerMinutePerWorkspace: 1,
      },
    });
    const principal = yield* authorize(harness.bridge);
    const socket = new FakeSocket();
    harness.bridge.openAuthorizedSocket(socket, principal);
    socket.emit(openFrame());
    yield* harness.bridge.drain;
    for (const requestId of ["request-1", "request-2"]) {
      socket.emit({
        protocolVersion: 1,
        type: "inspector.request",
        sessionId: "session-1" as never,
        operation: { type: "capabilities.get", requestId: requestId as never },
      });
    }
    yield* harness.bridge.drain;
    expect(socket.closes.at(-1)).toEqual({ code: 4429, reason: "inspector_request_limit" });
    expect(
      harness.workerCommands.filter(
        (frame) => frame.type === "inspector.command" && frame.command.type === "inspector.request",
      ),
    ).toHaveLength(1);
    harness.bridge.dispose();
  }),
);

it.effect("enforces per-session request admission before worker dispatch", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      limits: {
        maxInflightRequestsPerSession: 8,
        maxRequestsPerMinutePerSession: 1,
        maxRequestsPerMinutePerWorkspace: 100,
      },
    });
    const principal = yield* authorize(harness.bridge);
    const socket = new FakeSocket();
    harness.bridge.openAuthorizedSocket(socket, principal);
    socket.emit(openFrame());
    yield* harness.bridge.drain;
    for (const requestId of ["session-rate-1", "session-rate-2"]) {
      socket.emit({
        protocolVersion: 1,
        type: "inspector.request",
        sessionId: "session-1" as never,
        operation: { type: "capabilities.get", requestId: requestId as never },
      });
    }
    yield* harness.bridge.drain;
    expect(socket.closes.at(-1)).toEqual({ code: 4429, reason: "inspector_request_limit" });
    expect(
      harness.workerCommands.filter(
        (frame) => frame.type === "inspector.command" && frame.command.type === "inspector.request",
      ),
    ).toHaveLength(1);
    harness.bridge.dispose();
  }),
);

it.effect("enforces the control-plane in-flight cap before worker dispatch", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      limits: {
        maxInflightRequestsPerSession: 1,
        maxRequestsPerMinutePerSession: 100,
        maxRequestsPerMinutePerWorkspace: 100,
      },
    });
    const principal = yield* authorize(harness.bridge);
    const socket = new FakeSocket();
    harness.bridge.openAuthorizedSocket(socket, principal);
    socket.emit(openFrame());
    yield* harness.bridge.drain;
    for (const requestId of ["inflight-1", "inflight-2"]) {
      socket.emit({
        protocolVersion: 1,
        type: "inspector.request",
        sessionId: "session-1" as never,
        operation: { type: "capabilities.get", requestId: requestId as never },
      });
    }
    yield* harness.bridge.drain;
    expect(socket.closes.at(-1)).toEqual({ code: 4429, reason: "inspector_request_limit" });
    expect(
      harness.workerCommands.filter(
        (frame) => frame.type === "inspector.command" && frame.command.type === "inspector.request",
      ),
    ).toHaveLength(1);
    harness.bridge.dispose();
  }),
);

it.effect("rejects artifact-count and byte churn before a second durable upload", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      limits: { maxArtifactsPerSession: 1, maxArtifactBytesPerSession: 3 },
    });
    const principal = yield* authorize(harness.bridge);
    const socket = new FakeSocket();
    harness.bridge.openAuthorizedSocket(socket, principal);
    socket.emit(openFrame());
    yield* harness.bridge.drain;
    yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, readyFrame());
    const artifactFrame = (sequence: number, artifactId: string): InspectorWorkerFrame => ({
      type: "inspector.artifact.proposed",
      binding: readyFrame().binding,
      sessionId: "session-1" as never,
      sequence,
      emittedAt: now,
      requestId: `capture-${sequence}` as never,
      artifact: {
        artifactId: artifactId as never,
        kind: "desktop-frame",
        mediaType: "image/png",
        byteLength: 3,
        sha256: "8f8cbb7dcf46e0bc7d53265749a6c17d116093a6ba95e442764060c76fd4a86c",
      },
      base64: Buffer.from("png").toString("base64"),
    });
    yield* harness.bridge.inspectorFrames.handleFrame(
      harness.active.lease,
      artifactFrame(1, "artifact-1"),
    );
    const second = yield* Effect.result(
      harness.bridge.inspectorFrames.handleFrame(
        harness.active.lease,
        artifactFrame(2, "artifact-2"),
      ),
    );
    expect(second._tag).toBe("Failure");
    expect(harness.uploads).toHaveLength(1);
    harness.bridge.dispose();
  }),
);

it.effect("accepts only exact-binding late frames from a bounded closed-session tombstone", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const principal = yield* authorize(harness.bridge);
    const socket = new FakeSocket();
    harness.bridge.openAuthorizedSocket(socket, principal);
    socket.emit(openFrame());
    yield* harness.bridge.drain;
    yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, readyFrame());
    harness.bridge.dispose();

    const exactLate: InspectorWorkerFrame = {
      ...readyFrame(),
      type: "inspector.ack",
      sequence: 1,
      requestId: "late-exact" as never,
    };
    expect(
      (yield* Effect.result(
        harness.bridge.inspectorFrames.handleFrame(harness.active.lease, exactLate),
      ))._tag,
    ).toBe("Success");

    for (const [route, forged] of [
      [harness.active.lease, { ...exactLate, sessionId: "session-unknown" as never }],
      [
        harness.active.lease,
        {
          ...exactLate,
          binding: { ...exactLate.binding, attemptId: "attempt-forged" as never },
        },
      ],
      [lease(2), exactLate],
    ] as const) {
      const result = yield* Effect.result(
        harness.bridge.inspectorFrames.handleFrame(route, forged),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.code).toBe("identityMismatch");
    }
  }),
);

it.effect("resets the sequence baseline explicitly when worker replay history was evicted", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const principal = yield* authorize(harness.bridge);
    const socket = new FakeSocket();
    harness.bridge.openAuthorizedSocket(socket, principal);
    socket.emit(openFrame());
    yield* harness.bridge.drain;
    yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, readyFrame());
    socket.disconnect();
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, {
        ...readyFrame(),
        type: "inspector.ack",
        sequence,
        requestId: `old-${sequence}` as never,
      });
    }

    const newerCommands: Array<WorkerRelayInbound> = [];
    const newer: ActiveWorkerRoute = {
      lease: lease(2),
      send: (frame) => {
        newerCommands.push(frame);
        return true;
      },
      close: () => undefined,
    };
    harness.routes.activate(newer);
    yield* harness.bridge.drain;
    expect(newerCommands[0]).toMatchObject({
      type: "inspector.command",
      command: { type: "inspector.open", resumeAfterSequence: 0 },
    });

    const binding = { ...readyFrame().binding, routeGeneration: 2 };
    const rejected = yield* Effect.result(
      harness.bridge.inspectorFrames.handleFrame(newer.lease, {
        type: "inspector.resume-rejected",
        binding,
        sessionId: "session-1" as never,
        emittedAt: now,
        requestedAfterSequence: 0,
        earliestAvailableSequence: 3,
        latestSequence: 5,
        reason: "history-evicted",
      }),
    );
    expect(rejected._tag).toBe("Success");
    const live = yield* Effect.result(
      harness.bridge.inspectorFrames.handleFrame(newer.lease, {
        ...readyFrame(2),
        type: "inspector.ack",
        sequence: 6,
        requestId: "after-gap" as never,
      }),
    );
    expect(live._tag).toBe("Success");
    expect(harness.bridge.activeSessions()).toBe(1);
    harness.bridge.dispose();
  }),
);

it.effect("keeps active terminal quotas across reconnect and releases them on retirement", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      limits: {
        maxActiveTerminalsPerSession: 1,
        maxActiveTerminalsPerWorkspace: 1,
        maxRequestsPerMinutePerSession: 100,
        maxRequestsPerMinutePerWorkspace: 100,
      },
    });
    const principal = yield* authorize(harness.bridge);
    const first = new FakeSocket();
    harness.bridge.openAuthorizedSocket(first, principal);
    first.emit(openFrame());
    yield* harness.bridge.drain;
    yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, readyFrame());
    first.emit({
      protocolVersion: 1,
      type: "inspector.request",
      sessionId: "session-1" as never,
      operation: {
        type: "terminal.open",
        requestId: "open-one" as never,
        terminalId: "terminal-one" as never,
        executable: "shell",
        columns: 80,
        rows: 24,
      },
    });
    yield* harness.bridge.drain;
    yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, {
      ...readyFrame(),
      type: "inspector.ack",
      sequence: 1,
      requestId: "open-one" as never,
    });
    yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, {
      ...readyFrame(),
      type: "inspector.complete",
      sequence: 2,
      requestId: "open-one" as never,
    });
    first.disconnect();

    const resumed = new FakeSocket();
    harness.bridge.openAuthorizedSocket(resumed, principal);
    resumed.emit({ ...openFrame("session-1"), resumeAfterSequence: 2 });
    yield* harness.bridge.drain;
    const beforeSecond = harness.workerCommands.length;
    resumed.emit({
      protocolVersion: 1,
      type: "inspector.request",
      sessionId: "session-1" as never,
      operation: {
        type: "terminal.open",
        requestId: "open-two-denied" as never,
        terminalId: "terminal-two" as never,
        executable: "shell",
        columns: 80,
        rows: 24,
      },
    });
    yield* harness.bridge.drain;
    expect(resumed.closes.at(-1)).toEqual({ code: 4429, reason: "inspector_request_limit" });
    expect(harness.workerCommands).toHaveLength(beforeSecond);

    const closer = new FakeSocket();
    harness.bridge.openAuthorizedSocket(closer, principal);
    closer.emit({ ...openFrame("session-1"), resumeAfterSequence: 2 });
    yield* harness.bridge.drain;
    closer.emit({
      protocolVersion: 1,
      type: "inspector.request",
      sessionId: "session-1" as never,
      operation: {
        type: "terminal.close",
        requestId: "close-one" as never,
        terminalId: "terminal-one" as never,
      },
    });
    yield* harness.bridge.drain;
    yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, {
      ...readyFrame(),
      type: "terminal.retired",
      sequence: 3,
      terminalId: "terminal-one" as never,
      reason: "killed",
    });
    yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, {
      ...readyFrame(),
      type: "inspector.ack",
      sequence: 4,
      requestId: "close-one" as never,
    });
    yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, {
      ...readyFrame(),
      type: "inspector.complete",
      sequence: 5,
      requestId: "close-one" as never,
    });
    const beforeAllowed = harness.workerCommands.length;
    closer.emit({
      protocolVersion: 1,
      type: "inspector.request",
      sessionId: "session-1" as never,
      operation: {
        type: "terminal.open",
        requestId: "open-two" as never,
        terminalId: "terminal-two" as never,
        executable: "shell",
        columns: 80,
        rows: 24,
      },
    });
    yield* harness.bridge.drain;
    expect(harness.workerCommands).toHaveLength(beforeAllowed + 1);
    harness.bridge.dispose();
  }),
);

it.effect("retains a cancelled terminal-open quota until the worker retires the PTY", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      limits: {
        maxActiveTerminalsPerSession: 1,
        maxActiveTerminalsPerWorkspace: 1,
        maxRequestsPerMinutePerSession: 100,
        maxRequestsPerMinutePerWorkspace: 100,
      },
    });
    const principal = yield* authorize(harness.bridge);
    const socket = new FakeSocket();
    harness.bridge.openAuthorizedSocket(socket, principal);
    socket.emit(openFrame());
    yield* harness.bridge.drain;
    yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, readyFrame());
    socket.emit({
      protocolVersion: 1,
      type: "inspector.request",
      sessionId: "session-1" as never,
      operation: {
        type: "terminal.open",
        requestId: "cancelled-open" as never,
        terminalId: "cancelled-terminal" as never,
        executable: "shell",
        columns: 80,
        rows: 24,
      },
    });
    yield* harness.bridge.drain;
    socket.emit({
      protocolVersion: 1,
      type: "inspector.cancel",
      sessionId: "session-1" as never,
      requestId: "cancelled-open" as never,
    });
    yield* harness.bridge.drain;
    socket.emit({
      protocolVersion: 1,
      type: "inspector.cancel",
      sessionId: "session-1" as never,
      requestId: "cancelled-open" as never,
    });
    yield* harness.bridge.drain;

    const beforeDenied = harness.workerCommands.length;
    socket.emit({
      protocolVersion: 1,
      type: "inspector.request",
      sessionId: "session-1" as never,
      operation: {
        type: "terminal.open",
        requestId: "bypass-before-outcome" as never,
        terminalId: "bypass-terminal" as never,
        executable: "shell",
        columns: 80,
        rows: 24,
      },
    });
    yield* harness.bridge.drain;
    expect(harness.workerCommands).toHaveLength(beforeDenied);

    yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, {
      ...readyFrame(),
      type: "inspector.ack",
      sequence: 1,
      requestId: "cancelled-open" as never,
    });
    const automaticClose = harness.workerCommands.findLast(
      (command) =>
        command.type === "inspector.command" &&
        command.command.type === "inspector.request" &&
        command.command.operation.type === "terminal.close" &&
        command.command.operation.terminalId === "cancelled-terminal",
    );
    expect(automaticClose).toBeDefined();
    if (
      automaticClose?.type !== "inspector.command" ||
      automaticClose.command.type !== "inspector.request" ||
      automaticClose.command.operation.type !== "terminal.close"
    ) {
      return;
    }
    const automaticCloseRequestId = automaticClose.command.operation.requestId;
    yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, {
      ...readyFrame(),
      type: "inspector.complete",
      sequence: 2,
      requestId: "cancelled-open" as never,
    });
    yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, {
      ...readyFrame(),
      type: "terminal.retired",
      sequence: 3,
      terminalId: "cancelled-terminal" as never,
      reason: "exited",
    });
    yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, {
      ...readyFrame(),
      type: "inspector.ack",
      sequence: 4,
      requestId: automaticCloseRequestId,
    });
    yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, {
      ...readyFrame(),
      type: "inspector.complete",
      sequence: 5,
      requestId: automaticCloseRequestId,
    });

    const resumed = new FakeSocket();
    harness.bridge.openAuthorizedSocket(resumed, principal);
    resumed.emit({ ...openFrame("session-1"), resumeAfterSequence: 0 });
    yield* harness.bridge.drain;
    for (const frame of [
      { ...readyFrame(), type: "inspector.ack" as const, sequence: 1, requestId: "cancelled-open" },
      {
        ...readyFrame(),
        type: "inspector.complete" as const,
        sequence: 2,
        requestId: "cancelled-open",
      },
      {
        ...readyFrame(),
        type: "terminal.retired" as const,
        sequence: 3,
        terminalId: "cancelled-terminal",
        reason: "exited" as const,
      },
      {
        ...readyFrame(),
        type: "inspector.ack" as const,
        sequence: 4,
        requestId: automaticCloseRequestId,
      },
      {
        ...readyFrame(),
        type: "inspector.complete" as const,
        sequence: 5,
        requestId: automaticCloseRequestId,
      },
      { ...readyFrame(), sequence: 6 },
    ]) {
      yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, frame as never);
    }
    const beforeReplacement = harness.workerCommands.length;
    resumed.emit({
      protocolVersion: 1,
      type: "inspector.request",
      sessionId: "session-1" as never,
      operation: {
        type: "terminal.open",
        requestId: "replacement-open" as never,
        terminalId: "replacement-terminal" as never,
        executable: "shell",
        columns: 80,
        rows: 24,
      },
    });
    yield* harness.bridge.drain;
    expect(harness.workerCommands).toHaveLength(beforeReplacement + 1);
    expect(harness.bridge.activeSessions()).toBe(1);
    harness.bridge.dispose();
  }),
);

it.effect("releases a failed ACK terminal exactly once when its history reconnects", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      limits: {
        maxActiveTerminalsPerSession: 1,
        maxActiveTerminalsPerWorkspace: 1,
        maxRequestsPerMinutePerSession: 100,
        maxRequestsPerMinutePerWorkspace: 100,
      },
    });
    const principal = yield* authorize(harness.bridge);
    const first = new FakeSocket();
    harness.bridge.openAuthorizedSocket(first, principal);
    first.emit(openFrame());
    yield* harness.bridge.drain;
    yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, readyFrame());
    first.emit({
      protocolVersion: 1,
      type: "inspector.request",
      sessionId: "session-1" as never,
      operation: {
        type: "terminal.open",
        requestId: "failed-ack-open" as never,
        terminalId: "failed-ack-terminal" as never,
        executable: "shell",
        columns: 80,
        rows: 24,
      },
    });
    yield* harness.bridge.drain;
    first.disconnect();

    const replay = [
      {
        ...readyFrame(),
        type: "inspector.ack" as const,
        sequence: 1,
        requestId: "failed-ack-open",
      },
      {
        ...readyFrame(),
        type: "terminal.retired" as const,
        sequence: 2,
        terminalId: "failed-ack-terminal",
        reason: "killed" as const,
      },
      {
        ...readyFrame(),
        type: "inspector.error" as const,
        sequence: 3,
        requestId: "failed-ack-open",
        code: "internal" as const,
        retryable: true,
        detail: "Inspector operation failed",
      },
      { ...readyFrame(), sequence: 4 },
    ];
    const resumed = new FakeSocket();
    harness.bridge.openAuthorizedSocket(resumed, principal);
    resumed.emit({ ...openFrame("session-1"), resumeAfterSequence: 0 });
    yield* harness.bridge.drain;
    for (const frame of replay) {
      yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, frame as never);
    }
    const beforeReplacement = harness.workerCommands.length;
    resumed.emit({
      protocolVersion: 1,
      type: "inspector.request",
      sessionId: "session-1" as never,
      operation: {
        type: "terminal.open",
        requestId: "replacement-after-failed-ack" as never,
        terminalId: "replacement-terminal" as never,
        executable: "shell",
        columns: 80,
        rows: 24,
      },
    });
    yield* harness.bridge.drain;
    expect(harness.workerCommands).toHaveLength(beforeReplacement + 1);
    resumed.disconnect();

    const replayedAgain = new FakeSocket();
    harness.bridge.openAuthorizedSocket(replayedAgain, principal);
    replayedAgain.emit({ ...openFrame("session-1"), resumeAfterSequence: 0 });
    yield* harness.bridge.drain;
    for (const frame of replay) {
      yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, frame as never);
    }
    const beforeDenied = harness.workerCommands.length;
    replayedAgain.emit({
      protocolVersion: 1,
      type: "inspector.request",
      sessionId: "session-1" as never,
      operation: {
        type: "terminal.open",
        requestId: "quota-bypass-after-replay" as never,
        terminalId: "quota-bypass-terminal" as never,
        executable: "shell",
        columns: 80,
        rows: 24,
      },
    });
    yield* harness.bridge.drain;
    expect(harness.workerCommands).toHaveLength(beforeDenied);
    expect(replayedAgain.closes.at(-1)).toEqual({
      code: 4429,
      reason: "inspector_request_limit",
    });
    harness.bridge.dispose();
  }),
);

it.effect("releases terminal quota on a connected natural exit", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      limits: {
        maxActiveTerminalsPerSession: 1,
        maxActiveTerminalsPerWorkspace: 1,
        maxRequestsPerMinutePerSession: 100,
        maxRequestsPerMinutePerWorkspace: 100,
      },
    });
    const principal = yield* authorize(harness.bridge);
    const socket = new FakeSocket();
    harness.bridge.openAuthorizedSocket(socket, principal);
    socket.emit(openFrame());
    yield* harness.bridge.drain;
    yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, readyFrame());
    socket.emit({
      protocolVersion: 1,
      type: "inspector.request",
      sessionId: "session-1" as never,
      operation: {
        type: "terminal.open",
        requestId: "open-natural-one" as never,
        terminalId: "terminal-natural-one" as never,
        executable: "shell",
        columns: 80,
        rows: 24,
      },
    });
    yield* harness.bridge.drain;
    for (const frame of [
      {
        ...readyFrame(),
        type: "inspector.ack" as const,
        sequence: 1,
        requestId: "open-natural-one" as never,
      },
      {
        ...readyFrame(),
        type: "inspector.complete" as const,
        sequence: 2,
        requestId: "open-natural-one" as never,
      },
      {
        ...readyFrame(),
        type: "terminal.retired" as const,
        sequence: 3,
        terminalId: "terminal-natural-one" as never,
        reason: "exited" as const,
      },
    ]) {
      yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, frame);
    }
    expect(
      socket.sent.some(
        (frame) => frame.type === "inspector.data" && frame.payload.type === "terminal.retired",
      ),
    ).toBe(true);
    const before = harness.workerCommands.length;
    socket.emit({
      protocolVersion: 1,
      type: "inspector.request",
      sessionId: "session-1" as never,
      operation: {
        type: "terminal.open",
        requestId: "open-natural-two" as never,
        terminalId: "terminal-natural-two" as never,
        executable: "shell",
        columns: 80,
        rows: 24,
      },
    });
    yield* harness.bridge.drain;
    expect(harness.workerCommands).toHaveLength(before + 1);
    harness.bridge.dispose();
  }),
);

it.effect("idempotently releases a disconnected terminal exit when it replays", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      limits: {
        maxActiveTerminalsPerSession: 1,
        maxActiveTerminalsPerWorkspace: 1,
        maxRequestsPerMinutePerSession: 100,
        maxRequestsPerMinutePerWorkspace: 100,
      },
    });
    const principal = yield* authorize(harness.bridge);
    const first = new FakeSocket();
    harness.bridge.openAuthorizedSocket(first, principal);
    first.emit(openFrame());
    yield* harness.bridge.drain;
    yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, readyFrame());
    first.emit({
      protocolVersion: 1,
      type: "inspector.request",
      sessionId: "session-1" as never,
      operation: {
        type: "terminal.open",
        requestId: "open-replayed-one" as never,
        terminalId: "terminal-replayed-one" as never,
        executable: "shell",
        columns: 80,
        rows: 24,
      },
    });
    yield* harness.bridge.drain;
    yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, {
      ...readyFrame(),
      type: "inspector.ack",
      sequence: 1,
      requestId: "open-replayed-one" as never,
    });
    yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, {
      ...readyFrame(),
      type: "inspector.complete",
      sequence: 2,
      requestId: "open-replayed-one" as never,
    });
    first.disconnect();
    const retired: InspectorWorkerFrame = {
      ...readyFrame(),
      type: "terminal.retired",
      sequence: 3,
      terminalId: "terminal-replayed-one" as never,
      reason: "exited",
    };
    yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, retired);

    const resumed = new FakeSocket();
    harness.bridge.openAuthorizedSocket(resumed, principal);
    resumed.emit({ ...openFrame("session-1"), resumeAfterSequence: 2 });
    yield* harness.bridge.drain;
    yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, retired);
    yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, {
      ...retired,
      sequence: 4,
    });
    expect(
      resumed.sent.filter(
        (frame) => frame.type === "inspector.data" && frame.payload.type === "terminal.retired",
      ),
    ).toHaveLength(2);
    const before = harness.workerCommands.length;
    resumed.emit({
      protocolVersion: 1,
      type: "inspector.request",
      sessionId: "session-1" as never,
      operation: {
        type: "terminal.open",
        requestId: "open-replayed-two" as never,
        terminalId: "terminal-replayed-two" as never,
        executable: "shell",
        columns: 80,
        rows: 24,
      },
    });
    yield* harness.bridge.drain;
    expect(harness.workerCommands).toHaveLength(before + 1);
    harness.bridge.dispose();
  }),
);

it.effect("releases terminal quota when a replacement route tears down the session", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      limits: {
        maxActiveTerminalsPerSession: 1,
        maxActiveTerminalsPerWorkspace: 1,
        maxRequestsPerMinutePerSession: 100,
        maxRequestsPerMinutePerWorkspace: 100,
      },
    });
    const principal = yield* authorize(harness.bridge);
    const first = new FakeSocket();
    harness.bridge.openAuthorizedSocket(first, principal);
    first.emit(openFrame());
    yield* harness.bridge.drain;
    yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, readyFrame());
    first.emit({
      protocolVersion: 1,
      type: "inspector.request",
      sessionId: "session-1" as never,
      operation: {
        type: "terminal.open",
        requestId: "open-before-replacement" as never,
        terminalId: "terminal-before-replacement" as never,
        executable: "shell",
        columns: 80,
        rows: 24,
      },
    });
    yield* harness.bridge.drain;
    yield* harness.bridge.inspectorFrames.handleFrame(harness.active.lease, {
      ...readyFrame(),
      type: "inspector.ack",
      sequence: 1,
      requestId: "open-before-replacement" as never,
    });

    harness.routes.activate({
      lease: { ...lease(2), workerId: "worker-replaced" as never },
      send: () => true,
      close: () => undefined,
    });
    yield* harness.bridge.drain;
    expect(harness.bridge.activeSessions()).toBe(0);

    const replacementCommands: Array<WorkerRelayInbound> = [];
    const replacement: ActiveWorkerRoute = {
      lease: lease(3),
      send: (frame) => {
        replacementCommands.push(frame);
        return true;
      },
      close: () => undefined,
    };
    harness.routes.activate(replacement);
    const secondPrincipal = yield* authorize(harness.bridge);
    const second = new FakeSocket();
    harness.bridge.openAuthorizedSocket(second, secondPrincipal);
    second.emit(openFrame());
    yield* harness.bridge.drain;
    yield* harness.bridge.inspectorFrames.handleFrame(replacement.lease, readyFrame(3));
    const before = replacementCommands.length;
    second.emit({
      protocolVersion: 1,
      type: "inspector.request",
      sessionId: "session-1" as never,
      operation: {
        type: "terminal.open",
        requestId: "open-after-replacement" as never,
        terminalId: "terminal-after-replacement" as never,
        executable: "shell",
        columns: 80,
        rows: 24,
      },
    });
    yield* harness.bridge.drain;
    expect(replacementCommands).toHaveLength(before + 1);
    harness.bridge.dispose();
  }),
);
