import type { AuthSessionId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type {
  AgentConnectionProfile,
  AgentLoginId,
  AgentMaterializationId,
  AgentProfileId,
  WorkspaceId,
} from "@t3tools/contracts/cloud";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeHostedAgentConnectionAdapter } from "./agentConnectionAdapter.ts";
import type { ProviderLoginCoordinator } from "./providerCredentialProduction.ts";
import type { ProviderCredentialService } from "./providerCredentialService.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111" as WorkspaceId;
const loginId = "login-a" as AgentLoginId;
const profileId = "profile-a" as AgentProfileId;
const threadId = "thread-a" as ThreadId;
const materializationId = "materialization-a" as AgentMaterializationId;
const profile = {
  profileId,
  workspaceId,
  provider: { instanceId: "codex_work", driver: "codex" },
  label: "Work",
  state: "active",
  keyVersion: "kms-v1",
  createdAt: "2026-08-27T12:00:00.000Z",
  updatedAt: "2026-08-27T12:01:00.000Z",
} as AgentConnectionProfile;
const principal = {
  workspaceId,
  authSessionId: "session-a" as AuthSessionId,
  userId: "user-a",
};

it.effect("implements every hosted connection operation through the D1 authority boundaries", () =>
  Effect.gen(function* () {
    const calls: Array<string> = [];
    const logins = {
      begin: () => Effect.sync(() => calls.push("beginLogin")) as never,
      poll: () => Effect.sync(() => calls.push("pollLogin")) as never,
      cancel: () => Effect.sync(() => calls.push("cancelLogin")) as never,
    } as unknown as ProviderLoginCoordinator;
    const profiles = {
      sealProfile: () =>
        Effect.sync(() => {
          calls.push("sealProfile");
          return profile;
        }),
      materialize: () => Effect.sync(() => calls.push("materialize")) as never,
      validate: () => Effect.sync(() => calls.push("validate")) as never,
      refresh: () => Effect.sync(() => calls.push("refresh")) as never,
      revoke: () =>
        Effect.sync(() => {
          calls.push("revoke");
          return profile;
        }),
    } as unknown as ProviderCredentialService;
    const adapter = makeHostedAgentConnectionAdapter({ logins, profiles });

    yield* adapter.beginLogin(principal, {
      threadId,
      providerInstanceId: "codex_work" as ProviderInstanceId,
    });
    yield* adapter.pollLogin(principal, loginId);
    const sealed = yield* adapter.sealProfile(principal, {
      loginId,
      profileId,
      label: "Work",
      idempotencyKey: "seal-once",
    });
    yield* adapter.materialize(principal, { threadId, profileId, materializationId });
    yield* adapter.validate(principal, profileId);
    yield* adapter.refresh(principal, profileId);
    const revoked = yield* adapter.revoke(principal, profileId);
    yield* adapter.cancelLogin(principal, loginId);

    expect(calls).toEqual([
      "beginLogin",
      "pollLogin",
      "sealProfile",
      "materialize",
      "validate",
      "refresh",
      "revoke",
      "cancelLogin",
    ]);
    expect(sealed).toEqual({ workspaceId, profile });
    expect(revoked).toEqual({
      profileId,
      workspaceId,
      revokedAt: profile.updatedAt,
    });
  }),
);
