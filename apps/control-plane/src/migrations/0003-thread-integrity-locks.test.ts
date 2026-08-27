// @effect-diagnostics nodeBuiltinImport:off -- This focused test reads checked-in SQL migrations.
import * as NodeFSP from "node:fs/promises";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

const loadMigration = (filename: string) =>
  Effect.promise(() => NodeFSP.readFile(new URL(filename, import.meta.url), "utf8"));

it.effect("preserves 0002 and upgrades integrity columns and full-key locks forward-only", () =>
  Effect.gen(function* () {
    const [originalMigration, upgrade] = yield* Effect.all([
      loadMigration("./0002-cloud-thread-store.sql"),
      loadMigration("./0003-thread-integrity-locks.sql"),
    ]);

    expect(originalMigration).not.toContain("occurred_at_text");
    expect(originalMigration).not.toContain("received_at_text");
    expect(originalMigration).not.toContain("cloud_thread_command_lock");
    expect(upgrade).toContain("SET LOCAL lock_timeout = '5s'");
    expect(upgrade).toContain("SET LOCAL statement_timeout = '30s'");
    expect(upgrade).toContain("ADD COLUMN IF NOT EXISTS occurred_at_text text");
    expect(upgrade).toContain("ADD COLUMN IF NOT EXISTS received_at_text text");
    expect(upgrade).toContain("envelope #>> '{event,occurredAt}'");
    expect(upgrade).toContain("envelope #>> '{receivedAt}'");
    expect(upgrade).toContain("ALTER COLUMN occurred_at_text SET NOT NULL");
    expect(upgrade).toContain("ALTER COLUMN received_at_text SET NOT NULL");
    expect(upgrade).toContain("CREATE TABLE IF NOT EXISTS cloud_thread_command_lock");
    expect(upgrade).toContain("PRIMARY KEY (workspace_id, lock_kind, lock_value)");
    expect(upgrade).toContain("CREATE INDEX IF NOT EXISTS cloud_thread_command_lock_retention_idx");
  }),
);
