import * as NodeCrypto from "node:crypto";

export const E2B_BASE_TEMPLATE_NAME = "agentsin-cloud-base";
export const E2B_BASE_TEMPLATE_VERSION = "v1";
export const E2B_DESKTOP_PORT = 6080;
export const E2B_ACTIVE_TIMEOUT_MS = 15 * 60 * 1_000;
export const E2B_TEMPLATE_REF_PREFIX = "e2b://template/";
export const E2B_BASE_SOURCE_IMAGE =
  "node:24.13.1-bookworm@sha256:00e9195ebd49985a6da8921f419978d85dfe354589755192dc090425ce4da2f7";
export const E2B_BASE_TEMPLATE_PACKAGES = Object.freeze([
  "build-essential",
  "ca-certificates",
  "curl",
  "git",
  "iproute2",
  "novnc",
  "openssh-client",
  "sudo",
  "websockify",
  "x11-utils",
  "x11vnc",
  "xfce4",
  "xfce4-terminal",
  "xvfb",
]);
export const E2B_DESKTOP_START_SCRIPT_SHA256 =
  "8b2e7f046d90cf94f06aa3eebba66bf5a1ed1df79bb6629d99b1b6fa3f9045c8";

/** Inputs that define the base build. A successful E2B build ID is pinned separately per revision. */
export const E2B_BASE_TEMPLATE_MANIFEST = Object.freeze({
  schemaVersion: 1,
  sourceImage: E2B_BASE_SOURCE_IMAGE,
  packages: E2B_BASE_TEMPLATE_PACKAGES,
  desktopStartScriptSha256: E2B_DESKTOP_START_SCRIPT_SHA256,
  desktop: "xfce4",
  desktopTransport: "novnc",
  desktopPort: E2B_DESKTOP_PORT,
  workspaceDirectory: "/workspace",
  verificationCommand:
    "test -d /workspace && command -v git && command -v curl && command -v node && test -x /usr/share/novnc/utils/novnc_proxy",
});

export const E2B_BASE_TEMPLATE_SOURCE_HASH = NodeCrypto.createHash("sha256")
  .update(JSON.stringify(E2B_BASE_TEMPLATE_MANIFEST))
  .digest("hex");

const E2B_BUILD_ID = /^(?<buildId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const E2B_TEMPLATE_BUILD_REFERENCE =
  /^(?<name>[a-z0-9][a-z0-9_/-]*):build-(?<buildId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export const makeE2bImmutableBuildTag = (buildId: string) => {
  const normalized = buildId.trim();
  if (!E2B_BUILD_ID.test(normalized)) throw new Error("An E2B UUID build ID is required");
  return `build-${normalized.toLowerCase()}`;
};

/** Environment revisions store a unique `template:build-<build id>` tag assigned to that build. */
export const makeE2bTemplateReference = (templateName: string, buildId: string) => {
  const value = `${templateName.trim()}:${makeE2bImmutableBuildTag(buildId)}`;
  if (!E2B_TEMPLATE_BUILD_REFERENCE.test(value)) {
    throw new Error("An E2B template name and immutable UUID build ID are required");
  }
  return `${E2B_TEMPLATE_REF_PREFIX}${value}`;
};

export const assignImmutableE2bBuildTag = async (input: {
  readonly templateName: string;
  readonly stagingTag: string;
  readonly buildId: string;
  readonly assignTags: (
    targetName: string,
    tag: string,
  ) => Promise<{ readonly buildId: string; readonly tags: ReadonlyArray<string> }>;
}) => {
  const immutableTag = makeE2bImmutableBuildTag(input.buildId);
  const assigned = await input.assignTags(
    `${input.templateName.trim()}:${input.stagingTag.trim()}`,
    immutableTag,
  );
  if (assigned.buildId !== input.buildId || !assigned.tags.includes(immutableTag)) {
    throw new Error("E2B did not assign the immutable tag to the requested build");
  }
  return makeE2bTemplateReference(input.templateName, input.buildId);
};

/** A template tag is publishable only after E2B can launch it and pass its verification command. */
export const verifyAndAssignImmutableE2bBuildTag = async (input: {
  readonly templateName: string;
  readonly stagingTag: string;
  readonly buildId: string;
  readonly verificationCommand: string;
  readonly launchProbe: (template: string) => Promise<{
    readonly sandboxId: string;
    readonly execute: (command: string) => Promise<{ readonly exitCode: number }>;
  }>;
  readonly destroyProbe: (sandboxId: string) => Promise<boolean>;
  readonly assignTags: (
    targetName: string,
    tag: string,
  ) => Promise<{ readonly buildId: string; readonly tags: ReadonlyArray<string> }>;
}) => {
  const stagingReference = `${input.templateName.trim()}:${input.stagingTag.trim()}`;
  const probe = await input.launchProbe(stagingReference);
  let verificationFailed = false;
  try {
    const result = await probe.execute(input.verificationCommand);
    verificationFailed = result.exitCode !== 0;
  } catch {
    verificationFailed = true;
  }

  let cleanupFailed = false;
  try {
    cleanupFailed = !(await input.destroyProbe(probe.sandboxId));
  } catch {
    cleanupFailed = true;
  }
  if (cleanupFailed) throw new Error("E2B template probe cleanup could not be confirmed");
  if (verificationFailed) throw new Error("E2B template verification failed");

  return assignImmutableE2bBuildTag(input);
};

export const parseE2bTemplateReference = (reference: string) => {
  if (!reference.startsWith(E2B_TEMPLATE_REF_PREFIX)) return undefined;
  const value = reference.slice(E2B_TEMPLATE_REF_PREFIX.length).trim();
  return E2B_TEMPLATE_BUILD_REFERENCE.test(value) ? value : undefined;
};
