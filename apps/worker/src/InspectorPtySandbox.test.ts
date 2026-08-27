// @effect-diagnostics nodeBuiltinImport:off -- The test pins a real disposable workspace descriptor.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeLinuxBubblewrapPtySandbox } from "./InspectorPtySandbox.ts";

it.effect("builds a fail-closed unprivileged network-isolated Bubblewrap command", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "aic-pty-args-"))),
    (workspace) =>
      Effect.gen(function* () {
        const stat = yield* Effect.promise(() => NodeFSP.stat(workspace));
        let executable = "";
        let args: ReadonlyArray<string> = [];
        const sandbox = makeLinuxBubblewrapPtySandbox({
          loadPty: {
            spawn: (nextExecutable: string, nextArgs?: ReadonlyArray<string>) => {
              executable = nextExecutable;
              args = nextArgs ?? [];
              return {} as never;
            },
          } as never,
          hostPlatform: "linux",
          bubblewrapPath: NodeProcess.execPath,
          setprivPath: NodeProcess.execPath,
          agentUid: 65_534,
          agentGid: 65_534,
        });
        sandbox.spawn({
          workspaceMountSource: workspace,
          workspaceMountIdentity: { dev: stat.dev, ino: stat.ino },
          shell: "/bin/sh",
          columns: 80,
          rows: 24,
        });

        expect(executable).toBe("/bin/bash");
        const invocation = args.join("\0");
        for (const required of [
          "--reuid=$uid",
          "--regid=$gid",
          "--clear-groups",
          "--no-new-privs",
          "--unshare-user",
          "--unshare-net",
          "--disable-userns",
          "--cap-drop ALL",
          "--bind /proc/self/fd/9 /workspace",
        ]) {
          expect(invocation).toContain(required);
        }
        expect(invocation).not.toContain("--share-net");
      }),
    (workspace) => Effect.promise(() => NodeFSP.rm(workspace, { recursive: true, force: true })),
  ),
);

it("rejects a privileged inspector identity before spawning", () => {
  expect(() =>
    makeLinuxBubblewrapPtySandbox({
      loadPty: {} as never,
      hostPlatform: "linux",
      bubblewrapPath: NodeProcess.execPath,
      setprivPath: NodeProcess.execPath,
      agentUid: 0,
      agentGid: 0,
    }),
  ).toThrow("dedicated untrusted uid and gid");
});
