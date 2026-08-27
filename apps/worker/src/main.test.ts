// @effect-diagnostics nodeBuiltinImport:off -- Tests use disposable roots and a fake PTY.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import { InspectorWorkerFrame } from "@t3tools/contracts/inspector";
import { WorkerBootstrap } from "@t3tools/contracts/worker";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { WORKER_BOOTSTRAP_FILE_ENV, type WorkerBootstrapFileSource } from "./bootstrap.ts";
import {
  WORKER_EXECUTION_MODE_ENV,
  WORKER_MTLS_CREDENTIAL_DIRECTORY_ENV,
  makeHostedInspectorFactory,
  runWorkerMain,
  selectWorkerProcessDependencies,
} from "./main.ts";
import type { CloudWorkerDependencies } from "./CloudWorker.ts";
import type { InspectorPtySandbox } from "./InspectorPtySandbox.ts";
import type { WorkerSecretMaterialization } from "./ports.ts";

const bootstrapText = `{"schemaVersion":1,"workerId":"worker-1","workspaceId":"workspace-1","environmentId":"environment-1","environmentRevisionId":"revision-1","threadId":"thread-1","sandboxId":"sandbox-1","reservationId":"command-reserve-1","provider":{"instanceId":"codex_personal","driver":"codex"},"workspaceDirectory":"/workspace/project","bootstrapEndpoint":"https://control.example.com/api/v1/worker-certificates/bootstrap","relayEndpoint":"wss://control.example.com/worker","relayServerSpkiSha256":"sha256/47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=","relayCredentialRef":"relay-ref-1","secretLeaseRef":"lease-ref-1","issuedAt":"2026-08-27T00:25:00.000Z","expiresAt":"2026-08-27T00:40:00.000Z"}`;
const decodeBootstrapText = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkerBootstrap));
const encodeInspectorFrames = Schema.encodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(InspectorWorkerFrame)),
);

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
            makeInspectorOutputRedactor: () => (chunk) => chunk,
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

it.effect("composes hosted PTY isolation with broker-owned split-chunk redaction", () =>
  Effect.scoped(
    Effect.acquireRelease(
      Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agentsin-c6-hosted-inspector-")),
      ),
      (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    ).pipe(
      Effect.flatMap((root) =>
        Effect.gen(function* () {
          let dataListener: ((chunk: string) => void) | undefined;
          let exitListener:
            | ((event: { readonly exitCode: number; readonly signal: number }) => void)
            | undefined;
          const fakePty = {
            pid: 1,
            write: () => undefined,
            resize: () => undefined,
            kill: () => exitListener?.({ exitCode: 0, signal: 0 }),
            onData: (listener: (chunk: string) => void) => {
              dataListener = listener;
              return { dispose: () => undefined };
            },
            onExit: (
              listener: (event: { readonly exitCode: number; readonly signal: number }) => void,
            ) => {
              exitListener = listener;
              return { dispose: () => undefined };
            },
          };
          const ptySandbox: InspectorPtySandbox = {
            filesystemIsolated: true,
            networkIsolated: true,
            spawn: () => fakePty as never,
          };
          const secret = "broker-secret-value";
          const materialization = {
            leaseRef: "lease-ref-1" as never,
            credentialDirectory: "/run/agentsin/credentials",
            environmentVariableNames: ["CODEX_HOME"],
            containsWalletMaterial: false,
            makeInspectorOutputRedactor: () => {
              let buffered = "";
              return (chunk: string, final = false) => {
                buffered += chunk;
                const scanThrough = final
                  ? buffered.length
                  : Math.max(0, buffered.length - secret.length + 1);
                let output = "";
                let offset = 0;
                while (offset < scanThrough) {
                  if (buffered.startsWith(secret, offset)) {
                    output += "[REDACTED]";
                    offset += secret.length;
                  } else {
                    output += buffered[offset];
                    offset += 1;
                  }
                }
                buffered = buffered.slice(offset);
                return output;
              };
            },
            scrub: Effect.void,
          } satisfies WorkerSecretMaterialization;
          const decodedBootstrap = yield* decodeBootstrapText(bootstrapText).pipe(Effect.orDie);
          const bootstrap = {
            ...decodedBootstrap,
            workspaceDirectory: root,
          } as WorkerBootstrap;
          const runtime = yield* makeHostedInspectorFactory({
            mtlsDirectory: "/run/agentsin/mtls",
            bootstrapPath: "/run/secrets/bootstrap.json",
            loadPty: async () => ({ spawn: () => fakePty }) as never,
            ptySandbox,
            requireLinuxDescriptorTraversal: false,
          }).make({ bootstrap, materialization });
          const frames: Array<InspectorWorkerFrame> = [];
          const binding = {
            protocolVersion: 1 as const,
            workspaceId: bootstrap.workspaceId,
            threadId: bootstrap.threadId,
            attemptId: "attempt-1" as never,
            environmentId: bootstrap.environmentId,
            environmentRevisionId: bootstrap.environmentRevisionId,
            providerInstanceId: bootstrap.provider.instanceId,
            providerDriver: bootstrap.provider.driver,
            sandboxId: bootstrap.sandboxId,
            workerId: bootstrap.workerId as never,
            routeGeneration: 1,
          };
          const sink = {
            emit: (frame: InspectorWorkerFrame) =>
              Effect.sync(() => {
                frames.push(frame);
              }),
          };
          yield* runtime.handle(
            {
              type: "inspector.open",
              binding,
              sessionId: "session-1" as never,
              resumeAfterSequence: -1,
            },
            sink,
          );
          yield* runtime.handle(
            {
              type: "inspector.request",
              binding,
              sessionId: "session-1" as never,
              operation: {
                type: "terminal.open",
                requestId: "open-pty" as never,
                terminalId: "pty-1" as never,
                executable: "shell",
                columns: 80,
                rows: 24,
              },
            },
            sink,
          );
          yield* runtime.drain;
          dataListener?.("token=broker-");
          dataListener?.("secret-value\n");
          fakePty.kill();
          yield* runtime.drain;
          const serialized = yield* encodeInspectorFrames(frames).pipe(Effect.orDie);
          expect(serialized).not.toContain(secret);
          expect(serialized).toContain("[REDACTED]");
          yield* runtime.close;
        }),
      ),
    ),
  ),
);

it.effect("rejects a hosted inspector workspace that overlaps credential storage", () =>
  Effect.gen(function* () {
    const decodedBootstrap = yield* decodeBootstrapText(bootstrapText).pipe(Effect.orDie);
    const materialization = {
      leaseRef: "lease-ref-1" as never,
      credentialDirectory: "/run/agentsin/credentials",
      environmentVariableNames: ["CODEX_HOME"],
      containsWalletMaterial: false,
      makeInspectorOutputRedactor: () => (chunk: string) => chunk,
      scrub: Effect.void,
    } satisfies WorkerSecretMaterialization;
    const result = yield* Effect.result(
      makeHostedInspectorFactory({
        mtlsDirectory: "/run/agentsin/mtls",
        requireLinuxDescriptorTraversal: false,
      }).make({
        bootstrap: {
          ...decodedBootstrap,
          workspaceDirectory: "/run/agentsin/credentials/workspace",
        },
        materialization,
      }),
    );
    expect(result._tag).toBe("Failure");
  }),
);

it.effect("rejects reuse of the provider runtime identity for an inspector PTY", () =>
  Effect.gen(function* () {
    const bootstrap = yield* decodeBootstrapText(bootstrapText).pipe(Effect.orDie);
    const materialization = {
      leaseRef: "lease-ref-1" as never,
      credentialDirectory: "/run/agentsin/credentials",
      environmentVariableNames: ["CODEX_HOME"],
      containsWalletMaterial: false,
      makeInspectorOutputRedactor: () => (chunk: string) => chunk,
      scrub: Effect.void,
    } satisfies WorkerSecretMaterialization;
    const result = yield* Effect.result(
      makeHostedInspectorFactory({
        mtlsDirectory: "/run/agentsin/mtls",
        agentUid: 65_533,
        agentGid: 65_533,
        inspectorUid: 65_533,
        inspectorGid: 65_533,
        loadPty: async () => ({ spawn: () => undefined }) as never,
        requireLinuxDescriptorTraversal: false,
      }).make({ bootstrap, materialization }),
    );
    expect(result._tag).toBe("Failure");
  }),
);
