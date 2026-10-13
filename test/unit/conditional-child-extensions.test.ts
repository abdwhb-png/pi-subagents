import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { registerRequiredChildExtensions } from "../../src/api/required-child-extensions.ts";
import { assertRequiredChildExtensionsAdmitted, resolveRequiredChildExtensions, readRetainedRequiredChildExtensions, writeRetainedRequiredChildExtensions } from "../../src/shared/required-child-extensions.ts";
import { buildRunnerChildLaunch } from "../../src/runs/background/runner-child-launch.ts";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";

const base = { sessionEnabled: false, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, cwd: process.cwd(), childAgentName: "worker", childIndex: 0, host: "parent" as const };

it("loads a conditional provider only for an effective requested tool", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-conditional-ext-"));
	const file = path.join(dir, "provider.mjs");
	fs.writeFileSync(file, "export default () => {};\n");
	try {
		const registration = registerRequiredChildExtensions({ sessionId: "conditional-selection", extensions: [{ id: "provider", path: file, whenTools: ["inspect_symbols"] }] });
		try {
			const launch = (tools: string[]) => buildInProcessChildLaunch({ ...base, parentSessionId: "conditional-selection", tools });
			assert.deepEqual(launch(["read"]).session.requiredExtensions, []);
			assert.deepEqual(launch(["inspect_symbols"]).session.requiredExtensions?.map(({ id }) => id), ["provider"]);
		} finally { registration.dispose(); }
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it("respects exclusions, ceilings, explicit providers, and empty selections", () => {
	const requiredExtensions = [{ id: "provider", path: "/tmp/provider.mjs", whenTools: ["inspect_symbols"] }];
	const selection = { ...base, tools: ["inspect_symbols"], requiredExtensions };
	for (const overrides of [
		{ tools: [] },
		{ tools: undefined },
		{ excludeTools: ["inspect_symbols"] },
		{ capabilityCeiling: { version: 1 as const, allowedTools: ["read"], denyExtensions: false, sources: ["test"] } },
		{ capabilityCeiling: { version: 1 as const, denyExtensions: true, sources: ["test"] } },
		{ extensions: [] },
		{ extensions: ["/tmp/explicit.mjs"] },
		{ subagentOnlyExtensions: [] },
		{ subagentOnlyExtensions: ["/tmp/explicit.mjs"] },
		{ tools: ["inspect_symbols", "/tmp/explicit.mjs"] },
	]) {
		const launch = buildInProcessChildLaunch({ ...selection, ...overrides });
		assert.deepEqual(launch.session.requiredExtensions, [], JSON.stringify(overrides));
		assert.equal(launch.session.extensionPaths.includes("/tmp/provider.mjs"), false);
	}
});

it("retains the full frozen catalogue through an intermediate child and a detached runner", () => {
	const catalogue = [{ id: "provider", path: "/tmp/provider.mjs", whenTools: ["inspect_symbols"] }];
	const parent = buildInProcessChildLaunch({ ...base, tools: ["read"], requiredExtensions: catalogue, allowNestedSubagents: true });
	assert.deepEqual(parent.session.requiredExtensions, []);
	assert.deepEqual(parent.config.requiredExtensions, catalogue);
	assert.ok(Object.isFrozen(parent.config.requiredExtensions));
	const nested = buildInProcessChildLaunch({ ...base, tools: ["inspect_symbols"], inherited: { depth: 1, requiredExtensions: parent.config.requiredExtensions } });
	assert.deepEqual(nested.session.requiredExtensions?.map(({ id }) => id), ["provider"]);
	const runner = buildRunnerChildLaunch({ agent: "worker", task: "test", tools: ["inspect_symbols"], inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, requiredExtensions: JSON.parse(JSON.stringify(parent.config.requiredExtensions)) }, { cwd: process.cwd(), id: "run", flatIndex: 0 }, { sessionEnabled: false, watchdogStatus() {} });
	assert.deepEqual(runner.session.requiredExtensions, nested.session.requiredExtensions);
});

it("captures fresh synchronous providers per root launch, then detaches from the registration", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-provider-callback-"));
	const file = path.join(dir, "provider.mjs");
	fs.writeFileSync(file, "export default () => {};\n");
	let names = ["inspect_symbols"];
	let calls = 0;
	try {
		const registration = registerRequiredChildExtensions({ sessionId: "provider-callback", extensions: () => { calls++; return [{ id: "provider", path: file, whenTools: names }]; } });
		try {
			assert.equal(calls, 0);
			const first = buildInProcessChildLaunch({ ...base, parentSessionId: "provider-callback", tools: ["read"] });
			names.push("inspect_files");
			const second = buildInProcessChildLaunch({ ...base, parentSessionId: "provider-callback", tools: ["inspect_files"] });
			assert.equal(calls, 2);
			assert.deepEqual(first.config.requiredExtensions?.[0]?.whenTools, ["inspect_symbols"]);
			assert.deepEqual(second.session.requiredExtensions?.[0]?.whenTools, ["inspect_files", "inspect_symbols"]);
			assert.ok(Object.isFrozen(second.session.requiredExtensions?.[0]?.whenTools));
			registration.dispose();
			const resumed = buildInProcessChildLaunch({ ...base, tools: ["inspect_symbols"], requiredExtensions: JSON.parse(JSON.stringify(first.config.requiredExtensions)) });
			assert.deepEqual(resumed.session.requiredExtensions?.map(({ id }) => id), ["provider"]);
			assert.deepEqual(resolveRequiredChildExtensions("provider-callback"), []);
		} finally { registration.dispose(); }
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it("validates callback output and concrete bounded tool names without accepting aliases or paths", () => {
	for (const whenTools of [[], ["@inspect"], ["*"], [" inspect"], ["path/provider.ts"], [""], new Array(1), Array(257).fill("read")]) {
		assert.throws(() => buildInProcessChildLaunch({ ...base, requiredExtensions: [{ id: "provider", path: "/tmp/provider.mjs", whenTools }] }), /concrete tool names/);
	}
	for (const output of [Promise.resolve([]), null, [{ id: "provider", path: "/missing-provider.mjs", whenTools: ["read"] }]]) {
		// Deliberately violate the external callback contract to verify runtime validation.
		const registration = registerRequiredChildExtensions({ sessionId: "invalid-callback", extensions: (() => output) as () => [] });
		try { assert.throws(() => resolveRequiredChildExtensions("invalid-callback"), /array|importable file/); }
		finally { registration.dispose(); }
	}
});

it("persists a conditional catalogue for workflow append without requiring external runner admission", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-provider-retention-"));
	try {
		const catalogue = [{ id: "provider", path: "/tmp/provider.mjs", whenTools: ["inspect_symbols"] }];
		writeRetainedRequiredChildExtensions(dir, catalogue);
		assert.deepEqual(readRetainedRequiredChildExtensions(dir), catalogue);
		assertRequiredChildExtensionsAdmitted([catalogue], { agent: "worker", runnerType: "external-cli" });
		assertRequiredChildExtensionsAdmitted([catalogue], { agent: "worker", machine: "remote" });
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
