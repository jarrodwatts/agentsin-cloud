import type { ProviderInstanceRef } from "@t3tools/contracts";
import type {
  AgentConnectionLoginEvent,
  AgentLoginId,
  AgentProfileId,
  WorkspaceId,
} from "@t3tools/contracts/cloud";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { Secret } from "./providerSecrets.ts";

export class ProviderCredentialLoginRunnerError extends Schema.TaggedErrorClass<ProviderCredentialLoginRunnerError>()(
  "ProviderCredentialLoginRunnerError",
  {
    code: Schema.Literals([
      "capacityExceeded",
      "configurationInvalid",
      "executionFailed",
      "expired",
      "notFound",
      "terminationFailed",
    ]),
    operation: Schema.String,
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {}

export interface ProviderCredentialLoginRunInput {
  readonly workspaceId: WorkspaceId;
  readonly loginId: AgentLoginId;
  readonly profileId: AgentProfileId;
  readonly provider: ProviderInstanceRef;
  readonly expiresAt: string;
  readonly onEvent: (
    event: AgentConnectionLoginEvent,
  ) => Effect.Effect<void, ProviderCredentialLoginRunnerError>;
}

export type ProviderCredentialLoginRunResult =
  | {
      readonly outcome: "authorized";
      /** Owned mutable bytes. The coordinator seals and zeroizes them locally. */
      readonly credential: Secret<Uint8Array>;
      readonly accountLabel?: string;
      readonly occurredAt: string;
    }
  | {
      readonly outcome: "denied" | "expired" | "cancelled" | "failed";
      readonly errorCode?: string;
      readonly occurredAt: string;
    };

/**
 * Provider-neutral boundary for a disposable credential-only job. A production
 * adapter must provide an empty HOME/TMPDIR, no repository or worker mounts,
 * an allowlisted digest-pinned executable, bounded output/runtime, restricted
 * egress, confirmed process-tree termination, and cleanup before resolving.
 * Provider-specific command construction belongs to D2.
 */
export interface ProviderCredentialLoginRunner {
  /** Revalidates the concrete job/container boundary before hosted startup. */
  readonly validateConfiguration: Effect.Effect<void, ProviderCredentialLoginRunnerError>;
  readonly run: (
    input: ProviderCredentialLoginRunInput,
  ) => Effect.Effect<ProviderCredentialLoginRunResult, ProviderCredentialLoginRunnerError>;
  readonly cancel: (input: {
    readonly workspaceId: WorkspaceId;
    readonly loginId: AgentLoginId;
  }) => Effect.Effect<void, ProviderCredentialLoginRunnerError>;
  readonly shutdown: Effect.Effect<void, ProviderCredentialLoginRunnerError>;
}

export interface ProviderCredentialLoginRunnerSecurityPolicy {
  readonly isolationMode: "railway-job" | "dedicated-container";
  readonly emptyHome: true;
  readonly repositoryMounts: 0;
  readonly credentialMounts: 0;
  readonly dropSupplementaryGroups: true;
  readonly maxRuntimeMs: number;
  readonly maxOutputBytes: number;
  readonly maxProfileBytes: number;
  readonly maxConcurrentRuns: number;
  readonly executableSha256Allowlist: ReadonlySet<string>;
  readonly allowedDomains: ReadonlySet<string>;
}

/** Fail-closed validation shared by production job/container adapters. */
export const validateProviderCredentialLoginRunnerPolicy = (
  policy: ProviderCredentialLoginRunnerSecurityPolicy,
): Effect.Effect<void, ProviderCredentialLoginRunnerError> =>
  Effect.suspend(() => {
    const digests = [...policy.executableSha256Allowlist];
    const domains = [...policy.allowedDomains];
    if (
      policy.emptyHome !== true ||
      policy.repositoryMounts !== 0 ||
      policy.credentialMounts !== 0 ||
      policy.dropSupplementaryGroups !== true ||
      !Number.isSafeInteger(policy.maxRuntimeMs) ||
      policy.maxRuntimeMs < 1 ||
      policy.maxRuntimeMs > 15 * 60_000 ||
      !Number.isSafeInteger(policy.maxOutputBytes) ||
      policy.maxOutputBytes < 1 ||
      policy.maxOutputBytes > 64 * 1024 ||
      !Number.isSafeInteger(policy.maxProfileBytes) ||
      policy.maxProfileBytes < 1 ||
      policy.maxProfileBytes > 1024 * 1024 ||
      !Number.isSafeInteger(policy.maxConcurrentRuns) ||
      policy.maxConcurrentRuns < 1 ||
      policy.maxConcurrentRuns > 64 ||
      digests.length === 0 ||
      digests.some((digest) => !/^[0-9a-f]{64}$/u.test(digest)) ||
      domains.length === 0 ||
      domains.some(
        (domain) =>
          domain.length > 253 ||
          !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u.test(
            domain,
          ),
      )
    ) {
      return Effect.fail(
        new ProviderCredentialLoginRunnerError({
          code: "configurationInvalid",
          operation: "validate-security-policy",
        }),
      );
    }
    return Effect.void;
  });
