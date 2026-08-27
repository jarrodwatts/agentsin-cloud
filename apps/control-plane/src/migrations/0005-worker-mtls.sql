-- Durable worker authentication and routing state. Bootstrap secrets are
-- stored only as SHA-256 digests; certificate private keys never cross into
-- the control plane.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS cloud_worker_bootstrap_token (
  token_hash text PRIMARY KEY CHECK (length(token_hash) = 64),
  workspace_id uuid NOT NULL,
  thread_id text NOT NULL,
  environment_id text NOT NULL,
  environment_revision_id text NOT NULL,
  sandbox_id text NOT NULL,
  reservation_id text NOT NULL,
  worker_id text NOT NULL,
  provider_instance_id text NOT NULL,
  provider_driver text NOT NULL,
  identity_binding text NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > issued_at),
  FOREIGN KEY (workspace_id, thread_id, environment_id)
    REFERENCES cloud_thread (workspace_id, thread_id, environment_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cloud_worker_certificate (
  certificate_fingerprint text PRIMARY KEY,
  workspace_id uuid NOT NULL,
  thread_id text NOT NULL,
  environment_id text NOT NULL,
  environment_revision_id text NOT NULL,
  sandbox_id text NOT NULL,
  reservation_id text NOT NULL,
  worker_id text NOT NULL,
  provider_instance_id text NOT NULL,
  provider_driver text NOT NULL,
  identity_binding text NOT NULL,
  san_uri text NOT NULL,
  public_key_spki_sha256 text NOT NULL,
  certificate_generation bigint NOT NULL CHECK (certificate_generation > 0),
  not_before timestamptz NOT NULL,
  not_after timestamptz NOT NULL,
  overlap_until timestamptz,
  revoked_at timestamptz,
  revocation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (not_after > not_before),
  UNIQUE (workspace_id, worker_id, certificate_generation),
  FOREIGN KEY (workspace_id, thread_id, environment_id)
    REFERENCES cloud_thread (workspace_id, thread_id, environment_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cloud_worker_lease (
  workspace_id uuid NOT NULL,
  sandbox_id text NOT NULL,
  thread_id text NOT NULL,
  environment_id text NOT NULL,
  environment_revision_id text NOT NULL,
  reservation_id text NOT NULL,
  worker_id text NOT NULL,
  provider_instance_id text NOT NULL,
  provider_driver text NOT NULL,
  certificate_fingerprint text NOT NULL REFERENCES cloud_worker_certificate (certificate_fingerprint),
  certificate_generation bigint NOT NULL CHECK (certificate_generation > 0),
  lease_generation bigint NOT NULL CHECK (lease_generation > 0),
  process_instance_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('connected', 'disconnected', 'timed_out', 'fenced')),
  connected_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  disconnected_at timestamptz,
  heartbeat_sequence bigint NOT NULL DEFAULT 0 CHECK (heartbeat_sequence >= 0),
  confirmed_event_cursor bigint NOT NULL DEFAULT -1 CHECK (confirmed_event_cursor >= -1),
  last_command_delivery_id text,
  fence_reason text,
  PRIMARY KEY (workspace_id, sandbox_id),
  FOREIGN KEY (workspace_id, thread_id, environment_id)
    REFERENCES cloud_thread (workspace_id, thread_id, environment_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS cloud_worker_bootstrap_expiry_idx
  ON cloud_worker_bootstrap_token (expires_at) WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS cloud_worker_certificate_identity_idx
  ON cloud_worker_certificate (identity_binding, certificate_fingerprint);
CREATE INDEX IF NOT EXISTS cloud_worker_certificate_expiry_idx
  ON cloud_worker_certificate (not_after) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS cloud_worker_lease_process_idx
  ON cloud_worker_lease (process_instance_id, state);
CREATE INDEX IF NOT EXISTS cloud_worker_lease_heartbeat_idx
  ON cloud_worker_lease (last_seen_at) WHERE state = 'connected';

COMMIT;
