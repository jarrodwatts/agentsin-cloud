// @effect-diagnostics nodeBuiltinImport:off -- The worker boundary intentionally owns sandbox-local filesystem and PTY access.
// @effect-diagnostics runEffectInsideEffect:off -- Native PTY callbacks re-enter the already-constructed frame sink.
import * as NodeCrypto from "node:crypto";

import type {
  InspectorCapabilities,
  InspectorOperation,
  InspectorPort,
  InspectorRequestId,
  InspectorResumeCursor,
  InspectorRouteBinding,
  InspectorSessionId,
  InspectorTerminalId,
  InspectorWorkerCommand,
} from "@t3tools/contracts/inspector";
import type { DesktopInputPermit } from "@t3tools/contracts/desktop-lease";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  INSPECTOR_MAX_ARTIFACT_TRANSFER_BYTES,
  INSPECTOR_MAX_ARTIFACT_BYTES_PER_SESSION,
  INSPECTOR_MAX_ARTIFACTS_PER_SESSION,
  INSPECTOR_MAX_FILE_BYTES,
  INSPECTOR_MAX_FRAME_BYTES,
  INSPECTOR_MAX_INFLIGHT_REQUESTS,
  INSPECTOR_MAX_INLINE_BYTES,
  INSPECTOR_MAX_REQUESTS_PER_MINUTE,
  INSPECTOR_MAX_TERMINALS_PER_SESSION,
  INSPECTOR_ALLOWED_PORT_MAX,
  INSPECTOR_ALLOWED_PORT_MIN,
  InspectorWorkerFrame,
} from "@t3tools/contracts/inspector";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import type { IPty } from "node-pty";

import {
  ContainedWorkspaceError,
  openContainedWorkspace,
  type ContainedWorkspaceTestHooks,
} from "./ContainedWorkspace.ts";
import type { InspectorPtySandbox } from "./InspectorPtySandbox.ts";

export class InspectorRuntimeError extends Schema.TaggedErrorClass<InspectorRuntimeError>()(
  "InspectorRuntimeError",
  {
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
    operation: Schema.String,
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {}

export interface WorkerInspectorFrameSink {
  readonly emit: (frame: InspectorWorkerFrame) => Effect.Effect<void, InspectorRuntimeError>;
}

export interface InspectorVisualBackend {
  readonly capabilities: {
    readonly browserFrames: boolean;
    readonly browserInput: boolean;
    readonly desktopFrames: boolean;
    readonly desktopInput: boolean;
  };
  readonly perform: (
    operation: Extract<
      InspectorOperation,
      {
        readonly type:
          | "browser.start"
          | "browser.navigate"
          | "browser.input"
          | "browser.capture"
          | "browser.stop"
          | "desktop.start"
          | "desktop.input"
          | "desktop.capture"
          | "desktop.stop";
      }
    >,
  ) => Effect.Effect<
    | { readonly type: "ack" }
    | {
        readonly type: "artifact";
        readonly kind: "browser-frame" | "desktop-frame";
        readonly mediaType: string;
        readonly bytes: Uint8Array;
      },
    InspectorRuntimeError
  >;
  readonly close: Effect.Effect<void>;
}

export interface InspectorPortBackend {
  readonly list: Effect.Effect<ReadonlyArray<InspectorPort>, InspectorRuntimeError>;
  readonly expose: (
    port: number,
    protocol: "http" | "https",
  ) => Effect.Effect<ReadonlyArray<InspectorPort>, InspectorRuntimeError>;
  readonly close: (
    port: number,
  ) => Effect.Effect<ReadonlyArray<InspectorPort>, InspectorRuntimeError>;
}

export interface WorkerInspectorRuntime {
  readonly handle: (
    command: InspectorWorkerCommand,
    sink: WorkerInspectorFrameSink,
  ) => Effect.Effect<void, never>;
  /** Waits for currently admitted requests and PTY output callbacks to settle. */
  readonly drain: Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
}

interface InspectorSessionState {
  readonly id: InspectorSessionId;
  binding: InspectorRouteBinding;
  sequence: number;
  readonly history: Array<InspectorSequencedWorkerFrame>;
  historyBytes: number;
  readonly requests: Map<InspectorRequestId, Fiber.Fiber<void, never>>;
  requestWindowStartedAt: number;
  requestsInWindow: number;
  artifactCount: number;
  artifactBytes: number;
}

interface InspectorTerminalState {
  readonly process: IPty;
  readonly sessionId: InspectorSessionId;
  readonly redact: (chunk: string, final?: boolean) => string;
  readonly disposeListeners: () => void;
  retirementReason?: "killed" | "resource-limit";
  retirementStarted: boolean;
  pendingBytes: number;
  processing: Promise<void>;
}

const noPorts: InspectorPortBackend = {
  list: Effect.succeed([]),
  expose: () =>
    Effect.fail(
      new InspectorRuntimeError({
        code: "unsupported",
        retryable: false,
        operation: "ports.expose",
      }),
    ),
  close: () =>
    Effect.fail(
      new InspectorRuntimeError({
        code: "unsupported",
        retryable: false,
        operation: "ports.close",
      }),
    ),
};

const noVisuals: InspectorVisualBackend = {
  capabilities: {
    browserFrames: false,
    browserInput: false,
    desktopFrames: false,
    desktopInput: false,
  },
  perform: (operation) =>
    Effect.fail(
      new InspectorRuntimeError({
        code: "unsupported",
        retryable: false,
        operation: operation.type,
      }),
    ),
  close: Effect.void,
};

type AllowedShell = "/bin/bash" | "/bin/sh" | "/bin/zsh";
const allowedShells = new Set<AllowedShell>(["/bin/bash", "/bin/sh", "/bin/zsh"]);
const isAllowedShell = (value: string): value is AllowedShell =>
  allowedShells.has(value as AllowedShell);

const sensitivePath =
  /(?:^|\/)(?:\.agentsin|\.aws|\.azure|\.docker|\.kube|\.config\/(?:gh|gcloud|git|op|railway|vercel)|\.env[^/]*|\.git|\.gitconfig[^/]*|\.git-credentials[^/]*|\.gnupg|\.netrc[^/]*|\.npmrc[^/]*|\.pki|\.ssh|credentials?(?:[._-][^/]*)?|secrets?(?:[._-][^/]*)?|wallet(?:[._-][^/]*)?)(?:\/|$)/i;

const safeDetail = (error: InspectorRuntimeError) => {
  switch (error.code) {
    case "unsupported":
      return "This inspector capability is unavailable";
    case "not-found":
      return "The requested inspector resource was not found";
    case "conflict":
      return "The inspector resource changed before the operation completed";
    case "limit-exceeded":
      return "The inspector operation exceeded a safety limit";
    case "cancelled":
      return "The inspector operation was cancelled";
    default:
      return "Inspector operation failed";
  }
};

const isInspectorRuntimeError = Schema.is(InspectorRuntimeError);
const errorFrom = (
  operation: string,
  cause: unknown,
  code: InspectorRuntimeError["code"] = "internal",
) =>
  isInspectorRuntimeError(cause)
    ? cause
    : cause instanceof ContainedWorkspaceError
      ? new InspectorRuntimeError({
          code: cause.code,
          retryable: false,
          operation: cause.operation,
          cause: cause.cause,
        })
      : new InspectorRuntimeError({ code, retryable: false, operation, cause });

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const baseCapabilities = (
  visuals: InspectorVisualBackend,
  ports: InspectorPortBackend,
): InspectorCapabilities => ({
  terminal: true,
  files: true,
  ports: ports !== noPorts,
  browserFrames: visuals.capabilities.browserFrames,
  browserInput: visuals.capabilities.browserInput,
  desktopFrames: visuals.capabilities.desktopFrames,
  desktopInput: visuals.capabilities.desktopInput,
  desktopBackend:
    visuals.capabilities.desktopFrames || visuals.capabilities.desktopInput
      ? "injected"
      : "unsupported",
});

export interface NodeInspectorRuntimeOptions {
  readonly workspaceDirectory: string;
  readonly protectedPaths?: ReadonlyArray<string>;
  /** Broker-owned streaming redactor; the runtime never receives secret values. */
  readonly makeInspectorOutputRedactor?: () => (chunk: string, final?: boolean) => string;
  readonly ptySandbox?: InspectorPtySandbox;
  readonly requirePtyNamespace?: boolean;
  readonly requireLinuxDescriptorTraversal?: boolean;
  readonly untrustedUid?: number;
  readonly additionalUntrustedUids?: ReadonlyArray<number>;
  readonly ports?: InspectorPortBackend;
  readonly visuals?: InspectorVisualBackend;
  readonly now?: () => string;
  readonly loadPty?: () => Promise<typeof import("node-pty")>;
  readonly maxSessions?: number;
  readonly maxHistoryFrames?: number;
  readonly maxHistoryBytes?: number;
  readonly maxConcurrentRequests?: number;
  readonly maxTerminalsPerSession?: number;
  readonly maxArtifactsPerSession?: number;
  readonly maxArtifactBytesPerSession?: number;
  readonly maxRequestsPerMinute?: number;
  readonly requestDeadlineMs?: number;
  readonly nowMs?: () => number;
  readonly testHooks?: ContainedWorkspaceTestHooks;
  /** Final worker-side fence, evaluated inside the queued request immediately before visual input. */
  readonly authorizeVisualInput?: (input: {
    readonly binding: InspectorRouteBinding;
    readonly permit: DesktopInputPermit;
    readonly operation: Extract<
      InspectorOperation,
      { readonly type: "browser.input" | "desktop.input" }
    >;
  }) => Effect.Effect<void, InspectorRuntimeError>;
}

type InspectorSequencedWorkerFrame = Exclude<
  InspectorWorkerFrame,
  { readonly type: "inspector.resume-rejected" }
>;

type InspectorWorkerFrameBody = InspectorSequencedWorkerFrame extends infer Frame
  ? Frame extends InspectorSequencedWorkerFrame
    ? Omit<Frame, "binding" | "sessionId" | "sequence" | "emittedAt">
    : never
  : never;

const encodeWorkerFrame = Schema.encodeUnknownSync(Schema.fromJsonString(InspectorWorkerFrame));

export const makeNodeInspectorRuntime = (
  options: NodeInspectorRuntimeOptions,
): Effect.Effect<WorkerInspectorRuntime, InspectorRuntimeError> =>
  Effect.gen(function* () {
    const hostPlatform = yield* HostProcessPlatform;
    const workspace = yield* Effect.tryPromise({
      try: () =>
        openContainedWorkspace({
          workspaceDirectory: options.workspaceDirectory,
          hostPlatform,
          ...(options.requireLinuxDescriptorTraversal === undefined
            ? {}
            : { requireLinuxDescriptorTraversal: options.requireLinuxDescriptorTraversal }),
          ...(options.untrustedUid === undefined ? {} : { untrustedUid: options.untrustedUid }),
          ...(options.additionalUntrustedUids === undefined
            ? {}
            : { additionalUntrustedUids: options.additionalUntrustedUids }),
          ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
        }),
      catch: (cause) => errorFrom("workspace-root", cause, "not-found"),
    });
    const runQuiescentPromise = <A>(
      operation: string,
      run: (signal: AbortSignal) => Promise<A>,
      code: InspectorRuntimeError["code"] = "internal",
    ): Effect.Effect<A, InspectorRuntimeError> =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const controller = new AbortController();
          const promise = run(controller.signal);
          return { controller, promise };
        }),
        ({ promise }) =>
          Effect.tryPromise({
            try: () => promise,
            catch: (cause) => errorFrom(operation, cause, code),
          }),
        ({ controller, promise }) =>
          Effect.sync(() => controller.abort()).pipe(
            Effect.andThen(
              Effect.promise(() =>
                promise.then(
                  () => undefined,
                  () => undefined,
                ),
              ),
            ),
          ),
      );

    if (options.protectedPaths !== undefined && options.protectedPaths.length > 0) {
      yield* runQuiescentPromise(
        "workspace-protected-paths",
        (signal) => workspace.assertDisjointProtectedPaths(options.protectedPaths ?? [], signal),
        "invalid-operation",
      ).pipe(Effect.tapError(() => Effect.promise(() => workspace.close())));
    }

    const ptyModule = yield* Effect.tryPromise({
      try: options.loadPty ?? (() => import("node-pty")),
      catch: (cause) => errorFrom("load-pty", cause, "unsupported"),
    });
    const ports = options.ports ?? noPorts;
    const visuals = options.visuals ?? noVisuals;
    const now = options.now ?? (() => DateTime.formatIso(DateTime.nowUnsafe()));
    const maxSessions = options.maxSessions ?? 8;
    const maxHistoryFrames = options.maxHistoryFrames ?? 256;
    const maxHistoryBytes = options.maxHistoryBytes ?? 2 * 1024 * 1024;
    const maxConcurrentRequests = options.maxConcurrentRequests ?? INSPECTOR_MAX_INFLIGHT_REQUESTS;
    const maxTerminalsPerSession =
      options.maxTerminalsPerSession ?? INSPECTOR_MAX_TERMINALS_PER_SESSION;
    const maxArtifactsPerSession =
      options.maxArtifactsPerSession ?? INSPECTOR_MAX_ARTIFACTS_PER_SESSION;
    const maxArtifactBytesPerSession =
      options.maxArtifactBytesPerSession ?? INSPECTOR_MAX_ARTIFACT_BYTES_PER_SESSION;
    const maxRequestsPerMinute = options.maxRequestsPerMinute ?? INSPECTOR_MAX_REQUESTS_PER_MINUTE;
    const requestDeadlineMs = options.requestDeadlineMs ?? 30_000;
    const nowMs = options.nowMs ?? Date.now;
    const bounded = [
      ["maxSessions", maxSessions, 1, 64],
      ["maxHistoryFrames", maxHistoryFrames, 1, 4_096],
      ["maxHistoryBytes", maxHistoryBytes, INSPECTOR_MAX_FRAME_BYTES, 64 * 1024 * 1024],
      ["maxConcurrentRequests", maxConcurrentRequests, 1, 32],
      ["maxTerminalsPerSession", maxTerminalsPerSession, 1, 16],
      ["maxArtifactsPerSession", maxArtifactsPerSession, 1, 1_024],
      [
        "maxArtifactBytesPerSession",
        maxArtifactBytesPerSession,
        INSPECTOR_MAX_ARTIFACT_TRANSFER_BYTES,
        128 * 1024 * 1024,
      ],
      ["maxRequestsPerMinute", maxRequestsPerMinute, 1, 10_000],
      ["requestDeadlineMs", requestDeadlineMs, 100, 300_000],
    ] as const;
    for (const [name, value, minimum, maximum] of bounded) {
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        yield* Effect.promise(() => workspace.close());
        return yield* new InspectorRuntimeError({
          code: "invalid-operation",
          retryable: false,
          operation: `configure-${name}`,
        });
      }
    }
    const ptySandbox = options.ptySandbox;
    if (
      options.requirePtyNamespace === true &&
      (ptySandbox?.filesystemIsolated !== true || ptySandbox.networkIsolated !== true)
    ) {
      yield* Effect.promise(() => workspace.close());
      return yield* new InspectorRuntimeError({
        code: "unsupported",
        retryable: false,
        operation: "pty-namespace",
      });
    }
    const sessions = new Map<InspectorSessionId, InspectorSessionState>();
    const terminals = new Map<string, InspectorTerminalState>();
    const terminalReservations = new Set<string>();
    const makeInspectorOutputRedactor =
      options.makeInspectorOutputRedactor ?? (() => (chunk: string) => chunk);

    const terminalKey = (sessionId: InspectorSessionId, terminalId: string) =>
      `${sessionId}\0${terminalId}`;

    const emit = (
      session: InspectorSessionState,
      sink: WorkerInspectorFrameSink,
      frame: InspectorWorkerFrameBody,
      onRecorded?: () => void,
    ) =>
      Effect.gen(function* () {
        const next = {
          ...frame,
          binding: session.binding,
          sessionId: session.id,
          sequence: session.sequence++,
          emittedAt: now(),
        } as InspectorSequencedWorkerFrame;
        const bytes = Buffer.byteLength(encodeWorkerFrame(next));
        if (bytes > INSPECTOR_MAX_FRAME_BYTES) {
          return yield* new InspectorRuntimeError({
            code: "limit-exceeded",
            retryable: false,
            operation: "emit-frame",
          });
        }
        session.history.push(next);
        session.historyBytes += bytes;
        while (
          session.history.length > maxHistoryFrames ||
          session.historyBytes > maxHistoryBytes
        ) {
          const removed = session.history.shift();
          if (removed !== undefined)
            session.historyBytes -= Buffer.byteLength(encodeWorkerFrame(removed));
        }
        onRecorded?.();
        yield* sink.emit(next);
      });

    const emitResumeRejected = (
      session: InspectorSessionState,
      sink: WorkerInspectorFrameSink,
      input: {
        readonly requestedAfterSequence: InspectorResumeCursor;
        readonly earliestAvailableSequence: InspectorResumeCursor;
        readonly latestSequence: InspectorResumeCursor;
        readonly reason: "history-evicted" | "session-unavailable";
      },
    ) =>
      sink.emit({
        type: "inspector.resume-rejected",
        binding: session.binding,
        sessionId: session.id,
        emittedAt: now(),
        ...input,
      });

    const emitError = (
      session: InspectorSessionState,
      sink: WorkerInspectorFrameSink,
      requestId: InspectorRequestId | undefined,
      cause: unknown,
    ) => {
      const error = errorFrom("request", cause);
      return emit(session, sink, {
        type: "inspector.error",
        ...(requestId === undefined ? {} : { requestId }),
        code: error.code,
        retryable: error.retryable,
        detail: safeDetail(error),
      });
    };

    const emitArtifact = (
      session: InspectorSessionState,
      sink: WorkerInspectorFrameSink,
      requestId: InspectorRequestId,
      kind: "terminal-chunk" | "browser-frame" | "desktop-frame",
      mediaType: string,
      bytes: Uint8Array,
    ) => {
      if (
        bytes.byteLength > INSPECTOR_MAX_ARTIFACT_TRANSFER_BYTES ||
        session.artifactCount >= maxArtifactsPerSession ||
        session.artifactBytes + bytes.byteLength > maxArtifactBytesPerSession
      ) {
        return Effect.fail(
          new InspectorRuntimeError({
            code: "limit-exceeded",
            retryable: false,
            operation: "artifact",
          }),
        );
      }
      session.artifactCount += 1;
      session.artifactBytes += bytes.byteLength;
      return emit(session, sink, {
        type: "inspector.artifact.proposed",
        requestId,
        artifact: {
          artifactId: NodeCrypto.randomUUID() as never,
          kind,
          mediaType,
          byteLength: bytes.byteLength,
          sha256: sha256(bytes),
        },
        base64: Buffer.from(bytes).toString("base64"),
      }).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            session.artifactCount -= 1;
            session.artifactBytes -= bytes.byteLength;
          }),
        ),
      );
    };

    const emitTerminalOutput = (
      session: InspectorSessionState,
      sink: WorkerInspectorFrameSink,
      requestId: InspectorRequestId,
      terminalId: InspectorTerminalId,
      data: string,
    ) => {
      const bytes = Buffer.from(data);
      if (bytes.byteLength <= INSPECTOR_MAX_INLINE_BYTES) {
        return emit(session, sink, {
          type: "terminal.chunk",
          requestId,
          terminalId,
          stream: "stdout",
          data,
        });
      }
      const chunks: Array<Uint8Array> = [];
      for (
        let offset = 0;
        offset < bytes.byteLength;
        offset += INSPECTOR_MAX_ARTIFACT_TRANSFER_BYTES
      ) {
        chunks.push(bytes.subarray(offset, offset + INSPECTOR_MAX_ARTIFACT_TRANSFER_BYTES));
      }
      return Effect.forEach(
        chunks,
        (chunk) => emitArtifact(session, sink, requestId, "terminal-chunk", "text/plain", chunk),
        { discard: true },
      );
    };

    const handleOperation = (
      session: InspectorSessionState,
      operation: InspectorOperation,
      sink: WorkerInspectorFrameSink,
      desktopPermit?: DesktopInputPermit,
    ): Effect.Effect<void, InspectorRuntimeError> =>
      Effect.gen(function* () {
        switch (operation.type) {
          case "capabilities.get":
            yield* emit(session, sink, {
              type: "inspector.ready",
              capabilities: baseCapabilities(visuals, ports),
            });
            break;
          case "terminal.open": {
            if (operation.executable !== "shell") {
              return yield* new InspectorRuntimeError({
                code: "unsupported",
                retryable: false,
                operation: operation.type,
              });
            }
            const key = terminalKey(session.id, operation.terminalId);
            const shell =
              process.env.SHELL !== undefined && isAllowedShell(process.env.SHELL)
                ? process.env.SHELL
                : "/bin/bash";
            const mount = yield* runQuiescentPromise(
              operation.type,
              (signal) => workspace.sealedRootMount(signal),
              "conflict",
            );
            yield* Effect.acquireUseRelease(
              Effect.try({
                try: () => ({
                  child:
                    ptySandbox?.spawn({
                      workspaceMountSource: mount.source,
                      workspaceMountIdentity: mount.identity,
                      shell,
                      columns: operation.columns,
                      rows: operation.rows,
                    }) ??
                    ptyModule.spawn(shell, ["-l"], {
                      cwd: mount.source,
                      cols: operation.columns,
                      rows: operation.rows,
                      name: "xterm-256color",
                      env: {
                        PATH: "/usr/local/bin:/usr/bin:/bin",
                        HOME: mount.source,
                        LANG: "C.UTF-8",
                        TERM: "xterm-256color",
                      },
                    }),
                  committed: false,
                }),
                catch: (cause) => errorFrom(operation.type, cause),
              }),
              (acquired) =>
                Effect.gen(function* () {
                  const child = acquired.child;
                  let dataSubscription: { dispose: () => void } | undefined;
                  let exitSubscription: { dispose: () => void } | undefined;
                  const terminal: InspectorTerminalState = {
                    process: child,
                    sessionId: session.id,
                    redact: makeInspectorOutputRedactor(),
                    disposeListeners: () => {
                      dataSubscription?.dispose();
                      exitSubscription?.dispose();
                    },
                    pendingBytes: 0,
                    processing: Promise.resolve(),
                    retirementStarted: false,
                  };
                  terminals.set(key, terminal);
                  dataSubscription = child.onData((data) => {
                    if (!sessions.has(session.id)) return;
                    const redacted = terminal.redact(data);
                    const bytes = Buffer.byteLength(redacted);
                    if (bytes === 0) return;
                    if (terminal.pendingBytes + bytes > maxHistoryBytes) {
                      terminal.retirementReason = "resource-limit";
                      terminal.process.kill();
                      return;
                    }
                    terminal.pendingBytes += bytes;
                    terminal.processing = terminal.processing
                      .then(() =>
                        Effect.runPromise(
                          emitTerminalOutput(
                            session,
                            sink,
                            operation.requestId,
                            operation.terminalId,
                            redacted,
                          ).pipe(Effect.ignore),
                        ),
                      )
                      .finally(() => {
                        terminal.pendingBytes -= bytes;
                      });
                  });
                  exitSubscription = child.onExit((event) => {
                    if (terminal.retirementStarted) return;
                    terminal.retirementStarted = true;
                    const redacted = terminal.redact("", true);
                    const reason =
                      terminal.retirementReason ?? (event.signal === 0 ? "exited" : "killed");
                    terminal.processing = terminal.processing
                      .then(() =>
                        Effect.runPromise(
                          Effect.gen(function* () {
                            if (redacted.length > 0 && sessions.has(session.id)) {
                              yield* emitTerminalOutput(
                                session,
                                sink,
                                operation.requestId,
                                operation.terminalId,
                                redacted,
                              ).pipe(Effect.ignore);
                            }
                            if (sessions.has(session.id)) {
                              yield* emit(session, sink, {
                                type: "terminal.retired",
                                terminalId: operation.terminalId,
                                reason,
                              }).pipe(Effect.ignore);
                            }
                          }),
                        ),
                      )
                      .finally(() => {
                        terminal.disposeListeners();
                        terminals.delete(key);
                      });
                  });
                  // Recording the ACK makes it replayable and is therefore the
                  // logical commit point, even when the current relay send fails.
                  yield* Effect.uninterruptible(
                    emit(
                      session,
                      sink,
                      {
                        type: "inspector.ack",
                        requestId: operation.requestId,
                      },
                      () => {
                        acquired.committed = true;
                      },
                    ).pipe(
                      Effect.tapError(() =>
                        Effect.gen(function* () {
                          const shouldRecord = yield* Effect.sync(() => {
                            if (terminal.retirementStarted) return false;
                            terminal.retirementStarted = true;
                            terminal.retirementReason = "killed";
                            return true;
                          });
                          if (shouldRecord) {
                            yield* emit(session, sink, {
                              type: "terminal.retired",
                              terminalId: operation.terminalId,
                              reason: "killed",
                            }).pipe(Effect.ignore);
                            yield* Effect.sync(() => {
                              try {
                                terminal.process.kill();
                              } finally {
                                terminal.disposeListeners();
                                terminals.delete(key);
                              }
                            });
                          }
                        }),
                      ),
                    ),
                  );
                }),
              (acquired) =>
                Effect.sync(() => {
                  if (acquired.committed) return;
                  const terminal = terminals.get(key);
                  terminal?.disposeListeners();
                  terminals.delete(key);
                  acquired.child.kill();
                }),
            );
            break;
          }
          case "terminal.write": {
            const terminal = terminals.get(terminalKey(session.id, operation.terminalId));
            if (terminal === undefined) {
              return yield* new InspectorRuntimeError({
                code: "not-found",
                retryable: false,
                operation: operation.type,
              });
            }
            terminal.process.write(operation.data);
            yield* emit(session, sink, { type: "inspector.ack", requestId: operation.requestId });
            break;
          }
          case "terminal.resize": {
            const terminal = terminals.get(terminalKey(session.id, operation.terminalId));
            if (terminal === undefined) {
              return yield* new InspectorRuntimeError({
                code: "not-found",
                retryable: false,
                operation: operation.type,
              });
            }
            terminal.process.resize(operation.columns, operation.rows);
            yield* emit(session, sink, { type: "inspector.ack", requestId: operation.requestId });
            break;
          }
          case "terminal.close": {
            const key = terminalKey(session.id, operation.terminalId);
            const terminal = terminals.get(key);
            if (terminal !== undefined && !terminal.retirementStarted) {
              terminal.retirementStarted = true;
              terminal.disposeListeners();
              terminal.retirementReason = "killed";
              terminal.process.kill();
              terminals.delete(key);
              yield* emit(session, sink, {
                type: "terminal.retired",
                terminalId: operation.terminalId,
                reason: "killed",
              });
            }
            yield* emit(session, sink, { type: "inspector.ack", requestId: operation.requestId });
            break;
          }
          case "files.list": {
            if (sensitivePath.test(operation.path)) {
              return yield* new InspectorRuntimeError({
                code: "not-found",
                retryable: false,
                operation: operation.type,
              });
            }
            const entries = yield* runQuiescentPromise(
              operation.type,
              (signal) =>
                workspace.list(
                  operation.path,
                  operation.limit,
                  (path) => sensitivePath.test(path),
                  signal,
                ),
              "not-found",
            );
            yield* emit(session, sink, {
              type: "files.entries",
              requestId: operation.requestId,
              path: operation.path,
              entries,
            });
            break;
          }
          case "files.read": {
            if (sensitivePath.test(operation.path)) {
              return yield* new InspectorRuntimeError({
                code: "not-found",
                retryable: false,
                operation: operation.type,
              });
            }
            const bytes = yield* runQuiescentPromise(operation.type, (signal) =>
              workspace.read(operation.path, operation.offset, operation.length, signal),
            );
            yield* emit(session, sink, {
              type: "files.contents",
              requestId: operation.requestId,
              path: operation.path,
              encoding: "base64",
              contents: bytes.bytes.toString("base64"),
              sha256: sha256(bytes.bytes),
              eof: bytes.eof,
            });
            break;
          }
          case "files.write": {
            if (sensitivePath.test(operation.path)) {
              return yield* new InspectorRuntimeError({
                code: "not-found",
                retryable: false,
                operation: operation.type,
              });
            }
            if (
              operation.encoding === "base64" &&
              Buffer.from(operation.contents, "base64").toString("base64") !== operation.contents
            ) {
              return yield* new InspectorRuntimeError({
                code: "invalid-operation",
                retryable: false,
                operation: operation.type,
              });
            }
            const bytes = Buffer.from(operation.contents, operation.encoding);
            if (bytes.byteLength > INSPECTOR_MAX_FILE_BYTES) {
              return yield* new InspectorRuntimeError({
                code: "limit-exceeded",
                retryable: false,
                operation: operation.type,
              });
            }
            yield* runQuiescentPromise(operation.type, (signal) =>
              workspace.write(operation.path, bytes, operation.expectedSha256, signal),
            );
            yield* emit(session, sink, { type: "inspector.ack", requestId: operation.requestId });
            break;
          }
          case "ports.list":
          case "ports.expose":
          case "ports.close": {
            if (
              operation.type !== "ports.list" &&
              (operation.port < INSPECTOR_ALLOWED_PORT_MIN ||
                operation.port > INSPECTOR_ALLOWED_PORT_MAX)
            ) {
              return yield* new InspectorRuntimeError({
                code: "invalid-operation",
                retryable: false,
                operation: operation.type,
              });
            }
            const snapshot =
              operation.type === "ports.list"
                ? yield* ports.list
                : operation.type === "ports.expose"
                  ? yield* ports.expose(operation.port, operation.protocol)
                  : yield* ports.close(operation.port);
            yield* emit(session, sink, {
              type: "ports.snapshot",
              requestId: operation.requestId,
              ports: snapshot,
            });
            break;
          }
          default: {
            if (operation.type === "browser.input" || operation.type === "desktop.input") {
              if (desktopPermit === undefined || options.authorizeVisualInput === undefined) {
                return yield* new InspectorRuntimeError({
                  code: "invalid-operation",
                  retryable: false,
                  operation: "authorize-visual-input",
                });
              }
              yield* options.authorizeVisualInput({
                binding: session.binding,
                permit: desktopPermit,
                operation,
              });
            }
            const result = yield* visuals.perform(operation);
            if (result.type === "artifact") {
              yield* emitArtifact(
                session,
                sink,
                operation.requestId,
                result.kind,
                result.mediaType,
                result.bytes,
              );
            } else {
              yield* emit(session, sink, { type: "inspector.ack", requestId: operation.requestId });
            }
          }
        }
      });

    const closeSession = (sessionId: InspectorSessionId) =>
      Effect.gen(function* () {
        const session = sessions.get(sessionId);
        sessions.delete(sessionId);
        if (session !== undefined) {
          for (const fiber of session.requests.values()) {
            yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
          }
          session.requests.clear();
        }
        for (const [key, terminal] of terminals) {
          if (terminal.sessionId !== sessionId) continue;
          terminal.disposeListeners();
          terminal.process.kill();
          terminals.delete(key);
        }
      });

    const sameBinding = (left: InspectorRouteBinding, right: InspectorRouteBinding) =>
      left.workspaceId === right.workspaceId &&
      left.threadId === right.threadId &&
      left.attemptId === right.attemptId &&
      left.environmentId === right.environmentId &&
      left.environmentRevisionId === right.environmentRevisionId &&
      left.providerInstanceId === right.providerInstanceId &&
      left.providerDriver === right.providerDriver &&
      left.sandboxId === right.sandboxId &&
      left.workerId === right.workerId;

    const emptySession = (
      command: Extract<InspectorWorkerCommand, { readonly type: "inspector.open" }>,
      sequence: number,
    ): InspectorSessionState => ({
      id: command.sessionId,
      binding: command.binding,
      sequence,
      history: [],
      historyBytes: 0,
      requests: new Map(),
      requestWindowStartedAt: nowMs(),
      requestsInWindow: 0,
      artifactCount: 0,
      artifactBytes: 0,
    });

    const launchRequest = (
      session: InspectorSessionState,
      operation: InspectorOperation,
      sink: WorkerInspectorFrameSink,
      desktopPermit?: DesktopInputPermit,
    ) =>
      Effect.gen(function* () {
        const nowValue = nowMs();
        if (nowValue - session.requestWindowStartedAt >= 60_000) {
          session.requestWindowStartedAt = nowValue;
          session.requestsInWindow = 0;
        }
        if (
          session.requests.has(operation.requestId) ||
          session.requests.size >= maxConcurrentRequests ||
          session.requestsInWindow >= maxRequestsPerMinute
        ) {
          yield* emitError(
            session,
            sink,
            operation.requestId,
            new InspectorRuntimeError({
              code: "limit-exceeded",
              retryable: false,
              operation: operation.type,
            }),
          ).pipe(Effect.ignore);
          return;
        }
        let terminalReservation: string | undefined;
        if (operation.type === "terminal.open") {
          terminalReservation = terminalKey(session.id, operation.terminalId);
          const sessionTerminalCount =
            [...terminals.values()].filter((terminal) => terminal.sessionId === session.id).length +
            [...terminalReservations].filter((key) => key.startsWith(`${session.id}\0`)).length;
          if (
            terminals.has(terminalReservation) ||
            terminalReservations.has(terminalReservation) ||
            sessionTerminalCount >= maxTerminalsPerSession ||
            terminals.size + terminalReservations.size >= maxSessions * maxTerminalsPerSession
          ) {
            yield* emitError(
              session,
              sink,
              operation.requestId,
              new InspectorRuntimeError({
                code: "limit-exceeded",
                retryable: false,
                operation: operation.type,
              }),
            ).pipe(Effect.ignore);
            return;
          }
          terminalReservations.add(terminalReservation);
        }
        session.requestsInWindow += 1;
        const timedOut = new InspectorRuntimeError({
          code: "limit-exceeded",
          retryable: false,
          operation: `${operation.type}-deadline`,
        });
        const operationTask = handleOperation(session, operation, sink, desktopPermit).pipe(
          Effect.timeoutOrElse({
            duration: `${requestDeadlineMs} millis`,
            orElse: () => Effect.fail(timedOut),
          }),
          Effect.matchEffect({
            onFailure: (cause) =>
              emitError(session, sink, operation.requestId, cause).pipe(
                Effect.andThen(
                  emit(session, sink, {
                    type: "inspector.complete",
                    requestId: operation.requestId,
                  }),
                ),
                Effect.ignore,
              ),
            onSuccess: () =>
              emit(session, sink, {
                type: "inspector.complete",
                requestId: operation.requestId,
              }).pipe(Effect.ignore),
          }),
          Effect.ensuring(
            terminalReservation === undefined
              ? Effect.void
              : Effect.sync(() => terminalReservations.delete(terminalReservation)),
          ),
        );
        let requestFiber: Fiber.Fiber<void, never> | undefined;
        const task = Effect.yieldNow.pipe(
          Effect.andThen(operationTask),
          Effect.ensuring(
            Effect.sync(() => {
              if (session.requests.get(operation.requestId) === requestFiber) {
                session.requests.delete(operation.requestId);
              }
            }),
          ),
        );
        const fiber = yield* Effect.forkDetach(task);
        requestFiber = fiber;
        session.requests.set(operation.requestId, fiber);
        if (fiber.pollUnsafe() !== undefined) session.requests.delete(operation.requestId);
      });

    return {
      handle: (command, sink) =>
        Effect.gen(function* () {
          if (command.type === "inspector.open") {
            const existing = sessions.get(command.sessionId);
            if (existing === undefined && sessions.size >= maxSessions) return;
            if (existing === undefined && command.resumeAfterSequence !== -1) {
              const rejected = emptySession(command, command.resumeAfterSequence + 1);
              yield* emitResumeRejected(rejected, sink, {
                requestedAfterSequence: command.resumeAfterSequence,
                earliestAvailableSequence: -1,
                latestSequence: -1,
                reason: "session-unavailable",
              }).pipe(Effect.ignore);
              return;
            }
            const session = existing ?? emptySession(command, 0);
            if (
              existing !== undefined &&
              (!sameBinding(existing.binding, command.binding) ||
                command.binding.routeGeneration < existing.binding.routeGeneration)
            ) {
              return;
            }
            const earliest = session.history[0]?.sequence ?? session.sequence;
            if (
              existing !== undefined &&
              (command.resumeAfterSequence + 1 < earliest ||
                command.resumeAfterSequence >= session.sequence)
            ) {
              yield* emitResumeRejected(session, sink, {
                requestedAfterSequence: command.resumeAfterSequence,
                earliestAvailableSequence: earliest as InspectorResumeCursor,
                latestSequence: (session.sequence - 1) as InspectorResumeCursor,
                reason: "history-evicted",
              }).pipe(Effect.ignore);
              return;
            }
            session.binding = command.binding;
            sessions.set(command.sessionId, session);
            for (const frame of session.history) {
              if (frame.sequence <= command.resumeAfterSequence) continue;
              yield* sink.emit({ ...frame, binding: command.binding }).pipe(Effect.ignore);
            }
            yield* emit(session, sink, {
              type: "inspector.ready",
              capabilities: baseCapabilities(visuals, ports),
            }).pipe(Effect.ignore);
            return;
          }
          const session = sessions.get(command.sessionId);
          if (session === undefined) return;
          if (
            !sameBinding(command.binding, session.binding) ||
            command.binding.routeGeneration < session.binding.routeGeneration
          ) {
            return;
          }
          session.binding = command.binding;
          if (command.type === "inspector.cancel") {
            const fiber = session.requests.get(command.requestId);
            if (fiber !== undefined) {
              session.requests.delete(command.requestId);
              yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
              yield* emitError(
                session,
                sink,
                command.requestId,
                new InspectorRuntimeError({
                  code: "cancelled",
                  retryable: false,
                  operation: "inspector.cancel",
                }),
              ).pipe(
                Effect.andThen(
                  emit(session, sink, {
                    type: "inspector.complete",
                    requestId: command.requestId,
                  }),
                ),
                Effect.ignore,
              );
            }
            return;
          }
          if (command.type === "inspector.close") {
            yield* closeSession(command.sessionId);
            return;
          }
          yield* launchRequest(session, command.operation, sink, command.desktopPermit);
        }),
      drain: Effect.gen(function* () {
        const fibers = [...sessions.values()].flatMap((session) => [...session.requests.values()]);
        yield* Effect.forEach(fibers, (fiber) => Fiber.await(fiber), { discard: true });
        yield* Effect.promise(() =>
          Promise.allSettled([...terminals.values()].map((terminal) => terminal.processing)).then(
            () => undefined,
          ),
        );
      }),
      close: Effect.gen(function* () {
        for (const sessionId of sessions.keys()) yield* closeSession(sessionId);
        yield* visuals.close.pipe(Effect.ignore);
        yield* Effect.promise(() => workspace.close()).pipe(Effect.ignore);
      }),
    } satisfies WorkerInspectorRuntime;
  });
