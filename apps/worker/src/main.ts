// @effect-diagnostics nodeBuiltinImport:off -- Signal handling and process env are the Node worker boundary.
import * as NodeProcess from "node:process";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

import { loadWorkerBootstrap, type WorkerBootstrapFileSource } from "./bootstrap.ts";
import { runCloudWorker, type CloudWorkerDependencies } from "./CloudWorker.ts";
import { WorkerBootstrapError, type CloudWorkerError } from "./errors.ts";
import { makeGitHubGitExecutor } from "./GitHubGitExecutor.ts";
import { makeNodeWorkerMtlsCredentialStore } from "./MtlsCredentials.ts";
import {
  makeNodeMtlsGitHubTokenLeaseBroker,
  makeNodeMtlsRelayConnector,
} from "./NodeMtlsRelayConnector.ts";

export const WORKER_EXECUTION_MODE_ENV = "AGENTSIN_WORKER_MODE";
export const WORKER_MTLS_CREDENTIAL_DIRECTORY_ENV = "AGENTSIN_WORKER_MTLS_DIRECTORY";

export interface WorkerProcessOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly bootstrapSource?: WorkerBootstrapFileSource;
  readonly termination?: Effect.Effect<void>;
}

export const selectWorkerProcessDependencies = (
  dependencies: CloudWorkerDependencies,
  env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<CloudWorkerDependencies, WorkerBootstrapError> => {
  const mode = env[WORKER_EXECUTION_MODE_ENV];
  if (mode === undefined || mode === "injected") return Effect.succeed(dependencies);
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
    const selectedDependencies = yield* selectWorkerProcessDependencies(dependencies, env);
    const nowIso = yield* selectedDependencies.clock.now;
    const bootstrap = yield* loadWorkerBootstrap({
      env,
      nowIso,
      ...(options.bootstrapSource === undefined ? {} : { source: options.bootstrapSource }),
    });
    const worker = runCloudWorker(bootstrap, selectedDependencies);
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
