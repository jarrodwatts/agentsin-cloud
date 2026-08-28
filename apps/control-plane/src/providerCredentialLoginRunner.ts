import type { ProviderInstanceRef } from "@t3tools/contracts";
import type {
  AgentConnectionLoginMethod,
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
  /** Returns the public login method only for drivers this runner can execute. */
  readonly loginMethod: (provider: ProviderInstanceRef) => AgentConnectionLoginMethod | undefined;
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
  /** The job starts from exactly these values; the host environment is never inherited. */
  readonly environment: {
    readonly inherit: false;
    readonly variables: Readonly<Record<string, string>>;
  };
}

export const PROVIDER_LOGIN_HOME = "/run/agentsin/provider-login/home";
export const PROVIDER_LOGIN_TMPDIR = "/run/agentsin/provider-login/tmp";
export const PROVIDER_LOGIN_CONFIG_DIRECTORY = "/run/agentsin/provider-login/provider";
export const PROVIDER_LOGIN_SECURE_STORAGE_DIRECTORY =
  "/run/agentsin/provider-login/secure-storage";

const REQUIRED_PROVIDER_LOGIN_ENVIRONMENT = new Set([
  "HOME",
  "LANG",
  "LC_ALL",
  "NO_COLOR",
  "PATH",
  "TMPDIR",
]);

const FORBIDDEN_PROVIDER_LOGIN_ENVIRONMENT = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_API_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_API_KEY",
  "CLAUDE_CODE_BASE_URL",
  "CODEX_API_KEY",
  "CODEX_AUTH_TOKEN",
  "CODEX_BASE_URL",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "OPENAI_API_BASE",
  "OPENAI_API_KEY",
  "OPENAI_API_URL",
  "OPENAI_AUTH_TOKEN",
  "OPENAI_BASE_URL",
]);

/** Defense in depth: exact allowlisting already excludes every matching name. */
export const isForbiddenProviderLoginEnvironmentVariable = (name: string) =>
  FORBIDDEN_PROVIDER_LOGIN_ENVIRONMENT.has(name) ||
  /^(?:ANTHROPIC|AWS|AZURE_OPENAI|CLAUDE(?:_CODE)?|CODEX|GOOGLE|OPENAI)_.+(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN|ACCESS_KEY|SECRET|SESSION_TOKEN|PASSWORD|BASE_URL|API_URL|ENDPOINT|CREDENTIALS?|CUSTOM_HEADERS)$/u.test(
    name,
  );

const isExplicitExecutableSearchPath = (value: string) =>
  value.length >= 1 &&
  value.length <= 4_096 &&
  value
    .split(":")
    .every(
      (path) =>
        path.startsWith("/") &&
        !path.includes("\0") &&
        path.split("/").every((part) => part !== "." && part !== ".."),
    );

/** Fail-closed validation shared by production job/container adapters. */
export const validateProviderCredentialLoginRunnerPolicy = (
  policy: ProviderCredentialLoginRunnerSecurityPolicy,
): Effect.Effect<void, ProviderCredentialLoginRunnerError> =>
  Effect.suspend(() => {
    const digests = [...policy.executableSha256Allowlist];
    const domains = [...policy.allowedDomains];
    const environment = policy.environment;
    const environmentEntries = Object.entries(environment?.variables ?? {});
    const environmentNames = new Set(environmentEntries.map(([name]) => name));
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
      ) ||
      environment?.inherit !== false ||
      environmentEntries.length !== REQUIRED_PROVIDER_LOGIN_ENVIRONMENT.size ||
      environmentEntries.some(
        ([name, value]) =>
          !REQUIRED_PROVIDER_LOGIN_ENVIRONMENT.has(name) ||
          isForbiddenProviderLoginEnvironmentVariable(name) ||
          typeof value !== "string" ||
          value.includes("\0"),
      ) ||
      [...REQUIRED_PROVIDER_LOGIN_ENVIRONMENT].some((name) => !environmentNames.has(name)) ||
      environment.variables.HOME !== PROVIDER_LOGIN_HOME ||
      environment.variables.TMPDIR !== PROVIDER_LOGIN_TMPDIR ||
      environment.variables.LANG !== "C.UTF-8" ||
      environment.variables.LC_ALL !== "C.UTF-8" ||
      environment.variables.NO_COLOR !== "1" ||
      !isExplicitExecutableSearchPath(environment.variables.PATH ?? "")
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
