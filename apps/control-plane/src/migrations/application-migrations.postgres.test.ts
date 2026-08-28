// @effect-diagnostics nodeBuiltinImport:off -- PostgreSQL replay coverage loads isolated migration assets.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Pool } from "pg";

const postgresUrl = process.env.AGENTSIN_TEST_POSTGRES_URL;

const loadApplicationMigrations = async () => {
  const migrationsDirectory = new URL("./", import.meta.url);
  const filenames = (await NodeFSP.readdir(migrationsDirectory))
    .filter((filename) => /^\d{4}-.+\.sql$/u.test(filename))
    .sort();
  return Promise.all(
    filenames.map(async (filename) => ({
      filename,
      sql: await NodeFSP.readFile(new URL(filename, migrationsDirectory), "utf8"),
    })),
  );
};

const withPostgres = (use: (pool: Pool) => Promise<void>) => {
  if (postgresUrl === undefined) return Effect.void;
  return Effect.acquireUseRelease(
    Effect.promise(async () => {
      const schema = `agentsin_migration_replay_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
      const admin = new Pool({ connectionString: postgresUrl, max: 1 });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const pool = new Pool({
        connectionString: postgresUrl,
        max: 1,
        options: `-c search_path=${schema}`,
        connectionTimeoutMillis: 5_000,
        query_timeout: 30_000,
        statement_timeout: 30_000,
      });
      return { admin, pool, schema };
    }),
    ({ pool }) => Effect.promise(() => use(pool)),
    ({ admin, pool, schema }) =>
      Effect.promise(async () => {
        await pool.end().catch(() => undefined);
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
        await admin.end().catch(() => undefined);
      }),
  );
};

it.effect("replays every application migration without weakening route binding", () =>
  withPostgres(async (pool) => {
    await pool.query('CREATE TABLE "user" (id text PRIMARY KEY)');
    const migrations = await loadApplicationMigrations();

    expect(migrations.map(({ filename }) => filename)).toEqual([
      "0001-workspaces.sql",
      "0002-cloud-thread-store.sql",
      "0003-thread-integrity-locks.sql",
      "0004-cloud-thread-lifecycle.sql",
      "0005-worker-mtls.sql",
      "0006-github-thread-workflow.sql",
      "0007-provider-credential-profiles.sql",
      "0008-thread-route-generation.sql",
      "0009-github-worker-route-binding.sql",
      "0010-artifact-storage.sql",
      "0011-desktop-leases.sql",
      "0012-user-wallets.sql",
      "0013-cloud-thread-runtime.sql",
      "0014-usage-ledger.sql",
    ]);

    for (const { sql } of migrations) await pool.query(sql);
    for (const { sql } of migrations) await pool.query(sql);

    const constraints = await pool.query<{
      readonly conname: string;
      readonly contype: string;
      readonly convalidated: boolean;
      readonly definition: string;
    }>(
      `SELECT conname, contype, convalidated, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'github_worker_token_lease'::regclass
          AND conname IN (
            'github_worker_token_lease_route_operation_key',
            'github_worker_token_lease_route_binding_required'
          )
        ORDER BY conname`,
    );

    expect(constraints.rows).toHaveLength(2);
    expect(constraints.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conname: "github_worker_token_lease_route_operation_key",
          contype: "u",
          convalidated: true,
          definition: "UNIQUE (workspace_id, sandbox_id, operation_id, route_generation)",
        }),
        expect.objectContaining({
          conname: "github_worker_token_lease_route_binding_required",
          contype: "c",
          convalidated: true,
        }),
      ]),
    );
    const routeBinding = constraints.rows.find(
      ({ conname }) => conname === "github_worker_token_lease_route_binding_required",
    );
    expect(routeBinding?.definition).toContain("used_at IS NOT NULL");
    expect(routeBinding?.definition).toContain("certificate_generation > 0");
    expect(routeBinding?.definition).toContain("worker_lease_generation > 0");
    expect(routeBinding?.definition).toContain("route_generation > 0");
  }),
);
