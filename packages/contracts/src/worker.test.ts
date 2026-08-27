import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  WorkerBootstrap,
  WorkerCertificateBootstrapRequest,
  WorkerCertificateGrant,
  WorkerCommandClaimResponse,
  WorkerEventCursor,
  WorkerRelayEventProposal,
} from "./worker.ts";

const decodeBootstrap = Schema.decodeUnknownSync(WorkerBootstrap);
const decodeEventProposal = Schema.decodeUnknownSync(WorkerRelayEventProposal);
const decodeEventCursor = Schema.decodeUnknownSync(WorkerEventCursor);
const decodeCertificateBootstrap = Schema.decodeUnknownSync(WorkerCertificateBootstrapRequest);
const decodeCertificateGrant = Schema.decodeUnknownSync(WorkerCertificateGrant);
const decodeClaimResponse = Schema.decodeUnknownSync(WorkerCommandClaimResponse);

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
  reservationId: "command-reserve-1",
  provider: { instanceId: "codex_personal", driver: "codex" },
  workspaceDirectory: "/workspace/project",
  bootstrapEndpoint: "https://control.example.com/api/v1/worker-certificates/bootstrap",
  relayEndpoint: "wss://control.example.com/worker",
  relayServerSpkiSha256: "sha256/47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
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

describe("worker mTLS wire contracts", () => {
  it("bounds the one-time token and public SPKI without accepting identity fields", () => {
    const request = {
      schemaVersion: 1,
      token: "t".repeat(48),
      publicKeySpkiDerBase64: "QUJDRA==",
    };
    expect(decodeCertificateBootstrap(request)).toEqual(request);
    expect(() => decodeCertificateBootstrap({ ...request, workerId: "worker-forged" })).toThrow();
    expect(() => decodeCertificateBootstrap({ ...request, token: "short" })).toThrow();
  });

  it("requires a bounded PEM grant and closed command-claim state", () => {
    expect(
      decodeCertificateGrant({
        schemaVersion: 1,
        certificateChainPem: "-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----",
        notBefore: "2026-08-27T00:00:00.000Z",
        notAfter: "2026-08-27T00:10:00.000Z",
        rotateAfter: "2026-08-27T00:06:00.000Z",
      }).schemaVersion,
    ).toBe(1);
    expect(decodeClaimResponse({ schemaVersion: 1, claim: "in-flight" }).claim).toBe("in-flight");
    expect(() => decodeClaimResponse({ schemaVersion: 1, claim: "unknown" })).toThrow();
  });
});
