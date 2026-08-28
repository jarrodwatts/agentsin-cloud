import { expect, it } from "@effect/vitest";

import {
  decodeProviderProfileBundle,
  encodeProviderProfileBundle,
  isProviderProfileBundle,
  ProviderProfileBundleError,
} from "./providerProfileBundle.ts";

it("round-trips a bounded multi-file provider profile without copying decoded contents", () => {
  const first = Uint8Array.from([1, 2, 3]);
  const bundle = encodeProviderProfileBundle([
    { path: "codex/auth.json", contents: first },
    { path: "claude/.credentials.json", contents: Uint8Array.from([4, 5]) },
  ]);
  const decoded = decodeProviderProfileBundle(bundle);

  expect(decoded.files.map((file) => file.path)).toEqual([
    "codex/auth.json",
    "claude/.credentials.json",
  ]);
  expect([...decoded.files[0]!.contents]).toEqual([1, 2, 3]);
  decoded.files[0]!.contents[0] = 9;
  expect(decodeProviderProfileBundle(bundle).files[0]!.contents[0]).toBe(9);
  expect(isProviderProfileBundle(bundle)).toBe(true);
});

it("rejects traversal, duplicate normalized paths, malformed headers, and trailing data", () => {
  for (const path of ["../auth.json", "/auth.json", "C:\\auth.json", "a//b", ".", "x\0y"]) {
    expect(() => encodeProviderProfileBundle([{ path, contents: Uint8Array.from([1]) }])).toThrow(
      ProviderProfileBundleError,
    );
  }
  expect(() =>
    encodeProviderProfileBundle([
      { path: "a\\b", contents: Uint8Array.from([1]) },
      { path: "a/b", contents: Uint8Array.from([2]) },
    ]),
  ).toThrow(ProviderProfileBundleError);
  expect(isProviderProfileBundle(Uint8Array.from([0, 1, 2]))).toBe(false);
  const valid = encodeProviderProfileBundle([{ path: "auth.json", contents: new Uint8Array() }]);
  const trailing = new Uint8Array(valid.byteLength + 1);
  trailing.set(valid);
  expect(() => decodeProviderProfileBundle(trailing)).toThrow(ProviderProfileBundleError);
});
