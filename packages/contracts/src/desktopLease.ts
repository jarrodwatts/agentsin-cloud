/**
 * Versioned desktop-control messages carried by an authenticated inspector
 * socket. Holder identity and workspace scope are deliberately absent from
 * client messages: the control plane derives both from the Better Auth session
 * and the server-created socket identity.
 *
 * @module desktopLease
 */
import * as Schema from "effect/Schema";

import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { DesktopLeaseId, EnvironmentRevisionId, SandboxId, WorkspaceId } from "./cloud.ts";

export const DESKTOP_CONTROL_PROTOCOL_VERSION = 1 as const;

export const DesktopControlClientId = Schema.String.check(
  Schema.isLengthBetween(1, 128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
).pipe(Schema.brand("DesktopControlClientId"));
export type DesktopControlClientId = typeof DesktopControlClientId.Type;

export const DesktopLeaseGeneration = PositiveInt;
export type DesktopLeaseGeneration = typeof DesktopLeaseGeneration.Type;

/** Monotonic worker fence: odd revisions grant a user lease, even revisions restore the agent. */
export const DesktopAuthorityRevision = NonNegativeInt;
export type DesktopAuthorityRevision = typeof DesktopAuthorityRevision.Type;

export const DesktopLeaseResumeToken = Schema.String.check(
  Schema.isLengthBetween(43, 128),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
).pipe(Schema.brand("DesktopLeaseResumeToken"));
export type DesktopLeaseResumeToken = typeof DesktopLeaseResumeToken.Type;

export const DesktopLeaseIdempotencyKey = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("DesktopLeaseIdempotencyKey"),
);
export type DesktopLeaseIdempotencyKey = typeof DesktopLeaseIdempotencyKey.Type;

/** Exact lifecycle and authenticated worker route controlled by a lease. */
export const DesktopControlBinding = Schema.Struct({
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  attemptId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  environmentId: EnvironmentId,
  environmentRevisionId: EnvironmentRevisionId,
  sandboxId: SandboxId,
  workerId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  routeGeneration: PositiveInt,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type DesktopControlBinding = typeof DesktopControlBinding.Type;

export const DesktopInputPermit = Schema.Struct({
  leaseId: DesktopLeaseId,
  generation: DesktopLeaseGeneration,
  authorityRevision: DesktopAuthorityRevision,
  binding: DesktopControlBinding,
  expiresAt: IsoDateTime,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type DesktopInputPermit = typeof DesktopInputPermit.Type;

export const DesktopAuthorityCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("desktop.authority"),
    controller: Schema.Literal("user"),
    authorityRevision: DesktopAuthorityRevision,
    leaseId: DesktopLeaseId,
    generation: DesktopLeaseGeneration,
    binding: DesktopControlBinding,
    expiresAt: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("desktop.authority"),
    controller: Schema.Literal("agent"),
    authorityRevision: DesktopAuthorityRevision,
    binding: DesktopControlBinding,
  }),
]).annotate({ parseOptions: { onExcessProperty: "error" } });
export type DesktopAuthorityCommand = typeof DesktopAuthorityCommand.Type;

const ActiveControllerLease = Schema.Struct({
  leaseId: DesktopLeaseId,
  generation: DesktopLeaseGeneration,
  binding: DesktopControlBinding,
  expiresAt: IsoDateTime,
});

/** Public controller state. It never reveals another socket or auth-session id. */
export const DesktopControllerState = Schema.Union([
  Schema.Struct({
    controller: Schema.Literal("agent"),
    observedAt: IsoDateTime,
  }),
  Schema.Struct({
    controller: Schema.Literal("user"),
    lease: ActiveControllerLease,
    heldByCurrentClient: Schema.Boolean,
    observedAt: IsoDateTime,
  }),
  Schema.Struct({
    controller: Schema.Literal("disconnected"),
    lease: ActiveControllerLease,
    resumableByCurrentSession: Schema.Boolean,
    observedAt: IsoDateTime,
  }),
]).annotate({ parseOptions: { onExcessProperty: "error" } });
export type DesktopControllerState = typeof DesktopControllerState.Type;

const DesktopControlRequestIdentity = {
  protocolVersion: Schema.Literal(DESKTOP_CONTROL_PROTOCOL_VERSION),
  requestId: CommandId,
} as const;

export const DesktopControlClientFrame = Schema.Union([
  Schema.Struct({
    ...DesktopControlRequestIdentity,
    type: Schema.Literal("desktop.control.get"),
  }),
  Schema.Struct({
    ...DesktopControlRequestIdentity,
    type: Schema.Literal("desktop.control.acquire"),
    idempotencyKey: DesktopLeaseIdempotencyKey,
  }),
  Schema.Struct({
    ...DesktopControlRequestIdentity,
    type: Schema.Literal("desktop.control.heartbeat"),
    leaseId: DesktopLeaseId,
    generation: DesktopLeaseGeneration,
    idempotencyKey: DesktopLeaseIdempotencyKey,
  }),
  Schema.Struct({
    ...DesktopControlRequestIdentity,
    type: Schema.Literal("desktop.control.release"),
    leaseId: DesktopLeaseId,
    generation: DesktopLeaseGeneration,
    idempotencyKey: DesktopLeaseIdempotencyKey,
  }),
  Schema.Struct({
    ...DesktopControlRequestIdentity,
    type: Schema.Literal("desktop.control.resume"),
    leaseId: DesktopLeaseId,
    generation: DesktopLeaseGeneration,
    resumeToken: DesktopLeaseResumeToken,
    idempotencyKey: DesktopLeaseIdempotencyKey,
  }),
]).annotate({ parseOptions: { onExcessProperty: "error" } });
export type DesktopControlClientFrame = typeof DesktopControlClientFrame.Type;

export const DesktopControlServerFrame = Schema.Struct({
  protocolVersion: Schema.Literal(DESKTOP_CONTROL_PROTOCOL_VERSION),
  type: Schema.Literal("desktop.control.state"),
  requestId: CommandId,
  state: DesktopControllerState,
  resumeToken: Schema.optionalKey(DesktopLeaseResumeToken),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type DesktopControlServerFrame = typeof DesktopControlServerFrame.Type;
