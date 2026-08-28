const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { validateTreeRecords } = require("./protected-worker-source-lib.cjs");

const fail = (message) => {
  throw new Error(`Protected worker source checkout failed closed: ${message}`);
};

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`cannot decode the GitHub event (${String(error)})`);
  }
};

const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  }).trim();

const hashFile = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const walkFiles = (directory, root = directory) => {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) return walkFiles(absolute, root);
      if (!entry.isFile()) fail(`dependency input is not a regular file: ${absolute}`);
      return [path.relative(root, absolute)];
    })
    .sort();
};

const assertSameFile = (baseRoot, prRoot, relative) => {
  const baseFile = path.join(baseRoot, relative);
  const prFile = path.join(prRoot, relative);
  if (!fs.existsSync(baseFile) || !fs.existsSync(prFile)) {
    fail(`protected dependency input changed: ${relative}`);
  }
  if (hashFile(baseFile) !== hashFile(prFile)) {
    fail(`protected dependency input changed: ${relative}`);
  }
};

const assertSameDirectory = (baseRoot, prRoot, relative) => {
  const baseDirectory = path.join(baseRoot, relative);
  const prDirectory = path.join(prRoot, relative);
  const baseFiles = walkFiles(baseDirectory);
  const prFiles = walkFiles(prDirectory);
  if (JSON.stringify(baseFiles) !== JSON.stringify(prFiles)) {
    fail(`protected dependency directory changed: ${relative}`);
  }
  for (const file of baseFiles) assertSameFile(baseRoot, prRoot, path.join(relative, file));
};

const [baseInput, outputInput] = process.argv.slice(2);
if (baseInput === undefined || outputInput === undefined) {
  fail("usage: protected-worker-source.cjs <protected-base> <output-directory>");
}

const runnerTemp = process.env.RUNNER_TEMP;
const eventPath = process.env.GITHUB_EVENT_PATH;
const repository = process.env.GITHUB_REPOSITORY;
const serverUrl = process.env.GITHUB_SERVER_URL;
if (runnerTemp === undefined || eventPath === undefined || repository === undefined) {
  fail("required GitHub Actions environment is missing");
}
if (serverUrl !== "https://github.com") fail("only github.com pull requests are supported");
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
  fail("repository identity is malformed");
}

const baseRoot = fs.realpathSync(baseInput);
const outputRoot = path.resolve(outputInput);
const temporaryRoot = fs.realpathSync(runnerTemp);
if (!outputRoot.startsWith(`${temporaryRoot}${path.sep}`)) {
  fail("PR source must stay below RUNNER_TEMP");
}
if (fs.existsSync(outputRoot)) fail("PR source output already exists");

const event = readJson(eventPath);
const pullRequest = event?.pull_request;
const number = pullRequest?.number;
const headSha = pullRequest?.head?.sha;
const defaultBranch = event?.repository?.default_branch;
if (!Number.isSafeInteger(number) || number <= 0) fail("pull request number is invalid");
if (typeof headSha !== "string" || !/^[0-9a-f]{40}$/u.test(headSha)) {
  fail("pull request head SHA is invalid");
}
if (
  event?.repository?.full_name !== repository ||
  pullRequest?.base?.repo?.full_name !== repository ||
  typeof defaultBranch !== "string" ||
  pullRequest?.base?.ref !== defaultBranch
) {
  fail("pull request base is not the protected repository default branch");
}

const objectDirectory = fs.mkdtempSync(path.join(temporaryRoot, "agentsin-protected-objects-"));
try {
  run("/usr/bin/git", ["init", "--quiet", objectDirectory]);
  run("/usr/bin/git", [
    "-C",
    objectDirectory,
    "remote",
    "add",
    "origin",
    `${serverUrl}/${repository}.git`,
  ]);
  run("/usr/bin/git", [
    "-C",
    objectDirectory,
    "fetch",
    "--quiet",
    "--no-tags",
    "--depth=1",
    "origin",
    `+refs/pull/${String(number)}/head:refs/aic/pr-head`,
  ]);
  const fetchedSha = run("/usr/bin/git", [
    "-C",
    objectDirectory,
    "rev-parse",
    "refs/aic/pr-head^{commit}",
  ]);
  if (fetchedSha !== headSha) fail("pull request head moved after the event was issued");

  const tree = execFileSync(
    "/usr/bin/git",
    ["-C", objectDirectory, "ls-tree", "-rz", "-r", "--full-tree", "refs/aic/pr-head"],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  try {
    validateTreeRecords({
      tree,
      baseRoot,
      readBlob: (object) =>
        run("/usr/bin/git", ["-C", objectDirectory, "cat-file", "blob", object]),
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : "pull request Git tree validation failed");
  }

  fs.mkdirSync(outputRoot, { recursive: false, mode: 0o700 });
  const archive = path.join(temporaryRoot, `agentsin-pr-source-${headSha}.tar`);
  run("/usr/bin/git", [
    "-C",
    objectDirectory,
    "archive",
    "--format=tar",
    `--output=${archive}`,
    "refs/aic/pr-head",
  ]);
  run("/usr/bin/tar", [
    "--extract",
    `--file=${archive}`,
    `--directory=${outputRoot}`,
    "--no-same-owner",
    "--no-same-permissions",
    "--exclude=.repos",
    "--exclude=.repos/*",
  ]);
  fs.rmSync(archive, { force: true });
  fs.rmSync(path.join(outputRoot, ".repos"), { recursive: true, force: true });

  for (const relative of [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "vite.config.ts",
    "apps/worker/package.json",
    "apps/worker/vite.config.ts",
    "packages/contracts/package.json",
    "packages/shared/package.json",
  ]) {
    assertSameFile(baseRoot, outputRoot, relative);
  }
  assertSameDirectory(baseRoot, outputRoot, "patches");
  process.stdout.write(`Prepared protected PR source ${headSha}\n`);
} finally {
  fs.rmSync(objectDirectory, { recursive: true, force: true });
}
