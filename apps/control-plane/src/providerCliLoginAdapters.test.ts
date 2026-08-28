import type { ProviderInstanceRef } from "@t3tools/contracts";
import type {
  AgentConnectionLoginEvent,
  AgentLoginId,
  AgentProfileId,
  WorkspaceId,
} from "@t3tools/contracts/cloud";
import { encodeProviderProfileBundle } from "@t3tools/contracts/provider-profile-bundle";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import {
  claudeCliLoginAdapter,
  codexCliLoginAdapter,
  makeOfficialProviderCredentialLoginRunner,
  makeProviderCliProgressParser,
  type ProviderCliLoginJobExecutor,
} from "./providerCliLoginAdapters.ts";
import type { ProviderCredentialLoginRunnerSecurityPolicy } from "./providerCredentialLoginRunner.ts";
import {
  PROVIDER_LOGIN_CONFIG_DIRECTORY,
  PROVIDER_LOGIN_HOME,
  PROVIDER_LOGIN_SECURE_STORAGE_DIRECTORY,
  PROVIDER_LOGIN_TMPDIR,
} from "./providerCredentialLoginRunner.ts";
import { Secret } from "./providerSecrets.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111" as WorkspaceId;
const loginId = "login-a" as AgentLoginId;
const profileId = "profile-a" as AgentProfileId;
const now = "2026-08-27T12:00:00.000Z";
const expiresAt = "2026-08-27T12:15:00.000Z";
const codexSha = "a".repeat(64);
const claudeSha = "b".repeat(64);

const policy = (): ProviderCredentialLoginRunnerSecurityPolicy => ({
  isolationMode: "dedicated-container",
  emptyHome: true,
  repositoryMounts: 0,
  credentialMounts: 0,
  dropSupplementaryGroups: true,
  maxRuntimeMs: 15 * 60_000,
  maxOutputBytes: 64 * 1024,
  maxProfileBytes: 1024 * 1024,
  maxConcurrentRuns: 8,
  executableSha256Allowlist: new Set([codexSha, claudeSha]),
  allowedDomains: new Set([
    "auth.openai.com",
    "chatgpt.com",
    "openai.com",
    "claude.ai",
    "anthropic.com",
  ]),
  environment: {
    inherit: false,
    variables: {
      HOME: PROVIDER_LOGIN_HOME,
      TMPDIR: PROVIDER_LOGIN_TMPDIR,
      PATH: "/opt/agentsin/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      NO_COLOR: "1",
    },
  },
});

const provider = (driver: "codex" | "claudeAgent"): ProviderInstanceRef =>
  ({
    instanceId: `${driver}_work`,
    driver,
  }) as ProviderInstanceRef;

const request = (driver: "codex" | "claudeAgent", events: Array<AgentConnectionLoginEvent>) => ({
  workspaceId,
  loginId,
  profileId,
  provider: provider(driver),
  expiresAt,
  onEvent: (event: AgentConnectionLoginEvent) =>
    Effect.sync(() => {
      events.push(event);
    }),
});

const executor = (
  run: ProviderCliLoginJobExecutor["run"],
  validateConfiguration: ProviderCliLoginJobExecutor["validateConfiguration"] = () => Effect.void,
): ProviderCliLoginJobExecutor => ({
  validateConfiguration,
  run,
  cancel: () => Effect.void,
  shutdown: Effect.void,
});

const runner = (
  job: ProviderCliLoginJobExecutor,
  override?: {
    readonly policy?: ReturnType<typeof policy>;
    readonly now?: Effect.Effect<string>;
  },
) =>
  makeOfficialProviderCredentialLoginRunner({
    policy: override?.policy ?? policy(),
    executables: {
      codex: { path: "/opt/agentsin/bin/codex", sha256: codexSha },
      claudeAgent: { path: "/opt/agentsin/bin/claude", sha256: claudeSha },
    },
    executor: job,
    now: override?.now ?? Effect.succeed(now),
  });

it.effect("pins the exact official Codex and Claude subscription login jobs", () =>
  Effect.gen(function* () {
    const observed: Array<ReadonlyArray<string>> = [];
    const loginRunner = runner(
      executor(
        () => Effect.succeed({ outcome: "denied" as const }),
        ({ adapters }) =>
          Effect.sync(() => {
            observed.push(adapters[0]!.arguments, adapters[1]!.arguments);
            expect(adapters[0]).toMatchObject({
              driver: "codex",
              method: "deviceCode",
              configDirectoryEnvironment: "CODEX_HOME",
              profileFiles: [
                { sourcePath: "auth.json", bundlePath: "codex/auth.json", required: true },
              ],
            });
            expect(adapters[1]).toMatchObject({
              driver: "claudeAgent",
              method: "browser",
              configDirectoryEnvironment: "CLAUDE_CONFIG_DIR",
              secureStorageDirectoryEnvironment: "CLAUDE_SECURESTORAGE_CONFIG_DIR",
            });
          }),
      ),
    );

    yield* loginRunner.validateConfiguration;
    expect(loginRunner.loginMethod(provider("codex"))).toBe("deviceCode");
    expect(loginRunner.loginMethod(provider("claudeAgent"))).toBe("browser");
    expect(
      loginRunner.loginMethod({
        instanceId: "cursor_work",
        driver: "cursor",
      } as ProviderInstanceRef),
    ).toBeUndefined();
    expect(observed).toEqual([
      ["login", "--device-auth"],
      ["auth", "login", "--claudeai"],
    ]);
  }),
);

it.effect("accepts only Claude Code's isolated credential profile files", () =>
  Effect.gen(function* () {
    const events: Array<AgentConnectionLoginEvent> = [];
    const credentialBytes = encodeProviderProfileBundle([
      {
        path: "claude/.credentials.json",
        contents: Buffer.from('{"claudeAiOauth":"opaque"}'),
      },
    ]);
    const loginRunner = runner(
      executor(({ adapter, environment, onProgress }) =>
        Effect.gen(function* () {
          expect(adapter.arguments).toEqual(["auth", "login", "--claudeai"]);
          expect(adapter.configDirectoryEnvironment).toBe("CLAUDE_CONFIG_DIR");
          expect(adapter.secureStorageDirectoryEnvironment).toBe("CLAUDE_SECURESTORAGE_CONFIG_DIR");
          expect(environment).toEqual({
            inherit: false,
            variables: {
              HOME: PROVIDER_LOGIN_HOME,
              TMPDIR: PROVIDER_LOGIN_TMPDIR,
              PATH: "/opt/agentsin/bin:/usr/bin:/bin",
              LANG: "C.UTF-8",
              LC_ALL: "C.UTF-8",
              NO_COLOR: "1",
              CLAUDE_CONFIG_DIR: PROVIDER_LOGIN_CONFIG_DIRECTORY,
              CLAUDE_SECURESTORAGE_CONFIG_DIR: PROVIDER_LOGIN_SECURE_STORAGE_DIRECTORY,
            },
          });
          yield* onProgress({
            type: "authorizationUrl",
            authorizationUrl: "https://claude.ai/oauth/authorize?state=opaque",
          });
          return {
            outcome: "authorized" as const,
            credential: Secret.make<Uint8Array>(credentialBytes),
          };
        }),
      ),
    );

    const result = yield* loginRunner.run(request("claudeAgent", events));
    expect(result.outcome).toBe("authorized");
    expect(events.map((event) => event.type)).toEqual([
      "status",
      "authorizationUrl",
      "status",
      "status",
    ]);
    expect(events.at(-1)).toMatchObject({ status: "authorized" });
  }),
);

it.effect("fails startup when a provider digest or required egress domain is not pinned", () =>
  Effect.gen(function* () {
    const validPolicy = policy();
    const invalidPolicy = {
      ...validPolicy,
      executableSha256Allowlist: new Set([codexSha]),
      allowedDomains: new Set(
        [...validPolicy.allowedDomains].filter((domain) => domain !== "claude.ai"),
      ),
    };
    const result = yield* Effect.result(
      runner(
        executor(() => Effect.succeed({ outcome: "failed" as const })),
        {
          policy: invalidPolicy,
        },
      ).validateConfiguration,
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.code).toBe("configurationInvalid");
  }),
);

it.effect("keeps the runner environment exact when an executor mutates its validation copy", () =>
  Effect.gen(function* () {
    const loginRunner = runner(
      executor(
        ({ environment }) =>
          Effect.sync(() => {
            expect(environment.inherit).toBe(false);
            expect(environment.variables.OPENAI_API_KEY).toBeUndefined();
            expect(environment.variables.OPENAI_BASE_URL).toBeUndefined();
            expect(Object.keys(environment.variables).sort()).toEqual([
              "CODEX_HOME",
              "HOME",
              "LANG",
              "LC_ALL",
              "NO_COLOR",
              "PATH",
              "TMPDIR",
            ]);
            return { outcome: "denied" as const };
          }),
        ({ policy: validationPolicy, adapters }) =>
          Effect.sync(() => {
            (validationPolicy.environment.variables as Record<string, string>).OPENAI_API_KEY =
              "must-not-cross";
            (adapters[0]!.environment as Record<string, string>).OPENAI_BASE_URL =
              "https://evil.example";
          }),
      ),
    );

    yield* loginRunner.validateConfiguration;
    const result = yield* loginRunner.run(request("codex", []));
    expect(result.outcome).toBe("denied");
  }),
);

it("extracts only allowlisted structured progress inside the credential job", () => {
  const codex = makeProviderCliProgressParser(
    codexCliLoginAdapter({ path: "/bin/codex", sha256: codexSha }),
  );
  expect(codex("Open https://auth.openai.com/codex/device in your browser")).toEqual([
    {
      type: "authorizationUrl",
      authorizationUrl: "https://auth.openai.com/codex/device",
    },
  ]);
  expect(codex("Enter code ABCD-EFGH")).toEqual([
    {
      type: "deviceCode",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
    },
  ]);
  expect(codex("secret Bearer abc https://evil.example/steal")).toEqual([]);

  const claude = makeProviderCliProgressParser(
    claudeCliLoginAdapter({ path: "/bin/claude", sha256: claudeSha }),
  );
  expect(claude("Continue at https://claude.ai/oauth/authorize?code=opaque")).toEqual([
    {
      type: "authorizationUrl",
      authorizationUrl: "https://claude.ai/oauth/authorize?code=opaque",
    },
  ]);
  expect(claude("\u001b[31mhttps://claude.ai/unsafe\u001b[0m")).toEqual([]);
});

it.effect("relays sanitized Codex device progress and returns only an allowed opaque profile", () =>
  Effect.gen(function* () {
    const events: Array<AgentConnectionLoginEvent> = [];
    const credentialBytes = encodeProviderProfileBundle([
      { path: "codex/auth.json", contents: Buffer.from('{"tokens":"opaque"}') },
    ]);
    const loginRunner = runner(
      executor(({ adapter, environment, onProgress }) =>
        Effect.gen(function* () {
          expect(adapter.arguments).toEqual(["login", "--device-auth"]);
          expect(environment).toEqual({
            inherit: false,
            variables: {
              HOME: PROVIDER_LOGIN_HOME,
              TMPDIR: PROVIDER_LOGIN_TMPDIR,
              PATH: "/opt/agentsin/bin:/usr/bin:/bin",
              LANG: "C.UTF-8",
              LC_ALL: "C.UTF-8",
              NO_COLOR: "1",
              CODEX_HOME: PROVIDER_LOGIN_CONFIG_DIRECTORY,
            },
          });
          yield* onProgress({
            type: "authorizationUrl",
            authorizationUrl: "https://auth.openai.com/codex/device",
          });
          yield* onProgress({
            type: "deviceCode",
            verificationUrl: "https://auth.openai.com/codex/device",
            userCode: "ABCD-EFGH",
          });
          return {
            outcome: "authorized" as const,
            credential: Secret.make<Uint8Array>(credentialBytes),
            accountLabel: "Work account",
          };
        }),
      ),
    );

    const result = yield* loginRunner.run(request("codex", events));
    expect(result.outcome).toBe("authorized");
    expect(events.map((event) => [event.sequence, event.type])).toEqual([
      [0, "status"],
      [1, "authorizationUrl"],
      [2, "status"],
      [3, "deviceCode"],
      [4, "status"],
    ]);
    expect(events.at(-1)).toMatchObject({ status: "authorized" });
    expect(result).toMatchObject({ accountLabel: "Work account", occurredAt: now });
  }),
);

it.effect("expires and wipes an authorization completed exactly at the clock boundary", () =>
  Effect.gen(function* () {
    const events: Array<AgentConnectionLoginEvent> = [];
    const lateCredential = encodeProviderProfileBundle([
      { path: "codex/auth.json", contents: Buffer.from('{"tokens":"too-late"}') },
    ]);
    const timestamps = [
      "2026-08-27T12:00:00.000Z",
      "2026-08-27T12:00:00.001Z",
      expiresAt,
      expiresAt,
    ];
    const loginRunner = runner(
      executor(() =>
        Effect.succeed({
          outcome: "authorized" as const,
          credential: Secret.make<Uint8Array>(lateCredential),
        }),
      ),
      {
        now: Effect.sync(() => timestamps.shift() ?? expiresAt),
      },
    );

    const result = yield* loginRunner.run(request("codex", events));
    expect(result).toMatchObject({
      outcome: "expired",
      errorCode: "provider_login_expired",
      occurredAt: expiresAt,
    });
    expect(events).toMatchObject([
      { type: "status", status: "started" },
      { type: "status", status: "expired" },
    ]);
    expect(events.some((event) => event.type === "status" && event.status === "authorized")).toBe(
      false,
    );
    expect([...lateCredential]).toEqual(Array.from({ length: lateCredential.length }, () => 0));
  }),
);

it.effect("rejects unexpected profile files and zeroizes the rejected job result", () =>
  Effect.gen(function* () {
    const leaked = encodeProviderProfileBundle([
      { path: "codex/auth.json", contents: Buffer.from("opaque") },
      { path: "codex/config.toml", contents: Buffer.from("must-not-copy") },
    ]);
    const result = yield* Effect.result(
      runner(
        executor(() =>
          Effect.succeed({
            outcome: "authorized" as const,
            credential: Secret.make<Uint8Array>(leaked),
          }),
        ),
      ).run(request("codex", [])),
    );
    expect(Result.isFailure(result)).toBe(true);
    expect([...leaked]).toEqual(Array.from({ length: leaked.length }, () => 0));
  }),
);

it.effect("fails closed for unsupported providers and malicious progress", () =>
  Effect.gen(function* () {
    const unsupported = yield* Effect.result(
      runner(executor(() => Effect.succeed({ outcome: "failed" as const }))).run({
        ...request("codex", []),
        provider: { instanceId: "cursor_work", driver: "cursor" } as ProviderInstanceRef,
      }),
    );
    expect(Result.isFailure(unsupported)).toBe(true);

    const malicious = yield* Effect.result(
      runner(
        executor(({ adapter, onProgress }) =>
          Effect.sync(() => {
            (adapter.allowedDomains as Set<string>).add("evil.example");
          }).pipe(
            Effect.andThen(
              onProgress({
                type: "authorizationUrl",
                authorizationUrl: "https://evil.example/login",
              }),
            ),
            Effect.as({ outcome: "failed" as const }),
          ),
        ),
      ).run(request("claudeAgent", [])),
    );
    expect(Result.isFailure(malicious)).toBe(true);
  }),
);
