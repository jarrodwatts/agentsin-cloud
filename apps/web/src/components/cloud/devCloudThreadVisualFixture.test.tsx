import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  selectActiveRightPanelSurface,
  selectSelectedRightPanelSurface,
  type ThreadRightPanelState,
  useRightPanelStore,
} from "../../rightPanelStore";
import { CloudDesktopInspector } from "./CloudDesktopInspector";
import {
  DevCloudThreadFocusCanvas,
  shouldRenderDevCloudThreadFocusCanvas,
} from "./DevCloudThreadFocusCanvas";
import {
  CLOUD_THREAD_VISUAL_FIXTURE_QUERY_KEY,
  CLOUD_THREAD_VISUAL_FIXTURE_QUERY_VALUE,
  resolveDevCloudThreadVisualFixture,
} from "./devCloudThreadVisualFixture";
import type { CloudDesktopSession } from "./useCloudDesktopInspector";
import { useDevCloudThreadVisualFixtureSession } from "./useDevCloudThreadVisualFixtureSession";

const input = {
  search: `?${CLOUD_THREAD_VISUAL_FIXTURE_QUERY_KEY}=${CLOUD_THREAD_VISUAL_FIXTURE_QUERY_VALUE}`,
  environmentId: "environment-visual-fixture" as EnvironmentId,
  threadId: "thread-visual-fixture" as ThreadId,
};
const threadRef = scopeThreadRef(input.environmentId, input.threadId);

// ReactDOM needs a host, but this focused unit suite has no browser dependency.
class TestNode {
  parentNode: TestNode | null = null;
  childNodes: TestNode[] = [];
  readonly nodeName: string;
  readonly tagName: string;
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly style = {};

  constructor(
    name: string,
    readonly ownerDocument: TestNode | null = null,
    readonly nodeType = 1,
  ) {
    this.nodeName = name.toUpperCase();
    this.tagName = this.nodeName;
  }

  set textContent(_value: string) {
    this.childNodes = [];
  }

  appendChild(child: TestNode) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child: TestNode) {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }

  createElement(name: string) {
    return new TestNode(name, this);
  }

  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
}

function installTestDom() {
  const document = new TestNode("#document", null, 9);
  const window = {
    document,
    HTMLIFrameElement: TestNode,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("HTMLIFrameElement", window.HTMLIFrameElement);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return document;
}

let observedSession: CloudDesktopSession | null = null;

function FixtureSessionHarness({
  fixture,
}: {
  fixture: ReturnType<typeof resolveDevCloudThreadVisualFixture>;
}) {
  observedSession = useDevCloudThreadVisualFixtureSession({
    environmentId: input.environmentId,
    threadId: input.threadId,
    fixture: fixture?.desktop ?? null,
  });
  return null;
}

beforeEach(() => {
  observedSession = null;
  useRightPanelStore.setState({ byThreadKey: {} });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("active cloud-thread visual fixture", () => {
  it("requires the exact hidden query value and stays disabled by default", () => {
    expect(shouldRenderDevCloudThreadFocusCanvas(false)).toBe(false);
    expect(resolveDevCloudThreadVisualFixture({ ...input, search: "" })).toBeNull();
    expect(
      resolveDevCloudThreadVisualFixture({
        ...input,
        search: `?${CLOUD_THREAD_VISUAL_FIXTURE_QUERY_KEY}=unknown`,
      }),
    ).toBeNull();
  });

  it("cannot activate when Vite marks the bundle as production", () => {
    vi.stubEnv("PROD", true);
    vi.stubEnv("DEV", false);

    expect(resolveDevCloudThreadVisualFixture(input)).toBeNull();
    expect(shouldRenderDevCloudThreadFocusCanvas(true)).toBe(false);
  });

  it("provides a healthy active thread with realistic cloud activity", () => {
    const fixture = resolveDevCloudThreadVisualFixture(input);

    expect(fixture?.timeline.phase).toBe("ready");
    if (fixture?.timeline.phase !== "ready") throw new Error("fixture was not ready");
    expect(fixture.timeline.events.map(({ event }) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(
      fixture.timeline.events.map(({ event }) =>
        event.type === "thread.activity-appended" ? event.payload.activity.summary : null,
      ),
    ).toEqual([
      "Started the E2B cloud workspace",
      "Codex is working in the cloud",
      "Ran 28 focused tests",
      "Pushed a verified checkpoint",
    ]);
    expect(fixture.timeline.runtime).toMatchObject({
      branch: "agents/fix-checkout-race-a12f",
      sandboxState: "ready",
      accruedMicroUsdc: 180_000,
      composerState: "ready",
    });
    expect(fixture.focusCanvas).toMatchObject({
      userRequest:
        "Fix the checkout race, verify it with focused tests, and push a safe checkpoint.",
      checkpoint: { sha: "8c1f2ab", label: "Verified checkpoint pushed" },
    });
  });

  it("renders a deterministic focus canvas instead of persisted thread content", () => {
    const fixture = resolveDevCloudThreadVisualFixture(input);
    if (fixture === null) throw new Error("fixture was not enabled");
    const markup = renderToStaticMarkup(
      <DevCloudThreadFocusCanvas fixture={fixture.focusCanvas} view={fixture.timeline} />,
    );

    expect(shouldRenderDevCloudThreadFocusCanvas(true)).toBe(true);
    expect(markup).toContain('data-dev-cloud-focus-canvas="true"');
    expect(markup).toContain(fixture.focusCanvas.userRequest);
    expect(markup).toContain("Started the E2B cloud workspace");
    expect(markup).toContain("Codex is working in the cloud");
    expect(markup).toContain("Ran 28 focused tests");
    expect(markup).toContain("Pushed a verified checkpoint");
    expect(markup).toContain("2 files changed");
    expect(markup).toContain("src/services/checkout.ts");
    expect(markup).toContain("tests/checkout/checkout.test.ts");
    expect(markup).toContain("Verified checkpoint pushed");
    expect(markup).toContain("8c1f2ab");
    expect(markup).not.toContain("expired");
  });

  it("renders the existing live inspector in agent and user control states", () => {
    const fixture = resolveDevCloudThreadVisualFixture(input);
    if (fixture === null) throw new Error("fixture was not enabled");
    const actions = {
      takeControl: vi.fn(),
      resumeControl: vi.fn(),
      releaseControl: vi.fn(),
      retry: vi.fn(),
      sendInput: vi.fn(() => true),
    };
    const agentMarkup = renderToStaticMarkup(
      <CloudDesktopInspector
        snapshot={fixture.desktop.agentControlled}
        actions={actions}
        referenceMode
      />,
    );
    const userMarkup = renderToStaticMarkup(
      <CloudDesktopInspector snapshot={fixture.desktop.userControlled} actions={actions} />,
    );

    expect(agentMarkup).toContain('data-cloud-desktop-status="live"');
    expect(agentMarkup).toContain('data-cloud-desktop-reference-mode="true"');
    expect(agentMarkup).toContain("object-cover object-[center_12%]");
    expect(agentMarkup).not.toContain("object-contain");
    expect(agentMarkup).toContain("Agent controlling");
    expect(agentMarkup).toContain("Take Control");
    expect(agentMarkup).toContain('src="/assets/agents-in-cloud-desktop-preview.png"');
    expect(userMarkup).toContain("You’re controlling");
    expect(userMarkup).toContain("Release Control");
  });

  it("restores the exact prior panel state when the fixture is disabled", async () => {
    const fixture = resolveDevCloudThreadVisualFixture(input);
    if (fixture === null) throw new Error("fixture was not enabled");
    const previousPanelState: ThreadRightPanelState = {
      isOpen: false,
      activeSurfaceId: "diff",
      surfaces: [
        { id: "cloud-desktop", kind: "cloud-desktop" },
        { id: "diff", kind: "diff" },
      ],
    };
    const threadKey = scopedThreadKey(threadRef);
    useRightPanelStore.setState({ byThreadKey: { [threadKey]: previousPanelState } });
    const document = installTestDom();
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(document.createElement("div") as unknown as Element);

    try {
      await act(() => root.render(<FixtureSessionHarness fixture={fixture} />));
      expect(
        selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
      ).toMatchObject({ kind: "cloud-desktop" });
      expect(observedSession?.snapshot.controller?.controller).toBe("agent");

      await act(() => observedSession?.takeControl());
      expect(observedSession?.snapshot.controller?.controller).toBe("user");

      const fixtureWithNewIdentity = {
        ...fixture,
        desktop: { ...fixture.desktop },
      };
      await act(() => root.render(<FixtureSessionHarness fixture={fixtureWithNewIdentity} />));
      expect(observedSession?.snapshot.controller?.controller).toBe("user");

      await act(() => observedSession?.releaseControl());
      expect(observedSession?.snapshot.controller?.controller).toBe("agent");

      await act(() => root.render(<FixtureSessionHarness fixture={null} />));
      expect(observedSession).toBeNull();
      expect(useRightPanelStore.getState().byThreadKey[threadKey]).toEqual(previousPanelState);
      expect(
        selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
      ).toBeNull();
      expect(
        selectSelectedRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
      ).toMatchObject({ kind: "diff" });
    } finally {
      await act(() => root.unmount());
    }
  });
});
