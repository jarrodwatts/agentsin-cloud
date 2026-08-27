/**
 * Hosted cloud-worker wire contracts.
 *
 * The worker proposes provider runtime facts. Only the control plane may turn
 * those proposals into durable `CloudThreadEvent`s and assign their sequence.
 *
 * @module worker
 */
import * as Schema from "effect/Schema";

import {
  ApprovalRequestId,
  CommandId,
  EnvironmentId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  CloudThreadCommand,
  CloudThreadEvent,
  EnvironmentRevisionId,
  GitHubRepositoryRef,
  GitHubThreadBranchName,
  GitHubWorkflowAction,
  GitObjectSha,
  SandboxId,
  WorkspaceId,
} from "./cloud.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ProviderRuntimeEvent } from "./providerRuntime.ts";

const makeWorkerId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(Schema.brand(brand));

export const WorkerInstanceId = makeWorkerId("WorkerInstanceId");
export type WorkerInstanceId = typeof WorkerInstanceId.Type;
export const WorkerDeliveryId = makeWorkerId("WorkerDeliveryId");
export type WorkerDeliveryId = typeof WorkerDeliveryId.Type;
export const WorkerProposalId = makeWorkerId("WorkerProposalId");
export type WorkerProposalId = typeof WorkerProposalId.Type;
export const WorkerSecretLeaseRef = makeWorkerId("WorkerSecretLeaseRef");
export type WorkerSecretLeaseRef = typeof WorkerSecretLeaseRef.Type;
export const WorkerRelayCredentialRef = makeWorkerId("WorkerRelayCredentialRef");
export type WorkerRelayCredentialRef = typeof WorkerRelayCredentialRef.Type;
export const WorkerGitHubOperationId = makeWorkerId("WorkerGitHubOperationId");
export type WorkerGitHubOperationId = typeof WorkerGitHubOperationId.Type;
export const WorkerGitHubTokenLeaseRef = makeWorkerId("WorkerGitHubTokenLeaseRef");
export type WorkerGitHubTokenLeaseRef = typeof WorkerGitHubTokenLeaseRef.Type;
export const WORKER_GITHUB_TOKEN_REDEEM_PATH = "/api/v1/worker-github-token-leases/redeem" as const;
export const WorkerGitHubApprovalGeneration = makeWorkerId("WorkerGitHubApprovalGeneration");
export type WorkerGitHubApprovalGeneration = typeof WorkerGitHubApprovalGeneration.Type;

const WorkerProcessInstanceId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const WorkerCertificateFingerprint = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

/** `-1` is the only empty-log cursor; durable event sequences begin at zero. */
export const WorkerEventCursor = Schema.Int.check(
  Schema.isBetween({ minimum: -1, maximum: Number.MAX_SAFE_INTEGER }),
);
export type WorkerEventCursor = typeof WorkerEventCursor.Type;

const WssEndpoint = TrimmedNonEmptyString.check(
  Schema.isMaxLength(2048),
  Schema.isPattern(/^wss:\/\/[^\s]+$/),
);
const HttpsEndpoint = TrimmedNonEmptyString.check(
  Schema.isMaxLength(2048),
  Schema.isPattern(/^https:\/\/[^\s]+$/),
);
const Sha256Pin = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^sha256\/[A-Za-z0-9+/]{43}=$/),
);
const Base64Der = TrimmedNonEmptyString.check(
  Schema.isMaxLength(16 * 1024),
  Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/),
);
const PemCertificateChain = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64 * 1024),
  Schema.isPattern(/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$/),
);

/**
 * Immutable identity and opaque credential references placed in a sealed file
 * by the sandbox provisioner. The schema intentionally has no raw secret,
 * wallet, signing, or provider-profile field.
 */
export const WorkerBootstrap = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workerId: WorkerInstanceId,
  workspaceId: WorkspaceId,
  environmentId: EnvironmentId,
  environmentRevisionId: EnvironmentRevisionId,
  threadId: ThreadId,
  sandboxId: SandboxId,
  /** C1's durable one-sandbox-per-thread reservation. */
  reservationId: CommandId,
  provider: Schema.Struct({
    instanceId: ProviderInstanceId,
    driver: ProviderDriverKind,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  workspaceDirectory: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  bootstrapEndpoint: HttpsEndpoint,
  relayEndpoint: WssEndpoint,
  /** Pin for the direct Railway TLS service, independent from Web PKI rotation. */
  relayServerSpkiSha256: Sha256Pin,
  relayCredentialRef: WorkerRelayCredentialRef,
  secretLeaseRef: WorkerSecretLeaseRef,
  issuedAt: IsoDateTime,
  expiresAt: IsoDateTime,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type WorkerBootstrap = typeof WorkerBootstrap.Type;

/** Secret-bearing, single-use exchange request. Never persist or log this frame. */
export const WorkerCertificateBootstrapRequest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  token: TrimmedNonEmptyString.check(Schema.isMinLength(32), Schema.isMaxLength(4096)),
  publicKeySpkiDerBase64: Base64Der,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type WorkerCertificateBootstrapRequest = typeof WorkerCertificateBootstrapRequest.Type;

export const WorkerCertificateRotationRequest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  publicKeySpkiDerBase64: Base64Der,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type WorkerCertificateRotationRequest = typeof WorkerCertificateRotationRequest.Type;

export const WorkerCertificateGrant = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  certificateChainPem: PemCertificateChain,
  notBefore: IsoDateTime,
  notAfter: IsoDateTime,
  rotateAfter: IsoDateTime,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type WorkerCertificateGrant = typeof WorkerCertificateGrant.Type;

export const WorkerCommandClaimRequest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  command: CloudThreadCommand,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type WorkerCommandClaimRequest = typeof WorkerCommandClaimRequest.Type;

export const WorkerCommandClaimResponse = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  claim: Schema.Literals(["execute", "completed", "in-flight"]),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type WorkerCommandClaimResponse = typeof WorkerCommandClaimResponse.Type;

export const WorkerRelayCommandDelivery = Schema.Struct({
  type: Schema.Literal("thread.command"),
  deliveryId: WorkerDeliveryId,
  redelivered: Schema.Boolean,
  command: CloudThreadCommand,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type WorkerRelayCommandDelivery = typeof WorkerRelayCommandDelivery.Type;

const WorkerGitHubCommandIdentity = {
  operationId: WorkerGitHubOperationId,
  commandId: CommandId,
  workspaceId: WorkspaceId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  sandboxId: SandboxId,
  repository: GitHubRepositoryRef,
} as const;

/** Exact durable relay route selected by the control plane for one GitHub write. */
export const WorkerGitHubRouteBinding = Schema.Struct({
  workerId: WorkerInstanceId,
  reservationId: CommandId,
  environmentRevisionId: EnvironmentRevisionId,
  providerInstanceId: ProviderInstanceId,
  providerDriver: ProviderDriverKind,
  processInstanceId: WorkerProcessInstanceId,
  certificateFingerprint: WorkerCertificateFingerprint,
  certificateGeneration: PositiveInt,
  leaseGeneration: PositiveInt,
  routeGeneration: PositiveInt,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type WorkerGitHubRouteBinding = typeof WorkerGitHubRouteBinding.Type;

/**
 * Bounded Git operations executed by the authenticated thread worker. The
 * workspace path and raw GitHub token are intentionally absent: the worker
 * derives the path from its sealed bootstrap and materializes an opaque token
 * lease only for the duration of a push.
 */
export const WorkerGitHubCommand = Schema.Union([
  Schema.Struct({
    ...WorkerGitHubCommandIdentity,
    type: Schema.Literal("github.git.prepare-branch"),
    branch: GitHubThreadBranchName,
    baseSha: GitObjectSha,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    ...WorkerGitHubCommandIdentity,
    type: Schema.Literal("github.git.prepare-checkpoint"),
    branch: GitHubThreadBranchName,
    expectedParentSha: GitObjectSha,
    message: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
    committedAt: IsoDateTime,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    ...WorkerGitHubCommandIdentity,
    type: Schema.Literal("github.git.push"),
    branch: GitHubThreadBranchName,
    localSha: GitObjectSha,
    expectedRemoteSha: Schema.NullOr(GitObjectSha),
    tokenLeaseRef: WorkerGitHubTokenLeaseRef,
    approvalId: ApprovalRequestId,
    approvalGeneration: WorkerGitHubApprovalGeneration,
    approvalAction: GitHubWorkflowAction,
    leaseExpiresAt: IsoDateTime,
    routeBinding: WorkerGitHubRouteBinding,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
]);
export type WorkerGitHubCommand = typeof WorkerGitHubCommand.Type;

export const WorkerRelayGitHubCommandDelivery = Schema.Struct({
  type: Schema.Literal("github.command"),
  command: WorkerGitHubCommand,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type WorkerRelayGitHubCommandDelivery = typeof WorkerRelayGitHubCommandDelivery.Type;

const WorkerGitHubTokenLeaseBinding = {
  leaseRef: WorkerGitHubTokenLeaseRef,
  operationId: WorkerGitHubOperationId,
  commandId: CommandId,
  workspaceId: WorkspaceId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  sandboxId: SandboxId,
  repository: GitHubRepositoryRef,
  approvalId: ApprovalRequestId,
  approvalGeneration: WorkerGitHubApprovalGeneration,
  approvalAction: GitHubWorkflowAction,
  leaseExpiresAt: IsoDateTime,
  routeBinding: WorkerGitHubRouteBinding,
} as const;

export const WorkerGitHubTokenRedeemRequest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  ...WorkerGitHubTokenLeaseBinding,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type WorkerGitHubTokenRedeemRequest = typeof WorkerGitHubTokenRedeemRequest.Type;

/** Secret response sent only over the authenticated, pinned worker mTLS channel. */
export const WorkerGitHubTokenRedeemResponse = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  token: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  expiresAt: IsoDateTime,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type WorkerGitHubTokenRedeemResponse = typeof WorkerGitHubTokenRedeemResponse.Type;

/** A durable control-plane confirmation; the worker never constructs it. */
export const WorkerRelayEventConfirmation = Schema.Struct({
  type: Schema.Literal("thread.events.confirmed"),
  proposalId: WorkerProposalId,
  events: Schema.Array(CloudThreadEvent).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type WorkerRelayEventConfirmation = typeof WorkerRelayEventConfirmation.Type;

export const WorkerRelayReplayComplete = Schema.Struct({
  type: Schema.Literal("replay.complete"),
  confirmedThroughSequence: WorkerEventCursor,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type WorkerRelayReplayComplete = typeof WorkerRelayReplayComplete.Type;

export const WorkerRelayShutdown = Schema.Struct({
  type: Schema.Literal("worker.shutdown"),
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type WorkerRelayShutdown = typeof WorkerRelayShutdown.Type;

export const WorkerRelayInbound = Schema.Union([
  WorkerRelayCommandDelivery,
  WorkerRelayGitHubCommandDelivery,
  WorkerRelayEventConfirmation,
  WorkerRelayReplayComplete,
  WorkerRelayShutdown,
]);
export type WorkerRelayInbound = typeof WorkerRelayInbound.Type;

export const WorkerCommandAckStatus = Schema.Literals([
  "accepted",
  "duplicate",
  "needs-reconciliation",
  "rejected",
  "failed",
]);
export type WorkerCommandAckStatus = typeof WorkerCommandAckStatus.Type;

export const WorkerRelayCommandAck = Schema.Struct({
  type: Schema.Literal("thread.command.ack"),
  deliveryId: WorkerDeliveryId,
  commandId: CommandId,
  status: WorkerCommandAckStatus,
  detail: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
  acknowledgedAt: IsoDateTime,
});
export type WorkerRelayCommandAck = typeof WorkerRelayCommandAck.Type;

/**
 * A non-authoritative provider fact. It deliberately contains no durable
 * orchestration event id or sequence.
 */
export const WorkerRelayEventProposal = Schema.Struct({
  type: Schema.Literal("provider.event.proposed"),
  proposalId: WorkerProposalId,
  causedByCommandId: Schema.optionalKey(CommandId),
  runtimeEvent: ProviderRuntimeEvent,
  proposedAt: IsoDateTime,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type WorkerRelayEventProposal = typeof WorkerRelayEventProposal.Type;

export const WorkerRelayEventAck = Schema.Struct({
  type: Schema.Literal("thread.events.ack"),
  proposalId: WorkerProposalId,
  eventIds: Schema.Array(EventId).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  confirmedThroughSequence: WorkerEventCursor,
  acknowledgedAt: IsoDateTime,
});
export type WorkerRelayEventAck = typeof WorkerRelayEventAck.Type;

export const WorkerProviderState = Schema.Literals([
  "starting",
  "ready",
  "restarting",
  "failed",
  "stopped",
]);
export type WorkerProviderState = typeof WorkerProviderState.Type;

export const WorkerRelayState = Schema.Literals(["connecting", "connected", "replaying"]);
export type WorkerRelayState = typeof WorkerRelayState.Type;

export const WorkerRecoveryState = Schema.Literals(["healthy", "needs-reconciliation"]);
export type WorkerRecoveryState = typeof WorkerRecoveryState.Type;

export const WorkerHealth = Schema.Struct({
  workerId: WorkerInstanceId,
  workspaceId: WorkspaceId,
  environmentId: EnvironmentId,
  environmentRevisionId: EnvironmentRevisionId,
  threadId: ThreadId,
  sandboxId: SandboxId,
  providerState: WorkerProviderState,
  relayState: WorkerRelayState,
  recoveryState: WorkerRecoveryState,
  ready: Schema.Boolean,
  queuedCommands: NonNegativeInt,
  pendingEventProposals: NonNegativeInt,
  confirmedThroughSequence: WorkerEventCursor,
  providerRestartCount: NonNegativeInt,
  observedAt: IsoDateTime,
});
export type WorkerHealth = typeof WorkerHealth.Type;

export const WorkerRelayHeartbeat = Schema.Struct({
  type: Schema.Literal("worker.heartbeat"),
  heartbeatSequence: PositiveInt,
  health: WorkerHealth,
});
export type WorkerRelayHeartbeat = typeof WorkerRelayHeartbeat.Type;

export const WorkerRelayReady = Schema.Struct({
  type: Schema.Literal("worker.ready"),
  health: WorkerHealth,
});
export type WorkerRelayReady = typeof WorkerRelayReady.Type;

export const WorkerRelayFailure = Schema.Struct({
  type: Schema.Literal("worker.failure"),
  code: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  retryable: Schema.Boolean,
  detail: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  occurredAt: IsoDateTime,
});
export type WorkerRelayFailure = typeof WorkerRelayFailure.Type;

export const WorkerGitHubCommandFailureCode = Schema.Literals([
  "identityMismatch",
  "repositoryMismatch",
  "invalidHistory",
  "ambiguousIntent",
  "secretPath",
  "nonFastForward",
  "tokenExpired",
  "gitFailure",
]);
export type WorkerGitHubCommandFailureCode = typeof WorkerGitHubCommandFailureCode.Type;

export const WorkerRelayGitHubCommandResult = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("github.command.result"),
    operationId: WorkerGitHubOperationId,
    commandId: CommandId,
    status: Schema.Literal("prepared"),
    localSha: GitObjectSha,
    completedAt: IsoDateTime,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    type: Schema.Literal("github.command.result"),
    operationId: WorkerGitHubOperationId,
    commandId: CommandId,
    status: Schema.Literal("pushed"),
    completedAt: IsoDateTime,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    type: Schema.Literal("github.command.result"),
    operationId: WorkerGitHubOperationId,
    commandId: CommandId,
    status: Schema.Literal("failed"),
    code: WorkerGitHubCommandFailureCode,
    retryable: Schema.Boolean,
    detail: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
    completedAt: IsoDateTime,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
]);
export type WorkerRelayGitHubCommandResult = typeof WorkerRelayGitHubCommandResult.Type;

export const WorkerRelayOutbound = Schema.Union([
  WorkerRelayCommandAck,
  WorkerRelayEventProposal,
  WorkerRelayEventAck,
  WorkerRelayHeartbeat,
  WorkerRelayReady,
  WorkerRelayFailure,
  WorkerRelayGitHubCommandResult,
]);
export type WorkerRelayOutbound = typeof WorkerRelayOutbound.Type;
