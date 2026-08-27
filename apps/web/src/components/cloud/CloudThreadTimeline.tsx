import type { ReactNode } from "react";
import { memo, useMemo } from "react";
import {
  AlertTriangleIcon,
  CloudIcon,
  GitBranchIcon,
  RefreshCwIcon,
  WalletCardsIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { cn } from "~/lib/utils";
import {
  cloudComposerBlockedReason,
  formatMicroUsdc,
  inspectCloudThreadEventIntegrity,
  presentCloudSandboxState,
  type CloudThreadEventIntegrity,
  type CloudThreadRuntimePresentation,
  type CloudThreadTimelineView,
} from "./cloudThreadTimelineModel";

export const CloudThreadTimelineFrame = memo(function CloudThreadTimelineFrame(props: {
  readonly view: CloudThreadTimelineView;
  readonly integrity?: CloudThreadEventIntegrity;
  readonly onRetry?: () => void;
  readonly children: ReactNode;
}) {
  const integrity = useMemo(
    () => props.integrity ?? inspectCloudThreadEventIntegrity(props.view.events),
    [props.integrity, props.view.events],
  );
  const replayIssue = integrity.replayState === "repairing";

  return (
    <section
      className="relative flex min-h-0 flex-1 flex-col"
      data-cloud-thread-timeline="true"
      data-cloud-thread-phase={props.view.phase}
      data-cloud-thread-replay-state={integrity.replayState}
    >
      {props.view.phase === "loading" && !replayIssue ? (
        <div
          className="pointer-events-none absolute inset-x-0 top-5 z-10 mx-auto flex w-fit items-center gap-2 rounded-full border border-border/70 bg-background/90 px-3 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur-xl"
          role="status"
        >
          <CloudIcon className="size-3.5" aria-hidden="true" />
          Restoring cloud thread…
        </div>
      ) : null}
      {props.view.phase === "error" ? (
        <div className="absolute inset-x-3 top-3 z-20 mx-auto flex max-w-3xl items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-foreground shadow-sm backdrop-blur-xl">
          <AlertTriangleIcon className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
          <p className="min-w-0 flex-1 truncate" role="alert">
            {props.view.message}
          </p>
          {props.onRetry ? (
            <Button size="xs" variant="outline" onClick={props.onRetry}>
              <RefreshCwIcon className="size-3" aria-hidden="true" />
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}
      {replayIssue && props.view.phase !== "error" ? (
        <div className="absolute inset-x-3 top-3 z-20 mx-auto flex max-w-3xl items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-foreground shadow-sm backdrop-blur-xl">
          <AlertTriangleIcon className="size-3.5 shrink-0 text-amber-500" aria-hidden="true" />
          <p role="status">Replaying cloud history to repair event delivery integrity.</p>
        </div>
      ) : null}
      {props.children}
    </section>
  );
});

const STATUS_DOT_CLASS = {
  positive: "bg-emerald-400",
  neutral: "bg-muted-foreground/60",
  warning: "bg-amber-400",
  critical: "bg-destructive",
} as const;

export const CloudThreadStatusBar = memo(function CloudThreadStatusBar(props: {
  readonly runtime: CloudThreadRuntimePresentation;
}) {
  const sandbox = presentCloudSandboxState(props.runtime.sandboxState);
  const composerBlockReason = cloudComposerBlockedReason(props.runtime.composerState);

  return (
    <div
      className="@container/cloud-status flex min-h-9 min-w-0 items-center overflow-hidden divide-x divide-border/60 border-t border-border/60 text-[11px] text-muted-foreground"
      data-cloud-thread-status="true"
      role="group"
      aria-label="Cloud thread status"
    >
      <div className="hidden min-w-0 flex-1 items-center gap-1.5 px-3 @[30rem]/cloud-status:flex">
        <GitBranchIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate font-mono text-foreground/80">
          {props.runtime.branch ?? "Branch preparing"}
        </span>
      </div>
      <div
        className="flex min-w-0 flex-1 items-center gap-1.5 px-2 @[30rem]/cloud-status:flex-none @[30rem]/cloud-status:px-3"
        role="group"
        aria-label={`E2B Cloud, ${sandbox.label}`}
      >
        <CloudIcon className="size-3.5" aria-hidden="true" />
        <span>
          E2B<span className="hidden @[24rem]/cloud-status:inline"> Cloud</span>
        </span>
        <span
          className={cn("size-1.5 rounded-full", STATUS_DOT_CLASS[sandbox.tone])}
          aria-hidden="true"
        />
        <span className="text-foreground/80">{sandbox.label}</span>
      </div>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5 px-2 tabular-nums @[30rem]/cloud-status:flex-none @[30rem]/cloud-status:px-3">
        <WalletCardsIcon className="size-3.5" aria-hidden="true" />
        <span className="text-foreground/80">
          {formatMicroUsdc(props.runtime.accruedMicroUsdc)} USDC
        </span>
        <span className="hidden @[25rem]/cloud-status:inline">· Monad</span>
      </div>
      <span className="sr-only">
        {composerBlockReason ? `Composer unavailable: ${composerBlockReason}.` : "Composer ready."}
      </span>
    </div>
  );
});
