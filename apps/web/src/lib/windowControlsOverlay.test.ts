import { describe, expect, it } from "vite-plus/test";

import { getElectronPlatformClassNames } from "./windowControlsOverlay";

describe("Electron platform classes", () => {
  it("marks macOS separately for shell vibrancy", () => {
    expect(getElectronPlatformClassNames("MacIntel")).toEqual(["electron", "electron-macos"]);
  });

  it("preserves the Windows class without applying macOS shell styles", () => {
    expect(getElectronPlatformClassNames("Win32")).toEqual(["electron", "electron-windows"]);
  });

  it("does not add a platform-specific class for Linux", () => {
    expect(getElectronPlatformClassNames("Linux x86_64")).toEqual(["electron"]);
  });
});
