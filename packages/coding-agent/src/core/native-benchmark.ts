import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, type AssistantMessage, contentText, type Model } from "@earendil-works/pi-ai";
import { getAgentDir } from "../config.ts";
import type { AgentSession, AgentSessionEvent } from "./agent-session.ts";
import {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
import { resolveCliModel } from "./model-resolver.ts";
import { SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";
import { createOpenAICompatibleWorkspaceEmbeddingProvider } from "./workspace-embedding-provider.ts";
import { WorkspaceEmbeddingRuntimeManager } from "./workspace-embedding-runtime-manager.ts";
import type { WorkspaceSemanticIndexOptions } from "./workspace-semantic-index.ts";

export type NativeBenchmarkWebAccessStatus = "enabled" | "disabled" | "unavailable";

export interface NativeBenchmarkShellCommandValidationOptions {
	allowedCommands: string[];
}

export type NativeBenchmarkShellCommandValidationResult =
	| { valid: true }
	| {
			valid: false;
			reason: string;
	  };

export interface NativeBenchmarkCapabilityDeclaration {
	runtimePath: {
		services: "createAgentSessionServices";
		session: "createAgentSessionFromServices";
	};
	modelRuntime: {
		path: "ModelRuntime";
		localProviderAvailable: boolean;
	};
	model?: {
		provider: string;
		id: string;
	};
	semanticSearch: {
		available: boolean;
		status: string;
		vectorStatus?: string;
		vectorProvider?: string;
	};
	embeddingRuntime?: {
		state: string;
		baseUrl?: string;
	};
	webAccess: NativeBenchmarkWebAccessStatus;
	activeNativeTools: string[];
	extensionDiagnostics: AgentSessionRuntimeDiagnostic[];
}

export interface NativeBenchmarkTask {
	id: string;
	title?: string;
	prompt: string;
	expectedAssistantTextIncludes?: string;
	validationCommands?: string[];
	prepareWorkspace?: (workspace: NativeBenchmarkWorkspace) => void;
}

export interface NativeBenchmarkEventTrace {
	type: AgentSessionEvent["type"];
	messageRole?: string;
	toolCallId?: string;
	toolName?: string;
	args?: unknown;
	isError?: boolean;
	resultText?: string;
	state?: string;
}

export interface NativeBenchmarkTaskResult {
	task: {
		id: string;
	};
	workspace?: NativeBenchmarkWorkspace;
	capabilities: NativeBenchmarkCapabilityDeclaration;
	assistantText: string;
	finalAssistantTextLength: number;
	pass: boolean;
	failureReason?: string;
	validation: NativeBenchmarkValidationResult[];
	events: NativeBenchmarkEventTrace[];
	metrics: {
		assistantTurns: number;
		toolCalls: number;
		toolCallsByName: Record<string, number>;
		failedToolCalls: number;
		retrievalSearches: number;
		editAttempts: number;
		failedEdits: number;
	};
}

export interface NativeBenchmarkTaskCorpus {
	id: string;
	tasks: NativeBenchmarkTask[];
}

export interface NativeBenchmarkCorpusResult {
	corpus: {
		id: string;
	};
	pass: boolean;
	results: NativeBenchmarkTaskResult[];
	metrics: {
		tasks: number;
		passedTasks: number;
		failedTasks: number;
		assistantTurns: number;
		toolCalls: number;
		failedToolCalls: number;
		retrievalSearches: number;
		editAttempts: number;
		failedEdits: number;
	};
}

export type NativeBenchmarkCliPlan =
	| { type: "help"; text: string }
	| {
			type: "run";
			cwd: string;
			agentDir: string;
			outputDir: string;
			provider?: string;
			model?: string;
			semanticEmbedding?: NativeBenchmarkSemanticEmbeddingOptions;
			keepRuntimeProcesses: boolean;
			taskIds: string[];
			workspace?: NativeBenchmarkWorkspaceOptions;
			validation: {
				enabled: boolean;
				allowedCommands: string[];
			};
	  };

export interface NativeBenchmarkCorpusArtifacts {
	summaryJsonPath: string;
	summaryMarkdownPath: string;
	taskArtifacts: Array<{
		taskId: string;
		jsonlPath: string;
		markdownPath: string;
	}>;
}

export interface NativeBenchmarkCliOptions {
	cwd?: string;
	agentDir?: string;
	runCorpus?: (options: NativeBenchmarkCorpusOptions) => Promise<NativeBenchmarkCorpusResult>;
	stdout?: (message: string) => void;
	stderr?: (message: string) => void;
}

export interface NativeBenchmarkWorkspaceOptions {
	sourcePath: string;
	copyParent?: string;
}

export interface NativeBenchmarkWorkspace {
	sourcePath: string;
	path: string;
}

export interface NativeBenchmarkSemanticEmbeddingOptions {
	baseUrl: string;
	model: string;
	startCommand?: string;
	apiKey?: string;
	batchSize?: number;
}

export interface NativeBenchmarkValidationOptions extends NativeBenchmarkShellCommandValidationOptions {
	timeoutMs?: number;
	maxOutputBytes?: number;
}

export interface NativeBenchmarkValidationResult {
	command: string;
	exitCode: number | null;
	output: string;
	durationMs: number;
	passed: boolean;
	error?: string;
}

export type NativeBenchmarkJsonlTraceEntry =
	| {
			type: "capabilities";
			taskId: string;
			capabilities: NativeBenchmarkCapabilityDeclaration;
	  }
	| {
			type: "event";
			taskId: string;
			event: NativeBenchmarkEventTrace;
	  }
	| {
			type: "result";
			taskId: string;
			assistantText: string;
			finalAssistantTextLength: number;
			pass: boolean;
			failureReason?: string;
			validation: NativeBenchmarkValidationResult[];
			metrics: NativeBenchmarkTaskResult["metrics"];
	  };

export interface NativeBenchmarkCapabilityOptions extends CreateAgentSessionServicesOptions {
	sessionManager?: SessionManager;
	model?: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	scopedModels?: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;
	tools?: string[];
	excludeTools?: string[];
	noTools?: "all" | "builtin";
}

export interface NativeBenchmarkTaskOptions extends NativeBenchmarkCapabilityOptions {
	task: NativeBenchmarkTask;
	workspace?: NativeBenchmarkWorkspaceOptions;
	validation?: NativeBenchmarkValidationOptions;
}

export interface NativeBenchmarkCorpusOptions extends NativeBenchmarkCapabilityOptions {
	corpus: NativeBenchmarkTaskCorpus;
	workspace?: NativeBenchmarkWorkspaceOptions;
	validation?: NativeBenchmarkValidationOptions;
}

const NATIVE_DUBAI_BOOM_BENCHMARK_TASKS: NativeBenchmarkTask[] = [
	{
		id: "context-survey",
		title: "Planner context retrieval for API contracts",
		prompt:
			"Find where Dubai Boom Monitor implements the /api/day and /api/availability contracts, including ETag behavior. Name the files and functions that matter, and say whether the implementation appears aligned with CODEX.md.",
		expectedAssistantTextIncludes: "app/api.py",
	},
	{
		id: "api-contract-test",
		title: "Executor deterministic diff for API contract regression",
		prompt:
			"Add a focused unittest file tests/test_api_day_contract_benchmark.py proving GET /api/day?date=2026-07-24 returns an ETag and returns 304 with the same If-None-Match value. The relevant API implementation is in app/api.py; use exact file paths with extensions when reading. Mock app.api.cache.consume_rate_limit as allowed and app.api.db.get_day_hours to [0, 13]. Verify with exactly: python3 -m unittest tests.test_api_day_contract_benchmark -v. Keep the production code unchanged.",
		validationCommands: ["python3 -m unittest tests.test_api_day_contract_benchmark -v"],
	},
	{
		id: "self-correction-repair",
		title: "Build-tool self-correction repair loop",
		prompt:
			"Fix the failing benchmark in the copied Dubai Boom Monitor workspace. The intended scoring contract is confidence * source_count capped at 1.0. The regression test is tests/test_benchmark_repair.py; verify with exactly: python3 -m unittest tests.test_benchmark_repair -v.",
		validationCommands: ["python3 -m unittest tests.test_benchmark_repair -v"],
		prepareWorkspace: seedDubaiBoomRepairBenchmarkFixture,
	},
];

const DUBAI_BOOM_REPAIR_BENCHMARK_TEST = `"""Benchmark regression for GeoJSON scoring repair."""

from __future__ import annotations

import unittest
from datetime import datetime, timezone

from app.geojson import event_to_feature


class GeoJsonScoringBenchmarkTest(unittest.TestCase):
    def test_weight_is_capped_at_one(self) -> None:
        feature = event_to_feature(
            {
                "lat": 25.2048,
                "lng": 55.2708,
                "location_name": "Downtown Dubai",
                "confidence": 0.8,
                "source_count": 3,
                "created_utc": datetime(2026, 7, 24, tzinfo=timezone.utc),
            }
        )

        self.assertEqual(feature["properties"]["weight"], 1.0)

    def test_weight_preserves_uncorroborated_confidence(self) -> None:
        feature = event_to_feature(
            {
                "lat": 25.2048,
                "lng": 55.2708,
                "location_name": "Downtown Dubai",
                "confidence": 0.3,
                "source_count": 1,
                "created_utc": datetime(2026, 7, 24, tzinfo=timezone.utc),
            }
        )

        self.assertEqual(feature["properties"]["weight"], 0.3)


if __name__ == "__main__":
    unittest.main()
`;

const BENCHMARK_WORKSPACE_COPY_EXCLUDED_DIRECTORIES = new Set([
	".git",
	".venv",
	".semantic_search",
	".pytest_cache",
	"__pycache__",
]);

function seedDubaiBoomRepairBenchmarkFixture(workspace: NativeBenchmarkWorkspace): void {
	const testsDir = join(workspace.path, "tests");
	mkdirSync(testsDir, { recursive: true });
	writeFileSync(join(testsDir, "test_benchmark_repair.py"), DUBAI_BOOM_REPAIR_BENCHMARK_TEST);
}

function shouldCopyNativeBenchmarkWorkspaceEntry(source: string): boolean {
	return !BENCHMARK_WORKSPACE_COPY_EXCLUDED_DIRECTORIES.has(basename(source));
}

export function getNativeDubaiBoomBenchmarkTasks(): NativeBenchmarkTask[] {
	return NATIVE_DUBAI_BOOM_BENCHMARK_TASKS.map((task) => ({
		...task,
		validationCommands: task.validationCommands ? [...task.validationCommands] : undefined,
	}));
}

function nativeBenchmarkCliHelp(): string {
	return `Native benchmark runner

Usage:
  pi-native-benchmark [options]

Options:
  --task <ids>                    Comma-separated task ids. Defaults to all Dubai Boom tasks.
  --source-workspace <path>       Source workspace to copy for each task.
  --workspace-copy-parent <path>  Directory for copied benchmark workspaces.
  --out <path>                    Output directory for reports. Defaults to native-benchmark-results.
  --provider <name>               Provider name to record for model selection.
  --model <id>                    Model id or provider/model reference.
  --semantic-embedding-base-url <url>
                                  OpenAI-compatible embeddings base URL for native semantic_search.
  --semantic-embedding-model <id> Embedding model id for native semantic_search.
  --semantic-embedding-start-command <command>
                                  Optional command Pi starts before embedding calls.
  --semantic-embedding-api-key <key>
                                  Optional embeddings API key.
  --semantic-embedding-batch-size <n>
                                  Optional document embedding batch size.
  --keep-runtime-processes        Leave native model runtime processes running after benchmark services dispose.
  --allow-validation <command>    Allow one validation command. May be repeated.
  --disable-validation            Do not execute task validation commands.
  --help                          Show this help.
`;
}

function readFlagValue(args: string[], index: number, flag: string): { value: string; nextIndex: number } {
	const value = args[index + 1];
	if (value === undefined || value.startsWith("--")) {
		throw new Error(`${flag} requires a value`);
	}
	return { value, nextIndex: index + 1 };
}

function splitTaskIds(value: string): string[] {
	return value
		.split(",")
		.map((taskId) => taskId.trim())
		.filter((taskId) => taskId.length > 0);
}

export function createNativeBenchmarkCliPlan(
	args: readonly string[],
	options: { cwd: string; agentDir: string },
): NativeBenchmarkCliPlan {
	let outputDir = resolve(options.cwd, "native-benchmark-results");
	let sourceWorkspace: string | undefined;
	let workspaceCopyParent: string | undefined;
	let provider: string | undefined;
	let model: string | undefined;
	let semanticEmbeddingBaseUrl: string | undefined;
	let semanticEmbeddingModel: string | undefined;
	let semanticEmbeddingStartCommand: string | undefined;
	let semanticEmbeddingApiKey: string | undefined;
	let semanticEmbeddingBatchSize: number | undefined;
	let keepRuntimeProcesses = false;
	let taskIds: string[] | undefined;
	const allowedCommands: string[] = [];
	let validationEnabled = true;

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--help" || arg === "-h") {
			return { type: "help", text: nativeBenchmarkCliHelp() };
		}
		if (arg === "--task" || arg === "--tasks") {
			const parsed = readFlagValue([...args], index, arg);
			taskIds = splitTaskIds(parsed.value);
			index = parsed.nextIndex;
			continue;
		}
		if (arg === "--source-workspace") {
			const parsed = readFlagValue([...args], index, arg);
			sourceWorkspace = resolve(options.cwd, parsed.value);
			index = parsed.nextIndex;
			continue;
		}
		if (arg === "--workspace-copy-parent") {
			const parsed = readFlagValue([...args], index, arg);
			workspaceCopyParent = resolve(options.cwd, parsed.value);
			index = parsed.nextIndex;
			continue;
		}
		if (arg === "--out") {
			const parsed = readFlagValue([...args], index, arg);
			outputDir = resolve(options.cwd, parsed.value);
			index = parsed.nextIndex;
			continue;
		}
		if (arg === "--provider") {
			const parsed = readFlagValue([...args], index, arg);
			provider = parsed.value;
			index = parsed.nextIndex;
			continue;
		}
		if (arg === "--model") {
			const parsed = readFlagValue([...args], index, arg);
			model = parsed.value;
			index = parsed.nextIndex;
			continue;
		}
		if (arg === "--semantic-embedding-base-url") {
			const parsed = readFlagValue([...args], index, arg);
			semanticEmbeddingBaseUrl = parsed.value;
			index = parsed.nextIndex;
			continue;
		}
		if (arg === "--semantic-embedding-model") {
			const parsed = readFlagValue([...args], index, arg);
			semanticEmbeddingModel = parsed.value;
			index = parsed.nextIndex;
			continue;
		}
		if (arg === "--semantic-embedding-start-command") {
			const parsed = readFlagValue([...args], index, arg);
			semanticEmbeddingStartCommand = parsed.value;
			index = parsed.nextIndex;
			continue;
		}
		if (arg === "--semantic-embedding-api-key") {
			const parsed = readFlagValue([...args], index, arg);
			semanticEmbeddingApiKey = parsed.value;
			index = parsed.nextIndex;
			continue;
		}
		if (arg === "--semantic-embedding-batch-size") {
			const parsed = readFlagValue([...args], index, arg);
			const parsedBatchSize = Number(parsed.value);
			if (!Number.isInteger(parsedBatchSize) || parsedBatchSize <= 0) {
				throw new Error("--semantic-embedding-batch-size must be a positive integer");
			}
			semanticEmbeddingBatchSize = parsedBatchSize;
			index = parsed.nextIndex;
			continue;
		}
		if (arg === "--keep-runtime-processes") {
			keepRuntimeProcesses = true;
			continue;
		}
		if (arg === "--allow-validation") {
			const parsed = readFlagValue([...args], index, arg);
			allowedCommands.push(parsed.value);
			index = parsed.nextIndex;
			continue;
		}
		if (arg === "--disable-validation") {
			validationEnabled = false;
			continue;
		}
		throw new Error(`Unknown native benchmark option: ${arg}`);
	}

	if ((semanticEmbeddingBaseUrl && !semanticEmbeddingModel) || (!semanticEmbeddingBaseUrl && semanticEmbeddingModel)) {
		throw new Error("--semantic-embedding-base-url and --semantic-embedding-model must be provided together");
	}

	return {
		type: "run",
		cwd: options.cwd,
		agentDir: options.agentDir,
		outputDir,
		provider,
		model,
		keepRuntimeProcesses,
		semanticEmbedding:
			semanticEmbeddingBaseUrl && semanticEmbeddingModel
				? {
						baseUrl: semanticEmbeddingBaseUrl,
						model: semanticEmbeddingModel,
						startCommand: semanticEmbeddingStartCommand,
						apiKey: semanticEmbeddingApiKey,
						batchSize: semanticEmbeddingBatchSize,
					}
				: undefined,
		taskIds: taskIds ?? getNativeDubaiBoomBenchmarkTasks().map((task) => task.id),
		workspace: sourceWorkspace
			? {
					sourcePath: sourceWorkspace,
					copyParent: workspaceCopyParent,
				}
			: undefined,
		validation: {
			enabled: validationEnabled,
			allowedCommands,
		},
	};
}

function semanticIndexOptionsFromBenchmarkPlan(
	semanticEmbedding: NativeBenchmarkSemanticEmbeddingOptions | undefined,
): WorkspaceSemanticIndexOptions | undefined {
	if (!semanticEmbedding) return undefined;
	const embeddingRuntime = semanticEmbedding.startCommand
		? new WorkspaceEmbeddingRuntimeManager({
				baseUrl: semanticEmbedding.baseUrl,
				startCommand: semanticEmbedding.startCommand,
			})
		: undefined;
	return {
		embedding: createOpenAICompatibleWorkspaceEmbeddingProvider({
			baseUrl: semanticEmbedding.baseUrl,
			model: semanticEmbedding.model,
			apiKey: semanticEmbedding.apiKey,
			resolveBaseUrl: embeddingRuntime
				? async (signal) => (await embeddingRuntime.ensureReady(signal)).baseUrl
				: undefined,
		}),
		...(embeddingRuntime ? { embeddingRuntime } : {}),
		...(semanticEmbedding.batchSize ? { embeddingBatchSize: semanticEmbedding.batchSize } : {}),
	};
}

function selectNativeBenchmarkTasks(taskIds: readonly string[]): NativeBenchmarkTask[] {
	const tasksById = new Map(getNativeDubaiBoomBenchmarkTasks().map((task) => [task.id, task]));
	const tasks: NativeBenchmarkTask[] = [];
	for (const taskId of taskIds) {
		const task = tasksById.get(taskId);
		if (!task) {
			throw new Error(`Unknown native benchmark task: ${taskId}`);
		}
		tasks.push(task);
	}
	return tasks;
}

export function nativeBenchmarkCorpusSummaryMarkdown(result: NativeBenchmarkCorpusResult): string {
	const tasks = result.results
		.map((taskResult) => {
			const status = taskResult.pass ? "pass" : "fail";
			const suffix = taskResult.failureReason ? ` (${taskResult.failureReason})` : "";
			return `- ${status}: ${taskResult.task.id}${suffix}`;
		})
		.join("\n");

	return `# Native Benchmark Corpus Summary

Corpus: ${result.corpus.id}
Pass: ${result.pass ? "yes" : "no"}

Metrics:
- Tasks: ${result.metrics.tasks}
- Passed tasks: ${result.metrics.passedTasks}
- Failed tasks: ${result.metrics.failedTasks}
- Assistant turns: ${result.metrics.assistantTurns}
- Tool calls: ${result.metrics.toolCalls}
- Failed tool calls: ${result.metrics.failedToolCalls}
- Retrieval searches: ${result.metrics.retrievalSearches}
- Edit attempts: ${result.metrics.editAttempts}
- Failed edits: ${result.metrics.failedEdits}

Tasks:
${tasks || "- none"}
`;
}

export function writeNativeBenchmarkCorpusArtifacts(
	outputDir: string,
	result: NativeBenchmarkCorpusResult,
): NativeBenchmarkCorpusArtifacts {
	mkdirSync(outputDir, { recursive: true });
	const taskArtifacts = result.results.map((taskResult) => {
		const jsonlPath = join(outputDir, "tasks", `${taskResult.task.id}.jsonl`);
		const markdownPath = join(outputDir, "tasks", `${taskResult.task.id}.md`);
		writeNativeBenchmarkJsonlTrace(jsonlPath, taskResult);
		writeNativeBenchmarkMarkdownReport(markdownPath, taskResult);
		return {
			taskId: taskResult.task.id,
			jsonlPath,
			markdownPath,
		};
	});
	const summaryJsonPath = join(outputDir, "corpus-summary.json");
	const summaryMarkdownPath = join(outputDir, "corpus-summary.md");
	writeFileSync(
		summaryJsonPath,
		`${JSON.stringify(
			{
				corpus: result.corpus,
				pass: result.pass,
				metrics: result.metrics,
				tasks: result.results.map((taskResult) => ({
					id: taskResult.task.id,
					pass: taskResult.pass,
					failureReason: taskResult.failureReason,
				})),
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(summaryMarkdownPath, nativeBenchmarkCorpusSummaryMarkdown(result));
	return {
		summaryJsonPath,
		summaryMarkdownPath,
		taskArtifacts,
	};
}

export async function runNativeBenchmarkCli(
	args: readonly string[],
	options: NativeBenchmarkCliOptions = {},
): Promise<number> {
	const cwd = resolve(options.cwd ?? process.cwd());
	const agentDir = resolve(options.agentDir ?? getAgentDir());
	const stdout = options.stdout ?? ((message: string) => console.log(message));
	const stderr = options.stderr ?? ((message: string) => console.error(message));
	let plan: NativeBenchmarkCliPlan;
	try {
		plan = createNativeBenchmarkCliPlan(args, { cwd, agentDir });
		if (plan.type === "help") {
			stdout(plan.text);
			return 0;
		}

		let tasks = selectNativeBenchmarkTasks(plan.taskIds);
		if (!plan.validation.enabled) {
			tasks = tasks.map((task) => ({
				...task,
				validationCommands: undefined,
			}));
		}

		let model: Model<Api> | undefined;
		let thinkingLevel: ThinkingLevel | undefined;
		if (plan.provider && !plan.model) {
			throw new Error("--provider requires --model");
		}
		if (plan.model) {
			const services = await createAgentSessionServices({
				cwd: plan.cwd,
				agentDir: plan.agentDir,
				settingsManager: SettingsManager.create(plan.cwd, plan.agentDir),
			});
			try {
				const resolved = resolveCliModel({
					cliProvider: plan.provider,
					cliModel: plan.model,
					modelRuntime: services.modelRuntime,
				});
				if (resolved.error) {
					throw new Error(resolved.error);
				}
				if (!resolved.model) {
					throw new Error(`Model not found: ${plan.provider ? `${plan.provider}/` : ""}${plan.model}`);
				}
				if (resolved.warning) {
					stderr(`Warning: ${resolved.warning}`);
				}
				model = resolved.model;
				thinkingLevel = resolved.thinkingLevel;
			} finally {
				await services.dispose?.();
			}
		}

		const runCorpus = options.runCorpus ?? runNativeBenchmarkCorpus;
		const result = await runCorpus({
			cwd: plan.cwd,
			agentDir: plan.agentDir,
			settingsManager: SettingsManager.create(plan.cwd, plan.agentDir),
			model,
			thinkingLevel,
			disposeModelRuntime: !plan.keepRuntimeProcesses,
			semanticIndexOptions: semanticIndexOptionsFromBenchmarkPlan(plan.semanticEmbedding),
			corpus: {
				id: "dubai-boom",
				tasks,
			},
			workspace: plan.workspace,
			validation: plan.validation.enabled ? { allowedCommands: plan.validation.allowedCommands } : undefined,
		});
		const artifacts = writeNativeBenchmarkCorpusArtifacts(plan.outputDir, result);
		stdout(`Native benchmark ${result.pass ? "passed" : "failed"}: ${artifacts.summaryMarkdownPath}`);
		return result.pass ? 0 : 1;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		stderr(`Error: ${message}`);
		return 1;
	}
}

function collectExtensionDiagnostics(
	servicesDiagnostics: readonly AgentSessionRuntimeDiagnostic[],
	extensionErrors: readonly { path: string; error: string }[],
): AgentSessionRuntimeDiagnostic[] {
	return [
		...servicesDiagnostics,
		...extensionErrors.map((error) => ({
			type: "error" as const,
			message: `Extension "${error.path}" error: ${error.error}`,
		})),
	];
}

function webAccessStatus(
	activeToolNames: readonly string[],
	diagnostics: readonly AgentSessionRuntimeDiagnostic[],
): NativeBenchmarkWebAccessStatus {
	if (activeToolNames.includes("web_search") || activeToolNames.includes("fetch_content")) {
		return "enabled";
	}
	return diagnostics.some(
		(diagnostic) =>
			diagnostic.message.includes("pi-web-access") && diagnostic.message.includes("unavailable or disabled"),
	)
		? "disabled"
		: "unavailable";
}

function declareCapabilitiesFromSession(options: {
	services: AgentSessionServices;
	session: AgentSession;
	extensionErrors: readonly { path: string; error: string }[];
}): NativeBenchmarkCapabilityDeclaration {
	const activeToolNames = options.session.getActiveToolNames();
	const diagnostics = collectExtensionDiagnostics(options.services.diagnostics, options.extensionErrors);
	const model = options.session.model;
	const embeddingRuntimeState = options.services.embeddingRuntime?.getState();

	return {
		runtimePath: {
			services: "createAgentSessionServices",
			session: "createAgentSessionFromServices",
		},
		modelRuntime: {
			path: "ModelRuntime",
			localProviderAvailable: options.services.modelRuntime.getProvider("local") !== undefined,
		},
		model: model ? { provider: model.provider, id: model.id } : undefined,
		semanticSearch: {
			available: activeToolNames.includes("semantic_search"),
			status: options.services.semanticIndex.status,
			vectorStatus: options.services.semanticIndex.vectorStatus,
			vectorProvider: options.services.semanticIndex.vectorProviderId,
		},
		embeddingRuntime: embeddingRuntimeState
			? {
					state: embeddingRuntimeState.value,
					baseUrl: embeddingRuntimeState.baseUrl,
				}
			: undefined,
		webAccess: webAccessStatus(activeToolNames, diagnostics),
		activeNativeTools: activeToolNames,
		extensionDiagnostics: diagnostics,
	};
}

function truncateTraceText(text: string, maxLength = 2000): string {
	return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}

function traceValue(value: unknown): unknown {
	if (value === undefined) return undefined;
	if (typeof value === "string") return truncateTraceText(value);
	try {
		return JSON.parse(truncateTraceText(JSON.stringify(value)));
	} catch {
		return truncateTraceText(String(value));
	}
}

function traceResultText(result: unknown): string | undefined {
	if (typeof result !== "object" || result === null) {
		return result === undefined ? undefined : truncateTraceText(String(result));
	}
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) {
		return truncateTraceText(JSON.stringify(traceValue(result)));
	}
	const text = content
		.map((block) => {
			if (typeof block !== "object" || block === null) return "";
			const record = block as { type?: unknown; text?: unknown };
			return record.type === "text" && typeof record.text === "string" ? record.text : "";
		})
		.filter((line) => line.length > 0)
		.join("\n");
	return text.length > 0 ? truncateTraceText(text) : undefined;
}

function traceEvent(event: AgentSessionEvent): NativeBenchmarkEventTrace {
	switch (event.type) {
		case "message_end":
			return { type: event.type, messageRole: event.message.role };
		case "tool_execution_start":
			return {
				type: event.type,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: traceValue(event.args),
			};
		case "tool_execution_update":
			return {
				type: event.type,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: traceValue(event.args),
			};
		case "tool_execution_end":
			return {
				type: event.type,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				isError: event.isError,
				resultText: traceResultText(event.result),
			};
		case "local_model_runtime_state":
			return { type: event.type, state: event.state.value };
		default:
			return { type: event.type };
	}
}

function assistantMessages(session: AgentSession): AssistantMessage[] {
	return session.messages.filter((message): message is AssistantMessage => message.role === "assistant");
}

function countToolCallsByName(events: readonly NativeBenchmarkEventTrace[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const event of events) {
		if (event.type !== "tool_execution_start" || !event.toolName) continue;
		counts[event.toolName] = (counts[event.toolName] ?? 0) + 1;
	}
	return counts;
}

function evaluateNativeBenchmarkTask(
	task: NativeBenchmarkTask,
	assistantText: string,
	validationResults: readonly NativeBenchmarkValidationResult[],
): Pick<NativeBenchmarkTaskResult, "pass" | "failureReason"> {
	if (task.expectedAssistantTextIncludes === undefined) {
		const failedValidation = validationResults.find((result) => !result.passed);
		return failedValidation
			? {
					pass: false,
					failureReason: failedValidation.error ?? `Validation command failed: ${failedValidation.command}`,
				}
			: { pass: true };
	}
	if (!assistantText.includes(task.expectedAssistantTextIncludes)) {
		return {
			pass: false,
			failureReason: `Assistant text did not include expected text: ${task.expectedAssistantTextIncludes}`,
		};
	}
	const failedValidation = validationResults.find((result) => !result.passed);
	return failedValidation
		? {
				pass: false,
				failureReason: failedValidation.error ?? `Validation command failed: ${failedValidation.command}`,
			}
		: { pass: true };
}

function prepareNativeBenchmarkWorkspace(
	task: NativeBenchmarkTask,
	options: NativeBenchmarkWorkspaceOptions | undefined,
): NativeBenchmarkWorkspace | undefined {
	if (!options) return undefined;
	const sourcePath = resolve(options.sourcePath);
	const copyParent = resolve(options.copyParent ?? join(tmpdir(), "pi-native-benchmark-workspaces"));
	mkdirSync(copyParent, { recursive: true });
	const parent = mkdtempSync(join(copyParent, `${task.id}-`));
	const workspacePath = join(parent, basename(sourcePath));
	cpSync(sourcePath, workspacePath, { recursive: true, filter: shouldCopyNativeBenchmarkWorkspaceEntry });
	for (const entry of [".git", ".venv", ".semantic_search", ".pytest_cache", "__pycache__"]) {
		rmSync(join(workspacePath, entry), { recursive: true, force: true });
	}
	const workspace = {
		sourcePath,
		path: workspacePath,
	};
	task.prepareWorkspace?.(workspace);
	return workspace;
}

async function runNativeBenchmarkValidationCommand(
	command: string,
	cwd: string,
	options: NativeBenchmarkValidationOptions,
): Promise<NativeBenchmarkValidationResult> {
	const validation = validateNativeBenchmarkShellCommand(command, options);
	if (!validation.valid) {
		return {
			command,
			exitCode: null,
			output: "",
			durationMs: 0,
			passed: false,
			error: validation.reason,
		};
	}

	const started = Date.now();
	const maxOutputBytes = options.maxOutputBytes ?? 12_000;
	const timeoutMs = options.timeoutMs ?? 120_000;
	return await new Promise((resolvePromise) => {
		const child = spawn("bash", ["-lc", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		let timedOut = false;
		const appendOutput = (chunk: Buffer) => {
			output = `${output}${chunk.toString()}`.slice(-maxOutputBytes);
		};
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, timeoutMs);
		child.stdout.on("data", appendOutput);
		child.stderr.on("data", appendOutput);
		child.on("close", (code) => {
			clearTimeout(timer);
			const durationMs = Date.now() - started;
			if (timedOut) {
				resolvePromise({
					command,
					exitCode: code,
					output,
					durationMs,
					passed: false,
					error: `Validation command timed out: ${command}`,
				});
				return;
			}
			resolvePromise({
				command,
				exitCode: code,
				output,
				durationMs,
				passed: code === 0,
				error: code === 0 ? undefined : `Validation command failed: ${command}`,
			});
		});
	});
}

async function runNativeBenchmarkValidation(
	task: NativeBenchmarkTask,
	cwd: string,
	options: NativeBenchmarkValidationOptions | undefined,
): Promise<NativeBenchmarkValidationResult[]> {
	if (!task.validationCommands || task.validationCommands.length === 0) return [];
	const validationOptions = options ?? { allowedCommands: [] };
	const results: NativeBenchmarkValidationResult[] = [];
	for (const command of task.validationCommands) {
		results.push(await runNativeBenchmarkValidationCommand(command, cwd, validationOptions));
	}
	return results;
}

export async function declareNativeBenchmarkCapabilities(
	options: NativeBenchmarkCapabilityOptions,
): Promise<NativeBenchmarkCapabilityDeclaration> {
	const services = await createAgentSessionServices(options);
	let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;

	try {
		const result = await createAgentSessionFromServices({
			services,
			sessionManager: options.sessionManager ?? SessionManager.inMemory(services.cwd),
			model: options.model,
			thinkingLevel: options.thinkingLevel,
			scopedModels: options.scopedModels,
			tools: options.tools,
			excludeTools: options.excludeTools,
			noTools: options.noTools,
		});
		session = result.session;
		await session.bindExtensions({ mode: "print" });

		return declareCapabilitiesFromSession({
			services,
			session,
			extensionErrors: result.extensionsResult.errors,
		});
	} finally {
		session?.dispose();
		await services.dispose?.();
	}
}

export async function runNativeBenchmarkTask(options: NativeBenchmarkTaskOptions): Promise<NativeBenchmarkTaskResult> {
	const workspace = prepareNativeBenchmarkWorkspace(options.task, options.workspace);
	const services = await createAgentSessionServices({
		...options,
		cwd: workspace?.path ?? options.cwd,
	});
	let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;

	try {
		const result = await createAgentSessionFromServices({
			services,
			sessionManager: options.sessionManager ?? SessionManager.inMemory(services.cwd),
			model: options.model,
			thinkingLevel: options.thinkingLevel,
			scopedModels: options.scopedModels,
			tools: options.tools,
			excludeTools: options.excludeTools,
			noTools: options.noTools,
		});
		session = result.session;
		await session.bindExtensions({ mode: "print" });

		const events: NativeBenchmarkEventTrace[] = [];
		const unsubscribe = session.subscribe((event) => {
			events.push(traceEvent(event));
		});
		try {
			await session.prompt(options.task.prompt, { source: "rpc" });
		} finally {
			unsubscribe();
		}

		const assistant = assistantMessages(session).at(-1);
		const assistantText = assistant ? contentText(assistant.content, "") : "";
		const validation = await runNativeBenchmarkValidation(options.task, services.cwd, options.validation);
		const evaluation = evaluateNativeBenchmarkTask(options.task, assistantText, validation);
		const toolEndEvents = events.filter((event) => event.type === "tool_execution_end");
		const toolCallsByName = countToolCallsByName(events);
		const editEndEvents = toolEndEvents.filter((event) => event.toolName === "edit");

		return {
			task: {
				id: options.task.id,
			},
			workspace,
			capabilities: declareCapabilitiesFromSession({
				services,
				session,
				extensionErrors: result.extensionsResult.errors,
			}),
			assistantText,
			finalAssistantTextLength: assistantText.length,
			pass: evaluation.pass,
			failureReason: evaluation.failureReason,
			validation,
			events,
			metrics: {
				assistantTurns: assistantMessages(session).length,
				toolCalls: events.filter((event) => event.type === "tool_execution_start").length,
				toolCallsByName,
				failedToolCalls: toolEndEvents.filter((event) => event.isError).length,
				retrievalSearches: toolCallsByName.semantic_search ?? 0,
				editAttempts: toolCallsByName.edit ?? 0,
				failedEdits: editEndEvents.filter((event) => event.isError).length,
			},
		};
	} finally {
		session?.dispose();
		await services.dispose?.();
	}
}

export async function runNativeBenchmarkCorpus(
	options: NativeBenchmarkCorpusOptions,
): Promise<NativeBenchmarkCorpusResult> {
	const results: NativeBenchmarkTaskResult[] = [];
	for (const task of options.corpus.tasks) {
		results.push(
			await runNativeBenchmarkTask({
				...options,
				task,
			}),
		);
	}

	const passedTasks = results.filter((result) => result.pass).length;
	return {
		corpus: {
			id: options.corpus.id,
		},
		pass: passedTasks === results.length,
		results,
		metrics: {
			tasks: results.length,
			passedTasks,
			failedTasks: results.length - passedTasks,
			assistantTurns: results.reduce((sum, result) => sum + result.metrics.assistantTurns, 0),
			toolCalls: results.reduce((sum, result) => sum + result.metrics.toolCalls, 0),
			failedToolCalls: results.reduce((sum, result) => sum + result.metrics.failedToolCalls, 0),
			retrievalSearches: results.reduce((sum, result) => sum + result.metrics.retrievalSearches, 0),
			editAttempts: results.reduce((sum, result) => sum + result.metrics.editAttempts, 0),
			failedEdits: results.reduce((sum, result) => sum + result.metrics.failedEdits, 0),
		},
	};
}

export function nativeBenchmarkJsonlTraceEntries(result: NativeBenchmarkTaskResult): NativeBenchmarkJsonlTraceEntry[] {
	return [
		{
			type: "capabilities",
			taskId: result.task.id,
			capabilities: result.capabilities,
		},
		...result.events.map(
			(event): NativeBenchmarkJsonlTraceEntry => ({ type: "event", taskId: result.task.id, event }),
		),
		{
			type: "result",
			taskId: result.task.id,
			assistantText: result.assistantText,
			finalAssistantTextLength: result.finalAssistantTextLength,
			pass: result.pass,
			failureReason: result.failureReason,
			validation: result.validation,
			metrics: result.metrics,
		},
	];
}

export function writeNativeBenchmarkJsonlTrace(path: string, result: NativeBenchmarkTaskResult): void {
	mkdirSync(dirname(path), { recursive: true });
	const content = nativeBenchmarkJsonlTraceEntries(result)
		.map((entry) => JSON.stringify(entry))
		.join("\n");
	writeFileSync(path, `${content}\n`);
}

export function nativeBenchmarkMarkdownReport(result: NativeBenchmarkTaskResult): string {
	const capabilities = result.capabilities;
	const model = capabilities.model ? `${capabilities.model.provider}/${capabilities.model.id}` : "<none>";
	const semanticSearch = `${capabilities.semanticSearch.available ? "available" : "unavailable"} (${capabilities.semanticSearch.status})`;
	const semanticVectors =
		capabilities.semanticSearch.vectorStatus === undefined
			? undefined
			: `${capabilities.semanticSearch.vectorStatus}${
					capabilities.semanticSearch.vectorProvider ? ` (${capabilities.semanticSearch.vectorProvider})` : ""
				}`;
	const activeTools = capabilities.activeNativeTools.length > 0 ? capabilities.activeNativeTools.join(", ") : "<none>";
	const diagnostics =
		capabilities.extensionDiagnostics.length > 0
			? capabilities.extensionDiagnostics
					.map((diagnostic) => `- ${diagnostic.type}: ${diagnostic.message}`)
					.join("\n")
			: "- none";
	const validation =
		result.validation.length > 0
			? result.validation
					.map((validationResult) => {
						const status = validationResult.passed ? "pass" : "fail";
						const suffix = validationResult.error ? ` (${validationResult.error})` : "";
						return `- ${status}: ${validationResult.command} [exit=${validationResult.exitCode ?? "not-run"}]${suffix}`;
					})
					.join("\n")
			: "- none";

	return `# Native Benchmark Report

Task: ${result.task.id}

Runtime: ${capabilities.runtimePath.services} -> ${capabilities.runtimePath.session}
Model runtime: ${capabilities.modelRuntime.path}
Model: ${model}
Semantic search: ${semanticSearch}
${semanticVectors ? `Semantic vectors: ${semanticVectors}\n` : ""}Web access: ${capabilities.webAccess}
Active tools: ${activeTools}

Metrics:
- Pass: ${result.pass ? "yes" : "no"}
- Assistant turns: ${result.metrics.assistantTurns}
- Tool calls: ${result.metrics.toolCalls}
- Failed tool calls: ${result.metrics.failedToolCalls}
- Retrieval searches: ${result.metrics.retrievalSearches}
- Edit attempts: ${result.metrics.editAttempts}
- Failed edits: ${result.metrics.failedEdits}
- Final assistant text length: ${result.finalAssistantTextLength}

Validation:
${validation}

Extension diagnostics:
${diagnostics}
`;
}

export function writeNativeBenchmarkMarkdownReport(path: string, result: NativeBenchmarkTaskResult): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, nativeBenchmarkMarkdownReport(result));
}

export function validateNativeBenchmarkShellCommand(
	command: string,
	options: NativeBenchmarkShellCommandValidationOptions,
): NativeBenchmarkShellCommandValidationResult {
	return options.allowedCommands.includes(command)
		? { valid: true }
		: { valid: false, reason: `Benchmark validation command is not allowed: ${command}` };
}
