// @effect-diagnostics nodeBuiltinImport:off -- This is the Linux filesystem isolation boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { INSPECTOR_MAX_FILE_BYTES } from "@t3tools/contracts/inspector";

export class ContainedWorkspaceError extends Error {
  readonly code:
    | "unsupported"
    | "invalid-operation"
    | "not-found"
    | "conflict"
    | "limit-exceeded"
    | "internal";
  readonly operation: string;
  override readonly cause: unknown;

  constructor(operation: string, code: ContainedWorkspaceError["code"], cause?: unknown) {
    super(operation);
    this.name = "ContainedWorkspaceError";
    this.operation = operation;
    this.code = code;
    this.cause = cause;
  }
}

interface DirectoryAnchor {
  readonly handle: NodeFSP.FileHandle;
  readonly visiblePath: string;
  readonly identity: { readonly dev: number; readonly ino: number };
}

export interface ContainedWorkspaceTestHooks {
  readonly afterPreparedBeforeCommit?: (
    relativePath: string,
    protectedPreparedPath: string,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly beforeLeafOpen?: (relativePath: string, signal: AbortSignal) => Promise<void>;
  readonly afterValidationBeforeCommit?: (
    relativePath: string,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly beforeRename?: (relativePath: string, signal: AbortSignal) => Promise<void>;
  readonly afterFinalValidationBeforeCommit?: (
    relativePath: string,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly afterExpectedCaptureBeforePublish?: (
    relativePath: string,
    signal: AbortSignal,
  ) => Promise<void>;
}

export interface SealedWorkspaceMount {
  /** Stable descriptor path, never the caller-controlled workspace pathname. */
  readonly source: string;
  readonly identity: { readonly dev: number; readonly ino: number };
}

export interface ContainedWorkspace {
  readonly root: string;
  readonly list: (
    relativePath: string,
    limit: number,
    hidden: (relativePath: string) => boolean,
    signal: AbortSignal,
  ) => Promise<
    ReadonlyArray<{
      readonly name: string;
      readonly type: "file" | "directory" | "symlink";
      readonly sizeBytes: number;
      readonly modifiedAt: string;
    }>
  >;
  readonly read: (
    relativePath: string,
    offset: number,
    length: number,
    signal: AbortSignal,
  ) => Promise<{ readonly bytes: Buffer; readonly eof: boolean }>;
  readonly write: (
    relativePath: string,
    bytes: Uint8Array,
    expectedSha256: string | null,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly sealedRootMount: (signal: AbortSignal) => Promise<SealedWorkspaceMount>;
  readonly assertDisjointProtectedPaths: (
    protectedPaths: ReadonlyArray<string>,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly close: () => Promise<void>;
}

const failure = (operation: string, code: ContainedWorkspaceError["code"], cause?: unknown) =>
  new ContainedWorkspaceError(operation, code, cause);

const identityOf = (stat: NodeFS.Stats) => ({ dev: stat.dev, ino: stat.ino });
const sameIdentity = (
  left: { readonly dev: number; readonly ino: number },
  right: { readonly dev: number; readonly ino: number },
) => left.dev === right.dev && left.ino === right.ino;
const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const checkpoint = (signal: AbortSignal) => signal.throwIfAborted();
const readWholeFile = async (handle: NodeFSP.FileHandle, size: number, signal: AbortSignal) => {
  checkpoint(signal);
  if (!Number.isSafeInteger(size) || size < 0 || size > INSPECTOR_MAX_FILE_BYTES) {
    throw failure("workspace-read", "limit-exceeded");
  }
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const read = await handle.read(bytes, offset, size - offset, offset);
    checkpoint(signal);
    if (read.bytesRead === 0) break;
    offset += read.bytesRead;
  }
  return bytes.subarray(0, offset);
};

const splitRelative = (relativePath: string) =>
  relativePath === "." ? [] : relativePath.split("/").filter((component) => component.length > 0);

/**
 * Opens a workspace root once and pins every traversed directory by descriptor.
 * On hosted Linux, leaf operations use `/proc/<worker-pid>/fd/<dirfd>` so a renamed or
 * replaced pathname cannot retarget an operation. Darwin is retained only for
 * deterministic unit tests and performs the same inode checks without claiming
 * production-grade openat semantics.
 */
export const openContainedWorkspace = async (options: {
  readonly workspaceDirectory: string;
  readonly hostPlatform: NodeJS.Platform;
  readonly requireLinuxDescriptorTraversal?: boolean;
  readonly untrustedUid?: number;
  readonly additionalUntrustedUids?: ReadonlyArray<number>;
  readonly testHooks?: ContainedWorkspaceTestHooks;
}): Promise<ContainedWorkspace> => {
  const root = await NodeFSP.realpath(options.workspaceDirectory);
  if (options.requireLinuxDescriptorTraversal === true && options.hostPlatform !== "linux") {
    throw failure("workspace-root", "unsupported");
  }
  const rootHandle = await NodeFSP.open(
    root,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW,
  );
  const rootStat = await rootHandle.stat();
  if (!rootStat.isDirectory()) {
    await rootHandle.close();
    throw failure("workspace-root", "not-found");
  }
  const rootIdentity = identityOf(rootStat);
  let closed = false;
  const writeLocks = new Map<string, Promise<void>>();

  const descriptorRoot = options.hostPlatform === "linux" ? `/proc/${process.pid}/fd` : "/dev/fd";

  const descriptorPath = (anchor: DirectoryAnchor, child?: string) => {
    const base =
      options.hostPlatform === "linux"
        ? `${descriptorRoot}/${anchor.handle.fd}`
        : anchor.visiblePath;
    return child === undefined ? base : NodePath.join(base, child);
  };

  const assertAnchor = async (anchor: DirectoryAnchor, signal: AbortSignal) => {
    checkpoint(signal);
    if (closed) throw failure("workspace-closed", "conflict");
    const [descriptorStat, visibleStat] = await Promise.all([
      anchor.handle.stat(),
      NodeFSP.lstat(anchor.visiblePath),
    ]);
    checkpoint(signal);
    if (
      !descriptorStat.isDirectory() ||
      !visibleStat.isDirectory() ||
      visibleStat.isSymbolicLink() ||
      !sameIdentity(anchor.identity, identityOf(descriptorStat)) ||
      !sameIdentity(anchor.identity, identityOf(visibleStat))
    ) {
      throw failure("workspace-path-replaced", "conflict");
    }
  };

  const rootAnchor: DirectoryAnchor = {
    handle: rootHandle,
    visiblePath: root,
    identity: rootIdentity,
  };

  const transactionParent = NodePath.dirname(root);
  const workerUid = process.getuid?.();
  const untrustedUids = new Set(
    [options.untrustedUid, ...(options.additionalUntrustedUids ?? [])].filter(
      (uid): uid is number => uid !== undefined,
    ),
  );
  let transactionDirectory: string | undefined;
  let transactionHandle: NodeFSP.FileHandle | undefined;
  try {
    const transactionParentStat = await NodeFSP.stat(transactionParent);
    if (
      options.requireLinuxDescriptorTraversal === true &&
      (untrustedUids.size === 0 ||
        workerUid === undefined ||
        untrustedUids.has(workerUid) ||
        transactionParentStat.dev !== rootIdentity.dev ||
        untrustedUids.has(transactionParentStat.uid) ||
        (transactionParentStat.mode & 0o022) !== 0)
    ) {
      throw failure("workspace-transaction-boundary", "unsupported");
    }
    transactionDirectory = await NodeFSP.mkdtemp(
      NodePath.join(transactionParent, ".agentsin-inspector-"),
    );
    await NodeFSP.chmod(transactionDirectory, 0o700);
    transactionHandle = await NodeFSP.open(
      transactionDirectory,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW,
    );
    const transactionStat = await transactionHandle.stat();
    if (
      !transactionStat.isDirectory() ||
      transactionStat.dev !== rootIdentity.dev ||
      (workerUid !== undefined && transactionStat.uid !== workerUid) ||
      (transactionStat.mode & 0o077) !== 0
    ) {
      throw failure("workspace-transaction-boundary", "unsupported");
    }
  } catch (cause) {
    await transactionHandle?.close().catch(() => undefined);
    if (transactionDirectory !== undefined) {
      await NodeFSP.rm(transactionDirectory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    await rootHandle.close();
    throw cause;
  }
  if (transactionDirectory === undefined || transactionHandle === undefined) {
    await rootHandle.close();
    throw failure("workspace-transaction-boundary", "internal");
  }
  const transactionStat = await transactionHandle.stat();
  const transactionAnchor: DirectoryAnchor = {
    handle: transactionHandle,
    visiblePath: transactionDirectory,
    identity: identityOf(transactionStat),
  };

  const openDirectories = async (components: ReadonlyArray<string>, signal: AbortSignal) => {
    const anchors: Array<DirectoryAnchor> = [rootAnchor];
    try {
      await assertAnchor(rootAnchor, signal);
      for (const component of components) {
        checkpoint(signal);
        if (component === "." || component === ".." || component.includes(NodePath.sep)) {
          throw failure("workspace-component", "invalid-operation");
        }
        const parent = anchors[anchors.length - 1];
        if (parent === undefined) throw failure("workspace-parent", "internal");
        await assertAnchor(parent, signal);
        const handle = await NodeFSP.open(
          descriptorPath(parent, component),
          NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW,
        );
        const stat = await handle.stat();
        checkpoint(signal);
        if (!stat.isDirectory()) {
          await handle.close();
          throw failure("workspace-directory", "invalid-operation");
        }
        anchors.push({
          handle,
          visiblePath: NodePath.join(parent.visiblePath, component),
          identity: identityOf(stat),
        });
      }
      for (const anchor of anchors) await assertAnchor(anchor, signal);
      return anchors;
    } catch (cause) {
      await Promise.allSettled(anchors.slice(1).map((anchor) => anchor.handle.close()));
      throw cause instanceof ContainedWorkspaceError
        ? cause
        : failure("workspace-traversal", "invalid-operation", cause);
    }
  };

  const releaseDirectories = (anchors: ReadonlyArray<DirectoryAnchor>) =>
    Promise.allSettled(anchors.slice(1).map((anchor) => anchor.handle.close())).then(
      () => undefined,
    );

  const withParent = async <A>(
    relativePath: string,
    use: (
      parent: DirectoryAnchor,
      leaf: string,
      anchors: ReadonlyArray<DirectoryAnchor>,
    ) => Promise<A>,
    signal: AbortSignal,
  ) => {
    checkpoint(signal);
    const components = splitRelative(relativePath);
    const leaf = components.pop();
    if (leaf === undefined || leaf === "." || leaf === "..") {
      throw failure("workspace-leaf", "invalid-operation");
    }
    const anchors = await openDirectories(components, signal);
    try {
      const parent = anchors[anchors.length - 1];
      if (parent === undefined) throw failure("workspace-parent", "internal");
      await options.testHooks?.beforeLeafOpen?.(relativePath, signal);
      checkpoint(signal);
      for (const anchor of anchors) await assertAnchor(anchor, signal);
      return await use(parent, leaf, anchors);
    } finally {
      await releaseDirectories(anchors);
    }
  };

  const withWriteLock = async <A>(
    relativePath: string,
    signal: AbortSignal,
    use: () => Promise<A>,
  ) => {
    const previous = writeLocks.get(relativePath) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    writeLocks.set(relativePath, queued);
    try {
      await previous;
      checkpoint(signal);
      return await use();
    } finally {
      release();
      if (writeLocks.get(relativePath) === queued) {
        void queued.finally(() => {
          if (writeLocks.get(relativePath) === queued) writeLocks.delete(relativePath);
        });
      }
    }
  };

  return {
    root,
    list: async (relativePath, limit, hidden, signal) => {
      checkpoint(signal);
      const anchors = await openDirectories(splitRelative(relativePath), signal);
      try {
        const target = anchors[anchors.length - 1];
        if (target === undefined) throw failure("files.list", "internal");
        const entries = await NodeFSP.readdir(descriptorPath(target), { withFileTypes: true });
        checkpoint(signal);
        const visible = entries
          .filter(
            (entry) => !hidden(relativePath === "." ? entry.name : `${relativePath}/${entry.name}`),
          )
          .slice(0, limit);
        const result = [];
        for (const entry of visible) {
          checkpoint(signal);
          const itemStat = await NodeFSP.lstat(descriptorPath(target, entry.name));
          result.push({
            name: entry.name,
            type: itemStat.isSymbolicLink()
              ? ("symlink" as const)
              : itemStat.isDirectory()
                ? ("directory" as const)
                : ("file" as const),
            sizeBytes: itemStat.size,
            modifiedAt: itemStat.mtime.toISOString(),
          });
        }
        for (const anchor of anchors) await assertAnchor(anchor, signal);
        return result;
      } finally {
        await releaseDirectories(anchors);
      }
    },
    read: async (relativePath, offset, length, signal) => {
      checkpoint(signal);
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length <= 0 ||
        length > INSPECTOR_MAX_FILE_BYTES
      ) {
        throw failure("files.read", "limit-exceeded");
      }
      return withParent(
        relativePath,
        async (parent, leaf, anchors) => {
          checkpoint(signal);
          const opened = await NodeFSP.open(
            descriptorPath(parent, leaf),
            NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
          );
          try {
            const stat = await opened.stat();
            checkpoint(signal);
            if (!stat.isFile()) throw failure("files.read", "invalid-operation");
            const buffer = Buffer.alloc(length);
            const read = await opened.read(buffer, 0, length, offset);
            checkpoint(signal);
            for (const anchor of anchors) await assertAnchor(anchor, signal);
            return {
              bytes: buffer.subarray(0, read.bytesRead),
              eof: offset + read.bytesRead >= stat.size,
            };
          } finally {
            await opened.close();
          }
        },
        signal,
      );
    },
    write: (relativePath, bytes, expectedSha256, signal) =>
      withWriteLock(relativePath, signal, () =>
        withParent(
          relativePath,
          async (parent, leaf, anchors) => {
            checkpoint(signal);
            if (bytes.byteLength > INSPECTOR_MAX_FILE_BYTES) {
              throw failure("files.write", "limit-exceeded");
            }
            let existing: NodeFSP.FileHandle | undefined;
            let existingIdentity: { readonly dev: number; readonly ino: number } | undefined;
            let existingSnapshot:
              | { readonly size: number; readonly mtimeMs: number; readonly ctimeMs: number }
              | undefined;
            if (expectedSha256 !== null) {
              existing = await NodeFSP.open(
                descriptorPath(parent, leaf),
                NodeFS.constants.O_RDONLY |
                  NodeFS.constants.O_NOFOLLOW |
                  NodeFS.constants.O_NONBLOCK,
              );
              const stat = await existing.stat();
              checkpoint(signal);
              if (!stat.isFile() || stat.size > INSPECTOR_MAX_FILE_BYTES) {
                await existing.close();
                throw failure("files.write", "conflict");
              }
              const current = await readWholeFile(existing, stat.size, signal);
              checkpoint(signal);
              if (sha256(current) !== expectedSha256) {
                await existing.close();
                throw failure("files.write", "conflict");
              }
              existingIdentity = identityOf(stat);
              existingSnapshot = { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
            }
            const tempName = `${NodeCrypto.randomUUID()}.prepared`;
            const tempPath = descriptorPath(transactionAnchor, tempName);
            const guardName = `${NodeCrypto.randomUUID()}.expected`;
            const guardPath = descriptorPath(transactionAnchor, guardName);
            let removeGuard = true;
            let temp: NodeFSP.FileHandle | undefined;
            try {
              checkpoint(signal);
              await assertAnchor(transactionAnchor, signal);
              temp = await NodeFSP.open(
                tempPath,
                NodeFS.constants.O_CREAT |
                  NodeFS.constants.O_EXCL |
                  NodeFS.constants.O_RDWR |
                  NodeFS.constants.O_NOFOLLOW,
                0o600,
              );
              await temp.writeFile(bytes);
              checkpoint(signal);
              await temp.sync();
              const preparedStat = await temp.stat();
              const preparedIdentity = identityOf(preparedStat);
              const preparedSha256 = sha256(bytes);
              const validatePrepared = async () => {
                checkpoint(signal);
                await assertAnchor(transactionAnchor, signal);
                const [openedStat, namedStat] = await Promise.all([
                  temp!.stat(),
                  NodeFSP.lstat(tempPath),
                ]);
                checkpoint(signal);
                if (!openedStat.isFile() || openedStat.size > INSPECTOR_MAX_FILE_BYTES) {
                  throw failure("files.write", "conflict");
                }
                const preparedBytes = await readWholeFile(temp!, openedStat.size, signal);
                checkpoint(signal);
                if (
                  !sameIdentity(preparedIdentity, identityOf(openedStat)) ||
                  !sameIdentity(preparedIdentity, identityOf(namedStat)) ||
                  openedStat.size !== bytes.byteLength ||
                  sha256(preparedBytes) !== preparedSha256
                ) {
                  throw failure("files.write", "conflict");
                }
              };
              await options.testHooks?.afterPreparedBeforeCommit?.(relativePath, tempPath, signal);
              await validatePrepared();
              const validateExpected = async (
                namedPath = descriptorPath(parent, leaf),
                captured = false,
              ) => {
                checkpoint(signal);
                for (const anchor of anchors) await assertAnchor(anchor, signal);
                if (
                  existing === undefined ||
                  existingIdentity === undefined ||
                  existingSnapshot === undefined
                ) {
                  // A null precondition is create-or-replace by contract. The
                  // cooperative writer lock still serializes inspector writers.
                  return;
                }
                const [openedStat, namedStat] = await Promise.all([
                  existing.stat(),
                  NodeFSP.lstat(namedPath),
                ]);
                checkpoint(signal);
                if (!openedStat.isFile() || openedStat.size > INSPECTOR_MAX_FILE_BYTES) {
                  throw failure("files.write", "conflict");
                }
                const current = await readWholeFile(existing, openedStat.size, signal);
                checkpoint(signal);
                if (
                  !sameIdentity(existingIdentity, identityOf(openedStat)) ||
                  !sameIdentity(existingIdentity, identityOf(namedStat)) ||
                  openedStat.size !== existingSnapshot.size ||
                  openedStat.mtimeMs !== existingSnapshot.mtimeMs ||
                  (!captured && openedStat.ctimeMs !== existingSnapshot.ctimeMs) ||
                  sha256(current) !== expectedSha256
                ) {
                  throw failure("files.write", "conflict");
                }
              };
              await validateExpected();
              await options.testHooks?.afterValidationBeforeCommit?.(relativePath, signal);
              checkpoint(signal);
              await validateExpected();
              await options.testHooks?.beforeRename?.(relativePath, signal);
              checkpoint(signal);
              await validateExpected();
              checkpoint(signal);
              await options.testHooks?.afterFinalValidationBeforeCommit?.(relativePath, signal);
              checkpoint(signal);
              if (existing === undefined) {
                // A null precondition is an explicit unconditional overwrite.
                await validatePrepared();
                await NodeFSP.rename(tempPath, descriptorPath(parent, leaf));
              } else {
                const leafPath = descriptorPath(parent, leaf);
                const restoreCapturedVersion = async () => {
                  try {
                    await NodeFSP.link(guardPath, leafPath);
                    return true;
                  } catch (cause) {
                    if ((cause as NodeJS.ErrnoException).code === "EEXIST") return true;
                    removeGuard = false;
                    return false;
                  }
                };

                // Capture the currently named version before publishing. Unlike a
                // replacing rename, this protocol never overwrites an unknown
                // concurrent writer: the new version is linked only while the name
                // is absent, and a competing publisher wins with EEXIST. The
                // captured version lives outside the checkout in a worker-only
                // directory that the untrusted provider uid cannot traverse.
                await assertAnchor(transactionAnchor, signal);
                await NodeFSP.rename(leafPath, guardPath);
                let published = false;
                try {
                  await validateExpected(guardPath, true);
                  checkpoint(signal);
                  await options.testHooks?.afterExpectedCaptureBeforePublish?.(
                    relativePath,
                    signal,
                  );
                  checkpoint(signal);
                  await validatePrepared();
                  await NodeFSP.link(tempPath, leafPath);
                  published = true;
                } catch (cause) {
                  if (!published) await restoreCapturedVersion();
                  if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
                    throw failure("files.write", "conflict", cause);
                  }
                  throw cause;
                }
                // Linking is the commit point. Cancellation after it must not turn
                // an applied write into a cancelled response.
                await NodeFSP.rm(guardPath, { force: true });
              }
            } finally {
              await existing?.close();
              await temp?.close().catch(() => undefined);
              await NodeFSP.rm(tempPath, { force: true }).catch(() => undefined);
              if (removeGuard) {
                await NodeFSP.rm(guardPath, { force: true }).catch(() => undefined);
              }
            }
          },
          signal,
        ),
      ),
    sealedRootMount: async (signal) => {
      await assertAnchor(rootAnchor, signal);
      const source =
        options.hostPlatform === "linux"
          ? descriptorPath(rootAnchor)
          : `/dev/fd/${rootAnchor.handle.fd}`;
      const descriptorStat = await NodeFSP.stat(source);
      checkpoint(signal);
      if (
        !descriptorStat.isDirectory() ||
        (options.hostPlatform === "darwin"
          ? descriptorStat.ino !== rootIdentity.ino
          : !sameIdentity(rootIdentity, identityOf(descriptorStat)))
      ) {
        throw failure("workspace-mount", "conflict");
      }
      await assertAnchor(rootAnchor, signal);
      return { source, identity: rootIdentity };
    },
    assertDisjointProtectedPaths: async (protectedPaths, signal) => {
      await assertAnchor(rootAnchor, signal);
      for (const protectedPath of protectedPaths) {
        checkpoint(signal);
        let canonical = NodePath.resolve(protectedPath);
        let protectedIdentity: { readonly dev: number; readonly ino: number } | undefined;
        try {
          canonical = await NodeFSP.realpath(protectedPath);
          protectedIdentity = identityOf(await NodeFSP.stat(canonical));
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        }
        checkpoint(signal);
        if (
          (protectedIdentity !== undefined && sameIdentity(rootIdentity, protectedIdentity)) ||
          canonical === root ||
          canonical.startsWith(`${root}${NodePath.sep}`) ||
          root.startsWith(`${canonical}${NodePath.sep}`)
        ) {
          throw failure("workspace-protected-overlap", "invalid-operation");
        }
      }
      await assertAnchor(rootAnchor, signal);
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await transactionHandle.close();
      await NodeFSP.rm(transactionDirectory, { recursive: true, force: true });
      await rootHandle.close();
    },
  };
};
