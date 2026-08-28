// @effect-diagnostics nodeBuiltinImport:off -- Migration tests inspect the adjacent SQL artifact.
import * as NodeFSP from "node:fs/promises";

import { describe, expect, it } from "vite-plus/test";

const migration = await NodeFSP.readFile(
  new URL("./0012-user-wallets.sql", import.meta.url),
  "utf8",
);

describe("0012 user wallet migration", () => {
  it("creates tenant-scoped wallets, operations, recovery, spend, and audit state", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS cloud_wallet (");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS cloud_wallet_provisioning_intent");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS cloud_wallet_operation");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS cloud_wallet_delegated_authorization");
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS cloud_wallet_delegation_configuration_intent",
    );
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS cloud_wallet_delegation_revocation");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS cloud_wallet_recovery_attempt");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS cloud_wallet_spend_reservation");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS cloud_wallet_audit_event");
    expect(migration).toContain("UNIQUE (workspace_id, idempotency_key)");
    expect(migration).toContain("cloud_wallet_one_active_delegation_idx");
    expect(migration).toContain("cloud_wallet_one_pending_delegation_change_idx");
    expect(migration).toContain("provider_status text");
    expect(migration).toContain("provider_activity_ref text");
    expect(migration).toContain("provider_status = 'notApplied'");
    expect(migration).toContain("WHERE state IN ('reserved', 'submitted')");
  });

  it("pins Monad and native Circle USDC while excluding sensitive wallet material", () => {
    const ddl = migration.replace(/^--.*$/gmu, "");
    expect(migration).toContain("chain_id = 143");
    expect(migration).toContain("0x754704Bc059F8C67012fEd69BC8A327a5aafb603");
    expect(ddl).not.toMatch(/private_key|api_private|mnemonic|recovery_bundle|signing_stamp/iu);
  });
});
