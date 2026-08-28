import * as NodeCrypto from "node:crypto";

import { CommandId, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { SandboxProviderCreateRequest, SandboxId, SandboxPtyId } from "@t3tools/contracts/cloud";
import { WorkerInstanceId } from "@t3tools/contracts/worker";
import {
  e2bIdentityMetadataFor,
  type E2bClient,
  type E2bCreateInput,
  type E2bSandboxDescription,
  type SandboxIdentityRecord,
  type SandboxIdentityReservation,
  type SandboxIdentityStore,
} from "@t3tools/e2b-sandbox";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Pool } from "pg";

import type { DatabaseService } from "./database.ts";
import {
  E2bProviderServiceError,
  makeE2bProviderService,
  makeHostedE2bProviderService,
  makeMaterializingWorkerGateway,
  type SealedBootstrapMaterializer,
} from "./e2bSandboxProduction.ts";

const NOW = "2026-08-28T08:00:00.000Z";
const END = "2026-08-28T08:15:00.000Z";
const BUILD_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const date = (value: string) => DateTime.toDate(DateTime.makeUnsafe(value));

const createRequest = Schema.decodeUnknownSync(SandboxProviderCreateRequest)({
  type: "create",
  requestId: "create-e2b-1",
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
      name: "Verified E2B environment",
      repositoryIdentity: {
        canonicalKey: "github.com/jarrodwatts/agentsin-cloud",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://github.com/jarrodwatts/agentsin-cloud",
        },
      },
      image: `e2b://template/template-1@build-${BUILD_ID}`,
      workspaceDirectory: "/workspace",
      resources: { cpuCores: 4, memoryMiB: 8_192, storageMiB: 32_768 },
      setupCommands: [],
      runtimes: [],
      packages: [],
      pluginRefs: [],
      secretRefs: [],
      verificationCommands: [],
      providerInstances: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
    buildStatus: "ready",
    buildSummary: { message: "Verified", warningCount: 0, errorCount: 0, recentLines: [] },
    buildLogArtifact: {
      storage: "r2",
      bucket: "environment-builds",
      objectKey: "revision-1/build.log",
      contentHash: "sha256:build-log",
      sizeBytes: 1,
    },
    createdAt: NOW,
  },
});

const artifact = (kind: string) => ({
  storage: "r2" as const,
  bucket: "sandbox-artifacts",
  objectKey: `test/${kind}`,
  contentHash: NodeCrypto.createHash("sha256").update(kind).digest("hex"),
  sizeBytes: 0,
});

const artifacts = {
  open: async (input: { readonly kind: string }) => ({
    writerId: `writer/${input.kind}`,
    write: async () => undefined,
    complete: async () => artifact(input.kind),
    abort: async () => undefined,
  }),
  resume: async () => ({
    writerId: "writer/resumed",
    write: async () => undefined,
    complete: async () => artifact("resumed"),
    abort: async () => undefined,
  }),
};

const makeIdentityStore = () => {
  const reservations = new Map<string, SandboxIdentityReservation>();
  const records = new Map<string, SandboxIdentityRecord>();
  const states = new Map<string, "active" | "cleanup_required" | "destroyed">();
  const store: SandboxIdentityStore = {
    reserve: async (record) => {
      if (
        [...reservations.values()].some(
          (existing) =>
            existing.workspaceId === record.workspaceId && existing.threadId === record.threadId,
        )
      ) {
        throw new Error("thread already has an E2B sandbox reservation");
      }
      reservations.set(record.reservationId, record);
      return { state: "reserved" as const, disposition: "created" as const };
    },
    activateReservation: async (_workspaceId, reservationId, record) => {
      if (!reservations.has(reservationId)) throw new Error("reservation missing");
      records.set(record.sandboxId, record);
      states.set(record.sandboxId, "active");
    },
    markReservationFailed: async () => undefined,
    markReservationCleanupRequired: async () => undefined,
    get: async (_workspaceId, sandboxId) => {
      const identity = records.get(sandboxId);
      return identity === undefined
        ? undefined
        : { state: states.get(sandboxId) ?? "active", identity };
    },
    markDestroyed: async () => undefined,
    recordCleanupOrphan: async () => undefined,
    recordCleanupFailure: async () => undefined,
    markCleanupOrphanReclaimed: async () => undefined,
  };
  return { store, records, states };
};

const makeClient = (options?: {
  readonly remote?: () => E2bSandboxDescription | undefined;
  readonly onCreate?: (input: E2bCreateInput) => void;
}): E2bClient => ({
  create: async (input) => {
    options?.onCreate?.(input);
    return {
      sandboxId: "sandbox-1",
      templateId: input.templateId,
      state: "running",
      metadata: input.metadata,
      startedAt: date(NOW),
      endAt: date(END),
      sandboxDomain: "sandbox-1.e2b.app",
    };
  },
  inspect: async () => options?.remote?.(),
  connect: async () => {
    const remote = options?.remote?.();
    if (remote === undefined) throw new Error("sandbox missing");
    return remote;
  },
  execute: async () => ({
    exitCode: 0,
    stdoutSummary: "",
    stderrSummary: "",
    stdoutArtifact: artifact("stdout"),
    stderrArtifact: artifact("stderr"),
  }),
  files: async (_sandboxId, operation) =>
    operation.type === "list"
      ? { type: "list", path: operation.path, entries: [] }
      : operation.type === "read"
        ? { type: "read", path: operation.path, bytes: new Uint8Array() }
        : { type: operation.type, path: operation.path },
  pty: async () => ({ ptyId: SandboxPtyId.make("123"), state: "open" }),
  pause: async () => undefined,
  snapshot: async () => ({ snapshotId: "snapshot-1", state: "paused" }),
  desktop: async () => undefined,
  ports: async () => [],
  observability: async () => [],
  reconcilePtys: async () => undefined,
  shutdownPtys: async () => undefined,
  destroy: async () => true,
});

const lifecycleLocks = {
  withLock: async <A>(_sandboxId: SandboxId, operation: () => Promise<A>) => operation(),
};

it.effect("creates only after the durable thread reservation and rejects a second sandbox", () =>
  Effect.gen(function* () {
    const identities = makeIdentityStore();
    const bootstrap: SealedBootstrapMaterializer = {
      brokerId: "kms/bootstrap-production",
      validateConfiguration: Effect.void,
      materializeReference: () => Effect.void,
    };
    let createCalls = 0;
    const service = makeE2bProviderService({
      client: makeClient({ onCreate: () => (createCalls += 1) }),
      identities: identities.store,
      artifacts,
      lifecycleLocks,
      bootstrap,
      clock: { now: () => date(NOW) },
    });

    const first = yield* service.provider.create(createRequest);
    expect(first.sandbox.binding.threadId).toBe(createRequest.workspace.threadId);
    expect(createCalls).toBe(1);

    const duplicate = yield* Effect.exit(
      service.provider.create({ ...createRequest, requestId: CommandId.make("create-e2b-2") }),
    );
    expect(duplicate._tag).toBe("Failure");
    expect(createCalls).toBe(1);
  }),
);

it.effect("fails before remote create when the immutable template revision is absent", () =>
  Effect.gen(function* () {
    const identities = makeIdentityStore();
    let createCalls = 0;
    const service = makeE2bProviderService({
      client: makeClient({ onCreate: () => (createCalls += 1) }),
      identities: identities.store,
      artifacts,
      lifecycleLocks,
      bootstrap: {
        brokerId: "kms/bootstrap-production",
        validateConfiguration: Effect.void,
        materializeReference: () => Effect.void,
      },
    });

    const result = yield* Effect.exit(
      service.provider.create({
        ...createRequest,
        revision: {
          ...createRequest.revision,
          blueprint: { ...createRequest.revision.blueprint, image: "node:24" },
        },
      }),
    );
    expect(result._tag).toBe("Failure");
    expect(createCalls).toBe(0);
  }),
);

it.effect("materializes only an opaque reference into the exact bound running sandbox", () =>
  Effect.gen(function* () {
    const identities = makeIdentityStore();
    const sandboxId = SandboxId.make("sandbox-1");
    const identity: SandboxIdentityRecord = {
      reservationId: createRequest.requestId,
      sandboxId,
      provider: "e2b",
      workspaceId: createRequest.workspaceId,
      environmentId: createRequest.environmentId,
      projectId: createRequest.workspace.projectId,
      threadId: createRequest.workspace.threadId,
      revisionId: createRequest.revision.revisionId,
      providerTemplateId: "template-1",
      providerBuildId: BUILD_ID,
      repositoryIdentity: createRequest.workspace.repositoryIdentity,
      workspaceDirectory: createRequest.workspace.workspaceDirectory,
      providerHandle: "sandbox-1",
      createdAt: NOW,
    };
    identities.records.set(sandboxId, identity);
    identities.states.set(sandboxId, "active");
    let remote: E2bSandboxDescription = {
      sandboxId: "sandbox-1",
      templateId: "template-1",
      state: "running",
      metadata: e2bIdentityMetadataFor(createRequest, {
        templateId: "template-1",
        buildId: BUILD_ID,
      }),
      startedAt: date(NOW),
      endAt: date(END),
    };
    const materializations: Array<unknown> = [];
    let lockHeld = false;
    const service = makeE2bProviderService({
      client: makeClient({ remote: () => remote }),
      identities: identities.store,
      artifacts,
      lifecycleLocks: {
        withLock: async (_sandboxId, operation) => {
          lockHeld = true;
          try {
            return await operation();
          } finally {
            lockHeld = false;
          }
        },
      },
      bootstrap: {
        brokerId: "kms/bootstrap-production",
        validateConfiguration: Effect.void,
        materializeReference: (input) =>
          Effect.sync(() => {
            expect(lockHeld).toBe(true);
            materializations.push(input);
          }),
      },
      clock: { now: () => date(NOW) },
    });

    const wrongThread = yield* Effect.exit(
      service.materializeSealedBootstrap({
        workspaceId: identity.workspaceId,
        environmentId: identity.environmentId,
        threadId: "other-thread" as ThreadId,
        sandboxId,
        sealedBootstrapRef: "sealed://bootstrap/attempt-1",
      }),
    );
    expect(wrongThread).toMatchObject({ _tag: "Failure" });
    expect(materializations).toEqual([]);

    identities.states.set(sandboxId, "cleanup_required");
    const quarantined = yield* Effect.exit(
      service.materializeSealedBootstrap({
        workspaceId: identity.workspaceId,
        environmentId: identity.environmentId,
        threadId: identity.threadId,
        sandboxId,
        sealedBootstrapRef: "sealed://bootstrap/attempt-1",
      }),
    );
    expect(quarantined).toMatchObject({ _tag: "Failure" });
    expect(materializations).toEqual([]);
    identities.states.set(sandboxId, "active");

    remote = {
      ...remote,
      metadata: { ...remote.metadata, agentsin_cloud_thread_id: "other-thread" },
    };
    const mismatchedRemote = yield* Effect.exit(
      service.materializeSealedBootstrap({
        workspaceId: identity.workspaceId,
        environmentId: identity.environmentId,
        threadId: identity.threadId,
        sandboxId,
        sealedBootstrapRef: "sealed://bootstrap/attempt-1",
      }),
    );
    expect(mismatchedRemote).toMatchObject({ _tag: "Failure" });
    expect(materializations).toEqual([]);

    remote = {
      ...remote,
      templateId: "template-forged",
      metadata: e2bIdentityMetadataFor(createRequest, {
        templateId: "template-1",
        buildId: BUILD_ID,
      }),
    };
    const wrongTemplate = yield* Effect.exit(
      service.materializeSealedBootstrap({
        workspaceId: identity.workspaceId,
        environmentId: identity.environmentId,
        threadId: identity.threadId,
        sandboxId,
        sealedBootstrapRef: "sealed://bootstrap/attempt-1",
      }),
    );
    expect(wrongTemplate).toMatchObject({ _tag: "Failure" });
    expect(materializations).toEqual([]);

    remote = {
      ...remote,
      templateId: "template-1",
      metadata: e2bIdentityMetadataFor(createRequest, {
        templateId: "template-1",
        buildId: BUILD_ID,
      }),
    };
    const result = yield* service.materializeSealedBootstrap({
      workspaceId: identity.workspaceId,
      environmentId: identity.environmentId,
      threadId: identity.threadId,
      sandboxId,
      sealedBootstrapRef: "sealed://bootstrap/attempt-1",
    });
    expect(result).toEqual({ status: "materialized", completedAt: NOW });
    expect(materializations).toEqual([
      {
        workspaceId: identity.workspaceId,
        environmentId: identity.environmentId,
        threadId: identity.threadId,
        sandboxId,
        providerHandle: identity.providerHandle,
        revisionId: identity.revisionId,
        sealedBootstrapRef: "sealed://bootstrap/attempt-1",
      },
    ]);
  }),
);

it.effect("materializes the sealed bootstrap before the hosted lifecycle starts its worker", () =>
  Effect.gen(function* () {
    const order: Array<string> = [];
    const input = {
      workspaceId: createRequest.workspaceId,
      environmentId: createRequest.environmentId,
      threadId: createRequest.workspace.threadId,
      sandboxId: SandboxId.make("sandbox-1"),
      workerId: WorkerInstanceId.make("worker-1"),
      sealedBootstrapRef: "sealed://bootstrap/attempt-1",
    };
    const upstream = {
      start: () => Effect.sync(() => order.push("start")).pipe(Effect.asVoid),
      inspect: () => Effect.succeed("absent" as const),
      authorizeReconnect: () => Effect.die(new Error("unused by this startup test")),
    };
    const gateway = makeMaterializingWorkerGateway(
      {
        materializeSealedBootstrap: (materializeInput) =>
          Effect.sync(() => {
            expect(materializeInput).toMatchObject({
              workspaceId: input.workspaceId,
              environmentId: input.environmentId,
              threadId: input.threadId,
              sandboxId: input.sandboxId,
              sealedBootstrapRef: input.sealedBootstrapRef,
            });
            order.push("materialize");
            return { status: "materialized" as const, completedAt: NOW };
          }),
      },
      upstream,
    );

    yield* gateway.start(input);
    expect(order).toEqual(["materialize", "start"]);

    let blockedStartCalls = 0;
    const blocked = makeMaterializingWorkerGateway(
      {
        materializeSealedBootstrap: () =>
          Effect.fail(
            new E2bProviderServiceError({
              code: "unavailable",
              operation: "materialize-bootstrap-reference",
              retryable: true,
            }),
          ),
      },
      {
        ...upstream,
        start: () =>
          Effect.sync(() => {
            blockedStartCalls += 1;
          }),
      },
    );
    const failure = yield* Effect.flip(blocked.start(input));
    expect(failure).toMatchObject({
      code: "e2b-bootstrap-unavailable",
      retryable: true,
      outcome: "uncertain",
    });
    expect(blockedStartCalls).toBe(0);
  }),
);

it.effect("fails hosted composition before E2B I/O when secret-broker gates are absent", () =>
  Effect.gen(function* () {
    let sdkCalls = 0;
    const database = {
      pool: {} as Pool,
      query: () => Effect.succeed([]),
      ping: Effect.void,
    } as DatabaseService;
    const ptySessions = {
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
    const result = yield* Effect.exit(
      makeHostedE2bProviderService({
        config: { apiKey: "e2b-production-api-key-value", activeTimeoutMs: 900_000 },
        database,
        artifacts,
        lifecycleLocks,
        ptySessions,
        ptyOwnerId: "railway-control-plane-1",
        trafficCredentials: {
          brokerId: "",
          validateConfiguration: Effect.void,
          seal: async () => "opaque-ref",
          revoke: async () => undefined,
        },
        bootstrap: {
          brokerId: "kms/bootstrap-production",
          validateConfiguration: Effect.void,
          materializeReference: () => Effect.void,
        },
        sdk: {
          immutableBuildLaunch: true,
          create: async () => {
            sdkCalls += 1;
            throw new Error("must not run");
          },
          connect: async () => {
            sdkCalls += 1;
            throw new Error("must not run");
          },
          getInfo: async () => {
            sdkCalls += 1;
            throw new Error("must not run");
          },
          pause: async () => false,
          kill: async () => false,
          getMetrics: async () => [],
          getBuildStatus: async ({ templateId, buildId }) => ({
            templateID: templateId,
            buildID: buildId,
            status: "ready",
            logEntries: [],
            logs: [],
          }),
        },
      }),
    );

    expect(result._tag).toBe("Failure");
    expect(sdkCalls).toBe(0);
  }),
);
