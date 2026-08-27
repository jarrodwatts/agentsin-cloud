// @effect-diagnostics nodeBuiltinImport:off -- This focused test reads a checked-in SQL migration.
import * as NodeFSP from "node:fs/promises";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

it.effect("allocates route fencing in durable workspace-thread scope", () =>
  Effect.gen(function* () {
    const migration = yield* Effect.promise(() =>
      NodeFSP.readFile(new URL("./0008-thread-route-generation.sql", import.meta.url), "utf8"),
    );

    expect(migration).toContain("CREATE TABLE IF NOT EXISTS cloud_thread_route_generation");
    expect(migration).toContain("PRIMARY KEY (workspace_id, thread_id)");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS route_generation bigint");
    expect(migration).toContain("GREATEST(count(*)::bigint, max(lease_generation))");
    expect(migration).toContain("ALTER COLUMN route_generation SET NOT NULL");
    expect(migration).toContain("ON DELETE CASCADE");
  }),
);
