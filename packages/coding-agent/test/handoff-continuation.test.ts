import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { GoalStore } from "../src/core/goal-state.ts";
import {
	continueFromHandoff,
	formatHandoffContinuationStatus,
	validateHandoffForContinuation,
} from "../src/core/handoff-continuation.ts";

function goalStore(canAutoContinue: boolean): GoalStore {
	return {
		activePath: "/tmp/active.json",
		start: async () => {
			throw new Error("not used");
		},
		getActive: async () => undefined,
		canAutoContinue: async () => canAutoContinue,
		stop: async () => undefined,
	};
}

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
		"- Add a validation/read path.",
		"",
		"## Verification Commands",
		"- node node_modules/vitest/dist/cli.js --run test/handoff-status-tool.test.ts",
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
		"- Context reminder dedupe.",
		"",
		"## Completed Work",
		"- Writer exists.",
		"",
		"## Next Slice",
		"- Validate executor consumption.",
		"",
	].join("\n");
}

describe("handoff continuation", () => {
	test("formats concise user-facing lifecycle statuses", () => {
		expect(
			formatHandoffContinuationStatus({
				type: "context_handoff_written",
				handoffPath: ".pi/handoffs/continue.md",
				profile: "planner",
				title: "Continue",
				bytes: 1200,
				sourceProfile: "planner",
			}),
		).toEqual({ level: "status", message: "Context handoff: wrote .pi/handoffs/continue.md" });
		expect(
			formatHandoffContinuationStatus({
				type: "context_handoff_resume_started",
				handoffPath: ".pi/handoffs/continue.md",
				transition: "planner_to_executor",
			}),
		).toEqual({
			level: "status",
			message: "Context handoff: starting fresh executor context from .pi/handoffs/continue.md",
		});
		expect(
			formatHandoffContinuationStatus({
				type: "context_handoff_resume_failed",
				handoffPath: ".pi/handoffs/continue.md",
				transition: "planner_to_executor",
				error: "validation failed",
			}),
		).toEqual({ level: "error", message: "Context handoff failed: validation failed" });
	});

	test("validates handoff artifacts through handoff_status before continuation", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-handoff-continuation-"));
		try {
			mkdirSync(join(cwd, ".pi/handoffs"), { recursive: true });
			writeFileSync(join(cwd, ".pi/handoffs/complete.md"), completeHandoff(), "utf8");

			const handoff = await validateHandoffForContinuation(cwd, ".pi/handoffs/complete.md");

			expect(handoff).toMatchObject({
				path: ".pi/handoffs/complete.md",
				profile: "planner",
				content: expect.stringContaining("# Planner Handoff: Continue native workflow"),
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("rejects invalid handoff artifacts before continuation", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-handoff-continuation-"));
		try {
			mkdirSync(join(cwd, ".pi/handoffs"), { recursive: true });
			writeFileSync(join(cwd, ".pi/handoffs/incomplete.md"), "# Planner Handoff: Incomplete\n", "utf8");

			await expect(validateHandoffForContinuation(cwd, ".pi/handoffs/incomplete.md")).rejects.toThrow(
				"Handoff is invalid for continuation",
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("refuses fresh-context continuation without an active auto-continuing goal", async () => {
		const events: string[] = [];

		await expect(
			continueFromHandoff({
				goalStore: goalStore(false),
				transition: "planner_to_executor",
				originalGoal: "Implement handoff continuation.",
				handoffPath: ".pi/handoffs/plan.md",
				validateHandoff: async () => {
					throw new Error("validation should not run");
				},
				injectContinuationContext: async () => {
					throw new Error("continuation context should not be injected");
				},
				emit: (event) => events.push(event.type),
			}),
		).rejects.toThrow("Automatic handoff continuation requires an active goal");

		expect(events).toEqual(["context_handoff_resume_failed"]);
	});

	test("validates a handoff and injects fresh same-session context", async () => {
		const events: string[] = [];
		let injectedPrompt = "";
		const result = await continueFromHandoff({
			goalStore: goalStore(true),
			transition: "planner_to_executor",
			originalGoal: "Implement handoff continuation.",
			handoffPath: ".pi/handoffs/plan.md",
			validateHandoff: async (path) => ({
				path,
				profile: "planner",
				content: "## Plan Steps\n- Add controller.",
			}),
			injectContinuationContext: async (input) => {
				injectedPrompt = input.injectedPrompt;
				return { sessionId: "same-session" };
			},
			emit: (event) => events.push(event.type),
		});

		expect(result).toMatchObject({
			handoffPath: ".pi/handoffs/plan.md",
			transition: "planner_to_executor",
			session: { sessionId: "same-session" },
		});
		expect(injectedPrompt).toContain("Continue the active goal without user intervention unless blocked.");
		expect(injectedPrompt).toContain("Continuation path: planner -> executor.");
		expect(injectedPrompt).toContain("## Plan Steps");
		expect(events).toEqual(["context_handoff_resume_started"]);
	});

	test("infers planner to executor continuation when transition is omitted", async () => {
		const result = await continueFromHandoff({
			goalStore: goalStore(true),
			originalGoal: "Implement handoff continuation.",
			handoffPath: ".pi/handoffs/plan.md",
			validateHandoff: async (path) => ({
				path,
				profile: "planner",
				content: "## Next Slice\n- Implement the controller.",
			}),
			injectContinuationContext: async (input) => ({ transition: input.transition }),
		});

		expect(result.transition).toBe("planner_to_executor");
		expect(result.session).toEqual({ transition: "planner_to_executor" });
	});

	test("prevents immediate recursive continuation for the same handoff path", async () => {
		await expect(
			continueFromHandoff({
				goalStore: goalStore(true),
				transition: "executor_to_executor",
				originalGoal: "Continue implementation.",
				handoffPath: ".pi/handoffs/executor.md",
				consumedHandoffPaths: new Set([".pi/handoffs/executor.md"]),
				validateHandoff: async () => ({
					path: ".pi/handoffs/executor.md",
					profile: "executor",
					content: "## Next Slice\n- Continue.",
				}),
				injectContinuationContext: async () => ({ sessionId: "same-session" }),
			}),
		).rejects.toThrow("Handoff has already been consumed for continuation");
	});
});
