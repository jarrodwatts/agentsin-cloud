import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

const isPrivateHost = (hostname: string) => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1" || normalized.endsWith(".internal")) {
    return true;
  }
  if (/^127(?:\.\d{1,3}){3}$/u.test(normalized)) return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(normalized);
  if (match === null) return false;
  const octets = match.slice(1).map(Number);
  return (
    octets.every((value) => value <= 255) &&
    (octets[0] === 10 ||
      (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
      (octets[0] === 192 && octets[1] === 168))
  );
};

const validAuthField = (value: string) => {
  if (value.length > 512) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return false;
  }
  return true;
};

const valkeyUrlProblem = (url: URL): string | undefined => {
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    return "VALKEY_URL must use the redis or rediss scheme";
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    return "VALKEY_URL must not contain query parameters or a fragment";
  }
  if (url.hostname.length === 0) return "VALKEY_URL must contain a hostname";
  if (url.port === "0") return "VALKEY_URL port must be between 1 and 65535";
  if (url.protocol === "redis:" && !isPrivateHost(url.hostname)) {
    return "plaintext VALKEY_URL is allowed only for private or loopback hosts";
  }
  let username: string;
  let password: string;
  try {
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    return "VALKEY_URL contains malformed authentication encoding";
  }
  if (!validAuthField(username) || !validAuthField(password)) {
    return "VALKEY_URL contains unsafe authentication fields";
  }
  if (username.length > 0 && password.length === 0) {
    return "VALKEY_URL usernames require a password";
  }
  if (url.pathname !== "" && url.pathname !== "/" && !/^\/(?:[0-9]|1[0-5])$/u.test(url.pathname)) {
    return "VALKEY_URL database must be an integer from 0 through 15";
  }
  return undefined;
};

const Namespace = Schema.Trimmed.check(
  Schema.isLengthBetween(3, 48),
  Schema.isPattern(/^[a-z0-9][a-z0-9_-]*$/),
);

const Timeout = Schema.Int.check(Schema.isBetween({ minimum: 250, maximum: 30_000 }));

export interface ValkeyConfigShape {
  readonly host: string;
  readonly port: number;
  readonly username?: string;
  readonly password?: string;
  readonly database: number;
  readonly tls: boolean;
  readonly namespace: string;
  readonly connectTimeoutMs: number;
  readonly commandTimeoutMs: number;
}

export class ValkeyConfig extends Context.Service<ValkeyConfig, ValkeyConfigShape>()(
  "@agentsin-cloud/control-plane/valkeyConfig",
) {}

const rawConfig = Config.all({
  url: Config.nonEmptyString("VALKEY_URL"),
  namespace: Config.schema(Namespace, "VALKEY_NAMESPACE").pipe(
    Config.withDefault("agents-in-cloud"),
  ),
  connectTimeoutMs: Config.schema(Timeout, "VALKEY_CONNECT_TIMEOUT_MS").pipe(
    Config.withDefault(5_000),
  ),
  commandTimeoutMs: Config.schema(Timeout, "VALKEY_COMMAND_TIMEOUT_MS").pipe(
    Config.withDefault(2_000),
  ),
});

const invalid = (message: string) =>
  Effect.fail(
    new Config.ConfigError(new Schema.SchemaError(new SchemaIssue.InvalidValue({ message }))),
  );

export const envConfig = rawConfig.pipe(
  Config.mapOrFail(({ url: rawUrl, ...config }) => {
    if (rawUrl.includes("?") || rawUrl.includes("#")) {
      return invalid("VALKEY_URL must not contain query parameters or a fragment");
    }
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return invalid("VALKEY_URL must be a valid URL");
    }
    const problem = valkeyUrlProblem(url);
    if (problem !== undefined) return invalid(problem);
    return Effect.succeed<ValkeyConfigShape>({
      ...config,
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port: url.port.length === 0 ? 6379 : Number(url.port),
      ...(url.username.length === 0 ? {} : { username: decodeURIComponent(url.username) }),
      ...(url.password.length === 0 ? {} : { password: decodeURIComponent(url.password) }),
      database: url.pathname === "" || url.pathname === "/" ? 0 : Number(url.pathname.slice(1)),
      tls: url.protocol === "rediss:",
    });
  }),
);

const compactEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

export const fromEnv = (env: Readonly<Record<string, string | undefined>>) =>
  envConfig.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: compactEnv(env) }))),
  );

export const layer = Layer.effect(ValkeyConfig, envConfig);

export const layerFromEnv = (env: Readonly<Record<string, string | undefined>>) =>
  Layer.effect(ValkeyConfig, fromEnv(env));
