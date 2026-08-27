import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { SandboxId, WorkspaceId } from "@t3tools/contracts/cloud";
import {
  type WorkerRelayGitHubCommandDelivery,
  WorkerGitHubCommand,
} from "@t3tools/contracts/worker";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";

import { executeGitHubWorkerCommand } from "../../worker/src/githubCommandHandler.ts";
import { makeGitHubWorkerDispatcher } from "./githubWorkerDispatcher.ts";
import { makeInMemoryWorkerRouteRegistry } from "./workerRelay.ts";
import type { ActiveWorkerLease } from "./workerIdentity.ts";

const decodeCommand = Schema.decodeUnknownSync(WorkerGitHubCommand);
const workspaceId = "workspace-1" as WorkspaceId;
const environmentId = "environment-1" as EnvironmentId;
const threadId = "thread-1" as ThreadId;
const sandboxId = "sandbox-1" as SandboxId;
const lease = {
  workspaceId,
  environmentId,
  environmentRevisionId: "revision-1",
  threadId,
  sandboxId,
  reservationId: "reservation-1",
  workerId: "worker-1",
  providerInstanceId: "codex_personal",
  providerDriver: "codex",
  certificateFingerprint: "fingerprint-1",
  certificateGeneration: 1,
  leaseGeneration: 1,
  routeGeneration: 1,
  processInstanceId: "process-1",
  state: "connected",
  connectedAt: "2026-08-27T12:00:00.000Z",
  lastSeenAt: "2026-08-27T12:00:00.000Z",
  heartbeatSequence: 1,
  confirmedEventCursor: -1,
} as ActiveWorkerLease;

const commandFor = (
  identity: Pick<ActiveWorkerLease, "workspaceId" | "environmentId" | "threadId" | "sandboxId">,
  operationId = "operation-1",
  commandId = "command-1",
) =>
  decodeCommand({
    operationId,
    commandId,
    workspaceId: identity.workspaceId,
    environmentId: identity.environmentId,
    threadId: identity.threadId,
    sandboxId: identity.sandboxId,
    repository: {
      provider: "github",
      host: "github.com",
      installationId: "installation-1",
      owner: "jarrodwatts",
      name: "agentsin-cloud",
      canonicalKey: "github.com/jarrodwatts/agentsin-cloud",
    },
    type: "github.git.prepare-branch",
    branch: "agents/relay-test-123456789abc",
    baseSha: "a".repeat(40),
  });

it.effect(
  "routes a bounded Git command and accepts a result only from its authenticated worker",
  () =>
    Effect.gen(function* () {
      const routes = makeInMemoryWorkerRouteRegistry();
      const dispatcher = makeGitHubWorkerDispatcher({ routes, timeoutMs: 1_000 });
      const command = commandFor(lease);
      let delivered: WorkerRelayGitHubCommandDelivery | undefined;
      routes.activate({
        lease,
        close: () => undefined,
        send: (frame) => {
          if (frame.type === "github.command") delivered = frame;
          return true;
        },
      });
      const pending = yield* Effect.forkChild(
        dispatcher.dispatch({ workspaceId, environmentId, threadId, sandboxId }, command),
      );
      yield* Effect.yieldNow;
      if (delivered === undefined) return yield* Effect.die("relay did not receive the command");
      const workerResult = yield* executeGitHubWorkerCommand(
        {
          execute: (received) =>
            Effect.succeed({
              type: "github.command.result" as const,
              operationId: received.operationId,
              commandId: received.commandId,
              status: "prepared" as const,
              localSha: "a".repeat(40) as never,
              completedAt: "2026-08-27T12:00:01.000Z",
            }),
        },
        delivered.command,
      );
      yield* dispatcher.handleResult(
        { ...lease, certificateFingerprint: "fingerprint-1", certificateGeneration: 1 },
        workerResult,
      );
      const result = yield* Fiber.join(pending);
      expect(delivered.command.operationId).toBe(command.operationId);
      expect(result.status).toBe("prepared");
      expect(dispatcher.pendingCount()).toBe(0);
    }),
);

it.effect("rejects a result from a different sandbox principal", () =>
  Effect.gen(function* () {
    const routes = makeInMemoryWorkerRouteRegistry();
    const dispatcher = makeGitHubWorkerDispatcher({ routes, timeoutMs: 50 });
    const result = yield* Effect.flip(
      dispatcher.handleResult(
        { ...lease, sandboxId: "sandbox-forged" as SandboxId },
        {
          type: "github.command.result",
          operationId: "unknown-operation" as never,
          commandId: "command-1" as never,
          status: "pushed",
          completedAt: "2026-08-27T12:00:01.000Z",
        },
      ),
    );
    expect(result.code).toBe("identityMismatch");
  }),
);

it.effect("isolates the same operation and command ids across tenant routes", () =>
  Effect.gen(function* () {
    const routes = makeInMemoryWorkerRouteRegistry();
    const dispatcher = makeGitHubWorkerDispatcher({ routes, timeoutMs: 1_000 });
    const otherLease = {
      ...lease,
      workspaceId: "workspace-2" as WorkspaceId,
      environmentId: "environment-2" as EnvironmentId,
      threadId: "thread-2" as ThreadId,
      sandboxId: "sandbox-2" as SandboxId,
      workerId: "worker-2",
      certificateFingerprint: "fingerprint-2",
      processInstanceId: "process-2",
    } as ActiveWorkerLease;
    const deliveries = new Map<string, WorkerRelayGitHubCommandDelivery>();
    for (const active of [lease, otherLease]) {
      routes.activate({
        lease: active,
        close: () => undefined,
        send: (frame) => {
          if (frame.type === "github.command") deliveries.set(active.workspaceId, frame);
          return true;
        },
      });
    }
    const first = yield* Effect.forkChild(
      dispatcher.dispatch(
        { workspaceId, environmentId, threadId, sandboxId },
        commandFor(lease, "shared-operation", "shared-command"),
      ),
    );
    const second = yield* Effect.forkChild(
      dispatcher.dispatch(
        {
          workspaceId: otherLease.workspaceId,
          environmentId: otherLease.environmentId,
          threadId: otherLease.threadId,
          sandboxId: otherLease.sandboxId,
        },
        commandFor(otherLease, "shared-operation", "shared-command"),
      ),
    );
    yield* Effect.yieldNow;
    expect(deliveries.size).toBe(2);
    for (const active of [lease, otherLease]) {
      yield* dispatcher.handleResult(active, {
        type: "github.command.result",
        operationId: "shared-operation" as never,
        commandId: "shared-command" as never,
        status: "prepared",
        localSha: "a".repeat(40) as never,
        completedAt: "2026-08-27T12:00:01.000Z",
      });
    }
    expect((yield* Fiber.join(first)).status).toBe("prepared");
    expect((yield* Fiber.join(second)).status).toBe("prepared");
    expect(dispatcher.pendingCount()).toBe(0);
    dispatcher.close();
  }),
);

it.effect("rejects admission before timers when operation or queue budgets are exceeded", () =>
  Effect.gen(function* () {
    const routes = makeInMemoryWorkerRouteRegistry();
    routes.activate({ lease, close: () => undefined, send: () => true });
    const byteBounded = makeGitHubWorkerDispatcher({
      routes,
      timeoutMs: 1_000,
      limits: { maxOperationBytes: 1 },
    });
    const tooLarge = yield* Effect.flip(
      byteBounded.dispatch(
        { workspaceId, environmentId, threadId, sandboxId },
        commandFor(lease, "operation-too-large", "command-too-large"),
      ),
    );
    expect(tooLarge.code).toBe("capacityExceeded");
    expect(byteBounded.pendingCount()).toBe(0);
    expect(byteBounded.pendingBytes()).toBe(0);
    byteBounded.close();

    const saturated = makeGitHubWorkerDispatcher({
      routes,
      timeoutMs: 1_000,
      limits: { maxPendingGlobal: 1 },
    });
    const withheld = yield* Effect.forkChild(
      saturated.dispatch(
        { workspaceId, environmentId, threadId, sandboxId },
        commandFor(lease, "operation-withheld", "command-withheld"),
      ),
    );
    yield* Effect.yieldNow;
    const denied = yield* Effect.flip(
      saturated.dispatch(
        { workspaceId, environmentId, threadId, sandboxId },
        commandFor(lease, "operation-denied", "command-denied"),
      ),
    );
    expect(denied.code).toBe("capacityExceeded");
    expect(saturated.pendingCount()).toBe(1);
    routes.deactivate(lease);
    expect((yield* Effect.flip(Fiber.join(withheld))).code).toBe("workerUnavailable");
    expect(saturated.pendingBytes()).toBe(0);
    saturated.close();
  }),
);

it.effect("cleans a replaced route and rejects a late result from its old principal", () =>
  Effect.gen(function* () {
    const routes = makeInMemoryWorkerRouteRegistry();
    const dispatcher = makeGitHubWorkerDispatcher({ routes, timeoutMs: 1_000 });
    routes.activate({ lease, close: () => undefined, send: () => true });
    const pending = yield* Effect.forkChild(
      dispatcher.dispatch(
        { workspaceId, environmentId, threadId, sandboxId },
        commandFor(lease, "operation-replaced", "command-replaced"),
      ),
    );
    yield* Effect.yieldNow;
    const replacement = {
      ...lease,
      leaseGeneration: 2,
      routeGeneration: 2,
      certificateGeneration: 2,
      certificateFingerprint: "fingerprint-2",
      processInstanceId: "process-2",
    } as ActiveWorkerLease;
    expect(
      routes.activate({ lease: replacement, close: () => undefined, send: () => true }).accepted,
    ).toBe(true);
    expect((yield* Effect.flip(Fiber.join(pending))).code).toBe("workerUnavailable");
    expect(dispatcher.pendingCount()).toBe(0);
    expect(dispatcher.pendingBytes()).toBe(0);
    const late = yield* Effect.flip(
      dispatcher.handleResult(lease, {
        type: "github.command.result",
        operationId: "operation-replaced" as never,
        commandId: "command-replaced" as never,
        status: "pushed",
        completedAt: "2026-08-27T12:00:01.000Z",
      }),
    );
    expect(late.code).toBe("identityMismatch");
    dispatcher.close();
  }),
);

it.effect("fails a prepared dispatch when the selected route changes before send", () =>
  Effect.gen(function* () {
    const routes = makeInMemoryWorkerRouteRegistry();
    let oldDeliveries = 0;
    let replacementDeliveries = 0;
    routes.activate({
      lease,
      close: () => undefined,
      send: () => {
        oldDeliveries += 1;
        return true;
      },
    });
    const dispatcher = makeGitHubWorkerDispatcher({ routes, timeoutMs: 1_000 });
    const prepared = yield* dispatcher.prepare({
      workspaceId,
      environmentId,
      threadId,
      sandboxId,
    });
    const replacement = {
      ...lease,
      workerId: "worker-2",
      certificateFingerprint: "fingerprint-2",
      certificateGeneration: 2,
      leaseGeneration: 2,
      routeGeneration: 2,
      processInstanceId: "process-2",
    } as ActiveWorkerLease;
    routes.activate({
      lease: replacement,
      close: () => undefined,
      send: () => {
        replacementDeliveries += 1;
        return true;
      },
    });
    const denied = yield* Effect.flip(
      prepared.dispatch(commandFor(lease, "operation-stale-seal", "command-stale-seal")),
    );
    expect(denied.code).toBe("workerUnavailable");
    expect(oldDeliveries).toBe(0);
    expect(replacementDeliveries).toBe(0);
    expect(dispatcher.pendingCount()).toBe(0);
    dispatcher.close();
  }),
);
