// @effect-diagnostics nodeBuiltinImport:off -- Migration tests inspect the adjacent SQL artifact.
import * as NodeFSP from "node:fs/promises";

import { describe, expect, it } from "vite-plus/test";

const migration = await NodeFSP.readFile(
  new URL("./0011-desktop-leases.sql", import.meta.url),
  "utf8",
);

describe("0011 desktop lease migration", () => {
  it("creates tenant-scoped lease history, one-active fencing, and audit events", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS cloud_desktop_lease");
    expect(migration).toContain("cloud_desktop_one_active_lease_idx");
    expect(migration).toContain("WHERE state = 'active'");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS cloud_desktop_lease_event");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS cloud_desktop_lease_generation");
    expect(migration).toContain("last_generation bigint NOT NULL");
    expect(migration).toContain("UNIQUE (workspace_id, idempotency_key)");
    expect(migration).toContain("REFERENCES cloud_thread_lifecycle_attempt");
  });

  it("stores only a resume-secret hash and no credential payload", () => {
    expect(migration).toContain("resume_secret_hash");
    expect(migration).not.toMatch(/resume_secret\s+text/u);
    expect(migration).not.toMatch(/provider.*credential|wallet.*key|private.*key/iu);
  });
});
