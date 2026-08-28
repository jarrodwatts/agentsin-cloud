// @effect-diagnostics nodeBuiltinImport:off -- SHA-256 binds immutable receipt input at the PostgreSQL boundary.
import * as NodeCrypto from "node:crypto";

import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  UsageAccrual,
  type MicroUsdc,
  type UsageAccrualId,
  type UsageEvidenceSha256,
  type UsageSampleId,
  type VerifiedE2bUsageEvidence,
  type WorkspaceId,
  type SandboxId,
} from "@t3tools/contracts/cloud";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { exactUsagePriceDelta } from "./usagePricing.ts";

export class UsageLedgerRepositoryError extends Schema.TaggedErrorClass<UsageLedgerRepositoryError>()(
  "UsageLedgerRepositoryError",
  {
    code: Schema.Literals([
      "conflict",
      "invalidEvidenceRevision",
      "outOfOrder",
      "staleSandbox",
      "moneyOverflow",
      "databaseFailure",
    ]),
    operation: Schema.String,
    retryable: Schema.Boolean,
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {}

export interface AppendVerifiedUsageInput {
  readonly workspaceId: WorkspaceId;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly sandboxId: SandboxId;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly sampleId: UsageSampleId;
  readonly accrualId: UsageAccrualId;
  readonly evidence: VerifiedE2bUsageEvidence;
  readonly recordedAt: string;
}

export interface StoredUsageAccrual {
  readonly disposition: "created" | "duplicate";
  readonly requestFingerprint: string;
  readonly accrual: UsageAccrual;
}

export interface UsageLedgerRepository {
  readonly getByIdempotencyKey: (
    workspaceId: WorkspaceId,
    idempotencyKey: string,
  ) => Effect.Effect<StoredUsageAccrual | undefined, UsageLedgerRepositoryError>;
  readonly appendVerifiedUsage: (
    input: AppendVerifiedUsageInput,
  ) => Effect.Effect<StoredUsageAccrual, UsageLedgerRepositoryError>;
}

interface AccrualRow extends QueryResultRow {
  readonly request_fingerprint: string;
  readonly accrual_id: string;
  readonly sample_id: string;
  readonly prior_sample_id: string | null;
  readonly workspace_id: string;
  readonly environment_id: string;
  readonly thread_id: string;
  readonly sandbox_id: string;
  readonly evidence_id: string;
  readonly evidence_revision: number;
  readonly evidence_payload_sha256: string;
  readonly interval_start: string;
  readonly interval_end: string;
  readonly observed_at: string;
  readonly previous_upstream_micro_usdc: string;
  readonly previous_markup_micro_usdc: string;
  readonly previous_total_micro_usdc: string;
  readonly evidence_upstream_micro_usdc: string;
  readonly upstream_micro_usdc: string;
  readonly markup_micro_usdc: string;
  readonly total_micro_usdc: string;
  readonly upstream_delta_micro_usdc: string;
  readonly markup_delta_micro_usdc: string;
  readonly total_delta_micro_usdc: string;
  readonly receipt_input_sha256: string;
  readonly recorded_at: string;
}

const accrualColumns = `sample.request_fingerprint, ledger.accrual_id, sample.sample_id,
  sample.prior_sample_id, sample.workspace_id::text AS workspace_id, sample.environment_id,
  sample.thread_id, sample.sandbox_id, sample.evidence_id, sample.evidence_revision,
  sample.evidence_payload_sha256,
  to_char(sample.interval_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS interval_start,
  to_char(sample.interval_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS interval_end,
  to_char(sample.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at,
  ledger.previous_upstream_micro_usdc::text AS previous_upstream_micro_usdc,
  ledger.previous_markup_micro_usdc::text AS previous_markup_micro_usdc,
  ledger.previous_total_micro_usdc::text AS previous_total_micro_usdc,
  sample.upstream_micro_usdc::text AS evidence_upstream_micro_usdc,
  ledger.upstream_micro_usdc::text AS upstream_micro_usdc,
  ledger.markup_micro_usdc::text AS markup_micro_usdc,
  ledger.total_micro_usdc::text AS total_micro_usdc,
  ledger.upstream_delta_micro_usdc::text AS upstream_delta_micro_usdc,
  ledger.markup_delta_micro_usdc::text AS markup_delta_micro_usdc,
  ledger.total_delta_micro_usdc::text AS total_delta_micro_usdc,
  ledger.receipt_input_sha256,
  to_char(ledger.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS recorded_at`;

const decodeAccrual = Schema.decodeUnknownSync(UsageAccrual);
const money = (value: string) => Number(value);
const toAccrual = (row: AccrualRow): UsageAccrual =>
  decodeAccrual({
    accrualId: row.accrual_id,
    sampleId: row.sample_id,
    ...(row.prior_sample_id === null ? {} : { priorSampleId: row.prior_sample_id }),
    workspaceId: row.workspace_id,
    environmentId: row.environment_id,
    threadId: row.thread_id,
    sandboxId: row.sandbox_id,
    evidence: {
      evidenceId: row.evidence_id,
      revision: row.evidence_revision,
      infrastructureProvider: "e2b",
      verification: "e2b-authenticated-billing-record",
      payloadSha256: row.evidence_payload_sha256,
      intervalStart: row.interval_start,
      intervalEnd: row.interval_end,
      upstreamMicroUsdc: money(row.evidence_upstream_micro_usdc),
      observedAt: row.observed_at,
    },
    previousUpstreamMicroUsdc: money(row.previous_upstream_micro_usdc),
    previousMarkupMicroUsdc: money(row.previous_markup_micro_usdc),
    previousTotalMicroUsdc: money(row.previous_total_micro_usdc),
    upstreamMicroUsdc: money(row.upstream_micro_usdc),
    markupBasisPoints: 500,
    markupRounding: "half-up-to-nearest-micro-usdc",
    markupMicroUsdc: money(row.markup_micro_usdc),
    totalMicroUsdc: money(row.total_micro_usdc),
    upstreamDeltaMicroUsdc: money(row.upstream_delta_micro_usdc),
    markupDeltaMicroUsdc: money(row.markup_delta_micro_usdc),
    totalDeltaMicroUsdc: money(row.total_delta_micro_usdc),
    payloadSha256: row.receipt_input_sha256,
    recordedAt: row.recorded_at,
  });

const canonical = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  throw new TypeError("unsupported usage receipt input value");
};

export const usageReceiptInputSha256 = (
  value: Omit<UsageAccrual, "payloadSha256">,
): UsageEvidenceSha256 =>
  NodeCrypto.createHash("sha256")
    .update("agents-in-cloud/usage-accrual/v1\0")
    .update(canonical(value))
    .digest("hex") as UsageEvidenceSha256;

const repositoryError = (
  code: UsageLedgerRepositoryError["code"],
  operation: string,
  retryable: boolean,
  cause?: unknown,
) =>
  new UsageLedgerRepositoryError({
    code,
    operation,
    retryable,
    ...(cause === undefined ? {} : { cause }),
  });

const queryExisting = async (
  client: Pool | PoolClient,
  workspaceId: WorkspaceId,
  idempotencyKey: string,
) => {
  const result = await client.query<AccrualRow>(
    `SELECT ${accrualColumns}
       FROM cloud_usage_sample sample
       JOIN cloud_usage_ledger_entry ledger
         ON ledger.workspace_id = sample.workspace_id AND ledger.sample_id = sample.sample_id
      WHERE sample.workspace_id = $1 AND sample.idempotency_key = $2`,
    [workspaceId, idempotencyKey],
  );
  const row = result.rows[0];
  return row === undefined
    ? undefined
    : {
        disposition: "duplicate" as const,
        requestFingerprint: row.request_fingerprint,
        accrual: toAccrual(row),
      };
};

interface PriorRow extends QueryResultRow {
  readonly sample_id: string;
  readonly environment_id: string;
  readonly thread_id: string;
  readonly sandbox_id: string;
  readonly evidence_revision: number;
  readonly evidence_payload_sha256: string;
  readonly interval_start: string;
  readonly interval_end: string;
  readonly upstream_micro_usdc: string;
}

const withTransaction = async <A>(pool: Pool, use: (client: PoolClient) => Promise<A>) => {
  const client = await pool.connect();
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
};

export const makePostgresUsageLedgerRepository = (pool: Pool): UsageLedgerRepository => ({
  getByIdempotencyKey: (workspaceId, idempotencyKey) =>
    Effect.tryPromise({
      try: () => queryExisting(pool, workspaceId, idempotencyKey),
      catch: (cause) => repositoryError("databaseFailure", "get-by-idempotency-key", true, cause),
    }),
  appendVerifiedUsage: (input) =>
    Effect.tryPromise({
      try: () =>
        withTransaction(pool, async (client) => {
          // Fresh-key and replay races must observe the committed idempotency result before any
          // sequence checks. A collision only serializes unrelated requests; it cannot mix data.
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
            input.workspaceId,
            input.idempotencyKey,
          ]);
          const existing = await queryExisting(client, input.workspaceId, input.idempotencyKey);
          if (existing !== undefined) {
            if (existing.requestFingerprint !== input.requestFingerprint) {
              throw repositoryError("conflict", "append-verified-usage", false);
            }
            return existing;
          }

          const priorResult = await client.query<PriorRow>(
            `SELECT sample_id, environment_id, thread_id, sandbox_id, evidence_revision,
                    evidence_payload_sha256,
                    to_char(interval_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS interval_start,
                    to_char(interval_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS interval_end,
                    upstream_micro_usdc::text AS upstream_micro_usdc
               FROM cloud_usage_sample
              WHERE workspace_id = $1 AND evidence_id = $2
              ORDER BY evidence_revision DESC
              LIMIT 1 FOR UPDATE`,
            [input.workspaceId, input.evidence.evidenceId],
          );
          const prior = priorResult.rows[0];

          if (prior === undefined) {
            if (input.evidence.revision !== 1) {
              throw repositoryError(
                "invalidEvidenceRevision",
                "append-first-evidence-revision",
                false,
              );
            }
            const identity = await client.query(
              `SELECT reservation_id
                 FROM cloud_e2b_sandbox_identity
                WHERE workspace_id = $1 AND environment_id = $2 AND thread_id = $3
                  AND sandbox_id = $4 AND state = 'active'
                FOR UPDATE`,
              [input.workspaceId, input.environmentId, input.threadId, input.sandboxId],
            );
            if (identity.rowCount !== 1) {
              throw repositoryError("staleSandbox", "bind-current-sandbox", false);
            }
            const cursor = await client.query<{ readonly interval_end: string }>(
              `SELECT to_char(
                        interval_end AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                      ) AS interval_end
                 FROM cloud_usage_sample
                WHERE workspace_id = $1 AND sandbox_id = $2 AND evidence_revision = 1
                ORDER BY interval_end DESC
                LIMIT 1`,
              [input.workspaceId, input.sandboxId],
            );
            const lastIntervalEnd = cursor.rows[0]?.interval_end;
            if (lastIntervalEnd !== undefined && input.evidence.intervalStart < lastIntervalEnd) {
              throw repositoryError("outOfOrder", "advance-sandbox-usage-cursor", false);
            }
          } else {
            if (
              input.evidence.revision !== prior.evidence_revision + 1 ||
              input.environmentId !== prior.environment_id ||
              input.threadId !== prior.thread_id ||
              input.sandboxId !== prior.sandbox_id ||
              input.evidence.intervalStart !== prior.interval_start ||
              input.evidence.intervalEnd !== prior.interval_end ||
              input.evidence.payloadSha256 === prior.evidence_payload_sha256
            ) {
              throw repositoryError(
                "invalidEvidenceRevision",
                "append-corrected-evidence-revision",
                false,
              );
            }
          }

          let price;
          try {
            const priorUpstream = (
              prior === undefined ? 0 : money(prior.upstream_micro_usdc)
            ) as MicroUsdc;
            price = exactUsagePriceDelta(priorUpstream, input.evidence.upstreamMicroUsdc);
          } catch (cause) {
            throw repositoryError("moneyOverflow", "price-verified-usage", false, cause);
          }

          const withoutHash: Omit<UsageAccrual, "payloadSha256"> = {
            accrualId: input.accrualId,
            sampleId: input.sampleId,
            ...(prior === undefined ? {} : { priorSampleId: prior.sample_id as UsageSampleId }),
            workspaceId: input.workspaceId,
            environmentId: input.environmentId,
            threadId: input.threadId,
            sandboxId: input.sandboxId,
            evidence: input.evidence,
            previousUpstreamMicroUsdc: price.previous.upstreamMicroUsdc,
            previousMarkupMicroUsdc: price.previous.markupMicroUsdc,
            previousTotalMicroUsdc: price.previous.totalMicroUsdc,
            upstreamMicroUsdc: price.upstreamMicroUsdc,
            markupBasisPoints: 500,
            markupRounding: "half-up-to-nearest-micro-usdc",
            markupMicroUsdc: price.markupMicroUsdc,
            totalMicroUsdc: price.totalMicroUsdc,
            upstreamDeltaMicroUsdc: price.upstreamDeltaMicroUsdc,
            markupDeltaMicroUsdc: price.markupDeltaMicroUsdc,
            totalDeltaMicroUsdc: price.totalDeltaMicroUsdc,
            recordedAt: input.recordedAt,
          };
          const payloadSha256 = usageReceiptInputSha256(withoutHash);
          const accrual = decodeAccrual({ ...withoutHash, payloadSha256 });

          await client.query(
            `INSERT INTO cloud_usage_sample (
               workspace_id, sample_id, idempotency_key, request_fingerprint, environment_id,
               thread_id, sandbox_id, provider, verification, evidence_id, evidence_revision,
               evidence_payload_sha256, interval_start, interval_end, upstream_micro_usdc,
               prior_sample_id, observed_at, recorded_at
             ) VALUES (
               $1,$2,$3,$4,$5,$6,$7,'e2b','e2b-authenticated-billing-record',$8,$9,$10,
               $11,$12,$13,$14,$15,$16
             )`,
            [
              input.workspaceId,
              input.sampleId,
              input.idempotencyKey,
              input.requestFingerprint,
              input.environmentId,
              input.threadId,
              input.sandboxId,
              input.evidence.evidenceId,
              input.evidence.revision,
              input.evidence.payloadSha256,
              input.evidence.intervalStart,
              input.evidence.intervalEnd,
              input.evidence.upstreamMicroUsdc,
              prior?.sample_id ?? null,
              input.evidence.observedAt,
              input.recordedAt,
            ],
          );
          await client.query(
            `INSERT INTO cloud_usage_ledger_entry (
               workspace_id, accrual_id, sample_id, environment_id, thread_id, sandbox_id,
               entry_kind, previous_upstream_micro_usdc, previous_markup_micro_usdc,
               previous_total_micro_usdc, upstream_micro_usdc, markup_basis_points,
               markup_rounding, markup_micro_usdc, total_micro_usdc,
               upstream_delta_micro_usdc, markup_delta_micro_usdc, total_delta_micro_usdc,
               receipt_input_sha256, recorded_at
             ) VALUES (
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,500,'half-up-to-nearest-micro-usdc',
               $12,$13,$14,$15,$16,$17,$18
             )`,
            [
              input.workspaceId,
              input.accrualId,
              input.sampleId,
              input.environmentId,
              input.threadId,
              input.sandboxId,
              prior === undefined ? "usage" : "correction",
              price.previous.upstreamMicroUsdc,
              price.previous.markupMicroUsdc,
              price.previous.totalMicroUsdc,
              price.upstreamMicroUsdc,
              price.markupMicroUsdc,
              price.totalMicroUsdc,
              price.upstreamDeltaMicroUsdc,
              price.markupDeltaMicroUsdc,
              price.totalDeltaMicroUsdc,
              payloadSha256,
              input.recordedAt,
            ],
          );
          return {
            disposition: "created" as const,
            requestFingerprint: input.requestFingerprint,
            accrual,
          };
        }),
      catch: (cause) => {
        if (Schema.is(UsageLedgerRepositoryError)(cause)) return cause;
        const code =
          typeof cause === "object" && cause !== null && "code" in cause
            ? String(cause.code)
            : undefined;
        return repositoryError(
          code === "23505" ? "conflict" : "databaseFailure",
          "append-verified-usage",
          code !== "23505",
          cause,
        );
      },
    }),
});
