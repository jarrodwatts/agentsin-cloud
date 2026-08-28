-- Harden the durable Monad USDC settlement saga with generations and billing holds.
-- This schema stores only public wallet identity and provider references, never signing credentials.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_usage_settlement_attempt
  ADD COLUMN IF NOT EXISTS authorization_generation integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS provider_attempt_generation integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS next_submit_not_before timestamptz;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cloud_usage_settlement_attempt
     WHERE tx_hash IS NOT NULL
     GROUP BY lower(tx_hash) HAVING count(*) > 1
  ) OR EXISTS (
    SELECT 1 FROM cloud_usage_settlement_receipt
     GROUP BY lower(tx_hash) HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'case-variant settlement transaction hashes require operator reconciliation'
      USING ERRCODE = '23000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM cloud_usage_settlement_receipt
     WHERE tx_hash <> lower(tx_hash)
        OR payload->>'txHash' IS DISTINCT FROM lower(payload->>'txHash')
  ) THEN
    RAISE EXCEPTION 'noncanonical signed settlement receipt requires operator re-signing'
      USING ERRCODE = '23000';
  END IF;
END
$$;

UPDATE cloud_usage_settlement_attempt
   SET tx_hash = lower(tx_hash)
 WHERE tx_hash IS NOT NULL AND tx_hash <> lower(tx_hash);

ALTER TABLE cloud_usage_settlement_attempt
  DROP CONSTRAINT IF EXISTS cloud_usage_settlement_attempt_state_check,
  DROP CONSTRAINT IF EXISTS cloud_usage_settlement_attempt_tx_hash_check,
  DROP CONSTRAINT IF EXISTS cloud_usage_settlement_attempt_tx_hash_key,
  DROP CONSTRAINT IF EXISTS cloud_usage_settlement_attempt_authorization_generation_check,
  DROP CONSTRAINT IF EXISTS cloud_usage_settlement_attempt_provider_attempt_generation_check,
  DROP CONSTRAINT IF EXISTS cloud_usage_settlement_attempt_retry_window_check,
  ADD CONSTRAINT cloud_usage_settlement_attempt_state_check CHECK (state IN (
    'reserved', 'retry-waiting', 'submission-pending', 'reconciliation-required', 'transfer-applied',
    'low-balance-pause-pending', 'low-balance-paused', 'finalized'
  )),
  ADD CONSTRAINT cloud_usage_settlement_attempt_tx_hash_check CHECK (
    tx_hash IS NULL OR (tx_hash ~ '^0x[0-9a-f]{64}$' AND tx_hash = lower(tx_hash))
  ),
  ADD CONSTRAINT cloud_usage_settlement_attempt_authorization_generation_check
    CHECK (authorization_generation > 0),
  ADD CONSTRAINT cloud_usage_settlement_attempt_provider_attempt_generation_check
    CHECK (provider_attempt_generation > 0),
  ADD CONSTRAINT cloud_usage_settlement_attempt_retry_window_check CHECK (
    (state = 'retry-waiting' AND next_submit_not_before IS NOT NULL AND processing_owner IS NULL) OR
    (state <> 'retry-waiting' AND next_submit_not_before IS NULL)
  );

ALTER TABLE cloud_usage_settlement_receipt
  DROP CONSTRAINT IF EXISTS cloud_usage_settlement_receipt_tx_hash_check,
  DROP CONSTRAINT IF EXISTS cloud_usage_settlement_receipt_tx_hash_key,
  ADD CONSTRAINT cloud_usage_settlement_receipt_tx_hash_check
    CHECK (tx_hash ~ '^0x[0-9a-f]{64}$' AND tx_hash = lower(tx_hash));

CREATE UNIQUE INDEX IF NOT EXISTS cloud_usage_settlement_attempt_tx_hash_canonical
  ON cloud_usage_settlement_attempt (lower(tx_hash)) WHERE tx_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS cloud_usage_settlement_authorization_binding (
  workspace_id uuid NOT NULL,
  settlement_id text NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  wallet_id text NOT NULL,
  authorization_id text NOT NULL,
  wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-fA-F]{40}$'),
  treasury_address text NOT NULL CHECK (treasury_address ~ '^0x[0-9a-fA-F]{40}$'),
  bound_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, settlement_id, generation),
  FOREIGN KEY (workspace_id, settlement_id)
    REFERENCES cloud_usage_settlement_attempt (workspace_id, settlement_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, wallet_id, authorization_id)
    REFERENCES cloud_wallet_delegated_authorization (
      workspace_id, wallet_id, authorization_id
    ) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS cloud_usage_settlement_recovery_idx
  ON cloud_usage_settlement_attempt (state, processing_lease_expires_at, created_at)
  WHERE state <> 'finalized' AND state <> 'low-balance-paused';

CREATE TABLE IF NOT EXISTS cloud_usage_settlement_provider_attempt (
  workspace_id uuid NOT NULL,
  settlement_id text NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('submission-pending', 'unknown', 'not-applied', 'applied')),
  provider_activity_ref text CHECK (
    provider_activity_ref IS NULL OR length(provider_activity_ref) BETWEEN 1 AND 256
  ),
  tx_hash text CHECK (
    tx_hash IS NULL OR (tx_hash ~ '^0x[0-9a-f]{64}$' AND tx_hash = lower(tx_hash))
  ),
  transfer_submitted_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  closed_at timestamptz,
  PRIMARY KEY (workspace_id, settlement_id, generation),
  UNIQUE (idempotency_key),
  UNIQUE (provider_activity_ref),
  FOREIGN KEY (workspace_id, settlement_id)
    REFERENCES cloud_usage_settlement_attempt (workspace_id, settlement_id) ON DELETE RESTRICT,
  CHECK (
    (state = 'applied' AND provider_activity_ref IS NOT NULL AND tx_hash IS NOT NULL AND
      transfer_submitted_at IS NOT NULL AND closed_at IS NOT NULL) OR
    (state = 'not-applied' AND tx_hash IS NULL AND transfer_submitted_at IS NULL AND
      closed_at IS NOT NULL) OR
    (state = 'unknown' AND provider_activity_ref IS NOT NULL AND tx_hash IS NULL AND
      transfer_submitted_at IS NULL AND closed_at IS NULL) OR
    (state = 'submission-pending' AND tx_hash IS NULL AND transfer_submitted_at IS NULL AND
      closed_at IS NULL)
  )
);

INSERT INTO cloud_usage_settlement_authorization_binding (
  workspace_id, settlement_id, generation, wallet_id, authorization_id,
  wallet_address, treasury_address, bound_at
)
SELECT workspace_id, settlement_id, 1, wallet_id, authorization_id,
       wallet_address, treasury_address, created_at
  FROM cloud_usage_settlement_attempt
ON CONFLICT (workspace_id, settlement_id, generation) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cloud_usage_settlement_attempt
     WHERE state IN ('transfer-applied', 'finalized') AND provider_activity_ref IS NULL
  ) THEN
    RAISE EXCEPTION 'applied legacy settlement is missing its provider activity reference'
      USING ERRCODE = '23000';
  END IF;
END
$$;

INSERT INTO cloud_usage_settlement_provider_attempt (
  workspace_id, settlement_id, generation, idempotency_key, state,
  provider_activity_ref, tx_hash, transfer_submitted_at, created_at, updated_at, closed_at
)
SELECT workspace_id, settlement_id, 1, request_fingerprint,
       CASE
         WHEN state IN ('transfer-applied', 'finalized') THEN 'applied'
         WHEN state IN ('low-balance-pause-pending', 'low-balance-paused') THEN 'not-applied'
         WHEN provider_activity_ref IS NOT NULL THEN 'unknown'
         ELSE 'submission-pending'
       END,
       provider_activity_ref, tx_hash, transfer_submitted_at, created_at, updated_at,
       CASE
         WHEN state IN (
           'transfer-applied', 'finalized', 'low-balance-pause-pending', 'low-balance-paused'
         ) THEN updated_at
         ELSE NULL
       END
  FROM cloud_usage_settlement_attempt
 WHERE state <> 'reserved'
ON CONFLICT (workspace_id, settlement_id, generation) DO NOTHING;

UPDATE cloud_usage_settlement_attempt
   SET provider_attempt_generation = 2
 WHERE state = 'low-balance-paused' AND provider_attempt_generation = 1;

UPDATE cloud_usage_settlement_attempt
   SET state = 'reconciliation-required',
       failure_code = COALESCE(failure_code, 'legacy-submission-requires-reconciliation')
 WHERE state = 'submission-pending';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cloud_usage_settlement_attempt
     WHERE state IN (
       'reconciliation-required', 'low-balance-pause-pending', 'low-balance-paused'
     )
     GROUP BY workspace_id, thread_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'multiple legacy unsettled attempts for one thread require operator reconciliation'
      USING ERRCODE = '23000';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS cloud_usage_settlement_provider_tx_hash_canonical
  ON cloud_usage_settlement_provider_attempt (lower(tx_hash)) WHERE tx_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS cloud_usage_workspace_billing_fence (
  workspace_id uuid NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  fence_id text NOT NULL CHECK (length(fence_id) BETWEEN 1 AND 96),
  episode integer NOT NULL CHECK (episode > 0),
  source_thread_id text NOT NULL,
  settlement_id text,
  reason text NOT NULL CHECK (reason IN (
    'insufficient-balance', 'authorization-unavailable', 'provider-definitive-failure'
  )),
  state text NOT NULL CHECK (state IN ('active', 'cleared')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  cleared_at timestamptz,
  PRIMARY KEY (workspace_id, fence_id),
  UNIQUE (workspace_id, episode),
  FOREIGN KEY (workspace_id, source_thread_id)
    REFERENCES cloud_thread (workspace_id, thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, settlement_id, source_thread_id)
    REFERENCES cloud_usage_settlement_attempt (workspace_id, settlement_id, thread_id)
    ON DELETE RESTRICT,
  CHECK (
    (state = 'active' AND cleared_at IS NULL) OR
    (state = 'cleared' AND cleared_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS cloud_usage_workspace_billing_fence_active_bound_obligation
  ON cloud_usage_workspace_billing_fence (workspace_id, source_thread_id, settlement_id, reason)
  WHERE state = 'active' AND settlement_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cloud_usage_workspace_billing_fence_active_unbound_obligation
  ON cloud_usage_workspace_billing_fence (workspace_id, source_thread_id, reason)
  WHERE state = 'active' AND settlement_id IS NULL;

CREATE TABLE IF NOT EXISTS cloud_usage_billing_fence (
  workspace_id uuid NOT NULL,
  thread_id text NOT NULL,
  fence_id text NOT NULL CHECK (length(fence_id) BETWEEN 1 AND 96),
  episode integer NOT NULL CHECK (episode > 0),
  workspace_fence_id text,
  settlement_id text,
  recovery_settlement_id text,
  reason text NOT NULL CHECK (reason IN (
    'insufficient-balance', 'authorization-unavailable', 'provider-definitive-failure',
    'provider-outcome-uncertain'
  )),
  state text NOT NULL CHECK (state IN ('pause-pending', 'paused', 'cleared')),
  processing_owner text CHECK (processing_owner IS NULL OR length(processing_owner) BETWEEN 1 AND 128),
  processing_lease_expires_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  paused_at timestamptz,
  cleared_at timestamptz,
  PRIMARY KEY (workspace_id, thread_id, fence_id),
  UNIQUE (workspace_id, thread_id, episode),
  FOREIGN KEY (workspace_id, thread_id)
    REFERENCES cloud_thread (workspace_id, thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, workspace_fence_id)
    REFERENCES cloud_usage_workspace_billing_fence (workspace_id, fence_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, settlement_id, thread_id)
    REFERENCES cloud_usage_settlement_attempt (workspace_id, settlement_id, thread_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recovery_settlement_id, thread_id)
    REFERENCES cloud_usage_settlement_attempt (workspace_id, settlement_id, thread_id)
    ON DELETE RESTRICT,
  CHECK (
    (processing_owner IS NULL AND processing_lease_expires_at IS NULL) OR
    (processing_owner IS NOT NULL AND processing_lease_expires_at IS NOT NULL)
  ),
  CHECK (
    (state = 'pause-pending' AND paused_at IS NULL AND cleared_at IS NULL) OR
    (state = 'paused' AND paused_at IS NOT NULL AND cleared_at IS NULL) OR
    (state = 'cleared' AND cleared_at IS NOT NULL AND processing_owner IS NULL)
  )
);

DROP INDEX IF EXISTS cloud_usage_billing_fence_one_active_per_thread;
CREATE UNIQUE INDEX IF NOT EXISTS cloud_usage_billing_fence_one_active_workspace_link
  ON cloud_usage_billing_fence (workspace_id, thread_id, workspace_fence_id)
  WHERE state <> 'cleared' AND workspace_fence_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cloud_usage_billing_fence_one_active_settlement_obligation
  ON cloud_usage_billing_fence (
    workspace_id, thread_id, COALESCE(settlement_id, recovery_settlement_id), reason
  )
  WHERE state <> 'cleared' AND workspace_fence_id IS NULL
    AND COALESCE(settlement_id, recovery_settlement_id) IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cloud_usage_billing_fence_one_active_unbound_obligation
  ON cloud_usage_billing_fence (workspace_id, thread_id, reason)
  WHERE state <> 'cleared' AND workspace_fence_id IS NULL
    AND settlement_id IS NULL AND recovery_settlement_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'cloud_usage_billing_fence'::regclass
       AND conname = 'cloud_usage_billing_fence_identity_reason_unique'
  ) THEN
    ALTER TABLE cloud_usage_billing_fence
      ADD CONSTRAINT cloud_usage_billing_fence_identity_reason_unique
      UNIQUE (workspace_id, thread_id, fence_id, reason);
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS cloud_usage_billing_recovery_authorization (
  workspace_id uuid NOT NULL,
  settlement_id text NOT NULL,
  thread_id text NOT NULL,
  fence_id text NOT NULL,
  reason text NOT NULL CHECK (reason IN (
    'insufficient-balance', 'authorization-unavailable', 'provider-definitive-failure',
    'provider-outcome-uncertain'
  )),
  authorized_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, settlement_id, thread_id, fence_id),
  FOREIGN KEY (workspace_id, settlement_id, thread_id)
    REFERENCES cloud_usage_settlement_attempt (workspace_id, settlement_id, thread_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, thread_id, fence_id, reason)
    REFERENCES cloud_usage_billing_fence (workspace_id, thread_id, fence_id, reason)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS cloud_usage_billing_fence_event (
  workspace_id uuid NOT NULL,
  thread_id text NOT NULL,
  fence_id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  reason text NOT NULL CHECK (reason IN (
    'insufficient-balance', 'authorization-unavailable', 'provider-definitive-failure',
    'provider-outcome-uncertain'
  )),
  settlement_id text,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, thread_id, fence_id, sequence),
  FOREIGN KEY (workspace_id, thread_id, fence_id)
    REFERENCES cloud_usage_billing_fence (workspace_id, thread_id, fence_id) ON DELETE RESTRICT
);

INSERT INTO cloud_usage_billing_fence (
  workspace_id, thread_id, fence_id, episode, settlement_id, reason, state,
  created_at, updated_at, paused_at
)
SELECT workspace_id, thread_id,
       'billing-fence-migrated-' || left(request_fingerprint, 48),
       (
         SELECT COALESCE(max(existing.episode), 0) + 1
           FROM cloud_usage_billing_fence existing
          WHERE existing.workspace_id = cloud_usage_settlement_attempt.workspace_id
            AND existing.thread_id = cloud_usage_settlement_attempt.thread_id
       ),
       settlement_id,
       CASE
         WHEN state IN ('low-balance-pause-pending', 'low-balance-paused')
           THEN 'insufficient-balance'
         ELSE 'provider-outcome-uncertain'
       END,
       CASE WHEN state = 'low-balance-paused' THEN 'paused' ELSE 'pause-pending' END,
       updated_at, updated_at,
       CASE WHEN state = 'low-balance-paused' THEN updated_at ELSE NULL END
  FROM cloud_usage_settlement_attempt
 WHERE state IN (
   'reconciliation-required', 'low-balance-pause-pending', 'low-balance-paused'
 )
   AND NOT EXISTS (
     SELECT 1 FROM cloud_usage_billing_fence existing
      WHERE existing.workspace_id = cloud_usage_settlement_attempt.workspace_id
        AND existing.thread_id = cloud_usage_settlement_attempt.thread_id
        AND existing.state <> 'cleared'
        AND (
          existing.settlement_id = cloud_usage_settlement_attempt.settlement_id
          OR existing.recovery_settlement_id = cloud_usage_settlement_attempt.settlement_id
        )
   )
ON CONFLICT (workspace_id, thread_id, fence_id) DO NOTHING;

INSERT INTO cloud_usage_billing_fence_event (
  workspace_id, thread_id, fence_id, sequence, reason, settlement_id, recorded_at
)
SELECT workspace_id, thread_id, fence_id, 1, reason, settlement_id, created_at
  FROM cloud_usage_billing_fence
ON CONFLICT (workspace_id, thread_id, fence_id, sequence) DO NOTHING;

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
  tx_hash text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$' AND tx_hash = lower(tx_hash)),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, settlement_id),
  UNIQUE (payload_sha256),
  FOREIGN KEY (workspace_id, settlement_id, thread_id)
    REFERENCES cloud_usage_settlement_attempt (workspace_id, settlement_id, thread_id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS cloud_usage_settlement_receipt_tx_hash_canonical
  ON cloud_usage_settlement_receipt (lower(tx_hash));

CREATE OR REPLACE FUNCTION agentsin_cloud_protect_settlement_attempt()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'finalized' THEN
    RAISE EXCEPTION 'finalized usage settlement is immutable';
  END IF;
  IF NEW.provider_attempt_generation < OLD.provider_attempt_generation OR
     NEW.provider_attempt_generation > OLD.provider_attempt_generation + 1 THEN
    RAISE EXCEPTION 'settlement provider attempt generation may advance only once';
  END IF;
  IF NEW.provider_activity_ref IS DISTINCT FROM OLD.provider_activity_ref THEN
    RAISE EXCEPTION 'legacy settlement provider activity identity is immutable';
  END IF;
  IF ROW(
    OLD.workspace_id, OLD.settlement_id, OLD.thread_id, OLD.trigger_kind,
    OLD.treasury_address,
    OLD.first_pricing_sequence, OLD.last_pricing_sequence, OLD.accrual_count,
    OLD.upstream_delta_micro_usdc, OLD.markup_delta_micro_usdc,
    OLD.total_delta_micro_usdc, OLD.request_fingerprint, OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.workspace_id, NEW.settlement_id, NEW.thread_id, NEW.trigger_kind,
    NEW.treasury_address,
    NEW.first_pricing_sequence, NEW.last_pricing_sequence, NEW.accrual_count,
    NEW.upstream_delta_micro_usdc, NEW.markup_delta_micro_usdc,
    NEW.total_delta_micro_usdc, NEW.request_fingerprint, NEW.created_at
  ) THEN
    RAISE EXCEPTION 'usage settlement monetary identity is immutable';
  END IF;
  IF ROW(OLD.wallet_id, OLD.authorization_id, OLD.wallet_address)
     IS DISTINCT FROM ROW(NEW.wallet_id, NEW.authorization_id, NEW.wallet_address) THEN
    IF NEW.authorization_generation <> OLD.authorization_generation + 1 OR
       OLD.state NOT IN ('reserved', 'retry-waiting', 'low-balance-paused') THEN
      RAISE EXCEPTION 'settlement authorization may only rebind one generation while retryable';
    END IF;
  ELSIF NEW.authorization_generation <> OLD.authorization_generation THEN
    RAISE EXCEPTION 'settlement authorization generation requires a new binding';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION agentsin_cloud_protect_settlement_provider_attempt()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('not-applied', 'applied') THEN
    RAISE EXCEPTION 'terminal settlement provider attempt is immutable';
  END IF;
  IF ROW(
    OLD.workspace_id, OLD.settlement_id, OLD.generation, OLD.idempotency_key, OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.workspace_id, NEW.settlement_id, NEW.generation, NEW.idempotency_key, NEW.created_at
  ) THEN
    RAISE EXCEPTION 'settlement provider attempt identity is immutable';
  END IF;
  IF OLD.provider_activity_ref IS NOT NULL AND
     NEW.provider_activity_ref IS DISTINCT FROM OLD.provider_activity_ref THEN
    RAISE EXCEPTION 'settlement provider activity reference is immutable once observed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION agentsin_cloud_protect_usage_billing_fence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'cleared' THEN
    RAISE EXCEPTION 'cleared usage billing fence is immutable';
  END IF;
  IF ROW(
    OLD.workspace_id, OLD.thread_id, OLD.fence_id, OLD.episode, OLD.settlement_id,
    OLD.reason, OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.workspace_id, NEW.thread_id, NEW.fence_id, NEW.episode, NEW.settlement_id,
    NEW.reason, NEW.created_at
  ) THEN
    RAISE EXCEPTION 'usage billing fence identity is immutable';
  END IF;
  IF OLD.recovery_settlement_id IS NOT NULL AND
     NEW.recovery_settlement_id IS DISTINCT FROM OLD.recovery_settlement_id THEN
    RAISE EXCEPTION 'usage billing fence recovery settlement is immutable once bound';
  END IF;
  IF OLD.workspace_fence_id IS NOT NULL AND
     NEW.workspace_fence_id IS DISTINCT FROM OLD.workspace_fence_id THEN
    RAISE EXCEPTION 'usage billing fence workspace link is immutable once bound';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION agentsin_cloud_protect_usage_workspace_billing_fence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'cleared' THEN
    RAISE EXCEPTION 'cleared workspace billing fence is immutable';
  END IF;
  IF ROW(
    OLD.workspace_id, OLD.fence_id, OLD.episode, OLD.source_thread_id,
    OLD.reason, OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.workspace_id, NEW.fence_id, NEW.episode, NEW.source_thread_id,
    NEW.reason, NEW.created_at
  ) THEN
    RAISE EXCEPTION 'workspace billing fence identity is immutable';
  END IF;
  IF OLD.settlement_id IS NOT NULL AND NEW.settlement_id IS DISTINCT FROM OLD.settlement_id THEN
    RAISE EXCEPTION 'workspace billing fence settlement is immutable once bound';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION agentsin_cloud_block_billing_held_compute()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext('agents-in-cloud/workspace-billing-gate/v1'), hashtext(NEW.workspace_id::text)
  );
  IF EXISTS (
    SELECT 1 FROM cloud_usage_workspace_billing_fence
     WHERE workspace_id = NEW.workspace_id AND state = 'active'
  ) OR EXISTS (
    SELECT 1 FROM cloud_usage_billing_fence
     WHERE workspace_id = NEW.workspace_id AND thread_id = NEW.thread_id AND state <> 'cleared'
  ) THEN
    RAISE EXCEPTION 'cloud compute is blocked by an active billing hold';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cloud_usage_settlement_attempt_protected
  ON cloud_usage_settlement_attempt;
CREATE TRIGGER cloud_usage_settlement_attempt_protected
  BEFORE UPDATE ON cloud_usage_settlement_attempt
  FOR EACH ROW EXECUTE FUNCTION agentsin_cloud_protect_settlement_attempt();

DROP TRIGGER IF EXISTS cloud_usage_settlement_provider_attempt_protected
  ON cloud_usage_settlement_provider_attempt;
CREATE TRIGGER cloud_usage_settlement_provider_attempt_protected
  BEFORE UPDATE OR DELETE ON cloud_usage_settlement_provider_attempt
  FOR EACH ROW EXECUTE FUNCTION agentsin_cloud_protect_settlement_provider_attempt();

DROP TRIGGER IF EXISTS cloud_usage_settlement_authorization_binding_immutable
  ON cloud_usage_settlement_authorization_binding;
CREATE TRIGGER cloud_usage_settlement_authorization_binding_immutable
  BEFORE UPDATE OR DELETE ON cloud_usage_settlement_authorization_binding
  FOR EACH ROW EXECUTE FUNCTION agentsin_cloud_reject_usage_mutation();

DROP TRIGGER IF EXISTS cloud_usage_billing_fence_protected
  ON cloud_usage_billing_fence;
CREATE TRIGGER cloud_usage_billing_fence_protected
  BEFORE UPDATE OR DELETE ON cloud_usage_billing_fence
  FOR EACH ROW EXECUTE FUNCTION agentsin_cloud_protect_usage_billing_fence();

DROP TRIGGER IF EXISTS cloud_usage_workspace_billing_fence_protected
  ON cloud_usage_workspace_billing_fence;
CREATE TRIGGER cloud_usage_workspace_billing_fence_protected
  BEFORE UPDATE OR DELETE ON cloud_usage_workspace_billing_fence
  FOR EACH ROW EXECUTE FUNCTION agentsin_cloud_protect_usage_workspace_billing_fence();

DROP TRIGGER IF EXISTS cloud_usage_billing_fence_event_immutable
  ON cloud_usage_billing_fence_event;
CREATE TRIGGER cloud_usage_billing_fence_event_immutable
  BEFORE UPDATE OR DELETE ON cloud_usage_billing_fence_event
  FOR EACH ROW EXECUTE FUNCTION agentsin_cloud_reject_usage_mutation();

DROP TRIGGER IF EXISTS cloud_usage_billing_recovery_authorization_immutable
  ON cloud_usage_billing_recovery_authorization;
CREATE TRIGGER cloud_usage_billing_recovery_authorization_immutable
  BEFORE UPDATE OR DELETE ON cloud_usage_billing_recovery_authorization
  FOR EACH ROW EXECUTE FUNCTION agentsin_cloud_reject_usage_mutation();

DO $$
BEGIN
  IF to_regclass('cloud_thread_lifecycle_attempt') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS cloud_thread_lifecycle_billing_gate
      ON cloud_thread_lifecycle_attempt;
    CREATE TRIGGER cloud_thread_lifecycle_billing_gate
      BEFORE INSERT ON cloud_thread_lifecycle_attempt
      FOR EACH ROW EXECUTE FUNCTION agentsin_cloud_block_billing_held_compute();
  END IF;
  IF to_regclass('cloud_thread_runtime') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS cloud_thread_runtime_billing_gate
      ON cloud_thread_runtime;
    CREATE TRIGGER cloud_thread_runtime_billing_gate
      BEFORE INSERT OR UPDATE ON cloud_thread_runtime
      FOR EACH ROW
      WHEN (NEW.state IN (
        'running', 'resume_dispatched', 'resume_bootstrap_dispatched',
        'resume_worker_start_dispatched'
      ))
      EXECUTE FUNCTION agentsin_cloud_block_billing_held_compute();
  END IF;
END
$$;

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
