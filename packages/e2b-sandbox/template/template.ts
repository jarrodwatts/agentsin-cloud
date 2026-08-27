import { Template, waitForPort } from "e2b";

import { E2B_BASE_SOURCE_IMAGE, E2B_BASE_TEMPLATE_PACKAGES } from "../src/template.ts";

export const agentsInCloudBaseTemplate = Template()
  .fromImage(E2B_BASE_SOURCE_IMAGE)
  .aptInstall([...E2B_BASE_TEMPLATE_PACKAGES])
  .runCmd("mkdir -p /workspace /opt/agentsin")
  .copy("template/start-desktop.sh", "/opt/agentsin/start-desktop.sh")
  .runCmd("chmod 0755 /opt/agentsin/start-desktop.sh")
  .setWorkdir("/workspace")
  .setStartCmd("/opt/agentsin/start-desktop.sh", waitForPort(6080));
