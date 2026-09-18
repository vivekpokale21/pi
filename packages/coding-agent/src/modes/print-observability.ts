import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall, Usage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "../core/agent-session.ts";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import type { WorkspaceSemanticVectorStatus } from "../core/workspace-semantic-index.ts";

const CHARS_PER_TOKEN_ESTIMATE = 4;
const DEFAULT_METRICS_INTERVAL_MS = 30_000;

type Now = () => number | Date;

interface CompactMessageUpdateEvent {
	type: "message_update";
	role?: string;
	provider?: string;
	model?: string;
	stopReason?: string;
	assistantMessageEvent: Record<string, unknown>;
}

export function compactJsonEvent(event: AgentSessionEvent): AgentSessionEvent | CompactMessageUpdateEvent {
	if (event.type !== "message_update") return event;
	const assistantEvent = event.assistantMessageEvent as Record<string, unknown>;
	const compactAssistantEvent: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(assistantEvent)) {
		if (key === "partial" || key === "message") continue;
		compactAssistantEvent[key] = value;
	}
	if (typeof compactAssistantEvent.delta === "string") {
		compactAssistantEvent.deltaChars = compactAssistantEvent.delta.length;
	}
	const message = event.message as Partial<AssistantMessage>;
	return {
		type: "message_update",
		role: message.role,
		provider: message.provider,
		model: message.model,
		stopReason: message.stopReason,
		assistantMessageEvent: compactAssistantEvent,
	};
}

function nowMs(now: Now): number {
	const value = now();
	return value instanceof Date ? value.getTime() : value;
}

function nowIso(now: Now): string {
	const value = now();
	return (value instanceof Date ? value : new Date(value)).toISOString();
}

function appendJsonLine(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

function textChars(message: AssistantMessage): number {
	return message.content.reduce((sum, content) => {
		if (content.type === "text") return sum + content.text.length;
		if (content.type === "thinking") return sum + content.thinking.length;
		if (content.type === "toolCall")
			return sum + content.name.length + JSON.stringify(content.arguments ?? {}).length;
		return sum;
	}, 0);
}

function messageAggregateChars(message: AgentMessage): number {
	if (message.role === "assistant") return textChars(message);
	const content = (message as AgentMessage & { content?: unknown }).content;
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	return content.reduce((sum, part) => {
		if (!part || typeof part !== "object") return sum;
		const record = part as Record<string, unknown>;
		if (typeof record.text === "string") return sum + record.text.length;
		if (typeof record.content === "string") return sum + record.content.length;
		return sum;
	}, 0);
}

function usageHasTokens(usage: Usage | undefined): usage is Usage {
	return (
		!!usage &&
		[usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens].some((value) => value > 0)
	);
}

function estimateTokens(chars: number): number {
	return Math.max(0, Math.round(chars / CHARS_PER_TOKEN_ESTIMATE));
}

export function contextBand(tokens: number): "0-16k" | "16-32k" | "32-64k" | "64-96k" | "96-128k" | "128k+" {
	if (tokens < 16_384) return "0-16k";
	if (tokens < 32_768) return "16-32k";
	if (tokens < 65_536) return "32-64k";
	if (tokens < 98_304) return "64-96k";
	if (tokens < 131_072) return "96-128k";
	return "128k+";
}

export function shouldWaitForSemanticVectors(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.PI_WAIT_FOR_SEMANTIC_VECTORS === "1";
}

interface AssistantTurnState {
	turnIndex?: number;
	startMs: number;
	startTime: string;
	messageUpdateCount: number;
	deltaChars: number;
	thinkingChars: number;
	textChars: number;
	toolCallCount: number;
	toolCallIds: Set<string>;
	contextCharsBeforeTurn: number;
}

export interface AssistantTurnPerfLoggerOptions {
	path: string;
	sessionId?: string;
	now?: Now;
}

export class AssistantTurnPerfLogger {
	private readonly path: string;
	private readonly sessionId: string | undefined;
	private readonly now: Now;
	private currentTurnIndex: number | undefined;
	private conversationChars = 0;
	private active?: AssistantTurnState;

	constructor(options: AssistantTurnPerfLoggerOptions) {
		this.path = options.path;
		this.sessionId = options.sessionId;
		this.now = options.now ?? Date.now;
	}

	handleEvent(event: AgentSessionEvent): void {
		if (event.type === "turn_start") {
			this.currentTurnIndex = (event as { turnIndex?: number }).turnIndex;
			return;
		}
		if (event.type === "message_start" && event.message.role === "assistant") {
			this.startTurn();
			return;
		}
		if (event.type === "message_update") {
			this.handleMessageUpdate(event);
			return;
		}
		if (event.type === "message_end") {
			this.handleMessageEnd(event.message);
		}
	}

	private startTurn(): AssistantTurnState {
		if (this.active) return this.active;
		const ms = nowMs(this.now);
		const state: AssistantTurnState = {
			turnIndex: this.currentTurnIndex,
			startMs: ms,
			startTime: new Date(ms).toISOString(),
			messageUpdateCount: 0,
			deltaChars: 0,
			thinkingChars: 0,
			textChars: 0,
			toolCallCount: 0,
			toolCallIds: new Set(),
			contextCharsBeforeTurn: this.conversationChars,
		};
		this.active = state;
		return state;
	}

	private handleMessageUpdate(event: Extract<AgentSessionEvent, { type: "message_update" }>): void {
		if (event.message.role !== "assistant") return;
		const state = this.startTurn();
		state.messageUpdateCount++;
		const assistantEvent = event.assistantMessageEvent as Record<string, unknown>;
		const delta = typeof assistantEvent.delta === "string" ? assistantEvent.delta : "";
		state.deltaChars += delta.length;
		if (assistantEvent.type === "thinking_delta") state.thinkingChars += delta.length;
		if (assistantEvent.type === "text_delta") state.textChars += delta.length;
		if (assistantEvent.type === "toolcall_start" || assistantEvent.type === "toolcall_end") {
			const toolCall = assistantEvent.toolCall as Partial<ToolCall> | undefined;
			const id = toolCall?.id ?? `${assistantEvent.contentIndex ?? state.toolCallCount}`;
			if (!state.toolCallIds.has(id)) {
				state.toolCallIds.add(id);
				state.toolCallCount++;
			}
		}
	}

	private handleMessageEnd(message: AgentMessage): void {
		if (message.role !== "assistant") {
			this.conversationChars += messageAggregateChars(message);
			return;
		}
		const assistantMessage = message as AssistantMessage;
		const state = this.startTurn();
		const endMs = nowMs(this.now);
		const wallMs = Math.max(0, endMs - state.startMs);
		const outputTokens = usageHasTokens(assistantMessage.usage)
			? assistantMessage.usage.output
			: estimateTokens(Math.max(state.deltaChars, textChars(assistantMessage)));
		const inputTokens = usageHasTokens(assistantMessage.usage)
			? assistantMessage.usage.input + assistantMessage.usage.cacheRead + assistantMessage.usage.cacheWrite
			: estimateTokens(state.contextCharsBeforeTurn);
		const usage = assistantMessage.usage;
		const record = {
			schemaVersion: 1,
			...(this.sessionId ? { sessionId: this.sessionId } : {}),
			turnIndex: state.turnIndex,
			model: assistantMessage.model,
			responseId:
				(assistantMessage as AssistantMessage & { id?: string; responseId?: string }).responseId ??
				(assistantMessage as AssistantMessage & { id?: string; responseId?: string }).id,
			startTime: state.startTime,
			endTime: new Date(endMs).toISOString(),
			wallMs,
			messageUpdateCount: state.messageUpdateCount,
			deltaChars: state.deltaChars,
			thinkingChars: state.thinkingChars,
			textChars: state.textChars,
			toolCallCount: Math.max(
				state.toolCallCount,
				assistantMessage.content.filter((content) => content.type === "toolCall").length,
			),
			estimatedOutputTokens: outputTokens,
			estimatedTokensPerSecond: wallMs > 0 ? Number((outputTokens / (wallMs / 1000)).toFixed(3)) : undefined,
			stopReason: assistantMessage.stopReason,
			usage,
			contextTokens: {
				source: usageHasTokens(assistantMessage.usage) ? "provider_usage" : "estimated_chars",
				input: inputTokens,
				output: outputTokens,
				totalBeforeTurn: inputTokens,
				band: contextBand(inputTokens),
			},
			throughput: {
				wallMs,
				estimatedOutputTokens: outputTokens,
				estimatedTokensPerSecond: wallMs > 0 ? Number((outputTokens / (wallMs / 1000)).toFixed(3)) : undefined,
			},
		};
		appendJsonLine(this.path, record);
		this.conversationChars += textChars(assistantMessage);
		this.active = undefined;
	}
}

export interface ProcessMetrics {
	pid: number;
	rssMb?: number;
	cpuPct?: number;
}

export interface GpuMetrics {
	index: number;
	name?: string;
	memoryUsedMb?: number;
	memoryTotalMb?: number;
	utilizationGpuPct?: number;
	utilizationMemoryPct?: number;
}

export interface SystemMetricsSnapshot {
	processes: ProcessMetrics[];
	gpu: GpuMetrics[];
	warnings?: string[];
}

export interface SystemMetricsLoggerOptions {
	path: string;
	now?: Now;
	sampleSystem?: (pids: number[]) => SystemMetricsSnapshot;
	getProcessIds?: () => Array<number | undefined>;
	getSemanticVectorStatus?: () => WorkspaceSemanticVectorStatus | undefined;
	logPaths?: {
		rawEventLog?: string;
		assistantPerfLog?: string;
	};
	intervalMs?: number;
}

export class SystemMetricsLogger {
	private readonly path: string;
	private readonly now: Now;
	private readonly sampleSystem: (pids: number[]) => SystemMetricsSnapshot;
	private readonly getProcessIds: () => Array<number | undefined>;
	private readonly getSemanticVectorStatus: () => WorkspaceSemanticVectorStatus | undefined;
	private readonly logPaths: SystemMetricsLoggerOptions["logPaths"];
	private readonly intervalMs: number;
	private interval: ReturnType<typeof setInterval> | undefined;
	private currentTurnIndex: number | undefined;

	constructor(options: SystemMetricsLoggerOptions) {
		this.path = options.path;
		this.now = options.now ?? (() => new Date());
		this.sampleSystem = options.sampleSystem ?? defaultSampleSystem;
		this.getProcessIds = options.getProcessIds ?? (() => [process.pid]);
		this.getSemanticVectorStatus = options.getSemanticVectorStatus ?? (() => undefined);
		this.logPaths = options.logPaths;
		this.intervalMs = Math.max(1, options.intervalMs ?? DEFAULT_METRICS_INTERVAL_MS);
	}

	handleEvent(event: AgentSessionEvent): void {
		if (event.type === "turn_start") {
			this.currentTurnIndex = (event as { turnIndex?: number }).turnIndex;
			return;
		}
		if (event.type === "local_model_runtime_state" && event.state.value === "ready") {
			this.sample("model_ready", { modelRuntimeState: event.state });
			return;
		}
		if (event.type === "message_start" && event.message.role === "assistant") {
			this.sample("assistant_turn_start", { turnIndex: this.currentTurnIndex });
			this.startPeriodic();
			return;
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			this.stopPeriodic();
			this.sample("assistant_turn_end", { turnIndex: this.currentTurnIndex });
			return;
		}
		if (event.type === "tool_execution_start") {
			this.sample("tool_phase_start", { turnIndex: this.currentTurnIndex, toolName: event.toolName });
			return;
		}
		if (event.type === "tool_execution_end") {
			this.sample("tool_phase_end", {
				turnIndex: this.currentTurnIndex,
				toolName: event.toolName,
				isError: event.isError,
			});
			return;
		}
		if (event.type === "context_handoff_required") {
			this.sample(event.type, {
				turnIndex: this.currentTurnIndex,
				band: event.band,
				sourceProfile: event.sourceProfile,
			});
			return;
		}
		if (event.type === "context_handoff_written") {
			this.sample(event.type, {
				turnIndex: this.currentTurnIndex,
				handoffPath: event.handoffPath,
				profile: event.profile,
				sourceProfile: event.sourceProfile,
				bytes: event.bytes,
			});
			return;
		}
		if (
			event.type === "context_handoff_resume_started" ||
			event.type === "context_handoff_resume_completed" ||
			event.type === "context_handoff_resume_failed"
		) {
			this.sample(event.type, {
				turnIndex: this.currentTurnIndex,
				handoffPath: event.handoffPath,
				transition: event.transition,
				...(event.type === "context_handoff_resume_failed" ? { error: event.error } : {}),
			});
		}
	}

	sample(phase: string, extra: Record<string, unknown> = {}): void {
		const pids = [
			...new Set(
				this.getProcessIds().filter(
					(pid): pid is number => typeof pid === "number" && Number.isInteger(pid) && pid > 0,
				),
			),
		];
		const snapshot = this.sampleSystem(pids);
		appendJsonLine(this.path, {
			schemaVersion: 1,
			timestamp: nowIso(this.now),
			phase,
			...extra,
			processes: snapshot.processes,
			gpu: snapshot.gpu,
			systemWarnings: snapshot.warnings,
			rawEventLogBytes: statSize(this.logPaths?.rawEventLog),
			assistantPerfLogBytes: statSize(this.logPaths?.assistantPerfLog),
			systemMetricsLogBytes: statSize(this.path),
			semanticVectorStatus: this.getSemanticVectorStatus(),
		});
	}

	dispose(): void {
		this.stopPeriodic();
	}

	private startPeriodic(): void {
		if (this.interval) return;
		this.interval = setInterval(() => {
			this.sample("assistant_turn_progress", { turnIndex: this.currentTurnIndex });
		}, this.intervalMs);
		this.interval.unref?.();
	}

	private stopPeriodic(): void {
		if (!this.interval) return;
		clearInterval(this.interval);
		this.interval = undefined;
	}
}

function statSize(path: string | undefined): number | undefined {
	if (!path) return undefined;
	try {
		return statSync(path).size;
	} catch {
		return undefined;
	}
}

function readProcStatus(pid: number): Pick<ProcessMetrics, "rssMb"> {
	try {
		const status = readFileSync(`/proc/${pid}/status`, "utf8");
		const rssKb = status.match(/^VmRSS:\s+(\d+)\s+kB$/mu)?.[1];
		return rssKb ? { rssMb: Number((Number(rssKb) / 1024).toFixed(1)) } : {};
	} catch {
		return {};
	}
}

function readPs(pid: number): Pick<ProcessMetrics, "cpuPct" | "rssMb"> {
	try {
		const output = execFileSync("ps", ["-p", String(pid), "-o", "%cpu=,rss="], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		const [cpu, rss] = output.split(/\s+/u);
		return {
			cpuPct: cpu ? Number(cpu) : undefined,
			rssMb: rss ? Number((Number(rss) / 1024).toFixed(1)) : undefined,
		};
	} catch {
		return {};
	}
}

function readGpuMetrics(): { gpu: GpuMetrics[]; warning?: string } {
	try {
		const output = execFileSync(
			"nvidia-smi",
			[
				"--query-gpu=index,name,memory.used,memory.total,utilization.gpu,utilization.memory",
				"--format=csv,noheader,nounits",
			],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		).trim();
		if (!output) return { gpu: [] };
		return {
			gpu: output.split(/\r?\n/u).map((line) => {
				const [index, name, memoryUsed, memoryTotal, gpuUtil, memoryUtil] = line
					.split(",")
					.map((part) => part.trim());
				return {
					index: Number(index),
					name,
					memoryUsedMb: Number(memoryUsed),
					memoryTotalMb: Number(memoryTotal),
					utilizationGpuPct: Number(gpuUtil),
					utilizationMemoryPct: Number(memoryUtil),
				};
			}),
		};
	} catch {
		return { gpu: [], warning: "nvidia-smi unavailable" };
	}
}

function defaultSampleSystem(pids: number[]): SystemMetricsSnapshot {
	const warnings: string[] = [];
	const processes = pids.map((pid) => ({ pid, ...readPs(pid), ...readProcStatus(pid) }));
	const gpu = readGpuMetrics();
	if (gpu.warning) warnings.push(gpu.warning);
	return { processes, gpu: gpu.gpu, warnings };
}

function absoluteEnvPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
	const path = env[name]?.trim();
	if (!path) return undefined;
	if (isAbsolute(path)) return path;
	console.error(`${name} must be an absolute path; observability sidecar disabled.`);
	return undefined;
}

export function createPrintObservabilityFromEnv(
	runtimeHost: AgentSessionRuntime,
	env: NodeJS.ProcessEnv = process.env,
): {
	perfLogger?: AssistantTurnPerfLogger;
	systemMetricsLogger?: SystemMetricsLogger;
	compactJson: boolean;
	waitForSemanticVectors: boolean;
	dispose: () => void;
} {
	const perfPath = absoluteEnvPath("PI_ASSISTANT_PERF_LOG", env);
	const metricsPath = absoluteEnvPath("PI_SYSTEM_METRICS_LOG", env);
	const perfLogger = perfPath
		? new AssistantTurnPerfLogger({
				path: perfPath,
				sessionId: runtimeHost.session.sessionFile,
			})
		: undefined;
	const systemMetricsLogger = metricsPath
		? new SystemMetricsLogger({
				path: metricsPath,
				getProcessIds: () => [
					runtimeHost.services.modelRuntime.getLocalModelRuntimeProcessId?.(),
					runtimeHost.services.embeddingRuntime?.getProcessId?.(),
				],
				getSemanticVectorStatus: () => runtimeHost.services.semanticIndex.vectorStatus,
				logPaths: {
					assistantPerfLog: perfPath,
				},
			})
		: undefined;
	if (systemMetricsLogger) {
		const state = runtimeHost.services.modelRuntime.getLocalModelRuntimeState?.();
		systemMetricsLogger.sample(state?.value === "ready" ? "model_ready" : "startup", {
			...(state ? { modelRuntimeState: state } : {}),
		});
	}
	return {
		perfLogger,
		systemMetricsLogger,
		compactJson: env.PI_JSON_EVENT_COMPACT === "1",
		waitForSemanticVectors: shouldWaitForSemanticVectors(env),
		dispose: () => {
			systemMetricsLogger?.dispose();
		},
	};
}
