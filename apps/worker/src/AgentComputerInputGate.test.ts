import type {
  DesktopAuthorityCommand,
  DesktopControlBinding,
  DesktopInputPermit,
} from "@t3tools/contracts/desktop-lease";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { makeAgentComputerInputGate } from "./AgentComputerInputGate.ts";

const binding: DesktopControlBinding = {
  workspaceId: "11111111-1111-4111-8111-111111111111" as never,
  threadId: "thread-1" as never,
  attemptId: "attempt-1",
  environmentId: "environment-1" as never,
  environmentRevisionId: "revision-1" as never,
  sandboxId: "sandbox-1" as never,
  workerId: "worker-1",
  routeGeneration: 1,
};

const user = (
  generation: number,
  routeBinding = binding,
): Extract<DesktopAuthorityCommand, { readonly controller: "user" }> => ({
  type: "desktop.authority",
  controller: "user",
  authorityRevision: generation * 2 - 1,
  leaseId: "22222222-2222-4222-8222-222222222222" as never,
  generation,
  binding: routeBinding,
  expiresAt: "2026-08-27T12:01:00.000Z",
});

const agent = (
  generation: number,
): Extract<DesktopAuthorityCommand, { readonly controller: "agent" }> => ({
  type: "desktop.authority",
  controller: "agent",
  authorityRevision: generation * 2,
  binding,
});

const permit = (command: Extract<DesktopAuthorityCommand, { readonly controller: "user" }>) =>
  ({
    leaseId: command.leaseId,
    generation: command.generation,
    authorityRevision: command.authorityRevision,
    binding: command.binding,
    expiresAt: command.expiresAt,
  }) satisfies DesktopInputPermit;

it.effect("starts fail-closed and admits only the exact active user fence", () =>
  Effect.gen(function* () {
    const gate = makeAgentComputerInputGate();
    const first = user(1);
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          gate.authorizeUserInput(permit(first), binding, "2026-08-27T12:00:00.000Z"),
        ),
      ),
    ).toBe(true);

    yield* gate.update(first);
    yield* gate.authorizeUserInput(permit(first), binding, "2026-08-27T12:00:00.000Z");
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          gate.authorizeUserInput(
            { ...permit(first), binding: { ...binding, routeGeneration: 2 } },
            binding,
            "2026-08-27T12:00:00.000Z",
          ),
        ),
      ),
    ).toBe(true);
  }),
);

it.effect("release and replacement generations fence every older user permit", () =>
  Effect.gen(function* () {
    const gate = makeAgentComputerInputGate();
    const first = user(1);
    yield* gate.update(first);
    yield* gate.update(agent(1));
    yield* gate.update(first);
    expect(gate.snapshot()).toMatchObject({ controller: "agent", authorityRevision: 2 });
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          gate.authorizeUserInput(permit(first), binding, "2026-08-27T12:00:00.000Z"),
        ),
      ),
    ).toBe(true);

    const second = user(2);
    yield* gate.update(second);
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          gate.authorizeUserInput(permit(first), binding, "2026-08-27T12:00:00.000Z"),
        ),
      ),
    ).toBe(true);
    yield* gate.authorizeUserInput(permit(second), binding, "2026-08-27T12:00:00.000Z");
  }),
);

it.effect("pauses agent input throughout user and disconnected authority", () =>
  Effect.gen(function* () {
    const gate = makeAgentComputerInputGate();
    yield* gate.update(agent(0));
    yield* gate.authorizeAgentInput(binding, "2026-08-27T12:00:00.000Z");
    yield* gate.update(user(1));
    expect(
      Exit.isFailure(
        yield* Effect.exit(gate.authorizeAgentInput(binding, "2026-08-27T12:00:00.000Z")),
      ),
    ).toBe(true);
  }),
);

it.effect("rejects an equal-revision authority conflict and expired permits", () =>
  Effect.gen(function* () {
    const gate = makeAgentComputerInputGate();
    const first = user(1);
    yield* gate.update(first);
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          gate.update({ ...first, leaseId: "33333333-3333-4333-8333-333333333333" as never }),
        ),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          gate.authorizeUserInput(permit(first), binding, "2026-08-27T12:01:00.000Z"),
        ),
      ),
    ).toBe(true);
  }),
);
