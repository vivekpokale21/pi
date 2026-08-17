import { basename, join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import type { SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { ModelRuntime } from "./model-runtime.ts";
import {
	DefaultResourceLoader,
	type DefaultResourceLoaderOptions,
	type ResourceLoader,
	type ResourceLoaderReloadOptions,
} from "./resource-loader.ts";
import { type CreateAgentSessionOptions, type CreateAgentSessionResult, createAgentSession } from "./sdk.ts";
import type { SessionManager } from "./session-manager.ts";
import { type PackageSource, SettingsManager } from "./settings-manager.ts";
import { createOpenAICompatibleWorkspaceEmbeddingProvider } from "./workspace-embedding-provider.ts";
import { WorkspaceEmbeddingRuntimeManager } from "./workspace-embedding-runtime-manager.ts";
import { WorkspaceSemanticIndex, type WorkspaceSemanticIndexOptions } from "./workspace-semantic-index.ts";

/**
 * Non-fatal issues collected while creating services or sessions.
 *
 * Runtime creation returns diagnostics to the caller instead of printing or
 * exiting. The app layer decides whether warnings should be shown and whether
 * errors should abort startup.
 */
export interface AgentSessionRuntimeDiagnostic {
	type: "info" | "warning" | "error";
	message: string;
}

/**
 * Inputs for creating cwd-bound runtime services.
 *
 * These services are recreated whenever the effective session cwd changes.
 * CLI-provided resource paths should be resolved to absolute paths before they
 * reach this function, so later cwd switches do not reinterpret them.
 */
export interface CreateAgentSessionServicesOptions {
	cwd: string;
	agentDir?: string;
	settingsManager?: SettingsManager;
	modelRuntime?: ModelRuntime;
	extensionFlagValues?: Map<string, boolean | string>;
	resourceLoaderOptions?: Omit<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">;
	resourceLoaderReloadOptions?: ResourceLoaderReloadOptions;
	semanticIndexOptions?: WorkspaceSemanticIndexOptions;
	disposeModelRuntime?: boolean;
}

/**
 * Inputs for creating an AgentSession from already-created services.
 *
 * Use this after services exist and any cwd-bound model/tool/session options
 * have been resolved against those services.
 */
export interface CreateAgentSessionFromServicesOptions {
	services: AgentSessionServices;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	tools?: string[];
	excludeTools?: CreateAgentSessionOptions["excludeTools"];
	noTools?: CreateAgentSessionOptions["noTools"];
	customTools?: ToolDefinition[];
}

/**
 * Coherent cwd-bound runtime services for one effective session cwd.
 *
 * This is infrastructure only. The AgentSession itself is created separately so
 * session options can be resolved against these services first.
 */
export interface AgentSessionServices {
	cwd: string;
	agentDir: string;
	modelRuntime: ModelRuntime;
	settingsManager: SettingsManager;
	resourceLoader: ResourceLoader;
	semanticIndex: WorkspaceSemanticIndex;
	embeddingRuntime?: WorkspaceEmbeddingRuntimeManager;
	diagnostics: AgentSessionRuntimeDiagnostic[];
	dispose?: () => Promise<void>;
}

function applyExtensionFlagValues(
	resourceLoader: ResourceLoader,
	extensionFlagValues: Map<string, boolean | string> | undefined,
): AgentSessionRuntimeDiagnostic[] {
	if (!extensionFlagValues) {
		return [];
	}

	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	const extensionsResult = resourceLoader.getExtensions();
	const registeredFlags = new Map<string, { type: "boolean" | "string" }>();
	for (const extension of extensionsResult.extensions) {
		for (const [name, flag] of extension.flags) {
			registeredFlags.set(name, { type: flag.type });
		}
	}

	const unknownFlags: string[] = [];
	for (const [name, value] of extensionFlagValues) {
		const flag = registeredFlags.get(name);
		if (!flag) {
			unknownFlags.push(name);
			continue;
		}
		if (flag.type === "boolean") {
			extensionsResult.runtime.flagValues.set(name, true);
			continue;
		}
		if (typeof value === "string") {
			extensionsResult.runtime.flagValues.set(name, value);
			continue;
		}
		diagnostics.push({
			type: "error",
			message: `Extension flag "--${name}" requires a value`,
		});
	}

	if (unknownFlags.length > 0) {
		diagnostics.push({
			type: "error",
			message: `Unknown option${unknownFlags.length === 1 ? "" : "s"}: ${unknownFlags.map((name) => `--${name}`).join(", ")}`,
		});
	}

	return diagnostics;
}

function isPiWebAccessPackageSource(source: string): boolean {
	const normalized = source.replace(/\\/g, "/");
	if (normalized.startsWith("npm:")) {
		const npmSpec = normalized.slice("npm:".length);
		return npmSpec === "pi-web-access" || npmSpec.startsWith("pi-web-access@");
	}
	return basename(normalized) === "pi-web-access";
}

function sourceFromPackageSource(pkg: PackageSource): string {
	return typeof pkg === "string" ? pkg : pkg.source;
}

function collectWebAccessCapabilityDiagnostics(
	settingsManager: SettingsManager,
	resourceLoader: ResourceLoader,
): AgentSessionRuntimeDiagnostic[] {
	const hasConfiguredWebAccess = settingsManager
		.getPackages()
		.some((pkg) => isPiWebAccessPackageSource(sourceFromPackageSource(pkg)));
	if (!hasConfiguredWebAccess) {
		return [];
	}

	const registeredToolNames = new Set<string>();
	for (const extension of resourceLoader.getExtensions().extensions) {
		for (const toolName of extension.tools.keys()) {
			registeredToolNames.add(toolName);
		}
	}

	if (registeredToolNames.has("web_search") || registeredToolNames.has("fetch_content")) {
		return [];
	}

	return [
		{
			type: "info",
			message: "Web access is configured through pi-web-access, but web tools are unavailable or disabled.",
		},
	];
}

function parsePositiveInteger(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function createSemanticIndexOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): WorkspaceSemanticIndexOptions {
	const baseUrl = env.PI_SEMANTIC_EMBEDDING_BASE_URL;
	const model = env.PI_SEMANTIC_EMBEDDING_MODEL;
	const startCommand = env.PI_SEMANTIC_EMBEDDING_START_COMMAND;
	const embeddingBatchSize = parsePositiveInteger(env.PI_SEMANTIC_EMBEDDING_BATCH_SIZE);
	const embeddingRuntime =
		baseUrl && startCommand
			? new WorkspaceEmbeddingRuntimeManager({
					baseUrl,
					startCommand,
				})
			: undefined;
	return {
		...(embeddingBatchSize ? { embeddingBatchSize } : {}),
		...(baseUrl && model
			? {
					embedding: createOpenAICompatibleWorkspaceEmbeddingProvider({
						baseUrl,
						model,
						apiKey: env.PI_SEMANTIC_EMBEDDING_API_KEY,
						resolveBaseUrl: embeddingRuntime
							? async (signal) => (await embeddingRuntime.ensureReady(signal)).baseUrl
							: undefined,
					}),
				}
			: {}),
		...(embeddingRuntime ? { embeddingRuntime } : {}),
	};
}

/**
 * Create cwd-bound runtime services.
 *
 * Returns services plus diagnostics. It does not create an AgentSession.
 */
export async function createAgentSessionServices(
	options: CreateAgentSessionServicesOptions,
): Promise<AgentSessionServices> {
	const cwd = resolvePath(options.cwd);
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getAgentDir();
	const ownsModelRuntime = !options.modelRuntime;
	const disposeModelRuntime = options.disposeModelRuntime ?? ownsModelRuntime;
	const modelRuntime =
		options.modelRuntime ??
		(await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
		}));
	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const envSemanticIndexOptions = createSemanticIndexOptionsFromEnv();
	const semanticIndexOptions = {
		...envSemanticIndexOptions,
		...options.semanticIndexOptions,
	};
	const semanticIndex = new WorkspaceSemanticIndex(cwd, {
		...semanticIndexOptions,
		watch: true,
	});
	const embeddingRuntime = semanticIndexOptions.embeddingRuntime;
	semanticIndex.start();
	const resourceLoader = new DefaultResourceLoader({
		...(options.resourceLoaderOptions ?? {}),
		cwd,
		agentDir,
		settingsManager,
	});
	await resourceLoader.reload(options.resourceLoaderReloadOptions);

	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	const extensionsResult = resourceLoader.getExtensions();
	for (const { name, config, extensionPath } of extensionsResult.runtime.pendingProviderRegistrations) {
		try {
			modelRuntime.registerProvider(name, config);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			diagnostics.push({
				type: "error",
				message: `Extension "${extensionPath}" error: ${message}`,
			});
		}
	}
	extensionsResult.runtime.pendingProviderRegistrations = [];
	for (const { provider, extensionPath } of extensionsResult.runtime.pendingNativeProviderRegistrations) {
		try {
			modelRuntime.registerNativeProvider(provider);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			diagnostics.push({
				type: "error",
				message: `Extension "${extensionPath}" error: ${message}`,
			});
		}
	}
	extensionsResult.runtime.pendingNativeProviderRegistrations = [];
	await modelRuntime.refresh({ allowNetwork: false });
	diagnostics.push(...applyExtensionFlagValues(resourceLoader, options.extensionFlagValues));
	diagnostics.push(...collectWebAccessCapabilityDiagnostics(settingsManager, resourceLoader));

	return {
		cwd,
		agentDir,
		modelRuntime,
		settingsManager,
		resourceLoader,
		diagnostics,
		semanticIndex,
		embeddingRuntime,
		dispose: async () => {
			semanticIndex.cancel();
			await embeddingRuntime?.shutdown();
			if (disposeModelRuntime) await modelRuntime.dispose();
		},
	};
}

/**
 * Create an AgentSession from previously created services.
 *
 * This keeps session creation separate from service creation so callers can
 * resolve model, thinking, tools, and other session inputs against the target
 * cwd before constructing the session.
 */
export async function createAgentSessionFromServices(
	options: CreateAgentSessionFromServicesOptions,
): Promise<CreateAgentSessionResult> {
	return createAgentSession({
		cwd: options.services.cwd,
		agentDir: options.services.agentDir,
		modelRuntime: options.services.modelRuntime,
		settingsManager: options.services.settingsManager,
		resourceLoader: options.services.resourceLoader,
		sessionManager: options.sessionManager,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		scopedModels: options.scopedModels,
		tools: options.tools,
		excludeTools: options.excludeTools,
		noTools: options.noTools,
		customTools: options.customTools,
		semanticIndex: options.services.semanticIndex,
		sessionStartEvent: options.sessionStartEvent,
	});
}
