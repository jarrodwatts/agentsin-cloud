import { describe, expect, it } from "vite-plus/test";

import {
  CLOUD_DESKTOP_INSPECTOR_DEFAULT_WIDTH,
  CLOUD_DESKTOP_INSPECTOR_WIDTH_STORAGE_KEY,
  resolveRightPanelSheetStyle,
  RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY,
} from "./rightPanelLayout";

describe("right-panel focus-canvas layout", () => {
  it("keeps the inspector ahead of the mobile sidebar breakpoint", () => {
    expect(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY).toBe("(max-width: 980px)");
    expect(CLOUD_DESKTOP_INSPECTOR_DEFAULT_WIDTH).toBe(480);
    expect(CLOUD_DESKTOP_INSPECTOR_WIDTH_STORAGE_KEY).toBe(
      "t3code:right-panel:cloud-desktop-width",
    );
  });

  it("reserves the composer inset for a portalled narrow-window sheet", () => {
    expect(resolveRightPanelSheetStyle(143.2)).toEqual({
      maxHeight: "max(0px, calc(100% - 144px))",
      marginBottom: "144px",
    });
  });

  it("does not add an inset before the composer has measured", () => {
    expect(resolveRightPanelSheetStyle(0)).toEqual({});
    expect(resolveRightPanelSheetStyle(Number.NaN)).toEqual({});
    expect(resolveRightPanelSheetStyle(-8)).toEqual({});
  });
});
