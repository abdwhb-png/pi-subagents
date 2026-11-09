import * as fs from "node:fs";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Record any model invocation by a child that admission should reject. */
export default function (pi: ExtensionAPI) {
	pi.registerProvider("admission-fixture", {
		baseUrl: "http://unused.invalid", apiKey: "fixture", api: "openai-completions",
		models: ["model", "supervisor"].map(id => ({ id, name: id, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 })),
		streamSimple(model, context) {
			if (model.id !== "supervisor") {
				fs.appendFileSync(process.env.PI_TOOL_ADMISSION_AUDIT!, "generation\n");
				throw new Error("Invalid child reached generation");
			}
			const stream = createAssistantMessageEventStream();
			const result = context.messages.find(message => message.role === "toolResult");
			const message: AssistantMessage = {
				role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
				content: result ? [{ type: "text", text: JSON.stringify(result.content) }] : [{ type: "toolCall", id: "nested-admission", name: "subagent", arguments: { agent: "admission-fixture", task: "Never generate", async: false } }],
				stopReason: result ? "stop" : "toolUse",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: message.stopReason, message });
			stream.end();
			return stream;
		},
	});
}
