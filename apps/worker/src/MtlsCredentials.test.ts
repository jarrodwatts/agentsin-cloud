// @effect-diagnostics nodeBuiltinImport:off -- This focused boundary test verifies private sandbox files and generated keys.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { WorkerRelayCredentialRef } from "@t3tools/contracts/worker";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import {
  generateWorkerKeyPair,
  makeNodeWorkerMtlsCredentialStore,
  persistBootstrappedWorkerMtlsCredential,
  workerMtlsBootstrapTokenPath,
  workerMtlsCertificatePath,
  type WorkerMtlsFileHandle,
  type WorkerMtlsFileSystem,
} from "./MtlsCredentials.ts";

const credentialRef = "relay-ref-1" as WorkerRelayCredentialRef;
const certificate = `-----BEGIN CERTIFICATE-----
MIIBWjCCAQCgAwIBAgIUKyEAAAAAAAAAAAAAAAAAAAAwCgYIKoZIzj0EAwIwEjEQ
MA4GA1UEAwwHd29ya2VyMB4XDTI2MDgyNzEyMDAwMFoXDTI2MDgyNzEzMDAwMFow
EjEQMA4GA1UEAwwHd29ya2VyMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAKMTMBEwDwYDVR0TAQEABAUwAwEBADAKBggqhkjOPQQD
AgNHADBEAiAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIgAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
-----END CERTIFICATE-----`;

const makePersistedCredential = () => ({
  ...generateWorkerKeyPair(),
  grant: {
    schemaVersion: 1 as const,
    certificateChainPem: certificate,
    notBefore: "2026-08-27T12:00:00.000Z",
    notAfter: "2026-08-27T13:00:00.000Z",
    rotateAfter: "2026-08-27T12:45:00.000Z",
  },
});

const makeRecordingFileSystem = (options: { readonly failDirectorySync?: boolean } = {}) => {
  const operations: Array<string> = [];
  const handle = (kind: "directory" | "temporary"): WorkerMtlsFileHandle => ({
    stat: async () =>
      ({
        uid: typeof process.getuid === "function" ? process.getuid() : 0,
        isDirectory: () => kind === "directory",
        isFile: () => kind === "temporary",
      }) as unknown as NodeFS.Stats,
    readFile: async () => "",
    writeFile: async () => {
      operations.push(`${kind}:write`);
    },
    chmod: async () => {
      operations.push(`${kind}:chmod`);
    },
    sync: async () => {
      operations.push(`${kind}:sync`);
      if (kind === "directory" && options.failDirectorySync) {
        throw new Error("directory sync failed");
      }
    },
    close: async () => {
      operations.push(`${kind}:close`);
    },
  });
  const fileSystem: WorkerMtlsFileSystem = {
    mkdir: async () => {
      operations.push("mkdir");
    },
    open: async (_path, flags) => {
      const kind = (flags & NodeFS.constants.O_DIRECTORY) === 0 ? "temporary" : "directory";
      operations.push(`open:${kind}`);
      return handle(kind);
    },
    rename: async () => {
      operations.push("rename");
    },
    unlink: async (path) => {
      operations.push(path.endsWith(".token") ? "unlink:token" : "unlink:temporary");
    },
  };
  return { fileSystem, operations };
};

it.effect("generates a sandbox-local key and round-trips only private credential files", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "worker-mtls-"))),
    (directory) =>
      Effect.gen(function* () {
        const store = makeNodeWorkerMtlsCredentialStore(directory);
        const tokenPath = workerMtlsBootstrapTokenPath(directory, credentialRef);
        yield* Effect.promise(() => NodeFSP.writeFile(tokenPath, "t".repeat(48), { mode: 0o600 }));
        expect(yield* store.loadBootstrapToken(credentialRef)).toBe("t".repeat(48));

        const pair = generateWorkerKeyPair();
        expect(NodeCrypto.createPrivateKey(pair.privateKeyPem).type).toBe("private");
        expect(Buffer.from(pair.publicKeySpkiDerBase64, "base64").byteLength).toBeGreaterThan(32);
        const persisted = { ...pair, grant: makePersistedCredential().grant };
        yield* store.saveCertificate(credentialRef, persisted);
        expect(yield* store.loadCertificate(credentialRef)).toEqual(persisted);
        const stat = yield* Effect.promise(() =>
          NodeFSP.stat(workerMtlsCertificatePath(directory, credentialRef)),
        );
        expect(stat.mode & 0o077).toBe(0);
        yield* store.clearBootstrapToken(credentialRef);
        expect(
          Result.isFailure(yield* Effect.result(store.loadBootstrapToken(credentialRef))),
        ).toBe(true);
      }),
    (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
  ),
);

it.effect("fsyncs the certificate and parent directory before deleting the bootstrap token", () =>
  Effect.gen(function* () {
    const { fileSystem, operations } = makeRecordingFileSystem();
    const store = makeNodeWorkerMtlsCredentialStore("/run/agentsin/mtls", fileSystem);

    yield* persistBootstrappedWorkerMtlsCredential(store, credentialRef, makePersistedCredential());

    expect(operations.indexOf("temporary:sync")).toBeLessThan(operations.indexOf("rename"));
    expect(operations.indexOf("rename")).toBeLessThan(operations.indexOf("directory:sync"));
    expect(operations.indexOf("directory:sync")).toBeLessThan(operations.indexOf("unlink:token"));
  }),
);

it.effect("keeps the bootstrap token when crash-durable certificate commit fails", () =>
  Effect.gen(function* () {
    const { fileSystem, operations } = makeRecordingFileSystem({ failDirectorySync: true });
    const store = makeNodeWorkerMtlsCredentialStore("/run/agentsin/mtls", fileSystem);

    const result = yield* Effect.result(
      persistBootstrappedWorkerMtlsCredential(store, credentialRef, makePersistedCredential()),
    );

    expect(Result.isFailure(result)).toBe(true);
    expect(operations).toContain("directory:sync");
    expect(operations).not.toContain("unlink:token");
  }),
);

it.effect("rejects a symlinked bootstrap token", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "worker-mtls-link-"))),
    (directory) =>
      Effect.gen(function* () {
        const outside = NodePath.join(directory, "outside");
        yield* Effect.promise(() => NodeFSP.writeFile(outside, "s".repeat(48), { mode: 0o600 }));
        yield* Effect.promise(() =>
          NodeFSP.symlink(outside, workerMtlsBootstrapTokenPath(directory, credentialRef)),
        );
        const result = yield* Effect.result(
          makeNodeWorkerMtlsCredentialStore(directory).loadBootstrapToken(credentialRef),
        );
        expect(Result.isFailure(result)).toBe(true);
      }),
    (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
  ),
);
