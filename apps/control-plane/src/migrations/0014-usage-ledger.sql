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
  UNIQUE (
    workspace_id, sample_id, environment_id, thread_id, sandbox_id,
    upstream_micro_usdc, evidence_revision
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

-- One cursor per billing account. It is never reset by settlement, thread, or sandbox lifecycle.
CREATE TABLE IF NOT EXISTS cloud_usage_pricing_cursor (
  workspace_id uuid PRIMARY KEY REFERENCES workspace (id) ON DELETE RESTRICT,
  pricing_scope_kind text NOT NULL CHECK (pricing_scope_kind = 'workspace'),
  pricing_scope_id uuid NOT NULL,
  pricing_version integer NOT NULL CHECK (pricing_version = 1),
  transition_count bigint NOT NULL CHECK (
    transition_count BETWEEN 0 AND 9007199254740991
  ),
  cumulative_upstream_micro_usdc bigint NOT NULL CHECK (
    cumulative_upstream_micro_usdc BETWEEN 0 AND 9007199254740991
  ),
  cumulative_markup_micro_usdc bigint NOT NULL CHECK (
    cumulative_markup_micro_usdc BETWEEN 0 AND 9007199254740991
  ),
  cumulative_total_micro_usdc bigint NOT NULL CHECK (
    cumulative_total_micro_usdc BETWEEN 0 AND 9007199254740991
  ),
  updated_at timestamptz NOT NULL,
  UNIQUE (workspace_id, pricing_scope_id, pricing_version),
  CHECK (pricing_scope_id = workspace_id),
  CHECK (cumulative_markup_micro_usdc =
    cumulative_upstream_micro_usdc / 20 +
    CASE WHEN cumulative_upstream_micro_usdc % 20 >= 10 THEN 1 ELSE 0 END),
  CHECK (cumulative_total_micro_usdc =
    cumulative_upstream_micro_usdc + cumulative_markup_micro_usdc)
);

CREATE TABLE IF NOT EXISTS cloud_usage_ledger_entry (
  workspace_id uuid NOT NULL,
  accrual_id text NOT NULL CHECK (length(accrual_id) BETWEEN 1 AND 256),
  sample_id text NOT NULL,
  environment_id text NOT NULL,
  thread_id text NOT NULL,
  sandbox_id text NOT NULL,
  entry_kind text NOT NULL CHECK (entry_kind IN ('usage', 'correction')),
  evidence_revision integer NOT NULL CHECK (evidence_revision > 0),
  pricing_scope_kind text NOT NULL CHECK (pricing_scope_kind = 'workspace'),
  pricing_scope_id uuid NOT NULL,
  pricing_version integer NOT NULL CHECK (pricing_version = 1),
  pricing_sequence bigint NOT NULL CHECK (
    pricing_sequence BETWEEN 1 AND 9007199254740991
  ),
  evidence_previous_upstream_micro_usdc bigint NOT NULL CHECK (
    evidence_previous_upstream_micro_usdc BETWEEN 0 AND 9007199254740991
  ),
  evidence_upstream_micro_usdc bigint NOT NULL CHECK (
    evidence_upstream_micro_usdc BETWEEN 0 AND 9007199254740991
  ),
  cumulative_upstream_before_micro_usdc bigint NOT NULL CHECK (
    cumulative_upstream_before_micro_usdc BETWEEN 0 AND 9007199254740991
  ),
  cumulative_upstream_after_micro_usdc bigint NOT NULL CHECK (
    cumulative_upstream_after_micro_usdc BETWEEN 0 AND 9007199254740991
  ),
  markup_basis_points integer NOT NULL CHECK (markup_basis_points = 500),
  markup_rounding text NOT NULL CHECK (markup_rounding = 'half-up-to-nearest-micro-usdc'),
  cumulative_markup_before_micro_usdc bigint NOT NULL CHECK (
    cumulative_markup_before_micro_usdc BETWEEN 0 AND 9007199254740991
  ),
  cumulative_markup_after_micro_usdc bigint NOT NULL CHECK (
    cumulative_markup_after_micro_usdc BETWEEN 0 AND 9007199254740991
  ),
  cumulative_total_before_micro_usdc bigint NOT NULL CHECK (
    cumulative_total_before_micro_usdc BETWEEN 0 AND 9007199254740991
  ),
  cumulative_total_after_micro_usdc bigint NOT NULL CHECK (
    cumulative_total_after_micro_usdc BETWEEN 0 AND 9007199254740991
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
  UNIQUE (workspace_id, pricing_scope_id, pricing_version, pricing_sequence),
  FOREIGN KEY (
    workspace_id, sample_id, environment_id, thread_id, sandbox_id,
    evidence_upstream_micro_usdc, evidence_revision
  ) REFERENCES cloud_usage_sample (
    workspace_id, sample_id, environment_id, thread_id, sandbox_id,
    upstream_micro_usdc, evidence_revision
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, pricing_scope_id, pricing_version)
    REFERENCES cloud_usage_pricing_cursor (
      workspace_id, pricing_scope_id, pricing_version
    ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, thread_id, environment_id)
    REFERENCES cloud_thread (workspace_id, thread_id, environment_id) ON DELETE RESTRICT,
  CHECK (pricing_scope_id = workspace_id),
  CHECK (upstream_delta_micro_usdc =
    evidence_upstream_micro_usdc - evidence_previous_upstream_micro_usdc),
  CHECK (cumulative_upstream_after_micro_usdc =
    cumulative_upstream_before_micro_usdc + upstream_delta_micro_usdc),
  CHECK (cumulative_markup_before_micro_usdc =
    cumulative_upstream_before_micro_usdc / 20 +
    CASE WHEN cumulative_upstream_before_micro_usdc % 20 >= 10 THEN 1 ELSE 0 END),
  CHECK (cumulative_markup_after_micro_usdc =
    cumulative_upstream_after_micro_usdc / 20 +
    CASE WHEN cumulative_upstream_after_micro_usdc % 20 >= 10 THEN 1 ELSE 0 END),
  CHECK (cumulative_total_before_micro_usdc =
    cumulative_upstream_before_micro_usdc + cumulative_markup_before_micro_usdc),
  CHECK (cumulative_total_after_micro_usdc =
    cumulative_upstream_after_micro_usdc + cumulative_markup_after_micro_usdc),
  CHECK (markup_delta_micro_usdc =
    cumulative_markup_after_micro_usdc - cumulative_markup_before_micro_usdc),
  CHECK (total_delta_micro_usdc =
    cumulative_total_after_micro_usdc - cumulative_total_before_micro_usdc),
  CHECK (total_delta_micro_usdc = upstream_delta_micro_usdc + markup_delta_micro_usdc),
  CHECK (
    (entry_kind = 'usage' AND evidence_revision = 1 AND
      evidence_previous_upstream_micro_usdc = 0) OR
    (entry_kind = 'correction' AND evidence_revision > 1)
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

DROP TRIGGER IF EXISTS cloud_usage_pricing_cursor_no_delete ON cloud_usage_pricing_cursor;
CREATE TRIGGER cloud_usage_pricing_cursor_no_delete
  BEFORE DELETE ON cloud_usage_pricing_cursor
  FOR EACH ROW EXECUTE FUNCTION agentsin_cloud_reject_usage_mutation();

COMMIT;
