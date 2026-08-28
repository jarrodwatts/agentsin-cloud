// @effect-diagnostics nodeBuiltinImport:off -- This is the installed Node process boundary.
// @effect-diagnostics globalProcess:off -- The executable owns its process exit status.
import * as NodeCrypto from "node:crypto";
import * as NodeProcess from "node:process";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import type { CloudWorkerDependencies } from "./CloudWorker.ts";
import { WorkerProviderError, WorkerRelayError, WorkerSecretLeaseError } from "./errors.ts";
import { runWorkerMain, type WorkerProcessOptions } from "./main.ts";

/**
 * The image entrypoint deliberately supplies no development fallback. Hosted
 * startup replaces relay/provider with the pinned mTLS and restricted-child
 * adapters, while the secret broker stays disabled until C2.2 installs the
 * fixed production composition. Missing composition therefore exits before a
 * provider CLI or untrusted command can run.
 */
export const makeFailClosedImageDependencies = (): CloudWorkerDependencies => ({
  relay: {
    connect: () =>
      Effect.fail(
        new WorkerRelayError({
          operation: "image-relay-not-selected",
          retryable: false,
        }),
      ),
  },
  provider: {
    start: () =>
      Effect.fail(
        new WorkerProviderError({
          operation: "image-provider-not-selected",
          crashed: false,
        }),
      ),
  },
  secretLease: {
    materialize: () =>
      Effect.fail(
        new WorkerSecretLeaseError({
          operation: "hosted-secret-broker-not-composed",
        }),
      ),
  },
  clock: { now: DateTime.now.pipe(Effect.map(DateTime.formatIso)) },
  ids: {
    nextProposalId: Effect.sync(() => `proposal-${NodeCrypto.randomUUID()}` as never),
  },
  logger: {
    info: (message) => Effect.sync(() => NodeProcess.stderr.write(`[worker] ${message}\n`)),
    warn: (message) => Effect.sync(() => NodeProcess.stderr.write(`[worker] ${message}\n`)),
    error: (message) => Effect.sync(() => NodeProcess.stderr.write(`[worker] ${message}\n`)),
  },
});

export const runImageWorker = (options: WorkerProcessOptions = {}) =>
  runWorkerMain(makeFailClosedImageDependencies(), options);

const result = await Effect.runPromiseExit(runImageWorker());
if (Exit.isFailure(result)) {
  NodeProcess.stderr.write("Agents in Cloud worker startup failed closed.\n");
  NodeProcess.exit(1);
}
