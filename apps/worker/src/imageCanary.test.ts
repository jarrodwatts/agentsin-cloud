import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { runHermeticWorkerImageCanary } from "./imageCanary.ts";

it.effect("boots the worker and selects the hosted authenticated relay without network", () =>
  Effect.gen(function* () {
    const result = yield* runHermeticWorkerImageCanary();
    expect(result).toMatchObject({
      hostedRelaySelected: true,
      providerStarts: 1,
      providerStops: 1,
      relayConnects: 1,
      relayCloses: 1,
      credentialScrubs: 1,
    });
    expect(result.outboundTypes).toContain("worker.heartbeat");
    expect(result.outboundTypes).toContain("worker.ready");
  }),
);
