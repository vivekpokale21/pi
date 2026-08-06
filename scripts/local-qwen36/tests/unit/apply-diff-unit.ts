#!/usr/bin/env -S node --import tsx
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyUnifiedDiff, createApplyDiffTool } from "../../apply-diff.ts";
import { EXECUTOR_TOOL_NAMES, isPlannerToolAllowed, PLANNER_TOOL_NAMES } from "../../read-only.ts";

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
		assert.equal(result.appliedFiles[0].verification.status, "verified");
		assert.match(result.appliedFiles[0].verification.expectedSha256, /^[a-f0-9]{64}$/);
		assert.equal(result.appliedFiles[0].verification.expectedSha256, result.appliedFiles[0].verification.actualSha256);
		assert.deepEqual(result.appliedFiles[0].changedLineRanges, [{ startLine: 2, endLine: 2 }]);
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

		await assert.rejects(() => applyUnifiedDiff({ cwd: dir, patch }), /No matching region found for second\.txt hunk 1/);
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

async function appliesValidNewFilePatch(): Promise<void> {
	await withTempDir(async (dir) => {
		const patch = [
			"--- /dev/null",
			"+++ b/tests/example.py",
			"@@ -0,0 +1,4 @@",
			"+import unittest",
			"+",
			"+class ExampleTests(unittest.TestCase):",
			"+    pass",
			"",
		].join("\n");

		const result = await applyUnifiedDiff({ cwd: dir, patch });

		assert.equal(await readFile(join(dir, "tests/example.py"), "utf8"), "import unittest\n\nclass ExampleTests(unittest.TestCase):\n    pass\n");
		assert.equal(result.appliedFiles[0]?.path, "tests/example.py");
	});
}

async function normalizesMalformedHunkCountsBeforeApplying(): Promise<void> {
	await withTempDir(async (dir) => {
		const existing = join(dir, "existing.txt");
		await writeFile(existing, "alpha\nbeta\ngamma\n", "utf8");
		const patch = [
			"--- existing.txt",
			"+++ existing.txt",
			"@@ -1,99 +1,99 @@",
			" alpha",
			"-beta",
			"+BETA",
			" gamma",
			"--- /dev/null",
			"+++ b/tests/example.py",
			"@@ -0,0 +1,99 @@",
			"+import unittest",
			"+",
			"+class ExampleTests(unittest.TestCase):",
			"+    pass",
			"",
		].join("\n");

		const result = await applyUnifiedDiff({ cwd: dir, patch });

		assert.equal(await readFile(existing, "utf8"), "alpha\nBETA\ngamma\n");
		assert.equal(await readFile(join(dir, "tests/example.py"), "utf8"), "import unittest\n\nclass ExampleTests(unittest.TestCase):\n    pass\n");
		assert.equal(result.normalizedHunks.length, 2);
		assert.deepEqual(
			result.normalizedHunks.map((hunk) => [hunk.path, hunk.from, hunk.to]),
			[
				["existing.txt", "@@ -1,99 +1,99 @@", "@@ -1,3 +1,3 @@"],
				["tests/example.py", "@@ -0,0 +1,99 @@", "@@ -0,0 +1,4 @@"],
			],
		);
	});
}

async function appliesPatchWhenHunkStartLineIsWrong(): Promise<void> {
	await withTempDir(async (dir) => {
		const path = join(dir, "sample.txt");
		await writeFile(path, "alpha\nbeta\ngamma\ndelta\n", "utf8");
		const patch = [
			"--- sample.txt",
			"+++ sample.txt",
			"@@ -99,3 +99,3 @@",
			" alpha",
			"-beta",
			"+BETA",
			" gamma",
			"",
		].join("\n");

		const result = await applyUnifiedDiff({ cwd: dir, patch });

		assert.equal(await readFile(path, "utf8"), "alpha\nBETA\ngamma\ndelta\n");
		assert.equal(result.appliedFiles[0]?.hunksApplied, 1);
		assert.deepEqual(result.appliedFiles[0]?.changedLineRanges, [{ startLine: 2, endLine: 2 }]);
		assert.match(result.appliedFiles[0]?.previews[0]?.after ?? "", /2: BETA/);
	});
}

async function appliesPatchToCrlfFileWithLfPatchAndPreservesCrlf(): Promise<void> {
	await withTempDir(async (dir) => {
		const path = join(dir, "sample.txt");
		await writeFile(path, "alpha\r\nbeta\r\ngamma\r\n", "utf8");
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

		assert.equal(await readFile(path, "utf8"), "alpha\r\nBETA\r\ngamma\r\n");
		assert.equal(result.appliedFiles[0]?.verification.status, "verified");
		assert.equal(result.appliedFiles[0]?.lineEnding, "CRLF");
	});
}

async function trimsExcessLeadingAndTrailingContextWhenUnique(): Promise<void> {
	await withTempDir(async (dir) => {
		const path = join(dir, "sample.txt");
		await writeFile(path, "alpha\nbeta\ngamma\n", "utf8");
		const patch = [
			"--- sample.txt",
			"+++ sample.txt",
			"@@ -1,5 +1,5 @@",
			" before",
			" alpha",
			"-beta",
			"+BETA",
			" gamma",
			" after",
			"",
		].join("\n");

		const result = await applyUnifiedDiff({ cwd: dir, patch });

		assert.equal(await readFile(path, "utf8"), "alpha\nBETA\ngamma\n");
		assert.equal(result.appliedFiles[0]?.appliedHunks[0]?.matchStrategy, "trimmed-context");
		assert.deepEqual(result.appliedFiles[0]?.appliedHunks[0]?.trimmedContext, { leading: 1, trailing: 1 });
	});
}

async function appliesWhitespaceTolerantMatchOnlyWhenUnique(): Promise<void> {
	await withTempDir(async (dir) => {
		const path = join(dir, "sample.txt");
		await writeFile(path, "alpha\n  beta\ngamma\n", "utf8");
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
		assert.equal(result.appliedFiles[0]?.appliedHunks[0]?.matchStrategy, "whitespace-tolerant");
	});
}

async function appliesMultipleHunksInOneFile(): Promise<void> {
	await withTempDir(async (dir) => {
		const path = join(dir, "sample.txt");
		await writeFile(path, "one\ntwo\nthree\nfour\nfive\nsix\n", "utf8");
		const patch = [
			"--- sample.txt",
			"+++ sample.txt",
			"@@ -1,2 +1,2 @@",
			" one",
			"-two",
			"+TWO",
			"@@ -5,2 +5,2 @@",
			" five",
			"-six",
			"+SIX",
			"",
		].join("\n");

		const result = await applyUnifiedDiff({ cwd: dir, patch });

		assert.equal(await readFile(path, "utf8"), "one\nTWO\nthree\nfour\nfive\nSIX\n");
		assert.equal(result.appliedFiles[0]?.hunksApplied, 2);
		assert.deepEqual(result.appliedFiles[0]?.changedLineRanges, [{ startLine: 2, endLine: 6 }]);
	});
}

async function ambiguousRepeatedContextFailsWithoutWriting(): Promise<void> {
	await withTempDir(async (dir) => {
		const path = join(dir, "sample.txt");
		await writeFile(path, "x\na\nb\nc\ny\na\nb\nc\nz\n", "utf8");
		const patch = [
			"--- sample.txt",
			"+++ sample.txt",
			"@@ -99,3 +99,3 @@",
			" a",
			"-b",
			"+B",
			" c",
			"",
		].join("\n");

		await assert.rejects(() => applyUnifiedDiff({ cwd: dir, patch }), /Multiple candidate regions found.*sample\.txt/s);
		assert.equal(await readFile(path, "utf8"), "x\na\nb\nc\ny\na\nb\nc\nz\n");
	});
}

async function staleBaseHashFailsBeforeWriting(): Promise<void> {
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

		await assert.rejects(
			() => applyUnifiedDiff({ cwd: dir, patch, baseSha256: "0000000000000000000000000000000000000000000000000000000000000000" }),
			/File revision changed since it was read.*sample\.txt/s,
		);
		assert.equal(await readFile(path, "utf8"), "alpha\nbeta\ngamma\n");
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
await appliesValidNewFilePatch();
await normalizesMalformedHunkCountsBeforeApplying();
await appliesPatchWhenHunkStartLineIsWrong();
await appliesPatchToCrlfFileWithLfPatchAndPreservesCrlf();
await trimsExcessLeadingAndTrailingContextWhenUnique();
await appliesWhitespaceTolerantMatchOnlyWhenUnique();
await appliesMultipleHunksInOneFile();
await ambiguousRepeatedContextFailsWithoutWriting();
await staleBaseHashFailsBeforeWriting();
await toolUsesExecutorNameAndPlannerBlocksIt();
console.log("apply-diff-unit: ok");
