// @effect-diagnostics nodeBuiltinImport:off -- The hermetic canary models the installed Node boundary.
// @effect-diagnostics globalDateInEffect:off -- The canary owns a real wall-clock sealed bootstrap window.
import * as NodeCrypto from "node:crypto";

import { WorkerBootstrap, WorkerRelayInbound } from "@t3tools/contracts/worker";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { CloudWorkerDependencies } from "./CloudWorker.ts";
import { WORKER_BOOTSTRAP_FILE_ENV, type WorkerBootstrapFileSource } from "./bootstrap.ts";
import {
  WORKER_EXECUTION_MODE_ENV,
  WORKER_MTLS_CREDENTIAL_DIRECTORY_ENV,
  runWorkerMain,
  selectWorkerProcessDependencies,
} from "./main.ts";

const encodeInbound = Schema.encodeUnknownSync(Schema.fromJsonString(WorkerRelayInbound));
const encodeBootstrap = Schema.encodeUnknownSync(Schema.fromJsonString(WorkerBootstrap));

export interface WorkerImageCanaryResult {
  readonly hostedRelaySelected: boolean;
  readonly providerStarts: number;
  readonly providerStops: number;
  readonly relayConnects: number;
  readonly relayCloses: number;
  readonly credentialScrubs: number;
  readonly outboundTypes: ReadonlyArray<string>;
}

/**
 * Staging-shaped but hermetic: it boots the same worker runtime from an
 * owner-only sealed bootstrap, proves hosted mode selects the concrete mTLS
 * connector, and exercises replay/heartbeat/shutdown with an in-memory relay.
 * It performs no DNS, E2B, control-plane, provider, or filesystem writes.
 */
export const runHermeticWorkerImageCanary = () =>
  Effect.gen(function* () {
    const now = new Date();
    const issuedAt = new Date(now.getTime() - 60_000).toISOString();
    const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
    const bootstrapText = encodeBootstrap({
      schemaVersion: 1,
      workerId: "worker-image-canary",
      workspaceId: "workspace-image-canary",
      environmentId: "environment-image-canary",
      environmentRevisionId: "revision-image-canary",
      threadId: "thread-image-canary",
      sandboxId: "sandbox-image-canary",
      reservationId: "command-image-canary",
      provider: { instanceId: "codex_personal", driver: "codex" },
      workspaceDirectory: "/workspace/project",
      bootstrapEndpoint: "https://control.invalid/api/v1/worker-certificates/bootstrap",
      relayEndpoint: "wss://relay.invalid/worker",
      relayServerSpkiSha256: "sha256/47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
      relayCredentialRef: "relay-image-canary",
      secretLeaseRef: "lease-image-canary",
      issuedAt,
      expiresAt,
    } as never);
    const source: WorkerBootstrapFileSource = {
      currentUid: 11_001,
      openNoFollow: () =>
        Effect.acquireRelease(
          Effect.succeed({
            stat: Effect.succeed({
              bytes: Buffer.byteLength(bootstrapText),
              mode: 0o100600,
              ownerUid: 11_001,
              regularFile: true,
            }),
            readBounded: () => Effect.succeed(bootstrapText),
          }),
          () => Effect.void,
        ),
    };
    let providerStarts = 0;
    let providerStops = 0;
    let relayConnects = 0;
    let relayCloses = 0;
    let credentialScrubs = 0;
    const outboundTypes: Array<string> = [];
    const inbound = [
      encodeInbound({ type: "replay.complete", confirmedThroughSequence: -1 }),
      encodeInbound({ type: "worker.shutdown", reason: "image canary complete" }),
    ];
    const dependencies: CloudWorkerDependencies = {
      relay: {
        connect: () =>
          Effect.sync(() => {
            relayConnects += 1;
            return {
              credentialChannelKey: NodeCrypto.randomBytes(32),
              receive: Effect.sync(() => {
                const frame = inbound.shift();
                return frame === undefined
                  ? Option.none<Uint8Array>()
                  : Option.some(Buffer.from(frame, "utf8"));
              }),
              claimCommand: () => Effect.succeed("execute" as const),
              send: (message) =>
                Effect.sync(() => {
                  outboundTypes.push(message.type);
                }),
              close: Effect.sync(() => {
                relayCloses += 1;
              }),
            };
          }),
      },
      provider: {
        start: () =>
          Effect.sync(() => {
            providerStarts += 1;
            return {
              dispatch: () => Effect.void,
              health: Effect.succeed("ready" as const),
              stop: Effect.sync(() => {
                providerStops += 1;
              }),
            };
          }),
      },
      secretLease: {
        materialize: ({ leaseRef }) =>
          Effect.succeed({
            leaseRef,
            credentialDirectory: "/run/agentsin/provider/image-canary",
            environmentVariableNames: [],
            containsWalletMaterial: false,
            makeInspectorOutputRedactor: () => (chunk: string) => chunk,
            scrub: Effect.sync(() => {
              credentialScrubs += 1;
            }),
          }),
      },
      clock: { now: Effect.succeed(now.toISOString()) },
      ids: { nextProposalId: Effect.succeed("proposal-image-canary" as never) },
      logger: { info: () => Effect.void, warn: () => Effect.void, error: () => Effect.void },
    };
    const hosted = yield* selectWorkerProcessDependencies(
      dependencies,
      {
        [WORKER_EXECUTION_MODE_ENV]: "hosted",
        [WORKER_MTLS_CREDENTIAL_DIRECTORY_ENV]: "/run/agentsin/mtls",
      },
      0,
    );
    const hostedRelaySelected = hosted.relay !== dependencies.relay && hosted.github !== undefined;
    if (!hostedRelaySelected) return yield* Effect.die("hosted mTLS relay was not selected");

    yield* runWorkerMain(dependencies, {
      env: {
        [WORKER_EXECUTION_MODE_ENV]: "injected",
        [WORKER_BOOTSTRAP_FILE_ENV]: "/run/agentsin/bootstrap/sealed.json",
      },
      currentUid: 11_001,
      bootstrapSource: source,
    });

    if (
      providerStarts !== 1 ||
      providerStops !== 1 ||
      relayConnects !== 1 ||
      relayCloses !== 1 ||
      credentialScrubs !== 1 ||
      !outboundTypes.includes("worker.heartbeat") ||
      !outboundTypes.includes("worker.ready")
    ) {
      return yield* Effect.die("worker image canary did not complete the expected lifecycle");
    }
    return {
      hostedRelaySelected,
      providerStarts,
      providerStops,
      relayConnects,
      relayCloses,
      credentialScrubs,
      outboundTypes,
    };
  });
