import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  ACTIVE_SUBAGENT_RUNS_REGISTRY_KEY,
  registerActiveSubagentRunSource,
  snapshotActiveSubagentRuns,
} from "../../src/api/active-runs.ts";
import { registerSubagentActiveRunsProvider } from "../../src/extension/active-runs-provider.ts";
import type { AsyncJobState, SubagentState } from "../../src/shared/types.ts";

function clearRegistry(): void {
  delete (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for(ACTIVE_SUBAGENT_RUNS_REGISTRY_KEY)
  ];
}

afterEach(clearRegistry);

function job(asyncId: string, status: AsyncJobState["status"], sessionId?: string): AsyncJobState {
  return {
    asyncId,
    asyncDir: `/tmp/${asyncId}`,
    status,
    ...(sessionId ? { sessionId } : {}),
    agents: ["worker"],
    mode: "single",
    startedAt: Date.now(),
    updatedAt: Date.now(),
  } as AsyncJobState;
}

function stateWith(...jobs: AsyncJobState[]): SubagentState {
  return {
    asyncJobs: new Map(jobs.map((entry) => [entry.asyncId, entry])),
  } as SubagentState;
}

describe("active subagent runs bridge", () => {
  it("aggregates named process-global sources and scopes snapshots to one session", () => {
    const disposeFirst = registerActiveSubagentRunSource({
      name: "source-a",
      listActiveRuns: () => [
        { id: "run-a", sessionId: "session-a" },
        { id: "run-b", sessionId: "session-b" },
      ],
    });
    const disposeSecond = registerActiveSubagentRunSource({
      name: "source-b",
      listActiveRuns: () => [{ id: "run-c", sessionId: "session-a" }],
    });

    assert.deepEqual(snapshotActiveSubagentRuns("session-a"), [
      { id: "run-a", sessionId: "session-a" },
      { id: "run-c", sessionId: "session-a" },
    ]);

    disposeFirst();
    assert.deepEqual(snapshotActiveSubagentRuns("session-a"), [
      { id: "run-c", sessionId: "session-a" },
    ]);
    disposeSecond();
    assert.deepEqual(snapshotActiveSubagentRuns("session-a"), []);
  });

  it("projects only non-terminal jobs with stable session identities", () => {
    const state = stateWith(
      job("queued", "queued", "session-a"),
      job("running", "running", "session-a"),
      job("paused", "paused", "session-a"),
      job("complete", "complete", "session-a"),
      job("failed", "failed", "session-a"),
      job("other-session", "running", "session-b"),
      job("missing-session", "running"),
    );
    const dispose = registerSubagentActiveRunsProvider(state, "session-a");

    assert.deepEqual(snapshotActiveSubagentRuns("session-a"), [
      { id: "queued", sessionId: "session-a" },
      { id: "running", sessionId: "session-a" },
      { id: "paused", sessionId: "session-a" },
    ]);
    assert.deepEqual(snapshotActiveSubagentRuns("session-b"), [
      { id: "other-session", sessionId: "session-b" },
    ]);

    dispose();
    assert.deepEqual(snapshotActiveSubagentRuns("session-a"), []);
  });

  it("keeps a replacement source when the old disposer runs", () => {
    const disposeOld = registerActiveSubagentRunSource({
      name: "session-a",
      listActiveRuns: () => [{ id: "old", sessionId: "session-a" }],
    });
    const disposeNew = registerActiveSubagentRunSource({
      name: "session-a",
      listActiveRuns: () => [{ id: "new", sessionId: "session-a" }],
    });

    disposeOld();
    assert.deepEqual(snapshotActiveSubagentRuns("session-a"), [
      { id: "new", sessionId: "session-a" },
    ]);
    disposeNew();
    assert.deepEqual(snapshotActiveSubagentRuns("session-a"), []);
  });

  it("rejects malformed and duplicate source output", () => {
    registerActiveSubagentRunSource({
      name: "malformed",
      listActiveRuns: () => [{ id: " run", sessionId: "session-a" }],
    });
    assert.throws(() => snapshotActiveSubagentRuns("session-a"), /leading or trailing whitespace/);
    clearRegistry();

    registerActiveSubagentRunSource({
      name: "duplicates",
      listActiveRuns: () => [
        { id: "run-a", sessionId: "session-a" },
        { id: "run-a", sessionId: "session-a" },
      ],
    });
    assert.throws(() => snapshotActiveSubagentRuns("session-a"), /duplicate active run/);
  });
});
