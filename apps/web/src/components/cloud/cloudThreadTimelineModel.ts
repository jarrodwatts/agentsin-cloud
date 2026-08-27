import type { CloudThreadEvent, MicroUsdc, SandboxProviderState } from "@t3tools/contracts/cloud";

export type CloudThreadComposerState =
  | "ready"
  | "submitting"
  | "reconnecting"
  | "pausedLowBalance"
  | "unavailable";

export interface CloudThreadRuntimePresentation {
  readonly branch: string | null;
  readonly sandboxState: SandboxProviderState;
  readonly accruedMicroUsdc: MicroUsdc;
  readonly composerState: CloudThreadComposerState;
}

export type CloudThreadTimelineView =
  | {
      readonly phase: "loading";
      readonly events: ReadonlyArray<CloudThreadEvent>;
    }
  | {
      readonly phase: "ready";
      readonly events: ReadonlyArray<CloudThreadEvent>;
      readonly runtime: CloudThreadRuntimePresentation;
    }
  | {
      readonly phase: "error";
      readonly events: ReadonlyArray<CloudThreadEvent>;
      readonly message: string;
      readonly runtime?: CloudThreadRuntimePresentation;
    };

export type CloudThreadTimelineCapability =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly view: CloudThreadTimelineView;
      readonly onRetry?: () => void;
    };

export const DISABLED_CLOUD_THREAD_TIMELINE_CAPABILITY: CloudThreadTimelineCapability = {
  enabled: false,
};

export interface CloudThreadEventIntegrity {
  readonly lastSequence: number | null;
  readonly duplicateSequences: ReadonlyArray<number>;
  readonly duplicateSequenceCount: number;
  readonly identicalRetryCount: number;
  readonly outOfOrderCount: number;
  readonly missingSequences: ReadonlyArray<number>;
  readonly missingSequenceCount: number;
  readonly conflictingSequences: ReadonlyArray<number>;
  readonly conflictingEventIds: ReadonlyArray<string>;
  readonly replayState: "healthy" | "repairing";
  readonly presentationEvents: ReadonlyArray<CloudThreadEvent>;
}

const MAX_REPORTED_MISSING_SEQUENCES = 100;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

/**
 * Retries may have a later receivedAt, but their durable tenant and event
 * identity must be byte-for-byte equivalent after canonical serialization.
 */
function deliveryIdentity(event: CloudThreadEvent): string {
  return canonicalJson({
    schemaVersion: event.schemaVersion,
    workspaceId: event.workspaceId,
    environmentId: event.environmentId,
    threadId: event.threadId,
    event: event.event,
  });
}

/**
 * Checks only the cloud delivery envelopes. Canonical event projection remains
 * owned by T3's existing read model and timeline.
 */
export function inspectCloudThreadEventIntegrity(
  events: ReadonlyArray<CloudThreadEvent>,
): CloudThreadEventIntegrity {
  if (events.length === 0) {
    return {
      lastSequence: null,
      duplicateSequences: [],
      duplicateSequenceCount: 0,
      identicalRetryCount: 0,
      outOfOrderCount: 0,
      missingSequences: [],
      missingSequenceCount: 0,
      conflictingSequences: [],
      conflictingEventIds: [],
      replayState: "healthy",
      presentationEvents: [],
    };
  }

  const firstBySequence = new Map<
    number,
    { readonly event: CloudThreadEvent; readonly identity: string }
  >();
  const firstByEventId = new Map<
    string,
    { readonly sequence: number; readonly identity: string }
  >();
  const duplicateSequences: number[] = [];
  const duplicateSequenceSet = new Set<number>();
  const conflictingSequences = new Set<number>();
  const conflictingEventIds = new Set<string>();
  let duplicateSequenceCount = 0;
  let identicalRetryCount = 0;
  let outOfOrderCount = 0;
  let highestArrivalSequence: number | null = null;

  // Arrival order is authoritative delivery evidence. Classify it before
  // sorting the unique events for presentation and gap detection.
  for (const event of events) {
    const sequence = event.event.sequence;
    const eventId = event.event.eventId;
    const identity = deliveryIdentity(event);
    const existingSequence = firstBySequence.get(sequence);

    if (existingSequence !== undefined) {
      duplicateSequenceCount += 1;
      if (!duplicateSequenceSet.has(sequence)) {
        duplicateSequenceSet.add(sequence);
        duplicateSequences.push(sequence);
      }
      if (existingSequence.identity === identity) {
        identicalRetryCount += 1;
      } else {
        conflictingSequences.add(sequence);
      }
    } else {
      if (highestArrivalSequence !== null && sequence < highestArrivalSequence) {
        outOfOrderCount += 1;
      }
      highestArrivalSequence = Math.max(highestArrivalSequence ?? sequence, sequence);
      firstBySequence.set(sequence, { event, identity });
    }

    const existingEventId = firstByEventId.get(eventId);
    if (existingEventId === undefined) {
      firstByEventId.set(eventId, { sequence, identity });
    } else if (existingEventId.sequence !== sequence || existingEventId.identity !== identity) {
      conflictingEventIds.add(eventId);
    }
  }

  const presentationEvents = [...firstBySequence.values()]
    .sort((left, right) => left.event.event.sequence - right.event.event.sequence)
    .map(({ event }) => event);
  const sequences = presentationEvents.map(({ event }) => event.sequence);
  const missingSequences: number[] = [];
  let missingSequenceCount = 0;
  let previous: number | null = null;

  for (const sequence of sequences) {
    if (previous !== null) {
      const gapSize = sequence - previous - 1;
      missingSequenceCount += gapSize;
      const reportLimit = Math.min(
        sequence,
        previous + 1 + MAX_REPORTED_MISSING_SEQUENCES - missingSequences.length,
      );
      for (let missing = previous + 1; missing < reportLimit; missing += 1) {
        missingSequences.push(missing);
      }
    }
    previous = sequence;
  }

  const replayState =
    missingSequenceCount > 0 ||
    outOfOrderCount > 0 ||
    conflictingSequences.size > 0 ||
    conflictingEventIds.size > 0
      ? "repairing"
      : "healthy";

  return {
    lastSequence: sequences.at(-1) ?? null,
    duplicateSequences: duplicateSequences.sort((left, right) => left - right),
    duplicateSequenceCount,
    identicalRetryCount,
    outOfOrderCount,
    missingSequences,
    missingSequenceCount,
    conflictingSequences: [...conflictingSequences].sort((left, right) => left - right),
    conflictingEventIds: [...conflictingEventIds].sort(),
    replayState,
    presentationEvents,
  };
}

export function cloudThreadReplayBlockedReason(
  integrity: CloudThreadEventIntegrity,
): string | null {
  return integrity.replayState === "repairing" ? "Repairing cloud thread history" : null;
}

export function formatMicroUsdc(microUsdc: MicroUsdc): string {
  const whole = Math.floor(microUsdc / 1_000_000);
  const fraction = microUsdc % 1_000_000;
  if (fraction === 0) return `${whole}.00`;

  const fixed = `${whole}.${fraction.toString().padStart(6, "0")}`;
  return fixed.replace(/(\.\d{2,}?)0+$/u, "$1");
}

export function cloudComposerBlockedReason(state: CloudThreadComposerState): string | null {
  switch (state) {
    case "ready":
      return null;
    case "submitting":
      return "Sending to the cloud agent";
    case "reconnecting":
      return "Cloud thread is reconnecting";
    case "pausedLowBalance":
      return "Add USDC to resume this thread";
    case "unavailable":
      return "Cloud worker is unavailable";
  }
}

export interface CloudSandboxPresentation {
  readonly label: string;
  readonly tone: "positive" | "neutral" | "warning" | "critical";
}

export function presentCloudSandboxState(state: SandboxProviderState): CloudSandboxPresentation {
  switch (state) {
    case "ready":
      return { label: "Running", tone: "positive" };
    case "provisioning":
      return { label: "Starting", tone: "neutral" };
    case "suspended":
      return { label: "Paused", tone: "warning" };
    case "destroying":
      return { label: "Closing", tone: "neutral" };
    case "destroyed":
      return { label: "Closed", tone: "neutral" };
    case "failed":
      return { label: "Failed", tone: "critical" };
  }
}
