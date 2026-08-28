// @effect-diagnostics nodeBuiltinImport:off -- PostgreSQL tests own an isolated random schema.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeUtil from "node:util";

import type { AuthSessionId } from "@t3tools/contracts";
import type {
  EvmAddress,
  EvmTransactionHash,
  MicroUsdc,
  WorkspaceId,
} from "@t3tools/contracts/cloud";
import {
  MONAD_USDC_BINDING,
  type WalletDelegatedAuthorization,
  type WalletDelegatedChargeRequest,
  type WalletId,
  type WalletProvisionRequest,
  type WalletRecoveryBeginRequest,
  type WalletRecoveryCompleteRequest,
  type WalletWithdrawalRequest,
} from "@t3tools/contracts/wallet";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { Pool } from "pg";

import {
  makeFakeWalletCustodyAdapter,
  type WalletCustodyAdapter,
  WalletCustodyError,
} from "./walletCustodyAdapter.ts";
import {
  makePostgresWalletRepository,
  type WalletRepository,
  WalletRepositoryError,
} from "./walletRepository.ts";
import {
  makeWalletService,
  WalletServiceError,
  type WalletPrincipal,
  type WalletSettlementPrincipal,
  walletRequestFingerprint,
} from "./walletService.ts";
import { Secret } from "./providerSecrets.ts";

const postgresUrl = process.env.AGENTSIN_TEST_POSTGRES_URL;
const workspaceA = "11111111-1111-4111-8111-111111111111" as WorkspaceId;
const workspaceB = "22222222-2222-4222-8222-222222222222" as WorkspaceId;
const authSessionA = "session-a" as AuthSessionId;
const now = "2026-08-28T00:00:00.000Z";
const treasury = "0x1111111111111111111111111111111111111111" as EvmAddress;
const destination = "0x3333333333333333333333333333333333333333" as EvmAddress;
const walletId = "wallet-a" as WalletId;

const principalA: WalletPrincipal = {
  workspaceId: workspaceA,
  userId: "user-a",
  authSessionId: authSessionA,
};
const settlementA: WalletSettlementPrincipal = {
  service: "billing-settlement",
  workspaceId: workspaceA,
};

const fixture = (url: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const schema = `agentsin_h1_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
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
      await pool.query('CREATE TABLE "user" (id text PRIMARY KEY)');
      await pool.query('INSERT INTO "user" (id) VALUES ($1), ($2)', ["user-a", "user-b"]);
      for (const filename of ["0001-workspaces.sql", "0012-user-wallets.sql"]) {
        await pool.query(
          await NodeFSP.readFile(new URL(`./migrations/${filename}`, import.meta.url), "utf8"),
        );
      }
      await pool.query(
        "INSERT INTO workspace (id, owner_user_id, name) VALUES ($1,$2,$3),($4,$5,$6)",
        [workspaceA, "user-a", "A", workspaceB, "user-b", "B"],
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
  use: (pool: Pool) => Effect.Effect<void, WalletServiceError | WalletRepositoryError>,
) => {
  if (postgresUrl === undefined) return Effect.void;
  return Effect.scoped(Effect.flatMap(fixture(postgresUrl), ({ pool }) => use(pool)));
};

const auditIds = () => {
  let sequence = 0;
  return () => {
    sequence += 1;
    return `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
  };
};

const serviceFixture = (
  pool: Pool,
  customizeCustody?: (base: WalletCustodyAdapter) => WalletCustodyAdapter,
  walletIdForOperation: (operationId: WalletProvisionRequest["operationId"]) => WalletId = () =>
    walletId,
  customizeRepository?: (base: WalletRepository) => WalletRepository,
) => {
  const custody = makeFakeWalletCustodyAdapter();
  const activeCustody = customizeCustody?.(custody) ?? custody;
  const repository = makePostgresWalletRepository(pool);
  const activeRepository = customizeRepository?.(repository) ?? repository;
  const service = makeWalletService({
    repository: activeRepository,
    custody: activeCustody,
    now: () => now,
    nextAuditEventId: auditIds(),
    walletIdForOperation,
    authorizeSettlement: (principal, target) =>
      principal.service === "billing-settlement" && principal.workspaceId === target.workspaceId
        ? Effect.void
        : Effect.fail(
            new WalletServiceError({
              code: "forbidden",
              operation: "authorize-settlement",
              retryable: false,
            }),
          ),
  });
  return { custody, repository, service };
};

const provisioningMaterial = () => ({
  recoveryEmail: Secret.make("wallet-owner@example.test"),
  passkeyRegistration: Secret.make<Uint8Array>(new Uint8Array([1, 2, 3])),
  stamp: Secret.make<Uint8Array>(new Uint8Array([4, 5, 6])),
});

const provisionRequest = (suffix = "a"): WalletProvisionRequest => {
  const input = {
    schemaVersion: 1 as const,
    operationId: `provision-${suffix}` as WalletProvisionRequest["operationId"],
    idempotencyKey: `provision-${suffix}-once` as WalletProvisionRequest["idempotencyKey"],
    workspaceId: workspaceA,
    ownerUserId: "user-a",
    requestedAt: now,
  };
  return { ...input, requestFingerprint: walletRequestFingerprint(input) };
};

const delegationAuthorization = (suffix = "a"): WalletDelegatedAuthorization => ({
  authorizationId: `authorization-${suffix}` as WalletDelegatedAuthorization["authorizationId"],
  walletId,
  workspaceId: workspaceA,
  binding: MONAD_USDC_BINDING,
  treasuryAddress: treasury,
  perChargeLimitMicroUsdc: 600_000 as MicroUsdc,
  dailyLimitMicroUsdc: 1_000_000 as MicroUsdc,
  startsAt: "2026-08-27T00:00:00.000Z",
  expiresAt: "2026-08-29T00:00:00.000Z",
  policyRevision: suffix.charCodeAt(0),
  state: "pending",
  createdAt: now,
  updatedAt: now,
});

const configureDelegation = (
  service: ReturnType<typeof makeWalletService>,
  operationSuffix = "a",
  authorizationSuffix = operationSuffix,
) => {
  const authorization = delegationAuthorization(authorizationSuffix);
  const input = {
    schemaVersion: 1 as const,
    operationId: `delegation-${operationSuffix}` as WalletProvisionRequest["operationId"],
    idempotencyKey:
      `delegation-${operationSuffix}-once` as WalletProvisionRequest["idempotencyKey"],
    workspaceId: workspaceA,
    walletId,
    authorization: {
      authorizationId: authorization.authorizationId,
      treasuryAddress: authorization.treasuryAddress,
      perChargeLimitMicroUsdc: authorization.perChargeLimitMicroUsdc,
      dailyLimitMicroUsdc: authorization.dailyLimitMicroUsdc,
      startsAt: authorization.startsAt,
      expiresAt: authorization.expiresAt,
      policyRevision: authorization.policyRevision,
    },
    requestedAt: now,
  };
  return service.configureDelegation(
    principalA,
    {
      ...input,
      authorization,
      requestFingerprint: walletRequestFingerprint(input),
    },
    { stamp: Secret.make<Uint8Array>(new Uint8Array([7, 8, 9])) },
  );
};

const chargeRequest = (
  reservationId: string,
  amountMicroUsdc: MicroUsdc,
): WalletDelegatedChargeRequest => {
  const input = {
    schemaVersion: 1 as const,
    reservationId: reservationId as WalletDelegatedChargeRequest["reservationId"],
    idempotencyKey: `${reservationId}-once` as WalletDelegatedChargeRequest["idempotencyKey"],
    workspaceId: workspaceA,
    walletId,
    authorizationId: "authorization-a" as WalletDelegatedChargeRequest["authorizationId"],
    binding: MONAD_USDC_BINDING,
    destination: treasury,
    amountMicroUsdc,
    requestedAt: now,
  };
  return { ...input, requestFingerprint: walletRequestFingerprint(input) };
};

it.effect("provisions once, isolates workspaces, and never persists provisioning secrets", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const { custody, service } = serviceFixture(pool);
      const request = provisionRequest();
      const created = yield* service.provision(principalA, request, provisioningMaterial());
      const duplicate = yield* service.provision(principalA, request, provisioningMaterial());
      expect(created.disposition).toBe("created");
      expect(duplicate.disposition).toBe("duplicate");
      expect(custody.calls.filter((call) => call.operation === "provision")).toHaveLength(1);
      expect((yield* service.directDepositInstructions(principalA, walletId)).binding).toEqual(
        MONAD_USDC_BINDING,
      );

      const foreign = yield* Effect.exit(
        service.getWallet(
          {
            workspaceId: workspaceB,
            userId: "user-b",
            authSessionId: "session-b" as AuthSessionId,
          },
          walletId,
        ),
      );
      expect(Exit.isFailure(foreign)).toBe(true);

      const persistedRows = yield* Effect.promise(() =>
        Promise.all(
          [
            "cloud_wallet",
            "cloud_wallet_provisioning_intent",
            "cloud_wallet_operation",
            "cloud_wallet_delegated_authorization",
            "cloud_wallet_delegation_configuration_intent",
            "cloud_wallet_delegation_revocation",
            "cloud_wallet_recovery_attempt",
            "cloud_wallet_spend_reservation",
            "cloud_wallet_audit_event",
          ].map((table) => pool.query(`SELECT row_to_json(value) AS value FROM ${table} value`)),
        ),
      );
      const persisted = NodeUtil.inspect(
        persistedRows.flatMap((result) => result.rows),
        {
          depth: null,
        },
      );
      expect(persisted).not.toContain("wallet-owner@example.test");
      expect(persisted).not.toContain("opaque-stamp");
      expect(persisted).not.toContain("recovery_bundle");
    }),
  ),
);

it.effect("reserves one owner wallet before Turnkey provisioning under fresh-key races", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const { custody, service } = serviceFixture(
        pool,
        undefined,
        (operationId) => `wallet-${operationId}` as WalletId,
      );
      const results = yield* Effect.all(
        [
          service
            .provision(principalA, provisionRequest("race-a"), provisioningMaterial())
            .pipe(Effect.result),
          service
            .provision(principalA, provisionRequest("race-b"), provisioningMaterial())
            .pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      expect(results.filter(Result.isSuccess).length).toBeGreaterThanOrEqual(1);
      expect(custody.calls.filter((call) => call.operation === "provision")).toHaveLength(1);

      const counts = yield* Effect.promise(() =>
        pool.query<{ wallets: string; intents: string }>(
          `SELECT
             (SELECT count(*) FROM cloud_wallet WHERE workspace_id = $1 AND owner_user_id = $2)::text AS wallets,
             (SELECT count(*) FROM cloud_wallet_provisioning_intent
               WHERE workspace_id = $1 AND owner_user_id = $2 AND state = 'completed')::text AS intents`,
          [workspaceA, "user-a"],
        ),
      );
      expect(counts.rows[0]).toMatchObject({ wallets: "1", intents: "1" });
    }),
  ),
);

it.effect("serializes daily settlement spend and replays a submitted charge exactly once", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const { custody, repository, service } = serviceFixture(pool);
      yield* service.provision(principalA, provisionRequest(), provisioningMaterial());
      yield* configureDelegation(service);

      const firstRequest = chargeRequest("reservation-a", 250_000 as MicroUsdc);
      const first = yield* service.charge(settlementA, firstRequest);
      const duplicate = yield* service.charge(settlementA, firstRequest);
      expect(first.disposition).toBe("submitted");
      expect(duplicate.disposition).toBe("duplicate");

      const concurrent = yield* Effect.all(
        [
          service
            .charge(settlementA, chargeRequest("reservation-b", 500_000 as MicroUsdc))
            .pipe(Effect.result),
          service
            .charge(settlementA, chargeRequest("reservation-c", 500_000 as MicroUsdc))
            .pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      expect(concurrent.filter(Result.isSuccess)).toHaveLength(1);
      expect(concurrent.filter(Result.isFailure)).toHaveLength(1);
      expect(custody.calls.filter((call) => call.operation === "charge")).toHaveLength(2);

      const foreign = yield* Effect.exit(
        service.charge(
          { service: "billing-settlement", workspaceId: workspaceB },
          chargeRequest("reservation-foreign", 1 as MicroUsdc),
        ),
      );
      expect(Exit.isFailure(foreign)).toBe(true);
      const audit = yield* repository.listAudit(workspaceA, walletId);
      expect(audit.map((event) => event.eventKind)).toContain("spendSubmitted");
    }),
  ),
);

it.effect("revokes the prior provider delegation before activating its replacement", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const { custody, service } = serviceFixture(pool);
      yield* service.provision(principalA, provisionRequest(), provisioningMaterial());
      yield* configureDelegation(service, "a");
      yield* configureDelegation(service, "b");

      expect(
        custody.calls
          .filter((call) =>
            ["configureDelegatedAuthorization", "revokeDelegatedAuthorization"].includes(
              call.operation,
            ),
          )
          .map((call) => call.operation),
      ).toEqual([
        "configureDelegatedAuthorization",
        "revokeDelegatedAuthorization",
        "configureDelegatedAuthorization",
      ]);
      const rows = yield* Effect.promise(() =>
        pool.query<{ authorization_id: string; state: string }>(
          `SELECT authorization_id, state FROM cloud_wallet_delegated_authorization
           WHERE workspace_id = $1 AND wallet_id = $2 ORDER BY authorization_id`,
          [workspaceA, walletId],
        ),
      );
      expect(rows.rows).toEqual([
        { authorization_id: "authorization-a", state: "revoked" },
        { authorization_id: "authorization-b", state: "active" },
      ]);
      const revocation = yield* Effect.promise(() =>
        pool.query<{ provider_activity_ref: string; provider_status: string }>(
          `SELECT provider_activity_ref, provider_status
           FROM cloud_wallet_delegation_revocation
           WHERE workspace_id = $1 AND wallet_id = $2 AND authorization_id = $3`,
          [workspaceA, walletId, "authorization-a"],
        ),
      );
      expect(revocation.rows[0]).toMatchObject({ provider_status: "applied" });
      expect(revocation.rows[0]?.provider_activity_ref).toBeTruthy();
    }),
  ),
);

it.effect("serializes concurrent fresh delegation keys before either can call Turnkey", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      let externalCalls = 0;
      const entered = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const { service } = serviceFixture(pool, (base) => ({
        ...base,
        configureDelegatedAuthorization: (input) =>
          Effect.sync(() => {
            externalCalls += 1;
          }).pipe(
            Effect.andThen(Deferred.succeed(entered, undefined)),
            Effect.andThen(Deferred.await(released)),
            Effect.andThen(base.configureDelegatedAuthorization(input)),
          ),
      }));
      yield* service.provision(principalA, provisionRequest(), provisioningMaterial());

      const winnerFiber = yield* Effect.forkChild(configureDelegation(service, "race-a", "race"), {
        startImmediately: true,
      });
      yield* Deferred.await(entered);
      const loser = yield* configureDelegation(service, "race-b", "race").pipe(Effect.result);
      expect(Result.isFailure(loser)).toBe(true);
      expect(externalCalls).toBe(1);
      yield* Deferred.succeed(released, undefined);
      const winner = yield* Fiber.join(winnerFiber);
      expect(winner.authorizationId).toBe("authorization-race");

      const replay = yield* configureDelegation(service, "race-b", "race");
      expect(replay.authorizationId).toBe("authorization-race");
      expect(externalCalls).toBe(1);
      const durable = yield* Effect.promise(() =>
        pool.query<{ authorizations: string; intents: string; operations: string }>(
          `SELECT
             (SELECT count(*) FROM cloud_wallet_delegated_authorization
               WHERE workspace_id = $1 AND wallet_id = $2)::text AS authorizations,
             (SELECT count(*) FROM cloud_wallet_delegation_configuration_intent
               WHERE workspace_id = $1 AND wallet_id = $2 AND state = 'completed')::text AS intents,
             (SELECT count(*) FROM cloud_wallet_operation
               WHERE workspace_id = $1 AND wallet_id = $2
                 AND operation_kind = 'delegationConfigure')::text AS operations`,
          [workspaceA, walletId],
        ),
      );
      expect(durable.rows[0]).toEqual({
        authorizations: "1",
        intents: "1",
        operations: "1",
      });
    }),
  ),
);

it.effect("reconciles provider success lost before its database evidence commit", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      let evidenceWrites = 0;
      const { custody, service } = serviceFixture(
        pool,
        undefined,
        () => walletId,
        (repository) => ({
          ...repository,
          recordDelegationConfigurationEvidence: (input) => {
            evidenceWrites += 1;
            return evidenceWrites === 1
              ? Effect.fail(
                  new WalletRepositoryError({
                    code: "databaseFailure",
                    operation: "simulated-crash-before-evidence-commit",
                    retryable: true,
                    cause: "simulated connection loss",
                  }),
                )
              : repository.recordDelegationConfigurationEvidence(input);
          },
        }),
      );
      yield* service.provision(principalA, provisionRequest(), provisioningMaterial());

      const first = yield* Effect.exit(configureDelegation(service, "crash", "crash"));
      expect(Exit.isFailure(first)).toBe(true);
      expect(
        custody.calls.filter((call) => call.operation === "configureDelegatedAuthorization"),
      ).toHaveLength(1);

      const recovered = yield* configureDelegation(service, "crash", "crash");
      expect(recovered.authorizationId).toBe("authorization-crash");
      expect(
        custody.calls.filter((call) => call.operation === "configureDelegatedAuthorization"),
      ).toHaveLength(1);
      expect(
        custody.calls.filter((call) => call.operation === "getDelegatedAuthorizationStatus"),
      ).toHaveLength(1);
      expect(evidenceWrites).toBe(2);

      const intent = yield* Effect.promise(() =>
        pool.query<{
          state: string;
          provider_status: string;
          provider_activity_ref: string;
          provider_delegated_credential_ref: string;
        }>(
          `SELECT state, provider_status, provider_activity_ref,
             provider_delegated_credential_ref
           FROM cloud_wallet_delegation_configuration_intent
           WHERE workspace_id = $1 AND wallet_id = $2 AND operation_id = $3`,
          [workspaceA, walletId, "delegation-crash"],
        ),
      );
      expect(intent.rows[0]).toMatchObject({ state: "completed", provider_status: "applied" });
      expect(intent.rows[0]?.provider_activity_ref).toBeTruthy();
      expect(intent.rows[0]?.provider_delegated_credential_ref).toBeTruthy();
    }),
  ),
);

it.effect("reconciles an uncertain delegation activity without resubmitting configuration", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      let configureCalls = 0;
      const { custody, service } = serviceFixture(pool, (base) => ({
        ...base,
        configureDelegatedAuthorization: (input) => {
          configureCalls += 1;
          return Effect.fail(
            new WalletCustodyError({
              code: "providerUnavailable",
              operation: "configure-delegated-authorization",
              retryable: true,
              outcome: "uncertain",
              providerActivityRef: `activity-${input.operationId}`,
              providerStatus: "stillUnknown",
              observedAt: now,
            }),
          );
        },
      }));
      yield* service.provision(principalA, provisionRequest(), provisioningMaterial());

      expect(
        Exit.isFailure(yield* Effect.exit(configureDelegation(service, "uncertain", "uncertain"))),
      ).toBe(true);
      const recovered = yield* configureDelegation(service, "uncertain", "uncertain");
      expect(recovered.authorizationId).toBe("authorization-uncertain");
      expect(configureCalls).toBe(1);
      expect(
        custody.calls.filter((call) => call.operation === "getDelegatedAuthorizationStatus"),
      ).toHaveLength(1);
    }),
  ),
);

it.effect("replays durable provider evidence after a crash before authorization activation", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      let activationWrites = 0;
      const { custody, service } = serviceFixture(
        pool,
        undefined,
        () => walletId,
        (repository) => ({
          ...repository,
          completeDelegation: (input) => {
            activationWrites += 1;
            return activationWrites === 1
              ? Effect.fail(
                  new WalletRepositoryError({
                    code: "databaseFailure",
                    operation: "simulated-crash-before-authorization-activation",
                    retryable: true,
                    cause: "simulated connection loss",
                  }),
                )
              : repository.completeDelegation(input);
          },
        }),
      );
      yield* service.provision(principalA, provisionRequest(), provisioningMaterial());

      expect(
        Exit.isFailure(yield* Effect.exit(configureDelegation(service, "activate", "activate"))),
      ).toBe(true);
      const recovered = yield* configureDelegation(service, "activate", "activate");
      expect(recovered.authorizationId).toBe("authorization-activate");
      expect(
        custody.calls.filter((call) => call.operation === "configureDelegatedAuthorization"),
      ).toHaveLength(1);
      expect(
        custody.calls.filter((call) => call.operation === "getDelegatedAuthorizationStatus"),
      ).toHaveLength(0);
      expect(activationWrites).toBe(2);
    }),
  ),
);

it.effect("reconciles an uncertain provider revocation before configuring new access", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      let revokeCalls = 0;
      let statusCalls = 0;
      const { custody, service } = serviceFixture(pool, (base) => ({
        ...base,
        revokeDelegatedAuthorization: (input) => {
          revokeCalls += 1;
          return Effect.succeed({
            providerActivityRef: `revoke-${input.operationId}`,
            status: "stillUnknown",
            observedAt: input.requestedAt,
          });
        },
        getDelegationRevocationStatus: (input) => {
          statusCalls += 1;
          return Effect.succeed({
            providerActivityRef: input.providerActivityRef,
            status: "applied",
            observedAt: input.observedAt,
          });
        },
      }));
      yield* service.provision(principalA, provisionRequest(), provisioningMaterial());
      yield* configureDelegation(service, "a");

      const first = yield* Effect.exit(configureDelegation(service, "b"));
      expect(Exit.isFailure(first)).toBe(true);
      expect(
        custody.calls.filter((call) => call.operation === "configureDelegatedAuthorization"),
      ).toHaveLength(1);

      const replacement = yield* configureDelegation(service, "b");
      expect(replacement.authorizationId).toBe("authorization-b");
      expect(revokeCalls).toBe(1);
      expect(statusCalls).toBe(1);
      expect(
        custody.calls.filter((call) => call.operation === "configureDelegatedAuthorization"),
      ).toHaveLength(2);
    }),
  ),
);

it.effect("requires a matching live withdrawal approval and replays the transfer", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const { custody, service } = serviceFixture(pool);
      yield* service.provision(principalA, provisionRequest(), provisioningMaterial());
      const input = {
        schemaVersion: 1 as const,
        operationId: "withdrawal-a" as WalletWithdrawalRequest["operationId"],
        idempotencyKey: "withdrawal-once" as WalletWithdrawalRequest["idempotencyKey"],
        workspaceId: workspaceA,
        walletId,
        destination,
        amountMicroUsdc: 125_000 as MicroUsdc,
        approvalId: "approval-a" as WalletWithdrawalRequest["approval"]["approvalId"],
        approvedByUserId: "user-a",
        approvedByAuthSessionId: authSessionA,
        approvedAt: now,
        expiresAt: "2026-08-28T00:05:00.000Z",
        requestedAt: now,
      };
      const requestFingerprint = walletRequestFingerprint(input);
      const request: WalletWithdrawalRequest = {
        schemaVersion: 1,
        operationId: input.operationId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint,
        workspaceId: workspaceA,
        walletId,
        approval: {
          approvalId: input.approvalId,
          walletId,
          workspaceId: workspaceA,
          destination,
          amountMicroUsdc: input.amountMicroUsdc,
          approvedByUserId: "user-a",
          approvedByAuthSessionId: authSessionA,
          approvedAt: now,
          expiresAt: input.expiresAt,
          requestFingerprint,
        },
        requestedAt: now,
      };
      const ownerAuthorization = {
        stamp: Secret.make<Uint8Array>(new Uint8Array([9, 9, 9])),
      };
      const first = yield* service.withdraw(principalA, request, ownerAuthorization);
      const duplicate = yield* service.withdraw(principalA, request, ownerAuthorization);
      expect(first.disposition).toBe("submitted");
      expect(duplicate.disposition).toBe("duplicate");
      expect(custody.calls.filter((call) => call.operation === "withdraw")).toHaveLength(1);

      const wrongSession = yield* Effect.exit(
        service.withdraw(
          { ...principalA, authSessionId: "other-session" as AuthSessionId },
          { ...request, operationId: "withdrawal-b" as WalletWithdrawalRequest["operationId"] },
          ownerAuthorization,
        ),
      );
      expect(Exit.isFailure(wrongSession)).toBe(true);
    }),
  ),
);

it.effect("stores only recovery metadata and completes an unexpired recovery once", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const { custody, service } = serviceFixture(pool);
      yield* service.provision(principalA, provisionRequest(), provisioningMaterial());
      yield* configureDelegation(service, "a");
      const common = {
        recoveryAttemptId: "recovery-a" as WalletRecoveryBeginRequest["recoveryAttemptId"],
        walletId,
        workspaceId: workspaceA,
        requestedAt: now,
      };
      const beginInput = {
        operationId: "recovery-begin-a" as WalletRecoveryBeginRequest["operationId"],
        idempotencyKey: "recovery-begin-once" as WalletRecoveryBeginRequest["idempotencyKey"],
        ...common,
      };
      const begin: WalletRecoveryBeginRequest = {
        ...beginInput,
        requestFingerprint: walletRequestFingerprint(beginInput),
      };
      const initiated = yield* service.beginRecovery(principalA, begin, {
        recoveryEmail: Secret.make("wallet-owner@example.test"),
        targetPublicKey: Secret.make("opaque-target-public-key"),
      });
      expect(initiated.state).toBe("initiated");

      const completeInput = {
        operationId: "recovery-complete-a" as WalletRecoveryCompleteRequest["operationId"],
        idempotencyKey: "recovery-complete-once" as WalletRecoveryCompleteRequest["idempotencyKey"],
        ...common,
      };
      const complete: WalletRecoveryCompleteRequest = {
        ...completeInput,
        requestFingerprint: walletRequestFingerprint(completeInput),
      };
      const completed = yield* service.completeRecovery(principalA, complete, {
        encryptedRecoveryBundle: Secret.make("opaque-recovery-bundle"),
      });
      const duplicate = yield* service.completeRecovery(principalA, complete, {
        encryptedRecoveryBundle: Secret.make("must-not-be-consumed"),
      });
      expect(completed.state).toBe("completed");
      expect(duplicate.state).toBe("completed");
      expect(custody.calls.filter((call) => call.operation === "beginRecovery")).toHaveLength(1);
      expect(custody.calls.filter((call) => call.operation === "completeRecovery")).toHaveLength(1);
      expect(
        custody.calls.filter((call) => call.operation === "revokeDelegatedAuthorization"),
      ).toHaveLength(1);
      expect((yield* service.getWallet(principalA, walletId)).state).toBe("frozen");
      const recoveryIntent = yield* Effect.promise(() =>
        pool.query<{ operation_kind: string; state: string }>(
          `SELECT operation_kind, state
           FROM cloud_wallet_delegation_configuration_intent
           WHERE workspace_id = $1 AND wallet_id = $2 AND operation_id = $3`,
          [workspaceA, walletId, complete.operationId],
        ),
      );
      expect(recoveryIntent.rows[0]).toEqual({
        operation_kind: "recoveryComplete",
        state: "completed",
      });

      yield* configureDelegation(service, "b");
      expect((yield* service.getWallet(principalA, walletId)).state).toBe("active");

      const recoveryRows = yield* Effect.promise(() =>
        pool.query("SELECT row_to_json(value) AS value FROM cloud_wallet_recovery_attempt value"),
      );
      const persisted = NodeUtil.inspect(recoveryRows.rows, { depth: null });
      expect(persisted).not.toContain("wallet-owner@example.test");
      expect(persisted).not.toContain("opaque-target-public-key");
      expect(persisted).not.toContain("opaque-recovery-bundle");
    }),
  ),
);

it.effect(
  "reconciles uncertain charges as applied, not-applied, or still-unknown without replay",
  () =>
    withPostgres((pool) =>
      Effect.gen(function* () {
        let uncertainCalls = 0;
        let statusCalls = 0;
        const statuses: Array<"applied" | "notApplied" | "stillUnknown"> = [
          "stillUnknown",
          "applied",
          "notApplied",
        ];
        const appliedHash = `0x${"a".repeat(64)}` as EvmTransactionHash;
        const { repository, service } = serviceFixture(pool, (base) => ({
          ...base,
          charge: (input) => {
            uncertainCalls += 1;
            return Effect.fail(
              new WalletCustodyError({
                code: "providerUnavailable",
                operation: "charge",
                retryable: true,
                outcome: "uncertain",
                providerActivityRef: `activity-${input.operationId}`,
                providerStatus: "stillUnknown",
                observedAt: now,
              }),
            );
          },
          getChargeStatus: (input) => {
            const status = statuses[statusCalls] ?? "stillUnknown";
            statusCalls += 1;
            return Effect.succeed({
              evidence: {
                providerActivityRef: input.providerActivityRef,
                status,
                observedAt: input.observedAt,
                ...(status === "applied" ? { txHash: appliedHash } : {}),
              },
            });
          },
        }));
        yield* service.provision(principalA, provisionRequest(), provisioningMaterial());
        yield* configureDelegation(service);
        const request = chargeRequest("reservation-uncertain", 250_000 as MicroUsdc);

        const first = yield* Effect.exit(service.charge(settlementA, request));
        const retry = yield* Effect.exit(service.charge(settlementA, request));
        expect(Exit.isFailure(first)).toBe(true);
        expect(Exit.isFailure(retry)).toBe(true);
        expect(uncertainCalls).toBe(1);

        const unknown = yield* service.reconcileCharge(settlementA, request.reservationId);
        expect(unknown.status).toBe("stillUnknown");
        expect(unknown.reservation.state).toBe("reserved");
        const applied = yield* service.reconcileCharge(settlementA, request.reservationId);
        expect(applied.status).toBe("applied");
        expect(applied.reservation.state).toBe("submitted");
        expect(applied.transfer?.txHash).toBe(appliedHash);
        const appliedReplay = yield* service.reconcileCharge(settlementA, request.reservationId);
        expect(appliedReplay.disposition).toBe("duplicate");
        expect(appliedReplay.status).toBe("applied");
        expect(statusCalls).toBe(2);

        const rejected = chargeRequest("reservation-not-applied", 200_000 as MicroUsdc);
        expect(Exit.isFailure(yield* Effect.exit(service.charge(settlementA, rejected)))).toBe(
          true,
        );
        const notApplied = yield* service.reconcileCharge(settlementA, rejected.reservationId);
        expect(notApplied.status).toBe("notApplied");
        expect(notApplied.reservation.state).toBe("released");
        const notAppliedReplay = yield* service.reconcileCharge(
          settlementA,
          rejected.reservationId,
        );
        expect(notAppliedReplay.disposition).toBe("duplicate");
        expect(notAppliedReplay.status).toBe("notApplied");
        expect(statusCalls).toBe(3);
        expect(uncertainCalls).toBe(2);

        const foreign = yield* Effect.exit(
          service.reconcileCharge(
            { service: "billing-settlement", workspaceId: workspaceB },
            request.reservationId,
          ),
        );
        expect(Exit.isFailure(foreign)).toBe(true);

        const audit = yield* repository.listAudit(workspaceA, walletId);
        expect(audit.filter((event) => event.eventKind === "spendReserved")).toHaveLength(2);
        expect(audit.filter((event) => event.eventKind === "spendSubmitted")).toHaveLength(1);
        expect(audit.filter((event) => event.eventKind === "spendReleased")).toHaveLength(1);
      }),
    ),
);
