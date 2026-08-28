// @effect-diagnostics nodeBuiltinImport:off - Regression coverage reads packaged desktop metadata.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const desktopPackage = JSON.parse(
  NodeFS.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { readonly productName?: string };
const latestDmg = NodeFS.readFileSync(
  new URL("../../resources/dmg/dmg-background-latest.svg", import.meta.url),
  "utf8",
);
const nightlyDmg = NodeFS.readFileSync(
  new URL("../../resources/dmg/dmg-background-nightly.svg", import.meta.url),
  "utf8",
);

describe("Agents in Cloud desktop branding", () => {
  it("uses the product name in packaged application metadata", () => {
    expect(desktopPackage.productName).toBe("Agents in Cloud (Alpha)");
  });

  it("uses the product name in both macOS installer channels", () => {
    expect(latestDmg).toContain("Drag Agents in Cloud to Applications");
    expect(nightlyDmg).toContain("Drag Agents in Cloud to Applications");
  });
});
