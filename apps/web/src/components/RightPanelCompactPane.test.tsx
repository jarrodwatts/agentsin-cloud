import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { compactRightPanelShouldCloseForKey, RightPanelCompactPane } from "./RightPanelCompactPane";

const keyEvent = (
  key: string,
  overrides: Partial<Parameters<typeof compactRightPanelShouldCloseForKey>[0]> = {},
) => ({
  key,
  altKey: false,
  ctrlKey: false,
  defaultPrevented: false,
  metaKey: false,
  shiftKey: false,
  ...overrides,
});

describe("RightPanelCompactPane", () => {
  it("is an in-layout VoiceOver landmark rather than a modal focus trap", () => {
    const html = renderToStaticMarkup(
      <RightPanelCompactPane onClose={vi.fn()}>
        <button type="button">Close inspector</button>
      </RightPanelCompactPane>,
    );

    expect(html).toContain('aria-label="Inspector panel"');
    expect(html).toContain('data-right-panel-compact-pane="true"');
    expect(html).not.toContain('aria-modal="true"');
    expect(html).not.toContain("fixed");
    expect(html).toContain("Close inspector");
  });

  it("reserves unmodified Escape for returning to the composer", () => {
    expect(compactRightPanelShouldCloseForKey(keyEvent("Escape"))).toBe(true);
    expect(compactRightPanelShouldCloseForKey(keyEvent("Enter"))).toBe(false);
    expect(compactRightPanelShouldCloseForKey(keyEvent("Escape", { defaultPrevented: true }))).toBe(
      false,
    );
    expect(compactRightPanelShouldCloseForKey(keyEvent("Escape", { metaKey: true }))).toBe(false);
  });
});
