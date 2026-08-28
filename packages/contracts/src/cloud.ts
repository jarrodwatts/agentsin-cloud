/**
 * Cloud control-plane contracts.
 *
 * This module is intentionally a schema-only adapter boundary. Cloud runtimes
 * consume these shapes, but provisioning, leasing, metering, and settlement
 * behavior live outside `@t3tools/contracts`.
 *
 * @module cloud
 */
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";

import {
  ApprovalRequestId,
  AuthSessionId,
  CommandId,
  EnvironmentId,
  EventId,
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  PortSchema,
  PositiveInt,
  ProjectId,
  RuntimeSessionId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { ClientActivityClientId } from "./background.ts";
import {
  ExecutionEnvironmentPlatformArch,
  ExecutionEnvironmentPlatformOs,
  RepositoryIdentity,
} from "./environment.ts";
import { OrchestrationCommand, OrchestrationEvent } from "./orchestration.ts";
import { ProviderDriverKind, ProviderInstanceRef } from "./providerInstance.ts";

const makeCloudEntityId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

/** Opaque identifier safe to use as a single filesystem path component. */
const makePathSafeCloudEntityId = <Brand extends string>(brand: Brand) =>
  Schema.String.check(
    Schema.isLengthBetween(1, 96),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  ).pipe(Schema.brand(brand));

const PkceBase64Url = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/));

/** SHA-256 PKCE challenge used to bind a desktop deep-link callback. */
export const DesktopAuthCodeChallenge = PkceBase64Url.check(Schema.isLengthBetween(43, 43));
export type DesktopAuthCodeChallenge = typeof DesktopAuthCodeChallenge.Type;

/** RFC 7636 verifier length accepted by the hosted desktop auth exchange. */
export const DesktopAuthCodeVerifier = PkceBase64Url.check(Schema.isLengthBetween(43, 128));
export type DesktopAuthCodeVerifier = typeof DesktopAuthCodeVerifier.Type;

/** Client correlation value returned unchanged after the system-browser ceremony. */
export const DesktopAuthState = PkceBase64Url.check(Schema.isLengthBetween(32, 128));
export type DesktopAuthState = typeof DesktopAuthState.Type;

export const DesktopAuthInitiateRequest = Schema.Struct({
  codeChallenge: DesktopAuthCodeChallenge,
  state: DesktopAuthState,
});
export type DesktopAuthInitiateRequest = typeof DesktopAuthInitiateRequest.Type;

export const DesktopAuthInitiateResult = Schema.Struct({
  browserUrl: Schema.String,
  expiresAt: IsoDateTime,
});
export type DesktopAuthInitiateResult = typeof DesktopAuthInitiateResult.Type;

export const DesktopAuthExchangeRequest = Schema.Struct({
  handoff: TrimmedNonEmptyString,
  codeVerifier: DesktopAuthCodeVerifier,
});
export type DesktopAuthExchangeRequest = typeof DesktopAuthExchangeRequest.Type;

export const SandboxId = makeCloudEntityId("SandboxId");
export type SandboxId = typeof SandboxId.Type;
export const SandboxSnapshotId = makeCloudEntityId("SandboxSnapshotId");
export type SandboxSnapshotId = typeof SandboxSnapshotId.Type;
export const SandboxPtyId = makeCloudEntityId("SandboxPtyId");
export type SandboxPtyId = typeof SandboxPtyId.Type;
export const DesktopLeaseId = makeCloudEntityId("DesktopLeaseId");
export type DesktopLeaseId = typeof DesktopLeaseId.Type;
export const WorkspaceId = makeCloudEntityId("WorkspaceId");
export type WorkspaceId = typeof WorkspaceId.Type;
export const EnvironmentBlueprintId = makeCloudEntityId("EnvironmentBlueprintId");
export type EnvironmentBlueprintId = typeof EnvironmentBlueprintId.Type;
export const EnvironmentRevisionId = makeCloudEntityId("EnvironmentRevisionId");
export type EnvironmentRevisionId = typeof EnvironmentRevisionId.Type;
export const AgentConnectionId = makeCloudEntityId("AgentConnectionId");
export type AgentConnectionId = typeof AgentConnectionId.Type;
export const AgentLoginId = makePathSafeCloudEntityId("AgentLoginId");
export type AgentLoginId = typeof AgentLoginId.Type;
export const AgentProfileId = makeCloudEntityId("AgentProfileId");
export type AgentProfileId = typeof AgentProfileId.Type;
export const AgentMaterializationId = makePathSafeCloudEntityId("AgentMaterializationId");
export type AgentMaterializationId = typeof AgentMaterializationId.Type;
export const PluginId = makeCloudEntityId("PluginId");
export type PluginId = typeof PluginId.Type;
export const PluginPublisherId = makeCloudEntityId("PluginPublisherId");
export type PluginPublisherId = typeof PluginPublisherId.Type;
export const PluginGrantId = makeCloudEntityId("PluginGrantId");
export type PluginGrantId = typeof PluginGrantId.Type;
export const AutomationRecipeId = makeCloudEntityId("AutomationRecipeId");
export type AutomationRecipeId = typeof AutomationRecipeId.Type;
export const AutomationRunId = makeCloudEntityId("AutomationRunId");
export type AutomationRunId = typeof AutomationRunId.Type;
export const UsageSampleId = makeCloudEntityId("UsageSampleId");
export type UsageSampleId = typeof UsageSampleId.Type;
export const UsageEvidenceId = makeCloudEntityId("UsageEvidenceId");
export type UsageEvidenceId = typeof UsageEvidenceId.Type;
export const UsageAccrualId = makeCloudEntityId("UsageAccrualId");
export type UsageAccrualId = typeof UsageAccrualId.Type;
export const UsageReceiptId = makeCloudEntityId("UsageReceiptId");
export type UsageReceiptId = typeof UsageReceiptId.Type;
export const LedgerEntryId = makeCloudEntityId("LedgerEntryId");
export type LedgerEntryId = typeof LedgerEntryId.Type;
export const SettlementId = makeCloudEntityId("SettlementId");
export type SettlementId = typeof SettlementId.Type;
export const GitHubInstallationId = makeCloudEntityId("GitHubInstallationId");
export type GitHubInstallationId = typeof GitHubInstallationId.Type;
export const GitHubWorkflowEventId = makeCloudEntityId("GitHubWorkflowEventId");
export type GitHubWorkflowEventId = typeof GitHubWorkflowEventId.Type;
export const GitHubWorkflowEffectId = makeCloudEntityId("GitHubWorkflowEffectId");
export type GitHubWorkflowEffectId = typeof GitHubWorkflowEffectId.Type;

export const EvmAddress = TrimmedNonEmptyString.check(Schema.isPattern(/^0x[0-9a-fA-F]{40}$/)).pipe(
  Schema.brand("EvmAddress"),
);
export type EvmAddress = typeof EvmAddress.Type;
export const EvmTransactionHash = TrimmedNonEmptyString.check(
  Schema.isPattern(/^0x[0-9a-fA-F]{64}$/),
).pipe(
  Schema.decode({
    decode: SchemaGetter.transform((value) => value.toLowerCase()),
    encode: SchemaGetter.transform((value) => value.toLowerCase()),
  }),
  Schema.brand("EvmTransactionHash"),
);
export type EvmTransactionHash = typeof EvmTransactionHash.Type;

export const MONAD_MAINNET_CHAIN_ID = 143 as const;
export const MONAD_MAINNET_NATIVE_USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as const;

const NonNegativeFiniteNumber = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThanOrEqualTo(0),
);

/** Fixed-point monetary value: one unit is one millionth of one USDC. */
export const MicroUsdc = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
export type MicroUsdc = typeof MicroUsdc.Type;
export const SignedMicroUsdc = Schema.Int.check(
  Schema.isBetween({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
);
export type SignedMicroUsdc = typeof SignedMicroUsdc.Type;

export const USAGE_MARKUP_BASIS_POINTS = 500 as const;
export const UsageMarkupRounding = Schema.Literal("half-up-to-nearest-micro-usdc");
export type UsageMarkupRounding = typeof UsageMarkupRounding.Type;

export const fivePercentMarkupMicroUsdc = (upstreamMicroUsdc: number) =>
  Math.floor(upstreamMicroUsdc / 20) + (upstreamMicroUsdc % 20 >= 10 ? 1 : 0);

export const EnvironmentResourceProfile = Schema.Struct({
  cpuCores: PositiveInt,
  memoryMiB: PositiveInt,
  storageMiB: PositiveInt,
});
export type EnvironmentResourceProfile = typeof EnvironmentResourceProfile.Type;

export const EnvironmentRuntime = Schema.Struct({
  name: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  contentHash: TrimmedNonEmptyString,
});
export type EnvironmentRuntime = typeof EnvironmentRuntime.Type;

export const EnvironmentPackage = Schema.Struct({
  ecosystem: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  contentHash: TrimmedNonEmptyString,
});
export type EnvironmentPackage = typeof EnvironmentPackage.Type;

export const EnvironmentPluginReference = Schema.Struct({
  pluginId: PluginId,
  version: TrimmedNonEmptyString,
  manifestHash: TrimmedNonEmptyString,
});
export type EnvironmentPluginReference = typeof EnvironmentPluginReference.Type;

export const EnvironmentVerificationCommand = Schema.Struct({
  command: TrimmedNonEmptyString,
  arguments: Schema.Array(Schema.String),
  executableHash: TrimmedNonEmptyString,
  timeoutMs: Schema.optionalKey(PositiveInt),
});
export type EnvironmentVerificationCommand = typeof EnvironmentVerificationCommand.Type;

/** A mutable authoring record. Immutable provider input is carried by a revision. */
export const EnvironmentBlueprint = Schema.Struct({
  schemaVersion: PositiveInt,
  blueprintId: EnvironmentBlueprintId,
  workspaceId: WorkspaceId,
  name: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optionalKey(RepositoryIdentity),
  checkoutRef: Schema.optionalKey(TrimmedNonEmptyString),
  image: TrimmedNonEmptyString,
  workspaceDirectory: TrimmedNonEmptyString,
  resources: EnvironmentResourceProfile,
  setupCommands: Schema.Array(TrimmedNonEmptyString),
  runtimes: Schema.Array(EnvironmentRuntime),
  packages: Schema.Array(EnvironmentPackage),
  pluginRefs: Schema.Array(EnvironmentPluginReference),
  secretRefs: Schema.Array(TrimmedNonEmptyString),
  verificationCommands: Schema.Array(EnvironmentVerificationCommand),
  providerInstances: Schema.Array(ProviderInstanceRef),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type EnvironmentBlueprint = typeof EnvironmentBlueprint.Type;

export const EnvironmentRevisionBuildStatus = Schema.Literals([
  "queued",
  "building",
  "ready",
  "failed",
  "rolledBack",
]);
export type EnvironmentRevisionBuildStatus = typeof EnvironmentRevisionBuildStatus.Type;

export const EnvironmentRevisionBuildSummary = Schema.Struct({
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  warningCount: NonNegativeInt,
  errorCount: NonNegativeInt,
  recentLines: Schema.Array(Schema.String.check(Schema.isMaxLength(500))).check(
    Schema.isMaxLength(20),
  ),
});
export type EnvironmentRevisionBuildSummary = typeof EnvironmentRevisionBuildSummary.Type;

export const R2ArtifactReference = Schema.Struct({
  storage: Schema.Literal("r2"),
  bucket: TrimmedNonEmptyString,
  objectKey: TrimmedNonEmptyString,
  contentHash: TrimmedNonEmptyString,
  sizeBytes: NonNegativeInt,
});
export type R2ArtifactReference = typeof R2ArtifactReference.Type;

export const EnvironmentRevisionBuildLogArtifact = R2ArtifactReference;
export type EnvironmentRevisionBuildLogArtifact = typeof EnvironmentRevisionBuildLogArtifact.Type;

/** An immutable snapshot passed to a sandbox provider. */
export const EnvironmentRevision = Schema.Struct({
  revisionId: EnvironmentRevisionId,
  blueprintId: EnvironmentBlueprintId,
  workspaceId: WorkspaceId,
  revision: PositiveInt,
  contentHash: TrimmedNonEmptyString,
  blueprint: EnvironmentBlueprint,
  buildStatus: EnvironmentRevisionBuildStatus,
  buildSummary: EnvironmentRevisionBuildSummary,
  buildLogArtifact: EnvironmentRevisionBuildLogArtifact,
  rollbackRevisionId: Schema.optionalKey(EnvironmentRevisionId),
  rollbackReason: Schema.optionalKey(TrimmedNonEmptyString),
  rolledBackAt: Schema.optionalKey(IsoDateTime),
  createdAt: IsoDateTime,
}).check(
  Schema.makeFilter(
    (input) =>
      (input.blueprintId === input.blueprint.blueprintId &&
        input.workspaceId === input.blueprint.workspaceId) ||
      "revision identity must match its blueprint and workspace",
    { identifier: "EnvironmentRevisionBlueprintIdentity" },
  ),
  Schema.makeFilter(
    (input) =>
      (input.buildStatus === "rolledBack"
        ? input.rollbackRevisionId !== undefined &&
          input.rollbackReason !== undefined &&
          input.rolledBackAt !== undefined
        : input.rollbackRevisionId === undefined &&
          input.rollbackReason === undefined &&
          input.rolledBackAt === undefined) ||
      "rolled-back revisions require rollback identity, reason, and time; other revisions forbid them",
    { identifier: "EnvironmentRevisionRollback" },
  ),
);
export type EnvironmentRevision = typeof EnvironmentRevision.Type;

export const DesktopLeaseState = Schema.Literals(["active", "released", "expired", "revoked"]);
export type DesktopLeaseState = typeof DesktopLeaseState.Type;

export const DesktopLeaseHolder = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("agent"),
    connectionId: AgentConnectionId,
  }),
  Schema.Struct({
    type: Schema.Literal("userClient"),
    authSessionId: AuthSessionId,
    clientId: ClientActivityClientId,
  }),
  Schema.Struct({
    type: Schema.Literal("disconnected"),
    previousHolderType: Schema.Literals(["agent", "userClient"]),
    disconnectedAt: IsoDateTime,
  }),
]);
export type DesktopLeaseHolder = typeof DesktopLeaseHolder.Type;

export const DesktopLeaseReleaseReason = Schema.Literals([
  "released",
  "heartbeatExpired",
  "holderDisconnected",
  "revoked",
  "superseded",
]);
export type DesktopLeaseReleaseReason = typeof DesktopLeaseReleaseReason.Type;

/**
 * A renewable claim held by one agent, authenticated user client, or
 * disconnected holder.
 */
export const DesktopLease = Schema.Struct({
  leaseId: DesktopLeaseId,
  workspaceId: WorkspaceId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  sandboxId: SandboxId,
  revisionId: EnvironmentRevisionId,
  holder: DesktopLeaseHolder,
  generation: PositiveInt,
  state: DesktopLeaseState,
  acquiredAt: IsoDateTime,
  renewedAt: IsoDateTime,
  heartbeatAt: IsoDateTime,
  expiresAt: IsoDateTime,
  releaseReason: Schema.optionalKey(DesktopLeaseReleaseReason),
  endedAt: Schema.optionalKey(IsoDateTime),
}).check(
  Schema.makeFilter(
    (input) =>
      ((input.state === "active"
        ? input.releaseReason === undefined && input.endedAt === undefined
        : input.releaseReason !== undefined && input.endedAt !== undefined) &&
        (input.state === "active" ||
          (input.state === "released" &&
            ["released", "holderDisconnected", "superseded"].includes(input.releaseReason!)) ||
          (input.state === "expired" && input.releaseReason === "heartbeatExpired") ||
          (input.state === "revoked" && input.releaseReason === "revoked")) &&
        input.acquiredAt <= input.renewedAt &&
        input.renewedAt <= input.heartbeatAt &&
        input.heartbeatAt <= input.expiresAt &&
        (input.endedAt === undefined || input.acquiredAt <= input.endedAt)) ||
      "lease lifecycle fields and timestamps must be consistent",
    { identifier: "DesktopLeaseLifecycle" },
  ),
);
export type DesktopLease = typeof DesktopLease.Type;

export const SandboxWorkspaceIdentity = Schema.Struct({
  workspaceId: WorkspaceId,
  projectId: ProjectId,
  threadId: ThreadId,
  repositoryIdentity: RepositoryIdentity,
  workspaceDirectory: TrimmedNonEmptyString,
});
export type SandboxWorkspaceIdentity = typeof SandboxWorkspaceIdentity.Type;

export const ThreadSandboxBinding = Schema.Struct({
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  sandboxId: SandboxId,
});
export type ThreadSandboxBinding = typeof ThreadSandboxBinding.Type;

/** Registry snapshot enforcing a one-to-one thread/sandbox assignment. */
export const ThreadSandboxBindings = Schema.Array(ThreadSandboxBinding).check(
  Schema.makeFilter(
    (bindings) =>
      (new Set(bindings.map((binding) => JSON.stringify([binding.workspaceId, binding.threadId])))
        .size === bindings.length &&
        new Set(bindings.map((binding) => binding.sandboxId)).size === bindings.length) ||
      "a thread and sandbox may each appear in only one binding",
    { identifier: "ThreadSandboxBindingsOneToOne" },
  ),
);
export type ThreadSandboxBindings = typeof ThreadSandboxBindings.Type;

export const SandboxProviderCapability = Schema.Literals([
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
]);
export type SandboxProviderCapability = typeof SandboxProviderCapability.Type;
export const SandboxProviderCapabilities = ForwardCompatibleArray(SandboxProviderCapability);
export type SandboxProviderCapabilities = typeof SandboxProviderCapabilities.Type;

const SandboxProviderRequestBaseFields = {
  requestId: CommandId,
  workspaceId: WorkspaceId,
  environmentId: EnvironmentId,
  requestedAt: IsoDateTime,
} as const;

const SandboxProviderExistingSandboxRequestFields = {
  ...SandboxProviderRequestBaseFields,
  threadId: ThreadId,
  sandboxId: SandboxId,
} as const;

export const SandboxProviderCreateRequest = Schema.Struct({
  type: Schema.Literal("create"),
  ...SandboxProviderRequestBaseFields,
  workspace: SandboxWorkspaceIdentity,
  revision: EnvironmentRevision,
})
  .check(
    Schema.makeFilter(
      (input) =>
        (input.revision.buildStatus === "ready" &&
          input.workspaceId === input.workspace.workspaceId &&
          input.workspaceId === input.revision.workspaceId &&
          input.workspace.workspaceDirectory === input.revision.blueprint.workspaceDirectory &&
          input.workspace.repositoryIdentity.canonicalKey ===
            input.revision.blueprint.repositoryIdentity?.canonicalKey) ||
        "create requires a ready revision matching the requested workspace identity",
      { identifier: "SandboxCreateWorkspaceRevisionIdentity" },
    ),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });
export type SandboxProviderCreateRequest = typeof SandboxProviderCreateRequest.Type;

export const SandboxProviderConnectRequest = Schema.Struct({
  type: Schema.Literal("connect"),
  ...SandboxProviderExistingSandboxRequestFields,
});
export type SandboxProviderConnectRequest = typeof SandboxProviderConnectRequest.Type;

export const SandboxProviderExecuteRequest = Schema.Struct({
  type: Schema.Literal("execute"),
  ...SandboxProviderExistingSandboxRequestFields,
  command: TrimmedNonEmptyString,
  arguments: Schema.Array(Schema.String),
  cwd: Schema.optionalKey(TrimmedNonEmptyString),
  environment: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  timeoutMs: Schema.optionalKey(PositiveInt),
});
export type SandboxProviderExecuteRequest = typeof SandboxProviderExecuteRequest.Type;

export const SandboxProviderFileOperation = Schema.Union([
  Schema.Struct({ type: Schema.Literal("read"), path: TrimmedNonEmptyString }),
  Schema.Struct({
    type: Schema.Literal("write"),
    path: TrimmedNonEmptyString,
    content: Schema.String,
    encoding: Schema.Literals(["utf8", "base64"]),
  }),
  Schema.Struct({ type: Schema.Literal("list"), path: TrimmedNonEmptyString }),
  Schema.Struct({
    type: Schema.Literal("remove"),
    path: TrimmedNonEmptyString,
    recursive: Schema.Boolean,
  }),
]);
export type SandboxProviderFileOperation = typeof SandboxProviderFileOperation.Type;

export const SandboxProviderFilesRequest = Schema.Struct({
  type: Schema.Literal("files"),
  ...SandboxProviderExistingSandboxRequestFields,
  operation: SandboxProviderFileOperation,
});
export type SandboxProviderFilesRequest = typeof SandboxProviderFilesRequest.Type;

export const SandboxProviderPtyOperation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("open"),
    cwd: Schema.optionalKey(TrimmedNonEmptyString),
    shell: Schema.optionalKey(TrimmedNonEmptyString),
    columns: PositiveInt,
    rows: PositiveInt,
  }),
  Schema.Struct({
    type: Schema.Literal("input"),
    ptyId: SandboxPtyId,
    data: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("resize"),
    ptyId: SandboxPtyId,
    columns: PositiveInt,
    rows: PositiveInt,
  }),
  Schema.Struct({ type: Schema.Literal("close"), ptyId: SandboxPtyId }),
]);
export type SandboxProviderPtyOperation = typeof SandboxProviderPtyOperation.Type;

export const SandboxProviderPtyRequest = Schema.Struct({
  type: Schema.Literal("pty"),
  ...SandboxProviderExistingSandboxRequestFields,
  operation: SandboxProviderPtyOperation,
});
export type SandboxProviderPtyRequest = typeof SandboxProviderPtyRequest.Type;

export const SandboxProviderPauseRequest = Schema.Struct({
  type: Schema.Literal("pause"),
  ...SandboxProviderExistingSandboxRequestFields,
});
export type SandboxProviderPauseRequest = typeof SandboxProviderPauseRequest.Type;
export const SandboxProviderResumeRequest = Schema.Struct({
  type: Schema.Literal("resume"),
  ...SandboxProviderExistingSandboxRequestFields,
});
export type SandboxProviderResumeRequest = typeof SandboxProviderResumeRequest.Type;
export const SandboxProviderDestroyRequest = Schema.Struct({
  type: Schema.Literal("destroy"),
  ...SandboxProviderExistingSandboxRequestFields,
});
export type SandboxProviderDestroyRequest = typeof SandboxProviderDestroyRequest.Type;

export const SandboxProviderSnapshotRequest = Schema.Struct({
  type: Schema.Literal("snapshot"),
  ...SandboxProviderExistingSandboxRequestFields,
  label: Schema.optionalKey(TrimmedNonEmptyString),
});
export type SandboxProviderSnapshotRequest = typeof SandboxProviderSnapshotRequest.Type;

export const SandboxProviderDesktopRequest = Schema.Struct({
  type: Schema.Literal("desktop"),
  ...SandboxProviderExistingSandboxRequestFields,
});
export type SandboxProviderDesktopRequest = typeof SandboxProviderDesktopRequest.Type;

export const SandboxProviderPortsRequest = Schema.Struct({
  type: Schema.Literal("ports"),
  ...SandboxProviderExistingSandboxRequestFields,
});
export type SandboxProviderPortsRequest = typeof SandboxProviderPortsRequest.Type;

/** Requests resource observability gauges. These values are never authoritative billing evidence. */
export const SandboxProviderUsageRequest = Schema.Struct({
  type: Schema.Literal("usage"),
  ...SandboxProviderExistingSandboxRequestFields,
  since: IsoDateTime,
  until: IsoDateTime,
}).check(
  Schema.makeFilter((input) => input.since <= input.until || "since must not be after until", {
    identifier: "SandboxProviderUsageRange",
  }),
);
export type SandboxProviderUsageRequest = typeof SandboxProviderUsageRequest.Type;

export const SandboxProviderRequest = Schema.Union([
  SandboxProviderCreateRequest,
  SandboxProviderConnectRequest,
  SandboxProviderExecuteRequest,
  SandboxProviderFilesRequest,
  SandboxProviderPtyRequest,
  SandboxProviderPauseRequest,
  SandboxProviderResumeRequest,
  SandboxProviderSnapshotRequest,
  SandboxProviderDesktopRequest,
  SandboxProviderPortsRequest,
  SandboxProviderUsageRequest,
  SandboxProviderDestroyRequest,
]);
export type SandboxProviderRequest = typeof SandboxProviderRequest.Type;

export const SandboxProviderState = Schema.Literals([
  "provisioning",
  "ready",
  "suspended",
  "destroying",
  "destroyed",
  "failed",
]);
export type SandboxProviderState = typeof SandboxProviderState.Type;

export const SandboxProviderSandbox = Schema.Struct({
  sandboxId: SandboxId,
  workspaceId: WorkspaceId,
  environmentId: EnvironmentId,
  infrastructureProvider: Schema.Literal("e2b"),
  workspace: SandboxWorkspaceIdentity,
  binding: ThreadSandboxBinding,
  revisionId: EnvironmentRevisionId,
  providerHandle: TrimmedNonEmptyString,
  state: SandboxProviderState,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).check(
  Schema.makeFilter(
    (input) =>
      (input.binding.sandboxId === input.sandboxId &&
        input.workspaceId === input.workspace.workspaceId &&
        input.binding.workspaceId === input.workspaceId &&
        input.binding.threadId === input.workspace.threadId) ||
      "binding must associate this sandbox with exactly its workspace thread",
    { identifier: "ThreadSandboxBindingIdentity" },
  ),
);
export type SandboxProviderSandbox = typeof SandboxProviderSandbox.Type;

const sandboxResultWorkspaceIdentity = Schema.makeFilter(
  (input: { readonly workspaceId: WorkspaceId; readonly sandbox: SandboxProviderSandbox }) =>
    input.workspaceId === input.sandbox.workspaceId ||
    "result workspaceId must match the returned sandbox",
  { identifier: "SandboxResultWorkspaceIdentity" },
);

const SandboxProviderSandboxResultFields = {
  requestId: CommandId,
  workspaceId: WorkspaceId,
  sandbox: SandboxProviderSandbox,
  completedAt: IsoDateTime,
} as const;

export const SandboxProviderCreateResult = Schema.Struct({
  type: Schema.Literal("created"),
  ...SandboxProviderSandboxResultFields,
}).check(sandboxResultWorkspaceIdentity);
export type SandboxProviderCreateResult = typeof SandboxProviderCreateResult.Type;

export const SandboxProviderConnection = Schema.Struct({
  transport: Schema.Literals(["ssh", "websocket", "http"]),
  endpoint: TrimmedNonEmptyString,
  credentialRef: Schema.optionalKey(TrimmedNonEmptyString),
  expiresAt: Schema.optionalKey(IsoDateTime),
});
export type SandboxProviderConnection = typeof SandboxProviderConnection.Type;

export const SandboxProviderConnectResult = Schema.Struct({
  type: Schema.Literal("connected"),
  requestId: CommandId,
  workspaceId: WorkspaceId,
  sandboxId: SandboxId,
  connection: SandboxProviderConnection,
  completedAt: IsoDateTime,
});
export type SandboxProviderConnectResult = typeof SandboxProviderConnectResult.Type;

export const SandboxProviderOutputSummary = Schema.String.check(Schema.isMaxLength(4096));
export type SandboxProviderOutputSummary = typeof SandboxProviderOutputSummary.Type;

export const SandboxProviderExecuteResult = Schema.Struct({
  type: Schema.Literal("executed"),
  requestId: CommandId,
  workspaceId: WorkspaceId,
  sandboxId: SandboxId,
  exitCode: Schema.Int,
  signal: Schema.optionalKey(TrimmedNonEmptyString),
  stdoutSummary: SandboxProviderOutputSummary,
  stderrSummary: SandboxProviderOutputSummary,
  stdoutArtifact: R2ArtifactReference,
  stderrArtifact: R2ArtifactReference,
  startedAt: IsoDateTime,
  completedAt: IsoDateTime,
}).check(
  Schema.makeFilter(
    (input) => input.startedAt <= input.completedAt || "startedAt must not follow completedAt",
    { identifier: "SandboxProviderExecuteTimeRange" },
  ),
);
export type SandboxProviderExecuteResult = typeof SandboxProviderExecuteResult.Type;

export const SandboxProviderFileEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  type: Schema.Literals(["file", "directory", "symlink"]),
  sizeBytes: NonNegativeInt,
  contentHash: Schema.optionalKey(TrimmedNonEmptyString),
});
export type SandboxProviderFileEntry = typeof SandboxProviderFileEntry.Type;

export const SandboxProviderFileOperationResult = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("read"),
    path: TrimmedNonEmptyString,
    content: Schema.String,
    encoding: Schema.Literals(["utf8", "base64"]),
    contentHash: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("list"),
    path: TrimmedNonEmptyString,
    entries: Schema.Array(SandboxProviderFileEntry),
  }),
  Schema.Struct({
    type: Schema.Literals(["write", "remove"]),
    path: TrimmedNonEmptyString,
  }),
]);
export type SandboxProviderFileOperationResult = typeof SandboxProviderFileOperationResult.Type;

export const SandboxProviderFilesResult = Schema.Struct({
  type: Schema.Literal("files"),
  requestId: CommandId,
  workspaceId: WorkspaceId,
  sandboxId: SandboxId,
  result: SandboxProviderFileOperationResult,
  completedAt: IsoDateTime,
});
export type SandboxProviderFilesResult = typeof SandboxProviderFilesResult.Type;

export const SandboxProviderPtyResult = Schema.Struct({
  type: Schema.Literal("pty"),
  requestId: CommandId,
  workspaceId: WorkspaceId,
  sandboxId: SandboxId,
  ptyId: SandboxPtyId,
  state: Schema.Literals(["open", "closed"]),
  outputSummary: Schema.optionalKey(SandboxProviderOutputSummary),
  outputArtifact: Schema.optionalKey(R2ArtifactReference),
  completedAt: IsoDateTime,
}).check(
  Schema.makeFilter(
    (input) =>
      (input.outputSummary === undefined && input.outputArtifact === undefined) ||
      (input.outputSummary !== undefined && input.outputArtifact !== undefined) ||
      "PTY output summaries and R2 artifacts must be present together",
    { identifier: "SandboxProviderPtyOutputArtifact" },
  ),
);
export type SandboxProviderPtyResult = typeof SandboxProviderPtyResult.Type;

export const SandboxProviderPauseResult = Schema.Struct({
  type: Schema.Literal("paused"),
  ...SandboxProviderSandboxResultFields,
}).check(sandboxResultWorkspaceIdentity);
export type SandboxProviderPauseResult = typeof SandboxProviderPauseResult.Type;

export const SandboxProviderResumeResult = Schema.Struct({
  type: Schema.Literal("resumed"),
  ...SandboxProviderSandboxResultFields,
}).check(sandboxResultWorkspaceIdentity);
export type SandboxProviderResumeResult = typeof SandboxProviderResumeResult.Type;

export const SandboxProviderSnapshot = Schema.Struct({
  snapshotId: SandboxSnapshotId,
  workspaceId: WorkspaceId,
  sandboxId: SandboxId,
  revisionId: EnvironmentRevisionId,
  label: Schema.optionalKey(TrimmedNonEmptyString),
  contentHash: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type SandboxProviderSnapshot = typeof SandboxProviderSnapshot.Type;

export const SandboxProviderSnapshotResult = Schema.Struct({
  type: Schema.Literal("snapshotted"),
  requestId: CommandId,
  workspaceId: WorkspaceId,
  sandbox: SandboxProviderSandbox,
  snapshot: SandboxProviderSnapshot,
  completedAt: IsoDateTime,
}).check(
  sandboxResultWorkspaceIdentity,
  Schema.makeFilter(
    (input) =>
      input.workspaceId === input.snapshot.workspaceId ||
      "result workspaceId must match the returned snapshot",
    { identifier: "SandboxSnapshotResultWorkspaceIdentity" },
  ),
);
export type SandboxProviderSnapshotResult = typeof SandboxProviderSnapshotResult.Type;

export const SandboxProviderDesktopResult = Schema.Struct({
  type: Schema.Literal("desktop"),
  requestId: CommandId,
  workspaceId: WorkspaceId,
  sandboxId: SandboxId,
  endpoint: TrimmedNonEmptyString,
  credentialRef: Schema.optionalKey(TrimmedNonEmptyString),
  expiresAt: Schema.optionalKey(IsoDateTime),
  completedAt: IsoDateTime,
});
export type SandboxProviderDesktopResult = typeof SandboxProviderDesktopResult.Type;

export const SandboxProviderPort = Schema.Struct({
  internalPort: PortSchema,
  exposedPort: Schema.optionalKey(PortSchema),
  protocol: Schema.Literals(["http", "https", "tcp", "udp"]),
  visibility: Schema.Literals(["private", "authenticated", "public"]),
  endpoint: Schema.optionalKey(TrimmedNonEmptyString),
});
export type SandboxProviderPort = typeof SandboxProviderPort.Type;

export const SandboxProviderPortsResult = Schema.Struct({
  type: Schema.Literal("ports"),
  requestId: CommandId,
  workspaceId: WorkspaceId,
  sandboxId: SandboxId,
  ports: Schema.Array(SandboxProviderPort),
  completedAt: IsoDateTime,
});
export type SandboxProviderPortsResult = typeof SandboxProviderPortsResult.Type;

/** Non-billable resource observability measurement. */
export const SandboxProviderUsageMeasurement = Schema.Struct({
  meter: TrimmedNonEmptyString,
  quantity: NonNegativeFiniteNumber,
  unit: TrimmedNonEmptyString,
  intervalStart: IsoDateTime,
  intervalEnd: IsoDateTime,
}).check(
  Schema.makeFilter(
    (input) =>
      input.intervalStart <= input.intervalEnd || "intervalStart must not follow intervalEnd",
    { identifier: "SandboxProviderUsageMeasurementRange" },
  ),
);
export type SandboxProviderUsageMeasurement = typeof SandboxProviderUsageMeasurement.Type;

export const SandboxProviderUsageResult = Schema.Struct({
  type: Schema.Literal("usage"),
  requestId: CommandId,
  workspaceId: WorkspaceId,
  sandboxId: SandboxId,
  measurements: Schema.Array(SandboxProviderUsageMeasurement),
  completedAt: IsoDateTime,
});
export type SandboxProviderUsageResult = typeof SandboxProviderUsageResult.Type;

export const CloudThreadLifecycleState = Schema.Literals([
  "reserved",
  "create_dispatched",
  "sandbox_ready",
  "bootstrap_dispatched",
  "bootstrap_ready",
  "worker_start_dispatched",
  "ready",
  "cleanup_required",
  "failed",
]);
export type CloudThreadLifecycleState = typeof CloudThreadLifecycleState.Type;

/** Authenticated hosted request. Workspace authority and provider driver are server-derived. */
export const CreateCloudThreadRequest = Schema.Struct({
  requestId: CommandId,
  idempotencyKey: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  threadId: ThreadId,
  environmentId: EnvironmentId,
  environmentRevisionId: EnvironmentRevisionId,
  projectId: ProjectId,
  providerInstanceId: ProviderInstanceRef.fields.instanceId,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type CreateCloudThreadRequest = typeof CreateCloudThreadRequest.Type;

export const CloudThreadLifecycleView = Schema.Struct({
  threadId: ThreadId,
  environmentId: EnvironmentId,
  environmentRevisionId: EnvironmentRevisionId,
  state: CloudThreadLifecycleState,
  sandboxId: Schema.optionalKey(SandboxId),
  workerId: Schema.optionalKey(TrimmedNonEmptyString),
  failureCode: Schema.optionalKey(TrimmedNonEmptyString),
  replayCursor: Schema.Int,
});
export type CloudThreadLifecycleView = typeof CloudThreadLifecycleView.Type;

export const SandboxProviderDestroyResult = Schema.Struct({
  type: Schema.Literal("destroyed"),
  requestId: CommandId,
  workspaceId: WorkspaceId,
  environmentId: EnvironmentId,
  sandboxId: SandboxId,
  completedAt: IsoDateTime,
});
export type SandboxProviderDestroyResult = typeof SandboxProviderDestroyResult.Type;

export const SandboxProviderResult = Schema.Union([
  SandboxProviderCreateResult,
  SandboxProviderConnectResult,
  SandboxProviderExecuteResult,
  SandboxProviderFilesResult,
  SandboxProviderPtyResult,
  SandboxProviderPauseResult,
  SandboxProviderResumeResult,
  SandboxProviderSnapshotResult,
  SandboxProviderDesktopResult,
  SandboxProviderPortsResult,
  SandboxProviderUsageResult,
  SandboxProviderDestroyResult,
]);
export type SandboxProviderResult = typeof SandboxProviderResult.Type;

export const SandboxProviderError = Schema.Struct({
  code: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  retryable: Schema.Boolean,
  details: Schema.optionalKey(Schema.Unknown),
});
export type SandboxProviderError = typeof SandboxProviderError.Type;

/** Provider implementations satisfy this port in their own runtime package. */
export interface SandboxProvider {
  readonly capabilities: SandboxProviderCapabilities;
  readonly create: (
    request: SandboxProviderCreateRequest,
  ) => Effect.Effect<SandboxProviderCreateResult, SandboxProviderError>;
  readonly connect: (
    request: SandboxProviderConnectRequest,
  ) => Effect.Effect<SandboxProviderConnectResult, SandboxProviderError>;
  readonly execute: (
    request: SandboxProviderExecuteRequest,
  ) => Effect.Effect<SandboxProviderExecuteResult, SandboxProviderError>;
  readonly files: (
    request: SandboxProviderFilesRequest,
  ) => Effect.Effect<SandboxProviderFilesResult, SandboxProviderError>;
  readonly pty: (
    request: SandboxProviderPtyRequest,
  ) => Effect.Effect<SandboxProviderPtyResult, SandboxProviderError>;
  readonly pause: (
    request: SandboxProviderPauseRequest,
  ) => Effect.Effect<SandboxProviderPauseResult, SandboxProviderError>;
  readonly resume: (
    request: SandboxProviderResumeRequest,
  ) => Effect.Effect<SandboxProviderResumeResult, SandboxProviderError>;
  readonly snapshot: (
    request: SandboxProviderSnapshotRequest,
  ) => Effect.Effect<SandboxProviderSnapshotResult, SandboxProviderError>;
  readonly desktop: (
    request: SandboxProviderDesktopRequest,
  ) => Effect.Effect<SandboxProviderDesktopResult, SandboxProviderError>;
  readonly ports: (
    request: SandboxProviderPortsRequest,
  ) => Effect.Effect<SandboxProviderPortsResult, SandboxProviderError>;
  readonly usage: (
    request: SandboxProviderUsageRequest,
  ) => Effect.Effect<SandboxProviderUsageResult, SandboxProviderError>;
  readonly destroy: (
    request: SandboxProviderDestroyRequest,
  ) => Effect.Effect<SandboxProviderDestroyResult, SandboxProviderError>;
}

/** Cloud routing envelope around the canonical orchestration command schema. */
export const CloudThreadCommand = Schema.Struct({
  schemaVersion: PositiveInt,
  workspaceId: WorkspaceId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  leaseId: Schema.optionalKey(DesktopLeaseId),
  command: OrchestrationCommand,
  enqueuedAt: IsoDateTime,
}).check(
  Schema.makeFilter(
    (input) =>
      (input.command.type.startsWith("thread.") &&
        "threadId" in input.command &&
        input.command.threadId === input.threadId) ||
      "command must be a thread command for the envelope threadId",
    { identifier: "CloudThreadCommandIdentity" },
  ),
);
export type CloudThreadCommand = typeof CloudThreadCommand.Type;

/** Cloud delivery envelope around the canonical orchestration event schema. */
export const CloudThreadEvent = Schema.Struct({
  schemaVersion: PositiveInt,
  workspaceId: WorkspaceId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  event: OrchestrationEvent,
  receivedAt: IsoDateTime,
}).check(
  Schema.makeFilter(
    (input) =>
      (input.event.aggregateKind === "thread" &&
        input.event.aggregateId === input.threadId &&
        input.event.type.startsWith("thread.")) ||
      "event must be a thread event for the envelope threadId",
    { identifier: "CloudThreadEventIdentity" },
  ),
);
export type CloudThreadEvent = typeof CloudThreadEvent.Type;

/** Wire version for the hosted desktop command and event-stream endpoints. */
export const CLOUD_DESKTOP_RPC_VERSION = 1 as const;

const CloudRpcIdempotencyKey = TrimmedNonEmptyString.check(Schema.isMaxLength(256));

/**
 * HTTPS request for an idempotent thread command. The control plane derives
 * the authenticated workspace and rejects an envelope for any other tenant.
 */
export const CloudThreadCommandSubmissionRequest = Schema.Struct({
  protocolVersion: Schema.Literal(CLOUD_DESKTOP_RPC_VERSION),
  idempotencyKey: CloudRpcIdempotencyKey,
  envelope: CloudThreadCommand,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type CloudThreadCommandSubmissionRequest = typeof CloudThreadCommandSubmissionRequest.Type;

export const CloudThreadCommandSubmissionResult = Schema.Struct({
  protocolVersion: Schema.Literal(CLOUD_DESKTOP_RPC_VERSION),
  disposition: Schema.Literals(["accepted", "duplicate"]),
  commandId: CommandId,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type CloudThreadCommandSubmissionResult = typeof CloudThreadCommandSubmissionResult.Type;

const GitHubOwnerOrRepositoryName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(100),
  Schema.isPattern(/^[A-Za-z0-9_.-]+$/),
);
export const GitObjectSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));
export type GitObjectSha = typeof GitObjectSha.Type;
export const GitHubThreadBranchName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^agents\/[a-z0-9][a-z0-9/_-]*-[0-9a-f]{12}$/),
);
export type GitHubThreadBranchName = typeof GitHubThreadBranchName.Type;

/** GitHub.com is the only source-control host supported by hosted v1. */
export const GitHubRepositoryRef = Schema.Struct({
  provider: Schema.Literal("github"),
  host: Schema.Literal("github.com"),
  installationId: GitHubInstallationId,
  owner: GitHubOwnerOrRepositoryName,
  name: GitHubOwnerOrRepositoryName,
  canonicalKey: TrimmedNonEmptyString.check(
    Schema.isMaxLength(240),
    Schema.isPattern(/^github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  ),
}).check(
  Schema.makeFilter(
    (input) =>
      input.canonicalKey.toLowerCase() ===
        `github.com/${input.owner}/${input.name}`.toLowerCase() ||
      "canonicalKey must identify the GitHub owner and repository",
    { identifier: "GitHubRepositoryCanonicalIdentity" },
  ),
);
export type GitHubRepositoryRef = typeof GitHubRepositoryRef.Type;

export const GitHubWorkflowAction = Schema.Literals([
  "createBranch",
  "pushCheckpoint",
  "openDraftPullRequest",
  "markPullRequestReady",
]);
export type GitHubWorkflowAction = typeof GitHubWorkflowAction.Type;

/** A bounded, expiring authorization for hosted GitHub external writes. */
export const GitHubWorkflowApproval = Schema.Struct({
  approvalId: ApprovalRequestId,
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  repository: GitHubRepositoryRef,
  actions: Schema.Array(GitHubWorkflowAction).check(Schema.isMinLength(1)),
  decidedByUserId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  decidedBy: AuthSessionId,
  approvedAt: IsoDateTime,
  expiresAt: IsoDateTime,
}).check(
  Schema.makeFilter(
    (input) => input.approvedAt < input.expiresAt || "approval must expire after it is granted",
    { identifier: "GitHubWorkflowApprovalLifetime" },
  ),
);
export type GitHubWorkflowApproval = typeof GitHubWorkflowApproval.Type;

const GitHubWorkflowCommandBaseFields = {
  commandId: CommandId,
  workspaceId: WorkspaceId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  repository: GitHubRepositoryRef,
  approvalId: ApprovalRequestId,
  requestedAt: IsoDateTime,
} as const;

export const GitHubThreadWorkflowCommand = Schema.Union([
  Schema.Struct({
    ...GitHubWorkflowCommandBaseFields,
    type: Schema.Literal("github.branch.create"),
    threadSlug: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
    baseSha: GitObjectSha,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    ...GitHubWorkflowCommandBaseFields,
    type: Schema.Literal("github.checkpoint.push"),
    message: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    ...GitHubWorkflowCommandBaseFields,
    type: Schema.Literal("github.pull-request.open-draft"),
    title: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
    body: Schema.String.check(Schema.isMaxLength(65_536)),
    baseBranch: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    ...GitHubWorkflowCommandBaseFields,
    type: Schema.Literal("github.pull-request.mark-ready"),
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
]);
export type GitHubThreadWorkflowCommand = typeof GitHubThreadWorkflowCommand.Type;

export const GitHubThreadWorkflowSubmissionRequest = Schema.Struct({
  idempotencyKey: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  command: GitHubThreadWorkflowCommand,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type GitHubThreadWorkflowSubmissionRequest =
  typeof GitHubThreadWorkflowSubmissionRequest.Type;

export const GitHubThreadWorkflowEvent = Schema.Struct({
  eventId: GitHubWorkflowEventId,
  workspaceId: WorkspaceId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  sequence: NonNegativeInt,
  type: Schema.Literals([
    "github.branch-created",
    "github.checkpoint-pushed",
    "github.pull-request-opened",
    "github.pull-request-ready",
    "github.conflict",
    "github.operation-failed",
  ]),
  visible: Schema.Literal(true),
  summary: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  retryable: Schema.Boolean,
  payload: Schema.Record(Schema.String, Schema.Unknown),
  occurredAt: IsoDateTime,
});
export type GitHubThreadWorkflowEvent = typeof GitHubThreadWorkflowEvent.Type;

export const GitHubThreadWorkflowView = Schema.Struct({
  workspaceId: WorkspaceId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  repository: GitHubRepositoryRef,
  baseSha: GitObjectSha,
  branchName: GitHubThreadBranchName,
  remoteHeadSha: Schema.NullOr(GitObjectSha),
  status: Schema.Literals(["active", "paused-conflict"]),
  checkpointCount: NonNegativeInt,
  pullRequest: Schema.NullOr(
    Schema.Struct({
      number: PositiveInt,
      url: TrimmedNonEmptyString,
      draft: Schema.Boolean,
    }),
  ),
  events: Schema.Array(GitHubThreadWorkflowEvent),
});
export type GitHubThreadWorkflowView = typeof GitHubThreadWorkflowView.Type;

/** -1 means no event has been observed yet; otherwise this is the last sequence received. */
export const CloudThreadEventCursor = Schema.Int.check(
  Schema.isBetween({ minimum: -1, maximum: Number.MAX_SAFE_INTEGER }),
);
export type CloudThreadEventCursor = typeof CloudThreadEventCursor.Type;

export const CloudThreadStreamSubscribe = Schema.Struct({
  protocolVersion: Schema.Literal(CLOUD_DESKTOP_RPC_VERSION),
  type: Schema.Literal("subscribe"),
  threadId: ThreadId,
  afterSequence: CloudThreadEventCursor,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type CloudThreadStreamSubscribe = typeof CloudThreadStreamSubscribe.Type;

export const CloudThreadStreamHeartbeatAck = Schema.Struct({
  protocolVersion: Schema.Literal(CLOUD_DESKTOP_RPC_VERSION),
  type: Schema.Literal("heartbeatAck"),
  nonce: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type CloudThreadStreamHeartbeatAck = typeof CloudThreadStreamHeartbeatAck.Type;

export const CloudThreadStreamClientFrame = Schema.Union([
  CloudThreadStreamSubscribe,
  CloudThreadStreamHeartbeatAck,
]);
export type CloudThreadStreamClientFrame = typeof CloudThreadStreamClientFrame.Type;

export const CloudThreadStreamErrorCode = Schema.Literals([
  "unauthorized",
  "forbidden",
  "invalidRequest",
  "notFound",
  "replayGap",
  "slowConsumer",
  "connectionLimit",
  "internalError",
]);
export type CloudThreadStreamErrorCode = typeof CloudThreadStreamErrorCode.Type;

export const CloudThreadStreamServerFrame = Schema.Union([
  Schema.Struct({
    protocolVersion: Schema.Literal(CLOUD_DESKTOP_RPC_VERSION),
    type: Schema.Literal("subscribed"),
    threadId: ThreadId,
    afterSequence: CloudThreadEventCursor,
  }),
  Schema.Struct({
    protocolVersion: Schema.Literal(CLOUD_DESKTOP_RPC_VERSION),
    type: Schema.Literal("event"),
    event: CloudThreadEvent,
  }),
  Schema.Struct({
    protocolVersion: Schema.Literal(CLOUD_DESKTOP_RPC_VERSION),
    type: Schema.Literal("caughtUp"),
    threadId: ThreadId,
    lastSequence: CloudThreadEventCursor,
  }),
  Schema.Struct({
    protocolVersion: Schema.Literal(CLOUD_DESKTOP_RPC_VERSION),
    type: Schema.Literal("heartbeat"),
    nonce: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
    sentAt: IsoDateTime,
  }),
  Schema.Struct({
    protocolVersion: Schema.Literal(CLOUD_DESKTOP_RPC_VERSION),
    type: Schema.Literal("error"),
    code: CloudThreadStreamErrorCode,
    retryable: Schema.Boolean,
  }),
]);
export type CloudThreadStreamServerFrame = typeof CloudThreadStreamServerFrame.Type;

const AgentConnectionAdapterRequestFields = {
  requestId: CommandId,
  workspaceId: WorkspaceId,
  requestedAt: IsoDateTime,
} as const;

export const AgentConnectionBeginLoginRequest = Schema.Struct({
  ...AgentConnectionAdapterRequestFields,
  provider: ProviderInstanceRef,
  callbackUrl: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AgentConnectionBeginLoginRequest = typeof AgentConnectionBeginLoginRequest.Type;

export const AgentConnectionLoginMethod = Schema.Literals(["browser", "deviceCode"]);
export type AgentConnectionLoginMethod = typeof AgentConnectionLoginMethod.Type;

const AgentConnectionPublicHttpsUrl = TrimmedNonEmptyString.check(
  Schema.isMaxLength(2_048),
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.username === "" && url.password === ""
        ? true
        : "provider authorization URLs must use HTTPS without embedded credentials";
    } catch {
      return "provider authorization URLs must be valid URLs";
    }
  }),
);

/** Sanitized login progress that is safe to relay to authenticated clients. */
export const AgentConnectionLoginEvent = Schema.Union([
  Schema.Struct({
    sequence: NonNegativeInt,
    occurredAt: IsoDateTime,
    type: Schema.Literal("authorizationUrl"),
    authorizationUrl: AgentConnectionPublicHttpsUrl,
  }),
  Schema.Struct({
    sequence: NonNegativeInt,
    occurredAt: IsoDateTime,
    type: Schema.Literal("deviceCode"),
    verificationUrl: AgentConnectionPublicHttpsUrl,
    userCode: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  }),
  Schema.Struct({
    sequence: NonNegativeInt,
    occurredAt: IsoDateTime,
    type: Schema.Literal("status"),
    status: Schema.Literals(["started", "waiting", "authorized", "denied", "expired", "failed"]),
  }),
]);
export type AgentConnectionLoginEvent = typeof AgentConnectionLoginEvent.Type;

export const AgentConnectionLoginEvents = Schema.Array(AgentConnectionLoginEvent).check(
  Schema.isMaxLength(64),
  Schema.makeFilter(
    (events) =>
      events.every(
        (event, index) => index === 0 || event.sequence === events[index - 1]!.sequence + 1,
      ) || "provider login event sequences must be contiguous and increasing",
    { identifier: "AgentConnectionLoginEventsSequence" },
  ),
);
export type AgentConnectionLoginEvents = typeof AgentConnectionLoginEvents.Type;

export const AgentConnectionBeginLoginResult = Schema.Struct({
  loginId: AgentLoginId,
  profileId: AgentProfileId,
  workspaceId: WorkspaceId,
  provider: ProviderInstanceRef,
  method: AgentConnectionLoginMethod,
  events: AgentConnectionLoginEvents,
  expiresAt: IsoDateTime,
  pollAfterMs: PositiveInt,
});
export type AgentConnectionBeginLoginResult = typeof AgentConnectionBeginLoginResult.Type;

export const AgentConnectionPollLoginRequest = Schema.Struct({
  ...AgentConnectionAdapterRequestFields,
  loginId: AgentLoginId,
});
export type AgentConnectionPollLoginRequest = typeof AgentConnectionPollLoginRequest.Type;

export const AgentConnectionPollLoginResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("pending"),
    loginId: AgentLoginId,
    profileId: AgentProfileId,
    workspaceId: WorkspaceId,
    pollAfterMs: PositiveInt,
    events: AgentConnectionLoginEvents,
  }),
  Schema.Struct({
    status: Schema.Literal("authorized"),
    loginId: AgentLoginId,
    profileId: AgentProfileId,
    workspaceId: WorkspaceId,
    accountLabel: Schema.optionalKey(TrimmedNonEmptyString),
    events: AgentConnectionLoginEvents,
  }),
  Schema.Struct({
    status: Schema.Literals(["denied", "expired", "failed"]),
    loginId: AgentLoginId,
    profileId: AgentProfileId,
    workspaceId: WorkspaceId,
    reason: Schema.optionalKey(TrimmedNonEmptyString),
    events: AgentConnectionLoginEvents,
  }),
]);
export type AgentConnectionPollLoginResult = typeof AgentConnectionPollLoginResult.Type;

export const AgentProfileState = Schema.Literals(["active", "expired", "revoked"]);
export type AgentProfileState = typeof AgentProfileState.Type;

export const AgentConnectionProfile = Schema.Struct({
  profileId: AgentProfileId,
  workspaceId: WorkspaceId,
  provider: ProviderInstanceRef,
  label: TrimmedNonEmptyString,
  state: AgentProfileState,
  keyVersion: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  expiresAt: Schema.optionalKey(IsoDateTime),
});
export type AgentConnectionProfile = typeof AgentConnectionProfile.Type;

export const AgentConnectionSealProfileRequest = Schema.Struct({
  ...AgentConnectionAdapterRequestFields,
  loginId: AgentLoginId,
  provider: ProviderInstanceRef,
  profileId: AgentProfileId,
  idempotencyKey: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  label: TrimmedNonEmptyString,
});
export type AgentConnectionSealProfileRequest = typeof AgentConnectionSealProfileRequest.Type;

export const AgentConnectionSealProfileResult = Schema.Struct({
  workspaceId: WorkspaceId,
  profile: AgentConnectionProfile,
}).check(
  Schema.makeFilter(
    (input) =>
      input.workspaceId === input.profile.workspaceId ||
      "seal-profile result must match its profile workspace",
    { identifier: "AgentConnectionSealProfileWorkspace" },
  ),
);
export type AgentConnectionSealProfileResult = typeof AgentConnectionSealProfileResult.Type;

/** Short-lived user authorization for one active thread sandbox target. */
export const AgentProfileMaterializationAuthorization = Schema.Struct({
  workspaceId: WorkspaceId,
  authSessionId: AuthSessionId,
  threadId: ThreadId,
  environmentId: EnvironmentId,
  sandboxId: SandboxId,
  provider: ProviderInstanceRef,
  authorizedAt: IsoDateTime,
  expiresAt: IsoDateTime,
}).check(
  Schema.makeFilter(
    (input) => input.authorizedAt < input.expiresAt || "materialization authorization must expire",
    { identifier: "AgentProfileMaterializationAuthorizationLifetime" },
  ),
);
export type AgentProfileMaterializationAuthorization =
  typeof AgentProfileMaterializationAuthorization.Type;

export const AgentConnectionMaterializeRequest = Schema.Struct({
  ...AgentConnectionAdapterRequestFields,
  profileId: AgentProfileId,
  authorization: AgentProfileMaterializationAuthorization,
  targetPath: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
}).check(
  Schema.makeFilter(
    (input) =>
      input.workspaceId === input.authorization.workspaceId ||
      "materialization request must match its authorization workspace",
    { identifier: "AgentConnectionMaterializeRequestWorkspace" },
  ),
);
export type AgentConnectionMaterializeRequest = typeof AgentConnectionMaterializeRequest.Type;

export const AgentConnectionMaterializeResult = Schema.Struct({
  materializationId: AgentMaterializationId,
  profileId: AgentProfileId,
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  environmentId: EnvironmentId,
  sandboxId: SandboxId,
  materializationRef: TrimmedNonEmptyString,
  materializedAt: IsoDateTime,
  expiresAt: Schema.optionalKey(IsoDateTime),
});
export type AgentConnectionMaterializeResult = typeof AgentConnectionMaterializeResult.Type;

export const AgentConnectionValidateRequest = Schema.Struct({
  ...AgentConnectionAdapterRequestFields,
  profileId: AgentProfileId,
});
export type AgentConnectionValidateRequest = typeof AgentConnectionValidateRequest.Type;

export const AgentConnectionValidateResult = Schema.Struct({
  profileId: AgentProfileId,
  workspaceId: WorkspaceId,
  status: Schema.Literals(["valid", "invalid", "expired", "revoked"]),
  checkedAt: IsoDateTime,
  reason: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AgentConnectionValidateResult = typeof AgentConnectionValidateResult.Type;

export const AgentConnectionRefreshRequest = Schema.Struct({
  ...AgentConnectionAdapterRequestFields,
  profileId: AgentProfileId,
});
export type AgentConnectionRefreshRequest = typeof AgentConnectionRefreshRequest.Type;

export const AgentConnectionRefreshResult = Schema.Struct({
  workspaceId: WorkspaceId,
  profile: AgentConnectionProfile,
  refreshedAt: IsoDateTime,
}).check(
  Schema.makeFilter(
    (input) =>
      input.workspaceId === input.profile.workspaceId ||
      "refresh result must match its profile workspace",
    { identifier: "AgentConnectionRefreshWorkspace" },
  ),
);
export type AgentConnectionRefreshResult = typeof AgentConnectionRefreshResult.Type;

export const AgentConnectionRevokeRequest = Schema.Struct({
  ...AgentConnectionAdapterRequestFields,
  profileId: AgentProfileId,
});
export type AgentConnectionRevokeRequest = typeof AgentConnectionRevokeRequest.Type;

export const AgentConnectionRevokeResult = Schema.Struct({
  profileId: AgentProfileId,
  workspaceId: WorkspaceId,
  revokedAt: IsoDateTime,
});
export type AgentConnectionRevokeResult = typeof AgentConnectionRevokeResult.Type;

export const AgentConnectionAdapterError = Schema.Struct({
  workspaceId: WorkspaceId,
  code: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  retryable: Schema.Boolean,
  details: Schema.optionalKey(Schema.Unknown),
});
export type AgentConnectionAdapterError = typeof AgentConnectionAdapterError.Type;

const agentAdapterExchangeWorkspace = Schema.makeFilter(
  (input: {
    readonly request: { readonly workspaceId: WorkspaceId };
    readonly result: { readonly workspaceId: WorkspaceId };
  }) =>
    input.request.workspaceId === input.result.workspaceId ||
    "agent adapter request and result workspaces must match",
  { identifier: "AgentConnectionAdapterExchangeWorkspace" },
);

export const AgentConnectionAdapterExchange = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("beginLogin"),
    request: AgentConnectionBeginLoginRequest,
    result: AgentConnectionBeginLoginResult,
  }).check(
    agentAdapterExchangeWorkspace,
    Schema.makeFilter(
      (input) =>
        (input.request.provider.instanceId === input.result.provider.instanceId &&
          input.request.provider.driver === input.result.provider.driver) ||
        "begin-login provider identity must match",
      { identifier: "AgentConnectionBeginLoginExchange" },
    ),
  ),
  Schema.Struct({
    operation: Schema.Literal("pollLogin"),
    request: AgentConnectionPollLoginRequest,
    result: AgentConnectionPollLoginResult,
  }).check(
    agentAdapterExchangeWorkspace,
    Schema.makeFilter(
      (input) => input.request.loginId === input.result.loginId || "poll-login identity must match",
      { identifier: "AgentConnectionPollLoginExchange" },
    ),
  ),
  Schema.Struct({
    operation: Schema.Literal("sealProfile"),
    request: AgentConnectionSealProfileRequest,
    result: AgentConnectionSealProfileResult,
  }).check(
    agentAdapterExchangeWorkspace,
    Schema.makeFilter(
      (input) =>
        (input.request.profileId === input.result.profile.profileId &&
          input.request.provider.instanceId === input.result.profile.provider.instanceId &&
          input.request.provider.driver === input.result.profile.provider.driver) ||
        "seal-profile identities must match",
      { identifier: "AgentConnectionSealProfileExchange" },
    ),
  ),
  Schema.Struct({
    operation: Schema.Literal("materialize"),
    request: AgentConnectionMaterializeRequest,
    result: AgentConnectionMaterializeResult,
  }).check(
    agentAdapterExchangeWorkspace,
    Schema.makeFilter(
      (input) =>
        (input.request.profileId === input.result.profileId &&
          input.request.authorization.workspaceId === input.result.workspaceId &&
          input.request.authorization.threadId === input.result.threadId &&
          input.request.authorization.environmentId === input.result.environmentId &&
          input.request.authorization.sandboxId === input.result.sandboxId) ||
        "materialization profile and authorized target identities must match",
      { identifier: "AgentConnectionMaterializeExchange" },
    ),
  ),
  Schema.Struct({
    operation: Schema.Literal("validate"),
    request: AgentConnectionValidateRequest,
    result: AgentConnectionValidateResult,
  }).check(
    agentAdapterExchangeWorkspace,
    Schema.makeFilter(
      (input) =>
        input.request.profileId === input.result.profileId ||
        "validation profile identity must match",
      { identifier: "AgentConnectionValidateExchange" },
    ),
  ),
  Schema.Struct({
    operation: Schema.Literal("refresh"),
    request: AgentConnectionRefreshRequest,
    result: AgentConnectionRefreshResult,
  }).check(
    agentAdapterExchangeWorkspace,
    Schema.makeFilter(
      (input) =>
        input.request.profileId === input.result.profile.profileId ||
        "refresh profile identity must match",
      { identifier: "AgentConnectionRefreshExchange" },
    ),
  ),
  Schema.Struct({
    operation: Schema.Literal("revoke"),
    request: AgentConnectionRevokeRequest,
    result: AgentConnectionRevokeResult,
  }).check(
    agentAdapterExchangeWorkspace,
    Schema.makeFilter(
      (input) =>
        input.request.profileId === input.result.profileId || "revoke profile identity must match",
      { identifier: "AgentConnectionRevokeExchange" },
    ),
  ),
]);
export type AgentConnectionAdapterExchange = typeof AgentConnectionAdapterExchange.Type;

export interface AgentConnectionAdapter {
  readonly beginLogin: (
    request: AgentConnectionBeginLoginRequest,
  ) => Effect.Effect<AgentConnectionBeginLoginResult, AgentConnectionAdapterError>;
  readonly pollLogin: (
    request: AgentConnectionPollLoginRequest,
  ) => Effect.Effect<AgentConnectionPollLoginResult, AgentConnectionAdapterError>;
  readonly sealProfile: (
    request: AgentConnectionSealProfileRequest,
  ) => Effect.Effect<AgentConnectionSealProfileResult, AgentConnectionAdapterError>;
  readonly materialize: (
    request: AgentConnectionMaterializeRequest,
  ) => Effect.Effect<AgentConnectionMaterializeResult, AgentConnectionAdapterError>;
  readonly validate: (
    request: AgentConnectionValidateRequest,
  ) => Effect.Effect<AgentConnectionValidateResult, AgentConnectionAdapterError>;
  readonly refresh: (
    request: AgentConnectionRefreshRequest,
  ) => Effect.Effect<AgentConnectionRefreshResult, AgentConnectionAdapterError>;
  readonly revoke: (
    request: AgentConnectionRevokeRequest,
  ) => Effect.Effect<AgentConnectionRevokeResult, AgentConnectionAdapterError>;
}

export const AgentConnectionState = Schema.Literals([
  "requested",
  "connecting",
  "connected",
  "disconnecting",
  "disconnected",
  "failed",
]);
export type AgentConnectionState = typeof AgentConnectionState.Type;

/** Lifecycle snapshot for one provider session attached to a cloud thread. */
export const AgentConnection = Schema.Struct({
  connectionId: AgentConnectionId,
  workspaceId: WorkspaceId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  provider: ProviderInstanceRef,
  profileId: Schema.optionalKey(AgentProfileId),
  materializationId: Schema.optionalKey(AgentMaterializationId),
  runtimeSessionId: Schema.optionalKey(RuntimeSessionId),
  state: AgentConnectionState,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  connectedAt: Schema.optionalKey(IsoDateTime),
  disconnectedAt: Schema.optionalKey(IsoDateTime),
  lastError: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AgentConnection = typeof AgentConnection.Type;

/**
 * Hosted client commands deliberately carry identifiers only. Better Auth,
 * workspace membership, clock values, provider driver, and sandbox authority
 * are derived by the control plane and cannot be asserted by a client.
 */
export const ProviderCredentialBeginLoginCommand = Schema.Struct({
  requestId: CommandId,
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceRef.fields.instanceId,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ProviderCredentialBeginLoginCommand = typeof ProviderCredentialBeginLoginCommand.Type;

export const ProviderCredentialPollLoginCommand = Schema.Struct({
  requestId: CommandId,
  loginId: AgentLoginId,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ProviderCredentialPollLoginCommand = typeof ProviderCredentialPollLoginCommand.Type;

export const ProviderCredentialCancelLoginCommand = Schema.Struct({
  requestId: CommandId,
  loginId: AgentLoginId,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ProviderCredentialCancelLoginCommand = typeof ProviderCredentialCancelLoginCommand.Type;

export const ProviderCredentialSealProfileCommand = Schema.Struct({
  requestId: CommandId,
  loginId: AgentLoginId,
  profileId: AgentProfileId,
  idempotencyKey: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ProviderCredentialSealProfileCommand = typeof ProviderCredentialSealProfileCommand.Type;

export const ProviderCredentialMaterializeCommand = Schema.Struct({
  requestId: CommandId,
  threadId: ThreadId,
  profileId: AgentProfileId,
  materializationId: AgentMaterializationId,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ProviderCredentialMaterializeCommand = typeof ProviderCredentialMaterializeCommand.Type;

export const ProviderCredentialProfileCommand = Schema.Struct({
  requestId: CommandId,
  profileId: AgentProfileId,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ProviderCredentialProfileCommand = typeof ProviderCredentialProfileCommand.Type;

export const PluginPublisher = Schema.Struct({
  publisherId: PluginPublisherId,
  name: TrimmedNonEmptyString,
  website: Schema.optionalKey(TrimmedNonEmptyString),
});
export type PluginPublisher = typeof PluginPublisher.Type;

export const PluginSignature = Schema.Struct({
  algorithm: TrimmedNonEmptyString,
  keyId: TrimmedNonEmptyString,
  signature: TrimmedNonEmptyString,
  signedAt: IsoDateTime,
});
export type PluginSignature = typeof PluginSignature.Type;

export const PluginSecretReference = Schema.Struct({
  name: TrimmedNonEmptyString,
  purpose: TrimmedNonEmptyString,
  optional: Schema.Boolean,
});
export type PluginSecretReference = typeof PluginSecretReference.Type;

export const PluginOAuthReference = Schema.Struct({
  name: TrimmedNonEmptyString,
  provider: TrimmedNonEmptyString,
  scopes: Schema.Array(TrimmedNonEmptyString),
  optional: Schema.Boolean,
});
export type PluginOAuthReference = typeof PluginOAuthReference.Type;

export const PluginMcpServer = Schema.Union([
  Schema.Struct({
    name: TrimmedNonEmptyString,
    transport: Schema.Literal("stdio"),
    command: TrimmedNonEmptyString,
    arguments: Schema.Array(Schema.String),
    executableHash: TrimmedNonEmptyString,
    secretRefs: Schema.Array(TrimmedNonEmptyString),
    oauthRefs: Schema.Array(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    name: TrimmedNonEmptyString,
    transport: Schema.Literal("http"),
    url: TrimmedNonEmptyString,
    secretRefs: Schema.Array(TrimmedNonEmptyString),
    oauthRefs: Schema.Array(TrimmedNonEmptyString),
  }),
]);
export type PluginMcpServer = typeof PluginMcpServer.Type;

const PluginFileContributionFields = {
  name: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  contentHash: TrimmedNonEmptyString,
} as const;

export const PluginSkill = Schema.Struct(PluginFileContributionFields);
export type PluginSkill = typeof PluginSkill.Type;
export const PluginRule = Schema.Struct(PluginFileContributionFields);
export type PluginRule = typeof PluginRule.Type;

export const PluginCommand = Schema.Struct({
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  arguments: Schema.Array(Schema.String),
  executableHash: TrimmedNonEmptyString,
  cwd: Schema.optionalKey(TrimmedNonEmptyString),
});
export type PluginCommand = typeof PluginCommand.Type;

export const PluginHook = Schema.Struct({
  event: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  executableHash: TrimmedNonEmptyString,
});
export type PluginHook = typeof PluginHook.Type;

export const PluginSetupStep = Schema.Struct({
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  arguments: Schema.Array(Schema.String),
  executableHash: TrimmedNonEmptyString,
  timeoutMs: Schema.optionalKey(PositiveInt),
});
export type PluginSetupStep = typeof PluginSetupStep.Type;

export const PluginPermission = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("file"),
    access: Schema.Array(Schema.Literals(["read", "write"])),
    paths: Schema.Array(TrimmedNonEmptyString),
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    type: Schema.Literal("command"),
    commands: Schema.Array(TrimmedNonEmptyString),
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    type: Schema.Literal("network"),
    domains: Schema.Array(TrimmedNonEmptyString),
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    type: Schema.Literal("external-write"),
    services: Schema.Array(TrimmedNonEmptyString),
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    type: Schema.Literal("deploy"),
    targets: Schema.Array(TrimmedNonEmptyString),
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    type: Schema.Literal("payment"),
    maxMicroUsdcPerOperation: MicroUsdc,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
]);
export type PluginPermission = typeof PluginPermission.Type;

export const PluginCompatibility = Schema.Struct({
  minimumT3Version: TrimmedNonEmptyString,
  maximumT3Version: Schema.optionalKey(TrimmedNonEmptyString),
  platforms: Schema.Array(ExecutionEnvironmentPlatformOs),
  architectures: Schema.Array(ExecutionEnvironmentPlatformArch),
  sandboxCapabilities: ForwardCompatibleArray(SandboxProviderCapability),
});
export type PluginCompatibility = typeof PluginCompatibility.Type;

export const PluginVerification = Schema.Struct({
  status: Schema.Literals(["unverified", "verified", "rejected", "revoked"]),
  verifier: Schema.optionalKey(TrimmedNonEmptyString),
  verifiedAt: Schema.optionalKey(IsoDateTime),
  attestationHash: Schema.optionalKey(TrimmedNonEmptyString),
});
export type PluginVerification = typeof PluginVerification.Type;

export const PLUGIN_MANIFEST_SCHEMA_VERSION = 1 as const;
export const PluginManifestSchemaVersion = Schema.Literal(PLUGIN_MANIFEST_SCHEMA_VERSION);
export type PluginManifestSchemaVersion = typeof PluginManifestSchemaVersion.Type;

export const PluginManifest = Schema.Struct({
  schemaVersion: PluginManifestSchemaVersion,
  workspaceId: WorkspaceId,
  pluginId: PluginId,
  version: TrimmedNonEmptyString,
  publisher: PluginPublisher,
  signature: PluginSignature,
  name: TrimmedNonEmptyString,
  description: Schema.optionalKey(TrimmedNonEmptyString),
  homepage: Schema.optionalKey(TrimmedNonEmptyString),
  supportedAgents: Schema.Array(ProviderDriverKind),
  mcpServers: Schema.Array(PluginMcpServer),
  skills: Schema.Array(PluginSkill),
  rules: Schema.Array(PluginRule),
  commands: Schema.Array(PluginCommand),
  hooks: Schema.Array(PluginHook),
  setup: Schema.Array(PluginSetupStep),
  secretRefs: Schema.Array(PluginSecretReference),
  oauthRefs: Schema.Array(PluginOAuthReference),
  permissions: Schema.Array(PluginPermission),
  allowedDomains: Schema.Array(TrimmedNonEmptyString),
  compatibility: PluginCompatibility,
  verification: PluginVerification,
});
export type PluginManifest = typeof PluginManifest.Type;

export const PluginGrantState = Schema.Literals(["active", "revoked", "expired"]);
export type PluginGrantState = typeof PluginGrantState.Type;

export const PluginGrant = Schema.Struct({
  grantId: PluginGrantId,
  workspaceId: WorkspaceId,
  environmentId: EnvironmentId,
  pluginId: PluginId,
  pluginVersion: TrimmedNonEmptyString,
  manifestSchemaVersion: PluginManifestSchemaVersion,
  manifestHash: TrimmedNonEmptyString,
  permissions: Schema.Array(PluginPermission),
  state: PluginGrantState,
  grantedBy: AuthSessionId,
  grantedAt: IsoDateTime,
  expiresAt: Schema.optionalKey(IsoDateTime),
  revokedAt: Schema.optionalKey(IsoDateTime),
});
export type PluginGrant = typeof PluginGrant.Type;

export const AutomationGitHubEventKind = Schema.Literals(["issue", "pull_request", "comment"]);
export type AutomationGitHubEventKind = typeof AutomationGitHubEventKind.Type;

export const AutomationGitHubEventFilter = Schema.Struct({
  kind: AutomationGitHubEventKind,
  actions: Schema.Array(TrimmedNonEmptyString),
  branches: Schema.Array(TrimmedNonEmptyString),
  labels: Schema.Array(TrimmedNonEmptyString),
});
export type AutomationGitHubEventFilter = typeof AutomationGitHubEventFilter.Type;

export const AutomationWebhookSignature = Schema.Struct({
  algorithm: Schema.Literals(["hmac-sha256", "ed25519"]),
  secretRef: TrimmedNonEmptyString,
  signatureHeader: TrimmedNonEmptyString,
  timestampHeader: Schema.optionalKey(TrimmedNonEmptyString),
  toleranceSeconds: Schema.optionalKey(PositiveInt),
});
export type AutomationWebhookSignature = typeof AutomationWebhookSignature.Type;

export const AutomationTrigger = Schema.Union([
  Schema.Struct({ type: Schema.Literal("manual") }),
  Schema.Struct({
    type: Schema.Literal("schedule"),
    rrule: TrimmedNonEmptyString,
    timeZone: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("github"),
    repository: RepositoryIdentity,
    filters: Schema.Array(AutomationGitHubEventFilter),
  }),
  Schema.Struct({
    type: Schema.Literal("sentry"),
    organization: TrimmedNonEmptyString,
    project: TrimmedNonEmptyString,
    environments: Schema.Array(TrimmedNonEmptyString),
    levels: Schema.Array(TrimmedNonEmptyString),
    tags: Schema.Record(Schema.String, TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("webhook"),
    path: TrimmedNonEmptyString,
    signature: AutomationWebhookSignature,
  }),
]);
export type AutomationTrigger = typeof AutomationTrigger.Type;

export const AutomationTarget = Schema.Struct({
  type: Schema.Literal("project"),
  workspaceId: WorkspaceId,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  revisionId: EnvironmentRevisionId,
  threadMode: Schema.Literal("fresh"),
});
export type AutomationTarget = typeof AutomationTarget.Type;

export const AutomationRepositoryBoundary = Schema.Struct({
  repository: RepositoryIdentity,
  branches: Schema.Array(TrimmedNonEmptyString),
  push: Schema.Boolean,
  draftPullRequest: Schema.Boolean,
  comment: Schema.Boolean,
  merge: Schema.Literal(false),
  deploy: Schema.Literal(false),
});
export type AutomationRepositoryBoundary = typeof AutomationRepositoryBoundary.Type;

export const AutomationApprovalPolicy = Schema.Struct({
  mode: Schema.Literals(["never", "always", "externalWrites", "payments"]),
  boundary: AutomationRepositoryBoundary,
  allowedSecretRefs: Schema.Array(TrimmedNonEmptyString),
  expiresAfterMs: Schema.optionalKey(PositiveInt),
});
export type AutomationApprovalPolicy = typeof AutomationApprovalPolicy.Type;

export const AutomationApprovalAction = Schema.Literals([
  "push",
  "draftPullRequest",
  "comment",
  "payment",
]);
export type AutomationApprovalAction = typeof AutomationApprovalAction.Type;

const AutomationApprovalEnvelopeBaseFields = {
  requestId: ApprovalRequestId,
  workspaceId: WorkspaceId,
  recipeId: AutomationRecipeId,
  runId: AutomationRunId,
  environmentRevisionId: EnvironmentRevisionId,
  target: AutomationTarget,
  requestedAt: IsoDateTime,
  boundary: AutomationRepositoryBoundary,
  requestedActions: Schema.Array(AutomationApprovalAction),
  allowedSecretRefs: Schema.Array(TrimmedNonEmptyString),
  maxMicroUsdc: MicroUsdc,
} as const;

const approvalActionsWithinBoundary = Schema.makeFilter(
  (input: {
    readonly requestedActions: ReadonlyArray<AutomationApprovalAction>;
    readonly boundary: {
      readonly push: boolean;
      readonly draftPullRequest: boolean;
      readonly comment: boolean;
    };
  }) =>
    input.requestedActions.every(
      (action) => action === "payment" || input.boundary[action] === true,
    ) || "requested repository actions must be enabled by the approval boundary",
  { identifier: "AutomationApprovalRequestedActions" },
);

const approvalEnvelopeTargetIdentity = Schema.makeFilter(
  (input: {
    readonly workspaceId: WorkspaceId;
    readonly environmentRevisionId: EnvironmentRevisionId;
    readonly target: AutomationTarget;
  }) =>
    (input.workspaceId === input.target.workspaceId &&
      input.environmentRevisionId === input.target.revisionId) ||
    "approval workspace and environment revision must match its target",
  { identifier: "AutomationApprovalTargetIdentity" },
);

const AutomationApprovalPending = Schema.Struct({
  ...AutomationApprovalEnvelopeBaseFields,
  status: Schema.Literal("pending"),
})
  .check(approvalActionsWithinBoundary, approvalEnvelopeTargetIdentity)
  .annotate({ parseOptions: { onExcessProperty: "error" } });

const AutomationApprovalApproved = Schema.Struct({
  ...AutomationApprovalEnvelopeBaseFields,
  status: Schema.Literal("approved"),
  decidedAt: IsoDateTime,
  decidedBy: AuthSessionId,
  approvedMicroUsdc: Schema.optionalKey(MicroUsdc),
})
  .check(
    approvalActionsWithinBoundary,
    approvalEnvelopeTargetIdentity,
    Schema.makeFilter(
      (input) =>
        (input.requestedActions.includes("payment")
          ? input.approvedMicroUsdc !== undefined && input.approvedMicroUsdc <= input.maxMicroUsdc
          : input.approvedMicroUsdc === undefined) ||
        "payment approvals require an amount no greater than maxMicroUsdc",
      { identifier: "AutomationApprovalPaymentCap" },
    ),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });

const AutomationApprovalRejected = Schema.Struct({
  ...AutomationApprovalEnvelopeBaseFields,
  status: Schema.Literal("rejected"),
  decidedAt: IsoDateTime,
  decidedBy: AuthSessionId,
  reason: TrimmedNonEmptyString,
})
  .check(approvalActionsWithinBoundary, approvalEnvelopeTargetIdentity)
  .annotate({ parseOptions: { onExcessProperty: "error" } });

const AutomationApprovalExpired = Schema.Struct({
  ...AutomationApprovalEnvelopeBaseFields,
  status: Schema.Literal("expired"),
  decidedAt: IsoDateTime,
  reason: TrimmedNonEmptyString,
})
  .check(approvalActionsWithinBoundary, approvalEnvelopeTargetIdentity)
  .annotate({ parseOptions: { onExcessProperty: "error" } });

export const AutomationApprovalEnvelope = Schema.Union([
  AutomationApprovalPending,
  AutomationApprovalApproved,
  AutomationApprovalRejected,
  AutomationApprovalExpired,
]);
export type AutomationApprovalEnvelope = typeof AutomationApprovalEnvelope.Type;

export const AutomationOutputDefinition = Schema.Struct({
  name: TrimmedNonEmptyString,
  format: Schema.Literals(["text", "json", "file", "url"]),
  required: Schema.Boolean,
});
export type AutomationOutputDefinition = typeof AutomationOutputDefinition.Type;

export const AutomationOutput = Schema.Struct({
  name: TrimmedNonEmptyString,
  format: Schema.Literals(["text", "json", "file", "url"]),
  value: Schema.Unknown,
  contentHash: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AutomationOutput = typeof AutomationOutput.Type;

export const AutomationRetryPolicy = Schema.Struct({
  maxAttempts: PositiveInt,
  initialBackoffMs: NonNegativeInt,
  maxBackoffMs: NonNegativeInt,
  retryOn: Schema.Array(TrimmedNonEmptyString),
}).check(
  Schema.makeFilter(
    (input) =>
      input.initialBackoffMs <= input.maxBackoffMs ||
      "initialBackoffMs must not exceed maxBackoffMs",
    { identifier: "AutomationRetryBackoffRange" },
  ),
);
export type AutomationRetryPolicy = typeof AutomationRetryPolicy.Type;

export const AutomationNotificationChannel = Schema.Union([
  Schema.Struct({ type: Schema.Literal("desktop") }),
  Schema.Struct({ type: Schema.Literal("email"), address: TrimmedNonEmptyString }),
  Schema.Struct({
    type: Schema.Literal("webhook"),
    url: TrimmedNonEmptyString,
    secretRef: Schema.optionalKey(TrimmedNonEmptyString),
  }),
]);
export type AutomationNotificationChannel = typeof AutomationNotificationChannel.Type;

export const AutomationNotificationPolicy = Schema.Struct({
  events: Schema.Array(
    Schema.Literals(["approvalRequired", "succeeded", "failed", "budgetExceeded"]),
  ),
  channels: Schema.Array(AutomationNotificationChannel),
});
export type AutomationNotificationPolicy = typeof AutomationNotificationPolicy.Type;

export const AutomationRunState = Schema.Literals([
  "queued",
  "waitingForApproval",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "budgetExceeded",
  "approvalRejected",
  "approvalExpired",
]);
export type AutomationRunState = typeof AutomationRunState.Type;

export const AutomationRecipe = Schema.Struct({
  schemaVersion: PositiveInt,
  recipeId: AutomationRecipeId,
  workspaceId: WorkspaceId,
  name: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  trigger: AutomationTrigger,
  target: AutomationTarget,
  instruction: TrimmedNonEmptyString,
  provider: Schema.optionalKey(ProviderInstanceRef),
  pluginGrantIds: Schema.Array(PluginGrantId),
  approval: AutomationApprovalPolicy,
  allowedSecretRefs: Schema.Array(TrimmedNonEmptyString),
  maxMicroUsdc: MicroUsdc,
  outputs: Schema.Array(AutomationOutputDefinition),
  retry: AutomationRetryPolicy,
  notifications: AutomationNotificationPolicy,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).check(
  Schema.makeFilter(
    (input) =>
      (input.workspaceId === input.target.workspaceId &&
        input.approval.allowedSecretRefs.every((secretRef) =>
          input.allowedSecretRefs.includes(secretRef),
        )) ||
      "recipe target and approval secrets must match its workspace policy",
    { identifier: "AutomationRecipeAllowedSecrets" },
  ),
);
export type AutomationRecipe = typeof AutomationRecipe.Type;

export const AutomationRun = Schema.Struct({
  runId: AutomationRunId,
  recipeId: AutomationRecipeId,
  workspaceId: WorkspaceId,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  revisionId: EnvironmentRevisionId,
  threadMode: Schema.Literal("fresh"),
  threadId: Schema.optionalKey(ThreadId),
  turnId: Schema.optionalKey(TurnId),
  commandId: Schema.optionalKey(CommandId),
  attempt: PositiveInt,
  state: AutomationRunState,
  approval: AutomationApprovalEnvelope,
  maxMicroUsdc: MicroUsdc,
  spentMicroUsdc: MicroUsdc,
  outputs: Schema.Array(AutomationOutput),
  queuedAt: IsoDateTime,
  startedAt: Schema.optionalKey(IsoDateTime),
  finishedAt: Schema.optionalKey(IsoDateTime),
  error: Schema.optionalKey(TrimmedNonEmptyString),
}).check(
  Schema.makeFilter(
    (input) =>
      (input.spentMicroUsdc <= input.maxMicroUsdc &&
        input.approval.workspaceId === input.workspaceId &&
        input.approval.recipeId === input.recipeId &&
        input.approval.runId === input.runId &&
        input.approval.environmentRevisionId === input.revisionId &&
        input.approval.target.workspaceId === input.workspaceId &&
        input.approval.target.environmentId === input.environmentId &&
        input.approval.target.projectId === input.projectId &&
        input.approval.target.revisionId === input.revisionId &&
        input.approval.maxMicroUsdc === input.maxMicroUsdc &&
        (input.state === "waitingForApproval"
          ? input.approval.status === "pending"
          : ["queued", "running", "succeeded", "failed", "budgetExceeded"].includes(input.state)
            ? input.approval.status === "approved"
            : input.state === "approvalRejected"
              ? input.approval.status === "rejected"
              : input.state === "approvalExpired"
                ? input.approval.status === "expired"
                : input.approval.status === "pending" || input.approval.status === "approved") &&
        (["queued", "waitingForApproval", "approvalRejected", "approvalExpired"].includes(
          input.state,
        ) ||
          input.threadId !== undefined) &&
        (input.startedAt === undefined || input.queuedAt <= input.startedAt) &&
        (input.finishedAt === undefined ||
          (input.startedAt !== undefined && input.startedAt <= input.finishedAt))) ||
      "run approval identity/status, budget, fresh-thread identity, and timestamps must be consistent",
    { identifier: "AutomationRunBudget" },
  ),
);
export type AutomationRun = typeof AutomationRun.Type;

export const HostedInfrastructureProvider = Schema.Literal("e2b");
export type HostedInfrastructureProvider = typeof HostedInfrastructureProvider.Type;

export const UsageEvidenceSha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).pipe(
  Schema.brand("UsageEvidenceSha256"),
);
export type UsageEvidenceSha256 = typeof UsageEvidenceSha256.Type;
const CanonicalUsageIsoDateTime = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
);

/**
 * An exact upstream charge record retrieved through an authenticated E2B billing surface.
 * Monitoring metrics and locally calculated estimates cannot satisfy this contract.
 */
export const VerifiedE2bUsageEvidence = Schema.Struct({
  evidenceId: UsageEvidenceId,
  revision: PositiveInt,
  infrastructureProvider: HostedInfrastructureProvider,
  verification: Schema.Literal("e2b-authenticated-billing-record"),
  payloadSha256: UsageEvidenceSha256,
  intervalStart: CanonicalUsageIsoDateTime,
  intervalEnd: CanonicalUsageIsoDateTime,
  upstreamMicroUsdc: MicroUsdc,
  observedAt: CanonicalUsageIsoDateTime,
})
  .check(
    Schema.makeFilter(
      (input) =>
        input.intervalStart < input.intervalEnd || "verified usage interval must be non-empty",
      { identifier: "VerifiedE2bUsageEvidenceInterval" },
    ),
    Schema.makeFilter(
      (input) =>
        input.intervalEnd <= input.observedAt ||
        "verified usage cannot be observed before its interval ends",
      { identifier: "VerifiedE2bUsageEvidenceObservation" },
    ),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });
export type VerifiedE2bUsageEvidence = typeof VerifiedE2bUsageEvidence.Type;

export const UsagePricingScope = Schema.Struct({
  kind: Schema.Literal("workspace"),
  workspaceId: WorkspaceId,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type UsagePricingScope = typeof UsagePricingScope.Type;

/**
 * Immutable pricing transition passed to H5 receipt signing. Pricing is cumulative per workspace,
 * so evidence partitioning, parallel threads, and settlement boundaries cannot change the fee.
 */
export const UsageAccrual = Schema.Struct({
  accrualId: UsageAccrualId,
  sampleId: UsageSampleId,
  priorSampleId: Schema.optionalKey(UsageSampleId),
  workspaceId: WorkspaceId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  sandboxId: SandboxId,
  evidence: VerifiedE2bUsageEvidence,
  pricingScope: UsagePricingScope,
  pricingVersion: Schema.Literal(1),
  pricingSequence: PositiveInt,
  evidencePreviousUpstreamMicroUsdc: MicroUsdc,
  evidenceUpstreamMicroUsdc: MicroUsdc,
  markupBasisPoints: Schema.Literal(USAGE_MARKUP_BASIS_POINTS),
  markupRounding: UsageMarkupRounding,
  upstreamDeltaMicroUsdc: SignedMicroUsdc,
  cumulativeUpstreamBeforeMicroUsdc: MicroUsdc,
  cumulativeUpstreamAfterMicroUsdc: MicroUsdc,
  cumulativeMarkupBeforeMicroUsdc: MicroUsdc,
  cumulativeMarkupAfterMicroUsdc: MicroUsdc,
  cumulativeTotalBeforeMicroUsdc: MicroUsdc,
  cumulativeTotalAfterMicroUsdc: MicroUsdc,
  markupDeltaMicroUsdc: SignedMicroUsdc,
  totalDeltaMicroUsdc: SignedMicroUsdc,
  payloadSha256: UsageEvidenceSha256,
  recordedAt: CanonicalUsageIsoDateTime,
})
  .check(
    Schema.makeFilter(
      (input) =>
        (input.evidence.revision === 1
          ? input.priorSampleId === undefined && input.evidencePreviousUpstreamMicroUsdc === 0
          : input.priorSampleId !== undefined) ||
        "only the first evidence revision may omit its prior sample",
      { identifier: "UsageAccrualRevisionChain" },
    ),
    Schema.makeFilter(
      (input) =>
        (input.pricingScope.workspaceId === input.workspaceId &&
          input.evidenceUpstreamMicroUsdc === input.evidence.upstreamMicroUsdc) ||
        "usage pricing scope and evidence must match the accrual identity",
      { identifier: "UsageAccrualIdentity" },
    ),
    Schema.makeFilter(
      (input) =>
        (input.upstreamDeltaMicroUsdc ===
          input.evidenceUpstreamMicroUsdc - input.evidencePreviousUpstreamMicroUsdc &&
          input.cumulativeUpstreamAfterMicroUsdc ===
            input.cumulativeUpstreamBeforeMicroUsdc + input.upstreamDeltaMicroUsdc &&
          input.cumulativeMarkupBeforeMicroUsdc ===
            fivePercentMarkupMicroUsdc(input.cumulativeUpstreamBeforeMicroUsdc) &&
          input.cumulativeMarkupAfterMicroUsdc ===
            fivePercentMarkupMicroUsdc(input.cumulativeUpstreamAfterMicroUsdc) &&
          input.cumulativeTotalBeforeMicroUsdc ===
            input.cumulativeUpstreamBeforeMicroUsdc + input.cumulativeMarkupBeforeMicroUsdc &&
          input.cumulativeTotalAfterMicroUsdc ===
            input.cumulativeUpstreamAfterMicroUsdc + input.cumulativeMarkupAfterMicroUsdc &&
          input.markupDeltaMicroUsdc ===
            input.cumulativeMarkupAfterMicroUsdc - input.cumulativeMarkupBeforeMicroUsdc &&
          input.totalDeltaMicroUsdc ===
            input.cumulativeTotalAfterMicroUsdc - input.cumulativeTotalBeforeMicroUsdc &&
          input.totalDeltaMicroUsdc ===
            input.upstreamDeltaMicroUsdc + input.markupDeltaMicroUsdc) ||
        "usage accrual must be one exact cumulative workspace pricing transition",
      { identifier: "UsageAccrualDelta" },
    ),
    Schema.makeFilter(
      (input) =>
        input.evidence.observedAt <= input.recordedAt ||
        "usage accrual cannot be recorded before evidence is observed",
      { identifier: "UsageAccrualRecordedAt" },
    ),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });
export type UsageAccrual = typeof UsageAccrual.Type;

export const UsageAccrualPostingDirection = Schema.Literals(["debit", "credit", "none"]);
export type UsageAccrualPostingDirection = typeof UsageAccrualPostingDirection.Type;

/** H5 consumes this signed posting without repricing or rounding at settlement boundaries. */
export const UsageAccrualSettlementInput = Schema.Struct({
  accrualId: UsageAccrualId,
  workspaceId: WorkspaceId,
  pricingScope: UsagePricingScope,
  pricingVersion: Schema.Literal(1),
  pricingSequence: PositiveInt,
  receiptInputSha256: UsageEvidenceSha256,
  totalDeltaMicroUsdc: SignedMicroUsdc,
  walletLedgerAmountMicroUsdc: SignedMicroUsdc,
  direction: UsageAccrualPostingDirection,
})
  .check(
    Schema.makeFilter(
      (input) =>
        (input.pricingScope.workspaceId === input.workspaceId &&
          input.walletLedgerAmountMicroUsdc === -input.totalDeltaMicroUsdc &&
          (input.totalDeltaMicroUsdc > 0
            ? input.direction === "debit"
            : input.totalDeltaMicroUsdc < 0
              ? input.direction === "credit"
              : input.direction === "none")) ||
        "settlement input must preserve the signed accrual delta without repricing",
      { identifier: "UsageAccrualSettlementInputLinkage" },
    ),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });
export type UsageAccrualSettlementInput = typeof UsageAccrualSettlementInput.Type;

export const UsageSettlementTrigger = Schema.Literals([
  "five-minute-window",
  "amount-threshold",
  "sandbox-paused",
  "sandbox-closed",
]);
export type UsageSettlementTrigger = typeof UsageSettlementTrigger.Type;

export const UsageSettlementAttemptState = Schema.Literals([
  "reserved",
  "retry-waiting",
  "submission-pending",
  "reconciliation-required",
  "transfer-applied",
  "low-balance-pause-pending",
  "low-balance-paused",
  "finalized",
]);
export type UsageSettlementAttemptState = typeof UsageSettlementAttemptState.Type;

/** One immutable H4 pricing transition included in a settlement without repricing. */
export const UsageSettlementAccrualPosting = Schema.Struct({
  accrualId: UsageAccrualId,
  sampleId: UsageSampleId,
  environmentId: EnvironmentId,
  sandboxId: SandboxId,
  evidenceId: UsageEvidenceId,
  evidenceRevision: PositiveInt,
  evidencePayloadSha256: UsageEvidenceSha256,
  receiptInputSha256: UsageEvidenceSha256,
  pricingSequence: PositiveInt,
  intervalStart: CanonicalUsageIsoDateTime,
  intervalEnd: CanonicalUsageIsoDateTime,
  upstreamDeltaMicroUsdc: SignedMicroUsdc,
  markupDeltaMicroUsdc: SignedMicroUsdc,
  totalDeltaMicroUsdc: SignedMicroUsdc,
}).check(
  Schema.makeFilter(
    (input) =>
      (input.intervalStart < input.intervalEnd &&
        input.totalDeltaMicroUsdc === input.upstreamDeltaMicroUsdc + input.markupDeltaMicroUsdc) ||
      "settlement posting must preserve its immutable interval and signed H4 deltas",
    { identifier: "UsageSettlementAccrualPostingLinkage" },
  ),
);
export type UsageSettlementAccrualPosting = typeof UsageSettlementAccrualPosting.Type;

export const UsageSettlementEvidenceRange = Schema.Struct({
  firstSampleId: UsageSampleId,
  lastSampleId: UsageSampleId,
  firstEvidenceId: UsageEvidenceId,
  firstEvidenceRevision: PositiveInt,
  lastEvidenceId: UsageEvidenceId,
  lastEvidenceRevision: PositiveInt,
  firstPricingSequence: PositiveInt,
  lastPricingSequence: PositiveInt,
  accrualCount: PositiveInt,
  intervalStart: CanonicalUsageIsoDateTime,
  intervalEnd: CanonicalUsageIsoDateTime,
}).check(
  Schema.makeFilter(
    (input) =>
      (input.firstPricingSequence <= input.lastPricingSequence &&
        input.intervalStart < input.intervalEnd) ||
      "settlement evidence range must be ordered and non-empty",
    { identifier: "UsageSettlementEvidenceRangeOrder" },
  ),
);
export type UsageSettlementEvidenceRange = typeof UsageSettlementEvidenceRange.Type;

/** Signed receipt payload produced only after one exact Monad USDC transfer is observed. */
export const UsageSettlementReceiptPayload = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  settlementId: SettlementId,
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  infrastructureProvider: HostedInfrastructureProvider,
  evidenceRange: UsageSettlementEvidenceRange,
  postings: Schema.Array(UsageSettlementAccrualPosting).check(Schema.isMinLength(1)),
  upstreamMicroUsdc: SignedMicroUsdc,
  markupMicroUsdc: SignedMicroUsdc,
  totalMicroUsdc: MicroUsdc.check(Schema.isGreaterThan(0)),
  txHash: EvmTransactionHash,
  createdAt: CanonicalUsageIsoDateTime,
  submittedAt: CanonicalUsageIsoDateTime,
})
  .check(
    Schema.makeFilter(
      (input) => {
        const upstream = input.postings.reduce(
          (total, posting) => total + BigInt(posting.upstreamDeltaMicroUsdc),
          0n,
        );
        const markup = input.postings.reduce(
          (total, posting) => total + BigInt(posting.markupDeltaMicroUsdc),
          0n,
        );
        const total = input.postings.reduce(
          (sum, posting) => sum + BigInt(posting.totalDeltaMicroUsdc),
          0n,
        );
        const first = input.postings[0];
        const last = input.postings[input.postings.length - 1];
        const ordered = input.postings.every(
          (posting, index) =>
            index === 0 || input.postings[index - 1]!.pricingSequence < posting.pricingSequence,
        );
        const intervalStart = input.postings.reduce(
          (minimum, posting) => (posting.intervalStart < minimum ? posting.intervalStart : minimum),
          first?.intervalStart ?? input.evidenceRange.intervalStart,
        );
        const intervalEnd = input.postings.reduce(
          (maximum, posting) => (posting.intervalEnd > maximum ? posting.intervalEnd : maximum),
          first?.intervalEnd ?? input.evidenceRange.intervalEnd,
        );
        return (
          (first !== undefined &&
            last !== undefined &&
            input.createdAt <= input.submittedAt &&
            ordered &&
            upstream === BigInt(input.upstreamMicroUsdc) &&
            markup === BigInt(input.markupMicroUsdc) &&
            total === BigInt(input.totalMicroUsdc) &&
            total === upstream + markup &&
            input.evidenceRange.accrualCount === input.postings.length &&
            input.evidenceRange.intervalStart === intervalStart &&
            input.evidenceRange.intervalEnd === intervalEnd &&
            input.evidenceRange.firstSampleId === first.sampleId &&
            input.evidenceRange.lastSampleId === last.sampleId &&
            input.evidenceRange.firstEvidenceId === first.evidenceId &&
            input.evidenceRange.firstEvidenceRevision === first.evidenceRevision &&
            input.evidenceRange.lastEvidenceId === last.evidenceId &&
            input.evidenceRange.lastEvidenceRevision === last.evidenceRevision &&
            input.evidenceRange.firstPricingSequence === first.pricingSequence &&
            input.evidenceRange.lastPricingSequence === last.pricingSequence) ||
          "settlement receipt must exactly bind its ordered signed H4 postings and transfer"
        );
      },
      { identifier: "UsageSettlementReceiptPayloadLinkage" },
    ),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });
export type UsageSettlementReceiptPayload = typeof UsageSettlementReceiptPayload.Type;

export const UsageSettlementReceiptSignature = Schema.Struct({
  algorithm: TrimmedNonEmptyString,
  keyId: TrimmedNonEmptyString,
  payloadHash: UsageEvidenceSha256,
  signature: TrimmedNonEmptyString,
  signedAt: CanonicalUsageIsoDateTime,
});
export type UsageSettlementReceiptSignature = typeof UsageSettlementReceiptSignature.Type;

export const UsageSettlementReceipt = Schema.Struct({
  payload: UsageSettlementReceiptPayload,
  payloadSha256: UsageEvidenceSha256,
  signature: UsageSettlementReceiptSignature,
})
  .check(
    Schema.makeFilter(
      (input) =>
        (input.signature.payloadHash === input.payloadSha256 &&
          input.signature.signedAt >= input.payload.submittedAt) ||
        "settlement receipt signature must bind the exact payload hash",
      { identifier: "UsageSettlementReceiptSignatureLinkage" },
    ),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });
export type UsageSettlementReceipt = typeof UsageSettlementReceipt.Type;

/** Hosted billing accepts sandbox infrastructure meters only, never agent/provider usage. */
export const UsageMeter = Schema.Literals([
  "e2b.sandbox.cpu.millisecond",
  "e2b.sandbox.memory.byte-millisecond",
  "e2b.sandbox.storage.byte-millisecond",
  "e2b.sandbox.network.egress-byte",
  "e2b.sandbox.uptime.millisecond",
  "e2b.sandbox.desktop.millisecond",
]);
export type UsageMeter = typeof UsageMeter.Type;
export const UsageUnit = Schema.Literals(["millisecond", "byte-millisecond", "byte"]);
export type UsageUnit = typeof UsageUnit.Type;

const usageUnitMatchesMeter = (meter: UsageMeter, unit: UsageUnit) => {
  if (meter === "e2b.sandbox.network.egress-byte") return unit === "byte";
  if (
    meter === "e2b.sandbox.memory.byte-millisecond" ||
    meter === "e2b.sandbox.storage.byte-millisecond"
  ) {
    return unit === "byte-millisecond";
  }
  return unit === "millisecond";
};

export const UsageSample = Schema.Struct({
  sampleId: UsageSampleId,
  workspaceId: WorkspaceId,
  environmentId: EnvironmentId,
  sandboxId: SandboxId,
  threadId: Schema.optionalKey(ThreadId),
  automationRunId: Schema.optionalKey(AutomationRunId),
  infrastructureProvider: HostedInfrastructureProvider,
  meter: UsageMeter,
  quantity: NonNegativeFiniteNumber,
  unit: UsageUnit,
  intervalStart: IsoDateTime,
  intervalEnd: IsoDateTime,
  observedAt: IsoDateTime,
  sourceEventId: Schema.optionalKey(EventId),
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
}).check(
  Schema.makeFilter(
    (input) =>
      input.intervalStart <= input.intervalEnd || "intervalStart must not follow intervalEnd",
    { identifier: "UsageSampleInterval" },
  ),
  Schema.makeFilter(
    (input) =>
      usageUnitMatchesMeter(input.meter, input.unit) ||
      "usage unit must match its E2B sandbox meter",
    { identifier: "UsageSampleInfrastructureUnit" },
  ),
);
export type UsageSample = typeof UsageSample.Type;

export const UsageReceiptStatus = Schema.Literals(["accepted", "duplicate", "rejected"]);
export type UsageReceiptStatus = typeof UsageReceiptStatus.Type;

export const UsageSampleRange = Schema.Struct({
  firstSampleId: UsageSampleId,
  lastSampleId: UsageSampleId,
  sampleCount: PositiveInt,
  intervalStart: IsoDateTime,
  intervalEnd: IsoDateTime,
}).check(
  Schema.makeFilter(
    (input) =>
      input.intervalStart <= input.intervalEnd || "intervalStart must not follow intervalEnd",
    { identifier: "UsageSampleRangeInterval" },
  ),
);
export type UsageSampleRange = typeof UsageSampleRange.Type;

export const UsageReceiptSignature = Schema.Struct({
  algorithm: TrimmedNonEmptyString,
  keyId: TrimmedNonEmptyString,
  payloadHash: TrimmedNonEmptyString,
  signature: TrimmedNonEmptyString,
  signedAt: IsoDateTime,
});
export type UsageReceiptSignature = typeof UsageReceiptSignature.Type;

const UsageReceiptBaseFields = {
  receiptId: UsageReceiptId,
  workspaceId: WorkspaceId,
  environmentId: EnvironmentId,
  sandboxId: SandboxId,
  threadId: ThreadId,
  infrastructureProvider: HostedInfrastructureProvider,
  sampleRange: UsageSampleRange,
  signature: UsageReceiptSignature,
  recordedAt: IsoDateTime,
} as const;

export const UsageReceiptAccepted = Schema.Struct({
  ...UsageReceiptBaseFields,
  status: Schema.Literal("accepted"),
  upstreamMicroUsdc: MicroUsdc,
  markupBasisPoints: Schema.Literal(USAGE_MARKUP_BASIS_POINTS),
  markupRounding: UsageMarkupRounding,
  markupMicroUsdc: MicroUsdc,
  totalMicroUsdc: MicroUsdc,
  txHash: EvmTransactionHash,
  ledgerEntryId: Schema.optionalKey(LedgerEntryId),
})
  .check(
    Schema.makeFilter(
      (input) =>
        (input.markupMicroUsdc === fivePercentMarkupMicroUsdc(input.upstreamMicroUsdc) &&
          input.totalMicroUsdc === input.upstreamMicroUsdc + input.markupMicroUsdc) ||
        "accepted receipt markup must be 5% rounded half-up and total must equal upstream plus markup",
      { identifier: "UsageReceiptAcceptedTotal" },
    ),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });
export type UsageReceiptAccepted = typeof UsageReceiptAccepted.Type;

export const UsageReceiptDuplicate = Schema.Struct({
  ...UsageReceiptBaseFields,
  status: Schema.Literal("duplicate"),
  duplicateOfReceiptId: UsageReceiptId,
  reason: Schema.optionalKey(TrimmedNonEmptyString),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type UsageReceiptDuplicate = typeof UsageReceiptDuplicate.Type;

export const UsageReceiptRejected = Schema.Struct({
  ...UsageReceiptBaseFields,
  status: Schema.Literal("rejected"),
  reason: TrimmedNonEmptyString,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type UsageReceiptRejected = typeof UsageReceiptRejected.Type;

export const UsageReceipt = Schema.Union([
  UsageReceiptAccepted,
  UsageReceiptDuplicate,
  UsageReceiptRejected,
]);
export type UsageReceipt = typeof UsageReceipt.Type;

export const LedgerEntryKind = Schema.Literals(["usage", "credit", "adjustment", "settlement"]);
export type LedgerEntryKind = typeof LedgerEntryKind.Type;
export const LedgerEntryDirection = Schema.Literals(["debit", "credit"]);
export type LedgerEntryDirection = typeof LedgerEntryDirection.Type;

export const LedgerEntry = Schema.Struct({
  entryId: LedgerEntryId,
  workspaceId: WorkspaceId,
  environmentId: EnvironmentId,
  kind: LedgerEntryKind,
  direction: LedgerEntryDirection,
  amountMicroUsdc: SignedMicroUsdc,
  sandboxId: Schema.optionalKey(SandboxId),
  threadId: Schema.optionalKey(ThreadId),
  usageReceiptId: Schema.optionalKey(UsageReceiptId),
  settlementId: Schema.optionalKey(SettlementId),
  description: Schema.optionalKey(TrimmedNonEmptyString),
  recordedAt: IsoDateTime,
}).check(
  Schema.makeFilter(
    (input) =>
      (input.kind === "usage"
        ? input.direction === "debit" &&
          input.amountMicroUsdc <= 0 &&
          input.sandboxId !== undefined &&
          input.threadId !== undefined &&
          input.usageReceiptId !== undefined &&
          input.settlementId === undefined
        : input.usageReceiptId === undefined) ||
      "usage ledger debits require negative amount and complete receipt/sandbox/thread identity",
    { identifier: "UsageLedgerEntryIdentity" },
  ),
);
export type LedgerEntry = typeof LedgerEntry.Type;

export const UsageLedgerPosting = Schema.Struct({
  receipt: UsageReceiptAccepted,
  entry: LedgerEntry,
}).check(
  Schema.makeFilter(
    (input) =>
      (input.entry.kind === "usage" &&
        input.entry.direction === "debit" &&
        input.receipt.ledgerEntryId === input.entry.entryId &&
        input.entry.usageReceiptId === input.receipt.receiptId &&
        input.entry.workspaceId === input.receipt.workspaceId &&
        input.entry.environmentId === input.receipt.environmentId &&
        input.entry.sandboxId === input.receipt.sandboxId &&
        input.entry.threadId === input.receipt.threadId &&
        input.entry.amountMicroUsdc === -input.receipt.totalMicroUsdc) ||
      "usage posting must link one accepted receipt to its exact negative ledger debit",
    { identifier: "UsageLedgerPostingLinkage" },
  ),
);
export type UsageLedgerPosting = typeof UsageLedgerPosting.Type;

export const UsageLedgerBatch = Schema.Array(UsageLedgerPosting).check(
  Schema.makeFilter(
    (postings) =>
      (new Set(postings.map((posting) => posting.receipt.receiptId)).size === postings.length &&
        new Set(postings.map((posting) => posting.entry.entryId)).size === postings.length) ||
      "usage ledger batches cannot repeat receipt or ledger entry identities",
    { identifier: "UsageLedgerBatchUnique" },
  ),
);
export type UsageLedgerBatch = typeof UsageLedgerBatch.Type;

export const SettlementState = Schema.Literals(["pending", "finalized", "voided"]);
export type SettlementState = typeof SettlementState.Type;

export const MonadChainIdentity = Schema.Struct({
  namespace: Schema.Literal("eip155"),
  chain: Schema.Literal("monad"),
  chainId: Schema.Literal(MONAD_MAINNET_CHAIN_ID),
  network: Schema.Literal("monad-mainnet"),
  nativeUsdcAddress: Schema.Literal(MONAD_MAINNET_NATIVE_USDC),
  settlementContract: EvmAddress,
  treasuryAddress: EvmAddress,
});
export type MonadChainIdentity = typeof MonadChainIdentity.Type;

export const SettlementTransferIdentity = Schema.Struct({
  txHash: EvmTransactionHash,
  transferId: TrimmedNonEmptyString,
  fromAddress: EvmAddress,
  toAddress: EvmAddress,
  amountMicroUsdc: MicroUsdc,
  blockNumber: Schema.optionalKey(NonNegativeInt),
});
export type SettlementTransferIdentity = typeof SettlementTransferIdentity.Type;

export const SettlementReceiptReference = Schema.Struct({
  receiptId: UsageReceiptId,
  signature: UsageReceiptSignature,
});
export type SettlementReceiptReference = typeof SettlementReceiptReference.Type;

export const Settlement = Schema.Struct({
  settlementId: SettlementId,
  workspaceId: WorkspaceId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  state: SettlementState,
  chainIdentity: MonadChainIdentity,
  transfer: SettlementTransferIdentity,
  usagePostings: UsageLedgerBatch.check(Schema.isMinLength(1)),
  receiptRefs: Schema.Array(SettlementReceiptReference).check(Schema.isMinLength(1)),
  receiptSignatureRoot: TrimmedNonEmptyString,
  signature: UsageReceiptSignature,
  periodStart: IsoDateTime,
  periodEnd: IsoDateTime,
  ledgerEntryIds: Schema.Array(LedgerEntryId).check(Schema.isMinLength(1)),
  debitMicroUsdc: MicroUsdc,
  createdAt: IsoDateTime,
  finalizedAt: Schema.optionalKey(IsoDateTime),
})
  .check(
    Schema.makeFilter(
      (input) =>
        (input.periodStart <= input.periodEnd &&
          (input.state !== "finalized" || input.finalizedAt !== undefined) &&
          (input.finalizedAt === undefined || input.createdAt <= input.finalizedAt)) ||
        "settlement period and finalization fields must be consistent",
      { identifier: "SettlementLifecycle" },
    ),
    Schema.makeFilter(
      (input) => {
        const debitMicroUsdc = input.usagePostings.reduce(
          (total, posting) => total + posting.receipt.totalMicroUsdc,
          0,
        );
        const identitiesMatch = input.usagePostings.every(
          (posting) =>
            posting.receipt.workspaceId === input.workspaceId &&
            posting.receipt.environmentId === input.environmentId &&
            posting.receipt.threadId === input.threadId &&
            posting.entry.workspaceId === input.workspaceId &&
            posting.entry.environmentId === input.environmentId &&
            posting.entry.threadId === input.threadId,
        );
        const ledgerEntryIdsMatch =
          input.ledgerEntryIds.length === input.usagePostings.length &&
          input.ledgerEntryIds.every(
            (entryId, index) => entryId === input.usagePostings[index]?.entry.entryId,
          );
        const receiptRefsMatch =
          input.receiptRefs.length === input.usagePostings.length &&
          input.receiptRefs.every((reference, index) => {
            const receipt = input.usagePostings[index]?.receipt;
            return (
              receipt !== undefined &&
              reference.receiptId === receipt.receiptId &&
              reference.signature.algorithm === receipt.signature.algorithm &&
              reference.signature.keyId === receipt.signature.keyId &&
              reference.signature.payloadHash === receipt.signature.payloadHash &&
              reference.signature.signature === receipt.signature.signature &&
              reference.signature.signedAt === receipt.signature.signedAt
            );
          });

        return (
          (identitiesMatch &&
            ledgerEntryIdsMatch &&
            receiptRefsMatch &&
            input.debitMicroUsdc === debitMicroUsdc &&
            input.transfer.amountMicroUsdc === debitMicroUsdc) ||
          "settlement must exactly bind its accepted usage receipts, ledger debits, tenant, and USDC transfer"
        );
      },
      { identifier: "SettlementUsagePostingBinding" },
    ),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });
export type Settlement = typeof Settlement.Type;
