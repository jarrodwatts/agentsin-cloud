import * as NodeCrypto from "node:crypto";

export const E2B_BASE_TEMPLATE_NAME = "agentsin-cloud-base";
export const E2B_BASE_TEMPLATE_VERSION = "v2";
export const E2B_DESKTOP_PORT = 6080;
export const E2B_ACTIVE_TIMEOUT_MS = 15 * 60 * 1_000;
export const E2B_TEMPLATE_REF_PREFIX = "e2b://template/";
export const E2B_BASE_SOURCE_IMAGE =
  "node:24.13.1-bookworm@sha256:00e9195ebd49985a6da8921f419978d85dfe354589755192dc090425ce4da2f7";
export const E2B_BASE_TEMPLATE_PACKAGES = Object.freeze([
  "acl",
  "bubblewrap",
  "build-essential",
  "ca-certificates",
  "curl",
  "git",
  "iproute2",
  "novnc",
  "openssh-client",
  "python3",
  "util-linux",
  "websockify",
  "x11-utils",
  "x11vnc",
  "xfce4",
  "xfce4-terminal",
  "xvfb",
]);
export const E2B_DESKTOP_START_SCRIPT_SHA256 =
  "8b2e7f046d90cf94f06aa3eebba66bf5a1ed1df79bb6629d99b1b6fa3f9045c8";
export const E2B_WORKER_START_SCRIPT_SHA256 =
  "c64b4de03f277451ed78650d677b73fa1551a4e68fe804ad33ede441af031d88";
export const E2B_TEMPLATE_DEFINITION_SHA256 =
  "0facf01aa288af76ea7e368be0c15f2820b141ecc56ffc13f069eaaf022cf251";
export const E2B_IMAGE_VERIFICATION_SCRIPT_SHA256 =
  "2475284870d9df0ee0f35259f313b2927730d553793735a63a44a6fa807502b4";
export const E2B_WORKER_PACKAGE_SHA256 =
  "be6d610268058601dfc908a5f2b01c67fcbc8c44abedc9a1fee79aa3ac4ff15e";
export const E2B_WORKER_PACKAGE_LOCK_SHA256 =
  "286db57eb28fc9f00b16095d877785c160d29677e0fb66a8c1c6487193a4c056";
export const E2B_WORKER_ENTRYPOINT_SHA256 =
  "bb00ca28b78cae9c1cb9733fb1013ce541c33904433232fe4b0e6d7f2675f75b";
export const E2B_PROVIDER_RUNTIME_CHILD_SHA256 =
  "68e33a9dae988d5301166d326aba4d1b7aadcc574b4a93c4a9c8170093decff6";

/** Inputs that define the base build. A successful E2B build ID is pinned separately per revision. */
export const E2B_BASE_TEMPLATE_MANIFEST = Object.freeze({
  schemaVersion: 2,
  sourceImage: E2B_BASE_SOURCE_IMAGE,
  packages: E2B_BASE_TEMPLATE_PACKAGES,
  templateDefinitionSha256: E2B_TEMPLATE_DEFINITION_SHA256,
  desktopStartScriptSha256: E2B_DESKTOP_START_SCRIPT_SHA256,
  workerStartScriptSha256: E2B_WORKER_START_SCRIPT_SHA256,
  imageVerificationScriptSha256: E2B_IMAGE_VERIFICATION_SCRIPT_SHA256,
  workerPackageSha256: E2B_WORKER_PACKAGE_SHA256,
  workerPackageLockSha256: E2B_WORKER_PACKAGE_LOCK_SHA256,
  workerEntrypointSha256: E2B_WORKER_ENTRYPOINT_SHA256,
  providerRuntimeChildSha256: E2B_PROVIDER_RUNTIME_CHILD_SHA256,
  desktop: "xfce4",
  desktopTransport: "novnc",
  desktopPort: E2B_DESKTOP_PORT,
  workspaceDirectory: "/workspace",
  agentIdentity: { user: "agentsin-agent", uid: 11_001, gid: 11_001 },
  inspectorIdentity: { user: "agentsin-inspector", uid: 11_002, gid: 11_002 },
  workerEntrypoint: "/opt/agentsin/worker/entrypoint.mjs",
  workerStartCommand: "/opt/agentsin/start-worker.sh <sealed-bootstrap-reference>",
  providerRuntimeModule: "/opt/agentsin/provider/provider-service.mjs",
  verificationCommand: "/opt/agentsin/verify-image.sh",
});

export const E2B_BASE_TEMPLATE_SOURCE_HASH = NodeCrypto.createHash("sha256")
  .update(JSON.stringify(E2B_BASE_TEMPLATE_MANIFEST))
  .digest("hex");

export const assertE2bWorkerArtifactHashes = (input: {
  readonly workerEntrypointSha256: string;
  readonly providerRuntimeChildSha256: string;
}) => {
  if (
    input.workerEntrypointSha256 !== E2B_WORKER_ENTRYPOINT_SHA256 ||
    input.providerRuntimeChildSha256 !== E2B_PROVIDER_RUNTIME_CHILD_SHA256
  ) {
    throw new Error("E2B worker artifacts do not match the immutable template manifest");
  }
};

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
