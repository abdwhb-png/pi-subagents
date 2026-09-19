import {
  registerActiveSubagentRunSource,
  type ActiveSubagentRunStatus,
} from "../api/active-runs.ts";
import type { AsyncJobState, SubagentState } from "../shared/types.ts";

function isActive(
  status: AsyncJobState["status"],
): status is ActiveSubagentRunStatus {
  return status === "queued" || status === "running" || status === "paused";
}

/** Publish this runtime's non-terminal jobs through the process-global API. */
export function registerSubagentActiveRunsProvider(
  state: SubagentState,
  sourceName: string,
): () => void {
  return registerActiveSubagentRunSource({
    name: sourceName,
    listActiveRuns: () =>
      [...state.asyncJobs.values()].flatMap((job) => {
        if (!isActive(job.status) || !job.sessionId) return [];
        return [{ id: job.asyncId, sessionId: job.sessionId, status: job.status }];
      }),
  });
}
