#!/usr/bin/env -S node --import tsx
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendHierarchicalMemoryToSystemPrompt,
	classifyMemoryLine,
	compactHierarchicalMemory,
	loadRecentPersistentSummary,
} from "./memory-compaction.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-memory-compaction-"));
	try {
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function focusSurvivesTightBudget(): void {
	const result = compactHierarchicalMemory({
		working: [
			"timeline: read docs/ports/INDEX.md",
			"failure: profile smoke lost apply_diff gating",
			"timeline: inspected profile-smoke.ts",
			"repair: restore executor-only apply_diff policy",
			"timeline: ran local checks",
		],
		persistent: "previous persistent summary for qwen harness",
		budgets: { maxFocusChars: 96, maxTimelineChars: 20, maxPersistentChars: 80 },
	});

	assert.match(result.block, /<qwen36_memory>/);
	assert.match(result.block, /failure: profile smoke lost apply_diff gating/);
	assert.match(result.block, /repair: restore executor-only apply_diff policy/);
	assert.doesNotMatch(result.block, /inspected profile-smoke/);
	assert.match(result.block, /previous persistent summary/);
	assert.equal(result.focus.length, 2);
	assert.equal(result.omittedTimeline, 3);
}

function dedupesAndClassifiesLines(): void {
	assert.equal(classifyMemoryLine("BLOCKER: tests failing"), "focus");
	assert.equal(classifyMemoryLine("normal timeline update"), "timeline");

	const result = compactHierarchicalMemory({
		working: ["failure: same issue", "Failure: same issue", "timeline: one", "timeline: one"],
		budgets: { maxFocusChars: 200, maxTimelineChars: 200, maxPersistentChars: 0 },
	});
	assert.equal(result.focus.length, 1);
	assert.equal(result.timeline.length, 1);
	assert.equal(result.removedDuplicates, 2);
}

async function persistentSeedPrefersTaskOverlap(): Promise<void> {
	await withTempDir(async (dir) => {
		await writeFile(
			join(dir, "old.json"),
			JSON.stringify({
				run_id: "old",
				saved_unix: 10,
				persistent_summary: "semantic search checkpoint with unrelated notes",
			}),
			"utf8",
		);
		await writeFile(
			join(dir, "newest.json"),
			JSON.stringify({
				run_id: "newest",
				saved_unix: 30,
				persistent_summary: "frontend polish checkpoint",
			}),
			"utf8",
		);
		await writeFile(
			join(dir, "relevant.json"),
			JSON.stringify({
				run_id: "relevant",
				saved_unix: 20,
				persistent_summary: "qwen apply_diff memory compaction checkpoint",
			}),
			"utf8",
		);

		const relevant = await loadRecentPersistentSummary({ directory: dir, taskText: "continue qwen memory compaction" });
		assert.equal(relevant?.runId, "relevant");
		assert.match(relevant?.summary ?? "", /memory compaction/);

		const fallback = await loadRecentPersistentSummary({ directory: dir, taskText: "no lexical overlap here" });
		assert.equal(fallback?.runId, "newest");
	});
}

function appendsPromptMemoryOnlyWhenPresent(): void {
	const memory = compactHierarchicalMemory({
		working: ["failure: keep this"],
		persistent: "prior run seed",
		budgets: { maxFocusChars: 200, maxTimelineChars: 200, maxPersistentChars: 200 },
	});
	const prompt = appendHierarchicalMemoryToSystemPrompt("base prompt", memory.block);
	assert.match(prompt, /^base prompt\n\n<qwen36_memory>/);
	assert.equal(appendHierarchicalMemoryToSystemPrompt("base prompt", ""), "base prompt");
}

focusSurvivesTightBudget();
dedupesAndClassifiesLines();
await persistentSeedPrefersTaskOverlap();
appendsPromptMemoryOnlyWhenPresent();
console.log("memory-compaction-unit: ok");
