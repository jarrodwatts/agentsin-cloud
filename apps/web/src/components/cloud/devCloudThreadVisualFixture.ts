import type { LiveDesktopSnapshot } from "@t3tools/client-runtime/inspector";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  CloudThreadEvent,
  MicroUsdc,
  type CloudThreadEvent as CloudThreadEventValue,
} from "@t3tools/contracts/cloud";
import {
  DesktopControllerState,
  type DesktopControllerState as DesktopControllerStateValue,
} from "@t3tools/contracts/desktop-lease";
import type { InspectorCapabilities } from "@t3tools/contracts/inspector";
import * as Schema from "effect/Schema";

import type { CloudThreadTimelineView } from "./cloudThreadTimelineModel";

export const CLOUD_THREAD_VISUAL_FIXTURE_QUERY_KEY = "__agents_in_cloud_fixture";
export const CLOUD_THREAD_VISUAL_FIXTURE_QUERY_VALUE = "active-cloud-thread";

const FIXTURE_FRAME_URL = "/assets/agents-in-cloud-desktop-preview.png";
const FIXTURE_TIMESTAMP = "2026-08-28T12:00:00.000Z";

const capabilities: InspectorCapabilities = {
  terminal: true,
  files: true,
  ports: true,
  browserFrames: true,
  browserInput: true,
  desktopFrames: true,
  desktopInput: true,
  desktopBackend: "injected",
};

export interface CloudDesktopVisualFixture {
  readonly agentControlled: LiveDesktopSnapshot;
  readonly userControlled: LiveDesktopSnapshot;
}

export interface DevCloudThreadFocusCanvasFixture {
  readonly presentation: DevCloudThreadPresentationFixture;
  readonly userRequest: string;
  readonly agentSummary: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly additions: number;
    readonly deletions: number;
  }>;
  readonly checkpoint: {
    readonly sha: string;
    readonly label: string;
  };
}

export interface DevCloudThreadPresentationFixture {
  readonly title: string;
  readonly workspaceLabel: string;
  readonly environmentLabel: string;
  readonly providerLabel: string;
  readonly modelLabel: string;
  readonly runtimeLabel: string;
  readonly branch: string;
}

export interface DevCloudThreadVisualFixture {
  readonly desktop: CloudDesktopVisualFixture;
  readonly focusCanvas: DevCloudThreadFocusCanvasFixture;
  readonly timeline: CloudThreadTimelineView;
}

const decodeEvent = Schema.decodeUnknownSync(CloudThreadEvent);
const decodeMicroUsdc = Schema.decodeUnknownSync(MicroUsdc);
const decodeDesktopController = Schema.decodeUnknownSync(DesktopControllerState);

function activityEvent(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly sequence: number;
  readonly kind: string;
  readonly summary: string;
  readonly payload: unknown;
}): CloudThreadEventValue {
  return decodeEvent({
    schemaVersion: 1,
    workspaceId: "workspace-visual-fixture",
    environmentId: input.environmentId,
    threadId: input.threadId,
    event: {
      sequence: input.sequence,
      eventId: `event-visual-fixture-${input.sequence}`,
      aggregateKind: "thread",
      aggregateId: input.threadId,
      occurredAt: FIXTURE_TIMESTAMP,
      commandId: null,
      causationEventId: null,
      correlationId: "fixture-cloud-thread",
      metadata: { adapterKey: "codex" },
      type: "thread.activity-appended",
      payload: {
        threadId: input.threadId,
        activity: {
          id: `activity-visual-fixture-${input.sequence}`,
          tone: "tool",
          kind: input.kind,
          summary: input.summary,
          payload: input.payload,
          turnId: "turn-visual-fixture",
          sequence: input.sequence,
          createdAt: FIXTURE_TIMESTAMP,
        },
      },
    },
    receivedAt: FIXTURE_TIMESTAMP,
  });
}

function desktopSnapshots(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}): CloudDesktopVisualFixture {
  const lease = {
    leaseId: "lease-visual-fixture",
    generation: 1,
    binding: {
      workspaceId: "workspace-visual-fixture",
      threadId: input.threadId,
      attemptId: "attempt-visual-fixture",
      environmentId: input.environmentId,
      environmentRevisionId: "revision-visual-fixture",
      sandboxId: "sandbox-visual-fixture",
      workerId: "worker-visual-fixture",
      routeGeneration: 1,
    },
    expiresAt: "2026-08-28T12:15:00.000Z",
  };
  const agentController: DesktopControllerStateValue = decodeDesktopController({
    controller: "agent",
    observedAt: FIXTURE_TIMESTAMP,
  });
  const userController: DesktopControllerStateValue = decodeDesktopController({
    controller: "user",
    lease,
    heldByCurrentClient: true,
    observedAt: FIXTURE_TIMESTAMP,
  });
  const snapshot = (controller: DesktopControllerStateValue): LiveDesktopSnapshot => ({
    phase: "connected",
    capabilities,
    controller,
    frameUrl: FIXTURE_FRAME_URL,
    frameMediaType: "image/png",
    pendingAction: null,
    message: null,
  });

  return {
    agentControlled: snapshot(agentController),
    userControlled: snapshot(userController),
  };
}

/**
 * A deliberately hidden visual-QA seam. Vite replaces both environment flags
 * at build time, so a production bundle returns before reading the query.
 */
export function resolveDevCloudThreadVisualFixture(input: {
  readonly search: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}): DevCloudThreadVisualFixture | null {
  if (import.meta.env.PROD || !import.meta.env.DEV) return null;

  const requested = new URLSearchParams(input.search).get(CLOUD_THREAD_VISUAL_FIXTURE_QUERY_KEY);
  if (requested !== CLOUD_THREAD_VISUAL_FIXTURE_QUERY_VALUE) return null;

  const events = [
    activityEvent({
      ...input,
      sequence: 1,
      kind: "sandbox.ready",
      summary: "Started the E2B cloud workspace",
      payload: { provider: "e2b", region: "us-east" },
    }),
    activityEvent({
      ...input,
      sequence: 2,
      kind: "provider.started",
      summary: "Codex is working in the cloud",
      payload: { provider: "codex", model: "gpt-5" },
    }),
    activityEvent({
      ...input,
      sequence: 3,
      kind: "tool.completed",
      summary: "Ran 28 focused tests",
      payload: { command: "pnpm test", passed: 28, failed: 0 },
    }),
    activityEvent({
      ...input,
      sequence: 4,
      kind: "checkpoint.pushed",
      summary: "Pushed a verified checkpoint",
      payload: { branch: "agents/fix-checkout-race-a12f", commit: "8c1f2ab" },
    }),
  ];

  return {
    desktop: desktopSnapshots(input),
    focusCanvas: {
      presentation: {
        title: "Fix checkout race",
        workspaceLabel: "Checkout service",
        environmentLabel: "Relay managed · E2B",
        providerLabel: "Codex",
        modelLabel: "GPT-5.6 Codex",
        runtimeLabel: "E2B Cloud",
        branch: "agents/fix-checkout-race-a12f",
      },
      userRequest:
        "Fix the checkout race, verify it with focused tests, and push a safe checkpoint.",
      agentSummary:
        "I found the checkout ownership race and moved the lock boundary around the shared transaction. I’m verifying the fix before preparing the branch for review.",
      files: [
        { path: "src/services/checkout.ts", additions: 86, deletions: 12 },
        { path: "tests/checkout/checkout.test.ts", additions: 54, deletions: 0 },
      ],
      checkpoint: {
        sha: "8c1f2ab",
        label: "Verified checkpoint pushed",
      },
    },
    timeline: {
      phase: "ready",
      events,
      runtime: {
        branch: "agents/fix-checkout-race-a12f",
        sandboxState: "ready",
        accruedMicroUsdc: decodeMicroUsdc(180_000),
        composerState: "ready",
      },
    },
  };
}
