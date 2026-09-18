import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { llamaInferenceUrl } from "../extensions/llama/client.ts";

export type LocalModelRuntimeStateValue =
	| "unloaded"
	| "starting_server"
	| "loading_model"
	| "ready"
	| "runtime_unavailable"
	| "model_missing"
	| "configuration_invalid"
	| "load_failed"
	| "process_exited";

export interface LocalModelRuntimeState {
	value: LocalModelRuntimeStateValue;
	modelId?: string;
	modelPath?: string;
	baseUrl?: string;
	message?: string;
}

export interface LocalModelRuntimeLogEntry {
	stream: "stdout" | "stderr";
	text: string;
}

export interface LocalModelRuntimeTarget {
	id: string;
	path: string;
}

export interface LocalModelRuntimeEndpoint {
	baseUrl: string;
	apiKey: string;
}

export interface LocalModelRuntimeProcess {
	pid?: number;
	onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void;
	onOutput?(listener: (entry: LocalModelRuntimeLogEntry) => void): () => void;
	kill(signal?: NodeJS.Signals): void;
}

export interface LocalModelRuntimeStartOptions {
	cwd: string;
	host: string;
	port: number;
	env: NodeJS.ProcessEnv;
	retainAfterParentExit?: boolean;
	logPath?: string;
}

export interface LocalModelRuntimeOperations {
	executableExists(path: string): Promise<boolean>;
	modelExists(path: string): Promise<boolean>;
	allocatePort(host: string): Promise<number>;
	start(command: string, args: string[], options: LocalModelRuntimeStartOptions): LocalModelRuntimeProcess;
	waitUntilReady(baseUrl: string, signal?: AbortSignal, readyTimeoutMs?: number): Promise<void>;
}

export interface LocalModelRuntimeManagerOptions {
	serverBin?: string;
	host?: string;
	port?: number;
	cwd?: string;
	extraArgs?: string[];
	maxLogBytes?: number;
	restartCooldownMs?: number;
	readyTimeoutMs?: number;
	retainAfterParentExit?: boolean;
	logPath?: string;
	now?: () => number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	operations?: LocalModelRuntimeOperations;
}

export class LocalModelRuntimeError extends Error {
	readonly code: Exclude<
		LocalModelRuntimeStateValue,
		"unloaded" | "starting_server" | "loading_model" | "ready" | "process_exited"
	>;
	readonly state: LocalModelRuntimeState;

	constructor(code: LocalModelRuntimeError["code"], message: string, state: LocalModelRuntimeState) {
		super(message);
		this.name = "LocalModelRuntimeError";
		this.code = code;
		this.state = state;
	}
}

type StateListener = (state: LocalModelRuntimeState) => void;

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_API_KEY = "local";
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_LOG_BYTES = 2_000_000;
const DEFAULT_RESTART_COOLDOWN_MS = 0;
const QWEN_SHARP_CHAT_TEMPLATE_FILE = fileURLToPath(
	new URL("./chat-templates/qwen-sharp-chat-template.jinja", import.meta.url),
);

function envValue(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value || undefined;
}

function configuredServerBin(): string {
	return envValue("LLAMA_CPP_SERVER_BIN") ?? "llama-server";
}

function configuredPort(): number | undefined {
	const value = envValue("PI_LOCAL_LLAMA_PORT");
	if (!value) return undefined;
	const port = Number(value);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) return Number.NaN;
	return port;
}

function configuredReadyTimeoutMs(): number | undefined {
	const value = envValue("PI_LOCAL_LLAMA_READY_TIMEOUT_MS");
	if (!value) return undefined;
	const timeoutMs = Number(value);
	return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined;
}

function configuredExtraArgs(): string[] {
	const value = envValue("PI_LOCAL_LLAMA_ARGS");
	return value ? value.split(/\s+/u).filter((entry) => entry.length > 0) : [];
}

function isQwenCompatibleTarget(target: LocalModelRuntimeTarget): boolean {
	return /\bqwen\b|qwen\d|qwen[-_.]|kat[-_.]?coder/iu.test(`${target.id} ${target.path}`);
}

function hasArg(args: readonly string[], name: string): boolean {
	return args.includes(name);
}

function configuredLogPath(): string | undefined {
	return envValue("PI_LOCAL_LLAMA_LOG_PATH");
}

function commandCandidates(command: string): string[] {
	if (isAbsolute(command) || command.includes("/") || command.includes("\\")) return [command];
	return (process.env.PATH ?? "")
		.split(delimiter)
		.filter((entry) => entry.length > 0)
		.map((entry) => join(entry, command));
}

async function defaultExecutableExists(command: string): Promise<boolean> {
	for (const candidate of commandCandidates(command)) {
		try {
			await access(candidate, 0b001);
			return true;
		} catch {
			// Try the next PATH entry.
		}
	}
	return false;
}

async function defaultModelExists(path: string): Promise<boolean> {
	try {
		await access(path, 0b100);
		return true;
	} catch {
		return false;
	}
}

function defaultAllocatePort(host: string): Promise<number> {
	return new Promise((resolvePromise, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, host, () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : undefined;
			server.close(() => {
				if (port) resolvePromise(port);
				else reject(new Error("Could not allocate a local llama.cpp port"));
			});
		});
	});
}

function defaultStart(
	command: string,
	args: string[],
	options: LocalModelRuntimeStartOptions,
): LocalModelRuntimeProcess {
	const retainedLogFd =
		options.retainAfterParentExit === true && options.logPath ? openRetainedRuntimeLog(options.logPath) : undefined;
	let child!: ReturnType<typeof spawn>;
	try {
		child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			detached: options.retainAfterParentExit === true,
			stdio:
				options.retainAfterParentExit === true
					? ["ignore", retainedLogFd ?? "ignore", retainedLogFd ?? "ignore"]
					: ["ignore", "pipe", "pipe"],
		});
	} finally {
		if (retainedLogFd !== undefined) closeSync(retainedLogFd);
	}
	if (options.retainAfterParentExit === true) child.unref();
	return {
		pid: child.pid,
		onExit: (listener) => {
			child.on("exit", listener);
			return () => child.off("exit", listener);
		},
		onOutput: (listener) => {
			if (options.retainAfterParentExit === true) return () => {};
			const onStdout = (chunk: Buffer) => listener({ stream: "stdout", text: chunk.toString() });
			const onStderr = (chunk: Buffer) => listener({ stream: "stderr", text: chunk.toString() });
			child.stdout?.on("data", onStdout);
			child.stderr?.on("data", onStderr);
			return () => {
				child.stdout?.off("data", onStdout);
				child.stderr?.off("data", onStderr);
			};
		},
		kill: (signal = "SIGTERM") => {
			child.kill(signal);
		},
	};
}

function openRetainedRuntimeLog(logPath: string): number {
	mkdirSync(dirname(logPath), { recursive: true });
	return openSync(logPath, "a", 0o600);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new Error("Cancelled"));
			return;
		}
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolvePromise();
		}, ms);
		const abort = () => {
			clearTimeout(timeout);
			reject(signal?.reason ?? new Error("Cancelled"));
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
}

async function defaultWaitUntilReady(
	baseUrl: string,
	signal?: AbortSignal,
	readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
): Promise<void> {
	const deadline = Date.now() + readyTimeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		if (signal?.aborted) throw signal.reason ?? new Error("Cancelled");
		try {
			const response = await fetch(`${baseUrl}/v1/models`, {
				headers: { Authorization: `Bearer ${DEFAULT_API_KEY}` },
				signal: AbortSignal.timeout(2_000),
			});
			if (response.ok) return;
			lastError = new Error(`llama.cpp returned HTTP ${response.status}`);
		} catch (error) {
			lastError = error;
		}
		await sleep(250, signal);
	}
	throw lastError instanceof Error ? lastError : new Error("Timed out waiting for llama.cpp readiness");
}

function defaultOperations(): LocalModelRuntimeOperations {
	return {
		executableExists: defaultExecutableExists,
		modelExists: defaultModelExists,
		allocatePort: defaultAllocatePort,
		start: defaultStart,
		waitUntilReady: defaultWaitUntilReady,
	};
}

export class LocalModelRuntimeManager {
	private readonly serverBin: string;
	private readonly host: string;
	private readonly configuredPort: number | undefined;
	private readonly cwd: string;
	private readonly extraArgs: string[];
	private readonly maxLogBytes: number;
	private readonly restartCooldownMs: number;
	private readonly readyTimeoutMs: number;
	private readonly retainAfterParentExit: boolean;
	private readonly logPath: string | undefined;
	private readonly now: () => number;
	private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	private readonly operations: LocalModelRuntimeOperations;
	private readonly listeners = new Set<StateListener>();
	private readonly logs: LocalModelRuntimeLogEntry[] = [];
	private state: LocalModelRuntimeState = { value: "unloaded" };
	private process: LocalModelRuntimeProcess | undefined;
	private processExitUnsubscribe: (() => void) | undefined;
	private processOutputUnsubscribe: (() => void) | undefined;
	private endpoint: LocalModelRuntimeEndpoint | undefined;
	private readyTarget: LocalModelRuntimeTarget | undefined;
	private restartCooldownTarget: LocalModelRuntimeTarget | undefined;
	private restartCooldownUntil = 0;
	private startPromise: Promise<LocalModelRuntimeEndpoint> | undefined;
	private shuttingDown = false;

	constructor(options: LocalModelRuntimeManagerOptions = {}) {
		this.serverBin = options.serverBin ?? configuredServerBin();
		this.host = options.host ?? envValue("PI_LOCAL_LLAMA_HOST") ?? DEFAULT_HOST;
		this.configuredPort = options.port ?? configuredPort();
		this.cwd = options.cwd ?? process.cwd();
		this.extraArgs = options.extraArgs ?? configuredExtraArgs();
		this.maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
		this.restartCooldownMs = Math.max(0, options.restartCooldownMs ?? DEFAULT_RESTART_COOLDOWN_MS);
		this.readyTimeoutMs = Math.max(
			1,
			options.readyTimeoutMs ?? configuredReadyTimeoutMs() ?? DEFAULT_READY_TIMEOUT_MS,
		);
		this.retainAfterParentExit = options.retainAfterParentExit === true;
		this.logPath = options.logPath ?? configuredLogPath();
		this.now = options.now ?? Date.now;
		this.sleep = options.sleep ?? sleep;
		this.operations = options.operations ?? defaultOperations();
	}

	getState(): LocalModelRuntimeState {
		return { ...this.state };
	}

	subscribe(listener: StateListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	getLogSnapshot(): LocalModelRuntimeLogEntry[] {
		return this.logs.map((entry) => ({ ...entry }));
	}

	getProcessId(): number | undefined {
		return this.process?.pid;
	}

	private appendLog(entry: LocalModelRuntimeLogEntry): void {
		this.logs.push(entry);
		let totalBytes = this.logs.reduce((sum, logEntry) => sum + Buffer.byteLength(logEntry.text), 0);
		while (totalBytes > this.maxLogBytes && this.logs.length > 0) {
			const removed = this.logs.shift();
			totalBytes -= removed ? Buffer.byteLength(removed.text) : 0;
		}
	}

	private setState(state: LocalModelRuntimeState): void {
		this.state = state;
		for (const listener of this.listeners) listener(this.getState());
	}

	private error(
		code: LocalModelRuntimeError["code"],
		message: string,
		target?: LocalModelRuntimeTarget,
		baseUrl?: string,
	): LocalModelRuntimeError {
		const state = { value: code, modelId: target?.id, modelPath: target?.path, baseUrl, message };
		this.setState(state);
		return new LocalModelRuntimeError(code, message, state);
	}

	private async stopCurrent(): Promise<void> {
		this.processExitUnsubscribe?.();
		this.processExitUnsubscribe = undefined;
		this.processOutputUnsubscribe?.();
		this.processOutputUnsubscribe = undefined;
		if (this.process) {
			this.shuttingDown = true;
			this.process.kill("SIGTERM");
			this.shuttingDown = false;
		}
		this.process = undefined;
		this.endpoint = undefined;
		this.readyTarget = undefined;
	}

	private async waitForRestartCooldown(target: LocalModelRuntimeTarget, signal?: AbortSignal): Promise<void> {
		if (
			this.restartCooldownTarget?.id !== target.id ||
			this.restartCooldownTarget.path !== target.path ||
			this.restartCooldownUntil <= 0
		) {
			return;
		}
		const remainingMs = this.restartCooldownUntil - this.now();
		if (remainingMs <= 0) {
			this.restartCooldownTarget = undefined;
			this.restartCooldownUntil = 0;
			return;
		}
		await this.sleep(remainingMs, signal);
		this.restartCooldownTarget = undefined;
		this.restartCooldownUntil = 0;
	}

	private buildArgs(target: LocalModelRuntimeTarget, port: number): string[] {
		const qwenChatTemplateArgs =
			isQwenCompatibleTarget(target) &&
			!hasArg(this.extraArgs, "--chat-template-file") &&
			!hasArg(this.extraArgs, "--chat-template")
				? ["--chat-template-file", QWEN_SHARP_CHAT_TEMPLATE_FILE]
				: [];
		const qwenReasoningFormatArgs =
			isQwenCompatibleTarget(target) && !hasArg(this.extraArgs, "--reasoning-format")
				? ["--reasoning-format", "deepseek"]
				: [];
		return [
			"--host",
			this.host,
			"--port",
			String(port),
			"-m",
			target.path,
			"--jinja",
			...qwenChatTemplateArgs,
			...qwenReasoningFormatArgs,
			"--no-mmproj",
			...this.extraArgs,
		];
	}

	async ensureReady(target: LocalModelRuntimeTarget, signal?: AbortSignal): Promise<LocalModelRuntimeEndpoint> {
		if (
			this.endpoint &&
			this.readyTarget?.path === target.path &&
			this.readyTarget.id === target.id &&
			this.state.value === "ready"
		) {
			return this.endpoint;
		}
		if (this.startPromise) return this.startPromise;

		this.startPromise = this.start(target, signal).finally(() => {
			this.startPromise = undefined;
		});
		return this.startPromise;
	}

	private async start(target: LocalModelRuntimeTarget, signal?: AbortSignal): Promise<LocalModelRuntimeEndpoint> {
		if (Number.isNaN(this.configuredPort)) {
			throw this.error("configuration_invalid", "PI_LOCAL_LLAMA_PORT must be an integer from 1 to 65535.", target);
		}
		if (!(await this.operations.executableExists(this.serverBin))) {
			throw this.error("runtime_unavailable", `llama-server is not available: ${this.serverBin}`, target);
		}
		if (!(await this.operations.modelExists(target.path))) {
			throw this.error("model_missing", `Local model does not exist: ${target.path}`, target);
		}

		await this.waitForRestartCooldown(target, signal);
		await this.stopCurrent();
		const port = this.configuredPort ?? (await this.operations.allocatePort(this.host));
		const baseUrl = `http://${this.host}:${port}`;
		this.setState({ value: "starting_server", modelId: target.id, modelPath: target.path, baseUrl });
		let childProcess: LocalModelRuntimeProcess;
		try {
			childProcess = this.operations.start(this.serverBin, this.buildArgs(target, port), {
				cwd: this.cwd,
				host: this.host,
				port,
				env: process.env,
				retainAfterParentExit: this.retainAfterParentExit,
				logPath: this.logPath,
			});
		} catch (error) {
			throw this.error("load_failed", error instanceof Error ? error.message : String(error), target, baseUrl);
		}
		this.process = childProcess;
		this.processOutputUnsubscribe = childProcess.onOutput?.((entry) => this.appendLog(entry));
		this.processExitUnsubscribe = childProcess.onExit((code, exitSignal) => {
			if (this.shuttingDown) return;
			this.process = undefined;
			this.endpoint = undefined;
			if (this.restartCooldownMs > 0) {
				this.restartCooldownTarget = target;
				this.restartCooldownUntil = this.now() + this.restartCooldownMs;
			}
			this.setState({
				value: "process_exited",
				modelId: target.id,
				modelPath: target.path,
				baseUrl,
				message: `llama-server exited${code === null ? "" : ` with code ${code}`}${
					exitSignal ? ` (${exitSignal})` : ""
				}`,
			});
		});

		this.setState({ value: "loading_model", modelId: target.id, modelPath: target.path, baseUrl });
		try {
			await this.operations.waitUntilReady(baseUrl, signal, this.readyTimeoutMs);
		} catch (error) {
			await this.stopCurrent();
			throw this.error("load_failed", error instanceof Error ? error.message : String(error), target, baseUrl);
		}
		this.readyTarget = target;
		this.endpoint = { baseUrl, apiKey: DEFAULT_API_KEY };
		this.setState({ value: "ready", modelId: target.id, modelPath: target.path, baseUrl });
		return this.endpoint;
	}

	async shutdown(): Promise<void> {
		await this.stopCurrent();
		this.setState({ value: "unloaded" });
	}

	inferenceBaseUrl(endpoint: LocalModelRuntimeEndpoint): string {
		return llamaInferenceUrl(endpoint.baseUrl);
	}
}
