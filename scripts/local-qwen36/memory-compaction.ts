import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export type MemoryLineClass = "focus" | "timeline";

export interface HierarchicalMemoryBudgets {
	maxFocusChars: number;
	maxTimelineChars: number;
	maxPersistentChars: number;
}

export interface CompactHierarchicalMemoryInput {
	working: string[];
	persistent?: string;
	budgets: HierarchicalMemoryBudgets;
}

export interface CompactHierarchicalMemoryResult {
	block: string;
	focus: string[];
	timeline: string[];
	persistent: string;
	removedDuplicates: number;
	omittedFocus: number;
	omittedTimeline: number;
}

export interface PersistentSummarySeed {
	runId: string;
	summary: string;
	score: number;
	timestamp: number;
}

const FOCUS_PATTERNS = [
	/\bfail(?:ed|ure|ing)?\b/i,
	/\bblock(?:ed|er|ing)?\b/i,
	/\berror\b/i,
	/\brepair\b/i,
	/\bregression\b/i,
	/\bverify\b/i,
	/\btest\b.*\b(?:fail|red)\b/i,
	/\bcooldown\b/i,
	/\bcrash\b/i,
];

function normalizeLine(text: string): string {
	return text.split(/\s+/).filter(Boolean).join(" ").trim();
}

function dedupeKey(text: string): string {
	return normalizeLine(text).toLowerCase();
}

function charCount(lines: string[]): number {
	return lines.join("\n").length;
}

function truncateToChars(text: string, maxChars: number): string {
	if (maxChars <= 0) return "";
	if (text.length <= maxChars) return text;
	if (maxChars === 1) return "…";
	return `${text.slice(0, maxChars - 1)}…`;
}

function selectWithinBudget(lines: string[], maxChars: number): { selected: string[]; omitted: number } {
	if (maxChars <= 0) return { selected: [], omitted: lines.length };
	const selected: string[] = [];
	let omitted = 0;
	for (const line of lines) {
		const next = [...selected, line];
		if (charCount(next) <= maxChars) {
			selected.push(line);
		} else {
			omitted++;
		}
	}
	return { selected, omitted };
}

function formatBulletLines(lines: string[]): string {
	return lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : "- (none)";
}

export function classifyMemoryLine(text: string): MemoryLineClass {
	return FOCUS_PATTERNS.some((pattern) => pattern.test(text)) ? "focus" : "timeline";
}

export function compactHierarchicalMemory(
	input: CompactHierarchicalMemoryInput,
): CompactHierarchicalMemoryResult {
	const focus: string[] = [];
	const timeline: string[] = [];
	const seen = new Set<string>();
	let removedDuplicates = 0;

	for (const raw of input.working) {
		const line = normalizeLine(raw);
		if (!line) continue;
		const key = dedupeKey(line);
		if (seen.has(key)) {
			removedDuplicates++;
			continue;
		}
		seen.add(key);
		if (classifyMemoryLine(line) === "focus") {
			focus.push(line);
		} else {
			timeline.push(line);
		}
	}

	const selectedFocus = selectWithinBudget(focus, input.budgets.maxFocusChars);
	const selectedTimeline = selectWithinBudget(timeline, input.budgets.maxTimelineChars);
	const persistent = truncateToChars(normalizeLine(input.persistent ?? ""), input.budgets.maxPersistentChars);

	const sections = [
		"<qwen36_memory>",
		"<working>",
		"focus:",
		formatBulletLines(selectedFocus.selected),
		"timeline:",
		formatBulletLines(selectedTimeline.selected),
		"</working>",
		"<persistent>",
		persistent || "(none)",
		"</persistent>",
		"</qwen36_memory>",
	];

	return {
		block: sections.join("\n"),
		focus: selectedFocus.selected,
		timeline: selectedTimeline.selected,
		persistent,
		removedDuplicates,
		omittedFocus: selectedFocus.omitted,
		omittedTimeline: selectedTimeline.omitted,
	};
}

function tokenize(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9_./-]+/)
			.filter((token) => token.length >= 3),
	);
}

function overlapScore(taskText: string, summary: string): number {
	const task = tokenize(taskText);
	const candidate = tokenize(summary);
	let score = 0;
	for (const token of task) {
		if (candidate.has(token)) score++;
	}
	return score;
}

function readStringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

function readNumberField(record: Record<string, unknown>, ...keys: string[]): number | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

export async function loadRecentPersistentSummary(input: {
	directory: string;
	taskText: string;
}): Promise<PersistentSummarySeed | null> {
	const candidates: PersistentSummarySeed[] = [];
	let entries: string[];
	try {
		entries = await readdir(input.directory);
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error.code === "ENOENT" || error.code === "ENOTDIR")
		) {
			return null;
		}
		throw error;
	}

	for (const entry of entries.sort()) {
		if (!entry.endsWith(".json")) continue;
		const path = join(input.directory, entry);
		try {
			const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
			const summary = readStringField(parsed, "persistent_summary", "persistentSummary");
			if (!summary) continue;
			const fileStat = await stat(path);
			const timestamp =
				readNumberField(parsed, "saved_unix", "savedUnix", "created_unix", "createdUnix") ??
				fileStat.mtimeMs / 1000;
			candidates.push({
				runId: readStringField(parsed, "run_id", "runId") ?? entry.replace(/\.json$/i, ""),
				summary,
				score: overlapScore(input.taskText, summary),
				timestamp,
			});
		} catch {
			continue;
		}
	}

	if (candidates.length === 0) return null;
	candidates.sort((left, right) => {
		if (right.score !== left.score) return right.score - left.score;
		if (right.timestamp !== left.timestamp) return right.timestamp - left.timestamp;
		return left.runId.localeCompare(right.runId);
	});
	return candidates[0];
}

export function appendHierarchicalMemoryToSystemPrompt(systemPrompt: string, memoryBlock: string): string {
	const trimmed = memoryBlock.trim();
	if (!trimmed) return systemPrompt;
	return `${systemPrompt.trimEnd()}\n\n${trimmed}`;
}
