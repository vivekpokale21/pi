import { appendHierarchicalMemoryToSystemPrompt, compactHierarchicalMemory } from "./memory-compaction.ts";

export function buildQwen36ProfileMemoryBlock(_taskText = ""): string {
	return compactHierarchicalMemory({
		working: [
			"previous verifier failure: preserve apply_diff gating",
			"timeline: local Qwen3.6 harness uses planner/executor profile switching",
			"timeline: deterministic diff application is executor-only",
			"repair: keep fixed llama.cpp launcher local-only",
		],
		persistent: "Port slices 01-04 established fixed Qwen3.6 llama.cpp backend, planner/executor split, executor-only apply_diff, and supervised launcher backoff.",
		budgets: {
			maxFocusChars: 240,
			maxTimelineChars: 220,
			maxPersistentChars: 260,
		},
	}).block;
}

export function buildQwen36SystemPromptWithMemory(systemPrompt: string, taskText = ""): string {
	return appendHierarchicalMemoryToSystemPrompt(systemPrompt, buildQwen36ProfileMemoryBlock(taskText));
}
