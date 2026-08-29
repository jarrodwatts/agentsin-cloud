import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useRightPanelStore } from "../../rightPanelStore";
import type { CloudDesktopVisualFixture } from "./devCloudThreadVisualFixture";
import type { CloudDesktopSession } from "./useCloudDesktopInspector";

type FixtureController = "agent" | "user";

/**
 * Owns the visual fixture's temporary panel and controller state without
 * leaking either into an ordinary thread session.
 */
export function useDevCloudThreadVisualFixtureSession(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly fixture: CloudDesktopVisualFixture | null;
  readonly compactLayout: boolean;
}): CloudDesktopSession | null {
  const threadKey = scopedThreadKey(input);
  const fixture = import.meta.env.PROD || !import.meta.env.DEV ? null : input.fixture;
  const [control, setControl] = useState<{
    readonly threadKey: string;
    readonly controller: FixtureController;
  } | null>(null);
  const controller = control?.threadKey === threadKey ? control.controller : "agent";
  const fixtureActive = fixture !== null;

  useEffect(() => {
    if (!fixtureActive) return;

    const previousThreadState = useRightPanelStore.getState().byThreadKey[threadKey];

    return () => {
      useRightPanelStore.setState((state) => {
        if (previousThreadState === undefined) {
          if (!(threadKey in state.byThreadKey)) return state;
          const { [threadKey]: _removed, ...rest } = state.byThreadKey;
          return { byThreadKey: rest };
        }
        return {
          byThreadKey: {
            ...state.byThreadKey,
            [threadKey]: previousThreadState,
          },
        };
      });
    };
  }, [fixtureActive, input.environmentId, input.threadId, threadKey]);

  useEffect(() => {
    if (!fixtureActive || input.compactLayout) return;

    const threadRef = scopeThreadRef(input.environmentId, input.threadId);
    useRightPanelStore.getState().open(threadRef, "cloud-desktop");
  }, [fixtureActive, input.compactLayout, input.environmentId, input.threadId]);

  const takeControl = useCallback(() => {
    setControl({ threadKey, controller: "user" });
  }, [threadKey]);
  const releaseControl = useCallback(() => {
    setControl({ threadKey, controller: "agent" });
  }, [threadKey]);

  return useMemo(() => {
    if (fixture === null) return null;
    return {
      snapshot: controller === "user" ? fixture.userControlled : fixture.agentControlled,
      takeControl,
      resumeControl: takeControl,
      releaseControl,
      retry: () => undefined,
      sendInput: () => controller === "user",
    };
  }, [controller, fixture, releaseControl, takeControl]);
}
