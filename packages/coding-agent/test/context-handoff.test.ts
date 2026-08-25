import { describe, expect, test } from "vitest";
import {
	buildContextBudgetReminder,
	buildContextHandoffGuidance,
	type ContextBudgetReminderInput,
	getContextBudgetReminderBand,
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
