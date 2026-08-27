import type { CommandId } from "@t3tools/contracts";
import { RepositoryIdentity } from "@t3tools/contracts";
import type { SandboxId } from "@t3tools/contracts/cloud";
import type {
  SandboxCleanupOrphanRecord,
  SandboxCreateReconciliationRecord,
  SandboxIdentityRecord,
  SandboxIdentityReservation,
  SandboxIdentityStore,
} from "@t3tools/e2b-sandbox";
import * as Schema from "effect/Schema";
import type { Pool, PoolClient, QueryResultRow } from "pg";

const decodeRepositoryIdentity = Schema.decodeUnknownSync(RepositoryIdentity);

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

interface IdentityRow extends QueryResultRow {
  readonly reservation_id: string;
  readonly workspace_id: string;
  readonly thread_id: string;
  readonly environment_id: string;
  readonly project_id: string;
  readonly revision_id: string;
  readonly repository_identity: unknown;
  readonly workspace_directory: string;
  readonly sandbox_id: string | null;
  readonly provider_handle: string | null;
  readonly state: "reserved" | "active" | "cleanup_required" | "failed" | "destroyed";
  readonly requested_at: string;
  readonly activated_at: string | null;
  readonly destroyed_at: string | null;
}

const selectIdentity = `SELECT reservation_id, workspace_id::text AS workspace_id, thread_id,
       environment_id, project_id, revision_id, repository_identity, workspace_directory,
       sandbox_id, provider_handle, state, requested_at::text AS requested_at,
       activated_at::text AS activated_at, destroyed_at::text AS destroyed_at
  FROM cloud_e2b_sandbox_identity`;

type ReservationIdentity = Pick<
  SandboxIdentityReservation,
  | "reservationId"
  | "workspaceId"
  | "threadId"
  | "environmentId"
  | "projectId"
  | "revisionId"
  | "repositoryIdentity"
  | "workspaceDirectory"
>;

const sameReservation = (row: IdentityRow, record: ReservationIdentity) =>
  row.reservation_id === record.reservationId &&
  row.workspace_id === record.workspaceId &&
  row.thread_id === record.threadId &&
  row.environment_id === record.environmentId &&
  row.project_id === record.projectId &&
  row.revision_id === record.revisionId &&
  row.workspace_directory === record.workspaceDirectory &&
  canonicalJson(decodeRepositoryIdentity(row.repository_identity)) ===
    canonicalJson(record.repositoryIdentity);

const sameIdentity = (row: IdentityRow, record: SandboxIdentityRecord) =>
  sameReservation(row, record) &&
  row.sandbox_id === record.sandboxId &&
  row.provider_handle === record.providerHandle;

const toIdentity = (row: IdentityRow): SandboxIdentityRecord | undefined => {
  if (row.sandbox_id === null || row.provider_handle === null) return undefined;
  return {
    reservationId: row.reservation_id as CommandId,
    sandboxId: row.sandbox_id as SandboxId,
    provider: "e2b",
    workspaceId: row.workspace_id as SandboxIdentityRecord["workspaceId"],
    environmentId: row.environment_id as SandboxIdentityRecord["environmentId"],
    projectId: row.project_id as SandboxIdentityRecord["projectId"],
    threadId: row.thread_id as SandboxIdentityRecord["threadId"],
    revisionId: row.revision_id as SandboxIdentityRecord["revisionId"],
    repositoryIdentity: decodeRepositoryIdentity(row.repository_identity),
    workspaceDirectory: row.workspace_directory,
    providerHandle: row.provider_handle,
    createdAt: row.activated_at ?? row.requested_at,
    ...(row.destroyed_at === null ? {} : { destroyedAt: row.destroyed_at }),
  };
};

const transaction = async <A>(pool: Pool, use: (client: PoolClient) => Promise<A>) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await use(client);
    await client.query("COMMIT");
    return value;
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw cause;
  } finally {
    client.release();
  }
};

const requireReservation = async (
  client: PoolClient,
  workspaceId: SandboxIdentityReservation["workspaceId"],
  reservationId: CommandId,
) => {
  const result = await client.query<IdentityRow>(
    `${selectIdentity} WHERE workspace_id = $1 AND reservation_id = $2 FOR UPDATE`,
    [workspaceId, reservationId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("E2B sandbox reservation was not found");
  return row;
};

/** PostgreSQL implementation of C1's durable reservation and cleanup fence. */
export const makePostgresSandboxIdentityStore = (pool: Pool): SandboxIdentityStore => ({
  reserve: (record) =>
    transaction(pool, async (client) => {
      await client.query(
        `INSERT INTO cloud_e2b_sandbox_identity
          (reservation_id, workspace_id, thread_id, environment_id, project_id, revision_id,
           repository_identity, workspace_directory, state, requested_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'reserved', $9)
         ON CONFLICT (workspace_id, reservation_id) DO NOTHING`,
        [
          record.reservationId,
          record.workspaceId,
          record.threadId,
          record.environmentId,
          record.projectId,
          record.revisionId,
          JSON.stringify(record.repositoryIdentity),
          record.workspaceDirectory,
          record.requestedAt,
        ],
      );
      const row = await requireReservation(client, record.workspaceId, record.reservationId);
      if (!sameReservation(row, record) || !["reserved", "active"].includes(row.state)) {
        throw new Error("E2B sandbox reservation identity conflicts with durable state");
      }
    }),

  activateReservation: (workspaceId, reservationId, record) =>
    transaction(pool, async (client) => {
      const row = await requireReservation(client, workspaceId, reservationId);
      if (row.state === "active") {
        if (!sameIdentity(row, record)) {
          throw new Error("E2B sandbox activation conflicts with durable identity");
        }
        return;
      }
      if (row.state !== "reserved" || !sameReservation(row, record)) {
        throw new Error("E2B sandbox reservation cannot be activated");
      }
      const updated = await client.query(
        `UPDATE cloud_e2b_sandbox_identity
            SET sandbox_id = $3, provider_handle = $4, state = 'active', activated_at = $5,
                updated_at = now()
          WHERE workspace_id = $1 AND reservation_id = $2 AND state = 'reserved'`,
        [workspaceId, reservationId, record.sandboxId, record.providerHandle, record.createdAt],
      );
      if (updated.rowCount !== 1) throw new Error("E2B sandbox activation lost its reservation");
    }),

  markReservationFailed: (workspaceId, reservationId, failedAt, reason) =>
    transaction(pool, async (client) => {
      const row = await requireReservation(client, workspaceId, reservationId);
      if (row.state === "failed") return;
      if (row.state === "active" && reason !== "remote-reclaimed") {
        throw new Error("An active E2B sandbox cannot be marked as a create failure");
      }
      const updated = await client.query(
        `UPDATE cloud_e2b_sandbox_identity
            SET state = 'failed', failure_reason = $3, failed_at = $4, updated_at = now()
          WHERE workspace_id = $1 AND reservation_id = $2
            AND state IN ('reserved', 'active', 'cleanup_required')`,
        [workspaceId, reservationId, reason, failedAt],
      );
      if (updated.rowCount !== 1) throw new Error("E2B sandbox failure transition was rejected");
    }),

  markReservationCleanupRequired: (record: SandboxCreateReconciliationRecord) =>
    transaction(pool, async (client) => {
      const row = await requireReservation(client, record.workspaceId, record.reservationId);
      if (row.state === "cleanup_required") return;
      if (row.state !== "reserved") {
        throw new Error("Only an unresolved E2B create can require reconciliation");
      }
      const updated = await client.query(
        `UPDATE cloud_e2b_sandbox_identity
            SET state = 'cleanup_required',
                provider_handle = COALESCE(provider_handle, $3),
                sandbox_id = CASE
                  WHEN sandbox_id IS NOT NULL THEN sandbox_id
                  WHEN $3::text IS NOT NULL THEN $3
                  ELSE NULL
                END,
                reclaim_metadata = $4::jsonb, failure_reason = $5, updated_at = now()
          WHERE workspace_id = $1 AND reservation_id = $2 AND state = 'reserved'`,
        [
          record.workspaceId,
          record.reservationId,
          record.providerHandle ?? null,
          JSON.stringify(record.reclaimMetadata),
          record.reason,
        ],
      );
      if (updated.rowCount !== 1) throw new Error("E2B cleanup-required transition was rejected");
    }),

  get: async (workspaceId, sandboxId) => {
    const result = await pool.query<IdentityRow>(
      `${selectIdentity} WHERE workspace_id = $1 AND sandbox_id = $2`,
      [workspaceId, sandboxId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toIdentity(row);
  },

  markDestroyed: (workspaceId, sandboxId, destroyedAt) =>
    transaction(pool, async (client) => {
      const updated = await client.query(
        `UPDATE cloud_e2b_sandbox_identity
            SET state = 'destroyed', destroyed_at = $3, updated_at = now()
          WHERE workspace_id = $1 AND sandbox_id = $2 AND state = 'active'`,
        [workspaceId, sandboxId, destroyedAt],
      );
      if (updated.rowCount !== 1) {
        const existing = await client.query<IdentityRow>(
          `${selectIdentity} WHERE workspace_id = $1 AND sandbox_id = $2 FOR UPDATE`,
          [workspaceId, sandboxId],
        );
        if (existing.rows[0]?.state !== "destroyed") {
          throw new Error("E2B sandbox destroy transition was rejected");
        }
      }
    }),

  recordCleanupOrphan: (record: SandboxCleanupOrphanRecord) =>
    transaction(pool, async (client) => {
      await client.query(
        `INSERT INTO cloud_e2b_sandbox_cleanup_orphan
          (orphan_id, reservation_id, workspace_id, sandbox_id, provider_handle, reason, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (workspace_id, orphan_id) DO NOTHING`,
        [
          record.orphanId,
          record.reservationId,
          record.identity.workspaceId,
          record.identity.sandboxId,
          record.identity.providerHandle,
          record.reason,
          record.recordedAt,
        ],
      );
    }),

  recordCleanupFailure: (workspaceId, orphanId, attemptedAt) =>
    pool
      .query(
        `UPDATE cloud_e2b_sandbox_cleanup_orphan
            SET last_attempted_at = $3
          WHERE workspace_id = $1 AND orphan_id = $2 AND state = 'cleanup_required'`,
        [workspaceId, orphanId, attemptedAt],
      )
      .then(() => undefined),

  markCleanupOrphanReclaimed: (workspaceId, orphanId, reclaimedAt) =>
    pool
      .query(
        `UPDATE cloud_e2b_sandbox_cleanup_orphan
            SET state = 'reclaimed', reclaimed_at = $3
          WHERE workspace_id = $1 AND orphan_id = $2 AND state = 'cleanup_required'`,
        [workspaceId, orphanId, reclaimedAt],
      )
      .then(() => undefined),
});

export interface E2bReservationInspection {
  readonly state: IdentityRow["state"];
  readonly identity?: SandboxIdentityRecord;
}

/** Recovery-only lookup by the C1 reservation identity. */
export const inspectE2bReservation = async (
  pool: Pool,
  workspaceId: SandboxIdentityReservation["workspaceId"],
  reservationId: CommandId,
): Promise<E2bReservationInspection | undefined> => {
  const result = await pool.query<IdentityRow>(
    `${selectIdentity} WHERE workspace_id = $1 AND reservation_id = $2`,
    [workspaceId, reservationId],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  const identity = toIdentity(row);
  return { state: row.state, ...(identity === undefined ? {} : { identity }) };
};
