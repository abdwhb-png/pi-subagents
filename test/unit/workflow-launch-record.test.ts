import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { runLaunchDir } from "../../src/runs/shared/run-launch-folder.ts";
import { readWorkflowLaunchRecord, writeWorkflowLaunchRecord } from "../../src/workflows/workflow-launch-record.ts";
import { writeFileCreatingDir } from "../support/helpers.ts";

describe("workflow launch record", () => {
	it("reports a missing or invalid record", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-launch-record-invalid-"));
		try {
			const runs = path.join(root, "async-subagent-runs");
			assert.deepEqual(readWorkflowLaunchRecord(runs, "run"), { ok: false, missing: true, error: "launch.json is missing" });
			const write = (value: string) => writeFileCreatingDir(path.join(runLaunchDir(runs, "run"), "launch.json"), value);
			const cases: Array<[string, RegExp]> = [
				["{not json", /^not valid JSON: /],
				["[]", /^not a JSON object$/],
				[JSON.stringify({ version: 1, sessionId: "s", source: "script", params: {}, scriptDigest: "d" }), /^version must be 2$/],
				[JSON.stringify({ version: 2, sessionId: "s", source: "script", params: {} }), /^scriptDigest must be a non-empty string$/],
				[JSON.stringify({ version: 2, source: "script", params: {}, scriptDigest: "d" }), /^sessionId must be a non-empty string$/],
				[JSON.stringify({ version: 2, sessionId: "s", source: "script", params: {}, scriptDigest: "d", admissionCapabilityCeiling: { version: 9 } }), /admissionCapabilityCeiling/],
				[JSON.stringify({ version: 2, sessionId: "s", source: "other", scriptDigest: "d" }), /^source must be "script", "resource", "structured", or "internal"$/],
				[JSON.stringify({ version: 2, sessionId: "s", source: "script", params: [], scriptDigest: "d" }), /^params must be an object$/],
			];
			for (const [text, error] of cases) {
				write(text);
				const read = readWorkflowLaunchRecord(runs, "run");
				assert.equal(read.ok, false, text);
				assert.equal(!read.ok && read.missing, false, text);
				assert.match(!read.ok ? read.error : "", error, text);
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("retained workflow provider authority", () => {
	it("round-trips empty and populated catalogues without adding authority to legacy records", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-catalogue-record-"));
		try {
			const runs = path.join(root, "runs"), file = path.join(runLaunchDir(runs, "run"), "launch.json");
			const base = { version: 2 as const, sessionId: "session", source: "script" as const, scriptDigest: "digest", params: {} };
			for (const requiredExtensions of [[], [{ id: "provider", path: path.join(root, "provider.mjs"), whenTools: ["read"] }]]) {
				writeWorkflowLaunchRecord(runs, "run", { ...base, requiredExtensions });
				if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
				const read = readWorkflowLaunchRecord(runs, "run");
				assert.ok(read.ok);
				assert.deepEqual(read.record.requiredExtensions, requiredExtensions);
				assert.ok(Object.isFrozen(read.record.requiredExtensions));
			}
			writeFileCreatingDir(file, JSON.stringify(base));
			const legacy = readWorkflowLaunchRecord(runs, "run");
			assert.ok(legacy.ok);
			assert.equal(Object.hasOwn(legacy.record, "requiredExtensions"), false);
			for (const requiredExtensions of [null, "invalid", [{ id: "provider", path: "relative.mjs" }], [{ id: "provider", path: path.join(root, "provider.mjs"), whenTools: ["@inspect"] }]]) {
				writeFileCreatingDir(file, JSON.stringify({ ...base, requiredExtensions }));
				const invalid = readWorkflowLaunchRecord(runs, "run");
				assert.equal(invalid.ok, false);
				assert.ok(!invalid.ok && !invalid.missing);
			}
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});
});
