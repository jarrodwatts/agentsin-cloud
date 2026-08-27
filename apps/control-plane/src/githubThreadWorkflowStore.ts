// @effect-diagnostics nodeBuiltinImport:off -- Durable command fingerprints use audited SHA-256.
import * as NodeCrypto from "node:crypto";

import type { AuthSessionId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  GitHubThreadWorkflowCommand,
  GitHubThreadWorkflowEvent,
  type GitHubRepositoryRef,
  type GitHubThreadBranchName,
  type GitHubThreadWorkflowView,
  type GitObjectSha,
  type WorkspaceId,
} from "@t3tools/contracts/cloud";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { PoolClient, QueryResultRow } from "pg";

import type { DatabaseService } from "./database.ts";

export class GitHubWorkflowStoreError extends Schema.TaggedErrorClass<GitHubWorkflowStoreError>()(
  "GitHubWorkflowStoreError",
  {
    code: Schema.Literals([
      "notFound",
      "tenantMismatch",
      "repositoryDenied",
      "idempotencyConflict",
      "stateConflict",
      "databaseFailure",
      "invalidRecord",
    ]),
    operation: Schema.String,
    retryable: Schema.Boolean,
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {}

export interface GitHubRepositoryGrantRecord {
  readonly workspaceId: WorkspaceId;
  readonly repository: GitHubRepositoryRef;
  readonly repositoryId: number;
  readonly canPush: boolean;
  readonly canPullRequests: boolean;
}

export interface GitHubWorkflowSubmission {
  readonly disposition: "accepted" | "duplicate";
  readonly commandId: string;
}

export interface ClaimedGitHubWorkflowEffect {
  readonly effectId: string;
  readonly command: GitHubThreadWorkflowCommand;
  readonly workflow: Omit<GitHubThreadWorkflowView, "events">;
  readonly actorUserId: string;
  readonly authSessionId: AuthSessionId;
  readonly expectedParentSha?: GitObjectSha;
  readonly preparedSha?: GitObjectSha;
  readonly attemptCount: number;
}

export type GitHubWorkflowCompletion =
  | { readonly type: "branch"; readonly remoteHeadSha: GitObjectSha }
  | { readonly type: "checkpoint"; readonly remoteHeadSha: GitObjectSha }
  | {
      readonly type: "draftPullRequest";
      readonly pullRequest: { readonly number: number; readonly url: string; readonly draft: true };
    }
  | {
      readonly type: "readyPullRequest";
      readonly pullRequest: {
        readonly number: number;
        readonly url: string;
        readonly draft: false;
      };
    };

export interface GitHubWorkflowStore {
  readonly registerRepository: (
    record: GitHubRepositoryGrantRecord,
  ) => Effect.Effect<void, GitHubWorkflowStoreError>;
  readonly getRepository: (
    workspaceId: WorkspaceId,
    canonicalKey: string,
  ) => Effect.Effect<GitHubRepositoryGrantRecord | undefined, GitHubWorkflowStoreError>;
  readonly submit: (input: {
    readonly idempotencyKey: string;
    readonly command: GitHubThreadWorkflowCommand;
    readonly branchName?: GitHubThreadBranchName;
    readonly actorUserId: string;
    readonly authSessionId: AuthSessionId;
  }) => Effect.Effect<GitHubWorkflowSubmission, GitHubWorkflowStoreError>;
  readonly claim: (input: {
    readonly workspaceId: WorkspaceId;
    readonly commandId: string;
    readonly now: string;
    readonly leaseExpiresAt: string;
  }) => Effect.Effect<ClaimedGitHubWorkflowEffect | undefined, GitHubWorkflowStoreError>;
  readonly claimNext: (input: {
    readonly workspaceId: WorkspaceId;
    readonly now: string;
    readonly leaseExpiresAt: string;
  }) => Effect.Effect<ClaimedGitHubWorkflowEffect | undefined, GitHubWorkflowStoreError>;
  readonly savePreparedSha: (
    workspaceId: WorkspaceId,
    commandId: string,
    sha: GitObjectSha,
    attemptCount: number,
  ) => Effect.Effect<void, GitHubWorkflowStoreError>;
  readonly complete: (input: {
    readonly workspaceId: WorkspaceId;
    readonly commandId: string;
    readonly attemptCount: number;
    readonly completion: GitHubWorkflowCompletion;
    readonly occurredAt: string;
  }) => Effect.Effect<void, GitHubWorkflowStoreError>;
  readonly fail: (input: {
    readonly workspaceId: WorkspaceId;
    readonly commandId: string;
    readonly attemptCount: number;
    readonly code: string;
    readonly summary: string;
    readonly retryable: boolean;
    readonly conflict: boolean;
    readonly occurredAt: string;
    readonly retryAt?: string;
  }) => Effect.Effect<void, GitHubWorkflowStoreError>;
  readonly get: (
    workspaceId: WorkspaceId,
    threadId: ThreadId,
  ) => Effect.Effect<GitHubThreadWorkflowView | undefined, GitHubWorkflowStoreError>;
}

const decodeCommand = Schema.decodeUnknownSync(GitHubThreadWorkflowCommand);
const decodeEvent = Schema.decodeUnknownSync(GitHubThreadWorkflowEvent);
const isGitHubWorkflowStoreError = Schema.is(GitHubWorkflowStoreError);

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

const fingerprint = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonicalJson(value)).digest("hex");

const effectTypeFor = (command: GitHubThreadWorkflowCommand) => command.type;
const eventIdFor = (commandId: string) => `github-event-${commandId}`;
const effectIdFor = (commandId: string) => `github-effect-${commandId}`;

const failure = (
  code: GitHubWorkflowStoreError["code"],
  operation: string,
  retryable = false,
  cause?: unknown,
) => new GitHubWorkflowStoreError({ code, operation, retryable, ...(cause ? { cause } : {}) });

const transaction = <A>(
  database: DatabaseService,
  operation: string,
  use: (client: PoolClient) => Promise<A>,
): Effect.Effect<A, GitHubWorkflowStoreError> =>
  Effect.tryPromise({
    try: async () => {
      const client = await database.pool.connect();
      try {
        await client.query("BEGIN");
        const result = await use(client);
        await client.query("COMMIT");
        return result;
      } catch (cause) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw cause;
      } finally {
        client.release();
      }
    },
    catch: (cause) =>
      isGitHubWorkflowStoreError(cause)
        ? cause
        : failure("databaseFailure", operation, true, cause),
  });

interface GrantRow extends QueryResultRow {
  readonly workspace_id: string;
  readonly canonical_key: string;
  readonly installation_id: string;
  readonly owner_name: string;
  readonly repository_name: string;
  readonly repository_id: string;
  readonly can_push: boolean;
  readonly can_pull_requests: boolean;
}

const grantFromRow = (row: GrantRow): GitHubRepositoryGrantRecord => ({
  workspaceId: row.workspace_id as WorkspaceId,
  repository: {
    provider: "github",
    host: "github.com",
    installationId: row.installation_id as GitHubRepositoryRef["installationId"],
    owner: row.owner_name,
    name: row.repository_name,
    canonicalKey: row.canonical_key,
  },
  repositoryId: Number(row.repository_id),
  canPush: row.can_push,
  canPullRequests: row.can_pull_requests,
});

interface WorkflowRow extends QueryResultRow {
  readonly workspace_id: string;
  readonly thread_id: string;
  readonly environment_id: string;
  readonly canonical_key: string;
  readonly installation_id: string;
  readonly owner_name: string;
  readonly repository_name: string;
  readonly base_sha: string;
  readonly branch_name: string;
  readonly remote_head_sha: string | null;
  readonly status: "active" | "paused-conflict";
  readonly checkpoint_count: number;
  readonly pull_request_number: number | null;
  readonly pull_request_url: string | null;
  readonly pull_request_draft: boolean | null;
}

interface ClaimedEffectRow extends QueryResultRow {
  readonly effect_id: string;
  readonly payload: unknown;
  readonly prepared_sha: string | null;
  readonly expected_parent_sha: string | null;
  readonly attempt_count: number;
  readonly thread_id: string;
}

const workflowFromRow = (row: WorkflowRow): ClaimedGitHubWorkflowEffect["workflow"] => ({
  workspaceId: row.workspace_id as WorkspaceId,
  environmentId: row.environment_id as EnvironmentId,
  threadId: row.thread_id as ThreadId,
  repository: {
    provider: "github",
    host: "github.com",
    installationId: row.installation_id as GitHubRepositoryRef["installationId"],
    owner: row.owner_name,
    name: row.repository_name,
    canonicalKey: row.canonical_key,
  },
  baseSha: row.base_sha as GitObjectSha,
  branchName: row.branch_name as GitHubThreadBranchName,
  remoteHeadSha: row.remote_head_sha as GitObjectSha | null,
  status: row.status,
  checkpointCount: row.checkpoint_count,
  pullRequest:
    row.pull_request_number === null ||
    row.pull_request_url === null ||
    row.pull_request_draft === null
      ? null
      : {
          number: row.pull_request_number,
          url: row.pull_request_url,
          draft: row.pull_request_draft,
        },
});

const selectWorkflow = async (
  client: PoolClient,
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  lock = false,
) => {
  const result = await client.query<WorkflowRow>(
    `SELECT * FROM github_thread_workflow
      WHERE workspace_id = $1 AND thread_id = $2${lock ? " FOR UPDATE" : ""}`,
    [workspaceId, threadId],
  );
  return result.rows[0];
};

const claimedEffectFromRow = async (
  client: PoolClient,
  workspaceId: WorkspaceId,
  row: ClaimedEffectRow,
) => {
  let command: GitHubThreadWorkflowCommand;
  try {
    command = decodeCommand(row.payload);
  } catch (cause) {
    throw failure("invalidRecord", "claim-github-effect", false, cause);
  }
  if (command.workspaceId !== workspaceId) {
    throw failure("tenantMismatch", "claim-github-effect");
  }
  const workflow = await selectWorkflow(client, workspaceId, command.threadId, true);
  if (!workflow) throw failure("notFound", "claim-github-effect");
  const commandIdentity = await client.query<{
    readonly actor_user_id: string;
    readonly auth_session_id: string;
  }>(
    `SELECT actor_user_id, auth_session_id
       FROM github_thread_workflow_command
      WHERE workspace_id = $1 AND command_id = $2`,
    [workspaceId, command.commandId],
  );
  const identity = commandIdentity.rows[0];
  if (identity === undefined) throw failure("notFound", "claim-github-effect");
  return {
    effectId: row.effect_id,
    command,
    workflow: workflowFromRow(workflow),
    actorUserId: identity.actor_user_id,
    authSessionId: identity.auth_session_id as AuthSessionId,
    ...(row.expected_parent_sha
      ? { expectedParentSha: row.expected_parent_sha as GitObjectSha }
      : {}),
    ...(row.prepared_sha ? { preparedSha: row.prepared_sha as GitObjectSha } : {}),
    attemptCount: row.attempt_count,
  } satisfies ClaimedGitHubWorkflowEffect;
};

const appendEvent = async (
  client: PoolClient,
  workflow: WorkflowRow,
  input: {
    readonly commandId: string;
    readonly type: GitHubThreadWorkflowEvent["type"];
    readonly summary: string;
    readonly retryable: boolean;
    readonly payload: Record<string, unknown>;
    readonly occurredAt: string;
  },
) => {
  const sequenceResult = await client.query<{ readonly sequence: string }>(
    `UPDATE github_thread_workflow
        SET next_event_sequence = next_event_sequence + 1, updated_at = $3
      WHERE workspace_id = $1 AND thread_id = $2
      RETURNING (next_event_sequence - 1)::text AS sequence`,
    [workflow.workspace_id, workflow.thread_id, input.occurredAt],
  );
  const sequence = Number(sequenceResult.rows[0]?.sequence);
  await client.query(
    `INSERT INTO github_thread_workflow_event
       (workspace_id, thread_id, environment_id, sequence, event_id, event_type,
        visible, summary, retryable, payload, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8, $9::jsonb, $10)
     ON CONFLICT (workspace_id, event_id) DO NOTHING`,
    [
      workflow.workspace_id,
      workflow.thread_id,
      workflow.environment_id,
      sequence,
      eventIdFor(input.commandId),
      input.type,
      input.summary,
      input.retryable,
      canonicalJson(input.payload),
      input.occurredAt,
    ],
  );
};

export const makeGitHubWorkflowStore = (database: DatabaseService): GitHubWorkflowStore => ({
  registerRepository: (record) =>
    Effect.tryPromise({
      try: () =>
        database.pool.query(
          `INSERT INTO github_app_repository_access
             (workspace_id, canonical_key, installation_id, owner_name, repository_name,
              repository_id, can_push, can_pull_requests)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (workspace_id, canonical_key) DO UPDATE
             SET installation_id = EXCLUDED.installation_id,
                 owner_name = EXCLUDED.owner_name,
                 repository_name = EXCLUDED.repository_name,
                 repository_id = EXCLUDED.repository_id,
                 can_push = EXCLUDED.can_push,
                 can_pull_requests = EXCLUDED.can_pull_requests,
                 updated_at = now()`,
          [
            record.workspaceId,
            record.repository.canonicalKey.toLowerCase(),
            record.repository.installationId,
            record.repository.owner,
            record.repository.name,
            record.repositoryId,
            record.canPush,
            record.canPullRequests,
          ],
        ),
      catch: (cause) => failure("databaseFailure", "register-repository", true, cause),
    }).pipe(Effect.asVoid),
  getRepository: (workspaceId, canonicalKey) =>
    Effect.tryPromise({
      try: () =>
        database.pool.query<GrantRow>(
          `SELECT * FROM github_app_repository_access
            WHERE workspace_id = $1 AND canonical_key = $2`,
          [workspaceId, canonicalKey.toLowerCase()],
        ),
      catch: (cause) => failure("databaseFailure", "get-repository", true, cause),
    }).pipe(Effect.map((result) => (result.rows[0] ? grantFromRow(result.rows[0]) : undefined))),
  submit: ({ idempotencyKey, command, branchName, actorUserId, authSessionId }) => {
    const operation = "submit-github-command";
    return transaction(database, operation, async (client) => {
      const normalized = canonicalJson(command);
      const commandFingerprint = fingerprint(command);
      const identityLocks = [
        `${command.workspaceId}:command:${command.commandId}`,
        `${command.workspaceId}:idempotency:${idempotencyKey}`,
      ].sort();
      for (const identityLock of identityLocks) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [identityLock]);
      }
      const existing = await client.query<{
        readonly command_id: string;
        readonly idempotency_key: string;
        readonly fingerprint: string;
        readonly actor_user_id: string;
        readonly auth_session_id: string;
      }>(
        `SELECT command_id, idempotency_key, fingerprint, actor_user_id, auth_session_id
           FROM github_thread_workflow_command
          WHERE workspace_id = $1 AND (command_id = $2 OR idempotency_key = $3)
          FOR UPDATE`,
        [command.workspaceId, command.commandId, idempotencyKey],
      );
      if (existing.rows.length > 0) {
        const duplicate = existing.rows.every(
          (row) =>
            row.command_id === command.commandId &&
            row.idempotency_key === idempotencyKey &&
            row.fingerprint === commandFingerprint &&
            row.actor_user_id === actorUserId &&
            row.auth_session_id === authSessionId,
        );
        if (!duplicate) throw failure("idempotencyConflict", operation);
        return { disposition: "duplicate", commandId: command.commandId } as const;
      }

      let expectedParentSha: string | null = null;
      if (command.type === "github.branch.create") {
        if (!branchName) throw failure("invalidRecord", operation);
        const inserted = await client.query(
          `INSERT INTO github_thread_workflow
             (workspace_id, thread_id, environment_id, canonical_key, installation_id,
              owner_name, repository_name, base_sha, branch_name)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (workspace_id, thread_id) DO NOTHING
           RETURNING thread_id`,
          [
            command.workspaceId,
            command.threadId,
            command.environmentId,
            command.repository.canonicalKey.toLowerCase(),
            command.repository.installationId,
            command.repository.owner,
            command.repository.name,
            command.baseSha,
            branchName,
          ],
        );
        if (inserted.rowCount === 0) {
          const current = await selectWorkflow(client, command.workspaceId, command.threadId, true);
          if (
            !current ||
            current.environment_id !== command.environmentId ||
            current.canonical_key !== command.repository.canonicalKey.toLowerCase() ||
            current.base_sha !== command.baseSha ||
            current.branch_name !== branchName
          ) {
            throw failure("stateConflict", operation);
          }
        }
      } else {
        const current = await selectWorkflow(client, command.workspaceId, command.threadId, true);
        if (!current) throw failure("notFound", operation);
        if (
          current.environment_id !== command.environmentId ||
          current.canonical_key !== command.repository.canonicalKey.toLowerCase()
        ) {
          throw failure("tenantMismatch", operation);
        }
        if (current.status === "paused-conflict") throw failure("stateConflict", operation);
        if (command.type === "github.checkpoint.push") {
          if (current.remote_head_sha === null) throw failure("stateConflict", operation);
          expectedParentSha = current.remote_head_sha;
        }
      }

      await client.query(
        `INSERT INTO github_thread_workflow_command
           (workspace_id, thread_id, command_id, idempotency_key, fingerprint, command_type,
            approval_id, actor_user_id, auth_session_id, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
        [
          command.workspaceId,
          command.threadId,
          command.commandId,
          idempotencyKey,
          commandFingerprint,
          command.type,
          command.approvalId,
          actorUserId,
          authSessionId,
          normalized,
        ],
      );
      await client.query(
        `INSERT INTO github_thread_workflow_outbox
           (workspace_id, thread_id, effect_id, command_id, effect_type, payload,
            expected_parent_sha)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [
          command.workspaceId,
          command.threadId,
          effectIdFor(command.commandId),
          command.commandId,
          effectTypeFor(command),
          normalized,
          expectedParentSha,
        ],
      );
      return { disposition: "accepted", commandId: command.commandId } as const;
    });
  },
  claim: ({ workspaceId, commandId, now, leaseExpiresAt }) =>
    transaction(database, "claim-github-effect", async (client) => {
      const claimed = await client.query<ClaimedEffectRow>(
        `UPDATE github_thread_workflow_outbox
            SET status = 'processing', lease_expires_at = $3,
                attempt_count = attempt_count + 1, updated_at = $2
          WHERE workspace_id = $1 AND command_id = $4
            AND (status = 'pending' OR (status = 'processing' AND lease_expires_at <= $2))
            AND available_at <= $2
          RETURNING effect_id, payload, prepared_sha, expected_parent_sha,
                    attempt_count, thread_id`,
        [workspaceId, now, leaseExpiresAt, commandId],
      );
      const row = claimed.rows[0];
      if (!row) return undefined;
      return claimedEffectFromRow(client, workspaceId, row);
    }),
  claimNext: ({ workspaceId, now, leaseExpiresAt }) =>
    transaction(database, "claim-next-github-effect", async (client) => {
      const claimed = await client.query<ClaimedEffectRow>(
        `WITH candidate AS (
           SELECT workspace_id, command_id
             FROM github_thread_workflow_outbox
            WHERE workspace_id = $1
              AND (status = 'pending' OR (status = 'processing' AND lease_expires_at <= $2))
              AND available_at <= $2
            ORDER BY available_at ASC, created_at ASC, command_id ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
         )
         UPDATE github_thread_workflow_outbox AS outbox
            SET status = 'processing', lease_expires_at = $3,
                attempt_count = attempt_count + 1, updated_at = $2
           FROM candidate
          WHERE outbox.workspace_id = candidate.workspace_id
            AND outbox.command_id = candidate.command_id
         RETURNING outbox.effect_id, outbox.payload, outbox.prepared_sha,
                   outbox.expected_parent_sha,
                   outbox.attempt_count, outbox.thread_id`,
        [workspaceId, now, leaseExpiresAt],
      );
      const row = claimed.rows[0];
      if (!row) return undefined;
      return claimedEffectFromRow(client, workspaceId, row);
    }),
  savePreparedSha: (workspaceId, commandId, sha, attemptCount) =>
    Effect.tryPromise({
      try: async () => {
        const result = await database.pool.query(
          `UPDATE github_thread_workflow_outbox
              SET prepared_sha = COALESCE(prepared_sha, $3), updated_at = now()
            WHERE workspace_id = $1 AND command_id = $2 AND status = 'processing'
              AND attempt_count = $4 AND (prepared_sha IS NULL OR prepared_sha = $3)
            RETURNING command_id`,
          [workspaceId, commandId, sha, attemptCount],
        );
        if (result.rowCount !== 1) throw failure("stateConflict", "save-prepared-sha");
      },
      catch: (cause) =>
        isGitHubWorkflowStoreError(cause)
          ? cause
          : failure("databaseFailure", "save-prepared-sha", true, cause),
    }),
  complete: ({ workspaceId, commandId, attemptCount, completion, occurredAt }) =>
    transaction(database, "complete-github-effect", async (client) => {
      const commandResult = await client.query<{
        readonly thread_id: string;
        readonly status: string;
      }>(
        `SELECT thread_id, status FROM github_thread_workflow_command
          WHERE workspace_id = $1 AND command_id = $2 FOR UPDATE`,
        [workspaceId, commandId],
      );
      const command = commandResult.rows[0];
      if (!command) throw failure("notFound", "complete-github-effect");
      if (command.status === "succeeded") return;
      const outbox = await client.query<{
        readonly attempt_count: number;
        readonly status: string;
      }>(
        `SELECT attempt_count, status FROM github_thread_workflow_outbox
          WHERE workspace_id = $1 AND command_id = $2 FOR UPDATE`,
        [workspaceId, commandId],
      );
      if (
        outbox.rows[0]?.status !== "processing" ||
        outbox.rows[0].attempt_count !== attemptCount
      ) {
        throw failure("stateConflict", "complete-github-effect");
      }
      const workflow = await selectWorkflow(
        client,
        workspaceId,
        command.thread_id as ThreadId,
        true,
      );
      if (!workflow) throw failure("notFound", "complete-github-effect");

      let type: GitHubThreadWorkflowEvent["type"];
      let summary: string;
      let externalIdentity: string;
      let payload: Record<string, unknown>;
      if (completion.type === "branch") {
        await client.query(
          `UPDATE github_thread_workflow SET remote_head_sha = $3, status = 'active', updated_at = $4
            WHERE workspace_id = $1 AND thread_id = $2`,
          [workspaceId, workflow.thread_id, completion.remoteHeadSha, occurredAt],
        );
        type = "github.branch-created";
        summary = `Created ${workflow.branch_name}`;
        externalIdentity = `refs/heads/${workflow.branch_name}@${completion.remoteHeadSha}`;
        payload = { branchName: workflow.branch_name, sha: completion.remoteHeadSha };
      } else if (completion.type === "checkpoint") {
        await client.query(
          `UPDATE github_thread_workflow
              SET remote_head_sha = $3, checkpoint_count = checkpoint_count + 1, updated_at = $4
            WHERE workspace_id = $1 AND thread_id = $2`,
          [workspaceId, workflow.thread_id, completion.remoteHeadSha, occurredAt],
        );
        type = "github.checkpoint-pushed";
        summary = `Pushed checkpoint ${completion.remoteHeadSha.slice(0, 7)}`;
        externalIdentity = completion.remoteHeadSha;
        payload = { branchName: workflow.branch_name, sha: completion.remoteHeadSha };
      } else if (completion.type === "draftPullRequest") {
        await client.query(
          `UPDATE github_thread_workflow
              SET pull_request_number = $3, pull_request_url = $4,
                  pull_request_draft = true, updated_at = $5
            WHERE workspace_id = $1 AND thread_id = $2`,
          [
            workspaceId,
            workflow.thread_id,
            completion.pullRequest.number,
            completion.pullRequest.url,
            occurredAt,
          ],
        );
        type = "github.pull-request-opened";
        summary = `Opened draft PR #${completion.pullRequest.number}`;
        externalIdentity = completion.pullRequest.url;
        payload = completion.pullRequest;
      } else {
        const readyUpdate = await client.query(
          `UPDATE github_thread_workflow
              SET pull_request_draft = false, updated_at = $4
            WHERE workspace_id = $1 AND thread_id = $2 AND pull_request_number = $3`,
          [workspaceId, workflow.thread_id, completion.pullRequest.number, occurredAt],
        );
        if (readyUpdate.rowCount !== 1) {
          throw failure("stateConflict", "complete-github-effect");
        }
        type = "github.pull-request-ready";
        summary = `Marked PR #${completion.pullRequest.number} ready`;
        externalIdentity = completion.pullRequest.url;
        payload = completion.pullRequest;
      }

      await appendEvent(client, workflow, {
        commandId,
        type,
        summary,
        retryable: false,
        payload,
        occurredAt,
      });
      await client.query(
        `UPDATE github_thread_workflow_command SET status = 'succeeded', result = $3::jsonb, updated_at = $4
          WHERE workspace_id = $1 AND command_id = $2`,
        [workspaceId, commandId, canonicalJson(completion), occurredAt],
      );
      const effectId = effectIdFor(commandId);
      await client.query(
        `UPDATE github_thread_workflow_outbox
            SET status = 'delivered', lease_expires_at = NULL, updated_at = $3
          WHERE workspace_id = $1 AND command_id = $2`,
        [workspaceId, commandId, occurredAt],
      );
      await client.query(
        `INSERT INTO github_thread_workflow_receipt
           (workspace_id, thread_id, effect_id, command_id, external_identity, result, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         ON CONFLICT (workspace_id, effect_id) DO NOTHING`,
        [
          workspaceId,
          workflow.thread_id,
          effectId,
          commandId,
          externalIdentity,
          canonicalJson(completion),
          occurredAt,
        ],
      );
    }),
  fail: (input) =>
    transaction(database, "fail-github-effect", async (client) => {
      const commandResult = await client.query<{
        readonly thread_id: string;
        readonly status: string;
      }>(
        `SELECT thread_id, status FROM github_thread_workflow_command
          WHERE workspace_id = $1 AND command_id = $2 FOR UPDATE`,
        [input.workspaceId, input.commandId],
      );
      const command = commandResult.rows[0];
      if (!command) throw failure("notFound", "fail-github-effect");
      if (command.status === "failed" || command.status === "succeeded") return;
      const outbox = await client.query<{
        readonly attempt_count: number;
        readonly status: string;
      }>(
        `SELECT attempt_count, status FROM github_thread_workflow_outbox
          WHERE workspace_id = $1 AND command_id = $2 FOR UPDATE`,
        [input.workspaceId, input.commandId],
      );
      if (
        outbox.rows[0]?.status !== "processing" ||
        outbox.rows[0].attempt_count !== input.attemptCount
      ) {
        throw failure("stateConflict", "fail-github-effect");
      }
      const workflow = await selectWorkflow(
        client,
        input.workspaceId,
        command.thread_id as ThreadId,
        true,
      );
      if (!workflow) throw failure("notFound", "fail-github-effect");
      if (input.retryable && !input.conflict) {
        await client.query(
          `UPDATE github_thread_workflow_command SET status = 'pending', updated_at = $3
            WHERE workspace_id = $1 AND command_id = $2`,
          [input.workspaceId, input.commandId, input.occurredAt],
        );
        await client.query(
          `UPDATE github_thread_workflow_outbox
              SET status = 'pending', available_at = $3, lease_expires_at = NULL,
                  last_error_code = $4, updated_at = $5
            WHERE workspace_id = $1 AND command_id = $2`,
          [
            input.workspaceId,
            input.commandId,
            input.retryAt ?? input.occurredAt,
            input.code,
            input.occurredAt,
          ],
        );
        return;
      }
      await client.query(
        `UPDATE github_thread_workflow_command SET status = 'failed', updated_at = $3
          WHERE workspace_id = $1 AND command_id = $2`,
        [input.workspaceId, input.commandId, input.occurredAt],
      );
      await client.query(
        `UPDATE github_thread_workflow_outbox
            SET status = 'failed', lease_expires_at = NULL, last_error_code = $3, updated_at = $4
          WHERE workspace_id = $1 AND command_id = $2`,
        [input.workspaceId, input.commandId, input.code, input.occurredAt],
      );
      if (input.conflict) {
        await client.query(
          `UPDATE github_thread_workflow SET status = 'paused-conflict', updated_at = $3
            WHERE workspace_id = $1 AND thread_id = $2`,
          [input.workspaceId, workflow.thread_id, input.occurredAt],
        );
      }
      await appendEvent(client, workflow, {
        commandId: input.commandId,
        type: input.conflict ? "github.conflict" : "github.operation-failed",
        summary: input.summary,
        retryable: input.retryable,
        payload: { code: input.code },
        occurredAt: input.occurredAt,
      });
    }),
  get: (workspaceId, threadId) =>
    Effect.tryPromise({
      try: async () => {
        const workflowResult = await database.pool.query<WorkflowRow>(
          `SELECT * FROM github_thread_workflow WHERE workspace_id = $1 AND thread_id = $2`,
          [workspaceId, threadId],
        );
        const row = workflowResult.rows[0];
        if (!row) return undefined;
        const eventResult = await database.pool.query<{
          readonly event_id: string;
          readonly sequence: string;
          readonly event_type: GitHubThreadWorkflowEvent["type"];
          readonly summary: string;
          readonly retryable: boolean;
          readonly payload: Record<string, unknown>;
          readonly occurred_at: Date;
        }>(
          `SELECT event_id, sequence::text, event_type, summary, retryable, payload, occurred_at
             FROM github_thread_workflow_event
            WHERE workspace_id = $1 AND thread_id = $2 ORDER BY sequence ASC`,
          [workspaceId, threadId],
        );
        const workflow = workflowFromRow(row);
        return {
          ...workflow,
          events: eventResult.rows.map((event) =>
            decodeEvent({
              eventId: event.event_id,
              workspaceId,
              environmentId: workflow.environmentId,
              threadId,
              sequence: Number(event.sequence),
              type: event.event_type,
              visible: true,
              summary: event.summary,
              retryable: event.retryable,
              payload: event.payload,
              occurredAt: event.occurred_at.toISOString(),
            }),
          ),
        } satisfies GitHubThreadWorkflowView;
      },
      catch: (cause) => failure("databaseFailure", "get-github-workflow", true, cause),
    }),
});
