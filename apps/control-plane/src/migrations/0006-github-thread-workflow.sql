-- GitHub App external writes for hosted threads. Tokens are deliberately absent:
-- only repository grants, deterministic commands, outbox effects, and receipts persist.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS github_app_repository_access (
  workspace_id uuid NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  canonical_key text NOT NULL,
  installation_id text NOT NULL,
  owner_name text NOT NULL,
  repository_name text NOT NULL,
  repository_id bigint NOT NULL CHECK (repository_id > 0),
  can_push boolean NOT NULL,
  can_pull_requests boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, canonical_key),
  UNIQUE (workspace_id, installation_id, repository_id)
);

CREATE TABLE IF NOT EXISTS github_thread_workflow (
  workspace_id uuid NOT NULL,
  thread_id text NOT NULL,
  environment_id text NOT NULL,
  canonical_key text NOT NULL,
  installation_id text NOT NULL,
  owner_name text NOT NULL,
  repository_name text NOT NULL,
  base_sha text NOT NULL CHECK (base_sha ~ '^[0-9a-f]{40}$'),
  branch_name text NOT NULL CHECK (branch_name LIKE 'agents/%'),
  remote_head_sha text CHECK (remote_head_sha IS NULL OR remote_head_sha ~ '^[0-9a-f]{40}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused-conflict')),
  checkpoint_count integer NOT NULL DEFAULT 0 CHECK (checkpoint_count >= 0),
  pull_request_number integer CHECK (pull_request_number IS NULL OR pull_request_number > 0),
  pull_request_url text,
  pull_request_draft boolean,
  next_event_sequence bigint NOT NULL DEFAULT 0 CHECK (next_event_sequence >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, thread_id),
  UNIQUE (workspace_id, canonical_key, branch_name),
  FOREIGN KEY (workspace_id, thread_id, environment_id)
    REFERENCES cloud_thread (workspace_id, thread_id, environment_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, canonical_key)
    REFERENCES github_app_repository_access (workspace_id, canonical_key),
  CHECK (
    (pull_request_number IS NULL AND pull_request_url IS NULL AND pull_request_draft IS NULL) OR
    (pull_request_number IS NOT NULL AND pull_request_url IS NOT NULL AND pull_request_draft IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS github_thread_workflow_command (
  workspace_id uuid NOT NULL,
  thread_id text NOT NULL,
  command_id text NOT NULL,
  idempotency_key text NOT NULL,
  fingerprint text NOT NULL,
  command_type text NOT NULL,
  approval_id text NOT NULL,
  actor_user_id text NOT NULL,
  auth_session_id text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'succeeded', 'failed')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, command_id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, thread_id)
    REFERENCES github_thread_workflow (workspace_id, thread_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS github_thread_workflow_outbox (
  workspace_id uuid NOT NULL,
  thread_id text NOT NULL,
  effect_id text NOT NULL,
  command_id text NOT NULL,
  effect_type text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  expected_parent_sha text CHECK (
    expected_parent_sha IS NULL OR expected_parent_sha ~ '^[0-9a-f]{40}$'
  ),
  prepared_sha text CHECK (prepared_sha IS NULL OR prepared_sha ~ '^[0-9a-f]{40}$'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'delivered', 'failed')),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, effect_id),
  UNIQUE (workspace_id, command_id),
  FOREIGN KEY (workspace_id, command_id)
    REFERENCES github_thread_workflow_command (workspace_id, command_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, thread_id)
    REFERENCES github_thread_workflow (workspace_id, thread_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS github_thread_workflow_receipt (
  workspace_id uuid NOT NULL,
  thread_id text NOT NULL,
  effect_id text NOT NULL,
  command_id text NOT NULL,
  external_identity text NOT NULL,
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  completed_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, effect_id),
  UNIQUE (workspace_id, command_id),
  FOREIGN KEY (workspace_id, effect_id)
    REFERENCES github_thread_workflow_outbox (workspace_id, effect_id),
  FOREIGN KEY (workspace_id, command_id)
    REFERENCES github_thread_workflow_command (workspace_id, command_id)
);

CREATE TABLE IF NOT EXISTS github_thread_workflow_event (
  workspace_id uuid NOT NULL,
  thread_id text NOT NULL,
  environment_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence >= 0),
  event_id text NOT NULL,
  event_type text NOT NULL,
  visible boolean NOT NULL DEFAULT true CHECK (visible),
  summary text NOT NULL,
  retryable boolean NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, thread_id, sequence),
  UNIQUE (workspace_id, event_id),
  FOREIGN KEY (workspace_id, thread_id, environment_id)
    REFERENCES cloud_thread (workspace_id, thread_id, environment_id) ON DELETE CASCADE
);

-- Raw tokens live only in the injected one-shot vault. This table binds an
-- opaque vault reference to one approved write and one authenticated worker.
CREATE TABLE IF NOT EXISTS github_worker_token_lease (
  lease_ref text PRIMARY KEY,
  workspace_id uuid NOT NULL,
  environment_id text NOT NULL,
  thread_id text NOT NULL,
  sandbox_id text NOT NULL,
  environment_revision_id text NOT NULL,
  reservation_id text NOT NULL,
  worker_id text NOT NULL,
  provider_instance_id text NOT NULL,
  provider_driver text NOT NULL,
  process_instance_id text NOT NULL,
  certificate_fingerprint text NOT NULL,
  certificate_generation bigint NOT NULL CHECK (certificate_generation > 0),
  worker_lease_generation bigint NOT NULL CHECK (worker_lease_generation > 0),
  route_generation bigint NOT NULL CHECK (route_generation > 0),
  operation_id text NOT NULL,
  command_id text NOT NULL,
  approval_id text NOT NULL,
  approval_generation text NOT NULL,
  approval_action text NOT NULL CHECK (
    approval_action IN ('createBranch', 'pushCheckpoint', 'openDraftPullRequest', 'markPullRequestReady')
  ),
  actor_user_id text NOT NULL,
  auth_session_id text NOT NULL,
  installation_id text NOT NULL,
  canonical_key text NOT NULL,
  owner_name text NOT NULL,
  repository_name text NOT NULL,
  expires_at timestamptz NOT NULL,
  secret_ref text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, sandbox_id, operation_id),
  FOREIGN KEY (workspace_id, approval_id)
    REFERENCES cloud_thread_approval (workspace_id, request_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, thread_id, environment_id)
    REFERENCES cloud_thread (workspace_id, thread_id, environment_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS github_thread_workflow_outbox_pending_idx
  ON github_thread_workflow_outbox (workspace_id, available_at, created_at)
  WHERE status IN ('pending', 'processing');
CREATE INDEX IF NOT EXISTS github_thread_workflow_event_replay_idx
  ON github_thread_workflow_event (workspace_id, thread_id, sequence);
CREATE INDEX IF NOT EXISTS github_worker_token_lease_expiry_idx
  ON github_worker_token_lease (expires_at) WHERE used_at IS NULL;

COMMIT;
