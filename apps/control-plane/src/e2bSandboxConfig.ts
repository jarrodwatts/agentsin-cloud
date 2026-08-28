import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const ApiKey = Schema.Trimmed.check(
  Schema.isLengthBetween(16, 512),
  Schema.makeFilter((value) =>
    /[\u0000-\u001f\u007f]/.test(value) ? "E2B_API_KEY must not contain control characters" : true,
  ),
);

const ActiveTimeout = Schema.Int.check(
  Schema.isBetween({ minimum: 60_000, maximum: 24 * 60 * 60 * 1_000 }),
);

export interface E2bSandboxConfigShape {
  readonly apiKey: string;
  readonly activeTimeoutMs: number;
}

export class E2bSandboxConfig extends Context.Service<E2bSandboxConfig, E2bSandboxConfigShape>()(
  "@agentsin-cloud/control-plane/e2bSandboxConfig",
) {}

const envConfig = Config.all({
  apiKey: Config.schema(ApiKey, "E2B_API_KEY"),
  activeTimeoutMs: Config.schema(ActiveTimeout, "E2B_ACTIVE_TIMEOUT_MS").pipe(
    Config.withDefault(15 * 60 * 1_000),
  ),
});

const compactEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

/** Hosted E2B configuration is required; there is no development or fake-compute fallback. */
export const e2bSandboxConfigFromEnv = (env: Readonly<Record<string, string | undefined>>) =>
  envConfig.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: compactEnv(env) }))),
  );

export const e2bSandboxConfigLayer = Layer.effect(E2bSandboxConfig, envConfig);

export const e2bSandboxConfigLayerFromEnv = (env: Readonly<Record<string, string | undefined>>) =>
  Layer.effect(E2bSandboxConfig, e2bSandboxConfigFromEnv(env));
