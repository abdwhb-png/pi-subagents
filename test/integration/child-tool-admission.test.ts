import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { runChildSession } from "../../src/runs/background/run-child-session.ts";
import { buildRunnerChildLaunch } from "../../src/runs/background/runner-child-launch.ts";
import { makeAgent } from "../support/helpers.ts";
import { serializeAgent } from "../../src/agents/agent-serializer.ts";
import registerAdmissionModel from "../fixtures/admission-model.ts";
import { createDefaultChildSessionFactory } from "../../src/runs/shared/child-session.ts";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";

it("native SDK children register tool search and reject missing tools before generation", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tool-admission-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	let shutdowns = 0;
	const previousAudit = process.env.PI_TOOL_ADMISSION_AUDIT;
	process.env.PI_TOOL_ADMISSION_AUDIT = path.join(root, "audit.log");
	const registered: string[][] = [];
	const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: () => import("@earendil-works/pi-coding-agent") });
	try {
		fs.writeFileSync(process.env.PI_TOOL_ADMISSION_AUDIT, "");
		fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
		const launch = (tools: string[]) => {
			const built = buildInProcessChildLaunch({ cwd: root, childAgentName: "admission-fixture", childIndex: 0, host: "parent", sessionEnabled: false, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, tools });
			built.session.model = "admission-fixture/model";
			built.session.hooks.push({ name: "admission-model", factory(pi) {
				registerAdmissionModel(pi);
				pi.on("session_start", () => { registered.push(pi.getAllTools().map(tool => tool.name)); });
				pi.on("session_shutdown", () => { shutdowns++; });
			} });
			return built.session;
		};
		const child = await factory.create(launch(["codemode", "tool_search"]));
		await child.dispose();
		assert.ok(registered[0]?.includes("codemode"));
		assert.ok(registered[0]?.includes("tool_search"));
		await assert.rejects(async () => {
			const invalid = await factory.create(launch(["missing_fixture_tool"]));
			try { await invalid.prompt("Never generate"); } finally { await invalid.dispose(); }
		}, /unavailable child tools: missing_fixture_tool/);
		const providerHook = launch([]).hooks.at(-1)!;
		const guardedFactory = { create: (input: Parameters<typeof factory.create>[0]) => factory.create({ ...input, hooks: [...input.hooks, providerHook] }), dispose: () => factory.dispose() };
		const result = await runSync(root, [makeAgent("admission-fixture", { tools: ["missing_fixture_tool"], model: "admission-fixture/model", extensions: [], inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false })], "admission-fixture", "Never generate", { childSessionFactory: guardedFactory, waitToolEnabled: false });
		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /missing_fixture_tool/);
		const sdk = await import("@earendil-works/pi-coding-agent");
		const retained = sdk.SessionManager.create(root, path.join(root, "sessions"));
		retained.appendMessage({ role: "user", content: "Retained task", timestamp: Date.now() });
		const resumed = await runSync(root, [makeAgent("admission-fixture", { tools: ["missing_fixture_tool"], model: "admission-fixture/model", extensions: [], inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false })], "admission-fixture", "Resume without generation", { childSessionFactory: guardedFactory, sessionFile: retained.getSessionFile()!, waitToolEnabled: false });
		assert.equal(resumed.exitCode, 1);
		assert.match(resumed.error ?? "", /missing_fixture_tool/);
		const runnerLaunch = buildRunnerChildLaunch({ agent: "admission-fixture", task: "Never generate", tools: ["missing_fixture_tool"], extensions: [], inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false }, { cwd: root, id: "admission-runner", flatIndex: 0 }, { model: "admission-fixture/model", sessionEnabled: false, watchdogStatus() {} });
		const background = await runChildSession({ factory: guardedFactory, launch: runnerLaunch, prompt: "Never generate", appendChildEvent() {}, writeOutputLine() {} });
		assert.equal(background.exitCode, 1);
		assert.match(background.error ?? "", /missing_fixture_tool/);
		assert.equal(fs.readFileSync(process.env.PI_TOOL_ADMISSION_AUDIT, "utf8"), "");
		assert.equal(shutdowns, 5);
	} finally {
		try { await factory.dispose(); } finally {
			if (previousAudit === undefined) delete process.env.PI_TOOL_ADMISSION_AUDIT; else process.env.PI_TOOL_ADMISSION_AUDIT = previousAudit;
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
			fs.rmSync(root, { recursive: true, force: true });
		}
	}
});

it("native nested and workflow children reject missing tools before generation", { timeout: 60000 }, async () => {
	const { createSubagentExecutor } = await import("../../src/runs/foreground/subagent-executor.ts");
	const { childSessionFactory, setChildSessionFactory, childSessionFactoryModule, setChildSessionFactoryModule } = await import("../../src/runs/shared/child-session.ts");
	const { createEventBus, makeMinimalCtx } = await import("../support/helpers.ts");
	const { DIRS } = await import("../../src/shared/types.ts");
	const { fileURLToPath } = await import("node:url");
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-workflow-admission-"));
	const previous = { agentDir: process.env.PI_CODING_AGENT_DIR, audit: process.env.PI_TOOL_ADMISSION_AUDIT };
	const previousFactory = childSessionFactory(), previousModule = childSessionFactoryModule();
	const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: () => import("@earendil-works/pi-coding-agent") });
	try {
		process.env.PI_CODING_AGENT_DIR = root;
		process.env.PI_TOOL_ADMISSION_AUDIT = path.join(root, "audit.log");
		fs.writeFileSync(process.env.PI_TOOL_ADMISSION_AUDIT, "");
		fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
		setChildSessionFactory(factory);
		setChildSessionFactoryModule(fileURLToPath(new URL("../support/native-admission-child-factory.ts", import.meta.url)));
		const agents = [makeAgent("admission-fixture", { tools: ["missing_fixture_tool"], model: "admission-fixture/model", extensions: [fileURLToPath(new URL("../fixtures/admission-model.ts", import.meta.url))], inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false })];
		fs.mkdirSync(path.join(root, "agents"), { recursive: true });
		fs.writeFileSync(path.join(root, "agents/admission-fixture.md"), serializeAgent(agents[0]!));
		const supervisor = makeAgent("supervisor", { tools: ["subagent"], allowNestedSubagents: true, model: "admission-fixture/supervisor", extensions: agents[0]!.extensions, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false });
		const nested = await runSync(root, [supervisor], "supervisor", "Delegate to admission-fixture", { childSessionFactory: factory, maxSubagentDepth: 3, waitToolEnabled: false });
		assert.equal(nested.exitCode, 0, nested.error);
		assert.match(nested.finalOutput ?? "", /missing_fixture_tool/);
		assert.equal(fs.readFileSync(process.env.PI_TOOL_ADMISSION_AUDIT, "utf8"), "");
		for (const async of [false, true]) {
			const executor = createSubagentExecutor({ pi: { events: createEventBus(), getSessionName: () => undefined, sendMessage() {} }, state: { baseCwd: root, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null }, config: {}, asyncByDefault: false, tempArtifactsDir: root, getSubagentSessionRoot: () => root, expandTilde: (p: string) => p, discoverAgents: () => ({ agents }) });
			const result = await executor.execute(`workflow-admission-${async}`, { workflowScript: 'return await runs.run("invalid", {agent:"admission-fixture",task:"Never generate"});', async, output: false }, new AbortController().signal, undefined, { ...makeMinimalCtx(root), modelRegistry: { getAvailable: () => [], getRegisteredProviderIds: () => [] } });
			let payload = JSON.stringify(result);
			if (async) {
				const id = result.details?.asyncId;
				assert.ok(id, JSON.stringify(result));
				const file = path.join(DIRS.results, `${id}.json`), deadline = Date.now() + 30000;
				while (!fs.existsSync(file)) { assert.ok(Date.now() < deadline, "Detached workflow never settled"); await new Promise(resolve => setTimeout(resolve, 50)); }
				payload = fs.readFileSync(file, "utf8");
			}
			assert.match(payload, /missing_fixture_tool/);
			assert.equal(fs.readFileSync(process.env.PI_TOOL_ADMISSION_AUDIT, "utf8"), "");
		}
	} finally {
		try { await factory.dispose(); } finally {
			setChildSessionFactory(previousFactory); setChildSessionFactoryModule(previousModule);
			if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.agentDir;
			if (previous.audit === undefined) delete process.env.PI_TOOL_ADMISSION_AUDIT; else process.env.PI_TOOL_ADMISSION_AUDIT = previous.audit;
			fs.rmSync(root, { recursive: true, force: true });
		}
	}
});
