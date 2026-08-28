// @effect-diagnostics nodeBuiltinImport:off -- Migration tests inspect the adjacent SQL artifact.
import * as NodeFSP from "node:fs/promises";

import { expect, it } from "vite-plus/test";

const migration = await NodeFSP.readFile(
  new URL("./0009-github-worker-route-binding.sql", import.meta.url),
  "utf8",
);

it("fences legacy leases and makes operation uniqueness route-aware", () => {
  expect(migration).toContain("SET used_at = COALESCE(used_at, now())");
  expect(migration).toContain(
    "pg_get_constraintdef(oid) = 'UNIQUE (workspace_id, sandbox_id, operation_id)'",
  );
  expect(migration).toContain("DROP CONSTRAINT %I");
  expect(migration).toContain("UNIQUE (workspace_id, sandbox_id, operation_id, route_generation)");
  expect(migration).toContain("github_worker_token_lease_route_binding_required");
  expect(migration.match(/IF NOT EXISTS \(/gu)).toHaveLength(2);
  expect(migration).toContain("conrelid = 'github_worker_token_lease'::regclass");
});
