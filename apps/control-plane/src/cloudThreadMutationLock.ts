import type { ThreadId } from "@t3tools/contracts";
import type { WorkspaceId } from "@t3tools/contracts/cloud";
import type { PoolClient } from "pg";

export interface CloudThreadMutationBinding {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
}

/** Serializes durable control-plane decisions that can start or stop desktop activity. */
export const lockCloudThreadMutation = (
  client: Pick<PoolClient, "query">,
  binding: CloudThreadMutationBinding,
) =>
  client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    JSON.stringify([binding.workspaceId, binding.threadId]),
  ]);
