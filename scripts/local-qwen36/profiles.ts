import type { Model, ModelThinkingLevel } from "../../packages/ai/src/index.ts";

export type Qwen36ProfileMode = "planner" | "executor";

export interface Qwen36RuntimeProfile {
	mode: Qwen36ProfileMode;
	temperature: number;
	topP: number;
	topK: number;
	minP: number;
	presencePenalty: number;
	repeatPenalty: number;
	repeatLastN: number;
	enableThinking: boolean;
	preserveThinking: boolean;
	thinkingLevel: ModelThinkingLevel;
	systemPrompt: string;
}

export const QWEN36_PROFILES: Record<Qwen36ProfileMode, Qwen36RuntimeProfile> = {
	planner: {
		mode: "planner",
		temperature: 0.55,
		topP: 0.95,
		topK: 20,
		minP: 0.05,
		presencePenalty: 0.25,
		repeatPenalty: 1.03,
		repeatLastN: 128,
		enableThinking: true,
		preserveThinking: true,
		thinkingLevel: "low",
		systemPrompt: [
			"You are the planner profile for a local single-instance coding harness.",
			"Scope the task using only read-only tools. Do not modify files or state.",
			"Produce a concrete plan for the executor profile.",
		].join("\n"),
	},
	executor: {
		mode: "executor",
		temperature: 0.2,
		topP: 0.9,
		topK: 20,
		minP: 0.02,
		presencePenalty: 0,
		repeatPenalty: 1.02,
		repeatLastN: 128,
		enableThinking: false,
		preserveThinking: true,
		thinkingLevel: "off",
		systemPrompt: [
			"You are the executor profile for a local single-instance coding harness.",
			"Use the available tools to perform the requested change precisely.",
			"Keep responses concise and report concrete results.",
		].join("\n"),
	},
};

export function getQwen36Profile(mode: Qwen36ProfileMode): Qwen36RuntimeProfile {
	return QWEN36_PROFILES[mode];
}

export function applyQwen36ProfileToPayload(payload: unknown, profile: Qwen36RuntimeProfile): unknown {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;

	const params = payload as Record<string, unknown>;
	params.temperature = profile.temperature;
	params.top_p = profile.topP;
	params.top_k = profile.topK;
	params.min_p = profile.minP;
	params.presence_penalty = profile.presencePenalty;
	params.repeat_penalty = profile.repeatPenalty;
	params.repeat_last_n = profile.repeatLastN;

	const chatTemplateKwargs =
		typeof params.chat_template_kwargs === "object" &&
		params.chat_template_kwargs !== null &&
		!Array.isArray(params.chat_template_kwargs)
			? { ...(params.chat_template_kwargs as Record<string, unknown>) }
			: {};
	chatTemplateKwargs.enable_thinking = profile.enableThinking;
	chatTemplateKwargs.preserve_thinking = profile.preserveThinking;
	params.chat_template_kwargs = chatTemplateKwargs;

	return params;
}

export async function resolveLocalQwen36ModelId(baseUrl: string): Promise<string> {
	if (process.env.QWEN36_MODEL_ID) return process.env.QWEN36_MODEL_ID;

	const response = await fetch(`${baseUrl}/models`);
	if (!response.ok) {
		throw new Error(`failed to fetch ${baseUrl}/models: HTTP ${response.status}`);
	}
	const payload = (await response.json()) as { data?: Array<{ id?: string }> };
	const id = payload.data?.find((item) => typeof item.id === "string" && item.id.length > 0)?.id;
	if (!id) throw new Error(`no model id returned by ${baseUrl}/models`);
	return id;
}

export function createLocalQwen36Model(modelId: string, baseUrl: string): Model<"openai-completions"> {
	return {
		id: modelId,
		name: "Qwen3.6-35B-A3B ByteShape GPU-5",
		api: "openai-completions",
		provider: "local-llama-cpp",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: Number(process.env.QWEN36_CTX ?? "131072"),
		maxTokens: Number(process.env.QWEN36_SMOKE_MAX_TOKENS ?? "512"),
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsStore: false,
			supportsUsageInStreaming: true,
			maxTokensField: "max_tokens",
			requiresToolResultName: false,
			thinkingFormat: "qwen-chat-template",
			supportsStrictMode: false,
		},
	};
}
