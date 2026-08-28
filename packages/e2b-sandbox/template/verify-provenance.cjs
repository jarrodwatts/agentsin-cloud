const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const lock = JSON.parse(fs.readFileSync("/opt/agentsin/image-provenance.lock.json", "utf8"));
if (
  lock.publishable !== true ||
  typeof lock.debianSnapshot !== "string" ||
  !/^[0-9a-f]{64}$/.test(lock.resolvedAptPackagesSha256) ||
  !/^[0-9a-f]{64}$/.test(lock.nodePtyLinuxNativeArtifactsSha256)
) {
  throw new Error("E2B image provenance is not publishable");
}

const aptSourceFiles = ["/etc/apt/sources.list"];
if (fs.existsSync("/etc/apt/sources.list.d")) {
  for (const name of fs.readdirSync("/etc/apt/sources.list.d")) {
    aptSourceFiles.push(path.join("/etc/apt/sources.list.d", name));
  }
}
const aptSources = aptSourceFiles
  .filter((file) => fs.existsSync(file) && fs.statSync(file).isFile())
  .map((file) => fs.readFileSync(file, "utf8"))
  .join("\n");
if (!aptSources.includes(lock.debianSnapshot)) {
  throw new Error("apt sources do not use the locked Debian snapshot");
}

const resolvedPackages =
  childProcess
    .execFileSync("/usr/bin/dpkg-query", ["-W", "-f=${Package}=${Version}\\n"], {
      encoding: "utf8",
    })
    .trim()
    .split("\n")
    .sort()
    .join("\n") + "\n";
const packageDigest = crypto.createHash("sha256").update(resolvedPackages).digest("hex");
if (packageDigest !== lock.resolvedAptPackagesSha256) {
  throw new Error("resolved apt package closure does not match provenance");
}

const packageRoot = path.dirname(require.resolve("node-pty/package.json"));
const architecture = os.arch();
const nativeCandidates = [
  "build/Release/pty.node",
  "build/Release/spawn-helper",
  `prebuilds/linux-${architecture}/pty.node`,
  `prebuilds/linux-${architecture}/spawn-helper`,
];
const nativeArtifacts = nativeCandidates
  .filter((relative) => fs.existsSync(path.join(packageRoot, relative)))
  .sort()
  .map((relative) => {
    const digest = crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(packageRoot, relative)))
      .digest("hex");
    return `${relative}=${digest}`;
  });
if (nativeArtifacts.length < 2) {
  throw new Error("node-pty Linux native artifact closure is incomplete");
}
const nativeDigest = crypto
  .createHash("sha256")
  .update(`${nativeArtifacts.join("\n")}\n`)
  .digest("hex");
if (nativeDigest !== lock.nodePtyLinuxNativeArtifactsSha256) {
  throw new Error("node-pty Linux native artifact closure does not match provenance");
}
