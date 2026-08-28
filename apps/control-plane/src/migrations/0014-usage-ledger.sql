-- Authoritative E2B usage evidence and append-only fixed-point billing ledger.
-- Monitoring metrics and estimated prices are deliberately not accepted here.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS cloud_usage_sample (
  workspace_id uuid NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  sample_id text NOT NULL CHECK (length(sample_id) BETWEEN 1 AND 256),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  environment_id text NOT NULL,
  thread_id text NOT NULL,
  sandbox_id text NOT NULL,
  provider text NOT NULL CHECK (provider = 'e2b'),
  verification text NOT NULL CHECK (verification = 'e2b-authenticated-billing-record'),
  evidence_id text NOT NULL CHECK (length(evidence_id) BETWEEN 1 AND 256),
  evidence_revision integer NOT NULL CHECK (evidence_revision > 0),
  evidence_payload_sha256 text NOT NULL CHECK (evidence_payload_sha256 ~ '^[0-9a-f]{64}$'),
  interval_start timestamptz NOT NULL,
  interval_end timestamptz NOT NULL,
  upstream_micro_usdc bigint NOT NULL CHECK (
    upstream_micro_usdc BETWEEN 0 AND 9007199254740991
  ),
  prior_sample_id text,
  observed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, sample_id),
  UNIQUE (
    workspace_id, sample_id, environment_id, thread_id, sandbox_id, upstream_micro_usdc
  ),
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (workspace_id, evidence_id, evidence_revision),
  FOREIGN KEY (workspace_id, thread_id, environment_id)
    REFERENCES cloud_thread (workspace_id, thread_id, environment_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, prior_sample_id)
    REFERENCES cloud_usage_sample (workspace_id, sample_id),
  CHECK (interval_start < interval_end),
  CHECK (interval_end <= observed_at),
  CHECK (
    (evidence_revision = 1 AND prior_sample_id IS NULL) OR
    (evidence_revision > 1 AND prior_sample_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS cloud_usage_sample_sandbox_interval_idx
  ON cloud_usage_sample (workspace_id, sandbox_id, interval_end, interval_start)
  WHERE evidence_revision = 1;

CREATE TABLE IF NOT EXISTS cloud_usage_ledger_entry (
  workspace_id uuid NOT NULL,
  accrual_id text NOT NULL CHECK (length(accrual_id) BETWEEN 1 AND 256),
  sample_id text NOT NULL,
  environment_id text NOT NULL,
  thread_id text NOT NULL,
  sandbox_id text NOT NULL,
  entry_kind text NOT NULL CHECK (entry_kind IN ('usage', 'correction')),
  previous_upstream_micro_usdc bigint NOT NULL CHECK (
    previous_upstream_micro_usdc BETWEEN 0 AND 9007199254740991
  ),
  previous_markup_micro_usdc bigint NOT NULL CHECK (
    previous_markup_micro_usdc BETWEEN 0 AND 9007199254740991
  ),
  previous_total_micro_usdc bigint NOT NULL CHECK (
    previous_total_micro_usdc BETWEEN 0 AND 9007199254740991
  ),
  upstream_micro_usdc bigint NOT NULL CHECK (
    upstream_micro_usdc BETWEEN 0 AND 9007199254740991
  ),
  markup_basis_points integer NOT NULL CHECK (markup_basis_points = 500),
  markup_rounding text NOT NULL CHECK (markup_rounding = 'half-up-to-nearest-micro-usdc'),
  markup_micro_usdc bigint NOT NULL CHECK (
    markup_micro_usdc BETWEEN 0 AND 9007199254740991
  ),
  total_micro_usdc bigint NOT NULL CHECK (
    total_micro_usdc BETWEEN 0 AND 9007199254740991
  ),
  upstream_delta_micro_usdc bigint NOT NULL CHECK (
    upstream_delta_micro_usdc BETWEEN -9007199254740991 AND 9007199254740991
  ),
  markup_delta_micro_usdc bigint NOT NULL CHECK (
    markup_delta_micro_usdc BETWEEN -9007199254740991 AND 9007199254740991
  ),
  total_delta_micro_usdc bigint NOT NULL CHECK (
    total_delta_micro_usdc BETWEEN -9007199254740991 AND 9007199254740991
  ),
  receipt_input_sha256 text NOT NULL CHECK (receipt_input_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, accrual_id),
  UNIQUE (workspace_id, sample_id),
  UNIQUE (workspace_id, receipt_input_sha256),
  FOREIGN KEY (
    workspace_id, sample_id, environment_id, thread_id, sandbox_id, upstream_micro_usdc
  ) REFERENCES cloud_usage_sample (
    workspace_id, sample_id, environment_id, thread_id, sandbox_id, upstream_micro_usdc
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, thread_id, environment_id)
    REFERENCES cloud_thread (workspace_id, thread_id, environment_id) ON DELETE RESTRICT,
  CHECK (previous_markup_micro_usdc =
    previous_upstream_micro_usdc / 20 +
    CASE WHEN previous_upstream_micro_usdc % 20 >= 10 THEN 1 ELSE 0 END),
  CHECK (previous_total_micro_usdc =
    previous_upstream_micro_usdc + previous_markup_micro_usdc),
  CHECK (markup_micro_usdc =
    upstream_micro_usdc / 20 + CASE WHEN upstream_micro_usdc % 20 >= 10 THEN 1 ELSE 0 END),
  CHECK (total_micro_usdc = upstream_micro_usdc + markup_micro_usdc),
  CHECK (upstream_delta_micro_usdc = upstream_micro_usdc - previous_upstream_micro_usdc),
  CHECK (markup_delta_micro_usdc = markup_micro_usdc - previous_markup_micro_usdc),
  CHECK (total_delta_micro_usdc = total_micro_usdc - previous_total_micro_usdc),
  CHECK (
    (entry_kind = 'usage' AND previous_total_micro_usdc = 0) OR
    (entry_kind = 'correction')
  )
);

CREATE INDEX IF NOT EXISTS cloud_usage_ledger_unsettled_idx
  ON cloud_usage_ledger_entry (workspace_id, recorded_at, accrual_id);

CREATE OR REPLACE FUNCTION agentsin_cloud_reject_usage_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'usage accounting rows are append-only';
END;
$$;

DROP TRIGGER IF EXISTS cloud_usage_sample_immutable ON cloud_usage_sample;
CREATE TRIGGER cloud_usage_sample_immutable
  BEFORE UPDATE OR DELETE ON cloud_usage_sample
  FOR EACH ROW EXECUTE FUNCTION agentsin_cloud_reject_usage_mutation();

DROP TRIGGER IF EXISTS cloud_usage_ledger_entry_immutable ON cloud_usage_ledger_entry;
CREATE TRIGGER cloud_usage_ledger_entry_immutable
  BEFORE UPDATE OR DELETE ON cloud_usage_ledger_entry
  FOR EACH ROW EXECUTE FUNCTION agentsin_cloud_reject_usage_mutation();

COMMIT;
