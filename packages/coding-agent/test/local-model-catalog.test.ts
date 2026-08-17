import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	createAssistantMessageEventStream,
	InMemoryModelsStore,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	createLocalModelProvider,
	LOCAL_MODEL_PROVIDER_ID,
	LocalModelCatalog,
	resolveLocalModelsDir,
} from "../src/core/local-model-catalog.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const originalLocalModelsDir = process.env.PI_LOCAL_MODELS_DIR;
let tempDirs: string[] = [];

function tempDir(): string {
	const path = mkdtempSync(join(tmpdir(), "pi-local-models-"));
	tempDirs.push(path);
	return path;
}

function touch(path: string): void {
	mkdirSync(resolve(path, ".."), { recursive: true });
	writeFileSync(path, "");
}

afterEach(() => {
	if (originalLocalModelsDir === undefined) delete process.env.PI_LOCAL_MODELS_DIR;
	else process.env.PI_LOCAL_MODELS_DIR = originalLocalModelsDir;
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs = [];
});

describe("LocalModelCatalog", () => {
	it("uses ~/.pi/models by default and honors PI_LOCAL_MODELS_DIR", () => {
		delete process.env.PI_LOCAL_MODELS_DIR;
		expect(resolveLocalModelsDir()).toMatch(/[\\/]\.pi[\\/]models$/);

		const dir = tempDir();
		process.env.PI_LOCAL_MODELS_DIR = dir;
		expect(resolveLocalModelsDir()).toBe(resolve(dir));
	});

	it("reports a missing directory without throwing", async () => {
		const dir = join(tempDir(), "missing");
		const result = await new LocalModelCatalog({ modelsDir: dir }).discover();

		expect(result.models).toEqual([]);
		expect(result.errors).toEqual([`Local models directory does not exist: ${resolve(dir)}`]);
	});

	it("returns no models for an empty directory", async () => {
		const result = await new LocalModelCatalog({ modelsDir: tempDir() }).discover();

		expect(result.models).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	it("discovers gguf files recursively with canonical absolute paths and stable ids", async () => {
		const dir = tempDir();
		touch(join(dir, "Qwen3-Coder.gguf"));
		touch(join(dir, "nested", "DeepSeek.gguf"));
		touch(join(dir, "nested", "ignore.txt"));

		const result = await new LocalModelCatalog({ modelsDir: dir }).discover();

		expect(result.errors).toEqual([]);
		expect(result.models.map((model) => model.id)).toEqual(["DeepSeek", "Qwen3-Coder"]);
		expect(result.models.map((model) => model.path)).toEqual([
			resolve(dir, "nested", "DeepSeek.gguf"),
			resolve(dir, "Qwen3-Coder.gguf"),
		]);
	});

	it("disambiguates duplicate filenames in different subdirectories", async () => {
		const dir = tempDir();
		touch(join(dir, "a", "model.gguf"));
		touch(join(dir, "b", "model.gguf"));

		const result = await new LocalModelCatalog({ modelsDir: dir }).discover();

		expect(result.models.map((model) => model.id)).toEqual(["a/model", "b/model"]);
		expect(new Set(result.models.map((model) => model.id)).size).toBe(2);
	});

	it("handles unreadable paths without crashing", async () => {
		const filePath = join(tempDir(), "not-a-directory");
		writeFileSync(filePath, "");

		const result = await new LocalModelCatalog({ modelsDir: filePath }).discover();

		expect(result.models).toEqual([]);
		expect(result.errors[0]).toContain("Local models path is not a directory:");
	});
});

describe("ModelRuntime local models", () => {
	it("exposes discovered local models as available native models without provider catalog mutation", async () => {
		const dir = tempDir();
		touch(join(dir, "qwen.gguf"));
		process.env.PI_LOCAL_MODELS_DIR = dir;

		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});

		const model = runtime.getModel(LOCAL_MODEL_PROVIDER_ID, "qwen");
		expect(model).toMatchObject({
			id: "qwen",
			name: "qwen.gguf",
			provider: LOCAL_MODEL_PROVIDER_ID,
			api: "openai-completions",
		});
		expect(await runtime.checkAuth(LOCAL_MODEL_PROVIDER_ID)).toEqual({
			type: "api_key",
			source: "PI_LOCAL_MODELS_DIR",
		});
		expect((await runtime.getAvailable()).some((entry) => entry.provider === LOCAL_MODEL_PROVIDER_ID)).toBe(true);
		expect(runtime.getRegisteredProviderIds()).not.toContain(LOCAL_MODEL_PROVIDER_ID);
	});

	it("disposes the owned local model runtime manager", async () => {
		let shutdownCalls = 0;
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
			localModelRuntimeManager: {
				ensureReady: async () => ({ baseUrl: "http://127.0.0.1:49159", apiKey: "local" }),
				inferenceBaseUrl: (endpoint) => `${endpoint.baseUrl}/v1`,
				shutdown: async () => {
					shutdownCalls++;
				},
			},
		});

		await runtime.dispose();
		await runtime.dispose();

		expect(shutdownCalls).toBe(1);
	});
});

describe("local model provider runtime handoff", () => {
	function doneStream(model: Model<any>): ReturnType<typeof createAssistantMessageEventStream> {
		const stream = createAssistantMessageEventStream();
		stream.push({
			type: "done",
			reason: "stop",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		});
		return stream;
	}

	it("ensures the selected GGUF runtime is ready before streamSimple delegates", async () => {
		const dir = tempDir();
		const modelPath = join(dir, "qwen.gguf");
		touch(modelPath);
		const ensureCalls: Array<{ id: string; path: string }> = [];
		const streamCalls: Array<{ baseUrl: string | undefined; apiKey: string | undefined }> = [];
		const provider = await createLocalModelProvider({
			modelsDir: dir,
			runtimeManager: {
				ensureReady: async (target) => {
					ensureCalls.push(target);
					return { baseUrl: "http://127.0.0.1:49158", apiKey: "local" };
				},
				inferenceBaseUrl: (endpoint) => `${endpoint.baseUrl}/v1`,
			},
			streams: {
				stream: (model) => doneStream(model),
				streamSimple: (model, _context, options) => {
					streamCalls.push({ baseUrl: model.baseUrl, apiKey: options?.apiKey });
					return doneStream(model);
				},
			},
		});
		const model = provider.getModels()[0]!;

		const result = await provider.streamSimple(model, { messages: [] }).result();

		expect(result.stopReason).toBe("stop");
		expect(ensureCalls).toEqual([{ id: "qwen", path: resolve(modelPath) }]);
		expect(streamCalls).toEqual([{ baseUrl: "http://127.0.0.1:49158/v1", apiKey: "local" }]);
	});

	it("applies native Qwen compatibility metadata and payload defaults", async () => {
		const dir = tempDir();
		const modelPath = join(dir, "Qwen3.6-35B-A3B-IQ4_XS.gguf");
		touch(modelPath);
		const payloads: unknown[] = [];
		const streamCalls: Array<{ model: Model<"openai-completions">; options: SimpleStreamOptions | undefined }> = [];
		const provider = await createLocalModelProvider({
			modelsDir: dir,
			runtimeManager: {
				ensureReady: async () => ({ baseUrl: "http://127.0.0.1:49163", apiKey: "local" }),
				inferenceBaseUrl: (endpoint) => `${endpoint.baseUrl}/v1`,
			},
			streams: {
				stream: (model) => doneStream(model),
				streamSimple: (model, _context, options) => {
					streamCalls.push({ model, options });
					const payload = { model: model.id, chat_template_kwargs: { existing: true } };
					payloads.push(options?.onPayload ? options.onPayload(payload, model) : payload);
					return doneStream(model);
				},
			},
		});
		const model = provider.getModels()[0]!;

		await provider.streamSimple(model, { messages: [] }, { reasoning: "low" }).result();

		expect(streamCalls[0]?.model).toMatchObject({
			id: "Qwen3.6-35B-A3B-IQ4_XS",
			reasoning: true,
			contextWindow: 131072,
			maxTokens: 16384,
			compat: {
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				supportsStore: false,
				supportsUsageInStreaming: true,
				maxTokensField: "max_tokens",
				thinkingFormat: "qwen-chat-template",
				supportsStrictMode: false,
			},
		});
		await expect(Promise.resolve(payloads[0])).resolves.toMatchObject({
			temperature: 0.2,
			top_p: 0.9,
			top_k: 20,
			min_p: 0.02,
			presence_penalty: 0,
			repeat_penalty: 1.02,
			repeat_last_n: 128,
			chat_template_kwargs: {
				existing: true,
				enable_thinking: true,
				preserve_thinking: true,
			},
		});
	});

	it("disables Qwen thinking in payload defaults when no thinking level is requested", async () => {
		const dir = tempDir();
		touch(join(dir, "qwen-coder.gguf"));
		const payloads: unknown[] = [];
		const provider = await createLocalModelProvider({
			modelsDir: dir,
			runtimeManager: {
				ensureReady: async () => ({ baseUrl: "http://127.0.0.1:49164", apiKey: "local" }),
				inferenceBaseUrl: (endpoint) => `${endpoint.baseUrl}/v1`,
			},
			streams: {
				stream: (model) => doneStream(model),
				streamSimple: (model, _context, options) => {
					const payload = { model: model.id };
					payloads.push(options?.onPayload ? options.onPayload(payload, model) : payload);
					return doneStream(model);
				},
			},
		});
		const model = provider.getModels()[0]!;

		await provider.streamSimple(model, { messages: [] }).result();

		await expect(Promise.resolve(payloads[0])).resolves.toMatchObject({
			chat_template_kwargs: {
				enable_thinking: false,
				preserve_thinking: true,
			},
		});
	});

	it("does not apply Qwen-only metadata or payload defaults to non-Qwen local models", async () => {
		const dir = tempDir();
		touch(join(dir, "llama.gguf"));
		const payloads: unknown[] = [];
		const streamCalls: Array<{ model: Model<"openai-completions">; options: SimpleStreamOptions | undefined }> = [];
		const provider = await createLocalModelProvider({
			modelsDir: dir,
			runtimeManager: {
				ensureReady: async () => ({ baseUrl: "http://127.0.0.1:49165", apiKey: "local" }),
				inferenceBaseUrl: (endpoint) => `${endpoint.baseUrl}/v1`,
			},
			streams: {
				stream: (model) => doneStream(model),
				streamSimple: (model, _context, options) => {
					streamCalls.push({ model, options });
					const payload = { model: model.id };
					payloads.push(options?.onPayload ? options.onPayload(payload, model) : payload);
					return doneStream(model);
				},
			},
		});
		const model = provider.getModels()[0]!;

		await provider.streamSimple(model, { messages: [] }, { reasoning: "low" }).result();

		expect(streamCalls[0]?.model.reasoning).toBe(false);
		const capturedModel = streamCalls[0]?.model;
		if (capturedModel?.api !== "openai-completions") {
			throw new Error("Expected an OpenAI-compatible local model");
		}
		expect(capturedModel.compat?.thinkingFormat).not.toBe("qwen-chat-template");
		await expect(Promise.resolve(payloads[0])).resolves.toEqual({ model: "llama" });
	});

	it("fails closed when a local model id is no longer in the catalog", async () => {
		const dir = tempDir();
		touch(join(dir, "qwen.gguf"));
		const provider = await createLocalModelProvider({ modelsDir: dir });
		const staleModel = { ...provider.getModels()[0]!, id: "deleted" };

		const result = await provider.streamSimple(staleModel, { messages: [] }).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Local model is no longer available: deleted");
	});
});
