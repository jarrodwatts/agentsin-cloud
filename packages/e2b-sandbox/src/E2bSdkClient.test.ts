import * as NodeCrypto from "node:crypto";

import {
  AuthenticationError,
  type CommandHandle,
  type Sandbox,
  type SandboxConnectOpts,
  type SandboxInfo,
  type SandboxOpts,
} from "e2b";
import { SandboxPtyId } from "@t3tools/contracts/cloud";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { type E2bSdkClientOptions, type E2bSdkRuntime, makeE2bSdkClient } from "./E2bSdkClient.ts";
import { assignImmutableE2bBuildTag, parseE2bTemplateReference } from "./template.ts";
import type {
  E2bPtySessionRecord,
  E2bTrafficCredentialBroker,
  R2ArtifactWriter,
  StreamingArtifactWriter,
} from "./types.ts";

const NOW = DateTime.toDate(DateTime.makeUnsafe("2026-08-27T12:00:00.000Z"));
const END = DateTime.toDate(DateTime.makeUnsafe("2026-08-27T12:15:00.000Z"));
const BUILD_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

const info: SandboxInfo = {
  sandboxId: "sandbox-1",
  templateId: "template-1",
  metadata: { agentsin_cloud_provider: "e2b" },
  startedAt: NOW,
  endAt: END,
  state: "running",
  cpuCount: 4,
  memoryMB: 8_192,
  envdVersion: "0.6.4",
  sandboxDomain: "sandbox-1.e2b.app",
};

const makeSandbox = (overrides?: Partial<Sandbox>) =>
  ({
    sandboxId: "sandbox-1",
    sandboxDomain: "sandbox-1.e2b.app",
    trafficAccessToken: "raw-traffic-token",
    getInfo: async () => info,
    ...overrides,
  }) as Sandbox;

const makeSdk = (sandbox: Sandbox, overrides?: Partial<E2bSdkRuntime>): E2bSdkRuntime => ({
  immutableBuildLaunch: true,
  create: async () => sandbox,
  connect: async () => sandbox,
  getInfo: async () => info,
  pause: async () => true,
  kill: async () => true,
  getMetrics: async () => [],
  getBuildStatus: async ({ templateId, buildId }) => ({
    templateID: templateId,
    buildID: buildId,
    status: "ready",
    logEntries: [],
    logs: [],
  }),
  ...overrides,
});

const failingBroker = (message: string): E2bTrafficCredentialBroker => ({
  seal: async () => {
    throw new Error(message);
  },
  revoke: async () => undefined,
});

const acceptingBroker: E2bTrafficCredentialBroker = {
  seal: async ({ sandboxId }) => `secret-broker/e2b/${sandboxId}`,
  revoke: async () => undefined,
};

const artifactReference = (kind: string, sizeBytes: number) => ({
  storage: "r2" as const,
  bucket: "sandbox-artifacts",
  objectKey: `sandbox-1/${kind}`,
  contentHash: NodeCrypto.createHash("sha256").update(`${kind}:${sizeBytes}`).digest("hex"),
  sizeBytes,
});

const makeWriter = (kind: string) => {
  let totalBytes = 0;
  let maxChunkBytes = 0;
  let aborted = false;
  const writer: StreamingArtifactWriter = {
    writerId: `writer-${kind}`,
    write: async (chunk) => {
      totalBytes += chunk.byteLength;
      maxChunkBytes = Math.max(maxChunkBytes, chunk.byteLength);
    },
    complete: async () => artifactReference(kind, totalBytes),
    abort: async () => {
      aborted = true;
    },
  };
  return {
    writer,
    totalBytes: () => totalBytes,
    maxChunkBytes: () => maxChunkBytes,
    aborted: () => aborted,
  };
};

const makePtyInfrastructure = () => {
  const records = new Map<string, E2bPtySessionRecord>();
  const writers = new Map<string, StreamingArtifactWriter>();
  const terminalRecords: Array<E2bPtySessionRecord> = [];
  const terminalWaiters: Array<(record: E2bPtySessionRecord) => void> = [];
  const key = (sandboxId: string, ptyId: string) => `${sandboxId}:${ptyId}`;
  const emitTerminal = (record: E2bPtySessionRecord) => {
    const waiter = terminalWaiters.shift();
    if (waiter === undefined) terminalRecords.push(record);
    else waiter(record);
  };
  const ptySessions: E2bSdkClientOptions["ptySessions"] = {
    create: async (record) => {
      if (records.has(key(record.sandboxId, record.ptyId))) throw new Error("duplicate PTY");
      records.set(key(record.sandboxId, record.ptyId), record);
    },
    get: async (sandboxId, ptyId) => records.get(key(sandboxId, ptyId)),
    claim: async (sandboxId, ptyId, ownerId) => {
      const record = records.get(key(sandboxId, ptyId));
      if (record === undefined || record.state === "closed") return record;
      if (record.ownerId !== undefined && record.ownerId !== ownerId) {
        throw new Error("PTY owner lease is still active");
      }
      const claimed = { ...record, ownerId };
      records.set(key(sandboxId, ptyId), claimed);
      return claimed;
    },
    checkpoint: async (sandboxId, ptyId, ownerId, outputSummary) => {
      const record = records.get(key(sandboxId, ptyId));
      if (record?.ownerId !== ownerId) throw new Error("PTY ownership changed");
      records.set(key(sandboxId, ptyId), { ...record, outputSummary });
    },
    close: async (sandboxId, ptyId, ownerId, result) => {
      const record = records.get(key(sandboxId, ptyId));
      if (record?.ownerId !== ownerId) throw new Error("PTY ownership changed");
      const { ownerId: _ownerId, ...unowned } = record;
      const closed: E2bPtySessionRecord = {
        ...unowned,
        state: "closed",
        ...result,
      };
      records.set(key(sandboxId, ptyId), closed);
      emitTerminal(closed);
    },
    markCleanupRequired: async (sandboxId, ptyId, ownerId, terminalReason) => {
      const record = records.get(key(sandboxId, ptyId));
      if (record?.ownerId !== ownerId) throw new Error("PTY ownership changed");
      const { ownerId: _ownerId, ...unowned } = record;
      const cleanupRequired: E2bPtySessionRecord = {
        ...unowned,
        state: "cleanup-required",
        terminalReason,
      };
      records.set(key(sandboxId, ptyId), cleanupRequired);
      emitTerminal(cleanupRequired);
    },
    markReclaimed: async (sandboxId, ptyId, ownerId, terminalReason) => {
      const record = records.get(key(sandboxId, ptyId));
      if (record?.ownerId !== ownerId) throw new Error("PTY ownership changed");
      const { ownerId: _ownerId, ...unowned } = record;
      const reclaimed: E2bPtySessionRecord = {
        ...unowned,
        state: "closed",
        terminalReason,
      };
      records.set(key(sandboxId, ptyId), reclaimed);
      emitTerminal(reclaimed);
    },
    release: async (sandboxId, ptyId, ownerId) => {
      const record = records.get(key(sandboxId, ptyId));
      if (record?.ownerId !== ownerId) throw new Error("PTY ownership changed");
      const { ownerId: _ownerId, ...unowned } = record;
      records.set(key(sandboxId, ptyId), unowned);
    },
    listReclaimable: async (sandboxId) =>
      [...records.values()].filter(
        (record) =>
          record.state !== "closed" && (sandboxId === undefined || record.sandboxId === sandboxId),
      ),
  };
  const artifacts: Pick<R2ArtifactWriter, "resume"> = {
    resume: async (writerId) => {
      const writer = writers.get(writerId);
      if (writer === undefined) throw new Error("writer not found");
      return writer;
    },
  };
  return {
    records,
    writers,
    ptySessions,
    artifacts,
    registerWriter: (writer: StreamingArtifactWriter) => writers.set(writer.writerId, writer),
    nextTerminal: () => {
      const record = terminalRecords.shift();
      return record === undefined
        ? new Promise<E2bPtySessionRecord>((resolve) => terminalWaiters.push(resolve))
        : Promise.resolve(record);
    },
  };
};

const makeTestClient = (
  options: Pick<E2bSdkClientOptions, "apiKey" | "trafficCredentials"> & {
    readonly sdk?: E2bSdkRuntime;
    readonly ptyOwnerId?: string;
    readonly ptyInfrastructure?: ReturnType<typeof makePtyInfrastructure>;
  },
) => {
  const ptyInfrastructure = options.ptyInfrastructure ?? makePtyInfrastructure();
  return makeE2bSdkClient({
    operationUser: "agentsin-agent",
    inspectorUser: "agentsin-inspector",
    apiKey: options.apiKey,
    trafficCredentials: options.trafficCredentials,
    ...(options.sdk === undefined ? {} : { sdk: options.sdk }),
    ptySessions: ptyInfrastructure.ptySessions,
    artifacts: ptyInfrastructure.artifacts,
    ptyOwnerId: options.ptyOwnerId ?? "worker-1",
  });
};

const chunkStream = (chunkCount: number, chunkBytes: number, onCancel?: () => void) => {
  let emitted = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted >= chunkCount) {
        controller.close();
        return;
      }
      emitted += 1;
      controller.enqueue(new Uint8Array(chunkBytes).fill(97));
    },
    cancel() {
      onCancel?.();
    },
  });
};

describe("E2B SDK client", () => {
  it("launches the exact build-specific tag assigned after a template build", async () => {
    const buildId = BUILD_ID;
    const reference = await assignImmutableE2bBuildTag({
      templateName: "agentsin-cloud-base",
      templateId: "template-1",
      stagingTag: "staging-sdk-test",
      buildId,
      assignTags: async (_target, tag) => ({ buildId, tags: [tag] }),
    });
    const launchTag = parseE2bTemplateReference(reference);
    expect(launchTag).toEqual({ templateId: "template-1", buildId });
    if (launchTag === undefined) throw new Error("Expected an immutable E2B launch tag");
    let createdBuild: { readonly templateId: string; readonly buildId: string } | undefined;
    let createdOptions: SandboxOpts | undefined;
    const sandbox = makeSandbox();
    const client = makeTestClient({
      apiKey: "test-api-key",
      trafficCredentials: acceptingBroker,
      sdk: makeSdk(sandbox, {
        create: async (build, options) => {
          createdBuild = build;
          createdOptions = options;
          return sandbox;
        },
      }),
    });

    await client.create({ ...launchTag, metadata: {}, timeoutMs: 60_000 });
    expect(createdBuild).toEqual({ templateId: "template-1", buildId: BUILD_ID });
    expect(createdOptions).toMatchObject({
      secure: true,
      allowInternetAccess: false,
      network: { allowOut: [], allowPublicTraffic: false },
      lifecycle: {
        onTimeout: { action: "pause", keepMemory: true },
        autoResume: false,
      },
    });
  });

  it("fails before provider I/O when the SDK cannot bind a build ID to launch", async () => {
    const client = makeTestClient({
      apiKey: "test-api-key",
      trafficCredentials: acceptingBroker,
      sdk: makeSdk(makeSandbox(), { immutableBuildLaunch: false }),
    });

    await expect(
      client.create({
        templateId: "template-1",
        buildId: BUILD_ID,
        metadata: {},
        timeoutMs: 60_000,
      }),
    ).rejects.toMatchObject({
      code: "invalidRequest",
      retryable: false,
      createDisposition: { status: "no-compute-confirmed" },
    });
  });

  it("marks the installed SDK immutable-launch capability unavailable", async () => {
    const client = makeTestClient({
      apiKey: "test-api-key",
      trafficCredentials: acceptingBroker,
    });

    await expect(
      client.create({
        templateId: "template-1",
        buildId: BUILD_ID,
        metadata: {},
        timeoutMs: 60_000,
      }),
    ).rejects.toMatchObject({
      code: "invalidRequest",
      message: "The installed E2B SDK cannot launch a provider-native immutable build ID",
      retryable: false,
      createDisposition: { status: "no-compute-confirmed" },
    });
  });

  it("destroys a newly created sandbox when traffic-token sealing fails", async () => {
    const sandbox = makeSandbox();
    let killCalls = 0;
    const client = makeTestClient({
      apiKey: "test-api-key",
      trafficCredentials: failingBroker("raw-traffic-token must never escape"),
      sdk: makeSdk(sandbox, {
        kill: async () => {
          killCalls += 1;
          return true;
        },
      }),
    });

    await expect(
      client.create({
        templateId: "template-1",
        buildId: BUILD_ID,
        metadata: {},
        timeoutMs: 60_000,
      }),
    ).rejects.toMatchObject({
      code: "unavailable",
      message: "E2B credential sealing failed after create; the sandbox was destroyed",
      createDisposition: {
        status: "cleanup-confirmed",
        providerHandle: "sandbox-1",
      },
    });
    expect(killCalls).toBe(1);
  });

  it("classifies authentication failure as non-retryable before compute exists", async () => {
    let killCalls = 0;
    const client = makeTestClient({
      apiKey: "invalid-api-key",
      trafficCredentials: acceptingBroker,
      sdk: makeSdk(makeSandbox(), {
        create: async () => {
          throw new AuthenticationError("raw upstream authentication detail");
        },
        kill: async () => {
          killCalls += 1;
          return true;
        },
      }),
    });

    await expect(
      client.create({
        templateId: "template-1",
        buildId: BUILD_ID,
        metadata: {},
        timeoutMs: 60_000,
      }),
    ).rejects.toMatchObject({
      code: "authentication",
      retryable: false,
      message: "E2B authentication failed during create",
      createDisposition: { status: "no-compute-confirmed" },
    });
    expect(killCalls).toBe(0);
  });

  it("rejects a mismatched immutable build before creating compute", async () => {
    let createCalls = 0;
    const client = makeTestClient({
      apiKey: "test-api-key",
      trafficCredentials: acceptingBroker,
      sdk: makeSdk(makeSandbox(), {
        getBuildStatus: async ({ templateId }) => ({
          templateID: templateId,
          buildID: "11111111-1111-4111-8111-111111111111",
          status: "ready",
          logEntries: [],
          logs: [],
        }),
        create: async () => {
          createCalls += 1;
          return makeSandbox();
        },
      }),
    });

    await expect(
      client.create({
        templateId: "template-1",
        buildId: BUILD_ID,
        metadata: {},
        timeoutMs: 60_000,
      }),
    ).rejects.toMatchObject({
      code: "invalidRequest",
      retryable: false,
      createDisposition: { status: "no-compute-confirmed" },
    });
    expect(createCalls).toBe(0);
  });

  it("pauses a resumed sandbox when traffic-token sealing fails", async () => {
    const sandbox = makeSandbox();
    let pauseCalls = 0;
    let connectOptions: SandboxConnectOpts | undefined;
    const client = makeTestClient({
      apiKey: "test-api-key",
      trafficCredentials: failingBroker("raw-traffic-token must never escape"),
      sdk: makeSdk(sandbox, {
        connect: async (_sandboxId, options) => {
          connectOptions = options;
          return sandbox;
        },
        pause: async () => {
          pauseCalls += 1;
          return true;
        },
      }),
    });

    await expect(client.resume("sandbox-1", 900_000)).rejects.toMatchObject({
      code: "unavailable",
      message: "E2B credential sealing failed after resume; the sandbox was paused",
    });
    expect(pauseCalls).toBe(1);
    expect(connectOptions?.timeoutMs).toBe(900_000);
  });

  it("treats an already-paused false response as convergent success", async () => {
    const client = makeTestClient({
      apiKey: "test-api-key",
      trafficCredentials: acceptingBroker,
      sdk: makeSdk(makeSandbox(), { pause: async () => false }),
    });

    await expect(client.pause("sandbox-1")).resolves.toBeUndefined();
  });

  it("treats an already-absent false kill response as convergent success", async () => {
    const client = makeTestClient({
      apiKey: "test-api-key",
      trafficCredentials: acceptingBroker,
      sdk: makeSdk(makeSandbox(), { kill: async () => false }),
    });

    await expect(client.destroy("sandbox-1")).resolves.toBe(true);
  });

  it("sanitizes broker and cleanup failures without exposing token material", async () => {
    const sandbox = makeSandbox();
    const client = makeTestClient({
      apiKey: "test-api-key",
      trafficCredentials: failingBroker("raw-traffic-token"),
      sdk: makeSdk(sandbox, {
        kill: async () => {
          throw new Error("cleanup raw-traffic-token");
        },
      }),
    });

    const failure = await client
      .create({
        templateId: "template-1",
        buildId: BUILD_ID,
        metadata: { agentsin_cloud_reservation_id: "command-create" },
        timeoutMs: 60_000,
      })
      .catch((cause: unknown) => cause);
    expect(failure).toMatchObject({
      code: "unavailable",
      retryable: true,
      message: "E2B credential sealing failed after create and cleanup could not be confirmed",
      createDisposition: {
        status: "cleanup-required",
        providerHandle: "sandbox-1",
        reclaimMetadata: { agentsin_cloud_reservation_id: "command-create" },
      },
    });
    expect(String(failure)).not.toContain("raw-traffic-token");

    const resumeClient = makeTestClient({
      apiKey: "test-api-key",
      trafficCredentials: failingBroker("raw-traffic-token"),
      sdk: makeSdk(sandbox, {
        pause: async () => false,
      }),
    });
    const resumeFailure = await resumeClient
      .resume("sandbox-1", 900_000)
      .catch((cause: unknown) => cause);
    expect(resumeFailure).toMatchObject({
      code: "unavailable",
      retryable: false,
      message: "E2B credential sealing failed after resume; the sandbox was paused",
    });
    expect(String(resumeFailure)).not.toContain("raw-traffic-token");
  });

  it("streams large command output to artifact writers with bounded summaries", async () => {
    const stdoutChunks = 32;
    const chunkBytes = 256 * 1024;
    const stdout = makeWriter("stdout");
    const stderr = makeWriter("stderr");
    let readCount = 0;
    const commandUsers: Array<unknown> = [];
    const fileUsers: Array<unknown> = [];
    const sandbox = makeSandbox({
      commands: {
        run: async (_command: string, options?: { readonly user?: string }) => {
          commandUsers.push(options?.user);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      } as unknown as Sandbox["commands"],
      files: {
        read: async (_path: string, options?: { readonly user?: string }) => {
          fileUsers.push(options?.user);
          readCount += 1;
          return readCount === 1 ? chunkStream(stdoutChunks, chunkBytes) : chunkStream(0, 0);
        },
        remove: async (_path: string, options?: { readonly user?: string }) => {
          fileUsers.push(options?.user);
        },
      } as unknown as Sandbox["files"],
    });
    const client = makeTestClient({
      apiKey: "test-api-key",
      trafficCredentials: failingBroker("unused"),
      sdk: makeSdk(sandbox),
    });

    const result = await client.execute(
      "sandbox-1",
      { command: "generate", arguments: [] },
      { stdout: stdout.writer, stderr: stderr.writer },
      900_000,
    );

    expect(stdout.totalBytes()).toBe(stdoutChunks * chunkBytes);
    expect(stdout.maxChunkBytes()).toBe(chunkBytes);
    expect(result.stdoutSummary.length).toBeLessThanOrEqual(4_096);
    expect(result.stdoutArtifact.sizeBytes).toBe(stdoutChunks * chunkBytes);
    expect(stdout.aborted()).toBe(false);
    expect(commandUsers).toEqual(["agentsin-agent", "agentsin-agent"]);
    expect(fileUsers).toEqual([
      "agentsin-agent",
      "agentsin-agent",
      "agentsin-agent",
      "agentsin-agent",
    ]);
  });

  it("rejects oversized and growing file reads without materializing beyond the cap", async () => {
    let readCalls = 0;
    const oversized = makeSandbox({
      files: {
        getInfo: async () => ({ size: 9 }),
        read: async () => {
          readCalls += 1;
          return chunkStream(1, 9);
        },
      } as unknown as Sandbox["files"],
    });
    const oversizedClient = makeTestClient({
      apiKey: "test-api-key",
      trafficCredentials: failingBroker("unused"),
      sdk: makeSdk(oversized),
    });
    await expect(
      oversizedClient.files(
        "sandbox-1",
        { type: "read", path: "/workspace/large" },
        { maxReadBytes: 8, maxListEntries: 10, maxListBytes: 1_024 },
        900_000,
      ),
    ).rejects.toMatchObject({ code: "outputLimit" });
    expect(readCalls).toBe(0);

    let cancelled = false;
    const growing = makeSandbox({
      files: {
        getInfo: async () => ({ size: 1 }),
        read: async () =>
          chunkStream(100, 8, () => {
            cancelled = true;
          }),
      } as unknown as Sandbox["files"],
    });
    const growingClient = makeTestClient({
      apiKey: "test-api-key",
      trafficCredentials: failingBroker("unused"),
      sdk: makeSdk(growing),
    });
    await expect(
      growingClient.files(
        "sandbox-1",
        { type: "read", path: "/workspace/growing" },
        { maxReadBytes: 8, maxListEntries: 10, maxListBytes: 1_024 },
        900_000,
      ),
    ).rejects.toMatchObject({ code: "outputLimit" });
    expect(cancelled).toBe(true);
  });

  it("runs generic filesystem writes as the fixed non-root agent user", async () => {
    let writeUser: unknown;
    const sandbox = makeSandbox({
      files: {
        write: async (_path: string, _content: string, options?: { readonly user?: string }) => {
          writeUser = options?.user;
        },
      } as unknown as Sandbox["files"],
    });
    const client = makeTestClient({
      apiKey: "test-api-key",
      trafficCredentials: failingBroker("unused"),
      sdk: makeSdk(sandbox),
    });

    await client.files(
      "sandbox-1",
      { type: "write", path: "/workspace/file.txt", content: "safe", encoding: "utf8" },
      { maxReadBytes: 8, maxListEntries: 10, maxListBytes: 1_024 },
      900_000,
    );
    expect(writeUser).toBe("agentsin-agent");
  });

  it("passes explicit entry and byte ceilings to bounded directory listing", async () => {
    let listCommand = "";
    const sandbox = makeSandbox({
      commands: {
        run: async (command: string) => {
          listCommand = command;
          return { exitCode: 0, stdout: '{"overflow":true}\n', stderr: "" };
        },
      } as unknown as Sandbox["commands"],
    });
    const client = makeTestClient({
      apiKey: "test-api-key",
      trafficCredentials: failingBroker("unused"),
      sdk: makeSdk(sandbox),
    });

    await expect(
      client.files(
        "sandbox-1",
        { type: "list", path: "/workspace" },
        { maxReadBytes: 8, maxListEntries: 17, maxListBytes: 2_048 },
        900_000,
      ),
    ).rejects.toMatchObject({ code: "outputLimit" });
    expect(listCommand).toContain(" 17 2048");
  });

  it("uses the configured timeout and rechecks running state for every connected operation", async () => {
    const connectTimeouts: Array<number | undefined> = [];
    const inspectorUsers: Array<unknown> = [];
    const output = makeWriter("timeout-pty");
    const ptyInfrastructure = makePtyInfrastructure();
    ptyInfrastructure.registerWriter(output.writer);
    const handle = {
      pid: 51,
      kill: async () => true,
      disconnect: async () => undefined,
      wait: () => new Promise(() => undefined),
    } as unknown as CommandHandle;
    const sandbox = makeSandbox({
      commands: {
        run: async (command: string, options?: { readonly user?: string }) => {
          if (command === "ss -H -ltn") inspectorUsers.push(options?.user);
          return {
            exitCode: 0,
            stdout: command === "ss -H -ltn" ? "LISTEN 0 128 0.0.0.0:6080\n" : "",
            stderr: "",
          };
        },
      } as unknown as Sandbox["commands"],
      files: {
        getInfo: async () => ({ size: 0 }),
        read: async () => chunkStream(0, 0),
        remove: async () => undefined,
      } as unknown as Sandbox["files"],
      pty: {
        create: async () => handle,
        connect: async () => handle,
      } as unknown as Sandbox["pty"],
      createSnapshot: async () => ({ snapshotId: "snapshot-timeout", names: [] }),
      getHost: (port: number) => `${port}-sandbox-1.e2b.app`,
    });
    const client = makeTestClient({
      apiKey: "test-api-key",
      trafficCredentials: acceptingBroker,
      ptyInfrastructure,
      sdk: makeSdk(sandbox, {
        connect: async (_sandboxId, options) => {
          connectTimeouts.push(options?.timeoutMs);
          return sandbox;
        },
      }),
    });
    const stdout = makeWriter("timeout-stdout");
    const stderr = makeWriter("timeout-stderr");

    await client.execute(
      "sandbox-1",
      { command: "true", arguments: [] },
      { stdout: stdout.writer, stderr: stderr.writer },
      720_000,
    );
    await client.files(
      "sandbox-1",
      { type: "read", path: "/workspace/file" },
      { maxReadBytes: 8, maxListEntries: 8, maxListBytes: 1_024 },
      720_000,
    );
    const opened = await client.pty(
      "sandbox-1",
      { type: "open", columns: 80, rows: 24 },
      720_000,
      output.writer,
    );
    await client.pty("sandbox-1", { type: "close", ptyId: opened.ptyId }, 720_000);
    await client.snapshot("sandbox-1", undefined, 720_000);
    await client.desktop("sandbox-1", 720_000);
    await client.ports("sandbox-1", 720_000);

    expect(connectTimeouts).toEqual(Array.from({ length: 7 }, () => 720_000));
    expect(inspectorUsers).toEqual(["agentsin-inspector", "agentsin-inspector"]);

    let pausedConnectCalls = 0;
    const pausedClient = makeTestClient({
      apiKey: "test-api-key",
      trafficCredentials: acceptingBroker,
      sdk: makeSdk(sandbox, {
        getInfo: async () => ({ ...info, state: "paused" }),
        connect: async () => {
          pausedConnectCalls += 1;
          return sandbox;
        },
      }),
    });
    await expect(
      pausedClient.files(
        "sandbox-1",
        { type: "read", path: "/workspace/file" },
        { maxReadBytes: 8, maxListEntries: 8, maxListBytes: 1_024 },
        720_000,
      ),
    ).rejects.toMatchObject({ code: "invalidRequest" });
    expect(pausedConnectCalls).toBe(0);
  });

  it("retains the PTY handle and durably streams observable output until close", async () => {
    const output = makeWriter("pty");
    let onData: ((data: Uint8Array) => void | Promise<void>) | undefined;
    const stdin: Array<Uint8Array> = [];
    const inputPids: Array<number> = [];
    const resizes: Array<{ readonly cols: number; readonly rows: number }> = [];
    let killCalls = 0;
    let disconnectCalls = 0;
    const handle = {
      pid: 41,
      kill: async () => {
        killCalls += 1;
        return true;
      },
      disconnect: async () => {
        disconnectCalls += 1;
      },
      wait: () => new Promise(() => undefined),
    } as unknown as CommandHandle;
    const sandbox = makeSandbox({
      pty: {
        create: async (options: {
          readonly onData: (data: Uint8Array) => void | Promise<void>;
        }) => {
          onData = options.onData;
          return handle;
        },
        resize: async (_pid: number, size: { readonly cols: number; readonly rows: number }) => {
          resizes.push(size);
        },
        sendInput: async (pid: number, data: Uint8Array) => {
          inputPids.push(pid);
          stdin.push(data.slice());
        },
      } as unknown as Sandbox["pty"],
    });
    const ptyInfrastructure = makePtyInfrastructure();
    ptyInfrastructure.registerWriter(output.writer);
    const client = makeTestClient({
      apiKey: "test-api-key",
      trafficCredentials: acceptingBroker,
      sdk: makeSdk(sandbox),
      ptyInfrastructure,
    });

    const opened = await client.pty(
      "sandbox-1",
      { type: "open", columns: 120, rows: 40 },
      900_000,
      output.writer,
    );
    expect(opened).toEqual({ ptyId: "41", state: "open" });
    if (onData === undefined) throw new Error("Expected E2B PTY onData callback");
    const ptyBytes = new TextEncoder().encode("x".repeat(8_000));
    await onData(ptyBytes);
    await client.pty("sandbox-1", { type: "input", ptyId: opened.ptyId, data: "pwd\n" }, 900_000);
    await client.pty(
      "sandbox-1",
      {
        type: "resize",
        ptyId: opened.ptyId,
        columns: 160,
        rows: 60,
      },
      900_000,
    );
    const closed = await client.pty(
      "sandbox-1",
      {
        type: "close",
        ptyId: opened.ptyId,
      },
      900_000,
    );

    expect(new TextDecoder().decode(stdin[0])).toBe("pwd\n");
    expect(inputPids).toEqual([41]);
    expect(resizes).toEqual([{ cols: 160, rows: 60 }]);
    expect(killCalls).toBe(1);
    expect(disconnectCalls).toBe(1);
    expect(closed.outputSummary?.length).toBeLessThanOrEqual(4_096);
    expect(closed.outputArtifact?.sizeBytes).toBe(ptyBytes.byteLength);
    expect(output.totalBytes()).toBe(ptyBytes.byteLength);
    expect(output.aborted()).toBe(false);
    expect(ptyInfrastructure.records.get("sandbox-1:41")?.terminalReason).toBe("explicit-close");
    await expect(
      client.pty("sandbox-1", { type: "input", ptyId: opened.ptyId, data: "again" }, 900_000),
    ).rejects.toMatchObject({ code: "invalidRequest" });
  });

  it("hands a durable PTY session to a fresh client instance after worker restart", async () => {
    const output = makeWriter("pty-handoff");
    const ptyInfrastructure = makePtyInfrastructure();
    ptyInfrastructure.registerWriter(output.writer);
    const input: Array<string> = [];
    const inputPids: Array<number> = [];
    let firstDisconnects = 0;
    let reconnects = 0;
    const firstHandle = {
      pid: 61,
      kill: async () => true,
      disconnect: async () => {
        firstDisconnects += 1;
      },
      wait: () => new Promise(() => undefined),
    } as unknown as CommandHandle;
    const secondHandle = {
      pid: 61,
      kill: async () => true,
      disconnect: async () => undefined,
      wait: () => new Promise(() => undefined),
    } as unknown as CommandHandle;
    const sandbox = makeSandbox({
      pty: {
        create: async () => firstHandle,
        connect: async () => {
          reconnects += 1;
          return secondHandle;
        },
        sendInput: async (pid: number, data: Uint8Array) => {
          inputPids.push(pid);
          input.push(new TextDecoder().decode(data));
        },
      } as unknown as Sandbox["pty"],
    });
    const sdk = makeSdk(sandbox);
    const first = makeTestClient({
      apiKey: "test-api-key",
      trafficCredentials: acceptingBroker,
      sdk,
      ptyInfrastructure,
      ptyOwnerId: "worker-before-restart",
    });
    const opened = await first.pty(
      "sandbox-1",
      { type: "open", columns: 80, rows: 24 },
      900_000,
      output.writer,
    );
    expect((await ptyInfrastructure.ptySessions.get("sandbox-1", opened.ptyId))?.ownerId).toBe(
      "worker-before-restart",
    );
    await first.shutdownPtys("handoff", 900_000);
    expect(
      (await ptyInfrastructure.ptySessions.get("sandbox-1", opened.ptyId))?.ownerId,
    ).toBeUndefined();

    const second = makeTestClient({
      apiKey: "test-api-key",
      trafficCredentials: acceptingBroker,
      sdk,
      ptyInfrastructure,
      ptyOwnerId: "worker-after-restart",
    });
    await second.pty(
      "sandbox-1",
      { type: "input", ptyId: opened.ptyId, data: "echo resumed\n" },
      900_000,
    );
    expect((await ptyInfrastructure.ptySessions.get("sandbox-1", opened.ptyId))?.ownerId).toBe(
      "worker-after-restart",
    );
    await second.pty("sandbox-1", { type: "close", ptyId: opened.ptyId }, 900_000);

    expect(firstDisconnects).toBe(1);
    expect(reconnects).toBe(1);
    expect(input).toEqual(["echo resumed\n"]);
    expect(inputPids).toEqual([61]);
    expect(ptyInfrastructure.records.get("sandbox-1:61")?.state).toBe("closed");
  });

  it("finalizes PTYs before pause, snapshot, and destroy transitions", async () => {
    for (const reason of ["pause", "snapshot", "destroy"] as const) {
      const output = makeWriter(`pty-${reason}`);
      const ptyInfrastructure = makePtyInfrastructure();
      ptyInfrastructure.registerWriter(output.writer);
      const handle = {
        pid: 70,
        kill: async () => true,
        disconnect: async () => undefined,
        wait: () => new Promise(() => undefined),
      } as unknown as CommandHandle;
      const sandbox = makeSandbox({
        pty: {
          create: async () => handle,
          connect: async () => handle,
        } as unknown as Sandbox["pty"],
      });
      const client = makeTestClient({
        apiKey: "test-api-key",
        trafficCredentials: acceptingBroker,
        sdk: makeSdk(sandbox),
        ptyInfrastructure,
      });
      const opened = await client.pty(
        "sandbox-1",
        { type: "open", columns: 80, rows: 24 },
        900_000,
        output.writer,
      );

      await client.reconcilePtys("sandbox-1", reason, 900_000);

      expect(ptyInfrastructure.records.get(`sandbox-1:${opened.ptyId}`)).toMatchObject({
        state: "closed",
        terminalReason: reason,
      });
    }
  });

  it("finalizes durable output when a PTY exits naturally", async () => {
    const output = makeWriter("pty-natural");
    const ptyInfrastructure = makePtyInfrastructure();
    ptyInfrastructure.registerWriter(output.writer);
    let finish: () => void = () => undefined;
    const finished = new Promise<never>((resolve) => {
      finish = () => resolve(undefined as never);
    });
    const handle = {
      pid: 71,
      kill: async () => true,
      disconnect: async () => undefined,
      wait: () => finished,
    } as unknown as CommandHandle;
    const sandbox = makeSandbox({
      pty: { create: async () => handle } as unknown as Sandbox["pty"],
    });
    const client = makeTestClient({
      apiKey: "test-api-key",
      trafficCredentials: acceptingBroker,
      sdk: makeSdk(sandbox),
      ptyInfrastructure,
    });
    await client.pty("sandbox-1", { type: "open", columns: 80, rows: 24 }, 900_000, output.writer);

    finish();
    const terminal = await ptyInfrastructure.nextTerminal();

    expect(terminal).toMatchObject({ state: "closed", terminalReason: "natural-exit" });
  });

  it("marks cleanup required and aborts durable output when PTY streaming fails", async () => {
    let onData: ((data: Uint8Array) => void | Promise<void>) | undefined;
    let ptyUser: unknown;
    let aborted = false;
    const writer: StreamingArtifactWriter = {
      writerId: "writer-pty-failure",
      write: async () => {
        throw new Error("R2 write failed");
      },
      complete: async () => artifactReference("pty-failure", 0),
      abort: async () => {
        aborted = true;
      },
    };
    const ptyInfrastructure = makePtyInfrastructure();
    ptyInfrastructure.registerWriter(writer);
    let remoteReclaims = 0;
    const handle = {
      pid: 72,
      kill: async () => true,
      disconnect: async () => undefined,
      wait: () => new Promise(() => undefined),
    } as unknown as CommandHandle;
    const sandbox = makeSandbox({
      pty: {
        create: async (options: { readonly onData: typeof onData; readonly user?: string }) => {
          onData = options.onData;
          ptyUser = options.user;
          return handle;
        },
        kill: async () => {
          remoteReclaims += 1;
          return true;
        },
      } as unknown as Sandbox["pty"],
    });
    const client = makeTestClient({
      apiKey: "test-api-key",
      trafficCredentials: acceptingBroker,
      sdk: makeSdk(sandbox),
      ptyInfrastructure,
    });
    await client.pty("sandbox-1", { type: "open", columns: 80, rows: 24 }, 900_000, writer);
    expect(ptyUser).toBe("agentsin-agent");
    if (onData === undefined) throw new Error("Expected PTY output callback");

    await expect(onData(new TextEncoder().encode("broken"))).rejects.toThrow("R2 write failed");
    const terminal = await ptyInfrastructure.nextTerminal();

    expect(aborted).toBe(true);
    expect(terminal).toMatchObject({
      state: "cleanup-required",
      terminalReason: "writer-failure",
    });
    await client.reconcilePtys("sandbox-1", "pause", 900_000);
    expect(remoteReclaims).toBe(1);
    expect(ptyInfrastructure.records.get("sandbox-1:72")?.state).toBe("closed");
  });

  it("finalizes the PTY after input failure and during process shutdown", async () => {
    for (const path of ["input-failure", "shutdown"] as const) {
      const output = makeWriter(`pty-${path}`);
      const ptyInfrastructure = makePtyInfrastructure();
      ptyInfrastructure.registerWriter(output.writer);
      const handle = {
        pid: path === "input-failure" ? 73 : 74,
        kill: async () => true,
        disconnect: async () => undefined,
        wait: () => new Promise(() => undefined),
      } as unknown as CommandHandle;
      const sandbox = makeSandbox({
        pty: {
          create: async () => handle,
          connect: async () => handle,
          sendInput: async () => {
            if (path === "input-failure") throw new Error("stdin failed");
          },
        } as unknown as Sandbox["pty"],
      });
      const client = makeTestClient({
        apiKey: "test-api-key",
        trafficCredentials: acceptingBroker,
        sdk: makeSdk(sandbox),
        ptyInfrastructure,
      });
      const opened = await client.pty(
        "sandbox-1",
        { type: "open", columns: 80, rows: 24 },
        900_000,
        output.writer,
      );

      if (path === "input-failure") {
        await expect(
          client.pty("sandbox-1", { type: "input", ptyId: opened.ptyId, data: "fail" }, 900_000),
        ).rejects.toMatchObject({ code: "unavailable" });
      } else {
        await client.shutdownPtys("terminate", 900_000);
      }

      expect(ptyInfrastructure.records.get(`sandbox-1:${opened.ptyId}`)).toMatchObject({
        state: "closed",
        terminalReason: path,
      });
    }
  });

  it("aborts a detached writer and leaves a cleanup receipt for a paused sandbox", async () => {
    const output = makeWriter("pty-detached");
    const ptyInfrastructure = makePtyInfrastructure();
    ptyInfrastructure.registerWriter(output.writer);
    await ptyInfrastructure.ptySessions.create({
      sandboxId: "sandbox-1",
      ptyId: SandboxPtyId.make("75"),
      writerId: output.writer.writerId,
      state: "open",
      outputSummary: "before pause",
    });
    const sandbox = makeSandbox();
    const client = makeTestClient({
      apiKey: "test-api-key",
      trafficCredentials: acceptingBroker,
      ptyInfrastructure,
      sdk: makeSdk(sandbox, { getInfo: async () => ({ ...info, state: "paused" }) }),
    });

    await client.reconcilePtys("sandbox-1", "destroy", 900_000);

    expect(output.aborted()).toBe(true);
    expect(ptyInfrastructure.records.get("sandbox-1:75")).toMatchObject({
      state: "cleanup-required",
      terminalReason: "destroy",
    });
    await client.destroy("sandbox-1");
    expect(ptyInfrastructure.records.get("sandbox-1:75")?.state).toBe("closed");
  });
});
