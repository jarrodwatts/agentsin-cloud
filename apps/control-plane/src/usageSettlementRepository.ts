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
export const SETTLEMENT_RETRY_BASE_MS = 5_000;
export const SETTLEMENT_RETRY_MAX_MS = 5 * 60_000;

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
  readonly authorizationGeneration: number;
  readonly walletAddress: EvmAddress;
  readonly treasuryAddress: EvmAddress;
  readonly firstPricingSequence: number;
  readonly lastPricingSequence: number;
  readonly upstreamDeltaMicroUsdc: SignedMicroUsdc;
  readonly markupDeltaMicroUsdc: SignedMicroUsdc;
  readonly totalDeltaMicroUsdc: number;
  readonly requestFingerprint: string;
  readonly providerAttemptGeneration: number;
  readonly providerIdempotencyKey: string;
  readonly postings: ReadonlyArray<UsageSettlementAccrualPosting>;
  readonly providerActivityRef?: string;
  readonly nextSubmitNotBefore?: string;
  readonly txHash?: EvmTransactionHash;
  readonly transferSubmittedAt?: string;
  readonly failureCode?: string;
  readonly processingOwner?: string;
  readonly processingLeaseExpiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finalizedAt?: string;
  readonly receipt?: UsageSettlementReceipt;
  readonly billingFenceId?: string;
  readonly workspaceRecoveryFenceId?: string;
  readonly workspaceRecoveryAuthorizedAt?: string;
}

export interface UsageBillingFence {
  readonly fenceId: string;
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly workspaceFenceId?: string;
  readonly settlementId?: SettlementId;
  readonly reason:
    | "insufficient-balance"
    | "authorization-unavailable"
    | "provider-definitive-failure"
    | "provider-outcome-uncertain";
  readonly state: "pause-pending" | "paused" | "cleared";
  readonly processingOwner?: string;
  readonly processingLeaseExpiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pausedAt?: string;
  readonly clearedAt?: string;
}

export interface UsageSettlementClaimRequest {
  readonly processorId: string;
  readonly now: string;
  readonly leaseExpiresAt: string;
  readonly limit: number;
  readonly trigger?: "sandbox-paused" | "sandbox-closed";
  readonly workspaceId?: WorkspaceId;
  readonly threadId?: ThreadId;
  readonly recoverAuthorizationFence?: boolean;
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
  readonly markFinalizationRequired: (
    attempt: UsageSettlementAttempt,
    processorId: string,
    failureCode: string,
    now: string,
  ) => Promise<UsageSettlementAttempt>;
  readonly closeProviderAttemptNotApplied: (
    attempt: UsageSettlementAttempt,
    processorId: string,
    providerActivityRef: string | undefined,
    failureCode: string,
    now: string,
    nextSubmitNotBefore: string,
  ) => Promise<UsageSettlementAttempt>;
  readonly markLowBalancePausePending: (
    attempt: UsageSettlementAttempt,
    processorId: string,
    providerActivityRef: string | undefined,
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
  readonly claimPendingBillingFences: (
    processorId: string,
    now: string,
    leaseExpiresAt: string,
    limit: number,
  ) => Promise<ReadonlyArray<UsageBillingFence>>;
  readonly markBillingFencePaused: (
    fence: UsageBillingFence,
    processorId: string,
    pausedAt: string,
  ) => Promise<UsageBillingFence>;
  readonly claimProviderFailureRetry: (
    workspaceId: WorkspaceId,
    settlementId: SettlementId,
    processorId: string,
    now: string,
    leaseExpiresAt: string,
  ) => Promise<UsageSettlementAttempt>;
  readonly claimAuthorizationRecovery: (
    workspaceId: WorkspaceId,
    threadId: ThreadId,
    processorId: string,
    now: string,
    leaseExpiresAt: string,
  ) => Promise<UsageSettlementAttempt | undefined>;
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
  readonly authorization_generation: number;
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
  readonly authorization_generation: number;
  readonly wallet_address: string;
  readonly treasury_address: string;
  readonly first_pricing_sequence: string;
  readonly last_pricing_sequence: string;
  readonly upstream_delta_micro_usdc: string;
  readonly markup_delta_micro_usdc: string;
  readonly total_delta_micro_usdc: string;
  readonly request_fingerprint: string;
  readonly provider_attempt_generation: number;
  readonly next_submit_not_before: string | null;
  readonly tx_hash: string | null;
  readonly transfer_submitted_at: string | null;
  readonly failure_code: string | null;
  readonly processing_owner: string | null;
  readonly processing_lease_expires_at: string | null;
  readonly workspace_recovery_fence_id: string | null;
  readonly workspace_recovery_authorized_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly finalized_at: string | null;
}

interface ProviderAttemptRow extends QueryResultRow {
  readonly generation: number;
  readonly idempotency_key: string;
  readonly provider_activity_ref: string | null;
}

interface ReceiptRow extends QueryResultRow {
  readonly payload: unknown;
  readonly payload_sha256: string;
  readonly signature_algorithm: string;
  readonly signature_key_id: string;
  readonly signature: string;
  readonly signed_at: string;
}

interface BillingFenceRow extends QueryResultRow {
  readonly workspace_id: string;
  readonly thread_id: string;
  readonly fence_id: string;
  readonly workspace_fence_id: string | null;
  readonly settlement_id: string | null;
  readonly reason: UsageBillingFence["reason"];
  readonly state: UsageBillingFence["state"];
  readonly processing_owner: string | null;
  readonly processing_lease_expires_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly paused_at: string | null;
  readonly cleared_at: string | null;
}

const authorizationIsActive = async (
  client: PoolClient,
  attempt: UsageSettlementAttempt,
  now: string,
) => {
  const result = await client.query(
    `SELECT 1
       FROM cloud_wallet wallet
       JOIN cloud_wallet_delegated_authorization authz
         ON authz.workspace_id = wallet.workspace_id AND authz.wallet_id = wallet.wallet_id
      WHERE wallet.workspace_id = $1 AND wallet.wallet_id = $2 AND wallet.state = 'active'
        AND authz.authorization_id = $3 AND authz.state = 'active'
        AND authz.starts_at <= $4::timestamptz AND authz.expires_at > $4::timestamptz
      FOR SHARE OF wallet, authz`,
    [attempt.workspaceId, attempt.walletId, attempt.authorizationId, now],
  );
  return result.rowCount === 1;
};

const rebindAuthorizationIfNeeded = async (
  client: PoolClient,
  attempt: UsageSettlementAttempt,
  now: string,
) => {
  if (await authorizationIsActive(client, attempt, now)) return attempt;
  if (
    !(["reserved", "retry-waiting", "low-balance-paused"] as const).includes(attempt.state as never)
  ) {
    return attempt;
  }
  const replacement = await client.query<AuthorizationRow>(
    `SELECT wallet.wallet_id, authz.authorization_id,
            wallet.evm_address AS wallet_address, authz.treasury_address,
            authz.per_charge_limit_micro_usdc::text
       FROM cloud_wallet wallet
       JOIN cloud_wallet_delegated_authorization authz
         ON authz.workspace_id = wallet.workspace_id AND authz.wallet_id = wallet.wallet_id
      WHERE wallet.workspace_id = $1 AND wallet.state = 'active'
        AND authz.state = 'active'
        AND authz.starts_at <= $2::timestamptz AND authz.expires_at > $2::timestamptz
        AND authz.treasury_address = $3
        AND authz.per_charge_limit_micro_usdc >= $4
      ORDER BY wallet.wallet_id, authz.authorization_id
      LIMIT 1 FOR SHARE`,
    [attempt.workspaceId, now, attempt.treasuryAddress, attempt.totalDeltaMicroUsdc],
  );
  const authorization = replacement.rows[0];
  if (authorization === undefined) {
    throw new UsageSettlementRepositoryError(
      "configurationMissing",
      "no active delegated authorization can cover the settlement",
    );
  }
  const nextGeneration = attempt.authorizationGeneration + 1;
  await client.query(
    `INSERT INTO cloud_usage_settlement_authorization_binding (
       workspace_id, settlement_id, generation, wallet_id, authorization_id,
       wallet_address, treasury_address, bound_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz)`,
    [
      attempt.workspaceId,
      attempt.settlementId,
      nextGeneration,
      authorization.wallet_id,
      authorization.authorization_id,
      authorization.wallet_address,
      authorization.treasury_address,
      now,
    ],
  );
  const updated = await client.query(
    `UPDATE cloud_usage_settlement_attempt
        SET wallet_id = $3, authorization_id = $4, wallet_address = $5,
            authorization_generation = $6, updated_at = $7::timestamptz
      WHERE workspace_id = $1 AND settlement_id = $2
        AND authorization_generation = $8
        AND state IN ('reserved', 'retry-waiting', 'low-balance-paused')`,
    [
      attempt.workspaceId,
      attempt.settlementId,
      authorization.wallet_id,
      authorization.authorization_id,
      authorization.wallet_address,
      nextGeneration,
      now,
      attempt.authorizationGeneration,
    ],
  );
  if (updated.rowCount !== 1) {
    throw new UsageSettlementRepositoryError("conflict", "settlement authorization changed");
  }
  return requireAttempt(client, attempt.workspaceId, attempt.settlementId);
};

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

const providerIdempotencyKey = (requestFingerprint: string, generation: number) =>
  digest("agents-in-cloud/usage-settlement-provider-attempt/v1", {
    requestFingerprint,
    generation,
  });

const lockProviderIdentity = (
  client: PoolClient,
  domain: "activity" | "transaction",
  identity: string,
) =>
  client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
    `agents-in-cloud/usage-settlement-${domain}/v1`,
    identity.toLowerCase(),
  ]);

const providerActivityIsReused = async (
  client: PoolClient,
  attempt: UsageSettlementAttempt,
  providerActivityRef: string,
) => {
  await lockProviderIdentity(client, "activity", providerActivityRef);
  const reused = await client.query(
    `SELECT 1 FROM cloud_usage_settlement_provider_attempt
      WHERE provider_activity_ref = $1
        AND NOT (workspace_id = $2 AND settlement_id = $3 AND generation = $4)
      LIMIT 1 FOR SHARE`,
    [
      providerActivityRef,
      attempt.workspaceId,
      attempt.settlementId,
      attempt.providerAttemptGeneration,
    ],
  );
  return reused.rowCount === 1;
};

export const settlementRetryNotBefore = (now: string, generation: number) => {
  const delay = Math.min(
    SETTLEMENT_RETRY_MAX_MS,
    SETTLEMENT_RETRY_BASE_MS * 2 ** Math.min(generation - 1, 16),
  );
  return DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(now), { milliseconds: delay }));
};

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
  trigger_kind, wallet_id, authorization_id, authorization_generation,
  wallet_address, treasury_address,
  first_pricing_sequence::text, last_pricing_sequence::text,
  upstream_delta_micro_usdc::text, markup_delta_micro_usdc::text,
  total_delta_micro_usdc::text, request_fingerprint, provider_attempt_generation, tx_hash,
  CASE WHEN next_submit_not_before IS NULL THEN NULL ELSE
    to_char(next_submit_not_before AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  END AS next_submit_not_before,
  CASE WHEN transfer_submitted_at IS NULL THEN NULL ELSE
    to_char(transfer_submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  END AS transfer_submitted_at,
  failure_code, processing_owner,
  CASE WHEN processing_lease_expires_at IS NULL THEN NULL ELSE
    to_char(processing_lease_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  END AS processing_lease_expires_at,
  workspace_recovery_fence_id,
  CASE WHEN workspace_recovery_authorized_at IS NULL THEN NULL ELSE
    to_char(workspace_recovery_authorized_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  END AS workspace_recovery_authorized_at,
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

const billingFenceColumns = `fence.workspace_id::text, fence.thread_id, fence.fence_id,
  fence.workspace_fence_id, fence.settlement_id, fence.reason, fence.state, fence.processing_owner,
  CASE WHEN fence.processing_lease_expires_at IS NULL THEN NULL ELSE
    to_char(fence.processing_lease_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  END AS processing_lease_expires_at,
  to_char(fence.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
  to_char(fence.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at,
  CASE WHEN fence.paused_at IS NULL THEN NULL ELSE
    to_char(fence.paused_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  END AS paused_at,
  CASE WHEN fence.cleared_at IS NULL THEN NULL ELSE
    to_char(fence.cleared_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  END AS cleared_at`;

const billingFenceFromRow = (row: BillingFenceRow): UsageBillingFence => ({
  fenceId: row.fence_id,
  workspaceId: row.workspace_id as WorkspaceId,
  threadId: row.thread_id as ThreadId,
  ...(row.workspace_fence_id === null ? {} : { workspaceFenceId: row.workspace_fence_id }),
  ...(row.settlement_id === null ? {} : { settlementId: row.settlement_id as SettlementId }),
  reason: row.reason,
  state: row.state,
  ...(row.processing_owner === null ? {} : { processingOwner: row.processing_owner }),
  ...(row.processing_lease_expires_at === null
    ? {}
    : { processingLeaseExpiresAt: row.processing_lease_expires_at }),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.paused_at === null ? {} : { pausedAt: row.paused_at }),
  ...(row.cleared_at === null ? {} : { clearedAt: row.cleared_at }),
});

interface BillingFenceInput {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly settlementId?: SettlementId;
  readonly reason: UsageBillingFence["reason"];
  readonly processorId: string;
  readonly leaseExpiresAt: string;
  readonly now: string;
  /** Only trusted wallet-policy classifications may widen a provider failure to the workspace. */
  readonly workspaceWide?: boolean;
}

interface WorkspaceBillingFenceRow extends QueryResultRow {
  readonly fence_id: string;
  readonly source_thread_id: string;
  readonly settlement_id: string | null;
  readonly reason: Exclude<UsageBillingFence["reason"], "provider-outcome-uncertain">;
}

const lockWorkspaceBillingGate = (client: PoolClient, workspaceId: WorkspaceId) =>
  client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
    "agents-in-cloud/workspace-billing-gate/v1",
    workspaceId,
  ]);

const ensureThreadBillingFence = async (
  client: PoolClient,
  input: BillingFenceInput & {
    readonly workspaceFenceId?: string;
  },
) => {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
    "agents-in-cloud/usage-billing-fence/v1",
    `${input.workspaceId}:${input.threadId}`,
  ]);
  type ActiveFence = {
    readonly fence_id: string;
    readonly episode: number;
    readonly settlement_id: string | null;
    readonly recovery_settlement_id: string | null;
    readonly reason: UsageBillingFence["reason"];
  };
  const active =
    input.workspaceFenceId !== undefined
      ? await client.query<ActiveFence>(
          `SELECT fence_id, episode, settlement_id, recovery_settlement_id, reason
             FROM cloud_usage_billing_fence
            WHERE workspace_id = $1 AND thread_id = $2 AND workspace_fence_id = $3
              AND state <> 'cleared' FOR UPDATE`,
          [input.workspaceId, input.threadId, input.workspaceFenceId],
        )
      : input.settlementId !== undefined
        ? await client.query<ActiveFence>(
            `SELECT fence_id, episode, settlement_id, recovery_settlement_id, reason
               FROM cloud_usage_billing_fence
              WHERE workspace_id = $1 AND thread_id = $2 AND workspace_fence_id IS NULL
                AND (settlement_id = $3 OR recovery_settlement_id = $3)
                AND state <> 'cleared' FOR UPDATE`,
            [input.workspaceId, input.threadId, input.settlementId],
          )
        : await client.query<ActiveFence>(
            `SELECT fence_id, episode, settlement_id, recovery_settlement_id, reason
               FROM cloud_usage_billing_fence
              WHERE workspace_id = $1 AND thread_id = $2 AND workspace_fence_id IS NULL
                AND settlement_id IS NULL AND recovery_settlement_id IS NULL
                AND state <> 'cleared' FOR UPDATE`,
            [input.workspaceId, input.threadId],
          );
  const existing = active.rows[0];
  const episode =
    existing?.episode ??
    Number(
      (
        await client.query<{ readonly episode: string }>(
          `SELECT (COALESCE(max(episode), 0) + 1)::text AS episode
             FROM cloud_usage_billing_fence WHERE workspace_id = $1 AND thread_id = $2`,
          [input.workspaceId, input.threadId],
        )
      ).rows[0]!.episode,
    );
  const fenceId = `billing-fence-${digest("agents-in-cloud/usage-billing-fence/v1", {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    episode,
  }).slice(0, 48)}`;
  const effectiveFenceId = existing?.fence_id ?? fenceId;
  if (existing === undefined) {
    await client.query(
      `INSERT INTO cloud_usage_billing_fence (
         workspace_id, thread_id, fence_id, episode, workspace_fence_id,
         settlement_id, reason, state,
         processing_owner, processing_lease_expires_at, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'pause-pending',$8,$9::timestamptz,$10::timestamptz,$10::timestamptz)`,
      [
        input.workspaceId,
        input.threadId,
        fenceId,
        episode,
        input.workspaceFenceId ?? null,
        input.settlementId ?? null,
        input.reason,
        input.processorId,
        input.leaseExpiresAt,
        input.now,
      ],
    );
  } else {
    const boundSettlementId = existing.settlement_id ?? existing.recovery_settlement_id;
    if (
      input.settlementId !== undefined &&
      boundSettlementId !== null &&
      boundSettlementId !== input.settlementId
    ) {
      throw new UsageSettlementRepositoryError(
        "conflict",
        "active billing fence is bound to a different settlement",
      );
    }
    await client.query(
      `UPDATE cloud_usage_billing_fence
          SET reason = $4,
              recovery_settlement_id = COALESCE(recovery_settlement_id,
                CASE WHEN settlement_id IS NULL THEN $5 ELSE NULL END),
              updated_at = $6::timestamptz
        WHERE workspace_id = $1 AND thread_id = $2 AND fence_id = $3`,
      [
        input.workspaceId,
        input.threadId,
        existing.fence_id,
        input.reason,
        input.settlementId ?? null,
        input.now,
      ],
    );
  }
  await client.query(
    `INSERT INTO cloud_usage_billing_fence_event (
       workspace_id, thread_id, fence_id, sequence, reason, settlement_id, recorded_at
     ) SELECT $1,$2,$3,COALESCE(max(sequence),0)+1,$4,$5,$6::timestamptz
         FROM cloud_usage_billing_fence_event
        WHERE workspace_id = $1 AND thread_id = $2 AND fence_id = $3`,
    [
      input.workspaceId,
      input.threadId,
      effectiveFenceId,
      input.reason,
      input.settlementId ?? null,
      input.now,
    ],
  );
};

const ensureWorkspaceBillingFence = async (client: PoolClient, input: BillingFenceInput) => {
  const active = await client.query<WorkspaceBillingFenceRow>(
    `SELECT fence_id, source_thread_id, settlement_id, reason
       FROM cloud_usage_workspace_billing_fence
      WHERE workspace_id = $1 AND state = 'active' FOR UPDATE`,
    [input.workspaceId],
  );
  let workspaceFence = active.rows[0];
  if (workspaceFence === undefined) {
    const episode = Number(
      (
        await client.query<{ readonly episode: string }>(
          `SELECT (COALESCE(max(episode), 0) + 1)::text AS episode
             FROM cloud_usage_workspace_billing_fence WHERE workspace_id = $1`,
          [input.workspaceId],
        )
      ).rows[0]!.episode,
    );
    const fenceId = `workspace-billing-fence-${digest(
      "agents-in-cloud/usage-workspace-billing-fence/v1",
      { workspaceId: input.workspaceId, episode },
    ).slice(0, 48)}`;
    await client.query(
      `INSERT INTO cloud_usage_workspace_billing_fence (
         workspace_id, fence_id, episode, source_thread_id, settlement_id,
         reason, state, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'active',$7::timestamptz,$7::timestamptz)`,
      [
        input.workspaceId,
        fenceId,
        episode,
        input.threadId,
        input.settlementId ?? null,
        input.reason,
        input.now,
      ],
    );
    workspaceFence = {
      fence_id: fenceId,
      source_thread_id: input.threadId,
      settlement_id: input.settlementId ?? null,
      reason: input.reason as WorkspaceBillingFenceRow["reason"],
    };
  } else if (
    workspaceFence.source_thread_id === input.threadId &&
    workspaceFence.settlement_id === null &&
    input.settlementId !== undefined
  ) {
    await client.query(
      `UPDATE cloud_usage_workspace_billing_fence
          SET settlement_id = $3, updated_at = $4::timestamptz
        WHERE workspace_id = $1 AND fence_id = $2 AND state = 'active'`,
      [input.workspaceId, workspaceFence.fence_id, input.settlementId, input.now],
    );
    workspaceFence = { ...workspaceFence, settlement_id: input.settlementId };
  }

  const threads = await client.query<{ readonly thread_id: string }>(
    `SELECT thread_id FROM cloud_thread WHERE workspace_id = $1 ORDER BY thread_id FOR SHARE`,
    [input.workspaceId],
  );
  for (const thread of threads.rows) {
    const isSource = thread.thread_id === workspaceFence.source_thread_id;
    await ensureThreadBillingFence(client, {
      workspaceId: input.workspaceId,
      threadId: thread.thread_id as ThreadId,
      reason: workspaceFence.reason,
      processorId: input.processorId,
      leaseExpiresAt: input.leaseExpiresAt,
      now: input.now,
      workspaceFenceId: workspaceFence.fence_id,
      ...(isSource && workspaceFence.settlement_id !== null
        ? { settlementId: workspaceFence.settlement_id as SettlementId }
        : {}),
    });
  }
};

const ensureBillingFence = async (client: PoolClient, input: BillingFenceInput) => {
  await lockWorkspaceBillingGate(client, input.workspaceId);
  const workspaceWide =
    input.workspaceWide === true ||
    input.reason === "authorization-unavailable" ||
    input.reason === "insufficient-balance";
  if (workspaceWide && input.reason !== "provider-outcome-uncertain") {
    await ensureWorkspaceBillingFence(client, input);
    return;
  }
  await ensureThreadBillingFence(client, input);
};

const persistWorkspaceRecoveryAuthorization = async (
  client: PoolClient,
  input: {
    readonly workspaceId: WorkspaceId;
    readonly threadId: ThreadId;
    readonly settlementId: SettlementId;
    readonly now: string;
  },
) => {
  await lockWorkspaceBillingGate(client, input.workspaceId);
  const workspaceFence = await client.query<{ readonly fence_id: string }>(
    `SELECT fence_id FROM cloud_usage_workspace_billing_fence
      WHERE workspace_id = $1 AND source_thread_id = $2 AND settlement_id = $3
        AND state = 'active' FOR UPDATE`,
    [input.workspaceId, input.threadId, input.settlementId],
  );
  const fenceId = workspaceFence.rows[0]?.fence_id;
  if (fenceId === undefined) return undefined;
  const linked = await client.query<{
    readonly linked_count: string;
    readonly pending_count: string;
    readonly source_count: string;
  }>(
    `SELECT count(*)::text AS linked_count,
            count(*) FILTER (WHERE state <> 'paused')::text AS pending_count,
            count(*) FILTER (
              WHERE thread_id = $3 AND settlement_id = $4 AND state = 'paused'
            )::text AS source_count
       FROM cloud_usage_billing_fence
      WHERE workspace_id = $1 AND workspace_fence_id = $2 AND state <> 'cleared'`,
    [input.workspaceId, fenceId, input.threadId, input.settlementId],
  );
  const state = linked.rows[0]!;
  if (state.linked_count === "0" || state.pending_count !== "0" || state.source_count !== "1") {
    throw new UsageSettlementRepositoryError(
      "conflict",
      "every linked workspace billing fence must be durably paused before recovery",
    );
  }
  const authorized = await client.query(
    `UPDATE cloud_usage_settlement_attempt
        SET workspace_recovery_fence_id = COALESCE(workspace_recovery_fence_id, $3),
            workspace_recovery_authorized_at = COALESCE(
              workspace_recovery_authorized_at, $4::timestamptz
            ), updated_at = $4::timestamptz
      WHERE workspace_id = $1 AND settlement_id = $2
        AND (workspace_recovery_fence_id IS NULL OR workspace_recovery_fence_id = $3)`,
    [input.workspaceId, input.settlementId, fenceId, input.now],
  );
  if (authorized.rowCount !== 1) {
    throw new UsageSettlementRepositoryError(
      "conflict",
      "workspace recovery authorization changed",
    );
  }
  return fenceId;
};

const bindAuthorizationFenceToSettlement = async (
  client: PoolClient,
  input: {
    readonly workspaceId: WorkspaceId;
    readonly threadId: ThreadId;
    readonly settlementId: SettlementId;
    readonly processorId: string;
    readonly leaseExpiresAt: string;
    readonly now: string;
  },
) => {
  await lockWorkspaceBillingGate(client, input.workspaceId);
  const cleared = await client.query(
    `UPDATE cloud_usage_billing_fence
        SET state = 'cleared', cleared_at = $3::timestamptz,
            processing_owner = NULL, processing_lease_expires_at = NULL,
            updated_at = $3::timestamptz
      WHERE workspace_id = $1 AND thread_id = $2 AND settlement_id IS NULL
        AND reason = 'authorization-unavailable' AND state = 'paused'
        AND workspace_fence_id = (
          SELECT fence_id FROM cloud_usage_workspace_billing_fence
           WHERE workspace_id = $1 AND source_thread_id = $2 AND state = 'active'
        )`,
    [input.workspaceId, input.threadId, input.now],
  );
  if (cleared.rowCount !== 1) {
    throw new UsageSettlementRepositoryError(
      "conflict",
      "authorization billing fence is not ready to bind a settlement",
    );
  }
  await ensureBillingFence(client, {
    ...input,
    reason: "authorization-unavailable",
  });
  const rebound = await client.query(
    `UPDATE cloud_usage_billing_fence
        SET state = 'paused', paused_at = $4::timestamptz,
            processing_owner = NULL, processing_lease_expires_at = NULL,
            updated_at = $4::timestamptz
      WHERE workspace_id = $1 AND thread_id = $2 AND settlement_id = $3
        AND state = 'pause-pending'`,
    [input.workspaceId, input.threadId, input.settlementId, input.now],
  );
  if (rebound.rowCount !== 1) {
    throw new UsageSettlementRepositoryError(
      "conflict",
      "authorization billing hold could not transfer to the settlement",
    );
  }
};

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
  const postingResult = await client.query<PostingRow>(
    `SELECT ${postingColumns} FROM cloud_usage_settlement_item item
        WHERE workspace_id = $1 AND settlement_id = $2 ORDER BY position`,
    [workspaceId, settlementId],
  );
  const receiptResult = await client.query<ReceiptRow>(
    `SELECT payload, payload_sha256, signature_algorithm, signature_key_id,
              signature,
              to_char(signed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS signed_at
         FROM cloud_usage_settlement_receipt
        WHERE workspace_id = $1 AND settlement_id = $2`,
    [workspaceId, settlementId],
  );
  const providerAttemptResult = await client.query<ProviderAttemptRow>(
    `SELECT generation, idempotency_key, provider_activity_ref
         FROM cloud_usage_settlement_provider_attempt
        WHERE workspace_id = $1 AND settlement_id = $2 AND generation = $3`,
    [workspaceId, settlementId, row.provider_attempt_generation],
  );
  const fenceResult = await client.query<{ readonly fence_id: string }>(
    `SELECT fence_id FROM cloud_usage_billing_fence
      WHERE workspace_id = $1 AND thread_id = $2 AND state <> 'cleared'
        AND (settlement_id = $3 OR recovery_settlement_id = $3)
      ORDER BY (reason = 'insufficient-balance') DESC,
               (workspace_fence_id IS NOT NULL) DESC, created_at DESC
      LIMIT 1`,
    [workspaceId, row.thread_id, settlementId],
  );
  const providerAttempt = providerAttemptResult.rows[0];
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
    authorizationGeneration: row.authorization_generation,
    walletAddress: row.wallet_address as EvmAddress,
    treasuryAddress: row.treasury_address as EvmAddress,
    firstPricingSequence: safeNumber(row.first_pricing_sequence),
    lastPricingSequence: safeNumber(row.last_pricing_sequence),
    upstreamDeltaMicroUsdc: safeNumber(row.upstream_delta_micro_usdc) as SignedMicroUsdc,
    markupDeltaMicroUsdc: safeNumber(row.markup_delta_micro_usdc) as SignedMicroUsdc,
    totalDeltaMicroUsdc: safeNumber(row.total_delta_micro_usdc),
    requestFingerprint: row.request_fingerprint,
    providerAttemptGeneration: row.provider_attempt_generation,
    providerIdempotencyKey:
      providerAttempt?.idempotency_key ??
      providerIdempotencyKey(row.request_fingerprint, row.provider_attempt_generation),
    postings: postingResult.rows.map(postingFromRow),
    ...(providerAttempt?.provider_activity_ref === null || providerAttempt === undefined
      ? {}
      : { providerActivityRef: providerAttempt.provider_activity_ref }),
    ...(row.next_submit_not_before === null
      ? {}
      : { nextSubmitNotBefore: row.next_submit_not_before }),
    ...(row.tx_hash === null ? {} : { txHash: row.tx_hash as EvmTransactionHash }),
    ...(row.transfer_submitted_at === null
      ? {}
      : { transferSubmittedAt: row.transfer_submitted_at }),
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
    ...(row.processing_owner === null ? {} : { processingOwner: row.processing_owner }),
    ...(row.processing_lease_expires_at === null
      ? {}
      : { processingLeaseExpiresAt: row.processing_lease_expires_at }),
    ...(row.workspace_recovery_fence_id === null
      ? {}
      : { workspaceRecoveryFenceId: row.workspace_recovery_fence_id }),
    ...(row.workspace_recovery_authorized_at === null
      ? {}
      : { workspaceRecoveryAuthorizedAt: row.workspace_recovery_authorized_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.finalized_at === null ? {} : { finalizedAt: row.finalized_at }),
    ...(receipt === undefined ? {} : { receipt }),
    ...(fenceResult.rows[0] === undefined ? {} : { billingFenceId: fenceResult.rows[0].fence_id }),
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
  if (authorization === undefined) {
    await ensureBillingFence(client, {
      workspaceId: candidate.workspace_id as WorkspaceId,
      threadId: candidate.thread_id as ThreadId,
      reason: "authorization-unavailable",
      processorId: request.processorId,
      leaseExpiresAt: request.leaseExpiresAt,
      now: request.now,
    });
    return undefined;
  }

  const available = await candidatePostings(
    client,
    candidate.workspace_id as WorkspaceId,
    candidate.thread_id as ThreadId,
  );
  const postings = choosePrefix(available, safeNumber(authorization.per_charge_limit_micro_usdc));
  if (postings.length === 0) {
    await ensureBillingFence(client, {
      workspaceId: candidate.workspace_id as WorkspaceId,
      threadId: candidate.thread_id as ThreadId,
      reason: "authorization-unavailable",
      processorId: request.processorId,
      leaseExpiresAt: request.leaseExpiresAt,
      now: request.now,
    });
    return undefined;
  }
  const upstream = safeSum(postings.map((posting) => posting.upstreamDeltaMicroUsdc));
  const markup = safeSum(postings.map((posting) => posting.markupDeltaMicroUsdc));
  const total = safeSum(postings.map((posting) => posting.totalDeltaMicroUsdc));
  if (total <= 0 || BigInt(total) !== BigInt(upstream) + BigInt(markup)) return undefined;
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
    (Math.abs(safeNumber(candidate.total_delta_micro_usdc)) >=
    SETTLEMENT_AMOUNT_THRESHOLD_MICRO_USDC
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
  await client.query(
    `INSERT INTO cloud_usage_settlement_authorization_binding (
       workspace_id, settlement_id, generation, wallet_id, authorization_id,
       wallet_address, treasury_address, bound_at
     ) VALUES ($1,$2,1,$3,$4,$5,$6,$7::timestamptz)`,
    [
      candidate.workspace_id,
      settlementId,
      authorization.wallet_id,
      authorization.authorization_id,
      authorization.wallet_address,
      authorization.treasury_address,
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
  if (request.recoverAuthorizationFence === true) {
    await bindAuthorizationFenceToSettlement(client, {
      workspaceId: candidate.workspace_id as WorkspaceId,
      threadId: candidate.thread_id as ThreadId,
      settlementId,
      processorId: request.processorId,
      leaseExpiresAt: request.leaseExpiresAt,
      now: request.now,
    });
    await persistWorkspaceRecoveryAuthorization(client, {
      workspaceId: candidate.workspace_id as WorkspaceId,
      threadId: candidate.thread_id as ThreadId,
      settlementId,
      now: request.now,
    });
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
            AND (
              NOT EXISTS (
                SELECT 1 FROM cloud_usage_billing_fence fence
                 WHERE fence.workspace_id = ledger.workspace_id
                   AND fence.thread_id = ledger.thread_id AND fence.state <> 'cleared'
              ) OR ($7::boolean AND EXISTS (
                SELECT 1 FROM cloud_usage_billing_fence fence
                 WHERE fence.workspace_id = ledger.workspace_id
                   AND fence.thread_id = ledger.thread_id
                   AND fence.reason = 'authorization-unavailable' AND fence.state = 'paused'
              )))
            AND NOT EXISTS (
              SELECT 1 FROM cloud_usage_settlement_attempt blocked
               WHERE blocked.workspace_id = ledger.workspace_id
                 AND blocked.thread_id = ledger.thread_id
                 AND blocked.state <> 'finalized'
            )
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
          request.recoverAuthorizationFence ?? false,
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
      const unauthorizable = await client.query<{
        readonly workspace_id: string;
        readonly thread_id: string;
        readonly settlement_id: string;
      }>(
        `SELECT attempt.workspace_id::text, attempt.thread_id, attempt.settlement_id
           FROM cloud_usage_settlement_attempt attempt
          WHERE attempt.state IN (
            'reserved', 'retry-waiting', 'submission-pending', 'reconciliation-required'
          )
            AND NOT EXISTS (
              SELECT 1 FROM cloud_wallet wallet
              JOIN cloud_wallet_delegated_authorization authz
                ON authz.workspace_id = wallet.workspace_id AND authz.wallet_id = wallet.wallet_id
              WHERE wallet.workspace_id = attempt.workspace_id
                AND wallet.wallet_id = attempt.wallet_id AND wallet.state = 'active'
                AND authz.authorization_id = attempt.authorization_id AND authz.state = 'active'
                AND authz.starts_at <= $1::timestamptz AND authz.expires_at > $1::timestamptz
            )
            AND NOT EXISTS (
              SELECT 1 FROM cloud_usage_billing_fence fence
               WHERE fence.workspace_id = attempt.workspace_id
                 AND fence.thread_id = attempt.thread_id AND fence.state <> 'cleared'
            )
          ORDER BY attempt.created_at LIMIT $2 FOR UPDATE OF attempt SKIP LOCKED`,
        [now, limit],
      );
      for (const blocked of unauthorizable.rows) {
        await ensureBillingFence(client, {
          workspaceId: blocked.workspace_id as WorkspaceId,
          threadId: blocked.thread_id as ThreadId,
          settlementId: blocked.settlement_id as SettlementId,
          reason: "authorization-unavailable",
          processorId,
          leaseExpiresAt,
          now,
        });
      }
      const rows = await client.query<{
        readonly workspace_id: string;
        readonly settlement_id: string;
      }>(
        `WITH candidates AS (
           SELECT workspace_id, settlement_id
             FROM cloud_usage_settlement_attempt
            WHERE state IN (
              'reserved', 'retry-waiting', 'submission-pending', 'reconciliation-required',
              'transfer-applied', 'low-balance-pause-pending'
            )
              AND (state <> 'retry-waiting' OR next_submit_not_before <= $1::timestamptz)
              AND (processing_owner IS NULL OR processing_lease_expires_at <= $1::timestamptz)
              AND (
                NOT EXISTS (
                  SELECT 1 FROM cloud_usage_billing_fence fence
                   WHERE fence.workspace_id = cloud_usage_settlement_attempt.workspace_id
                     AND fence.thread_id = cloud_usage_settlement_attempt.thread_id
                     AND fence.state <> 'cleared'
                )
                OR (
                  state = 'transfer-applied'
                  AND EXISTS (
                    SELECT 1 FROM cloud_usage_billing_fence fence
                     WHERE fence.workspace_id = cloud_usage_settlement_attempt.workspace_id
                       AND fence.thread_id = cloud_usage_settlement_attempt.thread_id
                       AND (
                         (
                           fence.settlement_id = cloud_usage_settlement_attempt.settlement_id
                           AND fence.reason = 'provider-outcome-uncertain'
                         ) OR (
                           cloud_usage_settlement_attempt.workspace_recovery_fence_id IS NOT NULL
                           AND fence.workspace_fence_id =
                             cloud_usage_settlement_attempt.workspace_recovery_fence_id
                         )
                       )
                       AND fence.state = 'paused'
                  )
                )
              )
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
      const current = await requireAttempt(client, workspaceId, settlementId);
      await persistWorkspaceRecoveryAuthorization(client, {
        workspaceId,
        threadId: current.threadId,
        settlementId,
        now,
      });
      const result = await client.query(
        `UPDATE cloud_usage_settlement_attempt
            SET processing_owner = $3, processing_lease_expires_at = $4::timestamptz,
                updated_at = $5::timestamptz
          WHERE workspace_id = $1 AND settlement_id = $2
            AND state = 'low-balance-paused'
            AND (processing_owner IS NULL OR processing_lease_expires_at <= $5::timestamptz)
            AND EXISTS (
              SELECT 1 FROM cloud_usage_billing_fence fence
               WHERE fence.workspace_id = cloud_usage_settlement_attempt.workspace_id
                 AND fence.thread_id = cloud_usage_settlement_attempt.thread_id
                 AND fence.settlement_id = cloud_usage_settlement_attempt.settlement_id
                 AND fence.reason = 'insufficient-balance'
                 AND fence.state = 'paused'
                 AND (
                   fence.workspace_fence_id IS NULL OR NOT EXISTS (
                     SELECT 1 FROM cloud_usage_billing_fence sibling
                      WHERE sibling.workspace_id = fence.workspace_id
                        AND sibling.workspace_fence_id = fence.workspace_fence_id
                        AND sibling.state <> 'cleared' AND sibling.state <> 'paused'
                   )
                 )
            )`,
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
    transaction(pool, async (client) => {
      const current = await requireAttempt(client, attempt.workspaceId, attempt.settlementId);
      if (current.processingOwner !== processorId) {
        throw new UsageSettlementRepositoryError("conflict", "settlement processing lease changed");
      }
      if (!(await authorizationIsActive(client, current, now))) {
        await ensureBillingFence(client, {
          workspaceId: current.workspaceId,
          threadId: current.threadId,
          settlementId: current.settlementId,
          reason: "authorization-unavailable",
          processorId,
          leaseExpiresAt: current.processingLeaseExpiresAt ?? now,
          now,
        });
        return updateOwned(
          client,
          current,
          processorId,
          `UPDATE cloud_usage_settlement_attempt
              SET failure_code = 'authorization-unavailable', processing_owner = NULL,
                  processing_lease_expires_at = NULL, updated_at = $4::timestamptz`,
          [now],
          ["reserved", "retry-waiting", "low-balance-paused"],
        );
      }
      const pending = await updateOwned(
        client,
        current,
        processorId,
        `UPDATE cloud_usage_settlement_attempt
            SET state = 'submission-pending', next_submit_not_before = NULL,
                failure_code = NULL, updated_at = $4::timestamptz`,
        [now],
        ["reserved", "retry-waiting", "low-balance-paused"],
      );
      await client.query(
        `INSERT INTO cloud_usage_settlement_provider_attempt (
           workspace_id, settlement_id, generation, idempotency_key, state, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,'submission-pending',$5::timestamptz,$5::timestamptz)`,
        [
          pending.workspaceId,
          pending.settlementId,
          pending.providerAttemptGeneration,
          pending.providerIdempotencyKey,
          now,
        ],
      );
      return requireAttempt(client, pending.workspaceId, pending.settlementId);
    }),
  recordTransfer: (attempt, processorId, transfer, now) =>
    transaction(pool, async (client) => {
      await lockProviderIdentity(client, "activity", transfer.providerActivityRef);
      await lockProviderIdentity(client, "transaction", transfer.txHash);
      const reused = await client.query<{
        readonly workspace_id: string;
        readonly settlement_id: string;
        readonly generation: number;
      }>(
        `SELECT workspace_id::text, settlement_id, generation
           FROM cloud_usage_settlement_provider_attempt
          WHERE provider_activity_ref = $1 OR lower(tx_hash) = lower($2)
          LIMIT 1 FOR SHARE`,
        [transfer.providerActivityRef, transfer.txHash],
      );
      const prior = reused.rows[0];
      if (
        prior !== undefined &&
        (prior.workspace_id !== attempt.workspaceId ||
          prior.settlement_id !== attempt.settlementId ||
          prior.generation !== attempt.providerAttemptGeneration)
      ) {
        await ensureBillingFence(client, {
          workspaceId: attempt.workspaceId,
          threadId: attempt.threadId,
          settlementId: attempt.settlementId,
          reason: "provider-outcome-uncertain",
          processorId,
          leaseExpiresAt: attempt.processingLeaseExpiresAt ?? now,
          now,
        });
        return updateOwned(
          client,
          attempt,
          processorId,
          `UPDATE cloud_usage_settlement_attempt
              SET state = 'reconciliation-required', failure_code = $4,
                  processing_owner = NULL, processing_lease_expires_at = NULL,
                  updated_at = $5::timestamptz`,
          ["provider-transfer-identity-reused", now],
          ["submission-pending", "reconciliation-required"],
        );
      }
      const activity = await client.query(
        `UPDATE cloud_usage_settlement_provider_attempt
            SET state = 'applied', provider_activity_ref = COALESCE(provider_activity_ref, $4),
                tx_hash = $5, transfer_submitted_at = $6::timestamptz,
                closed_at = $7::timestamptz, updated_at = $7::timestamptz
          WHERE workspace_id = $1 AND settlement_id = $2 AND generation = $3
            AND state IN ('submission-pending', 'unknown')
            AND (provider_activity_ref IS NULL OR provider_activity_ref = $4)`,
        [
          attempt.workspaceId,
          attempt.settlementId,
          attempt.providerAttemptGeneration,
          transfer.providerActivityRef,
          transfer.txHash.toLowerCase(),
          transfer.submittedAt,
          now,
        ],
      );
      if (activity.rowCount !== 1) {
        throw new UsageSettlementRepositoryError(
          "conflict",
          "provider transfer does not match the active settlement generation",
        );
      }
      return updateOwned(
        client,
        attempt,
        processorId,
        `UPDATE cloud_usage_settlement_attempt
            SET state = 'transfer-applied', tx_hash = $4,
                transfer_submitted_at = $5::timestamptz,
                failure_code = NULL, updated_at = $6::timestamptz`,
        [transfer.txHash.toLowerCase(), transfer.submittedAt, now],
        ["submission-pending", "reconciliation-required"],
      );
    }),
  markReconciliationRequired: (attempt, processorId, providerActivityRef, failureCode, now) =>
    transaction(pool, async (client) => {
      if (providerActivityRef !== undefined) {
        if (await providerActivityIsReused(client, attempt, providerActivityRef)) {
          await ensureBillingFence(client, {
            workspaceId: attempt.workspaceId,
            threadId: attempt.threadId,
            settlementId: attempt.settlementId,
            reason: "provider-outcome-uncertain",
            processorId,
            leaseExpiresAt: attempt.processingLeaseExpiresAt ?? now,
            now,
          });
          return updateOwned(
            client,
            attempt,
            processorId,
            `UPDATE cloud_usage_settlement_attempt
                SET state = 'reconciliation-required', failure_code = $4,
                    processing_owner = NULL, processing_lease_expires_at = NULL,
                    updated_at = $5::timestamptz`,
            ["provider-activity-identity-reused", now],
            ["submission-pending", "reconciliation-required"],
          );
        }
        const activity = await client.query(
          `UPDATE cloud_usage_settlement_provider_attempt
              SET state = 'unknown', provider_activity_ref = COALESCE(provider_activity_ref, $4),
                  updated_at = $5::timestamptz
            WHERE workspace_id = $1 AND settlement_id = $2 AND generation = $3
              AND state IN ('submission-pending', 'unknown')
              AND (provider_activity_ref IS NULL OR provider_activity_ref = $4)`,
          [
            attempt.workspaceId,
            attempt.settlementId,
            attempt.providerAttemptGeneration,
            providerActivityRef,
            now,
          ],
        );
        if (activity.rowCount !== 1) {
          throw new UsageSettlementRepositoryError(
            "conflict",
            "provider activity does not match the active settlement generation",
          );
        }
      }
      await ensureBillingFence(client, {
        workspaceId: attempt.workspaceId,
        threadId: attempt.threadId,
        settlementId: attempt.settlementId,
        reason: "provider-outcome-uncertain",
        processorId,
        leaseExpiresAt: attempt.processingLeaseExpiresAt ?? now,
        now,
      });
      return updateOwned(
        client,
        attempt,
        processorId,
        `UPDATE cloud_usage_settlement_attempt
            SET state = 'reconciliation-required', failure_code = $4,
                processing_owner = NULL, processing_lease_expires_at = NULL,
                updated_at = $5::timestamptz`,
        [failureCode, now],
        ["submission-pending", "reconciliation-required"],
      );
    }),
  markFinalizationRequired: (attempt, processorId, failureCode, now) =>
    transaction(pool, async (client) => {
      await ensureBillingFence(client, {
        workspaceId: attempt.workspaceId,
        threadId: attempt.threadId,
        settlementId: attempt.settlementId,
        reason: "provider-outcome-uncertain",
        processorId,
        leaseExpiresAt: attempt.processingLeaseExpiresAt ?? now,
        now,
      });
      return updateOwned(
        client,
        attempt,
        processorId,
        `UPDATE cloud_usage_settlement_attempt
            SET failure_code = $4, processing_owner = NULL,
                processing_lease_expires_at = NULL, updated_at = $5::timestamptz`,
        [failureCode, now],
        ["transfer-applied"],
      );
    }),
  closeProviderAttemptNotApplied: (
    attempt,
    processorId,
    providerActivityRef,
    failureCode,
    now,
    nextSubmitNotBefore,
  ) =>
    transaction(pool, async (client) => {
      const current = await requireAttempt(client, attempt.workspaceId, attempt.settlementId);
      if (current.processingOwner !== processorId) {
        throw new UsageSettlementRepositoryError("conflict", "settlement processing lease changed");
      }
      if (
        providerActivityRef !== undefined &&
        (await providerActivityIsReused(client, current, providerActivityRef))
      ) {
        await ensureBillingFence(client, {
          workspaceId: current.workspaceId,
          threadId: current.threadId,
          settlementId: current.settlementId,
          reason: "provider-outcome-uncertain",
          processorId,
          leaseExpiresAt: current.processingLeaseExpiresAt ?? now,
          now,
        });
        return updateOwned(
          client,
          current,
          processorId,
          `UPDATE cloud_usage_settlement_attempt
              SET state = 'reconciliation-required', failure_code = $4,
                  processing_owner = NULL, processing_lease_expires_at = NULL,
                  updated_at = $5::timestamptz`,
          ["provider-activity-identity-reused", now],
          ["submission-pending", "reconciliation-required"],
        );
      }
      const storedActivity = await client.query<{
        readonly provider_activity_ref: string | null;
        readonly state: string;
      }>(
        `SELECT provider_activity_ref, state FROM cloud_usage_settlement_provider_attempt
          WHERE workspace_id = $1 AND settlement_id = $2 AND generation = $3 FOR UPDATE`,
        [current.workspaceId, current.settlementId, current.providerAttemptGeneration],
      );
      const storedActivityRef = storedActivity.rows[0]?.provider_activity_ref ?? undefined;
      if (
        storedActivityRef !== undefined &&
        providerActivityRef !== undefined &&
        storedActivityRef !== providerActivityRef
      ) {
        throw new UsageSettlementRepositoryError(
          "conflict",
          "definitive provider activity does not match durable history",
        );
      }
      const activity =
        providerActivityRef === undefined
          ? await client.query(
              `UPDATE cloud_usage_settlement_provider_attempt
                  SET state = 'not-applied', closed_at = $4::timestamptz,
                      updated_at = $4::timestamptz
                WHERE workspace_id = $1 AND settlement_id = $2 AND generation = $3
                  AND state IN ('submission-pending', 'unknown')
                  AND provider_activity_ref IS NULL`,
              [current.workspaceId, current.settlementId, current.providerAttemptGeneration, now],
            )
          : await client.query(
              `UPDATE cloud_usage_settlement_provider_attempt
                  SET state = 'not-applied',
                      provider_activity_ref = COALESCE(provider_activity_ref, $5),
                      closed_at = $4::timestamptz,
                      updated_at = $4::timestamptz
                WHERE workspace_id = $1 AND settlement_id = $2 AND generation = $3
                  AND state IN ('submission-pending', 'unknown')
                  AND (provider_activity_ref IS NULL OR provider_activity_ref = $5)`,
              [
                current.workspaceId,
                current.settlementId,
                current.providerAttemptGeneration,
                now,
                providerActivityRef,
              ],
            );
      if (activity.rowCount !== 1) {
        throw new UsageSettlementRepositoryError(
          "conflict",
          `definitive provider result does not match active settlement generation ${current.providerAttemptGeneration} (${storedActivity.rows[0]?.state ?? "missing"})`,
        );
      }
      const authorizationActive = await authorizationIsActive(client, current, now);
      await ensureBillingFence(client, {
        workspaceId: current.workspaceId,
        threadId: current.threadId,
        settlementId: current.settlementId,
        reason: authorizationActive ? "provider-definitive-failure" : "authorization-unavailable",
        workspaceWide: !authorizationActive || failureCode.startsWith("wallet-policy-"),
        processorId,
        leaseExpiresAt: current.processingLeaseExpiresAt ?? nextSubmitNotBefore,
        now,
      });
      return updateOwned(
        client,
        current,
        processorId,
        `UPDATE cloud_usage_settlement_attempt
            SET state = 'retry-waiting', provider_attempt_generation = provider_attempt_generation + 1,
                next_submit_not_before = $4::timestamptz, failure_code = $5,
                processing_owner = NULL, processing_lease_expires_at = NULL,
                updated_at = $6::timestamptz`,
        [nextSubmitNotBefore, failureCode, now],
        ["submission-pending", "reconciliation-required"],
      );
    }),
  markLowBalancePausePending: (attempt, processorId, providerActivityRef, failureCode, now) =>
    transaction(pool, async (client) => {
      if (
        providerActivityRef !== undefined &&
        (await providerActivityIsReused(client, attempt, providerActivityRef))
      ) {
        await ensureBillingFence(client, {
          workspaceId: attempt.workspaceId,
          threadId: attempt.threadId,
          settlementId: attempt.settlementId,
          reason: "provider-outcome-uncertain",
          processorId,
          leaseExpiresAt: attempt.processingLeaseExpiresAt ?? now,
          now,
        });
        return updateOwned(
          client,
          attempt,
          processorId,
          `UPDATE cloud_usage_settlement_attempt
              SET state = 'reconciliation-required', failure_code = $4,
                  processing_owner = NULL, processing_lease_expires_at = NULL,
                  updated_at = $5::timestamptz`,
          ["provider-activity-identity-reused", now],
          ["submission-pending", "reconciliation-required"],
        );
      }
      const activity = await client.query(
        `UPDATE cloud_usage_settlement_provider_attempt
            SET state = 'not-applied', provider_activity_ref = COALESCE(provider_activity_ref, $4),
                closed_at = $5::timestamptz, updated_at = $5::timestamptz
          WHERE workspace_id = $1 AND settlement_id = $2 AND generation = $3
            AND state IN ('submission-pending', 'unknown')
            AND ($4::text IS NULL OR provider_activity_ref IS NULL OR provider_activity_ref = $4)`,
        [
          attempt.workspaceId,
          attempt.settlementId,
          attempt.providerAttemptGeneration,
          providerActivityRef ?? null,
          now,
        ],
      );
      if (activity.rowCount !== 1) {
        throw new UsageSettlementRepositoryError(
          "conflict",
          "low-balance result does not match the active settlement generation",
        );
      }
      await client.query(
        `UPDATE cloud_usage_billing_fence
            SET state = 'cleared', cleared_at = $4::timestamptz,
                processing_owner = NULL, processing_lease_expires_at = NULL,
                updated_at = $4::timestamptz
          WHERE workspace_id = $1 AND thread_id = $2 AND settlement_id = $3
            AND workspace_fence_id IS NULL AND reason = 'provider-definitive-failure'
            AND state = 'paused'`,
        [attempt.workspaceId, attempt.threadId, attempt.settlementId, now],
      );
      await ensureBillingFence(client, {
        workspaceId: attempt.workspaceId,
        threadId: attempt.threadId,
        settlementId: attempt.settlementId,
        reason: "insufficient-balance",
        processorId,
        leaseExpiresAt: attempt.processingLeaseExpiresAt ?? now,
        now,
      });
      const existingFence = await client.query<{ readonly state: string }>(
        `SELECT state FROM cloud_usage_billing_fence
          WHERE workspace_id = $1 AND thread_id = $2
            AND settlement_id = $3 AND reason = 'insufficient-balance'
            AND state <> 'cleared' FOR UPDATE`,
        [attempt.workspaceId, attempt.threadId, attempt.settlementId],
      );
      if (existingFence.rows[0]?.state === "paused") {
        return updateOwned(
          client,
          attempt,
          processorId,
          `UPDATE cloud_usage_settlement_attempt
              SET state = 'low-balance-paused',
                  provider_attempt_generation = provider_attempt_generation + 1,
                  failure_code = $4, processing_owner = NULL,
                  processing_lease_expires_at = NULL, updated_at = $5::timestamptz`,
          [failureCode, now],
          ["submission-pending", "reconciliation-required"],
        );
      }
      return updateOwned(
        client,
        attempt,
        processorId,
        `UPDATE cloud_usage_settlement_attempt
            SET state = 'low-balance-pause-pending', failure_code = $4,
                updated_at = $5::timestamptz`,
        [failureCode, now],
        ["submission-pending", "reconciliation-required"],
      );
    }),
  markLowBalancePaused: (attempt, processorId, now) =>
    transaction(pool, async (client) => {
      const paused = await updateOwned(
        client,
        attempt,
        processorId,
        `UPDATE cloud_usage_settlement_attempt
            SET state = 'low-balance-paused',
                provider_attempt_generation = provider_attempt_generation + 1,
                processing_owner = NULL,
                processing_lease_expires_at = NULL, updated_at = $4::timestamptz`,
        [now],
        ["low-balance-pause-pending"],
      );
      const fence = await client.query(
        `UPDATE cloud_usage_billing_fence
            SET state = 'paused', paused_at = $5::timestamptz,
                processing_owner = NULL, processing_lease_expires_at = NULL,
                updated_at = $5::timestamptz
          WHERE workspace_id = $1 AND thread_id = $2
            AND (settlement_id = $3 OR recovery_settlement_id = $3)
            AND state = 'pause-pending'
            AND processing_owner = $4 AND fence_id = $6`,
        [
          attempt.workspaceId,
          attempt.threadId,
          attempt.settlementId,
          processorId,
          now,
          attempt.billingFenceId ?? "",
        ],
      );
      if (fence.rowCount !== 1) {
        throw new UsageSettlementRepositoryError(
          "conflict",
          "low-balance billing fence lease changed",
        );
      }
      return requireAttempt(client, paused.workspaceId, paused.settlementId);
    }),
  finalize: (attempt, processorId, receipt, now) =>
    transaction(pool, async (client) => {
      const current = await requireAttempt(client, attempt.workspaceId, attempt.settlementId);
      await lockWorkspaceBillingGate(client, current.workspaceId);
      const workspaceFenceResult = await client.query<{ readonly fence_id: string }>(
        `SELECT fence_id
           FROM cloud_usage_workspace_billing_fence
          WHERE workspace_id = $1 AND source_thread_id = $2 AND settlement_id = $3
            AND state = 'active' FOR UPDATE`,
        [current.workspaceId, current.threadId, current.settlementId],
      );
      const activeWorkspaceFenceId = workspaceFenceResult.rows[0]?.fence_id;
      if (
        activeWorkspaceFenceId !== undefined &&
        current.workspaceRecoveryFenceId !== activeWorkspaceFenceId
      ) {
        throw new UsageSettlementRepositoryError(
          "conflict",
          "workspace billing hold requires a persisted explicit recovery authorization",
        );
      }
      if (activeWorkspaceFenceId === undefined && current.workspaceRecoveryFenceId !== undefined) {
        throw new UsageSettlementRepositoryError(
          "conflict",
          "persisted workspace recovery authorization no longer matches an active hold",
        );
      }
      const workspaceFenceId = current.workspaceRecoveryFenceId;
      if (workspaceFenceId !== undefined) {
        const linked = await client.query<{
          readonly linked_count: string;
          readonly pending_count: string;
          readonly source_count: string;
        }>(
          `SELECT count(*)::text AS linked_count,
                  count(*) FILTER (WHERE state <> 'paused')::text AS pending_count,
                  count(*) FILTER (
                    WHERE thread_id = $3
                      AND (settlement_id = $4 OR recovery_settlement_id = $4)
                      AND state = 'paused'
                  )::text AS source_count
             FROM cloud_usage_billing_fence
            WHERE workspace_id = $1 AND workspace_fence_id = $2 AND state <> 'cleared'`,
          [current.workspaceId, workspaceFenceId, current.threadId, current.settlementId],
        );
        const linkedState = linked.rows[0]!;
        if (
          linkedState.linked_count === "0" ||
          linkedState.pending_count !== "0" ||
          linkedState.source_count !== "1"
        ) {
          throw new UsageSettlementRepositoryError(
            "conflict",
            "every linked workspace billing fence must be durably paused before recovery",
          );
        }
      }
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
      const finalized = await updateOwned(
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
      if (workspaceFenceId === undefined) {
        await client.query(
          `UPDATE cloud_usage_billing_fence
              SET state = 'cleared', cleared_at = $3::timestamptz,
                  processing_owner = NULL, processing_lease_expires_at = NULL,
                  updated_at = $3::timestamptz
            WHERE workspace_id = $1 AND thread_id = $2 AND state = 'paused'
              AND settlement_id = $4`,
          [current.workspaceId, current.threadId, now, current.settlementId],
        );
      } else {
        await client.query(
          `UPDATE cloud_usage_billing_fence
              SET state = 'cleared', cleared_at = $3::timestamptz,
                  processing_owner = NULL, processing_lease_expires_at = NULL,
                  updated_at = $3::timestamptz
            WHERE workspace_id = $1 AND workspace_fence_id = $2 AND state = 'paused'`,
          [current.workspaceId, workspaceFenceId, now],
        );
        const clearedWorkspace = await client.query(
          `UPDATE cloud_usage_workspace_billing_fence
              SET state = 'cleared', cleared_at = $3::timestamptz,
                  updated_at = $3::timestamptz
            WHERE workspace_id = $1 AND fence_id = $2 AND state = 'active'`,
          [current.workspaceId, workspaceFenceId, now],
        );
        if (clearedWorkspace.rowCount !== 1) {
          throw new UsageSettlementRepositoryError(
            "conflict",
            "workspace billing hold changed during recovery",
          );
        }
      }
      const activeFence = await client.query(
        `SELECT 1 FROM cloud_usage_billing_fence
          WHERE workspace_id = $1 AND thread_id = $2 AND state <> 'cleared' LIMIT 1`,
        [current.workspaceId, current.threadId],
      );
      if (activeFence.rowCount !== 0) {
        throw new UsageSettlementRepositoryError(
          "conflict",
          "billing fence must be durably paused before settlement finalization",
        );
      }
      return finalized;
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
  claimPendingBillingFences: (processorId, now, leaseExpiresAt, limit) =>
    transaction(pool, async (client) => {
      const result = await client.query<BillingFenceRow>(
        `WITH candidates AS (
           SELECT workspace_id, thread_id, fence_id
             FROM cloud_usage_billing_fence
            WHERE state = 'pause-pending'
              AND (processing_owner IS NULL OR processing_owner = $3
                OR processing_lease_expires_at <= $1::timestamptz)
            ORDER BY created_at, workspace_id, thread_id
            LIMIT $2 FOR UPDATE SKIP LOCKED
         )
         UPDATE cloud_usage_billing_fence fence
            SET processing_owner = $3, processing_lease_expires_at = $4::timestamptz,
                updated_at = $1::timestamptz
           FROM candidates
          WHERE fence.workspace_id = candidates.workspace_id
            AND fence.thread_id = candidates.thread_id
            AND fence.fence_id = candidates.fence_id
         RETURNING ${billingFenceColumns}`,
        [now, limit, processorId, leaseExpiresAt],
      );
      return result.rows.map(billingFenceFromRow);
    }),
  markBillingFencePaused: (fence, processorId, pausedAt) =>
    transaction(pool, async (client) => {
      const result = await client.query<BillingFenceRow>(
        `UPDATE cloud_usage_billing_fence fence
            SET state = 'paused', paused_at = $5::timestamptz,
                processing_owner = NULL, processing_lease_expires_at = NULL,
                updated_at = $5::timestamptz
          WHERE workspace_id = $1 AND thread_id = $2 AND fence_id = $3
            AND state = 'pause-pending' AND processing_owner = $4
          RETURNING ${billingFenceColumns}`,
        [fence.workspaceId, fence.threadId, fence.fenceId, processorId, pausedAt],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new UsageSettlementRepositoryError("conflict", "billing fence lease changed");
      }
      await client.query(
        `UPDATE cloud_usage_settlement_attempt attempt
            SET state = 'low-balance-paused',
                provider_attempt_generation = provider_attempt_generation + 1,
                processing_owner = NULL, processing_lease_expires_at = NULL,
                updated_at = $4::timestamptz
          WHERE attempt.workspace_id = $1 AND attempt.thread_id = $2
            AND attempt.state = 'low-balance-pause-pending'
            AND attempt.settlement_id = (
              SELECT settlement_id FROM cloud_usage_billing_fence
               WHERE workspace_id = $1 AND thread_id = $2 AND fence_id = $3
            )`,
        [fence.workspaceId, fence.threadId, fence.fenceId, pausedAt],
      );
      return billingFenceFromRow(row);
    }),
  claimProviderFailureRetry: (workspaceId, settlementId, processorId, now, leaseExpiresAt) =>
    transaction(pool, async (client) => {
      const current = await requireAttempt(client, workspaceId, settlementId);
      await persistWorkspaceRecoveryAuthorization(client, {
        workspaceId,
        threadId: current.threadId,
        settlementId,
        now,
      });
      const attemptResult = await client.query<{
        readonly thread_id: string;
        readonly state: UsageSettlementAttemptState;
      }>(
        `SELECT thread_id, state FROM cloud_usage_settlement_attempt
          WHERE workspace_id = $1 AND settlement_id = $2
            AND state IN ('reserved', 'retry-waiting', 'reconciliation-required')
            AND (state <> 'retry-waiting' OR next_submit_not_before <= $3::timestamptz)
            AND (
              state <> 'reconciliation-required'
              OR updated_at <= $3::timestamptz - interval '5 seconds'
            )
            AND (processing_owner IS NULL OR processing_lease_expires_at <= $3::timestamptz)
          FOR UPDATE`,
        [workspaceId, settlementId, now],
      );
      const attemptRow = attemptResult.rows[0];
      if (attemptRow === undefined) {
        throw new UsageSettlementRepositoryError(
          "conflict",
          "provider-failure settlement is not retry eligible",
        );
      }
      const fence = await client.query(
        `SELECT 1 FROM cloud_usage_billing_fence
          WHERE workspace_id = $1 AND thread_id = $2 AND settlement_id = $3
            AND reason = 'provider-definitive-failure' AND state = 'paused'
            AND (
              workspace_fence_id IS NULL OR NOT EXISTS (
                SELECT 1 FROM cloud_usage_billing_fence sibling
                 WHERE sibling.workspace_id = cloud_usage_billing_fence.workspace_id
                   AND sibling.workspace_fence_id = cloud_usage_billing_fence.workspace_fence_id
                   AND sibling.state <> 'cleared' AND sibling.state <> 'paused'
              )
            )
          FOR SHARE`,
        [workspaceId, attemptRow.thread_id, settlementId],
      );
      if (fence.rowCount !== 1) {
        throw new UsageSettlementRepositoryError(
          "conflict",
          "provider-failure billing fence must remain paused through explicit recovery",
        );
      }
      await client.query(
        `UPDATE cloud_usage_settlement_attempt
            SET state = CASE WHEN state = 'retry-waiting' THEN 'reserved' ELSE state END,
                next_submit_not_before = CASE
                  WHEN state = 'retry-waiting' THEN NULL ELSE next_submit_not_before
                END,
                processing_owner = $3, processing_lease_expires_at = $4::timestamptz,
                updated_at = $5::timestamptz
          WHERE workspace_id = $1 AND settlement_id = $2`,
        [workspaceId, settlementId, processorId, leaseExpiresAt, now],
      );
      return requireAttempt(client, workspaceId, settlementId);
    }),
  claimAuthorizationRecovery: (workspaceId, threadId, processorId, now, leaseExpiresAt) =>
    transaction(pool, async (client) => {
      await lockWorkspaceBillingGate(client, workspaceId);
      const fence = await client.query<{ readonly settlement_id: string | null }>(
        `SELECT settlement_id
           FROM cloud_usage_billing_fence
          WHERE workspace_id = $1 AND thread_id = $2
            AND reason = 'authorization-unavailable' AND state = 'paused'
            AND (
              workspace_fence_id IS NULL OR NOT EXISTS (
                SELECT 1 FROM cloud_usage_billing_fence sibling
                 WHERE sibling.workspace_id = cloud_usage_billing_fence.workspace_id
                   AND sibling.workspace_fence_id = cloud_usage_billing_fence.workspace_fence_id
                   AND sibling.state <> 'cleared' AND sibling.state <> 'paused'
              )
            )
          FOR UPDATE`,
        [workspaceId, threadId],
      );
      const settlementId = fence.rows[0]?.settlement_id;
      if (settlementId == null) return undefined;
      const current = await requireAttempt(client, workspaceId, settlementId as SettlementId);
      if (current.state !== "reserved" && current.state !== "retry-waiting") {
        throw new UsageSettlementRepositoryError(
          "conflict",
          "authorization may change only before a provider submission generation starts",
        );
      }
      if (
        current.state === "retry-waiting" &&
        current.nextSubmitNotBefore !== undefined &&
        current.nextSubmitNotBefore > now
      ) {
        throw new UsageSettlementRepositoryError(
          "conflict",
          "authorization recovery is waiting for its persisted retry window",
        );
      }
      const rebound = await rebindAuthorizationIfNeeded(client, current, now);
      if (!(await authorizationIsActive(client, rebound, now))) {
        throw new UsageSettlementRepositoryError(
          "configurationMissing",
          "an active delegated authorization is required for recovery",
        );
      }
      const claimed = await client.query(
        `UPDATE cloud_usage_settlement_attempt
            SET state = 'reserved', next_submit_not_before = NULL,
                processing_owner = $3, processing_lease_expires_at = $4::timestamptz,
                updated_at = $5::timestamptz
          WHERE workspace_id = $1 AND settlement_id = $2
            AND state IN ('reserved', 'retry-waiting')
            AND (processing_owner IS NULL OR processing_lease_expires_at <= $5::timestamptz)`,
        [workspaceId, rebound.settlementId, processorId, leaseExpiresAt, now],
      );
      if (claimed.rowCount !== 1) {
        throw new UsageSettlementRepositoryError(
          "conflict",
          "authorization recovery settlement lease changed",
        );
      }
      await persistWorkspaceRecoveryAuthorization(client, {
        workspaceId,
        threadId,
        settlementId: rebound.settlementId,
        now,
      });
      return requireAttempt(client, workspaceId, rebound.settlementId);
    }),
});
