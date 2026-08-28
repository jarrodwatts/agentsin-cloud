-- Exclusive desktop-control authority. PostgreSQL is the source of truth;
-- process-local and Valkey state may only cache the derived controller view.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS cloud_desktop_lease (
  workspace_id uuid NOT NULL,
  thread_id text NOT NULL,
  lease_id uuid NOT NULL,
  generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 4503599627370495),
  acquire_idempotency_key text NOT NULL,
  acquire_fingerprint text NOT NULL CHECK (acquire_fingerprint ~ '^[0-9a-f]{64}$'),
  attempt_id text NOT NULL,
  environment_id text NOT NULL,
  environment_revision_id text NOT NULL,
  sandbox_id text NOT NULL,
  worker_id text NOT NULL,
  route_generation bigint NOT NULL CHECK (route_generation > 0),
  holder_user_id text NOT NULL,
  holder_auth_session_id text NOT NULL,
  holder_client_id text NOT NULL,
  resume_secret_hash text NOT NULL CHECK (resume_secret_hash ~ '^[0-9a-f]{64}$'),
  connection_state text NOT NULL CHECK (connection_state IN ('connected', 'disconnected')),
  state text NOT NULL CHECK (state IN ('active', 'released', 'expired', 'revoked')),
  acquired_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  disconnected_at timestamptz,
  ended_at timestamptz,
  release_reason text CHECK (release_reason IN (
    'released',
    'heartbeatExpired',
    'holderDisconnected',
    'revoked',
    'superseded'
  )),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, thread_id, lease_id),
  UNIQUE (workspace_id, thread_id, generation),
  UNIQUE (workspace_id, acquire_idempotency_key),
  FOREIGN KEY (workspace_id, thread_id, environment_id)
    REFERENCES cloud_thread (workspace_id, thread_id, environment_id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, attempt_id)
    REFERENCES cloud_thread_lifecycle_attempt (workspace_id, attempt_id)
    ON DELETE CASCADE,
  CHECK ((connection_state = 'disconnected') = (disconnected_at IS NOT NULL)),
  CHECK (
    (state = 'active' AND ended_at IS NULL AND release_reason IS NULL) OR
    (state <> 'active' AND ended_at IS NOT NULL AND release_reason IS NOT NULL)
  ),
  CHECK (acquired_at <= heartbeat_at AND heartbeat_at <= expires_at),
  CHECK (disconnected_at IS NULL OR acquired_at <= disconnected_at),
  CHECK (ended_at IS NULL OR acquired_at <= ended_at)
);

-- Generation is a permanent fencing token. It lives outside retained lease
-- history so deleting old audit rows can never make a future holder reuse a
-- generation that a worker may have observed.
CREATE TABLE IF NOT EXISTS cloud_desktop_lease_generation (
  workspace_id uuid NOT NULL,
  thread_id text NOT NULL,
  last_generation bigint NOT NULL CHECK (last_generation BETWEEN 1 AND 4503599627370495),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, thread_id),
  FOREIGN KEY (workspace_id, thread_id)
    REFERENCES cloud_thread(workspace_id, thread_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS cloud_desktop_one_active_lease_idx
  ON cloud_desktop_lease (workspace_id, thread_id)
  WHERE state = 'active';
CREATE INDEX IF NOT EXISTS cloud_desktop_lease_expiry_idx
  ON cloud_desktop_lease (expires_at, workspace_id, thread_id, generation)
  WHERE state = 'active';
CREATE INDEX IF NOT EXISTS cloud_desktop_lease_retention_idx
  ON cloud_desktop_lease (ended_at, workspace_id, thread_id)
  WHERE state <> 'active';

CREATE TABLE IF NOT EXISTS cloud_desktop_lease_event (
  workspace_id uuid NOT NULL,
  thread_id text NOT NULL,
  event_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 4503599627370495),
  event_kind text NOT NULL CHECK (event_kind IN (
    'acquired',
    'heartbeat',
    'disconnected',
    'reconnected',
    'rebound',
    'released',
    'expired',
    'revoked'
  )),
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, event_id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, thread_id, lease_id)
    REFERENCES cloud_desktop_lease (workspace_id, thread_id, lease_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS cloud_desktop_lease_event_thread_idx
  ON cloud_desktop_lease_event (workspace_id, thread_id, occurred_at, event_id);

COMMIT;
