import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";

describe("BUILTIN_SLASH_COMMANDS", () => {
	it("includes a user-invoked semantic index refresh command", () => {
		expect(BUILTIN_SLASH_COMMANDS.some((command) => command.name === "semantic-refresh")).toBe(true);
	});

	it("includes a goal command for bounded autonomous continuation", () => {
		const goal = BUILTIN_SLASH_COMMANDS.find((command) => command.name === "goal");

		expect(goal).toMatchObject({
			description: "Start, show, or stop a bounded long-running goal",
			argumentHint: "<objective|status|stop>",
		});
	});
});
