import { BotIcon, CloudIcon } from "lucide-react";

import type { DevCloudThreadPresentationFixture } from "./devCloudThreadVisualFixture";

export function DevCloudThreadHeaderIdentity(props: {
  readonly presentation: DevCloudThreadPresentationFixture;
}) {
  return (
    <div
      className="flex min-w-0 flex-1 items-center justify-between gap-3"
      data-dev-cloud-header-identity="true"
    >
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <CloudIcon aria-hidden className="size-3.5 shrink-0 text-violet-500" />
        <span className="max-w-40 truncate text-muted-foreground">
          {props.presentation.workspaceLabel}
        </span>
        <span aria-hidden className="text-border">
          /
        </span>
        <h2 className="min-w-0 truncate font-medium text-foreground">{props.presentation.title}</h2>
      </div>
      <span className="hidden shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-muted/45 px-2.5 py-1 text-[11px] text-muted-foreground sm:inline-flex">
        <BotIcon aria-hidden className="size-3" />
        {props.presentation.providerLabel} · {props.presentation.environmentLabel}
      </span>
    </div>
  );
}

export function DevCloudThreadSidebarTitle(props: {
  readonly presentation: DevCloudThreadPresentationFixture;
}) {
  return <>{props.presentation.title}</>;
}

export function DevCloudThreadBranchIdentity(props: {
  readonly presentation: DevCloudThreadPresentationFixture;
}) {
  return <>{props.presentation.branch}</>;
}

export function DevCloudThreadComposerIdentity(props: {
  readonly presentation: DevCloudThreadPresentationFixture;
}) {
  return (
    <div
      className="flex min-w-0 items-center gap-1 text-xs text-secondary-label"
      data-dev-cloud-composer-identity="true"
    >
      <span className="inline-flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 font-medium text-foreground">
        <BotIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">
          {props.presentation.providerLabel} · {props.presentation.modelLabel}
        </span>
      </span>
      <span aria-hidden className="h-4 w-px bg-border" />
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 font-medium">
        <CloudIcon aria-hidden className="size-3.5" />
        {props.presentation.runtimeLabel}
      </span>
    </div>
  );
}
