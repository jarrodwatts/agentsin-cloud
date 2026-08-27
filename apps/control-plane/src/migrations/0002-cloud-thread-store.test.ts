// @effect-diagnostics nodeBuiltinImport:off -- This focused test reads the checked-in SQL migration fixture.
import * as NodeFSP from "node:fs/promises";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

const loadMigration = Effect.promise(() =>
  NodeFSP.readFile(new URL("./0002-cloud-thread-store.sql", import.meta.url), "utf8"),
);

it.effect("is additive, repeatable, bounded, and tenant-keyed", () =>
  Effect.gen(function* () {
    const migration = yield* loadMigration;
    const tables = [
      "cloud_thread",
      "cloud_thread_command",
      "cloud_thread_event",
      "cloud_thread_approval",
      "cloud_thread_checkpoint",
      "cloud_thread_runtime_lifecycle",
      "cloud_thread_outbox",
    ];

    expect(migration).toContain("BEGIN;");
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'");
    expect(migration).toContain("COMMIT;");
    expect(migration).not.toContain("CREATE EXTENSION");
    for (const table of tables) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(migration.match(/workspace_id uuid NOT NULL/g)).toHaveLength(tables.length);
    expect(migration).toContain("PRIMARY KEY (workspace_id, thread_id, sequence)");
    expect(migration).toContain("UNIQUE (workspace_id, idempotency_key)");
    expect(migration).toContain("UNIQUE (workspace_id, event_id)");
    expect(migration).toContain(
      "REFERENCES cloud_thread (workspace_id, thread_id, environment_id)",
    );
    expect(migration).toContain(
      "REFERENCES cloud_thread_event (workspace_id, thread_id, sequence)",
    );
    expect(migration).toContain("REFERENCES cloud_thread (workspace_id, thread_id)");
    expect(migration.match(/CREATE INDEX IF NOT EXISTS/g)).toHaveLength(5);
  }),
);
