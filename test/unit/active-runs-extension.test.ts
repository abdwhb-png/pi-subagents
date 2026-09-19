import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { SUBAGENT_CHILD_ENV } from "../../src/runs/shared/child-runtime-config.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function parentEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[SUBAGENT_CHILD_ENV];
  return env;
}

describe("subagent extension active-runs bridge", () => {
  it("keeps the rollback bridge dormant during extension lifecycle", () => {
    const script = String.raw`
			import registerSubagentExtension from "./index.ts";
			import { snapshotActiveSubagentRuns } from "./src/api/active-runs.ts";
			const handlers = new Map();
			const eventHandlers = new Map();
			const events = {
				on(channel, handler) {
					const listeners = eventHandlers.get(channel) ?? [];
					listeners.push(handler);
					eventHandlers.set(channel, listeners);
					return () => eventHandlers.set(channel, (eventHandlers.get(channel) ?? []).filter((entry) => entry !== handler));
				},
				emit(channel, payload) {
					for (const handler of eventHandlers.get(channel) ?? []) handler(payload);
				},
			};
			const fakePi = new Proxy({
				events,
				on(name, handler) {
					const listeners = handlers.get(name) ?? [];
					listeners.push(handler);
					handlers.set(name, listeners);
				},
				registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
				sendMessage() {}, sendUserMessage() {}, getSessionName() { return undefined; },
			}, { get(target, prop) { return prop in target ? target[prop] : () => undefined; } });
			registerSubagentExtension(fakePi);
			const ctx = {
				cwd: process.cwd(), hasUI: false,
				ui: { setWidget() {}, requestRender() {}, notify() {}, theme: { fg(_name, text) { return text; }, bg(_name, text) { return text; }, bold(text) { return text; } } },
				sessionManager: {
					getSessionId() { return "session-uuid"; },
					getSessionFile() { return "/sessions/session-active.jsonl"; },
					getEntries() { return []; },
				},
				modelRegistry: { getAvailable() { return []; } },
			};
			for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
			events.emit("subagent:async-started", {
				id: "run-active", pid: 1, sessionId: "/sessions/session-active.jsonl",
				mode: "single", agent: "worker", asyncDir: "/tmp/run-active",
			});
			const active = snapshotActiveSubagentRuns("/sessions/session-active.jsonl");
			if (active.length !== 0) throw new Error("dormant bridge published active runs: " + JSON.stringify(active));
			for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "shutdown" }, ctx);
			const afterShutdown = snapshotActiveSubagentRuns("/sessions/session-active.jsonl");
			if (afterShutdown.length !== 0) throw new Error("shutdown left active runs published: " + JSON.stringify(afterShutdown));
		`;

    execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--import",
        "./test/support/register-loader.mjs",
        "--input-type=module",
        "--eval",
        script,
      ],
      { cwd: projectRoot, env: parentEnv(), stdio: "pipe" },
    );
  });
});
