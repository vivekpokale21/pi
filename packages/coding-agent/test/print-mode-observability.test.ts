import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import {
	AssistantTurnPerfLogger,
	compactJsonEvent,
	SystemMetricsLogger,
	shouldWaitForSemanticVectors,
} from "../src/modes/print-observability.ts";

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-print-observability-"));
	tempDirs.push(dir);
	return dir;
}

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hello world" }],
		api: "anthropic-messages",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 120,
			output: 40,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 160,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("print-mode observability", () => {
	it("enables semantic vector warmup only through an explicit env gate", () => {
		expect(shouldWaitForSemanticVectors({})).toBe(false);
		expect(shouldWaitForSemanticVectors({ PI_WAIT_FOR_SEMANTIC_VECTORS: "0" })).toBe(false);
		expect(shouldWaitForSemanticVectors({ PI_WAIT_FOR_SEMANTIC_VECTORS: "1" })).toBe(true);
	});

	it("compacts message_update events without serializing full partial snapshots", () => {
		const fullMessage = assistantMessage({
			content: [{ type: "text", text: "hello ".repeat(1000) }],
		});
		const compact = compactJsonEvent({
			type: "message_update",
			message: fullMessage,
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "ok",
				partial: fullMessage,
			},
		} as AgentSessionEvent);

		expect(compact).toMatchObject({
			type: "message_update",
			role: "assistant",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ok", deltaChars: 2 },
		});
		expect("message" in compact).toBe(false);
		expect("partial" in (compact as { assistantMessageEvent: Record<string, unknown> }).assistantMessageEvent).toBe(
			false,
		);
	});

	it("preserves non-update events including final assistant content", () => {
		const message = assistantMessage();
		const compact = compactJsonEvent({ type: "message_end", message } as AgentSessionEvent);

		expect(compact).toEqual({ type: "message_end", message });
	});

	it("appends one compact assistant turn performance record", () => {
		const dir = tempDir();
		const path = join(dir, "assistant-turns.jsonl");
		const logger = new AssistantTurnPerfLogger({ path, now: () => 1_000 });

		logger.handleEvent({ type: "turn_start", turnIndex: 3, timestamp: 1_000 } as AgentSessionEvent);
		logger.handleEvent({ type: "message_start", message: assistantMessage() } as AgentSessionEvent);
		logger.handleEvent({
			type: "message_update",
			message: assistantMessage({ content: [{ type: "thinking", thinking: "abc" }] }),
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "abc", partial: assistantMessage() },
		} as AgentSessionEvent);
		logger.handleEvent({
			type: "message_update",
			message: assistantMessage(),
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello", partial: assistantMessage() },
		} as AgentSessionEvent);
		logger.handleEvent({
			type: "message_update",
			message: assistantMessage({ content: [{ type: "toolCall", id: "tc_1", name: "read", arguments: {} }] }),
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 0,
				partial: assistantMessage(),
			},
		} as AgentSessionEvent);
		logger.handleEvent({
			type: "message_end",
			message: assistantMessage({
				model: "faux-observed",
				usage: {
					input: 24_000,
					output: 64,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 24_064,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			}),
		} as AgentSessionEvent);

		const line = readFileSync(path, "utf8").trim();
		const record = JSON.parse(line) as Record<string, unknown>;

		expect(record).toMatchObject({
			schemaVersion: 1,
			turnIndex: 3,
			model: "faux-observed",
			wallMs: 0,
			messageUpdateCount: 3,
			deltaChars: 8,
			thinkingChars: 3,
			textChars: 5,
			toolCallCount: 1,
			stopReason: "stop",
			usage: { input: 24000, output: 64, cacheRead: 0, cacheWrite: 0, totalTokens: 24064 },
			estimatedOutputTokens: 64,
			contextTokens: { source: "provider_usage", input: 24000, output: 64, totalBeforeTurn: 24000, band: "16-32k" },
		});
		expect(record).not.toHaveProperty("message");
		expect(record).not.toHaveProperty("prompt");
	});

	it("estimates throughput and context band when usage is unavailable", () => {
		const dir = tempDir();
		const path = join(dir, "assistant-turns.jsonl");
		let now = 10_000;
		const logger = new AssistantTurnPerfLogger({ path, now: () => now });

		logger.handleEvent({ type: "turn_start", turnIndex: 1, timestamp: now } as AgentSessionEvent);
		logger.handleEvent({
			type: "message_update",
			message: assistantMessage(),
			assistantMessageEvent: { type: "text_delta", delta: "x".repeat(400), partial: assistantMessage() },
		} as AgentSessionEvent);
		now = 20_000;
		logger.handleEvent({
			type: "message_end",
			message: assistantMessage({
				content: [{ type: "text", text: "x".repeat(400) }],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			}),
		} as AgentSessionEvent);

		const record = JSON.parse(readFileSync(path, "utf8").trim()) as {
			estimatedOutputTokens: number;
			estimatedTokensPerSecond: number;
			contextTokens: { source: string; band: string };
		};

		expect(record.estimatedOutputTokens).toBe(100);
		expect(record.estimatedTokensPerSecond).toBe(10);
		expect(record.contextTokens).toMatchObject({ source: "estimated_chars", band: "0-16k" });
	});

	it("writes failure-tolerant system metric samples without requiring nvidia-smi", () => {
		const dir = tempDir();
		const path = join(dir, "system-metrics.jsonl");
		const perfPath = join(dir, "assistant-turns.jsonl");
		writeFileSync(perfPath, "previous\n", "utf8");
		const logger = new SystemMetricsLogger({
			path,
			now: () => new Date("2026-08-26T13:24:19.442Z"),
			sampleSystem: () => ({
				warnings: ["nvidia-smi unavailable"],
				processes: [{ pid: process.pid, rssMb: 12, cpuPct: 3.5 }],
				gpu: [],
			}),
			getSemanticVectorStatus: () => "building",
			logPaths: { assistantPerfLog: perfPath },
		});

		logger.sample("assistant_turn_start", { turnIndex: 2 });

		const record = JSON.parse(readFileSync(path, "utf8").trim()) as Record<string, unknown>;
		expect(record).toMatchObject({
			schemaVersion: 1,
			timestamp: "2026-08-26T13:24:19.442Z",
			phase: "assistant_turn_start",
			turnIndex: 2,
			systemWarnings: ["nvidia-smi unavailable"],
			processes: [{ pid: process.pid, rssMb: 12, cpuPct: 3.5 }],
			gpu: [],
			semanticVectorStatus: "building",
		});
		expect(record.assistantPerfLogBytes).toBe(statSync(perfPath).size);
		expect(existsSync(path)).toBe(true);
	});

	it("samples handoff continuation lifecycle events", () => {
		const dir = tempDir();
		const path = join(dir, "system-metrics.jsonl");
		const logger = new SystemMetricsLogger({
			path,
			now: () => new Date("2026-09-10T00:00:00.000Z"),
			sampleSystem: () => ({ processes: [], gpu: [] }),
			getProcessIds: () => [],
		});

		logger.handleEvent({
			type: "context_handoff_required",
			band: "handoff_required",
			originalGoal: "Continue native workflow.",
			sourceProfile: "planner",
		});
		logger.handleEvent({
			type: "context_handoff_written",
			handoffPath: ".pi/handoffs/continue.md",
			profile: "planner",
			title: "Continue",
			bytes: 1234,
			sourceProfile: "planner",
		});
		logger.handleEvent({
			type: "context_handoff_resume_started",
			handoffPath: ".pi/handoffs/continue.md",
			transition: "planner_to_executor",
		});
		logger.handleEvent({
			type: "context_handoff_resume_completed",
			handoffPath: ".pi/handoffs/continue.md",
			transition: "planner_to_executor",
		});
		logger.handleEvent({
			type: "context_handoff_resume_failed",
			handoffPath: ".pi/handoffs/continue.md",
			transition: "planner_to_executor",
			error: "validation failed",
		});

		const records = readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);

		expect(records.map((record) => record.phase)).toEqual([
			"context_handoff_required",
			"context_handoff_written",
			"context_handoff_resume_started",
			"context_handoff_resume_completed",
			"context_handoff_resume_failed",
		]);
		expect(records[1]).toMatchObject({
			handoffPath: ".pi/handoffs/continue.md",
			profile: "planner",
			bytes: 1234,
		});
		expect(records[4]).toMatchObject({ error: "validation failed" });
	});
});
