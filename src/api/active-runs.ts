export const ACTIVE_SUBAGENT_RUNS_PROTOCOL_VERSION = 1;
export const ACTIVE_SUBAGENT_RUNS_REGISTRY_KEY = "pi-subagents.active-runs.v1";

const MAX_SOURCES = 100;
const MAX_SOURCE_NAME_LENGTH = 256;
const MAX_RUNS_PER_SOURCE = 10_000;
const MAX_ID_LENGTH = 256;
const MAX_SESSION_ID_LENGTH = 256;

export interface ActiveSubagentRun {
  id: string;
  sessionId: string;
}

export interface ActiveSubagentRunSource {
  name: string;
  listActiveRuns(): readonly ActiveSubagentRun[];
}

interface ActiveSubagentRunsRegistry {
  version: typeof ACTIVE_SUBAGENT_RUNS_PROTOCOL_VERSION;
  sources: Map<string, ActiveSubagentRunSource>;
}

function registry(): ActiveSubagentRunsRegistry {
  const key = Symbol.for(ACTIVE_SUBAGENT_RUNS_REGISTRY_KEY);
  const globalObject = globalThis as Record<PropertyKey, unknown>;
  const existing = globalObject[key];
  if (existing === undefined) {
    const created: ActiveSubagentRunsRegistry = {
      version: ACTIVE_SUBAGENT_RUNS_PROTOCOL_VERSION,
      sources: new Map(),
    };
    globalObject[key] = created;
    return created;
  }
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    throw new Error(
      `Malformed active-runs registry at Symbol.for("${ACTIVE_SUBAGENT_RUNS_REGISTRY_KEY}").`,
    );
  }
  const candidate = existing as Partial<ActiveSubagentRunsRegistry>;
  if (
    candidate.version !== ACTIVE_SUBAGENT_RUNS_PROTOCOL_VERSION ||
    !(candidate.sources instanceof Map)
  ) {
    throw new Error(
      `Unsupported active-runs registry at Symbol.for("${ACTIVE_SUBAGENT_RUNS_REGISTRY_KEY}").`,
    );
  }
  return candidate as ActiveSubagentRunsRegistry;
}

function validateString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${field} must be a non-empty string without leading or trailing whitespace.`);
  }
  if (value.length > maxLength)
    throw new Error(`${field} must be at most ${maxLength} characters.`);
  if (value.includes("\0")) throw new Error(`${field} must not contain NUL characters.`);
  return value;
}

function validateSource(value: unknown): ActiveSubagentRunSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Active subagent run source must be an object.");
  }
  const source = value as Record<string, unknown>;
  const unknownFields = Object.keys(source).filter(
    (key) => key !== "name" && key !== "listActiveRuns",
  );
  if (unknownFields.length > 0) {
    throw new Error(`Active subagent run source has unknown fields: ${unknownFields.join(", ")}.`);
  }
  validateString(source.name, "Active subagent run source name", MAX_SOURCE_NAME_LENGTH);
  if (typeof source.listActiveRuns !== "function") {
    throw new Error("Active subagent run source must expose listActiveRuns().");
  }
  return value as ActiveSubagentRunSource;
}

function validateRun(value: unknown, index: number): ActiveSubagentRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Active subagent run ${index} must be an object.`);
  }
  const run = value as Record<string, unknown>;
  const unknownFields = Object.keys(run).filter((key) => key !== "id" && key !== "sessionId");
  if (unknownFields.length > 0) {
    throw new Error(
      `Active subagent run ${index} has unknown fields: ${unknownFields.join(", ")}.`,
    );
  }
  return {
    id: validateString(run.id, `Active subagent run ${index} id`, MAX_ID_LENGTH),
    sessionId: validateString(
      run.sessionId,
      `Active subagent run ${index} sessionId`,
      MAX_SESSION_ID_LENGTH,
    ),
  };
}

/** Register or replace one named process-global source. */
export function registerActiveSubagentRunSource(source: ActiveSubagentRunSource): () => void {
  const validated = validateSource(source);
  const current = registry();
  if (!current.sources.has(validated.name) && current.sources.size >= MAX_SOURCES) {
    throw new Error(`Active-runs registry supports at most ${MAX_SOURCES} sources.`);
  }
  current.sources.set(validated.name, validated);
  return () => {
    if (current.sources.get(validated.name) === validated) current.sources.delete(validated.name);
  };
}

/** Snapshot non-terminal pi-subagents runs owned by one exact Pi session. */
export function snapshotActiveSubagentRuns(sessionId: string): readonly ActiveSubagentRun[] {
  validateString(sessionId, "Active-runs snapshot sessionId", MAX_SESSION_ID_LENGTH);
  const current = registry();
  if (current.sources.size > MAX_SOURCES) {
    throw new Error(`Active-runs registry contains more than ${MAX_SOURCES} sources.`);
  }
  const runs: ActiveSubagentRun[] = [];
  const identities = new Set<string>();
  for (const rawSource of current.sources.values()) {
    const source = validateSource(rawSource);
    const active = source.listActiveRuns();
    if (!Array.isArray(active))
      throw new Error("Active subagent run source listActiveRuns() must return an array.");
    if (active.length > MAX_RUNS_PER_SOURCE) {
      throw new Error(
        `Active subagent run source returned ${active.length} runs; maximum is ${MAX_RUNS_PER_SOURCE}.`,
      );
    }
    active.forEach((value, index) => {
      const run = validateRun(value, index);
      const identity = `${run.sessionId}\0${run.id}`;
      if (identities.has(identity)) {
        throw new Error(
          `Active-runs registry contains duplicate active run '${run.id}' for session '${run.sessionId}'.`,
        );
      }
      identities.add(identity);
      if (run.sessionId === sessionId) runs.push(run);
    });
  }
  return runs;
}
