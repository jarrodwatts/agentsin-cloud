// @effect-diagnostics nodeBuiltinImport:off -- Signal handling and process env are the Node worker boundary.
import * as NodeProcess from "node:process";
import * as NodePath from "node:path";

import type { WorkerBootstrap } from "@t3tools/contracts/worker";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

import {
  loadWorkerBootstrap,
  WORKER_BOOTSTRAP_FILE_ENV,
  type WorkerBootstrapFileSource,
} from "./bootstrap.ts";
import { runCloudWorker, type CloudWorkerDependencies } from "./CloudWorker.ts";
import { WorkerBootstrapError, type CloudWorkerError } from "./errors.ts";
import { makeGitHubGitExecutor } from "./GitHubGitExecutor.ts";
import { InspectorRuntimeError, makeNodeInspectorRuntime } from "./InspectorRuntime.ts";
import { makeLinuxBubblewrapPtySandbox } from "./InspectorPtySandbox.ts";
import type { InspectorPtySandbox } from "./InspectorPtySandbox.ts";
import { makeNodeWorkerMtlsCredentialStore } from "./MtlsCredentials.ts";
import {
  makeNodeMtlsGitHubTokenLeaseBroker,
  makeNodeMtlsRelayConnector,
} from "./NodeMtlsRelayConnector.ts";
import {
  makeNodeWorkerCredentialIdentityRuntime,
  makeWorkerProviderCredentialExecutor,
} from "./ProviderCredentialExecutor.ts";
import { makeRestrictedProviderFactory } from "./ProviderRuntimeSupervisor.ts";
import type { WorkerSecretMaterialization } from "./ports.ts";

export const WORKER_EXECUTION_MODE_ENV = "AGENTSIN_WORKER_MODE";
export const WORKER_MTLS_CREDENTIAL_DIRECTORY_ENV = "AGENTSIN_WORKER_MTLS_DIRECTORY";
export const WORKER_PROVIDER_CREDENTIAL_ROOT_ENV = "AGENTSIN_WORKER_PROVIDER_CREDENTIAL_ROOT";
export const WORKER_AGENT_UID_ENV = "AGENTSIN_AGENT_UID";
export const WORKER_AGENT_GID_ENV = "AGENTSIN_AGENT_GID";
export const WORKER_INSPECTOR_UID_ENV = "AGENTSIN_INSPECTOR_UID";
export const WORKER_INSPECTOR_GID_ENV = "AGENTSIN_INSPECTOR_GID";
export const WORKER_PROVIDER_RUNTIME_MODULE_ENV = "AGENTSIN_PROVIDER_RUNTIME_MODULE";
export const WORKER_PROVIDER_RUNTIME_SHA256_ENV = "AGENTSIN_PROVIDER_RUNTIME_SHA256";
export const WORKER_PROVIDER_RUNTIME_CHILD_SHA256_ENV = "AGENTSIN_PROVIDER_RUNTIME_CHILD_SHA256";
export const WORKER_NODE_INTERPRETER_PATH_ENV = "AGENTSIN_NODE_INTERPRETER_PATH";
export const WORKER_NODE_INTERPRETER_SHA256_ENV = "AGENTSIN_NODE_INTERPRETER_SHA256";
export const WORKER_AGENT_HOME_ENV = "AGENTSIN_AGENT_HOME";
export const WORKER_AGENT_PATH_ENV = "AGENTSIN_AGENT_PATH";

export interface WorkerProcessOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly bootstrapSource?: WorkerBootstrapFileSource;
  readonly termination?: Effect.Effect<void>;
  /** Test seam; production uses the effective uid of this process. */
  readonly currentUid?: number;
}

export const makeHostedInspectorFactory = (options: {
  readonly mtlsDirectory: string;
  /** Provider runtime identity; it must not be able to reach inspector transaction files. */
  readonly agentUid?: number;
  readonly agentGid?: number;
  /** Dedicated identity for the interactive inspector PTY only. */
  readonly inspectorUid?: number;
  readonly inspectorGid?: number;
  readonly bootstrapPath?: string;
  readonly loadPty?: () => Promise<typeof import("node-pty")>;
  readonly ptySandbox?: InspectorPtySandbox;
  readonly requireLinuxDescriptorTraversal?: boolean;
}) => ({
  make: ({
    bootstrap,
    materialization,
  }: {
    readonly bootstrap: WorkerBootstrap;
    readonly materialization: WorkerSecretMaterialization;
  }) =>
    Effect.gen(function* () {
      const hostPlatform = yield* HostProcessPlatform;
      const protectedPaths = [
        materialization.credentialDirectory,
        options.mtlsDirectory,
        options.bootstrapPath,
      ].filter((path): path is string => path !== undefined);
      const pty = yield* Effect.tryPromise({
        try: options.loadPty ?? (() => import("node-pty")),
        catch: (cause) =>
          new InspectorRuntimeError({
            code: "unsupported",
            retryable: false,
            operation: "hosted-inspector-load-pty",
            cause,
          }),
      });
      if (
        options.ptySandbox === undefined &&
        (!Number.isSafeInteger(options.agentUid) ||
          (options.agentUid ?? 0) < 1 ||
          !Number.isSafeInteger(options.agentGid) ||
          (options.agentGid ?? 0) < 1 ||
          !Number.isSafeInteger(options.inspectorUid) ||
          (options.inspectorUid ?? 0) < 1 ||
          !Number.isSafeInteger(options.inspectorGid) ||
          (options.inspectorGid ?? 0) < 1 ||
          options.inspectorUid === options.agentUid ||
          options.inspectorGid === options.agentGid)
      ) {
        return yield* new InspectorRuntimeError({
          code: "unsupported",
          retryable: false,
          operation: "hosted-inspector-untrusted-identity",
        });
      }
      return yield* makeNodeInspectorRuntime({
        workspaceDirectory: bootstrap.workspaceDirectory,
        protectedPaths,
        makeInspectorOutputRedactor: materialization.makeInspectorOutputRedactor,
        ptySandbox:
          options.ptySandbox ??
          makeLinuxBubblewrapPtySandbox({
            loadPty: pty,
            hostPlatform,
            agentUid: options.inspectorUid!,
            agentGid: options.inspectorGid!,
          }),
        requirePtyNamespace: true,
        requireLinuxDescriptorTraversal: options.requireLinuxDescriptorTraversal ?? true,
        ...(options.agentUid === undefined ? {} : { untrustedUid: options.agentUid }),
        ...(options.inspectorUid === undefined
          ? {}
          : { additionalUntrustedUids: [options.inspectorUid] }),
        loadPty: async () => pty,
      });
    }),
});

export const selectWorkerProcessDependencies = (
  dependencies: CloudWorkerDependencies,
  env: Readonly<Record<string, string | undefined>>,
  currentUid = NodeProcess.getuid?.() ?? -1,
): Effect.Effect<CloudWorkerDependencies, WorkerBootstrapError> => {
  const mode = env[WORKER_EXECUTION_MODE_ENV];
  if (mode === undefined) {
    return Effect.fail(new WorkerBootstrapError({ reason: "worker execution mode is required" }));
  }
  if (mode === "injected") {
    if (currentUid === 0) {
      return Effect.fail(
        new WorkerBootstrapError({ reason: "root workers cannot use injected execution mode" }),
      );
    }
    return Effect.succeed(dependencies);
  }
  if (mode !== "hosted") {
    return Effect.fail(new WorkerBootstrapError({ reason: "worker execution mode is invalid" }));
  }
  const directory = env[WORKER_MTLS_CREDENTIAL_DIRECTORY_ENV];
  if (directory === undefined || !NodePath.isAbsolute(directory)) {
    return Effect.fail(
      new WorkerBootstrapError({
        reason: "hosted worker mTLS credential directory must be an absolute path",
      }),
    );
  }
  return Effect.try({
    try: () => {
      const credentials = makeNodeWorkerMtlsCredentialStore(directory);
      return {
        ...dependencies,
        relay: makeNodeMtlsRelayConnector({ credentials }),
        github: {
          makeExecutor: (bootstrap) =>
            makeGitHubGitExecutor({
              bootstrap,
              tokenLeases: makeNodeMtlsGitHubTokenLeaseBroker({ credentials }),
            }),
        },
        inspectorFactory: makeHostedInspectorFactory({
          mtlsDirectory: directory,
          agentUid: Number(env[WORKER_AGENT_UID_ENV]),
          agentGid: Number(env[WORKER_AGENT_GID_ENV]),
          inspectorUid: Number(env[WORKER_INSPECTOR_UID_ENV]),
          inspectorGid: Number(env[WORKER_INSPECTOR_GID_ENV]),
          ...(env[WORKER_BOOTSTRAP_FILE_ENV] === undefined
            ? {}
            : { bootstrapPath: env[WORKER_BOOTSTRAP_FILE_ENV] }),
        }),
      };
    },
    catch: (cause) =>
      new WorkerBootstrapError({ reason: "hosted worker relay could not be configured", cause }),
  });
};

/**
 * Non-interactive Node/Effect entrypoint. B4 supplies the concrete mTLS relay,
 * auth, and secret-broker layers; C2 owns validation, supervision, and clean
 * interruption. Winning the termination race interrupts `runCloudWorker`, so
 * its scoped provider/PTY and secret-scrub finalizers complete before return.
 */
export const runWorkerMain = (
  dependencies: CloudWorkerDependencies,
  options: WorkerProcessOptions = {},
): Effect.Effect<void, CloudWorkerError> =>
  Effect.gen(function* () {
    const env = options.env ?? NodeProcess.env;
    const selectedDependencies = yield* selectWorkerProcessDependencies(
      dependencies,
      env,
      options.currentUid,
    );
    const nowIso = yield* selectedDependencies.clock.now;
    const bootstrap = yield* loadWorkerBootstrap({
      env,
      nowIso,
      ...(options.bootstrapSource === undefined ? {} : { source: options.bootstrapSource }),
    });
    let runtimeDependencies = selectedDependencies;
    if (env[WORKER_EXECUTION_MODE_ENV] === "hosted") {
      const credentialRoot = env[WORKER_PROVIDER_CREDENTIAL_ROOT_ENV];
      const agentUid = Number(env[WORKER_AGENT_UID_ENV]);
      const agentGid = Number(env[WORKER_AGENT_GID_ENV]);
      const inspectorUid = Number(env[WORKER_INSPECTOR_UID_ENV]);
      const inspectorGid = Number(env[WORKER_INSPECTOR_GID_ENV]);
      const providerRuntimeModule = env[WORKER_PROVIDER_RUNTIME_MODULE_ENV];
      const providerRuntimeSha256 = env[WORKER_PROVIDER_RUNTIME_SHA256_ENV];
      const providerRuntimeChildSha256 = env[WORKER_PROVIDER_RUNTIME_CHILD_SHA256_ENV];
      const nodeInterpreterPath = env[WORKER_NODE_INTERPRETER_PATH_ENV];
      const nodeInterpreterSha256 = env[WORKER_NODE_INTERPRETER_SHA256_ENV];
      const agentHome = env[WORKER_AGENT_HOME_ENV];
      const agentPath = env[WORKER_AGENT_PATH_ENV];
      if (
        credentialRoot === undefined ||
        !NodePath.isAbsolute(credentialRoot) ||
        !Number.isSafeInteger(agentUid) ||
        agentUid < 1 ||
        !Number.isSafeInteger(agentGid) ||
        agentGid < 1 ||
        !Number.isSafeInteger(inspectorUid) ||
        inspectorUid < 1 ||
        !Number.isSafeInteger(inspectorGid) ||
        inspectorGid < 1 ||
        inspectorUid === agentUid ||
        inspectorGid === agentGid ||
        providerRuntimeModule === undefined ||
        !NodePath.isAbsolute(providerRuntimeModule) ||
        providerRuntimeSha256 === undefined ||
        providerRuntimeChildSha256 === undefined ||
        nodeInterpreterPath === undefined ||
        !NodePath.isAbsolute(nodeInterpreterPath) ||
        nodeInterpreterSha256 === undefined ||
        !/^[0-9a-f]{64}$/u.test(nodeInterpreterSha256) ||
        agentHome === undefined ||
        !NodePath.isAbsolute(agentHome) ||
        agentPath === undefined ||
        agentPath.length < 1
      ) {
        return yield* new WorkerBootstrapError({
          reason: "hosted worker credential executor configuration is required",
        });
      }
      const identityRuntime = makeNodeWorkerCredentialIdentityRuntime({
        interpreterPath: nodeInterpreterPath,
        interpreterSha256: nodeInterpreterSha256,
      });
      const providerCredentials = yield* makeWorkerProviderCredentialExecutor({
        privateRoot: credentialRoot,
        workspaceDirectory: bootstrap.workspaceDirectory,
        agentUid,
        agentGid,
        identityRuntime,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new WorkerBootstrapError({
              reason: "hosted worker credential executor could not be configured",
              cause,
            }),
        ),
      );
      const provider = yield* makeRestrictedProviderFactory({
        interpreterPath: nodeInterpreterPath,
        modulePath: providerRuntimeModule,
        moduleSha256: providerRuntimeSha256,
        childSha256: providerRuntimeChildSha256,
        searchPath: agentPath,
        agentHomeDirectory: agentHome,
        agentUid,
        agentGid,
        identityRuntime,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new WorkerBootstrapError({
              reason: "hosted worker provider runtime could not be isolated",
              cause,
            }),
        ),
      );
      runtimeDependencies = { ...selectedDependencies, providerCredentials, provider };
    }
    const worker = runCloudWorker(bootstrap, runtimeDependencies);
    const termination = options.termination ?? processTermination;
    yield* Effect.raceFirst(worker, termination);
  });

export const processTermination: Effect.Effect<void> = Effect.callback<void>((resume) => {
  const terminate = () => resume(Effect.void);
  NodeProcess.once("SIGTERM", terminate);
  NodeProcess.once("SIGINT", terminate);
  return Effect.sync(() => {
    NodeProcess.removeListener("SIGTERM", terminate);
    NodeProcess.removeListener("SIGINT", terminate);
  });
});
