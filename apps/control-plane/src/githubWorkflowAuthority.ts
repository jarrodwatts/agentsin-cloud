import type { AuthSessionId, ThreadId } from "@t3tools/contracts";
import {
  GitHubWorkflowApproval,
  type GitHubRepositoryRef,
  type GitHubWorkflowAction,
  type SandboxId,
  type WorkspaceId,
} from "@t3tools/contracts/cloud";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { QueryResultRow } from "pg";

import type { DatabaseService } from "./database.ts";
import type { GitHubWorkerTarget } from "./githubWorkerDispatcher.ts";

export interface ValidatedGitHubWorkflowApproval {
  readonly approval: GitHubWorkflowApproval;
  readonly generation: string;
}

export class GitHubAuthorityError extends Schema.TaggedErrorClass<GitHubAuthorityError>()(
  "GitHubAuthorityError",
  {
    code: Schema.Literals([
      "notFound",
      "notApproved",
      "expired",
      "identityMismatch",
      "sandboxUnavailable",
      "databaseFailure",
      "invalidRecord",
    ]),
    retryable: Schema.Boolean,
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {}

export interface GitHubWorkflowAuthority {
  readonly validateApproval: (input: {
    readonly approvalId: string;
    readonly workspaceId: WorkspaceId;
    readonly threadId: ThreadId;
    readonly repository: GitHubRepositoryRef;
    readonly action: GitHubWorkflowAction;
    readonly actorUserId: string;
    readonly authSessionId: AuthSessionId;
    readonly now: string;
  }) => Effect.Effect<ValidatedGitHubWorkflowApproval, GitHubAuthorityError>;
  readonly resolveWorkerTarget: (input: {
    readonly workspaceId: WorkspaceId;
    readonly threadId: ThreadId;
    readonly repository: GitHubRepositoryRef;
  }) => Effect.Effect<GitHubWorkerTarget, GitHubAuthorityError>;
}

interface ApprovalRow extends QueryResultRow {
  readonly thread_id: string;
  readonly state: "pending" | "approved" | "rejected" | "expired";
  readonly payload: unknown;
  readonly approval_generation: string;
}

interface TargetRow extends QueryResultRow {
  readonly workspace_id: string;
  readonly thread_id: string;
  readonly environment_id: string;
  readonly sandbox_id: string;
  readonly repository_identity: { readonly canonicalKey?: unknown };
}

const decodeApproval = Schema.decodeUnknownSync(GitHubWorkflowApproval);
const isAuthorityError = Schema.is(GitHubAuthorityError);
const sameRepository = (left: GitHubRepositoryRef, right: GitHubRepositoryRef) =>
  left.installationId === right.installationId &&
  left.canonicalKey.toLowerCase() === right.canonicalKey.toLowerCase() &&
  left.owner.toLowerCase() === right.owner.toLowerCase() &&
  left.name.toLowerCase() === right.name.toLowerCase();

export const makeGitHubWorkflowAuthority = (
  database: DatabaseService,
): GitHubWorkflowAuthority => ({
  validateApproval: (input) =>
    Effect.tryPromise({
      try: async () => {
        const result = await database.pool.query<ApprovalRow>(
          `SELECT thread_id, state, payload, xmin::text AS approval_generation
             FROM cloud_thread_approval
            WHERE workspace_id = $1 AND thread_id = $2 AND request_id = $3`,
          [input.workspaceId, input.threadId, input.approvalId],
        );
        const row = result.rows[0];
        if (row === undefined) {
          throw new GitHubAuthorityError({ code: "notFound", retryable: false });
        }
        if (row.state !== "approved") {
          throw new GitHubAuthorityError({ code: "notApproved", retryable: false });
        }
        let approval: GitHubWorkflowApproval;
        try {
          approval = decodeApproval(row.payload);
        } catch (cause) {
          throw new GitHubAuthorityError({ code: "invalidRecord", retryable: false, cause });
        }
        if (
          approval.approvalId !== input.approvalId ||
          approval.workspaceId !== input.workspaceId ||
          approval.threadId !== input.threadId ||
          approval.decidedByUserId !== input.actorUserId ||
          approval.decidedBy !== input.authSessionId ||
          !sameRepository(approval.repository, input.repository) ||
          !approval.actions.includes(input.action)
        ) {
          throw new GitHubAuthorityError({ code: "identityMismatch", retryable: false });
        }
        if (approval.expiresAt <= input.now) {
          throw new GitHubAuthorityError({ code: "expired", retryable: false });
        }
        return { approval, generation: row.approval_generation };
      },
      catch: (cause) =>
        isAuthorityError(cause)
          ? cause
          : new GitHubAuthorityError({ code: "databaseFailure", retryable: true, cause }),
    }),
  resolveWorkerTarget: (input) =>
    Effect.tryPromise({
      try: async () => {
        const result = await database.pool.query<TargetRow>(
          `SELECT workspace_id::text, thread_id, environment_id, sandbox_id,
                  repository_identity
             FROM cloud_e2b_sandbox_identity
            WHERE workspace_id = $1 AND thread_id = $2 AND state = 'active'
              AND sandbox_id IS NOT NULL`,
          [input.workspaceId, input.threadId],
        );
        const row = result.rows[0];
        if (row === undefined) {
          throw new GitHubAuthorityError({ code: "sandboxUnavailable", retryable: true });
        }
        if (
          typeof row.repository_identity.canonicalKey !== "string" ||
          row.repository_identity.canonicalKey.toLowerCase() !==
            input.repository.canonicalKey.toLowerCase()
        ) {
          throw new GitHubAuthorityError({ code: "identityMismatch", retryable: false });
        }
        return {
          workspaceId: row.workspace_id as WorkspaceId,
          environmentId: row.environment_id as GitHubWorkerTarget["environmentId"],
          threadId: row.thread_id as ThreadId,
          sandboxId: row.sandbox_id as SandboxId,
        };
      },
      catch: (cause) =>
        isAuthorityError(cause)
          ? cause
          : new GitHubAuthorityError({ code: "databaseFailure", retryable: true, cause }),
    }),
});
