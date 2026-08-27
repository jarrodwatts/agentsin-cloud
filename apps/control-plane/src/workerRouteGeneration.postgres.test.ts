// @effect-diagnostics nodeBuiltinImport:off -- Real PostgreSQL coverage uses isolated schemas and checked-in migrations.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentRevisionId, SandboxId, WorkspaceId } from "@t3tools/contracts/cloud";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Pool, type QueryResultRow } from "pg";

import { DatabaseError, type DatabaseService } from "./database.ts";
import type { WorkerCertificateRecord, WorkerIdentityError } from "./workerIdentity.ts";
import { makePostgresWorkerIdentityRepository } from "./workerIdentityPostgres.ts";

const postgresUrl = process.env.AGENTSIN_TEST_POSTGRES_URL;
const workspaceId = "77777777-7777-4777-8777-777777777777" as WorkspaceId;
const threadId = "route-generation-thread" as ThreadId;
const environmentId = "route-generation-environment" as EnvironmentId;
const revisionId = "route-generation-revision" as EnvironmentRevisionId;
const instant = "2026-08-27T12:00:00.000Z";

const databaseFor = (pool: Pool): DatabaseService => ({
  pool,
  query: <Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: ReadonlyArray<unknown> = [],
  ) =>
    Effect.tryPromise({
      try: async () => (await pool.query<Row>(text, [...values])).rows,
      catch: (cause) => new DatabaseError({ operation: text, cause }),
    }),
  ping: Effect.tryPromise({
    try: async () => void (await pool.query("SELECT 1")),
    catch: (cause) => new DatabaseError({ operation: "ping", cause }),
  }),
});

const certificate = (
  sandboxId: string,
  certificateGeneration: number,
): WorkerCertificateRecord => ({
  workspaceId,
  threadId,
  environmentId,
  environmentRevisionId: revisionId,
  sandboxId: sandboxId as SandboxId,
  reservationId: `reservation-${sandboxId}` as WorkerCertificateRecord["reservationId"],
  workerId: `worker-${sandboxId}` as WorkerCertificateRecord["workerId"],
  providerInstanceId: "codex_personal" as WorkerCertificateRecord["providerInstanceId"],
  providerDriver: "codex" as WorkerCertificateRecord["providerDriver"],
  certificateFingerprint: `${sandboxId}-${certificateGeneration}`,
  certificateGeneration,
  identityBinding: `binding-${sandboxId}`,
  sanUri: `spiffe://agentsin.cloud/workers/${sandboxId}`,
  publicKeySpkiSha256: `spki-${sandboxId}-${certificateGeneration}`,
  notBefore: instant,
  notAfter: "2026-08-27T14:00:00.000Z",
});

const postgresFixture = (url: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const schema = `agentsin_b5_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
      const admin = new Pool({ connectionString: url, max: 1 });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const pool = new Pool({
        connectionString: url,
        max: 8,
        options: `-c search_path=${schema}`,
        connectionTimeoutMillis: 5_000,
        query_timeout: 10_000,
        statement_timeout: 10_000,
      });
      const migrations = await Promise.all(
        [
          "0001-workspaces.sql",
          "0002-cloud-thread-store.sql",
          "0005-worker-mtls.sql",
          "0008-thread-route-generation.sql",
        ].map((filename) =>
          NodeFSP.readFile(new URL(`./migrations/${filename}`, import.meta.url), "utf8"),
        ),
      );
      await pool.query('CREATE TABLE "user" (id text PRIMARY KEY)');
      for (const migration of migrations) await pool.query(migration);
      await pool.query('INSERT INTO "user" (id) VALUES ($1)', ["route-generation-user"]);
      await pool.query("INSERT INTO workspace (id, owner_user_id, name) VALUES ($1, $2, $3)", [
        workspaceId,
        "route-generation-user",
        "Route generation workspace",
      ]);
      await pool.query(
        `INSERT INTO cloud_thread (workspace_id, thread_id, environment_id)
         VALUES ($1, $2, $3)`,
        [workspaceId, threadId, environmentId],
      );
      return { admin, pool, schema };
    }),
    ({ admin, pool, schema }) =>
      Effect.promise(async () => {
        await pool.end().catch(() => undefined);
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
        await admin.end().catch(() => undefined);
      }),
  );

const withPostgres = (use: (pool: Pool) => Effect.Effect<void, WorkerIdentityError>) =>
  Effect.scoped(Effect.flatMap(postgresFixture(postgresUrl!), ({ pool }) => use(pool)));

describe.skipIf(postgresUrl === undefined)("PostgreSQL thread route generation", () => {
  it.effect(
    "allocates one monotonic route generation across replacement sandboxes transactionally",
    () =>
      withPostgres((pool) =>
        Effect.gen(function* () {
          const repository = makePostgresWorkerIdentityRepository(databaseFor(pool));
          const firstCertificate = certificate("sandbox-a", 1);
          const replacementCertificate = certificate("sandbox-b", 1);
          yield* repository.insertCertificate(firstCertificate);
          yield* repository.insertCertificate(replacementCertificate);

          const initial = yield* Effect.all(
            [
              repository.activateLease(firstCertificate, "replica-a", instant),
              repository.activateLease(replacementCertificate, "replica-b", instant),
            ],
            { concurrency: "unbounded" },
          );
          expect(initial.map((lease) => lease.routeGeneration).sort((a, b) => a - b)).toEqual([
            1, 2,
          ]);
          expect(initial.map((lease) => lease.leaseGeneration)).toEqual([1, 1]);

          const rotatedCertificate = certificate("sandbox-a", 2);
          yield* repository.insertCertificate(rotatedCertificate);
          const rotated = yield* repository.activateLease(
            rotatedCertificate,
            "replica-a2",
            instant,
          );
          expect(rotated.routeGeneration).toBe(3);
          expect(rotated.leaseGeneration).toBe(2);
          expect(yield* repository.validateActiveLease(rotated)).toMatchObject({
            certificateFingerprint: rotated.certificateFingerprint,
            certificateGeneration: rotated.certificateGeneration,
            leaseGeneration: rotated.leaseGeneration,
            routeGeneration: rotated.routeGeneration,
            state: "connected",
          });
          yield* repository.fenceSandbox(
            rotated.workspaceId,
            rotated.sandboxId,
            "replacement",
            instant,
          );
          expect((yield* repository.validateActiveLease(rotated).pipe(Effect.exit))._tag).toBe(
            "Failure",
          );

          const stale = yield* Effect.exit(
            repository.activateLease(firstCertificate, "replica-stale", instant),
          );
          expect(stale._tag).toBe("Failure");

          const nextCertificate = certificate("sandbox-c", 1);
          yield* repository.insertCertificate(nextCertificate);
          const next = yield* repository.activateLease(nextCertificate, "replica-c", instant);
          expect(next.routeGeneration).toBe(4);
        }),
      ),
  );
});
