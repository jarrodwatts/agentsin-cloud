// @effect-diagnostics nodeBuiltinImport:off -- Test loads the root-owned CommonJS image verifier.
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

type FakeStats = {
  readonly uid: number;
  readonly mode: number;
  readonly isDirectory: () => boolean;
  readonly isFile: () => boolean;
  readonly isSymbolicLink: () => boolean;
};

type ProcessPolicy = {
  readonly name: string;
  readonly executable: string;
  readonly argv: ReadonlyArray<string>;
  readonly requiredRootFiles: ReadonlyArray<string>;
};

type ProcessIdentityVerifier = {
  readonly PROCESS_POLICIES: ReadonlyArray<ProcessPolicy>;
  readonly verifyProcessIdentities: (input: {
    readonly source: {
      readonly readFile: (path: string) => Buffer;
      readonly lstat: (path: string) => FakeStats;
      readonly realpath: (path: string) => string;
      readonly stat: (path: string) => FakeStats;
    };
    readonly pidRoot: string;
    readonly procRoot: string;
    readonly policies: ReadonlyArray<ProcessPolicy>;
  }) => void;
};

const require = NodeModule.createRequire(import.meta.url);
const verifier = require("../template/verify-process-identity.cjs") as ProcessIdentityVerifier;

const pidRoot = "/fixture/run/desktop/pids";
const procRoot = "/fixture/proc";
const generation = "0123456789abcdef0123456789abcdef";
const pid = "424";
const policy = verifier.PROCESS_POLICIES[0] as ProcessPolicy;
const generationRoot = NodePath.join(pidRoot, generation);

const processStat = (startTime: string) =>
  `${pid} (same uid decoy) S ${Array.from({ length: 18 }, () => "0").join(" ")} ${startTime} 0\n`;

const fakeStats = (input: {
  readonly uid: number;
  readonly mode: number;
  readonly directory: boolean;
}): FakeStats => ({
  uid: input.uid,
  mode: input.mode,
  isDirectory: () => input.directory,
  isFile: () => !input.directory,
  isSymbolicLink: () => false,
});

const makeFixture = (input?: {
  readonly policy?: ProcessPolicy;
  readonly recordedStartTime?: string;
  readonly observedStartTimes?: ReadonlyArray<string>;
}) => {
  const fixturePolicy = input?.policy ?? policy;
  const recordPath = NodePath.join(generationRoot, `${fixturePolicy.name}.record`);
  const recordedStartTime = input?.recordedStartTime ?? "500";
  const observedStartTimes = [...(input?.observedStartTimes ?? ["500", "500"])] as Array<string>;
  const files = new Map<string, Buffer>([
    [NodePath.join(pidRoot, "current"), Buffer.from(`${generation}\n`)],
    [recordPath, Buffer.from(`${generation}\n${pid}\n${recordedStartTime}\n`)],
    [
      NodePath.join(procRoot, pid, "status"),
      Buffer.from("State:\tS (sleeping)\nUid:\t11002\t11002\t11002\t11002\n"),
    ],
    [NodePath.join(procRoot, pid, "cmdline"), Buffer.from(`${fixturePolicy.argv.join("\0")}\0`)],
  ]);
  const stats = new Map<string, FakeStats>([
    [pidRoot, fakeStats({ uid: 11_002, mode: 0o40700, directory: true })],
    [
      NodePath.join(pidRoot, "current"),
      fakeStats({ uid: 11_002, mode: 0o100600, directory: false }),
    ],
    [generationRoot, fakeStats({ uid: 11_002, mode: 0o40700, directory: true })],
    [recordPath, fakeStats({ uid: 11_002, mode: 0o100600, directory: false })],
    [fixturePolicy.executable, fakeStats({ uid: 0, mode: 0o100755, directory: false })],
    ...fixturePolicy.requiredRootFiles.map(
      (target) => [target, fakeStats({ uid: 0, mode: 0o100755, directory: false })] as const,
    ),
  ]);
  const realpaths = new Map<string, string>([
    [pidRoot, pidRoot],
    [generationRoot, generationRoot],
    [fixturePolicy.executable, fixturePolicy.executable],
    [NodePath.join(procRoot, pid, "exe"), fixturePolicy.executable],
    ...fixturePolicy.requiredRootFiles.map((target) => [target, target] as const),
  ]);
  const statPath = NodePath.join(procRoot, pid, "stat");
  return {
    readFile: (target: string) => {
      if (target === statPath) {
        const startTime = observedStartTimes.shift() ?? observedStartTimes.at(-1) ?? "500";
        return Buffer.from(processStat(startTime));
      }
      const value = files.get(target);
      if (value === undefined) throw new Error(`missing fixture file: ${target}`);
      return Buffer.from(value);
    },
    lstat: (target: string) => {
      const value = stats.get(target);
      if (value === undefined) throw new Error(`missing fixture lstat: ${target}`);
      return value;
    },
    realpath: (target: string) => realpaths.get(target) ?? target,
    stat: (target: string) => {
      const value = stats.get(target);
      if (value === undefined) throw new Error(`missing fixture stat: ${target}`);
      return value;
    },
  };
};

it("accepts a process bound to the current generation, PID, start time, executable, and argv", () => {
  expect(() =>
    verifier.verifyProcessIdentities({
      source: makeFixture(),
      pidRoot,
      procRoot,
      policies: [policy],
    }),
  ).not.toThrow();
});

it("rejects a stale record even when a reused PID has the same UID, executable, and argv", () => {
  const noVnc = verifier.PROCESS_POLICIES.find(
    (candidate) => candidate.name === "novnc_proxy",
  ) as ProcessPolicy;
  expect(() =>
    verifier.verifyProcessIdentities({
      source: makeFixture({
        policy: noVnc,
        recordedStartTime: "400",
        observedStartTimes: ["500", "500"],
      }),
      pidRoot,
      procRoot,
      policies: [noVnc],
    }),
  ).toThrow("PID was reused before inspection");
});

it("rejects identity replacement during inspection and pins noVNC interpreter details", () => {
  expect(() =>
    verifier.verifyProcessIdentities({
      source: makeFixture({ observedStartTimes: ["500", "501"] }),
      pidRoot,
      procRoot,
      policies: [policy],
    }),
  ).toThrow("identity changed during inspection");

  const noVnc = verifier.PROCESS_POLICIES.find((candidate) => candidate.name === "novnc_proxy");
  expect(noVnc?.executable).toBe("/usr/bin/bash");
  expect(noVnc?.argv.slice(0, 2)).toEqual(["/usr/bin/bash", "/usr/share/novnc/utils/novnc_proxy"]);
  expect(noVnc?.requiredRootFiles).toEqual(["/usr/share/novnc/utils/novnc_proxy"]);
});
