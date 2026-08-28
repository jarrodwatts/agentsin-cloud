// @effect-diagnostics nodeBuiltinImport:off -- This test keeps the checked-in CI command aligned with PostgreSQL suites.
import * as NodeFSP from "node:fs/promises";

import { expect, it } from "vite-plus/test";

const workflow = await NodeFSP.readFile(
  new URL("../../../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);
const sourceFiles = await NodeFSP.readdir(new URL("./", import.meta.url), {
  recursive: true,
});

it("runs every control-plane PostgreSQL suite in the real-adapter CI job", () => {
  const jobStart = workflow.indexOf("  test_control_plane_coordination:");
  const jobEnd = workflow.indexOf("\n  test_server:", jobStart);
  expect(jobStart).toBeGreaterThanOrEqual(0);
  expect(jobEnd).toBeGreaterThan(jobStart);
  const job = workflow.slice(jobStart, jobEnd);
  expect(job).toContain("AGENTSIN_TEST_POSTGRES_URL:");

  const discovered = sourceFiles
    .filter((filename) => filename.endsWith(".postgres.test.ts"))
    .map((filename) => `src/${filename}`)
    .sort();
  const configured = [...job.matchAll(/src\/[A-Za-z0-9./-]+\.postgres\.test\.ts/gu)]
    .map(([filename]) => filename)
    .sort();

  expect(configured).toEqual(discovered);
});
