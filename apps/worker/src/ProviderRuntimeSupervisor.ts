// @effect-diagnostics nodeBuiltinImport:off -- Audited privileged-supervisor process boundary.
// @effect-diagnostics globalTimers:off -- Native timers bound child bootstrap and RPC operations.
// @effect-diagnostics globalTimersInEffect:off -- Timers are owned by the child transport.
// @effect-diagnostics globalDate:off -- Native process termination has no Effect clock context.
// @effect-diagnostics runEffectInsideEffect:off -- Child event callbacks re-enter the scoped worker runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeConstants from "node:constants";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { WorkerProviderError } from "./errors.ts";
import type { WorkerProviderFactory, WorkerProviderSession } from "./ports.ts";
import {
  nodeWorkerCredentialIdentityRuntime,
  type WorkerCredentialIdentityRuntime,
} from "./ProviderCredentialExecutor.ts";
import {
  RestrictedProviderRuntimeMessage,
  RestrictedProviderRuntimeRequest,
  type RestrictedProviderRuntimeMessage as RuntimeMessage,
  type RestrictedProviderRuntimeRequest as RuntimeRequest,
} from "./ProviderRuntimeProtocol.ts";

const MAX_PROTOCOL_BUFFER_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_PENDING_REQUESTS = 32;
const REQUEST_TIMEOUT_MS = 30_000;
const RUNTIME_CHILD_PATH = NodeURL.fileURLToPath(
  new URL("./ProviderRuntimeChild.ts", import.meta.url),
);
const decodeMessage = Schema.decodeUnknownSync(
  Schema.fromJsonString(RestrictedProviderRuntimeMessage),
);
const encodeRequest = Schema.encodeUnknownSync(
  Schema.fromJsonString(RestrictedProviderRuntimeRequest),
);

const providerFailure = (operation: string, cause?: unknown) =>
  new WorkerProviderError({ operation, crashed: true, ...(cause === undefined ? {} : { cause }) });

export interface RestrictedProviderRuntimeOptions {
  readonly interpreterPath?: string;
  readonly modulePath: string;
  readonly moduleSha256: string;
  readonly childPath?: string;
  readonly childSha256: string;
  readonly searchPath: string;
  readonly agentHomeDirectory: string;
  readonly agentUid: number;
  readonly agentGid: number;
  readonly identityRuntime?: WorkerCredentialIdentityRuntime;
  /** Test-only seam. Hosted composition always uses the kernel verifier. */
  readonly artifactVerifier?: TrustedRuntimeArtifactVerifier;
}

const assertTrustedAncestors = async (path: string, agentUid: number) => {
  const parsed = NodePath.parse(path);
  const workerUid = NodeProcess.getuid?.();
  if (workerUid === undefined) throw providerFailure("provider-runtime-module-owner");
  const assertTrusted = async (candidate: string) => {
    const stat = await NodeFSP.lstat(candidate);
    const stickyRootDirectory =
      stat.isDirectory() && stat.uid === workerUid && (stat.mode & 0o1000) !== 0;
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      stat.uid !== workerUid ||
      ((stat.mode & 0o022) !== 0 && !stickyRootDirectory)
    )
      throw providerFailure("provider-runtime-module-symlink");
  };
  let cursor = parsed.root;
  await assertTrusted(cursor);
  for (const part of path.slice(parsed.root.length).split(NodePath.sep).filter(Boolean)) {
    cursor = NodePath.join(cursor, part);
    await assertTrusted(cursor);
  }
  if (workerUid === agentUid) throw providerFailure("provider-runtime-module-owner");
};

const assertAgentPathAncestors = async (path: string, agentUid: number) => {
  const parsed = NodePath.parse(path);
  let cursor = parsed.root;
  for (const part of path.slice(parsed.root.length).split(NodePath.sep).filter(Boolean)) {
    cursor = NodePath.join(cursor, part);
    const stat = await NodeFSP.lstat(cursor);
    const stickyRootDirectory = stat.isDirectory() && stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      ((stat.mode & 0o022) !== 0 && !stickyRootDirectory && stat.uid !== agentUid)
    )
      throw providerFailure("provider-runtime-agent-path-ancestor");
  }
};

export interface TrustedRuntimeFileIdentity {
  readonly device: number;
  readonly inode: number;
  readonly sha256: string;
}

export interface TrustedRuntimeArtifactVerifier {
  readonly verify: (
    path: string,
    expectedSha256: string,
    agentUid: number,
    expectedIdentity?: TrustedRuntimeFileIdentity,
  ) => Promise<TrustedRuntimeFileIdentity>;
}

const verifyTrustedRuntimeFile = async (
  path: string,
  expectedSha256: string,
  agentUid: number,
  expectedIdentity?: TrustedRuntimeFileIdentity,
): Promise<TrustedRuntimeFileIdentity> => {
  if (!NodePath.isAbsolute(path) || !/^[0-9a-f]{64}$/u.test(expectedSha256))
    throw providerFailure("provider-runtime-module-identity");
  await assertTrustedAncestors(NodePath.dirname(path), agentUid);
  const handle = await NodeFSP.open(path, NodeConstants.O_RDONLY | NodeConstants.O_NOFOLLOW);
  const stat = await handle.stat();
  const pathStat = await NodeFSP.lstat(path);
  const workerUid = NodeProcess.getuid?.();
  if (
    workerUid === undefined ||
    !stat.isFile() ||
    pathStat.isSymbolicLink() ||
    stat.dev !== pathStat.dev ||
    stat.ino !== pathStat.ino ||
    stat.uid !== workerUid ||
    (stat.mode & 0o022) !== 0
  )
    throw providerFailure("provider-runtime-module-permissions");
  try {
    const bytes = await handle.readFile();
    const actual = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
    if (actual !== expectedSha256) throw providerFailure("provider-runtime-module-digest");
    const identity = { device: stat.dev, inode: stat.ino, sha256: actual };
    if (
      expectedIdentity !== undefined &&
      (identity.device !== expectedIdentity.device ||
        identity.inode !== expectedIdentity.inode ||
        identity.sha256 !== expectedIdentity.sha256)
    )
      throw providerFailure("provider-runtime-module-replaced");
    return identity;
  } finally {
    await handle.close();
  }
};

const containsPath = (parent: string, candidate: string) =>
  candidate === parent || candidate.startsWith(`${parent}${NodePath.sep}`);

const assertDisjointPaths = (first: string, second: string, operation: string) => {
  if (containsPath(first, second) || containsPath(second, first)) throw providerFailure(operation);
};

const verifyAgentDirectory = async (path: string, uid: number, gid: number, operation: string) => {
  if (!NodePath.isAbsolute(path)) throw providerFailure(operation);
  await assertAgentPathAncestors(path, uid);
  const stat = await NodeFSP.lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    stat.gid !== gid ||
    (stat.mode & 0o077) !== 0
  )
    throw providerFailure(operation);
  return NodeFSP.realpath(path);
};

const terminateProcessGroup = async (child: NodeChildProcess.ChildProcess) => {
  const pid = child.pid;
  if (pid === undefined) return;
  const exists = () => {
    try {
      NodeProcess.kill(-pid, 0);
      return true;
    } catch (cause) {
      return (cause as NodeJS.ErrnoException).code !== "ESRCH";
    }
  };
  if (!exists()) return;
  NodeProcess.kill(-pid, "SIGTERM");
  await new Promise<void>((resolve) => {
    const deadline = setTimeout(resolve, 500);
    child.once("exit", () => {
      clearTimeout(deadline);
      resolve();
    });
  });
  if (exists()) NodeProcess.kill(-pid, "SIGKILL");
  const deadline = Date.now() + 2_000;
  while (exists() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  if (exists()) throw providerFailure("provider-runtime-termination");
};

interface PendingRequest {
  readonly resolve: (
    message: Extract<RuntimeMessage, { readonly type: "provider.result" }>,
  ) => void;
  readonly reject: (cause: unknown) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

type RuntimeRequestInput =
  | Omit<Extract<RuntimeRequest, { readonly type: "provider.start" }>, "requestId">
  | Omit<Extract<RuntimeRequest, { readonly type: "provider.dispatch" }>, "requestId">
  | Omit<Extract<RuntimeRequest, { readonly type: "provider.health" }>, "requestId">
  | Omit<Extract<RuntimeRequest, { readonly type: "provider.stop" }>, "requestId">;

class RestrictedProviderClient {
  private readonly child: NodeChildProcess.ChildProcess;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (cause: unknown) => void;
  private outputBuffer = "";
  private stderrBytes = 0;
  private nextRequestId = 0;
  private terminal = false;
  private emitEvent?: (
    event: Extract<RuntimeMessage, { readonly type: "provider.event" }>["event"],
  ) => Promise<void>;

  constructor(child: NodeChildProcess.ChildProcess) {
    this.child = child;
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => this.onOutput(chunk));
    child.stderr!.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.byteLength;
      if (this.stderrBytes > MAX_STDERR_BYTES) this.fail("provider-runtime-stderr-budget");
    });
    child.once("error", () => this.fail("provider-runtime-spawn"));
    child.once("exit", () => this.fail("provider-runtime-exit"));
  }

  setEventHandler(
    handler: (
      event: Extract<RuntimeMessage, { readonly type: "provider.event" }>["event"],
    ) => Promise<void>,
  ) {
    this.emitEvent = handler;
  }

  async waitUntilReady() {
    await Promise.race([
      this.ready,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(providerFailure("provider-runtime-ready-timeout")), 5_000),
      ),
    ]);
  }

  request(
    input: RuntimeRequestInput,
  ): Promise<Extract<RuntimeMessage, { type: "provider.result" }>> {
    if (this.terminal || this.pending.size >= MAX_PENDING_REQUESTS)
      return Promise.reject(providerFailure("provider-runtime-request-budget"));
    const requestId = `provider-runtime-${++this.nextRequestId}`;
    const request = { ...input, requestId } as RuntimeRequest;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(providerFailure("provider-runtime-request-timeout"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timeout });
      this.child.stdin!.write(`${encodeRequest(request)}\n`, (error) => {
        if (error === null || error === undefined) return;
        const pending = this.pending.get(requestId);
        if (pending === undefined) return;
        this.pending.delete(requestId);
        clearTimeout(pending.timeout);
        pending.reject(providerFailure("provider-runtime-write"));
      });
    });
  }

  async close() {
    if (this.terminal) return;
    try {
      await this.request({ type: "provider.stop" });
    } catch {
      // Termination below is authoritative even when the child RPC is unavailable.
    }
    this.terminal = true;
    this.child.stdin?.end();
    await terminateProcessGroup(this.child);
    this.rejectAll(providerFailure("provider-runtime-closed"));
  }

  private onOutput(chunk: string) {
    if (this.terminal) return;
    this.outputBuffer += chunk;
    if (Buffer.byteLength(this.outputBuffer, "utf8") > MAX_PROTOCOL_BUFFER_BYTES) {
      this.fail("provider-runtime-output-budget");
      return;
    }
    let newline = this.outputBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.outputBuffer.slice(0, newline);
      this.outputBuffer = this.outputBuffer.slice(newline + 1);
      try {
        const message = decodeMessage(line);
        if (message.type === "provider.ready") this.resolveReady();
        else if (message.type === "provider.event") {
          const handler = this.emitEvent;
          if (handler === undefined) this.fail("provider-runtime-unexpected-event");
          else void handler(message.event).catch(() => this.fail("provider-runtime-event"));
        } else {
          const pending = this.pending.get(message.requestId);
          if (pending === undefined) this.fail("provider-runtime-unknown-result");
          else {
            this.pending.delete(message.requestId);
            clearTimeout(pending.timeout);
            pending.resolve(message);
          }
        }
      } catch {
        this.fail("provider-runtime-invalid-message");
      }
      newline = this.outputBuffer.indexOf("\n");
    }
  }

  private fail(operation: string) {
    if (this.terminal) return;
    this.terminal = true;
    const cause = providerFailure(operation);
    this.rejectReady(cause);
    this.rejectAll(cause);
    void terminateProcessGroup(this.child).catch(() => undefined);
  }

  private rejectAll(cause: unknown) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(cause);
    }
    this.pending.clear();
  }
}

const requireSuccess = (
  result: Extract<RuntimeMessage, { readonly type: "provider.result" }>,
  operation: string,
) => {
  if (!result.success) throw providerFailure(operation, result.errorCode);
  return result;
};

export const makeRestrictedProviderFactory = (
  options: RestrictedProviderRuntimeOptions,
): Effect.Effect<WorkerProviderFactory, WorkerProviderError> =>
  Effect.gen(function* () {
    const identityRuntime = options.identityRuntime ?? nodeWorkerCredentialIdentityRuntime;
    const verifyArtifact = options.artifactVerifier?.verify ?? verifyTrustedRuntimeFile;
    const childPath = options.childPath ?? RUNTIME_CHILD_PATH;
    const trusted = yield* Effect.tryPromise({
      try: async () => {
        await identityRuntime.verify(options.agentUid, options.agentGid);
        return {
          child: await verifyArtifact(childPath, options.childSha256, options.agentUid),
          module: await verifyArtifact(options.modulePath, options.moduleSha256, options.agentUid),
        };
      },
      catch: (cause) => providerFailure("provider-runtime-verify", cause),
    });
    return {
      start: ({ identity, materialization, emit }) =>
        Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: async () => {
              const workspace = await NodeFSP.realpath(identity.workspaceDirectory);
              const module = await NodeFSP.realpath(options.modulePath);
              const childRuntime = await NodeFSP.realpath(childPath);
              const agentHome = await verifyAgentDirectory(
                options.agentHomeDirectory,
                options.agentUid,
                options.agentGid,
                "provider-runtime-agent-home",
              );
              const credentialDirectory = await verifyAgentDirectory(
                materialization.credentialDirectory,
                options.agentUid,
                options.agentGid,
                "provider-runtime-credential-directory",
              );
              assertDisjointPaths(workspace, module, "provider-runtime-module-workspace");
              assertDisjointPaths(workspace, childRuntime, "provider-runtime-child-workspace");
              assertDisjointPaths(workspace, agentHome, "provider-runtime-home-workspace");
              assertDisjointPaths(
                workspace,
                credentialDirectory,
                "provider-runtime-credential-workspace",
              );
            },
            catch: (cause) => providerFailure("provider-runtime-boundary", cause),
          });
          yield* Effect.tryPromise({
            try: async () => {
              await verifyArtifact(childPath, options.childSha256, options.agentUid, trusted.child);
              await verifyArtifact(
                options.modulePath,
                options.moduleSha256,
                options.agentUid,
                trusted.module,
              );
            },
            catch: (cause) => providerFailure("provider-runtime-spawn-verify", cause),
          });
          const childProcess = yield* Effect.tryPromise({
            try: () =>
              identityRuntime.spawn(
                options.interpreterPath ?? NodeProcess.execPath,
                [childPath, options.modulePath],
                {
                  cwd: identity.workspaceDirectory,
                  uid: options.agentUid,
                  gid: options.agentGid,
                  detached: true,
                  shell: false,
                  env: {
                    HOME: options.agentHomeDirectory,
                    PATH: options.searchPath,
                    LANG: "C.UTF-8",
                    LC_ALL: "C.UTF-8",
                    NO_COLOR: "1",
                    AGENTSIN_PROVIDER_CREDENTIAL_DIRECTORY: materialization.credentialDirectory,
                  },
                  stdio: ["pipe", "pipe", "pipe"],
                },
              ),
            catch: (cause) => providerFailure("provider-runtime-spawn", cause),
          });
          const client = new RestrictedProviderClient(childProcess);
          yield* Effect.addFinalizer(() => Effect.promise(() => client.close()).pipe(Effect.orDie));
          client.setEventHandler((event) => Effect.runPromise(emit(event).pipe(Effect.asVoid)));
          yield* Effect.tryPromise({
            try: async () => {
              await client.waitUntilReady();
              requireSuccess(
                await client.request({
                  type: "provider.start",
                  identity,
                  materialization: {
                    leaseRef: materialization.leaseRef,
                    credentialDirectory: materialization.credentialDirectory,
                    environmentVariableNames: materialization.environmentVariableNames,
                    containsWalletMaterial: materialization.containsWalletMaterial,
                  },
                }),
                "provider-runtime-start",
              );
            },
            catch: (cause) => providerFailure("provider-runtime-start", cause),
          });
          return {
            dispatch: (command) =>
              Effect.tryPromise({
                try: async () => {
                  requireSuccess(
                    await client.request({ type: "provider.dispatch", command }),
                    "provider-runtime-dispatch",
                  );
                },
                catch: (cause) => providerFailure("provider-runtime-dispatch", cause),
              }),
            health: Effect.tryPromise({
              try: async () => {
                const result = requireSuccess(
                  await client.request({ type: "provider.health" }),
                  "provider-runtime-health",
                );
                if (result.health === undefined)
                  throw providerFailure("provider-runtime-health-result");
                return result.health;
              },
              catch: (cause) => providerFailure("provider-runtime-health", cause),
            }),
            stop: Effect.promise(() => client.close()),
          } satisfies WorkerProviderSession;
        }),
    } satisfies WorkerProviderFactory;
  });
