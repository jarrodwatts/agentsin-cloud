// @effect-diagnostics nodeBuiltinImport:off -- Real PostgreSQL coverage loads checked-in migrations into an isolated schema.
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttps from "node:https";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import type { AuthSessionId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  GitHubThreadWorkflowCommand,
  type GitHubRepositoryRef,
  type GitHubThreadBranchName,
  type GitObjectSha,
  type WorkspaceId,
} from "@t3tools/contracts/cloud";
import { WorkerGitHubTokenRedeemRequest, type WorkerInstanceId } from "@t3tools/contracts/worker";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Pool, type QueryResultRow } from "pg";

import { DatabaseError, type DatabaseService } from "./database.ts";
import {
  GitHubTokenLeaseError,
  makePostgresGitHubTokenLeaseBroker,
  type GitHubTokenLeaseBroker,
} from "./githubTokenLeaseBroker.ts";
import { makeGitHubWorkflowStore } from "./githubThreadWorkflowStore.ts";
import { makeGitHubWorkflowAuthority } from "./githubWorkflowAuthority.ts";
import { githubWorkerRouteBinding } from "./githubWorkerDispatcher.ts";
import {
  WorkerIdentityError,
  type ActiveWorkerLease,
  type WorkerIdentityService,
} from "./workerIdentity.ts";
import { createWorkerMtlsServer } from "./workerMtlsServer.ts";
import type { AuthenticatedWorkerPrincipal } from "./workerRelay.ts";
import type { WorkerRelay } from "./workerRelay.ts";

const postgresUrl = process.env.AGENTSIN_TEST_POSTGRES_URL;
const workspaceId = "66666666-6666-4666-8666-666666666666" as WorkspaceId;
const otherWorkspaceId = "77777777-7777-4777-8777-777777777777" as WorkspaceId;
const environmentId = "github-postgres-environment" as EnvironmentId;
const threadId = "github-postgres-thread" as ThreadId;
const instant = "2026-08-28T12:00:00.000Z";
const repository: GitHubRepositoryRef = {
  provider: "github",
  host: "github.com",
  installationId: "installation-42" as GitHubRepositoryRef["installationId"],
  owner: "jarrodwatts",
  name: "agentsin-cloud",
  canonicalKey: "github.com/jarrodwatts/agentsin-cloud",
};
const branchName = "agents/postgres-workflow-123456789abc" as GitHubThreadBranchName;
const baseSha = "a".repeat(40) as GitObjectSha;
const decodeCommand = Schema.decodeUnknownSync(GitHubThreadWorkflowCommand);
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeRedeemRequest = Schema.decodeUnknownSync(WorkerGitHubTokenRedeemRequest);

const branchCommand = (commandId: string, slug = "Postgres workflow") =>
  decodeCommand({
    type: "github.branch.create",
    commandId,
    workspaceId,
    environmentId,
    threadId,
    repository,
    approvalId: `approval-${commandId}`,
    requestedAt: instant,
    threadSlug: slug,
    baseSha,
  });

const checkpointCommand = (commandId: string) =>
  decodeCommand({
    type: "github.checkpoint.push",
    commandId,
    workspaceId,
    environmentId,
    threadId,
    repository,
    approvalId: `approval-${commandId}`,
    requestedAt: instant,
    message: "fix: verified checkpoint",
  });

const draftCommand = (commandId: string) =>
  decodeCommand({
    type: "github.pull-request.open-draft",
    commandId,
    workspaceId,
    environmentId,
    threadId,
    repository,
    approvalId: `approval-${commandId}`,
    requestedAt: instant,
    title: "Fix hosted workflow",
    body: "Verified by the cloud agent.",
    baseBranch: "main",
  });

const makeDatabase = (pool: Pool): DatabaseService => ({
  pool,
  query: <Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: ReadonlyArray<unknown> = [],
  ) =>
    Effect.tryPromise({
      try: async () => (await pool.query<Row>(text, [...values])).rows,
      catch: (cause) => new DatabaseError({ operation: text, cause }),
    }),
  ping: Effect.void,
});

const setWorkflowCommandAvailableAt = (pool: Pool, commandId: string, availableAt: string) =>
  Effect.promise(() =>
    pool.query(
      `UPDATE github_thread_workflow_outbox
          SET available_at = $3
        WHERE workspace_id = $1 AND command_id = $2`,
      [workspaceId, commandId, availableAt],
    ),
  ).pipe(Effect.asVoid);

const makeTestStore = (database: DatabaseService) => {
  const store = makeGitHubWorkflowStore(database);
  return {
    ...store,
    submit: (input: Omit<Parameters<typeof store.submit>[0], "actorUserId" | "authSessionId">) =>
      store.submit({
        ...input,
        actorUserId: "owner-a",
        authSessionId: "auth-session-postgres" as AuthSessionId,
      }),
  };
};

const withPostgres = <A, E, R>(use: (pool: Pool) => Effect.Effect<A, E, R>) => {
  if (!postgresUrl) return Effect.void;
  return Effect.scoped(
    Effect.acquireRelease(
      Effect.promise(async () => {
        const schema = `agentsin_c5_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
        const admin = new Pool({ connectionString: postgresUrl, max: 1 });
        await admin.query(`CREATE SCHEMA "${schema}"`);
        const pool = new Pool({
          connectionString: postgresUrl,
          max: 8,
          options: `-c search_path=${schema}`,
          connectionTimeoutMillis: 5_000,
          query_timeout: 10_000,
          statement_timeout: 10_000,
        });
        await pool.query('CREATE TABLE "user" (id text PRIMARY KEY)');
        for (const migration of [
          "0001-workspaces.sql",
          "0002-cloud-thread-store.sql",
          "0004-cloud-thread-lifecycle.sql",
          "0005-worker-mtls.sql",
          "0006-github-thread-workflow.sql",
          "0008-thread-route-generation.sql",
          "0009-github-worker-route-binding.sql",
        ]) {
          await pool.query(
            await NodeFSP.readFile(new URL(`./migrations/${migration}`, import.meta.url), "utf8"),
          );
        }
        await pool.query('INSERT INTO "user" (id) VALUES ($1), ($2)', ["owner-a", "owner-b"]);
        await pool.query(
          `INSERT INTO workspace (id, owner_user_id, name)
           VALUES ($1, 'owner-a', 'A'), ($2, 'owner-b', 'B')`,
          [workspaceId, otherWorkspaceId],
        );
        await pool.query(
          `INSERT INTO cloud_thread (workspace_id, thread_id, environment_id) VALUES ($1, $2, $3)`,
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
    ).pipe(Effect.flatMap(({ pool }) => use(pool))),
  );
};

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const tokenLeaseSanUri = "spiffe://agentsin.cloud/workers/github-token-lease";

interface TokenLeaseTlsFixture {
  readonly ca: Buffer;
  readonly serverCertificate: Buffer;
  readonly serverKey: Buffer;
  readonly clientCertificate: Buffer;
  readonly clientKey: Buffer;
  readonly clientFingerprint: string;
}

const runOpenSsl = (directory: string, args: ReadonlyArray<string>) =>
  execFile("openssl", [...args], { cwd: directory });

const generateTokenLeaseTlsFixture = async (directory: string): Promise<TokenLeaseTlsFixture> => {
  await runOpenSsl(directory, [
    "req",
    "-new",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=agents-in-cloud-test-ca",
    "-keyout",
    "ca.key",
    "-out",
    "ca.crt",
  ]);
  const signed = async (prefix: string, commonName: string, extensions: string) => {
    await runOpenSsl(directory, [
      "req",
      "-new",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-subj",
      `/CN=${commonName}`,
      "-keyout",
      `${prefix}.key`,
      "-out",
      `${prefix}.csr`,
    ]);
    await NodeFSP.writeFile(NodePath.join(directory, `${prefix}.ext`), extensions);
    await runOpenSsl(directory, [
      "x509",
      "-req",
      "-in",
      `${prefix}.csr`,
      "-CA",
      "ca.crt",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-sha256",
      "-days",
      "1",
      "-extfile",
      `${prefix}.ext`,
      "-out",
      `${prefix}.crt`,
    ]);
  };
  await signed(
    "server",
    "localhost",
    "subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n",
  );
  await signed(
    "client",
    "trusted-worker",
    `subjectAltName=URI:${tokenLeaseSanUri}\nextendedKeyUsage=clientAuth\n`,
  );
  const read = (name: string) => NodeFSP.readFile(NodePath.join(directory, name));
  const [ca, serverCertificate, serverKey, clientCertificate, clientKey] = await Promise.all([
    read("ca.crt"),
    read("server.crt"),
    read("server.key"),
    read("client.crt"),
    read("client.key"),
  ]);
  return {
    ca,
    serverCertificate,
    serverKey,
    clientCertificate,
    clientKey,
    clientFingerprint: new NodeCrypto.X509Certificate(clientCertificate).fingerprint256
      .replaceAll(":", "")
      .toLowerCase(),
  };
};

const withTokenLeaseTlsFixture = <A, E, R>(
  use: (fixture: TokenLeaseTlsFixture) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.tryPromise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "aic-c5-token-mtls-"))),
    (directory) =>
      Effect.tryPromise(() => generateTokenLeaseTlsFixture(directory)).pipe(Effect.flatMap(use)),
    (directory) =>
      Effect.tryPromise(() => NodeFSP.rm(directory, { recursive: true, force: true })).pipe(
        Effect.ignore,
      ),
  );

const withPostgresTokenLeaseTls = <A, E, R>(
  use: (pool: Pool, fixture: TokenLeaseTlsFixture) => Effect.Effect<A, E, R>,
) => withPostgres((pool) => withTokenLeaseTlsFixture((fixture) => use(pool, fixture)));

const withTokenLeaseMtlsBoundary = <A, E, R>(input: {
  readonly fixture: TokenLeaseTlsFixture;
  readonly principal: AuthenticatedWorkerPrincipal;
  readonly broker: Pick<GitHubTokenLeaseBroker, "redeem">;
  readonly use: (
    post: (body: unknown) => Promise<{ status: number; body: unknown }>,
  ) => Effect.Effect<A, E, R>;
}) =>
  Effect.acquireUseRelease(
    Effect.tryPromise(async () => {
      const identities = {
        clock: { now: Effect.succeed("2026-08-28T12:35:00.000Z") },
        authenticateCertificate: (request: {
          readonly fingerprint: string;
          readonly sanUris: ReadonlyArray<string>;
        }) =>
          request.fingerprint.replaceAll(":", "").toLowerCase() ===
            input.principal.certificateFingerprint && request.sanUris.includes(tokenLeaseSanUri)
            ? Effect.succeed(input.principal)
            : Effect.fail(
                new WorkerIdentityError({ code: "mismatch", operation: "token-mtls-principal" }),
              ),
      } as unknown as WorkerIdentityService;
      const relay = {
        limits: { maxFrameBytes: 64 * 1024 },
        open: () => Effect.die("relay is not used by the token redemption test"),
        claimCommand: () => Effect.die("claim is not used by the token redemption test"),
      } as unknown as WorkerRelay;
      const boundary = createWorkerMtlsServer({
        tls: {
          cert: input.fixture.serverCertificate,
          key: input.fixture.serverKey,
          ca: input.fixture.ca,
          minVersion: "TLSv1.3",
        },
        identities,
        relay,
        githubTokenLeases: input.broker,
      });
      await new Promise<void>((resolve, reject) => {
        boundary.server.once("error", reject);
        boundary.server.listen(0, "127.0.0.1", resolve);
      });
      const address = boundary.server.address();
      if (address === null || typeof address === "string") throw new Error("missing mTLS port");
      const post = (body: unknown) =>
        new Promise<{ status: number; body: unknown }>((resolve, reject) => {
          const encoded = Buffer.from(JSON.stringify(body));
          const request = NodeHttps.request(
            {
              host: "127.0.0.1",
              servername: "localhost",
              port: address.port,
              path: "/api/v1/worker-github-token-leases/redeem",
              method: "POST",
              ca: input.fixture.ca,
              cert: input.fixture.clientCertificate,
              key: input.fixture.clientKey,
              headers: {
                "content-type": "application/json",
                "content-length": encoded.byteLength,
              },
            },
            (response) => {
              const chunks: Array<Buffer> = [];
              response.on("data", (chunk: Buffer) => chunks.push(chunk));
              response.once("error", reject);
              response.once("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                resolve({
                  status: response.statusCode ?? 0,
                  body: text.length === 0 ? undefined : (JSON.parse(text) as unknown),
                });
              });
            },
          );
          request.once("error", reject);
          request.end(encoded);
        });
      return { boundary, post };
    }),
    ({ post }) => input.use(post),
    ({ boundary }) => Effect.promise(() => boundary.close()).pipe(Effect.ignore),
  );

it.effect("atomically coalesces duplicate commands and records one external receipt", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const store = makeTestStore(makeDatabase(pool));
      yield* store.registerRepository({
        workspaceId,
        repository,
        repositoryId: 42,
        canPush: true,
        canPullRequests: true,
      });
      const workflowCommand = branchCommand("command-postgres-1");
      const submissions = yield* Effect.all(
        [
          store.submit({
            idempotencyKey: "idem-postgres-1",
            command: workflowCommand,
            branchName,
          }),
          store.submit({
            idempotencyKey: "idem-postgres-1",
            command: workflowCommand,
            branchName,
          }),
        ],
        { concurrency: "unbounded" },
      );
      expect(submissions.map((result) => result.disposition).sort()).toEqual([
        "accepted",
        "duplicate",
      ]);
      yield* setWorkflowCommandAvailableAt(pool, workflowCommand.commandId, instant);

      const claim = yield* store.claim({
        workspaceId,
        commandId: workflowCommand.commandId,
        now: instant,
        leaseExpiresAt: "2026-08-28T12:01:00.000Z",
      });
      expect(claim?.attemptCount).toBe(1);
      expect(
        yield* store.claimNext({
          workspaceId,
          now: instant,
          leaseExpiresAt: "2026-08-28T12:01:00.000Z",
        }),
      ).toBeUndefined();
      yield* store.complete({
        workspaceId,
        commandId: workflowCommand.commandId,
        attemptCount: claim!.attemptCount,
        completion: { type: "branch", remoteHeadSha: baseSha },
        occurredAt: instant,
      });
      yield* store.complete({
        workspaceId,
        commandId: workflowCommand.commandId,
        attemptCount: claim!.attemptCount,
        completion: { type: "branch", remoteHeadSha: baseSha },
        occurredAt: instant,
      });
      expect(
        yield* store.claim({
          workspaceId,
          commandId: workflowCommand.commandId,
          now: "2026-08-28T12:02:00.000Z",
          leaseExpiresAt: "2026-08-28T12:03:00.000Z",
        }),
      ).toBeUndefined();
      const view = yield* store.get(workspaceId, threadId);
      expect(view?.remoteHeadSha).toBe(baseSha);
      expect(view?.events).toHaveLength(1);
      expect(yield* store.get(otherWorkspaceId, threadId)).toBeUndefined();
      const receipts = yield* Effect.promise(() =>
        pool.query(
          "SELECT COUNT(*)::int AS count FROM github_thread_workflow_receipt WHERE workspace_id = $1",
          [workspaceId],
        ),
      );
      expect(receipts.rows[0]?.count).toBe(1);

      const checkpoint = checkpointCommand("command-postgres-checkpoint");
      yield* store.submit({ idempotencyKey: "idem-checkpoint", command: checkpoint });
      yield* setWorkflowCommandAvailableAt(pool, checkpoint.commandId, instant);
      const firstCheckpointClaim = yield* store.claimNext({
        workspaceId,
        now: instant,
        leaseExpiresAt: "2026-08-28T12:01:00.000Z",
      });
      expect(firstCheckpointClaim?.command.commandId).toBe(checkpoint.commandId);
      expect(firstCheckpointClaim?.preparedSha).toBeUndefined();
      expect(firstCheckpointClaim?.expectedParentSha).toBe(baseSha);
      expect(firstCheckpointClaim?.actorUserId).toBe("owner-a");
      const preparedSha = "b".repeat(40) as GitObjectSha;
      yield* store.savePreparedSha(
        workspaceId,
        checkpoint.commandId,
        preparedSha,
        firstCheckpointClaim!.attemptCount,
      );
      expect(
        yield* store.claim({
          workspaceId,
          commandId: checkpoint.commandId,
          now: "2026-08-28T12:00:30.000Z",
          leaseExpiresAt: "2026-08-28T12:02:00.000Z",
        }),
      ).toBeUndefined();
      const recoveredCheckpoint = yield* store.claim({
        workspaceId,
        commandId: checkpoint.commandId,
        now: "2026-08-28T12:01:01.000Z",
        leaseExpiresAt: "2026-08-28T12:02:00.000Z",
      });
      expect(recoveredCheckpoint?.preparedSha).toBe(preparedSha);
      expect(recoveredCheckpoint?.attemptCount).toBe(2);
      const staleCompletion = yield* Effect.flip(
        store.complete({
          workspaceId,
          commandId: checkpoint.commandId,
          attemptCount: 1,
          completion: { type: "checkpoint", remoteHeadSha: preparedSha },
          occurredAt: "2026-08-28T12:01:01.500Z",
        }),
      );
      expect(staleCompletion.code).toBe("stateConflict");
      yield* store.complete({
        workspaceId,
        commandId: checkpoint.commandId,
        attemptCount: recoveredCheckpoint!.attemptCount,
        completion: { type: "checkpoint", remoteHeadSha: preparedSha },
        occurredAt: "2026-08-28T12:01:02.000Z",
      });

      const draft = draftCommand("command-postgres-draft");
      yield* store.submit({ idempotencyKey: "idem-draft", command: draft });
      yield* setWorkflowCommandAvailableAt(pool, draft.commandId, instant);
      yield* store.claim({
        workspaceId,
        commandId: draft.commandId,
        now: "2026-08-28T12:02:00.000Z",
        leaseExpiresAt: "2026-08-28T12:03:00.000Z",
      });
      const draftCompletion = {
        type: "draftPullRequest" as const,
        pullRequest: {
          number: 7,
          url: "https://github.com/jarrodwatts/agentsin-cloud/pull/7",
          draft: true as const,
        },
      };
      yield* store.complete({
        workspaceId,
        commandId: draft.commandId,
        attemptCount: 1,
        completion: draftCompletion,
        occurredAt: "2026-08-28T12:02:01.000Z",
      });
      yield* store.complete({
        workspaceId,
        commandId: draft.commandId,
        attemptCount: 1,
        completion: draftCompletion,
        occurredAt: "2026-08-28T12:02:01.000Z",
      });

      const retry = checkpointCommand("command-postgres-retry");
      yield* store.submit({ idempotencyKey: "idem-retry", command: retry });
      yield* setWorkflowCommandAvailableAt(pool, retry.commandId, instant);
      yield* store.claim({
        workspaceId,
        commandId: retry.commandId,
        now: "2026-08-28T12:02:10.000Z",
        leaseExpiresAt: "2026-08-28T12:03:10.000Z",
      });
      yield* store.fail({
        workspaceId,
        commandId: retry.commandId,
        attemptCount: 1,
        code: "rateLimited",
        summary: "GitHub asked the worker to retry later",
        retryable: true,
        conflict: false,
        occurredAt: "2026-08-28T12:02:11.000Z",
        retryAt: "2026-08-28T12:05:00.000Z",
      });
      expect(
        yield* store.claim({
          workspaceId,
          commandId: retry.commandId,
          now: "2026-08-28T12:04:59.000Z",
          leaseExpiresAt: "2026-08-28T12:06:00.000Z",
        }),
      ).toBeUndefined();
      const retried = yield* store.claim({
        workspaceId,
        commandId: retry.commandId,
        now: "2026-08-28T12:05:01.000Z",
        leaseExpiresAt: "2026-08-28T12:06:01.000Z",
      });
      expect(retried?.attemptCount).toBe(2);
      const retrySha = "c".repeat(40) as GitObjectSha;
      yield* store.complete({
        workspaceId,
        commandId: retry.commandId,
        attemptCount: retried!.attemptCount,
        completion: { type: "checkpoint", remoteHeadSha: retrySha },
        occurredAt: "2026-08-28T12:05:02.000Z",
      });

      const conflict = checkpointCommand("command-postgres-conflict");
      yield* store.submit({ idempotencyKey: "idem-stale", command: conflict });
      yield* setWorkflowCommandAvailableAt(pool, conflict.commandId, instant);
      yield* store.claim({
        workspaceId,
        commandId: conflict.commandId,
        now: "2026-08-28T12:03:00.000Z",
        leaseExpiresAt: "2026-08-28T12:04:00.000Z",
      });
      yield* store.fail({
        workspaceId,
        commandId: conflict.commandId,
        attemptCount: 1,
        code: "staleRemote",
        summary: "Remote contains a user commit",
        retryable: false,
        conflict: true,
        occurredAt: "2026-08-28T12:03:01.000Z",
      });
      const paused = yield* store.get(workspaceId, threadId);
      expect(paused?.status).toBe("paused-conflict");
      expect(paused?.events.at(-1)?.type).toBe("github.conflict");
      const receiptCounts = yield* Effect.promise(() =>
        pool.query(
          `SELECT command_id, COUNT(*)::int AS count
           FROM github_thread_workflow_receipt
          WHERE workspace_id = $1 GROUP BY command_id`,
          [workspaceId],
        ),
      );
      expect(receiptCounts.rows.every((row) => row.count === 1)).toBe(true);
    }),
  ),
);

it.effect("loads authoritative approvals and the server-owned active sandbox binding", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const authority = makeGitHubWorkflowAuthority(makeDatabase(pool));
      const approvalId = "approval-authoritative";
      const payload = {
        approvalId,
        workspaceId,
        threadId,
        repository,
        actions: ["pushCheckpoint"],
        decidedByUserId: "owner-a",
        decidedBy: "auth-session-postgres",
        approvedAt: instant,
        expiresAt: "2026-08-28T13:00:00.000Z",
      };
      yield* Effect.promise(() =>
        pool.query(
          `INSERT INTO cloud_thread_approval
             (workspace_id, thread_id, request_id, state, payload, requested_at, resolved_at)
           VALUES ($1, $2, $3, 'approved', $4::jsonb, $5, $5)`,
          [workspaceId, threadId, approvalId, encodeJson(payload), instant],
        ),
      );
      yield* Effect.promise(() =>
        pool.query(
          `INSERT INTO cloud_e2b_sandbox_identity
             (workspace_id, reservation_id, thread_id, environment_id, project_id,
              revision_id, repository_identity, workspace_directory, sandbox_id,
              provider_handle, state, requested_at, activated_at)
           VALUES ($1, 'reservation-authority', $2, $3, 'project-1', 'revision-1',
                   $4::jsonb, '/workspace/project', 'sandbox-authority',
                   'provider-authority', 'active', $5, $5)`,
          [
            workspaceId,
            threadId,
            environmentId,
            encodeJson({
              canonicalKey: repository.canonicalKey,
              locator: {
                source: "git-remote",
                remoteName: "origin",
                remoteUrl: "https://github.com/jarrodwatts/agentsin-cloud.git",
              },
            }),
            instant,
          ],
        ),
      );

      const approved = yield* authority.validateApproval({
        approvalId,
        workspaceId,
        threadId,
        repository,
        action: "pushCheckpoint",
        actorUserId: "owner-a",
        authSessionId: "auth-session-postgres" as AuthSessionId,
        now: "2026-08-28T12:30:00.000Z",
      });
      expect(approved.approval.approvalId).toBe(approvalId);
      expect(
        yield* authority.resolveWorkerTarget({ workspaceId, threadId, repository }),
      ).toMatchObject({ sandboxId: "sandbox-authority", environmentId });

      const actorDenied = yield* Effect.flip(
        authority.validateApproval({
          approvalId,
          workspaceId,
          threadId,
          repository,
          action: "pushCheckpoint",
          actorUserId: "owner-b",
          authSessionId: "auth-session-postgres" as AuthSessionId,
          now: "2026-08-28T12:30:00.000Z",
        }),
      );
      expect(actorDenied.code).toBe("identityMismatch");

      const expired = yield* Effect.flip(
        authority.validateApproval({
          approvalId,
          workspaceId,
          threadId,
          repository,
          action: "pushCheckpoint",
          actorUserId: "owner-a",
          authSessionId: "auth-session-postgres" as AuthSessionId,
          now: "2026-08-28T13:00:00.000Z",
        }),
      );
      expect(expired.code).toBe("expired");

      const repositoryDenied = yield* Effect.flip(
        authority.validateApproval({
          approvalId,
          workspaceId,
          threadId,
          repository: {
            ...repository,
            name: "different-repository",
            canonicalKey: "github.com/jarrodwatts/different-repository",
          },
          action: "pushCheckpoint",
          actorUserId: "owner-a",
          authSessionId: "auth-session-postgres" as AuthSessionId,
          now: "2026-08-28T12:30:00.000Z",
        }),
      );
      expect(repositoryDenied.code).toBe("identityMismatch");

      const threadDenied = yield* Effect.flip(
        authority.validateApproval({
          approvalId,
          workspaceId,
          threadId: "thread-other" as ThreadId,
          repository,
          action: "pushCheckpoint",
          actorUserId: "owner-a",
          authSessionId: "auth-session-postgres" as AuthSessionId,
          now: "2026-08-28T12:30:00.000Z",
        }),
      );
      expect(threadDenied.code).toBe("notFound");

      yield* Effect.promise(() =>
        pool.query(
          `UPDATE cloud_thread_approval SET state = 'rejected'
            WHERE workspace_id = $1 AND request_id = $2`,
          [workspaceId, approvalId],
        ),
      );
      const revoked = yield* Effect.flip(
        authority.validateApproval({
          approvalId,
          workspaceId,
          threadId,
          repository,
          action: "pushCheckpoint",
          actorUserId: "owner-a",
          authSessionId: "auth-session-postgres" as AuthSessionId,
          now: "2026-08-28T12:30:00.000Z",
        }),
      );
      expect(revoked.code).toBe("notApproved");
    }),
  ),
);

it.effect("redeems an approval-bound token once and rejects revocation or expiry before use", () =>
  withPostgresTokenLeaseTls((pool, fixture) =>
    Effect.gen(function* () {
      const database = makeDatabase(pool);
      const authority = makeGitHubWorkflowAuthority(database);
      const approvalId = "approval-token-lease";
      const approvalPayload = (expiresAt: string) => ({
        approvalId,
        workspaceId,
        threadId,
        repository,
        actions: ["pushCheckpoint"],
        decidedByUserId: "owner-a",
        decidedBy: "auth-session-postgres",
        approvedAt: instant,
        expiresAt,
      });
      yield* Effect.promise(() =>
        pool.query(
          `INSERT INTO cloud_thread_approval
             (workspace_id, thread_id, request_id, state, payload, requested_at,
              resolved_at, updated_at)
           VALUES ($1, $2, $3, 'approved', $4::jsonb, $5, $5, $5)`,
          [
            workspaceId,
            threadId,
            approvalId,
            encodeJson(approvalPayload("2026-08-28T13:00:00.000Z")),
            instant,
          ],
        ),
      );
      yield* Effect.promise(() =>
        pool.query(
          `INSERT INTO cloud_e2b_sandbox_identity
             (workspace_id, reservation_id, thread_id, environment_id, project_id,
              revision_id, repository_identity, workspace_directory, sandbox_id,
              provider_handle, state, requested_at, activated_at)
           VALUES ($1, 'reservation-token-lease', $2, $3, 'project-1', 'revision-1',
                   $4::jsonb, '/workspace/project', 'sandbox-token-lease',
                   'provider-token-lease', 'active', $5, $5)`,
          [
            workspaceId,
            threadId,
            environmentId,
            encodeJson({
              canonicalKey: repository.canonicalKey,
              locator: {
                source: "git-remote",
                remoteName: "origin",
                remoteUrl: "https://github.com/jarrodwatts/agentsin-cloud.git",
              },
            }),
            instant,
          ],
        ),
      );

      const workerLease = {
        workspaceId,
        threadId,
        environmentId,
        environmentRevisionId: "revision-1",
        sandboxId: "sandbox-token-lease",
        reservationId: "reservation-token-lease",
        workerId: "worker-token-lease",
        providerInstanceId: "codex_personal",
        providerDriver: "codex",
        certificateFingerprint: fixture.clientFingerprint,
        certificateGeneration: 1,
        leaseGeneration: 1,
        routeGeneration: 1,
        processInstanceId: "process-token-lease",
        state: "connected",
        connectedAt: instant,
        lastSeenAt: instant,
        heartbeatSequence: 0,
        confirmedEventCursor: -1,
      } as ActiveWorkerLease;
      yield* Effect.promise(async () => {
        await pool.query(
          `INSERT INTO cloud_worker_certificate
             (certificate_fingerprint, workspace_id, thread_id, environment_id,
              environment_revision_id, sandbox_id, reservation_id, worker_id,
              provider_instance_id, provider_driver, identity_binding, san_uri,
              public_key_spki_sha256, certificate_generation, not_before, not_after)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                   'binding-token-lease', 'spiffe://agentsin.cloud/workers/token-lease',
                   'spki-token-lease', $11, $12, '2026-08-29T12:00:00.000Z')`,
          [
            workerLease.certificateFingerprint,
            workspaceId,
            threadId,
            environmentId,
            workerLease.environmentRevisionId,
            workerLease.sandboxId,
            workerLease.reservationId,
            workerLease.workerId,
            workerLease.providerInstanceId,
            workerLease.providerDriver,
            workerLease.certificateGeneration,
            instant,
          ],
        );
        await pool.query(
          `INSERT INTO cloud_thread_route_generation (workspace_id, thread_id, generation)
           VALUES ($1, $2, $3)`,
          [workspaceId, threadId, workerLease.routeGeneration],
        );
        await pool.query(
          `INSERT INTO cloud_worker_lease
             (workspace_id, sandbox_id, thread_id, environment_id,
              environment_revision_id, reservation_id, worker_id, provider_instance_id,
              provider_driver, certificate_fingerprint, certificate_generation,
              lease_generation, route_generation, process_instance_id, state,
              connected_at, last_seen_at, heartbeat_sequence, confirmed_event_cursor)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                   $13, $14, 'connected', $15, $15, 0, -1)`,
          [
            workspaceId,
            workerLease.sandboxId,
            threadId,
            environmentId,
            workerLease.environmentRevisionId,
            workerLease.reservationId,
            workerLease.workerId,
            workerLease.providerInstanceId,
            workerLease.providerDriver,
            workerLease.certificateFingerprint,
            workerLease.certificateGeneration,
            workerLease.leaseGeneration,
            workerLease.routeGeneration,
            workerLease.processInstanceId,
            instant,
          ],
        );
      });

      const sealed = new Map<string, Redacted.Redacted<string>>();
      let vaultRedemptions = 0;
      const broker = makePostgresGitHubTokenLeaseBroker({
        database,
        vault: {
          seal: ({ leaseRef, token }) =>
            Effect.sync(() => {
              if (!sealed.has(leaseRef)) sealed.set(leaseRef, token);
              return `vault:${leaseRef}`;
            }),
          redeem: ({ leaseRef }) => {
            const token = sealed.get(leaseRef);
            if (token === undefined) {
              return Effect.fail(new GitHubTokenLeaseError({ code: "used", retryable: false }));
            }
            return Effect.sync(() => {
              sealed.delete(leaseRef);
              vaultRedemptions += 1;
              return token;
            });
          },
        },
      });
      const principal = workerLease as AuthenticatedWorkerPrincipal;
      const validated = yield* authority.validateApproval({
        approvalId,
        workspaceId,
        threadId,
        repository,
        action: "pushCheckpoint",
        actorUserId: "owner-a",
        authSessionId: "auth-session-postgres" as AuthSessionId,
        now: "2026-08-28T12:30:00.000Z",
      });
      const revokedLease = yield* broker.seal({
        token: {
          token: Redacted.make("token-revoked-before-redemption"),
          expiresAt: "2026-08-28T12:50:00.000Z",
        },
        workerLease,
        operationId: "operation-revoked",
        commandId: "command-revoked",
        approvalId,
        approvalGeneration: validated.generation as never,
        approvalAction: "pushCheckpoint",
        approvalExpiresAt: validated.approval.expiresAt,
        actorUserId: "owner-a",
        authSessionId: "auth-session-postgres" as AuthSessionId,
        repository,
      });
      const redeemRequest = (input: {
        readonly leaseRef: string;
        readonly operationId: string;
        readonly commandId: string;
        readonly generation: string;
        readonly expiresAt: string;
      }) =>
        decodeRedeemRequest({
          schemaVersion: 1,
          leaseRef: input.leaseRef,
          operationId: input.operationId,
          commandId: input.commandId,
          workspaceId,
          environmentId,
          threadId,
          sandboxId: principal.sandboxId,
          repository,
          approvalId,
          approvalGeneration: input.generation,
          approvalAction: "pushCheckpoint",
          leaseExpiresAt: input.expiresAt,
          routeBinding: githubWorkerRouteBinding(workerLease),
        });
      const forgedRepository = yield* Effect.flip(
        broker.redeem(
          principal,
          decodeRedeemRequest({
            schemaVersion: 1,
            leaseRef: revokedLease.leaseRef,
            operationId: "operation-revoked",
            commandId: "command-revoked",
            workspaceId,
            environmentId,
            threadId,
            sandboxId: principal.sandboxId,
            repository: {
              ...repository,
              name: "attacker-repository",
              canonicalKey: "github.com/jarrodwatts/attacker-repository",
            },
            approvalId,
            approvalGeneration: validated.generation,
            approvalAction: "pushCheckpoint",
            leaseExpiresAt: "2026-08-28T12:50:00.000Z",
            routeBinding: githubWorkerRouteBinding(workerLease),
          }),
          "2026-08-28T12:30:30.000Z",
        ),
      );
      expect(forgedRepository.code).toBe("identityMismatch");
      expect(vaultRedemptions).toBe(0);
      yield* Effect.promise(() =>
        pool.query(
          `INSERT INTO cloud_worker_certificate
             (certificate_fingerprint, workspace_id, thread_id, environment_id,
              environment_revision_id, sandbox_id, reservation_id, worker_id,
              provider_instance_id, provider_driver, identity_binding, san_uri,
              public_key_spki_sha256, certificate_generation, not_before, not_after)
           VALUES ('fingerprint-token-lease-2', $1, $2, $3, 'revision-1',
                   'sandbox-token-lease', 'reservation-token-lease', 'worker-token-lease',
                   'codex_personal', 'codex', 'binding-token-lease-2',
                   'spiffe://agentsin.cloud/workers/token-lease-2', 'spki-token-lease-2',
                   2, $4, '2026-08-29T12:00:00.000Z')`,
          [workspaceId, threadId, environmentId, instant],
        ),
      );
      const staleRouteMutations = [
        "UPDATE cloud_worker_lease SET worker_id = 'worker-stale' WHERE workspace_id = $1 AND sandbox_id = $2",
        "UPDATE cloud_worker_lease SET certificate_fingerprint = 'fingerprint-token-lease-2' WHERE workspace_id = $1 AND sandbox_id = $2",
        "UPDATE cloud_worker_lease SET certificate_generation = 2 WHERE workspace_id = $1 AND sandbox_id = $2",
        "UPDATE cloud_worker_lease SET lease_generation = 2 WHERE workspace_id = $1 AND sandbox_id = $2",
        "UPDATE cloud_worker_lease SET route_generation = 2 WHERE workspace_id = $1 AND sandbox_id = $2",
        "UPDATE cloud_worker_lease SET process_instance_id = 'process-stale' WHERE workspace_id = $1 AND sandbox_id = $2",
        "UPDATE cloud_worker_lease SET reservation_id = 'reservation-stale' WHERE workspace_id = $1 AND sandbox_id = $2",
        "UPDATE cloud_worker_lease SET environment_revision_id = 'revision-stale' WHERE workspace_id = $1 AND sandbox_id = $2",
        "UPDATE cloud_worker_lease SET provider_instance_id = 'claude_personal' WHERE workspace_id = $1 AND sandbox_id = $2",
        "UPDATE cloud_worker_lease SET provider_driver = 'claude' WHERE workspace_id = $1 AND sandbox_id = $2",
      ] as const;
      const restoreCurrentRoute = () =>
        pool.query(
          `UPDATE cloud_worker_lease SET
             environment_revision_id = $3, reservation_id = $4, worker_id = $5,
             provider_instance_id = $6, provider_driver = $7, process_instance_id = $8,
             certificate_fingerprint = $9, certificate_generation = $10,
             lease_generation = $11, route_generation = $12, state = 'connected'
           WHERE workspace_id = $1 AND sandbox_id = $2`,
          [
            workspaceId,
            workerLease.sandboxId,
            workerLease.environmentRevisionId,
            workerLease.reservationId,
            workerLease.workerId,
            workerLease.providerInstanceId,
            workerLease.providerDriver,
            workerLease.processInstanceId,
            workerLease.certificateFingerprint,
            workerLease.certificateGeneration,
            workerLease.leaseGeneration,
            workerLease.routeGeneration,
          ],
        );
      for (const mutation of staleRouteMutations) {
        yield* Effect.promise(() => pool.query(mutation, [workspaceId, workerLease.sandboxId]));
        const stale = yield* withTokenLeaseMtlsBoundary({
          fixture,
          principal,
          broker,
          use: (post) =>
            Effect.promise(() =>
              post(
                redeemRequest({
                  leaseRef: revokedLease.leaseRef,
                  operationId: "operation-revoked",
                  commandId: "command-revoked",
                  generation: validated.generation,
                  expiresAt: "2026-08-28T12:50:00.000Z",
                }),
              ),
            ),
        });
        expect(stale.status).toBe(401);
        expect(vaultRedemptions).toBe(0);
        yield* Effect.promise(restoreCurrentRoute);
      }
      yield* Effect.promise(() =>
        pool.query(
          `UPDATE cloud_thread_approval SET state = 'rejected', updated_at = '2026-08-28T12:31:00.000Z'
            WHERE workspace_id = $1 AND request_id = $2`,
          [workspaceId, approvalId],
        ),
      );
      const revoked = yield* Effect.flip(
        broker.redeem(
          principal,
          redeemRequest({
            leaseRef: revokedLease.leaseRef,
            operationId: "operation-revoked",
            commandId: "command-revoked",
            generation: validated.generation,
            expiresAt: "2026-08-28T12:50:00.000Z",
          }),
          "2026-08-28T12:32:00.000Z",
        ),
      );
      expect(revoked.code).toBe("approvalInvalid");
      expect(vaultRedemptions).toBe(0);

      yield* Effect.promise(() =>
        pool.query(
          `UPDATE cloud_thread_approval
              SET state = 'approved', payload = $3::jsonb,
                  updated_at = '2026-08-28T12:33:00.000Z'
            WHERE workspace_id = $1 AND request_id = $2`,
          [workspaceId, approvalId, encodeJson(approvalPayload("2026-08-28T13:00:00.000Z"))],
        ),
      );
      const refreshed = yield* authority.validateApproval({
        approvalId,
        workspaceId,
        threadId,
        repository,
        action: "pushCheckpoint",
        actorUserId: "owner-a",
        authSessionId: "auth-session-postgres" as AuthSessionId,
        now: "2026-08-28T12:34:00.000Z",
      });
      const usableLease = yield* broker.seal({
        token: {
          token: Redacted.make("token-valid-once"),
          expiresAt: "2026-08-28T12:50:00.000Z",
        },
        workerLease,
        operationId: "operation-valid",
        commandId: "command-valid",
        approvalId,
        approvalGeneration: refreshed.generation as never,
        approvalAction: "pushCheckpoint",
        approvalExpiresAt: refreshed.approval.expiresAt,
        actorUserId: "owner-a",
        authSessionId: "auth-session-postgres" as AuthSessionId,
        repository,
      });
      const retriedLease = yield* broker.seal({
        token: {
          token: Redacted.make("a-retry-must-not-replace-the-sealed-token"),
          expiresAt: "2026-08-28T12:55:00.000Z",
        },
        workerLease,
        operationId: "operation-valid",
        commandId: "command-valid",
        approvalId,
        approvalGeneration: refreshed.generation as never,
        approvalAction: "pushCheckpoint",
        approvalExpiresAt: refreshed.approval.expiresAt,
        actorUserId: "owner-a",
        authSessionId: "auth-session-postgres" as AuthSessionId,
        repository,
      });
      expect(retriedLease).toEqual(usableLease);
      const replacementRouteLease = yield* broker.seal({
        token: {
          token: Redacted.make("token-for-replacement-route"),
          expiresAt: "2026-08-28T12:50:00.000Z",
        },
        workerLease: {
          ...workerLease,
          workerId: "worker-token-lease-2" as WorkerInstanceId,
          certificateFingerprint: "fingerprint-token-lease-2",
          certificateGeneration: 2,
          leaseGeneration: 2,
          routeGeneration: 2,
          processInstanceId: "process-token-lease-2",
        },
        operationId: "operation-valid",
        commandId: "command-valid",
        approvalId,
        approvalGeneration: refreshed.generation as never,
        approvalAction: "pushCheckpoint",
        approvalExpiresAt: refreshed.approval.expiresAt,
        actorUserId: "owner-a",
        authSessionId: "auth-session-postgres" as AuthSessionId,
        repository,
      });
      expect(replacementRouteLease.leaseRef).not.toBe(usableLease.leaseRef);
      const validRequest = redeemRequest({
        leaseRef: usableLease.leaseRef,
        operationId: "operation-valid",
        commandId: "command-valid",
        generation: refreshed.generation,
        expiresAt: "2026-08-28T12:50:00.000Z",
      });
      const materialized = yield* withTokenLeaseMtlsBoundary({
        fixture,
        principal,
        broker,
        use: (post) => Effect.promise(() => post(validRequest)),
      });
      expect(materialized.status).toBe(200);
      expect(materialized.body).toMatchObject({ token: "token-valid-once" });
      expect(vaultRedemptions).toBe(1);
      const replay = yield* withTokenLeaseMtlsBoundary({
        fixture,
        principal,
        broker,
        use: (post) => Effect.promise(() => post(validRequest)),
      });
      expect(replay.status).toBe(401);
      expect(vaultRedemptions).toBe(1);

      yield* Effect.promise(() =>
        pool.query(
          `UPDATE cloud_thread_approval
              SET payload = $3::jsonb, updated_at = '2026-08-28T12:36:00.000Z'
            WHERE workspace_id = $1 AND request_id = $2`,
          [workspaceId, approvalId, encodeJson(approvalPayload("2026-08-28T12:38:00.000Z"))],
        ),
      );
      const expiring = yield* authority.validateApproval({
        approvalId,
        workspaceId,
        threadId,
        repository,
        action: "pushCheckpoint",
        actorUserId: "owner-a",
        authSessionId: "auth-session-postgres" as AuthSessionId,
        now: "2026-08-28T12:37:00.000Z",
      });
      const expiringLease = yield* broker.seal({
        token: {
          token: Redacted.make("token-expired-before-redemption"),
          expiresAt: "2026-08-28T12:50:00.000Z",
        },
        workerLease,
        operationId: "operation-expired",
        commandId: "command-expired",
        approvalId,
        approvalGeneration: expiring.generation as never,
        approvalAction: "pushCheckpoint",
        approvalExpiresAt: expiring.approval.expiresAt,
        actorUserId: "owner-a",
        authSessionId: "auth-session-postgres" as AuthSessionId,
        repository,
      });
      const expired = yield* Effect.flip(
        broker.redeem(
          principal,
          redeemRequest({
            leaseRef: expiringLease.leaseRef,
            operationId: "operation-expired",
            commandId: "command-expired",
            generation: expiring.generation,
            expiresAt: "2026-08-28T12:38:00.000Z",
          }),
          "2026-08-28T12:38:00.000Z",
        ),
      );
      expect(expired.code).toBe("expired");
      expect(vaultRedemptions).toBe(1);
    }),
  ),
);

it.effect("rejects an idempotency key reused with a different command", () =>
  withPostgres((pool) =>
    Effect.gen(function* () {
      const store = makeTestStore(makeDatabase(pool));
      yield* store.registerRepository({
        workspaceId,
        repository,
        repositoryId: 42,
        canPush: true,
        canPullRequests: true,
      });
      yield* store.submit({
        idempotencyKey: "idem-conflict",
        command: branchCommand("command-conflict-a"),
        branchName,
      });
      const error = yield* Effect.flip(
        store.submit({
          idempotencyKey: "idem-conflict",
          command: branchCommand("command-conflict-b", "Different"),
          branchName,
        }),
      );
      expect(error._tag).toBe("GitHubWorkflowStoreError");
      expect(error.code).toBe("idempotencyConflict");
    }),
  ),
);
