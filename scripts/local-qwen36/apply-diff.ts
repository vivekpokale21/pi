import type { AgentTool } from "../../packages/agent/src/index.ts";
import { Type, type Static } from "../../packages/ai/src/index.ts";
import { createTwoFilesPatch, parsePatch, type ParsedDiff } from "diff";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const applyDiffSchema = Type.Object({
	patch: Type.String({ description: "Unified diff to apply to local workspace files." }),
	baseSha256: Type.Optional(
		Type.String({
			description:
				"Optional SHA-256 of the file content observed before editing. For single-file edits, apply_diff fails if the current file hash differs.",
		}),
	),
});

type ApplyDiffParams = Static<typeof applyDiffSchema>;

export interface AppliedDiffFile {
	path: string;
	absolutePath: string;
	changed: boolean;
	diff: string;
	changedLineRanges: ChangedLineRange[];
	verification: AppliedDiffVerification;
	oldSha256: string;
	newSha256: string;
	hunksApplied: number;
	lineEnding: "LF" | "CRLF";
	appliedHunks: AppliedHunkReceipt[];
	previews: AppliedDiffPreview[];
}

export interface ChangedLineRange {
	startLine: number;
	endLine: number;
}

export interface AppliedDiffVerification {
	status: "verified";
	expectedSha256: string;
	actualSha256: string;
	expectedBytes: number;
	actualBytes: number;
}

export interface NormalizedDiffHunk {
	path: string;
	from: string;
	to: string;
}

export interface AppliedHunkReceipt {
	path: string;
	matchStrategy: HunkMatchStrategy;
	oldStart: number;
	oldEnd: number;
	newStart: number;
	newEnd: number;
	trimmedContext?: { leading: number; trailing: number };
}

export interface AppliedDiffPreview {
	path: string;
	startLine: number;
	endLine: number;
	before: string;
	after: string;
}

export interface ApplyUnifiedDiffResult {
	appliedFiles: AppliedDiffFile[];
	normalizedHunks: NormalizedDiffHunk[];
}

interface PlannedPatch {
	patch: ParsedDiff;
	relativePath: string;
	absolutePath: string;
	deletesFile: boolean;
}

interface DryRunFile {
	relativePath: string;
	absolutePath: string;
	originalContent: string;
	patchedContent: string;
	deletesFile: boolean;
	appliedHunks: AppliedHunkReceipt[];
	lineEnding: "LF" | "CRLF";
}

interface HunkHeader {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	raw: string;
	suffix: string;
}

type HunkLineKind = "context" | "delete" | "add";
type HunkMatchStrategy = "exact" | "line-ending-normalized" | "trimmed-context" | "whitespace-tolerant" | "header-insertion";

interface HunkLine {
	kind: HunkLineKind;
	text: string;
}

interface HunkVariant {
	lines: HunkLine[];
	leadingTrim: number;
	trailingTrim: number;
}

interface HunkMatch {
	startIndex: number;
	oldLength: number;
	newLines: string[];
	strategy: HunkMatchStrategy;
	leadingTrim: number;
	trailingTrim: number;
}

function stripDiffPrefix(fileName: string): string {
	if (fileName.startsWith("a/") || fileName.startsWith("b/")) return fileName.slice(2);
	return fileName;
}

function parseHunkHeader(line: string): HunkHeader | undefined {
	const match = /^(@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@)(.*)$/.exec(line);
	if (!match) return undefined;
	return {
		raw: match[1],
		oldStart: Number(match[2]),
		oldLines: Number(match[3] ?? "1"),
		newStart: Number(match[4]),
		newLines: Number(match[5] ?? "1"),
		suffix: match[6],
	};
}

function normalizePatchFileName(fileName: string): string {
	return stripDiffPrefix(fileName.trim());
}

function formatHunkRange(start: number, lines: number): string {
	return lines === 1 ? String(start) : `${start},${lines}`;
}

function formatHunkHeader(header: HunkHeader, oldLines: number, newLines: number): string {
	return `@@ -${formatHunkRange(header.oldStart, oldLines)} +${formatHunkRange(header.newStart, newLines)} @@${header.suffix}`;
}

function normalizePatchHunkCounts(patchText: string): { patchText: string; normalizedHunks: NormalizedDiffHunk[] } {
	const lines = patchText.split(/\r?\n/);
	let currentFile = "";
	const normalizedHunks: NormalizedDiffHunk[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line.startsWith("+++ ")) {
			currentFile = normalizePatchFileName(line.slice(4));
			continue;
		}
		const header = parseHunkHeader(line);
		if (!header) continue;

		let oldCount = 0;
		let newCount = 0;
		for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
			const bodyLine = lines[cursor];
			if (bodyLine.startsWith("@@ ") || bodyLine.startsWith("--- ") || bodyLine.startsWith("+++ ")) break;
			if (bodyLine.length === 0) continue;
			if (bodyLine.startsWith("+")) {
				newCount += 1;
			} else if (bodyLine.startsWith("-")) {
				oldCount += 1;
			} else if (bodyLine.startsWith(" ")) {
				oldCount += 1;
				newCount += 1;
			}
		}

		if (header.oldLines !== oldCount || header.newLines !== newCount) {
			const normalized = formatHunkHeader(header, oldCount, newCount);
			normalizedHunks.push({ path: currentFile, from: header.raw, to: normalized });
			lines[index] = normalized;
		}
	}
	return { patchText: lines.join("\n"), normalizedHunks };
}

function selectPatchPath(patch: ParsedDiff): { path: string; deletesFile: boolean } {
	const oldFileName = patch.oldFileName ?? "";
	const newFileName = patch.newFileName ?? "";
	if (newFileName && newFileName !== "/dev/null") {
		return { path: stripDiffPrefix(newFileName), deletesFile: false };
	}
	if (oldFileName && oldFileName !== "/dev/null") {
		return { path: stripDiffPrefix(oldFileName), deletesFile: newFileName === "/dev/null" };
	}
	throw new Error("patch target is missing a file name");
}

function isWithinWorkspace(candidate: string, workspaceRoot: string): boolean {
	return candidate === workspaceRoot || candidate.startsWith(`${workspaceRoot}${sep}`);
}

async function resolveExistingAncestor(path: string): Promise<string> {
	let current = path;
	while (true) {
		try {
			return await realpath(current);
		} catch (error) {
			if (
				typeof error !== "object" ||
				error === null ||
				!("code" in error) ||
				(error.code !== "ENOENT" && error.code !== "ENOTDIR")
			) {
				throw error;
			}
		}
		const parent = dirname(current);
		if (parent === current) return current;
		current = parent;
	}
}

async function resolvePatchPath(cwd: string, path: string): Promise<{ relativePath: string; absolutePath: string }> {
	if (!path || path === "/dev/null") throw new Error("patch target is missing a file name");
	if (isAbsolute(path)) throw new Error(`absolute patch paths are not allowed: ${path}`);

	const workspaceRoot = await realpath(cwd);
	const absolutePath = resolve(workspaceRoot, path);
	if (!isWithinWorkspace(absolutePath, workspaceRoot)) {
		throw new Error(`patch target ${path} escapes workspace ${workspaceRoot}`);
	}

	const existingTarget = await resolveExistingAncestor(absolutePath);
	if (!isWithinWorkspace(existingTarget, workspaceRoot)) {
		throw new Error(`patch target ${path} escapes workspace ${workspaceRoot}`);
	}

	return { relativePath: relative(workspaceRoot, absolutePath), absolutePath };
}

async function planPatches(cwd: string, patchText: string): Promise<PlannedPatch[]> {
	const parsed = parsePatch(patchText);
	if (parsed.length === 0) throw new Error("patch did not contain any file hunks");

	const planned: PlannedPatch[] = [];
	for (const patch of parsed) {
		if (!Array.isArray(patch.hunks) || patch.hunks.length === 0) {
			throw new Error("patch file entry did not contain any hunks");
		}
		const target = selectPatchPath(patch);
		const resolvedPath = await resolvePatchPath(cwd, target.path);
		planned.push({
			patch,
			relativePath: resolvedPath.relativePath,
			absolutePath: resolvedPath.absolutePath,
			deletesFile: target.deletesFile,
		});
	}
	return planned;
}

async function readTextFileForPatch(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error.code === "ENOENT" || error.code === "ENOTDIR")
		) {
			return "";
		}
		throw error;
	}
}

function sha256(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

function detectLineEnding(content: string): "LF" | "CRLF" {
	const crlfIndex = content.indexOf("\r\n");
	const lfIndex = content.indexOf("\n");
	return crlfIndex !== -1 && crlfIndex === lfIndex - 1 ? "CRLF" : "LF";
}

function normalizeLineEndings(content: string): string {
	return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(content: string, lineEnding: "LF" | "CRLF"): string {
	return lineEnding === "CRLF" ? content.replace(/\n/g, "\r\n") : content;
}

function contentLines(content: string): string[] {
	const lines = content.split(/\r?\n/);
	if (lines.length > 0 && lines[lines.length - 1] === "") return lines.slice(0, -1);
	return lines;
}

function changedLineRanges(originalContent: string, patchedContent: string): ChangedLineRange[] {
	if (originalContent === patchedContent) return [];
	const originalLines = contentLines(originalContent);
	const patchedLines = contentLines(patchedContent);
	let prefix = 0;
	while (
		prefix < originalLines.length &&
		prefix < patchedLines.length &&
		originalLines[prefix] === patchedLines[prefix]
	) {
		prefix += 1;
	}

	let suffix = 0;
	while (
		suffix + prefix < originalLines.length &&
		suffix + prefix < patchedLines.length &&
		originalLines[originalLines.length - 1 - suffix] === patchedLines[patchedLines.length - 1 - suffix]
	) {
		suffix += 1;
	}

	const startLine = prefix + 1;
	const endLine = Math.max(startLine, patchedLines.length - suffix);
	return [{ startLine, endLine }];
}

function buildVerification(expectedContent: string, actualContent: string): AppliedDiffVerification {
	const expectedSha256 = sha256(expectedContent);
	const actualSha256 = sha256(actualContent);
	if (expectedSha256 !== actualSha256) {
		throw new Error(`post-write verification failed: expected sha256 ${expectedSha256}, read ${actualSha256}`);
	}
	return {
		status: "verified",
		expectedSha256,
		actualSha256,
		expectedBytes: Buffer.byteLength(expectedContent, "utf8"),
		actualBytes: Buffer.byteLength(actualContent, "utf8"),
	};
}

function splitContentToLines(content: string): { lines: string[]; trailingNewline: boolean } {
	if (content.length === 0) return { lines: [], trailingNewline: false };
	const trailingNewline = content.endsWith("\n");
	const lines = content.split("\n");
	if (trailingNewline) lines.pop();
	return { lines, trailingNewline };
}

function joinContentLines(lines: string[], trailingNewline: boolean): string {
	return `${lines.join("\n")}${trailingNewline ? "\n" : ""}`;
}

function parseHunkLines(rawLines: string[]): HunkLine[] {
	const lines: HunkLine[] = [];
	for (const line of rawLines) {
		if (line.startsWith("\\")) continue;
		const prefix = line[0];
		const text = line.slice(1);
		if (prefix === " ") lines.push({ kind: "context", text });
		else if (prefix === "-") lines.push({ kind: "delete", text });
		else if (prefix === "+") lines.push({ kind: "add", text });
	}
	return lines;
}

function oldSide(lines: HunkLine[]): string[] {
	return lines.filter((line) => line.kind === "context" || line.kind === "delete").map((line) => line.text);
}

function leadingContextCount(lines: HunkLine[]): number {
	let count = 0;
	for (const line of lines) {
		if (line.kind !== "context") break;
		count += 1;
	}
	return count;
}

function trailingContextCount(lines: HunkLine[]): number {
	let count = 0;
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		if (lines[index].kind !== "context") break;
		count += 1;
	}
	return count;
}

function hunkVariants(lines: HunkLine[]): HunkVariant[] {
	const variants: HunkVariant[] = [{ lines, leadingTrim: 0, trailingTrim: 0 }];
	const leading = leadingContextCount(lines);
	const trailing = trailingContextCount(lines);
	for (let leadingTrim = 0; leadingTrim <= leading; leadingTrim += 1) {
		for (let trailingTrim = 0; trailingTrim <= trailing; trailingTrim += 1) {
			if (leadingTrim === 0 && trailingTrim === 0) continue;
			const end = lines.length - trailingTrim;
			if (leadingTrim >= end) continue;
			variants.push({ lines: lines.slice(leadingTrim, end), leadingTrim, trailingTrim });
		}
	}
	return variants;
}

function normalizeWhitespace(line: string): string {
	return line.trim().replace(/\s+/g, " ");
}

function findCandidateStarts(fileLines: string[], oldLines: string[], whitespaceTolerant: boolean): number[] {
	if (oldLines.length === 0) return [];
	const starts: number[] = [];
	for (let start = 0; start + oldLines.length <= fileLines.length; start += 1) {
		let matches = true;
		for (let offset = 0; offset < oldLines.length; offset += 1) {
			const left = fileLines[start + offset];
			const right = oldLines[offset];
			if (whitespaceTolerant ? normalizeWhitespace(left) !== normalizeWhitespace(right) : left !== right) {
				matches = false;
				break;
			}
		}
		if (matches) starts.push(start);
	}
	return starts;
}

function buildReplacementLines(variant: HunkVariant, matchedOldLines: string[], whitespaceTolerant: boolean): string[] {
	const replacement: string[] = [];
	let oldIndex = 0;
	for (const line of variant.lines) {
		if (line.kind === "add") {
			replacement.push(line.text);
			continue;
		}
		if (line.kind === "context") {
			replacement.push(whitespaceTolerant ? matchedOldLines[oldIndex] : line.text);
			oldIndex += 1;
			continue;
		}
		oldIndex += 1;
	}
	return replacement;
}

function candidateRanges(candidates: number[], oldLength: number): string {
	return candidates
		.slice(0, 5)
		.map((start) => `${start + 1}-${Math.max(start + 1, start + oldLength)}`)
		.join(", ");
}

function selectUniqueMatch(input: {
	fileLines: string[];
	hunkLines: HunkLine[];
	path: string;
	hunkIndex: number;
	oldStart: number;
}): HunkMatch {
	for (const variant of hunkVariants(input.hunkLines)) {
		const oldLines = oldSide(variant.lines);
		if (oldLines.length === 0) continue;
		const exactCandidates = findCandidateStarts(input.fileLines, oldLines, false);
		if (exactCandidates.length === 1) {
			const startIndex = exactCandidates[0];
			return {
				startIndex,
				oldLength: oldLines.length,
				newLines: buildReplacementLines(variant, input.fileLines.slice(startIndex, startIndex + oldLines.length), false),
				strategy: variant.leadingTrim || variant.trailingTrim ? "trimmed-context" : "line-ending-normalized",
				leadingTrim: variant.leadingTrim,
				trailingTrim: variant.trailingTrim,
			};
		}
		if (exactCandidates.length > 1) {
			throw new Error(
				`Multiple candidate regions found for ${input.path} hunk ${input.hunkIndex}: ${candidateRanges(exactCandidates, oldLines.length)}`,
			);
		}
	}

	for (const variant of hunkVariants(input.hunkLines)) {
		const oldLines = oldSide(variant.lines);
		if (oldLines.length === 0) continue;
		const candidates = findCandidateStarts(input.fileLines, oldLines, true);
		if (candidates.length === 1) {
			const startIndex = candidates[0];
			return {
				startIndex,
				oldLength: oldLines.length,
				newLines: buildReplacementLines(variant, input.fileLines.slice(startIndex, startIndex + oldLines.length), true),
				strategy: "whitespace-tolerant",
				leadingTrim: variant.leadingTrim,
				trailingTrim: variant.trailingTrim,
			};
		}
		if (candidates.length > 1) {
			throw new Error(
				`Multiple candidate regions found for ${input.path} hunk ${input.hunkIndex}: ${candidateRanges(candidates, oldLines.length)}`,
			);
		}
	}

	const fullOldSide = oldSide(input.hunkLines);
	if (fullOldSide.length === 0) {
		const insertIndex = Math.min(input.fileLines.length, Math.max(0, input.oldStart));
		return {
			startIndex: insertIndex,
			oldLength: 0,
			newLines: input.hunkLines.filter((line) => line.kind === "context" || line.kind === "add").map((line) => line.text),
			strategy: "header-insertion",
			leadingTrim: 0,
			trailingTrim: 0,
		};
	}

	throw new Error(`No matching region found for ${input.path} hunk ${input.hunkIndex}`);
}

function applyParsedPatchToContent(input: {
	relativePath: string;
	content: string;
	patch: ParsedDiff;
	deletesFile: boolean;
}): { content: string; appliedHunks: AppliedHunkReceipt[] } {
	const normalizedContent = normalizeLineEndings(input.content);
	const split = splitContentToLines(normalizedContent);
	let lines = split.lines;
	let trailingNewline = split.trailingNewline;
	const appliedHunks: AppliedHunkReceipt[] = [];

	for (let index = 0; index < input.patch.hunks.length; index += 1) {
		const hunk = input.patch.hunks[index];
		const hunkLines = parseHunkLines(hunk.lines);
		const match = selectUniqueMatch({
			fileLines: lines,
			hunkLines,
			path: input.relativePath,
			hunkIndex: index + 1,
			oldStart: hunk.oldStart,
		});
		lines = [...lines.slice(0, match.startIndex), ...match.newLines, ...lines.slice(match.startIndex + match.oldLength)];
		if (match.startIndex + match.newLines.length >= lines.length) trailingNewline = true;
		appliedHunks.push({
			path: input.relativePath,
			matchStrategy: match.strategy === "line-ending-normalized" && normalizeLineEndings(input.content) === input.content ? "exact" : match.strategy,
			oldStart: match.startIndex + 1,
			oldEnd: Math.max(match.startIndex + 1, match.startIndex + match.oldLength),
			newStart: match.startIndex + 1,
			newEnd: Math.max(match.startIndex + 1, match.startIndex + match.newLines.length),
			...(match.leadingTrim || match.trailingTrim
				? { trimmedContext: { leading: match.leadingTrim, trailing: match.trailingTrim } }
				: {}),
		});
	}

	if (input.deletesFile) return { content: "", appliedHunks };
	return { content: joinContentLines(lines, trailingNewline), appliedHunks };
}

function formatPreview(path: string, content: string, range: ChangedLineRange, radius = 2): string {
	const lines = contentLines(content);
	const start = Math.max(1, range.startLine - radius);
	const end = Math.min(lines.length, range.endLine + radius);
	return [`${path}:${start}-${end}`, ...lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`)].join("\n");
}

function buildPreviews(path: string, originalContent: string, patchedContent: string, ranges: ChangedLineRange[]): AppliedDiffPreview[] {
	return ranges.map((range) => ({
		path,
		startLine: range.startLine,
		endLine: range.endLine,
		before: formatPreview(path, originalContent, range),
		after: formatPreview(path, patchedContent, range),
	}));
}

export async function applyUnifiedDiff(input: { cwd: string; patch: string; baseSha256?: string }): Promise<ApplyUnifiedDiffResult> {
	if (input.patch.trim().length === 0) throw new Error("patch must not be empty");
	const normalized = normalizePatchHunkCounts(input.patch);

	const planned = await planPatches(input.cwd, normalized.patchText);
	if (input.baseSha256 !== undefined && planned.length !== 1) {
		throw new Error("baseSha256 can only guard a single-file apply_diff call");
	}
	const byPath = new Map<string, PlannedPatch[]>();
	for (const patch of planned) {
		const entries = byPath.get(patch.absolutePath) ?? [];
		entries.push(patch);
		byPath.set(patch.absolutePath, entries);
	}

	const dryRuns: DryRunFile[] = [];
	for (const patches of byPath.values()) {
		const first = patches[0];
		const originalContent = await readTextFileForPatch(first.absolutePath);
		const lineEnding = detectLineEnding(originalContent);
		const originalSha256 = sha256(originalContent);
		if (input.baseSha256 !== undefined && input.baseSha256 !== originalSha256) {
			throw new Error(
				`File revision changed since it was read for ${first.relativePath}: expected ${input.baseSha256}, current ${originalSha256}`,
			);
		}
		let patchedContent = normalizeLineEndings(originalContent);
		let deletesFile = false;
		const appliedHunks: AppliedHunkReceipt[] = [];

		for (const plannedPatch of patches) {
			const next = applyParsedPatchToContent({
				relativePath: plannedPatch.relativePath,
				content: patchedContent,
				patch: plannedPatch.patch,
				deletesFile: plannedPatch.deletesFile,
			});
			patchedContent = next.content;
			appliedHunks.push(...next.appliedHunks);
			deletesFile = plannedPatch.deletesFile;
		}
		if (!deletesFile) patchedContent = restoreLineEndings(patchedContent, lineEnding);

		dryRuns.push({
			relativePath: first.relativePath,
			absolutePath: first.absolutePath,
			originalContent,
			patchedContent,
			deletesFile,
			appliedHunks,
			lineEnding,
		});
	}

	const appliedFiles: AppliedDiffFile[] = [];
	for (const dryRun of dryRuns) {
		if (dryRun.deletesFile) {
			await rm(dryRun.absolutePath, { force: true });
		} else {
			await mkdir(dirname(dryRun.absolutePath), { recursive: true });
			await writeFile(dryRun.absolutePath, dryRun.patchedContent, "utf8");
		}
		const actualContent = await readTextFileForPatch(dryRun.absolutePath);
		const verification = buildVerification(dryRun.deletesFile ? "" : dryRun.patchedContent, actualContent);
		const ranges = changedLineRanges(dryRun.originalContent, dryRun.deletesFile ? "" : dryRun.patchedContent);

		appliedFiles.push({
			path: dryRun.relativePath,
			absolutePath: dryRun.absolutePath,
			changed: dryRun.originalContent !== dryRun.patchedContent || dryRun.deletesFile,
			changedLineRanges: ranges,
			verification,
			oldSha256: sha256(dryRun.originalContent),
			newSha256: sha256(dryRun.deletesFile ? "" : dryRun.patchedContent),
			hunksApplied: dryRun.appliedHunks.length,
			lineEnding: dryRun.lineEnding,
			appliedHunks: dryRun.appliedHunks,
			previews: buildPreviews(dryRun.relativePath, dryRun.originalContent, dryRun.deletesFile ? "" : dryRun.patchedContent, ranges),
			diff: createTwoFilesPatch(
				dryRun.relativePath,
				dryRun.relativePath,
				dryRun.originalContent,
				dryRun.deletesFile ? "" : dryRun.patchedContent,
			),
		});
	}

	return { appliedFiles, normalizedHunks: normalized.normalizedHunks };
}

export function createApplyDiffTool(cwd: string): AgentTool<typeof applyDiffSchema, ApplyUnifiedDiffResult> {
	return {
		label: "Apply diff",
		name: "apply_diff",
		description: "Apply a unified diff to local workspace files after deterministic dry-run validation.",
		parameters: applyDiffSchema,
		executionMode: "sequential",
		execute: async (_toolCallId: string, params: ApplyDiffParams) => {
			const result = await applyUnifiedDiff({ cwd, patch: params.patch });
			const files = result.appliedFiles.map((file) => file.path).join(", ");
			const normalized =
				result.normalizedHunks.length > 0 ? ` Normalized ${result.normalizedHunks.length} hunk header(s).` : "";
			return {
				content: [{ type: "text", text: `Applied diff to ${result.appliedFiles.length} file(s): ${files}.${normalized}` }],
				details: result,
			};
		},
	};
}
