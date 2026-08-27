// @effect-diagnostics nodeBuiltinImport:off -- This test creates ephemeral local TLS identities and sockets.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import WebSocket from "ws";

import {
  WorkerIdentityError,
  type WorkerCertificateRecord,
  type WorkerIdentityService,
} from "./workerIdentity.ts";
import { createWorkerMtlsServer } from "./workerMtlsServer.ts";
import type { WorkerRelay } from "./workerRelay.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const sanUri = "spiffe://agentsin.cloud/workers/test-binding";

interface TlsFixture {
  readonly ca: Buffer;
  readonly otherCa: Buffer;
  readonly serverCertificate: Buffer;
  readonly serverKey: Buffer;
  readonly clientCertificate: Buffer;
  readonly clientKey: Buffer;
  readonly otherClientCertificate: Buffer;
  readonly otherClientKey: Buffer;
  readonly selfSignedClientCertificate: Buffer;
  readonly selfSignedClientKey: Buffer;
  readonly clientFingerprint: string;
}

const runOpenSsl = (directory: string, args: ReadonlyArray<string>) =>
  execFile("openssl", [...args], { cwd: directory });

const generateCertificateAuthority = async (directory: string, prefix: string) => {
  await runOpenSsl(directory, [
    "genpkey",
    "-algorithm",
    "EC",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-pkeyopt",
    "ec_param_enc:named_curve",
    "-out",
    `${prefix}.key`,
  ]);
  await runOpenSsl(directory, [
    "req",
    "-new",
    "-x509",
    "-key",
    `${prefix}.key`,
    "-sha256",
    "-days",
    "1",
    "-subj",
    `/CN=${prefix}`,
    "-out",
    `${prefix}.crt`,
  ]);
};

const generateSignedCertificate = async (input: {
  readonly directory: string;
  readonly prefix: string;
  readonly caPrefix: string;
  readonly commonName: string;
  readonly extensions: string;
}) => {
  await runOpenSsl(input.directory, [
    "genpkey",
    "-algorithm",
    "EC",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-pkeyopt",
    "ec_param_enc:named_curve",
    "-out",
    `${input.prefix}.key`,
  ]);
  await runOpenSsl(input.directory, [
    "req",
    "-new",
    "-key",
    `${input.prefix}.key`,
    "-subj",
    `/CN=${input.commonName}`,
    "-out",
    `${input.prefix}.csr`,
  ]);
  await NodeFSP.writeFile(NodePath.join(input.directory, `${input.prefix}.ext`), input.extensions);
  await runOpenSsl(input.directory, [
    "x509",
    "-req",
    "-in",
    `${input.prefix}.csr`,
    "-CA",
    `${input.caPrefix}.crt`,
    "-CAkey",
    `${input.caPrefix}.key`,
    "-CAcreateserial",
    "-sha256",
    "-days",
    "1",
    "-extfile",
    `${input.prefix}.ext`,
    "-out",
    `${input.prefix}.crt`,
  ]);
};

const generateTlsFixture = async (directory: string): Promise<TlsFixture> => {
  await generateCertificateAuthority(directory, "ca");
  await generateCertificateAuthority(directory, "other-ca");
  await generateSignedCertificate({
    directory,
    prefix: "server",
    caPrefix: "ca",
    commonName: "localhost",
    extensions: "subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n",
  });
  await generateSignedCertificate({
    directory,
    prefix: "client",
    caPrefix: "ca",
    commonName: "trusted-worker",
    extensions: `subjectAltName=URI:${sanUri}\nextendedKeyUsage=clientAuth\n`,
  });
  await generateSignedCertificate({
    directory,
    prefix: "other-client",
    caPrefix: "other-ca",
    commonName: "wrong-ca-worker",
    extensions: `subjectAltName=URI:${sanUri}\nextendedKeyUsage=clientAuth\n`,
  });
  await runOpenSsl(directory, [
    "req",
    "-new",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-pkeyopt",
    "ec_param_enc:named_curve",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=self-signed-worker",
    "-keyout",
    "self-client.key",
    "-out",
    "self-client.crt",
  ]);
  const read = (name: string) => NodeFSP.readFile(NodePath.join(directory, name));
  const [
    ca,
    otherCa,
    serverCertificate,
    serverKey,
    clientCertificate,
    clientKey,
    otherClientCertificate,
    otherClientKey,
    selfSignedClientCertificate,
    selfSignedClientKey,
  ] = await Promise.all([
    read("ca.crt"),
    read("other-ca.crt"),
    read("server.crt"),
    read("server.key"),
    read("client.crt"),
    read("client.key"),
    read("other-client.crt"),
    read("other-client.key"),
    read("self-client.crt"),
    read("self-client.key"),
  ]);
  return {
    ca,
    otherCa,
    serverCertificate,
    serverKey,
    clientCertificate,
    clientKey,
    otherClientCertificate,
    otherClientKey,
    selfSignedClientCertificate,
    selfSignedClientKey,
    clientFingerprint: new NodeCrypto.X509Certificate(clientCertificate).fingerprint256,
  };
};

const certificateRecord = (fixture: TlsFixture): WorkerCertificateRecord =>
  ({
    workspaceId: "00000000-0000-4000-8000-000000000001",
    threadId: "thread-1",
    environmentId: "environment-1",
    environmentRevisionId: "revision-1",
    sandboxId: "sandbox-1",
    reservationId: "command-reserve-1",
    workerId: "worker-1",
    providerInstanceId: "codex_personal",
    providerDriver: "codex",
    certificateFingerprint: fixture.clientFingerprint.replaceAll(":", "").toLowerCase(),
    certificateGeneration: 1,
    identityBinding: "test-binding",
    sanUri,
    publicKeySpkiSha256: "test-spki",
    notBefore: "2026-08-27T00:00:00.000Z",
    notAfter: "2026-08-28T00:00:00.000Z",
  }) as WorkerCertificateRecord;

type IdentityMode = "accept" | "fingerprint" | "san" | "expired" | "revoked";

const startTlsBoundary = async (fixture: TlsFixture, mode: IdentityMode) => {
  let authenticationCalls = 0;
  let relayOpens = 0;
  const record = certificateRecord(fixture);
  const identities = {
    clock: { now: Effect.succeed("2026-08-27T12:00:00.000Z") },
    authenticateCertificate: (input: {
      readonly fingerprint: string;
      readonly sanUris: ReadonlyArray<string>;
    }) =>
      Effect.gen(function* () {
        authenticationCalls += 1;
        if (
          mode === "fingerprint" ||
          input.fingerprint.replaceAll(":", "").toLowerCase() !== record.certificateFingerprint
        ) {
          return yield* new WorkerIdentityError({
            code: "mismatch",
            operation: "test-fingerprint",
          });
        }
        if (mode === "san" || !input.sanUris.includes(record.sanUri)) {
          return yield* new WorkerIdentityError({ code: "mismatch", operation: "test-san" });
        }
        if (mode === "expired") {
          return yield* new WorkerIdentityError({ code: "expired", operation: "test-expired" });
        }
        if (mode === "revoked") {
          return yield* new WorkerIdentityError({ code: "revoked", operation: "test-revoked" });
        }
        return record;
      }),
  } as unknown as WorkerIdentityService;
  const relay = {
    limits: { maxFrameBytes: 64 * 1024 },
    open: () =>
      Effect.sync(() => {
        relayOpens += 1;
        return { close: () => undefined };
      }),
    claimCommand: () => Effect.die("not used by the TLS boundary test"),
  } as unknown as WorkerRelay;
  const boundary = createWorkerMtlsServer({
    tls: {
      cert: fixture.serverCertificate,
      key: fixture.serverKey,
      ca: fixture.ca,
      minVersion: "TLSv1.3",
    },
    identities,
    relay,
    limits: { maxConnections: 8, maxPendingHandshakes: 4 },
  });
  await new Promise<void>((resolve, reject) => {
    boundary.server.once("error", reject);
    boundary.server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = boundary.server.address();
  if (address === null || typeof address === "string") throw new Error("TLS listener has no port");
  return {
    boundary,
    url: `wss://localhost:${address.port}/api/v1/worker-relay`,
    authenticationCalls: () => authenticationCalls,
    relayOpens: () => relayOpens,
  };
};

const connect = (url: string, options: WebSocket.ClientOptions): Promise<"accepted" | "rejected"> =>
  new Promise((resolve) => {
    const socket = new WebSocket(url, { ...options, handshakeTimeout: 2_000 });
    let settled = false;
    const complete = (result: "accepted" | "rejected") => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      resolve(result);
    };
    socket.once("open", () => complete("accepted"));
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      complete("rejected");
    });
    socket.once("error", () => complete("rejected"));
  });

const withBoundary = async <A>(
  fixture: TlsFixture,
  mode: IdentityMode,
  use: (boundary: Awaited<ReturnType<typeof startTlsBoundary>>) => Promise<A>,
) => {
  const boundary = await startTlsBoundary(fixture, mode);
  try {
    return await use(boundary);
  } finally {
    await boundary.boundary.close();
  }
};

it.effect("accepts only a trusted client certificate through the full local TLS boundary", () =>
  Effect.acquireUseRelease(
    Effect.tryPromise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "aic-mtls-e2e-"))),
    (directory) =>
      Effect.tryPromise(async () => {
        const fixture = await generateTlsFixture(directory);
        await withBoundary(fixture, "accept", async (boundary) => {
          expect(
            await connect(boundary.url, {
              cert: fixture.clientCertificate,
              key: fixture.clientKey,
              ca: fixture.ca,
            }),
          ).toBe("accepted");
          expect(boundary.authenticationCalls()).toBe(1);
          expect(boundary.relayOpens()).toBe(1);
        });
      }),
    (directory) => Effect.tryPromise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
  ),
);

it.effect("rejects missing, spoofed, self-signed, wrong-CA, and wrong-server-CA peers at TLS", () =>
  Effect.acquireUseRelease(
    Effect.tryPromise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "aic-mtls-e2e-"))),
    (directory) =>
      Effect.tryPromise(async () => {
        const fixture = await generateTlsFixture(directory);
        await withBoundary(fixture, "accept", async (boundary) => {
          const base = { ca: fixture.ca };
          expect(await connect(boundary.url, base)).toBe("rejected");
          expect(
            await connect(boundary.url, { ...base, headers: { "x-client-cert": "spoofed" } }),
          ).toBe("rejected");
          expect(
            await connect(boundary.url, {
              ...base,
              cert: fixture.selfSignedClientCertificate,
              key: fixture.selfSignedClientKey,
            }),
          ).toBe("rejected");
          expect(
            await connect(boundary.url, {
              ...base,
              cert: fixture.otherClientCertificate,
              key: fixture.otherClientKey,
            }),
          ).toBe("rejected");
          expect(
            await connect(boundary.url, {
              cert: fixture.clientCertificate,
              key: fixture.clientKey,
              ca: fixture.otherCa,
            }),
          ).toBe("rejected");
          expect(boundary.authenticationCalls()).toBe(0);
          expect(boundary.relayOpens()).toBe(0);
        });
      }),
    (directory) => Effect.tryPromise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
  ),
);

it.effect(
  "rejects fingerprint, SAN, expiry, and revocation in server-side identity verification",
  () =>
    Effect.acquireUseRelease(
      Effect.tryPromise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "aic-mtls-e2e-"))),
      (directory) =>
        Effect.tryPromise(async () => {
          const fixture = await generateTlsFixture(directory);
          for (const mode of ["fingerprint", "san", "expired", "revoked"] as const) {
            await withBoundary(fixture, mode, async (boundary) => {
              expect(
                await connect(boundary.url, {
                  cert: fixture.clientCertificate,
                  key: fixture.clientKey,
                  ca: fixture.ca,
                }),
              ).toBe("rejected");
              expect(boundary.authenticationCalls()).toBe(1);
              expect(boundary.relayOpens()).toBe(0);
            });
          }
        }),
      (directory) =>
        Effect.tryPromise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    ),
);
