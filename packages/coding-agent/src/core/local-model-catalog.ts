import type { Dirent, Stats } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import {
	type AuthContext,
	type Context,
	lazyStream,
	type Model,
	type Provider,
	type ProviderStreamOptions,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/compat";
import { normalizePath } from "../utils/paths.ts";
import {
	type LocalModelRuntimeEndpoint,
	LocalModelRuntimeManager,
	type LocalModelRuntimeState,
	type LocalModelRuntimeTarget,
} from "./local-model-runtime-manager.ts";

export const LOCAL_MODEL_PROVIDER_ID = "local";
export const PI_LOCAL_MODELS_DIR = "PI_LOCAL_MODELS_DIR";
export const DEFAULT_LOCAL_MODELS_DIR = "~/.pi/models";

const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;
const QWEN_CONTEXT_WINDOW = 131072;
const QWEN_TEMPERATURE = 0.2;
const QWEN_TOP_P = 0.9;
const QWEN_TOP_K = 20;
const QWEN_MIN_P = 0.02;
const QWEN_PRESENCE_PENALTY = 0;
const QWEN_REPEAT_PENALTY = 1.02;
const QWEN_REPEAT_LAST_N = 128;

export interface LocalModelCatalogEntry {
	id: string;
	name: string;
	path: string;
}

export interface LocalModelCatalogResult {
	models: LocalModelCatalogEntry[];
	errors: string[];
}

export interface LocalModelCatalogOptions {
	modelsDir?: string;
}

export interface LocalModelProviderRuntime {
	ensureReady(target: LocalModelRuntimeTarget, signal?: AbortSignal): Promise<LocalModelRuntimeEndpoint>;
	inferenceBaseUrl(endpoint: LocalModelRuntimeEndpoint): string;
	subscribe?(listener: (state: LocalModelRuntimeState) => void): () => void;
	shutdown?(): Promise<void>;
}

export interface LocalModelProviderStreams {
	stream(
		model: Model<"openai-completions">,
		context: Context,
		options?: ProviderStreamOptions,
	): ReturnType<typeof stream>;
	streamSimple(
		model: Model<"openai-completions">,
		context: Context,
		options?: SimpleStreamOptions,
	): ReturnType<typeof streamSimple>;
}

export interface LocalModelProviderOptions extends LocalModelCatalogOptions {
	runtimeManager?: LocalModelProviderRuntime;
	streams?: LocalModelProviderStreams;
}

export function resolveLocalModelsDir(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env[PI_LOCAL_MODELS_DIR]?.trim();
	return resolve(normalizePath(configured || DEFAULT_LOCAL_MODELS_DIR, { homeDir: homedir() }));
}

function toModelId(path: string, root: string, duplicateBasenames: ReadonlySet<string>): string {
	const extension = extname(path);
	const stem = basename(path, extension);
	if (!duplicateBasenames.has(basename(path))) return stem;
	const relativePath = relative(root, path).split(sep).join("/");
	return relativePath.slice(0, -extension.length);
}

function toPiModel(entry: LocalModelCatalogEntry): Model<"openai-completions"> {
	const isQwen = isQwenLocalModel(entry);
	return {
		id: entry.id,
		name: entry.name,
		api: "openai-completions",
		provider: LOCAL_MODEL_PROVIDER_ID,
		baseUrl: "http://127.0.0.1:8080/v1",
		reasoning: isQwen,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: isQwen ? QWEN_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsUsageInStreaming: isQwen,
			supportsStrictMode: false,
			maxTokensField: "max_tokens",
			...(isQwen ? { thinkingFormat: "qwen-chat-template" as const } : {}),
		},
	};
}

function isQwenLocalModel(entry: LocalModelCatalogEntry): boolean {
	return /\bqwen\b|qwen\d|qwen[-_.]/iu.test(`${entry.id} ${entry.name}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function applyQwenPayloadDefaults(payload: unknown, thinkingEnabled: boolean): unknown {
	if (!isRecord(payload)) return payload;
	const params = { ...payload };
	params.temperature = QWEN_TEMPERATURE;
	params.top_p = QWEN_TOP_P;
	params.top_k = QWEN_TOP_K;
	params.min_p = QWEN_MIN_P;
	params.presence_penalty = QWEN_PRESENCE_PENALTY;
	params.repeat_penalty = QWEN_REPEAT_PENALTY;
	params.repeat_last_n = QWEN_REPEAT_LAST_N;
	const existingKwargs = isRecord(params.chat_template_kwargs) ? params.chat_template_kwargs : {};
	params.chat_template_kwargs = {
		...existingKwargs,
		enable_thinking: thinkingEnabled,
		preserve_thinking: true,
	};
	return params;
}

function applyQwenRequestOptions<TOptions extends StreamOptions & { apiKey: string; reasoning?: unknown }>(
	options: TOptions,
): TOptions {
	const originalOnPayload = options.onPayload;
	const thinkingEnabled = options.reasoning !== undefined;
	return {
		...options,
		onPayload: async (payload, model) => {
			const profiledPayload = applyQwenPayloadDefaults(payload, thinkingEnabled);
			const nextPayload = await originalOnPayload?.(profiledPayload, model);
			return nextPayload ?? profiledPayload;
		},
	};
}

async function directoryExists(ctx: AuthContext, path: string): Promise<boolean> {
	return ctx.fileExists(path);
}

export class LocalModelCatalog {
	private readonly modelsDir: string;

	constructor(options: LocalModelCatalogOptions = {}) {
		this.modelsDir = resolve(normalizePath(options.modelsDir ?? resolveLocalModelsDir()));
	}

	getModelsDir(): string {
		return this.modelsDir;
	}

	async discover(): Promise<LocalModelCatalogResult> {
		let rootStat: Stats;
		try {
			rootStat = await stat(this.modelsDir);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				return { models: [], errors: [`Local models directory does not exist: ${this.modelsDir}`] };
			}
			return {
				models: [],
				errors: [
					`Could not read local models directory: ${this.modelsDir}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				],
			};
		}
		if (!rootStat.isDirectory()) {
			return { models: [], errors: [`Local models path is not a directory: ${this.modelsDir}`] };
		}

		const files: string[] = [];
		const errors: string[] = [];
		const visit = async (dir: string): Promise<void> => {
			let entries: Dirent[];
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch (error) {
				errors.push(
					`Could not read local models directory: ${dir}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
				return;
			}
			for (const entry of entries) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) {
					await visit(path);
				} else if (entry.isFile() && entry.name.toLowerCase().endsWith(".gguf")) {
					files.push(path);
				}
			}
		};
		await visit(this.modelsDir);

		const canonicalRoot = await realpath(this.modelsDir);
		const canonicalFiles = await Promise.all(files.map((file) => realpath(file)));
		canonicalFiles.sort((a, b) => relative(canonicalRoot, a).localeCompare(relative(canonicalRoot, b)));
		const basenameCounts = new Map<string, number>();
		for (const file of canonicalFiles) {
			const name = basename(file);
			basenameCounts.set(name, (basenameCounts.get(name) ?? 0) + 1);
		}
		const duplicateBasenames = new Set(
			[...basenameCounts.entries()].filter((entry) => entry[1] > 1).map((entry) => entry[0]),
		);

		return {
			models: canonicalFiles.map((path) => ({
				id: toModelId(path, canonicalRoot, duplicateBasenames),
				name: basename(path),
				path,
			})),
			errors,
		};
	}
}

export async function createLocalModelProvider(
	options: LocalModelProviderOptions = {},
): Promise<Provider<"openai-completions">> {
	const catalog = new LocalModelCatalog({ modelsDir: options.modelsDir });
	let result = await catalog.discover();
	const runtimeManager = options.runtimeManager ?? new LocalModelRuntimeManager();
	const streams = options.streams ?? { stream, streamSimple };

	const configuredSource = process.env[PI_LOCAL_MODELS_DIR]?.trim() ? PI_LOCAL_MODELS_DIR : DEFAULT_LOCAL_MODELS_DIR;
	const refreshCatalog = async (): Promise<void> => {
		result = await catalog.discover();
	};

	return {
		id: LOCAL_MODEL_PROVIDER_ID,
		name: "Local GGUF",
		baseUrl: "http://127.0.0.1:8080/v1",
		auth: {
			apiKey: {
				name: "Local GGUF model directory",
				check: async ({ ctx }) =>
					result.models.length > 0 && (await directoryExists(ctx, catalog.getModelsDir()))
						? { type: "api_key", source: configuredSource }
						: undefined,
				resolve: async ({ ctx }) =>
					result.models.length > 0 && (await directoryExists(ctx, catalog.getModelsDir()))
						? { auth: { apiKey: "local" }, source: configuredSource }
						: undefined,
			},
		},
		getModels: () => result.models.map(toPiModel),
		refreshModels: async () => {
			await refreshCatalog();
		},
		stream: (model, context, streamOptions) =>
			lazyStream(model, async () => {
				const prepared = await prepareLocalModelRequest(model, streamOptions);
				return streams.stream(prepared.model, context, prepared.options as ProviderStreamOptions);
			}),
		streamSimple: (model, context, streamOptions) =>
			lazyStream(model, async () => {
				const prepared = await prepareLocalModelRequest(model, streamOptions);
				return streams.streamSimple(prepared.model, context, prepared.options as SimpleStreamOptions);
			}),
	};

	async function prepareLocalModelRequest<TOptions extends StreamOptions | undefined>(
		model: Model<"openai-completions">,
		requestOptions: TOptions,
	): Promise<{ model: Model<"openai-completions">; options: TOptions & { apiKey: string } }> {
		const entry = result.models.find((candidate) => candidate.id === model.id);
		if (!entry) throw new Error(`Local model is no longer available: ${model.id}`);
		const endpoint = await runtimeManager.ensureReady({ id: entry.id, path: entry.path }, requestOptions?.signal);
		const requestModel = toPiModel(entry);
		const options = {
			...(requestOptions ?? {}),
			apiKey: requestOptions?.apiKey ?? endpoint.apiKey,
		} as TOptions & { apiKey: string; reasoning?: unknown };
		return {
			model: {
				...requestModel,
				baseUrl: runtimeManager.inferenceBaseUrl(endpoint),
			},
			options: isQwenLocalModel(entry) ? applyQwenRequestOptions(options) : options,
		};
	}
}
