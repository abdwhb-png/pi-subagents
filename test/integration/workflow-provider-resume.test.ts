import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { installSingleExecutionHooks, available, createSubagentExecutor, mockPi, tempDir } from "../support/single-execution-fixture.ts";
import { createEventBus, makeAgent, makeMinimalCtx } from "../support/helpers.ts";
import { registerRequiredChildExtensions } from "../../src/api/required-child-extensions.ts";
import { DIRS } from "../../src/shared/types.ts";
import { prepareWorkflowResume } from "../../src/workflows/workflow-resume.ts";
import { readWorkflowLaunchRecord } from "../../src/workflows/workflow-launch-record.ts";
import { WORKFLOW_STOP_CAUSE_OWNER_EXITED } from "../../src/workflows/workflow-stop-cause.ts";

describe("provider authority across whole-workflow restart", { skip: !available || !createSubagentExecutor }, () => {
	installSingleExecutionHooks();
	const executor = () => createSubagentExecutor!({
		pi: { events: createEventBus(), getSessionName: () => undefined, sendMessage() {} },
		state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
		config: {}, asyncByDefault: false, tempArtifactsDir: tempDir, getSubagentSessionRoot: () => tempDir,
		expandTilde: (p: string) => p, discoverAgents: () => ({ agents: [makeAgent("worker", { tools: ["read"] })] }),
	});
	const waitForResult = async (id: string) => {
		const file = path.join(DIRS.results, `${id}.json`), deadline = Date.now() + 15000;
		while (!fs.existsSync(file)) {
			assert.ok(Date.now() < deadline, `Workflow ${id} never settled`);
			await new Promise(resolve => setTimeout(resolve, 25));
		}
	};
	for (const trigger of ["manual", "auto"] as const) for (const populated of [false, true]) {
		it(`retains ${populated ? "populated" : "empty"} authority after ${trigger} restart with a new executor`, async () => {
			const ctx = makeMinimalCtx(tempDir);
			const provider = path.join(tempDir, "original.mjs");
			fs.writeFileSync(provider, "export default () => {};\n");
			const catalogue = populated ? [{ id: "original", path: fs.realpathSync(provider), whenTools: ["read"] }] : [];
			const old = registerRequiredChildExtensions({ sessionId: "session-123", extensions: catalogue });
			let id: string;
			try {
				mockPi.onCall({ output: "initial failed child", exitCode: 1 });
				const result = await executor().executePublic("original", { workflowScript: 'return await runs.run("later", {agent:"worker",task:"Inspect",async:false});', async: true, output: false }, new AbortController().signal, undefined, ctx);
				assert.ok(result.details?.asyncId, JSON.stringify(result));
				id = result.details.asyncId;
				await waitForResult(id);
			} finally { old.dispose(); }
			const statusFile = path.join(DIRS.async, id, "status.json");
			// Simulate an exited owner using only temporary run state; the protected launch stays untouched.
			const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
			status.state = "failed";
			status.workflow.stopCause = WORKFLOW_STOP_CAUSE_OWNER_EXITED;
			fs.writeFileSync(statusFile, JSON.stringify(status));
			const lateProvider = path.join(tempDir, "late.mjs");
			fs.writeFileSync(lateProvider, "export default () => {};\n");
			const late = registerRequiredChildExtensions({ sessionId: "session-123", extensions: [{ id: "late", path: lateProvider, whenTools: ["read"] }] });
			try {
				const prepared = prepareWorkflowResume({ asyncDirRoot: DIRS.async, sourceRunId: id, currentSessionId: "session-123", trigger });
				assert.ok(prepared.ok, JSON.stringify(prepared));
				assert.deepEqual(prepared.prepared.requiredExtensions, catalogue);
				assert.equal(Object.hasOwn(prepared.prepared.params, "requiredExtensions"), false, "Provider authority must stay outside public workflow parameters");
				mockPi.onCall({ output: "resumed" });
				const resumed = await executor().executeWorkflowResume("restart", prepared.prepared, new AbortController().signal, ctx);
				assert.ok(resumed.result.details?.asyncId, JSON.stringify(resumed));
				await waitForResult(resumed.result.details.asyncId);
				assert.ok(mockPi.sessions.length >= 2, "A restarted child must actually launch");
				assert.deepEqual(mockPi.sessions.at(-1)?.launch.runtime.requiredExtensions, catalogue);
				const record = readWorkflowLaunchRecord(DIRS.async, resumed.result.details.asyncId);
				assert.ok(record.ok);
				assert.deepEqual(record.record.requiredExtensions, catalogue, "A subsequent restart must retain the same authority");
			} finally { late.dispose(); }
		});
	}
});
