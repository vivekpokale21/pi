export interface ContextBudgetReminderInput {
	tokens: number | null;
	contextWindow: number;
}

export type ContextBudgetBand = "tighten_scope" | "prepare_handoff" | "handoff_required";
export type HandoffProfile = "planner" | "executor";
export type HandoffContinuationPath = "planner_to_planner" | "planner_to_executor" | "executor_to_executor";

export interface HandoffContinuationInput {
	transition: HandoffContinuationPath;
	originalGoal: string;
	handoffPath: string;
	handoffContent: string;
}

export interface HandoffContinuationInferenceInput {
	profile: HandoffProfile;
	content: string;
}

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

function formatContinuationPath(transition: HandoffContinuationPath): string {
	if (transition === "planner_to_planner") return "planner -> planner";
	if (transition === "planner_to_executor") return "planner -> executor";
	return "executor -> executor";
}

function continuationRoleInstruction(transition: HandoffContinuationPath): string {
	if (transition === "planner_to_planner") {
		return "Planner role: continue targeted investigation, preserve provenance, update the plan or handoff when needed, and list unexplored items.";
	}
	if (transition === "planner_to_executor") {
		return "Executor role: revalidate before editing, implement only the next bounded implementation slice, and run focused verification.";
	}
	return "Executor role: revalidate before editing, preserve completed work, continue the next bounded slice, and avoid repeating finished steps.";
}

export function buildHandoffContinuationPrompt(input: HandoffContinuationInput): string {
	return [
		"Continue the active goal without user intervention unless blocked.",
		`Original goal: ${input.originalGoal.trim()}`,
		`Continuation path: ${formatContinuationPath(input.transition)}.`,
		`Handoff artifact: ${input.handoffPath.trim()}`,
		"",
		"Required stale-state checks before relying on this handoff:",
		"- Check git status.",
		"- Check referenced file existence.",
		"- Re-read relevant snippets or revisions before editing or extending the plan.",
		"- Re-check any verification commands the handoff relies on.",
		"",
		continuationRoleInstruction(input.transition),
		"",
		"Validated handoff content:",
		input.handoffContent.trim(),
	].join("\n");
}

export function inferHandoffContinuationPath(input: HandoffContinuationInferenceInput): HandoffContinuationPath {
	if (input.profile === "executor") return "executor_to_executor";
	const lowerContent = input.content.toLowerCase();
	const actionContent = `${extractMarkdownSection(lowerContent, "plan steps")}\n${extractMarkdownSection(
		lowerContent,
		"next slice",
	)}`;
	const contentToClassify = actionContent.trim() === "" ? lowerContent : actionContent;
	const implementationTerms = [
		" implement ",
		"- implement",
		" edit ",
		"- edit",
		" modify ",
		"- modify",
		" add controller",
		" add test",
		" fix ",
		"- fix",
	];
	return implementationTerms.some((term) => contentToClassify.includes(term))
		? "planner_to_executor"
		: "planner_to_planner";
}

function extractMarkdownSection(content: string, heading: string): string {
	const marker = `## ${heading}`;
	const start = content.indexOf(marker);
	if (start === -1) return "";
	const sectionStart = start + marker.length;
	const nextHeading = content.indexOf("\n## ", sectionStart);
	return content.slice(sectionStart, nextHeading === -1 ? undefined : nextHeading);
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
