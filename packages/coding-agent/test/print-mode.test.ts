import { type AssistantMessage, type Context, contentText, type ImageContent, type Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoalStore } from "../src/core/goal-state.ts";
import type { SessionShutdownEvent } from "../src/index.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

type EmitEvent = SessionShutdownEvent;

type FakeExtensionRunner = {
	hasHandlers: (eventType: string) => boolean;
	emit: ReturnType<typeof vi.fn<(event: EmitEvent) => Promise<void>>>;
};

type FakeSession = {
	sessionManager: { getHeader: () => object | undefined };
	agent: { waitForIdle: () => Promise<void> };
	state: { messages: AssistantMessage[] };
	extensionRunner: FakeExtensionRunner;
	bindExtensions: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
};

type FakeRuntimeHost = {
	session: FakeSession;
	newSession: ReturnType<typeof vi.fn>;
	fork: ReturnType<typeof vi.fn>;
	switchSession: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	setRebindSession: ReturnType<typeof vi.fn>;
};

type HarnessRuntimeHost = {
	session: Harness["session"];
	services: {
		semanticIndex: {
			ready: Promise<void>;
			vectorsReady: Promise<void>;
			vectorStatus: "ready";
		};
		modelRuntime: {
			getLocalModelRuntimeProcessId: () => undefined;
			getLocalModelRuntimeState: () => undefined;
		};
	};
	newSession: ReturnType<typeof vi.fn>;
	fork: ReturnType<typeof vi.fn>;
	switchSession: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	setRebindSession: ReturnType<typeof vi.fn>;
};

function createAssistantMessage(options?: {
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: options?.text ? [{ type: "text", text: options.text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options?.stopReason ?? "stop",
		errorMessage: options?.errorMessage,
		timestamp: Date.now(),
	};
}

function createRuntimeHost(assistantMessage: AssistantMessage): FakeRuntimeHost {
	const extensionRunner: FakeExtensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
	};

	const state = { messages: [assistantMessage] };

	const session: FakeSession = {
		sessionManager: { getHeader: () => undefined },
		agent: { waitForIdle: async () => {} },
		state,
		extensionRunner,
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		prompt: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
	};

	return {
		session,
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		}),
		setRebindSession: vi.fn(),
	};
}

function createHarnessRuntimeHost(harness: Harness): HarnessRuntimeHost {
	return {
		session: harness.session,
		services: {
			semanticIndex: {
				ready: Promise.resolve(),
				vectorsReady: Promise.resolve(),
				vectorStatus: "ready",
			},
			modelRuntime: {
				getLocalModelRuntimeProcessId: () => undefined,
				getLocalModelRuntimeState: () => undefined,
			},
		},
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => undefined),
		setRebindSession: vi.fn(),
	};
}

function appendAssistantUsage(harness: Harness, model: Model<string>, tokens: number): void {
	harness.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "old transcript only" }],
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
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runPrintMode", () => {
	it("emits session_shutdown in text mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc" }];

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "Say done",
			initialImages: images,
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("Say done", { images });
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown in json mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("hello");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown and returns non-zero on assistant error", async () => {
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" }),
		);
		const { session } = runtimeHost;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("provider failure");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("continues from a low-context handoff in the same print-mode session", async () => {
		const harness = await createHarness();
		const runtimeHost = createHarnessRuntimeHost(harness);
		let postResumeContext: Context | undefined;
		try {
			await createGoalStore(harness.tempDir).start({ objective: "Continue native workflow." });
			const model = harness.getModel();
			appendAssistantUsage(harness, model, Math.floor((model.contextWindow ?? 128_000) * 0.86));
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("handoff", {
						profile: "planner",
						title: "Continue Native Workflow",
						goal: "Continue the native planner/executor handoff workflow.",
						nonGoals: ["Do not use the legacy migration harness."],
						inspectedFiles: ["packages/coding-agent/src/modes/print-mode.ts"],
						facts: ["Print mode receives AgentSession events."],
						decisions: ["Resume in the same AgentSession."],
						plan: ["Implement print-mode handoff continuation."],
						verification: ["node node_modules/vitest/dist/cli.js --run test/print-mode.test.ts"],
						staleStateChecks: ["Run git status before editing."],
						risks: ["A handoff write can be mistaken for completed continuation."],
						stopConditions: ["Stop if validation fails."],
						unexplored: ["Interactive status rendering."],
						completed: ["Handoff write event exists."],
						nextSlice: ["Implement print-mode continuation."],
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("handoff written"),
				(context) => {
					postResumeContext = context;
					return fauxAssistantMessage("post resume done");
				},
			]);

			const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
				mode: "text",
				initialMessage: "continue until handoff",
			});

			expect(exitCode).toBe(0);
			expect(harness.eventsOfType("context_handoff_required")).toHaveLength(1);
			expect(harness.eventsOfType("context_handoff_written")).toHaveLength(1);
			expect(harness.eventsOfType("context_handoff_resume_started")).toHaveLength(1);
			expect(harness.eventsOfType("context_handoff_resume_completed")).toHaveLength(1);
			expect(harness.faux.state.callCount).toBe(3);
			const postResumeText = postResumeContext?.messages
				.map((message) => contentText(message.content, ""))
				.join("\n");
			expect(postResumeText).toContain("Continuation path: planner -> executor.");
			expect(postResumeText).toContain("# Planner Handoff: Continue Native Workflow");
			expect(postResumeText).not.toContain("old transcript only");
		} finally {
			harness.cleanup();
		}
	});
});
