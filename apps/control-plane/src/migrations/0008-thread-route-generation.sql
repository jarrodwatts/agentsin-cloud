-- A route is keyed by workspace and thread, so its fencing generation must be
-- allocated in that same durable scope. Sandbox-local lease counters may reset
-- when C3 replaces a sandbox and must never be used for cross-replica routing.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS cloud_thread_route_generation (
  workspace_id uuid NOT NULL,
  thread_id text NOT NULL,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, thread_id),
  FOREIGN KEY (workspace_id, thread_id)
    REFERENCES cloud_thread (workspace_id, thread_id)
    ON DELETE CASCADE
);

ALTER TABLE cloud_worker_lease
  ADD COLUMN IF NOT EXISTS route_generation bigint;

INSERT INTO cloud_thread_route_generation (workspace_id, thread_id, generation)
SELECT workspace_id, thread_id, GREATEST(count(*)::bigint, max(lease_generation))
  FROM cloud_worker_lease
 GROUP BY workspace_id, thread_id
ON CONFLICT (workspace_id, thread_id) DO UPDATE
  SET generation = GREATEST(
    cloud_thread_route_generation.generation,
    EXCLUDED.generation
  ),
  updated_at = now();

UPDATE cloud_worker_lease AS lease
   SET route_generation = generation.generation
  FROM cloud_thread_route_generation AS generation
 WHERE lease.workspace_id = generation.workspace_id
   AND lease.thread_id = generation.thread_id
   AND lease.route_generation IS NULL;

ALTER TABLE cloud_worker_lease
  ALTER COLUMN route_generation SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'cloud_worker_lease_route_generation_positive'
       AND conrelid = 'cloud_worker_lease'::regclass
  ) THEN
    ALTER TABLE cloud_worker_lease
      ADD CONSTRAINT cloud_worker_lease_route_generation_positive
      CHECK (route_generation > 0) NOT VALID;
  END IF;
END
$$;
ALTER TABLE cloud_worker_lease
  VALIDATE CONSTRAINT cloud_worker_lease_route_generation_positive;

COMMIT;
