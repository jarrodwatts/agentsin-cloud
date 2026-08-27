import { expect, it } from "@effect/vitest";

import { poolConfigFor } from "./database.ts";

it("bounds PostgreSQL acquisition and execution by one validated deadline", () => {
  const config = {
    databaseUrl: new URL("postgresql://localhost/agents_in_cloud"),
    requestTimeoutMs: 15_000,
  };
  const runtime = poolConfigFor(config);
  const migration = poolConfigFor(config, {
    maxConnections: 1,
    applicationName: "agents-in-cloud-control-plane-migrate",
  });

  for (const options of [runtime, migration]) {
    expect(options.connectionTimeoutMillis).toBe(config.requestTimeoutMs);
    expect(options.query_timeout).toBe(config.requestTimeoutMs);
    expect(options.statement_timeout).toBe(config.requestTimeoutMs);
  }
  expect(runtime.max).toBe(10);
  expect(migration.max).toBe(1);
});
