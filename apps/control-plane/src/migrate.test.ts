import { expect, it } from "@effect/vitest";

import { applicationMigrationFilenames } from "./applicationMigrations.ts";

it("uses a parsed, contiguous, strictly ordered application migration manifest", () => {
  const versions = applicationMigrationFilenames.map((filename) => Number(filename.slice(0, 4)));
  expect(versions).toEqual([...versions].sort((left, right) => left - right));
  expect(new Set(versions).size).toBe(versions.length);
  expect(versions).toEqual(Array.from({ length: versions.length }, (_, index) => index + 1));
  expect(applicationMigrationFilenames.slice(-3)).toEqual([
    "0015-e2b-template-identity.sql",
    "0016-usage-settlements.sql",
    "0017-usage-settlement-hardening.sql",
  ]);
});
