// @effect-diagnostics nodeBuiltinImport:off -- The E2B build entrypoint hashes local image inputs.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { Sandbox, Template } from "e2b";

import {
  E2B_ACTIVE_TIMEOUT_MS,
  E2B_BASE_TEMPLATE_MANIFEST,
  E2B_BASE_TEMPLATE_NAME,
  E2B_BASE_TEMPLATE_SOURCE_HASH,
  assertE2bWorkerArtifactHashes,
  verifyAndAssignImmutableE2bBuildTag,
} from "../src/template.ts";
import { agentsInCloudBaseTemplate } from "./template.ts";

const sha256File = async (path: string) =>
  NodeCrypto.createHash("sha256")
    .update(await NodeFSP.readFile(path))
    .digest("hex");

const repositoryRoot = NodePath.resolve(import.meta.dirname, "../../..");
assertE2bWorkerArtifactHashes({
  workerEntrypointSha256: await sha256File(
    NodePath.join(repositoryRoot, "apps/worker/dist/entrypoint.mjs"),
  ),
  providerRuntimeChildSha256: await sha256File(
    NodePath.join(repositoryRoot, "apps/worker/dist/ProviderRuntimeChild.mjs"),
  ),
});

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
