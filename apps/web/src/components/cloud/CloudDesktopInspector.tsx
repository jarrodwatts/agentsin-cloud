import type {
  LiveDesktopPendingAction,
  LiveDesktopSnapshot,
} from "@t3tools/client-runtime/inspector";
import type { InspectorInputEvent } from "@t3tools/contracts/inspector";
import {
  CircleAlert,
  LoaderCircle,
  MonitorUp,
  MousePointer2,
  RefreshCw,
  ScreenShare,
  Unplug,
  UserRound,
} from "lucide-react";
import {
  type ComponentProps,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
  useRef,
} from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

/** This is only rendered as an explicitly labelled reference fallback. */
export const CLOUD_DESKTOP_PREVIEW_ASSET = "/assets/agents-in-cloud-desktop-preview.png";
export const CLOUD_DESKTOP_PREVIEW_INTRINSIC_SIZE = {
  width: 960,
  height: 1320,
} as const;

export type CloudDesktopTabStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "unsupported"
  | "error";

export interface CloudDesktopInspectorActions {
  readonly takeControl: () => void;
  readonly resumeControl: () => void;
  readonly releaseControl: () => void;
  readonly retry: () => void;
  readonly sendInput: (input: InspectorInputEvent) => boolean;
}

export interface CloudDesktopInspectorProps extends Omit<ComponentProps<"section">, "children"> {
  readonly snapshot: LiveDesktopSnapshot;
  readonly actions: CloudDesktopInspectorActions;
  /** Reference-only fallback override for deterministic visual tests. */
  readonly referenceAssetSrc?: string;
  /** Crops the deterministic portrait fixture into the live landscape surface. */
  readonly referenceMode?: boolean;
}

export function cloudDesktopTabStatus(snapshot: LiveDesktopSnapshot): CloudDesktopTabStatus {
  switch (snapshot.phase) {
    case "connected":
      return "live";
    case "reconnecting":
      return "reconnecting";
    case "unsupported":
      return "unsupported";
    case "error":
      return "error";
    default:
      return "connecting";
  }
}

interface ControllerPresentation {
  readonly label: string;
  readonly detail: string;
  readonly tone: "agent" | "user" | "disconnected" | "muted";
  readonly action: "take" | "resume" | "release" | "none";
}

export function desktopControllerPresentation(
  snapshot: LiveDesktopSnapshot,
): ControllerPresentation {
  if (snapshot.capabilities?.desktopInput !== true) {
    return {
      label: "View only",
      detail: "This environment does not accept desktop input.",
      tone: "muted",
      action: "none",
    };
  }
  const controller = snapshot.controller;
  if (controller === null) {
    return {
      label: "Checking control",
      detail: "Confirming who controls this desktop.",
      tone: "muted",
      action: "none",
    };
  }
  if (controller.controller === "agent") {
    return {
      label: "Agent controlling",
      detail: "Take Control pauses agent mouse and keyboard input.",
      tone: "agent",
      action: "take",
    };
  }
  if (controller.controller === "disconnected") {
    return controller.resumableByCurrentSession
      ? {
          label: "Your control disconnected",
          detail: "Resume before the control lease expires.",
          tone: "disconnected",
          action: "resume",
        }
      : {
          label: "Controller disconnected",
          detail: "Agent control returns when the lease expires.",
          tone: "disconnected",
          action: "none",
        };
  }
  if (controller.heldByCurrentClient) {
    return {
      label: "You’re controlling",
      detail: "Agent mouse and keyboard input is paused.",
      tone: "user",
      action: "release",
    };
  }
  return {
    label: "Another session controlling",
    detail: "Control is exclusive to the other authenticated session.",
    tone: "user",
    action: "none",
  };
}

const pendingLabel = (pending: LiveDesktopPendingAction): string | null => {
  switch (pending) {
    case "take-control":
      return "Taking control…";
    case "resume":
      return "Resuming control…";
    case "release":
      return "Releasing control…";
    default:
      return null;
  }
};

const inputModifiers = (
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
) => [
  ...(event.altKey ? (["alt"] as const) : []),
  ...(event.ctrlKey ? (["control"] as const) : []),
  ...(event.metaKey ? (["meta"] as const) : []),
  ...(event.shiftKey ? (["shift"] as const) : []),
];

const pointerButton = (button: number): "none" | "left" | "middle" | "right" => {
  if (button === 0) return "left";
  if (button === 1) return "middle";
  if (button === 2) return "right";
  return "none";
};

const pointerInput = (
  event: PointerEvent<HTMLDivElement>,
  action: "down" | "up",
): InspectorInputEvent => {
  const bounds = event.currentTarget.getBoundingClientRect();
  const x = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  const y = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
  return {
    type: "pointer",
    action,
    x: Math.round(x * 1_440),
    y: Math.round(y * 1_024),
    button: pointerButton(event.button),
  };
};

function ControllerAction(props: {
  readonly presentation: ControllerPresentation;
  readonly pending: LiveDesktopPendingAction;
  readonly actions: CloudDesktopInspectorActions;
}) {
  const busyLabel = pendingLabel(props.pending);
  if (busyLabel !== null) {
    return (
      <Button size="sm" variant="outline" disabled aria-label={busyLabel}>
        <LoaderCircle aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
        {busyLabel}
      </Button>
    );
  }
  switch (props.presentation.action) {
    case "take":
      return (
        <Button size="sm" onClick={props.actions.takeControl}>
          <MousePointer2 aria-hidden className="size-3.5" />
          Take Control
        </Button>
      );
    case "resume":
      return (
        <Button size="sm" onClick={props.actions.resumeControl}>
          <RefreshCw aria-hidden className="size-3.5" />
          Resume Control
        </Button>
      );
    case "release":
      return (
        <Button size="sm" variant="outline" onClick={props.actions.releaseControl}>
          Release Control
        </Button>
      );
    default:
      return null;
  }
}

function StatusPill(props: {
  readonly presentation: ControllerPresentation;
  readonly phase: LiveDesktopSnapshot["phase"];
}) {
  const reconnecting = props.phase === "reconnecting";
  const label = reconnecting ? "Reconnecting" : props.presentation.label;
  const Icon = reconnecting
    ? RefreshCw
    : props.presentation.tone === "user"
      ? UserRound
      : props.presentation.tone === "disconnected"
        ? Unplug
        : ScreenShare;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-medium uppercase tracking-[0.07em]",
        props.presentation.tone === "user"
          ? "border-violet-400/35 bg-violet-500/10 text-violet-700 dark:text-violet-200"
          : props.presentation.tone === "agent"
            ? "border-emerald-400/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200"
            : "border-border/70 bg-background/55 text-muted-foreground",
      )}
      data-controller={props.presentation.tone}
    >
      <Icon
        aria-hidden
        className={cn("size-3", reconnecting && "animate-spin motion-reduce:animate-none")}
      />
      {label}
    </span>
  );
}

/** Live, authenticated cloud desktop with server-authoritative exclusive control. */
export function CloudDesktopInspector({
  snapshot,
  actions,
  referenceAssetSrc = CLOUD_DESKTOP_PREVIEW_ASSET,
  referenceMode = false,
  className,
  ...props
}: CloudDesktopInspectorProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const presentation = desktopControllerPresentation(snapshot);
  const controlled =
    snapshot.phase === "connected" &&
    snapshot.capabilities?.desktopInput === true &&
    snapshot.controller?.controller === "user" &&
    snapshot.controller.heldByCurrentClient;
  const loading = snapshot.phase === "idle" || snapshot.phase === "connecting";
  const unavailable = snapshot.phase === "unsupported" || snapshot.phase === "error";

  const handleKey = (event: KeyboardEvent<HTMLDivElement>, action: "down" | "up") => {
    if (event.nativeEvent.isComposing || !controlled) return;
    if (
      actions.sendInput({
        type: "key",
        key: event.key,
        code: event.code,
        action,
        modifiers: inputModifiers(event),
      })
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  const handlePointer = (event: PointerEvent<HTMLDivElement>, action: "down" | "up") => {
    if (!controlled) return;
    surfaceRef.current?.focus();
    if (action === "down") event.currentTarget.setPointerCapture(event.pointerId);
    if (actions.sendInput(pointerInput(event, action))) event.preventDefault();
  };
  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (
      controlled &&
      actions.sendInput({
        type: "scroll",
        deltaX: Math.round(Math.max(-10_000, Math.min(10_000, event.deltaX))),
        deltaY: Math.round(Math.max(-10_000, Math.min(10_000, event.deltaY))),
      })
    ) {
      event.preventDefault();
    }
  };

  return (
    <section
      aria-label="Cloud desktop inspector"
      className={cn("flex min-h-0 min-w-0 flex-1 flex-col bg-background", className)}
      data-cloud-desktop-inspector
      data-cloud-desktop-reference-mode={referenceMode ? "true" : undefined}
      data-cloud-desktop-status={cloudDesktopTabStatus(snapshot)}
      {...props}
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border/70 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="liquid-glass flex size-7 shrink-0 items-center justify-center rounded-lg border border-border/60 text-foreground">
            <MonitorUp aria-hidden className="size-4" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium text-foreground">Desktop</h2>
            <p className="truncate text-xs text-muted-foreground" aria-live="polite">
              {snapshot.phase === "connected"
                ? "Live cloud workspace"
                : snapshot.phase === "reconnecting"
                  ? "Restoring secure connection"
                  : unavailable
                    ? "Desktop unavailable"
                    : "Connecting securely"}
            </p>
          </div>
        </div>
        <StatusPill presentation={presentation} phase={snapshot.phase} />
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        <div className="liquid-glass overflow-hidden rounded-2xl border border-border/70 shadow-lg">
          <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2">
            <div className="min-w-0" aria-live="polite">
              <p className="truncate text-xs font-medium text-foreground">{presentation.label}</p>
              <p className="truncate text-[11px] text-muted-foreground">{presentation.detail}</p>
            </div>
            <ControllerAction
              presentation={presentation}
              pending={snapshot.pendingAction}
              actions={actions}
            />
          </div>

          <div
            ref={surfaceRef}
            className={cn(
              "relative flex aspect-[45/32] w-full items-center justify-center overflow-hidden bg-zinc-950 outline-none",
              controlled &&
                "cursor-crosshair focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-inset",
            )}
            tabIndex={controlled ? 0 : -1}
            aria-label={
              controlled
                ? "Interactive cloud desktop. Keyboard, clicks, and scrolling are sent to the cloud workspace."
                : "Live cloud desktop preview"
            }
            aria-disabled={!controlled}
            onKeyDown={(event) => handleKey(event, "down")}
            onKeyUp={(event) => handleKey(event, "up")}
            onPointerDown={(event) => handlePointer(event, "down")}
            onPointerUp={(event) => handlePointer(event, "up")}
            onWheel={handleWheel}
            onContextMenu={(event) => {
              if (controlled) event.preventDefault();
            }}
          >
            {snapshot.frameUrl !== null ? (
              <img
                key={snapshot.frameUrl}
                src={snapshot.frameUrl}
                alt={referenceMode ? "Cloud desktop reference frame" : "Live cloud desktop frame"}
                className={cn(
                  "block size-full select-none",
                  referenceMode ? "object-cover object-[center_12%]" : "object-contain",
                )}
                draggable={false}
              />
            ) : unavailable ? (
              <div className="relative size-full">
                <img
                  src={referenceAssetSrc}
                  width={CLOUD_DESKTOP_PREVIEW_INTRINSIC_SIZE.width}
                  height={CLOUD_DESKTOP_PREVIEW_INTRINSIC_SIZE.height}
                  alt="Reference desktop appearance; this is not a live stream"
                  className="size-full object-cover opacity-20 grayscale"
                  draggable={false}
                />
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-950/75 p-8 text-center text-zinc-100">
                  <CircleAlert aria-hidden className="size-6 text-amber-300" />
                  <div>
                    <p className="text-sm font-medium">
                      {snapshot.phase === "unsupported"
                        ? "Desktop streaming isn’t supported here"
                        : "Desktop connection failed"}
                    </p>
                    <p className="mt-1 text-xs text-zinc-400">
                      {snapshot.message ?? "The live desktop is unavailable."}
                    </p>
                  </div>
                  {snapshot.phase === "error" ? (
                    <Button size="sm" variant="outline" onClick={actions.retry}>
                      <RefreshCw aria-hidden className="size-3.5" />
                      Try Again
                    </Button>
                  ) : null}
                  <span className="text-[10px] uppercase tracking-[0.08em] text-zinc-500">
                    Reference image — not live
                  </span>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 px-8 text-center text-zinc-300">
                <LoaderCircle
                  aria-hidden
                  className="size-6 animate-spin text-violet-300 motion-reduce:animate-none"
                />
                <p className="text-sm font-medium">
                  {loading ? "Connecting to desktop…" : "Waiting for the first desktop frame…"}
                </p>
                <p className="text-xs text-zinc-500">The workspace keeps running in the cloud.</p>
              </div>
            )}

            {snapshot.phase === "reconnecting" && snapshot.frameUrl !== null ? (
              <div className="absolute inset-x-3 bottom-3 flex items-center justify-center gap-2 rounded-lg border border-white/10 bg-zinc-950/80 px-3 py-2 text-xs text-zinc-200 backdrop-blur motion-reduce:backdrop-blur-none">
                <RefreshCw
                  aria-hidden
                  className="size-3.5 animate-spin motion-reduce:animate-none"
                />
                Reconnecting — showing the last verified frame
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
