import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getModel, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import {
	createNativeBenchmarkCliPlan,
	declareNativeBenchmarkCapabilities,
	getNativeDubaiBoomBenchmarkTasks,
	runNativeBenchmarkCli,
	runNativeBenchmarkCorpus,
	runNativeBenchmarkTask,
	validateNativeBenchmarkShellCommand,
	writeNativeBenchmarkCorpusArtifacts,
	writeNativeBenchmarkJsonlTrace,
	writeNativeBenchmarkMarkdownReport,
} from "../src/core/native-benchmark.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { WorkspaceEmbeddingRuntimeManager } from "../src/core/workspace-embedding-runtime-manager.ts";

describe("native benchmark capability declaration", () => {
	let tempDir: string;
	let agentDir: string;
	const cleanups: Array<() => Promise<void> | void> = [];

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-native-benchmark-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("declares semantic_search active in the default native session", async () => {
		const declaration = await declareNativeBenchmarkCapabilities({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager: SettingsManager.create(tempDir, agentDir),
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});

		expect(declaration.runtimePath).toEqual({
			services: "createAgentSessionServices",
			session: "createAgentSessionFromServices",
		});
		expect(declaration.model).toEqual({
			provider: "anthropic",
			id: "claude-sonnet-4-5",
		});
		expect(declaration.semanticSearch.available).toBe(true);
		expect(declaration.semanticSearch.status).toBe("scanning");
		expect(declaration.activeNativeTools).toContain("semantic_search");
		expect(declaration.webAccess).toBe("unavailable");
	});

	it("declares pi-web-access enabled when web tools register through the package extension path", async () => {
		const packageDir = join(tempDir, "pi-web-access");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "pi-web-access",
				version: "0.21.0",
				type: "module",
				pi: { extensions: ["./index.ts"] },
			}),
		);
		writeFileSync(
			join(packageDir, "index.ts"),
			[
				"import { Type } from 'typebox';",
				"import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';",
				"export default function webAccess(pi: ExtensionAPI) {",
				"  pi.registerTool({",
				"    name: 'web_search',",
				"    label: 'Web search',",
				"    description: 'Search the web through the package extension.',",
				"    promptSnippet: 'Search the web through the package extension.',",
				"    parameters: Type.Object({ query: Type.String() }),",
				"    execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),",
				"  });",
				"  pi.registerTool({",
				"    name: 'fetch_content',",
				"    label: 'Fetch content',",
				"    description: 'Fetch web content through the package extension.',",
				"    promptSnippet: 'Fetch web content through the package extension.',",
				"    parameters: Type.Object({ url: Type.String() }),",
				"    execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),",
				"  });",
				"}",
			].join("\n"),
		);
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		settingsManager.setProjectPackages([packageDir]);

		const declaration = await declareNativeBenchmarkCapabilities({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});

		expect(declaration.webAccess).toBe("enabled");
		expect(declaration.activeNativeTools).toEqual(expect.arrayContaining(["web_search", "fetch_content"]));
		expect(declaration.extensionDiagnostics).toEqual([]);
	});

	it("declares configured pi-web-access disabled when package extension resources are disabled", async () => {
		const packageDir = join(tempDir, "pi-web-access");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "pi-web-access",
				version: "0.21.0",
				type: "module",
				pi: { extensions: ["./index.ts"] },
			}),
		);
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		settingsManager.setProjectPackages([{ source: packageDir, extensions: [] }]);

		const declaration = await declareNativeBenchmarkCapabilities({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});

		expect(declaration.webAccess).toBe("disabled");
		expect(declaration.activeNativeTools).not.toContain("web_search");
		expect(declaration.extensionDiagnostics).toContainEqual({
			type: "info",
			message: "Web access is configured through pi-web-access, but web tools are unavailable or disabled.",
		});
	});

	it("declares web access unavailable when no web package is configured", async () => {
		const declaration = await declareNativeBenchmarkCapabilities({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager: SettingsManager.create(tempDir, agentDir),
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});

		expect(declaration.webAccess).toBe("unavailable");
		expect(declaration.activeNativeTools).not.toContain("web_search");
		expect(declaration.extensionDiagnostics).toEqual([]);
	});

	it("reports the shared native semantic index vector mode in benchmark capabilities", async () => {
		writeFileSync(join(tempDir, "vector.ts"), "export const benchmarkVectorNeedle = true;\n");
		const embeddingRuntime = new WorkspaceEmbeddingRuntimeManager({
			baseUrl: "http://127.0.0.1:8129/v1",
			startCommand: "python -m local_embeddings --port 8129",
			operations: {
				executableExists: async () => true,
				start: () => ({
					onExit: () => () => {},
					kill: () => {},
				}),
				waitUntilReady: async () => {},
			},
		});
		cleanups.push(() => embeddingRuntime.shutdown());

		const declaration = await declareNativeBenchmarkCapabilities({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager: SettingsManager.create(tempDir, agentDir),
			semanticIndexOptions: {
				persist: false,
				embedding: {
					id: "test-vector-provider",
					embed: async (texts) => texts.map(() => [1, 0]),
				},
				embeddingRuntime,
			},
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});

		expect(declaration.semanticSearch).toEqual({
			available: true,
			status: "scanning",
			vectorStatus: "not_started",
			vectorProvider: "test-vector-provider",
		});
		expect(declaration.embeddingRuntime).toEqual({
			state: "unloaded",
			baseUrl: undefined,
		});
	});

	it("runs a deterministic fake-model task through the native headless session path", async () => {
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses([fauxAssistantMessage("native benchmark ok")]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(tempDir, "models.json"),
		});
		cleanups.push(() => modelRuntime.dispose());
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});

		const result = await runNativeBenchmarkTask({
			cwd: tempDir,
			agentDir,
			modelRuntime,
			model,
			settingsManager: SettingsManager.create(tempDir, agentDir),
			task: {
				id: "fake-model",
				prompt: "Return the deterministic benchmark response.",
				expectedAssistantTextIncludes: "benchmark ok",
			},
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});

		expect(result.task).toEqual({ id: "fake-model" });
		expect(result.assistantText).toBe("native benchmark ok");
		expect(result.pass).toBe(true);
		expect(result.failureReason).toBeUndefined();
		expect(result.finalAssistantTextLength).toBe("native benchmark ok".length);
		expect(result.capabilities.runtimePath).toEqual({
			services: "createAgentSessionServices",
			session: "createAgentSessionFromServices",
		});
		expect(result.capabilities.semanticSearch.available).toBe(true);
		expect(result.events.map((event) => event.type)).toEqual(
			expect.arrayContaining(["agent_start", "message_end", "agent_end", "agent_settled"]),
		);
		expect(result.metrics.assistantTurns).toBe(1);
		expect(result.metrics.toolCalls).toBe(0);
	});

	it("counts native semantic_search calls as retrieval metrics", async () => {
		writeFileSync(join(tempDir, "needle.ts"), "export const benchmarkNeedle = true;\n");
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("semantic_search", { query: "benchmarkNeedle" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("retrieval complete"),
		]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(tempDir, "models.json"),
		});
		cleanups.push(() => modelRuntime.dispose());
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});

		const result = await runNativeBenchmarkTask({
			cwd: tempDir,
			agentDir,
			modelRuntime,
			model,
			settingsManager: SettingsManager.create(tempDir, agentDir),
			task: {
				id: "semantic-search",
				prompt: "Find benchmarkNeedle.",
			},
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});

		expect(result.assistantText).toBe("retrieval complete");
		expect(result.events).toContainEqual(
			expect.objectContaining({ type: "tool_execution_end", toolName: "semantic_search", isError: false }),
		);
		expect(result.metrics.toolCalls).toBe(1);
		expect(result.metrics.toolCallsByName).toEqual({ semantic_search: 1 });
		expect(result.metrics.retrievalSearches).toBe(1);
	});

	it("counts native edit attempts and failed edits", async () => {
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("edit", {
					path: "missing.ts",
					edits: [{ oldText: "before", newText: "after" }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("edit failure observed"),
		]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(tempDir, "models.json"),
		});
		cleanups.push(() => modelRuntime.dispose());
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});

		const result = await runNativeBenchmarkTask({
			cwd: tempDir,
			agentDir,
			modelRuntime,
			model,
			settingsManager: SettingsManager.create(tempDir, agentDir),
			task: {
				id: "failed-edit",
				prompt: "Try an edit.",
			},
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});

		expect(result.assistantText).toBe("edit failure observed");
		expect(result.events).toContainEqual(expect.objectContaining({ type: "tool_execution_end", toolName: "edit" }));
		expect(result.events).toContainEqual(
			expect.objectContaining({
				type: "tool_execution_start",
				toolName: "edit",
				args: expect.objectContaining({ path: "missing.ts" }),
			}),
		);
		expect(result.events).toContainEqual(
			expect.objectContaining({
				type: "tool_execution_end",
				toolName: "edit",
				isError: true,
				resultText: expect.any(String),
			}),
		);
		expect(result.metrics.editAttempts).toBe(1);
		expect(result.metrics.failedEdits).toBe(1);
	});

	it("writes a JSONL trace for a native benchmark task result", () => {
		const tracePath = join(tempDir, "native-benchmark.jsonl");

		writeNativeBenchmarkJsonlTrace(tracePath, {
			task: { id: "trace-task" },
			capabilities: {
				runtimePath: {
					services: "createAgentSessionServices",
					session: "createAgentSessionFromServices",
				},
				modelRuntime: {
					path: "ModelRuntime",
					localProviderAvailable: true,
				},
				model: {
					provider: "faux",
					id: "faux-1",
				},
				semanticSearch: {
					available: true,
					status: "lexical_ready",
				},
				webAccess: "unavailable",
				activeNativeTools: ["read", "semantic_search"],
				extensionDiagnostics: [],
			},
			assistantText: "trace output",
			finalAssistantTextLength: "trace output".length,
			pass: true,
			validation: [],
			events: [{ type: "agent_start" }, { type: "message_end", messageRole: "assistant" }],
			metrics: {
				assistantTurns: 1,
				toolCalls: 0,
				toolCallsByName: {},
				failedToolCalls: 0,
				retrievalSearches: 0,
				editAttempts: 0,
				failedEdits: 0,
			},
		});

		const lines = readFileSync(tracePath, "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines).toEqual([
			{
				type: "capabilities",
				taskId: "trace-task",
				capabilities: expect.objectContaining({
					webAccess: "unavailable",
					activeNativeTools: ["read", "semantic_search"],
				}),
			},
			{
				type: "event",
				taskId: "trace-task",
				event: { type: "agent_start" },
			},
			{
				type: "event",
				taskId: "trace-task",
				event: { type: "message_end", messageRole: "assistant" },
			},
			{
				type: "result",
				taskId: "trace-task",
				assistantText: "trace output",
				finalAssistantTextLength: "trace output".length,
				pass: true,
				validation: [],
				metrics: {
					assistantTurns: 1,
					toolCalls: 0,
					toolCallsByName: {},
					failedToolCalls: 0,
					retrievalSearches: 0,
					editAttempts: 0,
					failedEdits: 0,
				},
			},
		]);
	});

	it("writes a markdown report for a native benchmark task result", () => {
		const reportPath = join(tempDir, "native-benchmark.md");

		writeNativeBenchmarkMarkdownReport(reportPath, {
			task: { id: "report-task" },
			capabilities: {
				runtimePath: {
					services: "createAgentSessionServices",
					session: "createAgentSessionFromServices",
				},
				modelRuntime: {
					path: "ModelRuntime",
					localProviderAvailable: true,
				},
				model: {
					provider: "faux",
					id: "faux-1",
				},
				semanticSearch: {
					available: true,
					status: "lexical_ready",
					vectorStatus: "ready",
					vectorProvider: "nomic-ai/CodeRankEmbed",
				},
				webAccess: "enabled",
				activeNativeTools: ["read", "semantic_search", "web_search"],
				extensionDiagnostics: [{ type: "info", message: "diagnostic" }],
			},
			assistantText: "report output",
			finalAssistantTextLength: "report output".length,
			pass: true,
			validation: [],
			events: [{ type: "agent_start" }],
			metrics: {
				assistantTurns: 1,
				toolCalls: 0,
				toolCallsByName: {},
				failedToolCalls: 0,
				retrievalSearches: 0,
				editAttempts: 0,
				failedEdits: 0,
			},
		});

		expect(readFileSync(reportPath, "utf-8")).toBe(`# Native Benchmark Report

Task: report-task

Runtime: createAgentSessionServices -> createAgentSessionFromServices
Model runtime: ModelRuntime
Model: faux/faux-1
Semantic search: available (lexical_ready)
Semantic vectors: ready (nomic-ai/CodeRankEmbed)
Web access: enabled
Active tools: read, semantic_search, web_search

Metrics:
- Pass: yes
- Assistant turns: 1
- Tool calls: 0
- Failed tool calls: 0
- Retrieval searches: 0
- Edit attempts: 0
- Failed edits: 0
- Final assistant text length: 13

Validation:
- none

Extension diagnostics:
- info: diagnostic
`);
	});

	it("validates benchmark shell commands against an explicit allowlist", () => {
		expect(
			validateNativeBenchmarkShellCommand("npm run check", {
				allowedCommands: ["npm run check"],
			}),
		).toEqual({ valid: true });
		expect(
			validateNativeBenchmarkShellCommand("rm -rf /", {
				allowedCommands: ["npm run check"],
			}),
		).toEqual({
			valid: false,
			reason: "Benchmark validation command is not allowed: rm -rf /",
		});
	});

	it("declares Dubai Boom benchmark tasks as native package data", () => {
		const tasks = getNativeDubaiBoomBenchmarkTasks();

		expect(tasks.map((task) => task.id)).toEqual(["context-survey", "api-contract-test", "self-correction-repair"]);
		expect(tasks[0]).toEqual(
			expect.objectContaining({
				title: "Planner context retrieval for API contracts",
				expectedAssistantTextIncludes: "app/api.py",
			}),
		);
		expect(tasks[1]?.validationCommands).toEqual(["python3 -m unittest tests.test_api_day_contract_benchmark -v"]);
		expect(tasks[1]?.prompt).toContain("GET /api/day?date=2026-07-24");
		expect(tasks[1]?.prompt).toContain("app/api.py");
		expect(tasks[1]?.prompt).toContain("python3 -m unittest tests.test_api_day_contract_benchmark -v");
		expect(tasks[2]?.validationCommands).toEqual(["python3 -m unittest tests.test_benchmark_repair -v"]);
		expect(tasks[2]?.prompt).toContain("tests/test_benchmark_repair.py");
	});

	it("seeds the Dubai Boom repair validation fixture into copied workspaces", async () => {
		const sourceWorkspace = join(tempDir, "source");
		mkdirSync(join(sourceWorkspace, "app"), { recursive: true });
		writeFileSync(join(sourceWorkspace, "app", "__init__.py"), "");
		writeFileSync(
			join(sourceWorkspace, "app", "geojson.py"),
			[
				"from datetime import datetime, timezone",
				"",
				"def _isoformat_utc(value):",
				"    if isinstance(value, str):",
				"        return value",
				"    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')",
				"",
				"def event_to_feature(event):",
				"    confidence = float(event.get('confidence', 0.0) or 0.0)",
				"    source_count = int(event.get('source_count', 1) or 1)",
				"    return {'properties': {'weight': round(min(confidence * source_count, 1.0), 3)}}",
				"",
			].join("\n"),
		);
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses([fauxAssistantMessage("repair fixture ok")]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(tempDir, "models.json"),
		});
		cleanups.push(() => modelRuntime.dispose());
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});

		const repairTask = getNativeDubaiBoomBenchmarkTasks().find((task) => task.id === "self-correction-repair");
		if (!repairTask) throw new Error("self-correction-repair task missing");
		const result = await runNativeBenchmarkTask({
			cwd: tempDir,
			agentDir,
			modelRuntime,
			model,
			settingsManager: SettingsManager.create(tempDir, agentDir),
			workspace: {
				sourcePath: sourceWorkspace,
				copyParent: join(tempDir, "copies"),
			},
			validation: {
				allowedCommands: ["python3 -m unittest tests.test_benchmark_repair -v"],
			},
			task: {
				...repairTask,
				prompt: "Return repair fixture ok.",
				expectedAssistantTextIncludes: "repair fixture ok",
			},
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});

		expect(result.pass).toBe(true);
		expect(result.validation[0]).toEqual(
			expect.objectContaining({
				command: "python3 -m unittest tests.test_benchmark_repair -v",
				exitCode: 0,
				passed: true,
			}),
		);
		expect(existsSync(join(result.workspace!.path, "tests", "test_benchmark_repair.py"))).toBe(true);
	});

	it("runs a native benchmark corpus through the native task runner", async () => {
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses([fauxAssistantMessage("first task done"), fauxAssistantMessage("second task done")]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(tempDir, "models.json"),
		});
		cleanups.push(() => modelRuntime.dispose());
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});

		const result = await runNativeBenchmarkCorpus({
			cwd: tempDir,
			agentDir,
			modelRuntime,
			model,
			settingsManager: SettingsManager.create(tempDir, agentDir),
			corpus: {
				id: "unit-corpus",
				tasks: [
					{
						id: "first",
						prompt: "Run first task.",
						expectedAssistantTextIncludes: "first",
					},
					{
						id: "second",
						prompt: "Run second task.",
						expectedAssistantTextIncludes: "second",
					},
				],
			},
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});

		expect(result.corpus).toEqual({ id: "unit-corpus" });
		expect(result.pass).toBe(true);
		expect(result.results.map((taskResult) => taskResult.task.id)).toEqual(["first", "second"]);
		expect(result.metrics).toEqual({
			tasks: 2,
			passedTasks: 2,
			failedTasks: 0,
			assistantTurns: 2,
			toolCalls: 0,
			failedToolCalls: 0,
			retrievalSearches: 0,
			editAttempts: 0,
			failedEdits: 0,
		});
	});

	it("copies a benchmark fixture workspace and runs validation in the copy", async () => {
		const sourceWorkspace = join(tempDir, "source");
		mkdirSync(join(sourceWorkspace, ".git"), { recursive: true });
		mkdirSync(join(sourceWorkspace, ".semantic_search"), { recursive: true });
		writeFileSync(join(sourceWorkspace, "keep.txt"), "fixture\n");
		writeFileSync(join(sourceWorkspace, ".git", "config"), "ignored\n");
		writeFileSync(join(sourceWorkspace, ".semantic_search", "index.json"), "{}\n");
		writeFileSync(join(sourceWorkspace, ".semantic_search", "stale.json"), "{}\n");

		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses([fauxAssistantMessage("validation ok")]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(tempDir, "models.json"),
		});
		cleanups.push(() => modelRuntime.dispose());
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});

		const result = await runNativeBenchmarkTask({
			cwd: tempDir,
			agentDir,
			modelRuntime,
			model,
			settingsManager: SettingsManager.create(tempDir, agentDir),
			workspace: {
				sourcePath: sourceWorkspace,
				copyParent: join(tempDir, "copies"),
			},
			validation: {
				allowedCommands: ["test -f keep.txt && test ! -e .git && test ! -f .semantic_search/stale.json && pwd"],
			},
			task: {
				id: "fixture-copy",
				prompt: "Return validation ok.",
				expectedAssistantTextIncludes: "validation ok",
				validationCommands: ["test -f keep.txt && test ! -e .git && test ! -f .semantic_search/stale.json && pwd"],
			},
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});

		expect(result.pass).toBe(true);
		expect(result.workspace?.sourcePath).toBe(sourceWorkspace);
		expect(result.workspace?.path).not.toBe(sourceWorkspace);
		expect(result.workspace?.path.endsWith("source")).toBe(true);
		expect(existsSync(join(sourceWorkspace, ".git", "config"))).toBe(true);
		expect(existsSync(join(result.workspace!.path, ".git"))).toBe(false);
		expect(result.validation).toHaveLength(1);
		expect(result.validation[0]).toEqual(
			expect.objectContaining({
				command: "test -f keep.txt && test ! -e .git && test ! -f .semantic_search/stale.json && pwd",
				exitCode: 0,
				passed: true,
			}),
		);
		expect(result.validation[0]?.output).toContain(result.workspace!.path);
	});

	it("fails a task when validation exits non-zero", async () => {
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses([fauxAssistantMessage("assistant ok")]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(tempDir, "models.json"),
		});
		cleanups.push(() => modelRuntime.dispose());
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});

		const result = await runNativeBenchmarkTask({
			cwd: tempDir,
			agentDir,
			modelRuntime,
			model,
			settingsManager: SettingsManager.create(tempDir, agentDir),
			validation: {
				allowedCommands: ['node -e "process.exit(7)"'],
			},
			task: {
				id: "validation-fails",
				prompt: "Return assistant ok.",
				expectedAssistantTextIncludes: "assistant ok",
				validationCommands: ['node -e "process.exit(7)"'],
			},
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});

		expect(result.pass).toBe(false);
		expect(result.failureReason).toBe('Validation command failed: node -e "process.exit(7)"');
		expect(result.validation[0]).toEqual(
			expect.objectContaining({
				command: 'node -e "process.exit(7)"',
				exitCode: 7,
				passed: false,
			}),
		);
	});

	it("rejects non-allowlisted validation commands without executing them", async () => {
		const markerPath = join(tempDir, "should-not-exist");
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses([fauxAssistantMessage("assistant ok")]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(tempDir, "models.json"),
		});
		cleanups.push(() => modelRuntime.dispose());
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});

		const result = await runNativeBenchmarkTask({
			cwd: tempDir,
			agentDir,
			modelRuntime,
			model,
			settingsManager: SettingsManager.create(tempDir, agentDir),
			validation: {
				allowedCommands: [],
			},
			task: {
				id: "validation-rejected",
				prompt: "Return assistant ok.",
				expectedAssistantTextIncludes: "assistant ok",
				validationCommands: [`touch ${markerPath}`],
			},
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});

		expect(result.pass).toBe(false);
		expect(result.validation[0]).toEqual({
			command: `touch ${markerPath}`,
			exitCode: null,
			output: "",
			durationMs: 0,
			passed: false,
			error: `Benchmark validation command is not allowed: touch ${markerPath}`,
		});
		expect(existsSync(markerPath)).toBe(false);
	});

	it("builds a native benchmark CLI plan from explicit flags", () => {
		const plan = createNativeBenchmarkCliPlan(
			[
				"--task",
				"context-survey,api-contract-test",
				"--source-workspace",
				"/tmp/source-workspace",
				"--workspace-copy-parent",
				"/tmp/copies",
				"--out",
				"/tmp/out",
				"--provider",
				"local",
				"--model",
				"local/qwen.gguf",
				"--semantic-embedding-base-url",
				"http://127.0.0.1:8129/v1",
				"--semantic-embedding-model",
				"nomic-ai/CodeRankEmbed",
				"--semantic-embedding-start-command",
				"python -m local_embeddings --port 8129",
				"--semantic-embedding-batch-size",
				"4",
				"--keep-runtime-processes",
				"--allow-validation",
				"python3 -m unittest tests.test_api_day_contract_benchmark -v",
				"--disable-validation",
			],
			{ cwd: "/tmp/run-cwd", agentDir: "/tmp/agent" },
		);

		expect(plan).toEqual({
			type: "run",
			cwd: "/tmp/run-cwd",
			agentDir: "/tmp/agent",
			outputDir: "/tmp/out",
			provider: "local",
			model: "local/qwen.gguf",
			semanticEmbedding: {
				baseUrl: "http://127.0.0.1:8129/v1",
				model: "nomic-ai/CodeRankEmbed",
				startCommand: "python -m local_embeddings --port 8129",
				batchSize: 4,
			},
			keepRuntimeProcesses: true,
			taskIds: ["context-survey", "api-contract-test"],
			workspace: {
				sourcePath: "/tmp/source-workspace",
				copyParent: "/tmp/copies",
			},
			validation: {
				enabled: false,
				allowedCommands: ["python3 -m unittest tests.test_api_day_contract_benchmark -v"],
			},
		});
	});

	it("writes native benchmark corpus artifacts", () => {
		const outputDir = join(tempDir, "artifacts");
		const result = {
			corpus: { id: "unit-corpus" },
			pass: false,
			results: [
				{
					task: { id: "first" },
					capabilities: {
						runtimePath: {
							services: "createAgentSessionServices" as const,
							session: "createAgentSessionFromServices" as const,
						},
						modelRuntime: {
							path: "ModelRuntime" as const,
							localProviderAvailable: true,
						},
						semanticSearch: {
							available: true,
							status: "lexical_ready",
						},
						webAccess: "unavailable" as const,
						activeNativeTools: ["semantic_search"],
						extensionDiagnostics: [],
					},
					assistantText: "first output",
					finalAssistantTextLength: "first output".length,
					pass: false,
					failureReason: "Validation command failed: false",
					validation: [
						{
							command: "false",
							exitCode: 1,
							output: "",
							durationMs: 2,
							passed: false,
							error: "Validation command failed: false",
						},
					],
					events: [{ type: "agent_start" as const }],
					metrics: {
						assistantTurns: 1,
						toolCalls: 0,
						toolCallsByName: {},
						failedToolCalls: 0,
						retrievalSearches: 0,
						editAttempts: 0,
						failedEdits: 0,
					},
				},
			],
			metrics: {
				tasks: 1,
				passedTasks: 0,
				failedTasks: 1,
				assistantTurns: 1,
				toolCalls: 0,
				failedToolCalls: 0,
				retrievalSearches: 0,
				editAttempts: 0,
				failedEdits: 0,
			},
		};

		const artifacts = writeNativeBenchmarkCorpusArtifacts(outputDir, result);

		expect(artifacts.summaryJsonPath).toBe(join(outputDir, "corpus-summary.json"));
		expect(artifacts.summaryMarkdownPath).toBe(join(outputDir, "corpus-summary.md"));
		expect(artifacts.taskArtifacts).toEqual([
			{
				taskId: "first",
				jsonlPath: join(outputDir, "tasks", "first.jsonl"),
				markdownPath: join(outputDir, "tasks", "first.md"),
			},
		]);
		expect(JSON.parse(readFileSync(artifacts.summaryJsonPath, "utf-8"))).toEqual({
			corpus: { id: "unit-corpus" },
			pass: false,
			metrics: result.metrics,
			tasks: [{ id: "first", pass: false, failureReason: "Validation command failed: false" }],
		});
		expect(readFileSync(artifacts.summaryMarkdownPath, "utf-8")).toContain("Failed tasks: 1");
		expect(readFileSync(join(outputDir, "tasks", "first.jsonl"), "utf-8")).toContain('"type":"result"');
		expect(readFileSync(join(outputDir, "tasks", "first.md"), "utf-8")).toContain("Validation command failed: false");
	});

	it("runs the native benchmark CLI through an injected corpus runner", async () => {
		const outputDir = join(tempDir, "cli-output");
		const sourceWorkspace = join(tempDir, "source-workspace");
		mkdirSync(sourceWorkspace, { recursive: true });
		let receivedOptions: Parameters<typeof runNativeBenchmarkCorpus>[0] | undefined;

		const exitCode = await runNativeBenchmarkCli(
			[
				"--task",
				"context-survey",
				"--source-workspace",
				sourceWorkspace,
				"--out",
				outputDir,
				"--semantic-embedding-base-url",
				"http://127.0.0.1:8129/v1",
				"--semantic-embedding-model",
				"nomic-ai/CodeRankEmbed",
				"--semantic-embedding-start-command",
				"python -m local_embeddings --port 8129",
				"--keep-runtime-processes",
				"--allow-validation",
				"python3 -m unittest tests.test_api_day_contract_benchmark -v",
			],
			{
				cwd: tempDir,
				agentDir,
				runCorpus: async (options) => {
					receivedOptions = options;
					return {
						corpus: { id: "dubai-boom" },
						pass: true,
						results: [
							{
								task: { id: "context-survey" },
								capabilities: {
									runtimePath: {
										services: "createAgentSessionServices",
										session: "createAgentSessionFromServices",
									},
									modelRuntime: {
										path: "ModelRuntime",
										localProviderAvailable: true,
									},
									semanticSearch: {
										available: true,
										status: "lexical_ready",
									},
									webAccess: "unavailable",
									activeNativeTools: ["semantic_search"],
									extensionDiagnostics: [],
								},
								assistantText: "app/api.py get_day etag",
								finalAssistantTextLength: "app/api.py get_day etag".length,
								pass: true,
								validation: [],
								events: [{ type: "agent_start" }],
								metrics: {
									assistantTurns: 1,
									toolCalls: 0,
									toolCallsByName: {},
									failedToolCalls: 0,
									retrievalSearches: 0,
									editAttempts: 0,
									failedEdits: 0,
								},
							},
						],
						metrics: {
							tasks: 1,
							passedTasks: 1,
							failedTasks: 0,
							assistantTurns: 1,
							toolCalls: 0,
							failedToolCalls: 0,
							retrievalSearches: 0,
							editAttempts: 0,
							failedEdits: 0,
						},
					};
				},
			},
		);

		expect(exitCode).toBe(0);
		expect(receivedOptions?.corpus.tasks.map((task) => task.id)).toEqual(["context-survey"]);
		expect(receivedOptions?.workspace).toEqual({ sourcePath: sourceWorkspace });
		expect(receivedOptions?.validation).toEqual({
			allowedCommands: ["python3 -m unittest tests.test_api_day_contract_benchmark -v"],
		});
		expect(receivedOptions?.semanticIndexOptions?.embedding?.id).toBe("nomic-ai/CodeRankEmbed");
		expect(receivedOptions?.semanticIndexOptions?.embeddingRuntime?.getState().value).toBe("unloaded");
		expect(receivedOptions?.disposeModelRuntime).toBe(false);
		expect(existsSync(join(outputDir, "corpus-summary.json"))).toBe(true);
	});
});
