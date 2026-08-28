import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import type { CloudThreadCommand, CloudThreadEvent } from "@t3tools/contracts/cloud";
import {
  type WorkerBootstrap,
  type WorkerCommandAckStatus,
  type WorkerHealth,
  type WorkerProposalId,
  type WorkerRecoveryState,
  type WorkerProviderState,
  type WorkerDeliveryId,
  type WorkerRelayEventProposal,
  type WorkerRelayEventConfirmation,
  type WorkerRelayInbound,
  type WorkerRelayOutbound,
  type WorkerRelayState,
  type WorkerGitHubCommand,
} from "@t3tools/contracts/worker";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";

import {
  WorkerProtocolError,
  WorkerProviderError,
  WorkerRelayError,
  WorkerStoppedError,
} from "./errors.ts";
import type {
  WorkerClock,
  WorkerIds,
  WorkerLogger,
  WorkerProviderFactory,
  WorkerProviderSession,
  WorkerRelayConnection,
  WorkerRelayConnector,
  WorkerSecretLeaseBroker,
  WorkerSecretMaterialization,
} from "./ports.ts";
import {
  WorkerProviderCredentialError,
  type WorkerProviderCredentialExecutor,
} from "./ProviderCredentialExecutor.ts";
import {
  assertOutboundWithinLimit,
  commandMatchesBootstrap,
  decodeRelayFrame,
  eventMatchesBootstrap,
} from "./protocol.ts";
import { isForbiddenBootstrapKey, redactLogFields } from "./redaction.ts";
import type { GitHubGitExecutor } from "./GitHubGitExecutor.ts";
import { executeGitHubWorkerCommand } from "./githubCommandHandler.ts";
import { InspectorRuntimeError, type WorkerInspectorRuntime } from "./InspectorRuntime.ts";
import {
  AgentComputerInputGateError,
  makeAgentComputerInputGate,
  type AgentComputerInputGate,
} from "./AgentComputerInputGate.ts";

export interface CloudWorkerOptions {
  readonly maxPendingEventProposals: number;
  readonly maxTrackedConfirmations: number;
  readonly maxPendingEventAcks: number;
  readonly beforeReconnect: Effect.Effect<void>;
  readonly heartbeatInterval: Effect.Effect<void>;
}

export interface CloudWorkerDependencies {
  readonly relay: WorkerRelayConnector;
  readonly provider: WorkerProviderFactory;
  readonly secretLease: WorkerSecretLeaseBroker;
  readonly clock: WorkerClock;
  readonly ids: WorkerIds;
  readonly logger: WorkerLogger;
  readonly github?: {
    readonly makeExecutor: (bootstrap: WorkerBootstrap) => GitHubGitExecutor;
  };
  readonly inspector?: WorkerInspectorRuntime;
  readonly computerInputGate?: AgentComputerInputGate;
  readonly inspectorFactory?: {
    readonly make: (input: {
      readonly bootstrap: WorkerBootstrap;
      readonly materialization: WorkerSecretMaterialization;
      readonly computerInputGate: AgentComputerInputGate;
    }) => Effect.Effect<WorkerInspectorRuntime, InspectorRuntimeError>;
  };
  readonly onCloudEvent?: (event: CloudThreadEvent) => Effect.Effect<void>;
  /** Required by hosted production; omitted only by local legacy workers. */
  readonly providerCredentials?: WorkerProviderCredentialExecutor;
  readonly options?: Partial<CloudWorkerOptions>;
}

const defaultOptions: CloudWorkerOptions = {
  maxPendingEventProposals: 256,
  maxTrackedConfirmations: 1_024,
  maxPendingEventAcks: 256,
  beforeReconnect: Effect.sleep("1 second"),
  heartbeatInterval: Effect.sleep("15 seconds"),
};

interface BufferedConfirmation {
  readonly proposalId: WorkerProposalId;
  readonly event: CloudThreadEvent;
}

interface PendingEventAck {
  readonly proposalId: WorkerProposalId;
  readonly eventIds: ReadonlyArray<CloudThreadEvent["event"]["eventId"]>;
  readonly sequences: ReadonlySet<number>;
}

interface PendingProposal {
  readonly proposal: WorkerRelayEventProposal;
  readonly sentGeneration: number | undefined;
}

interface ConfirmationState {
  readonly safeReplayCursor: number;
  readonly processedThroughSequence: number;
  readonly bufferedBySequence: ReadonlyMap<number, BufferedConfirmation>;
  readonly proposalEvents: ReadonlyMap<
    WorkerProposalId,
    ReadonlyMap<number, CloudThreadEvent["event"]["eventId"]>
  >;
  readonly acknowledgedSequences: ReadonlySet<number>;
  readonly pendingAcks: ReadonlyMap<WorkerProposalId, PendingEventAck>;
}

const isWorkerRelayError = Schema.is(WorkerRelayError);
const isWorkerProtocolError = Schema.is(WorkerProtocolError);
const isWorkerStoppedError = Schema.is(WorkerStoppedError);

const safeLogger = (logger: WorkerLogger): WorkerLogger => ({
  info: (message, fields) => logger.info(message, redactLogFields(fields)),
  warn: (message, fields) => logger.warn(message, redactLogFields(fields)),
  error: (message, fields) => logger.error(message, redactLogFields(fields)),
});

const verifyRuntimeEvent = (
  bootstrap: WorkerBootstrap,
  event: ProviderRuntimeEvent,
): Effect.Effect<void, WorkerProviderError> => {
  if (
    event.threadId !== bootstrap.threadId ||
    event.provider !== bootstrap.provider.driver ||
    (event.providerInstanceId !== undefined &&
      event.providerInstanceId !== bootstrap.provider.instanceId)
  ) {
    return Effect.fail(
      new WorkerProviderError({
        operation: "emit",
        crashed: false,
        cause: "provider emitted an event outside the sealed worker identity",
      }),
    );
  }
  return Effect.void;
};

export const runCloudWorker = (
  bootstrap: WorkerBootstrap,
  dependencies: CloudWorkerDependencies,
): Effect.Effect<void, WorkerStoppedError | WorkerProtocolError | WorkerProviderError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const options = { ...defaultOptions, ...dependencies.options };
      if (dependencies.providerCredentials !== undefined) {
        yield* Effect.addFinalizer(() =>
          dependencies.providerCredentials!.cleanupAll.pipe(Effect.orDie),
        );
      }
      if (!Number.isSafeInteger(options.maxPendingEventProposals)) {
        return yield* new WorkerProtocolError({
          reason: "maxPendingEventProposals must be a safe integer",
          retryable: false,
        });
      }
      if (options.maxPendingEventProposals < 1 || options.maxPendingEventProposals > 4096) {
        return yield* new WorkerProtocolError({
          reason: "maxPendingEventProposals is outside the supported range",
          retryable: false,
        });
      }
      if (
        !Number.isSafeInteger(options.maxTrackedConfirmations) ||
        options.maxTrackedConfirmations < 1 ||
        options.maxTrackedConfirmations > 16_384
      ) {
        return yield* new WorkerProtocolError({
          reason: "maxTrackedConfirmations is outside the supported range",
          retryable: false,
        });
      }
      if (
        !Number.isSafeInteger(options.maxPendingEventAcks) ||
        options.maxPendingEventAcks < 1 ||
        options.maxPendingEventAcks > 4_096
      ) {
        return yield* new WorkerProtocolError({
          reason: "maxPendingEventAcks is outside the supported range",
          retryable: false,
        });
      }

      const logger = safeLogger(dependencies.logger);
      const github = dependencies.github?.makeExecutor(bootstrap);
      let materializationScrubbed = false;
      const scrubOnce = (materialized: WorkerSecretMaterialization) =>
        Effect.suspend(() => {
          if (materializationScrubbed) return Effect.void;
          return materialized.scrub.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                materializationScrubbed = true;
              }),
            ),
          );
        });
      const materialization = yield* Effect.acquireRelease(
        dependencies.secretLease.materialize({
          identity: bootstrap,
          leaseRef: bootstrap.secretLeaseRef,
          provider: bootstrap.provider,
        }),
        (materialized) => scrubOnce(materialized).pipe(Effect.ignore),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new WorkerProviderError({
              operation: "materialize-credentials",
              crashed: false,
              cause,
            }),
        ),
      );
      if (
        materialization.containsWalletMaterial ||
        materialization.environmentVariableNames.some(isForbiddenBootstrapKey)
      ) {
        yield* scrubOnce(materialization).pipe(Effect.ignore);
        return yield* new WorkerProviderError({
          operation: "materialize-credentials",
          crashed: false,
          cause: "secret lease attempted to materialize wallet or signing material",
        });
      }
      let inspector = dependencies.inspector;
      const computerInputGate = dependencies.computerInputGate ?? makeAgentComputerInputGate();
      const scrubMaterialization = scrubOnce(materialization);

      const relayRef = yield* Ref.make<WorkerRelayConnection | undefined>(undefined);
      const relayFailureRef = yield* Ref.make<
        Deferred.Deferred<WorkerRelayError | WorkerProtocolError> | undefined
      >(undefined);
      const providerRef = yield* Ref.make<WorkerProviderSession | undefined>(undefined);
      const providerStateRef = yield* Ref.make<WorkerProviderState>("starting");
      const relayStateRef = yield* Ref.make<WorkerRelayState>("connecting");
      const recoveryStateRef = yield* Ref.make<WorkerRecoveryState>("healthy");
      const queuedCommandsRef = yield* Ref.make(0);
      const pendingProposalsRef = yield* Ref.make<ReadonlyMap<WorkerProposalId, PendingProposal>>(
        new Map(),
      );
      const connectionGenerationRef = yield* Ref.make(-1);
      const heartbeatSequenceRef = yield* Ref.make(0);
      const providerRestartCountRef = yield* Ref.make(0);
      const confirmationStateRef = yield* Ref.make<ConfirmationState>({
        safeReplayCursor: -1,
        processedThroughSequence: -1,
        bufferedBySequence: new Map(),
        proposalEvents: new Map(),
        acknowledgedSequences: new Set(),
        pendingAcks: new Map(),
      });
      const sendLock = yield* Semaphore.make(1);
      const providerCredentialLock = yield* Semaphore.make(1);
      const proposalDrainLock = yield* Semaphore.make(1);

      const health = Effect.gen(function* () {
        const [
          providerState,
          relayState,
          recoveryState,
          queuedCommands,
          pending,
          confirmation,
          restarts,
          now,
        ] = yield* Effect.all([
          Ref.get(providerStateRef),
          Ref.get(relayStateRef),
          Ref.get(recoveryStateRef),
          Ref.get(queuedCommandsRef),
          Ref.get(pendingProposalsRef),
          Ref.get(confirmationStateRef),
          Ref.get(providerRestartCountRef),
          dependencies.clock.now,
        ]);
        return {
          workerId: bootstrap.workerId,
          workspaceId: bootstrap.workspaceId,
          environmentId: bootstrap.environmentId,
          environmentRevisionId: bootstrap.environmentRevisionId,
          threadId: bootstrap.threadId,
          sandboxId: bootstrap.sandboxId,
          providerState,
          relayState,
          recoveryState,
          ready:
            providerState === "ready" && relayState === "connected" && recoveryState === "healthy",
          queuedCommands,
          pendingEventProposals: pending.size,
          confirmedThroughSequence: confirmation.safeReplayCursor,
          providerRestartCount: restarts,
          observedAt: now,
        } satisfies WorkerHealth;
      });

      const send = (message: WorkerRelayOutbound) =>
        sendLock.withPermits(1)(
          Effect.gen(function* () {
            yield* assertOutboundWithinLimit(message);
            const relay = yield* Ref.get(relayRef);
            if (relay === undefined) {
              return yield* new WorkerRelayError({
                operation: "send",
                retryable: true,
                cause: "relay is disconnected",
              });
            }
            yield* relay.send(message);
          }),
        );

      const heartbeat = Effect.gen(function* () {
        const sequence = yield* Ref.updateAndGet(heartbeatSequenceRef, (value) => value + 1);
        yield* send({
          type: "worker.heartbeat",
          heartbeatSequence: sequence,
          health: yield* health,
        });
      });

      const markRelayFailed = (cause: WorkerRelayError | WorkerProtocolError) =>
        Effect.gen(function* () {
          yield* Ref.set(relayStateRef, "connecting");
          const failureSignal = yield* Ref.get(relayFailureRef);
          if (failureSignal !== undefined) {
            yield* Deferred.succeed(failureSignal, cause).pipe(Effect.ignore);
          }
        });

      const drainPendingProposals = proposalDrainLock.withPermits(1)(
        Effect.gen(function* () {
          if ((yield* Ref.get(relayStateRef)) !== "connected") return;
          const generation = yield* Ref.get(connectionGenerationRef);
          for (;;) {
            const pending = yield* Ref.get(pendingProposalsRef);
            const next = [...pending.values()].find((entry) => entry.sentGeneration !== generation);
            if (next === undefined) return;
            yield* send(next.proposal).pipe(Effect.tapError(markRelayFailed));
            yield* Ref.update(pendingProposalsRef, (current) => {
              const existing = current.get(next.proposal.proposalId);
              if (existing === undefined || existing.proposal !== next.proposal) return current;
              return new Map(current).set(next.proposal.proposalId, {
                proposal: next.proposal,
                sentGeneration: generation,
              });
            });
          }
        }),
      );

      const emit = (
        runtimeEvent: ProviderRuntimeEvent,
        causedByCommandId?: CloudThreadCommand["command"]["commandId"],
      ): Effect.Effect<
        CloudThreadEvent | undefined,
        WorkerRelayError | WorkerProviderError | WorkerProtocolError
      > =>
        Effect.gen(function* () {
          yield* verifyRuntimeEvent(bootstrap, runtimeEvent);
          const proposalId = yield* dependencies.ids.nextProposalId;
          const proposedAt = yield* dependencies.clock.now;
          const proposal = {
            type: "provider.event.proposed" as const,
            proposalId,
            ...(causedByCommandId === undefined ? {} : { causedByCommandId }),
            runtimeEvent,
            proposedAt,
          } satisfies WorkerRelayEventProposal;
          const admission = yield* Ref.modify(pendingProposalsRef, (current) => {
            if (current.has(proposalId)) return ["duplicate" as const, current];
            if (current.size >= options.maxPendingEventProposals) {
              return ["full" as const, current];
            }
            return [
              "accepted" as const,
              new Map(current).set(proposalId, {
                proposal,
                sentGeneration: undefined,
              }),
            ];
          });
          if (admission === "duplicate") {
            return yield* new WorkerProtocolError({
              reason: "proposal id generator returned a pending id",
              retryable: false,
            });
          }
          if (admission === "full") {
            return yield* new WorkerProviderError({
              operation: "emit",
              crashed: false,
              cause: "provider event proposal queue is full",
            });
          }
          const relayState = yield* Ref.get(relayStateRef);
          if (relayState === "connected") {
            const sent = yield* Effect.result(drainPendingProposals);
            if (sent._tag === "Failure") {
              yield* logger.warn("Provider event queued while the relay reconnects", {
                workerId: bootstrap.workerId,
                threadId: bootstrap.threadId,
                proposalId,
              });
            }
          }
          return undefined;
        });

      const startProvider = Effect.gen(function* () {
        yield* Ref.set(providerStateRef, "starting");
        const session = yield* dependencies.provider.start({
          identity: bootstrap,
          materialization,
          emit,
        });
        yield* Ref.set(providerRef, session);
        yield* Ref.set(providerStateRef, "ready");
        return session;
      });

      const restartProvider = Effect.gen(function* () {
        yield* Ref.set(providerStateRef, "restarting");
        const previous = yield* Ref.getAndSet(providerRef, undefined);
        if (previous !== undefined) yield* previous.stop.pipe(Effect.ignore);
        yield* Ref.update(providerRestartCountRef, (value) => value + 1);
        return yield* startProvider.pipe(
          Effect.tapError(() => Ref.set(providerStateRef, "failed")),
        );
      });

      const stopProvider = Effect.gen(function* () {
        const provider = yield* Ref.getAndSet(providerRef, undefined);
        if (provider !== undefined) yield* provider.stop.pipe(Effect.ignore);
        yield* Ref.set(providerStateRef, "stopped");
      });

      const ackCommand = (
        deliveryId: WorkerDeliveryId,
        commandId: CloudThreadCommand["command"]["commandId"],
        status: WorkerCommandAckStatus,
        detail?: string,
      ) =>
        dependencies.clock.now.pipe(
          Effect.flatMap((acknowledgedAt) =>
            send({
              type: "thread.command.ack",
              deliveryId,
              commandId,
              status,
              ...(detail === undefined ? {} : { detail }),
              acknowledgedAt,
            }),
          ),
        );

      const processCommand = (
        connection: WorkerRelayConnection,
        delivery: Extract<WorkerRelayInbound, { readonly type: "thread.command" }>,
      ) =>
        Effect.gen(function* () {
          const commandId = delivery.command.command.commandId;
          if (!commandMatchesBootstrap(bootstrap, delivery.command)) {
            yield* ackCommand(
              delivery.deliveryId,
              commandId,
              "rejected",
              "command identity does not match the sealed worker identity",
            );
            return;
          }
          if ((yield* Ref.get(recoveryStateRef)) === "needs-reconciliation") {
            yield* ackCommand(
              delivery.deliveryId,
              commandId,
              "needs-reconciliation",
              "worker is waiting for the control plane to reconcile an earlier in-flight command",
            );
            return;
          }
          const claim = yield* connection.claimCommand(delivery.command);
          if (claim === "completed") {
            yield* ackCommand(delivery.deliveryId, commandId, "duplicate");
            return;
          }
          if (claim === "in-flight") {
            yield* Ref.set(recoveryStateRef, "needs-reconciliation");
            yield* ackCommand(
              delivery.deliveryId,
              commandId,
              "needs-reconciliation",
              "the command was claimed previously but its side-effect outcome is unknown",
            );
            return;
          }
          yield* Ref.set(queuedCommandsRef, 1);
          const provider = yield* Ref.get(providerRef);
          if (provider === undefined) {
            yield* Ref.set(queuedCommandsRef, 0);
            yield* ackCommand(delivery.deliveryId, commandId, "failed", "provider is unavailable");
            return;
          }
          const result = yield* provider.dispatch(delivery.command).pipe(Effect.result);
          yield* Ref.set(queuedCommandsRef, 0);
          if (result._tag === "Success") {
            yield* ackCommand(delivery.deliveryId, commandId, "accepted");
            return;
          }
          yield* logger.warn("Provider command failed; restarting the selected runtime", {
            workerId: bootstrap.workerId,
            threadId: bootstrap.threadId,
            commandId,
            operation: result.failure.operation,
          });
          yield* ackCommand(delivery.deliveryId, commandId, "failed", "provider command failed");
          yield* restartProvider;
        }).pipe(Effect.ensuring(Ref.set(queuedCommandsRef, 0)));

      const processGitHubCommand = (command: WorkerGitHubCommand) =>
        github === undefined
          ? dependencies.clock.now.pipe(
              Effect.flatMap((completedAt) =>
                send({
                  type: "github.command.result",
                  operationId: command.operationId,
                  commandId: command.commandId,
                  status: "failed",
                  code: "gitFailure",
                  retryable: false,
                  detail: "hosted worker Git executor is not configured",
                  completedAt,
                }),
              ),
            )
          : executeGitHubWorkerCommand(github, command).pipe(Effect.flatMap(send));

      const processInspectorCommand = (
        command: Extract<WorkerRelayInbound, { readonly type: "inspector.command" }>["command"],
      ) => {
        const binding = command.binding;
        if (
          binding.workspaceId !== bootstrap.workspaceId ||
          binding.threadId !== bootstrap.threadId ||
          binding.environmentId !== bootstrap.environmentId ||
          binding.environmentRevisionId !== bootstrap.environmentRevisionId ||
          binding.providerInstanceId !== bootstrap.provider.instanceId ||
          binding.providerDriver !== bootstrap.provider.driver ||
          binding.sandboxId !== bootstrap.sandboxId ||
          String(binding.workerId) !== String(bootstrap.workerId)
        ) {
          return Effect.fail(
            new WorkerProtocolError({
              reason: "inspector route does not match the sealed worker identity",
              retryable: false,
            }),
          );
        }
        if (inspector === undefined) {
          return Effect.void;
        }
        return Effect.gen(function* () {
          if (
            command.type === "inspector.request" &&
            (command.operation.type === "browser.input" ||
              command.operation.type === "desktop.input")
          ) {
            const now = yield* dependencies.clock.now;
            yield* computerInputGate
              .authorizeUserInput(command.desktopPermit!, command.desktopPermit!.binding, now)
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new WorkerProtocolError({
                      reason: `desktop input authority rejected: ${cause.code}`,
                      retryable: false,
                    }),
                ),
              );
          }
          yield* inspector!.handle(command, {
            emit: (frame) =>
              send({ type: "inspector.frame", frame }).pipe(
                Effect.mapError(
                  (cause) =>
                    new InspectorRuntimeError({
                      code: "internal",
                      retryable: true,
                      operation: "relay-send",
                      cause,
                    }),
                ),
              ),
          });
        });
      };

      const acknowledgeState = (state: ConfirmationState, pending: PendingEventAck) => {
        const acknowledgedSequences = new Set(state.acknowledgedSequences);
        for (const sequence of pending.sequences) {
          if (sequence > state.safeReplayCursor) acknowledgedSequences.add(sequence);
        }
        let safeReplayCursor = state.safeReplayCursor;
        while (acknowledgedSequences.delete(safeReplayCursor + 1)) safeReplayCursor += 1;
        const pendingAcks = new Map(state.pendingAcks);
        const proposalEvents = new Map(state.proposalEvents);
        pendingAcks.delete(pending.proposalId);
        proposalEvents.delete(pending.proposalId);
        return {
          ...state,
          safeReplayCursor,
          acknowledgedSequences,
          pendingAcks,
          proposalEvents,
        } satisfies ConfirmationState;
      };

      const sendPendingAck = (pending: PendingEventAck) =>
        Effect.gen(function* () {
          const state = yield* Ref.get(confirmationStateRef);
          if (!state.pendingAcks.has(pending.proposalId)) return;
          const next = acknowledgeState(state, pending);
          const tracked = new Set(next.acknowledgedSequences);
          for (const sequence of next.bufferedBySequence.keys()) tracked.add(sequence);
          for (const events of next.proposalEvents.values()) {
            for (const sequence of events.keys()) tracked.add(sequence);
          }
          if (tracked.size > options.maxTrackedConfirmations) {
            return yield* new WorkerProtocolError({
              reason: "confirmation state exceeds the cumulative bound",
              retryable: false,
            });
          }
          const acknowledgedAt = yield* dependencies.clock.now;
          yield* send({
            type: "thread.events.ack",
            proposalId: pending.proposalId,
            eventIds: pending.eventIds,
            confirmedThroughSequence: next.safeReplayCursor,
            acknowledgedAt,
          });
          yield* Ref.set(confirmationStateRef, next);
        });

      const flushPendingAcks = Effect.gen(function* () {
        const pending = yield* Ref.get(confirmationStateRef).pipe(
          Effect.map((state) => [...state.pendingAcks.values()]),
        );
        for (const ack of pending) yield* sendPendingAck(ack);
      });

      const observeConfirmation = (confirmation: WorkerRelayEventConfirmation) =>
        Effect.gen(function* () {
          for (const event of confirmation.events) {
            if (!eventMatchesBootstrap(bootstrap, event)) {
              return yield* new WorkerProtocolError({
                reason: "confirmed event identity does not match the sealed worker identity",
                retryable: false,
              });
            }
          }

          const state = yield* Ref.get(confirmationStateRef);
          const buffered = new Map(state.bufferedBySequence);
          const proposalEvents = new Map(state.proposalEvents);
          const eventsForProposal = new Map(proposalEvents.get(confirmation.proposalId) ?? []);
          for (const event of confirmation.events) {
            const sequence = event.event.sequence;
            for (const [proposalId, tracked] of proposalEvents) {
              const existingEventId = tracked.get(sequence);
              if (
                existingEventId !== undefined &&
                (proposalId !== confirmation.proposalId || existingEventId !== event.event.eventId)
              ) {
                return yield* new WorkerProtocolError({
                  reason: "control plane confirmed conflicting events for one durable sequence",
                  retryable: false,
                });
              }
            }
            const existing = buffered.get(sequence);
            if (existing !== undefined && existing.event.event.eventId !== event.event.eventId) {
              return yield* new WorkerProtocolError({
                reason: "control plane confirmed conflicting events for one durable sequence",
                retryable: false,
              });
            }
            eventsForProposal.set(sequence, event.event.eventId);
            if (sequence > state.processedThroughSequence) {
              buffered.set(sequence, { proposalId: confirmation.proposalId, event });
            }
          }
          if (eventsForProposal.size > 64) {
            return yield* new WorkerProtocolError({
              reason: "one proposal exceeds the cumulative event acknowledgement bound",
              retryable: false,
            });
          }
          proposalEvents.set(confirmation.proposalId, eventsForProposal);
          const trackedSequences = new Set<number>(state.acknowledgedSequences);
          for (const sequence of buffered.keys()) trackedSequences.add(sequence);
          for (const tracked of proposalEvents.values()) {
            for (const sequence of tracked.keys()) trackedSequences.add(sequence);
          }
          if (trackedSequences.size > options.maxTrackedConfirmations) {
            return yield* new WorkerProtocolError({
              reason: "confirmation state exceeds the cumulative bound",
              retryable: false,
            });
          }
          yield* Ref.set(confirmationStateRef, {
            ...state,
            bufferedBySequence: buffered,
            proposalEvents,
          });
          yield* Ref.update(pendingProposalsRef, (current) => {
            const next = new Map(current);
            next.delete(confirmation.proposalId);
            return next;
          });

          for (;;) {
            const current = yield* Ref.get(confirmationStateRef);
            const nextSequence = current.processedThroughSequence + 1;
            const next = current.bufferedBySequence.get(nextSequence);
            if (next === undefined) break;
            yield* dependencies.onCloudEvent?.(next.event) ?? Effect.void;
            const nextBuffered = new Map(current.bufferedBySequence);
            nextBuffered.delete(nextSequence);
            yield* Ref.set(confirmationStateRef, {
              ...current,
              processedThroughSequence: nextSequence,
              bufferedBySequence: nextBuffered,
            });
          }

          const processed = yield* Ref.get(confirmationStateRef);
          const pendingAcks = new Map(processed.pendingAcks);
          for (const [proposalId, events] of processed.proposalEvents) {
            if (
              [...events.keys()].some((sequence) => sequence > processed.processedThroughSequence)
            ) {
              continue;
            }
            if (!pendingAcks.has(proposalId) && pendingAcks.size >= options.maxPendingEventAcks) {
              return yield* new WorkerProtocolError({
                reason: "pending event acknowledgement state exceeds the cumulative bound",
                retryable: false,
              });
            }
            const ordered = [...events].sort(([left], [right]) => left - right);
            pendingAcks.set(proposalId, {
              proposalId,
              eventIds: ordered.map(([, eventId]) => eventId),
              sequences: new Set(ordered.map(([sequence]) => sequence)),
            });
          }
          yield* Ref.set(confirmationStateRef, { ...processed, pendingAcks });
          if ((yield* Ref.get(relayStateRef)) === "connected") yield* flushPendingAcks;
        });

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* stopProvider;
          yield* inspector?.close.pipe(Effect.ignore) ?? Effect.void;
          const relay = yield* Ref.getAndSet(relayRef, undefined);
          if (relay !== undefined) yield* relay.close.pipe(Effect.ignore);
        }),
      );
      yield* startProvider;
      // Provider startup is the only consumer of the temporary credential
      // materialization. Scrub it before constructing or validating inspector
      // surfaces so a failing inspector factory cannot extend secret lifetime.
      yield* scrubMaterialization.pipe(
        Effect.mapError(
          (cause) =>
            new WorkerProviderError({
              operation: "scrub-credentials",
              crashed: false,
              cause,
            }),
        ),
      );
      if (inspector === undefined && dependencies.inspectorFactory !== undefined) {
        inspector = yield* dependencies.inspectorFactory
          .make({ bootstrap, materialization, computerInputGate })
          .pipe(
            Effect.mapError(
              (cause) =>
                new WorkerProviderError({
                  operation: "configure-inspector",
                  crashed: false,
                  cause,
                }),
            ),
          );
      }

      const runConnection: Effect.Effect<
        void,
        WorkerStoppedError | WorkerProtocolError | WorkerRelayError | WorkerProviderError,
        Scope.Scope
      > = Effect.gen(function* () {
        yield* Ref.set(relayStateRef, "connecting");
        const confirmed = yield* Ref.get(confirmationStateRef);
        const failureSignal = yield* Deferred.make<WorkerRelayError | WorkerProtocolError>();
        yield* Ref.set(relayFailureRef, failureSignal);
        const connection = yield* dependencies.relay.connect({
          identity: bootstrap,
          credentialRef: bootstrap.relayCredentialRef,
          confirmedThroughSequence: confirmed.safeReplayCursor,
        });
        yield* Ref.set(relayRef, connection);
        yield* Ref.update(connectionGenerationRef, (generation) => generation + 1);
        yield* Ref.set(relayStateRef, "replaying");
        yield* heartbeat;

        const consumeFrames = Effect.gen(function* () {
          for (;;) {
            const frame = yield* connection.receive;
            if (Option.isNone(frame)) {
              return yield* new WorkerRelayError({
                operation: "receive",
                retryable: true,
                cause: "relay connection closed",
              });
            }
            const message = yield* decodeRelayFrame(frame.value, connection.credentialChannelKey);
            switch (message.type) {
              case "thread.command":
                yield* processCommand(connection, message);
                break;
              case "github.command":
                yield* processGitHubCommand(message.command);
                break;
              case "inspector.command":
                yield* processInspectorCommand(message.command);
                break;
              case "desktop.authority":
                if (
                  message.binding.workspaceId !== bootstrap.workspaceId ||
                  message.binding.threadId !== bootstrap.threadId ||
                  message.binding.environmentId !== bootstrap.environmentId ||
                  message.binding.environmentRevisionId !== bootstrap.environmentRevisionId ||
                  message.binding.attemptId !== bootstrap.reservationId ||
                  message.binding.sandboxId !== bootstrap.sandboxId ||
                  message.binding.workerId !== bootstrap.workerId
                ) {
                  return yield* new WorkerProtocolError({
                    reason: "desktop authority does not match the sealed worker identity",
                    retryable: false,
                  });
                }
                yield* computerInputGate.update(message).pipe(
                  Effect.mapError(
                    (cause: AgentComputerInputGateError) =>
                      new WorkerProtocolError({
                        reason: `desktop authority update rejected: ${cause.code}`,
                        retryable: false,
                      }),
                  ),
                );
                break;
              case "thread.events.confirmed":
                yield* observeConfirmation(message);
                break;
              case "replay.complete": {
                const state = yield* Ref.get(confirmationStateRef);
                if (message.confirmedThroughSequence !== state.processedThroughSequence) {
                  return yield* new WorkerProtocolError({
                    reason: "replay cursor does not match the events processed by the worker",
                    retryable: false,
                  });
                }
                yield* Ref.set(relayStateRef, "connected");
                yield* flushPendingAcks;
                yield* drainPendingProposals;
                yield* send({ type: "worker.ready", health: yield* health });
                break;
              }
              case "worker.shutdown":
                return yield* new WorkerStoppedError({
                  workerId: bootstrap.workerId,
                  threadId: bootstrap.threadId,
                  reason: message.reason,
                });
              case "provider.credentials.command": {
                if (dependencies.providerCredentials === undefined) {
                  return yield* new WorkerProtocolError({
                    reason: "hosted provider credential executor is unavailable",
                    retryable: false,
                  });
                }
                yield* providerCredentialLock
                  .withPermits(1)(
                    dependencies.providerCredentials.execute(message, undefined, (result) =>
                      send(result).pipe(
                        Effect.mapError(
                          (cause) =>
                            new WorkerProviderCredentialError({
                              code: "writeFailed",
                              operation: "emit-result",
                              cause,
                            }),
                        ),
                      ),
                    ),
                  )
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new WorkerProviderError({
                          operation: "provider-credentials",
                          crashed: false,
                          cause,
                        }),
                    ),
                    Effect.forkScoped,
                  );
                break;
              }
              case "provider.credentials.binary": {
                if (dependencies.providerCredentials === undefined) {
                  message.credentialPayload.fill(0);
                  return yield* new WorkerProtocolError({
                    reason: "hosted provider credential executor is unavailable",
                    retryable: false,
                  });
                }
                yield* providerCredentialLock
                  .withPermits(1)(
                    dependencies.providerCredentials.execute(
                      message.command,
                      message.credentialPayload,
                      (result) =>
                        send(result).pipe(
                          Effect.mapError(
                            (cause) =>
                              new WorkerProviderCredentialError({
                                code: "writeFailed",
                                operation: "emit-result",
                                cause,
                              }),
                          ),
                        ),
                    ),
                  )
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new WorkerProviderError({
                          operation: "provider-credentials",
                          crashed: false,
                          cause,
                        }),
                    ),
                    Effect.ensuring(
                      Effect.sync(() => {
                        message.credentialPayload.fill(0);
                      }),
                    ),
                    Effect.forkScoped,
                  );
                break;
              }
            }
            yield* heartbeat;
          }
        });
        const periodicHeartbeats = Effect.forever(
          options.heartbeatInterval.pipe(Effect.andThen(heartbeat)),
        );
        const signaledFailure = Deferred.await(failureSignal).pipe(Effect.flatMap(Effect.fail));
        return yield* Effect.raceFirst(
          consumeFrames,
          Effect.raceFirst(periodicHeartbeats, signaledFailure),
        );
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* Ref.set(relayStateRef, "connecting");
            yield* Ref.set(relayFailureRef, undefined);
            const connection = yield* Ref.getAndSet(relayRef, undefined);
            if (connection !== undefined) yield* connection.close.pipe(Effect.ignore);
          }),
        ),
      );

      const reconnect: () => Effect.Effect<
        void,
        WorkerStoppedError | WorkerProtocolError | WorkerProviderError,
        Scope.Scope
      > = () =>
        runConnection.pipe(
          Effect.catch((cause) => {
            if (isWorkerStoppedError(cause)) return Effect.fail(cause);
            if (isWorkerProtocolError(cause)) return Effect.fail(cause);
            if (!isWorkerRelayError(cause) || !cause.retryable) {
              return Effect.fail(
                new WorkerProtocolError({
                  reason: "worker relay failed permanently",
                  retryable: false,
                  cause,
                }),
              );
            }
            return logger
              .warn("Worker relay disconnected; requesting durable replay", {
                workerId: bootstrap.workerId,
                threadId: bootstrap.threadId,
                operation: cause.operation,
              })
              .pipe(
                Effect.andThen(options.beforeReconnect),
                Effect.andThen(Effect.suspend(reconnect)),
              );
          }),
        );

      yield* reconnect().pipe(Effect.catchTag("WorkerStoppedError", () => Effect.void));
    }),
  );
