export const MODEL_FALLBACK_WORKFLOW_KEY_PREFIX = "model-fallback-";
const MODEL_FALLBACK_WORKFLOW_MARKER = "// pi-subagents:model-fallback-workflow-v1";

interface ModelFallbackWorkflowArgs extends Record<string, unknown> {
	launch: {
		agent: string;
		task: string;
	};
	fallbackModels: string[];
}

export interface ModelFallbackWorkflowPlan {
	params: Record<string, unknown>;
	workflowScript: string;
	args: ModelFallbackWorkflowArgs;
}

interface ModelFallbackParamsInput {
	action?: unknown;
	agent?: unknown;
	args?: unknown;
	async?: unknown;
	chain?: unknown;
	id?: unknown;
	model?: unknown;
	output?: unknown;
	resume?: unknown;
	task?: unknown;
	tasks?: unknown;
	workflow?: unknown;
	workflowKey?: unknown;
	workflowScript?: unknown;
	workflowScriptPath?: unknown;
}

const MODEL_FALLBACK_CLASSIFIER_SOURCE = `function shouldRetryModelFallback(result) {
	if (!result || result.ok || result.detached || result.interrupted || result.stopped) return false;
	if (!Array.isArray(result.results) || result.results.length !== 1) return false;
	const child = result.results[0];
	if (!child || child.timedOut || child.interrupted || child.toolBudgetBlocked || child.turnBudgetExceeded || child.structuredOutputFailed) return false;
	if (child.progressSummary && Number(child.progressSummary.toolCount || 0) > 0) return false;
	if (typeof child.output === "string" && child.output.trim()) return false;

	const error = typeof child.error === "string" && child.error.trim()
		? child.error.trim()
		: typeof result.error === "string"
			? result.error.trim()
			: "";
	if (!error) return false;
	if (/^[A-Za-z0-9_.:@/-]+ failed(?:\\s|\\()/i.test(error)) return false;

	if (Array.isArray(child.messages) && child.messages.length > 0) {
		for (let index = 0; index < child.messages.length; index += 1) {
			const message = child.messages[index];
			if (!message || typeof message.errorMessage !== "string" || message.errorMessage.trim() !== error) return false;
		}
	}

	return /(?:provider|model|service).*(?:temporar(?:y|ily)|unavailable|overload|not found|unknown|disabled|unsupported|failed to load)|(?:temporar(?:y|ily)|unavailable|overload).*(?:provider|model|service)|unknown model|model not found|no such model|invalid model|authentication failed|unauthorized|forbidden|invalid api key|api key.*(?:invalid|missing)|rate limit|too many requests|\\b429\\b|quota|billing|usage limit|resource exhausted|network error|connection (?:error|refused|reset|closed)|socket hang up|fetch failed|gateway timeout|bad gateway|service unavailable|\\b50[0234]\\b|cold start|empty response|no output|model load.*fail/i.test(error);
}`;

function buildModelFallbackWorkflowScript(fallbackCount: number): string {
	const attempts: string[] = [];
	for (let index = 0; index < fallbackCount; index += 1) {
		attempts.push(`if (shouldRetryModelFallback(result)) {
	settled = await runs.all([{
		key: "${MODEL_FALLBACK_WORKFLOW_KEY_PREFIX}${index + 1}",
		agent: args.launch.agent,
		task: args.launch.task,
		async: false,
		model: args.fallbackModels[${index}],
	}]);
	result = settled[0];
}`);
	}
	return `${MODEL_FALLBACK_WORKFLOW_MARKER}
${MODEL_FALLBACK_CLASSIFIER_SOURCE}

let settled = await runs.all([{
	key: "${MODEL_FALLBACK_WORKFLOW_KEY_PREFIX}primary",
	agent: args.launch.agent,
	task: args.launch.task,
	async: false,
}]);
let result = settled[0];

${attempts.join("\n\n")}
if (!result.ok) {
	throw new Error(typeof result.error === "string" && result.error.trim()
		? result.error.trim()
		: "Model fallback attempts failed without an error message.");
}
return result.output;`;
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function hasWorkflowShape(params: Readonly<ModelFallbackParamsInput>): boolean {
	return params.action !== undefined
		|| params.workflow !== undefined
		|| params.workflowScript !== undefined
		|| params.workflowScriptPath !== undefined
		|| params.resume !== undefined
		|| params.tasks !== undefined
		|| params.chain !== undefined;
}

export function isModelFallbackWorkflowAttempt(params: Readonly<ModelFallbackParamsInput>): boolean {
	return typeof params.workflowKey === "string" && params.workflowKey.startsWith(MODEL_FALLBACK_WORKFLOW_KEY_PREFIX);
}

export function isGeneratedModelFallbackWorkflow(params: Readonly<ModelFallbackParamsInput>): boolean {
	return typeof params.workflowScript === "string" && params.workflowScript.startsWith(MODEL_FALLBACK_WORKFLOW_MARKER);
}

export function buildModelFallbackWorkflowParams(
	params: Readonly<ModelFallbackParamsInput>,
	fallbackModels: readonly string[],
	primaryModel?: string,
): ModelFallbackWorkflowPlan | undefined {
	if (hasWorkflowShape(params) || isModelFallbackWorkflowAttempt(params)) return undefined;
	if (!nonEmptyString(params.agent) || !nonEmptyString(params.task)) return undefined;

	const normalizedPrimaryModel = nonEmptyString(primaryModel) ? primaryModel.trim() : undefined;
	const seen = new Set<string>();
	const normalizedFallbackModels: string[] = [];
	for (const value of fallbackModels) {
		if (!nonEmptyString(value)) continue;
		const model = value.trim();
		if (model === normalizedPrimaryModel || seen.has(model)) continue;
		seen.add(model);
		normalizedFallbackModels.push(model);
	}
	if (normalizedFallbackModels.length === 0) return undefined;

	const args: ModelFallbackWorkflowArgs = {
		launch: {
			agent: params.agent.trim(),
			task: params.task,
		},
		fallbackModels: normalizedFallbackModels,
	};
	const {
		agent: _agent,
		task: _task,
		args: _args,
		...workflowDefaults
	} = params as ModelFallbackParamsInput & Record<string, unknown>;
	const workflowScript = buildModelFallbackWorkflowScript(normalizedFallbackModels.length);
	return {
		params: {
			...workflowDefaults,
			workflowScript,
			args,
		},
		workflowScript,
		args,
	};
}
