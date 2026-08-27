// @effect-diagnostics schemaSyncInEffect:off -- Canonical wire schemas build focused fixtures.
import { expect, it } from "@effect/vitest";
import { ProviderRuntimeEvent } from "@t3tools/contracts";
import {
  CloudThreadCommand,
  type CloudThreadCommand as CloudThreadCommandType,
} from "@t3tools/contracts/cloud";
import { WorkerBootstrap } from "@t3tools/contracts/worker";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { WorkerProviderError } from "./errors.ts";
import type { WorkerSecretMaterialization } from "./ports.ts";
import { makeT3ProviderFactory, type T3ProviderService } from "./T3ProviderRuntime.ts";

const bootstrap = Schema.decodeUnknownSync(WorkerBootstrap)({
  schemaVersion: 1,
  workerId: "worker-1",
  workspaceId: "workspace-1",
  environmentId: "environment-1",
  environmentRevisionId: "revision-1",
  threadId: "thread-1",
  sandboxId: "sandbox-1",
  reservationId: "command-reserve-1",
  provider: { instanceId: "codex_personal", driver: "codex" },
  workspaceDirectory: "/workspace/project",
  bootstrapEndpoint: "https://control.example.com/api/v1/worker-certificates/bootstrap",
  relayEndpoint: "wss://control.example.com/worker",
  relayServerSpkiSha256: "sha256/47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
  relayCredentialRef: "relay-ref-1",
  secretLeaseRef: "lease-ref-1",
  issuedAt: "2026-08-27T00:00:00.000Z",
  expiresAt: "2026-08-27T01:00:00.000Z",
});

const interrupt = Schema.decodeUnknownSync(CloudThreadCommand)({
  schemaVersion: 1,
  workspaceId: bootstrap.workspaceId,
  environmentId: bootstrap.environmentId,
  threadId: bootstrap.threadId,
  command: {
    type: "thread.turn.interrupt",
    commandId: "command-1",
    threadId: bootstrap.threadId,
    turnId: "turn-1",
    createdAt: "2026-08-27T00:30:00.000Z",
  },
  enqueuedAt: "2026-08-27T00:30:00.000Z",
});

const runtimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent)({
  eventId: "provider-event-1",
  provider: bootstrap.provider.driver,
  providerInstanceId: bootstrap.provider.instanceId,
  threadId: bootstrap.threadId,
  createdAt: "2026-08-27T00:30:00.000Z",
  type: "runtime.warning",
  payload: { message: "provider warning" },
});

const materialization: WorkerSecretMaterialization = {
  leaseRef: bootstrap.secretLeaseRef,
  credentialDirectory: "/run/agentsin/credentials",
  environmentVariableNames: ["CODEX_HOME"],
  containsWalletMaterial: false,
  makeInspectorOutputRedactor: () => (chunk) => chunk,
  scrub: Effect.void,
};

it.effect("delegates cancellation and runtime events to the existing T3 provider facade", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const interrupted: Array<CloudThreadCommandType["threadId"]> = [];
      const emitted: Array<string> = [];
      const eventObserved = yield* Deferred.make<void>();
      let stopped = 0;
      const service: T3ProviderService<WorkerProviderError> = {
        startSession: () =>
          Effect.fail(new WorkerProviderError({ operation: "unused", crashed: false })),
        sendTurn: () =>
          Effect.fail(new WorkerProviderError({ operation: "unused", crashed: false })),
        interruptTurn: (input) =>
          Effect.sync(() => {
            interrupted.push(input.threadId);
          }),
        respondToRequest: () => Effect.void,
        respondToUserInput: () => Effect.void,
        stopSession: () =>
          Effect.sync(() => {
            stopped += 1;
          }),
        listSessions: () => Effect.succeed([]),
        getInstanceInfo: () =>
          Effect.succeed({
            instanceId: bootstrap.provider.instanceId,
            driverKind: bootstrap.provider.driver,
            enabled: true,
          }),
        rollbackConversation: () => Effect.void,
        streamEvents: Stream.make(runtimeEvent),
      };
      const session = yield* makeT3ProviderFactory(service).start({
        identity: bootstrap,
        materialization,
        emit: (event) =>
          Effect.sync(() => emitted.push(event.eventId)).pipe(
            Effect.andThen(Deferred.succeed(eventObserved, undefined)),
            Effect.as(undefined),
          ),
      });
      yield* Deferred.await(eventObserved);
      yield* session.dispatch(interrupt);
      yield* session.stop;
      expect(interrupted).toEqual([bootstrap.threadId]);
      expect(emitted).toEqual(["provider-event-1"]);
      expect(stopped).toBe(1);
    }),
  ),
);

it.effect("rejects a provider instance whose driver differs from sealed identity", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const service: T3ProviderService<WorkerProviderError> = {
        startSession: () => Effect.never,
        sendTurn: () => Effect.never,
        interruptTurn: () => Effect.never,
        respondToRequest: () => Effect.never,
        respondToUserInput: () => Effect.never,
        stopSession: () => Effect.void,
        listSessions: () => Effect.succeed([]),
        getInstanceInfo: () =>
          Effect.succeed({
            instanceId: bootstrap.provider.instanceId,
            driverKind: "claudeAgent" as never,
            enabled: true,
          }),
        rollbackConversation: () => Effect.never,
        streamEvents: Stream.empty,
      };
      const exit = yield* Effect.exit(
        makeT3ProviderFactory(service).start({
          identity: bootstrap,
          materialization,
          emit: () => Effect.void.pipe(Effect.as(undefined)),
        }),
      );
      expect(exit._tag).toBe("Failure");
    }),
  ),
);
