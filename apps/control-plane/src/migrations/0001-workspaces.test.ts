// @effect-diagnostics nodeBuiltinImport:off -- This focused test reads the checked-in SQL migration fixture.
import * as NodeFSP from "node:fs/promises";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

const loadMigration = Effect.promise(() =>
  NodeFSP.readFile(new URL("./0001-workspaces.sql", import.meta.url), "utf8"),
);

it.effect("keeps workspace ownership single-member, referential, and idempotent", () =>
  Effect.gen(function* () {
    const migration = yield* loadMigration;

    expect(migration).toContain('REFERENCES "user" (id) ON DELETE CASCADE');
    expect(migration).toContain("owner_user_id text NOT NULL UNIQUE");
    expect(migration).not.toContain("CREATE EXTENSION");
  }),
);
