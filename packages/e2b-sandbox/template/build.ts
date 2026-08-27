import * as NodeCrypto from "node:crypto";

import { Sandbox, Template } from "e2b";

import {
  E2B_ACTIVE_TIMEOUT_MS,
  E2B_BASE_TEMPLATE_MANIFEST,
  E2B_BASE_TEMPLATE_NAME,
  E2B_BASE_TEMPLATE_SOURCE_HASH,
  verifyAndAssignImmutableE2bBuildTag,
} from "../src/template.ts";
import { agentsInCloudBaseTemplate } from "./template.ts";

const stagingTag = `staging-${NodeCrypto.randomUUID()}`;
const build = await Template.build(
  agentsInCloudBaseTemplate,
  `${E2B_BASE_TEMPLATE_NAME}:${stagingTag}`,
  { cpuCount: 8, memoryMB: 8_192 },
);
const templateReference = await verifyAndAssignImmutableE2bBuildTag({
  templateName: E2B_BASE_TEMPLATE_NAME,
  stagingTag,
  buildId: build.buildId,
  verificationCommand: E2B_BASE_TEMPLATE_MANIFEST.verificationCommand,
  launchProbe: async (template) => {
    const sandbox = await Sandbox.create(template, {
      timeoutMs: E2B_ACTIVE_TIMEOUT_MS,
      secure: true,
      network: { allowPublicTraffic: false },
    });
    return {
      sandboxId: sandbox.sandboxId,
      execute: (command) => sandbox.commands.run(command),
    };
  },
  destroyProbe: (sandboxId) => Sandbox.kill(sandboxId),
  assignTags: (targetName, tag) => Template.assignTags(targetName, tag),
});

process.stdout.write(
  `${JSON.stringify(
    {
      buildId: build.buildId,
      templateId: build.templateId,
      templateReference,
      sourceHash: E2B_BASE_TEMPLATE_SOURCE_HASH,
      verificationCommand: E2B_BASE_TEMPLATE_MANIFEST.verificationCommand,
    },
    undefined,
    2,
  )}\n`,
);
