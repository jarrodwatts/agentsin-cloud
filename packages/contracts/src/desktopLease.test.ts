import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  DesktopAuthorityCommand,
  DesktopControlClientFrame,
  DesktopInputPermit,
} from "./desktopLease.ts";
import { InspectorWorkerCommand } from "./inspector.ts";

const binding = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  threadId: "thread-1",
  attemptId: "attempt-1",
  environmentId: "environment-1",
  environmentRevisionId: "revision-1",
  sandboxId: "sandbox-1",
  workerId: "worker-1",
  routeGeneration: 3,
};
const permit = {
  leaseId: "22222222-2222-4222-8222-222222222222",
  generation: 7,
  authorityRevision: 13,
  binding,
  expiresAt: "2026-08-27T12:01:00.000Z",
};

it("keeps caller authority out of desktop-control requests", () => {
  const decode = Schema.decodeUnknownSync(DesktopControlClientFrame);
  expect(
    decode({
      protocolVersion: 1,
      type: "desktop.control.acquire",
      requestId: "request-1",
      idempotencyKey: "acquire-1",
    }).type,
  ).toBe("desktop.control.acquire");
  expect(() =>
    decode({
      protocolVersion: 1,
      type: "desktop.control.acquire",
      requestId: "request-1",
      idempotencyKey: "acquire-1",
      workspaceId: binding.workspaceId,
    }),
  ).toThrow();
});

it("rejects stale or unbounded desktop fences", () => {
  const decodePermit = Schema.decodeUnknownSync(DesktopInputPermit);
  const decodeAuthority = Schema.decodeUnknownSync(DesktopAuthorityCommand);
  expect(decodePermit(permit)).toMatchObject({ generation: 7, authorityRevision: 13 });
  expect(() => decodePermit({ ...permit, generation: 0 })).toThrow();
  expect(() => decodePermit({ ...permit, binding: { ...binding, routeGeneration: 0 } })).toThrow();
  expect(() =>
    decodeAuthority({
      type: "desktop.authority",
      controller: "user",
      ...permit,
      credential: "must-not-cross-wire",
    }),
  ).toThrow();
});

it("requires a permit only for browser and desktop input", () => {
  const decode = Schema.decodeUnknownSync(InspectorWorkerCommand);
  const base = {
    type: "inspector.request" as const,
    binding: {
      protocolVersion: 1,
      ...binding,
      providerInstanceId: "codex_personal",
      providerDriver: "codex",
    },
    sessionId: "session-1",
  };
  const input = {
    requestId: "input-1",
    type: "desktop.input" as const,
    input: { type: "pointer", action: "move", x: 10, y: 20, button: "none" },
  };
  expect(decode({ ...base, operation: input, desktopPermit: permit }).type).toBe(
    "inspector.request",
  );
  expect(() => decode({ ...base, operation: input })).toThrow();
  expect(() =>
    decode({
      ...base,
      operation: { type: "capabilities.get", requestId: "capabilities-1" },
      desktopPermit: permit,
    }),
  ).toThrow();
});
