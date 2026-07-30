#!/usr/bin/env -S node --import tsx
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadFileTool } from "./read-file.ts";
import { EXECUTOR_TOOL_NAMES, isPlannerToolAllowed, PLANNER_TOOL_NAMES } from "./read-only.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-read-file-"));
	try {
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function readsBoundedLineRange(): Promise<void> {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "app"), { recursive: true });
		await writeFile(join(dir, "app", "api.py"), "one\ntwo\nthree\nfour\n", "utf8");
		const tool = createReadFileTool(dir);
		const result = await tool.execute(
			"read-api",
			{ path: "app/api.py", startLine: 2, maxLines: 2 },
			undefined,
			undefined,
			undefined,
		);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		assert.match(text, /app\/api.py:2-3/);
		assert.match(text, /2: two/);
		assert.match(text, /3: three/);
		assert.doesNotMatch(text, /4: four/);
	});
}

async function rejectsWorkspaceEscape(): Promise<void> {
	await withTempDir(async (dir) => {
		const tool = createReadFileTool(dir);
		await assert.rejects(
			() => tool.execute("read-escape", { path: "../outside.txt" }, undefined, undefined, undefined),
			/path escapes workspace/,
		);
	});
}

function toolIsReadOnlyForProfiles(): void {
	const tool = createReadFileTool(process.cwd());
	assert.equal(tool.name, "read_file");
	assert.equal(isPlannerToolAllowed(tool.name), true);
	assert.equal(PLANNER_TOOL_NAMES.includes("read_file"), true);
	assert.equal(EXECUTOR_TOOL_NAMES.includes("read_file"), true);
}

await readsBoundedLineRange();
await rejectsWorkspaceEscape();
toolIsReadOnlyForProfiles();
console.log("read-file-unit: ok");
