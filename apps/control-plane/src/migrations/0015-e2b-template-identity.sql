-- Pin every durable sandbox reservation to E2B's provider-native template and build identities.
-- Existing rows without that evidence must block migration rather than silently trusting a tag.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_e2b_sandbox_identity
  ADD COLUMN IF NOT EXISTS provider_template_id text,
  ADD COLUMN IF NOT EXISTS provider_build_id text;

ALTER TABLE cloud_e2b_sandbox_identity
  ALTER COLUMN provider_template_id SET NOT NULL,
  ALTER COLUMN provider_build_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'cloud_e2b_provider_build_id_format'
       AND conrelid = 'cloud_e2b_sandbox_identity'::regclass
  ) THEN
    ALTER TABLE cloud_e2b_sandbox_identity
      ADD CONSTRAINT cloud_e2b_provider_build_id_format CHECK (
        provider_build_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      );
  END IF;
END
$$;

COMMIT;
