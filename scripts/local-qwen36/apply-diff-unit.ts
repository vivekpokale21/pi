#!/usr/bin/env -S node --import tsx
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyUnifiedDiff, createApplyDiffTool } from "./apply-diff.ts";
import { EXECUTOR_TOOL_NAMES, isPlannerToolAllowed, PLANNER_TOOL_NAMES } from "./read-only.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-apply-diff-"));
	try {
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function appliesPatchAfterDryRun(): Promise<void> {
	await withTempDir(async (dir) => {
		const path = join(dir, "sample.txt");
		await writeFile(path, "alpha\nbeta\ngamma\n", "utf8");
		const patch = [
			"--- sample.txt",
			"+++ sample.txt",
			"@@ -1,3 +1,3 @@",
			" alpha",
			"-beta",
			"+BETA",
			" gamma",
			"",
		].join("\n");

		const result = await applyUnifiedDiff({ cwd: dir, patch });

		assert.equal(await readFile(path, "utf8"), "alpha\nBETA\ngamma\n");
		assert.equal(result.appliedFiles.length, 1);
		assert.equal(result.appliedFiles[0].path, "sample.txt");
		assert.equal(result.appliedFiles[0].changed, true);
		assert.match(result.appliedFiles[0].diff, /-beta/);
		assert.match(result.appliedFiles[0].diff, /\+BETA/);
	});
}

async function dryRunFailureDoesNotWriteAnyFile(): Promise<void> {
	await withTempDir(async (dir) => {
		const first = join(dir, "first.txt");
		const second = join(dir, "second.txt");
		await writeFile(first, "one\ntwo\n", "utf8");
		await writeFile(second, "red\nblue\n", "utf8");
		const patch = [
			"--- first.txt",
			"+++ first.txt",
			"@@ -1,2 +1,2 @@",
			" one",
			"-two",
			"+TWO",
			"--- second.txt",
			"+++ second.txt",
			"@@ -1,2 +1,2 @@",
			" red",
			"-missing",
			"+GREEN",
			"",
		].join("\n");

		await assert.rejects(() => applyUnifiedDiff({ cwd: dir, patch }), /patch dry-run failed for second.txt/);
		assert.equal(await readFile(first, "utf8"), "one\ntwo\n");
		assert.equal(await readFile(second, "utf8"), "red\nblue\n");
	});
}

async function rejectsWorkspaceEscape(): Promise<void> {
	await withTempDir(async (dir) => {
		const patch = [
			"--- ../outside.txt",
			"+++ ../outside.txt",
			"@@ -0,0 +1 @@",
			"+unsafe",
			"",
		].join("\n");

		await assert.rejects(() => applyUnifiedDiff({ cwd: dir, patch }), /escapes workspace/);
	});
}

async function toolUsesExecutorNameAndPlannerBlocksIt(): Promise<void> {
	const tool = createApplyDiffTool(process.cwd());
	assert.equal(tool.name, "apply_diff");
	assert.equal(isPlannerToolAllowed(tool.name), false);
	assert.equal(EXECUTOR_TOOL_NAMES.includes("apply_diff"), true);
	assert.equal(PLANNER_TOOL_NAMES.includes("apply_diff"), false);
}

await appliesPatchAfterDryRun();
await dryRunFailureDoesNotWriteAnyFile();
await rejectsWorkspaceEscape();
await toolUsesExecutorNameAndPlannerBlocksIt();
console.log("apply-diff-unit: ok");
