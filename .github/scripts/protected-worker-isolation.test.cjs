const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require("node:fs");
const os = require("node:os");
const { test } = require("node:test");
const path = require("node:path");

const { validateTreeRecords } = require("./protected-worker-source-lib.cjs");

const repositoryRoot = path.resolve(__dirname, "../..");
const read = (relative) => readFileSync(path.join(repositoryRoot, relative), "utf8");

const workflow = read(".github/workflows/protected-worker-isolation.yml");
const normalCi = read(".github/workflows/ci.yml");
const hostHarness = read(".github/scripts/protected-worker-isolation.sh");
const mountValidationSource = read(".github/scripts/protected-worker-mounts.jq");
const mountValidator = path.join(repositoryRoot, ".github/scripts/protected-worker-mounts.jq");
const sourceHarness = read(".github/scripts/protected-worker-source.cjs");
const sourceLibrary = read(".github/scripts/protected-worker-source-lib.cjs");
const entrypoint = read(".github/scripts/protected-worker-container-entrypoint.sh");
const probe = read(".github/scripts/protected-worker-container-probe.mjs");
const ciDocumentation = read("docs/internals/ci.md");

test("protected workflow is default-branch-owned and read-only", () => {
  assert.match(workflow, /pull_request_target:/u);
  assert.match(workflow, /permissions:\n  contents: read/u);
  assert.doesNotMatch(workflow, /secrets\./u);
  assert.doesNotMatch(workflow, /\$\{\{/u);
  for (const action of workflow.matchAll(/uses:\s*([^\s]+)@([^\s]+)/gu)) {
    assert.match(action[2], /^[0-9a-f]{40}$/u, `${action[1]} must be commit pinned`);
  }
  assert.match(workflow, /cache: false/u);
  assert.doesNotMatch(workflow, /actions\/checkout|git submodule/u);
  assert.match(workflow, /GITHUB_EVENT_NAME" == "pull_request_target/u);
  assert.match(workflow, /event_repository" == "\$GITHUB_REPOSITORY/u);
  assert.match(workflow, /event_base_repository" == "\$GITHUB_REPOSITORY/u);
  assert.match(workflow, /event_base_ref" == "\$event_default_branch/u);
  assert.match(workflow, /GITHUB_REF" == "refs\/heads\/\$\{event_default_branch\}/u);
  assert.doesNotMatch(workflow, /pull_request\.base\.sha|event_base_sha/u);
  assert.match(workflow, /PATH=\/usr\/bin:\/bin/u);
  assert.match(workflow, /GIT_CONFIG_GLOBAL=\/dev\/null/u);
  assert.match(workflow, /-c credential\.helper=/u);
  assert.match(workflow, /ls-remote[\s\S]+--exit-code[\s\S]+--refs[\s\S]+"\$GITHUB_REF"/u);
  assert.match(workflow, /remote_default_sha" == "\$GITHUB_SHA/u);
  assert.match(workflow, /remote_default_ref" == "\$GITHUB_REF/u);
  assert.match(workflow, /\+\$\{GITHUB_SHA\}:refs\/aic\/protected-base/u);
  assert.match(workflow, /--no-recurse-submodules/u);
  assert.match(workflow, /":\(exclude\)\.repos"/u);
  assert.match(workflow, /\[\[ ! -e "\$GITHUB_WORKSPACE\/\.git" \]\]/u);
  assert.match(workflow, /\[\[ ! -e "\$GITHUB_WORKSPACE\/\.repos" \]\]/u);
  assert.match(workflow, /\/usr\/bin\/sha256sum --check/u);
  assert.doesNotMatch(workflow, /GITHUB_TOKEN|github\.token|Authorization|extraheader/u);
  assert.ok(
    workflow.indexOf('[[ "$remote_default_sha" == "$GITHUB_SHA" ]]') <
      workflow.indexOf('"+${GITHUB_SHA}:refs/aic/protected-base"'),
  );
  assert.ok(
    workflow.indexOf("Fetch protected base without checkout") <
      workflow.indexOf("Setup protected-base Vite+"),
  );
  assert.match(
    workflow,
    /node@sha256:85a395c77b811fa7f5b5e4aa69cd6eb4c3b80c7f1a8e34704dc0ce061e5b404e/u,
  );
  assert.match(workflow, /\/usr\/bin\/docker pull --platform linux\/amd64/u);
  assert.ok(workflow.includes('${resolved_digest##*@}" == "$expected_digest"'));
  assert.ok(
    workflow.indexOf("Pull digest-pinned toolchain") < workflow.indexOf("Fetch inert PR source"),
  );
});

test("stale event base SHA is ignored while remote default drift fails closed", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentsin-protected-default-"));
  const repository = path.join(root, "repository");
  const runGit = (...args) =>
    execFileSync("/usr/bin/git", ["-C", repository, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const acceptsProtectedBase = ({ githubRef, githubSha }) => {
    if (githubRef !== "refs/heads/main") return false;
    const remoteDefault = runGit("ls-remote", "--exit-code", "--refs", repository, githubRef);
    const [remoteSha, remoteRef, ...extra] = remoteDefault.split("\t");
    return extra.length === 0 && remoteSha === githubSha && remoteRef === githubRef;
  };

  try {
    mkdirSync(repository);
    execFileSync("/usr/bin/git", ["init", "--quiet", "--initial-branch=main", repository]);
    runGit("config", "user.email", "protected-ci@example.invalid");
    runGit("config", "user.name", "Protected CI");
    writeFileSync(path.join(repository, "README.md"), "stale base\n");
    runGit("add", "README.md");
    runGit("commit", "--quiet", "-m", "stale event base");
    const eventBaseSha = runGit("rev-parse", "HEAD");

    writeFileSync(path.join(repository, "README.md"), "current default\n");
    runGit("commit", "--quiet", "--all", "-m", "current default");
    const githubSha = runGit("rev-parse", "HEAD");

    assert.notEqual(eventBaseSha, githubSha);
    assert.equal(
      acceptsProtectedBase({ eventBaseSha, githubRef: "refs/heads/main", githubSha }),
      true,
    );

    writeFileSync(path.join(repository, "README.md"), "remote moved\n");
    runGit("commit", "--quiet", "--all", "-m", "remote moved");
    assert.equal(
      acceptsProtectedBase({ eventBaseSha, githubRef: "refs/heads/main", githubSha }),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("protected base archive excludes unconfigured gitlinks without creating a checkout", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentsin-protected-base-"));
  const repository = path.join(root, "repository");
  const extracted = path.join(root, "extracted");
  const archive = path.join(root, "protected-base.tar");
  const runGit = (...args) =>
    execFileSync("/usr/bin/git", ["-C", repository, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  try {
    mkdirSync(repository);
    mkdirSync(extracted);
    execFileSync("/usr/bin/git", ["init", "--quiet", repository]);
    runGit("config", "user.email", "protected-ci@example.invalid");
    runGit("config", "user.name", "Protected CI");
    writeFileSync(path.join(repository, "README.md"), "protected base\n");
    runGit("add", "README.md");
    runGit("commit", "--quiet", "-m", "base");

    const commit = runGit("rev-parse", "HEAD");
    runGit(
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${commit},.repos/alchemy-effect/.vendor/alchemy`,
    );
    runGit("commit", "--quiet", "-m", "unconfigured nested gitlink");
    assert.equal(existsSync(path.join(repository, ".gitmodules")), false);
    assert.throws(
      () => runGit("submodule", "foreach", "--recursive", "true"),
      /No url found for submodule path/u,
    );

    assert.doesNotThrow(() =>
      execFileSync(
        "/usr/bin/git",
        [
          "-C",
          repository,
          "archive",
          "--format=tar",
          `--output=${archive}`,
          "HEAD",
          "--",
          ".",
          ":(exclude).repos",
        ],
        { stdio: "pipe" },
      ),
    );
    execFileSync("/usr/bin/tar", ["--extract", `--file=${archive}`, `--directory=${extracted}`]);
    assert.equal(readFileSync(path.join(extracted, "README.md"), "utf8"), "protected base\n");
    assert.equal(existsSync(path.join(extracted, ".git")), false);
    assert.equal(existsSync(path.join(extracted, ".repos")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("normal pull-request CI never explicitly elevates its compatibility command", () => {
  const start = normalCi.indexOf("  test_worker_credential_isolation:");
  const trustedStart = normalCi.indexOf("  test_worker_root_isolation_trusted_main:");
  const end = trustedStart;
  assert.ok(start >= 0 && end > start);
  const job = normalCi.slice(start, end);
  assert.doesNotMatch(job, /sudo|setpriv|AGENTSIN_ROOT_SECURITY_TEST/u);
  assert.match(job, /Compatibility only/u);

  const trustedEnd = normalCi.indexOf("\n  test_control_plane_coordination:", trustedStart);
  assert.ok(trustedStart >= 0 && trustedEnd > trustedStart);
  const trustedJob = normalCi.slice(trustedStart, trustedEnd);
  assert.match(trustedJob, /if: github\.event_name == 'push'/u);
  assert.match(trustedJob, /PATH=\/usr\/local\/lib\/agentsin-ci:\/usr\/bin:\/bin/u);
  assert.doesNotMatch(trustedJob, /PATH=\$PATH/u);
});

test("host harness stages inert bytes before hardened controlled-mount execution", () => {
  for (const invariant of [
    "--read-only",
    "--network none",
    "--cap-drop ALL",
    "--security-opt no-new-privileges:true",
    "--user 65534:65534",
    "--pids-limit 256",
    "HostConfig.ReadonlyRootfs",
    "HostConfig.NetworkMode",
    "HostConfig.CapDrop",
    "HostConfig.SecurityOpt",
    "HostConfig.Binds",
    "protected-worker-mounts.jq",
    "/proc/$container_pid/mountinfo",
    "docker wait",
  ]) {
    assert.ok(hostHarness.includes(invariant), `missing host invariant: ${invariant}`);
  }
  assert.doesNotMatch(hostHarness, /(?:--volume|-v\s|--mount|docker\.sock)/u);
  assert.doesNotMatch(hostHarness, /env\s+"?PATH=|sudo\s+env/u);
  assert.match(hostHarness, /sha256sum[\s\S]+protected-worker-container-probe\.mjs/u);

  const stagingCreate = hostHarness.indexOf('staging_container_id="$(docker create');
  const stagingGuardStart = hostHarness.indexOf("assert_staging_inert() {", stagingCreate);
  const stagingGuardEnd = hostHarness.indexOf("}\nassert_staging_inert", stagingGuardStart);
  const stagingGuard = hostHarness.slice(stagingGuardStart, stagingGuardEnd);
  const stagingCheckBeforeCopy = hostHarness.indexOf("\nassert_staging_inert\n", stagingGuardEnd);
  const prSourceArchive = hostHarness.indexOf('tar -C "$pr_source"', stagingCreate);
  const prSourceCopy = hostHarness.indexOf(
    'docker cp - "$staging_container_id:/opt"',
    prSourceArchive,
  );
  const stagingCheckAfterCopy = hostHarness.indexOf("\nassert_staging_inert\n", prSourceCopy);
  const imageCommit = hostHarness.indexOf('docker commit "$staging_container_id"');
  const stagingRemove = hostHarness.indexOf('docker rm "$staging_container_id"', imageCommit);
  const finalCreate = hostHarness.indexOf('final_container_id="$(docker create');
  const finalStart = hostHarness.indexOf('docker start "$final_container_id"');
  assert.ok(
    stagingCreate >= 0 &&
      stagingGuardStart > stagingCreate &&
      stagingCheckBeforeCopy > stagingGuardEnd &&
      prSourceCopy > stagingCheckBeforeCopy &&
      stagingCheckAfterCopy > prSourceCopy &&
      imageCommit > stagingCheckAfterCopy &&
      stagingRemove > imageCommit &&
      finalCreate > stagingRemove &&
      finalStart > finalCreate,
  );
  assert.match(stagingGuard, /"created"[\s\S]+State\.Status\}\}/u);
  assert.match(stagingGuard, /"false"[\s\S]+State\.Running\}\}/u);
  assert.match(stagingGuard, /"null"[\s\S]+HostConfig\.Binds\}\}/u);
  assert.match(stagingGuard, /"0"[\s\S]+len \.Mounts\}\}/u);
  assert.equal(hostHarness.match(/^assert_staging_inert$/gmu)?.length, 2);
  assert.match(hostHarness, /final_container_id="\$\(docker create[\s\S]+"\$staged_image_id"/u);
  assert.doesNotMatch(hostHarness, /docker (?:start|exec|wait) "\$staging_container_id"/u);
  assert.deepEqual(
    [...hostHarness.matchAll(/docker start "\$(\w+)"/gu)].map((match) => match[1]),
    ["final_container_id"],
  );

  const cleanupStart = hostHarness.indexOf("cleanup() {");
  const cleanupEnd = hostHarness.indexOf("}\ntrap cleanup EXIT", cleanupStart);
  const cleanup = hostHarness.slice(cleanupStart, cleanupEnd);
  assert.match(cleanup, /docker rm --force "\$final_container_id"/u);
  assert.match(cleanup, /docker rm --force "\$staging_container_id"/u);
  assert.match(cleanup, /docker image rm --force "\$staged_image_id"/u);
  assert.match(mountValidationSource, /\.HostConfig\.Binds == null/u);
  assert.match(mountValidationSource, /\.HostConfig\.Tmpfs/u);
  assert.match(mountValidationSource, /\.Mounts/u);
  assert.doesNotMatch(
    hostHarness.slice(finalCreate),
    /docker inspect --format '\{\{len \.Mounts\}\}'/u,
  );
});

const expectedTmpfsInspect = () => [
  {
    Config: { Volumes: null },
    HostConfig: {
      Binds: null,
      Mounts: null,
      VolumesFrom: null,
      Tmpfs: {
        "/tmp": "rw,noexec,nosuid,nodev,size=64m,mode=1777",
        "/work": "rw,noexec,nosuid,nodev,size=4g,mode=1777",
      },
    },
    Mounts: [],
  },
];

const validateMountInspect = (inspect) =>
  execFileSync("/usr/bin/jq", ["--exit-status", "--from-file", mountValidator], {
    input: JSON.stringify(inspect),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });

const assertMountInspectRejected = (mutate, diagnostic) => {
  const inspect = structuredClone(expectedTmpfsInspect());
  mutate(inspect[0]);
  assert.throws(
    () => validateMountInspect(inspect),
    (error) => {
      assert.match(error.stderr, diagnostic);
      return true;
    },
  );
};

test("Docker 28 reports legacy --tmpfs only in HostConfig.Tmpfs", () => {
  const inspect = expectedTmpfsInspect();
  assert.deepEqual(inspect[0].HostConfig.Tmpfs, {
    "/tmp": "rw,noexec,nosuid,nodev,size=64m,mode=1777",
    "/work": "rw,noexec,nosuid,nodev,size=4g,mode=1777",
  });
  assert.deepEqual(inspect[0].Mounts, []);
  assert.doesNotThrow(() => validateMountInspect(inspect));

  inspect[0].HostConfig.Tmpfs["/tmp"] = "mode=1777,size=64m,nodev,nosuid,noexec,rw";
  assert.doesNotThrow(() => validateMountInspect(inspect));
});

test("mount validation rejects binds, volumes, host paths, and additional tmpfs mounts", () => {
  assertMountInspectRejected((inspect) => {
    inspect.HostConfig.Binds = ["/private/secret-marker:/host"];
  }, /bind mounts are configured/u);
  assertMountInspectRejected((inspect) => {
    inspect.HostConfig.Binds = [];
  }, /bind mounts are configured/u);
  assertMountInspectRejected((inspect) => {
    inspect.Mounts.push({
      Type: "volume",
      Source: "/var/lib/docker/volumes/worker/_data",
      Destination: "/data",
      Mode: "z",
      RW: true,
      Propagation: "",
    });
  }, /top-level runtime mounts must be empty/u);
  assertMountInspectRejected((inspect) => {
    inspect.Mounts.push({
      Type: "bind",
      Source: "/private/secret-marker",
      Destination: "/host",
      Mode: "",
      RW: false,
      Propagation: "rprivate",
    });
  }, /top-level runtime mounts must be empty/u);
  assertMountInspectRejected((inspect) => {
    inspect.Mounts = null;
  }, /runtime mount report is missing/u);
  assertMountInspectRejected((inspect) => {
    delete inspect.Mounts;
  }, /runtime mount report is missing/u);
  assertMountInspectRejected((inspect) => {
    inspect.HostConfig.Tmpfs["/extra"] = "rw,noexec,nosuid,nodev,size=1m,mode=1777";
  }, /tmpfs destinations must be exactly \/tmp and \/work/u);
  assertMountInspectRejected((inspect) => {
    delete inspect.HostConfig.Tmpfs["/work"];
  }, /tmpfs destinations must be exactly \/tmp and \/work/u);
  assertMountInspectRejected((inspect) => {
    inspect.HostConfig.Mounts = [{ Type: "tmpfs", Target: "/extra" }];
  }, /structured mounts are configured/u);
  assertMountInspectRejected((inspect) => {
    inspect.HostConfig.VolumesFrom = ["another-container:rw"];
  }, /volumes-from is configured/u);
  assertMountInspectRejected((inspect) => {
    inspect.Config.Volumes = { "/anonymous": {} };
  }, /image-declared volumes are configured/u);
});

test("mount validation enforces tmpfs security options and sizes without echoing inspect data", () => {
  for (const [target, unsafeOptions, diagnostic] of [
    ["/tmp", "rw,nosuid,nodev,size=64m,mode=1777", /\/tmp tmpfs options/u],
    ["/tmp", "rw,noexec,nosuid,nodev,size=128m,mode=1777", /\/tmp tmpfs options/u],
    ["/work", "rw,noexec,nosuid,nodev,size=4g,mode=0777", /\/work tmpfs options/u],
  ]) {
    assertMountInspectRejected((inspect) => {
      inspect.HostConfig.Tmpfs[target] = unsafeOptions;
    }, diagnostic);
  }

  const inspect = expectedTmpfsInspect();
  inspect[0].Mounts.push({
    Type: "bind",
    Source: "/private/secret-marker",
    Destination: "/host",
    Mode: "",
    RW: false,
    Propagation: "rprivate",
  });
  assert.throws(
    () => validateMountInspect(inspect),
    (error) => {
      assert.match(error.stderr, /top-level runtime mounts must be empty/u);
      assert.doesNotMatch(error.stderr, /secret-marker/u);
      return true;
    },
  );
});

test("host supplementary-group validation accepts only empty or 65534-only groups", () => {
  const functionStart = hostHarness.indexOf("supplementary_groups_allowed() {");
  const functionEnd = hostHarness.indexOf("\n}\n", functionStart) + 3;
  const functionSource = hostHarness.slice(functionStart, functionEnd);
  const validate = (groups) =>
    execFileSync(
      "bash",
      ["-c", `${functionSource}\nsupplementary_groups_allowed "$1"`, "groups-test", groups],
      { stdio: "pipe" },
    );

  assert.doesNotThrow(() => validate(""));
  assert.doesNotThrow(() => validate("65534"));
  assert.doesNotThrow(() => validate("65534 65534"));
  assert.throws(() => validate("0"));
  assert.throws(() => validate("65534 1234"));
});

test("every post-start host assertion has a stage-specific diagnostic", () => {
  const finalStart = hostHarness.indexOf('docker start "$final_container_id"');
  const postStart = hostHarness.slice(finalStart);
  assert.doesNotMatch(postStart, /^\s*\[\[/gmu);
  for (const diagnostic of [
    "did not reach its base-owned observation gate",
    "final container user is not 65534:65534",
    "final container root filesystem is writable",
    "final container network is enabled",
    "final container capabilities were not all dropped",
    "final container no-new-privileges is disabled",
    "final container mount validation failed",
    "final container PID is invalid",
    "final container process has an unexpected UID",
    "final container process has an unexpected GID",
    "final container supplementary-group status is unavailable",
    "final container process has an unauthorized supplementary group",
    "final container process has effective capabilities",
    "final container process does not enforce no-new-privileges",
    "final container shares the host $namespace namespace",
    "RUNNER_TEMP is visible in the protected container mounts",
    "GITHUB_WORKSPACE is visible in the protected container mounts",
    "Protected PR build/test exited with",
    "final container inspection reported a nonzero exit",
  ]) {
    assert.ok(postStart.includes(diagnostic), `missing post-start diagnostic: ${diagnostic}`);
  }
});

test("base-owned probe independently checks identity, caps, namespaces, network, files, and secrets", () => {
  for (const invariant of [
    "NodeProcess.getuid",
    "NodeProcess.getgid",
    "NodeProcess.getgroups",
    "CapEff",
    "NoNewPrivs",
    "/proc/self/ns/mnt",
    "/proc/self/ns/net",
    "/proc/self/ns/pid",
    "/proc/self/ns/ipc",
    "/proc/self/ns/uts",
    "host sentinel is readable",
    "base-owned probe is mutable",
    "external network is reachable",
    "credential-shaped environment",
  ]) {
    assert.ok(probe.includes(invariant), `missing base probe: ${invariant}`);
  }
});

test("PR source is treated as inert data and fails closed on mutable dependency inputs", () => {
  assert.match(sourceHarness, /refs\/pull\/\$\{String\(number\)\}\/head/u);
  assert.match(sourceHarness, /fetchedSha !== headSha/u);
  assert.match(sourceLibrary, /new, changed, or external symlink is denied/u);
  assert.match(sourceLibrary, /submodules and special files are denied/u);
  assert.match(sourceHarness, /protected dependency input changed/u);
  assert.match(sourceHarness, /"ls-tree", "-rz", "-r", "--full-tree"/u);
  assert.match(sourceHarness, /\/usr\/bin\/git/u);
  assert.match(sourceHarness, /\/usr\/bin\/tar/u);
  assert.doesNotMatch(sourceHarness, /"checkout"/u);
  assert.doesNotMatch(sourceHarness, /execSync|shell:\s*true/u);
  assert.match(entrypoint, /\/work\/source/u);
  assert.match(entrypoint, /vp run --filter @agentsin-cloud\/worker build/u);
  assert.match(entrypoint, /\.\/node_modules\/\.bin\/vp/u);
});

test("real recursive Git trees validate nested files and reject nested unsafe entries", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentsin-protected-tree-"));
  const base = path.join(root, "base");
  const repository = path.join(root, "repository");
  const runGit = (...args) =>
    execFileSync("/usr/bin/git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
  const treeAt = (revision) =>
    execFileSync(
      "/usr/bin/git",
      ["-C", repository, "ls-tree", "-rz", "-r", "--full-tree", revision],
      { encoding: "buffer" },
    );
  const readBlob = (object) => runGit("cat-file", "blob", object);

  try {
    mkdirSync(path.join(base, "nested"), { recursive: true });
    mkdirSync(path.join(repository, "nested"), { recursive: true });
    writeFileSync(path.join(base, "target.txt"), "target");
    writeFileSync(path.join(repository, "target.txt"), "target");
    writeFileSync(path.join(repository, "nested", "file.txt"), "nested");
    symlinkSync("../target.txt", path.join(base, "nested", "safe-link"));
    symlinkSync("../target.txt", path.join(repository, "nested", "safe-link"));
    execFileSync("/usr/bin/git", ["init", "--quiet", repository]);
    runGit("config", "user.email", "protected-ci@example.invalid");
    runGit("config", "user.name", "Protected CI");
    runGit("add", ".");
    runGit("commit", "--quiet", "-m", "valid nested tree");

    assert.doesNotThrow(() =>
      validateTreeRecords({ tree: treeAt("HEAD"), baseRoot: base, readBlob }),
    );

    symlinkSync("/etc/passwd", path.join(repository, "nested", "unsafe-link"));
    runGit("add", "nested/unsafe-link");
    const unsafeTree = runGit("write-tree");
    assert.throws(
      () => validateTreeRecords({ tree: treeAt(unsafeTree), baseRoot: base, readBlob }),
      /new, changed, or external symlink is denied/u,
    );

    runGit("rm", "--quiet", "--cached", "nested/unsafe-link");
    rmSync(path.join(repository, "nested", "unsafe-link"));
    const commit = runGit("rev-parse", "HEAD");
    runGit("update-index", "--add", "--cacheinfo", `160000,${commit},nested/fake-submodule`);
    const submoduleTree = runGit("write-tree");
    assert.throws(
      () => validateTreeRecords({ tree: treeAt(submoduleTree), baseRoot: base, readBlob }),
      /submodules and special files are denied/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap documentation delays branch protection until a follow-up PR proves the check", () => {
  assert.match(ciDocumentation, /authoritative only after this workflow exists on `main`/u);
  assert.match(ciDocumentation, /harmless follow-up\s+pull request/u);
  assert.match(ciDocumentation, /new documentation-only follow-up/u);
  assert.match(ciDocumentation, /Protected Worker Isolation/u);
});

test("protected shell harnesses parse", () => {
  for (const relative of [
    ".github/scripts/protected-worker-isolation.sh",
    ".github/scripts/protected-worker-container-entrypoint.sh",
  ]) {
    execFileSync("bash", ["-n", path.join(repositoryRoot, relative)], { stdio: "pipe" });
  }
});
