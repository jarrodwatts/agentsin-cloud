import type { GitHubRepositoryRef, GitObjectSha } from "@t3tools/contracts/cloud";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export interface GitHubInstallationToken {
  readonly token: Redacted.Redacted<string>;
  readonly expiresAt: string;
}

export interface GitHubInstallationTokenIssuer {
  /** The signer must mint a repository-scoped, short-lived installation token. */
  readonly issue: (
    repository: GitHubRepositoryRef,
  ) => Effect.Effect<GitHubInstallationToken, GitHubAppError>;
}

export interface GitHubPullRequestRecord {
  readonly number: number;
  readonly url: string;
  readonly draft: boolean;
  readonly headBranch: string;
}

export interface GitHubRepositoryAccess {
  readonly repositoryId: number;
  readonly defaultBranch: string;
  readonly canPush: boolean;
  readonly canPullRequests: boolean;
}

export class GitHubAppError extends Schema.TaggedErrorClass<GitHubAppError>()("GitHubAppError", {
  code: Schema.Literals([
    "unauthorized",
    "forbidden",
    "notFound",
    "rateLimited",
    "conflict",
    "invalidResponse",
    "networkFailure",
  ]),
  operation: Schema.String,
  retryable: Schema.Boolean,
  retryAt: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Unknown),
}) {}

export interface GitHubAppClient {
  readonly validateRepository: (
    token: GitHubInstallationToken,
    repository: GitHubRepositoryRef,
  ) => Effect.Effect<GitHubRepositoryAccess, GitHubAppError>;
  readonly getBranchHead: (
    token: GitHubInstallationToken,
    repository: GitHubRepositoryRef,
    branch: string,
  ) => Effect.Effect<GitObjectSha | undefined, GitHubAppError>;
  readonly findOpenPullRequest: (
    token: GitHubInstallationToken,
    repository: GitHubRepositoryRef,
    headBranch: string,
  ) => Effect.Effect<GitHubPullRequestRecord | undefined, GitHubAppError>;
  readonly getPullRequest: (
    token: GitHubInstallationToken,
    repository: GitHubRepositoryRef,
    pullRequestNumber: number,
  ) => Effect.Effect<GitHubPullRequestRecord, GitHubAppError>;
  readonly createDraftPullRequest: (
    token: GitHubInstallationToken,
    repository: GitHubRepositoryRef,
    input: {
      readonly headBranch: string;
      readonly baseBranch: string;
      readonly title: string;
      readonly body: string;
    },
  ) => Effect.Effect<GitHubPullRequestRecord, GitHubAppError>;
  readonly markPullRequestReady: (
    token: GitHubInstallationToken,
    repository: GitHubRepositoryRef,
    pullRequestNumber: number,
  ) => Effect.Effect<GitHubPullRequestRecord, GitHubAppError>;
}

const retryAt = (headers: Headers, now: DateTime.Utc): string | undefined => {
  const retryAfter = headers.get("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter)) {
    return DateTime.formatIso(DateTime.add(now, { seconds: Number(retryAfter) }));
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset && /^\d+$/.test(reset))
    return DateTime.formatIso(DateTime.makeUnsafe(Number(reset) * 1_000));
  return undefined;
};

const responseError = (operation: string, response: Response, now: DateTime.Utc) => {
  const limited = response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0";
  const code = limited
    ? "rateLimited"
    : response.status === 401
      ? "unauthorized"
      : response.status === 403
        ? "forbidden"
        : response.status === 404
          ? "notFound"
          : response.status === 409 || response.status === 422
            ? "conflict"
            : "invalidResponse";
  const resetAt = limited ? retryAt(response.headers, now) : undefined;
  return new GitHubAppError({
    code,
    operation,
    retryable: limited || response.status >= 500,
    ...(resetAt ? { retryAt: resetAt } : {}),
  });
};

const readJson = <A>(operation: string, response: Response) =>
  Effect.tryPromise({
    try: () => response.json() as Promise<A>,
    catch: (cause) =>
      new GitHubAppError({ code: "invalidResponse", operation, retryable: false, cause }),
  });

const request = (
  fetchImplementation: typeof fetch,
  token: GitHubInstallationToken,
  operation: string,
  url: string,
  init?: RequestInit,
  now: () => DateTime.Utc = DateTime.nowUnsafe,
) =>
  Effect.tryPromise({
    try: () => {
      const headers = new Headers(init?.headers);
      headers.set("Accept", "application/vnd.github+json");
      headers.set("Authorization", `Bearer ${Redacted.value(token.token)}`);
      headers.set("X-GitHub-Api-Version", "2022-11-28");
      return fetchImplementation(url, {
        ...init,
        headers,
      });
    },
    catch: (cause) =>
      new GitHubAppError({ code: "networkFailure", operation, retryable: true, cause }),
  }).pipe(
    Effect.flatMap((response) =>
      response.ok
        ? Effect.succeed(response)
        : Effect.fail(responseError(operation, response, now())),
    ),
  );

const repoUrl = (repository: GitHubRepositoryRef, suffix = "") =>
  `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}${suffix}`;

const parsePullRequest = (value: unknown, operation: string): GitHubPullRequestRecord => {
  const candidate = value as {
    readonly number?: unknown;
    readonly html_url?: unknown;
    readonly draft?: unknown;
    readonly head?: { readonly ref?: unknown };
  };
  if (
    !Number.isSafeInteger(candidate.number) ||
    (candidate.number as number) <= 0 ||
    typeof candidate.html_url !== "string" ||
    typeof candidate.draft !== "boolean" ||
    typeof candidate.head?.ref !== "string"
  ) {
    throw new GitHubAppError({ code: "invalidResponse", operation, retryable: false });
  }
  return {
    number: candidate.number as number,
    url: candidate.html_url,
    draft: candidate.draft,
    headBranch: candidate.head.ref,
  };
};

export const makeGitHubAppClient = (
  fetchImplementation: typeof fetch = fetch,
): GitHubAppClient => ({
  validateRepository: (token, repository) => {
    const operation = "validate-repository";
    return request(fetchImplementation, token, operation, repoUrl(repository)).pipe(
      Effect.flatMap((response) => readJson<unknown>(operation, response)),
      Effect.flatMap((value) => {
        const candidate = value as {
          readonly id?: unknown;
          readonly default_branch?: unknown;
          readonly permissions?: { readonly push?: unknown; readonly pull?: unknown };
        };
        return Number.isSafeInteger(candidate.id) &&
          typeof candidate.default_branch === "string" &&
          typeof candidate.permissions?.push === "boolean" &&
          typeof candidate.permissions.pull === "boolean"
          ? Effect.succeed({
              repositoryId: candidate.id as number,
              defaultBranch: candidate.default_branch,
              canPush: candidate.permissions.push,
              canPullRequests: candidate.permissions.pull,
            })
          : Effect.fail(
              new GitHubAppError({ code: "invalidResponse", operation, retryable: false }),
            );
      }),
    );
  },
  getBranchHead: (token, repository, branch) => {
    const operation = "get-branch-head";
    return request(
      fetchImplementation,
      token,
      operation,
      repoUrl(repository, `/git/ref/heads/${encodeURIComponent(branch)}`),
    ).pipe(
      Effect.flatMap((response) => readJson<unknown>(operation, response)),
      Effect.flatMap((value) => {
        const sha = (value as { readonly object?: { readonly sha?: unknown } }).object?.sha;
        return typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha)
          ? Effect.succeed(sha as GitObjectSha)
          : Effect.fail(
              new GitHubAppError({ code: "invalidResponse", operation, retryable: false }),
            );
      }),
      Effect.catch((error) =>
        error.code === "notFound" ? Effect.void.pipe(Effect.as(undefined)) : Effect.fail(error),
      ),
    );
  },
  findOpenPullRequest: (token, repository, headBranch) => {
    const operation = "find-open-pull-request";
    const query = new URLSearchParams({ state: "open", head: `${repository.owner}:${headBranch}` });
    return request(
      fetchImplementation,
      token,
      operation,
      repoUrl(repository, `/pulls?${query.toString()}`),
    ).pipe(
      Effect.flatMap((response) => readJson<ReadonlyArray<unknown>>(operation, response)),
      Effect.map((rows) =>
        rows[0] === undefined ? undefined : parsePullRequest(rows[0], operation),
      ),
    );
  },
  getPullRequest: (token, repository, pullRequestNumber) => {
    const operation = "get-pull-request";
    return request(
      fetchImplementation,
      token,
      operation,
      repoUrl(repository, `/pulls/${pullRequestNumber}`),
    ).pipe(
      Effect.flatMap((response) => readJson<unknown>(operation, response)),
      Effect.map((value) => parsePullRequest(value, operation)),
    );
  },
  createDraftPullRequest: (token, repository, input) => {
    const operation = "create-draft-pull-request";
    return request(fetchImplementation, token, operation, repoUrl(repository, "/pulls"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        head: input.headBranch,
        base: input.baseBranch,
        title: input.title,
        body: input.body,
        draft: true,
      }),
    }).pipe(
      Effect.flatMap((response) => readJson<unknown>(operation, response)),
      Effect.map((value) => parsePullRequest(value, operation)),
    );
  },
  markPullRequestReady: (token, repository, pullRequestNumber) => {
    const operation = "mark-pull-request-ready";
    return request(
      fetchImplementation,
      token,
      operation,
      repoUrl(repository, `/pulls/${pullRequestNumber}`),
    ).pipe(
      Effect.flatMap((response) => readJson<unknown>(operation, response)),
      Effect.flatMap((pull) => {
        const nodeId = (pull as { readonly node_id?: unknown }).node_id;
        if (typeof nodeId !== "string" || nodeId.length === 0) {
          return Effect.fail(
            new GitHubAppError({ code: "invalidResponse", operation, retryable: false }),
          );
        }
        return request(fetchImplementation, token, operation, "https://api.github.com/graphql", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query:
              "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{number url isDraft headRefName}}}",
            variables: { id: nodeId },
          }),
        });
      }),
      Effect.flatMap((response) => readJson<unknown>(operation, response)),
      Effect.map((value) => {
        const pullRequest = (
          value as {
            readonly data?: {
              readonly markPullRequestReadyForReview?: {
                readonly pullRequest?: {
                  readonly number?: unknown;
                  readonly url?: unknown;
                  readonly isDraft?: unknown;
                  readonly headRefName?: unknown;
                };
              };
            };
          }
        ).data?.markPullRequestReadyForReview?.pullRequest;
        return parsePullRequest(
          {
            number: pullRequest?.number,
            html_url: pullRequest?.url,
            draft: pullRequest?.isDraft,
            head: { ref: pullRequest?.headRefName },
          },
          operation,
        );
      }),
    );
  },
});
