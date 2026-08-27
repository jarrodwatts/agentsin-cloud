import type {
  CommandId,
  EnvironmentId,
  ProjectId,
  RepositoryIdentity,
  ThreadId,
} from "@t3tools/contracts";
import type {
  EnvironmentRevisionId,
  R2ArtifactReference,
  SandboxId,
  SandboxPtyId,
  WorkspaceId,
} from "@t3tools/contracts/cloud";

export type E2bSandboxState = "running" | "paused";

export interface E2bSandboxDescription {
  readonly sandboxId: string;
  readonly templateId: string;
  readonly state: E2bSandboxState;
  readonly metadata: Readonly<Record<string, string>>;
  readonly startedAt: Date;
  readonly endAt: Date;
  readonly sandboxDomain?: string;
  readonly trafficCredentialRef?: string;
}

export interface E2bCreateInput {
  readonly templateId: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface E2bExecuteInput {
  readonly command: string;
  readonly arguments: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export interface E2bExecutionResult {
  readonly exitCode: number;
  readonly signal?: string;
  readonly stdoutSummary: string;
  readonly stderrSummary: string;
  readonly stdoutArtifact: R2ArtifactReference;
  readonly stderrArtifact: R2ArtifactReference;
}

export interface StreamingArtifactWriter {
  /** Opaque resumable upload identity; safe to persist, unlike the writer object. */
  readonly writerId: string;
  readonly write: (chunk: Uint8Array) => Promise<void>;
  readonly complete: () => Promise<R2ArtifactReference>;
  /** Idempotently removes a partial or completed object when the operation fails. */
  readonly abort: () => Promise<void>;
}

export interface E2bExecutionOutput {
  readonly stdout: StreamingArtifactWriter;
  readonly stderr: StreamingArtifactWriter;
}

export interface E2bFileLimits {
  readonly maxReadBytes: number;
  readonly maxListEntries: number;
  readonly maxListBytes: number;
}

export interface E2bFileEntry {
  readonly path: string;
  readonly type: "file" | "directory" | "symlink";
  readonly sizeBytes: number;
}

export type E2bFileOperation =
  | { readonly type: "read"; readonly path: string }
  | {
      readonly type: "write";
      readonly path: string;
      readonly content: string;
      readonly encoding: "utf8" | "base64";
    }
  | { readonly type: "list"; readonly path: string }
  | { readonly type: "remove"; readonly path: string; readonly recursive: boolean };

export type E2bFileOperationResult =
  | { readonly type: "read"; readonly path: string; readonly bytes: Uint8Array }
  | { readonly type: "list"; readonly path: string; readonly entries: ReadonlyArray<E2bFileEntry> }
  | { readonly type: "write" | "remove"; readonly path: string };

export type E2bPtyOperation =
  | {
      readonly type: "open";
      readonly cwd?: string;
      readonly shell?: string;
      readonly columns: number;
      readonly rows: number;
    }
  | { readonly type: "input"; readonly ptyId: SandboxPtyId; readonly data: string }
  | {
      readonly type: "resize";
      readonly ptyId: SandboxPtyId;
      readonly columns: number;
      readonly rows: number;
    }
  | { readonly type: "close"; readonly ptyId: SandboxPtyId };

export interface E2bPtyResult {
  readonly ptyId: SandboxPtyId;
  readonly state: "open" | "closed";
  readonly outputSummary?: string;
  readonly outputArtifact?: R2ArtifactReference;
}

export interface E2bSnapshot {
  readonly snapshotId: string;
  /** E2B pauses the source sandbox when creating a snapshot. */
  readonly state: "paused";
}

export interface E2bDesktopConnection {
  readonly endpoint: string;
  readonly credentialRef?: string;
}

export interface E2bPort {
  readonly internalPort: number;
  readonly endpoint: string;
}

export interface E2bMetric {
  readonly timestamp: Date;
  readonly cpuUsedPct: number;
  readonly memoryUsedBytes: number;
  readonly memoryTotalBytes: number;
  readonly diskUsedBytes: number;
  readonly diskTotalBytes: number;
}

/** A sanitized upstream error. Its message must never contain request options or credentials. */
export class E2bClientFailure extends Error {
  readonly code:
    | "notFound"
    | "rateLimited"
    | "timeout"
    | "invalidRequest"
    | "outputLimit"
    | "unavailable";
  readonly retryable: boolean;
  readonly createDisposition?:
    | {
        readonly status: "no-compute-confirmed" | "cleanup-confirmed";
        readonly providerHandle?: string;
      }
    | {
        readonly status: "cleanup-required";
        readonly providerHandle?: string;
        /** Non-secret E2B metadata used to locate a create whose response was lost. */
        readonly reclaimMetadata: Readonly<Record<string, string>>;
      };

  constructor(options: {
    readonly code: E2bClientFailure["code"];
    readonly message: string;
    readonly retryable: boolean;
    readonly createDisposition?: E2bClientFailure["createDisposition"];
  }) {
    super(options.message);
    this.name = "E2bClientFailure";
    this.code = options.code;
    this.retryable = options.retryable;
    if (options.createDisposition !== undefined) {
      this.createDisposition = options.createDisposition;
    }
  }
}

/** Narrow SDK seam used by the provider and replaced by a fake in unit tests. */
export interface E2bClient {
  readonly create: (input: E2bCreateInput) => Promise<E2bSandboxDescription>;
  readonly inspect: (sandboxId: string) => Promise<E2bSandboxDescription | undefined>;
  readonly connect: (sandboxId: string, timeoutMs: number) => Promise<E2bSandboxDescription>;
  readonly execute: (
    sandboxId: string,
    input: E2bExecuteInput,
    output: E2bExecutionOutput,
    activeTimeoutMs: number,
  ) => Promise<E2bExecutionResult>;
  readonly files: (
    sandboxId: string,
    operation: E2bFileOperation,
    limits: E2bFileLimits,
    activeTimeoutMs: number,
  ) => Promise<E2bFileOperationResult>;
  readonly pty: (
    sandboxId: string,
    operation: E2bPtyOperation,
    activeTimeoutMs: number,
    output?: StreamingArtifactWriter,
  ) => Promise<E2bPtyResult>;
  readonly pause: (sandboxId: string) => Promise<void>;
  readonly snapshot: (
    sandboxId: string,
    label: string | undefined,
    activeTimeoutMs: number,
  ) => Promise<E2bSnapshot>;
  readonly desktop: (
    sandboxId: string,
    activeTimeoutMs: number,
  ) => Promise<E2bDesktopConnection | undefined>;
  readonly ports: (sandboxId: string, activeTimeoutMs: number) => Promise<ReadonlyArray<E2bPort>>;
  readonly usage: (
    sandboxId: string,
    since: Date,
    until: Date,
  ) => Promise<ReadonlyArray<E2bMetric>>;
  readonly reconcilePtys: (
    sandboxId: string,
    reason: "pause" | "snapshot" | "destroy",
    activeTimeoutMs: number,
  ) => Promise<void>;
  readonly shutdownPtys: (mode: "handoff" | "terminate", activeTimeoutMs: number) => Promise<void>;
  readonly destroy: (sandboxId: string) => Promise<boolean>;
}

export interface SandboxIdentityReservation {
  readonly reservationId: CommandId;
  readonly provider: "e2b";
  readonly workspaceId: WorkspaceId;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly revisionId: EnvironmentRevisionId;
  readonly repositoryIdentity: RepositoryIdentity;
  readonly workspaceDirectory: string;
  readonly requestedAt: string;
}

export interface SandboxIdentityRecord {
  readonly reservationId: CommandId;
  readonly sandboxId: SandboxId;
  readonly provider: "e2b";
  readonly workspaceId: WorkspaceId;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly revisionId: EnvironmentRevisionId;
  readonly repositoryIdentity: RepositoryIdentity;
  readonly workspaceDirectory: string;
  readonly providerHandle: string;
  readonly createdAt: string;
  readonly destroyedAt?: string;
}

export interface SandboxCleanupOrphanRecord {
  readonly orphanId: string;
  readonly reservationId: CommandId;
  readonly identity: SandboxIdentityRecord;
  readonly reason: "identity-registration-failed";
  readonly recordedAt: string;
}

export interface SandboxCreateReconciliationRecord {
  readonly workspaceId: WorkspaceId;
  readonly reservationId: CommandId;
  readonly reason: "remote-create-cleanup-uncertain";
  readonly providerHandle?: string;
  readonly reclaimMetadata: Readonly<Record<string, string>>;
  readonly recordedAt: string;
}

/**
 * Persistence seam. A pending cleanup orphan participates in the same thread uniqueness fence as
 * an active identity, so C3 cannot create another sandbox until it is reclaimed.
 */
export interface SandboxIdentityStore {
  /** Atomically creates the one-sandbox-per-thread fence before remote compute exists. */
  readonly reserve: (record: SandboxIdentityReservation) => Promise<void>;
  /** Atomically replaces the pending reservation with its active sandbox identity. */
  readonly activateReservation: (
    workspaceId: WorkspaceId,
    reservationId: CommandId,
    record: SandboxIdentityRecord,
  ) => Promise<void>;
  readonly markReservationFailed: (
    workspaceId: WorkspaceId,
    reservationId: CommandId,
    failedAt: string,
    reason: "remote-create-failed" | "remote-reclaimed",
  ) => Promise<void>;
  /** Preserves the uniqueness fence while making uncertain remote compute operator-reclaimable. */
  readonly markReservationCleanupRequired: (
    record: SandboxCreateReconciliationRecord,
  ) => Promise<void>;
  readonly get: (
    workspaceId: WorkspaceId,
    sandboxId: SandboxId,
  ) => Promise<SandboxIdentityRecord | undefined>;
  readonly markDestroyed: (
    workspaceId: WorkspaceId,
    sandboxId: SandboxId,
    destroyedAt: string,
  ) => Promise<void>;
  readonly recordCleanupOrphan: (record: SandboxCleanupOrphanRecord) => Promise<void>;
  readonly recordCleanupFailure: (
    workspaceId: WorkspaceId,
    orphanId: string,
    attemptedAt: string,
  ) => Promise<void>;
  readonly markCleanupOrphanReclaimed: (
    workspaceId: WorkspaceId,
    orphanId: string,
    reclaimedAt: string,
  ) => Promise<void>;
}

export interface ArtifactWriteInput {
  readonly workspaceId: WorkspaceId;
  readonly environmentId: EnvironmentId;
  readonly sandboxId: SandboxId;
  readonly requestId: CommandId;
  readonly kind: "command-stdout" | "command-stderr" | "pty-output";
  readonly contentType: "text/plain; charset=utf-8" | "application/octet-stream";
}

/** Large output is streamed to R2 through this seam; only bounded summaries remain inline. */
export interface R2ArtifactWriter {
  readonly open: (input: ArtifactWriteInput) => Promise<StreamingArtifactWriter>;
  readonly resume: (writerId: string) => Promise<StreamingArtifactWriter>;
}

export type E2bPtyTerminalReason =
  | "natural-exit"
  | "explicit-close"
  | "pause"
  | "snapshot"
  | "destroy"
  | "writer-failure"
  | "input-failure"
  | "shutdown";

/** Durable PTY routing/output metadata. SDK CommandHandle objects are never persisted. */
export interface E2bPtySessionRecord {
  readonly sandboxId: string;
  readonly ptyId: SandboxPtyId;
  readonly writerId: string;
  readonly ownerId?: string;
  readonly state: "open" | "closed" | "cleanup-required";
  readonly outputSummary: string;
  readonly outputArtifact?: R2ArtifactReference;
  readonly terminalReason?: E2bPtyTerminalReason;
}

/**
 * Durable/shared ownership seam. `claim` is atomic and may reclaim only an expired or released
 * owner lease; implementations route live owners rather than allowing two output consumers.
 */
export interface E2bPtySessionRegistry {
  readonly create: (record: E2bPtySessionRecord) => Promise<void>;
  /** Read-only routing lookup for the control plane before dispatching to the current owner. */
  readonly get: (
    sandboxId: string,
    ptyId: SandboxPtyId,
  ) => Promise<E2bPtySessionRecord | undefined>;
  readonly claim: (
    sandboxId: string,
    ptyId: SandboxPtyId,
    ownerId: string,
  ) => Promise<E2bPtySessionRecord | undefined>;
  readonly checkpoint: (
    sandboxId: string,
    ptyId: SandboxPtyId,
    ownerId: string,
    outputSummary: string,
  ) => Promise<void>;
  readonly close: (
    sandboxId: string,
    ptyId: SandboxPtyId,
    ownerId: string,
    result: {
      readonly outputSummary: string;
      readonly outputArtifact: R2ArtifactReference;
      readonly terminalReason: E2bPtyTerminalReason;
    },
  ) => Promise<void>;
  readonly markCleanupRequired: (
    sandboxId: string,
    ptyId: SandboxPtyId,
    ownerId: string,
    reason: E2bPtyTerminalReason,
  ) => Promise<void>;
  readonly markReclaimed: (
    sandboxId: string,
    ptyId: SandboxPtyId,
    ownerId: string,
    reason: E2bPtyTerminalReason,
  ) => Promise<void>;
  readonly release: (sandboxId: string, ptyId: SandboxPtyId, ownerId: string) => Promise<void>;
  readonly listReclaimable: (sandboxId?: string) => Promise<ReadonlyArray<E2bPtySessionRecord>>;
}

export interface SandboxProviderClock {
  readonly now: () => Date;
}

/** Seals E2B's traffic token outside the adapter; callers receive only an opaque reference. */
export interface E2bTrafficCredentialBroker {
  readonly seal: (input: {
    readonly sandboxId: string;
    readonly token: string;
    readonly expiresAt: Date;
  }) => Promise<string>;
  readonly revoke: (sandboxId: string) => Promise<void>;
}

/** Distributed/durable lock port. C3 supplies the lease-backed implementation. */
export interface SandboxLifecycleLock {
  readonly withLock: <A>(sandboxId: SandboxId, operation: () => Promise<A>) => Promise<A>;
}

export interface E2bSandboxProviderDependencies {
  readonly client: E2bClient;
  readonly identities: SandboxIdentityStore;
  readonly artifacts: R2ArtifactWriter;
  readonly lifecycleLocks: SandboxLifecycleLock;
  readonly clock: SandboxProviderClock;
  readonly activeTimeoutMs?: number;
  readonly maxInlineFileBytes?: number;
  readonly maxListEntries?: number;
  readonly maxListBytes?: number;
}
