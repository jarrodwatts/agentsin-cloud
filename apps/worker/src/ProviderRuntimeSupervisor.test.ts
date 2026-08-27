// @effect-diagnostics nodeBuiltinImport:off -- Test exercises the real Node subprocess protocol.
// @effect-diagnostics preferSchemaOverJson:off -- Trusted fixture configuration is intentionally minimal.
// @effect-diagnostics effectSucceedWithVoid:off -- The provider emit port requires literal undefined.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

import { CloudThreadCommand } from "@t3tools/contracts/cloud";
import { WorkerBootstrap } from "@t3tools/contracts/worker";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { WorkerCredentialIdentityRuntime } from "./ProviderCredentialExecutor.ts";
import {
  makeRestrictedProviderFactory,
  type TrustedRuntimeArtifactVerifier,
} from "./ProviderRuntimeSupervisor.ts";

const modulePath = NodeURL.fileURLToPath(
  new URL("./fixtures/RestrictedProviderSecurityService.ts", import.meta.url),
);
const childPath = NodeURL.fileURLToPath(new URL("./ProviderRuntimeChild.ts", import.meta.url));
const decodeBootstrap = Schema.decodeUnknownSync(WorkerBootstrap);
const decodeCommand = Schema.decodeUnknownSync(CloudThreadCommand);

const identityRuntime: WorkerCredentialIdentityRuntime = {
  verify: async () => undefined,
  chown: async () => undefined,
  chownFile: async () => undefined,
  isOwnedBy: () => true,
  spawn: async (executable, arguments_, options) => {
    const { uid: _uid, gid: _gid, ...unprivilegedOptions } = options;
    return NodeChildProcess.spawn(executable, [...arguments_], unprivilegedOptions);
  },
};
const artifactVerifier: TrustedRuntimeArtifactVerifier = {
  verify: async (path, expectedSha256, _agentUid, expected) => {
    const stat = await NodeFSP.stat(path);
    const sha256 = NodeCrypto.createHash("sha256")
      .update(await NodeFSP.readFile(path))
      .digest("hex");
    if (
      sha256 !== expectedSha256 ||
      (expected !== undefined && (expected.device !== stat.dev || expected.inode !== stat.ino))
    )
      throw new Error("runtime artifact changed");
    return { device: stat.dev, inode: stat.ino, sha256 };
  },
};

it.effect("proxies a real T3 provider turn through the restricted child protocol", () =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const directory = await NodeFSP.mkdtemp(
        NodePath.join(await NodeFSP.realpath(NodeOS.tmpdir()), "aic-provider-protocol-"),
      );
      const workspace = NodePath.join(directory, "checkout");
      const home = NodePath.join(directory, "home");
      const credentials = NodePath.join(directory, "credentials");
      await Promise.all(
        [workspace, home, credentials].map((path) => NodeFSP.mkdir(path, { mode: 0o700 })),
      );
      const ownCredential = NodePath.join(credentials, "auth.json");
      const siblingCredential = NodePath.join(directory, "sibling.json");
      const mtlsKey = NodePath.join(directory, "mtls.pem");
      const bootstrapFile = NodePath.join(directory, "bootstrap.json");
      const output = NodePath.join(workspace, "proof.json");
      await NodeFSP.writeFile(ownCredential, "ordinary-profile", { mode: 0o600 });
      await Promise.all(
        [siblingCredential, mtlsKey, bootstrapFile].map((path) =>
          NodeFSP.writeFile(path, "test-only", { mode: 0o600 }),
        ),
      );
      await NodeFSP.writeFile(
        NodePath.join(credentials, "probe.json"),
        JSON.stringify({
          ownCredential,
          siblingCredential,
          mtlsKey,
          bootstrap: bootstrapFile,
          output,
        }),
        { mode: 0o600 },
      );
      return { directory, workspace, home, credentials, output };
    }),
    ({ workspace, home, credentials, output }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const moduleSha256 = yield* Effect.promise(async () =>
            NodeCrypto.createHash("sha256")
              .update(await NodeFSP.readFile(modulePath))
              .digest("hex"),
          );
          const childSha256 = yield* Effect.promise(async () =>
            NodeCrypto.createHash("sha256")
              .update(await NodeFSP.readFile(childPath))
              .digest("hex"),
          );
          const identity = decodeBootstrap({
            schemaVersion: 1,
            workerId: "worker-protocol",
            workspaceId: "workspace-protocol",
            environmentId: "environment-protocol",
            environmentRevisionId: "revision-protocol",
            threadId: "thread-protocol",
            sandboxId: "sandbox-protocol",
            reservationId: "command-protocol-reservation",
            provider: { instanceId: "codex-root-security", driver: "codex" },
            workspaceDirectory: workspace,
            bootstrapEndpoint: "https://control.example.com/api/v1/worker-certificates/bootstrap",
            relayEndpoint: "wss://control.example.com/worker",
            relayServerSpkiSha256: "sha256/47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
            relayCredentialRef: "relay-protocol",
            secretLeaseRef: "lease-protocol",
            issuedAt: "2026-08-27T00:00:00.000Z",
            expiresAt: "2026-08-27T23:59:00.000Z",
          });
          const command = decodeCommand({
            schemaVersion: 1,
            workspaceId: identity.workspaceId,
            environmentId: identity.environmentId,
            threadId: identity.threadId,
            command: {
              type: "thread.turn.start",
              commandId: "command-protocol",
              threadId: identity.threadId,
              message: {
                messageId: "message-protocol",
                role: "user",
                text: "exercise provider child",
                attachments: [],
              },
              runtimeMode: "full-access",
              interactionMode: "default",
              createdAt: "2026-08-27T12:00:00.000Z",
            },
            enqueuedAt: "2026-08-27T12:00:00.000Z",
          });
          const uid = NodeProcess.getuid?.();
          const gid = NodeProcess.getgid?.();
          expect(uid).toBeDefined();
          expect(gid).toBeDefined();
          if (uid === undefined || gid === undefined) return;
          const factory = yield* makeRestrictedProviderFactory({
            modulePath,
            moduleSha256,
            childSha256,
            searchPath: NodeProcess.env.PATH ?? "/usr/bin:/bin",
            agentHomeDirectory: home,
            agentUid: uid,
            agentGid: gid,
            identityRuntime,
            artifactVerifier,
          });
          const session = yield* factory.start({
            identity,
            materialization: {
              leaseRef: identity.secretLeaseRef,
              credentialDirectory: credentials,
              environmentVariableNames: [],
              containsWalletMaterial: false,
              scrub: Effect.void,
            },
            emit: () => Effect.succeed(undefined),
          });
          yield* session.dispatch(command);
          const proof = JSON.parse(
            yield* Effect.promise(() => NodeFSP.readFile(output, "utf8")),
          ) as {
            readonly uid: number;
            readonly gid: number;
            readonly own: string;
          };
          expect(proof).toMatchObject({ uid, gid, own: "ordinary-profile" });
        }),
      ),
    ({ directory }) =>
      Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
  ),
);

it.effect("rejects a trusted runtime replacement at the per-spawn verification boundary", () =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const directory = await NodeFSP.mkdtemp(
        NodePath.join(await NodeFSP.realpath(NodeOS.tmpdir()), "aic-provider-replacement-"),
      );
      const workspace = NodePath.join(directory, "checkout");
      const home = NodePath.join(directory, "home");
      const credentials = NodePath.join(directory, "credentials");
      await Promise.all(
        [workspace, home, credentials].map((path) => NodeFSP.mkdir(path, { mode: 0o700 })),
      );
      return { directory, workspace, home, credentials };
    }),
    ({ workspace, home, credentials }) =>
      Effect.gen(function* () {
        const moduleSha256 = yield* Effect.promise(async () =>
          NodeCrypto.createHash("sha256")
            .update(await NodeFSP.readFile(modulePath))
            .digest("hex"),
        );
        const childSha256 = yield* Effect.promise(async () =>
          NodeCrypto.createHash("sha256")
            .update(await NodeFSP.readFile(childPath))
            .digest("hex"),
        );
        let spawns = 0;
        const replacementVerifier: TrustedRuntimeArtifactVerifier = {
          verify: async (path, expectedSha256, _agentUid, expected) => {
            if (expected !== undefined) throw new Error("runtime artifact changed before spawn");
            const stat = await NodeFSP.stat(path);
            return { device: stat.dev, inode: stat.ino, sha256: expectedSha256 };
          },
        };
        const replacementIdentity: WorkerCredentialIdentityRuntime = {
          ...identityRuntime,
          spawn: async () => {
            spawns += 1;
            throw new Error("untrusted runtime must not spawn");
          },
        };
        const factory = yield* makeRestrictedProviderFactory({
          modulePath,
          moduleSha256,
          childSha256,
          searchPath: NodeProcess.env.PATH ?? "/usr/bin:/bin",
          agentHomeDirectory: home,
          agentUid: NodeProcess.getuid?.() ?? 501,
          agentGid: NodeProcess.getgid?.() ?? 20,
          identityRuntime: replacementIdentity,
          artifactVerifier: replacementVerifier,
        });
        const identity = decodeBootstrap({
          schemaVersion: 1,
          workerId: "worker-replacement",
          workspaceId: "workspace-replacement",
          environmentId: "environment-replacement",
          environmentRevisionId: "revision-replacement",
          threadId: "thread-replacement",
          sandboxId: "sandbox-replacement",
          reservationId: "command-replacement-reservation",
          provider: { instanceId: "codex-replacement", driver: "codex" },
          workspaceDirectory: workspace,
          bootstrapEndpoint: "https://control.example.com/api/v1/worker-certificates/bootstrap",
          relayEndpoint: "wss://control.example.com/worker",
          relayServerSpkiSha256: "sha256/47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
          relayCredentialRef: "relay-replacement",
          secretLeaseRef: "lease-replacement",
          issuedAt: "2026-08-27T00:00:00.000Z",
          expiresAt: "2026-08-27T23:59:00.000Z",
        });
        const result = yield* factory
          .start({
            identity,
            materialization: {
              leaseRef: identity.secretLeaseRef,
              credentialDirectory: credentials,
              environmentVariableNames: [],
              containsWalletMaterial: false,
              scrub: Effect.void,
            },
            emit: () => Effect.succeed(undefined),
          })
          .pipe(Effect.exit);
        expect(result._tag).toBe("Failure");
        expect(spawns).toBe(0);
      }),
    ({ directory }) =>
      Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
  ),
);
