const fs = require("node:fs");
const path = require("node:path");

const INSPECTOR_UID = 11002;
const PID_ROOT = "/run/agentsin/desktop/pids";
const PROC_ROOT = "/proc";

const PROCESS_POLICIES = Object.freeze([
  Object.freeze({
    name: "Xvfb",
    executable: "/usr/bin/Xvfb",
    argv: Object.freeze([
      "/usr/bin/Xvfb",
      ":0",
      "-auth",
      "/run/agentsin/desktop/Xauthority",
      "-screen",
      "0",
      "1440x1024x24",
      "-nolisten",
      "tcp",
    ]),
    requiredRootFiles: Object.freeze([]),
  }),
  Object.freeze({
    name: "xfce4-session",
    executable: "/usr/bin/xfce4-session",
    argv: Object.freeze(["/usr/bin/xfce4-session"]),
    requiredRootFiles: Object.freeze([]),
  }),
  Object.freeze({
    name: "x11vnc",
    executable: "/usr/bin/x11vnc",
    argv: Object.freeze([
      "/usr/bin/x11vnc",
      "-display",
      ":0",
      "-auth",
      "/run/agentsin/desktop/Xauthority",
      "-forever",
      "-shared",
      "-localhost",
      "-rfbport",
      "5900",
      "-rfbauth",
      "/run/agentsin/desktop/vnc.passwd",
      "-noxdamage",
      "-repeat",
    ]),
    requiredRootFiles: Object.freeze([]),
  }),
  Object.freeze({
    name: "novnc_proxy",
    executable: "/usr/bin/bash",
    argv: Object.freeze([
      "/usr/bin/bash",
      "/usr/share/novnc/utils/novnc_proxy",
      "--vnc",
      "localhost:5900",
      "--listen",
      "6080",
      "--web",
      "/usr/share/novnc",
      "--heartbeat",
      "30",
    ]),
    requiredRootFiles: Object.freeze(["/usr/share/novnc/utils/novnc_proxy"]),
  }),
]);

const nodeSource = Object.freeze({
  readFile: (target) => fs.readFileSync(target),
  lstat: (target) => fs.lstatSync(target),
  realpath: (target) => fs.realpathSync(target),
  stat: (target) => fs.statSync(target),
});

const fail = (message) => {
  throw new Error(`desktop process identity verification failed: ${message}`);
};

const readText = (source, target) => source.readFile(target).toString("utf8");

const assertInspectorPath = (source, target, expectedMode, kind, expectedType) => {
  const linkStats = source.lstat(target);
  const stats = source.stat(target);
  if (
    linkStats.isSymbolicLink() ||
    stats.uid !== INSPECTOR_UID ||
    (stats.mode & 0o777) !== expectedMode ||
    (expectedType === "file" ? !stats.isFile() : !stats.isDirectory())
  ) {
    fail(`${kind} has an unexpected owner or mode`);
  }
};

const assertRootOwnedImmutableFile = (source, target) => {
  const canonical = source.realpath(target);
  const stats = source.stat(canonical);
  if (!stats.isFile() || stats.uid !== 0 || (stats.mode & 0o022) !== 0) {
    fail(`${target} is not a canonical root-owned immutable file`);
  }
  return canonical;
};

const readStartTime = (source, procRoot, pid) => {
  const text = readText(source, path.join(procRoot, pid, "stat")).trim();
  const close = text.lastIndexOf(") ");
  if (!text.startsWith(`${pid} (`) || close < 0) fail(`process ${pid} has malformed stat data`);
  const fields = text
    .slice(close + 2)
    .trim()
    .split(/\s+/u);
  const startTime = fields[19];
  if (fields.length < 20 || !/^[0-9]+$/u.test(startTime ?? "")) {
    fail(`process ${pid} has no valid start time`);
  }
  return startTime;
};

const assertInspectorStatus = (source, procRoot, pid) => {
  const text = readText(source, path.join(procRoot, pid, "status"));
  const state = /^State:\s+(\S+)/mu.exec(text)?.[1];
  const uids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/mu.exec(text)?.slice(1);
  if (state === undefined || state === "Z") fail(`process ${pid} is not live`);
  if (uids === undefined || uids.some((uid) => Number(uid) !== INSPECTOR_UID)) {
    fail(`process ${pid} escaped the inspector identity`);
  }
};

const readArgv = (source, procRoot, pid) => {
  const bytes = source.readFile(path.join(procRoot, pid, "cmdline"));
  const values = bytes.toString("utf8").split("\0");
  if (values.at(-1) === "") values.pop();
  if (values.length === 0 || values.some((value) => value.length === 0)) {
    fail(`process ${pid} has malformed argv`);
  }
  return values;
};

const arraysEqual = (left, right) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const readRecord = (source, recordPath) => {
  const bytes = source.readFile(recordPath);
  const lines = bytes.toString("utf8").trimEnd().split("\n");
  if (
    lines.length !== 3 ||
    !/^[0-9a-f]{32}$/u.test(lines[0] ?? "") ||
    !/^[1-9][0-9]*$/u.test(lines[1] ?? "") ||
    !/^[0-9]+$/u.test(lines[2] ?? "")
  ) {
    fail(`${recordPath} is malformed`);
  }
  return { bytes, generation: lines[0], pid: lines[1], startTime: lines[2] };
};

const verifyOneProcess = ({ source, procRoot, generation, generationRoot, policy }) => {
  const recordPath = path.join(generationRoot, `${policy.name}.record`);
  assertInspectorPath(source, recordPath, 0o600, `${policy.name} record`, "file");
  const recordBefore = readRecord(source, recordPath);
  if (recordBefore.generation !== generation) fail(`${policy.name} record is from a stale launch`);

  const expectedExecutable = assertRootOwnedImmutableFile(source, policy.executable);
  for (const required of policy.requiredRootFiles) assertRootOwnedImmutableFile(source, required);

  const startBefore = readStartTime(source, procRoot, recordBefore.pid);
  if (startBefore !== recordBefore.startTime)
    fail(`${policy.name} PID was reused before inspection`);
  assertInspectorStatus(source, procRoot, recordBefore.pid);
  const executableBefore = source.realpath(path.join(procRoot, recordBefore.pid, "exe"));
  if (executableBefore !== expectedExecutable) fail(`${policy.name} executable does not match`);
  const argv = readArgv(source, procRoot, recordBefore.pid);
  if (!arraysEqual(argv, policy.argv)) fail(`${policy.name} argv does not match exactly`);

  const startAfter = readStartTime(source, procRoot, recordBefore.pid);
  assertInspectorStatus(source, procRoot, recordBefore.pid);
  const executableAfter = source.realpath(path.join(procRoot, recordBefore.pid, "exe"));
  const recordAfter = readRecord(source, recordPath);
  if (
    startAfter !== startBefore ||
    executableAfter !== executableBefore ||
    !recordAfter.bytes.equals(recordBefore.bytes)
  ) {
    fail(`${policy.name} identity changed during inspection`);
  }
};

const verifyProcessIdentities = ({
  source = nodeSource,
  pidRoot = PID_ROOT,
  procRoot = PROC_ROOT,
  policies = PROCESS_POLICIES,
} = {}) => {
  assertInspectorPath(source, pidRoot, 0o700, "PID root", "directory");
  const currentPath = path.join(pidRoot, "current");
  assertInspectorPath(source, currentPath, 0o600, "launch generation pointer", "file");
  const currentBefore = readText(source, currentPath);
  const generation = currentBefore.trim();
  if (!/^[0-9a-f]{32}$/u.test(generation)) fail("launch generation is malformed");
  const canonicalPidRoot = source.realpath(pidRoot);
  const generationRoot = source.realpath(path.join(pidRoot, generation));
  if (path.dirname(generationRoot) !== canonicalPidRoot) fail("launch generation escaped PID root");
  assertInspectorPath(source, generationRoot, 0o700, "launch generation directory", "directory");

  for (const policy of policies) {
    verifyOneProcess({ source, procRoot, generation, generationRoot, policy });
  }

  if (readText(source, currentPath) !== currentBefore) {
    fail("launch generation changed during inspection");
  }
};

module.exports = { PROCESS_POLICIES, verifyProcessIdentities };

if (require.main === module) {
  try {
    verifyProcessIdentities();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
