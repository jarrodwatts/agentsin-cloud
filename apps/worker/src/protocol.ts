import type { CloudThreadCommand, CloudThreadEvent } from "@t3tools/contracts/cloud";
import {
  WorkerRelayInbound,
  WorkerRelayOutbound,
  WorkerProviderCredentialCommand,
  type WorkerBootstrap,
} from "@t3tools/contracts/worker";
import { isCredentialBinaryFrame } from "@t3tools/contracts/credential-binary";
import { openCredentialBinaryFrame } from "@t3tools/shared/credentialRelayCrypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { WorkerProtocolError } from "./errors.ts";

// Credential frames are rare, direct mTLS messages and may contain a bounded
// one-megabyte opaque provider profile. They are never part of durable replay.
export const WORKER_RELAY_FRAME_MAX_BYTES = 2 * 1024 * 1024;
export const WORKER_RELAY_OUTBOUND_MAX_BYTES = 2 * 1024 * 1024;

const decodeInboundJson = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkerRelayInbound));
const encodeOutboundJson = Schema.encodeUnknownEffect(Schema.fromJsonString(WorkerRelayOutbound));
const isWorkerProtocolError = Schema.is(WorkerProtocolError);

export type DecodedWorkerRelayFrame =
  | WorkerRelayInbound
  | {
      readonly type: "provider.credentials.binary";
      readonly command: Extract<
        WorkerProviderCredentialCommand,
        { readonly operation: "materialize" }
      >;
      readonly credentialPayload: Uint8Array;
    };

const decodeCredentialCommand = Schema.decodeUnknownSync(WorkerProviderCredentialCommand);

export const decodeRelayFrame = (
  frame: Uint8Array,
  credentialChannelKey?: Uint8Array,
): Effect.Effect<DecodedWorkerRelayFrame, WorkerProtocolError> =>
  Effect.gen(function* () {
    if (frame.byteLength > WORKER_RELAY_FRAME_MAX_BYTES) {
      return yield* new WorkerProtocolError({
        reason: "relay frame exceeds the worker payload limit",
        retryable: false,
      });
    }
    if (isCredentialBinaryFrame(frame)) {
      return yield* Effect.try({
        try: () => {
          if (credentialChannelKey === undefined) throw new Error("credential channel unavailable");
          const decoded = openCredentialBinaryFrame({ key: credentialChannelKey, frame });
          try {
            const command = decodeCredentialCommand(decoded.header.control);
            if (
              decoded.header.kind !== "materialize" ||
              command.operation !== "materialize" ||
              command.operationId !== decoded.header.operationId ||
              command.routeGeneration !== decoded.header.routeGeneration ||
              command.credentialPayloadBytes !== decoded.plaintext.byteLength
            ) {
              throw new Error("credential frame context mismatch");
            }
            return {
              type: "provider.credentials.binary" as const,
              command,
              credentialPayload: decoded.plaintext,
            };
          } catch (cause) {
            decoded.plaintext.fill(0);
            throw cause;
          }
        },
        catch: (cause) =>
          new WorkerProtocolError({
            reason: "credential relay frame is malformed",
            retryable: false,
            cause,
          }),
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
