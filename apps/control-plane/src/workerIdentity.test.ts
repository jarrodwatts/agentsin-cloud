import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  WorkerIdentityError,
  makeWorkerIdentityService,
  type ActiveWorkerLease,
  type WorkerBootstrapTokenRecord,
  type WorkerCertificateRecord,
  type WorkerIdentity,
  type WorkerIdentityRepository,
} from "./workerIdentity.ts";

const identity = {
  workspaceId: "00000000-0000-4000-8000-000000000001",
  threadId: "thread-1",
  environmentId: "environment-1",
  environmentRevisionId: "revision-1",
  sandboxId: "sandbox-1",
  reservationId: "command-reserve-1",
  workerId: "worker-1",
  providerInstanceId: "codex_personal",
  providerDriver: "codex",
} as WorkerIdentity;

const publicKeySpkiDerBase64 =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEDrFZCB2Ljw8xdzov/eXqy2tULl/kz2lWq6H2pZVnOgvGO0RQiUEcG7WATjTLVSo4+qIwGhg6QBR42wZhAEAT1Q==";

const certificates = [
  `-----BEGIN CERTIFICATE-----
MIIB7zCCAZagAwIBAgIUWy6Ixr1do6AkXAp3uxdviMmWnoMwCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLd29ya2VyLXRlc3QwHhcNMjYwODI3MTIzNjMxWhcNMjYwODI5
MTIzNjMxWjAWMRQwEgYDVQQDDAt3b3JrZXItdGVzdDBZMBMGByqGSM49AgEGCCqG
SM49AwEHA0IABA6xWQgdi48PMXc6L/3l6strVC5f5M9pVquh9qWVZzoLxjtEUIlB
HBu1gE40y1UqOPqiMBoYOkAUeNsGYQBAE9WjgcEwgb4wHQYDVR0OBBYEFCUX2gdu
wQYJRQVWCtHpV5fmetQ0MB8GA1UdIwQYMBaAFCUX2gduwQYJRQVWCtHpV5fmetQ0
MA8GA1UdEwEB/wQFMAMBAf8wawYDVR0RBGQwYoZgc3BpZmZlOi8vYWdlbnRzaW4u
Y2xvdWQvd29ya2Vycy9iM2IwM2I2NTRkZGUyNzBkN2E5ZDNmZTVkNmFkYzhjNGFh
OWU4MWM0MTMxY2NkNDQ0NWQyZTQ5ZTM3ZDI5ZjA0MAoGCCqGSM49BAMCA0cAMEQC
IHdoC3bo+5qieRf/Ps9qHzJGDGikkiCWFF+JMDEXdl57AiBVVuQNwlsdCOgz4DY/
HJaPGulCEQchaXc3g/Cl2c+7RA==
-----END CERTIFICATE-----`,
  `-----BEGIN CERTIFICATE-----
MIIB3DCCAYOgAwIBAgIBAjAKBggqhkjOPQQDAjAWMRQwEgYDVQQDDAt3b3JrZXIt
dGVzdDAeFw0yNjA4MjcxMjM3MjdaFw0yNjA4MjkxMjM3MjdaMBYxFDASBgNVBAMM
C3dvcmtlci10ZXN0MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEDrFZCB2Ljw8x
dzov/eXqy2tULl/kz2lWq6H2pZVnOgvGO0RQiUEcG7WATjTLVSo4+qIwGhg6QBR4
2wZhAEAT1aOBwTCBvjAdBgNVHQ4EFgQUJRfaB27BBglFBVYK0elXl+Z61DQwHwYD
VR0jBBgwFoAUJRfaB27BBglFBVYK0elXl+Z61DQwDwYDVR0TAQH/BAUwAwEB/zBr
BgNVHREEZDBihmBzcGlmZmU6Ly9hZ2VudHNpbi5jbG91ZC93b3JrZXJzL2IzYjAz
YjY1NGRkZTI3MGQ3YTlkM2ZlNWQ2YWRjOGM0YWE5ZTgxYzQxMzFjY2Q0NDQ1ZDJl
NDllMzdkMjlmMDQwCgYIKoZIzj0EAwIDRwAwRAIgA/68WosdC7WsJ8KOX8frqgql
LyEZKJasu5kHlPnJJgUCIGl7tcCYyguG1g1nNc1/OcNNjmcGu0qWt8kAxNWSVhFn
-----END CERTIFICATE-----`,
] as const;

const isWorkerIdentityError = Schema.is(WorkerIdentityError);

const makeRepository = (): WorkerIdentityRepository & {
  readonly certificates: Map<string, WorkerCertificateRecord>;
} => {
  const tokens = new Map<string, WorkerBootstrapTokenRecord & { consumed?: boolean }>();
  const certificateRecords = new Map<string, WorkerCertificateRecord>();
  const leases = new Map<string, ActiveWorkerLease>();
  const routeGenerations = new Map<string, number>();
  const attempted = <A>(operation: string, use: () => A) =>
    Effect.try({
      try: use,
      catch: (cause) =>
        isWorkerIdentityError(cause)
          ? cause
          : new WorkerIdentityError({ code: "storeFailed", operation, cause }),
    });
  return {
    certificates: certificateRecords,
    insertBootstrapToken: (record) =>
      attempted("insert-token", () => {
        if (tokens.has(record.tokenHash)) throw new Error("duplicate token");
        tokens.set(record.tokenHash, record);
      }),
    claimBootstrapToken: (tokenHash, now) =>
      attempted("claim-token", () => {
        const record = tokens.get(tokenHash);
        if (
          record === undefined ||
          record.consumed ||
          Date.parse(record.expiresAt) <= Date.parse(now)
        ) {
          throw new WorkerIdentityError({ code: "replayed", operation: "claim-token" });
        }
        tokens.set(tokenHash, { ...record, consumed: true });
        return record;
      }),
    insertCertificate: (record) =>
      attempted("insert-certificate", () => {
        if (certificateRecords.has(record.certificateFingerprint))
          throw new Error("duplicate cert");
        certificateRecords.set(record.certificateFingerprint, record);
      }),
    markCertificateSuperseded: (fingerprint, overlapUntil) =>
      attempted("supersede-certificate", () => {
        const record = certificateRecords.get(fingerprint);
        if (record === undefined) throw new Error("missing cert");
        certificateRecords.set(fingerprint, { ...record, overlapUntil });
      }),
    findCertificate: (fingerprint) =>
      attempted("find-certificate", () => {
        const record = certificateRecords.get(fingerprint);
        if (record === undefined) {
          throw new WorkerIdentityError({ code: "invalid", operation: "find-certificate" });
        }
        return record;
      }),
    activateLease: (certificate, processInstanceId, now) =>
      attempted("activate-lease", () => {
        const previous = leases.get(certificate.sandboxId);
        if (
          previous !== undefined &&
          certificate.certificateGeneration < previous.certificateGeneration
        ) {
          throw new WorkerIdentityError({
            code: "staleCertificate",
            operation: "activate-lease",
          });
        }
        const lease: ActiveWorkerLease = {
          ...certificate,
          processInstanceId,
          leaseGeneration: (previous?.leaseGeneration ?? 0) + 1,
          routeGeneration:
            (routeGenerations.get(`${certificate.workspaceId}\0${certificate.threadId}`) ?? 0) + 1,
          state: "connected",
          connectedAt: now,
          lastSeenAt: now,
          heartbeatSequence: 0,
          confirmedEventCursor: previous?.confirmedEventCursor ?? -1,
          ...(previous?.lastCommandDeliveryId === undefined
            ? {}
            : { lastCommandDeliveryId: previous.lastCommandDeliveryId }),
        };
        routeGenerations.set(
          `${certificate.workspaceId}\0${certificate.threadId}`,
          lease.routeGeneration,
        );
        leases.set(certificate.sandboxId, lease);
        return lease;
      }),
    heartbeat: (lease, sequence, now) =>
      attempted("heartbeat", () => {
        const active = leases.get(lease.sandboxId);
        if (
          active === undefined ||
          active.leaseGeneration !== lease.leaseGeneration ||
          active.state !== "connected" ||
          sequence <= active.heartbeatSequence
        ) {
          throw new WorkerIdentityError({ code: "leaseFenced", operation: "heartbeat" });
        }
        const updated = { ...active, heartbeatSequence: sequence, lastSeenAt: now };
        leases.set(lease.sandboxId, updated);
        return updated;
      }),
    saveCursors: (lease, cursors, now) =>
      attempted("save-cursors", () => {
        const active = leases.get(lease.sandboxId);
        if (active === undefined || active.leaseGeneration !== lease.leaseGeneration) {
          throw new WorkerIdentityError({ code: "leaseFenced", operation: "save-cursors" });
        }
        const updated: ActiveWorkerLease = {
          ...active,
          lastSeenAt: now,
          confirmedEventCursor: Math.max(
            active.confirmedEventCursor,
            cursors.confirmedEventCursor ?? active.confirmedEventCursor,
          ),
          ...(cursors.commandDeliveryId === undefined
            ? {}
            : { lastCommandDeliveryId: cursors.commandDeliveryId }),
        };
        leases.set(lease.sandboxId, updated);
        return updated;
      }),
    disconnect: (lease, state, _now) =>
      attempted("disconnect", () => {
        const active = leases.get(lease.sandboxId);
        if (active === undefined || active.leaseGeneration !== lease.leaseGeneration) return false;
        leases.set(lease.sandboxId, { ...active, state });
        return true;
      }),
    fenceSandbox: (_workspaceId, sandboxId, _reason, now) =>
      attempted("fence", () => {
        const affected: Array<WorkerIdentity> = [];
        for (const [fingerprint, record] of certificateRecords) {
          if (record.sandboxId !== sandboxId) continue;
          affected.push(record);
          certificateRecords.set(fingerprint, { ...record, revokedAt: now });
        }
        const active = leases.get(sandboxId);
        if (active !== undefined) leases.set(sandboxId, { ...active, state: "fenced" });
        return affected;
      }),
    recoverProcess: (processInstanceId, _now) =>
      attempted("recover-process", () => {
        const recovered: Array<ActiveWorkerLease> = [];
        for (const [sandboxId, lease] of leases) {
          if (lease.processInstanceId !== processInstanceId || lease.state !== "connected")
            continue;
          const disconnected = { ...lease, state: "disconnected" as const };
          leases.set(sandboxId, disconnected);
          recovered.push(disconnected);
        }
        return recovered;
      }),
  };
};

const makeHarness = () => {
  let now = "2026-08-27T13:00:00.000Z";
  let issued = 0;
  const repository = makeRepository();
  const lifecycle: Array<string> = [];
  const service = makeWorkerIdentityService({
    repository,
    clock: { now: Effect.sync(() => now) },
    reservations: { verifyActive: () => Effect.void },
    lifecycle: {
      record: (record) => Effect.sync(() => lifecycle.push(record.state)).pipe(Effect.asVoid),
    },
    signer: {
      issue: (request) =>
        Effect.sync(() => ({
          certificateChainPem: certificates[Math.min(issued++, certificates.length - 1)]!,
          embeddedIdentityBinding: request.identityExtension.value,
        })),
    },
    randomBytes: () => Buffer.alloc(32, 7),
    options: {
      certificateLifetimeMs: 3 * 24 * 60 * 60_000,
      rotateBeforeExpiryMs: 24 * 60 * 60_000,
      rotationOverlapMs: 90_000,
    },
  });
  return { repository, service, lifecycle, setNow: (value: string) => (now = value) };
};

it.effect("consumes a bootstrap token exactly once under concurrent exchange", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const issued = yield* harness.service.issueBootstrapToken(identity);
    const exchange = harness.service.exchangeBootstrapToken({
      token: issued.token,
      publicKeySpkiDerBase64,
    });
    const outcomes = yield* Effect.all([Effect.result(exchange), Effect.result(exchange)], {
      concurrency: "unbounded",
    });
    expect(outcomes.filter(Result.isSuccess)).toHaveLength(1);
    expect(outcomes.filter(Result.isFailure)).toHaveLength(1);
    expect(harness.lifecycle).toEqual(["certificate-issued"]);
  }),
);

it.effect("binds certificate SAN, validity, revocation, and rotation overlap to identity", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const token = yield* harness.service.issueBootstrapToken(identity);
    yield* harness.service.exchangeBootstrapToken({ token: token.token, publicKeySpkiDerBase64 });
    const first = [...harness.repository.certificates.values()][0]!;

    const mismatch = yield* Effect.result(
      harness.service.authenticateCertificate({
        fingerprint: first.certificateFingerprint,
        sanUris: ["spiffe://agentsin.cloud/workers/wrong"],
        now: "2026-08-27T13:00:00.000Z",
      }),
    );
    expect(Result.isFailure(mismatch) && mismatch.failure.code).toBe("mismatch");

    const notYetValid = yield* Effect.result(
      harness.service.authenticateCertificate({
        fingerprint: first.certificateFingerprint,
        sanUris: [first.sanUri],
        now: "2026-08-27T11:00:00.000Z",
      }),
    );
    expect(Result.isFailure(notYetValid) && notYetValid.failure.code).toBe("notYetValid");
    const expired = yield* Effect.result(
      harness.service.authenticateCertificate({
        fingerprint: first.certificateFingerprint,
        sanUris: [first.sanUri],
        now: "2026-08-29T14:00:00.000Z",
      }),
    );
    expect(Result.isFailure(expired) && expired.failure.code).toBe("expired");

    const rotated = yield* harness.service.rotateCertificate({
      current: first,
      publicKeySpkiDerBase64,
    });
    expect(rotated.certificateChainPem).toBe(certificates[1]);
    const updatedFirst = harness.repository.certificates.get(first.certificateFingerprint)!;
    expect(updatedFirst.overlapUntil).toBe("2026-08-27T13:01:30.000Z");

    yield* harness.service.authenticateCertificate({
      fingerprint: first.certificateFingerprint,
      sanUris: [first.sanUri],
      now: "2026-08-27T13:01:29.000Z",
    });
    const stale = yield* Effect.result(
      harness.service.authenticateCertificate({
        fingerprint: first.certificateFingerprint,
        sanUris: [first.sanUri],
        now: "2026-08-27T13:01:30.000Z",
      }),
    );
    expect(Result.isFailure(stale) && stale.failure.code).toBe("staleCertificate");

    harness.setNow("2026-08-27T13:01:00.000Z");
    const second = [...harness.repository.certificates.values()].find(
      (entry) => entry.certificateGeneration === 2,
    )!;
    yield* harness.service.fenceSandbox(identity.workspaceId, identity.sandboxId, "pause");
    const revoked = yield* Effect.result(
      harness.service.authenticateCertificate({
        fingerprint: second.certificateFingerprint,
        sanUris: [second.sanUri],
        now: "2026-08-27T13:01:00.000Z",
      }),
    );
    expect(Result.isFailure(revoked) && revoked.failure.code).toBe("revoked");
  }),
);
