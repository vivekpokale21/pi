import {
	buildHandoffContinuationPrompt,
	type HandoffContinuationPath,
	type HandoffProfile,
	inferHandoffContinuationPath,
} from "./context-handoff.ts";
import type { GoalStore } from "./goal-state.ts";
import { createHandoffStatusTool, type HandoffToolOptions } from "./tools/handoff.ts";

export interface ValidatedHandoff {
	path: string;
	profile: "planner" | "executor";
	content: string;
}

export interface HandoffContinuationContextInput {
	injectedPrompt: string;
	handoff: ValidatedHandoff;
	transition: HandoffContinuationPath;
}

export type HandoffContinuationEvent =
	| {
			type: "context_handoff_required";
			band: "handoff_required";
			originalGoal: string;
			sourceProfile: HandoffProfile;
	  }
	| {
			type: "context_handoff_written";
			handoffPath: string;
			profile: HandoffProfile;
			title: string;
			bytes: number;
			sourceProfile: HandoffProfile;
	  }
	| {
			type: "context_handoff_resume_started";
			handoffPath: string;
			transition: HandoffContinuationPath;
	  }
	| {
			type: "context_handoff_resume_failed";
			handoffPath: string;
			transition: HandoffContinuationPath;
			error: string;
	  }
	| {
			type: "context_handoff_resume_completed";
			handoffPath: string;
			transition: HandoffContinuationPath;
	  };

export interface HandoffContinuationStatus {
	level: "status" | "error";
	message: string;
}

export interface ContinueFromHandoffInput<TSession> {
	goalStore: GoalStore;
	transition?: HandoffContinuationPath;
	originalGoal: string;
	handoffPath: string;
	consumedHandoffPaths?: Set<string>;
	validateHandoff(path: string): Promise<ValidatedHandoff>;
	injectContinuationContext(input: HandoffContinuationContextInput): Promise<TSession>;
	emit?: (event: HandoffContinuationEvent) => void;
}

export interface ContinueFromHandoffResult<TSession> {
	handoffPath: string;
	transition: HandoffContinuationPath;
	session: TSession;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function targetProfileLabel(transition: HandoffContinuationPath): HandoffProfile {
	return transition === "planner_to_planner" ? "planner" : "executor";
}

export function formatHandoffContinuationStatus(
	event: HandoffContinuationEvent,
): HandoffContinuationStatus | undefined {
	if (event.type === "context_handoff_required") {
		return {
			level: "status",
			message: "Context handoff required: active goal needs a handoff before broad work continues",
		};
	}
	if (event.type === "context_handoff_written") {
		return { level: "status", message: `Context handoff: wrote ${event.handoffPath}` };
	}
	if (event.type === "context_handoff_resume_started") {
		return {
			level: "status",
			message: `Context handoff: starting fresh ${targetProfileLabel(event.transition)} context from ${event.handoffPath}`,
		};
	}
	if (event.type === "context_handoff_resume_completed") {
		return {
			level: "status",
			message: `Context handoff: fresh ${targetProfileLabel(event.transition)} context completed first turn`,
		};
	}
	if (event.type === "context_handoff_resume_failed") {
		return { level: "error", message: `Context handoff failed: ${event.error}` };
	}
	return undefined;
}

export async function validateHandoffForContinuation(
	cwd: string,
	path: string,
	options?: HandoffToolOptions,
): Promise<ValidatedHandoff> {
	const result = await createHandoffStatusTool(cwd, options).execute(
		"handoff-continuation-status",
		{ path },
		undefined,
		undefined,
	);
	if (!result.details.valid || !result.details.profile) {
		throw new Error(`Handoff is invalid for continuation: ${result.details.path}`);
	}
	const textContent = result.content.find((part) => part.type === "text");
	return {
		path: result.details.path,
		profile: result.details.profile,
		content: textContent?.text ?? "",
	};
}

export async function continueFromHandoff<TSession>(
	input: ContinueFromHandoffInput<TSession>,
): Promise<ContinueFromHandoffResult<TSession>> {
	let transition = input.transition ?? "planner_to_planner";
	try {
		if (!(await input.goalStore.canAutoContinue())) {
			throw new Error("Automatic handoff continuation requires an active goal");
		}
		if (input.consumedHandoffPaths?.has(input.handoffPath)) {
			throw new Error("Handoff has already been consumed for continuation");
		}
		const handoff = await input.validateHandoff(input.handoffPath);
		transition =
			input.transition ?? inferHandoffContinuationPath({ profile: handoff.profile, content: handoff.content });
		const injectedPrompt = buildHandoffContinuationPrompt({
			transition,
			originalGoal: input.originalGoal,
			handoffPath: handoff.path,
			handoffContent: handoff.content,
		});
		const session = await input.injectContinuationContext({ injectedPrompt, handoff, transition });
		input.consumedHandoffPaths?.add(input.handoffPath);
		input.emit?.({
			type: "context_handoff_resume_started",
			handoffPath: input.handoffPath,
			transition,
		});
		return { handoffPath: input.handoffPath, transition, session };
	} catch (error) {
		input.emit?.({
			type: "context_handoff_resume_failed",
			handoffPath: input.handoffPath,
			transition,
			error: errorMessage(error),
		});
		throw error;
	}
}
