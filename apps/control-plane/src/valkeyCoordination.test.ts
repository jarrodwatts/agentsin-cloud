import { expect, it } from "@effect/vitest";
import type { ThreadId } from "@t3tools/contracts";
import type { WorkspaceId } from "@t3tools/contracts/cloud";
import * as Effect from "effect/Effect";

import {
  CONTROL_MUTATION_RATE_POLICY,
  PRESENCE_HEARTBEAT_RATE_POLICY,
} from "./ephemeralCoordination.ts";
import {
  makeValkeyEphemeralCoordinationFromClient,
  type ValkeyCommandClient,
} from "./valkeyCoordination.ts";

const workspaceId = "00000000-0000-4000-8000-000000000001" as WorkspaceId;
const threadId = "thread-1" as ThreadId;

class ScriptedClient implements ValkeyCommandClient {
  readonly evalCalls: Array<{
    readonly script: string;
    readonly numberOfKeys: number;
    readonly arguments: ReadonlyArray<string>;
  }> = [];
  getResult: string | null = null;
  evalResult: unknown = 1;
  error: Error | undefined;

  get() {
    return this.error === undefined ? Promise.resolve(this.getResult) : Promise.reject(this.error);
  }

  eval(script: string, numberOfKeys: number, ...arguments_: ReadonlyArray<string>) {
    this.evalCalls.push({ script, numberOfKeys, arguments: arguments_ });
    if (this.error !== undefined) return Promise.reject(this.error);
    if (script.includes("local generation = redis.call('INCR'")) {
      return Promise.resolve([1, arguments_[7]]);
    }
    return Promise.resolve(this.evalResult);
  }

  ping() {
    return this.error === undefined ? Promise.resolve("PONG") : Promise.reject(this.error);
  }
}

it.effect("publishes routes through one atomic script in a versioned encoded keyspace", () =>
  Effect.gen(function* () {
    const client = new ScriptedClient();
    const coordination = makeValkeyEphemeralCoordinationFromClient(client, "aic-prod");

    expect(
      yield* coordination.publishRoute({
        workspaceId,
        threadId,
        connectionId: "connection-1",
        processInstanceId: "railway-1",
        generation: 4,
        ttlMs: 10_000,
      }),
    ).toBe("applied");

    const call = client.evalCalls[0];
    expect(call?.numberOfKeys).toBe(3);
    expect(call?.arguments[0]).toContain("aic-prod:v1:route:");
    expect(call?.arguments[1]).toContain("aic-prod:v1:route-fence:");
    expect(call?.arguments[0]).not.toContain(workspaceId);
    expect(call?.arguments[0]).not.toContain(threadId);
    expect(call?.arguments).toContain("4");
  }),
);

it.effect("sends only a lease capability digest to Valkey", () =>
  Effect.gen(function* () {
    const client = new ScriptedClient();
    const coordination = makeValkeyEphemeralCoordinationFromClient(client, "aic-prod");

    const result = yield* coordination.acquireLease({
      workspaceId,
      resourceKind: "desktop-control",
      resourceId: threadId,
      leaseId: "lease-1",
      holderId: "client-1",
      ttlMs: 10_000,
    });

    expect(result.acquired).toBe(true);
    if (!result.acquired) return;
    const serializedCall = client.evalCalls[0]?.arguments.join("\n") ?? "";
    expect(serializedCall).not.toContain(result.leaseToken);
    expect(serializedCall).toMatch(/[a-f0-9]{64}/);
    expect(client.evalCalls[0]?.numberOfKeys).toBe(4);
  }),
);

it.effect("maps malformed stored records to corrupt-state failures", () =>
  Effect.gen(function* () {
    const client = new ScriptedClient();
    client.getResult = "{not-json";
    const coordination = makeValkeyEphemeralCoordinationFromClient(client, "aic-prod");

    const error = yield* Effect.flip(coordination.getRoute(workspaceId, threadId));
    expect(error.code).toBe("corruptState");
  }),
);

it.effect("fails closed for mutations and explicitly degrades advisory rate limits", () =>
  Effect.gen(function* () {
    const client = new ScriptedClient();
    client.error = new Error("connection lost");
    const coordination = makeValkeyEphemeralCoordinationFromClient(client, "aic-prod");
    const common = {
      workspaceId,
      subjectKind: "session",
      subjectId: "session-1",
    };

    expect(
      yield* coordination.consumeRateLimit({
        ...common,
        policy: PRESENCE_HEARTBEAT_RATE_POLICY,
      }),
    ).toMatchObject({ allowed: true, degraded: true, retryAfterMs: 0 });
    expect(
      (yield* Effect.exit(
        coordination.consumeRateLimit({
          ...common,
          policy: CONTROL_MUTATION_RATE_POLICY,
        }),
      ))._tag,
    ).toBe("Failure");
  }),
);

it.effect("does not fail open corrupt limiter replies", () =>
  Effect.gen(function* () {
    const client = new ScriptedClient();
    client.evalResult = ["not-a-status", 1, 1_000];
    const coordination = makeValkeyEphemeralCoordinationFromClient(client, "aic-prod");

    expect(
      (yield* Effect.exit(
        coordination.consumeRateLimit({
          workspaceId,
          subjectKind: "session",
          subjectId: "session-1",
          policy: PRESENCE_HEARTBEAT_RATE_POLICY,
        }),
      ))._tag,
    ).toBe("Failure");
  }),
);

it.effect("rejects unbounded input before issuing any Valkey command", () =>
  Effect.gen(function* () {
    const client = new ScriptedClient();
    const coordination = makeValkeyEphemeralCoordinationFromClient(client, "aic-prod");

    expect(
      (yield* Effect.exit(
        coordination.publishRoute({
          workspaceId,
          threadId,
          connectionId: "connection-1",
          processInstanceId: "railway-1",
          generation: 0,
          ttlMs: 10_000,
        }),
      ))._tag,
    ).toBe("Failure");
    expect(client.evalCalls).toHaveLength(0);
  }),
);
