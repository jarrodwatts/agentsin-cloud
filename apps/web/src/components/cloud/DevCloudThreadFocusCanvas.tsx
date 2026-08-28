import {
  BotIcon,
  CheckCircle2Icon,
  CloudIcon,
  FileCode2Icon,
  GitCommitHorizontalIcon,
  TestTube2Icon,
} from "lucide-react";
import type { ComponentType } from "react";

import { Badge } from "../ui/badge";
import { cn } from "~/lib/utils";
import type { DevCloudThreadFocusCanvasFixture } from "./devCloudThreadVisualFixture";
import {
  inspectCloudThreadEventIntegrity,
  type CloudThreadTimelineView,
} from "./cloudThreadTimelineModel";

interface FixtureActivity {
  readonly kind: string;
  readonly summary: string;
}

function fixtureActivities(view: CloudThreadTimelineView): ReadonlyArray<FixtureActivity> {
  return inspectCloudThreadEventIntegrity(view.events).presentationEvents.flatMap((entry) =>
    entry.event.type === "thread.activity-appended"
      ? [
          {
            kind: entry.event.payload.activity.kind,
            summary: entry.event.payload.activity.summary,
          },
        ]
      : [],
  );
}

function activityIcon(
  kind: string,
): ComponentType<{ className?: string; "aria-hidden"?: boolean }> {
  if (kind.startsWith("sandbox.")) return CloudIcon;
  if (kind.startsWith("provider.")) return BotIcon;
  if (kind.startsWith("checkpoint.")) return GitCommitHorizontalIcon;
  return TestTube2Icon;
}

export function shouldRenderDevCloudThreadFocusCanvas(requested: boolean): boolean {
  return import.meta.env.DEV && !import.meta.env.PROD && requested;
}

export function DevCloudThreadFocusCanvas(props: {
  readonly fixture: DevCloudThreadFocusCanvasFixture;
  readonly view: CloudThreadTimelineView;
}) {
  const activities = fixtureActivities(props.view);
  const additions = props.fixture.files.reduce((total, file) => total + file.additions, 0);
  const deletions = props.fixture.files.reduce((total, file) => total + file.deletions, 0);

  return (
    <section
      aria-label="Development cloud thread fixture"
      className="min-h-0 flex-1 overflow-y-auto"
      data-dev-cloud-focus-canvas="true"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-5 pb-48 pt-6 sm:px-8 sm:pt-8">
        <div className="flex justify-end">
          <div
            className="max-w-[88%] rounded-2xl border border-border/70 bg-muted/65 px-4 py-3 text-sm leading-6 text-foreground shadow-sm"
            data-cloud-fixture-user-request="true"
          >
            {props.fixture.userRequest}
          </div>
        </div>

        <article className="liquid-glass overflow-hidden rounded-2xl border border-border/70 shadow-sm">
          <header className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-xl border border-violet-400/25 bg-violet-500/10 text-violet-600 dark:text-violet-200">
                <BotIcon aria-hidden className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">Codex</p>
                <p className="truncate text-[11px] text-muted-foreground">
                  Working in an E2B cloud workspace
                </p>
              </div>
            </div>
            <Badge className="gap-1.5 rounded-full" size="sm" variant="secondary">
              <CloudIcon aria-hidden className="size-3" />
              Cloud active
            </Badge>
          </header>

          <div className="space-y-4 px-4 py-4">
            <p className="text-sm leading-6 text-foreground/90">{props.fixture.agentSummary}</p>

            <ol className="space-y-1.5" aria-label="Cloud agent progress">
              {activities.map((activity, index) => {
                const Icon = activityIcon(activity.kind);
                const complete = index < activities.length - 1;
                return (
                  <li
                    className="flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs"
                    data-cloud-fixture-event-kind={activity.kind}
                    key={`${activity.kind}:${activity.summary}`}
                  >
                    <span
                      className={cn(
                        "flex size-6 shrink-0 items-center justify-center rounded-lg border",
                        complete
                          ? "border-emerald-400/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
                          : "border-violet-400/25 bg-violet-500/10 text-violet-600 dark:text-violet-200",
                      )}
                    >
                      {complete ? (
                        <CheckCircle2Icon aria-hidden className="size-3.5" />
                      ) : (
                        <Icon aria-hidden className="size-3.5" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1 text-foreground/85">{activity.summary}</span>
                  </li>
                );
              })}
            </ol>

            <div
              className="overflow-hidden rounded-xl border border-border/65 bg-background/45"
              data-cloud-fixture-file-progress="true"
            >
              <div className="flex items-center justify-between gap-3 border-b border-border/55 px-3 py-2.5">
                <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                  <FileCode2Icon aria-hidden className="size-3.5 text-muted-foreground" />
                  {props.fixture.files.length} files changed
                </div>
                <div className="flex items-center gap-2 font-mono text-[11px] tabular-nums">
                  <span className="text-emerald-600 dark:text-emerald-300">+{additions}</span>
                  <span className="text-rose-600 dark:text-rose-300">−{deletions}</span>
                </div>
              </div>
              <ul className="divide-y divide-border/50">
                {props.fixture.files.map((file) => (
                  <li className="flex min-w-0 items-center gap-3 px-3 py-2.5" key={file.path}>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/80">
                      {file.path}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                      <span className="text-emerald-600 dark:text-emerald-300">
                        +{file.additions}
                      </span>
                      {file.deletions > 0 ? (
                        <span className="ml-2 text-rose-600 dark:text-rose-300">
                          −{file.deletions}
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <footer className="flex items-center gap-2 border-t border-border/60 bg-background/30 px-4 py-3 text-xs text-muted-foreground">
            <GitCommitHorizontalIcon aria-hidden className="size-3.5" />
            <span className="font-medium text-foreground/85">{props.fixture.checkpoint.label}</span>
            <code className="rounded-md border border-border/60 bg-background/55 px-1.5 py-0.5 font-mono text-[10px]">
              {props.fixture.checkpoint.sha}
            </code>
          </footer>
        </article>
      </div>
    </section>
  );
}
