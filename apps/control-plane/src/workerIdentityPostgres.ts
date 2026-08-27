import type { PoolClient, QueryResultRow } from "pg";
import * as Effect from "effect/Effect";

import type { DatabaseService } from "./database.ts";
import {
  WorkerIdentityError,
  type ActiveWorkerLease,
  type WorkerBootstrapTokenRecord,
  type WorkerCertificateRecord,
  type WorkerIdentity,
  type WorkerIdentityRepository,
} from "./workerIdentity.ts";

const fail = (
  operation: string,
  cause?: unknown,
  code: WorkerIdentityError["code"] = "storeFailed",
) => new WorkerIdentityError({ code, operation, ...(cause === undefined ? {} : { cause }) });

const query = <Row extends QueryResultRow>(
  database: DatabaseService,
  operation: string,
  text: string,
  values: ReadonlyArray<unknown> = [],
) => database.query<Row>(text, values).pipe(Effect.mapError((cause) => fail(operation, cause)));

const clientQuery = <Row extends QueryResultRow>(
  client: Pick<PoolClient, "query">,
  operation: string,
  text: string,
  values: ReadonlyArray<unknown> = [],
) =>
  Effect.tryPromise({
    try: async () => (await client.query<Row>(text, [...values])).rows,
    catch: (cause) => fail(operation, cause),
  });

const transaction = <A>(
  database: DatabaseService,
  operation: string,
  use: (client: Pick<PoolClient, "query">) => Effect.Effect<A, WorkerIdentityError>,
) =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => database.pool.connect(),
      catch: (cause) => fail(operation, cause),
    }),
    (client) =>
      clientQuery(client, operation, "BEGIN").pipe(
        Effect.andThen(use(client)),
        Effect.tap(() => clientQuery(client, operation, "COMMIT")),
        Effect.catch((cause) =>
          clientQuery(client, operation, "ROLLBACK").pipe(
            Effect.ignore,
            Effect.andThen(Effect.fail(cause)),
          ),
        ),
      ),
    (client) => Effect.sync(() => client.release()),
  );

interface BootstrapRow extends QueryResultRow {
  readonly token_hash: string;
  readonly workspace_id: string;
  readonly thread_id: string;
  readonly environment_id: string;
  readonly environment_revision_id: string;
  readonly sandbox_id: string;
  readonly reservation_id: string;
  readonly worker_id: string;
  readonly provider_instance_id: string;
  readonly provider_driver: string;
  readonly identity_binding: string;
  readonly issued_at: string;
  readonly expires_at: string;
}

interface CertificateRow extends QueryResultRow, BootstrapRow {
  readonly certificate_fingerprint: string;
  readonly certificate_generation: string;
  readonly san_uri: string;
  readonly public_key_spki_sha256: string;
  readonly not_before: string;
  readonly not_after: string;
  readonly overlap_until: string | null;
  readonly revoked_at: string | null;
}

interface LeaseRow extends QueryResultRow {
  readonly workspace_id: string;
  readonly thread_id: string;
  readonly environment_id: string;
  readonly environment_revision_id: string;
  readonly sandbox_id: string;
  readonly reservation_id: string;
  readonly worker_id: string;
  readonly provider_instance_id: string;
  readonly provider_driver: string;
  readonly certificate_fingerprint: string;
  readonly certificate_generation: string;
  readonly lease_generation: string;
  readonly process_instance_id: string;
  readonly state: ActiveWorkerLease["state"];
  readonly connected_at: string;
  readonly last_seen_at: string;
  readonly heartbeat_sequence: string;
  readonly confirmed_event_cursor: string;
  readonly last_command_delivery_id: string | null;
}

const identityFromRow = (row: BootstrapRow): WorkerIdentity => ({
  workspaceId: row.workspace_id as WorkerIdentity["workspaceId"],
  threadId: row.thread_id as WorkerIdentity["threadId"],
  environmentId: row.environment_id as WorkerIdentity["environmentId"],
  environmentRevisionId: row.environment_revision_id as WorkerIdentity["environmentRevisionId"],
  sandboxId: row.sandbox_id as WorkerIdentity["sandboxId"],
  reservationId: row.reservation_id as WorkerIdentity["reservationId"],
  workerId: row.worker_id as WorkerIdentity["workerId"],
  providerInstanceId: row.provider_instance_id as WorkerIdentity["providerInstanceId"],
  providerDriver: row.provider_driver as WorkerIdentity["providerDriver"],
});

const bootstrapFromRow = (row: BootstrapRow): WorkerBootstrapTokenRecord => ({
  ...identityFromRow(row),
  tokenHash: row.token_hash,
  identityBinding: row.identity_binding,
  issuedAt: row.issued_at,
  expiresAt: row.expires_at,
});

const certificateFromRow = (row: CertificateRow): WorkerCertificateRecord => ({
  ...identityFromRow(row),
  certificateFingerprint: row.certificate_fingerprint,
  certificateGeneration: Number(row.certificate_generation),
  identityBinding: row.identity_binding,
  sanUri: row.san_uri,
  publicKeySpkiSha256: row.public_key_spki_sha256,
  notBefore: row.not_before,
  notAfter: row.not_after,
  ...(row.overlap_until === null ? {} : { overlapUntil: row.overlap_until }),
  ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
});

const leaseFromRow = (row: LeaseRow): ActiveWorkerLease => ({
  workspaceId: row.workspace_id as ActiveWorkerLease["workspaceId"],
  threadId: row.thread_id as ActiveWorkerLease["threadId"],
  environmentId: row.environment_id as ActiveWorkerLease["environmentId"],
  environmentRevisionId: row.environment_revision_id as ActiveWorkerLease["environmentRevisionId"],
  sandboxId: row.sandbox_id as ActiveWorkerLease["sandboxId"],
  reservationId: row.reservation_id as ActiveWorkerLease["reservationId"],
  workerId: row.worker_id as ActiveWorkerLease["workerId"],
  providerInstanceId: row.provider_instance_id as ActiveWorkerLease["providerInstanceId"],
  providerDriver: row.provider_driver as ActiveWorkerLease["providerDriver"],
  certificateFingerprint: row.certificate_fingerprint,
  certificateGeneration: Number(row.certificate_generation),
  leaseGeneration: Number(row.lease_generation),
  processInstanceId: row.process_instance_id,
  state: row.state,
  connectedAt: row.connected_at,
  lastSeenAt: row.last_seen_at,
  heartbeatSequence: Number(row.heartbeat_sequence),
  confirmedEventCursor: Number(row.confirmed_event_cursor),
  ...(row.last_command_delivery_id === null
    ? {}
    : { lastCommandDeliveryId: row.last_command_delivery_id }),
});

const leaseReturning = `RETURNING workspace_id::text, thread_id, environment_id,
  environment_revision_id, sandbox_id, reservation_id, worker_id,
  provider_instance_id, provider_driver, certificate_fingerprint,
  certificate_generation::text, lease_generation::text, process_instance_id,
  state, connected_at::text, last_seen_at::text, heartbeat_sequence::text,
  confirmed_event_cursor::text, last_command_delivery_id`;

export const makePostgresWorkerIdentityRepository = (
  database: DatabaseService,
): WorkerIdentityRepository => ({
  insertBootstrapToken: (record) =>
    query(
      database,
      "insert-bootstrap-token",
      `INSERT INTO cloud_worker_bootstrap_token (
        token_hash, workspace_id, thread_id, environment_id, environment_revision_id,
        sandbox_id, reservation_id, worker_id, provider_instance_id, provider_driver,
        identity_binding, issued_at, expires_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,$13::timestamptz)`,
      [
        record.tokenHash,
        record.workspaceId,
        record.threadId,
        record.environmentId,
        record.environmentRevisionId,
        record.sandboxId,
        record.reservationId,
        record.workerId,
        record.providerInstanceId,
        record.providerDriver,
        record.identityBinding,
        record.issuedAt,
        record.expiresAt,
      ],
    ).pipe(Effect.asVoid),
  claimBootstrapToken: (tokenHash, now) =>
    query<BootstrapRow>(
      database,
      "claim-bootstrap-token",
      `UPDATE cloud_worker_bootstrap_token
       SET consumed_at = $2::timestamptz
       WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > $2::timestamptz
       RETURNING token_hash, workspace_id::text, thread_id, environment_id,
         environment_revision_id, sandbox_id, reservation_id, worker_id,
         provider_instance_id, provider_driver, identity_binding,
         issued_at::text, expires_at::text`,
      [tokenHash, now],
    ).pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.fail(fail("claim-bootstrap-token", undefined, "replayed"))
          : Effect.succeed(bootstrapFromRow(rows[0])),
      ),
    ),
  insertCertificate: (record) =>
    query(
      database,
      "insert-worker-certificate",
      `INSERT INTO cloud_worker_certificate (
        certificate_fingerprint, workspace_id, thread_id, environment_id,
        environment_revision_id, sandbox_id, reservation_id, worker_id,
        provider_instance_id, provider_driver, identity_binding, san_uri,
        public_key_spki_sha256, certificate_generation, not_before, not_after,
        overlap_until
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
        $15::timestamptz,$16::timestamptz,$17::timestamptz)`,
      [
        record.certificateFingerprint,
        record.workspaceId,
        record.threadId,
        record.environmentId,
        record.environmentRevisionId,
        record.sandboxId,
        record.reservationId,
        record.workerId,
        record.providerInstanceId,
        record.providerDriver,
        record.identityBinding,
        record.sanUri,
        record.publicKeySpkiSha256,
        record.certificateGeneration,
        record.notBefore,
        record.notAfter,
        record.overlapUntil ?? null,
      ],
    ).pipe(Effect.asVoid),
  markCertificateSuperseded: (fingerprint, overlapUntil) =>
    query(
      database,
      "supersede-worker-certificate",
      `UPDATE cloud_worker_certificate SET overlap_until = $2::timestamptz
       WHERE certificate_fingerprint = $1 AND revoked_at IS NULL
       RETURNING certificate_fingerprint`,
      [fingerprint, overlapUntil],
    ).pipe(
      Effect.flatMap((rows) =>
        rows.length === 1
          ? Effect.void
          : Effect.fail(fail("supersede-worker-certificate", undefined, "invalid")),
      ),
    ),
  findCertificate: (fingerprint) =>
    query<CertificateRow>(
      database,
      "find-worker-certificate",
      `SELECT certificate_fingerprint, workspace_id::text, thread_id, environment_id,
        environment_revision_id, sandbox_id, reservation_id, worker_id,
        provider_instance_id, provider_driver, identity_binding, san_uri,
        public_key_spki_sha256, certificate_generation::text, not_before::text,
        not_after::text, overlap_until::text, revoked_at::text,
        '' AS token_hash, now()::text AS issued_at, now()::text AS expires_at
       FROM cloud_worker_certificate WHERE certificate_fingerprint = $1`,
      [fingerprint],
    ).pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.fail(fail("find-worker-certificate", undefined, "invalid"))
          : Effect.succeed(certificateFromRow(rows[0])),
      ),
    ),
  activateLease: (certificate, processInstanceId, now) =>
    query<LeaseRow>(
      database,
      "activate-worker-lease",
      `INSERT INTO cloud_worker_lease (
        workspace_id, sandbox_id, thread_id, environment_id, environment_revision_id,
        reservation_id, worker_id, provider_instance_id, provider_driver,
        certificate_fingerprint, certificate_generation, lease_generation,
        process_instance_id, state, connected_at, last_seen_at,
        heartbeat_sequence, confirmed_event_cursor
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12,'connected',
        $13::timestamptz,$13::timestamptz,0,-1)
      ON CONFLICT (workspace_id, sandbox_id) DO UPDATE SET
        thread_id = EXCLUDED.thread_id,
        environment_id = EXCLUDED.environment_id,
        environment_revision_id = EXCLUDED.environment_revision_id,
        reservation_id = EXCLUDED.reservation_id,
        worker_id = EXCLUDED.worker_id,
        provider_instance_id = EXCLUDED.provider_instance_id,
        provider_driver = EXCLUDED.provider_driver,
        certificate_fingerprint = EXCLUDED.certificate_fingerprint,
        certificate_generation = EXCLUDED.certificate_generation,
        lease_generation = cloud_worker_lease.lease_generation + 1,
        process_instance_id = EXCLUDED.process_instance_id,
        state = 'connected', connected_at = EXCLUDED.connected_at,
        last_seen_at = EXCLUDED.last_seen_at, disconnected_at = NULL,
        heartbeat_sequence = 0, fence_reason = NULL
      WHERE EXCLUDED.certificate_generation >= cloud_worker_lease.certificate_generation
      ${leaseReturning}`,
      [
        certificate.workspaceId,
        certificate.sandboxId,
        certificate.threadId,
        certificate.environmentId,
        certificate.environmentRevisionId,
        certificate.reservationId,
        certificate.workerId,
        certificate.providerInstanceId,
        certificate.providerDriver,
        certificate.certificateFingerprint,
        certificate.certificateGeneration,
        processInstanceId,
        now,
      ],
    ).pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.fail(fail("activate-worker-lease", undefined, "staleCertificate"))
          : Effect.succeed(leaseFromRow(rows[0])),
      ),
    ),
  heartbeat: (lease, heartbeatSequence, now) =>
    query<LeaseRow>(
      database,
      "worker-heartbeat",
      `UPDATE cloud_worker_lease SET heartbeat_sequence = $4, last_seen_at = $5::timestamptz
       WHERE workspace_id = $1 AND sandbox_id = $2 AND lease_generation = $3
         AND state = 'connected' AND heartbeat_sequence < $4
       ${leaseReturning}`,
      [lease.workspaceId, lease.sandboxId, lease.leaseGeneration, heartbeatSequence, now],
    ).pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.fail(fail("worker-heartbeat", undefined, "leaseFenced"))
          : Effect.succeed(leaseFromRow(rows[0])),
      ),
    ),
  saveCursors: (lease, cursors, now) =>
    query<LeaseRow>(
      database,
      "save-worker-cursors",
      `UPDATE cloud_worker_lease SET
        confirmed_event_cursor = GREATEST(confirmed_event_cursor, COALESCE($4, confirmed_event_cursor)),
        last_command_delivery_id = COALESCE($5, last_command_delivery_id),
        last_seen_at = $6::timestamptz
       WHERE workspace_id = $1 AND sandbox_id = $2 AND lease_generation = $3
         AND state = 'connected'
       ${leaseReturning}`,
      [
        lease.workspaceId,
        lease.sandboxId,
        lease.leaseGeneration,
        cursors.confirmedEventCursor ?? null,
        cursors.commandDeliveryId ?? null,
        now,
      ],
    ).pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.fail(fail("save-worker-cursors", undefined, "leaseFenced"))
          : Effect.succeed(leaseFromRow(rows[0])),
      ),
    ),
  disconnect: (lease, state, now) =>
    query(
      database,
      "disconnect-worker-lease",
      `UPDATE cloud_worker_lease SET state = $4, disconnected_at = $5::timestamptz
       WHERE workspace_id = $1 AND sandbox_id = $2 AND lease_generation = $3
         AND state = 'connected' RETURNING 1 AS changed`,
      [lease.workspaceId, lease.sandboxId, lease.leaseGeneration, state, now],
    ).pipe(Effect.map((rows) => rows.length > 0)),
  fenceSandbox: (workspaceId, sandboxId, reason, now) =>
    transaction(database, "fence-worker-sandbox", (client) =>
      Effect.gen(function* () {
        const rows = yield* clientQuery<CertificateRow>(
          client,
          "list-worker-identities-for-fence",
          `SELECT certificate_fingerprint, workspace_id::text, thread_id, environment_id,
          environment_revision_id, sandbox_id, reservation_id, worker_id,
          provider_instance_id, provider_driver, identity_binding, san_uri,
          public_key_spki_sha256, certificate_generation::text, not_before::text,
          not_after::text, overlap_until::text, revoked_at::text,
          '' AS token_hash, now()::text AS issued_at, now()::text AS expires_at
         FROM cloud_worker_certificate WHERE workspace_id = $1 AND sandbox_id = $2`,
          [workspaceId, sandboxId],
        );
        yield* clientQuery(
          client,
          "revoke-worker-certificates",
          `UPDATE cloud_worker_certificate SET revoked_at = $4::timestamptz,
          revocation_reason = $3 WHERE workspace_id = $1 AND sandbox_id = $2
          AND revoked_at IS NULL`,
          [workspaceId, sandboxId, reason, now],
        );
        yield* clientQuery(
          client,
          "consume-worker-bootstrap-tokens",
          `UPDATE cloud_worker_bootstrap_token SET consumed_at = COALESCE(consumed_at, $3::timestamptz)
         WHERE workspace_id = $1 AND sandbox_id = $2`,
          [workspaceId, sandboxId, now],
        );
        yield* clientQuery(
          client,
          "fence-worker-lease",
          `UPDATE cloud_worker_lease SET state = 'fenced', disconnected_at = $4::timestamptz,
          fence_reason = $3 WHERE workspace_id = $1 AND sandbox_id = $2`,
          [workspaceId, sandboxId, reason, now],
        );
        return rows.map(identityFromRow);
      }),
    ),
  recoverProcess: (processInstanceId, now) =>
    query<LeaseRow>(
      database,
      "recover-worker-process",
      `UPDATE cloud_worker_lease SET state = 'disconnected', disconnected_at = $2::timestamptz
       WHERE process_instance_id = $1 AND state = 'connected'
       ${leaseReturning}`,
      [processInstanceId, now],
    ).pipe(Effect.map((rows) => rows.map(leaseFromRow))),
});
