// @effect-diagnostics nodeBuiltinImport:off -- Tests use a disposable filesystem root.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { INSPECTOR_MAX_FILE_BYTES } from "@t3tools/contracts/inspector";
import { expect, it } from "@effect/vitest";

import { ContainedWorkspaceError, openContainedWorkspace } from "./ContainedWorkspace.ts";

it("bounds direct reads before opening or allocating from caller input", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agentsin-contained-read-"));
  const workspace = await openContainedWorkspace({
    workspaceDirectory: root,
    hostPlatform: NodeProcess.platform,
  });
  try {
    const boundary = Buffer.alloc(INSPECTOR_MAX_FILE_BYTES, 0x61);
    await NodeFSP.writeFile(NodePath.join(root, "boundary.bin"), boundary);
    const read = await workspace.read(
      "boundary.bin",
      0,
      INSPECTOR_MAX_FILE_BYTES,
      new AbortController().signal,
    );
    expect(read.bytes).toEqual(boundary);
    expect(read.eof).toBe(true);

    for (const [offset, length] of [
      [0, 8 * 1024 * 1024],
      [-1, 1],
      [0.5, 1],
      [Number.MAX_SAFE_INTEGER + 1, 1],
      [0, 0],
      [0, -1],
      [0, 1.5],
    ] as const) {
      await expect(
        workspace.read("missing.bin", offset, length, new AbortController().signal),
      ).rejects.toMatchObject({
        code: "limit-exceeded",
        operation: "files.read",
      } satisfies Partial<ContainedWorkspaceError>);
    }
  } finally {
    await workspace.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
