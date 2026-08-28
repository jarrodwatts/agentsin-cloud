/**
 * Versioned live-inspector contracts shared by the desktop, control plane, and
 * authenticated cloud worker. Inspector traffic is deliberately a closed
 * union: it cannot smuggle an arbitrary command or untyped payload.
 *
 * @module inspector
 */
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  PortSchema,
  PositiveInt,
  ThreadId,
} from "./baseSchemas.ts";
import { EnvironmentRevisionId, SandboxId, WorkspaceId } from "./cloud.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import {
  DesktopControlClientFrame,
  DesktopControlServerFrame,
  DesktopInputPermit,
} from "./desktopLease.ts";

const boundedId = <Brand extends string>(brand: Brand) =>
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  ).pipe(Schema.brand(brand));

export const InspectorSessionId = boundedId("InspectorSessionId");
export type InspectorSessionId = typeof InspectorSessionId.Type;
export const InspectorRequestId = boundedId("InspectorRequestId");
export type InspectorRequestId = typeof InspectorRequestId.Type;
export const InspectorAttemptId = boundedId("InspectorAttemptId");
export type InspectorAttemptId = typeof InspectorAttemptId.Type;
export const InspectorArtifactId = boundedId("InspectorArtifactId");
export type InspectorArtifactId = typeof InspectorArtifactId.Type;
export const InspectorTerminalId = boundedId("InspectorTerminalId");
export type InspectorTerminalId = typeof InspectorTerminalId.Type;
export const InspectorWorkerId = boundedId("InspectorWorkerId");
export type InspectorWorkerId = typeof InspectorWorkerId.Type;

export const INSPECTOR_PROTOCOL_VERSION = 1 as const;
export const INSPECTOR_MAX_INLINE_BYTES = 16 * 1024;
export const INSPECTOR_MAX_FILE_BYTES = 256 * 1024;
// Keep the base64 payload plus the typed envelope safely beneath the relay's 512 KiB frame cap.
export const INSPECTOR_MAX_ARTIFACT_TRANSFER_BYTES = 320 * 1024;
export const INSPECTOR_MAX_FRAME_BYTES = 512 * 1024;
export const INSPECTOR_ALLOWED_PORT_MIN = 1_024;
export const INSPECTOR_ALLOWED_PORT_MAX = 65_535;
export const INSPECTOR_MAX_REQUESTS_PER_MINUTE = 120;
export const INSPECTOR_MAX_INFLIGHT_REQUESTS = 8;
export const INSPECTOR_MAX_TERMINALS_PER_SESSION = 4;
export const INSPECTOR_MAX_ARTIFACTS_PER_SESSION = 128;
export const INSPECTOR_MAX_ARTIFACT_BYTES_PER_SESSION = 16 * 1024 * 1024;

export const InspectorSequence = NonNegativeInt;
export type InspectorSequence = typeof InspectorSequence.Type;
export const InspectorResumeCursor = Schema.Int.check(
  Schema.isBetween({ minimum: -1, maximum: Number.MAX_SAFE_INTEGER }),
);
export type InspectorResumeCursor = typeof InspectorResumeCursor.Type;

/** A normalized, workspace-relative path. The worker still resolves it beneath its sealed root. */
export const InspectorRelativePath = Schema.String.check(
  Schema.isMaxLength(1_024),
  Schema.isPattern(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?:\.|[^/]+(?:\/[^/]+)*)$/u),
  Schema.makeFilter((path) =>
    path.includes(String.fromCharCode(0)) ? "paths must not contain NUL bytes" : undefined,
  ),
).pipe(Schema.brand("InspectorRelativePath"));
export type InspectorRelativePath = typeof InspectorRelativePath.Type;

export const InspectorRouteBinding = Schema.Struct({
  protocolVersion: Schema.Literal(INSPECTOR_PROTOCOL_VERSION),
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  attemptId: InspectorAttemptId,
  environmentId: EnvironmentId,
  environmentRevisionId: EnvironmentRevisionId,
  providerInstanceId: ProviderInstanceId,
  providerDriver: ProviderDriverKind,
  sandboxId: SandboxId,
  workerId: InspectorWorkerId,
  routeGeneration: PositiveInt,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type InspectorRouteBinding = typeof InspectorRouteBinding.Type;

export const InspectorCapabilities = Schema.Struct({
  terminal: Schema.Boolean,
  files: Schema.Boolean,
  ports: Schema.Boolean,
  browserFrames: Schema.Boolean,
  browserInput: Schema.Boolean,
  desktopFrames: Schema.Boolean,
  desktopInput: Schema.Boolean,
  desktopBackend: Schema.Literals(["unsupported", "injected"]),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type InspectorCapabilities = typeof InspectorCapabilities.Type;

const BoundedText = Schema.String.check(Schema.isMaxLength(INSPECTOR_MAX_INLINE_BYTES));
const Base64Payload = Schema.String.check(
  Schema.isMaxLength(Math.ceil((INSPECTOR_MAX_ARTIFACT_TRANSFER_BYTES * 4) / 3) + 4),
  Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
);
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const BoundedMediaType = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i),
);
const inspectorArtifactMediaTypeAllowed = (
  kind: "terminal-chunk" | "browser-frame" | "desktop-frame",
  mediaType: string,
) =>
  kind === "terminal-chunk"
    ? mediaType === "text/plain"
    : ["application/octet-stream", "image/jpeg", "image/png", "image/webp", "video/mp4"].includes(
        mediaType,
      );

export const InspectorInputEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("key"),
    key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
    code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
    action: Schema.Literals(["down", "up"]),
    modifiers: Schema.Array(Schema.Literals(["alt", "control", "meta", "shift"])).check(
      Schema.isMaxLength(4),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("text"),
    text: Schema.String.check(Schema.isMaxLength(4_096)),
  }),
  Schema.Struct({
    type: Schema.Literal("pointer"),
    action: Schema.Literals(["move", "down", "up"]),
    x: NonNegativeInt.check(Schema.isLessThanOrEqualTo(16_384)),
    y: NonNegativeInt.check(Schema.isLessThanOrEqualTo(16_384)),
    button: Schema.Literals(["none", "left", "middle", "right"]),
  }),
  Schema.Struct({
    type: Schema.Literal("scroll"),
    deltaX: Schema.Int.check(Schema.isBetween({ minimum: -10_000, maximum: 10_000 })),
    deltaY: Schema.Int.check(Schema.isBetween({ minimum: -10_000, maximum: 10_000 })),
  }),
]);
export type InspectorInputEvent = typeof InspectorInputEvent.Type;

const InspectorOperationIdentity = {
  requestId: InspectorRequestId,
} as const;

const InspectorAllowedPort = Schema.Int.check(
  Schema.isBetween({ minimum: INSPECTOR_ALLOWED_PORT_MIN, maximum: INSPECTOR_ALLOWED_PORT_MAX }),
);

/** Operations the desktop is allowed to ask the worker to perform. */
export const InspectorOperation = Schema.Union([
  Schema.Struct({
    ...InspectorOperationIdentity,
    type: Schema.Literal("capabilities.get"),
  }),
  Schema.Struct({
    ...InspectorOperationIdentity,
    type: Schema.Literal("terminal.open"),
    terminalId: InspectorTerminalId,
    executable: Schema.Literals(["shell", "agent"]),
    columns: PositiveInt.check(Schema.isLessThanOrEqualTo(500)),
    rows: PositiveInt.check(Schema.isLessThanOrEqualTo(300)),
  }),
  Schema.Struct({
    ...InspectorOperationIdentity,
    type: Schema.Literal("terminal.write"),
    terminalId: InspectorTerminalId,
    data: BoundedText,
  }),
  Schema.Struct({
    ...InspectorOperationIdentity,
    type: Schema.Literal("terminal.resize"),
    terminalId: InspectorTerminalId,
    columns: PositiveInt.check(Schema.isLessThanOrEqualTo(500)),
    rows: PositiveInt.check(Schema.isLessThanOrEqualTo(300)),
  }),
  Schema.Struct({
    ...InspectorOperationIdentity,
    type: Schema.Literal("terminal.close"),
    terminalId: InspectorTerminalId,
  }),
  Schema.Struct({
    ...InspectorOperationIdentity,
    type: Schema.Literal("files.list"),
    path: InspectorRelativePath,
    limit: PositiveInt.check(Schema.isLessThanOrEqualTo(1_000)),
  }),
  Schema.Struct({
    ...InspectorOperationIdentity,
    type: Schema.Literal("files.read"),
    path: InspectorRelativePath,
    offset: NonNegativeInt,
    length: PositiveInt.check(Schema.isLessThanOrEqualTo(INSPECTOR_MAX_FILE_BYTES)),
  }),
  Schema.Struct({
    ...InspectorOperationIdentity,
    type: Schema.Literal("files.write"),
    path: InspectorRelativePath,
    expectedSha256: Schema.NullOr(Sha256),
    encoding: Schema.Literals(["utf8", "base64"]),
    contents: Schema.String.check(Schema.isMaxLength(INSPECTOR_MAX_FILE_BYTES * 2)),
  }),
  Schema.Struct({
    ...InspectorOperationIdentity,
    type: Schema.Literal("ports.list"),
  }),
  Schema.Struct({
    ...InspectorOperationIdentity,
    type: Schema.Literal("ports.expose"),
    port: InspectorAllowedPort,
    protocol: Schema.Literals(["http", "https"]),
  }),
  Schema.Struct({
    ...InspectorOperationIdentity,
    type: Schema.Literal("ports.close"),
    port: InspectorAllowedPort,
  }),
  Schema.Struct({
    ...InspectorOperationIdentity,
    type: Schema.Literal("browser.start"),
    viewportWidth: PositiveInt.check(Schema.isLessThanOrEqualTo(4_096)),
    viewportHeight: PositiveInt.check(Schema.isLessThanOrEqualTo(4_096)),
  }),
  Schema.Struct({
    ...InspectorOperationIdentity,
    type: Schema.Literal("browser.navigate"),
    url: Schema.String.check(Schema.isMaxLength(2_048), Schema.isPattern(/^https?:\/\/[^\s]+$/)),
  }),
  Schema.Struct({
    ...InspectorOperationIdentity,
    type: Schema.Literal("browser.input"),
    input: InspectorInputEvent,
  }),
  Schema.Struct({
    ...InspectorOperationIdentity,
    type: Schema.Literal("browser.capture"),
  }),
  Schema.Struct({
    ...InspectorOperationIdentity,
    type: Schema.Literal("browser.stop"),
  }),
  Schema.Struct({
    ...InspectorOperationIdentity,
    type: Schema.Literal("desktop.start"),
    width: PositiveInt.check(Schema.isLessThanOrEqualTo(4_096)),
    height: PositiveInt.check(Schema.isLessThanOrEqualTo(4_096)),
  }),
  Schema.Struct({
    ...InspectorOperationIdentity,
    type: Schema.Literal("desktop.input"),
    input: InspectorInputEvent,
  }),
  Schema.Struct({
    ...InspectorOperationIdentity,
    type: Schema.Literal("desktop.capture"),
  }),
  Schema.Struct({
    ...InspectorOperationIdentity,
    type: Schema.Literal("desktop.stop"),
  }),
]);
export type InspectorOperation = typeof InspectorOperation.Type;

export const InspectorClientFrame = Schema.Union([
  Schema.Struct({
    protocolVersion: Schema.Literal(INSPECTOR_PROTOCOL_VERSION),
    type: Schema.Literal("inspector.open"),
    threadId: ThreadId,
    attemptId: InspectorAttemptId,
    sessionId: Schema.optionalKey(InspectorSessionId),
    resumeAfterSequence: InspectorResumeCursor,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    protocolVersion: Schema.Literal(INSPECTOR_PROTOCOL_VERSION),
    type: Schema.Literal("inspector.request"),
    sessionId: InspectorSessionId,
    operation: InspectorOperation,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    protocolVersion: Schema.Literal(INSPECTOR_PROTOCOL_VERSION),
    type: Schema.Literal("inspector.cancel"),
    sessionId: InspectorSessionId,
    requestId: InspectorRequestId,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    protocolVersion: Schema.Literal(INSPECTOR_PROTOCOL_VERSION),
    type: Schema.Literal("inspector.heartbeat.ack"),
    sessionId: InspectorSessionId,
    nonce: boundedId("InspectorHeartbeatNonce"),
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  DesktopControlClientFrame,
]);
export type InspectorClientFrame = typeof InspectorClientFrame.Type;

export const InspectorWorkerCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("inspector.open"),
    binding: InspectorRouteBinding,
    sessionId: InspectorSessionId,
    resumeAfterSequence: InspectorResumeCursor,
  }),
  Schema.Struct({
    type: Schema.Literal("inspector.request"),
    binding: InspectorRouteBinding,
    sessionId: InspectorSessionId,
    operation: InspectorOperation,
    desktopPermit: Schema.optionalKey(DesktopInputPermit),
  }).check(
    Schema.makeFilter(
      (input) =>
        (input.operation.type === "browser.input" || input.operation.type === "desktop.input") ===
          (input.desktopPermit !== undefined) ||
        "interactive visual input requires a desktop-control permit and other operations forbid it",
      { identifier: "InspectorDesktopInputPermit" },
    ),
  ),
  Schema.Struct({
    type: Schema.Literal("inspector.cancel"),
    binding: InspectorRouteBinding,
    sessionId: InspectorSessionId,
    requestId: InspectorRequestId,
  }),
  Schema.Struct({
    type: Schema.Literal("inspector.close"),
    binding: InspectorRouteBinding,
    sessionId: InspectorSessionId,
    reason: Schema.Literals(["client-disconnected", "replaced", "timeout", "closed"]),
  }),
]).annotate({ parseOptions: { onExcessProperty: "error" } });
export type InspectorWorkerCommand = typeof InspectorWorkerCommand.Type;

export const InspectorFileEntry = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  type: Schema.Literals(["file", "directory", "symlink"]),
  sizeBytes: NonNegativeInt,
  modifiedAt: IsoDateTime,
});
export type InspectorFileEntry = typeof InspectorFileEntry.Type;

export const InspectorPort = Schema.Struct({
  port: PortSchema,
  protocol: Schema.Literals(["http", "https"]),
  state: Schema.Literals(["listening", "exposed"]),
  publicUrl: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(2_048), Schema.isPattern(/^https:\/\/[^\s]+$/)),
  ),
});
export type InspectorPort = typeof InspectorPort.Type;

export const InspectorArtifactReference = Schema.Struct({
  artifactId: InspectorArtifactId,
  kind: Schema.Literals(["terminal-chunk", "browser-frame", "desktop-frame"]),
  mediaType: BoundedMediaType,
  byteLength: NonNegativeInt.check(
    Schema.isLessThanOrEqualTo(INSPECTOR_MAX_ARTIFACT_TRANSFER_BYTES),
  ),
  sha256: Sha256,
})
  .check(
    Schema.makeFilter((artifact) =>
      inspectorArtifactMediaTypeAllowed(artifact.kind, artifact.mediaType)
        ? undefined
        : "media type is not allowed for this inspector artifact kind",
    ),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });
export type InspectorArtifactReference = typeof InspectorArtifactReference.Type;

const WorkerFrameIdentity = {
  binding: InspectorRouteBinding,
  sessionId: InspectorSessionId,
  sequence: InspectorSequence,
  emittedAt: IsoDateTime,
} as const;

const WorkerControlFrameIdentity = {
  binding: InspectorRouteBinding,
  sessionId: InspectorSessionId,
  emittedAt: IsoDateTime,
} as const;

/** Worker-to-control-plane frames. Artifact bytes are consumed by B6 before client fan-out. */
export const InspectorWorkerFrame = Schema.Union([
  Schema.Struct({
    ...WorkerControlFrameIdentity,
    type: Schema.Literal("inspector.resume-rejected"),
    requestedAfterSequence: InspectorResumeCursor,
    earliestAvailableSequence: InspectorResumeCursor,
    latestSequence: InspectorResumeCursor,
    reason: Schema.Literals(["history-evicted", "session-unavailable"]),
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    ...WorkerFrameIdentity,
    type: Schema.Literal("inspector.ready"),
    capabilities: InspectorCapabilities,
  }),
  Schema.Struct({
    ...WorkerFrameIdentity,
    type: Schema.Literal("inspector.ack"),
    requestId: InspectorRequestId,
  }),
  Schema.Struct({
    ...WorkerFrameIdentity,
    type: Schema.Literal("inspector.error"),
    requestId: Schema.optionalKey(InspectorRequestId),
    code: Schema.Literals([
      "unsupported",
      "invalid-operation",
      "not-found",
      "conflict",
      "limit-exceeded",
      "cancelled",
      "internal",
    ]),
    retryable: Schema.Boolean,
    detail: Schema.String.check(Schema.isMaxLength(500)),
  }),
  Schema.Struct({
    ...WorkerFrameIdentity,
    type: Schema.Literal("terminal.chunk"),
    requestId: InspectorRequestId,
    terminalId: InspectorTerminalId,
    stream: Schema.Literals(["stdout", "stderr"]),
    data: BoundedText,
  }),
  Schema.Struct({
    ...WorkerFrameIdentity,
    type: Schema.Literal("terminal.retired"),
    terminalId: InspectorTerminalId,
    reason: Schema.Literals(["exited", "killed", "resource-limit"]),
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    ...WorkerFrameIdentity,
    type: Schema.Literal("files.entries"),
    requestId: InspectorRequestId,
    path: InspectorRelativePath,
    entries: Schema.Array(InspectorFileEntry).check(Schema.isMaxLength(1_000)),
  }),
  Schema.Struct({
    ...WorkerFrameIdentity,
    type: Schema.Literal("files.contents"),
    requestId: InspectorRequestId,
    path: InspectorRelativePath,
    encoding: Schema.Literals(["utf8", "base64"]),
    contents: Schema.String.check(Schema.isMaxLength(INSPECTOR_MAX_FILE_BYTES * 2)),
    sha256: Sha256,
    eof: Schema.Boolean,
  }),
  Schema.Struct({
    ...WorkerFrameIdentity,
    type: Schema.Literal("ports.snapshot"),
    requestId: InspectorRequestId,
    ports: Schema.Array(InspectorPort).check(Schema.isMaxLength(64)),
  }),
  Schema.Struct({
    ...WorkerFrameIdentity,
    type: Schema.Literal("inspector.artifact.proposed"),
    requestId: InspectorRequestId,
    artifact: InspectorArtifactReference,
    base64: Base64Payload,
  }),
  Schema.Struct({
    ...WorkerFrameIdentity,
    type: Schema.Literal("inspector.complete"),
    requestId: InspectorRequestId,
  }),
  Schema.Struct({
    ...WorkerFrameIdentity,
    type: Schema.Literal("inspector.heartbeat"),
    nonce: boundedId("InspectorHeartbeatNonce"),
  }),
]);
export type InspectorWorkerFrame = typeof InspectorWorkerFrame.Type;

/** Frames visible to an authenticated desktop client. No object key or raw artifact bytes leak. */
export const InspectorServerFrame = Schema.Union([
  Schema.Struct({
    protocolVersion: Schema.Literal(INSPECTOR_PROTOCOL_VERSION),
    type: Schema.Literal("inspector.resume-rejected"),
    binding: InspectorRouteBinding,
    sessionId: InspectorSessionId,
    requestedAfterSequence: InspectorResumeCursor,
    earliestAvailableSequence: InspectorResumeCursor,
    latestSequence: InspectorResumeCursor,
    reason: Schema.Literals(["history-evicted", "session-unavailable"]),
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    protocolVersion: Schema.Literal(INSPECTOR_PROTOCOL_VERSION),
    type: Schema.Literal("inspector.opened"),
    binding: InspectorRouteBinding,
    sessionId: InspectorSessionId,
    sequence: InspectorSequence,
    resumedThroughSequence: InspectorResumeCursor,
    capabilities: InspectorCapabilities,
  }),
  Schema.Struct({
    protocolVersion: Schema.Literal(INSPECTOR_PROTOCOL_VERSION),
    type: Schema.Literal("inspector.data"),
    binding: InspectorRouteBinding,
    sessionId: InspectorSessionId,
    sequence: InspectorSequence,
    payload: Schema.Union([
      Schema.Struct({ type: Schema.Literal("ack"), requestId: InspectorRequestId }),
      Schema.Struct({
        type: Schema.Literal("error"),
        requestId: Schema.optionalKey(InspectorRequestId),
        code: Schema.String.check(Schema.isMaxLength(64)),
        retryable: Schema.Boolean,
        detail: Schema.String.check(Schema.isMaxLength(500)),
      }),
      Schema.Struct({
        type: Schema.Literal("terminal.chunk"),
        requestId: InspectorRequestId,
        terminalId: InspectorTerminalId,
        stream: Schema.Literals(["stdout", "stderr"]),
        data: BoundedText,
      }),
      Schema.Struct({
        type: Schema.Literal("terminal.retired"),
        terminalId: InspectorTerminalId,
        reason: Schema.Literals(["exited", "killed", "resource-limit"]),
      }),
      Schema.Struct({
        type: Schema.Literal("files.entries"),
        requestId: InspectorRequestId,
        path: InspectorRelativePath,
        entries: Schema.Array(InspectorFileEntry).check(Schema.isMaxLength(1_000)),
      }),
      Schema.Struct({
        type: Schema.Literal("files.contents"),
        requestId: InspectorRequestId,
        path: InspectorRelativePath,
        encoding: Schema.Literals(["utf8", "base64"]),
        contents: Schema.String.check(Schema.isMaxLength(INSPECTOR_MAX_FILE_BYTES * 2)),
        sha256: Sha256,
        eof: Schema.Boolean,
      }),
      Schema.Struct({
        type: Schema.Literal("ports.snapshot"),
        requestId: InspectorRequestId,
        ports: Schema.Array(InspectorPort).check(Schema.isMaxLength(64)),
      }),
      Schema.Struct({
        type: Schema.Literal("artifact"),
        requestId: InspectorRequestId,
        artifact: InspectorArtifactReference,
      }),
      Schema.Struct({ type: Schema.Literal("complete"), requestId: InspectorRequestId }),
    ]),
  }),
  Schema.Struct({
    protocolVersion: Schema.Literal(INSPECTOR_PROTOCOL_VERSION),
    type: Schema.Literal("inspector.heartbeat"),
    sessionId: InspectorSessionId,
    nonce: boundedId("InspectorHeartbeatNonce"),
    sentAt: IsoDateTime,
  }),
  DesktopControlServerFrame,
]).annotate({ parseOptions: { onExcessProperty: "error" } });
export type InspectorServerFrame = typeof InspectorServerFrame.Type;
