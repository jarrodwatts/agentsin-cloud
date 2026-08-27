// @effect-diagnostics nodeBuiltinImport:off -- Hashing binds idempotency and audit-safe target metadata.
import * as NodeCrypto from "node:crypto";

import type {
  AuthSessionId,
  EnvironmentId,
  ProviderInstanceRef,
  ThreadId,
} from "@t3tools/contracts";
import type {
  AgentConnectionMaterializeResult,
  AgentConnectionProfile,
  AgentConnectionValidateResult,
  AgentLoginId,
  AgentMaterializationId,
  AgentProfileId,
  SandboxId,
  WorkspaceId,
} from "@t3tools/contracts/cloud";
import type {
  WorkerInstanceId,
  WorkerProviderCredentialCommand,
  WorkerProviderCredentialResult,
} from "@t3tools/contracts/worker";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  isProviderCredentialEnvelopeMetadataValid,
  openProviderCredentialPayload,
  type ProviderCredentialCrypto,
  type ProviderCredentialEnvelope,
  type ProviderCredentialKeyEncryption,
} from "./providerCredentialEnvelope.ts";
import type {
  ProviderCredentialMaterializationRecord,
  ProviderCredentialProfileRecord,
  ProviderCredentialStore,
} from "./providerCredentialStore.ts";
import type { Secret } from "./providerSecrets.ts";
import type { ActiveWorkerLease } from "./workerIdentity.ts";

export interface ProviderCredentialAuthorizationContext {
  readonly workspaceId: WorkspaceId;
  readonly authSessionId: AuthSessionId;
  readonly userId: string;
}

export interface AuthorizedProviderCredentialTarget {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly sandboxId: SandboxId;
  readonly workerId: WorkerInstanceId;
  readonly provider: ProviderInstanceRef;
  readonly active: true;
  readonly authorizationExpiresAt: string;
  readonly identity: ActiveWorkerLease;
}

export interface ProviderCredentialTargetAuthorizer {
  readonly authorize: (input: {
    readonly principal: ProviderCredentialAuthorizationContext;
    readonly threadId: ThreadId;
    readonly profileId: AgentProfileId;
  }) => Effect.Effect<AuthorizedProviderCredentialTarget, ProviderCredentialServiceError>;
  readonly resolveSystem: (input: {
    readonly workspaceId: WorkspaceId;
    readonly threadId: ThreadId;
    readonly profileId: AgentProfileId;
    /** Attested relay lease used only while reconnect reconciliation is provisional. */
    readonly provisionalIdentity?: ActiveWorkerLease;
  }) => Effect.Effect<AuthorizedProviderCredentialTarget, ProviderCredentialServiceError>;
}

export interface ProviderCredentialLoginSource {
  readonly getProvider: (
    workspaceId: WorkspaceId,
    loginId: AgentLoginId,
  ) => Effect.Effect<ProviderInstanceRef, ProviderCredentialServiceError>;
  readonly consumeCredential: (
    workspaceId: WorkspaceId,
    loginId: AgentLoginId,
  ) => Effect.Effect<
    {
      readonly provider: ProviderInstanceRef;
      readonly profileId: AgentProfileId;
      readonly envelope: ProviderCredentialEnvelope;
    },
    ProviderCredentialServiceError
  >;
}

/** Direct, authenticated B4 route. Implementations must not persist commands. */
export interface ProviderCredentialWorkerTransport {
  /** Relay-attested lease carried only by the provisional reconnect transport. */
  readonly attestedProvisionalIdentity?: ActiveWorkerLease;
  readonly dispatch: (input: {
    readonly target: AuthorizedProviderCredentialTarget;
    readonly command: WorkerProviderCredentialCommand;
    /** Owned plaintext is authorized for this one active sandbox lease and zeroized by dispatch. */
    readonly credentialPayload?: Secret<Uint8Array>;
  }) => Effect.Effect<WorkerProviderCredentialResult, ProviderCredentialServiceError>;
}

export class ProviderCredentialServiceError extends Schema.TaggedErrorClass<ProviderCredentialServiceError>()(
  "ProviderCredentialServiceError",
  {
    code: Schema.Literals([
      "unauthorized",
      "expiredAuthorization",
      "notFound",
      "profileUnavailable",
      "providerMismatch",
      "idempotencyConflict",
      "integrityFailure",
      "materializationFailed",
      "cleanupFailed",
    ]),
    operation: Schema.String,
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {}
const isProviderCredentialServiceError = Schema.is(ProviderCredentialServiceError);

export interface ProviderCredentialService {
  readonly sealProfile: (input: {
    readonly authorization: ProviderCredentialAuthorizationContext;
    readonly loginId: AgentLoginId;
    readonly profileId: AgentProfileId;
    readonly label: string;
    readonly idempotencyKey: string;
    readonly expiresAt?: string;
  }) => Effect.Effect<AgentConnectionProfile, ProviderCredentialServiceError>;
  readonly validate: (input: {
    readonly authorization: ProviderCredentialAuthorizationContext;
    readonly profileId: AgentProfileId;
  }) => Effect.Effect<AgentConnectionValidateResult, ProviderCredentialServiceError>;
  readonly materialize: (input: {
    readonly authorization: ProviderCredentialAuthorizationContext;
    readonly threadId: ThreadId;
    readonly profileId: AgentProfileId;
    readonly materializationId: AgentMaterializationId;
  }) => Effect.Effect<AgentConnectionMaterializeResult, ProviderCredentialServiceError>;
  readonly revoke: (input: {
    readonly authorization: ProviderCredentialAuthorizationContext;
    readonly profileId: AgentProfileId;
  }) => Effect.Effect<AgentConnectionProfile, ProviderCredentialServiceError>;
  readonly cleanupLifecycle: (input: {
    readonly workspaceId: WorkspaceId;
    readonly threadId: ThreadId;
    readonly sandboxId?: SandboxId;
    readonly reason: "paused" | "destroyed" | "replaced";
    readonly workerOverride?: ProviderCredentialWorkerTransport;
  }) => Effect.Effect<void, ProviderCredentialServiceError>;
  readonly reconcileWorker: (input: {
    readonly workspaceId: WorkspaceId;
    readonly sandboxId: SandboxId;
    readonly workerOverride?: ProviderCredentialWorkerTransport;
  }) => Effect.Effect<void, ProviderCredentialServiceError>;
  readonly sweepExpired: Effect.Effect<void, ProviderCredentialServiceError>;
}

const fail = (code: ProviderCredentialServiceError["code"], operation: string, cause?: unknown) =>
  new ProviderCredentialServiceError({
    code,
    operation,
    ...(cause === undefined ? {} : { cause }),
  });

const digest = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

const profileMetadata = (record: ProviderCredentialProfileRecord): AgentConnectionProfile => ({
  profileId: record.profileId,
  workspaceId: record.workspaceId,
  provider: record.provider,
  label: record.label,
  state: record.state,
  keyVersion: record.envelope.keyVersion,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
});

const sameProvider = (left: ProviderInstanceRef, right: ProviderInstanceRef) =>
  left.instanceId === right.instanceId && left.driver === right.driver;

const mapFailure = (operation: string) => (cause: unknown) => {
  if (isProviderCredentialServiceError(cause)) return cause;
  const tagged = cause as { readonly _tag?: string; readonly code?: string };
  if (tagged._tag === "ProviderCredentialStoreError" && tagged.code === "idempotencyConflict") {
    return fail("idempotencyConflict", operation);
  }
  if (tagged._tag === "ProviderCredentialEnvelopeError") {
    return fail("integrityFailure", operation);
  }
  return fail("materializationFailed", operation, cause);
};

export const makeProviderCredentialService = (dependencies: {
  readonly logins: ProviderCredentialLoginSource;
  readonly store: ProviderCredentialStore;
  readonly keyEncryption: ProviderCredentialKeyEncryption;
  readonly crypto?: ProviderCredentialCrypto;
  readonly authorizer: ProviderCredentialTargetAuthorizer;
  readonly worker: ProviderCredentialWorkerTransport;
  readonly now: Effect.Effect<string>;
}): ProviderCredentialService => {
  const loadProfile = (workspaceId: WorkspaceId, profileId: AgentProfileId) =>
    dependencies.store.getProfile(workspaceId, profileId).pipe(
      Effect.mapError(mapFailure("get-profile")),
      Effect.flatMap((profile) =>
        profile === undefined
          ? Effect.fail(fail("notFound", "get-profile"))
          : Effect.succeed(profile),
      ),
    );

  const cleanupRecords = (
    records: ReadonlyArray<ProviderCredentialMaterializationRecord>,
    reason: string,
    worker: ProviderCredentialWorkerTransport = dependencies.worker,
    provisionalIdentity?: ActiveWorkerLease,
  ) =>
    Effect.forEach(
      records,
      (record) =>
        Effect.gen(function* () {
          const now = yield* dependencies.now;
          const target = yield* dependencies.authorizer.resolveSystem({
            workspaceId: record.workspaceId,
            threadId: record.threadId,
            profileId: record.profileId,
            ...(provisionalIdentity === undefined ? {} : { provisionalIdentity }),
          });
          if (
            target.sandboxId !== record.sandboxId ||
            target.workerId !== record.workerId ||
            target.provider.instanceId !== record.providerInstanceId ||
            target.provider.driver !== record.providerDriver
          )
            return yield* fail("unauthorized", "cleanup-target-mismatch");
          const result = yield* worker
            .dispatch({
              target,
              command: {
                type: "provider.credentials.command",
                operation: "cleanup",
                operationId: record.materializationId,
                routeGeneration: target.identity.routeGeneration,
                profileId: record.profileId,
                profileGeneration: record.profileGeneration,
                providerInstanceId: record.providerInstanceId,
                providerDriver: record.providerDriver,
              },
            })
            .pipe(Effect.result);
          if (
            result._tag === "Success" &&
            result.success.operation === "cleanup" &&
            result.success.outcome === "absent"
          ) {
            const confirmed = yield* dependencies.store
              .confirmAbsent(
                record.workspaceId,
                record.materializationId,
                record.profileGeneration,
                now,
                reason,
              )
              .pipe(Effect.mapError(mapFailure("confirm-cleanup")));
            if (!confirmed) return yield* fail("cleanupFailed", "cleanup-generation-fenced");
            return;
          }
          const detail =
            result._tag === "Failure"
              ? result.failure.code
              : result.success.operation === "cleanup"
                ? (result.success.errorCode ?? "worker_cleanup_failed")
                : "worker_result_mismatch";
          yield* dependencies.store
            .requireCleanup(record.workspaceId, record.materializationId, reason, detail, now)
            .pipe(Effect.mapError(mapFailure("persist-cleanup-failure")));
          return yield* fail("cleanupFailed", "cleanup", detail);
        }),
      { concurrency: 1, discard: true },
    );

  return {
    sealProfile: (input) =>
      Effect.gen(function* () {
        if (input.authorization.workspaceId.length === 0) {
          return yield* fail("unauthorized", "seal-profile");
        }
        const now = yield* dependencies.now;
        const provider = yield* dependencies.logins.getProvider(
          input.authorization.workspaceId,
          input.loginId,
        );
        const requestFingerprint = digest(
          [
            input.loginId,
            input.profileId,
            provider.instanceId,
            provider.driver,
            input.label,
            input.expiresAt ?? null,
          ]
            .map((part) => {
              const value = part ?? "";
              return `${Buffer.byteLength(value, "utf8")}:${value}`;
            })
            .join("|"),
        );
        const existing = yield* dependencies.store
          .findProfileByIdempotency(
            input.authorization.workspaceId,
            provider.instanceId,
            input.idempotencyKey,
          )
          .pipe(Effect.mapError(mapFailure("seal-profile")));
        if (existing !== undefined) {
          if (existing.requestFingerprint !== requestFingerprint) {
            return yield* fail("idempotencyConflict", "seal-profile");
          }
          return profileMetadata(existing);
        }
        const login = yield* dependencies.logins
          .consumeCredential(input.authorization.workspaceId, input.loginId)
          .pipe(Effect.mapError(mapFailure("consume-login")));
        if (!sameProvider(provider, login.provider)) {
          return yield* fail("providerMismatch", "consume-login");
        }
        if (login.profileId !== input.profileId) {
          return yield* fail("idempotencyConflict", "seal-profile-binding");
        }
        const record = yield* dependencies.store
          .sealProfile({
            workspaceId: input.authorization.workspaceId,
            profileId: input.profileId,
            provider: login.provider,
            label: input.label,
            state: "active",
            generation: 1,
            envelope: login.envelope,
            idempotencyKey: input.idempotencyKey,
            requestFingerprint,
            createdAt: now,
            updatedAt: now,
            ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
          })
          .pipe(Effect.mapError(mapFailure("seal-profile")));
        return profileMetadata(record);
      }),
    validate: (input) =>
      Effect.gen(function* () {
        const now = yield* dependencies.now;
        const profile = yield* loadProfile(input.authorization.workspaceId, input.profileId);
        const status =
          profile.state === "revoked"
            ? "revoked"
            : profile.expiresAt !== undefined && profile.expiresAt <= now
              ? "expired"
              : profile.state === "expired"
                ? "expired"
                : isProviderCredentialEnvelopeMetadataValid(profile.envelope)
                  ? "valid"
                  : "invalid";
        return {
          profileId: profile.profileId,
          workspaceId: profile.workspaceId,
          status,
          checkedAt: now,
          ...(status === "invalid" ? { reason: "invalid-envelope-metadata" } : {}),
        };
      }),
    materialize: (input) =>
      Effect.gen(function* () {
        const now = yield* dependencies.now;
        const target = yield* dependencies.authorizer.authorize({
          principal: input.authorization,
          threadId: input.threadId,
          profileId: input.profileId,
        });
        if (
          target.workspaceId !== input.authorization.workspaceId ||
          target.threadId !== input.threadId ||
          target.authorizationExpiresAt <= now
        )
          return yield* fail("unauthorized", "materialize-target");
        const profile = yield* loadProfile(input.authorization.workspaceId, input.profileId);
        if (
          profile.state !== "active" ||
          (profile.expiresAt !== undefined && profile.expiresAt <= now)
        ) {
          return yield* fail("profileUnavailable", "materialize");
        }
        if (!sameProvider(profile.provider, target.provider)) {
          return yield* fail("providerMismatch", "materialize");
        }
        const targetPath = `provider/${profile.provider.driver}/${profile.profileId}`;
        const materialization = yield* dependencies.store
          .reserveMaterialization({
            workspaceId: input.authorization.workspaceId,
            materializationId: input.materializationId,
            profileId: input.profileId,
            providerInstanceId: profile.provider.instanceId,
            providerDriver: profile.provider.driver,
            threadId: target.threadId,
            environmentId: target.environmentId,
            sandboxId: target.sandboxId,
            workerId: target.workerId,
            targetPath,
            targetPathSha256: digest(targetPath),
            authorizationSessionId: input.authorization.authSessionId,
            authorizationExpiresAt: target.authorizationExpiresAt,
            createdAt: now,
          })
          .pipe(Effect.mapError(mapFailure("reserve-materialization")));
        const resultMetadata = (materializedAt: string): AgentConnectionMaterializeResult => ({
          materializationId: input.materializationId,
          profileId: input.profileId,
          workspaceId: input.authorization.workspaceId,
          threadId: target.threadId,
          environmentId: target.environmentId,
          sandboxId: target.sandboxId,
          materializationRef: `worker:${target.workerId}:provider-profile:${input.materializationId}`,
          materializedAt,
          expiresAt: target.authorizationExpiresAt,
        });
        if (materialization.authorizationExpiresAt <= now) {
          yield* dependencies.store
            .requireCleanup(
              input.authorization.workspaceId,
              input.materializationId,
              "authorization_expired",
              undefined,
              now,
            )
            .pipe(Effect.mapError(mapFailure("expire-materialization")));
          yield* cleanupRecords([materialization], "authorization_expired");
          return yield* fail("expiredAuthorization", "materialize-expired");
        }
        if (materialization.state === "active") {
          return resultMetadata(materialization.materializedAt ?? materialization.createdAt);
        }
        if (materialization.state === "cleanup_required") {
          yield* cleanupRecords([materialization], "retry_cleanup");
          return yield* fail("profileUnavailable", "materialize-cleanup-required");
        }
        if (materialization.state === "cleaned") {
          return yield* fail("idempotencyConflict", "materialize-cleaned");
        }
        if (materialization.state === "reserved") {
          yield* dependencies.store
            .markDispatched(
              input.authorization.workspaceId,
              input.materializationId,
              materialization.profileGeneration,
              now,
            )
            .pipe(Effect.mapError(mapFailure("mark-materialization-dispatched")));
        }
        const plaintext = yield* openProviderCredentialPayload({
          envelope: profile.envelope,
          context: {
            workspaceId: profile.workspaceId,
            profileId: profile.profileId,
            provider: profile.provider,
          },
          keyEncryption: dependencies.keyEncryption,
          ...(dependencies.crypto === undefined ? {} : { crypto: dependencies.crypto }),
        }).pipe(Effect.mapError(mapFailure("materialize")));
        const result = yield* dependencies.worker
          .dispatch({
            target,
            command: {
              type: "provider.credentials.command",
              operation: "materialize",
              operationId: input.materializationId,
              routeGeneration: target.identity.routeGeneration,
              profileId: input.profileId,
              profileGeneration: materialization.profileGeneration,
              providerInstanceId: profile.provider.instanceId,
              providerDriver: profile.provider.driver,
              authorizationExpiresAt: target.authorizationExpiresAt,
              credentialPayloadBytes: plaintext.withValue((bytes) => bytes.byteLength),
            },
            credentialPayload: plaintext,
          })
          .pipe(
            Effect.ensuring(Effect.sync(() => plaintext.withValue((bytes) => bytes.fill(0)))),
            Effect.result,
          );
        if (
          result._tag === "Failure" ||
          result.success.operation !== "materialize" ||
          result.success.outcome !== "materialized"
        ) {
          const detail =
            result._tag === "Failure"
              ? result.failure.code
              : result.success.operation === "materialize"
                ? (result.success.errorCode ?? "worker_materialization_failed")
                : "worker_result_mismatch";
          yield* dependencies.store
            .requireCleanup(
              input.authorization.workspaceId,
              input.materializationId,
              "materialization_failed",
              detail,
              now,
            )
            .pipe(Effect.mapError(mapFailure("persist-materialization-failure")));
          return yield* fail("materializationFailed", "materialize", detail);
        }
        const confirmationAt = yield* dependencies.now;
        const accepted = yield* dependencies.store
          .confirmMaterialized(
            input.authorization.workspaceId,
            input.materializationId,
            materialization.profileGeneration,
            confirmationAt,
          )
          .pipe(Effect.mapError(mapFailure("confirm-materialized")));
        if (!accepted) {
          const fenced = yield* dependencies.store
            .listLiveMaterializations(input.authorization.workspaceId, {
              profileId: input.profileId,
              sandboxId: target.sandboxId,
            })
            .pipe(Effect.mapError(mapFailure("load-fenced-materialization")));
          yield* cleanupRecords(fenced, "stale_generation");
          return yield* fail("profileUnavailable", "materialize-fenced");
        }
        return resultMetadata(confirmationAt);
      }),
    revoke: (input) =>
      Effect.gen(function* () {
        const now = yield* dependencies.now;
        const profile = yield* dependencies.store
          .revokeProfile(input.authorization.workspaceId, input.profileId, now)
          .pipe(Effect.mapError(mapFailure("revoke-profile")));
        const materializations = yield* dependencies.store
          .listLiveMaterializations(input.authorization.workspaceId, { profileId: input.profileId })
          .pipe(Effect.mapError(mapFailure("list-profile-materializations")));
        yield* cleanupRecords(materializations, "revoked");
        return profileMetadata(profile);
      }),
    cleanupLifecycle: (input) =>
      Effect.gen(function* () {
        const now = yield* dependencies.now;
        const records = yield* dependencies.store
          .fenceLifecycleMaterializations(
            input.workspaceId,
            input.threadId,
            input.sandboxId,
            input.reason,
            now,
          )
          .pipe(Effect.mapError(mapFailure("fence-lifecycle-materializations")));
        if (records.length === 0) return;
        yield* cleanupRecords(
          records,
          input.reason,
          input.workerOverride ?? dependencies.worker,
        ).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Provider credential lifecycle cleanup deferred", {
              reason: input.reason,
              code: cause.code,
            }),
          ),
        );
      }),
    reconcileWorker: (input) =>
      Effect.gen(function* () {
        const now = yield* dependencies.now;
        yield* dependencies.store
          .expireMaterializations(input.workspaceId, now, input.sandboxId)
          .pipe(Effect.mapError(mapFailure("expire-reconnect-materializations")));
        yield* dependencies.store
          .fenceUnconfirmed(input.workspaceId, input.sandboxId, "worker_reconnect", now)
          .pipe(Effect.mapError(mapFailure("fence-unconfirmed")));
        const records = yield* dependencies.store
          .listLiveMaterializations(input.workspaceId, { sandboxId: input.sandboxId })
          .pipe(Effect.mapError(mapFailure("list-reconnect-cleanup")));
        const cleanup = records.filter((record) => record.state === "cleanup_required");
        if (cleanup.length > 0)
          yield* cleanupRecords(
            cleanup,
            "worker_reconnect",
            input.workerOverride ?? dependencies.worker,
            input.workerOverride?.attestedProvisionalIdentity,
          );
        const active = records.filter(
          (record) => record.state === "active" && record.authorizationExpiresAt > now,
        );
        yield* Effect.forEach(
          active,
          (record) =>
            Effect.gen(function* () {
              const target = yield* dependencies.authorizer.resolveSystem({
                workspaceId: record.workspaceId,
                threadId: record.threadId,
                profileId: record.profileId,
                ...(input.workerOverride?.attestedProvisionalIdentity === undefined
                  ? {}
                  : {
                      provisionalIdentity: input.workerOverride.attestedProvisionalIdentity,
                    }),
              });
              const dispatch = yield* (input.workerOverride ?? dependencies.worker)
                .dispatch({
                  target,
                  command: {
                    type: "provider.credentials.command",
                    operation: "lease.arm",
                    operationId: record.materializationId,
                    routeGeneration: target.identity.routeGeneration,
                    profileId: record.profileId,
                    profileGeneration: record.profileGeneration,
                    providerInstanceId: record.providerInstanceId,
                    providerDriver: record.providerDriver,
                    authorizationExpiresAt: record.authorizationExpiresAt,
                  },
                })
                .pipe(Effect.result);
              if (
                dispatch._tag === "Success" &&
                dispatch.success.operation === "lease.arm" &&
                dispatch.success.outcome === "absent"
              ) {
                const confirmed = yield* dependencies.store
                  .confirmAbsent(
                    record.workspaceId,
                    record.materializationId,
                    record.profileGeneration,
                    now,
                    "worker_reconnect_absent",
                  )
                  .pipe(Effect.mapError(mapFailure("confirm-reconnect-absence")));
                if (!confirmed) {
                  yield* dependencies.store
                    .requireCleanup(
                      record.workspaceId,
                      record.materializationId,
                      "worker_reconnect_generation_fenced",
                      "confirm_absent_rejected",
                      now,
                    )
                    .pipe(Effect.mapError(mapFailure("persist-reconnect-absence-fence")));
                  return yield* fail("cleanupFailed", "reconnect-absence-generation-fenced");
                }
                return;
              }
              if (
                dispatch._tag === "Failure" ||
                dispatch.success.operation !== "lease.arm" ||
                dispatch.success.outcome !== "armed"
              ) {
                const detail =
                  dispatch._tag === "Failure"
                    ? dispatch.failure.code
                    : dispatch.success.operation === "lease.arm"
                      ? (dispatch.success.errorCode ?? "worker_lease_rearm_failed")
                      : "worker_result_mismatch";
                yield* dependencies.store
                  .requireCleanup(
                    record.workspaceId,
                    record.materializationId,
                    "lease_rearm_failed",
                    detail,
                    now,
                  )
                  .pipe(Effect.mapError(mapFailure("persist-lease-rearm-failure")));
                return yield* fail("cleanupFailed", "lease-rearm", detail);
              }
            }),
          { concurrency: 1, discard: true },
        );
      }),
    sweepExpired: Effect.gen(function* () {
      const now = yield* dependencies.now;
      const retryAt = DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(now), { seconds: 30 }));
      const due = yield* dependencies.store
        .claimDueCleanup(now, retryAt, 64)
        .pipe(Effect.mapError(mapFailure("claim-expired-materializations")));
      if (due.length > 0) yield* cleanupRecords(due, "authorization_expired");
    }),
  };
};
