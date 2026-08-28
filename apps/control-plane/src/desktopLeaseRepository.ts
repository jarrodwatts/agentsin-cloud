// @effect-diagnostics nodeBuiltinImport:off -- Lease ids and request fingerprints are generated at the PostgreSQL adapter boundary.
import * as NodeCrypto from "node:crypto";

import type { AuthSessionId } from "@t3tools/contracts";
import type {
  DesktopControlBinding,
  DesktopControlClientId,
  DesktopLeaseGeneration,
  DesktopLeaseIdempotencyKey,
  DesktopInputPermit,
} from "@t3tools/contracts/desktop-lease";
import type { DesktopLeaseId, WorkspaceId } from "@t3tools/contracts/cloud";
import * as DateTime from "effect/DateTime";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { lockCloudThreadMutation } from "./cloudThreadMutationLock.ts";

export type DesktopLeaseRecordState = "active" | "released" | "expired" | "revoked";
export type DesktopLeaseConnectionState = "connected" | "disconnected";
export type DesktopLeaseReleaseReason =
  | "released"
  | "heartbeatExpired"
  | "holderDisconnected"
  | "revoked"
  | "superseded";

export interface DesktopLeaseActor {
  readonly userId: string;
  readonly authSessionId: AuthSessionId;
  readonly clientId: DesktopControlClientId;
}

export interface DesktopLeaseRecord {
  readonly leaseId: DesktopLeaseId;
  readonly binding: DesktopControlBinding;
  readonly generation: DesktopLeaseGeneration;
  readonly actor: DesktopLeaseActor;
  readonly connectionState: DesktopLeaseConnectionState;
  readonly state: DesktopLeaseRecordState;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
  readonly expiresAt: string;
  readonly disconnectedAt?: string;
  readonly endedAt?: string;
  readonly releaseReason?: DesktopLeaseReleaseReason;
  readonly updatedAt: string;
}

export interface DesktopLeaseMutationResult {
  readonly disposition: "applied" | "replayed";
  readonly lease: DesktopLeaseRecord;
}

export interface DesktopRouteAuthoritySnapshot {
  readonly lease?: DesktopLeaseRecord;
  readonly latestGeneration: number;
}

export interface DesktopLeaseRepository {
  readonly current: (input: {
    readonly workspaceId: WorkspaceId;
    readonly threadId: DesktopControlBinding["threadId"];
    readonly now: string;
  }) => Promise<DesktopLeaseRecord | undefined>;
  readonly expireCurrent: (input: {
    readonly binding: DesktopControlBinding;
    readonly now: string;
  }) => Promise<DesktopLeaseRecord | undefined>;
  readonly acquire: (input: {
    readonly binding: DesktopControlBinding;
    readonly actor: DesktopLeaseActor;
    readonly leaseId: DesktopLeaseId;
    readonly resumeSecretHash: string;
    readonly idempotencyKey: DesktopLeaseIdempotencyKey;
    readonly now: string;
    readonly expiresAt: string;
  }) => Promise<DesktopLeaseMutationResult>;
  readonly heartbeat: (input: {
    readonly leaseId: DesktopLeaseId;
    readonly generation: DesktopLeaseGeneration;
    readonly binding: DesktopControlBinding;
    readonly actor: DesktopLeaseActor;
    readonly idempotencyKey: DesktopLeaseIdempotencyKey;
    readonly now: string;
    readonly expiresAt: string;
  }) => Promise<DesktopLeaseMutationResult>;
  readonly release: (input: {
    readonly leaseId: DesktopLeaseId;
    readonly generation: DesktopLeaseGeneration;
    readonly binding: DesktopControlBinding;
    readonly actor: DesktopLeaseActor;
    readonly idempotencyKey: DesktopLeaseIdempotencyKey;
    readonly now: string;
  }) => Promise<DesktopLeaseMutationResult>;
  readonly disconnect: (input: {
    readonly binding: DesktopControlBinding;
    readonly actor: DesktopLeaseActor;
    readonly idempotencyKey: DesktopLeaseIdempotencyKey;
    readonly now: string;
    readonly graceExpiresAt: string;
  }) => Promise<DesktopLeaseRecord | undefined>;
  readonly resume: (input: {
    readonly leaseId: DesktopLeaseId;
    readonly generation: DesktopLeaseGeneration;
    readonly binding: DesktopControlBinding;
    readonly actor: DesktopLeaseActor;
    readonly resumeSecretHash: string;
    readonly nextResumeSecretHash: string;
    readonly idempotencyKey: DesktopLeaseIdempotencyKey;
    readonly now: string;
    readonly expiresAt: string;
  }) => Promise<DesktopLeaseMutationResult>;
  readonly rebindRoute: (input: {
    readonly binding: DesktopControlBinding;
    readonly now: string;
    readonly idempotencyKey: DesktopLeaseIdempotencyKey;
  }) => Promise<DesktopRouteAuthoritySnapshot>;
  readonly authorizeUserInput: (input: {
    readonly binding: DesktopControlBinding;
    readonly actor: DesktopLeaseActor;
    readonly now: string;
  }) => Promise<DesktopInputPermit>;
  readonly authorizeAgentInput: (input: {
    readonly binding: DesktopControlBinding;
    readonly now: string;
  }) => Promise<void>;
  readonly revokeBinding: (input: {
    readonly binding: DesktopControlBinding;
    readonly now: string;
    readonly idempotencyKey: DesktopLeaseIdempotencyKey;
  }) => Promise<DesktopLeaseRecord | undefined>;
  readonly revokeCurrent: (input: {
    readonly workspaceId: WorkspaceId;
    readonly threadId: DesktopControlBinding["threadId"];
    readonly sandboxId?: DesktopControlBinding["sandboxId"];
    readonly now: string;
    readonly idempotencyKey: DesktopLeaseIdempotencyKey;
  }) => Promise<DesktopLeaseRecord | undefined>;
  readonly sweepExpired: (input: {
    readonly now: string;
    readonly limit: number;
  }) => Promise<ReadonlyArray<DesktopLeaseRecord>>;
  readonly purgeEndedBefore: (input: {
    readonly before: string;
    readonly limit: number;
  }) => Promise<number>;
}

export class DesktopLeaseRepositoryError extends Error {
  readonly code:
    | "conflict"
    | "forbidden"
    | "notFound"
    | "staleBinding"
    | "expired"
    | "transportRejected"
    | "databaseFailure";

  constructor(
    code: DesktopLeaseRepositoryError["code"],
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "DesktopLeaseRepositoryError";
    this.code = code;
  }
}

interface LeaseRow extends QueryResultRow {
  readonly workspace_id: string;
  readonly thread_id: string;
  readonly lease_id: string;
  readonly generation: string;
  readonly attempt_id: string;
  readonly environment_id: string;
  readonly environment_revision_id: string;
  readonly sandbox_id: string;
  readonly worker_id: string;
  readonly route_generation: string;
  readonly holder_user_id: string;
  readonly holder_auth_session_id: string;
  readonly holder_client_id: string;
  readonly connection_state: DesktopLeaseConnectionState;
  readonly state: DesktopLeaseRecordState;
  readonly acquired_at: string | Date;
  readonly heartbeat_at: string | Date;
  readonly expires_at: string | Date;
  readonly disconnected_at: string | Date | null;
  readonly ended_at: string | Date | null;
  readonly release_reason: DesktopLeaseReleaseReason | null;
  readonly updated_at: string | Date;
}

interface IdempotencyRow extends QueryResultRow {
  readonly request_fingerprint: string;
  readonly lease_id: string;
  readonly generation: string;
}

const leaseColumns = `workspace_id::text AS workspace_id, thread_id, lease_id::text AS lease_id,
  generation::text AS generation, attempt_id, environment_id, environment_revision_id,
  sandbox_id, worker_id, route_generation::text AS route_generation, holder_user_id,
  holder_auth_session_id, holder_client_id, connection_state, state,
  acquired_at, heartbeat_at, expires_at, disconnected_at, ended_at, release_reason, updated_at`;

const iso = (value: string | Date) => DateTime.formatIso(DateTime.makeUnsafe(value));

const toRecord = (row: LeaseRow): DesktopLeaseRecord => ({
  leaseId: row.lease_id as DesktopLeaseId,
  binding: {
    workspaceId: row.workspace_id as WorkspaceId,
    threadId: row.thread_id as DesktopControlBinding["threadId"],
    attemptId: row.attempt_id,
    environmentId: row.environment_id as DesktopControlBinding["environmentId"],
    environmentRevisionId:
      row.environment_revision_id as DesktopControlBinding["environmentRevisionId"],
    sandboxId: row.sandbox_id as DesktopControlBinding["sandboxId"],
    workerId: row.worker_id,
    routeGeneration: Number(row.route_generation) as DesktopControlBinding["routeGeneration"],
  },
  generation: Number(row.generation) as DesktopLeaseGeneration,
  actor: {
    userId: row.holder_user_id,
    authSessionId: row.holder_auth_session_id as AuthSessionId,
    clientId: row.holder_client_id as DesktopControlClientId,
  },
  connectionState: row.connection_state,
  state: row.state,
  acquiredAt: iso(row.acquired_at),
  heartbeatAt: iso(row.heartbeat_at),
  expiresAt: iso(row.expires_at),
  ...(row.disconnected_at === null ? {} : { disconnectedAt: iso(row.disconnected_at) }),
  ...(row.ended_at === null ? {} : { endedAt: iso(row.ended_at) }),
  ...(row.release_reason === null ? {} : { releaseReason: row.release_reason }),
  updatedAt: iso(row.updated_at),
});

const fingerprint = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

const sameBinding = (left: DesktopControlBinding, right: DesktopControlBinding) =>
  left.workspaceId === right.workspaceId &&
  left.threadId === right.threadId &&
  left.attemptId === right.attemptId &&
  left.environmentId === right.environmentId &&
  left.environmentRevisionId === right.environmentRevisionId &&
  left.sandboxId === right.sandboxId &&
  left.workerId === right.workerId &&
  left.routeGeneration === right.routeGeneration;

const sameActor = (left: DesktopLeaseActor, right: DesktopLeaseActor) =>
  left.userId === right.userId &&
  left.authSessionId === right.authSessionId &&
  left.clientId === right.clientId;

const transaction = async <A>(pool: Pool, use: (client: PoolClient) => Promise<A>) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await use(client);
    await client.query("COMMIT");
    return result;
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (cause instanceof DesktopLeaseRepositoryError) throw cause;
    throw new DesktopLeaseRepositoryError("databaseFailure", "Desktop lease transaction failed", {
      cause,
    });
  } finally {
    client.release();
  }
};

const assertCurrentLifecycle = async (
  client: PoolClient,
  binding: DesktopControlBinding,
  requireRunningRuntime = false,
) => {
  const result = await client.query<{
    readonly attempt_id: string;
    readonly environment_id: string;
    readonly environment_revision_id: string;
    readonly sandbox_id: string | null;
    readonly worker_id: string | null;
    readonly state: string;
    readonly runtime_state: string | null;
  }>(
    `SELECT attempt.attempt_id, attempt.environment_id, attempt.environment_revision_id,
            attempt.sandbox_id, attempt.worker_id, attempt.state,
            runtime.state AS runtime_state
       FROM cloud_thread_lifecycle_attempt AS attempt
       JOIN cloud_thread_runtime AS runtime
         ON runtime.workspace_id = attempt.workspace_id
        AND runtime.thread_id = attempt.thread_id
        AND runtime.attempt_id = attempt.attempt_id
      WHERE attempt.workspace_id = $1 AND attempt.thread_id = $2 AND attempt.is_current
      FOR SHARE OF attempt, runtime`,
    [binding.workspaceId, binding.threadId],
  );
  const current = result.rows[0];
  if (
    current === undefined ||
    current.state !== "ready" ||
    (requireRunningRuntime && current.runtime_state !== "running") ||
    current.attempt_id !== binding.attemptId ||
    current.environment_id !== binding.environmentId ||
    current.environment_revision_id !== binding.environmentRevisionId ||
    current.sandbox_id !== binding.sandboxId ||
    current.worker_id !== binding.workerId
  ) {
    throw new DesktopLeaseRepositoryError(
      "staleBinding",
      "Desktop control is not bound to the current ready lifecycle",
    );
  }
};

const allocateGeneration = async (
  client: PoolClient,
  binding: Pick<DesktopControlBinding, "workspaceId" | "threadId">,
  now: string,
) => {
  const result = await client.query<{ readonly generation: string }>(
    `INSERT INTO cloud_desktop_lease_generation
      (workspace_id, thread_id, last_generation, updated_at)
     VALUES ($1, $2, 1, $3)
     ON CONFLICT (workspace_id, thread_id) DO UPDATE
       SET last_generation = cloud_desktop_lease_generation.last_generation + 1,
           updated_at = EXCLUDED.updated_at
     RETURNING last_generation::text AS generation`,
    [binding.workspaceId, binding.threadId, now],
  );
  return Number(result.rows[0]!.generation) as DesktopLeaseGeneration;
};

const loadLease = async (
  client: PoolClient,
  workspaceId: WorkspaceId,
  threadId: DesktopControlBinding["threadId"],
  leaseId: DesktopLeaseId,
) => {
  const result = await client.query<LeaseRow>(
    `SELECT ${leaseColumns}
       FROM cloud_desktop_lease
      WHERE workspace_id = $1 AND thread_id = $2 AND lease_id = $3
      FOR UPDATE`,
    [workspaceId, threadId, leaseId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new DesktopLeaseRepositoryError("notFound", "Desktop lease was not found");
  }
  return toRecord(row);
};

const loadActive = async (
  client: PoolClient,
  workspaceId: WorkspaceId,
  threadId: DesktopControlBinding["threadId"],
) => {
  const result = await client.query<LeaseRow>(
    `SELECT ${leaseColumns}
       FROM cloud_desktop_lease
      WHERE workspace_id = $1 AND thread_id = $2 AND state = 'active'
      FOR UPDATE`,
    [workspaceId, threadId],
  );
  return result.rows[0] === undefined ? undefined : toRecord(result.rows[0]);
};

const eventIdempotency = async (
  client: PoolClient,
  workspaceId: WorkspaceId,
  idempotencyKey: DesktopLeaseIdempotencyKey,
  expectedFingerprint: string,
) => {
  const result = await client.query<IdempotencyRow>(
    `SELECT request_fingerprint, lease_id::text AS lease_id, generation::text AS generation
       FROM cloud_desktop_lease_event
      WHERE workspace_id = $1 AND idempotency_key = $2`,
    [workspaceId, idempotencyKey],
  );
  const existing = result.rows[0];
  if (existing !== undefined && existing.request_fingerprint !== expectedFingerprint) {
    throw new DesktopLeaseRepositoryError(
      "conflict",
      "Desktop lease idempotency key was reused with different input",
    );
  }
  return existing;
};

const appendEvent = (
  client: PoolClient,
  input: {
    readonly lease: DesktopLeaseRecord;
    readonly kind:
      | "acquired"
      | "heartbeat"
      | "disconnected"
      | "reconnected"
      | "rebound"
      | "released"
      | "expired"
      | "revoked";
    readonly idempotencyKey: string;
    readonly requestFingerprint: string;
    readonly occurredAt: string;
  },
) =>
  client.query(
    `INSERT INTO cloud_desktop_lease_event
      (workspace_id, thread_id, event_id, lease_id, generation, event_kind,
       idempotency_key, request_fingerprint, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.lease.binding.workspaceId,
      input.lease.binding.threadId,
      NodeCrypto.randomUUID(),
      input.lease.leaseId,
      input.lease.generation,
      input.kind,
      input.idempotencyKey,
      input.requestFingerprint,
      input.occurredAt,
    ],
  );

const endLease = async (
  client: PoolClient,
  lease: DesktopLeaseRecord,
  input: {
    readonly state: "released" | "expired" | "revoked";
    readonly reason: DesktopLeaseReleaseReason;
    readonly kind: "released" | "expired" | "revoked";
    readonly idempotencyKey: string;
    readonly requestFingerprint: string;
    readonly now: string;
  },
) => {
  const result = await client.query<LeaseRow>(
    `UPDATE cloud_desktop_lease
        SET state = $4, release_reason = $5, ended_at = $6, updated_at = $6
      WHERE workspace_id = $1 AND thread_id = $2 AND lease_id = $3 AND state = 'active'
      RETURNING ${leaseColumns}`,
    [
      lease.binding.workspaceId,
      lease.binding.threadId,
      lease.leaseId,
      input.state,
      input.reason,
      input.now,
    ],
  );
  const ended = result.rows[0] === undefined ? lease : toRecord(result.rows[0]);
  if (result.rows[0] !== undefined) {
    await appendEvent(client, {
      lease: ended,
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      occurredAt: input.now,
    });
  }
  return ended;
};

const expireIfDue = async (
  client: PoolClient,
  lease: DesktopLeaseRecord | undefined,
  now: string,
) => {
  if (lease === undefined || lease.state !== "active" || lease.expiresAt > now) return lease;
  return endLease(client, lease, {
    state: "expired",
    reason: lease.connectionState === "disconnected" ? "holderDisconnected" : "heartbeatExpired",
    kind: "expired",
    idempotencyKey: `desktop-expire:${lease.leaseId}:${lease.generation}`,
    requestFingerprint: fingerprint({
      type: "expire",
      leaseId: lease.leaseId,
      generation: lease.generation,
    }),
    now,
  });
};

const requireActive = (
  lease: DesktopLeaseRecord,
  input: {
    readonly binding: DesktopControlBinding;
    readonly actor?: DesktopLeaseActor;
    readonly generation: DesktopLeaseGeneration;
    readonly now: string;
    readonly requireConnected?: boolean;
  },
) => {
  if (!sameBinding(lease.binding, input.binding)) {
    throw new DesktopLeaseRepositoryError("staleBinding", "Desktop lease binding is stale");
  }
  if (lease.generation !== input.generation || lease.state !== "active") {
    throw new DesktopLeaseRepositoryError(
      "conflict",
      "Desktop lease generation is no longer active",
    );
  }
  if (lease.expiresAt <= input.now) {
    throw new DesktopLeaseRepositoryError("expired", "Desktop lease has expired");
  }
  if (input.actor !== undefined && !sameActor(lease.actor, input.actor)) {
    throw new DesktopLeaseRepositoryError("forbidden", "Desktop lease belongs to another client");
  }
  if (input.requireConnected === true && lease.connectionState !== "connected") {
    throw new DesktopLeaseRepositoryError("forbidden", "Desktop lease holder is disconnected");
  }
};

export const makePostgresDesktopLeaseRepository = (pool: Pool): DesktopLeaseRepository => ({
  current: (input) =>
    transaction(pool, async (client) => {
      await lockCloudThreadMutation(client, input);
      return loadActive(client, input.workspaceId, input.threadId);
    }),

  expireCurrent: (input) =>
    transaction(pool, async (client) => {
      await lockCloudThreadMutation(client, input.binding);
      await assertCurrentLifecycle(client, input.binding);
      const active = await loadActive(client, input.binding.workspaceId, input.binding.threadId);
      if (active === undefined || !sameBinding(active.binding, input.binding)) return undefined;
      return expireIfDue(client, active, input.now);
    }),

  acquire: (input) =>
    transaction(pool, async (client) => {
      await lockCloudThreadMutation(client, input.binding);
      await assertCurrentLifecycle(client, input.binding, true);
      const requestFingerprint = fingerprint({
        type: "acquire",
        binding: input.binding,
        actor: {
          userId: input.actor.userId,
          authSessionId: input.actor.authSessionId,
        },
      });
      const replay = await eventIdempotency(
        client,
        input.binding.workspaceId,
        input.idempotencyKey,
        requestFingerprint,
      );
      if (replay !== undefined) {
        return {
          disposition: "replayed",
          lease: await loadLease(
            client,
            input.binding.workspaceId,
            input.binding.threadId,
            replay.lease_id as DesktopLeaseId,
          ),
        };
      }
      const active = await loadActive(client, input.binding.workspaceId, input.binding.threadId);
      const current = await expireIfDue(client, active, input.now);
      if (current?.state === "active") {
        throw new DesktopLeaseRepositoryError("conflict", "Desktop control is already held");
      }
      const generation = await allocateGeneration(client, input.binding, input.now);
      const inserted = await client.query<LeaseRow>(
        `INSERT INTO cloud_desktop_lease
          (workspace_id, thread_id, lease_id, generation, acquire_idempotency_key,
           acquire_fingerprint, attempt_id, environment_id, environment_revision_id,
           sandbox_id, worker_id, route_generation, holder_user_id, holder_auth_session_id,
           holder_client_id, resume_secret_hash, connection_state, state, acquired_at,
           heartbeat_at, expires_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                 $15, $16, 'connected', 'active', $17, $17, $18, $17)
         RETURNING ${leaseColumns}`,
        [
          input.binding.workspaceId,
          input.binding.threadId,
          input.leaseId,
          generation,
          input.idempotencyKey,
          requestFingerprint,
          input.binding.attemptId,
          input.binding.environmentId,
          input.binding.environmentRevisionId,
          input.binding.sandboxId,
          input.binding.workerId,
          input.binding.routeGeneration,
          input.actor.userId,
          input.actor.authSessionId,
          input.actor.clientId,
          input.resumeSecretHash,
          input.now,
          input.expiresAt,
        ],
      );
      const lease = toRecord(inserted.rows[0]!);
      await appendEvent(client, {
        lease,
        kind: "acquired",
        idempotencyKey: input.idempotencyKey,
        requestFingerprint,
        occurredAt: input.now,
      });
      return { disposition: "applied", lease };
    }),

  heartbeat: (input) =>
    transaction(pool, async (client) => {
      await lockCloudThreadMutation(client, input.binding);
      await assertCurrentLifecycle(client, input.binding, true);
      const requestFingerprint = fingerprint({
        type: "heartbeat",
        leaseId: input.leaseId,
        generation: input.generation,
        binding: input.binding,
        actor: input.actor,
      });
      const replay = await eventIdempotency(
        client,
        input.binding.workspaceId,
        input.idempotencyKey,
        requestFingerprint,
      );
      if (replay !== undefined) {
        return {
          disposition: "replayed",
          lease: await loadLease(
            client,
            input.binding.workspaceId,
            input.binding.threadId,
            input.leaseId,
          ),
        };
      }
      const lease = await loadLease(
        client,
        input.binding.workspaceId,
        input.binding.threadId,
        input.leaseId,
      );
      requireActive(lease, {
        binding: input.binding,
        actor: input.actor,
        generation: input.generation,
        now: input.now,
        requireConnected: true,
      });
      const updated = await client.query<LeaseRow>(
        `UPDATE cloud_desktop_lease
            SET heartbeat_at = $4, expires_at = $5, updated_at = $4
          WHERE workspace_id = $1 AND thread_id = $2 AND lease_id = $3 AND state = 'active'
          RETURNING ${leaseColumns}`,
        [
          input.binding.workspaceId,
          input.binding.threadId,
          input.leaseId,
          input.now,
          input.expiresAt,
        ],
      );
      const next = toRecord(updated.rows[0]!);
      await appendEvent(client, {
        lease: next,
        kind: "heartbeat",
        idempotencyKey: input.idempotencyKey,
        requestFingerprint,
        occurredAt: input.now,
      });
      return { disposition: "applied", lease: next };
    }),

  release: (input) =>
    transaction(pool, async (client) => {
      await lockCloudThreadMutation(client, input.binding);
      const requestFingerprint = fingerprint({
        type: "release",
        leaseId: input.leaseId,
        generation: input.generation,
        binding: input.binding,
        actor: input.actor,
      });
      const replay = await eventIdempotency(
        client,
        input.binding.workspaceId,
        input.idempotencyKey,
        requestFingerprint,
      );
      if (replay !== undefined) {
        return {
          disposition: "replayed",
          lease: await loadLease(
            client,
            input.binding.workspaceId,
            input.binding.threadId,
            input.leaseId,
          ),
        };
      }
      const lease = await loadLease(
        client,
        input.binding.workspaceId,
        input.binding.threadId,
        input.leaseId,
      );
      if (lease.state !== "active") return { disposition: "replayed", lease };
      requireActive(lease, {
        binding: input.binding,
        actor: input.actor,
        generation: input.generation,
        now: input.now,
      });
      return {
        disposition: "applied",
        lease: await endLease(client, lease, {
          state: "released",
          reason: "released",
          kind: "released",
          idempotencyKey: input.idempotencyKey,
          requestFingerprint,
          now: input.now,
        }),
      };
    }),

  disconnect: (input) =>
    transaction(pool, async (client) => {
      await lockCloudThreadMutation(client, input.binding);
      const active = await loadActive(client, input.binding.workspaceId, input.binding.threadId);
      if (active === undefined || !sameBinding(active.binding, input.binding)) return undefined;
      if (!sameActor(active.actor, input.actor)) return active;
      if (active.connectionState === "disconnected") return active;
      const requestFingerprint = fingerprint({
        type: "disconnect",
        leaseId: active.leaseId,
        generation: active.generation,
        actor: input.actor,
      });
      const eventKey = `${input.idempotencyKey}:${active.leaseId}:${active.generation}`;
      const replay = await eventIdempotency(
        client,
        input.binding.workspaceId,
        eventKey as DesktopLeaseIdempotencyKey,
        requestFingerprint,
      );
      if (replay !== undefined) return active;
      const updated = await client.query<LeaseRow>(
        `UPDATE cloud_desktop_lease
            SET connection_state = 'disconnected', disconnected_at = $4,
                expires_at = LEAST(expires_at, $5::timestamptz), updated_at = $4
          WHERE workspace_id = $1 AND thread_id = $2 AND lease_id = $3 AND state = 'active'
          RETURNING ${leaseColumns}`,
        [
          input.binding.workspaceId,
          input.binding.threadId,
          active.leaseId,
          input.now,
          input.graceExpiresAt,
        ],
      );
      const next = toRecord(updated.rows[0]!);
      await appendEvent(client, {
        lease: next,
        kind: "disconnected",
        idempotencyKey: eventKey,
        requestFingerprint,
        occurredAt: input.now,
      });
      return next;
    }),

  resume: (input) =>
    transaction(pool, async (client) => {
      await lockCloudThreadMutation(client, input.binding);
      await assertCurrentLifecycle(client, input.binding, true);
      const requestFingerprint = fingerprint({
        type: "resume",
        leaseId: input.leaseId,
        generation: input.generation,
        binding: input.binding,
        actor: {
          userId: input.actor.userId,
          authSessionId: input.actor.authSessionId,
        },
        resumeSecretHash: input.resumeSecretHash,
        nextResumeSecretHash: input.nextResumeSecretHash,
      });
      const replay = await eventIdempotency(
        client,
        input.binding.workspaceId,
        input.idempotencyKey,
        requestFingerprint,
      );
      if (replay !== undefined) {
        return {
          disposition: "replayed",
          lease: await loadLease(
            client,
            input.binding.workspaceId,
            input.binding.threadId,
            input.leaseId,
          ),
        };
      }
      const lease = await loadLease(
        client,
        input.binding.workspaceId,
        input.binding.threadId,
        input.leaseId,
      );
      if (
        lease.generation !== input.generation ||
        lease.state !== "active" ||
        lease.expiresAt <= input.now ||
        lease.connectionState !== "disconnected" ||
        lease.actor.userId !== input.actor.userId ||
        lease.actor.authSessionId !== input.actor.authSessionId ||
        !sameBinding(lease.binding, input.binding)
      ) {
        throw new DesktopLeaseRepositoryError("forbidden", "Desktop lease cannot be resumed");
      }
      const secret = await client.query<{ readonly resume_secret_hash: string }>(
        `SELECT resume_secret_hash
           FROM cloud_desktop_lease
          WHERE workspace_id = $1 AND thread_id = $2 AND lease_id = $3
          FOR UPDATE`,
        [input.binding.workspaceId, input.binding.threadId, input.leaseId],
      );
      if (secret.rows[0]?.resume_secret_hash !== input.resumeSecretHash) {
        throw new DesktopLeaseRepositoryError("forbidden", "Desktop lease resume proof is invalid");
      }
      const nextGeneration = await allocateGeneration(client, input.binding, input.now);
      const updated = await client.query<LeaseRow>(
        `UPDATE cloud_desktop_lease
            SET generation = $4, holder_client_id = $5,
                resume_secret_hash = $6, connection_state = 'connected', disconnected_at = NULL,
                heartbeat_at = $7, expires_at = $8, updated_at = $7
          WHERE workspace_id = $1 AND thread_id = $2 AND lease_id = $3 AND state = 'active'
          RETURNING ${leaseColumns}`,
        [
          input.binding.workspaceId,
          input.binding.threadId,
          input.leaseId,
          nextGeneration,
          input.actor.clientId,
          input.nextResumeSecretHash,
          input.now,
          input.expiresAt,
        ],
      );
      const next = toRecord(updated.rows[0]!);
      await appendEvent(client, {
        lease: next,
        kind: "reconnected",
        idempotencyKey: input.idempotencyKey,
        requestFingerprint,
        occurredAt: input.now,
      });
      return { disposition: "applied", lease: next };
    }),

  rebindRoute: (input) =>
    transaction(pool, async (client) => {
      await lockCloudThreadMutation(client, input.binding);
      await assertCurrentLifecycle(client, input.binding, true);
      const active = await loadActive(client, input.binding.workspaceId, input.binding.threadId);
      const current = await expireIfDue(client, active, input.now);
      if (current === undefined || current.state !== "active") {
        const latestGeneration = await allocateGeneration(client, input.binding, input.now);
        return { latestGeneration };
      }
      const immutableBindingMatches =
        current.binding.workspaceId === input.binding.workspaceId &&
        current.binding.threadId === input.binding.threadId &&
        current.binding.attemptId === input.binding.attemptId &&
        current.binding.environmentId === input.binding.environmentId &&
        current.binding.environmentRevisionId === input.binding.environmentRevisionId &&
        current.binding.sandboxId === input.binding.sandboxId &&
        current.binding.workerId === input.binding.workerId;
      if (
        !immutableBindingMatches ||
        input.binding.routeGeneration < current.binding.routeGeneration
      ) {
        throw new DesktopLeaseRepositoryError("staleBinding", "Desktop route cannot rebind lease");
      }
      if (input.binding.routeGeneration === current.binding.routeGeneration) {
        return { lease: current, latestGeneration: current.generation };
      }
      const requestFingerprint = fingerprint({
        type: "rebind",
        leaseId: current.leaseId,
        generation: current.generation,
        binding: input.binding,
      });
      const replay = await eventIdempotency(
        client,
        input.binding.workspaceId,
        input.idempotencyKey,
        requestFingerprint,
      );
      if (replay !== undefined) {
        return { lease: current, latestGeneration: current.generation };
      }
      const updated = await client.query<LeaseRow>(
        `UPDATE cloud_desktop_lease
            SET generation = $4, route_generation = $5, updated_at = $6
          WHERE workspace_id = $1 AND thread_id = $2 AND lease_id = $3 AND state = 'active'
          RETURNING ${leaseColumns}`,
        [
          input.binding.workspaceId,
          input.binding.threadId,
          current.leaseId,
          await allocateGeneration(client, input.binding, input.now),
          input.binding.routeGeneration,
          input.now,
        ],
      );
      const next = toRecord(updated.rows[0]!);
      await appendEvent(client, {
        lease: next,
        kind: "rebound",
        idempotencyKey: input.idempotencyKey,
        requestFingerprint,
        occurredAt: input.now,
      });
      return { lease: next, latestGeneration: next.generation };
    }),

  authorizeUserInput: (input) =>
    transaction(pool, async (client) => {
      await lockCloudThreadMutation(client, input.binding);
      await assertCurrentLifecycle(client, input.binding, true);
      const active = await loadActive(client, input.binding.workspaceId, input.binding.threadId);
      if (active === undefined) {
        throw new DesktopLeaseRepositoryError("forbidden", "User does not hold desktop control");
      }
      requireActive(active, {
        binding: input.binding,
        actor: input.actor,
        generation: active.generation,
        now: input.now,
        requireConnected: true,
      });
      return {
        leaseId: active.leaseId,
        generation: active.generation,
        authorityRevision: (active.generation * 2 - 1) as DesktopInputPermit["authorityRevision"],
        binding: active.binding,
        expiresAt: active.expiresAt,
      };
    }),

  authorizeAgentInput: (input) =>
    transaction(pool, async (client) => {
      await lockCloudThreadMutation(client, input.binding);
      await assertCurrentLifecycle(client, input.binding, true);
      const active = await loadActive(client, input.binding.workspaceId, input.binding.threadId);
      if (active !== undefined) {
        throw new DesktopLeaseRepositoryError(
          "forbidden",
          "Agent computer input is paused while user control is active or disconnected",
        );
      }
    }),

  revokeBinding: (input) =>
    transaction(pool, async (client) => {
      await lockCloudThreadMutation(client, input.binding);
      const active = await loadActive(client, input.binding.workspaceId, input.binding.threadId);
      if (active === undefined || !sameBinding(active.binding, input.binding)) return undefined;
      const requestFingerprint = fingerprint({
        type: "revoke",
        leaseId: active.leaseId,
        generation: active.generation,
        binding: input.binding,
      });
      const eventKey = `${input.idempotencyKey}:${active.leaseId}:${active.generation}`;
      const replay = await eventIdempotency(
        client,
        input.binding.workspaceId,
        eventKey as DesktopLeaseIdempotencyKey,
        requestFingerprint,
      );
      if (replay !== undefined) return active;
      return endLease(client, active, {
        state: "revoked",
        reason: "revoked",
        kind: "revoked",
        idempotencyKey: eventKey,
        requestFingerprint,
        now: input.now,
      });
    }),

  revokeCurrent: (input) =>
    transaction(pool, async (client) => {
      await lockCloudThreadMutation(client, input);
      const active = await loadActive(client, input.workspaceId, input.threadId);
      if (
        active === undefined ||
        (input.sandboxId !== undefined && active.binding.sandboxId !== input.sandboxId)
      ) {
        return undefined;
      }
      const requestFingerprint = fingerprint({
        type: "revoke-current",
        leaseId: active.leaseId,
        generation: active.generation,
        sandboxId: input.sandboxId,
      });
      const eventKey = `${input.idempotencyKey}:${active.leaseId}:${active.generation}`;
      const replay = await eventIdempotency(
        client,
        input.workspaceId,
        eventKey as DesktopLeaseIdempotencyKey,
        requestFingerprint,
      );
      if (replay !== undefined) return active;
      return endLease(client, active, {
        state: "revoked",
        reason: "revoked",
        kind: "revoked",
        idempotencyKey: eventKey,
        requestFingerprint,
        now: input.now,
      });
    }),

  sweepExpired: (input) =>
    transaction(pool, async (client) => {
      const candidates = await client.query<LeaseRow>(
        `SELECT ${leaseColumns}
           FROM cloud_desktop_lease
          WHERE state = 'active' AND expires_at <= $1
          ORDER BY expires_at, workspace_id, thread_id
          FOR UPDATE SKIP LOCKED
          LIMIT $2`,
        [input.now, input.limit],
      );
      const expired: Array<DesktopLeaseRecord> = [];
      for (const row of candidates.rows) {
        const lease = toRecord(row);
        const ended = await expireIfDue(client, lease, input.now);
        if (ended !== undefined) expired.push(ended);
      }
      return expired;
    }),

  purgeEndedBefore: (input) =>
    transaction(pool, async (client) => {
      const deleted = await client.query(
        `DELETE FROM cloud_desktop_lease
          WHERE (workspace_id, thread_id, lease_id) IN (
            SELECT workspace_id, thread_id, lease_id
              FROM cloud_desktop_lease
             WHERE state <> 'active' AND ended_at < $1
             ORDER BY ended_at
             LIMIT $2
             FOR UPDATE SKIP LOCKED
          )`,
        [input.before, input.limit],
      );
      return deleted.rowCount ?? 0;
    }),
});
