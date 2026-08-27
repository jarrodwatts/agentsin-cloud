import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { WORKER_BOOTSTRAP_FILE_ENV, type WorkerBootstrapFileSource } from "./bootstrap.ts";
import {
  WORKER_EXECUTION_MODE_ENV,
  WORKER_MTLS_CREDENTIAL_DIRECTORY_ENV,
  runWorkerMain,
  selectWorkerProcessDependencies,
} from "./main.ts";
import type { CloudWorkerDependencies } from "./CloudWorker.ts";

const bootstrapText = `{"schemaVersion":1,"workerId":"worker-1","workspaceId":"workspace-1","environmentId":"environment-1","environmentRevisionId":"revision-1","threadId":"thread-1","sandboxId":"sandbox-1","reservationId":"command-reserve-1","provider":{"instanceId":"codex_personal","driver":"codex"},"workspaceDirectory":"/workspace/project","bootstrapEndpoint":"https://control.example.com/api/v1/worker-certificates/bootstrap","relayEndpoint":"wss://control.example.com/worker","relayServerSpkiSha256":"sha256/47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=","relayCredentialRef":"relay-ref-1","secretLeaseRef":"lease-ref-1","issuedAt":"2026-08-27T00:25:00.000Z","expiresAt":"2026-08-27T00:40:00.000Z"}`;

it.effect("selects the concrete Node mTLS relay only in fail-closed hosted mode", () =>
  Effect.gen(function* () {
    const injectedRelay = {} as CloudWorkerDependencies["relay"];
    const injectedGitHub = {} as NonNullable<CloudWorkerDependencies["github"]>;
    const dependencies = {
      relay: injectedRelay,
      github: injectedGitHub,
    } as CloudWorkerDependencies;
    const hosted = yield* selectWorkerProcessDependencies(
      dependencies,
      {
        [WORKER_EXECUTION_MODE_ENV]: "hosted",
        [WORKER_MTLS_CREDENTIAL_DIRECTORY_ENV]: "/run/agentsin/mtls",
      },
      0,
    );
    expect(hosted.relay).not.toBe(injectedRelay);
    expect(hosted.github).toBeDefined();
    expect(hosted.github).not.toBe(injectedGitHub);

    const missingDirectory = yield* Effect.result(
      selectWorkerProcessDependencies(
        dependencies,
        {
          [WORKER_EXECUTION_MODE_ENV]: "hosted",
        },
        0,
      ),
    );
    expect(missingDirectory._tag).toBe("Failure");
  }),
);

it.effect("interrupts provider work and scrubs leased credentials on termination", () =>
  Effect.gen(function* () {
    const providerStarted = yield* Deferred.make<void>();
    const relayConnected = yield* Deferred.make<void>();
    let providerStops = 0;
    let relayCloses = 0;
    let scrubs = 0;
    const dependencies: CloudWorkerDependencies = {
      relay: {
        connect: () =>
          Deferred.succeed(relayConnected, undefined).pipe(
            Effect.as({
              credentialChannelKey: new Uint8Array(32),
              receive: Effect.never.pipe(Effect.as(Option.none())),
              claimCommand: () => Effect.succeed("execute" as const),
              send: () => Effect.void,
              close: Effect.sync(() => {
                relayCloses += 1;
              }),
            }),
          ),
      },
      provider: {
        start: () =>
          Deferred.succeed(providerStarted, undefined).pipe(
            Effect.as({
              dispatch: () => Effect.void,
              health: Effect.succeed("ready" as const),
              stop: Effect.sync(() => {
                providerStops += 1;
              }),
            }),
          ),
      },
      secretLease: {
        materialize: ({ leaseRef }) =>
          Effect.succeed({
            leaseRef,
            credentialDirectory: "/run/agentsin/credentials",
            environmentVariableNames: ["CODEX_HOME"],
            containsWalletMaterial: false,
            scrub: Effect.sync(() => {
              scrubs += 1;
            }),
          }),
      },
      clock: { now: Effect.succeed("2026-08-27T00:30:00.000Z") },
      ids: { nextProposalId: Effect.succeed("proposal-1" as never) },
      logger: {
        info: () => Effect.void,
        warn: () => Effect.void,
        error: () => Effect.void,
      },
    };
    const source: WorkerBootstrapFileSource = {
      currentUid: 501,
      openNoFollow: () =>
        Effect.acquireRelease(
          Effect.succeed({
            stat: Effect.succeed({
              bytes: bootstrapText.length,
              mode: 0o100600,
              ownerUid: 501,
              regularFile: true,
            }),
            readBounded: () => Effect.succeed(bootstrapText),
          }),
          () => Effect.void,
        ),
    };
    yield* runWorkerMain(dependencies, {
      env: {
        [WORKER_EXECUTION_MODE_ENV]: "injected",
        [WORKER_BOOTSTRAP_FILE_ENV]: "/run/secrets/bootstrap.json",
      },
      currentUid: 501,
      bootstrapSource: source,
      termination: Effect.all([Deferred.await(providerStarted), Deferred.await(relayConnected)]),
    });
    expect(providerStops).toBe(1);
    expect(relayCloses).toBe(1);
    expect(scrubs).toBe(1);
  }),
);

it.effect("fails closed before startup for missing or root-injected execution modes", () =>
  Effect.gen(function* () {
    const dependencies = {} as CloudWorkerDependencies;
    for (const env of [{}, { [WORKER_EXECUTION_MODE_ENV]: "injected" }]) {
      const result = yield* Effect.result(selectWorkerProcessDependencies(dependencies, env, 0));
      expect(result._tag).toBe("Failure");
    }
    const explicitNonRoot = yield* selectWorkerProcessDependencies(
      dependencies,
      { [WORKER_EXECUTION_MODE_ENV]: "injected" },
      501,
    );
    expect(explicitNonRoot).toBe(dependencies);
  }),
);
