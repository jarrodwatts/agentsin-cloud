// @effect-diagnostics nodeBuiltinImport:off -- Signal handling and process env are the Node worker boundary.
import * as NodeProcess from "node:process";

import * as Effect from "effect/Effect";

import { loadWorkerBootstrap, type WorkerBootstrapFileSource } from "./bootstrap.ts";
import { runCloudWorker, type CloudWorkerDependencies } from "./CloudWorker.ts";
import type { CloudWorkerError } from "./errors.ts";

export interface WorkerProcessOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly bootstrapSource?: WorkerBootstrapFileSource;
  readonly termination?: Effect.Effect<void>;
}

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
    const nowIso = yield* dependencies.clock.now;
    const bootstrap = yield* loadWorkerBootstrap({
      env: options.env ?? NodeProcess.env,
      nowIso,
      ...(options.bootstrapSource === undefined ? {} : { source: options.bootstrapSource }),
    });
    const worker = runCloudWorker(bootstrap, dependencies);
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
