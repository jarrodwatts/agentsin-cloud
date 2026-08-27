import type { ProviderInstanceRef, ProviderRuntimeEvent } from "@t3tools/contracts";
import type { CloudThreadCommand, CloudThreadEvent } from "@t3tools/contracts/cloud";
import type {
  WorkerBootstrap,
  WorkerEventCursor,
  WorkerProposalId,
  WorkerRelayCredentialRef,
  WorkerRelayOutbound,
  WorkerSecretLeaseRef,
} from "@t3tools/contracts/worker";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

import type {
  WorkerProviderError,
  WorkerProtocolError,
  WorkerRelayError,
  WorkerSecretLeaseError,
} from "./errors.ts";

export interface WorkerClock {
  readonly now: Effect.Effect<string>;
}

export interface WorkerIds {
  readonly nextProposalId: Effect.Effect<WorkerProposalId>;
}

export interface WorkerRelayConnectInput {
  readonly identity: WorkerBootstrap;
  readonly credentialRef: WorkerRelayCredentialRef;
  readonly confirmedThroughSequence: WorkerEventCursor;
}

/**
 * `completed` is safe to acknowledge as a duplicate. `in-flight` means the
 * prior side-effect outcome is unknown and must enter reconciliation.
 */
export type WorkerCommandClaim = "execute" | "completed" | "in-flight";

/**
 * Pull-based receive is deliberate backpressure: the worker cannot accept a
 * second command frame until it has finished the first one.
 */
export interface WorkerRelayConnection {
  /** TLS-exported, connection-bound key; connector zeroizes it on close. */
  readonly credentialChannelKey: Uint8Array;
  readonly receive: Effect.Effect<Option.Option<Uint8Array>, WorkerRelayError>;
  readonly claimCommand: (
    command: CloudThreadCommand,
  ) => Effect.Effect<WorkerCommandClaim, WorkerRelayError>;
  readonly send: (message: WorkerRelayOutbound) => Effect.Effect<void, WorkerRelayError>;
  readonly close: Effect.Effect<void>;
}

export interface WorkerRelayConnector {
  readonly connect: (
    input: WorkerRelayConnectInput,
  ) => Effect.Effect<WorkerRelayConnection, WorkerRelayError, Scope.Scope>;
}

/**
 * An opaque result created by the secret broker. The worker sees only the
 * directory and names already materialized into the sandbox, never values.
 */
export interface WorkerSecretMaterialization {
  readonly leaseRef: WorkerSecretLeaseRef;
  readonly credentialDirectory: string;
  readonly environmentVariableNames: ReadonlyArray<string>;
  readonly containsWalletMaterial: boolean;
  readonly scrub: Effect.Effect<void, WorkerSecretLeaseError>;
}

export interface WorkerSecretLeaseBroker {
  readonly materialize: (input: {
    readonly identity: WorkerBootstrap;
    readonly leaseRef: WorkerSecretLeaseRef;
    readonly provider: ProviderInstanceRef;
  }) => Effect.Effect<WorkerSecretMaterialization, WorkerSecretLeaseError>;
}

export interface WorkerProviderSession {
  readonly dispatch: (command: CloudThreadCommand) => Effect.Effect<void, WorkerProviderError>;
  readonly health: Effect.Effect<"ready" | "failed", WorkerProviderError>;
  readonly stop: Effect.Effect<void>;
}

export interface WorkerProviderFactory {
  readonly start: (input: {
    readonly identity: WorkerBootstrap;
    readonly materialization: WorkerSecretMaterialization;
    readonly emit: (
      event: ProviderRuntimeEvent,
      causedByCommandId?: CloudThreadCommand["command"]["commandId"],
    ) => Effect.Effect<
      CloudThreadEvent | undefined,
      WorkerRelayError | WorkerProviderError | WorkerProtocolError
    >;
  }) => Effect.Effect<WorkerProviderSession, WorkerProviderError, Scope.Scope>;
}

export interface WorkerLogger {
  readonly info: (
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<void>;
  readonly warn: (
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<void>;
  readonly error: (
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<void>;
}
