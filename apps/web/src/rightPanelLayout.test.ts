// @effect-diagnostics nodeBuiltinImport:off -- Source regression keeps the measured layout contract wired into ChatView.
import * as NodeFS from "node:fs";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  CLOUD_DESKTOP_INSPECTOR_DEFAULT_WIDTH,
  CLOUD_DESKTOP_INSPECTOR_WIDTH_STORAGE_KEY,
  performRightPanelToggleForLayout,
  resolveFocusCanvasLayout,
  RIGHT_PANEL_COMPACT_LAYOUT_MEDIA_QUERY,
  shouldCollapseRightPanelOnCompactEntry,
} from "./rightPanelLayout";

describe("right-panel focus-canvas layout", () => {
  it("keeps the inspector ahead of the mobile sidebar breakpoint", () => {
    expect(RIGHT_PANEL_COMPACT_LAYOUT_MEDIA_QUERY).toBe("(max-width: 980px)");
    expect(CLOUD_DESKTOP_INSPECTOR_DEFAULT_WIDTH).toBe(480);
    expect(CLOUD_DESKTOP_INSPECTOR_WIDTH_STORAGE_KEY).toBe(
      "t3code:right-panel:cloud-desktop-width",
    );
  });

  it("keeps the selected 1440px focus canvas as three non-overlapping columns", () => {
    expect(resolveFocusCanvasLayout(1_440, true)).toEqual({
      mode: "inline",
      sidebarWidth: 236,
      chatWidth: 724,
      panelWidth: 480,
    });
  });

  it("preserves the minimum chat width immediately above the compact boundary", () => {
    expect(resolveFocusCanvasLayout(981, true)).toEqual({
      mode: "inline",
      sidebarWidth: 236,
      chatWidth: 360,
      panelWidth: 385,
    });
  });

  it("uses the whole content region for an explicitly reopened panel at 980px and 900px", () => {
    expect(resolveFocusCanvasLayout(980, true)).toEqual({
      mode: "compact",
      sidebarWidth: 236,
      chatWidth: 0,
      panelWidth: 744,
    });
    expect(resolveFocusCanvasLayout(900, true)).toEqual({
      mode: "compact",
      sidebarWidth: 236,
      chatWidth: 0,
      panelWidth: 664,
    });
    expect(resolveFocusCanvasLayout(900, false)).toEqual({
      mode: "compact",
      sidebarWidth: 236,
      chatWidth: 664,
      panelWidth: 0,
    });
  });

  it("collapses once on compact entry without fighting an explicit reopen", () => {
    expect(shouldCollapseRightPanelOnCompactEntry(false, true, true)).toBe(true);
    expect(shouldCollapseRightPanelOnCompactEntry(null, true, true)).toBe(true);
    expect(shouldCollapseRightPanelOnCompactEntry(true, true, true)).toBe(false);
    expect(shouldCollapseRightPanelOnCompactEntry(false, true, false)).toBe(false);
    expect(shouldCollapseRightPanelOnCompactEntry(true, false, true)).toBe(false);
  });

  it("restores composer focus for the 900px global toggle while preserving the wide toggle", () => {
    const closePanel = vi.fn();
    const restoreComposerFocus = vi.fn();
    const togglePanel = vi.fn();
    const compact = resolveFocusCanvasLayout(900, true);

    expect(
      performRightPanelToggleForLayout({
        compact: compact.mode === "compact",
        panelOpen: true,
        closePanel,
        restoreComposerFocus,
        togglePanel,
      }),
    ).toBe("compact-close");
    expect(closePanel).toHaveBeenCalledTimes(1);
    expect(restoreComposerFocus).toHaveBeenCalledTimes(1);
    expect(togglePanel).not.toHaveBeenCalled();

    expect(
      performRightPanelToggleForLayout({
        compact: resolveFocusCanvasLayout(1_440, true).mode === "compact",
        panelOpen: true,
        closePanel,
        restoreComposerFocus,
        togglePanel,
      }),
    ).toBe("toggle");
    expect(closePanel).toHaveBeenCalledTimes(1);
    expect(restoreComposerFocus).toHaveBeenCalledTimes(1);
    expect(togglePanel).toHaveBeenCalledTimes(1);
  });

  it("wires compact mode as an in-layout replacement rather than a composer overlay", () => {
    const chatViewSource = NodeFS.readFileSync(
      new URL("./components/ChatView.tsx", import.meta.url),
      "utf8",
    );

    expect(chatViewSource).toContain(
      "<RightPanelCompactPane onClose={toggleRightPanelForCurrentLayout}>",
    );
    expect(chatViewSource).toContain("data-chat-column-compact-panel-away={");
    expect(chatViewSource).toContain('? "hidden"');
    expect(chatViewSource).not.toContain("RightPanelSheet");

    const globalToggleStart = chatViewSource.indexOf('if (command === "rightPanel.toggle")');
    const globalToggleEnd = chatViewSource.indexOf(
      'if (command === "rightPanel.toggleMaximized")',
      globalToggleStart,
    );
    const globalToggleBlock = chatViewSource.slice(globalToggleStart, globalToggleEnd);
    expect(globalToggleBlock).toContain("toggleRightPanelForCurrentLayout();");
    expect(globalToggleBlock).not.toContain("toggleRightPanel();");
  });
});
