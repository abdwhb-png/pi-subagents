import * as fs from "node:fs";
import * as path from "node:path";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_REQUIRED_EXTENSIONS = 32;
const MAX_PATH_BYTES = 4096;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,255}$/;
const MAX_PROVIDER_TOOLS = 256;
const EMPTY_SNAPSHOT: RequiredChildExtensionSnapshot = Object.freeze([]);

export interface RequiredChildExtension {
	/** Safe host-owned identity exposed in launch evidence. */
	id: string;
	/** Existing importable module path. Snapshotted to its canonical absolute path. */
	path: string;
	/** Load this provider only when an effective tool selection includes one of these names. */
	whenTools?: readonly string[];
}

export interface RegisterRequiredChildExtensionsInput {
	sessionId: string;
	extensions: readonly RequiredChildExtension[] | (() => readonly RequiredChildExtension[]);
	/** Reject launches whose runner or machine placement cannot load these extensions, instead of dropping them. */
	requireForAllRunners?: boolean;
}

export interface RequiredChildExtensionRegistration { dispose(): void }
/** Registration stamps `requireForAllRunners` on each entry so every carrier of the snapshot retains it. */
export type RequiredChildExtensionSnapshot = ReadonlyArray<Readonly<RequiredChildExtension & { requireForAllRunners?: true }>>;

/** Validate and freeze a snapshot; each capture canonicalizes files, while retained launches preserve that identity. */
export function snapshotRequiredChildExtensions(value: unknown, label = "Required child extensions", canonicalizeFiles = false): RequiredChildExtensionSnapshot {
	if (!Array.isArray(value) || value.length > MAX_REQUIRED_EXTENSIONS) throw new Error(`${label} must be an array of at most ${MAX_REQUIRED_EXTENSIONS} entries.`);
	const ids = new Set<string>();
	const paths = new Set<string>();
	return Object.freeze(Array.from(value, (entry, index) => {
		// The flag comes from registration, so only serialized snapshots (not registration input) may carry it.
		if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).some((key) => key !== "id" && key !== "path" && key !== "whenTools" && (canonicalizeFiles || key !== "requireForAllRunners"))) throw new Error(`${label} entry ${index} accepts only id, path, whenTools, and the retained runner flag.`);
		const id = "id" in entry ? entry.id : undefined;
		const rawPath = "path" in entry ? entry.path : undefined;
		const requireForAllRunners = "requireForAllRunners" in entry ? entry.requireForAllRunners : undefined;
		if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new Error(`${label} entry ${index} requires a safe id of at most 128 characters.`);
		if (ids.has(id)) throw new Error(`${label} id '${id}' is duplicated.`);
		if (requireForAllRunners !== undefined && requireForAllRunners !== true) throw new Error(`${label} '${id}' requireForAllRunners must be true when present.`);
		if (typeof rawPath !== "string" || !rawPath.trim() || rawPath.includes("\0") || Buffer.byteLength(rawPath, "utf8") > MAX_PATH_BYTES || (!canonicalizeFiles && !path.isAbsolute(rawPath))) throw new Error(`${label} '${id}' requires ${canonicalizeFiles ? "a" : "an absolute"} non-empty path of at most ${MAX_PATH_BYTES} bytes without NUL.`);
		let whenTools: readonly string[] | undefined;
		if ("whenTools" in entry) {
			const names = entry.whenTools;
			// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate external callback and persisted tool names before creating the typed snapshot.
			if (!Array.isArray(names) || names.length === 0 || names.length > MAX_PROVIDER_TOOLS || Array.from(names).some((name) => typeof name !== "string" || !TOOL_NAME_PATTERN.test(name))) throw new Error(`${label} '${id}' whenTools requires 1 to ${MAX_PROVIDER_TOOLS} concrete tool names.`);
			whenTools = Object.freeze([...new Set<string>(names)].sort());
		}
		let extensionPath = rawPath;
		if (canonicalizeFiles) {
			try {
				extensionPath = fs.realpathSync(path.resolve(rawPath));
				if (!fs.statSync(extensionPath).isFile()) throw new Error("not a file");
			} catch (error) {
				throw new Error(`${label} '${id}' is not an importable file: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (paths.has(extensionPath)) throw new Error(`${label} path '${extensionPath}' is duplicated.`);
		ids.add(id);
		paths.add(extensionPath);
		const result: RequiredChildExtension & { requireForAllRunners?: true } = { id, path: extensionPath };
		if (whenTools) result.whenTools = whenTools;
		if (requireForAllRunners) result.requireForAllRunners = true;
		return Object.freeze(result);
	}));
}

interface Registry { version: 1; bySession: Map<string, RequiredChildExtensionSnapshot | (() => RequiredChildExtensionSnapshot)> }

function registry(): Registry {
	const key = Symbol.for("pi-subagents.required-child-extensions.v1");
	const root = globalThis as Record<PropertyKey, unknown>;
	const existing = root[key];
	if (existing === undefined) {
		const created: Registry = { version: 1, bySession: new Map() };
		root[key] = created;
		return created;
	}
	if (!existing || typeof existing !== "object" || !("version" in existing) || existing.version !== 1 || !("bySession" in existing) || !(existing.bySession instanceof Map)) throw new Error("Malformed or unsupported required child extension registry.");
	return { version: 1, bySession: existing.bySession };
}

/** Register a fixed snapshot or a synchronous provider captured at each fresh root launch. */
export function registerRequiredChildExtensions(input: RegisterRequiredChildExtensionsInput): RequiredChildExtensionRegistration {
	if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => key !== "sessionId" && key !== "extensions" && key !== "requireForAllRunners")) throw new Error("Required child extension registration accepts only sessionId, extensions, and requireForAllRunners.");
	if (typeof input.sessionId !== "string" || !input.sessionId || input.sessionId.trim() !== input.sessionId || input.sessionId.length > 256 || input.sessionId.includes("\0")) throw new Error("Required child extension registration requires a non-empty trimmed sessionId of at most 256 characters without NUL.");
	if (input.requireForAllRunners !== undefined && typeof input.requireForAllRunners !== "boolean") throw new Error("Required child extension registration requireForAllRunners must be a boolean.");
	const { sessionId, extensions, requireForAllRunners } = input;
	const capture = () => {
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- The public API accepts either a fixed array or a synchronous callback.
		const canonical = snapshotRequiredChildExtensions(typeof extensions === "function" ? extensions() : extensions, "Required child extensions", true);
		return requireForAllRunners ? Object.freeze(canonical.map((entry) => Object.freeze({ ...entry, requireForAllRunners: true as const }))) : canonical;
	};
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Fixed registrations capture immediately; callbacks capture at launch.
	const registered = typeof extensions === "function" ? capture : capture();
	const store = registry();
	if (store.bySession.has(sessionId)) throw new Error(`Required child extensions are already registered for session '${sessionId}'; dispose them first.`);
	store.bySession.set(sessionId, registered);
	return { dispose() { if (store.bySession.get(sessionId) === registered) store.bySession.delete(sessionId); } };
}

export function resolveRequiredChildExtensions(sessionId: string | undefined): RequiredChildExtensionSnapshot {
	if (!sessionId) return EMPTY_SNAPSHOT;
	const registered = registry().bySession.get(sessionId);
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Process-global registrations retain the array-or-callback public contract.
	return typeof registered === "function" ? registered() : registered ?? EMPTY_SNAPSHOT;
}

/** Reject a non-native runner or machine placement when any given snapshot has a `requireForAllRunners` entry. */
export function assertRequiredChildExtensionsAdmitted(snapshots: ReadonlyArray<RequiredChildExtensionSnapshot | undefined>, launch: { agent: string; runnerType?: string; machine?: string }): void {
	const ids = [...new Set(snapshots.flatMap((snapshot) => snapshot ?? []).filter((entry) => entry.requireForAllRunners).map((entry) => entry.id))];
	if (ids.length === 0) return;
	const route = launch.machine ? `machine '${launch.machine}'` : launch.runnerType !== undefined && launch.runnerType !== "pi" ? `runner.type='${launch.runnerType}'` : undefined;
	if (route) throw new Error(`Agent '${launch.agent}' cannot run on ${route}: the host requires child extensions (${ids.join(", ")}) for every runner, and only local native Pi children load them.`);
}

const RETAINED_FILE = "required-child-extensions.json";

/** An empty admission catalogue is authoritative too; only missing legacy files allow recapture. */
export function writeRetainedRequiredChildExtensions(asyncDir: string, snapshot: RequiredChildExtensionSnapshot): void {
	fs.writeFileSync(path.join(asyncDir, RETAINED_FILE), `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
}

export function readRetainedRequiredChildExtensions(asyncDir: string): RequiredChildExtensionSnapshot | undefined {
	const filePath = path.join(asyncDir, RETAINED_FILE);
	if (!fs.existsSync(filePath)) return undefined;
	return snapshotRequiredChildExtensions(JSON.parse(fs.readFileSync(filePath, "utf-8")), "Retained required child extensions");
}
