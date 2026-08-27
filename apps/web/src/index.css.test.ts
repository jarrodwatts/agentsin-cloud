// @effect-diagnostics nodeBuiltinImport:off - Regression coverage reads the source stylesheet.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const indexCss = NodeFS.readFileSync(new URL("./index.css", import.meta.url), "utf8");

describe("macOS shell glass styles", () => {
  it("scopes translucent shell surfaces to Electron macOS", () => {
    expect(indexCss).toContain('html.electron-macos [data-slot="sidebar-wrapper"]');
    expect(indexCss).toContain("html.electron-macos [data-app-sidebar]");
    expect(indexCss).toContain("html.electron-macos [data-app-shell-inset]");
    expect(indexCss).toContain("html.electron-macos [data-app-shell-content]");
    expect(indexCss).toContain("html.electron-macos [data-app-shell-header]");
    expect(indexCss).toContain("html.electron-macos [data-cloud-desktop-inspector]");
    expect(indexCss).toContain("--app-shell-glass-surface: var(--app-liquid-glass-surface)");
  });

  it("keeps the base glass utility and reduced-transparency path opaque", () => {
    expect(indexCss).toContain("background: var(--app-liquid-glass-fallback);");
    expect(indexCss).toContain("@media (prefers-reduced-transparency: reduce)");
    expect(indexCss).toContain("background: var(--app-liquid-glass-fallback) !important;");
    expect(indexCss).toContain("backdrop-filter: none !important;");
  });
});
