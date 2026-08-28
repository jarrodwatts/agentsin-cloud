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
  MonadSettlementPortError,
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
        "0013-cloud-thread-runtime.sql",
        "0014-usage-ledger.sql",
        "0015-e2b-template-identity.sql",
        "0016-usage-settlements.sql",
        "0017-usage-settlement-hardening.sql",
      ]) {
        const migration = await NodeFSP.readFile(
          new URL(`./migrations/${filename}`, import.meta.url),
          "utf8",
        );
        await pool.query(migration);
      }
      await pool.query(
        await NodeFSP.readFile(
          new URL("./migrations/0017-usage-settlement-hardening.sql", import.meta.url),
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
           provider_template_id, provider_build_id, requested_at, activated_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11,$12,$13,$13,$13)`,
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
          "agentsin-cloud-settlement",
          "11111111-1111-4111-8111-111111111111",
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
  now = "2026-08-28T00:06:00.000Z",
  scope: {
    readonly threadId?: ThreadId;
    readonly environmentId?: EnvironmentId;
    readonly sandboxId?: SandboxId;
  } = {},
) => {
  const source: VerifiedE2bUsageSource = {
    read: (request) => Effect.succeed(records.get(request.evidenceId)!),
  };
  const service = makeUsageMeteringService({
    repository: makePostgresUsageLedgerRepository(pool),
    source,
    now: () => now,
    sampleId: (request) => `sample-${request.idempotencyKey}` as UsageSampleId,
    accrualId: (request) => `accrual-${request.idempotencyKey}` as UsageAccrualId,
  });
  const request: UsageMeteringRequest = {
    workspaceId,
    environmentId: scope.environmentId ?? environmentId,
    threadId: scope.threadId ?? threadId,
    sandboxId: scope.sandboxId ?? sandboxId,
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
  let inspectFailure: MonadSettlementPortError | undefined;
  const submitKeys: Array<string> = [];
  const port: MonadSettlementPort = {
    inspect: () => {
      inspections += 1;
      return inspectFailure === undefined
        ? Effect.succeed(inspectResult)
        : Effect.fail(inspectFailure);
    },
    submit: (request) => {
      submits += 1;
      submitKeys.push(request.idempotencyKey);
      return Effect.succeed(submitResult);
    },
  };
  return {
    port,
    submits: () => submits,
    inspections: () => inspections,
    submitKeys: () => submitKeys,
    setSubmit: (value: MonadSettlementObservation) => {
      submitResult = value;
    },
    setInspect: (value: MonadSettlementObservation) => {
      inspectFailure = undefined;
      inspectResult = value;
    },
    setInspectFailure: (outcome: "uncertain" | "notApplied") => {
      inspectFailure = new MonadSettlementPortError({
        code: "provider-inspection-failed",
        outcome,
        retryable: outcome === "uncertain",
      });
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
  const failedThreadIds = new Set<string>();
  const requestIds: Array<string> = [];
  const runtime: SettlementRuntimeBoundary = {
    pauseForBillingFailure: (request) => {
      pauses += 1;
      requestIds.push(request.requestId);
      return fails || failedThreadIds.has(request.threadId)
        ? Effect.fail(
            new SettlementRuntimeBoundaryError({ code: "runtime-unavailable", retryable: true }),
          )
        : Effect.succeed({ pausedAt: "2026-08-28T00:15:00.000Z" });
    },
  };
  return {
    runtime,
    pauses: () => pauses,
    requestIds: () => requestIds,
    setFail: (value: boolean) => {
      fails = value;
    },
    setThreadFail: (failedThreadId: ThreadId, value: boolean) => {
      if (value) failedThreadIds.add(failedThreadId);
      else failedThreadIds.delete(failedThreadId);
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

const settlementIds = (pool: Pool) =>
  pool
    .query<{ readonly settlement_id: string }>(
      "SELECT settlement_id FROM cloud_usage_settlement_attempt ORDER BY created_at, settlement_id",
    )
    .then((result) => result.rows.map((row) => row.settlement_id as SettlementId));

const addAuthorization = (pool: Pool, id: string) =>
  pool.query(
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
      id,
      "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
      treasuryAddress,
      "2026-08-28T00:00:00.000Z",
      "2026-08-29T00:00:00.000Z",
      `turnkey-policy-${id}`,
      `turnkey-user-${id}`,
      `secret://turnkey/delegated/${id}`,
    ],
  );

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
      ).toMatchObject({ claimed: 1, pending: 1, finalized: 0, billingPaused: 1 });
      expect(chain.submits()).toBe(1);
      expect(runtime.pauses()).toBe(1);
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

it.effect("holds compute when a receipt signer returns a mismatched signature", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const first = evidence("signature-mismatch", 1, 2_100, "b");
      yield* accrue(pool, new Map([[first.evidenceId, first]]), first, "signature-mismatch-v1");
      const chain = makeChain();
      const runtime = makeRuntime();
      const mismatchedSigner: SettlementReceiptSigner = {
        sign: ({ signedAt }) =>
          Effect.succeed({
            algorithm: "ed25519",
            keyId: "kms://settlement-receipts/v1",
            payloadHash: "f".repeat(64) as UsageEvidenceSha256,
            signature: "mismatched-signature",
            signedAt,
          }),
      };
      const held = yield* settlementService(
        pool,
        chain,
        mismatchedSigner,
        runtime.runtime,
        "settler-signature-mismatch",
      ).settleReady({ trigger: "sandbox-closed", workspaceId, threadId });
      expect(held).toMatchObject({ claimed: 1, finalized: 0, billingPaused: 1 });
      expect(runtime.pauses()).toBe(1);
      expect(
        yield* Effect.promise(() =>
          pool.query(
            `SELECT reason, state FROM cloud_usage_billing_fence
              WHERE workspace_id = $1 AND thread_id = $2 AND state <> 'cleared'`,
            [workspaceId, threadId],
          ),
        ),
      ).toMatchObject({
        rows: [{ reason: "provider-outcome-uncertain", state: "paused" }],
      });

      const recovered = yield* settlementService(
        pool,
        chain,
        signer(),
        runtime.runtime,
        "settler-signature-recovery",
        "2026-08-28T00:16:00.000Z",
      ).recoverPending();
      expect(recovered.finalized).toBe(1);
      expect(chain.submits()).toBe(1);
      expect(
        yield* Effect.promise(() =>
          pool.query(
            `SELECT count(*)::integer AS count FROM cloud_usage_billing_fence
              WHERE workspace_id = $1 AND thread_id = $2 AND state <> 'cleared'`,
            [workspaceId, threadId],
          ),
        ),
      ).toMatchObject({ rows: [{ count: 0 }] });
    }),
  ),
);

it.effect("rejects a future provider submission timestamp and pauses compute", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const first = evidence("future-submission", 1, 2_200, "e");
      yield* accrue(pool, new Map([[first.evidenceId, first]]), first, "future-submission-v1");
      const chain = makeChain();
      chain.setSubmit({
        status: "applied",
        providerActivityRef: "turnkey-future-submission",
        txHash: `0x${"e".repeat(64)}` as EvmTransactionHash,
        submittedAt: "2026-08-28T00:15:00.001Z",
      });
      const runtime = makeRuntime();
      const result = yield* settlementService(
        pool,
        chain,
        signer(),
        runtime.runtime,
        "settler-future-submission",
        "2026-08-28T00:15:00.000Z",
      ).settleReady({ trigger: "sandbox-closed", workspaceId, threadId });
      expect(result).toMatchObject({
        claimed: 1,
        finalized: 0,
        reconciliationRequired: 1,
        billingPaused: 1,
      });
      expect(runtime.pauses()).toBe(1);
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
          "2026-08-28T00:15:05.000Z",
        ).retryProviderFailure(workspaceId, yield* Effect.promise(() => onlySettlementId(pool))),
      ).toMatchObject({ state: "reconciliation-required" });
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
          "2026-08-28T00:15:10.000Z",
        ).retryProviderFailure(workspaceId, yield* Effect.promise(() => onlySettlementId(pool))),
      ).toMatchObject({ state: "reconciliation-required" });

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
        "2026-08-28T00:15:15.000Z",
      ).retryProviderFailure(workspaceId, yield* Effect.promise(() => onlySettlementId(pool)));
      expect(recovered.state).toBe("finalized");
      expect(chain.submits()).toBe(1);
    }),
  ),
);

it.effect("holds compute when provider inspection fails definitively", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const first = evidence("inspection-failure", 1, 3_500, "3");
      yield* accrue(pool, new Map([[first.evidenceId, first]]), first, "inspection-failure-v1");
      const chain = makeChain();
      chain.setInspectFailure("notApplied");
      const runtime = makeRuntime();
      const firstSweep = yield* settlementService(
        pool,
        chain,
        signer(),
        runtime.runtime,
        "settler-inspection-failure",
      ).settleReady({ trigger: "sandbox-paused", workspaceId, threadId });
      expect(firstSweep).toMatchObject({
        claimed: 1,
        reconciliationRequired: 1,
        billingPaused: 1,
      });
      expect(chain.submits()).toBe(0);
      expect(runtime.pauses()).toBe(1);
      const settlementId = yield* Effect.promise(() => onlySettlementId(pool));
      const held = yield* settlementService(
        pool,
        chain,
        signer(),
        runtime.runtime,
        "settler-inspection-failure-retry",
        "2026-08-28T00:15:05.000Z",
      ).retryProviderFailure(workspaceId, settlementId);
      expect(held).toMatchObject({
        state: "reconciliation-required",
        failureCode: "provider-inspection-failed",
      });
      expect(chain.submits()).toBe(0);
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

      const stillUnderfunded = yield* settlementService(
        pool,
        chain,
        signer(),
        runtime.runtime,
        "settler-still-underfunded",
      ).retryLowBalance(workspaceId, settlementId);
      expect(stillUnderfunded.state).toBe("low-balance-paused");
      expect(chain.submits()).toBe(2);
      expect(runtime.pauses()).toBe(1);

      chain.setSubmit({
        status: "applied",
        providerActivityRef: "turnkey-funded-1",
        txHash: appliedTx,
        submittedAt: "2026-08-28T00:15:00.000Z",
      });
      yield* Effect.promise(() =>
        makePostgresUsageSettlementRepository(pool).claimLowBalance(
          workspaceId,
          settlementId,
          "settler-funding-crash",
          "2026-08-28T00:15:01.000Z",
          "2026-08-28T00:15:02.000Z",
        ),
      );
      const funded = yield* settlementService(
        pool,
        chain,
        signer(),
        runtime.runtime,
        "settler-b",
        "2026-08-28T00:15:03.000Z",
      ).retryLowBalance(workspaceId, settlementId);
      expect(funded.state).toBe("finalized");
      expect(runtime.pauses()).toBe(1);
      expect(chain.submits()).toBe(3);
    }),
  ),
);

it.effect(
  "holds every workspace thread until an explicit low-balance recovery pauses all siblings",
  () =>
    withPostgres((pool) =>
      Effect.gen(function* () {
        const siblingThreadId = "settlement-thread-sibling" as ThreadId;
        const otherWorkspaceId = "88888888-8888-4888-8888-888888888888" as WorkspaceId;
        const otherThreadId = "settlement-thread-other-workspace" as ThreadId;
        yield* Effect.promise(() =>
          pool.query(
            `INSERT INTO cloud_thread (workspace_id, thread_id, environment_id)
             VALUES ($1,$2,$3)`,
            [workspaceId, siblingThreadId, "settlement-environment-sibling"],
          ),
        );
        yield* Effect.promise(() =>
          pool.query('INSERT INTO "user" (id) VALUES ($1)', ["settlement-owner-other"]),
        );
        yield* Effect.promise(() =>
          pool.query("INSERT INTO workspace (id, owner_user_id, name) VALUES ($1,$2,$3)", [
            otherWorkspaceId,
            "settlement-owner-other",
            "Other settlement workspace",
          ]),
        );
        yield* Effect.promise(() =>
          pool.query(
            `INSERT INTO cloud_thread (workspace_id, thread_id, environment_id)
             VALUES ($1,$2,$3)`,
            [otherWorkspaceId, otherThreadId, "settlement-environment-other"],
          ),
        );

        const first = evidence("workspace-low-balance", 1, 4_250, "d");
        yield* accrue(
          pool,
          new Map([[first.evidenceId, first]]),
          first,
          "workspace-low-balance-v1",
        );
        const chain = makeChain();
        chain.setSubmit({ status: "insufficientBalance" });
        const runtime = makeRuntime();
        runtime.setThreadFail(siblingThreadId, true);
        const service = settlementService(
          pool,
          chain,
          signer(),
          runtime.runtime,
          "settler-workspace-low",
        );
        expect(
          yield* service.settleReady({ trigger: "sandbox-paused", workspaceId, threadId }),
        ).toMatchObject({ lowBalancePaused: 1, billingPaused: 0 });

        const settlementId = yield* Effect.promise(() => onlySettlementId(pool));
        const activeWorkspaceFence = yield* Effect.promise(() =>
          pool.query<{ readonly fence_id: string; readonly episode: number }>(
            `SELECT fence_id, episode FROM cloud_usage_workspace_billing_fence
              WHERE workspace_id = $1 AND state = 'active'`,
            [workspaceId],
          ),
        );
        expect(activeWorkspaceFence.rows).toHaveLength(1);
        expect(activeWorkspaceFence.rows[0]!.episode).toBe(1);
        const linked = yield* Effect.promise(() =>
          pool.query<{
            readonly thread_id: string;
            readonly state: string;
            readonly workspace_fence_id: string | null;
            readonly settlement_id: string | null;
          }>(
            `SELECT thread_id, state, workspace_fence_id, settlement_id
               FROM cloud_usage_billing_fence
              WHERE workspace_id = $1 AND state <> 'cleared' ORDER BY thread_id`,
            [workspaceId],
          ),
        );
        expect(linked.rows).toEqual([
          {
            thread_id: threadId,
            state: "paused",
            workspace_fence_id: activeWorkspaceFence.rows[0]!.fence_id,
            settlement_id: settlementId,
          },
          {
            thread_id: siblingThreadId,
            state: "pause-pending",
            workspace_fence_id: activeWorkspaceFence.rows[0]!.fence_id,
            settlement_id: null,
          },
        ]);
        expect(
          (yield* Effect.promise(() =>
            pool.query(
              `SELECT 1 FROM cloud_usage_billing_fence
                  WHERE workspace_id = $1 AND state <> 'cleared'`,
              [otherWorkspaceId],
            ),
          )).rowCount,
        ).toBe(0);

        expect(
          Exit.isFailure(
            yield* Effect.exit(
              settlementService(
                pool,
                chain,
                signer(),
                runtime.runtime,
                "settler-premature-recovery",
                "2026-08-28T00:15:01.000Z",
              ).retryLowBalance(workspaceId, settlementId),
            ),
          ),
        ).toBe(true);
        expect(chain.submits()).toBe(1);
        expect(
          (yield* Effect.promise(() =>
            makePostgresUsageSettlementRepository(pool).get(workspaceId, settlementId),
          ))?.state,
        ).toBe("low-balance-paused");

        expect(
          Exit.isFailure(
            yield* Effect.exit(
              Effect.tryPromise(() =>
                pool.query(
                  `INSERT INTO cloud_thread_lifecycle_attempt (
                     workspace_id, thread_id, attempt_id, idempotency_key, request_fingerprint,
                     environment_id, environment_revision_id, environment_revision_hash,
                     project_id, provider_instance_id, provider_driver, repository_identity,
                     workspace_directory, state, is_current, created_at, updated_at
                   ) VALUES ($1,$2,'blocked-sibling-create','blocked-sibling-key',$3,$4,
                     'sibling-revision',$5,$6,'provider-instance','codex',$7::jsonb,
                     '/workspace/agentsin-cloud','reserved',true,$8,$8)`,
                  [
                    workspaceId,
                    siblingThreadId,
                    "a".repeat(64),
                    "settlement-environment-sibling",
                    "b".repeat(64),
                    projectId,
                    { canonicalKey: "github.com/jarrodwatts/agentsin-cloud" },
                    "2026-08-28T00:15:01.000Z",
                  ],
                ),
              ),
            ),
          ),
        ).toBe(true);
        yield* Effect.promise(() =>
          pool.query(
            `INSERT INTO cloud_thread_lifecycle_attempt (
               workspace_id, thread_id, attempt_id, idempotency_key, request_fingerprint,
               environment_id, environment_revision_id, environment_revision_hash,
               project_id, provider_instance_id, provider_driver, repository_identity,
               workspace_directory, state, is_current, created_at, updated_at
             ) VALUES ($1,$2,'other-workspace-create','other-workspace-key',$3,$4,
               'other-revision',$5,$6,'provider-instance','codex',$7::jsonb,
               '/workspace/agentsin-cloud','reserved',true,$8,$8)`,
            [
              otherWorkspaceId,
              otherThreadId,
              "c".repeat(64),
              "settlement-environment-other",
              "d".repeat(64),
              projectId,
              { canonicalKey: "github.com/jarrodwatts/agentsin-cloud" },
              "2026-08-28T00:15:01.000Z",
            ],
          ),
        );

        runtime.setThreadFail(siblingThreadId, false);
        expect((yield* service.recoverPending()).billingPaused).toBe(1);
        const repository = makePostgresUsageSettlementRepository(pool);
        const authorized = yield* Effect.promise(() =>
          repository.claimLowBalance(
            workspaceId,
            settlementId,
            "settler-workspace-crash",
            "2026-08-28T00:15:02.000Z",
            "2026-08-28T00:16:02.000Z",
          ),
        );
        expect(
          (yield* Effect.promise(() =>
            pool.query<{ readonly fence_id: string }>(
              `SELECT fence.workspace_fence_id AS fence_id
                 FROM cloud_usage_billing_recovery_authorization recovery
                 JOIN cloud_usage_billing_fence fence
                   ON fence.workspace_id = recovery.workspace_id
                  AND fence.thread_id = recovery.thread_id
                  AND fence.fence_id = recovery.fence_id
                WHERE recovery.workspace_id = $1 AND recovery.settlement_id = $2`,
              [workspaceId, settlementId],
            ),
          )).rows,
        ).toEqual([{ fence_id: activeWorkspaceFence.rows[0]!.fence_id }]);
        const submissionPending = yield* Effect.promise(() =>
          repository.setSubmissionPending(
            authorized,
            "settler-workspace-crash",
            "2026-08-28T00:15:02.000Z",
          ),
        );
        const applied = yield* Effect.promise(() =>
          repository.recordTransfer(
            submissionPending,
            "settler-workspace-crash",
            {
              providerActivityRef: "turnkey-workspace-funded",
              txHash: `0x${"d".repeat(64)}` as EvmTransactionHash,
              submittedAt: "2026-08-28T00:15:02.000Z",
            },
            "2026-08-28T00:15:02.000Z",
          ),
        );
        expect(applied).toMatchObject({ state: "transfer-applied" });

        const siblingSettlementId = "settlement-sibling-independent" as SettlementId;
        yield* Effect.promise(() =>
          pool.query(
            `INSERT INTO cloud_usage_settlement_attempt (
               workspace_id, settlement_id, thread_id, state, trigger_kind, wallet_id,
               authorization_id, wallet_address, treasury_address, first_pricing_sequence,
               last_pricing_sequence, accrual_count, upstream_delta_micro_usdc,
               markup_delta_micro_usdc, total_delta_micro_usdc, request_fingerprint,
               created_at, updated_at
             ) VALUES ($1,$2,$3,'reconciliation-required','sandbox-paused',$4,$5,$6,$7,
               2,2,1,100,5,105,$8,$9,$9)`,
            [
              workspaceId,
              siblingSettlementId,
              siblingThreadId,
              walletId,
              authorizationId,
              walletAddress,
              treasuryAddress,
              NodeCrypto.createHash("sha256").update(siblingSettlementId).digest("hex"),
              "2026-08-28T00:15:02.000Z",
            ],
          ),
        );
        yield* Effect.promise(() =>
          pool.query(
            `INSERT INTO cloud_usage_billing_fence (
               workspace_id, thread_id, fence_id, episode, settlement_id, reason,
               state, created_at, updated_at, paused_at
             ) VALUES ($1,$2,'sibling-independent-fence',2,$3,
               'provider-outcome-uncertain','paused',$4,$4,$4)`,
            [workspaceId, siblingThreadId, siblingSettlementId, "2026-08-28T00:15:02.000Z"],
          ),
        );

        const recovered = yield* settlementService(
          pool,
          chain,
          signer(),
          runtime.runtime,
          "settler-workspace-recover-after-crash",
          "2026-08-28T00:16:03.000Z",
        ).recoverPending();
        expect(recovered.finalized).toBe(1);
        const funded = yield* Effect.promise(() => repository.get(workspaceId, settlementId));
        expect(funded?.state).toBe("finalized");
        expect(
          (yield* Effect.promise(() =>
            pool.query(
              `SELECT 1 FROM cloud_usage_workspace_billing_fence
                  WHERE workspace_id = $1 AND state = 'active'`,
              [workspaceId],
            ),
          )).rowCount,
        ).toBe(0);
        expect(
          (yield* Effect.promise(() =>
            pool.query<{ readonly fence_id: string }>(
              `SELECT fence_id FROM cloud_usage_billing_fence
                  WHERE workspace_id = $1 AND state <> 'cleared'`,
              [workspaceId],
            ),
          )).rows,
        ).toEqual([{ fence_id: "sibling-independent-fence" }]);
      }),
    ),
);

it.effect("keeps concurrent workspace obligations independent until each cause is recovered", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const siblingThreadId = "settlement-thread-concurrent" as ThreadId;
      const siblingEnvironmentId = "settlement-environment-concurrent" as EnvironmentId;
      const siblingSandboxId = "settlement-sandbox-concurrent" as SandboxId;
      yield* Effect.promise(() =>
        pool.query(
          `INSERT INTO cloud_thread (workspace_id, thread_id, environment_id)
             VALUES ($1,$2,$3)`,
          [workspaceId, siblingThreadId, siblingEnvironmentId],
        ),
      );
      yield* Effect.promise(() =>
        pool.query(
          `INSERT INTO cloud_e2b_sandbox_identity (
               workspace_id, reservation_id, thread_id, environment_id, project_id, revision_id,
               repository_identity, workspace_directory, sandbox_id, provider_handle, state,
               provider_template_id, provider_build_id, requested_at, activated_at, updated_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11,$12,$13,$13,$13)`,
          [
            workspaceId,
            "settlement-reservation-concurrent",
            siblingThreadId,
            siblingEnvironmentId,
            projectId,
            "settlement-revision-concurrent",
            { canonicalKey: "github.com/jarrodwatts/agentsin-cloud" },
            "/workspace/agentsin-cloud",
            siblingSandboxId,
            "e2b-settlement-sandbox-concurrent",
            "agentsin-cloud-settlement",
            "22222222-2222-4222-8222-222222222222",
            "2026-08-28T00:00:00.000Z",
          ],
        ),
      );
      const first = evidence("concurrent-workspace-low", 1, 4_500, "4");
      const second = evidence("concurrent-workspace-policy", 1, 4_750, "5");
      yield* accrue(pool, new Map([[first.evidenceId, first]]), first, "concurrent-low-v1");
      yield* accrue(
        pool,
        new Map([[second.evidenceId, second]]),
        second,
        "concurrent-policy-v1",
        "2026-08-28T00:06:00.000Z",
        {
          threadId: siblingThreadId,
          environmentId: siblingEnvironmentId,
          sandboxId: siblingSandboxId,
        },
      );
      const repository = makePostgresUsageSettlementRepository(pool);
      const attempts = yield* Effect.promise(() =>
        repository.claimReady({
          processorId: "settler-concurrent-workspace",
          now: "2026-08-28T00:15:00.000Z",
          leaseExpiresAt: "2026-08-28T00:16:00.000Z",
          limit: 2,
          workspaceId,
        }),
      );
      expect(attempts).toHaveLength(2);
      const lowAttempt = attempts.find((attempt) => attempt.threadId === threadId)!;
      const policyAttempt = attempts.find((attempt) => attempt.threadId === siblingThreadId)!;
      const [lowPending, policyPending] = yield* Effect.promise(() =>
        Promise.all([
          repository.setSubmissionPending(
            lowAttempt,
            "settler-concurrent-workspace",
            "2026-08-28T00:15:00.000Z",
          ),
          repository.setSubmissionPending(
            policyAttempt,
            "settler-concurrent-workspace",
            "2026-08-28T00:15:00.000Z",
          ),
        ]),
      );
      yield* Effect.promise(() =>
        Promise.all([
          repository.markLowBalancePausePending(
            lowPending,
            "settler-concurrent-workspace",
            undefined,
            "provider-insufficient-balance",
            "2026-08-28T00:15:01.000Z",
          ),
          repository.closeProviderAttemptNotApplied(
            policyPending,
            "settler-concurrent-workspace",
            undefined,
            "wallet-policy-denied",
            "2026-08-28T00:15:01.000Z",
            "2026-08-28T00:15:06.000Z",
          ),
        ]),
      );
      const runtime = makeRuntime();
      const chain = makeChain();
      const service = settlementService(
        pool,
        chain,
        signer(),
        runtime.runtime,
        "settler-concurrent-workspace",
        "2026-08-28T00:15:02.000Z",
      );
      expect((yield* service.recoverPending()).billingPaused).toBe(4);
      expect(
        (yield* Effect.promise(() =>
          pool.query<{ readonly reason: string; readonly settlement_id: string }>(
            `SELECT reason, settlement_id FROM cloud_usage_workspace_billing_fence
                WHERE workspace_id = $1 AND state = 'active' ORDER BY reason`,
            [workspaceId],
          ),
        )).rows,
      ).toEqual([
        { reason: "insufficient-balance", settlement_id: lowAttempt.settlementId },
        { reason: "provider-definitive-failure", settlement_id: policyAttempt.settlementId },
      ]);

      chain.setSubmit({
        status: "applied",
        providerActivityRef: "turnkey-concurrent-low-recovered",
        txHash: `0x${"4".repeat(64)}` as EvmTransactionHash,
        submittedAt: "2026-08-28T00:15:03.000Z",
      });
      const recoveredLow = yield* settlementService(
        pool,
        chain,
        signer(),
        runtime.runtime,
        "settler-concurrent-low-recovery",
        "2026-08-28T00:15:03.000Z",
      ).retryLowBalance(workspaceId, lowAttempt.settlementId);
      expect(recoveredLow.state).toBe("finalized");
      expect(chain.submits()).toBe(1);
      expect(
        (yield* Effect.promise(() =>
          pool.query<{ readonly reason: string; readonly settlement_id: string }>(
            `SELECT reason, settlement_id FROM cloud_usage_workspace_billing_fence
                WHERE workspace_id = $1 AND state = 'active'`,
            [workspaceId],
          ),
        )).rows,
      ).toEqual([
        {
          reason: "provider-definitive-failure",
          settlement_id: policyAttempt.settlementId,
        },
      ]);
      const ordinaryRecovery = yield* settlementService(
        pool,
        chain,
        signer(),
        runtime.runtime,
        "settler-concurrent-ordinary-recovery",
        "2026-08-28T00:15:10.000Z",
      ).recoverPending();
      expect(ordinaryRecovery.claimed).toBe(0);
      expect(chain.submits()).toBe(1);
      expect(
        yield* Effect.promise(() => repository.get(workspaceId, policyAttempt.settlementId)),
      ).toMatchObject({ state: "retry-waiting" });
      expect(
        (yield* Effect.promise(() =>
          pool.query(
            `SELECT 1 FROM cloud_usage_billing_fence
                WHERE workspace_id = $1 AND settlement_id = $2
                  AND reason = 'provider-definitive-failure' AND state = 'paused'`,
            [workspaceId, policyAttempt.settlementId],
          ),
        )).rowCount,
      ).toBe(1);
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
      expect((yield* service.recoverPending()).billingPaused).toBe(1);
      expect(chain.submits()).toBe(1);
      expect(runtime.pauses()).toBe(3);
      expect(new Set(runtime.requestIds()).size).toBe(1);
      expect(
        (yield* Effect.promise(() =>
          makePostgresUsageSettlementRepository(pool).get(workspaceId, settlementId),
        ))?.state,
      ).toBe("low-balance-paused");
    }),
  ),
);

it.effect("bounds definitive retries with a new auditable provider generation", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const first = evidence("bounded-retry", 1, 6_000, "8");
      yield* accrue(pool, new Map([[first.evidenceId, first]]), first, "bounded-retry-v1");
      const chain = makeChain();
      chain.setSubmit({
        status: "notApplied",
        providerActivityRef: "turnkey-bounded-not-applied",
      });
      const runtime = makeRuntime();
      const firstService = settlementService(
        pool,
        chain,
        signer(),
        runtime.runtime,
        "settler-first",
      );
      const firstSweep = yield* firstService.settleReady({
        trigger: "sandbox-paused",
        workspaceId,
        threadId,
      });
      expect(firstSweep).toMatchObject({ claimed: 1, finalized: 0, billingPaused: 1 });
      expect(chain.submits()).toBe(1);
      const settlementId = yield* Effect.promise(() => onlySettlementId(pool));
      const waiting = yield* Effect.promise(() =>
        makePostgresUsageSettlementRepository(pool).get(workspaceId, settlementId),
      );
      expect(waiting).toMatchObject({ state: "retry-waiting", providerAttemptGeneration: 2 });

      expect(
        Exit.isFailure(
          yield* Effect.exit(
            settlementService(
              pool,
              chain,
              signer(),
              runtime.runtime,
              "settler-too-early",
              "2026-08-28T00:15:04.999Z",
            ).retryProviderFailure(workspaceId, settlementId),
          ),
        ),
      ).toBe(true);
      expect(chain.submits()).toBe(1);

      chain.setSubmit({
        status: "applied",
        providerActivityRef: "turnkey-bounded-retry-2",
        txHash: `0x${"b".repeat(64)}` as EvmTransactionHash,
        submittedAt: "2026-08-28T00:15:05.000Z",
      });
      yield* Effect.promise(() =>
        makePostgresUsageSettlementRepository(pool).claimProviderFailureRetry(
          workspaceId,
          settlementId,
          "settler-provider-crash",
          "2026-08-28T00:15:05.000Z",
          "2026-08-28T00:15:06.000Z",
        ),
      );
      const finalized = yield* settlementService(
        pool,
        chain,
        signer(),
        runtime.runtime,
        "settler-second",
        "2026-08-28T00:15:07.000Z",
      ).retryProviderFailure(workspaceId, settlementId);
      expect(finalized.state).toBe("finalized");
      expect(chain.submits()).toBe(2);
      expect(new Set(chain.submitKeys()).size).toBe(2);
      const history = yield* Effect.promise(() =>
        pool.query<{ readonly generation: number; readonly state: string }>(
          `SELECT generation, state FROM cloud_usage_settlement_provider_attempt
            WHERE workspace_id = $1 AND settlement_id = $2 ORDER BY generation`,
          [workspaceId, settlementId],
        ),
      );
      expect(history.rows).toEqual([
        { generation: 1, state: "not-applied" },
        { generation: 2, state: "applied" },
      ]);
    }),
  ),
);

it.effect("keeps workspace and later provider obligations separate", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const first = evidence("cross-reason", 1, 6_500, "0");
      yield* accrue(pool, new Map([[first.evidenceId, first]]), first, "cross-reason-v1");
      const chain = makeChain();
      chain.setSubmit({ status: "notApplied" });
      const runtime = makeRuntime();
      yield* settlementService(
        pool,
        chain,
        signer(),
        runtime.runtime,
        "settler-cross-provider",
      ).settleReady({ trigger: "sandbox-paused", workspaceId, threadId });
      const settlementId = yield* Effect.promise(() => onlySettlementId(pool));
      chain.setSubmit({ status: "insufficientBalance" });
      const low = yield* settlementService(
        pool,
        chain,
        signer(),
        runtime.runtime,
        "settler-cross-low",
        "2026-08-28T00:15:05.000Z",
      ).retryProviderFailure(workspaceId, settlementId);
      expect(low.state).toBe("low-balance-paused");
      const activeAfterLow = yield* Effect.promise(() =>
        pool.query<{ readonly fence_id: string; readonly reason: string; readonly state: string }>(
          `SELECT fence_id, reason, state FROM cloud_usage_billing_fence
            WHERE workspace_id = $1 AND thread_id = $2 AND state <> 'cleared'
            ORDER BY reason`,
          [workspaceId, threadId],
        ),
      );
      expect(activeAfterLow.rows).toHaveLength(2);
      expect(activeAfterLow.rows[0]).toMatchObject({
        reason: "insufficient-balance",
        state: "paused",
      });
      expect(activeAfterLow.rows[1]).toMatchObject({
        reason: "provider-definitive-failure",
        state: "paused",
      });

      chain.setSubmit({ status: "notApplied" });
      const providerAgain = yield* settlementService(
        pool,
        chain,
        signer(),
        runtime.runtime,
        "settler-cross-provider-again",
        "2026-08-28T00:15:06.000Z",
      ).retryLowBalance(workspaceId, settlementId);
      expect(providerAgain.state).toBe("retry-waiting");
      const activeAfterProvider = yield* Effect.promise(() =>
        pool.query<{
          readonly fence_id: string;
          readonly reason: string;
          readonly workspace_fence_id: string | null;
        }>(
          `SELECT fence_id, reason, workspace_fence_id FROM cloud_usage_billing_fence
            WHERE workspace_id = $1 AND thread_id = $2 AND state <> 'cleared'`,
          [workspaceId, threadId],
        ),
      );
      expect(activeAfterProvider.rows).toHaveLength(2);
      expect(activeAfterProvider.rows).toContainEqual({
        fence_id: activeAfterLow.rows[0]!.fence_id,
        reason: "insufficient-balance",
        workspace_fence_id: expect.any(String),
      });
      expect(activeAfterProvider.rows).toContainEqual({
        fence_id: expect.not.stringMatching(activeAfterLow.rows[0]!.fence_id),
        reason: "provider-definitive-failure",
        workspace_fence_id: null,
      });
      const events = yield* Effect.promise(() =>
        pool.query<{ readonly reason: string }>(
          `SELECT reason FROM cloud_usage_billing_fence_event
            WHERE workspace_id = $1 AND thread_id = $2 ORDER BY recorded_at, fence_id, sequence`,
          [workspaceId, threadId],
        ),
      );
      expect(events.rows.map((row) => row.reason)).toEqual([
        "provider-definitive-failure",
        "insufficient-balance",
        "provider-definitive-failure",
      ]);

      const repository = makePostgresUsageSettlementRepository(pool);
      const authorized = yield* Effect.promise(() =>
        repository.claimProviderFailureRetry(
          workspaceId,
          settlementId,
          "settler-cross-crash",
          "2026-08-28T00:16:00.000Z",
          "2026-08-28T00:17:00.000Z",
        ),
      );
      expect(
        (yield* Effect.promise(() =>
          pool.query<{ readonly reason: string }>(
            `SELECT reason FROM cloud_usage_billing_recovery_authorization
              WHERE workspace_id = $1 AND settlement_id = $2 ORDER BY reason`,
            [workspaceId, settlementId],
          ),
        )).rows,
      ).toEqual([{ reason: "insufficient-balance" }, { reason: "provider-definitive-failure" }]);
      const pending = yield* Effect.promise(() =>
        repository.setSubmissionPending(
          authorized,
          "settler-cross-crash",
          "2026-08-28T00:16:00.000Z",
        ),
      );
      const applied = yield* Effect.promise(() =>
        repository.recordTransfer(
          pending,
          "settler-cross-crash",
          {
            providerActivityRef: "turnkey-cross-crash-applied",
            txHash: `0x${"3".repeat(64)}` as EvmTransactionHash,
            submittedAt: "2026-08-28T00:16:00.000Z",
          },
          "2026-08-28T00:16:00.000Z",
        ),
      );
      expect(applied.state).toBe("transfer-applied");
      const submitsBeforeCrashRecovery = chain.submits();
      expect(
        (yield* settlementService(
          pool,
          chain,
          signer(),
          runtime.runtime,
          "settler-cross-after-crash",
          "2026-08-28T00:17:00.000Z",
        ).recoverPending()).finalized,
      ).toBe(1);
      expect(chain.submits()).toBe(submitsBeforeCrashRecovery);
      expect(yield* Effect.promise(() => repository.get(workspaceId, settlementId))).toMatchObject({
        state: "finalized",
        receipt: expect.any(Object),
      });
      expect(
        (yield* Effect.promise(() =>
          pool.query(
            `SELECT 1 FROM cloud_usage_billing_fence
              WHERE workspace_id = $1 AND thread_id = $2 AND state <> 'cleared'
                AND (settlement_id = $3 OR recovery_settlement_id = $3)`,
            [workspaceId, threadId, settlementId],
          ),
        )).rowCount,
      ).toBe(0);
    }),
  ),
);

it.effect("inspects an uncertain transfer after authorization expiry without rebinding", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const first = evidence("expired-after-submit", 1, 6_750, "7");
      yield* accrue(pool, new Map([[first.evidenceId, first]]), first, "expired-after-submit-v1");
      const chain = makeChain();
      chain.setSubmit({ status: "unknown", providerActivityRef: "turnkey-expired-unknown" });
      const runtime = makeRuntime();
      yield* settlementService(
        pool,
        chain,
        signer(),
        runtime.runtime,
        "settler-expired-submit",
      ).settleReady({ trigger: "sandbox-paused", workspaceId, threadId });
      const settlementId = yield* Effect.promise(() => onlySettlementId(pool));
      yield* Effect.promise(() =>
        pool.query(
          `UPDATE cloud_wallet_delegated_authorization SET state = 'revoked', updated_at = $2
            WHERE workspace_id = $1 AND authorization_id = $3`,
          [workspaceId, "2026-08-28T00:15:01.000Z", authorizationId],
        ),
      );
      chain.setInspect({
        status: "applied",
        providerActivityRef: "turnkey-expired-unknown",
        txHash: `0x${"f".repeat(64)}` as EvmTransactionHash,
        submittedAt: "2026-08-28T00:15:00.000Z",
      });
      const finalized = yield* settlementService(
        pool,
        chain,
        signer(),
        runtime.runtime,
        "settler-expired-inspect",
        "2026-08-28T00:15:05.000Z",
      ).retryProviderFailure(workspaceId, settlementId);
      expect(finalized).toMatchObject({
        state: "finalized",
        authorizationId,
        authorizationGeneration: 1,
      });
      expect(chain.submits()).toBe(1);
      expect(chain.inspections()).toBe(2);
    }),
  ),
);

it.effect("revalidates authorization immediately before the first provider generation", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const first = evidence("revoked-before-provider", 1, 6_800, "6");
      yield* accrue(
        pool,
        new Map([[first.evidenceId, first]]),
        first,
        "revoked-before-provider-v1",
      );
      const repository = makePostgresUsageSettlementRepository(pool);
      const [claimed] = yield* Effect.promise(() =>
        repository.claimReady({
          processorId: "settler-auth-race",
          now: "2026-08-28T00:15:00.000Z",
          leaseExpiresAt: "2026-08-28T00:16:00.000Z",
          limit: 1,
          trigger: "sandbox-paused",
          workspaceId,
          threadId,
        }),
      );
      expect(claimed).toBeDefined();
      yield* Effect.promise(() =>
        pool.query(
          `UPDATE cloud_wallet_delegated_authorization SET state = 'revoked', updated_at = $2
            WHERE workspace_id = $1 AND authorization_id = $3`,
          [workspaceId, "2026-08-28T00:15:00.500Z", authorizationId],
        ),
      );
      const held = yield* Effect.promise(() =>
        repository.setSubmissionPending(claimed!, "settler-auth-race", "2026-08-28T00:15:01.000Z"),
      );
      expect(held).toMatchObject({
        state: "reserved",
        failureCode: "authorization-unavailable",
      });
      expect(
        (yield* Effect.promise(() =>
          pool.query(
            `SELECT count(*)::integer AS count
                 FROM cloud_usage_settlement_provider_attempt WHERE workspace_id = $1`,
            [workspaceId],
          ),
        )).rows[0],
      ).toEqual({ count: 0 });
      const runtime = makeRuntime();
      const sweep = yield* settlementService(
        pool,
        makeChain(),
        signer(),
        runtime.runtime,
        "settler-auth-race",
        "2026-08-28T00:15:02.000Z",
      ).settleReady({ trigger: "sandbox-paused", workspaceId, threadId });
      expect(sweep).toMatchObject({ claimed: 0, billingPaused: 1 });
      expect(runtime.requestIds()).toHaveLength(1);
    }),
  ),
);

it.effect("rebinds only after an uncertain transfer is definitively not applied", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const first = evidence("rebind-after-not-applied", 1, 6_900, "a");
      yield* accrue(
        pool,
        new Map([[first.evidenceId, first]]),
        first,
        "rebind-after-not-applied-v1",
      );
      const chain = makeChain();
      chain.setSubmit({ status: "unknown", providerActivityRef: "turnkey-rebind-unknown" });
      const runtime = makeRuntime();
      yield* settlementService(
        pool,
        chain,
        signer(),
        runtime.runtime,
        "settler-rebind-submit",
      ).settleReady({ trigger: "sandbox-paused", workspaceId, threadId });
      const settlementId = yield* Effect.promise(() => onlySettlementId(pool));
      yield* Effect.promise(() =>
        pool.query(
          `UPDATE cloud_wallet_delegated_authorization SET state = 'revoked', updated_at = $2
            WHERE workspace_id = $1 AND authorization_id = $3`,
          [workspaceId, "2026-08-28T00:15:01.000Z", authorizationId],
        ),
      );
      expect(
        yield* Effect.promise(() =>
          makePostgresUsageSettlementRepository(pool).get(workspaceId, settlementId),
        ),
      ).toMatchObject({
        state: "reconciliation-required",
        providerAttemptGeneration: 1,
        providerActivityRef: "turnkey-rebind-unknown",
      });
      chain.setInspect({ status: "notApplied", providerActivityRef: "turnkey-rebind-unknown" });
      expect(
        yield* Effect.promise(() =>
          pool.query(
            `SELECT state, provider_activity_ref FROM cloud_usage_settlement_provider_attempt
              WHERE workspace_id = $1 AND settlement_id = $2 AND generation = 1`,
            [workspaceId, settlementId],
          ),
        ),
      ).toMatchObject({
        rows: [{ state: "unknown", provider_activity_ref: "turnkey-rebind-unknown" }],
      });
      const waiting = yield* settlementService(
        pool,
        chain,
        signer(),
        runtime.runtime,
        "settler-rebind-inspect",
        "2026-08-28T00:15:05.000Z",
      ).retryProviderFailure(workspaceId, settlementId);
      expect(waiting).toMatchObject({
        state: "retry-waiting",
        authorizationGeneration: 1,
        providerAttemptGeneration: 2,
      });
      const wrongRecoveryCause = yield* Effect.exit(
        settlementService(
          pool,
          chain,
          signer(),
          runtime.runtime,
          "settler-rebind-expired-generation",
          "2026-08-28T00:15:10.000Z",
        ).retryProviderFailure(workspaceId, settlementId),
      );
      expect(Exit.isFailure(wrongRecoveryCause)).toBe(true);
      expect(
        yield* Effect.promise(() =>
          makePostgresUsageSettlementRepository(pool).get(workspaceId, settlementId),
        ),
      ).toMatchObject({
        state: "retry-waiting",
        providerAttemptGeneration: 2,
      });
      expect(
        (yield* Effect.promise(() =>
          pool.query(
            `SELECT generation FROM cloud_usage_settlement_provider_attempt
                WHERE workspace_id = $1 AND settlement_id = $2 ORDER BY generation`,
            [workspaceId, settlementId],
          ),
        )).rows,
      ).toEqual([{ generation: 1 }]);
      expect(
        (yield* settlementService(
          pool,
          chain,
          signer(),
          runtime.runtime,
          "settler-rebind-pause-authorization",
          "2026-08-28T00:15:11.000Z",
        ).recoverPending()).billingPaused,
      ).toBe(0);
      yield* Effect.promise(() => addAuthorization(pool, "settlement-authorization-rebound"));
      yield* Effect.promise(() =>
        makePostgresUsageSettlementRepository(pool).claimAuthorizationRecovery(
          workspaceId,
          threadId,
          "settler-authorization-crash",
          "2026-08-28T00:15:15.000Z",
          "2026-08-28T00:15:16.000Z",
        ),
      );
      chain.setSubmit({
        status: "applied",
        providerActivityRef: "turnkey-rebound-applied",
        txHash: `0x${"1".repeat(64)}` as EvmTransactionHash,
        submittedAt: "2026-08-28T00:15:06.000Z",
      });
      chain.setInspect({ status: "notApplied" });
      const rebound = yield* settlementService(
        pool,
        chain,
        signer(),
        runtime.runtime,
        "settler-rebind-submit-new",
        "2026-08-28T00:15:17.000Z",
      ).retryAuthorization(workspaceId, threadId);
      expect(rebound).toMatchObject({
        state: "finalized",
        authorizationId: "settlement-authorization-rebound",
        authorizationGeneration: 2,
        providerAttemptGeneration: 2,
      });
      expect(chain.submits()).toBe(2);
      expect(new Set(chain.submitKeys()).size).toBe(2);
      const bindings = yield* Effect.promise(() =>
        pool.query<{ readonly generation: number; readonly authorization_id: string }>(
          `SELECT generation, authorization_id
             FROM cloud_usage_settlement_authorization_binding
            WHERE workspace_id = $1 AND settlement_id = $2 ORDER BY generation`,
          [workspaceId, settlementId],
        ),
      );
      expect(bindings.rows).toEqual([
        { generation: 1, authorization_id: authorizationId },
        { generation: 2, authorization_id: "settlement-authorization-rebound" },
      ]);
    }),
  ),
);

it.effect("keeps the full-candidate amount trigger when a charge cap splits the batch", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        pool.query(
          `UPDATE cloud_wallet_delegated_authorization
              SET per_charge_limit_micro_usdc = 200000 WHERE workspace_id = $1`,
          [workspaceId],
        ),
      );
      const first = evidence("split-one", 1, 150_000, "1");
      const second = {
        ...evidence("split-two", 1, 300_000, "2"),
        intervalStart: "2026-08-28T00:05:00.000Z",
        intervalEnd: "2026-08-28T00:10:00.000Z",
        observedAt: "2026-08-28T00:11:00.000Z",
      };
      const records = new Map([
        [first.evidenceId, first],
        [second.evidenceId, second],
      ]);
      yield* accrue(pool, records, first, "split-one-v1");
      yield* accrue(pool, records, second, "split-two-v1", "2026-08-28T00:11:00.000Z");
      const chain = makeChain();
      chain.setSubmit({
        status: "applied",
        providerActivityRef: "turnkey-split-1",
        txHash: `0x${"c".repeat(64)}` as EvmTransactionHash,
        submittedAt: "2026-08-28T00:06:00.000Z",
      });
      const runtime = makeRuntime();
      const result = yield* settlementService(
        pool,
        chain,
        signer(),
        runtime.runtime,
        "settler-split",
        "2026-08-28T00:06:00.000Z",
      ).settleReady();
      expect(result).toMatchObject({ claimed: 1, finalized: 1 });
      const id = yield* Effect.promise(() => onlySettlementId(pool));
      const stored = yield* Effect.promise(() =>
        makePostgresUsageSettlementRepository(pool).get(workspaceId, id),
      );
      expect(stored).toMatchObject({ trigger: "amount-threshold", totalDeltaMicroUsdc: 157_500 });
      expect(stored?.postings).toHaveLength(1);
    }),
  ),
);

it.effect("canonicalizes transaction hashes and fences a case-variant reuse", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const first = evidence("canonical-first", 1, 7_000, "3");
      yield* accrue(pool, new Map([[first.evidenceId, first]]), first, "canonical-first-v1");
      const chain = makeChain();
      const uppercaseTx = `0x${"D".repeat(64)}` as EvmTransactionHash;
      chain.setSubmit({
        status: "applied",
        providerActivityRef: "turnkey-canonical-first",
        txHash: uppercaseTx,
        submittedAt: "2026-08-28T00:15:00.000Z",
      });
      const runtime = makeRuntime();
      yield* settlementService(
        pool,
        chain,
        signer(),
        runtime.runtime,
        "settler-canonical-first",
      ).settleReady({ trigger: "sandbox-paused", workspaceId, threadId });
      const firstId = yield* Effect.promise(() => onlySettlementId(pool));
      expect(
        (yield* Effect.promise(() =>
          makePostgresUsageSettlementRepository(pool).get(workspaceId, firstId),
        ))?.txHash,
      ).toBe(uppercaseTx.toLowerCase());

      const second = {
        ...evidence("canonical-second", 1, 15_000, "4"),
        intervalStart: "2026-08-28T00:05:00.000Z",
        intervalEnd: "2026-08-28T00:10:00.000Z",
        observedAt: "2026-08-28T00:11:00.000Z",
      };
      yield* accrue(
        pool,
        new Map([[second.evidenceId, second]]),
        second,
        "canonical-second-v1",
        "2026-08-28T00:11:00.000Z",
      );
      chain.setSubmit({
        status: "applied",
        providerActivityRef: "turnkey-canonical-second",
        txHash: uppercaseTx,
        submittedAt: "2026-08-28T00:16:00.000Z",
      });
      const secondSweep = yield* settlementService(
        pool,
        chain,
        signer(),
        runtime.runtime,
        "settler-canonical-second",
        "2026-08-28T00:16:00.000Z",
      ).settleReady({ trigger: "sandbox-paused", workspaceId, threadId });
      expect(secondSweep).toMatchObject({ finalized: 0, reconciliationRequired: 1 });
      const receipts = yield* Effect.promise(() =>
        pool.query<{ readonly count: string }>(
          "SELECT count(*)::text AS count FROM cloud_usage_settlement_receipt",
        ),
      );
      expect(receipts.rows[0]?.count).toBe("1");
      expect(yield* Effect.promise(() => settlementIds(pool))).toHaveLength(2);
    }),
  ),
);

it.effect("fences a reused provider activity returned with insufficient balance", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const first = evidence("low-reuse-first", 1, 7_100, "4");
      yield* accrue(pool, new Map([[first.evidenceId, first]]), first, "low-reuse-first-v1");
      const chain = makeChain();
      chain.setSubmit({
        status: "applied",
        providerActivityRef: "turnkey-low-reused-activity",
        txHash: `0x${"4".repeat(64)}` as EvmTransactionHash,
        submittedAt: "2026-08-28T00:15:00.000Z",
      });
      const runtime = makeRuntime();
      yield* settlementService(
        pool,
        chain,
        signer(),
        runtime.runtime,
        "settler-low-reuse-first",
      ).settleReady({ trigger: "sandbox-paused", workspaceId, threadId });

      const second = {
        ...evidence("low-reuse-second", 1, 7_200, "5"),
        intervalStart: "2026-08-28T00:05:00.000Z",
        intervalEnd: "2026-08-28T00:10:00.000Z",
        observedAt: "2026-08-28T00:11:00.000Z",
      };
      yield* accrue(
        pool,
        new Map([[second.evidenceId, second]]),
        second,
        "low-reuse-second-v1",
        "2026-08-28T00:11:00.000Z",
      );
      chain.setSubmit({
        status: "insufficientBalance",
        providerActivityRef: "turnkey-low-reused-activity",
      });
      const result = yield* settlementService(
        pool,
        chain,
        signer(),
        runtime.runtime,
        "settler-low-reuse-second",
        "2026-08-28T00:16:00.000Z",
      ).settleReady({ trigger: "sandbox-paused", workspaceId, threadId });
      expect(result).toMatchObject({
        lowBalancePaused: 0,
        reconciliationRequired: 1,
        billingPaused: 1,
      });
      expect(runtime.pauses()).toBe(1);
    }),
  ),
);

it.effect("serializes concurrent canonical transfer identity collisions into a durable hold", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const secondThreadId = "settlement-thread-race-two" as ThreadId;
      yield* Effect.promise(() =>
        pool.query(
          "INSERT INTO cloud_thread (workspace_id, thread_id, environment_id) VALUES ($1,$2,$3)",
          [workspaceId, secondThreadId, "settlement-environment-race-two"],
        ),
      );
      const firstSettlementId = "settlement-canonical-race-one" as SettlementId;
      const secondSettlementId = "settlement-canonical-race-two" as SettlementId;
      for (const [position, settlementId, settlementThreadId, owner] of [
        [1, firstSettlementId, threadId, "settler-race-one"],
        [2, secondSettlementId, secondThreadId, "settler-race-two"],
      ] as const) {
        yield* Effect.promise(() =>
          pool.query(
            `INSERT INTO cloud_usage_settlement_attempt (
               workspace_id, settlement_id, thread_id, state, trigger_kind, wallet_id,
               authorization_id, wallet_address, treasury_address, first_pricing_sequence,
               last_pricing_sequence, accrual_count, upstream_delta_micro_usdc,
               markup_delta_micro_usdc, total_delta_micro_usdc, request_fingerprint,
               processing_owner, processing_lease_expires_at, created_at, updated_at
             ) VALUES ($1,$2,$3,'submission-pending','sandbox-paused',$4,$5,$6,$7,
               $8,$8,1,100,5,105,$9,$10,$11,$12,$12)`,
            [
              workspaceId,
              settlementId,
              settlementThreadId,
              walletId,
              authorizationId,
              walletAddress,
              treasuryAddress,
              position,
              NodeCrypto.createHash("sha256").update(settlementId).digest("hex"),
              owner,
              "2026-08-28T00:16:00.000Z",
              "2026-08-28T00:15:00.000Z",
            ],
          ),
        );
        yield* Effect.promise(() =>
          pool.query(
            `INSERT INTO cloud_usage_settlement_authorization_binding (
               workspace_id, settlement_id, generation, wallet_id, authorization_id,
               wallet_address, treasury_address, bound_at
             ) VALUES ($1,$2,1,$3,$4,$5,$6,$7)`,
            [
              workspaceId,
              settlementId,
              walletId,
              authorizationId,
              walletAddress,
              treasuryAddress,
              "2026-08-28T00:15:00.000Z",
            ],
          ),
        );
        yield* Effect.promise(() =>
          pool.query(
            `INSERT INTO cloud_usage_settlement_provider_attempt (
               workspace_id, settlement_id, generation, idempotency_key, state, created_at, updated_at
             ) VALUES ($1,$2,1,$3,'submission-pending',$4,$4)`,
            [
              workspaceId,
              settlementId,
              NodeCrypto.createHash("sha256").update(`provider:${settlementId}`).digest("hex"),
              "2026-08-28T00:15:00.000Z",
            ],
          ),
        );
      }
      const repository = makePostgresUsageSettlementRepository(pool);
      const [firstAttempt, secondAttempt] = yield* Effect.promise(() =>
        Promise.all([
          repository.get(workspaceId, firstSettlementId),
          repository.get(workspaceId, secondSettlementId),
        ]),
      );
      expect(firstAttempt).toBeDefined();
      expect(secondAttempt).toBeDefined();
      const sharedTransfer = {
        providerActivityRef: "turnkey-concurrent-canonical-identity",
        txHash: `0x${"c".repeat(64)}` as EvmTransactionHash,
        submittedAt: "2026-08-28T00:15:00.000Z",
      };
      const outcomes = yield* Effect.promise(() =>
        Promise.all([
          repository.recordTransfer(
            firstAttempt!,
            "settler-race-one",
            sharedTransfer,
            "2026-08-28T00:15:01.000Z",
          ),
          repository.recordTransfer(
            secondAttempt!,
            "settler-race-two",
            sharedTransfer,
            "2026-08-28T00:15:01.000Z",
          ),
        ]),
      );
      expect(outcomes.map((outcome) => outcome.state).sort()).toEqual([
        "reconciliation-required",
        "transfer-applied",
      ]);
      expect(
        (yield* Effect.promise(() =>
          pool.query(
            `SELECT count(*)::integer AS count FROM cloud_usage_billing_fence
                WHERE workspace_id = $1 AND state <> 'cleared'`,
            [workspaceId],
          ),
        )).rows[0],
      ).toEqual({ count: 1 });
    }),
  ),
);

it.effect("holds create and resume through two separate authorization-loss episodes", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        pool.query(
          `INSERT INTO cloud_thread_lifecycle_attempt (
             workspace_id, thread_id, attempt_id, idempotency_key, request_fingerprint,
             environment_id, environment_revision_id, environment_revision_hash, project_id,
             provider_instance_id, provider_driver, repository_identity, workspace_directory,
             sandbox_id, provider_handle, worker_id, sealed_bootstrap_ref,
             state, is_current, created_at, updated_at, completed_at
           ) VALUES ($1,$2,'runtime-attempt','runtime-key',$3,$4,'runtime-revision',$5,$6,
             'provider-instance','codex',$7::jsonb,'/workspace/agentsin-cloud',$8,$9,
             'runtime-worker','sealed://runtime','ready',true,$10,$10,$10)`,
          [
            workspaceId,
            threadId,
            "e".repeat(64),
            environmentId,
            "f".repeat(64),
            projectId,
            { canonicalKey: "github.com/jarrodwatts/agentsin-cloud" },
            sandboxId,
            "e2b-settlement-sandbox",
            "2026-08-28T00:00:00.000Z",
          ],
        ),
      );
      yield* Effect.promise(() =>
        pool.query(
          `UPDATE cloud_thread_runtime
              SET state = 'paused', idle_since = NULL, transition_id = 'pause:runtime:1',
                  transition_kind = 'pause', transition_started_at = $3,
                  route_fenced_at = $3, credentials_revoked_at = $3,
                  credentials_scrubbed_at = $3, provider_completed_at = $3, updated_at = $3
            WHERE workspace_id = $1 AND thread_id = $2`,
          [workspaceId, threadId, "2026-08-28T00:05:00.000Z"],
        ),
      );
      const first = evidence("auth-loss-one", 1, 9_000, "5");
      yield* accrue(pool, new Map([[first.evidenceId, first]]), first, "auth-loss-one-v1");
      yield* Effect.promise(() =>
        pool.query(
          `UPDATE cloud_wallet_delegated_authorization
              SET state = 'revoked', updated_at = $2
            WHERE workspace_id = $1 AND authorization_id = $3`,
          [workspaceId, "2026-08-28T00:14:00.000Z", authorizationId],
        ),
      );
      const runtime = makeRuntime();
      const chain = makeChain();
      const service = settlementService(pool, chain, signer(), runtime.runtime, "settler-auth-one");
      const blocked = yield* service.settleReady({
        trigger: "sandbox-paused",
        workspaceId,
        threadId,
      });
      expect(blocked).toMatchObject({ claimed: 0, billingPaused: 1 });
      expect(yield* Effect.promise(() => settlementIds(pool))).toHaveLength(0);

      expect(
        Exit.isFailure(
          yield* Effect.exit(
            Effect.tryPromise(() =>
              pool.query(
                `UPDATE cloud_thread_runtime
                    SET state = 'resume_dispatched', generation = generation + 1,
                        transition_id = 'resume:runtime:2', transition_kind = 'resume',
                        transition_started_at = $3, updated_at = $3
                  WHERE workspace_id = $1 AND thread_id = $2`,
                [workspaceId, threadId, "2026-08-28T00:15:00.000Z"],
              ),
            ),
          ),
        ),
      ).toBe(true);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            Effect.tryPromise(() =>
              pool.query(
                `INSERT INTO cloud_thread_lifecycle_attempt (
                   workspace_id, thread_id, attempt_id, idempotency_key, request_fingerprint,
                   environment_id, environment_revision_id, environment_revision_hash, project_id,
                   provider_instance_id, provider_driver, repository_identity, workspace_directory,
                   state, is_current, created_at, updated_at
                 ) VALUES ($1,$2,'blocked-create','blocked-create-key',$3,$4,'revision-2',$5,$6,
                   'provider-instance','codex',$7::jsonb,'/workspace/agentsin-cloud',
                   'reserved',false,$8,$8)`,
                [
                  workspaceId,
                  threadId,
                  "a".repeat(64),
                  environmentId,
                  "b".repeat(64),
                  projectId,
                  { canonicalKey: "github.com/jarrodwatts/agentsin-cloud" },
                  "2026-08-28T00:15:00.000Z",
                ],
              ),
            ),
          ),
        ),
      ).toBe(true);

      yield* Effect.promise(() => addAuthorization(pool, "settlement-authorization-2"));
      chain.setSubmit({
        status: "applied",
        providerActivityRef: "turnkey-auth-recovery-one",
        txHash: `0x${"e".repeat(64)}` as EvmTransactionHash,
        submittedAt: "2026-08-28T00:15:00.000Z",
      });
      const recovered = yield* settlementService(
        pool,
        chain,
        signer(),
        runtime.runtime,
        "settler-auth-recover-one",
      ).retryAuthorization(workspaceId, threadId);
      expect(recovered).toMatchObject({
        state: "finalized",
        authorizationId: "settlement-authorization-2",
      });

      const second = {
        ...evidence("auth-loss-two", 1, 19_000, "6"),
        intervalStart: "2026-08-28T00:05:00.000Z",
        intervalEnd: "2026-08-28T00:10:00.000Z",
        observedAt: "2026-08-28T00:11:00.000Z",
      };
      yield* accrue(
        pool,
        new Map([[second.evidenceId, second]]),
        second,
        "auth-loss-two-v1",
        "2026-08-28T00:11:00.000Z",
      );
      yield* Effect.promise(() =>
        pool.query(
          `UPDATE cloud_wallet_delegated_authorization
              SET state = 'revoked', updated_at = $2
            WHERE workspace_id = $1 AND authorization_id = 'settlement-authorization-2'`,
          [workspaceId, "2026-08-28T00:16:00.000Z"],
        ),
      );
      expect(
        yield* settlementService(
          pool,
          chain,
          signer(),
          runtime.runtime,
          "settler-auth-two",
          "2026-08-28T00:16:00.000Z",
        ).settleReady({ trigger: "sandbox-paused", workspaceId, threadId }),
      ).toMatchObject({ claimed: 0, billingPaused: 1 });
      const episodes = yield* Effect.promise(() =>
        pool.query<{ readonly fence_id: string; readonly episode: number }>(
          `SELECT fence_id, episode FROM cloud_usage_billing_fence
            WHERE workspace_id = $1 AND thread_id = $2 ORDER BY episode`,
          [workspaceId, threadId],
        ),
      );
      expect(episodes.rows.map((row) => row.episode)).toEqual([1, 2, 3]);
      expect(new Set(episodes.rows.map((row) => row.fence_id)).size).toBe(3);
    }),
  ),
);
