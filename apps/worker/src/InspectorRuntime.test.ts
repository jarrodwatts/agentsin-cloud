// @effect-diagnostics nodeBuiltinImport:off -- Tests use disposable filesystem roots and a fake PTY.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  INSPECTOR_MAX_FILE_BYTES,
  InspectorOperation,
  InspectorWorkerFrame,
  type InspectorRouteBinding,
  type InspectorWorkerCommand,
} from "@t3tools/contracts/inspector";
import type { DesktopInputPermit } from "@t3tools/contracts/desktop-lease";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import {
  InspectorRuntimeError,
  makeNodeInspectorRuntime,
  type InspectorPortBackend,
  type InspectorVisualBackend,
  type NodeInspectorRuntimeOptions,
} from "./InspectorRuntime.ts";

const binding: InspectorRouteBinding = {
  protocolVersion: 1,
  workspaceId: "workspace-1" as never,
  threadId: "thread-1" as never,
  attemptId: "attempt-1" as never,
  environmentId: "environment-1" as never,
  environmentRevisionId: "revision-1" as never,
  providerInstanceId: "codex_personal" as never,
  providerDriver: "codex" as never,
  sandboxId: "sandbox-1" as never,
  workerId: "worker-1" as never,
  routeGeneration: 1,
};
const encodeFrames = Schema.encodeUnknownSync(
  Schema.fromJsonString(Schema.Array(InspectorWorkerFrame)),
);

class FakePty {
  pid = 100;
  killCount = 0;
  readonly writes: Array<string> = [];
  private data: ((value: string) => void) | undefined;
  private exit:
    | ((event: { readonly exitCode: number; readonly signal: number }) => void)
    | undefined;

  write(value: string) {
    this.writes.push(value);
  }
  resize() {}
  kill() {
    this.killCount += 1;
    this.exit?.({ exitCode: 0, signal: 0 });
  }
  onData(listener: (value: string) => void) {
    this.data = listener;
    return {
      dispose: () => {
        if (this.data === listener) this.data = undefined;
      },
    };
  }
  onExit(listener: (event: { readonly exitCode: number; readonly signal: number }) => void) {
    this.exit = listener;
    return {
      dispose: () => {
        if (this.exit === listener) this.exit = undefined;
      },
    };
  }
  emit(value: string) {
    this.data?.(value);
  }
}

const testRedactor = (secret: string) => {
  let buffered = "";
  return (chunk: string, final = false) => {
    buffered += chunk;
    const scanThrough = final ? buffered.length : Math.max(0, buffered.length - secret.length + 1);
    let output = "";
    let offset = 0;
    while (offset < scanThrough) {
      if (buffered.startsWith(secret, offset)) {
        output += "[REDACTED]";
        offset += secret.length;
      } else {
        output += buffered[offset];
        offset += 1;
      }
    }
    buffered = buffered.slice(offset);
    return output;
  };
};

const withRuntime = <A, E>(
  use: (input: {
    readonly root: string;
    readonly pty: FakePty;
    readonly frames: Array<InspectorWorkerFrame>;
    readonly handle: (command: InspectorWorkerCommand) => Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
  }) => Effect.Effect<A, E>,
  redactedValues?: ReadonlyArray<string>,
  runtimeOptions: Partial<
    Omit<
      NodeInspectorRuntimeOptions,
      "workspaceDirectory" | "loadPty" | "makeInspectorOutputRedactor"
    >
  > = {},
  interceptFrame?: (frame: InspectorWorkerFrame) => Effect.Effect<void, InspectorRuntimeError>,
) =>
  Effect.scoped(
    Effect.acquireRelease(
      Effect.gen(function* () {
        const root = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agentsin-c6-inspector-")),
        );
        const pty = new FakePty();
        const frames: Array<InspectorWorkerFrame> = [];
        const runtime = yield* makeNodeInspectorRuntime({
          ...runtimeOptions,
          workspaceDirectory: root,
          now: () => "2026-08-27T12:00:00.000Z",
          loadPty: async () => ({ spawn: () => pty }) as never,
          ...(redactedValues?.[0] === undefined
            ? {}
            : { makeInspectorOutputRedactor: () => testRedactor(redactedValues[0]!) }),
        });
        return {
          root,
          pty,
          frames,
          runtime,
          drain: runtime.drain,
          handle: (command: InspectorWorkerCommand) =>
            runtime.handle(command, {
              emit: (frame) =>
                (interceptFrame === undefined ? Effect.void : interceptFrame(frame)).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      frames.push(frame);
                    }),
                  ),
                ),
            }),
        };
      }),
      ({ root, runtime }) =>
        runtime.close.pipe(
          Effect.andThen(Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true }))),
        ),
    ).pipe(Effect.flatMap(use)),
  );

const open = (resumeAfterSequence = -1): InspectorWorkerCommand => ({
  type: "inspector.open",
  binding,
  sessionId: "session-1" as never,
  resumeAfterSequence,
});

const decodeOperation = Schema.decodeUnknownSync(InspectorOperation);
const request = (operation: unknown) =>
  ({
    type: "inspector.request",
    binding,
    sessionId: "session-1",
    operation: decodeOperation(operation),
  }) as InspectorWorkerCommand;

it.effect("confines file access and hides credential-shaped paths", () =>
  withRuntime(({ root, frames, handle, drain }) =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        Promise.all([
          NodeFSP.writeFile(NodePath.join(root, "safe.txt"), "safe"),
          NodeFSP.writeFile(NodePath.join(root, ".env"), "TOKEN=secret"),
          NodeFSP.writeFile(NodePath.join(root, ".env.backup"), "TOKEN=secret"),
          NodeFSP.writeFile(NodePath.join(root, "credentials.json"), "secret"),
        ]),
      );
      const outside = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agentsin-c6-outside-")),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(outside, "secret.txt"), "secret"),
      );
      yield* Effect.promise(() => NodeFSP.symlink(outside, NodePath.join(root, "escape")));

      yield* handle(open());
      yield* handle(request({ type: "files.list", requestId: "list-1", path: ".", limit: 100 }));
      yield* drain;
      const listing = frames.find((frame) => frame.type === "files.entries");
      expect(listing?.type).toBe("files.entries");
      if (listing?.type === "files.entries") {
        expect(listing.entries.map((entry) => entry.name)).toContain("safe.txt");
        expect(listing.entries.map((entry) => entry.name)).not.toContain(".env");
        expect(listing.entries.map((entry) => entry.name)).not.toContain(".env.backup");
        expect(listing.entries.map((entry) => entry.name)).not.toContain("credentials.json");
      }

      yield* handle(
        request({
          type: "files.read",
          requestId: "read-escape",
          path: "escape/secret.txt",
          offset: 0,
          length: 10,
        }),
      );
      yield* handle(
        request({
          type: "files.write",
          requestId: "write-escape",
          path: "escape/new.txt",
          expectedSha256: null,
          encoding: "utf8",
          contents: "escaped",
        }),
      );
      yield* drain;
      expect(
        frames.some(
          (frame) =>
            frame.type === "inspector.error" &&
            frame.requestId === "read-escape" &&
            frame.code !== "internal",
        ),
      ).toBe(true);
      expect(
        frames.some(
          (frame) =>
            frame.type === "inspector.error" &&
            frame.requestId === "write-escape" &&
            frame.code !== "internal",
        ),
      ).toBe(true);
      expect(
        yield* Effect.promise(() =>
          NodeFSP.access(NodePath.join(outside, "new.txt")).then(
            () => false,
            () => true,
          ),
        ),
      ).toBe(true);
      yield* Effect.promise(() => NodeFSP.rm(outside, { recursive: true, force: true }));
    }),
  ),
);

it.effect("denies Git credential and configuration paths for list, read, and write", () =>
  withRuntime(({ root, frames, handle, drain }) =>
    Effect.gen(function* () {
      const sensitive = [
        ".git/config",
        ".git-credentials",
        ".gitconfig",
        ".gitconfig-work",
        ".gitconfigbackup",
        ".git-credentialsbackup",
        ".config/git/config",
        "nested/.git/config.worktree",
        "nested/.git-credentials",
        "nested/.gitconfig",
        "nested/.config/git/credentials",
      ] as const;
      yield* Effect.promise(async () => {
        for (const path of sensitive) {
          const absolute = NodePath.join(root, path);
          await NodeFSP.mkdir(NodePath.dirname(absolute), { recursive: true });
          await NodeFSP.writeFile(absolute, "credential=secret");
        }
      });
      yield* handle(open());

      for (const [index, path] of sensitive.entries()) {
        yield* handle(
          request({
            type: "files.read",
            requestId: `git-read-${index}`,
            path,
            offset: 0,
            length: 64,
          }),
        );
        yield* handle(
          request({
            type: "files.write",
            requestId: `git-write-${index}`,
            path,
            expectedSha256: null,
            encoding: "utf8",
            contents: "overwritten",
          }),
        );
        yield* drain;
      }
      const sensitiveDirectories = [
        ".git",
        ".config/git",
        "nested/.git",
        "nested/.config/git",
      ] as const;
      for (const [index, path] of sensitiveDirectories.entries()) {
        yield* handle(
          request({ type: "files.list", requestId: `git-list-${index}`, path, limit: 100 }),
        );
        yield* drain;
      }

      for (const [index, path] of sensitive.entries()) {
        expect(
          frames.some(
            (frame) =>
              frame.type === "inspector.error" &&
              frame.requestId === `git-read-${index}` &&
              frame.code === "not-found",
          ),
        ).toBe(true);
        expect(
          frames.some(
            (frame) =>
              frame.type === "inspector.error" &&
              frame.requestId === `git-write-${index}` &&
              frame.code === "not-found",
          ),
        ).toBe(true);
        expect(
          yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(root, path), "utf8")),
        ).toBe("credential=secret");
      }
      for (const [index] of sensitiveDirectories.entries()) {
        expect(
          frames.some(
            (frame) =>
              frame.type === "inspector.error" &&
              frame.requestId === `git-list-${index}` &&
              frame.code === "not-found",
          ),
        ).toBe(true);
      }
    }),
  ),
);

it.effect("supports bounded PTY output and session replay", () =>
  withRuntime(({ pty, frames, handle, drain }) =>
    Effect.gen(function* () {
      yield* handle(open());
      yield* handle(
        request({
          type: "terminal.open",
          requestId: "open-pty",
          terminalId: "pty-1",
          executable: "shell",
          columns: 80,
          rows: 24,
        }),
      );
      yield* drain;
      pty.emit("hello\n");
      yield* drain;
      const emitted = frames.find((frame) => frame.type === "terminal.chunk");
      expect(emitted?.sequence).toBeGreaterThanOrEqual(0);
      const resumeAfter = emitted === undefined ? -1 : emitted.sequence - 1;
      const count = frames.length;
      yield* handle(open(resumeAfter));
      expect(frames.length).toBeGreaterThan(count);
      expect(frames.slice(count).some((frame) => frame.type === "terminal.chunk")).toBe(true);
    }),
  ),
);

it.effect("sequences and replays natural terminal retirement", () =>
  withRuntime(({ pty, frames, handle, drain }) =>
    Effect.gen(function* () {
      yield* handle(open());
      yield* handle(
        request({
          type: "terminal.open",
          requestId: "open-retiring-pty",
          terminalId: "pty-retired",
          executable: "shell",
          columns: 80,
          rows: 24,
        }),
      );
      yield* drain;
      pty.kill();
      yield* drain;
      const retired = frames.find(
        (frame) => frame.type === "terminal.retired" && frame.terminalId === "pty-retired",
      );
      expect(retired).toMatchObject({ type: "terminal.retired", reason: "exited" });
      if (retired?.type !== "terminal.retired") return;
      const count = frames.length;
      yield* handle(open(retired.sequence - 1));
      expect(
        frames
          .slice(count)
          .some((frame) => frame.type === "terminal.retired" && frame.terminalId === "pty-retired"),
      ).toBe(true);
    }),
  ),
);

it.effect("retires an explicit terminal close before acknowledging it", () =>
  withRuntime(({ frames, handle, drain }) =>
    Effect.gen(function* () {
      yield* handle(open());
      yield* handle(
        request({
          type: "terminal.open",
          requestId: "open-explicit-close",
          terminalId: "pty-explicit-close",
          executable: "shell",
          columns: 80,
          rows: 24,
        }),
      );
      yield* drain;
      yield* handle(
        request({
          type: "terminal.close",
          requestId: "explicit-close",
          terminalId: "pty-explicit-close",
        }),
      );
      yield* drain;
      const retiredIndex = frames.findIndex(
        (frame) => frame.type === "terminal.retired" && frame.terminalId === "pty-explicit-close",
      );
      const acknowledgedIndex = frames.findIndex(
        (frame) => frame.type === "inspector.ack" && frame.requestId === "explicit-close",
      );
      expect(retiredIndex).toBeGreaterThanOrEqual(0);
      expect(acknowledgedIndex).toBeGreaterThan(retiredIndex);
      expect(frames[retiredIndex]).toMatchObject({
        type: "terminal.retired",
        reason: "killed",
      });
    }),
  ),
);

it.effect("reuses a terminal slot after cancellation suspends its open acknowledgement", () =>
  Effect.gen(function* () {
    const acknowledgementReached = yield* Deferred.make<void>();
    const releaseAcknowledgement = yield* Deferred.make<void>();
    let suspendFirstAcknowledgement = true;
    yield* withRuntime(
      ({ pty, frames, handle, drain }) =>
        Effect.gen(function* () {
          yield* handle(open());
          yield* handle(
            request({
              type: "terminal.open",
              requestId: "suspended-open",
              terminalId: "suspended-terminal",
              executable: "shell",
              columns: 80,
              rows: 24,
            }),
          );
          yield* Deferred.await(acknowledgementReached);

          expect(pty.killCount).toBe(0);
          const cancellationStarted = yield* Deferred.make<void>();
          yield* Effect.all(
            [
              Deferred.succeed(cancellationStarted, undefined).pipe(
                Effect.andThen(
                  handle({
                    type: "inspector.cancel",
                    binding,
                    sessionId: "session-1" as never,
                    requestId: "suspended-open" as never,
                  }),
                ),
              ),
              Deferred.await(cancellationStarted).pipe(
                Effect.andThen(Deferred.succeed(releaseAcknowledgement, undefined)),
              ),
            ],
            { concurrency: "unbounded", discard: true },
          );

          expect(
            frames.filter(
              (frame) => frame.type === "inspector.ack" && frame.requestId === "suspended-open",
            ),
          ).toHaveLength(1);
          expect(
            frames.filter(
              (frame) =>
                frame.type === "terminal.retired" && frame.terminalId === "suspended-terminal",
            ),
          ).toHaveLength(0);

          yield* handle(
            request({
              type: "terminal.close",
              requestId: "close-cancelled-open",
              terminalId: "suspended-terminal",
            }),
          );
          yield* drain;
          expect(pty.killCount).toBe(1);
          expect(
            frames.filter(
              (frame) =>
                frame.type === "terminal.retired" && frame.terminalId === "suspended-terminal",
            ),
          ).toHaveLength(1);

          yield* handle(
            request({
              type: "terminal.open",
              requestId: "open-after-cancelled-retirement",
              terminalId: "replacement-terminal",
              executable: "shell",
              columns: 80,
              rows: 24,
            }),
          );
          yield* drain;
          expect(
            frames.some(
              (frame) =>
                frame.type === "inspector.ack" &&
                frame.requestId === "open-after-cancelled-retirement",
            ),
          ).toBe(true);
          expect(
            frames.filter(
              (frame) =>
                frame.type === "terminal.retired" && frame.terminalId === "suspended-terminal",
            ),
          ).toHaveLength(1);
        }),
      undefined,
      { maxTerminalsPerSession: 1 },
      (frame) => {
        if (
          suspendFirstAcknowledgement &&
          frame.type === "inspector.ack" &&
          frame.requestId === "suspended-open"
        ) {
          suspendFirstAcknowledgement = false;
          return Deferred.succeed(acknowledgementReached, undefined).pipe(
            Effect.andThen(Deferred.await(releaseAcknowledgement)),
          );
        }
        return Effect.void;
      },
    );
  }),
);

it.effect("replays exactly one retirement when the terminal-open ACK sink fails", () => {
  let relayAvailable = true;
  let failAckOnce = true;
  return withRuntime(
    ({ pty, frames, handle, drain }) =>
      Effect.gen(function* () {
        yield* handle(open());
        yield* handle(
          request({
            type: "terminal.open",
            requestId: "failed-ack-open",
            terminalId: "failed-ack-terminal",
            executable: "shell",
            columns: 80,
            rows: 24,
          }),
        );
        yield* drain;
        expect(pty.killCount).toBe(1);
        expect(
          frames.some(
            (frame) =>
              (frame.type === "inspector.ack" && frame.requestId === "failed-ack-open") ||
              (frame.type === "terminal.retired" && frame.terminalId === "failed-ack-terminal"),
          ),
        ).toBe(false);

        relayAvailable = true;
        const replayStart = frames.length;
        yield* handle(open(0));
        const replay = frames.slice(replayStart);
        expect(
          replay.filter(
            (frame) => frame.type === "inspector.ack" && frame.requestId === "failed-ack-open",
          ),
        ).toHaveLength(1);
        expect(
          replay.filter(
            (frame) =>
              frame.type === "terminal.retired" && frame.terminalId === "failed-ack-terminal",
          ),
        ).toHaveLength(1);

        yield* handle(
          request({
            type: "terminal.open",
            requestId: "open-after-failed-ack",
            terminalId: "replacement-after-failed-ack",
            executable: "shell",
            columns: 80,
            rows: 24,
          }),
        );
        yield* drain;
        expect(
          frames.some(
            (frame) =>
              frame.type === "inspector.ack" && frame.requestId === "open-after-failed-ack",
          ),
        ).toBe(true);
        expect(
          frames.filter(
            (frame) =>
              frame.type === "terminal.retired" && frame.terminalId === "failed-ack-terminal",
          ),
        ).toHaveLength(1);
      }),
    undefined,
    { maxTerminalsPerSession: 1 },
    (frame) => {
      if (failAckOnce && frame.type === "inspector.ack" && frame.requestId === "failed-ack-open") {
        failAckOnce = false;
        relayAvailable = false;
      }
      return relayAvailable
        ? Effect.void
        : Effect.fail(
            new InspectorRuntimeError({
              code: "internal",
              retryable: true,
              operation: "test-relay-send",
            }),
          );
    },
  );
});

it.effect("fails closed when no browser or desktop adapter is injected", () =>
  withRuntime(({ frames, handle, drain }) =>
    Effect.gen(function* () {
      yield* handle(open());
      yield* handle(
        request({ type: "desktop.start", requestId: "desktop-1", width: 1440, height: 1024 }),
      );
      yield* drain;
      expect(
        frames.some(
          (frame) =>
            frame.type === "inspector.error" &&
            frame.requestId === "desktop-1" &&
            frame.code === "unsupported",
        ),
      ).toBe(true);
    }),
  ),
);

it.effect("rechecks the desktop generation inside the queued task immediately before input", () => {
  let allowed = true;
  let performed = 0;
  const visuals: InspectorVisualBackend = {
    capabilities: {
      browserFrames: false,
      browserInput: false,
      desktopFrames: true,
      desktopInput: true,
    },
    perform: () =>
      Effect.sync(() => {
        performed += 1;
        return { type: "ack" as const };
      }),
    close: Effect.void,
  };
  const permit: DesktopInputPermit = {
    leaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as never,
    generation: 1,
    authorityRevision: 1,
    binding: {
      workspaceId: binding.workspaceId,
      threadId: binding.threadId,
      attemptId: binding.attemptId,
      environmentId: binding.environmentId,
      environmentRevisionId: binding.environmentRevisionId,
      sandboxId: binding.sandboxId,
      workerId: binding.workerId,
      routeGeneration: binding.routeGeneration,
    },
    expiresAt: "2026-08-27T12:01:00.000Z",
  };
  return withRuntime(
    ({ handle, drain, frames }) =>
      Effect.gen(function* () {
        yield* handle(open());
        yield* handle({
          type: "inspector.request",
          binding,
          sessionId: "session-1" as never,
          operation: decodeOperation({
            type: "desktop.input",
            requestId: "desktop-input-1",
            input: { type: "text", text: "hello" },
          }),
          desktopPermit: permit,
        });
        // The request is deliberately forked by InspectorRuntime. A release or
        // replacement that lands before the task runs must fence the backend.
        allowed = false;
        yield* drain;
        expect(performed).toBe(0);
        expect(
          frames.some(
            (frame) => frame.type === "inspector.error" && frame.requestId === "desktop-input-1",
          ),
        ).toBe(true);
      }),
    undefined,
    {
      visuals,
      authorizeVisualInput: () =>
        allowed
          ? Effect.void
          : Effect.fail(
              new InspectorRuntimeError({
                code: "invalid-operation",
                retryable: false,
                operation: "desktop-generation-fenced",
              }),
            ),
    },
  );
});

it.effect("redacts injected environment values even when PTY chunks split a secret", () =>
  withRuntime(
    ({ pty, frames, handle, drain }) =>
      Effect.gen(function* () {
        yield* handle(open());
        yield* handle(
          request({
            type: "terminal.open",
            requestId: "open-redacted-pty",
            terminalId: "pty-redacted",
            executable: "shell",
            columns: 80,
            rows: 24,
          }),
        );
        yield* drain;
        pty.emit("token=super-");
        pty.emit("secret-token\n");
        pty.kill();
        yield* drain;
        expect(encodeFrames(frames)).not.toContain("super-secret-token");
        expect(encodeFrames(frames)).toContain("[REDACTED]");
      }),
    ["super-secret-token"],
  ),
);

it.effect("rejects resume when a replacement worker has no replay history", () =>
  withRuntime(({ frames, handle }) =>
    Effect.gen(function* () {
      yield* handle(open(5));
      expect(frames[0]).toMatchObject({
        type: "inspector.resume-rejected",
        requestedAfterSequence: 5,
        earliestAvailableSequence: -1,
        latestSequence: -1,
        reason: "session-unavailable",
      });
    }),
  ),
);

it.effect("keeps data sequences contiguous when an old resume cursor has been evicted", () =>
  withRuntime(
    ({ frames, handle, drain }) =>
      Effect.gen(function* () {
        yield* handle(open());
        for (const requestId of ["cap-1", "cap-2"]) {
          yield* handle(request({ type: "capabilities.get", requestId }));
          yield* drain;
        }
        const count = frames.length;
        yield* handle(open(0));
        const rejected = frames[count];
        expect(rejected).toMatchObject({
          type: "inspector.resume-rejected",
          requestedAfterSequence: 0,
          latestSequence: 4,
          reason: "history-evicted",
        });
        expect("sequence" in (rejected ?? {})).toBe(false);
        yield* handle(request({ type: "capabilities.get", requestId: "cap-3" }));
        yield* drain;
        const after = frames.slice(count + 1).filter((frame) => "sequence" in frame);
        expect(after.map((frame) => frame.sequence)).toEqual([5, 6]);
      }),
    undefined,
    { maxHistoryFrames: 2 },
  ),
);

it.effect("rejects a workspace symlink that aliases a protected credential directory", () =>
  Effect.scoped(
    Effect.acquireRelease(
      Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agentsin-c6-protected-alias-")),
      ),
      (parent) => Effect.promise(() => NodeFSP.rm(parent, { recursive: true, force: true })),
    ).pipe(
      Effect.flatMap((parent) =>
        Effect.gen(function* () {
          const credentials = NodePath.join(parent, "credentials");
          const workspace = NodePath.join(parent, "workspace");
          yield* Effect.promise(async () => {
            await NodeFSP.mkdir(credentials);
            await NodeFSP.symlink(credentials, workspace);
          });
          const result = yield* Effect.result(
            makeNodeInspectorRuntime({
              workspaceDirectory: workspace,
              protectedPaths: [credentials],
              loadPty: async () => ({ spawn: () => new FakePty() }) as never,
            }),
          );
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") expect(result.failure.code).toBe("invalid-operation");
        }),
      ),
    ),
  ),
);

it.effect("never re-resolves a replaced workspace path when spawning a PTY", () => {
  let rootPath = "";
  let movedRoot = "";
  let credentials = "";
  let mountedOriginal = false;
  return withRuntime(
    ({ root, frames, handle, drain }) =>
      Effect.gen(function* () {
        rootPath = root;
        movedRoot = `${root}.sealed`;
        credentials = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agentsin-c6-pty-credentials-")),
        );
        yield* handle(open());
        yield* handle(
          request({
            type: "terminal.open",
            requestId: "pty-sealed-root",
            terminalId: "pty-sealed",
            executable: "shell",
            columns: 80,
            rows: 24,
          }),
        );
        yield* drain;
        expect(mountedOriginal).toBe(true);
        expect(
          frames.some(
            (frame) => frame.type === "inspector.ack" && frame.requestId === "pty-sealed-root",
          ),
        ).toBe(true);
        yield* Effect.promise(async () => {
          await NodeFSP.rm(rootPath, { force: true });
          await NodeFSP.rename(movedRoot, rootPath);
          await NodeFSP.rm(credentials, { recursive: true, force: true });
        });
      }),
    undefined,
    {
      ptySandbox: {
        filesystemIsolated: true,
        networkIsolated: true,
        spawn: ({ workspaceMountSource }) => {
          NodeFS.renameSync(rootPath, movedRoot);
          NodeFS.symlinkSync(credentials, rootPath);
          const mounted = NodeFS.statSync(workspaceMountSource);
          const original = NodeFS.statSync(movedRoot);
          mountedOriginal = mounted.ino === original.ino && workspaceMountSource !== rootPath;
          return new FakePty() as never;
        },
      },
    },
  );
});

it.effect("rejects deterministic workspace-root replacement during a file read", () => {
  let activeRoot = "";
  let movedRoot = "";
  let swapped = false;
  return withRuntime(
    ({ root, frames, handle, drain }) =>
      Effect.gen(function* () {
        activeRoot = root;
        movedRoot = `${root}.original`;
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "safe.txt"), "safe"));
        yield* handle(open());
        yield* handle(
          request({
            type: "files.read",
            requestId: "root-swap",
            path: "safe.txt",
            offset: 0,
            length: 4,
          }),
        );
        yield* drain;
        expect(
          frames.some(
            (frame) =>
              frame.type === "inspector.error" &&
              frame.requestId === "root-swap" &&
              frame.code === "conflict",
          ),
        ).toBe(true);
        yield* Effect.promise(async () => {
          await NodeFSP.rm(activeRoot, { recursive: true, force: true });
          await NodeFSP.rename(movedRoot, activeRoot);
        });
      }),
    undefined,
    {
      testHooks: {
        beforeLeafOpen: async () => {
          if (swapped) return;
          swapped = true;
          await NodeFSP.rename(activeRoot, movedRoot);
          await NodeFSP.mkdir(activeRoot);
          await NodeFSP.writeFile(NodePath.join(activeRoot, "safe.txt"), "forged");
        },
      },
    },
  );
});

it.effect("rejects a directory-component swap before atomic rename", () => {
  let activeRoot = "";
  let outside = "";
  let swapped = false;
  return withRuntime(
    ({ root, frames, handle, drain }) =>
      Effect.gen(function* () {
        activeRoot = root;
        outside = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agentsin-c6-component-outside-")),
        );
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.join(root, "src"));
          await NodeFSP.writeFile(NodePath.join(root, "src", "safe.txt"), "old");
        });
        yield* handle(open());
        yield* handle(
          request({
            type: "files.write",
            requestId: "component-swap",
            path: "src/safe.txt",
            expectedSha256: null,
            encoding: "utf8",
            contents: "new",
          }),
        );
        yield* drain;
        expect(
          frames.some(
            (frame) =>
              frame.type === "inspector.error" &&
              frame.requestId === "component-swap" &&
              frame.code === "conflict",
          ),
        ).toBe(true);
        expect(
          yield* Effect.promise(() =>
            NodeFSP.access(NodePath.join(outside, "safe.txt")).then(
              () => false,
              () => true,
            ),
          ),
        ).toBe(true);
        yield* Effect.promise(async () => {
          await NodeFSP.rm(NodePath.join(activeRoot, "src"), { force: true });
          await NodeFSP.rename(
            NodePath.join(activeRoot, "src.original"),
            NodePath.join(activeRoot, "src"),
          );
          await NodeFSP.rm(outside, { recursive: true, force: true });
        });
      }),
    undefined,
    {
      testHooks: {
        beforeRename: async () => {
          if (swapped) return;
          swapped = true;
          await NodeFSP.rename(
            NodePath.join(activeRoot, "src"),
            NodePath.join(activeRoot, "src.original"),
          );
          await NodeFSP.symlink(outside, NodePath.join(activeRoot, "src"));
        },
      },
    },
  );
});

it.effect("cancels an atomic write before rename and waits for filesystem quiescence", () => {
  let entered!: () => void;
  const hookEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let hookQuiescent = false;
  return withRuntime(
    ({ root, frames, handle, drain }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "safe.txt"), "old"));
        yield* handle(open());
        yield* handle(
          request({
            type: "files.write",
            requestId: "cancel-before-rename",
            path: "safe.txt",
            expectedSha256: NodeCrypto.createHash("sha256").update("old").digest("hex"),
            encoding: "utf8",
            contents: "new",
          }),
        );
        yield* Effect.promise(() => hookEntered);
        yield* handle({
          type: "inspector.cancel",
          binding,
          sessionId: "session-1" as never,
          requestId: "cancel-before-rename" as never,
        });
        yield* drain;
        expect(hookQuiescent).toBe(true);
        expect(
          yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(root, "safe.txt"), "utf8")),
        ).toBe("old");
        expect(
          frames.some(
            (frame) =>
              frame.type === "inspector.error" &&
              frame.requestId === "cancel-before-rename" &&
              frame.code === "cancelled",
          ),
        ).toBe(true);
      }),
    undefined,
    {
      testHooks: {
        beforeRename: async (_path, signal) => {
          entered();
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
          hookQuiescent = true;
        },
      },
    },
  );
});

it.effect("aborts a deadline-bound atomic write before rename", () => {
  let entered!: () => void;
  const hookEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let hookQuiescent = false;
  return withRuntime(
    ({ root, frames, handle, drain }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "safe.txt"), "old"));
        yield* handle(open());
        yield* handle(
          request({
            type: "files.write",
            requestId: "deadline-before-rename",
            path: "safe.txt",
            expectedSha256: NodeCrypto.createHash("sha256").update("old").digest("hex"),
            encoding: "utf8",
            contents: "new",
          }),
        );
        yield* Effect.promise(() => hookEntered);
        yield* TestClock.adjust("100 millis");
        yield* drain;
        expect(hookQuiescent).toBe(true);
        expect(
          yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(root, "safe.txt"), "utf8")),
        ).toBe("old");
        expect(
          frames.some(
            (frame) =>
              frame.type === "inspector.error" &&
              frame.requestId === "deadline-before-rename" &&
              frame.code === "limit-exceeded",
          ),
        ).toBe(true);
      }),
    undefined,
    {
      requestDeadlineMs: 100,
      testHooks: {
        beforeRename: async (_path, signal) => {
          entered();
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
          hookQuiescent = true;
        },
      },
    },
  );
});

it.effect("fails expectedSha256 when an outside writer mutates after validation", () => {
  let rootPath = "";
  return withRuntime(
    ({ root, frames, handle, drain }) =>
      Effect.gen(function* () {
        rootPath = root;
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "safe.txt"), "old"));
        yield* handle(open());
        yield* handle(
          request({
            type: "files.write",
            requestId: "cas-window",
            path: "safe.txt",
            expectedSha256: NodeCrypto.createHash("sha256").update("old").digest("hex"),
            encoding: "utf8",
            contents: "inspector",
          }),
        );
        yield* drain;
        expect(
          yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(root, "safe.txt"), "utf8")),
        ).toBe("outside");
        expect(
          frames.some(
            (frame) =>
              frame.type === "inspector.error" &&
              frame.requestId === "cas-window" &&
              frame.code === "conflict",
          ),
        ).toBe(true);
      }),
    undefined,
    {
      testHooks: {
        afterFinalValidationBeforeCommit: async () => {
          const replacement = NodePath.join(rootPath, ".outside-replacement");
          await NodeFSP.writeFile(replacement, "outside");
          await NodeFSP.rename(replacement, NodePath.join(rootPath, "safe.txt"));
        },
      },
    },
  );
});

it.effect("rejects an oversized existing inode before CAS validation allocates it", () => {
  let rootPath = "";
  return withRuntime(
    ({ root, frames, handle, drain }) =>
      Effect.gen(function* () {
        rootPath = root;
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "safe.txt"), "old"));
        yield* handle(open());
        yield* handle(
          request({
            type: "files.write",
            requestId: "cas-oversized-inode",
            path: "safe.txt",
            expectedSha256: NodeCrypto.createHash("sha256").update("old").digest("hex"),
            encoding: "utf8",
            contents: "inspector",
          }),
        );
        yield* drain;
        expect(
          frames.some(
            (frame) =>
              frame.type === "inspector.error" &&
              frame.requestId === "cas-oversized-inode" &&
              frame.code === "conflict",
          ),
        ).toBe(true);
      }),
    undefined,
    {
      testHooks: {
        afterValidationBeforeCommit: async () => {
          await NodeFSP.truncate(NodePath.join(rootPath, "safe.txt"), INSPECTOR_MAX_FILE_BYTES + 1);
        },
      },
    },
  );
});

for (const expected of ["conditional", "unconditional"] as const) {
  it.effect(`rejects protected prepared-file substitution for ${expected} writes`, () =>
    withRuntime(
      ({ root, frames, handle, drain }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "safe.txt"), "old"));
          yield* handle(open());
          yield* handle(
            request({
              type: "files.write",
              requestId: `prepared-substitution-${expected}`,
              path: "safe.txt",
              expectedSha256:
                expected === "conditional"
                  ? NodeCrypto.createHash("sha256").update("old").digest("hex")
                  : null,
              encoding: "utf8",
              contents: "inspector",
            }),
          );
          yield* drain;
          expect(
            yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(root, "safe.txt"), "utf8")),
          ).toBe("old");
          expect(
            frames.some(
              (frame) =>
                frame.type === "inspector.error" &&
                frame.requestId === `prepared-substitution-${expected}` &&
                frame.code === "conflict",
            ),
          ).toBe(true);
        }),
      undefined,
      {
        testHooks: {
          afterPreparedBeforeCommit: async (_path, protectedPreparedPath) => {
            await NodeFSP.rename(protectedPreparedPath, `${protectedPreparedPath}.captured`);
            await NodeFSP.writeFile(protectedPreparedPath, "substituted");
          },
        },
      },
    ),
  );
}

it.effect("does not overwrite an outside writer that publishes during conditional commit", () => {
  let rootPath = "";
  return withRuntime(
    ({ root, frames, handle, drain }) =>
      Effect.gen(function* () {
        rootPath = root;
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "safe.txt"), "old"));
        yield* handle(open());
        yield* handle(
          request({
            type: "files.write",
            requestId: "cas-publish-race",
            path: "safe.txt",
            expectedSha256: NodeCrypto.createHash("sha256").update("old").digest("hex"),
            encoding: "utf8",
            contents: "inspector",
          }),
        );
        yield* drain;
        expect(
          yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(root, "safe.txt"), "utf8")),
        ).toBe("outside");
        expect(
          frames.some(
            (frame) =>
              frame.type === "inspector.error" &&
              frame.requestId === "cas-publish-race" &&
              frame.code === "conflict",
          ),
        ).toBe(true);
      }),
    undefined,
    {
      testHooks: {
        afterExpectedCaptureBeforePublish: async () => {
          await NodeFSP.writeFile(NodePath.join(rootPath, "safe.txt"), "outside");
        },
      },
    },
  );
});

it.effect("restores the captured version when a conditional commit is cancelled", () => {
  let entered!: () => void;
  const hookEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  return withRuntime(
    ({ root, frames, handle, drain }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "safe.txt"), "old"));
        yield* handle(open());
        yield* handle(
          request({
            type: "files.write",
            requestId: "cas-cancel-after-capture",
            path: "safe.txt",
            expectedSha256: NodeCrypto.createHash("sha256").update("old").digest("hex"),
            encoding: "utf8",
            contents: "inspector",
          }),
        );
        yield* Effect.promise(() => hookEntered);
        yield* handle({
          type: "inspector.cancel",
          binding,
          sessionId: "session-1" as never,
          requestId: "cas-cancel-after-capture" as never,
        });
        yield* drain;
        expect(
          yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(root, "safe.txt"), "utf8")),
        ).toBe("old");
        expect(
          frames.some(
            (frame) =>
              frame.type === "inspector.error" &&
              frame.requestId === "cas-cancel-after-capture" &&
              frame.code === "cancelled",
          ),
        ).toBe(true);
      }),
    undefined,
    {
      testHooks: {
        afterExpectedCaptureBeforePublish: async (_path, signal) => {
          entered();
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      },
    },
  );
});

it.effect("interrupts in-flight work and releases the request slot", () => {
  const visuals: InspectorVisualBackend = {
    capabilities: {
      browserFrames: true,
      browserInput: false,
      desktopFrames: false,
      desktopInput: false,
    },
    perform: () => Effect.never,
    close: Effect.void,
  };
  return withRuntime(
    ({ frames, handle, drain }) =>
      Effect.gen(function* () {
        yield* handle(open());
        yield* handle(request({ type: "browser.capture", requestId: "slow-capture" }));
        yield* handle({
          type: "inspector.cancel",
          binding,
          sessionId: "session-1" as never,
          requestId: "slow-capture" as never,
        });
        yield* drain;
        expect(
          frames.some(
            (frame) =>
              frame.type === "inspector.error" &&
              frame.requestId === "slow-capture" &&
              frame.code === "cancelled",
          ),
        ).toBe(true);
        yield* handle(request({ type: "capabilities.get", requestId: "after-cancel" }));
        yield* drain;
        expect(
          frames.some(
            (frame) => frame.type === "inspector.complete" && frame.requestId === "after-cancel",
          ),
        ).toBe(true);
      }),
    undefined,
    { visuals, maxConcurrentRequests: 1 },
  );
});

it.effect("bounds 128-request PTY, artifact, and port churn", () => {
  const visuals: InspectorVisualBackend = {
    capabilities: {
      browserFrames: true,
      browserInput: false,
      desktopFrames: false,
      desktopInput: false,
    },
    perform: () =>
      Effect.succeed({
        type: "artifact" as const,
        kind: "browser-frame" as const,
        mediaType: "image/png",
        bytes: new Uint8Array([1]),
      }),
    close: Effect.void,
  };
  const exposedPorts: Array<number> = [];
  const ports: InspectorPortBackend = {
    list: Effect.succeed([]),
    expose: (port) =>
      Effect.sync(() => {
        exposedPorts.push(port);
        return [];
      }),
    close: () => Effect.succeed([]),
  };
  return withRuntime(
    ({ frames, handle, drain }) =>
      Effect.gen(function* () {
        yield* handle(open());
        for (let index = 0; index < 128; index += 1) {
          yield* handle(
            request({
              type: "terminal.open",
              requestId: `pty-open-${index}`,
              terminalId: `pty-${index}`,
              executable: "shell",
              columns: 80,
              rows: 24,
            }),
          );
        }
        yield* drain;
        expect(
          frames.filter(
            (frame) => frame.type === "inspector.ack" && frame.requestId.startsWith("pty-open-"),
          ).length,
        ).toBeLessThanOrEqual(4);
        for (let index = 0; index < 128; index += 1) {
          yield* handle(request({ type: "browser.capture", requestId: `artifact-${index}` }));
          yield* drain;
        }
        expect(frames.filter((frame) => frame.type === "inspector.artifact.proposed")).toHaveLength(
          4,
        );
        for (let index = 0; index < 128; index += 1) {
          yield* handle(
            request({
              type: "ports.expose",
              requestId: `port-${index}`,
              port: 1_024 + index,
              protocol: "http",
            }),
          );
          yield* drain;
        }
        expect(exposedPorts).toHaveLength(128);
        expect(exposedPorts.every((port) => port >= 1_024 && port <= 65_535)).toBe(true);
      }),
    undefined,
    {
      visuals,
      ports,
      maxTerminalsPerSession: 4,
      maxArtifactsPerSession: 4,
      maxRequestsPerMinute: 1_000,
    },
  );
});

it.effect("enforces the worker request-rate window independently of concurrency", () =>
  withRuntime(
    ({ frames, handle, drain }) =>
      Effect.gen(function* () {
        yield* handle(open());
        yield* handle(request({ type: "capabilities.get", requestId: "rate-1" }));
        yield* drain;
        yield* handle(request({ type: "capabilities.get", requestId: "rate-2" }));
        yield* drain;
        expect(
          frames.some(
            (frame) =>
              frame.type === "inspector.error" &&
              frame.requestId === "rate-2" &&
              frame.code === "limit-exceeded",
          ),
        ).toBe(true);
      }),
    undefined,
    { maxRequestsPerMinute: 1 },
  ),
);
