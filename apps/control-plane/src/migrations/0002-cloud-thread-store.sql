-- Durable hosted thread state. All child-table foreign keys include the
-- workspace so a missing tenant predicate cannot silently cross boundaries.
-- The migration is deliberately additive and repeatable; the migration runner
-- supplies the bounded PostgreSQL statement/query timeout.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS cloud_thread (
  workspace_id uuid NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  thread_id text NOT NULL,
  environment_id text NOT NULL,
  next_event_sequence bigint NOT NULL DEFAULT 0 CHECK (next_event_sequence >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, thread_id),
  UNIQUE (workspace_id, thread_id, environment_id)
);

CREATE TABLE IF NOT EXISTS cloud_thread_command (
  workspace_id uuid NOT NULL,
  thread_id text NOT NULL,
  environment_id text NOT NULL,
  command_id text NOT NULL,
  idempotency_key text NOT NULL,
  fingerprint text NOT NULL,
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  enqueued_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, command_id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, thread_id, environment_id)
    REFERENCES cloud_thread (workspace_id, thread_id, environment_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cloud_thread_event (
  workspace_id uuid NOT NULL,
  thread_id text NOT NULL,
  environment_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence >= 0),
  event_id text NOT NULL,
  fingerprint text NOT NULL,
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, thread_id, sequence),
  UNIQUE (workspace_id, event_id),
  FOREIGN KEY (workspace_id, thread_id, environment_id)
    REFERENCES cloud_thread (workspace_id, thread_id, environment_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cloud_thread_approval (
  workspace_id uuid NOT NULL,
  thread_id text NOT NULL,
  request_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'expired')),
  payload jsonb NOT NULL,
  requested_at timestamptz NOT NULL,
  resolved_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, request_id),
  FOREIGN KEY (workspace_id, thread_id)
    REFERENCES cloud_thread (workspace_id, thread_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cloud_thread_checkpoint (
  workspace_id uuid NOT NULL,
  thread_id text NOT NULL,
  checkpoint_ref text NOT NULL,
  event_sequence bigint NOT NULL CHECK (event_sequence >= 0),
  turn_id text,
  turn_count bigint NOT NULL CHECK (turn_count >= 0),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, thread_id, checkpoint_ref),
  FOREIGN KEY (workspace_id, thread_id, event_sequence)
    REFERENCES cloud_thread_event (workspace_id, thread_id, sequence)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, thread_id)
    REFERENCES cloud_thread (workspace_id, thread_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cloud_thread_runtime_lifecycle (
  workspace_id uuid NOT NULL,
  thread_id text NOT NULL,
  lifecycle_id text NOT NULL,
  resource_kind text NOT NULL CHECK (resource_kind IN ('sandbox', 'worker')),
  resource_id text NOT NULL,
  state text NOT NULL,
  fingerprint text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, lifecycle_id),
  FOREIGN KEY (workspace_id, thread_id)
    REFERENCES cloud_thread (workspace_id, thread_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cloud_thread_outbox (
  workspace_id uuid NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  outbox_id uuid NOT NULL DEFAULT gen_random_uuid(),
  topic text NOT NULL,
  aggregate_id text NOT NULL,
  dedupe_key text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  available_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, outbox_id),
  UNIQUE (workspace_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS cloud_thread_event_replay_idx
  ON cloud_thread_event (workspace_id, thread_id, sequence);
CREATE INDEX IF NOT EXISTS cloud_thread_outbox_pending_idx
  ON cloud_thread_outbox (workspace_id, available_at, created_at)
  WHERE delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS cloud_thread_approval_thread_idx
  ON cloud_thread_approval (workspace_id, thread_id, updated_at);
CREATE INDEX IF NOT EXISTS cloud_thread_checkpoint_thread_idx
  ON cloud_thread_checkpoint (workspace_id, thread_id, event_sequence);
CREATE INDEX IF NOT EXISTS cloud_thread_lifecycle_thread_idx
  ON cloud_thread_runtime_lifecycle (workspace_id, thread_id, occurred_at);

COMMIT;
