// @effect-diagnostics nodeBuiltinImport:off -- Focused migration test reads the adjacent SQL artifact.
import * as NodeFSP from "node:fs/promises";

import { describe, expect, it } from "vite-plus/test";

const migration = await NodeFSP.readFile(
  new URL("./0015-e2b-template-identity.sql", import.meta.url),
  "utf8",
);

describe("0015 immutable E2B template identity migration", () => {
  it("requires provider-native template and build identities on every reservation", () => {
    expect(migration).toContain("provider_template_id text");
    expect(migration).toContain("provider_build_id text");
    expect(migration).toContain("provider_template_id SET NOT NULL");
    expect(migration).toContain("provider_build_id SET NOT NULL");
    expect(migration).toContain("cloud_e2b_provider_build_id_format");
  });
});
