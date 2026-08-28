import type { DesktopControllerState } from "@t3tools/contracts/desktop-lease";
import type {
  InspectorCapabilities,
  InspectorRouteBinding,
  InspectorServerFrame,
} from "@t3tools/contracts/inspector";
import { describe, expect, it } from "vite-plus/test";

import {
  makeLiveDesktopClient,
  type LiveDesktopScheduler,
  type LiveDesktopSocket,
} from "./liveDesktopClient.ts";

class TestSocket implements LiveDesktopSocket {
  readonly sent: string[] = [];
  readonly closes: Array<{ readonly code?: number; readonly reason?: string }> = [];
  readonly #open = new Set<() => void>();
  readonly #message = new Set<(payload: string) => void>();
  readonly #close = new Set<(event: { readonly code: number }) => void>();

  send(payload: string) {
    this.sent.push(payload);
  }
  close(code?: number, reason?: string) {
    this.closes.push({ ...(code === undefined ? {} : { code }), ...(reason ? { reason } : {}) });
  }
  onOpen(listener: () => void) {
    this.#open.add(listener);
    return () => this.#open.delete(listener);
  }
  onMessage(listener: (payload: string) => void) {
    this.#message.add(listener);
    return () => this.#message.delete(listener);
  }
  onClose(listener: (event: { readonly code: number }) => void) {
    this.#close.add(listener);
    return () => this.#close.delete(listener);
  }
  open() {
    for (const listener of this.#open) listener();
  }
  message(frame: InspectorServerFrame) {
    for (const listener of this.#message) listener(JSON.stringify(frame));
  }
  disconnect(code = 1006) {
    this.#close.forEach((listener) => listener({ code }));
  }
}

class TestScheduler implements LiveDesktopScheduler {
  readonly #tasks = new Map<number, () => void>();
  #next = 0;

  schedule(callback: () => void) {
    const id = ++this.#next;
    this.#tasks.set(id, callback);
    return id;
  }
  cancel(handle: unknown) {
    this.#tasks.delete(handle as number);
  }
  runNext() {
    const next = [...this.#tasks.entries()].sort(([left], [right]) => left - right)[0];
    if (next === undefined) throw new Error("No scheduled task");
    this.#tasks.delete(next[0]);
    next[1]();
  }
}

const binding = {
  protocolVersion: 1,
  workspaceId: "workspace-1",
  threadId: "thread-1",
  attemptId: "attempt-1",
  environmentId: "environment-1",
  environmentRevisionId: "revision-1",
  providerInstanceId: "codex_default",
  providerDriver: "codex",
  sandboxId: "sandbox-1",
  workerId: "worker-1",
  routeGeneration: 1,
} as InspectorRouteBinding;

const controlBinding = {
  workspaceId: binding.workspaceId,
  threadId: binding.threadId,
  attemptId: binding.attemptId,
  environmentId: binding.environmentId,
  environmentRevisionId: binding.environmentRevisionId,
  sandboxId: binding.sandboxId,
  workerId: binding.workerId,
  routeGeneration: binding.routeGeneration,
};

const capabilities: InspectorCapabilities = {
  terminal: true,
  files: true,
  ports: false,
  browserFrames: false,
  browserInput: false,
  desktopFrames: true,
  desktopInput: true,
  desktopBackend: "injected",
};

const agentState = (observedAt = "2026-08-27T12:00:00.000Z"): DesktopControllerState => ({
  controller: "agent",
  observedAt,
});

const leaseState = (
  controller: "user" | "disconnected",
  options: {
    readonly held?: boolean;
    readonly resumable?: boolean;
    readonly generation?: number;
  } = {},
): DesktopControllerState =>
  ({
    controller,
    lease: {
      leaseId: "lease-1" as never,
      generation: (options.generation ?? 1) as never,
      binding: controlBinding,
      expiresAt: "2026-08-27T12:01:00.000Z",
    },
    ...(controller === "user"
      ? { heldByCurrentClient: options.held ?? false }
      : { resumableByCurrentSession: options.resumable ?? false }),
    observedAt: "2026-08-27T12:00:00.000Z",
  }) as DesktopControllerState;

const opened = (
  sequence: number,
  resumedThroughSequence: number,
): Extract<InspectorServerFrame, { readonly type: "inspector.opened" }> => ({
  protocolVersion: 1,
  type: "inspector.opened",
  binding,
  sessionId: "session-1" as never,
  sequence,
  resumedThroughSequence,
  capabilities,
});

const control = (
  requestId: string,
  state: DesktopControllerState,
  resumeToken?: string,
): InspectorServerFrame => ({
  protocolVersion: 1,
  type: "desktop.control.state",
  requestId: requestId as never,
  state,
  ...(resumeToken === undefined ? {} : { resumeToken: resumeToken as never }),
});

const frames = (socket: TestSocket) =>
  socket.sent.map((entry) => JSON.parse(entry) as Record<string, unknown>);

const lastFrame = (socket: TestSocket, type: string) =>
  frames(socket).findLast((frame) => frame.type === type);

function setup() {
  const sockets: TestSocket[] = [];
  const scheduler = new TestScheduler();
  let id = 0;
  const client = makeLiveDesktopClient({
    threadId: "thread-1" as never,
    attemptId: "attempt-1" as never,
    createSocket: () => {
      const socket = new TestSocket();
      sockets.push(socket);
      return socket;
    },
    artifactUrl: (artifact) => `https://cloud.test/artifacts/${artifact.artifactId}`,
    nextId: () => `id-${++id}`,
    scheduler,
    now: () => Date.parse("2026-08-27T12:00:00.000Z"),
    reconnectDelayMs: () => 1,
  });
  client.connect();
  sockets[0]!.open();
  sockets[0]!.message(opened(0, -1));
  return { client, scheduler, sockets };
}

describe("live desktop inspector client", () => {
  it("renders authenticated artifacts and only sends input for this socket's lease", () => {
    const { client, sockets } = setup();
    const socket = sockets[0]!;
    const get = lastFrame(socket, "desktop.control.get")!;
    socket.message(control(get.requestId as string, agentState()));

    client.takeControl();
    const acquire = lastFrame(socket, "desktop.control.acquire")!;
    socket.message(
      control(acquire.requestId as string, leaseState("user", { held: true }), "a".repeat(43)),
    );

    expect(client.getSnapshot().controller).toMatchObject({
      controller: "user",
      heldByCurrentClient: true,
    });
    expect(
      client.sendInput({
        type: "key",
        key: "a",
        code: "KeyA",
        action: "down",
        modifiers: [],
      }),
    ).toBe(true);
    expect(lastFrame(socket, "inspector.request")?.operation).toMatchObject({
      type: "desktop.input",
    });

    const artifact = {
      artifactId: "artifact-1" as never,
      kind: "desktop-frame" as const,
      mediaType: "image/webp",
      byteLength: 512,
      sha256: "a".repeat(64),
    };
    socket.message({
      protocolVersion: 1,
      type: "inspector.data",
      binding,
      sessionId: "session-1" as never,
      sequence: 1,
      payload: {
        type: "artifact",
        requestId: "desktop-start" as never,
        artifact,
      },
    });
    expect(client.getSnapshot().frameUrl).toBe("https://cloud.test/artifacts/artifact-1");

    client.dispose();
    expect(lastFrame(socket, "desktop.control.release")).toMatchObject({
      leaseId: "lease-1",
      generation: 1,
    });
  });

  it("replays lost acquire and resume responses exactly before rotating the proof", () => {
    const { client, scheduler, sockets } = setup();
    const first = sockets[0]!;
    const get = lastFrame(first, "desktop.control.get")!;
    first.message(control(get.requestId as string, agentState()));
    client.takeControl();
    const acquire = lastFrame(first, "desktop.control.acquire")!;

    first.disconnect();
    scheduler.runNext();
    const second = sockets[1]!;
    second.open();
    expect(lastFrame(second, "inspector.open")).toMatchObject({
      sessionId: "session-1",
      resumeAfterSequence: 0,
    });
    second.message(opened(1, 0));
    expect(lastFrame(second, "desktop.control.acquire")).toEqual(acquire);

    second.message(
      control(
        acquire.requestId as string,
        leaseState("disconnected", { resumable: true }),
        "a".repeat(43),
      ),
    );
    const firstResume = lastFrame(second, "desktop.control.resume")!;
    expect(firstResume).toMatchObject({ resumeToken: "a".repeat(43) });

    second.disconnect();
    scheduler.runNext();
    const third = sockets[2]!;
    third.open();
    third.message(opened(2, 1));
    expect(lastFrame(third, "desktop.control.resume")).toEqual(firstResume);

    third.message(
      control(
        firstResume.requestId as string,
        leaseState("disconnected", { resumable: true, generation: 2 }),
        "b".repeat(43),
      ),
    );
    const handoff = lastFrame(third, "desktop.control.resume")!;
    expect(handoff.requestId).not.toBe(firstResume.requestId);
    expect(handoff).toMatchObject({ generation: 2, resumeToken: "b".repeat(43) });

    third.message(
      control(
        handoff.requestId as string,
        leaseState("user", { held: true, generation: 3 }),
        "c".repeat(43),
      ),
    );
    expect(client.getSnapshot()).toMatchObject({
      phase: "connected",
      controller: { controller: "user", heldByCurrentClient: true },
      pendingAction: null,
    });
  });

  it("recovers a lost release response before releasing from the current socket", () => {
    const { client, scheduler, sockets } = setup();
    const first = sockets[0]!;
    const get = lastFrame(first, "desktop.control.get")!;
    first.message(control(get.requestId as string, agentState()));
    client.takeControl();
    const acquire = lastFrame(first, "desktop.control.acquire")!;
    first.message(
      control(acquire.requestId as string, leaseState("user", { held: true }), "a".repeat(43)),
    );

    client.releaseControl();
    const staleRelease = lastFrame(first, "desktop.control.release")!;
    first.disconnect();
    scheduler.runNext();

    const second = sockets[1]!;
    second.open();
    second.message(opened(1, 0));
    expect(lastFrame(second, "desktop.control.release")).toBeUndefined();
    const recoveredCurrent = lastFrame(second, "desktop.control.get")!;
    second.message(
      control(
        recoveredCurrent.requestId as string,
        leaseState("disconnected", { resumable: true }),
        "b".repeat(43),
      ),
    );
    const handoff = lastFrame(second, "desktop.control.resume")!;
    second.message(
      control(
        handoff.requestId as string,
        leaseState("user", { held: true, generation: 2 }),
        "c".repeat(43),
      ),
    );

    const currentRelease = lastFrame(second, "desktop.control.release")!;
    expect(currentRelease.requestId).not.toBe(staleRelease.requestId);
    expect(currentRelease).toMatchObject({ generation: 2, leaseId: "lease-1" });
    second.message(control(currentRelease.requestId as string, agentState()));
    expect(client.getSnapshot()).toMatchObject({
      controller: { controller: "agent" },
      pendingAction: null,
    });
  });

  it("fails closed for a foreign holder and a mismatched stream binding", () => {
    const { client, sockets } = setup();
    const socket = sockets[0]!;
    const get = lastFrame(socket, "desktop.control.get")!;
    socket.message(control(get.requestId as string, leaseState("user", { held: false })));

    expect(
      client.sendInput({
        type: "pointer",
        action: "down",
        x: 10,
        y: 10,
        button: "left",
      }),
    ).toBe(false);
    client.takeControl();
    expect(frames(socket).filter((frame) => frame.type === "desktop.control.acquire")).toHaveLength(
      0,
    );

    socket.message({
      protocolVersion: 1,
      type: "inspector.data",
      binding: { ...binding, routeGeneration: 2 },
      sessionId: "session-1" as never,
      sequence: 1,
      payload: { type: "complete", requestId: "request-1" as never },
    });
    expect(client.getSnapshot()).toMatchObject({
      phase: "error",
      message: "The cloud desktop stream became inconsistent.",
    });
  });

  it("reports a fail-closed unsupported desktop without starting a fake stream", () => {
    const sockets: TestSocket[] = [];
    const client = makeLiveDesktopClient({
      threadId: "thread-1" as never,
      attemptId: "attempt-1" as never,
      createSocket: () => {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
      artifactUrl: () => "unused",
      nextId: () => "id-1",
      scheduler: new TestScheduler(),
      now: () => 0,
    });
    client.connect();
    sockets[0]!.open();
    sockets[0]!.message({
      ...opened(0, -1),
      capabilities: {
        ...capabilities,
        desktopFrames: false,
        desktopInput: false,
        desktopBackend: "unsupported",
      },
    });

    expect(client.getSnapshot()).toMatchObject({
      phase: "unsupported",
      frameUrl: null,
    });
    expect(
      frames(sockets[0]!).some(
        (frame) =>
          frame.type === "inspector.request" &&
          (frame.operation as Record<string, unknown> | undefined)?.type === "desktop.start",
      ),
    ).toBe(false);
  });
});
