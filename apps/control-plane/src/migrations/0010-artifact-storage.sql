-- Durable metadata for immutable thread artifacts. PostgreSQL is authoritative;
-- object storage contains payload bytes only. Upload verification is committed
-- before an artifact becomes visible as complete.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS cloud_thread_artifact (
  workspace_id uuid NOT NULL,
  thread_id text NOT NULL,
  artifact_id text NOT NULL,
  idempotency_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'terminal-chunk',
    'screenshot',
    'diff',
    'environment-build-log',
    'thread-export'
  )),
  state text NOT NULL CHECK (state IN (
    'reserved',
    'uploading',
    'complete',
    'delete_pending',
    'deleted',
    'failed'
  )),
  object_key text NOT NULL,
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  media_type text NOT NULL,
  etag text,
  object_version text,
  retention_until timestamptz,
  expires_at timestamptz,
  failure_code text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  deleted_at timestamptz,
  PRIMARY KEY (workspace_id, thread_id, artifact_id),
  UNIQUE (workspace_id, thread_id, idempotency_key),
  UNIQUE (workspace_id, object_key),
  FOREIGN KEY (workspace_id, thread_id)
    REFERENCES cloud_thread (workspace_id, thread_id)
    ON DELETE CASCADE,
  CHECK (retention_until IS NULL OR expires_at IS NULL OR retention_until <= expires_at),
  CHECK (
    (state = 'complete' AND completed_at IS NOT NULL AND etag IS NOT NULL) OR
    (state <> 'complete')
  )
);

CREATE TABLE IF NOT EXISTS cloud_thread_artifact_outbox (
  workspace_id uuid NOT NULL,
  thread_id text NOT NULL,
  artifact_id text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('verify_upload', 'delete_object')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  available_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  PRIMARY KEY (workspace_id, thread_id, artifact_id, operation),
  FOREIGN KEY (workspace_id, thread_id, artifact_id)
    REFERENCES cloud_thread_artifact (workspace_id, thread_id, artifact_id)
    ON DELETE CASCADE
);

-- Upgrade early 0010 installations whose outbox predates leasing. Application
-- migrations are intentionally idempotent and rerun at startup.
ALTER TABLE cloud_thread_artifact_outbox
  ADD COLUMN IF NOT EXISTS lease_token uuid;

-- Freezes a conservative, payload-free export snapshot before the R2 side
-- effect. This is durable control intent, not an artifact payload copy.
CREATE TABLE IF NOT EXISTS cloud_thread_export_intent (
  workspace_id uuid NOT NULL,
  thread_id text NOT NULL,
  export_id text NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL,
  snapshot jsonb NOT NULL CHECK (
    jsonb_typeof(snapshot) = 'object' AND
    octet_length(snapshot::text) <= 8388608
  ),
  PRIMARY KEY (workspace_id, thread_id, export_id),
  UNIQUE (workspace_id, thread_id, idempotency_key),
  FOREIGN KEY (workspace_id, thread_id)
    REFERENCES cloud_thread (workspace_id, thread_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS cloud_thread_artifact_thread_idx
  ON cloud_thread_artifact (workspace_id, thread_id, created_at, artifact_id)
  WHERE state = 'complete';
CREATE INDEX IF NOT EXISTS cloud_thread_artifact_recovery_idx
  ON cloud_thread_artifact (state, updated_at, workspace_id, artifact_id)
  WHERE state IN ('reserved', 'uploading', 'delete_pending', 'failed');
CREATE INDEX IF NOT EXISTS cloud_thread_artifact_expiry_idx
  ON cloud_thread_artifact (expires_at, workspace_id, artifact_id)
  WHERE state = 'complete' AND expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS cloud_thread_artifact_outbox_claim_idx
  ON cloud_thread_artifact_outbox (status, available_at, created_at)
  WHERE status IN ('pending', 'processing', 'failed');

COMMIT;
