// @effect-diagnostics nodeBuiltinImport:off -- PostgreSQL tests own an isolated random schema.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type {
  EvmTransactionHash,
  MicroUsdc,
  SandboxId,
  SettlementId,
  UsageAccrualId,
  UsageEvidenceId,
  UsageEvidenceSha256,
  UsageSampleId,
  VerifiedE2bUsageEvidence,
  WorkspaceId,
} from "@t3tools/contracts/cloud";
import type { WalletDelegatedAuthorizationId, WalletId } from "@t3tools/contracts/wallet";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { Pool } from "pg";

import { makePostgresUsageLedgerRepository } from "./usageLedgerRepository.ts";
import {
  makeUsageMeteringService,
  type UsageMeteringRequest,
  type VerifiedE2bUsageSource,
} from "./usageMeteringService.ts";
import { makePostgresUsageSettlementRepository } from "./usageSettlementRepository.ts";
import {
  makeUsageSettlementService,
  SettlementReceiptSignerError,
  SettlementRuntimeBoundaryError,
  type MonadSettlementObservation,
  type MonadSettlementPort,
  type SettlementReceiptSigner,
  type SettlementRuntimeBoundary,
} from "./usageSettlementService.ts";

const postgresUrl = process.env.AGENTSIN_TEST_POSTGRES_URL;
const workspaceId = "77777777-7777-4777-8777-777777777777" as WorkspaceId;
const threadId = "settlement-thread" as ThreadId;
const environmentId = "settlement-environment" as EnvironmentId;
const projectId = "settlement-project" as ProjectId;
const sandboxId = "settlement-sandbox" as SandboxId;
const walletId = "settlement-wallet" as WalletId;
const authorizationId = "settlement-authorization" as WalletDelegatedAuthorizationId;
const walletAddress = "0x1111111111111111111111111111111111111111";
const treasuryAddress = "0x2222222222222222222222222222222222222222";
const appliedTx = `0x${"a".repeat(64)}` as EvmTransactionHash;

const fixture = (url: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const schema = `agentsin_h5_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
      const admin = new Pool({ connectionString: url, max: 1 });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const pool = new Pool({
        connectionString: url,
        max: 12,
        options: `-c search_path=${schema}`,
        connectionTimeoutMillis: 5_000,
        query_timeout: 10_000,
        statement_timeout: 10_000,
      });
      await pool.query('CREATE TABLE "user" (id text PRIMARY KEY)');
      for (const filename of [
        "0001-workspaces.sql",
        "0002-cloud-thread-store.sql",
        "0004-cloud-thread-lifecycle.sql",
        "0012-user-wallets.sql",
        "0014-usage-ledger.sql",
        "0016-usage-settlements.sql",
      ]) {
        const migration = await NodeFSP.readFile(
          new URL(`./migrations/${filename}`, import.meta.url),
          "utf8",
        );
        await pool.query(migration);
      }
      await pool.query(
        await NodeFSP.readFile(
          new URL("./migrations/0016-usage-settlements.sql", import.meta.url),
          "utf8",
        ),
      );
      await pool.query('INSERT INTO "user" (id) VALUES ($1)', ["settlement-owner"]);
      await pool.query("INSERT INTO workspace (id, owner_user_id, name) VALUES ($1,$2,$3)", [
        workspaceId,
        "settlement-owner",
        "Settlement",
      ]);
      await pool.query(
        "INSERT INTO cloud_thread (workspace_id, thread_id, environment_id) VALUES ($1,$2,$3)",
        [workspaceId, threadId, environmentId],
      );
      await pool.query(
        `INSERT INTO cloud_e2b_sandbox_identity (
           workspace_id, reservation_id, thread_id, environment_id, project_id, revision_id,
           repository_identity, workspace_directory, sandbox_id, provider_handle, state,
           requested_at, activated_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11,$11,$11)`,
        [
          workspaceId,
          "settlement-reservation",
          threadId,
          environmentId,
          projectId,
          "settlement-revision",
          { canonicalKey: "github.com/jarrodwatts/agentsin-cloud" },
          "/workspace/agentsin-cloud",
          sandboxId,
          "e2b-settlement-sandbox",
          "2026-08-28T00:00:00.000Z",
        ],
      );
      await pool.query(
        `INSERT INTO cloud_wallet (
           workspace_id, wallet_id, owner_user_id, provider, provider_organization_ref,
           provider_wallet_ref, evm_address, state, recovery_method, recovery_enabled,
           created_at, updated_at
         ) VALUES ($1,$2,$3,'turnkey',$4,$5,$6,'active','passkeyAndEmail',true,$7,$7)`,
        [
          workspaceId,
          walletId,
          "settlement-owner",
          "turnkey-org-settlement",
          "turnkey-wallet-settlement",
          walletAddress,
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
          workspaceId,
          walletId,
          authorizationId,
          "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
          treasuryAddress,
          "2026-08-28T00:00:00.000Z",
          "2026-08-29T00:00:00.000Z",
          "turnkey-policy-settlement",
          "turnkey-user-settlement",
          "secret://turnkey/delegated/settlement",
        ],
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

const withPostgres = <E>(use: (pool: Pool) => Effect.Effect<void, E>): Effect.Effect<void, E> => {
  if (postgresUrl === undefined) return Effect.void;
  return Effect.scoped(Effect.flatMap(fixture(postgresUrl), ({ pool }) => use(pool)));
};

const evidence = (
  evidenceId: string,
  revision: number,
  upstreamMicroUsdc: number,
  hashCharacter: string,
): VerifiedE2bUsageEvidence => ({
  evidenceId: evidenceId as UsageEvidenceId,
  revision,
  infrastructureProvider: "e2b",
  verification: "e2b-authenticated-billing-record",
  payloadSha256: hashCharacter.repeat(64) as UsageEvidenceSha256,
  intervalStart: "2026-08-28T00:00:00.000Z",
  intervalEnd: "2026-08-28T00:05:00.000Z",
  upstreamMicroUsdc: upstreamMicroUsdc as MicroUsdc,
  observedAt: "2026-08-28T00:06:00.000Z",
});

const accrue = (
  pool: Pool,
  records: Map<string, VerifiedE2bUsageEvidence>,
  value: VerifiedE2bUsageEvidence,
  idempotencyKey: string,
) => {
  const source: VerifiedE2bUsageSource = {
    read: (request) => Effect.succeed(records.get(request.evidenceId)!),
  };
  const service = makeUsageMeteringService({
    repository: makePostgresUsageLedgerRepository(pool),
    source,
    now: () => "2026-08-28T00:06:00.000Z",
    sampleId: (request) => `sample-${request.idempotencyKey}` as UsageSampleId,
    accrualId: (request) => `accrual-${request.idempotencyKey}` as UsageAccrualId,
  });
  const request: UsageMeteringRequest = {
    workspaceId,
    environmentId,
    threadId,
    sandboxId,
    evidenceId: value.evidenceId,
    intervalStart: value.intervalStart,
    intervalEnd: value.intervalEnd,
    idempotencyKey,
  };
  return service.accrue({ service: "e2b-usage-sampler", workspaceId }, request);
};

const makeChain = () => {
  let submitResult: MonadSettlementObservation = {
    status: "applied",
    providerActivityRef: "turnkey-activity-1",
    txHash: appliedTx,
    submittedAt: "2026-08-28T00:15:00.000Z",
  };
  let inspectResult: MonadSettlementObservation = { status: "notApplied" };
  let submits = 0;
  let inspections = 0;
  const port: MonadSettlementPort = {
    inspect: () => {
      inspections += 1;
      return Effect.succeed(inspectResult);
    },
    submit: () => {
      submits += 1;
      return Effect.succeed(submitResult);
    },
  };
  return {
    port,
    submits: () => submits,
    inspections: () => inspections,
    setSubmit: (value: MonadSettlementObservation) => {
      submitResult = value;
    },
    setInspect: (value: MonadSettlementObservation) => {
      inspectResult = value;
    },
  };
};

const signer = (fails = false): SettlementReceiptSigner => ({
  sign: ({ payloadSha256, signedAt }) =>
    fails
      ? Effect.fail(new SettlementReceiptSignerError({ code: "kms-unavailable", retryable: true }))
      : Effect.succeed({
          algorithm: "ed25519",
          keyId: "kms://settlement-receipts/v1",
          payloadHash: payloadSha256,
          signature: `signature:${payloadSha256}`,
          signedAt,
        }),
});

const makeRuntime = () => {
  let pauses = 0;
  let fails = false;
  const runtime: SettlementRuntimeBoundary = {
    pauseForInsufficientBalance: () => {
      pauses += 1;
      return fails
        ? Effect.fail(
            new SettlementRuntimeBoundaryError({ code: "runtime-unavailable", retryable: true }),
          )
        : Effect.succeed({ pausedAt: "2026-08-28T00:15:00.000Z" });
    },
  };
  return {
    runtime,
    pauses: () => pauses,
    setFail: (value: boolean) => {
      fails = value;
    },
  };
};

const settlementService = (
  pool: Pool,
  chain: ReturnType<typeof makeChain>,
  receiptSigner: SettlementReceiptSigner,
  runtime: SettlementRuntimeBoundary,
  processorId: string,
  now = "2026-08-28T00:15:00.000Z",
) =>
  makeUsageSettlementService({
    repository: makePostgresUsageSettlementRepository(pool),
    settlement: chain.port,
    signer: receiptSigner,
    runtime,
    processorId,
    now: () => now,
  });

const onlySettlementId = (pool: Pool) =>
  pool
    .query<{ readonly settlement_id: string }>(
      "SELECT settlement_id FROM cloud_usage_settlement_attempt",
    )
    .then((result) => result.rows[0]!.settlement_id as SettlementId);

it.effect("settles immutable debit and credit accruals once under concurrent delivery", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const records = new Map<string, VerifiedE2bUsageEvidence>();
      const initial = evidence("corrected-settlement", 1, 1_000, "a");
      records.set(initial.evidenceId, initial);
      yield* accrue(pool, records, initial, "settlement-v1");
      const correction = evidence("corrected-settlement", 2, 900, "b");
      records.set(correction.evidenceId, correction);
      yield* accrue(pool, records, correction, "settlement-v2");

      const chain = makeChain();
      const runtime = makeRuntime();
      const first = settlementService(pool, chain, signer(), runtime.runtime, "settler-a");
      const second = settlementService(pool, chain, signer(), runtime.runtime, "settler-b");
      const results = yield* Effect.all(
        [
          first.settleReady({ trigger: "sandbox-paused", workspaceId, threadId }),
          second.settleReady({ trigger: "sandbox-paused", workspaceId, threadId }),
        ],
        { concurrency: "unbounded" },
      );
      expect(results.reduce((sum, result) => sum + result.claimed, 0)).toBe(1);
      expect(results.reduce((sum, result) => sum + result.finalized, 0)).toBe(1);
      expect(chain.submits()).toBe(1);

      const settlementId = yield* Effect.promise(() => onlySettlementId(pool));
      const stored = yield* Effect.promise(() =>
        makePostgresUsageSettlementRepository(pool).get(workspaceId, settlementId),
      );
      expect(stored).toMatchObject({
        state: "finalized",
        upstreamDeltaMicroUsdc: 900,
        markupDeltaMicroUsdc: 45,
        totalDeltaMicroUsdc: 945,
        txHash: appliedTx,
      });
      expect(stored?.postings.map((posting) => posting.totalDeltaMicroUsdc)).toEqual([1050, -105]);
      expect(stored?.receipt?.payload).toMatchObject({
        workspaceId,
        threadId,
        infrastructureProvider: "e2b",
        upstreamMicroUsdc: 900,
        markupMicroUsdc: 45,
        totalMicroUsdc: 945,
        txHash: appliedTx,
      });
      expect(stored?.receipt?.signature.payloadHash).toBe(stored?.receipt?.payloadSha256);

      expect(
        Exit.isFailure(
          yield* Effect.exit(
            Effect.tryPromise(() =>
              pool.query("UPDATE cloud_usage_settlement_item SET total_delta_micro_usdc = 1"),
            ),
          ),
        ),
      ).toBe(true);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            Effect.tryPromise(() =>
              pool.query("UPDATE cloud_usage_settlement_attempt SET total_delta_micro_usdc = 1"),
            ),
          ),
        ),
      ).toBe(true);
    }),
  ),
);

it.effect("settles at the exact five-minute boundary and immediately at the amount threshold", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const first = evidence("timer-boundary", 1, 100_000, "f");
      const records = new Map([[first.evidenceId, first]]);
      yield* accrue(pool, records, first, "timer-boundary-v1");
      const chain = makeChain();
      chain.setSubmit({
        status: "applied",
        providerActivityRef: "turnkey-timer-boundary",
        txHash: appliedTx,
        submittedAt: "2026-08-28T00:11:00.000Z",
      });
      const runtime = makeRuntime();
      expect(
        (yield* settlementService(
          pool,
          chain,
          signer(),
          runtime.runtime,
          "settler-before",
          "2026-08-28T00:10:59.999Z",
        ).settleReady()).claimed,
      ).toBe(0);
      const timed = yield* settlementService(
        pool,
        chain,
        signer(),
        runtime.runtime,
        "settler-at-boundary",
        "2026-08-28T00:11:00.000Z",
      ).settleReady();
      expect(timed).toMatchObject({ claimed: 1, finalized: 1 });
      const timedId = yield* Effect.promise(() => onlySettlementId(pool));
      expect(
        (yield* Effect.promise(() =>
          makePostgresUsageSettlementRepository(pool).get(workspaceId, timedId),
        ))?.trigger,
      ).toBe("five-minute-window");
    }),
  ),
);

it.effect("settles a threshold-sized charge before five minutes elapse", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const first = evidence("amount-threshold", 1, 250_000, "9");
      const records = new Map([[first.evidenceId, first]]);
      yield* accrue(pool, records, first, "amount-threshold-v1");
      const chain = makeChain();
      chain.setSubmit({
        status: "applied",
        providerActivityRef: "turnkey-amount-threshold",
        txHash: appliedTx,
        submittedAt: "2026-08-28T00:06:00.000Z",
      });
      const runtime = makeRuntime();
      const result = yield* settlementService(
        pool,
        chain,
        signer(),
        runtime.runtime,
        "settler-threshold",
        "2026-08-28T00:06:00.000Z",
      ).settleReady();
      expect(result).toMatchObject({ claimed: 1, finalized: 1 });
      const id = yield* Effect.promise(() => onlySettlementId(pool));
      expect(
        (yield* Effect.promise(() =>
          makePostgresUsageSettlementRepository(pool).get(workspaceId, id),
        ))?.trigger,
      ).toBe("amount-threshold");
    }),
  ),
);

it.effect("recovers after transfer submission without submitting a second transaction", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const first = evidence("crash-recovery", 1, 2_000, "c");
      const records = new Map([[first.evidenceId, first]]);
      yield* accrue(pool, records, first, "crash-recovery-v1");
      const chain = makeChain();
      const runtime = makeRuntime();
      const failing = settlementService(pool, chain, signer(true), runtime.runtime, "settler-a");
      expect(
        yield* failing.settleReady({ trigger: "sandbox-closed", workspaceId, threadId }),
      ).toMatchObject({ claimed: 1, pending: 1, finalized: 0 });
      expect(chain.submits()).toBe(1);
      const settlementId = yield* Effect.promise(() => onlySettlementId(pool));
      const before = yield* Effect.promise(() =>
        makePostgresUsageSettlementRepository(pool).get(workspaceId, settlementId),
      );
      expect(before?.state).toBe("transfer-applied");

      const recovered = settlementService(pool, chain, signer(), runtime.runtime, "settler-b");
      expect((yield* recovered.recoverPending()).finalized).toBe(1);
      expect(chain.submits()).toBe(1);
    }),
  ),
);

it.effect("reconciles an uncertain transfer and never resubmits it", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const first = evidence("uncertain-transfer", 1, 3_000, "d");
      const records = new Map([[first.evidenceId, first]]);
      yield* accrue(pool, records, first, "uncertain-v1");
      const chain = makeChain();
      chain.setSubmit({ status: "unknown", providerActivityRef: "turnkey-unknown-1" });
      const runtime = makeRuntime();
      const service = settlementService(pool, chain, signer(), runtime.runtime, "settler-a");
      const firstSweep = yield* service.settleReady({
        trigger: "sandbox-paused",
        workspaceId,
        threadId,
      });
      expect(firstSweep.reconciliationRequired).toBe(1);
      expect(chain.submits()).toBe(1);

      chain.setInspect({
        status: "notApplied",
        providerActivityRef: "turnkey-substituted-activity",
      });
      expect(
        yield* settlementService(
          pool,
          chain,
          signer(),
          runtime.runtime,
          "settler-not-applied-mismatch",
        ).recoverPending(),
      ).toMatchObject({ reconciliationRequired: 1, finalized: 0 });
      expect(chain.submits()).toBe(1);

      chain.setInspect({
        status: "applied",
        providerActivityRef: "turnkey-substituted-activity",
        txHash: appliedTx,
        submittedAt: "2026-08-28T00:15:00.000Z",
      });
      expect(
        yield* settlementService(
          pool,
          chain,
          signer(),
          runtime.runtime,
          "settler-mismatch",
        ).recoverPending(),
      ).toMatchObject({ reconciliationRequired: 1, finalized: 0 });

      chain.setInspect({
        status: "applied",
        providerActivityRef: "turnkey-unknown-1",
        txHash: appliedTx,
        submittedAt: "2026-08-28T00:15:00.000Z",
      });
      const recovered = yield* settlementService(
        pool,
        chain,
        signer(),
        runtime.runtime,
        "settler-b",
      ).recoverPending();
      expect(recovered.finalized).toBe(1);
      expect(chain.submits()).toBe(1);
    }),
  ),
);

it.effect("durably pauses on low balance and resumes only after an explicit funding retry", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const first = evidence("low-balance", 1, 4_000, "e");
      const records = new Map([[first.evidenceId, first]]);
      yield* accrue(pool, records, first, "low-balance-v1");
      const chain = makeChain();
      chain.setSubmit({ status: "insufficientBalance" });
      const runtime = makeRuntime();
      const service = settlementService(pool, chain, signer(), runtime.runtime, "settler-a");
      const result = yield* service.settleReady({
        trigger: "sandbox-paused",
        workspaceId,
        threadId,
      });
      expect(result.lowBalancePaused).toBe(1);
      expect(runtime.pauses()).toBe(1);
      const settlementId = yield* Effect.promise(() => onlySettlementId(pool));
      const stored = yield* Effect.promise(() =>
        makePostgresUsageSettlementRepository(pool).get(workspaceId, settlementId),
      );
      expect(stored?.state).toBe("low-balance-paused");
      expect(stored?.receipt).toBeUndefined();
      expect((yield* service.recoverPending()).claimed).toBe(0);

      chain.setSubmit({
        status: "applied",
        providerActivityRef: "turnkey-funded-1",
        txHash: appliedTx,
        submittedAt: "2026-08-28T00:15:00.000Z",
      });
      const funded = yield* settlementService(
        pool,
        chain,
        signer(),
        runtime.runtime,
        "settler-b",
      ).retryLowBalance(workspaceId, settlementId);
      expect(funded.state).toBe("finalized");
      expect(runtime.pauses()).toBe(1);
      expect(chain.submits()).toBe(2);
    }),
  ),
);

it.effect("keeps a failed low-balance pause durable and retries only the pause boundary", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const first = evidence("pause-recovery", 1, 5_000, "7");
      const records = new Map([[first.evidenceId, first]]);
      yield* accrue(pool, records, first, "pause-recovery-v1");
      const chain = makeChain();
      chain.setSubmit({ status: "insufficientBalance" });
      const runtime = makeRuntime();
      runtime.setFail(true);
      const service = settlementService(pool, chain, signer(), runtime.runtime, "settler-a");
      expect(
        yield* service.settleReady({ trigger: "sandbox-closed", workspaceId, threadId }),
      ).toMatchObject({ claimed: 1, pending: 1, lowBalancePaused: 0 });
      expect(chain.submits()).toBe(1);
      const settlementId = yield* Effect.promise(() => onlySettlementId(pool));
      expect(
        (yield* Effect.promise(() =>
          makePostgresUsageSettlementRepository(pool).get(workspaceId, settlementId),
        ))?.state,
      ).toBe("low-balance-pause-pending");

      runtime.setFail(false);
      expect((yield* service.recoverPending()).lowBalancePaused).toBe(1);
      expect(chain.submits()).toBe(1);
      expect(runtime.pauses()).toBe(2);
    }),
  ),
);
