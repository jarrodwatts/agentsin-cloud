import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

const AccountId = Schema.Trimmed.check(
  Schema.isPattern(/^[0-9a-f]{32}$/),
  Schema.isLengthBetween(32, 32),
);
const BucketName = Schema.Trimmed.check(
  Schema.isLengthBetween(3, 63),
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/),
);
const AccessKey = Schema.Trimmed.check(Schema.isLengthBetween(16, 128));
const SecretKey = Schema.Trimmed.check(Schema.isLengthBetween(32, 256));
const MaxArtifactBytes = Schema.Int.check(
  Schema.isBetween({ minimum: 1_024, maximum: 64 * 1_024 * 1_024 }),
);
const RequestTimeout = Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 120_000 }));

const R2Endpoint = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    url.protocol === "https:" &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.port.length === 0 &&
    url.pathname === "/" &&
    url.search.length === 0 &&
    url.hash.length === 0
      ? true
      : "R2_ENDPOINT must be a credential-free HTTPS origin",
  ),
);

export interface R2ArtifactConfigShape {
  readonly accountId: string;
  readonly endpoint: URL;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: "auto";
  readonly maxArtifactBytes: number;
  readonly requestTimeoutMs: number;
}

export class R2ArtifactConfig extends Context.Service<R2ArtifactConfig, R2ArtifactConfigShape>()(
  "@agentsin-cloud/control-plane/artifactConfig/R2ArtifactConfig",
) {}

const envConfig = Config.all({
  accountId: Config.schema(AccountId, "R2_ACCOUNT_ID"),
  endpoint: Config.schema(R2Endpoint, "R2_ENDPOINT"),
  bucket: Config.schema(BucketName, "R2_ARTIFACT_BUCKET"),
  accessKeyId: Config.schema(AccessKey, "R2_ACCESS_KEY_ID"),
  secretAccessKey: Config.schema(SecretKey, "R2_SECRET_ACCESS_KEY"),
  maxArtifactBytes: Config.schema(MaxArtifactBytes, "R2_MAX_ARTIFACT_BYTES").pipe(
    Config.withDefault(16 * 1_024 * 1_024),
  ),
  requestTimeoutMs: Config.schema(RequestTimeout, "R2_REQUEST_TIMEOUT_MS").pipe(
    Config.withDefault(30_000),
  ),
}).pipe(
  Config.mapOrFail((config) => {
    const expectedHost = `${config.accountId}.r2.cloudflarestorage.com`;
    if (config.endpoint.hostname !== expectedHost) {
      return Effect.fail(
        new Config.ConfigError(
          new Schema.SchemaError(
            new SchemaIssue.InvalidValue({
              message: `R2_ENDPOINT must use the configured account host ${expectedHost}`,
            }),
          ),
        ),
      );
    }
    return Effect.succeed({ ...config, region: "auto" as const });
  }),
);

const compactEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

/** Hosted composition has no credential-chain or in-memory fallback. */
export const r2ConfigFromEnv = (env: Readonly<Record<string, string | undefined>>) =>
  envConfig.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: compactEnv(env) }))),
  );

export const r2ArtifactConfigLayer = Layer.effect(R2ArtifactConfig, envConfig);

export const r2ArtifactConfigLayerFromEnv = (env: Readonly<Record<string, string | undefined>>) =>
  Layer.effect(R2ArtifactConfig, r2ConfigFromEnv(env));
