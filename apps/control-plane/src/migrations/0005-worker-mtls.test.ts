// @effect-diagnostics nodeBuiltinImport:off -- This focused test reads a checked-in SQL migration.
import * as NodeFSP from "node:fs/promises";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

it.effect("adds tenant-bound single-use worker identity, certificate, and lease state", () =>
  Effect.gen(function* () {
    const sql = yield* Effect.promise(() =>
      NodeFSP.readFile(new URL("./0005-worker-mtls.sql", import.meta.url), "utf8"),
    );
    expect(sql).toContain("SET LOCAL statement_timeout = '30s'");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS cloud_worker_bootstrap_token");
    expect(sql).toContain("token_hash text PRIMARY KEY");
    expect(sql).toContain("consumed_at timestamptz");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS cloud_worker_certificate");
    expect(sql).toContain("certificate_generation bigint NOT NULL");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS cloud_worker_lease");
    expect(sql).toContain("PRIMARY KEY (workspace_id, sandbox_id)");
    expect(sql).toContain("confirmed_event_cursor bigint NOT NULL DEFAULT -1");
  }),
);
