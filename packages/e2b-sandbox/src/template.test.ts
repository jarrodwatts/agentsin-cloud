// @effect-diagnostics nodeBuiltinImport:off -- Template tests hash checked-in filesystem inputs.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import { Template } from "e2b";
import { describe, expect, it } from "vite-plus/test";

import {
  E2B_BASE_TEMPLATE_MANIFEST,
  E2B_DESKTOP_SESSION_SCRIPT_SHA256,
  E2B_DESKTOP_START_SCRIPT_SHA256,
  E2B_IMAGE_PROVENANCE_LOCK_SHA256,
  E2B_IMAGE_VERIFICATION_SCRIPT_SHA256,
  E2B_PROVENANCE_VERIFICATION_SCRIPT_SHA256,
  E2B_SANDBOX_START_SCRIPT_SHA256,
  E2B_TEMPLATE_DEFINITION_SHA256,
  E2B_WORKER_PACKAGE_LOCK_SHA256,
  E2B_WORKER_PACKAGE_SHA256,
  E2B_WORKER_START_SCRIPT_SHA256,
  assertE2bImageProvenancePublishable,
  assertE2bWorkerArtifactHashes,
  verifyAndAssignImmutableE2bBuildTag,
} from "./template.ts";
import { agentsInCloudBaseTemplate } from "../template/template.ts";

const BUILD_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const sha256 = async (path: URL) =>
  NodeCrypto.createHash("sha256")
    .update(await NodeFSP.readFile(path))
    .digest("hex");

describe("immutable E2B worker image manifest", () => {
  it("pins the least-privilege worker runtime and fixed boot contract", () => {
    expect(E2B_BASE_TEMPLATE_MANIFEST).toMatchObject({
      schemaVersion: 3,
      agentIdentity: { user: "agentsin-agent", uid: 11_001, gid: 11_001 },
      inspectorIdentity: { user: "agentsin-inspector", uid: 11_002, gid: 11_002 },
      workspaceDirectory: "/workspace",
      workerEntrypoint: "/opt/agentsin/worker/entrypoint.mjs",
      sandboxStartCommand: "/opt/agentsin/start-sandbox.sh",
      workerStartCommand: "/opt/agentsin/start-worker.sh /run/agentsin/bootstrap/sealed.json",
      providerRuntimeModule: "/opt/agentsin/provider/provider-service.mjs",
      verificationCommand: "/opt/agentsin/verify-image.sh",
    });
    expect(E2B_BASE_TEMPLATE_MANIFEST.packages).toEqual(
      expect.arrayContaining(["acl", "bubblewrap", "procps", "util-linux", "xauth"]),
    );
    expect(E2B_BASE_TEMPLATE_MANIFEST.packages).not.toContain("sudo");
  });

  it("binds every checked-in image input to the manifest", async () => {
    await expect(sha256(new URL("../template/template.ts", import.meta.url))).resolves.toBe(
      E2B_TEMPLATE_DEFINITION_SHA256,
    );
    await expect(sha256(new URL("../template/start-sandbox.sh", import.meta.url))).resolves.toBe(
      E2B_SANDBOX_START_SCRIPT_SHA256,
    );
    await expect(sha256(new URL("../template/start-desktop.sh", import.meta.url))).resolves.toBe(
      E2B_DESKTOP_START_SCRIPT_SHA256,
    );
    await expect(sha256(new URL("../template/desktop-session.sh", import.meta.url))).resolves.toBe(
      E2B_DESKTOP_SESSION_SCRIPT_SHA256,
    );
    await expect(sha256(new URL("../template/start-worker.sh", import.meta.url))).resolves.toBe(
      E2B_WORKER_START_SCRIPT_SHA256,
    );
    await expect(sha256(new URL("../template/verify-image.sh", import.meta.url))).resolves.toBe(
      E2B_IMAGE_VERIFICATION_SCRIPT_SHA256,
    );
    await expect(
      sha256(new URL("../template/verify-provenance.cjs", import.meta.url)),
    ).resolves.toBe(E2B_PROVENANCE_VERIFICATION_SCRIPT_SHA256);
    await expect(sha256(new URL("../template/worker-package.json", import.meta.url))).resolves.toBe(
      E2B_WORKER_PACKAGE_SHA256,
    );
    await expect(
      sha256(new URL("../template/worker-package-lock.json", import.meta.url)),
    ).resolves.toBe(E2B_WORKER_PACKAGE_LOCK_SHA256);
    await expect(
      sha256(new URL("../template/image-provenance.lock.json", import.meta.url)),
    ).resolves.toBe(E2B_IMAGE_PROVENANCE_LOCK_SHA256);
  });

  it("boots through the fixed supervisor and reaches the worker entrypoint", async () => {
    const dockerfile = Template.toDockerfile(agentsInCloudBaseTemplate);
    expect(dockerfile).toContain(
      "COPY packages/e2b-sandbox/template/start-sandbox.sh /opt/agentsin/start-sandbox.sh",
    );
    expect(dockerfile).toContain(
      "COPY packages/e2b-sandbox/template/start-worker.sh /opt/agentsin/start-worker.sh",
    );
    expect(dockerfile).toContain("ENTRYPOINT /opt/agentsin/start-sandbox.sh");

    const supervisor = await NodeFSP.readFile(
      new URL("../template/start-sandbox.sh", import.meta.url),
      "utf8",
    );
    expect(supervisor).toContain('readonly bootstrap_ref="/run/agentsin/bootstrap/sealed.json"');
    expect(supervisor.match(/\/opt\/agentsin\/start-worker\.sh/g)).toHaveLength(1);
    expect(supervisor).toContain('wait -n "${desktop_pid}" "${worker_pid}"');
    expect(supervisor).not.toContain('x11vnc -storepasswd "${vnc_password}"');
  });

  it("keeps the desktop behind the inspector identity and authenticated X/VNC boundaries", async () => {
    const startDesktop = await NodeFSP.readFile(
      new URL("../template/start-desktop.sh", import.meta.url),
      "utf8",
    );
    const desktopSession = await NodeFSP.readFile(
      new URL("../template/desktop-session.sh", import.meta.url),
      "utf8",
    );
    const verifier = await NodeFSP.readFile(
      new URL("../template/verify-image.sh", import.meta.url),
      "utf8",
    );

    expect(startDesktop).toContain("/usr/bin/setpriv");
    expect(startDesktop).toContain("--reuid=11002");
    expect(startDesktop).toContain("--regid=11002");
    expect(startDesktop).toContain("-- /usr/bin/env -i");
    expect(desktopSession).toContain('-auth "${XAUTHORITY}"');
    expect(desktopSession).toContain('-rfbauth "${vnc_password_file}"');
    expect(desktopSession).toContain("-localhost");
    expect(desktopSession).not.toMatch(/(^|\s)-ac(\s|$)/u);
    expect(desktopSession).not.toContain("-nopw");
    expect(verifier).toContain("if 1 in security_types or 2 not in security_types:");
    expect(verifier).toContain("if ($1 != 11002) exit 1");
    expect(verifier).toContain("XAUTHORITY=/dev/null xdpyinfo");
    expect(verifier.indexOf("/opt/agentsin/start-sandbox.sh")).toBeLessThan(
      verifier.indexOf("node /opt/agentsin/verify-provenance.cjs"),
    );
  });

  it("refuses publication while apt and node-pty provenance remain unresolved", () => {
    expect(E2B_BASE_TEMPLATE_MANIFEST.imageProvenance).toMatchObject({
      publishable: false,
      debianSnapshot: null,
      resolvedAptPackagesSha256: null,
      nodePtyLinuxNativeArtifactsSha256: null,
    });
    expect(() => assertE2bImageProvenancePublishable()).toThrow(
      "E2B image provenance is not publishable",
    );
  });

  it("keeps the checked-in provenance lock aligned with the source manifest", async () => {
    const lock = JSON.parse(
      await NodeFSP.readFile(
        new URL("../template/image-provenance.lock.json", import.meta.url),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(lock).toMatchObject({
      publishable: E2B_BASE_TEMPLATE_MANIFEST.imageProvenance.publishable,
      bootstrapSourceImage: E2B_BASE_TEMPLATE_MANIFEST.sourceImage,
      debianSnapshot: E2B_BASE_TEMPLATE_MANIFEST.imageProvenance.debianSnapshot,
      resolvedAptPackagesSha256:
        E2B_BASE_TEMPLATE_MANIFEST.imageProvenance.resolvedAptPackagesSha256,
      nodePtyLinuxNativeArtifactsSha256:
        E2B_BASE_TEMPLATE_MANIFEST.imageProvenance.nodePtyLinuxNativeArtifactsSha256,
    });
  });

  it("checks provenance before any remote template build", async () => {
    const buildSource = await NodeFSP.readFile(
      new URL("../template/build.ts", import.meta.url),
      "utf8",
    );
    expect(buildSource.indexOf("assertE2bImageProvenancePublishable();")).toBeGreaterThan(-1);
    expect(buildSource.indexOf("assertE2bImageProvenancePublishable();")).toBeLessThan(
      buildSource.indexOf("Template.build("),
    );
  });

  it("refuses worker bundles that differ from the immutable manifest", () => {
    expect(() =>
      assertE2bWorkerArtifactHashes({
        workerEntrypointSha256: E2B_BASE_TEMPLATE_MANIFEST.workerEntrypointSha256,
        providerRuntimeChildSha256: E2B_BASE_TEMPLATE_MANIFEST.providerRuntimeChildSha256,
      }),
    ).not.toThrow();
    expect(() =>
      assertE2bWorkerArtifactHashes({
        workerEntrypointSha256: "0".repeat(64),
        providerRuntimeChildSha256: E2B_BASE_TEMPLATE_MANIFEST.providerRuntimeChildSha256,
      }),
    ).toThrow("do not match");
  });
});

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
