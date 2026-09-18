import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createGoalStore } from "../src/core/goal-state.ts";

const tempDirs: string[] = [];

function tempDir(): string {
	const path = mkdtempSync(join(tmpdir(), "pi-goal-state-"));
	tempDirs.push(path);
	return path;
}

afterEach(() => {
	for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("goal state", () => {
	test("starts and persists an active goal under .pi/goals", async () => {
		const cwd = tempDir();
		const store = createGoalStore(cwd, { now: () => new Date("2026-09-09T16:10:00.000Z") });

		const goal = await store.start({
			objective: "Implement fresh-context handoff continuation.",
			nonGoals: ["Do not auto-commit."],
			stopConditions: ["Stop if validation fails."],
			verification: ["node node_modules/vitest/dist/cli.js --run test/goal-state.test.ts"],
			autoContinue: true,
		});

		expect(goal).toMatchObject({
			status: "active",
			objective: "Implement fresh-context handoff continuation.",
			nonGoals: ["Do not auto-commit."],
			stopConditions: ["Stop if validation fails."],
			verification: ["node node_modules/vitest/dist/cli.js --run test/goal-state.test.ts"],
			autoContinue: true,
			createdAt: "2026-09-09T16:10:00.000Z",
			updatedAt: "2026-09-09T16:10:00.000Z",
		});
		expect(goal.id).toMatch(/^[a-f0-9-]{36}$/);
		expect(await store.getActive()).toEqual(goal);

		const persisted = JSON.parse(readFileSync(join(cwd, ".pi/goals/active.json"), "utf8")) as Record<string, unknown>;
		expect(persisted).toMatchObject({ id: goal.id, status: "active", autoContinue: true });
	});

	test("does not allow automatic handoff continuation without an active auto-continue goal", async () => {
		const cwd = tempDir();
		const store = createGoalStore(cwd);

		expect(await store.canAutoContinue()).toBe(false);

		await store.start({ objective: "Manual goal only.", autoContinue: false });

		expect(await store.canAutoContinue()).toBe(false);
	});

	test("stops the active goal and clears auto-continuation", async () => {
		const cwd = tempDir();
		const store = createGoalStore(cwd, {
			now: () => new Date("2026-09-09T16:20:00.000Z"),
		});
		const goal = await store.start({ objective: "Continue until stopped." });

		const stopped = await store.stop("User requested stop.");

		expect(stopped).toMatchObject({
			id: goal.id,
			status: "stopped",
			objective: "Continue until stopped.",
			stopReason: "User requested stop.",
			updatedAt: "2026-09-09T16:20:00.000Z",
		});
		expect(await store.getActive()).toBeUndefined();
		expect(await store.canAutoContinue()).toBe(false);
	});
});
