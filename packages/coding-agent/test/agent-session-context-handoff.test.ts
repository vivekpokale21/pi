import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type Api,
	contentText,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, test } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createGoalStore } from "../src/core/goal-state.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createHarness, type Harness } from "./suite/harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

const tempDirs: string[] = [];
const harnesses: Harness[] = [];

function tempDir(): string {
	const path = mkdtempSync(join(tmpdir(), "pi-agent-session-handoff-"));
	tempDirs.push(path);
	return path;
}

afterEach(() => {
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
	for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function completeHandoff(): string {
	return [
		"# Planner Handoff: Continue native workflow",
		"",
		"Created: 2026-08-23T10:11:12.000Z",
		"Profile: planner",
		"",
		"## Goal",
		"Continue the native planner/executor handoff workflow.",
		"",
		"## Non-Goals",
		"- Do not use the legacy migration harness.",
		"",
		"## Files Inspected",
		"- packages/coding-agent/src/core/tools/handoff.ts",
		"",
		"## Current Facts With Provenance",
		"- handoff.ts writes structured Markdown under .pi/handoffs/.",
		"",
		"## Decisions",
		"- Keep the workflow native.",
		"",
		"## Plan Steps",
		"- Implement same-session continuation injection.",
		"",
		"## Verification Commands",
		"- node node_modules/vitest/dist/cli.js --run test/agent-session-context-handoff.test.ts",
		"",
		"## Stale-State Checks",
		"- Run git status before editing.",
		"",
		"## Risks",
		"- Handoff facts may be stale.",
		"",
		"## Stop Conditions",
		"- Stop if files no longer match the handoff.",
		"",
		"## Unexplored Items",
		"- Print-mode continuation.",
		"",
		"## Completed Work",
		"- Goal store exists.",
		"",
		"## Next Slice",
		"- Implement the AgentSession continuation method.",
		"",
	].join("\n");
}

function appendAssistantUsage(sessionManager: SessionManager, model: Model<Api>, tokens: number): void {
	sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "usage sample" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: tokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: tokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now() - 1000,
	});
}

function hasContextBudgetReminder(messages: Message[], phrase: string): boolean {
	return messages.some((message) => {
		if (message.role !== "user") {
			return false;
		}
		const content = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
		return content.some(
			(part) => part.type === "text" && part.text.includes("Context budget reminder") && part.text.includes(phrase),
		);
	});
}

function countContextBudgetReminders(messages: Message[]): number {
	let count = 0;
	for (const message of messages) {
		if (message.role !== "user") {
			continue;
		}
		const content = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
		for (const part of content) {
			if (part.type === "text" && part.text.includes("Context budget reminder")) {
				count += 1;
			}
		}
	}
	return count;
}

describe("AgentSession context handoff reminders", () => {
	test("enables the native handoff tools by default", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const session = new AgentSession({
			agent: new Agent({
				streamFn: () => createAssistantMessageEventStream(),
				initialState: {
					model,
					systemPrompt: "Test",
					tools: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.inMemory(),
			cwd: process.cwd(),
			modelRuntime: getModelRuntime(await createInMemoryModelRegistry(authStorage)),
			resourceLoader: createTestResourceLoader(),
		});

		try {
			expect(session.getActiveToolNames()).toContain("handoff");
			expect(session.getActiveToolNames()).toContain("handoff_status");
			expect(session.systemPrompt).toContain("- handoff:");
			expect(session.systemPrompt).toContain("- handoff_status:");
		} finally {
			session.dispose();
		}
	});

	test("injects a native context budget reminder before the next user turn", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));

		let capturedMessages: Message[] = [];
		const agent = new Agent({
			streamFn: (streamModel, context) => {
				capturedMessages = context.messages;
				const stream = createAssistantMessageEventStream();
				void Promise.resolve().then(() => {
					stream.push({
						type: "done",
						reason: "stop",
						message: {
							...fauxAssistantMessage("done"),
							api: streamModel.api,
							provider: streamModel.provider,
							model: streamModel.id,
						},
					});
				});
				return stream;
			},
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager: SettingsManager.inMemory(),
			cwd: process.cwd(),
			modelRuntime: getModelRuntime(await createInMemoryModelRegistry(authStorage)),
			resourceLoader: createTestResourceLoader(),
		});

		try {
			const contextWindow = model.contextWindow ?? 200_000;
			appendAssistantUsage(sessionManager, model, Math.floor(contextWindow * 0.82));
			session.agent.state.messages = sessionManager.buildSessionContext().messages;

			await session.prompt("continue");

			expect(hasContextBudgetReminder(capturedMessages, "start writing a handoff")).toBe(true);
		} finally {
			session.dispose();
		}
	});

	test("dedupes reminders until context enters a stricter band", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));

		const capturedRuns: Message[][] = [];
		const agent = new Agent({
			streamFn: (streamModel, context) => {
				capturedRuns.push(context.messages);
				const stream = createAssistantMessageEventStream();
				void Promise.resolve().then(() => {
					stream.push({
						type: "done",
						reason: "stop",
						message: {
							...fauxAssistantMessage("done"),
							api: streamModel.api,
							provider: streamModel.provider,
							model: streamModel.id,
						},
					});
				});
				return stream;
			},
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager: SettingsManager.inMemory(),
			cwd: process.cwd(),
			modelRuntime: getModelRuntime(await createInMemoryModelRegistry(authStorage)),
			resourceLoader: createTestResourceLoader(),
		});

		try {
			const contextWindow = model.contextWindow ?? 200_000;
			appendAssistantUsage(sessionManager, model, Math.floor(contextWindow * 0.82));
			session.agent.state.messages = sessionManager.buildSessionContext().messages;

			await session.prompt("first low-context turn");
			await session.prompt("same low-context turn");

			appendAssistantUsage(sessionManager, model, Math.floor(contextWindow * 0.86));
			session.agent.state.messages = sessionManager.buildSessionContext().messages;

			await session.prompt("stricter low-context turn");

			expect(countContextBudgetReminders(capturedRuns[0] ?? [])).toBe(1);
			expect(countContextBudgetReminders(capturedRuns[1] ?? [])).toBe(1);
			expect(countContextBudgetReminders(capturedRuns[2] ?? [])).toBe(2);
			expect(hasContextBudgetReminder(capturedRuns[0] ?? [], "start writing a handoff")).toBe(true);
			expect(hasContextBudgetReminder(capturedRuns[2] ?? [], "Do not start new exploration")).toBe(true);
		} finally {
			session.dispose();
		}
	});

	test("records resume intent when context reaches the handoff-required band under an active goal", async () => {
		const cwd = tempDir();
		await createGoalStore(cwd).start({ objective: "Continue native workflow." });

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const sessionManager = SessionManager.inMemory(cwd);
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));

		const agent = new Agent({
			streamFn: (streamModel) => {
				const stream = createAssistantMessageEventStream();
				void Promise.resolve().then(() => {
					stream.push({
						type: "done",
						reason: "stop",
						message: {
							...fauxAssistantMessage("done"),
							api: streamModel.api,
							provider: streamModel.provider,
							model: streamModel.id,
						},
					});
				});
				return stream;
			},
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager: SettingsManager.inMemory(),
			cwd,
			modelRuntime: getModelRuntime(await createInMemoryModelRegistry(authStorage)),
			resourceLoader: createTestResourceLoader(),
		});

		try {
			const events: string[] = [];
			const unsubscribe = session.subscribe((event) => {
				events.push(event.type);
			});
			const contextWindow = model.contextWindow ?? 200_000;
			appendAssistantUsage(sessionManager, model, Math.floor(contextWindow * 0.86));
			session.agent.state.messages = sessionManager.buildSessionContext().messages;

			await session.prompt("continue next broad slice");

			expect(session.getPendingHandoffContinuationIntent()).toMatchObject({
				band: "handoff_required",
				originalGoal: "Continue native workflow.",
				sourceProfile: "planner",
			});
			expect(events).toContain("context_handoff_required");
			unsubscribe();
		} finally {
			session.dispose();
		}
	});

	test("emits a compact event when the handoff tool writes a continuation artifact", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await createGoalStore(harness.tempDir).start({ objective: "Continue native workflow." });
		const contextWindow = harness.getModel().contextWindow ?? 128_000;
		appendAssistantUsage(harness.sessionManager, harness.getModel(), Math.floor(contextWindow * 0.86));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("handoff", {
					profile: "planner",
					title: "Continue Native Workflow",
					goal: "Continue the native planner/executor handoff workflow.",
					nonGoals: ["Do not use the legacy migration harness."],
					inspectedFiles: ["packages/coding-agent/src/core/agent-session.ts"],
					facts: ["AgentSession emits events for tool execution."],
					decisions: ["Keep orchestration in AgentSession."],
					plan: ["Implement handoff write event tracking."],
					verification: ["node node_modules/vitest/dist/cli.js --run test/agent-session-context-handoff.test.ts"],
					staleStateChecks: ["Run git status before editing."],
					risks: ["Handoff facts may be stale."],
					stopConditions: ["Stop if validation fails."],
					unexplored: ["Print mode wiring."],
					completed: ["Goal boundary exists."],
					nextSlice: ["Implement event tracking."],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("handoff written"),
		]);

		await harness.session.prompt("write handoff");

		expect(harness.eventsOfType("context_handoff_written")).toEqual([
			expect.objectContaining({
				handoffPath: expect.stringMatching(/^\.pi\/handoffs\/.*continue-native-workflow\.md$/),
				profile: "planner",
				bytes: expect.any(Number),
			}),
		]);
		expect(harness.session.getPendingHandoffContinuationIntent()?.sourceProfile).toBe("planner");
	});

	test("injects handoff continuation into a fresh same-session model context", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));

		const capturedRuns: Message[][] = [];
		const agent = new Agent({
			streamFn: (streamModel, context) => {
				capturedRuns.push(context.messages);
				const stream = createAssistantMessageEventStream();
				void Promise.resolve().then(() => {
					stream.push({
						type: "done",
						reason: "stop",
						message: {
							...fauxAssistantMessage("done"),
							api: streamModel.api,
							provider: streamModel.provider,
							model: streamModel.id,
						},
					});
				});
				return stream;
			},
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager: SettingsManager.inMemory(),
			cwd: process.cwd(),
			modelRuntime: getModelRuntime(await createInMemoryModelRegistry(authStorage)),
			resourceLoader: createTestResourceLoader(),
		});

		try {
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "old context that should be cached on disk only" }],
				timestamp: Date.now() - 2000,
			});
			session.agent.state.messages = sessionManager.buildSessionContext().messages;

			session.injectHandoffContinuationContext({
				prompt: "Continue from validated handoff content.",
				handoffPath: ".pi/handoffs/continue.md",
				transition: "planner_to_executor",
			});
			await session.prompt("continue");

			const messages = capturedRuns[0] ?? [];
			const text = messages.map((message) => contentText(message.content, "")).join("\n");

			expect(text).toContain("Continue from validated handoff content.");
			expect(text).not.toContain("old context that should be cached on disk only");
			expect(
				sessionManager
					.buildContextEntries()
					.slice(0, 2)
					.map((entry) => entry.type),
			).toEqual(["compaction", "custom_message"]);
		} finally {
			session.dispose();
		}
	});

	test("validates goal-bounded handoff and resets context in the same session", async () => {
		const cwd = tempDir();
		mkdirSync(join(cwd, ".pi/handoffs"), { recursive: true });
		writeFileSync(join(cwd, ".pi/handoffs/continue.md"), completeHandoff(), "utf8");
		await createGoalStore(cwd).start({ objective: "Continue native workflow." });

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const sessionManager = SessionManager.inMemory(cwd);
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));

		const capturedRuns: Message[][] = [];
		const agent = new Agent({
			streamFn: (streamModel, context) => {
				capturedRuns.push(context.messages);
				const stream = createAssistantMessageEventStream();
				void Promise.resolve().then(() => {
					stream.push({
						type: "done",
						reason: "stop",
						message: {
							...fauxAssistantMessage("done"),
							api: streamModel.api,
							provider: streamModel.provider,
							model: streamModel.id,
						},
					});
				});
				return stream;
			},
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager: SettingsManager.inMemory(),
			cwd,
			modelRuntime: getModelRuntime(await createInMemoryModelRegistry(authStorage)),
			resourceLoader: createTestResourceLoader(),
		});

		try {
			const events: string[] = [];
			const unsubscribe = session.subscribe((event) => {
				events.push(event.type);
			});
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "old transcript only" }],
				timestamp: Date.now() - 2000,
			});
			session.agent.state.messages = sessionManager.buildSessionContext().messages;

			const result = await session.continueFromHandoff({
				handoffPath: ".pi/handoffs/continue.md",
				originalGoal: "Continue native workflow.",
			});
			await session.prompt("continue");

			const text = capturedRuns
				.flat()
				.map((message) => contentText(message.content, ""))
				.join("\n");

			expect(result.transition).toBe("planner_to_executor");
			expect(text).toContain("Continuation path: planner -> executor.");
			expect(text).toContain("# Planner Handoff: Continue native workflow");
			expect(text).not.toContain("old transcript only");
			expect(events).toContain("context_handoff_resume_started");
			expect(events).toContain("context_handoff_resume_completed");
			unsubscribe();
		} finally {
			session.dispose();
		}
	});

	test("rejects reusing a consumed handoff path in the same session", async () => {
		const cwd = tempDir();
		mkdirSync(join(cwd, ".pi/handoffs"), { recursive: true });
		writeFileSync(join(cwd, ".pi/handoffs/continue.md"), completeHandoff(), "utf8");
		await createGoalStore(cwd).start({ objective: "Continue native workflow." });

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const sessionManager = SessionManager.inMemory(cwd);
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));

		const agent = new Agent({
			streamFn: (streamModel) => {
				const stream = createAssistantMessageEventStream();
				void Promise.resolve().then(() => {
					stream.push({
						type: "done",
						reason: "stop",
						message: {
							...fauxAssistantMessage("done"),
							api: streamModel.api,
							provider: streamModel.provider,
							model: streamModel.id,
						},
					});
				});
				return stream;
			},
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager: SettingsManager.inMemory(),
			cwd,
			modelRuntime: getModelRuntime(await createInMemoryModelRegistry(authStorage)),
			resourceLoader: createTestResourceLoader(),
		});

		try {
			await session.continueFromHandoff({
				handoffPath: ".pi/handoffs/continue.md",
				originalGoal: "Continue native workflow.",
			});

			await expect(
				session.continueFromHandoff({
					handoffPath: ".pi/handoffs/continue.md",
					originalGoal: "Continue native workflow.",
				}),
			).rejects.toThrow("Handoff has already been consumed for continuation");
		} finally {
			session.dispose();
		}
	});
});
