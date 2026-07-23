import type { AgentTool } from "../../packages/agent/src/index.ts";
import { Type, type Static } from "../../packages/ai/src/index.ts";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type LspAction = "health" | "symbols";
export type LspServerStatus = "connected" | "disconnected" | "starting" | "error";

export interface LspServerState {
	language: string;
	status: LspServerStatus;
	rootPath?: string;
	capabilities: string[];
}

export interface LspSymbol {
	name: string;
	kind: string;
	path: string;
	line: number;
	character: number;
	containerName?: string;
}

export interface LspHealthState {
	consecutiveFailures: number;
	blockedUntilUnix: number;
	lastError: string;
	lastAttemptUnix: number;
	lastSuccessUnix: number;
	totalAttempts: number;
	totalFailures: number;
	lastFailureKind: string;
	recentCrashLoops: number;
	lastCapabilities: string;
}

export interface LspSymbolsResult {
	action: "symbols";
	path: string;
	query?: string;
	language: string;
	status: "dispatched";
	symbols: LspSymbol[];
	count: number;
}

export interface LspHealthResult {
	action: "health";
	servers: LspServerState[];
	health: Record<string, LspHealthSnapshot>;
	count: number;
}

export interface LspHealthSnapshot {
	consecutiveFailures: number;
	cooldownRemainingSeconds: number;
	lastError: string;
	lastAttemptUnix: number;
	lastSuccessUnix: number;
	totalAttempts: number;
	totalFailures: number;
	lastFailureKind: string;
	recentCrashLoops: number;
	lastCapabilities: string;
}

export type LspDispatchResult = LspSymbolsResult | LspHealthResult;

export interface LspSymbolRegistryOptions {
	now?: () => number;
	maxConsecutiveFailures?: number;
	cooldownMs?: number;
}

export interface LspDispatchInput {
	action: LspAction | "status" | "document_symbols";
	path?: string;
	query?: string;
	limit?: number;
}

const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_COOLDOWN_MS = 300_000;

export function languageForPath(path: string): string | undefined {
	const ext = path.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase();
	switch (ext) {
		case "rs":
			return "rust";
		case "ts":
		case "tsx":
			return "typescript";
		case "js":
		case "jsx":
			return "javascript";
		case "py":
			return "python";
		case "go":
			return "go";
		case "java":
			return "java";
		case "c":
		case "h":
			return "c";
		case "cpp":
		case "hpp":
		case "cc":
			return "cpp";
		case "rb":
			return "ruby";
		case "lua":
			return "lua";
		default:
			return undefined;
	}
}

function normalizeAction(action: LspDispatchInput["action"]): LspAction {
	if (action === "status") return "health";
	if (action === "document_symbols") return "symbols";
	return action;
}

function normalizeQuery(query: string | undefined): string {
	return query?.trim().toLowerCase() ?? "";
}

function symbolKey(symbol: LspSymbol): string {
	return `${symbol.path}\u0000${symbol.line}\u0000${symbol.character}\u0000${symbol.kind}\u0000${symbol.name}`;
}

function byLocationAndName(left: LspSymbol, right: LspSymbol): number {
	return (
		left.path.localeCompare(right.path) ||
		left.line - right.line ||
		left.character - right.character ||
		left.name.localeCompare(right.name)
	);
}

function summarizeCapabilities(capabilities: string[]): string {
	const sorted = [...new Set(capabilities)].sort();
	return sorted.length === 0 ? "none" : sorted.join(",");
}

function createEmptyHealth(): LspHealthState {
	return {
		consecutiveFailures: 0,
		blockedUntilUnix: 0,
		lastError: "",
		lastAttemptUnix: 0,
		lastSuccessUnix: 0,
		totalAttempts: 0,
		totalFailures: 0,
		lastFailureKind: "",
		recentCrashLoops: 0,
		lastCapabilities: "",
	};
}

export class LspSymbolRegistry {
	private readonly now: () => number;
	private readonly maxConsecutiveFailures: number;
	private readonly cooldownMs: number;
	private readonly servers = new Map<string, LspServerState>();
	private readonly symbolsByLanguage = new Map<string, LspSymbol[]>();
	private readonly health = new Map<string, LspHealthState>();

	constructor(options: LspSymbolRegistryOptions = {}) {
		this.now = options.now ?? Date.now;
		this.maxConsecutiveFailures = Math.max(1, options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES);
		this.cooldownMs = Math.max(1, options.cooldownMs ?? DEFAULT_COOLDOWN_MS);
	}

	registerServer(server: LspServerState): void {
		this.servers.set(server.language, { ...server, capabilities: [...server.capabilities] });
	}

	addSymbols(language: string, symbols: LspSymbol[]): void {
		const existing = this.symbolsByLanguage.get(language) ?? [];
		const deduped = new Map<string, LspSymbol>();
		for (const symbol of [...existing, ...symbols]) {
			deduped.set(symbolKey(symbol), { ...symbol });
		}
		this.symbolsByLanguage.set(language, [...deduped.values()].sort(byLocationAndName));
	}

	findServerForPath(path: string): LspServerState | undefined {
		const language = languageForPath(path);
		if (!language) return undefined;
		const server = this.servers.get(language);
		return server ? { ...server, capabilities: [...server.capabilities] } : undefined;
	}

	listServers(): LspServerState[] {
		return [...this.servers.values()]
			.map((server) => ({ ...server, capabilities: [...server.capabilities] }))
			.sort((left, right) => left.language.localeCompare(right.language));
	}

	dispatch(input: LspDispatchInput): LspDispatchResult {
		const action = normalizeAction(input.action);
		if (action === "health") return this.healthStatus();
		if (action !== "symbols") throw new Error(`unknown LSP action: ${input.action}`);

		const path = input.path?.trim();
		if (!path) throw new Error("path is required for this LSP action");
		const language = languageForPath(path);
		if (!language) throw new Error(`no LSP server available for path: ${path}`);
		this.assertCooldownInactive(language);
		this.recordAttempt(language);

		const server = this.servers.get(language);
		if (!server) {
			this.recordFailure(language, "request", `no LSP server available for path: ${path}`);
			throw new Error(`no LSP server available for path: ${path}`);
		}
		if (server.status !== "connected") {
			this.recordFailure(language, "startup", `LSP server for '${server.language}' is not connected (status: ${server.status})`);
			throw new Error(`LSP server for '${server.language}' is not connected (status: ${server.status})`);
		}

		this.recordSuccess(language, server.capabilities);
		const query = normalizeQuery(input.query);
		const limit = Math.max(1, input.limit ?? 20);
		const symbols = (this.symbolsByLanguage.get(language) ?? [])
			.filter((symbol) => symbol.path === path)
			.filter((symbol) => query.length === 0 || symbol.name.toLowerCase().includes(query))
			.sort(byLocationAndName)
			.slice(0, limit);

		return {
			action: "symbols",
			path,
			query: input.query,
			language,
			status: "dispatched",
			symbols,
			count: symbols.length,
		};
	}

	private recordAttempt(language: string): void {
		const state = this.getOrCreateHealth(language);
		state.totalAttempts += 1;
		state.lastAttemptUnix = this.now() / 1000;
	}

	private recordSuccess(language: string, capabilities: string[]): void {
		const state = this.getOrCreateHealth(language);
		state.consecutiveFailures = 0;
		state.blockedUntilUnix = 0;
		state.lastSuccessUnix = this.now() / 1000;
		state.lastError = "";
		state.lastFailureKind = "";
		state.recentCrashLoops = 0;
		state.lastCapabilities = summarizeCapabilities(capabilities);
	}

	private recordFailure(language: string, failureKind: string, error: string): void {
		const state = this.getOrCreateHealth(language);
		state.consecutiveFailures += 1;
		state.totalFailures += 1;
		state.lastError = error;
		state.lastFailureKind = failureKind;
		if (state.consecutiveFailures >= this.maxConsecutiveFailures) {
			state.blockedUntilUnix = this.now() / 1000 + this.cooldownMs / 1000;
			state.recentCrashLoops += 1;
		}
	}

	private assertCooldownInactive(language: string): void {
		const remaining = this.cooldownRemainingSeconds(language);
		if (remaining === null) return;
		const state = this.health.get(language);
		const suffix = state?.lastError ? ` after error: ${state.lastError}` : "";
		throw new Error(`LSP action blocked for '${language}': cooldown active for ${remaining}s${suffix}`);
	}

	private cooldownRemainingSeconds(language: string): number | null {
		const state = this.health.get(language);
		if (!state) return null;
		const remaining = state.blockedUntilUnix - this.now() / 1000;
		return remaining > 0 ? Math.ceil(remaining) : null;
	}

	private healthStatus(): LspHealthResult {
		const health: Record<string, LspHealthSnapshot> = {};
		for (const [language, state] of [...this.health.entries()].sort(([left], [right]) => left.localeCompare(right))) {
			health[language] = {
				consecutiveFailures: state.consecutiveFailures,
				cooldownRemainingSeconds: this.cooldownRemainingSeconds(language) ?? 0,
				lastError: state.lastError,
				lastAttemptUnix: state.lastAttemptUnix,
				lastSuccessUnix: state.lastSuccessUnix,
				totalAttempts: state.totalAttempts,
				totalFailures: state.totalFailures,
				lastFailureKind: state.lastFailureKind,
				recentCrashLoops: state.recentCrashLoops,
				lastCapabilities: state.lastCapabilities,
			};
		}
		return {
			action: "health",
			servers: this.listServers(),
			health,
			count: Object.keys(health).length,
		};
	}

	private getOrCreateHealth(language: string): LspHealthState {
		const existing = this.health.get(language);
		if (existing) return existing;
		const next = createEmptyHealth();
		this.health.set(language, next);
		return next;
	}
}

export function createLspSymbolRegistry(options: LspSymbolRegistryOptions = {}): LspSymbolRegistry {
	return new LspSymbolRegistry(options);
}

export function buildLspSymbolContext(input: {
	registry: LspSymbolRegistry;
	path: string;
	query?: string;
	limit?: number;
}): string {
	const result = input.registry.dispatch({
		action: "symbols",
		path: input.path,
		query: input.query,
		limit: input.limit,
	});
	if (result.action !== "symbols") throw new Error("expected symbols result");

	const lines = [
		"<lsp_symbols>",
		`language: ${result.language}`,
		`path: ${result.path}`,
		`count: ${result.count}`,
		...result.symbols.map((symbol) => {
			const container = symbol.containerName ? ` container=${symbol.containerName}` : "";
			return `- ${symbol.kind} ${symbol.name} ${symbol.path}:${symbol.line}:${symbol.character}${container}`;
		}),
		"</lsp_symbols>",
	];
	return `${lines.join("\n")}\n`;
}

function isWithinWorkspace(candidate: string, workspaceRoot: string): boolean {
	return candidate === workspaceRoot || candidate.startsWith(`${workspaceRoot}${sep}`);
}

async function resolveWorkspacePath(cwd: string, path: string): Promise<string> {
	if (!path.trim()) throw new Error("path must not be empty");
	const workspaceRoot = await realpath(cwd);
	const absolutePath = isAbsolute(path) ? path : resolve(workspaceRoot, path);
	if (!isWithinWorkspace(absolutePath, workspaceRoot)) {
		throw new Error(`path escapes workspace: ${path}`);
	}
	return relative(workspaceRoot, absolutePath);
}

const lspSymbolsSchema = Type.Object({
	path: Type.String({ description: "Workspace-relative source file path." }),
	query: Type.Optional(Type.String({ description: "Optional case-insensitive symbol-name filter." })),
	limit: Type.Optional(Type.Number({ description: "Maximum symbols to return." })),
});

type LspSymbolsParams = Static<typeof lspSymbolsSchema>;

export function createLspSymbolsTool(cwd: string, registry: LspSymbolRegistry): AgentTool<typeof lspSymbolsSchema, LspSymbolsResult> {
	return {
		label: "LSP symbols",
		name: "lsp_symbols",
		description: "Return cached LSP document symbols for a workspace source file.",
		parameters: lspSymbolsSchema,
		executionMode: "parallel",
		execute: async (_toolCallId: string, params: LspSymbolsParams) => {
			const path = await resolveWorkspacePath(cwd, params.path);
			const result = registry.dispatch({
				action: "symbols",
				path,
				query: params.query,
				limit: params.limit,
			});
			if (result.action !== "symbols") throw new Error("expected symbols result");
			const text = buildLspSymbolContext({
				registry,
				path,
				query: params.query,
				limit: params.limit,
			});
			return {
				content: [{ type: "text", text }],
				details: result,
			};
		},
	};
}
