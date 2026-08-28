import * as NodeCrypto from "node:crypto";

import {
  AuthenticationError,
  CommandExitError,
  type CommandHandle,
  FileType,
  InvalidArgumentError,
  RateLimitError,
  Sandbox,
  type SandboxApiOpts,
  type SandboxConnectOpts,
  type SandboxInfo,
  type SandboxMetrics,
  type SandboxMetricsOpts,
  SandboxNotFoundError,
  Template,
  type TemplateBuildStatusResponse,
  type SandboxOpts,
  type SandboxPauseOpts,
  TimeoutError,
} from "e2b";
import { SandboxPtyId } from "@t3tools/contracts/cloud";

import { E2B_DESKTOP_PORT } from "./template.ts";
import {
  E2bClientFailure,
  type E2bClient,
  type E2bExecutionResult,
  type E2bFileEntry,
  type E2bFileLimits,
  type E2bSandboxDescription,
  type E2bPtySessionRecord,
  type E2bPtySessionRegistry,
  type E2bPtyTerminalReason,
  type R2ArtifactWriter,
  type StreamingArtifactWriter,
  type E2bTrafficCredentialBroker,
} from "./types.ts";

export interface E2bSdkRuntime {
  /** True only when create binds both provider-native identities to the launched machine. */
  readonly immutableBuildLaunch: boolean;
  readonly create: (
    build: { readonly templateId: string; readonly buildId: string },
    options?: SandboxOpts,
  ) => Promise<Sandbox>;
  readonly connect: (sandboxId: string, options?: SandboxConnectOpts) => Promise<Sandbox>;
  readonly getInfo: (sandboxId: string, options?: SandboxApiOpts) => Promise<SandboxInfo>;
  readonly pause: (sandboxId: string, options?: SandboxPauseOpts) => Promise<boolean>;
  readonly kill: (sandboxId: string, options?: SandboxApiOpts) => Promise<boolean>;
  readonly getMetrics: (
    sandboxId: string,
    options?: SandboxMetricsOpts,
  ) => Promise<Array<SandboxMetrics>>;
  readonly getBuildStatus: (
    input: { readonly templateId: string; readonly buildId: string },
    options?: SandboxApiOpts,
  ) => Promise<TemplateBuildStatusResponse>;
}

const DEFAULT_SDK: E2bSdkRuntime = {
  // E2B 2.46 accepts only a template/tag in Sandbox.create(). Build status is queryable, but the
  // build ID cannot be bound to that launch. Fail before any remote create instead of silently
  // launching whichever build is currently attached to a mutable template identity.
  immutableBuildLaunch: false,
  create: async () => {
    throw new E2bClientFailure({
      code: "invalidRequest",
      message: "The installed E2B SDK cannot launch a provider-native immutable build ID",
      retryable: false,
      createDisposition: { status: "no-compute-confirmed" },
    });
  },
  connect: (sandboxId, options) => Sandbox.connect(sandboxId, options),
  getInfo: (sandboxId, options) => Sandbox.getInfo(sandboxId, options),
  pause: (sandboxId, options) => Sandbox.pause(sandboxId, options),
  kill: (sandboxId, options) => Sandbox.kill(sandboxId, options),
  getMetrics: (sandboxId, options) => Sandbox.getMetrics(sandboxId, options),
  getBuildStatus: (input, options) => Template.getBuildStatus(input, options),
};

export interface E2bSdkClientOptions {
  readonly apiKey: string;
  readonly domain?: string;
  readonly trafficCredentials: E2bTrafficCredentialBroker;
  readonly ptySessions: E2bPtySessionRegistry;
  readonly artifacts: Pick<R2ArtifactWriter, "resume">;
  /** Stable worker-process routing identity. Never contains a credential. */
  readonly ptyOwnerId: string;
  /** Fixed non-root template user for every generic agent operation. */
  readonly operationUser: "agentsin-agent";
  readonly inspectorUser: "agentsin-inspector";
  /** Test seam around E2B's static SDK surface. */
  readonly sdk?: E2bSdkRuntime;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

const commandLine = (command: string, arguments_: ReadonlyArray<string>) =>
  [command, ...arguments_].map(shellQuote).join(" ");

const toClientFailure = (operation: string, error: unknown) => {
  if (error instanceof AuthenticationError) {
    return new E2bClientFailure({
      code: "authentication",
      message: `E2B authentication failed during ${operation}`,
      retryable: false,
    });
  }
  if (error instanceof SandboxNotFoundError) {
    return new E2bClientFailure({
      code: "notFound",
      message: `E2B sandbox was not found during ${operation}`,
      retryable: false,
    });
  }
  if (error instanceof RateLimitError) {
    return new E2bClientFailure({
      code: "rateLimited",
      message: `E2B rate limited ${operation}`,
      retryable: true,
    });
  }
  if (error instanceof TimeoutError) {
    return new E2bClientFailure({
      code: "timeout",
      message: `E2B timed out during ${operation}`,
      retryable: true,
    });
  }
  if (error instanceof InvalidArgumentError) {
    return new E2bClientFailure({
      code: "invalidRequest",
      message: `E2B rejected the ${operation} request`,
      retryable: false,
    });
  }
  return new E2bClientFailure({
    code: "unavailable",
    message: `E2B ${operation} failed`,
    retryable: true,
  });
};

const safe = async <A>(operation: string, run: () => Promise<A>) => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof E2bClientFailure) throw error;
    throw toClientFailure(operation, error);
  }
};

const description = async (
  sandbox: Sandbox,
  trafficCredentials: E2bTrafficCredentialBroker,
): Promise<E2bSandboxDescription> => {
  const info = await sandbox.getInfo();
  const trafficCredentialRef =
    sandbox.trafficAccessToken === undefined
      ? undefined
      : await trafficCredentials.seal({
          sandboxId: sandbox.sandboxId,
          token: sandbox.trafficAccessToken,
          expiresAt: info.endAt,
        });
  return {
    sandboxId: sandbox.sandboxId,
    templateId: info.templateId,
    state: info.state,
    metadata: info.metadata,
    startedAt: info.startedAt,
    endAt: info.endAt,
    sandboxDomain: sandbox.sandboxDomain,
    ...(trafficCredentialRef === undefined ? {} : { trafficCredentialRef }),
  };
};

const descriptionFromInfo = (info: SandboxInfo): E2bSandboxDescription => ({
  sandboxId: info.sandboxId,
  templateId: info.templateId,
  state: info.state,
  metadata: info.metadata,
  startedAt: info.startedAt,
  endAt: info.endAt,
  ...(info.sandboxDomain === undefined ? {} : { sandboxDomain: info.sandboxDomain }),
});

const ptyProcessId = (ptyId: string) => {
  const pid = Number(ptyId);
  if (!Number.isSafeInteger(pid) || pid <= 0 || String(pid) !== ptyId) {
    throw new E2bClientFailure({
      code: "invalidRequest",
      message: "Invalid E2B PTY identifier",
      retryable: false,
    });
  }
  return pid;
};

const snapshotName = (label: string | undefined) => {
  if (label === undefined) return undefined;
  const name = label
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 63);
  return name.length === 0 ? undefined : name;
};

const listeningPorts = (stdout: string) => {
  const ports = new Set<number>();
  for (const line of stdout.split("\n")) {
    const address = line.trim().split(/\s+/).at(3);
    const match = address?.match(/:(\d+)$/);
    const port = match?.[1] === undefined ? undefined : Number(match[1]);
    if (port !== undefined && Number.isSafeInteger(port) && port > 0 && port <= 65_535) {
      ports.add(port);
    }
  }
  return [...ports].sort((left, right) => left - right);
};

const isFileEntryType = (value: unknown): value is E2bFileEntry["type"] =>
  value === "file" || value === "directory" || value === "symlink";

const OUTPUT_SUMMARY_LIMIT = 4_096;
const OUTPUT_SUMMARY_MARKER = "\n… output stored in R2 …\n";

class BoundedTextSummary {
  readonly #decoder = new TextDecoder();
  #content = "";
  #truncated = false;

  constructor(initial = "") {
    this.#appendText(initial);
  }

  append(chunk: Uint8Array) {
    this.#appendText(this.#decoder.decode(chunk, { stream: true }));
  }

  finish() {
    this.#appendText(this.#decoder.decode());
    return this.value();
  }

  value() {
    return this.#truncated
      ? `${this.#content.slice(0, OUTPUT_SUMMARY_LIMIT - OUTPUT_SUMMARY_MARKER.length)}${OUTPUT_SUMMARY_MARKER}`
      : this.#content;
  }

  #appendText(value: string) {
    if (value.length === 0) return;
    const remaining = OUTPUT_SUMMARY_LIMIT - this.#content.length;
    if (value.length > remaining) this.#truncated = true;
    if (remaining > 0) this.#content += value.slice(0, remaining);
  }
}

const pumpFileToArtifact = async (
  sandbox: Sandbox,
  path: string,
  writer: StreamingArtifactWriter,
  user: string,
) => {
  const reader = (await sandbox.files.read(path, { format: "stream", user })).getReader();
  const summary = new BoundedTextSummary();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      summary.append(next.value);
      await writer.write(next.value);
    }
    return { summary: summary.finish(), artifact: await writer.complete() };
  } catch (cause) {
    await reader.cancel().catch(() => undefined);
    throw cause;
  } finally {
    reader.releaseLock();
  }
};

const abortArtifacts = async (...writers: ReadonlyArray<StreamingArtifactWriter>) => {
  await Promise.allSettled(writers.map((writer) => writer.abort()));
};

const readBoundedFile = async (sandbox: Sandbox, path: string, maxBytes: number, user: string) => {
  const info = await sandbox.files.getInfo(path, { user });
  if (info.size > maxBytes) {
    throw new E2bClientFailure({
      code: "outputLimit",
      message: "E2B file exceeds the inline response limit",
      retryable: false,
    });
  }
  const reader = (await sandbox.files.read(path, { format: "stream", user })).getReader();
  const chunks: Array<Uint8Array> = [];
  let byteLength = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      byteLength += next.value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        throw new E2bClientFailure({
          code: "outputLimit",
          message: "E2B file changed while reading and exceeds the inline response limit",
          retryable: false,
        });
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const DIRECTORY_LIST_SCRIPT = `
import { opendir, lstat } from "node:fs/promises";
import { join } from "node:path";
const [root, maxEntriesValue, maxBytesValue] = process.argv.slice(2);
const maxEntries = Number(maxEntriesValue);
const maxBytes = Number(maxBytesValue);
let count = 0;
let bytes = 0;
const directory = await opendir(root);
for await (const entry of directory) {
  count += 1;
  if (count > maxEntries) {
    process.stdout.write(JSON.stringify({ overflow: true }) + "\\n");
    break;
  }
  const path = join(root, entry.name);
  const stat = await lstat(path);
  const type = stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file";
  const line = JSON.stringify({ path, type, sizeBytes: stat.size }) + "\\n";
  const lineBytes = Buffer.byteLength(line);
  if (bytes + lineBytes > maxBytes) {
    process.stdout.write(JSON.stringify({ overflow: true }) + "\\n");
    break;
  }
  bytes += lineBytes;
  process.stdout.write(line);
}
`;

const listBoundedDirectory = async (
  sandbox: Sandbox,
  path: string,
  limits: E2bFileLimits,
  user: string,
) => {
  const script = Buffer.from(DIRECTORY_LIST_SCRIPT).toString("base64");
  const result = await sandbox.commands.run(
    `printf %s ${shellQuote(script)} | base64 -d | node --input-type=module - ${shellQuote(path)} ${limits.maxListEntries} ${limits.maxListBytes}`,
    { user },
  );
  if (new TextEncoder().encode(result.stdout).byteLength > limits.maxListBytes + 64) {
    throw new E2bClientFailure({
      code: "outputLimit",
      message: "E2B directory listing exceeds the response limit",
      retryable: false,
    });
  }
  const entries: Array<E2bFileEntry> = [];
  for (const line of result.stdout.split("\n")) {
    if (line.length === 0) continue;
    const value: unknown = JSON.parse(line);
    if (
      typeof value !== "object" ||
      value === null ||
      ("overflow" in value && value.overflow === true)
    ) {
      throw new E2bClientFailure({
        code: "outputLimit",
        message: "E2B directory listing exceeds the response limit",
        retryable: false,
      });
    }
    if (
      !("path" in value) ||
      typeof value.path !== "string" ||
      !("type" in value) ||
      !isFileEntryType(value.type) ||
      !("sizeBytes" in value) ||
      typeof value.sizeBytes !== "number" ||
      !Number.isSafeInteger(value.sizeBytes) ||
      value.sizeBytes < 0
    ) {
      throw new E2bClientFailure({
        code: "unavailable",
        message: "E2B returned a malformed bounded directory listing",
        retryable: true,
      });
    }
    entries.push({
      path: value.path,
      type: value.type,
      sizeBytes: value.sizeBytes,
    });
  }
  return entries;
};

const directoryHasEntry = async (sandbox: Sandbox, path: string, user: string) => {
  const script = Buffer.from(`
import { opendir } from "node:fs/promises";
const directory = await opendir(process.argv[2]);
const entry = await directory.read();
await directory.close();
process.stdout.write(entry === null ? "0" : "1");
`).toString("base64");
  const result = await sandbox.commands.run(
    `printf %s ${shellQuote(script)} | base64 -d | node --input-type=module - ${shellQuote(path)}`,
    { user },
  );
  return result.stdout === "1";
};

export const makeE2bSdkClient = (options: E2bSdkClientOptions): E2bClient => {
  const sdk = options.sdk ?? DEFAULT_SDK;
  const ptyAttachments = new Map<
    string,
    {
      readonly handle: CommandHandle;
      readonly output: StreamingArtifactWriter;
      readonly summary: BoundedTextSummary;
      writeTail: Promise<void>;
      handoff: boolean;
      finalizing?: Promise<{
        readonly ptyId: SandboxPtyId;
        readonly state: "closed";
        readonly outputSummary: string;
        readonly outputArtifact: Awaited<ReturnType<StreamingArtifactWriter["complete"]>>;
      }>;
    }
  >();
  const connection = () => ({
    apiKey: options.apiKey,
    ...(options.domain === undefined ? {} : { domain: options.domain }),
  });

  const connect = (sandboxId: string, timeoutMs?: number) =>
    sdk.connect(sandboxId, {
      ...connection(),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });

  const connectRunning = async (sandboxId: string, timeoutMs: number) => {
    const before = await sdk.getInfo(sandboxId, connection());
    if (before.state !== "running") {
      throw new E2bClientFailure({
        code: "invalidRequest",
        message: "E2B sandbox is paused; resume it before this operation",
        retryable: false,
      });
    }
    const sandbox = await connect(sandboxId, timeoutMs);
    const after = await sandbox.getInfo();
    if (after.state !== "running") {
      throw new E2bClientFailure({
        code: "invalidRequest",
        message: "E2B sandbox stopped while the operation connected",
        retryable: true,
      });
    }
    return sandbox;
  };

  const ptySessionKey = (sandboxId: string, ptyId: string) => `${sandboxId}:${ptyId}`;

  type PtyAttachment = NonNullable<ReturnType<typeof ptyAttachments.get>>;

  const closeDetachedSession = async (
    record: E2bPtySessionRecord,
    reason: E2bPtyTerminalReason,
  ) => {
    const claimed = await options.ptySessions.claim(
      record.sandboxId,
      record.ptyId,
      options.ptyOwnerId,
    );
    if (claimed === undefined || claimed.state !== "open") return;
    try {
      const writer = await options.artifacts.resume(claimed.writerId);
      await writer.abort().catch(() => undefined);
    } finally {
      await options.ptySessions.markCleanupRequired(
        record.sandboxId,
        record.ptyId,
        options.ptyOwnerId,
        reason,
      );
    }
  };

  const finalizeAttachment = async (
    sandboxId: string,
    ptyId: SandboxPtyId,
    attachment: PtyAttachment,
    reason: E2bPtyTerminalReason,
    kill: boolean,
  ) => {
    if (attachment.finalizing !== undefined) return attachment.finalizing;
    const key = ptySessionKey(sandboxId, ptyId);
    attachment.finalizing = (async () => {
      try {
        if (kill) await attachment.handle.kill();
        await attachment.handle.disconnect();
        await attachment.writeTail;
        const outputSummary = attachment.summary.finish();
        const outputArtifact = await attachment.output.complete();
        await options.ptySessions.close(sandboxId, ptyId, options.ptyOwnerId, {
          outputSummary,
          outputArtifact,
          terminalReason: reason,
        });
        return { ptyId, state: "closed" as const, outputSummary, outputArtifact };
      } catch (cause) {
        await attachment.output.abort().catch(() => undefined);
        await options.ptySessions
          .markCleanupRequired(sandboxId, ptyId, options.ptyOwnerId, reason)
          .catch(() => undefined);
        throw cause;
      } finally {
        ptyAttachments.delete(key);
      }
    })();
    return attachment.finalizing;
  };

  const attachPty = async (sandbox: Sandbox, sandboxId: string, ptyId: SandboxPtyId) => {
    const key = ptySessionKey(sandboxId, ptyId);
    const existing = ptyAttachments.get(key);
    if (existing !== undefined) return { attachment: existing, record: undefined };
    const record = await options.ptySessions.claim(sandboxId, ptyId, options.ptyOwnerId);
    if (record === undefined) {
      throw new E2bClientFailure({
        code: "invalidRequest",
        message: "E2B PTY session is not registered",
        retryable: false,
      });
    }
    if (record.state !== "open") return { attachment: undefined, record };

    let output: StreamingArtifactWriter;
    try {
      output = await options.artifacts.resume(record.writerId);
    } catch (cause) {
      await options.ptySessions
        .markCleanupRequired(sandboxId, ptyId, options.ptyOwnerId, "writer-failure")
        .catch(() => undefined);
      throw cause;
    }
    const summary = new BoundedTextSummary(record.outputSummary);
    let attachment: PtyAttachment | undefined;
    let pendingWriteTail = Promise.resolve();
    const onData = (data: Uint8Array) => {
      summary.append(data);
      pendingWriteTail = pendingWriteTail
        .then(() => output.write(data))
        .then(() =>
          options.ptySessions.checkpoint(sandboxId, ptyId, options.ptyOwnerId, summary.value()),
        );
      if (attachment !== undefined) attachment.writeTail = pendingWriteTail;
      void pendingWriteTail.catch(() => {
        if (attachment !== undefined) {
          void finalizeAttachment(sandboxId, ptyId, attachment, "writer-failure", true).catch(
            () => undefined,
          );
        }
      });
      return pendingWriteTail;
    };
    try {
      const handle = await sandbox.pty.connect(ptyProcessId(ptyId), { onData });
      attachment = { handle, output, summary, writeTail: pendingWriteTail, handoff: false };
      ptyAttachments.set(key, attachment);
      void handle.wait().then(
        () =>
          attachment!.handoff
            ? undefined
            : finalizeAttachment(sandboxId, ptyId, attachment!, "natural-exit", false).catch(
                () => undefined,
              ),
        () =>
          attachment!.handoff
            ? undefined
            : finalizeAttachment(sandboxId, ptyId, attachment!, "natural-exit", false).catch(
                () => undefined,
              ),
      );
      return { attachment, record };
    } catch (cause) {
      await output.abort().catch(() => undefined);
      await options.ptySessions
        .markCleanupRequired(sandboxId, ptyId, options.ptyOwnerId, "writer-failure")
        .catch(() => undefined);
      throw cause;
    }
  };

  const describeCreated = async (
    sandbox: Sandbox,
    reclaimMetadata: Readonly<Record<string, string>>,
  ) => {
    try {
      return await description(sandbox, options.trafficCredentials);
    } catch {
      let cleanupFailed = false;
      try {
        await sdk.kill(sandbox.sandboxId, connection());
      } catch {
        cleanupFailed = true;
      }
      throw new E2bClientFailure({
        code: "unavailable",
        message: cleanupFailed
          ? "E2B credential sealing failed after create and cleanup could not be confirmed"
          : "E2B credential sealing failed after create; the sandbox was destroyed",
        retryable: cleanupFailed,
        createDisposition: cleanupFailed
          ? {
              status: "cleanup-required",
              providerHandle: sandbox.sandboxId,
              reclaimMetadata,
            }
          : { status: "cleanup-confirmed", providerHandle: sandbox.sandboxId },
      });
    }
  };

  const describeConnected = async (sandbox: Sandbox) => {
    try {
      return await description(sandbox, options.trafficCredentials);
    } catch {
      let cleanupFailed = false;
      try {
        await sdk.pause(sandbox.sandboxId, {
          ...connection(),
          keepMemory: true,
        });
      } catch {
        cleanupFailed = true;
      }
      throw new E2bClientFailure({
        code: "unavailable",
        message: cleanupFailed
          ? "E2B credential sealing failed after resume and pause could not be confirmed"
          : "E2B credential sealing failed after resume; the sandbox was paused",
        retryable: cleanupFailed,
      });
    }
  };

  const connectAndDescribe = async (sandboxId: string, timeoutMs: number) =>
    describeConnected(await connect(sandboxId, timeoutMs));

  const reconcilePtySessions = async (
    sandboxId: string,
    reason: E2bPtyTerminalReason,
    activeTimeoutMs: number,
  ) => {
    const records = await options.ptySessions.listReclaimable(sandboxId);
    if (records.length === 0) return;
    let info: SandboxInfo | undefined;
    try {
      info = await sdk.getInfo(sandboxId, connection());
    } catch (cause) {
      if (!(cause instanceof SandboxNotFoundError)) throw cause;
    }
    if (info?.state !== "running") {
      await Promise.all(records.map((record) => closeDetachedSession(record, reason)));
      return;
    }
    const sandbox = await connectRunning(sandboxId, activeTimeoutMs);
    for (const record of records) {
      if (record.state === "cleanup-required") {
        const claimed = await options.ptySessions.claim(
          sandboxId,
          record.ptyId,
          options.ptyOwnerId,
        );
        if (claimed === undefined || claimed.state === "closed") continue;
        await sandbox.pty.kill(ptyProcessId(record.ptyId));
        await options.ptySessions.markReclaimed(
          sandboxId,
          record.ptyId,
          options.ptyOwnerId,
          reason,
        );
        continue;
      }
      const attached = await attachPty(sandbox, sandboxId, record.ptyId);
      if (attached.attachment !== undefined) {
        await finalizeAttachment(sandboxId, record.ptyId, attached.attachment, reason, true);
      }
    }
  };

  const handoffPtySessions = async () => {
    for (const [key, attachment] of ptyAttachments) {
      const separator = key.lastIndexOf(":");
      const sandboxId = key.slice(0, separator);
      const ptyId = SandboxPtyId.make(key.slice(separator + 1));
      try {
        attachment.handoff = true;
        await attachment.handle.disconnect();
        await attachment.writeTail;
        await options.ptySessions.checkpoint(
          sandboxId,
          ptyId,
          options.ptyOwnerId,
          attachment.summary.value(),
        );
        await options.ptySessions.release(sandboxId, ptyId, options.ptyOwnerId);
        ptyAttachments.delete(key);
      } catch (cause) {
        attachment.handoff = false;
        await finalizeAttachment(sandboxId, ptyId, attachment, "shutdown", true).catch(
          () => undefined,
        );
        throw cause;
      }
    }
  };

  return {
    create: (input) =>
      safe("create", async () => {
        let sandbox: Sandbox;
        try {
          if (!sdk.immutableBuildLaunch) {
            throw new E2bClientFailure({
              code: "invalidRequest",
              message: "The installed E2B SDK cannot launch a provider-native immutable build ID",
              retryable: false,
              createDisposition: { status: "no-compute-confirmed" },
            });
          }
          const build = await sdk.getBuildStatus(
            { templateId: input.templateId, buildId: input.buildId },
            connection(),
          );
          if (
            build.templateID !== input.templateId ||
            build.buildID.toLowerCase() !== input.buildId.toLowerCase() ||
            build.status !== "ready"
          ) {
            throw new E2bClientFailure({
              code: "invalidRequest",
              message: "E2B immutable template build verification failed",
              retryable: false,
            });
          }
          sandbox = await sdk.create(
            { templateId: input.templateId, buildId: input.buildId },
            {
              ...connection(),
              timeoutMs: input.timeoutMs,
              metadata: { ...input.metadata },
              secure: true,
              allowInternetAccess: false,
              // Untrusted repository/package code starts without Internet egress. A later plugin
              // grant must use a separately reviewed broker/allowlist path; credentials alone do
              // not authorize arbitrary outbound traffic.
              network: { allowOut: [], allowPublicTraffic: false },
              lifecycle: {
                onTimeout: { action: "pause", keepMemory: true },
                autoResume: false,
              },
            },
          );
        } catch (cause) {
          const failure =
            cause instanceof E2bClientFailure ? cause : toClientFailure("create", cause);
          if (failure.createDisposition !== undefined) throw failure;
          const noComputeConfirmed =
            failure.code === "authentication" ||
            failure.code === "invalidRequest" ||
            failure.code === "rateLimited" ||
            failure.code === "notFound";
          throw new E2bClientFailure({
            code: failure.code,
            message: failure.message,
            retryable: failure.retryable,
            createDisposition: noComputeConfirmed
              ? { status: "no-compute-confirmed" }
              : { status: "cleanup-required", reclaimMetadata: input.metadata },
          });
        }
        return describeCreated(sandbox, input.metadata);
      }),
    inspect: (sandboxId) =>
      safe("inspect", async () => {
        try {
          return descriptionFromInfo(await sdk.getInfo(sandboxId, connection()));
        } catch (error) {
          if (error instanceof SandboxNotFoundError) return undefined;
          throw error;
        }
      }),
    resume: (sandboxId, timeoutMs) =>
      safe("resume", () => connectAndDescribe(sandboxId, timeoutMs)),
    execute: (sandboxId, input, output, activeTimeoutMs) =>
      safe("execute", async (): Promise<E2bExecutionResult> => {
        const user = options.operationUser;
        const sandbox = await connectRunning(sandboxId, activeTimeoutMs);
        const executionId = NodeCrypto.randomUUID();
        const stdoutPath = `/tmp/agentsin-cloud/${executionId}.stdout`;
        const stderrPath = `/tmp/agentsin-cloud/${executionId}.stderr`;
        let exitCode: number;
        try {
          await sandbox.commands.run("mkdir -p /tmp/agentsin-cloud", { user });
          try {
            // E2B 2.46 accumulates callback output inside CommandHandle. Redirect remotely so the
            // control plane only receives bounded stream chunks from the filesystem API.
            const result = await sandbox.commands.run(
              `exec ${commandLine(input.command, input.arguments)} >${shellQuote(stdoutPath)} 2>${shellQuote(stderrPath)}`,
              {
                user,
                ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
                ...(input.environment === undefined ? {} : { envs: { ...input.environment } }),
                ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
              },
            );
            exitCode = result.exitCode;
          } catch (error) {
            if (!(error instanceof CommandExitError)) throw error;
            exitCode = error.exitCode;
          }
          const [stdout, stderr] = await Promise.all([
            pumpFileToArtifact(sandbox, stdoutPath, output.stdout, user),
            pumpFileToArtifact(sandbox, stderrPath, output.stderr, user),
          ]);
          return {
            exitCode,
            stdoutSummary: stdout.summary,
            stderrSummary: stderr.summary,
            stdoutArtifact: stdout.artifact,
            stderrArtifact: stderr.artifact,
          };
        } catch (cause) {
          await abortArtifacts(output.stdout, output.stderr);
          throw cause;
        } finally {
          await Promise.allSettled([
            sandbox.files.remove(stdoutPath, { user }),
            sandbox.files.remove(stderrPath, { user }),
          ]);
        }
      }),
    files: (sandboxId, operation, limits, activeTimeoutMs) =>
      safe("files", async () => {
        const user = options.operationUser;
        const sandbox = await connectRunning(sandboxId, activeTimeoutMs);
        switch (operation.type) {
          case "read":
            return {
              type: "read",
              path: operation.path,
              bytes: await readBoundedFile(sandbox, operation.path, limits.maxReadBytes, user),
            };
          case "write": {
            if (operation.encoding === "utf8") {
              await sandbox.files.write(operation.path, operation.content, { user });
            } else {
              const decoded = Buffer.from(operation.content, "base64");
              const bytes = new ArrayBuffer(decoded.byteLength);
              new Uint8Array(bytes).set(decoded);
              await sandbox.files.write(operation.path, bytes, { user });
            }
            return { type: "write", path: operation.path };
          }
          case "list": {
            return {
              type: "list",
              path: operation.path,
              entries: await listBoundedDirectory(sandbox, operation.path, limits, user),
            };
          }
          case "remove": {
            if (!operation.recursive) {
              const info = await sandbox.files.getInfo(operation.path, { user });
              if (
                info.type === FileType.DIR &&
                (await directoryHasEntry(sandbox, operation.path, user))
              ) {
                throw new E2bClientFailure({
                  code: "invalidRequest",
                  message: "Recursive removal is required for a non-empty directory",
                  retryable: false,
                });
              }
            }
            await sandbox.files.remove(operation.path, { user });
            return { type: "remove", path: operation.path };
          }
        }
      }),
    pty: (sandboxId, operation, activeTimeoutMs, output) =>
      safe("pty", async () => {
        const user = options.operationUser;
        const sandbox = await connectRunning(sandboxId, activeTimeoutMs);
        switch (operation.type) {
          case "open": {
            if (operation.shell !== undefined) {
              throw new E2bClientFailure({
                code: "invalidRequest",
                message: "E2B PTYs do not support selecting a custom shell",
                retryable: false,
              });
            }
            if (output === undefined) {
              throw new E2bClientFailure({
                code: "invalidRequest",
                message: "E2B PTY output requires a durable artifact writer",
                retryable: false,
              });
            }
            const stream = {
              output,
              summary: new BoundedTextSummary(),
              writeTail: Promise.resolve(),
            };
            let handle: CommandHandle;
            let attachment: PtyAttachment | undefined;
            try {
              handle = await sandbox.pty.create({
                user,
                cols: operation.columns,
                rows: operation.rows,
                onData: (data) => {
                  stream.summary.append(data);
                  stream.writeTail = stream.writeTail
                    .then(() => stream.output.write(data))
                    .then(() => {
                      if (handle === undefined) return;
                      return options.ptySessions.checkpoint(
                        sandboxId,
                        SandboxPtyId.make(String(handle.pid)),
                        options.ptyOwnerId,
                        stream.summary.value(),
                      );
                    });
                  if (attachment !== undefined) attachment.writeTail = stream.writeTail;
                  void stream.writeTail.catch(() => {
                    if (attachment !== undefined) {
                      void finalizeAttachment(
                        sandboxId,
                        SandboxPtyId.make(String(attachment.handle.pid)),
                        attachment,
                        "writer-failure",
                        true,
                      ).catch(() => undefined);
                    }
                  });
                  return stream.writeTail;
                },
                ...(operation.cwd === undefined ? {} : { cwd: operation.cwd }),
              });
            } catch (cause) {
              await output.abort().catch(() => undefined);
              throw cause;
            }
            const ptyId = SandboxPtyId.make(String(handle.pid));
            attachment = { handle, ...stream, handoff: false };
            try {
              await options.ptySessions.create({
                sandboxId,
                ptyId,
                writerId: output.writerId,
                ownerId: options.ptyOwnerId,
                state: "open",
                outputSummary: "",
              });
            } catch (cause) {
              await Promise.allSettled([handle.kill(), handle.disconnect(), output.abort()]);
              throw cause;
            }
            ptyAttachments.set(ptySessionKey(sandboxId, ptyId), attachment);
            void handle.wait().then(
              () =>
                attachment.handoff
                  ? undefined
                  : finalizeAttachment(sandboxId, ptyId, attachment, "natural-exit", false).catch(
                      () => undefined,
                    ),
              () =>
                attachment.handoff
                  ? undefined
                  : finalizeAttachment(sandboxId, ptyId, attachment, "natural-exit", false).catch(
                      () => undefined,
                    ),
            );
            return { ptyId, state: "open" };
          }
          case "input": {
            const { attachment, record } = await attachPty(sandbox, sandboxId, operation.ptyId);
            if (attachment === undefined || record?.state === "closed") {
              throw new E2bClientFailure({
                code: "invalidRequest",
                message: "E2B PTY is already closed",
                retryable: false,
              });
            }
            try {
              await attachment.writeTail;
              await sandbox.pty.sendInput(
                ptyProcessId(operation.ptyId),
                new TextEncoder().encode(operation.data),
              );
            } catch (cause) {
              await finalizeAttachment(
                sandboxId,
                operation.ptyId,
                attachment,
                "input-failure",
                true,
              ).catch(() => undefined);
              throw cause;
            }
            return { ptyId: operation.ptyId, state: "open" };
          }
          case "resize": {
            const { attachment } = await attachPty(sandbox, sandboxId, operation.ptyId);
            if (attachment === undefined) {
              throw new E2bClientFailure({
                code: "invalidRequest",
                message: "E2B PTY is already closed",
                retryable: false,
              });
            }
            await sandbox.pty.resize(ptyProcessId(operation.ptyId), {
              cols: operation.columns,
              rows: operation.rows,
            });
            return { ptyId: operation.ptyId, state: "open" };
          }
          case "close": {
            const { attachment, record } = await attachPty(sandbox, sandboxId, operation.ptyId);
            if (attachment === undefined) {
              if (record?.state === "closed" && record.outputArtifact !== undefined) {
                return {
                  ptyId: operation.ptyId,
                  state: "closed",
                  outputSummary: record.outputSummary,
                  outputArtifact: record.outputArtifact,
                };
              }
              throw new E2bClientFailure({
                code: "unavailable",
                message: "E2B PTY cleanup requires reconciliation",
                retryable: true,
              });
            }
            return finalizeAttachment(
              sandboxId,
              operation.ptyId,
              attachment,
              "explicit-close",
              true,
            );
          }
        }
      }),
    pause: (sandboxId) =>
      safe("pause", async () => {
        // E2B returns false when the sandbox is already paused. Both outcomes converge on paused.
        await sdk.pause(sandboxId, { ...connection(), keepMemory: true });
      }),
    snapshot: (sandboxId, label, activeTimeoutMs) =>
      safe("snapshot", async () => {
        const sandbox = await connectRunning(sandboxId, activeTimeoutMs);
        const name = snapshotName(label);
        const result = await sandbox.createSnapshot({
          ...connection(),
          ...(name === undefined ? {} : { name }),
        });
        return { snapshotId: result.snapshotId, state: "paused" };
      }),
    desktop: (sandboxId, activeTimeoutMs) =>
      safe("desktop", async () => {
        const sandbox = await connectRunning(sandboxId, activeTimeoutMs);
        const ports = listeningPorts(
          (await sandbox.commands.run("ss -H -ltn", { user: options.inspectorUser })).stdout,
        );
        if (!ports.includes(E2B_DESKTOP_PORT)) return undefined;
        const connected = await describeConnected(sandbox);
        return {
          endpoint: `https://${sandbox.getHost(E2B_DESKTOP_PORT)}`,
          ...(connected.trafficCredentialRef === undefined
            ? {}
            : { credentialRef: connected.trafficCredentialRef }),
        };
      }),
    ports: (sandboxId, activeTimeoutMs) =>
      safe("ports", async () => {
        const sandbox = await connectRunning(sandboxId, activeTimeoutMs);
        const ports = listeningPorts(
          (await sandbox.commands.run("ss -H -ltn", { user: options.inspectorUser })).stdout,
        );
        return ports.map((internalPort) => ({
          internalPort,
          endpoint: `https://${sandbox.getHost(internalPort)}`,
        }));
      }),
    observability: (sandboxId, since, until) =>
      safe("observability", async () =>
        (
          await sdk.getMetrics(sandboxId, {
            ...connection(),
            start: since,
            end: until,
          })
        ).map((metric) => ({
          timestamp: metric.timestamp,
          cpuUsedPct: metric.cpuUsedPct,
          memoryUsedBytes: metric.memUsed,
          memoryTotalBytes: metric.memTotal,
          diskUsedBytes: metric.diskUsed,
          diskTotalBytes: metric.diskTotal,
        })),
      ),
    reconcilePtys: (sandboxId, reason, activeTimeoutMs) =>
      safe("PTY reconciliation", () => reconcilePtySessions(sandboxId, reason, activeTimeoutMs)),
    shutdownPtys: (mode, activeTimeoutMs) =>
      safe("PTY shutdown", async () => {
        if (mode === "handoff") {
          await handoffPtySessions();
          return;
        }
        const records = await options.ptySessions.listReclaimable();
        const sandboxIds = [...new Set(records.map((record) => record.sandboxId))];
        for (const sandboxId of sandboxIds) {
          await reconcilePtySessions(sandboxId, "shutdown", activeTimeoutMs);
        }
      }),
    destroy: (sandboxId) =>
      safe("destroy", async () => {
        try {
          // E2B returns false when the sandbox is already absent. Both outcomes converge on absent.
          await sdk.kill(sandboxId, connection());
          const records = await options.ptySessions.listReclaimable(sandboxId);
          for (const record of records) {
            const claimed = await options.ptySessions.claim(
              sandboxId,
              record.ptyId,
              options.ptyOwnerId,
            );
            if (claimed === undefined || claimed.state === "closed") continue;
            await options.ptySessions.markReclaimed(
              sandboxId,
              record.ptyId,
              options.ptyOwnerId,
              "destroy",
            );
          }
          return true;
        } finally {
          await options.trafficCredentials.revoke(sandboxId);
        }
      }),
  };
};
