// @effect-diagnostics nodeBuiltinImport:off -- Migration tests inspect the adjacent SQL artifact.
import * as NodeFSP from "node:fs/promises";

import { expect, it } from "vite-plus/test";

const migration = await NodeFSP.readFile(
  new URL("./0010-artifact-storage.sql", import.meta.url),
  "utf8",
);

it("keeps PostgreSQL authoritative until immutable payload verification completes", () => {
  expect(migration).toContain("CREATE TABLE IF NOT EXISTS cloud_thread_artifact (");
  expect(migration).toContain("FOREIGN KEY (workspace_id, thread_id)");
  expect(migration).toContain("PRIMARY KEY (workspace_id, thread_id, artifact_id)");
  expect(migration).toContain("UNIQUE (workspace_id, thread_id, idempotency_key)");
  expect(migration).toContain("UNIQUE (workspace_id, object_key)");
  expect(migration).toContain(
    "state = 'complete' AND completed_at IS NOT NULL AND etag IS NOT NULL",
  );
  expect(migration).toContain("CREATE TABLE IF NOT EXISTS cloud_thread_artifact_outbox");
  expect(migration).toContain("lease_token uuid");
  expect(migration).toContain("ADD COLUMN IF NOT EXISTS lease_token uuid");
  expect(migration).toContain("cloud_thread_artifact_outbox_claim_idx");
  expect(migration).toContain("CREATE TABLE IF NOT EXISTS cloud_thread_export_intent");
  expect(migration).toContain("octet_length(snapshot::text) <= 8388608");
  expect(migration).toContain("FOREIGN KEY (workspace_id, thread_id, artifact_id)");
  expect(migration).toContain("'verify_upload', 'delete_object'");
  expect(migration).toContain(
    "WHERE state IN ('reserved', 'uploading', 'delete_pending', 'failed')",
  );
});
