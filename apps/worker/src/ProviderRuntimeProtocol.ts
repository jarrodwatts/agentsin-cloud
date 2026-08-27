import { ProviderRuntimeEvent } from "@t3tools/contracts";
import { CloudThreadCommand } from "@t3tools/contracts/cloud";
import { WorkerBootstrap, WorkerSecretLeaseRef } from "@t3tools/contracts/worker";
import * as Schema from "effect/Schema";

const RuntimeRequestId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100));

export const RestrictedProviderMaterialization = Schema.Struct({
  leaseRef: WorkerSecretLeaseRef,
  credentialDirectory: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  environmentVariableNames: Schema.Array(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ).check(Schema.isMaxLength(128)),
  containsWalletMaterial: Schema.Boolean,
});
export type RestrictedProviderMaterialization = typeof RestrictedProviderMaterialization.Type;

export const RestrictedProviderRuntimeRequest = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("provider.start"),
    requestId: RuntimeRequestId,
    identity: WorkerBootstrap,
    materialization: RestrictedProviderMaterialization,
  }),
  Schema.Struct({
    type: Schema.Literal("provider.dispatch"),
    requestId: RuntimeRequestId,
    command: CloudThreadCommand,
  }),
  Schema.Struct({ type: Schema.Literal("provider.health"), requestId: RuntimeRequestId }),
  Schema.Struct({ type: Schema.Literal("provider.stop"), requestId: RuntimeRequestId }),
]);
export type RestrictedProviderRuntimeRequest = typeof RestrictedProviderRuntimeRequest.Type;

export const RestrictedProviderRuntimeMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("provider.ready") }),
  Schema.Struct({
    type: Schema.Literal("provider.result"),
    requestId: RuntimeRequestId,
    success: Schema.Boolean,
    health: Schema.optionalKey(Schema.Literals(["ready", "failed"])),
    errorCode: Schema.optionalKey(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    ),
  }),
  Schema.Struct({ type: Schema.Literal("provider.event"), event: ProviderRuntimeEvent }),
]);
export type RestrictedProviderRuntimeMessage = typeof RestrictedProviderRuntimeMessage.Type;
