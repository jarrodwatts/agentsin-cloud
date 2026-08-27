import * as NodeCrypto from "node:crypto";

import type { Sandbox, SandboxInfo } from "e2b";
import { CommandId } from "@t3tools/contracts";
import {
  SandboxProviderConnectRequest,
  SandboxProviderCreateRequest,
  SandboxProviderDesktopRequest,
  SandboxProviderDestroyRequest,
  SandboxProviderExecuteRequest,
  SandboxProviderFilesRequest,
  SandboxProviderPauseRequest,
  SandboxProviderPortsRequest,
  SandboxProviderPtyRequest,
  SandboxProviderResumeRequest,
  SandboxProviderSnapshotRequest,
  SandboxProviderUsageRequest,
  SandboxPtyId,
  WorkspaceId,
} from "@t3tools/contracts/cloud";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";

import { makeE2bSandboxProvider } from "./E2bSandboxProvider.ts";
import { type E2bSdkRuntime, makeE2bSdkClient } from "./E2bSdkClient.ts";
import { assignImmutableE2bBuildTag } from "./template.ts";
import {
  E2bClientFailure,
  type E2bClient,
  type E2bSandboxDescription,
  type E2bPtySessionRegistry,
  type SandboxCleanupOrphanRecord,
  type SandboxIdentityRecord,
  type SandboxIdentityReservation,
} from "./types.ts";

const NOW = "2026-08-27T12:00:00.000Z";
const BUILD_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const date = (value = NOW) => DateTime.toDate(DateTime.makeUnsafe(value));

const unusedPtySessions: E2bPtySessionRegistry = {
  create: async () => undefined,
  get: async () => undefined,
  claim: async () => undefined,
  checkpoint: async () => undefined,
  close: async () => undefined,
  markCleanupRequired: async () => undefined,
  markReclaimed: async () => undefined,
  release: async () => undefined,
  listReclaimable: async () => [],
};

const createRequest = Schema.decodeUnknownSync(SandboxProviderCreateRequest)({
  type: "create",
  requestId: "command-create",
  workspaceId: "workspace-1",
  environmentId: "environment-1",
  requestedAt: NOW,
  workspace: {
    workspaceId: "workspace-1",
    projectId: "project-1",
    threadId: "thread-1",
    repositoryIdentity: {
      canonicalKey: "github.com/jarrodwatts/agentsin-cloud",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/jarrodwatts/agentsin-cloud",
      },
    },
    workspaceDirectory: "/workspace",
  },
  revision: {
    revisionId: "revision-1",
    blueprintId: "blueprint-1",
    workspaceId: "workspace-1",
    revision: 1,
    contentHash: "sha256:revision-1",
    blueprint: {
      schemaVersion: 1,
      blueprintId: "blueprint-1",
      workspaceId: "workspace-1",
      name: "Cloud environment",
      repositoryIdentity: {
        canonicalKey: "github.com/jarrodwatts/agentsin-cloud",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://github.com/jarrodwatts/agentsin-cloud",
        },
      },
      checkoutRef: "main",
      image: `e2b://template/agentsin-cloud-base:build-${BUILD_ID}`,
      workspaceDirectory: "/workspace",
      resources: { cpuCores: 4, memoryMiB: 8_192, storageMiB: 32_768 },
      setupCommands: [],
      runtimes: [],
      packages: [],
      pluginRefs: [],
      secretRefs: [],
      verificationCommands: [
        {
          command: "test",
          arguments: ["-d", "/workspace"],
          executableHash: "sha256:test",
        },
      ],
      providerInstances: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
    buildStatus: "ready",
    buildSummary: {
      message: "Verified",
      warningCount: 0,
      errorCount: 0,
      recentLines: ["Verified"],
    },
    buildLogArtifact: {
      storage: "r2",
      bucket: "build-logs",
      objectKey: "revision-1.log",
      contentHash: "sha256:log",
      sizeBytes: 8,
    },
    createdAt: NOW,
  },
});

const makeHarness = (options?: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly desktop?: boolean;
  readonly executeFailure?: E2bClientFailure;
  readonly identityReservationFailure?: boolean;
  readonly identityActivationFailure?: boolean;
  readonly reservationFailureUpdateFailure?: boolean;
  readonly cleanupOrphanRecordFailure?: boolean;
  readonly createFailure?: boolean;
  readonly clientOverride?: E2bClient;
  readonly destroyFailure?: boolean;
  readonly ptyOutput?: string;
  readonly activeTimeoutMs?: number;
}) => {
  const records = new Map<string, SandboxIdentityRecord>();
  const reservations = new Map<
    string,
    SandboxIdentityReservation & {
      readonly state: "pending" | "active" | "failed" | "cleanup-required";
      readonly providerHandle?: string;
      readonly reclaimMetadata?: Readonly<Record<string, string>>;
    }
  >();
  const cleanupOrphans = new Map<
    string,
    SandboxCleanupOrphanRecord & {
      readonly cleanupFailedAt?: string;
      readonly reclaimedAt?: string;
    }
  >();
  const uploads: Array<{ readonly kind: string; readonly bytes: Uint8Array }> = [];
  const lockTails = new Map<string, Promise<void>>();
  let destroyed = false;
  let destroyCalls = 0;
  let connectCalls = 0;
  const connectTimeouts: Array<number> = [];
  let executeCalls = 0;
  let createCalls = 0;
  let ptyOutputWriter: Parameters<E2bClient["pty"]>[3];
  const ptyInputs: Array<string> = [];
  let pauseHold: { readonly wait: Promise<void>; readonly signal: () => void } | undefined;
  let destroyHold: { readonly wait: Promise<void>; readonly signal: () => void } | undefined;
  let contentionSignal: (() => void) | undefined;
  let createInput: Parameters<E2bClient["create"]>[0] | undefined;
  let description: E2bSandboxDescription = {
    sandboxId: "sandbox-1",
    templateId: "template-1",
    state: "running" as const,
    metadata: {} as Readonly<Record<string, string>>,
    startedAt: date(),
    endAt: date("2026-08-27T12:15:00.000Z"),
    sandboxDomain: "sandbox-1.e2b.app",
    trafficCredentialRef: "secret-broker/e2b/sandbox-1",
  };

  const defaultClient: E2bClient = {
    create: async (input) => {
      createCalls += 1;
      if (options?.createFailure === true) {
        throw new E2bClientFailure({
          code: "unavailable",
          message: "E2B create failed",
          retryable: true,
          createDisposition: { status: "no-compute-confirmed" },
        });
      }
      createInput = input;
      description = { ...description, metadata: input.metadata };
      return description;
    },
    inspect: async () => (destroyed ? undefined : description),
    connect: async (_sandboxId, timeoutMs) => {
      connectCalls += 1;
      connectTimeouts.push(timeoutMs);
      description = { ...description, state: "running" };
      return description;
    },
    execute: async (_sandboxId, _input, output) => {
      executeCalls += 1;
      if (options?.executeFailure !== undefined) throw options.executeFailure;
      const stdout = new TextEncoder().encode(options?.stdout ?? "ok");
      const stderr = new TextEncoder().encode(options?.stderr ?? "");
      await output.stdout.write(stdout);
      await output.stderr.write(stderr);
      return {
        exitCode: 0,
        stdoutSummary: new TextDecoder().decode(stdout).slice(0, 4_096),
        stderrSummary: new TextDecoder().decode(stderr).slice(0, 4_096),
        stdoutArtifact: await output.stdout.complete(),
        stderrArtifact: await output.stderr.complete(),
      };
    },
    files: async (_sandboxId, operation, _limits) => {
      if (operation.type === "read") {
        return {
          type: "read",
          path: operation.path,
          bytes: new TextEncoder().encode("contents"),
        };
      }
      if (operation.type === "list") {
        return {
          type: "list",
          path: operation.path,
          entries: [{ path: `${operation.path}/file`, type: "file", sizeBytes: 8 }],
        };
      }
      return { type: operation.type, path: operation.path };
    },
    pty: async (_sandboxId, operation, _activeTimeoutMs, output) => {
      if (operation.type === "open") {
        if (output === undefined) throw new Error("PTY output writer is required");
        ptyOutputWriter = output;
        await output.write(new TextEncoder().encode(options?.ptyOutput ?? "cloud prompt"));
        return { ptyId: SandboxPtyId.make("41"), state: "open" };
      }
      if (operation.type === "input") ptyInputs.push(operation.data);
      if (operation.type === "close") {
        if (ptyOutputWriter === undefined) throw new Error("PTY output writer was lost");
        const content = options?.ptyOutput ?? "cloud prompt";
        return {
          ptyId: operation.ptyId,
          state: "closed",
          outputSummary: content.slice(0, 4_096),
          outputArtifact: await ptyOutputWriter.complete(),
        };
      }
      return { ptyId: operation.ptyId, state: "open" };
    },
    pause: async () => {
      pauseHold?.signal();
      if (pauseHold !== undefined) await pauseHold.wait;
      description = { ...description, state: "paused" };
    },
    snapshot: async () => {
      description = { ...description, state: "paused" };
      return { snapshotId: "snapshot-1", state: "paused" };
    },
    desktop: async () =>
      options?.desktop === false
        ? undefined
        : {
            endpoint: "https://6080-sandbox-1.e2b.app",
            credentialRef: "e2b-traffic/sandbox-1",
          },
    ports: async () => [{ internalPort: 3_000, endpoint: "https://3000-sandbox-1.e2b.app" }],
    usage: async () => [
      {
        timestamp: date("2026-08-27T12:01:00.000Z"),
        cpuUsedPct: 25,
        memoryUsedBytes: 100,
        memoryTotalBytes: 200,
        diskUsedBytes: 300,
        diskTotalBytes: 400,
      },
    ],
    reconcilePtys: async () => undefined,
    shutdownPtys: async () => undefined,
    destroy: async () => {
      destroyCalls += 1;
      destroyHold?.signal();
      if (destroyHold !== undefined) await destroyHold.wait;
      if (options?.destroyFailure === true) {
        throw new E2bClientFailure({
          code: "unavailable",
          message: "E2B destroy failed",
          retryable: true,
        });
      }
      destroyed = true;
      return true;
    },
  };
  const client = options?.clientOverride ?? defaultClient;

  const provider = makeE2bSandboxProvider({
    client,
    identities: {
      reserve: async (record) => {
        if (options?.identityReservationFailure === true) {
          throw new Error("identity reservation failed");
        }
        if (
          [...reservations.values()].some(
            (existing) =>
              existing.workspaceId === record.workspaceId &&
              existing.threadId === record.threadId &&
              existing.state !== "failed",
          )
        ) {
          throw new Error("thread already has a sandbox fence");
        }
        reservations.set(record.reservationId, { ...record, state: "pending" });
      },
      activateReservation: async (reservationId, record) => {
        if (options?.identityActivationFailure === true) {
          throw new Error("identity activation failed");
        }
        const reservation = reservations.get(reservationId);
        if (reservation === undefined || reservation.state !== "pending") {
          throw new Error("pending reservation not found");
        }
        records.set(record.sandboxId, record);
        reservations.set(reservationId, {
          ...reservation,
          state: "active",
          providerHandle: record.providerHandle,
        });
      },
      markReservationFailed: async (reservationId, _failedAt, _reason) => {
        if (options?.reservationFailureUpdateFailure === true) {
          throw new Error("reservation failure update failed");
        }
        const reservation = reservations.get(reservationId);
        if (reservation !== undefined) {
          reservations.set(reservationId, { ...reservation, state: "failed" });
        }
      },
      markReservationCleanupRequired: async (reconciliation) => {
        const reservation = reservations.get(reconciliation.reservationId);
        if (reservation === undefined) throw new Error("reservation not found");
        reservations.set(reconciliation.reservationId, {
          ...reservation,
          state: "cleanup-required",
          ...(reconciliation.providerHandle === undefined
            ? {}
            : { providerHandle: reconciliation.providerHandle }),
          reclaimMetadata: reconciliation.reclaimMetadata,
        });
      },
      get: async (sandboxId) => records.get(sandboxId),
      markDestroyed: async (sandboxId, destroyedAt) => {
        const record = records.get(sandboxId);
        if (record !== undefined) records.set(sandboxId, { ...record, destroyedAt });
      },
      recordCleanupOrphan: async (record) => {
        if (options?.cleanupOrphanRecordFailure === true) {
          throw new Error("cleanup orphan record failed");
        }
        cleanupOrphans.set(record.orphanId, record);
      },
      recordCleanupFailure: async (orphanId, attemptedAt) => {
        const record = cleanupOrphans.get(orphanId);
        if (record !== undefined) {
          cleanupOrphans.set(orphanId, { ...record, cleanupFailedAt: attemptedAt });
        }
      },
      markCleanupOrphanReclaimed: async (orphanId, reclaimedAt) => {
        const record = cleanupOrphans.get(orphanId);
        if (record !== undefined) {
          cleanupOrphans.set(orphanId, { ...record, reclaimedAt });
        }
      },
    },
    artifacts: {
      open: async (input) => {
        const chunks: Array<Uint8Array> = [];
        let aborted = false;
        return {
          writerId: `${input.sandboxId}/${input.requestId}/${input.kind}`,
          write: async (chunk: Uint8Array) => {
            if (aborted) throw new Error("writer aborted");
            chunks.push(chunk.slice());
          },
          complete: async () => {
            const sizeBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
            const bytes = new Uint8Array(sizeBytes);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.byteLength;
            }
            uploads.push({ kind: input.kind, bytes });
            return {
              storage: "r2" as const,
              bucket: "sandbox-artifacts",
              objectKey: `${input.sandboxId}/${input.requestId}/${input.kind}`,
              contentHash: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
              sizeBytes,
            };
          },
          abort: async () => {
            aborted = true;
            chunks.length = 0;
          },
        };
      },
      resume: async () => {
        throw new Error("provider harness does not resume writers directly");
      },
    },
    lifecycleLocks: {
      withLock: async (sandboxId, operation) => {
        const key = String(sandboxId);
        const previous = lockTails.get(key) ?? Promise.resolve();
        if (lockTails.has(key)) contentionSignal?.();
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const tail = previous.then(() => gate);
        lockTails.set(key, tail);
        await previous;
        try {
          return await operation();
        } finally {
          release();
          if (lockTails.get(key) === tail) lockTails.delete(key);
        }
      },
    },
    clock: { now: () => date() },
    ...(options?.activeTimeoutMs === undefined ? {} : { activeTimeoutMs: options.activeTimeoutMs }),
  });

  const request = <S extends Schema.Top>(
    schema: S,
    type: string,
    fields: Record<string, unknown>,
  ): S["Type"] =>
    Schema.decodeUnknownSync(schema as never)({
      type,
      requestId: `command-${type}`,
      workspaceId: createRequest.workspaceId,
      environmentId: createRequest.environmentId,
      requestedAt: NOW,
      ...fields,
    }) as S["Type"];

  return {
    provider,
    records,
    reservations,
    cleanupOrphans,
    uploads,
    createInput: () => createInput,
    createCalls: () => createCalls,
    destroyCalls: () => destroyCalls,
    connectCalls: () => connectCalls,
    connectTimeouts,
    executeCalls: () => executeCalls,
    ptyInputs,
    holdPause: () => {
      let signalEntered: () => void = () => undefined;
      let releasePause: () => void = () => undefined;
      const entered = new Promise<void>((resolve) => {
        signalEntered = resolve;
      });
      const released = new Promise<void>((resolve) => {
        releasePause = resolve;
      });
      pauseHold = { wait: released, signal: signalEntered };
      return { entered, release: releasePause };
    },
    holdDestroy: () => {
      let signalEntered: () => void = () => undefined;
      let releaseDestroy: () => void = () => undefined;
      const entered = new Promise<void>((resolve) => {
        signalEntered = resolve;
      });
      const released = new Promise<void>((resolve) => {
        releaseDestroy = resolve;
      });
      destroyHold = { wait: released, signal: signalEntered };
      return { entered, release: releaseDestroy };
    },
    nextContention: () =>
      new Promise<void>((resolve) => {
        contentionSignal = resolve;
      }),
    setMetadata: (metadata: Readonly<Record<string, string>>) => {
      description = { ...description, metadata };
    },
    request,
  };
};

describe("E2B SandboxProvider", () => {
  it.effect("creates only from an immutable E2B build and records provider identity", () =>
    Effect.gen(function* () {
      const assignments: Array<{ readonly target: string; readonly tag: string }> = [];
      const reference = yield* Effect.promise(() =>
        assignImmutableE2bBuildTag({
          templateName: "agentsin-cloud-base",
          stagingTag: "staging-request-1",
          buildId: BUILD_ID,
          assignTags: async (target, tag) => {
            assignments.push({ target, tag });
            return { buildId: BUILD_ID, tags: [tag] };
          },
        }),
      );
      const harness = makeHarness();
      const result = yield* harness.provider.create({
        ...createRequest,
        revision: {
          ...createRequest.revision,
          blueprint: { ...createRequest.revision.blueprint, image: reference },
        },
      });

      expect(assignments).toEqual([
        {
          target: "agentsin-cloud-base:staging-request-1",
          tag: `build-${BUILD_ID}`,
        },
      ]);
      expect(reference).toBe(`e2b://template/agentsin-cloud-base:build-${BUILD_ID}`);
      expect(harness.createInput()?.templateId).toBe(`agentsin-cloud-base:build-${BUILD_ID}`);
      expect(harness.createInput()?.timeoutMs).toBe(900_000);
      expect(harness.createInput()?.metadata.agentsin_cloud_thread_id).toBe("thread-1");
      expect(result.sandbox.infrastructureProvider).toBe("e2b");
      expect(result.sandbox.providerHandle).toBe("sandbox-1");
      expect(harness.records.get("sandbox-1")?.revisionId).toBe("revision-1");

      yield* Effect.promise(() =>
        expect(
          assignImmutableE2bBuildTag({
            templateName: "agentsin-cloud-base",
            stagingTag: "staging-request-2",
            buildId: BUILD_ID,
            assignTags: async (_target, tag) => ({ buildId: "different-build", tags: [tag] }),
          }),
        ).rejects.toThrow("did not assign the immutable tag to the requested build"),
      );
    }),
  );

  it.effect("stores full command output in R2 and keeps summaries bounded", () =>
    Effect.gen(function* () {
      const stdout = "a".repeat(8_000);
      const harness = makeHarness({ stdout, stderr: "warning" });
      const created = yield* harness.provider.create(createRequest);
      const result = yield* harness.provider.execute(
        harness.request(SandboxProviderExecuteRequest, "execute", {
          sandboxId: created.sandbox.sandboxId,
          command: "printf",
          arguments: ["ok"],
        }),
      );

      expect(result.stdoutSummary.length).toBeLessThanOrEqual(4_096);
      expect(new TextDecoder().decode(harness.uploads[0]?.bytes)).toBe(stdout);
      expect(new TextDecoder().decode(harness.uploads[1]?.bytes)).toBe("warning");
      expect(result.stdoutArtifact.storage).toBe("r2");
    }),
  );

  it.effect("creates no remote compute when the durable thread reservation fails", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ identityReservationFailure: true });
      const failure = yield* Effect.flip(harness.provider.create(createRequest));

      expect(failure.code).toBe("E2B_INTERNAL_ERROR");
      expect(harness.createCalls()).toBe(0);
      expect(harness.reservations.size).toBe(0);
    }),
  );

  it.effect("marks failed creates and preserves the fence if that update fails", () =>
    Effect.gen(function* () {
      const reconciled = makeHarness({ createFailure: true });
      const createFailure = yield* Effect.flip(reconciled.provider.create(createRequest));
      expect(createFailure.code).toBe("E2B_UNAVAILABLE");
      expect(reconciled.reservations.get(createRequest.requestId)?.state).toBe("failed");

      const pending = makeHarness({
        createFailure: true,
        reservationFailureUpdateFailure: true,
      });
      const reconciliationFailure = yield* Effect.flip(pending.provider.create(createRequest));
      expect(reconciliationFailure).toMatchObject({
        code: "E2B_RESERVATION_RECONCILIATION_REQUIRED",
        details: { reservationId: createRequest.requestId },
      });
      expect(pending.reservations.get(createRequest.requestId)?.state).toBe("pending");
    }),
  );

  it.effect("preserves a reclaimable fence when create cleanup is uncertain", () =>
    Effect.gen(function* () {
      let sdkCreateCalls = 0;
      let createdMetadata: Readonly<Record<string, string>> = {};
      const sandboxInfo: SandboxInfo = {
        sandboxId: "sandbox-uncertain",
        templateId: "template-1",
        metadata: createdMetadata,
        startedAt: date(),
        endAt: date("2026-08-27T12:15:00.000Z"),
        state: "running",
        cpuCount: 4,
        memoryMB: 8_192,
        envdVersion: "0.6.4",
        sandboxDomain: "sandbox-uncertain.e2b.app",
      };
      const sandbox = {
        sandboxId: "sandbox-uncertain",
        sandboxDomain: "sandbox-uncertain.e2b.app",
        trafficAccessToken: "opaque-test-traffic-token",
        getInfo: async () => ({ ...sandboxInfo, metadata: createdMetadata }),
      } as Sandbox;
      const sdk: E2bSdkRuntime = {
        create: async (_template, options) => {
          sdkCreateCalls += 1;
          createdMetadata = options?.metadata ?? {};
          return sandbox;
        },
        connect: async () => sandbox,
        getInfo: async () => ({ ...sandboxInfo, metadata: createdMetadata }),
        pause: async () => true,
        kill: async () => {
          throw new Error("simulated cleanup failure");
        },
        getMetrics: async () => [],
      };
      const client = makeE2bSdkClient({
        apiKey: "test-api-key",
        sdk,
        trafficCredentials: {
          seal: async () => {
            throw new Error("simulated credential sealing failure");
          },
          revoke: async () => undefined,
        },
        ptySessions: unusedPtySessions,
        artifacts: {
          resume: async () => {
            throw new Error("PTY artifacts are unused by this test");
          },
        },
        ptyOwnerId: "worker-test",
      });
      const harness = makeHarness({ clientOverride: client });
      const failure = yield* Effect.flip(harness.provider.create(createRequest));

      expect(failure).toMatchObject({
        code: "E2B_ORPHAN_CLEANUP_REQUIRED",
        details: {
          reservationId: createRequest.requestId,
          providerHandle: "sandbox-uncertain",
          durableFenceRecorded: true,
          durableReclaimRecorded: true,
        },
      });
      expect(harness.reservations.get(createRequest.requestId)).toMatchObject({
        state: "cleanup-required",
        providerHandle: "sandbox-uncertain",
        reclaimMetadata: {
          agentsin_cloud_reservation_id: createRequest.requestId,
        },
      });

      const secondFailure = yield* Effect.flip(harness.provider.create(createRequest));
      expect(secondFailure.code).toBe("E2B_INTERNAL_ERROR");
      expect(sdkCreateCalls).toBe(1);
    }),
  );

  it.effect("keeps the durable fence when activation, orphan update, and cleanup all fail", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        identityActivationFailure: true,
        cleanupOrphanRecordFailure: true,
        destroyFailure: true,
      });
      const failure = yield* Effect.flip(harness.provider.create(createRequest));

      expect(failure).toMatchObject({
        code: "E2B_ORPHAN_CLEANUP_REQUIRED",
        retryable: true,
        details: {
          providerHandle: "sandbox-1",
          durableOrphanRecorded: false,
          durableFenceRecorded: true,
        },
      });
      expect(harness.destroyCalls()).toBe(1);
      expect(harness.cleanupOrphans.size).toBe(0);
      expect(harness.reservations.get(createRequest.requestId)?.state).toBe("pending");
      expect(harness.records.size).toBe(0);
    }),
  );

  it.effect("uses the configured active timeout for create, connect, and resume", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ activeTimeoutMs: 720_000 });
      const created = yield* harness.provider.create(createRequest);
      const sandboxId = created.sandbox.sandboxId;
      expect(harness.createInput()?.timeoutMs).toBe(720_000);

      yield* harness.provider.connect(
        harness.request(SandboxProviderConnectRequest, "connect", { sandboxId }),
      );
      yield* harness.provider.pause(
        harness.request(SandboxProviderPauseRequest, "pause", { sandboxId }),
      );
      yield* harness.provider.resume(
        harness.request(SandboxProviderResumeRequest, "resume", { sandboxId }),
      );

      expect(harness.connectTimeouts).toEqual([720_000, 720_000]);
    }),
  );

  it.effect("maps pause, resume, snapshot, files, PTY, ports, usage, and desktop", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const created = yield* harness.provider.create(createRequest);
      const sandboxId = created.sandbox.sandboxId;

      const paused = yield* harness.provider.pause(
        harness.request(SandboxProviderPauseRequest, "pause", { sandboxId }),
      );
      expect(paused.sandbox.state).toBe("suspended");
      const resumed = yield* harness.provider.resume(
        harness.request(SandboxProviderResumeRequest, "resume", { sandboxId }),
      );
      expect(resumed.sandbox.state).toBe("ready");
      expect(harness.connectTimeouts).toEqual([900_000]);
      const files = yield* harness.provider.files(
        harness.request(SandboxProviderFilesRequest, "files", {
          sandboxId,
          operation: { type: "read", path: "/workspace/a" },
        }),
      );
      expect(files.result.type).toBe("read");
      const pty = yield* harness.provider.pty(
        harness.request(SandboxProviderPtyRequest, "pty", {
          sandboxId,
          operation: { type: "open", columns: 120, rows: 40 },
        }),
      );
      expect(pty.ptyId).toBe("41");
      yield* harness.provider.pty(
        harness.request(SandboxProviderPtyRequest, "pty", {
          sandboxId,
          operation: { type: "input", ptyId: pty.ptyId, data: "pwd\n" },
        }),
      );
      const closedPty = yield* harness.provider.pty(
        harness.request(SandboxProviderPtyRequest, "pty", {
          sandboxId,
          operation: { type: "close", ptyId: pty.ptyId },
        }),
      );
      expect(harness.ptyInputs).toEqual(["pwd\n"]);
      expect(closedPty.outputSummary).toBe("cloud prompt");
      expect(closedPty.outputArtifact?.sizeBytes).toBe(12);
      expect(new TextDecoder().decode(harness.uploads.at(-1)?.bytes)).toBe("cloud prompt");
      const ports = yield* harness.provider.ports(
        harness.request(SandboxProviderPortsRequest, "ports", { sandboxId }),
      );
      expect(ports.ports).toEqual([
        {
          internalPort: 3_000,
          protocol: "https",
          visibility: "authenticated",
          endpoint: "https://3000-sandbox-1.e2b.app",
        },
      ]);
      const desktop = yield* harness.provider.desktop(
        harness.request(SandboxProviderDesktopRequest, "desktop", { sandboxId }),
      );
      expect(desktop.endpoint).toContain("6080");
      const usage = yield* harness.provider.usage(
        harness.request(SandboxProviderUsageRequest, "usage", {
          sandboxId,
          since: NOW,
          until: "2026-08-27T12:02:00.000Z",
        }),
      );
      expect(usage.measurements).toHaveLength(5);
      const snapshot = yield* harness.provider.snapshot(
        harness.request(SandboxProviderSnapshotRequest, "snapshot", {
          sandboxId,
          label: "Checkpoint",
        }),
      );
      expect(snapshot.snapshot.snapshotId).toBe("snapshot-1");
      expect(snapshot.snapshot.contentHash).toHaveLength(64);
      expect(snapshot.sandbox.state).toBe("suspended");
    }),
  );

  it.effect("does not implicitly resume a paused sandbox for running-only operations", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const created = yield* harness.provider.create(createRequest);
      const sandboxId = created.sandbox.sandboxId;

      yield* harness.provider.pause(
        harness.request(SandboxProviderPauseRequest, "pause", { sandboxId }),
      );
      const failure = yield* Effect.flip(
        harness.provider.execute(
          harness.request(SandboxProviderExecuteRequest, "execute", {
            sandboxId,
            command: "true",
            arguments: [],
          }),
        ),
      );

      expect(failure.code).toBe("E2B_SANDBOX_PAUSED");
      expect(harness.connectCalls()).toBe(0);
      const connected = yield* harness.provider.connect(
        harness.request(SandboxProviderConnectRequest, "connect", { sandboxId }),
      );
      expect(harness.connectCalls()).toBe(1);
      expect(harness.connectTimeouts).toEqual([900_000]);
      expect(connected.connection.credentialRef).toBe("secret-broker/e2b/sandbox-1");
    }),
  );

  it.effect("serializes pause with execute so a paused sandbox cannot be auto-resumed", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const created = yield* harness.provider.create(createRequest);
      const sandboxId = created.sandbox.sandboxId;
      const hold = harness.holdPause();
      const pause = yield* harness.provider
        .pause(harness.request(SandboxProviderPauseRequest, "pause", { sandboxId }))
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => hold.entered);
      const contended = harness.nextContention();
      const execute = yield* Effect.flip(
        harness.provider.execute(
          harness.request(SandboxProviderExecuteRequest, "execute", {
            sandboxId,
            command: "true",
            arguments: [],
          }),
        ),
      ).pipe(Effect.forkChild);
      yield* Effect.promise(() => contended);

      expect(harness.executeCalls()).toBe(0);
      hold.release();
      yield* Fiber.join(pause);
      const failure = yield* Fiber.join(execute);
      expect(failure.code).toBe("E2B_SANDBOX_PAUSED");
      expect(harness.executeCalls()).toBe(0);
    }),
  );

  it.effect("fails closed when request identity or E2B metadata does not match", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const created = yield* harness.provider.create(createRequest);
      const sandboxId = created.sandbox.sandboxId;
      const wrongWorkspace = yield* Effect.flip(
        harness.provider.connect({
          ...harness.request(SandboxProviderConnectRequest, "connect", { sandboxId }),
          workspaceId: WorkspaceId.make("workspace-other"),
        }),
      );
      expect(wrongWorkspace.code).toBe("E2B_IDENTITY_MISMATCH");

      harness.setMetadata({ agentsin_cloud_provider: "e2b" });
      const drift = yield* Effect.flip(
        harness.provider.connect(
          harness.request(SandboxProviderConnectRequest, "connect", { sandboxId }),
        ),
      );
      expect(drift.code).toBe("E2B_IDENTITY_MISMATCH");
    }),
  );

  it.effect("returns typed sanitized upstream failures", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        executeFailure: new E2bClientFailure({
          code: "unavailable",
          message: "E2B execute failed",
          retryable: true,
        }),
      });
      const created = yield* harness.provider.create(createRequest);
      const failure = yield* Effect.flip(
        harness.provider.execute(
          harness.request(SandboxProviderExecuteRequest, "execute", {
            sandboxId: created.sandbox.sandboxId,
            command: "false",
            arguments: [],
          }),
        ),
      );
      expect(failure).toEqual({
        code: "E2B_UNAVAILABLE",
        message: "E2B execute failed",
        retryable: true,
        details: { operation: "execute" },
      });
    }),
  );

  it.effect("reports unsupported desktop capability without fabricating an endpoint", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ desktop: false });
      const created = yield* harness.provider.create(createRequest);
      const failure = yield* Effect.flip(
        harness.provider.desktop(
          harness.request(SandboxProviderDesktopRequest, "desktop", {
            sandboxId: created.sandbox.sandboxId,
          }),
        ),
      );
      expect(failure.code).toBe("E2B_UNSUPPORTED_CAPABILITY");
    }),
  );

  it.effect("serializes concurrent destroy requests and tombstones after one remote kill", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const created = yield* harness.provider.create(createRequest);
      const destroyRequest = harness.request(SandboxProviderDestroyRequest, "destroy", {
        sandboxId: created.sandbox.sandboxId,
      });

      const hold = harness.holdDestroy();
      const first = yield* harness.provider.destroy(destroyRequest).pipe(Effect.forkChild);
      yield* Effect.promise(() => hold.entered);
      const contended = harness.nextContention();
      const second = yield* harness.provider
        .destroy({ ...destroyRequest, requestId: CommandId.make("destroy-again") })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => contended);
      expect(harness.destroyCalls()).toBe(1);
      hold.release();
      yield* Fiber.join(first);
      yield* Fiber.join(second);

      expect(harness.destroyCalls()).toBe(1);
      expect(harness.records.get("sandbox-1")?.destroyedAt).toBe(NOW);
    }),
  );

  it.effect("rejects non-E2B and mutable template references", () =>
    Effect.gen(function* () {
      for (const image of [
        "ubuntu:24.04",
        "e2b://template/base:latest",
        `e2b://template/base:${BUILD_ID}`,
      ]) {
        const request = {
          ...createRequest,
          requestId: CommandId.make(`create-${image}`),
          revision: {
            ...createRequest.revision,
            blueprint: { ...createRequest.revision.blueprint, image },
          },
        };
        const harness = makeHarness();
        const failure = yield* Effect.flip(harness.provider.create(request));
        expect(failure.code).toBe("E2B_TEMPLATE_REQUIRED");
      }
    }),
  );
});
