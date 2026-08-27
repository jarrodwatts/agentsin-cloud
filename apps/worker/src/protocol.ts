import type { CloudThreadCommand, CloudThreadEvent } from "@t3tools/contracts/cloud";
import {
  WorkerRelayInbound,
  WorkerRelayOutbound,
  type WorkerBootstrap,
} from "@t3tools/contracts/worker";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { WorkerProtocolError } from "./errors.ts";

export const WORKER_RELAY_FRAME_MAX_BYTES = 512 * 1024;
export const WORKER_RELAY_OUTBOUND_MAX_BYTES = 512 * 1024;

const decodeInboundJson = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkerRelayInbound));
const encodeOutboundJson = Schema.encodeUnknownEffect(Schema.fromJsonString(WorkerRelayOutbound));
const isWorkerProtocolError = Schema.is(WorkerProtocolError);

export const decodeRelayFrame = (
  frame: Uint8Array,
): Effect.Effect<WorkerRelayInbound, WorkerProtocolError> =>
  Effect.gen(function* () {
    if (frame.byteLength > WORKER_RELAY_FRAME_MAX_BYTES) {
      return yield* new WorkerProtocolError({
        reason: "relay frame exceeds the worker payload limit",
        retryable: false,
      });
    }
    const text = Buffer.from(frame).toString("utf8");
    return yield* decodeInboundJson(text).pipe(
      Effect.mapError(
        (cause) =>
          new WorkerProtocolError({
            reason: "relay frame is malformed",
            retryable: false,
            cause,
          }),
      ),
    );
  });

export const assertOutboundWithinLimit = (
  outbound: WorkerRelayOutbound,
): Effect.Effect<void, WorkerProtocolError> =>
  encodeOutboundJson(outbound).pipe(
    Effect.flatMap((json) =>
      Buffer.byteLength(json, "utf8") <= WORKER_RELAY_OUTBOUND_MAX_BYTES
        ? Effect.void
        : Effect.fail(
            new WorkerProtocolError({
              reason: "worker outbound payload exceeds the relay limit",
              retryable: false,
            }),
          ),
    ),
    Effect.mapError((cause) =>
      isWorkerProtocolError(cause)
        ? cause
        : new WorkerProtocolError({
            reason: "worker outbound payload cannot be encoded",
            retryable: false,
            cause,
          }),
    ),
  );

export const commandMatchesBootstrap = (
  bootstrap: WorkerBootstrap,
  command: CloudThreadCommand,
): boolean => {
  if (
    command.workspaceId !== bootstrap.workspaceId ||
    command.environmentId !== bootstrap.environmentId ||
    command.threadId !== bootstrap.threadId ||
    !("threadId" in command.command) ||
    command.command.threadId !== bootstrap.threadId
  ) {
    return false;
  }

  const orchestration = command.command;
  const selection = "modelSelection" in orchestration ? orchestration.modelSelection : undefined;
  if (selection !== undefined && selection !== null) {
    return selection.instanceId === bootstrap.provider.instanceId;
  }
  const bootstrapSelection =
    orchestration.type === "thread.turn.start"
      ? orchestration.bootstrap?.createThread?.modelSelection
      : undefined;
  return (
    bootstrapSelection === undefined ||
    bootstrapSelection.instanceId === bootstrap.provider.instanceId
  );
};

export const eventMatchesBootstrap = (
  bootstrap: WorkerBootstrap,
  event: CloudThreadEvent,
): boolean =>
  event.workspaceId === bootstrap.workspaceId &&
  event.environmentId === bootstrap.environmentId &&
  event.threadId === bootstrap.threadId &&
  event.event.aggregateId === bootstrap.threadId;
