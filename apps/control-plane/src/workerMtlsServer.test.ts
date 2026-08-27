import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { WorkerIdentityService } from "./workerIdentity.ts";
import {
  makeWorkerBootstrapHandler,
  makeWorkerMtlsConnectionAdmission,
} from "./workerMtlsServer.ts";

it("atomically bounds raw connections and pending TLS handshakes", () => {
  const admission = makeWorkerMtlsConnectionAdmission({
    maxConnections: 2,
    maxPendingHandshakes: 1,
  });
  const first = admission.admit();

  expect(first).toBeDefined();
  expect(admission.admit()).toBeUndefined();
  expect(admission.totalConnections()).toBe(1);
  expect(admission.pendingHandshakes()).toBe(1);

  first?.handshakeComplete();
  const second = admission.admit();
  expect(second).toBeDefined();
  expect(admission.admit()).toBeUndefined();
  expect(admission.totalConnections()).toBe(2);
  expect(admission.pendingHandshakes()).toBe(1);

  first?.close();
  first?.close();
  expect(admission.admit()).toBeUndefined();
  second?.close();
  expect(admission.totalConnections()).toBe(0);
  expect(admission.pendingHandshakes()).toBe(0);
  expect(admission.admit()).toBeDefined();
});

it("releases a raw pending-handshake slot when the socket closes before TLS", () => {
  const admission = makeWorkerMtlsConnectionAdmission({
    maxConnections: 1,
    maxPendingHandshakes: 1,
  });
  const first = admission.admit();
  first?.close();
  first?.handshakeComplete();

  expect(admission.totalConnections()).toBe(0);
  expect(admission.pendingHandshakes()).toBe(0);
  expect(admission.admit()).toBeDefined();
});

it.effect("stops reading an unannounced oversized bootstrap body and fails closed", () =>
  Effect.gen(function* () {
    let pulls = 0;
    let exchanges = 0;
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        pulls += 1;
        controller.enqueue(new Uint8Array(64));
        if (pulls === 100) controller.close();
      },
    });
    const request = new Request("https://control.example/api/v1/worker-certificates/bootstrap", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit & { readonly duplex: "half" });
    const handler = makeWorkerBootstrapHandler({
      identities: {
        exchangeBootstrapToken: () =>
          Effect.sync(() => {
            exchanges += 1;
            throw new Error("must not exchange an oversized body");
          }),
      } as unknown as WorkerIdentityService,
      maxBodyBytes: 100,
    });

    const response = yield* handler(request);
    expect(response?.status).toBe(401);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(exchanges).toBe(0);
    expect(pulls).toBeLessThan(100);
  }),
);
