-- User-owned Turnkey wallet metadata and durable authorization state.
-- This schema must never store private keys, API private keys, authenticator
-- assertions, recovery bundles, signing stamps, or wallet mnemonics.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS cloud_wallet (
  workspace_id uuid NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  wallet_id text NOT NULL CHECK (wallet_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'),
  owner_user_id text NOT NULL,
  provider text NOT NULL CHECK (provider = 'turnkey'),
  provider_organization_ref text NOT NULL CHECK (length(provider_organization_ref) BETWEEN 1 AND 256),
  provider_wallet_ref text NOT NULL CHECK (length(provider_wallet_ref) BETWEEN 1 AND 256),
  evm_address text NOT NULL CHECK (evm_address ~ '^0x[0-9a-fA-F]{40}$'),
  state text NOT NULL CHECK (state IN ('provisioning', 'active', 'recoveryPending', 'frozen')),
  recovery_method text NOT NULL CHECK (recovery_method = 'passkeyAndEmail'),
  recovery_enabled boolean NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, wallet_id),
  UNIQUE (workspace_id, owner_user_id),
  UNIQUE (provider, provider_organization_ref),
  UNIQUE (provider, provider_wallet_ref),
  UNIQUE (provider, evm_address)
);

CREATE TABLE IF NOT EXISTS cloud_wallet_operation (
  workspace_id uuid NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  operation_id text NOT NULL CHECK (operation_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'),
  wallet_id text NOT NULL CHECK (wallet_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'),
  operation_kind text NOT NULL CHECK (operation_kind IN (
    'provision',
    'delegationConfigure',
    'recoveryBegin',
    'recoveryComplete',
    'withdrawal'
  )),
  state text NOT NULL CHECK (state IN ('pending', 'succeeded', 'failed')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  provider_activity_ref text CHECK (
    provider_activity_ref IS NULL OR length(provider_activity_ref) BETWEEN 1 AND 256
  ),
  tx_hash text CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  amount_micro_usdc bigint CHECK (
    amount_micro_usdc IS NULL OR amount_micro_usdc BETWEEN 1 AND 9007199254740991
  ),
  destination text CHECK (destination IS NULL OR destination ~ '^0x[0-9a-fA-F]{40}$'),
  requested_at timestamptz NOT NULL,
  completed_at timestamptz,
  error_code text CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 96),
  PRIMARY KEY (workspace_id, operation_id),
  UNIQUE (workspace_id, idempotency_key),
  CHECK (
    (state = 'pending' AND completed_at IS NULL AND error_code IS NULL) OR
    (state = 'succeeded' AND completed_at IS NOT NULL AND error_code IS NULL) OR
    (state = 'failed' AND completed_at IS NOT NULL AND error_code IS NOT NULL)
  ),
  CHECK (
    (operation_kind = 'withdrawal' AND amount_micro_usdc IS NOT NULL AND destination IS NOT NULL) OR
    (operation_kind <> 'withdrawal' AND amount_micro_usdc IS NULL AND destination IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS cloud_wallet_operation_pending_idx
  ON cloud_wallet_operation (requested_at, workspace_id, operation_id)
  WHERE state = 'pending';

CREATE TABLE IF NOT EXISTS cloud_wallet_provisioning_intent (
  workspace_id uuid NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  owner_user_id text NOT NULL,
  wallet_id text NOT NULL CHECK (wallet_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'),
  operation_id text NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('pending', 'completed', 'failed')),
  provider_activity_ref text CHECK (
    provider_activity_ref IS NULL OR length(provider_activity_ref) BETWEEN 1 AND 256
  ),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, owner_user_id),
  UNIQUE (workspace_id, wallet_id),
  FOREIGN KEY (workspace_id, operation_id)
    REFERENCES cloud_wallet_operation (workspace_id, operation_id) ON DELETE CASCADE,
  CHECK (
    (state = 'completed' AND provider_activity_ref IS NOT NULL) OR
    (state <> 'completed')
  )
);

CREATE TABLE IF NOT EXISTS cloud_wallet_delegated_authorization (
  workspace_id uuid NOT NULL,
  wallet_id text NOT NULL,
  authorization_id text NOT NULL CHECK (
    authorization_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'
  ),
  chain_id integer NOT NULL CHECK (chain_id = 143),
  token_contract text NOT NULL CHECK (
    lower(token_contract) = lower('0x754704Bc059F8C67012fEd69BC8A327a5aafb603')
  ),
  treasury_address text NOT NULL CHECK (treasury_address ~ '^0x[0-9a-fA-F]{40}$'),
  per_charge_limit_micro_usdc bigint NOT NULL CHECK (
    per_charge_limit_micro_usdc BETWEEN 1 AND 9007199254740991
  ),
  daily_limit_micro_usdc bigint NOT NULL CHECK (
    daily_limit_micro_usdc BETWEEN per_charge_limit_micro_usdc AND 9007199254740991
  ),
  starts_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  policy_revision integer NOT NULL CHECK (policy_revision > 0),
  provider_policy_ref text CHECK (
    provider_policy_ref IS NULL OR length(provider_policy_ref) BETWEEN 1 AND 256
  ),
  provider_delegated_user_ref text CHECK (
    provider_delegated_user_ref IS NULL OR length(provider_delegated_user_ref) BETWEEN 1 AND 256
  ),
  provider_delegated_credential_ref text CHECK (
    provider_delegated_credential_ref IS NULL OR length(provider_delegated_credential_ref) BETWEEN 1 AND 256
  ),
  state text NOT NULL CHECK (state IN ('pending', 'active', 'expired', 'revoked')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, wallet_id, authorization_id),
  FOREIGN KEY (workspace_id, wallet_id)
    REFERENCES cloud_wallet (workspace_id, wallet_id) ON DELETE CASCADE,
  CHECK (starts_at < expires_at),
  CHECK (
    (state = 'active' AND num_nonnulls(
      provider_policy_ref,
      provider_delegated_user_ref,
      provider_delegated_credential_ref
    ) = 3) OR state <> 'active'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS cloud_wallet_one_active_delegation_idx
  ON cloud_wallet_delegated_authorization (workspace_id, wallet_id)
  WHERE state = 'active';

-- Serializes every provider-side delegated-access mutation for one wallet.
-- An attempt is durable before Turnkey is called, so a retry reconciles the
-- same provider operation instead of creating another credential.
CREATE TABLE IF NOT EXISTS cloud_wallet_delegation_configuration_intent (
  workspace_id uuid NOT NULL,
  wallet_id text NOT NULL,
  operation_id text NOT NULL,
  operation_kind text NOT NULL CHECK (operation_kind IN ('delegationConfigure', 'recoveryComplete')),
  authorization_id text,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (
    state IN ('reserved', 'attempting', 'providerApplied', 'completed', 'failed')
  ),
  provider_activity_ref text CHECK (
    provider_activity_ref IS NULL OR length(provider_activity_ref) BETWEEN 1 AND 256
  ),
  provider_status text CHECK (
    provider_status IS NULL OR provider_status IN ('applied', 'notApplied', 'stillUnknown')
  ),
  provider_policy_ref text CHECK (
    provider_policy_ref IS NULL OR length(provider_policy_ref) BETWEEN 1 AND 256
  ),
  provider_delegated_user_ref text CHECK (
    provider_delegated_user_ref IS NULL OR length(provider_delegated_user_ref) BETWEEN 1 AND 256
  ),
  provider_delegated_credential_ref text CHECK (
    provider_delegated_credential_ref IS NULL OR length(provider_delegated_credential_ref) BETWEEN 1 AND 256
  ),
  provider_observed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, operation_id),
  FOREIGN KEY (workspace_id, wallet_id)
    REFERENCES cloud_wallet (workspace_id, wallet_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, operation_id)
    REFERENCES cloud_wallet_operation (workspace_id, operation_id) ON DELETE CASCADE,
  CHECK (
    (operation_kind = 'delegationConfigure' AND authorization_id IS NOT NULL) OR
    (operation_kind = 'recoveryComplete' AND authorization_id IS NULL)
  ),
  CHECK (
    (provider_status = 'applied' AND state IN ('providerApplied', 'completed') AND
      num_nonnulls(
        provider_activity_ref,
        provider_policy_ref,
        provider_delegated_user_ref,
        provider_delegated_credential_ref,
        provider_observed_at
      ) = 5) OR
    (provider_status IN ('notApplied', 'stillUnknown') AND state IN ('failed', 'attempting') AND
      provider_observed_at IS NOT NULL) OR
    (provider_status IS NULL AND state IN ('reserved', 'attempting', 'completed', 'failed'))
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS cloud_wallet_one_pending_delegation_change_idx
  ON cloud_wallet_delegation_configuration_intent (workspace_id, wallet_id)
  WHERE state IN ('reserved', 'attempting', 'providerApplied');

CREATE TABLE IF NOT EXISTS cloud_wallet_delegation_revocation (
  workspace_id uuid NOT NULL,
  wallet_id text NOT NULL,
  authorization_id text NOT NULL,
  operation_id text NOT NULL,
  provider_activity_ref text NOT NULL CHECK (
    length(provider_activity_ref) BETWEEN 1 AND 256
  ),
  provider_status text NOT NULL CHECK (
    provider_status IN ('applied', 'notApplied', 'stillUnknown')
  ),
  requested_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (workspace_id, wallet_id, authorization_id),
  FOREIGN KEY (workspace_id, wallet_id, authorization_id)
    REFERENCES cloud_wallet_delegated_authorization (
      workspace_id, wallet_id, authorization_id
    ) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, operation_id)
    REFERENCES cloud_wallet_operation (workspace_id, operation_id) ON DELETE CASCADE,
  CHECK (
    (provider_status = 'applied' AND revoked_at IS NOT NULL) OR
    (provider_status <> 'applied' AND revoked_at IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS cloud_wallet_recovery_attempt (
  workspace_id uuid NOT NULL,
  wallet_id text NOT NULL,
  recovery_attempt_id text NOT NULL CHECK (
    recovery_attempt_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'
  ),
  state text NOT NULL CHECK (state IN ('initiated', 'completed', 'expired', 'failed')),
  provider_activity_ref text CHECK (
    provider_activity_ref IS NULL OR length(provider_activity_ref) BETWEEN 1 AND 256
  ),
  initiated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  failed_at timestamptz,
  PRIMARY KEY (workspace_id, recovery_attempt_id),
  FOREIGN KEY (workspace_id, wallet_id)
    REFERENCES cloud_wallet (workspace_id, wallet_id) ON DELETE CASCADE,
  CHECK (initiated_at < expires_at),
  CHECK (
    (state = 'completed' AND completed_at IS NOT NULL AND failed_at IS NULL) OR
    (state = 'failed' AND failed_at IS NOT NULL AND completed_at IS NULL) OR
    (state IN ('initiated', 'expired') AND completed_at IS NULL AND failed_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS cloud_wallet_one_pending_recovery_idx
  ON cloud_wallet_recovery_attempt (workspace_id, wallet_id)
  WHERE state = 'initiated';

CREATE TABLE IF NOT EXISTS cloud_wallet_spend_reservation (
  workspace_id uuid NOT NULL,
  wallet_id text NOT NULL,
  authorization_id text NOT NULL,
  reservation_id text NOT NULL CHECK (
    reservation_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'
  ),
  utc_day date NOT NULL,
  amount_micro_usdc bigint NOT NULL CHECK (
    amount_micro_usdc BETWEEN 1 AND 9007199254740991
  ),
  state text NOT NULL CHECK (state IN ('reserved', 'submitted', 'released')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  provider_activity_ref text CHECK (
    provider_activity_ref IS NULL OR length(provider_activity_ref) BETWEEN 1 AND 256
  ),
  provider_status text CHECK (
    provider_status IS NULL OR provider_status IN ('applied', 'notApplied', 'stillUnknown')
  ),
  provider_observed_at timestamptz,
  tx_hash text CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, reservation_id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, wallet_id, authorization_id)
    REFERENCES cloud_wallet_delegated_authorization (
      workspace_id, wallet_id, authorization_id
    ) ON DELETE CASCADE,
  CHECK (
    (provider_activity_ref IS NULL AND provider_status IS NULL AND provider_observed_at IS NULL) OR
    (provider_activity_ref IS NOT NULL AND provider_status IS NOT NULL AND provider_observed_at IS NOT NULL)
  ),
  CHECK (
    (state = 'submitted' AND tx_hash IS NOT NULL AND provider_status = 'applied') OR
    (state = 'released' AND tx_hash IS NULL AND provider_status = 'notApplied') OR
    (state = 'reserved' AND tx_hash IS NULL AND (
      provider_status IS NULL OR provider_status = 'stillUnknown'
    ))
  )
);

CREATE INDEX IF NOT EXISTS cloud_wallet_spend_daily_idx
  ON cloud_wallet_spend_reservation (
    workspace_id, wallet_id, authorization_id, utc_day, state
  ) WHERE state IN ('reserved', 'submitted');

CREATE TABLE IF NOT EXISTS cloud_wallet_audit_event (
  workspace_id uuid NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  audit_event_id uuid NOT NULL,
  wallet_id text,
  operation_id text,
  actor_user_id text,
  actor_auth_session_id text,
  event_kind text NOT NULL CHECK (event_kind IN (
    'walletProvisioned',
    'delegationConfigured',
    'delegationRevoked',
    'recoveryInitiated',
    'recoveryCompleted',
    'withdrawalSubmitted',
    'spendReserved',
    'spendSubmitted',
    'spendReleased',
    'operationFailed'
  )),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, audit_event_id),
  CHECK (actor_auth_session_id IS NULL OR actor_user_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS cloud_wallet_audit_timeline_idx
  ON cloud_wallet_audit_event (workspace_id, wallet_id, occurred_at, audit_event_id);

COMMIT;
