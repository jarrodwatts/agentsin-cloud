import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { AuthSessionId } from "@t3tools/contracts";
import {
  MONAD_MAINNET_CHAIN_ID,
  MONAD_MAINNET_NATIVE_USDC,
  type EvmAddress,
  type EvmTransactionHash,
  type MicroUsdc,
  type WorkspaceId,
} from "@t3tools/contracts/cloud";
import {
  MONAD_USDC_BINDING,
  type UserOwnedWallet,
  type WalletDelegatedAuthorization,
  type WalletDelegatedChargeRequest,
  type WalletId,
  type WalletIdempotencyKey,
  type WalletOperationId,
  type WalletRecoveryAttemptId,
  type WalletRecoveryMetadata,
  type WalletRequestFingerprint,
  type WalletSpendReservationId,
  type WalletDelegatedSpendReservation,
  type WalletProviderEffectEvidence,
  type WalletTransferResult,
} from "@t3tools/contracts/wallet";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export type WalletOperationKind =
  | "provision"
  | "delegationConfigure"
  | "recoveryBegin"
  | "recoveryComplete"
  | "withdrawal";
export type WalletOperationState = "pending" | "succeeded" | "failed";

export interface WalletOperationRecord {
  readonly workspaceId: WorkspaceId;
  readonly operationId: WalletOperationId;
  readonly walletId: WalletId;
  readonly kind: WalletOperationKind;
  readonly state: WalletOperationState;
  readonly idempotencyKey: WalletIdempotencyKey;
  readonly requestFingerprint: WalletRequestFingerprint;
  readonly requestedAt: string;
  readonly providerActivityRef?: string;
  readonly txHash?: EvmTransactionHash;
  readonly amountMicroUsdc?: MicroUsdc;
  readonly destination?: EvmAddress;
  readonly completedAt?: string;
  readonly errorCode?: string;
}

export interface WalletAuditActor {
  readonly userId: string;
  readonly authSessionId: AuthSessionId;
}

export type WalletAuditEventKind =
  | "walletProvisioned"
  | "delegationConfigured"
  | "delegationRevoked"
  | "recoveryInitiated"
  | "recoveryCompleted"
  | "withdrawalSubmitted"
  | "spendReserved"
  | "spendSubmitted"
  | "spendReleased"
  | "operationFailed";

export interface WalletAuditRecord {
  readonly workspaceId: WorkspaceId;
  readonly auditEventId: string;
  readonly walletId?: WalletId;
  readonly operationId?: WalletOperationId;
  readonly actor?: WalletAuditActor;
  readonly eventKind: WalletAuditEventKind;
  readonly occurredAt: string;
}

export interface WalletOperationReservation {
  readonly disposition: "reserved" | "duplicate";
  readonly operation: WalletOperationRecord;
}

export interface WalletProvisionReservation {
  readonly disposition: "reserved" | "duplicate";
  readonly operation?: WalletOperationRecord;
  readonly wallet?: UserOwnedWallet;
}

export interface WalletDelegationRevocationRecord {
  readonly workspaceId: WorkspaceId;
  readonly walletId: WalletId;
  readonly authorizationId: WalletDelegatedAuthorization["authorizationId"];
  readonly operationId: WalletOperationId;
  readonly providerActivityRef: string;
  readonly providerStatus: WalletProviderEffectEvidence["status"];
  readonly requestedAt: string;
  readonly observedAt: string;
  readonly revokedAt?: string;
}

export interface WalletDelegationConfigurationEvidence {
  readonly status: "applied" | "notApplied" | "stillUnknown";
  readonly observedAt: string;
  readonly providerActivityRef?: string;
  readonly providerPolicyRef?: string;
  readonly providerDelegatedUserRef?: string;
  readonly providerDelegatedCredentialRef?: string;
}

export interface WalletDelegationConfigurationIntent {
  readonly workspaceId: WorkspaceId;
  readonly walletId: WalletId;
  readonly operationId: WalletOperationId;
  readonly operationKind: "delegationConfigure" | "recoveryComplete";
  readonly authorizationId?: WalletDelegatedAuthorization["authorizationId"];
  readonly requestFingerprint: WalletRequestFingerprint;
  readonly state: "reserved" | "attempting" | "providerApplied" | "completed" | "failed";
  readonly evidence?: WalletDelegationConfigurationEvidence;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WalletDelegationConfigurationReservation {
  readonly disposition: "reserved" | "duplicate";
  readonly operation?: WalletOperationRecord;
  readonly intent?: WalletDelegationConfigurationIntent;
  readonly authorization?: WalletDelegatedAuthorization;
}

export interface WalletSpendReservationResult {
  readonly disposition: "reserved" | "duplicate";
  readonly reservation: WalletDelegatedSpendReservation;
}

export interface WalletSpendEvidenceResult {
  readonly disposition: "updated" | "duplicate";
  readonly reservation: WalletDelegatedSpendReservation;
}

export class WalletRepositoryError extends Schema.TaggedErrorClass<WalletRepositoryError>()(
  "WalletRepositoryError",
  {
    code: Schema.Literals([
      "notFound",
      "idempotencyConflict",
      "operationPending",
      "stateConflict",
      "policyViolation",
      "dailyLimitExceeded",
      "databaseFailure",
    ]),
    operation: Schema.String,
    retryable: Schema.Boolean,
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {}

export interface WalletRepository {
  readonly reserveProvision: (input: {
    readonly operation: WalletOperationRecord;
    readonly ownerUserId: string;
  }) => Effect.Effect<WalletProvisionReservation, WalletRepositoryError>;
  readonly reserveOperation: (
    operation: WalletOperationRecord,
  ) => Effect.Effect<WalletOperationReservation, WalletRepositoryError>;
  readonly getOperation: (
    workspaceId: WorkspaceId,
    operationId: WalletOperationId,
  ) => Effect.Effect<WalletOperationRecord | undefined, WalletRepositoryError>;
  readonly failOperation: (input: {
    readonly workspaceId: WorkspaceId;
    readonly operationId: WalletOperationId;
    readonly walletId: WalletId;
    readonly errorCode: string;
    readonly failedAt: string;
    readonly auditEventId: string;
  }) => Effect.Effect<WalletOperationRecord, WalletRepositoryError>;
  readonly completeProvision: (input: {
    readonly operation: WalletOperationRecord;
    readonly wallet: UserOwnedWallet;
    readonly providerActivityRef: string;
    readonly actor: WalletAuditActor;
    readonly auditEventId: string;
  }) => Effect.Effect<UserOwnedWallet, WalletRepositoryError>;
  readonly getWallet: (
    workspaceId: WorkspaceId,
    walletId: WalletId,
  ) => Effect.Effect<UserOwnedWallet | undefined, WalletRepositoryError>;
  readonly reserveDelegationConfiguration: (input: {
    readonly operation: WalletOperationRecord;
    readonly authorization?: WalletDelegatedAuthorization;
  }) => Effect.Effect<WalletDelegationConfigurationReservation, WalletRepositoryError>;
  readonly beginDelegationConfigurationAttempt: (input: {
    readonly operation: WalletOperationRecord;
    readonly attemptedAt: string;
  }) => Effect.Effect<WalletDelegationConfigurationIntent, WalletRepositoryError>;
  readonly recordDelegationConfigurationEvidence: (input: {
    readonly operation: WalletOperationRecord;
    readonly evidence: WalletDelegationConfigurationEvidence;
  }) => Effect.Effect<WalletDelegationConfigurationIntent, WalletRepositoryError>;
  readonly completeDelegation: (input: {
    readonly operation: WalletOperationRecord;
    readonly authorization: WalletDelegatedAuthorization;
    readonly provider: {
      readonly policyRef: string;
      readonly delegatedUserRef: string;
      readonly delegatedCredentialRef: string;
      readonly activityRef: string;
    };
    readonly actor: WalletAuditActor;
    readonly completedAt: string;
    readonly auditEventId: string;
  }) => Effect.Effect<WalletDelegatedAuthorization, WalletRepositoryError>;
  readonly getDelegatedAuthorization: (
    workspaceId: WorkspaceId,
    walletId: WalletId,
    authorizationId: WalletDelegatedAuthorization["authorizationId"],
  ) => Effect.Effect<WalletDelegatedAuthorization | undefined, WalletRepositoryError>;
  readonly getActiveDelegatedAuthorization: (
    workspaceId: WorkspaceId,
    walletId: WalletId,
  ) => Effect.Effect<WalletDelegatedAuthorization | undefined, WalletRepositoryError>;
  readonly getDelegationRevocation: (
    workspaceId: WorkspaceId,
    walletId: WalletId,
    authorizationId: WalletDelegatedAuthorization["authorizationId"],
  ) => Effect.Effect<WalletDelegationRevocationRecord | undefined, WalletRepositoryError>;
  readonly recordDelegationRevocation: (input: {
    readonly operation: WalletOperationRecord;
    readonly authorization: WalletDelegatedAuthorization;
    readonly providerActivityRef: string;
    readonly providerStatus: WalletProviderEffectEvidence["status"];
    readonly requestedAt: string;
    readonly observedAt: string;
    readonly auditEventId: string;
  }) => Effect.Effect<WalletDelegationRevocationRecord, WalletRepositoryError>;
  readonly completeRecoveryBegin: (input: {
    readonly operation: WalletOperationRecord;
    readonly recovery: WalletRecoveryMetadata;
    readonly actor: WalletAuditActor;
    readonly auditEventId: string;
  }) => Effect.Effect<WalletRecoveryMetadata, WalletRepositoryError>;
  readonly completeRecovery: (input: {
    readonly operation: WalletOperationRecord;
    readonly recoveryAttemptId: WalletRecoveryAttemptId;
    readonly providerActivityRef: string;
    readonly actor: WalletAuditActor;
    readonly completedAt: string;
    readonly auditEventId: string;
  }) => Effect.Effect<WalletRecoveryMetadata, WalletRepositoryError>;
  readonly getRecovery: (
    workspaceId: WorkspaceId,
    recoveryAttemptId: WalletRecoveryAttemptId,
  ) => Effect.Effect<WalletRecoveryMetadata | undefined, WalletRepositoryError>;
  readonly completeWithdrawal: (input: {
    readonly operation: WalletOperationRecord;
    readonly transfer: WalletTransferResult;
    readonly actor: WalletAuditActor;
    readonly auditEventId: string;
  }) => Effect.Effect<WalletTransferResult, WalletRepositoryError>;
  readonly reserveDelegatedSpend: (input: {
    readonly request: WalletDelegatedChargeRequest;
    readonly operationId: WalletOperationId;
    readonly utcDay: string;
    readonly auditEventId: string;
  }) => Effect.Effect<WalletSpendReservationResult, WalletRepositoryError>;
  readonly getDelegatedSpend: (
    workspaceId: WorkspaceId,
    reservationId: WalletSpendReservationId,
  ) => Effect.Effect<WalletDelegatedSpendReservation | undefined, WalletRepositoryError>;
  readonly recordDelegatedSpendEvidence: (input: {
    readonly workspaceId: WorkspaceId;
    readonly reservationId: WalletSpendReservationId;
    readonly evidence: WalletProviderEffectEvidence;
    readonly auditEventId: string;
  }) => Effect.Effect<WalletSpendEvidenceResult, WalletRepositoryError>;
  readonly listAudit: (
    workspaceId: WorkspaceId,
    walletId: WalletId,
  ) => Effect.Effect<ReadonlyArray<WalletAuditRecord>, WalletRepositoryError>;
}

interface OperationRow extends QueryResultRow {
  readonly workspace_id: string;
  readonly operation_id: string;
  readonly wallet_id: string;
  readonly operation_kind: WalletOperationKind;
  readonly state: WalletOperationState;
  readonly idempotency_key: string;
  readonly request_fingerprint: string;
  readonly provider_activity_ref: string | null;
  readonly tx_hash: string | null;
  readonly amount_micro_usdc: string | null;
  readonly destination: string | null;
  readonly requested_at: string;
  readonly completed_at: string | null;
  readonly error_code: string | null;
}

interface WalletRow extends QueryResultRow {
  readonly workspace_id: string;
  readonly wallet_id: string;
  readonly owner_user_id: string;
  readonly provider_organization_ref: string;
  readonly provider_wallet_ref: string;
  readonly evm_address: string;
  readonly state: UserOwnedWallet["state"];
  readonly recovery_enabled: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ProvisionIntentRow extends QueryResultRow {
  readonly workspace_id: string;
  readonly owner_user_id: string;
  readonly wallet_id: string;
  readonly operation_id: string;
  readonly request_fingerprint: string;
  readonly state: "pending" | "completed" | "failed";
  readonly provider_activity_ref: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface AuthorizationRow extends QueryResultRow {
  readonly workspace_id: string;
  readonly wallet_id: string;
  readonly authorization_id: string;
  readonly treasury_address: string;
  readonly per_charge_limit_micro_usdc: string;
  readonly daily_limit_micro_usdc: string;
  readonly starts_at: string;
  readonly expires_at: string;
  readonly policy_revision: number;
  readonly provider_policy_ref: string | null;
  readonly provider_delegated_user_ref: string | null;
  readonly provider_delegated_credential_ref: string | null;
  readonly state: WalletDelegatedAuthorization["state"];
  readonly created_at: string;
  readonly updated_at: string;
}

interface RecoveryRow extends QueryResultRow {
  readonly workspace_id: string;
  readonly wallet_id: string;
  readonly recovery_attempt_id: string;
  readonly state: WalletRecoveryMetadata["state"];
  readonly provider_activity_ref: string | null;
  readonly initiated_at: string;
  readonly expires_at: string;
  readonly completed_at: string | null;
  readonly failed_at: string | null;
}

interface RevocationRow extends QueryResultRow {
  readonly workspace_id: string;
  readonly wallet_id: string;
  readonly authorization_id: string;
  readonly operation_id: string;
  readonly provider_activity_ref: string;
  readonly provider_status: WalletProviderEffectEvidence["status"];
  readonly requested_at: string;
  readonly observed_at: string;
  readonly revoked_at: string | null;
}

interface DelegationConfigurationIntentRow extends QueryResultRow {
  readonly workspace_id: string;
  readonly wallet_id: string;
  readonly operation_id: string;
  readonly operation_kind: "delegationConfigure" | "recoveryComplete";
  readonly authorization_id: string | null;
  readonly request_fingerprint: string;
  readonly state: WalletDelegationConfigurationIntent["state"];
  readonly provider_activity_ref: string | null;
  readonly provider_status: WalletDelegationConfigurationEvidence["status"] | null;
  readonly provider_policy_ref: string | null;
  readonly provider_delegated_user_ref: string | null;
  readonly provider_delegated_credential_ref: string | null;
  readonly provider_observed_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface SpendRow extends QueryResultRow {
  readonly workspace_id: string;
  readonly wallet_id: string;
  readonly authorization_id: string;
  readonly reservation_id: string;
  readonly utc_day: string;
  readonly amount_micro_usdc: string;
  readonly state: WalletDelegatedSpendReservation["state"];
  readonly idempotency_key: string;
  readonly request_fingerprint: string;
  readonly provider_activity_ref: string | null;
  readonly provider_status: WalletProviderEffectEvidence["status"] | null;
  readonly provider_observed_at: string | null;
  readonly tx_hash: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface AuditRow extends QueryResultRow {
  readonly workspace_id: string;
  readonly audit_event_id: string;
  readonly wallet_id: string | null;
  readonly operation_id: string | null;
  readonly actor_user_id: string | null;
  readonly actor_auth_session_id: string | null;
  readonly event_kind: WalletAuditEventKind;
  readonly occurred_at: string;
}

const utcTimestamp = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const operationColumns = `workspace_id::text, operation_id, wallet_id, operation_kind, state,
  idempotency_key, request_fingerprint, provider_activity_ref, tx_hash,
  amount_micro_usdc::text, destination, ${utcTimestamp("requested_at")} AS requested_at,
  ${utcTimestamp("completed_at")} AS completed_at, error_code`;
const walletColumns = `workspace_id::text, wallet_id, owner_user_id, provider_organization_ref,
  provider_wallet_ref, evm_address, state, recovery_enabled,
  ${utcTimestamp("created_at")} AS created_at, ${utcTimestamp("updated_at")} AS updated_at`;
const provisionIntentColumns = `workspace_id::text, owner_user_id, wallet_id, operation_id,
  request_fingerprint, state, provider_activity_ref,
  ${utcTimestamp("created_at")} AS created_at, ${utcTimestamp("updated_at")} AS updated_at`;
const authorizationColumns = `workspace_id::text, wallet_id, authorization_id, treasury_address,
  per_charge_limit_micro_usdc::text, daily_limit_micro_usdc::text,
  ${utcTimestamp("starts_at")} AS starts_at, ${utcTimestamp("expires_at")} AS expires_at,
  policy_revision, provider_policy_ref, provider_delegated_user_ref,
  provider_delegated_credential_ref, state, ${utcTimestamp("created_at")} AS created_at,
  ${utcTimestamp("updated_at")} AS updated_at`;
const recoveryColumns = `workspace_id::text, wallet_id, recovery_attempt_id, state,
  provider_activity_ref, ${utcTimestamp("initiated_at")} AS initiated_at,
  ${utcTimestamp("expires_at")} AS expires_at,
  ${utcTimestamp("completed_at")} AS completed_at,
  ${utcTimestamp("failed_at")} AS failed_at`;
const revocationColumns = `workspace_id::text, wallet_id, authorization_id, operation_id,
  provider_activity_ref, provider_status, ${utcTimestamp("requested_at")} AS requested_at,
  ${utcTimestamp("observed_at")} AS observed_at, ${utcTimestamp("revoked_at")} AS revoked_at`;
const delegationConfigurationIntentColumns = `workspace_id::text, wallet_id, operation_id,
  operation_kind, authorization_id, request_fingerprint, state, provider_activity_ref,
  provider_status, provider_policy_ref, provider_delegated_user_ref,
  provider_delegated_credential_ref,
  ${utcTimestamp("provider_observed_at")} AS provider_observed_at,
  ${utcTimestamp("created_at")} AS created_at, ${utcTimestamp("updated_at")} AS updated_at`;
const spendColumns = `workspace_id::text, wallet_id, authorization_id, reservation_id,
  utc_day::text, amount_micro_usdc::text, state, idempotency_key, request_fingerprint,
  provider_activity_ref, provider_status,
  ${utcTimestamp("provider_observed_at")} AS provider_observed_at, tx_hash,
  ${utcTimestamp("created_at")} AS created_at, ${utcTimestamp("updated_at")} AS updated_at`;

const operationFromRow = (row: OperationRow): WalletOperationRecord => ({
  workspaceId: row.workspace_id as WorkspaceId,
  operationId: row.operation_id as WalletOperationId,
  walletId: row.wallet_id as WalletId,
  kind: row.operation_kind,
  state: row.state,
  idempotencyKey: row.idempotency_key as WalletIdempotencyKey,
  requestFingerprint: row.request_fingerprint as WalletRequestFingerprint,
  requestedAt: row.requested_at,
  ...(row.provider_activity_ref === null ? {} : { providerActivityRef: row.provider_activity_ref }),
  ...(row.tx_hash === null ? {} : { txHash: row.tx_hash as EvmTransactionHash }),
  ...(row.amount_micro_usdc === null
    ? {}
    : { amountMicroUsdc: Number(row.amount_micro_usdc) as MicroUsdc }),
  ...(row.destination === null ? {} : { destination: row.destination as EvmAddress }),
  ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  ...(row.error_code === null ? {} : { errorCode: row.error_code }),
});

const walletFromRow = (row: WalletRow): UserOwnedWallet => ({
  schemaVersion: 1,
  walletId: row.wallet_id as WalletId,
  workspaceId: row.workspace_id as WorkspaceId,
  ownerUserId: row.owner_user_id,
  provider: "turnkey",
  providerOrganizationRef: row.provider_organization_ref,
  providerWalletRef: row.provider_wallet_ref,
  address: row.evm_address as EvmAddress,
  state: row.state,
  recoveryMethod: "passkeyAndEmail",
  recoveryEnabled: row.recovery_enabled,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const authorizationFromRow = (row: AuthorizationRow): WalletDelegatedAuthorization => ({
  authorizationId: row.authorization_id as WalletDelegatedAuthorization["authorizationId"],
  walletId: row.wallet_id as WalletId,
  workspaceId: row.workspace_id as WorkspaceId,
  binding: MONAD_USDC_BINDING,
  treasuryAddress: row.treasury_address as EvmAddress,
  perChargeLimitMicroUsdc: Number(row.per_charge_limit_micro_usdc) as MicroUsdc,
  dailyLimitMicroUsdc: Number(row.daily_limit_micro_usdc) as MicroUsdc,
  startsAt: row.starts_at,
  expiresAt: row.expires_at,
  policyRevision: row.policy_revision,
  ...(row.provider_policy_ref === null ? {} : { providerPolicyRef: row.provider_policy_ref }),
  ...(row.provider_delegated_user_ref === null
    ? {}
    : { providerDelegatedUserRef: row.provider_delegated_user_ref }),
  ...(row.provider_delegated_credential_ref === null
    ? {}
    : { providerDelegatedCredentialRef: row.provider_delegated_credential_ref }),
  state: row.state,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const recoveryFromRow = (row: RecoveryRow): WalletRecoveryMetadata => ({
  recoveryAttemptId: row.recovery_attempt_id as WalletRecoveryAttemptId,
  walletId: row.wallet_id as WalletId,
  workspaceId: row.workspace_id as WorkspaceId,
  state: row.state,
  ...(row.provider_activity_ref === null ? {} : { providerActivityRef: row.provider_activity_ref }),
  initiatedAt: row.initiated_at,
  expiresAt: row.expires_at,
  ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  ...(row.failed_at === null ? {} : { failedAt: row.failed_at }),
});

const revocationFromRow = (row: RevocationRow): WalletDelegationRevocationRecord => ({
  workspaceId: row.workspace_id as WorkspaceId,
  walletId: row.wallet_id as WalletId,
  authorizationId: row.authorization_id as WalletDelegatedAuthorization["authorizationId"],
  operationId: row.operation_id as WalletOperationId,
  providerActivityRef: row.provider_activity_ref,
  providerStatus: row.provider_status,
  requestedAt: row.requested_at,
  observedAt: row.observed_at,
  ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
});

const delegationConfigurationIntentFromRow = (
  row: DelegationConfigurationIntentRow,
): WalletDelegationConfigurationIntent => ({
  workspaceId: row.workspace_id as WorkspaceId,
  walletId: row.wallet_id as WalletId,
  operationId: row.operation_id as WalletOperationId,
  operationKind: row.operation_kind,
  ...(row.authorization_id === null
    ? {}
    : {
        authorizationId: row.authorization_id as WalletDelegatedAuthorization["authorizationId"],
      }),
  requestFingerprint: row.request_fingerprint as WalletRequestFingerprint,
  state: row.state,
  ...(row.provider_status === null || row.provider_observed_at === null
    ? {}
    : {
        evidence: {
          status: row.provider_status,
          observedAt: row.provider_observed_at,
          ...(row.provider_activity_ref === null
            ? {}
            : { providerActivityRef: row.provider_activity_ref }),
          ...(row.provider_policy_ref === null
            ? {}
            : { providerPolicyRef: row.provider_policy_ref }),
          ...(row.provider_delegated_user_ref === null
            ? {}
            : { providerDelegatedUserRef: row.provider_delegated_user_ref }),
          ...(row.provider_delegated_credential_ref === null
            ? {}
            : { providerDelegatedCredentialRef: row.provider_delegated_credential_ref }),
        },
      }),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const spendFromRow = (row: SpendRow): WalletDelegatedSpendReservation => ({
  reservationId: row.reservation_id as WalletSpendReservationId,
  workspaceId: row.workspace_id as WorkspaceId,
  walletId: row.wallet_id as WalletId,
  authorizationId: row.authorization_id as WalletDelegatedAuthorization["authorizationId"],
  utcDay: row.utc_day,
  amountMicroUsdc: Number(row.amount_micro_usdc) as MicroUsdc,
  state: row.state,
  idempotencyKey: row.idempotency_key as WalletIdempotencyKey,
  requestFingerprint: row.request_fingerprint as WalletRequestFingerprint,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.tx_hash === null ? {} : { txHash: row.tx_hash as EvmTransactionHash }),
  ...(row.provider_activity_ref === null ? {} : { providerActivityRef: row.provider_activity_ref }),
  ...(row.provider_status === null ? {} : { providerStatus: row.provider_status }),
  ...(row.provider_observed_at === null ? {} : { providerObservedAt: row.provider_observed_at }),
});

const auditFromRow = (row: AuditRow): WalletAuditRecord => ({
  workspaceId: row.workspace_id as WorkspaceId,
  auditEventId: row.audit_event_id,
  ...(row.wallet_id === null ? {} : { walletId: row.wallet_id as WalletId }),
  ...(row.operation_id === null ? {} : { operationId: row.operation_id as WalletOperationId }),
  ...(row.actor_user_id === null || row.actor_auth_session_id === null
    ? {}
    : {
        actor: {
          userId: row.actor_user_id,
          authSessionId: row.actor_auth_session_id as AuthSessionId,
        },
      }),
  eventKind: row.event_kind,
  occurredAt: row.occurred_at,
});

const failed = (
  operation: string,
  cause?: unknown,
  code: WalletRepositoryError["code"] = "databaseFailure",
  retryable = code === "databaseFailure",
) =>
  new WalletRepositoryError({
    operation,
    code,
    retryable,
    ...(cause === undefined ? {} : { cause }),
  });

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
  use: (client: PoolClient) => Effect.Effect<A, WalletRepositoryError>,
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

const insertAudit = (client: PoolClient, record: WalletAuditRecord) =>
  query(
    client,
    "insert-wallet-audit",
    `INSERT INTO cloud_wallet_audit_event (
       workspace_id, audit_event_id, wallet_id, operation_id, actor_user_id,
       actor_auth_session_id, event_kind, occurred_at
     ) VALUES ($1,$2::uuid,$3,$4,$5,$6,$7,$8::timestamptz)`,
    [
      record.workspaceId,
      record.auditEventId,
      record.walletId ?? null,
      record.operationId ?? null,
      record.actor?.userId ?? null,
      record.actor?.authSessionId ?? null,
      record.eventKind,
      record.occurredAt,
    ],
  ).pipe(Effect.asVoid);

const updateOperationSucceeded = (
  client: PoolClient,
  operation: WalletOperationRecord,
  completedAt: string,
  providerActivityRef?: string,
  txHash?: EvmTransactionHash,
) =>
  query<OperationRow>(
    client,
    "complete-wallet-operation",
    `UPDATE cloud_wallet_operation
       SET state = 'succeeded', completed_at = $3::timestamptz,
           provider_activity_ref = COALESCE($4, provider_activity_ref),
           tx_hash = COALESCE($5, tx_hash)
     WHERE workspace_id = $1 AND operation_id = $2 AND state = 'pending'
     RETURNING ${operationColumns}`,
    [
      operation.workspaceId,
      operation.operationId,
      completedAt,
      providerActivityRef ?? null,
      txHash ?? null,
    ],
  ).pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.fail(failed("complete-wallet-operation", undefined, "stateConflict", false))
        : Effect.succeed(operationFromRow(rows[0])),
    ),
  );

export const makePostgresWalletRepository = (pool: Pool): WalletRepository => ({
  reserveProvision: ({ operation, ownerUserId }) =>
    transaction(pool, "reserve-wallet-provision", (client) =>
      Effect.gen(function* () {
        yield* query(
          client,
          "lock-wallet-owner-provision",
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [
            `${operation.workspaceId.length}:${operation.workspaceId}${ownerUserId.length}:${ownerUserId}`,
          ],
        );
        const wallets = yield* query<WalletRow>(
          client,
          "find-wallet-by-owner",
          `SELECT ${walletColumns} FROM cloud_wallet
           WHERE workspace_id = $1 AND owner_user_id = $2`,
          [operation.workspaceId, ownerUserId],
        );
        if (wallets[0] !== undefined) {
          return { disposition: "duplicate" as const, wallet: walletFromRow(wallets[0]) };
        }

        const intents = yield* query<ProvisionIntentRow>(
          client,
          "lock-wallet-provision-intent",
          `SELECT ${provisionIntentColumns} FROM cloud_wallet_provisioning_intent
           WHERE workspace_id = $1 AND owner_user_id = $2 FOR UPDATE`,
          [operation.workspaceId, ownerUserId],
        );
        const intent = intents[0];
        if (intent?.state === "pending") {
          if (
            intent.operation_id !== operation.operationId ||
            intent.wallet_id !== operation.walletId ||
            intent.request_fingerprint !== operation.requestFingerprint
          ) {
            return yield* failed("reserve-wallet-provision", undefined, "operationPending", true);
          }
          const operations = yield* query<OperationRow>(
            client,
            "get-pending-wallet-provision-operation",
            `SELECT ${operationColumns} FROM cloud_wallet_operation
             WHERE workspace_id = $1 AND operation_id = $2`,
            [operation.workspaceId, operation.operationId],
          );
          if (operations[0] === undefined) {
            return yield* failed("reserve-wallet-provision", undefined, "stateConflict", false);
          }
          return {
            disposition: "duplicate" as const,
            operation: operationFromRow(operations[0]),
          };
        }
        if (intent?.state === "completed") {
          return yield* failed("reserve-wallet-provision", undefined, "stateConflict", false);
        }

        const existingOperations = yield* query<OperationRow>(
          client,
          "find-wallet-provision-idempotency",
          `SELECT ${operationColumns} FROM cloud_wallet_operation
           WHERE workspace_id = $1 AND idempotency_key = $2`,
          [operation.workspaceId, operation.idempotencyKey],
        );
        if (existingOperations[0] !== undefined) {
          const existing = operationFromRow(existingOperations[0]);
          if (
            existing.requestFingerprint !== operation.requestFingerprint ||
            existing.kind !== "provision" ||
            existing.walletId !== operation.walletId
          ) {
            return yield* failed(
              "reserve-wallet-provision",
              undefined,
              "idempotencyConflict",
              false,
            );
          }
          return { disposition: "duplicate" as const, operation: existing };
        }

        const operations = yield* query<OperationRow>(
          client,
          "insert-wallet-provision-operation",
          `INSERT INTO cloud_wallet_operation (
             workspace_id, operation_id, wallet_id, operation_kind, state, idempotency_key,
             request_fingerprint, requested_at
           ) VALUES ($1,$2,$3,'provision','pending',$4,$5,$6::timestamptz)
           RETURNING ${operationColumns}`,
          [
            operation.workspaceId,
            operation.operationId,
            operation.walletId,
            operation.idempotencyKey,
            operation.requestFingerprint,
            operation.requestedAt,
          ],
        );
        yield* query(
          client,
          "upsert-wallet-provision-intent",
          `INSERT INTO cloud_wallet_provisioning_intent (
             workspace_id, owner_user_id, wallet_id, operation_id, request_fingerprint,
             state, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,'pending',$6::timestamptz,$6::timestamptz)
           ON CONFLICT (workspace_id, owner_user_id) DO UPDATE SET
             wallet_id = EXCLUDED.wallet_id,
             operation_id = EXCLUDED.operation_id,
             request_fingerprint = EXCLUDED.request_fingerprint,
             state = 'pending',
             provider_activity_ref = NULL,
             updated_at = EXCLUDED.updated_at
           WHERE cloud_wallet_provisioning_intent.state = 'failed'`,
          [
            operation.workspaceId,
            ownerUserId,
            operation.walletId,
            operation.operationId,
            operation.requestFingerprint,
            operation.requestedAt,
          ],
        );
        return {
          disposition: "reserved" as const,
          operation: operationFromRow(operations[0]!),
        };
      }),
    ),
  reserveOperation: (operation) =>
    transaction(pool, "reserve-wallet-operation", (client) =>
      Effect.gen(function* () {
        yield* query(
          client,
          "lock-wallet-operation",
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [
            `${operation.workspaceId.length}:${operation.workspaceId}${operation.idempotencyKey.length}:${operation.idempotencyKey}`,
          ],
        );
        const existing = yield* query<OperationRow>(
          client,
          "find-wallet-operation-idempotency",
          `SELECT ${operationColumns} FROM cloud_wallet_operation
           WHERE workspace_id = $1 AND idempotency_key = $2`,
          [operation.workspaceId, operation.idempotencyKey],
        );
        if (existing[0] !== undefined) {
          const record = operationFromRow(existing[0]);
          if (
            record.requestFingerprint !== operation.requestFingerprint ||
            record.kind !== operation.kind ||
            record.walletId !== operation.walletId
          ) {
            return yield* failed(
              "reserve-wallet-operation",
              undefined,
              "idempotencyConflict",
              false,
            );
          }
          return { disposition: "duplicate" as const, operation: record };
        }
        const rows = yield* query<OperationRow>(
          client,
          "insert-wallet-operation",
          `INSERT INTO cloud_wallet_operation (
             workspace_id, operation_id, wallet_id, operation_kind, state, idempotency_key,
             request_fingerprint, amount_micro_usdc, destination, requested_at
           ) VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9::timestamptz)
           RETURNING ${operationColumns}`,
          [
            operation.workspaceId,
            operation.operationId,
            operation.walletId,
            operation.kind,
            operation.idempotencyKey,
            operation.requestFingerprint,
            operation.amountMicroUsdc ?? null,
            operation.destination ?? null,
            operation.requestedAt,
          ],
        );
        return { disposition: "reserved" as const, operation: operationFromRow(rows[0]!) };
      }),
    ),
  getOperation: (workspaceId, operationId) =>
    query<OperationRow>(
      pool,
      "get-wallet-operation",
      `SELECT ${operationColumns} FROM cloud_wallet_operation
       WHERE workspace_id = $1 AND operation_id = $2`,
      [workspaceId, operationId],
    ).pipe(Effect.map((rows) => (rows[0] === undefined ? undefined : operationFromRow(rows[0])))),
  failOperation: (input) =>
    transaction(pool, "fail-wallet-operation", (client) =>
      Effect.gen(function* () {
        const rows = yield* query<OperationRow>(
          client,
          "fail-wallet-operation",
          `UPDATE cloud_wallet_operation
             SET state = 'failed', completed_at = $3::timestamptz, error_code = $4
           WHERE workspace_id = $1 AND operation_id = $2 AND state = 'pending'
           RETURNING ${operationColumns}`,
          [input.workspaceId, input.operationId, input.failedAt, input.errorCode],
        );
        if (rows[0] === undefined) {
          return yield* failed("fail-wallet-operation", undefined, "stateConflict", false);
        }
        if (rows[0].operation_kind === "provision") {
          yield* query(
            client,
            "fail-wallet-provision-intent",
            `UPDATE cloud_wallet_provisioning_intent
               SET state = 'failed', updated_at = $3::timestamptz
             WHERE workspace_id = $1 AND operation_id = $2 AND state = 'pending'`,
            [input.workspaceId, input.operationId, input.failedAt],
          );
        }
        if (
          rows[0].operation_kind === "delegationConfigure" ||
          rows[0].operation_kind === "recoveryComplete"
        ) {
          yield* query(
            client,
            "fail-wallet-delegation-configuration-intent",
            `UPDATE cloud_wallet_delegation_configuration_intent
               SET state = 'failed', updated_at = $3::timestamptz
             WHERE workspace_id = $1 AND operation_id = $2
               AND state IN ('reserved', 'attempting')`,
            [input.workspaceId, input.operationId, input.failedAt],
          );
        }
        yield* insertAudit(client, {
          workspaceId: input.workspaceId,
          auditEventId: input.auditEventId,
          walletId: input.walletId,
          operationId: input.operationId,
          eventKind: "operationFailed",
          occurredAt: input.failedAt,
        });
        return operationFromRow(rows[0]);
      }),
    ),
  completeProvision: (input) =>
    transaction(pool, "complete-wallet-provision", (client) =>
      Effect.gen(function* () {
        const walletRows = yield* query<WalletRow>(
          client,
          "insert-wallet",
          `INSERT INTO cloud_wallet (
             workspace_id, wallet_id, owner_user_id, provider, provider_organization_ref,
             provider_wallet_ref, evm_address, state, recovery_method, recovery_enabled,
             created_at, updated_at
           ) VALUES ($1,$2,$3,'turnkey',$4,$5,$6,'active','passkeyAndEmail',true,
             $7::timestamptz,$8::timestamptz)
           ON CONFLICT (workspace_id, wallet_id) DO UPDATE SET
             updated_at = EXCLUDED.updated_at
           WHERE cloud_wallet.provider_organization_ref = EXCLUDED.provider_organization_ref
             AND cloud_wallet.provider_wallet_ref = EXCLUDED.provider_wallet_ref
             AND lower(cloud_wallet.evm_address) = lower(EXCLUDED.evm_address)
           RETURNING ${walletColumns}`,
          [
            input.wallet.workspaceId,
            input.wallet.walletId,
            input.wallet.ownerUserId,
            input.wallet.providerOrganizationRef,
            input.wallet.providerWalletRef,
            input.wallet.address,
            input.wallet.createdAt,
            input.wallet.updatedAt,
          ],
        );
        if (walletRows[0] === undefined) {
          return yield* failed("insert-wallet", undefined, "stateConflict", false);
        }
        const intents = yield* query<ProvisionIntentRow>(
          client,
          "complete-wallet-provision-intent",
          `UPDATE cloud_wallet_provisioning_intent
             SET state = 'completed', provider_activity_ref = $3,
                 updated_at = $4::timestamptz
           WHERE workspace_id = $1 AND operation_id = $2 AND wallet_id = $5
             AND state = 'pending'
           RETURNING ${provisionIntentColumns}`,
          [
            input.wallet.workspaceId,
            input.operation.operationId,
            input.providerActivityRef,
            input.wallet.updatedAt,
            input.wallet.walletId,
          ],
        );
        if (intents[0] === undefined) {
          return yield* failed(
            "complete-wallet-provision-intent",
            undefined,
            "stateConflict",
            false,
          );
        }
        yield* updateOperationSucceeded(
          client,
          input.operation,
          input.wallet.updatedAt,
          input.providerActivityRef,
        );
        yield* insertAudit(client, {
          workspaceId: input.wallet.workspaceId,
          auditEventId: input.auditEventId,
          walletId: input.wallet.walletId,
          operationId: input.operation.operationId,
          actor: input.actor,
          eventKind: "walletProvisioned",
          occurredAt: input.wallet.updatedAt,
        });
        return walletFromRow(walletRows[0]);
      }),
    ),
  getWallet: (workspaceId, walletId) =>
    query<WalletRow>(
      pool,
      "get-wallet",
      `SELECT ${walletColumns} FROM cloud_wallet WHERE workspace_id = $1 AND wallet_id = $2`,
      [workspaceId, walletId],
    ).pipe(Effect.map((rows) => (rows[0] === undefined ? undefined : walletFromRow(rows[0])))),
  reserveDelegationConfiguration: ({ operation, authorization: requestedAuthorization }) =>
    transaction(pool, "reserve-wallet-delegation-configuration", (client) =>
      Effect.gen(function* () {
        const authorizationId = requestedAuthorization?.authorizationId;
        if (
          (operation.kind === "delegationConfigure" && authorizationId === undefined) ||
          (operation.kind === "recoveryComplete" && authorizationId !== undefined) ||
          (operation.kind !== "delegationConfigure" && operation.kind !== "recoveryComplete")
        ) {
          return yield* failed(
            "reserve-wallet-delegation-configuration",
            undefined,
            "policyViolation",
            false,
          );
        }
        yield* query(
          client,
          "lock-wallet-delegation-configuration",
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [
            `${operation.workspaceId.length}:${operation.workspaceId}${operation.walletId.length}:${operation.walletId}`,
          ],
        );
        if (authorizationId !== undefined) {
          const authorizations = yield* query<AuthorizationRow>(
            client,
            "find-existing-wallet-delegation-configuration",
            `SELECT ${authorizationColumns} FROM cloud_wallet_delegated_authorization
             WHERE workspace_id = $1 AND wallet_id = $2 AND authorization_id = $3`,
            [operation.workspaceId, operation.walletId, authorizationId],
          );
          if (authorizations[0] !== undefined) {
            const existingAuthorization = authorizationFromRow(authorizations[0]);
            if (
              requestedAuthorization === undefined ||
              existingAuthorization.state !== "active" ||
              existingAuthorization.treasuryAddress !== requestedAuthorization.treasuryAddress ||
              existingAuthorization.perChargeLimitMicroUsdc !==
                requestedAuthorization.perChargeLimitMicroUsdc ||
              existingAuthorization.dailyLimitMicroUsdc !==
                requestedAuthorization.dailyLimitMicroUsdc ||
              existingAuthorization.startsAt !== requestedAuthorization.startsAt ||
              existingAuthorization.expiresAt !== requestedAuthorization.expiresAt ||
              existingAuthorization.policyRevision !== requestedAuthorization.policyRevision
            ) {
              return yield* failed(
                "reserve-wallet-delegation-configuration",
                undefined,
                "idempotencyConflict",
                false,
              );
            }
            return {
              disposition: "duplicate" as const,
              authorization: existingAuthorization,
            };
          }
        }
        const pending = yield* query<DelegationConfigurationIntentRow>(
          client,
          "find-pending-wallet-delegation-configuration",
          `SELECT ${delegationConfigurationIntentColumns}
           FROM cloud_wallet_delegation_configuration_intent
           WHERE workspace_id = $1 AND wallet_id = $2
             AND state IN ('reserved', 'attempting', 'providerApplied')
           FOR UPDATE`,
          [operation.workspaceId, operation.walletId],
        );
        if (pending[0] !== undefined) {
          const intent = delegationConfigurationIntentFromRow(pending[0]);
          if (
            intent.operationId !== operation.operationId ||
            intent.requestFingerprint !== operation.requestFingerprint ||
            intent.authorizationId !== authorizationId ||
            intent.operationKind !== operation.kind
          ) {
            return yield* failed(
              "reserve-wallet-delegation-configuration",
              undefined,
              "operationPending",
              true,
            );
          }
          const operations = yield* query<OperationRow>(
            client,
            "get-wallet-delegation-configuration-operation",
            `SELECT ${operationColumns} FROM cloud_wallet_operation
             WHERE workspace_id = $1 AND operation_id = $2`,
            [operation.workspaceId, operation.operationId],
          );
          if (operations[0] === undefined) {
            return yield* failed(
              "reserve-wallet-delegation-configuration",
              undefined,
              "stateConflict",
              false,
            );
          }
          return {
            disposition: "duplicate" as const,
            operation: operationFromRow(operations[0]),
            intent,
          };
        }
        const existingOperations = yield* query<OperationRow>(
          client,
          "find-wallet-delegation-configuration-idempotency",
          `SELECT ${operationColumns} FROM cloud_wallet_operation
           WHERE workspace_id = $1 AND (idempotency_key = $2 OR operation_id = $3)`,
          [operation.workspaceId, operation.idempotencyKey, operation.operationId],
        );
        if (existingOperations[0] !== undefined) {
          const existing = operationFromRow(existingOperations[0]);
          if (
            existing.operationId !== operation.operationId ||
            existing.idempotencyKey !== operation.idempotencyKey ||
            existing.requestFingerprint !== operation.requestFingerprint ||
            existing.kind !== operation.kind ||
            existing.walletId !== operation.walletId
          ) {
            return yield* failed(
              "reserve-wallet-delegation-configuration",
              undefined,
              "idempotencyConflict",
              false,
            );
          }
          const intents = yield* query<DelegationConfigurationIntentRow>(
            client,
            "get-wallet-delegation-configuration-intent",
            `SELECT ${delegationConfigurationIntentColumns}
             FROM cloud_wallet_delegation_configuration_intent
             WHERE workspace_id = $1 AND operation_id = $2`,
            [operation.workspaceId, operation.operationId],
          );
          return {
            disposition: "duplicate" as const,
            operation: existing,
            ...(intents[0] === undefined
              ? {}
              : { intent: delegationConfigurationIntentFromRow(intents[0]) }),
          };
        }
        const operations = yield* query<OperationRow>(
          client,
          "insert-wallet-delegation-configuration-operation",
          `INSERT INTO cloud_wallet_operation (
             workspace_id, operation_id, wallet_id, operation_kind, state,
             idempotency_key, request_fingerprint, requested_at
           ) VALUES ($1,$2,$3,$4,'pending',$5,$6,$7::timestamptz)
           RETURNING ${operationColumns}`,
          [
            operation.workspaceId,
            operation.operationId,
            operation.walletId,
            operation.kind,
            operation.idempotencyKey,
            operation.requestFingerprint,
            operation.requestedAt,
          ],
        );
        const intents = yield* query<DelegationConfigurationIntentRow>(
          client,
          "insert-wallet-delegation-configuration-intent",
          `INSERT INTO cloud_wallet_delegation_configuration_intent (
             workspace_id, wallet_id, operation_id, operation_kind, authorization_id,
             request_fingerprint, state, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,'reserved',$7::timestamptz,$7::timestamptz)
           RETURNING ${delegationConfigurationIntentColumns}`,
          [
            operation.workspaceId,
            operation.walletId,
            operation.operationId,
            operation.kind,
            authorizationId ?? null,
            operation.requestFingerprint,
            operation.requestedAt,
          ],
        );
        return {
          disposition: "reserved" as const,
          operation: operationFromRow(operations[0]!),
          intent: delegationConfigurationIntentFromRow(intents[0]!),
        };
      }),
    ),
  beginDelegationConfigurationAttempt: ({ operation, attemptedAt }) =>
    transaction(pool, "begin-wallet-delegation-configuration-attempt", (client) =>
      query<DelegationConfigurationIntentRow>(
        client,
        "begin-wallet-delegation-configuration-attempt",
        `UPDATE cloud_wallet_delegation_configuration_intent
           SET state = 'attempting', updated_at = $3::timestamptz
         WHERE workspace_id = $1 AND operation_id = $2 AND state = 'reserved'
         RETURNING ${delegationConfigurationIntentColumns}`,
        [operation.workspaceId, operation.operationId, attemptedAt],
      ).pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined
            ? Effect.fail(
                failed(
                  "begin-wallet-delegation-configuration-attempt",
                  undefined,
                  "stateConflict",
                  false,
                ),
              )
            : Effect.succeed(delegationConfigurationIntentFromRow(rows[0])),
        ),
      ),
    ),
  recordDelegationConfigurationEvidence: ({ operation, evidence }) =>
    transaction(pool, "record-wallet-delegation-configuration-evidence", (client) =>
      Effect.gen(function* () {
        const rows = yield* query<DelegationConfigurationIntentRow>(
          client,
          "lock-wallet-delegation-configuration-evidence",
          `SELECT ${delegationConfigurationIntentColumns}
           FROM cloud_wallet_delegation_configuration_intent
           WHERE workspace_id = $1 AND operation_id = $2 FOR UPDATE`,
          [operation.workspaceId, operation.operationId],
        );
        if (rows[0] === undefined) {
          return yield* failed(
            "record-wallet-delegation-configuration-evidence",
            undefined,
            "notFound",
            false,
          );
        }
        const current = delegationConfigurationIntentFromRow(rows[0]);
        const currentEvidence = current.evidence;
        const conflicts =
          (currentEvidence?.providerActivityRef !== undefined &&
            currentEvidence.providerActivityRef !== evidence.providerActivityRef) ||
          (currentEvidence?.providerPolicyRef !== undefined &&
            currentEvidence.providerPolicyRef !== evidence.providerPolicyRef) ||
          (currentEvidence?.providerDelegatedUserRef !== undefined &&
            currentEvidence.providerDelegatedUserRef !== evidence.providerDelegatedUserRef) ||
          (currentEvidence?.providerDelegatedCredentialRef !== undefined &&
            currentEvidence.providerDelegatedCredentialRef !==
              evidence.providerDelegatedCredentialRef);
        if (conflicts || current.state === "completed" || current.state === "failed") {
          return yield* failed(
            "record-wallet-delegation-configuration-evidence",
            undefined,
            "stateConflict",
            false,
          );
        }
        if (
          evidence.status === "applied" &&
          (evidence.providerActivityRef === undefined ||
            evidence.providerPolicyRef === undefined ||
            evidence.providerDelegatedUserRef === undefined ||
            evidence.providerDelegatedCredentialRef === undefined)
        ) {
          return yield* failed(
            "record-wallet-delegation-configuration-evidence",
            undefined,
            "policyViolation",
            false,
          );
        }
        const nextState =
          evidence.status === "applied"
            ? "providerApplied"
            : evidence.status === "notApplied"
              ? "failed"
              : "attempting";
        const updated = yield* query<DelegationConfigurationIntentRow>(
          client,
          "update-wallet-delegation-configuration-evidence",
          `UPDATE cloud_wallet_delegation_configuration_intent
             SET state = $3,
                 provider_status = $4,
                 provider_activity_ref = COALESCE($5, provider_activity_ref),
                 provider_policy_ref = COALESCE($6, provider_policy_ref),
                 provider_delegated_user_ref = COALESCE($7, provider_delegated_user_ref),
                 provider_delegated_credential_ref = COALESCE($8, provider_delegated_credential_ref),
                 provider_observed_at = $9::timestamptz,
                 updated_at = $9::timestamptz
           WHERE workspace_id = $1 AND operation_id = $2
             AND state IN ('reserved', 'attempting', 'providerApplied')
           RETURNING ${delegationConfigurationIntentColumns}`,
          [
            operation.workspaceId,
            operation.operationId,
            nextState,
            evidence.status,
            evidence.providerActivityRef ?? null,
            evidence.providerPolicyRef ?? null,
            evidence.providerDelegatedUserRef ?? null,
            evidence.providerDelegatedCredentialRef ?? null,
            evidence.observedAt,
          ],
        );
        if (updated[0] === undefined) {
          return yield* failed(
            "record-wallet-delegation-configuration-evidence",
            undefined,
            "stateConflict",
            false,
          );
        }
        return delegationConfigurationIntentFromRow(updated[0]);
      }),
    ),
  completeDelegation: (input) =>
    transaction(pool, "complete-wallet-delegation", (client) =>
      Effect.gen(function* () {
        const intents = yield* query<DelegationConfigurationIntentRow>(
          client,
          "guard-wallet-delegation-configuration-evidence",
          `SELECT ${delegationConfigurationIntentColumns}
           FROM cloud_wallet_delegation_configuration_intent
           WHERE workspace_id = $1 AND operation_id = $2 FOR UPDATE`,
          [input.operation.workspaceId, input.operation.operationId],
        );
        const intent =
          intents[0] === undefined ? undefined : delegationConfigurationIntentFromRow(intents[0]);
        if (
          intent?.state !== "providerApplied" ||
          intent.authorizationId !== input.authorization.authorizationId ||
          intent.evidence?.status !== "applied" ||
          intent.evidence.providerActivityRef !== input.provider.activityRef ||
          intent.evidence.providerPolicyRef !== input.provider.policyRef ||
          intent.evidence.providerDelegatedUserRef !== input.provider.delegatedUserRef ||
          intent.evidence.providerDelegatedCredentialRef !== input.provider.delegatedCredentialRef
        ) {
          return yield* failed(
            "guard-wallet-delegation-configuration-evidence",
            undefined,
            "stateConflict",
            false,
          );
        }
        const active = yield* query<AuthorizationRow>(
          client,
          "guard-wallet-delegation-replacement",
          `SELECT ${authorizationColumns} FROM cloud_wallet_delegated_authorization
           WHERE workspace_id = $1 AND wallet_id = $2 AND state = 'active'
           FOR UPDATE`,
          [input.authorization.workspaceId, input.authorization.walletId],
        );
        if (
          active[0] !== undefined &&
          active[0].authorization_id !== input.authorization.authorizationId
        ) {
          return yield* failed(
            "guard-wallet-delegation-replacement",
            undefined,
            "policyViolation",
            false,
          );
        }
        const rows = yield* query<AuthorizationRow>(
          client,
          "insert-wallet-delegation",
          `INSERT INTO cloud_wallet_delegated_authorization (
             workspace_id, wallet_id, authorization_id, chain_id, token_contract,
             treasury_address, per_charge_limit_micro_usdc, daily_limit_micro_usdc,
             starts_at, expires_at, policy_revision, provider_policy_ref,
             provider_delegated_user_ref, provider_delegated_credential_ref,
             state, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10::timestamptz,$11,
             $12,$13,$14,'active',$15::timestamptz,$16::timestamptz)
           RETURNING ${authorizationColumns}`,
          [
            input.authorization.workspaceId,
            input.authorization.walletId,
            input.authorization.authorizationId,
            MONAD_MAINNET_CHAIN_ID,
            MONAD_MAINNET_NATIVE_USDC,
            input.authorization.treasuryAddress,
            input.authorization.perChargeLimitMicroUsdc,
            input.authorization.dailyLimitMicroUsdc,
            input.authorization.startsAt,
            input.authorization.expiresAt,
            input.authorization.policyRevision,
            input.provider.policyRef,
            input.provider.delegatedUserRef,
            input.provider.delegatedCredentialRef,
            input.authorization.createdAt,
            input.completedAt,
          ],
        );
        yield* updateOperationSucceeded(
          client,
          input.operation,
          input.completedAt,
          input.provider.activityRef,
        );
        yield* query(
          client,
          "activate-wallet-after-delegation",
          `UPDATE cloud_wallet SET state = 'active', updated_at = $3::timestamptz
           WHERE workspace_id = $1 AND wallet_id = $2 AND state IN ('active', 'frozen')`,
          [input.authorization.workspaceId, input.authorization.walletId, input.completedAt],
        );
        yield* query(
          client,
          "complete-wallet-delegation-configuration-intent",
          `UPDATE cloud_wallet_delegation_configuration_intent
             SET state = 'completed', updated_at = $3::timestamptz
           WHERE workspace_id = $1 AND operation_id = $2 AND state = 'providerApplied'`,
          [input.operation.workspaceId, input.operation.operationId, input.completedAt],
        );
        yield* insertAudit(client, {
          workspaceId: input.authorization.workspaceId,
          auditEventId: input.auditEventId,
          walletId: input.authorization.walletId,
          operationId: input.operation.operationId,
          actor: input.actor,
          eventKind: "delegationConfigured",
          occurredAt: input.completedAt,
        });
        return authorizationFromRow(rows[0]!);
      }),
    ),
  getDelegatedAuthorization: (workspaceId, walletId, authorizationId) =>
    query<AuthorizationRow>(
      pool,
      "get-wallet-delegation",
      `SELECT ${authorizationColumns} FROM cloud_wallet_delegated_authorization
       WHERE workspace_id = $1 AND wallet_id = $2 AND authorization_id = $3`,
      [workspaceId, walletId, authorizationId],
    ).pipe(
      Effect.map((rows) => (rows[0] === undefined ? undefined : authorizationFromRow(rows[0]))),
    ),
  getActiveDelegatedAuthorization: (workspaceId, walletId) =>
    query<AuthorizationRow>(
      pool,
      "get-active-wallet-delegation",
      `SELECT ${authorizationColumns} FROM cloud_wallet_delegated_authorization
       WHERE workspace_id = $1 AND wallet_id = $2 AND state = 'active'`,
      [workspaceId, walletId],
    ).pipe(
      Effect.map((rows) => (rows[0] === undefined ? undefined : authorizationFromRow(rows[0]))),
    ),
  getDelegationRevocation: (workspaceId, walletId, authorizationId) =>
    query<RevocationRow>(
      pool,
      "get-wallet-delegation-revocation",
      `SELECT ${revocationColumns} FROM cloud_wallet_delegation_revocation
       WHERE workspace_id = $1 AND wallet_id = $2 AND authorization_id = $3`,
      [workspaceId, walletId, authorizationId],
    ).pipe(Effect.map((rows) => (rows[0] === undefined ? undefined : revocationFromRow(rows[0])))),
  recordDelegationRevocation: (input) =>
    transaction(pool, "record-wallet-delegation-revocation", (client) =>
      Effect.gen(function* () {
        const existing = yield* query<RevocationRow>(
          client,
          "lock-wallet-delegation-revocation",
          `SELECT ${revocationColumns} FROM cloud_wallet_delegation_revocation
           WHERE workspace_id = $1 AND wallet_id = $2 AND authorization_id = $3
           FOR UPDATE`,
          [
            input.authorization.workspaceId,
            input.authorization.walletId,
            input.authorization.authorizationId,
          ],
        );
        if (
          existing[0] !== undefined &&
          (existing[0].provider_activity_ref !== input.providerActivityRef ||
            existing[0].operation_id !== input.operation.operationId)
        ) {
          return yield* failed(
            "record-wallet-delegation-revocation",
            undefined,
            "stateConflict",
            false,
          );
        }
        if (existing[0]?.provider_status === "applied") {
          return revocationFromRow(existing[0]);
        }
        const rows = yield* query<RevocationRow>(
          client,
          "upsert-wallet-delegation-revocation",
          `INSERT INTO cloud_wallet_delegation_revocation (
             workspace_id, wallet_id, authorization_id, operation_id,
             provider_activity_ref, provider_status, requested_at, observed_at, revoked_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz,
             CASE WHEN $6 = 'applied' THEN $8::timestamptz ELSE NULL END)
           ON CONFLICT (workspace_id, wallet_id, authorization_id) DO UPDATE SET
             provider_status = EXCLUDED.provider_status,
             observed_at = EXCLUDED.observed_at,
             revoked_at = EXCLUDED.revoked_at
           RETURNING ${revocationColumns}`,
          [
            input.authorization.workspaceId,
            input.authorization.walletId,
            input.authorization.authorizationId,
            input.operation.operationId,
            input.providerActivityRef,
            input.providerStatus,
            input.requestedAt,
            input.observedAt,
          ],
        );
        if (input.providerStatus === "applied") {
          const authorizations = yield* query<AuthorizationRow>(
            client,
            "revoke-wallet-delegation",
            `UPDATE cloud_wallet_delegated_authorization
               SET state = 'revoked', updated_at = $4::timestamptz
             WHERE workspace_id = $1 AND wallet_id = $2 AND authorization_id = $3
               AND state IN ('active', 'revoked')
             RETURNING ${authorizationColumns}`,
            [
              input.authorization.workspaceId,
              input.authorization.walletId,
              input.authorization.authorizationId,
              input.observedAt,
            ],
          );
          if (authorizations[0] === undefined) {
            return yield* failed("revoke-wallet-delegation", undefined, "stateConflict", false);
          }
          yield* insertAudit(client, {
            workspaceId: input.authorization.workspaceId,
            auditEventId: input.auditEventId,
            walletId: input.authorization.walletId,
            operationId: input.operation.operationId,
            eventKind: "delegationRevoked",
            occurredAt: input.observedAt,
          });
        }
        return revocationFromRow(rows[0]!);
      }),
    ),
  completeRecoveryBegin: (input) =>
    transaction(pool, "complete-wallet-recovery-begin", (client) =>
      Effect.gen(function* () {
        yield* query(
          client,
          "expire-prior-wallet-recovery",
          `UPDATE cloud_wallet_recovery_attempt
             SET state = 'expired'
           WHERE workspace_id = $1 AND wallet_id = $2 AND state = 'initiated'`,
          [input.recovery.workspaceId, input.recovery.walletId],
        );
        const rows = yield* query<RecoveryRow>(
          client,
          "insert-wallet-recovery",
          `INSERT INTO cloud_wallet_recovery_attempt (
             workspace_id, wallet_id, recovery_attempt_id, state, provider_activity_ref,
             initiated_at, expires_at
           ) VALUES ($1,$2,$3,'initiated',$4,$5::timestamptz,$6::timestamptz)
           RETURNING ${recoveryColumns}`,
          [
            input.recovery.workspaceId,
            input.recovery.walletId,
            input.recovery.recoveryAttemptId,
            input.recovery.providerActivityRef ?? null,
            input.recovery.initiatedAt,
            input.recovery.expiresAt,
          ],
        );
        yield* query(
          client,
          "mark-wallet-recovery-pending",
          `UPDATE cloud_wallet SET state = 'recoveryPending', updated_at = $3::timestamptz
           WHERE workspace_id = $1 AND wallet_id = $2`,
          [input.recovery.workspaceId, input.recovery.walletId, input.recovery.initiatedAt],
        );
        yield* updateOperationSucceeded(
          client,
          input.operation,
          input.recovery.initiatedAt,
          input.recovery.providerActivityRef,
        );
        yield* insertAudit(client, {
          workspaceId: input.recovery.workspaceId,
          auditEventId: input.auditEventId,
          walletId: input.recovery.walletId,
          operationId: input.operation.operationId,
          actor: input.actor,
          eventKind: "recoveryInitiated",
          occurredAt: input.recovery.initiatedAt,
        });
        return recoveryFromRow(rows[0]!);
      }),
    ),
  completeRecovery: (input) =>
    transaction(pool, "complete-wallet-recovery", (client) =>
      Effect.gen(function* () {
        const intents = yield* query<DelegationConfigurationIntentRow>(
          client,
          "guard-wallet-recovery-delegation-intent",
          `SELECT ${delegationConfigurationIntentColumns}
           FROM cloud_wallet_delegation_configuration_intent
           WHERE workspace_id = $1 AND operation_id = $2
             AND operation_kind = 'recoveryComplete' AND state = 'reserved'
           FOR UPDATE`,
          [input.operation.workspaceId, input.operation.operationId],
        );
        if (intents[0] === undefined) {
          return yield* failed(
            "guard-wallet-recovery-delegation-intent",
            undefined,
            "stateConflict",
            false,
          );
        }
        const rows = yield* query<RecoveryRow>(
          client,
          "complete-wallet-recovery",
          `UPDATE cloud_wallet_recovery_attempt
             SET state = 'completed', completed_at = $4::timestamptz,
                 provider_activity_ref = $5
           WHERE workspace_id = $1 AND wallet_id = $2 AND recovery_attempt_id = $3
             AND state = 'initiated' AND expires_at > $4::timestamptz
           RETURNING ${recoveryColumns}`,
          [
            input.operation.workspaceId,
            input.operation.walletId,
            input.recoveryAttemptId,
            input.completedAt,
            input.providerActivityRef,
          ],
        );
        if (rows[0] === undefined) {
          return yield* failed("complete-wallet-recovery", undefined, "stateConflict", false);
        }
        yield* query(
          client,
          "freeze-recovered-wallet-until-reauthorized",
          `UPDATE cloud_wallet SET state = 'frozen', updated_at = $3::timestamptz
           WHERE workspace_id = $1 AND wallet_id = $2`,
          [input.operation.workspaceId, input.operation.walletId, input.completedAt],
        );
        yield* query(
          client,
          "complete-wallet-recovery-delegation-intent",
          `UPDATE cloud_wallet_delegation_configuration_intent
             SET state = 'completed', updated_at = $3::timestamptz
           WHERE workspace_id = $1 AND operation_id = $2 AND state = 'reserved'`,
          [input.operation.workspaceId, input.operation.operationId, input.completedAt],
        );
        yield* updateOperationSucceeded(
          client,
          input.operation,
          input.completedAt,
          input.providerActivityRef,
        );
        yield* insertAudit(client, {
          workspaceId: input.operation.workspaceId,
          auditEventId: input.auditEventId,
          walletId: input.operation.walletId,
          operationId: input.operation.operationId,
          actor: input.actor,
          eventKind: "recoveryCompleted",
          occurredAt: input.completedAt,
        });
        return recoveryFromRow(rows[0]);
      }),
    ),
  getRecovery: (workspaceId, recoveryAttemptId) =>
    query<RecoveryRow>(
      pool,
      "get-wallet-recovery",
      `SELECT ${recoveryColumns} FROM cloud_wallet_recovery_attempt
       WHERE workspace_id = $1 AND recovery_attempt_id = $2`,
      [workspaceId, recoveryAttemptId],
    ).pipe(Effect.map((rows) => (rows[0] === undefined ? undefined : recoveryFromRow(rows[0])))),
  completeWithdrawal: (input) =>
    transaction(pool, "complete-wallet-withdrawal", (client) =>
      Effect.gen(function* () {
        yield* updateOperationSucceeded(
          client,
          input.operation,
          input.transfer.submittedAt,
          undefined,
          input.transfer.txHash,
        );
        yield* insertAudit(client, {
          workspaceId: input.transfer.workspaceId,
          auditEventId: input.auditEventId,
          walletId: input.transfer.walletId,
          operationId: input.operation.operationId,
          actor: input.actor,
          eventKind: "withdrawalSubmitted",
          occurredAt: input.transfer.submittedAt,
        });
        return input.transfer;
      }),
    ),
  reserveDelegatedSpend: (input) =>
    transaction(pool, "reserve-wallet-spend", (client) =>
      Effect.gen(function* () {
        const duplicate = yield* query<SpendRow>(
          client,
          "find-wallet-spend-idempotency",
          `SELECT ${spendColumns} FROM cloud_wallet_spend_reservation
           WHERE workspace_id = $1 AND idempotency_key = $2`,
          [input.request.workspaceId, input.request.idempotencyKey],
        );
        if (duplicate[0] !== undefined) {
          const reservation = spendFromRow(duplicate[0]);
          if (
            reservation.requestFingerprint !== input.request.requestFingerprint ||
            reservation.walletId !== input.request.walletId ||
            reservation.authorizationId !== input.request.authorizationId
          ) {
            return yield* failed("reserve-wallet-spend", undefined, "idempotencyConflict", false);
          }
          return { disposition: "duplicate" as const, reservation };
        }
        const authorizations = yield* query<AuthorizationRow>(
          client,
          "lock-wallet-delegation",
          `SELECT ${authorizationColumns} FROM cloud_wallet_delegated_authorization
           WHERE workspace_id = $1 AND wallet_id = $2 AND authorization_id = $3
           FOR UPDATE`,
          [input.request.workspaceId, input.request.walletId, input.request.authorizationId],
        );
        if (authorizations[0] === undefined) {
          return yield* failed("reserve-wallet-spend", undefined, "notFound", false);
        }
        const authorization = authorizationFromRow(authorizations[0]);
        if (
          authorization.state !== "active" ||
          input.request.requestedAt < authorization.startsAt ||
          input.request.requestedAt >= authorization.expiresAt ||
          input.request.destination.toLowerCase() !== authorization.treasuryAddress.toLowerCase() ||
          input.request.binding.chainId !== MONAD_MAINNET_CHAIN_ID ||
          input.request.binding.tokenContract.toLowerCase() !==
            MONAD_MAINNET_NATIVE_USDC.toLowerCase() ||
          input.request.amountMicroUsdc > authorization.perChargeLimitMicroUsdc
        ) {
          return yield* failed("reserve-wallet-spend", undefined, "policyViolation", false);
        }
        const sums = yield* query<{ readonly amount: string }>(
          client,
          "sum-wallet-daily-spend",
          `SELECT COALESCE(SUM(amount_micro_usdc), 0)::text AS amount
           FROM cloud_wallet_spend_reservation
           WHERE workspace_id = $1 AND wallet_id = $2 AND authorization_id = $3
             AND utc_day = $4::date AND state IN ('reserved', 'submitted')`,
          [
            input.request.workspaceId,
            input.request.walletId,
            input.request.authorizationId,
            input.utcDay,
          ],
        );
        const spent = Number(sums[0]?.amount ?? "0");
        if (spent + input.request.amountMicroUsdc > authorization.dailyLimitMicroUsdc) {
          return yield* failed("reserve-wallet-spend", undefined, "dailyLimitExceeded", false);
        }
        const rows = yield* query<SpendRow>(
          client,
          "insert-wallet-spend-reservation",
          `INSERT INTO cloud_wallet_spend_reservation (
             workspace_id, wallet_id, authorization_id, reservation_id, utc_day,
             amount_micro_usdc, state, idempotency_key, request_fingerprint,
             created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5::date,$6,'reserved',$7,$8,$9::timestamptz,$9::timestamptz)
           RETURNING ${spendColumns}`,
          [
            input.request.workspaceId,
            input.request.walletId,
            input.request.authorizationId,
            input.request.reservationId,
            input.utcDay,
            input.request.amountMicroUsdc,
            input.request.idempotencyKey,
            input.request.requestFingerprint,
            input.request.requestedAt,
          ],
        );
        yield* insertAudit(client, {
          workspaceId: input.request.workspaceId,
          auditEventId: input.auditEventId,
          walletId: input.request.walletId,
          operationId: input.operationId,
          eventKind: "spendReserved",
          occurredAt: input.request.requestedAt,
        });
        return { disposition: "reserved" as const, reservation: spendFromRow(rows[0]!) };
      }),
    ),
  getDelegatedSpend: (workspaceId, reservationId) =>
    query<SpendRow>(
      pool,
      "get-wallet-spend",
      `SELECT ${spendColumns} FROM cloud_wallet_spend_reservation
       WHERE workspace_id = $1 AND reservation_id = $2`,
      [workspaceId, reservationId],
    ).pipe(Effect.map((rows) => (rows[0] === undefined ? undefined : spendFromRow(rows[0])))),
  recordDelegatedSpendEvidence: (input) =>
    transaction(pool, "record-wallet-spend-evidence", (client) =>
      Effect.gen(function* () {
        const rows = yield* query<SpendRow>(
          client,
          "lock-wallet-spend-evidence",
          `SELECT ${spendColumns} FROM cloud_wallet_spend_reservation
           WHERE workspace_id = $1 AND reservation_id = $2 FOR UPDATE`,
          [input.workspaceId, input.reservationId],
        );
        if (rows[0] === undefined) {
          return yield* failed("record-wallet-spend-evidence", undefined, "notFound", false);
        }
        const current = spendFromRow(rows[0]);
        if (
          current.providerActivityRef !== undefined &&
          current.providerActivityRef !== input.evidence.providerActivityRef
        ) {
          return yield* failed("record-wallet-spend-evidence", undefined, "stateConflict", false);
        }
        if (current.state !== "reserved") {
          const sameTerminalEvidence =
            current.providerStatus === input.evidence.status &&
            current.txHash === input.evidence.txHash;
          if (!sameTerminalEvidence) {
            return yield* failed("record-wallet-spend-evidence", undefined, "stateConflict", false);
          }
          return { disposition: "duplicate" as const, reservation: current };
        }
        if (input.evidence.status === "applied" && input.evidence.txHash === undefined) {
          return yield* failed("record-wallet-spend-evidence", undefined, "policyViolation", false);
        }
        const nextState =
          input.evidence.status === "applied"
            ? "submitted"
            : input.evidence.status === "notApplied"
              ? "released"
              : "reserved";
        const updated = yield* query<SpendRow>(
          client,
          "update-wallet-spend-evidence",
          `UPDATE cloud_wallet_spend_reservation
             SET state = $3,
                 provider_activity_ref = $4,
                 provider_status = $5,
                 provider_observed_at = $6::timestamptz,
                 tx_hash = $7,
                 updated_at = $6::timestamptz
           WHERE workspace_id = $1 AND reservation_id = $2 AND state = 'reserved'
           RETURNING ${spendColumns}`,
          [
            input.workspaceId,
            input.reservationId,
            nextState,
            input.evidence.providerActivityRef,
            input.evidence.status,
            input.evidence.observedAt,
            input.evidence.txHash ?? null,
          ],
        );
        if (updated[0] === undefined) {
          return yield* failed("update-wallet-spend-evidence", undefined, "stateConflict", false);
        }
        const reservation = spendFromRow(updated[0]);
        if (input.evidence.status !== "stillUnknown") {
          yield* insertAudit(client, {
            workspaceId: input.workspaceId,
            auditEventId: input.auditEventId,
            walletId: reservation.walletId,
            eventKind: input.evidence.status === "applied" ? "spendSubmitted" : "spendReleased",
            occurredAt: input.evidence.observedAt,
          });
        }
        return { disposition: "updated" as const, reservation };
      }),
    ),
  listAudit: (workspaceId, walletId) =>
    query<AuditRow>(
      pool,
      "list-wallet-audit",
      `SELECT workspace_id::text, audit_event_id::text, wallet_id, operation_id,
         actor_user_id, actor_auth_session_id, event_kind,
         ${utcTimestamp("occurred_at")} AS occurred_at
       FROM cloud_wallet_audit_event
       WHERE workspace_id = $1 AND wallet_id = $2
       ORDER BY occurred_at, audit_event_id`,
      [workspaceId, walletId],
    ).pipe(Effect.map((rows) => rows.map(auditFromRow))),
});
