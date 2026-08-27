export const RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 980px)";
/** The focus-canvas width for the managed desktop inspector at ChatView call sites. */
export const CLOUD_DESKTOP_INSPECTOR_DEFAULT_WIDTH = 480;
/** Keep the managed desktop inspector's remembered width separate from Browser. */
export const CLOUD_DESKTOP_INSPECTOR_WIDTH_STORAGE_KEY = "t3code:right-panel:cloud-desktop-width";

/**
 * Keep a narrow-window sheet above the composer overlay. The sheet is
 * portalled to the document body, so the inset is passed as an inline style
 * rather than through a layout custom property owned by ChatView.
 */
export function resolveRightPanelSheetStyle(bottomInset: number): {
  readonly maxHeight?: string;
  readonly marginBottom?: string;
} {
  const inset = Number.isFinite(bottomInset) ? Math.max(0, Math.ceil(bottomInset)) : 0;
  if (inset === 0) return {};

  return {
    maxHeight: `max(0px, calc(100% - ${inset}px))`,
    marginBottom: `${inset}px`,
  };
}

export const RIGHT_PANEL_SHEET_CLASS_NAME =
  "w-[min(42vw,28rem)] min-w-80 max-w-[28rem] p-0 max-[760px]:w-[min(88vw,24rem)] max-[760px]:min-w-0 wco:mt-[env(titlebar-area-height)] wco:h-[calc(100%-env(titlebar-area-height))] wco:max-h-[calc(100%-env(titlebar-area-height))]";
