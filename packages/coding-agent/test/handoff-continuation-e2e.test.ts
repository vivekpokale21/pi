import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AssistantMessage, type Context, contentText, type Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createGoalStore } from "../src/core/goal-state.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

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

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
	vi.restoreAllMocks();
});

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

function plannerHandoffCall(): AssistantMessage {
	return fauxAssistantMessage(
		fauxToolCall("handoff", {
			profile: "planner",
			title: "Continue Native Workflow",
			goal: "Continue the native planner/executor handoff workflow.",
			nonGoals: ["Do not use the legacy migration harness."],
			inspectedFiles: ["packages/coding-agent/src/modes/print-mode.ts"],
			facts: ["Print mode can observe handoff lifecycle events."],
			decisions: ["Resume as executor after the planner handoff."],
			plan: ["Implement the next executor slice."],
			verification: ["node node_modules/vitest/dist/cli.js --run test/handoff-continuation-e2e.test.ts"],
			staleStateChecks: ["Run git status before editing."],
			risks: ["The executor could repeat planner work instead of editing."],
			stopConditions: ["Stop if handoff validation fails."],
			unexplored: ["Executor to executor continuation."],
			completed: ["Planner handoff was created."],
			nextSlice: ["Implement executor progress by writing target.txt."],
		}),
		{ stopReason: "toolUse" },
	);
}

function executorHandoffCall(): AssistantMessage {
	return fauxAssistantMessage(
		fauxToolCall("handoff", {
			profile: "executor",
			title: "Continue Executor Slice",
			goal: "Continue the native planner/executor handoff workflow.",
			nonGoals: ["Do not repeat completed edits."],
			inspectedFiles: ["packages/coding-agent/src/core/agent-session.ts"],
			facts: ["The first executor slice already wrote one checkpoint."],
			decisions: ["Continue as executor."],
			plan: ["Continue the next bounded executor slice."],
			verification: ["node node_modules/vitest/dist/cli.js --run test/handoff-continuation-e2e.test.ts"],
			staleStateChecks: ["Run git status before editing."],
			risks: ["The executor could repeat completed work."],
			stopConditions: ["Stop if stale-state checks fail."],
			unexplored: ["Native smoke."],
			completed: ["First executor slice completed."],
			nextSlice: ["Write executor-next.txt."],
		}),
		{ stopReason: "toolUse" },
	);
}

function plannerResearchHandoffCall(): AssistantMessage {
	return fauxAssistantMessage(
		fauxToolCall("handoff", {
			profile: "planner",
			title: "Continue Planner Research",
			goal: "Continue investigating the handoff workflow.",
			nonGoals: ["Do not edit implementation files yet."],
			inspectedFiles: ["docs/ports/21-fresh-context-handoff-orchestration-plan.md"],
			facts: ["The remaining work still has unexplored questions."],
			decisions: ["Stay in planner mode."],
			plan: ["Read the remaining task list and refine the plan."],
			verification: ["node node_modules/vitest/dist/cli.js --run test/handoff-continuation-e2e.test.ts"],
			staleStateChecks: ["Run git status before extending the plan."],
			risks: ["The plan may be stale."],
			stopConditions: ["Stop if required files moved."],
			unexplored: ["Native smoke requirements.", "Interactive edge cases."],
			completed: ["Initial planning summary recorded."],
			nextSlice: ["Continue planning and document remaining questions."],
		}),
		{ stopReason: "toolUse" },
	);
}

describe("handoff continuation e2e", () => {
	test("print mode resumes planner handoff as executor and edits after reset", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const runtimeHost = createHarnessRuntimeHost(harness);
		await createGoalStore(harness.tempDir).start({ objective: "Continue native workflow." });
		const model = harness.getModel();
		appendAssistantUsage(harness, model, Math.floor((model.contextWindow ?? 128_000) * 0.86));

		let postResumeContext: Context | undefined;
		harness.setResponses([
			plannerHandoffCall(),
			fauxAssistantMessage("handoff written"),
			(context) => {
				postResumeContext = context;
				return fauxAssistantMessage(
					fauxToolCall("write", {
						path: "target.txt",
						content: "executor progress\n",
					}),
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("executor done"),
		]);

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "continue until handoff",
		});

		const postResumeText = postResumeContext?.messages.map((message) => contentText(message.content, "")).join("\n");

		expect(exitCode).toBe(0);
		expect(postResumeText).toContain("Continuation path: planner -> executor.");
		expect(postResumeText).toContain("# Planner Handoff: Continue Native Workflow");
		expect(postResumeText).not.toContain("old transcript only");
		expect(readFileSync(join(harness.tempDir, "target.txt"), "utf8")).toBe("executor progress\n");
		expect(harness.eventsOfType("context_handoff_resume_completed")).toHaveLength(1);
		expect(existsSync(join(harness.tempDir, ".pi/handoffs"))).toBe(true);
	});

	test("print mode resumes executor handoff as executor and continues the next slice", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const runtimeHost = createHarnessRuntimeHost(harness);
		await createGoalStore(harness.tempDir).start({ objective: "Continue executor workflow." });
		const model = harness.getModel();
		appendAssistantUsage(harness, model, Math.floor((model.contextWindow ?? 128_000) * 0.86));

		let postResumeContext: Context | undefined;
		harness.setResponses([
			executorHandoffCall(),
			fauxAssistantMessage("executor handoff written"),
			(context) => {
				postResumeContext = context;
				return fauxAssistantMessage(
					fauxToolCall("write", {
						path: "executor-next.txt",
						content: "executor next slice\n",
					}),
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("executor next done"),
		]);

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "continue executor until handoff",
		});

		const postResumeText = postResumeContext?.messages.map((message) => contentText(message.content, "")).join("\n");

		expect(exitCode).toBe(0);
		expect(postResumeText).toContain("Continuation path: executor -> executor.");
		expect(postResumeText).toContain("# Executor Handoff: Continue Executor Slice");
		expect(readFileSync(join(harness.tempDir, "executor-next.txt"), "utf8")).toBe("executor next slice\n");
	});

	test("print mode resumes planner handoff as planner when work remains investigative", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const runtimeHost = createHarnessRuntimeHost(harness);
		await createGoalStore(harness.tempDir).start({ objective: "Continue planner workflow." });
		const model = harness.getModel();
		appendAssistantUsage(harness, model, Math.floor((model.contextWindow ?? 128_000) * 0.86));

		let postResumeContext: Context | undefined;
		harness.setResponses([
			plannerResearchHandoffCall(),
			fauxAssistantMessage("planner handoff written"),
			(context) => {
				postResumeContext = context;
				return fauxAssistantMessage("planner refined remaining questions");
			},
		]);

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "continue planner until handoff",
		});

		const postResumeText = postResumeContext?.messages.map((message) => contentText(message.content, "")).join("\n");

		expect(exitCode).toBe(0);
		expect(postResumeText).toContain("Continuation path: planner -> planner.");
		expect(postResumeText).toContain("# Planner Handoff: Continue Planner Research");
		expect(harness.eventsOfType("context_handoff_resume_completed")).toHaveLength(1);
	});
});
