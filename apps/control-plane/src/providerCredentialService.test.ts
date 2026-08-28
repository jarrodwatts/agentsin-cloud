import type {
  AuthSessionId,
  EnvironmentId,
  ProviderInstanceRef,
  ThreadId,
} from "@t3tools/contracts";
import type {
  AgentLoginId,
  AgentMaterializationId,
  AgentProfileId,
  SandboxId,
  WorkspaceId,
} from "@t3tools/contracts/cloud";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";

import {
  nodeProviderCredentialCrypto,
  providerCredentialEnvelopeAad,
  type ProviderCredentialCrypto,
  type ProviderCredentialKeyEncryption,
} from "./providerCredentialEnvelope.ts";
import {
  makeProviderCredentialService,
  type AuthorizedProviderCredentialTarget,
  type ProviderCredentialTargetAuthorizer,
  ProviderCredentialServiceError,
} from "./providerCredentialService.ts";
import { makeLifecycleProviderCredentialTargetAuthorizer } from "./providerCredentialProduction.ts";
import type { CloudThreadLifecycleStore } from "./cloudThreadLifecycleStore.ts";
import { makeInMemoryWorkerRouteRegistry, type WorkerRelay } from "./workerRelay.ts";
import type {
  ProviderCredentialMaterializationRecord,
  ProviderCredentialProfileRecord,
  ProviderCredentialStore,
} from "./providerCredentialStore.ts";
import { ProviderCredentialStoreError } from "./providerCredentialStore.ts";
import { Secret } from "./providerSecrets.ts";
import type { WorkerInstanceId } from "@t3tools/contracts/worker";

const workspaceA = "11111111-1111-4111-8111-111111111111" as WorkspaceId;
const workspaceB = "22222222-2222-4222-8222-222222222222" as WorkspaceId;
const profileId = "profile-a" as AgentProfileId;
const loginId = "login-a" as AgentLoginId;
const sandboxId = "sandbox-a" as SandboxId;
const provider = { instanceId: "codex_work", driver: "codex" } as ProviderInstanceRef;
const now = "2026-08-27T12:00:00.000Z";
const later = "2026-08-27T12:05:00.000Z";
const auth = {
  workspaceId: workspaceA,
  authSessionId: "session-a" as AuthSessionId,
  userId: "user-a",
};
const workerId = "worker-a" as WorkerInstanceId;

class MemoryStore implements ProviderCredentialStore {
  readonly profiles = new Map<string, ProviderCredentialProfileRecord>();
  readonly idempotency = new Map<string, ProviderCredentialProfileRecord>();
  readonly materializations = new Map<string, ProviderCredentialMaterializationRecord>();
  key(workspaceId: WorkspaceId, id: string) {
    return `${workspaceId}:${id}`;
  }
  findProfileByIdempotency(
    workspaceId: WorkspaceId,
    providerInstanceId: ProviderInstanceRef["instanceId"],
    idempotencyKey: string,
  ) {
    return Effect.succeed(
      this.idempotency.get(this.key(workspaceId, `${providerInstanceId}:${idempotencyKey}`)),
    );
  }
  sealProfile(record: ProviderCredentialProfileRecord) {
    const key = this.key(
      record.workspaceId,
      `${record.provider.instanceId}:${record.idempotencyKey}`,
    );
    const existing = this.idempotency.get(key);
    if (existing !== undefined && existing.requestFingerprint !== record.requestFingerprint) {
      return Effect.fail(
        new ProviderCredentialStoreError({ code: "idempotencyConflict", operation: "seal" }),
      );
    }
    const value = existing ?? record;
    this.profiles.set(this.key(value.workspaceId, value.profileId), value);
    this.idempotency.set(key, value);
    return Effect.succeed(value);
  }
  getProfile(workspaceId: WorkspaceId, id: AgentProfileId) {
    return Effect.succeed(this.profiles.get(this.key(workspaceId, id)));
  }
  revokeProfile(workspaceId: WorkspaceId, id: AgentProfileId, revokedAt: string) {
    const record = this.profiles.get(this.key(workspaceId, id));
    if (record === undefined)
      return Effect.fail(
        new ProviderCredentialStoreError({ code: "notFound", operation: "revoke" }),
      );
    const revoked = {
      ...record,
      state: "revoked" as const,
      generation: record.generation + 1,
      revokedAt,
      updatedAt: revokedAt,
    };
    this.profiles.set(this.key(workspaceId, id), revoked);
    for (const [key, materialization] of this.materializations) {
      if (materialization.workspaceId === workspaceId && materialization.profileId === id) {
        this.materializations.set(key, {
          ...materialization,
          state: "cleanup_required",
          cleanupReason: "revoked",
        });
      }
    }
    return Effect.succeed(revoked);
  }
  reserveMaterialization(
    record: Omit<
      ProviderCredentialMaterializationRecord,
      | "profileGeneration"
      | "state"
      | "dispatchedAt"
      | "materializedAt"
      | "cleanedAt"
      | "cleanupReason"
      | "cleanupAttempts"
      | "cleanupLastError"
      | "cleanupNextAttemptAt"
    >,
  ) {
    const key = this.key(record.workspaceId, record.materializationId);
    const existing = this.materializations.get(key);
    const profile = this.profiles.get(this.key(record.workspaceId, record.profileId))!;
    const reserved: ProviderCredentialMaterializationRecord = {
      ...record,
      profileGeneration: profile.generation,
      state: "reserved",
      cleanupAttempts: 0,
    };
    this.materializations.set(key, existing ?? reserved);
    return Effect.succeed(existing ?? reserved);
  }
  markDispatched(
    workspaceId: WorkspaceId,
    id: AgentMaterializationId,
    profileGeneration: number,
    dispatchedAt: string,
  ) {
    const key = this.key(workspaceId, id);
    const record = this.materializations.get(key)!;
    if (record.state !== "reserved" || record.profileGeneration !== profileGeneration) {
      return Effect.fail(
        new ProviderCredentialStoreError({ code: "stateConflict", operation: "dispatch" }),
      );
    }
    const dispatched = { ...record, state: "dispatched" as const, profileGeneration, dispatchedAt };
    this.materializations.set(key, dispatched);
    return Effect.succeed(dispatched);
  }
  confirmMaterialized(
    workspaceId: WorkspaceId,
    id: AgentMaterializationId,
    profileGeneration: number,
    materializedAt: string,
  ) {
    const key = this.key(workspaceId, id);
    const record = this.materializations.get(key);
    if (
      record === undefined ||
      (record.state !== "dispatched" &&
        record.state !== "cleanup_required" &&
        record.state !== "cleaned")
    )
      return Effect.succeed(false);
    const profile = this.profiles.get(this.key(workspaceId, record.profileId))!;
    const accepted =
      record.state === "dispatched" &&
      profile.state === "active" &&
      profile.generation === profileGeneration &&
      record.authorizationExpiresAt > materializedAt;
    const { cleanedAt: previousCleanedAt, ...withoutCleanedAt } = record;
    void previousCleanedAt;
    this.materializations.set(key, {
      ...withoutCleanedAt,
      state: accepted ? "active" : "cleanup_required",
      materializedAt,
    });
    return Effect.succeed(accepted);
  }
  requireCleanup(
    workspaceId: WorkspaceId,
    id: AgentMaterializationId,
    reason: string,
    error: string | undefined,
    nextAttemptAt: string,
  ) {
    const key = this.key(workspaceId, id);
    const record = this.materializations.get(key)!;
    this.materializations.set(key, {
      ...record,
      state: "cleanup_required",
      cleanupReason: reason,
      cleanupAttempts: record.cleanupAttempts + 1,
      ...(error === undefined ? {} : { cleanupLastError: error }),
      cleanupNextAttemptAt: nextAttemptAt,
    });
    return Effect.void;
  }
  confirmAbsent(
    workspaceId: WorkspaceId,
    id: AgentMaterializationId,
    profileGeneration: number,
    cleanedAt: string,
    reason: string,
  ) {
    const key = this.key(workspaceId, id);
    const record = this.materializations.get(key)!;
    if (record.profileGeneration !== profileGeneration) return Effect.succeed(false);
    this.materializations.set(key, {
      ...record,
      state: "cleaned",
      cleanedAt,
      cleanupReason: reason,
    });
    return Effect.succeed(true);
  }
  fenceUnconfirmed(workspaceId: WorkspaceId, targetSandboxId: SandboxId) {
    const fenced: Array<ProviderCredentialMaterializationRecord> = [];
    for (const [key, record] of this.materializations) {
      if (
        record.workspaceId === workspaceId &&
        record.sandboxId === targetSandboxId &&
        (record.state === "reserved" || record.state === "dispatched")
      ) {
        const next = { ...record, state: "cleanup_required" as const };
        this.materializations.set(key, next);
        fenced.push(next);
      }
    }
    return Effect.succeed(fenced);
  }
  fenceLifecycleMaterializations(
    workspaceId: WorkspaceId,
    threadId: ThreadId,
    targetSandboxId: SandboxId | undefined,
    reason: string,
    nextAttemptAt: string,
  ) {
    const fenced: Array<ProviderCredentialMaterializationRecord> = [];
    for (const [key, record] of this.materializations) {
      if (
        record.workspaceId !== workspaceId ||
        record.threadId !== threadId ||
        (targetSandboxId !== undefined && record.sandboxId !== targetSandboxId) ||
        record.state === "cleaned"
      )
        continue;
      const next = {
        ...record,
        state: "cleanup_required" as const,
        cleanupReason: reason,
        cleanupNextAttemptAt: nextAttemptAt,
      };
      this.materializations.set(key, next);
      fenced.push(next);
    }
    return Effect.succeed(fenced);
  }
  expireMaterializations(workspaceId: WorkspaceId, at: string, targetSandboxId?: SandboxId) {
    const expired: Array<ProviderCredentialMaterializationRecord> = [];
    for (const [key, record] of this.materializations) {
      if (
        record.workspaceId !== workspaceId ||
        (targetSandboxId !== undefined && record.sandboxId !== targetSandboxId) ||
        record.authorizationExpiresAt > at ||
        (record.state !== "reserved" && record.state !== "dispatched" && record.state !== "active")
      )
        continue;
      const next = {
        ...record,
        state: "cleanup_required" as const,
        cleanupReason: "authorization_expired",
        cleanupNextAttemptAt: at,
      };
      this.materializations.set(key, next);
      expired.push(next);
    }
    return Effect.succeed(expired);
  }
  claimDueCleanup(at: string, retryAt: string, limit: number) {
    const due: Array<ProviderCredentialMaterializationRecord> = [];
    for (const [key, record] of this.materializations) {
      if (due.length >= limit) break;
      const expired =
        (record.state === "reserved" ||
          record.state === "dispatched" ||
          record.state === "active") &&
        record.authorizationExpiresAt <= at;
      const retry =
        record.state === "cleanup_required" &&
        (record.cleanupNextAttemptAt === undefined || record.cleanupNextAttemptAt <= at);
      if (!expired && !retry) continue;
      const next = {
        ...record,
        state: "cleanup_required" as const,
        cleanupReason: expired
          ? "authorization_expired"
          : (record.cleanupReason ?? "cleanup_retry"),
        cleanupAttempts: record.cleanupAttempts + 1,
        cleanupNextAttemptAt: retryAt,
      };
      this.materializations.set(key, next);
      due.push(next);
    }
    return Effect.succeed(due);
  }
  listLiveMaterializations(
    workspaceId: WorkspaceId,
    selector: { readonly profileId?: AgentProfileId; readonly sandboxId?: SandboxId },
  ) {
    return Effect.succeed(
      [...this.materializations.values()].filter(
        (record) =>
          record.workspaceId === workspaceId &&
          record.state !== "cleaned" &&
          (selector.profileId === undefined || record.profileId === selector.profileId) &&
          (selector.sandboxId === undefined || record.sandboxId === selector.sandboxId),
      ),
    );
  }
}

const testDek = new Uint8Array(32).fill(0x7b);
const keyEncryption: ProviderCredentialKeyEncryption = {
  kmsKeyId: "test-kms-key",
  activeKeyVersion: "test-v1",
  wrap: (dek) =>
    Effect.succeed({
      keyVersion: "test-v1",
      wrappedKey: dek.withValue((bytes) => Uint8Array.from(bytes)),
    }),
  unwrap: () => Effect.succeed(Secret.make(Uint8Array.from(testDek))),
};
const profileEnvelope = (() => {
  const nonce = new Uint8Array(12).fill(0x43);
  const aad = providerCredentialEnvelopeAad(
    { workspaceId: workspaceA, profileId, provider },
    keyEncryption.activeKeyVersion,
  );
  try {
    const encrypted = nodeProviderCredentialCrypto.encrypt({
      key: testDek,
      nonce,
      aad,
      plaintext: Buffer.from("opaque-provider-profile"),
    });
    return {
      envelopeVersion: 1 as const,
      keyVersion: keyEncryption.activeKeyVersion,
      wrappedKey: new Uint8Array(32).fill(0x51),
      nonce,
      authTag: encrypted.authTag,
      ciphertext: encrypted.ciphertext,
    };
  } finally {
    aad.fill(0);
  }
})();

const harness = (options?: {
  readonly dispatch?: Parameters<typeof makeProviderCredentialService>[0]["worker"]["dispatch"];
  readonly crypto?: ProviderCredentialCrypto;
  readonly keyEncryption?: ProviderCredentialKeyEncryption;
  readonly authorizer?: ProviderCredentialTargetAuthorizer;
  readonly now?: Effect.Effect<string>;
}) => {
  const store = new MemoryStore();
  let consumed = 0;
  const logins = {
    getProvider: (workspaceId: WorkspaceId, requestedLoginId: AgentLoginId) =>
      workspaceId === workspaceA && requestedLoginId === loginId
        ? Effect.succeed(provider)
        : Effect.die("unexpected login"),
    consumeCredential: (workspaceId: WorkspaceId, requestedLoginId: AgentLoginId) => {
      if (workspaceId !== workspaceA || requestedLoginId !== loginId) {
        return Effect.die("unexpected login");
      }
      consumed += 1;
      return Effect.succeed({
        provider,
        profileId,
        envelope: profileEnvelope,
      });
    },
  };
  const writes: Array<string> = [];
  const removals: Array<string> = [];
  const target = {
    workspaceId: workspaceA,
    threadId: "thread-a" as ThreadId,
    environmentId: "environment-a" as EnvironmentId,
    sandboxId,
    workerId,
    provider,
    active: true as const,
    authorizationExpiresAt: later,
    identity: {
      workspaceId: workspaceA,
      threadId: "thread-a" as ThreadId,
      environmentId: "environment-a" as EnvironmentId,
      environmentRevisionId: "revision-a",
      sandboxId,
      reservationId: "reservation-a",
      workerId,
      providerInstanceId: provider.instanceId,
      providerDriver: provider.driver,
      certificateFingerprint: "test-fingerprint",
      certificateGeneration: 1,
      leaseGeneration: 1,
      routeGeneration: 1,
      processInstanceId: "test-control-plane",
      state: "connected" as const,
      connectedAt: now,
      lastSeenAt: now,
      heartbeatSequence: 1,
      confirmedEventCursor: 0,
    },
  } as AuthorizedProviderCredentialTarget;
  const service = makeProviderCredentialService({
    logins,
    store,
    keyEncryption: options?.keyEncryption ?? keyEncryption,
    authorizer: options?.authorizer ?? {
      authorize: ({ principal }) =>
        principal.workspaceId === workspaceA
          ? Effect.succeed(target)
          : Effect.fail(
              new ProviderCredentialServiceError({ code: "unauthorized", operation: "test" }),
            ),
      resolveSystem: () => Effect.succeed(target),
    },
    worker: {
      dispatch:
        options?.dispatch ??
        (({ command, credentialPayload }) =>
          Effect.sync(() => {
            if (command.operation === "materialize") {
              writes.push(
                credentialPayload?.withValue((bytes) => Buffer.from(bytes).toString("utf8")) ?? "",
              );
              return {
                type: "provider.credentials.result" as const,
                operation: "materialize" as const,
                operationId: command.operationId,
                routeGeneration: command.routeGeneration,
                profileGeneration: command.profileGeneration,
                outcome: "materialized" as const,
                occurredAt: now,
              };
            }
            if (command.operation === "cleanup") {
              removals.push(`${sandboxId}:${command.operationId}`);
              return {
                type: "provider.credentials.result" as const,
                operation: "cleanup" as const,
                operationId: command.operationId,
                routeGeneration: command.routeGeneration,
                profileGeneration: command.profileGeneration,
                outcome: "absent" as const,
                occurredAt: now,
              };
            }
            throw new Error("unexpected command");
          })),
    },
    ...(options?.crypto === undefined ? {} : { crypto: options.crypto }),
    now: options?.now ?? Effect.succeed(now),
  });
  return { store, service, writes, removals, consumed: () => consumed };
};

const seedMaterialization = (
  test: ReturnType<typeof harness>,
  materializationId: AgentMaterializationId,
  state: "dispatched" | "active" | "cleanup_required",
) => {
  test.store.materializations.set(test.store.key(workspaceA, materializationId), {
    workspaceId: workspaceA,
    materializationId,
    profileId,
    profileGeneration: 1,
    providerInstanceId: provider.instanceId,
    providerDriver: provider.driver,
    threadId: "thread-a" as ThreadId,
    environmentId: "environment-a" as EnvironmentId,
    sandboxId,
    workerId,
    targetPath: `provider/${provider.driver}/${profileId}`,
    targetPathSha256: "test-target-digest",
    authorizationSessionId: auth.authSessionId,
    authorizationExpiresAt: later,
    state,
    createdAt: now,
    dispatchedAt: now,
    ...(state === "active" ? { materializedAt: now } : {}),
    cleanupAttempts: state === "cleanup_required" ? 1 : 0,
    ...(state === "cleanup_required" ? { cleanupReason: "worker_reconnect" } : {}),
  });
};

it.effect("seals idempotently without exposing or consuming the opaque login twice", () =>
  Effect.gen(function* () {
    const test = harness();
    const request = {
      authorization: auth,
      loginId,
      profileId,
      label: "Work account",
      idempotencyKey: "seal-once",
    };
    const first = yield* test.service.sealProfile(request);
    const second = yield* test.service.sealProfile(request);
    expect(first).toEqual(second);
    expect(first.keyVersion).toBe("test-v1");
    expect(test.consumed()).toBe(1);
    const stored = test.store.profiles.get(test.store.key(workspaceA, profileId))!;
    expect(Buffer.from(stored.envelope.ciphertext).toString("utf8")).not.toContain(
      "opaque-provider-profile",
    );
  }),
);

it.effect("rearms active credentials through the provisional reconnect transport", () =>
  Effect.gen(function* () {
    let defaultDispatches = 0;
    let provisionalDispatches = 0;
    const test = harness({
      dispatch: () => {
        defaultDispatches += 1;
        return Effect.fail(
          new ProviderCredentialServiceError({
            code: "materializationFailed",
            operation: "unpublished-route",
          }),
        );
      },
    });
    const materializationId = "materialization-active-reconnect" as AgentMaterializationId;
    seedMaterialization(test, materializationId, "active");

    yield* test.service.reconcileWorker({
      workspaceId: workspaceA,
      sandboxId,
      workerOverride: {
        dispatch: ({ command }) => {
          provisionalDispatches += 1;
          expect(command.operation).toBe("lease.arm");
          return Effect.succeed({
            type: "provider.credentials.result" as const,
            operation: "lease.arm" as const,
            operationId: command.operationId,
            routeGeneration: command.routeGeneration,
            profileGeneration: command.profileGeneration,
            outcome: "armed" as const,
            occurredAt: now,
          });
        },
      },
    });

    expect(defaultDispatches).toBe(0);
    expect(provisionalDispatches).toBe(1);
    expect(
      test.store.materializations.get(test.store.key(workspaceA, materializationId))?.state,
    ).toBe("active");
  }),
);

it.effect(
  "authorizes only the attested provisional route before production reconnect publication",
  () =>
    Effect.gen(function* () {
      const routes = makeInMemoryWorkerRouteRegistry();
      const provisionalIdentity = {
        workspaceId: workspaceA,
        threadId: "thread-a" as ThreadId,
        environmentId: "environment-a" as EnvironmentId,
        environmentRevisionId: "revision-a",
        sandboxId,
        reservationId: "reservation-a",
        workerId,
        providerInstanceId: provider.instanceId,
        providerDriver: provider.driver,
        certificateFingerprint: "test-fingerprint",
        certificateGeneration: 1,
        leaseGeneration: 1,
        routeGeneration: 7,
        processInstanceId: "test-control-plane",
        state: "connected" as const,
        connectedAt: now,
        lastSeenAt: now,
        heartbeatSequence: 1,
        confirmedEventCursor: 0,
      } as AuthorizedProviderCredentialTarget["identity"];
      const lifecycle = {
        getCurrent: async () => ({
          workspaceId: workspaceA,
          threadId: "thread-a" as ThreadId,
          attemptId: "attempt-a",
          idempotencyKey: "attempt-a",
          requestFingerprint: "request-a",
          environmentId: "environment-a" as EnvironmentId,
          environmentRevisionId: "revision-a",
          environmentRevisionHash: "revision-hash-a",
          projectId: "project-a",
          providerInstanceId: provider.instanceId,
          providerDriver: provider.driver,
          repositoryIdentity: { owner: "agents", name: "cloud", provider: "github" },
          workspaceDirectory: "/workspace",
          state: "ready" as const,
          isCurrent: true,
          sandboxId,
          workerId,
          createdAt: now,
          updatedAt: now,
        }),
      } as unknown as CloudThreadLifecycleStore;
      const authorizer = makeLifecycleProviderCredentialTargetAuthorizer({
        lifecycle,
        relay: { routes } as WorkerRelay,
        now: Effect.succeed(now),
      });
      expect(
        (yield* authorizer
          .resolveSystem({
            workspaceId: workspaceA,
            threadId: "thread-a" as ThreadId,
            profileId,
          })
          .pipe(Effect.exit))._tag,
      ).toBe("Failure");

      const operations: Array<string> = [];
      const test = harness({ authorizer });
      const activeId = "materialization-production-active" as AgentMaterializationId;
      const cleanupId = "materialization-production-cleanup" as AgentMaterializationId;
      seedMaterialization(test, activeId, "active");
      seedMaterialization(test, cleanupId, "cleanup_required");
      yield* test.service.reconcileWorker({
        workspaceId: workspaceA,
        sandboxId,
        workerOverride: {
          attestedProvisionalIdentity: provisionalIdentity,
          dispatch: ({ command, target }) =>
            Effect.sync(() => {
              expect(routes.size()).toBe(0);
              expect(target.identity).toEqual(provisionalIdentity);
              operations.push(command.operation);
              return command.operation === "cleanup"
                ? {
                    type: "provider.credentials.result" as const,
                    operation: "cleanup" as const,
                    operationId: command.operationId,
                    routeGeneration: command.routeGeneration,
                    profileGeneration: command.profileGeneration,
                    outcome: "absent" as const,
                    occurredAt: now,
                  }
                : {
                    type: "provider.credentials.result" as const,
                    operation: "lease.arm" as const,
                    operationId: command.operationId,
                    routeGeneration: command.routeGeneration,
                    profileGeneration: command.profileGeneration,
                    outcome: "armed" as const,
                    occurredAt: now,
                  };
            }),
        },
      });
      expect(operations).toEqual(["cleanup", "lease.arm"]);
      expect(test.store.materializations.get(test.store.key(workspaceA, cleanupId))?.state).toBe(
        "cleaned",
      );
      expect(test.store.materializations.get(test.store.key(workspaceA, activeId))?.state).toBe(
        "active",
      );
      expect(
        routes.activate({ lease: provisionalIdentity, send: () => true, close: () => {} }),
      ).toMatchObject({ accepted: true });
      expect(routes.size()).toBe(1);
    }),
);

it.effect("keeps reconnect fenced and persists retry when active lease rearm fails", () =>
  Effect.gen(function* () {
    const test = harness();
    const materializationId = "materialization-active-rearm-failure" as AgentMaterializationId;
    seedMaterialization(test, materializationId, "active");

    expect(
      (yield* test.service
        .reconcileWorker({
          workspaceId: workspaceA,
          sandboxId,
          workerOverride: {
            dispatch: () =>
              Effect.fail(
                new ProviderCredentialServiceError({
                  code: "materializationFailed",
                  operation: "provisional-route-lost",
                }),
              ),
          },
        })
        .pipe(Effect.exit))._tag,
    ).toBe("Failure");
    expect(
      test.store.materializations.get(test.store.key(workspaceA, materializationId)),
    ).toMatchObject({
      state: "cleanup_required",
      cleanupReason: "lease_rearm_failed",
      cleanupLastError: "materializationFailed",
    });
  }),
);

it.effect("durably fences lifecycle cleanup before dispatch and recovers after restart", () =>
  Effect.gen(function* () {
    let failCleanup = true;
    const test = harness({
      dispatch: ({ command }) => {
        if (command.operation !== "cleanup") return Effect.die("unexpected command");
        return failCleanup
          ? Effect.fail(
              new ProviderCredentialServiceError({
                code: "cleanupFailed",
                operation: "route-loss",
              }),
            )
          : Effect.succeed({
              type: "provider.credentials.result" as const,
              operation: "cleanup" as const,
              operationId: command.operationId,
              routeGeneration: command.routeGeneration,
              profileGeneration: command.profileGeneration,
              outcome: "absent" as const,
              occurredAt: now,
            });
      },
    });
    const materializationId = "materialization-lifecycle" as AgentMaterializationId;
    seedMaterialization(test, materializationId, "active");

    yield* test.service.cleanupLifecycle({
      workspaceId: workspaceA,
      threadId: "thread-a" as ThreadId,
      sandboxId,
      reason: "replaced",
    });
    expect(
      test.store.materializations.get(test.store.key(workspaceA, materializationId)),
    ).toMatchObject({
      state: "cleanup_required",
      cleanupReason: "replaced",
      cleanupLastError: "cleanupFailed",
    });

    failCleanup = false;
    yield* test.service.reconcileWorker({ workspaceId: workspaceA, sandboxId });
    expect(
      test.store.materializations.get(test.store.key(workspaceA, materializationId))?.state,
    ).toBe("cleaned");
  }),
);

it.effect("tenant-scopes validation and rejects a non-member materialization before writes", () =>
  Effect.gen(function* () {
    const test = harness();
    yield* test.service.sealProfile({
      authorization: auth,
      loginId,
      profileId,
      label: "Work account",
      idempotencyKey: "seal",
    });
    expect(
      (yield* Effect.exit(
        test.service.validate({
          authorization: {
            workspaceId: workspaceB,
            authSessionId: auth.authSessionId,
            userId: "user-b",
          },
          profileId,
        }),
      ))._tag,
    ).toBe("Failure");
    const failure = yield* Effect.flip(
      test.service.materialize({
        authorization: { ...auth, workspaceId: workspaceB },
        threadId: "thread-a" as ThreadId,
        profileId,
        materializationId: "materialization-expired" as AgentMaterializationId,
      }),
    );
    expect(failure).toBeInstanceOf(ProviderCredentialServiceError);
    expect(failure.code).toBe("unauthorized");
    expect(test.writes).toEqual([]);
  }),
);

it.effect("materializes only an allowed active target and scrubs it on revoke", () =>
  Effect.gen(function* () {
    const test = harness();
    yield* test.service.sealProfile({
      authorization: auth,
      loginId,
      profileId,
      label: "Work account",
      idempotencyKey: "seal",
    });
    const materialized = yield* test.service.materialize({
      authorization: auth,
      threadId: "thread-a" as ThreadId,
      profileId,
      materializationId: "materialization-a" as AgentMaterializationId,
    });
    expect(materialized.sandboxId).toBe(sandboxId);
    expect(test.writes).toEqual(["opaque-provider-profile"]);
    const revoked = yield* test.service.revoke({ authorization: auth, profileId });
    expect(revoked.state).toBe("revoked");
    expect(test.removals).toEqual([`${sandboxId}:materialization-a`]);
    expect(
      test.store.materializations.get(test.store.key(workspaceA, "materialization-a"))?.state,
    ).toBe("cleaned");
  }),
);

it.effect("uses the post-dispatch clock and cleans a materialization at the expiry boundary", () =>
  Effect.gen(function* () {
    const clock = [now, now, later, later];
    let clockRead = 0;
    const operations: Array<string> = [];
    const test = harness({
      now: Effect.sync(() => clock[Math.min(clockRead++, clock.length - 1)]!),
      dispatch: ({ command }) =>
        Effect.sync(() => {
          operations.push(command.operation);
          return command.operation === "materialize"
            ? {
                type: "provider.credentials.result" as const,
                operation: "materialize" as const,
                operationId: command.operationId,
                routeGeneration: command.routeGeneration,
                profileGeneration: command.profileGeneration,
                outcome: "materialized" as const,
                occurredAt: later,
              }
            : {
                type: "provider.credentials.result" as const,
                operation: "cleanup" as const,
                operationId: command.operationId,
                routeGeneration: command.routeGeneration,
                profileGeneration: command.profileGeneration,
                outcome: "absent" as const,
                occurredAt: later,
              };
        }),
    });
    yield* test.service.sealProfile({
      authorization: auth,
      loginId,
      profileId,
      label: "Work account",
      idempotencyKey: "seal-expiry-boundary",
    });
    const materializationId = "materialization-expiry-boundary" as AgentMaterializationId;
    expect(
      (yield* test.service
        .materialize({
          authorization: auth,
          threadId: "thread-a" as ThreadId,
          profileId,
          materializationId,
        })
        .pipe(Effect.exit))._tag,
    ).toBe("Failure");
    expect(operations).toEqual(["materialize", "cleanup"]);
    expect(
      test.store.materializations.get(test.store.key(workspaceA, materializationId))?.state,
    ).toBe("cleaned");
  }),
);

it.effect("re-dispatches an uncertain dispatched materialization before reporting success", () =>
  Effect.gen(function* () {
    const test = harness();
    yield* test.service.sealProfile({
      authorization: auth,
      loginId,
      profileId,
      label: "Work account",
      idempotencyKey: "seal",
    });
    const materializationId = "materialization-dispatched" as AgentMaterializationId;
    seedMaterialization(test, materializationId, "dispatched");

    const result = yield* test.service.materialize({
      authorization: auth,
      threadId: "thread-a" as ThreadId,
      profileId,
      materializationId,
    });

    expect(result.materializationId).toBe(materializationId);
    expect(test.writes).toEqual(["opaque-provider-profile"]);
    expect(
      test.store.materializations.get(test.store.key(workspaceA, materializationId))?.state,
    ).toBe("active");
  }),
);

it.effect("scrubs cleanup-required state and never reports it as materialized", () =>
  Effect.gen(function* () {
    const test = harness();
    yield* test.service.sealProfile({
      authorization: auth,
      loginId,
      profileId,
      label: "Work account",
      idempotencyKey: "seal",
    });
    const materializationId = "materialization-cleanup" as AgentMaterializationId;
    seedMaterialization(test, materializationId, "cleanup_required");

    const failure = yield* Effect.flip(
      test.service.materialize({
        authorization: auth,
        threadId: "thread-a" as ThreadId,
        profileId,
        materializationId,
      }),
    );

    expect(failure.code).toBe("profileUnavailable");
    expect(test.writes).toEqual([]);
    expect(test.removals).toEqual([`${sandboxId}:${materializationId}`]);
    expect(
      test.store.materializations.get(test.store.key(workspaceA, materializationId))?.state,
    ).toBe("cleaned");
  }),
);

it.effect("fences a delayed materialization result after revoke and worker-confirmed cleanup", () =>
  Effect.gen(function* () {
    const materializeStarted = yield* Deferred.make<void>();
    const finishMaterialize = yield* Deferred.make<void>();
    let cleanupCount = 0;
    const test = harness({
      dispatch: ({ command }) => {
        if (command.operation === "materialize") {
          return Effect.gen(function* () {
            yield* Deferred.succeed(materializeStarted, undefined);
            yield* Deferred.await(finishMaterialize);
            return {
              type: "provider.credentials.result" as const,
              operation: "materialize" as const,
              operationId: command.operationId,
              routeGeneration: command.routeGeneration,
              profileGeneration: command.profileGeneration,
              outcome: "materialized" as const,
              occurredAt: now,
            };
          });
        }
        if (command.operation !== "cleanup") return Effect.die("unexpected command");
        cleanupCount += 1;
        return Effect.succeed({
          type: "provider.credentials.result" as const,
          operation: "cleanup" as const,
          operationId: command.operationId,
          routeGeneration: command.routeGeneration,
          profileGeneration: command.profileGeneration,
          outcome: "absent" as const,
          occurredAt: now,
        });
      },
    });
    yield* test.service.sealProfile({
      authorization: auth,
      loginId,
      profileId,
      label: "Work account",
      idempotencyKey: "seal",
    });
    const materializeFiber = yield* Effect.forkChild(
      test.service.materialize({
        authorization: auth,
        threadId: "thread-a" as ThreadId,
        profileId,
        materializationId: "materialization-race" as AgentMaterializationId,
      }),
    );
    yield* Deferred.await(materializeStarted);
    const revoked = yield* test.service.revoke({ authorization: auth, profileId });
    expect(revoked.state).toBe("revoked");
    expect(
      test.store.materializations.get(test.store.key(workspaceA, "materialization-race"))?.state,
    ).toBe("cleaned");
    expect(cleanupCount).toBe(1);
    yield* Deferred.succeed(finishMaterialize, undefined);
    const materializeExit = yield* Fiber.await(materializeFiber);
    expect(materializeExit._tag).toBe("Failure");
    expect(
      test.store.materializations.get(test.store.key(workspaceA, "materialization-race"))?.state,
    ).toBe("cleaned");
    expect(cleanupCount).toBe(2);
  }),
);

it.effect("validates profile metadata without invoking KMS unwrap or decrypting credentials", () =>
  Effect.gen(function* () {
    let decrypts = 0;
    let unwraps = 0;
    const crypto: ProviderCredentialCrypto = {
      ...nodeProviderCredentialCrypto,
      decrypt: (input) => {
        decrypts += 1;
        return nodeProviderCredentialCrypto.decrypt(input);
      },
    };
    const originalUnwrap = keyEncryption.unwrap;
    const testKeyEncryption: ProviderCredentialKeyEncryption = {
      ...keyEncryption,
      unwrap: (...input) => {
        unwraps += 1;
        return originalUnwrap(...input);
      },
    };
    const test = harness({ crypto, keyEncryption: testKeyEncryption });
    yield* test.service.sealProfile({
      authorization: auth,
      loginId,
      profileId,
      label: "Work account",
      idempotencyKey: "seal",
    });
    const result = yield* test.service.validate({ authorization: auth, profileId });
    expect(result.status).toBe("valid");
    expect(unwraps).toBe(0);
    expect(decrypts).toBe(0);
    const stored = test.store.profiles.get(test.store.key(workspaceA, profileId))!;
    test.store.profiles.set(test.store.key(workspaceA, profileId), {
      ...stored,
      envelope: { ...stored.envelope, nonce: new Uint8Array(0) },
    });
    expect(yield* test.service.validate({ authorization: auth, profileId })).toMatchObject({
      status: "invalid",
      reason: "invalid-envelope-metadata",
    });
    expect(unwraps).toBe(0);
    expect(decrypts).toBe(0);
  }),
);

it.effect("refreshes only reusable active profile metadata without decrypting credentials", () =>
  Effect.gen(function* () {
    let unwraps = 0;
    const test = harness({
      keyEncryption: {
        ...keyEncryption,
        unwrap: (...input) => {
          unwraps += 1;
          return keyEncryption.unwrap(...input);
        },
      },
    });
    yield* test.service.sealProfile({
      authorization: auth,
      loginId,
      profileId,
      label: "Work account",
      idempotencyKey: "seal-refresh",
    });
    const refreshed = yield* test.service.refresh({ authorization: auth, profileId });
    expect(refreshed).toMatchObject({
      workspaceId: workspaceA,
      refreshedAt: now,
      profile: { profileId, state: "active" },
    });
    expect(unwraps).toBe(0);

    yield* test.service.revoke({ authorization: auth, profileId });
    const rejected = yield* Effect.result(test.service.refresh({ authorization: auth, profileId }));
    expect(Result.isFailure(rejected)).toBe(true);
  }),
);

it.effect("persists cleanup failure and retries it on authenticated worker reconciliation", () =>
  Effect.gen(function* () {
    let failCleanup = true;
    const test = harness({
      dispatch: ({ command }) => {
        if (command.operation === "materialize") {
          return Effect.succeed({
            type: "provider.credentials.result" as const,
            operation: "materialize" as const,
            operationId: command.operationId,
            routeGeneration: command.routeGeneration,
            profileGeneration: command.profileGeneration,
            outcome: "materialized" as const,
            occurredAt: now,
          });
        }
        if (command.operation !== "cleanup") return Effect.die("unexpected command");
        return Effect.succeed({
          type: "provider.credentials.result" as const,
          operation: "cleanup" as const,
          operationId: command.operationId,
          routeGeneration: command.routeGeneration,
          profileGeneration: command.profileGeneration,
          outcome: failCleanup ? ("failed" as const) : ("absent" as const),
          ...(failCleanup ? { errorCode: "fsync_failed" } : {}),
          occurredAt: now,
        });
      },
    });
    yield* test.service.sealProfile({
      authorization: auth,
      loginId,
      profileId,
      label: "Work account",
      idempotencyKey: "seal",
    });
    yield* test.service.materialize({
      authorization: auth,
      threadId: "thread-a" as ThreadId,
      profileId,
      materializationId: "materialization-retry" as AgentMaterializationId,
    });
    expect((yield* Effect.exit(test.service.revoke({ authorization: auth, profileId })))._tag).toBe(
      "Failure",
    );
    const pending = test.store.materializations.get(
      test.store.key(workspaceA, "materialization-retry"),
    );
    expect(pending).toMatchObject({
      state: "cleanup_required",
      cleanupAttempts: 1,
      cleanupLastError: "fsync_failed",
    });
    failCleanup = false;
    yield* test.service.reconcileWorker({ workspaceId: workspaceA, sandboxId });
    expect(
      test.store.materializations.get(test.store.key(workspaceA, "materialization-retry"))?.state,
    ).toBe("cleaned");
  }),
);
