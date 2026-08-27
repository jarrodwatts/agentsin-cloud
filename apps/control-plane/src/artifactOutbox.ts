import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";

import type {
  ArtifactOutboxRecord,
  ArtifactRepository,
  ArtifactRepositoryError,
} from "./artifactRepository.ts";
import type { ArtifactStorageError, ArtifactStorageService } from "./artifactStorage.ts";

const iso = (epochMillis: number) => DateTime.formatIso(DateTime.makeUnsafe(epochMillis));

export interface ArtifactOutboxProcessor {
  readonly runOnce: Effect.Effect<number, ArtifactRepositoryError>;
  readonly drain: Effect.Effect<never, never>;
}

export const startArtifactOutboxDrain = (processor: ArtifactOutboxProcessor) =>
  processor.drain.pipe(Effect.forkScoped);

export const makeArtifactOutboxProcessor = (options: {
  readonly repository: ArtifactRepository;
  readonly storage: ArtifactStorageService;
  readonly clock?: { readonly now: () => number };
  readonly batchSize?: number;
  readonly maxAttempts?: number;
  readonly leaseMs?: number;
  readonly renewalMs?: number;
  readonly idleMs?: number;
}): ArtifactOutboxProcessor => {
  const now = options.clock?.now ?? Date.now;
  const batchSize = options.batchSize ?? 10;
  const maxAttempts = options.maxAttempts ?? 5;
  const leaseMs = options.leaseMs ?? 180_000;
  const renewalMs = Math.max(
    1,
    Math.min(options.renewalMs ?? Math.floor(leaseMs / 3), leaseMs - 1),
  );
  const idleMs = options.idleMs ?? 1_000;

  const process = (item: ArtifactOutboxRecord) =>
    Effect.raceFirst(
      Effect.gen(function* () {
        if (item.operation === "verify_upload") {
          yield* options.storage.reconcile(item.workspaceId, item.threadId, item.artifactId);
        } else {
          yield* options.storage.delete(item.workspaceId, item.threadId, item.artifactId);
        }
        yield* options.repository.completeOutbox(item, iso(now()));
      }),
      Effect.forever(
        Effect.sleep(renewalMs).pipe(
          Effect.andThen(
            Effect.sync(() => {
              const current = now();
              return { current, expiresAt: current + leaseMs };
            }),
          ),
          Effect.flatMap(({ current, expiresAt }) =>
            options.repository.renewOutbox(item, iso(current), iso(expiresAt)),
          ),
        ),
      ),
    ).pipe(
      Effect.catch((cause: ArtifactRepositoryError | ArtifactStorageError) => {
        const current = now();
        const backoffMs = Math.min(60_000, 1_000 * 2 ** Math.max(0, item.attemptCount - 1));
        return options.repository
          .failOutbox(item, iso(current), iso(current + backoffMs), cause.code)
          .pipe(Effect.catch(() => Effect.void));
      }),
    );

  const runOnce = Effect.gen(function* () {
    const current = now();
    yield* options.repository.requeueExpiredOutbox(iso(current), batchSize * 4);
    const claimed = yield* options.repository.claimOutbox({
      now: iso(current),
      leaseExpiresAt: iso(current + leaseMs),
      limit: batchSize,
      maxAttempts,
    });
    yield* Effect.forEach(claimed, process, { concurrency: 3, discard: true });
    return claimed.length;
  });

  const drain = Effect.forever(
    runOnce.pipe(
      Effect.catch((cause) =>
        Effect.logError("Artifact outbox drain failed", cause).pipe(Effect.as(0)),
      ),
      Effect.flatMap((processed) => (processed === 0 ? Effect.sleep(idleMs) : Effect.void)),
    ),
  );
  return { runOnce, drain };
};
