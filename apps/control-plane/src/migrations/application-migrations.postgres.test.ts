// @effect-diagnostics nodeBuiltinImport:off -- PostgreSQL replay coverage loads isolated migration assets.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Pool } from "pg";

import { applicationMigrationFilenames } from "../applicationMigrations.ts";

const postgresUrl = process.env.AGENTSIN_TEST_POSTGRES_URL;
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

const seedLegacySettlementDependencies = async (pool: Pool) => {
  await pool.query('INSERT INTO "user" (id) VALUES ($1)', ["legacy-settlement-owner"]);
  await pool.query("INSERT INTO workspace (id, owner_user_id, name) VALUES ($1,$2,$3)", [
    "88888888-8888-4888-8888-888888888888",
    "legacy-settlement-owner",
    "Legacy settlement",
  ]);
  await pool.query(
    "INSERT INTO cloud_thread (workspace_id, thread_id, environment_id) VALUES ($1,$2,$3)",
    [
      "88888888-8888-4888-8888-888888888888",
      "legacy-settlement-thread",
      "legacy-settlement-environment",
    ],
  );
  await pool.query(
    `INSERT INTO cloud_wallet (
       workspace_id, wallet_id, owner_user_id, provider, provider_organization_ref,
       provider_wallet_ref, evm_address, state, recovery_method, recovery_enabled,
       created_at, updated_at
     ) VALUES ($1,$2,$3,'turnkey',$4,$5,$6,'active','passkeyAndEmail',true,$7,$7)`,
    [
      "88888888-8888-4888-8888-888888888888",
      "legacy-wallet",
      "legacy-settlement-owner",
      "legacy-turnkey-org",
      "legacy-turnkey-wallet",
      "0x1111111111111111111111111111111111111111",
      "2026-08-28T00:00:00.000Z",
    ],
  );
  await pool.query(
    `INSERT INTO cloud_wallet_delegated_authorization (
       workspace_id, wallet_id, authorization_id, chain_id, token_contract,
       treasury_address, per_charge_limit_micro_usdc, daily_limit_micro_usdc,
       starts_at, expires_at, policy_revision, provider_policy_ref,
       provider_delegated_user_ref, provider_delegated_credential_ref,
       state, created_at, updated_at
     ) VALUES ($1,$2,$3,143,$4,$5,10000000,50000000,$6,$7,1,$8,$9,$10,'active',$6,$6)`,
    [
      "88888888-8888-4888-8888-888888888888",
      "legacy-wallet",
      "legacy-authorization",
      "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
      "0x2222222222222222222222222222222222222222",
      "2026-08-28T00:00:00.000Z",
      "2026-08-29T00:00:00.000Z",
      "legacy-policy",
      "legacy-delegated-user",
      "secret://turnkey/delegated/legacy",
    ],
  );
};

const insertLegacySettlement = (
  pool: Pool,
  input: {
    readonly id: string;
    readonly state: string;
    readonly threadId?: string;
    readonly providerActivityRef?: string;
    readonly txHash?: string;
  },
) =>
  pool.query(
    `INSERT INTO cloud_usage_settlement_attempt (
       workspace_id, settlement_id, thread_id, state, trigger_kind, wallet_id,
       authorization_id, wallet_address, treasury_address, first_pricing_sequence,
       last_pricing_sequence, accrual_count, upstream_delta_micro_usdc,
       markup_delta_micro_usdc, total_delta_micro_usdc, request_fingerprint,
       provider_activity_ref, tx_hash, transfer_submitted_at, created_at, updated_at, finalized_at
     ) VALUES ($1,$2,$3,$4,'sandbox-paused',$5,$6,$7,$8,1,1,1,100,5,105,$9,$10,$11,
       CASE WHEN $11::text IS NULL THEN NULL ELSE $12::timestamptz END,
       $12::timestamptz,$12::timestamptz,
       CASE WHEN $4 = 'finalized' THEN $12::timestamptz ELSE NULL END)`,
    [
      "88888888-8888-4888-8888-888888888888",
      input.id,
      input.threadId ?? "legacy-settlement-thread",
      input.state,
      "legacy-wallet",
      "legacy-authorization",
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
      NodeCrypto.createHash("sha256").update(input.id).digest("hex"),
      input.providerActivityRef ?? null,
      input.txHash ?? null,
      "2026-08-28T00:15:00.000Z",
    ],
  );

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

it.effect("upgrades legacy settlement states through the additive hardening migration", () =>
  withPostgres(async (pool) => {
    await pool.query('CREATE TABLE "user" (id text PRIMARY KEY)');
    const migrations = await loadApplicationMigrations();
    const legacy = migrations.filter(({ filename }) => filename <= "0016-usage-settlements.sql");
    const hardening = migrations.find(
      ({ filename }) => filename === "0017-usage-settlement-hardening.sql",
    );
    if (hardening === undefined) throw new Error("0017 settlement hardening migration is missing");
    await applyMigrations(pool, legacy);
    await seedLegacySettlementDependencies(pool);
    await pool.query(
      `INSERT INTO cloud_thread (workspace_id, thread_id, environment_id) VALUES
       ($1,'legacy-submission-thread','legacy-submission-environment'),
       ($1,'legacy-reconciliation-thread','legacy-reconciliation-environment'),
       ($1,'legacy-applied-thread','legacy-applied-environment'),
       ($1,'legacy-low-balance-thread','legacy-low-balance-environment')`,
      ["88888888-8888-4888-8888-888888888888"],
    );
    await insertLegacySettlement(pool, { id: "legacy-reserved", state: "reserved" });
    await insertLegacySettlement(pool, {
      id: "legacy-submission",
      state: "submission-pending",
      threadId: "legacy-submission-thread",
      providerActivityRef: "legacy-submission-activity",
    });
    await insertLegacySettlement(pool, {
      id: "legacy-reconciliation",
      state: "reconciliation-required",
      threadId: "legacy-reconciliation-thread",
      providerActivityRef: "legacy-reconciliation-activity",
    });
    await insertLegacySettlement(pool, {
      id: "legacy-applied",
      state: "transfer-applied",
      threadId: "legacy-applied-thread",
      providerActivityRef: "legacy-applied-activity",
      txHash: `0x${"A".repeat(64)}`,
    });
    await insertLegacySettlement(pool, {
      id: "legacy-low-balance",
      state: "low-balance-paused",
      threadId: "legacy-low-balance-thread",
      providerActivityRef: "legacy-low-balance-activity",
    });

    await pool.query(hardening.sql);
    expect(
      (
        await pool.query(
          `SELECT settlement_id, state, authorization_generation, provider_attempt_generation,
                  next_submit_not_before, tx_hash
             FROM cloud_usage_settlement_attempt ORDER BY settlement_id`,
        )
      ).rows,
    ).toEqual([
      expect.objectContaining({
        settlement_id: "legacy-applied",
        authorization_generation: 1,
        provider_attempt_generation: 1,
        tx_hash: `0x${"a".repeat(64)}`,
      }),
      expect.objectContaining({
        settlement_id: "legacy-low-balance",
        provider_attempt_generation: 2,
      }),
      expect.objectContaining({ settlement_id: "legacy-reconciliation" }),
      expect.objectContaining({ settlement_id: "legacy-reserved" }),
      expect.objectContaining({
        settlement_id: "legacy-submission",
        state: "reconciliation-required",
      }),
    ]);
    expect(
      (
        await pool.query(
          `SELECT settlement_id, state FROM cloud_usage_settlement_provider_attempt
            ORDER BY settlement_id`,
        )
      ).rows,
    ).toEqual([
      { settlement_id: "legacy-applied", state: "applied" },
      { settlement_id: "legacy-low-balance", state: "not-applied" },
      { settlement_id: "legacy-reconciliation", state: "unknown" },
      { settlement_id: "legacy-submission", state: "unknown" },
    ]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM cloud_usage_settlement_authorization_binding",
        )
      ).rows[0],
    ).toEqual({ count: 5 });
    expect(
      (
        await pool.query(
          `SELECT thread_id, reason, state
             FROM cloud_usage_billing_fence
            ORDER BY thread_id`,
        )
      ).rows,
    ).toEqual([
      {
        thread_id: "legacy-low-balance-thread",
        reason: "insufficient-balance",
        state: "paused",
      },
      {
        thread_id: "legacy-reconciliation-thread",
        reason: "provider-outcome-uncertain",
        state: "pause-pending",
      },
      {
        thread_id: "legacy-submission-thread",
        reason: "provider-outcome-uncertain",
        state: "pause-pending",
      },
    ]);
    await pool.query(hardening.sql);
  }),
);

it.effect("rejects case-variant legacy transaction hash collisions", () =>
  withPostgres(async (pool) => {
    await pool.query('CREATE TABLE "user" (id text PRIMARY KEY)');
    const migrations = await loadApplicationMigrations();
    await applyMigrations(
      pool,
      migrations.filter(({ filename }) => filename <= "0016-usage-settlements.sql"),
    );
    await seedLegacySettlementDependencies(pool);
    await insertLegacySettlement(pool, {
      id: "legacy-case-lower",
      state: "transfer-applied",
      providerActivityRef: "legacy-case-lower-activity",
      txHash: `0x${"a".repeat(64)}`,
    });
    await insertLegacySettlement(pool, {
      id: "legacy-case-upper",
      state: "transfer-applied",
      providerActivityRef: "legacy-case-upper-activity",
      txHash: `0x${"A".repeat(64)}`,
    });
    const hardening = migrations.find(
      ({ filename }) => filename === "0017-usage-settlement-hardening.sql",
    );
    if (hardening === undefined) throw new Error("0017 settlement hardening migration is missing");
    await expect(pool.query(hardening.sql)).rejects.toMatchObject({
      code: "23000",
      message: expect.stringContaining("case-variant settlement transaction hashes"),
    });
    await pool.query("ROLLBACK");
  }),
);

it.effect("fails closed instead of rewriting a signed legacy receipt", () =>
  withPostgres(async (pool) => {
    await pool.query('CREATE TABLE "user" (id text PRIMARY KEY)');
    const migrations = await loadApplicationMigrations();
    await applyMigrations(
      pool,
      migrations.filter(({ filename }) => filename <= "0016-usage-settlements.sql"),
    );
    await seedLegacySettlementDependencies(pool);
    const txHash = `0x${"B".repeat(64)}`;
    await insertLegacySettlement(pool, {
      id: "legacy-signed-receipt",
      state: "finalized",
      providerActivityRef: "legacy-signed-receipt-activity",
      txHash,
    });
    await pool.query(
      `INSERT INTO cloud_usage_settlement_receipt (
         workspace_id, settlement_id, thread_id, payload, payload_sha256,
         signature_algorithm, signature_key_id, signature, signed_at, tx_hash, created_at
       ) VALUES ($1,$2,$3,$4::jsonb,$5,'ed25519','legacy-key','legacy-signature',$6,$7,$6)`,
      [
        "88888888-8888-4888-8888-888888888888",
        "legacy-signed-receipt",
        "legacy-settlement-thread",
        JSON.stringify({ txHash }),
        "c".repeat(64),
        "2026-08-28T00:15:00.000Z",
        txHash,
      ],
    );
    const hardening = migrations.find(
      ({ filename }) => filename === "0017-usage-settlement-hardening.sql",
    );
    if (hardening === undefined) throw new Error("0017 settlement hardening migration is missing");
    await expect(pool.query(hardening.sql)).rejects.toMatchObject({
      code: "23000",
      message: expect.stringContaining("noncanonical signed settlement receipt"),
    });
    await pool.query("ROLLBACK");
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
