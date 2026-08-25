export interface ContextBudgetReminderInput {
	tokens: number | null;
	contextWindow: number;
}

export type ContextBudgetBand = "tighten_scope" | "prepare_handoff" | "handoff_required";

function formatPercent(value: number): string {
	return value.toFixed(1);
}

function getContextBudgetBand(remainingPercent: number): ContextBudgetBand | undefined {
	if (remainingPercent <= 15) {
		return "handoff_required";
	}
	if (remainingPercent <= 20) {
		return "prepare_handoff";
	}
	if (remainingPercent <= 35) {
		return "tighten_scope";
	}
	return undefined;
}

export function getContextBudgetReminderBand(input: ContextBudgetReminderInput): ContextBudgetBand | undefined {
	if (input.tokens === null || input.contextWindow <= 0) {
		return undefined;
	}

	const usedPercent = (input.tokens / input.contextWindow) * 100;
	const remainingPercent = Math.max(0, 100 - usedPercent);
	return getContextBudgetBand(remainingPercent);
}

export function buildContextHandoffGuidance(): string {
	return [
		"Context handoff protocol:",
		"- Treat compaction as a fallback, not the primary strategy for long work.",
		"- Use the handoff tool when available; otherwise write structured Markdown under `.pi/handoffs/`.",
		"- Use handoff_status when available before executing from an existing `.pi/handoffs/` artifact.",
		"- planner profile: explore, record provenance-backed findings, write a concrete plan, and list unexplored items when context is low.",
		"- executor profile: execute bounded slices, revalidate handoff facts against current files before editing, run focused checks, and checkpoint remaining work when context is low.",
		"- A handoff must include goal/non-goals, inspected files, current facts with provenance, decisions, plan steps, verification commands, stale-state checks, risks, stop conditions, unexplored items, completed work, and next slice.",
		"- Before executing from a handoff, revalidate `git status`, file existence, relevant snippets or revisions, and any commands the plan relies on.",
	].join("\n");
}

export function buildContextBudgetReminder(input: ContextBudgetReminderInput): string | undefined {
	if (input.tokens === null || input.contextWindow <= 0) {
		return undefined;
	}

	const usedPercent = (input.tokens / input.contextWindow) * 100;
	const remainingPercent = Math.max(0, 100 - usedPercent);
	const band = getContextBudgetReminderBand(input);
	if (!band) {
		return undefined;
	}

	const header = `Context budget reminder: ${formatPercent(remainingPercent)}% remaining (${input.tokens}/${input.contextWindow} tokens used).`;
	const common = "Use `.pi/handoffs/` for any handoff or checkpoint artifact.";

	if (band === "handoff_required") {
		return [
			header,
			"Do not start new exploration or a broad new execution slice before writing a handoff.",
			"Planner: write findings, plan steps, provenance, and unexplored items for a fresh planner or executor pass.",
			"Executor: checkpoint completed work, current file state, verification results, and the next bounded slice.",
			common,
		].join("\n");
	}

	if (band === "prepare_handoff") {
		return [
			header,
			"Context is low; start writing a handoff before taking on more work.",
			"Planner: record findings, decisions, plan steps, risks, and unexplored items.",
			"Executor: finish only the current safe slice, verify it, then checkpoint remaining work.",
			common,
		].join("\n");
	}

	return [
		header,
		"Context is trending low; tighten scope and avoid broad exploration.",
		"Planner: prefer targeted reads and start organizing findings for a possible handoff.",
		"Executor: keep work slice-sized and preserve exact verification state.",
		common,
	].join("\n");
}
