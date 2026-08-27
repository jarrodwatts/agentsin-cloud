-- Bind every redeemable GitHub token lease to one immutable authenticated
-- worker route. Existing unbound leases are permanently fenced before the
-- legacy operation-level uniqueness constraint is replaced.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE github_worker_token_lease
  ADD COLUMN IF NOT EXISTS environment_revision_id text,
  ADD COLUMN IF NOT EXISTS reservation_id text,
  ADD COLUMN IF NOT EXISTS worker_id text,
  ADD COLUMN IF NOT EXISTS provider_instance_id text,
  ADD COLUMN IF NOT EXISTS provider_driver text,
  ADD COLUMN IF NOT EXISTS process_instance_id text,
  ADD COLUMN IF NOT EXISTS certificate_fingerprint text,
  ADD COLUMN IF NOT EXISTS certificate_generation bigint,
  ADD COLUMN IF NOT EXISTS worker_lease_generation bigint,
  ADD COLUMN IF NOT EXISTS route_generation bigint;

UPDATE github_worker_token_lease
   SET used_at = COALESCE(used_at, now())
 WHERE environment_revision_id IS NULL
    OR reservation_id IS NULL
    OR worker_id IS NULL
    OR provider_instance_id IS NULL
    OR provider_driver IS NULL
    OR process_instance_id IS NULL
    OR certificate_fingerprint IS NULL
    OR certificate_generation IS NULL
    OR worker_lease_generation IS NULL
    OR route_generation IS NULL;

DO $$
DECLARE
  legacy_constraint text;
BEGIN
  SELECT constraint_name
    INTO legacy_constraint
    FROM information_schema.table_constraints
   WHERE table_schema = current_schema()
     AND table_name = 'github_worker_token_lease'
     AND constraint_type = 'UNIQUE'
     AND constraint_name IN (
       SELECT conname
         FROM pg_constraint
        WHERE conrelid = 'github_worker_token_lease'::regclass
          AND pg_get_constraintdef(oid) = 'UNIQUE (workspace_id, sandbox_id, operation_id)'
     )
   LIMIT 1;
  IF legacy_constraint IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE github_worker_token_lease DROP CONSTRAINT %I',
      legacy_constraint
    );
  END IF;
END
$$;

ALTER TABLE github_worker_token_lease
  ADD CONSTRAINT github_worker_token_lease_route_operation_key
    UNIQUE (workspace_id, sandbox_id, operation_id, route_generation),
  ADD CONSTRAINT github_worker_token_lease_route_binding_required
    CHECK (
      used_at IS NOT NULL OR (
        environment_revision_id IS NOT NULL AND
        reservation_id IS NOT NULL AND
        worker_id IS NOT NULL AND
        provider_instance_id IS NOT NULL AND
        provider_driver IS NOT NULL AND
        process_instance_id IS NOT NULL AND
        certificate_fingerprint IS NOT NULL AND
        certificate_generation > 0 AND
        worker_lease_generation > 0 AND
        route_generation > 0
      )
    );

COMMIT;
