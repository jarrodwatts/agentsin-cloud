import type { SandboxProviderCreateRequest } from "@t3tools/contracts/cloud";

import type { E2bSandboxDescription, SandboxIdentityRecord } from "./types.ts";

export const E2B_IDENTITY_METADATA = {
  provider: "agentsin_cloud_provider",
  workspaceId: "agentsin_cloud_workspace_id",
  environmentId: "agentsin_cloud_environment_id",
  projectId: "agentsin_cloud_project_id",
  threadId: "agentsin_cloud_thread_id",
  revisionId: "agentsin_cloud_revision_id",
  reservationId: "agentsin_cloud_reservation_id",
  repositoryCanonicalKey: "agentsin_cloud_repository_canonical_key",
} as const;

/** Non-secret metadata used to bind an E2B resource to its durable control-plane identity. */
export const e2bIdentityMetadataFor = (request: SandboxProviderCreateRequest) => ({
  [E2B_IDENTITY_METADATA.provider]: "e2b",
  [E2B_IDENTITY_METADATA.workspaceId]: request.workspaceId,
  [E2B_IDENTITY_METADATA.environmentId]: request.environmentId,
  [E2B_IDENTITY_METADATA.projectId]: request.workspace.projectId,
  [E2B_IDENTITY_METADATA.threadId]: request.workspace.threadId,
  [E2B_IDENTITY_METADATA.revisionId]: request.revision.revisionId,
  [E2B_IDENTITY_METADATA.reservationId]: request.requestId,
  [E2B_IDENTITY_METADATA.repositoryCanonicalKey]: request.workspace.repositoryIdentity.canonicalKey,
});

/** Verify both the upstream handle and every tenant/thread binding before an E2B operation. */
export const e2bDescriptionMatchesIdentity = (
  remote: E2bSandboxDescription,
  identity: SandboxIdentityRecord,
) =>
  remote.sandboxId === identity.providerHandle &&
  remote.metadata[E2B_IDENTITY_METADATA.provider] === "e2b" &&
  remote.metadata[E2B_IDENTITY_METADATA.workspaceId] === identity.workspaceId &&
  remote.metadata[E2B_IDENTITY_METADATA.environmentId] === identity.environmentId &&
  remote.metadata[E2B_IDENTITY_METADATA.projectId] === identity.projectId &&
  remote.metadata[E2B_IDENTITY_METADATA.threadId] === identity.threadId &&
  remote.metadata[E2B_IDENTITY_METADATA.revisionId] === identity.revisionId &&
  remote.metadata[E2B_IDENTITY_METADATA.reservationId] === identity.reservationId &&
  remote.metadata[E2B_IDENTITY_METADATA.repositoryCanonicalKey] ===
    identity.repositoryIdentity.canonicalKey;
