// @effect-diagnostics nodeBuiltinImport:off -- Lease references use SHA-256 and never contain token material.
import * as NodeCrypto from "node:crypto";

import type { AuthSessionId } from "@t3tools/contracts";
import { GitHubWorkflowApproval, type GitHubRepositoryRef } from "@t3tools/contracts/cloud";
import type {
  WorkerGitHubApprovalGeneration,
  WorkerGitHubTokenLeaseRef,
  WorkerGitHubTokenRedeemRequest,
} from "@t3tools/contracts/worker";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { PoolClient, QueryResultRow } from "pg";

import type { DatabaseService } from "./database.ts";
import type { GitHubInstallationToken } from "./githubAppClient.ts";
import type { ActiveWorkerLease } from "./workerIdentity.ts";
import type { AuthenticatedWorkerPrincipal } from "./workerRelay.ts";

export class GitHubTokenLeaseError extends Schema.TaggedErrorClass<GitHubTokenLeaseError>()(
  "GitHubTokenLeaseError",
  {
    code: Schema.Literals([
      "notFound",
      "identityMismatch",
      "approvalInvalid",
      "expired",
      "used",
      "vaultFailure",
      "databaseFailure",
    ]),
    retryable: Schema.Boolean,
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {}

/**
 * Deployment KMS/secret store. `seal` is permanently idempotent by lease
 * reference and never replaces or re-seals a value; `redeem` atomically
 * consumes it once while retaining a replay tombstone.
 */
export interface GitHubSingleUseTokenVault {
  readonly seal: (input: {
    readonly leaseRef: WorkerGitHubTokenLeaseRef;
    readonly token: Redacted.Redacted<string>;
    readonly expiresAt: string;
  }) => Effect.Effect<string, GitHubTokenLeaseError>;
  readonly redeem: (input: {
    readonly leaseRef: WorkerGitHubTokenLeaseRef;
    readonly secretRef: string;
  }) => Effect.Effect<Redacted.Redacted<string>, GitHubTokenLeaseError>;
}

export interface GitHubTokenLeaseSealInput {
  readonly token: GitHubInstallationToken;
  readonly workerLease: ActiveWorkerLease;
  readonly operationId: string;
  readonly commandId: string;
  readonly approvalId: string;
  readonly approvalGeneration: WorkerGitHubApprovalGeneration;
  readonly approvalAction: WorkerGitHubTokenRedeemRequest["approvalAction"];
  readonly approvalExpiresAt: string;
  readonly actorUserId: string;
  readonly authSessionId: AuthSessionId;
  readonly repository: GitHubRepositoryRef;
}

export interface GitHubTokenLeaseBroker {
  readonly seal: (
    input: GitHubTokenLeaseSealInput,
  ) => Effect.Effect<
    { readonly leaseRef: WorkerGitHubTokenLeaseRef; readonly expiresAt: string },
    GitHubTokenLeaseError
  >;
  readonly redeem: (
    principal: AuthenticatedWorkerPrincipal,
    request: WorkerGitHubTokenRedeemRequest,
    now: string,
  ) => Effect.Effect<GitHubInstallationToken, GitHubTokenLeaseError>;
}

interface LeaseRow extends QueryResultRow {
  readonly workspace_id: string;
  readonly environment_id: string;
  readonly thread_id: string;
  readonly sandbox_id: string;
  readonly environment_revision_id: string;
  readonly reservation_id: string;
  readonly worker_id: string;
  readonly provider_instance_id: string;
  readonly provider_driver: string;
  readonly process_instance_id: string;
  readonly certificate_fingerprint: string;
  readonly certificate_generation: string;
  readonly worker_lease_generation: string;
  readonly route_generation: string;
  readonly operation_id: string;
  readonly command_id: string;
  readonly approval_id: string;
  readonly approval_generation: string;
  readonly approval_action: WorkerGitHubTokenRedeemRequest["approvalAction"];
  readonly actor_user_id: string;
  readonly auth_session_id: string;
  readonly installation_id: string;
  readonly canonical_key: string;
  readonly owner_name: string;
  readonly repository_name: string;
  readonly expires_at: string;
  readonly secret_ref: string;
  readonly used_at: string | null;
  readonly approval_state: "pending" | "approved" | "rejected" | "expired";
  readonly approval_payload: unknown;
  readonly current_approval_generation: string;
  readonly sandbox_state: string | null;
  readonly current_worker_state: string | null;
  readonly current_thread_id: string | null;
  readonly current_environment_id: string | null;
  readonly current_environment_revision_id: string | null;
  readonly current_reservation_id: string | null;
  readonly current_worker_id: string | null;
  readonly current_provider_instance_id: string | null;
  readonly current_provider_driver: string | null;
  readonly current_process_instance_id: string | null;
  readonly current_certificate_fingerprint: string | null;
  readonly current_certificate_generation: string | null;
  readonly current_worker_lease_generation: string | null;
  readonly current_route_generation: string | null;
}

const decodeApproval = Schema.decodeUnknownSync(GitHubWorkflowApproval);
const isLeaseError = Schema.is(GitHubTokenLeaseError);
const sameRepository = (row: LeaseRow, repository: GitHubRepositoryRef) =>
  row.installation_id === repository.installationId &&
  row.canonical_key === repository.canonicalKey.toLowerCase() &&
  row.owner_name.toLowerCase() === repository.owner.toLowerCase() &&
  row.repository_name.toLowerCase() === repository.name.toLowerCase();

const failure = (code: GitHubTokenLeaseError["code"], retryable: boolean, cause?: unknown) =>
  new GitHubTokenLeaseError({ code, retryable, ...(cause === undefined ? {} : { cause }) });

const withTransaction = <A>(
  database: DatabaseService,
  use: (client: PoolClient) => Effect.Effect<A, GitHubTokenLeaseError>,
) =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => database.pool.connect(),
      catch: (cause) => failure("databaseFailure", true, cause),
    }),
    (client) =>
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () => client.query("BEGIN"),
          catch: (cause) => failure("databaseFailure", true, cause),
        });
        const result = yield* use(client).pipe(
          Effect.tapError(() =>
            Effect.tryPromise(() => client.query("ROLLBACK")).pipe(Effect.ignore),
          ),
        );
        yield* Effect.tryPromise({
          try: () => client.query("COMMIT"),
          catch: (cause) => failure("databaseFailure", true, cause),
        }).pipe(
          Effect.tapError(() =>
            Effect.tryPromise(() => client.query("ROLLBACK")).pipe(Effect.ignore),
          ),
        );
        return result;
      }),
    (client) => Effect.sync(() => client.release()),
  );

export const makePostgresGitHubTokenLeaseBroker = (input: {
  readonly database: DatabaseService;
  readonly vault: GitHubSingleUseTokenVault;
}): GitHubTokenLeaseBroker => ({
  seal: (lease) =>
    Effect.gen(function* () {
      const worker = lease.workerLease;
      const expiresAt =
        lease.token.expiresAt < lease.approvalExpiresAt
          ? lease.token.expiresAt
          : lease.approvalExpiresAt;
      const leaseRef = `gh-token-${NodeCrypto.createHash("sha256")
        .update(
          [
            worker.workspaceId,
            worker.environmentId,
            worker.threadId,
            worker.sandboxId,
            worker.environmentRevisionId,
            worker.reservationId,
            worker.workerId,
            worker.providerInstanceId,
            worker.providerDriver,
            worker.processInstanceId,
            worker.certificateFingerprint,
            worker.certificateGeneration,
            worker.leaseGeneration,
            worker.routeGeneration,
            lease.operationId,
            lease.commandId,
            lease.approvalId,
            lease.approvalGeneration,
          ].join("\0"),
        )
        .digest("hex")}` as WorkerGitHubTokenLeaseRef;
      const secretRef = yield* input.vault.seal({
        leaseRef,
        token: lease.token.token,
        expiresAt,
      });
      const persistedExpiresAt = yield* withTransaction(input.database, (client) =>
        Effect.tryPromise({
          try: async () => {
            await client.query(
              `INSERT INTO github_worker_token_lease
                 (lease_ref, workspace_id, environment_id, thread_id, sandbox_id,
                  environment_revision_id, reservation_id, worker_id,
                  provider_instance_id, provider_driver, process_instance_id,
                  certificate_fingerprint, certificate_generation,
                  worker_lease_generation, route_generation,
                  operation_id, command_id, approval_id, approval_generation,
                  approval_action, actor_user_id, auth_session_id, installation_id,
                  canonical_key, owner_name, repository_name, expires_at, secret_ref)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                       $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
                       $24, $25, $26, $27, $28)
               ON CONFLICT (lease_ref) DO NOTHING`,
              [
                leaseRef,
                worker.workspaceId,
                worker.environmentId,
                worker.threadId,
                worker.sandboxId,
                worker.environmentRevisionId,
                worker.reservationId,
                worker.workerId,
                worker.providerInstanceId,
                worker.providerDriver,
                worker.processInstanceId,
                worker.certificateFingerprint,
                worker.certificateGeneration,
                worker.leaseGeneration,
                worker.routeGeneration,
                lease.operationId,
                lease.commandId,
                lease.approvalId,
                lease.approvalGeneration,
                lease.approvalAction,
                lease.actorUserId,
                lease.authSessionId,
                lease.repository.installationId,
                lease.repository.canonicalKey.toLowerCase(),
                lease.repository.owner,
                lease.repository.name,
                expiresAt,
                secretRef,
              ],
            );
            const verified = await client.query<{ readonly expires_at: string }>(
              `SELECT to_char(expires_at AT TIME ZONE 'UTC',
                              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at
                FROM github_worker_token_lease
                WHERE lease_ref = $1 AND workspace_id = $2 AND environment_id = $3
                  AND thread_id = $4 AND sandbox_id = $5
                  AND environment_revision_id = $6 AND reservation_id = $7
                  AND worker_id = $8 AND provider_instance_id = $9
                  AND provider_driver = $10 AND process_instance_id = $11
                  AND certificate_fingerprint = $12 AND certificate_generation = $13
                  AND worker_lease_generation = $14 AND route_generation = $15
                  AND operation_id = $16 AND command_id = $17 AND approval_id = $18
                  AND approval_generation = $19 AND approval_action = $20
                  AND actor_user_id = $21 AND auth_session_id = $22
                  AND installation_id = $23 AND canonical_key = $24
                  AND lower(owner_name) = lower($25) AND lower(repository_name) = lower($26)
                  AND secret_ref = $27 AND used_at IS NULL`,
              [
                leaseRef,
                worker.workspaceId,
                worker.environmentId,
                worker.threadId,
                worker.sandboxId,
                worker.environmentRevisionId,
                worker.reservationId,
                worker.workerId,
                worker.providerInstanceId,
                worker.providerDriver,
                worker.processInstanceId,
                worker.certificateFingerprint,
                worker.certificateGeneration,
                worker.leaseGeneration,
                worker.routeGeneration,
                lease.operationId,
                lease.commandId,
                lease.approvalId,
                lease.approvalGeneration,
                lease.approvalAction,
                lease.actorUserId,
                lease.authSessionId,
                lease.repository.installationId,
                lease.repository.canonicalKey.toLowerCase(),
                lease.repository.owner,
                lease.repository.name,
                secretRef,
              ],
            );
            if (verified.rowCount !== 1) throw failure("identityMismatch", false);
            return verified.rows[0]!.expires_at;
          },
          catch: (cause) => (isLeaseError(cause) ? cause : failure("databaseFailure", true, cause)),
        }),
      );
      return { leaseRef, expiresAt: persistedExpiresAt };
    }),
  redeem: (principal, request, now) =>
    withTransaction(input.database, (client) =>
      Effect.gen(function* () {
        const result = yield* Effect.tryPromise({
          try: () =>
            client.query<LeaseRow>(
              `SELECT lease.*, approval.state AS approval_state,
                      approval.payload AS approval_payload,
                      approval.xmin::text AS current_approval_generation,
                      sandbox.state AS sandbox_state,
                      current_worker.state AS current_worker_state,
                      current_worker.thread_id AS current_thread_id,
                      current_worker.environment_id AS current_environment_id,
                      current_worker.environment_revision_id AS current_environment_revision_id,
                      current_worker.reservation_id AS current_reservation_id,
                      current_worker.worker_id AS current_worker_id,
                      current_worker.provider_instance_id AS current_provider_instance_id,
                      current_worker.provider_driver AS current_provider_driver,
                      current_worker.process_instance_id AS current_process_instance_id,
                      current_worker.certificate_fingerprint AS current_certificate_fingerprint,
                      current_worker.certificate_generation::text AS current_certificate_generation,
                      current_worker.lease_generation::text AS current_worker_lease_generation,
                      current_worker.route_generation::text AS current_route_generation,
                      to_char(lease.expires_at AT TIME ZONE 'UTC',
                              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at
                 FROM github_worker_token_lease AS lease
                 JOIN cloud_thread_approval AS approval
                   ON approval.workspace_id = lease.workspace_id
                  AND approval.request_id = lease.approval_id
                 LEFT JOIN cloud_e2b_sandbox_identity AS sandbox
                   ON sandbox.workspace_id = lease.workspace_id
                  AND sandbox.thread_id = lease.thread_id
                  AND sandbox.environment_id = lease.environment_id
                  AND sandbox.sandbox_id = lease.sandbox_id
                 JOIN cloud_worker_lease AS current_worker
                   ON current_worker.workspace_id = lease.workspace_id
                  AND current_worker.sandbox_id = lease.sandbox_id
                WHERE lease.lease_ref = $1
                FOR UPDATE OF lease, approval, current_worker`,
              [request.leaseRef],
            ),
          catch: (cause) => failure("databaseFailure", true, cause),
        });
        const row = result.rows[0];
        if (row === undefined) return yield* failure("notFound", false);
        const binding = request.routeBinding;
        if (
          row.workspace_id !== principal.workspaceId ||
          row.environment_id !== principal.environmentId ||
          row.thread_id !== principal.threadId ||
          row.sandbox_id !== principal.sandboxId ||
          row.environment_revision_id !== principal.environmentRevisionId ||
          row.reservation_id !== principal.reservationId ||
          row.worker_id !== principal.workerId ||
          row.provider_instance_id !== principal.providerInstanceId ||
          row.provider_driver !== principal.providerDriver ||
          row.certificate_fingerprint !== principal.certificateFingerprint ||
          row.certificate_generation !== String(principal.certificateGeneration) ||
          row.environment_revision_id !== binding.environmentRevisionId ||
          row.reservation_id !== binding.reservationId ||
          row.worker_id !== binding.workerId ||
          row.provider_instance_id !== binding.providerInstanceId ||
          row.provider_driver !== binding.providerDriver ||
          row.process_instance_id !== binding.processInstanceId ||
          row.certificate_fingerprint !== binding.certificateFingerprint ||
          row.certificate_generation !== String(binding.certificateGeneration) ||
          row.worker_lease_generation !== String(binding.leaseGeneration) ||
          row.route_generation !== String(binding.routeGeneration) ||
          row.current_worker_state !== "connected" ||
          row.current_thread_id !== row.thread_id ||
          row.current_environment_id !== row.environment_id ||
          row.current_environment_revision_id !== row.environment_revision_id ||
          row.current_reservation_id !== row.reservation_id ||
          row.current_worker_id !== row.worker_id ||
          row.current_provider_instance_id !== row.provider_instance_id ||
          row.current_provider_driver !== row.provider_driver ||
          row.current_process_instance_id !== row.process_instance_id ||
          row.current_certificate_fingerprint !== row.certificate_fingerprint ||
          row.current_certificate_generation !== row.certificate_generation ||
          row.current_worker_lease_generation !== row.worker_lease_generation ||
          row.current_route_generation !== row.route_generation ||
          row.operation_id !== request.operationId ||
          row.command_id !== request.commandId ||
          row.approval_id !== request.approvalId ||
          row.approval_generation !== request.approvalGeneration ||
          row.approval_action !== request.approvalAction ||
          row.expires_at !== request.leaseExpiresAt ||
          !sameRepository(row, request.repository) ||
          row.sandbox_state !== "active"
        ) {
          return yield* failure("identityMismatch", false);
        }
        if (row.used_at !== null) return yield* failure("used", false);
        if (row.expires_at <= now) return yield* failure("expired", false);
        const approval = yield* Effect.try({
          try: () => decodeApproval(row.approval_payload),
          catch: (cause) => failure("approvalInvalid", false, cause),
        });
        if (
          row.approval_state !== "approved" ||
          row.current_approval_generation !== row.approval_generation ||
          approval.approvalId !== row.approval_id ||
          approval.workspaceId !== row.workspace_id ||
          approval.threadId !== row.thread_id ||
          approval.decidedByUserId !== row.actor_user_id ||
          approval.decidedBy !== row.auth_session_id ||
          !approval.actions.includes(row.approval_action) ||
          !sameRepository(row, approval.repository) ||
          approval.expiresAt <= now
        ) {
          return yield* failure("approvalInvalid", false);
        }
        const token = yield* input.vault.redeem({
          leaseRef: request.leaseRef,
          secretRef: row.secret_ref,
        });
        const used = yield* Effect.tryPromise({
          try: () =>
            client.query(
              `UPDATE github_worker_token_lease SET used_at = $2
                WHERE lease_ref = $1 AND used_at IS NULL RETURNING lease_ref`,
              [request.leaseRef, now],
            ),
          catch: (cause) => failure("databaseFailure", true, cause),
        });
        if (used.rowCount !== 1) return yield* failure("used", false);
        return { token, expiresAt: row.expires_at };
      }),
    ),
});
