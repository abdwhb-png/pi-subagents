import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	MODEL_FALLBACK_WORKFLOW_KEY_PREFIX,
	buildModelFallbackWorkflowParams,
	isGeneratedModelFallbackWorkflow,
	isModelFallbackWorkflowAttempt,
} from "../../src/runs/shared/model-fallback-workflow.ts";
import { runWorkflowScript, validateWorkflowScript, type WorkflowScriptChildResult } from "../../src/workflows/scripted-workflow.ts";

function success(key: string, output = "done"): WorkflowScriptChildResult {
	return { key, ok: true, output, artifactPaths: [] };
}

function failure(
	key: string,
	error: string,
	options: { toolCount?: number; messages?: Array<{ errorMessage?: string }>; timedOut?: boolean; interrupted?: boolean } = {},
): WorkflowScriptChildResult {
	return {
		key,
		ok: false,
		output: "",
		error,
		artifactPaths: [],
		...(options.interrupted ? { interrupted: true } : {}),
		results: [{
			index: 0,
			agent: "worker",
			task: "work",
			exitCode: 1,
			error,
			messages: options.messages ?? [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			progressSummary: { toolCount: options.toolCount ?? 0, tokens: 0, durationMs: 1 },
			...(options.timedOut ? { timedOut: true } : {}),
		}] as never,
	};
}

async function executePlan(
	plan: NonNullable<ReturnType<typeof buildModelFallbackWorkflowParams>>,
	results: WorkflowScriptChildResult[],
): Promise<{ launches: Array<{ key: string; params: Record<string, unknown> }>; value?: unknown; error?: Error }> {
	const launches: Array<{ key: string; params: Record<string, unknown> }> = [];
	try {
		const execution = await runWorkflowScript({
			script: plan.workflowScript,
			args: plan.args,
			async launch(key, params) {
				launches.push({ key, params });
				const next = results[launches.length - 1];
				if (!next) throw new Error(`Unexpected fallback launch ${key}`);
				return { ...next, key };
			},
			async status(key) { return success(key); },
		});
		return { launches, value: execution.value };
	} catch (error) {
		return { launches, error: error instanceof Error ? error : new Error(String(error)) };
	}
}

describe("explicit model fallback workflow", () => {
	it("preserves outer async semantics and creates ordered independent launch attempts", async () => {
		const source = { agent: "worker", task: "work", model: "provider/primary", async: true, output: false };
		const plan = buildModelFallbackWorkflowParams(source, [
			"provider/primary",
			" provider/backup ",
			"provider/backup",
			"provider/last",
		], source.model);
		assert.ok(plan);
		assert.deepEqual(source, { agent: "worker", task: "work", model: "provider/primary", async: true, output: false });
		assert.equal(plan.params.async, true);
		assert.equal(plan.params.agent, undefined);
		assert.equal(plan.params.task, undefined);
		assert.equal(plan.params.model, "provider/primary");
		assert.deepEqual(plan.args.fallbackModels, ["provider/backup", "provider/last"]);
		assert.equal(isGeneratedModelFallbackWorkflow(plan.params), true);
		assert.equal(isGeneratedModelFallbackWorkflow({ workflowScript: "return null;" }), false);
		assert.deepEqual(validateWorkflowScript(plan.workflowScript), { ok: true, errors: [] });

		const run = await executePlan(plan, [
			failure("ignored", "Provider temporarily unavailable"),
			success("ignored", "backup succeeded"),
		]);
		assert.deepEqual(run.launches, [
			{
				key: `${MODEL_FALLBACK_WORKFLOW_KEY_PREFIX}primary`,
				params: { agent: "worker", task: "work", async: false },
			},
			{
				key: `${MODEL_FALLBACK_WORKFLOW_KEY_PREFIX}1`,
				params: { agent: "worker", task: "work", async: false, model: "provider/backup" },
			},
		]);
		assert.equal(run.value, "backup succeeded");
	});

	it("does not retry task, tool, timeout, or interrupted failures", async () => {
		const cases = [
			failure("ignored", "bash failed (exit 1): network error"),
			failure("ignored", "Provider unavailable", { toolCount: 1 }),
			failure("ignored", "Provider timeout", { timedOut: true }),
			failure("ignored", "Provider unavailable", { interrupted: true }),
		];
		for (const first of cases) {
			const plan = buildModelFallbackWorkflowParams({ agent: "worker", task: "work", async: false }, ["provider/backup"]);
			assert.ok(plan);
			const run = await executePlan(plan, [first]);
			assert.equal(run.launches.length, 1, first.error);
			assert.match(run.error?.message ?? "", new RegExp((first.error ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		}
	});

	it("retries only a provider error surfaced before useful child activity", async () => {
		const plan = buildModelFallbackWorkflowParams({ agent: "worker", task: "work", async: false }, ["provider/backup", "provider/last"]);
		assert.ok(plan);

		const mismatch = await executePlan(plan, [
			failure("ignored", "Provider unavailable", { messages: [{ errorMessage: "different failure" }] }),
		]);
		assert.equal(mismatch.launches.length, 1);
		assert.match(mismatch.error?.message ?? "", /Provider unavailable/);

		const exhausted = await executePlan(plan, [
			failure("ignored", "429 rate limit", { messages: [{ errorMessage: "429 rate limit" }] }),
			failure("ignored", "Unknown model provider/backup"),
			failure("ignored", "Authentication failed"),
		]);
		assert.deepEqual(exhausted.launches.map((launch) => launch.params.model), [undefined, "provider/backup", "provider/last"]);
		assert.match(exhausted.error?.message ?? "", /Authentication failed/);
	});

	it("does not wrap empty policies or recursively wrap generated attempts", () => {
		assert.equal(buildModelFallbackWorkflowParams({ agent: "worker", task: "work" }, []), undefined);
		assert.equal(buildModelFallbackWorkflowParams({ action: "status", id: "run" }, ["provider/backup"]), undefined);
		assert.equal(isModelFallbackWorkflowAttempt({ workflowKey: `${MODEL_FALLBACK_WORKFLOW_KEY_PREFIX}1` }), true);
		assert.equal(isModelFallbackWorkflowAttempt({ workflowKey: "ordinary-child" }), false);
	});
});
