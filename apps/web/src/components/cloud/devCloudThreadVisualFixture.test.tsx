import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { CloudDesktopInspector } from "./CloudDesktopInspector";
import {
  CLOUD_THREAD_VISUAL_FIXTURE_QUERY_KEY,
  CLOUD_THREAD_VISUAL_FIXTURE_QUERY_VALUE,
  resolveDevCloudThreadVisualFixture,
} from "./devCloudThreadVisualFixture";

const input = {
  search: `?${CLOUD_THREAD_VISUAL_FIXTURE_QUERY_KEY}=${CLOUD_THREAD_VISUAL_FIXTURE_QUERY_VALUE}`,
  environmentId: "environment-visual-fixture" as EnvironmentId,
  threadId: "thread-visual-fixture" as ThreadId,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("active cloud-thread visual fixture", () => {
  it("requires the exact hidden query value and stays disabled by default", () => {
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
      <CloudDesktopInspector snapshot={fixture.desktop.agentControlled} actions={actions} />,
    );
    const userMarkup = renderToStaticMarkup(
      <CloudDesktopInspector snapshot={fixture.desktop.userControlled} actions={actions} />,
    );

    expect(agentMarkup).toContain('data-cloud-desktop-status="live"');
    expect(agentMarkup).toContain("Agent controlling");
    expect(agentMarkup).toContain("Take Control");
    expect(agentMarkup).toContain('src="/assets/agents-in-cloud-desktop-preview.png"');
    expect(userMarkup).toContain("You’re controlling");
    expect(userMarkup).toContain("Release Control");
  });
});
