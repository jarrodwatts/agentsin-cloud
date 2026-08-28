// @effect-diagnostics nodeBuiltinImport:off -- Lifecycle event ids are generated at the Node control-plane boundary.
import * as NodeCrypto from "node:crypto";

import type { EventId } from "@t3tools/contracts";
import type { WorkerRelayInbound } from "@t3tools/contracts/worker";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ControlPlaneConfigShape } from "./config.ts";
import type { DatabaseService } from "./database.ts";
import type { EphemeralCoordinationService } from "./ephemeralCoordination.ts";
import {
  makeWorkerIdentityService,
  type CertificateSigner,
  type SandboxReservationVerifier,
} from "./workerIdentity.ts";
import { makePostgresWorkerIdentityRepository } from "./workerIdentityPostgres.ts";
import { makeThreadEventStoreWorkerLifecycleRecorder } from "./workerLifecycle.ts";
import { makeWorkerBootstrapHandler } from "./workerMtlsServer.ts";
import {
  makeInMemoryWorkerRouteRegistry,
  makeWorkerRelay,
  WorkerRelayServerError,
  type AuthenticatedWorkerPrincipal,
  type WorkerRecoverySource,
  type WorkerRelay,
} from "./workerRelay.ts";
import type { ThreadEventStoreService } from "./threadEventStore.ts";
import {
  CloudThreadLifecycleDependencyError,
  type WorkerRouteLifecycle,
} from "./cloudThreadLifecycle.ts";
import type { GitHubAppClient, GitHubInstallationTokenIssuer } from "./githubAppClient.ts";
import type { GitHubSingleUseTokenVault } from "./githubTokenLeaseBroker.ts";
import {
  makeGitHubWorkerDispatcher,
  type GitHubWorkerDispatcher,
} from "./githubWorkerDispatcher.ts";

/**
 * The certificate issuer is implemented by the deployment's KMS adapter. The
 * private issuer key is intentionally absent from this interface and process
 * configuration.
 */
export interface KmsBackedCertificateSigner extends CertificateSigner {
  readonly kmsKeyId: string;
}

/** C1 and C3 provide these two production-owned boundaries. */
export interface WorkerProductionDependencies {
  readonly signer: KmsBackedCertificateSigner;
  readonly reservations: SandboxReservationVerifier;
  readonly recovery: WorkerRecoverySource;
  readonly github: {
    readonly client: GitHubAppClient;
    readonly tokens: GitHubInstallationTokenIssuer;
    readonly tokenVault: GitHubSingleUseTokenVault;
  };
}

export class WorkerProductionConfigurationError extends Schema.TaggedErrorClass<WorkerProductionConfigurationError>()(
  "WorkerProductionConfigurationError",
  { operation: Schema.String, cause: Schema.optionalKey(Schema.Unknown) },
) {}

export interface WorkerControlPlaneRuntime {
  readonly identities: ReturnType<typeof makeWorkerIdentityService>;
  readonly relay: WorkerRelay;
  readonly routeLifecycle: WorkerRouteLifecycle;
  readonly bindLifecycleRecovery: (
    recover: (
      identity: AuthenticatedWorkerPrincipal,
      confirmedEventCursor: number,
    ) => Effect.Effect<ReadonlyArray<WorkerRelayInbound>, WorkerRelayServerError>,
  ) => void;
  readonly githubWorker: GitHubWorkerDispatcher;
  readonly workerBootstrap: {
    readonly handleHttp: ReturnType<typeof makeWorkerBootstrapHandler>;
  };
}

export const makeLifecycleWorkerRecoveryBridge = (
  protocol: Omit<WorkerRecoverySource, "recover">,
) => {
  let lifecycleRecovery:
    | ((
        identity: AuthenticatedWorkerPrincipal,
        confirmedEventCursor: number,
      ) => Effect.Effect<ReadonlyArray<WorkerRelayInbound>, WorkerRelayServerError>)
    | undefined;
  const source: WorkerRecoverySource = {
    ...protocol,
    recover: (identity, cursors) =>
      lifecycleRecovery === undefined
        ? Effect.fail(
            new WorkerRelayServerError({
              code: "internal",
              operation: "recover-before-cloud-lifecycle-bound",
            }),
          )
        : lifecycleRecovery(identity, cursors.confirmedEventCursor),
  };
  return {
    source,
    bind: (recover: NonNullable<typeof lifecycleRecovery>) => {
      if (lifecycleRecovery !== undefined) {
        throw new Error("Cloud thread lifecycle recovery is already bound");
      }
      lifecycleRecovery = recover;
    },
  };
};

/**
 * Compose the authoritative Postgres identity/lifecycle service, process-local
 * live socket table, and ephemeral cross-replica route mirror. Only the
 * TLS-authenticated principal is passed to C3's recovery source; worker frames
 * cannot supply identity fields.
 */
export const makeWorkerControlPlaneRuntime = (input: {
  readonly config: ControlPlaneConfigShape;
  readonly database: DatabaseService;
  readonly threadEvents: ThreadEventStoreService;
  readonly production: WorkerProductionDependencies;
  readonly coordination: EphemeralCoordinationService;
}): Effect.Effect<WorkerControlPlaneRuntime, WorkerProductionConfigurationError> =>
  Effect.gen(function* () {
    if (input.production.signer.kmsKeyId !== input.config.workerCertificateSignerKmsKeyId) {
      return yield* new WorkerProductionConfigurationError({
        operation: "verify-kms-signer",
        cause: "configured signer identity does not match the injected KMS signer",
      });
    }

    const repository = makePostgresWorkerIdentityRepository(input.database);
    const lifecycle = makeThreadEventStoreWorkerLifecycleRecorder({
      eventStore: input.threadEvents,
      nextLifecycleId: Effect.sync(() => NodeCrypto.randomUUID() as EventId),
    });
    const identities = makeWorkerIdentityService({
      repository,
      signer: input.production.signer,
      reservations: input.production.reservations,
      lifecycle,
      clock: { now: DateTime.now.pipe(Effect.map(DateTime.formatIso)) },
    });
    const routes = makeInMemoryWorkerRouteRegistry();
    const githubWorker = makeGitHubWorkerDispatcher({ routes });
    const recoveryBridge = makeLifecycleWorkerRecoveryBridge(input.production.recovery);
    const relay = makeWorkerRelay({
      identities,
      recovery: recoveryBridge.source,
      processInstanceId: input.config.workerProcessInstanceId,
      coordination: input.coordination,
      routes,
      githubResults: githubWorker,
    });
    const routeLifecycle: WorkerRouteLifecycle = {
      fenceSandboxForReplacement: (request) =>
        relay
          .fenceSandboxForReplacement(
            request.workspaceId,
            request.threadId,
            request.sandboxId,
            request.reason,
          )
          .pipe(
            Effect.mapError(
              () =>
                new CloudThreadLifecycleDependencyError({
                  code: "worker-route-fence-failed",
                  retryable: true,
                  outcome: "uncertain",
                }),
            ),
          ),
    };

    return {
      identities,
      relay,
      routeLifecycle,
      bindLifecycleRecovery: recoveryBridge.bind,
      githubWorker,
      workerBootstrap: {
        handleHttp: makeWorkerBootstrapHandler({ identities }),
      },
    };
  });
