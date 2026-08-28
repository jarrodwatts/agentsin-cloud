-- Pin every durable sandbox reservation to E2B's provider-native template and build identities.
-- Existing rows without that evidence must block migration rather than silently trusting a tag.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_e2b_sandbox_identity
  ADD COLUMN IF NOT EXISTS provider_template_id text,
  ADD COLUMN IF NOT EXISTS provider_build_id text;

DO $$
DECLARE
  template_type text;
  template_not_null boolean;
  build_type text;
  build_not_null boolean;
BEGIN
  SELECT format_type(atttypid, atttypmod), attnotnull
    INTO template_type, template_not_null
    FROM pg_attribute
   WHERE attrelid = 'cloud_e2b_sandbox_identity'::regclass
     AND attname = 'provider_template_id'
     AND NOT attisdropped;
  SELECT format_type(atttypid, atttypmod), attnotnull
    INTO build_type, build_not_null
    FROM pg_attribute
   WHERE attrelid = 'cloud_e2b_sandbox_identity'::regclass
     AND attname = 'provider_build_id'
     AND NOT attisdropped;
  IF template_type IS DISTINCT FROM 'text' OR build_type IS DISTINCT FROM 'text' THEN
    RAISE EXCEPTION 'cloud_e2b_sandbox_identity provider identity columns have unexpected types'
      USING ERRCODE = '23000';
  END IF;
  -- Existing nullable columns may only be tightened when every row already carries evidence.
  IF (NOT template_not_null OR NOT build_not_null) AND EXISTS (
    SELECT 1 FROM cloud_e2b_sandbox_identity
     WHERE provider_template_id IS NULL OR provider_build_id IS NULL
  ) THEN
    RAISE EXCEPTION 'cloud_e2b_sandbox_identity contains unpinned provider identities'
      USING ERRCODE = '23000';
  END IF;
END
$$;

ALTER TABLE cloud_e2b_sandbox_identity
  ALTER COLUMN provider_template_id SET NOT NULL,
  ALTER COLUMN provider_build_id SET NOT NULL;

DO $$
DECLARE
  constraint_type text;
  constraint_validated boolean;
  constraint_definition text;
  expected_definition constant text :=
    'CHECK ((provider_build_id ~ ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''::text))';
BEGIN
  SELECT contype::text,
         convalidated,
         btrim(regexp_replace(pg_get_constraintdef(oid), '[[:space:]]+', ' ', 'g'))
    INTO constraint_type, constraint_validated, constraint_definition
    FROM pg_constraint
   WHERE conname = 'cloud_e2b_provider_build_id_format'
     AND conrelid = 'cloud_e2b_sandbox_identity'::regclass;
  IF FOUND THEN
    IF constraint_type <> 'c'
       OR NOT constraint_validated
       OR constraint_definition <> expected_definition THEN
      RAISE EXCEPTION
        'cloud_e2b_provider_build_id_format does not match its required validated definition'
        USING ERRCODE = '23000';
    END IF;
  ELSE
    ALTER TABLE cloud_e2b_sandbox_identity
      ADD CONSTRAINT cloud_e2b_provider_build_id_format CHECK (
        provider_build_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      );
  END IF;
END
$$;

COMMIT;
