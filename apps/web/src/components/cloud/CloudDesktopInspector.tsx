import { MonitorUp, PanelRight, ScreenShare } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

/**
 * The supplied 960px source is intentionally rendered at half size in the
 * inspector so the cloud desktop remains crisp on a 2x display.
 */
export const CLOUD_DESKTOP_PREVIEW_ASSET = "/assets/agents-in-cloud-desktop-preview.png";
export const CLOUD_DESKTOP_PREVIEW_INTRINSIC_SIZE = {
  width: 960,
  height: 1320,
} as const;

export interface CloudDesktopInspectorProps extends ComponentProps<"section"> {
  /** Override only for tests or a future server-provided capture. */
  assetSrc?: string;
}

/**
 * Presentational shell for a managed desktop surface. It deliberately owns
 * no connection or input state; the worker/desktop lease contract can wire
 * those controls in later without making this visual foundation invent a
 * live session.
 */
export function CloudDesktopInspector({
  assetSrc = CLOUD_DESKTOP_PREVIEW_ASSET,
  className,
  ...props
}: CloudDesktopInspectorProps) {
  return (
    <section
      aria-label="Cloud desktop inspector"
      className={cn("flex min-h-0 min-w-0 flex-1 flex-col bg-background", className)}
      data-cloud-desktop-inspector
      {...props}
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border/70 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="liquid-glass flex size-7 shrink-0 items-center justify-center rounded-lg border border-border/60 text-foreground">
            <MonitorUp aria-hidden className="size-4" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium text-foreground">Desktop</h2>
            <p className="truncate text-xs text-muted-foreground">Cloud workspace preview</p>
          </div>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border/60 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          <ScreenShare aria-hidden className="size-3" />
          View only
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        <figure className="liquid-glass overflow-hidden rounded-2xl border border-border/70 shadow-lg">
          <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <PanelRight aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">Reference desktop surface</span>
            </span>
            <span className="shrink-0 font-mono tabular-nums">
              {CLOUD_DESKTOP_PREVIEW_INTRINSIC_SIZE.width / 2} ×{" "}
              {CLOUD_DESKTOP_PREVIEW_INTRINSIC_SIZE.height / 2}
            </span>
          </div>
          <img
            src={assetSrc}
            width={CLOUD_DESKTOP_PREVIEW_INTRINSIC_SIZE.width}
            height={CLOUD_DESKTOP_PREVIEW_INTRINSIC_SIZE.height}
            alt="Cloud desktop showing a code editor and test terminal"
            className="block h-auto w-full object-contain"
            draggable={false}
          />
          <figcaption className="border-t border-border/60 px-3 py-2 text-xs text-muted-foreground">
            Desktop streaming and Take Control will attach to this surface when the cloud runtime is
            available.
          </figcaption>
        </figure>
      </div>
    </section>
  );
}
