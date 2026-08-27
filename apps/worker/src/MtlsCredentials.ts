// @effect-diagnostics nodeBuiltinImport:off -- Worker mTLS keys live in a private sandbox-local file boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { WorkerCertificateGrant, type WorkerRelayCredentialRef } from "@t3tools/contracts/worker";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { WorkerRelayError } from "./errors.ts";

export interface WorkerMtlsCredential {
  readonly privateKeyPem: string;
  readonly publicKeySpkiDerBase64: string;
  readonly grant: WorkerCertificateGrant;
}

export interface WorkerMtlsCredentialStore {
  readonly loadBootstrapToken: (
    ref: WorkerRelayCredentialRef,
  ) => Effect.Effect<string, WorkerRelayError>;
  readonly clearBootstrapToken: (
    ref: WorkerRelayCredentialRef,
  ) => Effect.Effect<void, WorkerRelayError>;
  readonly loadCertificate: (
    ref: WorkerRelayCredentialRef,
  ) => Effect.Effect<WorkerMtlsCredential | undefined, WorkerRelayError>;
  readonly saveCertificate: (
    ref: WorkerRelayCredentialRef,
    credential: WorkerMtlsCredential,
  ) => Effect.Effect<void, WorkerRelayError>;
}

export const persistBootstrappedWorkerMtlsCredential = (
  store: WorkerMtlsCredentialStore,
  ref: WorkerRelayCredentialRef,
  credential: WorkerMtlsCredential,
) => store.saveCertificate(ref, credential).pipe(Effect.andThen(store.clearBootstrapToken(ref)));

export interface WorkerMtlsFileHandle {
  readonly stat: () => Promise<NodeFS.Stats>;
  readonly readFile: (encoding: BufferEncoding) => Promise<string>;
  readonly writeFile: (data: string, encoding: BufferEncoding) => Promise<void>;
  readonly chmod: (mode: number) => Promise<void>;
  readonly sync: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface WorkerMtlsFileSystem {
  readonly open: (path: string, flags: number, mode?: number) => Promise<WorkerMtlsFileHandle>;
  readonly mkdir: (
    path: string,
    options: { readonly recursive: true; readonly mode: number },
  ) => Promise<unknown>;
  readonly rename: (oldPath: string, newPath: string) => Promise<void>;
  readonly unlink: (path: string) => Promise<void>;
}

const nodeWorkerMtlsFileSystem: WorkerMtlsFileSystem = {
  open: (path, flags, mode) => NodeFSP.open(path, flags, mode),
  mkdir: (path, options) => NodeFSP.mkdir(path, options),
  rename: (oldPath, newPath) => NodeFSP.rename(oldPath, newPath),
  unlink: (path) => NodeFSP.unlink(path),
};

export const generateWorkerKeyPair = (): Omit<WorkerMtlsCredential, "grant"> => {
  const pair = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeySpkiDerBase64: pair.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64"),
  };
};

const persistedCredential = Schema.Struct({
  privateKeyPem: Schema.String.check(
    Schema.isPattern(/^-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----\n?$/),
  ),
  publicKeySpkiDerBase64: Schema.String,
  grant: WorkerCertificateGrant,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const decodePersistedText = Schema.decodeUnknownSync(Schema.fromJsonString(persistedCredential));
const encodePersistedText = Schema.encodeSync(Schema.fromJsonString(persistedCredential));

const relayFailure = (operation: string, cause?: unknown) =>
  new WorkerRelayError({ operation, retryable: false, ...(cause === undefined ? {} : { cause }) });

const privateName = (ref: WorkerRelayCredentialRef, suffix: string) =>
  `${NodeCrypto.createHash("sha256").update(ref).digest("hex")}.${suffix}`;

export const workerMtlsBootstrapTokenPath = (
  baseDirectory: string,
  ref: WorkerRelayCredentialRef,
) => NodePath.join(baseDirectory, privateName(ref, "token"));

export const workerMtlsCertificatePath = (baseDirectory: string, ref: WorkerRelayCredentialRef) =>
  NodePath.join(baseDirectory, privateName(ref, "mtls.json"));

const readPrivateFile = async (
  fileSystem: WorkerMtlsFileSystem,
  path: string,
  maxBytes: number,
) => {
  const handle = await fileSystem.open(
    path,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o077) !== 0 || stat.size > maxBytes) {
      throw new Error("credential file permissions or size are invalid");
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
};

export const makeNodeWorkerMtlsCredentialStore = (
  baseDirectory: string,
  fileSystem: WorkerMtlsFileSystem = nodeWorkerMtlsFileSystem,
): WorkerMtlsCredentialStore => {
  if (!NodePath.isAbsolute(baseDirectory)) throw new Error("credential directory must be absolute");
  const pathFor = (ref: WorkerRelayCredentialRef, suffix: string) =>
    NodePath.join(baseDirectory, privateName(ref, suffix));
  return {
    loadBootstrapToken: (ref) =>
      Effect.tryPromise({
        try: async () => {
          const token = (await readPrivateFile(fileSystem, pathFor(ref, "token"), 4_096)).trim();
          if (token.length < 32) throw new Error("bootstrap token is invalid");
          return token;
        },
        catch: (cause) => relayFailure("load-bootstrap-token", cause),
      }),
    clearBootstrapToken: (ref) =>
      Effect.tryPromise({
        try: () => fileSystem.unlink(pathFor(ref, "token")),
        catch: (cause) => relayFailure("clear-bootstrap-token", cause),
      }),
    loadCertificate: (ref) =>
      Effect.tryPromise({
        try: async () => {
          try {
            return decodePersistedText(
              await readPrivateFile(fileSystem, pathFor(ref, "mtls.json"), 128 * 1024),
            );
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw cause;
          }
        },
        catch: (cause) => relayFailure("load-certificate", cause),
      }),
    saveCertificate: (ref, credential) =>
      Effect.tryPromise({
        try: async () => {
          await fileSystem.mkdir(baseDirectory, { recursive: true, mode: 0o700 });
          const target = pathFor(ref, "mtls.json");
          const temporary = `${target}.${NodeCrypto.randomUUID()}.tmp`;
          const directory = await fileSystem.open(
            baseDirectory,
            NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW,
          );
          let temporaryHandle: WorkerMtlsFileHandle | undefined;
          let renamed = false;
          try {
            const directoryStat = await directory.stat();
            const uid = typeof process.getuid === "function" ? process.getuid() : directoryStat.uid;
            if (!directoryStat.isDirectory() || directoryStat.uid !== uid) {
              throw new Error("credential directory owner or type is invalid");
            }
            await directory.chmod(0o700);
            temporaryHandle = await fileSystem.open(
              temporary,
              NodeFS.constants.O_WRONLY |
                NodeFS.constants.O_CREAT |
                NodeFS.constants.O_EXCL |
                NodeFS.constants.O_NOFOLLOW,
              0o600,
            );
            await temporaryHandle.writeFile(encodePersistedText(credential), "utf8");
            await temporaryHandle.chmod(0o600);
            await temporaryHandle.sync();
            await temporaryHandle.close();
            temporaryHandle = undefined;
            await fileSystem.rename(temporary, target);
            renamed = true;
            await directory.sync();
          } finally {
            await temporaryHandle?.close().catch(() => undefined);
            await directory.close().catch(() => undefined);
            if (!renamed) await fileSystem.unlink(temporary).catch(() => undefined);
          }
        },
        catch: (cause) => relayFailure("save-certificate", cause),
      }),
  };
};
