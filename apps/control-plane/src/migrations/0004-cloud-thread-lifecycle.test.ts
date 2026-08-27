// @effect-diagnostics nodeBuiltinImport:off -- This focused test reads the checked-in SQL migration.
import * as NodeFSP from "node:fs/promises";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

const loadMigration = Effect.promise(() =>
  NodeFSP.readFile(new URL("./0004-cloud-thread-lifecycle.sql", import.meta.url), "utf8"),
);

it.effect("fences one current E2B sandbox per tenant thread and retains saga history", () =>
  Effect.gen(function* () {
    const migration = yield* loadMigration;
    expect(migration).toContain("BEGIN;");
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS cloud_e2b_sandbox_identity");
    expect(migration).toContain("PRIMARY KEY (workspace_id, reservation_id)");
    expect(migration).not.toContain("reservation_id text PRIMARY KEY");
    expect(migration).toContain("cloud_e2b_one_current_sandbox_per_thread_idx");
    expect(migration).toContain("WHERE state IN ('reserved', 'active', 'cleanup_required')");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS cloud_thread_lifecycle_attempt");
    expect(migration).toContain("cloud_thread_one_current_lifecycle_attempt_idx");
    expect(migration).toContain("WHERE is_current");
    expect(migration).toContain("UNIQUE (workspace_id, idempotency_key)");
    expect(migration).toContain("CHECK (is_current OR state = 'failed')");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS cloud_thread_lifecycle_outbox");
    expect(migration).toContain("'create_sandbox', 'issue_bootstrap', 'start_worker'");
    expect(migration).toContain("status IN ('pending', 'processing', 'completed', 'failed')");
    expect(migration).toContain("FOREIGN KEY (workspace_id, thread_id, environment_id)");
    expect(migration).toContain("COMMIT;");
    expect(migration).not.toContain("wallet");
    expect(migration).not.toContain("private_key");
  }),
);
