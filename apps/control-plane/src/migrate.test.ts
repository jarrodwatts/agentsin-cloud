// @effect-diagnostics nodeBuiltinImport:off -- Migration-order test reads the checked-in entrypoint as source.
import * as NodeFSP from "node:fs/promises";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

it.effect("runs application migrations in strict 0001 through 0010 order", () =>
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
      "0007 is reserved",
      "0008-",
      "0009-",
      "0010-",
    ].map((marker) => source.indexOf(marker));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  }),
);
