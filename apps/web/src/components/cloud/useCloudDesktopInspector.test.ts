import type { InspectorArtifactReference } from "@t3tools/contracts/inspector";
import { describe, expect, it } from "vite-plus/test";

import { cloudDesktopArtifactUrl, cloudDesktopWebSocketUrl } from "./useCloudDesktopInspector";

const connection = {
  controlPlaneOrigin: "https://agents.example/",
  attemptId: "attempt-1" as never,
};

describe("cloud desktop authenticated endpoints", () => {
  it("uses the same authenticated origin and sends no workspace or credential in the URL", () => {
    const url = cloudDesktopWebSocketUrl(connection, "thread-1" as never);

    expect(url.toString()).toBe(
      "wss://agents.example/api/v1/inspector?threadId=thread-1&attemptId=attempt-1",
    );
    expect(url.searchParams.has("workspaceId")).toBe(false);
    expect(url.searchParams.has("token")).toBe(false);
  });

  it("builds an authenticated no-store artifact URL from the opaque server reference", () => {
    const artifact = {
      artifactId: "artifact-1",
      kind: "desktop-frame",
      mediaType: "image/webp",
      byteLength: 512,
      sha256: "a".repeat(64),
    } as InspectorArtifactReference;

    expect(cloudDesktopArtifactUrl(connection, "thread-1" as never, artifact)).toBe(
      "https://agents.example/api/v1/inspector/artifacts/artifact-1?threadId=thread-1&attemptId=attempt-1",
    );
  });

  it("rejects endpoint paths instead of silently sending cookies to the wrong route", () => {
    expect(() =>
      cloudDesktopWebSocketUrl(
        { ...connection, controlPlaneOrigin: "https://agents.example/not-an-origin" },
        "thread-1" as never,
      ),
    ).toThrow("must be an origin");
    expect(() =>
      cloudDesktopWebSocketUrl(
        { ...connection, controlPlaneOrigin: "http://agents.example/" },
        "thread-1" as never,
      ),
    ).toThrow("must use HTTPS");
  });
});
