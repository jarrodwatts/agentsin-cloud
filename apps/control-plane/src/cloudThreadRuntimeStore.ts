// @effect-diagnostics nodeBuiltinImport:off -- Durable request fingerprints use audited SHA-256.
import * as NodeCrypto from "node:crypto";

import type {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { EnvironmentRevisionId, SandboxId, WorkspaceId } from "@t3tools/contracts/cloud";
import type { WorkerInstanceId } from "@t3tools/contracts/worker";
import * as DateTime from "effect/DateTime";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { lockCloudThreadMutation } from "./cloudThreadMutationLock.ts";

export const CLOUD_THREAD_IDLE_MS = 15 * 60_000;

export type CloudThreadRuntimeState =
  | "running"
  | "pause_dispatched"
  | "paused"
  | "resume_dispatched"
  | "resume_bootstrap_dispatched"
  | "resume_worker_start_dispatched"
  | "reconciliation_required";

export type CloudThreadRuntimeActivitySource = "agent" | "preview";
export type CloudThreadResumeReason = "message" | "inspector" | "approved_continuation";

export interface CloudThreadRuntimeRecord {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly attemptId: string;
  readonly environmentId: EnvironmentId;
  readonly environmentRevisionId: EnvironmentRevisionId;
  readonly sandboxId: SandboxId;
  readonly workerId: WorkerInstanceId;
  readonly sealedBootstrapRef: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerDriver: ProviderDriverKind;
  readonly generation: number;
  readonly state: CloudThreadRuntimeState;
  readonly lastActivityAt: string;
  readonly idleSince?: string;
  readonly transitionId?: string;
  readonly transitionKind?: "pause" | "resume";
  readonly transitionStartedAt?: string;
  readonly routeFencedAt?: string;
  readonly credentialsRevokedAt?: string;
  readonly credentialsScrubbedAt?: string;
  readonly providerCompletedAt?: string;
  readonly sandboxDestroyedAt?: string;
  readonly failureCode?: string;
  readonly updatedAt: string;
}

export type CloudThreadActivityEvent =
  | {
      readonly type: "started";
      readonly workspaceId: WorkspaceId;
      readonly threadId: ThreadId;
      readonly attemptId: string;
      readonly eventId: string;
      readonly activityId: string;
      readonly source: CloudThreadRuntimeActivitySource;
      readonly generation: number;
      readonly leaseMs: number;
      readonly occurredAt: string;
      readonly expiresAt: string;
    }
  | {
      readonly type: "heartbeat";
      readonly workspaceId: WorkspaceId;
      readonly threadId: ThreadId;
      readonly attemptId: string;
      readonly eventId: string;
      readonly activityId: string;
      readonly generation: number;
      readonly leaseMs: number;
      readonly occurredAt: string;
      readonly expiresAt: string;
    }
  | {
      readonly type: "ended";
      readonly workspaceId: WorkspaceId;
      readonly threadId: ThreadId;
      readonly attemptId: string;
      readonly eventId: string;
      readonly activityId: string;
      readonly generation: number;
      readonly occurredAt: string;
    };

export interface CloudThreadActivityReceipt {
  readonly disposition: "applied" | "replayed";
  readonly runtime: CloudThreadRuntimeRecord;
  readonly event: CloudThreadActivityEvent;
}

export interface CloudThreadResumeRequest {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly attemptId: string;
  readonly requestId: string;
  readonly reason: CloudThreadResumeReason;
}

export interface CloudThreadResumeEvent extends CloudThreadResumeRequest {
  readonly requestedAt: string;
}

export type CloudThreadResumeClaim = {
  readonly disposition: "running" | "pending" | "claimed" | "joined";
  readonly runtime: CloudThreadRuntimeRecord;
  readonly request: CloudThreadResumeEvent;
};

export type CloudThreadContainmentStep =
  | "route_fence"
  | "credential_revoke"
  | "credential_scrub"
  | "provider_pause"
  | "provider_destroy";

export type CloudThreadContainmentOutcome =
  | "succeeded"
  | "retryable_failure"
  | "confirmed_failure"
  | "uncertain_failure";

export class CloudThreadRuntimeStoreError extends Error {
  readonly code: "conflict" | "notFound" | "staleGeneration" | "databaseFailure";

  constructor(code: CloudThreadRuntimeStoreError["code"], message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "CloudThreadRuntimeStoreError";
    this.code = code;
  }
}

interface RuntimeRow extends QueryResultRow {
  readonly workspace_id: string;
  readonly thread_id: string;
  readonly attempt_id: string;
  readonly environment_id: string;
  readonly environment_revision_id: string;
  readonly sandbox_id: string;
  readonly worker_id: string;
  readonly sealed_bootstrap_ref: string;
  readonly provider_instance_id: string;
  readonly provider_driver: ProviderDriverKind;
  readonly generation: string;
  readonly state: CloudThreadRuntimeState;
  readonly last_activity_at: string;
  readonly idle_since: string | null;
  readonly transition_id: string | null;
  readonly transition_kind: "pause" | "resume" | null;
  readonly transition_started_at: string | null;
  readonly route_fenced_at: string | null;
  readonly credentials_revoked_at: string | null;
  readonly credentials_scrubbed_at: string | null;
  readonly provider_completed_at: string | null;
  readonly sandbox_destroyed_at: string | null;
  readonly failure_code: string | null;
  readonly updated_at: string;
}

interface ActivityRow extends QueryResultRow {
  readonly thread_id: string;
  readonly attempt_id: string;
  readonly activity_id: string;
  readonly source: CloudThreadRuntimeActivitySource;
  readonly generation: string;
  readonly state: "active" | "ended";
  readonly started_at: string;
  readonly heartbeat_at: string;
  readonly expires_at: string;
  readonly ended_at: string | null;
}

interface ActivityEventRow extends QueryResultRow {
  readonly thread_id: string;
  readonly activity_id: string;
  readonly event_kind: CloudThreadActivityEvent["type"];
  readonly request_fingerprint: string;
  readonly occurred_at: string;
  readonly expires_at: string | null;
}

interface ResumeRequestRow extends QueryResultRow {
  readonly thread_id: string;
  readonly attempt_id: string;
  readonly reason: CloudThreadResumeReason;
  readonly request_fingerprint: string;
  readonly state: "pending" | "dispatched" | "completed";
  readonly transition_id: string | null;
  readonly requested_at: string;
}

const runtimeColumns = `runtime.workspace_id::text AS workspace_id, runtime.thread_id,
  runtime.attempt_id, runtime.environment_id, runtime.environment_revision_id,
  runtime.sandbox_id, runtime.worker_id, runtime.sealed_bootstrap_ref,
  attempt.provider_instance_id, attempt.provider_driver,
  runtime.generation::text, runtime.state,
  runtime.last_activity_at::text, runtime.idle_since::text,
  runtime.transition_id, runtime.transition_kind, runtime.transition_started_at::text,
  runtime.route_fenced_at::text, runtime.credentials_revoked_at::text,
  runtime.credentials_scrubbed_at::text, runtime.provider_completed_at::text,
  runtime.sandbox_destroyed_at::text, runtime.failure_code, runtime.updated_at::text`;

const toRuntime = (row: RuntimeRow): CloudThreadRuntimeRecord => ({
  workspaceId: row.workspace_id as WorkspaceId,
  threadId: row.thread_id as ThreadId,
  attemptId: row.attempt_id,
  environmentId: row.environment_id as EnvironmentId,
  environmentRevisionId: row.environment_revision_id as EnvironmentRevisionId,
  sandboxId: row.sandbox_id as SandboxId,
  workerId: row.worker_id as WorkerInstanceId,
  sealedBootstrapRef: row.sealed_bootstrap_ref,
  providerInstanceId: row.provider_instance_id as ProviderInstanceId,
  providerDriver: row.provider_driver,
  generation: Number(row.generation),
  state: row.state,
  lastActivityAt: row.last_activity_at,
  ...(row.idle_since === null ? {} : { idleSince: row.idle_since }),
  ...(row.transition_id === null ? {} : { transitionId: row.transition_id }),
  ...(row.transition_kind === null ? {} : { transitionKind: row.transition_kind }),
  ...(row.transition_started_at === null ? {} : { transitionStartedAt: row.transition_started_at }),
  ...(row.route_fenced_at === null ? {} : { routeFencedAt: row.route_fenced_at }),
  ...(row.credentials_revoked_at === null
    ? {}
    : { credentialsRevokedAt: row.credentials_revoked_at }),
  ...(row.credentials_scrubbed_at === null
    ? {}
    : { credentialsScrubbedAt: row.credentials_scrubbed_at }),
  ...(row.provider_completed_at === null ? {} : { providerCompletedAt: row.provider_completed_at }),
  ...(row.sandbox_destroyed_at === null ? {} : { sandboxDestroyedAt: row.sandbox_destroyed_at }),
  ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
  updatedAt: row.updated_at,
});

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

const fingerprint = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonicalJson(value)).digest("hex");

const transaction = async <A>(pool: Pool, use: (client: PoolClient) => Promise<A>) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await use(client);
    await client.query("COMMIT");
    return value;
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (cause instanceof CloudThreadRuntimeStoreError) throw cause;
    throw new CloudThreadRuntimeStoreError(
      "databaseFailure",
      "Cloud thread runtime transaction failed",
      cause,
    );
  } finally {
    client.release();
  }
};

const loadRuntime = async (
  client: Pick<PoolClient, "query">,
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  lock = false,
) => {
  const result = await client.query<RuntimeRow>(
    `SELECT ${runtimeColumns}
       FROM cloud_thread_runtime AS runtime
       JOIN cloud_thread_lifecycle_attempt AS attempt
         ON attempt.workspace_id = runtime.workspace_id AND attempt.attempt_id = runtime.attempt_id
      WHERE runtime.workspace_id = $1 AND runtime.thread_id = $2
        AND attempt.is_current AND attempt.state = 'ready'
      ${lock ? "FOR UPDATE OF runtime" : ""}`,
    [workspaceId, threadId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new CloudThreadRuntimeStoreError("notFound", "Cloud thread runtime was not found");
  }
  return toRuntime(row);
};

const exactAttempt = (runtime: CloudThreadRuntimeRecord, attemptId: string) => {
  if (runtime.attemptId !== attemptId) {
    throw new CloudThreadRuntimeStoreError("conflict", "Cloud thread lifecycle attempt changed");
  }
};

const exactGeneration = (runtime: CloudThreadRuntimeRecord, generation: number) => {
  if (runtime.generation !== generation) {
    throw new CloudThreadRuntimeStoreError(
      "staleGeneration",
      "Activity came from a stale cloud worker generation",
    );
  }
};

const eventFingerprint = (event: CloudThreadActivityEvent) =>
  fingerprint(
    event.type === "started"
      ? {
          type: event.type,
          workspaceId: event.workspaceId,
          threadId: event.threadId,
          attemptId: event.attemptId,
          eventId: event.eventId,
          activityId: event.activityId,
          source: event.source,
          generation: event.generation,
          leaseMs: event.leaseMs,
        }
      : event.type === "heartbeat"
        ? {
            type: event.type,
            workspaceId: event.workspaceId,
            threadId: event.threadId,
            attemptId: event.attemptId,
            eventId: event.eventId,
            activityId: event.activityId,
            generation: event.generation,
            leaseMs: event.leaseMs,
          }
        : {
            type: event.type,
            workspaceId: event.workspaceId,
            threadId: event.threadId,
            attemptId: event.attemptId,
            eventId: event.eventId,
            activityId: event.activityId,
            generation: event.generation,
          },
  );
const resumeFingerprint = (request: CloudThreadResumeRequest) =>
  fingerprint({
    workspaceId: request.workspaceId,
    threadId: request.threadId,
    attemptId: request.attemptId,
    requestId: request.requestId,
    reason: request.reason,
  });

export interface CloudThreadRuntimeStore {
  readonly getCurrent: (
    workspaceId: WorkspaceId,
    threadId: ThreadId,
  ) => Promise<CloudThreadRuntimeRecord | undefined>;
  readonly recordActivity: (event: CloudThreadActivityEvent) => Promise<CloudThreadActivityReceipt>;
  readonly claimIdlePauses: (
    now: string,
    idleForMs?: number,
    limit?: number,
  ) => Promise<ReadonlyArray<CloudThreadRuntimeRecord>>;
  readonly recordContainmentOutcome: (
    runtime: CloudThreadRuntimeRecord,
    step: CloudThreadContainmentStep,
    outcome: CloudThreadContainmentOutcome,
    errorCode: string | undefined,
    occurredAt: string,
  ) => Promise<CloudThreadRuntimeRecord>;
  readonly markPaused: (
    runtime: CloudThreadRuntimeRecord,
    occurredAt: string,
  ) => Promise<CloudThreadRuntimeRecord>;
  readonly requestResume: (request: CloudThreadResumeEvent) => Promise<CloudThreadResumeClaim>;
  readonly claimPendingResume: (
    runtime: CloudThreadRuntimeRecord,
    now: string,
  ) => Promise<CloudThreadRuntimeRecord | undefined>;
  readonly markProviderResumed: (
    runtime: CloudThreadRuntimeRecord,
    occurredAt: string,
  ) => Promise<CloudThreadRuntimeRecord>;
  readonly recordResumeBootstrap: (
    runtime: CloudThreadRuntimeRecord,
    workerId: WorkerInstanceId,
    sealedBootstrapRef: string,
    occurredAt: string,
  ) => Promise<CloudThreadRuntimeRecord>;
  readonly markRunning: (
    runtime: CloudThreadRuntimeRecord,
    occurredAt: string,
  ) => Promise<CloudThreadRuntimeRecord>;
  readonly markReconciliationRequired: (
    runtime: CloudThreadRuntimeRecord,
    failureCode: string,
    occurredAt: string,
  ) => Promise<CloudThreadRuntimeRecord>;
  readonly listRecoverable: (limit?: number) => Promise<ReadonlyArray<CloudThreadRuntimeRecord>>;
}

export const makePostgresCloudThreadRuntimeStore = (pool: Pool): CloudThreadRuntimeStore => ({
  getCurrent: async (workspaceId, threadId) => {
    try {
      return await transaction(pool, (client) => loadRuntime(client, workspaceId, threadId));
    } catch (cause) {
      if (cause instanceof CloudThreadRuntimeStoreError && cause.code === "notFound") {
        return undefined;
      }
      throw cause;
    }
  },

  recordActivity: (event) =>
    transaction(pool, async (client) => {
      if (
        event.type !== "ended" &&
        Date.parse(event.expiresAt) - Date.parse(event.occurredAt) !== event.leaseMs
      ) {
        throw new CloudThreadRuntimeStoreError(
          "conflict",
          "Activity expiry did not match its stable lease duration",
        );
      }
      const runtime = await loadRuntime(client, event.workspaceId, event.threadId, true);
      exactAttempt(runtime, event.attemptId);
      const digest = eventFingerprint(event);
      const existingEvent = await client.query<ActivityEventRow>(
        `SELECT thread_id, activity_id, event_kind, request_fingerprint,
                to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                  AS occurred_at,
                CASE WHEN expires_at IS NULL THEN NULL ELSE
                  to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                END AS expires_at
           FROM cloud_thread_runtime_activity_event
          WHERE workspace_id = $1 AND event_id = $2`,
        [event.workspaceId, event.eventId],
      );
      const prior = existingEvent.rows[0];
      if (prior !== undefined) {
        if (
          prior.thread_id !== event.threadId ||
          prior.activity_id !== event.activityId ||
          prior.event_kind !== event.type ||
          prior.request_fingerprint !== digest
        ) {
          throw new CloudThreadRuntimeStoreError(
            "conflict",
            "Activity event identity was reused with different content",
          );
        }
        if (event.type !== "ended" && prior.expires_at === null) {
          throw new CloudThreadRuntimeStoreError(
            "databaseFailure",
            "Persisted activity event is missing its original expiry",
          );
        }
        const replayedEvent: CloudThreadActivityEvent =
          event.type === "ended"
            ? { ...event, occurredAt: prior.occurred_at }
            : { ...event, occurredAt: prior.occurred_at, expiresAt: prior.expires_at! };
        return { disposition: "replayed", runtime, event: replayedEvent };
      }
      exactGeneration(runtime, event.generation);
      if (runtime.state !== "running") {
        throw new CloudThreadRuntimeStoreError(
          "conflict",
          "Activity cannot enter a fenced cloud runtime",
        );
      }

      const activityResult = await client.query<ActivityRow>(
        `SELECT thread_id, attempt_id, activity_id, source, generation::text, state,
                started_at::text, heartbeat_at::text, expires_at::text, ended_at::text
           FROM cloud_thread_runtime_activity
          WHERE workspace_id = $1 AND activity_id = $2
          FOR UPDATE`,
        [event.workspaceId, event.activityId],
      );
      const activity = activityResult.rows[0];
      let activityBoundaryAt = event.occurredAt;
      if (event.type === "started") {
        if (Date.parse(event.occurredAt) >= Date.parse(event.expiresAt)) {
          throw new CloudThreadRuntimeStoreError(
            "conflict",
            "Activity expiry must be in the future",
          );
        }
        if (activity === undefined) {
          await client.query(
            `INSERT INTO cloud_thread_runtime_activity
              (workspace_id, thread_id, attempt_id, activity_id, source, generation, state,
               started_at, heartbeat_at, expires_at)
             VALUES ($1,$2,$3,$4,$5,$6,'active',$7::timestamptz,$7::timestamptz,$8::timestamptz)`,
            [
              event.workspaceId,
              event.threadId,
              event.attemptId,
              event.activityId,
              event.source,
              event.generation,
              event.occurredAt,
              event.expiresAt,
            ],
          );
        } else {
          throw new CloudThreadRuntimeStoreError(
            "conflict",
            "Activity identity was started more than once",
          );
        }
      } else {
        if (
          activity === undefined ||
          activity.thread_id !== event.threadId ||
          activity.attempt_id !== event.attemptId ||
          Number(activity.generation) !== event.generation
        ) {
          throw new CloudThreadRuntimeStoreError(
            "conflict",
            "Activity update did not match its claim",
          );
        }
        if (event.type === "heartbeat") {
          if (
            activity.state !== "active" ||
            Date.parse(event.occurredAt) < Date.parse(activity.heartbeat_at) ||
            Date.parse(event.occurredAt) >= Date.parse(activity.expires_at) ||
            Date.parse(event.occurredAt) >= Date.parse(event.expiresAt)
          ) {
            throw new CloudThreadRuntimeStoreError("conflict", "Activity heartbeat was stale");
          }
          await client.query(
            `UPDATE cloud_thread_runtime_activity
                SET heartbeat_at = $3::timestamptz, expires_at = $4::timestamptz
              WHERE workspace_id = $1 AND activity_id = $2 AND state = 'active'`,
            [event.workspaceId, event.activityId, event.occurredAt, event.expiresAt],
          );
        } else {
          if (Date.parse(event.occurredAt) < Date.parse(activity.heartbeat_at)) {
            throw new CloudThreadRuntimeStoreError(
              "conflict",
              "Activity end preceded its latest heartbeat",
            );
          }
          if (activity.state === "active") {
            activityBoundaryAt =
              Date.parse(event.occurredAt) < Date.parse(activity.expires_at)
                ? event.occurredAt
                : activity.expires_at;
            await client.query(
              `UPDATE cloud_thread_runtime_activity
                  SET state = 'ended', ended_at = $3::timestamptz
                WHERE workspace_id = $1 AND activity_id = $2 AND state = 'active'`,
              [event.workspaceId, event.activityId, activityBoundaryAt],
            );
          } else {
            throw new CloudThreadRuntimeStoreError("conflict", "Activity ended more than once");
          }
        }
      }

      await client.query(
        `INSERT INTO cloud_thread_runtime_activity_event
          (workspace_id, event_id, thread_id, activity_id, event_kind,
           request_fingerprint, occurred_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz)`,
        [
          event.workspaceId,
          event.eventId,
          event.threadId,
          event.activityId,
          event.type,
          digest,
          event.occurredAt,
          event.type === "ended" ? null : event.expiresAt,
        ],
      );

      const active = await client.query(
        `SELECT 1 FROM cloud_thread_runtime_activity
          WHERE workspace_id = $1 AND thread_id = $2 AND attempt_id = $4
            AND state = 'active'
            AND expires_at > $3::timestamptz
          LIMIT 1`,
        [event.workspaceId, event.threadId, event.occurredAt, event.attemptId],
      );
      const desktop = await client.query(
        `SELECT 1 FROM cloud_desktop_lease
          WHERE workspace_id = $1 AND thread_id = $2 AND attempt_id = $4
            AND state = 'active'
            AND expires_at > $3::timestamptz
          LIMIT 1`,
        [event.workspaceId, event.threadId, event.occurredAt, event.attemptId],
      );
      const remainsActive = (active.rowCount ?? 0) > 0 || (desktop.rowCount ?? 0) > 0;
      await client.query(
        `UPDATE cloud_thread_runtime
            SET last_activity_at = GREATEST(last_activity_at, $3::timestamptz),
                idle_since = ${remainsActive ? "NULL" : "GREATEST(last_activity_at, $3::timestamptz)"},
                updated_at = GREATEST(updated_at, $4::timestamptz)
          WHERE workspace_id = $1 AND thread_id = $2`,
        [event.workspaceId, event.threadId, activityBoundaryAt, event.occurredAt],
      );
      return {
        disposition: "applied",
        runtime: await loadRuntime(client, event.workspaceId, event.threadId),
        event,
      };
    }),

  claimIdlePauses: (now, idleForMs = CLOUD_THREAD_IDLE_MS, limit = 25) =>
    transaction(pool, async (client) => {
      const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
      const boundedIdleMs = Math.max(1, Math.trunc(idleForMs));
      const cutoff = DateTime.formatIso(
        DateTime.subtract(DateTime.makeUnsafe(now), { milliseconds: boundedIdleMs }),
      );
      const candidates = await client.query<
        { readonly workspace_id: string; readonly thread_id: string } & QueryResultRow
      >(
        `WITH candidates AS (
           SELECT runtime.workspace_id, runtime.thread_id,
             GREATEST(
               runtime.last_activity_at,
               COALESCE((
                 SELECT MAX(CASE
                   WHEN activity.state = 'ended' THEN activity.ended_at
                   WHEN activity.expires_at <= $1::timestamptz THEN activity.expires_at
                   ELSE NULL END)
                 FROM cloud_thread_runtime_activity AS activity
                 WHERE activity.workspace_id = runtime.workspace_id
                   AND activity.thread_id = runtime.thread_id
                   AND activity.attempt_id = runtime.attempt_id
               ), runtime.last_activity_at),
               COALESCE((
                 SELECT MAX(CASE
                   WHEN lease.state = 'active' AND lease.expires_at <= $1::timestamptz
                     THEN lease.expires_at
                   WHEN lease.state <> 'active' THEN lease.ended_at
                   ELSE NULL END)
                 FROM cloud_desktop_lease AS lease
                 WHERE lease.workspace_id = runtime.workspace_id
                   AND lease.thread_id = runtime.thread_id
                   AND lease.attempt_id = runtime.attempt_id
               ), runtime.last_activity_at)
             ) AS effective_idle_since
           FROM cloud_thread_runtime AS runtime
           JOIN cloud_thread_lifecycle_attempt AS attempt
             ON attempt.workspace_id = runtime.workspace_id
            AND attempt.attempt_id = runtime.attempt_id
           WHERE runtime.state = 'running' AND attempt.is_current AND attempt.state = 'ready'
             AND NOT EXISTS (
               SELECT 1 FROM cloud_thread_runtime_activity AS active
               WHERE active.workspace_id = runtime.workspace_id
                 AND active.thread_id = runtime.thread_id
                 AND active.attempt_id = runtime.attempt_id
                 AND active.state = 'active' AND active.expires_at > $1::timestamptz
             )
             AND NOT EXISTS (
               SELECT 1 FROM cloud_desktop_lease AS lease
               WHERE lease.workspace_id = runtime.workspace_id
                 AND lease.thread_id = runtime.thread_id
                 AND lease.attempt_id = runtime.attempt_id
                 AND lease.state = 'active' AND lease.expires_at > $1::timestamptz
             )
         )
         SELECT workspace_id::text AS workspace_id, thread_id
           FROM candidates
          WHERE effective_idle_since <= $2::timestamptz
          ORDER BY effective_idle_since, workspace_id, thread_id
          LIMIT $3`,
        [now, cutoff, boundedLimit],
      );
      const claimed: CloudThreadRuntimeRecord[] = [];
      for (const candidate of candidates.rows) {
        const binding = {
          workspaceId: candidate.workspace_id as WorkspaceId,
          threadId: candidate.thread_id as ThreadId,
        };
        // Desktop lease mutations take this lock before inspecting runtime state. The pause
        // decision takes it in the same order, then rechecks all durable activity below.
        await lockCloudThreadMutation(client, binding);
        const locked = await client.query<
          { readonly attempt_id: string; readonly generation: string } & QueryResultRow
        >(
          `SELECT runtime.attempt_id, runtime.generation::text
             FROM cloud_thread_runtime AS runtime
             JOIN cloud_thread_lifecycle_attempt AS attempt
               ON attempt.workspace_id = runtime.workspace_id
              AND attempt.attempt_id = runtime.attempt_id
            WHERE runtime.workspace_id = $1 AND runtime.thread_id = $2
              AND runtime.state = 'running' AND attempt.is_current AND attempt.state = 'ready'
            FOR UPDATE OF runtime`,
          [binding.workspaceId, binding.threadId],
        );
        const current = locked.rows[0];
        if (current === undefined) continue;

        const eligible = await client.query<{ readonly eligible: boolean } & QueryResultRow>(
          `SELECT
             NOT EXISTS (
               SELECT 1 FROM cloud_thread_runtime_activity AS active
                WHERE active.workspace_id = runtime.workspace_id
                  AND active.thread_id = runtime.thread_id
                  AND active.attempt_id = runtime.attempt_id
                  AND active.state = 'active' AND active.expires_at > $3::timestamptz
             )
             AND NOT EXISTS (
               SELECT 1 FROM cloud_desktop_lease AS lease
                WHERE lease.workspace_id = runtime.workspace_id
                  AND lease.thread_id = runtime.thread_id
                  AND lease.attempt_id = runtime.attempt_id
                  AND lease.state = 'active' AND lease.expires_at > $3::timestamptz
             )
             AND GREATEST(
               runtime.last_activity_at,
               COALESCE((
                 SELECT MAX(CASE
                   WHEN activity.state = 'ended' THEN activity.ended_at
                   WHEN activity.expires_at <= $3::timestamptz THEN activity.expires_at
                   ELSE NULL END)
                   FROM cloud_thread_runtime_activity AS activity
                  WHERE activity.workspace_id = runtime.workspace_id
                    AND activity.thread_id = runtime.thread_id
                    AND activity.attempt_id = runtime.attempt_id
               ), runtime.last_activity_at),
               COALESCE((
                 SELECT MAX(CASE
                   WHEN lease.state = 'active' AND lease.expires_at <= $3::timestamptz
                     THEN lease.expires_at
                   WHEN lease.state <> 'active' THEN lease.ended_at
                   ELSE NULL END)
                   FROM cloud_desktop_lease AS lease
                  WHERE lease.workspace_id = runtime.workspace_id
                    AND lease.thread_id = runtime.thread_id
                    AND lease.attempt_id = runtime.attempt_id
               ), runtime.last_activity_at)
             ) <= $4::timestamptz AS eligible
             FROM cloud_thread_runtime AS runtime
            WHERE runtime.workspace_id = $1 AND runtime.thread_id = $2
              AND runtime.attempt_id = $5 AND runtime.generation = $6
              AND runtime.state = 'running'`,
          [
            binding.workspaceId,
            binding.threadId,
            now,
            cutoff,
            current.attempt_id,
            current.generation,
          ],
        );
        if (eligible.rows[0]?.eligible !== true) continue;

        const updated = await client.query(
          `UPDATE cloud_thread_runtime
              SET state = 'pause_dispatched', idle_since = NULL,
                  transition_id = 'pause:' || workspace_id::text || ':' ||
                    encode(convert_to(thread_id, 'UTF8'), 'hex') || ':' ||
                    encode(convert_to(attempt_id, 'UTF8'), 'hex') || ':' ||
                    encode(convert_to(sandbox_id, 'UTF8'), 'hex') || ':' || generation::text,
                  transition_kind = 'pause', transition_started_at = $5::timestamptz,
                  route_fenced_at = NULL, credentials_revoked_at = NULL,
                  credentials_scrubbed_at = NULL, provider_completed_at = NULL,
                  sandbox_destroyed_at = NULL, failure_code = NULL,
                  updated_at = $5::timestamptz
            WHERE workspace_id = $1 AND thread_id = $2 AND attempt_id = $3
              AND generation = $4 AND state = 'running'
            RETURNING thread_id`,
          [binding.workspaceId, binding.threadId, current.attempt_id, current.generation, now],
        );
        if (updated.rowCount === 1) {
          claimed.push(await loadRuntime(client, binding.workspaceId, binding.threadId));
        }
      }
      return claimed;
    }),

  recordContainmentOutcome: (runtime, step, outcome, errorCode, occurredAt) =>
    transaction(pool, async (client) => {
      if ((outcome === "succeeded") !== (errorCode === undefined)) {
        throw new CloudThreadRuntimeStoreError(
          "conflict",
          "Containment outcome and error code did not agree",
        );
      }
      const current = await loadRuntime(client, runtime.workspaceId, runtime.threadId, true);
      exactAttempt(current, runtime.attemptId);
      exactGeneration(current, runtime.generation);
      if (
        current.transitionId !== runtime.transitionId ||
        current.transitionKind !== "pause" ||
        (current.state !== "pause_dispatched" && current.state !== "reconciliation_required")
      ) {
        throw new CloudThreadRuntimeStoreError("conflict", "Containment outcome arrived stale");
      }
      await client.query(
        `INSERT INTO cloud_thread_runtime_containment_attempt
          (workspace_id, thread_id, transition_id, step, attempt_no, outcome, error_code,
           occurred_at)
         SELECT $1,$2,$3,$4,COALESCE(MAX(attempt_no), 0) + 1,$5,$6,$7::timestamptz
           FROM cloud_thread_runtime_containment_attempt
          WHERE workspace_id = $1 AND thread_id = $2 AND transition_id = $3 AND step = $4`,
        [
          runtime.workspaceId,
          runtime.threadId,
          runtime.transitionId,
          step,
          outcome,
          errorCode ?? null,
          occurredAt,
        ],
      );
      const column =
        step === "route_fence"
          ? "route_fenced_at"
          : step === "credential_revoke"
            ? "credentials_revoked_at"
            : step === "credential_scrub"
              ? "credentials_scrubbed_at"
              : step === "provider_pause"
                ? "provider_completed_at"
                : "sandbox_destroyed_at";
      const updated = await client.query(
        `UPDATE cloud_thread_runtime
            SET ${column} = CASE WHEN $5 = 'succeeded'
                  THEN COALESCE(${column}, $7::timestamptz) ELSE ${column} END,
                failure_code = CASE WHEN $5 = 'succeeded' THEN failure_code ELSE $6 END,
                updated_at = GREATEST(updated_at, $7::timestamptz)
          WHERE workspace_id = $1 AND thread_id = $2 AND attempt_id = $3
            AND generation = $4
            AND state IN ('pause_dispatched', 'reconciliation_required')
            AND transition_id = $8
          RETURNING thread_id`,
        [
          runtime.workspaceId,
          runtime.threadId,
          runtime.attemptId,
          runtime.generation,
          outcome,
          errorCode ?? null,
          occurredAt,
          runtime.transitionId,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new CloudThreadRuntimeStoreError("conflict", "Containment receipt arrived stale");
      }
      return loadRuntime(client, runtime.workspaceId, runtime.threadId);
    }),

  markPaused: (runtime, occurredAt) =>
    transaction(pool, async (client) => {
      const updated = await client.query(
        `UPDATE cloud_thread_runtime
            SET state = 'paused', failure_code = NULL, updated_at = $5::timestamptz
          WHERE workspace_id = $1 AND thread_id = $2 AND attempt_id = $3
            AND generation = $4 AND state IN ('pause_dispatched', 'reconciliation_required')
            AND transition_id = $6 AND route_fenced_at IS NOT NULL
            AND credentials_revoked_at IS NOT NULL AND credentials_scrubbed_at IS NOT NULL
            AND provider_completed_at IS NOT NULL AND sandbox_destroyed_at IS NULL
          RETURNING thread_id`,
        [
          runtime.workspaceId,
          runtime.threadId,
          runtime.attemptId,
          runtime.generation,
          occurredAt,
          runtime.transitionId,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new CloudThreadRuntimeStoreError("conflict", "Pause completion arrived stale");
      }
      return loadRuntime(client, runtime.workspaceId, runtime.threadId);
    }),

  requestResume: (request) =>
    transaction(pool, async (client) => {
      let runtime = await loadRuntime(client, request.workspaceId, request.threadId, true);
      exactAttempt(runtime, request.attemptId);
      const digest = resumeFingerprint(request);
      const existing = await client.query<ResumeRequestRow>(
        `SELECT thread_id, attempt_id, reason, request_fingerprint, state,
                transition_id,
                to_char(requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                  AS requested_at
           FROM cloud_thread_runtime_resume_request
          WHERE workspace_id = $1 AND request_id = $2`,
        [request.workspaceId, request.requestId],
      );
      const prior = existing.rows[0];
      if (prior !== undefined) {
        if (
          prior.thread_id !== request.threadId ||
          prior.attempt_id !== request.attemptId ||
          prior.reason !== request.reason ||
          prior.request_fingerprint !== digest
        ) {
          throw new CloudThreadRuntimeStoreError(
            "conflict",
            "Resume request identity was reused with different content",
          );
        }
        const disposition =
          prior.state === "pending"
            ? "pending"
            : runtime.state === "running"
              ? "running"
              : "joined";
        return {
          disposition,
          runtime,
          request: { ...request, requestedAt: prior.requested_at },
        } as CloudThreadResumeClaim;
      }
      if (runtime.state === "reconciliation_required") {
        throw new CloudThreadRuntimeStoreError(
          "conflict",
          "Cloud runtime requires reconciliation before resume",
        );
      }

      if (runtime.state === "running") {
        await client.query(
          `INSERT INTO cloud_thread_runtime_resume_request
            (workspace_id, request_id, thread_id, attempt_id, reason, request_fingerprint,
             state, transition_id, requested_at, completed_at)
           VALUES ($1,$2,$3,$4,$5,$6,'completed','running',$7::timestamptz,$7::timestamptz)`,
          [
            request.workspaceId,
            request.requestId,
            request.threadId,
            request.attemptId,
            request.reason,
            digest,
            request.requestedAt,
          ],
        );
        await client.query(
          `UPDATE cloud_thread_runtime
              SET last_activity_at = GREATEST(last_activity_at, $3::timestamptz),
                  idle_since = GREATEST(last_activity_at, $3::timestamptz),
                  updated_at = GREATEST(updated_at, $3::timestamptz)
            WHERE workspace_id = $1 AND thread_id = $2`,
          [request.workspaceId, request.threadId, request.requestedAt],
        );
        runtime = await loadRuntime(client, request.workspaceId, request.threadId);
        return { disposition: "running", runtime, request };
      }

      if (runtime.state === "pause_dispatched") {
        await client.query(
          `INSERT INTO cloud_thread_runtime_resume_request
            (workspace_id, request_id, thread_id, attempt_id, reason, request_fingerprint,
             state, requested_at)
           VALUES ($1,$2,$3,$4,$5,$6,'pending',$7::timestamptz)`,
          [
            request.workspaceId,
            request.requestId,
            request.threadId,
            request.attemptId,
            request.reason,
            digest,
            request.requestedAt,
          ],
        );
        return { disposition: "pending", runtime, request };
      }

      if (runtime.state === "paused") {
        const generation = runtime.generation + 1;
        const transitionId = `resume:${runtime.attemptId}:${generation}`;
        await client.query(
          `UPDATE cloud_thread_runtime
              SET state = 'resume_dispatched', generation = $3,
                  transition_id = $4, transition_kind = 'resume',
                  transition_started_at = $5::timestamptz, route_fenced_at = NULL,
                  credentials_revoked_at = NULL, credentials_scrubbed_at = NULL,
                  provider_completed_at = NULL, sandbox_destroyed_at = NULL,
                  failure_code = NULL, updated_at = $5::timestamptz
            WHERE workspace_id = $1 AND thread_id = $2 AND state = 'paused'`,
          [request.workspaceId, request.threadId, generation, transitionId, request.requestedAt],
        );
        await client.query(
          `INSERT INTO cloud_thread_runtime_resume_request
            (workspace_id, request_id, thread_id, attempt_id, reason, request_fingerprint,
             state, transition_id, requested_at)
           VALUES ($1,$2,$3,$4,$5,$6,'dispatched',$7,$8::timestamptz)`,
          [
            request.workspaceId,
            request.requestId,
            request.threadId,
            request.attemptId,
            request.reason,
            digest,
            transitionId,
            request.requestedAt,
          ],
        );
        runtime = await loadRuntime(client, request.workspaceId, request.threadId);
        return { disposition: "claimed", runtime, request };
      }

      await client.query(
        `INSERT INTO cloud_thread_runtime_resume_request
          (workspace_id, request_id, thread_id, attempt_id, reason, request_fingerprint,
           state, transition_id, requested_at)
         VALUES ($1,$2,$3,$4,$5,$6,'dispatched',$7,$8::timestamptz)`,
        [
          request.workspaceId,
          request.requestId,
          request.threadId,
          request.attemptId,
          request.reason,
          digest,
          runtime.transitionId,
          request.requestedAt,
        ],
      );
      return { disposition: "joined", runtime, request };
    }),

  claimPendingResume: (runtime, now) =>
    transaction(pool, async (client) => {
      const current = await loadRuntime(client, runtime.workspaceId, runtime.threadId, true);
      exactAttempt(current, runtime.attemptId);
      if (current.state !== "paused") return undefined;
      const pending = await client.query<{ readonly request_id: string } & QueryResultRow>(
        `SELECT request_id FROM cloud_thread_runtime_resume_request
          WHERE workspace_id = $1 AND thread_id = $2 AND state = 'pending'
          ORDER BY requested_at, request_id LIMIT 1 FOR UPDATE`,
        [runtime.workspaceId, runtime.threadId],
      );
      if (pending.rows[0] === undefined) return undefined;
      const generation = current.generation + 1;
      const transitionId = `resume:${current.attemptId}:${generation}`;
      await client.query(
        `UPDATE cloud_thread_runtime
            SET state = 'resume_dispatched', generation = $3,
                transition_id = $4, transition_kind = 'resume',
                transition_started_at = $5::timestamptz, route_fenced_at = NULL,
                credentials_revoked_at = NULL, credentials_scrubbed_at = NULL,
                provider_completed_at = NULL, sandbox_destroyed_at = NULL,
                failure_code = NULL, updated_at = $5::timestamptz
          WHERE workspace_id = $1 AND thread_id = $2 AND state = 'paused'`,
        [runtime.workspaceId, runtime.threadId, generation, transitionId, now],
      );
      await client.query(
        `UPDATE cloud_thread_runtime_resume_request
            SET state = 'dispatched', transition_id = $3
          WHERE workspace_id = $1 AND thread_id = $2 AND state = 'pending'`,
        [runtime.workspaceId, runtime.threadId, transitionId],
      );
      return loadRuntime(client, runtime.workspaceId, runtime.threadId);
    }),

  markProviderResumed: (runtime, occurredAt) =>
    transaction(pool, async (client) => {
      const updated = await client.query(
        `UPDATE cloud_thread_runtime
            SET state = 'resume_bootstrap_dispatched',
                provider_completed_at = $5::timestamptz, updated_at = $5::timestamptz
          WHERE workspace_id = $1 AND thread_id = $2 AND attempt_id = $3
            AND generation = $4 AND state = 'resume_dispatched' AND transition_id = $6
          RETURNING thread_id`,
        [
          runtime.workspaceId,
          runtime.threadId,
          runtime.attemptId,
          runtime.generation,
          occurredAt,
          runtime.transitionId,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new CloudThreadRuntimeStoreError("conflict", "Resume receipt arrived stale");
      }
      return loadRuntime(client, runtime.workspaceId, runtime.threadId);
    }),

  recordResumeBootstrap: (runtime, workerId, sealedBootstrapRef, occurredAt) =>
    transaction(pool, async (client) => {
      if (workerId === runtime.workerId || sealedBootstrapRef.trim().length === 0) {
        throw new CloudThreadRuntimeStoreError(
          "conflict",
          "Resume must create a fresh worker bootstrap",
        );
      }
      const attempt = await client.query(
        `UPDATE cloud_thread_lifecycle_attempt
            SET worker_id = $4, sealed_bootstrap_ref = $5, updated_at = $6::timestamptz
          WHERE workspace_id = $1 AND thread_id = $2 AND attempt_id = $3
            AND is_current AND state = 'ready' AND sandbox_id = $7
          RETURNING attempt_id`,
        [
          runtime.workspaceId,
          runtime.threadId,
          runtime.attemptId,
          workerId,
          sealedBootstrapRef,
          occurredAt,
          runtime.sandboxId,
        ],
      );
      if (attempt.rowCount !== 1) {
        throw new CloudThreadRuntimeStoreError("conflict", "Resume worker binding arrived stale");
      }
      const updated = await client.query(
        `UPDATE cloud_thread_runtime
            SET state = 'resume_worker_start_dispatched', worker_id = $5,
                sealed_bootstrap_ref = $6, updated_at = $7::timestamptz
          WHERE workspace_id = $1 AND thread_id = $2 AND attempt_id = $3
            AND generation = $4 AND state = 'resume_bootstrap_dispatched'
            AND transition_id = $8
          RETURNING thread_id`,
        [
          runtime.workspaceId,
          runtime.threadId,
          runtime.attemptId,
          runtime.generation,
          workerId,
          sealedBootstrapRef,
          occurredAt,
          runtime.transitionId,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new CloudThreadRuntimeStoreError("conflict", "Resume bootstrap arrived stale");
      }
      return loadRuntime(client, runtime.workspaceId, runtime.threadId);
    }),

  markRunning: (runtime, occurredAt) =>
    transaction(pool, async (client) => {
      const updated = await client.query(
        `UPDATE cloud_thread_runtime
            SET state = 'running', last_activity_at = $5::timestamptz,
                idle_since = $5::timestamptz, transition_id = NULL,
                transition_kind = NULL, transition_started_at = NULL,
                route_fenced_at = NULL, credentials_revoked_at = NULL,
                credentials_scrubbed_at = NULL, provider_completed_at = NULL,
                sandbox_destroyed_at = NULL, failure_code = NULL,
                updated_at = $5::timestamptz
          WHERE workspace_id = $1 AND thread_id = $2 AND attempt_id = $3
            AND generation = $4 AND state = 'resume_worker_start_dispatched'
            AND transition_id = $6
          RETURNING thread_id`,
        [
          runtime.workspaceId,
          runtime.threadId,
          runtime.attemptId,
          runtime.generation,
          occurredAt,
          runtime.transitionId,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new CloudThreadRuntimeStoreError("conflict", "Running receipt arrived stale");
      }
      await client.query(
        `UPDATE cloud_thread_runtime_resume_request
            SET state = 'completed', completed_at = $3::timestamptz
          WHERE workspace_id = $1 AND thread_id = $2
            AND state = 'dispatched' AND transition_id = $4`,
        [runtime.workspaceId, runtime.threadId, occurredAt, runtime.transitionId],
      );
      return loadRuntime(client, runtime.workspaceId, runtime.threadId);
    }),

  markReconciliationRequired: (runtime, failureCode, occurredAt) =>
    transaction(pool, async (client) => {
      const updated = await client.query(
        `UPDATE cloud_thread_runtime
            SET state = 'reconciliation_required', idle_since = NULL,
                failure_code = $5, updated_at = $6::timestamptz
          WHERE workspace_id = $1 AND thread_id = $2 AND attempt_id = $3
            AND generation = $4 AND state <> 'running'
          RETURNING thread_id`,
        [
          runtime.workspaceId,
          runtime.threadId,
          runtime.attemptId,
          runtime.generation,
          failureCode,
          occurredAt,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new CloudThreadRuntimeStoreError("conflict", "Reconciliation receipt arrived stale");
      }
      return loadRuntime(client, runtime.workspaceId, runtime.threadId);
    }),

  listRecoverable: async (limit = 25) => {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const result = await pool.query<RuntimeRow>(
      `SELECT ${runtimeColumns}
         FROM cloud_thread_runtime AS runtime
         JOIN cloud_thread_lifecycle_attempt AS attempt
           ON attempt.workspace_id = runtime.workspace_id AND attempt.attempt_id = runtime.attempt_id
        WHERE attempt.is_current AND attempt.state = 'ready'
          AND (
            runtime.state IN (
              'pause_dispatched', 'resume_dispatched',
              'resume_bootstrap_dispatched', 'resume_worker_start_dispatched'
            ) OR (
              runtime.state = 'reconciliation_required'
              AND runtime.transition_kind = 'pause'
              AND (
                runtime.route_fenced_at IS NULL OR runtime.credentials_revoked_at IS NULL OR
                (
                  runtime.sandbox_destroyed_at IS NULL AND
                  (runtime.provider_completed_at IS NULL OR runtime.credentials_scrubbed_at IS NULL)
                )
              )
            )
          )
        ORDER BY runtime.updated_at, runtime.workspace_id, runtime.thread_id
        LIMIT $1`,
      [boundedLimit],
    );
    return result.rows.map(toRuntime);
  },
});
