import type { AuthSessionId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  GitHubThreadWorkflowCommand,
  type GitHubRepositoryRef,
  type GitHubThreadBranchName,
  type GitHubThreadWorkflowView,
  type GitObjectSha,
  type WorkspaceId,
} from "@t3tools/contracts/cloud";
import type { WorkerGitHubTokenLeaseRef } from "@t3tools/contracts/worker";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { GitHubAppError, type GitHubAppClient } from "./githubAppClient.ts";
import { branchNameForThread, makeGitHubThreadWorkflow } from "./githubThreadWorkflow.ts";
import type { GitHubWorkflowCompletion, GitHubWorkflowStore } from "./githubThreadWorkflowStore.ts";
import { GitHubAuthorityError, type GitHubWorkflowAuthority } from "./githubWorkflowAuthority.ts";
import type { GitHubWorkerDispatcher } from "./githubWorkerDispatcher.ts";
import type { ActiveWorkerLease } from "./workerIdentity.ts";

const decodeCommand = Schema.decodeUnknownSync(GitHubThreadWorkflowCommand);
const workspaceId = "workspace-1" as WorkspaceId;
const environmentId = "environment-1" as EnvironmentId;
const threadId = "thread-1" as ThreadId;
const authSessionId = "session-1" as AuthSessionId;
const baseSha = "a".repeat(40) as GitObjectSha;
const branchName = "agents/hosted-thread-123456789abc" as GitHubThreadBranchName;
const now = Date.parse("2026-08-27T12:00:00.000Z");
const repository: GitHubRepositoryRef = {
  provider: "github",
  host: "github.com",
  installationId: "installation-1" as GitHubRepositoryRef["installationId"],
  owner: "jarrodwatts",
  name: "agentsin-cloud",
  canonicalKey: "github.com/jarrodwatts/agentsin-cloud",
};

const token = {
  token: Redacted.make("short-lived-token"),
  expiresAt: "2026-08-27T12:30:00.000Z",
};
const workerLease = {
  workspaceId,
  environmentId,
  environmentRevisionId: "revision-1",
  threadId,
  sandboxId: "sandbox-1",
  reservationId: "reservation-1",
  workerId: "worker-1",
  providerInstanceId: "codex_personal",
  providerDriver: "codex",
  certificateFingerprint: "fingerprint-1",
  certificateGeneration: 1,
  leaseGeneration: 1,
  routeGeneration: 1,
  processInstanceId: "process-1",
  state: "connected",
  connectedAt: "2026-08-27T12:00:00.000Z",
  lastSeenAt: "2026-08-27T12:00:00.000Z",
  heartbeatSequence: 0,
  confirmedEventCursor: -1,
} as ActiveWorkerLease;

const view = (pullRequest: GitHubThreadWorkflowView["pullRequest"] = null) => ({
  workspaceId,
  environmentId,
  threadId,
  repository,
  baseSha,
  branchName,
  remoteHeadSha: baseSha,
  status: "active" as const,
  checkpointCount: 0,
  pullRequest,
  events: [],
});

const checkpoint = (approvalId = "approval-checkpoint") =>
  decodeCommand({
    type: "github.checkpoint.push",
    commandId: "command-checkpoint",
    workspaceId,
    environmentId,
    threadId,
    repository,
    approvalId,
    requestedAt: "2026-08-27T12:00:00.000Z",
    message: "feat: verified checkpoint",
  });

const markReady = () =>
  decodeCommand({
    type: "github.pull-request.mark-ready",
    commandId: "command-ready",
    workspaceId,
    environmentId,
    threadId,
    repository,
    approvalId: "approval-ready",
    requestedAt: "2026-08-27T12:00:00.000Z",
  });

const openDraft = () =>
  decodeCommand({
    type: "github.pull-request.open-draft",
    commandId: "command-open-draft",
    workspaceId,
    environmentId,
    threadId,
    repository,
    approvalId: "approval-open-draft",
    requestedAt: "2026-08-27T12:00:00.000Z",
    baseBranch: "main",
    title: "Cloud checkpoint",
    body: "Verified by Agents in Cloud",
  });

const makeHarness = (input: {
  readonly command: ReturnType<typeof checkpoint>;
  readonly currentView?: GitHubThreadWorkflowView;
  readonly authority?: GitHubWorkflowAuthority;
  readonly github?: GitHubAppClient;
}) => {
  let claimed = false;
  let completion: GitHubWorkflowCompletion | undefined;
  let failureCode: string | undefined;
  const workerCommands: Array<string> = [];
  const currentView = input.currentView ?? view();
  const store: GitHubWorkflowStore = {
    registerRepository: () => Effect.void,
    getRepository: () =>
      Effect.succeed({
        workspaceId,
        repository,
        repositoryId: 42,
        canPush: true,
        canPullRequests: true,
      }),
    submit: () => Effect.succeed({ disposition: "accepted", commandId: input.command.commandId }),
    claim: () => {
      if (claimed) return Effect.sync(() => undefined);
      claimed = true;
      return Effect.succeed({
        effectId: "effect-1",
        command: input.command,
        workflow: { ...currentView, events: undefined } as never,
        actorUserId: "user-1",
        authSessionId,
        expectedParentSha: baseSha,
        attemptCount: 1,
      });
    },
    claimNext: () => Effect.sync(() => undefined),
    savePreparedSha: () => Effect.void,
    complete: (record) =>
      Effect.sync(() => {
        completion = record.completion;
      }),
    fail: (record) =>
      Effect.sync(() => {
        failureCode = record.code;
      }),
    get: () => Effect.succeed(currentView),
  };
  const defaultAuthority: GitHubWorkflowAuthority = {
    validateApproval: (request) =>
      Effect.succeed({
        approval: {
          approvalId: request.approvalId as never,
          workspaceId,
          threadId,
          repository,
          actions: [request.action],
          decidedByUserId: "user-1",
          decidedBy: authSessionId,
          approvedAt: "2026-08-27T11:00:00.000Z",
          expiresAt: "2026-08-27T13:00:00.000Z",
        },
        generation: "approval-generation-1",
      }),
    resolveWorkerTarget: () =>
      Effect.succeed({ workspaceId, environmentId, threadId, sandboxId: "sandbox-1" as never }),
  };
  const defaultGithub: GitHubAppClient = {
    validateRepository: () =>
      Effect.succeed({
        repositoryId: 42,
        defaultBranch: "main",
        canPush: true,
        canPullRequests: true,
      }),
    getBranchHead: () => Effect.succeed(baseSha),
    findOpenPullRequest: () => Effect.sync(() => undefined),
    getPullRequest: () => Effect.die("not used"),
    createDraftPullRequest: () => Effect.die("not used"),
    markPullRequestReady: () => Effect.die("not used"),
  };
  const dispatch = (
    _target: unknown,
    command: Parameters<GitHubWorkerDispatcher["dispatch"]>[1],
  ) => {
    workerCommands.push(command.type);
    return command.type === "github.git.prepare-checkpoint"
      ? Effect.succeed({
          type: "github.command.result" as const,
          operationId: command.operationId,
          commandId: command.commandId,
          status: "prepared" as const,
          localSha: "b".repeat(40) as GitObjectSha,
          completedAt: "2026-08-27T12:00:00.000Z",
        })
      : Effect.succeed({
          type: "github.command.result" as const,
          operationId: command.operationId,
          commandId: command.commandId,
          status: "pushed" as const,
          completedAt: "2026-08-27T12:00:00.000Z",
        });
  };
  const workflow = makeGitHubThreadWorkflow({
    workspaces: {
      ensureForUser: () => Effect.die("not used"),
      findForUser: () =>
        Effect.succeed({
          id: workspaceId,
          ownerUserId: "user-1",
          name: "User",
          createdAt: "2026-08-27T00:00:00.000Z",
        }),
    },
    store,
    authority: input.authority ?? defaultAuthority,
    tokens: { issue: () => Effect.succeed(token) },
    tokenLeases: {
      seal: () =>
        Effect.succeed({
          leaseRef: "token-lease-1" as WorkerGitHubTokenLeaseRef,
          expiresAt: "2026-08-27T13:00:00.000Z",
        }),
    },
    github: input.github ?? defaultGithub,
    worker: {
      dispatch,
      prepare: () =>
        Effect.succeed({
          lease: workerLease,
          dispatch: (command) => dispatch(undefined, command),
        }),
      handleResult: () => Effect.void,
      close: () => undefined,
      pendingCount: () => 0,
      pendingBytes: () => 0,
    },
    clock: { now: () => now },
  });
  return {
    workflow,
    workerCommands,
    completion: () => completion,
    failureCode: () => failureCode,
  };
};

const execute = (
  workflow: ReturnType<typeof makeGitHubThreadWorkflow>,
  command: ReturnType<typeof checkpoint>,
) =>
  workflow.execute({
    actorUserId: "user-1",
    authSessionId,
    workspaceId,
    idempotencyKey: `idem-${command.commandId}`,
    command,
  });

it.effect("rejects a forged approval id before any GitHub or worker effect", () => {
  let externalReads = 0;
  const command = checkpoint("forged-approval");
  const harness = makeHarness({
    command,
    authority: {
      validateApproval: () =>
        Effect.fail(new GitHubAuthorityError({ code: "notFound", retryable: false })),
      resolveWorkerTarget: () => Effect.die("must not resolve a worker"),
    },
    github: {
      validateRepository: () => {
        externalReads += 1;
        return Effect.die("must not call GitHub");
      },
      getBranchHead: () => Effect.die("must not call GitHub"),
      findOpenPullRequest: () => Effect.die("must not call GitHub"),
      getPullRequest: () => Effect.die("must not call GitHub"),
      createDraftPullRequest: () => Effect.die("must not call GitHub"),
      markPullRequestReady: () => Effect.die("must not call GitHub"),
    },
  });
  return Effect.gen(function* () {
    const error = yield* Effect.flip(execute(harness.workflow, command));
    expect(error.code).toBe("approvalRequired");
    expect(externalReads).toBe(0);
    expect(harness.workerCommands).toEqual([]);
  });
});

it.effect(
  "rechecks approval after local preparation and performs zero remote writes when it expires",
  () => {
    let validations = 0;
    const command = checkpoint();
    const harness = makeHarness({
      command,
      authority: {
        validateApproval: (request) => {
          validations += 1;
          return validations < 3
            ? Effect.succeed({
                approval: {
                  approvalId: request.approvalId as never,
                  workspaceId,
                  threadId,
                  repository,
                  actions: [request.action],
                  decidedByUserId: "user-1",
                  decidedBy: authSessionId,
                  approvedAt: "2026-08-27T11:00:00.000Z",
                  expiresAt: "2026-08-27T13:00:00.000Z",
                },
                generation: "approval-generation-1",
              })
            : Effect.fail(new GitHubAuthorityError({ code: "expired", retryable: false }));
        },
        resolveWorkerTarget: () =>
          Effect.succeed({ workspaceId, environmentId, threadId, sandboxId: "sandbox-1" as never }),
      },
    });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(execute(harness.workflow, command));
      expect(error.code).toBe("approvalExpired");
      expect(harness.workerCommands).toEqual(["github.git.prepare-checkpoint"]);
      expect(harness.failureCode()).toBe("approvalExpired");
    });
  },
);

it.effect("reconciles mark-ready after an uncertain GitHub completion", () => {
  let reads = 0;
  let writes = 0;
  const command = markReady();
  const harness = makeHarness({
    command,
    currentView: view({
      number: 7,
      url: "https://github.com/jarrodwatts/agentsin-cloud/pull/7",
      draft: true,
    }),
    github: {
      validateRepository: () =>
        Effect.succeed({
          repositoryId: 42,
          defaultBranch: "main",
          canPush: true,
          canPullRequests: true,
        }),
      getBranchHead: () => Effect.succeed(baseSha),
      findOpenPullRequest: () => Effect.sync(() => undefined),
      getPullRequest: () => {
        reads += 1;
        return Effect.succeed({
          number: 7,
          url: "https://github.com/jarrodwatts/agentsin-cloud/pull/7",
          draft: reads === 1,
          headBranch: branchName,
        });
      },
      createDraftPullRequest: () => Effect.die("not used"),
      markPullRequestReady: () => {
        writes += 1;
        return Effect.fail(
          new GitHubAppError({ code: "networkFailure", operation: "mark-ready", retryable: true }),
        );
      },
    },
  });
  return Effect.gen(function* () {
    yield* execute(harness.workflow, command);
    expect(writes).toBe(1);
    expect(reads).toBe(2);
    expect(harness.completion()).toMatchObject({
      type: "readyPullRequest",
      pullRequest: { draft: false },
    });
  });
});

it("builds a deterministic valid branch name from hostile thread text", () => {
  const first = branchNameForThread("../../refs/heads/main\nlock", threadId);
  const second = branchNameForThread("../../refs/heads/main\nlock", threadId);
  expect(first).toBe(second);
  expect(first).toMatch(/^agents\/[a-z0-9][a-z0-9._-]*-[a-f0-9]{12}$/);
  expect(first).not.toContain("..");
  expect(first).not.toContain("refs/");
});

it.effect("pauses durably when a user commit advances the remote branch", () => {
  const command = checkpoint();
  const harness = makeHarness({
    command,
    github: {
      validateRepository: () =>
        Effect.succeed({
          repositoryId: 42,
          defaultBranch: "main",
          canPush: true,
          canPullRequests: true,
        }),
      getBranchHead: () => Effect.succeed("c".repeat(40) as GitObjectSha),
      findOpenPullRequest: () => Effect.die("not used"),
      getPullRequest: () => Effect.die("not used"),
      createDraftPullRequest: () => Effect.die("not used"),
      markPullRequestReady: () => Effect.die("not used"),
    },
  });
  return Effect.gen(function* () {
    const error = yield* Effect.flip(execute(harness.workflow, command));
    expect(error.code).toBe("conflict");
    expect(harness.failureCode()).toBe("conflict");
    expect(harness.workerCommands).toEqual([]);
  });
});

it.effect("reconciles an uncertain draft PR creation without duplicating the PR", () => {
  let created = false;
  let creates = 0;
  const command = openDraft();
  const harness = makeHarness({
    command,
    github: {
      validateRepository: () =>
        Effect.succeed({
          repositoryId: 42,
          defaultBranch: "main",
          canPush: true,
          canPullRequests: true,
        }),
      getBranchHead: () => Effect.die("not used"),
      findOpenPullRequest: () =>
        Effect.succeed(
          created
            ? {
                number: 9,
                url: "https://github.com/jarrodwatts/agentsin-cloud/pull/9",
                draft: true,
                headBranch: branchName,
              }
            : undefined,
        ),
      getPullRequest: () => Effect.die("not used"),
      createDraftPullRequest: () => {
        creates += 1;
        created = true;
        return Effect.fail(
          new GitHubAppError({
            code: "networkFailure",
            operation: "create-draft-pr",
            retryable: true,
          }),
        );
      },
      markPullRequestReady: () => Effect.die("not used"),
    },
  });
  return Effect.gen(function* () {
    yield* execute(harness.workflow, command);
    expect(creates).toBe(1);
    expect(harness.completion()).toMatchObject({
      type: "draftPullRequest",
      pullRequest: { number: 9, draft: true },
    });
  });
});
