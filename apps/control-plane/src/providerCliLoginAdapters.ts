// @effect-diagnostics nodeBuiltinImport:off -- Absolute executable validation is a Node deployment boundary.
import * as NodePath from "node:path";

import type { ProviderDriverKind } from "@t3tools/contracts";
import type { AgentConnectionLoginEvent } from "@t3tools/contracts/cloud";
import {
  decodeProviderProfileBundle,
  MAX_PROVIDER_PROFILE_BUNDLE_BYTES,
} from "@t3tools/contracts/provider-profile-bundle";
import * as Effect from "effect/Effect";

import {
  ProviderCredentialLoginRunnerError,
  PROVIDER_LOGIN_CONFIG_DIRECTORY,
  PROVIDER_LOGIN_SECURE_STORAGE_DIRECTORY,
  type ProviderCredentialLoginRunInput,
  type ProviderCredentialLoginRunResult,
  type ProviderCredentialLoginRunner,
  type ProviderCredentialLoginRunnerSecurityPolicy,
  validateProviderCredentialLoginRunnerPolicy,
} from "./providerCredentialLoginRunner.ts";
import { type Secret } from "./providerSecrets.ts";

const CODEX_DRIVER = "codex";
const CLAUDE_DRIVER = "claudeAgent";
const SAFE_CODE = /^[A-Za-z0-9]{4,16}(?:-[A-Za-z0-9]{2,16}){0,7}$/u;
const HTTPS_URL = /https:\/\/[^\s<>"']+/giu;

const hasControlCharacters = (value: string) =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
  });

export type OfficialProviderLoginDriver = typeof CODEX_DRIVER | typeof CLAUDE_DRIVER;

export interface ProviderCliExecutablePin {
  readonly path: string;
  readonly sha256: string;
}

export interface ProviderCliProfileFile {
  /** Path beneath the disposable job's isolated provider config directory. */
  readonly sourcePath: string;
  /** Path materialized beneath the worker's private credential directory. */
  readonly bundlePath: string;
  readonly required: boolean;
}

export interface ProviderCliLoginAdapterSpec {
  readonly driver: OfficialProviderLoginDriver;
  readonly method: "browser" | "deviceCode";
  readonly executable: ProviderCliExecutablePin;
  readonly arguments: ReadonlyArray<string>;
  readonly configDirectoryEnvironment: "CODEX_HOME" | "CLAUDE_CONFIG_DIR";
  readonly secureStorageDirectoryEnvironment?: "CLAUDE_SECURESTORAGE_CONFIG_DIR";
  /** Provider-specific additions to the policy's exact base environment. */
  readonly environment: Readonly<Record<string, string>>;
  readonly profileFiles: ReadonlyArray<ProviderCliProfileFile>;
  readonly allowedDomains: ReadonlySet<string>;
}

export type ProviderCliLoginJobProgress =
  | { readonly type: "authorizationUrl"; readonly authorizationUrl: string }
  | {
      readonly type: "deviceCode";
      readonly verificationUrl: string;
      readonly userCode: string;
    };

type AgentConnectionLoginEventInput =
  | { readonly type: "authorizationUrl"; readonly authorizationUrl: string }
  | { readonly type: "deviceCode"; readonly verificationUrl: string; readonly userCode: string }
  | {
      readonly type: "status";
      readonly status: "started" | "waiting" | "authorized" | "denied" | "expired" | "failed";
    };

export type ProviderCliLoginJobResult =
  | {
      readonly outcome: "authorized";
      /** Canonical profile bundle. The runner takes ownership and wipes it. */
      readonly credential: Secret<Uint8Array>;
      readonly accountLabel?: string;
    }
  | {
      readonly outcome: "denied" | "expired" | "cancelled" | "failed";
      /** Stable classification only; raw CLI output may not cross the job boundary. */
      readonly errorCode?: string;
    };

export interface ProviderCliLoginJobEnvironment {
  readonly inherit: false;
  readonly variables: Readonly<Record<string, string>>;
}

/**
 * Dedicated-job boundary. Implementations create an empty HOME/TMPDIR and
 * provider config directory, execute the exact argv without a shell, parse
 * progress inside the job, bundle only `profileFiles`, terminate the complete
 * process tree, and delete the job filesystem before resolving. `run.environment`
 * is the complete child environment; it must never be merged with `process.env`.
 */
export interface ProviderCliLoginJobExecutor {
  readonly validateConfiguration: (input: {
    readonly policy: ProviderCredentialLoginRunnerSecurityPolicy;
    readonly adapters: ReadonlyArray<ProviderCliLoginAdapterSpec>;
  }) => Effect.Effect<void, ProviderCredentialLoginRunnerError>;
  readonly run: (input: {
    readonly request: Omit<ProviderCredentialLoginRunInput, "onEvent">;
    readonly adapter: ProviderCliLoginAdapterSpec;
    readonly environment: ProviderCliLoginJobEnvironment;
    readonly onProgress: (
      progress: ProviderCliLoginJobProgress,
    ) => Effect.Effect<void, ProviderCredentialLoginRunnerError>;
  }) => Effect.Effect<ProviderCliLoginJobResult, ProviderCredentialLoginRunnerError>;
  readonly cancel: ProviderCredentialLoginRunner["cancel"];
  readonly shutdown: ProviderCredentialLoginRunner["shutdown"];
}

export const codexCliLoginAdapter = (
  executable: ProviderCliExecutablePin,
): ProviderCliLoginAdapterSpec => ({
  driver: CODEX_DRIVER,
  method: "deviceCode",
  executable,
  arguments: ["login", "--device-auth"],
  configDirectoryEnvironment: "CODEX_HOME",
  environment: { CODEX_HOME: PROVIDER_LOGIN_CONFIG_DIRECTORY },
  profileFiles: [{ sourcePath: "auth.json", bundlePath: "codex/auth.json", required: true }],
  allowedDomains: new Set(["auth.openai.com", "chatgpt.com", "openai.com"]),
});

export const claudeCliLoginAdapter = (
  executable: ProviderCliExecutablePin,
): ProviderCliLoginAdapterSpec => ({
  driver: CLAUDE_DRIVER,
  method: "browser",
  executable,
  arguments: ["auth", "login", "--claudeai"],
  configDirectoryEnvironment: "CLAUDE_CONFIG_DIR",
  secureStorageDirectoryEnvironment: "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  environment: {
    CLAUDE_CONFIG_DIR: PROVIDER_LOGIN_CONFIG_DIRECTORY,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: PROVIDER_LOGIN_SECURE_STORAGE_DIRECTORY,
  },
  profileFiles: [
    {
      sourcePath: ".credentials.json",
      bundlePath: "claude/.credentials.json",
      required: true,
    },
  ],
  allowedDomains: new Set(["claude.ai", "anthropic.com"]),
});

const copyAdapterSpec = (adapter: ProviderCliLoginAdapterSpec): ProviderCliLoginAdapterSpec => ({
  ...adapter,
  executable: { ...adapter.executable },
  arguments: [...adapter.arguments],
  environment: { ...adapter.environment },
  profileFiles: adapter.profileFiles.map((file) => ({ ...file })),
  allowedDomains: new Set(adapter.allowedDomains),
});

const copySecurityPolicy = (
  policy: ProviderCredentialLoginRunnerSecurityPolicy,
): ProviderCredentialLoginRunnerSecurityPolicy => ({
  ...policy,
  executableSha256Allowlist: new Set(policy.executableSha256Allowlist),
  allowedDomains: new Set(policy.allowedDomains),
  environment: {
    inherit: policy.environment.inherit,
    variables: { ...policy.environment.variables },
  },
});

const loginFailure = (
  code: ProviderCredentialLoginRunnerError["code"],
  operation: string,
  cause?: unknown,
) =>
  new ProviderCredentialLoginRunnerError({
    code,
    operation,
    ...(cause === undefined ? {} : { cause }),
  });

const isAllowedUrl = (value: string, allowedDomains: ReadonlySet<string>) => {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return false;
    const hostname = url.hostname.toLowerCase();
    return [...allowedDomains].some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
};

const isSafePathComponentTree = (value: string) =>
  value.length > 0 &&
  value.length <= 1024 &&
  !value.startsWith("/") &&
  !/^[A-Za-z]:[\\/]/u.test(value) &&
  !value.includes("\0") &&
  value.split(/[\\/]/u).every((part) => part !== "" && part !== "." && part !== "..");

const validateAdapterSpec = (
  adapter: ProviderCliLoginAdapterSpec,
  policy: ProviderCredentialLoginRunnerSecurityPolicy,
) =>
  Effect.suspend(() => {
    const expected =
      adapter.driver === CODEX_DRIVER
        ? codexCliLoginAdapter(adapter.executable)
        : claudeCliLoginAdapter(adapter.executable);
    const sameArguments =
      adapter.arguments.length === expected.arguments.length &&
      adapter.arguments.every((argument, index) => argument === expected.arguments[index]);
    const sameProfileFiles =
      adapter.profileFiles.length === expected.profileFiles.length &&
      adapter.profileFiles.every((file, index) => {
        const expectedFile = expected.profileFiles[index];
        return (
          expectedFile !== undefined &&
          file.sourcePath === expectedFile.sourcePath &&
          file.bundlePath === expectedFile.bundlePath &&
          file.required === expectedFile.required
        );
      });
    const expectedEnvironment = Object.entries(expected.environment);
    if (
      !NodePath.isAbsolute(adapter.executable.path) ||
      adapter.executable.path.includes("\0") ||
      !/^[0-9a-f]{64}$/u.test(adapter.executable.sha256) ||
      !policy.executableSha256Allowlist.has(adapter.executable.sha256) ||
      adapter.method !== expected.method ||
      !sameArguments ||
      adapter.configDirectoryEnvironment !== expected.configDirectoryEnvironment ||
      adapter.secureStorageDirectoryEnvironment !== expected.secureStorageDirectoryEnvironment ||
      Object.keys(adapter.environment).length !== expectedEnvironment.length ||
      expectedEnvironment.some(([name, value]) => adapter.environment[name] !== value) ||
      !sameProfileFiles ||
      adapter.profileFiles.some(
        (file) =>
          !isSafePathComponentTree(file.sourcePath) || !isSafePathComponentTree(file.bundlePath),
      ) ||
      adapter.allowedDomains.size !== expected.allowedDomains.size ||
      [...expected.allowedDomains].some((domain) => !adapter.allowedDomains.has(domain)) ||
      [...adapter.allowedDomains].some((domain) => !policy.allowedDomains.has(domain))
    ) {
      return Effect.fail(loginFailure("configurationInvalid", "validate-provider-adapter"));
    }
    return Effect.void;
  });

const sanitizeAccountLabel = (value: string | undefined) => {
  if (value === undefined) return undefined;
  const label = value.trim();
  return label.length >= 1 && label.length <= 256 && !hasControlCharacters(label)
    ? label
    : undefined;
};

const wipeCredential = (credential: Secret<Uint8Array>) =>
  Effect.sync(() => credential.withValue((bytes) => bytes.fill(0)));

const validateProgress = (
  adapter: ProviderCliLoginAdapterSpec,
  progress: ProviderCliLoginJobProgress,
) => {
  if (progress.type === "authorizationUrl") {
    return isAllowedUrl(progress.authorizationUrl, adapter.allowedDomains);
  }
  return (
    adapter.method === "deviceCode" &&
    isAllowedUrl(progress.verificationUrl, adapter.allowedDomains) &&
    SAFE_CODE.test(progress.userCode) &&
    !hasControlCharacters(progress.userCode)
  );
};

const validateProfileBundle = (
  adapter: ProviderCliLoginAdapterSpec,
  credential: Secret<Uint8Array>,
  maxProfileBytes: number,
) =>
  credential.withValue((bytes) => {
    if (
      bytes.byteLength > maxProfileBytes ||
      bytes.byteLength > MAX_PROVIDER_PROFILE_BUNDLE_BYTES
    ) {
      return false;
    }
    try {
      const bundle = decodeProviderProfileBundle(bytes);
      const allowed = new Map(adapter.profileFiles.map((file) => [file.bundlePath, file]));
      const present = new Set<string>();
      for (const file of bundle.files) {
        const descriptor = allowed.get(file.path);
        if (descriptor === undefined || present.has(file.path)) return false;
        if (descriptor.required && file.contents.byteLength < 1) return false;
        present.add(file.path);
      }
      return adapter.profileFiles.every((file) => !file.required || present.has(file.bundlePath));
    } catch {
      return false;
    }
  });

const driverAdapter = (
  adapters: ReadonlyMap<ProviderDriverKind, ProviderCliLoginAdapterSpec>,
  driver: ProviderDriverKind,
) => adapters.get(driver);

export const makeOfficialProviderCredentialLoginRunner = (input: {
  readonly policy: ProviderCredentialLoginRunnerSecurityPolicy;
  readonly executables: {
    readonly codex: ProviderCliExecutablePin;
    readonly claudeAgent: ProviderCliExecutablePin;
  };
  readonly executor: ProviderCliLoginJobExecutor;
  readonly now: Effect.Effect<string>;
}): ProviderCredentialLoginRunner => {
  const policy = copySecurityPolicy(input.policy);
  const adapterList = [
    codexCliLoginAdapter(input.executables.codex),
    claudeCliLoginAdapter(input.executables.claudeAgent),
  ] as const;
  const adapters = new Map<ProviderDriverKind, ProviderCliLoginAdapterSpec>(
    adapterList.map((adapter) => [adapter.driver as ProviderDriverKind, adapter]),
  );
  const validateConfiguration = validateProviderCredentialLoginRunnerPolicy(policy).pipe(
    Effect.andThen(Effect.forEach(adapterList, (adapter) => validateAdapterSpec(adapter, policy))),
    Effect.andThen(
      input.executor.validateConfiguration({
        policy: copySecurityPolicy(policy),
        adapters: adapterList.map(copyAdapterSpec),
      }),
    ),
  );
  const environmentFor = (
    adapter: ProviderCliLoginAdapterSpec,
  ): ProviderCliLoginJobEnvironment => ({
    inherit: false,
    variables: { ...policy.environment.variables, ...adapter.environment },
  });

  return {
    validateConfiguration,
    loginMethod: (provider) => driverAdapter(adapters, provider.driver)?.method,
    run: (
      request,
    ): Effect.Effect<ProviderCredentialLoginRunResult, ProviderCredentialLoginRunnerError> =>
      Effect.gen(function* () {
        const adapter = driverAdapter(adapters, request.provider.driver);
        if (adapter === undefined) {
          return yield* loginFailure("configurationInvalid", "unsupported-provider-driver");
        }
        yield* validateProviderCredentialLoginRunnerPolicy(policy);
        yield* validateAdapterSpec(adapter, policy);
        const startedAt = yield* input.now;
        if (request.expiresAt <= startedAt) {
          return yield* loginFailure("expired", "provider-login-expired");
        }
        let sequence = 0;
        let waitingEmitted = false;
        const emit = (
          event: AgentConnectionLoginEventInput,
        ): Effect.Effect<void, ProviderCredentialLoginRunnerError> =>
          Effect.gen(function* () {
            if (sequence >= 64) {
              return yield* loginFailure("executionFailed", "provider-login-event-limit");
            }
            const occurredAt = yield* input.now;
            const sequenced = { ...event, sequence, occurredAt } as AgentConnectionLoginEvent;
            sequence += 1;
            yield* request.onEvent(sequenced);
          });
        yield* emit({ type: "status", status: "started" });
        const result = yield* input.executor.run({
          request: {
            workspaceId: request.workspaceId,
            loginId: request.loginId,
            profileId: request.profileId,
            provider: request.provider,
            expiresAt: request.expiresAt,
          },
          adapter: copyAdapterSpec(adapter),
          environment: environmentFor(adapter),
          onProgress: (progress) =>
            Effect.gen(function* () {
              if (!validateProgress(adapter, progress)) {
                return yield* loginFailure("executionFailed", "invalid-provider-login-progress");
              }
              yield* emit(progress);
              if (!waitingEmitted) {
                waitingEmitted = true;
                yield* emit({ type: "status", status: "waiting" });
              }
            }),
        });
        const occurredAt = yield* input.now;
        if (request.expiresAt <= occurredAt) {
          if (result.outcome === "authorized") yield* wipeCredential(result.credential);
          yield* emit({ type: "status", status: "expired" });
          return {
            outcome: "expired" as const,
            errorCode: "provider_login_expired",
            occurredAt,
          } satisfies ProviderCredentialLoginRunResult;
        }
        if (result.outcome === "authorized") {
          return yield* Effect.gen(function* () {
            if (!validateProfileBundle(adapter, result.credential, policy.maxProfileBytes)) {
              return yield* loginFailure("executionFailed", "invalid-provider-profile-bundle");
            }
            yield* emit({ type: "status", status: "authorized" });
            const accountLabel = sanitizeAccountLabel(result.accountLabel);
            return {
              outcome: "authorized" as const,
              credential: result.credential,
              ...(accountLabel === undefined ? {} : { accountLabel }),
              occurredAt,
            } satisfies ProviderCredentialLoginRunResult;
          }).pipe(Effect.tapError(() => wipeCredential(result.credential)));
        }
        yield* emit({
          type: "status",
          status:
            result.outcome === "cancelled" || result.outcome === "failed"
              ? "failed"
              : result.outcome,
        });
        return {
          outcome: result.outcome,
          ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
          occurredAt,
        } satisfies ProviderCredentialLoginRunResult;
      }),
    cancel: input.executor.cancel,
    shutdown: input.executor.shutdown,
  };
};

/**
 * Parser used inside the disposable job. Raw lines are never returned to the
 * control plane. It extracts only the provider authorization URL/device code.
 */
export const makeProviderCliProgressParser = (adapter: ProviderCliLoginAdapterSpec) => {
  let verificationUrl: string | undefined;
  let userCode: string | undefined;
  let authorizationEmitted = false;
  let deviceCodeEmitted = false;
  return (line: string): ReadonlyArray<ProviderCliLoginJobProgress> => {
    if (line.length > 4_096 || hasControlCharacters(line)) return [];
    const events: Array<ProviderCliLoginJobProgress> = [];
    for (const raw of line.match(HTTPS_URL) ?? []) {
      const candidate = raw.replace(/[),.;:]+$/u, "");
      if (!isAllowedUrl(candidate, adapter.allowedDomains)) continue;
      verificationUrl ??= candidate;
      if (!authorizationEmitted) {
        authorizationEmitted = true;
        events.push({ type: "authorizationUrl", authorizationUrl: candidate });
      }
      break;
    }
    if (adapter.method === "deviceCode" && userCode === undefined) {
      const candidate = line.match(/\b[A-Z0-9]{4,16}(?:-[A-Z0-9]{2,16}){1,7}\b/u)?.[0];
      if (candidate !== undefined && SAFE_CODE.test(candidate)) userCode = candidate;
    }
    if (
      adapter.method === "deviceCode" &&
      !deviceCodeEmitted &&
      verificationUrl !== undefined &&
      userCode !== undefined
    ) {
      deviceCodeEmitted = true;
      events.push({ type: "deviceCode", verificationUrl, userCode });
    }
    return events;
  };
};
