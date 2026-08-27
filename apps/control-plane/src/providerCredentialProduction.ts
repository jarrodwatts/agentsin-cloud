// @effect-diagnostics nodeBuiltinImport:off -- UUIDs are generated at the server authority boundary.
import * as NodeCrypto from "node:crypto";

import type { AuthSessionId, ProviderInstanceRef, ThreadId } from "@t3tools/contracts";
import {
  AgentConnectionLoginEvent,
  type AgentConnectionBeginLoginResult,
  type AgentConnectionPollLoginResult,
  type AgentLoginId,
  type AgentProfileId,
  type WorkspaceId,
} from "@t3tools/contracts/cloud";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Pool } from "pg";

import type { CloudThreadLifecycleStore } from "./cloudThreadLifecycleStore.ts";
import {
  sealProviderCredentialPayload,
  type ProviderCredentialEnvelope,
  type ProviderCredentialKeyEncryption,
} from "./providerCredentialEnvelope.ts";
import {
  ProviderCredentialLoginRunnerError,
  type ProviderCredentialLoginRunResult,
  type ProviderCredentialLoginRunner,
} from "./providerCredentialLoginRunner.ts";
import {
  type AuthorizedProviderCredentialTarget,
  type ProviderCredentialAuthorizationContext,
  type ProviderCredentialLoginSource,
  ProviderCredentialServiceError,
  type ProviderCredentialTargetAuthorizer,
  type ProviderCredentialWorkerTransport,
} from "./providerCredentialService.ts";
import type { WorkerRelay } from "./workerRelay.ts";

const fail = (code: ProviderCredentialServiceError["code"], operation: string, cause?: unknown) =>
  new ProviderCredentialServiceError({
    code,
    operation,
    ...(cause === undefined ? {} : { cause }),
  });

const database = <A>(operation: string, use: () => Promise<A>) =>
  Effect.tryPromise({
    try: use,
    catch: (cause) => fail("materializationFailed", operation, cause),
  });

const LOGIN_GLOBAL_ACTIVE_LIMIT = 64;
const LOGIN_WORKSPACE_ACTIVE_LIMIT = 8;
const LOGIN_WORKSPACE_RATE_LIMIT_PER_MINUTE = 16;
const LOGIN_GLOBAL_RETAINED_LIMIT = 100_000;
const LOGIN_WORKSPACE_RETAINED_LIMIT = 10_000;
const LOGIN_GLOBAL_RETAINED_BYTES = 1024 * 1024 * 1024;
const LOGIN_WORKSPACE_RETAINED_BYTES = 128 * 1024 * 1024;
export const PROVIDER_LOGIN_TERMINAL_RETENTION_DAYS = 30;
const PROVIDER_LOGIN_RETENTION_BATCH_SIZE = 1_000;
const encodeLoginEventArray = Schema.encodeUnknownSync(
  Schema.fromJsonString(Schema.Array(AgentConnectionLoginEvent)),
);

export const purgeTerminalProviderLogins = (pool: Pool, now: string) =>
  database("purge-terminal-provider-logins", () =>
    pool
      .query<{ readonly purged_count: string }>(
        `WITH candidates AS MATERIALIZED (
           SELECT workspace_id, login_id, provider_instance_id, provider_driver,
                  state, created_at, updated_at
             FROM provider_credential_login_session
            WHERE state <> 'running'
              AND cleanup_state = 'confirmed'
              AND updated_at < $1::timestamptz - interval '${PROVIDER_LOGIN_TERMINAL_RETENTION_DAYS} days'
            ORDER BY updated_at, workspace_id, login_id
            FOR UPDATE SKIP LOCKED
            LIMIT $2
         ), retained AS (
           INSERT INTO provider_credential_login_audit_daily (
             audit_day, workspace_id, provider_instance_id, provider_driver,
             terminal_state, attempt_count, first_created_at, last_terminal_at
           )
           SELECT (updated_at AT TIME ZONE 'UTC')::date, workspace_id,
                  provider_instance_id, provider_driver, state,
                  count(*), min(created_at), max(updated_at)
             FROM candidates
            GROUP BY 1,2,3,4,5
           ON CONFLICT (
             audit_day, workspace_id, provider_instance_id, provider_driver, terminal_state
           ) DO UPDATE SET
             attempt_count = provider_credential_login_audit_daily.attempt_count + EXCLUDED.attempt_count,
             first_created_at = least(provider_credential_login_audit_daily.first_created_at, EXCLUDED.first_created_at),
             last_terminal_at = greatest(provider_credential_login_audit_daily.last_terminal_at, EXCLUDED.last_terminal_at)
           RETURNING 1
         ), deleted AS (
           DELETE FROM provider_credential_login_session AS sessions
            USING candidates
            WHERE sessions.workspace_id = candidates.workspace_id
              AND sessions.login_id = candidates.login_id
              AND (SELECT count(*) FROM retained) >= 0
           RETURNING 1
         )
         SELECT count(*)::text AS purged_count FROM deleted`,
        [now, PROVIDER_LOGIN_RETENTION_BATCH_SIZE],
      )
      .then((result) => Number(result.rows[0]?.purged_count ?? 0)),
  );

export const makeLifecycleProviderCredentialTargetAuthorizer = (input: {
  readonly lifecycle: CloudThreadLifecycleStore;
  readonly relay: WorkerRelay;
  readonly now: Effect.Effect<string>;
}): ProviderCredentialTargetAuthorizer => {
  const resolve = (
    workspaceId: WorkspaceId,
    threadId: ThreadId,
    provisionalIdentity?: AuthorizedProviderCredentialTarget["identity"],
  ) =>
    Effect.gen(function* () {
      const attempt = yield* Effect.tryPromise({
        try: () => input.lifecycle.getCurrent(workspaceId, threadId),
        catch: (cause) => fail("materializationFailed", "load-thread-target", cause),
      });
      if (
        attempt === undefined ||
        !attempt.isCurrent ||
        attempt.state !== "ready" ||
        attempt.sandboxId === undefined ||
        attempt.workerId === undefined
      )
        return yield* fail("unauthorized", "inactive-thread-target");
      const route = input.relay.routes.get(workspaceId, attempt.sandboxId);
      const identity = provisionalIdentity ?? route?.lease;
      if (
        identity === undefined ||
        identity.workspaceId !== workspaceId ||
        identity.sandboxId !== attempt.sandboxId ||
        identity.threadId !== threadId ||
        identity.environmentId !== attempt.environmentId ||
        identity.environmentRevisionId !== attempt.environmentRevisionId ||
        identity.workerId !== attempt.workerId ||
        identity.providerInstanceId !== attempt.providerInstanceId ||
        identity.providerDriver !== attempt.providerDriver
      )
        return yield* fail("unauthorized", "unverified-worker-target");
      const now = yield* input.now;
      return {
        workspaceId,
        threadId,
        environmentId: attempt.environmentId,
        sandboxId: attempt.sandboxId,
        workerId: attempt.workerId,
        provider: { instanceId: attempt.providerInstanceId, driver: attempt.providerDriver },
        active: true as const,
        authorizationExpiresAt: DateTime.formatIso(
          DateTime.add(DateTime.makeUnsafe(now), { minutes: 2 }),
        ),
        identity,
      } satisfies AuthorizedProviderCredentialTarget;
    });
  return {
    authorize: ({ principal, threadId }) => resolve(principal.workspaceId, threadId),
    resolveSystem: ({ workspaceId, threadId, provisionalIdentity }) =>
      resolve(workspaceId, threadId, provisionalIdentity),
  };
};

export const makeB4ProviderCredentialWorkerTransport = (
  relay: Pick<WorkerRelay, "sendCredentialCommand">,
  attestedProvisionalIdentity?: AuthorizedProviderCredentialTarget["identity"],
): ProviderCredentialWorkerTransport => ({
  ...(attestedProvisionalIdentity === undefined ? {} : { attestedProvisionalIdentity }),
  dispatch: ({ target, command, credentialPayload }) =>
    relay
      .sendCredentialCommand({
        identity: target.identity,
        command,
        ...(credentialPayload === undefined ? {} : { credentialPayload }),
      })
      .pipe(Effect.mapError((cause) => fail("materializationFailed", "worker-transport", cause))),
});

interface LoginRow {
  readonly login_id: string;
  readonly profile_id: string;
  readonly thread_id: string;
  readonly environment_id: string;
  readonly sandbox_id: string;
  readonly worker_id: string;
  readonly provider_instance_id: string;
  readonly provider_driver: ProviderInstanceRef["driver"];
  readonly generation: string;
  readonly state: "running" | "authorized" | "denied" | "expired" | "cancelled" | "failed";
  readonly events: ReadonlyArray<AgentConnectionPollLoginResult["events"][number]>;
  readonly key_version: string | null;
  readonly wrapped_dek: Buffer | null;
  readonly nonce: Buffer | null;
  readonly auth_tag: Buffer | null;
  readonly ciphertext: Buffer | null;
  readonly expires_at: string;
}

export interface ProviderLoginCoordinator extends ProviderCredentialLoginSource {
  readonly begin: (input: {
    readonly principal: ProviderCredentialAuthorizationContext;
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceRef["instanceId"];
  }) => Effect.Effect<AgentConnectionBeginLoginResult, ProviderCredentialServiceError>;
  readonly poll: (
    principal: ProviderCredentialAuthorizationContext,
    loginId: AgentLoginId,
  ) => Effect.Effect<AgentConnectionPollLoginResult, ProviderCredentialServiceError>;
  readonly cancel: (
    principal: ProviderCredentialAuthorizationContext,
    loginId: AgentLoginId,
  ) => Effect.Effect<AgentConnectionPollLoginResult, ProviderCredentialServiceError>;
  readonly sweepExpired: Effect.Effect<number, ProviderCredentialServiceError>;
  readonly shutdown: Effect.Effect<void, ProviderCredentialServiceError>;
  readonly purgeTerminalHistory: Effect.Effect<number, ProviderCredentialServiceError>;
}

/**
 * Provider login runs in a disposable credential-only job adjacent to the
 * control-plane KMS boundary. Authorized payloads are sealed before the job
 * result is persisted; PostgreSQL never stores provider plaintext.
 */
export const makeProviderLoginCoordinator = (input: {
  readonly pool: Pool;
  readonly targets: ProviderCredentialTargetAuthorizer;
  readonly runner: ProviderCredentialLoginRunner;
  readonly now: Effect.Effect<string>;
  readonly keyEncryption: ProviderCredentialKeyEncryption;
}): ProviderLoginCoordinator => {
  const load = (workspaceId: WorkspaceId, loginId: AgentLoginId) =>
    database("load-provider-login", async () => {
      const rows = await input.pool.query<LoginRow>(
        `SELECT login_id, profile_id, thread_id, environment_id, sandbox_id, worker_id,
                provider_instance_id, provider_driver, generation::text, state, events,
                key_version, wrapped_dek, nonce, auth_tag, ciphertext,
                expires_at::text AS expires_at
           FROM provider_credential_login_session
          WHERE workspace_id = $1 AND login_id = $2`,
        [workspaceId, loginId],
      );
      return rows.rows[0];
    }).pipe(
      Effect.flatMap((row) =>
        row === undefined
          ? Effect.fail(fail("notFound", "load-provider-login"))
          : Effect.succeed(row),
      ),
    );
  const persistCompletion = (
    workspaceId: WorkspaceId,
    loginId: AgentLoginId,
    expected: {
      readonly provider: ProviderInstanceRef;
      readonly generation: number;
    },
    result: ProviderCredentialLoginRunResult,
  ) =>
    result.outcome === "authorized"
      ? sealProviderCredentialPayload({
          plaintext: result.credential,
          context: {
            workspaceId,
            profileId: loginId as unknown as AgentProfileId,
            provider: expected.provider,
          },
          keyEncryption: input.keyEncryption,
        }).pipe(
          Effect.mapError((cause) => fail("integrityFailure", "seal-provider-login", cause)),
          Effect.flatMap((envelope) =>
            database("complete-provider-login", () =>
              input.pool
                .query(
                  `UPDATE provider_credential_login_session
                      SET state = 'authorized', cleanup_state = 'confirmed', cleanup_error = NULL,
                          key_version = $3, wrapped_dek = $4, nonce = $5, auth_tag = $6,
                          ciphertext = $7, updated_at = $8::timestamptz
                    WHERE workspace_id = $1 AND login_id = $2 AND state = 'running'
                      AND provider_instance_id = $9 AND provider_driver = $10
                      AND generation = $11`,
                  [
                    workspaceId,
                    loginId,
                    envelope.keyVersion,
                    Buffer.from(envelope.wrappedKey),
                    Buffer.from(envelope.nonce),
                    Buffer.from(envelope.authTag),
                    Buffer.from(envelope.ciphertext),
                    result.occurredAt,
                    expected.provider.instanceId,
                    expected.provider.driver,
                    expected.generation,
                  ],
                )
                .then((queryResult) => {
                  if (queryResult.rowCount !== 1)
                    throw new Error("provider login completion CAS failed");
                }),
            ),
          ),
          Effect.ensuring(Effect.sync(() => result.credential.withValue((bytes) => bytes.fill(0)))),
        )
      : database("complete-provider-login", () =>
          input.pool
            .query(
              `UPDATE provider_credential_login_session
                  SET state = $3, cleanup_state = 'confirmed', cleanup_error = $4,
                      key_version = NULL, wrapped_dek = NULL, nonce = NULL,
                      auth_tag = NULL, ciphertext = NULL, updated_at = $5::timestamptz
                WHERE workspace_id = $1 AND login_id = $2 AND state = 'running'
                  AND provider_instance_id = $6 AND provider_driver = $7
                  AND generation = $8`,
              [
                workspaceId,
                loginId,
                result.outcome,
                result.outcome === "failed" ? (result.errorCode ?? "provider_login_failed") : null,
                result.occurredAt,
                expected.provider.instanceId,
                expected.provider.driver,
                expected.generation,
              ],
            )
            .then((queryResult) => {
              if (queryResult.rowCount !== 1)
                throw new Error("provider login completion CAS failed");
            }),
        );
  const persistCancellationFailure = (
    workspaceId: WorkspaceId,
    loginId: AgentLoginId,
    at: string,
  ) =>
    database("fail-provider-login-cleanup", () =>
      input.pool
        .query(
          `UPDATE provider_credential_login_session
            SET cleanup_state = 'retry_required', cleanup_error = 'runner_cleanup_failed',
                updated_at = $3::timestamptz
          WHERE workspace_id = $1 AND login_id = $2`,
          [workspaceId, loginId, at],
        )
        .then(() => undefined),
    );
  const confirmRunnerCleanup = (
    workspaceId: WorkspaceId,
    loginId: AgentLoginId,
    generation: number,
    at: string,
  ) =>
    database("confirm-provider-login-cleanup", () =>
      input.pool
        .query(
          `UPDATE provider_credential_login_session
              SET cleanup_state = 'confirmed', cleanup_error = NULL, updated_at = $4::timestamptz
            WHERE workspace_id = $1 AND login_id = $2 AND generation = $3
              AND state <> 'running' AND cleanup_state = 'pending'`,
          [workspaceId, loginId, generation, at],
        )
        .then(() => undefined),
    );
  const toPollResult = (
    workspaceId: WorkspaceId,
    loginId: AgentLoginId,
    row: LoginRow,
  ): AgentConnectionPollLoginResult =>
    row.state === "running"
      ? {
          status: "pending",
          loginId,
          profileId: row.profile_id as AgentProfileId,
          workspaceId,
          pollAfterMs: 1_000,
          events: row.events,
        }
      : row.state === "authorized"
        ? {
            status: "authorized",
            loginId,
            profileId: row.profile_id as AgentProfileId,
            workspaceId,
            events: row.events,
          }
        : {
            status: row.state === "cancelled" ? "failed" : row.state,
            loginId,
            profileId: row.profile_id as AgentProfileId,
            workspaceId,
            events: row.events,
          };
  const envelopeFromRow = (row: LoginRow): ProviderCredentialEnvelope | undefined =>
    row.key_version === null ||
    row.wrapped_dek === null ||
    row.nonce === null ||
    row.auth_tag === null ||
    row.ciphertext === null
      ? undefined
      : {
          envelopeVersion: 1,
          keyVersion: row.key_version,
          wrappedKey: Uint8Array.from(row.wrapped_dek),
          nonce: Uint8Array.from(row.nonce),
          authTag: Uint8Array.from(row.auth_tag),
          ciphertext: Uint8Array.from(row.ciphertext),
        };

  return {
    begin: ({ principal, threadId, providerInstanceId }) =>
      Effect.gen(function* () {
        const target = yield* input.targets.authorize({
          principal,
          threadId,
          profileId: "pending-login" as AgentProfileId,
        });
        if (target.provider.instanceId !== providerInstanceId)
          return yield* fail("providerMismatch", "begin-login");
        const loginId = NodeCrypto.randomUUID() as AgentLoginId;
        const profileId = loginId as unknown as AgentProfileId;
        const now = yield* input.now;
        const expiresAt = DateTime.formatIso(
          DateTime.add(DateTime.makeUnsafe(now), { minutes: 15 }),
        );
        yield* database("insert-provider-login", async () => {
          const client = await input.pool.connect();
          try {
            await client.query("BEGIN");
            await client.query("SELECT pg_advisory_xact_lock(730174001)");
            await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 730174002))", [
              principal.workspaceId,
            ]);
            const inserted = await client.query(
              `INSERT INTO provider_credential_login_session (
               workspace_id, login_id, profile_id, thread_id, environment_id, sandbox_id, worker_id,
               provider_instance_id, provider_driver, state, events, cleanup_state,
               expires_at, created_at, updated_at
             ) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,'running','[]'::jsonb,'pending',
                       $10::timestamptz,$11::timestamptz,$11::timestamptz
               WHERE (SELECT count(*) FROM provider_credential_login_session WHERE state = 'running') < ${LOGIN_GLOBAL_ACTIVE_LIMIT}
                 AND (SELECT count(*) FROM provider_credential_login_session WHERE workspace_id = $1 AND state = 'running') < ${LOGIN_WORKSPACE_ACTIVE_LIMIT}
                 AND (SELECT count(*) FROM provider_credential_login_session WHERE workspace_id = $1 AND created_at >= $11::timestamptz - interval '1 minute') < ${LOGIN_WORKSPACE_RATE_LIMIT_PER_MINUTE}
                 AND (SELECT count(*) FROM provider_credential_login_session) < ${LOGIN_GLOBAL_RETAINED_LIMIT}
                 AND (SELECT count(*) FROM provider_credential_login_session WHERE workspace_id = $1) < ${LOGIN_WORKSPACE_RETAINED_LIMIT}
                 AND (SELECT coalesce(sum(pg_column_size(session_row)), 0) FROM provider_credential_login_session AS session_row) < ${LOGIN_GLOBAL_RETAINED_BYTES}
                 AND (SELECT coalesce(sum(pg_column_size(session_row)), 0) FROM provider_credential_login_session AS session_row WHERE workspace_id = $1) < ${LOGIN_WORKSPACE_RETAINED_BYTES}
               RETURNING login_id`,
              [
                principal.workspaceId,
                loginId,
                profileId,
                threadId,
                target.environmentId,
                target.sandboxId,
                target.workerId,
                target.provider.instanceId,
                target.provider.driver,
                expiresAt,
                now,
              ],
            );
            if (inserted.rowCount !== 1) throw new Error("provider login quota exceeded");
            await client.query("COMMIT");
          } catch (cause) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw cause;
          } finally {
            client.release();
          }
        });
        yield* input.runner
          .run({
            workspaceId: principal.workspaceId,
            loginId,
            profileId,
            provider: target.provider,
            expiresAt,
            onEvent: (event) =>
              Effect.tryPromise({
                try: () =>
                  input.pool
                    .query(
                      `UPDATE provider_credential_login_session
                          SET events = events || $3::jsonb, updated_at = $4::timestamptz
                        WHERE workspace_id = $1 AND login_id = $2 AND state = 'running'
                          AND jsonb_array_length(events) < 64
                          AND octet_length(events::text) + octet_length($3::text) <= 65536`,
                      [
                        principal.workspaceId,
                        loginId,
                        encodeLoginEventArray([event]),
                        event.occurredAt,
                      ],
                    )
                    .then((result) => {
                      if (result.rowCount !== 1)
                        throw new Error("provider login event was rejected");
                    }),
                catch: (cause) =>
                  new ProviderCredentialLoginRunnerError({
                    code: "executionFailed",
                    operation: "persist-provider-login-event",
                    cause,
                  }),
              }),
          })
          .pipe(
            Effect.flatMap((result) =>
              persistCompletion(
                principal.workspaceId,
                loginId,
                { provider: target.provider, generation: 1 },
                result,
              ),
            ),
            Effect.catch(() =>
              input.now.pipe(
                Effect.flatMap((failedAt) =>
                  database("fail-provider-login", () =>
                    input.pool
                      .query(
                        `UPDATE provider_credential_login_session
                            SET state = 'failed', cleanup_state = 'retry_required',
                                cleanup_error = 'credential_runner_failed',
                                key_version = NULL, wrapped_dek = NULL, nonce = NULL,
                                auth_tag = NULL, ciphertext = NULL,
                                updated_at = $3::timestamptz
                          WHERE workspace_id = $1 AND login_id = $2 AND state = 'running'`,
                        [principal.workspaceId, loginId, failedAt],
                      )
                      .then(() => undefined),
                  ),
                ),
                Effect.catch(() => Effect.void),
              ),
            ),
            Effect.forkDetach,
          );
        return {
          loginId,
          profileId,
          workspaceId: principal.workspaceId,
          provider: target.provider,
          method: "deviceCode" as const,
          events: [],
          expiresAt,
          pollAfterMs: 1_000,
        };
      }),
    poll: (principal, loginId) =>
      load(principal.workspaceId, loginId).pipe(
        Effect.map((row) => toPollResult(principal.workspaceId, loginId, row)),
      ),
    cancel: (principal, loginId) =>
      Effect.gen(function* () {
        const row = yield* load(principal.workspaceId, loginId);
        if (row.state !== "running") return toPollResult(principal.workspaceId, loginId, row);
        const at = yield* input.now;
        const fenced = yield* database("fence-provider-login-cancel", () =>
          input.pool.query(
            `UPDATE provider_credential_login_session
                SET state = 'cancelled', cleanup_state = 'pending', cleanup_error = NULL,
                    key_version = NULL, wrapped_dek = NULL, nonce = NULL,
                    auth_tag = NULL, ciphertext = NULL, updated_at = $4::timestamptz
              WHERE workspace_id = $1 AND login_id = $2 AND generation = $3 AND state = 'running'`,
            [principal.workspaceId, loginId, Number(row.generation), at],
          ),
        );
        if (fenced.rowCount !== 1) {
          const current = yield* load(principal.workspaceId, loginId);
          return toPollResult(principal.workspaceId, loginId, current);
        }
        yield* input.runner.cancel({ workspaceId: principal.workspaceId, loginId }).pipe(
          Effect.mapError((cause) => fail("cleanupFailed", "cancel-login", cause)),
          Effect.tapError(() => persistCancellationFailure(principal.workspaceId, loginId, at)),
        );
        yield* confirmRunnerCleanup(principal.workspaceId, loginId, Number(row.generation), at);
        const current = yield* load(principal.workspaceId, loginId);
        return toPollResult(principal.workspaceId, loginId, current);
      }),
    getProvider: (workspaceId, loginId) =>
      load(workspaceId, loginId).pipe(
        Effect.flatMap((row) =>
          row.state === "authorized"
            ? Effect.succeed({
                instanceId: row.provider_instance_id as ProviderInstanceRef["instanceId"],
                driver: row.provider_driver,
              })
            : Effect.fail(fail("profileUnavailable", "provider-login-not-authorized")),
        ),
      ),
    consumeCredential: (workspaceId, loginId) =>
      Effect.gen(function* () {
        const row = yield* load(workspaceId, loginId);
        if (row.state !== "authorized")
          return yield* fail("profileUnavailable", "provider-login-not-authorized");
        const envelope = envelopeFromRow(row);
        if (envelope === undefined)
          return yield* fail("integrityFailure", "provider-login-envelope-missing");
        return {
          provider: {
            instanceId: row.provider_instance_id as ProviderInstanceRef["instanceId"],
            driver: row.provider_driver,
          },
          profileId: row.profile_id as AgentProfileId,
          envelope,
        };
      }),
    sweepExpired: Effect.gen(function* () {
      const at = yield* input.now;
      const claimed = yield* database("claim-provider-login-cleanup", () =>
        input.pool.query<{
          readonly workspace_id: WorkspaceId;
          readonly login_id: AgentLoginId;
          readonly generation: string;
        }>(
          `WITH candidates AS MATERIALIZED (
             SELECT workspace_id, login_id, generation
               FROM provider_credential_login_session
              WHERE (state = 'running' AND expires_at <= $1::timestamptz)
                 OR cleanup_state = 'retry_required'
                 OR (state <> 'running' AND cleanup_state = 'pending'
                     AND updated_at <= $1::timestamptz - interval '1 minute')
              ORDER BY updated_at, workspace_id, login_id
              FOR UPDATE SKIP LOCKED
              LIMIT 64
           )
           UPDATE provider_credential_login_session AS sessions
              SET state = CASE
                    WHEN sessions.state = 'running' AND sessions.expires_at <= $1::timestamptz
                      THEN 'expired'
                    WHEN sessions.state = 'running' THEN 'cancelled'
                    ELSE sessions.state
                  END,
                  cleanup_state = 'pending', cleanup_error = NULL,
                  key_version = CASE WHEN sessions.state = 'authorized' THEN sessions.key_version ELSE NULL END,
                  wrapped_dek = CASE WHEN sessions.state = 'authorized' THEN sessions.wrapped_dek ELSE NULL END,
                  nonce = CASE WHEN sessions.state = 'authorized' THEN sessions.nonce ELSE NULL END,
                  auth_tag = CASE WHEN sessions.state = 'authorized' THEN sessions.auth_tag ELSE NULL END,
                  ciphertext = CASE WHEN sessions.state = 'authorized' THEN sessions.ciphertext ELSE NULL END,
                  updated_at = $1::timestamptz
             FROM candidates
            WHERE sessions.workspace_id = candidates.workspace_id
              AND sessions.login_id = candidates.login_id
              AND sessions.generation = candidates.generation
           RETURNING sessions.workspace_id, sessions.login_id, sessions.generation::text`,
          [at],
        ),
      );
      const outcomes = yield* Effect.forEach(
        claimed.rows,
        (row) =>
          input.runner.cancel({ workspaceId: row.workspace_id, loginId: row.login_id }).pipe(
            Effect.catch((cause) =>
              cause.code === "notFound"
                ? Effect.void
                : persistCancellationFailure(row.workspace_id, row.login_id, at).pipe(
                    Effect.andThen(Effect.fail(fail("cleanupFailed", "sweep-login", cause))),
                  ),
            ),
            Effect.andThen(
              confirmRunnerCleanup(row.workspace_id, row.login_id, Number(row.generation), at),
            ),
            Effect.exit,
          ),
        { concurrency: 4 },
      );
      const firstFailure = outcomes.find((outcome) => outcome._tag === "Failure");
      if (firstFailure !== undefined) return yield* fail("cleanupFailed", "sweep-logins");
      return claimed.rowCount ?? 0;
    }),
    shutdown: input.runner.shutdown.pipe(
      Effect.mapError((cause) => fail("cleanupFailed", "shutdown-login-runner", cause)),
    ),
    purgeTerminalHistory: input.now.pipe(
      Effect.flatMap((at) => purgeTerminalProviderLogins(input.pool, at)),
    ),
  };
};

export const makeServerCredentialPrincipal = (input: {
  readonly workspaceId: WorkspaceId;
  readonly userId: string;
  readonly authSessionId: string;
}): ProviderCredentialAuthorizationContext => ({
  workspaceId: input.workspaceId,
  userId: input.userId,
  authSessionId: input.authSessionId as AuthSessionId,
});
