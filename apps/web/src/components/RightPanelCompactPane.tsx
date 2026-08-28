import { type ReactNode, useEffect } from "react";

import { cn } from "~/lib/utils";

interface CompactRightPanelKeyEvent {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly defaultPrevented: boolean;
  readonly key: string;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

export function compactRightPanelShouldCloseForKey(event: CompactRightPanelKeyEvent): boolean {
  return (
    event.key === "Escape" &&
    !event.defaultPrevented &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  );
}

/**
 * Narrow windows present the right panel as an in-layout workspace. The chat
 * column is absent while this is mounted, so neither the composer nor its
 * controls can sit underneath the panel. Unlike a modal sheet, this does not
 * trap focus; Escape provides the fast path back to the composer.
 */
export function RightPanelCompactPane(props: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly onClose: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!compactRightPanelShouldCloseForKey(event)) return;
      event.preventDefault();
      props.onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [props.onClose]);

  return (
    <section
      aria-label="Inspector panel"
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background",
        props.className,
      )}
      data-right-panel-compact-pane="true"
    >
      {props.children}
    </section>
  );
}
