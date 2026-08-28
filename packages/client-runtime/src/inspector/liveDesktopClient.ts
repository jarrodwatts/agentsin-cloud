import type { CommandId, ThreadId } from "@t3tools/contracts";
import type { DesktopControllerState } from "@t3tools/contracts/desktop-lease";
import {
  DESKTOP_CONTROL_PROTOCOL_VERSION,
  type DesktopControlClientFrame,
  type DesktopLeaseIdempotencyKey,
  type DesktopLeaseResumeToken,
} from "@t3tools/contracts/desktop-lease";
import {
  INSPECTOR_PROTOCOL_VERSION,
  InspectorServerFrame,
  type InspectorArtifactReference,
  type InspectorAttemptId,
  type InspectorCapabilities,
  type InspectorClientFrame,
  type InspectorInputEvent,
  type InspectorRequestId,
  type InspectorRouteBinding,
  type InspectorSessionId,
} from "@t3tools/contracts/inspector";
import * as Schema from "effect/Schema";

const decodeServerFrame = Schema.decodeUnknownSync(Schema.fromJsonString(InspectorServerFrame));

export type LiveDesktopConnectionPhase =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "unsupported"
  | "error";

export type LiveDesktopPendingAction = "take-control" | "resume" | "release" | null;

export interface LiveDesktopSnapshot {
  readonly phase: LiveDesktopConnectionPhase;
  readonly capabilities: InspectorCapabilities | null;
  readonly controller: DesktopControllerState | null;
  readonly frameUrl: string | null;
  readonly frameMediaType: string | null;
  readonly pendingAction: LiveDesktopPendingAction;
  readonly message: string | null;
}

export interface LiveDesktopSocket {
  readonly send: (payload: string) => void;
  readonly close: (code?: number, reason?: string) => void;
  readonly onOpen: (listener: () => void) => () => void;
  readonly onMessage: (listener: (payload: string) => void) => () => void;
  readonly onClose: (listener: (event: { readonly code: number }) => void) => () => void;
}

export interface LiveDesktopScheduler {
  readonly schedule: (callback: () => void, delayMs: number) => unknown;
  readonly cancel: (handle: unknown) => void;
}

export interface LiveDesktopClientOptions {
  readonly threadId: ThreadId;
  readonly attemptId: InspectorAttemptId;
  readonly createSocket: () => LiveDesktopSocket;
  readonly artifactUrl: (artifact: InspectorArtifactReference) => string;
  readonly nextId: () => string;
  readonly scheduler: LiveDesktopScheduler;
  readonly now: () => number;
  readonly captureIntervalMs?: number;
  readonly reconnectDelayMs?: (attempt: number) => number;
}

export interface LiveDesktopClient {
  readonly getSnapshot: () => LiveDesktopSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly connect: () => void;
  readonly retry: () => void;
  readonly takeControl: () => void;
  readonly resumeControl: () => void;
  readonly releaseControl: () => void;
  readonly sendInput: (input: InspectorInputEvent) => boolean;
  readonly dispose: () => void;
}

const initialSnapshot: LiveDesktopSnapshot = {
  phase: "idle",
  capabilities: null,
  controller: null,
  frameUrl: null,
  frameMediaType: null,
  pendingAction: null,
  message: null,
};

const sameBinding = (left: InspectorRouteBinding, right: InspectorRouteBinding): boolean =>
  left.protocolVersion === right.protocolVersion &&
  left.workspaceId === right.workspaceId &&
  left.threadId === right.threadId &&
  left.attemptId === right.attemptId &&
  left.environmentId === right.environmentId &&
  left.environmentRevisionId === right.environmentRevisionId &&
  left.providerInstanceId === right.providerInstanceId &&
  left.providerDriver === right.providerDriver &&
  left.sandboxId === right.sandboxId &&
  left.workerId === right.workerId &&
  left.routeGeneration === right.routeGeneration;

const controllerBindingMatches = (
  state: DesktopControllerState,
  binding: InspectorRouteBinding,
): boolean => {
  if (state.controller === "agent") return true;
  const controlled = state.lease.binding;
  return (
    controlled.workspaceId === binding.workspaceId &&
    controlled.threadId === binding.threadId &&
    controlled.attemptId === binding.attemptId &&
    controlled.environmentId === binding.environmentId &&
    controlled.environmentRevisionId === binding.environmentRevisionId &&
    controlled.sandboxId === binding.sandboxId &&
    controlled.workerId === binding.workerId &&
    controlled.routeGeneration === binding.routeGeneration
  );
};

type ControlPurpose = "get" | "take-control" | "heartbeat" | "resume" | "release";

interface PendingControl {
  readonly purpose: ControlPurpose;
  readonly frame: DesktopControlClientFrame;
}

const pendingPresentation = (purpose: ControlPurpose): LiveDesktopPendingAction => {
  switch (purpose) {
    case "take-control":
      return "take-control";
    case "resume":
      return "resume";
    case "release":
      return "release";
    default:
      return null;
  }
};

/**
 * Maintains the resumable inspector cursor and the one in-flight desktop lease
 * mutation. The exact control frame is retained across a lost response, which
 * is required by the server's idempotent acquire/resume protocol.
 */
export function makeLiveDesktopClient(options: LiveDesktopClientOptions): LiveDesktopClient {
  const captureIntervalMs = Math.max(250, options.captureIntervalMs ?? 1_000);
  const reconnectDelayMs =
    options.reconnectDelayMs ?? ((attempt: number) => Math.min(5_000, 250 * 2 ** attempt));
  const listeners = new Set<() => void>();
  const requestKinds = new Map<InspectorRequestId, "start" | "capture" | "input">();

  let snapshot = initialSnapshot;
  let socket: LiveDesktopSocket | null = null;
  let socketCleanup: (() => void) | null = null;
  let socketEpoch = 0;
  let disposed = false;
  let intentionallyClosing = false;
  let sessionId: InspectorSessionId | null = null;
  let binding: InspectorRouteBinding | null = null;
  let resumeAfterSequence = -1;
  let opened = false;
  let desktopStarted = false;
  let reconnectAttempt = 0;
  let reconnectHandle: unknown = null;
  let captureHandle: unknown = null;
  let heartbeatHandle: unknown = null;
  let pendingControl: PendingControl | null = null;
  let resumeToken: DesktopLeaseResumeToken | null = null;
  let releaseAfterRecovery = false;

  const publish = (patch: Partial<LiveDesktopSnapshot>) => {
    const next = { ...snapshot, ...patch };
    if (
      next.phase === snapshot.phase &&
      next.capabilities === snapshot.capabilities &&
      next.controller === snapshot.controller &&
      next.frameUrl === snapshot.frameUrl &&
      next.frameMediaType === snapshot.frameMediaType &&
      next.pendingAction === snapshot.pendingAction &&
      next.message === snapshot.message
    ) {
      return;
    }
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const clearHandle = (kind: "reconnect" | "capture" | "heartbeat") => {
    const handle =
      kind === "reconnect" ? reconnectHandle : kind === "capture" ? captureHandle : heartbeatHandle;
    if (handle !== null) options.scheduler.cancel(handle);
    if (kind === "reconnect") reconnectHandle = null;
    else if (kind === "capture") captureHandle = null;
    else heartbeatHandle = null;
  };

  const nextRequestId = () => options.nextId() as InspectorRequestId;
  const nextCommandId = () => options.nextId() as CommandId;
  const nextIdempotencyKey = () => options.nextId() as DesktopLeaseIdempotencyKey;

  const send = (frame: InspectorClientFrame): boolean => {
    if (socket === null || !opened) return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  };

  const sendControl = (pending: PendingControl): boolean => send(pending.frame);

  const startControl = (purpose: ControlPurpose, frame: DesktopControlClientFrame): boolean => {
    if (pendingControl !== null || !opened) return false;
    pendingControl = { purpose, frame };
    publish({ pendingAction: pendingPresentation(purpose), message: null });
    if (sendControl(pendingControl)) return true;
    return false;
  };

  const beginGet = () => {
    if (pendingControl !== null || !opened) return;
    startControl("get", {
      protocolVersion: DESKTOP_CONTROL_PROTOCOL_VERSION,
      type: "desktop.control.get",
      requestId: nextCommandId(),
    });
  };

  const beginResume = (token: DesktopLeaseResumeToken) => {
    const controller = snapshot.controller;
    if (
      pendingControl !== null ||
      controller === null ||
      controller.controller !== "disconnected" ||
      !controller.resumableByCurrentSession
    ) {
      return;
    }
    startControl("resume", {
      protocolVersion: DESKTOP_CONTROL_PROTOCOL_VERSION,
      type: "desktop.control.resume",
      requestId: nextCommandId(),
      leaseId: controller.lease.leaseId,
      generation: controller.lease.generation,
      resumeToken: token,
      idempotencyKey: nextIdempotencyKey(),
    });
  };

  const scheduleHeartbeat = () => {
    clearHandle("heartbeat");
    const controller = snapshot.controller;
    if (
      disposed ||
      controller?.controller !== "user" ||
      !controller.heldByCurrentClient ||
      pendingControl !== null
    ) {
      return;
    }
    const remaining = Date.parse(controller.lease.expiresAt) - options.now();
    const delay = Math.max(1_000, Math.min(10_000, Math.floor(remaining / 3)));
    heartbeatHandle = options.scheduler.schedule(() => {
      heartbeatHandle = null;
      const current = snapshot.controller;
      if (current?.controller !== "user" || !current.heldByCurrentClient) return;
      startControl("heartbeat", {
        protocolVersion: DESKTOP_CONTROL_PROTOCOL_VERSION,
        type: "desktop.control.heartbeat",
        requestId: nextCommandId(),
        leaseId: current.lease.leaseId,
        generation: current.lease.generation,
        idempotencyKey: nextIdempotencyKey(),
      });
    }, delay);
  };

  const requestDesktop = (kind: "start" | "capture") => {
    if (!opened || snapshot.capabilities?.desktopFrames !== true) return false;
    if ([...requestKinds.values()].some((value) => value === "start" || value === "capture")) {
      return false;
    }
    const requestId = nextRequestId();
    const operation =
      kind === "start"
        ? ({
            requestId,
            type: "desktop.start",
            width: 1_440,
            height: 1_024,
          } as const)
        : ({ requestId, type: "desktop.capture" } as const);
    requestKinds.set(requestId, kind);
    if (
      send({
        protocolVersion: INSPECTOR_PROTOCOL_VERSION,
        type: "inspector.request",
        sessionId: sessionId!,
        operation,
      })
    ) {
      return true;
    }
    requestKinds.delete(requestId);
    return false;
  };

  const scheduleCapture = () => {
    clearHandle("capture");
    if (disposed || snapshot.capabilities?.desktopFrames !== true) return;
    captureHandle = options.scheduler.schedule(() => {
      captureHandle = null;
      requestDesktop("capture");
    }, captureIntervalMs);
  };

  const cleanupSocket = () => {
    socketCleanup?.();
    socketCleanup = null;
    socket = null;
    opened = false;
    requestKinds.clear();
    clearHandle("capture");
    clearHandle("heartbeat");
  };

  const scheduleReconnect = () => {
    if (disposed || intentionallyClosing || reconnectHandle !== null) return;
    publish({ phase: "reconnecting", message: "Reconnecting to the cloud desktop…" });
    reconnectHandle = options.scheduler.schedule(() => {
      reconnectHandle = null;
      connectSocket(true);
    }, reconnectDelayMs(reconnectAttempt++));
  };

  const failProtocol = (message: string) => {
    intentionallyClosing = true;
    socket?.close(4400, "invalid_inspector_frame");
    cleanupSocket();
    publish({ phase: "error", message, pendingAction: null });
  };

  const acceptController = (
    state: DesktopControllerState,
    token: DesktopLeaseResumeToken | undefined,
  ) => {
    if (binding === null || !controllerBindingMatches(state, binding)) {
      failProtocol("The desktop controller no longer matches this cloud workspace.");
      return;
    }
    if (token !== undefined) resumeToken = token;
    publish({ controller: state, pendingAction: null, message: null });
  };

  const afterControlResponse = (purpose: ControlPurpose) => {
    const controller = snapshot.controller;
    if (controller?.controller === "user" && controller.heldByCurrentClient) {
      if (releaseAfterRecovery) {
        releaseAfterRecovery = false;
        const frame: DesktopControlClientFrame = {
          protocolVersion: DESKTOP_CONTROL_PROTOCOL_VERSION,
          type: "desktop.control.release",
          requestId: nextCommandId(),
          leaseId: controller.lease.leaseId,
          generation: controller.lease.generation,
          idempotencyKey: nextIdempotencyKey(),
        };
        startControl("release", frame);
        return;
      }
      scheduleHeartbeat();
      return;
    }
    if (
      controller?.controller === "disconnected" &&
      controller.resumableByCurrentSession &&
      resumeToken !== null
    ) {
      // A lost resume response is first recovered idempotently. That response
      // can intentionally remain disconnected; the rotated proof then performs
      // a fresh, higher-generation handoff to this new authenticated socket.
      beginResume(resumeToken);
      return;
    }
    if (controller?.controller === "agent") releaseAfterRecovery = false;
    if (purpose === "take-control" && controller?.controller === "user") {
      const retryGet = () => {
        if (!disposed && pendingControl === null) beginGet();
      };
      heartbeatHandle = options.scheduler.schedule(retryGet, 250);
    }
  };

  const handleControlFrame = (
    frame: Extract<
      ReturnType<typeof decodeServerFrame>,
      { readonly type: "desktop.control.state" }
    >,
  ) => {
    const pending = pendingControl;
    if (pending === null || pending.frame.requestId !== frame.requestId) return;
    pendingControl = null;
    acceptController(frame.state, frame.resumeToken);
    if (snapshot.phase === "error") return;
    afterControlResponse(pending.purpose);
  };

  const handleData = (
    frame: Extract<ReturnType<typeof decodeServerFrame>, { readonly type: "inspector.data" }>,
  ) => {
    if (
      binding === null ||
      sessionId !== frame.sessionId ||
      !sameBinding(binding, frame.binding) ||
      frame.sequence !== resumeAfterSequence + 1
    ) {
      failProtocol("The cloud desktop stream became inconsistent.");
      return;
    }
    resumeAfterSequence = frame.sequence;
    const payload = frame.payload;
    if (payload.type === "artifact" && payload.artifact.kind === "desktop-frame") {
      publish({
        frameUrl: options.artifactUrl(payload.artifact),
        frameMediaType: payload.artifact.mediaType,
      });
      return;
    }
    if (payload.type === "error" && payload.requestId !== undefined) {
      const kind = requestKinds.get(payload.requestId);
      requestKinds.delete(payload.requestId);
      if (kind === "start" || kind === "capture") {
        clearHandle("capture");
        publish({
          phase: payload.code === "unsupported" ? "unsupported" : "error",
          message:
            payload.code === "unsupported"
              ? "This cloud environment does not provide a desktop stream."
              : payload.detail,
        });
      }
      return;
    }
    if (payload.type === "complete") {
      const kind = requestKinds.get(payload.requestId);
      requestKinds.delete(payload.requestId);
      if (kind === "start") desktopStarted = true;
      if (kind === "start" || kind === "capture") scheduleCapture();
    }
  };

  const handleServerFrame = (payload: string) => {
    let frame: ReturnType<typeof decodeServerFrame>;
    try {
      frame = decodeServerFrame(payload);
    } catch {
      failProtocol("The cloud desktop sent an invalid response.");
      return;
    }
    if (frame.type === "inspector.heartbeat") {
      if (frame.sessionId !== sessionId) {
        failProtocol("The cloud desktop heartbeat did not match this session.");
        return;
      }
      send({
        protocolVersion: INSPECTOR_PROTOCOL_VERSION,
        type: "inspector.heartbeat.ack",
        sessionId: frame.sessionId,
        nonce: frame.nonce,
      });
      return;
    }
    if (frame.type === "inspector.resume-rejected") {
      if (
        frame.sessionId !== sessionId ||
        binding === null ||
        !sameBinding(binding, frame.binding)
      ) {
        failProtocol("The cloud desktop rejected an unrelated session.");
        return;
      }
      resumeAfterSequence = frame.latestSequence;
      if (frame.reason === "session-unavailable") {
        sessionId = null;
        binding = null;
        desktopStarted = false;
        return;
      }
      // The bridge has explicitly advanced this authenticated session to the
      // latest retained cursor. Visual state is replaceable, so fetch a fresh
      // frame instead of poisoning or abandoning the live session.
      opened = true;
      publish({
        phase: "connected",
        message: "Earlier desktop frames expired; showing live state.",
      });
      if (pendingControl !== null) sendControl(pendingControl);
      else beginGet();
      requestDesktop("capture");
      return;
    }
    if (frame.type === "inspector.opened") {
      if (
        frame.binding.threadId !== options.threadId ||
        frame.binding.attemptId !== options.attemptId ||
        (sessionId !== null && frame.sessionId !== sessionId) ||
        frame.resumedThroughSequence !== resumeAfterSequence ||
        frame.sequence !== resumeAfterSequence + 1
      ) {
        failProtocol("The cloud desktop opened with the wrong workspace identity.");
        return;
      }
      sessionId = frame.sessionId;
      binding = frame.binding;
      resumeAfterSequence = frame.sequence;
      opened = true;
      reconnectAttempt = 0;
      const unsupported =
        !frame.capabilities.desktopFrames || frame.capabilities.desktopBackend === "unsupported";
      publish({
        phase: unsupported ? "unsupported" : "connected",
        capabilities: frame.capabilities,
        message: unsupported ? "This cloud environment does not provide a desktop stream." : null,
      });
      if (unsupported) return;
      if (pendingControl !== null) sendControl(pendingControl);
      else beginGet();
      if (!desktopStarted) requestDesktop("start");
      else requestDesktop("capture");
      return;
    }
    if (frame.type === "desktop.control.state") {
      handleControlFrame(frame);
      return;
    }
    handleData(frame);
  };

  function connectSocket(reconnecting: boolean) {
    if (disposed) return;
    intentionallyClosing = false;
    cleanupSocket();
    clearHandle("reconnect");
    const epoch = ++socketEpoch;
    publish({
      phase: reconnecting ? "reconnecting" : "connecting",
      message: reconnecting ? "Reconnecting to the cloud desktop…" : null,
    });
    let nextSocket: LiveDesktopSocket;
    try {
      nextSocket = options.createSocket();
    } catch {
      publish({ phase: "error", message: "Could not open the cloud desktop connection." });
      return;
    }
    socket = nextSocket;
    const removeOpen = nextSocket.onOpen(() => {
      if (disposed || socketEpoch !== epoch || socket !== nextSocket) return;
      nextSocket.send(
        JSON.stringify({
          protocolVersion: INSPECTOR_PROTOCOL_VERSION,
          type: "inspector.open",
          threadId: options.threadId,
          attemptId: options.attemptId,
          ...(sessionId === null ? {} : { sessionId }),
          resumeAfterSequence,
        } satisfies InspectorClientFrame),
      );
    });
    const removeMessage = nextSocket.onMessage((payload) => {
      if (!disposed && socketEpoch === epoch && socket === nextSocket) handleServerFrame(payload);
    });
    const removeClose = nextSocket.onClose((event) => {
      if (socketEpoch !== epoch || socket !== nextSocket) return;
      cleanupSocket();
      if (pendingControl?.purpose === "heartbeat") {
        pendingControl = null;
        publish({ pendingAction: null });
      } else if (pendingControl?.purpose === "release") {
        pendingControl = null;
        releaseAfterRecovery = true;
        publish({ pendingAction: "release" });
      }
      if (event.code === 4409) {
        sessionId = null;
        binding = null;
        resumeAfterSequence = -1;
        desktopStarted = false;
      }
      if (event.code === 4403 || event.code === 4404) {
        publish({
          phase: "error",
          message: "This desktop session is no longer authorized or available.",
          pendingAction: null,
        });
        return;
      }
      scheduleReconnect();
    });
    socketCleanup = () => {
      removeOpen();
      removeMessage();
      removeClose();
    };
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connect: () => {
      if (disposed || socket !== null || reconnectHandle !== null) return;
      connectSocket(false);
    },
    retry: () => {
      if (disposed) return;
      intentionallyClosing = true;
      socket?.close(1000, "retry");
      cleanupSocket();
      reconnectAttempt = 0;
      connectSocket(false);
    },
    takeControl: () => {
      if (
        snapshot.capabilities?.desktopInput !== true ||
        snapshot.controller?.controller !== "agent"
      ) {
        return;
      }
      startControl("take-control", {
        protocolVersion: DESKTOP_CONTROL_PROTOCOL_VERSION,
        type: "desktop.control.acquire",
        requestId: nextCommandId(),
        idempotencyKey: nextIdempotencyKey(),
      });
    },
    resumeControl: () => {
      if (resumeToken !== null) beginResume(resumeToken);
    },
    releaseControl: () => {
      const controller = snapshot.controller;
      if (
        controller?.controller !== "user" ||
        !controller.heldByCurrentClient ||
        pendingControl !== null
      ) {
        return;
      }
      clearHandle("heartbeat");
      startControl("release", {
        protocolVersion: DESKTOP_CONTROL_PROTOCOL_VERSION,
        type: "desktop.control.release",
        requestId: nextCommandId(),
        leaseId: controller.lease.leaseId,
        generation: controller.lease.generation,
        idempotencyKey: nextIdempotencyKey(),
      });
    },
    sendInput: (input) => {
      const controller = snapshot.controller;
      if (
        snapshot.phase !== "connected" ||
        snapshot.capabilities?.desktopInput !== true ||
        controller?.controller !== "user" ||
        !controller.heldByCurrentClient ||
        sessionId === null
      ) {
        return false;
      }
      const requestId = nextRequestId();
      requestKinds.set(requestId, "input");
      const sent = send({
        protocolVersion: INSPECTOR_PROTOCOL_VERSION,
        type: "inspector.request",
        sessionId,
        operation: { type: "desktop.input", requestId, input },
      });
      if (!sent) requestKinds.delete(requestId);
      return sent;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearHandle("reconnect");
      clearHandle("capture");
      clearHandle("heartbeat");
      intentionallyClosing = true;
      // A healthy socket gets one best-effort release before disconnect. If
      // delivery loses the race, the server's authenticated disconnect grace
      // and durable expiry still restore agent authority.
      const controller = snapshot.controller;
      if (
        opened &&
        sessionId !== null &&
        controller?.controller === "user" &&
        controller.heldByCurrentClient
      ) {
        try {
          socket?.send(
            JSON.stringify({
              protocolVersion: DESKTOP_CONTROL_PROTOCOL_VERSION,
              type: "desktop.control.release",
              requestId: nextCommandId(),
              leaseId: controller.lease.leaseId,
              generation: controller.lease.generation,
              idempotencyKey: nextIdempotencyKey(),
            } satisfies DesktopControlClientFrame),
          );
        } catch {
          // The authenticated server-side disconnect path is authoritative.
        }
      }
      socket?.close(1000, "inspector_closed");
      cleanupSocket();
      pendingControl = null;
      releaseAfterRecovery = false;
      listeners.clear();
    },
  };
}
