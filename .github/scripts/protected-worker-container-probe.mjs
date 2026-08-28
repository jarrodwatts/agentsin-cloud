import * as NodeDnsPromises from "node:dns/promises";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeProcess from "node:process";

const fail = (message) => {
  throw new Error(`Protected container probe failed: ${message}`);
};

if (NodeProcess.getuid?.() !== 65_534 || NodeProcess.getgid?.() !== 65_534) {
  fail("unexpected uid or gid");
}
if (NodeProcess.getgroups().some((group) => group !== 65_534)) {
  fail("supplementary groups remain");
}

const status = await NodeFSP.readFile("/proc/self/status", "utf8");
const field = (name) => new RegExp(`^${name}:\\s+(.+)$`, "mu").exec(status)?.[1];
if (!/^0+$/u.test(field("CapEff") ?? "")) fail("effective capabilities remain");
if (field("NoNewPrivs") !== "1") fail("no-new-privileges is disabled");

const forbiddenEnvironment = Object.keys(NodeProcess.env).filter((name) =>
  /(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|ACTIONS_RUNTIME|GITHUB_)/u.test(name),
);
if (forbiddenEnvironment.length > 0) {
  fail(`credential-shaped environment reached the container: ${forbiddenEnvironment.join(",")}`);
}

const hostSentinel = NodeProcess.argv[2];
if (hostSentinel === undefined || !hostSentinel.startsWith("/")) fail("host sentinel is missing");
try {
  await NodeFSP.readFile(hostSentinel);
  fail("host sentinel is readable");
} catch (error) {
  if (error instanceof Error && error.message.startsWith("Protected container probe failed:")) {
    throw error;
  }
  if (error?.code !== "ENOENT" && error?.code !== "EACCES") fail("host sentinel denial is unclear");
}

try {
  await NodeFSP.readFile("/opt/aic/protected-worker-container-probe.mjs", "utf8");
} catch {
  fail("base-owned probe is unavailable");
}
try {
  await NodeFSP.appendFile("/opt/aic/protected-worker-container-probe.mjs", "\n");
  fail("base-owned probe is mutable");
} catch (error) {
  if (error instanceof Error && error.message.startsWith("Protected container probe failed:")) {
    throw error;
  }
  if (error?.code !== "EROFS" && error?.code !== "EACCES" && error?.code !== "EPERM") {
    fail("base-owned probe immutability is unclear");
  }
}

const connect = () =>
  new Promise((resolve) => {
    const socket = NodeNet.createConnection({ host: "1.1.1.1", port: 53 });
    const finish = (reached) => {
      socket.destroy();
      resolve(reached);
    };
    socket.setTimeout(1_000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
if (await connect()) fail("external network is reachable");
try {
  await NodeDnsPromises.lookup("example.com");
  fail("DNS is reachable");
} catch (error) {
  if (error instanceof Error && error.message.startsWith("Protected container probe failed:")) {
    throw error;
  }
}

const result = {
  uid: NodeProcess.getuid(),
  gid: NodeProcess.getgid(),
  groups: NodeProcess.getgroups(),
  capEff: field("CapEff"),
  noNewPrivs: field("NoNewPrivs"),
  mountNamespace: await NodeFSP.readlink("/proc/self/ns/mnt"),
  networkNamespace: await NodeFSP.readlink("/proc/self/ns/net"),
  pidNamespace: await NodeFSP.readlink("/proc/self/ns/pid"),
  ipcNamespace: await NodeFSP.readlink("/proc/self/ns/ipc"),
  utsNamespace: await NodeFSP.readlink("/proc/self/ns/uts"),
  hostSentinelDenied: true,
  harnessImmutable: true,
  networkDenied: true,
};
NodeProcess.stdout.write(`${JSON.stringify(result)}\n`);
