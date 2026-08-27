// @effect-diagnostics nodeBuiltinImport:off -- Test owns its isolated temporary secret directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { loadWorkerMtlsTlsOptions } from "./workerTlsFiles.ts";

const withSecretDirectory = Effect.acquireRelease(
  Effect.tryPromise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "aic-worker-tls-"))),
  (directory) =>
    Effect.tryPromise(() => NodeFSP.rm(directory, { recursive: true, force: true })).pipe(
      Effect.catch(() => Effect.void),
    ),
);

it.effect("loads bounded regular PEM files and enforces private-key permissions", () =>
  Effect.gen(function* () {
    const directory = yield* withSecretDirectory;
    const cert = NodePath.join(directory, "server.crt");
    const key = NodePath.join(directory, "server.key");
    const ca = NodePath.join(directory, "client-ca.crt");
    yield* Effect.tryPromise(() =>
      Promise.all([
        NodeFSP.writeFile(cert, "test-server-certificate", { mode: 0o644 }),
        NodeFSP.writeFile(key, "test-private-key", { mode: 0o600 }),
        NodeFSP.writeFile(ca, "test-client-ca", { mode: 0o644 }),
      ]),
    );

    const tls = yield* loadWorkerMtlsTlsOptions({
      workerMtlsServerCertificateFile: cert,
      workerMtlsServerKeyFile: key,
      workerMtlsClientCaFile: ca,
    });
    expect(Buffer.from(tls.cert as Uint8Array).toString("utf8")).toBe("test-server-certificate");
    expect(Buffer.from(tls.key as Uint8Array).toString("utf8")).toBe("test-private-key");
    expect(Buffer.from(tls.ca as Uint8Array).toString("utf8")).toBe("test-client-ca");
    expect(tls.minVersion).toBe("TLSv1.3");

    yield* Effect.tryPromise(() => NodeFSP.chmod(key, 0o644));
    expect(
      (yield* Effect.exit(
        loadWorkerMtlsTlsOptions({
          workerMtlsServerCertificateFile: cert,
          workerMtlsServerKeyFile: key,
          workerMtlsClientCaFile: ca,
        }),
      ))._tag,
    ).toBe("Failure");
  }),
);

it.effect("rejects symlinked TLS material", () =>
  Effect.gen(function* () {
    const directory = yield* withSecretDirectory;
    const cert = NodePath.join(directory, "server.crt");
    const key = NodePath.join(directory, "server.key");
    const ca = NodePath.join(directory, "client-ca.crt");
    const realCa = NodePath.join(directory, "real-client-ca.crt");
    yield* Effect.tryPromise(() =>
      Promise.all([
        NodeFSP.writeFile(cert, "test-server-certificate", { mode: 0o644 }),
        NodeFSP.writeFile(key, "test-private-key", { mode: 0o600 }),
        NodeFSP.writeFile(realCa, "test-client-ca", { mode: 0o644 }),
      ]).then(() => NodeFSP.symlink(realCa, ca)),
    );

    const result = yield* Effect.exit(
      loadWorkerMtlsTlsOptions({
        workerMtlsServerCertificateFile: cert,
        workerMtlsServerKeyFile: key,
        workerMtlsClientCaFile: ca,
      }),
    );
    expect(result._tag).toBe("Failure");
  }),
);
