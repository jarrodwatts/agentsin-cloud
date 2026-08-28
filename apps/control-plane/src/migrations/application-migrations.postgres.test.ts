// @effect-diagnostics nodeBuiltinImport:off -- PostgreSQL replay coverage loads isolated migration assets.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Pool } from "pg";

const postgresUrl = process.env.AGENTSIN_TEST_POSTGRES_URL;
const applicationMigrationFilenames = [
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
  "0015-e2b-template-identity.sql",
] as const;
const expectedRouteBindingDefinition =
  "CHECK (((used_at IS NOT NULL) OR ((environment_revision_id IS NOT NULL) AND (reservation_id IS NOT NULL) AND (worker_id IS NOT NULL) AND (provider_instance_id IS NOT NULL) AND (provider_driver IS NOT NULL) AND (process_instance_id IS NOT NULL) AND (certificate_fingerprint IS NOT NULL) AND (certificate_generation > 0) AND (worker_lease_generation > 0) AND (route_generation > 0))))";

interface ApplicationMigration {
  readonly filename: string;
  readonly sql: string;
}

interface ConstraintState {
  readonly conname: string;
  readonly contype: string;
  readonly convalidated: boolean;
  readonly definition: string;
}

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

const applyMigrations = async (pool: Pool, migrations: ReadonlyArray<ApplicationMigration>) => {
  for (const { sql } of migrations) await pool.query(sql);
};

const prepareMigratedDatabase = async (pool: Pool) => {
  await pool.query('CREATE TABLE "user" (id text PRIMARY KEY)');
  const migrations = await loadApplicationMigrations();
  expect(migrations.map(({ filename }) => filename)).toEqual(applicationMigrationFilenames);
  await applyMigrations(pool, migrations);
  const routeBindingMigration = migrations.find(
    ({ filename }) => filename === "0009-github-worker-route-binding.sql",
  );
  if (routeBindingMigration === undefined) {
    throw new Error("0009 GitHub worker route binding migration is missing");
  }
  const e2bIdentityMigration = migrations.find(
    ({ filename }) => filename === "0015-e2b-template-identity.sql",
  );
  if (e2bIdentityMigration === undefined) {
    throw new Error("0015 E2B template identity migration is missing");
  }
  return { migrations, routeBindingMigration, e2bIdentityMigration };
};

const readRouteConstraintState = async (pool: Pool) =>
  (
    await pool.query<ConstraintState>(
      `SELECT conname,
              contype::text AS contype,
              convalidated,
              btrim(regexp_replace(pg_get_constraintdef(oid), '[[:space:]]+', ' ', 'g'))
                AS definition
         FROM pg_constraint
        WHERE conrelid = 'github_worker_token_lease'::regclass
          AND conname IN (
            'github_worker_token_lease_route_operation_key',
            'github_worker_token_lease_route_binding_required'
          )
        ORDER BY conname`,
    )
  ).rows;

const expectReplayRejected = async (
  pool: Pool,
  migration: ApplicationMigration,
  constraintName: string,
) => {
  await expect(pool.query(migration.sql)).rejects.toMatchObject({
    code: "23000",
    message: expect.stringContaining(`${constraintName} does not match`),
  });
  await pool.query("ROLLBACK");
};

it.effect("replays every application migration without weakening route binding", () =>
  withPostgres(async (pool) => {
    const { migrations } = await prepareMigratedDatabase(pool);
    const beforeReplay = await readRouteConstraintState(pool);

    expect(beforeReplay).toEqual([
      {
        conname: "github_worker_token_lease_route_binding_required",
        contype: "c",
        convalidated: true,
        definition: expectedRouteBindingDefinition,
      },
      {
        conname: "github_worker_token_lease_route_operation_key",
        contype: "u",
        convalidated: true,
        definition: "UNIQUE (workspace_id, sandbox_id, operation_id, route_generation)",
      },
    ]);

    await applyMigrations(pool, migrations);
    expect(await readRouteConstraintState(pool)).toEqual(beforeReplay);
  }),
);

it.effect("fails closed for a weakened same-name route uniqueness constraint", () =>
  withPostgres(async (pool) => {
    const { routeBindingMigration } = await prepareMigratedDatabase(pool);
    await pool.query(`ALTER TABLE github_worker_token_lease
      DROP CONSTRAINT github_worker_token_lease_route_operation_key,
      ADD CONSTRAINT github_worker_token_lease_route_operation_key
      UNIQUE (workspace_id, sandbox_id, operation_id, route_generation, lease_ref)`);

    await expectReplayRejected(
      pool,
      routeBindingMigration,
      "github_worker_token_lease_route_operation_key",
    );
  }),
);

it.effect("fails closed for a different same-name route binding check", () =>
  withPostgres(async (pool) => {
    const { routeBindingMigration } = await prepareMigratedDatabase(pool);
    await pool.query(`ALTER TABLE github_worker_token_lease
      DROP CONSTRAINT github_worker_token_lease_route_binding_required,
      ADD CONSTRAINT github_worker_token_lease_route_binding_required
      CHECK (used_at IS NOT NULL OR route_generation > 0)`);

    await expectReplayRejected(
      pool,
      routeBindingMigration,
      "github_worker_token_lease_route_binding_required",
    );
  }),
);

it.effect("fails closed for a same-name route binding check that is not validated", () =>
  withPostgres(async (pool) => {
    const { routeBindingMigration } = await prepareMigratedDatabase(pool);
    await pool.query(`ALTER TABLE github_worker_token_lease
      DROP CONSTRAINT github_worker_token_lease_route_binding_required,
      ADD CONSTRAINT github_worker_token_lease_route_binding_required
      CHECK (
        used_at IS NOT NULL OR (
          environment_revision_id IS NOT NULL AND reservation_id IS NOT NULL AND
          worker_id IS NOT NULL AND provider_instance_id IS NOT NULL AND
          provider_driver IS NOT NULL AND process_instance_id IS NOT NULL AND
          certificate_fingerprint IS NOT NULL AND certificate_generation > 0 AND
          worker_lease_generation > 0 AND route_generation > 0
        )
      ) NOT VALID`);

    await expectReplayRejected(
      pool,
      routeBindingMigration,
      "github_worker_token_lease_route_binding_required",
    );
  }),
);

it.effect("fails closed for a wrong-type same-name route binding constraint", () =>
  withPostgres(async (pool) => {
    const { routeBindingMigration } = await prepareMigratedDatabase(pool);
    await pool.query(`ALTER TABLE github_worker_token_lease
      DROP CONSTRAINT github_worker_token_lease_route_binding_required,
      ADD CONSTRAINT github_worker_token_lease_route_binding_required
      UNIQUE (lease_ref, route_generation)`);

    await expectReplayRejected(
      pool,
      routeBindingMigration,
      "github_worker_token_lease_route_binding_required",
    );
  }),
);

const expectE2bReplayRejected = async (
  pool: Pool,
  migration: ApplicationMigration,
  message: string,
) => {
  await expect(pool.query(migration.sql)).rejects.toMatchObject({
    code: "23000",
    message: expect.stringContaining(message),
  });
  await pool.query("ROLLBACK");
};

it.effect("fails closed for a weakened same-name E2B build check", () =>
  withPostgres(async (pool) => {
    const { e2bIdentityMigration } = await prepareMigratedDatabase(pool);
    await pool.query(`ALTER TABLE cloud_e2b_sandbox_identity
      DROP CONSTRAINT cloud_e2b_provider_build_id_format,
      ADD CONSTRAINT cloud_e2b_provider_build_id_format CHECK (true)`);
    await expectE2bReplayRejected(
      pool,
      e2bIdentityMigration,
      "cloud_e2b_provider_build_id_format does not match",
    );
  }),
);

it.effect("fails closed for an unvalidated E2B build check", () =>
  withPostgres(async (pool) => {
    const { e2bIdentityMigration } = await prepareMigratedDatabase(pool);
    await pool.query(`ALTER TABLE cloud_e2b_sandbox_identity
      DROP CONSTRAINT cloud_e2b_provider_build_id_format,
      ADD CONSTRAINT cloud_e2b_provider_build_id_format CHECK (
        provider_build_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      ) NOT VALID`);
    await expectE2bReplayRejected(
      pool,
      e2bIdentityMigration,
      "cloud_e2b_provider_build_id_format does not match",
    );
  }),
);

it.effect("fails closed for a wrong-type same-name E2B build constraint", () =>
  withPostgres(async (pool) => {
    const { e2bIdentityMigration } = await prepareMigratedDatabase(pool);
    await pool.query(`ALTER TABLE cloud_e2b_sandbox_identity
      DROP CONSTRAINT cloud_e2b_provider_build_id_format,
      ADD CONSTRAINT cloud_e2b_provider_build_id_format UNIQUE (provider_build_id)`);
    await expectE2bReplayRejected(
      pool,
      e2bIdentityMigration,
      "cloud_e2b_provider_build_id_format does not match",
    );
  }),
);

it.effect("fails closed when an E2B provider identity column drifts from text", () =>
  withPostgres(async (pool) => {
    const { e2bIdentityMigration } = await prepareMigratedDatabase(pool);
    await pool.query(`ALTER TABLE cloud_e2b_sandbox_identity
      DROP CONSTRAINT cloud_e2b_provider_build_id_format,
      ALTER COLUMN provider_build_id DROP NOT NULL,
      ALTER COLUMN provider_build_id TYPE varchar(64)`);
    await expectE2bReplayRejected(
      pool,
      e2bIdentityMigration,
      "provider identity columns have unexpected types",
    );
  }),
);
