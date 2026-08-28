// @effect-diagnostics nodeBuiltinImport:off -- Linux root security integration proof.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { openContainedWorkspace } from "./ContainedWorkspace.ts";

const agentUid = 65_534;
const agentGid = 65_534;
const securityNodePath = NodeProcess.env.AGENTSIN_ROOT_SECURITY_NODE ?? NodeProcess.execPath;

const probePreparedPath = (
  workspace: string,
  protectedPreparedPath: string,
): Promise<{ readonly leakedInCheckout: boolean; readonly substitutionDenied: boolean }> =>
  new Promise((resolve, reject) => {
    let output = "";
    const child = NodeChildProcess.spawn(
      securityNodePath,
      [
        "-e",
        `const fs=require("node:fs");
const [workspace,prepared]=process.argv.slice(1);
const leaked=fs.readdirSync(workspace).some((name)=>name.includes("agentsin")||name.endsWith(".prepared"));
let denied=false;
try{fs.writeFileSync(prepared,"substituted")}catch(error){denied=error.code==="EACCES"||error.code==="EPERM"}
process.stdout.write(JSON.stringify({leakedInCheckout:leaked,substitutionDenied:denied}));`,
        workspace,
        protectedPreparedPath,
      ],
      {
        uid: agentUid,
        gid: agentGid,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      },
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error(`prepared-path probe exited ${String(code)}`));
      else resolve(JSON.parse(output) as never);
    });
  });

describe.skipIf(NodeProcess.env.AGENTSIN_ROOT_SECURITY_TEST !== "1")(
  "contained workspace prepared files",
  () => {
    it.effect("keeps conditional and unconditional prepared inodes outside the provider uid", () =>
      Effect.acquireUseRelease(
        Effect.promise(async () => {
          if (NodeProcess.platform !== "linux" || NodeProcess.getuid?.() !== 0) {
            throw new Error("this security proof must run as root on Linux");
          }
          const directory = await NodeFSP.mkdtemp(
            NodePath.join(NodeOS.tmpdir(), "aic-contained-workspace-root-"),
          );
          await NodeFSP.chmod(directory, 0o711);
          const checkout = NodePath.join(directory, "checkout");
          await NodeFSP.mkdir(checkout, { mode: 0o700 });
          await NodeFSP.chown(checkout, agentUid, agentGid);
          const probes: Array<{
            readonly leakedInCheckout: boolean;
            readonly substitutionDenied: boolean;
          }> = [];
          const workspace = await openContainedWorkspace({
            workspaceDirectory: checkout,
            hostPlatform: "linux",
            requireLinuxDescriptorTraversal: true,
            untrustedUid: agentUid,
            testHooks: {
              afterPreparedBeforeCommit: async (_path, protectedPreparedPath) => {
                probes.push(await probePreparedPath(checkout, protectedPreparedPath));
              },
            },
          });
          return { directory, checkout, probes, workspace };
        }),
        ({ checkout, probes, workspace }) =>
          Effect.promise(async () => {
            const path = NodePath.join(checkout, "safe.txt");
            for (const mode of ["conditional", "unconditional"] as const) {
              await NodeFSP.writeFile(path, "old", { mode: 0o600 });
              await NodeFSP.chown(path, agentUid, agentGid);
              await workspace.write(
                "safe.txt",
                Buffer.from(`new-${mode}`),
                mode === "conditional"
                  ? NodeCrypto.createHash("sha256").update("old").digest("hex")
                  : null,
                new AbortController().signal,
              );
              expect(await NodeFSP.readFile(path, "utf8")).toBe(`new-${mode}`);
            }
            expect(probes).toEqual([
              { leakedInCheckout: false, substitutionDenied: true },
              { leakedInCheckout: false, substitutionDenied: true },
            ]);
          }),
        ({ directory, workspace }) =>
          Effect.promise(async () => {
            await workspace.close();
            await NodeFSP.rm(directory, { recursive: true, force: true });
          }),
      ),
    );
  },
);
