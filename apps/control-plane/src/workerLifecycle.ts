import type { EventId, IsoDateTime } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ThreadEventStoreService } from "./threadEventStore.ts";
import { WorkerIdentityError, type WorkerLifecycleRecorder } from "./workerIdentity.ts";

export const makeThreadEventStoreWorkerLifecycleRecorder = (input: {
  readonly eventStore: ThreadEventStoreService;
  readonly nextLifecycleId: Effect.Effect<EventId>;
}): WorkerLifecycleRecorder => ({
  record: (record) =>
    Effect.gen(function* () {
      const lifecycleId = yield* input.nextLifecycleId;
      yield* input.eventStore.appendLifecycle({
        workspaceId: record.identity.workspaceId,
        threadId: record.identity.threadId,
        lifecycleId,
        resourceKind: "worker",
        resourceId: record.identity.workerId,
        state: record.state,
        payload: {
          sandboxId: record.identity.sandboxId,
          reservationId: record.identity.reservationId,
          environmentId: record.identity.environmentId,
          environmentRevisionId: record.identity.environmentRevisionId,
          providerInstanceId: record.identity.providerInstanceId,
          providerDriver: record.identity.providerDriver,
          ...(record.details === undefined ? {} : { details: record.details }),
        },
        occurredAt: record.occurredAt as IsoDateTime,
      });
    }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkerIdentityError({ code: "storeFailed", operation: "record-lifecycle", cause }),
      ),
    ),
});
