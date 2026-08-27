// @effect-diagnostics nodeBuiltinImport:off -- This module is the audited Node filesystem/TLS secret boundary.
import * as NodeConstants from "node:constants";
import * as NodeFSP from "node:fs/promises";
import type * as NodeTls from "node:tls";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ControlPlaneConfigShape } from "./config.ts";

const MAX_PEM_BYTES = 1024 * 1024;

export class WorkerTlsFileError extends Schema.TaggedErrorClass<WorkerTlsFileError>()(
  "WorkerTlsFileError",
  { operation: Schema.String, cause: Schema.optionalKey(Schema.Unknown) },
) {}

const readPem = (path: string, kind: "certificate" | "private-key") =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => NodeFSP.open(path, NodeConstants.O_RDONLY | NodeConstants.O_NOFOLLOW),
      catch: (cause) => new WorkerTlsFileError({ operation: `open-${kind}`, cause }),
    }),
    (handle) =>
      Effect.gen(function* () {
        const stat = yield* Effect.tryPromise({
          try: () => handle.stat(),
          catch: (cause) => new WorkerTlsFileError({ operation: `stat-${kind}`, cause }),
        });
        if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_PEM_BYTES) {
          return yield* new WorkerTlsFileError({ operation: `validate-${kind}` });
        }
        if (
          kind === "private-key" &&
          (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
        ) {
          return yield* new WorkerTlsFileError({ operation: "validate-private-key-permissions" });
        }
        return yield* Effect.tryPromise({
          try: () => handle.readFile(),
          catch: (cause) => new WorkerTlsFileError({ operation: `read-${kind}`, cause }),
        });
      }),
    (handle) => Effect.tryPromise(() => handle.close()).pipe(Effect.catch(() => Effect.void)),
  );

/** Load deployment-mounted PEMs without ever placing their contents in config or logs. */
export const loadWorkerMtlsTlsOptions = (
  config: Pick<
    ControlPlaneConfigShape,
    "workerMtlsServerCertificateFile" | "workerMtlsServerKeyFile" | "workerMtlsClientCaFile"
  >,
): Effect.Effect<NodeTls.TlsOptions, WorkerTlsFileError> =>
  Effect.gen(function* () {
    const cert = yield* readPem(config.workerMtlsServerCertificateFile, "certificate");
    const key = yield* readPem(config.workerMtlsServerKeyFile, "private-key");
    const ca = yield* readPem(config.workerMtlsClientCaFile, "certificate");
    return { cert, key, ca, minVersion: "TLSv1.3" };
  });
