import { expect, it } from "vite-plus/test";

import type { ThreadId } from "@t3tools/contracts";
import type { WorkspaceId } from "@t3tools/contracts/cloud";

import { artifactObjectKey, MAX_OBJECT_KEY_BYTES, threadExportObjectKey } from "./artifactKeys.ts";

const workspaceId = "00000000-0000-4000-8000-000000000001" as WorkspaceId;
const threadId = "thread-one" as ThreadId;
const digest = "a".repeat(64);

it("creates deterministic tenant/thread scoped keys without raw identities", () => {
  const first = artifactObjectKey(
    { workspaceId, threadId },
    "terminal-chunk",
    "terminal:0001",
    digest,
  );
  const second = artifactObjectKey(
    { workspaceId, threadId },
    "terminal-chunk",
    "terminal:0001",
    digest,
  );
  expect(first).toBe(second);
  expect(first).not.toContain(workspaceId);
  expect(first).not.toContain(threadId);
  expect(first).not.toContain("terminal:0001");
  expect(first).toMatch(/^v1\/w\/[A-Za-z0-9_-]+\/t\/[A-Za-z0-9_-]+\/a\//);
});

it("is injective for distinct well-formed Unicode identities", () => {
  const inputs = ["thread-a", "thread-aa", "é", "emoji-🚀", "日本語", "ß"];
  const keys = inputs.map((value) =>
    artifactObjectKey({ workspaceId, threadId: value as ThreadId }, "diff", "artifact", digest),
  );
  expect(new Set(keys).size).toBe(inputs.length);
});

it("rejects malformed Unicode, normalization aliases, traversal, and path escapes", () => {
  const invalid = ["\ud800", "e\u0301", ".", "..", "a/b", "a\\b", "%2e%2e", "%2Fetc"];
  for (const value of invalid) {
    expect(() =>
      artifactObjectKey(
        { workspaceId, threadId: value as ThreadId },
        "screenshot",
        "artifact",
        digest,
      ),
    ).toThrow();
  }
});

it("uses a separate immutable namespace for exports", () => {
  const key = threadExportObjectKey({ workspaceId, threadId }, "export-1", digest);
  expect(key).toMatch(/\/x\/[A-Za-z0-9_-]+\/[a-f0-9]{64}\.json$/);
  expect(key).not.toContain("export-1");
});

it("enforces the S3-compatible UTF-8 key byte limit after encoding", () => {
  const safe = artifactObjectKey(
    { workspaceId, threadId: `thread-${"🚀".repeat(80)}` as ThreadId },
    "diff",
    "artifact",
    digest,
  );
  expect(new TextEncoder().encode(safe).byteLength).toBeLessThanOrEqual(MAX_OBJECT_KEY_BYTES);
  expect(() =>
    artifactObjectKey(
      { workspaceId, threadId: `thread-${"🚀".repeat(100)}` as ThreadId },
      "diff",
      `artifact-${"🚀".repeat(100)}`,
      digest,
    ),
  ).toThrow(/objectKey/);
});
