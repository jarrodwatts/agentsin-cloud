// @effect-diagnostics nodeBuiltinImport:off -- Linux root security integration proof.
// @effect-diagnostics schemaSyncInEffect:off -- Canonical wire fixtures are built at the boundary.
// @effect-diagnostics preferSchemaOverJson:off -- Test fixture writes a trusted probe configuration.
// @effect-diagnostics effectSucceedWithVoid:off -- The provider emit port requires literal undefined.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

import { CloudThreadCommand } from "@t3tools/contracts/cloud";
import { WorkerBootstrap } from "@t3tools/contracts/worker";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeRestrictedProviderFactory } from "./ProviderRuntimeSupervisor.ts";
import { makeNodeWorkerCredentialIdentityRuntime } from "./ProviderCredentialExecutor.ts";

const agentUid = 65_534;
const agentGid = 65_534;
const sourceChildPath = NodeURL.fileURLToPath(
  new URL("./ProviderRuntimeChild.ts", import.meta.url),
);

const KernelProof = Schema.Struct({
  uid: Schema.Number,
  gid: Schema.Number,
  groups: Schema.Array(Schema.Number),
  own: Schema.String,
  mtlsDenied: Schema.Boolean,
  bootstrapDenied: Schema.Boolean,
  siblingDenied: Schema.Boolean,
  privilegedFdInherited: Schema.Boolean,
});
const decodeKernelProof = Schema.decodeUnknownSync(Schema.fromJsonString(KernelProof));
const decodeBootstrap = Schema.decodeUnknownSync(WorkerBootstrap);
const decodeCommand = Schema.decodeUnknownSync(CloudThreadCommand);

const requireLinuxRoot = () => {
  if (NodeProcess.platform !== "linux" || NodeProcess.getuid?.() !== 0)
    throw new Error("this security proof must run as root on Linux");
};

describe.skipIf(NodeProcess.env.AGENTSIN_ROOT_SECURITY_TEST !== "1")(
  "restricted provider runtime",
  () => {
    it.effect("runs the actual T3 provider and its ordinary command as the agent identity", () =>
      Effect.acquireUseRelease(
        Effect.promise(async () => {
          requireLinuxRoot();
          const directory = await NodeFSP.mkdtemp(
            NodePath.join(NodeOS.tmpdir(), "aic-provider-runtime-root-"),
          );
          await NodeFSP.chmod(directory, 0o711);
          const workspace = NodePath.join(directory, "checkout");
          const agentHome = NodePath.join(directory, "agent-home");
          const ownDirectory = NodePath.join(directory, "provider-own");
          const siblingDirectory = NodePath.join(directory, "provider-sibling");
          const mtlsDirectory = NodePath.join(directory, "worker-mtls");
          const workspaceProof = NodePath.join(workspace, "provider-proof.json");
          const trustedRuntime = NodePath.join(directory, "trusted-runtime");
          const interpreterPath = NodePath.join(directory, "trusted-node");
          const replaceableInterpreterPath = NodePath.join(directory, "replaceable-node");
          await NodeFSP.copyFile(NodeProcess.execPath, interpreterPath);
          await NodeFSP.copyFile(NodeProcess.execPath, replaceableInterpreterPath);
          await NodeFSP.chmod(interpreterPath, 0o555);
          await NodeFSP.chmod(replaceableInterpreterPath, 0o555);
          await NodeFSP.cp(NodePath.dirname(sourceChildPath), trustedRuntime, { recursive: true });
          const modulePath = NodePath.join(
            trustedRuntime,
            "fixtures",
            "RestrictedProviderSecurityService.ts",
          );
          const childPath = NodePath.join(trustedRuntime, "ProviderRuntimeChild.ts");
          await NodeFSP.symlink(
            NodePath.resolve(NodePath.dirname(sourceChildPath), "../../..", "node_modules"),
            NodePath.join(directory, "node_modules"),
          );
          await NodeFSP.mkdir(workspace, { mode: 0o700 });
          await NodeFSP.mkdir(agentHome, { mode: 0o700 });
          await NodeFSP.mkdir(ownDirectory, { mode: 0o700 });
          await NodeFSP.mkdir(siblingDirectory, { mode: 0o700 });
          await NodeFSP.mkdir(mtlsDirectory, { mode: 0o700 });
          await Promise.all([
            NodeFSP.chown(workspace, agentUid, agentGid),
            NodeFSP.chown(agentHome, agentUid, agentGid),
            NodeFSP.chown(ownDirectory, agentUid, agentGid),
          ]);
          const ownCredential = NodePath.join(ownDirectory, "auth.json");
          const siblingCredential = NodePath.join(siblingDirectory, "auth.json");
          const mtlsKey = NodePath.join(mtlsDirectory, "client-key.pem");
          const bootstrap = NodePath.join(directory, "bootstrap.json");
          await NodeFSP.writeFile(ownCredential, "own-credential", { mode: 0o400 });
          await NodeFSP.chown(ownCredential, agentUid, agentGid);
          await NodeFSP.writeFile(siblingCredential, "sibling-credential", { mode: 0o400 });
          await NodeFSP.writeFile(mtlsKey, "worker-key", { mode: 0o600 });
          await NodeFSP.writeFile(bootstrap, "worker-bootstrap", { mode: 0o600 });
          const probeConfiguration = NodePath.join(ownDirectory, "probe.json");
          await NodeFSP.writeFile(
            probeConfiguration,
            JSON.stringify({
              ownCredential,
              mtlsKey,
              bootstrap,
              siblingCredential,
              output: workspaceProof,
            }),
            { mode: 0o400 },
          );
          await NodeFSP.chown(probeConfiguration, agentUid, agentGid);
          const mtlsHandle = await NodeFSP.open(mtlsKey, "r");
          const bootstrapHandle = await NodeFSP.open(bootstrap, "r");
          const moduleBytes = await NodeFSP.readFile(modulePath);
          return {
            directory,
            workspace,
            agentHome,
            ownDirectory,
            workspaceProof,
            mtlsHandle,
            bootstrapHandle,
            modulePath,
            childPath,
            moduleSha256: NodeCrypto.createHash("sha256").update(moduleBytes).digest("hex"),
            childSha256: NodeCrypto.createHash("sha256")
              .update(await NodeFSP.readFile(childPath))
              .digest("hex"),
            interpreterPath,
            replaceableInterpreterPath,
            interpreterSha256: NodeCrypto.createHash("sha256")
              .update(await NodeFSP.readFile(interpreterPath))
              .digest("hex"),
          };
        }),
        ({
          workspace,
          agentHome,
          ownDirectory,
          workspaceProof,
          modulePath,
          childPath,
          moduleSha256,
          childSha256,
          interpreterPath,
          replaceableInterpreterPath,
          interpreterSha256,
        }) =>
          Effect.scoped(
            Effect.gen(function* () {
              const bootstrap = decodeBootstrap({
                schemaVersion: 1,
                workerId: "worker-root-security",
                workspaceId: "workspace-root-security",
                environmentId: "environment-root-security",
                environmentRevisionId: "revision-root-security",
                threadId: "thread-root-security",
                sandboxId: "sandbox-root-security",
                reservationId: "command-root-security-reserve",
                provider: { instanceId: "codex-root-security", driver: "codex" },
                workspaceDirectory: workspace,
                bootstrapEndpoint:
                  "https://control.example.com/api/v1/worker-certificates/bootstrap",
                relayEndpoint: "wss://control.example.com/worker",
                relayServerSpkiSha256: "sha256/47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
                relayCredentialRef: "relay-root-security",
                secretLeaseRef: "lease-root-security",
                issuedAt: "2026-08-27T00:00:00.000Z",
                expiresAt: "2026-08-27T23:59:00.000Z",
              });
              const command = decodeCommand({
                schemaVersion: 1,
                workspaceId: bootstrap.workspaceId,
                environmentId: bootstrap.environmentId,
                threadId: bootstrap.threadId,
                command: {
                  type: "thread.turn.start",
                  commandId: "command-root-security",
                  threadId: bootstrap.threadId,
                  message: {
                    messageId: "message-root-security",
                    role: "user",
                    text: "run kernel security probe",
                    attachments: [],
                  },
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  createdAt: "2026-08-27T12:00:00.000Z",
                },
                enqueuedAt: "2026-08-27T12:00:00.000Z",
              });
              const identityRuntime = makeNodeWorkerCredentialIdentityRuntime({
                interpreterPath,
                interpreterSha256,
              });
              const factory = yield* makeRestrictedProviderFactory({
                interpreterPath,
                modulePath,
                moduleSha256,
                childPath,
                childSha256,
                searchPath: NodeProcess.env.PATH ?? "/usr/bin:/bin",
                agentHomeDirectory: agentHome,
                agentUid,
                agentGid,
                identityRuntime,
              });
              const mutation = yield* Effect.promise(
                () =>
                  new Promise<{ readonly code: number | null; readonly signal: string | null }>(
                    (resolve, reject) => {
                      void identityRuntime
                        .spawn(
                          interpreterPath,
                          [
                            "-e",
                            'const fs=require("node:fs");for(const path of process.argv.slice(1)){try{fs.appendFileSync(path,"tamper");process.exit(1)}catch(error){if(error.code!=="EACCES"&&error.code!=="EPERM")process.exit(2)}}',
                            modulePath,
                            childPath,
                          ],
                          {
                            cwd: workspace,
                            uid: agentUid,
                            gid: agentGid,
                            detached: true,
                            shell: false,
                            env: { PATH: "/usr/bin:/bin" },
                            stdio: "ignore",
                          },
                        )
                        .then((child) => {
                          child.once("error", reject);
                          child.once("exit", (code, signal) => resolve({ code, signal }));
                        }, reject);
                    },
                  ),
              );
              expect(mutation).toEqual({ code: 0, signal: null });
              const session = yield* factory.start({
                identity: bootstrap,
                materialization: {
                  leaseRef: bootstrap.secretLeaseRef,
                  credentialDirectory: ownDirectory,
                  environmentVariableNames: [],
                  containsWalletMaterial: false,
                  scrub: Effect.void,
                },
                emit: () => Effect.succeed(undefined),
              });
              yield* session.dispatch(command);
              expect(
                decodeKernelProof(
                  yield* Effect.promise(() => NodeFSP.readFile(workspaceProof, "utf8")),
                ),
              ).toEqual({
                uid: agentUid,
                gid: agentGid,
                groups: [agentGid],
                own: "own-credential",
                mtlsDenied: true,
                bootstrapDenied: true,
                siblingDenied: true,
                privilegedFdInherited: false,
              });

              const unsafe = yield* makeRestrictedProviderFactory({
                modulePath,
                moduleSha256,
                childSha256,
                searchPath: "/usr/bin:/bin",
                agentHomeDirectory: agentHome,
                agentUid: 0,
                agentGid,
              }).pipe(Effect.exit);
              expect(unsafe._tag).toBe("Failure");

              let replaceBeforeSpawn = true;
              const replacementRuntime = makeNodeWorkerCredentialIdentityRuntime({
                interpreterPath: replaceableInterpreterPath,
                interpreterSha256,
                beforePrivilegedSpawn: async () => {
                  if (!replaceBeforeSpawn) return;
                  replaceBeforeSpawn = false;
                  const original = `${replaceableInterpreterPath}.original`;
                  await NodeFSP.rename(replaceableInterpreterPath, original);
                  await NodeFSP.copyFile(original, replaceableInterpreterPath);
                  await NodeFSP.chmod(replaceableInterpreterPath, 0o555);
                },
              });
              expect(
                (yield* Effect.tryPromise(() => replacementRuntime.verify(agentUid, agentGid)).pipe(
                  Effect.exit,
                ))._tag,
              ).toBe("Failure");
              const untrustedLauncher = makeNodeWorkerCredentialIdentityRuntime({
                interpreterPath,
                interpreterSha256,
                launcherSha256: "0".repeat(64),
              });
              expect(
                (yield* Effect.tryPromise(() => untrustedLauncher.verify(agentUid, agentGid)).pipe(
                  Effect.exit,
                ))._tag,
              ).toBe("Failure");
            }),
          ),
        ({ directory, mtlsHandle, bootstrapHandle }) =>
          Effect.promise(async () => {
            await mtlsHandle.close();
            await bootstrapHandle.close();
            await NodeFSP.rm(directory, { recursive: true, force: true });
          }),
      ),
    );
  },
);
