// @effect-diagnostics nodeBuiltinImport:off - Regression coverage reads the static boot document.
import * as NodeFS from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SplashScreen } from "./components/SplashScreen";

const indexHtml = NodeFS.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const manifest = JSON.parse(
  NodeFS.readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
) as { readonly name?: string; readonly short_name?: string };

describe("Agents in Cloud web branding", () => {
  it("brands the document before React starts", () => {
    expect(indexHtml).toContain("<title>Agents in Cloud (Alpha)</title>");
    expect(indexHtml).toContain('name="application-name" content="Agents in Cloud"');
    expect(indexHtml).toContain('name="apple-mobile-web-app-title" content="Agents in Cloud"');
    expect(indexHtml).toContain('aria-label="Agents in Cloud splash screen"');
    expect(indexHtml).toContain('alt="Agents in Cloud"');
    expect(manifest).toMatchObject({ name: "Agents in Cloud", short_name: "Agents in Cloud" });
  });

  it("keeps the React splash accessible under the same product name", () => {
    const markup = renderToStaticMarkup(<SplashScreen />);

    expect(markup).toContain('aria-label="Agents in Cloud splash screen"');
    expect(markup).toContain('alt="Agents in Cloud"');
  });
});
