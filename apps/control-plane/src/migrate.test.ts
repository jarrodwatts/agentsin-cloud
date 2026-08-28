// @effect-diagnostics nodeBuiltinImport:off -- Migration-order test reads the checked-in entrypoint as source.
import * as NodeFSP from "node:fs/promises";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

it.effect("keeps E2B template identity migration 0015 before settlement migration 0016", () =>
  Effect.gen(function* () {
    const source = yield* Effect.promise(() =>
      NodeFSP.readFile(new URL("./migrate.ts", import.meta.url), "utf8"),
    );
    const positions = [
      "0001-",
      "0002-",
      "0003-",
      "0004-",
      "0005-",
      "0006-",
      "0007-",
      "0008-",
      "0009-",
      "0010-",
      "0011-",
      "0012-",
      "0013-",
      "0014-",
      "0015-",
      "0016-",
    ].map((marker) => source.indexOf(marker));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  }),
);
