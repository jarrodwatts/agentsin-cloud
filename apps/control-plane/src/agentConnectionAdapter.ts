import type {
  AgentConnectionBeginLoginResult,
  AgentConnectionMaterializeResult,
  AgentConnectionPollLoginResult,
  AgentConnectionRefreshResult,
  AgentConnectionRevokeResult,
  AgentConnectionSealProfileResult,
  AgentConnectionValidateResult,
  AgentLoginId,
  AgentMaterializationId,
  AgentProfileId,
} from "@t3tools/contracts/cloud";
import type { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type {
  ProviderCredentialAuthorizationContext,
  ProviderCredentialService,
  ProviderCredentialServiceError,
} from "./providerCredentialService.ts";
import type { ProviderLoginCoordinator } from "./providerCredentialProduction.ts";

/**
 * Server-authoritative implementation of the public AgentConnectionAdapter
 * lifecycle. Hosted callers never supply workspace, provider driver, sandbox,
 * target path, clock, or worker identity; those values are resolved by D1.
 */
export interface HostedAgentConnectionAdapter {
  readonly beginLogin: (
    principal: ProviderCredentialAuthorizationContext,
    input: { readonly threadId: ThreadId; readonly providerInstanceId: ProviderInstanceId },
  ) => Effect.Effect<AgentConnectionBeginLoginResult, ProviderCredentialServiceError>;
  readonly pollLogin: (
    principal: ProviderCredentialAuthorizationContext,
    loginId: AgentLoginId,
  ) => Effect.Effect<AgentConnectionPollLoginResult, ProviderCredentialServiceError>;
  readonly sealProfile: (
    principal: ProviderCredentialAuthorizationContext,
    input: {
      readonly loginId: AgentLoginId;
      readonly profileId: AgentProfileId;
      readonly label: string;
      readonly idempotencyKey: string;
    },
  ) => Effect.Effect<AgentConnectionSealProfileResult, ProviderCredentialServiceError>;
  readonly materialize: (
    principal: ProviderCredentialAuthorizationContext,
    input: {
      readonly threadId: ThreadId;
      readonly profileId: AgentProfileId;
      readonly materializationId: AgentMaterializationId;
    },
  ) => Effect.Effect<AgentConnectionMaterializeResult, ProviderCredentialServiceError>;
  readonly validate: (
    principal: ProviderCredentialAuthorizationContext,
    profileId: AgentProfileId,
  ) => Effect.Effect<AgentConnectionValidateResult, ProviderCredentialServiceError>;
  readonly refresh: (
    principal: ProviderCredentialAuthorizationContext,
    profileId: AgentProfileId,
  ) => Effect.Effect<AgentConnectionRefreshResult, ProviderCredentialServiceError>;
  readonly revoke: (
    principal: ProviderCredentialAuthorizationContext,
    profileId: AgentProfileId,
  ) => Effect.Effect<AgentConnectionRevokeResult, ProviderCredentialServiceError>;
  readonly cancelLogin: (
    principal: ProviderCredentialAuthorizationContext,
    loginId: AgentLoginId,
  ) => Effect.Effect<AgentConnectionPollLoginResult, ProviderCredentialServiceError>;
}

export const makeHostedAgentConnectionAdapter = (input: {
  readonly logins: ProviderLoginCoordinator;
  readonly profiles: ProviderCredentialService;
}): HostedAgentConnectionAdapter => ({
  beginLogin: (principal, request) => input.logins.begin({ principal, ...request }),
  pollLogin: (principal, loginId) => input.logins.poll(principal, loginId),
  sealProfile: (authorization, request) =>
    input.profiles
      .sealProfile({ authorization, ...request })
      .pipe(Effect.map((profile) => ({ workspaceId: profile.workspaceId, profile }))),
  materialize: (authorization, request) =>
    input.profiles.materialize({ authorization, ...request }),
  validate: (authorization, profileId) => input.profiles.validate({ authorization, profileId }),
  refresh: (authorization, profileId) => input.profiles.refresh({ authorization, profileId }),
  revoke: (authorization, profileId) =>
    input.profiles.revoke({ authorization, profileId }).pipe(
      Effect.map((profile) => ({
        profileId: profile.profileId,
        workspaceId: profile.workspaceId,
        revokedAt: profile.updatedAt,
      })),
    ),
  cancelLogin: (principal, loginId) => input.logins.cancel(principal, loginId),
});
