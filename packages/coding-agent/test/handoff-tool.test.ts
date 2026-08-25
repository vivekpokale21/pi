import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createHandoffTool } from "../src/core/tools/handoff.ts";

describe("handoff tool", () => {
	test("writes a structured planner handoff under .pi/handoffs", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-handoff-tool-"));
		try {
			const tool = createHandoffTool(cwd, {
				now: () => new Date("2026-08-23T10:11:12.000Z"),
			});

			const result = await tool.execute(
				"handoff-call",
				{
					profile: "planner",
					title: "Investigate context flow",
					goal: "Design native planner/executor handoffs.",
					nonGoals: ["Do not use the legacy migration harness."],
					inspectedFiles: ["packages/coding-agent/src/core/agent-session.ts"],
					facts: ["AgentSession owns native turn orchestration."],
					decisions: ["Keep the handoff workflow native."],
					plan: ["Add reminder injection.", "Add native handoff writer."],
					verification: ["Run focused handoff tests."],
					unexplored: ["Validate executor follow-up flow."],
					staleStateChecks: ["Run git status before editing."],
					risks: ["Context may become stale between planner and executor."],
					stopConditions: ["Stop if current files contradict the handoff."],
					completed: ["Added initial handoff writer."],
					nextSlice: ["Validate executor follow-up flow."],
				},
				undefined,
				undefined,
			);

			expect(result.details).toMatchObject({
				path: ".pi/handoffs/2026-08-23T10-11-12-000Z-planner-investigate-context-flow.md",
				profile: "planner",
			});
			const outputPath = join(cwd, ".pi/handoffs/2026-08-23T10-11-12-000Z-planner-investigate-context-flow.md");
			expect(existsSync(outputPath)).toBe(true);
			const content = readFileSync(outputPath, "utf8");
			expect(content).toContain("# Planner Handoff: Investigate context flow");
			expect(content).toContain("## Goal");
			expect(content).toContain("## Files Inspected");
			expect(content).toContain("- packages/coding-agent/src/core/agent-session.ts");
			expect(content).toContain("## Unexplored Items");
			expect(content).toContain("- Validate executor follow-up flow.");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("requires all status-required sections to contain items", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-handoff-tool-"));
		try {
			const tool = createHandoffTool(cwd);

			await expect(
				tool.execute(
					"handoff-call",
					{
						profile: "planner",
						title: "Incomplete",
						goal: "Document current work.",
						nonGoals: ["Do not use the legacy migration harness."],
						inspectedFiles: ["packages/coding-agent/src/core/tools/handoff.ts"],
						facts: ["The writer renders all known handoff sections."],
						plan: ["Reject incomplete handoffs."],
						verification: ["Run handoff-tool.test.ts."],
						staleStateChecks: ["Run git status before editing."],
						risks: ["Generated handoffs can become stale."],
						stopConditions: ["Stop if files contradict the handoff."],
						unexplored: ["Executor read path."],
						completed: ["Added writer."],
						nextSlice: ["Align writer and validator."],
					},
					undefined,
					undefined,
				),
			).rejects.toThrow("Handoff section Decisions must contain at least one item");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("requires at least one useful handoff section", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-handoff-tool-"));
		try {
			const tool = createHandoffTool(cwd);

			await expect(
				tool.execute(
					"handoff-call",
					{
						profile: "executor",
						title: "Empty",
						goal: "Checkpoint current work.",
					},
					undefined,
					undefined,
				),
			).rejects.toThrow("At least one handoff section must contain an item");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("requires a recorded handoff goal", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-handoff-tool-"));
		try {
			const tool = createHandoffTool(cwd);

			await expect(
				tool.execute(
					"handoff-call",
					{
						profile: "planner",
						title: "Blank goal",
						goal: "   ",
						nonGoals: ["Do not use the legacy migration harness."],
						inspectedFiles: ["packages/coding-agent/src/core/tools/handoff.ts"],
						facts: ["The writer renders a Goal section."],
						decisions: ["Reject blank goals."],
						plan: ["Add goal validation."],
						verification: ["Run handoff-tool.test.ts."],
						staleStateChecks: ["Run git status before editing."],
						risks: ["A blank goal leaves the next pass underspecified."],
						stopConditions: ["Stop if the handoff lacks a concrete goal."],
						unexplored: ["No additional items."],
						completed: ["Added red test."],
						nextSlice: ["Implement goal validation."],
					},
					undefined,
					undefined,
				),
			).rejects.toThrow("Handoff goal must be recorded");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("reports the rendered fallback title for blank title input", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-handoff-tool-"));
		try {
			const tool = createHandoffTool(cwd, {
				now: () => new Date("2026-08-23T10:11:12.000Z"),
			});

			const result = await tool.execute(
				"handoff-call",
				{
					profile: "executor",
					title: "   ",
					goal: "Checkpoint current work.",
					nonGoals: ["Do not use the legacy migration harness."],
					inspectedFiles: ["packages/coding-agent/src/core/tools/handoff.ts"],
					facts: ["The writer normalizes blank titles while rendering."],
					decisions: ["Return the rendered title in details."],
					plan: ["Add normalized title reporting."],
					verification: ["Run handoff-tool.test.ts."],
					staleStateChecks: ["Run git status before editing."],
					risks: ["Raw title details can differ from the artifact heading."],
					stopConditions: ["Stop if artifact and details disagree."],
					unexplored: ["No additional items."],
					completed: ["Added red test."],
					nextSlice: ["Keep writer details aligned with rendered content."],
				},
				undefined,
				undefined,
			);

			expect(result.details.title).toBe("Untitled handoff");
			expect(result.details.path).toBe(".pi/handoffs/2026-08-23T10-11-12-000Z-executor-handoff.md");
			const content = readFileSync(join(cwd, result.details.path), "utf8");
			expect(content).toContain("# Executor Handoff: Untitled handoff");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("rejects placeholder-only section items", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-handoff-tool-"));
		try {
			const tool = createHandoffTool(cwd);

			await expect(
				tool.execute(
					"handoff-call",
					{
						profile: "planner",
						title: "Placeholder item",
						goal: "Document current work.",
						nonGoals: ["Do not use the legacy migration harness."],
						inspectedFiles: ["packages/coding-agent/src/core/tools/handoff.ts"],
						facts: ["None recorded."],
						decisions: ["Reject placeholder section items."],
						plan: ["Filter placeholder items before rendering."],
						verification: ["Run handoff-tool.test.ts."],
						staleStateChecks: ["Run git status before editing."],
						risks: ["Writer could generate status-invalid handoffs."],
						stopConditions: ["Stop if writer and validator disagree."],
						unexplored: ["No additional items."],
						completed: ["Added red test."],
						nextSlice: ["Reject placeholder-only section items."],
					},
					undefined,
					undefined,
				),
			).rejects.toThrow("Handoff section Current Facts With Provenance must contain at least one item");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("rejects not-recorded placeholder section items", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-handoff-tool-"));
		try {
			const tool = createHandoffTool(cwd);

			await expect(
				tool.execute(
					"handoff-call",
					{
						profile: "planner",
						title: "Not recorded item",
						goal: "Document current work.",
						nonGoals: ["Do not use the legacy migration harness."],
						inspectedFiles: ["packages/coding-agent/src/core/tools/handoff.ts"],
						facts: ["Not recorded."],
						decisions: ["Reject placeholder section items."],
						plan: ["Filter placeholder items before rendering."],
						verification: ["Run handoff-tool.test.ts."],
						staleStateChecks: ["Run git status before editing."],
						risks: ["Writer could generate status-invalid handoffs."],
						stopConditions: ["Stop if writer and validator disagree."],
						unexplored: ["No additional items."],
						completed: ["Added red test."],
						nextSlice: ["Reject not-recorded placeholder section items."],
					},
					undefined,
					undefined,
				),
			).rejects.toThrow("Handoff section Current Facts With Provenance must contain at least one item");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
