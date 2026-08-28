// @effect-diagnostics globalProcess:off -- This executable reports one hermetic build canary result.
import * as NodeProcess from "node:process";

import * as Effect from "effect/Effect";

import { runHermeticWorkerImageCanary } from "./imageCanary.ts";

const result = await Effect.runPromise(runHermeticWorkerImageCanary());
NodeProcess.stdout.write(`${JSON.stringify(result)}\n`);
