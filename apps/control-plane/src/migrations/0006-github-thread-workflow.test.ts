// @effect-diagnostics nodeBuiltinImport:off -- Migration tests inspect the adjacent SQL artifact.
import * as NodeFSP from "node:fs/promises";

import { expect, it } from "vite-plus/test";

const migration = await NodeFSP.readFile(
  new URL("./0006-github-thread-workflow.sql", import.meta.url),
  "utf8",
);

it("keeps GitHub tokens out of durable workflow tables", () => {
  expect(migration).not.toMatch(/access_token|private_key|bearer/i);
  expect(migration).toContain("github_thread_workflow_outbox");
  expect(migration).toContain("github_thread_workflow_receipt");
  expect(migration).toContain("github_thread_workflow_event");
  expect(migration).toContain("github_worker_token_lease");
  expect(migration).toContain("secret_ref text NOT NULL");
  expect(migration).toContain("used_at timestamptz");
  expect(migration).toContain("environment_revision_id text NOT NULL");
  expect(migration).toContain("certificate_fingerprint text NOT NULL");
  expect(migration).toContain("worker_lease_generation bigint NOT NULL");
  expect(migration).toContain("route_generation bigint NOT NULL");
  expect(migration).not.toMatch(/\btoken\s+text\b/i);
});

it("scopes workflow keys and foreign keys by workspace", () => {
  expect(migration).toContain("PRIMARY KEY (workspace_id, thread_id)");
  expect(migration).toContain("UNIQUE (workspace_id, canonical_key, branch_name)");
  expect(migration).toContain("FOREIGN KEY (workspace_id, thread_id, environment_id)");
  expect(migration).toContain("(workspace_id, available_at, created_at)");
  expect(migration).toContain("attempt_count integer NOT NULL DEFAULT 0");
  expect(migration).toContain("actor_user_id text NOT NULL");
  expect(migration).toContain("auth_session_id text NOT NULL");
  expect(migration).toContain("expected_parent_sha text");
  expect(migration).not.toContain("workspace_directory text");
});
