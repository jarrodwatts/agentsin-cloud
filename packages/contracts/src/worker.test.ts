import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { WorkerBootstrap, WorkerEventCursor, WorkerRelayEventProposal } from "./worker.ts";

const decodeBootstrap = Schema.decodeUnknownSync(WorkerBootstrap);
const decodeEventProposal = Schema.decodeUnknownSync(WorkerRelayEventProposal);
const decodeEventCursor = Schema.decodeUnknownSync(WorkerEventCursor);

it("uses -1 as the sole empty event-log cursor", () => {
  expect(decodeEventCursor(-1)).toBe(-1);
  expect(decodeEventCursor(0)).toBe(0);
  expect(() => decodeEventCursor(-2)).toThrow();
});

const validBootstrap = {
  schemaVersion: 1,
  workerId: "worker-1",
  workspaceId: "workspace-1",
  environmentId: "environment-1",
  environmentRevisionId: "revision-1",
  threadId: "thread-1",
  sandboxId: "sandbox-1",
  provider: { instanceId: "codex_personal", driver: "codex" },
  workspaceDirectory: "/workspace/project",
  relayEndpoint: "wss://control.example.com/worker",
  relayCredentialRef: "relay-ref-1",
  secretLeaseRef: "lease-ref-1",
  issuedAt: "2026-08-27T00:00:00.000Z",
  expiresAt: "2026-08-27T01:00:00.000Z",
};

describe("WorkerBootstrap", () => {
  it("pins immutable thread, sandbox, revision, and provider identity", () => {
    const decoded = decodeBootstrap(validBootstrap);
    expect(decoded).toMatchObject({
      threadId: "thread-1",
      sandboxId: "sandbox-1",
      environmentRevisionId: "revision-1",
      provider: { instanceId: "codex_personal", driver: "codex" },
    });
  });

  it("rejects extra wallet/signing fields", () => {
    expect(() =>
      decodeBootstrap({
        ...validBootstrap,
        walletPrivateKey: "forbidden",
      }),
    ).toThrow();
  });
});

describe("WorkerRelayEventProposal", () => {
  const proposal = {
    type: "provider.event.proposed",
    proposalId: "proposal-1",
    runtimeEvent: {
      eventId: "provider-event-1",
      provider: "codex",
      providerInstanceId: "codex_personal",
      threadId: "thread-1",
      createdAt: "2026-08-27T00:30:00.000Z",
      type: "runtime.warning",
      payload: { message: "warning" },
    },
    proposedAt: "2026-08-27T00:30:00.000Z",
  };

  it("carries provider facts without claiming durable event authority", () => {
    expect(decodeEventProposal(proposal)).toMatchObject({
      proposalId: "proposal-1",
      runtimeEvent: { eventId: "provider-event-1" },
    });
    expect(() => decodeEventProposal({ ...proposal, sequence: 1 })).toThrow();
  });
});
