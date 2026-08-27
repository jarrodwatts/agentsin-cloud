import { Pool, type PoolConfig, type QueryResultRow } from "pg";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ControlPlaneConfig, type ControlPlaneConfigShape } from "./config.ts";

export class DatabaseError extends Schema.TaggedErrorClass<DatabaseError>()("DatabaseError", {
  operation: Schema.String,
  cause: Schema.Unknown,
}) {}

export interface DatabaseService {
  readonly pool: Pool;
  readonly query: <Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: ReadonlyArray<unknown>,
  ) => Effect.Effect<ReadonlyArray<Row>, DatabaseError>;
  readonly ping: Effect.Effect<void, DatabaseError>;
}

export class Database extends Context.Service<Database, DatabaseService>()(
  "@agentsin-cloud/control-plane/database",
) {}

const makeQuery =
  (pool: Pool) =>
  <Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: ReadonlyArray<unknown> = [],
  ): Effect.Effect<ReadonlyArray<Row>, DatabaseError> =>
    Effect.tryPromise({
      try: async () => (await pool.query<Row>(text, [...values])).rows,
      catch: (cause) =>
        new DatabaseError({
          operation: text,
          cause,
        }),
    });

export const poolConfigFor = (
  config: Pick<ControlPlaneConfigShape, "databaseUrl" | "requestTimeoutMs">,
  options: {
    readonly applicationName?: string;
    readonly maxConnections?: number;
  } = {},
): PoolConfig => ({
  connectionString: config.databaseUrl.toString(),
  max: options.maxConnections ?? 10,
  application_name: options.applicationName ?? "agents-in-cloud-control-plane",
  // pg-pool applies this bound both while opening a connection and while a
  // saturated pool is waiting for a checked-out client to be released.
  connectionTimeoutMillis: config.requestTimeoutMs,
  query_timeout: config.requestTimeoutMs,
  statement_timeout: config.requestTimeoutMs,
});

export const make = Effect.fn("ControlPlaneDatabase.make")(function* () {
  const config = yield* ControlPlaneConfig;
  const pool = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool(poolConfigFor(config))),
    (activePool) => Effect.tryPromise(() => activePool.end()).pipe(Effect.catch(() => Effect.void)),
  );
  const query = makeQuery(pool);

  return Database.of({
    pool,
    query,
    ping: query<{ ok: number }>("SELECT 1 AS ok").pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(Database, make());
