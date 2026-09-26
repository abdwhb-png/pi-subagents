export interface SubagentToolSelection {
	tools?: readonly string[];
	mcpDirectTools?: readonly string[];
	cwd?: string;
	agentName?: string;
}

export interface SubagentToolSelectionTransformer {
	name: string;
	resolve(selection: SubagentToolSelection): readonly string[];
}

const REGISTRY_KEY = Symbol.for("pi-subagents.tool-selection.v2");
interface Registry {
	version: 2;
	entries: Array<{ transformer: SubagentToolSelectionTransformer }>;
}

function registry(): Registry {
	const globalObject = globalThis as Record<symbol, unknown>;
	const existing = globalObject[REGISTRY_KEY];
	if (existing === undefined) {
		const created: Registry = { version: 2, entries: [] };
		globalObject[REGISTRY_KEY] = created;
		return created;
	}
	if (typeof existing !== "object" || existing === null || (existing as Registry).version !== 2 || !Array.isArray((existing as Registry).entries)) {
		throw new Error("Invalid pi-subagents tool-selection registry.");
	}
	return existing as Registry;
}

/** Register a process-local adapter; nested sessions restore the previous registration on disposal. */
export function registerSubagentToolSelectionTransformer(transformer: SubagentToolSelectionTransformer): () => void {
	if (!transformer || typeof transformer.name !== "string" || !transformer.name.trim() || typeof transformer.resolve !== "function") {
		throw new Error("Tool-selection transformer requires a name and resolve function.");
	}
	const state = registry();
	const active = state.entries.at(-1)?.transformer;
	if (active && active.name !== transformer.name) {
		throw new Error(`Tool-selection transformer '${active.name}' is already registered.`);
	}
	const entry = { transformer };
	state.entries.push(entry);
	return () => {
		const index = state.entries.indexOf(entry);
		if (index !== -1) state.entries.splice(index, 1);
	};
}

/** Selectors remain opaque here; pi-subagents parses returned MCP and extension selectors. */
export function resolveSubagentToolSelection(selection: SubagentToolSelection): string[] | undefined {
	if (selection.tools === undefined) return undefined;
	const input = [
		...(selection.tools ?? []),
		...(selection.mcpDirectTools ?? []).map((name) => `mcp:${name}`),
	];
	const current = registry().entries.at(-1)?.transformer;
	const output = current ? current.resolve({ ...selection, tools: input, mcpDirectTools: undefined }) : input;
	if (!Array.isArray(output) || output.some((name) => typeof name !== "string" || !name.trim() || name !== name.trim())) {
		throw new Error("Tool-selection transformer returned invalid tool selectors.");
	}
	return [...output];
}

export function splitToolSelectors(rawTools: readonly string[] | undefined): { tools?: string[]; mcpDirectTools?: string[] } {
	const mcpDirectTools: string[] = [];
	const tools: string[] = [];
	for (const tool of rawTools ?? []) {
		if (tool.startsWith("mcp:")) mcpDirectTools.push(tool.slice(4));
		else tools.push(tool);
	}
	return {
		...(rawTools !== undefined ? { tools } : {}),
		...(mcpDirectTools.length > 0 ? { mcpDirectTools } : {}),
	};
}
