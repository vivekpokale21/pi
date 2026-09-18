import type { GoalState, GoalStore } from "./goal-state.ts";

export type GoalCommandResultKind = "started" | "status" | "stopped";

export interface GoalCommandResult {
	kind: GoalCommandResultKind;
	message: string;
	goal?: GoalState;
}

function formatGoalStatus(goal: GoalState | undefined): string {
	if (!goal) return "No active goal.";
	return [`Active goal: ${goal.objective}`, `Auto-continuation: ${goal.autoContinue ? "enabled" : "disabled"}`].join(
		"\n",
	);
}

export async function executeGoalCommand(store: GoalStore, args: string): Promise<GoalCommandResult> {
	const trimmed = args.trim();
	if (trimmed.length === 0) {
		throw new Error("Usage: /goal <objective|status|stop>");
	}

	if (trimmed === "status") {
		const goal = await store.getActive();
		return { kind: "status", message: formatGoalStatus(goal), ...(goal ? { goal } : {}) };
	}

	if (trimmed === "stop") {
		const goal = await store.stop("Stopped through /goal stop.");
		return {
			kind: "stopped",
			message: goal ? `Goal stopped: ${goal.objective}` : "No active goal.",
			...(goal ? { goal } : {}),
		};
	}

	const goal = await store.start({ objective: trimmed, autoContinue: true });
	return { kind: "started", message: `Goal started: ${goal.objective}`, goal };
}
