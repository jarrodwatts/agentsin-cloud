import * as NodeCrypto from "node:crypto";

export const E2B_BASE_TEMPLATE_NAME = "agentsin-cloud-base";
export const E2B_BASE_TEMPLATE_VERSION = "v3";
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
  "procps",
  "python3",
  "util-linux",
  "websockify",
  "xauth",
  "x11-utils",
  "x11vnc",
  "xfce4",
  "xfce4-terminal",
  "xvfb",
]);
export const E2B_DESKTOP_START_SCRIPT_SHA256 =
  "ea4c9b8b6decc5d09fb8d19453b082ee4997444383b73373cd3bb6ec60853a0e";
export const E2B_SANDBOX_START_SCRIPT_SHA256 =
  "2176edc27efa3be877a499349c3e427574cec49716a977774e16229590d28149";
export const E2B_DESKTOP_SESSION_SCRIPT_SHA256 =
  "e82840136d2882d89a0a3e836faa6da8b4d62611e6577335e6043879166b72bd";
export const E2B_WORKER_START_SCRIPT_SHA256 =
  "d52379c6f80322e55abb60bf10d8755b4839e1bac71dbd54253f37bd1c098318";
export const E2B_TEMPLATE_DEFINITION_SHA256 =
  "7c80c9f2c702afb0116e910055c0315d46e710b7400591926eade392f274923c";
export const E2B_IMAGE_VERIFICATION_SCRIPT_SHA256 =
  "8c760f785008d92aa79b4fcc8842a9cef83afcb8d1bc63eee2a18589c9eff1f7";
export const E2B_PROCESS_IDENTITY_VERIFICATION_SCRIPT_SHA256 =
  "b85093b4a592c40fc8e218bebb11e5be161e186754fddcb51a21f19731b2f56a";
export const E2B_PROVENANCE_VERIFICATION_SCRIPT_SHA256 =
  "972bff1da520b90ebfd43fbb2f08961772f64b595a01efc06eb5c3e1013ac1e5";
export const E2B_WORKER_PACKAGE_SHA256 =
  "be6d610268058601dfc908a5f2b01c67fcbc8c44abedc9a1fee79aa3ac4ff15e";
export const E2B_WORKER_PACKAGE_LOCK_SHA256 =
  "286db57eb28fc9f00b16095d877785c160d29677e0fb66a8c1c6487193a4c056";
export const E2B_WORKER_ENTRYPOINT_SHA256 =
  "bb00ca28b78cae9c1cb9733fb1013ce541c33904433232fe4b0e6d7f2675f75b";
export const E2B_PROVIDER_RUNTIME_CHILD_SHA256 =
  "68e33a9dae988d5301166d326aba4d1b7aadcc574b4a93c4a9c8170093decff6";
export const E2B_IMAGE_PROVENANCE_LOCK_SHA256 =
  "c0ec9f45efa931e3f19a60d40c1ad18168f99668976bf1de6546629c44008a54";
export const E2B_IMAGE_PROVENANCE = Object.freeze({
  publishable: false,
  debianSnapshot: null,
  resolvedAptPackagesSha256: null,
  nodePtyLinuxNativeArtifactsSha256: null,
  releaseGate:
    "A fully built OCI digest, or an immutable Debian snapshot plus resolved package closure and Linux node-pty native artifact digest, is required",
});

/** Inputs that define the base build. A successful E2B build ID is pinned separately per revision. */
export const E2B_BASE_TEMPLATE_MANIFEST = Object.freeze({
  schemaVersion: 3,
  sourceImage: E2B_BASE_SOURCE_IMAGE,
  packages: E2B_BASE_TEMPLATE_PACKAGES,
  imageProvenanceLockSha256: E2B_IMAGE_PROVENANCE_LOCK_SHA256,
  imageProvenance: E2B_IMAGE_PROVENANCE,
  templateDefinitionSha256: E2B_TEMPLATE_DEFINITION_SHA256,
  sandboxStartScriptSha256: E2B_SANDBOX_START_SCRIPT_SHA256,
  desktopStartScriptSha256: E2B_DESKTOP_START_SCRIPT_SHA256,
  desktopSessionScriptSha256: E2B_DESKTOP_SESSION_SCRIPT_SHA256,
  workerStartScriptSha256: E2B_WORKER_START_SCRIPT_SHA256,
  imageVerificationScriptSha256: E2B_IMAGE_VERIFICATION_SCRIPT_SHA256,
  processIdentityVerificationScriptSha256: E2B_PROCESS_IDENTITY_VERIFICATION_SCRIPT_SHA256,
  provenanceVerificationScriptSha256: E2B_PROVENANCE_VERIFICATION_SCRIPT_SHA256,
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
  sandboxStartCommand: "/opt/agentsin/start-sandbox.sh",
  workerStartCommand: "/opt/agentsin/start-worker.sh /run/agentsin/bootstrap/sealed.json",
  providerRuntimeModule: "/opt/agentsin/provider/provider-service.mjs",
  verificationCommand: "/opt/agentsin/verify-image.sh",
});

export const E2B_BASE_TEMPLATE_SOURCE_HASH = NodeCrypto.createHash("sha256")
  .update(JSON.stringify(E2B_BASE_TEMPLATE_MANIFEST))
  .digest("hex");

/** Publishing remains disabled until every mutable package/native input has a resolved digest. */
export const assertE2bImageProvenancePublishable = () => {
  if (
    !E2B_IMAGE_PROVENANCE.publishable ||
    E2B_IMAGE_PROVENANCE.debianSnapshot === null ||
    E2B_IMAGE_PROVENANCE.resolvedAptPackagesSha256 === null ||
    E2B_IMAGE_PROVENANCE.nodePtyLinuxNativeArtifactsSha256 === null
  ) {
    throw new Error(`E2B image provenance is not publishable: ${E2B_IMAGE_PROVENANCE.releaseGate}`);
  }
};

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
