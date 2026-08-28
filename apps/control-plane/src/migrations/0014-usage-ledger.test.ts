// @effect-diagnostics nodeBuiltinImport:off -- Focused migration test reads the adjacent SQL artifact.
import * as NodeFSP from "node:fs/promises";

import { describe, expect, it } from "vite-plus/test";

const migration = await NodeFSP.readFile(
  new URL("./0014-usage-ledger.sql", import.meta.url),
  "utf8",
);

describe("0014 authoritative usage ledger migration", () => {
  it("creates immutable tenant-bound evidence and fixed-point ledger tables", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS cloud_usage_sample");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS cloud_usage_pricing_cursor");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS cloud_usage_ledger_entry");
    expect(migration).toContain("verification = 'e2b-authenticated-billing-record'");
    expect(migration).toContain("UNIQUE (workspace_id, idempotency_key)");
    expect(migration).toContain("UNIQUE (workspace_id, evidence_id, evidence_revision)");
    expect(migration).toContain("markup_basis_points = 500");
    expect(migration).toContain("pricing_scope_kind = 'workspace'");
    expect(migration).toContain("pricing_scope_id = workspace_id");
    expect(migration).toContain("cumulative_upstream_after_micro_usdc");
    expect(migration).toContain("transition_count");
    expect(migration).toContain("half-up-to-nearest-micro-usdc");
    expect(migration).toContain("usage accounting rows are append-only");
    expect(migration).toContain("cloud_usage_sample_immutable");
    expect(migration).toContain("cloud_usage_ledger_entry_immutable");
  });

  it("contains no wallet or signing material", () => {
    const ddl = migration.replace(/^--.*$/gmu, "");
    expect(ddl).not.toMatch(/private_key|mnemonic|recovery_bundle|signing_stamp|wallet_secret/iu);
  });
});
