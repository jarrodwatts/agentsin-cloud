// @effect-diagnostics nodeBuiltinImport:off -- Git runs at the trusted worker process boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { CommandId } from "@t3tools/contracts";
import type { GitHubRepositoryRef, GitObjectSha } from "@t3tools/contracts/cloud";
import type {
  WorkerBootstrap,
  WorkerGitHubCommand,
  WorkerGitHubTokenRedeemRequest,
  WorkerRelayGitHubCommandResult,
} from "@t3tools/contracts/worker";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

const MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const GIT_BINARY = "/usr/bin/git";

class GitExecutionFailure extends Schema.TaggedErrorClass<GitExecutionFailure>()(
  "GitExecutionFailure",
  {
    code: Schema.Literals([
      "identityMismatch",
      "repositoryMismatch",
      "invalidHistory",
      "ambiguousIntent",
      "secretPath",
      "nonFastForward",
      "tokenExpired",
      "gitFailure",
    ]),
    retryable: Schema.Boolean,
    detail: Schema.String,
  },
) {}

export class WorkerGitHubTokenLeaseError extends Schema.TaggedErrorClass<WorkerGitHubTokenLeaseError>()(
  "WorkerGitHubTokenLeaseError",
  { reason: Schema.String },
) {}

interface ProcessOutput {
  readonly stdout: string;
  readonly stderr: string;
}

export interface WorkerGitHubTokenMaterialization {
  readonly token: Redacted.Redacted<string>;
  readonly expiresAt: string;
  readonly scrub: Effect.Effect<void>;
}

export interface WorkerGitHubTokenLeaseBroker {
  readonly materialize: (
    input: WorkerGitHubTokenRedeemRequest,
    identity: WorkerBootstrap,
  ) => Effect.Effect<WorkerGitHubTokenMaterialization, WorkerGitHubTokenLeaseError>;
}

export interface GitHubPushTransport {
  readonly push: (input: {
    readonly cwd: string;
    readonly repository: GitHubRepositoryRef;
    readonly branch: string;
    readonly localSha: GitObjectSha;
    readonly expectedRemoteSha: GitObjectSha | null;
    readonly token: Redacted.Redacted<string>;
  }) => Effect.Effect<void, GitExecutionFailure>;
}

export interface GitHubGitExecutor {
  readonly execute: (command: WorkerGitHubCommand) => Effect.Effect<WorkerRelayGitHubCommandResult>;
}

const secureArgs = (args: ReadonlyArray<string>) => [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "credential.helper=",
  "-c",
  "http.proxy=",
  "-c",
  "http.followRedirects=false",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
  ...args,
];

const run = (
  cwd: string,
  args: ReadonlyArray<string>,
  environment: Readonly<Record<string, string>> = {},
): Effect.Effect<ProcessOutput, GitExecutionFailure> =>
  Effect.callback((resume) => {
    const child = NodeChildProcess.spawn(GIT_BINARY, secureArgs(args), {
      cwd,
      env: {
        PATH: "/usr/bin:/bin",
        LANG: "C",
        LC_ALL: "C",
        HOME: "/nonexistent",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_COUNT: "0",
        GIT_TERMINAL_PROMPT: "0",
        ...environment,
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: DEFAULT_TIMEOUT_MS,
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const finish = (effect: Effect.Effect<ProcessOutput, GitExecutionFailure>) => {
      if (settled) return;
      settled = true;
      resume(effect);
    };
    const append = (current: Buffer, chunk: Buffer) =>
      Buffer.concat([current, chunk]).subarray(0, MAX_OUTPUT_BYTES);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", () =>
      finish(
        Effect.fail(
          new GitExecutionFailure({
            code: "gitFailure",
            retryable: false,
            detail: "git could not start",
          }),
        ),
      ),
    );
    child.once("exit", (code, signal) => {
      const detail = stderr.toString("utf8").slice(0, 500);
      finish(
        code === 0
          ? Effect.succeed({ stdout: stdout.toString("utf8"), stderr: detail })
          : Effect.fail(
              new GitExecutionFailure({
                code:
                  args.includes("push") && /stale info|fetch first|rejected/i.test(detail)
                    ? "nonFastForward"
                    : "gitFailure",
                retryable: signal !== null || args.includes("push"),
                detail: signal === null ? detail || "git command failed" : "git command timed out",
              }),
            ),
      );
    });
    return Effect.sync(() => {
      if (!settled) child.kill("SIGTERM");
    });
  });

export const authorizedGitHubPushUrl = (repository: GitHubRepositoryRef) =>
  `https://github.com/${repository.owner}/${repository.name}.git`;

export const makePinnedGitHubPushTransport = (
  executeGit: typeof run = run,
): GitHubPushTransport => ({
  push: (input) =>
    Effect.scoped(
      Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agentsin-gh-push-"))),
        (directory) =>
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      ).pipe(
        Effect.flatMap((directory) =>
          Effect.gen(function* () {
            const commonDirectory = yield* executeGit(input.cwd, [
              "rev-parse",
              "--path-format=absolute",
              "--git-common-dir",
            ]).pipe(Effect.map(({ stdout }) => stdout.trim()));
            if (!NodePath.isAbsolute(commonDirectory)) {
              return yield* new GitExecutionFailure({
                code: "invalidHistory",
                retryable: false,
                detail: "git object directory is not absolute",
              });
            }
            const bare = NodePath.join(directory, "trusted.git");
            yield* executeGit(directory, ["init", "--bare", bare]);
            const destination = authorizedGitHubPushUrl(input.repository);
            const headerEnvironmentName = "AGENTS_IN_CLOUD_GITHUB_AUTHORIZATION";
            const authorization = Buffer.from(
              `x-access-token:${Redacted.value(input.token)}`,
              "utf8",
            ).toString("base64");
            yield* executeGit(
              directory,
              [
                `--git-dir=${bare}`,
                `--config-env=http.${destination}/.extraHeader=${headerEnvironmentName}`,
                "push",
                "--porcelain",
                destination,
                `${input.localSha}:refs/heads/${input.branch}`,
                `--force-with-lease=refs/heads/${input.branch}:${input.expectedRemoteSha ?? ""}`,
              ],
              {
                GIT_ALTERNATE_OBJECT_DIRECTORIES: NodePath.join(commonDirectory, "objects"),
                [headerEnvironmentName]: `Authorization: Basic ${authorization}`,
                NO_PROXY: "github.com",
                no_proxy: "github.com",
              },
            );
          }),
        ),
      ),
    ),
});

const forbiddenSecretPath = (path: string) => {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const basename = normalized.split("/").at(-1) ?? normalized;
  return (
    normalized.startsWith(".ssh/") ||
    normalized.includes("/.ssh/") ||
    normalized.startsWith(".aws/") ||
    normalized.includes("/.aws/") ||
    normalized.startsWith(".config/gh/") ||
    normalized.includes("/.config/gh/") ||
    /^\.env(?:\..+)?$/.test(basename) ||
    /\.(?:pem|key|p12|pfx)$/.test(basename) ||
    /^(?:credentials|secrets?)(?:\..+)?$/.test(basename)
  );
};

const assertIdentity = (bootstrap: WorkerBootstrap, command: WorkerGitHubCommand) =>
  command.workspaceId === bootstrap.workspaceId &&
  command.environmentId === bootstrap.environmentId &&
  command.threadId === bootstrap.threadId &&
  command.sandboxId === bootstrap.sandboxId;

const normalizeGitHubRemote = (value: string) => {
  const trimmed = value.trim().replace(/\.git$/i, "");
  const https = /^https:\/\/([^/]+)\/(.+)$/i.exec(trimmed);
  return https === null ? "" : `${https[1]}/${https[2]}`;
};

const validateOrigin = (cwd: string, repository: GitHubRepositoryRef) =>
  run(cwd, ["remote", "get-url", "origin"]).pipe(
    Effect.flatMap(({ stdout }) => {
      const expected = `github.com/${repository.owner}/${repository.name}`.toLowerCase();
      const actual = normalizeGitHubRemote(stdout).toLowerCase();
      return actual === expected && /^https:\/\/github\.com\//i.test(stdout.trim())
        ? Effect.void
        : Effect.fail(
            new GitExecutionFailure({
              code: "repositoryMismatch",
              retryable: false,
              detail: "origin does not match the authorized repository",
            }),
          );
    }),
  );

const changedPaths = (cwd: string) =>
  Effect.all([
    run(cwd, ["diff", "--name-only", "-z", "HEAD"]),
    run(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]).pipe(
    Effect.map(([tracked, untracked]) =>
      [...new Set(`${tracked.stdout}${untracked.stdout}`.split("\0").filter(Boolean))].sort(),
    ),
  );

const currentHead = (cwd: string) =>
  run(cwd, ["rev-parse", "HEAD"]).pipe(Effect.map(({ stdout }) => stdout.trim() as GitObjectSha));

const ensureBranch = (cwd: string, branch: string, expectedParent: GitObjectSha) =>
  Effect.gen(function* () {
    yield* run(cwd, ["cat-file", "-e", `${expectedParent}^{commit}`]).pipe(
      Effect.mapError(
        () =>
          new GitExecutionFailure({
            code: "invalidHistory",
            retryable: false,
            detail: "expected commit does not exist",
          }),
      ),
    );
    const exists = yield* run(cwd, ["show-ref", "--verify", `refs/heads/${branch}`]).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (exists) yield* run(cwd, ["checkout", "--no-recurse-submodules", branch]);
    else yield* run(cwd, ["checkout", "--no-recurse-submodules", "-b", branch, expectedParent]);
  });

const findIntentCommit = (cwd: string, commandId: CommandId) =>
  run(cwd, [
    "log",
    "--all",
    "--fixed-strings",
    `--grep=Agents-In-Cloud-Command: ${commandId}`,
    "--format=%H",
    "--max-count=3",
  ]).pipe(Effect.map(({ stdout }) => stdout.split("\n").filter(Boolean)));

const prepareCheckpoint = (
  cwd: string,
  command: Extract<WorkerGitHubCommand, { type: "github.git.prepare-checkpoint" }>,
) =>
  Effect.gen(function* () {
    yield* ensureBranch(cwd, command.branch, command.expectedParentSha);
    const intents = yield* findIntentCommit(cwd, command.commandId);
    if (intents.length > 1) {
      return yield* new GitExecutionFailure({
        code: "ambiguousIntent",
        retryable: false,
        detail: "multiple commits carry this command intent",
      });
    }
    const existing = intents[0];
    if (existing !== undefined) {
      const [head, parent, body, author] = yield* Effect.all([
        currentHead(cwd),
        run(cwd, ["rev-parse", `${existing}^`]).pipe(Effect.map(({ stdout }) => stdout.trim())),
        run(cwd, ["show", "-s", "--format=%B", existing]).pipe(Effect.map(({ stdout }) => stdout)),
        run(cwd, ["show", "-s", "--format=%an <%ae>", existing]).pipe(
          Effect.map(({ stdout }) => stdout.trim()),
        ),
      ]);
      if (
        existing !== head ||
        parent !== command.expectedParentSha ||
        author !== "Agents in Cloud <agents@agentsin.cloud>" ||
        !body.includes(`Agents-In-Cloud-Thread: ${command.threadId}`) ||
        !body.includes(`Agents-In-Cloud-Command: ${command.commandId}`)
      ) {
        return yield* new GitExecutionFailure({
          code: "ambiguousIntent",
          retryable: false,
          detail: "existing command commit does not match its durable intent",
        });
      }
      return existing as GitObjectSha;
    }
    if ((yield* currentHead(cwd)) !== command.expectedParentSha) {
      return yield* new GitExecutionFailure({
        code: "invalidHistory",
        retryable: false,
        detail: "branch head moved before checkpoint preparation",
      });
    }
    const paths = yield* changedPaths(cwd);
    if (paths.length === 0) {
      return yield* new GitExecutionFailure({
        code: "invalidHistory",
        retryable: false,
        detail: "checkpoint has no changes",
      });
    }
    const secret = paths.find(forbiddenSecretPath);
    if (secret !== undefined) {
      return yield* new GitExecutionFailure({
        code: "secretPath",
        retryable: false,
        detail: "checkpoint contains a protected secret path",
      });
    }
    yield* run(cwd, ["add", "-A", "--", ...paths]);
    yield* run(
      cwd,
      [
        "commit",
        "--no-verify",
        "--no-gpg-sign",
        "--author=Agents in Cloud <agents@agentsin.cloud>",
        "-m",
        command.message.replace(/[\r\n]+/g, " ").trim(),
        "-m",
        `Agents-In-Cloud-Thread: ${command.threadId}\nAgents-In-Cloud-Command: ${command.commandId}`,
      ],
      {
        GIT_AUTHOR_DATE: command.committedAt,
        GIT_COMMITTER_DATE: command.committedAt,
        GIT_COMMITTER_NAME: "Agents in Cloud",
        GIT_COMMITTER_EMAIL: "agents@agentsin.cloud",
      },
    );
    return yield* currentHead(cwd);
  });

const failureResult = (
  command: WorkerGitHubCommand,
  failure: GitExecutionFailure,
  completedAt: string,
): WorkerRelayGitHubCommandResult => ({
  type: "github.command.result",
  operationId: command.operationId,
  commandId: command.commandId,
  status: "failed",
  code: failure.code,
  retryable: failure.retryable,
  detail: failure.detail || "worker Git operation failed",
  completedAt,
});

export const makeGitHubGitExecutor = (input: {
  readonly bootstrap: WorkerBootstrap;
  readonly tokenLeases: WorkerGitHubTokenLeaseBroker;
  readonly pushTransport?: GitHubPushTransport;
  readonly now?: Effect.Effect<string>;
}): GitHubGitExecutor => ({
  execute: (command) =>
    Effect.gen(function* () {
      const completedAt = yield* input.now ?? DateTime.now.pipe(Effect.map(DateTime.formatIso));
      if (!assertIdentity(input.bootstrap, command)) {
        return failureResult(
          command,
          new GitExecutionFailure({
            code: "identityMismatch",
            retryable: false,
            detail: "command identity does not match worker bootstrap",
          }),
          completedAt,
        );
      }
      const result = yield* Effect.gen(function* () {
        const cwd = input.bootstrap.workspaceDirectory;
        yield* validateOrigin(cwd, command.repository);
        if (command.type === "github.git.prepare-branch") {
          yield* ensureBranch(cwd, command.branch, command.baseSha);
          if ((yield* currentHead(cwd)) !== command.baseSha) {
            return yield* new GitExecutionFailure({
              code: "invalidHistory",
              retryable: false,
              detail: "branch is not pinned to the selected base commit",
            });
          }
          return { status: "prepared" as const, localSha: command.baseSha };
        }
        if (command.type === "github.git.prepare-checkpoint") {
          return { status: "prepared" as const, localSha: yield* prepareCheckpoint(cwd, command) };
        }
        if (command.expectedRemoteSha !== null) {
          yield* run(cwd, [
            "merge-base",
            "--is-ancestor",
            command.expectedRemoteSha,
            command.localSha,
          ]).pipe(
            Effect.mapError(
              () =>
                new GitExecutionFailure({
                  code: "nonFastForward",
                  retryable: false,
                  detail: "local checkpoint is not descended from expected remote head",
                }),
            ),
          );
        }
        const materialization = yield* input.tokenLeases
          .materialize(
            {
              schemaVersion: 1,
              leaseRef: command.tokenLeaseRef,
              operationId: command.operationId,
              commandId: command.commandId,
              workspaceId: command.workspaceId,
              environmentId: command.environmentId,
              threadId: command.threadId,
              sandboxId: command.sandboxId,
              repository: command.repository,
              approvalId: command.approvalId,
              approvalGeneration: command.approvalGeneration,
              approvalAction: command.approvalAction,
              leaseExpiresAt: command.leaseExpiresAt,
              routeBinding: command.routeBinding,
            },
            input.bootstrap,
          )
          .pipe(
            Effect.mapError(
              () =>
                new GitExecutionFailure({
                  code: "tokenExpired",
                  retryable: true,
                  detail: "GitHub token lease is unavailable",
                }),
            ),
          );
        const push = Effect.gen(function* () {
          const now = yield* input.now ?? DateTime.now.pipe(Effect.map(DateTime.formatIso));
          if (materialization.expiresAt <= now) {
            return yield* new GitExecutionFailure({
              code: "tokenExpired",
              retryable: true,
              detail: "GitHub token lease expired before push",
            });
          }
          yield* (input.pushTransport ?? makePinnedGitHubPushTransport()).push({
            cwd,
            repository: command.repository,
            branch: command.branch,
            localSha: command.localSha,
            expectedRemoteSha: command.expectedRemoteSha,
            token: materialization.token,
          });
        }).pipe(Effect.ensuring(materialization.scrub.pipe(Effect.ignore)));
        yield* push;
        return { status: "pushed" as const };
      }).pipe(Effect.result);
      if (result._tag === "Failure") return failureResult(command, result.failure, completedAt);
      return result.success.status === "prepared"
        ? {
            type: "github.command.result" as const,
            operationId: command.operationId,
            commandId: command.commandId,
            status: "prepared" as const,
            localSha: result.success.localSha,
            completedAt,
          }
        : {
            type: "github.command.result" as const,
            operationId: command.operationId,
            commandId: command.commandId,
            status: "pushed" as const,
            completedAt,
          };
    }),
});

export const isForbiddenCheckpointPath = forbiddenSecretPath;
