// @effect-diagnostics nodeBuiltinImport:off -- Branch suffixes and worker operation ids use SHA-256.
import * as NodeCrypto from "node:crypto";

import type { AuthSessionId, ThreadId } from "@t3tools/contracts";
import {
  GitHubThreadWorkflowCommand,
  type GitHubThreadBranchName,
  type GitHubThreadWorkflowView,
  type GitHubWorkflowAction,
  type GitObjectSha,
  type WorkspaceId,
} from "@t3tools/contracts/cloud";
import type {
  WorkerGitHubApprovalGeneration,
  WorkerGitHubCommand,
  WorkerGitHubOperationId,
} from "@t3tools/contracts/worker";
import { sanitizeBranchFragment } from "@t3tools/shared/git";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type {
  GitHubAppClient,
  GitHubAppError,
  GitHubInstallationToken,
  GitHubInstallationTokenIssuer,
} from "./githubAppClient.ts";
import type {
  ClaimedGitHubWorkflowEffect,
  GitHubWorkflowStore,
  GitHubWorkflowStoreError,
} from "./githubThreadWorkflowStore.ts";
import type { GitHubAuthorityError, GitHubWorkflowAuthority } from "./githubWorkflowAuthority.ts";
import type {
  GitHubWorkerDispatchError,
  GitHubWorkerDispatcher,
  GitHubWorkerTarget,
} from "./githubWorkerDispatcher.ts";
import { githubWorkerRouteBinding } from "./githubWorkerDispatcher.ts";
import type { GitHubTokenLeaseBroker, GitHubTokenLeaseError } from "./githubTokenLeaseBroker.ts";
import type { WorkspaceRepositoryError, WorkspaceRepositoryService } from "./workspaces.ts";

export class GitHubThreadWorkflowError extends Schema.TaggedErrorClass<GitHubThreadWorkflowError>()(
  "GitHubThreadWorkflowError",
  {
    code: Schema.Literals([
      "unauthorized",
      "repositoryDenied",
      "approvalRequired",
      "approvalExpired",
      "notFound",
      "conflict",
      "dependencyFailure",
      "databaseFailure",
    ]),
    retryable: Schema.Boolean,
    retryAt: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {}

export interface GitHubWorkflowClock {
  readonly now: () => number;
}

export interface GitHubThreadWorkflowDependencies {
  readonly workspaces: WorkspaceRepositoryService;
  readonly store: GitHubWorkflowStore;
  readonly authority: GitHubWorkflowAuthority;
  readonly tokens: GitHubInstallationTokenIssuer;
  readonly tokenLeases: Pick<GitHubTokenLeaseBroker, "seal">;
  readonly github: GitHubAppClient;
  readonly worker: GitHubWorkerDispatcher;
  readonly clock: GitHubWorkflowClock;
  readonly leaseMs?: number;
}

export interface ExecuteGitHubWorkflowInput {
  readonly actorUserId: string;
  readonly authSessionId: AuthSessionId;
  readonly workspaceId: WorkspaceId;
  readonly idempotencyKey: string;
  readonly command: GitHubThreadWorkflowCommand;
}

export interface ExecuteGitHubWorkflowResult {
  readonly disposition: "accepted" | "duplicate";
  readonly view?: GitHubThreadWorkflowView;
}

const decodeCommand = Schema.decodeUnknownEffect(GitHubThreadWorkflowCommand);
const isoAt = (epochMillis: number) => DateTime.formatIso(DateTime.makeUnsafe(epochMillis));

export const branchNameForThread = (
  threadSlug: string,
  threadId: ThreadId,
): GitHubThreadBranchName => {
  const slug = sanitizeBranchFragment(threadSlug).replaceAll("/", "-").slice(0, 64);
  const suffix = NodeCrypto.createHash("sha256").update(threadId).digest("hex").slice(0, 12);
  return `agents/${slug}-${suffix}` as GitHubThreadBranchName;
};

const operationId = (commandId: string, phase: string) =>
  `gh-${NodeCrypto.createHash("sha256").update(`${commandId}\0${phase}`).digest("hex").slice(0, 40)}` as WorkerGitHubOperationId;

const actionFor = (command: GitHubThreadWorkflowCommand): GitHubWorkflowAction => {
  switch (command.type) {
    case "github.branch.create":
      return "createBranch";
    case "github.checkpoint.push":
      return "pushCheckpoint";
    case "github.pull-request.open-draft":
      return "openDraftPullRequest";
    case "github.pull-request.mark-ready":
      return "markPullRequestReady";
  }
};

const mapStoreError = (cause: GitHubWorkflowStoreError) =>
  new GitHubThreadWorkflowError({
    code:
      cause.code === "notFound"
        ? "notFound"
        : cause.code === "repositoryDenied" || cause.code === "tenantMismatch"
          ? "repositoryDenied"
          : cause.code === "stateConflict" || cause.code === "idempotencyConflict"
            ? "conflict"
            : "databaseFailure",
    retryable: cause.retryable,
    cause,
  });

const mapWorkspaceError = (cause: WorkspaceRepositoryError) =>
  new GitHubThreadWorkflowError({ code: "databaseFailure", retryable: true, cause });

const mapAuthorityError = (cause: GitHubAuthorityError) =>
  new GitHubThreadWorkflowError({
    code:
      cause.code === "expired"
        ? "approvalExpired"
        : cause.code === "notFound" || cause.code === "notApproved"
          ? "approvalRequired"
          : cause.code === "identityMismatch"
            ? "unauthorized"
            : cause.code === "databaseFailure" || cause.code === "invalidRecord"
              ? "databaseFailure"
              : "dependencyFailure",
    retryable: cause.retryable,
    cause,
  });

const mapGitHubError = (cause: GitHubAppError) =>
  new GitHubThreadWorkflowError({
    code:
      cause.code === "unauthorized" || cause.code === "forbidden"
        ? "repositoryDenied"
        : cause.code === "notFound"
          ? "notFound"
          : cause.code === "conflict"
            ? "conflict"
            : "dependencyFailure",
    retryable: cause.retryable,
    ...(cause.retryAt ? { retryAt: cause.retryAt } : {}),
    cause,
  });

const mapWorkerError = (cause: GitHubWorkerDispatchError) =>
  new GitHubThreadWorkflowError({
    code:
      cause.code === "identityMismatch"
        ? "conflict"
        : cause.code === "workerRejected" &&
            typeof cause.cause === "object" &&
            cause.cause !== null &&
            "code" in cause.cause &&
            cause.cause.code === "nonFastForward"
          ? "conflict"
          : "dependencyFailure",
    retryable: cause.retryable,
    cause,
  });

const mapTokenLeaseError = (cause: GitHubTokenLeaseError) =>
  new GitHubThreadWorkflowError({
    code:
      cause.code === "approvalInvalid" || cause.code === "expired"
        ? "approvalExpired"
        : cause.code === "identityMismatch" || cause.code === "used"
          ? "conflict"
          : "dependencyFailure",
    retryable: cause.retryable,
    cause,
  });

const failureSummary = (error: GitHubThreadWorkflowError) => {
  switch (error.code) {
    case "conflict":
      return "GitHub or the cloud checkout changed. The thread is paused for review.";
    case "repositoryDenied":
      return "The GitHub App no longer has the required repository permission.";
    case "approvalExpired":
    case "approvalRequired":
    case "unauthorized":
      return "This GitHub write needs a new approval.";
    default:
      return "The GitHub operation failed.";
  }
};

const sameRepository = (
  left: ClaimedGitHubWorkflowEffect["workflow"]["repository"],
  right: ClaimedGitHubWorkflowEffect["workflow"]["repository"],
) =>
  left.installationId === right.installationId &&
  left.canonicalKey.toLowerCase() === right.canonicalKey.toLowerCase() &&
  left.owner.toLowerCase() === right.owner.toLowerCase() &&
  left.name.toLowerCase() === right.name.toLowerCase();

const validateApproval = (
  dependencies: GitHubThreadWorkflowDependencies,
  claim: Pick<ClaimedGitHubWorkflowEffect, "command" | "actorUserId" | "authSessionId">,
) =>
  dependencies.authority
    .validateApproval({
      approvalId: claim.command.approvalId,
      workspaceId: claim.command.workspaceId,
      threadId: claim.command.threadId,
      repository: claim.command.repository,
      action: actionFor(claim.command),
      actorUserId: claim.actorUserId,
      authSessionId: claim.authSessionId,
      now: isoAt(dependencies.clock.now()),
    })
    .pipe(Effect.mapError(mapAuthorityError));

const validateInitialAuthority = Effect.fn("GitHubThreadWorkflow.validateInitialAuthority")(
  function* (
    dependencies: GitHubThreadWorkflowDependencies,
    input: ExecuteGitHubWorkflowInput,
    command: GitHubThreadWorkflowCommand,
  ) {
    const workspace = yield* dependencies.workspaces
      .findForUser(input.actorUserId)
      .pipe(Effect.mapError(mapWorkspaceError));
    if (
      !workspace ||
      workspace.id !== input.workspaceId ||
      command.workspaceId !== input.workspaceId
    ) {
      return yield* new GitHubThreadWorkflowError({ code: "unauthorized", retryable: false });
    }
    yield* validateApproval(dependencies, {
      command,
      actorUserId: input.actorUserId,
      authSessionId: input.authSessionId,
    });
    const grant = yield* dependencies.store
      .getRepository(input.workspaceId, command.repository.canonicalKey)
      .pipe(Effect.mapError(mapStoreError));
    if (
      !grant ||
      !sameRepository(grant.repository, command.repository) ||
      !grant.canPush ||
      ((command.type === "github.pull-request.open-draft" ||
        command.type === "github.pull-request.mark-ready") &&
        !grant.canPullRequests)
    ) {
      return yield* new GitHubThreadWorkflowError({ code: "repositoryDenied", retryable: false });
    }
  },
);

type WorkerGitHubCommandBody = WorkerGitHubCommand extends infer Command
  ? Command extends WorkerGitHubCommand
    ? Omit<
        Command,
        "commandId" | "workspaceId" | "environmentId" | "threadId" | "sandboxId" | "repository"
      >
    : never
  : never;

const makeWorkerCommand = (
  target: GitHubWorkerTarget,
  claim: ClaimedGitHubWorkflowEffect,
  command: WorkerGitHubCommandBody,
): WorkerGitHubCommand =>
  ({
    ...command,
    commandId: claim.command.commandId,
    workspaceId: target.workspaceId,
    environmentId: target.environmentId,
    threadId: target.threadId,
    sandboxId: target.sandboxId,
    repository: claim.workflow.repository,
  }) as WorkerGitHubCommand;

const dispatchPush = Effect.fn("GitHubThreadWorkflow.dispatchPush")(function* (
  dependencies: GitHubThreadWorkflowDependencies,
  claim: ClaimedGitHubWorkflowEffect,
  target: GitHubWorkerTarget,
  token: GitHubInstallationToken,
  localSha: GitObjectSha,
  expectedRemoteSha: GitObjectSha | null,
) {
  const pushOperationId = operationId(claim.command.commandId, "push");
  const authorization = yield* validateApproval(dependencies, claim);
  const approvalGeneration = authorization.generation as WorkerGitHubApprovalGeneration;
  const preparedRoute = yield* dependencies.worker
    .prepare(target)
    .pipe(Effect.mapError(mapWorkerError));
  const tokenLease = yield* dependencies.tokenLeases
    .seal({
      token,
      workerLease: preparedRoute.lease,
      operationId: pushOperationId,
      commandId: claim.command.commandId,
      approvalId: claim.command.approvalId,
      approvalGeneration,
      approvalAction: actionFor(claim.command),
      approvalExpiresAt: authorization.approval.expiresAt,
      actorUserId: claim.actorUserId,
      authSessionId: claim.authSessionId,
      repository: claim.workflow.repository,
    })
    .pipe(Effect.mapError(mapTokenLeaseError));
  yield* preparedRoute
    .dispatch(
      makeWorkerCommand(target, claim, {
        type: "github.git.push",
        operationId: pushOperationId,
        branch: claim.workflow.branchName,
        localSha,
        expectedRemoteSha,
        tokenLeaseRef: tokenLease.leaseRef,
        approvalId: claim.command.approvalId,
        approvalGeneration,
        approvalAction: actionFor(claim.command),
        leaseExpiresAt: tokenLease.expiresAt,
        routeBinding: githubWorkerRouteBinding(preparedRoute.lease),
      }),
    )
    .pipe(Effect.mapError(mapWorkerError));
});

const processClaim = Effect.fn("GitHubThreadWorkflow.processClaim")(function* (
  dependencies: GitHubThreadWorkflowDependencies,
  claim: ClaimedGitHubWorkflowEffect,
) {
  yield* validateApproval(dependencies, claim);
  const token = yield* dependencies.tokens
    .issue(claim.workflow.repository)
    .pipe(Effect.mapError(mapGitHubError));
  if (token.expiresAt <= isoAt(dependencies.clock.now() + 30_000)) {
    return yield* new GitHubThreadWorkflowError({ code: "repositoryDenied", retryable: true });
  }
  const access = yield* dependencies.github
    .validateRepository(token, claim.workflow.repository)
    .pipe(Effect.mapError(mapGitHubError));
  const grant = yield* dependencies.store
    .getRepository(claim.workflow.workspaceId, claim.workflow.repository.canonicalKey)
    .pipe(Effect.mapError(mapStoreError));
  if (
    !grant ||
    !sameRepository(grant.repository, claim.workflow.repository) ||
    grant.repositoryId !== access.repositoryId ||
    !grant.canPush ||
    !access.canPush
  ) {
    return yield* new GitHubThreadWorkflowError({ code: "repositoryDenied", retryable: false });
  }

  const command = claim.command;
  if (command.type === "github.branch.create") {
    const target = yield* dependencies.authority
      .resolveWorkerTarget({
        workspaceId: claim.workflow.workspaceId,
        threadId: claim.workflow.threadId,
        repository: claim.workflow.repository,
      })
      .pipe(Effect.mapError(mapAuthorityError));
    yield* dependencies.worker
      .dispatch(
        target,
        makeWorkerCommand(target, claim, {
          type: "github.git.prepare-branch",
          operationId: operationId(command.commandId, "prepare-branch"),
          branch: claim.workflow.branchName,
          baseSha: claim.workflow.baseSha,
        }),
      )
      .pipe(Effect.mapError(mapWorkerError));
    const remote = yield* dependencies.github
      .getBranchHead(token, claim.workflow.repository, claim.workflow.branchName)
      .pipe(Effect.mapError(mapGitHubError));
    if (remote !== undefined && remote !== claim.workflow.baseSha) {
      return yield* new GitHubThreadWorkflowError({ code: "conflict", retryable: false });
    }
    if (remote === undefined)
      yield* dispatchPush(dependencies, claim, target, token, claim.workflow.baseSha, null);
    return { type: "branch", remoteHeadSha: claim.workflow.baseSha } as const;
  }

  if (command.type === "github.checkpoint.push") {
    const expected = claim.expectedParentSha;
    if (expected === undefined || claim.workflow.remoteHeadSha !== expected) {
      return yield* new GitHubThreadWorkflowError({ code: "conflict", retryable: false });
    }
    const remote = yield* dependencies.github
      .getBranchHead(token, claim.workflow.repository, claim.workflow.branchName)
      .pipe(Effect.mapError(mapGitHubError));
    if (claim.preparedSha !== undefined && remote === claim.preparedSha)
      return { type: "checkpoint", remoteHeadSha: claim.preparedSha } as const;
    if (remote !== expected)
      return yield* new GitHubThreadWorkflowError({ code: "conflict", retryable: false });
    const target = yield* dependencies.authority
      .resolveWorkerTarget({
        workspaceId: claim.workflow.workspaceId,
        threadId: claim.workflow.threadId,
        repository: claim.workflow.repository,
      })
      .pipe(Effect.mapError(mapAuthorityError));
    const prepared = yield* dependencies.worker
      .dispatch(
        target,
        makeWorkerCommand(target, claim, {
          type: "github.git.prepare-checkpoint",
          operationId: operationId(command.commandId, "prepare-checkpoint"),
          branch: claim.workflow.branchName,
          expectedParentSha: expected,
          message: command.message,
          committedAt: command.requestedAt,
        }),
      )
      .pipe(Effect.mapError(mapWorkerError));
    if (prepared.status !== "prepared")
      return yield* new GitHubThreadWorkflowError({ code: "dependencyFailure", retryable: true });
    const localSha = prepared.localSha;
    if (claim.preparedSha === undefined) {
      yield* dependencies.store
        .savePreparedSha(command.workspaceId, command.commandId, localSha, claim.attemptCount)
        .pipe(Effect.mapError(mapStoreError));
    } else if (claim.preparedSha !== localSha) {
      return yield* new GitHubThreadWorkflowError({ code: "conflict", retryable: false });
    }
    yield* dispatchPush(dependencies, claim, target, token, localSha, expected);
    return { type: "checkpoint", remoteHeadSha: localSha } as const;
  }

  if (!grant.canPullRequests || !access.canPullRequests)
    return yield* new GitHubThreadWorkflowError({ code: "repositoryDenied", retryable: false });
  if (command.type === "github.pull-request.open-draft") {
    const existing = yield* dependencies.github
      .findOpenPullRequest(token, claim.workflow.repository, claim.workflow.branchName)
      .pipe(Effect.mapError(mapGitHubError));
    let pullRequest = existing;
    if (pullRequest === undefined) {
      yield* validateApproval(dependencies, claim);
      pullRequest = yield* dependencies.github
        .createDraftPullRequest(token, claim.workflow.repository, {
          headBranch: claim.workflow.branchName,
          baseBranch: command.baseBranch,
          title: command.title,
          body: command.body,
        })
        .pipe(
          Effect.catch((createError) =>
            dependencies.github
              .findOpenPullRequest(token, claim.workflow.repository, claim.workflow.branchName)
              .pipe(
                Effect.flatMap((created) =>
                  created === undefined ? Effect.fail(createError) : Effect.succeed(created),
                ),
              ),
          ),
          Effect.mapError(mapGitHubError),
        );
    }
    if (!pullRequest.draft || pullRequest.headBranch !== claim.workflow.branchName)
      return yield* new GitHubThreadWorkflowError({ code: "conflict", retryable: false });
    return {
      type: "draftPullRequest",
      pullRequest: { number: pullRequest.number, url: pullRequest.url, draft: true },
    } as const;
  }

  const recorded = claim.workflow.pullRequest;
  if (recorded === null)
    return yield* new GitHubThreadWorkflowError({ code: "notFound", retryable: false });
  const authoritative = yield* dependencies.github
    .getPullRequest(token, claim.workflow.repository, recorded.number)
    .pipe(Effect.mapError(mapGitHubError));
  if (authoritative.headBranch !== claim.workflow.branchName)
    return yield* new GitHubThreadWorkflowError({ code: "conflict", retryable: false });
  if (!authoritative.draft)
    return {
      type: "readyPullRequest",
      pullRequest: { number: authoritative.number, url: authoritative.url, draft: false },
    } as const;
  yield* validateApproval(dependencies, claim);
  const ready = yield* dependencies.github
    .markPullRequestReady(token, claim.workflow.repository, recorded.number)
    .pipe(
      Effect.catch((writeError) =>
        dependencies.github
          .getPullRequest(token, claim.workflow.repository, recorded.number)
          .pipe(
            Effect.flatMap((reconciled) =>
              !reconciled.draft && reconciled.headBranch === claim.workflow.branchName
                ? Effect.succeed(reconciled)
                : Effect.fail(writeError),
            ),
          ),
      ),
      Effect.mapError(mapGitHubError),
    );
  if (ready.draft || ready.headBranch !== claim.workflow.branchName)
    return yield* new GitHubThreadWorkflowError({ code: "conflict", retryable: false });
  return {
    type: "readyPullRequest",
    pullRequest: { number: ready.number, url: ready.url, draft: false },
  } as const;
});

export const makeGitHubThreadWorkflow = (dependencies: GitHubThreadWorkflowDependencies) => {
  const process = (claim: ClaimedGitHubWorkflowEffect) =>
    Effect.gen(function* () {
      const completion = yield* processClaim(dependencies, claim).pipe(Effect.result);
      if (completion._tag === "Success") {
        yield* dependencies.store
          .complete({
            workspaceId: claim.command.workspaceId,
            commandId: claim.command.commandId,
            attemptCount: claim.attemptCount,
            completion: completion.success,
            occurredAt: isoAt(dependencies.clock.now()),
          })
          .pipe(Effect.mapError(mapStoreError));
        return;
      }
      const error = completion.failure;
      yield* dependencies.store
        .fail({
          workspaceId: claim.command.workspaceId,
          commandId: claim.command.commandId,
          attemptCount: claim.attemptCount,
          code: error.code,
          summary: failureSummary(error),
          retryable: error.retryable,
          conflict: error.code === "conflict",
          occurredAt: isoAt(dependencies.clock.now()),
          ...(error.retryAt ? { retryAt: error.retryAt } : {}),
        })
        .pipe(Effect.mapError(mapStoreError));
      return yield* error;
    });

  const drain = (workspaceId: WorkspaceId, commandId: string) =>
    Effect.gen(function* () {
      const now = dependencies.clock.now();
      const claim = yield* dependencies.store
        .claim({
          workspaceId,
          commandId,
          now: isoAt(now),
          leaseExpiresAt: isoAt(now + (dependencies.leaseMs ?? 60_000)),
        })
        .pipe(Effect.mapError(mapStoreError));
      if (claim === undefined) return false;
      yield* process(claim);
      return true;
    });

  const drainNext = (workspaceId: WorkspaceId) =>
    Effect.gen(function* () {
      const now = dependencies.clock.now();
      const claim = yield* dependencies.store
        .claimNext({
          workspaceId,
          now: isoAt(now),
          leaseExpiresAt: isoAt(now + (dependencies.leaseMs ?? 60_000)),
        })
        .pipe(Effect.mapError(mapStoreError));
      if (claim === undefined) return false;
      yield* process(claim);
      return true;
    });

  const execute = (input: ExecuteGitHubWorkflowInput) =>
    Effect.gen(function* () {
      const command = yield* decodeCommand(input.command).pipe(
        Effect.mapError(
          (cause) =>
            new GitHubThreadWorkflowError({ code: "approvalRequired", retryable: false, cause }),
        ),
      );
      yield* validateInitialAuthority(dependencies, input, command);
      const branchName =
        command.type === "github.branch.create"
          ? branchNameForThread(command.threadSlug, command.threadId)
          : undefined;
      const submission = yield* dependencies.store
        .submit({
          idempotencyKey: input.idempotencyKey,
          command,
          actorUserId: input.actorUserId,
          authSessionId: input.authSessionId,
          ...(branchName ? { branchName } : {}),
        })
        .pipe(Effect.mapError(mapStoreError));
      yield* drain(input.workspaceId, command.commandId);
      const view = yield* dependencies.store
        .get(input.workspaceId, command.threadId)
        .pipe(Effect.mapError(mapStoreError));
      return { disposition: submission.disposition, ...(view ? { view } : {}) };
    });

  return { execute, drain, drainNext };
};
