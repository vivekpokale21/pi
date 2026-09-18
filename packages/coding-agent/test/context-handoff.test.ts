import { describe, expect, test } from "vitest";
import {
	buildContextBudgetReminder,
	buildContextHandoffGuidance,
	buildHandoffContinuationPrompt,
	type ContextBudgetReminderInput,
	getContextBudgetReminderBand,
	inferHandoffContinuationPath,
} from "../src/core/context-handoff.ts";

const baseInput: ContextBudgetReminderInput = {
	tokens: 85_000,
	contextWindow: 100_000,
};

describe("context handoff guidance", () => {
	test("documents native planner and executor handoff behavior", () => {
		const guidance = buildContextHandoffGuidance();

		expect(guidance).toContain("handoff tool");
		expect(guidance).toContain("handoff_status");
		expect(guidance).toContain(".pi/handoffs/");
		expect(guidance).toContain("planner");
		expect(guidance).toContain("executor");
		expect(guidance).toContain("unexplored");
		expect(guidance).toContain("completed work");
		expect(guidance).toContain("next slice");
		expect(guidance).toContain("revalidate");
		expect(guidance).toContain("git status");
	});
});

describe("buildHandoffContinuationPrompt", () => {
	test("builds a planner to planner continuation prompt", () => {
		const prompt = buildHandoffContinuationPrompt({
			transition: "planner_to_planner",
			originalGoal: "Investigate native handoff orchestration.",
			handoffPath: ".pi/handoffs/planner.md",
			handoffContent: "## Current Facts With Provenance\n- Read agent-session.ts.",
		});

		expect(prompt).toContain("Continue the active goal without user intervention unless blocked.");
		expect(prompt).toContain("Original goal: Investigate native handoff orchestration.");
		expect(prompt).toContain("Continuation path: planner -> planner.");
		expect(prompt).toContain("Handoff artifact: .pi/handoffs/planner.md");
		expect(prompt).toContain("Planner role: continue targeted investigation");
		expect(prompt).toContain("git status");
		expect(prompt).toContain("referenced file existence");
		expect(prompt).toContain("## Current Facts With Provenance");
	});

	test("builds a planner to executor continuation prompt", () => {
		const prompt = buildHandoffContinuationPrompt({
			transition: "planner_to_executor",
			originalGoal: "Implement native handoff orchestration.",
			handoffPath: ".pi/handoffs/plan.md",
			handoffContent: "## Plan Steps\n- Add controller tests.",
		});

		expect(prompt).toContain("Continuation path: planner -> executor.");
		expect(prompt).toContain("Executor role: revalidate before editing");
		expect(prompt).toContain("focused verification");
		expect(prompt).toContain("bounded implementation slice");
	});

	test("builds an executor to executor continuation prompt", () => {
		const prompt = buildHandoffContinuationPrompt({
			transition: "executor_to_executor",
			originalGoal: "Continue implementation.",
			handoffPath: ".pi/handoffs/executor.md",
			handoffContent: "## Completed Work\n- Goal store is green.",
		});

		expect(prompt).toContain("Continuation path: executor -> executor.");
		expect(prompt).toContain("Executor role: revalidate before editing");
		expect(prompt).toContain("completed work");
		expect(prompt).toContain("next bounded slice");
	});
});

describe("inferHandoffContinuationPath", () => {
	test("continues executor handoffs as executor to executor", () => {
		expect(
			inferHandoffContinuationPath({
				profile: "executor",
				content: "## Next Slice\n- Continue implementation.",
			}),
		).toBe("executor_to_executor");
	});

	test("continues planner handoffs with implementation next slice as planner to executor", () => {
		expect(
			inferHandoffContinuationPath({
				profile: "planner",
				content: "## Plan Steps\n- Implement the controller.\n\n## Next Slice\n- Edit handoff-continuation.ts.",
			}),
		).toBe("planner_to_executor");
	});

	test("continues planner handoffs with unexplored planning work as planner to planner", () => {
		expect(
			inferHandoffContinuationPath({
				profile: "planner",
				content:
					"## Unexplored Items\n- Inspect agent-session restart behavior.\n\n## Next Slice\n- Investigate options.",
			}),
		).toBe("planner_to_planner");
	});

	test("ignores non-goal implementation terms when planner work remains investigative", () => {
		expect(
			inferHandoffContinuationPath({
				profile: "planner",
				content: [
					"## Non-Goals",
					"- Do not edit implementation files yet.",
					"",
					"## Plan Steps",
					"- Read the remaining task list and refine the plan.",
					"",
					"## Next Slice",
					"- Continue planning and document remaining questions.",
				].join("\n"),
			}),
		).toBe("planner_to_planner");
	});
});

describe("buildContextBudgetReminder", () => {
	test("classifies reminder bands by remaining context", () => {
		expect(getContextBudgetReminderBand({ tokens: 60_000, contextWindow: 100_000 })).toBeUndefined();
		expect(getContextBudgetReminderBand({ tokens: 66_000, contextWindow: 100_000 })).toBe("tighten_scope");
		expect(getContextBudgetReminderBand({ tokens: 82_000, contextWindow: 100_000 })).toBe("prepare_handoff");
		expect(getContextBudgetReminderBand({ tokens: 85_000, contextWindow: 100_000 })).toBe("handoff_required");
	});

	test("returns undefined while ample context remains", () => {
		expect(buildContextBudgetReminder({ ...baseInput, tokens: 60_000 })).toBeUndefined();
	});

	test("warns profiles to tighten scope below 35 percent remaining", () => {
		const reminder = buildContextBudgetReminder({ ...baseInput, tokens: 66_000 });

		expect(reminder).toContain("Context budget reminder");
		expect(reminder).toContain("34.0% remaining");
		expect(reminder).toContain("tighten scope");
		expect(reminder).toContain(".pi/handoffs/");
	});

	test("requires planner and executor checkpoint preparation below 20 percent remaining", () => {
		const reminder = buildContextBudgetReminder({ ...baseInput, tokens: 82_000 });

		expect(reminder).toContain("18.0% remaining");
		expect(reminder).toContain("start writing a handoff");
		expect(reminder).toContain("Planner:");
		expect(reminder).toContain("Executor:");
	});

	test("requires handoff before new exploration below 15 percent remaining", () => {
		const reminder = buildContextBudgetReminder(baseInput);

		expect(reminder).toContain("15.0% remaining");
		expect(reminder).toContain("Do not start new exploration");
		expect(reminder).toContain("handoff");
	});

	test("returns undefined when context usage is unknown", () => {
		expect(buildContextBudgetReminder({ tokens: null, contextWindow: 100_000 })).toBeUndefined();
	});
});
