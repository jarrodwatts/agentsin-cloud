// @effect-diagnostics nodeBuiltinImport:off -- Linux root fail-closed startup proof.
import * as NodeProcess from "node:process";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { CloudWorkerDependencies } from "./CloudWorker.ts";
import { WORKER_EXECUTION_MODE_ENV, selectWorkerProcessDependencies } from "./main.ts";

describe.skipIf(NodeProcess.env.AGENTSIN_ROOT_SECURITY_TEST !== "1")(
  "root worker startup mode",
  () => {
    it.effect(
      "rejects missing, injected, malformed, and incomplete hosted modes as real uid zero",
      () =>
        Effect.gen(function* () {
          expect(NodeProcess.getuid?.()).toBe(0);
          const dependencies = {} as CloudWorkerDependencies;
          for (const env of [
            {},
            { [WORKER_EXECUTION_MODE_ENV]: "injected" },
            { [WORKER_EXECUTION_MODE_ENV]: "unknown" },
            { [WORKER_EXECUTION_MODE_ENV]: "hosted" },
          ]) {
            const outcome = yield* selectWorkerProcessDependencies(dependencies, env).pipe(
              Effect.exit,
            );
            expect(outcome._tag).toBe("Failure");
          }
        }),
    );
  },
);
