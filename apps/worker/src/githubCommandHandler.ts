import type {
  WorkerGitHubCommand,
  WorkerRelayGitHubCommandResult,
} from "@t3tools/contracts/worker";
import type * as Effect from "effect/Effect";

import type { GitHubGitExecutor } from "./GitHubGitExecutor.ts";

export const executeGitHubWorkerCommand = (
  executor: GitHubGitExecutor,
  command: WorkerGitHubCommand,
): Effect.Effect<WorkerRelayGitHubCommandResult> => executor.execute(command);
