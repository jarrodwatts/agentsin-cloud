// @effect-diagnostics nodeBuiltinImport:off -- Focused test reads one checked-in migration asset.
import * as NodeFSP from "node:fs/promises";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

const loadMigration = Effect.promise(() =>
  NodeFSP.readFile(new URL("./0013-cloud-thread-runtime.sql", import.meta.url), "utf8"),
);

it.effect("keeps idle, pause, resume, and activity state authoritative in PostgreSQL", () =>
  Effect.gen(function* () {
    const migration = yield* loadMigration;
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS cloud_thread_runtime");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS cloud_thread_runtime_activity");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS cloud_thread_runtime_activity_event");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS cloud_thread_runtime_resume_request");
    expect(migration).toContain("cloud_thread_runtime_idle_idx");
    expect(migration).toContain("cloud_thread_runtime_recovery_idx");
    expect(migration).toContain("agentsin_cloud_seed_thread_runtime");
    expect(migration).toContain("AFTER INSERT OR UPDATE OF state, is_current");
    expect(migration).toContain("source IN ('agent', 'preview')");
    expect(migration).toContain("reason IN ('message', 'inspector', 'approved_continuation')");
    expect(migration).not.toContain("valkey");
    expect(migration).not.toContain("private_key");
    expect(migration).not.toContain("wallet");
  }),
);
