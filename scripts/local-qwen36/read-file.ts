import { readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { AgentTool } from "../../packages/agent/src/index.ts";
import { Type, type Static } from "../../packages/ai/src/index.ts";
import { createParserAdapterForLanguage } from "./parser-adapters.ts";

const readFileSchema = Type.Object({
	path: Type.String({ description: "Workspace-relative file path to read." }),
	mode: Type.Optional(
		Type.Union([
			Type.Literal("range", { description: "Read a bounded line range. This is the default." }),
			Type.Literal("map", { description: "Return a compact file map with symbol and range handles." }),
			Type.Literal("symbol", { description: "Read one named symbol body plus expansion handles." }),
			Type.Literal("around", { description: "Read bounded context around one line." }),
		]),
	),
	symbol: Type.Optional(Type.String({ description: "Symbol name for mode=symbol." })),
	parent: Type.Optional(Type.String({ description: "Optional parent/container name to disambiguate mode=symbol." })),
	line: Type.Optional(Type.Number({ description: "Center line for mode=around." })),
	before: Type.Optional(Type.Number({ description: "Lines before the center line for mode=around." })),
	after: Type.Optional(Type.Number({ description: "Lines after the center line for mode=around." })),
	startLine: Type.Optional(Type.Number({ description: "1-based first line to include." })),
	maxLines: Type.Optional(Type.Number({ description: "Maximum lines to return. Default 120, maximum 300." })),
});

type ReadFileParams = Static<typeof readFileSchema>;

interface ReadSymbol {
	path: string;
	startLine: number;
	endLine: number;
	symbolName: string;
	symbolKind: string;
	parentName?: string;
	lspSymbolKind: number;
	lspSymbolKindName: string;
}

interface ReadRangeHandle {
	path: string;
	startLine: number;
	maxLines: number;
}

interface ReadToolHandle {
	tool: "read_file";
	args: {
		path: string;
		mode: "range" | "map" | "symbol" | "around";
		symbol?: string;
		parent?: string;
		startLine?: number;
		maxLines?: number;
		line?: number;
		before?: number;
		after?: number;
	};
}

// LSP SymbolKind values from the Language Server Protocol enum.
const LSP_SYMBOL_KIND = {
	class: { value: 5, name: "Class" },
	method: { value: 6, name: "Method" },
	interface: { value: 11, name: "Interface" },
	function: { value: 12, name: "Function" },
	type: { value: 13, name: "Variable" },
	const: { value: 13, name: "Variable" },
	let: { value: 13, name: "Variable" },
	var: { value: 13, name: "Variable" },
	variable: { value: 13, name: "Variable" },
} as const;

function lspSymbolKind(kind: string): { value: number; name: string } {
	return LSP_SYMBOL_KIND[kind as keyof typeof LSP_SYMBOL_KIND] ?? { value: 13, name: "Variable" };
}

interface ReadFileDetails {
	path: string;
	mode: "range" | "map" | "symbol" | "around";
	startLine?: number;
	endLine?: number;
	totalLines: number;
	fileRevision: string;
	chunkId?: string;
	symbols?: ReadSymbol[];
	handles?: {
		above?: ReadRangeHandle;
		below?: ReadRangeHandle;
		range?: ReadRangeHandle;
	};
	retrieval?: RetrievalReceipt;
}

interface RetrievalReceipt {
	range: { startLine: number; endLine: number };
	overlapLines: number;
	novelLines: number;
	noveltyRatio: number;
	repeatedOverlap: boolean;
	recommendedNextAction: "continue" | "expand_or_act" | "read_full_file";
}

function isWithinWorkspace(path: string, workspaceRoot: string): boolean {
	const rel = relative(workspaceRoot, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function resolveWorkspaceFile(cwd: string, path: string): Promise<{ absolutePath: string; relativePath: string }> {
	const workspaceRoot = await realpath(cwd);
	const rawPath = path.trim();
	const absolutePath = rawPath ? (isAbsolute(rawPath) ? rawPath : resolve(workspaceRoot, rawPath)) : workspaceRoot;
	if (!isWithinWorkspace(absolutePath, workspaceRoot)) {
		throw new Error(`path escapes workspace: ${path}`);
	}
	const resolvedPath = await realpath(absolutePath);
	if (!isWithinWorkspace(resolvedPath, workspaceRoot)) {
		throw new Error(`path escapes workspace: ${path}`);
	}
	const info = await stat(resolvedPath);
	if (!info.isFile()) throw new Error(`path is not a file: ${path}`);
	return { absolutePath: resolvedPath, relativePath: relative(workspaceRoot, resolvedPath).replaceAll("\\", "/") };
}

function effectiveLineCount(lines: string[]): number {
	return lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

function sha256(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

function lineIndent(line: string): number {
	const match = /^\s*/.exec(line);
	return match?.[0].length ?? 0;
}

function braceDelta(line: string): number {
	let delta = 0;
	let quote: "'" | '"' | "`" | undefined;
	let escaped = false;
	for (const char of line) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (quote) {
			if (char === "\\") escaped = true;
			else if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			quote = char;
			continue;
		}
		if (char === "{") delta += 1;
		if (char === "}") delta -= 1;
	}
	return delta;
}

function classifySymbolLine(line: string): { symbolKind: string; symbolName: string } | undefined {
	const trimmed = line.trim();
	const patterns: Array<{ symbolKind: string; regex: RegExp }> = [
		{ symbolKind: "class", regex: /^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)\b/ },
		{ symbolKind: "function", regex: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/ },
		{ symbolKind: "interface", regex: /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/ },
		{ symbolKind: "type", regex: /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/ },
		{ symbolKind: "const", regex: /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\b/ },
		{ symbolKind: "let", regex: /^(?:export\s+)?let\s+([A-Za-z_$][\w$]*)\b/ },
		{ symbolKind: "var", regex: /^(?:export\s+)?var\s+([A-Za-z_$][\w$]*)\b/ },
		{ symbolKind: "method", regex: /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:\w\s<>,[\]|&.?]*\{/ },
	];
	for (const pattern of patterns) {
		const match = pattern.regex.exec(trimmed);
		if (match?.[1]) return { symbolKind: pattern.symbolKind, symbolName: match[1] };
	}
	return undefined;
}

function findSymbolEnd(lines: string[], startIndex: number): number {
	let depth = 0;
	let sawBrace = false;
	const startIndent = lineIndent(lines[startIndex] ?? "");
	for (let index = startIndex; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (line.includes("{")) sawBrace = true;
		depth += braceDelta(line);
		if (sawBrace && depth <= 0) return index + 1;
		if (!sawBrace && index > startIndex && line.trim().length > 0 && lineIndent(line) <= startIndent) return index;
	}
	return effectiveLineCount(lines);
}

function parentFromSymbolName(symbolName: string): string | undefined {
	const index = symbolName.lastIndexOf(".");
	return index > 0 ? symbolName.slice(0, index) : undefined;
}

function baseSymbolName(symbolName: string): string {
	const index = symbolName.lastIndexOf(".");
	return index >= 0 ? symbolName.slice(index + 1) : symbolName;
}

function languageForPath(path: string): string {
	switch (extname(path).toLowerCase()) {
		case ".ts":
		case ".tsx":
		case ".js":
		case ".jsx":
			return "typescript";
		default:
			return extname(path).slice(1).toLowerCase() || "text";
	}
}

function toReadSymbol(input: {
	path: string;
	startLine: number;
	endLine: number;
	symbolName: string;
	symbolKind: string;
	parentName?: string;
}): ReadSymbol {
	const kind = lspSymbolKind(input.symbolKind);
	return {
		path: input.path,
		startLine: input.startLine,
		endLine: input.endLine,
		symbolName: input.symbolName,
		symbolKind: input.symbolKind,
		parentName: input.parentName ?? parentFromSymbolName(input.symbolName),
		lspSymbolKind: kind.value,
		lspSymbolKindName: kind.name,
	};
}

function collectFallbackSymbols(path: string, lines: string[]): ReadSymbol[] {
	const symbols: ReadSymbol[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const symbol = classifySymbolLine(lines[index] ?? "");
		if (!symbol) continue;
		symbols.push(toReadSymbol({
			path,
			startLine: index + 1,
			endLine: findSymbolEnd(lines, index),
			symbolName: symbol.symbolName,
			symbolKind: symbol.symbolKind,
		}));
	}
	return symbols;
}

function collectSymbols(path: string, text: string, lines: string[]): ReadSymbol[] {
	const parser = createParserAdapterForLanguage(languageForPath(path));
	if (parser) {
		const parsed = parser.extract({ path, text });
		const symbols = parsed.chunks
			.filter((chunk) => chunk.symbolName && chunk.symbolKind && chunk.languageTier === "structured")
			.map((chunk) =>
				toReadSymbol({
					path,
					startLine: chunk.startLine,
					endLine: chunk.endLine,
					symbolName: chunk.symbolName ?? "",
					symbolKind: chunk.symbolKind ?? "variable",
				}),
			);
		if (symbols.length > 0) return symbols;
	}
	return collectFallbackSymbols(path, lines);
}

function boundedRange(params: { totalLines: number; startLine: number; maxLines: number }): { startLine: number; endLine: number } {
	const startLine = Math.min(params.totalLines || 1, Math.max(1, Math.trunc(params.startLine)));
	const maxLines = Math.min(300, Math.max(1, Math.trunc(params.maxLines)));
	const endLine = Math.min(params.totalLines, startLine + maxLines - 1);
	return { startLine, endLine };
}

function formatRange(path: string, lines: string[], startLine: number, endLine: number): string {
	const selected = lines.slice(startLine - 1, endLine);
	const body = selected.map((line, index) => `${startLine + index}: ${line}`).join("\n");
	return `${path}:${startLine}-${endLine}\n${body}`;
}

function chunkId(path: string, label: string, startLine: number, revision: string): string {
	return `${path}::${label}@line-${startLine}:${revision.slice(0, 12)}`;
}

function readLabel(mode: ReadFileDetails["mode"], params: ReadFileParams, startLine: number): string {
	if (mode === "symbol" && params.symbol?.trim()) return params.symbol.trim();
	return mode === "map" ? "map" : `${mode}-${startLine}`;
}

function computeRetrievalReceipt(
	seenRanges: Map<string, Array<{ startLine: number; endLine: number }>>,
	path: string,
	startLine: number,
	endLine: number,
	totalLines: number,
): RetrievalReceipt {
	const existing = seenRanges.get(path) ?? [];
	let overlapLines = 0;
	for (let line = startLine; line <= endLine; line += 1) {
		if (existing.some((range) => line >= range.startLine && line <= range.endLine)) overlapLines += 1;
	}
	const lineCount = Math.max(0, endLine - startLine + 1);
	const novelLines = Math.max(0, lineCount - overlapLines);
	const noveltyRatio = lineCount === 0 ? 0 : novelLines / lineCount;
	const coveredAfter = new Set<number>();
	for (const range of existing) {
		for (let line = range.startLine; line <= range.endLine; line += 1) coveredAfter.add(line);
	}
	for (let line = startLine; line <= endLine; line += 1) coveredAfter.add(line);
	const recommendedNextAction =
		coveredAfter.size >= Math.ceil(totalLines * 0.7)
			? "read_full_file"
			: overlapLines > 0 && noveltyRatio <= 0.35
				? "expand_or_act"
				: "continue";
	existing.push({ startLine, endLine });
	seenRanges.set(path, existing);
	return {
		range: { startLine, endLine },
		overlapLines,
		novelLines,
		noveltyRatio,
		repeatedOverlap: overlapLines > 0 && noveltyRatio <= 0.35,
		recommendedNextAction,
	};
}

function readToolHandle(args: ReadToolHandle["args"]): ReadToolHandle {
	return { tool: "read_file", args };
}

function handleText(name: string, handle: ReadRangeHandle | undefined): string | undefined {
	if (!handle || handle.maxLines <= 0) return undefined;
	return `${name}: ${JSON.stringify(
		readToolHandle({ path: handle.path, mode: "range", startLine: handle.startLine, maxLines: handle.maxLines }),
	)}`;
}

function symbolHandle(path: string, symbol: ReadSymbol): ReadToolHandle {
	return readToolHandle({
		path,
		mode: "symbol",
		symbol: baseSymbolName(symbol.symbolName),
		parent: symbol.parentName,
		startLine: symbol.startLine,
	});
}

function matchesSymbolName(symbol: ReadSymbol, requested: string): boolean {
	return symbol.symbolName === requested || baseSymbolName(symbol.symbolName) === requested;
}

function selectSymbol(symbols: ReadSymbol[], params: ReadFileParams, path: string): ReadSymbol {
	const symbolName = params.symbol?.trim();
	if (!symbolName) throw new Error("symbol is required for mode=symbol");
	let candidates = symbols.filter((entry) => matchesSymbolName(entry, symbolName));
	if (params.parent?.trim()) {
		const parent = params.parent.trim();
		candidates = candidates.filter((entry) => entry.parentName === parent || entry.symbolName.startsWith(`${parent}.`));
	}
	if (params.startLine !== undefined) {
		const startLine = Math.trunc(params.startLine);
		candidates = candidates.filter((entry) => entry.startLine === startLine);
	}
	if (candidates.length === 1) return candidates[0];
	if (candidates.length === 0) throw new Error(`symbol not found in ${path}: ${symbolName}`);
	const handles = candidates.map((candidate) => JSON.stringify(symbolHandle(path, candidate))).join("\n");
	throw new Error(`ambiguous symbol ${symbolName} in ${path}; use parent or startLine. Candidates:\n${handles}`);
}

export function createReadFileTool(
	cwd: string,
): AgentTool<typeof readFileSchema, ReadFileDetails> {
	const seenRanges = new Map<string, Array<{ startLine: number; endLine: number }>>();
	return {
		label: "Read file",
		name: "read_file",
		description:
			"Read workspace files hierarchically. Use mode=map for a compact symbol map, mode=symbol for one symbol body, mode=around for nearby context, or bounded range reads with startLine/maxLines.",
		parameters: readFileSchema,
		executionMode: "parallel",
		execute: async (_toolCallId: string, params: ReadFileParams) => {
			const file = await resolveWorkspaceFile(cwd, params.path);
			const text = await readFile(file.absolutePath, "utf8");
			const fileRevision = sha256(text);
			const lines = text.split(/\r?\n/);
			const totalLines = effectiveLineCount(lines);
			const mode = (params.mode ?? "range") as ReadFileDetails["mode"];
			const symbols = collectSymbols(file.relativePath, text, lines);

			if (mode === "map") {
				const symbolLines = symbols.map(
					(symbol) =>
						`symbol ${symbol.symbolKind} ${symbol.symbolName} lines ${symbol.startLine}-${symbol.endLine} lsp=${symbol.lspSymbolKindName}(${symbol.lspSymbolKind})\n  next: ${JSON.stringify(symbolHandle(file.relativePath, symbol))}`,
				);
				const text = [
					`<read_map path="${file.relativePath}" lines="${lines.length}">`,
					...symbolLines,
					symbolLines.length === 0 ? "(no symbols detected)" : undefined,
					"</read_map>",
					"<available_context>",
					`range: read_file path=${file.relativePath} startLine=1 maxLines=120`,
					"</available_context>",
				]
					.filter((line): line is string => line !== undefined)
					.join("\n");
					return {
					content: [{ type: "text", text }],
					details: {
						path: file.relativePath,
						mode,
						totalLines,
						fileRevision,
						chunkId: chunkId(file.relativePath, "map", 1, fileRevision),
						symbols,
						handles: { range: { path: file.relativePath, startLine: 1, maxLines: Math.min(120, totalLines) } },
					},
				};
			}

			let startLine: number;
			let endLine: number;
			if (mode === "symbol") {
				const symbol = selectSymbol(symbols, params, file.relativePath);
				startLine = symbol.startLine;
				endLine = symbol.endLine;
			} else if (mode === "around") {
				const center = Math.max(1, Math.trunc(params.line ?? params.startLine ?? 1));
				const before = Math.min(120, Math.max(0, Math.trunc(params.before ?? 20)));
				const after = Math.min(120, Math.max(0, Math.trunc(params.after ?? 20)));
				startLine = Math.max(1, center - before);
				endLine = Math.min(totalLines, center + after);
			} else {
				const range = boundedRange({
					totalLines,
					startLine: params.startLine ?? 1,
					maxLines: params.maxLines ?? 120,
				});
				startLine = range.startLine;
				endLine = range.endLine;
			}

			const above =
				startLine > 1
					? { path: file.relativePath, startLine: 1, maxLines: startLine - 1 }
					: undefined;
			const below =
				endLine < totalLines
					? { path: file.relativePath, startLine: endLine + 1, maxLines: totalLines - endLine }
					: undefined;
			const handleLines = [handleText("above", above), handleText("below", below)].filter(
				(line): line is string => line !== undefined,
			);
			const body = formatRange(file.relativePath, lines, startLine, endLine);
			const id = chunkId(file.relativePath, readLabel(mode, params, startLine), startLine, fileRevision);
			const retrieval = computeRetrievalReceipt(seenRanges, file.relativePath, startLine, endLine, totalLines);
			const receipt = `<read_receipt revision="${fileRevision.slice(0, 12)}" chunk="${id}" retrieval overlap=${retrieval.overlapLines} novel=${retrieval.novelLines} next=${retrieval.recommendedNextAction}>`;
			const output =
				mode === "range"
					? `${receipt}\n${body}${handleLines.length > 0 ? `\n\n<available_context>\n${handleLines.join("\n")}\n</available_context>` : ""}`
					: [
							`<read_context path="${file.relativePath}" mode="${mode}" lines="${startLine}-${endLine}" revision="${fileRevision.slice(0, 12)}" chunk="${id}"${params.symbol ? ` symbol="${params.symbol}"` : ""}>`,
							receipt,
							body,
							"</read_context>",
							...(handleLines.length > 0 ? ["<available_context>", ...handleLines, "</available_context>"] : []),
						].join("\n");

			return {
				content: [{ type: "text", text: output }],
				details: {
					path: file.relativePath,
					mode,
					startLine,
					endLine,
					totalLines,
					fileRevision,
					chunkId: id,
					symbols,
					handles: { above, below },
					retrieval,
				},
			};
		},
	};
}
