import { Agent } from "@earendil-works/pi-agent-core";
import {
	type Api,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, test } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

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
});
