// @effect-diagnostics nodeBuiltinImport:off -- Real PostgreSQL coverage owns an isolated schema.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import type {
  AuthSessionId,
  EnvironmentId,
  ProviderInstanceRef,
  ThreadId,
} from "@t3tools/contracts";
import type {
  AgentMaterializationId,
  AgentProfileId,
  SandboxId,
  WorkspaceId,
} from "@t3tools/contracts/cloud";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { Pool } from "pg";

import type { ProviderCredentialProfileRecord } from "./providerCredentialStore.ts";
import {
  makePostgresProviderCredentialStore,
  ProviderCredentialStoreError,
} from "./providerCredentialStore.ts";
import { purgeTerminalProviderLogins } from "./providerCredentialProduction.ts";
import { makeProviderLoginCoordinator } from "./providerCredentialProduction.ts";
import type { ProviderCredentialServiceError } from "./providerCredentialService.ts";
import type { AuthorizedProviderCredentialTarget } from "./providerCredentialService.ts";
import type { ProviderCredentialKeyEncryption } from "./providerCredentialEnvelope.ts";
import type {
  ProviderCredentialLoginRunResult,
  ProviderCredentialLoginRunner,
} from "./providerCredentialLoginRunner.ts";
import { ProviderCredentialLoginRunnerError } from "./providerCredentialLoginRunner.ts";
import { Secret } from "./providerSecrets.ts";
import type { WorkerInstanceId } from "@t3tools/contracts/worker";

const postgresUrl = process.env.AGENTSIN_TEST_POSTGRES_URL;
const workspaceA = "11111111-1111-4111-8111-111111111111" as WorkspaceId;
const workspaceB = "22222222-2222-4222-8222-222222222222" as WorkspaceId;
const provider = { instanceId: "codex_work", driver: "codex" } as ProviderInstanceRef;
const now = "2026-08-27T12:00:00.000Z";

const keyEncryption = (): ProviderCredentialKeyEncryption => ({
  kmsKeyId: "kms/provider-credentials",
  activeKeyVersion: "kms-v1",
  wrap: (dek) =>
    Effect.sync(() => ({
      keyVersion: "kms-v1",
      wrappedKey: dek.withValue((bytes) =>
        Uint8Array.from(bytes, (byte, index) => byte ^ (0xa5 + index)),
      ),
    })),
  unwrap: (wrapped) =>
    Effect.succeed(
      Secret.make(Uint8Array.from(wrapped.wrappedKey, (byte, index) => byte ^ (0xa5 + index))),
    ),
});

const target = {
  workspaceId: workspaceA,
  threadId: "thread-a" as ThreadId,
  environmentId: "environment-a" as EnvironmentId,
  sandboxId: "sandbox-a" as SandboxId,
  workerId: "worker-a" as WorkerInstanceId,
  provider,
  active: true as const,
  authorizationExpiresAt: "2026-08-27T12:02:00.000Z",
  identity: {
    workspaceId: workspaceA,
    threadId: "thread-a" as ThreadId,
    environmentId: "environment-a" as EnvironmentId,
    environmentRevisionId: "revision-a",
    sandboxId: "sandbox-a" as SandboxId,
    reservationId: "reservation-a",
    workerId: "worker-a" as WorkerInstanceId,
    providerInstanceId: provider.instanceId,
    providerDriver: provider.driver,
    certificateFingerprint: "fingerprint-a",
    certificateGeneration: 1,
    leaseGeneration: 1,
    routeGeneration: 1,
    processInstanceId: "process-a",
    state: "connected" as const,
    connectedAt: now,
    lastSeenAt: now,
    heartbeatSequence: 1,
    confirmedEventCursor: 0,
  },
} as AuthorizedProviderCredentialTarget;

const authorizer = {
  authorize: () => Effect.succeed(target),
  resolveSystem: () => Effect.succeed(target),
};

const observeQueries = (
  pool: Pool,
  observe: (queryText: string, rowCount: number | null) => void,
): Pool =>
  new Proxy(pool, {
    get: (targetPool, property) => {
      if (property === "query") {
        return (async (queryText: string, values?: Array<unknown>) => {
          const result = await targetPool.query(queryText, values);
          observe(queryText, result.rowCount);
          return result;
        }) as Pool["query"];
      }
      const value: unknown = Reflect.get(targetPool, property, targetPool);
      return typeof value === "function" ? value.bind(targetPool) : value;
    },
  });

const fixture = (url: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const schema = `agentsin_d1_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
      const admin = new Pool({ connectionString: url, max: 1 });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const pool = new Pool({
        connectionString: url,
        max: 6,
        options: `-c search_path=${schema}`,
        connectionTimeoutMillis: 5_000,
        query_timeout: 10_000,
        statement_timeout: 10_000,
      });
      await pool.query('CREATE TABLE "user" (id text PRIMARY KEY)');
      await pool.query('INSERT INTO "user" (id) VALUES ($1), ($2)', ["user-a", "user-b"]);
      for (const filename of [
        "0001-workspaces.sql",
        "0002-cloud-thread-store.sql",
        "0007-provider-credential-profiles.sql",
      ]) {
        await pool.query(
          await NodeFSP.readFile(new URL(`./migrations/${filename}`, import.meta.url), "utf8"),
        );
      }
      await pool.query(
        "INSERT INTO workspace (id, owner_user_id, name) VALUES ($1,$2,$3),($4,$5,$6)",
        [workspaceA, "user-a", "A", workspaceB, "user-b", "B"],
      );
      await pool.query(
        "INSERT INTO cloud_thread (workspace_id, thread_id, environment_id) VALUES ($1,$2,$3),($4,$5,$6)",
        [workspaceA, "thread-a", "environment-a", workspaceB, "thread-b", "environment-b"],
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

const withPostgres = (
  use: (
    pool: Pool,
  ) => Effect.Effect<void, ProviderCredentialStoreError | ProviderCredentialServiceError, never>,
) => {
  if (postgresUrl === undefined) return Effect.void;
  return Effect.scoped(Effect.flatMap(fixture(postgresUrl), ({ pool }) => use(pool)));
};

const profile = (
  workspaceId: WorkspaceId,
  profileId: string,
  idempotencyKey = "seal-once",
  requestFingerprint = "a".repeat(64),
): ProviderCredentialProfileRecord => ({
  workspaceId,
  profileId: profileId as AgentProfileId,
  provider,
  label: "Work account",
  state: "active",
  generation: 1,
  envelope: {
    envelopeVersion: 1,
    keyVersion: "kms-v1",
    wrappedKey: NodeCrypto.randomBytes(48),
    nonce: NodeCrypto.randomBytes(12),
    authTag: NodeCrypto.randomBytes(16),
    ciphertext: Buffer.from("encrypted-not-plaintext"),
  },
  idempotencyKey,
  requestFingerprint,
  createdAt: now,
  updatedAt: now,
});

it.effect("tenant-scopes profiles and preserves seal idempotency in PostgreSQL", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const store = makePostgresProviderCredentialStore(pool);
      const a = yield* store.sealProfile(profile(workspaceA, "profile-a"));
      const duplicate = yield* store.sealProfile(profile(workspaceA, "profile-new-random"));
      const b = yield* store.sealProfile(profile(workspaceB, "profile-a"));
      expect(duplicate.profileId).toBe(a.profileId);
      expect(b.workspaceId).toBe(workspaceB);
      expect((yield* store.getProfile(workspaceB, a.profileId))?.workspaceId).toBe(workspaceB);
      expect((yield* store.getProfile(workspaceA, a.profileId))?.workspaceId).toBe(workspaceA);
      const conflict = yield* Effect.result(
        store.sealProfile(profile(workspaceA, "profile-conflict", "seal-once", "c".repeat(64))),
      );
      expect(Result.isFailure(conflict)).toBe(true);
      if (Result.isFailure(conflict)) expect(conflict.failure.code).toBe("idempotencyConflict");
    }),
  ),
);

it.effect("stores no provider plaintext in any profile column", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const store = makePostgresProviderCredentialStore(pool);
      const record = profile(workspaceA, "profile-plaintext-check");
      yield* store.sealProfile(record);
      const rows = yield* Effect.promise(() =>
        pool.query<{ readonly row_text: string }>(
          "SELECT row_to_json(p)::text AS row_text FROM provider_credential_profile p WHERE workspace_id = $1 AND profile_id = $2",
          [workspaceA, record.profileId],
        ),
      );
      expect(rows.rows[0]?.row_text).not.toContain("provider-secret-value");
      expect(rows.rows[0]?.row_text).not.toContain("accessToken");
    }),
  ),
);

it.effect(
  "seals an authorized runner result locally and reloads it after coordinator restart",
  () =>
    withPostgres((pool) =>
      Effect.gen(function* () {
        let resolveStored: (() => void) | undefined;
        const stored = new Promise<void>((resolve) => {
          resolveStored = resolve;
        });
        const observedPool = observeQueries(pool, (queryText, rowCount) => {
          if (queryText.includes("WITH candidate AS MATERIALIZED") && rowCount === 1)
            resolveStored?.();
        });
        const plaintext = Buffer.from("provider-login-plaintext-never-stored");
        const runner: ProviderCredentialLoginRunner = {
          validateConfiguration: Effect.void,
          loginMethod: () => "deviceCode",
          run: (input) =>
            input
              .onEvent({
                sequence: 0,
                occurredAt: now,
                type: "authorizationUrl",
                authorizationUrl: "https://auth.example.test/device",
              })
              .pipe(
                Effect.andThen(
                  Effect.succeed({
                    outcome: "authorized" as const,
                    credential: Secret.make<Uint8Array>(plaintext),
                    occurredAt: now,
                  }),
                ),
              ),
          cancel: () => Effect.void,
          shutdown: Effect.void,
        };
        const coordinator = makeProviderLoginCoordinator({
          pool: observedPool,
          targets: authorizer,
          runner,
          now: Effect.succeed(now),
          keyEncryption: keyEncryption(),
        });
        const login = yield* coordinator.begin({
          principal: {
            workspaceId: workspaceA,
            authSessionId: "session-a" as AuthSessionId,
            userId: "user-a",
          },
          threadId: "thread-a" as ThreadId,
          providerInstanceId: provider.instanceId,
        });
        yield* Effect.promise(() => stored);
        expect(plaintext.every((byte) => byte === 0)).toBe(true);
        const row = yield* Effect.promise(() =>
          pool.query<{ readonly row_text: string; readonly state: string }>(
            `SELECT row_to_json(s)::text AS row_text, state
             FROM provider_credential_login_session s
            WHERE workspace_id = $1 AND login_id = $2`,
            [workspaceA, login.loginId],
          ),
        );
        expect(row.rows[0]?.state).toBe("authorized");
        expect(row.rows[0]?.row_text).not.toContain("provider-login-plaintext-never-stored");

        const restarted = makeProviderLoginCoordinator({
          pool,
          targets: authorizer,
          runner: { ...runner, run: () => Effect.die("restart must not rerun login") },
          now: Effect.succeed(now),
          keyEncryption: keyEncryption(),
        });
        const recovered = yield* restarted.consumeCredential(workspaceA, login.loginId);
        expect(recovered.profileId).toBe(login.profileId);
        expect(recovered.envelope.ciphertext.byteLength).toBeGreaterThan(0);
      }),
    ),
);

it.effect("atomically expires a provider result completed at its PostgreSQL deadline", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      let resolveCompleted: (() => void) | undefined;
      const completed = new Promise<void>((resolve) => {
        resolveCompleted = resolve;
      });
      const observedPool = observeQueries(pool, (queryText, rowCount) => {
        if (queryText.includes("WITH candidate AS MATERIALIZED") && rowCount === 1)
          resolveCompleted?.();
      });
      const plaintext = Buffer.from("provider-login-completed-at-expiry");
      const runner: ProviderCredentialLoginRunner = {
        validateConfiguration: Effect.void,
        loginMethod: () => "deviceCode",
        run: () =>
          Effect.succeed({
            outcome: "authorized" as const,
            credential: Secret.make<Uint8Array>(plaintext),
            occurredAt: "2026-08-27T12:15:00.000Z",
          }),
        cancel: () => Effect.void,
        shutdown: Effect.void,
      };
      const coordinator = makeProviderLoginCoordinator({
        pool: observedPool,
        targets: authorizer,
        runner,
        now: Effect.succeed(now),
        keyEncryption: keyEncryption(),
      });
      const login = yield* coordinator.begin({
        principal: {
          workspaceId: workspaceA,
          authSessionId: "session-a" as AuthSessionId,
          userId: "user-a",
        },
        threadId: "thread-a" as ThreadId,
        providerInstanceId: provider.instanceId,
      });
      yield* Effect.promise(() => completed);

      expect(plaintext.every((byte) => byte === 0)).toBe(true);
      const row = yield* Effect.promise(() =>
        pool.query<{
          readonly state: string;
          readonly key_version: string | null;
          readonly wrapped_dek: Buffer | null;
          readonly ciphertext: Buffer | null;
        }>(
          `SELECT state, key_version, wrapped_dek, ciphertext
             FROM provider_credential_login_session
            WHERE workspace_id = $1 AND login_id = $2`,
          [workspaceA, login.loginId],
        ),
      );
      expect(row.rows[0]).toEqual({
        state: "expired",
        key_version: null,
        wrapped_dek: null,
        ciphertext: null,
      });
    }),
  ),
);

it.effect("fences a late authorized result after cancellation and wipes its plaintext", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const completion = yield* Deferred.make<ProviderCredentialLoginRunResult>();
      let resolveAttemptedCas: (() => void) | undefined;
      const attemptedCas = new Promise<void>((resolve) => {
        resolveAttemptedCas = resolve;
      });
      const observedPool = observeQueries(pool, (queryText) => {
        if (queryText.includes("WITH candidate AS MATERIALIZED")) resolveAttemptedCas?.();
      });
      const runner: ProviderCredentialLoginRunner = {
        validateConfiguration: Effect.void,
        loginMethod: () => "deviceCode",
        run: () => Deferred.await(completion),
        cancel: () => Effect.void,
        shutdown: Effect.void,
      };
      const coordinator = makeProviderLoginCoordinator({
        pool: observedPool,
        targets: authorizer,
        runner,
        now: Effect.succeed(now),
        keyEncryption: keyEncryption(),
      });
      const principal = {
        workspaceId: workspaceA,
        authSessionId: "session-a" as AuthSessionId,
        userId: "user-a",
      };
      const login = yield* coordinator.begin({
        principal,
        threadId: "thread-a" as ThreadId,
        providerInstanceId: provider.instanceId,
      });
      const cancelled = yield* coordinator.cancel(principal, login.loginId);
      expect(cancelled.status).toBe("failed");
      const latePlaintext = Buffer.from("late-provider-login-plaintext");
      yield* Deferred.succeed(completion, {
        outcome: "authorized",
        credential: Secret.make<Uint8Array>(latePlaintext),
        occurredAt: now,
      });
      yield* Effect.promise(() => attemptedCas);
      expect(latePlaintext.every((byte) => byte === 0)).toBe(true);
      const row = yield* Effect.promise(() =>
        pool.query<{
          readonly state: string;
          readonly ciphertext: Buffer | null;
        }>(
          `SELECT state, ciphertext FROM provider_credential_login_session
            WHERE workspace_id = $1 AND login_id = $2`,
          [workspaceA, login.loginId],
        ),
      );
      expect(row.rows[0]).toEqual({ state: "cancelled", ciphertext: null });
    }),
  ),
);

it.effect("fences expired logins before runner cleanup and durably retries cleanup failures", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      let failCleanup = true;
      let cancellationAttempts = 0;
      const runner: ProviderCredentialLoginRunner = {
        validateConfiguration: Effect.void,
        loginMethod: () => "deviceCode",
        run: () => Effect.die("expired login must not restart"),
        cancel: () => {
          cancellationAttempts += 1;
          return failCleanup
            ? Effect.fail(
                new ProviderCredentialLoginRunnerError({
                  code: "terminationFailed",
                  operation: "test-expiry-cleanup",
                }),
              )
            : Effect.void;
        },
        shutdown: Effect.void,
      };
      yield* Effect.promise(() =>
        pool.query(
          `INSERT INTO provider_credential_login_session (
             workspace_id, login_id, profile_id, thread_id, environment_id, sandbox_id,
             worker_id, provider_instance_id, provider_driver, state, events,
             cleanup_state, expires_at, created_at, updated_at
           ) VALUES ($1,'expired-login','expired-profile','thread-a','environment-a','sandbox-a',
                     'worker-a',$2,$3,'running','[]'::jsonb,'pending',
                     '2026-08-27T11:00:00.000Z','2026-08-27T10:00:00.000Z',
                     '2026-08-27T10:00:00.000Z')`,
          [workspaceA, provider.instanceId, provider.driver],
        ),
      );
      const coordinator = makeProviderLoginCoordinator({
        pool,
        targets: authorizer,
        runner,
        now: Effect.succeed(now),
        keyEncryption: keyEncryption(),
      });

      expect((yield* coordinator.sweepExpired.pipe(Effect.exit))._tag).toBe("Failure");
      const retry = yield* Effect.promise(() =>
        pool.query<{ readonly state: string; readonly cleanup_state: string }>(
          `SELECT state, cleanup_state FROM provider_credential_login_session
            WHERE workspace_id = $1 AND login_id = 'expired-login'`,
          [workspaceA],
        ),
      );
      expect(retry.rows[0]).toEqual({ state: "expired", cleanup_state: "retry_required" });

      failCleanup = false;
      expect(yield* coordinator.sweepExpired).toBe(1);
      const cleaned = yield* Effect.promise(() =>
        pool.query<{ readonly state: string; readonly cleanup_state: string }>(
          `SELECT state, cleanup_state FROM provider_credential_login_session
            WHERE workspace_id = $1 AND login_id = 'expired-login'`,
          [workspaceA],
        ),
      );
      expect(cleaned.rows[0]).toEqual({ state: "expired", cleanup_state: "confirmed" });
      expect(cancellationAttempts).toBe(2);
    }),
  ),
);

it.effect(
  "serializes login admission quotas and never starts a runner after a database failure",
  () =>
    withPostgres((pool) =>
      Effect.gen(function* () {
        let starts = 0;
        const runner: ProviderCredentialLoginRunner = {
          validateConfiguration: Effect.void,
          loginMethod: () => "deviceCode",
          run: () => {
            starts += 1;
            return Effect.never;
          },
          cancel: () => Effect.void,
          shutdown: Effect.void,
        };
        const coordinator = makeProviderLoginCoordinator({
          pool,
          targets: authorizer,
          runner,
          now: Effect.succeed(now),
          keyEncryption: keyEncryption(),
        });
        const attempts = yield* Effect.forEach(
          Array.from({ length: 9 }),
          () =>
            coordinator
              .begin({
                principal: {
                  workspaceId: workspaceA,
                  authSessionId: "session-a" as AuthSessionId,
                  userId: "user-a",
                },
                threadId: "thread-a" as ThreadId,
                providerInstanceId: provider.instanceId,
              })
              .pipe(Effect.result),
          { concurrency: "unbounded" },
        );
        expect(attempts.filter(Result.isSuccess)).toHaveLength(8);
        expect(attempts.filter(Result.isFailure)).toHaveLength(1);
        expect(starts).toBe(8);
        const active = yield* Effect.promise(() =>
          pool.query<{ readonly count: string }>(
            "SELECT count(*)::text AS count FROM provider_credential_login_session WHERE workspace_id = $1 AND state = 'running'",
            [workspaceA],
          ),
        );
        expect(active.rows[0]?.count).toBe("8");

        const failedPool = new Proxy(pool, {
          get: (targetPool, property) =>
            property === "connect"
              ? async () => Promise.reject(new Error("database unavailable"))
              : Reflect.get(targetPool, property, targetPool),
        });
        const failedCoordinator = makeProviderLoginCoordinator({
          pool: failedPool,
          targets: authorizer,
          runner,
          now: Effect.succeed(now),
          keyEncryption: keyEncryption(),
        });
        expect(
          (yield* failedCoordinator
            .begin({
              principal: {
                workspaceId: workspaceB,
                authSessionId: "session-b" as AuthSessionId,
                userId: "user-b",
              },
              threadId: "thread-b" as ThreadId,
              providerInstanceId: provider.instanceId,
            })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect(starts).toBe(8);
      }),
    ),
);

it.effect("purges only confirmed terminal logins after 30 days and retains audit aggregates", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const store = makePostgresProviderCredentialStore(pool);
      const currentProfile = profile(workspaceA, "profile-retention-current", "retention-profile");
      yield* store.sealProfile(currentProfile);
      const rows = [
        ["old-authorized", "authorized", "confirmed", "2026-07-01T00:00:00.000Z"],
        ["old-retry", "failed", "retry_required", "2026-07-01T00:00:00.000Z"],
        ["old-running", "running", "pending", "2026-07-01T00:00:00.000Z"],
        ["recent-denied", "denied", "confirmed", "2026-08-20T00:00:00.000Z"],
      ] as const;
      for (const [loginIdValue, state, cleanupState, timestamp] of rows) {
        yield* Effect.promise(() =>
          pool.query(
            `INSERT INTO provider_credential_login_session (
               workspace_id, login_id, profile_id, thread_id, environment_id, sandbox_id,
               worker_id, provider_instance_id, provider_driver, state, events,
               cleanup_state, key_version, wrapped_dek, nonce, auth_tag, ciphertext,
               expires_at, created_at, updated_at
             ) VALUES ($1,$2,$3,'thread-a','environment-a','sandbox-a','worker-a',$4,$5,$6,
                       '[]'::jsonb,$7,$9,$10,$11,$12,$13,
                       $8::timestamptz,$8::timestamptz,$8::timestamptz)`,
            [
              workspaceA,
              loginIdValue,
              `${loginIdValue}-profile`,
              provider.instanceId,
              provider.driver,
              state,
              cleanupState,
              timestamp,
              state === "authorized" ? "test-v1" : null,
              state === "authorized" ? Buffer.alloc(32, 1) : null,
              state === "authorized" ? Buffer.alloc(12, 2) : null,
              state === "authorized" ? Buffer.alloc(16, 3) : null,
              state === "authorized" ? Buffer.from("encrypted") : null,
            ],
          ),
        );
      }

      expect(yield* purgeTerminalProviderLogins(pool, "2026-08-27T12:00:00.000Z")).toBe(1);
      const remaining = yield* Effect.promise(() =>
        pool.query<{ readonly login_id: string }>(
          "SELECT login_id FROM provider_credential_login_session ORDER BY login_id",
        ),
      );
      expect(remaining.rows.map((row) => row.login_id)).toEqual([
        "old-retry",
        "old-running",
        "recent-denied",
      ]);
      const audit = yield* Effect.promise(() =>
        pool.query<{ readonly terminal_state: string; readonly attempt_count: string }>(
          "SELECT terminal_state, attempt_count::text FROM provider_credential_login_audit_daily",
        ),
      );
      expect(audit.rows).toEqual([{ terminal_state: "authorized", attempt_count: "1" }]);
      expect(yield* store.getProfile(workspaceA, currentProfile.profileId)).toBeDefined();
    }),
  ),
);

it.effect("refuses a materialization reservation after the profile is revoked", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const store = makePostgresProviderCredentialStore(pool);
      const record = profile(workspaceA, "profile-revoked-before-materialization");
      yield* store.sealProfile(record);
      yield* store.revokeProfile(workspaceA, record.profileId, now);
      const reserved = yield* Effect.result(
        store.reserveMaterialization({
          workspaceId: workspaceA,
          materializationId: "materialization-revoked" as AgentMaterializationId,
          profileId: record.profileId,
          providerInstanceId: provider.instanceId,
          providerDriver: provider.driver,
          threadId: "thread-a" as ThreadId,
          environmentId: "environment-a" as EnvironmentId,
          sandboxId: "sandbox-a" as SandboxId,
          workerId: "worker-a" as import("@t3tools/contracts/worker").WorkerInstanceId,
          targetPath: ".config/provider/auth.json",
          targetPathSha256: "c".repeat(64),
          authorizationSessionId: "session-a" as AuthSessionId,
          authorizationExpiresAt: "2026-08-27T12:05:00.000Z",
          createdAt: now,
        }),
      );
      expect(Result.isFailure(reserved)).toBe(true);
      if (Result.isFailure(reserved)) expect(reserved.failure.code).toBe("stateConflict");
    }),
  ),
);

it.effect("transactionally fences a late materialization confirmation after revoke", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const store = makePostgresProviderCredentialStore(pool);
      const record = profile(workspaceA, "profile-generation-race", "race-seal");
      yield* store.sealProfile(record);
      const materializationId = "materialization-generation-race" as AgentMaterializationId;
      const reserved = yield* store.reserveMaterialization({
        workspaceId: workspaceA,
        materializationId,
        profileId: record.profileId,
        providerInstanceId: provider.instanceId,
        providerDriver: provider.driver,
        threadId: "thread-a" as ThreadId,
        environmentId: "environment-a" as EnvironmentId,
        sandboxId: "sandbox-a" as SandboxId,
        workerId: "worker-a" as import("@t3tools/contracts/worker").WorkerInstanceId,
        targetPath: "provider/codex/profile-generation-race",
        targetPathSha256: "d".repeat(64),
        authorizationSessionId: "session-a" as AuthSessionId,
        authorizationExpiresAt: "2026-08-27T12:05:00.000Z",
        createdAt: now,
      });
      yield* store.markDispatched(workspaceA, materializationId, reserved.profileGeneration, now);
      const revoked = yield* store.revokeProfile(workspaceA, record.profileId, now);
      expect(revoked.generation).toBe(2);
      expect(
        yield* store.confirmMaterialized(
          workspaceA,
          materializationId,
          reserved.profileGeneration,
          now,
        ),
      ).toBe(false);
      expect(
        (yield* store.listLiveMaterializations(workspaceA, {
          profileId: record.profileId,
        }))[0]?.state,
      ).toBe("cleanup_required");
      expect(
        yield* store.confirmAbsent(
          workspaceA,
          materializationId,
          reserved.profileGeneration,
          now,
          "revoked",
        ),
      ).toBe(true);
      expect(
        yield* store.listLiveMaterializations(workspaceA, {
          profileId: record.profileId,
        }),
      ).toEqual([]);
    }),
  ),
);

it.effect("transactionally fences lifecycle materializations with tenant and sandbox scope", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const store = makePostgresProviderCredentialStore(pool);
      const record = profile(workspaceA, "profile-lifecycle-fence", "lifecycle-fence");
      yield* store.sealProfile(record);
      const materializationId = "materialization-lifecycle-fence" as AgentMaterializationId;
      const reserved = yield* store.reserveMaterialization({
        workspaceId: workspaceA,
        materializationId,
        profileId: record.profileId,
        providerInstanceId: provider.instanceId,
        providerDriver: provider.driver,
        threadId: "thread-a" as ThreadId,
        environmentId: "environment-a" as EnvironmentId,
        sandboxId: "sandbox-a" as SandboxId,
        workerId: "worker-a" as WorkerInstanceId,
        targetPath: "provider/codex/profile-lifecycle-fence",
        targetPathSha256: "e".repeat(64),
        authorizationSessionId: "session-a" as AuthSessionId,
        authorizationExpiresAt: "2026-08-27T12:05:00.000Z",
        createdAt: now,
      });
      yield* store.markDispatched(workspaceA, materializationId, reserved.profileGeneration, now);
      expect(
        yield* store.confirmMaterialized(
          workspaceA,
          materializationId,
          reserved.profileGeneration,
          now,
        ),
      ).toBe(true);

      expect(
        yield* store.fenceLifecycleMaterializations(
          workspaceB,
          "thread-b" as ThreadId,
          undefined,
          "paused",
          now,
        ),
      ).toEqual([]);
      const fenced = yield* store.fenceLifecycleMaterializations(
        workspaceA,
        "thread-a" as ThreadId,
        "sandbox-a" as SandboxId,
        "destroyed",
        now,
      );
      expect(fenced).toHaveLength(1);
      expect(fenced[0]).toMatchObject({
        materializationId,
        state: "cleanup_required",
        cleanupReason: "destroyed",
      });
    }),
  ),
);
