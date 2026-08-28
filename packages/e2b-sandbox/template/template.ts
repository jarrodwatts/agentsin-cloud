// @effect-diagnostics nodeBuiltinImport:off -- E2B resolves copy inputs from the repository root.
import * as NodePath from "node:path";

import { Template, waitForPort } from "e2b";

import {
  E2B_BASE_SOURCE_IMAGE,
  E2B_BASE_TEMPLATE_PACKAGES,
  E2B_IMAGE_PROVENANCE_LOCK_SHA256,
} from "../src/template.ts";

export const agentsInCloudBaseTemplate = Template({
  fileContextPath: NodePath.resolve(import.meta.dirname, "../../.."),
})
  .fromImage(E2B_BASE_SOURCE_IMAGE)
  .aptInstall([...E2B_BASE_TEMPLATE_PACKAGES])
  .runCmd([
    "groupadd --gid 11001 agentsin-agent",
    "useradd --uid 11001 --gid 11001 --create-home --home-dir /home/agentsin-agent --shell /bin/bash agentsin-agent",
    "groupadd --gid 11002 agentsin-inspector",
    "useradd --uid 11002 --gid 11002 --create-home --home-dir /home/agentsin-inspector --shell /bin/bash agentsin-inspector",
    "install -d -o agentsin-agent -g agentsin-agent -m 0700 /home/agentsin-agent",
    "install -d -o agentsin-inspector -g agentsin-inspector -m 0700 /home/agentsin-inspector",
    "install -d -o agentsin-agent -g agentsin-agent -m 0700 /workspace",
    "setfacl -m u:agentsin-inspector:rwx,m:rwx /workspace",
    "setfacl -d -m u::rwx,u:agentsin-inspector:rwx,g::---,m::rwx,o::--- /workspace",
    "install -d -o root -g root -m 0755 /opt/agentsin /opt/agentsin/worker /opt/agentsin/provider",
    "install -d -o root -g root -m 0711 /run/agentsin /run/agentsin/provider-credentials",
    "install -d -o root -g root -m 0700 /run/agentsin/bootstrap /run/agentsin/mtls",
  ])
  .copy("packages/e2b-sandbox/template/start-sandbox.sh", "/opt/agentsin/start-sandbox.sh", {
    mode: 0o555,
  })
  .copy("packages/e2b-sandbox/template/start-desktop.sh", "/opt/agentsin/start-desktop.sh", {
    mode: 0o555,
  })
  .copy("packages/e2b-sandbox/template/desktop-session.sh", "/opt/agentsin/desktop-session.sh", {
    mode: 0o555,
  })
  .copy("packages/e2b-sandbox/template/start-worker.sh", "/opt/agentsin/start-worker.sh", {
    mode: 0o555,
  })
  .copy("packages/e2b-sandbox/template/verify-image.sh", "/opt/agentsin/verify-image.sh", {
    mode: 0o555,
  })
  .copy(
    "packages/e2b-sandbox/template/verify-provenance.cjs",
    "/opt/agentsin/verify-provenance.cjs",
    { mode: 0o444 },
  )
  .copy("apps/worker/dist/entrypoint.mjs", "/opt/agentsin/worker/entrypoint.mjs", {
    mode: 0o555,
  })
  .copy(
    "apps/worker/dist/ProviderRuntimeChild.mjs",
    "/opt/agentsin/worker/ProviderRuntimeChild.mjs",
    { mode: 0o555 },
  )
  .copy("apps/worker/dist/SHA256SUMS", "/opt/agentsin/worker/SHA256SUMS", { mode: 0o444 })
  .copy("packages/e2b-sandbox/template/worker-package.json", "/opt/agentsin/worker/package.json", {
    mode: 0o444,
  })
  .copy(
    "packages/e2b-sandbox/template/worker-package-lock.json",
    "/opt/agentsin/worker/package-lock.json",
    { mode: 0o444 },
  )
  .copy(
    "packages/e2b-sandbox/template/image-provenance.lock.json",
    "/opt/agentsin/image-provenance.lock.json",
    { mode: 0o444 },
  )
  .setWorkdir("/opt/agentsin/worker")
  .runCmd("npm ci --omit=dev --ignore-scripts=false --no-audit --no-fund")
  .runCmd(
    `printf '%s  %s\\n' '${E2B_IMAGE_PROVENANCE_LOCK_SHA256}' '/opt/agentsin/image-provenance.lock.json' | sha256sum --check --strict -`,
  )
  .runCmd("find /opt/agentsin -xdev -not -type l -exec chown root:root {} +")
  .runCmd("find /opt/agentsin -xdev -type d -exec chmod go-w {} +")
  .runCmd("/opt/agentsin/verify-image.sh")
  .setWorkdir("/workspace")
  .setStartCmd("/opt/agentsin/start-sandbox.sh", waitForPort(6080));
