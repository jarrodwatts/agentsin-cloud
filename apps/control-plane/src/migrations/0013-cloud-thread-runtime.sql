-- Authoritative idle activity and pause/resume state for one E2B sandbox per cloud thread.
-- PostgreSQL owns every transition. Provider calls happen only after a durable claim and are
-- retried with the same transition identity when their response is uncertain.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS cloud_thread_runtime (
  workspace_id uuid NOT NULL,
  thread_id text NOT NULL,
  attempt_id text NOT NULL,
  environment_id text NOT NULL,
  environment_revision_id text NOT NULL,
  sandbox_id text NOT NULL,
  worker_id text NOT NULL,
  sealed_bootstrap_ref text NOT NULL,
  generation bigint NOT NULL DEFAULT 1 CHECK (generation BETWEEN 1 AND 4503599627370495),
  state text NOT NULL CHECK (state IN (
    'running',
    'pause_dispatched',
    'paused',
    'resume_dispatched',
    'resume_bootstrap_dispatched',
    'resume_worker_start_dispatched',
    'reconciliation_required'
  )),
  last_activity_at timestamptz NOT NULL,
  idle_since timestamptz,
  transition_id text,
  transition_kind text CHECK (transition_kind IN ('pause', 'resume')),
  transition_started_at timestamptz,
  route_fenced_at timestamptz,
  credentials_revoked_at timestamptz,
  credentials_scrubbed_at timestamptz,
  provider_completed_at timestamptz,
  sandbox_destroyed_at timestamptz,
  failure_code text,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, thread_id),
  UNIQUE (workspace_id, attempt_id),
  FOREIGN KEY (workspace_id, thread_id, environment_id)
    REFERENCES cloud_thread (workspace_id, thread_id, environment_id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, attempt_id)
    REFERENCES cloud_thread_lifecycle_attempt (workspace_id, attempt_id)
    ON DELETE CASCADE,
  CHECK (state = 'running' OR idle_since IS NULL),
  CHECK (
    (transition_id IS NULL AND transition_kind IS NULL AND transition_started_at IS NULL) OR
    (transition_id IS NOT NULL AND transition_kind IS NOT NULL AND transition_started_at IS NOT NULL)
  ),
  CHECK (state = 'running' OR transition_id IS NOT NULL),
  CHECK (
    state <> 'paused' OR (
      route_fenced_at IS NOT NULL AND credentials_revoked_at IS NOT NULL AND
      credentials_scrubbed_at IS NOT NULL AND provider_completed_at IS NOT NULL AND
      sandbox_destroyed_at IS NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS cloud_thread_runtime_idle_idx
  ON cloud_thread_runtime (idle_since, workspace_id, thread_id)
  WHERE state = 'running';
CREATE INDEX IF NOT EXISTS cloud_thread_runtime_recovery_idx
  ON cloud_thread_runtime (updated_at, workspace_id, thread_id)
  WHERE state IN (
    'pause_dispatched',
    'reconciliation_required',
    'resume_dispatched',
    'resume_bootstrap_dispatched',
    'resume_worker_start_dispatched'
  );

CREATE TABLE IF NOT EXISTS cloud_thread_runtime_activity (
  workspace_id uuid NOT NULL,
  thread_id text NOT NULL,
  attempt_id text NOT NULL,
  activity_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('agent', 'preview')),
  generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 4503599627370495),
  state text NOT NULL CHECK (state IN ('active', 'ended')),
  started_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  ended_at timestamptz,
  PRIMARY KEY (workspace_id, activity_id),
  FOREIGN KEY (workspace_id, thread_id)
    REFERENCES cloud_thread_runtime (workspace_id, thread_id)
    ON DELETE CASCADE,
  CHECK (started_at <= heartbeat_at AND heartbeat_at < expires_at),
  CHECK ((state = 'ended') = (ended_at IS NOT NULL)),
  CHECK (ended_at IS NULL OR started_at <= ended_at)
);

CREATE INDEX IF NOT EXISTS cloud_thread_runtime_activity_active_idx
  ON cloud_thread_runtime_activity (workspace_id, thread_id, expires_at)
  WHERE state = 'active';

CREATE TABLE IF NOT EXISTS cloud_thread_runtime_activity_event (
  workspace_id uuid NOT NULL,
  event_id text NOT NULL,
  thread_id text NOT NULL,
  activity_id text NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN ('started', 'heartbeat', 'ended')),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  expires_at timestamptz,
  PRIMARY KEY (workspace_id, event_id),
  FOREIGN KEY (workspace_id, activity_id)
    REFERENCES cloud_thread_runtime_activity (workspace_id, activity_id)
    ON DELETE CASCADE,
  CHECK ((event_kind = 'ended') = (expires_at IS NULL)),
  CHECK (expires_at IS NULL OR occurred_at < expires_at)
);

CREATE TABLE IF NOT EXISTS cloud_thread_runtime_resume_request (
  workspace_id uuid NOT NULL,
  request_id text NOT NULL,
  thread_id text NOT NULL,
  attempt_id text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('message', 'inspector', 'approved_continuation')),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('pending', 'dispatched', 'completed')),
  transition_id text,
  requested_at timestamptz NOT NULL,
  completed_at timestamptz,
  PRIMARY KEY (workspace_id, request_id),
  FOREIGN KEY (workspace_id, thread_id)
    REFERENCES cloud_thread_runtime (workspace_id, thread_id)
    ON DELETE CASCADE,
  CHECK ((state = 'pending') = (transition_id IS NULL)),
  CHECK ((state = 'completed') = (completed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS cloud_thread_runtime_resume_pending_idx
  ON cloud_thread_runtime_resume_request (workspace_id, thread_id, requested_at, request_id)
  WHERE state = 'pending';

CREATE TABLE IF NOT EXISTS cloud_thread_runtime_containment_attempt (
  workspace_id uuid NOT NULL,
  thread_id text NOT NULL,
  transition_id text NOT NULL,
  step text NOT NULL CHECK (step IN (
    'route_fence',
    'credential_revoke',
    'credential_scrub',
    'provider_pause',
    'provider_destroy'
  )),
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  outcome text NOT NULL CHECK (outcome IN (
    'succeeded',
    'retryable_failure',
    'confirmed_failure',
    'uncertain_failure'
  )),
  error_code text,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, thread_id, transition_id, step, attempt_no),
  FOREIGN KEY (workspace_id, thread_id)
    REFERENCES cloud_thread_runtime (workspace_id, thread_id)
    ON DELETE CASCADE,
  CHECK ((outcome = 'succeeded') = (error_code IS NULL))
);

CREATE OR REPLACE FUNCTION agentsin_cloud_seed_thread_runtime()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT NEW.is_current OR NEW.state = 'failed' THEN
    DELETE FROM cloud_thread_runtime
      WHERE workspace_id = NEW.workspace_id AND attempt_id = NEW.attempt_id;
    RETURN NEW;
  END IF;
  IF NEW.state = 'ready' AND NEW.is_current AND NEW.sandbox_id IS NOT NULL
     AND NEW.worker_id IS NOT NULL AND NEW.sealed_bootstrap_ref IS NOT NULL THEN
    INSERT INTO cloud_thread_runtime (
      workspace_id, thread_id, attempt_id, environment_id, environment_revision_id,
      sandbox_id, worker_id, sealed_bootstrap_ref, generation, state,
      last_activity_at, idle_since, updated_at
    ) VALUES (
      NEW.workspace_id, NEW.thread_id, NEW.attempt_id, NEW.environment_id,
      NEW.environment_revision_id, NEW.sandbox_id, NEW.worker_id, NEW.sealed_bootstrap_ref,
      1, 'running', NEW.updated_at, NEW.updated_at, NEW.updated_at
    ) ON CONFLICT (workspace_id, thread_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cloud_thread_runtime_seed_trigger ON cloud_thread_lifecycle_attempt;
CREATE TRIGGER cloud_thread_runtime_seed_trigger
AFTER INSERT OR UPDATE OF state, is_current ON cloud_thread_lifecycle_attempt
FOR EACH ROW EXECUTE FUNCTION agentsin_cloud_seed_thread_runtime();

INSERT INTO cloud_thread_runtime (
  workspace_id, thread_id, attempt_id, environment_id, environment_revision_id,
  sandbox_id, worker_id, sealed_bootstrap_ref, generation, state,
  last_activity_at, idle_since, updated_at
)
SELECT workspace_id, thread_id, attempt_id, environment_id, environment_revision_id,
       sandbox_id, worker_id, sealed_bootstrap_ref, 1, 'running', updated_at, updated_at, updated_at
FROM cloud_thread_lifecycle_attempt
WHERE state = 'ready' AND is_current AND sandbox_id IS NOT NULL
  AND worker_id IS NOT NULL AND sealed_bootstrap_ref IS NOT NULL
ON CONFLICT (workspace_id, thread_id) DO NOTHING;

COMMIT;
