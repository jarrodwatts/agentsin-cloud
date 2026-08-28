import { THREAD_SIDEBAR_DEFAULT_WIDTH } from "./components/threadSidebarWidth";

export const RIGHT_PANEL_COMPACT_LAYOUT_MAX_WIDTH = 980;
export const RIGHT_PANEL_COMPACT_LAYOUT_MEDIA_QUERY = `(max-width: ${RIGHT_PANEL_COMPACT_LAYOUT_MAX_WIDTH}px)`;
/** The focus-canvas width for the managed desktop inspector at ChatView call sites. */
export const CLOUD_DESKTOP_INSPECTOR_DEFAULT_WIDTH = 480;
/** Keep the managed desktop inspector's remembered width separate from Browser. */
export const CLOUD_DESKTOP_INSPECTOR_WIDTH_STORAGE_KEY = "t3code:right-panel:cloud-desktop-width";
export const FOCUS_CANVAS_CHAT_MIN_WIDTH = 360;

export interface FocusCanvasLayout {
  readonly mode: "compact" | "inline";
  readonly sidebarWidth: number;
  readonly chatWidth: number;
  readonly panelWidth: number;
}

/**
 * Models the two intentional focus-canvas states. Once the inline columns no
 * longer fit, an explicitly opened panel replaces the chat region instead of
 * floating over the composer. Entering that mode also closes a previously
 * open panel; the user can reopen it as the dedicated compact workspace.
 */
export function resolveFocusCanvasLayout(
  viewportWidth: number,
  panelOpen: boolean,
): FocusCanvasLayout {
  const viewport = Number.isFinite(viewportWidth) ? Math.max(0, Math.floor(viewportWidth)) : 0;
  const sidebarWidth = Math.min(THREAD_SIDEBAR_DEFAULT_WIDTH, viewport);
  const contentWidth = Math.max(0, viewport - sidebarWidth);
  if (!panelOpen) {
    return {
      mode: viewport <= RIGHT_PANEL_COMPACT_LAYOUT_MAX_WIDTH ? "compact" : "inline",
      sidebarWidth,
      chatWidth: contentWidth,
      panelWidth: 0,
    };
  }
  if (viewport <= RIGHT_PANEL_COMPACT_LAYOUT_MAX_WIDTH) {
    return {
      mode: "compact",
      sidebarWidth,
      chatWidth: 0,
      panelWidth: contentWidth,
    };
  }
  const panelWidth = Math.min(
    CLOUD_DESKTOP_INSPECTOR_DEFAULT_WIDTH,
    Math.max(0, contentWidth - FOCUS_CANVAS_CHAT_MIN_WIDTH),
  );
  return {
    mode: "inline",
    sidebarWidth,
    chatWidth: contentWidth - panelWidth,
    panelWidth,
  };
}

export function shouldCollapseRightPanelOnCompactEntry(
  previousCompact: boolean | null,
  nextCompact: boolean,
  panelOpen: boolean,
): boolean {
  return nextCompact && previousCompact !== true && panelOpen;
}

export function performRightPanelToggleForLayout(input: {
  readonly compact: boolean;
  readonly panelOpen: boolean;
  readonly closePanel: () => void;
  readonly restoreComposerFocus: () => void;
  readonly togglePanel: () => void;
}): "compact-close" | "toggle" {
  if (input.compact && input.panelOpen) {
    input.closePanel();
    input.restoreComposerFocus();
    return "compact-close";
  }
  input.togglePanel();
  return "toggle";
}
