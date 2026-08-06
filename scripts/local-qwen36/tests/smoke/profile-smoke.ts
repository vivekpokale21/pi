#!/usr/bin/env -S node --import tsx
import { Agent, type AgentEvent, type AgentTool } from "../../../../packages/agent/src/index.ts";
import { streamSimple } from "../../../../packages/ai/src/api/openai-completions.ts";
import { Type, type AssistantMessage, type Static } from "../../../../packages/ai/src/index.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplyDiffTool } from "../../apply-diff.ts";
import { buildQwen36SystemPromptWithMemory } from "../../profile-memory.ts";
import {
	applyQwen36ProfileToPayload,
	createLocalQwen36Model,
	getQwen36Profile,
	type Qwen36ProfileMode,
	resolveLocalQwen36ModelId,
} from "../../profiles.ts";
import { isPlannerToolAllowed } from "../../read-only.ts";

const baseUrl = process.env.QWEN36_BASE_URL ?? "http://127.0.0.1:8080/v1";
const plannerMarker = process.env.QWEN36_PLANNER_MARKER ?? "PI_QWEN36_PLANNER_MARKER";
const executorMarker = process.env.QWEN36_EXECUTOR_MARKER ?? "PI_QWEN36_EXECUTOR_MARKER";

const markerSchema = Type.Object({
	marker: Type.String({ description: "Marker string that must be passed exactly." }),
});

type MarkerParams = Static<typeof markerSchema>;

interface SmokeToolDetails {
	marker: string;
	kind: "read" | "write";
}

function createReadMarkerTool(events: string[]): AgentTool<typeof markerSchema, SmokeToolDetails> {
	return {
		label: "Read marker",
		name: "read_marker",
		description: "Read and return a marker without mutating state.",
		parameters: markerSchema,
		executionMode: "sequential",
		execute: async (_toolCallId: string, params: MarkerParams) => {
			events.push(`read:${params.marker}`);
			return {
				content: [{ type: "text", text: `read_marker_result=${params.marker}` }],
				details: { marker: params.marker, kind: "read" },
			};
		},
	};
}

function createWriteMarkerTool(events: string[]): AgentTool<typeof markerSchema, SmokeToolDetails> {
	return {
		label: "Write marker",
		name: "write_marker",
		description: "Write a marker to the smoke-test in-memory sink.",
		parameters: markerSchema,
		executionMode: "sequential",
		execute: async (_toolCallId: string, params: MarkerParams) => {
			events.push(`write:${params.marker}`);
			return {
				content: [{ type: "text", text: `write_marker_result=${params.marker}` }],
				details: { marker: params.marker, kind: "write" },
			};
		},
	};
}

function assistantText(message: AssistantMessage | undefined): string {
	if (!message) return "";
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function asRecord(payload: unknown): Record<string, any> {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		throw new Error("expected provider payload object");
	}
	return payload as Record<string, any>;
}

function assertProfilePayload(mode: Qwen36ProfileMode, payload: unknown): void {
	const profile = getQwen36Profile(mode);
	const record = asRecord(payload);
	if (record.temperature !== profile.temperature) {
		throw new Error(`${mode} payload temperature mismatch: ${record.temperature}`);
	}
	if (record.top_p !== profile.topP) {
		throw new Error(`${mode} payload top_p mismatch: ${record.top_p}`);
	}
	if (record.top_k !== profile.topK) {
		throw new Error(`${mode} payload top_k mismatch: ${record.top_k}`);
	}
	if (record.min_p !== profile.minP) {
		throw new Error(`${mode} payload min_p mismatch: ${record.min_p}`);
	}
	if (record.repeat_penalty !== profile.repeatPenalty) {
		throw new Error(`${mode} payload repeat_penalty mismatch: ${record.repeat_penalty}`);
	}
	if (record.repeat_last_n !== profile.repeatLastN) {
		throw new Error(`${mode} payload repeat_last_n mismatch: ${record.repeat_last_n}`);
	}
	if (record.chat_template_kwargs?.enable_thinking !== profile.enableThinking) {
		throw new Error(`${mode} payload enable_thinking mismatch`);
	}
	if (record.chat_template_kwargs?.preserve_thinking !== profile.preserveThinking) {
		throw new Error(`${mode} payload preserve_thinking mismatch`);
	}
}

async function main() {
	const toolEvents: string[] = [];
	const smokeDir = await mkdtemp(join(tmpdir(), "pi-qwen36-profile-"));
	const diffTarget = join(smokeDir, "executor-diff.txt");
	await writeFile(diffTarget, "alpha\nbeta\ngamma\n", "utf8");
	const diffPatch = [
		"--- executor-diff.txt",
		"+++ executor-diff.txt",
		"@@ -1,3 +1,3 @@",
		" alpha",
		"-beta",
		"+PI_QWEN36_DIFF_APPLIED",
		" gamma",
		"",
	].join("\n");
	const readMarkerTool = createReadMarkerTool(toolEvents);
	const writeMarkerTool = createWriteMarkerTool(toolEvents);
	const applyDiffTool = createApplyDiffTool(smokeDir);
	const modelId = await resolveLocalQwen36ModelId(baseUrl);
	const model = createLocalQwen36Model(modelId, baseUrl);

	let currentMode: Qwen36ProfileMode = "planner";
	const payloads: Array<{ mode: Qwen36ProfileMode; payload: unknown }> = [];
	const agentEvents: AgentEvent[] = [];

	const plannerProfile = getQwen36Profile("planner");
	const executorProfile = getQwen36Profile("executor");
	const agent = new Agent({
		streamFn: streamSimple,
		getApiKey: () => "local",
		onPayload: (payload) => {
			const profile = getQwen36Profile(currentMode);
			const nextPayload = applyQwen36ProfileToPayload(payload, profile);
			payloads.push({ mode: currentMode, payload: structuredClone(nextPayload) });
			return nextPayload;
		},
		beforeToolCall: async ({ toolCall }) => {
			if (currentMode === "planner" && !isPlannerToolAllowed(toolCall.name)) {
				return { block: true, reason: `planner profile blocks mutating tool: ${toolCall.name}` };
			}
		},
		initialState: {
			systemPrompt: buildQwen36SystemPromptWithMemory(
				[
					plannerProfile.systemPrompt,
					"For this smoke test, call read_marker exactly once with the user-provided marker.",
					"After the tool result, respond with a short Plan: section and do not call write_marker.",
				].join("\n"),
				"planner profile smoke",
			),
			model,
			thinkingLevel: plannerProfile.thinkingLevel,
			tools: [readMarkerTool],
		},
		toolExecution: "sequential",
	});

	agent.subscribe((event) => {
		if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
			agentEvents.push(event);
		}
	});

	await agent.prompt(`Planner phase: call read_marker with marker "${plannerMarker}".`);

	const plannerPayload = payloads.find((entry) => entry.mode === "planner")?.payload;
	if (!plannerPayload) throw new Error("no planner payload captured");
	assertProfilePayload("planner", plannerPayload);
	if (!toolEvents.includes(`read:${plannerMarker}`)) {
		throw new Error("planner did not execute read_marker");
	}
	if (toolEvents.some((event) => event.startsWith("write:"))) {
		throw new Error("planner executed a write tool");
	}

	currentMode = "executor";
	agent.state.systemPrompt = buildQwen36SystemPromptWithMemory(
		[
			executorProfile.systemPrompt,
			"For this smoke test, first call apply_diff exactly once with the user-provided unified diff.",
			"Then call write_marker exactly once with the user-provided marker.",
			"After both tool results, answer with the returned marker and no extra commentary.",
		].join("\n"),
		"executor profile smoke",
	);
	agent.state.thinkingLevel = executorProfile.thinkingLevel;
	agent.state.tools = [readMarkerTool, writeMarkerTool, applyDiffTool];

	await agent.prompt(
		[
			`Executor phase: apply this unified diff first, then call write_marker with marker "${executorMarker}".`,
			"Pass the patch string exactly as shown:",
			"```diff",
			diffPatch,
			"```",
		].join("\n"),
	);

	const executorPayload = [...payloads].reverse().find((entry) => entry.mode === "executor")?.payload;
	if (!executorPayload) throw new Error("no executor payload captured");
	assertProfilePayload("executor", executorPayload);
	if (!toolEvents.includes(`write:${executorMarker}`)) {
		throw new Error("executor did not execute write_marker");
	}
	const diffContent = await readFile(diffTarget, "utf8").catch(() => "");
	if (!diffContent.includes("PI_QWEN36_DIFF_APPLIED")) {
		throw new Error("executor did not apply diff");
	}

	const finalAssistant = [...agent.state.messages].reverse().find((message) => message.role === "assistant") as
		| AssistantMessage
		| undefined;
	const finalText = assistantText(finalAssistant);
	if (!finalText.includes(executorMarker)) {
		throw new Error("executor final response did not include marker");
	}

	const summary = {
		baseUrl,
		modelId,
		planner: {
			markerRead: toolEvents.includes(`read:${plannerMarker}`),
			payloadTemperature: asRecord(plannerPayload).temperature,
			enableThinking: asRecord(plannerPayload).chat_template_kwargs.enable_thinking,
		},
		executor: {
			markerWritten: toolEvents.includes(`write:${executorMarker}`),
			diffApplied: diffContent.includes("PI_QWEN36_DIFF_APPLIED"),
			payloadTemperature: asRecord(executorPayload).temperature,
			enableThinking: asRecord(executorPayload).chat_template_kwargs.enable_thinking,
			finalText,
		},
		messageCount: agent.state.messages.length,
		payloadCount: payloads.length,
		toolEventCount: agentEvents.length,
	};

	console.log(JSON.stringify(summary, null, 2));
	await rm(smokeDir, { recursive: true, force: true });
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack || error.message : String(error));
	process.exit(1);
});
