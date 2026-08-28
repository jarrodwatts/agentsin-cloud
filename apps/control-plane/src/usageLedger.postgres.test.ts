// @effect-diagnostics nodeBuiltinImport:off -- PostgreSQL tests own an isolated random schema.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type {
  MicroUsdc,
  SandboxId,
  UsageAccrualId,
  UsageEvidenceId,
  UsageEvidenceSha256,
  UsageSampleId,
  VerifiedE2bUsageEvidence,
  WorkspaceId,
} from "@t3tools/contracts/cloud";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { Pool } from "pg";

import { makePostgresUsageLedgerRepository } from "./usageLedgerRepository.ts";
import {
  makeUsageMeteringService,
  UsageMeteringServiceError,
  VerifiedE2bUsageSourceError,
  type UsageMeteringRequest,
  type VerifiedE2bUsageSource,
} from "./usageMeteringService.ts";

const postgresUrl = process.env.AGENTSIN_TEST_POSTGRES_URL;
const workspaceId = "77777777-7777-4777-8777-777777777777" as WorkspaceId;
const environmentId = "usage-environment" as EnvironmentId;
const threadId = "usage-thread" as ThreadId;
const projectId = "usage-project" as ProjectId;
const sandboxA = "usage-sandbox-a" as SandboxId;
const sandboxB = "usage-sandbox-b" as SandboxId;
const now = "2026-08-28T00:30:00.000Z";

const fixture = (url: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const schema = `agentsin_h4_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
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
        "0014-usage-ledger.sql",
      ]) {
        await pool.query(
          await NodeFSP.readFile(new URL(`./migrations/${filename}`, import.meta.url), "utf8"),
        );
      }
      await pool.query(
        await NodeFSP.readFile(
          new URL("./migrations/0014-usage-ledger.sql", import.meta.url),
          "utf8",
        ),
      );
      await pool.query('INSERT INTO "user" (id) VALUES ($1)', ["usage-owner"]);
      await pool.query("INSERT INTO workspace (id, owner_user_id, name) VALUES ($1,$2,$3)", [
        workspaceId,
        "usage-owner",
        "Usage",
      ]);
      await pool.query(
        "INSERT INTO cloud_thread (workspace_id, thread_id, environment_id) VALUES ($1,$2,$3)",
        [workspaceId, threadId, environmentId],
      );
      await insertActiveSandbox(pool, sandboxA, "reservation-a");
      return { admin, pool, schema };
    }),
    ({ admin, pool, schema }) =>
      Effect.promise(async () => {
        await pool.end().catch(() => undefined);
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
        await admin.end().catch(() => undefined);
      }),
  );

const insertActiveSandbox = (pool: Pool, sandboxId: SandboxId, reservationId: string) =>
  pool.query(
    `INSERT INTO cloud_e2b_sandbox_identity (
       workspace_id, reservation_id, thread_id, environment_id, project_id, revision_id,
       repository_identity, workspace_directory, sandbox_id, provider_handle, state,
       requested_at, activated_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11,$11,$11)`,
    [
      workspaceId,
      reservationId,
      threadId,
      environmentId,
      projectId,
      "usage-revision",
      { canonicalKey: "github.com/jarrodwatts/agentsin-cloud" },
      "/workspace/agentsin-cloud",
      sandboxId,
      `e2b-${sandboxId}`,
      "2026-08-28T00:00:00.000Z",
    ],
  );

const withPostgres = (use: (pool: Pool) => Effect.Effect<void, UsageMeteringServiceError>) => {
  if (postgresUrl === undefined) return Effect.void;
  return Effect.scoped(Effect.flatMap(fixture(postgresUrl), ({ pool }) => use(pool)));
};

const evidence = (
  evidenceId: string,
  revision: number,
  intervalStart: string,
  intervalEnd: string,
  upstreamMicroUsdc: number,
  hashCharacter = "a",
): VerifiedE2bUsageEvidence => ({
  evidenceId: evidenceId as UsageEvidenceId,
  revision,
  infrastructureProvider: "e2b",
  verification: "e2b-authenticated-billing-record",
  payloadSha256: hashCharacter.repeat(64) as UsageEvidenceSha256,
  intervalStart,
  intervalEnd,
  upstreamMicroUsdc: upstreamMicroUsdc as MicroUsdc,
  observedAt: now,
});

const request = (
  evidenceValue: VerifiedE2bUsageEvidence,
  idempotencyKey: string,
  sandboxId = sandboxA,
): UsageMeteringRequest => ({
  workspaceId,
  environmentId,
  threadId,
  sandboxId,
  evidenceId: evidenceValue.evidenceId,
  intervalStart: evidenceValue.intervalStart,
  intervalEnd: evidenceValue.intervalEnd,
  idempotencyKey,
});

const serviceFor = (pool: Pool, source: VerifiedE2bUsageSource) =>
  makeUsageMeteringService({
    repository: makePostgresUsageLedgerRepository(pool),
    source,
    now: () => now,
    sampleId: (value) => `sample-${value.idempotencyKey}` as UsageSampleId,
    accrualId: (value) => `accrual-${value.idempotencyKey}` as UsageAccrualId,
  });

const sourceFor = (records: Map<string, VerifiedE2bUsageEvidence>) => {
  let reads = 0;
  const source: VerifiedE2bUsageSource = {
    read: (value) => {
      reads += 1;
      const record = records.get(value.evidenceId);
      return record === undefined
        ? Effect.fail(new VerifiedE2bUsageSourceError({ code: "notFound", retryable: false }))
        : Effect.succeed(record);
    },
  };
  return { source, reads: () => reads };
};

it.effect("posts one exact usage debit and returns duplicates without charging twice", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const first = evidence(
        "charge-a",
        1,
        "2026-08-28T00:00:00.000Z",
        "2026-08-28T00:05:00.000Z",
        1_010,
      );
      const source = sourceFor(new Map([[first.evidenceId, first]]));
      const service = serviceFor(pool, source.source);
      const input = request(first, "charge-a-once");
      const created = yield* service.accrue({ service: "e2b-usage-sampler", workspaceId }, input);
      const duplicate = yield* service.accrue({ service: "e2b-usage-sampler", workspaceId }, input);
      expect(created.disposition).toBe("created");
      expect(created.accrual).toMatchObject({
        upstreamMicroUsdc: 1_010,
        markupMicroUsdc: 51,
        totalMicroUsdc: 1_061,
        totalDeltaMicroUsdc: 1_061,
      });
      expect(duplicate).toEqual({ disposition: "duplicate", accrual: created.accrual });
      expect(source.reads()).toBe(1);

      const changedReplay = yield* Effect.exit(
        service.accrue(
          { service: "e2b-usage-sampler", workspaceId },
          { ...input, intervalStart: "2026-08-27T23:55:00.000Z" },
        ),
      );
      expect(Exit.isFailure(changedReplay)).toBe(true);
      expect(source.reads()).toBe(1);

      const rows = yield* Effect.promise(() =>
        Promise.all([
          pool.query<{ readonly count: number }>(
            "SELECT count(*)::int AS count FROM cloud_usage_sample",
          ),
          pool.query<{ readonly count: number }>(
            "SELECT count(*)::int AS count FROM cloud_usage_ledger_entry",
          ),
        ]),
      );
      expect(rows[0]!.rows[0]!.count).toBe(1);
      expect(rows[1]!.rows[0]!.count).toBe(1);
    }),
  ),
);

it.effect("rejects missing revisions and monetary overflow without appending a charge", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const skipped = evidence(
        "skipped-revision",
        2,
        "2026-08-28T00:00:00.000Z",
        "2026-08-28T00:05:00.000Z",
        1_000,
      );
      const overflow = evidence(
        "overflowing-charge",
        1,
        "2026-08-28T00:00:00.000Z",
        "2026-08-28T00:05:00.000Z",
        Number.MAX_SAFE_INTEGER,
        "b",
      );
      const service = serviceFor(
        pool,
        sourceFor(new Map([skipped, overflow].map((record) => [record.evidenceId, record]))).source,
      );
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            service.accrue(
              { service: "e2b-usage-sampler", workspaceId },
              request(skipped, "skipped-revision-once"),
            ),
          ),
        ),
      ).toBe(true);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            service.accrue(
              { service: "e2b-usage-sampler", workspaceId },
              request(overflow, "overflow-once"),
            ),
          ),
        ),
      ).toBe(true);
      const count = yield* Effect.promise(() =>
        pool.query<{ readonly count: number }>(
          "SELECT count(*)::int AS count FROM cloud_usage_ledger_entry",
        ),
      );
      expect(count.rows[0]!.count).toBe(0);
    }),
  ),
);

it.effect("rejects overlap and out-of-order samples while accepting an adjacent interval", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const first = evidence(
        "range-a",
        1,
        "2026-08-28T00:00:00.000Z",
        "2026-08-28T00:05:00.000Z",
        1_000,
      );
      const overlap = evidence(
        "range-overlap",
        1,
        "2026-08-28T00:04:00.000Z",
        "2026-08-28T00:06:00.000Z",
        500,
        "b",
      );
      const older = evidence(
        "range-older",
        1,
        "2026-08-27T23:50:00.000Z",
        "2026-08-27T23:55:00.000Z",
        500,
        "c",
      );
      const adjacent = evidence(
        "range-adjacent",
        1,
        "2026-08-28T00:05:00.000Z",
        "2026-08-28T00:10:00.000Z",
        500,
        "d",
      );
      const records = new Map(
        [first, overlap, older, adjacent].map((record) => [record.evidenceId, record]),
      );
      const service = serviceFor(pool, sourceFor(records).source);
      yield* service.accrue(
        { service: "e2b-usage-sampler", workspaceId },
        request(first, "range-a-once"),
      );
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            service.accrue(
              { service: "e2b-usage-sampler", workspaceId },
              request(overlap, "range-overlap-once"),
            ),
          ),
        ),
      ).toBe(true);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            service.accrue(
              { service: "e2b-usage-sampler", workspaceId },
              request(older, "range-older-once"),
            ),
          ),
        ),
      ).toBe(true);
      expect(
        (yield* service.accrue(
          { service: "e2b-usage-sampler", workspaceId },
          request(adjacent, "range-adjacent-once"),
        )).disposition,
      ).toBe("created");
    }),
  ),
);

it.effect("appends provider corrections and permits old-sandbox correction after replacement", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const records = new Map<string, VerifiedE2bUsageEvidence>();
      const source = sourceFor(records);
      const service = serviceFor(pool, source.source);
      const first = evidence(
        "corrected-charge",
        1,
        "2026-08-28T00:00:00.000Z",
        "2026-08-28T00:05:00.000Z",
        1_010,
      );
      records.set(first.evidenceId, first);
      yield* service.accrue(
        { service: "e2b-usage-sampler", workspaceId },
        request(first, "correction-v1"),
      );

      const correction = evidence(
        "corrected-charge",
        2,
        first.intervalStart,
        first.intervalEnd,
        1_000,
        "b",
      );
      records.set(correction.evidenceId, correction);
      const corrected = yield* service.accrue(
        { service: "e2b-usage-sampler", workspaceId },
        request(correction, "correction-v2"),
      );
      expect(corrected.accrual).toMatchObject({
        previousTotalMicroUsdc: 1_061,
        totalMicroUsdc: 1_050,
        totalDeltaMicroUsdc: -11,
        priorSampleId: "sample-correction-v1",
      });

      yield* Effect.promise(() =>
        pool.query(
          `UPDATE cloud_e2b_sandbox_identity
              SET state = 'destroyed', destroyed_at = $3, updated_at = $3
            WHERE workspace_id = $1 AND sandbox_id = $2`,
          [workspaceId, sandboxA, now],
        ),
      );
      yield* Effect.promise(() => insertActiveSandbox(pool, sandboxB, "reservation-b"));

      const staleNew = evidence(
        "stale-new-charge",
        1,
        "2026-08-28T00:05:00.000Z",
        "2026-08-28T00:10:00.000Z",
        100,
        "c",
      );
      records.set(staleNew.evidenceId, staleNew);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            service.accrue(
              { service: "e2b-usage-sampler", workspaceId },
              request(staleNew, "stale-new", sandboxA),
            ),
          ),
        ),
      ).toBe(true);

      const oldCorrection = evidence(
        "corrected-charge",
        3,
        first.intervalStart,
        first.intervalEnd,
        990,
        "d",
      );
      records.set(oldCorrection.evidenceId, oldCorrection);
      expect(
        (yield* service.accrue(
          { service: "e2b-usage-sampler", workspaceId },
          request(oldCorrection, "correction-v3", sandboxA),
        )).accrual.totalDeltaMicroUsdc,
      ).toBe(-10);

      const replacement = evidence(
        "replacement-charge",
        1,
        "2026-08-28T00:05:00.000Z",
        "2026-08-28T00:10:00.000Z",
        100,
        "e",
      );
      records.set(replacement.evidenceId, replacement);
      expect(
        (yield* service.accrue(
          { service: "e2b-usage-sampler", workspaceId },
          request(replacement, "replacement-first", sandboxB),
        )).disposition,
      ).toBe("created");
    }),
  ),
);

it.effect("serializes concurrent duplicate delivery and makes accounting rows immutable", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const first = evidence(
        "concurrent-charge",
        1,
        "2026-08-28T00:00:00.000Z",
        "2026-08-28T00:05:00.000Z",
        2_000,
      );
      const service = serviceFor(pool, sourceFor(new Map([[first.evidenceId, first]])).source);
      const input = request(first, "concurrent-once");
      const results = yield* Effect.all(
        [
          service.accrue({ service: "e2b-usage-sampler", workspaceId }, input),
          service.accrue({ service: "e2b-usage-sampler", workspaceId }, input),
        ],
        { concurrency: "unbounded" },
      );
      expect(results.map((result) => result.disposition).sort()).toEqual(["created", "duplicate"]);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            Effect.tryPromise(() =>
              pool.query(
                "UPDATE cloud_usage_ledger_entry SET total_micro_usdc = total_micro_usdc + 1",
              ),
            ),
          ),
        ),
      ).toBe(true);
      expect(
        Exit.isFailure(
          yield* Effect.exit(Effect.tryPromise(() => pool.query("DELETE FROM cloud_usage_sample"))),
        ),
      ).toBe(true);
    }),
  ),
);
