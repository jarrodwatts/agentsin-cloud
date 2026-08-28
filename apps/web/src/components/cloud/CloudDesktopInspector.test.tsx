import type { LiveDesktopSnapshot } from "@t3tools/client-runtime/inspector";
import type { DesktopControllerState } from "@t3tools/contracts/desktop-lease";
import type { InspectorCapabilities } from "@t3tools/contracts/inspector";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  CLOUD_DESKTOP_PREVIEW_ASSET,
  CloudDesktopInspector,
  cloudDesktopTabStatus,
  desktopControllerPresentation,
} from "./CloudDesktopInspector";

const capabilities: InspectorCapabilities = {
  terminal: true,
  files: true,
  ports: false,
  browserFrames: false,
  browserInput: false,
  desktopFrames: true,
  desktopInput: true,
  desktopBackend: "injected",
};

const lease = {
  leaseId: "lease-1" as never,
  generation: 1 as never,
  binding: {
    workspaceId: "workspace-1" as never,
    threadId: "thread-1" as never,
    attemptId: "attempt-1",
    environmentId: "environment-1" as never,
    environmentRevisionId: "revision-1" as never,
    sandboxId: "sandbox-1" as never,
    workerId: "worker-1",
    routeGeneration: 1 as never,
  },
  expiresAt: "2026-08-27T12:01:00.000Z",
};

const snapshot = (
  controller: DesktopControllerState | null,
  input: Partial<LiveDesktopSnapshot> = {},
): LiveDesktopSnapshot => ({
  phase: "connected",
  capabilities,
  controller,
  frameUrl: "https://cloud.test/frame.webp",
  frameMediaType: "image/webp",
  pendingAction: null,
  message: null,
  ...input,
});

const actions = {
  takeControl: vi.fn(),
  resumeControl: vi.fn(),
  releaseControl: vi.fn(),
  retry: vi.fn(),
  sendInput: vi.fn(() => true),
};

describe("CloudDesktopInspector", () => {
  it("exposes the current user's exclusive desktop as a keyboard-operable surface", () => {
    const markup = renderToStaticMarkup(
      <CloudDesktopInspector
        snapshot={snapshot({
          controller: "user",
          lease,
          heldByCurrentClient: true,
          observedAt: "2026-08-27T12:00:00.000Z",
        })}
        actions={actions}
      />,
    );

    expect(markup).toContain("You’re controlling");
    expect(markup).toContain("Release Control");
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain("Interactive cloud desktop. Keyboard, clicks, and scrolling");
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('data-cloud-desktop-status="live"');
    expect(markup).toContain('src="https://cloud.test/frame.webp"');
  });

  it("distinguishes agent, foreign-user, and resumable disconnected control", () => {
    const agent = snapshot({
      controller: "agent",
      observedAt: "2026-08-27T12:00:00.000Z",
    });
    const foreign = snapshot({
      controller: "user",
      lease,
      heldByCurrentClient: false,
      observedAt: "2026-08-27T12:00:00.000Z",
    });
    const disconnected = snapshot({
      controller: "disconnected",
      lease,
      resumableByCurrentSession: true,
      observedAt: "2026-08-27T12:00:00.000Z",
    });

    expect(
      renderToStaticMarkup(<CloudDesktopInspector snapshot={agent} actions={actions} />),
    ).toContain("Take Control");
    const foreignMarkup = renderToStaticMarkup(
      <CloudDesktopInspector snapshot={foreign} actions={actions} />,
    );
    expect(foreignMarkup).toContain("Another session controlling");
    expect(foreignMarkup).not.toContain("Take Control");
    expect(foreignMarkup).toContain('tabindex="-1"');
    expect(
      renderToStaticMarkup(<CloudDesktopInspector snapshot={disconnected} actions={actions} />),
    ).toContain("Resume Control");
  });

  it("labels the reference asset as non-live when the worker has no visual adapter", () => {
    const unsupported = snapshot(null, {
      phase: "unsupported",
      capabilities: {
        ...capabilities,
        desktopFrames: false,
        desktopInput: false,
        desktopBackend: "unsupported",
      },
      frameUrl: null,
      frameMediaType: null,
      message: "This cloud environment does not provide a desktop stream.",
    });
    const markup = renderToStaticMarkup(
      <CloudDesktopInspector snapshot={unsupported} actions={actions} />,
    );

    expect(markup).toContain(`src="${CLOUD_DESKTOP_PREVIEW_ASSET}"`);
    expect(markup).toContain("Reference image — not live");
    expect(markup).toContain("Desktop streaming isn’t supported here");
    expect(markup).not.toContain("Take Control");
    expect(cloudDesktopTabStatus(unsupported)).toBe("unsupported");
  });

  it("uses motion-safe status treatments and honest reconnect copy", () => {
    const reconnecting = snapshot(
      { controller: "agent", observedAt: "2026-08-27T12:00:00.000Z" },
      { phase: "reconnecting", message: "Reconnecting to the cloud desktop…" },
    );
    const markup = renderToStaticMarkup(
      <CloudDesktopInspector snapshot={reconnecting} actions={actions} />,
    );

    expect(markup).toContain("showing the last verified frame");
    expect(markup).toContain("motion-reduce:animate-none");
    expect(markup).toContain("motion-reduce:backdrop-blur-none");
    expect(desktopControllerPresentation(reconnecting).label).toBe("Agent controlling");
  });
});
