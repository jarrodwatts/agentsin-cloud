import type { GitHubRepositoryRef } from "@t3tools/contracts/cloud";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "@effect/vitest";

import { makeGitHubAppClient } from "./githubAppClient.ts";

const repository: GitHubRepositoryRef = {
  provider: "github",
  host: "github.com",
  installationId: "installation-1" as GitHubRepositoryRef["installationId"],
  owner: "jarrodwatts",
  name: "agentsin-cloud",
  canonicalKey: "github.com/jarrodwatts/agentsin-cloud",
};
const token = {
  token: Redacted.make("github-installation-secret"),
  expiresAt: "2026-08-27T13:00:00.000Z",
};

describe("GitHubAppClient", () => {
  it.effect(
    "keeps the installation token out of inspection while sending it only as authorization",
    () =>
      Effect.gen(function* () {
        let authorization: string | null = null;
        const client = makeGitHubAppClient(async (_url, init) => {
          authorization = new Headers(init?.headers).get("authorization");
          return new Response(
            JSON.stringify({
              id: 42,
              default_branch: "main",
              permissions: { push: true, pull: true },
            }),
            { status: 200 },
          );
        });

        const access = yield* client.validateRepository(token, repository);
        expect(access.canPush).toBe(true);
        expect(authorization).toBe("Bearer github-installation-secret");
        expect(String(token.token)).toBe("<redacted>");
      }),
  );

  it.effect("maps rate limits into a typed retry-aware error", () =>
    Effect.gen(function* () {
      const client = makeGitHubAppClient(
        async () =>
          new Response("limited", {
            status: 429,
            headers: { "retry-after": "60", "x-ratelimit-remaining": "0" },
          }),
      );
      const error = yield* Effect.flip(client.validateRepository(token, repository));
      expect(error._tag).toBe("GitHubAppError");
      expect(error.code).toBe("rateLimited");
      expect(error.retryable).toBe(true);
      expect(error.retryAt).toBeDefined();
    }),
  );

  it.effect("looks up the real PR node id before marking it ready", () =>
    Effect.gen(function* () {
      const requests: Array<{ readonly url: string; readonly body?: string }> = [];
      const client = makeGitHubAppClient(async (url, init) => {
        requests.push({
          url: String(url),
          ...(typeof init?.body === "string" ? { body: init.body } : {}),
        });
        if (String(url).endsWith("/pulls/7")) {
          return new Response(JSON.stringify({ node_id: "PR_kwDO-real-node-id" }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            data: {
              markPullRequestReadyForReview: {
                pullRequest: {
                  number: 7,
                  url: "https://github.com/jarrodwatts/agentsin-cloud/pull/7",
                  isDraft: false,
                  headRefName: "agents/fix-checkout-123456789abc",
                },
              },
            },
          }),
          { status: 200 },
        );
      });

      const pullRequest = yield* client.markPullRequestReady(token, repository, 7);
      expect(pullRequest.draft).toBe(false);
      expect(requests).toHaveLength(2);
      expect(requests[1]?.body).toContain("PR_kwDO-real-node-id");
      expect(requests[1]?.body).not.toContain("jarrodwatts/agentsin-cloud#7");
    }),
  );
});
