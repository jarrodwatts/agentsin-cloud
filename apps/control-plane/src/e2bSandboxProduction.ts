import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type {
  EnvironmentRevisionId,
  SandboxId,
  SandboxProvider,
  WorkspaceId,
} from "@t3tools/contracts/cloud";
import {
  E2B_ACTIVE_TIMEOUT_MS,
  e2bDescriptionMatchesIdentity,
  makeE2bSandboxProvider,
  type E2bClient,
  type E2bPtySessionRegistry,
  type E2bTrafficCredentialBroker,
  type R2ArtifactWriter,
  type SandboxIdentityStore,
  type SandboxLifecycleLock,
  type SandboxProviderClock,
} from "@t3tools/e2b-sandbox";
import { makeE2bSdkClient, type E2bSdkRuntime } from "@t3tools/e2b-sandbox/sdk";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { DatabaseService } from "./database.ts";
import {
  CloudThreadLifecycleDependencyError,
  type WorkerConnectionGateway,
} from "./cloudThreadLifecycle.ts";
import type { E2bSandboxConfigShape } from "./e2bSandboxConfig.ts";
import { makePostgresSandboxIdentityStore } from "./sandboxIdentityStore.ts";

export class E2bProviderServiceError extends Schema.TaggedErrorClass<E2bProviderServiceError>()(
  "E2bProviderServiceError",
  {
    code: Schema.Literals([
      "configuration",
      "invalidReference",
      "notFound",
      "identityMismatch",
      "sandboxPaused",
      "unavailable",
    ]),
    operation: Schema.String,
    retryable: Schema.Boolean,
  },
) {}

export class E2bProductionBoundaryError extends Schema.TaggedErrorClass<E2bProductionBoundaryError>()(
  "E2bProductionBoundaryError",
  { operation: Schema.String },
) {}

export interface SealedBootstrapMaterializer {
  /** Stable non-secret identity of the deployment's KMS/secret-broker adapter. */
  readonly brokerId: string;
  readonly validateConfiguration: Effect.Effect<void, E2bProductionBoundaryError>;
  /**
   * Resolve and materialize an opaque reference inside the bound sandbox. The control plane never
   * receives the referenced plaintext, and implementations must not place it in command arguments,
   * environment variables, logs, or durable rows.
   */
  readonly materializeReference: (input: {
    readonly workspaceId: WorkspaceId;
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly sandboxId: SandboxId;
    readonly providerHandle: string;
    readonly revisionId: EnvironmentRevisionId;
    readonly sealedBootstrapRef: string;
  }) => Effect.Effect<void, E2bProductionBoundaryError>;
}

export interface KmsBackedE2bTrafficCredentialBroker extends E2bTrafficCredentialBroker {
  /** Stable non-secret identity of the deployment's KMS/secret-broker adapter. */
  readonly brokerId: string;
  readonly validateConfiguration: Effect.Effect<void, E2bProductionBoundaryError>;
}

export interface E2bProviderServiceShape {
  readonly provider: SandboxProvider;
  readonly materializeSealedBootstrap: (input: {
    readonly workspaceId: WorkspaceId;
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly sandboxId: SandboxId;
    readonly sealedBootstrapRef: string;
  }) => Effect.Effect<
    { readonly status: "materialized"; readonly completedAt: string },
    E2bProviderServiceError
  >;
  /** Handoff preserves remote PTYs for another control-plane process to claim. */
  readonly shutdown: Effect.Effect<void, E2bProviderServiceError>;
}

/** Worker startup cannot run until the exact active sandbox passes template and bootstrap checks. */
export const makeMaterializingWorkerGateway = (
  e2b: Pick<E2bProviderServiceShape, "materializeSealedBootstrap">,
  upstream: WorkerConnectionGateway,
): WorkerConnectionGateway => ({
  ...upstream,
  start: (input) =>
    e2b
      .materializeSealedBootstrap({
        workspaceId: input.workspaceId,
        environmentId: input.environmentId,
        threadId: input.threadId,
        sandboxId: input.sandboxId,
        sealedBootstrapRef: input.sealedBootstrapRef,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new CloudThreadLifecycleDependencyError({
              code: `e2b-bootstrap-${cause.code}`,
              retryable: cause.retryable,
              outcome: cause.retryable ? "uncertain" : "confirmed",
            }),
        ),
        Effect.andThen(upstream.start(input)),
      ),
});

const failure = (code: E2bProviderServiceError["code"], operation: string, retryable: boolean) =>
  new E2bProviderServiceError({ code, operation, retryable });
const isProviderServiceError = Schema.is(E2bProviderServiceError);

const validReference = (value: string) =>
  value.length > 0 &&
  value.length <= 2_048 &&
  value === value.trim() &&
  !/[\u0000-\u001f\u007f]/.test(value);

export const makeE2bProviderService = (input: {
  readonly client: E2bClient;
  readonly identities: SandboxIdentityStore;
  readonly artifacts: R2ArtifactWriter;
  readonly lifecycleLocks: SandboxLifecycleLock;
  readonly bootstrap: SealedBootstrapMaterializer;
  readonly clock?: SandboxProviderClock;
  readonly activeTimeoutMs?: number;
}): E2bProviderServiceShape => {
  const clock = input.clock ?? { now: () => DateTime.toDate(DateTime.nowUnsafe()) };
  const activeTimeoutMs = input.activeTimeoutMs ?? E2B_ACTIVE_TIMEOUT_MS;
  const provider = makeE2bSandboxProvider({
    client: input.client,
    identities: input.identities,
    artifacts: input.artifacts,
    lifecycleLocks: input.lifecycleLocks,
    clock,
    activeTimeoutMs,
  });

  const materialize = (
    request: Parameters<E2bProviderServiceShape["materializeSealedBootstrap"]>[0],
  ) =>
    Effect.gen(function* () {
      if (!validReference(request.sealedBootstrapRef)) {
        return yield* failure("invalidReference", "validate-bootstrap-reference", false);
      }
      const lookup = yield* Effect.tryPromise({
        try: () => input.identities.get(request.workspaceId, request.sandboxId),
        catch: () => failure("unavailable", "load-sandbox-identity", true),
      });
      if (lookup === undefined || lookup.state !== "active") {
        return yield* failure("notFound", "load-sandbox-identity", false);
      }
      const identity = lookup.identity;
      if (
        identity.workspaceId !== request.workspaceId ||
        identity.environmentId !== request.environmentId ||
        identity.threadId !== request.threadId ||
        identity.sandboxId !== request.sandboxId
      ) {
        return yield* failure("identityMismatch", "authorize-bootstrap-materialization", false);
      }
      const remote = yield* Effect.tryPromise({
        try: () => input.client.inspect(identity.providerHandle),
        catch: () => failure("unavailable", "inspect-bootstrap-sandbox", true),
      });
      if (remote === undefined) {
        return yield* failure("notFound", "inspect-bootstrap-sandbox", false);
      }
      if (!e2bDescriptionMatchesIdentity(remote, identity)) {
        return yield* failure("identityMismatch", "verify-bootstrap-sandbox", false);
      }
      if (remote.state !== "running") {
        return yield* failure("sandboxPaused", "verify-bootstrap-sandbox", false);
      }
      yield* input.bootstrap
        .materializeReference({
          workspaceId: identity.workspaceId,
          environmentId: identity.environmentId,
          threadId: identity.threadId,
          sandboxId: identity.sandboxId,
          providerHandle: identity.providerHandle,
          revisionId: identity.revisionId,
          sealedBootstrapRef: request.sealedBootstrapRef,
        })
        .pipe(
          Effect.mapError(() => failure("unavailable", "materialize-bootstrap-reference", true)),
        );
      return { status: "materialized" as const, completedAt: clock.now().toISOString() };
    });

  return {
    provider,
    materializeSealedBootstrap: (request) =>
      Effect.tryPromise({
        try: () =>
          input.lifecycleLocks.withLock(request.sandboxId, async () => {
            const result = await Effect.runPromise(Effect.result(materialize(request)));
            if (Result.isFailure(result)) throw result.failure;
            return result.success;
          }),
        catch: (cause) =>
          isProviderServiceError(cause)
            ? cause
            : failure("unavailable", "lock-bootstrap-materialization", true),
      }),
    shutdown: Effect.tryPromise({
      try: () => input.client.shutdownPtys("handoff", activeTimeoutMs),
      catch: () => failure("unavailable", "handoff-pty-sessions", true),
    }),
  };
};

export interface HostedE2bProviderDependencies {
  readonly config: E2bSandboxConfigShape;
  readonly database: DatabaseService;
  readonly artifacts: R2ArtifactWriter;
  readonly lifecycleLocks: SandboxLifecycleLock;
  readonly ptySessions: E2bPtySessionRegistry;
  readonly trafficCredentials: KmsBackedE2bTrafficCredentialBroker;
  readonly bootstrap: SealedBootstrapMaterializer;
  /** Stable process identity used by the durable PTY ownership lease. */
  readonly ptyOwnerId: string;
  readonly clock?: SandboxProviderClock;
  /** Test seam around the official E2B SDK. Hosted launchers leave this unset. */
  readonly sdk?: E2bSdkRuntime;
}

/**
 * Compose the official E2B SDK with PostgreSQL's one-sandbox-per-thread fence. Every secret-bearing
 * capability is an explicit production dependency; no in-memory broker or pretend compute exists.
 */
export const makeHostedE2bProviderService = (
  input: HostedE2bProviderDependencies,
): Effect.Effect<E2bProviderServiceShape, E2bProviderServiceError> =>
  Effect.gen(function* () {
    if (
      input.config.apiKey.trim().length < 16 ||
      input.config.apiKey !== input.config.apiKey.trim() ||
      /[\u0000-\u001f\u007f]/.test(input.config.apiKey) ||
      input.ptyOwnerId.trim().length === 0 ||
      input.trafficCredentials.brokerId.trim().length === 0 ||
      input.bootstrap.brokerId.trim().length === 0
    ) {
      return yield* failure("configuration", "validate-e2b-production-dependencies", false);
    }
    yield* input.trafficCredentials.validateConfiguration.pipe(
      Effect.mapError(() => failure("configuration", "validate-traffic-credential-broker", false)),
    );
    yield* input.bootstrap.validateConfiguration.pipe(
      Effect.mapError(() => failure("configuration", "validate-bootstrap-materializer", false)),
    );

    const client = makeE2bSdkClient({
      operationUser: "agentsin-agent",
      inspectorUser: "agentsin-inspector",
      apiKey: input.config.apiKey,
      trafficCredentials: input.trafficCredentials,
      ptySessions: input.ptySessions,
      artifacts: input.artifacts,
      ptyOwnerId: input.ptyOwnerId,
      ...(input.sdk === undefined ? {} : { sdk: input.sdk }),
    });
    return makeE2bProviderService({
      client,
      identities: makePostgresSandboxIdentityStore(input.database.pool),
      artifacts: input.artifacts,
      lifecycleLocks: input.lifecycleLocks,
      bootstrap: input.bootstrap,
      ...(input.clock === undefined ? {} : { clock: input.clock }),
      activeTimeoutMs: input.config.activeTimeoutMs,
    });
  });
