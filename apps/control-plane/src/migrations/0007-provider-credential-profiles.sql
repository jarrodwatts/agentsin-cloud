-- This migration must remain after 0006 GitHub workflow and before 0008 route
-- generation when the independently reviewed slices are integrated.
-- Profiles contain only opaque ciphertext and a KMS-wrapped per-profile DEK.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS provider_credential_profile (
  workspace_id uuid NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  profile_id text NOT NULL,
  provider_instance_id text NOT NULL,
  provider_driver text NOT NULL,
  label text NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'expired', 'revoked')),
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  key_version text NOT NULL,
  wrapped_dek bytea NOT NULL CHECK (octet_length(wrapped_dek) BETWEEN 32 AND 16384),
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  auth_tag bytea NOT NULL CHECK (octet_length(auth_tag) = 16),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 1 AND 1048576),
  aad_version smallint NOT NULL DEFAULT 1 CHECK (aad_version = 1),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
  PRIMARY KEY (workspace_id, profile_id),
  UNIQUE (workspace_id, provider_instance_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS provider_credential_login_session (
  workspace_id uuid NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  login_id text NOT NULL CHECK (login_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'),
  profile_id text NOT NULL,
  thread_id text NOT NULL,
  environment_id text NOT NULL,
  sandbox_id text NOT NULL,
  worker_id text NOT NULL,
  provider_instance_id text NOT NULL,
  provider_driver text NOT NULL,
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  state text NOT NULL CHECK (state IN ('running', 'authorized', 'denied', 'expired', 'cancelled', 'failed')),
  events jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(events) = 'array'),
  key_version text CHECK (key_version IS NULL OR length(key_version) BETWEEN 1 AND 256),
  wrapped_dek bytea CHECK (wrapped_dek IS NULL OR octet_length(wrapped_dek) BETWEEN 32 AND 16384),
  nonce bytea CHECK (nonce IS NULL OR octet_length(nonce) = 12),
  auth_tag bytea CHECK (auth_tag IS NULL OR octet_length(auth_tag) = 16),
  ciphertext bytea CHECK (ciphertext IS NULL OR octet_length(ciphertext) BETWEEN 1 AND 1048576),
  cleanup_state text NOT NULL DEFAULT 'pending' CHECK (cleanup_state IN ('pending', 'confirmed', 'retry_required')),
  cleanup_error text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (
    (state = 'authorized' AND num_nonnulls(key_version, wrapped_dek, nonce, auth_tag, ciphertext) = 5) OR
    (state <> 'authorized' AND num_nonnulls(key_version, wrapped_dek, nonce, auth_tag, ciphertext) = 0)
  ),
  PRIMARY KEY (workspace_id, login_id)
);

-- Terminal login attempts are permanently purged after 30 days. This compact,
-- non-secret aggregate preserves lifecycle/audit observability without keeping
-- device-code events, account labels, or credential material.
CREATE TABLE IF NOT EXISTS provider_credential_login_audit_daily (
  audit_day date NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  provider_instance_id text NOT NULL,
  provider_driver text NOT NULL,
  terminal_state text NOT NULL CHECK (
    terminal_state IN ('authorized', 'denied', 'expired', 'cancelled', 'failed')
  ),
  attempt_count bigint NOT NULL CHECK (attempt_count > 0),
  first_created_at timestamptz NOT NULL,
  last_terminal_at timestamptz NOT NULL,
  PRIMARY KEY (
    audit_day, workspace_id, provider_instance_id, provider_driver, terminal_state
  )
);

CREATE TABLE IF NOT EXISTS provider_credential_materialization (
  workspace_id uuid NOT NULL,
  materialization_id text NOT NULL CHECK (
    materialization_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'
  ),
  profile_id text NOT NULL,
  profile_generation bigint NOT NULL CHECK (profile_generation > 0),
  provider_instance_id text NOT NULL,
  provider_driver text NOT NULL,
  thread_id text NOT NULL,
  environment_id text NOT NULL,
  sandbox_id text NOT NULL,
  worker_id text NOT NULL,
  target_path text NOT NULL,
  target_path_sha256 text NOT NULL CHECK (target_path_sha256 ~ '^[0-9a-f]{64}$'),
  authorization_session_id text NOT NULL,
  authorization_expires_at timestamptz NOT NULL,
  state text NOT NULL CHECK (
    state IN ('reserved', 'dispatched', 'active', 'cleanup_required', 'cleaned')
  ),
  created_at timestamptz NOT NULL,
  dispatched_at timestamptz,
  materialized_at timestamptz,
  cleaned_at timestamptz,
  cleanup_reason text,
  cleanup_attempts integer NOT NULL DEFAULT 0 CHECK (cleanup_attempts >= 0),
  cleanup_last_error text,
  cleanup_next_attempt_at timestamptz,
  PRIMARY KEY (workspace_id, materialization_id),
  FOREIGN KEY (workspace_id, profile_id)
    REFERENCES provider_credential_profile (workspace_id, profile_id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, thread_id, environment_id)
    REFERENCES cloud_thread (workspace_id, thread_id, environment_id)
    ON DELETE CASCADE,
  CHECK (
    (state = 'reserved' AND dispatched_at IS NULL AND materialized_at IS NULL AND cleaned_at IS NULL) OR
    (state = 'dispatched' AND dispatched_at IS NOT NULL AND cleaned_at IS NULL) OR
    (state = 'active' AND dispatched_at IS NOT NULL AND materialized_at IS NOT NULL AND cleaned_at IS NULL) OR
    (state = 'cleanup_required' AND cleaned_at IS NULL) OR
    (state = 'cleaned' AND cleaned_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_credential_live_profile_sandbox_idx
  ON provider_credential_materialization (workspace_id, sandbox_id, profile_id)
  WHERE state IN ('reserved', 'dispatched', 'active', 'cleanup_required');
CREATE INDEX IF NOT EXISTS provider_credential_profile_provider_idx
  ON provider_credential_profile (workspace_id, provider_instance_id, state);
CREATE INDEX IF NOT EXISTS provider_credential_login_retention_idx
  ON provider_credential_login_session (updated_at)
  WHERE state <> 'running' AND cleanup_state = 'confirmed';
CREATE INDEX IF NOT EXISTS provider_credential_materialization_cleanup_idx
  ON provider_credential_materialization (
    workspace_id, sandbox_id, state, cleanup_next_attempt_at
  ) WHERE state IN ('reserved', 'dispatched', 'active', 'cleanup_required');

COMMIT;
