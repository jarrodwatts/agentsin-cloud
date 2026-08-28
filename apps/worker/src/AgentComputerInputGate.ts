import type {
  DesktopAuthorityCommand,
  DesktopControlBinding,
  DesktopInputPermit,
} from "@t3tools/contracts/desktop-lease";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class AgentComputerInputGateError extends Schema.TaggedErrorClass<AgentComputerInputGateError>()(
  "AgentComputerInputGateError",
  {
    code: Schema.Literals(["notSynchronized", "staleAuthority", "forbidden", "expired"]),
    operation: Schema.String,
  },
) {}

type AuthorityState =
  | { readonly controller: "unknown"; readonly authorityRevision: 0 }
  | DesktopAuthorityCommand;

export interface AgentComputerInputGate {
  readonly update: (
    command: DesktopAuthorityCommand,
  ) => Effect.Effect<void, AgentComputerInputGateError>;
  readonly authorizeUserInput: (
    permit: DesktopInputPermit,
    binding: DesktopControlBinding,
    now: string,
  ) => Effect.Effect<void, AgentComputerInputGateError>;
  /** Future provider visual adapters call this immediately before mouse/keyboard input. */
  readonly authorizeAgentInput: (
    binding: DesktopControlBinding,
    now: string,
  ) => Effect.Effect<void, AgentComputerInputGateError>;
  readonly snapshot: () => AuthorityState;
}

const sameBinding = (left: DesktopControlBinding, right: DesktopControlBinding) =>
  left.workspaceId === right.workspaceId &&
  left.threadId === right.threadId &&
  left.attemptId === right.attemptId &&
  left.environmentId === right.environmentId &&
  left.environmentRevisionId === right.environmentRevisionId &&
  left.sandboxId === right.sandboxId &&
  left.workerId === right.workerId &&
  left.routeGeneration === right.routeGeneration;

const sameAuthority = (left: DesktopAuthorityCommand, right: DesktopAuthorityCommand) =>
  left.controller === right.controller &&
  left.authorityRevision === right.authorityRevision &&
  sameBinding(left.binding, right.binding) &&
  (left.controller === "agent" ||
    (right.controller === "user" &&
      left.leaseId === right.leaseId &&
      left.generation === right.generation &&
      right.expiresAt >= left.expiresAt));

/**
 * The worker starts fail-closed and accepts only monotonic authority updates
 * from its authenticated per-thread relay stream.
 */
export const makeAgentComputerInputGate = (): AgentComputerInputGate => {
  let state: AuthorityState = { controller: "unknown", authorityRevision: 0 };

  return {
    update: (command) =>
      Effect.suspend(() => {
        if (command.authorityRevision < state.authorityRevision) return Effect.void;
        if (
          command.authorityRevision === state.authorityRevision &&
          state.controller !== "unknown" &&
          !sameAuthority(state, command)
        ) {
          return Effect.fail(
            new AgentComputerInputGateError({
              code: "staleAuthority",
              operation: "update-authority",
            }),
          );
        }
        state = command;
        return Effect.void;
      }),

    authorizeUserInput: (permit, binding, now) =>
      Effect.suspend(() => {
        if (state.controller === "unknown") {
          return Effect.fail(
            new AgentComputerInputGateError({
              code: "notSynchronized",
              operation: "authorize-user-input",
            }),
          );
        }
        if (
          state.controller !== "user" ||
          !sameBinding(state.binding, binding) ||
          !sameBinding(permit.binding, binding) ||
          state.leaseId !== permit.leaseId ||
          state.generation !== permit.generation ||
          state.authorityRevision !== permit.authorityRevision
        ) {
          return Effect.fail(
            new AgentComputerInputGateError({
              code: "forbidden",
              operation: "authorize-user-input",
            }),
          );
        }
        if (state.expiresAt <= now || permit.expiresAt <= now) {
          return Effect.fail(
            new AgentComputerInputGateError({
              code: "expired",
              operation: "authorize-user-input",
            }),
          );
        }
        return Effect.void;
      }),

    authorizeAgentInput: (binding) =>
      Effect.suspend(() =>
        state.controller === "agent" && sameBinding(state.binding, binding)
          ? Effect.void
          : Effect.fail(
              new AgentComputerInputGateError({
                code: state.controller === "unknown" ? "notSynchronized" : "forbidden",
                operation: "authorize-agent-input",
              }),
            ),
      ),

    snapshot: () => state,
  };
};
