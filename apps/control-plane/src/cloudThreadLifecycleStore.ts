import type {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { RepositoryIdentity } from "@t3tools/contracts";
import type {
  EnvironmentRevisionId,
  SandboxProviderSandbox,
  WorkspaceId,
} from "@t3tools/contracts/cloud";
import type { WorkerInstanceId } from "@t3tools/contracts/worker";
import * as Schema from "effect/Schema";
import type { Pool, PoolClient, QueryResultRow } from "pg";

const decodeRepositoryIdentity = Schema.decodeUnknownSync(RepositoryIdentity);

export type CloudThreadLifecycleState =
  | "reserved"
  | "create_dispatched"
  | "sandbox_ready"
  | "bootstrap_dispatched"
  | "bootstrap_ready"
  | "worker_start_dispatched"
  | "ready"
  | "cleanup_required"
  | "failed";

export type CloudThreadLifecycleStep = "create_sandbox" | "issue_bootstrap" | "start_worker";

export interface CloudThreadLifecycleAttempt {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly attemptId: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly environmentId: EnvironmentId;
  readonly environmentRevisionId: EnvironmentRevisionId;
  readonly environmentRevisionHash: string;
  readonly projectId: ProjectId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerDriver: ProviderDriverKind;
  readonly repositoryIdentity: RepositoryIdentity;
  readonly workspaceDirectory: string;
  readonly state: CloudThreadLifecycleState;
  readonly isCurrent: boolean;
  readonly sandboxId?: SandboxProviderSandbox["sandboxId"];
  readonly providerHandle?: string;
  readonly workerId?: WorkerInstanceId;
  readonly sealedBootstrapRef?: string;
  readonly failureCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ReserveCloudThreadLifecycleInput = Omit<
  CloudThreadLifecycleAttempt,
  | "state"
  | "isCurrent"
  | "sandboxId"
  | "providerHandle"
  | "workerId"
  | "sealedBootstrapRef"
  | "failureCode"
  | "updatedAt"
>;

export interface CloudThreadLifecycleStore {
  readonly reserve: (input: ReserveCloudThreadLifecycleInput) => Promise<{
    readonly disposition: "created" | "existing";
    readonly attempt: CloudThreadLifecycleAttempt;
  }>;
  readonly getCurrent: (
    workspaceId: WorkspaceId,
    threadId: ThreadId,
  ) => Promise<CloudThreadLifecycleAttempt | undefined>;
  readonly getAttempt: (
    workspaceId: WorkspaceId,
    attemptId: string,
  ) => Promise<CloudThreadLifecycleAttempt | undefined>;
  readonly claim: (
    attempt: CloudThreadLifecycleAttempt,
    step: CloudThreadLifecycleStep,
    expectedState: CloudThreadLifecycleState,
    dispatchedState: CloudThreadLifecycleState,
    now: string,
    leaseExpiresAt: string,
  ) => Promise<boolean>;
  readonly recordSandbox: (
    attempt: CloudThreadLifecycleAttempt,
    sandbox: SandboxProviderSandbox,
    now: string,
  ) => Promise<CloudThreadLifecycleAttempt>;
  readonly recordBootstrap: (
    attempt: CloudThreadLifecycleAttempt,
    workerId: WorkerInstanceId,
    sealedBootstrapRef: string,
    now: string,
  ) => Promise<CloudThreadLifecycleAttempt>;
  readonly markReady: (
    attempt: CloudThreadLifecycleAttempt,
    now: string,
  ) => Promise<CloudThreadLifecycleAttempt>;
  readonly resetStep: (
    attempt: CloudThreadLifecycleAttempt,
    step: CloudThreadLifecycleStep,
    resetState: CloudThreadLifecycleState,
    now: string,
    errorCode: string,
  ) => Promise<CloudThreadLifecycleAttempt>;
  readonly markCleanupRequired: (
    attempt: CloudThreadLifecycleAttempt,
    now: string,
    errorCode: string,
  ) => Promise<CloudThreadLifecycleAttempt>;
  readonly markFailed: (
    attempt: CloudThreadLifecycleAttempt,
    now: string,
    errorCode: string,
  ) => Promise<CloudThreadLifecycleAttempt>;
  readonly listRecoverable: (
    now: string,
    limit: number,
  ) => Promise<ReadonlyArray<CloudThreadLifecycleAttempt>>;
}

export class CloudThreadLifecycleStoreError extends Error {
  readonly code: "conflict" | "notFound" | "databaseFailure";

  constructor(code: CloudThreadLifecycleStoreError["code"], message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "CloudThreadLifecycleStoreError";
    this.code = code;
  }
}

interface AttemptRow extends QueryResultRow {
  readonly workspace_id: string;
  readonly thread_id: string;
  readonly attempt_id: string;
  readonly idempotency_key: string;
  readonly request_fingerprint: string;
  readonly environment_id: string;
  readonly environment_revision_id: string;
  readonly environment_revision_hash: string;
  readonly project_id: string;
  readonly provider_instance_id: string;
  readonly provider_driver: ProviderDriverKind;
  readonly repository_identity: unknown;
  readonly workspace_directory: string;
  readonly sandbox_id: string | null;
  readonly provider_handle: string | null;
  readonly worker_id: string | null;
  readonly sealed_bootstrap_ref: string | null;
  readonly state: CloudThreadLifecycleState;
  readonly is_current: boolean;
  readonly failure_code: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const attemptColumns = `workspace_id::text AS workspace_id, thread_id, attempt_id, idempotency_key,
  request_fingerprint, environment_id, environment_revision_id, environment_revision_hash,
  project_id, provider_instance_id, provider_driver, repository_identity, workspace_directory,
  sandbox_id, provider_handle, worker_id, sealed_bootstrap_ref, state, is_current, failure_code,
  created_at::text AS created_at, updated_at::text AS updated_at`;

const qualifiedAttemptColumns = `attempt.workspace_id::text AS workspace_id,
  attempt.thread_id, attempt.attempt_id, attempt.idempotency_key, attempt.request_fingerprint,
  attempt.environment_id, attempt.environment_revision_id, attempt.environment_revision_hash,
  attempt.project_id, attempt.provider_instance_id, attempt.provider_driver,
  attempt.repository_identity, attempt.workspace_directory, attempt.sandbox_id,
  attempt.provider_handle, attempt.worker_id, attempt.sealed_bootstrap_ref, attempt.state,
  attempt.is_current, attempt.failure_code, attempt.created_at::text AS created_at,
  attempt.updated_at::text AS updated_at`;

const toAttempt = (row: AttemptRow): CloudThreadLifecycleAttempt => ({
  workspaceId: row.workspace_id as WorkspaceId,
  threadId: row.thread_id as ThreadId,
  attemptId: row.attempt_id,
  idempotencyKey: row.idempotency_key,
  requestFingerprint: row.request_fingerprint,
  environmentId: row.environment_id as EnvironmentId,
  environmentRevisionId: row.environment_revision_id as EnvironmentRevisionId,
  environmentRevisionHash: row.environment_revision_hash,
  projectId: row.project_id as ProjectId,
  providerInstanceId: row.provider_instance_id as ProviderInstanceId,
  providerDriver: row.provider_driver,
  repositoryIdentity: decodeRepositoryIdentity(row.repository_identity),
  workspaceDirectory: row.workspace_directory,
  state: row.state,
  isCurrent: row.is_current,
  ...(row.sandbox_id === null
    ? {}
    : { sandboxId: row.sandbox_id as SandboxProviderSandbox["sandboxId"] }),
  ...(row.provider_handle === null ? {} : { providerHandle: row.provider_handle }),
  ...(row.worker_id === null ? {} : { workerId: row.worker_id as WorkerInstanceId }),
  ...(row.sealed_bootstrap_ref === null ? {} : { sealedBootstrapRef: row.sealed_bootstrap_ref }),
  ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const transaction = async <A>(pool: Pool, use: (client: PoolClient) => Promise<A>) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await use(client);
    await client.query("COMMIT");
    return value;
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (cause instanceof CloudThreadLifecycleStoreError) throw cause;
    throw new CloudThreadLifecycleStoreError(
      "databaseFailure",
      "Cloud thread lifecycle transaction failed",
      cause,
    );
  } finally {
    client.release();
  }
};

const loadAttempt = async (client: PoolClient, workspaceId: WorkspaceId, attemptId: string) => {
  const result = await client.query<AttemptRow>(
    `SELECT ${attemptColumns}
       FROM cloud_thread_lifecycle_attempt
      WHERE workspace_id = $1 AND attempt_id = $2
      FOR UPDATE`,
    [workspaceId, attemptId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new CloudThreadLifecycleStoreError("notFound", "Cloud lifecycle attempt was not found");
  }
  return toAttempt(row);
};

const exactRequest = (
  existing: CloudThreadLifecycleAttempt,
  input: ReserveCloudThreadLifecycleInput,
) =>
  existing.requestFingerprint === input.requestFingerprint &&
  existing.environmentId === input.environmentId &&
  existing.environmentRevisionId === input.environmentRevisionId &&
  existing.environmentRevisionHash === input.environmentRevisionHash &&
  existing.projectId === input.projectId &&
  existing.providerInstanceId === input.providerInstanceId &&
  existing.providerDriver === input.providerDriver;

export const makePostgresCloudThreadLifecycleStore = (pool: Pool): CloudThreadLifecycleStore => ({
  reserve: (input) =>
    transaction(pool, async (client) => {
      await client.query(
        `SELECT thread_id FROM cloud_thread
          WHERE workspace_id = $1 AND thread_id = $2 AND environment_id = $3
          FOR UPDATE`,
        [input.workspaceId, input.threadId, input.environmentId],
      );
      const currentResult = await client.query<AttemptRow>(
        `SELECT ${attemptColumns}
           FROM cloud_thread_lifecycle_attempt
          WHERE workspace_id = $1 AND thread_id = $2 AND is_current
          FOR UPDATE`,
        [input.workspaceId, input.threadId],
      );
      const currentRow = currentResult.rows[0];
      if (currentRow !== undefined) {
        const current = toAttempt(currentRow);
        if (!exactRequest(current, input)) {
          throw new CloudThreadLifecycleStoreError(
            "conflict",
            "Thread already has a current sandbox for a different immutable environment",
          );
        }
        return { disposition: "existing" as const, attempt: current };
      }

      const idempotencyResult = await client.query<AttemptRow>(
        `SELECT ${attemptColumns}
           FROM cloud_thread_lifecycle_attempt
          WHERE workspace_id = $1 AND idempotency_key = $2
          FOR UPDATE`,
        [input.workspaceId, input.idempotencyKey],
      );
      const idempotentRow = idempotencyResult.rows[0];
      if (idempotentRow !== undefined) {
        const existing = toAttempt(idempotentRow);
        if (!exactRequest(existing, input) || existing.threadId !== input.threadId) {
          throw new CloudThreadLifecycleStoreError(
            "conflict",
            "Cloud thread create idempotency key was reused with another request",
          );
        }
        return { disposition: "existing" as const, attempt: existing };
      }

      await client.query(
        `INSERT INTO cloud_thread_lifecycle_attempt
          (workspace_id, thread_id, attempt_id, idempotency_key, request_fingerprint,
           environment_id, environment_revision_id, environment_revision_hash, project_id,
           provider_instance_id, provider_driver, repository_identity, workspace_directory,
           state, is_current, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13,
                 'reserved', true, $14, $14)`,
        [
          input.workspaceId,
          input.threadId,
          input.attemptId,
          input.idempotencyKey,
          input.requestFingerprint,
          input.environmentId,
          input.environmentRevisionId,
          input.environmentRevisionHash,
          input.projectId,
          input.providerInstanceId,
          input.providerDriver,
          JSON.stringify(input.repositoryIdentity),
          input.workspaceDirectory,
          input.createdAt,
        ],
      );
      await client.query(
        `INSERT INTO cloud_thread_lifecycle_outbox
          (workspace_id, attempt_id, step, status, created_at, updated_at)
         VALUES ($1, $2, 'create_sandbox', 'pending', $3, $3)`,
        [input.workspaceId, input.attemptId, input.createdAt],
      );
      return {
        disposition: "created" as const,
        attempt: await loadAttempt(client, input.workspaceId, input.attemptId),
      };
    }),

  getCurrent: async (workspaceId, threadId) => {
    const result = await pool.query<AttemptRow>(
      `SELECT ${attemptColumns}
         FROM cloud_thread_lifecycle_attempt
        WHERE workspace_id = $1 AND thread_id = $2 AND is_current`,
      [workspaceId, threadId],
    );
    return result.rows[0] === undefined ? undefined : toAttempt(result.rows[0]);
  },

  getAttempt: async (workspaceId, attemptId) => {
    const result = await pool.query<AttemptRow>(
      `SELECT ${attemptColumns}
         FROM cloud_thread_lifecycle_attempt
        WHERE workspace_id = $1 AND attempt_id = $2`,
      [workspaceId, attemptId],
    );
    return result.rows[0] === undefined ? undefined : toAttempt(result.rows[0]);
  },

  claim: (attempt, step, expectedState, dispatchedState, now, leaseExpiresAt) =>
    transaction(pool, async (client) => {
      const outbox = await client.query(
        `UPDATE cloud_thread_lifecycle_outbox
            SET status = 'processing', attempt_count = attempt_count + 1,
                lease_expires_at = $4, updated_at = $3
          WHERE workspace_id = $1 AND attempt_id = $2 AND step = $5 AND status = 'pending'
          RETURNING step`,
        [attempt.workspaceId, attempt.attemptId, now, leaseExpiresAt, step],
      );
      if (outbox.rowCount !== 1) return false;
      const updated = await client.query(
        `UPDATE cloud_thread_lifecycle_attempt
            SET state = $4, updated_at = $3
          WHERE workspace_id = $1 AND attempt_id = $2 AND state = $5 AND is_current
          RETURNING attempt_id`,
        [attempt.workspaceId, attempt.attemptId, now, dispatchedState, expectedState],
      );
      if (updated.rowCount !== 1) {
        throw new CloudThreadLifecycleStoreError(
          "conflict",
          "Cloud lifecycle step no longer matches its durable state",
        );
      }
      return true;
    }),

  recordSandbox: (attempt, sandbox, now) =>
    transaction(pool, async (client) => {
      if (
        sandbox.workspaceId !== attempt.workspaceId ||
        sandbox.workspace.threadId !== attempt.threadId ||
        sandbox.environmentId !== attempt.environmentId ||
        sandbox.revisionId !== attempt.environmentRevisionId ||
        sandbox.infrastructureProvider !== "e2b"
      ) {
        throw new CloudThreadLifecycleStoreError(
          "conflict",
          "E2B sandbox identity does not match the reserved thread",
        );
      }
      const updated = await client.query(
        `UPDATE cloud_thread_lifecycle_attempt
            SET sandbox_id = $4, provider_handle = $5, state = 'sandbox_ready', updated_at = $3
          WHERE workspace_id = $1 AND attempt_id = $2
            AND state IN ('create_dispatched', 'sandbox_ready') AND is_current
            AND (sandbox_id IS NULL OR sandbox_id = $4)
            AND (provider_handle IS NULL OR provider_handle = $5)
          RETURNING attempt_id`,
        [attempt.workspaceId, attempt.attemptId, now, sandbox.sandboxId, sandbox.providerHandle],
      );
      if (updated.rowCount !== 1) {
        throw new CloudThreadLifecycleStoreError("conflict", "Sandbox result arrived stale");
      }
      await client.query(
        `UPDATE cloud_thread_lifecycle_outbox
            SET status = 'completed', completed_at = $3, lease_expires_at = NULL, updated_at = $3
          WHERE workspace_id = $1 AND attempt_id = $2 AND step = 'create_sandbox'`,
        [attempt.workspaceId, attempt.attemptId, now],
      );
      await client.query(
        `INSERT INTO cloud_thread_lifecycle_outbox
          (workspace_id, attempt_id, step, status, created_at, updated_at)
         VALUES ($1, $2, 'issue_bootstrap', 'pending', $3, $3)
         ON CONFLICT (workspace_id, attempt_id, step) DO NOTHING`,
        [attempt.workspaceId, attempt.attemptId, now],
      );
      return loadAttempt(client, attempt.workspaceId, attempt.attemptId);
    }),

  recordBootstrap: (attempt, workerId, sealedBootstrapRef, now) =>
    transaction(pool, async (client) => {
      const updated = await client.query(
        `UPDATE cloud_thread_lifecycle_attempt
            SET worker_id = $4, sealed_bootstrap_ref = $5, state = 'bootstrap_ready', updated_at = $3
          WHERE workspace_id = $1 AND attempt_id = $2
            AND state IN ('bootstrap_dispatched', 'bootstrap_ready') AND is_current
            AND (worker_id IS NULL OR worker_id = $4)
            AND (sealed_bootstrap_ref IS NULL OR sealed_bootstrap_ref = $5)
          RETURNING attempt_id`,
        [attempt.workspaceId, attempt.attemptId, now, workerId, sealedBootstrapRef],
      );
      if (updated.rowCount !== 1) {
        throw new CloudThreadLifecycleStoreError("conflict", "Worker bootstrap arrived stale");
      }
      await client.query(
        `UPDATE cloud_thread_lifecycle_outbox
            SET status = 'completed', completed_at = $3, lease_expires_at = NULL, updated_at = $3
          WHERE workspace_id = $1 AND attempt_id = $2 AND step = 'issue_bootstrap'`,
        [attempt.workspaceId, attempt.attemptId, now],
      );
      await client.query(
        `INSERT INTO cloud_thread_lifecycle_outbox
          (workspace_id, attempt_id, step, status, created_at, updated_at)
         VALUES ($1, $2, 'start_worker', 'pending', $3, $3)
         ON CONFLICT (workspace_id, attempt_id, step) DO NOTHING`,
        [attempt.workspaceId, attempt.attemptId, now],
      );
      return loadAttempt(client, attempt.workspaceId, attempt.attemptId);
    }),

  markReady: (attempt, now) =>
    transaction(pool, async (client) => {
      const updated = await client.query(
        `UPDATE cloud_thread_lifecycle_attempt
            SET state = 'ready', updated_at = $3, completed_at = $3
          WHERE workspace_id = $1 AND attempt_id = $2
            AND state IN ('worker_start_dispatched', 'ready') AND is_current
          RETURNING attempt_id`,
        [attempt.workspaceId, attempt.attemptId, now],
      );
      if (updated.rowCount !== 1) {
        throw new CloudThreadLifecycleStoreError("conflict", "Worker-ready receipt arrived stale");
      }
      await client.query(
        `UPDATE cloud_thread_lifecycle_outbox
            SET status = 'completed', completed_at = $3, lease_expires_at = NULL, updated_at = $3
          WHERE workspace_id = $1 AND attempt_id = $2 AND step = 'start_worker'`,
        [attempt.workspaceId, attempt.attemptId, now],
      );
      return loadAttempt(client, attempt.workspaceId, attempt.attemptId);
    }),

  resetStep: (attempt, step, resetState, now, errorCode) =>
    transaction(pool, async (client) => {
      const updated = await client.query(
        `UPDATE cloud_thread_lifecycle_attempt
            SET state = $4, failure_code = $5, updated_at = $3
          WHERE workspace_id = $1 AND attempt_id = $2 AND is_current AND state = $6
          RETURNING attempt_id`,
        [attempt.workspaceId, attempt.attemptId, now, resetState, errorCode, attempt.state],
      );
      if (updated.rowCount !== 1) {
        throw new CloudThreadLifecycleStoreError("conflict", "Retry receipt arrived stale");
      }
      await client.query(
        `UPDATE cloud_thread_lifecycle_outbox
            SET status = 'pending', lease_expires_at = NULL, last_error_code = $4, updated_at = $3
          WHERE workspace_id = $1 AND attempt_id = $2 AND step = $5`,
        [attempt.workspaceId, attempt.attemptId, now, errorCode, step],
      );
      return loadAttempt(client, attempt.workspaceId, attempt.attemptId);
    }),

  markCleanupRequired: (attempt, now, errorCode) =>
    transaction(pool, async (client) => {
      const updated = await client.query(
        `UPDATE cloud_thread_lifecycle_attempt
            SET state = 'cleanup_required', failure_code = $3, updated_at = $4
          WHERE workspace_id = $1 AND attempt_id = $2 AND is_current AND state = $5
          RETURNING attempt_id`,
        [attempt.workspaceId, attempt.attemptId, errorCode, now, attempt.state],
      );
      if (updated.rowCount !== 1) {
        throw new CloudThreadLifecycleStoreError("conflict", "Cleanup receipt arrived stale");
      }
      await client.query(
        `UPDATE cloud_thread_lifecycle_outbox
            SET status = 'failed', lease_expires_at = NULL, last_error_code = $3, updated_at = $4
          WHERE workspace_id = $1 AND attempt_id = $2 AND status <> 'completed'`,
        [attempt.workspaceId, attempt.attemptId, errorCode, now],
      );
      return loadAttempt(client, attempt.workspaceId, attempt.attemptId);
    }),

  markFailed: (attempt, now, errorCode) =>
    transaction(pool, async (client) => {
      const updated = await client.query(
        `UPDATE cloud_thread_lifecycle_attempt
            SET state = 'failed', is_current = false, failure_code = $3,
                updated_at = $4, completed_at = $4
          WHERE workspace_id = $1 AND attempt_id = $2 AND is_current AND state = $5
          RETURNING attempt_id`,
        [attempt.workspaceId, attempt.attemptId, errorCode, now, attempt.state],
      );
      if (updated.rowCount !== 1) {
        throw new CloudThreadLifecycleStoreError("conflict", "Failure receipt arrived stale");
      }
      await client.query(
        `UPDATE cloud_thread_lifecycle_outbox
            SET status = 'failed', lease_expires_at = NULL, last_error_code = $3, updated_at = $4
          WHERE workspace_id = $1 AND attempt_id = $2 AND status <> 'completed'`,
        [attempt.workspaceId, attempt.attemptId, errorCode, now],
      );
      return loadAttempt(client, attempt.workspaceId, attempt.attemptId);
    }),

  listRecoverable: async (now, limit) => {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const result = await pool.query<AttemptRow>(
      `SELECT ${qualifiedAttemptColumns}
         FROM cloud_thread_lifecycle_attempt AS attempt
         JOIN cloud_thread_lifecycle_outbox AS outbox
           ON outbox.workspace_id = attempt.workspace_id AND outbox.attempt_id = attempt.attempt_id
        WHERE attempt.is_current
          AND outbox.status IN ('pending', 'processing')
          AND (outbox.status = 'pending' OR outbox.lease_expires_at <= $1)
        ORDER BY attempt.updated_at ASC, attempt.attempt_id ASC
        LIMIT $2`,
      [now, boundedLimit],
    );
    return result.rows.map(toAttempt);
  },
});
