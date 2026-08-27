import { ThreadId } from "@t3tools/contracts";
import { WorkerInstanceId } from "@t3tools/contracts/worker";
import * as Schema from "effect/Schema";

export class WorkerBootstrapError extends Schema.TaggedErrorClass<WorkerBootstrapError>()(
  "WorkerBootstrapError",
  {
    reason: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class WorkerRelayError extends Schema.TaggedErrorClass<WorkerRelayError>()(
  "WorkerRelayError",
  {
    operation: Schema.String,
    retryable: Schema.Boolean,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class WorkerProviderError extends Schema.TaggedErrorClass<WorkerProviderError>()(
  "WorkerProviderError",
  {
    operation: Schema.String,
    crashed: Schema.Boolean,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class WorkerSecretLeaseError extends Schema.TaggedErrorClass<WorkerSecretLeaseError>()(
  "WorkerSecretLeaseError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class WorkerProtocolError extends Schema.TaggedErrorClass<WorkerProtocolError>()(
  "WorkerProtocolError",
  {
    reason: Schema.String,
    retryable: Schema.Boolean,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class WorkerStoppedError extends Schema.TaggedErrorClass<WorkerStoppedError>()(
  "WorkerStoppedError",
  {
    workerId: WorkerInstanceId,
    threadId: ThreadId,
    reason: Schema.String,
  },
) {}

export const CloudWorkerError = Schema.Union([
  WorkerBootstrapError,
  WorkerRelayError,
  WorkerProviderError,
  WorkerSecretLeaseError,
  WorkerProtocolError,
  WorkerStoppedError,
]);
export type CloudWorkerError = typeof CloudWorkerError.Type;
