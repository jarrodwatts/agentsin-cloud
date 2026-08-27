-- Forward-only integrity upgrade for installations that already applied 0002.
-- Backfill and validation are bounded by the statement timeout so an operator
-- can retry rather than holding locks indefinitely on an unexpectedly large table.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE cloud_thread_event
  ADD COLUMN IF NOT EXISTS occurred_at_text text,
  ADD COLUMN IF NOT EXISTS received_at_text text;

UPDATE cloud_thread_event
   SET occurred_at_text = COALESCE(envelope #>> '{event,occurredAt}', occurred_at::text),
       received_at_text = COALESCE(envelope #>> '{receivedAt}', received_at::text)
 WHERE occurred_at_text IS NULL OR received_at_text IS NULL;

ALTER TABLE cloud_thread_event
  ALTER COLUMN occurred_at_text SET NOT NULL,
  ALTER COLUMN received_at_text SET NOT NULL;

CREATE TABLE IF NOT EXISTS cloud_thread_command_lock (
  workspace_id uuid NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  lock_kind text NOT NULL CHECK (lock_kind IN ('command_id', 'idempotency_key')),
  lock_value text NOT NULL,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, lock_kind, lock_value)
);

CREATE INDEX IF NOT EXISTS cloud_thread_command_lock_retention_idx
  ON cloud_thread_command_lock (workspace_id, last_used_at, lock_kind, lock_value);

COMMIT;
