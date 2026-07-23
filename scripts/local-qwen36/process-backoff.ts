import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

const DEFAULT_PROCESS_HEALTH_VERSION = 1;
const DEFAULT_PROCESS_HEALTH_STATE_FILE = "process_health_state.json";
const DEFAULT_PROCESS_STATE_DIR = ".port_sessions";
const ENV_PROCESS_HEALTH_STATE_FILE = "QWEN36_PROCESS_HEALTH_STATE_FILE";

export interface BackoffDelayPolicy {
	initialDelayMs: number;
	maxDelayMs: number;
}

export interface CrashBackoffPolicy extends BackoffDelayPolicy {
	maxConsecutiveFailures: number;
	cooldownMs: number;
}

export interface ProcessRunResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	runtimeMs: number;
}

export interface ProcessHealthState {
	consecutiveFailures: number;
	blockedUntilUnix: number;
	lastError: string;
	lastAttemptUnix: number;
	lastSuccessUnix: number;
	totalAttempts: number;
	totalFailures: number;
	lastFailureKind: string;
	recentCrashLoops: number;
}

export interface ProcessHealthStore {
	getState(processKey: string): Promise<ProcessHealthState | undefined>;
	cooldownRemainingSeconds(processKey: string): Promise<number | null>;
	recordAttempt(processKey: string): Promise<ProcessHealthState>;
	recordSuccess(processKey: string): Promise<ProcessHealthState>;
	recordFailure(
		processKey: string,
		failureKind: string,
		error: string,
		policy: Pick<CrashBackoffPolicy, "maxConsecutiveFailures" | "cooldownMs">,
	): Promise<ProcessHealthState>;
}

export interface ProcessHealthStoreOptions {
	path?: string;
	inMemory?: boolean;
	now?: () => number;
}

export interface RunWithCrashBackoffOptions {
	processKey: string;
	maxAttempts: number;
	stableAfterMs: number;
	policy: CrashBackoffPolicy;
	store: ProcessHealthStore;
	sleep: (ms: number) => Promise<void>;
	runOnce: () => Promise<ProcessRunResult>;
}

export type CrashBackoffRunSummary =
	| { status: "success"; attempts: number; lastResult: ProcessRunResult }
	| { status: "blocked"; attempts: number; reason: string }
	| { status: "exhausted"; attempts: number; reason: string; lastResult?: ProcessRunResult };

interface PersistedProcessHealthState {
	consecutive_failures?: number;
	blocked_until_unix?: number;
	last_error?: string;
	last_attempt_unix?: number;
	last_success_unix?: number;
	total_attempts?: number;
	total_failures?: number;
	last_failure_kind?: string;
	recent_crash_loops?: number;
}

interface PersistedProcessHealthPayload {
	version?: number;
	saved_unix?: number;
	health?: Record<string, PersistedProcessHealthState>;
}

function defaultState(): ProcessHealthState {
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
	};
}

function toPublicState(state: PersistedProcessHealthState | undefined): ProcessHealthState {
	return {
		consecutiveFailures: state?.consecutive_failures ?? 0,
		blockedUntilUnix: state?.blocked_until_unix ?? 0,
		lastError: state?.last_error ?? "",
		lastAttemptUnix: state?.last_attempt_unix ?? 0,
		lastSuccessUnix: state?.last_success_unix ?? 0,
		totalAttempts: state?.total_attempts ?? 0,
		totalFailures: state?.total_failures ?? 0,
		lastFailureKind: state?.last_failure_kind ?? "",
		recentCrashLoops: state?.recent_crash_loops ?? 0,
	};
}

function toPersistedState(state: ProcessHealthState): PersistedProcessHealthState {
	return {
		consecutive_failures: state.consecutiveFailures,
		blocked_until_unix: state.blockedUntilUnix,
		last_error: state.lastError,
		last_attempt_unix: state.lastAttemptUnix,
		last_success_unix: state.lastSuccessUnix,
		total_attempts: state.totalAttempts,
		total_failures: state.totalFailures,
		last_failure_kind: state.lastFailureKind,
		recent_crash_loops: state.recentCrashLoops,
	};
}

function nowUnixSeconds(now: () => number): number {
	return now();
}

function defaultHealthPath(): string {
	const override = process.env[ENV_PROCESS_HEALTH_STATE_FILE];
	if (override) {
		return isAbsolute(override) ? override : join(process.cwd(), override);
	}
	return join(process.cwd(), DEFAULT_PROCESS_STATE_DIR, DEFAULT_PROCESS_HEALTH_STATE_FILE);
}

function normalizePositiveInteger(value: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(1, Math.floor(value));
}

function normalizePositiveNumber(value: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(1, value);
}

export function calculateBackoffDelayMs(attempt: number, policy: BackoffDelayPolicy): number {
	const normalizedAttempt = normalizePositiveInteger(attempt, 1);
	const initialDelayMs = normalizePositiveInteger(policy.initialDelayMs, 1);
	const maxDelayMs = normalizePositiveInteger(policy.maxDelayMs, initialDelayMs);
	const multiplier = 2 ** (normalizedAttempt - 1);
	return Math.min(initialDelayMs * multiplier, maxDelayMs);
}

class JsonProcessHealthStore implements ProcessHealthStore {
	private readonly path: string;
	private readonly inMemory: boolean;
	private readonly now: () => number;
	private memoryPayload: PersistedProcessHealthPayload = {
		version: DEFAULT_PROCESS_HEALTH_VERSION,
		saved_unix: 0,
		health: {},
	};

	constructor(options: ProcessHealthStoreOptions) {
		this.path = options.path ?? defaultHealthPath();
		this.inMemory = options.inMemory ?? false;
		this.now = options.now ?? (() => Date.now() / 1000);
	}

	async getState(processKey: string): Promise<ProcessHealthState | undefined> {
		const payload = await this.loadPayload();
		const state = payload.health?.[processKey];
		return state ? toPublicState(state) : undefined;
	}

	async cooldownRemainingSeconds(processKey: string): Promise<number | null> {
		const state = await this.getState(processKey);
		if (!state) return null;
		const remaining = state.blockedUntilUnix - nowUnixSeconds(this.now);
		return remaining > 0 ? remaining : null;
	}

	async recordAttempt(processKey: string): Promise<ProcessHealthState> {
		return this.updateState(processKey, (state) => {
			state.totalAttempts += 1;
			state.lastAttemptUnix = nowUnixSeconds(this.now);
			return state;
		});
	}

	async recordSuccess(processKey: string): Promise<ProcessHealthState> {
		return this.updateState(processKey, (state) => {
			state.consecutiveFailures = 0;
			state.blockedUntilUnix = 0;
			state.lastSuccessUnix = nowUnixSeconds(this.now);
			state.lastFailureKind = "";
			state.lastError = "";
			state.recentCrashLoops = 0;
			return state;
		});
	}

	async recordFailure(
		processKey: string,
		failureKind: string,
		error: string,
		policy: Pick<CrashBackoffPolicy, "maxConsecutiveFailures" | "cooldownMs">,
	): Promise<ProcessHealthState> {
		return this.updateState(processKey, (state) => {
			const maxConsecutiveFailures = normalizePositiveInteger(policy.maxConsecutiveFailures, 1);
			const cooldownSeconds = normalizePositiveNumber(policy.cooldownMs, 1) / 1000;
			state.consecutiveFailures += 1;
			state.totalFailures += 1;
			state.lastError = error;
			state.lastFailureKind = failureKind;
			if (state.consecutiveFailures >= maxConsecutiveFailures) {
				state.blockedUntilUnix = nowUnixSeconds(this.now) + cooldownSeconds;
				state.recentCrashLoops += 1;
			}
			return state;
		});
	}

	private async updateState(
		processKey: string,
		update: (state: ProcessHealthState) => ProcessHealthState,
	): Promise<ProcessHealthState> {
		const payload = await this.loadPayload();
		const health = payload.health ?? {};
		const next = update(toPublicState(health[processKey]));
		health[processKey] = toPersistedState(next);
		payload.version = DEFAULT_PROCESS_HEALTH_VERSION;
		payload.saved_unix = nowUnixSeconds(this.now);
		payload.health = health;
		await this.savePayload(payload);
		return next;
	}

	private async loadPayload(): Promise<PersistedProcessHealthPayload> {
		if (this.inMemory) return this.memoryPayload;
		try {
			const raw = await readFile(this.path, "utf8");
			const parsed = JSON.parse(raw) as PersistedProcessHealthPayload;
			return {
				version: parsed.version ?? DEFAULT_PROCESS_HEALTH_VERSION,
				saved_unix: parsed.saved_unix ?? 0,
				health: parsed.health ?? {},
			};
		} catch (error) {
			if (
				typeof error === "object" &&
				error !== null &&
				"code" in error &&
				(error.code === "ENOENT" || error.code === "ENOTDIR")
			) {
				return { version: DEFAULT_PROCESS_HEALTH_VERSION, saved_unix: 0, health: {} };
			}
			throw error;
		}
	}

	private async savePayload(payload: PersistedProcessHealthPayload): Promise<void> {
		if (this.inMemory) {
			this.memoryPayload = payload;
			return;
		}
		await mkdir(dirname(this.path), { recursive: true });
		await writeFile(this.path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	}
}

export function createProcessHealthStore(options: ProcessHealthStoreOptions = {}): ProcessHealthStore {
	return new JsonProcessHealthStore(options);
}

function describeProcessExit(result: ProcessRunResult): string {
	if (result.signal) return `signal ${result.signal}`;
	return `exit ${result.code ?? "unknown"}`;
}

function isSuccessfulRun(result: ProcessRunResult): boolean {
	return result.code === 0 && result.signal === null;
}

export async function runWithCrashBackoff(options: RunWithCrashBackoffOptions): Promise<CrashBackoffRunSummary> {
	const maxAttempts = normalizePositiveInteger(options.maxAttempts, 1);
	const stableAfterMs = normalizePositiveInteger(options.stableAfterMs, 1);
	let lastResult: ProcessRunResult | undefined;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const cooldown = await options.store.cooldownRemainingSeconds(options.processKey);
		if (cooldown !== null) {
			return {
				status: "blocked",
				attempts: attempt - 1,
				reason: `cooldown active for ${cooldown.toFixed(1)}s`,
			};
		}

		await options.store.recordAttempt(options.processKey);
		lastResult = await options.runOnce();

		if (isSuccessfulRun(lastResult)) {
			await options.store.recordSuccess(options.processKey);
			return { status: "success", attempts: attempt, lastResult };
		}

		const failureKind = lastResult.runtimeMs < stableAfterMs ? "startup" : "runtime";
		await options.store.recordFailure(options.processKey, failureKind, describeProcessExit(lastResult), options.policy);

		const postFailureCooldown = await options.store.cooldownRemainingSeconds(options.processKey);
		if (postFailureCooldown !== null) {
			return {
				status: "blocked",
				attempts: attempt,
				reason: `cooldown active for ${postFailureCooldown.toFixed(1)}s after ${failureKind} failure`,
			};
		}

		if (attempt < maxAttempts) {
			await options.sleep(calculateBackoffDelayMs(attempt, options.policy));
		}
	}

	return {
		status: "exhausted",
		attempts: maxAttempts,
		reason: `exhausted ${maxAttempts} process attempt(s)`,
		lastResult,
	};
}
