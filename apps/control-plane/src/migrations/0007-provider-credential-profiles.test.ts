// @effect-diagnostics nodeBuiltinImport:off -- This focused test reads a checked-in SQL migration.
import * as NodeFSP from "node:fs/promises";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

it.effect("stores only envelope-encrypted provider profiles and cleanup metadata", () =>
  Effect.gen(function* () {
    const sql = yield* Effect.promise(() =>
      NodeFSP.readFile(new URL("./0007-provider-credential-profiles.sql", import.meta.url), "utf8"),
    );
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS provider_credential_profile");
    expect(sql).toContain("wrapped_dek bytea NOT NULL");
    expect(sql).toContain("ciphertext bytea NOT NULL");
    expect(sql).toContain("UNIQUE (workspace_id, provider_instance_id, idempotency_key)");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS provider_credential_materialization");
    expect(sql).toContain("provider_credential_live_profile_sandbox_idx");
    expect(sql).toContain("profile_generation");
    expect(sql).toContain("provider_credential_login_audit_daily");
    expect(sql).toContain("provider_credential_login_retention_idx");
    expect(sql).toContain("login_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'");
    expect(sql).toContain("materialization_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'");
    expect(sql).toContain("profile_id text NOT NULL");
    expect(sql).toContain("key_version text");
    expect(sql).toContain("ciphertext bytea");
    expect(sql).toContain(
      "num_nonnulls(key_version, wrapped_dek, nonce, auth_tag, ciphertext) = 5",
    );
    expect(sql).not.toContain("payload_sha256");
    const ddl = sql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(ddl).not.toMatch(/plaintext|private_key|access_token|refresh_token/);
  }),
);
