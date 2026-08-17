import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

export type WorkspaceEmbeddingRuntimeStateValue =
	| "unloaded"
	| "starting_server"
	| "ready"
	| "runtime_unavailable"
	| "configuration_invalid"
	| "load_failed"
	| "process_exited";

export interface WorkspaceEmbeddingRuntimeState {
	value: WorkspaceEmbeddingRuntimeStateValue;
	baseUrl?: string;
	message?: string;
}

export interface WorkspaceEmbeddingRuntimeEndpoint {
	baseUrl: string;
}

export interface WorkspaceEmbeddingRuntimeProcess {
	onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void;
	kill(signal?: NodeJS.Signals): void;
}

export interface WorkspaceEmbeddingRuntimeStartOptions {
	cwd: string;
	baseUrl: string;
	env: NodeJS.ProcessEnv;
}

export interface WorkspaceEmbeddingRuntimeOperations {
	executableExists(command: string): Promise<boolean>;
	start(command: string, options: WorkspaceEmbeddingRuntimeStartOptions): WorkspaceEmbeddingRuntimeProcess;
	waitUntilReady(baseUrl: string, signal?: AbortSignal): Promise<void>;
}

export interface WorkspaceEmbeddingRuntimeManagerOptions {
	baseUrl: string;
	startCommand: string;
	cwd?: string;
	operations?: WorkspaceEmbeddingRuntimeOperations;
}

export class WorkspaceEmbeddingRuntimeError extends Error {
	readonly code: Exclude<
		WorkspaceEmbeddingRuntimeStateValue,
		"unloaded" | "starting_server" | "ready" | "process_exited"
	>;
	readonly state: WorkspaceEmbeddingRuntimeState;

	constructor(code: WorkspaceEmbeddingRuntimeError["code"], message: string, state: WorkspaceEmbeddingRuntimeState) {
		super(message);
		this.name = "WorkspaceEmbeddingRuntimeError";
		this.code = code;
		this.state = state;
	}
}

type StateListener = (state: WorkspaceEmbeddingRuntimeState) => void;

const DEFAULT_READY_TIMEOUT_MS = 120_000;

function commandExecutable(command: string): string {
	return command.trim().split(/\s+/u)[0] ?? "";
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

function defaultStart(
	command: string,
	options: WorkspaceEmbeddingRuntimeStartOptions,
): WorkspaceEmbeddingRuntimeProcess {
	const child = spawn("bash", ["-lc", command], {
		cwd: options.cwd,
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		onExit: (listener) => {
			child.on("exit", listener);
			return () => child.off("exit", listener);
		},
		kill: (signal = "SIGTERM") => {
			child.kill(signal);
		},
	};
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

async function defaultWaitUntilReady(baseUrl: string, signal?: AbortSignal): Promise<void> {
	const deadline = Date.now() + DEFAULT_READY_TIMEOUT_MS;
	let lastError: unknown;
	while (Date.now() < deadline) {
		if (signal?.aborted) throw signal.reason ?? new Error("Cancelled");
		try {
			const response = await fetch(`${baseUrl.replace(/\/+$/u, "")}/models`, {
				signal: AbortSignal.timeout(2_000),
			});
			if (response.ok) return;
			lastError = new Error(`embedding endpoint returned HTTP ${response.status}`);
		} catch (error) {
			lastError = error;
		}
		await sleep(250, signal);
	}
	throw lastError instanceof Error ? lastError : new Error("Timed out waiting for embedding endpoint readiness");
}

function defaultOperations(): WorkspaceEmbeddingRuntimeOperations {
	return {
		executableExists: defaultExecutableExists,
		start: defaultStart,
		waitUntilReady: defaultWaitUntilReady,
	};
}

export class WorkspaceEmbeddingRuntimeManager {
	private readonly baseUrl: string;
	private readonly startCommand: string;
	private readonly cwd: string;
	private readonly operations: WorkspaceEmbeddingRuntimeOperations;
	private readonly listeners = new Set<StateListener>();
	private state: WorkspaceEmbeddingRuntimeState = { value: "unloaded" };
	private process: WorkspaceEmbeddingRuntimeProcess | undefined;
	private processExitUnsubscribe: (() => void) | undefined;
	private endpoint: WorkspaceEmbeddingRuntimeEndpoint | undefined;
	private startPromise: Promise<WorkspaceEmbeddingRuntimeEndpoint> | undefined;
	private shuttingDown = false;

	constructor(options: WorkspaceEmbeddingRuntimeManagerOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
		this.startCommand = options.startCommand.trim();
		this.cwd = options.cwd ?? process.cwd();
		this.operations = options.operations ?? defaultOperations();
	}

	getState(): WorkspaceEmbeddingRuntimeState {
		return { ...this.state };
	}

	subscribe(listener: StateListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private setState(state: WorkspaceEmbeddingRuntimeState): void {
		this.state = state;
		for (const listener of this.listeners) listener(this.getState());
	}

	private error(code: WorkspaceEmbeddingRuntimeError["code"], message: string): WorkspaceEmbeddingRuntimeError {
		const state = { value: code, baseUrl: this.baseUrl, message };
		this.setState(state);
		return new WorkspaceEmbeddingRuntimeError(code, message, state);
	}

	async ensureReady(signal?: AbortSignal): Promise<WorkspaceEmbeddingRuntimeEndpoint> {
		if (this.endpoint && this.state.value === "ready") return this.endpoint;
		if (this.startPromise) return this.startPromise;
		this.startPromise = this.start(signal).finally(() => {
			this.startPromise = undefined;
		});
		return this.startPromise;
	}

	private async start(signal?: AbortSignal): Promise<WorkspaceEmbeddingRuntimeEndpoint> {
		const executable = commandExecutable(this.startCommand);
		if (!this.baseUrl) {
			throw this.error("configuration_invalid", "PI_SEMANTIC_EMBEDDING_BASE_URL is required.");
		}
		if (!executable) {
			throw this.error("configuration_invalid", "PI_SEMANTIC_EMBEDDING_START_COMMAND is empty.");
		}
		if (!(await this.operations.executableExists(executable))) {
			throw this.error("runtime_unavailable", `Embedding start command is not available: ${executable}`);
		}

		this.setState({ value: "starting_server", baseUrl: this.baseUrl });
		let childProcess: WorkspaceEmbeddingRuntimeProcess;
		try {
			childProcess = this.operations.start(this.startCommand, {
				cwd: this.cwd,
				baseUrl: this.baseUrl,
				env: process.env,
			});
		} catch (error) {
			throw this.error("load_failed", error instanceof Error ? error.message : String(error));
		}
		this.process = childProcess;
		this.processExitUnsubscribe = childProcess.onExit((code, exitSignal) => {
			if (this.shuttingDown) return;
			this.process = undefined;
			this.endpoint = undefined;
			this.setState({
				value: "process_exited",
				baseUrl: this.baseUrl,
				message: `embedding server exited${code === null ? "" : ` with code ${code}`}${
					exitSignal ? ` (${exitSignal})` : ""
				}`,
			});
		});

		try {
			await this.operations.waitUntilReady(this.baseUrl, signal);
		} catch (error) {
			await this.stopCurrent();
			throw this.error("load_failed", error instanceof Error ? error.message : String(error));
		}
		this.endpoint = { baseUrl: this.baseUrl };
		this.setState({ value: "ready", baseUrl: this.baseUrl });
		return this.endpoint;
	}

	private async stopCurrent(): Promise<void> {
		this.processExitUnsubscribe?.();
		this.processExitUnsubscribe = undefined;
		if (this.process) {
			this.shuttingDown = true;
			this.process.kill("SIGTERM");
			this.shuttingDown = false;
		}
		this.process = undefined;
		this.endpoint = undefined;
	}

	async shutdown(): Promise<void> {
		await this.stopCurrent();
		this.setState({ value: "unloaded" });
	}
}
