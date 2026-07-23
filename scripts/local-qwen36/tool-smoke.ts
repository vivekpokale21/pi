#!/usr/bin/env -S node --import tsx
import { Agent, type AgentEvent, type AgentTool } from "../../packages/agent/src/index.ts";
import { streamSimple } from "../../packages/ai/src/api/openai-completions.ts";
import { Type, type AssistantMessage, type Static } from "../../packages/ai/src/index.ts";
import { createLocalQwen36Model, resolveLocalQwen36ModelId } from "./profiles.ts";

const baseUrl = process.env.QWEN36_BASE_URL ?? "http://127.0.0.1:8080/v1";
const marker = process.env.QWEN36_TOOL_SMOKE_MARKER ?? "PI_QWEN36_TOOL_SMOKE";

const echoMarkerSchema = Type.Object({
	marker: Type.String({ description: "Marker string that must be echoed exactly." }),
});

type EchoMarkerParams = Static<typeof echoMarkerSchema>;

const echoMarkerTool: AgentTool<typeof echoMarkerSchema, { marker: string }> = {
	label: "Echo marker",
	name: "echo_marker",
	description: "Return a fixed marker string to prove that tool calling works.",
	parameters: echoMarkerSchema,
	executionMode: "sequential",
	execute: async (_toolCallId: string, params: EchoMarkerParams) => {
		return {
			content: [{ type: "text", text: `echo_marker_result=${params.marker}` }],
			details: { marker: params.marker },
		};
	},
};

function assistantText(message: AssistantMessage | undefined): string {
	if (!message) return "";
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

async function main() {
	const modelId = await resolveLocalQwen36ModelId(baseUrl);
	const model = createLocalQwen36Model(modelId, baseUrl);

	const payloads: unknown[] = [];
	const toolEvents: AgentEvent[] = [];
	const agent = new Agent({
		streamFn: streamSimple,
		getApiKey: () => "local",
		onPayload: (payload) => {
			payloads.push(payload);
		},
		initialState: {
			systemPrompt: [
				"You are running a local harness smoke test.",
				"Call the echo_marker tool exactly once with the marker requested by the user.",
				"After the tool result is returned, answer with the returned marker and no extra commentary.",
			].join("\n"),
			model,
			thinkingLevel: "low",
			tools: [echoMarkerTool],
		},
		toolExecution: "sequential",
	});

	agent.subscribe((event) => {
		if (
			event.type === "tool_execution_start" ||
			event.type === "tool_execution_end" ||
			event.type === "tool_execution_update"
		) {
			toolEvents.push(event);
		}
	});

	await agent.prompt(`Call echo_marker with marker "${marker}".`);

	const toolCalled = toolEvents.some((event) => event.type === "tool_execution_end" && event.toolName === "echo_marker");
	const finalAssistant = [...agent.state.messages].reverse().find((message) => message.role === "assistant") as
		| AssistantMessage
		| undefined;
	const finalText = assistantText(finalAssistant);
	const sawMarkerInToolResult = agent.state.messages.some(
		(message) =>
			message.role === "toolResult" &&
			message.toolName === "echo_marker" &&
			message.content.some((block) => block.type === "text" && block.text.includes(marker)),
	);

	const summary = {
		baseUrl,
		modelId,
		toolCalled,
		sawMarkerInToolResult,
		finalText,
		messageCount: agent.state.messages.length,
		payloadCount: payloads.length,
		usage: finalAssistant?.usage,
	};

	console.log(JSON.stringify(summary, null, 2));

	if (!toolCalled) {
		throw new Error("echo_marker was not executed");
	}
	if (!sawMarkerInToolResult) {
		throw new Error("echo_marker tool result did not include the marker");
	}
	if (!finalText.includes(marker)) {
		throw new Error("final assistant response did not include the returned marker");
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack || error.message : String(error));
	process.exit(1);
});
