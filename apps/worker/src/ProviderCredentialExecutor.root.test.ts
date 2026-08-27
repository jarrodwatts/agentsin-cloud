// @effect-diagnostics nodeBuiltinImport:off -- Linux root security integration proof.
// @effect-diagnostics globalDateInEffect:off -- Materialization expiry must be in the live future.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { AgentMaterializationId, AgentProfileId } from "@t3tools/contracts/cloud";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  makeNodeWorkerCredentialIdentityRuntime,
  makeWorkerProviderCredentialExecutor,
} from "./ProviderCredentialExecutor.ts";

const providerInstanceId = "codex-root-security" as ProviderInstanceId;
const providerDriver = "codex" as ProviderDriverKind;
const agentUid = 65_534;
const agentGid = 65_534;

const encodedBundle = (contents: string) => {
  const path = Buffer.from("auth.json");
  const secret = Buffer.from(contents);
  const output = Buffer.alloc(12 + path.length + secret.length);
  output.writeUInt32BE(0x41494350, 0);
  output.writeUInt16BE(1, 4);
  output.writeUInt16BE(path.length, 6);
  output.writeUInt32BE(secret.length, 8);
  path.copy(output, 12);
  secret.copy(output, 12 + path.length);
  return output;
};

const requireLinuxRoot = () => {
  if (NodeProcess.platform !== "linux" || NodeProcess.getuid?.() !== 0) {
    throw new Error("this security proof must run as root on Linux");
  }
};

describe.skipIf(NodeProcess.env.AGENTSIN_ROOT_SECURITY_TEST !== "1")(
  "root worker credential isolation",
  () => {
    it.effect("enforces the real worker-to-agent kernel privilege boundary", () =>
      Effect.acquireUseRelease(
        Effect.promise(async () => {
          requireLinuxRoot();
          const directory = await NodeFSP.mkdtemp(
            NodePath.join(NodeOS.tmpdir(), "aic-root-security-"),
          );
          await NodeFSP.chmod(directory, 0o711);
          const workspace = NodePath.join(directory, "checkout");
          const privateRoot = NodePath.join(directory, "provider-credentials");
          const interpreterPath = NodePath.join(directory, "trusted-node");
          await NodeFSP.mkdir(workspace, { mode: 0o755 });
          await NodeFSP.copyFile(NodeProcess.execPath, interpreterPath);
          await NodeFSP.chmod(interpreterPath, 0o555);
          const interpreterSha256 = NodeCrypto.createHash("sha256")
            .update(await NodeFSP.readFile(interpreterPath))
            .digest("hex");
          return { directory, workspace, privateRoot, interpreterPath, interpreterSha256 };
        }),
        ({ privateRoot, workspace, interpreterPath, interpreterSha256 }) =>
          Effect.gen(function* () {
            const identityRuntime = makeNodeWorkerCredentialIdentityRuntime({
              interpreterPath,
              interpreterSha256,
            });
            const executor = yield* makeWorkerProviderCredentialExecutor({
              privateRoot,
              workspaceDirectory: workspace,
              agentUid,
              agentGid,
              identityRuntime,
            });

            const outsideSentinel = NodePath.join(
              NodePath.dirname(privateRoot),
              "outside-sentinel",
            );
            yield* Effect.promise(() =>
              NodeFSP.writeFile(outsideSentinel, "untouched", { mode: 0o600 }),
            );
            const traversal = yield* executor
              .execute(
                {
                  type: "provider.credentials.command",
                  operation: "cleanup",
                  operationId: "x/../../../outside-sentinel" as AgentMaterializationId,
                  routeGeneration: 1,
                  profileId: "profile-own" as AgentProfileId,
                  profileGeneration: 1,
                  providerInstanceId,
                  providerDriver,
                },
                undefined,
                () => Effect.void,
              )
              .pipe(Effect.exit);
            expect(traversal._tag).toBe("Failure");
            expect(yield* Effect.promise(() => NodeFSP.readFile(outsideSentinel, "utf8"))).toBe(
              "untouched",
            );

            const originalRoot = `${privateRoot}-original`;
            yield* Effect.promise(async () => {
              await NodeFSP.rename(privateRoot, originalRoot);
              await NodeFSP.symlink(workspace, privateRoot);
            });
            const replacementPayload = encodedBundle("must-not-escape");
            const replacement = yield* executor
              .execute(
                {
                  type: "provider.credentials.command",
                  operation: "materialize",
                  operationId: "replacement-attempt" as AgentMaterializationId,
                  routeGeneration: 1,
                  profileId: "profile-own" as AgentProfileId,
                  profileGeneration: 1,
                  providerInstanceId,
                  providerDriver,
                  authorizationExpiresAt: new Date(Date.now() + 60_000).toISOString(),
                  credentialPayloadBytes: replacementPayload.byteLength,
                },
                replacementPayload,
                () => Effect.void,
              )
              .pipe(Effect.exit);
            expect(replacement._tag).toBe("Failure");
            expect(replacementPayload.every((byte) => byte === 0)).toBe(true);
            expect(yield* Effect.promise(() => NodeFSP.readdir(workspace))).toEqual([]);
            expect(yield* Effect.promise(() => NodeFSP.readFile(outsideSentinel, "utf8"))).toBe(
              "untouched",
            );
            yield* Effect.promise(async () => {
              await NodeFSP.unlink(privateRoot);
              await NodeFSP.rename(originalRoot, privateRoot);
            });

            const ownPayload = encodedBundle("own-credential");
            yield* executor.execute(
              {
                type: "provider.credentials.command",
                operation: "materialize",
                operationId: "own-profile" as AgentMaterializationId,
                routeGeneration: 1,
                profileId: "profile-own" as AgentProfileId,
                profileGeneration: 1,
                providerInstanceId,
                providerDriver,
                authorizationExpiresAt: new Date(Date.now() + 60_000).toISOString(),
                credentialPayloadBytes: ownPayload.byteLength,
              },
              ownPayload,
              () => Effect.void,
            );

            const unsafeExecutor = yield* makeWorkerProviderCredentialExecutor({
              privateRoot: NodePath.join(NodePath.dirname(privateRoot), "unsafe-root"),
              workspaceDirectory: workspace,
              agentUid: 0,
              agentGid,
              identityRuntime,
            }).pipe(Effect.exit);
            expect(unsafeExecutor._tag).toBe("Failure");
          }),
        ({ directory }) =>
          Effect.promise(async () => {
            await NodeFSP.rm(directory, { recursive: true, force: true });
          }),
      ),
    );
  },
);
