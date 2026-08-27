import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  INSPECTOR_MAX_FILE_BYTES,
  InspectorClientFrame,
  InspectorOperation,
  InspectorRelativePath,
  InspectorRouteBinding,
  InspectorWorkerFrame,
} from "./inspector.ts";

const decodePath = Schema.decodeUnknownSync(InspectorRelativePath);
const decodeOperation = Schema.decodeUnknownSync(InspectorOperation);
const decodeClient = Schema.decodeUnknownSync(InspectorClientFrame);
const decodeBinding = Schema.decodeUnknownSync(InspectorRouteBinding);
const decodeWorkerFrame = Schema.decodeUnknownSync(InspectorWorkerFrame);

const binding = {
  protocolVersion: 1,
  workspaceId: "workspace-1",
  threadId: "thread-1",
  attemptId: "attempt-1",
  environmentId: "environment-1",
  environmentRevisionId: "revision-1",
  providerInstanceId: "codex_personal",
  providerDriver: "codex",
  sandboxId: "sandbox-1",
  workerId: "worker-1",
  routeGeneration: 2,
};

describe("inspector wire contracts", () => {
  it("requires an exact versioned route binding", () => {
    expect(decodeBinding(binding)).toEqual(binding);
    expect(() => decodeBinding({ ...binding, protocolVersion: 2 })).toThrow();
    expect(() => decodeBinding({ ...binding, routeGeneration: 0 })).toThrow();
    expect(() => decodeBinding({ ...binding, workspaceId: "" })).toThrow();
    expect(() => decodeBinding({ ...binding, credential: "secret" })).toThrow();
  });

  it("rejects traversal, absolute paths, NULs, and oversized operations", () => {
    expect(decodePath(".")).toBe(".");
    expect(decodePath("src/index.ts")).toBe("src/index.ts");
    for (const value of ["../secret", "src/../../secret", "/etc/passwd", "a\0b"]) {
      expect(() => decodePath(value)).toThrow();
    }
    expect(() =>
      decodeOperation({
        type: "files.read",
        requestId: "request-1",
        path: "README.md",
        offset: 0,
        length: INSPECTOR_MAX_FILE_BYTES + 1,
      }),
    ).toThrow();
    expect(() =>
      decodeOperation({ type: "ports.expose", requestId: "request-1", port: 22, protocol: "http" }),
    ).toThrow();
  });

  it("does not accept polymorphic client commands or excess authority", () => {
    expect(
      decodeClient({
        protocolVersion: 1,
        type: "inspector.request",
        sessionId: "session-1",
        operation: {
          type: "terminal.write",
          requestId: "request-1",
          terminalId: "pty-1",
          data: "ls\n",
        },
      }).type,
    ).toBe("inspector.request");
    expect(() =>
      decodeClient({
        protocolVersion: 1,
        type: "inspector.request",
        sessionId: "session-1",
        operation: { type: "command.exec", requestId: "request-1", command: "cat /etc/passwd" },
      }),
    ).toThrow();
    expect(() =>
      decodeClient({
        protocolVersion: 1,
        type: "inspector.request",
        sessionId: "session-1",
        operation: {
          type: "terminal.write",
          requestId: "request-1",
          terminalId: "pty-1",
          data: "ls\n",
          token: "must-not-cross",
        },
      }),
    ).toThrow();
    expect(() =>
      decodeClient({
        protocolVersion: 1,
        type: "inspector.open",
        threadId: "thread-1",
        attemptId: "attempt-1",
        resumeAfterSequence: -1,
        workspaceId: "workspace-forged",
      }),
    ).toThrow();
  });

  it("bounds monotonic frame sequences and artifact payloads", () => {
    const acknowledged = decodeWorkerFrame({
      type: "inspector.ack",
      binding,
      sessionId: "session-1",
      sequence: 0,
      emittedAt: "2026-08-27T12:00:00.000Z",
      requestId: "request-1",
    });
    expect(acknowledged.type === "inspector.ack" ? acknowledged.sequence : undefined).toBe(0);
    expect(() =>
      decodeWorkerFrame({
        type: "inspector.ack",
        binding,
        sessionId: "session-1",
        sequence: -1,
        emittedAt: "2026-08-27T12:00:00.000Z",
        requestId: "request-1",
      }),
    ).toThrow();
    expect(() =>
      decodeWorkerFrame({
        type: "inspector.artifact.proposed",
        binding,
        sessionId: "session-1",
        sequence: 1,
        emittedAt: "2026-08-27T12:00:00.000Z",
        requestId: "request-1",
        artifact: {
          artifactId: "artifact-1",
          kind: "desktop-frame",
          mediaType: "image/png",
          byteLength: 4,
          sha256: "a".repeat(64),
        },
        base64: "not base64!",
      }),
    ).toThrow();
    expect(() =>
      decodeWorkerFrame({
        type: "inspector.artifact.proposed",
        binding,
        sessionId: "session-1",
        sequence: 1,
        emittedAt: "2026-08-27T12:00:00.000Z",
        requestId: "request-1",
        artifact: {
          artifactId: "artifact-1",
          kind: "desktop-frame",
          mediaType: "text/html",
          byteLength: 0,
          sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
        base64: "",
      }),
    ).toThrow();
  });

  it("keeps resume rejection outside the monotonic data sequence", () => {
    const rejected = decodeWorkerFrame({
      type: "inspector.resume-rejected",
      binding,
      sessionId: "session-1",
      emittedAt: "2026-08-27T12:00:00.000Z",
      requestedAfterSequence: 0,
      earliestAvailableSequence: 3,
      latestSequence: 5,
      reason: "history-evicted",
    });
    expect(rejected.type).toBe("inspector.resume-rejected");
    expect("sequence" in rejected).toBe(false);
    expect(() =>
      decodeWorkerFrame({
        ...rejected,
        sequence: 6,
      }),
    ).toThrow();
  });

  it("keeps terminal retirement sequenced, bounded, and explicit", () => {
    const retired = decodeWorkerFrame({
      type: "terminal.retired",
      binding,
      sessionId: "session-1",
      sequence: 7,
      emittedAt: "2026-08-27T12:00:00.000Z",
      terminalId: "terminal-1",
      reason: "exited",
    });
    expect(retired).toMatchObject({
      type: "terminal.retired",
      sequence: 7,
      terminalId: "terminal-1",
      reason: "exited",
    });
    expect(() => decodeWorkerFrame({ ...retired, reason: "unknown" })).toThrow();
    expect(() => decodeWorkerFrame({ ...retired, requestId: "not-applicable" })).toThrow();
  });
});
