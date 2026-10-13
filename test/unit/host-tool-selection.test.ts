import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgents, discoverAgentsAll, discoverAgentSnapshot, findBlockingAgentDiagnostic } from "../../src/agents/agents.ts";
import { registerAgent } from "../../src/api/agents.ts";
import { clearRuntimeAgentsForPi, mergeRuntimeAgents } from "../../src/agents/runtime-agent-registry.ts";
import { handleManagementAction } from "../../src/agents/agent-management.ts";
import { resolveSubagentLaunchContract } from "../../src/api/preflight.ts";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";

const originalEnv = { ...process.env };
let root: string;
let cwd: string;
let agentDir: string;
let provider: string;
let pi: ExtensionAPI;
function json<Value>(file: string, value: Value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value));
}
function agent(name: string, tools = "@inspect", directory = path.join(agentDir, "agents")) {
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(path.join(directory, `${name}.md`), `---\nname: ${name}\ndescription: Fixture\naliases: short-${name}\ntools: ${tools}\n---\nFixture.\n`);
}
function settings(resolver: string = provider, overrides: Record<string, {tools?:string[] | string; model?:string}> = {}) {
	json(path.join(agentDir, "settings.json"), { subagents: { toolSelectionResolver: resolver, agentOverrides: overrides } });
}
beforeEach(() => {
	// SAFETY: Registration validates only on/registerTool; discovery uses this object solely as the registry owner.
	pi = { on() {}, registerTool() {} } as ExtensionAPI;
	root = fs.mkdtempSync(path.join(os.tmpdir(), "host-tools-"));
	cwd = path.join(root, "project");
	agentDir = path.join(root, "agent");
	fs.mkdirSync(cwd);
	process.env.HOME = root;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
	provider = path.join(root, "provider.ts");
	fs.writeFileSync(provider, `export function resolveTools({ selections }) { return selections.map(({ selectors }) => ({ ok: true, selectors: selectors.flatMap(s => s === "@inspect" ? ["read", "mcp:fixture/lookup"] : [s]) })); }`);
	settings();
	agent("fixture");
});
afterEach(() => {
	clearRuntimeAgentsForPi(pi);
	for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
	Object.assign(process.env, originalEnv);
	fs.rmSync(root, { recursive: true, force: true });
});
it("resolves effective selections on cached and uncached discovery without rewriting declarations", () => {
	for (const scope of ["both", "user"] as const) {
		const selected = discoverAgents(cwd, scope).agents.find(a => a.name === "fixture");
		assert.deepEqual(selected?.tools, ["read"]);
		assert.deepEqual(selected?.mcpDirectTools, ["fixture/lookup"]);
	}
	assert.deepEqual(discoverAgentsAll(cwd).user.find(a => a.name === "fixture")?.tools, ["@inspect"]);
});

it("resolves extension-owned runtime tool aliases before building the child launch", () => {
	fs.writeFileSync(provider, `export function resolveTools({ selections }) { return selections.map(({ selectors }) => ({ ok: true, selectors: selectors.flatMap(s => s === "@inspect" ? ["read", "grep"] : [s]) })); }`);
	settings(provider, { "runtime-helper": { tools: ["bash"], model: "p/override" } });
	registerAgent({ pi, name: "runtime-helper", definition: {
		description: "Runtime fixture", systemPrompt: "Inspect.", tools: ["@inspect"],
	} });
	const discovered = discoverAgents(cwd, "both");
	const merged = mergeRuntimeAgents(pi, discovered, undefined, { cwd, scope: "both" });
	const selected = merged.agents.find(a => a.name === "runtime-helper");
	assert.ok(selected);
	const launch = buildInProcessChildLaunch({
		cwd, childAgentName: selected.name, childIndex: 0, host: "parent", sessionEnabled: false,
		inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
		tools: selected.tools, mcpDirectTools: selected.mcpDirectTools,
	});
	assert.deepEqual(launch.session.tools, ["read", "grep"]);
	assert.equal(selected.model, "p/override");
	assert.deepEqual(mergeRuntimeAgents(pi, discovered).agents.find(a => a.name === "runtime-helper")?.tools, ["@inspect"]);
});

it("reports unresolved runtime tool aliases in management lists and model queries", () => {
	json(path.join(agentDir, "settings.json"), {});
	registerAgent({ pi, name: "runtime-helper", definition: {
		description: "Runtime fixture", systemPrompt: "Inspect.", aliases: ["runtime-short"], tools: ["@inspect"],
	} });
	const context = { cwd, runtimeAgentOwner: pi, modelRegistry: { getAvailable: () => [] } };
	for (const action of ["list", "models"]) {
		const result = handleManagementAction(action, {}, context);
		const text = result.content.map(part => part.type === "text" ? part.text : "").join("\n");
		assert.match(text, /runtime-helper/);
		assert.match(text, /Tool-group aliases require subagents\.toolSelectionResolver/);
	}
	const result = handleManagementAction("models", { agent: "runtime-short" }, context);
	assert.equal(result.isError, true);
	assert.match(JSON.stringify(result.content), /invalid configuration.*Tool-group aliases require/);
});

it("splits and deduplicates resolved runtime MCP selectors using the native tool selection rules", () => {
	registerAgent({ pi, name: "runtime-helper", definition: {
		description: "Runtime fixture", systemPrompt: "Inspect.", tools: ["read", "@inspect"], mcpDirectTools: ["fixture/other"],
	} });
	const merged = mergeRuntimeAgents(pi, discoverAgents(cwd, "both"), undefined, { cwd, scope: "both" });
	const selected = merged.agents.find(a => a.name === "runtime-helper");
	assert.deepEqual(selected?.tools, ["read"]);
	assert.deepEqual(selected?.mcpDirectTools, ["fixture/lookup", "fixture/other"]);
});

it("refreshes runtime tool groups in the current discovery context without mutating registrations", () => {
	const data = path.join(root, "group.json");
	const requestPath = path.join(root, "request.json");
	json(data, ["read"]);
	fs.writeFileSync(provider, `import fs from "node:fs"; export function resolveTools(request) {
		fs.writeFileSync(${JSON.stringify(requestPath)}, JSON.stringify(request));
		const tools = JSON.parse(fs.readFileSync(${JSON.stringify(data)}, "utf8"));
		return request.selections.map(({selectors}) => ({ok:true, selectors:selectors.flatMap(s => s === "@inspect" ? tools : [s])}));
	}`);
	registerAgent({ pi, name: "runtime-helper", definition: {
		description: "Runtime fixture", systemPrompt: "Inspect.", tools: ["@inspect"],
	} });
	const context = { cwd, scope: "user" as const, projectTrusted: false };
	const discovered = discoverAgents(cwd, context.scope, undefined, { projectTrusted: false });
	const first = mergeRuntimeAgents(pi, discovered, undefined, context);
	json(data, ["grep"]);
	const next = mergeRuntimeAgents(pi, discovered, undefined, context);
	assert.deepEqual(first.agents.find(a => a.name === "runtime-helper")?.tools, ["read"]);
	assert.deepEqual(next.agents.find(a => a.name === "runtime-helper")?.tools, ["grep"]);
	assert.deepEqual(JSON.parse(fs.readFileSync(requestPath, "utf8")), {
		cwd, agentDir, scope: "user", projectTrusted: false,
		selections: [{ agentName: "runtime-helper", selectors: ["@inspect"] }],
	});
	assert.deepEqual(mergeRuntimeAgents(pi, discovered).agents.find(a => a.name === "runtime-helper")?.tools, ["@inspect"]);
});

it("preserves empty and inherited runtime tools even when the provider cannot load", () => {
	settings(path.join(root, "missing.ts"));
	for (const [name, tools] of [["runtime-empty", []], ["runtime-inherited", undefined]] as const) {
		registerAgent({ pi, name, definition: { description: "Runtime fixture", systemPrompt: "Inspect.", tools } });
	}
	const merged = mergeRuntimeAgents(pi, discoverAgents(cwd, "both"), undefined, { cwd, scope: "both" });
	assert.deepEqual(merged.agents.find(a => a.name === "runtime-empty")?.tools, []);
	const inherited = merged.agents.find(a => a.name === "runtime-inherited");
	assert.ok(inherited);
	assert.equal(inherited.tools, undefined);
});

it("adds runtime failure diagnostics without altering incoming discovery and recovers after configuration repair", () => {
	json(path.join(agentDir, "settings.json"), {});
	for (const [name, tools] of [["runtime-helper", ["@inspect"]], ["runtime-concrete", ["read"]]] as const) {
		registerAgent({ pi, name, definition: { description: "Runtime fixture", systemPrompt: "Inspect.", tools, aliases: [`short-${name}`] } });
	}
	const discovered = discoverAgents(cwd, "both");
	const original = structuredClone(discovered);
	const context = { cwd, scope: "both" as const };
	const merged = mergeRuntimeAgents(pi, discovered, undefined, context);
	assert.equal(merged.agents.some(a => a.name === "runtime-helper"), false);
	assert.deepEqual(merged.agents.find(a => a.name === "runtime-concrete")?.tools, ["read"]);
	for (const name of ["runtime-helper", "short-runtime-helper"]) {
		const diagnostic = findBlockingAgentDiagnostic(name, undefined, merged.agentDiagnostics);
		assert.equal(diagnostic?.source, "runtime");
		assert.match(diagnostic?.error ?? "", /Tool-group aliases require/);
	}
	assert.deepEqual(merged.agentDiagnostics?.slice(0, original.agentDiagnostics?.length), original.agentDiagnostics);
	assert.deepEqual(discovered, original);
	settings();
	const recovered = mergeRuntimeAgents(pi, discoverAgents(cwd, "both"), undefined, context);
	assert.deepEqual(recovered.agents.find(a => a.name === "runtime-helper")?.tools, ["read"]);
	assert.equal(findBlockingAgentDiagnostic("runtime-helper", undefined, recovered.agentDiagnostics), undefined);
});

it("keeps native empty and inherited selections even if the host cannot resolve tools", () => {
	settings(path.join(root, "missing.ts"), { fixture: { tools: [] }, inherited: { tools: "inherit" } });
	agent("inherited");
	const result = discoverAgents(cwd, "both");
	assert.deepEqual(result.agents.find(a => a.name === "fixture")?.tools, []);
	assert.equal(result.agents.find(a => a.name === "inherited")?.tools, undefined);
});

it("uses native project overrides and the global provider even with project-only scope", () => {
	agent("fixture", "@ignored", path.join(cwd, ".pi", "agents"));
	json(path.join(cwd, ".pi", "settings.json"), { subagents: { toolSelectionResolver: path.join(root, "evil.ts"), agentOverrides: { fixture: { tools: ["@inspect"], model: "p/project" } } } });
	const selected = discoverAgents(cwd, "project").agents.find(a => a.name === "fixture");
	assert.equal(selected?.source, "project");
	assert.equal(selected?.model, "p/project");
	assert.deepEqual(selected?.tools, ["read"]);
	assert.deepEqual(selected?.mcpDirectTools, ["fixture/lookup"]);
});
it("resolves each new batch afresh and leaves the raw snapshot cache unchanged", () => {
	const data = path.join(root, "group.json");
	json(data, ["read"]);
	fs.writeFileSync(provider, `import fs from "node:fs"; export function resolveTools({ selections }) { const tools = JSON.parse(fs.readFileSync(${JSON.stringify(data)}, "utf8")); return selections.map(() => ({ok:true,selectors:tools})); }`);
	const first = discoverAgentSnapshot(cwd, "both");
	json(data, ["grep"]);
	const next = discoverAgentSnapshot(cwd, "both");
	assert.deepEqual(first.effective.agents.find(a => a.name === "fixture")?.tools, ["read"]);
	assert.deepEqual(next.effective.agents.find(a => a.name === "fixture")?.tools, ["grep"]);
	assert.deepEqual(next.all.user.find(a => a.name === "fixture")?.tools, ["@inspect"]);
});
for (const [label, source] of [
	["missing export", "export const unrelated = 1"],
	["async", "export async function resolveTools() { return []; }"],
	["cardinality", "export function resolveTools() { return []; }"],
	["malformed", "export function resolveTools({ selections }) { return selections.map(() => ({ok:true,selectors:[42]})); }"],
	["unresolved", "export function resolveTools({ selections }) { return selections.map(() => ({ok:true,selectors:['@unknown']})); }"],
	["host error", "export function resolveTools({ selections }) { return selections.map(() => ({ok:false,error:'Missing host group'})); }"],
] as const) it(`fails closed with actionable canonical and alias diagnostics: ${label}`, () => {
	fs.writeFileSync(provider, source);
	const result = discoverAgents(cwd, "both");
	assert.equal(result.agents.find(a => a.name === "fixture"), undefined);
	assert.ok(findBlockingAgentDiagnostic("fixture", undefined, result.agentDiagnostics)?.error);
	assert.ok(findBlockingAgentDiagnostic("short-fixture", undefined, result.agentDiagnostics)?.error);
	assert.equal(discoverAgentsAll(cwd).user.some(a => a.name === "fixture"), true);
});
it("rejects aliases without a provider and tolerates ordinary concrete tools", () => {
	settings(undefined);
	// Omit the setting rather than the helper's default provider argument.
	json(path.join(agentDir, "settings.json"), {});
	agent("concrete", "read");
	const result = discoverAgents(cwd, "user");
	assert.equal(result.agents.some(a => a.name === "fixture"), false);
	assert.deepEqual(result.agents.find(a => a.name === "concrete")?.tools, ["read"]);
});
it("keeps provider failures as diagnostics after deletion, so persisted runs can recover", () => {
	assert.ok(discoverAgents(cwd, "both").agents.find(a => a.name === "fixture"));
	fs.unlinkSync(provider);
	const result = discoverAgents(cwd, "both");
	assert.equal(result.agents.some(a => a.name === "fixture"), false);
	assert.ok(findBlockingAgentDiagnostic("short-fixture", undefined, result.agentDiagnostics));
});

it("normalizes native package agents and diagnoses their qualified, local and alias names", () => {
	const packageRoot = path.join(root,"package");
	json(path.join(packageRoot,"package.json"), {name:"fixture-package", version:"1.0.0", "pi-subagents":{agents:["agents"]}});
	fs.mkdirSync(path.join(packageRoot,"agents"));
	fs.writeFileSync(path.join(packageRoot,"agents","reader.md"), "---\nname: reader\npackage: alpha\naliases: short-reader\ndescription: Package fixture\ntools: '@inspect'\n---\nFixture.\n");
	json(path.join(agentDir,"settings.json"), {packages:[packageRoot],subagents:{toolSelectionResolver:provider}});
	const first = discoverAgents(cwd,"both").agents.find(a => a.name === "alpha.reader");
	assert.equal(first?.source,"package");
	assert.deepEqual(first?.tools,["read"]);
	fs.unlinkSync(provider);
	const failed = discoverAgents(cwd,"both");
	for (const name of ["alpha.reader","reader","short-reader"]) assert.ok(findBlockingAgentDiagnostic(name,undefined,failed.agentDiagnostics));
});
it("normalizes an active workflow definition without making inactive agents visible", () => {
	assert.equal(discoverAgents(cwd,"both").agents.some(a => a.name === "workflow-reader"),false);
	agent("workflow-reader");
	assert.deepEqual(discoverAgents(cwd,"both").agents.find(a=>a.name === "workflow-reader")?.tools,["read"]);
	fs.unlinkSync(path.join(agentDir,"agents","workflow-reader.md"));
	assert.equal(discoverAgents(cwd,"both").agents.some(a => a.name === "workflow-reader"),false);
});

it("does not expose mutable empty selections from the raw discovery cache", () => {
	agent("empty", "");
	const selected = discoverAgents(cwd,"both").agents.find(a=>a.name === "empty");
	assert.ok(selected?.tools);
	selected.tools.push("write");
	assert.deepEqual(discoverAgentsAll(cwd).user.find(a=>a.name === "empty")?.tools, []);
});

for (const [label, definition, requested] of [
	["local name", "name: worker\npackage: alpha", "worker"],
	["alias", "name: broken\naliases: fixture", "fixture"],
] as const) it(`does not let a failed ${label} block a healthy canonical public launch`, async () => {
	fs.writeFileSync(provider, `export function resolveTools({selections}) { return selections.map(({selectors}) => selectors.includes("@broken") ? {ok:false,error:"Fixture missing group"} : {ok:true,selectors:selectors.flatMap(s => s === "@inspect" ? ["read"] : [s])}); }`);
	const directory = label === "local name" ? path.join(agentDir, "agents") : path.join(cwd, ".pi", "agents");
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(path.join(directory, "broken.md"), `---\n${definition}\ndescription: Broken fixture\ntools: '@broken'\n---\nFixture.\n`);
	const result = await resolveSubagentLaunchContract({
		agent: requested, cwd, agentScope: "both", projectTrusted: true, artifacts: false,
		model: "fixture/model", availableModels: [{provider:"fixture",id:"model"}],
	});
	assert.equal(result.ok, true, JSON.stringify(result));
});

it("blocks a failed canonical identity instead of falling through to a healthy alias", async () => {
	fs.writeFileSync(provider, `export function resolveTools({selections}) { return selections.map(({selectors}) => selectors.includes("@broken") ? {ok:false,error:"Fixture missing group"} : {ok:true,selectors:["read"]}); }`);
	const directory = path.join(cwd, ".pi", "agents");
	fs.mkdirSync(directory, {recursive:true});
	fs.writeFileSync(path.join(directory, "fixture.md"), "---\nname: fixture\naliases: requested\ndescription: Healthy project alias\ntools: read\n---\nFixture.\n");
	agent("requested", "@broken");
	const result = await resolveSubagentLaunchContract({agent:"requested", cwd, agentScope:"both", projectTrusted:true, artifacts:false});
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.message, /Fixture missing group/);
});

for (const [label, source] of [
	["sparse batch", "export function resolveTools({selections}) { return new Array(selections.length); }"],
	["sparse selectors", "export function resolveTools({selections}) { return selections.map(() => ({ok:true,selectors:Array(1)})); }"],
	["mutated cardinality", "export function resolveTools(request) { request.selections.length = 0; return []; }"],
	["mutated cardinality before throwing", "export function resolveTools(request) { request.selections.length = 0; throw new Error('Fixture provider failure'); }"],
] as const) it(`rejects malformed provider ${label} through discovery and public preflight`, async () => {
	agent("fixture", "read, write");
	fs.writeFileSync(provider, source);
	const discovery = discoverAgents(cwd, "both");
	assert.equal(discovery.agents.some(a => a.name === "fixture"), false);
	assert.ok(findBlockingAgentDiagnostic("fixture", undefined, discovery.agentDiagnostics));
	const result = await resolveSubagentLaunchContract({
		agent:"fixture", cwd, agentScope:"both", projectTrusted:true, artifacts:false,
		model:"fixture/model", availableModels:[{provider:"fixture",id:"model"}],
	});
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.code, "missing_agent");
});
