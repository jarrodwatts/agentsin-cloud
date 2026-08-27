// @effect-diagnostics nodeBuiltinImport:off -- Worker identity uses Node's audited crypto and X.509 parser at the TLS boundary.
import * as NodeCrypto from "node:crypto";

import type { CommandId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentRevisionId, SandboxId, WorkspaceId } from "@t3tools/contracts/cloud";
import type {
  WorkerCertificateGrant,
  WorkerInstanceId,
  WorkerProviderState,
  WorkerRecoveryState,
  WorkerRelayState,
} from "@t3tools/contracts/worker";
import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

export const WORKER_IDENTITY_EXTENSION_OID = "1.3.6.1.4.1.57264.1.1";

export interface WorkerIdentity {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly environmentRevisionId: EnvironmentRevisionId;
  readonly sandboxId: SandboxId;
  readonly reservationId: CommandId;
  readonly workerId: WorkerInstanceId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerDriver: ProviderDriverKind;
}

export interface WorkerBootstrapTokenRecord extends WorkerIdentity {
  readonly tokenHash: string;
  readonly identityBinding: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface WorkerCertificateRecord extends WorkerIdentity {
  readonly certificateFingerprint: string;
  readonly certificateGeneration: number;
  readonly identityBinding: string;
  readonly sanUri: string;
  readonly publicKeySpkiSha256: string;
  readonly notBefore: string;
  readonly notAfter: string;
  readonly overlapUntil?: string;
  readonly revokedAt?: string;
}

export interface ActiveWorkerLease extends WorkerIdentity {
  readonly certificateFingerprint: string;
  readonly certificateGeneration: number;
  readonly leaseGeneration: number;
  /** Durable monotonic fence allocated in workspace+thread route scope. */
  readonly routeGeneration: number;
  readonly processInstanceId: string;
  readonly state: "connected" | "disconnected" | "timed_out" | "fenced";
  readonly connectedAt: string;
  readonly lastSeenAt: string;
  readonly heartbeatSequence: number;
  readonly confirmedEventCursor: number;
  readonly lastCommandDeliveryId?: string;
}

export class WorkerIdentityError extends Schema.TaggedErrorClass<WorkerIdentityError>()(
  "WorkerIdentityError",
  {
    code: Schema.Literals([
      "invalid",
      "expired",
      "notYetValid",
      "replayed",
      "mismatch",
      "revoked",
      "staleCertificate",
      "reservationRejected",
      "signingFailed",
      "storeFailed",
      "leaseFenced",
    ]),
    operation: Schema.String,
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {}

export interface CertificateSignerRequest {
  readonly publicKeySpkiDerBase64: string;
  readonly sanUri: string;
  readonly identityExtension: {
    readonly oid: typeof WORKER_IDENTITY_EXTENSION_OID;
    readonly value: string;
  };
  readonly notBefore: string;
  readonly notAfter: string;
}

export interface CertificateSignerResult {
  readonly certificateChainPem: string;
  /** KMS/issuer attestation that the requested private extension was embedded. */
  readonly embeddedIdentityBinding: string;
}

export interface CertificateSigner {
  readonly issue: (
    request: CertificateSignerRequest,
  ) => Effect.Effect<CertificateSignerResult, WorkerIdentityError>;
}

export interface SandboxReservationVerifier {
  readonly verifyActive: (identity: WorkerIdentity) => Effect.Effect<void, WorkerIdentityError>;
}

export interface WorkerLifecycleRecorder {
  readonly record: (input: {
    readonly identity: WorkerIdentity;
    readonly state: string;
    readonly occurredAt: string;
    readonly details?: Readonly<Record<string, unknown>>;
  }) => Effect.Effect<void, WorkerIdentityError>;
}

export interface WorkerIdentityRepository {
  readonly insertBootstrapToken: (
    record: WorkerBootstrapTokenRecord,
  ) => Effect.Effect<void, WorkerIdentityError>;
  /** Atomically consumes an unexpired token. No secret value is stored. */
  readonly claimBootstrapToken: (
    tokenHash: string,
    now: string,
  ) => Effect.Effect<WorkerBootstrapTokenRecord, WorkerIdentityError>;
  readonly insertCertificate: (
    record: WorkerCertificateRecord,
  ) => Effect.Effect<void, WorkerIdentityError>;
  readonly markCertificateSuperseded: (
    fingerprint: string,
    overlapUntil: string,
  ) => Effect.Effect<void, WorkerIdentityError>;
  readonly findCertificate: (
    fingerprint: string,
  ) => Effect.Effect<WorkerCertificateRecord, WorkerIdentityError>;
  readonly activateLease: (
    certificate: WorkerCertificateRecord,
    processInstanceId: string,
    now: string,
  ) => Effect.Effect<ActiveWorkerLease, WorkerIdentityError>;
  readonly heartbeat: (
    lease: Pick<ActiveWorkerLease, "workspaceId" | "sandboxId" | "leaseGeneration">,
    heartbeatSequence: number,
    now: string,
  ) => Effect.Effect<ActiveWorkerLease, WorkerIdentityError>;
  readonly saveCursors: (
    lease: Pick<ActiveWorkerLease, "workspaceId" | "sandboxId" | "leaseGeneration">,
    cursors: { readonly confirmedEventCursor?: number; readonly commandDeliveryId?: string },
    now: string,
  ) => Effect.Effect<ActiveWorkerLease, WorkerIdentityError>;
  readonly disconnect: (
    lease: Pick<ActiveWorkerLease, "workspaceId" | "sandboxId" | "leaseGeneration">,
    state: "disconnected" | "timed_out",
    now: string,
  ) => Effect.Effect<boolean, WorkerIdentityError>;
  readonly fenceSandbox: (
    workspaceId: WorkspaceId,
    sandboxId: SandboxId,
    reason: string,
    now: string,
  ) => Effect.Effect<ReadonlyArray<WorkerIdentity>, WorkerIdentityError>;
  readonly recoverProcess: (
    processInstanceId: string,
    now: string,
  ) => Effect.Effect<ReadonlyArray<ActiveWorkerLease>, WorkerIdentityError>;
}

export interface WorkerIdentityClock {
  readonly now: Effect.Effect<string>;
}

export interface WorkerIdentityOptions {
  readonly bootstrapLifetimeMs: number;
  readonly certificateLifetimeMs: number;
  readonly rotateBeforeExpiryMs: number;
  readonly rotationOverlapMs: number;
  readonly clockSkewMs: number;
}

export const DEFAULT_WORKER_IDENTITY_OPTIONS: WorkerIdentityOptions = {
  bootstrapLifetimeMs: 2 * 60_000,
  certificateLifetimeMs: 10 * 60_000,
  rotateBeforeExpiryMs: 4 * 60_000,
  rotationOverlapMs: 90_000,
  clockSkewMs: 30_000,
};

const failure = (code: WorkerIdentityError["code"], operation: string, cause?: unknown) =>
  new WorkerIdentityError({
    code,
    operation,
    ...(cause === undefined ? {} : { cause }),
  });

const digestHex = (value: string | Buffer) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

export const workerIdentityBinding = (identity: WorkerIdentity): string =>
  digestHex(
    JSON.stringify([
      identity.workspaceId,
      identity.threadId,
      identity.environmentId,
      identity.environmentRevisionId,
      identity.sandboxId,
      identity.reservationId,
      identity.workerId,
      identity.providerInstanceId,
      identity.providerDriver,
    ]),
  );

export const workerIdentitySanUri = (binding: string) =>
  `spiffe://agentsin.cloud/workers/${binding}`;

export const normalizeCertificateFingerprint = (fingerprint: string) =>
  fingerprint.replaceAll(":", "").toLowerCase();

const sameIdentity = (left: WorkerIdentity, right: WorkerIdentity) =>
  workerIdentityBinding(left) === workerIdentityBinding(right);

const parseTime = (value: string, operation: string) => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw failure("invalid", operation);
  return parsed;
};

const isoFromEpoch = (epochMillis: number) => DateTime.formatIso(DateTime.makeUnsafe(epochMillis));
const canonicalCertificateTime = (value: string) => DateTime.formatIso(DateTime.makeUnsafe(value));

export interface MakeWorkerIdentityServiceOptions {
  readonly repository: WorkerIdentityRepository;
  readonly signer: CertificateSigner;
  readonly reservations: SandboxReservationVerifier;
  readonly lifecycle: WorkerLifecycleRecorder;
  readonly clock: WorkerIdentityClock;
  readonly options?: Partial<WorkerIdentityOptions>;
  readonly randomBytes?: (size: number) => Buffer;
}

export const makeWorkerIdentityService = (dependencies: MakeWorkerIdentityServiceOptions) => {
  const options = { ...DEFAULT_WORKER_IDENTITY_OPTIONS, ...dependencies.options };
  const randomBytes = dependencies.randomBytes ?? NodeCrypto.randomBytes;

  const validateOptions = Effect.sync(() => {
    const values = Object.values(options);
    if (values.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
      throw failure("invalid", "configure");
    }
    if (options.rotateBeforeExpiryMs >= options.certificateLifetimeMs) {
      throw failure("invalid", "configure");
    }
  });

  const issueCertificate = (
    identity: WorkerIdentity,
    publicKeySpkiDerBase64: string,
    generation: number,
    now: string,
  ) =>
    Effect.gen(function* () {
      const binding = workerIdentityBinding(identity);
      const sanUri = workerIdentitySanUri(binding);
      const nowMs = parseTime(now, "issue-certificate");
      const notBefore = isoFromEpoch(nowMs - options.clockSkewMs);
      const notAfter = isoFromEpoch(nowMs + options.certificateLifetimeMs);
      const rotateAfter = isoFromEpoch(
        nowMs + options.certificateLifetimeMs - options.rotateBeforeExpiryMs,
      );
      const signed = yield* dependencies.signer.issue({
        publicKeySpkiDerBase64,
        sanUri,
        identityExtension: {
          oid: WORKER_IDENTITY_EXTENSION_OID,
          value: binding,
        },
        notBefore,
        notAfter,
      });
      if (signed.embeddedIdentityBinding !== binding) {
        return yield* failure("signingFailed", "issue-certificate", "identity extension mismatch");
      }

      const certificate = yield* Effect.try({
        try: () => new NodeCrypto.X509Certificate(signed.certificateChainPem),
        catch: (cause) => failure("signingFailed", "parse-certificate", cause),
      });
      const certificateSpki = certificate.publicKey.export({ type: "spki", format: "der" });
      const requestedSpki = Buffer.from(publicKeySpkiDerBase64, "base64");
      if (!certificateSpki.equals(requestedSpki)) {
        return yield* failure("signingFailed", "issue-certificate", "public key mismatch");
      }
      if (!(certificate.subjectAltName ?? "").split(", ").includes(`URI:${sanUri}`)) {
        return yield* failure("signingFailed", "issue-certificate", "SAN mismatch");
      }
      const certificateNotBefore = canonicalCertificateTime(certificate.validFrom);
      const certificateNotAfter = canonicalCertificateTime(certificate.validTo);
      if (
        parseTime(certificateNotBefore, "issue-certificate") > nowMs ||
        parseTime(certificateNotAfter, "issue-certificate") <= nowMs ||
        parseTime(certificateNotAfter, "issue-certificate") >
          nowMs + options.certificateLifetimeMs + options.clockSkewMs
      ) {
        return yield* failure("signingFailed", "issue-certificate", "invalid validity window");
      }

      const record: WorkerCertificateRecord = {
        ...identity,
        certificateFingerprint: normalizeCertificateFingerprint(certificate.fingerprint256),
        certificateGeneration: generation,
        identityBinding: binding,
        sanUri,
        publicKeySpkiSha256: digestHex(certificateSpki),
        notBefore: certificateNotBefore,
        notAfter: certificateNotAfter,
      };
      yield* dependencies.repository.insertCertificate(record);
      return {
        record,
        grant: {
          schemaVersion: 1,
          certificateChainPem: signed.certificateChainPem,
          notBefore: certificateNotBefore,
          notAfter: certificateNotAfter,
          rotateAfter,
        } satisfies WorkerCertificateGrant,
      };
    });

  const issueBootstrapToken = (identity: WorkerIdentity) =>
    Effect.gen(function* () {
      yield* validateOptions;
      yield* dependencies.reservations.verifyActive(identity);
      const now = yield* dependencies.clock.now;
      const token = randomBytes(32).toString("base64url");
      const record: WorkerBootstrapTokenRecord = {
        ...identity,
        tokenHash: digestHex(token),
        identityBinding: workerIdentityBinding(identity),
        issuedAt: now,
        expiresAt: isoFromEpoch(parseTime(now, "issue-bootstrap") + options.bootstrapLifetimeMs),
      };
      yield* dependencies.repository.insertBootstrapToken(record);
      return { token, expiresAt: record.expiresAt };
    });

  const exchangeBootstrapToken = (input: {
    readonly token: string;
    readonly publicKeySpkiDerBase64: string;
  }) =>
    Effect.gen(function* () {
      yield* validateOptions;
      const now = yield* dependencies.clock.now;
      const record = yield* dependencies.repository.claimBootstrapToken(
        digestHex(input.token),
        now,
      );
      yield* dependencies.reservations.verifyActive(record);
      const issued = yield* issueCertificate(record, input.publicKeySpkiDerBase64, 1, now);
      yield* dependencies.lifecycle.record({
        identity: record,
        state: "certificate-issued",
        occurredAt: now,
        details: { certificateGeneration: 1 },
      });
      return issued.grant;
    });

  const authenticateCertificate = (input: {
    readonly fingerprint: string;
    readonly sanUris: ReadonlyArray<string>;
    readonly now: string;
  }) =>
    Effect.gen(function* () {
      const certificate = yield* dependencies.repository.findCertificate(
        normalizeCertificateFingerprint(input.fingerprint),
      );
      const nowMs = parseTime(input.now, "authenticate-certificate");
      if (certificate.revokedAt !== undefined) {
        return yield* failure("revoked", "authenticate-certificate");
      }
      if (
        certificate.overlapUntil !== undefined &&
        nowMs >= parseTime(certificate.overlapUntil, "authenticate-certificate")
      ) {
        return yield* failure("staleCertificate", "authenticate-certificate");
      }
      if (
        nowMs + options.clockSkewMs <
        parseTime(certificate.notBefore, "authenticate-certificate")
      ) {
        return yield* failure("notYetValid", "authenticate-certificate");
      }
      if (
        nowMs - options.clockSkewMs >=
        parseTime(certificate.notAfter, "authenticate-certificate")
      ) {
        return yield* failure("expired", "authenticate-certificate");
      }
      if (!input.sanUris.includes(certificate.sanUri)) {
        return yield* failure("mismatch", "authenticate-certificate");
      }
      yield* dependencies.reservations.verifyActive(certificate);
      return certificate;
    });

  const rotateCertificate = (input: {
    readonly current: WorkerCertificateRecord;
    readonly publicKeySpkiDerBase64: string;
  }) =>
    Effect.gen(function* () {
      const now = yield* dependencies.clock.now;
      const authenticated = yield* authenticateCertificate({
        fingerprint: input.current.certificateFingerprint,
        sanUris: [input.current.sanUri],
        now,
      });
      if (!sameIdentity(authenticated, input.current)) {
        return yield* failure("mismatch", "rotate-certificate");
      }
      const issued = yield* issueCertificate(
        authenticated,
        input.publicKeySpkiDerBase64,
        authenticated.certificateGeneration + 1,
        now,
      );
      yield* dependencies.repository.markCertificateSuperseded(
        authenticated.certificateFingerprint,
        isoFromEpoch(parseTime(now, "rotate-certificate") + options.rotationOverlapMs),
      );
      yield* dependencies.lifecycle.record({
        identity: authenticated,
        state: "certificate-rotated",
        occurredAt: now,
        details: { certificateGeneration: issued.record.certificateGeneration },
      });
      return issued.grant;
    });

  const activateLease = (certificate: WorkerCertificateRecord, processInstanceId: string) =>
    Effect.gen(function* () {
      const now = yield* dependencies.clock.now;
      const lease = yield* dependencies.repository.activateLease(
        certificate,
        processInstanceId,
        now,
      );
      yield* dependencies.lifecycle.record({
        identity: certificate,
        state: "connected",
        occurredAt: now,
        details: { leaseGeneration: lease.leaseGeneration },
      });
      return lease;
    });

  const recordHeartbeat = (
    lease: ActiveWorkerLease,
    input: {
      readonly heartbeatSequence: number;
      readonly health: {
        readonly workerId: WorkerInstanceId;
        readonly workspaceId: WorkspaceId;
        readonly environmentId: EnvironmentId;
        readonly environmentRevisionId: EnvironmentRevisionId;
        readonly threadId: ThreadId;
        readonly sandboxId: SandboxId;
        readonly providerState: WorkerProviderState;
        readonly relayState: WorkerRelayState;
        readonly recoveryState: WorkerRecoveryState;
      };
    },
  ) =>
    Effect.gen(function* () {
      if (
        input.health.workerId !== lease.workerId ||
        input.health.workspaceId !== lease.workspaceId ||
        input.health.environmentId !== lease.environmentId ||
        input.health.environmentRevisionId !== lease.environmentRevisionId ||
        input.health.threadId !== lease.threadId ||
        input.health.sandboxId !== lease.sandboxId
      ) {
        return yield* failure("mismatch", "heartbeat");
      }
      const now = yield* dependencies.clock.now;
      return yield* dependencies.repository.heartbeat(lease, input.heartbeatSequence, now);
    });

  const fenceSandbox = (workspaceId: WorkspaceId, sandboxId: SandboxId, reason: string) =>
    Effect.gen(function* () {
      const now = yield* dependencies.clock.now;
      const identities = yield* dependencies.repository.fenceSandbox(
        workspaceId,
        sandboxId,
        reason,
        now,
      );
      yield* Effect.forEach(identities, (identity) =>
        dependencies.lifecycle.record({ identity, state: "fenced", occurredAt: now }),
      );
      return identities;
    });

  const disconnectLease = (lease: ActiveWorkerLease, state: "disconnected" | "timed_out") =>
    Effect.gen(function* () {
      const now = yield* dependencies.clock.now;
      const changed = yield* dependencies.repository.disconnect(lease, state, now);
      if (changed) {
        yield* dependencies.lifecycle.record({
          identity: lease,
          state,
          occurredAt: now,
          details: { leaseGeneration: lease.leaseGeneration },
        });
      }
      return changed;
    });

  return {
    issueBootstrapToken,
    exchangeBootstrapToken,
    authenticateCertificate,
    rotateCertificate,
    activateLease,
    recordHeartbeat,
    disconnectLease,
    fenceSandbox,
    repository: dependencies.repository,
    clock: dependencies.clock,
  } as const;
};

export type WorkerIdentityService = ReturnType<typeof makeWorkerIdentityService>;
