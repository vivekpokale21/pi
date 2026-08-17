/**
 * Shared diff computation utilities for the edit and similar tools.
 */

import * as Diff from "diff";
import { constants } from "fs";
import { access, readFile } from "fs/promises";
import { resolveToCwd } from "./path-utils.ts";

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
export function normalizeForFuzzyMatch(text: string): string {
	return (
		text
			.normalize("NFKC")
			// Strip trailing whitespace per line
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n")
			// Smart single quotes → '
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			// Smart double quotes → "
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			// Various dashes/hyphens → -
			// U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
			// U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
			.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
			// Special spaces → regular space
			// U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
			// U+205F medium math space, U+3000 ideographic space
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
	);
}

function splitLinesWithEndings(content: string): string[] {
	return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

interface LineSpan {
	start: number;
	end: number;
}

interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

type TextReplacement = Pick<MatchedEdit, "matchIndex" | "matchLength" | "newText">;

function getLineSpans(content: string): LineSpan[] {
	let offset = 0;
	return splitLinesWithEndings(content).map((line) => {
		const span = { start: offset, end: offset + line.length };
		offset = span.end;
		return span;
	});
}

function getReplacementLineRange(lines: LineSpan[], replacement: TextReplacement) {
	const replacementStart = replacement.matchIndex;
	const replacementEnd = replacement.matchIndex + replacement.matchLength;

	let startLine = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (replacementStart >= line.start && replacementStart < line.end) {
			startLine = i;
			break;
		}
	}
	if (startLine === -1) {
		throw new Error("Replacement range is outside the base content.");
	}

	let endLine = startLine;
	while (endLine < lines.length && lines[endLine].end < replacementEnd) {
		endLine++;
	}
	if (endLine >= lines.length) {
		throw new Error("Replacement range is outside the base content.");
	}

	return { startLine, endLine: endLine + 1 };
}

function applyReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
	let result = content;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const replacement = replacements[i];
		const matchIndex = replacement.matchIndex - offset;
		result =
			result.substring(0, matchIndex) + replacement.newText + result.substring(matchIndex + replacement.matchLength);
	}
	return result;
}

/**
 * Apply replacements matched against `baseContent` to `originalContent` while
 * preserving unchanged line blocks from the original.
 *
 * This is useful when `baseContent` is a normalized view of the original. Each
 * replacement is widened to the lines it actually touches, those touched lines
 * are rewritten from the normalized base, and all other lines are copied back
 * from `originalContent`. The actual replacement ranges drive preservation so
 * duplicate normalized lines cannot be aligned to the wrong occurrence.
 */
export function applyReplacementsPreservingUnchangedLines(
	originalContent: string,
	baseContent: string,
	replacements: TextReplacement[],
): string {
	const originalLines = splitLinesWithEndings(originalContent);
	const baseLines = getLineSpans(baseContent);
	if (originalLines.length !== baseLines.length) {
		throw new Error("Cannot preserve unchanged lines because the base content has a different line count.");
	}

	const groups: Array<{ startLine: number; endLine: number; replacements: TextReplacement[] }> = [];
	const sortedReplacements = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
	for (const replacement of sortedReplacements) {
		const range = getReplacementLineRange(baseLines, replacement);
		const current = groups[groups.length - 1];
		if (current && range.startLine < current.endLine) {
			current.endLine = Math.max(current.endLine, range.endLine);
			current.replacements.push(replacement);
			continue;
		}
		groups.push({ ...range, replacements: [replacement] });
	}

	let originalLineIndex = 0;
	let result = "";
	for (const group of groups) {
		result += originalLines.slice(originalLineIndex, group.startLine).join("");

		const groupStartOffset = baseLines[group.startLine].start;
		const groupEndOffset = baseLines[group.endLine - 1].end;
		result += applyReplacements(
			baseContent.slice(groupStartOffset, groupEndOffset),
			group.replacements,
			groupStartOffset,
		);
		originalLineIndex = group.endLine;
	}
	result += originalLines.slice(originalLineIndex).join("");

	return result;
}

export interface FuzzyMatchResult {
	/** Whether a match was found */
	found: boolean;
	/** The index where the match starts (in the content that should be used for replacement) */
	index: number;
	/** Length of the matched text */
	matchLength: number;
	/** Whether fuzzy matching was used (false = exact match) */
	usedFuzzyMatch: boolean;
	/**
	 * The content to use for replacement operations.
	 * When exact match: original content. When fuzzy match: normalized content.
	 */
	contentForReplacement: string;
}

export interface Edit {
	oldText: string;
	newText: string;
}

export interface AppliedEditsResult {
	baseContent: string;
	newContent: string;
}

export interface AppliedPatchResult {
	baseContent: string;
	newContent: string;
	hunksApplied: number;
	hunks: AppliedPatchHunk[];
}

export interface AppliedPatchHunk {
	index: number;
	oldStartLine: number;
	oldLineCount: number;
	newLineCount: number;
}

/**
 * Find oldText in content, trying exact match first, then fuzzy match.
 * When fuzzy matching is used, the returned contentForReplacement is the
 * fuzzy-normalized version of the content (trailing whitespace stripped,
 * Unicode quotes/dashes normalized to ASCII).
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
	// Try exact match first
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return {
			found: true,
			index: exactIndex,
			matchLength: oldText.length,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	// Try fuzzy match - work entirely in normalized space
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

	if (fuzzyIndex === -1) {
		return {
			found: false,
			index: -1,
			matchLength: 0,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	// When fuzzy matching, return offsets in normalized space. Callers can use
	// the normalized content to compute replacements, then decide how much of
	// that normalized output should be written back.
	return {
		found: true,
		index: fuzzyIndex,
		matchLength: fuzzyOldText.length,
		usedFuzzyMatch: true,
		contentForReplacement: fuzzyContent,
	};
}

/** Strip UTF-8 BOM if present, return both the BOM (if any) and the text without it */
export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

function countOccurrences(content: string, oldText: string): number {
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	return fuzzyContent.split(fuzzyOldText).length - 1;
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
		);
	}
	return new Error(
		`Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
	);
}

function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
		);
	}
	return new Error(
		`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
	);
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(`oldText must not be empty in ${path}.`);
	}
	return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
		);
	}
	return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/**
 * Apply one or more exact-text replacements to LF-normalized content.
 *
 * All edits are matched against the same original content. Replacements are
 * then applied in reverse order so offsets remain stable. If any edit needs
 * fuzzy matching, the operation runs in fuzzy-normalized content space and then
 * overlays those line-level changes onto the original content so unchanged line
 * blocks keep their original bytes.
 */
export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
): AppliedEditsResult {
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));

	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw getEmptyOldTextError(path, i, normalizedEdits.length);
		}
	}

	const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText));
	const usedFuzzyMatch = initialMatches.some((match) => match.usedFuzzyMatch);
	const replacementBaseContent = usedFuzzyMatch ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;

	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		const matchResult = fuzzyFindText(replacementBaseContent, edit.oldText);
		if (!matchResult.found) {
			throw getNotFoundError(path, i, normalizedEdits.length);
		}

		const occurrences = countOccurrences(replacementBaseContent, edit.oldText);
		if (occurrences > 1) {
			throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
		}

		matchedEdits.push({
			editIndex: i,
			matchIndex: matchResult.index,
			matchLength: matchResult.matchLength,
			newText: edit.newText,
		});
	}

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	const baseContent = normalizedContent;
	const newContent = usedFuzzyMatch
		? applyReplacementsPreservingUnchangedLines(normalizedContent, replacementBaseContent, matchedEdits)
		: applyReplacements(replacementBaseContent, matchedEdits);

	if (baseContent === newContent) {
		throw getNoChangeError(path, normalizedEdits.length);
	}

	return { baseContent, newContent };
}

function getPatchBodyLines(hunkLines: readonly string[]): { oldLines: string[]; newLines: string[] } {
	const oldLines: string[] = [];
	const newLines: string[] = [];
	for (const line of hunkLines) {
		if (line.startsWith("\\")) continue;
		const marker = line[0];
		const body = line.slice(1);
		if (marker === " ") {
			oldLines.push(body);
			newLines.push(body);
		} else if (marker === "-") {
			oldLines.push(body);
		} else if (marker === "+") {
			newLines.push(body);
		} else {
			throw new Error(`Unsupported unified diff hunk line: ${line}`);
		}
	}
	return { oldLines, newLines };
}

function joinPatchLines(lines: readonly string[]): string {
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function countPatchBodyLines(body: string): number {
	return body === "" ? 0 : countDiffLines(body);
}

function findUniqueBody(content: string, body: string, path: string, hunkIndex: number): number {
	if (body.length === 0) {
		throw new Error(`Cannot apply hunk ${hunkIndex + 1} in ${path}: hunk has no old-side context.`);
	}
	const first = content.indexOf(body);
	if (first === -1) {
		throw new Error(`Could not find old-side body for hunk ${hunkIndex + 1} in ${path}.`);
	}
	if (content.indexOf(body, first + body.length) !== -1) {
		throw new Error(`Old-side body for hunk ${hunkIndex + 1} in ${path} is ambiguous.`);
	}
	return first;
}

function isOldBodyNotFound(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith("Could not find old-side body");
}

function getTrimmedHunkLineVariants(hunkLines: readonly string[]): string[][] {
	let leadingContext = 0;
	while (hunkLines[leadingContext]?.startsWith(" ")) {
		leadingContext++;
	}

	let trailingContext = 0;
	while (
		trailingContext < hunkLines.length - leadingContext &&
		hunkLines[hunkLines.length - trailingContext - 1]?.startsWith(" ")
	) {
		trailingContext++;
	}

	const variants: string[][] = [];
	const maxLeadingTrim = Math.min(3, leadingContext);
	const maxTrailingTrim = Math.min(3, trailingContext);
	for (let leadingTrim = 0; leadingTrim <= maxLeadingTrim; leadingTrim++) {
		for (let trailingTrim = 0; trailingTrim <= maxTrailingTrim; trailingTrim++) {
			const end = hunkLines.length - trailingTrim;
			if (leadingTrim >= end) continue;
			const variant = hunkLines.slice(leadingTrim, end);
			if (variant.some((line) => line.startsWith("-"))) {
				variants.push([...variant]);
			}
		}
	}
	return variants;
}

function applyExactPatchBody(
	content: string,
	oldBody: string,
	newBody: string,
	path: string,
	hunkIndex: number,
): { content: string; hunk: AppliedPatchHunk } {
	const matchIndex = findUniqueBody(content, oldBody, path, hunkIndex);
	const range = getReplacementLineRange(getLineSpans(content), {
		matchIndex,
		matchLength: oldBody.length,
		newText: newBody,
	});
	return {
		content: applyReplacements(content, [{ matchIndex, matchLength: oldBody.length, newText: newBody }]),
		hunk: {
			index: hunkIndex,
			oldStartLine: range.startLine + 1,
			oldLineCount: countPatchBodyLines(oldBody),
			newLineCount: countPatchBodyLines(newBody),
		},
	};
}

function applyUniquePatchBody(
	content: string,
	hunkLines: readonly string[],
	oldBody: string,
	newBody: string,
	path: string,
	hunkIndex: number,
): { content: string; hunk: AppliedPatchHunk } {
	try {
		return applyExactPatchBody(content, oldBody, newBody, path, hunkIndex);
	} catch (error) {
		if (!isOldBodyNotFound(error)) {
			throw error;
		}
	}

	for (const variant of getTrimmedHunkLineVariants(hunkLines).slice(1)) {
		const { oldLines: trimmedOldLines, newLines: trimmedNewLines } = getPatchBodyLines(variant);
		const trimmedOldBody = joinPatchLines(trimmedOldLines);
		const trimmedNewBody = joinPatchLines(trimmedNewLines);
		try {
			return applyExactPatchBody(content, trimmedOldBody, trimmedNewBody, path, hunkIndex);
		} catch (error) {
			if (!isOldBodyNotFound(error)) {
				throw error;
			}
		}
	}

	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldBody = normalizeForFuzzyMatch(oldBody);
	const matchIndex = findUniqueBody(fuzzyContent, fuzzyOldBody, path, hunkIndex);
	const fuzzyRange = getReplacementLineRange(getLineSpans(fuzzyContent), {
		matchIndex,
		matchLength: fuzzyOldBody.length,
		newText: "",
	});
	const originalLines = splitLinesWithEndings(content);
	let originalLineIndex = fuzzyRange.startLine;
	let replacement = "";
	for (const line of hunkLines) {
		if (line.startsWith("\\")) continue;
		const marker = line[0];
		const body = line.slice(1);
		if (marker === " ") {
			replacement += originalLines[originalLineIndex] ?? `${body}\n`;
			originalLineIndex++;
		} else if (marker === "-") {
			originalLineIndex++;
		} else if (marker === "+") {
			replacement += `${body}\n`;
		}
	}
	const originalSpans = getLineSpans(content);
	const startOffset = originalSpans[fuzzyRange.startLine]?.start;
	const endOffset = originalSpans[fuzzyRange.endLine - 1]?.end;
	if (startOffset === undefined || endOffset === undefined) {
		throw new Error(`Replacement range for hunk ${hunkIndex + 1} is outside ${path}.`);
	}
	return {
		content: applyReplacements(content, [
			{ matchIndex: startOffset, matchLength: endOffset - startOffset, newText: replacement },
		]),
		hunk: {
			index: hunkIndex,
			oldStartLine: fuzzyRange.startLine + 1,
			oldLineCount: countPatchBodyLines(oldBody),
			newLineCount: countPatchBodyLines(newBody),
		},
	};
}

function parseUnifiedPatchHunks(patch: string, path: string): string[][] {
	const lines = patch.split("\n");
	if (lines.filter((line) => line.startsWith("--- ")).length > 1) {
		throw new Error(`Multi-file unified diff input is not supported by single-file edit for ${path}.`);
	}
	const hunks: string[][] = [];
	let currentHunk: string[] | undefined;
	for (const line of lines) {
		if (line.startsWith("@@")) {
			currentHunk = [];
			hunks.push(currentHunk);
			continue;
		}
		if (!currentHunk) continue;
		if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("diff ")) {
			currentHunk = undefined;
			continue;
		}
		if (line === "" && lines[lines.length - 1] === line) continue;
		currentHunk.push(line);
	}
	if (hunks.length === 0) {
		throw new Error(`Unified diff for ${path} does not contain any hunks.`);
	}
	return hunks;
}

export function applyUnifiedPatchToNormalizedContent(
	normalizedContent: string,
	patch: string,
	path: string,
): AppliedPatchResult {
	const hunks = parseUnifiedPatchHunks(patch, path);
	let newContent = normalizedContent;
	const appliedHunks: AppliedPatchHunk[] = [];
	for (let index = 0; index < hunks.length; index++) {
		const hunkLines = hunks[index] ?? [];
		const { oldLines, newLines } = getPatchBodyLines(hunkLines);
		const oldBody = joinPatchLines(oldLines);
		const newBody = joinPatchLines(newLines);
		const applied = applyUniquePatchBody(newContent, hunkLines, oldBody, newBody, path, index);
		newContent = applied.content;
		appliedHunks.push(applied.hunk);
	}

	if (normalizedContent === newContent) {
		throw getNoChangeError(path, hunks.length);
	}

	return { baseContent: normalizedContent, newContent, hunksApplied: hunks.length, hunks: appliedHunks };
}

/** Generate a standard unified patch. */
export function generateUnifiedPatch(path: string, oldContent: string, newContent: string, contextLines = 4): string {
	return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: Diff.FILE_HEADERS_ONLY,
	});
}

/**
 * Generate a display-oriented diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			// Capture the first changed line (in the new file)
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			// Show the change
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					// removed
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			// Context lines - only show a few before/after changes
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
			const hasLeadingChange = lastWasChange;
			const hasTrailingChange = nextPartIsChange;

			if (hasLeadingChange && hasTrailingChange) {
				if (raw.length <= contextLines * 2) {
					for (const line of raw) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				} else {
					const leadingLines = raw.slice(0, contextLines);
					const trailingLines = raw.slice(raw.length - contextLines);
					const skippedLines = raw.length - leadingLines.length - trailingLines.length;

					for (const line of leadingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}

					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;

					for (const line of trailingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				}
			} else if (hasLeadingChange) {
				const shownLines = raw.slice(0, contextLines);
				const skippedLines = raw.length - shownLines.length;

				for (const line of shownLines) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}
			} else if (hasTrailingChange) {
				const skippedLines = Math.max(0, raw.length - contextLines);
				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}

				for (const line of raw.slice(skippedLines)) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			} else {
				// Skip these context lines entirely
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return { diff: output.join("\n"), firstChangedLine };
}

export interface EditDiffResult {
	diff: string;
	firstChangedLine: number | undefined;
}

export interface ChangedRange {
	startLine: number;
	endLine: number;
}

function countDiffLines(value: string): number {
	const lines = value.split("\n");
	if (lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines.length;
}

export function computeChangedRanges(oldContent: string, newContent: string): ChangedRange[] {
	const parts = Diff.diffLines(oldContent, newContent);
	const ranges: ChangedRange[] = [];
	let newLineNum = 1;
	let currentStartLine: number | undefined;
	let currentEndLine: number | undefined;

	const flush = (): void => {
		if (currentStartLine === undefined) return;
		ranges.push({
			startLine: currentStartLine,
			endLine: currentEndLine ?? currentStartLine,
		});
		currentStartLine = undefined;
		currentEndLine = undefined;
	};

	for (const part of parts) {
		const lineCount = countDiffLines(part.value);
		if (part.added) {
			currentStartLine ??= newLineNum;
			currentEndLine = newLineNum + lineCount - 1;
			newLineNum += lineCount;
		} else if (part.removed) {
			currentStartLine ??= newLineNum;
		} else {
			flush();
			newLineNum += lineCount;
		}
	}
	flush();

	return ranges;
}

export interface EditDiffError {
	error: string;
}

/**
 * Compute the diff for one or more edit operations without applying them.
 * Used for preview rendering in the TUI before the tool executes.
 */
export async function computeEditsDiff(
	path: string,
	edits: Edit[],
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	const absolutePath = resolveToCwd(path, cwd);

	try {
		// Check if file exists and is readable
		try {
			await access(absolutePath, constants.R_OK);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
			return { error: `Could not edit file: ${path}. ${errorMessage}.` };
		}

		// Read the file
		const rawContent = await readFile(absolutePath, "utf-8");

		// Strip BOM before matching (LLM won't include invisible BOM in oldText)
		const { text: content } = stripBom(rawContent);
		const normalizedContent = normalizeToLF(content);
		const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);

		// Generate the diff
		return generateDiffString(baseContent, newContent);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Compute the diff for a single edit operation without applying it.
 * Kept as a convenience wrapper for single-edit callers.
 */
export async function computeEditDiff(
	path: string,
	oldText: string,
	newText: string,
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	return computeEditsDiff(path, [{ oldText, newText }], cwd);
}
