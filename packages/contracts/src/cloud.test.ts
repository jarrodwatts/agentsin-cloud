import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  AgentConnection,
  AgentConnectionAdapterExchange,
  AgentConnectionBeginLoginResult,
  AgentConnectionMaterializeResult,
  AgentConnectionPollLoginResult,
  AgentConnectionProfile,
  AgentConnectionRefreshResult,
  AgentConnectionRevokeResult,
  AgentConnectionSealProfileResult,
  AgentConnectionValidateResult,
  AutomationApprovalEnvelope,
  AutomationApprovalPolicy,
  AutomationRecipe,
  AutomationRun,
  AutomationTrigger,
  CloudThreadCommand,
  CloudThreadCommandSubmissionRequest,
  CloudThreadEvent,
  CloudThreadStreamClientFrame,
  CloudThreadStreamServerFrame,
  DesktopAuthExchangeRequest,
  DesktopAuthInitiateRequest,
  DesktopLease,
  EnvironmentRevision,
  LedgerEntry,
  PluginGrant,
  PluginManifest,
  PluginMcpServer,
  SandboxProviderCapabilities,
  SandboxProviderExecuteResult,
  SandboxProviderPortsResult,
  SandboxProviderPtyResult,
  SandboxProviderRequest,
  SandboxProviderResult,
  Settlement,
  ThreadSandboxBindings,
  UsageLedgerPosting,
  UsageReceipt,
  UsageReceiptAccepted,
  UsageSample,
} from "./cloud.ts";

const NOW = "2026-08-27T12:00:00.000Z";
const WORKSPACE_ID = "workspace-1";
const SETTLEMENT_ADDRESS = "0x1111111111111111111111111111111111111111";
const TREASURY_ADDRESS = "0x2222222222222222222222222222222222222222";
const PAYER_ADDRESS = "0x3333333333333333333333333333333333333333";
const MERCHANT_ADDRESS = "0x4444444444444444444444444444444444444444";
const RECEIPT_TX_HASH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SETTLEMENT_TX_HASH = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("desktop auth handoff contracts", () => {
  it("accepts canonical S256 PKCE inputs", () => {
    expect(
      Schema.decodeUnknownSync(DesktopAuthInitiateRequest)({
        codeChallenge: "a".repeat(43),
        state: "s".repeat(32),
      }),
    ).toEqual({ codeChallenge: "a".repeat(43), state: "s".repeat(32) });
    expect(
      Schema.decodeUnknownSync(DesktopAuthExchangeRequest)({
        handoff: "signed-handoff",
        codeVerifier: "v".repeat(64),
      }),
    ).toEqual({ handoff: "signed-handoff", codeVerifier: "v".repeat(64) });
  });

  it("rejects padded, short, or empty handoff inputs", () => {
    expect(() =>
      Schema.decodeUnknownSync(DesktopAuthInitiateRequest)({
        codeChallenge: `${"a".repeat(42)}=`,
        state: "short",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(DesktopAuthExchangeRequest)({
        handoff: "",
        codeVerifier: "short",
      }),
    ).toThrow();
  });
});

const blueprint = {
  schemaVersion: 1,
  blueprintId: "blueprint-1",
  workspaceId: WORKSPACE_ID,
  name: "Default cloud workspace",
  repositoryIdentity: {
    canonicalKey: "github.com/pingdotgg/t3code",
    locator: {
      source: "git-remote",
      remoteName: "upstream",
      remoteUrl: "https://github.com/pingdotgg/t3code",
    },
  },
  checkoutRef: "main",
  image: "ghcr.io/agentsincloud/t3:2026-08-27",
  workspaceDirectory: "/workspace/t3code",
  resources: {
    cpuCores: 4,
    memoryMiB: 8192,
    storageMiB: 32768,
  },
  setupCommands: ["vp i"],
  runtimes: [{ name: "node", version: "24.13.1", contentHash: "sha256:node" }],
  packages: [
    {
      ecosystem: "npm",
      name: "@t3tools/contracts",
      version: "0.0.35",
      contentHash: "sha256:contracts",
    },
  ],
  pluginRefs: [{ pluginId: "github-plugin", version: "1.0.0", manifestHash: "sha256:manifest-1" }],
  secretRefs: ["agent-profile/codex-work"],
  verificationCommands: [
    {
      command: "vp",
      arguments: ["test", "run"],
      executableHash: "sha256:vp",
      timeoutMs: 60_000,
    },
  ],
  providerInstances: [
    {
      instanceId: "codex_work",
      driver: "codex",
    },
  ],
  createdAt: NOW,
  updatedAt: NOW,
} as const;

const revision = {
  revisionId: "revision-1",
  blueprintId: "blueprint-1",
  workspaceId: WORKSPACE_ID,
  revision: 1,
  contentHash: "sha256:revision-1",
  blueprint,
  buildStatus: "ready",
  buildSummary: {
    message: "Build completed",
    warningCount: 0,
    errorCount: 0,
    recentLines: ["Build completed"],
  },
  buildLogArtifact: {
    storage: "r2",
    bucket: "agents-in-cloud-build-logs",
    objectKey: "environment-builds/revision-1.log",
    contentHash: "sha256:build-log",
    sizeBytes: 128,
  },
  createdAt: NOW,
} as const;

const sandbox = {
  sandboxId: "sandbox-1",
  workspaceId: WORKSPACE_ID,
  environmentId: "environment-1",
  infrastructureProvider: "e2b",
  revisionId: "revision-1",
  workspace: {
    workspaceId: WORKSPACE_ID,
    projectId: "project-1",
    threadId: "thread-1",
    repositoryIdentity: blueprint.repositoryIdentity,
    workspaceDirectory: "/workspace/t3code",
  },
  binding: { workspaceId: WORKSPACE_ID, threadId: "thread-1", sandboxId: "sandbox-1" },
  providerHandle: "provider/sandboxes/sandbox-1",
  state: "ready",
  createdAt: NOW,
  updatedAt: NOW,
} as const;

const approvalBoundary = {
  repository: blueprint.repositoryIdentity,
  branches: ["codex/*"],
  push: true,
  draftPullRequest: true,
  comment: true,
  merge: false,
  deploy: false,
} as const;

const automationTarget = {
  type: "project",
  workspaceId: WORKSPACE_ID,
  environmentId: "environment-1",
  projectId: "project-1",
  revisionId: "revision-1",
  threadMode: "fresh",
} as const;

const automationApprovalRequest = {
  requestId: "approval-run-1",
  workspaceId: WORKSPACE_ID,
  recipeId: "recipe-1",
  runId: "run-1",
  environmentRevisionId: "revision-1",
  target: automationTarget,
  requestedAt: NOW,
  boundary: approvalBoundary,
  requestedActions: ["push"],
  allowedSecretRefs: ["agent-profile/codex-work"],
  maxMicroUsdc: 2_000_000,
} as const;

const approvedAutomationApproval = {
  ...automationApprovalRequest,
  status: "approved",
  decidedAt: NOW,
  decidedBy: "auth-session-1",
} as const;

const outputArtifact = {
  storage: "r2",
  bucket: "agents-in-cloud-sandbox-output",
  objectKey: "sandboxes/sandbox-1/commands/command-1/stdout.log",
  contentHash: "sha256:sandbox-output",
  sizeBytes: 128,
} as const;

const receiptSignature = {
  algorithm: "ed25519",
  keyId: "usage-key-1",
  payloadHash: "sha256:receipt-payload",
  signature: "base64:signature",
  signedAt: NOW,
} as const;

const settlementAuditFields = {
  chainIdentity: {
    namespace: "eip155",
    chain: "monad",
    chainId: 143,
    network: "monad-mainnet",
    nativeUsdcAddress: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    settlementContract: SETTLEMENT_ADDRESS,
    treasuryAddress: TREASURY_ADDRESS,
  },
  transfer: {
    txHash: SETTLEMENT_TX_HASH,
    transferId: `${SETTLEMENT_TX_HASH}:0`,
    fromAddress: PAYER_ADDRESS,
    toAddress: MERCHANT_ADDRESS,
    amountMicroUsdc: 1050,
    blockNumber: 1234,
  },
  receiptRefs: [{ receiptId: "receipt-1", signature: receiptSignature }],
  receiptSignatureRoot: "sha256:receipt-root",
  signature: {
    algorithm: "ed25519",
    keyId: "settlement-key-1",
    payloadHash: "sha256:settlement-payload",
    signature: "base64:settlement-signature",
    signedAt: NOW,
  },
} as const;

const usageSampleFixture = {
  sampleId: "sample-1",
  workspaceId: WORKSPACE_ID,
  environmentId: "environment-1",
  sandboxId: "sandbox-1",
  threadId: "thread-1",
  infrastructureProvider: "e2b",
  meter: "e2b.sandbox.cpu.millisecond",
  quantity: 1024,
  unit: "millisecond",
  intervalStart: NOW,
  intervalEnd: "2026-08-27T12:01:00.000Z",
  observedAt: "2026-08-27T12:01:01.000Z",
  sourceEventId: "event-1",
  metadata: { model: "gpt-5.6" },
} as const;

const decodeRevision = Schema.decodeUnknownSync(EnvironmentRevision);
const decodeSandboxRequest = Schema.decodeUnknownSync(SandboxProviderRequest);
const decodeSandboxResult = Schema.decodeUnknownSync(SandboxProviderResult);
const decodeCloudThreadCommand = Schema.decodeUnknownSync(CloudThreadCommand);
const decodeCloudThreadEvent = Schema.decodeUnknownSync(CloudThreadEvent);
const decodeCloudThreadCommandSubmission = Schema.decodeUnknownSync(
  CloudThreadCommandSubmissionRequest,
);
const decodeCloudThreadStreamClientFrame = Schema.decodeUnknownSync(CloudThreadStreamClientFrame);
const decodeCloudThreadStreamServerFrame = Schema.decodeUnknownSync(CloudThreadStreamServerFrame);
const decodePluginManifest = Schema.decodeUnknownSync(PluginManifest);
const decodeUsageSample = Schema.decodeUnknownSync(UsageSample);

describe("cloud provider contracts", () => {
  it("covers the complete sandbox provider capability surface", () => {
    const capabilities = Schema.decodeUnknownSync(SandboxProviderCapabilities)([
      "create",
      "connect",
      "execute",
      "files",
      "pty",
      "pause",
      "resume",
      "snapshot",
      "desktop",
      "ports",
      "usage",
      "destroy",
      "futureGpu",
    ]);
    const requestBase = {
      requestId: "command-1",
      workspaceId: WORKSPACE_ID,
      environmentId: "environment-1",
      sandboxId: "sandbox-1",
      requestedAt: NOW,
    };
    const requests = [
      { type: "connect", ...requestBase },
      {
        type: "execute",
        ...requestBase,
        command: "git",
        arguments: ["status", "--short"],
      },
      {
        type: "files",
        ...requestBase,
        operation: { type: "read", path: "/workspace/README.md" },
      },
      {
        type: "pty",
        ...requestBase,
        operation: { type: "open", columns: 120, rows: 40 },
      },
      { type: "pause", ...requestBase },
      { type: "resume", ...requestBase },
      { type: "snapshot", ...requestBase },
      { type: "desktop", ...requestBase },
      { type: "ports", ...requestBase },
      { type: "usage", ...requestBase, since: NOW, until: NOW },
      { type: "destroy", ...requestBase },
    ];

    expect(capabilities).toHaveLength(12);
    expect(requests.map((request) => decodeSandboxRequest(request).type)).toEqual([
      "connect",
      "execute",
      "files",
      "pty",
      "pause",
      "resume",
      "snapshot",
      "desktop",
      "ports",
      "usage",
      "destroy",
    ]);
  });

  it("round-trips immutable revisions and provider messages through JSON codecs", () => {
    const revisionCodec = Schema.toCodecJson(EnvironmentRevision);
    const requestCodec = Schema.toCodecJson(SandboxProviderRequest);
    const resultCodec = Schema.toCodecJson(SandboxProviderResult);

    const decodedRevision = decodeRevision(revision);
    const decodedRequest = decodeSandboxRequest({
      type: "create",
      requestId: "command-1",
      workspaceId: WORKSPACE_ID,
      environmentId: "environment-1",
      workspace: sandbox.workspace,
      revision,
      requestedAt: NOW,
    });
    const decodedResult = decodeSandboxResult({
      type: "created",
      requestId: "command-1",
      workspaceId: WORKSPACE_ID,
      sandbox,
      completedAt: NOW,
    });

    expect(
      Schema.decodeUnknownSync(revisionCodec)(
        Schema.encodeUnknownSync(revisionCodec)(decodedRevision),
      ),
    ).toStrictEqual(decodedRevision);
    expect(
      Schema.decodeUnknownSync(requestCodec)(
        Schema.encodeUnknownSync(requestCodec)(decodedRequest),
      ),
    ).toStrictEqual(decodedRequest);
    expect(
      Schema.decodeUnknownSync(resultCodec)(Schema.encodeUnknownSync(resultCodec)(decodedResult)),
    ).toStrictEqual(decodedResult);
  });

  it("rejects a revision whose snapshot belongs to another blueprint", () => {
    expect(() =>
      decodeRevision({
        ...revision,
        blueprintId: "blueprint-2",
      }),
    ).toThrow();
  });

  it("requires complete rollback audit fields on a rolled-back revision", () => {
    expect(() => decodeRevision({ ...revision, buildStatus: "rolledBack" })).toThrow();

    const rolledBack = decodeRevision({
      ...revision,
      buildStatus: "rolledBack",
      rollbackRevisionId: "revision-previous",
      rollbackReason: "Verification failed",
      rolledBackAt: NOW,
    });

    expect(rolledBack.rollbackRevisionId).toBe("revision-previous");
  });

  it("bounds revision summaries and requires an R2 build-log artifact", () => {
    expect(() =>
      decodeRevision({
        ...revision,
        buildSummary: { ...revision.buildSummary, recentLines: Array(21).fill("line") },
      }),
    ).toThrow();
    expect(() =>
      decodeRevision({
        ...revision,
        buildLogArtifact: { ...revision.buildLogArtifact, storage: "s3" },
      }),
    ).toThrow();
  });

  it("creates only from ready revisions and rejects pre-sandbox lease ids", () => {
    const createRequest = {
      type: "create",
      requestId: "command-1",
      workspaceId: WORKSPACE_ID,
      environmentId: "environment-1",
      workspace: sandbox.workspace,
      revision,
      requestedAt: NOW,
    } as const;

    expect(() =>
      decodeSandboxRequest({
        ...createRequest,
        revision: { ...revision, buildStatus: "building" },
      }),
    ).toThrow();
    expect(() =>
      decodeSandboxRequest({ ...createRequest, leaseId: "lease-before-sandbox" }),
    ).toThrow();
  });

  it("rejects provider ports outside the canonical port range", () => {
    expect(() =>
      Schema.decodeUnknownSync(SandboxProviderPortsResult)({
        type: "ports",
        requestId: "command-1",
        workspaceId: WORKSPACE_ID,
        sandboxId: "sandbox-1",
        ports: [{ internalPort: 70_000, protocol: "http", visibility: "private" }],
        completedAt: NOW,
      }),
    ).toThrow();
  });

  it("bounds execute and PTY output summaries and requires R2 artifacts", () => {
    const execute = {
      type: "executed",
      requestId: "command-1",
      workspaceId: WORKSPACE_ID,
      sandboxId: "sandbox-1",
      exitCode: 0,
      stdoutSummary: "complete",
      stderrSummary: "",
      stdoutArtifact: outputArtifact,
      stderrArtifact: {
        ...outputArtifact,
        objectKey: "sandboxes/sandbox-1/commands/command-1/stderr.log",
      },
      startedAt: NOW,
      completedAt: NOW,
    } as const;
    const pty = {
      type: "pty",
      requestId: "command-1",
      workspaceId: WORKSPACE_ID,
      sandboxId: "sandbox-1",
      ptyId: "pty-1",
      state: "open",
      outputSummary: "ready",
      outputArtifact: outputArtifact,
      completedAt: NOW,
    } as const;

    expect(Schema.decodeUnknownSync(SandboxProviderExecuteResult)(execute).stdoutSummary).toBe(
      "complete",
    );
    expect(Schema.decodeUnknownSync(SandboxProviderPtyResult)(pty).outputSummary).toBe("ready");
    expect(() =>
      Schema.decodeUnknownSync(SandboxProviderExecuteResult)({
        ...execute,
        stdoutSummary: "x".repeat(4097),
      }),
    ).toThrow();
    const { stdoutArtifact: _stdoutArtifact, ...executeWithoutStdoutArtifact } = execute;
    expect(() =>
      Schema.decodeUnknownSync(SandboxProviderExecuteResult)(executeWithoutStdoutArtifact),
    ).toThrow();
    const { outputArtifact: _outputArtifact, ...ptyWithoutArtifact } = pty;
    expect(() => Schema.decodeUnknownSync(SandboxProviderPtyResult)(ptyWithoutArtifact)).toThrow();
  });

  it("rejects a sandbox binding that does not match its one workspace thread", () => {
    expect(() =>
      decodeSandboxResult({
        type: "created",
        requestId: "command-1",
        workspaceId: WORKSPACE_ID,
        sandbox: {
          ...sandbox,
          binding: {
            workspaceId: WORKSPACE_ID,
            threadId: "thread-2",
            sandboxId: "sandbox-1",
          },
        },
        completedAt: NOW,
      }),
    ).toThrow();
  });

  it("rejects sandbox results routed to another workspace", () => {
    expect(() =>
      decodeSandboxResult({
        type: "created",
        requestId: "command-1",
        workspaceId: "workspace-2",
        sandbox,
        completedAt: NOW,
      }),
    ).toThrow();
  });

  it("rejects registry snapshots that assign one thread to multiple sandboxes", () => {
    expect(() =>
      Schema.decodeUnknownSync(ThreadSandboxBindings)([
        { workspaceId: WORKSPACE_ID, threadId: "thread-1", sandboxId: "sandbox-1" },
        { workspaceId: WORKSPACE_ID, threadId: "thread-1", sandboxId: "sandbox-2" },
      ]),
    ).toThrow();
  });
});

describe("cloud thread envelopes", () => {
  const command = {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    environmentId: "environment-1",
    threadId: "thread-1",
    command: {
      type: "thread.turn.interrupt",
      commandId: "command-1",
      threadId: "thread-1",
      turnId: "turn-1",
      createdAt: NOW,
    },
    enqueuedAt: NOW,
  } as const;

  const event = {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    environmentId: "environment-1",
    threadId: "thread-1",
    event: {
      sequence: 1,
      eventId: "event-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      occurredAt: NOW,
      commandId: "command-1",
      causationEventId: null,
      correlationId: "command-1",
      metadata: {},
      type: "thread.deleted",
      payload: {
        threadId: "thread-1",
        deletedAt: NOW,
      },
    },
    receivedAt: NOW,
  } as const;

  it("wraps the canonical orchestration command and event shapes", () => {
    expect(decodeCloudThreadCommand(command).command.type).toBe("thread.turn.interrupt");
    expect(decodeCloudThreadEvent(event).event.type).toBe("thread.deleted");
  });

  it("rejects a command routed to a different thread", () => {
    expect(() =>
      decodeCloudThreadCommand({
        ...command,
        threadId: "thread-2",
      }),
    ).toThrow();
  });

  it("requires workspace identity on cloud thread envelopes", () => {
    expect(() => decodeCloudThreadCommand({ ...command, workspaceId: undefined })).toThrow();
    expect(() => decodeCloudThreadEvent({ ...event, workspaceId: undefined })).toThrow();
  });

  it("bounds and versions desktop command and stream RPC frames", () => {
    expect(
      decodeCloudThreadCommandSubmission({
        protocolVersion: 1,
        idempotencyKey: "desktop-request-1",
        envelope: command,
      }).idempotencyKey,
    ).toBe("desktop-request-1");
    expect(
      decodeCloudThreadStreamClientFrame({
        protocolVersion: 1,
        type: "subscribe",
        threadId: "thread-1",
        afterSequence: -1,
      }).type,
    ).toBe("subscribe");
    expect(
      decodeCloudThreadStreamServerFrame({
        protocolVersion: 1,
        type: "event",
        event,
      }).type,
    ).toBe("event");

    expect(() =>
      decodeCloudThreadCommandSubmission({
        protocolVersion: 2,
        idempotencyKey: "desktop-request-1",
        envelope: command,
      }),
    ).toThrow();
    expect(() =>
      decodeCloudThreadStreamClientFrame({
        protocolVersion: 1,
        type: "subscribe",
        threadId: "thread-1",
        afterSequence: -2,
      }),
    ).toThrow();
    expect(() =>
      decodeCloudThreadStreamClientFrame({
        protocolVersion: 1,
        type: "subscribe",
        threadId: "thread-1",
        afterSequence: -1,
        workspaceId: "spoofed-workspace",
      }),
    ).toThrow();
  });

  it("rejects project commands at the thread boundary", () => {
    expect(() =>
      decodeCloudThreadCommand({
        ...command,
        command: {
          type: "project.delete",
          commandId: "command-1",
          projectId: "project-1",
        },
      }),
    ).toThrow();
  });

  it("rejects an event routed to a different aggregate", () => {
    expect(() =>
      decodeCloudThreadEvent({
        ...event,
        threadId: "thread-2",
      }),
    ).toThrow();
  });
});

describe("cloud lifecycle records", () => {
  it("decodes every agent connection adapter lifecycle result", () => {
    const profile = Schema.decodeUnknownSync(AgentConnectionProfile)({
      profileId: "profile-1",
      workspaceId: WORKSPACE_ID,
      driver: "codex",
      label: "Work account",
      sealedCredentialRef: "secrets/agent-profiles/profile-1",
      state: "active",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const begin = Schema.decodeUnknownSync(AgentConnectionBeginLoginResult)({
      loginId: "login-1",
      workspaceId: WORKSPACE_ID,
      driver: "codex",
      method: "browser",
      authorizationUrl: "https://example.test/authorize",
      expiresAt: "2026-08-27T12:05:00.000Z",
      pollAfterMs: 1000,
    });
    const poll = Schema.decodeUnknownSync(AgentConnectionPollLoginResult)({
      status: "authorized",
      loginId: "login-1",
      workspaceId: WORKSPACE_ID,
      credentialHandle: "ephemeral/login-1",
    });
    const sealed = Schema.decodeUnknownSync(AgentConnectionSealProfileResult)({
      workspaceId: WORKSPACE_ID,
      profile,
    });
    const materialized = Schema.decodeUnknownSync(AgentConnectionMaterializeResult)({
      materializationId: "materialization-1",
      profileId: "profile-1",
      workspaceId: WORKSPACE_ID,
      environmentId: "environment-1",
      materializationRef: "sandbox-secrets/materialization-1",
      materializedAt: NOW,
    });
    const validated = Schema.decodeUnknownSync(AgentConnectionValidateResult)({
      profileId: "profile-1",
      workspaceId: WORKSPACE_ID,
      status: "valid",
      checkedAt: NOW,
    });
    const refreshed = Schema.decodeUnknownSync(AgentConnectionRefreshResult)({
      workspaceId: WORKSPACE_ID,
      profile,
      refreshedAt: NOW,
    });
    const revoked = Schema.decodeUnknownSync(AgentConnectionRevokeResult)({
      profileId: "profile-1",
      workspaceId: WORKSPACE_ID,
      revokedAt: NOW,
    });

    expect(begin.method).toBe("browser");
    expect(poll.status).toBe("authorized");
    expect(sealed.profile.profileId).toBe("profile-1");
    expect(materialized.environmentId).toBe("environment-1");
    expect(validated.status).toBe("valid");
    expect(refreshed.profile.state).toBe("active");
    expect(revoked.profileId).toBe("profile-1");
  });

  it("rejects cross-workspace agent connection adapter exchanges", () => {
    const exchange = {
      operation: "pollLogin",
      request: {
        requestId: "command-1",
        workspaceId: WORKSPACE_ID,
        requestedAt: NOW,
        loginId: "login-1",
      },
      result: {
        status: "authorized",
        loginId: "login-1",
        workspaceId: WORKSPACE_ID,
        credentialHandle: "ephemeral/login-1",
      },
    } as const;

    expect(Schema.decodeUnknownSync(AgentConnectionAdapterExchange)(exchange).operation).toBe(
      "pollLogin",
    );
    expect(() =>
      Schema.decodeUnknownSync(AgentConnectionAdapterExchange)({
        ...exchange,
        result: { ...exchange.result, workspaceId: "workspace-2" },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(AgentConnectionAdapterExchange)({
        ...exchange,
        result: { ...exchange.result, loginId: "login-2" },
      }),
    ).toThrow();
  });

  it("decodes leases, agent connections, plugin grants, and automation runs", () => {
    const lease = Schema.decodeUnknownSync(DesktopLease)({
      leaseId: "lease-1",
      workspaceId: WORKSPACE_ID,
      environmentId: "environment-1",
      threadId: "thread-1",
      sandboxId: "sandbox-1",
      revisionId: "revision-1",
      holder: {
        type: "userClient",
        authSessionId: "auth-session-1",
        clientId: "desktop-client-1",
      },
      generation: 2,
      state: "active",
      acquiredAt: NOW,
      renewedAt: NOW,
      heartbeatAt: NOW,
      expiresAt: "2026-08-27T12:05:00.000Z",
    });
    const connection = Schema.decodeUnknownSync(AgentConnection)({
      connectionId: "connection-1",
      workspaceId: WORKSPACE_ID,
      environmentId: "environment-1",
      threadId: "thread-1",
      provider: { instanceId: "codex_work", driver: "codex" },
      runtimeSessionId: "runtime-session-1",
      state: "connected",
      createdAt: NOW,
      updatedAt: NOW,
      connectedAt: NOW,
    });
    const grant = Schema.decodeUnknownSync(PluginGrant)({
      grantId: "grant-1",
      workspaceId: WORKSPACE_ID,
      environmentId: "environment-1",
      pluginId: "github-plugin",
      pluginVersion: "1.0.0",
      manifestSchemaVersion: 1,
      manifestHash: "sha256:manifest-1",
      permissions: [{ type: "file", access: ["read"], paths: ["/workspace"] }],
      state: "active",
      grantedBy: "auth-session-1",
      grantedAt: NOW,
    });
    const recipe = Schema.decodeUnknownSync(AutomationRecipe)({
      schemaVersion: 1,
      recipeId: "recipe-1",
      workspaceId: WORKSPACE_ID,
      name: "Review nightly failures",
      enabled: true,
      trigger: {
        type: "schedule",
        rrule: "FREQ=DAILY;BYHOUR=9",
        timeZone: "America/New_York",
      },
      target: automationTarget,
      instruction: "Review the latest failed checks.",
      provider: { instanceId: "codex_work", driver: "codex" },
      pluginGrantIds: ["grant-1"],
      approval: {
        mode: "externalWrites",
        boundary: approvalBoundary,
        allowedSecretRefs: ["agent-profile/codex-work"],
      },
      allowedSecretRefs: ["agent-profile/codex-work"],
      maxMicroUsdc: 2_000_000,
      outputs: [{ name: "summary", format: "text", required: true }],
      retry: {
        maxAttempts: 3,
        initialBackoffMs: 1000,
        maxBackoffMs: 30_000,
        retryOn: ["providerUnavailable"],
      },
      notifications: {
        events: ["failed", "budgetExceeded"],
        channels: [{ type: "desktop" }],
      },
      createdAt: NOW,
      updatedAt: NOW,
    });
    const run = Schema.decodeUnknownSync(AutomationRun)({
      runId: "run-1",
      recipeId: "recipe-1",
      workspaceId: WORKSPACE_ID,
      environmentId: "environment-1",
      projectId: "project-1",
      revisionId: "revision-1",
      threadMode: "fresh",
      threadId: "thread-1",
      turnId: "turn-1",
      commandId: "command-1",
      attempt: 1,
      state: "succeeded",
      approval: approvedAutomationApproval,
      maxMicroUsdc: 2_000_000,
      spentMicroUsdc: 1250,
      outputs: [{ name: "summary", format: "text", value: "No failures." }],
      queuedAt: NOW,
      startedAt: NOW,
      finishedAt: NOW,
    });

    expect(lease.state).toBe("active");
    expect(connection.runtimeSessionId).toBe("runtime-session-1");
    expect(grant.permissions[0]?.type).toBe("file");
    expect(recipe.trigger.type).toBe("schedule");
    expect(run.state).toBe("succeeded");
  });

  it("rejects a lease heartbeat after its expiry", () => {
    expect(() =>
      Schema.decodeUnknownSync(DesktopLease)({
        leaseId: "lease-1",
        workspaceId: WORKSPACE_ID,
        environmentId: "environment-1",
        threadId: "thread-1",
        sandboxId: "sandbox-1",
        revisionId: "revision-1",
        holder: { type: "agent", connectionId: "connection-1" },
        generation: 1,
        state: "active",
        acquiredAt: NOW,
        renewedAt: NOW,
        heartbeatAt: "2026-08-27T12:06:00.000Z",
        expiresAt: "2026-08-27T12:05:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects inactive leases with incompatible release reasons", () => {
    expect(() =>
      Schema.decodeUnknownSync(DesktopLease)({
        leaseId: "lease-1",
        workspaceId: WORKSPACE_ID,
        environmentId: "environment-1",
        threadId: "thread-1",
        sandboxId: "sandbox-1",
        revisionId: "revision-1",
        holder: { type: "disconnected", previousHolderType: "agent", disconnectedAt: NOW },
        generation: 1,
        state: "expired",
        acquiredAt: NOW,
        renewedAt: NOW,
        heartbeatAt: NOW,
        expiresAt: "2026-08-27T12:05:00.000Z",
        releaseReason: "revoked",
        endedAt: "2026-08-27T12:05:00.000Z",
      }),
    ).toThrow();
  });

  it("fails closed on unknown plugin-grant permissions and manifest versions", () => {
    const grant = {
      grantId: "grant-1",
      workspaceId: WORKSPACE_ID,
      environmentId: "environment-1",
      pluginId: "github-plugin",
      pluginVersion: "1.0.0",
      manifestSchemaVersion: 1,
      manifestHash: "sha256:manifest-1",
      permissions: [{ type: "file", access: ["read"], paths: ["/workspace"] }],
      state: "active",
      grantedBy: "auth-session-1",
      grantedAt: NOW,
    } as const;

    expect(() =>
      Schema.decodeUnknownSync(PluginGrant)({
        ...grant,
        permissions: [{ type: "future-permission", scope: "future" }],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(PluginGrant)({
        ...grant,
        permissions: [
          { type: "file", access: ["read"], paths: ["/workspace"], futureRestriction: true },
        ],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(PluginGrant)({ ...grant, manifestSchemaVersion: 2 }),
    ).toThrow();
  });
});

describe("automation triggers", () => {
  it("decodes schedule, GitHub, Sentry issue, signed webhook, and manual triggers", () => {
    const decodeTrigger = Schema.decodeUnknownSync(AutomationTrigger);
    const triggers = [
      { type: "schedule", rrule: "FREQ=HOURLY", timeZone: "UTC" },
      {
        type: "github",
        repository: blueprint.repositoryIdentity,
        filters: [
          {
            kind: "pull_request",
            actions: ["opened", "synchronize"],
            branches: ["main"],
            labels: ["agent"],
          },
          { kind: "issue", actions: ["opened"], branches: [], labels: [] },
          { kind: "comment", actions: ["created"], branches: [], labels: [] },
        ],
      },
      {
        type: "sentry",
        organization: "agents-in-cloud",
        project: "server",
        environments: ["production"],
        levels: ["error", "fatal"],
        tags: { ownedBy: "platform" },
      },
      {
        type: "webhook",
        path: "/hooks/deploy",
        signature: {
          algorithm: "hmac-sha256",
          secretRef: "secrets/webhooks/deploy",
          signatureHeader: "x-signature",
          timestampHeader: "x-timestamp",
          toleranceSeconds: 300,
        },
      },
      { type: "manual" },
    ];

    expect(triggers.map((trigger) => decodeTrigger(trigger).type)).toEqual([
      "schedule",
      "github",
      "sentry",
      "webhook",
      "manual",
    ]);
  });

  it("forbids merge/deploy boundaries and rejects runs over budget", () => {
    expect(() =>
      Schema.decodeUnknownSync(AutomationApprovalPolicy)({
        mode: "always",
        boundary: { ...approvalBoundary, merge: true },
        allowedSecretRefs: [],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(AutomationRun)({
        runId: "run-over-budget",
        recipeId: "recipe-1",
        workspaceId: WORKSPACE_ID,
        environmentId: "environment-1",
        projectId: "project-1",
        revisionId: "revision-1",
        threadMode: "fresh",
        threadId: "thread-1",
        attempt: 1,
        state: "budgetExceeded",
        approval: {
          ...approvedAutomationApproval,
          requestId: "approval-run-over-budget",
          runId: "run-over-budget",
          maxMicroUsdc: 100,
        },
        maxMicroUsdc: 100,
        spentMicroUsdc: 101,
        outputs: [],
        queuedAt: NOW,
      }),
    ).toThrow();
  });

  it("rejects requested writes outside an approval envelope boundary", () => {
    const decodeEnvelope = Schema.decodeUnknownSync(AutomationApprovalEnvelope);
    const envelope = {
      requestId: "approval-1",
      workspaceId: WORKSPACE_ID,
      recipeId: "recipe-1",
      runId: "run-1",
      environmentRevisionId: "revision-1",
      target: automationTarget,
      status: "pending",
      requestedAt: NOW,
      boundary: approvalBoundary,
      requestedActions: ["push", "comment"],
      allowedSecretRefs: ["agent-profile/codex-work"],
      maxMicroUsdc: 1_000_000,
    } as const;

    expect(decodeEnvelope(envelope).requestedActions).toEqual(["push", "comment"]);
    expect(() =>
      decodeEnvelope({
        ...envelope,
        boundary: { ...approvalBoundary, draftPullRequest: false },
        requestedActions: ["draftPullRequest"],
      }),
    ).toThrow();
  });

  it("discriminates approval status fields and caps payment approvals", () => {
    const decodeEnvelope = Schema.decodeUnknownSync(AutomationApprovalEnvelope);
    const base = {
      requestId: "approval-payment",
      workspaceId: WORKSPACE_ID,
      recipeId: "recipe-1",
      runId: "run-payment",
      environmentRevisionId: "revision-1",
      target: automationTarget,
      requestedAt: NOW,
      boundary: approvalBoundary,
      requestedActions: ["payment"],
      allowedSecretRefs: [],
      maxMicroUsdc: 100,
    } as const;

    expect(() => decodeEnvelope({ ...base, status: "approved" })).toThrow();
    expect(() =>
      decodeEnvelope({
        ...base,
        status: "approved",
        decidedAt: NOW,
        decidedBy: "auth-session-1",
        approvedMicroUsdc: 101,
      }),
    ).toThrow();
    expect(
      decodeEnvelope({
        ...base,
        status: "approved",
        decidedAt: NOW,
        decidedBy: "auth-session-1",
        approvedMicroUsdc: 100,
      }).status,
    ).toBe("approved");
    expect(() => decodeEnvelope({ ...base, status: "pending", decidedAt: NOW })).toThrow();
    expect(() => decodeEnvelope({ ...base, status: "rejected", reason: "Denied" })).toThrow();
  });

  it("requires a thread id once a fresh-thread run starts", () => {
    expect(() =>
      Schema.decodeUnknownSync(AutomationRun)({
        runId: "run-started",
        recipeId: "recipe-1",
        workspaceId: WORKSPACE_ID,
        environmentId: "environment-1",
        projectId: "project-1",
        revisionId: "revision-1",
        threadMode: "fresh",
        attempt: 1,
        state: "running",
        approval: {
          ...approvedAutomationApproval,
          requestId: "approval-run-started",
          runId: "run-started",
          maxMicroUsdc: 100,
        },
        maxMicroUsdc: 100,
        spentMicroUsdc: 0,
        outputs: [],
        queuedAt: NOW,
        startedAt: NOW,
      }),
    ).toThrow();
  });

  it("binds approvals to one run and enforces run-state approval status", () => {
    const waitingRun = {
      runId: "run-waiting",
      recipeId: "recipe-1",
      workspaceId: WORKSPACE_ID,
      environmentId: "environment-1",
      projectId: "project-1",
      revisionId: "revision-1",
      threadMode: "fresh",
      attempt: 1,
      state: "waitingForApproval",
      approval: {
        ...automationApprovalRequest,
        requestId: "approval-run-waiting",
        runId: "run-waiting",
        status: "pending",
      },
      maxMicroUsdc: 2_000_000,
      spentMicroUsdc: 0,
      outputs: [],
      queuedAt: NOW,
    } as const;

    expect(Schema.decodeUnknownSync(AutomationRun)(waitingRun).state).toBe("waitingForApproval");
    expect(() =>
      Schema.decodeUnknownSync(AutomationRun)({
        ...waitingRun,
        approval: { ...waitingRun.approval, runId: "run-replayed" },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(AutomationRun)({ ...waitingRun, state: "queued" }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(AutomationRun)({
        ...waitingRun,
        state: "cancelled",
        threadId: "thread-1",
        approval: {
          ...automationApprovalRequest,
          requestId: "approval-run-waiting",
          runId: "run-waiting",
          status: "rejected",
          decidedAt: NOW,
          decidedBy: "auth-session-1",
          reason: "Denied",
        },
      }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(AutomationRun)({
        ...waitingRun,
        state: "approvalRejected",
        approval: {
          ...automationApprovalRequest,
          requestId: "approval-run-waiting",
          runId: "run-waiting",
          status: "rejected",
          decidedAt: NOW,
          decidedBy: "auth-session-1",
          reason: "Denied",
        },
      }).state,
    ).toBe("approvalRejected");
  });
});

describe("cloud usage accounting", () => {
  it("round-trips the sample-to-settlement record chain", () => {
    const decodedSample = decodeUsageSample(usageSampleFixture);
    const receipt = Schema.decodeUnknownSync(UsageReceipt)({
      receiptId: "receipt-1",
      workspaceId: WORKSPACE_ID,
      environmentId: "environment-1",
      sandboxId: "sandbox-1",
      threadId: "thread-1",
      infrastructureProvider: "e2b",
      sampleRange: {
        firstSampleId: "sample-1",
        lastSampleId: "sample-1",
        sampleCount: 1,
        intervalStart: NOW,
        intervalEnd: "2026-08-27T12:01:00.000Z",
      },
      status: "accepted",
      upstreamMicroUsdc: 1000,
      markupBasisPoints: 500,
      markupRounding: "half-up-to-nearest-micro-usdc",
      markupMicroUsdc: 50,
      totalMicroUsdc: 1050,
      txHash: RECEIPT_TX_HASH,
      signature: receiptSignature,
      ledgerEntryId: "entry-1",
      recordedAt: NOW,
    });
    const entry = Schema.decodeUnknownSync(LedgerEntry)({
      entryId: "entry-1",
      workspaceId: WORKSPACE_ID,
      environmentId: "environment-1",
      kind: "usage",
      direction: "debit",
      amountMicroUsdc: -1050,
      sandboxId: "sandbox-1",
      threadId: "thread-1",
      usageReceiptId: "receipt-1",
      recordedAt: NOW,
    });
    const posting = Schema.decodeUnknownSync(UsageLedgerPosting)({ receipt, entry });
    const settlement = Schema.decodeUnknownSync(Settlement)({
      settlementId: "settlement-1",
      workspaceId: WORKSPACE_ID,
      environmentId: "environment-1",
      threadId: "thread-1",
      state: "finalized",
      ...settlementAuditFields,
      usagePostings: [posting],
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: "2026-09-01T00:00:00.000Z",
      ledgerEntryIds: ["entry-1"],
      debitMicroUsdc: 1050,
      createdAt: NOW,
      finalizedAt: NOW,
    });

    const codec = Schema.toCodecJson(
      Schema.Struct({
        usageSample: UsageSample,
        receipt: UsageReceipt,
        entry: LedgerEntry,
        settlement: Settlement,
      }),
    );
    const records = { usageSample: decodedSample, receipt, entry, settlement };

    expect(Schema.decodeUnknownSync(codec)(Schema.encodeUnknownSync(codec)(records))).toStrictEqual(
      records,
    );
    expect(posting.entry.amountMicroUsdc).toBe(-posting.receipt.totalMicroUsdc);
    expect(() =>
      Schema.decodeUnknownSync(UsageReceipt)({
        ...receipt,
        infrastructureProvider: "agent-subscription",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(Settlement)({
        ...settlement,
        chainIdentity: { ...settlement.chainIdentity, chainId: 1 },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(Settlement)({
        ...settlement,
        chainIdentity: {
          ...settlement.chainIdentity,
          nativeUsdcAddress: "0x0000000000000000000000000000000000000000",
        },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(Settlement)({
        ...settlement,
        chainIdentity: { ...settlement.chainIdentity, settlementContract: "0xnot-an-address" },
      }),
    ).toThrow();
  });

  it("rejects negative and non-finite quantities", () => {
    expect(() => decodeUsageSample({ ...usageSampleFixture, quantity: -1 })).toThrow();
    expect(() =>
      decodeUsageSample({ ...usageSampleFixture, quantity: Number.POSITIVE_INFINITY }),
    ).toThrow();
    expect(() =>
      decodeUsageSample({
        ...usageSampleFixture,
        intervalStart: "2026-08-27T12:02:00.000Z",
        intervalEnd: "2026-08-27T12:01:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects an invalid signed receipt total", () => {
    expect(() =>
      Schema.decodeUnknownSync(UsageReceipt)({
        receiptId: "receipt-1",
        workspaceId: WORKSPACE_ID,
        environmentId: "environment-1",
        sandboxId: "sandbox-1",
        threadId: "thread-1",
        infrastructureProvider: "e2b",
        sampleRange: {
          firstSampleId: "sample-1",
          lastSampleId: "sample-1",
          sampleCount: 1,
          intervalStart: NOW,
          intervalEnd: NOW,
        },
        status: "accepted",
        upstreamMicroUsdc: 1010,
        markupBasisPoints: 500,
        markupRounding: "half-up-to-nearest-micro-usdc",
        markupMicroUsdc: 50,
        totalMicroUsdc: 1060,
        txHash: RECEIPT_TX_HASH,
        signature: {
          algorithm: "ed25519",
          keyId: "usage-key-1",
          payloadHash: "sha256:invalid-receipt-payload",
          signature: "base64:signature",
          signedAt: NOW,
        },
        recordedAt: NOW,
      }),
    ).toThrow();
  });

  it("keeps rejected and duplicate receipts nonbillable and links exact usage debits", () => {
    const base = {
      receiptId: "receipt-status",
      workspaceId: WORKSPACE_ID,
      environmentId: "environment-1",
      sandboxId: "sandbox-1",
      threadId: "thread-1",
      infrastructureProvider: "e2b",
      sampleRange: {
        firstSampleId: "sample-1",
        lastSampleId: "sample-1",
        sampleCount: 1,
        intervalStart: NOW,
        intervalEnd: NOW,
      },
      signature: {
        algorithm: "ed25519",
        keyId: "usage-key-1",
        payloadHash: "sha256:status-receipt-payload",
        signature: "base64:status-signature",
        signedAt: NOW,
      },
      recordedAt: NOW,
    } as const;
    const accepted = Schema.decodeUnknownSync(UsageReceipt)({
      ...base,
      status: "accepted",
      upstreamMicroUsdc: 1000,
      markupBasisPoints: 500,
      markupRounding: "half-up-to-nearest-micro-usdc",
      markupMicroUsdc: 50,
      totalMicroUsdc: 1050,
      txHash: RECEIPT_TX_HASH,
      ledgerEntryId: "entry-status",
    });
    const entry = {
      entryId: "entry-status",
      workspaceId: WORKSPACE_ID,
      environmentId: "environment-1",
      kind: "usage",
      direction: "debit",
      amountMicroUsdc: -1050,
      sandboxId: "sandbox-1",
      threadId: "thread-1",
      usageReceiptId: "receipt-status",
      recordedAt: NOW,
    } as const;

    expect(
      Schema.decodeUnknownSync(UsageReceipt)({ ...base, status: "rejected", reason: "bad" }).status,
    ).toBe("rejected");
    expect(() =>
      Schema.decodeUnknownSync(UsageReceipt)({
        ...base,
        status: "rejected",
        reason: "bad",
        totalMicroUsdc: 1050,
        ledgerEntryId: "entry-status",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(UsageReceipt)({
        ...base,
        status: "duplicate",
        duplicateOfReceiptId: "receipt-1",
        upstreamMicroUsdc: 1000,
      }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(UsageLedgerPosting)({ receipt: accepted, entry }).entry.entryId,
    ).toBe("entry-status");
    expect(() =>
      Schema.decodeUnknownSync(UsageLedgerPosting)({
        receipt: accepted,
        entry: { ...entry, amountMicroUsdc: -1049 },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(UsageLedgerPosting)({
        receipt: accepted,
        entry: { ...entry, workspaceId: "workspace-2" },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(LedgerEntry)({ ...entry, amountMicroUsdc: 1050 }),
    ).toThrow();
  });

  it("rounds the fixed 5% markup half-up to the nearest micro-USDC", () => {
    const receipt = Schema.decodeUnknownSync(UsageReceiptAccepted)({
      receiptId: "receipt-rounding",
      workspaceId: WORKSPACE_ID,
      environmentId: "environment-1",
      sandboxId: "sandbox-1",
      threadId: "thread-1",
      infrastructureProvider: "e2b",
      sampleRange: {
        firstSampleId: "sample-1",
        lastSampleId: "sample-1",
        sampleCount: 1,
        intervalStart: NOW,
        intervalEnd: NOW,
      },
      status: "accepted",
      upstreamMicroUsdc: 1010,
      markupBasisPoints: 500,
      markupRounding: "half-up-to-nearest-micro-usdc",
      markupMicroUsdc: 51,
      totalMicroUsdc: 1061,
      txHash: RECEIPT_TX_HASH,
      signature: {
        algorithm: "ed25519",
        keyId: "usage-key-1",
        payloadHash: "sha256:rounding-receipt-payload",
        signature: "base64:rounding-signature",
        signedAt: NOW,
      },
      recordedAt: NOW,
    });

    expect(receipt.markupMicroUsdc).toBe(51);
    expect(receipt.totalMicroUsdc).toBe(1061);
  });

  it("binds settlement exactly to a non-empty accepted usage posting batch", () => {
    const receipt = {
      receiptId: "receipt-1",
      workspaceId: WORKSPACE_ID,
      environmentId: "environment-1",
      sandboxId: "sandbox-1",
      threadId: "thread-1",
      infrastructureProvider: "e2b",
      sampleRange: {
        firstSampleId: "sample-1",
        lastSampleId: "sample-1",
        sampleCount: 1,
        intervalStart: NOW,
        intervalEnd: NOW,
      },
      status: "accepted",
      upstreamMicroUsdc: 1000,
      markupBasisPoints: 500,
      markupRounding: "half-up-to-nearest-micro-usdc",
      markupMicroUsdc: 50,
      totalMicroUsdc: 1050,
      txHash: RECEIPT_TX_HASH,
      signature: receiptSignature,
      ledgerEntryId: "entry-1",
      recordedAt: NOW,
    } as const;
    const entry = {
      entryId: "entry-1",
      workspaceId: WORKSPACE_ID,
      environmentId: "environment-1",
      kind: "usage",
      direction: "debit",
      amountMicroUsdc: -1050,
      sandboxId: "sandbox-1",
      threadId: "thread-1",
      usageReceiptId: "receipt-1",
      recordedAt: NOW,
    } as const;
    const posting = { receipt, entry } as const;
    const settlement = {
      settlementId: "settlement-1",
      workspaceId: WORKSPACE_ID,
      environmentId: "environment-1",
      threadId: "thread-1",
      state: "pending",
      ...settlementAuditFields,
      usagePostings: [posting],
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: "2026-09-01T00:00:00.000Z",
      ledgerEntryIds: ["entry-1"],
      debitMicroUsdc: 1050,
      createdAt: NOW,
    } as const;
    const decodeSettlement = Schema.decodeUnknownSync(Settlement);
    const rejectedReceipt = {
      receiptId: "receipt-rejected",
      workspaceId: WORKSPACE_ID,
      environmentId: "environment-1",
      sandboxId: "sandbox-1",
      threadId: "thread-1",
      infrastructureProvider: "e2b",
      sampleRange: receipt.sampleRange,
      status: "rejected",
      reason: "invalid sample",
      signature: receiptSignature,
      recordedAt: NOW,
    } as const;
    const duplicateReceipt = {
      ...rejectedReceipt,
      receiptId: "receipt-duplicate",
      status: "duplicate",
      duplicateOfReceiptId: "receipt-1",
      reason: "already billed",
    } as const;

    expect(decodeSettlement(settlement).debitMicroUsdc).toBe(1050);
    expect(() => decodeSettlement({ ...settlement, usagePostings: [] })).toThrow();
    expect(() => decodeSettlement({ ...settlement, ledgerEntryIds: [] })).toThrow();
    expect(() =>
      decodeSettlement({
        ...settlement,
        receiptRefs: [{ ...settlement.receiptRefs[0], receiptId: "receipt-arbitrary" }],
      }),
    ).toThrow();
    expect(() =>
      decodeSettlement({
        ...settlement,
        receiptRefs: [
          {
            ...settlement.receiptRefs[0],
            signature: {
              ...settlement.receiptRefs[0].signature,
              payloadHash: "sha256:unrelated-receipt",
            },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeSettlement({ ...settlement, ledgerEntryIds: ["entry-arbitrary"] }),
    ).toThrow();
    expect(() => decodeSettlement({ ...settlement, workspaceId: "workspace-2" })).toThrow();
    expect(() => decodeSettlement({ ...settlement, environmentId: "environment-2" })).toThrow();
    expect(() => decodeSettlement({ ...settlement, threadId: "thread-2" })).toThrow();
    expect(() =>
      decodeSettlement({ ...settlement, creditMicroUsdc: 25, netMicroUsdc: 1025 }),
    ).toThrow();
    expect(() =>
      decodeSettlement({
        ...settlement,
        debitMicroUsdc: 100,
        transfer: { ...settlement.transfer, amountMicroUsdc: 100 },
      }),
    ).toThrow();
    expect(() =>
      decodeSettlement({
        ...settlement,
        usagePostings: [posting, posting],
        receiptRefs: [settlement.receiptRefs[0], settlement.receiptRefs[0]],
        ledgerEntryIds: ["entry-1", "entry-1"],
        debitMicroUsdc: 2100,
        transfer: { ...settlement.transfer, amountMicroUsdc: 2100 },
      }),
    ).toThrow();
    expect(() =>
      decodeSettlement({
        ...settlement,
        usagePostings: [{ receipt: rejectedReceipt, entry }],
      }),
    ).toThrow();
    expect(() =>
      decodeSettlement({
        ...settlement,
        usagePostings: [{ receipt: duplicateReceipt, entry }],
      }),
    ).toThrow();
  });
});

describe("cloud contract forward compatibility", () => {
  it("validates MCP transports and binds executable hashes to stdio commands", () => {
    const decodeMcp = Schema.decodeUnknownSync(PluginMcpServer);

    expect(() =>
      decodeMcp({
        name: "broken-stdio",
        transport: "stdio",
        command: "node",
        arguments: [],
        secretRefs: [],
        oauthRefs: [],
      }),
    ).toThrow();
    expect(() =>
      decodeMcp({
        name: "broken-http",
        transport: "http",
        command: "node",
        secretRefs: [],
        oauthRefs: [],
      }),
    ).toThrow();
    expect(
      decodeMcp({
        name: "valid-http",
        transport: "http",
        url: "https://mcp.example.test",
        secretRefs: [],
        oauthRefs: [],
      }).transport,
    ).toBe("http");
  });

  it("fails closed on plugin authorization versions while keeping capabilities descriptive", () => {
    const manifestFixture = {
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      pluginId: "future-plugin",
      version: "2.0.0",
      publisher: {
        publisherId: "publisher-1",
        name: "Future Tools",
        website: "https://example.test",
      },
      signature: {
        algorithm: "ed25519",
        keyId: "plugin-key-1",
        signature: "base64:plugin-signature",
        signedAt: NOW,
      },
      name: "Future plugin",
      supportedAgents: ["futureAgent"],
      mcpServers: [
        {
          name: "future-mcp",
          transport: "stdio",
          command: "node",
          arguments: ["dist/mcp.mjs"],
          executableHash: "sha256:node",
          secretRefs: ["api-token"],
          oauthRefs: ["github-oauth"],
        },
      ],
      skills: [{ name: "review", path: "skills/review.md", contentHash: "sha256:skill" }],
      rules: [{ name: "safety", path: "rules/safety.md", contentHash: "sha256:rule" }],
      commands: [
        {
          name: "review",
          command: "node",
          arguments: ["dist/review.mjs"],
          executableHash: "sha256:node",
        },
      ],
      hooks: [{ event: "thread.completed", command: "review", executableHash: "sha256:review" }],
      setup: [
        {
          name: "install",
          command: "npm",
          arguments: ["install"],
          executableHash: "sha256:npm",
          timeoutMs: 60_000,
        },
      ],
      secretRefs: [{ name: "api-token", purpose: "Call the API", optional: false }],
      oauthRefs: [
        {
          name: "github-oauth",
          provider: "github",
          scopes: ["repo:read"],
          optional: false,
        },
      ],
      permissions: [
        { type: "file", access: ["read", "write"], paths: ["/workspace"] },
        { type: "command", commands: ["git status"] },
        { type: "network", domains: ["api.example.test"] },
        { type: "external-write", services: ["github"] },
        { type: "deploy", targets: ["preview"] },
        { type: "payment", maxMicroUsdcPerOperation: 1_000_000 },
      ],
      allowedDomains: ["api.example.test"],
      compatibility: {
        minimumT3Version: "0.0.35",
        platforms: ["linux"],
        architectures: ["x64"],
        sandboxCapabilities: ["execute", "futureGpu", "files"],
      },
      verification: {
        status: "verified",
        verifier: "Agents in Cloud",
        verifiedAt: NOW,
        attestationHash: "sha256:attestation",
      },
      futureManifestField: { enabled: true },
    } as const;
    const manifest = decodePluginManifest(manifestFixture);
    const futureRevision = decodeRevision({
      ...revision,
      blueprint: {
        ...blueprint,
        schemaVersion: 2,
        providerInstances: [
          {
            instanceId: "future_agent",
            driver: "futureAgent",
          },
        ],
        futureBlueprintField: true,
      },
    });

    expect(manifest.supportedAgents).toEqual(["futureAgent"]);
    expect(manifest.permissions.map((permission) => permission.type)).toEqual([
      "file",
      "command",
      "network",
      "external-write",
      "deploy",
      "payment",
    ]);
    expect(manifest.compatibility.sandboxCapabilities).toEqual(["execute", "files"]);
    expect(futureRevision.blueprint.providerInstances[0]?.driver).toBe("futureAgent");
    expect("futureManifestField" in manifest).toBe(false);
    expect(() =>
      decodePluginManifest({
        ...manifestFixture,
        permissions: [
          ...manifestFixture.permissions,
          { type: "future-permission", scope: "future" },
        ],
      }),
    ).toThrow();
    expect(() => decodePluginManifest({ ...manifestFixture, schemaVersion: 2 })).toThrow();
    expect(() =>
      decodePluginManifest({
        ...manifestFixture,
        commands: [{ name: "review", command: "node", arguments: ["dist/review.mjs"] }],
      }),
    ).toThrow();
  });

  it("rejects agent-token and non-E2B usage sources", () => {
    expect(() =>
      decodeUsageSample({ ...usageSampleFixture, meter: "provider.tokens.input" }),
    ).toThrow();
    expect(() => decodeUsageSample({ ...usageSampleFixture, unit: "token" })).toThrow();
    expect(() =>
      decodeUsageSample({ ...usageSampleFixture, infrastructureProvider: "agent-subscription" }),
    ).toThrow();
  });
});
