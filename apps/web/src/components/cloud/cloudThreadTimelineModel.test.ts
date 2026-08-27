import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";
import { CloudThreadEvent, MicroUsdc } from "@t3tools/contracts/cloud";
import {
  cloudComposerBlockedReason,
  cloudThreadReplayBlockedReason,
  formatMicroUsdc,
  inspectCloudThreadEventIntegrity,
  presentCloudSandboxState,
} from "./cloudThreadTimelineModel";

const decodeCloudEvent = Schema.decodeUnknownSync(CloudThreadEvent);
const decodeMicroUsdc = Schema.decodeUnknownSync(MicroUsdc);

function cloudEvent(
  sequence: number,
  options: {
    readonly eventId?: string;
    readonly summary?: string;
    readonly receivedAt?: string;
  } = {},
) {
  return decodeCloudEvent({
    schemaVersion: 1,
    workspaceId: "workspace-1",
    environmentId: "environment-1",
    threadId: "thread-1",
    event: {
      sequence,
      eventId: options.eventId ?? `event-${sequence}`,
      aggregateKind: "thread",
      aggregateId: "thread-1",
      occurredAt: "2026-08-27T12:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.activity-appended",
      payload: {
        threadId: "thread-1",
        activity: {
          id: `activity-${sequence}`,
          tone: "tool",
          kind: "tool.completed",
          summary: options.summary ?? "Ran focused tests",
          payload: { command: "pnpm test" },
          turnId: "turn-1",
          sequence,
          createdAt: "2026-08-27T12:00:00.000Z",
        },
      },
    },
    receivedAt: options.receivedAt ?? "2026-08-27T12:00:00.100Z",
  });
}

describe("cloud thread timeline presentation", () => {
  it("classifies arrival order before producing sorted presentation events", () => {
    const events = [cloudEvent(4), cloudEvent(1), cloudEvent(2), cloudEvent(2)];
    const integrity = inspectCloudThreadEventIntegrity(events);

    expect(integrity.lastSequence).toBe(4);
    expect(integrity.duplicateSequences).toEqual([2]);
    expect(integrity.duplicateSequenceCount).toBe(1);
    expect(integrity.identicalRetryCount).toBe(1);
    expect(integrity.outOfOrderCount).toBe(2);
    expect(integrity.missingSequences).toEqual([3]);
    expect(integrity.missingSequenceCount).toBe(1);
    expect(integrity.replayState).toBe("repairing");
    expect(integrity.presentationEvents.map(({ event }) => event.sequence)).toEqual([1, 2, 4]);
    expect(events.map(({ event }) => event.sequence)).toEqual([4, 1, 2, 2]);
  });

  it("repairs a complete but out-of-order delivery", () => {
    const integrity = inspectCloudThreadEventIntegrity([cloudEvent(2), cloudEvent(1)]);

    expect(integrity.missingSequenceCount).toBe(0);
    expect(integrity.outOfOrderCount).toBe(1);
    expect(integrity.replayState).toBe("repairing");
    expect(cloudThreadReplayBlockedReason(integrity)).toBe("Repairing cloud thread history");
  });

  it("safe-dedupes an identical at-least-once retry that only changes receivedAt", () => {
    const integrity = inspectCloudThreadEventIntegrity([
      cloudEvent(1),
      cloudEvent(1, { receivedAt: "2026-08-27T12:00:01.000Z" }),
    ]);

    expect(integrity.duplicateSequenceCount).toBe(1);
    expect(integrity.identicalRetryCount).toBe(1);
    expect(integrity.conflictingSequences).toEqual([]);
    expect(integrity.conflictingEventIds).toEqual([]);
    expect(integrity.replayState).toBe("healthy");
    expect(integrity.presentationEvents).toHaveLength(1);
    expect(cloudThreadReplayBlockedReason(integrity)).toBeNull();
  });

  it("repairs conflicting events that claim the same sequence", () => {
    const integrity = inspectCloudThreadEventIntegrity([
      cloudEvent(2),
      cloudEvent(2, { eventId: "event-conflict", summary: "Different durable payload" }),
    ]);

    expect(integrity.duplicateSequenceCount).toBe(1);
    expect(integrity.identicalRetryCount).toBe(0);
    expect(integrity.conflictingSequences).toEqual([2]);
    expect(integrity.replayState).toBe("repairing");
  });

  it("repairs a reused event identity whose durable payload changed", () => {
    const integrity = inspectCloudThreadEventIntegrity([
      cloudEvent(2),
      cloudEvent(2, { summary: "Conflicting payload" }),
    ]);

    expect(integrity.conflictingSequences).toEqual([2]);
    expect(integrity.conflictingEventIds).toEqual(["event-2"]);
    expect(integrity.replayState).toBe("repairing");
  });

  it("repairs a reused event ID attached to a different sequence", () => {
    const integrity = inspectCloudThreadEventIntegrity([
      cloudEvent(1, { eventId: "event-reused" }),
      cloudEvent(2, { eventId: "event-reused" }),
    ]);

    expect(integrity.conflictingEventIds).toEqual(["event-reused"]);
    expect(integrity.replayState).toBe("repairing");
  });

  it("bounds missing-sequence evidence for malformed large gaps", () => {
    const integrity = inspectCloudThreadEventIntegrity([cloudEvent(1), cloudEvent(10_000)]);

    expect(integrity.missingSequenceCount).toBe(9_998);
    expect(integrity.missingSequences).toHaveLength(100);
    expect(integrity.missingSequences.at(-1)).toBe(101);
  });

  it("formats fixed-point micro-USDC without floating-point arithmetic", () => {
    expect(formatMicroUsdc(decodeMicroUsdc(0))).toBe("0.00");
    expect(formatMicroUsdc(decodeMicroUsdc(180_000))).toBe("0.18");
    expect(formatMicroUsdc(decodeMicroUsdc(1_234_560))).toBe("1.23456");
    expect(formatMicroUsdc(decodeMicroUsdc(2_000_000))).toBe("2.00");
  });

  it("maps every cloud composer and sandbox state to user-facing copy", () => {
    expect(cloudComposerBlockedReason("ready")).toBeNull();
    expect(cloudComposerBlockedReason("pausedLowBalance")).toBe("Add USDC to resume this thread");
    expect(cloudComposerBlockedReason("unavailable")).toBe("Cloud worker is unavailable");
    expect(presentCloudSandboxState("ready")).toEqual({ label: "Running", tone: "positive" });
    expect(presentCloudSandboxState("suspended")).toEqual({
      label: "Paused",
      tone: "warning",
    });
    expect(presentCloudSandboxState("failed")).toEqual({ label: "Failed", tone: "critical" });
  });
});
