import {
  makeLiveDesktopClient,
  type LiveDesktopClient,
  type LiveDesktopSnapshot,
  type LiveDesktopSocket,
} from "@t3tools/client-runtime/inspector";
import type { ThreadId } from "@t3tools/contracts";
import type { InspectorArtifactReference, InspectorAttemptId } from "@t3tools/contracts/inspector";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { randomUUID } from "~/lib/utils";

export interface CloudDesktopConnection {
  readonly controlPlaneOrigin: string;
  readonly attemptId: InspectorAttemptId;
}

export interface CloudDesktopSession {
  readonly snapshot: LiveDesktopSnapshot;
  readonly takeControl: () => void;
  readonly resumeControl: () => void;
  readonly releaseControl: () => void;
  readonly retry: () => void;
  readonly sendInput: LiveDesktopClient["sendInput"];
}

const inactiveSnapshot: LiveDesktopSnapshot = {
  phase: "idle",
  capabilities: null,
  controller: null,
  frameUrl: null,
  frameMediaType: null,
  pendingAction: null,
  message: null,
};

function normalizedControlPlaneOrigin(value: string): URL {
  const origin = new URL(value);
  if (origin.pathname !== "/" || origin.search !== "" || origin.hash !== "") {
    throw new Error("Cloud desktop control plane must be an origin.");
  }
  if (origin.protocol !== "https:" && origin.protocol !== "http:") {
    throw new Error("Cloud desktop control plane must use HTTP or HTTPS.");
  }
  const localDevelopmentHost =
    origin.hostname === "localhost" ||
    origin.hostname === "127.0.0.1" ||
    origin.hostname === "[::1]";
  if (origin.protocol !== "https:" && !localDevelopmentHost) {
    throw new Error("Cloud desktop control plane must use HTTPS outside local development.");
  }
  if (origin.username !== "" || origin.password !== "") {
    throw new Error("Cloud desktop control plane must not contain credentials.");
  }
  return origin;
}

function nativeSocket(url: URL): LiveDesktopSocket {
  const socket = new WebSocket(url);
  return {
    send: (payload) => socket.send(payload),
    close: (code, reason) => socket.close(code, reason),
    onOpen: (listener) => {
      socket.addEventListener("open", listener);
      return () => socket.removeEventListener("open", listener);
    },
    onMessage: (listener) => {
      const receive = (event: MessageEvent) => {
        if (typeof event.data === "string") listener(event.data);
        else socket.close(1003, "binary_inspector_frame");
      };
      socket.addEventListener("message", receive);
      return () => socket.removeEventListener("message", receive);
    },
    onClose: (listener) => {
      const close = (event: CloseEvent) => listener({ code: event.code });
      socket.addEventListener("close", close);
      return () => socket.removeEventListener("close", close);
    },
  };
}

export function cloudDesktopWebSocketUrl(
  connection: CloudDesktopConnection,
  threadId: ThreadId,
): URL {
  const url = normalizedControlPlaneOrigin(connection.controlPlaneOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/v1/inspector";
  url.searchParams.set("threadId", threadId);
  url.searchParams.set("attemptId", connection.attemptId);
  return url;
}

export function cloudDesktopArtifactUrl(
  connection: CloudDesktopConnection,
  threadId: ThreadId,
  artifact: InspectorArtifactReference,
): string {
  const url = normalizedControlPlaneOrigin(connection.controlPlaneOrigin);
  url.pathname = `/api/v1/inspector/artifacts/${encodeURIComponent(artifact.artifactId)}`;
  url.searchParams.set("threadId", threadId);
  url.searchParams.set("attemptId", connection.attemptId);
  return url.toString();
}

export function makeBrowserLiveDesktopClient(input: {
  readonly connection: CloudDesktopConnection;
  readonly threadId: ThreadId;
}): LiveDesktopClient {
  return makeLiveDesktopClient({
    threadId: input.threadId,
    attemptId: input.connection.attemptId,
    createSocket: () => nativeSocket(cloudDesktopWebSocketUrl(input.connection, input.threadId)),
    artifactUrl: (artifact) => cloudDesktopArtifactUrl(input.connection, input.threadId, artifact),
    nextId: randomUUID,
    now: () => Date.now(),
    scheduler: {
      schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
      cancel: (handle) => window.clearTimeout(handle as number),
    },
  });
}

const noAction = () => undefined;
const noInput = () => false;

/** Opens the authenticated inspector only while its surface is visible. */
export function useCloudDesktopInspector(input: {
  readonly active: boolean;
  readonly connection: CloudDesktopConnection | null;
  readonly threadId: ThreadId;
  readonly makeClient?: typeof makeBrowserLiveDesktopClient;
}): CloudDesktopSession {
  const makeClient = input.makeClient ?? makeBrowserLiveDesktopClient;
  const controlPlaneOrigin = input.connection?.controlPlaneOrigin ?? null;
  const attemptId = input.connection?.attemptId ?? null;
  const client = useMemo(
    () =>
      input.active && controlPlaneOrigin !== null && attemptId !== null
        ? makeClient({
            connection: { controlPlaneOrigin, attemptId },
            threadId: input.threadId,
          })
        : null,
    [attemptId, controlPlaneOrigin, input.active, input.threadId, makeClient],
  );
  const snapshot = useSyncExternalStore(
    client?.subscribe ?? (() => noAction),
    client?.getSnapshot ?? (() => inactiveSnapshot),
    () => inactiveSnapshot,
  );

  useEffect(() => {
    if (client === null) return;
    client.connect();
    return () => client.dispose();
  }, [client]);

  return {
    snapshot,
    takeControl: client?.takeControl ?? noAction,
    resumeControl: client?.resumeControl ?? noAction,
    releaseControl: client?.releaseControl ?? noAction,
    retry: client?.retry ?? noAction,
    sendInput: client?.sendInput ?? noInput,
  };
}
