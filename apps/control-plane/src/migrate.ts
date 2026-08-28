// @effect-diagnostics nodeBuiltinImport:off -- The migration entrypoint loads a checked-in SQL asset before bootstrapping Better Auth.
// @effect-diagnostics globalConsole:off -- This process boundary must report startup failure before setting a nonzero exit code.
import * as NodeFSP from "node:fs/promises";

import { getMigrations } from "better-auth/db/migration";
import { Effect } from "effect";
import { Pool } from "pg";

import { makeAuth } from "./auth.ts";
import { fromEnv } from "./config.ts";
import { poolConfigFor } from "./database.ts";

const migrate = async () => {
  const config = await Effect.runPromise(fromEnv(process.env));
  const pool = new Pool(
    poolConfigFor(config, {
      maxConnections: 1,
      applicationName: "agents-in-cloud-control-plane-migrate",
    }),
  );

  try {
    const auth = makeAuth({
      config,
      pool,
      onUserCreated: async () => undefined,
    });
    const migrationPlan = await getMigrations(auth.options);
    await migrationPlan.runMigrations();

    const applicationMigrations = [
      "0001-workspaces.sql",
      "0002-cloud-thread-store.sql",
      "0003-thread-integrity-locks.sql",
      "0004-cloud-thread-lifecycle.sql",
      "0005-worker-mtls.sql",
      "0006-github-thread-workflow.sql",
      "0007-provider-credential-profiles.sql",
      "0008-thread-route-generation.sql",
      "0009-github-worker-route-binding.sql",
      "0010-artifact-storage.sql",
      "0011-desktop-leases.sql",
      "0012-user-wallets.sql",
    ];
    for (const filename of applicationMigrations) {
      const migration = await NodeFSP.readFile(
        new URL(`./migrations/${filename}`, import.meta.url),
        "utf8",
      );
      await pool.query(migration);
    }
  } finally {
    await pool.end();
  }
};

await migrate().catch((cause: unknown) => {
  console.error("Control-plane migration failed", cause);
  process.exitCode = 1;
});
