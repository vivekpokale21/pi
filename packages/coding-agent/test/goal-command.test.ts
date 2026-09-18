import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { executeGoalCommand } from "../src/core/goal-command.ts";
import { createGoalStore } from "../src/core/goal-state.ts";

const tempDirs: string[] = [];

function tempDir(): string {
	const path = mkdtempSync(join(tmpdir(), "pi-goal-command-"));
	tempDirs.push(path);
	return path;
}

afterEach(() => {
	for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("goal command", () => {
	test("starts an auto-continuing goal from free-form objective text", async () => {
		const store = createGoalStore(tempDir(), { now: () => new Date("2026-09-09T16:30:00.000Z") });

		const result = await executeGoalCommand(store, "Implement fresh-context handoff continuation");

		expect(result.kind).toBe("started");
		expect(result.message).toContain("Goal started");
		expect(result.message).toContain("Implement fresh-context handoff continuation");
		expect(await store.canAutoContinue()).toBe(true);
	});

	test("reports active goal status", async () => {
		const store = createGoalStore(tempDir(), { now: () => new Date("2026-09-09T16:30:00.000Z") });
		await executeGoalCommand(store, "Implement handoff continuation");

		const result = await executeGoalCommand(store, "status");

		expect(result).toMatchObject({
			kind: "status",
			message: "Active goal: Implement handoff continuation\nAuto-continuation: enabled",
		});
	});

	test("stops active goal continuation", async () => {
		const store = createGoalStore(tempDir(), { now: () => new Date("2026-09-09T16:30:00.000Z") });
		await executeGoalCommand(store, "Implement handoff continuation");

		const result = await executeGoalCommand(store, "stop");

		expect(result).toMatchObject({
			kind: "stopped",
			message: "Goal stopped: Implement handoff continuation",
		});
		expect(await store.canAutoContinue()).toBe(false);
	});

	test("requires an objective when no subcommand is provided", async () => {
		const store = createGoalStore(tempDir());

		await expect(executeGoalCommand(store, "")).rejects.toThrow("Usage: /goal <objective|status|stop>");
	});
});
