import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { Schema } from "effect";
import { CloudThreadEvent, MicroUsdc } from "@t3tools/contracts/cloud";
import { CloudThreadStatusBar, CloudThreadTimelineFrame } from "./CloudThreadTimeline";

const event = Schema.decodeUnknownSync(CloudThreadEvent)({
  schemaVersion: 1,
  workspaceId: "workspace-1",
  environmentId: "environment-1",
  threadId: "thread-1",
  event: {
    sequence: 1,
    eventId: "event-1",
    aggregateKind: "thread",
    aggregateId: "thread-1",
    occurredAt: "2026-08-27T12:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.deleted",
    payload: { threadId: "thread-1", deletedAt: "2026-08-27T12:00:00.000Z" },
  },
  receivedAt: "2026-08-27T12:00:00.100Z",
});
const decodeMicroUsdc = Schema.decodeUnknownSync(MicroUsdc);

describe("CloudThreadTimelineFrame", () => {
  it("preserves the existing timeline inside the cloud delivery frame", () => {
    const markup = renderToStaticMarkup(
      <CloudThreadTimelineFrame
        view={{
          phase: "ready",
          events: [event],
          runtime: {
            branch: "agents/fix-checkout-race-a12f",
            sandboxState: "ready",
            accruedMicroUsdc: decodeMicroUsdc(180_000),
            composerState: "ready",
          },
        }}
      >
        <div data-existing-t3-timeline>Timeline</div>
      </CloudThreadTimelineFrame>,
    );

    expect(markup).toContain('data-cloud-thread-timeline="true"');
    expect(markup).toContain('data-cloud-thread-phase="ready"');
    expect(markup).toContain('data-cloud-thread-replay-state="healthy"');
    expect(markup).toContain("data-existing-t3-timeline");
  });

  it("shows actionable loading, error, and replay-gap states", () => {
    const loading = renderToStaticMarkup(
      <CloudThreadTimelineFrame view={{ phase: "loading", events: [] }}>
        <div />
      </CloudThreadTimelineFrame>,
    );
    const onRetry = vi.fn();
    const error = renderToStaticMarkup(
      <CloudThreadTimelineFrame
        view={{ phase: "error", events: [event], message: "Worker connection lost" }}
        onRetry={onRetry}
      >
        <div />
      </CloudThreadTimelineFrame>,
    );
    const gapEvent = {
      ...event,
      event: { ...event.event, sequence: 3, eventId: event.event.eventId },
    };
    const gap = renderToStaticMarkup(
      <CloudThreadTimelineFrame view={{ phase: "loading", events: [event, gapEvent] }}>
        <div />
      </CloudThreadTimelineFrame>,
    );

    expect(loading).toContain("Restoring cloud thread");
    expect(error).toContain("Worker connection lost");
    expect(error).toContain("Retry");
    expect(gap).toContain('data-cloud-thread-replay-state="repairing"');
    expect(gap).toContain("repair event delivery integrity");
  });
});

describe("CloudThreadStatusBar", () => {
  it("renders exact branch, E2B state, Monad usage, and accessible composer state", () => {
    const markup = renderToStaticMarkup(
      <CloudThreadStatusBar
        runtime={{
          branch: "agents/fix-checkout-race-a12f",
          sandboxState: "suspended",
          accruedMicroUsdc: decodeMicroUsdc(180_000),
          composerState: "pausedLowBalance",
        }}
      />,
    );

    expect(markup).toContain("agents/fix-checkout-race-a12f");
    expect(markup).toContain('aria-label="E2B Cloud, Paused"');
    expect(markup).toContain("Paused");
    expect(markup).toContain("0.18 USDC");
    expect(markup).toContain("Monad");
    expect(markup).toContain("Add USDC to resume this thread");
  });
});
