-- Durable Monad USDC settlement saga over immutable H4 accruals.
-- This schema stores only public wallet identity and provider references, never signing credentials.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS cloud_usage_settlement_attempt (
  workspace_id uuid NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  settlement_id text NOT NULL CHECK (length(settlement_id) BETWEEN 1 AND 96),
  thread_id text NOT NULL,
  state text NOT NULL CHECK (state IN (
    'reserved', 'submission-pending', 'reconciliation-required', 'transfer-applied',
    'low-balance-pause-pending', 'low-balance-paused', 'finalized'
  )),
  trigger_kind text NOT NULL CHECK (trigger_kind IN (
    'five-minute-window', 'amount-threshold', 'sandbox-paused', 'sandbox-closed'
  )),
  wallet_id text NOT NULL,
  authorization_id text NOT NULL,
  wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-fA-F]{40}$'),
  treasury_address text NOT NULL CHECK (treasury_address ~ '^0x[0-9a-fA-F]{40}$'),
  first_pricing_sequence bigint NOT NULL CHECK (
    first_pricing_sequence BETWEEN 1 AND 9007199254740991
  ),
  last_pricing_sequence bigint NOT NULL CHECK (
    last_pricing_sequence BETWEEN first_pricing_sequence AND 9007199254740991
  ),
  accrual_count integer NOT NULL CHECK (accrual_count > 0),
  upstream_delta_micro_usdc bigint NOT NULL CHECK (
    upstream_delta_micro_usdc BETWEEN -9007199254740991 AND 9007199254740991
  ),
  markup_delta_micro_usdc bigint NOT NULL CHECK (
    markup_delta_micro_usdc BETWEEN -9007199254740991 AND 9007199254740991
  ),
  total_delta_micro_usdc bigint NOT NULL CHECK (
    total_delta_micro_usdc BETWEEN 1 AND 9007199254740991
  ),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  provider_activity_ref text CHECK (
    provider_activity_ref IS NULL OR length(provider_activity_ref) BETWEEN 1 AND 256
  ),
  tx_hash text CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  transfer_submitted_at timestamptz,
  failure_code text CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 96),
  processing_owner text CHECK (processing_owner IS NULL OR length(processing_owner) BETWEEN 1 AND 128),
  processing_lease_expires_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  finalized_at timestamptz,
  PRIMARY KEY (workspace_id, settlement_id),
  UNIQUE (workspace_id, request_fingerprint),
  UNIQUE (tx_hash),
  UNIQUE (workspace_id, settlement_id, thread_id),
  FOREIGN KEY (workspace_id, thread_id)
    REFERENCES cloud_thread (workspace_id, thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, wallet_id, authorization_id)
    REFERENCES cloud_wallet_delegated_authorization (
      workspace_id, wallet_id, authorization_id
    ) ON DELETE RESTRICT,
  CHECK (total_delta_micro_usdc = upstream_delta_micro_usdc + markup_delta_micro_usdc),
  CHECK (
    (processing_owner IS NULL AND processing_lease_expires_at IS NULL) OR
    (processing_owner IS NOT NULL AND processing_lease_expires_at IS NOT NULL)
  ),
  CHECK (
    (state IN ('transfer-applied', 'finalized') AND
      tx_hash IS NOT NULL AND transfer_submitted_at IS NOT NULL) OR
    (state NOT IN ('transfer-applied', 'finalized') AND
      tx_hash IS NULL AND transfer_submitted_at IS NULL)
  ),
  CHECK (
    (state = 'finalized' AND finalized_at IS NOT NULL AND processing_owner IS NULL) OR
    (state <> 'finalized' AND finalized_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS cloud_usage_settlement_recovery_idx
  ON cloud_usage_settlement_attempt (state, processing_lease_expires_at, created_at)
  WHERE state <> 'finalized' AND state <> 'low-balance-paused';

CREATE TABLE IF NOT EXISTS cloud_usage_settlement_item (
  workspace_id uuid NOT NULL,
  settlement_id text NOT NULL,
  thread_id text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  accrual_id text NOT NULL,
  sample_id text NOT NULL,
  environment_id text NOT NULL,
  sandbox_id text NOT NULL,
  evidence_id text NOT NULL,
  evidence_revision integer NOT NULL CHECK (evidence_revision > 0),
  evidence_payload_sha256 text NOT NULL CHECK (evidence_payload_sha256 ~ '^[0-9a-f]{64}$'),
  receipt_input_sha256 text NOT NULL CHECK (receipt_input_sha256 ~ '^[0-9a-f]{64}$'),
  pricing_sequence bigint NOT NULL CHECK (
    pricing_sequence BETWEEN 1 AND 9007199254740991
  ),
  interval_start timestamptz NOT NULL,
  interval_end timestamptz NOT NULL,
  upstream_delta_micro_usdc bigint NOT NULL CHECK (
    upstream_delta_micro_usdc BETWEEN -9007199254740991 AND 9007199254740991
  ),
  markup_delta_micro_usdc bigint NOT NULL CHECK (
    markup_delta_micro_usdc BETWEEN -9007199254740991 AND 9007199254740991
  ),
  total_delta_micro_usdc bigint NOT NULL CHECK (
    total_delta_micro_usdc BETWEEN -9007199254740991 AND 9007199254740991
  ),
  PRIMARY KEY (workspace_id, settlement_id, position),
  UNIQUE (workspace_id, accrual_id),
  UNIQUE (workspace_id, settlement_id, pricing_sequence),
  FOREIGN KEY (workspace_id, settlement_id, thread_id)
    REFERENCES cloud_usage_settlement_attempt (workspace_id, settlement_id, thread_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, accrual_id)
    REFERENCES cloud_usage_ledger_entry (workspace_id, accrual_id) ON DELETE RESTRICT,
  CHECK (interval_start < interval_end),
  CHECK (total_delta_micro_usdc = upstream_delta_micro_usdc + markup_delta_micro_usdc)
);

CREATE TABLE IF NOT EXISTS cloud_usage_settlement_receipt (
  workspace_id uuid NOT NULL,
  settlement_id text NOT NULL,
  thread_id text NOT NULL,
  payload jsonb NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  signature_algorithm text NOT NULL CHECK (length(signature_algorithm) BETWEEN 1 AND 96),
  signature_key_id text NOT NULL CHECK (length(signature_key_id) BETWEEN 1 AND 256),
  signature text NOT NULL CHECK (length(signature) BETWEEN 1 AND 8192),
  signed_at timestamptz NOT NULL,
  tx_hash text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, settlement_id),
  UNIQUE (payload_sha256),
  UNIQUE (tx_hash),
  FOREIGN KEY (workspace_id, settlement_id, thread_id)
    REFERENCES cloud_usage_settlement_attempt (workspace_id, settlement_id, thread_id)
    ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION agentsin_cloud_protect_settlement_attempt()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'finalized' THEN
    RAISE EXCEPTION 'finalized usage settlement is immutable';
  END IF;
  IF OLD.provider_activity_ref IS NOT NULL AND
     NEW.provider_activity_ref IS DISTINCT FROM OLD.provider_activity_ref THEN
    RAISE EXCEPTION 'settlement provider activity identity is immutable once observed';
  END IF;
  IF ROW(
    OLD.workspace_id, OLD.settlement_id, OLD.thread_id, OLD.trigger_kind,
    OLD.wallet_id, OLD.authorization_id, OLD.wallet_address, OLD.treasury_address,
    OLD.first_pricing_sequence, OLD.last_pricing_sequence, OLD.accrual_count,
    OLD.upstream_delta_micro_usdc, OLD.markup_delta_micro_usdc,
    OLD.total_delta_micro_usdc, OLD.request_fingerprint, OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.workspace_id, NEW.settlement_id, NEW.thread_id, NEW.trigger_kind,
    NEW.wallet_id, NEW.authorization_id, NEW.wallet_address, NEW.treasury_address,
    NEW.first_pricing_sequence, NEW.last_pricing_sequence, NEW.accrual_count,
    NEW.upstream_delta_micro_usdc, NEW.markup_delta_micro_usdc,
    NEW.total_delta_micro_usdc, NEW.request_fingerprint, NEW.created_at
  ) THEN
    RAISE EXCEPTION 'usage settlement monetary identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cloud_usage_settlement_attempt_protected
  ON cloud_usage_settlement_attempt;
CREATE TRIGGER cloud_usage_settlement_attempt_protected
  BEFORE UPDATE ON cloud_usage_settlement_attempt
  FOR EACH ROW EXECUTE FUNCTION agentsin_cloud_protect_settlement_attempt();

DROP TRIGGER IF EXISTS cloud_usage_settlement_item_immutable
  ON cloud_usage_settlement_item;
CREATE TRIGGER cloud_usage_settlement_item_immutable
  BEFORE UPDATE OR DELETE ON cloud_usage_settlement_item
  FOR EACH ROW EXECUTE FUNCTION agentsin_cloud_reject_usage_mutation();

DROP TRIGGER IF EXISTS cloud_usage_settlement_receipt_immutable
  ON cloud_usage_settlement_receipt;
CREATE TRIGGER cloud_usage_settlement_receipt_immutable
  BEFORE UPDATE OR DELETE ON cloud_usage_settlement_receipt
  FOR EACH ROW EXECUTE FUNCTION agentsin_cloud_reject_usage_mutation();

COMMIT;
