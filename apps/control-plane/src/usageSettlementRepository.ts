// @effect-diagnostics nodeBuiltinImport:off -- Domain-separated SHA-256 gives settlement attempts stable identities.
import * as NodeCrypto from "node:crypto";

import type { ThreadId } from "@t3tools/contracts";
import type {
  EvmAddress,
  EvmTransactionHash,
  SettlementId,
  SignedMicroUsdc,
  UsageEvidenceSha256,
  UsageSettlementAccrualPosting,
  UsageSettlementAttemptState,
  UsageSettlementTrigger,
  WorkspaceId,
} from "@t3tools/contracts/cloud";
import { UsageSettlementReceipt } from "@t3tools/contracts/cloud";
import type { WalletDelegatedAuthorizationId, WalletId } from "@t3tools/contracts/wallet";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import type { Pool, PoolClient, QueryResultRow } from "pg";

export const SETTLEMENT_INTERVAL_MS = 5 * 60_000;
export const SETTLEMENT_AMOUNT_THRESHOLD_MICRO_USDC = 250_000;

export class UsageSettlementRepositoryError extends Error {
  readonly code: "conflict" | "notFound" | "configurationMissing" | "databaseFailure";

  constructor(code: UsageSettlementRepositoryError["code"], message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "UsageSettlementRepositoryError";
    this.code = code;
  }
}

export interface UsageSettlementAttempt {
  readonly settlementId: SettlementId;
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly state: UsageSettlementAttemptState;
  readonly trigger: UsageSettlementTrigger;
  readonly walletId: WalletId;
  readonly authorizationId: WalletDelegatedAuthorizationId;
  readonly walletAddress: EvmAddress;
  readonly treasuryAddress: EvmAddress;
  readonly firstPricingSequence: number;
  readonly lastPricingSequence: number;
  readonly upstreamDeltaMicroUsdc: SignedMicroUsdc;
  readonly markupDeltaMicroUsdc: SignedMicroUsdc;
  readonly totalDeltaMicroUsdc: number;
  readonly requestFingerprint: string;
  readonly postings: ReadonlyArray<UsageSettlementAccrualPosting>;
  readonly providerActivityRef?: string;
  readonly txHash?: EvmTransactionHash;
  readonly transferSubmittedAt?: string;
  readonly failureCode?: string;
  readonly processingOwner?: string;
  readonly processingLeaseExpiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finalizedAt?: string;
  readonly receipt?: UsageSettlementReceipt;
}

export interface UsageSettlementClaimRequest {
  readonly processorId: string;
  readonly now: string;
  readonly leaseExpiresAt: string;
  readonly limit: number;
  readonly trigger?: "sandbox-paused" | "sandbox-closed";
  readonly workspaceId?: WorkspaceId;
  readonly threadId?: ThreadId;
}

export interface UsageSettlementRepository {
  readonly claimReady: (
    request: UsageSettlementClaimRequest,
  ) => Promise<ReadonlyArray<UsageSettlementAttempt>>;
  readonly claimRecoverable: (
    processorId: string,
    now: string,
    leaseExpiresAt: string,
    limit: number,
  ) => Promise<ReadonlyArray<UsageSettlementAttempt>>;
  readonly claimLowBalance: (
    workspaceId: WorkspaceId,
    settlementId: SettlementId,
    processorId: string,
    now: string,
    leaseExpiresAt: string,
  ) => Promise<UsageSettlementAttempt>;
  readonly get: (
    workspaceId: WorkspaceId,
    settlementId: SettlementId,
  ) => Promise<UsageSettlementAttempt | undefined>;
  readonly setSubmissionPending: (
    attempt: UsageSettlementAttempt,
    processorId: string,
    now: string,
  ) => Promise<UsageSettlementAttempt>;
  readonly recordTransfer: (
    attempt: UsageSettlementAttempt,
    processorId: string,
    transfer: {
      readonly providerActivityRef: string;
      readonly txHash: EvmTransactionHash;
      readonly submittedAt: string;
    },
    now: string,
  ) => Promise<UsageSettlementAttempt>;
  readonly markReconciliationRequired: (
    attempt: UsageSettlementAttempt,
    processorId: string,
    providerActivityRef: string | undefined,
    failureCode: string,
    now: string,
  ) => Promise<UsageSettlementAttempt>;
  readonly markLowBalancePausePending: (
    attempt: UsageSettlementAttempt,
    processorId: string,
    failureCode: string,
    now: string,
  ) => Promise<UsageSettlementAttempt>;
  readonly markLowBalancePaused: (
    attempt: UsageSettlementAttempt,
    processorId: string,
    now: string,
  ) => Promise<UsageSettlementAttempt>;
  readonly finalize: (
    attempt: UsageSettlementAttempt,
    processorId: string,
    receipt: UsageSettlementReceipt,
    now: string,
  ) => Promise<UsageSettlementAttempt>;
  readonly releaseLease: (
    attempt: UsageSettlementAttempt,
    processorId: string,
    failureCode: string,
    now: string,
  ) => Promise<void>;
}

interface CandidateRow extends QueryResultRow {
  readonly workspace_id: string;
  readonly thread_id: string;
  readonly oldest_recorded_at: string;
  readonly total_delta_micro_usdc: string;
}

interface AuthorizationRow extends QueryResultRow {
  readonly wallet_id: string;
  readonly authorization_id: string;
  readonly wallet_address: string;
  readonly treasury_address: string;
  readonly per_charge_limit_micro_usdc: string;
}

interface PostingRow extends QueryResultRow {
  readonly accrual_id: string;
  readonly sample_id: string;
  readonly environment_id: string;
  readonly sandbox_id: string;
  readonly evidence_id: string;
  readonly evidence_revision: number;
  readonly evidence_payload_sha256: string;
  readonly receipt_input_sha256: string;
  readonly pricing_sequence: string;
  readonly interval_start: string;
  readonly interval_end: string;
  readonly upstream_delta_micro_usdc: string;
  readonly markup_delta_micro_usdc: string;
  readonly total_delta_micro_usdc: string;
}

interface AttemptRow extends QueryResultRow {
  readonly workspace_id: string;
  readonly settlement_id: string;
  readonly thread_id: string;
  readonly state: UsageSettlementAttemptState;
  readonly trigger_kind: UsageSettlementTrigger;
  readonly wallet_id: string;
  readonly authorization_id: string;
  readonly wallet_address: string;
  readonly treasury_address: string;
  readonly first_pricing_sequence: string;
  readonly last_pricing_sequence: string;
  readonly upstream_delta_micro_usdc: string;
  readonly markup_delta_micro_usdc: string;
  readonly total_delta_micro_usdc: string;
  readonly request_fingerprint: string;
  readonly provider_activity_ref: string | null;
  readonly tx_hash: string | null;
  readonly transfer_submitted_at: string | null;
  readonly failure_code: string | null;
  readonly processing_owner: string | null;
  readonly processing_lease_expires_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly finalized_at: string | null;
}

interface ReceiptRow extends QueryResultRow {
  readonly payload: unknown;
  readonly payload_sha256: string;
  readonly signature_algorithm: string;
  readonly signature_key_id: string;
  readonly signature: string;
  readonly signed_at: string;
}

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
  throw new TypeError("unsupported settlement identity value");
};

const digest = (domain: string, value: unknown) =>
  NodeCrypto.createHash("sha256").update(`${domain}\0`).update(canonical(value)).digest("hex");

const decodeReceipt = Schema.decodeUnknownSync(UsageSettlementReceipt);
const receiptPayloadHash = (value: UsageSettlementReceipt["payload"]) =>
  digest("agents-in-cloud/usage-settlement-receipt/v1", value);

const safeNumber = (value: string) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new RangeError("settlement money exceeds safe bounds");
  return parsed;
};

const safeSum = (values: ReadonlyArray<number>) => {
  const total = values.reduce((sum, value) => BigInt(sum) + BigInt(value), 0n);
  if (total < BigInt(Number.MIN_SAFE_INTEGER) || total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("settlement batch exceeds safe micro-USDC bounds");
  }
  return Number(total);
};

const postingFromRow = (row: PostingRow): UsageSettlementAccrualPosting => ({
  accrualId: row.accrual_id as UsageSettlementAccrualPosting["accrualId"],
  sampleId: row.sample_id as UsageSettlementAccrualPosting["sampleId"],
  environmentId: row.environment_id as UsageSettlementAccrualPosting["environmentId"],
  sandboxId: row.sandbox_id as UsageSettlementAccrualPosting["sandboxId"],
  evidenceId: row.evidence_id as UsageSettlementAccrualPosting["evidenceId"],
  evidenceRevision: row.evidence_revision,
  evidencePayloadSha256: row.evidence_payload_sha256 as UsageEvidenceSha256,
  receiptInputSha256: row.receipt_input_sha256 as UsageEvidenceSha256,
  pricingSequence: safeNumber(row.pricing_sequence),
  intervalStart: row.interval_start,
  intervalEnd: row.interval_end,
  upstreamDeltaMicroUsdc: safeNumber(row.upstream_delta_micro_usdc) as SignedMicroUsdc,
  markupDeltaMicroUsdc: safeNumber(row.markup_delta_micro_usdc) as SignedMicroUsdc,
  totalDeltaMicroUsdc: safeNumber(row.total_delta_micro_usdc) as SignedMicroUsdc,
});

const attemptColumns = `workspace_id::text AS workspace_id, settlement_id, thread_id, state,
  trigger_kind, wallet_id, authorization_id, wallet_address, treasury_address,
  first_pricing_sequence::text, last_pricing_sequence::text,
  upstream_delta_micro_usdc::text, markup_delta_micro_usdc::text,
  total_delta_micro_usdc::text, request_fingerprint, provider_activity_ref, tx_hash,
  CASE WHEN transfer_submitted_at IS NULL THEN NULL ELSE
    to_char(transfer_submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  END AS transfer_submitted_at,
  failure_code, processing_owner,
  CASE WHEN processing_lease_expires_at IS NULL THEN NULL ELSE
    to_char(processing_lease_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  END AS processing_lease_expires_at,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at,
  CASE WHEN finalized_at IS NULL THEN NULL ELSE
    to_char(finalized_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  END AS finalized_at`;

const postingColumns = `item.accrual_id, item.sample_id, item.environment_id, item.sandbox_id,
  item.evidence_id, item.evidence_revision, item.evidence_payload_sha256,
  item.receipt_input_sha256, item.pricing_sequence::text,
  to_char(item.interval_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS interval_start,
  to_char(item.interval_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS interval_end,
  item.upstream_delta_micro_usdc::text, item.markup_delta_micro_usdc::text,
  item.total_delta_micro_usdc::text`;

const transaction = async <A>(pool: Pool, use: (client: PoolClient) => Promise<A>) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await use(client);
    await client.query("COMMIT");
    return result;
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (cause instanceof UsageSettlementRepositoryError) throw cause;
    throw new UsageSettlementRepositoryError(
      "databaseFailure",
      "usage settlement transaction failed",
      cause,
    );
  } finally {
    client.release();
  }
};

const loadAttempt = async (
  client: Pool | PoolClient,
  workspaceId: WorkspaceId,
  settlementId: SettlementId,
) => {
  const attemptResult = await client.query<AttemptRow>(
    `SELECT ${attemptColumns} FROM cloud_usage_settlement_attempt
      WHERE workspace_id = $1 AND settlement_id = $2`,
    [workspaceId, settlementId],
  );
  const row = attemptResult.rows[0];
  if (row === undefined) return undefined;
  const [postingResult, receiptResult] = await Promise.all([
    client.query<PostingRow>(
      `SELECT ${postingColumns} FROM cloud_usage_settlement_item item
        WHERE workspace_id = $1 AND settlement_id = $2 ORDER BY position`,
      [workspaceId, settlementId],
    ),
    client.query<ReceiptRow>(
      `SELECT payload, payload_sha256, signature_algorithm, signature_key_id,
              signature,
              to_char(signed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS signed_at
         FROM cloud_usage_settlement_receipt
        WHERE workspace_id = $1 AND settlement_id = $2`,
      [workspaceId, settlementId],
    ),
  ]);
  const receiptRow = receiptResult.rows[0];
  const receipt =
    receiptRow === undefined
      ? undefined
      : decodeReceipt({
          payload: receiptRow.payload,
          payloadSha256: receiptRow.payload_sha256,
          signature: {
            algorithm: receiptRow.signature_algorithm,
            keyId: receiptRow.signature_key_id,
            payloadHash: receiptRow.payload_sha256,
            signature: receiptRow.signature,
            signedAt: receiptRow.signed_at,
          },
        });
  if (receipt !== undefined && receiptPayloadHash(receipt.payload) !== receipt.payloadSha256) {
    throw new UsageSettlementRepositoryError(
      "databaseFailure",
      "stored settlement receipt payload hash does not match",
    );
  }
  return {
    settlementId: row.settlement_id as SettlementId,
    workspaceId: row.workspace_id as WorkspaceId,
    threadId: row.thread_id as ThreadId,
    state: row.state,
    trigger: row.trigger_kind,
    walletId: row.wallet_id as WalletId,
    authorizationId: row.authorization_id as WalletDelegatedAuthorizationId,
    walletAddress: row.wallet_address as EvmAddress,
    treasuryAddress: row.treasury_address as EvmAddress,
    firstPricingSequence: safeNumber(row.first_pricing_sequence),
    lastPricingSequence: safeNumber(row.last_pricing_sequence),
    upstreamDeltaMicroUsdc: safeNumber(row.upstream_delta_micro_usdc) as SignedMicroUsdc,
    markupDeltaMicroUsdc: safeNumber(row.markup_delta_micro_usdc) as SignedMicroUsdc,
    totalDeltaMicroUsdc: safeNumber(row.total_delta_micro_usdc),
    requestFingerprint: row.request_fingerprint,
    postings: postingResult.rows.map(postingFromRow),
    ...(row.provider_activity_ref === null
      ? {}
      : { providerActivityRef: row.provider_activity_ref }),
    ...(row.tx_hash === null ? {} : { txHash: row.tx_hash as EvmTransactionHash }),
    ...(row.transfer_submitted_at === null
      ? {}
      : { transferSubmittedAt: row.transfer_submitted_at }),
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
    ...(row.processing_owner === null ? {} : { processingOwner: row.processing_owner }),
    ...(row.processing_lease_expires_at === null
      ? {}
      : { processingLeaseExpiresAt: row.processing_lease_expires_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.finalized_at === null ? {} : { finalizedAt: row.finalized_at }),
    ...(receipt === undefined ? {} : { receipt }),
  } satisfies UsageSettlementAttempt;
};

const requireAttempt = async (
  client: Pool | PoolClient,
  workspaceId: WorkspaceId,
  settlementId: SettlementId,
) => {
  const attempt = await loadAttempt(client, workspaceId, settlementId);
  if (attempt === undefined) {
    throw new UsageSettlementRepositoryError("notFound", "settlement attempt was not found");
  }
  return attempt;
};

const updateOwned = async (
  client: PoolClient,
  attempt: UsageSettlementAttempt,
  processorId: string,
  sql: string,
  parameters: ReadonlyArray<unknown>,
  allowedStates: ReadonlyArray<UsageSettlementAttemptState>,
) => {
  const stateParameter = 4 + parameters.length;
  const result = await client.query(
    `${sql} WHERE workspace_id = $1 AND settlement_id = $2 AND processing_owner = $3
       AND state = ANY($${stateParameter}::text[])`,
    [attempt.workspaceId, attempt.settlementId, processorId, ...parameters, allowedStates],
  );
  if (result.rowCount !== 1) {
    throw new UsageSettlementRepositoryError("conflict", "settlement processing lease changed");
  }
  return requireAttempt(client, attempt.workspaceId, attempt.settlementId);
};

const candidatePostings = async (
  client: PoolClient,
  workspaceId: WorkspaceId,
  threadId: ThreadId,
) => {
  const result = await client.query<PostingRow>(
    `SELECT ledger.accrual_id, ledger.sample_id, ledger.environment_id, ledger.sandbox_id,
            sample.evidence_id, sample.evidence_revision, sample.evidence_payload_sha256,
            ledger.receipt_input_sha256, ledger.pricing_sequence::text,
            to_char(sample.interval_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS interval_start,
            to_char(sample.interval_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS interval_end,
            ledger.upstream_delta_micro_usdc::text, ledger.markup_delta_micro_usdc::text,
            ledger.total_delta_micro_usdc::text
       FROM cloud_usage_ledger_entry ledger
       JOIN cloud_usage_sample sample
         ON sample.workspace_id = ledger.workspace_id AND sample.sample_id = ledger.sample_id
       LEFT JOIN cloud_usage_settlement_item item
         ON item.workspace_id = ledger.workspace_id AND item.accrual_id = ledger.accrual_id
      WHERE ledger.workspace_id = $1 AND ledger.thread_id = $2 AND item.accrual_id IS NULL
      ORDER BY ledger.pricing_sequence
      FOR UPDATE OF ledger`,
    [workspaceId, threadId],
  );
  return result.rows.map(postingFromRow);
};

const choosePrefix = (
  postings: ReadonlyArray<UsageSettlementAccrualPosting>,
  perChargeLimit: number,
) => {
  let running = 0;
  let selectedLength = 0;
  for (const [index, posting] of postings.entries()) {
    running = safeSum([running, posting.totalDeltaMicroUsdc]);
    if (running > 0 && running <= perChargeLimit) selectedLength = index + 1;
  }
  return postings.slice(0, selectedLength);
};

const insertAttempt = async (
  client: PoolClient,
  request: UsageSettlementClaimRequest,
  candidate: CandidateRow,
) => {
  const authorizationResult = await client.query<AuthorizationRow>(
    `SELECT wallet.wallet_id, authz.authorization_id,
            wallet.evm_address AS wallet_address, authz.treasury_address,
            authz.per_charge_limit_micro_usdc::text
       FROM cloud_wallet wallet
       JOIN cloud_wallet_delegated_authorization authz
         ON authz.workspace_id = wallet.workspace_id
        AND authz.wallet_id = wallet.wallet_id
      WHERE wallet.workspace_id = $1 AND wallet.state = 'active'
        AND authz.state = 'active'
        AND authz.starts_at <= $2::timestamptz
        AND authz.expires_at > $2::timestamptz
      ORDER BY wallet.wallet_id, authz.authorization_id
      LIMIT 1 FOR SHARE`,
    [candidate.workspace_id, request.now],
  );
  const authorization = authorizationResult.rows[0];
  if (authorization === undefined) return undefined;

  const available = await candidatePostings(
    client,
    candidate.workspace_id as WorkspaceId,
    candidate.thread_id as ThreadId,
  );
  const postings = choosePrefix(available, safeNumber(authorization.per_charge_limit_micro_usdc));
  if (postings.length === 0) return undefined;
  const upstream = safeSum(postings.map((posting) => posting.upstreamDeltaMicroUsdc));
  const markup = safeSum(postings.map((posting) => posting.markupDeltaMicroUsdc));
  const total = safeSum(postings.map((posting) => posting.totalDeltaMicroUsdc));
  if (total <= 0 || total !== upstream + markup) return undefined;
  const first = postings[0]!;
  const last = postings[postings.length - 1]!;
  const identity = {
    workspaceId: candidate.workspace_id,
    threadId: candidate.thread_id,
    firstPricingSequence: first.pricingSequence,
    lastPricingSequence: last.pricingSequence,
    accruals: postings.map((posting) => ({
      accrualId: posting.accrualId,
      receiptInputSha256: posting.receiptInputSha256,
      totalDeltaMicroUsdc: posting.totalDeltaMicroUsdc,
    })),
    upstreamDeltaMicroUsdc: upstream,
    markupDeltaMicroUsdc: markup,
    totalDeltaMicroUsdc: total,
  };
  const requestFingerprint = digest("agents-in-cloud/usage-settlement-request/v1", identity);
  const settlementId = `settlement-${digest(
    "agents-in-cloud/usage-settlement-id/v1",
    identity,
  ).slice(0, 48)}` as SettlementId;
  const trigger =
    request.trigger ??
    (Math.abs(total) >= SETTLEMENT_AMOUNT_THRESHOLD_MICRO_USDC
      ? "amount-threshold"
      : "five-minute-window");
  await client.query(
    `INSERT INTO cloud_usage_settlement_attempt (
       workspace_id, settlement_id, thread_id, state, trigger_kind,
       wallet_id, authorization_id, wallet_address, treasury_address,
       first_pricing_sequence, last_pricing_sequence, accrual_count,
       upstream_delta_micro_usdc, markup_delta_micro_usdc, total_delta_micro_usdc,
       request_fingerprint, processing_owner, processing_lease_expires_at,
       created_at, updated_at
     ) VALUES ($1,$2,$3,'reserved',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)
     `,
    [
      candidate.workspace_id,
      settlementId,
      candidate.thread_id,
      trigger,
      authorization.wallet_id,
      authorization.authorization_id,
      authorization.wallet_address,
      authorization.treasury_address,
      first.pricingSequence,
      last.pricingSequence,
      postings.length,
      upstream,
      markup,
      total,
      requestFingerprint,
      request.processorId,
      request.leaseExpiresAt,
      request.now,
    ],
  );
  for (const [position, posting] of postings.entries()) {
    await client.query(
      `INSERT INTO cloud_usage_settlement_item (
         workspace_id, settlement_id, thread_id, position, accrual_id, sample_id,
         environment_id, sandbox_id, evidence_id, evidence_revision,
         evidence_payload_sha256, receipt_input_sha256, pricing_sequence,
         interval_start, interval_end, upstream_delta_micro_usdc,
         markup_delta_micro_usdc, total_delta_micro_usdc
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        candidate.workspace_id,
        settlementId,
        candidate.thread_id,
        position,
        posting.accrualId,
        posting.sampleId,
        posting.environmentId,
        posting.sandboxId,
        posting.evidenceId,
        posting.evidenceRevision,
        posting.evidencePayloadSha256,
        posting.receiptInputSha256,
        posting.pricingSequence,
        posting.intervalStart,
        posting.intervalEnd,
        posting.upstreamDeltaMicroUsdc,
        posting.markupDeltaMicroUsdc,
        posting.totalDeltaMicroUsdc,
      ],
    );
  }
  return requireAttempt(client, candidate.workspace_id as WorkspaceId, settlementId);
};

export const makePostgresUsageSettlementRepository = (pool: Pool): UsageSettlementRepository => ({
  claimReady: (request) =>
    transaction(pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "agents-in-cloud/usage-settlement-claim/v1",
      ]);
      const cutoff = DateTime.formatIso(
        DateTime.subtract(DateTime.makeUnsafe(request.now), {
          milliseconds: SETTLEMENT_INTERVAL_MS,
        }),
      );
      const targeted = request.trigger !== undefined;
      if (targeted && (request.workspaceId === undefined || request.threadId === undefined)) {
        throw new UsageSettlementRepositoryError(
          "conflict",
          "lifecycle settlement requires an exact workspace and thread",
        );
      }
      const candidates = await client.query<CandidateRow>(
        `SELECT ledger.workspace_id::text AS workspace_id, ledger.thread_id,
                min(ledger.recorded_at)::text AS oldest_recorded_at,
                sum(ledger.total_delta_micro_usdc)::text AS total_delta_micro_usdc
           FROM cloud_usage_ledger_entry ledger
           LEFT JOIN cloud_usage_settlement_item item
             ON item.workspace_id = ledger.workspace_id AND item.accrual_id = ledger.accrual_id
          WHERE item.accrual_id IS NULL
            AND ($1::uuid IS NULL OR ledger.workspace_id = $1)
            AND ($2::text IS NULL OR ledger.thread_id = $2)
          GROUP BY ledger.workspace_id, ledger.thread_id
         HAVING sum(ledger.total_delta_micro_usdc) > 0
            AND ($3::boolean OR min(ledger.recorded_at) <= $4::timestamptz
                 OR abs(sum(ledger.total_delta_micro_usdc)) >= $5)
          ORDER BY min(ledger.recorded_at), ledger.workspace_id, ledger.thread_id
          LIMIT $6`,
        [
          request.workspaceId ?? null,
          request.threadId ?? null,
          targeted,
          cutoff,
          SETTLEMENT_AMOUNT_THRESHOLD_MICRO_USDC,
          request.limit,
        ],
      );
      const attempts: Array<UsageSettlementAttempt> = [];
      for (const candidate of candidates.rows) {
        const attempt = await insertAttempt(client, request, candidate);
        if (attempt !== undefined) attempts.push(attempt);
      }
      return attempts;
    }),
  claimRecoverable: (processorId, now, leaseExpiresAt, limit) =>
    transaction(pool, async (client) => {
      const rows = await client.query<{
        readonly workspace_id: string;
        readonly settlement_id: string;
      }>(
        `WITH candidates AS (
           SELECT workspace_id, settlement_id
             FROM cloud_usage_settlement_attempt
            WHERE state IN (
              'reserved', 'submission-pending', 'reconciliation-required',
              'transfer-applied', 'low-balance-pause-pending'
            )
              AND (processing_owner IS NULL OR processing_lease_expires_at <= $1::timestamptz)
            ORDER BY created_at, workspace_id, settlement_id
            LIMIT $2 FOR UPDATE SKIP LOCKED
         )
         UPDATE cloud_usage_settlement_attempt attempt
            SET processing_owner = $3, processing_lease_expires_at = $4::timestamptz,
                updated_at = $1::timestamptz
           FROM candidates
          WHERE attempt.workspace_id = candidates.workspace_id
            AND attempt.settlement_id = candidates.settlement_id
         RETURNING attempt.workspace_id::text, attempt.settlement_id`,
        [now, limit, processorId, leaseExpiresAt],
      );
      return Promise.all(
        rows.rows.map((row) =>
          requireAttempt(
            client,
            row.workspace_id as WorkspaceId,
            row.settlement_id as SettlementId,
          ),
        ),
      );
    }),
  claimLowBalance: (workspaceId, settlementId, processorId, now, leaseExpiresAt) =>
    transaction(pool, async (client) => {
      const result = await client.query(
        `UPDATE cloud_usage_settlement_attempt
            SET processing_owner = $3, processing_lease_expires_at = $4::timestamptz,
                updated_at = $5::timestamptz
          WHERE workspace_id = $1 AND settlement_id = $2
            AND state = 'low-balance-paused' AND processing_owner IS NULL`,
        [workspaceId, settlementId, processorId, leaseExpiresAt, now],
      );
      if (result.rowCount !== 1) {
        throw new UsageSettlementRepositoryError(
          "conflict",
          "low-balance settlement is not ready for an explicit funding retry",
        );
      }
      return requireAttempt(client, workspaceId, settlementId);
    }),
  get: (workspaceId, settlementId) => loadAttempt(pool, workspaceId, settlementId),
  setSubmissionPending: (attempt, processorId, now) =>
    transaction(pool, (client) =>
      updateOwned(
        client,
        attempt,
        processorId,
        `UPDATE cloud_usage_settlement_attempt
            SET state = 'submission-pending', failure_code = NULL, updated_at = $4::timestamptz`,
        [now],
        ["reserved", "low-balance-paused"],
      ),
    ),
  recordTransfer: (attempt, processorId, transfer, now) =>
    transaction(pool, (client) =>
      updateOwned(
        client,
        attempt,
        processorId,
        `UPDATE cloud_usage_settlement_attempt
            SET state = 'transfer-applied', provider_activity_ref = $4,
                tx_hash = $5, transfer_submitted_at = $6::timestamptz,
                failure_code = NULL, updated_at = $7::timestamptz`,
        [transfer.providerActivityRef, transfer.txHash, transfer.submittedAt, now],
        ["submission-pending", "reconciliation-required"],
      ),
    ),
  markReconciliationRequired: (attempt, processorId, providerActivityRef, failureCode, now) =>
    transaction(pool, (client) =>
      updateOwned(
        client,
        attempt,
        processorId,
        `UPDATE cloud_usage_settlement_attempt
            SET state = 'reconciliation-required', provider_activity_ref = COALESCE($4, provider_activity_ref),
                failure_code = $5, processing_owner = NULL,
                processing_lease_expires_at = NULL, updated_at = $6::timestamptz`,
        [providerActivityRef ?? null, failureCode, now],
        ["submission-pending", "reconciliation-required"],
      ),
    ),
  markLowBalancePausePending: (attempt, processorId, failureCode, now) =>
    transaction(pool, (client) =>
      updateOwned(
        client,
        attempt,
        processorId,
        `UPDATE cloud_usage_settlement_attempt
            SET state = 'low-balance-pause-pending', failure_code = $4,
                updated_at = $5::timestamptz`,
        [failureCode, now],
        ["submission-pending", "reconciliation-required"],
      ),
    ),
  markLowBalancePaused: (attempt, processorId, now) =>
    transaction(pool, (client) =>
      updateOwned(
        client,
        attempt,
        processorId,
        `UPDATE cloud_usage_settlement_attempt
            SET state = 'low-balance-paused', processing_owner = NULL,
                processing_lease_expires_at = NULL, updated_at = $4::timestamptz`,
        [now],
        ["low-balance-pause-pending"],
      ),
    ),
  finalize: (attempt, processorId, receipt, now) =>
    transaction(pool, async (client) => {
      const current = await requireAttempt(client, attempt.workspaceId, attempt.settlementId);
      const verifiedReceipt = decodeReceipt(receipt);
      if (
        current.state !== "transfer-applied" ||
        current.processingOwner !== processorId ||
        current.txHash === undefined ||
        current.transferSubmittedAt === undefined ||
        verifiedReceipt.payloadSha256 !== receiptPayloadHash(verifiedReceipt.payload) ||
        verifiedReceipt.payload.settlementId !== current.settlementId ||
        verifiedReceipt.payload.workspaceId !== current.workspaceId ||
        verifiedReceipt.payload.threadId !== current.threadId ||
        verifiedReceipt.payload.txHash !== current.txHash ||
        verifiedReceipt.payload.createdAt !== current.createdAt ||
        verifiedReceipt.payload.submittedAt !== current.transferSubmittedAt ||
        verifiedReceipt.payload.upstreamMicroUsdc !== current.upstreamDeltaMicroUsdc ||
        verifiedReceipt.payload.markupMicroUsdc !== current.markupDeltaMicroUsdc ||
        verifiedReceipt.payload.totalMicroUsdc !== current.totalDeltaMicroUsdc ||
        verifiedReceipt.signature.signedAt < current.transferSubmittedAt ||
        canonical(verifiedReceipt.payload.postings) !== canonical(current.postings)
      ) {
        throw new UsageSettlementRepositoryError(
          "conflict",
          "receipt does not match the immutable settlement and transfer",
        );
      }
      await client.query(
        `INSERT INTO cloud_usage_settlement_receipt (
           workspace_id, settlement_id, thread_id, payload, payload_sha256,
           signature_algorithm, signature_key_id, signature, signed_at, tx_hash, created_at
         ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9::timestamptz,$10,$11::timestamptz)`,
        [
          current.workspaceId,
          current.settlementId,
          current.threadId,
          JSON.stringify(verifiedReceipt.payload),
          verifiedReceipt.payloadSha256,
          verifiedReceipt.signature.algorithm,
          verifiedReceipt.signature.keyId,
          verifiedReceipt.signature.signature,
          verifiedReceipt.signature.signedAt,
          verifiedReceipt.payload.txHash,
          now,
        ],
      );
      return updateOwned(
        client,
        current,
        processorId,
        `UPDATE cloud_usage_settlement_attempt
            SET state = 'finalized', failure_code = NULL, processing_owner = NULL,
                processing_lease_expires_at = NULL, finalized_at = $4::timestamptz,
                updated_at = $4::timestamptz`,
        [now],
        ["transfer-applied"],
      );
    }),
  releaseLease: (attempt, processorId, failureCode, now) =>
    transaction(pool, async (client) => {
      const result = await client.query(
        `UPDATE cloud_usage_settlement_attempt
            SET processing_owner = NULL, processing_lease_expires_at = NULL,
                failure_code = $4, updated_at = $5::timestamptz
          WHERE workspace_id = $1 AND settlement_id = $2 AND processing_owner = $3
            AND state <> 'finalized'`,
        [attempt.workspaceId, attempt.settlementId, processorId, failureCode, now],
      );
      if (result.rowCount !== 1) {
        throw new UsageSettlementRepositoryError("conflict", "settlement processing lease changed");
      }
    }),
});
