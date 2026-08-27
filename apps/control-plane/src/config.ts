import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

const AuthSecret = Schema.Trimmed.check(
  Schema.isMinLength(32, {
    message: "Authentication secrets must contain at least 32 characters",
  }),
);

const NonEmptyString = Schema.Trimmed.check(Schema.isNonEmpty());

const PostgresUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    url.protocol === "postgres:" || url.protocol === "postgresql:"
      ? true
      : "DATABASE_URL must use the postgres or postgresql scheme",
  ),
);

const BetterAuthUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) => {
    if (url.username.length > 0 || url.password.length > 0) {
      return "BETTER_AUTH_URL must not contain credentials";
    }
    if (url.pathname !== "/" || url.search.length > 0 || url.hash.length > 0) {
      return "BETTER_AUTH_URL must be an origin without a path, query, or fragment";
    }
    return url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost")
      ? true
      : "BETTER_AUTH_URL must use HTTPS (HTTP is allowed only for localhost)";
  }),
);

const DesktopAuthCallbackUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) => {
    if (url.protocol !== "agentsincloud:" && url.protocol !== "agentsincloud-dev:") {
      return "DESKTOP_AUTH_CALLBACK_URL must use the agentsincloud or agentsincloud-dev scheme";
    }
    return url.hostname === "auth" &&
      url.pathname === "/callback" &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.port.length === 0 &&
      url.search.length === 0 &&
      url.hash.length === 0
      ? true
      : "DESKTOP_AUTH_CALLBACK_URL must be exactly an auth callback without credentials, port, query, or fragment";
  }),
);

const RequestBodyLimit = Schema.Int.check(
  Schema.isBetween({ minimum: 1_024, maximum: 8 * 1_024 * 1_024 }),
);
const RequestTimeout = Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 120_000 }));
const HandoffTtl = Schema.Int.check(Schema.isBetween({ minimum: 60, maximum: 300 }));

export interface ControlPlaneConfigShape {
  readonly port: number;
  readonly host: string;
  readonly databaseUrl: URL;
  readonly betterAuthSecret: string;
  readonly betterAuthUrl: URL;
  readonly githubClientId: string;
  readonly githubClientSecret: string;
  readonly passkeyRpId: string;
  readonly passkeyRpName: string;
  readonly desktopAuthCallbackUrl: URL;
  readonly desktopAuthHandoffSecret: string;
  readonly desktopAuthHandoffTtlSeconds: number;
  readonly maxRequestBodyBytes: number;
  readonly requestTimeoutMs: number;
  readonly headersTimeoutMs: number;
}

export class ControlPlaneConfig extends Context.Service<
  ControlPlaneConfig,
  ControlPlaneConfigShape
>()("@agentsin-cloud/control-plane/config/ControlPlaneConfig") {}

/**
 * Configuration is intentionally strict: a Railway deployment must fail at
 * boot when auth or database configuration is missing instead of starting a
 * process that cannot create sessions safely.
 */
const baseEnvConfig = Config.all({
  port: Config.port("PORT").pipe(Config.withDefault(8787)),
  host: Config.schema(NonEmptyString, "HOST").pipe(Config.withDefault("0.0.0.0")),
  databaseUrl: Config.schema(PostgresUrl, "DATABASE_URL"),
  betterAuthSecret: Config.schema(AuthSecret, "BETTER_AUTH_SECRET"),
  betterAuthUrl: Config.schema(BetterAuthUrl, "BETTER_AUTH_URL"),
  githubClientId: Config.schema(NonEmptyString, "GITHUB_CLIENT_ID"),
  githubClientSecret: Config.schema(NonEmptyString, "GITHUB_CLIENT_SECRET"),
  desktopAuthCallbackUrl: Config.schema(DesktopAuthCallbackUrl, "DESKTOP_AUTH_CALLBACK_URL"),
  desktopAuthHandoffSecret: Config.schema(AuthSecret, "DESKTOP_AUTH_HANDOFF_SECRET"),
  desktopAuthHandoffTtlSeconds: Config.schema(HandoffTtl, "DESKTOP_AUTH_HANDOFF_TTL_SECONDS").pipe(
    Config.withDefault(120),
  ),
  maxRequestBodyBytes: Config.schema(RequestBodyLimit, "MAX_REQUEST_BODY_BYTES").pipe(
    Config.withDefault(1_024 * 1_024),
  ),
  requestTimeoutMs: Config.schema(RequestTimeout, "REQUEST_TIMEOUT_MS").pipe(
    Config.withDefault(15_000),
  ),
  headersTimeoutMs: Config.schema(RequestTimeout, "HEADERS_TIMEOUT_MS").pipe(
    Config.withDefault(10_000),
  ),
  passkeyRpName: Config.schema(NonEmptyString, "PASSKEY_RP_NAME").pipe(
    Config.withDefault("Agents in Cloud"),
  ),
});

const validatedEnvConfig = baseEnvConfig.pipe(
  Config.mapOrFail((config) => {
    const invalid = (message: string) =>
      Effect.fail(
        new Config.ConfigError(new Schema.SchemaError(new SchemaIssue.InvalidValue({ message }))),
      );
    if (config.headersTimeoutMs > config.requestTimeoutMs) {
      return invalid("HEADERS_TIMEOUT_MS must not exceed REQUEST_TIMEOUT_MS");
    }
    if (config.desktopAuthHandoffSecret === config.betterAuthSecret) {
      return invalid("DESKTOP_AUTH_HANDOFF_SECRET must be distinct from BETTER_AUTH_SECRET");
    }
    return Effect.succeed(config);
  }),
);

export const envConfig = validatedEnvConfig.pipe(
  Config.map(
    (config): ControlPlaneConfigShape => ({
      ...config,
      passkeyRpId: config.betterAuthUrl.hostname,
    }),
  ),
);

const compactEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

export const fromEnv = (env: Readonly<Record<string, string | undefined>>) =>
  envConfig.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: compactEnv(env) }))),
  );

export const layer = Layer.effect(ControlPlaneConfig, envConfig);

export const layerFromEnv = (env: Readonly<Record<string, string | undefined>>) =>
  Layer.effect(ControlPlaneConfig, fromEnv(env));
