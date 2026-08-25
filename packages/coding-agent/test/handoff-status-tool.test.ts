import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createHandoffStatusTool } from "../src/core/tools/handoff.ts";

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

function handoffWithoutMetadata(): string {
	return completeHandoff()
		.split("\n")
		.filter((line) => !line.startsWith("# Planner Handoff:") && !line.startsWith("Profile:"))
		.join("\n");
}

function handoffWithoutCreatedAt(): string {
	return completeHandoff()
		.split("\n")
		.filter((line) => !line.startsWith("Created:"))
		.join("\n");
}

function handoffWithInvalidCreatedAt(): string {
	return completeHandoff().replace("Created: 2026-08-23T10:11:12.000Z", "Created: yesterday");
}

function handoffWithNonCanonicalCreatedAt(): string {
	return completeHandoff().replace("Created: 2026-08-23T10:11:12.000Z", "Created: 2026-08-23");
}

function handoffWithEmptyFacts(): string {
	return completeHandoff().replace(
		"## Current Facts With Provenance\n- handoff.ts writes structured Markdown under .pi/handoffs/.",
		"## Current Facts With Provenance\n- None recorded.",
	);
}

function handoffWithNotRecordedFacts(): string {
	return completeHandoff().replace(
		"## Current Facts With Provenance\n- handoff.ts writes structured Markdown under .pi/handoffs/.",
		"## Current Facts With Provenance\n- Not recorded.",
	);
}

function handoffWithMultipleFactPlaceholders(): string {
	return completeHandoff().replace(
		"## Current Facts With Provenance\n- handoff.ts writes structured Markdown under .pi/handoffs/.",
		"## Current Facts With Provenance\n- None recorded.\n- Not recorded.",
	);
}

function handoffWithPlaceholderAndRealFacts(): string {
	return completeHandoff().replace(
		"## Current Facts With Provenance\n- handoff.ts writes structured Markdown under .pi/handoffs/.",
		"## Current Facts With Provenance\n- None recorded.\n- handoff.ts writes structured Markdown under .pi/handoffs/.",
	);
}

function handoffWithUnrecordedGoal(): string {
	return completeHandoff().replace(
		"## Goal\nContinue the native planner/executor handoff workflow.",
		"## Goal\nNot recorded.",
	);
}

function handoffWithDuplicateGoal(): string {
	return completeHandoff().replace(
		"## Non-Goals",
		"## Goal\nContinue a different ambiguous workflow.\n\n## Non-Goals",
	);
}

function handoffWithMismatchedProfile(): string {
	return completeHandoff().replace(
		"# Planner Handoff: Continue native workflow",
		"# Executor Handoff: Continue native workflow",
	);
}

function handoffWithDuplicateProfileMetadata(): string {
	return completeHandoff().replace("Profile: planner", "Profile: planner\nProfile: executor");
}

function handoffWithMetadataOnlyInSections(): string {
	return handoffWithoutMetadata().replace(
		"## Current Facts With Provenance\n- handoff.ts writes structured Markdown under .pi/handoffs/.",
		"## Current Facts With Provenance\nProfile: planner\n# Planner Handoff: Continue native workflow\n- handoff.ts writes structured Markdown under .pi/handoffs/.",
	);
}

function handoffWithCreatedOnlyInSections(): string {
	return handoffWithoutCreatedAt().replace(
		"## Current Facts With Provenance\n- handoff.ts writes structured Markdown under .pi/handoffs/.",
		"## Current Facts With Provenance\nCreated: 2026-08-23T10:11:12.000Z\n- handoff.ts writes structured Markdown under .pi/handoffs/.",
	);
}

describe("handoff status tool", () => {
	test("validates a complete handoff under .pi/handoffs", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-handoff-status-"));
		try {
			const handoffPath = join(cwd, ".pi/handoffs/complete.md");
			mkdirSync(join(cwd, ".pi/handoffs"), { recursive: true });
			writeFileSync(handoffPath, completeHandoff(), "utf8");
			const tool = createHandoffStatusTool(cwd);

			const result = await tool.execute(
				"handoff-status-call",
				{ path: ".pi/handoffs/complete.md" },
				undefined,
				undefined,
			);

			expect(result.details).toMatchObject({
				path: ".pi/handoffs/complete.md",
				valid: true,
				missingSections: [],
				profile: "planner",
				title: "Continue native workflow",
				createdAt: "2026-08-23T10:11:12.000Z",
			});
			expect(result.details.staleStateChecks).toEqual([
				"re-check git status before editing",
				"verify referenced file existence",
				"re-read relevant snippets or revisions before relying on handoff facts",
				"rerun or re-evaluate commands the plan depends on before broad execution",
			]);
			const textContent = result.content.find((part) => part.type === "text");
			expect(textContent?.text).toContain("Handoff is complete");
			expect(textContent?.text).toContain("re-check git status");
			expect(textContent?.text).toContain("file existence");
			expect(textContent?.text).toContain("snippets or revisions");
			expect(textContent?.text).toContain("Handoff content:");
			expect(textContent?.text).toContain("# Planner Handoff: Continue native workflow");
			expect(textContent?.text).toContain("## Goal");
			expect(textContent?.text).toContain("Continue the native planner/executor handoff workflow.");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("reports missing required sections", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-handoff-status-"));
		try {
			const handoffPath = join(cwd, ".pi/handoffs/incomplete.md");
			mkdirSync(join(cwd, ".pi/handoffs"), { recursive: true });
			writeFileSync(handoffPath, "# Planner Handoff: Incomplete\n\n## Goal\nKeep going.\n", "utf8");
			const tool = createHandoffStatusTool(cwd);

			const result = await tool.execute(
				"handoff-status-call",
				{ path: ".pi/handoffs/incomplete.md" },
				undefined,
				undefined,
			);

			expect(result.details.valid).toBe(false);
			expect(result.details.missingSections).toContain("Files Inspected");
			expect(result.details.missingSections).toContain("Stale-State Checks");
			const textContent = result.content.find((part) => part.type === "text");
			expect(textContent?.text).toContain("Missing required sections");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("reports placeholder-only required sections", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-handoff-status-"));
		try {
			const handoffPath = join(cwd, ".pi/handoffs/empty-facts.md");
			mkdirSync(join(cwd, ".pi/handoffs"), { recursive: true });
			writeFileSync(handoffPath, handoffWithEmptyFacts(), "utf8");
			const tool = createHandoffStatusTool(cwd);

			const result = await tool.execute(
				"handoff-status-call",
				{ path: ".pi/handoffs/empty-facts.md" },
				undefined,
				undefined,
			);

			expect(result.details.valid).toBe(false);
			expect(result.details.emptySections).toContain("Current Facts With Provenance");
			const textContent = result.content.find((part) => part.type === "text");
			expect(textContent?.text).toContain("Empty required sections");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("reports not-recorded list placeholders", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-handoff-status-"));
		try {
			const handoffPath = join(cwd, ".pi/handoffs/not-recorded-facts.md");
			mkdirSync(join(cwd, ".pi/handoffs"), { recursive: true });
			writeFileSync(handoffPath, handoffWithNotRecordedFacts(), "utf8");
			const tool = createHandoffStatusTool(cwd);

			const result = await tool.execute(
				"handoff-status-call",
				{ path: ".pi/handoffs/not-recorded-facts.md" },
				undefined,
				undefined,
			);

			expect(result.details.valid).toBe(false);
			expect(result.details.emptySections).toContain("Current Facts With Provenance");
			const textContent = result.content.find((part) => part.type === "text");
			expect(textContent?.text).toContain("Empty required sections");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("reports sections containing only placeholder lines", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-handoff-status-"));
		try {
			const handoffPath = join(cwd, ".pi/handoffs/multiple-placeholder-facts.md");
			mkdirSync(join(cwd, ".pi/handoffs"), { recursive: true });
			writeFileSync(handoffPath, handoffWithMultipleFactPlaceholders(), "utf8");
			const tool = createHandoffStatusTool(cwd);

			const result = await tool.execute(
				"handoff-status-call",
				{ path: ".pi/handoffs/multiple-placeholder-facts.md" },
				undefined,
				undefined,
			);

			expect(result.details.valid).toBe(false);
			expect(result.details.emptySections).toContain("Current Facts With Provenance");
			const textContent = result.content.find((part) => part.type === "text");
			expect(textContent?.text).toContain("Empty required sections");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("accepts sections that include real content after placeholder lines", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-handoff-status-"));
		try {
			const handoffPath = join(cwd, ".pi/handoffs/placeholder-and-real-facts.md");
			mkdirSync(join(cwd, ".pi/handoffs"), { recursive: true });
			writeFileSync(handoffPath, handoffWithPlaceholderAndRealFacts(), "utf8");
			const tool = createHandoffStatusTool(cwd);

			const result = await tool.execute(
				"handoff-status-call",
				{ path: ".pi/handoffs/placeholder-and-real-facts.md" },
				undefined,
				undefined,
			);

			expect(result.details.valid).toBe(true);
			expect(result.details.emptySections).not.toContain("Current Facts With Provenance");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("reports not-recorded required sections", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-handoff-status-"));
		try {
			const handoffPath = join(cwd, ".pi/handoffs/unrecorded-goal.md");
			mkdirSync(join(cwd, ".pi/handoffs"), { recursive: true });
			writeFileSync(handoffPath, handoffWithUnrecordedGoal(), "utf8");
			const tool = createHandoffStatusTool(cwd);

			const result = await tool.execute(
				"handoff-status-call",
				{ path: ".pi/handoffs/unrecorded-goal.md" },
				undefined,
				undefined,
			);

			expect(result.details.valid).toBe(false);
			expect(result.details.emptySections).toContain("Goal");
			const textContent = result.content.find((part) => part.type === "text");
			expect(textContent?.text).toContain("Empty required sections");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("reports duplicate required sections", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-handoff-status-"));
		try {
			const handoffPath = join(cwd, ".pi/handoffs/duplicate-goal.md");
			mkdirSync(join(cwd, ".pi/handoffs"), { recursive: true });
			writeFileSync(handoffPath, handoffWithDuplicateGoal(), "utf8");
			const tool = createHandoffStatusTool(cwd);

			const result = await tool.execute(
				"handoff-status-call",
				{ path: ".pi/handoffs/duplicate-goal.md" },
				undefined,
				undefined,
			);

			expect(result.details.valid).toBe(false);
			expect(result.details.duplicateSections).toContain("Goal");
			const textContent = result.content.find((part) => part.type === "text");
			expect(textContent?.text).toContain("Duplicate required sections");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("reports missing generated metadata", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-handoff-status-"));
		try {
			const handoffPath = join(cwd, ".pi/handoffs/missing-metadata.md");
			mkdirSync(join(cwd, ".pi/handoffs"), { recursive: true });
			writeFileSync(handoffPath, handoffWithoutMetadata(), "utf8");
			const tool = createHandoffStatusTool(cwd);

			const result = await tool.execute(
				"handoff-status-call",
				{ path: ".pi/handoffs/missing-metadata.md" },
				undefined,
				undefined,
			);

			expect(result.details.valid).toBe(false);
			expect(result.details.missingMetadata).toEqual(["profile", "title"]);
			const textContent = result.content.find((part) => part.type === "text");
			expect(textContent?.text).toContain("Handoff is invalid");
			expect(textContent?.text).toContain("Missing required metadata");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("reports missing created metadata", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-handoff-status-"));
		try {
			const handoffPath = join(cwd, ".pi/handoffs/missing-created.md");
			mkdirSync(join(cwd, ".pi/handoffs"), { recursive: true });
			writeFileSync(handoffPath, handoffWithoutCreatedAt(), "utf8");
			const tool = createHandoffStatusTool(cwd);

			const result = await tool.execute(
				"handoff-status-call",
				{ path: ".pi/handoffs/missing-created.md" },
				undefined,
				undefined,
			);

			expect(result.details.valid).toBe(false);
			expect(result.details.missingMetadata).toContain("createdAt");
			const textContent = result.content.find((part) => part.type === "text");
			expect(textContent?.text).toContain("Missing required metadata");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("ignores profile and title metadata after the preamble", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-handoff-status-"));
		try {
			const handoffPath = join(cwd, ".pi/handoffs/late-metadata.md");
			mkdirSync(join(cwd, ".pi/handoffs"), { recursive: true });
			writeFileSync(handoffPath, handoffWithMetadataOnlyInSections(), "utf8");
			const tool = createHandoffStatusTool(cwd);

			const result = await tool.execute(
				"handoff-status-call",
				{ path: ".pi/handoffs/late-metadata.md" },
				undefined,
				undefined,
			);

			expect(result.details.valid).toBe(false);
			expect(result.details.missingMetadata).toEqual(["profile", "title"]);
			const textContent = result.content.find((part) => part.type === "text");
			expect(textContent?.text).toContain("Missing required metadata");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("ignores created metadata after the preamble", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-handoff-status-"));
		try {
			const handoffPath = join(cwd, ".pi/handoffs/late-created.md");
			mkdirSync(join(cwd, ".pi/handoffs"), { recursive: true });
			writeFileSync(handoffPath, handoffWithCreatedOnlyInSections(), "utf8");
			const tool = createHandoffStatusTool(cwd);

			const result = await tool.execute(
				"handoff-status-call",
				{ path: ".pi/handoffs/late-created.md" },
				undefined,
				undefined,
			);

			expect(result.details.valid).toBe(false);
			expect(result.details.missingMetadata).toEqual(["createdAt"]);
			const textContent = result.content.find((part) => part.type === "text");
			expect(textContent?.text).toContain("Missing required metadata");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("reports invalid created metadata", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-handoff-status-"));
		try {
			const handoffPath = join(cwd, ".pi/handoffs/invalid-created.md");
			mkdirSync(join(cwd, ".pi/handoffs"), { recursive: true });
			writeFileSync(handoffPath, handoffWithInvalidCreatedAt(), "utf8");
			const tool = createHandoffStatusTool(cwd);

			const result = await tool.execute(
				"handoff-status-call",
				{ path: ".pi/handoffs/invalid-created.md" },
				undefined,
				undefined,
			);

			expect(result.details.valid).toBe(false);
			expect(result.details.metadataMismatches).toContain("createdAt");
			const textContent = result.content.find((part) => part.type === "text");
			expect(textContent?.text).toContain("Mismatched metadata");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("reports non-canonical created metadata", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-handoff-status-"));
		try {
			const handoffPath = join(cwd, ".pi/handoffs/non-canonical-created.md");
			mkdirSync(join(cwd, ".pi/handoffs"), { recursive: true });
			writeFileSync(handoffPath, handoffWithNonCanonicalCreatedAt(), "utf8");
			const tool = createHandoffStatusTool(cwd);

			const result = await tool.execute(
				"handoff-status-call",
				{ path: ".pi/handoffs/non-canonical-created.md" },
				undefined,
				undefined,
			);

			expect(result.details.valid).toBe(false);
			expect(result.details.metadataMismatches).toContain("createdAt");
			const textContent = result.content.find((part) => part.type === "text");
			expect(textContent?.text).toContain("Mismatched metadata");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("reports mismatched generated profile metadata", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-handoff-status-"));
		try {
			const handoffPath = join(cwd, ".pi/handoffs/mismatched-profile.md");
			mkdirSync(join(cwd, ".pi/handoffs"), { recursive: true });
			writeFileSync(handoffPath, handoffWithMismatchedProfile(), "utf8");
			const tool = createHandoffStatusTool(cwd);

			const result = await tool.execute(
				"handoff-status-call",
				{ path: ".pi/handoffs/mismatched-profile.md" },
				undefined,
				undefined,
			);

			expect(result.details.valid).toBe(false);
			expect(result.details.metadataMismatches).toEqual(["profile"]);
			const textContent = result.content.find((part) => part.type === "text");
			expect(textContent?.text).toContain("Handoff is invalid");
			expect(textContent?.text).toContain("Mismatched metadata");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("reports duplicate generated metadata", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-handoff-status-"));
		try {
			const handoffPath = join(cwd, ".pi/handoffs/duplicate-profile.md");
			mkdirSync(join(cwd, ".pi/handoffs"), { recursive: true });
			writeFileSync(handoffPath, handoffWithDuplicateProfileMetadata(), "utf8");
			const tool = createHandoffStatusTool(cwd);

			const result = await tool.execute(
				"handoff-status-call",
				{ path: ".pi/handoffs/duplicate-profile.md" },
				undefined,
				undefined,
			);

			expect(result.details.valid).toBe(false);
			expect(result.details.duplicateMetadata).toEqual(["profile"]);
			const textContent = result.content.find((part) => part.type === "text");
			expect(textContent?.text).toContain("Duplicate metadata");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("accepts absolute paths under .pi/handoffs", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-handoff-status-"));
		try {
			const handoffPath = join(cwd, ".pi/handoffs/absolute.md");
			mkdirSync(join(cwd, ".pi/handoffs"), { recursive: true });
			writeFileSync(handoffPath, completeHandoff(), "utf8");
			const tool = createHandoffStatusTool(cwd);

			const result = await tool.execute("handoff-status-call", { path: handoffPath }, undefined, undefined);

			expect(result.details.path).toBe(".pi/handoffs/absolute.md");
			expect(result.details.valid).toBe(true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("rejects paths outside .pi/handoffs", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-handoff-status-"));
		try {
			const tool = createHandoffStatusTool(cwd);

			await expect(
				tool.execute("handoff-status-call", { path: "notes/handoff.md" }, undefined, undefined),
			).rejects.toThrow("Handoff path must be under .pi/handoffs/");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("rejects non-Markdown handoff paths", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-handoff-status-"));
		try {
			const handoffPath = join(cwd, ".pi/handoffs/not-markdown.txt");
			mkdirSync(join(cwd, ".pi/handoffs"), { recursive: true });
			writeFileSync(handoffPath, completeHandoff(), "utf8");
			const tool = createHandoffStatusTool(cwd);

			await expect(
				tool.execute("handoff-status-call", { path: ".pi/handoffs/not-markdown.txt" }, undefined, undefined),
			).rejects.toThrow("Handoff path must be a Markdown file under .pi/handoffs/");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("rejects symlinked handoff paths that resolve outside .pi/handoffs", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-handoff-status-"));
		try {
			mkdirSync(join(cwd, ".pi/handoffs"), { recursive: true });
			const outsidePath = join(cwd, "outside.md");
			writeFileSync(outsidePath, completeHandoff(), "utf8");
			symlinkSync(outsidePath, join(cwd, ".pi/handoffs/linked.md"));
			const tool = createHandoffStatusTool(cwd);

			await expect(
				tool.execute("handoff-status-call", { path: ".pi/handoffs/linked.md" }, undefined, undefined),
			).rejects.toThrow("Handoff path must be under .pi/handoffs/");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("rejects symlinked handoff directories that resolve outside the workspace handoff path", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-handoff-status-"));
		const outsideDir = mkdtempSync(join(tmpdir(), "pi-handoff-status-outside-"));
		try {
			mkdirSync(join(cwd, ".pi"), { recursive: true });
			writeFileSync(join(outsideDir, "handoff.md"), completeHandoff(), "utf8");
			symlinkSync(outsideDir, join(cwd, ".pi/handoffs"));
			const tool = createHandoffStatusTool(cwd);

			await expect(
				tool.execute("handoff-status-call", { path: ".pi/handoffs/handoff.md" }, undefined, undefined),
			).rejects.toThrow("Handoff path must be under .pi/handoffs/");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(outsideDir, { recursive: true, force: true });
		}
	});

	test("reports missing handoff files clearly", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-handoff-status-"));
		try {
			const tool = createHandoffStatusTool(cwd);

			await expect(
				tool.execute("handoff-status-call", { path: ".pi/handoffs/missing.md" }, undefined, undefined),
			).rejects.toThrow("Handoff file not found under .pi/handoffs/");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
