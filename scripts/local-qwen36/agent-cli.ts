#!/usr/bin/env -S node --import tsx
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Agent, type AgentEvent, type AgentTool } from "../../packages/agent/src/index.ts";
import { streamSimple } from "../../packages/ai/src/api/openai-completions.ts";
import { type AssistantMessage } from "../../packages/ai/src/index.ts";
import { createApplyDiffTool } from "./apply-diff.ts";
import { createLspSymbolRegistry, createLspSymbolsTool } from "./lsp-symbols.ts";
import { buildQwen36SystemPromptWithMemory } from "./profile-memory.ts";
import {
	applyQwen36ProfileToPayload,
	createLocalQwen36Model,
	getQwen36Profile,
	resolveLocalQwen36ModelId,
} from "./profiles.ts";
import { createReadFileTool } from "./read-file.ts";
import { createSemanticSearchTool } from "./semantic-search.ts";
import { createWebFetchTool, createWebSearchTool } from "./web-access.ts";

const baseUrl = process.env.QWEN36_BASE_URL ?? "http://127.0.0.1:8080/v1";

export interface AgentCliOptions {
	cwd: string;
	prompt?: string;
	help: boolean;
}

export function parseAgentCliArgs(args: string[]): AgentCliOptions {
	const options: AgentCliOptions = { cwd: process.cwd(), help: false };
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		switch (arg) {
			case "--cwd":
				options.cwd = args[++index] ?? "";
				if (!options.cwd) throw new Error("--cwd requires a value");
				break;
			case "--prompt":
			case "-p":
				options.prompt = args[++index] ?? "";
				if (!options.prompt) throw new Error(`${arg} requires a value`);
				break;
			case "--help":
			case "-h":
				options.help = true;
				break;
			default:
				throw new Error(`unknown argument: ${arg}`);
		}
	}
	return options;
}

export function createLocalQwen36HarnessTools(cwd: string): AgentTool<any, any>[] {
	return [
		createSemanticSearchTool(cwd),
		createLspSymbolsTool(cwd, createLspSymbolRegistry()),
		createReadFileTool(cwd),
		createWebSearchTool(),
		createWebFetchTool(),
		createApplyDiffTool(cwd),
	];
}

function assistantText(message: AssistantMessage | undefined): string {
	if (!message) return "";
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function printUsage(): void {
	console.log(`Usage: npx tsx scripts/local-qwen36/agent-cli.ts [--cwd PATH] [--prompt TEXT]

Starts the local Qwen harness agent with:
  semantic_search, lsp_symbols, read_file, apply_diff, web_search, web_fetch

Environment:
  QWEN36_BASE_URL   OpenAI-compatible local endpoint, default http://127.0.0.1:8080/v1
  QWEN36_MODEL_ID   Optional model id override
`);
}

async function main(): Promise<void> {
	const options = parseAgentCliArgs(process.argv.slice(2));
	if (options.help) {
		printUsage();
		return;
	}

	const cwd = resolve(options.cwd);
	const profile = getQwen36Profile("executor");
	const modelId = await resolveLocalQwen36ModelId(baseUrl);
	const agent = new Agent({
		streamFn: streamSimple,
		getApiKey: () => "local",
		onPayload: (payload) => applyQwen36ProfileToPayload(payload, profile),
		initialState: {
			systemPrompt: buildQwen36SystemPromptWithMemory(
				[
					profile.systemPrompt,
					"You are running in the local Qwen harness terminal.",
					"Use semantic_search, lsp_symbols, and read_file for repository context.",
					"Use web_search and web_fetch when current external information is useful.",
					"Use apply_diff for file edits.",
				].join("\n"),
				"local qwen harness cli",
			),
			model: createLocalQwen36Model(modelId, baseUrl),
			thinkingLevel: profile.thinkingLevel,
			tools: createLocalQwen36HarnessTools(cwd),
		},
		toolExecution: "sequential",
	});

	agent.subscribe((event: AgentEvent) => {
		if (event.type === "tool_execution_start") {
			console.log(`[tool:start] ${event.toolName}`);
		}
		if (event.type === "tool_execution_end") {
			console.log(`[tool:end] ${event.toolName}${event.isError ? " error" : ""}`);
		}
	});

	const runPrompt = async (prompt: string) => {
		await agent.prompt(prompt);
		const finalAssistant = [...agent.state.messages].reverse().find((message) => message.role === "assistant") as
			| AssistantMessage
			| undefined;
		const text = assistantText(finalAssistant);
		if (text) console.log(`\n${text}\n`);
	};

	if (options.prompt) {
		await runPrompt(options.prompt);
		return;
	}

	console.log(`local-qwen36 agent ready. cwd=${cwd}`);
	console.log("Type /exit to quit.");
	const rl = createInterface({ input, output });
	try {
		while (true) {
			const prompt = await rl.question("> ");
			if (prompt.trim() === "/exit") break;
			if (!prompt.trim()) continue;
			await runPrompt(prompt);
		}
	} finally {
		rl.close();
	}
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.stack || error.message : String(error));
		process.exit(1);
	});
}
