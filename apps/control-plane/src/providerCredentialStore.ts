import type { Pool, PoolClient, QueryResultRow } from "pg";
import type {
  AuthSessionId,
  EnvironmentId,
  ProviderInstanceRef,
  ThreadId,
} from "@t3tools/contracts";
import type {
  AgentMaterializationId,
  AgentProfileId,
  AgentProfileState,
  SandboxId,
  WorkspaceId,
} from "@t3tools/contracts/cloud";
import type { WorkerInstanceId } from "@t3tools/contracts/worker";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProviderCredentialEnvelope } from "./providerCredentialEnvelope.ts";

export interface ProviderCredentialProfileRecord {
  readonly workspaceId: WorkspaceId;
  readonly profileId: AgentProfileId;
  readonly provider: ProviderInstanceRef;
  readonly label: string;
  readonly state: AgentProfileState;
  /** Monotonic fence incremented in the same transaction as revocation. */
  readonly generation: number;
  readonly envelope: ProviderCredentialEnvelope;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
}

export type ProviderCredentialMaterializationState =
  | "reserved"
  | "dispatched"
  | "active"
  | "cleanup_required"
  | "cleaned";

export interface ProviderCredentialMaterializationRecord {
  readonly workspaceId: WorkspaceId;
  readonly materializationId: AgentMaterializationId;
  readonly profileId: AgentProfileId;
  readonly profileGeneration: number;
  readonly providerInstanceId: ProviderInstanceRef["instanceId"];
  readonly providerDriver: ProviderInstanceRef["driver"];
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly sandboxId: SandboxId;
  readonly workerId: WorkerInstanceId;
  readonly targetPath: string;
  readonly targetPathSha256: string;
  readonly authorizationSessionId: AuthSessionId;
  readonly authorizationExpiresAt: string;
  readonly state: ProviderCredentialMaterializationState;
  readonly createdAt: string;
  readonly dispatchedAt?: string;
  readonly materializedAt?: string;
  readonly cleanedAt?: string;
  readonly cleanupReason?: string;
  readonly cleanupAttempts: number;
  readonly cleanupLastError?: string;
  readonly cleanupNextAttemptAt?: string;
}

export class ProviderCredentialStoreError extends Schema.TaggedErrorClass<ProviderCredentialStoreError>()(
  "ProviderCredentialStoreError",
  {
    code: Schema.Literals(["notFound", "idempotencyConflict", "stateConflict", "storeFailed"]),
    operation: Schema.String,
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {}

export interface ProviderCredentialStore {
  readonly findProfileByIdempotency: (
    workspaceId: WorkspaceId,
    providerInstanceId: ProviderInstanceRef["instanceId"],
    idempotencyKey: string,
  ) => Effect.Effect<ProviderCredentialProfileRecord | undefined, ProviderCredentialStoreError>;
  readonly sealProfile: (
    record: ProviderCredentialProfileRecord,
  ) => Effect.Effect<ProviderCredentialProfileRecord, ProviderCredentialStoreError>;
  readonly getProfile: (
    workspaceId: WorkspaceId,
    profileId: AgentProfileId,
  ) => Effect.Effect<ProviderCredentialProfileRecord | undefined, ProviderCredentialStoreError>;
  readonly revokeProfile: (
    workspaceId: WorkspaceId,
    profileId: AgentProfileId,
    revokedAt: string,
  ) => Effect.Effect<ProviderCredentialProfileRecord, ProviderCredentialStoreError>;
  readonly reserveMaterialization: (
    record: Omit<
      ProviderCredentialMaterializationRecord,
      | "profileGeneration"
      | "state"
      | "dispatchedAt"
      | "materializedAt"
      | "cleanedAt"
      | "cleanupReason"
      | "cleanupAttempts"
      | "cleanupLastError"
      | "cleanupNextAttemptAt"
    >,
  ) => Effect.Effect<ProviderCredentialMaterializationRecord, ProviderCredentialStoreError>;
  readonly markDispatched: (
    workspaceId: WorkspaceId,
    materializationId: AgentMaterializationId,
    profileGeneration: number,
    dispatchedAt: string,
  ) => Effect.Effect<ProviderCredentialMaterializationRecord, ProviderCredentialStoreError>;
  readonly confirmMaterialized: (
    workspaceId: WorkspaceId,
    materializationId: AgentMaterializationId,
    profileGeneration: number,
    materializedAt: string,
  ) => Effect.Effect<boolean, ProviderCredentialStoreError>;
  readonly requireCleanup: (
    workspaceId: WorkspaceId,
    materializationId: AgentMaterializationId,
    reason: string,
    error: string | undefined,
    nextAttemptAt: string,
  ) => Effect.Effect<void, ProviderCredentialStoreError>;
  readonly confirmAbsent: (
    workspaceId: WorkspaceId,
    materializationId: AgentMaterializationId,
    profileGeneration: number,
    cleanedAt: string,
    reason: string,
  ) => Effect.Effect<boolean, ProviderCredentialStoreError>;
  readonly fenceUnconfirmed: (
    workspaceId: WorkspaceId,
    sandboxId: SandboxId,
    reason: string,
    nextAttemptAt: string,
  ) => Effect.Effect<
    ReadonlyArray<ProviderCredentialMaterializationRecord>,
    ProviderCredentialStoreError
  >;
  readonly fenceLifecycleMaterializations: (
    workspaceId: WorkspaceId,
    threadId: ThreadId,
    sandboxId: SandboxId | undefined,
    reason: string,
    nextAttemptAt: string,
  ) => Effect.Effect<
    ReadonlyArray<ProviderCredentialMaterializationRecord>,
    ProviderCredentialStoreError
  >;
  readonly expireMaterializations: (
    workspaceId: WorkspaceId,
    now: string,
    sandboxId?: SandboxId,
  ) => Effect.Effect<
    ReadonlyArray<ProviderCredentialMaterializationRecord>,
    ProviderCredentialStoreError
  >;
  readonly claimDueCleanup: (
    now: string,
    retryAt: string,
    limit: number,
  ) => Effect.Effect<
    ReadonlyArray<ProviderCredentialMaterializationRecord>,
    ProviderCredentialStoreError
  >;
  readonly listLiveMaterializations: (
    workspaceId: WorkspaceId,
    selector: { readonly profileId?: AgentProfileId; readonly sandboxId?: SandboxId },
  ) => Effect.Effect<
    ReadonlyArray<ProviderCredentialMaterializationRecord>,
    ProviderCredentialStoreError
  >;
}

interface ProfileRow extends QueryResultRow {
  readonly workspace_id: string;
  readonly profile_id: string;
  readonly provider_instance_id: string;
  readonly provider_driver: string;
  readonly label: string;
  readonly state: AgentProfileState;
  readonly generation: string;
  readonly key_version: string;
  readonly wrapped_dek: Buffer;
  readonly nonce: Buffer;
  readonly auth_tag: Buffer;
  readonly ciphertext: Buffer;
  readonly idempotency_key: string;
  readonly request_fingerprint: string;
  readonly expires_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly revoked_at: string | null;
}

interface MaterializationRow extends QueryResultRow {
  readonly workspace_id: string;
  readonly materialization_id: string;
  readonly profile_id: string;
  readonly profile_generation: string;
  readonly provider_instance_id: string;
  readonly provider_driver: ProviderInstanceRef["driver"];
  readonly thread_id: string;
  readonly environment_id: string;
  readonly sandbox_id: string;
  readonly worker_id: string;
  readonly target_path: string;
  readonly target_path_sha256: string;
  readonly authorization_session_id: string;
  readonly authorization_expires_at: string;
  readonly state: ProviderCredentialMaterializationState;
  readonly created_at: string;
  readonly dispatched_at: string | null;
  readonly materialized_at: string | null;
  readonly cleaned_at: string | null;
  readonly cleanup_reason: string | null;
  readonly cleanup_attempts: number;
  readonly cleanup_last_error: string | null;
  readonly cleanup_next_attempt_at: string | null;
}

const profileColumns = `workspace_id::text, profile_id, provider_instance_id, provider_driver,
  label, state, generation::text, key_version, wrapped_dek, nonce, auth_tag, ciphertext,
  idempotency_key, request_fingerprint, expires_at::text, created_at::text,
  updated_at::text, revoked_at::text`;
const materializationColumns = `workspace_id::text, materialization_id, profile_id,
  profile_generation::text, provider_instance_id, provider_driver, thread_id, environment_id,
  sandbox_id, worker_id, target_path,
  target_path_sha256, authorization_session_id, authorization_expires_at::text,
  state, created_at::text, dispatched_at::text, materialized_at::text, cleaned_at::text,
  cleanup_reason, cleanup_attempts, cleanup_last_error, cleanup_next_attempt_at::text`;

const profileFromRow = (row: ProfileRow): ProviderCredentialProfileRecord => ({
  workspaceId: row.workspace_id as WorkspaceId,
  profileId: row.profile_id as AgentProfileId,
  provider: {
    instanceId: row.provider_instance_id as ProviderInstanceRef["instanceId"],
    driver: row.provider_driver as ProviderInstanceRef["driver"],
  },
  label: row.label,
  state: row.state,
  generation: Number(row.generation),
  envelope: {
    envelopeVersion: 1,
    keyVersion: row.key_version,
    wrappedKey: row.wrapped_dek,
    nonce: row.nonce,
    authTag: row.auth_tag,
    ciphertext: row.ciphertext,
  },
  idempotencyKey: row.idempotency_key,
  requestFingerprint: row.request_fingerprint,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
  ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
});

const materializationFromRow = (
  row: MaterializationRow,
): ProviderCredentialMaterializationRecord => ({
  workspaceId: row.workspace_id as WorkspaceId,
  materializationId: row.materialization_id as AgentMaterializationId,
  profileId: row.profile_id as AgentProfileId,
  profileGeneration: Number(row.profile_generation),
  providerInstanceId: row.provider_instance_id as ProviderInstanceRef["instanceId"],
  providerDriver: row.provider_driver,
  threadId: row.thread_id as ThreadId,
  environmentId: row.environment_id as EnvironmentId,
  sandboxId: row.sandbox_id as SandboxId,
  workerId: row.worker_id as WorkerInstanceId,
  targetPath: row.target_path,
  targetPathSha256: row.target_path_sha256,
  authorizationSessionId: row.authorization_session_id as AuthSessionId,
  authorizationExpiresAt: row.authorization_expires_at,
  state: row.state,
  createdAt: row.created_at,
  ...(row.dispatched_at === null ? {} : { dispatchedAt: row.dispatched_at }),
  ...(row.materialized_at === null ? {} : { materializedAt: row.materialized_at }),
  ...(row.cleaned_at === null ? {} : { cleanedAt: row.cleaned_at }),
  ...(row.cleanup_reason === null ? {} : { cleanupReason: row.cleanup_reason }),
  cleanupAttempts: row.cleanup_attempts,
  ...(row.cleanup_last_error === null ? {} : { cleanupLastError: row.cleanup_last_error }),
  ...(row.cleanup_next_attempt_at === null
    ? {}
    : { cleanupNextAttemptAt: row.cleanup_next_attempt_at }),
});

const failed = (
  operation: string,
  cause?: unknown,
  code: ProviderCredentialStoreError["code"] = "storeFailed",
) =>
  new ProviderCredentialStoreError({ operation, code, ...(cause === undefined ? {} : { cause }) });

const query = <Row extends QueryResultRow>(
  client: Pick<PoolClient, "query">,
  operation: string,
  sql: string,
  values: ReadonlyArray<unknown> = [],
) =>
  Effect.tryPromise({
    try: async () => (await client.query<Row>(sql, [...values])).rows,
    catch: (cause) => failed(operation, cause),
  });

const transaction = <A>(
  pool: Pool,
  operation: string,
  use: (client: PoolClient) => Effect.Effect<A, ProviderCredentialStoreError>,
) =>
  Effect.acquireUseRelease(
    Effect.tryPromise({ try: () => pool.connect(), catch: (cause) => failed(operation, cause) }),
    (client) =>
      query(client, operation, "BEGIN").pipe(
        Effect.andThen(use(client)),
        Effect.tap(() => query(client, operation, "COMMIT")),
        Effect.catch((cause) =>
          query(client, operation, "ROLLBACK").pipe(
            Effect.ignore,
            Effect.andThen(Effect.fail(cause)),
          ),
        ),
      ),
    (client) => Effect.sync(() => client.release()),
  );

export const makePostgresProviderCredentialStore = (pool: Pool): ProviderCredentialStore => ({
  findProfileByIdempotency: (workspaceId, providerInstanceId, idempotencyKey) =>
    query<ProfileRow>(
      pool,
      "find-profile-idempotency",
      `SELECT ${profileColumns} FROM provider_credential_profile
       WHERE workspace_id = $1 AND provider_instance_id = $2 AND idempotency_key = $3`,
      [workspaceId, providerInstanceId, idempotencyKey],
    ).pipe(Effect.map((rows) => (rows[0] === undefined ? undefined : profileFromRow(rows[0])))),
  sealProfile: (record) =>
    transaction(pool, "seal-profile", (client) =>
      Effect.gen(function* () {
        yield* query(
          client,
          "lock-profile-idempotency",
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [
            [record.workspaceId, record.provider.instanceId, record.idempotencyKey]
              .map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`)
              .join("|"),
          ],
        );
        const existing = yield* query<ProfileRow>(
          client,
          "find-profile-idempotency",
          `SELECT ${profileColumns} FROM provider_credential_profile
           WHERE workspace_id = $1 AND provider_instance_id = $2 AND idempotency_key = $3`,
          [record.workspaceId, record.provider.instanceId, record.idempotencyKey],
        );
        if (existing[0] !== undefined) {
          if (existing[0].request_fingerprint !== record.requestFingerprint) {
            return yield* failed("seal-profile", undefined, "idempotencyConflict");
          }
          return profileFromRow(existing[0]);
        }
        const rows = yield* query<ProfileRow>(
          client,
          "insert-profile",
          `INSERT INTO provider_credential_profile (
             workspace_id, profile_id, provider_instance_id, provider_driver, label, state,
             generation, key_version, wrapped_dek, nonce, auth_tag, ciphertext,
             idempotency_key, request_fingerprint, expires_at, created_at, updated_at, revoked_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::timestamptz,
             $16::timestamptz,$17::timestamptz,$18::timestamptz)
           RETURNING ${profileColumns}`,
          [
            record.workspaceId,
            record.profileId,
            record.provider.instanceId,
            record.provider.driver,
            record.label,
            record.state,
            record.generation,
            record.envelope.keyVersion,
            Buffer.from(record.envelope.wrappedKey),
            Buffer.from(record.envelope.nonce),
            Buffer.from(record.envelope.authTag),
            Buffer.from(record.envelope.ciphertext),
            record.idempotencyKey,
            record.requestFingerprint,
            record.expiresAt ?? null,
            record.createdAt,
            record.updatedAt,
            record.revokedAt ?? null,
          ],
        );
        return profileFromRow(rows[0]!);
      }),
    ),
  getProfile: (workspaceId, profileId) =>
    query<ProfileRow>(
      pool,
      "get-profile",
      `SELECT ${profileColumns} FROM provider_credential_profile
       WHERE workspace_id = $1 AND profile_id = $2`,
      [workspaceId, profileId],
    ).pipe(Effect.map((rows) => (rows[0] === undefined ? undefined : profileFromRow(rows[0])))),
  revokeProfile: (workspaceId, profileId, revokedAt) =>
    transaction(pool, "revoke-profile", (client) =>
      Effect.gen(function* () {
        const rows = yield* query<ProfileRow>(
          client,
          "revoke-profile",
          `UPDATE provider_credential_profile
              SET state = 'revoked', generation = generation + CASE WHEN state = 'revoked' THEN 0 ELSE 1 END,
                  revoked_at = COALESCE(revoked_at, $3::timestamptz),
                  updated_at = GREATEST(updated_at, $3::timestamptz)
            WHERE workspace_id = $1 AND profile_id = $2
            RETURNING ${profileColumns}`,
          [workspaceId, profileId, revokedAt],
        );
        if (rows[0] === undefined) return yield* failed("revoke-profile", undefined, "notFound");
        yield* query(
          client,
          "fence-profile-materializations",
          `UPDATE provider_credential_materialization
              SET state = 'cleanup_required', cleanup_reason = 'revoked',
                  cleanup_next_attempt_at = $3::timestamptz
            WHERE workspace_id = $1 AND profile_id = $2 AND state <> 'cleaned'`,
          [workspaceId, profileId, revokedAt],
        );
        return profileFromRow(rows[0]);
      }),
    ),
  reserveMaterialization: (record) =>
    query<MaterializationRow>(
      pool,
      "reserve-materialization",
      `INSERT INTO provider_credential_materialization (
         workspace_id, materialization_id, profile_id, profile_generation,
         provider_instance_id, provider_driver, thread_id,
         environment_id, sandbox_id, worker_id, target_path, target_path_sha256,
         authorization_session_id, authorization_expires_at, state, created_at
       ) SELECT $1,$2,$3,profile.generation,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::timestamptz,
                'reserved',$14::timestamptz
         FROM provider_credential_profile profile
         WHERE profile.workspace_id = $1 AND profile.profile_id = $3
           AND profile.provider_instance_id = $4 AND profile.provider_driver = $5
           AND profile.state = 'active'
           AND (profile.expires_at IS NULL OR profile.expires_at > $14::timestamptz)
       ON CONFLICT (workspace_id, materialization_id) DO UPDATE
         SET materialization_id = provider_credential_materialization.materialization_id
       RETURNING ${materializationColumns}`,
      [
        record.workspaceId,
        record.materializationId,
        record.profileId,
        record.providerInstanceId,
        record.providerDriver,
        record.threadId,
        record.environmentId,
        record.sandboxId,
        record.workerId,
        record.targetPath,
        record.targetPathSha256,
        record.authorizationSessionId,
        record.authorizationExpiresAt,
        record.createdAt,
      ],
    ).pipe(
      Effect.flatMap((rows) => {
        if (rows[0] === undefined) {
          return Effect.fail(failed("reserve-materialization", undefined, "stateConflict"));
        }
        const stored = materializationFromRow(rows[0]);
        const matches =
          stored.profileId === record.profileId &&
          stored.providerInstanceId === record.providerInstanceId &&
          stored.providerDriver === record.providerDriver &&
          stored.threadId === record.threadId &&
          stored.environmentId === record.environmentId &&
          stored.sandboxId === record.sandboxId &&
          stored.workerId === record.workerId &&
          stored.targetPathSha256 === record.targetPathSha256 &&
          stored.authorizationSessionId === record.authorizationSessionId;
        return matches
          ? Effect.succeed(stored)
          : Effect.fail(failed("reserve-materialization", undefined, "idempotencyConflict"));
      }),
    ),
  markDispatched: (workspaceId, materializationId, profileGeneration, dispatchedAt) =>
    query<MaterializationRow>(
      pool,
      "mark-dispatched",
      `UPDATE provider_credential_materialization
       SET state = 'dispatched', dispatched_at = $4::timestamptz
       WHERE workspace_id = $1 AND materialization_id = $2
         AND profile_generation = $3 AND state = 'reserved'
       RETURNING ${materializationColumns}`,
      [workspaceId, materializationId, profileGeneration, dispatchedAt],
    ).pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.fail(failed("mark-dispatched", undefined, "stateConflict"))
          : Effect.succeed(materializationFromRow(rows[0])),
      ),
    ),
  confirmMaterialized: (workspaceId, materializationId, profileGeneration, materializedAt) =>
    transaction(pool, "confirm-materialized", (client) =>
      query(
        client,
        "confirm-materialized",
        `UPDATE provider_credential_materialization materialization
            SET state = CASE WHEN materialization.state = 'dispatched'
                                  AND profile.state = 'active' AND profile.generation = $3
                                  AND materialization.authorization_expires_at > $4::timestamptz
                             THEN 'active' ELSE 'cleanup_required' END,
                materialized_at = $4::timestamptz,
                cleaned_at = NULL,
                cleanup_reason = CASE WHEN materialization.state = 'dispatched'
                                           AND profile.state = 'active' AND profile.generation = $3
                                           AND materialization.authorization_expires_at > $4::timestamptz
                                      THEN NULL ELSE 'stale_generation' END,
                cleanup_next_attempt_at = CASE WHEN materialization.state = 'dispatched'
                                                    AND profile.state = 'active' AND profile.generation = $3
                                                    AND materialization.authorization_expires_at > $4::timestamptz
                                               THEN NULL ELSE $4::timestamptz END
           FROM provider_credential_profile profile
          WHERE materialization.workspace_id = $1
            AND materialization.materialization_id = $2
            AND materialization.profile_generation = $3
            AND materialization.state IN ('dispatched','cleanup_required','cleaned')
            AND profile.workspace_id = materialization.workspace_id
            AND profile.profile_id = materialization.profile_id
          RETURNING materialization.state`,
        [workspaceId, materializationId, profileGeneration, materializedAt],
      ).pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined
            ? Effect.succeed(false)
            : Effect.succeed((rows[0] as { state: string }).state === "active"),
        ),
      ),
    ),
  requireCleanup: (workspaceId, materializationId, reason, error, nextAttemptAt) =>
    query(
      pool,
      "require-cleanup",
      `UPDATE provider_credential_materialization
       SET state = 'cleanup_required', cleanup_reason = $3,
           cleanup_attempts = cleanup_attempts + 1, cleanup_last_error = $4,
           cleanup_next_attempt_at = $5::timestamptz
       WHERE workspace_id = $1 AND materialization_id = $2 AND state <> 'cleaned'`,
      [workspaceId, materializationId, reason, error ?? null, nextAttemptAt],
    ).pipe(Effect.asVoid),
  confirmAbsent: (workspaceId, materializationId, profileGeneration, cleanedAt, reason) =>
    query(
      pool,
      "mark-cleaned",
      `UPDATE provider_credential_materialization
       SET state = 'cleaned', cleaned_at = $3::timestamptz, cleanup_reason = $4
       WHERE workspace_id = $1 AND materialization_id = $2
         AND profile_generation = $5 AND state IN ('reserved','dispatched','active','cleanup_required')
       RETURNING materialization_id`,
      [workspaceId, materializationId, cleanedAt, reason, profileGeneration],
    ).pipe(Effect.map((rows) => rows.length === 1)),
  fenceUnconfirmed: (workspaceId, sandboxId, reason, nextAttemptAt) =>
    query<MaterializationRow>(
      pool,
      "fence-unconfirmed",
      `UPDATE provider_credential_materialization
          SET state = 'cleanup_required', cleanup_reason = $3,
              cleanup_next_attempt_at = $4::timestamptz
        WHERE workspace_id = $1 AND sandbox_id = $2 AND state IN ('reserved','dispatched')
        RETURNING ${materializationColumns}`,
      [workspaceId, sandboxId, reason, nextAttemptAt],
    ).pipe(Effect.map((rows) => rows.map(materializationFromRow))),
  fenceLifecycleMaterializations: (workspaceId, threadId, sandboxId, reason, nextAttemptAt) => {
    const sandboxClause = sandboxId === undefined ? "" : " AND sandbox_id = $5";
    return query<MaterializationRow>(
      pool,
      "fence-lifecycle-materializations",
      `UPDATE provider_credential_materialization
          SET state = 'cleanup_required', cleanup_reason = $3,
              cleanup_next_attempt_at = $4::timestamptz
        WHERE workspace_id = $1 AND thread_id = $2
          AND state IN ('reserved','dispatched','active','cleanup_required')${sandboxClause}
        RETURNING ${materializationColumns}`,
      sandboxId === undefined
        ? [workspaceId, threadId, reason, nextAttemptAt]
        : [workspaceId, threadId, reason, nextAttemptAt, sandboxId],
    ).pipe(Effect.map((rows) => rows.map(materializationFromRow)));
  },
  expireMaterializations: (workspaceId, now, sandboxId) => {
    const sandboxClause = sandboxId === undefined ? "" : " AND sandbox_id = $3";
    return query<MaterializationRow>(
      pool,
      "expire-materializations",
      `UPDATE provider_credential_materialization
          SET state = 'cleanup_required', cleanup_reason = 'authorization_expired',
              cleanup_next_attempt_at = $2::timestamptz
        WHERE workspace_id = $1
          AND state IN ('reserved','dispatched','active')
          AND authorization_expires_at <= $2::timestamptz${sandboxClause}
        RETURNING ${materializationColumns}`,
      sandboxId === undefined ? [workspaceId, now] : [workspaceId, now, sandboxId],
    ).pipe(Effect.map((rows) => rows.map(materializationFromRow)));
  },
  claimDueCleanup: (now, retryAt, limit) =>
    query<MaterializationRow>(
      pool,
      "claim-due-materialization-cleanup",
      `WITH due AS (
         SELECT ctid FROM provider_credential_materialization
          WHERE (state IN ('reserved','dispatched','active') AND authorization_expires_at <= $1::timestamptz)
             OR (state = 'cleanup_required' AND cleanup_next_attempt_at <= $1::timestamptz)
          ORDER BY COALESCE(cleanup_next_attempt_at, authorization_expires_at), materialization_id
          LIMIT $3 FOR UPDATE SKIP LOCKED
       )
       UPDATE provider_credential_materialization materialization
          SET state = 'cleanup_required',
              cleanup_reason = CASE
                WHEN materialization.authorization_expires_at <= $1::timestamptz
                  THEN 'authorization_expired'
                ELSE COALESCE(materialization.cleanup_reason, 'cleanup_retry')
              END,
              cleanup_attempts = cleanup_attempts + 1,
              cleanup_next_attempt_at = $2::timestamptz
         FROM due WHERE materialization.ctid = due.ctid
       RETURNING ${materializationColumns}`,
      [now, retryAt, limit],
    ).pipe(Effect.map((rows) => rows.map(materializationFromRow))),
  listLiveMaterializations: (workspaceId, selector) => {
    const clauses = [
      "workspace_id = $1",
      "state IN ('reserved','dispatched','active','cleanup_required')",
    ];
    const values: Array<unknown> = [workspaceId];
    if (selector.profileId !== undefined) {
      values.push(selector.profileId);
      clauses.push(`profile_id = $${values.length}`);
    }
    if (selector.sandboxId !== undefined) {
      values.push(selector.sandboxId);
      clauses.push(`sandbox_id = $${values.length}`);
    }
    return query<MaterializationRow>(
      pool,
      "list-live-materializations",
      `SELECT ${materializationColumns} FROM provider_credential_materialization
       WHERE ${clauses.join(" AND ")} ORDER BY created_at, materialization_id`,
      values,
    ).pipe(Effect.map((rows) => rows.map(materializationFromRow)));
  },
});
