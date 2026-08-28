// @effect-diagnostics nodeBuiltinImport:off -- Audited worker-only process and filesystem boundary.
// @effect-diagnostics globalTimers:off -- Native expiry timers own credential lease cleanup.
// @effect-diagnostics globalTimersInEffect:off -- Timers bridge the filesystem cleanup boundary.
import * as NodeConstants from "node:constants";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import type { AgentMaterializationId } from "@t3tools/contracts/cloud";
import {
  decodeProviderProfileBundle,
  type ProviderProfileBundle,
} from "@t3tools/contracts/provider-profile-bundle";
import type {
  WorkerProviderCredentialCommand,
  WorkerProviderCredentialResult,
} from "@t3tools/contracts/worker";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const RESTRICTED_PROCESS_LAUNCHER = [
  'const cp=require("node:child_process");',
  "const uid=Number(process.argv[1]);",
  "const gid=Number(process.argv[2]);",
  'const executable=Buffer.from(process.argv[3],"base64").toString("utf8");',
  'const args=JSON.parse(Buffer.from(process.argv[4],"base64").toString("utf8"));',
  "const interpreterFd=Number(process.argv[5]);",
  "try{",
  'require("node:fs").closeSync(interpreterFd);',
  "process.setgroups([]);",
  "process.setgid(gid);",
  "process.setuid(uid);",
  "const groups=process.getgroups();",
  "if(process.getuid()!==uid||process.getgid()!==gid||groups.some((group)=>group!==gid))process.exit(70);",
  'const child=cp.spawn(executable,args,{cwd:process.cwd(),env:process.env,stdio:["inherit","inherit","inherit"],shell:false});',
  'child.once("error",()=>process.exit(71));',
  'child.once("exit",(code,signal)=>{if(signal!==null){process.kill(process.pid,signal);return;}process.exit(code??72);});',
  "}catch{process.exit(70);}",
].join("");

export class WorkerProviderCredentialError extends Schema.TaggedErrorClass<WorkerProviderCredentialError>()(
  "WorkerProviderCredentialError",
  {
    code: Schema.Literals(["invalidProfile", "unsafeRoot", "writeFailed", "cleanupFailed"]),
    operation: Schema.String,
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {}

export interface WorkerProviderCredentialExecutor {
  readonly execute: (
    command: WorkerProviderCredentialCommand,
    credentialPayload: Uint8Array | undefined,
    emit: (
      result: WorkerProviderCredentialResult,
    ) => Effect.Effect<void, WorkerProviderCredentialError>,
  ) => Effect.Effect<void, WorkerProviderCredentialError>;
  readonly cleanupAll: Effect.Effect<void, WorkerProviderCredentialError>;
}

export interface WorkerCredentialIdentityRuntime {
  readonly verify: (uid: number, gid: number) => Promise<void>;
  readonly chown: (path: string, uid: number, gid: number) => Promise<void>;
  readonly chownFile: (
    handle: Awaited<ReturnType<typeof NodeFSP.open>>,
    uid: number,
    gid: number,
  ) => Promise<void>;
  readonly isOwnedBy: (
    stat: Awaited<ReturnType<Awaited<ReturnType<typeof NodeFSP.open>>["stat"]>>,
    uid: number,
    gid: number,
  ) => boolean;
  readonly spawn: (
    executable: string,
    arguments_: ReadonlyArray<string>,
    options: NodeChildProcess.SpawnOptions,
  ) => Promise<NodeChildProcess.ChildProcess>;
}

export interface WorkerCredentialLeaseScheduler {
  readonly nowMs: () => number;
  readonly schedule: (
    delayMs: number,
    expire: () => Promise<void>,
  ) => { readonly cancel: () => void };
}

const nativeLeaseScheduler: WorkerCredentialLeaseScheduler = {
  nowMs: Date.now,
  schedule: (delayMs, expire) => {
    const timer = setTimeout(() => void expire(), delayMs);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
};

const failure = (code: WorkerProviderCredentialError["code"], operation: string, cause?: unknown) =>
  new WorkerProviderCredentialError({ code, operation, ...(cause === undefined ? {} : { cause }) });
const isWorkerProviderCredentialError = Schema.is(WorkerProviderCredentialError);

const waitForChild = (child: NodeChildProcess.ChildProcess) =>
  new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );

interface TrustedInterpreterIdentity {
  readonly device: number;
  readonly inode: number;
  readonly sha256: string;
}

export interface NodeWorkerCredentialIdentityRuntimeOptions {
  readonly interpreterPath?: string;
  readonly interpreterSha256?: string;
  readonly launcherSha256?: string;
  /** Linux-root replacement proof only; production never supplies this hook. */
  readonly beforePrivilegedSpawn?: () => Promise<void>;
}

export const RESTRICTED_PROCESS_LAUNCHER_SHA256 = NodeCrypto.createHash("sha256")
  .update(RESTRICTED_PROCESS_LAUNCHER)
  .digest("hex");

const assertTrustedInterpreterAncestors = async (path: string) => {
  const parsed = NodePath.parse(path);
  const assertTrusted = async (candidate: string) => {
    const stat = await NodeFSP.lstat(candidate);
    const stickyRoot = stat.isDirectory() && stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      stat.uid !== 0 ||
      ((stat.mode & 0o022) !== 0 && !stickyRoot)
    )
      throw failure("unsafeRoot", "restricted-interpreter-ancestor");
  };
  let cursor = parsed.root;
  await assertTrusted(cursor);
  for (const part of path.slice(parsed.root.length).split(NodePath.sep).filter(Boolean)) {
    cursor = NodePath.join(cursor, part);
    await assertTrusted(cursor);
  }
};

const normalizePrivilegedStdio = (stdio: NodeChildProcess.SpawnOptions["stdio"]) => {
  if (stdio === undefined || stdio === "pipe") return ["pipe", "pipe", "pipe"] as const;
  if (stdio === "ignore") return ["ignore", "ignore", "ignore"] as const;
  if (stdio === "inherit") return ["inherit", "inherit", "inherit"] as const;
  if (!Array.isArray(stdio) || stdio.length > 3)
    throw failure("unsafeRoot", "restricted-spawn-stdio");
  return [stdio[0] ?? "pipe", stdio[1] ?? "pipe", stdio[2] ?? "pipe"] as const;
};

export const makeNodeWorkerCredentialIdentityRuntime = (
  runtimeOptions: NodeWorkerCredentialIdentityRuntimeOptions = {},
): WorkerCredentialIdentityRuntime => {
  const interpreterPath = runtimeOptions.interpreterPath ?? process.execPath;
  const expectedInterpreterSha256 = runtimeOptions.interpreterSha256;
  const expectedLauncherSha256 =
    runtimeOptions.launcherSha256 ?? RESTRICTED_PROCESS_LAUNCHER_SHA256;
  let trustedInterpreter: TrustedInterpreterIdentity | undefined;

  const openTrustedInterpreter = async () => {
    if (
      NodeProcess.platform !== "linux" ||
      !NodePath.isAbsolute(interpreterPath) ||
      (expectedInterpreterSha256 !== undefined &&
        !/^[0-9a-f]{64}$/u.test(expectedInterpreterSha256)) ||
      !/^[0-9a-f]{64}$/u.test(expectedLauncherSha256) ||
      RESTRICTED_PROCESS_LAUNCHER_SHA256 !== expectedLauncherSha256
    )
      throw failure("unsafeRoot", "restricted-interpreter-config");
    await assertTrustedInterpreterAncestors(NodePath.dirname(interpreterPath));
    const handle = await NodeFSP.open(
      interpreterPath,
      NodeConstants.O_RDONLY | NodeConstants.O_NOFOLLOW,
    );
    try {
      const stat = await handle.stat();
      const pathStat = await NodeFSP.lstat(interpreterPath);
      if (
        !stat.isFile() ||
        pathStat.isSymbolicLink() ||
        stat.uid !== 0 ||
        (stat.mode & 0o022) !== 0 ||
        stat.dev !== pathStat.dev ||
        stat.ino !== pathStat.ino
      )
        throw failure("unsafeRoot", "restricted-interpreter-permissions");
      const sha256 = NodeCrypto.createHash("sha256")
        .update(await handle.readFile())
        .digest("hex");
      if (expectedInterpreterSha256 !== undefined && sha256 !== expectedInterpreterSha256)
        throw failure("unsafeRoot", "restricted-interpreter-digest");
      const identity = { device: stat.dev, inode: stat.ino, sha256 };
      if (
        trustedInterpreter !== undefined &&
        (identity.device !== trustedInterpreter.device ||
          identity.inode !== trustedInterpreter.inode ||
          identity.sha256 !== trustedInterpreter.sha256)
      )
        throw failure("unsafeRoot", "restricted-interpreter-replaced");
      trustedInterpreter ??= identity;
      return { handle, identity };
    } catch (cause) {
      await handle.close();
      throw cause;
    }
  };

  const runtime: WorkerCredentialIdentityRuntime = {
    verify: async (uid, gid) => {
      const workerUid = process.getuid?.();
      const workerGid = process.getgid?.();
      if (
        workerUid === undefined ||
        workerGid === undefined ||
        workerUid !== 0 ||
        uid === workerUid ||
        gid === workerGid
      )
        throw failure("unsafeRoot", "restricted-identity");
      const proof = await openTrustedInterpreter();
      await proof.handle.close();
      const child = await runtime.spawn(
        interpreterPath,
        [
          "-e",
          "if(process.getuid()!==Number(process.argv[1])||process.getgid()!==Number(process.argv[2])||process.getgroups().some((group)=>group!==Number(process.argv[2])))process.exit(70)",
          String(uid),
          String(gid),
        ],
        { uid, gid, shell: false, stdio: "ignore", env: { PATH: "/usr/bin:/bin" } },
      );
      const result = await waitForChild(child);
      if (result.code !== 0 || result.signal !== null)
        throw failure("unsafeRoot", "restricted-identity-probe", result);
    },
    chown: (path, uid, gid) => NodeFSP.chown(path, uid, gid),
    chownFile: (handle, uid, gid) => handle.chown(uid, gid),
    isOwnedBy: (stat, uid, gid) => stat.uid === uid && stat.gid === gid,
    spawn: async (executable, arguments_, options) => {
      const uid = options.uid;
      const gid = options.gid;
      if (uid === undefined || gid === undefined)
        throw failure("unsafeRoot", "restricted-spawn-identity");
      const trusted = await openTrustedInterpreter();
      try {
        await runtimeOptions.beforePrivilegedSpawn?.();
        const pathStat = await NodeFSP.lstat(interpreterPath);
        if (
          pathStat.isSymbolicLink() ||
          pathStat.dev !== trusted.identity.device ||
          pathStat.ino !== trusted.identity.inode
        )
          throw failure("unsafeRoot", "restricted-interpreter-replaced-before-spawn");
        const stdio = normalizePrivilegedStdio(options.stdio);
        const interpreterFd = 3;
        const { uid: _uid, gid: _gid, stdio: _stdio, ...launcherOptions } = options;
        const child = NodeChildProcess.spawn(
          `/proc/self/fd/${interpreterFd}`,
          [
            "-e",
            RESTRICTED_PROCESS_LAUNCHER,
            String(uid),
            String(gid),
            Buffer.from(executable, "utf8").toString("base64"),
            Buffer.from(JSON.stringify(arguments_), "utf8").toString("base64"),
            String(interpreterFd),
          ],
          { ...launcherOptions, stdio: [...stdio, trusted.handle.fd] },
        );
        let handleClosed = false;
        const closeHandle = () => {
          if (handleClosed) return;
          handleClosed = true;
          void trusted.handle.close();
        };
        child.once("spawn", closeHandle);
        child.once("error", closeHandle);
        return child;
      } catch (cause) {
        await trusted.handle.close();
        throw cause;
      }
    },
  };
  return runtime;
};

export const nodeWorkerCredentialIdentityRuntime = makeNodeWorkerCredentialIdentityRuntime();

interface PrivateRootIdentity {
  readonly path: string;
  readonly realPath: string;
  readonly device: number;
  readonly inode: number;
  readonly uid: number;
  readonly gid: number;
}

const assertNoSymlinkAncestors = async (path: string) => {
  const parsed = NodePath.parse(path);
  let cursor = parsed.root;
  for (const part of path.slice(parsed.root.length).split(NodePath.sep).filter(Boolean)) {
    cursor = NodePath.join(cursor, part);
    const stat = await NodeFSP.lstat(cursor);
    if (stat.isSymbolicLink()) throw failure("unsafeRoot", "symlink-ancestor");
  }
};

const assertPrivateRoot = async (
  root: string,
  workspaceDirectory: string,
  agentUid: number,
  agentGid: number,
) => {
  const resolved = NodePath.resolve(root);
  const parent = NodePath.dirname(resolved);
  await assertNoSymlinkAncestors(parent);
  const parentStat = await NodeFSP.lstat(parent);
  const workerUid = process.getuid?.();
  const workerGid = process.getgid?.();
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    workerUid === undefined ||
    workerGid === undefined ||
    parentStat.uid !== workerUid ||
    (parentStat.mode & 0o066) !== 0 ||
    agentUid === workerUid ||
    agentGid === workerGid
  )
    throw failure("unsafeRoot", "private-parent");
  try {
    await NodeFSP.mkdir(resolved, { mode: 0o711 });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
  }
  await assertNoSymlinkAncestors(resolved);
  const stat = await NodeFSP.lstat(resolved);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== workerUid ||
    stat.dev !== parentStat.dev ||
    (stat.mode & 0o077) !== 0o011
  )
    throw failure("unsafeRoot", "root-ownership");
  const realPath = await NodeFSP.realpath(resolved);
  const checkout = await NodeFSP.realpath(workspaceDirectory);
  if (
    realPath === checkout ||
    realPath.startsWith(`${checkout}${NodePath.sep}`) ||
    checkout.startsWith(`${realPath}${NodePath.sep}`)
  )
    throw failure("unsafeRoot", "checkout-root");
  return {
    path: resolved,
    realPath,
    device: stat.dev,
    inode: stat.ino,
    uid: stat.uid,
    gid: stat.gid,
  } satisfies PrivateRootIdentity;
};

const assertRootIdentity = async (root: PrivateRootIdentity) => {
  const stat = await NodeFSP.lstat(root.path);
  const realPath = await NodeFSP.realpath(root.path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.dev !== root.device ||
    stat.ino !== root.inode ||
    realPath !== root.realPath
  )
    throw failure("unsafeRoot", "root-replaced");
};

const fsyncDirectory = async (path: string) => {
  const handle = await NodeFSP.open(path, NodeConstants.O_RDONLY | NodeConstants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const PATH_SAFE_OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;

const resolveMaterializationDirectory = async (
  root: PrivateRootIdentity,
  profileRoot: string,
  operationId: AgentMaterializationId,
) => {
  if (!PATH_SAFE_OPERATION_ID.test(operationId)) {
    throw failure("unsafeRoot", "unsafe-materialization-id");
  }
  await assertRootChild(root, profileRoot);
  const stableProfileRoot = await NodeFSP.realpath(profileRoot);
  const candidate = NodePath.resolve(stableProfileRoot, `materialization-${operationId}`);
  if (
    NodePath.dirname(candidate) !== stableProfileRoot ||
    !candidate.startsWith(`${stableProfileRoot}${NodePath.sep}`)
  ) {
    throw failure("unsafeRoot", "materialization-containment");
  }
  return { candidate, stableProfileRoot };
};

const assertStableProfileRoot = async (
  root: PrivateRootIdentity,
  profileRoot: string,
  expectedRealPath: string,
) => {
  await assertRootChild(root, profileRoot);
  if ((await NodeFSP.realpath(profileRoot)) !== expectedRealPath) {
    throw failure("unsafeRoot", "profile-root-replaced");
  }
};

const assertRootChild = async (root: PrivateRootIdentity, path: string) => {
  await assertRootIdentity(root);
  const stat = await NodeFSP.lstat(path);
  const realPath = await NodeFSP.realpath(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.dev !== root.device ||
    stat.uid !== root.uid ||
    stat.gid !== root.gid ||
    (stat.mode & 0o077) !== 0o011 ||
    (realPath !== root.realPath && !realPath.startsWith(`${root.realPath}${NodePath.sep}`))
  )
    throw failure("unsafeRoot", "root-child");
};

const writeBundle = async (
  root: PrivateRootIdentity,
  profileRoot: string,
  operationId: AgentMaterializationId,
  bundle: ProviderProfileBundle,
  restrictedIdentity: { readonly uid: number; readonly gid: number },
  identityRuntime: WorkerCredentialIdentityRuntime,
) => {
  const { candidate: finalDirectory, stableProfileRoot } = await resolveMaterializationDirectory(
    root,
    profileRoot,
    operationId,
  );
  const temporaryDirectory = NodePath.join(
    profileRoot,
    `.materialization-${operationId}-${NodeCrypto.randomUUID()}`,
  );
  await NodeFSP.mkdir(temporaryDirectory, { mode: 0o711 });
  try {
    const directories = new Set<string>([temporaryDirectory]);
    for (const file of bundle.files) {
      const parts = file.path.split("/");
      let parent = temporaryDirectory;
      for (const part of parts.slice(0, -1)) {
        parent = NodePath.join(parent, part);
        await NodeFSP.mkdir(parent, { mode: 0o711 });
        directories.add(parent);
        const parentStat = await NodeFSP.lstat(parent);
        if (!parentStat.isDirectory() || parentStat.isSymbolicLink())
          throw failure("writeFailed", "parent-symlink");
      }
      const path = NodePath.join(temporaryDirectory, ...parts);
      const handle = await NodeFSP.open(
        path,
        NodeConstants.O_CREAT |
          NodeConstants.O_EXCL |
          NodeConstants.O_WRONLY |
          NodeConstants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(file.contents);
        await handle.sync();
        await handle.chmod(0o400);
        await identityRuntime.chownFile(handle, restrictedIdentity.uid, restrictedIdentity.gid);
      } finally {
        await handle.close();
      }
    }
    await fsyncDirectory(temporaryDirectory);
    for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
      await NodeFSP.chmod(directory, 0o711);
    }
    await assertStableProfileRoot(root, profileRoot, stableProfileRoot);
    const activeSibling = (await NodeFSP.readdir(profileRoot, { withFileTypes: true })).find(
      (entry) =>
        entry.name.startsWith("materialization-") &&
        entry.name !== NodePath.basename(finalDirectory),
    );
    if (activeSibling !== undefined) throw failure("writeFailed", "profile-already-materialized");
    await assertStableProfileRoot(root, profileRoot, stableProfileRoot);
    await NodeFSP.rm(finalDirectory, { recursive: true, force: true });
    await assertStableProfileRoot(root, profileRoot, stableProfileRoot);
    await NodeFSP.rename(temporaryDirectory, finalDirectory);
    await fsyncDirectory(profileRoot);
    await assertRootIdentity(root);
  } catch (cause) {
    try {
      await NodeFSP.rm(temporaryDirectory, { recursive: true, force: true });
    } catch (cleanupCause) {
      throw failure("cleanupFailed", "materialization-rollback", { cause, cleanupCause });
    }
    throw cause;
  }
};

const removeBundle = async (
  root: PrivateRootIdentity,
  profileRoot: string,
  operationId: AgentMaterializationId,
) => {
  const { candidate: finalDirectory, stableProfileRoot } = await resolveMaterializationDirectory(
    root,
    profileRoot,
    operationId,
  );
  await assertStableProfileRoot(root, profileRoot, stableProfileRoot);
  await NodeFSP.rm(finalDirectory, { recursive: true, force: true });
  await assertStableProfileRoot(root, profileRoot, stableProfileRoot);
  await fsyncDirectory(profileRoot);
  await assertRootIdentity(root);
  try {
    await NodeFSP.lstat(finalDirectory);
    throw failure("cleanupFailed", "confirm-absence");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
};

export const makeWorkerProviderCredentialExecutor = (input: {
  readonly privateRoot: string;
  readonly workspaceDirectory: string;
  readonly agentUid: number;
  readonly agentGid: number;
  readonly now?: Effect.Effect<string>;
  readonly identityRuntime?: WorkerCredentialIdentityRuntime;
  readonly leaseScheduler?: WorkerCredentialLeaseScheduler;
}): Effect.Effect<WorkerProviderCredentialExecutor, WorkerProviderCredentialError> =>
  Effect.gen(function* () {
    const identityRuntime = input.identityRuntime ?? nodeWorkerCredentialIdentityRuntime;
    const leaseScheduler = input.leaseScheduler ?? nativeLeaseScheduler;
    yield* Effect.tryPromise({
      try: () => identityRuntime.verify(input.agentUid, input.agentGid),
      catch: (cause) =>
        isWorkerProviderCredentialError(cause)
          ? cause
          : failure("unsafeRoot", "restricted-identity", cause),
    });
    const root = yield* Effect.tryPromise({
      try: () =>
        assertPrivateRoot(
          input.privateRoot,
          input.workspaceDirectory,
          input.agentUid,
          input.agentGid,
        ),
      catch: (cause) =>
        isWorkerProviderCredentialError(cause) ? cause : failure("unsafeRoot", "initialize", cause),
    });
    const profileRoot = NodePath.join(root.path, "profiles");
    yield* Effect.tryPromise({
      try: async () => {
        try {
          await NodeFSP.mkdir(profileRoot, { mode: 0o711 });
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
        }
        await NodeFSP.chmod(profileRoot, 0o711);
        await assertRootChild(root, profileRoot);
      },
      catch: (cause) => failure("unsafeRoot", "initialize-directories", cause),
    });
    const cleanedMaterializations = new Map<AgentMaterializationId, number>();
    const materializationLeases = new Map<
      AgentMaterializationId,
      { readonly cancel: () => void }
    >();
    const now = input.now ?? DateTime.now.pipe(Effect.map(DateTime.formatIso));

    const armMaterializationLease = (
      operationId: AgentMaterializationId,
      generation: number,
      expiresAt: string,
    ) =>
      Effect.try({
        try: () => {
          const expiresAtMs = Date.parse(expiresAt);
          const delay = expiresAtMs - leaseScheduler.nowMs();
          if (!Number.isFinite(expiresAtMs) || delay <= 0) {
            throw failure("cleanupFailed", "materialization-lease-expired");
          }
          const previous = materializationLeases.get(operationId);
          previous?.cancel();
          const timer = leaseScheduler.schedule(delay, async () => {
            materializationLeases.delete(operationId);
            try {
              await removeBundle(root, profileRoot, operationId);
              cleanedMaterializations.set(
                operationId,
                Math.max(cleanedMaterializations.get(operationId) ?? 0, generation),
              );
            } catch {
              // PostgreSQL owns the durable cleanup retry; reconnect and the
              // periodic expiry sweep will reissue cleanup until absence is confirmed.
            }
          });
          materializationLeases.set(operationId, timer);
        },
        catch: (cause) =>
          isWorkerProviderCredentialError(cause)
            ? cause
            : failure("cleanupFailed", "materialization-lease", cause),
      });

    const execute: WorkerProviderCredentialExecutor["execute"] = (
      command,
      credentialPayload,
      emit,
    ) =>
      Effect.gen(function* () {
        if (command.operation === "materialize") {
          if (
            (cleanedMaterializations.get(command.operationId) ?? 0) >= command.profileGeneration
          ) {
            yield* emit({
              type: "provider.credentials.result",
              operation: "materialize",
              operationId: command.operationId,
              routeGeneration: command.routeGeneration,
              profileGeneration: command.profileGeneration,
              outcome: "failed",
              errorCode: "cleanup_fenced",
              occurredAt: yield* now,
            });
            return yield* failure("writeFailed", "materialize-cleanup-fenced");
          }
          if (
            credentialPayload === undefined ||
            credentialPayload.byteLength !== command.credentialPayloadBytes
          )
            return yield* failure("invalidProfile", "missing-binary-payload");
          const bundle = yield* Effect.try({
            try: () => decodeProviderProfileBundle(credentialPayload),
            catch: (cause) =>
              isWorkerProviderCredentialError(cause)
                ? cause
                : failure("invalidProfile", "decode", cause),
          });
          const result = yield* Effect.result(
            Effect.tryPromise({
              try: () =>
                writeBundle(
                  root,
                  profileRoot,
                  command.operationId,
                  bundle,
                  { uid: input.agentUid, gid: input.agentGid },
                  identityRuntime,
                ),
              catch: (cause) => failure("writeFailed", "materialize", cause),
            }),
          );
          if (result._tag === "Failure") {
            yield* emit({
              type: "provider.credentials.result",
              operation: "materialize",
              operationId: command.operationId,
              routeGeneration: command.routeGeneration,
              profileGeneration: command.profileGeneration,
              outcome: "failed",
              errorCode: result.failure.code,
              occurredAt: yield* now,
            });
            return yield* result.failure;
          }
          const armed = yield* armMaterializationLease(
            command.operationId,
            command.profileGeneration,
            command.authorizationExpiresAt,
          ).pipe(Effect.result);
          if (armed._tag === "Failure") {
            const removed = yield* Effect.tryPromise({
              try: () => removeBundle(root, profileRoot, command.operationId),
              catch: (cause) => failure("cleanupFailed", "materialization-arm-rollback", cause),
            }).pipe(Effect.result);
            if (removed._tag === "Success") {
              cleanedMaterializations.set(
                command.operationId,
                Math.max(
                  cleanedMaterializations.get(command.operationId) ?? 0,
                  command.profileGeneration,
                ),
              );
            }
            const failureCause = removed._tag === "Failure" ? removed.failure : armed.failure;
            yield* emit({
              type: "provider.credentials.result",
              operation: "materialize",
              operationId: command.operationId,
              routeGeneration: command.routeGeneration,
              profileGeneration: command.profileGeneration,
              outcome: "failed",
              errorCode: failureCause.code,
              occurredAt: yield* now,
            });
            return yield* failureCause;
          }
          yield* emit({
            type: "provider.credentials.result",
            operation: "materialize",
            operationId: command.operationId,
            routeGeneration: command.routeGeneration,
            profileGeneration: command.profileGeneration,
            outcome: "materialized",
            occurredAt: yield* now,
          });
          return;
        }
        if (command.operation === "lease.arm") {
          const { candidate } = yield* Effect.tryPromise({
            try: () => resolveMaterializationDirectory(root, profileRoot, command.operationId),
            catch: (cause) => failure("unsafeRoot", "lease-arm-path", cause),
          });
          const exists = yield* Effect.tryPromise({
            try: async () => {
              try {
                return (await NodeFSP.lstat(candidate)).isDirectory();
              } catch (cause) {
                if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
                throw cause;
              }
            },
            catch: (cause) => failure("cleanupFailed", "lease-arm-stat", cause),
          });
          if (exists) {
            yield* armMaterializationLease(
              command.operationId,
              command.profileGeneration,
              command.authorizationExpiresAt,
            );
          }
          yield* emit({
            type: "provider.credentials.result",
            operation: "lease.arm",
            operationId: command.operationId,
            routeGeneration: command.routeGeneration,
            profileGeneration: command.profileGeneration,
            outcome: exists ? "armed" : "absent",
            occurredAt: yield* now,
          });
          return;
        }
        if (command.operation === "cleanup") {
          const leaseTimer = materializationLeases.get(command.operationId);
          leaseTimer?.cancel();
          materializationLeases.delete(command.operationId);
          const result = yield* Effect.result(
            Effect.tryPromise({
              try: () => removeBundle(root, profileRoot, command.operationId),
              catch: (cause) => failure("cleanupFailed", "cleanup", cause),
            }),
          );
          if (result._tag === "Success") {
            cleanedMaterializations.set(
              command.operationId,
              Math.max(
                cleanedMaterializations.get(command.operationId) ?? 0,
                command.profileGeneration,
              ),
            );
          }
          yield* emit({
            type: "provider.credentials.result",
            operation: "cleanup",
            operationId: command.operationId,
            routeGeneration: command.routeGeneration,
            profileGeneration: command.profileGeneration,
            outcome: result._tag === "Success" ? "absent" : "failed",
            ...(result._tag === "Failure" ? { errorCode: result.failure.code } : {}),
            occurredAt: yield* now,
          });
          if (result._tag === "Failure") return yield* result.failure;
          return;
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            credentialPayload?.fill(0);
          }),
        ),
      );

    return {
      execute,
      cleanupAll: Effect.tryPromise({
        try: async () => {
          for (const timer of materializationLeases.values()) timer.cancel();
          materializationLeases.clear();
          cleanedMaterializations.clear();
          await NodeFSP.rm(profileRoot, { recursive: true, force: true });
          await NodeFSP.mkdir(profileRoot, { mode: 0o711 });
          await fsyncDirectory(root.path);
          await assertRootIdentity(root);
        },
        catch: (cause) => failure("cleanupFailed", "cleanup-all", cause),
      }),
    };
  });
