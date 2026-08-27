-- Durable create/worker-start saga for one E2B sandbox per cloud thread.
-- Remote side effects are always preceded by a committed reservation and
-- outbox claim. Failed attempts remain as audit history; uncertain cleanup
-- keeps the current-thread fence until an operator or reconciler clears it.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS cloud_e2b_sandbox_identity (
  workspace_id uuid NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  reservation_id text NOT NULL,
  thread_id text NOT NULL,
  environment_id text NOT NULL,
  project_id text NOT NULL,
  revision_id text NOT NULL,
  repository_identity jsonb NOT NULL CHECK (jsonb_typeof(repository_identity) = 'object'),
  workspace_directory text NOT NULL,
  sandbox_id text,
  provider_handle text,
  state text NOT NULL CHECK (
    state IN ('reserved', 'active', 'cleanup_required', 'failed', 'destroyed')
  ),
  failure_reason text,
  reclaim_metadata jsonb CHECK (
    reclaim_metadata IS NULL OR jsonb_typeof(reclaim_metadata) = 'object'
  ),
  requested_at timestamptz NOT NULL,
  activated_at timestamptz,
  failed_at timestamptz,
  destroyed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, thread_id, environment_id)
    REFERENCES cloud_thread (workspace_id, thread_id, environment_id)
    ON DELETE CASCADE,
  CHECK ((sandbox_id IS NULL) = (provider_handle IS NULL)),
  CHECK (state <> 'active' OR sandbox_id IS NOT NULL),
  CHECK (state <> 'cleanup_required' OR reclaim_metadata IS NOT NULL),
  PRIMARY KEY (workspace_id, reservation_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS cloud_e2b_one_current_sandbox_per_thread_idx
  ON cloud_e2b_sandbox_identity (workspace_id, thread_id)
  WHERE state IN ('reserved', 'active', 'cleanup_required');
CREATE UNIQUE INDEX IF NOT EXISTS cloud_e2b_sandbox_id_idx
  ON cloud_e2b_sandbox_identity (workspace_id, sandbox_id)
  WHERE sandbox_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cloud_e2b_provider_handle_idx
  ON cloud_e2b_sandbox_identity (workspace_id, provider_handle)
  WHERE provider_handle IS NOT NULL;

CREATE TABLE IF NOT EXISTS cloud_e2b_sandbox_cleanup_orphan (
  workspace_id uuid NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  orphan_id text NOT NULL,
  reservation_id text NOT NULL,
  sandbox_id text NOT NULL,
  provider_handle text NOT NULL,
  reason text NOT NULL CHECK (reason = 'identity-registration-failed'),
  state text NOT NULL DEFAULT 'cleanup_required'
    CHECK (state IN ('cleanup_required', 'reclaimed')),
  recorded_at timestamptz NOT NULL,
  last_attempted_at timestamptz,
  reclaimed_at timestamptz,
  PRIMARY KEY (workspace_id, orphan_id),
  FOREIGN KEY (workspace_id, reservation_id)
    REFERENCES cloud_e2b_sandbox_identity (workspace_id, reservation_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cloud_thread_lifecycle_attempt (
  workspace_id uuid NOT NULL,
  thread_id text NOT NULL,
  attempt_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  environment_id text NOT NULL,
  environment_revision_id text NOT NULL,
  environment_revision_hash text NOT NULL,
  project_id text NOT NULL,
  provider_instance_id text NOT NULL,
  provider_driver text NOT NULL,
  repository_identity jsonb NOT NULL CHECK (jsonb_typeof(repository_identity) = 'object'),
  workspace_directory text NOT NULL,
  sandbox_id text,
  provider_handle text,
  worker_id text,
  sealed_bootstrap_ref text,
  state text NOT NULL CHECK (state IN (
    'reserved',
    'create_dispatched',
    'sandbox_ready',
    'bootstrap_dispatched',
    'bootstrap_ready',
    'worker_start_dispatched',
    'ready',
    'cleanup_required',
    'failed'
  )),
  is_current boolean NOT NULL DEFAULT true,
  failure_code text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  PRIMARY KEY (workspace_id, attempt_id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, thread_id, environment_id)
    REFERENCES cloud_thread (workspace_id, thread_id, environment_id)
    ON DELETE CASCADE,
  CHECK ((sandbox_id IS NULL) = (provider_handle IS NULL)),
  CHECK ((worker_id IS NULL) = (sealed_bootstrap_ref IS NULL)),
  CHECK (is_current OR state = 'failed')
);

CREATE UNIQUE INDEX IF NOT EXISTS cloud_thread_one_current_lifecycle_attempt_idx
  ON cloud_thread_lifecycle_attempt (workspace_id, thread_id)
  WHERE is_current;
CREATE INDEX IF NOT EXISTS cloud_thread_lifecycle_history_idx
  ON cloud_thread_lifecycle_attempt (workspace_id, thread_id, created_at, attempt_id);

CREATE TABLE IF NOT EXISTS cloud_thread_lifecycle_outbox (
  workspace_id uuid NOT NULL,
  attempt_id text NOT NULL,
  step text NOT NULL CHECK (step IN ('create_sandbox', 'issue_bootstrap', 'start_worker')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  PRIMARY KEY (workspace_id, attempt_id, step),
  FOREIGN KEY (workspace_id, attempt_id)
    REFERENCES cloud_thread_lifecycle_attempt (workspace_id, attempt_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS cloud_thread_lifecycle_outbox_recovery_idx
  ON cloud_thread_lifecycle_outbox (status, lease_expires_at, updated_at)
  WHERE status IN ('pending', 'processing');

COMMIT;
