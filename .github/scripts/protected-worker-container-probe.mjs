import { appendFile, readFile, readlink } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import net from "node:net";
import process from "node:process";

const fail = (message) => {
  throw new Error(`Protected container probe failed: ${message}`);
};

if (process.getuid?.() !== 65_534 || process.getgid?.() !== 65_534) {
  fail("unexpected uid or gid");
}
if (process.getgroups().some((group) => group !== 65_534)) fail("supplementary groups remain");

const status = await readFile("/proc/self/status", "utf8");
const field = (name) => new RegExp(`^${name}:\\s+(.+)$`, "mu").exec(status)?.[1];
if (!/^0+$/u.test(field("CapEff") ?? "")) fail("effective capabilities remain");
if (field("NoNewPrivs") !== "1") fail("no-new-privileges is disabled");

const forbiddenEnvironment = Object.keys(process.env).filter((name) =>
  /(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|ACTIONS_RUNTIME|GITHUB_)/u.test(name),
);
if (forbiddenEnvironment.length > 0) {
  fail(`credential-shaped environment reached the container: ${forbiddenEnvironment.join(",")}`);
}

const hostSentinel = process.argv[2];
if (hostSentinel === undefined || !hostSentinel.startsWith("/")) fail("host sentinel is missing");
try {
  await readFile(hostSentinel);
  fail("host sentinel is readable");
} catch (error) {
  if (error instanceof Error && error.message.startsWith("Protected container probe failed:")) {
    throw error;
  }
  if (error?.code !== "ENOENT" && error?.code !== "EACCES") fail("host sentinel denial is unclear");
}

try {
  await readFile("/opt/aic/protected-worker-container-probe.mjs", "utf8");
} catch {
  fail("base-owned probe is unavailable");
}
try {
  await appendFile("/opt/aic/protected-worker-container-probe.mjs", "\n");
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
    const socket = net.createConnection({ host: "1.1.1.1", port: 53 });
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
  await lookup("example.com");
  fail("DNS is reachable");
} catch (error) {
  if (error instanceof Error && error.message.startsWith("Protected container probe failed:")) {
    throw error;
  }
}

const result = {
  uid: process.getuid(),
  gid: process.getgid(),
  groups: process.getgroups(),
  capEff: field("CapEff"),
  noNewPrivs: field("NoNewPrivs"),
  mountNamespace: await readlink("/proc/self/ns/mnt"),
  networkNamespace: await readlink("/proc/self/ns/net"),
  pidNamespace: await readlink("/proc/self/ns/pid"),
  ipcNamespace: await readlink("/proc/self/ns/ipc"),
  utsNamespace: await readlink("/proc/self/ns/uts"),
  hostSentinelDenied: true,
  harnessImmutable: true,
  networkDenied: true,
};
process.stdout.write(`${JSON.stringify(result)}\n`);
