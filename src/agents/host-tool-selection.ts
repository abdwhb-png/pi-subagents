import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { Static } from "typebox";
import type { AgentScope } from "./agents.ts";

export interface ToolSelectionRequest {
	cwd: string;
	agentDir: string;
	scope: AgentScope;
	projectTrusted: boolean;
	selections: Array<{ agentName: string; selectors: string[] }>;
}
export type ToolSelectionResult = { ok: true; selectors: string[] } | { ok: false; error: string };
export type ToolSelectionResolver = (request: ToolSelectionRequest) => ToolSelectionResult[];

const require = createRequire(import.meta.url);

// Status/recovery readers import discovery too. Keep host-only dependencies off their cold path.
function createCodecs() {
	const { Type }: typeof import("typebox") = require("typebox");
	const { Check }: typeof import("typebox/value") = require("typebox/value");
	const settings = Type.Object({ subagents: Type.Optional(Type.Object({ toolSelectionResolver: Type.Optional(Type.String({ pattern: "\\S" })) })) });
	const provider = Type.Object({ resolveTools: Type.Function([Type.Unknown()], Type.Unknown()) });
	const result = Type.Union([
		Type.Object({ ok: Type.Literal(true), selectors: Type.Array(Type.String({ pattern: "^(?!@)\\S(?:.*\\S)?$" })) }),
		Type.Object({ ok: Type.Literal(false), error: Type.String({ pattern: "\\S" }) }),
	]);
	return { Check, settings, provider, result };
}
let codecs: ReturnType<typeof createCodecs> | undefined;
let loader: ReturnType<typeof import("jiti").createJiti> | undefined;
const providers = new Map<string, Static<ReturnType<typeof createCodecs>["provider"]>["resolveTools"]>();

function loadProvider(agentDir: string, codec: ReturnType<typeof createCodecs>) {
	const settingsPath = path.join(agentDir, "settings.json");
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw new Error(`Cannot read tool-selection settings: ${settingsPath}`);
	}
	if (!codec.Check(codec.settings, raw)) throw new Error("Invalid global subagents.toolSelectionResolver settings");
	const configured = raw.subagents?.toolSelectionResolver;
	if (configured === undefined) return undefined;
	const expanded = configured.startsWith("~/") ? path.join(os.homedir(), configured.slice(2)) : configured;
	const canonical = fs.realpathSync(path.resolve(agentDir, expanded));
	const cached = providers.get(canonical);
	if (cached) return cached;
	const { createJiti }: typeof import("jiti") = require("jiti");
	loader ??= createJiti(import.meta.url, { fsCache: false, moduleCache: false, tryNative: false, nativeModules: ["@earendil-works/pi-coding-agent"] });
	const loaded: unknown = loader(canonical);
	if (!codec.Check(codec.provider, loaded)) throw new Error(`Tool-selection provider must export resolveTools: ${canonical}`);
	const provider = loaded.resolveTools;
	providers.set(canonical, provider);
	return provider;
}

/** Resolve a fresh batch. Only the global settings may choose executable host code. */
export function resolveHostToolSelections(request: ToolSelectionRequest): ToolSelectionResult[] {
	const selectionCount = request.selections.length;
	if (!selectionCount) return [];
	try {
		const codec = codecs ??= createCodecs();
		const provider = loadProvider(request.agentDir, codec);
		if (!provider) return request.selections.map(({ selectors }) => selectors.some(s => s.startsWith("@"))
			? { ok: false, error: "Tool-group aliases require subagents.toolSelectionResolver in global settings" }
			: { ok: true, selectors: [...selectors] });
		const results = provider(request);
		if (results instanceof Promise) {
			// Report the contract violation synchronously and consume a rejected async producer.
			void results.catch(() => undefined);
			throw new Error("resolveTools must be synchronous");
		}
		if (!Array.isArray(results) || results.length !== selectionCount) throw new Error("resolveTools must return a synchronous result for each selection, in order");
		return Array.from(results, (result): ToolSelectionResult => {
			const malformed: ToolSelectionResult = {ok:false, error:"resolveTools returned malformed selectors or an unresolved tool-group alias"};
			if (!codec.Check(codec.result, result)) return malformed;
			if (!result.ok) return result;
			// TypeBox accepts sparse array slots. Materialize them before checking selector elements.
			const selectors = Array.from(result.selectors);
			return codec.Check(codec.result, {ok:true, selectors}) ? {ok:true, selectors:[...new Set(selectors)]} : malformed;
		});
	} catch (error) {
		return Array.from({length:selectionCount}, () => ({ ok: false, error: `Tool selection failed: ${error instanceof Error ? error.message : String(error)}` }));
	}
}
