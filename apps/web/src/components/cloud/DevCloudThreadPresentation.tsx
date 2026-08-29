import { BotIcon, CloudIcon, GitBranchIcon } from "lucide-react";

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
      <span
        className="hidden shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-muted/45 px-2.5 py-1 text-[11px] text-muted-foreground xl:inline-flex"
        data-dev-cloud-header-secondary-identity="true"
      >
        <BotIcon aria-hidden className="size-3" />
        {props.presentation.providerLabel} · {props.presentation.environmentLabel}
      </span>
    </div>
  );
}

export function DevCloudThreadSidebarRow(props: {
  readonly presentation: DevCloudThreadPresentationFixture;
  readonly onActivate?: () => void;
}) {
  const accessibleLabel = [
    props.presentation.workspaceLabel,
    props.presentation.title,
    props.presentation.runtimeLabel,
    props.presentation.branch,
  ].join(", ");

  return (
    <li
      className="list-none py-0.5 [content-visibility:auto] [contain-intrinsic-size:auto_96px]"
      data-dev-cloud-sidebar-row="true"
      data-thread-item
    >
      <button
        type="button"
        aria-label={accessibleLabel}
        className="w-full cursor-pointer overflow-hidden rounded-md bg-sidebar-row-active px-[var(--sidebar-row-content-inset)] py-[var(--sidebar-content-inset)] text-left text-sidebar-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={props.onActivate}
      >
        <span className="flex h-5 min-w-0 items-center gap-1.5">
          <CloudIcon aria-hidden className="size-4 shrink-0 text-violet-500" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-secondary-label">
            {props.presentation.workspaceLabel}
          </span>
          <span className="shrink-0 text-xs font-medium text-sky-600 dark:text-sky-400">
            Cloud active
          </span>
        </span>
        <span className="mt-1 block min-w-0 truncate text-sm font-medium text-foreground/90">
          {props.presentation.title}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-secondary-label">
          <GitBranchIcon aria-hidden className="size-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate whitespace-nowrap">
            {props.presentation.branch}
          </span>
          <CloudIcon aria-hidden className="size-3 shrink-0" />
          <span className="shrink-0">{props.presentation.runtimeLabel}</span>
        </span>
      </button>
    </li>
  );
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
