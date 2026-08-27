import { describe, expect, it } from "vite-plus/test";

import { verifyAndAssignImmutableE2bBuildTag } from "./template.ts";

const BUILD_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

describe("verified E2B template publishing", () => {
  it("launches and verifies the staged build before assigning its immutable tag", async () => {
    const operations: Array<string> = [];
    const reference = await verifyAndAssignImmutableE2bBuildTag({
      templateName: "agentsin-cloud-base",
      stagingTag: "staging-verified",
      buildId: BUILD_ID,
      verificationCommand: "test -d /workspace",
      launchProbe: async (template) => {
        operations.push(`launch:${template}`);
        return {
          sandboxId: "probe-1",
          execute: async (command) => {
            operations.push(`verify:${command}`);
            return { exitCode: 0 };
          },
        };
      },
      destroyProbe: async (sandboxId) => {
        operations.push(`destroy:${sandboxId}`);
        return true;
      },
      assignTags: async (target, tag) => {
        operations.push(`assign:${target}:${tag}`);
        return { buildId: BUILD_ID, tags: [tag] };
      },
    });

    expect(reference).toBe(`e2b://template/agentsin-cloud-base:build-${BUILD_ID}`);
    expect(operations).toEqual([
      "launch:agentsin-cloud-base:staging-verified",
      "verify:test -d /workspace",
      "destroy:probe-1",
      `assign:agentsin-cloud-base:staging-verified:build-${BUILD_ID}`,
    ]);
  });

  it("cleans up a failed verification probe without publishing the launch tag", async () => {
    let assignCalls = 0;
    let destroyCalls = 0;
    await expect(
      verifyAndAssignImmutableE2bBuildTag({
        templateName: "agentsin-cloud-base",
        stagingTag: "staging-failed",
        buildId: BUILD_ID,
        verificationCommand: "verify-template",
        launchProbe: async () => ({
          sandboxId: "probe-2",
          execute: async () => ({ exitCode: 1 }),
        }),
        destroyProbe: async () => {
          destroyCalls += 1;
          return true;
        },
        assignTags: async (_target, tag) => {
          assignCalls += 1;
          return { buildId: BUILD_ID, tags: [tag] };
        },
      }),
    ).rejects.toThrow("E2B template verification failed");

    expect(destroyCalls).toBe(1);
    expect(assignCalls).toBe(0);
  });

  it("refuses to publish when probe cleanup cannot be confirmed", async () => {
    let assignCalls = 0;
    await expect(
      verifyAndAssignImmutableE2bBuildTag({
        templateName: "agentsin-cloud-base",
        stagingTag: "staging-cleanup-failed",
        buildId: BUILD_ID,
        verificationCommand: "verify-template",
        launchProbe: async () => ({
          sandboxId: "probe-3",
          execute: async () => ({ exitCode: 0 }),
        }),
        destroyProbe: async () => false,
        assignTags: async (_target, tag) => {
          assignCalls += 1;
          return { buildId: BUILD_ID, tags: [tag] };
        },
      }),
    ).rejects.toThrow("E2B template probe cleanup could not be confirmed");

    expect(assignCalls).toBe(0);
  });
});
