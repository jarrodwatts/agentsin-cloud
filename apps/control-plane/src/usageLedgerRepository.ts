// @effect-diagnostics nodeBuiltinImport:off -- SHA-256 binds immutable receipt input at the PostgreSQL boundary.
import * as NodeCrypto from "node:crypto";

import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  UsageAccrual,
  type MicroUsdc,
  type SignedMicroUsdc,
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

import { exactCumulativeUsageTransition } from "./usagePricing.ts";

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
  readonly pricing_scope_kind: "workspace";
  readonly pricing_scope_id: string;
  readonly pricing_version: number;
  readonly pricing_sequence: string;
  readonly evidence_previous_upstream_micro_usdc: string;
  readonly evidence_upstream_micro_usdc: string;
  readonly cumulative_upstream_before_micro_usdc: string;
  readonly cumulative_upstream_after_micro_usdc: string;
  readonly cumulative_markup_before_micro_usdc: string;
  readonly cumulative_markup_after_micro_usdc: string;
  readonly cumulative_total_before_micro_usdc: string;
  readonly cumulative_total_after_micro_usdc: string;
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
  ledger.pricing_scope_kind, ledger.pricing_scope_id::text AS pricing_scope_id,
  ledger.pricing_version, ledger.pricing_sequence::text AS pricing_sequence,
  ledger.evidence_previous_upstream_micro_usdc::text AS evidence_previous_upstream_micro_usdc,
  sample.upstream_micro_usdc::text AS evidence_upstream_micro_usdc,
  ledger.cumulative_upstream_before_micro_usdc::text AS cumulative_upstream_before_micro_usdc,
  ledger.cumulative_upstream_after_micro_usdc::text AS cumulative_upstream_after_micro_usdc,
  ledger.cumulative_markup_before_micro_usdc::text AS cumulative_markup_before_micro_usdc,
  ledger.cumulative_markup_after_micro_usdc::text AS cumulative_markup_after_micro_usdc,
  ledger.cumulative_total_before_micro_usdc::text AS cumulative_total_before_micro_usdc,
  ledger.cumulative_total_after_micro_usdc::text AS cumulative_total_after_micro_usdc,
  ledger.upstream_delta_micro_usdc::text AS upstream_delta_micro_usdc,
  ledger.markup_delta_micro_usdc::text AS markup_delta_micro_usdc,
  ledger.total_delta_micro_usdc::text AS total_delta_micro_usdc,
  ledger.receipt_input_sha256,
  to_char(ledger.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS recorded_at`;

const decodeAccrual = Schema.decodeUnknownSync(UsageAccrual);
const isUsageLedgerRepositoryError = Schema.is(UsageLedgerRepositoryError);
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
    pricingScope: {
      kind: row.pricing_scope_kind,
      workspaceId: row.pricing_scope_id,
    },
    pricingVersion: row.pricing_version,
    pricingSequence: money(row.pricing_sequence),
    evidencePreviousUpstreamMicroUsdc: money(row.evidence_previous_upstream_micro_usdc),
    evidenceUpstreamMicroUsdc: money(row.evidence_upstream_micro_usdc),
    markupBasisPoints: 500,
    markupRounding: "half-up-to-nearest-micro-usdc",
    upstreamDeltaMicroUsdc: money(row.upstream_delta_micro_usdc),
    cumulativeUpstreamBeforeMicroUsdc: money(row.cumulative_upstream_before_micro_usdc),
    cumulativeUpstreamAfterMicroUsdc: money(row.cumulative_upstream_after_micro_usdc),
    cumulativeMarkupBeforeMicroUsdc: money(row.cumulative_markup_before_micro_usdc),
    cumulativeMarkupAfterMicroUsdc: money(row.cumulative_markup_after_micro_usdc),
    cumulativeTotalBeforeMicroUsdc: money(row.cumulative_total_before_micro_usdc),
    cumulativeTotalAfterMicroUsdc: money(row.cumulative_total_after_micro_usdc),
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
    .update("agents-in-cloud/usage-accrual/v2\0")
    .update(canonical(value))
    .digest("hex") as UsageEvidenceSha256;

const verifiedAccrualFromRow = (row: AccrualRow) => {
  const accrual = toAccrual(row);
  const { payloadSha256, ...receiptInput } = accrual;
  if (usageReceiptInputSha256(receiptInput) !== payloadSha256) {
    throw new TypeError("stored usage receipt input hash does not match its immutable payload");
  }
  return accrual;
};

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
        accrual: verifiedAccrualFromRow(row),
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

interface PricingCursorRow extends QueryResultRow {
  readonly pricing_scope_kind: "workspace";
  readonly pricing_scope_id: string;
  readonly pricing_version: number;
  readonly transition_count: string;
  readonly cumulative_upstream_micro_usdc: string;
  readonly cumulative_markup_micro_usdc: string;
  readonly cumulative_total_micro_usdc: string;
}

const signedDifference = (current: MicroUsdc, previous: MicroUsdc): SignedMicroUsdc => {
  const delta = BigInt(current) - BigInt(previous);
  if (delta < BigInt(Number.MIN_SAFE_INTEGER) || delta > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("usage evidence correction delta exceeds safe micro-USDC bounds");
  }
  return Number(delta) as SignedMicroUsdc;
};

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

          await client.query(
            `INSERT INTO cloud_usage_pricing_cursor (
               workspace_id, pricing_scope_kind, pricing_scope_id, pricing_version,
               transition_count, cumulative_upstream_micro_usdc,
               cumulative_markup_micro_usdc, cumulative_total_micro_usdc, updated_at
             ) VALUES ($1,'workspace',$1,1,0,0,0,0,$2)
             ON CONFLICT (workspace_id) DO NOTHING`,
            [input.workspaceId, input.recordedAt],
          );
          const cursorResult = await client.query<PricingCursorRow>(
            `SELECT pricing_scope_kind, pricing_scope_id::text AS pricing_scope_id,
                    pricing_version, transition_count::text AS transition_count,
                    cumulative_upstream_micro_usdc::text AS cumulative_upstream_micro_usdc,
                    cumulative_markup_micro_usdc::text AS cumulative_markup_micro_usdc,
                    cumulative_total_micro_usdc::text AS cumulative_total_micro_usdc
               FROM cloud_usage_pricing_cursor
              WHERE workspace_id = $1
              FOR UPDATE`,
            [input.workspaceId],
          );
          const pricingCursor = cursorResult.rows[0];
          if (pricingCursor === undefined) {
            throw repositoryError("databaseFailure", "lock-pricing-cursor", true);
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
          let evidencePreviousUpstreamMicroUsdc: MicroUsdc;
          let pricingSequence: number;
          try {
            evidencePreviousUpstreamMicroUsdc = (
              prior === undefined ? 0 : money(prior.upstream_micro_usdc)
            ) as MicroUsdc;
            const upstreamDeltaMicroUsdc = signedDifference(
              input.evidence.upstreamMicroUsdc,
              evidencePreviousUpstreamMicroUsdc,
            );
            price = exactCumulativeUsageTransition(
              money(pricingCursor.cumulative_upstream_micro_usdc) as MicroUsdc,
              upstreamDeltaMicroUsdc,
            );
            pricingSequence = money(pricingCursor.transition_count) + 1;
            if (!Number.isSafeInteger(pricingSequence)) {
              throw new RangeError("pricing sequence exceeds safe integer bounds");
            }
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
            pricingScope: {
              kind: pricingCursor.pricing_scope_kind,
              workspaceId: pricingCursor.pricing_scope_id as WorkspaceId,
            },
            pricingVersion: 1,
            pricingSequence,
            evidencePreviousUpstreamMicroUsdc,
            evidenceUpstreamMicroUsdc: input.evidence.upstreamMicroUsdc,
            markupBasisPoints: 500,
            markupRounding: "half-up-to-nearest-micro-usdc",
            upstreamDeltaMicroUsdc: price.upstreamDeltaMicroUsdc,
            cumulativeUpstreamBeforeMicroUsdc: price.before.upstreamMicroUsdc,
            cumulativeUpstreamAfterMicroUsdc: price.after.upstreamMicroUsdc,
            cumulativeMarkupBeforeMicroUsdc: price.before.markupMicroUsdc,
            cumulativeMarkupAfterMicroUsdc: price.after.markupMicroUsdc,
            cumulativeTotalBeforeMicroUsdc: price.before.totalMicroUsdc,
            cumulativeTotalAfterMicroUsdc: price.after.totalMicroUsdc,
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
            `UPDATE cloud_usage_pricing_cursor
                SET transition_count = $2,
                    cumulative_upstream_micro_usdc = $3,
                    cumulative_markup_micro_usdc = $4,
                    cumulative_total_micro_usdc = $5,
                    updated_at = $6
              WHERE workspace_id = $1`,
            [
              input.workspaceId,
              pricingSequence,
              price.after.upstreamMicroUsdc,
              price.after.markupMicroUsdc,
              price.after.totalMicroUsdc,
              input.recordedAt,
            ],
          );
          await client.query(
            `INSERT INTO cloud_usage_ledger_entry (
               workspace_id, accrual_id, sample_id, environment_id, thread_id, sandbox_id,
               entry_kind, evidence_revision, pricing_scope_kind, pricing_scope_id,
               pricing_version, pricing_sequence, evidence_previous_upstream_micro_usdc,
               evidence_upstream_micro_usdc, cumulative_upstream_before_micro_usdc,
               cumulative_upstream_after_micro_usdc, markup_basis_points, markup_rounding,
               cumulative_markup_before_micro_usdc, cumulative_markup_after_micro_usdc,
               cumulative_total_before_micro_usdc, cumulative_total_after_micro_usdc,
               upstream_delta_micro_usdc, markup_delta_micro_usdc, total_delta_micro_usdc,
               receipt_input_sha256, recorded_at
             ) VALUES (
               $1,$2,$3,$4,$5,$6,$7,$8,'workspace',$1,1,$9,$10,$11,$12,$13,
               500,'half-up-to-nearest-micro-usdc',$14,$15,$16,$17,$18,$19,$20,$21,$22
             )`,
            [
              input.workspaceId,
              input.accrualId,
              input.sampleId,
              input.environmentId,
              input.threadId,
              input.sandboxId,
              prior === undefined ? "usage" : "correction",
              input.evidence.revision,
              pricingSequence,
              evidencePreviousUpstreamMicroUsdc,
              input.evidence.upstreamMicroUsdc,
              price.before.upstreamMicroUsdc,
              price.after.upstreamMicroUsdc,
              price.before.markupMicroUsdc,
              price.after.markupMicroUsdc,
              price.before.totalMicroUsdc,
              price.after.totalMicroUsdc,
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
        if (isUsageLedgerRepositoryError(cause)) return cause;
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
