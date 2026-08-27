// @effect-diagnostics nodeBuiltinImport:off -- Integration tests create disposable real Git repositories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { WorkerBootstrap, WorkerGitHubCommand } from "@t3tools/contracts/worker";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import {
  authorizedGitHubPushUrl,
  isForbiddenCheckpointPath,
  makeGitHubGitExecutor,
  makePinnedGitHubPushTransport,
  WorkerGitHubTokenLeaseError,
} from "./GitHubGitExecutor.ts";

const decodeBootstrap = Schema.decodeUnknownSync(WorkerBootstrap);
const decodeCommand = Schema.decodeUnknownSync(WorkerGitHubCommand);
const now = "2026-08-27T12:00:00.000Z";

const git = (cwd: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();

const withRepository = <A, E, R>(use: (cwd: string, baseSha: string) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.acquireRelease(
      Effect.promise(async () => {
        const cwd = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agentsin-c5-git-"));
        git(cwd, ["init", "-b", "main"]);
        git(cwd, ["config", "user.name", "Test User"]);
        git(cwd, ["config", "user.email", "test@example.com"]);
        await NodeFSP.writeFile(NodePath.join(cwd, "README.md"), "base\n");
        git(cwd, ["add", "README.md"]);
        git(cwd, ["commit", "-m", "base"]);
        git(cwd, ["remote", "add", "origin", "https://github.com/jarrodwatts/agentsin-cloud.git"]);
        return { cwd, baseSha: git(cwd, ["rev-parse", "HEAD"]) };
      }),
      ({ cwd }) => Effect.promise(() => NodeFSP.rm(cwd, { recursive: true, force: true })),
    ).pipe(Effect.flatMap(({ cwd, baseSha }) => use(cwd, baseSha))),
  );

const bootstrap = (cwd: string) =>
  decodeBootstrap({
    schemaVersion: 1,
    workerId: "worker-1",
    workspaceId: "workspace-1",
    environmentId: "environment-1",
    environmentRevisionId: "revision-1",
    threadId: "thread-1",
    sandboxId: "sandbox-1",
    reservationId: "reservation-1",
    provider: { instanceId: "codex_personal", driver: "codex" },
    workspaceDirectory: cwd,
    bootstrapEndpoint: "https://control.example.com/bootstrap",
    relayEndpoint: "wss://control.example.com/worker",
    relayServerSpkiSha256: "sha256/47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
    relayCredentialRef: "relay-1",
    secretLeaseRef: "secrets-1",
    issuedAt: now,
    expiresAt: "2026-08-27T13:00:00.000Z",
  });

const commandIdentity = {
  operationId: "github-operation-1",
  commandId: "github-command-1",
  workspaceId: "workspace-1",
  environmentId: "environment-1",
  threadId: "thread-1",
  sandboxId: "sandbox-1",
  repository: {
    provider: "github",
    host: "github.com",
    installationId: "installation-1",
    owner: "jarrodwatts",
    name: "agentsin-cloud",
    canonicalKey: "github.com/jarrodwatts/agentsin-cloud",
  },
} as const;
const routeBinding = {
  workerId: "worker-1",
  reservationId: "reservation-1",
  environmentRevisionId: "revision-1",
  providerInstanceId: "codex_personal",
  providerDriver: "codex",
  processInstanceId: "process-1",
  certificateFingerprint: "fingerprint-1",
  certificateGeneration: 1,
  leaseGeneration: 1,
  routeGeneration: 1,
} as const;

const executor = (cwd: string) =>
  makeGitHubGitExecutor({
    bootstrap: bootstrap(cwd),
    tokenLeases: {
      materialize: () => Effect.die("token lease is not used by preparation tests"),
    },
    now: Effect.succeed(now),
  });

it("denies Git credential and repository-control paths at every depth", () => {
  for (const path of [
    ".git/config",
    "nested/.git",
    "nested/.git/config.worktree",
    ".git-credentials",
    "nested/.git-credentials",
    "nested/.git-credentialsbackup",
    ".gitconfig",
    "nested/.gitconfig-work",
    "nested/.gitconfigbackup",
    ".config/git",
    ".config/git/config",
    "nested/.config/git/credentials",
  ]) {
    expect(isForbiddenCheckpointPath(path)).toBe(true);
  }
});

it.effect("recovers the exact checkpoint after a commit-before-receipt crash", () =>
  withRepository((cwd, baseSha) =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(cwd, "feature.ts"), "export {};\n"),
      );
      const command = decodeCommand({
        ...commandIdentity,
        type: "github.git.prepare-checkpoint",
        branch: "agents/crash-recovery-123456789abc",
        expectedParentSha: baseSha,
        message: "feat: checkpoint",
        committedAt: now,
      });
      const first = yield* executor(cwd).execute(command);
      const retried = yield* executor(cwd).execute(command);
      expect(first.status).toBe("prepared");
      expect(retried.status).toBe("prepared");
      if (first.status === "prepared" && retried.status === "prepared") {
        expect(retried.localSha).toBe(first.localSha);
      }
      expect(git(cwd, ["rev-list", "--count", baseSha + "..HEAD"])).toBe("1");
      expect(git(cwd, ["show", "-s", "--format=%B", "HEAD"])).toContain(
        "Agents-In-Cloud-Command: github-command-1",
      );
    }),
  ),
);

it.effect("rejects tampered recovery history and secret paths", () =>
  withRepository((cwd, baseSha) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(cwd, ".env"), "TOKEN=secret\n"));
      const secret = yield* executor(cwd).execute(
        decodeCommand({
          ...commandIdentity,
          type: "github.git.prepare-checkpoint",
          branch: "agents/secret-check-123456789abc",
          expectedParentSha: baseSha,
          message: "feat: secret",
          committedAt: now,
        }),
      );
      expect(secret).toMatchObject({ status: "failed", code: "secretPath" });

      yield* Effect.promise(() => NodeFSP.rm(NodePath.join(cwd, ".env")));
      for (const path of [
        ".git-credentials",
        ".gitconfig",
        ".gitconfig-work",
        "nested/.git-credentials",
        ".config/git/config",
        "nested/.config/git/credentials",
      ]) {
        const absolute = NodePath.join(cwd, path);
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.dirname(absolute), { recursive: true });
          await NodeFSP.writeFile(absolute, "credential=secret\n");
        });
        const protectedGitPath = yield* executor(cwd).execute(
          decodeCommand({
            ...commandIdentity,
            type: "github.git.prepare-checkpoint",
            branch: "agents/git-secret-check-123456789abc",
            expectedParentSha: baseSha,
            message: "feat: git secret",
            committedAt: now,
          }),
        );
        expect(protectedGitPath).toMatchObject({ status: "failed", code: "secretPath" });
        yield* Effect.promise(() => NodeFSP.rm(absolute));
      }
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(cwd, "safe.ts"), "export {};\n"));
      const command = decodeCommand({
        ...commandIdentity,
        commandId: "github-command-tampered",
        type: "github.git.prepare-checkpoint",
        branch: "agents/tamper-check-123456789abc",
        expectedParentSha: baseSha,
        message: "feat: safe",
        committedAt: now,
      });
      const prepared = yield* executor(cwd).execute(command);
      expect(prepared.status).toBe("prepared");
      git(cwd, ["commit", "--amend", "--no-edit", "--author=Attacker <attacker@example.com>"]);
      const retried = yield* executor(cwd).execute(command);
      expect(retried).toMatchObject({ status: "failed", code: "ambiguousIntent" });
    }),
  ),
);

it.effect("rejects a command outside the sealed worker identity", () =>
  withRepository((cwd, baseSha) =>
    executor(cwd)
      .execute(
        decodeCommand({
          ...commandIdentity,
          workspaceId: "workspace-forged",
          type: "github.git.prepare-branch",
          branch: "agents/forged-123456789abc",
          baseSha,
        }),
      )
      .pipe(
        Effect.tap((result) =>
          Effect.sync(() =>
            expect(result).toMatchObject({ status: "failed", code: "identityMismatch" }),
          ),
        ),
      ),
  ),
);

it.effect("rejects an expired token lease before push and always scrubs it", () =>
  withRepository((cwd, baseSha) =>
    Effect.gen(function* () {
      let scrubbed = false;
      const pushExecutor = makeGitHubGitExecutor({
        bootstrap: bootstrap(cwd),
        tokenLeases: {
          materialize: () =>
            Effect.succeed({
              token: Redacted.make("must-not-leak"),
              expiresAt: "2026-08-27T11:59:59.000Z",
              scrub: Effect.sync(() => {
                scrubbed = true;
              }),
            }),
        },
        now: Effect.succeed(now),
      });
      const result = yield* pushExecutor.execute(
        decodeCommand({
          ...commandIdentity,
          type: "github.git.push",
          branch: "agents/token-expiry-123456789abc",
          localSha: baseSha,
          expectedRemoteSha: null,
          tokenLeaseRef: "token-lease-expired",
          approvalId: "approval-token-expiry",
          approvalGeneration: "approval-generation-1",
          approvalAction: "pushCheckpoint",
          leaseExpiresAt: "2026-08-27T13:00:00.000Z",
          routeBinding,
        }),
      );
      expect(result).toMatchObject({ status: "failed", code: "tokenExpired" });
      expect(scrubbed).toBe(true);
    }),
  ),
);

it.effect("pins push authentication to the authorized repository despite hostile Git config", () =>
  withRepository((cwd, baseSha) =>
    Effect.gen(function* () {
      git(cwd, ["config", "remote.origin.pushurl", "https://attacker.invalid/loot.git"]);
      git(cwd, [
        "config",
        "url.https://attacker.invalid/rewrite/.pushInsteadOf",
        "https://github.com/",
      ]);
      const invocations: Array<{
        readonly args: ReadonlyArray<string>;
        readonly environment: Readonly<Record<string, string>>;
      }> = [];
      const pushTransport = makePinnedGitHubPushTransport((processCwd, args, environment = {}) => {
        invocations.push({ args, environment });
        return Effect.succeed({
          stdout: args.includes("--git-common-dir") ? NodePath.join(processCwd, ".git") : "",
          stderr: "",
        });
      });
      let scrubbed = false;
      const pushExecutor = makeGitHubGitExecutor({
        bootstrap: bootstrap(cwd),
        tokenLeases: {
          materialize: (request) => {
            expect(request.repository).toEqual(commandIdentity.repository);
            return Effect.succeed({
              token: Redacted.make("single-use-token"),
              expiresAt: "2026-08-27T12:05:00.000Z",
              scrub: Effect.sync(() => {
                scrubbed = true;
              }),
            });
          },
        },
        pushTransport,
        now: Effect.succeed(now),
      });
      const pushCommand = decodeCommand({
        ...commandIdentity,
        type: "github.git.push",
        branch: "agents/pinned-destination-123456789abc",
        localSha: baseSha,
        expectedRemoteSha: null,
        tokenLeaseRef: "token-lease-pinned",
        approvalId: "approval-pinned",
        approvalGeneration: "approval-generation-1",
        approvalAction: "pushCheckpoint",
        leaseExpiresAt: "2026-08-27T12:05:00.000Z",
        routeBinding,
      });
      const result = yield* pushExecutor.execute(pushCommand);
      expect(result.status).toBe("pushed");
      expect(scrubbed).toBe(true);
      const push = invocations.find(({ args }) => args.includes("push"));
      expect(push).toBeDefined();
      const destination = authorizedGitHubPushUrl(pushCommand.repository);
      expect(push?.args).toContain(destination);
      expect(push?.args).toContain(
        `--config-env=http.${destination}/.extraHeader=AGENTS_IN_CLOUD_GITHUB_AUTHORIZATION`,
      );
      expect(push?.args).not.toContain("origin");
      expect(push?.args.join(" ")).not.toContain("attacker.invalid");
      expect(push?.args.join(" ")).not.toContain("single-use-token");
      expect(Object.values(push?.environment ?? {}).join(" ")).not.toContain("attacker.invalid");
      expect(invocations.some(({ args }) => args.join(" ").includes("attacker.invalid"))).toBe(
        false,
      );
    }),
  ),
);

it.effect("performs no push when approval-bound token redemption is rejected", () =>
  withRepository((cwd, baseSha) => {
    let pushes = 0;
    const pushExecutor = makeGitHubGitExecutor({
      bootstrap: bootstrap(cwd),
      tokenLeases: {
        materialize: () =>
          Effect.fail(new WorkerGitHubTokenLeaseError({ reason: "approval revoked" })),
      },
      pushTransport: {
        push: () => {
          pushes += 1;
          return Effect.void;
        },
      },
      now: Effect.succeed(now),
    });
    return pushExecutor
      .execute(
        decodeCommand({
          ...commandIdentity,
          type: "github.git.push",
          branch: "agents/revoked-approval-123456789abc",
          localSha: baseSha,
          expectedRemoteSha: null,
          tokenLeaseRef: "token-lease-revoked",
          approvalId: "approval-revoked",
          approvalGeneration: "approval-generation-1",
          approvalAction: "pushCheckpoint",
          leaseExpiresAt: "2026-08-27T12:05:00.000Z",
          routeBinding,
        }),
      )
      .pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result).toMatchObject({ status: "failed", code: "tokenExpired" });
            expect(pushes).toBe(0);
          }),
        ),
      );
  }),
);
