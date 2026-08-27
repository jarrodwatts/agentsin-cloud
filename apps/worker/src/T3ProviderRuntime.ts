import type {
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderSendTurnInput,
  ProviderTurnStartResult,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderStopSessionInput,
} from "@t3tools/contracts";
import type { CloudThreadCommand } from "@t3tools/contracts/cloud";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { WorkerProviderError } from "./errors.ts";
import type { WorkerProviderFactory, WorkerProviderSession } from "./ports.ts";

export interface T3ProviderInstanceInfo {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly enabled: boolean;
}

/** Narrow structural view of the existing server `ProviderServiceShape`. */
export interface T3ProviderService<E> {
  readonly startSession: (
    threadId: CloudThreadCommand["threadId"],
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, E>;
  readonly sendTurn: (input: ProviderSendTurnInput) => Effect.Effect<ProviderTurnStartResult, E>;
  readonly interruptTurn: (input: ProviderInterruptTurnInput) => Effect.Effect<void, E>;
  readonly respondToRequest: (input: ProviderRespondToRequestInput) => Effect.Effect<void, E>;
  readonly respondToUserInput: (input: ProviderRespondToUserInputInput) => Effect.Effect<void, E>;
  readonly stopSession: (input: ProviderStopSessionInput) => Effect.Effect<void, E>;
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;
  readonly getInstanceInfo: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<T3ProviderInstanceInfo, E>;
  readonly rollbackConversation: (input: {
    readonly threadId: CloudThreadCommand["threadId"];
    readonly numTurns: number;
  }) => Effect.Effect<void, E>;
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent, E>;
}

const providerFailure = (operation: string, cause: unknown, crashed = true) =>
  new WorkerProviderError({ operation, crashed, cause });

const mapProviderFailure = (operation: string) =>
  Effect.mapError((cause: unknown) => providerFailure(operation, cause));

const matchingSession = (
  sessions: ReadonlyArray<ProviderSession>,
  command: CloudThreadCommand,
): ProviderSession | undefined => sessions.find((session) => session.threadId === command.threadId);

/**
 * Adapts the existing T3 `ProviderService` facade into the cloud-worker port.
 * Driver creation, CLI protocol handling, approvals, and normalized runtime
 * events remain owned by the existing Codex/Claude/Cursor/Grok/OpenCode
 * adapters. The B4 composition root must construct this service only after
 * the opaque secret lease has materialized its credential directory.
 */
export const makeT3ProviderFactory = <E>(
  providerService: T3ProviderService<E>,
): WorkerProviderFactory => ({
  start: ({ identity, emit }) =>
    Effect.gen(function* () {
      const instance = yield* providerService
        .getInstanceInfo(identity.provider.instanceId)
        .pipe(mapProviderFailure("resolve-provider-instance"));
      if (instance.driverKind !== identity.provider.driver || !instance.enabled) {
        return yield* providerFailure(
          "resolve-provider-instance",
          "selected provider instance is unavailable or does not match the sealed driver",
          false,
        );
      }

      const stoppedRef = yield* Ref.make(false);
      const eventPumpStateRef = yield* Ref.make<"ready" | "failed">("ready");
      const eventPump = yield* providerService.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === identity.threadId &&
            event.provider === identity.provider.driver &&
            (event.providerInstanceId === undefined ||
              event.providerInstanceId === identity.provider.instanceId),
        ),
        Stream.runForEach((event: ProviderRuntimeEvent) => emit(event).pipe(Effect.asVoid)),
        Effect.tapError(() => Ref.set(eventPumpStateRef, "failed")),
        Effect.forkScoped,
      );

      const ensureSession = (command: CloudThreadCommand) =>
        Effect.gen(function* () {
          const sessions = yield* providerService.listSessions();
          const existing = matchingSession(sessions, command);
          if (
            existing !== undefined &&
            existing.status !== "closed" &&
            existing.status !== "error"
          ) {
            return existing;
          }
          if (command.command.type !== "thread.turn.start") {
            return undefined;
          }
          return yield* providerService
            .startSession(identity.threadId, {
              threadId: identity.threadId,
              provider: identity.provider.driver,
              providerInstanceId: identity.provider.instanceId,
              cwd: identity.workspaceDirectory,
              ...(command.command.modelSelection === undefined
                ? {}
                : { modelSelection: command.command.modelSelection }),
              runtimeMode: command.command.runtimeMode,
            })
            .pipe(mapProviderFailure("start-session"));
        });

      const stopSession = providerService
        .stopSession({ threadId: identity.threadId })
        .pipe(Effect.catch(() => Effect.void));

      const dispatch = (command: CloudThreadCommand) =>
        Effect.gen(function* () {
          if (yield* Ref.get(stoppedRef)) {
            return yield* providerFailure("dispatch", "provider runtime is stopped", true);
          }
          switch (command.command.type) {
            case "thread.turn.start":
              yield* ensureSession(command);
              yield* providerService
                .sendTurn({
                  threadId: identity.threadId,
                  input: command.command.message.text,
                  attachments: command.command.message.attachments,
                  ...(command.command.modelSelection === undefined
                    ? {}
                    : { modelSelection: command.command.modelSelection }),
                  interactionMode: command.command.interactionMode,
                })
                .pipe(mapProviderFailure("send-turn"));
              return;
            case "thread.turn.interrupt":
              yield* providerService
                .interruptTurn({
                  threadId: identity.threadId,
                  ...(command.command.turnId === undefined
                    ? {}
                    : { turnId: command.command.turnId }),
                })
                .pipe(mapProviderFailure("interrupt-turn"));
              return;
            case "thread.approval.respond":
              yield* providerService
                .respondToRequest({
                  threadId: identity.threadId,
                  requestId: command.command.requestId,
                  decision: command.command.decision,
                })
                .pipe(mapProviderFailure("respond-to-approval"));
              return;
            case "thread.user-input.respond":
              yield* providerService
                .respondToUserInput({
                  threadId: identity.threadId,
                  requestId: command.command.requestId,
                  answers: command.command.answers,
                })
                .pipe(mapProviderFailure("respond-to-user-input"));
              return;
            case "thread.checkpoint.revert":
              yield* providerService
                .rollbackConversation({
                  threadId: identity.threadId,
                  numTurns: command.command.turnCount,
                })
                .pipe(mapProviderFailure("rollback-conversation"));
              return;
            case "thread.session.stop":
            case "thread.delete":
              yield* stopSession;
              return;
            case "thread.runtime-mode.set":
              yield* stopSession;
              return;
            case "thread.meta.update":
              if (command.command.modelSelection !== undefined) yield* stopSession;
              return;
            default:
              // The control plane already persists metadata-only commands.
              // This adapter owns provider side effects only.
              return;
          }
        });

      const stop = Effect.gen(function* () {
        const alreadyStopped = yield* Ref.getAndSet(stoppedRef, true);
        if (alreadyStopped) return;
        yield* stopSession;
        yield* Fiber.interrupt(eventPump).pipe(Effect.ignore);
      });

      return {
        dispatch,
        health: Effect.gen(function* () {
          if (yield* Ref.get(stoppedRef)) return "failed" as const;
          return yield* Ref.get(eventPumpStateRef);
        }),
        stop,
      } satisfies WorkerProviderSession;
    }),
});
