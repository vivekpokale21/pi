import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type GoalCommandContext = {
	sessionManager: {
		getCwd(): string;
	};
	showStatus(message: string): void;
	showError(message: string): void;
};

type InteractiveModeGoalCommandPrototype = {
	handleGoalCommand(this: GoalCommandContext, text: string): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModeGoalCommandPrototype;
const tempDirs: string[] = [];

function tempDir(): string {
	const path = mkdtempSync(join(tmpdir(), "pi-interactive-goal-"));
	tempDirs.push(path);
	return path;
}

afterEach(() => {
	for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("InteractiveMode /goal", () => {
	test("starts a persisted goal from interactive command text", async () => {
		const cwd = tempDir();
		const statuses: string[] = [];
		const context: GoalCommandContext = {
			sessionManager: { getCwd: () => cwd },
			showStatus: (message) => statuses.push(message),
			showError: (message) => statuses.push(`error: ${message}`),
		};

		await interactiveModePrototype.handleGoalCommand.call(context, "/goal Implement fresh context continuation");

		expect(statuses).toEqual(["Goal started: Implement fresh context continuation"]);
		const persisted = JSON.parse(readFileSync(join(cwd, ".pi/goals/active.json"), "utf8")) as Record<string, unknown>;
		expect(persisted).toMatchObject({
			objective: "Implement fresh context continuation",
			status: "active",
			autoContinue: true,
		});
	});

	test("reports usage errors without creating a goal", async () => {
		const cwd = tempDir();
		const errors: string[] = [];
		const context: GoalCommandContext = {
			sessionManager: { getCwd: () => cwd },
			showStatus: () => {},
			showError: (message) => errors.push(message),
		};

		await interactiveModePrototype.handleGoalCommand.call(context, "/goal");

		expect(errors).toEqual(["Usage: /goal <objective|status|stop>"]);
	});
});
