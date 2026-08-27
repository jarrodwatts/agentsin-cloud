import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  CLOUD_DESKTOP_PREVIEW_ASSET,
  CLOUD_DESKTOP_PREVIEW_INTRINSIC_SIZE,
  CloudDesktopInspector,
} from "./CloudDesktopInspector";

describe("CloudDesktopInspector", () => {
  it("uses the supplied 2x raster reference at half-size metadata", () => {
    const markup = renderToStaticMarkup(<CloudDesktopInspector />);

    expect(markup).toContain(`src="${CLOUD_DESKTOP_PREVIEW_ASSET}"`);
    expect(markup).toContain(`width="${CLOUD_DESKTOP_PREVIEW_INTRINSIC_SIZE.width}"`);
    expect(markup).toContain(`height="${CLOUD_DESKTOP_PREVIEW_INTRINSIC_SIZE.height}"`);
    expect(markup).toContain("480 × 660");
    expect(markup).toContain('data-cloud-desktop-inspector="true"');
  });

  it("does not imply live connection state or add a control handler", () => {
    const markup = renderToStaticMarkup(
      <CloudDesktopInspector assetSrc="/custom/reference.png" data-testid="cloud-desktop" />,
    );

    expect(markup).toContain('src="/custom/reference.png"');
    expect(markup).toContain("View only");
    expect(markup).toContain("will attach to this surface when the cloud runtime is available");
    expect(markup).not.toContain("onClick");
  });
});
